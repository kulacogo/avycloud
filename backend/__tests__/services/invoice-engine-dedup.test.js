'use strict';

/**
 * Regression tests for the duplicate-invoice bug.
 *
 * Two distinct defects produced doubled SevDesk invoices (one paid + one draft,
 * same number) and non-sequential numbers (RE-2026-0059):
 *
 *  1. exportToSevDesk ran after generateInvoice and POSTed a fresh saveInvoice
 *     (id:null, status 100), creating a SECOND SevDesk invoice as a permanent
 *     draft — and it even passed our local fallback number to SevDesk.
 *  2. generateInvoice had a TOCTOU race: the idempotency marker (invoiceId) was
 *     only written at the very end, so two concurrent triggers both created one.
 *
 * These tests pin the fixes: exportToSevDesk is now idempotent on sevdeskId,
 * finalizes via sendBy, and never pushes a client invoiceNumber; generateInvoice
 * claims the order atomically.
 */

// ── Patch GCP packages BEFORE requiring the service under test ──
require('../api/_patchGcp'); // storage + (generic) firestore

// ── Controllable Firestore: one shared ref for invoice + order ──
let currentInvoice = null; // what invoices/{id}.get() returns
let orderTxData = {};       // what the claim transaction sees for the order
const setCalls = [];        // records ref.set(...) payloads

const sharedRef = {
  get: async () => ({ exists: currentInvoice != null, data: () => currentInvoice, ref: sharedRef }),
  set: async (d) => { setCalls.push(d); if (currentInvoice) Object.assign(currentInvoice, d); },
};
const fakeDb = {
  collection: () => ({ doc: () => sharedRef }),
  runTransaction: async (fn) => fn({
    get: async () => ({ exists: true, data: () => orderTxData }),
    set() {},
    update() {},
  }),
};

function FakeFirestore() { return fakeDb; }
FakeFirestore.FieldValue = { serverTimestamp: () => null, increment: (n) => n, delete: () => null };
FakeFirestore.Timestamp = { now: () => ({}), fromDate: () => ({}) };

function patchCache(moduleName, exportsObj) {
  const key = require.resolve(moduleName);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exportsObj, children: [], paths: [] };
}

// Override the generic firestore mock from _patchGcp with our controllable one
patchCache('@google-cloud/firestore', {
  Firestore: FakeFirestore,
  FieldValue: FakeFirestore.FieldValue,
  Timestamp: FakeFirestore.Timestamp,
});
// SevDesk token always present
patchCache('../../lib/secret-values', { getSecretValue: async () => 'TEST-SEVDESK-TOKEN' });

// ── SevDesk HTTP mock ──
let fetchCalls = [];
global.fetch = vi.fn(async (url, opts = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, method: opts.method, body: opts.body });
  if (u.includes('/Invoice/Factory/saveInvoice')) {
    return { ok: true, json: async () => ({ objects: { invoice: { id: 'SD-NEW-123' } } }) };
  }
  if (u.includes('/sendBy')) {
    return { ok: true, json: async () => ({ objects: { invoiceNumber: 'RE-9001' } }) };
  }
  // getSevdeskUserId (/SevUser) and any other GET
  return { ok: true, json: async () => ({ objects: [{ id: 'USER-1' }] }), text: async () => '' };
});

// Require AFTER patches so getDb()/Firestore bind to our mock
const engine = require('../../services/invoice-engine');

beforeEach(() => {
  fetchCalls = [];
  setCalls.length = 0;
  currentInvoice = null;
  orderTxData = {};
});

describe('exportToSevDesk — idempotency (no duplicate drafts)', () => {
  // Der SevDesk-Weg ist seit 2026-08-17 standardmaessig AUS ("rechnung nur in
  // avycloud nicht in sevdesk", lib/auto-invoice-gate.js). Diese Tests
  // beschreiben genau diesen Weg — sie muessen ihn also einschalten.
  const altPush = process.env.INVOICE_SEVDESK_PUSH;
  beforeEach(() => { process.env.INVOICE_SEVDESK_PUSH = 'on'; });
  afterEach(() => {
    if (altPush === undefined) delete process.env.INVOICE_SEVDESK_PUSH;
    else process.env.INVOICE_SEVDESK_PUSH = altPush;
  });

  it('skips entirely when the invoice already has a sevdeskId', async () => {
    currentInvoice = { sevdeskId: 'SD-EXISTING', invoiceNumber: 'RE-2044', orderId: null, customer: { name: 'X' } };

    const res = await engine.exportToSevDesk({ invoiceId: 'inv-1' });

    expect(res).toEqual({ ok: true, sevdeskId: 'SD-EXISTING', skipped: true });
    // The whole bug: a second saveInvoice must NOT be sent.
    expect(fetchCalls.filter((c) => c.url.includes('saveInvoice')).length).toBe(0);
  });

  it('creates + finalizes when no sevdeskId, and never pushes the local fallback number', async () => {
    currentInvoice = {
      sevdeskId: null,
      invoiceNumber: 'RE-2026-0099', // local fallback format — must not reach SevDesk
      orderId: null,
      customer: { name: 'Y' },
      date: '2026-05-01',
      dueDate: '2026-05-15',
      amountNetto: 10,
      vatRate: 0.19,
    };

    const res = await engine.exportToSevDesk({ invoiceId: 'inv-2' });

    const saveCall = fetchCalls.find((c) => c.url.includes('saveInvoice'));
    expect(saveCall).toBeTruthy();
    // Local fallback number must NOT be sent to SevDesk (SevDesk assigns it).
    expect(saveCall.body).not.toContain('RE-2026-0099');
    // Draft is finalized.
    expect(fetchCalls.some((c) => c.url.includes('/sendBy'))).toBe(true);
    // Doc updated with SevDesk id + official sequential number.
    expect(res.sevdeskId).toBe('SD-NEW-123');
    expect(res.invoiceNumber).toBe('RE-9001');
    const lastSet = setCalls[setCalls.length - 1];
    expect(lastSet.sevdeskId).toBe('SD-NEW-123');
    expect(lastSet.invoiceNumber).toBe('RE-9001');
  });
});

describe('generateInvoice — atomic claim (no concurrent double-create)', () => {
  it('returns the existing invoice without re-creating it', async () => {
    currentInvoice = {}; // order exists
    orderTxData = { invoiceId: 'INV-EXIST', invoiceNumber: 'RE-1', pdfUrl: 'gs://x/RE-1.pdf' };

    const res = await engine.generateInvoice({ orderId: 'o-1', tenantId: 'default' });

    expect(res).toEqual({ invoiceId: 'INV-EXIST', invoiceNumber: 'RE-1', pdfUrl: 'gs://x/RE-1.pdf' });
    expect(fetchCalls.some((c) => c.url.includes('saveInvoice'))).toBe(false);
  });

  it('skips when another generation claim is still active', async () => {
    currentInvoice = {}; // order exists
    orderTxData = { invoiceClaimedAt: new Date().toISOString() }; // fresh claim by a concurrent run

    const res = await engine.generateInvoice({ orderId: 'o-2', tenantId: 'default' });

    expect(res.skipped).toBe(true);
    expect(res.invoiceId).toBeNull();
    expect(fetchCalls.some((c) => c.url.includes('saveInvoice'))).toBe(false);
  });
});

describe('generateInvoice — no 0 € / customer-less invoices (eBay-Käufer fix)', () => {
  it('skips an order with zero amount', async () => {
    currentInvoice = { items: [], totalAmount: 0, customer: { name: 'Kunde' } };
    orderTxData = {}; // claim succeeds

    const res = await engine.generateInvoice({ orderId: 'o-3', tenantId: 'default' });

    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no_amount_or_customer');
    expect(fetchCalls.some((c) => c.url.includes('saveInvoice'))).toBe(false);
  });

  it('skips an order without customer name (anonymized eBay buyer)', async () => {
    currentInvoice = { items: [{ priceBrutto: 50, quantity: 1 }], customer: null };
    orderTxData = {};

    const res = await engine.generateInvoice({ orderId: 'o-4', tenantId: 'default' });

    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no_amount_or_customer');
    expect(fetchCalls.some((c) => c.url.includes('saveInvoice'))).toBe(false);
  });
});
