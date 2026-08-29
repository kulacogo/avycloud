import { test } from "node:test";
import assert from "node:assert";
import {
  INVENTORY_EXPORT_DEFAULT_FIELDS,
  INVENTORY_EXPORT_FIELDS,
  buildInventoryExport,
  buildInventoryExportFilename,
  formatExportCell,
  loadInventoryExportPreferences,
  resolveBuyPrice,
  resolveFields,
  type InventoryExportContext,
} from "./inventory-export.ts";
// Die Preis-Kette liegt in ihrem eigenen Modul; hier wird geprueft, dass die
// Datei sie benutzt statt eine eigene Lesart zu erfinden.
import { resolveSellPrice } from "./sellPrice.ts";

// Der Export ist die Datei, die aus dem System herausgeht — in Excel, zum
// Steuerberater, in die Inventur. Was hier falsch formatiert oder still
// weggelassen wird, faellt niemandem mehr auf.

const NO_MARKETPLACE: InventoryExportContext = {
  marketplace: () => ({
    isEbayActive: false,
    isKauflandActive: false,
    isListed: false,
    hasErrors: false,
    errorCount: 0,
  }),
};

const product = (overrides: any = {}): any => ({
  id: "p1",
  identification: { name: "Testartikel", brand: "ACME", sku: "SKU-1", category: "", confidence: 1, method: "manual" },
  details: { identifiers: {}, pricing: { lowest_price: { amount: 0, currency: "EUR", sources: [] }, price_confidence: 0 } },
  ops: { sync_status: "synced", revision: 1 },
  inventory: { quantity: 0 },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Zahlenformat
// ---------------------------------------------------------------------------

test("deutsches Format schreibt Komma und nie einen Tausendertrenner", () => {
  // Ein Tausenderpunkt zerlegt die Zahl beim Import in zwei Zellen.
  assert.strictEqual(formatExportCell(1234.5, "money", "de"), "1234,50");
  assert.strictEqual(formatExportCell(1234567.89, "money", "de"), "1234567,89");
});

test("internationales Format schreibt Punkt", () => {
  assert.strictEqual(formatExportCell(1234.5, "money", "intl"), "1234.50");
});

test("Ganzzahlen bekommen keine Nachkommastellen", () => {
  assert.strictEqual(formatExportCell(7, "integer", "de"), "7");
  assert.strictEqual(formatExportCell(7, "money", "de"), "7,00");
});

test("leere Werte bleiben leer statt zu 0 zu werden", () => {
  // Eine 0 im VK-Feld behauptet einen Preis, den niemand gesetzt hat.
  assert.strictEqual(formatExportCell("", "money", "de"), "");
  assert.strictEqual(formatExportCell(null, "money", "de"), "");
  assert.strictEqual(formatExportCell(undefined, "integer", "de"), "");
});

test("Datum wird deutsch geschrieben, Unlesbares bleibt stehen", () => {
  assert.strictEqual(formatExportCell("2026-08-12T10:30:00.000Z", "date", "de"), "12.08.2026");
  assert.strictEqual(formatExportCell("keine-zeit", "date", "de"), "keine-zeit");
});

// ---------------------------------------------------------------------------
// EK-Herkunft — der Kern der Belegtauglichkeit
// ---------------------------------------------------------------------------

test("erfasster Einkaufspreis gewinnt und wird als 'erfasst' ausgewiesen", () => {
  const p = product({ details: { identifiers: {}, pricing: { buyPrice: 12.5, lowest_price: { amount: 99 } } } });
  assert.deepStrictEqual(resolveBuyPrice(p), { amount: 12.5, source: "recorded" });
});

test("fehlender Einkaufspreis faellt auf den Marktpreis, wird aber als 'geschaetzt' markiert", () => {
  // Genau diese stille Ersetzung macht eine Bestandsliste sonst unbrauchbar:
  // der recherchierte Marktpreis ist kein Einkaufspreis.
  const p = product({ details: { identifiers: {}, pricing: { lowest_price: { amount: 99 } } } });
  assert.deepStrictEqual(resolveBuyPrice(p), { amount: 99, source: "estimated" });

  const { rows } = buildInventoryExport([p], ["buyPrice", "buyPriceSource"], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(rows[0], ["99,00", "geschätzt"]);
});

test("ohne jeden Preis meldet die Quelle 'fehlt' statt still 0 zu behaupten", () => {
  const p = product();
  assert.deepStrictEqual(resolveBuyPrice(p), { amount: 0, source: "none" });
  const { rows } = buildInventoryExport([p], ["buyPriceSource"], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(rows[0], ["fehlt"]);
});

test("Bestandswert rechnet mit dem aufgeloesten EK", () => {
  const p = product({
    inventory: { quantity: 3 },
    details: { identifiers: {}, pricing: { buyPrice: 10 } },
  });
  const { rows } = buildInventoryExport([p], ["stockValue"], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(rows[0], ["30,00"]);
});

// ---------------------------------------------------------------------------
// VK-Herkunft — dieselbe Frage wie beim EK, nur andersherum
// ---------------------------------------------------------------------------

test("gepflegter Verkaufspreis gewinnt und gilt als bestaetigt", () => {
  const p = product({ details: { identifiers: {}, pricing: { sellPrice: 24.9, lowest_price: { amount: 19.99 } } } });
  assert.deepStrictEqual(resolveSellPrice(p), { amount: 24.9, source: "confirmed" });
});

test("ohne sellPrice zeigt VK den Preis, mit dem der Artikel wirklich online steht", () => {
  // Gemessen am Export vom 28.08.2026: 301 von 837 Zeilen liessen VK leer,
  // obwohl der Artikel bei eBay/Kaufland aktiv war. Der Marktplatz nimmt in
  // genau diesem Fall lowest_price.amount als Angebotspreis
  // (backend/lib/listing-price-source.js resolveListingPrice). Eine leere
  // Zelle behauptet dort "kein Verkaufspreis" — der Artikel ist aber verkaeuflich.
  const p = product({ details: { identifiers: {}, pricing: { lowest_price: { amount: 18.99 } } } });
  assert.deepStrictEqual(resolveSellPrice(p), { amount: 18.99, source: "market" });

  const { rows } = buildInventoryExport([p], ["sellPrice", "sellPriceSource"], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(rows[0], ["18,99", "Marktpreis"]);
});

test("VK-Quelle unterscheidet bestaetigt von geschaetzt", () => {
  const bestaetigt = product({ details: { identifiers: {}, pricing: { sellPrice: 24.9, lowest_price: { amount: 19.99 } } } });
  const { rows } = buildInventoryExport([bestaetigt], ["sellPrice", "sellPriceSource"], NO_MARKETPLACE, "de");
  // Ohne diese Spalte waeren 24,90 (entschieden) und 18,99 (geraten) in der
  // Datei nicht mehr voneinander zu unterscheiden.
  assert.deepStrictEqual(rows[0], ["24,90", "bestätigt"]);
});

test("ohne jeden Preis bleibt VK leer statt 0,00 zu behaupten", () => {
  const p = product();
  assert.deepStrictEqual(resolveSellPrice(p), { amount: null, source: "missing" });
  const { rows } = buildInventoryExport([p], ["sellPrice", "sellPriceSource"], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(rows[0], ["", "fehlt"]);
});

test("ein sellPrice von 0 ist kein Preis und faellt auf den Marktpreis", () => {
  const p = product({ details: { identifiers: {}, pricing: { sellPrice: 0, lowest_price: { amount: 12.5 } } } });
  assert.deepStrictEqual(resolveSellPrice(p), { amount: 12.5, source: "market" });
});

// ---------------------------------------------------------------------------
// Feldauswahl
// ---------------------------------------------------------------------------

test("unbekannte Feldschluessel fallen weg statt eine leere Spalte zu erzeugen", () => {
  const fields = resolveFields(["sku", "gibtesnicht", "quantity"]);
  assert.deepStrictEqual(fields.map((f) => f.key), ["sku", "quantity"]);
});

test("die Spaltenreihenfolge kommt aus dem Katalog, nicht aus der Klickreihenfolge", () => {
  const { headers } = buildInventoryExport([product()], ["quantity", "sku"], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(headers, ["SKU", "Menge"]);
});

test("leere Auswahl liefert eine leere Kopfzeile statt zu werfen", () => {
  const { headers, rows } = buildInventoryExport([product()], [], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(headers, []);
  assert.deepStrictEqual(rows, [[]]);
});

test("jedes Feld im Katalog hat einen eindeutigen Schluessel", () => {
  const keys = INVENTORY_EXPORT_FIELDS.map((f) => f.key);
  assert.strictEqual(new Set(keys).size, keys.length);
});

test("die Vorauswahl verweist nur auf existierende Felder", () => {
  const known = new Set(INVENTORY_EXPORT_FIELDS.map((f) => f.key));
  INVENTORY_EXPORT_DEFAULT_FIELDS.forEach((key) => assert.ok(known.has(key), `unbekannt: ${key}`));
});

// ---------------------------------------------------------------------------
// Robustheit
// ---------------------------------------------------------------------------

test("ein kaputter Datensatz kippt nicht den ganzen Export", () => {
  // Firestore-Daten sind nicht schemagepruft. Ein Produkt ohne `details` darf
  // nicht dazu fuehren, dass 773 andere Zeilen verloren gehen.
  const broken = { id: "kaputt" } as any;
  const { rows } = buildInventoryExport([broken, product()], ["name", "buyPrice", "binCode"], NO_MARKETPLACE, "de");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1][0], "Testartikel");
});

test("Lagerplatz nimmt den Bin mit Bestand, nicht den leergeraeumten ersten", () => {
  const p = product({
    storage: null,
    storageBins: [
      { code: "SEG0101A", quantity: 0 },
      { code: "LEG0202B", quantity: 4 },
    ],
  });
  const { rows } = buildInventoryExport([p], ["binCode"], NO_MARKETPLACE, "de");
  assert.deepStrictEqual(rows[0], ["LEG0202B"]);
});

// ---------------------------------------------------------------------------
// Gespeicherte Auswahl
// ---------------------------------------------------------------------------

const fakeStorage = (value: string | null) => ({ getItem: () => value });

test("gespeicherte Auswahl wird gelesen", () => {
  const prefs = loadInventoryExportPreferences(
    fakeStorage(JSON.stringify({ fields: ["sku", "quantity"], numberFormat: "intl" }))
  );
  assert.deepStrictEqual(prefs, { fields: ["sku", "quantity"], numberFormat: "intl" });
});

test("entfernte Felder werden aus der gespeicherten Auswahl gefiltert", () => {
  const prefs = loadInventoryExportPreferences(
    fakeStorage(JSON.stringify({ fields: ["sku", "altlast"], numberFormat: "de" }))
  );
  assert.deepStrictEqual(prefs.fields, ["sku"]);
});

test("spaeter ergaenzte Felder werden NICHT in eine gespeicherte Auswahl eingemischt", () => {
  // Sonst aendert sich die Spaltenzahl einer Datei, die woanders eingelesen
  // wird, ohne dass jemand etwas geklickt hat.
  const prefs = loadInventoryExportPreferences(fakeStorage(JSON.stringify({ fields: ["sku"], numberFormat: "de" })));
  assert.deepStrictEqual(prefs.fields, ["sku"]);
});

test("eine gespeicherte Auswahl mit VK bekommt die VK-Quelle nachgereicht", () => {
  // Eng begrenzte Ausnahme zur Regel darueber: seit VK den effektiven Preis
  // zeigt, gehoert die Herkunft zur Spalte. Wer VK ohne Quelle exportiert,
  // bekaeme geschaetzte Preise ununterscheidbar neben entschiedenen.
  const prefs = loadInventoryExportPreferences(
    fakeStorage(JSON.stringify({ fields: ["sku", "sellPrice", "marketPrice"], numberFormat: "de" }))
  );
  assert.deepStrictEqual(prefs.fields, ["sku", "sellPrice", "sellPriceSource", "marketPrice"]);
});

test("ohne VK-Spalte wird auch keine VK-Quelle nachgereicht", () => {
  const prefs = loadInventoryExportPreferences(fakeStorage(JSON.stringify({ fields: ["sku", "quantity"], numberFormat: "de" })));
  assert.deepStrictEqual(prefs.fields, ["sku", "quantity"]);
});

test("wer die VK-Quelle bewusst abwaehlt, bekommt sie nicht wieder aufgedraengt", () => {
  // Nach einmaligem Speichern traegt die Auswahl ihre Version; die Nachreichung
  // ist dann erledigt und darf eine Entscheidung nicht ueberstimmen.
  const prefs = loadInventoryExportPreferences(
    fakeStorage(JSON.stringify({ v: 2, fields: ["sku", "sellPrice"], numberFormat: "de" }))
  );
  assert.deepStrictEqual(prefs.fields, ["sku", "sellPrice"]);
});

test("kaputter oder leerer Speicher faellt auf die Vorauswahl zurueck", () => {
  assert.deepStrictEqual(loadInventoryExportPreferences(fakeStorage("{kein json")).fields, INVENTORY_EXPORT_DEFAULT_FIELDS);
  assert.deepStrictEqual(loadInventoryExportPreferences(fakeStorage(null)).fields, INVENTORY_EXPORT_DEFAULT_FIELDS);
  assert.deepStrictEqual(
    loadInventoryExportPreferences(fakeStorage(JSON.stringify({ fields: [] }))).fields,
    INVENTORY_EXPORT_DEFAULT_FIELDS
  );
});

test("unbekanntes Zahlenformat faellt auf Deutsch zurueck", () => {
  assert.strictEqual(loadInventoryExportPreferences(fakeStorage(JSON.stringify({ numberFormat: "klingon" }))).numberFormat, "de");
});

// ---------------------------------------------------------------------------
// Dateiname
// ---------------------------------------------------------------------------

test("Dateiname traegt Umfang und Datum", () => {
  const day = new Date("2026-08-12T09:00:00.000Z");
  assert.strictEqual(buildInventoryExportFilename("all", day), "warenbestand-gesamt-2026-08-12.csv");
  assert.strictEqual(buildInventoryExportFilename("filtered", day), "warenbestand-auswahl-2026-08-12.csv");
});

// ---------------------------------------------------------------------------
// Identifikatoren: führende Nullen überleben Excel
// ---------------------------------------------------------------------------

/**
 * Die Datei ist bewusst auf Excel ausgelegt (BOM, Semikolon, Komma als
 * Dezimalzeichen). Reine Ziffernfolgen erkennt Excel aber als ZAHL: eine
 * 13-stellige EAN wird zu 4,00638E+12, und bei GTIN-14/UPC-12 verschwindet die
 * führende Null kommentarlos — die Datei sieht danach richtig aus, ist es aber
 * nicht. Genau diese Nullen sind bedeutungstragend.
 */
test("EAN behält im Excel-Format ihre führende Null", () => {
  assert.strictEqual(formatExportCell("04006381333931", "identifier", "de"), '="04006381333931"');
});

test("UPC-12 behält im Excel-Format ihre führende Null", () => {
  assert.strictEqual(formatExportCell("012345678905", "identifier", "de"), '="012345678905"');
});

test("im internationalen Format bleibt der Identifikator roh", () => {
  // LibreOffice und Fremdsysteme werten Formeln beim CSV-Import nicht aus und
  // würden ="..." wörtlich anzeigen. Der Sonderweg gilt nur für Excel.
  assert.strictEqual(formatExportCell("012345678905", "identifier", "intl"), "012345678905");
});

test("leerer Identifikator bleibt leer statt =\"\"", () => {
  assert.strictEqual(formatExportCell("", "identifier", "de"), "");
});

test("die gebaute Zeile trägt den Identifikator excel-fest", () => {
  const { headers, rows } = buildInventoryExport(
    [
      {
        id: "SKU-1",
        identification: { name: "Bosch Bohrer", sku: "SKU-1" },
        details: { identifiers: { ean: "04006381333931" } },
      } as any,
    ],
    ["name", "ean"],
    {
      marketplace: () => ({
        isEbayActive: false,
        isKauflandActive: false,
        isListed: false,
        hasErrors: false,
        errorCount: 0,
      }),
    },
    "de"
  );
  assert.deepStrictEqual(headers, ["Produkt", "EAN"]);
  // Die Zelle enthält ein Anführungszeichen — damit maskiert der CSV-Schreiber
  // sie zwangsläufig, und Excel liest sie als Text statt als Zahl.
  assert.strictEqual(rows[0][1], '="04006381333931"');
  assert.ok(rows[0][1].includes('"'), "ohne Anführungszeichen bliebe die Zelle unmaskiert");
});
