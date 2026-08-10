// Mirrors backend/app/schemas.py exactly. If you change one, change both.

export interface Stop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lng: number;
  is_interchange: boolean;
  is_major_stop: boolean;
}

export interface RouteLeg {
  route_id: string;
  route_name: string;
  from_stop: Stop;
  to_stop: Stop;
  // Straight stop-to-stop points from the API. lib/osrm.ts replaces this
  // with a real road-following polyline client-side.
  path: [number, number][]; // [lat, lng][]
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
