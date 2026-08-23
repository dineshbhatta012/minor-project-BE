"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import SearchForm from "@/components/SearchForm";
import SearchableSelect from "@/components/SearchableSelect";
import PlaceSearch from "@/components/PlaceSearch";
import { Place } from "@/lib/geocode";
import { fetchRouteDetail, fetchRoutes, fetchStops, removeStopFromRoute, searchRoute, updateStopCoordinates, updateRouteStops, createStop } from "@/lib/api";
import { enrichRouteWithRoadGeometry, getRoadPath } from "@/lib/osrm";
import { haversineMeters } from "@/lib/geo";
import { RouteDetail, RouteSearchResult, RouteSummary, Stop } from "@/types/route";
import type { LegWaypoints } from "@/components/BusMap";

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
  const [verifiedRoutes, setVerifiedRoutes] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("verifiedRoutes");
      return stored ? new Set<string>(JSON.parse(stored)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  });

  function toggleRouteVerified(routeId: string) {
    setVerifiedRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) {
        next.delete(routeId);
      } else {
        next.add(routeId);
      }
      try {
        localStorage.setItem("verifiedRoutes", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }
  const [showUnverifiedOnly, setShowUnverifiedOnly] = useState(false);
  const [editStopMode, setEditStopMode] = useState(false);
  const [addStopMode, setAddStopMode] = useState(false);
  const [editingStop, setEditingStop] = useState<Stop | null>(null);
  const [draftStop, setDraftStop] = useState<Stop | null>(null);
  const [stopMoveSaving, setStopMoveSaving] = useState(false);
  const [stopMoveError, setStopMoveError] = useState<string | null>(null);
  const [stopEditSuccess, setStopEditSuccess] = useState<string | null>(null);
  const [searchedPlace, setSearchedPlace] = useState<Place | null>(null);
  const [refreshingMap, setRefreshingMap] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // ── Edit-route state ──────────────────────────────────────────────────────
  const [editRouteMode, setEditRouteMode] = useState(false);
  // User-placed via waypoints for each leg (lat/lng tuples)
  const [legWaypoints, setLegWaypoints] = useState<LegWaypoints[]>([]);
  // The visually updated (re-routed) result while editing; null = no changes yet
  const [draftResult, setDraftResult] = useState<RouteSearchResult | null>(null);
  const [rerouteLoading, setRerouteLoading] = useState(false);
  const [rerouteError, setRerouteError] = useState<string | null>(null);
  // Debounce timer for OSRM re-route calls
  const rerouteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [waypointDeleteMode, setWaypointDeleteMode] = useState(false);
  const [selectedWaypointsToDelete, setSelectedWaypointsToDelete] = useState<{ legIndex: number; wpIndex: number }[]>([]);

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

  const [pendingNewStopCoords, setPendingNewStopCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [pendingNewStopName, setPendingNewStopName] = useState("");

  function handleAddStopMapClick(lat: number, lng: number) {
    setPendingNewStopCoords({ lat, lng });
    setPendingNewStopName("");
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

  // ── Edit-route handlers ────────────────────────────────────────────────────

  function handleToggleEditRoute() {
    if (editRouteMode) {
      // Leaving edit mode without saving → discard draft
      setEditRouteMode(false);
      setLegWaypoints([]);
      setDraftResult(null);
      setRerouteError(null);
      setWaypointDeleteMode(false);
      setSelectedWaypointsToDelete([]);
    } else {
      if (!result?.found) return; // nothing to edit
      setEditRouteMode(true);
      setLegWaypoints([]);
      setDraftResult(null);
      setRerouteError(null);
      setWaypointDeleteMode(false);
      setSelectedWaypointsToDelete([]);
    }
  }

  // Re-routes a single leg through its waypoints via OSRM and returns the
  // updated path.  Falls back to the original path on failure.
  async function rerouteLeg(
    legIndex: number,
    waypoints: [number, number][],
    baseResult: RouteSearchResult
  ): Promise<RouteSearchResult> {
    const leg = baseResult.legs[legIndex];
    const stopCoords: [number, number][] = leg.stopCoords ?? leg.path;

    // Build the full waypoint sequence: origin stop → user waypoints → dest stop
    const from = stopCoords[0];
    const to   = stopCoords[stopCoords.length - 1];
    const allPoints: [number, number][] = [from, ...waypoints, to];

    // Build road path through all points pairwise
    const segPromises = allPoints.slice(0, -1).map((pt, i) =>
      getRoadPath(pt[0], pt[1], allPoints[i + 1][0], allPoints[i + 1][1])
    );
    const segs = await Promise.all(segPromises);

    // Stitch segments, dropping duplicate junction points
    const stitched: [number, number][] = [];
    for (const seg of segs) {
      if (!seg || seg.length === 0) continue;
      const start = stitched.length > 0 ? 1 : 0;
      for (let j = start; j < seg.length; j++) stitched.push(seg[j]);
    }

    const newPath = stitched.length >= 2 ? stitched : leg.path;
    const updatedLegs = baseResult.legs.map((l, i) =>
      i === legIndex ? { ...l, path: newPath } : l
    );
    return { ...baseResult, legs: updatedLegs };
  }

  // Called by BusMap whenever a waypoint is added / moved / removed.
  // Debounces the OSRM call so rapid drags don't flood the API.
  const handleWaypointChange = useCallback(
    (legIndex: number, waypoints: [number, number][]) => {
      // Update stored waypoints immediately
      setLegWaypoints((prev) => {
        const next = prev.filter((lw) => lw.legIndex !== legIndex);
        if (waypoints.length > 0) next.push({ legIndex, waypoints });
        return next;
      });

      if (rerouteTimer.current) clearTimeout(rerouteTimer.current);
      rerouteTimer.current = setTimeout(async () => {
        const base = result;
        if (!base?.found) return;
        setRerouteLoading(true);
        setRerouteError(null);
        try {
          // Re-route the affected leg and merge into the current draft
          setDraftResult((prev) => {
            // We need async here, so we trigger the async work outside this setter
            return prev;
          });
          const currentDraft = draftResult ?? base;
          const updated = await rerouteLeg(legIndex, waypoints, currentDraft);
          setDraftResult(updated);
        } catch {
          setRerouteError("Couldn't re-route via OSRM. Check your connection.");
        } finally {
          setRerouteLoading(false);
        }
      }, 600);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, draftResult]
  );

  function handleWaypointSelectToggle(legIndex: number, wpIndex: number) {
    setSelectedWaypointsToDelete((prev) => {
      const exists = prev.find((w) => w.legIndex === legIndex && w.wpIndex === wpIndex);
      if (exists) {
        return prev.filter((w) => !(w.legIndex === legIndex && w.wpIndex === wpIndex));
      }
      return [...prev, { legIndex, wpIndex }];
    });
  }

  function handleConfirmDeleteSelectedWaypoints() {
    if (selectedWaypointsToDelete.length === 0) {
      setWaypointDeleteMode(false);
      return;
    }
    
    // Group deletions by leg
    const deletionsByLeg = new Map<number, number[]>();
    for (const { legIndex, wpIndex } of selectedWaypointsToDelete) {
      if (!deletionsByLeg.has(legIndex)) deletionsByLeg.set(legIndex, []);
      deletionsByLeg.get(legIndex)!.push(wpIndex);
    }
    
    // Process deletions for each leg
    for (const [legIndex, wpIndices] of Array.from(deletionsByLeg.entries())) {
      const currentWaypoints = legWaypoints.find((lw) => lw.legIndex === legIndex)?.waypoints || [];
      const updatedWaypoints = currentWaypoints.filter((_, idx) => !wpIndices.includes(idx));
      handleWaypointChange(legIndex, updatedWaypoints);
    }
    
    setWaypointDeleteMode(false);
    setSelectedWaypointsToDelete([]);
  }

  function handleSaveEditedRoute() {
    if (draftResult) {
      setResult(draftResult);
    }
    setEditRouteMode(false);
    setLegWaypoints([]);
    setDraftResult(null);
    setRerouteError(null);
    setWaypointDeleteMode(false);
    setSelectedWaypointsToDelete([]);
  }

  function handleCancelEditRoute() {
    setEditRouteMode(false);
    setLegWaypoints([]);
    setDraftResult(null);
    setRerouteError(null);
    setWaypointDeleteMode(false);
    setSelectedWaypointsToDelete([]);
  }

  function handleResetEditRoute() {
    setLegWaypoints([]);
    setDraftResult(null);
    setRerouteError(null);
    setWaypointDeleteMode(false);
    setSelectedWaypointsToDelete([]);
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

  const [draggedStopIndex, setDraggedStopIndex] = useState<number | null>(null);
  const [dragOverStopIndex, setDragOverStopIndex] = useState<number | null>(null);
  const [addingStop, setAddingStop] = useState(false);

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
          <div className="flex gap-2">
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
          </div>
          {editStopMode && (
            <p className="text-xs text-route-accent">
              Click a bus stop on the map, then drag the marker to its correct position.
            </p>
          )}
          {addStopMode && !pendingNewStopCoords && (
            <p className="text-xs text-emerald-400">
              Click on the map to add at this point.
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

        {/* ── Edit Route button ── */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleToggleEditRoute}
            disabled={!result?.found && !editRouteMode}
            title={!result?.found ? "Search for a route first" : undefined}
            className={`rounded-md border font-medium py-2 text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              editRouteMode
                ? "bg-orange-500 text-white border-orange-500"
                : "bg-route-bg border-route-line text-neutral-300 hover:border-orange-400 hover:text-white"
            }`}
          >
            {editRouteMode ? "Exit route editing" : "Edit route"}
          </button>
          {editRouteMode && (
            <p className="text-xs text-orange-400">
              Drag the <span className="font-semibold">small dots</span> on the coloured path to reroute it. Double-click a waypoint to remove it.
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
            {/* Category tabs */}
            <div className="flex gap-1.5">
              {routeGroups.map((group) => {
                const verified = group.routes.filter((r) => verifiedRoutes.has(r.route_id)).length;
                return (
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
                    {verified > 0 && (
                      <span className="ml-1 text-emerald-400">✓{verified}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Route list with checkboxes */}
            {(() => {
              const activeGroup = routeGroups.find((g) => g.name === activeCategory)!;
              const verifiedCount = activeGroup.routes.filter((r) => verifiedRoutes.has(r.route_id)).length;
              const unverifiedCount = activeGroup.routes.length - verifiedCount;
              const displayRoutes = showUnverifiedOnly
                ? activeGroup.routes.filter((r) => !verifiedRoutes.has(r.route_id))
                : activeGroup.routes;
              return (
                <div className="flex flex-col gap-1">
                  {/* Progress bar + filter toggle */}
                  <div className="flex items-center justify-between px-1 gap-2">
                    <button
                      type="button"
                      onClick={() => setShowUnverifiedOnly((v) => !v)}
                      className={`flex items-center gap-1.5 text-xs font-medium rounded px-2 py-0.5 border transition-colors cursor-pointer ${
                        showUnverifiedOnly
                          ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                          : "bg-route-bg border-route-line text-neutral-400 hover:border-amber-400 hover:text-amber-300"
                      }`}
                      title={showUnverifiedOnly ? "Show all routes" : "Show only unverified routes"}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      {showUnverifiedOnly ? `Unverified (${unverifiedCount})` : `${verifiedCount}/${activeGroup.routes.length} verified`}
                    </button>
                    <div className="flex-1 h-1.5 rounded-full bg-route-line overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all"
                        style={{ width: activeGroup.routes.length > 0 ? `${(verifiedCount / activeGroup.routes.length) * 100}%` : "0%" }}
                      />
                    </div>
                  </div>
                  <ul className="flex flex-col gap-0.5 max-h-64 overflow-y-auto pr-1">
                    {displayRoutes.length === 0 ? (
                      <li className="text-xs text-emerald-400 text-center py-3 opacity-70">
                        ✓ All routes in this section are verified!
                      </li>
                    ) : (
                      displayRoutes.map((r) => {
                        const isVerified = verifiedRoutes.has(r.route_id);
                        const isSelected = selectedRoute?.route_id === r.route_id;
                        return (
                          <li
                            key={r.route_id}
                            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors group ${
                              isSelected
                                ? "bg-route-accent/20 border border-route-accent/40"
                                : "border border-transparent hover:bg-route-bg/60"
                            }`}
                          >
                            {/* Verification checkbox */}
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); toggleRouteVerified(r.route_id); }}
                              title={isVerified ? "Mark as unverified" : "Mark as verified"}
                              className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors cursor-pointer ${
                                isVerified
                                  ? "bg-emerald-500 border-emerald-500 text-white"
                                  : "bg-route-bg border-route-line text-transparent hover:border-emerald-400"
                              }`}
                            >
                              {isVerified && (
                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              )}
                            </button>
                            {/* Route name — click to load */}
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
                      })
                    )}
                  </ul>
                </div>
              );
            })()}


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
          result={editRouteMode && draftResult ? draftResult : result}
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
          editRouteMode={editRouteMode}
          legWaypoints={legWaypoints}
          onWaypointChange={handleWaypointChange}
          waypointDeleteMode={waypointDeleteMode}
          selectedWaypoints={selectedWaypointsToDelete}
          onWaypointSelectToggle={handleWaypointSelectToggle}
          addStopMode={addStopMode}
          onMapClickForAddStop={handleAddStopMapClick}
        />

        {/* ── Edit-route floating control panel ── */}
        {editRouteMode && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1100] w-[min(92%,28rem)] rounded-xl bg-route-panel border border-orange-500/50 shadow-2xl p-4 flex flex-col gap-3">
            {/* Header */}
            <div className="flex items-center gap-2">
              {/* Pencil icon */}
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              <p className="text-sm font-semibold text-orange-400">Edit Route</p>
              {rerouteLoading && (
                <span className="ml-auto text-xs text-neutral-400 animate-pulse">Re-routing…</span>
              )}
              {!rerouteLoading && draftResult && (
                <span className="ml-auto text-xs text-emerald-400">✓ Route updated</span>
              )}
            </div>

            {/* Instruction */}
            <p className="text-xs text-neutral-400 leading-relaxed">
              {waypointDeleteMode 
                ? "Click the waypoints you want to remove, then click Delete Selected."
                : <>Drag the <span className="text-orange-300 font-medium">small dots</span> on the coloured path to reroute it along a different road. Double-click a waypoint to remove it.</>}
            </p>

            {rerouteError && (
              <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded-md px-2 py-1.5">
                {rerouteError}
              </p>
            )}

            {/* Action buttons */}
            {!waypointDeleteMode ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveEditedRoute}
                  disabled={!draftResult || rerouteLoading}
                  className="flex-1 rounded-md bg-orange-500 hover:bg-orange-400 text-white font-semibold py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  Save route
                </button>
                <button
                  type="button"
                  onClick={() => setWaypointDeleteMode(true)}
                  disabled={legWaypoints.length === 0 || rerouteLoading}
                  className="rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-red-400 hover:text-red-300 font-medium px-3 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="Select waypoints to delete"
                >
                  Delete waypoints
                </button>
                <button
                  type="button"
                  onClick={handleResetEditRoute}
                  disabled={legWaypoints.length === 0 || rerouteLoading}
                  className="rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-orange-400 hover:text-white font-medium px-3 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  title="Reset waypoints"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={handleCancelEditRoute}
                  className="rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-red-400 hover:text-red-300 font-medium px-3 py-2 text-sm transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleConfirmDeleteSelectedWaypoints}
                  className="flex-1 rounded-md bg-red-500 hover:bg-red-400 text-white font-semibold py-2 text-sm transition-colors cursor-pointer"
                >
                  Delete selected ({selectedWaypointsToDelete.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWaypointDeleteMode(false);
                    setSelectedWaypointsToDelete([]);
                  }}
                  className="rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-red-400 hover:text-red-300 font-medium px-3 py-2 text-sm transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

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
