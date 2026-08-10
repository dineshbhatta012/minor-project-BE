# Dropping this into `kathmandu-bus-route-finder/backend/`

This was built directly against your real dataset (300 stops, 87 active
routes, 1590 route-stop links) — not a mock. Logic was verified against
both a small hardcoded test graph and a real slice of your data before
being handed to you (see "What was actually tested" at the bottom).

## 1. Copy files into place

Copy everything in this folder into your repo's `backend/` directory. Copy
`docker-compose.yml` to your **repo root** — if one already exists there,
merge the `db` service in rather than overwriting (yours may already define
one; this file matches exactly what `data/schema.sql` was tested against:
PostgreSQL 16 + PostGIS 3.4).

Your repo root should end up looking like:
```
kathmandu-bus-route-finder/
├── backend/         <- everything from this scaffold
├── data/            <- your existing data/ folder, unchanged
├── frontend/         <- the frontend scaffold from earlier
├── docker-compose.yml
```

## 2. Start the database

```bash
docker compose up -d db
docker ps   # should show ktm_bus_db running and healthy
```

The schema (`backend/db_init/01_schema.sql`, a copy of your `data/schema.sql`)
applies automatically the first time the container starts. If you ever need
to re-apply it from scratch: `docker compose down -v` (this wipes the data
volume) then `docker compose up -d db` again.

## 3. Set up the Python environment

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

## 4. Load your real dataset

```bash
python scripts/load_data.py
```

This streams your CSVs into Postgres using the `COPY` protocol (not `\copy`
— no file-path headaches between your host and the Docker container) and
runs the same sanity checks as `data/import.sql`. Expect output like:
```
  loaded operators from operators_clean.csv (28 rows)
  loaded stops from stops_clean.csv (300 rows)
  loaded routes from routes_clean.csv (87 rows)
  loaded route_stops from route_stops_clean.csv (1589 rows)
  loaded route_operators from route_operators_clean.csv (85 rows)
  loaded route_return_leg_priority from return_leg_verification_priority_clean.csv (86 rows)
  loaded fare_rules from fare_rules_clean.csv (5 rows)

Sanity checks (every count should be 0):
  [OK] route_stops -> stops orphan: 0
  [OK] route_stops -> routes orphan: 0
  [OK] route_operators -> operators orphan: 0
  [OK] routes.total_stops mismatch: 0
  [OK] stops missing geom: 0

All tables loaded and committed successfully.
```
If any check fails, nothing is committed — safe to fix and re-run.

## 5. Run the API

```bash
uvicorn app.main:app --reload --port 8000
```

Check it's alive:
- http://localhost:8000/health → `{"status": "ok"}`
- http://localhost:8000/docs → interactive API docs, every real endpoint
  and schema
- http://localhost:8000/admin/graph-stats → should show ~300 stop nodes,
  ~1590 route nodes, ~71 active routes (a few of your 87 routes are
  `pending_release`/etc. and correctly excluded)

## 6. Connect the frontend

In `frontend/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

The frontend scaffold from earlier already has the mock/real split built
in — see its own `SETUP.md` for the exact lines to change in `page.tsx`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness check |
| GET | `/stops` | all active stops — frontend uses this for autocomplete |
| GET | `/stops/nearest?lat=&lng=` | nearest stops to a point (PostGIS) |
| GET | `/routes` | all active routes, summary |
| GET | `/routes/{route_id}` | one route with its full ordered stop list |
| POST | `/route/search` | `{origin_stop_id, destination_stop_id}` → route result |
| POST | `/admin/refresh-graph` | rebuild the in-memory routing graph after data changes |
| GET | `/admin/graph-stats` | node/edge counts, sanity check the graph built correctly |

## How routing actually works

Not a plain stop-to-stop graph — see the long comment at the top of
`app/routing/graph_builder.py` for the full model. Short version: each
route gets its own copy of every stop it visits, connected in sequence with
real travel-distance weights. Switching from one route's copy of a stop to
another route's copy costs a configurable penalty
(`TRANSFER_PENALTY_KM` in `.env`). One Dijkstra run per search naturally
finds the best combination of direct rides and transfers, without needing
separate code paths for each case.

## What was actually tested (and one real finding)

Before handing this to you, the pathfinding logic was run against:
1. A small 7-stop hardcoded graph (matching the 5 test cases from the
   original plan: known shortest path, known transfer, no-route case,
   identical origin/destination, and the BFS direct-route check) — all
   passed. These are now `tests/test_routing.py`; run with `pytest` once
   your venv is set up.
2. Your **actual** 300-stop dataset, directly.

That second test caught something real: with a low transfer penalty
(1.2 "km"), Dijkstra chose a 4-transfer path over a plain single-route ride
between two stops on the same route, because Kathmandu's route network
overlaps enough that hopping between routes can shave a little real
distance even after a small penalty. The default is now `5.0`, which fixed
that specific case — but this is a judgment call about your city's network,
not something I can fully verify without you trying real origin/destination
pairs. If you see multi-transfer results where a direct route obviously
exists, check the `uvicorn` logs — `/route/search` logs a warning exactly
when this happens, and the fix is raising `TRANSFER_PENALTY_KM`.

## What's still a judgment call, not verified

- **Edge weights are real-world distance only** — not accounting for
  `estimated_duration_min`, traffic, or wait time between buses. If two
  routes cover the same distance but one is much slower (worse
  `frequency_min`), the current model doesn't know that.
- **CORS** is set to allow only `http://localhost:3000` — update
  `CORS_ORIGINS` in `.env` when you deploy the frontend somewhere else.
- **`/admin/*` is unauthenticated** — fine for local dev, not for anything
  publicly reachable.
