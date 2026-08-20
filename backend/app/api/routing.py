import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.routing.graph_builder import get_cached_graph
from app.routing.pathfinding import find_direct_route_bfs, find_route_dijkstra, path_to_legs
from app.schemas import RouteLegOut, RouteSearchRequest, RouteSearchResult, StopOut

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/route", tags=["routing"])


@router.post("/search", response_model=RouteSearchResult)
def search_route(payload: RouteSearchRequest, db: Session = Depends(get_db)):
    graph_data = get_cached_graph(db)
    origin_id = payload.origin_stop_id
    dest_id = payload.destination_stop_id

    if origin_id == dest_id:
        return RouteSearchResult(found=False, transfer_count=0, legs=[])

    path = find_route_dijkstra(graph_data, origin_id, dest_id)

    if path is None:
        return RouteSearchResult(found=False, transfer_count=0, legs=[])

    legs_raw, total_km = path_to_legs(graph_data, path)

    # Sanity check, not a gate: if a direct route exists in the raw data but
    # Dijkstra's result used a transfer anyway, the transfer penalty or
    # weighting is probably off — log it rather than silently serving a
    # worse-than-optimal route.
    if len(legs_raw) > 1:
        direct = find_direct_route_bfs(graph_data, origin_id, dest_id)
        if direct is not None:
            logger.warning(
                "Dijkstra returned %d transfers for %s->%s but a direct route (%s) exists — check transfer_penalty_km",
                len(legs_raw) - 1,
                origin_id,
                dest_id,
                direct,
            )

    legs_out = [
        RouteLegOut(
            route_id=leg["route_id"],
            route_name=leg["route_name"],
            operator=leg.get("operator") or None,
            from_stop=StopOut(**graph_data.stops_by_id[leg["from_stop_id"]]),
            to_stop=StopOut(**graph_data.stops_by_id[leg["to_stop_id"]]),
            path=[
                (graph_data.stops_by_id[sid]["lat"], graph_data.stops_by_id[sid]["lng"])
                for sid in leg["stop_ids"]
            ],
        )
        for leg in legs_raw
    ]

    return RouteSearchResult(
        found=True,
        transfer_count=len(legs_out) - 1,
        total_distance_km=total_km,
        legs=legs_out,
    )
