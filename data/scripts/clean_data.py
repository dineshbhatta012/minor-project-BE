#!/usr/bin/env python3
"""
clean_data.py — Kathmandu Bus Route Finder data-cleaning pipeline.

Turns the raw exports in data/raw/ into the validated tables in data/processed/,
and regenerates processed/report.md documenting exactly what changed.

This reproduces the logic described in the original report.md:
  1. Remove route_stops rows referencing a stop_id with no row in stops
  2. Re-sequence route_stops.sequence_no per route after removals (1..N)
  3. Recompute routes.start_stop_id / end_stop_id / total_stops from route_stops
  4. Null out routes.operator_id where it has no match in operators and is
     not recoverable from operator_id_raw or route_operators
  5. Flag distance outliers (haversine vs. recorded approx_distance_km)
  6. Verify route_operators / operators have no orphan pairs
  7. Run the same post-cleanup integrity checks import.sql runs in Postgres

Usage:
    python scripts/clean_data.py \
        --raw-dir data/raw \
        --out-dir data/processed \
        --config scripts/config.yaml   # optional, see config.example.yaml

Requires: pandas, pyyaml (only if using --config). See requirements.txt.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("clean_data")

UTC_NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

# Kathmandu Valley rough bounding box — used only to flag stops whose lat/lng
# fall outside the expected area (geo_out_of_bounds), not to reject them.
VALLEY_BBOX = {"lat_min": 27.55, "lat_max": 27.85, "lng_min": 85.15, "lng_max": 85.55}


@dataclass
class CleaningStats:
    """Everything needed to regenerate report.md at the end of the run."""

    rows_before: dict[str, int] = field(default_factory=dict)
    rows_after: dict[str, int] = field(default_factory=dict)
    orphan_route_stops_removed: int = 0
    phantom_stop_ids: dict[str, dict] = field(default_factory=dict)  # id -> {name, route_count}
    resequenced_routes: int = 0
    start_stop_corrected: list[str] = field(default_factory=list)
    end_stop_corrected: list[str] = field(default_factory=list)
    total_stops_corrected: list[str] = field(default_factory=list)
    invalid_operator_ids: list[str] = field(default_factory=list)
    operator_id_nulled_routes: list[str] = field(default_factory=list)
    revisit_rows: int = 0
    revisit_routes: int = 0
    distance_flagged_routes: list[str] = field(default_factory=list)
    verification: dict[str, int] = field(default_factory=dict)


def haversine_km(lat1, lng1, lat2, lng2) -> float:
    """Great-circle distance in km between two lat/lng points."""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def load_csv(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(
            f"Expected raw file not found: {path}\n"
            f"Check --raw-dir, or rename your source file to match, or edit "
            f"the RAW_FILENAMES map at the top of clean_data.py."
        )
    log.info("Loading %s", path)
    return pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])


def clean_stops(stops: pd.DataFrame) -> pd.DataFrame:
    """Type-cast, flag out-of-bounds coordinates, stamp timestamps."""
    df = stops.copy()

    for col in ("lat", "lng"):
        df[col] = pd.to_numeric(df[col], errors="raise")

    df["geo_out_of_bounds"] = ~(
        df["lat"].between(VALLEY_BBOX["lat_min"], VALLEY_BBOX["lat_max"])
        & df["lng"].between(VALLEY_BBOX["lng_min"], VALLEY_BBOX["lng_max"])
    )

    bool_cols = [
        "is_major_stop", "has_shelter", "has_ticket_counter",
        "is_interchange", "wheelchair_access", "audio_support",
    ]
    for col in bool_cols:
        if col in df.columns:
            df[col] = df[col].fillna("False").astype(str).str.strip().str.lower().eq("true")

    df["status"] = df["status"].fillna("active")
    df.setdefault = None  # no-op, keeps linters quiet about unused import path
    df["created_at"] = df.get("created_at", pd.Series([None] * len(df))).fillna(UTC_NOW)
    df["updated_at"] = UTC_NOW

    # unverified_fields: any optional field that was blank in the raw export.
    optional_fields = ["ward", "landmark", "has_shelter", "has_ticket_counter",
                        "wheelchair_access", "audio_support"]

    def unverified(row) -> str:
        missing = [f for f in optional_fields if str(row.get(f, "")).strip() in ("", "False", "nan")]
        return "{" + ",".join(missing) + "}" if missing else ""

    if "unverified_fields" not in df.columns:
        df["unverified_fields"] = df.apply(unverified, axis=1)

    dupes = df["stop_id"].duplicated().sum()
    if dupes:
        log.warning("stops: %d duplicate stop_id rows found — keeping first occurrence", dupes)
        df = df.drop_duplicates(subset="stop_id", keep="first")

    return df


def clean_route_stops(
    route_stops: pd.DataFrame, stops: pd.DataFrame, stats: CleaningStats
) -> pd.DataFrame:
    """Remove orphan (route_id, stop_id) pairs and re-sequence per route."""
    df = route_stops.copy()
    df["sequence_no"] = pd.to_numeric(df["sequence_no"], errors="raise").astype(int)

    valid_stop_ids = set(stops["stop_id"])
    orphan_mask = ~df["stop_id"].isin(valid_stop_ids)
    orphans = df[orphan_mask]

    stats.orphan_route_stops_removed = int(orphan_mask.sum())
    for stop_id, grp in orphans.groupby("stop_id"):
        stop_name = grp["stop_name"].iloc[0] if "stop_name" in grp.columns else stop_id
        stats.phantom_stop_ids[stop_id] = {
            "name": stop_name,
            "route_count": grp["route_id"].nunique(),
        }

    df = df[~orphan_mask].copy()

    # Drop denormalized stop_name — canonical name lives in stops.stop_name.
    if "stop_name" in df.columns:
        df = df.drop(columns=["stop_name"])

    # Re-sequence 1..N per route, preserving original relative order.
    df = df.sort_values(["route_id", "sequence_no"])
    df["sequence_no"] = df.groupby("route_id").cumcount() + 1
    stats.resequenced_routes = df["route_id"].nunique()

    # Informational only: stops revisited within the same route (loops/return legs).
    revisits = df.groupby(["route_id", "stop_id"]).size()
    revisits = revisits[revisits > 1]
    stats.revisit_rows = int((revisits - 1).sum())  # extra occurrences beyond the first
    stats.revisit_routes = int(revisits.index.get_level_values("route_id").nunique())

    return df.reset_index(drop=True)


def clean_routes(
    routes: pd.DataFrame,
    route_stops_clean: pd.DataFrame,
    stops: pd.DataFrame,
    operators: pd.DataFrame,
    route_operators: pd.DataFrame,
    stats: CleaningStats,
) -> pd.DataFrame:
    df = routes.copy()

    # --- Recompute start/end/total_stops from the cleaned route_stops ---
    grouped = route_stops_clean.sort_values(["route_id", "sequence_no"]).groupby("route_id")
    first_stop = grouped["stop_id"].first()
    last_stop = grouped["stop_id"].last()
    counts = grouped.size()

    for route_id in df["route_id"]:
        if route_id not in counts.index:
            continue
        row_idx = df.index[df["route_id"] == route_id][0]

        if df.at[row_idx, "start_stop_id"] != first_stop.get(route_id):
            stats.start_stop_corrected.append(route_id)
            df.at[row_idx, "start_stop_id"] = first_stop[route_id]

        if df.at[row_idx, "end_stop_id"] != last_stop.get(route_id):
            stats.end_stop_corrected.append(route_id)
            df.at[row_idx, "end_stop_id"] = last_stop[route_id]

        recomputed_total = int(counts[route_id])
        if str(df.at[row_idx, "total_stops"]) != str(recomputed_total):
            stats.total_stops_corrected.append(route_id)
            df.at[row_idx, "total_stops"] = str(recomputed_total)

    # --- Validate operator_id; null out unrecoverable orphan references ---
    valid_operator_ids = set(operators["operator_id"])
    route_op_lookup = route_operators.groupby("route_id")["operator_id"].apply(set)

    def resolve_operator(row):
        op_id = row.get("operator_id")
        if pd.isna(op_id) or op_id in valid_operator_ids:
            return op_id

        stats.invalid_operator_ids.append(op_id)

        raw = row.get("operator_id_raw")
        if isinstance(raw, str) and raw:
            candidates = [c.strip() for c in raw.split(";") if c.strip() in valid_operator_ids]
            if candidates:
                return candidates[0]

        fallback = route_op_lookup.get(row["route_id"])
        if fallback:
            valid_fallback = fallback & valid_operator_ids
            if valid_fallback:
                return sorted(valid_fallback)[0]

        stats.operator_id_nulled_routes.append(row["route_id"])
        return None

    df["operator_id"] = df.apply(resolve_operator, axis=1)
    stats.invalid_operator_ids = sorted(set(stats.invalid_operator_ids))

    # --- Haversine distance sanity check per route ---
    stop_coords = stops.set_index("stop_id")[["lat", "lng"]]

    def route_haversine(route_id: str) -> tuple[float, float]:
        seq = route_stops_clean[route_stops_clean["route_id"] == route_id].sort_values("sequence_no")
        coords = seq["stop_id"].map(lambda sid: stop_coords.loc[sid] if sid in stop_coords.index else None)
        coords = [c for c in coords if c is not None]
        if len(coords) < 2:
            return 0.0, 0.0
        total, max_jump = 0.0, 0.0
        for a, b in zip(coords, coords[1:]):
            d = haversine_km(a["lat"], a["lng"], b["lat"], b["lng"])
            total += d
            max_jump = max(max_jump, d)
        return round(total, 3), round(max_jump, 3)

    hav_total, hav_max = {}, {}
    for route_id in df["route_id"]:
        t, m = route_haversine(route_id)
        hav_total[route_id] = t
        hav_max[route_id] = m

    df["haversine_distance_km"] = df["route_id"].map(hav_total)
    df["max_consecutive_stop_jump_km"] = df["route_id"].map(hav_max)

    if "approx_distance_km_original" not in df.columns:
        df["approx_distance_km_original"] = df["approx_distance_km"]

    def flag_distance(row) -> bool:
        try:
            recorded = float(row["approx_distance_km_original"])
            hav = float(row["haversine_distance_km"])
        except (TypeError, ValueError):
            return False
        if hav == 0:
            return False
        # Haversine is a straight-line lower bound; flag if recorded distance
        # is implausibly close to or below it (roads are never shorter than
        # straight-line distance between the same two endpoints in sequence).
        return recorded < hav * 0.9

    flagged = df.apply(flag_distance, axis=1)
    df["distance_flagged_for_recompute"] = flagged
    stats.distance_flagged_routes = df.loc[flagged, "route_id"].tolist()

    df["updated_at"] = UTC_NOW
    if "created_at" not in df.columns:
        df["created_at"] = UTC_NOW

    return df


def verify(
    routes: pd.DataFrame,
    stops: pd.DataFrame,
    route_stops: pd.DataFrame,
    operators: pd.DataFrame,
    route_operators: pd.DataFrame,
    stats: CleaningStats,
) -> bool:
    """Mirror the sanity checks import.sql runs in Postgres, in pandas."""
    checks = {
        "route_stops.stop_id not in stops": (~route_stops["stop_id"].isin(stops["stop_id"])).sum(),
        "route_stops.route_id not in routes": (~route_stops["route_id"].isin(routes["route_id"])).sum(),
        "route_operators.route_id not in routes": (~route_operators["route_id"].isin(routes["route_id"])).sum(),
        "route_operators.operator_id not in operators": (~route_operators["operator_id"].isin(operators["operator_id"])).sum(),
        "routes.operator_id not in operators (excl. NULL)": (
            routes["operator_id"].notna() & ~routes["operator_id"].isin(operators["operator_id"])
        ).sum(),
        "routes.start_stop_id not in stops": (~routes["start_stop_id"].isin(stops["stop_id"])).sum(),
        "routes.end_stop_id not in stops": (~routes["end_stop_id"].isin(stops["stop_id"])).sum(),
    }
    counts = route_stops.groupby("route_id").size()
    mismatch = routes.apply(
        lambda r: int(r["total_stops"]) != int(counts.get(r["route_id"], 0)), axis=1
    ).sum()
    checks["routes.total_stops mismatched vs actual route_stops count"] = int(mismatch)

    stats.verification = {k: int(v) for k, v in checks.items()}

    all_zero = True
    for name, count in checks.items():
        status = "OK" if count == 0 else "FAIL"
        if count != 0:
            all_zero = False
        log.info("verify: %-55s %5d  [%s]", name, count, status)
    return all_zero


def write_report(stats: CleaningStats, out_path: Path) -> None:
    lines = ["# Orphan-pair audit & cleanup report — Kathmandu Bus Route Finder\n"]
    lines.append(f"_Generated {UTC_NOW} by scripts/clean_data.py_\n")

    lines.append("| Table | Rows before | Rows after |")
    lines.append("|---|---|---|")
    for table in stats.rows_before:
        lines.append(
            f"| {table} | {stats.rows_before[table]} | {stats.rows_after.get(table, '?')} |"
        )
    lines.append("")

    lines.append("## 1. route_stops orphan pairs")
    lines.append(f"- Removed rows: {stats.orphan_route_stops_removed}")
    if stats.phantom_stop_ids:
        lines.append(f"- Distinct phantom stop_ids ({len(stats.phantom_stop_ids)}):")
        for sid, info in sorted(stats.phantom_stop_ids.items()):
            lines.append(f"    - {sid} (\"{info['name']}\") — referenced by {info['route_count']} route(s)")
    lines.append("")

    lines.append("## 2. route_stops re-sequencing")
    lines.append(f"- Routes re-sequenced (1..N, order preserved): {stats.resequenced_routes}")
    lines.append("")

    lines.append("## 3. routes.start_stop_id / end_stop_id / total_stops recomputation")
    lines.append(f"- start_stop_id corrected: {len(stats.start_stop_corrected)} -> {stats.start_stop_corrected}")
    lines.append(f"- end_stop_id corrected:   {len(stats.end_stop_corrected)} -> {stats.end_stop_corrected}")
    lines.append(f"- total_stops corrected:   {len(stats.total_stops_corrected)} -> {stats.total_stops_corrected}")
    lines.append("")

    lines.append("## 4. routes.operator_id orphan references")
    lines.append(f"- Invalid operator_id value(s): {stats.invalid_operator_ids}")
    lines.append(f"- Routes nulled (unrecoverable): {len(stats.operator_id_nulled_routes)} -> {stats.operator_id_nulled_routes}")
    lines.append("")

    lines.append("## 5. Distance outlier flags")
    lines.append(f"- Routes flagged distance_flagged_for_recompute: {len(stats.distance_flagged_routes)} -> {stats.distance_flagged_routes}")
    lines.append("")

    lines.append("## 6. Post-cleanup verification (must all read 0)")
    for name, count in stats.verification.items():
        lines.append(f"- {name}: {count}")
    lines.append("")

    lines.append("## 7. Note — revisited stops (informational only, not modified)")
    lines.append(
        f"- {stats.revisit_rows} route_stops rows revisit a stop_id already used earlier "
        f"in the same route, across {stats.revisit_routes} routes — consistent with "
        f"loop/return-leg routes. Left untouched."
    )

    out_path.write_text("\n".join(lines), encoding="utf-8")
    log.info("Wrote %s", out_path)


RAW_FILENAMES = {
    "operators": "operators.csv",
    "stops": "stops_production_v2.csv",
    "routes": "routes_production_v2_fixed.csv",
    "route_stops": "route_stops_production_v2.csv",
    "route_operators": "route_operators_production.csv",
    "return_leg": "return_leg_verification_priority_production_fixed.csv",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--out-dir", type=Path, default=Path("data/processed"))
    ap.add_argument("--fail-on-verify-error", action="store_true",
                     help="Exit non-zero if any post-cleanup check is non-zero (recommended for CI)")
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    stats = CleaningStats()

    operators = load_csv(args.raw_dir / RAW_FILENAMES["operators"])
    stops_raw = load_csv(args.raw_dir / RAW_FILENAMES["stops"])
    routes_raw = load_csv(args.raw_dir / RAW_FILENAMES["routes"])
    route_stops_raw = load_csv(args.raw_dir / RAW_FILENAMES["route_stops"])
    route_operators = load_csv(args.raw_dir / RAW_FILENAMES["route_operators"])

    for name, df in [
        ("operators.csv", operators), ("stops.csv", stops_raw),
        ("routes.csv", routes_raw), ("route_stops.csv", route_stops_raw),
        ("route_operators.csv", route_operators),
    ]:
        stats.rows_before[name] = len(df)

    stops = clean_stops(stops_raw)
    route_stops = clean_route_stops(route_stops_raw, stops, stats)
    routes = clean_routes(routes_raw, route_stops, stops, operators, route_operators, stats)

    stats.rows_after["operators.csv"] = len(operators)
    stats.rows_after["stops.csv"] = len(stops)
    stats.rows_after["routes.csv"] = len(routes)
    stats.rows_after["route_stops.csv"] = len(route_stops)
    stats.rows_after["route_operators.csv"] = len(route_operators)

    ok = verify(routes, stops, route_stops, operators, route_operators, stats)

    operators.to_csv(args.out_dir / "operators_clean.csv", index=False)
    stops.to_csv(args.out_dir / "stops_clean.csv", index=False)
    routes.to_csv(args.out_dir / "routes_clean.csv", index=False)
    route_stops.to_csv(args.out_dir / "route_stops_clean.csv", index=False)
    route_operators.to_csv(args.out_dir / "route_operators_clean.csv", index=False)

    return_leg_path = args.raw_dir / RAW_FILENAMES["return_leg"]
    if return_leg_path.exists():
        return_leg = load_csv(return_leg_path)
        return_leg.to_csv(args.out_dir / "return_leg_verification_priority_clean.csv", index=False)
    else:
        log.warning("Skipping return_leg_verification_priority — %s not found", return_leg_path)

    write_report(stats, args.out_dir / "report.md")

    log.info("Done. rows_before=%s rows_after=%s", stats.rows_before, stats.rows_after)

    if args.fail_on_verify_error and not ok:
        log.error("One or more post-cleanup checks failed — see above.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
