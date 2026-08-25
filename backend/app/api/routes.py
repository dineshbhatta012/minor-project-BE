import subprocess
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Body, BackgroundTasks
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.routing.geo import haversine_km
from app.routing.graph_builder import refresh_graph
from app.schemas import (
    RouteCreateRequest,
    RouteDetailOut,
    RouteSummaryOut,
    StopOut,
    RouteStopsUpdateRequest,
)


router = APIRouter(prefix="/routes", tags=["routes"])
 
import sys
def run_export_data():
    script_path = Path(__file__).resolve().parents[2] / "scripts" / "export_data.py"
    try:
        subprocess.run([sys.executable, str(script_path)], check=True)
    except Exception as e:
        print(f"Failed to export data: {e}")


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


@router.delete("/{route_id}/stops/{sequence_no}", response_model=RouteDetailOut)
def remove_stop_from_route(route_id: str, sequence_no: int, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Remove one position from a route's stop sequence. The stop itself
    remains available to other routes; only this route_stops row is deleted.
    The remaining stops are re-numbered and the routing graph is rebuilt."""
    route_row = db.execute(
        text("SELECT route_id FROM routes WHERE route_id = :route_id AND status = 'active'"),
        {"route_id": route_id},
    ).mappings().first()
    if route_row is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")

    stop_row = db.execute(
        text(
            "SELECT rs.stop_id FROM route_stops rs "
            "JOIN stops s ON s.stop_id = rs.stop_id "
            "WHERE rs.route_id = :route_id AND rs.sequence_no = :sequence_no "
            "AND s.status = 'active'"
        ),
        {"route_id": route_id, "sequence_no": sequence_no},
    ).mappings().first()
    if stop_row is None:
        raise HTTPException(status_code=404, detail=f"Sequence {sequence_no} is not on route '{route_id}'")

    current_count = db.execute(
        text("SELECT count(*) AS c FROM route_stops WHERE route_id = :route_id"),
        {"route_id": route_id},
    ).scalar_one()
    if current_count <= 2:
        raise HTTPException(
            status_code=400,
            detail="A route must keep at least two stops — cannot remove any more.",
        )

    db.execute(
        text("DELETE FROM route_stops WHERE route_id = :route_id AND sequence_no = :sequence_no"),
        {"route_id": route_id, "sequence_no": sequence_no},
    )

    remaining = db.execute(
        text(
            "SELECT rs.stop_id, rs.sequence_no, s.lat, s.lng FROM route_stops rs"
            " JOIN stops s ON s.stop_id = rs.stop_id"
            " WHERE rs.route_id = :route_id ORDER BY rs.sequence_no"
        ),
        {"route_id": route_id},
    ).mappings().all()

    db.execute(
        text(
            "UPDATE route_stops SET sequence_no = sequence_no + 1000000 "
            "WHERE route_id = :route_id"
        ),
        {"route_id": route_id},
    )
    for i, row in enumerate(remaining, start=1):
        db.execute(
            text(
                "UPDATE route_stops SET sequence_no = :seq"
                " WHERE route_id = :route_id AND sequence_no = :old_seq"
            ),
            {"seq": i, "route_id": route_id, "old_seq": row["sequence_no"] + 1000000},
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
            "UPDATE routes SET total_stops = :total, approx_distance_km = :km, "
            "start_stop_id = :start_stop_id, end_stop_id = :end_stop_id"
            " WHERE route_id = :route_id"
        ),
        {
            "total": len(remaining),
            "km": approx_km,
            "start_stop_id": remaining[0]["stop_id"],
            "end_stop_id": remaining[-1]["stop_id"],
            "route_id": route_id,
        },
    )
    db.commit()
    background_tasks.add_task(run_export_data)

    refresh_graph(db)

    detail = _fetch_route_detail(db, route_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")
    return detail

@router.put("/{route_id}/stops", response_model=RouteDetailOut)
def update_route_stops(
    route_id: str,
    payload: RouteStopsUpdateRequest = Body(...),
    background_tasks: BackgroundTasks = None,
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
    if len(stop_ids) < 1:
        raise HTTPException(status_code=400, detail="A route must have at least one stop.")

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
    if background_tasks:
        background_tasks.add_task(run_export_data)

    refresh_graph(db)

    detail = _fetch_route_detail(db, route_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")
    return detail


@router.post("", response_model=RouteSummaryOut)
def create_route(
    payload: RouteCreateRequest = Body(...),
    db: Session = Depends(get_db),
):
    route_name = payload.route_name.strip()
    if not route_name:
        raise HTTPException(status_code=400, detail="Route name cannot be blank.")

    # Serialize ID allocation so concurrent requests cannot choose the same ID.
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext('routes-route-id'))"))
    # Keep generated IDs stable and readable while checking the primary key
    # before inserting, so an existing non-numeric route ID cannot collide.
    max_row = db.execute(
        text(
            "SELECT COALESCE(MAX(CAST(SUBSTRING(route_id FROM 2) AS INTEGER)), 0) AS max_id "
            "FROM routes WHERE route_id ~ '^R[0-9]+$'"
        ),
    ).mappings().first()
    new_route_id = f"R{int(max_row['max_id']) + 1}"

    # Create the route with default values (no stops initially)
    db.execute(
        text(
            "INSERT INTO routes "
            "(route_id, route_name, vehicle_type, total_stops, start_stop_id, end_stop_id, status) "
            "VALUES (:route_id, :route_name, :vehicle_type, 0, NULL, NULL, 'active')"
        ),
        {
            "route_id": new_route_id,
            "route_name": route_name,
            "vehicle_type": "bus",
        },
    )
    db.commit()

    # Return the created route summary
    row = db.execute(
        text(
            "SELECT route_id, route_name, short_name, vehicle_type, "
            "total_stops, approx_distance_km, start_stop_id, end_stop_id "
            "FROM routes WHERE route_id = :route_id AND status = 'active'"
        ),
        {"route_id": new_route_id},
    ).mappings().first()

    if row is None:
        raise HTTPException(status_code=500, detail="Failed to create route")

    return RouteSummaryOut(**dict(row))
