"use client";

import { Fragment } from "react";
import { MapContainer, TileLayer, Marker, Polyline, CircleMarker, Tooltip } from "react-leaflet";
import L from "leaflet";
import { RouteSearchResult, Stop } from "@/types/route";

// Leaflet's default marker icons reference image paths that don't resolve
// correctly with Next.js's bundler. Pointing at CDN-hosted icons sidesteps
// that without needing to fiddle with webpack config.
const busIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

// Kathmandu Valley center, used as the default map view.
const VALLEY_CENTER: [number, number] = [27.7041, 85.32];

const LEG_COLORS = ["#059669", "#2563eb", "#dc2626", "#7c3aed"];

interface BusMapProps {
  result?: RouteSearchResult | null;
  stops: Stop[];
  originName: string;
  destinationName: string;
  mapSelectionMode: "from" | "to" | null;
  onSelectStop: (stop: Stop, type: "from" | "to") => void;
}

export default function BusMap({
  result,
  stops,
  originName,
  destinationName,
  mapSelectionMode,
  onSelectStop,
}: BusMapProps) {
  const selecting = mapSelectionMode !== null;
  const originStop = stops.find((s) => s.stop_name === originName);
  const destinationStop = stops.find((s) => s.stop_name === destinationName);

  function stopMarker(stop: Stop, interactive: boolean, markerColor: string, markerRadius: number, weight: number) {
    return (
      <CircleMarker
        key={stop.stop_id}
        center={[stop.lat, stop.lng]}
        radius={markerRadius}
        pathOptions={{
          color: interactive ? "#ffffff" : markerColor,
          fillColor: markerColor,
          fillOpacity: 0.85,
          weight,
        }}
        eventHandlers={
          interactive
            ? { click: () => onSelectStop(stop, mapSelectionMode!) }
            : undefined
        }
      >
        <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
          <span className="font-medium text-xs">{stop.stop_name}</span>
        </Tooltip>
      </CircleMarker>
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

      {/* Bubbles are only shown while choosing from/to on the map */}
      {selecting &&
        stops.map((stop) => {
          const isOrigin = stop.stop_id === originStop?.stop_id;
          const isDest = stop.stop_id === destinationStop?.stop_id;

          let markerColor = "#718096"; // Slate-500
          let markerRadius = 5;
          let weight = 1;

          if (isOrigin) {
            markerColor = "#3DDC97"; // Emerald/green
            markerRadius = 8;
            weight = 3;
          } else if (isDest) {
            markerColor = "#F2A93B"; // Amber/orange
            markerRadius = 8;
            weight = 3;
          } else if (stop.is_major_stop || stop.is_interchange) {
            markerColor = "#5DA9E9"; // Blue
            markerRadius = 6;
            weight = 1.5;
          }

          return stopMarker(stop, true, markerColor, markerRadius, weight);
        })}

      {/* Selected stops are still visible when not choosing */}
      {!selecting && originStop && stopMarker(originStop, false, "#3DDC97", 8, 3)}
      {!selecting && destinationStop && stopMarker(destinationStop, false, "#F2A93B", 8, 3)}

      {result?.legs.map((leg, i) => (
        <Fragment key={leg.route_id}>
          <Marker position={[leg.from_stop.lat, leg.from_stop.lng]} icon={busIcon}>
            <Tooltip direction="top" opacity={0.9}>
              <span className="font-medium text-xs">{leg.from_stop.stop_name}</span>
            </Tooltip>
          </Marker>
          <Marker position={[leg.to_stop.lat, leg.to_stop.lng]} icon={busIcon}>
            <Tooltip direction="top" opacity={0.9}>
              <span className="font-medium text-xs">{leg.to_stop.stop_name}</span>
            </Tooltip>
          </Marker>
          {/* Outline Polyline to make the route easily recognized */}
          <Polyline
            positions={leg.path}
            pathOptions={{ color: "#0f172a", weight: 12, opacity: 0.45 }}
          />
          {/* Main colored Polyline */}
          <Polyline
            positions={leg.path}
            pathOptions={{ color: LEG_COLORS[i % LEG_COLORS.length], weight: 7 }}
          />
        </Fragment>
      ))}
    </MapContainer>
  );
}
