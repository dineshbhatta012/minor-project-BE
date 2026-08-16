import { RouteSearchResult, Stop } from "@/types/route";

// A handful of fake Kathmandu Valley stops, roughly placed, for UI
// development only. Swap for the real dataset once it lands.
export const MOCK_STOPS: Stop[] = [
  { stop_id: "s1", stop_name: "Ratna Park", lat: 27.7041, lng: 85.3145, is_interchange: false, is_major_stop: true },
  { stop_id: "s2", stop_name: "Koteshwor", lat: 27.6789, lng: 85.3494, is_interchange: true, is_major_stop: true },
  { stop_id: "s3", stop_name: "Kalanki", lat: 27.6939, lng: 85.28, is_interchange: true, is_major_stop: true },
  { stop_id: "s4", stop_name: "Lagankhel", lat: 27.6667, lng: 85.3247, is_interchange: true, is_major_stop: true },
  { stop_id: "s5", stop_name: "Balaju", lat: 27.7326, lng: 85.3038, is_interchange: false, is_major_stop: true },
];

export function getMockStops(): Stop[] {
  return MOCK_STOPS;
}

// Simulates a single-transfer route: Ratna Park -> Koteshwor -> Lagankhel.
export function getMockRouteResult(): RouteSearchResult {
  const ratnaPark = MOCK_STOPS[0];
  const koteshwor = MOCK_STOPS[1];
  const lagankhel = MOCK_STOPS[3];

  return {
    found: true,
    transfer_count: 1,
    total_distance_km: 9.4,
    legs: [
      {
        route_id: "r12",
        route_name: "Route 12 (Ratna Park - Koteshwor)",
        from_stop: ratnaPark,
        to_stop: koteshwor,
        path: [
          [ratnaPark.lat, ratnaPark.lng],
          [koteshwor.lat, koteshwor.lng],
        ],
      },
      {
        route_id: "r27",
        route_name: "Route 27 (Koteshwor - Lagankhel)",
        from_stop: koteshwor,
        to_stop: lagankhel,
        path: [
          [koteshwor.lat, koteshwor.lng],
          [lagankhel.lat, lagankhel.lng],
        ],
      },
    ],
  };
}

// Simulates the "no route found" case so the UI can be built against it.
export function getMockNoRouteResult(): RouteSearchResult {
  return { found: false, transfer_count: 0, legs: [] };
}
