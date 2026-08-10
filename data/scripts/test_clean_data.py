"""
test_clean_data.py — regression tests for clean_data.py, using tiny in-memory
fixtures instead of the full dataset. Run with: pytest scripts/test_clean_data.py

These pin the specific behaviors report.md documents, so a future refactor
can't silently change orphan-removal, resequencing, or operator_id-nulling
logic without a test failing.
"""

import pandas as pd
import pytest

from clean_data import CleaningStats, clean_route_stops, clean_routes, clean_stops


@pytest.fixture
def stops_raw():
    return pd.DataFrame([
        {"stop_id": "S001", "stop_name": "A", "lat": "27.70", "lng": "85.30",
         "aliases": "", "zone": "Z", "district": "KATHMANDU", "ward": "1",
         "is_major_stop": "False", "landmark": "", "has_shelter": "False",
         "has_ticket_counter": "False", "is_interchange": "False",
         "wheelchair_access": "False", "audio_support": "False", "status": "active"},
        {"stop_id": "S002", "stop_name": "B", "lat": "27.71", "lng": "85.31",
         "aliases": "", "zone": "Z", "district": "KATHMANDU", "ward": "2",
         "is_major_stop": "False", "landmark": "", "has_shelter": "False",
         "has_ticket_counter": "False", "is_interchange": "False",
         "wheelchair_access": "False", "audio_support": "False", "status": "active"},
        {"stop_id": "S003", "stop_name": "C", "lat": "99.00", "lng": "85.32",
         "aliases": "", "zone": "Z", "district": "KATHMANDU", "ward": "3",
         "is_major_stop": "False", "landmark": "", "has_shelter": "False",
         "has_ticket_counter": "False", "is_interchange": "False",
         "wheelchair_access": "False", "audio_support": "False", "status": "active"},
    ])


def test_clean_stops_flags_out_of_bounds(stops_raw):
    stops = clean_stops(stops_raw)
    assert stops.loc[stops["stop_id"] == "S003", "geo_out_of_bounds"].iloc[0] is True
    assert stops.loc[stops["stop_id"] == "S001", "geo_out_of_bounds"].iloc[0] is False


def test_clean_route_stops_removes_orphans_and_resequences(stops_raw):
    stops = clean_stops(stops_raw)
    route_stops_raw = pd.DataFrame([
        {"route_id": "R1", "stop_id": "S001", "sequence_no": "1"},
        {"route_id": "R1", "stop_id": "S999", "sequence_no": "2"},  # orphan: no such stop
        {"route_id": "R1", "stop_id": "S002", "sequence_no": "3"},
    ])
    stats = CleaningStats()
    cleaned = clean_route_stops(route_stops_raw, stops, stats)

    assert stats.orphan_route_stops_removed == 1
    assert "S999" in stats.phantom_stop_ids
    assert list(cleaned["stop_id"]) == ["S001", "S002"]
    assert list(cleaned["sequence_no"]) == [1, 2]  # re-numbered, no gap


def test_clean_route_stops_flags_revisits_without_removing(stops_raw):
    stops = clean_stops(stops_raw)
    route_stops_raw = pd.DataFrame([
        {"route_id": "R1", "stop_id": "S001", "sequence_no": "1"},
        {"route_id": "R1", "stop_id": "S002", "sequence_no": "2"},
        {"route_id": "R1", "stop_id": "S001", "sequence_no": "3"},  # loop back to S001
    ])
    stats = CleaningStats()
    cleaned = clean_route_stops(route_stops_raw, stops, stats)

    assert len(cleaned) == 3  # nothing removed — revisits are legitimate
    assert stats.revisit_rows == 1
    assert stats.revisit_routes == 1


def test_clean_routes_nulls_unrecoverable_operator_id(stops_raw):
    stops = clean_stops(stops_raw)
    route_stops_raw = pd.DataFrame([
        {"route_id": "R1", "stop_id": "S001", "sequence_no": "1"},
        {"route_id": "R1", "stop_id": "S002", "sequence_no": "2"},
    ])
    stats = CleaningStats()
    route_stops = clean_route_stops(route_stops_raw, stops, stats)

    operators = pd.DataFrame([{"operator_id": "OP001", "name": "Real Operator"}])
    route_operators = pd.DataFrame(columns=["route_id", "operator_id"])

    routes_raw = pd.DataFrame([{
        "route_id": "R1", "route_name": "Test Route", "vehicle_type": "bus",
        "operator": "Unregistered Micro", "operator_id": "OP999",  # invalid
        "operator_id_raw": "OP999", "start_stop_id": "S001", "end_stop_id": "S002",
        "total_stops": "2", "approx_distance_km": "1.0",
        "approx_distance_km_original": "1.0",
    }])

    routes = clean_routes(routes_raw, route_stops, stops, operators, route_operators, stats)

    assert pd.isna(routes.loc[0, "operator_id"])
    assert "OP999" in stats.invalid_operator_ids
    assert "R1" in stats.operator_id_nulled_routes


def test_clean_routes_recomputes_total_stops_after_orphan_removal(stops_raw):
    stops = clean_stops(stops_raw)
    route_stops_raw = pd.DataFrame([
        {"route_id": "R1", "stop_id": "S001", "sequence_no": "1"},
        {"route_id": "R1", "stop_id": "S999", "sequence_no": "2"},  # orphan
        {"route_id": "R1", "stop_id": "S002", "sequence_no": "3"},
    ])
    stats = CleaningStats()
    route_stops = clean_route_stops(route_stops_raw, stops, stats)

    operators = pd.DataFrame([{"operator_id": "OP001", "name": "Real Operator"}])
    route_operators = pd.DataFrame(columns=["route_id", "operator_id"])
    routes_raw = pd.DataFrame([{
        "route_id": "R1", "route_name": "Test Route", "vehicle_type": "bus",
        "operator": "Real Operator", "operator_id": "OP001", "operator_id_raw": "OP001",
        "start_stop_id": "S001", "end_stop_id": "S001",  # wrong on purpose
        "total_stops": "3",  # wrong on purpose (was 3 before orphan removal)
        "approx_distance_km": "1.0", "approx_distance_km_original": "1.0",
    }])

    routes = clean_routes(routes_raw, route_stops, stops, operators, route_operators, stats)

    assert routes.loc[0, "end_stop_id"] == "S002"
    assert int(routes.loc[0, "total_stops"]) == 2
    assert "R1" in stats.end_stop_corrected
    assert "R1" in stats.total_stops_corrected
