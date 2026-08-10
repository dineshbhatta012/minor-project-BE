# Dropping this into `kathmandu-bus-route-finder/frontend/`

This is now wired to the **real** backend (see the backend scaffold's
SETUP.md) — not the mock. `lib/mockRoute.ts` is no longer used by
`page.tsx`; keep it around only if you want an offline fallback for
frontend-only work when the backend isn't running.

## Setup

1. Copy every file in this folder into your repo's `frontend/` directory.
2. Install dependencies:
   ```
   cd frontend
   npm install
   ```
3. Point the frontend at your backend:
   ```
   cp .env.local.example .env.local
   ```
   (defaults to `http://localhost:8000` — change it if your backend runs
   somewhere else)
4. Make sure the backend is running first (see its own SETUP.md — `docker
   compose up -d db`, load the data, `uvicorn app.main:app --reload`).
5. Run the frontend:
   ```
   npm run dev
   ```
   Visit http://localhost:3000. The search form's autocomplete now pulls
   from your real 300 stops via `GET /stops`. Searching calls the real
   `POST /route/search` and renders the actual graph result, with OSRM
   filling in road-following polylines.

## What's real vs. still client-side only

- **Real**: stop list, route search, transfer/distance data — all from
  your FastAPI backend and your actual dataset.
- **Still client-side**: the road-following polyline shape. The backend
  intentionally returns straight stop-to-stop lines (see the comment in
  `backend/app/schemas.py`) so the API's response time isn't coupled to
  OSRM's public demo server, which is rate-limited. `lib/osrm.ts` fills
  this in after the fact. Before deploying, self-host OSRM and update
  `OSRM_BASE_URL` there.

## Files

- `types/route.ts` — mirrors `backend/app/schemas.py` field-for-field.
  If you change one, change both.
- `lib/api.ts` — `fetchStops()` and `searchRoute()`, the only two calls to
  your backend.
- `lib/osrm.ts` — road-geometry enrichment, unchanged from before.
- `lib/mockRoute.ts` — unused now; kept only as an offline fallback.
