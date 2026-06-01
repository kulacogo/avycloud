'use strict';

/**
 * Tests for refund-sync: marketplace refund → correction invoice.
 * Verifies matching, the per-refund idempotency, and the no-order path.
 */

require('../api/_patchGcp');

// ── Control variables ──
let ebayRefunds = [];
let kauflandRefunds = [];
let refundCorrExists = false;
let orderExists = true;
const correctionCalls = [];
const corrSetCalls = [];

const fakeDb = {
  collection: (name) => {
    if (name === 'refund_corrections') {
      return { doc: () => ({
        get: async () => ({ exists: refundCorrExists }),
        set: async (d) => { corrSetCalls.push(d); },
      }) };
    }
    if (name === 'orders') {
      return { doc: () => ({ get: async () => ({ exists: orderExists, data: () => ({ tenantId: 'default' }) }) }) };
    }
    if (name === 'invoices') {
      return { where: () => ({ where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }) }) };
    }
    return { doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }) };
  },
};

function FakeFirestore() { return fakeDb; }
function patchCache(name, exportsObj) {
  const key = require.resolve(name);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exportsObj, children: [], paths: [] };
}

patchCache('@google-cloud/firestore', { Firestore: FakeFirestore, FieldValue: {}, Timestamp: {} });
patchCache('../../lib/ebay-finances', { getEbayRefunds: async () => ebayRefunds });
patchCache('../../lib/kaufland-api', { getKauflandRefunds: async () => kauflandRefunds });
patchCache('../../services/invoice-engine', {
  createCorrectionInvoice: async (args) => { correctionCalls.push(args); return { ok: true, correctionId: 'C1' }; },
});

const { syncRefunds } = require('../../services/refund-sync');

beforeEach(() => {
  ebayRefunds = [];
  kauflandRefunds = [];
  refundCorrExists = false;
  orderExists = true;
  correctionCalls.length = 0;
  corrSetCalls.length = 0;
});

describe('refund-sync', () => {
  it('creates a gutschrift correction for a new eBay refund and records it', async () => {
    ebayRefunds = [{ refundId: 'R1', orderId: '20-14584-70491', amount: 10, currency: 'EUR', date: '2026-06-01' }];

    const res = await syncRefunds({ tenantId: 'default', sinceDate: '2026-06-01' });

    expect(correctionCalls.length).toBe(1);
    expect(correctionCalls[0]).toMatchObject({ type: 'gutschrift', refundAmount: 10, orderId: 'ebay__20-14584-70491' });
    expect(res.corrected).toBe(1);
    expect(corrSetCalls.some((c) => c.status === 'corrected')).toBe(true);
  });

  it('is idempotent — a refund already recorded is skipped (no second correction)', async () => {
    ebayRefunds = [{ refundId: 'R1', orderId: '20-14584-70491', amount: 10, currency: 'EUR', date: '2026-06-01' }];
    refundCorrExists = true; // already processed

    const res = await syncRefunds({ tenantId: 'default', sinceDate: '2026-06-01' });

    expect(correctionCalls.length).toBe(0);
    expect(res.corrected).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it('records no_order (and creates no correction) when the order cannot be resolved', async () => {
    ebayRefunds = [{ refundId: 'R2', orderId: 'UNKNOWN', amount: 5, currency: 'EUR', date: '2026-06-01' }];
    orderExists = false; // order doc + invoice lookup both miss

    const res = await syncRefunds({ tenantId: 'default', sinceDate: '2026-06-01' });

    expect(correctionCalls.length).toBe(0);
    expect(res.noOrder).toBe(1);
    expect(corrSetCalls.some((c) => c.status === 'no_order')).toBe(true);
  });
});
