"use client";

import { Fragment } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, Tooltip } from "react-leaflet";
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

const LEG_COLORS = ["#3DDC97", "#F2A93B", "#5DA9E9", "#E06C75"];

interface BusMapProps {
  result?: RouteSearchResult | null;
  stops: Stop[];
  originName: string;
  destinationName: string;
  onSelectStop: (stop: Stop, type: "from" | "to") => void;
}

export default function BusMap({
  result,
  stops,
  originName,
  destinationName,
  onSelectStop,
}: BusMapProps) {
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

      {stops.map((stop) => {
        const isOrigin = stop.stop_name === originName;
        const isDest = stop.stop_name === destinationName;

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

        return (
          <CircleMarker
            key={stop.stop_id}
            center={[stop.lat, stop.lng]}
            radius={markerRadius}
            pathOptions={{
              color: isOrigin || isDest ? "#ffffff" : markerColor,
              fillColor: markerColor,
              fillOpacity: 0.85,
              weight: weight,
            }}
          >
            <Tooltip direction="top" offset={[0, -5]} opacity={0.9}>
              <span className="font-medium text-xs">{stop.stop_name}</span>
            </Tooltip>
            <Popup>
              <div className="flex flex-col gap-2 p-1 text-slate-800">
                <span className="font-semibold text-sm">{stop.stop_name}</span>
                {stop.is_major_stop && (
                  <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded font-semibold w-max">
                    Major Stop
                  </span>
                )}
                {stop.is_interchange && (
                  <span className="text-[10px] text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded font-semibold w-max">
                    Interchange
                  </span>
                )}
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => onSelectStop(stop, "from")}
                    className="text-xs px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium transition-colors cursor-pointer border-0"
                  >
                    Set as From
                  </button>
                  <button
                    onClick={() => onSelectStop(stop, "to")}
                    className="text-xs px-2 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-medium transition-colors cursor-pointer border-0"
                  >
                    Set as To
                  </button>
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {result?.legs.map((leg, i) => (
        <Fragment key={leg.route_id}>
          <Marker position={[leg.from_stop.lat, leg.from_stop.lng]} icon={busIcon}>
            <Popup>{leg.from_stop.stop_name}</Popup>
          </Marker>
          <Marker position={[leg.to_stop.lat, leg.to_stop.lng]} icon={busIcon}>
            <Popup>{leg.to_stop.stop_name}</Popup>
          </Marker>
          <Polyline
            positions={leg.path}
            pathOptions={{ color: LEG_COLORS[i % LEG_COLORS.length], weight: 5 }}
          />
        </Fragment>
      ))}
    </MapContainer>
  );
}
