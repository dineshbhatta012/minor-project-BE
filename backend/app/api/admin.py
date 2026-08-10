from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.routing.graph_builder import get_cached_graph, refresh_graph
from app.schemas import GraphStatsOut

router = APIRouter(prefix="/admin", tags=["admin"])

# NOTE: unauthenticated on purpose for local dev. Before deploying anywhere
# reachable outside your own machine, put this behind the same auth as the
# rest of an admin surface — rebuilding the graph is cheap, but it's still
# a DB-hitting endpoint you don't want open to the internet.


@router.post("/refresh-graph", response_model=GraphStatsOut)
def refresh(db: Session = Depends(get_db)):
    """Call this after loading new/updated data into Postgres — the graph
    is cached in memory and won't pick up DB changes on its own."""
    graph_data = refresh_graph(db)
    return _stats(graph_data)


@router.get("/graph-stats", response_model=GraphStatsOut)
def stats(db: Session = Depends(get_db)):
    graph_data = get_cached_graph(db)
    return _stats(graph_data)


def _stats(graph_data) -> GraphStatsOut:
    g = graph_data.graph
    stop_nodes = sum(1 for n in g.nodes if n.startswith("S:"))
    route_nodes = sum(1 for n in g.nodes if n.startswith("R:"))
    return GraphStatsOut(
        stop_nodes=stop_nodes,
        route_nodes=route_nodes,
        edges=g.number_of_edges(),
        active_routes=len(graph_data.route_sequences),
    )
