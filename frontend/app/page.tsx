"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import SearchForm from "@/components/SearchForm";
import SearchableSelect from "@/components/SearchableSelect";
import { fetchRouteDetail, fetchRoutes, fetchStops, searchRoute } from "@/lib/api";
import { enrichRouteWithRoadGeometry, getRoadPath } from "@/lib/osrm";
import { haversineMeters } from "@/lib/geo";
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
  const [routesOpen, setRoutesOpen] = useState(true);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<RouteDetail | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [showSequence, setShowSequence] = useState(false);
  const [activeCategory, setActiveCategory] = useState("All");
  const [coordinateMode, setCoordinateMode] = useState(false);
  const [pickedPoint, setPickedPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [copied, setCopied] = useState(false);

  function handlePickCoordinate(lat: number, lng: number) {
    setPickedPoint({ lat, lng });
  }

  function handleCopyCoordinates() {
    if (!pickedPoint) return;
    const text = `${pickedPoint.lat.toFixed(6)}, ${pickedPoint.lng.toFixed(6)}`;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  const CATEGORY_NAMES = ["All", "Dinesh", "Dipesh", "Janak"] as const;

  // Evenly split the fetched routes across the 3 categories (31/31/31).
  const routeGroups = (() => {
    const chunk = Math.ceil(routes.length / (CATEGORY_NAMES.length - 1));
    const categories = CATEGORY_NAMES.filter((name) => name !== "All").map((name, i) => ({
      name,
      routes: routes.slice(i * chunk, (i + 1) * chunk),
    }));
    return [{ name: "All", routes }, ...categories];
  })();

  // Load the route list once on mount so the panel is populated by default.
  useEffect(() => {
    if (routes.length > 0 || routesLoading) return;
    setRoutesLoading(true);
    setRoutesError(null);
    fetchRoutes()
      .then(setRoutes)
      .catch(() => setRoutesError("Couldn't load the route list."))
      .finally(() => setRoutesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [myLocation, setMyLocation] = useState<{
    lat: number;
    lng: number;
    stop: Stop;
    walkMeters: number;
    walkPath: [number, number][];
  } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  function findNearestStop(lat: number, lng: number): { stop: Stop; meters: number } | null {
    let best: Stop | null = null;
    let bestMeters = Infinity;
    for (const s of stops) {
      const meters = haversineMeters(lat, lng, s.lat, s.lng);
      if (meters < bestMeters) {
        bestMeters = meters;
        best = s;
      }
    }
    return best ? { stop: best, meters: Math.round(bestMeters) } : null;
  }

  function handleUseMyLocation() {
    if (!("geolocation" in navigator)) {
      setLocationError("Geolocation isn't supported by this browser.");
      return;
    }
    setLocating(true);
    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        const nearest = findNearestStop(latitude, longitude);
        setLocating(false);
        if (!nearest) {
          setLocationError("Couldn't find any bus stop nearby.");
          return;
        }
        // Trace the actual walking route to the stop (OSRM foot profile),
        // falling back to a straight line if the foot route isn't available.
        const footPath =
          (await getRoadPath(latitude, longitude, nearest.stop.lat, nearest.stop.lng, "foot")) ??
          [
            [latitude, longitude],
            [nearest.stop.lat, nearest.stop.lng],
          ];
        setMyLocation({
          lat: latitude,
          lng: longitude,
          stop: nearest.stop,
          walkMeters: nearest.meters,
          walkPath: footPath,
        });
        setOriginName(nearest.stop.stop_name);
        setMapSelectionMode(null);
        setResult(null);
        setSelectedRoute(null);
        setShowSequence(false);
        setError(null);
      },
      (err) => {
        setLocating(false);
        const message =
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Allow access and try again."
            : "Couldn't get your location. Try again.";
        setLocationError(message);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

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
    setMyLocation(null);
    setLocationError(null);
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
          onUseMyLocation={handleUseMyLocation}
          locating={locating}
          locationError={locationError}
          loading={loading}
          disabled={stopsLoading || !!stopsError}
        />

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setCoordinateMode((m) => !m)}
            className={`rounded-md border font-medium py-2 text-sm transition-colors cursor-pointer ${
              coordinateMode
                ? "bg-route-accent text-route-bg border-route-accent"
                : "bg-route-bg border-route-line text-neutral-300 hover:border-route-accent hover:text-white"
            }`}
          >
            {coordinateMode ? "Stop picking coordinates" : "Show coordinates"}
          </button>
          {coordinateMode && (
            <p className="text-xs text-route-accent">
              Right-click anywhere on the map to pick its coordinates.
            </p>
          )}
          {pickedPoint && (
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={`${pickedPoint.lat.toFixed(6)}, ${pickedPoint.lng.toFixed(6)}`}
                className="flex-1 rounded-md bg-route-bg border border-route-line px-3 py-2 text-sm text-neutral-300 outline-none focus:border-route-accent"
              />
              <button
                type="button"
                onClick={handleCopyCoordinates}
                title="Copy coordinates"
                className="rounded-md bg-route-bg border border-route-line p-2 text-neutral-300 hover:border-route-accent hover:text-white transition-colors cursor-pointer"
              >
                {copied ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </div>
          )}
        </div>

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
            <div className="flex gap-1.5">
              {routeGroups.map((group) => (
                <button
                  key={group.name}
                  type="button"
                  onClick={() => setActiveCategory(group.name)}
                  className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors cursor-pointer border ${
                    activeCategory === group.name
                      ? "bg-route-accent text-route-bg border-route-accent"
                      : "bg-route-bg border-route-line text-neutral-300 hover:border-route-accent"
                  }`}
                >
                  {group.name}
                  <span className="ml-1 opacity-70">({group.routes.length})</span>
                </button>
              ))}
            </div>
            <SearchableSelect
              options={routeGroups
                .find((g) => g.name === activeCategory)!
                .routes.map((r) => ({
                  value: r.route_id,
                  label: `${r.route_name} (${r.total_stops} stops)`,
                }))}
              value=""
              onChange={(id) => id && handleSelectRoute(id)}
              placeholder={`Search routes in ${activeCategory}…`}
              disabled={routeLoading}
            />
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
            {myLocation && (
              <div className="flex flex-col gap-1.5 bg-route-panel rounded-md px-3 py-2 text-neutral-300">
                <p>
                  Go to {myLocation.stop.stop_name}, ~{myLocation.walkMeters} m from your
                  location.
                </p>
                {result.legs.map((leg, i) => (
                  <p key={leg.route_id}>
                    {i === 0 ? "Take" : "Then take"} {leg.operator ? `${leg.operator} ` : ""}
                    {leg.route_name} from {leg.from_stop.stop_name} to {leg.to_stop.stop_name}.
                  </p>
                ))}
              </div>
            )}
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
          userLocation={myLocation ? { lat: myLocation.lat, lng: myLocation.lng } : null}
          focusStop={myLocation?.stop ?? null}
          walkPath={myLocation?.walkPath ?? null}
          coordinateMode={coordinateMode}
          onPickCoordinate={handlePickCoordinate}
          pickedPoint={pickedPoint}
        />
      </div>
    </main>
  );
}
