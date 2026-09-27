const stockQuantities = require('../lib/marketplace-stock-quantity');
stockQuantities.readLocatedQuantity = async product => stockQuantities.locatedQuantity(product);
// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Incident 2026-07-19 (SKU-6656556112, itemId 800339004471).
//
// Der Zero-Stock-Pfad beendete das eBay-Listing (EndFixedPriceItem/
// NotAvailable). Als der Bestand zurückkam (Reservierungs-Doppelzählung
// aufgelöst / Storno), konnte der Sync das Listing NIE wiederbeleben: Revise
// auf ein beendetes Listing schlägt fehl → clearStaleItemId koppelte das
// Produkt dauerhaft ab, danach übersprang jeder Sync eBay still. Kein Fehler,
// kein Drain, kein Alarm — das Produkt hatte Bestand, aber kein Angebot.
//
// Fix (Selbstheilung):
//  1. Zero-Stock-End schreibt Marker ops.ebay.zeroStockEnd {itemId, at}.
//  2. Bestand zurück + Marker → RelistFixedPriceItem statt Silent-Skip.
//  3. Ohne Marker (Operator-/eBay-seitiges Ende) wird NIE auto-relistet.
//  4. Lebt ein ANDERES Listing derselben SKU, wird umgehängt statt dupliziert.
//  5. Relist-Fehler → retryable Failure (Drain), NIEMALS destruktiv.

let reviseImpl = async () => ({ ack: 'Success' });
let relistImpl = async () => ({ ack: 'Success', itemId: 'NEW-ITEM-1' });
let endImpl = async () => ({ ack: 'Success' });
const reviseCalls = [];
const endCalls = [];
const relistCalls = [];
const productUpdates = [];
const mirrorSets = [];
let ebayLiveDocs = [];
let mirrorDocData = {};
let mirrorReadError = null;
let freshReadError = null;
let reservationReadError = null;

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'products_v2') {
      return {
        doc: vi.fn((id) => ({
          get: async () => { if (freshReadError) throw freshReadError; return { exists: false }; },
          set: async () => {},
          update: async (payload) => { productUpdates.push({ id, payload }); },
        })),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => ({ empty: true, docs: [] }),
      };
    }
    if (name === 'ebayListingsLive') {
      const docsForQuery = () => ebayLiveDocs.map((d) => ({
        id: d.id,
        data: () => ({ ...d }),
        ref: { set: async (payload) => { mirrorSets.push({ id: d.id, payload }); } },
      }));
      let queryLimit = Infinity;
      let afterId = null;
      const chain = {
        where: vi.fn(() => chain),
        limit: vi.fn((n) => { queryLimit = n; return chain; }),
        startAfter: vi.fn((doc) => { afterId = doc.id; return chain; }),
        get: async () => {
          if (mirrorReadError) throw mirrorReadError;
          const all = docsForQuery();
          const start = afterId === null ? 0 : all.findIndex(d => d.id === afterId) + 1;
          const docs = all.slice(start, start + queryLimit);
          return { empty: docs.length === 0, docs };
        },
        doc: vi.fn((id) => ({
          set: async (payload) => { mirrorSets.push({ id, payload }); },
          get: async () => ({ exists: Boolean(mirrorDocData[id]), data: () => mirrorDocData[id] || {} }),
        })),
      };
      return chain;
    }
    return {
      add: vi.fn(async () => {}),
      doc: vi.fn(() => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} })),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: async () => ({ empty: true, docs: [] }),
    };
  }),
};

function patch(path, exports) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

patch('../lib/firestore', { firestore: mockFirestore });
patch('../lib/stock-lock', { withStockLock: async (_key, fn) => fn() });
patch('../services/stock-reservation', { getReservedQuantity: async () => { if (reservationReadError) throw reservationReadError; return 0; } });
const opsAlerts = [];
patch('../lib/ops-alert', { emitOpsAlert: (a) => { opsAlerts.push(a); } });
patch('../lib/ebay-trading-api', {
  reviseFixedPriceItem: async (payload) => { reviseCalls.push(payload); return reviseImpl(payload); },
  endFixedPriceItem: async (...args) => { endCalls.push(args); return endImpl(...args); },
  relistFixedPriceItem: async (itemId, opts) => { relistCalls.push({ itemId, ...opts }); return relistImpl(itemId, opts); },
});

const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');

function baseProduct(overrides = {}) {
  return {
    id: 'prod-6656556112',
    tenantId: 'default',
    identification: { sku: 'SKU-6656556112' },
    inventory: { quantity: 1 },
    storageBins: [{ code: 'A-01', quantity: overrides.inventory?.quantity ?? 1 }],
    ops: { ebay: { itemId: '800339004471' } },
    ...overrides,
  };
}

beforeEach(() => {
  reviseCalls.length = 0;
  endCalls.length = 0;
  relistCalls.length = 0;
  productUpdates.length = 0;
  mirrorSets.length = 0;
  ebayLiveDocs = [];
  mirrorDocData = {};
  mirrorReadError = null;
  freshReadError = null;
  reservationReadError = null;
  delete process.env.EBAY_LISTING_PAGINATION;
  opsAlerts.length = 0;
  reviseImpl = async () => ({ ack: 'Success' });
  relistImpl = async () => ({ ack: 'Success', itemId: 'NEW-ITEM-1' });
  endImpl = async () => ({ ack: 'Success' });
});

afterEach(() => { delete process.env.EBAY_LISTING_PAGINATION; });

describe('Vollständiger Listing-Abgleich', () => {
  it('belegt die alte Lücke bei ausgeschalteter Pagination', async () => {
    ebayLiveDocs = Array.from({ length: 205 }, (_, i) => ({ id: `old-${i}`, active: false }));
    ebayLiveDocs.push({ id: 'late-active', active: true });
    await syncStockToAllChannels({ tenantId: 'default', product: baseProduct(), onlyChannels: ['ebay'] });
    expect(reviseCalls.map(call => call.itemId)).not.toContain('late-active');
  });

  it('erreicht ein aktives Länderangebot hinter vielen historischen Einträgen', async () => {
    process.env.EBAY_LISTING_PAGINATION = 'on';
    ebayLiveDocs = Array.from({ length: 205 }, (_, i) => ({ id: `old-${i}`, active: false }));
    ebayLiveDocs.push({ id: 'late-active', active: true });
    await syncStockToAllChannels({ tenantId: 'default', product: baseProduct(), onlyChannels: ['ebay'] });
    expect(reviseCalls.map(call => call.itemId)).toContain('late-active');
  });

  it('ändert bei unvollständigem Read kein Angebot, sondern liefert einen dauerhaften Retry-Kandidaten', async () => {
    process.env.EBAY_LISTING_PAGINATION = 'on';
    mirrorReadError = new Error('unavailable');
    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: baseProduct({ inventory: { quantity: 0 } }), onlyChannels: ['ebay'] });
    expect(endCalls).toHaveLength(0);
    expect(reviseCalls).toHaveLength(0);
    expect(relistCalls).toHaveLength(0);
    expect(results).toContainEqual(expect.objectContaining({ status: 'failed', retryable: true, action: 'listing_lookup_incomplete' }));
  });
});

describe('Zero-Stock-End schreibt den Selbstheilungs-Marker', () => {
  it('setzt ops.ebay.zeroStockEnd nach erfolgreichem End', async () => {
    const product = baseProduct({ inventory: { quantity: 0 } });

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'shipped-test' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(endCalls.length).toBe(1);
    expect(ebay.action).toBe('ended');
    const markerUpdate = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEnd']);
    expect(markerUpdate).toBeTruthy();
    expect(markerUpdate.payload['ops.ebay.zeroStockEnd'].itemId).toBe('800339004471');
    expect(markerUpdate.payload['ops.ebay.zeroStockEnd'].at).toBeTruthy();
  });

  it('setzt bei already_ended KEINEN Marker (kann Operator-Ende sein — nie ungefragt wiederbeleben)', async () => {
    const product = baseProduct({ inventory: { quantity: 0 } });
    endImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'shipped-test' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(endCalls.length).toBe(1);
    expect(ebay.action).toBe('already_ended');
    const markerUpdate = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEnd']);
    expect(markerUpdate).toBeUndefined();
  });
});

describe('Betreiberregel: Wiederaktivierung ausschließlich manuell', () => {
  it.each([true, false])('relistet bei Bestandsrückkehr nie (Pointer vorhanden: %s)', async (hasPointer) => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    const product = baseProduct({ ops: { ebay: {
      itemId: hasPointer ? '800339004471' : null,
      zeroStockEnd: { itemId: '800339004471', at: new Date().toISOString(), siblingItemIds: ['sibling'] },
    } } });
    const { results } = await syncStockToAllChannels({ tenantId: 'default', product });
    expect(relistCalls).toHaveLength(0);
    expect(endCalls).toHaveLength(0);
    expect(results).toContainEqual(expect.objectContaining({ channel: 'ebay', status: 'skipped', action: 'manual_reactivation_required' }));
  });

  it('aktualisiert ein weiterhin aktives Angebot bei positivem Bestand', async () => {
    await syncStockToAllChannels({ tenantId: 'default', product: baseProduct() });
    expect(reviseCalls).toContainEqual(expect.objectContaining({ itemId: '800339004471', quantity: 1 }));
    expect(relistCalls).toHaveLength(0);
  });

  it('beachtet auch ohne End-Marker die manuelle Beendigung', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    await syncStockToAllChannels({ tenantId: 'default', product: baseProduct() });
    expect(relistCalls).toHaveLength(0);
    expect(endCalls).toHaveLength(0);
  });
});

describe('Multi-Site-Fan-Out: alle Länder-Listings der SKU werden bedient (2026-07-21)', () => {
  it('Stock>0: revised das getrackte Listing UND alle aktiven Geschwister-Sites mit derselben Menge', async () => {
    const product = baseProduct({ inventory: { quantity: 3 } });
    ebayLiveDocs = [
      { id: '800339004471', itemId: '800339004471', sku: 'SKU-6656556112', active: true },  // getrackt (DE)
      { id: 'IT-1', itemId: 'IT-1', sku: 'SKU-6656556112', active: true },
      { id: 'ES-1', itemId: 'ES-1', sku: 'SKU-6656556112', active: true },
      { id: 'BE-ENDED', itemId: 'BE-ENDED', sku: 'SKU-6656556112', active: false },        // inaktiv → skip
    ];

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const ebayResults = results.filter((r) => r.channel === 'ebay');

    const revisedIds = reviseCalls.map((c) => c.itemId).sort();
    expect(revisedIds).toEqual(['800339004471', 'ES-1', 'IT-1'].sort());
    expect(reviseCalls.every((c) => c.quantity === 3)).toBe(true);
    expect(ebayResults.filter((r) => r.action === 'revise_sibling_site').length).toBe(2);
    expect(endCalls.length).toBe(0);
  });

  it('Zero-Stock: beendet das getrackte Listing UND alle aktiven Geschwister-Sites', async () => {
    const product = baseProduct({ inventory: { quantity: 0 } });
    ebayLiveDocs = [
      { id: '800339004471', itemId: '800339004471', sku: 'SKU-6656556112', active: true },
      { id: 'IT-1', itemId: 'IT-1', sku: 'SKU-6656556112', active: true },
      { id: 'FR-1', itemId: 'FR-1', sku: 'SKU-6656556112', active: true },
    ];

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'shipped-x' });
    const endedIds = endCalls.map((c) => String(c[0])).sort();

    expect(endedIds).toEqual(['800339004471', 'FR-1', 'IT-1'].sort());
    const siblingEnds = results.filter((r) => r.action === 'ended_sibling_site');
    expect(siblingEnds.length).toBe(2);
    // Geschwister-Mirror-Rows werden inaktiv gestempelt
    const deact = mirrorSets.filter((m) => m.payload?.active === false).map((m) => m.id).sort();
    expect(deact).toEqual(['FR-1', 'IT-1'].sort());
  });

  it('totes/fremdes Geschwister → nur dessen Mirror-Row deaktiviert, kein Drain-Retry', async () => {
    const product = baseProduct({ inventory: { quantity: 2 } });
    ebayLiveDocs = [
      { id: '800339004471', itemId: '800339004471', sku: 'SKU-6656556112', active: true },
      { id: 'AT-DEAD', itemId: 'AT-DEAD', sku: 'SKU-6656556112', active: true },
    ];
    reviseImpl = async (payload) => {
      if (payload.itemId === 'AT-DEAD') throw new Error('Die Auktion wurde bereits beendet.');
      return { ack: 'Success' };
    };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const sib = results.find((r) => r.itemId === 'AT-DEAD');

    expect(sib.status).toBe('skipped');
    expect(sib.retryable).toBeUndefined();
    expect(mirrorSets.some((m) => m.id === 'AT-DEAD' && m.payload.active === false)).toBe(true);
    // Getracktes Listing normal revised
    expect(results.find((r) => r.itemId === '800339004471').status).toBe('success');
  });

  it('transienter Geschwister-Fehler → retryable in den Drain, NIE destruktiv', async () => {
    const product = baseProduct({ inventory: { quantity: 2 } });
    ebayLiveDocs = [
      { id: '800339004471', itemId: '800339004471', sku: 'SKU-6656556112', active: true },
      { id: 'IT-FLAKY', itemId: 'IT-FLAKY', sku: 'SKU-6656556112', active: true },
    ];
    reviseImpl = async (payload) => {
      if (payload.itemId === 'IT-FLAKY') throw new Error('Request timed out');
      return { ack: 'Success' };
    };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const sib = results.find((r) => r.itemId === 'IT-FLAKY');

    expect(sib.status).toBe('failed');
    expect(sib.retryable).toBe(true);
    expect(endCalls.length).toBe(0);
  });
});

describe('Sibling-Relist-Selbstheilung (Lücke 2026-07-22, SKU-9550750665)', () => {
  it('Zero-Stock-Fan-Out schreibt die beendeten Geschwister in den Marker (siblingItemIds)', async () => {
    const product = baseProduct({ inventory: { quantity: 0 } });
    ebayLiveDocs = [
      { id: '800339004471', itemId: '800339004471', sku: 'SKU-6656556112', active: true },
      { id: 'IT-1', itemId: 'IT-1', sku: 'SKU-6656556112', active: true },
      { id: 'ES-1', itemId: 'ES-1', sku: 'SKU-6656556112', active: true },
    ];

    await syncStockToAllChannels({ tenantId: 'default', product, reason: 'shipped-x' });

    const sibUpdate = productUpdates.find((u) => Array.isArray(u.payload['ops.ebay.zeroStockEnd.siblingItemIds']));
    expect(sibUpdate).toBeTruthy();
    expect(sibUpdate.payload['ops.ebay.zeroStockEnd.siblingItemIds'].sort()).toEqual(['ES-1', 'IT-1']);
  });

});

describe('clearStaleItemId deaktiviert NUR die tote ItemID im Mirror', () => {
  it('lässt Mirror-Docs anderer (lebender) Listings derselben SKU unangetastet', async () => {
    // Nur das GETRACKTE Listing ist tot — das Geschwister lebt und nimmt
    // den Fan-Out-Revise an (sonst wäre Deaktivieren beider korrekt).
    reviseImpl = async (payload) => {
      if (String(payload.itemId) === '800339004471') throw new Error('Die Auktion wurde bereits beendet.');
      return { ack: 'Success' };
    };
    const product = baseProduct(); // kein Marker → Skip-Pfad mit clearStaleItemId
    ebayLiveDocs = [
      { id: '800339004471', itemId: '800339004471', sku: 'SKU-6656556112', active: true },
      { id: '800368782370', itemId: '800368782370', sku: 'SKU-6656556112', active: true },
    ];

    await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });

    const deactivated = mirrorSets.filter((m) => m.payload && m.payload.active === false);
    expect(deactivated.length).toBeGreaterThan(0);
    // Nur die tote 800339004471 wird inaktiv gestempelt — 800368782370 nie
    expect(deactivated.every((m) => m.id === '800339004471')).toBe(true);
  });
});


describe('stock sync refuses uncertain inventory', () => {
  for (const source of ['product', 'reservation']) {
    it(`does not increase or end listings on ${source} read failure`, async () => {
      if (source === 'product') freshReadError = new Error('unavailable');
      else reservationReadError = new Error('unavailable');
      const { results } = await syncStockToAllChannels({ tenantId: 'default', product: baseProduct() });
      expect(reviseCalls).toHaveLength(0);
      expect(endCalls).toHaveLength(0);
      expect(relistCalls).toHaveLength(0);
      expect(results.some(r => r.status === 'failed' && r.retryable === true)).toBe(true);
    });
  }
});

it('ends unlocated stock and never relists it, even with an old zero-stock marker', async () => {
 const product = baseProduct({ storageBins: [], ops: { ebay: { itemId: '800339004471', zeroStockEnd: { itemId: '800339004471' } } } });
 await syncStockToAllChannels({ tenantId: 'default', product, onlyChannels: ['ebay'] });
 expect(endCalls).toHaveLength(1);
 expect(relistCalls).toHaveLength(0);
 expect(reviseCalls).toHaveLength(0);
});

it('does not end or relist anything when actual BIN verification is unavailable', async () => {
 const previous = stockQuantities.readLocatedQuantity;
 stockQuantities.readLocatedQuantity = async () => { throw new Error('BIN read unavailable'); };
 try {
  const result = await syncStockToAllChannels({tenantId:'default',product:baseProduct(),onlyChannels:['ebay']});
  expect(result.results[0]).toMatchObject({status:'failed',retryable:true});
  expect(endCalls).toHaveLength(0); expect(reviseCalls).toHaveLength(0); expect(relistCalls).toHaveLength(0);
 } finally { stockQuantities.readLocatedQuantity = previous; }
});
it('ends an offer when a named product location is absent from the actual BIN', async () => {
 const previous = stockQuantities.readLocatedQuantity;
 stockQuantities.readLocatedQuantity = async () => 0;
 try {
  await syncStockToAllChannels({tenantId:'default',product:baseProduct(),onlyChannels:['ebay']});
  expect(endCalls).toHaveLength(1); expect(reviseCalls).toHaveLength(0); expect(relistCalls).toHaveLength(0);
 } finally { stockQuantities.readLocatedQuantity = previous; }
});
