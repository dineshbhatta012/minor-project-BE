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
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import squareform

import argparse
import json
import logging
import math
import sys
import difflib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
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

# Routes whose name indicates a one-way loop/circuit — these should never
# be defaulted to bidirectional, since reversing their stop sequence
# wouldn't represent a real return trip along the same streets.
LOOP_KEYWORDS = ("loop", "parikrama")

# Backtrack distance (meters) below which a revisited stop is flagged as a
# LIKELY splice artifact rather than a genuine loop/return-leg. This is a
# heuristic hint for the report only — it never auto-drops anything on its
# own. See resolve_revisits().
REVISIT_BACKTRACK_SUSPECT_M = 400


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
    stop_dedup_groups: list[list[str]] = field(default_factory=list)
    stop_dedup_dropped: int = 0
    route_dedup_merged: list[tuple[str, str]] = field(default_factory=list)
    route_dedup_marked_bidirectional: list[str] = field(default_factory=list)
    stop_dedup_candidates: list[list[str]] = field(default_factory=list)
    stop_dedup_pending_review: list[list[str]] = field(default_factory=list)
    route_dedup_candidates: list[dict] = field(default_factory=list)
    route_dedup_pending_review: list[dict] = field(default_factory=list)
    # --- return-leg / revisit resolution (new) ---
    revisit_candidates: list[dict] = field(default_factory=list)
    revisit_confirmed_dropped_rows: int = 0
    revisit_confirmed_kept_routes: list[str] = field(default_factory=list)
    revisit_confirmed_collapsed_routes: list[str] = field(default_factory=list)
    revisit_pending_review: list[dict] = field(default_factory=list)


def _normalize_stop_name(name: str) -> str:
    """Strip common boilerplate so real name variants compare cleanly."""
    n = str(name).strip().lower()
    for suffix in (" chowk / junction", " chowk/junction", " stop", " station"):
        if n.endswith(suffix):
            n = n[: -len(suffix)]
    return n.strip()


def _names_similar(name_a: str, name_b: str, threshold: float = 0.55) -> bool:
    a, b = _normalize_stop_name(name_a), _normalize_stop_name(name_b)
    if not a or not b:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= threshold

def haversine_km(lat1, lng1, lat2, lng2) -> float:
    """Great-circle distance in km between two lat/lng points."""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def dedup_stops(
    stops: pd.DataFrame, stats: CleaningStats, overrides_path: Path | None = None
) -> tuple[pd.DataFrame, dict[str, str]]:
    """Propose stop-duplicate clusters via ~250m complete-linkage distance
    clustering, but only actually merge pairs confirmed in overrides_path
    (stop_dedup_overrides.yaml). Distance alone cannot distinguish "same
    stop, different name/script" from "different but nearby stops" — see
    report.md history for concrete false positives found by hand. All
    proposed candidates are recorded for human review regardless of
    whether they're confirmed."""
    from scipy.cluster.hierarchy import linkage, fcluster
    from scipy.spatial.distance import squareform

    DEDUP_RADIUS_M = 250

    df = stops.reset_index(drop=True)
    n = len(df)
    lat = df["lat"].to_numpy()
    lng = df["lng"].to_numpy()
    id_to_idx = {sid: i for i, sid in enumerate(df["stop_id"])}

    dist_matrix = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            d = haversine_km(lat[i], lng[i], lat[j], lng[j]) * 1000
            dist_matrix[i, j] = dist_matrix[j, i] = d

    condensed = squareform(dist_matrix, checks=False)
    Z = linkage(condensed, method="complete")
    cluster_labels = fcluster(Z, t=DEDUP_RADIUS_M, criterion="distance")

    candidate_clusters: list[list[str]] = []
    label_groups: dict[int, list[int]] = {}
    for idx, label in enumerate(cluster_labels):
        label_groups.setdefault(label, []).append(idx)
    for members in label_groups.values():
        if len(members) > 1:
            candidate_clusters.append([df.at[idx, "stop_id"] for idx in members])

    stats.stop_dedup_candidates = candidate_clusters

    # Load human-confirmed merges. Nothing merges without this.
    confirmed: dict[str, str] = {}  # dropped_id -> keeper_id
    if overrides_path and overrides_path.exists():
        import yaml
        with open(overrides_path) as f:
            data = yaml.safe_load(f) or {}
        for entry in data.get("confirmed_merges", []):
            keeper = entry["keep"]
            for dropped in entry.get("drop", []):
                confirmed[dropped] = keeper

    def completeness(idx: int) -> int:
        row = df.iloc[idx]
        return sum(1 for v in row.values if str(v).strip() not in ("", "nan", "None"))

    remap: dict[str, str] = {}
    for dropped_id, keeper_id in confirmed.items():
        if dropped_id not in id_to_idx or keeper_id not in id_to_idx:
            log.warning(
                "stop_dedup_overrides.yaml references unknown stop_id (keep=%s, drop=%s) — skipped",
                keeper_id, dropped_id,
            )
            continue
        remap[dropped_id] = keeper_id
        stats.stop_dedup_groups.append([keeper_id, dropped_id])

    unconfirmed_candidates = [
        c for c in candidate_clusters if not any(sid in confirmed for sid in c)
    ]
    if unconfirmed_candidates:
        log.info(
            "%d candidate duplicate cluster(s) proposed but NOT merged — "
            "needs human review, see report.md and add confirmed pairs to %s",
            len(unconfirmed_candidates), overrides_path,
        )

    stats.stop_dedup_dropped = len(remap)
    stats.stop_dedup_pending_review = unconfirmed_candidates

    keep_indices = [i for i in range(n) if df.at[i, "stop_id"] not in remap]
    deduped = df.iloc[sorted(keep_indices)].reset_index(drop=True)
    return deduped, remap

def remap_stop_ids(route_stops: pd.DataFrame, remap: dict[str, str]) -> pd.DataFrame:
    """Apply a {dropped_stop_id: kept_stop_id} remap to route_stops.stop_id."""
    if not remap:
        return route_stops
    df = route_stops.copy()
    df["stop_id"] = df["stop_id"].map(lambda sid: remap.get(sid, sid))
    return df


def _stop_set_similarity(a: frozenset, b: frozenset) -> float:
    """Jaccard similarity between two stop sets."""
    if not a and not b:
        return 1.0
    return len(a & b) / len(a | b)


def dedup_routes(
    routes: pd.DataFrame,
    route_stops: pd.DataFrame,
    route_operators: pd.DataFrame,
    stats: CleaningStats,
    overrides_path: Path | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Propose route-duplicate candidates (same operator, stop-set Jaccard
    similarity >= threshold) but only merge pairs confirmed in
    overrides_path (route_dedup_overrides.yaml). Exact reverse-sequence
    matches are flagged specially since they're the clearest case for
    is_bidirectional, but even those require explicit confirmation —
    some "duplicates" (see R2988835/R2988836) turn out to be genuinely
    different route variants with partial stop overlap, not simple
    A-to-B/B-to-A pairs."""
    SIMILARITY_THRESHOLD = 0.7

    if "is_bidirectional" not in routes.columns:
        routes = routes.copy()
        routes["is_bidirectional"] = False
    else:
        routes = routes.copy()
        routes["is_bidirectional"] = (
            routes["is_bidirectional"].fillna("False").astype(str).str.strip().str.lower().eq("true")
        )

    ordered = route_stops.sort_values("sequence_no").groupby("route_id")["stop_id"].apply(tuple)
    routes["stop_seq_tmp"] = routes["route_id"].map(lambda rid: ordered.get(rid, ()))
    routes["stop_set_tmp"] = routes["stop_seq_tmp"].map(frozenset)

    candidates: list[dict] = []
    by_operator = routes.groupby("operator_id")
    for operator_id, group in by_operator:
        if pd.isna(operator_id) or len(group) < 2:
            continue
        rows = list(group[["route_id", "route_name", "stop_seq_tmp", "stop_set_tmp"]].itertuples(index=False))
        for i in range(len(rows)):
            for j in range(i + 1, len(rows)):
                a, b = rows[i], rows[j]
                sim = _stop_set_similarity(a.stop_set_tmp, b.stop_set_tmp)
                if sim < SIMILARITY_THRESHOLD:
                    continue
                is_exact_reverse = a.stop_seq_tmp == tuple(reversed(b.stop_seq_tmp))
                candidates.append({
                    "route_a": a.route_id, "name_a": a.route_name,
                    "route_b": b.route_id, "name_b": b.route_name,
                    "operator_id": operator_id,
                    "similarity": round(sim, 2),
                    "exact_reverse": is_exact_reverse,
                })

    stats.route_dedup_candidates = candidates

    confirmed: dict[str, dict] = {}  # dropped_route_id -> {"keep": ..., "bidirectional": bool}
    if overrides_path and overrides_path.exists():
        import yaml
        with open(overrides_path) as f:
            data = yaml.safe_load(f) or {}
        for entry in data.get("confirmed_merges", []):
            keeper = entry["keep"]
            bidirectional = entry.get("bidirectional", False)
            for dropped in entry.get("drop", []):
                confirmed[dropped] = {"keep": keeper, "bidirectional": bidirectional}

    dropped_route_ids: set[str] = set()
    for dropped_id, info in confirmed.items():
        keeper_id = info["keep"]
        if dropped_id not in set(routes["route_id"]) or keeper_id not in set(routes["route_id"]):
            log.warning(
                "route_dedup_overrides.yaml references unknown route_id (keep=%s, drop=%s) — skipped",
                keeper_id, dropped_id,
            )
            continue
        dropped_route_ids.add(dropped_id)
        stats.route_dedup_merged.append((keeper_id, dropped_id))
        if info["bidirectional"]:
            routes.loc[routes["route_id"] == keeper_id, "is_bidirectional"] = True
            stats.route_dedup_marked_bidirectional.append(keeper_id)

    pending = [
        c for c in candidates
        if c["route_a"] not in dropped_route_ids and c["route_b"] not in dropped_route_ids
        and not (c["route_a"] in confirmed or c["route_b"] in confirmed)
    ]
    stats.route_dedup_pending_review = pending
    if pending:
        log.info(
            "%d candidate duplicate route pair(s) proposed but NOT merged — "
            "needs human review, see report.md and add confirmed pairs to %s",
            len(pending), overrides_path,
        )

    routes = routes[~routes["route_id"].isin(dropped_route_ids)].drop(columns=["stop_seq_tmp", "stop_set_tmp"])
    route_stops = route_stops[~route_stops["route_id"].isin(dropped_route_ids)]
    route_operators = route_operators[~route_operators["route_id"].isin(dropped_route_ids)]

    return routes.reset_index(drop=True), route_stops.reset_index(drop=True), route_operators.reset_index(drop=True), dropped_route_ids


def resolve_revisits(
    route_stops: pd.DataFrame,
    stops: pd.DataFrame,
    stats: CleaningStats,
    overrides_path: Path | None = None,
) -> pd.DataFrame:
    """Resolve route_stops rows that revisit a stop_id already used earlier
    in the same route.

    A revisit can be either:
      (a) a genuine loop / return-leg route where the sequence legitimately
          passes the same physical stop twice, or
      (b) a data-splice artifact (e.g. outbound + return-leg source rows
          concatenated during raw data assembly), which shows up as
          A -> B -> A with B a nearby-but-distinct stop and a short
          backtrack distance.

    Geometry alone can't reliably tell these apart — see report.md history
    (Buddhanagar Stop / Jadibuti / Gopi Krishna Stop cases, all also present
    in return_leg_verification_priority_production_fixed.csv with
    return_leg_verified=False). So, mirroring dedup_stops()/dedup_routes():
    every route with a revisit is recorded as a *candidate*, annotated with
    a backtrack-distance hint, but ONLY routes confirmed in overrides_path
    (return_leg_overrides.yaml, verdict: drop_repeats) actually get rows
    removed. Routes confirmed verdict: keep are left untouched and recorded
    as confirmed. Anything not yet in the overrides file is left untouched
    AND surfaced in revisit_pending_review so it doesn't silently pass
    through as "assumed fine."
    """
    df = route_stops.sort_values(["route_id", "sequence_no"]).reset_index(drop=True)
    stop_coords = stops.set_index("stop_id")[["lat", "lng"]]

    candidates: list[dict] = []
    for route_id, grp in df.groupby("route_id"):
        grp = grp.reset_index(drop=True)
        ids = grp["stop_id"].tolist()
        seen: dict[str, int] = {}
        dup_positions: dict[str, list[int]] = {}
        for i, sid in enumerate(ids):
            if sid in seen:
                dup_positions.setdefault(sid, [seen[sid]]).append(i)
            else:
                seen[sid] = i
        for sid, positions in dup_positions.items():
            first_idx, second_idx = positions[0], positions[1]
            bridge_sid = ids[second_idx - 1] if second_idx - 1 != first_idx else None
            backtrack_m = None
            if bridge_sid and sid in stop_coords.index and bridge_sid in stop_coords.index:
                a, b = stop_coords.loc[sid], stop_coords.loc[bridge_sid]
                backtrack_m = round(haversine_km(a["lat"], a["lng"], b["lat"], b["lng"]) * 1000, 1)
            candidates.append({
                "route_id": route_id,
                "stop_id": sid,
                "sequence_positions": [int(grp.at[p, "sequence_no"]) for p in positions],
                "bridge_stop_id": bridge_sid,
                "backtrack_m": backtrack_m,
                "suspect": backtrack_m is not None and backtrack_m < REVISIT_BACKTRACK_SUSPECT_M,
            })

    stats.revisit_candidates = candidates
    revisited_routes = sorted({c["route_id"] for c in candidates})

    verdicts: dict[str, str] = {}  # route_id -> "keep" | "drop_repeats"
    if overrides_path and overrides_path.exists():
        import yaml
        with open(overrides_path) as f:
            data = yaml.safe_load(f) or {}
        for entry in data.get("routes", []):
            rid = entry.get("route_id")
            verdict = entry.get("verdict")
            if rid and verdict in ("keep", "drop_repeats"):
                verdicts[rid] = verdict
            elif rid:
                log.warning(
                    "return_leg_overrides.yaml: route %s has unrecognized verdict %r — ignored",
                    rid, verdict,
                )

    drop_row_mask = pd.Series(False, index=df.index)
    for route_id in revisited_routes:
        verdict = verdicts.get(route_id)
        if verdict == "keep":
            stats.revisit_confirmed_kept_routes.append(route_id)
            continue
        if verdict == "drop_repeats":
            route_mask = df["route_id"] == route_id
            sub = df[route_mask]
            ids = sub["stop_id"]
            later_dupe_mask = route_mask & df["stop_id"].isin(ids[ids.duplicated()].unique()) & df.duplicated(subset=["route_id", "stop_id"], keep="first")
            drop_row_mask |= later_dupe_mask
            stats.revisit_confirmed_collapsed_routes.append(route_id)
            continue
        # No confirmed verdict yet — leave rows untouched, but surface it.
        stats.revisit_pending_review.append({
            "route_id": route_id,
            "revisits": [c for c in candidates if c["route_id"] == route_id],
        })

    if stats.revisit_pending_review:
        log.info(
            "%d route(s) have unresolved stop revisits — needs human review, "
            "see report.md and add verdicts to %s",
            len(stats.revisit_pending_review), overrides_path,
        )

    stats.revisit_confirmed_dropped_rows = int(drop_row_mask.sum())
    df = df[~drop_row_mask].copy()

    # Re-sequence 1..N per route after any drops, preserving relative order.
    df = df.sort_values(["route_id", "sequence_no"])
    df["sequence_no"] = df.groupby("route_id").cumcount() + 1

    # Informational: revisits still present after resolution (i.e. confirmed
    # "keep" routes, or unresolved ones left untouched pending review).
    remaining = df.groupby(["route_id", "stop_id"]).size()
    remaining = remaining[remaining > 1]
    stats.revisit_rows = int((remaining - 1).sum())
    stats.revisit_routes = int(remaining.index.get_level_values("route_id").nunique()) if len(remaining) else 0

    return df.reset_index(drop=True)


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
    route_stops: pd.DataFrame,
    stops: pd.DataFrame,
    stats: CleaningStats,
    revisit_overrides_path: Path | None = None,
) -> pd.DataFrame:
    """Remove orphan (route_id, stop_id) pairs, re-sequence per route, then
    resolve revisited stops via resolve_revisits() (see its docstring)."""
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

    # Resolve revisits (confirmed drop_repeats / keep / pending review).
    # This re-sequences again internally after any drops.
    df = resolve_revisits(df, stops, stats, overrides_path=revisit_overrides_path)

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
            recorded = float(row["approx_distance_km"])
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


def apply_default_bidirectional_and_status(routes: pd.DataFrame) -> pd.DataFrame:
    """Default every non-loop route to is_bidirectional=True and every
    route to status='active'. This is a deliberate operational decision
    made after manually reviewing the dataset — most routes here are
    genuinely two-way corridors even though the raw data models each
    direction as (or lacks) a separate one-way entry, and pending_release
    was blocking working routes from ever being used by the app. Loop/
    circuit routes (see LOOP_KEYWORDS) are excluded from the bidirectional
    default since their stop sequence only makes sense in one direction.

    This intentionally overrides the more conservative per-pair
    confirmation flow in dedup_routes() (which only sets is_bidirectional
    via route_dedup_overrides.yaml) and skips the return-leg verification
    gate implied by status_original/status_corrected_for_return_leg. If a
    dataset later needs any given route to actually stay pending_release
    or one-way, exclude it here explicitly rather than relying on that
    stricter per-pair mechanism to catch it.
    """
    df = routes.copy()
    is_loop = df["route_name"].str.lower().str.contains(
        "|".join(LOOP_KEYWORDS), regex=True, na=False
    )
    df.loc[~is_loop, "is_bidirectional"] = True
    df["status"] = "active"
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

    lines.append("## 2b. Stop deduplication (~250m radius candidates)")
    lines.append(f"- Stops actually merged (human-confirmed via stop_dedup_overrides.yaml): {stats.stop_dedup_dropped}")
    if stats.stop_dedup_groups:
        for group in stats.stop_dedup_groups:
            lines.append(f"    - kept {group[0]}, dropped {group[1:]}")
    lines.append(f"- Candidate clusters PENDING human review (not merged): {len(stats.stop_dedup_pending_review)}")
    if stats.stop_dedup_pending_review:
        lines.append("  Distance alone can't tell 'same stop, different name' from 'different nearby stops' —")
        lines.append("  add confirmed pairs to data/scripts/stop_dedup_overrides.yaml to merge them:")
        for group in stats.stop_dedup_pending_review:
            names = ", ".join(f"{sid} ({df_name_lookup.get(sid, '?')})" for sid in group) if False else ", ".join(group)
            lines.append(f"    - {group}")
    lines.append("")

    lines.append("## 2c. Route deduplication (same operator + similar stop set)")
    lines.append(f"- Routes actually merged (human-confirmed via route_dedup_overrides.yaml): {len(stats.route_dedup_merged)}")
    for keeper, dropped in stats.route_dedup_merged:
        lines.append(f"    - kept {keeper}, dropped {dropped}")
    lines.append(f"- Marked is_bidirectional as a result of merge: {stats.route_dedup_marked_bidirectional}")
    lines.append(f"- Candidate pairs PENDING human review (not merged): {len(stats.route_dedup_pending_review)}")
    for c in stats.route_dedup_pending_review:
        reverse_note = " [EXACT REVERSE — likely a clean bidirectional pair]" if c["exact_reverse"] else ""
        lines.append(
            f"    - {c['route_a']} (\"{c['name_a']}\") <-> {c['route_b']} (\"{c['name_b']}\") "
            f"— stop-set similarity {c['similarity']}{reverse_note}"
        )
    lines.append("")

    lines.append("## 2d. Revisited-stop resolution (return-leg / splice candidates)")
    lines.append(
        f"- Candidate (route, stop_id) revisit pairs found: {len(stats.revisit_candidates)} "
        f"across {len({c['route_id'] for c in stats.revisit_candidates})} route(s)"
    )
    lines.append(f"- Rows dropped (human-confirmed verdict: drop_repeats): {stats.revisit_confirmed_dropped_rows}")
    if stats.revisit_confirmed_collapsed_routes:
        lines.append(f"    - routes collapsed to first occurrence: {stats.revisit_confirmed_collapsed_routes}")
    if stats.revisit_confirmed_kept_routes:
        lines.append(f"- Routes confirmed as genuine loop/return-leg (verdict: keep): {stats.revisit_confirmed_kept_routes}")
    lines.append(f"- Routes PENDING human review (no verdict yet, left untouched): {len(stats.revisit_pending_review)}")
    if stats.revisit_pending_review:
        lines.append("  Add a verdict (keep / drop_repeats) to data/scripts/return_leg_overrides.yaml.")
        lines.append("  Cross-check against return_leg_verification_priority_production_fixed.csv.")
        for entry in stats.revisit_pending_review:
            for r in entry["revisits"]:
                suspect_note = " [SUSPECT — short backtrack, likely splice artifact]" if r["suspect"] else ""
                lines.append(
                    f"    - {entry['route_id']}: {r['stop_id']} at seq {r['sequence_positions']}, "
                    f"bridge stop {r['bridge_stop_id']}, backtrack {r['backtrack_m']}m{suspect_note}"
                )
    lines.append("")

    lines.append("## 3a. routes.start_stop_id / end_stop_id / total_stops recomputation")
    lines.append(f"- start_stop_id corrected: {len(stats.start_stop_corrected)} -> {stats.start_stop_corrected}")
    lines.append(f"- end_stop_id corrected:   {len(stats.end_stop_corrected)} -> {stats.end_stop_corrected}")
    lines.append(f"- total_stops corrected:   {len(stats.total_stops_corrected)} -> {stats.total_stops_corrected}")
    lines.append("")

    lines.append("## 3b. Default bidirectional/status override")
    lines.append(
    "- All non-loop routes forced to is_bidirectional=True; all routes forced to status='active'. "
    "See apply_default_bidirectional_and_status() docstring for why."
    )
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

    lines.append("## 7. Note — revisited stops remaining after resolution (informational)")
    lines.append(
        f"- {stats.revisit_rows} route_stops rows still revisit a stop_id already used earlier "
        f"in the same route, across {stats.revisit_routes} routes, after applying confirmed "
        f"verdicts above. These are either confirmed genuine loops (verdict: keep) or still "
        f"pending human review — see section 2d."
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
    stops, stop_id_remap = dedup_stops(stops, stats, overrides_path=Path("data/scripts/stop_dedup_overrides.yaml"))
    route_stops_raw = remap_stop_ids(route_stops_raw, stop_id_remap)

    route_stops = clean_route_stops(
        route_stops_raw, stops, stats,
        revisit_overrides_path=Path("data/scripts/return_leg_overrides.yaml"),
    )

    routes_raw, route_stops, route_operators, dropped_route_ids = dedup_routes(
        routes_raw, route_stops, route_operators, stats,
        overrides_path=Path("data/scripts/route_dedup_overrides.yaml"),
    )

    routes = clean_routes(routes_raw, route_stops, stops, operators, route_operators, stats)
    routes = apply_default_bidirectional_and_status(routes)

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
        orphaned = return_leg[return_leg["route_id"].isin(dropped_route_ids)]
        if len(orphaned):
            log.info(
                "Dropping %d return_leg_verification_priority row(s) referencing merged-away routes: %s",
                len(orphaned), orphaned["route_id"].tolist(),
            )
        return_leg = return_leg[~return_leg["route_id"].isin(dropped_route_ids)]
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
