# Kathmandu Bus Route Finder

An interactive transit route planning application for the Kathmandu Valley. This system finds direct or single-transfer routes between ~300 bus stops using a custom Dijkstra algorithm implemented in a FastAPI backend with a PostGIS database, visualised on a Next.js/Leaflet map.

---

## Prerequisites

Ensure you have the following installed on your system:
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running, with WSL 2 integration if on Windows)
- [Python 3.10+](https://www.python.org/downloads/)
- [Node.js 18+](https://nodejs.org/)

---

##  Setup & Execution

### 1. Database Setup (Docker)

Spin up the PostGIS database container from the repository root:
```bash
docker compose up -d db
```
*Note: The schema is automatically applied on the first run. To wipe and recreate the database, run `docker compose down -v`.*

### 2. Backend Setup (FastAPI)

Navigate to the `backend` folder and configure Python:

```bash
cd backend

# Create and activate virtual environment
python -m venv venv
# On Windows:
venv\Scripts\activate
# On macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create environment configuration
cp .env.example .env

# Load cleaner CSV stop/route datasets into database
python scripts/load_data.py

# Run the API server


```
- **Interactive Docs:** [http://localhost:8000/docs](http://localhost:8000/docs)
- **Health Check:** [http://localhost:8000/health](http://localhost:8000/health)

### 3. Frontend Setup (Next.js)

Navigate to the `frontend` folder and configure React:

```bash
cd ../frontend

# Install packages
npm install

# Create environment configuration
cp .env.local.example .env.local

# Run the development server
npm run dev
```
- **Web App URL:** [http://localhost:3000](http://localhost:3000)

---

##  Features

- **Map Selection:** Select origin/destination bus stops directly by clicking markers on the interactive Leaflet map ("Set as From" / "Set as To").
- **Smart Pathfinding:** Uses an in-memory Dijkstra graph model with configurable transfer penalties to discourage excessive bus transfers.
- **Road-Following Polyline:** Real-road geometry fetched dynamically from OSRM to render accurate routes rather than straight lines.
