'use strict';

/**
 * catalog-index.js — Produktbestand im Speicher fuer die Duplikat-Suche.
 *
 * Der Katalog ist klein (Groessenordnung 1.700 Produkte); services/deduplication.js
 * laedt ihn heute schon in einem Rutsch. Fuer die Suche beim Erfassen brauchen
 * wir nur ein paar Felder je Produkt, das sind ein paar hundert Kilobyte.
 *
 * Verhalten bei Stoerungen: ein fehlgeschlagenes Nachladen behaelt den letzten
 * bekannten guten Stand. Ein leerer Index findet keine Duplikate — die
 * Erfassung wuerde dann still wieder Dubletten anlegen, und genau das soll
 * dieser Pfad ja verhindern.
 */

const { buildCatalogEntry } = require('./product-match');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const CATALOG_SCAN_LIMIT = 5000;

function createCatalogIndex({ load, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  let loadedAt = 0;
  let inFlight = null;

  async function refresh() {
    const produkte = await load();
    cached = (produkte || []).map(buildCatalogEntry).filter((e) => e.id);
    loadedAt = now();
    return cached;
  }

  async function entries() {
    if (cached && now() - loadedAt < ttlMs) return cached;
    if (inFlight) return inFlight;

    inFlight = refresh()
      .catch((err) => {
        console.warn('[catalog-index] Nachladen fehlgeschlagen:', err?.message || err);
        // Letzten guten Stand behalten; beim allerersten Fehler leer liefern.
        if (cached) loadedAt = now();
        return cached || [];
      })
      .finally(() => { inFlight = null; });

    return inFlight;
  }

  return {
    entries,
    invalidate() { loadedAt = 0; },
  };
}

/** Produktionslader: liest products_v2 einmal komplett. */
async function loadProductsFromFirestore() {
  const { firestore, PRODUCTS_COLLECTION } = require('./firestore');
  const snap = await firestore.collection(PRODUCTS_COLLECTION).limit(CATALOG_SCAN_LIMIT).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

let sharedIndex = null;

/** Prozessweiter Index fuer den Erfassungs-Pfad. */
function getSharedCatalogIndex() {
  if (!sharedIndex) {
    sharedIndex = createCatalogIndex({
      load: loadProductsFromFirestore,
      ttlMs: parseInt(process.env.CATALOG_INDEX_TTL_MS || String(DEFAULT_TTL_MS), 10),
    });
  }
  return sharedIndex;
}

module.exports = { createCatalogIndex, getSharedCatalogIndex, loadProductsFromFirestore };
