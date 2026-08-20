"use client";

import { useEffect, useRef, useState } from "react";
import { Place, searchPlaces } from "@/lib/geocode";

interface PlaceSearchProps {
  onSelect: (place: Place) => void;
  disabled?: boolean;
}

// A search-as-you-type box (like a real map app): debounced query to the
// geocoder, a results dropdown, and keyboard navigation.
export default function PlaceSearch({ onSelect, disabled }: PlaceSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setOpen(false);
      setLoading(false);
      setError(null);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchPlaces(q, controller.signal)
        .then((places) => {
          setResults(places);
          setHighlighted(0);
          setOpen(true);
        })
        .catch((err: Error) => {
          if (err.name === "AbortError") return;
          setResults([]);
          setError("Couldn't search places. Check your connection.");
        })
        .finally(() => setLoading(false));
    }, 400);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function choose(place: Place) {
    onSelect(place);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[highlighted]) choose(results[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <div className="relative">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          disabled={disabled}
          placeholder="Search for a place…"
          className="w-full rounded-md bg-route-bg border border-route-line pl-9 pr-3 py-2 text-sm text-neutral-300 outline-none focus:border-route-accent placeholder:text-neutral-500 disabled:opacity-50"
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-route-accent">
            …
          </span>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      {open && (
        <ul className="absolute left-0 right-0 z-20 max-h-64 overflow-y-auto rounded-md bg-route-panel border border-route-line mt-1 py-1 shadow-lg">
          {results.length === 0 && !loading && (
            <li className="px-3 py-2 text-sm text-neutral-500">No places found.</li>
          )}
          {results.map((place, i) => (
            <li
              key={`${place.lat},${place.lng},${place.name}`}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => choose(place)}
              className={`px-3 py-2 text-sm cursor-pointer transition-colors ${
                i === highlighted
                  ? "bg-route-accent/20 text-white"
                  : "text-neutral-300 hover:bg-route-accent/10"
              }`}
            >
              {place.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}