"""
Builds the routing graph used by pathfinding.py.

MODEL: a "route-expanded" graph, not a plain stop-to-stop graph. This is
what lets one Dijkstra run resolve both direct and single-transfer routes
naturally (per the proposal's Section 4.1.1), instead of needing separate
logic for each case.

Two kinds of nodes:
  - "S:{stop_id}"            — a physical stop, platform-level, route-agnostic
  - "R:{route_id}:{stop_id}" — "you are riding this specific route, currently
                                 at this stop"

Three kinds of edges:
  - travel edges:  R:{route}:{stop_i} -> R:{route}:{stop_i+1}
                   weight = real haversine distance between consecutive stops
                   on that route's recorded sequence. Directional only, never
                   invented in reverse — a route's reverse direction only
                   exists if the data actually records a separate route_id
                   for it.
  - alight edges:  R:{route}:{stop} -> S:{stop}, weight 0 (getting off is free)
  - board edges:   S:{stop} -> R:{route}:{stop}, weight = transfer_penalty_km
                   (boarding after already being "on the ground" costs a
                   penalty — this is what makes Dijkstra prefer fewer
                   transfers without needing separate transfer-counting logic)

At query time, pathfinding.py adds one more temporary edge type: origin
edges that connect directly into route nodes at the origin stop with
weight 0, bypassing the board penalty for the very first boarding (you
shouldn't be penalized just for starting your trip).
"""

from dataclasses import dataclass, field
from threading import Lock

import networkx as nx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.routing.geo import haversine_km

STOP_PREFIX = "S:"
ROUTE_PREFIX = "R:"


@dataclass
class GraphData:
    graph: nx.DiGraph
    stops_by_id: dict[str, dict]
    route_names: dict[str, str]
    # ordered stop_id sequence per route — used by the BFS direct-route
    # sanity check in pathfinding.py, kept separate from the graph itself
    route_sequences: dict[str, list[str]] = field(default_factory=dict)


def stop_node(stop_id: str) -> str:
    return f"{STOP_PREFIX}{stop_id}"


def route_node(route_id: str, stop_id: str) -> str:
    return f"{ROUTE_PREFIX}{route_id}:{stop_id}"


def build_graph_from_rows(
    stops: list[dict],
    routes: list[dict],
    route_stops: list[dict],
    transfer_penalty_km: float,
) -> GraphData:
    """
    Pure function, no DB access — this is what makes it unit-testable with
    a small hardcoded graph (per the proposal's "Set up NetworkX graph
    skeleton" task) without needing a live database.

    stops:       [{stop_id, stop_name, lat, lng, is_interchange, is_major_stop}, ...]
    routes:      [{route_id, route_name}, ...]  (caller pre-filters to active)
    route_stops: [{route_id, stop_id, sequence_no}, ...]
    """
    graph = nx.DiGraph()
    stops_by_id = {s["stop_id"]: s for s in stops}
    route_names = {r["route_id"]: r["route_name"] for r in routes}

    for stop_id in stops_by_id:
        graph.add_node(stop_node(stop_id))

    # Group route_stops by route_id, preserving sequence_no order
    by_route: dict[str, list[dict]] = {}
    for row in route_stops:
        by_route.setdefault(row["route_id"], []).append(row)
    route_sequences: dict[str, list[str]] = {}

    for route_id, rows in by_route.items():
        if route_id not in route_names:
            continue  # route filtered out upstream (e.g. inactive)
        ordered = sorted(rows, key=lambda r: r["sequence_no"])
        stop_sequence = [r["stop_id"] for r in ordered]
        route_sequences[route_id] = stop_sequence

        for stop_id in stop_sequence:
            if stop_id not in stops_by_id:
                continue  # defensive: skip orphaned stop references
            r_node = route_node(route_id, stop_id)
            graph.add_node(r_node)
            graph.add_edge(r_node, stop_node(stop_id), weight=0.0, kind="alight")
            graph.add_edge(
                stop_node(stop_id), r_node, weight=transfer_penalty_km, kind="board"
            )

        for a, b in zip(stop_sequence, stop_sequence[1:]):
            if a not in stops_by_id or b not in stops_by_id:
                continue
            sa, sb = stops_by_id[a], stops_by_id[b]
            dist = haversine_km(sa["lat"], sa["lng"], sb["lat"], sb["lng"])
            graph.add_edge(
                route_node(route_id, a),
                route_node(route_id, b),
                weight=dist,
                kind="travel",
            )

    return GraphData(
        graph=graph,
        stops_by_id=stops_by_id,
        route_names=route_names,
        route_sequences=route_sequences,
    )


def _query_stops(db: Session) -> list[dict]:
    rows = db.execute(
        text(
            """
            SELECT stop_id, stop_name, lat, lng, is_interchange, is_major_stop
            FROM stops
            WHERE status = 'active'
            """
        )
    ).mappings()
    return [dict(r) for r in rows]


def _query_active_routes(db: Session) -> list[dict]:
    rows = db.execute(
        text("SELECT route_id, route_name FROM routes WHERE status = 'active'")
    ).mappings()
    return [dict(r) for r in rows]


def _query_route_stops(db: Session) -> list[dict]:
    rows = db.execute(
        text("SELECT route_id, stop_id, sequence_no FROM route_stops")
    ).mappings()
    return [dict(r) for r in rows]


def build_graph_from_db(db: Session) -> GraphData:
    settings = get_settings()
    stops = _query_stops(db)
    routes = _query_active_routes(db)
    route_stops = _query_route_stops(db)
    return build_graph_from_rows(stops, routes, route_stops, settings.transfer_penalty_km)


# --- Module-level cache -----------------------------------------------------
# The graph is rebuilt once at startup (see main.py's lifespan hook) and
# cached in memory rather than rebuilt per-request, since 87 routes / 300
# stops build in well under a second but every /route/search call doesn't
# need to redo that work. Call refresh_graph() (exposed via POST
# /admin/refresh-graph) after the underlying data changes.

_cache_lock = Lock()
_cached: GraphData | None = None


def get_cached_graph(db: Session) -> GraphData:
    global _cached
    with _cache_lock:
        if _cached is None:
            _cached = build_graph_from_db(db)
        return _cached


def refresh_graph(db: Session) -> GraphData:
    global _cached
    with _cache_lock:
        _cached = build_graph_from_db(db)
        return _cached
