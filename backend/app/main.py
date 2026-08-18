import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import admin, routes, routing, stops
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.routing import graph_builder

logger = logging.getLogger("uvicorn.error")
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    db = SessionLocal()
    try:
        graph_data = graph_builder.get_cached_graph(db)
        graph = graph_data.graph
        logger.info(
            "Routing graph built: %d stops, %d route-nodes, %d edges, %d active routes",
            sum(1 for n in graph.nodes if n.startswith("S:")),
            sum(1 for n in graph.nodes if n.startswith("R:")),
            graph.number_of_edges(),
            len(graph_data.route_sequences),
        )
    except Exception:
        logger.exception("Failed to build routing graph at startup")
    finally:
        db.close()

    yield


app = FastAPI(
    title="Kathmandu Bus Route Finder API",
    description="Origin-destination bus route search for the Kathmandu Valley.",
    version="0.1.0",
    lifespan=lifespan,
)

# Frontend runs on a different origin (localhost:3000) than this API
# (localhost:8000) during dev, so without this every fetch from the browser
# is blocked regardless of whether the backend itself is working correctly.
# Normalize cors origins read from env: allow JSON list, plain string, or
# comma-separated values.
import json

cors_origins = settings.cors_origins
if isinstance(cors_origins, str):
    try:
        parsed = json.loads(cors_origins)
        if isinstance(parsed, str):
            cors_origins = [parsed]
        elif isinstance(parsed, list):
            cors_origins = parsed
        else:
            cors_origins = [str(parsed)]
    except Exception:
        # Fallback: split comma-separated values
        cors_origins = [o.strip() for o in cors_origins.split(",") if o.strip()]

if not isinstance(cors_origins, (list, tuple)):
    cors_origins = [cors_origins]

# Ensure common dev origins are allowed so the Next dev server can talk to the API
_dev_allowed = [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
]
for o in _dev_allowed:
    if o not in cors_origins:
        cors_origins.append(o)

logger.info("CORS allowed origins: %s", cors_origins)

# For local development make CORS permissive to avoid opaque failures in the
# browser. In production set a specific list via CORS_ORIGINS env.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health_check():
    return {"status": "ok"}


app.include_router(stops.router)
app.include_router(routes.router)
app.include_router(routing.router)
app.include_router(admin.router)
