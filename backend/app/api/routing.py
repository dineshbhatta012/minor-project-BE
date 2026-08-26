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

    target_origin_id = origin_id
    target_dest_id = dest_id
    
    direct = find_direct_route_bfs(graph_data, origin_id, dest_id)
    
    if direct is None:
        from app.routing.geo import haversine_km
        
        origin_stop = graph_data.stops_by_id.get(origin_id)
        dest_stop = graph_data.stops_by_id.get(dest_id)
        
        if origin_stop and dest_stop:
            origin_lat, origin_lng = origin_stop["lat"], origin_stop["lng"]
            dest_lat, dest_lng = dest_stop["lat"], dest_stop["lng"]
            
            cand_origins = [origin_id]
            cand_dests = [dest_id]
            
            for stop_id, stop_data in graph_data.stops_by_id.items():
                if stop_id != origin_id:
                    if haversine_km(origin_lat, origin_lng, stop_data["lat"], stop_data["lng"]) <= 0.150:
                        cand_origins.append(stop_id)
                if stop_id != dest_id:
                    if haversine_km(dest_lat, dest_lng, stop_data["lat"], stop_data["lng"]) <= 0.150:
                        cand_dests.append(stop_id)
                        
            best_pair = None
            min_score = float('inf')
            
            for o in cand_origins:
                for d in cand_dests:
                    if o == d:
                        continue
                    if find_direct_route_bfs(graph_data, o, d) is not None:
                        o_data = graph_data.stops_by_id[o]
                        d_data = graph_data.stops_by_id[d]
                        # Score is the sum of distance from origin to candidate origin + distance from candidate dest to dest.
                        # Wait, user prompt: "selct the bus stop which has lowest distance to the destination bus stop"
                        # For origin candidate, it's haversine_km(o, dest_id). We can minimize this sum.
                        score = haversine_km(o_data["lat"], o_data["lng"], dest_lat, dest_lng) + \
                                haversine_km(d_data["lat"], d_data["lng"], dest_lat, dest_lng)
                        if score < min_score:
                            min_score = score
                            best_pair = (o, d)
                            
            if best_pair is not None:
                target_origin_id, target_dest_id = best_pair

    path = find_route_dijkstra(graph_data, target_origin_id, target_dest_id)

    if path is None:
        # Fall back to Dijkstra without nearby candidates if even they failed to yield a path
        if target_origin_id != origin_id or target_dest_id != dest_id:
            target_origin_id = origin_id
            target_dest_id = dest_id
            path = find_route_dijkstra(graph_data, origin_id, dest_id)
            
        if path is None:
            return RouteSearchResult(found=False, transfer_count=0, legs=[])

    legs_raw, total_km = path_to_legs(graph_data, path)

    if len(legs_raw) > 1:
        check_direct = find_direct_route_bfs(graph_data, target_origin_id, target_dest_id)
        if check_direct is not None:
            logger.warning(
                "Dijkstra returned %d transfers for %s->%s but a direct route (%s) exists — check transfer_penalty_km",
                len(legs_raw) - 1,
                target_origin_id,
                target_dest_id,
                check_direct,
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
    
    def make_walk_leg(from_id: str, to_id: str) -> RouteLegOut:
        from_stop = graph_data.stops_by_id[from_id]
        to_stop = graph_data.stops_by_id[to_id]
        from app.routing.geo import haversine_km
        dist = haversine_km(from_stop["lat"], from_stop["lng"], to_stop["lat"], to_stop["lng"])
        return RouteLegOut(
            route_id="walk",
            route_name=f"Walk to {to_stop['stop_name']}",
            operator=None,
            from_stop=StopOut(**from_stop),
            to_stop=StopOut(**to_stop),
            path=[
                (from_stop["lat"], from_stop["lng"]),
                (to_stop["lat"], to_stop["lng"])
            ]
        )

    if target_origin_id != origin_id:
        walk_leg = make_walk_leg(origin_id, target_origin_id)
        legs_out.insert(0, walk_leg)
        
    if target_dest_id != dest_id:
        walk_leg = make_walk_leg(target_dest_id, dest_id)
        legs_out.append(walk_leg)

    return RouteSearchResult(
        found=True,
        transfer_count=max(0, len([leg for leg in legs_out if leg.route_id != "walk"]) - 1),
        total_distance_km=total_km,
        legs=legs_out,
    )
