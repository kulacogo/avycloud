'use strict';

/**
 * Tests for refund-sync: marketplace refund → BELL NOTIFICATION (no auto-book).
 * Verifies the buyer-refund amount derivation (invoice gross − eBay order total),
 * per-refund idempotency, the no-invoice fallback, and the Kaufland path.
 */

require('../api/_patchGcp');

// ── Control variables ──
let ebayRefunds = [];
let kauflandRefunds = [];
let refundCorrExists = false;
let invoiceDoc = null; // { invoiceNumber, amountBrutto }
const alertAddCalls = [];
const corrSetCalls = [];

const fakeDb = {
  collection: (name) => {
    if (name === 'refund_corrections') {
      return { doc: () => ({
        get: async () => ({ exists: refundCorrExists }),
        set: async (d) => { corrSetCalls.push(d); },
      }) };
    }
    if (name === 'invoices') {
      return { where: () => ({ where: () => ({ limit: () => ({
        get: async () => invoiceDoc
          ? ({ empty: false, docs: [{ data: () => invoiceDoc }] })
          : ({ empty: true, docs: [] }),
      }) }) }) };
    }
    if (name === 'stock_failure_alerts') {
      return { add: async (d) => { alertAddCalls.push(d); } };
    }
    return { doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }), add: async () => {} };
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

const { syncRefunds } = require('../../services/refund-sync');

beforeEach(() => {
  ebayRefunds = [];
  kauflandRefunds = [];
  refundCorrExists = false;
  invoiceDoc = null;
  alertAddCalls.length = 0;
  corrSetCalls.length = 0;
});

describe('refund-sync', () => {
  it('raises a bell alert with the buyer-refund amount (invoice − eBay total) for a new eBay refund', async () => {
    ebayRefunds = [{ refundId: 'R1', orderId: '20-14584-70491', ebayOrderTotal: 109.20, sellerNetRefund: 7.86, currency: 'EUR', date: '2026-06-01' }];
    invoiceDoc = { invoiceNumber: 'RE-1927', amountBrutto: 119.20 };

    const res = await syncRefunds({ tenantId: 'default', sinceDate: '2026-06-01' });

    expect(res.notified).toBe(1);
    expect(alertAddCalls.length).toBe(1);
    // 119.20 − 109.20 = 10.00 (NOT the 7.86 seller-net figure)
    expect(alertAddCalls[0]).toMatchObject({
      kind: 'refund_review',
      terminalStatus: 'needs_manual',
      marketplace: 'ebay',
      invoiceNumber: 'RE-1927',
      amount: 10,
      amountBasis: 'invoice_minus_ebay_total',
    });
    expect(corrSetCalls.some((c) => c.status === 'notified')).toBe(true);
  });

  it('is idempotent — an already-recorded refund is skipped (no second alert)', async () => {
    ebayRefunds = [{ refundId: 'R1', orderId: '20-14584-70491', ebayOrderTotal: 109.20, currency: 'EUR', date: '2026-06-01' }];
    refundCorrExists = true;

    const res = await syncRefunds({ tenantId: 'default', sinceDate: '2026-06-01' });

    expect(alertAddCalls.length).toBe(0);
    expect(res.notified).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it('still alerts when no invoice is found (flagged, seller-net fallback)', async () => {
    ebayRefunds = [{ refundId: 'R2', orderId: 'UNKNOWN', ebayOrderTotal: 0, sellerNetRefund: 5, currency: 'EUR', date: '2026-06-01' }];
    invoiceDoc = null;

    const res = await syncRefunds({ tenantId: 'default', sinceDate: '2026-06-01' });

    expect(res.notified).toBe(1);
    expect(res.noInvoice).toBe(1);
    expect(alertAddCalls[0]).toMatchObject({ amountBasis: 'seller_net_fallback', amount: 5 });
    expect(corrSetCalls.some((c) => c.status === 'notified_no_invoice')).toBe(true);
  });

  it('uses the Kaufland booking amount directly (buyer gross)', async () => {
    kauflandRefunds = [{ refundId: 'kaufland:MX1:5.00:2026-06-01', orderId: 'MX1', amount: 5, currency: 'EUR', date: '2026-06-01' }];
    invoiceDoc = { invoiceNumber: 'RE-1500', amountBrutto: 50 };

    const res = await syncRefunds({ tenantId: 'default', sinceDate: '2026-06-01' });

    expect(res.notified).toBe(1);
    expect(alertAddCalls[0]).toMatchObject({ marketplace: 'kaufland', amount: 5, amountBasis: 'kaufland_booking' });
  });
});
