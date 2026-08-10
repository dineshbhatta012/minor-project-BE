from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas import RouteDetailOut, RouteSummaryOut, StopOut

router = APIRouter(prefix="/routes", tags=["routes"])


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
        raise HTTPException(status_code=404, detail=f"Route '{route_id}' not found")

    stop_rows = db.execute(
        text(
            """
            SELECT s.stop_id, s.stop_name, s.lat, s.lng, s.is_interchange, s.is_major_stop
            FROM route_stops rs
            JOIN stops s ON s.stop_id = rs.stop_id
            WHERE rs.route_id = :route_id
            ORDER BY rs.sequence_no
            """
        ),
        {"route_id": route_id},
    ).mappings()

    return RouteDetailOut(
        **dict(route_row),
        stops=[StopOut(**dict(r)) for r in stop_rows],
    )
