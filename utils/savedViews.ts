import type { ActiveFilter } from "./productFilters.ts";
import type { SortLevel } from "./productSort.ts";

/**
 * Gespeicherte Ansichten der Produkttabelle: benannte Filter+Sortier-
 * Kombinationen (das Views-Muster aus Linear/Airtable/Shopify-Admin).
 *
 * Bewusst NUR lokal je Geraet (localStorage): die Server-Persistenz im
 * Nutzerprofil waere eine Aenderung an einer bestehenden Route und braucht
 * eine eigene Owner-Entscheidung (CLAUDE.md Regel 1).
 *
 * Datums-Presets ("Letzte 7 Tage") speichern sich rollierend — ausgewertet
 * wird erst beim Filtern, nicht beim Speichern.
 */

export interface SavedView {
  id: string;
  name: string;
  filters: ActiveFilter[];
  sort: SortLevel[];
  createdAt: string;
}

export const VIEWS_STORAGE_KEY = "avystock:admin-table:views.v1";

interface StorageLike {
  getItem(key: string): string | null;
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => (({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" }) as Record<string, string>)[c] || c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "ansicht";

export function upsertSavedView(
  views: SavedView[],
  name: string,
  filters: ActiveFilter[],
  sort: SortLevel[]
): SavedView[] {
  const trimmed = name.trim();
  if (!trimmed) return views;

  // Gleicher Name = dieselbe Ansicht: ueberschreiben statt doppeln.
  const existingByName = views.find((v) => v.name === trimmed);
  if (existingByName) {
    return views.map((v) =>
      v.id === existingByName.id
        ? { ...v, filters: structuredClone(filters), sort: structuredClone(sort) }
        : v
    );
  }

  let id = slugify(trimmed);
  let suffix = 2;
  const taken = new Set(views.map((v) => v.id));
  while (taken.has(id)) {
    id = `${slugify(trimmed)}-${suffix}`;
    suffix += 1;
  }

  return [
    ...views,
    {
      id,
      name: trimmed,
      filters: structuredClone(filters),
      sort: structuredClone(sort),
      createdAt: new Date().toISOString(),
    },
  ];
}

export function deleteSavedView(views: SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id);
}

export function serializeSavedViews(views: SavedView[]): string {
  return JSON.stringify({ v: 1, views });
}

const isValidView = (entry: unknown): entry is SavedView =>
  Boolean(entry) &&
  typeof entry === "object" &&
  typeof (entry as SavedView).id === "string" &&
  typeof (entry as SavedView).name === "string" &&
  Array.isArray((entry as SavedView).filters) &&
  Array.isArray((entry as SavedView).sort);

export function loadSavedViews(storage: StorageLike | null | undefined): SavedView[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(VIEWS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { views?: unknown }).views)
        ? ((parsed as { views: unknown[] }).views)
        : null;
    if (!list) return [];
    // Kaputte Zeilen einzeln verwerfen, intakte BEHALTEN: der Persist-Effekt
    // schreibt den geladenen Stand sofort zurueck — ein All-or-nothing wuerde
    // wegen einer einzigen Muell-Zeile auch die intakten Ansichten loeschen.
    return list.filter(isValidView);
  } catch {
    return [];
  }
}
