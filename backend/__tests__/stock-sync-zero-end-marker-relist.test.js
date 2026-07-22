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

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'products_v2') {
      return {
        doc: vi.fn((id) => ({
          get: async () => ({ exists: false }),
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
      const chain = {
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        get: async () => {
          const docs = docsForQuery();
          return { empty: docs.length === 0, docs };
        },
        doc: vi.fn((id) => ({
          set: async (payload) => { mirrorSets.push({ id, payload }); },
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
patch('../services/stock-reservation', { getReservedQuantity: async () => 0 });
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
  opsAlerts.length = 0;
  reviseImpl = async () => ({ ack: 'Success' });
  relistImpl = async () => ({ ack: 'Success', itemId: 'NEW-ITEM-1' });
  endImpl = async () => ({ ack: 'Success' });
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

describe('Selbstheilung: Bestand zurück → Relist', () => {
  it('relistet via Marker wenn Revise mit "beendet" fehlschlägt (der Incident-Fall)', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    const product = baseProduct({
      ops: { ebay: { itemId: '800339004471', zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z', reason: 'shipped' } } },
    });

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'cancelled-resync' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(relistCalls.length).toBe(1);
    expect(relistCalls[0].itemId).toBe('800339004471');
    expect(relistCalls[0].quantity).toBe(1);
    expect(ebay.status).toBe('success');
    expect(ebay.action).toBe('relisted');
    expect(ebay.itemId).toBe('NEW-ITEM-1');
    // Produkt hängt an der neuen ItemID, Marker ist geleert
    const relistUpdate = productUpdates.find((u) => u.payload['ops.ebay.itemId'] === 'NEW-ITEM-1');
    expect(relistUpdate).toBeTruthy();
    expect(relistUpdate.payload['ops.ebay.zeroStockEnd']).toBe(null);
    expect(relistUpdate.payload['listingStatus.ebay']).toBe('active');
    // Mirror-Seed für die neue ItemID, damit der nächste Sync sie sofort findet
    const seed = mirrorSets.find((m) => m.id === 'NEW-ITEM-1');
    expect(seed).toBeTruthy();
    expect(seed.payload.active).toBe(true);
    expect(endCalls.length).toBe(0);
  });

  it('relistet im Post-Clear-Zustand (keine ItemID mehr, nur Marker) — vorher Silent-Skip für immer', async () => {
    const product = baseProduct({
      ops: { ebay: { itemId: null, zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z', reason: 'shipped' } } },
    });
    ebayLiveDocs = []; // kein aktives Listing im Mirror

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'ended-with-stock-heal' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(relistCalls.length).toBe(1);
    expect(relistCalls[0].itemId).toBe('800339004471');
    expect(ebay.status).toBe('success');
    expect(ebay.action).toBe('relisted');
    expect(reviseCalls.length).toBe(0);
    expect(endCalls.length).toBe(0);
  });

  it('relistet NICHT ohne Marker (Operator-/eBay-seitig beendet) — heutiges Skip-Verhalten bleibt', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    const product = baseProduct(); // kein zeroStockEnd-Marker

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(relistCalls.length).toBe(0);
    expect(ebay.status).toBe('skipped');
    expect(ebay.error).toBe('listing_ended');
  });

  it('hängt auf ein ANDERES aktives Listing um statt zu duplizieren (Operator-Relist auf eBay)', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    const product = baseProduct({
      ops: { ebay: { itemId: '800339004471', zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z', reason: 'shipped' } } },
    });
    ebayLiveDocs = [
      { id: '800339004471', itemId: '800339004471', sku: 'SKU-6656556112', active: false },
      { id: '800368782370', itemId: '800368782370', sku: 'SKU-6656556112', active: true },
    ];

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(relistCalls.length).toBe(0);
    expect(ebay.action).toBe('switched_to_other_active_listing');
    expect(ebay.itemId).toBe('800368782370');
    const switchUpdate = productUpdates.find((u) => u.payload['ops.ebay.itemId'] === '800368782370');
    expect(switchUpdate).toBeTruthy();
    // Review-Finding 1/6/12: der Switch ist optimistisch (Mirror kann stale
    // sein) — der Marker darf NICHT verbraucht werden. Erst ein erfolgreicher
    // Revise/Relist beweist Leben und leert ihn.
    expect(switchUpdate.payload['ops.ebay.zeroStockEnd']).toBeUndefined();
  });

  it('leert den Marker erst bei ERFOLGREICHEM Revise (Liveness-Beweis)', async () => {
    const product = baseProduct({
      ops: { ebay: { itemId: '800368782370', zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z', reason: 'shipped' } } },
    });
    reviseImpl = async () => ({ ack: 'Success' });

    await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });

    const clearUpdate = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEnd'] === null);
    expect(clearUpdate).toBeTruthy();
  });

  it('relistet NICHT bei Marker-Mismatch (Marker für ItemID A, beendet wurde B → Operator-Entscheid respektieren)', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    const product = baseProduct({
      ops: { ebay: { itemId: 'B-OPERATOR-LISTING', zeroStockEnd: { itemId: 'A-OLD-ENDED', at: '2026-07-19T17:25:26Z', reason: 'shipped' } } },
    });

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(relistCalls.length).toBe(0);
    expect(ebay.status).toBe('skipped');
    expect(ebay.error).toBe('listing_ended');
  });

  it('gibt nach MAX_RELIST_ATTEMPTS auf: Marker geleert, Audit-Feld, Ops-Alarm, kein Drain-Retry mehr', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    const product = baseProduct({
      ops: { ebay: { itemId: '800339004471', zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z', reason: 'shipped', relistAttempts: 5 } } },
    });

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(relistCalls.length).toBe(0);
    expect(ebay.action).toBe('relist_abandoned');
    expect(ebay.status).toBe('skipped');
    const abandonUpdate = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEnd'] === null && u.payload['ops.ebay.zeroStockEndAbandoned']);
    expect(abandonUpdate).toBeTruthy();
    expect(opsAlerts.length).toBeGreaterThan(0);
  });

  it('permanenter Relist-Fehler ("cannot be relisted") → sofort aufgeben statt Drain-Endlosschleife', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    relistImpl = async () => { throw new Error('This item cannot be relisted.'); };
    const product = baseProduct({
      ops: { ebay: { itemId: '800339004471', zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z', reason: 'shipped' } } },
    });

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(ebay.action).toBe('relist_permanently_failed');
    expect(ebay.status).toBe('skipped');
    expect(ebay.retryable).toBeUndefined();
    const abandonUpdate = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEndAbandoned']);
    expect(abandonUpdate).toBeTruthy();
  });

  it('transienter Relist-Fehler → retryable Failure für den Drain + Versuchszähler, NIEMALS destruktiv (Punkt 14)', async () => {
    reviseImpl = async () => { throw new Error('Die Auktion wurde bereits beendet.'); };
    relistImpl = async () => { throw new Error('Request timed out'); };
    const product = baseProduct({
      ops: { ebay: { itemId: '800339004471', zeroStockEnd: { itemId: '800339004471', at: '2026-07-19T17:25:26Z', reason: 'shipped' } } },
    });

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(ebay.status).toBe('failed');
    expect(ebay.retryable).toBe(true);
    expect(ebay.action).toBe('relist_failed');
    expect(endCalls.length).toBe(0);
    const attemptStamp = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEnd.relistAttempts'] === 1);
    expect(attemptStamp).toBeTruthy();
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

  it('Marker-Relist belebt Geschwister UND getracktes Listing wieder — Marker erst am Ende geleert', async () => {
    let n = 0;
    relistImpl = async () => ({ ack: 'Success', itemId: `NEW-${++n}` });
    const product = baseProduct({
      inventory: { quantity: 2 },
      ops: { ebay: { itemId: null, zeroStockEnd: { itemId: 'DE-OLD', at: '2026-07-21T09:14:38Z', reason: 'shipped', siblingItemIds: ['AT-OLD', 'IT-OLD'] } } },
    });
    ebayLiveDocs = [];

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'ended-with-stock-heal' });

    const relistedIds = relistCalls.map((c) => c.itemId).sort();
    expect(relistedIds).toEqual(['AT-OLD', 'DE-OLD', 'IT-OLD'].sort());
    expect(results.filter((r) => r.action === 'relisted_sibling').length).toBe(2);
    expect(results.filter((r) => r.action === 'relisted').length).toBe(1);
    // Geschwister-Erfolge kürzen die Marker-Liste, getrackter Erfolg leert den Marker
    const clearUpdate = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEnd'] === null);
    expect(clearUpdate).toBeTruthy();
    // Mirror-Seeds für alle neuen IDs
    expect(mirrorSets.filter((m) => m.payload?.active === true).length).toBeGreaterThanOrEqual(3);
  });

  it('permanent unrelistbares Geschwister wird übersprungen, Rest + getracktes laufen weiter', async () => {
    relistImpl = async (itemId) => {
      if (itemId === 'ALT-KONTO') throw new Error('Sie sind nicht der Verkäufer dieses Artikels.');
      return { ack: 'Success', itemId: `NEW-${itemId}` };
    };
    const product = baseProduct({
      inventory: { quantity: 1 },
      ops: { ebay: { itemId: null, zeroStockEnd: { itemId: 'DE-OLD', at: '2026-07-21T09:14:38Z', reason: 'x', siblingItemIds: ['ALT-KONTO', 'IT-OLD'] } } },
    });
    ebayLiveDocs = [];

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'heal' });

    expect(results.find((r) => r.action === 'sibling_relist_permanently_failed')?.itemId).toBe('ALT-KONTO');
    expect(results.filter((r) => r.action === 'relisted_sibling').length).toBe(1);
    expect(results.filter((r) => r.action === 'relisted').length).toBe(1);
  });

  it('transienter Geschwister-Fehler stoppt den Lauf: Marker bleibt, retryable in den Drain, getracktes NICHT relistet', async () => {
    relistImpl = async (itemId) => {
      if (itemId === 'IT-FLAKY') throw new Error('Request timed out');
      return { ack: 'Success', itemId: `NEW-${itemId}` };
    };
    const product = baseProduct({
      inventory: { quantity: 1 },
      ops: { ebay: { itemId: null, zeroStockEnd: { itemId: 'DE-OLD', at: '2026-07-21T09:14:38Z', reason: 'x', siblingItemIds: ['IT-FLAKY', 'ES-OLD'] } } },
    });
    ebayLiveDocs = [];

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'heal' });

    const sib = results.find((r) => r.action === 'sibling_relist_failed');
    expect(sib.retryable).toBe(true);
    expect(results.filter((r) => r.action === 'relisted').length).toBe(0);
    const clearUpdate = productUpdates.find((u) => u.payload['ops.ebay.zeroStockEnd'] === null);
    expect(clearUpdate).toBeUndefined();
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
