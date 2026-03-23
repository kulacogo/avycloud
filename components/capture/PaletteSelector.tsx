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
  const [inputText, setInputText] = useState(value);
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

  // Sync inputText when value changes externally (e.g. reset)
  useEffect(() => {
    setInputText(value);
  }, [value]);

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

  const isValid = value !== "" && bins.some((b) => b.code === value);
  const filtered = bins.filter((b) =>
    b.code.toLowerCase().includes(inputText.toLowerCase())
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const upper = e.target.value.toUpperCase();
    setInputText(upper);
    setOpen(true);
    // Auto-select if exact match typed
    if (bins.some((b) => b.code === upper)) {
      onChange(upper);
    } else {
      // Clear parent value — only valid codes propagate
      onChange("");
    }
  }, [bins, onChange]);

  const handleSelect = useCallback((code: string) => {
    setInputText(code);
    onChange(code);
    setOpen(false);
  }, [onChange]);

  const borderClass = inputText
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
        type="text"
        autoComplete="off"
        className={`w-full rounded-xl bg-app-bg border ${borderClass} px-3 py-2 text-sm text-txt-primary placeholder:text-txt-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40`}
        placeholder={loading ? "Paletten werden geladen..." : "Palette eingeben (z.B. PGA001)"}
        value={inputText}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        disabled={loading}
      />
      {isValid && (
        <p className="text-xs text-success mt-1">Palette {value} ausgewählt</p>
      )}
      {inputText && !isValid && (
        <p className="text-xs text-danger mt-1">Palette nicht gefunden — bitte aus der Liste wählen</p>
      )}
      {!inputText && (
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
