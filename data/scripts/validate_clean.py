#!/usr/bin/env python3
"""
validate_clean.py — integrity checks on data/processed/*.csv, no database required.

Runs the same checks as the sanity-check block at the bottom of import.sql,
so you can catch problems in CI before ever touching Postgres.

Usage:
    python scripts/validate_clean.py --dir data/processed
    # exits 1 and prints failures if any check is non-zero
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd


def load(dir_: Path, name: str) -> pd.DataFrame:
    path = dir_ / name
    if not path.exists():
        print(f"MISSING: {path}", file=sys.stderr)
        sys.exit(2)
    return pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[""])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", type=Path, default=Path("data/processed"))
    args = ap.parse_args()

    operators = load(args.dir, "operators_clean.csv")
    stops = load(args.dir, "stops_clean.csv")
    routes = load(args.dir, "routes_clean.csv")
    route_stops = load(args.dir, "route_stops_clean.csv")
    route_operators = load(args.dir, "route_operators_clean.csv")

    checks = {}

    checks["route_stops.stop_id not in stops"] = (
        ~route_stops["stop_id"].isin(stops["stop_id"])
    ).sum()

    checks["route_stops.route_id not in routes"] = (
        ~route_stops["route_id"].isin(routes["route_id"])
    ).sum()

    checks["route_operators.route_id not in routes"] = (
        ~route_operators["route_id"].isin(routes["route_id"])
    ).sum()

    checks["route_operators.operator_id not in operators"] = (
        ~route_operators["operator_id"].isin(operators["operator_id"])
    ).sum()

    checks["routes.operator_id not in operators (excl. NULL)"] = (
        routes["operator_id"].notna()
        & ~routes["operator_id"].isin(operators["operator_id"])
    ).sum()

    checks["routes.start_stop_id not in stops"] = (
        ~routes["start_stop_id"].isin(stops["stop_id"])
    ).sum()

    checks["routes.end_stop_id not in stops"] = (
        ~routes["end_stop_id"].isin(stops["stop_id"])
    ).sum()

    counts = route_stops.groupby("route_id").size()
    mismatch = routes.apply(
        lambda r: int(r["total_stops"]) != int(counts.get(r["route_id"], 0)), axis=1
    ).sum()
    checks["routes.total_stops mismatched vs actual route_stops count"] = int(mismatch)

    dup_stop_ids = stops["stop_id"].duplicated().sum()
    checks["stops.stop_id duplicated"] = int(dup_stop_ids)

    dup_operator_ids = operators["operator_id"].duplicated().sum()
    checks["operators.operator_id duplicated"] = int(dup_operator_ids)

    # sequence_no must be 1..N with no gaps/dupes within each route
    def bad_sequence(group: pd.DataFrame) -> bool:
        seqs = sorted(int(s) for s in group["sequence_no"])
        return seqs != list(range(1, len(seqs) + 1))

    bad_seq_routes = route_stops.groupby("route_id").apply(bad_sequence)
    checks["routes with non-contiguous sequence_no"] = int(bad_seq_routes.sum())

    ok = True
    print(f"{'CHECK':<62}{'COUNT':>8}  STATUS")
    print("-" * 82)
    for name, count in checks.items():
        status = "OK" if count == 0 else "FAIL"
        if count != 0:
            ok = False
        print(f"{name:<62}{count:>8}  {status}")

    print()
    if ok:
        print("All checks passed.")
        return 0
    else:
        print("One or more checks FAILED — see above.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
