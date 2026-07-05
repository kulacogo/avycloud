'use strict';

/**
 * Regression: Trading-API-Calls mit VORGEBAUTEM XML (buildRequestRoot beim
 * Caller) nutzten immer den statischen Secret-Manager-Token — der frische
 * OAuth-Token aus dem "Mit eBay verbinden"-Flow wurde nur für Fragment-Caller
 * injiziert (callTradingApi Zeile ~617 übersprang das Wrapping bei `<?xml`).
 *
 * Folge in Production (2026-06-30): Der statische Token starb, der komplette
 * Listing-Sync (GetMyeBaySelling & Co. — alles Prebuilt-Caller) fiel aus,
 * obwohl ein Klick auf "Neu verbinden" ihn hätte heilen können.
 *
 * Fix: callTradingApi ersetzt in vorgebautem XML den <eBayAuthToken> durch den
 * jeweils gültigen Token (OAuth bevorzugt, statisch als Fallback).
 */

// Trading-Konfig komplett über ENV, damit kein Secret-Manager-Call passiert.
process.env.EBAY_TRADING_APP_ID = 'test-app-id';
process.env.EBAY_TRADING_DEV_ID = 'test-dev-id';
process.env.EBAY_TRADING_CERT_ID = 'test-cert-id';
process.env.EBAY_TRADING_USER_TOKEN = 'STATIC-SECRET-TOKEN';

// ebay-oauth im require.cache vor-patchen, bevor irgendetwas es laden kann —
// das Modul zieht sonst lib/firestore (GCP) hoch. Implementierung pro Test
// über den mutablen Holder unten austauschbar.
let oauthImpl = async () => ({ accessToken: 'OAUTH-FRESH-TOKEN' });
const oauthPath = require.resolve('../../lib/ebay-oauth');
require.cache[oauthPath] = {
  id: oauthPath,
  filename: oauthPath,
  loaded: true,
  exports: { getValidEbayAccessToken: (...args) => oauthImpl(...args) },
};

// fetch stubben BEVOR ebay-trading-api lädt (fetchImpl wird beim Laden gebunden).
const capturedRequests = [];
const SUCCESS_XML =
  '<?xml version="1.0" encoding="UTF-8"?><GeteBayOfficialTimeResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Timestamp>2026-07-05T00:00:00.000Z</Timestamp></GeteBayOfficialTimeResponse>';
global.fetch = async (url, init) => {
  capturedRequests.push({ url, body: init?.body || '' });
  return { ok: true, status: 200, text: async () => SUCCESS_XML };
};

const {
  callTradingApi,
  buildRequestRoot,
  replaceRequesterToken,
} = require('../../lib/ebay-trading-api');

describe('replaceRequesterToken — Token-Austausch in vorgebautem Trading-XML', () => {
  it('ersetzt den eingebauten Token durch den übergebenen', () => {
    const xml = buildRequestRoot('GeteBayOfficialTime', '<Foo>1</Foo>', 'OLD-TOKEN', '1209');
    const out = replaceRequesterToken(xml, 'NEW-TOKEN');
    expect(out).toContain('<eBayAuthToken>NEW-TOKEN</eBayAuthToken>');
    expect(out).not.toContain('OLD-TOKEN');
  });

  it('escaped XML-Sonderzeichen im Token', () => {
    const xml = buildRequestRoot('GeteBayOfficialTime', '<Foo>1</Foo>', 'OLD', '1209');
    const out = replaceRequesterToken(xml, 'v^1.1#a<b&c');
    expect(out).toContain('<eBayAuthToken>v^1.1#a&lt;b&amp;c</eBayAuthToken>');
  });

  it('lässt XML ohne Token-Tag und leere Tokens unverändert', () => {
    expect(replaceRequesterToken('<Foo>1</Foo>', 'TOKEN')).toBe('<Foo>1</Foo>');
    const xml = buildRequestRoot('GeteBayOfficialTime', '<Foo>1</Foo>', 'OLD', '1209');
    expect(replaceRequesterToken(xml, '')).toBe(xml);
    expect(replaceRequesterToken(xml, null)).toBe(xml);
  });

  it('ist robust gegen $-Muster im Token (kein Regex-Replacement-Unfall)', () => {
    const xml = buildRequestRoot('GeteBayOfficialTime', '<Foo>1</Foo>', 'OLD', '1209');
    const out = replaceRequesterToken(xml, 'a$&b$1c');
    expect(out).toContain('<eBayAuthToken>a$&amp;b$1c</eBayAuthToken>');
  });
});

describe('callTradingApi — OAuth-Token gewinnt auch bei vorgebautem XML', () => {
  beforeEach(() => {
    capturedRequests.length = 0;
  });

  it('sendet den frischen OAuth-Token statt des eingebauten statischen Tokens', async () => {
    oauthImpl = async () => ({ accessToken: 'OAUTH-FRESH-TOKEN' });
    const prebuilt = buildRequestRoot('GeteBayOfficialTime', '<Foo>1</Foo>', 'STATIC-SECRET-TOKEN', '1209');

    const result = await callTradingApi('GeteBayOfficialTime', prebuilt);

    expect(result.ack).toBe('Success');
    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0].body).toContain('<eBayAuthToken>OAUTH-FRESH-TOKEN</eBayAuthToken>');
    expect(capturedRequests[0].body).not.toContain('STATIC-SECRET-TOKEN');
  });

  it('fällt auf den statischen Token zurück, wenn kein OAuth-Token verfügbar ist', async () => {
    oauthImpl = async () => {
      const err = new Error('eBay is not connected.');
      err.code = 'EBAY_NOT_CONNECTED';
      throw err;
    };
    const prebuilt = buildRequestRoot('GeteBayOfficialTime', '<Foo>1</Foo>', 'STATIC-SECRET-TOKEN', '1209');

    const result = await callTradingApi('GeteBayOfficialTime', prebuilt);

    expect(result.ack).toBe('Success');
    expect(capturedRequests[0].body).toContain('<eBayAuthToken>STATIC-SECRET-TOKEN</eBayAuthToken>');
  });
});
