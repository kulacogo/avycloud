// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — SevDesk CheckAccountTransaction MUSS paginieren.
//
// Vorher: ein einzelner Request mit limit=500 für das GESAMTE Zeitfenster.
// Payee-Filterung passiert erst client-seitig → bei Jahres-Presets mit
// > 500 Bank-Buchungen wurden Auszahlungen/Versandkosten still unterschlagen
// und als 'source: sevdesk' (= exakt) ausgewiesen.

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}

patchCjsModule('../services/integration-store', {
  getIntegrationSecret: vi.fn(async () => 'sevdesk-token'),
});

// fetch: liefert Seiten à 500, gesteuert über `pages`
let pages = [];
const defaultFetchImpl = async (url) => {
  const u = new URL(String(url));
  const offset = parseInt(u.searchParams.get('offset') || '0', 10);
  const limit = parseInt(u.searchParams.get('limit') || '500', 10);
  const pageIndex = Math.floor(offset / limit);
  return {
    ok: true,
    json: async () => ({ objects: pages[pageIndex] || [] }),
  };
};
globalThis.fetch = vi.fn(defaultFetchImpl);

const { fetchAllCheckAccountTransactions, getMarketplacePayoutsFromSevDesk } = require('../lib/sevdesk');

function makeTx(payee, amount) {
  return { payeePayerName: payee, amount: String(amount), valueDate: '2026-01-15' };
}

beforeEach(() => {
  pages = [];
  globalThis.fetch.mockClear();
  globalThis.fetch.mockImplementation(defaultFetchImpl);
});

describe('fetchAllCheckAccountTransactions', () => {
  it('lädt weitere Seiten, bis eine Seite < 500 Einträge liefert', async () => {
    pages = [
      Array.from({ length: 500 }, () => makeTx('Sonstige GmbH', -1)),
      Array.from({ length: 500 }, () => makeTx('Sonstige GmbH', -1)),
      Array.from({ length: 42 }, () => makeTx('eBay S.a.r.l.', 100)),
    ];

    const all = await fetchAllCheckAccountTransactions({
      apiKey: 'k', startTs: 0, endTs: 1, timeoutMs: 15000,
    });

    expect(all.length).toBe(1042);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    // Offsets korrekt gesetzt:
    const offsets = globalThis.fetch.mock.calls.map(([u]) => new URL(String(u)).searchParams.get('offset'));
    expect(offsets).toEqual(['0', '500', '1000']);
  });

  it('eine Seite < 500 → genau ein Request (kein Overhead im Normalfall)', async () => {
    pages = [Array.from({ length: 10 }, () => makeTx('DHL', -5))];
    const all = await fetchAllCheckAccountTransactions({ apiKey: 'k', startTs: 0, endTs: 1 });
    expect(all.length).toBe(10);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('wirft bei erschöpftem Zeitbudget statt still Unvollständiges zu liefern', async () => {
    pages = [Array.from({ length: 500 }, () => makeTx('X', -1))];
    // fetch der zweiten Seite künstlich verzögern
    let call = 0;
    globalThis.fetch.mockImplementation(async () => {
      call++;
      if (call > 1) await new Promise((r) => setTimeout(r, 50));
      return { ok: true, json: async () => ({ objects: call === 1 ? pages[0] : pages[0] }) };
    });

    await expect(fetchAllCheckAccountTransactions({
      apiKey: 'k', startTs: 0, endTs: 1, timeoutMs: 30,
    })).rejects.toThrow(/Zeitbudget/);
  });
});

describe('getMarketplacePayoutsFromSevDesk mit Pagination', () => {
  it('zählt Auszahlungen jenseits der 500er-Grenze mit', async () => {
    pages = [
      Array.from({ length: 500 }, () => makeTx('Kunde XY', -9.99)),
      [makeTx('eBay S.a.r.l., Boulevard Royal', 250.5), makeTx('cflox GmbH', 100)],
    ];

    const result = await getMarketplacePayoutsFromSevDesk('2026-01-01', '2026-12-31', { forceRefresh: true });

    expect(result.tx_count).toBe(2);
    expect(result.ebay).toBe(250.5);
    expect(result.kaufland).toBe(100);
    expect(result.total).toBe(350.5);
  });
});
