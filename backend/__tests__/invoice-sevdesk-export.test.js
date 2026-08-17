// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARDS — SevDesk-Export (2 Bugs, gefunden 2026-07-06):
//
// 1. exportToSevDesk baute die Positionen NUR aus order.items — die
//    Versandkosten-Position fehlte. Die finalisierte SevDesk-Rechnung lag um
//    die vollen Versandkosten unter dem tatsächlich gezahlten Betrag
//    (generateInvoice hat die Position, der Schwester-Pfad nicht).
//
// 2. Netto-Stückpreis auf 2 Stellen gerundet → SevDesk-Summe weicht vom
//    Brutto-Zahlbetrag ab (4,99 € ×3: 4,19 × 3 × 1,19 = 14,96 statt 14,97).
//    Seit Fix: volle Präzision (6 Nachkommastellen), SevDesk rundet die SUMME.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

// Firestore-Konstruktor mocken BEVOR invoice-engine geladen wird.
const docs = {}; // `${collection}/${id}` → data
function MockFirestore() {
  return {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => ({
          exists: docs[`${name}/${id}`] !== undefined,
          data: () => docs[`${name}/${id}`],
          ref: { set: async () => {}, update: async () => {} },
        }),
        set: async () => {},
        update: async () => {},
      }),
    }),
  };
}
patchCjsModule('@google-cloud/firestore', { Firestore: MockFirestore, FieldValue: {} });
patchCjsModule('@google-cloud/storage', { Storage: function () { return {}; } });
patchCjsModule('../services/integration-store', {
  getIntegrationSecret: vi.fn(async () => 'sevdesk-token'),
});

const fetchCalls = [];
globalThis.fetch = vi.fn(async (url) => {
  fetchCalls.push({ url, body: fetch.mock.calls[fetchCalls.length]?.[1]?.body });
  if (String(url).includes('SevUser')) {
    return { ok: true, json: async () => ({ objects: [{ id: 'user-1' }] }) };
  }
  return { ok: true, json: async () => ({ objects: { invoice: { id: 'sd-1' } } }) };
});

const { exportToSevDesk, toSevdeskNetUnitPrice } = require('../services/invoice-engine');

describe('toSevdeskNetUnitPrice', () => {
  it('behält volle Präzision statt auf 2 Stellen zu runden', () => {
    // 4,99 brutto / 1,19 = 4,193277... — mit 2-Stellen-Rundung (4,19) ergäbe
    // 3 × 4,19 × 1,19 = 14,96 statt der gezahlten 14,97.
    const price = toSevdeskNetUnitPrice(4.99, 1.19);
    expect(price).toBeCloseTo(4.193277, 5);
    const sevdeskSum = Math.round(price * 3 * 1.19 * 100) / 100;
    expect(sevdeskSum).toBe(14.97);
  });

  it('null/undefined → 0', () => {
    expect(toSevdeskNetUnitPrice(undefined, 1.19)).toBe(0);
    expect(toSevdeskNetUnitPrice(null, 1.19)).toBe(0);
  });
});

describe('exportToSevDesk: Versandkosten-Position', () => {
  // Der SevDesk-Weg ist seit 2026-08-17 standardmaessig AUS ("rechnung nur in
  // avycloud nicht in sevdesk", lib/auto-invoice-gate.js). Diese Tests
  // beschreiben genau diesen Weg — sie muessen ihn also einschalten.
  const altPush = process.env.INVOICE_SEVDESK_PUSH;
  beforeEach(() => {
    process.env.INVOICE_SEVDESK_PUSH = 'on';
    for (const k of Object.keys(docs)) delete docs[k];
    globalThis.fetch.mockClear();
  });
  afterEach(() => {
    if (altPush === undefined) delete process.env.INVOICE_SEVDESK_PUSH;
    else process.env.INVOICE_SEVDESK_PUSH = altPush;
  });

  function lastSaveInvoicePayload() {
    const call = globalThis.fetch.mock.calls.find(([url]) => String(url).includes('saveInvoice'));
    return JSON.parse(call[1].body);
  }

  it('hängt die Versandkosten als eigene Position an', async () => {
    docs['invoices/inv-1'] = {
      orderId: 'order-1', vatRate: 0.19, customer: { name: 'Max' }, date: '2026-07-01',
    };
    docs['orders/order-1'] = {
      items: [{ name: 'Artikel A', sku: 'SKU-A', quantity: 1, priceBrutto: 20.0 }],
      shippingCost: 4.99,
    };

    const result = await exportToSevDesk({ invoiceId: 'inv-1' });
    expect(result.ok).toBe(true);

    const payload = lastSaveInvoicePayload();
    const positions = payload.invoicePosSave;
    expect(positions.length).toBe(2);
    const shipping = positions.find((p) => p.name === 'Versandkosten');
    expect(shipping).toBeTruthy();
    expect(shipping.quantity).toBe(1);
    expect(shipping.price).toBeCloseTo(4.99 / 1.19, 5);
    // Gesamtsumme (SevDesk-Arithmetik nachgerechnet) = gezahlter Betrag:
    const total = positions.reduce((s, p) => s + p.price * p.quantity * 1.19, 0);
    expect(Math.round(total * 100) / 100).toBe(24.99);
  });

  it('keine Versandposition wenn shippingCost 0', async () => {
    docs['invoices/inv-2'] = {
      orderId: 'order-2', vatRate: 0.19, customer: { name: 'Max' }, date: '2026-07-01',
    };
    docs['orders/order-2'] = {
      items: [{ name: 'Artikel A', quantity: 1, priceBrutto: 20.0 }],
      shippingCost: 0,
    };

    await exportToSevDesk({ invoiceId: 'inv-2' });
    const positions = lastSaveInvoicePayload().invoicePosSave;
    expect(positions.length).toBe(1);
  });

  it('bereits exportierte Rechnung (sevdeskId) bleibt unangetastet', async () => {
    docs['invoices/inv-3'] = { sevdeskId: 'sd-existing' };
    const result = await exportToSevDesk({ invoiceId: 'inv-3' });
    expect(result.skipped).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
