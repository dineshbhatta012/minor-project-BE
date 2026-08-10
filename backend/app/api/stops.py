from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.schemas import StopOut

router = APIRouter(prefix="/stops", tags=["stops"])


@router.get("", response_model=list[StopOut])
def list_stops(db: Session = Depends(get_db)):
    """All active stops. The frontend fetches this once on load to populate
    the search-form autocomplete and resolve typed stop names to stop_ids."""
    rows = db.execute(
        text(
            """
            SELECT stop_id, stop_name, lat, lng, is_interchange, is_major_stop
            FROM stops
            WHERE status = 'active'
            ORDER BY stop_name
            """
        )
    ).mappings()
    return [StopOut(**dict(r)) for r in rows]


@router.get("/nearest", response_model=list[StopOut])
def nearest_stops(
    lat: float = Query(..., ge=-90, le=90),
    lng: float = Query(..., ge=-180, le=180),
    limit: int = Query(5, ge=1, le=20),
    db: Session = Depends(get_db),
):
    """Nearest active stops to a point, using PostGIS's geography distance
    (accounts for the earth's curvature, unlike a naive lat/lng bounding box).
    Useful for a future 'use my location' feature."""
    rows = db.execute(
        text(
            """
            SELECT stop_id, stop_name, lat, lng, is_interchange, is_major_stop
            FROM stops
            WHERE status = 'active'
            ORDER BY geom <-> ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
            LIMIT :limit
            """
        ),
        {"lat": lat, "lng": lng, "limit": limit},
    ).mappings()
    result = [StopOut(**dict(r)) for r in rows]
    if not result:
        raise HTTPException(status_code=404, detail="No active stops found")
    return result
