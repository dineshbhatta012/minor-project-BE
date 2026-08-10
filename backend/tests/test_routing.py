from app.routing.pathfinding import find_direct_route_bfs, find_route_dijkstra, path_to_legs


def test_known_shortest_path_direct_route(graph_data):
    """A -> D is a direct route on R1, no transfer needed."""
    path = find_route_dijkstra(graph_data, "A", "D")
    assert path is not None

    legs, total_km = path_to_legs(graph_data, path)
    assert len(legs) == 1
    assert legs[0]["route_id"] == "R1"
    assert legs[0]["from_stop_id"] == "A"
    assert legs[0]["to_stop_id"] == "D"
    assert total_km > 0


def test_known_transfer_case(graph_data):
    """A -> F requires transferring from R1 to R2 at the interchange, C."""
    path = find_route_dijkstra(graph_data, "A", "F")
    assert path is not None

    legs, _ = path_to_legs(graph_data, path)
    assert len(legs) == 2
    assert legs[0]["route_id"] == "R1"
    assert legs[0]["to_stop_id"] == "C"
    assert legs[1]["route_id"] == "R2"
    assert legs[1]["from_stop_id"] == "C"
    assert legs[1]["to_stop_id"] == "F"


def test_no_route_case(graph_data):
    """Z isn't served by any route, so no path should be found."""
    path = find_route_dijkstra(graph_data, "A", "Z")
    assert path is None


def test_identical_origin_destination(graph_data):
    """Same stop for origin and destination should short-circuit to no path,
    not silently return a trivial zero-length route."""
    path = find_route_dijkstra(graph_data, "A", "A")
    assert path is None


def test_direct_route_bfs_finds_direct(graph_data):
    assert find_direct_route_bfs(graph_data, "A", "D") == "R1"


def test_direct_route_bfs_no_direct_route_when_transfer_required(graph_data):
    # F is only reachable via R2, and R2 doesn't start at A — so no single
    # route covers A->F directly.
    assert find_direct_route_bfs(graph_data, "A", "F") is None


def test_direct_route_bfs_wrong_direction_not_counted(graph_data):
    # D comes after A on R1's sequence, so D->A (reverse) shouldn't count as
    # a direct route — the data doesn't actually support that direction.
    assert find_direct_route_bfs(graph_data, "D", "A") is None
