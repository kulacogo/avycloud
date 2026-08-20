'use strict';

// globals: true in vitest.config.js — describe/it/expect sind global.
//
// REGRESSION GUARD — Incident 2026-08-20: "Gelistete Artikel bleiben auf der
// zu-listenden-Liste".
//
// publishProduct schrieb nach erfolgreichem Listing NUR marketplace.ebay.itemId
// aufs Produkt — obwohl im Publish-Moment das Produkt↔ItemID-Wissen mit
// Sicherheit bekannt ist. Das komplette "gelistet"-Signal (ops.listingStatus,
// /api/ebay/sku-index, Publish-Modal-Ausschluss) hing damit an ebayListingLinks,
// die nur der manuelle Voll-Sync baute (Fenster max ~1000 von 3200+ Listings).
// Gemessen: 274 Publishes in 30 Tagen, ~96 % ohne Link, ops.listingStatus null —
// der ListingSyncRunner setzte 'active' sogar aktiv auf 'not_listed' zurueck.
//
// Diese Tests zementieren: recordPublishedListingLinkage verankert nach dem
// Publish sofort (1) das Link-Doc (method 'publish', Konfidenz 1 — KEINE
// Heuristik, das Wissen ist exakt), (2) das Spiegel-Doc (active:true, sku +
// skuIndex fuer den sku-index-Join), (3) ops.listingStatus.ebay='active'.

const linkWrites = [];
const mirrorWrites = [];
const productWrites = [];
let mirrorDocExists = false;

const mockFirestore = {
  collection: (name) => ({
    doc: (id) => ({
      get: async () => ({ exists: name === 'ebayListingsLive' ? mirrorDocExists : false, id }),
      set: async (payload, opts) => {
        const entry = { id, payload, opts };
        if (name === 'ebayListingLinks') linkWrites.push(entry);
        else if (name === 'ebayListingsLive') mirrorWrites.push(entry);
        else if (name === 'products_v2') productWrites.push(entry);
      },
      update: async () => {},
    }),
    where: () => ({
      get: async () => ({ empty: true, docs: [] }),
      limit: () => ({ get: async () => ({ empty: true, docs: [] }) }),
      select: () => ({ get: async () => ({ empty: true, docs: [] }) }),
    }),
    get: async () => ({ empty: true, docs: [] }),
    add: async () => {},
  }),
  getAll: async (...refs) => refs.map((r) => ({ exists: false, id: 'x' })),
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

const { recordPublishedListingLinkage } = require('../lib/ebay-direct');

describe('recordPublishedListingLinkage — Publish verankert das Listing sofort lokal', () => {
  beforeEach(() => {
    linkWrites.length = 0;
    mirrorWrites.length = 0;
    productWrites.length = 0;
    mirrorDocExists = false;
  });

  it('schreibt Link-Doc mit method publish, Konfidenz 1 und der EXAKTEN productId', async () => {
    const result = await recordPublishedListingLinkage({
      productId: 'prod-1',
      itemId: '800539945637',
      sku: 'SKU-1637470122',
      title: 'Testartikel',
      actor: 'tester@trendocean.de',
    });

    expect(result.linked).toBe(true);
    expect(linkWrites.length).toBe(1);
    expect(linkWrites[0].id).toBe('800539945637');
    expect(linkWrites[0].payload.status).toBe('matched');
    expect(linkWrites[0].payload.method).toBe('publish');
    expect(linkWrites[0].payload.confidence).toBe(1);
    expect(linkWrites[0].payload.productId).toBe('prod-1');
    expect(linkWrites[0].payload.listingSku).toBe('SKU-1637470122');
    expect(linkWrites[0].opts).toEqual({ merge: true });
  });

  it('schreibt Spiegel-Doc active:true mit sku + skuIndex (der sku-index-Join liest beides)', async () => {
    await recordPublishedListingLinkage({
      productId: 'prod-1',
      itemId: '800539945637',
      sku: 'SKU-1637470122',
      actor: 'tester',
    });

    expect(mirrorWrites.length).toBe(1);
    expect(mirrorWrites[0].id).toBe('800539945637');
    expect(mirrorWrites[0].payload.active).toBe(true);
    expect(mirrorWrites[0].payload.sku).toBe('SKU-1637470122');
    expect(mirrorWrites[0].payload.skuIndex).toEqual(['SKU-1637470122']);
    expect(mirrorWrites[0].opts).toEqual({ merge: true });
    // Neues Doc → firstSeenAt wird gesetzt
    expect(mirrorWrites[0].payload.firstSeenAt).toBeDefined();
    // Neues Doc → Default-Site-URL (Publish geht immer auf ebay.de/Site 77),
    // damit die Site-Spalte sofort stimmt statt ≤15 min 'Unbekannt'.
    expect(mirrorWrites[0].payload.viewItemUrl).toBe('https://www.ebay.de/itm/800539945637');
  });

  it('ueberschreibt firstSeenAt und viewItemUrl eines VORHANDENEN Spiegel-Docs nicht', async () => {
    mirrorDocExists = true;
    await recordPublishedListingLinkage({
      productId: 'prod-1',
      itemId: '800539945637',
      sku: 'SKU-1637470122',
    });
    expect(mirrorWrites.length).toBe(1);
    expect(mirrorWrites[0].payload.firstSeenAt).toBeUndefined();
    expect(mirrorWrites[0].payload.viewItemUrl).toBeUndefined();
  });

  it('setzt ops.listingStatus.ebay=active auf dem Produkt (merge, additiv)', async () => {
    await recordPublishedListingLinkage({
      productId: 'prod-1',
      itemId: '800539945637',
      sku: 'SKU-1637470122',
    });
    expect(productWrites.length).toBe(1);
    expect(productWrites[0].id).toBe('prod-1');
    expect(productWrites[0].payload.ops.listingStatus.ebay).toBe('active');
    expect(productWrites[0].payload.ops.listingStatus.lastSyncAt).toBeTruthy();
    expect(productWrites[0].opts).toEqual({ merge: true });
  });

  it('ohne productId/itemId: kein Write (skipped)', async () => {
    const r1 = await recordPublishedListingLinkage({ productId: '', itemId: '800' });
    const r2 = await recordPublishedListingLinkage({ productId: 'p', itemId: '' });
    expect(r1.skipped).toBe(true);
    expect(r2.skipped).toBe(true);
    expect(linkWrites.length).toBe(0);
    expect(mirrorWrites.length).toBe(0);
    expect(productWrites.length).toBe(0);
  });

  it('fehlende SKU ueberschreibt sku/skuIndex im Spiegel NICHT mit null', async () => {
    await recordPublishedListingLinkage({ productId: 'prod-1', itemId: '800539945637', sku: null });
    expect(mirrorWrites.length).toBe(1);
    expect('sku' in mirrorWrites[0].payload).toBe(false);
    expect('skuIndex' in mirrorWrites[0].payload).toBe(false);
  });
});

describe('publishProduct-Verdrahtung (Source-Gate)', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ebay-direct.js'), 'utf8');

  it('publishProduct ruft recordPublishedListingLinkage auf — best-effort im try/catch (ein Fehler darf den Publish-Erfolg nie maskieren, sonst Doppel-Listing)', () => {
    const start = source.indexOf('async function publishProduct(');
    const end = source.indexOf('async function bulkVerifyPublishProducts');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain('recordPublishedListingLinkage(');
    // Der Aufruf muss in einem try-Block stehen, dessen catch NICHT wirft.
    const callIdx = body.indexOf('recordPublishedListingLinkage(');
    const tryIdx = body.lastIndexOf('try {', callIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    const catchIdx = body.indexOf('catch', callIdx);
    expect(catchIdx).toBeGreaterThan(callIdx);
  });
});
