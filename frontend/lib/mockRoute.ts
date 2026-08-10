import { RouteSearchResult, Stop } from "@/types/route";

// A handful of fake Kathmandu Valley stops, roughly placed, for UI
// development only. Swap for the real dataset once it lands.
export const MOCK_STOPS: Stop[] = [
  { id: "s1", name: "Ratna Park", lat: 27.7041, lng: 85.3145 },
  { id: "s2", name: "Koteshwor", lat: 27.6789, lng: 85.3494 },
  { id: "s3", name: "Kalanki", lat: 27.6939, lng: 85.28 },
  { id: "s4", name: "Lagankhel", lat: 27.6667, lng: 85.3247 },
  { id: "s5", name: "Balaju", lat: 27.7326, lng: 85.3038 },
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
