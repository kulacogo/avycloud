// globals: true in vitest.config.js
'use strict';

/**
 * Regression Vorfall 2026-09-25/26: der Tracking-Nachholer war blind.
 *
 * Er fragte `omsStatus=='shipped' AND updatedAt>=cutoff` mit `.limit(50)`.
 * Firestore sortiert dabei nach dem Ungleichheitsfeld AUFSTEIGEND — geliefert
 * wurden die 50 AELTESTEN versendeten Auftraege. Gemessen: 94 im Fenster, die
 * 50 gelieferten reichten vom 21.09. bis 24.09. und waren alle schon gemeldet.
 * Die 13 frischen Fehlschlaege vom 25.09. lagen hinter Platz 50 — der
 * Nachholer lief viermal und fasste sie nie an.
 *
 * Das Fake-Firestore unten bildet genau diese Sortier-/Limit-Semantik nach,
 * damit ein Rueckfall auf eine gefensterte, gekappte Abfrage hier auffaellt.
 */

function patch(path, exports) {
  require.cache[require.resolve(path)] = {
    id: require.resolve(path), filename: require.resolve(path), loaded: true, exports, children: [], paths: [],
  };
}

// ─── Fake-Firestore mit echter where/limit/Sortier-Semantik ─────────────────
const docs = new Map();

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function makeQuery(filters = [], limitN = null) {
  return {
    where: (field, op, value) => makeQuery([...filters, { field, op, value }], limitN),
    limit: (n) => makeQuery(filters, n),
    get: async () => {
      let rows = [...docs.entries()].filter(([, d]) => filters.every(({ field, op, value }) => {
        const v = getPath(d, field);
        if (op === '==') return v === value;
        if (op === '>=') return typeof v === typeof value && v >= value;
        if (op === 'in') return value.includes(v);
        throw new Error(`op ${op} not supported in fake`);
      }));
      // Firestore: bei Ungleichheit wird nach diesem Feld aufsteigend sortiert,
      // sonst nach Dokument-ID.
      const ineq = filters.find((f) => f.op === '>=');
      rows.sort(([ia, a], [ib, b]) => (ineq
        ? String(getPath(a, ineq.field)).localeCompare(String(getPath(b, ineq.field)))
        : ia.localeCompare(ib)));
      if (limitN != null) rows = rows.slice(0, limitN);
      const out = rows.map(([id]) => snap(id));
      return { size: out.length, empty: out.length === 0, docs: out };
    },
  };
}

function ref(id) {
  return {
    id,
    get: async () => snap(id),
    set: async (data, opts) => {
      const prev = docs.get(id) || {};
      docs.set(id, opts?.merge ? { ...prev, ...data } : data);
    },
    update: async (data) => { docs.set(id, { ...(docs.get(id) || {}), ...data }); },
  };
}

function snap(id) {
  const data = docs.get(id);
  return { id, exists: !!data, data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined), ref: ref(id) };
}

function MockFirestore() {
  return {
    collection: () => ({
      where: (field, op, value) => makeQuery([{ field, op, value }]),
      doc: (id) => ref(id),
    }),
  };
}
patch('@google-cloud/firestore', { Firestore: MockFirestore });
patch('../lib/error-collector', { collectError: () => {} });

const completeSaleFor = [];
patch('../lib/ebay-trading-api', {
  getEbayTradingConfig: async () => ({ userToken: 'tok', compatibilityLevel: '1.0.0' }),
  buildRequestRoot: (_n, inner) => inner,
  callTradingApi: async (_callName, xml) => {
    completeSaleFor.push(/<OrderID>([^<]+)</.exec(xml)[1]);
    return { ack: 'Success', errors: [] };
  },
});

const {
  retryFailedTrackingPushes,
  retryFailedMarketplacePushes,
  classifyTrackingCatchup,
} = require('../services/marketplace-tracking');

const NOW = Date.parse('2026-09-26T13:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 60 * 60 * 1000;

function seedIncident() {
  docs.clear();
  completeSaleFor.length = 0;
  // 60 aeltere, laengst erfolgreich gemeldete Versendungen (21.–24.09.)
  for (let i = 0; i < 60; i++) {
    docs.set(`ebay__old-${String(i).padStart(2, '0')}`, {
      marketplace: 'ebay', marketplaceOrderId: `old-${i}`, omsStatus: 'shipped',
      trackingNumber: `OLD${i}`, updatedAt: iso((5 * 24 - i) * H), shippedAt: iso((5 * 24 - i) * H),
      marketplacePush: { status: 'success', attempts: 0 },
    });
  }
  // 13 frische Fehlschlaege vom 25.09. morgens (Kontingent leer)
  for (let i = 0; i < 13; i++) {
    docs.set(`ebay__new-${String(i).padStart(2, '0')}`, {
      marketplace: 'ebay', marketplaceOrderId: `new-${i}`, omsStatus: 'shipped', shippingService: 'dhl_de',
      trackingNumber: `NEW${i}`, updatedAt: iso(30 * H - i * 60000), shippedAt: iso(30 * H - i * 60000),
      marketplacePush: { status: 'failed', attempts: 2, error: 'eBay Trading skipped for CompleteSale: exceeded usage limit (quota cooldown 42s)' },
    });
  }
}

describe('Tracking-Nachholer: kein blinder Fleck mehr', () => {
  it('die ALTE Abfrage haette die 13 Fehlschlaege nicht gesehen (Beleg fuer das Fake)', async () => {
    seedIncident();
    const cutoff = new Date(NOW - 7 * 24 * H).toISOString();
    const oldQuery = await MockFirestore().collection('orders')
      .where('omsStatus', '==', 'shipped').where('updatedAt', '>=', cutoff).limit(50).get();
    expect(oldQuery.docs.map((d) => d.id).filter((id) => id.startsWith('ebay__new'))).toHaveLength(0);
  });

  it('meldet ALLE 13 fehlgeschlagenen Versendungen nach — unabhaengig von Menge und Alter der uebrigen', async () => {
    seedIncident();

    const stats = await retryFailedTrackingPushes({ nowMs: NOW });

    expect(stats.retried).toBe(13);
    expect(stats.succeeded).toBe(13);
    expect(completeSaleFor.sort()).toEqual(Array.from({ length: 13 }, (_, i) => `new-${i}`).sort());
    for (let i = 0; i < 13; i++) {
      expect(docs.get(`ebay__new-${String(i).padStart(2, '0')}`).marketplacePush).toMatchObject({ status: 'success', via: 'trading' });
    }
  });

  it('meldet auch nach, wenn der Auftrag inzwischen als zugestellt gilt', async () => {
    seedIncident();
    docs.get('ebay__new-00').omsStatus = 'delivered';

    await retryFailedTrackingPushes({ nowMs: NOW });

    expect(completeSaleFor).toContain('new-0');
  });

  it('der 2-h-Lauf findet zusaetzlich Versendungen ganz OHNE Push-Versuch — auch jenseits von Platz 50', async () => {
    seedIncident();
    docs.set('ebay__never', {
      marketplace: 'ebay', marketplaceOrderId: 'never', omsStatus: 'shipped', shippingService: 'dpd',
      trackingNumber: 'NEVER1', updatedAt: iso(H), shippedAt: iso(H),
    });

    const stats = await retryFailedMarketplacePushes({});

    expect(completeSaleFor).toContain('never');
    expect(stats.retried).toBeGreaterThanOrEqual(14);
  });

  it('laeuft nicht doppelt, wenn ein Lauf noch aktiv ist', async () => {
    seedIncident();
    const [a, b] = await Promise.all([
      retryFailedTrackingPushes({ nowMs: NOW }),
      retryFailedTrackingPushes({ nowMs: NOW }),
    ]);
    expect([a.skippedRunning, b.skippedRunning].filter(Boolean)).toHaveLength(1);
    expect(completeSaleFor).toHaveLength(13);
  });

  it('gibt nach Ablauf des Nachholfensters auf (sichtbar, statt ewig weiterzuversuchen)', async () => {
    seedIncident();
    const d = docs.get('ebay__new-05');
    d.shippedAt = iso(20 * 24 * H);

    const stats = await retryFailedTrackingPushes({ nowMs: NOW, maxAgeDays: 14 });

    expect(stats.expired).toBe(1);
    expect(docs.get('ebay__new-05').marketplacePush.status).toBe('abandoned');
    expect(completeSaleFor).not.toContain('new-5');
  });
});

describe('classifyTrackingCatchup', () => {
  const base = {
    marketplace: 'ebay', omsStatus: 'shipped', trackingNumber: 'T', shippedAt: iso(H),
    marketplacePush: { status: 'failed' },
  };

  it('pusht einen gescheiterten versendeten Auftrag', () => {
    expect(classifyTrackingCatchup(base, { nowMs: NOW })).toMatchObject({ action: 'push', trackingNumber: 'T' });
  });

  it('ueberspringt Storno, fehlende Nummer, fremden Mandanten, erledigte Pushes', () => {
    expect(classifyTrackingCatchup({ ...base, omsStatus: 'cancelled' }, { nowMs: NOW }).action).toBe('skip');
    expect(classifyTrackingCatchup({ ...base, trackingNumber: null }, { nowMs: NOW }).reason).toBe('no_tracking');
    expect(classifyTrackingCatchup({ ...base, tenantId: 'other' }, { nowMs: NOW }).reason).toBe('other_tenant');
    expect(classifyTrackingCatchup({ ...base, marketplacePush: { status: 'success' } }, { nowMs: NOW }).action).toBe('skip');
    expect(classifyTrackingCatchup({ ...base, marketplace: 'manual' }, { nowMs: NOW }).action).toBe('skip');
  });

  it('nimmt den Transporteur aus shippingService, wenn carrier fehlt', () => {
    expect(classifyTrackingCatchup({ ...base, carrier: null, shippingService: 'dp' }, { nowMs: NOW }).carrier).toBe('dp');
  });
});
