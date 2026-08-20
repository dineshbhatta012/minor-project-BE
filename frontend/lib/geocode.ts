// Geocoding via Nominatim (OpenStreetMap's free geocoder). No API key
// needed, but it's rate-limited (~1 req/s) and requires that clients keep a
// light footprint — hence the debounce + abort in the PlaceSearch component.

export interface Place {
  lat: number;
  lng: number;
  name: string;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?format=json&limit=6&countrycodes=np&accept-language=en&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const data = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  return data.map((d) => ({
    lat: parseFloat(d.lat),
    lng: parseFloat(d.lon),
    name: d.display_name,
  }));
}