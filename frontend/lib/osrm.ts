// Talks to a public OSRM demo server to convert a straight origin->destination
// line into a real road-following polyline.
//
// IMPORTANT: router.project-osrm.org is a free public demo instance meant
// for light testing only — it's rate-limited and has no uptime guarantee.
// Before deploying, self-host OSRM (their Docker image + a Nepal/South-Asia
// .osm.pbf extract) or swap OSRM_BASE_URL for your own instance.
const OSRM_BASE_URL = "https://router.project-osrm.org";

/**
 * Fetches a road-following path between two points.
 * @param fromLat, fromLng - origin coordinates
 * @param toLat, toLng - destination coordinates
 * @param profile - "driving" (buses) or "foot" if you ever need walking legs
 * @returns array of [lat, lng] points tracing the road, or null if OSRM
 *          couldn't find a route (falls back to a straight line upstream).
 */
export async function getRoadPath(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  profile: "driving" | "foot" = "driving"
): Promise<[number, number][] | null> {
  const url = `${OSRM_BASE_URL}/route/v1/${profile}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.length) return null;

    // GeoJSON coordinates come back as [lng, lat] — Leaflet wants [lat, lng].
    const coords: [number, number][] = data.routes[0].geometry.coordinates.map(
      ([lng, lat]: [number, number]) => [lat, lng]
    );
    return coords;
  } catch {
    return null; // network error, offline, etc. — caller falls back to straight line
  }
}
