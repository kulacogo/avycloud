// globals: true in vitest.config.js
'use strict';

/**
 * Vorfall 2026-09-25: 13 eBay-Auftraege wurden um 08:25–09:06 Uhr (MESZ)
 * versendet, als das Trading-Tageskontingent leer war (5.000 Aufrufe fuer ALLE
 * Trading-Aufrufe zusammen, Reset 07:00 UTC). CompleteSale wurde vom
 * Kontingent-Schutzschalter lokal abgewiesen ("eBay Trading skipped for
 * CompleteSale: exceeded usage limit"). Bei eBay standen die Auftraege 30 h
 * spaeter noch auf NOT_STARTED.
 *
 * Vertrag:
 *   - Kontingent-Fehler bei CompleteSale → Meldung ueber die Sell-Fulfillment-
 *     REST-API (eigenes Kontingent, 100.000/Tag).
 *   - JEDER andere CompleteSale-Fehler → KEIN Ausweichweg (nichts verschleiern).
 *   - REST ist idempotent: bereits versendet gemeldet → keine zweite Sendung.
 *   - Kontingent-Fehler zaehlen nicht gegen die Versuchs-Obergrenze.
 */

function patch(path, exports) {
  require.cache[require.resolve(path)] = {
    id: require.resolve(path), filename: require.resolve(path), loaded: true, exports, children: [], paths: [],
  };
}

patch('../lib/error-collector', { collectError: () => {} });

let tradingApiImpl;
const tradingCalls = [];
patch('../lib/ebay-trading-api', {
  getEbayTradingConfig: async () => ({ userToken: 'tok', compatibilityLevel: '1.0.0' }),
  buildRequestRoot: (_name, inner) => inner,
  callTradingApi: async (callName, xml) => { tradingCalls.push({ callName, xml }); return tradingApiImpl(callName, xml); },
});
patch('../lib/ebay-oauth', {
  getValidEbayAccessToken: async () => ({ accessToken: 'user-token', apiBaseUrl: 'https://api.ebay.test' }),
});

const {
  pushTrackingToEbay,
  deriveMarketplacePushStatus,
  toEbayRestCarrierCode,
  resolveShippedDate,
  MAX_PUSH_ATTEMPTS,
} = require('../services/marketplace-tracking');

const QUOTA_ERROR = 'eBay Trading skipped for CompleteSale: exceeded usage limit (quota cooldown 42s)';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let fetchCalls;
let ebayOrderState;
let createStatus;
const realFetch = globalThis.fetch;

beforeEach(() => {
  tradingCalls.length = 0;
  fetchCalls = [];
  createStatus = 201;
  ebayOrderState = {
    orderId: '07-15213-96010',
    orderFulfillmentStatus: 'NOT_STARTED',
    cancelStatus: { cancelState: 'NONE_REQUESTED' },
    lineItems: [{ lineItemId: '10089234837207', quantity: 1, lineItemFulfillmentStatus: 'NOT_STARTED' }],
  };
  tradingApiImpl = async () => { throw Object.assign(new Error(QUOTA_ERROR), { quotaCooldown: true }); };
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if ((init.method || 'GET') === 'GET') return jsonResponse(200, ebayOrderState);
    if (createStatus === 201) return jsonResponse(201, {});
    return jsonResponse(createStatus, { errors: [{ errorId: 32100, longMessage: 'kaputt' }] });
  };
  delete process.env.EBAY_TRACKING_REST_FALLBACK;
});

afterAll(() => { globalThis.fetch = realFetch; });

const order = () => ({ marketplaceOrderId: '07-15213-96010', shippedAt: '2026-09-25T06:25:42.957Z' });

describe('eBay-Tracking: REST-Ausweichweg bei leerem Trading-Kontingent', () => {
  it('Kontingent leer → Versand wird ueber die Fulfillment-API gemeldet, mit echtem Versanddatum', async () => {
    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'A0063809DD0000000B64', carrier: 'dp' });

    expect(res).toMatchObject({ ok: true, marketplace: 'ebay', via: 'fulfillment_api' });
    expect(tradingCalls).toHaveLength(1);
    expect(tradingCalls[0].callName).toBe('CompleteSale');

    const post = fetchCalls.find((c) => c.method === 'POST');
    expect(post.url).toBe('https://api.ebay.test/sell/fulfillment/v1/order/07-15213-96010/shipping_fulfillment');
    expect(post.headers.Authorization).toBe('Bearer user-token');
    expect(post.body).toEqual({
      lineItems: [{ lineItemId: '10089234837207', quantity: 1 }],
      shippedDate: '2026-09-25T06:25:42.957Z',
      shippingCarrierCode: 'DeutschePost',
      trackingNumber: 'A0063809DD0000000B64',
    });
  });

  it('ein anderer CompleteSale-Fehler nimmt KEINEN Ausweichweg', async () => {
    tradingApiImpl = async () => ({ ack: 'Failure', errors: [{ longMessage: 'Invalid tracking number' }] });

    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'X', carrier: 'dhl_de' });

    expect(res).toMatchObject({ ok: false, via: 'trading', error: 'Invalid tracking number' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('CompleteSale erfolgreich → REST wird nie angefasst', async () => {
    tradingApiImpl = async () => ({ ack: 'Success', errors: [] });

    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'T1', carrier: 'dhl_de' });

    expect(res).toMatchObject({ ok: true, via: 'trading' });
    expect(fetchCalls).toHaveLength(0);
  });

  it("Notbremse EBAY_TRACKING_REST_FALLBACK='off' → kein Ausweichweg", async () => {
    process.env.EBAY_TRACKING_REST_FALLBACK = 'off';

    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'T1', carrier: 'dhl_de' });

    expect(res.ok).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });

  it('bei eBay schon versendet gemeldet → KEINE zweite Sendung, gilt als Erfolg', async () => {
    ebayOrderState.orderFulfillmentStatus = 'FULFILLED';
    ebayOrderState.lineItems[0].lineItemFulfillmentStatus = 'FULFILLED';

    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'T1', carrier: 'dhl_de' });

    expect(res).toMatchObject({ ok: true, alreadyFulfilled: true, via: 'fulfillment_api' });
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('meldet nur die noch offenen Positionen', async () => {
    ebayOrderState.lineItems = [
      { lineItemId: 'L1', quantity: 2, lineItemFulfillmentStatus: 'FULFILLED' },
      { lineItemId: 'L2', quantity: 1, lineItemFulfillmentStatus: 'NOT_STARTED' },
    ];

    await pushTrackingToEbay({ order: order(), trackingNumber: 'T1', carrier: 'dpd' });

    const post = fetchCalls.find((c) => c.method === 'POST');
    expect(post.body.lineItems).toEqual([{ lineItemId: 'L2', quantity: 1 }]);
    expect(post.body.shippingCarrierCode).toBe('DPD');
  });

  it('bei eBay storniert → dauerhafter Fehler (abandoned), kein Versand gemeldet', async () => {
    ebayOrderState.cancelStatus.cancelState = 'CANCELED';

    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'T1', carrier: 'dhl_de' });

    expect(res.ok).toBe(false);
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(deriveMarketplacePushStatus({ ok: false, error: res.error, prevAttempts: 0 }).status).toBe('abandoned');
  });

  it('unbekannter Transporteur → kein geratener eBay-Code, Versuch bleibt offen (zaehlt nicht)', async () => {
    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'T1', carrier: 'brieftaube' });

    expect(res.ok).toBe(false);
    expect(fetchCalls).toHaveLength(0);
    const derived = deriveMarketplacePushStatus({ ok: false, error: res.error, prevAttempts: 3 });
    expect(derived).toMatchObject({ status: 'failed', attempts: 3, rateLimited: true });
  });

  it('beide Wege scheitern (REST 500) → failed, Kontingent-Signatur bleibt, Obergrenze zaehlt nicht', async () => {
    createStatus = 500;

    const res = await pushTrackingToEbay({ order: order(), trackingNumber: 'T1', carrier: 'dhl_de' });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeded usage limit/);
    expect(res.error).toMatch(/HTTP 500/);
    const derived = deriveMarketplacePushStatus({ ok: false, error: res.error, prevAttempts: MAX_PUSH_ATTEMPTS - 1 });
    expect(derived.status).toBe('failed');
    expect(derived.attempts).toBe(MAX_PUSH_ATTEMPTS - 1);
  });
});

describe('eBay-Code-Zuordnung fuer die Fulfillment-API', () => {
  it('bildet die im Bestand vorkommenden Transporteure auf die eBay-Liste (Site 77) ab', () => {
    expect(toEbayRestCarrierCode('dhl_de')).toBe('DHL');
    expect(toEbayRestCarrierCode('DHL')).toBe('DHL');
    expect(toEbayRestCarrierCode('dp')).toBe('DeutschePost');
    expect(toEbayRestCarrierCode('DP')).toBe('DeutschePost');
    expect(toEbayRestCarrierCode('dpd')).toBe('DPD');
    expect(toEbayRestCarrierCode('dpd:express/delivery=18')).toBe('DPD');
    expect(toEbayRestCarrierCode('dhl_express')).toBe('DHLEXPRESS');
    expect(toEbayRestCarrierCode('')).toBeNull();
    expect(toEbayRestCarrierCode('other')).toBeNull();
  });

  it('Versanddatum: echter Versandzeitpunkt, Zukunft/Unsinn → jetzt', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    expect(resolveShippedDate({ shippedAt: '2026-09-25T06:25:42.957Z' }, now)).toBe('2026-09-25T06:25:42.957Z');
    expect(resolveShippedDate({ shippedAt: '2027-01-01T00:00:00Z' }, now)).toBe('2026-09-26T12:00:00.000Z');
    expect(resolveShippedDate({ shippedAt: 'kaputt' }, now)).toBe('2026-09-26T12:00:00.000Z');
    expect(resolveShippedDate({}, now)).toBe('2026-09-26T12:00:00.000Z');
  });
});
