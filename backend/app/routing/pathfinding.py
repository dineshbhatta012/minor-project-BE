import networkx as nx

from app.routing.graph_builder import GraphData, route_node, stop_node

ORIGIN_NODE = "__origin__"


def find_direct_route_bfs(graph_data: GraphData, origin_stop_id: str, destination_stop_id: str) -> str | None:
    """
    Lightweight comparator (per the proposal's objectives): scans each
    route's recorded stop sequence directly, no graph traversal. Used as a
    fast sanity check for the direct-route case — if this finds a direct
    route but Dijkstra's result has transfer_count > 0, something is off in
    the weighted graph and it's worth logging.

    Returns the first route_id that visits origin before destination in its
    recorded sequence, or None.
    """
    for route_id, sequence in graph_data.route_sequences.items():
        try:
            origin_idx = sequence.index(origin_stop_id)
            dest_idx = sequence.index(destination_stop_id)
        except ValueError:
            continue
        if origin_idx < dest_idx:
            return route_id
    return None


def find_route_dijkstra(
    graph_data: GraphData, origin_stop_id: str, destination_stop_id: str
) -> list[str] | None:
    """
    Runs one Dijkstra call over a lightly-augmented copy of the cached graph:
    a temporary ORIGIN_NODE is connected directly into every route node at
    the origin stop with weight 0, so the very first boarding never pays the
    transfer penalty (only actual mid-trip transfers do). The destination is
    just the physical stop node — alight edges already lead there for free.

    Returns the raw node-id path (mix of R:... and S:... nodes), or None if
    no path exists.
    """
    if origin_stop_id not in graph_data.stops_by_id or destination_stop_id not in graph_data.stops_by_id:
        return None
    if origin_stop_id == destination_stop_id:
        return None  # nothing to search for; caller should short-circuit this case

    g = graph_data.graph
    target = stop_node(destination_stop_id)

    # Copy only what we're about to mutate — cheap, since we're just adding
    # one node and a handful of edges, and avoids corrupting the shared
    # cached graph across concurrent requests.
    augmented = g.copy()
    augmented.add_node(ORIGIN_NODE)

    boarded_any = False
    for route_id in graph_data.route_sequences:
        candidate = route_node(route_id, origin_stop_id)
        if augmented.has_node(candidate):
            augmented.add_edge(ORIGIN_NODE, candidate, weight=0.0, kind="origin")
            boarded_any = True

    if not boarded_any:
        return None  # origin stop isn't served by any active route

    try:
        path = nx.dijkstra_path(augmented, ORIGIN_NODE, target, weight="weight")
    except nx.NetworkXNoPath:
        return None

    return path[1:]  # drop the synthetic ORIGIN_NODE


def path_to_legs(graph_data: GraphData, path: list[str]) -> tuple[list[dict], float]:
    """
    Groups a raw node path into per-route legs and sums real travel distance
    (ignoring the 0-weight alight edges and the transfer-penalty board edges,
    which aren't real distance).
    """
    legs: list[dict] = []
    total_km = 0.0
    current_route_id: str | None = None
    current_stop_ids: list[str] = []

    g = graph_data.graph

    def flush():
        nonlocal current_route_id, current_stop_ids
        if current_route_id is not None and len(current_stop_ids) >= 2:
            legs.append(
                {
                    "route_id": current_route_id,
                    "route_name": graph_data.route_names.get(current_route_id, current_route_id),
                    "operator": graph_data.route_operators.get(current_route_id, ""),
                    "from_stop_id": current_stop_ids[0],
                    "to_stop_id": current_stop_ids[-1],
                    "stop_ids": list(current_stop_ids),
                }
            )
        current_route_id = None
        current_stop_ids = []

    for node in path:
        if node.startswith("R:"):
            _, route_id, stop_id = node.split(":", 2)
            if route_id != current_route_id:
                flush()
                current_route_id = route_id
            current_stop_ids.append(stop_id)
        # "S:" nodes are transfer/arrival points — they don't start a new
        # leg by themselves, the next "R:" node does (or the walk ends here)

    flush()

    for u, v in zip(path, path[1:]):
        edge = g.get_edge_data(u, v)
        if edge and edge.get("kind") == "travel":
            total_km += edge["weight"]

    return legs, round(total_km, 3)
