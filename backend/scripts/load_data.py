"""
Loads the cleaned CSVs (../data/processed/*.csv, relative to this repo's
root) into the schema created by data/schema.sql.

Run schema.sql first (see SETUP.md), then:
    python scripts/load_data.py

Uses psycopg2's copy_expert, which streams each CSV to Postgres over the
COPY protocol — unlike psql's \\copy meta-command, this doesn't require the
CSV path to be visible from wherever Postgres itself is running (handy since
Postgres runs inside Docker here, but the CSVs live on the host).
"""

import sys
from pathlib import Path

import psycopg2

from app.core.config import get_settings

# repo layout is:  <root>/backend/scripts/load_data.py  and  <root>/data/processed/
DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"

# Order matters: foreign keys mean operators/stops must load before routes,
# and routes before route_stops/route_operators. Mirrors data/import.sql.
LOAD_PLAN = [
    ("operators", "operators_clean.csv",
     "operator_id, name, service_type, contact_number, rating, unverified_fields"),
    ("stops", "stops_clean.csv",
     "stop_id, stop_name, aliases, lat, lng, zone, district, ward, is_major_stop, "
     "landmark, has_shelter, has_ticket_counter, is_interchange, wheelchair_access, "
     "audio_support, status, unverified_fields, created_at, updated_at, geo_out_of_bounds"),
    ("routes", "routes_clean.csv",
     "route_id, route_name, short_name, vehicle_type, route_type, operator, "
     "start_stop_id, end_stop_id, total_stops, approx_distance_km, "
     "estimated_duration_min, service_start_time, service_end_time, frequency_min, "
     "fare_type, has_ac, is_express, status, created_at, updated_at, operator_id, "
     "return_leg_verified, operator_id_raw, is_multi_operator, haversine_distance_km, "
     "max_consecutive_stop_jump_km, approx_distance_km_original, "
     "distance_flagged_for_recompute, status_original, status_corrected_for_return_leg, "
     "is_bidirectional"),
    ("route_stops", "route_stops_clean.csv", "route_id, stop_id, sequence_no"),
    ("route_operators", "route_operators_clean.csv", "route_id, operator_id, is_primary"),
    ("route_return_leg_priority", "return_leg_verification_priority_clean.csv",
     "route_id, route_name, vehicle_type, operator, total_stops, approx_distance_km, status"),
    ("fare_rules", "fare_rules_clean.csv",
     "fare_id, min_distance_km, max_distance_km, fare_npr_min, fare_npr_max, "
     "student_discount_pct, verification_note"),
]

SANITY_CHECKS_SQL = """
SELECT 'route_stops -> stops orphan' AS check, count(*) FROM route_stops rs
  LEFT JOIN stops s ON rs.stop_id = s.stop_id WHERE s.stop_id IS NULL
UNION ALL
SELECT 'route_stops -> routes orphan', count(*) FROM route_stops rs
  LEFT JOIN routes r ON rs.route_id = r.route_id WHERE r.route_id IS NULL
UNION ALL
SELECT 'route_operators -> operators orphan', count(*) FROM route_operators ro
  LEFT JOIN operators o ON ro.operator_id = o.operator_id WHERE o.operator_id IS NULL
UNION ALL
SELECT 'routes.total_stops mismatch', count(*) FROM routes r
  LEFT JOIN (SELECT route_id, count(*) c FROM route_stops GROUP BY route_id) rs
  ON rs.route_id = r.route_id WHERE r.total_stops IS DISTINCT FROM rs.c
UNION ALL
SELECT 'stops missing geom', count(*) FROM stops WHERE geom IS NULL;
"""


def main():
    settings = get_settings()
    # psycopg2 wants a plain postgresql:// DSN, not SQLAlchemy's
    # postgresql+psycopg2:// variant
    dsn = settings.database_url.replace("postgresql+psycopg2://", "postgresql://")

    if not DATA_DIR.exists():
        print(f"Data directory not found: {DATA_DIR}", file=sys.stderr)
        print("Expected repo layout: <root>/data/processed/ and <root>/backend/", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    cur = conn.cursor()

    try:
        for table, filename, columns in LOAD_PLAN:
            csv_path = DATA_DIR / filename
            if not csv_path.exists():
                print(f"  SKIP {table}: {csv_path} not found", file=sys.stderr)
                continue
            with open(csv_path, encoding="utf-8") as f:
                cur.copy_expert(
                    f"COPY {table} ({columns}) FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')",
                    f,
                )
            print(f"  loaded {table} from {filename} ({cur.rowcount} rows)")

        print("\nSanity checks (every count should be 0):")
        cur.execute(SANITY_CHECKS_SQL)
        ok = True
        for check, count in cur.fetchall():
            marker = "OK" if count == 0 else "FAIL"
            if count != 0:
                ok = False
            print(f"  [{marker}] {check}: {count}")

        if not ok:
            print("\nSanity checks failed — rolling back, nothing was committed.", file=sys.stderr)
            conn.rollback()
            sys.exit(1)

        conn.commit()
        print("\nAll tables loaded and committed successfully.")

    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
