"use client";

import { Stop } from "@/types/route";

interface SearchFormProps {
  stops: Stop[];
  originName: string;
  setOriginName: (name: string) => void;
  destinationName: string;
  setDestinationName: (name: string) => void;
  onSearch: (originStopId: string, destinationStopId: string) => void;
  loading?: boolean;
  disabled?: boolean;
}

export default function SearchForm({
  stops,
  originName,
  setOriginName,
  destinationName,
  setDestinationName,
  onSearch,
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
        <label htmlFor="origin" className="text-xs uppercase tracking-wide text-neutral-400">
          From
        </label>
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

      <div className="flex flex-col gap-1">
        <label htmlFor="destination" className="text-xs uppercase tracking-wide text-neutral-400">
          To
        </label>
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
    </form>
  );
}
