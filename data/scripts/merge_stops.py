"""
merge_stops.py

Applies confirmed stop-duplicate merges from a YAML override file to the
ktm_bus_route_finder database.

For each {keep, drop: [...]} entry:
  1. Repoint route_stops.stop_id from each dropped id -> keep id
  2. Collapse resulting (or pre-existing) consecutive-duplicate stop_id rows
     per route, keeping the lower sequence_no
  3. Renumber sequence_no per route to close any gaps left by the collapse
  4. Repoint routes.start_stop_id / routes.end_stop_id if they reference a
     dropped id
  5. Delete the now-orphaned rows from stops

Everything runs inside a single transaction. Use --dry-run first to see
counts without committing anything.

Usage:
    python merge_stops.py --db-url postgresql://user:pass@localhost/ktm_bus_route_finder \
        --overrides stop_dedup_overrides.yaml --dry-run

    python merge_stops.py --db-url ... --overrides stop_dedup_overrides.yaml --apply
"""

import argparse
import sys
from dataclasses import dataclass

import yaml
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine


@dataclass
class MergeStats:
    keep: str
    drops: list
    routes_repointed: int = 0
    route_stops_repointed: int = 0
    duplicate_rows_deleted: int = 0
    routes_renumbered: int = 0
    routes_start_end_fixed: int = 0
    stops_deleted: int = 0


def load_overrides(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    merges = data.get("confirmed_merges", [])
    if not merges:
        raise ValueError(f"No 'confirmed_merges' found in {path}")
    return merges


def repoint_route_stops(conn, keep: str, drop_ids: list[str]) -> int:
    """Point every route_stops row at a dropped id to the keep id instead."""
    result = conn.execute(
        text(
            """
            UPDATE route_stops
            SET stop_id = :keep
            WHERE stop_id = ANY(:drops)
            """
        ),
        {"keep": keep, "drops": drop_ids},
    )
    return result.rowcount


def collapse_consecutive_duplicates(conn, keep: str) -> int:
    """
    For every route touched by this merge, find consecutive rows where
    stop_id repeats (stop_id = prev stop_id in sequence_no order) and
    delete the later occurrence. Repeats until no more consecutive
    duplicates remain for this stop_id (handles runs of 3+).
    """
    total_deleted = 0
    while True:
        result = conn.execute(
            text(
                """
                WITH flagged AS (
                    SELECT
                        route_id,
                        sequence_no,
                        stop_id,
                        LAG(stop_id) OVER (
                            PARTITION BY route_id ORDER BY sequence_no
                        ) AS prev_stop_id
                    FROM route_stops
                    WHERE stop_id = :keep
                )
                DELETE FROM route_stops rs
                USING flagged f
                WHERE rs.route_id = f.route_id
                  AND rs.sequence_no = f.sequence_no
                  AND rs.stop_id = f.stop_id
                  AND f.stop_id = f.prev_stop_id
                """
            ),
            {"keep": keep},
        )
        deleted = result.rowcount
        total_deleted += deleted
        if deleted == 0:
            break
    return total_deleted


def renumber_sequences(conn, keep: str) -> int:
    """
    Renumber sequence_no (1..n, gap-free) for every route that contains
    the keep stop, preserving existing relative order.
    """
    affected_routes = conn.execute(
        text("SELECT DISTINCT route_id FROM route_stops WHERE stop_id = :keep"),
        {"keep": keep},
    ).scalars().all()

    for route_id in affected_routes:
        rows = conn.execute(
            text(
                """
                SELECT sequence_no FROM route_stops
                WHERE route_id = :route_id
                ORDER BY sequence_no
                """
            ),
            {"route_id": route_id},
        ).scalars().all()

        # Temp-shift to avoid violating the (route_id, sequence_no) PK
        # while renumbering in place.
        conn.execute(
            text(
                """
                UPDATE route_stops
                SET sequence_no = sequence_no + 1000000
                WHERE route_id = :route_id
                """
            ),
            {"route_id": route_id},
        )
        for new_seq, old_seq in enumerate(rows, start=1):
            conn.execute(
                text(
                    """
                    UPDATE route_stops
                    SET sequence_no = :new_seq
                    WHERE route_id = :route_id
                      AND sequence_no = :old_seq_shifted
                    """
                ),
                {
                    "new_seq": new_seq,
                    "route_id": route_id,
                    "old_seq_shifted": old_seq + 1000000,
                },
            )
    return len(affected_routes)


def fix_route_start_end(conn, keep: str, drop_ids: list[str]) -> int:
    result = conn.execute(
        text(
            """
            UPDATE routes
            SET start_stop_id = :keep
            WHERE start_stop_id = ANY(:drops)
            """
        ),
        {"keep": keep, "drops": drop_ids},
    )
    n = result.rowcount
    result = conn.execute(
        text(
            """
            UPDATE routes
            SET end_stop_id = :keep
            WHERE end_stop_id = ANY(:drops)
            """
        ),
        {"keep": keep, "drops": drop_ids},
    )
    n += result.rowcount
    return n


def delete_dropped_stops(conn, drop_ids: list[str]) -> int:
    result = conn.execute(
        text("DELETE FROM stops WHERE stop_id = ANY(:drops)"),
        {"drops": drop_ids},
    )
    return result.rowcount


def apply_merge(conn, merge: dict) -> MergeStats:
    keep = merge["keep"]
    drops = merge["drop"]
    stats = MergeStats(keep=keep, drops=drops)

    stats.route_stops_repointed = repoint_route_stops(conn, keep, drops)
    stats.duplicate_rows_deleted = collapse_consecutive_duplicates(conn, keep)
    stats.routes_renumbered = renumber_sequences(conn, keep)
    stats.routes_start_end_fixed = fix_route_start_end(conn, keep, drops)
    stats.stops_deleted = delete_dropped_stops(conn, drops)

    return stats


def print_report(all_stats: list[MergeStats]) -> None:
    print("\n" + "=" * 78)
    print("MERGE REPORT")
    print("=" * 78)
    for s in all_stats:
        print(f"\nkeep={s.keep}  drop={s.drops}")
        print(f"  route_stops rows repointed:       {s.route_stops_repointed}")
        print(f"  consecutive-duplicate rows removed: {s.duplicate_rows_deleted}")
        print(f"  routes renumbered:                 {s.routes_renumbered}")
        print(f"  routes.start/end_stop_id fixed:    {s.routes_start_end_fixed}")
        print(f"  stops rows deleted:                {s.stops_deleted}")
    print("\n" + "=" * 78)
    total_dup = sum(s.duplicate_rows_deleted for s in all_stats)
    total_stops = sum(s.stops_deleted for s in all_stats)
    print(f"TOTAL consecutive-duplicate rows removed: {total_dup}")
    print(f"TOTAL stops rows deleted:                 {total_stops}")
    print("=" * 78)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-url", required=True, help="postgresql://user:pass@host/dbname")
    parser.add_argument("--overrides", required=True, help="path to stop_dedup_overrides.yaml")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="run and report, then ROLLBACK")
    mode.add_argument("--apply", action="store_true", help="run and COMMIT")
    args = parser.parse_args()

    merges = load_overrides(args.overrides)
    engine: Engine = create_engine(args.db_url)

    all_stats = []
    with engine.connect() as conn:
        trans = conn.begin()
        try:
            for merge in merges:
                stats = apply_merge(conn, merge)
                all_stats.append(stats)

            print_report(all_stats)

            if args.dry_run:
                trans.rollback()
                print("\n[DRY RUN] Rolled back. No changes were committed.")
            else:
                trans.commit()
                print("\n[APPLIED] Changes committed.")
        except Exception:
            trans.rollback()
            print("\n[ERROR] Transaction rolled back due to exception:", file=sys.stderr)
            raise


if __name__ == "__main__":
    main()
