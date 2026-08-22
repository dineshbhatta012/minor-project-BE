import csv
import io
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.routing.graph_builder import refresh_graph
from app.schemas import StopOut, StopUpdateRequest

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
              AND NULLIF(TRIM(stop_name), '') IS NOT NULL
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
              AND NULLIF(TRIM(stop_name), '') IS NOT NULL
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


def _stops_csv_paths() -> list[Path]:
    """Resolve every stop CSV that mirrors the stops table. These are relative
    to the repo root so they work regardless of the backend's working
    directory. The first entry is the processed CSV that is loaded into the DB;
    the rest are the raw source / corrected / verification files that must stay
    in sync so the change survives a fresh import."""
    settings = get_settings()
    repo_root = Path(__file__).resolve().parents[3]
    configured = Path(settings.stops_csv_path)
    if not configured.is_absolute():
        configured = repo_root / configured
    candidates = [
        configured,
        repo_root / "data" / "raw" / "stops_production_v2.csv",
        repo_root / "data" / "scripts" / "stops_corrected.csv",
        repo_root / "data" / "verification" / "stops_verify_dinesh.csv",
        repo_root / "data" / "verification" / "stops_verify_dipesh.csv",
        repo_root / "data" / "verification" / "stops_verify_janak.csv",
    ]
    return candidates


def _update_stop_in_csv(stop_id: str, lat: float, lng: float) -> None:
    """Rewrite every stop CSV that contains this stop_id with the new
    coordinates so the change survives a fresh DB import. Format-preserving
    round-trip — files without a matching row (or without lat/lng columns) are
    left untouched. Handles UTF-8 BOMs and CRLF/LF line endings found in some
    of the raw/verification files."""
    updated = 0
    for path in _stops_csv_paths():
        if not path.exists():
            continue
        raw = path.read_bytes()
        if not raw:
            continue
        has_bom = raw.startswith(b"\xef\xbb\xbf")
        crlf = b"\r\n" in raw
        text = raw.decode("utf-8-sig")
        reader = csv.DictReader(text.splitlines())
        fieldnames = reader.fieldnames
        if not fieldnames or not {"stop_id", "lat", "lng"}.issubset(fieldnames):
            continue
        rows = list(reader)
        if not rows:
            continue
        changed = False
        for row in rows:
            if row.get("stop_id") == stop_id:
                row["lat"] = f"{lat:.6f}"
                row["lng"] = f"{lng:.6f}"
                changed = True
        if not changed:
            continue
        out = io.StringIO()
        writer = csv.DictWriter(
            out,
            fieldnames=fieldnames,
            lineterminator="\r\n" if crlf else "\n",
        )
        writer.writeheader()
        writer.writerows(rows)
        payload = out.getvalue()
        if has_bom:
            payload = "\ufeff" + payload
        path.write_text(payload, encoding="utf-8", newline="")
        updated += 1
    return updated


@router.patch("/{stop_id}", response_model=StopOut)
def update_stop_coordinates(stop_id: str, payload: StopUpdateRequest, db: Session = Depends(get_db)):
    """Update a stop's coordinates in the database, in every stop CSV
    (processed, raw, corrected, verification), and in the in-memory routing
    graph. The geom column is kept in sync automatically by the schema's
    trigger."""
    if not (-90 <= payload.lat <= 90) or not (-180 <= payload.lng <= 180):
        raise HTTPException(
            status_code=422,
            detail="Latitude must be in [-90, 90] and longitude in [-180, 180]",
        )

    row = db.execute(
        text(
            """
            UPDATE stops
            SET lat = :lat, lng = :lng
            WHERE stop_id = :stop_id AND status = 'active'
            RETURNING stop_id, stop_name, lat, lng, is_interchange, is_major_stop
            """
        ),
        {"stop_id": stop_id, "lat": payload.lat, "lng": payload.lng},
    ).mappings().first()
    db.commit()

    if row is None:
        raise HTTPException(status_code=404, detail=f"Active stop '{stop_id}' not found")

    _update_stop_in_csv(stop_id, payload.lat, payload.lng)
    refresh_graph(db)
    return StopOut(**dict(row))
