"use client";

import { Stop } from "@/types/route";

interface SearchFormProps {
  stops: Stop[];
  originName: string;
  setOriginName: (name: string) => void;
  destinationName: string;
  setDestinationName: (name: string) => void;
  mapSelectionMode: "from" | "to" | null;
  setMapSelectionMode: (mode: "from" | "to" | null) => void;
  onSearch: (originStopId: string, destinationStopId: string) => void;
  onSwap: () => void;
  onClear: () => void;
  loading?: boolean;
  disabled?: boolean;
}

export default function SearchForm({
  stops,
  originName,
  setOriginName,
  destinationName,
  setDestinationName,
  mapSelectionMode,
  setMapSelectionMode,
  onSearch,
  onSwap,
  onClear,
  loading,
  disabled,
}: SearchFormProps) {

  function resolveStopId(name: string): string | null {
    const match = stops.find((s) => s.stop_name.toLowerCase() === name.trim().toLowerCase());
    return match ? match.stop_id : null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const originId = resolveStopId(originName);
    const destinationId = resolveStopId(destinationName);
    if (!originId || !destinationId) return; // caller's page shows a hint via the datalist itself
    onSearch(originId, destinationId);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4 bg-route-panel rounded-lg">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="origin" className="text-xs uppercase tracking-wide text-neutral-400">
            From
          </label>
          <button
            type="button"
            onClick={() => setMapSelectionMode(mapSelectionMode === "from" ? null : "from")}
            disabled={disabled}
            className={`text-xs px-2 py-0.5 rounded font-medium transition-colors cursor-pointer border-0 ${
              mapSelectionMode === "from"
                ? "bg-emerald-600 text-white"
                : "bg-route-bg border border-route-line text-neutral-300 hover:border-route-accent disabled:opacity-50"
            }`}
          >
            Choose from map
          </button>
        </div>
        <input
          id="origin"
          list="stop-options"
          value={originName}
          onChange={(e) => setOriginName(e.target.value)}
          placeholder={disabled ? "Loading stops…" : "Origin stop"}
          disabled={disabled}
          className="rounded-md bg-route-bg border border-route-line px-3 py-2 text-sm outline-none focus:border-route-accent disabled:opacity-50"
        />
      </div>

      {/* Swap origin ↔ destination */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onSwap}
          disabled={disabled || (!originName && !destinationName)}
          title="Swap origin and destination"
          className="rounded-full bg-route-bg border border-route-line p-1.5 text-neutral-300 hover:border-route-accent hover:text-white disabled:opacity-50 transition-colors cursor-pointer"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 4l-4 4 4 4" />
            <path d="M17 20l4-4-4-4" />
            <line x1="3" y1="8" x2="21" y2="8" />
            <line x1="21" y1="16" x2="3" y2="16" />
          </svg>
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label htmlFor="destination" className="text-xs uppercase tracking-wide text-neutral-400">
            To
          </label>
          <button
            type="button"
            onClick={() => setMapSelectionMode(mapSelectionMode === "to" ? null : "to")}
            disabled={disabled}
            className={`text-xs px-2 py-0.5 rounded font-medium transition-colors cursor-pointer border-0 ${
              mapSelectionMode === "to"
                ? "bg-amber-600 text-white"
                : "bg-route-bg border border-route-line text-neutral-300 hover:border-route-accent disabled:opacity-50"
            }`}
          >
            Choose from map
          </button>
        </div>
        <input
          id="destination"
          list="stop-options"
          value={destinationName}
          onChange={(e) => setDestinationName(e.target.value)}
          placeholder={disabled ? "Loading stops…" : "Destination stop"}
          disabled={disabled}
          className="rounded-md bg-route-bg border border-route-line px-3 py-2 text-sm outline-none focus:border-route-accent disabled:opacity-50"
        />
      </div>

      {mapSelectionMode && (
        <p className="text-xs text-route-accent">
          Click a bus stop icon on the map to set the {mapSelectionMode === "from" ? "origin" : "destination"}.
        </p>
      )}

      {/* Real stop names from GET /stops, fetched once on page load */}
      <datalist id="stop-options">
        {stops.map((s) => (
          <option key={s.stop_id} value={s.stop_name} />
        ))}
      </datalist>

      <button
        type="submit"
        disabled={loading || disabled}
        className="mt-1 rounded-md bg-route-accent text-route-bg font-medium py-2 text-sm disabled:opacity-50"
      >
        {loading ? "Searching…" : "Find route"}
      </button>

      <button
        type="button"
        onClick={onClear}
        disabled={disabled || (!originName && !destinationName)}
        className="rounded-md bg-route-bg border border-route-line text-neutral-300 hover:border-route-accent hover:text-white font-medium py-2 text-sm disabled:opacity-50 transition-colors cursor-pointer"
      >
        Clear
      </button>
    </form>
  );
}
