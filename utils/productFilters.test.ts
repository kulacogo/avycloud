import { describe, test } from "node:test";
import assert from "node:assert";
import type { Product } from "../types.ts";
import {
  NONE_SENTINEL,
  FILTERS_STORAGE_KEY,
  getFilterDefs,
  getFilterDef,
  matchesNumberCompare,
  resolveDateRange,
  matchesDateRange,
  effectiveSellPrice,
  productWeightKg,
  applyProductFilters,
  serializeFilters,
  deserializeFilters,
  loadFilterState,
  numberCompareChipText,
  dateRangeChipText,
  chipSegments,
  filterDefMatchesQuery,
  hasUnreadNotes,
  type ActiveFilter,
  type ProductNotesInfo,
  type FilterContext,
  type NumberCompareValue,
  type DateRangeValue,
} from "./productFilters.ts";

/**
 * Die Produkttabelle pflegte dieselbe Filterliste an VIER Stellen von Hand
 * (Zaehler, Chips, zwei Resets) — beim letzten Fix fehlten dort schon einmal
 * zwei Filter. Diese Registry ist die eine Quelle; die Tests hier sichern die
 * Predicate-Paritaet zum alten Verhalten UND die neuen Filtertypen ab.
 */

const makeProduct = (partial: Record<string, unknown>): Product =>
  ({
    id: "p1",
    identification: { method: "manual", name: "", brand: "", category: "", confidence: 1 },
    details: {},
    ops: { sync_status: "pending", revision: 1 },
    ...partial,
  }) as unknown as Product;

const baseCtx = (over: Partial<FilterContext> = {}): FilterContext => ({
  now: new Date(2026, 7, 26, 12, 0, 0), // 26.08.2026 12:00 lokal
  myInitials: "OK",
  ebaySkuUrlMap: new Map(),
  ebayProductIdMap: new Map(),
  ebayActiveItemIds: new Set(),
  kauflandSkuSet: new Set(),
  kauflandEanSet: new Set(),
  resolveErfasstVon: () => "",
  getDisplayCategory: () => "Unbekannt",
  notesById: new Map(),
  ...over,
});

const apply = (
  products: Product[],
  active: ActiveFilter[],
  ctx: FilterContext = baseCtx(),
  isAdmin = true
) => applyProductFilters(products, active, ctx, { isAdmin }).map((p) => p.id);

describe("matchesNumberCompare", () => {
  const cmp = (op: NumberCompareValue["op"], a: number | null, b: number | null = null): NumberCompareValue => ({ op, a, b });

  test("groesser / kleiner / gleich / ungleich", () => {
    assert.equal(matchesNumberCompare(6, cmp("gt", 5)), true);
    assert.equal(matchesNumberCompare(5, cmp("gt", 5)), false);
    assert.equal(matchesNumberCompare(5, cmp("gte", 5)), true);
    assert.equal(matchesNumberCompare(4, cmp("lt", 5)), true);
    assert.equal(matchesNumberCompare(5, cmp("lte", 5)), true);
    assert.equal(matchesNumberCompare(5, cmp("eq", 5)), true);
    assert.equal(matchesNumberCompare(4, cmp("ne", 5)), true);
    assert.equal(matchesNumberCompare(5, cmp("ne", 5)), false);
  });

  test("zwischen: beide Grenzen inklusiv", () => {
    assert.equal(matchesNumberCompare(10, cmp("between", 10, 50)), true);
    assert.equal(matchesNumberCompare(50, cmp("between", 10, 50)), true);
    assert.equal(matchesNumberCompare(9.99, cmp("between", 10, 50)), false);
    assert.equal(matchesNumberCompare(50.01, cmp("between", 10, 50)), false);
  });

  test("zwischen mit nur einer Grenze wirkt einseitig", () => {
    assert.equal(matchesNumberCompare(999, cmp("between", 10, null)), true);
    assert.equal(matchesNumberCompare(9, cmp("between", 10, null)), false);
    assert.equal(matchesNumberCompare(9, cmp("between", null, 10)), true);
    assert.equal(matchesNumberCompare(11, cmp("between", null, 10)), false);
  });

  test("verdrehte Zwischen-Grenzen werden getauscht statt leer zu treffen", () => {
    assert.equal(matchesNumberCompare(30, cmp("between", 50, 10)), true);
  });

  test("fehlender Produktwert trifft nie", () => {
    assert.equal(matchesNumberCompare(null, cmp("gt", 0)), false);
    assert.equal(matchesNumberCompare(null, cmp("lt", 100)), false);
  });

  test("ohne gesetzte Grenze (inaktiv) trifft alles", () => {
    assert.equal(matchesNumberCompare(5, cmp("gt", null)), true);
    assert.equal(matchesNumberCompare(null, cmp("gt", null)), true);
  });
});

describe("resolveDateRange / matchesDateRange", () => {
  const now = new Date(2026, 7, 26, 15, 30, 0); // Mi 26.08.2026

  test("Heute umfasst den ganzen Kalendertag", () => {
    const v: DateRangeValue = { preset: "today", from: null, to: null };
    assert.equal(matchesDateRange("2026-08-26T00:00:01+02:00", v, now), true);
    assert.equal(matchesDateRange("2026-08-26T23:59:00+02:00", v, now), true);
    assert.equal(matchesDateRange("2026-08-25T23:59:00+02:00", v, now), false);
  });

  test("Letzte 7 Tage rollierend inkl. heute", () => {
    const v: DateRangeValue = { preset: "last7", from: null, to: null };
    assert.equal(matchesDateRange(new Date(2026, 7, 20, 0, 0, 1).toISOString(), v, now), true);
    assert.equal(matchesDateRange(new Date(2026, 7, 19, 23, 0, 0).toISOString(), v, now), false);
  });

  test("Letzter Monat ist der komplette Vormonat", () => {
    const v: DateRangeValue = { preset: "lastMonth", from: null, to: null };
    assert.equal(matchesDateRange(new Date(2026, 6, 1, 0, 30).toISOString(), v, now), true);
    assert.equal(matchesDateRange(new Date(2026, 6, 31, 23, 30).toISOString(), v, now), true);
    assert.equal(matchesDateRange(new Date(2026, 7, 1, 0, 30).toISOString(), v, now), false);
  });

  test("eigener Zeitraum: von/bis inklusiv, halboffen erlaubt", () => {
    const both: DateRangeValue = { preset: "custom", from: "2026-08-01", to: "2026-08-15" };
    assert.equal(matchesDateRange(new Date(2026, 7, 15, 22, 0).toISOString(), both, now), true);
    assert.equal(matchesDateRange(new Date(2026, 7, 16, 1, 0).toISOString(), both, now), false);
    const openEnd: DateRangeValue = { preset: "custom", from: "2026-08-20", to: null };
    assert.equal(matchesDateRange(new Date(2026, 7, 25).toISOString(), openEnd, now), true);
    assert.equal(matchesDateRange(new Date(2026, 7, 19).toISOString(), openEnd, now), false);
  });

  test("fehlendes oder kaputtes Datum trifft nie", () => {
    const v: DateRangeValue = { preset: "last30", from: null, to: null };
    assert.equal(matchesDateRange(null, v, now), false);
    assert.equal(matchesDateRange("kein-datum", v, now), false);
  });

  test("leerer Wert ist inaktiv (null-Range)", () => {
    assert.equal(resolveDateRange({ preset: null, from: null, to: null }, now), null);
  });

  test("Custom ohne Datumsangaben ist INAKTIV (kein Zombie-Chip)", () => {
    const leer: DateRangeValue = { preset: "custom", from: null, to: null };
    assert.equal(resolveDateRange(leer, now), null);
    assert.equal(getFilterDef("erstellt")!.isActive(leer), false);
  });

  test("Diese Woche laeuft von Montag bis Sonntag (deutsche Woche)", () => {
    // now ist Mittwoch, 26.08.2026 → Woche = Mo 24.08. bis So 30.08.
    const v: DateRangeValue = { preset: "thisWeek", from: null, to: null };
    assert.equal(matchesDateRange(new Date(2026, 7, 24, 0, 30).toISOString(), v, now), true);
    assert.equal(matchesDateRange(new Date(2026, 7, 30, 23, 30).toISOString(), v, now), true);
    assert.equal(matchesDateRange(new Date(2026, 7, 23, 23, 30).toISOString(), v, now), false);
    assert.equal(matchesDateRange(new Date(2026, 7, 31, 0, 30).toISOString(), v, now), false);
  });

  test("verdrehte Custom-Grenzen werden getauscht statt still nichts zu treffen", () => {
    const verdreht: DateRangeValue = { preset: "custom", from: "2026-08-15", to: "2026-08-01" };
    assert.equal(matchesDateRange(new Date(2026, 7, 10).toISOString(), verdreht, now), true);
    assert.equal(matchesDateRange(new Date(2026, 7, 20).toISOString(), verdreht, now), false);
  });
});

describe("effectiveSellPrice", () => {
  test("sellPrice gewinnt, sonst recherchierter Marktpreis, sonst null", () => {
    assert.equal(
      effectiveSellPrice(makeProduct({ details: { pricing: { sellPrice: 19.99, lowest_price: { amount: 25, currency: "EUR", sources: [] } } } })),
      19.99
    );
    assert.equal(
      effectiveSellPrice(makeProduct({ details: { pricing: { lowest_price: { amount: 25, currency: "EUR", sources: [] } } } })),
      25
    );
    assert.equal(effectiveSellPrice(makeProduct({ details: {} })), null);
    // sellPrice 0 ist "nicht gesetzt" (gleiches Verhalten wie Preisspalte)
    assert.equal(
      effectiveSellPrice(makeProduct({ details: { pricing: { sellPrice: 0, lowest_price: { amount: 25, currency: "EUR", sources: [] } } } })),
      25
    );
  });
});

describe("productWeightKg — eine Kette fuer Filter UND Spalte", () => {
  // Der alte Gewicht-Filter las NUR attributes.weight, die Spalte aber vier
  // Felder — ein Produkt galt im Filter als "ohne Gewicht", zeigte aber eins an.
  test("liest alle vier Quellen in Spalten-Reihenfolge", () => {
    assert.equal(productWeightKg(makeProduct({ details: { weight: 1.2 } })), 1.2);
    assert.equal(productWeightKg(makeProduct({ details: { attributes: { weight: 0.8 } } })), 0.8);
    assert.equal(productWeightKg(makeProduct({ details: { attributes: { "Gewicht (kg)": "2.5" } } })), 2.5);
    assert.equal(productWeightKg(makeProduct({ details: { attributes: { Gewicht: "3" } } })), 3);
    assert.equal(productWeightKg(makeProduct({ details: {} })), null);
    assert.equal(productWeightKg(makeProduct({ details: { weight: 0 } })), null);
  });
});

describe("applyProductFilters — neue Dimensionen", () => {
  test("Menge mit Vergleichsoperator (WMS-Wahrheit via getProductQuantity)", () => {
    const a = makeProduct({ id: "a", inventory: { quantity: 2 } });
    const b = makeProduct({ id: "b", inventory: { quantity: 10 } });
    const active: ActiveFilter[] = [{ id: "menge", value: { op: "gt", a: 5, b: null } }];
    assert.deepEqual(apply([a, b], active), ["b"]);
  });

  test("Preis-Spanne nutzt den Effektivpreis (Fallback-Produkte verschwinden nicht)", () => {
    const confirmed = makeProduct({ id: "a", details: { pricing: { sellPrice: 20, lowest_price: { amount: 90, currency: "EUR", sources: [] } } } });
    const fallback = makeProduct({ id: "b", details: { pricing: { lowest_price: { amount: 30, currency: "EUR", sources: [] } } } });
    const none = makeProduct({ id: "c", details: {} });
    const active: ActiveFilter[] = [{ id: "preis", value: { op: "between", a: 10, b: 50 } }];
    assert.deepEqual(apply([confirmed, fallback, none], active), ["a", "b"]);
  });

  test("Preisquelle: bestaetigt / Marktpreis / fehlt", () => {
    const confirmed = makeProduct({ id: "a", details: { pricing: { sellPrice: 20 } } });
    const market = makeProduct({ id: "b", details: { pricing: { lowest_price: { amount: 30, currency: "EUR", sources: [] } } } });
    const none = makeProduct({ id: "c", details: {} });
    assert.deepEqual(apply([confirmed, market, none], [{ id: "preisquelle", value: "confirmed" }]), ["a"]);
    assert.deepEqual(apply([confirmed, market, none], [{ id: "preisquelle", value: "market" }]), ["b"]);
    assert.deepEqual(apply([confirmed, market, none], [{ id: "preisquelle", value: "missing" }]), ["c"]);
  });

  test("Erfassungsdatum als Zeitraum (ops.created_at_iso)", () => {
    const alt = makeProduct({ id: "a", ops: { sync_status: "pending", revision: 1, created_at_iso: new Date(2026, 5, 1).toISOString() } });
    const neu = makeProduct({ id: "b", ops: { sync_status: "pending", revision: 1, created_at_iso: new Date(2026, 7, 25).toISOString() } });
    const active: ActiveFilter[] = [{ id: "erstellt", value: { preset: "last7", from: null, to: null } }];
    assert.deepEqual(apply([alt, neu], active), ["b"]);
  });

  test("Aktualisierungsdatum als Zeitraum (ops.last_saved_iso)", () => {
    const alt = makeProduct({ id: "a", ops: { sync_status: "pending", revision: 1, last_saved_iso: new Date(2026, 0, 1).toISOString() } });
    const neu = makeProduct({ id: "b", ops: { sync_status: "pending", revision: 1, last_saved_iso: new Date(2026, 7, 26, 9, 0).toISOString() } });
    const active: ActiveFilter[] = [{ id: "aktualisiert", value: { preset: "today", from: null, to: null } }];
    assert.deepEqual(apply([alt, neu], active), ["b"]);
  });

  test("Marke: Mehrfachauswahl + Ohne-Marke-Sentinel", () => {
    const bosch = makeProduct({ id: "a", identification: { method: "manual", name: "", brand: "Bosch", category: "", confidence: 1 } });
    const ate = makeProduct({ id: "b", identification: { method: "manual", name: "", brand: "ATE", category: "", confidence: 1 } });
    const ohne = makeProduct({ id: "c", identification: { method: "manual", name: "", brand: "", category: "", confidence: 1 } });
    assert.deepEqual(apply([bosch, ate, ohne], [{ id: "marke", value: ["Bosch"] }]), ["a"]);
    assert.deepEqual(apply([bosch, ate, ohne], [{ id: "marke", value: ["Bosch", NONE_SENTINEL] }]), ["a", "c"]);
  });

  test("Los aus ops.sourceLot", () => {
    const l1 = makeProduct({ id: "a", ops: { sync_status: "pending", revision: 1, sourceLot: "L-082601" } });
    const nl = makeProduct({ id: "b", ops: { sync_status: "pending", revision: 1, sourceLot: "NL-0626" } });
    const ohne = makeProduct({ id: "c" });
    assert.deepEqual(apply([l1, nl, ohne], [{ id: "los", value: ["NL-0626"] }]), ["b"]);
    assert.deepEqual(apply([l1, nl, ohne], [{ id: "los", value: [NONE_SENTINEL] }]), ["c"]);
  });

  test("Herstellernummer vorhanden/fehlt", () => {
    const mit = makeProduct({ id: "a", details: { identifiers: { mpn: "34116860912" } } });
    const ohne = makeProduct({ id: "b", details: {} });
    assert.deepEqual(apply([mit, ohne], [{ id: "mpn", value: "withMpn" }]), ["a"]);
    assert.deepEqual(apply([mit, ohne], [{ id: "mpn", value: "noMpn" }]), ["b"]);
  });

  test("Bilderanzahl als Vergleich (= 0 findet Produkte ohne Bild)", () => {
    const ohne = makeProduct({ id: "a", details: { images: [] } });
    const zwei = makeProduct({ id: "b", details: { images: [{}, {}] } });
    assert.deepEqual(apply([ohne, zwei], [{ id: "bilder", value: { op: "eq", a: 0, b: null } }]), ["a"]);
    assert.deepEqual(apply([ohne, zwei], [{ id: "bilder", value: { op: "gte", a: 2, b: null } }]), ["b"]);
  });

  test("Vollstaendigkeit in Prozent", () => {
    const halb = makeProduct({ id: "a", completeness: { percent: 50, missing: [], total: 10 } });
    const voll = makeProduct({ id: "b", completeness: { percent: 100, missing: [], total: 10 } });
    assert.deepEqual(apply([halb, voll], [{ id: "vollstaendigkeit", value: { op: "lt", a: 80, b: null } }]), ["a"]);
  });

  test("Erfasser: Mehrfachauswahl + Ohne-Zuordnung, nur fuer Admins", () => {
    const p1 = makeProduct({ id: "a" });
    const p2 = makeProduct({ id: "b" });
    const ctx = baseCtx({ resolveErfasstVon: (p) => (p.id === "a" ? "Oguz" : "") });
    assert.deepEqual(apply([p1, p2], [{ id: "erfasser", value: ["Oguz"] }], ctx, true), ["a"]);
    assert.deepEqual(apply([p1, p2], [{ id: "erfasser", value: [NONE_SENTINEL] }], ctx, true), ["b"]);
    // Nicht-Admin: der Filter wird ignoriert statt still falsch zu filtern
    assert.deepEqual(apply([p1, p2], [{ id: "erfasser", value: ["Oguz"] }], ctx, false), ["a", "b"]);
  });

  test("Zustand: leeres Feld zaehlt als Neu (1000)", () => {
    const neu = makeProduct({ id: "a", details: {} });
    const gebraucht = makeProduct({ id: "b", details: { conditionId: "3000" } });
    assert.deepEqual(apply([neu, gebraucht], [{ id: "zustand", value: ["1000"] }]), ["a"]);
    assert.deepEqual(apply([neu, gebraucht], [{ id: "zustand", value: ["3000"] }]), ["b"]);
  });
});

describe("hasUnreadNotes", () => {
  const info = (over: Partial<ProductNotesInfo>): ProductNotesInfo => ({
    count: 1,
    lastNoteAt: "2026-08-26T10:00:00.000Z",
    seenAt: null,
    ...over,
  });

  test("nie geoeffnet = ungelesen; nach dem Oeffnen gelesen; neue Notiz macht wieder ungelesen", () => {
    assert.equal(hasUnreadNotes(info({ seenAt: null })), true);
    assert.equal(hasUnreadNotes(info({ seenAt: "2026-08-26T11:00:00.000Z" })), false);
    assert.equal(hasUnreadNotes(info({ seenAt: "2026-08-25T09:00:00.000Z" })), true);
  });

  test("ohne Notizen nie ungelesen; kaputte Zeitstempel fallen auf 'ungelesen bei nie gesehen' zurueck", () => {
    assert.equal(hasUnreadNotes(undefined), false);
    assert.equal(hasUnreadNotes(info({ count: 0 })), false);
    assert.equal(hasUnreadNotes(info({ lastNoteAt: null, seenAt: null })), true);
    assert.equal(hasUnreadNotes(info({ lastNoteAt: null, seenAt: "2026-08-26T11:00:00.000Z" })), false);
  });
});

describe("Notizen-Filter (Registry, liest aus dem FilterContext)", () => {
  const mitUngelesen = makeProduct({ id: "a" });
  const mitGelesen = makeProduct({ id: "b" });
  const ohne = makeProduct({ id: "c" });
  const notesCtx = () =>
    baseCtx({
      notesById: new Map<string, ProductNotesInfo>([
        ["a", { count: 2, lastNoteAt: "2026-08-26T10:00:00.000Z", seenAt: null }],
        ["b", { count: 1, lastNoteAt: "2026-08-20T10:00:00.000Z", seenAt: "2026-08-21T08:00:00.000Z" }],
      ]),
    });

  test("Vorhanden / Keine / Ungelesen / Gelesen", () => {
    assert.deepEqual(apply([mitUngelesen, mitGelesen, ohne], [{ id: "notizen", value: "withNotes" }], notesCtx()), ["a", "b"]);
    assert.deepEqual(apply([mitUngelesen, mitGelesen, ohne], [{ id: "notizen", value: "noNotes" }], notesCtx()), ["c"]);
    assert.deepEqual(apply([mitUngelesen, mitGelesen, ohne], [{ id: "notizen", value: "unread" }], notesCtx()), ["a"]);
    assert.deepEqual(apply([mitUngelesen, mitGelesen, ohne], [{ id: "notizen", value: "read" }], notesCtx()), ["b"]);
  });

  test("Letzte Notiz als Zeitraum (Preset rechnet mit ctx.now)", () => {
    // ctx.now = 26.08.2026 → "Letzte 7 Tage" trifft die Notiz vom 26.08., nicht die vom 01.06.
    const alt = makeProduct({ id: "d" });
    const ctx = baseCtx({
      notesById: new Map<string, ProductNotesInfo>([
        ["a", { count: 1, lastNoteAt: new Date(2026, 7, 26, 9, 0).toISOString(), seenAt: null }],
        ["d", { count: 1, lastNoteAt: new Date(2026, 5, 1).toISOString(), seenAt: null }],
      ]),
    });
    const active: ActiveFilter[] = [{ id: "letzteNotiz", value: { preset: "last7", from: null, to: null } }];
    assert.deepEqual(apply([mitUngelesen, alt, ohne], active, ctx), ["a"]);
  });

  test("Produkte ohne Notizen treffen den Zeitraum nie", () => {
    const active: ActiveFilter[] = [{ id: "letzteNotiz", value: { preset: "thisMonth", from: null, to: null } }];
    assert.deepEqual(apply([ohne], active, notesCtx()), []);
  });
});

describe("applyProductFilters — Paritaet zum Altverhalten", () => {
  test("Status: fehlender Status zaehlt als Ausstehend", () => {
    const ohne = makeProduct({ id: "a" });
    const bereit = makeProduct({ id: "b", ops: { sync_status: "pending", revision: 1, readiness: "ready" } });
    assert.deepEqual(apply([ohne, bereit], [{ id: "status", value: "pending" }]), ["a"]);
    assert.deepEqual(apply([ohne, bereit], [{ id: "status", value: "ready" }]), ["b"]);
  });

  test("Gewicht-Filter nutzt jetzt dieselbe Kette wie die Spalte (Regression)", () => {
    const spaltenGewicht = makeProduct({ id: "a", details: { weight: 1.5 } });
    const attrGewicht = makeProduct({ id: "b", details: { attributes: { "Gewicht (kg)": "2" } } });
    const ohne = makeProduct({ id: "c", details: {} });
    assert.deepEqual(apply([spaltenGewicht, attrGewicht, ohne], [{ id: "gewicht", value: "withWeight" }]), ["a", "b"]);
    assert.deepEqual(apply([spaltenGewicht, attrGewicht, ohne], [{ id: "gewicht", value: "noWeight" }]), ["c"]);
  });

  test("EAN/GTIN: gueltig / ungueltig / fehlt", () => {
    const gueltig = makeProduct({ id: "a", details: { identifiers: { ean: "4006381333931" } } });
    const ungueltig = makeProduct({ id: "b", details: { identifiers: { ean: "1234567890123" } } });
    const fehlt = makeProduct({ id: "c", details: {} });
    assert.deepEqual(apply([gueltig, ungueltig, fehlt], [{ id: "ean", value: "valid" }]), ["a"]);
    assert.deepEqual(apply([gueltig, ungueltig, fehlt], [{ id: "ean", value: "invalid" }]), ["b"]);
    assert.deepEqual(apply([gueltig, ungueltig, fehlt], [{ id: "ean", value: "missing" }]), ["c"]);
  });

  test("eBay gelistet rechnet gegen den Live-Index, nie gegen ops.listingStatus", () => {
    const listedBySku = makeProduct({ id: "a", details: { identifiers: { sku: "sku-1" } } });
    const staleActive = makeProduct({ id: "b", details: {}, ops: { sync_status: "pending", revision: 1, listingStatus: { ebay: "active" } } });
    const ctx = baseCtx({ ebaySkuUrlMap: new Map([["SKU-1", "https://ebay.de/itm/1"]]) });
    assert.deepEqual(apply([listedBySku, staleActive], [{ id: "ebay", value: "listed" }], ctx), ["a"]);
    assert.deepEqual(apply([listedBySku, staleActive], [{ id: "ebay", value: "notListed" }], ctx), ["b"]);
  });

  test("Kaufland gelistet via SKU- oder EAN-Index", () => {
    const bySku = makeProduct({ id: "a", details: { identifiers: { sku: "K-1" } } });
    const byEan = makeProduct({ id: "b", details: { identifiers: { ean: "4006381333931" } } });
    const nicht = makeProduct({ id: "c", details: {} });
    const ctx = baseCtx({ kauflandSkuSet: new Set(["K-1"]), kauflandEanSet: new Set(["4006381333931"]) });
    assert.deepEqual(apply([bySku, byEan, nicht], [{ id: "kaufland", value: "listed" }], ctx), ["a", "b"]);
  });

  test("Bearbeiter inkl. Ohne-Zuordnung-Sentinel", () => {
    const vonOk = makeProduct({ id: "a", ops: { sync_status: "pending", revision: 1, readiness_editor: "OK" } });
    const ohne = makeProduct({ id: "b" });
    assert.deepEqual(apply([vonOk, ohne], [{ id: "editor", value: ["OK"] }]), ["a"]);
    assert.deepEqual(apply([vonOk, ohne], [{ id: "editor", value: [NONE_SENTINEL] }]), ["b"]);
  });

  test("Lagerplaetze: Einzel- vs. Mehrplatz (binSplit bekommt endlich einen Einstieg)", () => {
    const einzel = makeProduct({ id: "a", storageBins: [{ code: "S-01-01-A", quantity: 2 }] });
    const mehr = makeProduct({ id: "b", storageBins: [{ code: "S-01-01-A", quantity: 1 }, { code: "M-02-01-B", quantity: 3 }] });
    assert.deepEqual(apply([einzel, mehr], [{ id: "binSplit", value: "singleBin" }]), ["a"]);
    assert.deepEqual(apply([einzel, mehr], [{ id: "binSplit", value: "multiBin" }]), ["b"]);
  });

  test("unbekannte Filter-IDs werden ignoriert (defensiv gegen alte Speicherstaende)", () => {
    const p = makeProduct({ id: "a" });
    assert.deepEqual(apply([p], [{ id: "gibtEsNicht", value: "x" }]), ["a"]);
  });
});

describe("Registry-Konsistenz", () => {
  test("jede Definition hat Label, Gruppe und funktionierendes chipLabel", () => {
    for (const def of getFilterDefs(true)) {
      assert.ok(def.label.length > 0, `${def.id} ohne Label`);
      assert.ok(def.group.length > 0, `${def.id} ohne Gruppe`);
      const chip = def.chipLabel(def.defaultValue, baseCtx());
      assert.equal(typeof chip, "string", `${def.id} chipLabel liefert keinen String`);
    }
  });

  test("adminOnly-Filter sind fuer Nicht-Admins unsichtbar", () => {
    const nonAdminIds = getFilterDefs(false).map((d) => d.id);
    assert.ok(!nonAdminIds.includes("erfasser"));
    assert.ok(getFilterDefs(true).map((d) => d.id).includes("erfasser"));
  });

  test("Default-Werte sind inaktiv", () => {
    for (const def of getFilterDefs(true)) {
      assert.equal(def.isActive(def.defaultValue), false, `${def.id} ist mit Default aktiv`);
    }
  });
});

describe("Chip-Beschriftungen", () => {
  test("Zahlenvergleich mit Einheit", () => {
    assert.equal(numberCompareChipText("Menge", { op: "gt", a: 5, b: null }), "Menge > 5");
    assert.equal(numberCompareChipText("Preis", { op: "between", a: 10, b: 50 }, "€"), "Preis 10–50 €");
    assert.equal(numberCompareChipText("Preis", { op: "lte", a: 9.99, b: null }, "€"), "Preis ≤ 9,99 €");
  });

  test("Zeitraum: Preset-Name bzw. deutsches Datumsformat", () => {
    assert.equal(dateRangeChipText("Erstellt", { preset: "last7", from: null, to: null }), "Erstellt: Letzte 7 Tage");
    assert.equal(
      dateRangeChipText("Erstellt", { preset: "custom", from: "2026-08-01", to: "2026-08-15" }),
      "Erstellt: 01.08.2026–15.08.2026"
    );
    assert.equal(dateRangeChipText("Aktualisiert", { preset: "custom", from: "2026-08-20", to: null }), "Aktualisiert: ab 20.08.2026");
  });

  test("Mehrfachauswahl: erster Wert + Rest als Zaehler", () => {
    const marke = getFilterDef("marke")!;
    assert.equal(marke.chipLabel(["Bosch"], baseCtx()), "Marke: Bosch");
    assert.equal(marke.chipLabel(["Bosch", "ATE", "HELLA"], baseCtx()), "Marke: Bosch +2");
    assert.equal(marke.chipLabel([NONE_SENTINEL], baseCtx()), "Marke: Ohne Marke");
  });
});

describe("chipSegments — segmentierte Chips (Feld | Operator | Wert)", () => {
  test("Zahlenvergleich: Operator als eigenes Segment", () => {
    const def = getFilterDef("menge")!;
    assert.deepEqual(chipSegments(def, { op: "gt", a: 5, b: null }, baseCtx()), {
      field: "Menge",
      op: ">",
      value: "5",
    });
    assert.deepEqual(chipSegments(getFilterDef("preis")!, { op: "between", a: 10, b: 50 }, baseCtx()), {
      field: "Preis",
      op: "zwischen",
      value: "10–50 €",
    });
  });

  test("Mehrfachauswahl: 'ist' bei einem Wert, 'ist eines von' bei mehreren, kollabiert", () => {
    const def = getFilterDef("marke")!;
    assert.deepEqual(chipSegments(def, ["Bosch"], baseCtx()), { field: "Marke", op: "ist", value: "Bosch" });
    assert.deepEqual(chipSegments(def, ["Bosch", "ATE", "HELLA"], baseCtx()), {
      field: "Marke",
      op: "ist eines von",
      value: "Bosch +2",
    });
    assert.deepEqual(chipSegments(def, [NONE_SENTINEL], baseCtx()), { field: "Marke", op: "ist", value: "Ohne Marke" });
  });

  test("Select: Optionsbeschriftung als Wert", () => {
    assert.deepEqual(chipSegments(getFilterDef("status")!, "ready", baseCtx()), {
      field: "Status",
      op: "ist",
      value: "Bereit",
    });
  });

  test("Zeitraum: Preset-Name bzw. Datumsspanne als Wert", () => {
    // Label folgt der Spalte ("Erfasst am") — der Betreiber suchte "erfasst"
    // und fand den Filter unter "Erstellt" nicht.
    assert.deepEqual(chipSegments(getFilterDef("erstellt")!, { preset: "last7", from: null, to: null }, baseCtx()), {
      field: "Erfasst am",
      op: "ist",
      value: "Letzte 7 Tage",
    });
    assert.deepEqual(
      chipSegments(getFilterDef("erstellt")!, { preset: "custom", from: "2026-08-20", to: null }, baseCtx()),
      { field: "Erfasst am", op: "ist", value: "ab 20.08.2026" }
    );
  });

  test("Menue-Suche findet Filter auch ueber Alt-Namen und Synonyme", () => {
    const erstellt = getFilterDef("erstellt")!;
    assert.equal(filterDefMatchesQuery(erstellt, "erfasst"), true);
    assert.equal(filterDefMatchesQuery(erstellt, "Erstellt"), true);
    assert.equal(filterDefMatchesQuery(erstellt, "angelegt"), true);
    const aktualisiert = getFilterDef("aktualisiert")!;
    assert.equal(aktualisiert.label, "Zuletzt gespeichert");
    assert.equal(filterDefMatchesQuery(aktualisiert, "aktualisiert"), true);
    assert.equal(filterDefMatchesQuery(aktualisiert, "geändert"), true);
    assert.equal(filterDefMatchesQuery(getFilterDef("marke")!, "hersteller"), true);
    assert.equal(filterDefMatchesQuery(erstellt, "xyz"), false);
    assert.equal(filterDefMatchesQuery(erstellt, ""), true);
  });

  test("Zustand: uebersetzte Options-Labels", () => {
    assert.deepEqual(chipSegments(getFilterDef("zustand")!, ["3000"], baseCtx()), {
      field: "Zustand",
      op: "ist",
      value: "Gebraucht",
    });
  });
});

describe("Persistenz + Migration", () => {
  function fakeStorage(seed: Record<string, string>) {
    const daten = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => (daten.has(k) ? daten.get(k)! : null),
      setItem: (k: string, v: string) => void daten.set(k, v),
    };
  }

  test("Roundtrip: serialize → deserialize", () => {
    const active: ActiveFilter[] = [
      { id: "menge", value: { op: "gt", a: 5, b: null } },
      { id: "marke", value: ["Bosch"] },
      { id: "erstellt", value: { preset: "last7", from: null, to: null } },
    ];
    assert.deepEqual(deserializeFilters(serializeFilters(active)), active);
  });

  test("falsch getypte Werte je Filter-Art werden beim Laden verworfen", () => {
    const raw = JSON.stringify({
      v: 2,
      filters: [
        { id: "menge", value: "kaputt" },
        { id: "menge", value: { op: "quatsch", a: 5, b: null } },
        { id: "marke", value: "Bosch" },
        { id: "erstellt", value: { preset: "unbekannt", from: null, to: null } },
        { id: "status", value: 42 },
        { id: "status", value: "ready" },
        { id: "preis", value: { op: "between", a: 10, b: 50 } },
      ],
    });
    assert.deepEqual(deserializeFilters(raw), [
      { id: "status", value: "ready" },
      { id: "preis", value: { op: "between", a: 10, b: 50 } },
    ]);
  });

  test("kaputter Speicherstand liefert leere Liste statt Absturz", () => {
    assert.deepEqual(deserializeFilters("{kaputt"), []);
    assert.deepEqual(deserializeFilters(null), []);
    assert.deepEqual(deserializeFilters(JSON.stringify({ nicht: "array" })), []);
  });

  test("v2-Stand gewinnt gegenueber Alt-Schluesseln", () => {
    const storage = fakeStorage({
      [FILTERS_STORAGE_KEY]: serializeFilters([{ id: "status", value: "ready" }]),
      "avystock:admin-table:filterStatus": "pending",
    });
    assert.deepEqual(loadFilterState(storage), [{ id: "status", value: "ready" }]);
  });

  test("Alt-Schluessel werden einmalig uebernommen (alle 12 Legacy-Filter)", () => {
    const storage = fakeStorage({
      "avystock:admin-table:filterStatus": "ready",
      "avystock:admin-table:filterCategorySelection": JSON.stringify(["Auto & Motorrad"]),
      "avystock:admin-table:filterBin": "withBin",
      "avystock:admin-table:filterBinSplit": "multiBin",
      "avystock:admin-table:filterEanValid": "missing",
      "avystock:admin-table:filterGpsr": "incomplete",
      "avystock:admin-table:filterWeight": "noWeight",
      "avystock:admin-table:filterReserved": "reserved",
      "avystock:admin-table:filterSold": "unsold",
      "avystock:admin-table:filterEbay": "listed",
      "avystock:admin-table:filterKaufland": "notListed",
      "avystock:admin-table:filterEditor": JSON.stringify(["OK"]),
    });
    const geladen = loadFilterState(storage);
    const byId = Object.fromEntries(geladen.map((f) => [f.id, f.value]));
    assert.equal(byId["status"], "ready");
    assert.deepEqual(byId["category"], ["Auto & Motorrad"]);
    assert.equal(byId["lagerplatz"], "withBin");
    assert.equal(byId["binSplit"], "multiBin");
    assert.equal(byId["ean"], "missing");
    assert.equal(byId["gpsr"], "incomplete");
    assert.equal(byId["gewicht"], "noWeight");
    assert.equal(byId["reserviert"], "reserved");
    assert.equal(byId["verkauft"], "unsold");
    assert.equal(byId["ebay"], "listed");
    assert.equal(byId["kaufland"], "notListed");
    assert.deepEqual(byId["editor"], ["OK"]);
  });

  test("ungueltige Alt-Select-Werte werden verworfen (historisches 'empty', Muellwerte)", () => {
    // Der Altcode sanierte sessionStorage-Status 'empty' beim Init auf 'all';
    // die Migration darf ihn nicht als unerfuellbaren Filter verewigen
    // (Predicate normalizeReadiness(...) === 'empty' traefe NIE → leere Tabelle).
    const storage = fakeStorage({
      "avystock:admin-table:filterStatus": "empty",
      "avystock:admin-table:filterBin": "wthBin",
    });
    assert.deepEqual(loadFilterState(storage), []);
  });

  test("Legacy-Kategorie-Einzelschluessel als letzter Fallback", () => {
    const storage = fakeStorage({ "avystock:admin-table:filterCategory": "Haushalt" });
    assert.deepEqual(loadFilterState(storage), [{ id: "category", value: ["Haushalt"] }]);
  });

  test("inaktive Werte (all/leer) werden bei der Migration nicht uebernommen", () => {
    const storage = fakeStorage({
      "avystock:admin-table:filterStatus": "all",
      "avystock:admin-table:filterEditor": JSON.stringify([]),
    });
    assert.deepEqual(loadFilterState(storage), []);
  });

  test("ohne Storage (SSR) leere Liste", () => {
    assert.deepEqual(loadFilterState(null), []);
    assert.deepEqual(loadFilterState(undefined), []);
  });
});
