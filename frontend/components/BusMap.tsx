"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { RouteSearchResult, Stop } from "@/types/route";
import { Place } from "@/lib/geocode";

// Kathmandu Valley center, used as the default map view.
const VALLEY_CENTER: [number, number] = [27.7041, 85.32];

const LEG_COLORS = ["#3f4058", "#9696b5", "#c49f3b", "#6f9670"];

// Build a Leaflet divIcon that renders bus-icon.png clipped to a circle
// with a coloured border ring to distinguish stop types.
function makeBusStopIcon(size: number, borderColor: string): L.DivIcon {
  const border = Math.max(2, Math.round(size / 8));
  const outer = size + border * 2;
  return L.divIcon({
    html: `<div style="width:${outer}px;height:${outer}px;border-radius:50%;border:${border}px solid ${borderColor};overflow:hidden;display:flex;align-items:center;justify-content:center;background:${borderColor};">
             <img src="/bus-icon.png" style="width:${size}px;height:${size}px;border-radius:50%;display:block;" />
           </div>`,
    className: "",           // prevent leaflet's default white-box styling
    iconSize: [outer, outer],
    iconAnchor: [outer / 2, outer / 2],
    tooltipAnchor: [0, -outer / 2],
  });
}

// A small circular handle rendered on polyline midpoints in edit-route mode.
function makeWaypointHandle(color: string, isExisting = false, isSelected = false): L.DivIcon {
  const size = isExisting ? (isSelected ? 16 : 14) : 10;
  const ring = isExisting ? 3 : 2;
  const outer = size + ring * 2;
  const bg = isSelected ? "#777776" : color;
  const borderCol = isSelected ? "#ECECEB" : "#fff";
  return L.divIcon({
    html: `<div style="width:${outer}px;height:${outer}px;border-radius:50%;background:${bg};border:${ring}px solid ${borderCol};box-shadow:0 1px 4px rgba(0,0,0,0.5);${isExisting && !isSelected ? 'cursor:grab;' : 'cursor:pointer;'}"></div>`,
    className: "",
    iconSize: [outer, outer],
    iconAnchor: [outer / 2, outer / 2],
  });
}

// Pre-built bus icons for each stop role (different sizes & colours)
const BUS_ICON_ORIGIN      = makeBusStopIcon(28, "#5E5E5D");
const BUS_ICON_DESTINATION = makeBusStopIcon(28, "#777776");
const BUS_ICON_MAJOR       = makeBusStopIcon(22, "#999998");
const BUS_ICON_DEFAULT     = makeBusStopIcon(16, "#B8B8B7");
const BUS_ICON_NEAREST     = makeBusStopIcon(32, "#5E5E5D");

// Large neutral-ringed bus icon for the stop currently being re-positioned by
// drag & drop while in "Edit bus stop" mode.
const BUS_ICON_EDIT = makeBusStopIcon(32, "#777776");

const USER_LOCATION_ICON = L.divIcon({
  className: "",
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#777776;border:3px solid #fff;box-shadow:0 0 0 3px rgba(119,119,118,0.4);"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

const PLACE_PIN_ICON = L.divIcon({
  className: "",
  html: `<div style="position:relative;width:28px;height:34px;">
    <div style="position:absolute;left:4px;top:0;width:20px;height:20px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#777776;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>
    <div style="position:absolute;left:9px;top:5px;width:10px;height:10px;border-radius:50%;background:#fff;"></div>
  </div>`,
  iconSize: [28, 34],
  iconAnchor: [14, 32],
  tooltipAnchor: [0, -30],
});

// Matches a route-path coordinate back to the nearest known stop (within
// ~10 m) so path markers can show stop names in their tooltips.
function findStop(lat: number, lng: number, stops: Stop[]): Stop | undefined {
  let best: Stop | undefined;
  let bestDist = Infinity;
  for (const s of stops) {
    const d = (s.lat - lat) ** 2 + (s.lng - lng) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best && Math.sqrt(bestDist) < 0.0001 ? best : undefined;
}

// Compute the geographic midpoint between two [lat,lng] coordinates.
function midpoint(a: [number, number], b: [number, number]): [number, number] {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// ─── Waypoint state per leg ───────────────────────────────────────────────────
// In edit-route mode we track user-placed waypoints for each leg independently.
// A waypoint is a [lat,lng] tuple manually inserted by dragging.

export interface LegWaypoints {
  legIndex: number;
  waypoints: [number, number][];
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface BusMapProps {
  result?: RouteSearchResult | null;
  stops: Stop[];
  originName: string;
  destinationName: string;
  mapSelectionMode: "from" | "to" | null;
  onSelectStop: (stop: Stop, type: "from" | "to") => void;
  userLocation?: { lat: number; lng: number } | null;
  focusStop?: Stop | null;
  walkPath?: [number, number][] | null;
  editStopMode?: boolean;
  onSelectStopForEdit?: (stop: Stop) => void;
  editingStop?: Stop | null;
  onStopDragged?: (stop: Stop, lat: number, lng: number) => void;
  place?: Place | null;
  // Edit-route mode
  editRouteMode?: boolean;
  legWaypoints?: LegWaypoints[];        // current waypoints per leg
  onWaypointChange?: (legIndex: number, waypoints: [number, number][]) => void;
  waypointDeleteMode?: boolean;
  selectedWaypoints?: { legIndex: number; wpIndex: number }[];
  onWaypointSelectToggle?: (legIndex: number, wpIndex: number) => void;
  // Add stop mode
  addStopMode?: boolean;
  onMapClickForAddStop?: (lat: number, lng: number) => void;
}

// ─── Map-child helpers ────────────────────────────────────────────────────────

// Keeps the map centered on the stop being edited instead of zooming out.
function FitBoundsIfNotEditing({ result, editStopMode }: { result?: RouteSearchResult | null; editStopMode?: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (editStopMode) return;
    if (!result?.found || !result.legs.length) return;
    const points = result.legs.flatMap((leg) => leg.path);
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points.map(([lat, lng]) => [lat, lng])));
    }
  }, [result, map]);
  return null;
}

// Flies the map to the stop currently being edited whenever it changes.
function FlyToEditingStop({ editingStop }: { editingStop?: Stop | null }) {
  const map = useMap();
  useEffect(() => {
    if (editingStop) {
      map.flyTo([editingStop.lat, editingStop.lng], map.getZoom(), { duration: 1.2 });
    }
  }, [editingStop, map]);
  return null;
}

// Flies the map to a target point whenever it changes (e.g. after picking
// "Your location" or searching for a place).
function FlyTo({ target, zoom = 16 }: { target?: [number, number] | null; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      map.flyTo(target, zoom, { duration: 1.2 });
    }
  }, [target, zoom, map]);
  return null;
}

// Disables map dragging while we are dragging a waypoint handle so the
// underlying map doesn't pan at the same time.
function MapDragController({ disabled }: { disabled: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (disabled) {
      map.dragging.disable();
    } else {
      map.dragging.enable();
    }
  }, [disabled, map]);
  return null;
}

function MapClickHandler({ 
  addStopMode, 
  onMapClickForAddStop 
}: { 
  addStopMode?: boolean; 
  onMapClickForAddStop?: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (addStopMode && onMapClickForAddStop) {
        onMapClickForAddStop(e.latlng.lat, e.latlng.lng);
      }
    }
  });
  return null;
}

// ─── Waypoint context menu ────────────────────────────────────────────────────

interface WaypointContextMenuProps {
  x: number;
  y: number;
  onDelete: () => void;
  onClose: () => void;
}

function WaypointContextMenu({ x, y, onDelete, onClose }: WaypointContextMenuProps) {
  // Dismiss on outside click
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("click", handler, { once: true });
    return () => window.removeEventListener("click", handler);
  }, [onClose]);

  const menu = (
    <div
      style={{
        position: "fixed",
        top: y,
        left: x,
        zIndex: 9999,
        background: "linear-gradient(135deg, #ECECEB 0%, #DEDEDD 100%)",
        border: "1px solid #C4C4C3",
        borderRadius: 8,
        boxShadow: "0 4px 16px rgba(0,0,0,0.45)",
        minWidth: 160,
        overflow: "hidden",
        userSelect: "none",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          padding: "6px 10px",
          fontSize: 11,
          color: "#000000",
          borderBottom: "1px solid #C4C4C3",
          letterSpacing: "0.05em",
          textTransform: "uppercase",
        }}
      >
        Waypoint
      </div>
      <button
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "9px 14px",
          background: "transparent",
          border: "none",
          color: "#000000",
          fontSize: 13,
          cursor: "pointer",
          textAlign: "left",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#C4C4C355")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        onClick={() => { onDelete(); onClose(); }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6M14 11v6" />
          <path d="M9 6V4h6v2" />
        </svg>
        Delete waypoint
      </button>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(menu, document.body) : null;
}

// ─── Waypoint handles rendered on a single leg ────────────────────────────────

interface LegRouteEditorProps {
  legIndex: number;
  path: [number, number][];        // current (OSRM-enriched) displayed path
  color: string;
  waypoints: [number, number][];   // user-placed waypoints for this leg
  onWaypointChange: (legIndex: number, waypoints: [number, number][]) => void;
  onDragging: (dragging: boolean) => void;
  waypointDeleteMode?: boolean;
  selectedWaypoints?: number[];
  onWaypointSelectToggle?: (legIndex: number, wpIndex: number) => void;
}

function LegRouteEditor({
  legIndex,
  path,
  color,
  waypoints,
  onWaypointChange,
  onDragging,
  waypointDeleteMode = false,
  selectedWaypoints = [],
  onWaypointSelectToggle,
}: LegRouteEditorProps) {
  // Context menu state: null = hidden; otherwise {x,y,wi} of the right-clicked waypoint.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; wi: number } | null>(null);

  // We show a midpoint "ghost handle" between every consecutive pair in the
  // displayed path (which may have hundreds of points from OSRM).
  // To avoid rendering thousands of markers we sample: show one handle per
  // segment of the *stop-to-stop* sub-path. Since stopCoords are in the
  // parent we use the full path but only draw handles every ~N points.
  const SAMPLE_STEP = Math.max(1, Math.floor(path.length / 20)); // ~20 handles max

  const ghostHandles: [number, number][] = [];
  for (let i = 0; i + SAMPLE_STEP < path.length; i += SAMPLE_STEP) {
    ghostHandles.push(midpoint(path[i], path[i + SAMPLE_STEP]));
  }

  const ghostIcon = makeWaypointHandle(color, false);

  return (
    <>
      {/* Context menu (portal) — shown after right-clicking a waypoint */}
      {ctxMenu && !waypointDeleteMode && (
        <WaypointContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onDelete={() => onWaypointChange(legIndex, waypoints.filter((_, idx) => idx !== ctxMenu.wi))}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Ghost midpoint handles — drag to insert a new waypoint */}
      {!waypointDeleteMode && ghostHandles.map((pos, hi) => (
        <Marker
          key={`ghost-${legIndex}-${hi}`}
          position={pos}
          icon={ghostIcon}
          draggable
          eventHandlers={{
            dragstart: () => onDragging(true),
            dragend: (e) => {
              onDragging(false);
              const latlng = (e.target as L.Marker).getLatLng();
              const newWp: [number, number] = [latlng.lat, latlng.lng];
              // Insert the waypoint in geographic order: find the segment of
              // the current path closest to the drag-end point and insert
              // after the nearest existing waypoint anchor.
              onWaypointChange(legIndex, [...waypoints, newWp]);
            },
          }}
        >
          <Tooltip direction="top" offset={[0, -6]} opacity={0.85}>
            <span className="text-xs">Drag to reroute</span>
          </Tooltip>
        </Marker>
      ))}

      {/* Existing user-placed waypoints — draggable to reposition */}
      {waypoints.map((wp, wi) => {
        const isSelected = selectedWaypoints.includes(wi);
        const existingIcon = makeWaypointHandle(color, true, isSelected);

        return (
          <Marker
            key={`wp-${legIndex}-${wi}`}
            position={wp}
            icon={existingIcon}
            draggable={!waypointDeleteMode}
            eventHandlers={{
              click: () => {
                if (waypointDeleteMode) {
                  onWaypointSelectToggle?.(legIndex, wi);
                }
              },
              dragstart: () => {
                if (!waypointDeleteMode) onDragging(true);
              },
              dragend: (e) => {
                if (waypointDeleteMode) return;
                onDragging(false);
                const latlng = (e.target as L.Marker).getLatLng();
                const updated = waypoints.map((w, idx) =>
                  idx === wi ? ([latlng.lat, latlng.lng] as [number, number]) : w
                );
                onWaypointChange(legIndex, updated);
              },
              dblclick: () => {
                if (waypointDeleteMode) return;
                // Double-click still removes the waypoint
                onWaypointChange(legIndex, waypoints.filter((_, idx) => idx !== wi));
              },
              contextmenu: (e) => {
                if (waypointDeleteMode) return;
                // Right-click: show the delete context menu
                const domEvent = (e as unknown as { originalEvent: MouseEvent }).originalEvent;
                domEvent.preventDefault();
                domEvent.stopPropagation();
                setCtxMenu({ x: domEvent.clientX, y: domEvent.clientY, wi });
              },
            }}
          >
            <Tooltip direction="top" offset={[0, -8]} opacity={0.85}>
              <span className="text-xs">
                {waypointDeleteMode 
                  ? (isSelected ? "Click to deselect" : "Click to select for deletion")
                  : "Drag to move · right-click to delete"}
              </span>
            </Tooltip>
          </Marker>
        );
      })}
    </>
  );
}

// ─── Main BusMap component ────────────────────────────────────────────────────

export default function BusMap({
  result,
  stops,
  originName,
  destinationName,
  mapSelectionMode,
  onSelectStop,
  userLocation,
  focusStop,
  walkPath,
  editStopMode,
  onSelectStopForEdit,
  editingStop,
  onStopDragged,
  place,
  editRouteMode = false,
  legWaypoints = [],
  onWaypointChange,
  waypointDeleteMode = false,
  selectedWaypoints = [],
  onWaypointSelectToggle,
  addStopMode = false,
  onMapClickForAddStop,
}: BusMapProps) {
  const selecting = mapSelectionMode !== null || editStopMode === true;
  const originStop = stops.find((s) => s.stop_name === originName);
  const destinationStop = stops.find((s) => s.stop_name === destinationName);

  // Track whether the user is currently dragging a waypoint handle so we can
  // disable map panning during the drag.
  const draggingWaypoint = useRef(false);

  const handleDragging = useCallback((d: boolean) => {
    draggingWaypoint.current = d;
  }, []);

  function getWaypointsForLeg(legIndex: number): [number, number][] {
    return legWaypoints.find((lw) => lw.legIndex === legIndex)?.waypoints ?? [];
  }

  function pickIcon(stop: Stop) {
    if (stop.stop_id === focusStop?.stop_id) return BUS_ICON_NEAREST;
    if (stop.stop_id === originStop?.stop_id) return BUS_ICON_ORIGIN;
    if (stop.stop_id === destinationStop?.stop_id) return BUS_ICON_DESTINATION;
    if (stop.is_major_stop || stop.is_interchange) return BUS_ICON_MAJOR;
    return BUS_ICON_DEFAULT;
  }

  function stopMarker(stop: Stop, interactive: boolean) {
    return (
      <Marker
        key={stop.stop_id}
        position={[stop.lat, stop.lng]}
        icon={pickIcon(stop)}
        eventHandlers={
          interactive
            ? {
                click: () => {
                  if (editStopMode) {
                    onSelectStopForEdit?.(stop);
                  } else {
                    onSelectStop(stop, mapSelectionMode!);
                  }
                },
              }
            : undefined
        }
      >
        <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
          <span className="font-medium text-xs">
            {stop.stop_id === focusStop?.stop_id
              ? `Your nearest stop — ${stop.stop_name}`
              : editStopMode
                ? `Click to edit — ${stop.stop_name}`
                : stop.stop_name}
          </span>
        </Tooltip>
      </Marker>
    );
  }

  return (
    <MapContainer
      center={VALLEY_CENTER}
      zoom={12}
      scrollWheelZoom
      style={{ height: "100%", width: "100%", cursor: addStopMode ? "crosshair" : undefined }}
    >
      <MapClickHandler addStopMode={addStopMode} onMapClickForAddStop={onMapClickForAddStop} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <FitBoundsIfNotEditing result={result} editStopMode={editStopMode} />

      <FlyToEditingStop editingStop={editingStop} />

      <FlyTo target={focusStop ? [focusStop.lat, focusStop.lng] : null} />

      {/* Searched place pin */}
      {place && (
        <FlyTo target={[place.lat, place.lng]} zoom={16} />
      )}
      {place && (
        <Marker position={[place.lat, place.lng]} icon={PLACE_PIN_ICON}>
          <Tooltip direction="top" offset={[0, -30]} opacity={0.9}>
            <span className="font-medium text-xs">{place.name}</span>
          </Tooltip>
        </Marker>
      )}

      {/* Walking path from your location to the nearest stop (thin, dotted) */}
      {walkPath && walkPath.length >= 2 && (
        <Polyline
          positions={walkPath}
          pathOptions={{ color: "#3f4058", weight: 3, dashArray: "2 6", opacity: 0.9 }}
        />
      )}

      {/* The user's current location (after clicking "Your location") */}
      {userLocation && (
        <Marker position={[userLocation.lat, userLocation.lng]} icon={USER_LOCATION_ICON}>
          <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
            <span className="font-medium text-xs">Your location</span>
          </Tooltip>
        </Marker>
      )}

      {/* Bus icons are shown while choosing from/to or editing on the map,
          so the user can pick a new stop even if a route is currently displayed. */}
      {selecting &&
        stops
          .filter((stop) => stop.stop_id !== editingStop?.stop_id)
          .map((stop) => stopMarker(stop, true))}

      {/* The stop being re-positioned: a larger, draggable marker */}
      {editingStop && (
        <Marker
          position={[editingStop.lat, editingStop.lng]}
          icon={BUS_ICON_EDIT}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const pos = (e.target as L.Marker).getLatLng();
              onStopDragged?.(editingStop, pos.lat, pos.lng);
            },
          }}
        >
          <Tooltip direction="top" offset={[0, -8]} opacity={0.9}>
            <span className="font-medium text-xs">
              Drag me to the correct position — {editingStop.stop_name}
            </span>
          </Tooltip>
        </Marker>
      )}

      {/* Selected stops are still visible when no route is shown */}
      {!selecting && !result && originStop && stopMarker(originStop, false)}
      {!selecting && !result && destinationStop && stopMarker(destinationStop, false)}

      {result?.legs.map((leg, i) => {
        const color = LEG_COLORS[i % LEG_COLORS.length];
        const legStopIcon = makeBusStopIcon(18, color);
        const isLastLeg = i === result.legs.length - 1;
        // Use original stop coordinates for markers (falls back to path
        // when stopCoords hasn't been set, e.g. before OSRM enrichment).
        const markerCoords = leg.stopCoords ?? leg.path;
        const wps = getWaypointsForLeg(i);

        const isWalk = leg.route_id === "walk";

        return (
          <Fragment key={`${leg.route_id}-${i}`}>
            {/* Outline Polyline to make the route easily recognized */}
            <Polyline
              positions={leg.path}
              pathOptions={{ color: "#3f4058", weight: isWalk ? 0 : 12, opacity: 0.45 }}
            />
            {/* Main colored Polyline following actual road geometry */}
            <Polyline
              positions={leg.path}
              pathOptions={{ 
                color: isWalk ? "#3f4058" : color, 
                weight: isWalk ? 5 : 7,
                dashArray: isWalk ? "5 10" : undefined 
              }}
            />

            {/* Draggable waypoint handles — only in edit-route mode */}
            {editRouteMode && onWaypointChange && (
              <LegRouteEditor
                legIndex={i}
                path={leg.path}
                color={color}
                waypoints={wps}
                onWaypointChange={onWaypointChange}
                onDragging={handleDragging}
                waypointDeleteMode={waypointDeleteMode}
                selectedWaypoints={
                  selectedWaypoints
                    ?.filter((sw) => sw.legIndex === i)
                    .map((sw) => sw.wpIndex)
                }
                onWaypointSelectToggle={onWaypointSelectToggle}
              />
            )}

            {/* Bus icon at every stop along the route */}
            {markerCoords.map(([lat, lng], j) => {
              const stop = findStop(lat, lng, stops);
              const isRouteStart = i === 0 && j === 0;
              const isRouteEnd = isLastLeg && j === markerCoords.length - 1;
              const icon = isRouteStart
                ? BUS_ICON_ORIGIN
                : isRouteEnd
                  ? BUS_ICON_DESTINATION
                  : legStopIcon;
              return (
                <Marker key={`${leg.route_id}-${j}`} position={[lat, lng]} icon={icon}>
                  {stop && (
                    <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
                      <span className="font-medium text-xs">{stop.stop_name}</span>
                    </Tooltip>
                  )}
                </Marker>
              );
            })}
          </Fragment>
        );
      })}
    </MapContainer>
  );
}
