"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchableOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: SearchableOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

// A lightweight searchable dropdown (no external deps): type to filter the
// options, click or arrow keys + Enter to pick one.
export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  disabled,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function openDropdown() {
    if (disabled) return;
    setQuery("");
    setHighlighted(0);
    setOpen(true);
  }

  function choose(opt: SearchableOption) {
    onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlighted]) choose(filtered[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <input
        value={open ? query : (selected?.label ?? "")}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlighted(0);
          if (!open) setOpen(true);
        }}
        onFocus={openDropdown}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-md bg-route-bg border border-route-line px-3 py-2 text-sm text-neutral-300 outline-none focus:border-route-accent placeholder:text-neutral-500 disabled:opacity-50"
      />
      {open && (
        <ul className="absolute left-0 right-0 z-10 max-h-56 overflow-y-auto rounded-md bg-route-panel border border-route-line mt-1 py-1 shadow-lg">
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-sm text-neutral-500">No routes match your search.</li>
          )}
          {filtered.map((opt, i) => (
            <li
              key={opt.value}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => choose(opt)}
              className={`px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                i === highlighted
                  ? "bg-route-accent/20 text-white"
                  : "text-neutral-300 hover:bg-route-accent/10"
              }`}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}