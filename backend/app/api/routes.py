from fastapi import APIRouter, Depends, HTTPException, Body
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.routing.geo import haversine_km
from app.routing.graph_builder import refresh_graph
from app.schemas import RouteDetailOut, RouteSummaryOut, StopOut, RouteStopsUpdateRequest

router = APIRouter(prefix="/routes", tags=["routes"])


def _fetch_route_detail(db: Session, route_id: str) -> RouteDetailOut | None:
    route_row = db.execute(
        text(
            """
            SELECT route_id, route_name, short_name, vehicle_type,
                   total_stops, approx_distance_km, start_stop_id, end_stop_id
            FROM routes
            WHERE route_id = :route_id AND status = 'active'
            """
        ),
        {"route_id": route_id},
    ).mappings().first()

    if route_row is None:
        return None

    stop_rows = db.execute(
        text(
            """
            SELECT s.stop_id, s.stop_name, s.lat, s.lng, s.is_interchange, s.is_major_stop
            FROM route_stops rs
            JOIN stops s ON s.stop_id = rs.stop_id
            WHERE rs.route_id = :route_id
              AND NULLIF(TRIM(s.stop_name), '') IS NOT NULL
            ORDER BY rs.sequence_no
            """
        ),
        {"route_id": route_id},
    ).mappings()

    return RouteDetailOut(
        **dict(route_row),
        stops=[StopOut(**dict(r)) for r in stop_rows],
    )


@router.get("", response_model=list[RouteSummaryOut])
def list_routes(db: Session = Depends(get_db)):
    rows = db.execute(
        text(
            """
            SELECT route_id, route_name, short_name, vehicle_type,
                   total_stops, approx_distance_km, start_stop_id, end_stop_id
            FROM routes
            WHERE status = 'active'
            ORDER BY route_name
            """
        )
    ).mappings()
    return [RouteSummaryOut(**dict(r)) for r in rows]


@router.get("/{route_id}", response_model=RouteDetailOut)
def get_route(route_id: str, db: Session = Depends(get_db)):
    detail = _fetch_route_detail(db, route_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")
    return detail


@router.delete("/{route_id}/stops/{stop_id}", response_model=RouteDetailOut)
def remove_stop_from_route(route_id: str, stop_id: str, db: Session = Depends(get_db)):
    """Remove a stop from one route's stop sequence. The stop itself stays in
    the stops table and on every other route that serves it — only the
    route_stops mapping row for (route_id, stop_id) is deleted. The remaining
    stops are re-numbered and the cached routing graph is rebuilt."""
    route_row = db.execute(
        text("SELECT route_id FROM routes WHERE route_id = :route_id AND status = 'active'"),
        {"route_id": route_id},
    ).mappings().first()
    if route_row is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")

    stop_row = db.execute(
        text("SELECT stop_id FROM stops WHERE stop_id = :stop_id AND status = 'active'"),
        {"stop_id": stop_id},
    ).mappings().first()
    if stop_row is None:
        raise HTTPException(status_code=404, detail=f"Stop '{stop_id}' not found")

    current_count = db.execute(
        text("SELECT count(*) AS c FROM route_stops WHERE route_id = :route_id"),
        {"route_id": route_id},
    ).scalar_one()
    if current_count <= 2:
        raise HTTPException(
            status_code=400,
            detail="A route must keep at least two stops — cannot remove any more.",
        )

    deleted = db.execute(
        text(
            "DELETE FROM route_stops WHERE route_id = :route_id AND stop_id = :stop_id"
            " RETURNING sequence_no"
        ),
        {"route_id": route_id, "stop_id": stop_id},
    ).mappings().first()
    if deleted is None:
        raise HTTPException(
            status_code=404, detail=f"Stop '{stop_id}' is not on route '{route_id}'"
        )

    remaining = db.execute(
        text(
            "SELECT rs.stop_id, s.lat, s.lng FROM route_stops rs"
            " JOIN stops s ON s.stop_id = rs.stop_id"
            " WHERE rs.route_id = :route_id ORDER BY rs.sequence_no"
        ),
        {"route_id": route_id},
    ).mappings().all()

    for i, row in enumerate(remaining, start=1):
        db.execute(
            text(
                "UPDATE route_stops SET sequence_no = :seq"
                " WHERE route_id = :route_id AND stop_id = :stop_id"
            ),
            {"seq": i, "route_id": route_id, "stop_id": row["stop_id"]},
        )

    approx_km = round(
        sum(
            haversine_km(a["lat"], a["lng"], b["lat"], b["lng"])
            for a, b in zip(remaining, remaining[1:])
        ),
        3,
    )
    db.execute(
        text(
            "UPDATE routes SET total_stops = :total, approx_distance_km = :km"
            " WHERE route_id = :route_id"
        ),
        {"total": len(remaining), "km": approx_km, "route_id": route_id},
    )
    db.commit()

    refresh_graph(db)

    detail = _fetch_route_detail(db, route_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")
    return detail

@router.put("/{route_id}/stops", response_model=RouteDetailOut)
def update_route_stops(
    route_id: str,
    payload: RouteStopsUpdateRequest = Body(...),
    db: Session = Depends(get_db)
):
    """Replace the entire stop sequence for a route. Used for both reordering
    existing stops and adding new stops."""
    route_row = db.execute(
        text("SELECT route_id FROM routes WHERE route_id = :route_id AND status = 'active'"),
        {"route_id": route_id},
    ).mappings().first()
    if route_row is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")

    stop_ids = payload.stop_ids
    if len(stop_ids) < 2:
        raise HTTPException(status_code=400, detail="A route must have at least two stops.")

    # Check if all stops exist
    existing_stops = db.execute(
        text("SELECT stop_id, lat, lng FROM stops WHERE stop_id = ANY(:stop_ids) AND status = 'active'"),
        {"stop_ids": stop_ids}
    ).mappings().all()
    
    existing_stop_map = {s["stop_id"]: s for s in existing_stops}
    for stop_id in stop_ids:
        if stop_id not in existing_stop_map:
            raise HTTPException(status_code=404, detail=f"Stop '{stop_id}' not found")

    # Delete existing sequence
    db.execute(
        text("DELETE FROM route_stops WHERE route_id = :route_id"),
        {"route_id": route_id}
    )

    # Insert new sequence
    for i, stop_id in enumerate(stop_ids, start=1):
        db.execute(
            text(
                "INSERT INTO route_stops (route_id, stop_id, sequence_no) "
                "VALUES (:route_id, :stop_id, :seq)"
            ),
            {"route_id": route_id, "stop_id": stop_id, "seq": i}
        )

    # Calculate new distance
    ordered_stops_coords = [existing_stop_map[sid] for sid in stop_ids]
    approx_km = round(
        sum(
            haversine_km(a["lat"], a["lng"], b["lat"], b["lng"])
            for a, b in zip(ordered_stops_coords, ordered_stops_coords[1:])
        ),
        3,
    )

    # Update route summary
    db.execute(
        text(
            "UPDATE routes SET total_stops = :total, approx_distance_km = :km, "
            "start_stop_id = :start_stop_id, end_stop_id = :end_stop_id "
            "WHERE route_id = :route_id"
        ),
        {
            "total": len(stop_ids),
            "km": approx_km,
            "start_stop_id": stop_ids[0],
            "end_stop_id": stop_ids[-1],
            "route_id": route_id
        },
    )
    db.commit()

    refresh_graph(db)

    detail = _fetch_route_detail(db, route_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")
    return detail
