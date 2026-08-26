"use client";

import { Fragment, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { RouteSearchResult, Stop } from "@/types/route";

// Kathmandu Valley center, used as the default map view.
const VALLEY_CENTER: [number, number] = [27.7041, 85.32];

const LEG_COLORS = ["#059669", "#2563eb", "#dc2626", "#7c3aed"];

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

// Pre-built bus icons for each stop role (different sizes & colours)
const BUS_ICON_ORIGIN      = makeBusStopIcon(28, "#3DDC97");  // Green — origin
const BUS_ICON_DESTINATION = makeBusStopIcon(28, "#F2A93B");  // Amber — destination
const BUS_ICON_MAJOR       = makeBusStopIcon(22, "#5DA9E9");  // Blue — major / interchange
const BUS_ICON_DEFAULT     = makeBusStopIcon(16, "#94a3b8");  // Slate — regular stop
const BUS_ICON_NEAREST     = makeBusStopIcon(32, "#2563eb");  // Blue ring — nearest stop to your location

// Large violet-ringed bus icon for the stop currently being re-positioned by
// drag & drop while in "Edit bus stop" mode.
const BUS_ICON_EDIT = makeBusStopIcon(32, "#a855f7");

const USER_LOCATION_ICON = L.divIcon({
  className: "",
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#3b82f6;border:3px solid #fff;box-shadow:0 0 0 3px rgba(59,130,246,0.4);"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
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
  }, [result, editStopMode, map]);
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
// "Your location").
function FlyTo({ target, zoom = 16 }: { target?: [number, number] | null; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      map.flyTo(target, zoom, { duration: 1.2 });
    }
  }, [target, zoom, map]);
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
  addStopMode = false,
  onMapClickForAddStop,
}: BusMapProps) {
  const selecting = mapSelectionMode !== null || editStopMode === true;
  const originStop = stops.find((s) => s.stop_name === originName);
  const destinationStop = stops.find((s) => s.stop_name === destinationName);

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

      {/* Walking path from your location to the nearest stop (thin, dotted) */}
      {walkPath && walkPath.length >= 2 && (
        <Polyline
          positions={walkPath}
          pathOptions={{ color: "#64748b", weight: 3, dashArray: "2 6", opacity: 0.9 }}
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

        const isWalk = leg.route_id === "walk";

        return (
          <Fragment key={`${leg.route_id}-${i}`}>
            {/* Outline Polyline to make the route easily recognized */}
            <Polyline
              positions={leg.path}
              pathOptions={{ color: isWalk ? "#64748b" : "#0f172a", weight: isWalk ? 0 : 12, opacity: 0.45 }}
            />
            {/* Main colored Polyline following actual road geometry */}
            <Polyline
              positions={leg.path}
              pathOptions={{ 
                color: isWalk ? "#64748b" : color, 
                weight: isWalk ? 5 : 7,
                dashArray: isWalk ? "5 10" : undefined 
              }}
            />

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
