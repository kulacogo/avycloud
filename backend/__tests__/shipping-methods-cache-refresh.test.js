// REGRESSION GUARD — shipping_methods-Cache darf nicht unbegrenzt veralten
// (2026-07-20): Der Cache wurde nur bei LEERER Collection oder manuellem
// Sync-Button neu aufgebaut. Ergebnis in Prod: letzter Sync 02.04.2026 (vor dem
// SendCloud-Konto-Reconnect), 146 statt 185 Methoden — die Nicht-Premium-
// Warenpost-Varianten fehlten in Versandregeln UND Bestell-Dropdown komplett.
//
// Erwartung: getCachedShippingMethods liefert den Cache SOFORT aus (nie
// blockierend) und stößt bei Überschreiten von METHODS_REFRESH_TTL_MS einen
// Hintergrund-Sync an (stale-while-revalidate). Frischer Cache → kein API-Call.

const { mockQuery } = require('./api/_patchGcp');

const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: { lookupCsvPrice: vi.fn().mockResolvedValue(null), listSenderAddresses: vi.fn() },
  children: [], paths: [],
};
const sendcloudAuthPath = require.resolve('../lib/sendcloud-auth');
require.cache[sendcloudAuthPath] = {
  id: sendcloudAuthPath, filename: sendcloudAuthPath, loaded: true,
  exports: { getSendCloudAuthHeader: vi.fn().mockResolvedValue('Basic mock') },
  children: [], paths: [],
};

const { getCachedShippingMethods, syncShippingMethods } = require('../services/shipping-engine');

const methodDoc = (lastSyncedAt) => ({
  id: 'default_4210',
  data: () => ({
    tenantId: 'default',
    sendcloudId: 4210,
    carrier: 'dhl_de',
    carrierName: 'dhl_de',
    name: 'DHL Warenpost International Premium',
    minWeight: 0.01,
    maxWeight: 1.001,
    countries: ['AT'],
    enabled: true,
    lastSyncedAt,
  }),
});

describe('getCachedShippingMethods — stale-while-revalidate', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        shipping_methods: [{
          id: 4208, carrier: 'dhl_de', name: 'DHL Warenpost International',
          min_weight: '0.01', max_weight: '1.001', countries: [{ iso_2: 'AT' }],
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Cache älter als TTL → liefert Cache sofort UND stößt Hintergrund-Sync an', async () => {
    const staleDocs = [methodDoc('2026-04-02T13:38:17.011Z')];
    mockQuery.get.mockResolvedValue({ docs: staleDocs, empty: false, size: 1, forEach: () => {} });

    const methods = await getCachedShippingMethods('default');
    // Antwort kommt aus dem Cache (alter Stand), nicht blockiert vom Sync
    expect(methods).toHaveLength(1);
    expect(methods[0].sendcloudId).toBe(4210);

    // Hintergrund-Sync ruft die SendCloud-v2-Methodenliste ab
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/shipping_methods'),
        expect.anything()
      );
    });
  });

  it('EMPTY-SET-GUARD: leere 200er-Antwort → kein Disable-Sweep, bestehender Cache bleibt (auch bei force)', async () => {
    // Review-Finding 2026-07-20 (major): transient leere Antwort im
    // Reconnect-Fenster hätte sonst ALLE ~185 Methoden disabled und alle
    // Dropdowns ≥1h geleert (Disable stempelt lastSyncedAt=now → 1h-Guard).
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ shipping_methods: [] }) });
    const cachedDocs = [methodDoc('2026-04-02T13:38:17.011Z')];
    mockQuery.get.mockResolvedValue({ docs: cachedDocs, empty: false, size: 1, forEach: () => {} });

    const methods = await syncShippingMethods('default', { force: true });
    expect(fetchSpy).toHaveBeenCalled();
    // Bestehender enabled-Stand wird zurückgegeben statt geleert
    expect(methods).toHaveLength(1);
    expect(methods[0].sendcloudId).toBe(4210);
  });

  it('Failure-Backoff: fehlgeschlagener Refresh → nächster Aufruf feuert KEINEN neuen API-Call', async () => {
    fetchSpy.mockRejectedValue(new Error('SendCloud 503'));
    const staleDocs = [methodDoc('2026-04-02T13:38:17.011Z')];
    mockQuery.get.mockResolvedValue({ docs: staleDocs, empty: false, size: 1, forEach: () => {} });

    await getCachedShippingMethods('backoff-tenant');
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    // Hintergrund-Promise settlen lassen (finally räumt das Inflight-Set)
    await new Promise((r) => setTimeout(r, 20));

    await getCachedShippingMethods('backoff-tenant');
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Backoff aktiv, kein zweiter Versuch
  });

  it('frischer Cache → KEIN SendCloud-API-Call', async () => {
    const freshDocs = [methodDoc(new Date().toISOString())];
    mockQuery.get.mockResolvedValue({ docs: freshDocs, empty: false, size: 1, forEach: () => {} });

    const methods = await getCachedShippingMethods('default');
    expect(methods).toHaveLength(1);

    // Kein Refresh nötig — kurz warten, dann sicherstellen dass nichts feuerte
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
