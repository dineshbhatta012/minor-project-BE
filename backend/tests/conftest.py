import pytest

from app.routing.graph_builder import GraphData, build_graph_from_rows

# A small hand-built network: two routes sharing an interchange stop (C),
# plus one isolated stop (Z) served by nothing, for the no-route case.
#
#   Route "R1":  A -- B -- C -- D   (straight line, ~1km hops)
#   Route "R2":  C -- E -- F        (branches off the interchange at C)
#   Z: isolated, no route serves it
#
# So: A->D is direct (one route, no transfer).
#     A->F requires one transfer at C (R1 then R2).
#     A->Z has no route (Z isn't on the graph).

TEST_STOPS = [
    {"stop_id": "A", "stop_name": "A", "lat": 27.700, "lng": 85.300, "is_interchange": False, "is_major_stop": False},
    {"stop_id": "B", "stop_name": "B", "lat": 27.701, "lng": 85.301, "is_interchange": False, "is_major_stop": False},
    {"stop_id": "C", "stop_name": "C", "lat": 27.702, "lng": 85.302, "is_interchange": True, "is_major_stop": True},
    {"stop_id": "D", "stop_name": "D", "lat": 27.703, "lng": 85.303, "is_interchange": False, "is_major_stop": False},
    {"stop_id": "E", "stop_name": "E", "lat": 27.704, "lng": 85.304, "is_interchange": False, "is_major_stop": False},
    {"stop_id": "F", "stop_name": "F", "lat": 27.705, "lng": 85.305, "is_interchange": False, "is_major_stop": False},
    {"stop_id": "Z", "stop_name": "Z", "lat": 27.800, "lng": 85.400, "is_interchange": False, "is_major_stop": False},
]

TEST_ROUTES = [
    {"route_id": "R1", "route_name": "Route 1"},
    {"route_id": "R2", "route_name": "Route 2"},
]

TEST_ROUTE_STOPS = [
    {"route_id": "R1", "stop_id": "A", "sequence_no": 1},
    {"route_id": "R1", "stop_id": "B", "sequence_no": 2},
    {"route_id": "R1", "stop_id": "C", "sequence_no": 3},
    {"route_id": "R1", "stop_id": "D", "sequence_no": 4},
    {"route_id": "R2", "stop_id": "C", "sequence_no": 1},
    {"route_id": "R2", "stop_id": "E", "sequence_no": 2},
    {"route_id": "R2", "stop_id": "F", "sequence_no": 3},
]

TRANSFER_PENALTY_KM = 5.0


@pytest.fixture
def graph_data() -> GraphData:
    return build_graph_from_rows(TEST_STOPS, TEST_ROUTES, TEST_ROUTE_STOPS, TRANSFER_PENALTY_KM)
