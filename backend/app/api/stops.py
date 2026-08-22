import csv
import io
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import get_db
from app.routing.graph_builder import refresh_graph
from app.schemas import StopOut, StopUpdateRequest, StopCreateRequest

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


def _add_stop_to_csv(stop_id: str, stop_name: str, lat: float, lng: float, is_interchange: bool, is_major_stop: bool) -> int:
    """Append a new stop to every stop CSV. Handles CSV files that might not 
    have the exact same columns by mapping only what exists."""
    updated = 0
    for path in _stops_csv_paths():
        if not path.exists():
            continue
        raw = path.read_bytes()
        if not raw:
            continue
        has_bom = raw.startswith(b"\xef\xbb\xbf")
        crlf = b"\r\n" in raw
        text_content = raw.decode("utf-8-sig")
        lines = text_content.splitlines()
        
        reader = csv.DictReader(lines)
        fieldnames = reader.fieldnames
        if not fieldnames or not {"stop_id", "stop_name", "lat", "lng"}.issubset(fieldnames):
            continue
            
        rows = list(reader)
        
        new_row = {}
        for field in fieldnames:
            if field == "stop_id":
                new_row[field] = stop_id
            elif field == "stop_name":
                new_row[field] = stop_name
            elif field == "lat":
                new_row[field] = f"{lat:.6f}"
            elif field == "lng":
                new_row[field] = f"{lng:.6f}"
            elif field == "is_interchange":
                new_row[field] = str(is_interchange).upper()
            elif field == "is_major_stop":
                new_row[field] = str(is_major_stop).upper()
            elif field == "status":
                new_row[field] = "active"
            else:
                new_row[field] = ""
                
        rows.append(new_row)
        
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


@router.post("", response_model=StopOut)
def create_stop(payload: StopCreateRequest, db: Session = Depends(get_db)):
    """Create a new bus stop in the database and append it to all stop CSVs."""
    if not (-90 <= payload.lat <= 90) or not (-180 <= payload.lng <= 180):
        raise HTTPException(
            status_code=422,
            detail="Latitude must be in [-90, 90] and longitude in [-180, 180]",
        )
        
    if not payload.stop_name.strip():
        raise HTTPException(status_code=422, detail="Stop name cannot be empty")

    # Generate a new stop ID, e.g. "S_9999" - basic approach
    max_id_row = db.execute(text("SELECT MAX(CAST(SUBSTRING(stop_id FROM 3) AS INTEGER)) as max_id FROM stops WHERE stop_id LIKE 'S_%'")).mappings().first()
    next_id_num = (max_id_row["max_id"] or 0) + 1
    new_stop_id = f"S_{next_id_num}"

    row = db.execute(
        text(
            """
            INSERT INTO stops (stop_id, stop_name, lat, lng, is_interchange, is_major_stop, status)
            VALUES (:stop_id, :stop_name, :lat, :lng, :is_interchange, :is_major_stop, 'active')
            RETURNING stop_id, stop_name, lat, lng, is_interchange, is_major_stop
            """
        ),
        {
            "stop_id": new_stop_id, 
            "stop_name": payload.stop_name.strip(), 
            "lat": payload.lat, 
            "lng": payload.lng,
            "is_interchange": payload.is_interchange,
            "is_major_stop": payload.is_major_stop
        },
    ).mappings().first()
    db.commit()

    _add_stop_to_csv(
        new_stop_id, 
        payload.stop_name.strip(), 
        payload.lat, 
        payload.lng, 
        payload.is_interchange, 
        payload.is_major_stop
    )
    
    refresh_graph(db)
    return StopOut(**dict(row))
