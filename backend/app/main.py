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
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
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
