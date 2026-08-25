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

  // Geolocation state
  const [myLocation, setMyLocation] = useState<{
    lat: number;
    lng: number;
    stop: Stop;
    walkMeters: number;
    walkPath: [number, number][];
  } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  // Load stops and routes on mount
  useEffect(() => {
    fetchStops()
      .then(setStops)
      .catch(() =>
        setStopsError(
          "Couldn't reach the backend. Is it running at NEXT_PUBLIC_API_URL (default http://localhost:8000)?"
        )
      )
      .finally(() => setStopsLoading(false));

    setRoutesLoading(true);
    setRoutesError(null);
    fetchRoutes()
      .then(setRoutes)
      .catch(() => setRoutesError("Couldn't load the route list."))
      .finally(() => setRoutesLoading(false));
  }, []);

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

    // Reset any temporary interactive modes when switching tabs
    if (tab !== "edit") {
      setEditStopMode(false);
      setAddStopMode(false);
      setEditingStop(null);
      setDraftStop(null);
      setPendingNewStopCoords(null);
      setStopMoveError(null);
    }
    if (tab !== "navigate") {
      setMapSelectionMode(null);
    }
  }

  // Helper to build a RouteSearchResult from a RouteDetail
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

  // Refresh map data
  async function handleRefreshMap() {
    setRefreshingMap(true);
    setRefreshError(null);
    try {
      const freshStops = await fetchStops();
      setStops(freshStops);
      const freshRoutes = await fetchRoutes();
      setRoutes(freshRoutes);

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

  // ── Navigate handlers ───────────────────────────────────────────────────────

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

  async function handleSearch(originStopId: string, destinationStopId: string) {
    setLoading(true);
    setError(null);
    setSelectedRoute(null);
    try {
      const data = await searchRoute({
        origin_stop_id: originStopId,
        destination_stop_id: destinationStopId,
      });
      const enriched = await enrichRouteWithRoadGeometry(data);
      setResult(enriched);
    } catch {
      setError("Something went wrong searching for a route. Try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Routes section handlers ─────────────────────────────────────────────────

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
      await handleSelectRoute(selectedRoute.route_id);
      setShowSequence(true);
    } catch {
      setError("Couldn't remove that stop from the route.");
    }
  }

  // ── Edit stop handlers ──────────────────────────────────────────────────────

  function handleSelectStopForEdit(stop: Stop) {
    setEditingStop(stop);
    setDraftStop(null);
    setStopMoveError(null);
    setStopEditSuccess(null);
  }

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

        {/* Right side status & refresh */}
        <div className="flex items-center gap-3">
          {stops.length > 0 && (
            <span className="text-xs text-neutral-400 hidden sm:inline">
              {stops.length} stops
            </span>
          )}
          <button
            type="button"
            onClick={handleRefreshMap}
            disabled={refreshingMap}
            title="Refresh map & data"
            className="flex items-center gap-1.5 rounded-md bg-route-bg border border-route-line px-2.5 py-1.5 text-xs text-neutral-300 hover:border-route-accent hover:text-white disabled:opacity-50 transition-colors cursor-pointer"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="13"
              height="13"
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
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </header>

      {/* ── Main Body: Sidebar + Map ── */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Side Panel (Collapsible) */}
        {isPanelOpen && (
          <aside className="w-full max-w-sm flex flex-col gap-4 p-4 overflow-y-auto border-r border-route-line bg-route-bg/95 shrink-0 z-10">
            {stopsError && (
                <>
                  <p className="text-sm font-medium text-white">{editingStop.stop_name}</p>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    New coordinates: {draftStop.lat.toFixed(6)}, {draftStop.lng.toFixed(6)}
                  </p>
                  {stopMoveError && <p className="text-xs text-red-400 mt-2">{stopMoveError}</p>}
                  <div className="flex gap-2 mt-3">
                    <button
                      type="button"
                      onClick={handleSaveStopMove}
                      disabled={stopMoveSaving}
                      className="flex-1 rounded-md bg-route-accent text-route-bg font-semibold py-2 text-xs disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      {stopMoveSaving ? "Saving…" : "Save new position"}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelStopMove}
                      disabled={stopMoveSaving}
                      className="flex-1 rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-route-accent hover:text-white font-medium py-2 text-xs transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-neutral-300 leading-relaxed">
                  Drag the <span className="text-fuchsia-400 font-medium">violet marker</span> on the map to reposition <span className="font-medium text-white">{editingStop.stop_name}</span>.
                </p>
              )}
            </div>
          )}

          {refreshError && (
            <div className="absolute top-4 right-4 z-[1100] max-w-[260px] rounded-md bg-red-950/90 border border-red-900 px-3 py-2 text-xs text-red-300 shadow-lg">
              {refreshError}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
