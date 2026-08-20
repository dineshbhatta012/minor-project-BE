"use client";

import { Fragment, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from "react-leaflet";
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
const BUS_ICON_ORIGIN = makeBusStopIcon(28, "#3DDC97");       // Green — origin
const BUS_ICON_DESTINATION = makeBusStopIcon(28, "#F2A93B");   // Amber — destination
const BUS_ICON_MAJOR = makeBusStopIcon(22, "#5DA9E9");         // Blue — major / interchange
const BUS_ICON_DEFAULT = makeBusStopIcon(16, "#94a3b8");       // Slate — regular stop
const BUS_ICON_NEAREST = makeBusStopIcon(32, "#2563eb");       // Blue ring — nearest stop to your location

const USER_LOCATION_ICON = L.divIcon({
  className: "",
  html: `<div style="width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 6px rgba(37,99,235,0.3);"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const PICK_MARKER_ICON = L.divIcon({
  className: "",
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#dc2626;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,0.5);"></div>`,
  iconSize: [14, 14],
  iconAnchor: [7, 7],
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
  coordinateMode?: boolean;
  onPickCoordinate?: (lat: number, lng: number) => void;
  pickedPoint?: { lat: number; lng: number } | null;
  editStopMode?: boolean;
  onSelectStopForEdit?: (stop: Stop) => void;
}

// Zooms the map to the displayed result whenever it changes.
function FitBounds({ result }: { result?: RouteSearchResult | null }) {
  const map = useMap();
  useEffect(() => {
    if (!result?.found || !result.legs.length) return;
    const points = result.legs.flatMap((leg) => leg.path);
    if (points.length > 0) {
      map.fitBounds(L.latLngBounds(points.map(([lat, lng]) => [lat, lng])));
    }
  }, [result, map]);
  return null;
}

// Flies the map to the focus stop whenever it changes (e.g. after picking
// "Your location").
function FlyTo({ target }: { target?: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) {
      map.flyTo(target, 16, { duration: 1.2 });
    }
  }, [target, map]);
  return null;
}

// While coordinate mode is active, shows a crosshair pointer on the map and
// reports the coordinates of a right-clicked point.
function CoordinatePicker({
  active,
  onPick,
}: {
  active: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (active) {
      container.style.cursor = "crosshair";
    }
    const handler = (e: L.LeafletMouseEvent) => {
      if (!active) return;
      onPick(e.latlng.lat, e.latlng.lng);
    };
    map.on("contextmenu", handler);
    return () => {
      container.style.cursor = "";
      map.off("contextmenu", handler);
    };
  }, [active, map, onPick]);
  return null;
}

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
  coordinateMode,
  onPickCoordinate,
  pickedPoint,
  editStopMode,
  onSelectStopForEdit,
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
                ? `Click to change — ${stop.stop_name}`
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
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <FitBounds result={result} />

      <CoordinatePicker
        active={coordinateMode ?? false}
        onPick={(lat, lng) => onPickCoordinate?.(lat, lng)}
      />

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

      {/* Point picked with "Show coordinates" (right-click) */}
      {pickedPoint && (
        <Marker position={[pickedPoint.lat, pickedPoint.lng]} icon={PICK_MARKER_ICON}>
          <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
            <span className="font-medium text-xs">
              {pickedPoint.lat.toFixed(6)}, {pickedPoint.lng.toFixed(6)}
            </span>
          </Tooltip>
        </Marker>
      )}

      {/* Bus icons are shown while choosing from/to on the map */}
      {selecting &&
        stops.map((stop) => stopMarker(stop, true))}

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
        return (
          <Fragment key={leg.route_id}>
            {/* Outline Polyline to make the route easily recognized */}
            <Polyline
              positions={leg.path}
              pathOptions={{ color: "#0f172a", weight: 12, opacity: 0.45 }}
            />
            {/* Main colored Polyline following actual road geometry */}
            <Polyline
              positions={leg.path}
              pathOptions={{ color, weight: 7 }}
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
