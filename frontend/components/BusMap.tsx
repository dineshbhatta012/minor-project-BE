"use client";

import { Fragment } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline } from "react-leaflet";
import L from "leaflet";
import { RouteSearchResult } from "@/types/route";

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
}

export default function BusMap({ result }: BusMapProps) {
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
