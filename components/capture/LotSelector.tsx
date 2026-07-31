import React, { useState, useEffect, useRef, useCallback } from "react";
import { fetchWarehouseLots } from "../../api/client";
import type { WarehouseLot } from "../../types";

/**
 * Los-Auswahl beim Erfassen (Pflicht). Ein Los ist die Einkaufs-Zugehörigkeit
 * der Ware: L-MMYYNN (Auktions-Los) oder NL-MMYY (Non-Los). Nur Codes, die in
 * der Los-Struktur angelegt sind, werden akzeptiert — der QR-Scan vom
 * Rollwagen-Label liefert exakt diesen Code.
 */

interface LotSelectorProps {
  value: string;
  onChange: (code: string) => void;
}

const LotSelector: React.FC<LotSelectorProps> = ({ value, onChange }) => {
  const [lots, setLots] = useState<WarehouseLot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState(false);
  const [inputText, setInputText] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    fetchWarehouseLots()
      .then((data) => {
        if (!cancelled) {
          setLots(data);
          setLoading(false);
        }
      })
      .catch(() => {
        // Fehler NICHT verschlucken: sonst blockiert ein transienter Ausfall
        // (z.B. Deploy-Fenster) gültige Scans mit irreführendem "nicht gefunden".
        if (!cancelled) {
          setLoadError(true);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [reloadKey]);

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

  const isValid = value !== "" && lots.some((l) => l.code === value);
  const filtered = lots.filter((l) =>
    l.code.toLowerCase().includes(inputText.toLowerCase())
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const upper = e.target.value.toUpperCase();
    setInputText(upper);
    setOpen(true);
    // Auto-select if exact match typed/scanned
    if (lots.some((l) => l.code === upper)) {
      onChange(upper);
    } else {
      // Clear parent value — only valid codes propagate
      onChange("");
    }
  }, [lots, onChange]);

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
        Los (Pflicht)
      </label>
      <input
        type="text"
        autoComplete="off"
        className={`w-full rounded-xl bg-app-bg border ${borderClass} px-3 py-2 text-sm text-txt-primary placeholder:text-txt-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40`}
        placeholder={loading ? "Lose werden geladen..." : "Los scannen/eingeben (z.B. L-072612 oder NL-0726)"}
        value={inputText}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        disabled={loading}
      />
      {loadError && (
        <p className="text-xs text-danger mt-1">
          Lose konnten nicht geladen werden.{" "}
          <button
            type="button"
            className="underline hover:text-txt-primary"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Erneut laden
          </button>
        </p>
      )}
      {!loadError && isValid && (
        <p className="text-xs text-success mt-1">Los {value} ausgewählt</p>
      )}
      {!loadError && inputText && !isValid && (
        <p className="text-xs text-danger mt-1">
          Los nicht gefunden — bitte aus der Liste wählen oder unter Lager → Los-Struktur anlegen
        </p>
      )}
      {!loadError && !inputText && (
        <p className="text-xs text-txt-muted mt-1">Bitte Los auswählen (Wareneingangs-Zugehörigkeit)</p>
      )}

      {/* Autocomplete dropdown */}
      {open && !loading && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto rounded-xl border border-app-border bg-app-bg shadow-lg shadow-black/20">
          {filtered.map((lot) => (
            <button
              key={lot.code}
              type="button"
              onClick={() => handleSelect(lot.code)}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-accent/10 transition-colors ${
                lot.code === value ? "text-accent font-medium bg-accent/5" : "text-txt-primary"
              }`}
            >
              <span className="font-mono">{lot.code}</span>
              <span className="text-txt-muted ml-2">
                {lot.type === "L" ? "Auktion" : "Non-Los"}
                {typeof lot.productCount === "number" ? ` · ${lot.productCount} Produkte` : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default LotSelector;
