# Kathmandu Bus Route Finder — Database (processed, v4)

Cleaned, orphan-audited CSVs plus a PostgreSQL + PostGIS schema and import
script for the Kathmandu Bus Route Finder project. This is the *processed*
dataset — raw/unverified sources and the full audit trail live in
`report.md` (v3) and `report_v4.md` (this round).

## Requirements

Tested live against this exact stack (stock Ubuntu 24.04 LTS apt packages —
no manual version pinning needed):

| Component  | Version |
|---|---|
| PostgreSQL | 16.14 |
| PostGIS    | 3.4.2 |
| GEOS       | 3.12.1 |
| PROJ       | 9.4.0 |

```bash
sudo apt install postgresql-16 postgresql-16-postgis-3
```

## Files

| File | Contents |
|---|---|
| `schema.sql` | Table definitions, indexes, triggers, constraints. Run first. |
| `import.sql` | `\copy` statements for all 7 CSVs + sanity checks. Run second. |
| `operators_clean.csv` | 29 rows — bus/microbus/tempo operators |
| `stops_clean.csv` | 302 rows — physical stops (lat/lng, amenities) |
| `routes_clean.csv` | 88 rows — routes (distance, timing, operator link) |
| `route_stops_clean.csv` | 1662 rows — ordered route ↔ stop mapping |
| `route_operators_clean.csv` | 86 rows — route ↔ operator (M:N, one primary each) |
| `return_leg_verification_priority_clean.csv` | 87 rows — auxiliary QA table |
| `fare_rules_clean.csv` | 5 rows — distance-banded fare lookup |
| `report.md` / `report_v4.md` | Full audit trail — read these before trusting a number |

## Setup

```bash
createdb ktm_bus
psql -d ktm_bus -f schema.sql

# Edit import.sql first: replace /path/to/csv/ with the absolute path to
# this folder (the CSVs listed above), then:
psql -d ktm_bus -f import.sql
```

The last query in `import.sql` is a sanity-check block — every row should
read `0` except `fare_rules row count`, which should read `5`.

## Schema overview

- **operators** — carrier registry (`operator_id` PK)
- **stops** — physical stops; `geom` (PostGIS `geography`) is auto-derived
  from `lat`/`lng` by a trigger, never set directly
- **routes** — one row per route; `operator_id` is the primary carrier,
  `total_stops`/`start_stop_id`/`end_stop_id` are kept in sync with
  `route_stops` (enforced by the sanity checks, not a DB constraint)
- **route_stops** — ordered stop sequence per route; the same `stop_id` can
  legitimately repeat within one route (loop/bidirectional routes)
- **route_operators** — M:N join; exactly one `is_primary = true` row per
  route (enforced by a partial unique index)
- **route_return_leg_priority** — QA tracking table, 1:1 with `routes`
- **fare_rules** — distance → fare lookup. `min_distance_km` is inclusive,
  `max_distance_km` is **exclusive** (a route at exactly 5.00 km falls into
  the `[5,10)` band, not `[0,5)`). An `EXCLUDE` constraint makes overlapping
  bands physically impossible to insert.

## Known data caveats (see `report_v4.md` for full detail)

- **2 routes** (`R3102124`, `R3028077`) had corrupted/invalid `is_express`
  values in the source export. `is_express` for both was unrecoverable and
  defaults to `False`. (No unresolved `operator_id` nulls remain as of the
  latest cleaned dataset.)
- **`fare_rules.verification_note`** flags the fare figures as a
  2026-08 desk estimate, pending confirmation against the official Bagmati
  Province gazette notice — not yet independently verified.
