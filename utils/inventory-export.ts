/**
 * Warenbestandsliste — Feldkatalog und Zeilenbau fuer den CSV-Export der
 * Inventar-Ansicht.
 *
 * Bewusst frei von React: der gesamte Teil, der falsch sein KANN (Zahlenformat,
 * EK-Herkunft, Feldauswahl), ist hier isoliert und ohne DOM pruefbar.
 *
 * Die Zugriffsfunktionen spiegeln exakt das, was `components/InventoryView.tsx`
 * in der Tabelle anzeigt. Eine CSV, die der Bildschirmanzeige widerspricht, ist
 * schlimmer als gar keine CSV.
 */

// Explizite .ts-Endungen: so laeuft dieses Modul unter `node --test` ohne
// Bundler (tsconfig erlaubt das via allowImportingTsExtensions).
import type { Product } from "../types";
import { getProductBinCode, getProductBinZone } from "./product.ts";
import { readinessLabel } from "./readiness.ts";

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export type InventoryExportGroup =
  | "identification"
  | "stock"
  | "storage"
  | "pricing"
  | "marketplace"
  | "origin";

export const INVENTORY_EXPORT_GROUP_LABELS: Record<InventoryExportGroup, string> = {
  identification: "Identifikation",
  stock: "Bestand",
  storage: "Lager",
  pricing: "Preise",
  marketplace: "Marktplatz",
  origin: "Herkunft",
};

/** Reihenfolge der Gruppen im Dialog und in der Datei. */
export const INVENTORY_EXPORT_GROUP_ORDER: InventoryExportGroup[] = [
  "identification",
  "stock",
  "storage",
  "pricing",
  "marketplace",
  "origin",
];

/**
 * `integer`/`decimal`/`money` werden je nach Zahlenformat mit Komma oder Punkt
 * geschrieben, `date` als deutsches Datum. `text` bleibt unangetastet.
 */
/**
 * `identifier` ist Text, der NIE als Zahl gelesen werden darf.
 *
 * Excel erkennt reine Ziffernfolgen als Zahl: eine 13-stellige EAN wird zu
 * 4,00638E+12, und bei GTIN-14/UPC-12 fällt die führende Null weg — die Datei
 * sieht danach richtig aus, ist es aber nicht. Anführungszeichen allein helfen
 * nicht, Excel typt auch quotierte Felder.
 *
 * Bewusst nur für ean/gtin/upc/mpn: SKU, Produkt-ID und Kategorie-IDs haben
 * Präfixe bzw. sind kurz, dort wäre der Sonderweg nur Lärm.
 */
export type InventoryExportValueType = "text" | "identifier" | "integer" | "decimal" | "money" | "date";

/** Marktplatz-Zustand eines Produkts, aus der Ansicht hereingereicht. */
export interface InventoryExportMarketplaceFlags {
  isEbayActive: boolean;
  isKauflandActive: boolean;
  isListed: boolean;
  hasErrors: boolean;
  errorCount: number;
}

export interface InventoryExportContext {
  marketplace: (product: Product) => InventoryExportMarketplaceFlags;
}

export interface InventoryExportField {
  key: string;
  label: string;
  group: InventoryExportGroup;
  type: InventoryExportValueType;
  value: (product: Product, ctx: InventoryExportContext) => string | number | null | undefined;
}

export type InventoryExportNumberFormat = "de" | "intl";

export interface InventoryExportPreferences {
  fields: string[];
  numberFormat: InventoryExportNumberFormat;
}

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const firstBin = (product: Product) =>
  Array.isArray(product.storageBins) && product.storageBins.length ? product.storageBins[0] : null;

/**
 * EK-Aufloesung samt Herkunft.
 *
 * `buyPrice` ist der echte Einkaufspreis. Fehlt er, zeigt die Inventar-Tabelle
 * den recherchierten Marktpreis (`lowest_price.amount`) an derselben Stelle —
 * das ist NICHT dasselbe. Der Export uebernimmt den Wert, damit CSV und Tabelle
 * uebereinstimmen, macht die Herkunft aber ueber eine eigene Spalte sichtbar.
 * Eine Bestandsliste, die geschaetzte Marktpreise stillschweigend als
 * Einkaufspreise ausgibt, ist ein Beleg-Risiko.
 */
export function resolveBuyPrice(product: Product): {
  amount: number;
  source: "recorded" | "estimated" | "none";
} {
  const pricing = product.details?.pricing as any;
  const recorded = pricing?.buyPrice;
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded > 0) {
    return { amount: recorded, source: "recorded" };
  }
  const estimated = pricing?.lowest_price?.amount;
  if (typeof estimated === "number" && Number.isFinite(estimated) && estimated > 0) {
    return { amount: estimated, source: "estimated" };
  }
  return { amount: 0, source: "none" };
}

const BUY_PRICE_SOURCE_LABELS: Record<"recorded" | "estimated" | "none", string> = {
  recorded: "erfasst",
  estimated: "geschätzt",
  none: "fehlt",
};

// ---------------------------------------------------------------------------
// Feldkatalog
// ---------------------------------------------------------------------------

export const INVENTORY_EXPORT_FIELDS: InventoryExportField[] = [
  // --- Identifikation ---
  { key: "name", label: "Produkt", group: "identification", type: "text", value: (p) => p.identification?.name || "" },
  { key: "brand", label: "Marke", group: "identification", type: "text", value: (p) => p.identification?.brand || "" },
  { key: "sku", label: "SKU", group: "identification", type: "text", value: (p) => p.identification?.sku || "" },
  { key: "ean", label: "EAN", group: "identification", type: "identifier", value: (p) => p.details?.identifiers?.ean || "" },
  { key: "gtin", label: "GTIN", group: "identification", type: "identifier", value: (p) => p.details?.identifiers?.gtin || "" },
  { key: "upc", label: "UPC", group: "identification", type: "identifier", value: (p) => p.details?.identifiers?.upc || "" },
  { key: "mpn", label: "Herstellernummer", group: "identification", type: "identifier", value: (p) => p.details?.identifiers?.mpn || "" },
  { key: "productId", label: "Produkt-ID", group: "identification", type: "text", value: (p) => p.id || "" },
  { key: "category", label: "Kategorie", group: "identification", type: "text", value: (p) => p.identification?.category || "" },
  { key: "categoryId", label: "eBay-Kategorie-ID", group: "identification", type: "text", value: (p) => p.details?.categoryId || "" },
  { key: "conditionId", label: "Zustand-ID", group: "identification", type: "text", value: (p) => p.details?.conditionId || "" },

  // --- Bestand ---
  { key: "quantity", label: "Menge", group: "stock", type: "integer", value: (p) => p.inventory?.quantity ?? 0 },
  {
    key: "available",
    label: "Verfügbar",
    group: "stock",
    type: "integer",
    value: (p) => p.inventory?.availableQuantity ?? p.inventory?.quantity ?? 0,
  },
  { key: "reserved", label: "Reserviert", group: "stock", type: "integer", value: (p) => p.inventory?.reservedQuantity ?? 0 },
  { key: "sold", label: "Verkauft", group: "stock", type: "integer", value: (p) => p.inventory?.soldQuantity ?? 0 },
  { key: "openOrders", label: "Offene Aufträge", group: "stock", type: "integer", value: (p) => p.inventory?.openOrderQuantity ?? 0 },

  // --- Lager ---
  { key: "binCode", label: "Lagerplatz", group: "storage", type: "text", value: (p) => getProductBinCode(p) || "" },
  { key: "zone", label: "Zone", group: "storage", type: "text", value: (p) => getProductBinZone(p) || "" },
  { key: "etage", label: "Etage", group: "storage", type: "text", value: (p) => p.storage?.etage || firstBin(p)?.etage || "" },
  { key: "gang", label: "Gang", group: "storage", type: "text", value: (p) => p.storage?.gang ?? firstBin(p)?.gang ?? "" },
  { key: "regal", label: "Regal", group: "storage", type: "text", value: (p) => p.storage?.regal ?? firstBin(p)?.regal ?? "" },
  { key: "ebene", label: "Ebene", group: "storage", type: "text", value: (p) => p.storage?.ebene || firstBin(p)?.ebene || "" },
  { key: "binCount", label: "Anzahl Lagerplätze", group: "storage", type: "integer", value: (p) => (Array.isArray(p.storageBins) ? p.storageBins.length : 0) },
  { key: "lastMovement", label: "Letzte Bewegung", group: "storage", type: "date", value: (p) => firstBin(p)?.lastUpdatedAt || "" },

  // --- Preise ---
  { key: "buyPrice", label: "EK (€)", group: "pricing", type: "money", value: (p) => resolveBuyPrice(p).amount },
  {
    key: "buyPriceSource",
    label: "EK-Quelle",
    group: "pricing",
    type: "text",
    value: (p) => BUY_PRICE_SOURCE_LABELS[resolveBuyPrice(p).source],
  },
  {
    key: "stockValue",
    label: "Bestandswert (€)",
    group: "pricing",
    type: "money",
    value: (p) => num(p.inventory?.quantity) * resolveBuyPrice(p).amount,
  },
  { key: "sellPrice", label: "VK (€)", group: "pricing", type: "money", value: (p) => (p.details?.pricing as any)?.sellPrice ?? "" },
  { key: "marketPrice", label: "Marktpreis (€)", group: "pricing", type: "money", value: (p) => (p.details?.pricing as any)?.lowest_price?.amount ?? "" },
  { key: "weight", label: "Gewicht (kg)", group: "pricing", type: "decimal", value: (p) => p.details?.weight ?? "" },

  // --- Marktplatz ---
  {
    key: "ebayStatus",
    label: "eBay",
    group: "marketplace",
    type: "text",
    value: (p, ctx) => {
      const mp = ctx.marketplace(p);
      if (mp.isEbayActive) return "Aktiv";
      return p.marketplace_listings?.ebay?.validation && !p.marketplace_listings.ebay.validation.ready
        ? "Fehler"
        : "Nicht gelistet";
    },
  },
  {
    key: "kauflandStatus",
    label: "Kaufland",
    group: "marketplace",
    type: "text",
    value: (p, ctx) => {
      const mp = ctx.marketplace(p);
      if (mp.isKauflandActive) return "Aktiv";
      return p.marketplace_listings?.kaufland?.validation && !p.marketplace_listings.kaufland.validation.ready
        ? "Fehler"
        : "Nicht gelistet";
    },
  },
  { key: "isListed", label: "Gelistet", group: "marketplace", type: "text", value: (p, ctx) => (ctx.marketplace(p).isListed ? "Ja" : "Nein") },
  { key: "listingErrors", label: "Listing-Fehler", group: "marketplace", type: "integer", value: (p, ctx) => ctx.marketplace(p).errorCount },

  // --- Herkunft ---
  { key: "sourceLot", label: "Los", group: "origin", type: "text", value: (p) => p.ops?.sourceLot || "" },
  { key: "sourceLotAt", label: "Los zugeordnet am", group: "origin", type: "date", value: (p) => p.ops?.sourceLotAt || "" },
  { key: "readiness", label: "Bereitschaft", group: "origin", type: "text", value: (p) => readinessLabel(p.ops?.readiness) },
  { key: "lastSaved", label: "Zuletzt gespeichert", group: "origin", type: "date", value: (p) => p.ops?.last_saved_iso || "" },
  { key: "manufacturer", label: "Hersteller", group: "origin", type: "text", value: (p) => p.details?.gpsr?.manufacturer_name || "" },
];

const FIELD_BY_KEY = new Map(INVENTORY_EXPORT_FIELDS.map((f) => [f.key, f]));

/** Vorauswahl = die Spalten, die die Inventar-Tabelle heute zeigt, plus EK-Quelle. */
export const INVENTORY_EXPORT_DEFAULT_FIELDS: string[] = [
  "name",
  "brand",
  "sku",
  "binCode",
  "quantity",
  "available",
  "buyPrice",
  "buyPriceSource",
  "stockValue",
  "ebayStatus",
  "kauflandStatus",
];

// ---------------------------------------------------------------------------
// Formatierung
// ---------------------------------------------------------------------------

/**
 * Zahl als CSV-Zelle.
 *
 * Ohne Tausendertrenner — der zerlegt beim Import jede Zahl in zwei Zellen.
 * Deutsches Excel liest "18.99" als Text oder als 18; darum ist "de" (Komma)
 * die Vorgabe, passend zum Semikolon-Trenner und BOM aus `csv-export.ts`.
 */
export function formatExportNumber(
  value: number,
  type: InventoryExportValueType,
  format: InventoryExportNumberFormat
): string {
  const digits = type === "integer" ? 0 : 2;
  const fixed = value.toFixed(digits);
  return format === "de" ? fixed.replace(".", ",") : fixed;
}

/** ISO-Zeitstempel als deutsches Datum. Unlesbares bleibt unveraendert stehen. */
export function formatExportDate(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function formatExportCell(
  raw: string | number | null | undefined,
  type: InventoryExportValueType,
  format: InventoryExportNumberFormat
): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (type === "date") return formatExportDate(raw);
  if (type === "identifier") {
    const value = String(raw);
    // Nur im Excel-Format: LibreOffice und Fremdsysteme (Steuerberater,
    // Warenwirtschaft) werten Formeln beim CSV-Import nicht aus und würden
    // ="…" wörtlich anzeigen. Dieselbe Trennlinie zieht die Zahlenformatierung
    // ohnehin schon.
    return format === "de" ? `="${value}"` : value;
  }
  if (type === "integer" || type === "decimal" || type === "money") {
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n)) return String(raw);
    return formatExportNumber(n, type, format);
  }
  return String(raw);
}

// ---------------------------------------------------------------------------
// Zeilenbau
// ---------------------------------------------------------------------------

/** Unbekannte Schluessel fallen weg, die Reihenfolge des Katalogs gewinnt. */
export function resolveFields(keys: string[]): InventoryExportField[] {
  const wanted = new Set(keys);
  return INVENTORY_EXPORT_FIELDS.filter((f) => wanted.has(f.key));
}

export function buildInventoryExport(
  products: Product[],
  fieldKeys: string[],
  ctx: InventoryExportContext,
  numberFormat: InventoryExportNumberFormat = "de"
): { headers: string[]; rows: string[][] } {
  const fields = resolveFields(fieldKeys);
  const headers = fields.map((f) => f.label);
  const rows = products.map((product) =>
    fields.map((field) => {
      try {
        return formatExportCell(field.value(product, ctx), field.type, numberFormat);
      } catch {
        // Ein kaputtes Einzelfeld darf nie den ganzen Export kippen.
        return "";
      }
    })
  );
  return { headers, rows };
}

export function buildInventoryExportFilename(scope: "filtered" | "all", now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `warenbestand-${scope === "all" ? "gesamt" : "auswahl"}-${day}.csv`;
}

// ---------------------------------------------------------------------------
// Gespeicherte Auswahl
// ---------------------------------------------------------------------------

export const INVENTORY_EXPORT_STORAGE_KEY = "avystock:inventory-export:preferences";

export const INVENTORY_EXPORT_DEFAULT_PREFERENCES: InventoryExportPreferences = {
  fields: INVENTORY_EXPORT_DEFAULT_FIELDS,
  numberFormat: "de",
};

/**
 * Gespeicherte Auswahl lesen.
 *
 * Spaeter ergaenzte Felder werden BEWUSST nicht nachtraeglich eingemischt: wer
 * die Datei regelmaessig woanders einliest, bekaeme sonst ohne Zutun eine neue
 * Spalte. Unbekannte Schluessel fallen weg, damit ein umbenanntes Feld keine
 * leere Spalte hinterlaesst.
 */
export function loadInventoryExportPreferences(
  storage?: Pick<Storage, "getItem"> | null
): InventoryExportPreferences {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return { ...INVENTORY_EXPORT_DEFAULT_PREFERENCES };
  try {
    const raw = store.getItem(INVENTORY_EXPORT_STORAGE_KEY);
    if (!raw) return { ...INVENTORY_EXPORT_DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw);
    const fields = Array.isArray(parsed?.fields)
      ? parsed.fields.filter((k: unknown) => typeof k === "string" && FIELD_BY_KEY.has(k))
      : [];
    return {
      fields: fields.length ? fields : INVENTORY_EXPORT_DEFAULT_FIELDS,
      numberFormat: parsed?.numberFormat === "intl" ? "intl" : "de",
    };
  } catch {
    return { ...INVENTORY_EXPORT_DEFAULT_PREFERENCES };
  }
}

export function saveInventoryExportPreferences(
  prefs: InventoryExportPreferences,
  storage?: Pick<Storage, "setItem"> | null
): void {
  const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!store) return;
  try {
    store.setItem(INVENTORY_EXPORT_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Privater Modus / volles Kontingent — kein Grund, den Export zu verweigern.
  }
}
