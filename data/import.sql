-- ============================================================================
-- Import cleaned CSVs into the schema created by schema.sql.
--
-- Before running, replace every occurrence of C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/ below with the
-- absolute path to the folder containing the *_clean.csv files (client-side
-- path, since \copy runs on the machine running psql). Then:
--   psql -d your_database -f import.sql
-- ============================================================================

\copy operators (operator_id, name, service_type, contact_number, rating, unverified_fields) FROM 'C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/operators_clean.csv' WITH (FORMAT csv, HEADER true, NULL '')

-- geom is populated automatically by the trg_stops_set_geom trigger (schema.sql) as each row lands
\copy stops (stop_id, stop_name, aliases, lat, lng, zone, district, ward, is_major_stop, landmark, has_shelter, has_ticket_counter, is_interchange, wheelchair_access, audio_support, status, unverified_fields, created_at, updated_at, geo_out_of_bounds) FROM 'C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/stops_clean.csv' WITH (FORMAT csv, HEADER true, NULL '')

\copy routes (route_id, route_name, short_name, vehicle_type, route_type, operator, start_stop_id, end_stop_id, total_stops, approx_distance_km, estimated_duration_min, service_start_time, service_end_time, frequency_min, fare_type, has_ac, is_express, status, created_at, updated_at, operator_id, return_leg_verified, operator_id_raw, is_multi_operator, haversine_distance_km, max_consecutive_stop_jump_km, approx_distance_km_original, distance_flagged_for_recompute, status_original, status_corrected_for_return_leg, is_bidirectional) FROM 'C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/routes_clean_no_notes.csv' WITH (FORMAT csv, HEADER true, NULL '')

\copy route_stops (route_id, stop_id, sequence_no) FROM 'C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/route_stops_clean.csv' WITH (FORMAT csv, HEADER true, NULL '')

\copy route_operators (route_id, operator_id, is_primary) FROM 'C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/route_operators_clean.csv' WITH (FORMAT csv, HEADER true, NULL '')

\copy route_return_leg_priority (route_id, route_name, vehicle_type, operator, total_stops, approx_distance_km, status) FROM 'C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/return_leg_verification_priority_clean.csv' WITH (FORMAT csv, HEADER true, NULL '')

-- ----------------------------------------------------------------------------
-- Sanity checks — every count should be 0
-- ----------------------------------------------------------------------------
SELECT 'route_stops -> stops orphan'    AS check, count(*) FROM route_stops rs LEFT JOIN stops s ON rs.stop_id = s.stop_id WHERE s.stop_id IS NULL
UNION ALL
SELECT 'route_stops -> routes orphan',  count(*) FROM route_stops rs LEFT JOIN routes r ON rs.route_id = r.route_id WHERE r.route_id IS NULL
UNION ALL
SELECT 'route_operators -> operators orphan', count(*) FROM route_operators ro LEFT JOIN operators o ON ro.operator_id = o.operator_id WHERE o.operator_id IS NULL
UNION ALL
SELECT 'routes.total_stops mismatch',   count(*) FROM routes r
  LEFT JOIN (SELECT route_id, count(*) c FROM route_stops GROUP BY route_id) rs ON rs.route_id = r.route_id
  WHERE r.total_stops IS DISTINCT FROM rs.c
UNION ALL
SELECT 'stops missing geom',            count(*) FROM stops WHERE geom IS NULL;

-- fare_rules
\copy fare_rules (fare_id, min_distance_km, max_distance_km, fare_npr_min, fare_npr_max, student_discount_pct, verification_note) FROM 'C:/Users/dines/Desktop/ktm bus route finder/minor-project-BE/data/processed/fare_rules_clean.csv' WITH (FORMAT csv, HEADER true, NULL '')
