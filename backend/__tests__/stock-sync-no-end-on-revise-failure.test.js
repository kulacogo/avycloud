// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Incident 2026-06-16 (SKU-9635453280 + 65 more listings in 30d).
//
// A stock-IN (+1 → qty 2) ended the eBay listing. Root cause: when the quantity
// `reviseFixedPriceItem` call failed with a NON-stock error (a Best-Offer
// pricing-config error, a transient "operation aborted", an image error, ...),
// the dispatcher fell through to a blanket fail-safe `endFixedPriceItem` and
// logged it as SUCCESS — silently killing a healthy listing and never queueing
// a repair. In 30d this killed 66 healthy listings; 0 were genuine stock-outs.
//
// Correct behavior: a revise failure at stock > 0 means the listing is UNCHANGED
// on eBay — it does NOT prove the stock is gone. NEVER end the listing; record a
// retryable failure so the durable drain (stock-failure-drain.js) retries and
// reconciliation reconciles. This is the oversell architecture in decisions.md.

let reviseImpl = async () => ({ ack: 'Success' });
const reviseCalls = [];
const endCalls = [];

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'products_v2') {
      return {
        doc: vi.fn(() => ({
          get: async () => ({ exists: false }),
          set: async () => {},
          update: async () => {},
        })),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => ({ empty: true, docs: [] }),
      };
    }
    if (name === 'stock_sync_log') {
      return { add: vi.fn(async () => {}) };
    }
    if (name === 'ebayListingsLive') {
      const chain = {
        where: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        get: async () => ({ empty: true, docs: [] }),
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

require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: mockFirestore },
  children: [],
  paths: [],
};

require.cache[require.resolve('../lib/stock-lock')] = {
  id: require.resolve('../lib/stock-lock'),
  filename: require.resolve('../lib/stock-lock'),
  loaded: true,
  exports: { withStockLock: async (_key, fn) => fn() },
  children: [],
  paths: [],
};

// No reservations → availableQuantity === physical quantity (stock > 0 path).
require.cache[require.resolve('../services/stock-reservation')] = {
  id: require.resolve('../services/stock-reservation'),
  filename: require.resolve('../services/stock-reservation'),
  loaded: true,
  exports: { getReservedQuantity: async () => 0 },
  children: [],
  paths: [],
};

require.cache[require.resolve('../lib/ebay-trading-api')] = {
  id: require.resolve('../lib/ebay-trading-api'),
  filename: require.resolve('../lib/ebay-trading-api'),
  loaded: true,
  exports: {
    reviseFixedPriceItem: async (payload) => {
      reviseCalls.push(payload);
      return reviseImpl(payload);
    },
    endFixedPriceItem: async (...args) => {
      endCalls.push(args);
      return { ack: 'Success' };
    },
  },
  children: [],
  paths: [],
};

const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');

function productWithStock() {
  return {
    id: 'prod-incident-1',
    tenantId: 'default',
    identification: { sku: 'SKU-9635453280' },
    inventory: { quantity: 2 }, // stock just went UP to 2 — listing must stay alive
    ops: { ebay: { itemId: '389922954728' } },
  };
}

describe('stock-sync: revise failure must NOT end a healthy listing', () => {
  beforeEach(() => {
    reviseCalls.length = 0;
    endCalls.length = 0;
    reviseImpl = async () => ({ ack: 'Success' });
  });

  it('does NOT end the listing when revise fails with a Best-Offer pricing-config error (the incident)', async () => {
    reviseImpl = async () => {
      throw new Error('Der Betrag für die automatische Ablehnung darf nicht größer oder gleich dem Betrag des Sofort-Kaufen-Preises sein.');
    };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: productWithStock(), reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    // The listing must remain ACTIVE — no end call.
    expect(endCalls.length).toBe(0);
    // The failure must be recorded as a retryable failure (→ drain), not a fake success.
    expect(ebay.status).toBe('failed');
    expect(ebay.retryable).toBe(true);
    expect(ebay.action).not.toBe('fail_safe_end');
  });

  it('does NOT end the listing on a transient eBay error ("This operation was aborted")', async () => {
    reviseImpl = async () => { throw new Error('This operation was aborted'); };

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: productWithStock(), reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(endCalls.length).toBe(0);
    expect(ebay.status).toBe('failed');
    expect(ebay.retryable).toBe(true);
  });

  it('still revises normally (no end) when stock > 0 and revise succeeds', async () => {
    reviseImpl = async () => ({ ack: 'Success' });

    const { results } = await syncStockToAllChannels({ tenantId: 'default', product: productWithStock(), reason: 'stock-in' });
    const ebay = results.find((r) => r.channel === 'ebay');

    expect(reviseCalls.length).toBe(1);
    expect(reviseCalls[0].quantity).toBe(2);
    expect(endCalls.length).toBe(0);
    expect(ebay.status).toBe('success');
  });
});
