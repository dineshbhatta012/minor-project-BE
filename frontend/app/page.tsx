"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import SearchForm from "@/components/SearchForm";
import SearchableSelect from "@/components/SearchableSelect";
import {
  fetchRouteDetail,
  fetchRoutes,
  fetchStops,
  removeStopFromRoute,
  searchRoute,
  updateStopCoordinates,
  updateRouteStops,
  createStop,
  createRoute,
} from "@/lib/api";
import { enrichRouteWithRoadGeometry, getRoadPath } from "@/lib/osrm";
import { haversineMeters } from "@/lib/geo";
import { RouteDetail, RouteSearchResult, RouteSummary, Stop } from "@/types/route";

// Leaflet touches `window`, so the map must load client-side only.
const BusMap = dynamic(() => import("@/components/BusMap"), { ssr: false });

type NavSection = "navigate" | "routes" | "edit";

export default function Home() {
  // Navigation active tab and per-section open/minimize state
  const [activeTab, setActiveTab] = useState<NavSection>("navigate");
  const [isNavigateMinimized, setIsNavigateMinimized] = useState(false);
  const [isRoutesMinimized, setIsRoutesMinimized] = useState(false);
  const [isEditMinimized, setIsEditMinimized] = useState(false);

  function handleTabChange(tab: NavSection) {
    if (activeTab === tab) {
      // Toggle minimize for the current section when clicked
      if (tab === "navigate") {
        setIsNavigateMinimized((open) => !open);
      } else if (tab === "routes") {
        setIsRoutesMinimized((open) => !open);
      } else if (tab === "edit") {
        setIsEditMinimized((open) => !open);
      }
    } else {
      setActiveTab(tab);
      if (tab === "navigate") {
        setIsNavigateMinimized(false);
      } else if (tab === "routes") {
        setIsRoutesMinimized(false);
      } else if (tab === "edit") {
        setIsEditMinimized(false);
      }
    }
  }

  // Derived: whether the active panel section is expanded
  const isPanelOpen =
    activeTab === "navigate" ? !isNavigateMinimized :
    activeTab === "routes" ? !isRoutesMinimized :
    !isEditMinimized;

  // Stops state
  const [stops, setStops] = useState<Stop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(true);
  const [stopsError, setStopsError] = useState<string | null>(null);

  // Navigate section state
  const [originName, setOriginName] = useState("");
  const [destinationName, setDestinationName] = useState("");
  const [mapSelectionMode, setMapSelectionMode] = useState<"from" | "to" | null>(null);

  const [result, setResult] = useState<RouteSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Routes section state
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [routeSearchQuery, setRouteSearchQuery] = useState("");
  const [selectedRoute, setSelectedRoute] = useState<RouteDetail | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [showSequence, setShowSequence] = useState(false);
  const [creatingRoute, setCreatingRoute] = useState(false);
  const [creatingRouteSaving, setCreatingRouteSaving] = useState(false);
  const [newRouteName, setNewRouteName] = useState("");
  const [draggedStopIndex, setDraggedStopIndex] = useState<number | null>(null);
  const [dragOverStopIndex, setDragOverStopIndex] = useState<number | null>(null);
  const [addingStop, setAddingStop] = useState(false);

  // Edit section state (Add / Edit Stop)
  const [editStopMode, setEditStopMode] = useState(false);
  const [addStopMode, setAddStopMode] = useState(false);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const [draftStop, setDraftStop] = useState<Stop | null>(null);
  const [stopMoveSaving, setStopMoveSaving] = useState(false);
  const [stopMoveError, setStopMoveError] = useState<string | null>(null);
  const [stopEditSuccess, setStopEditSuccess] = useState<string | null>(null);

  const [pendingNewStopCoords, setPendingNewStopCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [pendingNewStopName, setPendingNewStopName] = useState("");

  // Map refresh state
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
        `Updated ${updated.stop_name} coordinates to ${updated.lat.toFixed(6)}, ${updated.lng.toFixed(6)}`
      );
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

  function handleAddStopMapClick(lat: number, lng: number) {
    setPendingNewStopCoords({ lat, lng });
    setPendingNewStopName("");
    setStopEditSuccess(null);
  }

  async function handleConfirmAddStop() {
    if (!pendingNewStopCoords || !pendingNewStopName.trim()) {
      return;
    }
    setStopMoveSaving(true);
    setStopMoveError(null);
    try {
      const newStop = await createStop({
        stop_name: pendingNewStopName.trim(),
        lat: pendingNewStopCoords.lat,
        lng: pendingNewStopCoords.lng,
      });
      setStops((prev) => [...prev, newStop].sort((a, b) => a.stop_name.localeCompare(b.stop_name)));
      setStopEditSuccess(`Added new bus stop: ${newStop.stop_name}`);
      setAddStopMode(false);
      setPendingNewStopCoords(null);
    } catch {
      setStopMoveError("Failed to add bus stop. Is the backend running?");
    } finally {
      setStopMoveSaving(false);
    }
  }

  function handleCancelAddStop() {
    setPendingNewStopCoords(null);
    setPendingNewStopName("");
    setAddStopMode(false);
  }

  // Filtered routes in single "Show all routes" list
  const filteredRoutes = routes.filter((r) =>
    r.route_name.toLowerCase().includes(routeSearchQuery.toLowerCase())
  );

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

  async function buildRouteResult(detail: RouteDetail): Promise<RouteSearchResult | null> {
    if (detail.stops.length < 2) return null;
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

  function handleDragStart(e: React.DragEvent, index: number) {
    setDraggedStopIndex(index);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverStopIndex(index);
  }

  async function handleDrop(e: React.DragEvent, dropIndex: number) {
    e.preventDefault();
    if (draggedStopIndex === null || draggedStopIndex === dropIndex || !selectedRoute) {
      setDragOverStopIndex(null);
      setDraggedStopIndex(null);
      return;
    }

    const newStops = [...selectedRoute.stops];
    const [moved] = newStops.splice(draggedStopIndex, 1);
    newStops.splice(dropIndex, 0, moved);

    const newStopIds = newStops.map((s) => s.stop_id);
    const previousRoute = { ...selectedRoute };

    // Optimistic UI update
    setSelectedRoute({ ...selectedRoute, stops: newStops });
    setDragOverStopIndex(null);
    setDraggedStopIndex(null);
    setError(null);

    try {
      const updated = await updateRouteStops(selectedRoute.route_id, newStopIds);
      setRoutes((prev) =>
        prev.map((r) =>
          r.route_id === updated.route_id
            ? {
                ...r,
                total_stops: updated.total_stops,
                approx_distance_km: updated.approx_distance_km,
                start_stop_id: updated.start_stop_id,
                end_stop_id: updated.end_stop_id,
              }
            : r
        )
      );
      setSelectedRoute(updated);
      setResult(await buildRouteResult(updated));
    } catch {
      setError("Couldn't reorder stops.");
      setSelectedRoute(previousRoute);
    }
  }

  async function handleAddStopToRoute(stopId: string) {
    if (!selectedRoute) return;
    const newStopIds = [...selectedRoute.stops.map((s) => s.stop_id), stopId];
    setError(null);
    try {
      const updated = await updateRouteStops(selectedRoute.route_id, newStopIds);
      setRoutes((prev) =>
        prev.map((r) =>
          r.route_id === updated.route_id
            ? {
                ...r,
                total_stops: updated.total_stops,
                approx_distance_km: updated.approx_distance_km,
                start_stop_id: updated.start_stop_id,
                end_stop_id: updated.end_stop_id,
              }
            : r
        )
      );
      setSelectedRoute(updated);
      setResult(await buildRouteResult(updated));
      setAddingStop(false);
    } catch {
      setError("Couldn't add stop to route.");
    }
  }

  async function handleDeleteStopFromRoute(sequenceNo: number, stopName: string) {
    if (!selectedRoute) return;
    if (selectedRoute.stops.length <= 2) {
      setError("A route must keep at least two stops — cannot remove any more.");
      return;
    }
    if (!window.confirm(`Remove "${stopName}" from ${selectedRoute.route_name}?`)) return;
    setError(null);
    try {
      const updated = await removeStopFromRoute(selectedRoute.route_id, sequenceNo);
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
    <main className="flex flex-col h-screen w-screen bg-route-bg text-neutral-100 overflow-hidden font-sans">
      {/* ── Top Horizontal Navigation Bar ── */}
      <header className="h-14 bg-route-panel border-b border-route-line px-4 flex items-center justify-between shrink-0 z-20">
        <div className="flex items-center gap-6">
          <h1 className="text-base font-semibold text-white tracking-tight">
            Kathmandu Bus Route Finder
          </h1>

          {/* Horizontal Nav Bar */}
          <nav className="flex items-center bg-route-bg p-1 rounded-lg border border-route-line">
            <button
              type="button"
              onClick={() => handleTabChange("navigate")}
              title={activeTab === "navigate" && isPanelOpen ? "Minimize Navigate section" : "Open Navigate section"}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer ${
                activeTab === "navigate" && isPanelOpen
                  ? "bg-route-accent text-route-bg font-semibold shadow-sm"
                  : activeTab === "navigate"
                    ? "border border-route-accent/50 text-white bg-route-panel"
                    : "text-neutral-300 hover:text-white hover:bg-route-panel"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="3 11 22 2 13 21 11 13 3 11" />
              </svg>
              Navigate
              {activeTab === "navigate" && isPanelOpen && (
                <span className="text-[10px] opacity-75 font-normal ml-0.5">•</span>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleTabChange("routes")}
              title={activeTab === "routes" && isPanelOpen ? "Minimize Routes section" : "Open Routes section"}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer ${
                activeTab === "routes" && isPanelOpen
                  ? "bg-route-accent text-route-bg font-semibold shadow-sm"
                  : activeTab === "routes"
                    ? "border border-route-accent/50 text-white bg-route-panel"
                    : "text-neutral-300 hover:text-white hover:bg-route-panel"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="6" cy="19" r="3" />
                <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
                <circle cx="18" cy="5" r="3" />
              </svg>
              Routes
              {activeTab === "routes" && isPanelOpen && (
                <span className="text-[10px] opacity-75 font-normal ml-0.5">•</span>
              )}
            </button>

            <button
              type="button"
              onClick={() => handleTabChange("edit")}
              title={activeTab === "edit" && isPanelOpen ? "Minimize Edit section" : "Open Edit section"}
              className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer ${
                activeTab === "edit" && isPanelOpen
                  ? "bg-route-accent text-route-bg font-semibold shadow-sm"
                  : activeTab === "edit"
                    ? "border border-route-accent/50 text-white bg-route-panel"
                    : "text-neutral-300 hover:text-white hover:bg-route-panel"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              Edit
              {activeTab === "edit" && isPanelOpen && (
                <span className="text-[10px] opacity-75 font-normal ml-0.5">•</span>
              )}
            </button>
          </nav>
        </div>

      </header>

      {/* ── Main Body: Sidebar + Map ── */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Side Panel (Collapsible) */}
        {isPanelOpen && (
          <aside className="w-full max-w-sm flex flex-col gap-4 p-4 overflow-y-auto border-r border-route-line bg-route-bg/95 shrink-0 z-10">

            {stopsError && (
              <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
                {stopsError}
              </p>
            )}

            {/* ── Navigate Tab ── */}
            {activeTab === "navigate" && (
              <>
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
              </>
            )}

            {/* ── Routes Tab ── */}
            {activeTab === "routes" && (
              <>
                {routesLoading && (
                  <p className="text-xs text-route-accent">Loading routes…</p>
                )}
                {routesError && (
                  <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
                    {routesError}
                  </p>
                )}

                {/* Search / filter routes */}
                <div className="flex flex-col gap-2">
                  <input
                    type="text"
                    value={routeSearchQuery}
                    onChange={(e) => setRouteSearchQuery(e.target.value)}
                    placeholder="Search routes…"
                    className="w-full bg-route-bg border border-route-line rounded px-3 py-2 text-sm text-neutral-200 outline-none focus:border-route-accent transition-colors"
                  />

                  <button
                    type="button"
                    onClick={() => setCreatingRoute(true)}
                    className="mt-2 rounded-md bg-route-accent text-route-bg font-medium py-1.5 text-xs transition-colors cursor-pointer"
                  >
                    Create route
                  </button>
                  {creatingRoute ? (
                    <div className="mt-2 flex flex-col gap-2 p-2 bg-route-bg/50 border border-route-line rounded-md">
                      <p className="text-xs text-neutral-400">Enter route name:</p>
                      <input
                        type="text"
                        value={newRouteName}
                        onChange={(e) => setNewRouteName(e.target.value)}
                        placeholder="Route name"
                        className="w-full bg-route-bg border border-route-line rounded px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-route-accent transition-colors"
                      />
                      <div className="flex gap-2 mt-1">
                        <button
                          type="button"
                          onClick={() => setCreatingRoute(false)}
                          className="flex-1 rounded border border-route-line bg-route-bg hover:bg-neutral-800 text-neutral-300 font-medium px-3 py-1.5 text-xs transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!newRouteName.trim()) {
                              alert("Please enter a route name");
                              return;
                            }
                            setCreatingRouteSaving(true);
                            try {
                              const created = await createRoute(newRouteName);
                              setRoutes((prev) => [...prev, {
                                route_id: created.route_id,
                                route_name: created.route_name,
                                short_name: created.short_name,
                                vehicle_type: created.vehicle_type,
                                total_stops: created.total_stops,
                                approx_distance_km: created.approx_distance_km,
                                start_stop_id: created.start_stop_id,
                                end_stop_id: created.end_stop_id,
                              }]);
                              setSelectedRoute({
                                ...created,
                                stops: [],
                              });
                              setResult(null);
                              setAddingStop(false);
                              setShowSequence(true);
                              setCreatingRoute(false);
                              setNewRouteName("");
                            } catch (e) {
                              alert("Failed to create route: " + (e instanceof Error ? e.message : String(e)));
                            } finally {
                              setCreatingRouteSaving(false);
                            }
                          }}
                          disabled={creatingRouteSaving}
                          className="flex-1 rounded border border-route-accent bg-route-accent text-route-bg font-medium py-1.5 text-xs transition-colors cursor-pointer disabled:opacity-50"
                        >
                          Create
                        </button>
                      </div>
                    </div>
                  ) : (
                    ""
                  )}
                  {filteredRoutes.length > 0 && (
                    <ul className="flex flex-col gap-0.5 max-h-80 overflow-y-auto pr-1">
                      {filteredRoutes.map((r) => {
                        const isSelected = selectedRoute?.route_id === r.route_id;
                        return (
                          <li
                            key={r.route_id}
                            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors ${
                              isSelected
                                ? "bg-route-accent/20 border border-route-accent/40"
                                : "border border-transparent hover:bg-route-bg/60"
                            }`}
                          >
                            <button
                              type="button"
                              disabled={routeLoading}
                              onClick={() => handleSelectRoute(r.route_id)}
                              className={`flex-1 text-left truncate transition-colors cursor-pointer disabled:opacity-50 ${
                                isSelected ? "text-white font-medium" : "text-neutral-300 hover:text-white"
                              }`}
                              title={`${r.route_name} · ${r.total_stops} stops`}
                            >
                              {r.route_name}
                            </button>
                            <span className="shrink-0 text-neutral-600 tabular-nums">{r.total_stops}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {filteredRoutes.length === 0 && !routesLoading && (
                    <p className="text-xs text-neutral-500 text-center py-4">
                      {routeSearchQuery ? "No routes match your search." : "No routes loaded yet."}
                    </p>
                  )}
                </div>

                {routeLoading && (
                  <p className="text-xs text-route-accent">Loading route stops…</p>
                )}

                {/* Selected route detail */}
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

                {/* Drag-to-reorder stop sequence + Add / Remove stops */}
                {showSequence && selectedRoute && !routeLoading && (
                  <div className="flex flex-col gap-2 text-sm bg-route-panel rounded-md px-3 py-2">
                    <p className="text-xs uppercase tracking-wide text-neutral-400">
                      Bus stops in sequence ({selectedRoute.stops.length})
                    </p>
                    <ol className="flex flex-col gap-1 max-h-72 overflow-y-auto pr-1 pb-1">
                      {selectedRoute.stops.map((s, i) => (
                        <li 
                          key={`${s.stop_id}-${i}`}
                          draggable
                          onDragStart={(e) => handleDragStart(e, i)}
                          onDragOver={(e) => handleDragOver(e, i)}
                          onDrop={(e) => handleDrop(e, i)}
                          className={`flex items-center gap-2 text-neutral-300 group rounded-md p-1 cursor-grab active:cursor-grabbing transition-colors ${
                            dragOverStopIndex === i ? "bg-route-accent/20 border border-route-accent/50" : "hover:bg-route-bg/50 border border-transparent"
                          }`}
                        >
                          <svg className="w-4 h-4 text-neutral-500 shrink-0 opacity-50 group-hover:opacity-100" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="9" cy="12" r="1"/>
                            <circle cx="9" cy="5" r="1"/>
                            <circle cx="9" cy="19" r="1"/>
                            <circle cx="15" cy="12" r="1"/>
                            <circle cx="15" cy="5" r="1"/>
                            <circle cx="15" cy="19" r="1"/>
                          </svg>
                          <span className="text-neutral-500 w-6 shrink-0 text-right tabular-nums">
                            {i + 1}.
                          </span>
                          <span className="flex-1 truncate">{s.stop_name}</span>
                          <button
                            type="button"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteStopFromRoute(i + 1, s.stop_name);
                            }}
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
                      
                      {!addingStop ? (
                        <button
                          type="button"
                          onClick={() => setAddingStop(true)}
                          className="mt-2 flex items-center justify-center gap-1.5 rounded-md border border-dashed border-route-line hover:border-route-accent text-neutral-400 hover:text-white py-1.5 text-xs transition-colors cursor-pointer"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                          </svg>
                          Add stop
                        </button>
                      ) : (
                        <div className="mt-2 flex flex-col gap-2 p-2 bg-route-bg/50 border border-route-line rounded-md">
                          <p className="text-xs text-neutral-400">Select a stop to add to the end of the route (drag it later to reposition):</p>
                          <SearchableSelect
                            options={stops.map((s) => ({ value: s.stop_id, label: s.stop_name }))}
                            value=""
                            onChange={(val) => { if (val) handleAddStopToRoute(val); }}
                            placeholder="Search for a stop..."
                          />
                          <button
                            type="button"
                            onClick={() => setAddingStop(false)}
                            className="text-xs text-neutral-500 hover:text-white text-right"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </ol>
                  </div>
                )}
              </>
            )}

            {/* ── Edit Tab ── */}
            {activeTab === "edit" && (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditStopMode((m) => !m);
                    setAddStopMode(false);
                    setPendingNewStopCoords(null);
                    setEditingStop(null);
                    setDraftStop(null);
                    setStopMoveError(null);
                    setStopEditSuccess(null);
                  }}
                  className={`flex-1 rounded-md border font-medium py-2 text-sm transition-colors cursor-pointer ${
                    editStopMode
                      ? "bg-route-accent text-route-bg border-route-accent"
                      : "bg-route-bg border-route-line text-neutral-300 hover:border-route-accent hover:text-white"
                  }`}
                >
                  {editStopMode ? "Stop editing bus stop" : "Edit bus stop"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddStopMode((m) => {
                      if (m) setPendingNewStopCoords(null);
                      return !m;
                    });
                    setEditStopMode(false);
                    setEditingStop(null);
                    setDraftStop(null);
                    setStopMoveError(null);
                    setStopEditSuccess(null);
                  }}
                  className={`flex-1 rounded-md border font-medium py-2 text-sm transition-colors cursor-pointer ${
                    addStopMode
                      ? "bg-emerald-500 text-white border-emerald-500"
                      : "bg-route-bg border-route-line text-neutral-300 hover:border-emerald-400 hover:text-white"
                  }`}
                >
                  {addStopMode ? "Cancel adding stop" : "Add a bus stop"}
                </button>

                {editStopMode && (
                  <p className="text-xs text-route-accent">
                    Click a bus stop on the map, then drag the marker to its correct position.
                  </p>
                )}
                {addStopMode && !pendingNewStopCoords && (
                  <p className="text-xs text-emerald-400">
                    Click on the map to add a new bus stop.
                  </p>
                )}
                {pendingNewStopCoords && (
                  <div className="flex flex-col gap-2 bg-emerald-950/40 border border-emerald-900 rounded-md p-3">
                    <p className="text-xs text-emerald-400 font-medium">New stop coordinates: {pendingNewStopCoords.lat.toFixed(6)}, {pendingNewStopCoords.lng.toFixed(6)}</p>
                    <input
                      type="text"
                      autoFocus
                      placeholder="Enter bus stop name"
                      className="w-full bg-route-bg border border-route-line rounded px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-emerald-500 transition-colors"
                      value={pendingNewStopName}
                      onChange={(e) => setPendingNewStopName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleConfirmAddStop();
                        if (e.key === "Escape") handleCancelAddStop();
                      }}
                    />
                    {stopMoveError && <p className="text-xs text-red-400">{stopMoveError}</p>}
                    <div className="flex gap-2 mt-1">
                      <button
                        type="button"
                        onClick={handleConfirmAddStop}
                        disabled={stopMoveSaving || !pendingNewStopName.trim()}
                        className="flex-1 rounded border border-emerald-600 bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-1.5 text-xs disabled:opacity-50 transition-colors cursor-pointer"
                      >
                        {stopMoveSaving ? "Saving..." : "Save stop"}
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelAddStop}
                        className="rounded border border-route-line bg-route-bg hover:bg-neutral-800 text-neutral-300 font-medium px-3 py-1.5 text-xs transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {stopEditSuccess && (
                  <p className="text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-900 rounded-md px-3 py-2">
                    {stopEditSuccess}
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-md px-3 py-2">
                {error}
              </p>
            )}
          </aside>
        )}

        {/* Map Area */}
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
            addStopMode={addStopMode}
            onMapClickForAddStop={handleAddStopMapClick}
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

        </div>
      </div>
    </main>
  );
}