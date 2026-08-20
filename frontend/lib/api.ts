import {
  RouteDetail,
  RouteSearchRequest,
  RouteSearchResult,
  RouteSummary,
  Stop,
} from "@/types/route";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export async function fetchStops(): Promise<Stop[]> {
  const res = await fetch(`${API_URL}/stops`);
  if (!res.ok) throw new Error(`Failed to load stops (${res.status})`);
  return res.json();
}

export async function fetchRoutes(): Promise<RouteSummary[]> {
  const res = await fetch(`${API_URL}/routes`);
  if (!res.ok) throw new Error(`Failed to load routes (${res.status})`);
  return res.json();
}

export async function fetchRouteDetail(routeId: string): Promise<RouteDetail> {
  const res = await fetch(`${API_URL}/routes/${encodeURIComponent(routeId)}`);
  if (!res.ok) throw new Error(`Failed to load route (${res.status})`);
  return res.json();
}

export async function searchRoute(payload: RouteSearchRequest): Promise<RouteSearchResult> {
  const res = await fetch(`${API_URL}/route/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Route search failed (${res.status})`);
  return res.json();
}

export async function updateStopCoordinates(
  stopId: string,
  lat: number,
  lng: number
): Promise<Stop> {
  const res = await fetch(`${API_URL}/stops/${encodeURIComponent(stopId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lng }),
  });
  if (!res.ok) throw new Error(`Failed to update stop (${res.status})`);
  return res.json();
}

export async function removeStopFromRoute(
  routeId: string,
  stopId: string
): Promise<RouteDetail> {
  const res = await fetch(
    `${API_URL}/routes/${encodeURIComponent(routeId)}/stops/${encodeURIComponent(stopId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to remove stop from route (${res.status})`);
  return res.json();
}
