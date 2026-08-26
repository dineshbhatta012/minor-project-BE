// Talks to a public OSRM demo server to convert a straight origin->destination
// line into a real road-following polyline.
//
// IMPORTANT: router.project-osrm.org is a free public demo instance meant
// for light testing only — it's rate-limited and has no uptime guarantee.
// Before deploying, self-host OSRM (their Docker image + a Nepal/South-Asia
// .osm.pbf extract) or swap OSRM_BASE_URL for your own instance.

import { RouteSearchResult } from "@/types/route";

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

/**
 * Fetches road geometry for all consecutive stop-pairs in a leg path and
 * stitches the sub-segments into a single detailed polyline.
 *
 * Falls back to the original straight-line path if all OSRM calls fail.
 */
async function getEnrichedPath(
  stopCoords: [number, number][],
  profile: "driving" | "foot" = "driving",
  stopScores?: number[]
): Promise<{ path: [number, number][]; scores: number[] }> {
  if (stopCoords.length < 2) {
    return { path: stopCoords, scores: stopScores ?? stopCoords.map(() => 0) };
  }

  // Fire all pair requests in parallel for speed.
  const pairPromises: Promise<[number, number][] | null>[] = [];
  for (let i = 0; i < stopCoords.length - 1; i++) {
    const [fromLat, fromLng] = stopCoords[i];
    const [toLat, toLng] = stopCoords[i + 1];
    pairPromises.push(getRoadPath(fromLat, fromLng, toLat, toLng, profile));
  }

  const segments = await Promise.all(pairPromises);

  // Stitch segments together, dropping duplicate junction points.
  const stitched: [number, number][] = [];
  const stitchedScores: number[] = [];
  const scores = stopScores ?? stopCoords.map(() => 0);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const fromScore = scores[i] ?? 0;
    const toScore = scores[i + 1] ?? 0;

    if (seg && seg.length > 0) {
      // Interpolate scores across this segment's points
      const segScores: number[] = seg.map((_, j) => {
        const t = seg.length === 1 ? 0 : j / (seg.length - 1);
        return fromScore + (toScore - fromScore) * t;
      });

      // Avoid duplicate point at the junction with the previous segment.
      const start = stitched.length > 0 ? 1 : 0;
      for (let j = start; j < seg.length; j++) {
        stitched.push(seg[j]);
        stitchedScores.push(segScores[j]);
      }
    } else {
      // OSRM failed for this pair — fall back to a straight line for it.
      if (stitched.length === 0) {
        stitched.push(stopCoords[i]);
        stitchedScores.push(fromScore);
      }
      stitched.push(stopCoords[i + 1]);
      stitchedScores.push(toScore);
    }
  }

  if (stitched.length >= 2) {
    return { path: stitched, scores: stitchedScores };
  }
  return { path: stopCoords, scores };
}

/**
 * Takes a RouteSearchResult (whose leg.path arrays are just stop coordinates,
 * i.e. straight lines) and replaces each leg.path with a road-following
 * polyline fetched from OSRM.
 *
 * The original stop coordinates are preserved in a new `stopCoords` field on
 * each leg so bus-stop markers can still be placed exactly where they belong.
 */
export async function enrichRouteWithRoadGeometry(
  result: RouteSearchResult
): Promise<RouteSearchResult> {
  if (!result.found || result.legs.length === 0) return result;

  const enrichedLegs = await Promise.all(
    result.legs.map(async (leg) => {
      const { path: roadPath, scores } = await getEnrichedPath(
        leg.path,
        "driving",
        leg.stop_scores
      );
      return {
        ...leg,
        // Keep original stop positions for markers; use road path for polyline.
        stopCoords: leg.path,
        path: roadPath,
        pathScores: scores,
      };
    })
  );

  return { ...result, legs: enrichedLegs };
}
