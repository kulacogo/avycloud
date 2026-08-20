import { test } from "node:test";
import assert from "node:assert";
import { isListingRowActive } from "./listingRowStatus.ts";

// Incident 2026-08-20: Die Ausschlussbedingung des Publish-Modals verglich
// `l.status` lowercase — eBay-Zeilen haben aber KEIN status-Feld (nur
// active:boolean) und Kaufland liefert den Status GROSSGESCHRIEBEN. Die
// SKU/EAN-Ausschlussliste war dadurch leer und bereits gelistete Artikel
// blieben auf der "zu listenden"-Liste.

test("eBay-Zeile: active:true zaehlt als gelistet, auch ohne status-Feld", () => {
  assert.strictEqual(isListingRowActive({ active: true }), true);
  assert.strictEqual(isListingRowActive({ active: true, status: null }), true);
});

test("eBay-Zeile: active:false ohne status ist NICHT gelistet", () => {
  assert.strictEqual(isListingRowActive({ active: false }), false);
  assert.strictEqual(isListingRowActive({}), false);
  assert.strictEqual(isListingRowActive(null), false);
  assert.strictEqual(isListingRowActive(undefined), false);
});

test("Kaufland-Status wird case-insensitiv erkannt (Backend liefert UPPERCASE)", () => {
  assert.strictEqual(isListingRowActive({ status: "LIVE" }), true);
  assert.strictEqual(isListingRowActive({ status: "live" }), true);
  assert.strictEqual(isListingRowActive({ status: "Active" }), true);
  assert.strictEqual(isListingRowActive({ status: "INDEXING" }), true);
});

test("invalid zaehlt als existent — die Unit ist angelegt, erneutes Publish waere ein Duplikat", () => {
  assert.strictEqual(isListingRowActive({ status: "INVALID" }), true);
  assert.strictEqual(isListingRowActive({ status: "invalid" }), true);
});

test("beendete/unbekannte Status zaehlen nicht", () => {
  assert.strictEqual(isListingRowActive({ status: "ENDED" }), false);
  assert.strictEqual(isListingRowActive({ status: "deleted" }), false);
  assert.strictEqual(isListingRowActive({ status: "" }), false);
  assert.strictEqual(isListingRowActive({ status: "   " }), false);
});

test("explizites active:false schlaegt einen (veralteten) Status-String NICHT — Status gewinnt, wenn er Existenz belegt", () => {
  // Kaufland-Ghost-Fix: active-Flag stammt vom Sync; ein Status wie LIVE
  // heisst, die Unit existiert beim Marktplatz. Fuer den AUSSCHLUSS im
  // Publish-Modal ist Existenz das Kriterium (Duplikat-Gefahr), daher OR.
  assert.strictEqual(isListingRowActive({ active: false, status: "LIVE" }), true);
});
