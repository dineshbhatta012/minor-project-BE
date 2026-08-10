"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import SearchForm from "@/components/SearchForm";
import { fetchStops, searchRoute } from "@/lib/api";
import { getRoadPath } from "@/lib/osrm";
import { RouteSearchResult, Stop } from "@/types/route";

// Leaflet touches `window`, so the map must load client-side only.
const BusMap = dynamic(() => import("@/components/BusMap"), { ssr: false });

// Replaces each leg's straight from->to line with a real road-following
// polyline from OSRM. Falls back to the original straight line for any leg
// where OSRM fails, so the map still renders something instead of breaking.
async function withRoadPaths(result: RouteSearchResult): Promise<RouteSearchResult> {
  const legs = await Promise.all(
    result.legs.map(async (leg) => {
      const roadPath = await getRoadPath(
        leg.from_stop.lat,
        leg.from_stop.lng,
        leg.to_stop.lat,
        leg.to_stop.lng
      );
      return roadPath ? { ...leg, path: roadPath } : leg;
    })
  );
  return { ...result, legs };
}

export default function Home() {
  const [stops, setStops] = useState<Stop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(true);
  const [stopsError, setStopsError] = useState<string | null>(null);

  const [result, setResult] = useState<RouteSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStops()
      .then(setStops)
      .catch(() =>
        setStopsError(
          "Couldn't reach the backend. Is it running at NEXT_PUBLIC_API_URL (default http://localhost:8000)?"
        )
      )
      .finally(() => setStopsLoading(false));
  }, []);

  async function handleSearch(originStopId: string, destinationStopId: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await searchRoute({
        origin_stop_id: originStopId,
        destination_stop_id: destinationStopId,
      });
      const withRoads = data.found ? await withRoadPaths(data) : data;
      setResult(withRoads);
    } catch {
      setError("Something went wrong searching for a route. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex h-screen w-screen">
      <aside className="w-full max-w-sm flex flex-col gap-4 p-4 overflow-y-auto border-r border-route-line">
        <div>
          <h1 className="text-lg font-semibold">Kathmandu Bus Route Finder</h1>
          <p className="text-sm text-neutral-400">
            Find a direct or single-transfer bus route across the Valley.
          </p>
        </div>

        {stopsError && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
            {stopsError}
          </p>
        )}

        <SearchForm
          stops={stops}
          onSearch={handleSearch}
          loading={loading}
          disabled={stopsLoading || !!stopsError}
        />

        {error && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {result && !result.found && (
          <p className="text-sm text-neutral-300 bg-route-panel rounded-md px-3 py-2">
            No direct or single-transfer route found between those stops.
          </p>
        )}

        {result && result.found && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="text-neutral-400">
              {result.transfer_count === 0 ? "Direct route" : `${result.transfer_count} transfer`}
              {result.total_distance_km ? ` · ${result.total_distance_km} km` : ""}
            </p>
            {result.legs.map((leg) => (
              <div key={leg.route_id} className="bg-route-panel rounded-md px-3 py-2">
                <p className="font-medium">{leg.route_name}</p>
                <p className="text-neutral-400">
                  {leg.from_stop.stop_name} → {leg.to_stop.stop_name}
                </p>
              </div>
            ))}
          </div>
        )}
      </aside>

      <div className="flex-1">
        <BusMap result={result} />
      </div>
    </main>
  );
}
