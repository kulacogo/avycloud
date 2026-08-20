'use strict';

// globals: true in vitest.config.js — describe/it/expect sind global.
//
// REGRESSION GUARD — Incident 2026-08-20 (zweite Haelfte des Fixes).
//
// Der 15-Minuten-ListingSyncRunner propagierte ops.listingStatus.ebay NUR aus
// vorhandenen ebayListingLinks — baute aber selbst NIE Links. Links entstanden
// ausschliesslich im manuellen Voll-Sync (Default-Fenster 10 Seiten × 100 =
// max 1.000 von 3.232 aktiven Listings) und in Bulk-Revise-Pfaden. Ergebnis:
// 1.742 von 3.232 aktiven Listings ohne Link — deren Produkte galten dauerhaft
// als "nicht gelistet".
//
// healMissingListingLinks schliesst die Luecke: aktive Spiegel-Listings OHNE
// Link-Doc werden je Zyklus (Cap) deterministisch nachverlinkt. Nur FEHLENDE
// Docs — ein einmal geschriebenes 'unmatched' (echtes Waisen-Listing) wird
// nicht endlos neu gematcht.

let activeMirrorIds = [];
let existingLinkIds = new Set();

const mockFirestore = {
  collection: (name) => ({
    where: () => ({
      select: () => ({
        get: async () => ({
          empty: activeMirrorIds.length === 0,
          docs: activeMirrorIds.map((id) => ({ id })),
        }),
      }),
      get: async () => ({ empty: true, docs: [] }),
    }),
    doc: (id) => ({ _collection: name, _id: id, get: async () => ({ exists: false }), set: async () => {}, update: async () => {} }),
    get: async () => ({ empty: true, docs: [] }),
    add: async () => {},
  }),
  getAll: async (...refs) => refs.map((r) => ({ id: r._id, exists: existingLinkIds.has(r._id) })),
};

require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: {
    firestore: mockFirestore,
    getAllProducts: async () => [],
    getAllProductsForTenant: async () => [],
    PRODUCTS_COLLECTION: 'products_v2',
  },
  children: [],
  paths: [],
};

const { healMissingListingLinks } = require('../lib/ebay-direct');

describe('healMissingListingLinks — Runner verlinkt fehlende eBay-Links nach', () => {
  beforeEach(() => {
    activeMirrorIds = [];
    existingLinkIds = new Set();
  });

  it('verlinkt genau die aktiven Listings OHNE Link-Doc', async () => {
    activeMirrorIds = ['111', '222', '333'];
    existingLinkIds = new Set(['111']);
    const calls = [];
    const result = await healMissingListingLinks({
      buildLinks: async (args) => { calls.push(args); return { matched: 2, ambiguous: 0, unmatched: 0 }; },
    });

    expect(calls.length).toBe(1);
    // Neueste ItemIDs zuerst (eBay-ItemIDs wachsen monoton — frische
    // Publishes sind die akuten Faelle auf der Liste).
    expect(calls[0].itemIds).toEqual(['333', '222']);
    expect(result.missing).toBe(2);
    expect(result.healed).toBe(2);
    expect(result.checked).toBe(3);
  });

  it('respektiert den Cap (limit) und priorisiert die NEUESTEN ItemIDs', async () => {
    activeMirrorIds = ['1', '2', '3', '4'];
    existingLinkIds = new Set();
    const calls = [];
    const result = await healMissingListingLinks({
      limit: 2,
      buildLinks: async (args) => { calls.push(args); return {}; },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].itemIds).toEqual(['4', '3']);
    expect(result.missing).toBe(4);
    expect(result.healed).toBe(2);
  });

  it('nichts fehlt → KEIN Matching-Lauf (reiner Index-Check, skipped)', async () => {
    activeMirrorIds = ['111', '222'];
    existingLinkIds = new Set(['111', '222']);
    const calls = [];
    const result = await healMissingListingLinks({
      buildLinks: async (args) => { calls.push(args); return {}; },
    });
    expect(calls.length).toBe(0);
    expect(result.skipped).toBe(true);
    expect(result.missing).toBe(0);
  });

  it('leerer Spiegel → skipped, kein Matching', async () => {
    const calls = [];
    const result = await healMissingListingLinks({
      buildLinks: async (args) => { calls.push(args); return {}; },
    });
    expect(calls.length).toBe(0);
    expect(result.skipped).toBe(true);
  });
});

describe('ListingSyncRunner-Verdrahtung (Source-Gate)', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'listing-sync-runner.js'), 'utf8');

  it('runListingSyncCycle ruft healMissingListingLinks VOR propagateEbayStatusToProducts auf', () => {
    const start = source.indexOf('async function runListingSyncCycle');
    const end = source.indexOf('function startListingSyncRunner');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    const healIdx = body.indexOf('healMissingListingLinks');
    const propagateIdx = body.indexOf('propagateEbayStatusToProducts()');
    expect(healIdx).toBeGreaterThan(-1);
    expect(propagateIdx).toBeGreaterThan(-1);
    expect(healIdx).toBeLessThan(propagateIdx);
  });
});
