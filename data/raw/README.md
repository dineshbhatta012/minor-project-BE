# Raw Data Sources

This folder holds the unprocessed inputs to the cleaning pipeline documented in
`../processed/report.md`. Each file below is paired with where it came from.

## 1. OSM / Overpass Turbo exports
**Source:** [Overpass Turbo](https://overpass-turbo.eu/) queries against OpenStreetMap,
filtered to `bus`, `microbus`, and `tempo` route/stop tags for the Kathmandu Valley.
**Method:** manual Overpass QL query, exported as CSV/GeoJSON then converted.
**Files:**
- `stops_production_v2.csv` — stop locations, names, tags
- `route_stops_production_v2.csv` — stop sequences per route
- `routes_production_v2_fixed.csv` — route geometries/metadata

## 2. 2013 Yatayat (neogeomat.github.io/yatayat)
**Source:** [Kathmandu Public Transport](https://neogeomat.github.io/yatayat/) —
a community mapping project by Kathmandu University Geomatics and the Monsoon
Collective, built on OSM data with a Leaflet routing UI and fare reference page.
**Method:** exported/scraped route and fare listings from the site.
**Files:**
- Cross-referenced against `routes_production_v2_fixed.csv` and
  `route_stops_production_v2.csv` for route naming and continuity
- Contributed to `return_leg_verification_priority_production_fixed.csv`
  (routes flagged for manual return-leg verification)

## 3. DOTM (Department of Transport Management) records
**Source:** Nepal DOTM operator/route registration records.
**Method:** manual transcription / public dataset 
**Files:**
- `operators.csv` — registered transport operator/company details
- `route_operators_production.csv` — operator-to-route assignments


## Notes
- Files above are the pre-cleaning originals. See `../processed/report.md` for
  the orphan-pair audit and cleanup applied to produce `../processed/*_clean.csv`.
- Collection dates and exact Overpass QL queries are not yet recorded — add them
  here if you still have them, since OSM data changes over time and future
  reproducibility depends on knowing the export date.
