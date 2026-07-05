'use strict';

/**
 * Regression (2026-07-05): Der Kaufland-Verbindungstest im IntegrationWizard
 * schlug IMMER fehl (HTTP 401/404), auch mit korrekten Schlüsseln:
 * integration-store.testConnection baute die URL selbst — Basis
 * `…/v2` + Pfad `/v2/info/locale` = `…/v2/v2/info/locale` (doppeltes /v2) —
 * statt die funktionierende Request-Maschinerie aus lib/kaufland-api.js
 * wiederzuverwenden. Damit war das Speichern neuer Kaufland-Zugangsdaten
 * (Konto-Wechsel!) komplett blockiert.
 *
 * Neu: lib/kaufland-api.js exportiert pingKaufland(credentials) — gleiche
 * URL-/Signatur-/Header-Logik wie kauflandRequest, aber mit explizit
 * übergebenen Schlüsseln. testConnection('kaufland') nutzt sie.
 */

// node-fetch + global fetch stubben BEVOR Module laden.
const fetchCalls = [];
let fetchResponse = { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }) };
const fetchStub = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  return fetchResponse;
};
global.fetch = fetchStub;
const nodeFetchPath = require.resolve('node-fetch');
require.cache[nodeFetchPath] = {
  id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fetchStub, children: [], paths: [],
};

const { pingKaufland } = require('../../lib/kaufland-api');

describe('pingKaufland — Verbindungstest mit expliziten Schlüsseln', () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    fetchResponse = { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }) };
  });

  it('ruft die KORREKTE URL auf (kein doppeltes /v2) mit Kaufland-Signatur-Headern', async () => {
    const result = await pingKaufland({ clientKey: 'ck-123456789012', secretKey: 'sk-123456789012' });

    expect(result.ok).toBe(true);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe('https://sellerapi.kaufland.com/v2/warehouses');
    expect(fetchCalls[0].url).not.toContain('/v2/v2');
    const headers = fetchCalls[0].opts.headers;
    expect(headers['Shop-Client-Key']).toBe('ck-123456789012');
    expect(headers['Shop-Timestamp']).toMatch(/^\d+$/);
    expect(headers['Shop-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('meldet ungültige Schlüssel verständlich (401)', async () => {
    fetchResponse = { ok: false, status: 401, text: async () => JSON.stringify({ message: 'Unauthorized' }) };
    const result = await pingKaufland({ clientKey: 'wrong', secretKey: 'wrong' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ungültig|401/i);
  });

  it('meldet fehlende Schlüssel ohne API-Call', async () => {
    const result = await pingKaufland({ clientKey: '', secretKey: '' });
    expect(result.ok).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });
});
