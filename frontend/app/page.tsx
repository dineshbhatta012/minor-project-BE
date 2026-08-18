"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import SearchForm from "@/components/SearchForm";
import { fetchRouteDetail, fetchRoutes, fetchStops, searchRoute } from "@/lib/api";
import { enrichRouteWithRoadGeometry } from "@/lib/osrm";
import { RouteDetail, RouteSearchResult, RouteSummary, Stop } from "@/types/route";

// Leaflet touches `window`, so the map must load client-side only.
const BusMap = dynamic(() => import("@/components/BusMap"), { ssr: false });

export default function Home() {
  const [stops, setStops] = useState<Stop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(true);
  const [stopsError, setStopsError] = useState<string | null>(null);

  const [originName, setOriginName] = useState("");
  const [destinationName, setDestinationName] = useState("");
  const [mapSelectionMode, setMapSelectionMode] = useState<"from" | "to" | null>(null);

  const [result, setResult] = useState<RouteSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<RouteDetail | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [showSequence, setShowSequence] = useState(false);

  function handleSelectStop(stop: Stop, type: "from" | "to") {
    if (type === "from") {
      setOriginName(stop.stop_name);
    } else {
      setDestinationName(stop.stop_name);
    }
    setMapSelectionMode(null);
  }

  function handleSwap() {
    setOriginName(destinationName);
    setDestinationName(originName);
    setResult(null);
    setError(null);
  }

  function handleClear() {
    setOriginName("");
    setDestinationName("");
    setMapSelectionMode(null);
    setResult(null);
    setSelectedRoute(null);
    setShowSequence(false);
    setError(null);
  }

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
    setSelectedRoute(null);
    try {
      const data = await searchRoute({
        origin_stop_id: originStopId,
        destination_stop_id: destinationStopId,
      });
      // Enrich straight-line paths with actual road geometry from OSRM.
      const enriched = await enrichRouteWithRoadGeometry(data);
      setResult(enriched);
    } catch {
      setError("Something went wrong searching for a route. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleRoutes() {
    if (routes.length === 0 && !routesLoading) {
      setRoutesLoading(true);
      setRoutesError(null);
      try {
        setRoutes(await fetchRoutes());
        setRoutesOpen(true);
      } catch {
        setRoutesError("Couldn't load the route list.");
      } finally {
        setRoutesLoading(false);
      }
    } else {
      setRoutesOpen((open) => !open);
    }
  }

  async function handleSelectRoute(routeId: string) {
    setRouteLoading(true);
    setError(null);
    try {
      const detail = await fetchRouteDetail(routeId);
      setSelectedRoute(detail);
      setShowSequence(false);
      const data: RouteSearchResult = {
        found: true,
        transfer_count: 0,
        total_distance_km: detail.approx_distance_km ?? undefined,
        legs: [
          {
            route_id: detail.route_id,
            route_name: detail.route_name,
            from_stop: detail.stops[0],
            to_stop: detail.stops[detail.stops.length - 1],
            path: detail.stops.map((s) => [s.lat, s.lng]),
          },
        ],
      };
      const enriched = await enrichRouteWithRoadGeometry(data);
      setResult(enriched);
    } catch {
      setError("Couldn't load that route.");
    } finally {
      setRouteLoading(false);
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
          originName={originName}
          setOriginName={setOriginName}
          destinationName={destinationName}
          setDestinationName={setDestinationName}
          mapSelectionMode={mapSelectionMode}
          setMapSelectionMode={setMapSelectionMode}
          onSearch={handleSearch}
          onSwap={handleSwap}
          onClear={handleClear}
          loading={loading}
          disabled={stopsLoading || !!stopsError}
        />

        <button
          type="button"
          onClick={handleToggleRoutes}
          disabled={stopsLoading || !!stopsError || routesLoading}
          className="rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-route-accent hover:text-white font-medium py-2 text-sm disabled:opacity-50 transition-colors cursor-pointer"
        >
          {routesLoading ? "Loading routes…" : routesOpen ? "Hide routes" : "Show all routes"}
        </button>

        {routesError && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
            {routesError}
          </p>
        )}

        {routesOpen && (
          <div className="flex flex-col gap-2">
            <select
              value=""
              onChange={(e) => e.target.value && handleSelectRoute(e.target.value)}
              disabled={routeLoading}
              className="rounded-md bg-route-bg border border-route-line px-3 py-2 text-sm text-neutral-300 outline-none focus:border-route-accent disabled:opacity-50"
            >
              <option value="" disabled>
                Select a route…
              </option>
              {routes.map((r) => (
                <option key={r.route_id} value={r.route_id}>
                  {r.route_name} ({r.total_stops} stops)
                </option>
              ))}
            </select>
            {routeLoading && (
              <p className="text-xs text-route-accent">Loading route stops…</p>
            )}
          </div>
        )}

        {selectedRoute && !routeLoading && (
          <div className="flex flex-col gap-1 text-sm bg-route-panel rounded-md px-3 py-2">
            <p className="font-medium">
              {selectedRoute.route_name}{" "}
              <span className="text-neutral-500">({selectedRoute.route_id})</span>
            </p>
            <p className="text-neutral-400">
              {selectedRoute.vehicle_type} · {selectedRoute.total_stops} stops
              {selectedRoute.approx_distance_km
                ? ` · ${selectedRoute.approx_distance_km} km`
                : ""}
            </p>
            <button
              type="button"
              onClick={() => setShowSequence((s) => !s)}
              className="mt-1 rounded-md bg-route-accent text-route-bg font-medium py-1.5 text-xs disabled:opacity-50 transition-colors cursor-pointer"
            >
              {showSequence ? "Hide sequence" : "View sequence"}
            </button>
          </div>
        )}

        {showSequence && selectedRoute && !routeLoading && (
          <div className="flex flex-col gap-2 text-sm bg-route-panel rounded-md px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-neutral-400">
              Bus stops in sequence ({selectedRoute.stops.length})
            </p>
            <ol className="flex flex-col gap-1 max-h-72 overflow-y-auto pr-1">
              {selectedRoute.stops.map((s, i) => (
                <li key={`${s.stop_id}-${i}`} className="flex gap-2 text-neutral-300">
                  <span className="text-neutral-500 w-6 shrink-0 text-right tabular-nums">
                    {i + 1}.
                  </span>
                  <span>{s.stop_name}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

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
                <p className="font-medium">
                  {leg.route_name} <span className="text-neutral-500">({leg.route_id})</span>
                </p>
                <p className="text-neutral-400">
                  {leg.from_stop.stop_name} → {leg.to_stop.stop_name}
                </p>
              </div>
            ))}
          </div>
        )}
      </aside>

      <div className="flex-1">
        <BusMap
          result={result}
          stops={stops}
          originName={originName}
          destinationName={destinationName}
          mapSelectionMode={mapSelectionMode}
          onSelectStop={handleSelectStop}
        />
      </div>
    </main>
  );
}
