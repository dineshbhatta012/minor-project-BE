import { RouteSearchRequest, RouteSearchResult, Stop } from "@/types/route";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function fetchStops(): Promise<Stop[]> {
  const res = await fetch(`${API_URL}/stops`);
  if (!res.ok) throw new Error(`Failed to load stops (${res.status})`);
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
