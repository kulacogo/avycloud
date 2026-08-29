import type { Product } from "../types.ts";
import { getProductQuantity, getProductAvailableQuantity } from "./product.ts";
import { normalizeBarcode, isValidGtin } from "./gtin.ts";
import { normalizeReadiness, READINESS_LABELS } from "./readiness.ts";
import { resolveSellPrice } from "./sellPrice.ts";
// Die Preis-Spalte der Produkttabelle liest den effektiven Preis ueber die
// Registry — die Kette selbst liegt in ./sellPrice.ts, damit der CSV-Export
// dieselbe Lesart benutzen kann, ohne die ganze Registry zu laden.
export { effectiveSellPrice, resolveSellPrice, type SellPriceSource } from "./sellPrice.ts";

/**
 * DIE eine Filter-Registry der Produkttabelle.
 *
 * Vorher lebte dieselbe Filterliste als VIER handgepflegte Aufzaehlungen in
 * AdminTable/AdminTableFilters (Zaehler, Chips, zwei Resets) — beim Fix vom
 * 2026-?? fehlten dort bereits zwei Filter. Zaehler, Chips, Reset und das
 * Filter-Predicate leiten sich hier aus EINER Definition je Dimension ab.
 *
 * Alles ist pur und ohne React, damit `node --test` es direkt ausfuehren kann.
 */

export type NumberOp = "gt" | "gte" | "lt" | "lte" | "eq" | "ne" | "between";

export interface NumberCompareValue {
  op: NumberOp;
  a: number | null;
  b: number | null;
}

export type DatePreset =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thisMonth"
  | "lastMonth"
  | "custom";

export interface DateRangeValue {
  preset: DatePreset | null;
  /** Nur bei preset "custom": lokales Datum als YYYY-MM-DD. */
  from: string | null;
  to: string | null;
}

export type FilterValue = string | string[] | NumberCompareValue | DateRangeValue;

export interface ActiveFilter {
  id: string;
  value: FilterValue;
}

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

/**
 * Live-Kontext, den einzelne Predicates brauchen (Marktplatz-Indizes,
 * Erfasser-Aufloesung). `now` wird injiziert, damit Datums-Presets testbar
 * sind und gespeicherte Ansichten rollierend bleiben.
 */
export interface FilterContext {
  now: Date;
  myInitials: string;
  ebaySkuUrlMap: ReadonlyMap<string, unknown>;
  ebayProductIdMap: ReadonlyMap<string, unknown>;
  ebayActiveItemIds: ReadonlySet<string>;
  kauflandSkuSet: ReadonlySet<string>;
  kauflandEanSet: ReadonlySet<string>;
  resolveErfasstVon: (p: Product) => string;
  getDisplayCategory: (p: Product) => string;
}

export const NONE_SENTINEL = "__none__";
export const FILTERS_STORAGE_KEY = "avystock:admin-table:filters.v2";

export interface ProductFilterDef {
  id: string;
  label: string;
  group: string;
  kind: "select" | "multi" | "numberCompare" | "dateRange";
  adminOnly?: boolean;
  /** Einheit fuer Zahlenfilter-Chips, z. B. "€" oder "%". */
  unit?: string;
  /** Feste Optionen (kind "select"). */
  selectOptions?: FilterOption[];
  /** Dynamische Optionen mit Counts (kind "multi" / datengetriebene Selects). */
  buildOptions?: (products: Product[], ctx: FilterContext) => FilterOption[];
  /** Anzeigename eines Multi-Werts (Sentinel-Aufloesung, Zustands-Namen). */
  optionLabel?: (value: string) => string;
  defaultValue: FilterValue;
  isActive: (value: FilterValue | undefined) => boolean;
  predicate: (p: Product, value: FilterValue, ctx: FilterContext) => boolean;
  chipLabel: (value: FilterValue, ctx: FilterContext) => string;
}

// ---------------------------------------------------------------------------
// Zahlenvergleich
// ---------------------------------------------------------------------------

const NUMBER_OP_SYMBOL: Record<Exclude<NumberOp, "between">, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
  ne: "≠",
};

export const NUMBER_OP_LABELS: Array<{ value: NumberOp; label: string }> = [
  { value: "gt", label: "größer als" },
  { value: "gte", label: "mindestens" },
  { value: "lt", label: "kleiner als" },
  { value: "lte", label: "höchstens" },
  { value: "eq", label: "genau" },
  { value: "ne", label: "ungleich" },
  { value: "between", label: "zwischen" },
];

const isNumberCompareActive = (v: NumberCompareValue): boolean =>
  v.a !== null || (v.op === "between" && v.b !== null);

/**
 * `value` ist der Produktwert (null = Produkt hat keinen Wert). Ein inaktiver
 * Vergleich trifft alles; ein aktiver Vergleich trifft fehlende Werte nie.
 */
export function matchesNumberCompare(value: number | null, cmp: NumberCompareValue): boolean {
  if (!isNumberCompareActive(cmp)) return true;
  if (value === null || !Number.isFinite(value)) return false;
  if (cmp.op === "between") {
    let lo = cmp.a ?? Number.NEGATIVE_INFINITY;
    let hi = cmp.b ?? Number.POSITIVE_INFINITY;
    // Verdrehte Grenzen tauschen statt eine leere Spanne zu erzeugen.
    if (lo > hi) [lo, hi] = [hi, lo];
    return value >= lo && value <= hi;
  }
  const a = cmp.a as number;
  switch (cmp.op) {
    case "gt":
      return value > a;
    case "gte":
      return value >= a;
    case "lt":
      return value < a;
    case "lte":
      return value <= a;
    case "eq":
      return value === a;
    case "ne":
      return value !== a;
    default:
      return true;
  }
}

const formatNumberDe = (n: number): string =>
  new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(n);

export function numberCompareChipText(label: string, v: NumberCompareValue, unit?: string): string {
  const suffix = unit ? ` ${unit}` : "";
  if (v.op === "between") {
    if (v.a !== null && v.b !== null) {
      const lo = Math.min(v.a, v.b);
      const hi = Math.max(v.a, v.b);
      return `${label} ${formatNumberDe(lo)}–${formatNumberDe(hi)}${suffix}`;
    }
    if (v.a !== null) return `${label} ≥ ${formatNumberDe(v.a)}${suffix}`;
    if (v.b !== null) return `${label} ≤ ${formatNumberDe(v.b)}${suffix}`;
    return label;
  }
  if (v.a === null) return label;
  return `${label} ${NUMBER_OP_SYMBOL[v.op]} ${formatNumberDe(v.a)}${suffix}`;
}

// ---------------------------------------------------------------------------
// Zeitraeume
// ---------------------------------------------------------------------------

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: "Heute",
  yesterday: "Gestern",
  last7: "Letzte 7 Tage",
  last30: "Letzte 30 Tage",
  thisMonth: "Dieser Monat",
  lastMonth: "Letzter Monat",
  custom: "Zeitraum",
};

const startOfDayMs = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();
const endOfDayMs = (y: number, m: number, d: number): number => new Date(y, m, d + 1).getTime() - 1;

const parseLocalDate = (raw: string | null): { y: number; m: number; d: number } | null => {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
};

const isDateRangeActive = (v: DateRangeValue): boolean =>
  // "custom" ohne Datumsangaben ist NICHT aktiv — sonst entsteht ein Chip,
  // der zaehlt und persistiert wird, aber nichts filtert.
  v.preset !== null && v.preset !== "custom" ? true : Boolean(v.from) || Boolean(v.to);

/** Liefert die lokale Zeitspanne [fromMs, toMs] oder null, wenn inaktiv. */
export function resolveDateRange(v: DateRangeValue, now: Date): { fromMs: number; toMs: number } | null {
  if (!isDateRangeActive(v)) return null;
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  switch (v.preset) {
    case "today":
      return { fromMs: startOfDayMs(y, m, d), toMs: endOfDayMs(y, m, d) };
    case "yesterday":
      return { fromMs: startOfDayMs(y, m, d - 1), toMs: endOfDayMs(y, m, d - 1) };
    case "last7":
      return { fromMs: startOfDayMs(y, m, d - 6), toMs: endOfDayMs(y, m, d) };
    case "last30":
      return { fromMs: startOfDayMs(y, m, d - 29), toMs: endOfDayMs(y, m, d) };
    case "thisMonth":
      return { fromMs: startOfDayMs(y, m, 1), toMs: endOfDayMs(y, m + 1, 0) };
    case "lastMonth":
      return { fromMs: startOfDayMs(y, m - 1, 1), toMs: endOfDayMs(y, m, 0) };
    default: {
      const from = parseLocalDate(v.from);
      const to = parseLocalDate(v.to);
      if (!from && !to) return null;
      let fromMs = from ? startOfDayMs(from.y, from.m, from.d) : Number.NEGATIVE_INFINITY;
      let toMs = to ? endOfDayMs(to.y, to.m, to.d) : Number.POSITIVE_INFINITY;
      // Verdrehte Grenzen tauschen — gleiche Regel wie beim Zahlen-"zwischen".
      if (fromMs > toMs) {
        const swappedFrom = to ? startOfDayMs(to.y, to.m, to.d) : Number.NEGATIVE_INFINITY;
        const swappedTo = from ? endOfDayMs(from.y, from.m, from.d) : Number.POSITIVE_INFINITY;
        fromMs = swappedFrom;
        toMs = swappedTo;
      }
      return { fromMs, toMs };
    }
  }
}

export function matchesDateRange(iso: string | null | undefined, v: DateRangeValue, now: Date): boolean {
  const range = resolveDateRange(v, now);
  if (!range) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= range.fromMs && t <= range.toMs;
}

const formatLocalDateDe = (raw: string | null): string => {
  const parsed = parseLocalDate(raw);
  if (!parsed) return "";
  const dd = String(parsed.d).padStart(2, "0");
  const mm = String(parsed.m + 1).padStart(2, "0");
  return `${dd}.${mm}.${parsed.y}`;
};

export function dateRangeChipText(label: string, v: DateRangeValue): string {
  if (v.preset && v.preset !== "custom") {
    return `${label}: ${DATE_PRESET_LABELS[v.preset]}`;
  }
  const from = formatLocalDateDe(v.from);
  const to = formatLocalDateDe(v.to);
  if (from && to) return `${label}: ${from}–${to}`;
  if (from) return `${label}: ab ${from}`;
  if (to) return `${label}: bis ${to}`;
  return label;
}

/**
 * Segmentierter Chip-Inhalt (Linear-Muster): [Feld] [Operator] [Wert] als
 * getrennt darstell- und klickbare Teile. `op` bleibt beim Zahlenvergleich
 * das Symbol — dieses Segment ist im UI klickbar und wechselt den Operator.
 */
export interface ChipSegmentsResult {
  field: string;
  op: string | null;
  value: string;
}

const CHIP_EMPTY_VALUE = "wählen …";

export function chipSegments(def: ProductFilterDef, value: FilterValue, _ctx: FilterContext): ChipSegmentsResult {
  const unitSuffix = def.unit ? ` ${def.unit}` : "";
  switch (def.kind) {
    case "numberCompare": {
      const v = value as NumberCompareValue;
      if (v.op === "between") {
        if (v.a !== null && v.b !== null) {
          const lo = Math.min(v.a, v.b);
          const hi = Math.max(v.a, v.b);
          return { field: def.label, op: "zwischen", value: `${formatNumberDe(lo)}–${formatNumberDe(hi)}${unitSuffix}` };
        }
        if (v.a !== null) return { field: def.label, op: "≥", value: `${formatNumberDe(v.a)}${unitSuffix}` };
        if (v.b !== null) return { field: def.label, op: "≤", value: `${formatNumberDe(v.b)}${unitSuffix}` };
        return { field: def.label, op: "zwischen", value: CHIP_EMPTY_VALUE };
      }
      if (v.a === null) return { field: def.label, op: NUMBER_OP_SYMBOL[v.op], value: CHIP_EMPTY_VALUE };
      return { field: def.label, op: NUMBER_OP_SYMBOL[v.op], value: `${formatNumberDe(v.a)}${unitSuffix}` };
    }
    case "dateRange": {
      const v = value as DateRangeValue;
      let display = CHIP_EMPTY_VALUE;
      if (v.preset && v.preset !== "custom") {
        display = DATE_PRESET_LABELS[v.preset];
      } else {
        const from = formatLocalDateDe(v.from);
        const to = formatLocalDateDe(v.to);
        if (from && to) display = `${from}–${to}`;
        else if (from) display = `ab ${from}`;
        else if (to) display = `bis ${to}`;
      }
      return { field: def.label, op: "ist", value: display };
    }
    case "multi": {
      const values = Array.isArray(value) ? value : [];
      const labelFor = def.optionLabel ?? ((raw: string) => raw);
      if (values.length === 0) return { field: def.label, op: "ist", value: CHIP_EMPTY_VALUE };
      const first = labelFor(values[0]);
      return {
        field: def.label,
        op: values.length > 1 ? "ist eines von" : "ist",
        value: values.length > 1 ? `${first} +${values.length - 1}` : first,
      };
    }
    default: {
      const raw = typeof value === "string" ? value : "";
      const opt = def.selectOptions?.find((o) => o.value === raw);
      return { field: def.label, op: "ist", value: opt?.label ?? (raw || CHIP_EMPTY_VALUE) };
    }
  }
}

// ---------------------------------------------------------------------------
// Produkt-Lesehelfer (Paritaet zu den Spalten-Renderern)
// ---------------------------------------------------------------------------

/**
 * Gewicht in kg — EXAKT die Fallback-Kette der Gewicht-Spalte. Der alte Filter
 * las nur `attributes.weight` und widersprach damit der eigenen Anzeige.
 */
export function productWeightKg(p: Product): number | null {
  const d = (p.details || {}) as unknown as Record<string, unknown>;
  const attrs = (d.attributes || {}) as Record<string, unknown>;
  const raw = d.weight ?? attrs.weight ?? attrs["Gewicht (kg)"] ?? attrs["Gewicht"];
  const num = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(num) || num <= 0) {
    return null;
  }
  return num;
}

const normalizeSkuKey = (value?: string | null): string =>
  value ? value.toString().trim().replace(/\s+/g, "").toUpperCase() : "";

const normalizeEanDigits = (value?: string | null): string =>
  value ? value.toString().replace(/\D+/g, "").trim() : "";

const productPrimaryBarcode = (p: Product): string => {
  const codes = p.identification?.barcodes || [];
  const ids = p.details?.identifiers || {};
  return codes[0] || ids.ean || ids.gtin || ids.upc || "";
};

const isValidMarketplaceEan = (value: string): boolean => {
  const digits = normalizeBarcode(value);
  if (!digits) return false;
  if (digits.length !== 13 && digits.length !== 14) return false;
  return isValidGtin(digits);
};

const productBrandKey = (p: Product): string => (p.identification?.brand || "").trim() || NONE_SENTINEL;

const productLotKey = (p: Product): string => (p.ops?.sourceLot || "").trim() || NONE_SENTINEL;

const productConditionId = (p: Product): string => String(p.details?.conditionId || "1000");

const productMpn = (p: Product): string =>
  String(
    p.details?.identifiers?.mpn || ((p as unknown as { identification?: { mpn?: string } }).identification?.mpn ?? "")
  ).trim();

const productImagesCount = (p: Product): number =>
  Array.isArray(p.details?.images) ? p.details.images.length : 0;

const productCreatedAtIso = (p: Product): string | null =>
  ((p.ops || {}) as { created_at_iso?: string | null }).created_at_iso || null;

const productLastSoldIso = (p: Product): string | null => {
  const attrs = (p.details?.attributes || {}) as Record<string, unknown>;
  const raw = attrs.lastSoldAt || attrs.last_sold_at || attrs.lastSold;
  return typeof raw === "string" && raw ? raw : null;
};

const productHasBin = (p: Product): boolean =>
  Boolean(p.storage?.binCode) || (Array.isArray(p.storageBins) && p.storageBins.length > 0);

const productBinCountWithStock = (p: Product): number => {
  const codes = new Set<string>();
  const bins = Array.isArray(p.storageBins) ? p.storageBins : [];
  for (const bin of bins) {
    if (!bin?.code) continue;
    if ((Number(bin.quantity || 0) || 0) > 0) codes.add(String(bin.code).toUpperCase());
  }
  if (codes.size === 0 && p.storage?.binCode) codes.add(String(p.storage.binCode).toUpperCase());
  return codes.size;
};

const productGpsrComplete = (p: Product): boolean => {
  const gpsr = (p.details?.gpsr || {}) as Record<string, unknown>;
  const gs = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return Boolean(
    gs(gpsr.manufacturer_name) &&
      gs(gpsr.manufacturer_address) &&
      gs(gpsr.manufacturer_city) &&
      gs(gpsr.manufacturer_postalcode) &&
      (gs(gpsr.entity_country) || gs(gpsr.country_code)) &&
      (gs(gpsr.email) || gs(gpsr.manufacturer_phone))
  );
};

export const isEbayListed = (p: Product, ctx: FilterContext): boolean => {
  const skuCandidates = Array.from(
    new Set(
      [
        normalizeSkuKey(p.details?.identifiers?.sku),
        normalizeSkuKey(p.identification?.sku),
      ].filter(Boolean)
    )
  );
  const marketplaceItemId = String(
    ((p as unknown as { marketplace?: { ebay?: { itemId?: string } } }).marketplace?.ebay?.itemId ?? "")
  ).trim();
  return Boolean(
    skuCandidates.some((sku) => ctx.ebaySkuUrlMap.has(sku)) ||
      ctx.ebayProductIdMap.has(p.id) ||
      (marketplaceItemId && ctx.ebayActiveItemIds.has(marketplaceItemId))
  );
};

export const isKauflandListed = (p: Product, ctx: FilterContext): boolean => {
  const sku = normalizeSkuKey(p.identification?.sku || p.details?.identifiers?.sku || p.id || "");
  const eanCandidates = Array.from(
    new Set(
      [
        p.details?.identifiers?.ean,
        p.details?.identifiers?.gtin,
        p.details?.identifiers?.upc,
        ...(p.identification?.barcodes || []),
      ]
        .map((v) => normalizeEanDigits(String(v || "")))
        .filter(Boolean)
    )
  );
  return Boolean((sku && ctx.kauflandSkuSet.has(sku)) || eanCandidates.some((ean) => ctx.kauflandEanSet.has(ean)));
};

// ---------------------------------------------------------------------------
// Definitions-Fabriken
// ---------------------------------------------------------------------------

const selectActive = (v: FilterValue | undefined): boolean => typeof v === "string" && v !== "" && v !== "all";
const multiActive = (v: FilterValue | undefined): boolean => Array.isArray(v) && v.length > 0;

const selectChip = (def: Pick<ProductFilterDef, "label" | "selectOptions">, v: FilterValue): string => {
  const value = typeof v === "string" ? v : "";
  const opt = def.selectOptions?.find((o) => o.value === value);
  return `${def.label}: ${opt?.label ?? value}`;
};

const multiChip = (label: string, v: FilterValue, labelFor: (value: string) => string): string => {
  const values = Array.isArray(v) ? v : [];
  if (values.length === 0) return label;
  const first = labelFor(values[0]);
  return values.length === 1 ? `${label}: ${first}` : `${label}: ${first} +${values.length - 1}`;
};

const countedOptions = (
  products: Product[],
  keyOf: (p: Product) => string,
  labelFor: (value: string) => string
): FilterOption[] => {
  const counts = new Map<string, number>();
  for (const p of products) {
    const key = keyOf(p);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => {
    if (a[0] === NONE_SENTINEL) return 1;
    if (b[0] === NONE_SENTINEL) return -1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0], "de");
  });
  return entries.map(([value, count]) => ({ value, label: labelFor(value), count }));
};

interface NumberDefArgs {
  id: string;
  label: string;
  group: string;
  unit?: string;
  read: (p: Product) => number | null;
}

const numberDef = ({ id, label, group, unit, read }: NumberDefArgs): ProductFilterDef => ({
  id,
  label,
  group,
  kind: "numberCompare",
  unit,
  defaultValue: { op: "gte", a: null, b: null },
  isActive: (v) => Boolean(v) && isNumberCompareActive(v as NumberCompareValue),
  predicate: (p, v) => matchesNumberCompare(read(p), v as NumberCompareValue),
  chipLabel: (v) => numberCompareChipText(label, v as NumberCompareValue, unit),
});

interface DateDefArgs {
  id: string;
  label: string;
  group: string;
  read: (p: Product) => string | null;
}

const dateDef = ({ id, label, group, read }: DateDefArgs): ProductFilterDef => ({
  id,
  label,
  group,
  kind: "dateRange",
  defaultValue: { preset: null, from: null, to: null },
  isActive: (v) => Boolean(v) && isDateRangeActive(v as DateRangeValue),
  predicate: (p, v, ctx) => matchesDateRange(read(p), v as DateRangeValue, ctx.now),
  chipLabel: (v) => dateRangeChipText(label, v as DateRangeValue),
});

// eBay-Zustands-IDs, die in unserem Bestand vorkommen koennen. Die exakten
// kategorieabhaengigen Namen kennt nur backend/lib/ebay-conditions.js — fuer
// den Filter reicht die gaengige Grundbedeutung.
const CONDITION_LABELS: Record<string, string> = {
  "1000": "Neu",
  "1500": "Neu (andere)",
  "1750": "Neu mit Fehlern",
  "2500": "Generalüberholt",
  "2750": "Wie neu",
  "2990": "Hervorragend",
  "3000": "Gebraucht",
  "3010": "Sehr gut",
  "4000": "Gut",
  "5000": "Akzeptabel",
  "6000": "Defekt / als Ersatzteil",
  "7000": "Defekt / als Ersatzteil",
};

const GROUP_STATUS = "Status & Personen";
const GROUP_BESTAND = "Bestand & Lager";
const GROUP_PREIS = "Preis";
const GROUP_TERMINE = "Termine";
const GROUP_DATEN = "Daten & Qualität";
const GROUP_MARKT = "Marktplätze";

const DEFS: ProductFilterDef[] = [
  {
    id: "status",
    label: "Status",
    group: GROUP_STATUS,
    kind: "select",
    selectOptions: [
      { value: "pending", label: READINESS_LABELS.pending },
      { value: "in_progress", label: READINESS_LABELS.in_progress },
      { value: "ready", label: READINESS_LABELS.ready },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => normalizeReadiness(p.ops?.readiness) === v,
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  {
    id: "category",
    label: "Kategorie",
    group: GROUP_DATEN,
    kind: "multi",
    defaultValue: [],
    isActive: multiActive,
    predicate: (p, v, ctx) => {
      const selection = new Set((v as string[]).map((s) => String(s).trim()).filter(Boolean));
      if (selection.size === 0) return true;
      const resolved = ctx.getDisplayCategory(p);
      const raw = (resolved && resolved !== "—" ? resolved : "Unbekannt").toString();
      const parts = raw.split(">").map((s) => s.trim()).filter(Boolean);
      const top = parts[0] || "Unbekannt";
      const sub = parts.length >= 2 ? parts[1] : "";
      return selection.has(top) || (sub ? selection.has(`${top} > ${sub}`) : false);
    },
    optionLabel: (value) => value,
    chipLabel: (v) => multiChip("Kategorie", v, (value) => value),
  },
  {
    id: "editor",
    label: "Bearbeiter",
    group: GROUP_STATUS,
    kind: "multi",
    defaultValue: [],
    isActive: multiActive,
    buildOptions: (products, ctx) => {
      const options = countedOptions(
        products,
        (p) => p.ops?.readiness_editor || NONE_SENTINEL,
        (value) => (value === NONE_SENTINEL ? "Ohne Zuordnung" : value)
      );
      // Eigene Initialen zuoberst — gleiche Ordnung wie der alte Bearbeiter-Popover.
      options.sort((a, b) => {
        if (a.value === ctx.myInitials && b.value !== ctx.myInitials) return -1;
        if (b.value === ctx.myInitials && a.value !== ctx.myInitials) return 1;
        return 0;
      });
      return options;
    },
    predicate: (p, v) => {
      const selection = new Set(v as string[]);
      return selection.has(p.ops?.readiness_editor || NONE_SENTINEL);
    },
    optionLabel: (value) => (value === NONE_SENTINEL ? "Ohne Zuordnung" : value),
    chipLabel: (v) => multiChip("Bearbeiter", v, (value) => (value === NONE_SENTINEL ? "Ohne Zuordnung" : value)),
  },
  {
    id: "erfasser",
    label: "Erfasst von",
    group: GROUP_STATUS,
    kind: "multi",
    adminOnly: true,
    defaultValue: [],
    isActive: multiActive,
    buildOptions: (products, ctx) =>
      countedOptions(
        products,
        (p) => ctx.resolveErfasstVon(p) || NONE_SENTINEL,
        (value) => (value === NONE_SENTINEL ? "Ohne Zuordnung" : value)
      ),
    predicate: (p, v, ctx) => {
      const selection = new Set(v as string[]);
      const name = ctx.resolveErfasstVon(p);
      return selection.has(name || NONE_SENTINEL);
    },
    optionLabel: (value) => (value === NONE_SENTINEL ? "Ohne Zuordnung" : value),
    chipLabel: (v) => multiChip("Erfasst von", v, (value) => (value === NONE_SENTINEL ? "Ohne Zuordnung" : value)),
  },
  numberDef({ id: "menge", label: "Menge", group: GROUP_BESTAND, read: (p) => getProductQuantity(p) }),
  numberDef({ id: "verfuegbar", label: "Verfügbar", group: GROUP_BESTAND, read: (p) => getProductAvailableQuantity(p) }),
  {
    id: "reserviert",
    label: "Reserviert",
    group: GROUP_BESTAND,
    kind: "select",
    selectOptions: [
      { value: "reserved", label: "> 0" },
      { value: "notReserved", label: "0" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => {
      const reserved = Number(p.inventory?.reservedQuantity || 0) || 0;
      return v === "reserved" ? reserved > 0 : reserved <= 0;
    },
    chipLabel: (v) => (v === "reserved" ? "Reserviert > 0" : "Reserviert = 0"),
  },
  {
    id: "verkauft",
    label: "Verkauft",
    group: GROUP_BESTAND,
    kind: "select",
    selectOptions: [
      { value: "sold", label: "Ja" },
      { value: "unsold", label: "Nein" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => {
      const sold = Number(p.inventory?.soldQuantity || 0) || 0;
      const open = Number(p.inventory?.openOrderQuantity || 0) || 0;
      return v === "sold" ? sold > 0 || open > 0 : sold <= 0 && open <= 0;
    },
    chipLabel: (v) => (v === "sold" ? "Verkauft: Ja" : "Verkauft: Nein"),
  },
  numberDef({
    id: "wareneingang",
    label: "Wareneingang offen",
    group: GROUP_BESTAND,
    read: (p) => Number(p.ops?.pending_intake_quantity) || 0,
  }),
  {
    id: "lagerplatz",
    label: "Lagerplatz",
    group: GROUP_BESTAND,
    kind: "select",
    selectOptions: [
      { value: "withBin", label: "Mit Lagerplatz" },
      { value: "withoutBin", label: "Ohne Lagerplatz" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => (v === "withBin" ? productHasBin(p) : !productHasBin(p)),
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  {
    id: "binSplit",
    label: "Lagerplätze",
    group: GROUP_BESTAND,
    kind: "select",
    selectOptions: [
      { value: "singleBin", label: "Ein Lagerplatz" },
      { value: "multiBin", label: "Mehrere Lagerplätze" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => {
      const count = productBinCountWithStock(p);
      return v === "singleBin" ? count <= 1 : count >= 2;
    },
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  {
    id: "los",
    label: "Los",
    group: GROUP_BESTAND,
    kind: "multi",
    defaultValue: [],
    isActive: multiActive,
    buildOptions: (products) =>
      countedOptions(products, productLotKey, (value) => (value === NONE_SENTINEL ? "Ohne Los" : value)),
    predicate: (p, v) => new Set(v as string[]).has(productLotKey(p)),
    optionLabel: (value) => (value === NONE_SENTINEL ? "Ohne Los" : value),
    chipLabel: (v) => multiChip("Los", v, (value) => (value === NONE_SENTINEL ? "Ohne Los" : value)),
  },
  numberDef({ id: "preis", label: "Preis", group: GROUP_PREIS, unit: "€", read: (p) => resolveSellPrice(p).amount }),
  {
    id: "preisquelle",
    label: "Preisquelle",
    group: GROUP_PREIS,
    kind: "select",
    selectOptions: [
      { value: "confirmed", label: "Bestätigter Verkaufspreis" },
      { value: "market", label: "Nur Marktpreis-Schätzung" },
      { value: "missing", label: "Kein Preis" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => resolveSellPrice(p).source === v,
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  dateDef({ id: "erstellt", label: "Erstellt", group: GROUP_TERMINE, read: productCreatedAtIso }),
  dateDef({ id: "aktualisiert", label: "Aktualisiert", group: GROUP_TERMINE, read: (p) => p.ops?.last_saved_iso || null }),
  dateDef({ id: "zuletztVerkauft", label: "Zuletzt verkauft", group: GROUP_TERMINE, read: productLastSoldIso }),
  {
    id: "marke",
    label: "Marke",
    group: GROUP_DATEN,
    kind: "multi",
    defaultValue: [],
    isActive: multiActive,
    buildOptions: (products) =>
      countedOptions(products, productBrandKey, (value) => (value === NONE_SENTINEL ? "Ohne Marke" : value)),
    predicate: (p, v) => new Set(v as string[]).has(productBrandKey(p)),
    optionLabel: (value) => (value === NONE_SENTINEL ? "Ohne Marke" : value),
    chipLabel: (v) => multiChip("Marke", v, (value) => (value === NONE_SENTINEL ? "Ohne Marke" : value)),
  },
  {
    id: "zustand",
    label: "Zustand",
    group: GROUP_DATEN,
    kind: "multi",
    defaultValue: [],
    isActive: multiActive,
    buildOptions: (products) =>
      countedOptions(products, productConditionId, (value) => CONDITION_LABELS[value] || `Zustand ${value}`),
    predicate: (p, v) => new Set(v as string[]).has(productConditionId(p)),
    optionLabel: (value) => CONDITION_LABELS[value] || `Zustand ${value}`,
    chipLabel: (v) => multiChip("Zustand", v, (value) => CONDITION_LABELS[value] || value),
  },
  {
    id: "mpn",
    label: "Herstellernummer",
    group: GROUP_DATEN,
    kind: "select",
    selectOptions: [
      { value: "withMpn", label: "Vorhanden" },
      { value: "noMpn", label: "Fehlt" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => (v === "withMpn" ? productMpn(p).length > 0 : productMpn(p).length === 0),
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  {
    id: "ean",
    label: "EAN/GTIN",
    group: GROUP_DATEN,
    kind: "select",
    selectOptions: [
      { value: "valid", label: "Gültig" },
      { value: "invalid", label: "Ungültig" },
      { value: "missing", label: "Fehlt" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => {
      const barcode = productPrimaryBarcode(p);
      const present = barcode.length > 0;
      const valid = present && isValidMarketplaceEan(barcode);
      if (v === "valid") return valid;
      if (v === "invalid") return present && !valid;
      return !present;
    },
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  {
    id: "gewicht",
    label: "Gewicht",
    group: GROUP_DATEN,
    kind: "select",
    selectOptions: [
      { value: "withWeight", label: "Vorhanden" },
      { value: "noWeight", label: "Fehlt" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => (v === "withWeight" ? productWeightKg(p) !== null : productWeightKg(p) === null),
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  numberDef({ id: "bilder", label: "Bilder", group: GROUP_DATEN, read: productImagesCount }),
  {
    id: "gpsr",
    label: "GPSR",
    group: GROUP_DATEN,
    kind: "select",
    selectOptions: [
      { value: "complete", label: "Vollständig" },
      { value: "incomplete", label: "Unvollständig" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v) => (v === "complete" ? productGpsrComplete(p) : !productGpsrComplete(p)),
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  numberDef({
    id: "vollstaendigkeit",
    label: "Vollständigkeit",
    group: GROUP_DATEN,
    unit: "%",
    read: (p) => {
      const percent = Number(p.completeness?.percent);
      return Number.isFinite(percent) ? percent : null;
    },
  }),
  {
    id: "ebay",
    label: "eBay",
    group: GROUP_MARKT,
    kind: "select",
    selectOptions: [
      { value: "listed", label: "Gelistet" },
      { value: "notListed", label: "Nicht gelistet" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    // Live-Index ist die Wahrheit; ops.listingStatus kann stale sein und ist
    // als Filterquelle VERBOTEN (Incident 2026-08-20).
    predicate: (p, v, ctx) => (v === "listed" ? isEbayListed(p, ctx) : !isEbayListed(p, ctx)),
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
  {
    id: "kaufland",
    label: "Kaufland",
    group: GROUP_MARKT,
    kind: "select",
    selectOptions: [
      { value: "listed", label: "Gelistet" },
      { value: "notListed", label: "Nicht gelistet" },
    ],
    defaultValue: "all",
    isActive: selectActive,
    predicate: (p, v, ctx) => (v === "listed" ? isKauflandListed(p, ctx) : !isKauflandListed(p, ctx)),
    chipLabel(v) {
      return selectChip(this, v);
    },
  },
];

export function getFilterDefs(isAdmin: boolean): ProductFilterDef[] {
  return isAdmin ? DEFS : DEFS.filter((d) => !d.adminOnly);
}

export function getFilterDef(id: string): ProductFilterDef | undefined {
  return DEFS.find((d) => d.id === id);
}

// ---------------------------------------------------------------------------
// Anwenden
// ---------------------------------------------------------------------------

export function applyProductFilters(
  products: Product[],
  active: ActiveFilter[],
  ctx: FilterContext,
  opts: { isAdmin?: boolean } = {}
): Product[] {
  const isAdmin = opts.isAdmin !== false;
  const defsById = new Map(getFilterDefs(isAdmin).map((d) => [d.id, d]));
  const checks: Array<{ def: ProductFilterDef; value: FilterValue }> = [];
  for (const entry of active) {
    const def = defsById.get(entry.id);
    // Unbekannte IDs (alte Speicherstaende) und fuer die Rolle unsichtbare
    // Filter werden ignoriert statt still falsch zu filtern.
    if (!def || !def.isActive(entry.value)) continue;
    checks.push({ def, value: entry.value });
  }
  if (checks.length === 0) return products;
  return products.filter((p) => checks.every((c) => c.def.predicate(p, c.value, ctx)));
}

// ---------------------------------------------------------------------------
// Persistenz + Migration der Alt-Schluessel
// ---------------------------------------------------------------------------

interface StorageLike {
  getItem(key: string): string | null;
}

const KNOWN_NUMBER_OPS = new Set(NUMBER_OP_LABELS.map((o) => o.value));
const KNOWN_DATE_PRESETS = new Set(Object.keys(DATE_PRESET_LABELS));

/**
 * Passt die Wert-FORM zum kind der Definition? Schuetzt gegen alte/kaputte
 * Speicherstaende — ein falsch getypter Wert wuerde sonst als "aktiv" gelten
 * und Chips wie "Menge undefined" rendern.
 */
export function isValidValueForDef(def: ProductFilterDef, value: unknown): value is FilterValue {
  switch (def.kind) {
    case "select":
      return (
        typeof value === "string" &&
        (value === "all" || (def.selectOptions ?? []).some((o) => o.value === value))
      );
    case "multi":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "numberCompare": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const v = value as NumberCompareValue;
      const okNum = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n));
      return typeof v.op === "string" && KNOWN_NUMBER_OPS.has(v.op) && okNum(v.a) && okNum(v.b);
    }
    case "dateRange": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const v = value as DateRangeValue;
      const okDate = (d: unknown) => d === null || typeof d === "string";
      return (v.preset === null || (typeof v.preset === "string" && KNOWN_DATE_PRESETS.has(v.preset))) && okDate(v.from) && okDate(v.to);
    }
    default:
      return false;
  }
}

export function serializeFilters(active: ActiveFilter[]): string {
  return JSON.stringify({ v: 2, filters: active });
}

export function deserializeFilters(raw: string | null): ActiveFilter[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { filters?: unknown }).filters)
        ? ((parsed as { filters: unknown[] }).filters)
        : null;
    if (!list) return [];
    return list.filter((entry): entry is ActiveFilter => {
      if (!entry || typeof entry !== "object") return false;
      const candidate = entry as ActiveFilter;
      if (typeof candidate.id !== "string") return false;
      const def = getFilterDef(candidate.id);
      return Boolean(def && isValidValueForDef(def, candidate.value));
    });
  } catch {
    return [];
  }
}

const LEGACY_PREFIX = "avystock:admin-table:";

/** Uebernimmt die alten Einzel-Schluessel (bis 2026-08) in das v2-Format. */
export function migrateLegacyFilters(storage: StorageLike): ActiveFilter[] {
  const read = (key: string): string | null => {
    try {
      return storage.getItem(`${LEGACY_PREFIX}${key}`);
    } catch {
      return null;
    }
  };
  const readJsonArray = (key: string): string[] => {
    const raw = read(key);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(Boolean).map((v) => String(v)) : [];
    } catch {
      return [];
    }
  };

  const migrated: ActiveFilter[] = [];
  const pushSelect = (legacyKey: string, id: string) => {
    const value = read(legacyKey);
    if (!value || value === "all") return;
    // Nur Werte uebernehmen, die die Registry kennt. Der Altcode sanierte
    // z. B. den historischen Status "empty" beim Init auf "all" — ihn zu
    // migrieren hiesse: unerfuellbarer Filter, dauerhaft leere Tabelle.
    const def = getFilterDef(id);
    if (def && isValidValueForDef(def, value)) migrated.push({ id, value });
  };

  pushSelect("filterStatus", "status");

  const categories = readJsonArray("filterCategorySelection");
  if (categories.length > 0) {
    migrated.push({ id: "category", value: categories });
  } else {
    const legacySingle = read("filterCategory");
    if (legacySingle && legacySingle !== "all") migrated.push({ id: "category", value: [legacySingle] });
  }

  pushSelect("filterBin", "lagerplatz");
  pushSelect("filterBinSplit", "binSplit");
  pushSelect("filterEanValid", "ean");
  pushSelect("filterGpsr", "gpsr");
  pushSelect("filterWeight", "gewicht");
  pushSelect("filterReserved", "reserviert");
  pushSelect("filterSold", "verkauft");
  pushSelect("filterEbay", "ebay");
  pushSelect("filterKaufland", "kaufland");

  const editors = readJsonArray("filterEditor");
  if (editors.length > 0) migrated.push({ id: "editor", value: editors });

  // Nur Werte behalten, die laut Registry wirklich aktiv sind.
  return migrated.filter((entry) => {
    const def = getFilterDef(entry.id);
    return Boolean(def && def.isActive(entry.value));
  });
}

/** Laedt den Filterzustand: v2-Schluessel gewinnt, sonst einmalige Migration. */
export function loadFilterState(storage: StorageLike | null | undefined): ActiveFilter[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(FILTERS_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw !== null) return deserializeFilters(raw);
  return migrateLegacyFilters(storage);
}
