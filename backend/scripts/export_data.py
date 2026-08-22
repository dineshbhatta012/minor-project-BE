import sys
from pathlib import Path
import csv
import psycopg2

sys.path.append(str(Path(__file__).resolve().parents[1]))
from app.core.config import get_settings

DATA_DIR_PROCESSED = Path(__file__).resolve().parents[2] / "data" / "processed"
DATA_DIR_RAW = Path(__file__).resolve().parents[2] / "data" / "raw"

LOAD_PLAN = [
    ("operators", "operators_clean.csv", "operator_id, name, service_type, contact_number, rating, unverified_fields"),
    ("stops", "stops_clean.csv", "stop_id, stop_name, aliases, lat, lng, zone, district, ward, is_major_stop, landmark, has_shelter, has_ticket_counter, is_interchange, wheelchair_access, audio_support, status, unverified_fields, created_at, updated_at, geo_out_of_bounds"),
    ("routes", "routes_clean.csv", "route_id, route_name, short_name, vehicle_type, route_type, operator, start_stop_id, end_stop_id, total_stops, approx_distance_km, estimated_duration_min, service_start_time, service_end_time, frequency_min, fare_type, has_ac, is_express, status, created_at, updated_at, operator_id, return_leg_verified, operator_id_raw, is_multi_operator, haversine_distance_km, max_consecutive_stop_jump_km, approx_distance_km_original, distance_flagged_for_recompute, status_original, status_corrected_for_return_leg, is_bidirectional"),
    ("route_stops", "route_stops_clean.csv", "route_id, stop_id, sequence_no"),
    ("route_operators", "route_operators_clean.csv", "route_id, operator_id, is_primary"),
    ("route_return_leg_priority", "return_leg_verification_priority_clean.csv", "route_id, route_name, vehicle_type, operator, total_stops, approx_distance_km, status"),
    ("fare_rules", "fare_rules_clean.csv", "fare_id, min_distance_km, max_distance_km, fare_npr_min, fare_npr_max, student_discount_pct, verification_note"),
]

def get_raw_filename(table):
    if table == 'stops': return 'stops_production_v2.csv'
    if table == 'routes': return 'routes_production_v2_fixed.csv'
    if table == 'route_stops': return 'route_stops_production_v2.csv'
    if table == 'route_operators': return 'route_operators_production.csv'
    if table == 'operators': return 'operators.csv'
    if table == 'route_return_leg_priority': return 'return_leg_verification_priority_production_fixed.csv'
    return None

def process_row(row):
    new_row = []
    for val in row:
        if isinstance(val, list):
            new_row.append(",".join(str(v) for v in val))
        elif isinstance(val, bool):
            new_row.append("True" if val else "False")
        elif val is None:
            new_row.append("")
        else:
            new_row.append(str(val))
    return new_row

def main():
    settings = get_settings()
    dsn = settings.database_url.replace("postgresql+psycopg2://", "postgresql://")
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()

    for table, filename, columns in LOAD_PLAN:
        cols = [c.strip() for c in columns.split(',')]
        
        cur.execute(f"SELECT {', '.join(cols)} FROM {table}")
        rows = cur.fetchall()
        
        csv_path = DATA_DIR_PROCESSED / filename
        with open(csv_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(cols)
            for row in rows:
                writer.writerow(process_row(row))
        print(f"Exported {table} to {filename}")

        # Update routes_clean_no_notes.csv if routes
        if table == 'routes':
            no_notes_path = DATA_DIR_PROCESSED / 'routes_clean_no_notes.csv'
            if no_notes_path.exists():
                with open(no_notes_path, 'w', encoding='utf-8', newline='') as f:
                    writer = csv.writer(f)
                    writer.writerow(cols)
                    for row in rows:
                        writer.writerow(process_row(row))

        raw_name = get_raw_filename(table)
        if raw_name:
            raw_path = DATA_DIR_RAW / raw_name
            if raw_path.exists():
                if table == 'route_stops':
                    cur.execute(f"SELECT rs.route_id, rs.stop_id, rs.sequence_no, s.stop_name FROM route_stops rs LEFT JOIN stops s ON rs.stop_id = s.stop_id ORDER BY rs.route_id, rs.sequence_no")
                    rs_rows = cur.fetchall()
                    with open(raw_path, 'w', encoding='utf-8', newline='') as f:
                        writer = csv.writer(f)
                        writer.writerow(["route_id","stop_id","sequence_no","stop_name"])
                        for row in rs_rows:
                            writer.writerow(process_row(row))
                    print(f"Exported {table} to raw/{raw_name}")
                else:
                    with open(raw_path, 'w', encoding='utf-8', newline='') as f:
                        writer = csv.writer(f)
                        writer.writerow(cols)
                        for row in rows:
                            writer.writerow(process_row(row))
                    print(f"Exported {table} to raw/{raw_name}")

if __name__ == '__main__':
    main()
