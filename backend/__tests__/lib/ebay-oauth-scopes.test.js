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

describe('Support: zusätzliche Nachrichtenfreigabe ohne Verlust bestehender Rechte', () => {
  it('erweitert nur den ausdrücklichen Nachrichten-Consent und erhält bestehende Sonderrechte', async () => {
    integrationDoc = { scopes: ['https://api.ebay.com/oauth/api_scope/sell.analytics.readonly'] };
    const { getEbayConsentScopes } = require('../../lib/ebay-oauth');
    const standard = await getEbayConsentScopes();
    expect(standard).toContain('https://api.ebay.com/oauth/api_scope/sell.analytics.readonly');
    expect(standard).not.toContain('https://api.ebay.com/oauth/api_scope/commerce.message');
    const scopes = await getEbayConsentScopes({ includeMessages: true });
    const url = new URL(await buildConsentUrl({ state: 'test', scopes }));
    expect(url.searchParams.get('scope')).toContain('commerce.message');
    expect(url.searchParams.get('scope')).toContain('sell.analytics.readonly');
  });
  it('bewahrt die beim Consent tatsächlich angefragten Rechte im State und Token', async () => {
    const { createOAuthState, upsertEbayTokenSet } = require('../../lib/ebay-oauth');
    const scopes = ['https://api.ebay.com/oauth/api_scope/commerce.message'];
    patches.length = 0;
    await createOAuthState({ scopes, tenantId: 'default' });
    expect(patches[0]).toMatchObject({ scopes, tenantId: 'default' });
    await upsertEbayTokenSet({ access_token: 'new', refresh_token: 'refresh', expires_in: 7200 }, { scopes });
    expect(patches[1].scopes).toEqual(scopes);
  });
  it('ersetzt die gültige Verbindung nicht durch eine unvollständig gewährte Verbindung', async () => {
    const { upsertEbayTokenSet } = require('../../lib/ebay-oauth');
    patches.length = 0;
    await expect(upsertEbayTokenSet({ access_token: 'new', scope: 'read' }, { scopes: ['read', 'write'] })).rejects.toThrow();
    expect(patches).toHaveLength(0);
  });
});

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
