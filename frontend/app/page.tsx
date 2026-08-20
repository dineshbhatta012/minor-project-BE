"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import SearchForm from "@/components/SearchForm";
import SearchableSelect from "@/components/SearchableSelect";
import PlaceSearch from "@/components/PlaceSearch";
import { Place } from "@/lib/geocode";
import { fetchRouteDetail, fetchRoutes, fetchStops, removeStopFromRoute, searchRoute, updateStopCoordinates } from "@/lib/api";
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
  const [editStopMode, setEditStopMode] = useState(false);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const [draftStop, setDraftStop] = useState<Stop | null>(null);
  const [stopMoveSaving, setStopMoveSaving] = useState(false);
  const [stopMoveError, setStopMoveError] = useState<string | null>(null);
  const [stopEditSuccess, setStopEditSuccess] = useState<string | null>(null);
  const [searchedPlace, setSearchedPlace] = useState<Place | null>(null);
  const [refreshingMap, setRefreshingMap] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Re-fetches stops (so changed bus-stop coordinates show up) and rebuilds
  // the currently displayed result (route detail or search) from fresh data so
  // the rendered path reflects the latest coordinates. Leaves the left-side
  // form untouched.
  async function handleRefreshMap() {
    setRefreshingMap(true);
    setRefreshError(null);
    try {
      const freshStops = await fetchStops();
      setStops(freshStops);
      if (selectedRoute) {
        const detail = await fetchRouteDetail(selectedRoute.route_id);
        setSelectedRoute(detail);
        setResult(await buildRouteResult(detail));
      } else if (result && result.found) {
        const resolveId = (name: string) =>
          freshStops.find((s) => s.stop_name.toLowerCase() === name.trim().toLowerCase())
            ?.stop_id;
        const originId = resolveId(originName);
        const destinationId = resolveId(destinationName);
        if (originId && destinationId) {
          const data = await searchRoute({
            origin_stop_id: originId,
            destination_stop_id: destinationId,
          });
          setResult(await enrichRouteWithRoadGeometry(data));
        }
      }
    } catch {
      setRefreshError("Map refresh failed. Is the backend running?");
    } finally {
      setRefreshingMap(false);
    }
  }

  function handleSelectStopForEdit(stop: Stop) {
    setEditingStop(stop);
    setDraftStop(null);
    setStopMoveError(null);
    setStopEditSuccess(null);
  }

  // Fired after the user drags a stop's marker to a new spot on the map. The
  // stop isn't saved yet — we just remember the new position so the user can
  // confirm or cancel.
  function handleStopDragged(stop: Stop, lat: number, lng: number) {
    setDraftStop({ ...stop, lat, lng });
    setStopMoveError(null);
  }

  async function handleSaveStopMove() {
    if (!editingStop || !draftStop) return;
    setStopMoveSaving(true);
    setStopMoveError(null);
    try {
      const updated = await updateStopCoordinates(
        editingStop.stop_id,
        draftStop.lat,
        draftStop.lng
      );
      setStops((prev) => prev.map((s) => (s.stop_id === updated.stop_id ? updated : s)));
      setEditingStop(null);
      setDraftStop(null);
      setStopEditSuccess(
        `Updated ${updated.stop_name} to ${updated.lat.toFixed(6)}, ${updated.lng.toFixed(6)}`
      );
      // Rebuild the displayed route/path so it uses the new coordinates.
      await handleRefreshMap();
    } catch {
      setStopMoveError("Failed to update the stop. Is the backend running?");
    } finally {
      setStopMoveSaving(false);
    }
  }

  function handleCancelStopMove() {
    setEditingStop(null);
    setDraftStop(null);
    setStopMoveError(null);
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

  async function buildRouteResult(detail: RouteDetail): Promise<RouteSearchResult> {
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
    return enrichRouteWithRoadGeometry(data);
  }

  async function handleSelectRoute(routeId: string) {
    setRouteLoading(true);
    setError(null);
    try {
      const detail = await fetchRouteDetail(routeId);
      setSelectedRoute(detail);
      setShowSequence(false);
      setResult(await buildRouteResult(detail));
    } catch {
      setError("Couldn't load that route.");
    } finally {
      setRouteLoading(false);
    }
  }

  async function handleDeleteStopFromRoute(stopId: string, stopName: string) {
    if (!selectedRoute) return;
    if (selectedRoute.stops.length <= 2) {
      setError("A route must keep at least two stops — cannot remove any more.");
      return;
    }
    if (!window.confirm(`Remove "${stopName}" from ${selectedRoute.route_name}?`)) return;
    setError(null);
    try {
      const updated = await removeStopFromRoute(selectedRoute.route_id, stopId);
      setRoutes((prev) =>
        prev.map((r) =>
          r.route_id === updated.route_id
            ? {
                ...r,
                total_stops: updated.total_stops,
                approx_distance_km: updated.approx_distance_km,
              }
            : r
        )
      );
      // Re-select the (updated) route so the map path and sequence refresh.
      await handleSelectRoute(selectedRoute.route_id);
      setShowSequence(true);
    } catch {
      setError("Couldn't remove that stop from the route.");
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

        <PlaceSearch
          onSelect={(place) => setSearchedPlace(place)}
          disabled={stopsLoading || !!stopsError}
        />
        {searchedPlace && (
          <div className="flex items-center justify-between gap-2 text-xs bg-route-panel rounded-md px-3 py-2">
            <span className="text-neutral-300 truncate" title={searchedPlace.name}>
              {searchedPlace.name}
            </span>
            <button
              type="button"
              onClick={() => setSearchedPlace(null)}
              className="shrink-0 text-neutral-500 hover:text-white transition-colors cursor-pointer"
              title="Clear searched place"
            >
              ✕
            </button>
          </div>
        )}

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
            onClick={() => {
              setEditStopMode((m) => !m);
              setEditingStop(null);
              setDraftStop(null);
              setStopMoveError(null);
              setStopEditSuccess(null);
            }}
            className={`rounded-md border font-medium py-2 text-sm transition-colors cursor-pointer ${
              editStopMode
                ? "bg-route-accent text-route-bg border-route-accent"
                : "bg-route-bg border-route-line text-neutral-300 hover:border-route-accent hover:text-white"
            }`}
          >
            {editStopMode ? "Stop editing bus stop" : "Edit bus stop"}
          </button>
          {editStopMode && (
            <p className="text-xs text-route-accent">
              Click a bus stop on the map, then drag the marker to its correct position.
            </p>
          )}
          {stopEditSuccess && (
            <p className="text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-900 rounded-md px-3 py-2">
              {stopEditSuccess}
            </p>
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
                <li key={`${s.stop_id}-${i}`} className="flex items-center gap-2 text-neutral-300 group">
                  <span className="text-neutral-500 w-6 shrink-0 text-right tabular-nums">
                    {i + 1}.
                  </span>
                  <span className="flex-1 truncate">{s.stop_name}</span>
                  <button
                    type="button"
                    onClick={() => handleDeleteStopFromRoute(s.stop_id, s.stop_name)}
                    disabled={selectedRoute.stops.length <= 2}
                    title={`Remove ${s.stop_name} from ${selectedRoute.route_name}`}
                    className="shrink-0 rounded p-1 text-neutral-600 opacity-0 group-hover:opacity-100 hover:text-red-400 focus:opacity-100 disabled:opacity-0 transition-colors cursor-pointer"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" y1="11" x2="10" y2="17" />
                      <line x1="14" y1="11" x2="14" y2="17" />
                    </svg>
                  </button>
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

      <div className="relative flex-1">
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
          editStopMode={editStopMode}
          onSelectStopForEdit={handleSelectStopForEdit}
          editingStop={editingStop}
          onStopDragged={handleStopDragged}
          place={searchedPlace}
        />

        {/* Drag-to-move helper card shown while re-positioning a bus stop */}
        {editingStop && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1100] w-[min(92%,24rem)] rounded-lg bg-route-panel border border-route-line shadow-lg p-4">
            {draftStop ? (
              <>
                <p className="text-sm font-medium text-white">{editingStop.stop_name}</p>
                <p className="text-xs text-neutral-400 mt-0.5">
                  New position: {draftStop.lat.toFixed(6)}, {draftStop.lng.toFixed(6)}
                </p>
                {stopMoveError && <p className="text-xs text-red-400 mt-2">{stopMoveError}</p>}
                <div className="flex gap-2 mt-3">
                  <button
                    type="button"
                    onClick={handleSaveStopMove}
                    disabled={stopMoveSaving}
                    className="flex-1 rounded-md bg-route-accent text-route-bg font-medium py-2 text-sm disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {stopMoveSaving ? "Saving…" : "Save new position"}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelStopMove}
                    disabled={stopMoveSaving}
                    className="flex-1 rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-route-accent hover:text-white font-medium py-2 text-sm transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-neutral-300">
                Drag the <span className="text-fuchsia-400 font-medium">violet marker</span> to the
                correct position for <span className="font-medium text-white">{editingStop.stop_name}</span>.
              </p>
            )}
          </div>
        )}

        {/* Map-only refresh button (top-right of the screen) */}
        <button
          type="button"
          onClick={handleRefreshMap}
          disabled={refreshingMap}
          title="Refresh map"
          className="absolute top-4 right-4 z-[1100] rounded-full bg-route-panel border border-route-line p-2.5 text-neutral-300 hover:border-route-accent hover:text-white shadow-lg disabled:opacity-50 transition-colors cursor-pointer"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={refreshingMap ? "animate-spin" : ""}
          >
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
        {refreshError && (
          <div className="absolute top-16 right-4 z-[1100] max-w-[240px] rounded-md bg-red-950/80 border border-red-900 px-3 py-2 text-xs text-red-300 shadow-lg">
            {refreshError}
          </div>
        )}
      </div>
    </main>
  );
}
