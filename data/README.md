# Data
(schema, ingestion, cleaning, spatial queries, data access layer)

```
data/
├── raw/          Original exports
│                   - 2013 Yatayat OSM export
│                   - Overpass Turbo pulls
│                   - DOTM records
│
├── processed/    Cleaned, validated CSVs ready for DB import
│                   (see processed/README.md)
│
└── scripts/      Data-cleaning and validation pipeline
                    - clean_data.py    — raw/ → processed/
                    - validate_clean.py — post-cleaning integrity checks
                    - test_clean_data.py — unit tests
                    - requirements.txt
```

## Pipeline order

1. **`scripts/clean_data.py`** — `raw/` → `processed/`
   Turns raw exports into validated CSVs and regenerates
   `processed/report.md` documenting exactly what changed:
     1. Removes `route_stops` rows referencing a `stop_id` with no matching
        row in `stops`
     2. Re-sequences `route_stops.sequence_no` per route after removals
        (1..N)
     3. Recomputes `routes.start_stop_id` / `end_stop_id` / `total_stops`
        from `route_stops`
     4. Nulls out `routes.operator_id` where it has no match in `operators`
        and isn't recoverable from `operator_id_raw` or `route_operators`
     5. Flags distance outliers (haversine vs. recorded
        `approx_distance_km`)
     6. Verifies `route_operators`/`operators` have no orphan pairs
     7. Runs the same post-cleanup integrity checks `import.sql` runs in
        Postgres

```bash
   python scripts/clean_data.py \
       --raw-dir data/raw \
       --out-dir data/processed \
       --config scripts/config.yaml   # optional
```

2. **`scripts/validate_clean.py`** — integrity checks on `processed/*.csv`,
   no database required. Runs the same checks as the sanity-check block at
   the bottom of `import.sql`, so problems can be caught in CI before ever
   touching Postgres.

```bash
   python scripts/validate_clean.py --dir data/processed
   # exits 1 and prints failures if any check is non-zero
```

3. **`schema.sql`** — builds the full schema (7 tables: `operators`,
   `stops`, `routes`, `route_stops`, `route_operators`,
   `route_return_leg_priority`, `fare_rules`) against a PostgreSQL 16.14 +
   PostGIS 3.4.2 instance. Applied via Alembic migration
   `0002_replace_with_full_schema` in the backend's migration chain, so the
   live app DB and this file stay in sync going forward.

4. **`import.sql`** — loads all `processed/*_clean.csv` files directly via
   `\copy` into the schema from step 3, in dependency order (operators →
   stops → routes → route_stops → route_operators →
   route_return_leg_priority → fare_rules), followed by a built-in
   referential-integrity sanity check — all currently passing clean.

   > **Before running:** paths inside `import.sql` are placeholders
   > (`/path/to/csv/`). Replace with your local absolute path to
   > `processed/` first.

---

## Current dataset status

| Table              | Row count |
|--------------------|-----------|
| `routes`           | 88        |
| `stops`             | 302       |
| `operators`         | 29        |
| `route_stops`       | 1,662     |
| `route_operators`   | 86        |
| `fare_rules`        | 5         |

All of the above are confirmed loaded successfully into a live
PostgreSQL 16.14 + PostGIS 3.4.2 instance via `import.sql`.

**Referential-integrity audit** — passed clean end-to-end:
  - `route_stops → stops` orphan check: **0**
  - `route_stops → routes` orphan check: **0**
  - `route_operators → operators` orphan check: **0**
  - `routes.total_stops` vs. actual `route_stops` count: **0 mismatches**
  - `stops` rows missing `geom`: **0**

  See `processed/README.md` and `report_v4.md` for the full audit trail.

**Fare rules** — 5 distance bands, confirmed non-overlapping (enforced by
the `EXCLUDE USING gist` constraint) and correctly computed as
`[min_distance_km, max_distance_km)`.
  > Note: all 5 rows are currently `desk_estimate_2026-08` — scaled from a
  > prior Bagmati Province rate, pending confirmation against the official
  > gazette notice. **Not yet field-verified.**

**Field verification status** — not re-assessed this round.
  <!-- TODO: replace with current Tier 1/2/3 breakdown -->
  Note: `return_leg_verification_priority_clean.csv` still flags **86 of
  87 routes** as pending return-leg verification, so most of the dataset
  likely isn't field-verified yet even though it's now referentially clean.

**Unresolved operator matches** — none currently. All routes have a
resolved `operator_id` as of the latest cleaned dataset.

