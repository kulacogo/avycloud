import React, { useState, useEffect, useRef, useCallback } from "react";
import { fetchWarehouseBins } from "../../api/client";
import type { WarehouseBin } from "../../types";

interface PaletteSelectorProps {
  value: string;
  onChange: (code: string) => void;
}

const PaletteSelector: React.FC<PaletteSelectorProps> = ({ value, onChange }) => {
  const [bins, setBins] = useState<WarehouseBin[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchWarehouseBins("P", "").then((result) => {
      if (!cancelled) {
        setBins(Array.isArray(result) ? result : []);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const isValid = bins.some((b) => b.code === value);
  const filtered = bins.filter((b) =>
    b.code.toLowerCase().includes(filter.toLowerCase())
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const upper = e.target.value.toUpperCase();
    setFilter(upper);
    onChange(upper);
    setOpen(true);
  }, [onChange]);

  const handleSelect = useCallback((code: string) => {
    onChange(code);
    setFilter("");
    setOpen(false);
  }, [onChange]);

  const borderClass = value
    ? isValid
      ? "border-success/40"
      : "border-danger/40"
    : "border-app-border";

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-semibold text-txt-muted mb-1">
        Palette (Pflicht)
      </label>
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        className={`w-full rounded-xl bg-app-bg border ${borderClass} px-3 py-2 text-sm text-txt-primary placeholder:text-txt-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40`}
        placeholder={loading ? "Paletten werden geladen..." : "Palette eingeben (z.B. PGA001)"}
        value={value || filter}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        disabled={loading}
      />
      {value && isValid && (
        <p className="text-xs text-success mt-1">Palette {value} ausgewählt</p>
      )}
      {value && !isValid && (
        <p className="text-xs text-danger mt-1">Palette nicht gefunden — bitte aus der Liste wählen</p>
      )}
      {!value && (
        <p className="text-xs text-txt-muted mt-1">Bitte Quell-Palette auswählen</p>
      )}

      {/* Autocomplete dropdown */}
      {open && !loading && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto rounded-xl border border-app-border bg-app-bg shadow-lg shadow-black/20">
          {filtered.map((bin) => (
            <button
              key={bin.code}
              type="button"
              onClick={() => handleSelect(bin.code)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-accent/10 transition-colors ${
                bin.code === value ? "text-accent font-medium bg-accent/5" : "text-txt-primary"
              }`}
            >
              <span className="font-mono">{bin.code}</span>
              <span className="text-txt-muted ml-2">Etage {bin.etage}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PaletteSelector;
