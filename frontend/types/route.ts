// Mirrors backend/app/schemas.py exactly. If you change one, change both.

export interface Stop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lng: number;
  is_interchange: boolean;
  is_major_stop: boolean;
  congestion_score?: number;
  congestion_loss?: number;
}

export interface RouteLeg {
  route_id: string;
  route_name: string;
  operator?: string | null;
  from_stop: Stop;
  to_stop: Stop;
  // Stop coordinates in route order from the API (the polyline is drawn
  // through these so it follows the bus stops in sequence).
  path: [number, number][]; // [lat, lng][]
  // After OSRM enrichment, the original stop coordinates are preserved here
  // so bus-stop markers remain at the correct positions.
  stopCoords?: [number, number][];
  // Congestion scores parallel to path — one score per stop in route order.
  // Populated from backend's stop_scores field.
  stop_scores?: number[];
  // After OSRM enrichment, interpolated scores parallel to path (road geometry).
  pathScores?: number[];
}

export interface RouteSearchResult {
  found: boolean;
  transfer_count: number;
  total_distance_km?: number;
  legs: RouteLeg[];
}

export interface RouteSearchRequest {
  origin_stop_id: string;
  destination_stop_id: string;
}

export interface RouteSummary {
  route_id: string;
  route_name: string;
  short_name: string | null;
  vehicle_type: string;
  total_stops: number;
  approx_distance_km?: number | null;
  start_stop_id: string | null;
  end_stop_id: string | null;
}

export interface RouteDetail extends RouteSummary {
  stops: Stop[];
}
