import React from "react";
import {
  filterDefMatchesQuery,
  NUMBER_OP_LABELS,
  DATE_PRESET_LABELS,
  type DatePreset,
  type DateRangeValue,
  type FilterOption,
  type FilterValue,
  type NumberCompareValue,
  type NumberOp,
  type ProductFilterDef,
} from "../../utils/productFilters";

/**
 * Typisierte Wert-Editoren fuer die Filter-Chips der Produkttabelle.
 *
 * UX-Leitplanken (Baymard/NN-g, Recherche 2026-08-26):
 * - Zahlenfilter = Operator + Eingabefelder, NIE Slider (>50 % Fehlbedienung
 *   bei Dual-Slidern in Baymards Tests).
 * - Datumsfilter = Presets ("Letzte 7 Tage") + freier Von-Bis-Bereich.
 * - Mehrfachauswahl mit Treffer-Counts je Option; Suche ab ~9 Optionen.
 * - Aenderungen wirken sofort (Daten liegen komplett im Client).
 */

const inputClass =
  "w-full p-2 text-sm bg-app-surface border border-app-border rounded-xl text-txt-primary focus:ring-2 focus:ring-accent outline-none";

/** Popover-Huelle im App-Standardmuster (absolute, Token-Farben, Schatten). */
export const FilterPopover: React.FC<{
  title: string;
  onClose: () => void;
  onRemove?: () => void;
  widthClass?: string;
  children: React.ReactNode;
}> = ({ title, onClose, onRemove, widthClass, children }) => (
  <div
    data-filter-pop
    className={`absolute left-0 z-30 mt-2 ${widthClass || "w-[280px]"} max-w-[92vw] rounded-xl border border-app-border bg-app-bg p-3 shadow-lg`}
  >
    <div className="mb-2 flex items-center justify-between gap-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-txt-secondary">{title}</p>
      <div className="flex items-center gap-2">
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-xs text-danger hover:underline">
            Entfernen
          </button>
        )}
        <button type="button" onClick={onClose} className="text-xs text-txt-secondary hover:underline">
          Schließen
        </button>
      </div>
    </div>
    {children}
  </div>
);

export const SelectFilterEditor: React.FC<{
  def: ProductFilterDef;
  value: string;
  onChange: (value: string) => void;
}> = ({ def, value, onChange }) => (
  <div className="space-y-0.5">
    {(def.selectOptions || []).map((opt) => {
      const active = value === opt.value;
      return (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={active}
          className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition ${
            active ? "bg-accent/10 font-medium text-accent" : "text-txt-primary hover:bg-app-elevated/60"
          }`}
        >
          <span className="truncate">{opt.label}</span>
          {active && (
            <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
      );
    })}
  </div>
);

export const MultiFilterEditor: React.FC<{
  options: FilterOption[];
  values: string[];
  onChange: (values: string[]) => void;
}> = ({ options, values, onChange }) => {
  const [query, setQuery] = React.useState("");
  const selected = React.useMemo(() => new Set(values), [values]);
  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(Array.from(next));
  };

  return (
    <div className="space-y-2">
      {options.length > 8 && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Suchen …"
          aria-label="Optionen durchsuchen"
          className={inputClass}
        />
      )}
      <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <p className="px-1 py-2 text-xs text-txt-muted">Keine Treffer</p>
        ) : (
          filtered.map((opt) => (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition hover:bg-app-elevated/60 ${
                selected.has(opt.value) ? "text-txt-primary" : "text-txt-secondary"
              }`}
            >
              <input type="checkbox" checked={selected.has(opt.value)} onChange={() => toggle(opt.value)} />
              <span className="flex-1 truncate">{opt.label}</span>
              {typeof opt.count === "number" && <span className="text-xs tabular-nums text-txt-muted">{opt.count}</span>}
            </label>
          ))
        )}
      </div>
      {values.length > 0 && (
        <div className="flex justify-end border-t border-app-border pt-2">
          <button type="button" onClick={() => onChange([])} className="text-xs text-accent hover:underline">
            Auswahl leeren
          </button>
        </div>
      )}
    </div>
  );
};

const parseNumberInput = (raw: string): number | null => {
  if (raw.trim() === "") return null;
  // Deutsches Komma zulassen — der Ziffernblock des Browsers liefert je nach
  // Locale beides.
  const num = Number(raw.replace(",", "."));
  return Number.isFinite(num) ? num : null;
};

export const NumberCompareEditor: React.FC<{
  def: ProductFilterDef;
  value: NumberCompareValue;
  onChange: (value: NumberCompareValue) => void;
}> = ({ def, value, onChange }) => {
  const setOp = (op: NumberOp) => onChange({ ...value, op });
  return (
    <div className="space-y-2">
      <select
        value={value.op}
        onChange={(e) => setOp(e.target.value as NumberOp)}
        aria-label="Vergleich"
        className={inputClass}
      >
        {NUMBER_OP_LABELS.map((op) => (
          <option key={op.value} value={op.value}>
            {op.label}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={value.a ?? ""}
          onChange={(e) => onChange({ ...value, a: parseNumberInput(e.target.value) })}
          placeholder={value.op === "between" ? "von" : "Wert"}
          aria-label={value.op === "between" ? `${def.label} von` : `${def.label} Wert`}
          className={inputClass}
        />
        {value.op === "between" && (
          <>
            <span className="text-xs text-txt-muted">–</span>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              value={value.b ?? ""}
              onChange={(e) => onChange({ ...value, b: parseNumberInput(e.target.value) })}
              placeholder="bis"
              aria-label={`${def.label} bis`}
              className={inputClass}
            />
          </>
        )}
        {def.unit && <span className="text-sm text-txt-muted">{def.unit}</span>}
      </div>
    </div>
  );
};

const DATE_PRESETS_IN_ORDER: DatePreset[] = ["today", "yesterday", "thisWeek", "last7", "last30", "thisMonth", "lastMonth"];

export const DateRangeEditor: React.FC<{
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
}> = ({ value, onChange }) => (
  <div className="space-y-2">
    <div className="grid grid-cols-2 gap-1.5">
      {DATE_PRESETS_IN_ORDER.map((preset) => {
        const active = value.preset === preset;
        return (
          <button
            key={preset}
            type="button"
            onClick={() => onChange({ preset, from: null, to: null })}
            aria-pressed={active}
            className={`rounded-xl border px-2 py-1.5 text-xs font-medium transition ${
              active
                ? "border-accent bg-accent-dim text-accent"
                : "border-app-border bg-app-surface text-txt-primary hover:border-app-border/80"
            }`}
          >
            {DATE_PRESET_LABELS[preset]}
          </button>
        );
      })}
    </div>
    <div className="space-y-1 border-t border-app-border pt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-txt-muted">Eigener Zeitraum</p>
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={value.preset === "custom" ? value.from || "" : ""}
          onChange={(e) =>
            onChange({ preset: "custom", from: e.target.value || null, to: value.preset === "custom" ? value.to : null })
          }
          aria-label="Von"
          className={inputClass}
        />
        <span className="text-xs text-txt-muted">–</span>
        <input
          type="date"
          value={value.preset === "custom" ? value.to || "" : ""}
          onChange={(e) =>
            onChange({ preset: "custom", from: value.preset === "custom" ? value.from : null, to: e.target.value || null })
          }
          aria-label="Bis"
          className={inputClass}
        />
      </div>
    </div>
  </div>
);

/** Kleines Typ-Symbol je Filter-Art — gibt dem Menue scanbare Struktur. */
export const FilterKindIcon: React.FC<{ kind: ProductFilterDef["kind"]; className?: string }> = ({
  kind,
  className = "h-3.5 w-3.5",
}) => {
  switch (kind) {
    case "numberCompare":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path strokeLinecap="round" d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16" />
        </svg>
      );
    case "dateRange":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
          <path strokeLinecap="round" d="M8 3v4M16 3v4M3.5 10.5h17" />
        </svg>
      );
    case "multi":
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 6.5l1.5 1.5L7.5 5M3.5 13l1.5 1.5L7.5 11.5M3.5 19.5l1.5 1.5L7.5 18M11 7h9.5M11 13.5h9.5M11 20h9.5" />
        </svg>
      );
    default:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        </svg>
      );
  }
};

/**
 * "+ Filter"-Menue als zweistufiges Command-Menue (Linear-Muster):
 *
 * Ebene 1: Dimensionen — durchsuchbar, gruppiert, mit Typ-Icons; die Suche ist
 * EBENEN-UEBERGREIFEND ("Quick search filters"): wer direkt einen WERT tippt
 * ("bosch", "Bereit"), bekommt "Marke · Bosch" als Direkteintrag und filtert
 * mit einem Klick, ohne erst das Feld zu waehlen.
 *
 * Ebene 2: dasselbe Popover wechselt zur Werteauswahl der gewaehlten
 * Dimension (Checkboxen/Operator+Zahl/Zeitraum) statt zu einem Editor an
 * anderer Stelle zu springen. Esc geht eine Ebene zurueck; ein ohne Wert
 * verlassener Filter hinterlaesst keinen leeren Chip.
 */
interface ValueHit {
  defId: string;
  value: string;
  label: string;
  count?: number;
}

type FlatItem = { type: "field"; def: ProductFilterDef } | { type: "value"; hit: ValueHit };

export const AddFilterMenu: React.FC<{
  defs: ProductFilterDef[];
  activeIds: ReadonlySet<string>;
  optionsById: ReadonlyMap<string, FilterOption[]>;
  getValue: (id: string) => FilterValue | undefined;
  setFilterValue: (id: string, value: FilterValue) => void;
  removeFilter: (id: string) => void;
  /** Sonder-Editoren (Kategorie-Baum) fuer Ebene 2; null = Standard-Editor. */
  renderCustomEditor?: (def: ProductFilterDef) => React.ReactNode | null;
  onClose: () => void;
}> = ({ defs, activeIds, optionsById, getValue, setFilterValue, removeFilter, renderCustomEditor, onClose }) => {
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const [levelId, setLevelId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  const defById = React.useMemo(() => new Map(defs.map((d) => [d.id, d])), [defs]);
  const levelDef = levelId ? defById.get(levelId) ?? null : null;

  React.useEffect(() => {
    if (!levelId) inputRef.current?.focus();
  }, [levelId]);

  const q = query.trim().toLowerCase();
  // Label + Synonyme ("erfasst" findet auch den frueher "Erstellt" genannten Filter).
  const fieldMatches = q ? defs.filter((d) => filterDefMatchesQuery(d, q)) : defs;

  // Wert-Treffer: Options-Labels aller Dimensionen durchsuchen (max. 10).
  const valueHits = React.useMemo<ValueHit[]>(() => {
    if (!q) return [];
    const hits: ValueHit[] = [];
    for (const def of defs) {
      const options = def.kind === "multi" ? optionsById.get(def.id) : def.kind === "select" ? def.selectOptions : undefined;
      if (!options) continue;
      for (const opt of options) {
        if (hits.length >= 10) return hits;
        if (opt.label.toLowerCase().includes(q)) {
          hits.push({ defId: def.id, value: opt.value, label: opt.label, count: opt.count });
        }
      }
    }
    return hits;
  }, [q, defs, optionsById]);

  const flatItems = React.useMemo<FlatItem[]>(
    () => [
      ...fieldMatches.map((def) => ({ type: "field", def }) as FlatItem),
      ...valueHits.map((hit) => ({ type: "value", hit }) as FlatItem),
    ],
    [fieldMatches, valueHits]
  );

  React.useEffect(() => {
    setHighlight(0);
  }, [q]);
  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-menu-idx="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Ebene verlassen ohne gesetzten Wert → leeren Eintrag wieder aufraeumen.
  const cleanupLevel = React.useCallback(
    (id: string | null) => {
      if (!id) return;
      const def = defById.get(id);
      const value = getValue(id);
      if (def && value !== undefined && !def.isActive(value)) removeFilter(id);
    },
    [defById, getValue, removeFilter]
  );
  const levelRef = React.useRef<string | null>(null);
  levelRef.current = levelId;
  const cleanupRef = React.useRef(cleanupLevel);
  cleanupRef.current = cleanupLevel;
  React.useEffect(
    () => () => {
      // Unmount (Aussenklick, Schliessen): letzte offene Ebene aufraeumen.
      cleanupRef.current(levelRef.current);
    },
    []
  );

  const enterLevel = (id: string) => {
    setLevelId(id);
  };
  const backToLevel1 = () => {
    cleanupLevel(levelId);
    setLevelId(null);
    setQuery("");
  };

  const pickItem = (item: FlatItem) => {
    if (item.type === "field") {
      enterLevel(item.def.id);
      return;
    }
    const def = defById.get(item.hit.defId);
    if (!def) return;
    if (def.kind === "multi") {
      const existing = (getValue(def.id) as string[] | undefined) ?? [];
      const next = existing.includes(item.hit.value) ? existing : [...existing, item.hit.value];
      setFilterValue(def.id, next);
      // Linear-Verhalten: in die Werteliste springen, Haken sitzt bereits.
      setLevelId(def.id);
    } else {
      setFilterValue(def.id, item.hit.value);
      onClose();
    }
  };

  const renderLevel2 = (def: ProductFilterDef) => {
    const custom = renderCustomEditor?.(def);
    if (custom) return custom;
    const value = getValue(def.id) ?? def.defaultValue;
    if (def.kind === "multi") {
      return (
        <MultiFilterEditor
          options={optionsById.get(def.id) || []}
          values={(value as string[]) || []}
          onChange={(next) => setFilterValue(def.id, next)}
        />
      );
    }
    if (def.kind === "numberCompare") {
      return (
        <NumberCompareEditor
          def={def}
          value={value as NumberCompareValue}
          onChange={(next) => setFilterValue(def.id, next)}
        />
      );
    }
    if (def.kind === "dateRange") {
      return <DateRangeEditor value={value as DateRangeValue} onChange={(next) => setFilterValue(def.id, next)} />;
    }
    return (
      <SelectFilterEditor
        def={def}
        value={(value as string) || ""}
        onChange={(next) => {
          setFilterValue(def.id, next);
          onClose();
        }}
      />
    );
  };

  return (
    <div
      data-filter-pop
      className="absolute left-0 z-30 mt-2 w-[320px] max-w-[92vw] overflow-hidden rounded-xl border border-app-border bg-app-bg shadow-xl shadow-black/40"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // Esc geht eine Ebene zurueck, erst dann schliesst es das Menue —
        // und erreicht NIE den globalen Alles-schliessen-Handler.
        e.stopPropagation();
        if (levelDef) backToLevel1();
        else onClose();
      }}
    >
      {levelDef ? (
        <>
          <div className="flex items-center gap-1 border-b border-app-border p-2">
            <button
              type="button"
              onClick={backToLevel1}
              aria-label="Zurück zur Filterliste"
              className="rounded-lg p-1 text-txt-muted transition hover:bg-app-elevated/60 hover:text-txt-primary"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="flex items-center gap-1.5 text-sm font-medium text-txt-primary">
              <span className="text-txt-muted">
                <FilterKindIcon kind={levelDef.kind} />
              </span>
              {levelDef.label}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-lg px-2 py-1 text-xs text-txt-secondary transition hover:bg-app-elevated/60 hover:text-txt-primary"
            >
              Fertig
            </button>
          </div>
          <div className="max-h-[min(60vh,460px)] overflow-y-auto overscroll-contain p-2">{renderLevel2(levelDef)}</div>
        </>
      ) : (
        <>
          <div className="border-b border-app-border p-2">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => Math.min(h + 1, Math.max(flatItems.length - 1, 0)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => Math.max(h - 1, 0));
                } else if (e.key === "Enter" && flatItems.length > 0) {
                  e.preventDefault();
                  pickItem(flatItems[Math.min(highlight, flatItems.length - 1)]);
                }
              }}
              placeholder="Feld oder Wert tippen …"
              aria-label="Filter suchen"
              className="w-full rounded-lg bg-app-surface px-2.5 py-1.5 text-sm text-txt-primary placeholder:text-txt-muted outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div ref={listRef} className="max-h-[min(60vh,460px)] overflow-y-auto overscroll-contain p-1.5 pb-2">
            {flatItems.length === 0 ? (
              <p className="px-2.5 py-3 text-xs text-txt-muted">Kein Filter passt zu „{query}“</p>
            ) : (
              <>
                {(() => {
                  const groups: Array<{ group: string; defs: ProductFilterDef[] }> = [];
                  for (const def of fieldMatches) {
                    const bucket = groups.find((g) => g.group === def.group);
                    if (bucket) bucket.defs.push(def);
                    else groups.push({ group: def.group, defs: [def] });
                  }
                  return groups.map(({ group, defs: groupDefs }, groupIdx) => (
                    <div key={group}>
                      <p
                        className={`px-2.5 ${groupIdx === 0 ? "pt-1" : "pt-3"} pb-1 text-[10px] font-semibold uppercase tracking-wider text-txt-muted`}
                      >
                        {group}
                      </p>
                      {groupDefs.map((def) => {
                        const flatIdx = fieldMatches.indexOf(def);
                        const active = activeIds.has(def.id);
                        return (
                          <button
                            key={def.id}
                            type="button"
                            data-menu-idx={flatIdx}
                            onClick={() => pickItem({ type: "field", def })}
                            onMouseEnter={() => setHighlight(flatIdx)}
                            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
                              flatIdx === highlight ? "bg-app-elevated/80 text-txt-primary" : "text-txt-primary"
                            }`}
                          >
                            <span className={active ? "text-accent" : "text-txt-muted"}>
                              <FilterKindIcon kind={def.kind} />
                            </span>
                            <span className="flex-1 truncate">{def.label}</span>
                            {active && (
                              <svg className="h-3.5 w-3.5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ));
                })()}
                {valueHits.length > 0 && (
                  <div>
                    <p className="px-2.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-txt-muted">
                      Direkt filtern
                    </p>
                    {valueHits.map((hit, i) => {
                      const flatIdx = fieldMatches.length + i;
                      const def = defById.get(hit.defId);
                      return (
                        <button
                          key={`${hit.defId}:${hit.value}`}
                          type="button"
                          data-menu-idx={flatIdx}
                          onClick={() => pickItem({ type: "value", hit })}
                          onMouseEnter={() => setHighlight(flatIdx)}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
                            flatIdx === highlight ? "bg-app-elevated/80" : ""
                          }`}
                        >
                          <span className="text-txt-muted">
                            <FilterKindIcon kind={def?.kind ?? "select"} />
                          </span>
                          <span className="truncate text-txt-muted">{def?.label}</span>
                          <span className="text-txt-muted">·</span>
                          <span className="flex-1 truncate text-txt-primary">{hit.label}</span>
                          {typeof hit.count === "number" && (
                            <span className="text-xs tabular-nums text-txt-muted">{hit.count}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};
