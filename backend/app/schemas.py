from pydantic import BaseModel


class StopOut(BaseModel):
    stop_id: str
    stop_name: str
    lat: float
    lng: float
    is_interchange: bool
    is_major_stop: bool


class RouteLegOut(BaseModel):
    route_id: str
    route_name: str
    from_stop: StopOut
    to_stop: StopOut
    # Straight endpoint-to-endpoint line. The frontend replaces this with a
    # real road-following polyline via OSRM — see lib/osrm.ts. We don't do
    # that server-side to avoid coupling the API's response time to a
    # third-party routing service's latency/rate limits.
    path: list[tuple[float, float]]  # [(lat, lng), ...]


class RouteSearchResult(BaseModel):
    found: bool
    transfer_count: int
    total_distance_km: float | None = None
    legs: list[RouteLegOut] = []


class RouteSearchRequest(BaseModel):
    origin_stop_id: str
    destination_stop_id: str


class RouteSummaryOut(BaseModel):
    route_id: str
    route_name: str
    short_name: str | None
    vehicle_type: str
    total_stops: int
    approx_distance_km: float | None
    start_stop_id: str
    end_stop_id: str


class RouteDetailOut(RouteSummaryOut):
    stops: list[StopOut]


class GraphStatsOut(BaseModel):
    stop_nodes: int
    route_nodes: int
    edges: int
    active_routes: int
