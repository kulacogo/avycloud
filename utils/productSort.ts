/**
 * Multi-Kriterien-Sortierung der Produkttabelle.
 *
 * Klick auf einen Spaltenkopf ersetzt die Sortierung (asc → desc im Wechsel);
 * Shift-Klick haengt die Spalte als weiteres Kriterium an (asc → desc →
 * entfernen). Der Comparator sortiert deutsch, zahlenbewusst ("BIN2" vor
 * "BIN10") und schiebt leere Werte in beiden Richtungen ans Ende — sonst
 * fluten Produkte ohne Preis die "teuerste zuerst"-Ansicht von oben.
 */

export type SortDirection = "asc" | "desc";

export interface SortLevel {
  key: string;
  direction: SortDirection;
}

export const SORT_STORAGE_KEY = "avystock:admin-table:sort";

export const DEFAULT_SORT: SortLevel[] = [{ key: "ops.last_saved_iso", direction: "desc" }];

export function toggleSortLevel(levels: SortLevel[], key: string, additive: boolean): SortLevel[] {
  const existing = levels.find((l) => l.key === key);
  if (!additive) {
    // Nur wenn die Spalte die EINZIGE Sortierung ist, dreht der Klick die
    // Richtung — sonst wird sie neue alleinige Sortierung (aufsteigend).
    if (levels.length === 1 && existing) {
      return [{ key, direction: existing.direction === "asc" ? "desc" : "asc" }];
    }
    return [{ key, direction: "asc" }];
  }
  if (!existing) return [...levels, { key, direction: "asc" }];
  if (existing.direction === "asc") {
    return levels.map((l) => (l.key === key ? { key, direction: "desc" as SortDirection } : l));
  }
  return levels.filter((l) => l.key !== key);
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

const isEmptyValue = (v: unknown): boolean => v === null || v === undefined || v === "";

export function buildProductComparator<T>(
  levels: SortLevel[],
  getValue: (item: T, key: string) => unknown
): (a: T, b: T) => number {
  return (a, b) => {
    for (const level of levels) {
      const aValue = getValue(a, level.key);
      const bValue = getValue(b, level.key);
      const aEmpty = isEmptyValue(aValue);
      const bEmpty = isEmptyValue(bValue);
      if (aEmpty || bEmpty) {
        if (aEmpty && bEmpty) continue;
        // Leere Werte immer ans Ende — unabhaengig von der Richtung.
        return aEmpty ? 1 : -1;
      }
      let cmp: number;
      if (typeof aValue === "number" || typeof bValue === "number") {
        cmp = (Number(aValue) || 0) - (Number(bValue) || 0);
      } else {
        cmp = collator.compare(String(aValue), String(bValue));
      }
      if (cmp !== 0) return level.direction === "asc" ? cmp : -cmp;
    }
    return 0;
  };
}

// Der einzige inhaltliche Alt-Key-Umzug: quality-gate-Zeitstempel → last_saved.
const migrateKey = (key: string): string =>
  key === "ops.data_quality.last_quality_gate_iso" ? "ops.last_saved_iso" : key;

const isValidLevel = (entry: unknown): entry is SortLevel =>
  Boolean(entry) &&
  typeof entry === "object" &&
  typeof (entry as SortLevel).key === "string" &&
  ((entry as SortLevel).direction === "asc" || (entry as SortLevel).direction === "desc");

/** Liest den gespeicherten Sortierzustand: Array (neu) oder {key,direction} (alt). */
export function migrateSortState(raw: string | null): SortLevel[] {
  if (!raw) return DEFAULT_SORT;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isValidLevel).map((l) => ({ key: migrateKey(l.key), direction: l.direction }));
    }
    if (isValidLevel(parsed)) {
      return [{ key: migrateKey(parsed.key), direction: parsed.direction }];
    }
    return DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}
