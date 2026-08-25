from pydantic import BaseModel, Field


class StopOut(BaseModel):
    stop_id: str
    stop_name: str
    lat: float
    lng: float
    is_interchange: bool
    is_major_stop: bool


class StopCreateRequest(BaseModel):
    stop_name: str
    lat: float
    lng: float
    is_interchange: bool = False
    is_major_stop: bool = False

class StopUpdateRequest(BaseModel):
    lat: float
    lng: float

class RouteCreateRequest(BaseModel):
    route_name: str = Field(min_length=1, max_length=200)


class RouteStopsUpdateRequest(BaseModel):
    stop_ids: list[str]

class RouteLegOut(BaseModel):
    route_id: str
    route_name: str
    operator: str | None = None
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
    start_stop_id: str | None = None
    end_stop_id: str | None = None


class RouteDetailOut(RouteSummaryOut):
    stops: list[StopOut]


class GraphStatsOut(BaseModel):
    stop_nodes: int
    route_nodes: int
    edges: int
    active_routes: int
