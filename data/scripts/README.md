# scripts/

Cleaning and validation pipeline for the Kathmandu Bus Route Finder dataset.
Turns `data/raw/*.csv` into `data/processed/*_clean.csv` + `processed/report.md`,
and can validate the result without needing a live Postgres instance.

## Setup

```bash
pip install -r scripts/requirements.txt
```

## Run the cleaning pipeline

```bash
python scripts/clean_data.py --raw-dir data/raw --out-dir data/processed
```

This will:
1. Remove `route_stops` rows referencing a `stop_id` that has no row in `stops`
2. Re-sequence `sequence_no` per route (1..N, gaps closed) after removals
3. Recompute `routes.start_stop_id` / `end_stop_id` / `total_stops` from the
   cleaned `route_stops`
4. Resolve or null out `routes.operator_id` values that don't match any row
   in `operators` — tries `operator_id_raw`, then `route_operators`, before
   giving up and setting `NULL`
5. Flag routes whose recorded distance looks implausible against a haversine
   (straight-line) estimate computed from stop coordinates
6. Regenerate `processed/report.md` documenting every change, in the same
   format as the original manual audit
7. Run the same referential-integrity checks `import.sql`'s sanity-check
   block runs in Postgres — printed to the console as it goes

Add `--fail-on-verify-error` to exit non-zero if any check fails (used in CI).

## Validate an already-cleaned dataset

If you just want to check `data/processed/` is internally consistent —
no cleaning, no database required:

```bash
python scripts/validate_clean.py --dir data/processed
```

## Run the tests

```bash
pip install pytest
pytest scripts/test_clean_data.py -v
```

These pin the exact behaviors documented in `report.md` (orphan removal,
resequencing, operator_id resolution, total_stops recomputation) against
small fixtures, so a future change to the pipeline can't silently break
them without a test failing.

## CI

`ci_data_pipeline.yml` (move to `.github/workflows/` to activate) runs the
tests, re-runs the full pipeline against `data/raw`, validates the committed
`data/processed` output, and warns if a fresh run would produce different
output than what's currently committed — a signal that `data/raw` changed
but `data/processed` wasn't regenerated to match.

## Known caveats / things to verify against your real data

- **Raw filename mapping**: `clean_data.py`'s `RAW_FILENAMES` dict currently
  points at the v2-named files (`stops_production_v2.csv`,
  `routes_production_v2_fixed.csv`, etc.). The original `report.md` refers to
  v3-named files. If your actual raw filenames differ, edit `RAW_FILENAMES`
  at the top of `clean_data.py` — don't guess, just match what's in
  `data/raw/`.
- **`geo_out_of_bounds` bounding box** (`VALLEY_BBOX` in `clean_data.py`) is
  a rough Kathmandu Valley box, not sourced from your original cleaning
  logic (which wasn't available to reconstruct from). Verify it against
  what the original v3 cleaning actually used, or your real stop
  coordinates, and adjust.
- **`unverified_fields` inference** (which optional stop fields count as
  "unverified") is a best-effort reconstruction from the clean CSVs'
  existing values, not a documented rule from the original run. Check a
  sample of `stops_clean.csv` against what this script would produce and
  adjust the `optional_fields` list in `clean_stops()` if it doesn't match.
- **Distance-flagging threshold** (`recorded < haversine * 0.9` in
  `clean_routes()`) is a reasonable heuristic, not a value taken from the
  original report — tune it if it flags too many/few routes on your real
  data.

Run the pipeline against your real `data/raw`, diff the output against the
currently-committed `data/processed`, and adjust the three items above until
they match (or intentionally differ, if you're improving on the original
logic).
