'use strict';

/**
 * Fix 2 (2026-07-05): eBay-OAuth-Scopes.
 *
 * (a) Der Default-Scope-Satz muss das SCHREIBRECHT sell.inventory enthalten —
 *     ohne dieses darf ein OAuth-Token zwar Angebote lesen, aber der
 *     Stock-Sync (ReviseFixedPriceItem etc.) schlägt fehl. Wichtig, damit
 *     "Mit eBay verbinden" eine voll funktionsfähige Verbindung ergibt.
 *
 * (b) Der Token-REFRESH darf NICHT die konfigurierten (ggf. inzwischen
 *     breiteren) Scopes anfragen, sondern nur die beim Verbinden GEWÄHRTEN —
 *     sonst bricht jede bestehende Verbindung in dem Moment, in dem die
 *     Scope-Liste erweitert wird (eBay: refresh scope must be <= original).
 */

// OAuth-Konfig komplett über ENV, kein Secret-Manager-Zugriff.
process.env.EBAY_CLIENT_ID = 'test-client';
process.env.EBAY_CLIENT_SECRET = 'test-secret';
process.env.EBAY_RU_NAME = 'Test-RuName';
delete process.env.EBAY_SCOPES;

// lib/firestore vor-patchen (ebay-oauth lädt es beim Require).
const firestorePath = require.resolve('../../lib/firestore');
let integrationDoc = null;
const patches = [];
const fakeFirestore = {
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: Boolean(integrationDoc), data: () => integrationDoc }),
      set: async (patch) => { patches.push(patch); },
      delete: async () => {},
    }),
  }),
};
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: { firestore: fakeFirestore },
};

// fetch stubben BEVOR ebay-oauth lädt (fetchImpl wird beim Laden gebunden).
const capturedTokenCalls = [];
global.fetch = async (url, init) => {
  capturedTokenCalls.push({ url: String(url), body: String(init?.body || '') });
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ access_token: 'NEW-ACCESS', expires_in: 7200, token_type: 'User Access Token' }),
  };
};

const { buildConsentUrl, getValidEbayAccessToken } = require('../../lib/ebay-oauth');

describe('eBay OAuth Scopes — Verbinden-Flow fragt Schreibrecht an', () => {
  it('Default-Consent-URL enthält sell.inventory (write) UND die bisherigen Scopes', async () => {
    const url = new URL(await buildConsentUrl({ state: 's1' }));
    const scope = url.searchParams.get('scope') || '';
    expect(scope).toContain('https://api.ebay.com/oauth/api_scope/sell.inventory ');
    expect(scope).toContain('sell.inventory.readonly');
    expect(scope).toContain('sell.fulfillment');
    expect(scope).toContain('sell.finances');
    expect(scope).toContain('sell.account.readonly');
  });
});

describe('eBay OAuth Refresh — nutzt gewährte Scopes, nicht die Konfiguration', () => {
  it('refresht mit exakt den beim Verbinden gespeicherten Scopes', async () => {
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    const futureIso = new Date(Date.now() + 300 * 24 * 3600 * 1000).toISOString();
    integrationDoc = {
      accessToken: 'OLD-ACCESS',
      accessTokenExpiresAt: pastIso, // abgelaufen → Refresh nötig
      refreshToken: 'REFRESH-1',
      refreshTokenExpiresAt: futureIso,
      scopes: ['https://api.ebay.com/oauth/api_scope/sell.finances'], // enger als der neue Default
    };
    capturedTokenCalls.length = 0;

    const { accessToken } = await getValidEbayAccessToken();

    expect(accessToken).toBe('NEW-ACCESS');
    expect(capturedTokenCalls.length).toBe(1);
    const body = new URLSearchParams(capturedTokenCalls[0].body);
    expect(body.get('grant_type')).toBe('refresh_token');
    // Gewährte Scopes — NICHT der (breitere) Default mit sell.inventory:
    expect(body.get('scope')).toBe('https://api.ebay.com/oauth/api_scope/sell.finances');
  });

  it('lässt den scope-Parameter weg, wenn keine gewährten Scopes gespeichert sind', async () => {
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    integrationDoc = {
      accessToken: 'OLD-ACCESS',
      accessTokenExpiresAt: pastIso,
      refreshToken: 'REFRESH-2',
      refreshTokenExpiresAt: null,
      scopes: [],
    };
    capturedTokenCalls.length = 0;

    await getValidEbayAccessToken();

    const body = new URLSearchParams(capturedTokenCalls[0].body);
    expect(body.get('scope')).toBeNull();
  });
});
