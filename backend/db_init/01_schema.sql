-- ============================================================================
-- Kathmandu Bus Route Finder — production schema (PostgreSQL + PostGIS)
-- Generated from operators_clean.csv, stops_clean.csv, routes_clean.csv,
-- route_stops_clean.csv, route_operators_clean.csv, fare_rules_clean.csv
-- (return_leg_verification_priority_clean.csv is loaded as an auxiliary QA table)
--
-- Tested end-to-end on:
--   PostgreSQL 16.14  (16.14-0ubuntu0.24.04.1)
--   PostGIS     3.4.2  (3.4.2+dfsg-1ubuntu3)
--   GEOS        3.12.1 (bundled with the above PostGIS build)
--   PROJ        9.4.0  (9.4.0-1build2)
-- All four ship together as-is from the Ubuntu 24.04 LTS (noble) apt repos
-- (postgresql-16 + postgresql-16-postgis-3), so no manual pinning is needed
-- on a stock Ubuntu 24.04 host. Requires PostgreSQL 13+ generally; the
-- fare_rules EXCLUDE constraint below needs the native range GiST opclass,
-- available in every currently-supported PostgreSQL version.
--
-- Run this before import.sql. Requires the postgis extension available on
-- the server (`CREATE EXTENSION` requires postgis to be installed).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ----------------------------------------------------------------------------
-- operators
-- ----------------------------------------------------------------------------
CREATE TABLE operators (
    operator_id         TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    service_type        TEXT,
    contact_number      TEXT,
    rating              NUMERIC(2,1) CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
    unverified_fields   TEXT[]                          -- fields whose values are unverified/estimated
);

-- ----------------------------------------------------------------------------
-- stops
-- ----------------------------------------------------------------------------
CREATE TABLE stops (
    stop_id             TEXT PRIMARY KEY,
    stop_name           TEXT NOT NULL,
    aliases             TEXT,
    lat                 DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng                 DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
    geom                GEOGRAPHY(Point, 4326) NOT NULL,  -- auto-populated from lat/lng by trigger below
    zone                TEXT,
    district             TEXT,
    ward                INTEGER,
    is_major_stop       BOOLEAN NOT NULL DEFAULT FALSE,
    landmark            TEXT,
    has_shelter         BOOLEAN NOT NULL DEFAULT FALSE,
    has_ticket_counter  BOOLEAN NOT NULL DEFAULT FALSE,
    is_interchange      BOOLEAN NOT NULL DEFAULT FALSE,
    wheelchair_access   BOOLEAN NOT NULL DEFAULT FALSE,
    audio_support       BOOLEAN NOT NULL DEFAULT FALSE,
    status              TEXT NOT NULL DEFAULT 'active',
    unverified_fields   TEXT[],
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    geo_out_of_bounds   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_stops_geom       ON stops USING GIST (geom);
CREATE INDEX idx_stops_district   ON stops (district);
CREATE INDEX idx_stops_status     ON stops (status);

-- geom is always derived from lat/lng, on every insert and every lat/lng update
-- (fires during \copy too, so the plain lat/lng CSV import populates it automatically)
CREATE OR REPLACE FUNCTION stops_set_geom() RETURNS trigger AS $$
BEGIN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stops_set_geom
    BEFORE INSERT OR UPDATE OF lat, lng ON stops
    FOR EACH ROW EXECUTE FUNCTION stops_set_geom();

-- ----------------------------------------------------------------------------
-- routes
-- ----------------------------------------------------------------------------
CREATE TABLE routes (
    route_id                          TEXT PRIMARY KEY,
    route_name                        TEXT NOT NULL,
    short_name                        TEXT,
    vehicle_type                      TEXT NOT NULL,
    route_type                        TEXT,
    operator                          TEXT,               -- free-text operator name as originally recorded
    operator_id                       TEXT REFERENCES operators(operator_id) ON DELETE SET NULL,
    operator_id_raw                   TEXT,                -- raw/staging value (may list multiple ids "A;B")
    -- Draft routes have no sequence yet; these are populated when stops are added.
    start_stop_id                     TEXT REFERENCES stops(stop_id) ON DELETE RESTRICT,
    end_stop_id                       TEXT REFERENCES stops(stop_id) ON DELETE RESTRICT,
    total_stops                       INTEGER NOT NULL CHECK (total_stops >= 0),
    approx_distance_km                NUMERIC(6,2),
    approx_distance_km_original       NUMERIC(6,2),
    haversine_distance_km             NUMERIC(6,3),
    max_consecutive_stop_jump_km      NUMERIC(6,3),
    distance_flagged_for_recompute    BOOLEAN NOT NULL DEFAULT FALSE,
    estimated_duration_min            NUMERIC(6,1),
    service_start_time                TIME,
    service_end_time                  TIME,
    frequency_min                     INTEGER,
    fare_type                         TEXT,
    has_ac                            BOOLEAN NOT NULL DEFAULT FALSE,
    is_express                        BOOLEAN NOT NULL DEFAULT FALSE,
    is_multi_operator                 BOOLEAN NOT NULL DEFAULT FALSE,
    is_bidirectional                  BOOLEAN NOT NULL DEFAULT FALSE,
    status                            TEXT NOT NULL DEFAULT 'active',
    status_original                   TEXT,
    status_corrected_for_return_leg   BOOLEAN NOT NULL DEFAULT FALSE,
    return_leg_verified                BOOLEAN NOT NULL DEFAULT FALSE,
    notes                              TEXT,
    created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_routes_operator_id  ON routes (operator_id);
CREATE INDEX idx_routes_status       ON routes (status);
CREATE INDEX idx_routes_vehicle_type ON routes (vehicle_type);
CREATE INDEX idx_routes_start_stop   ON routes (start_stop_id);
CREATE INDEX idx_routes_end_stop     ON routes (end_stop_id);

-- ----------------------------------------------------------------------------
-- route_stops (ordered route <-> stop mapping)
-- PK is (route_id, sequence_no): sequence_no is always unique within a route,
-- while the same stop_id can legitimately recur within one route (loop /
-- bidirectional routes revisiting a junction) — see import.sql notes.
-- ----------------------------------------------------------------------------
CREATE TABLE route_stops (
    route_id     TEXT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
    stop_id      TEXT NOT NULL REFERENCES stops(stop_id) ON DELETE RESTRICT,
    sequence_no  INTEGER NOT NULL CHECK (sequence_no > 0),
    PRIMARY KEY (route_id, sequence_no)
);

CREATE INDEX idx_route_stops_stop_id ON route_stops (stop_id);
CREATE INDEX idx_route_stops_route_id ON route_stops (route_id);

-- ----------------------------------------------------------------------------
-- route_operators (many-to-many: a route can have multiple operators)
-- ----------------------------------------------------------------------------
CREATE TABLE route_operators (
    route_id     TEXT NOT NULL REFERENCES routes(route_id) ON DELETE CASCADE,
    operator_id  TEXT NOT NULL REFERENCES operators(operator_id) ON DELETE RESTRICT,
    is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (route_id, operator_id)
);

CREATE INDEX idx_route_operators_operator_id ON route_operators (operator_id);

-- Only one primary operator per route
CREATE UNIQUE INDEX uq_route_operators_primary
    ON route_operators (route_id)
    WHERE is_primary;

-- ----------------------------------------------------------------------------
-- route_return_leg_priority — auxiliary QA/tracking table, not a relational
-- entity in its own right (all columns duplicate routes.* for the routes
-- flagged for return-leg verification). Kept 1:1 with routes.route_id.
-- ----------------------------------------------------------------------------
CREATE TABLE route_return_leg_priority (
    route_id             TEXT PRIMARY KEY REFERENCES routes(route_id) ON DELETE CASCADE,
    route_name           TEXT,
    vehicle_type         TEXT,
    operator              TEXT,
    total_stops           INTEGER,
    approx_distance_km    NUMERIC(6,2),
    status                TEXT
);

-- ----------------------------------------------------------------------------
-- fare_rules — distance-banded fare lookup, independent of routes/stops.
-- A route's fare is found by matching its approx_distance_km into whichever
-- band contains it: min_distance_km <= distance < max_distance_km (the upper
-- bound is EXCLUSIVE — source data recorded it as e.g. "<5", "<10").
-- distance_range/the EXCLUDE constraint guarantee the bands can never overlap
-- or duplicate at load time (native numrange GiST opclass — no extension
-- beyond core PostgreSQL needed).
-- ----------------------------------------------------------------------------
CREATE TABLE fare_rules (
    fare_id                TEXT PRIMARY KEY,
    min_distance_km        NUMERIC(6,2) NOT NULL CHECK (min_distance_km >= 0),
    max_distance_km        NUMERIC(6,2) NOT NULL CHECK (max_distance_km > min_distance_km),
    fare_npr_min            NUMERIC(7,2) NOT NULL CHECK (fare_npr_min >= 0),
    fare_npr_max            NUMERIC(7,2) NOT NULL CHECK (fare_npr_max >= fare_npr_min),
    student_discount_pct    NUMERIC(5,2) CHECK (student_discount_pct IS NULL OR (student_discount_pct BETWEEN 0 AND 100)),
    verification_note       TEXT,
    distance_range           NUMRANGE GENERATED ALWAYS AS (
                                  numrange(min_distance_km, max_distance_km, '[)')
                              ) STORED,
    EXCLUDE USING gist (distance_range WITH &&)
);

CREATE INDEX idx_fare_rules_distance_range ON fare_rules USING GIST (distance_range);