'use strict';

/**
 * Tests für syncKauflandInvalidReasons (services/kaufland-listings-sync.js).
 *
 * Hintergrund (2026-07-11): Kaufland zeigt product_valid=false Units im Portal
 * als "Inaktiv" mit Badge "Ungültig" — avycloud zählte sie als aktiv und die
 * GRÜNDE (fehlende/abgelehnte Pflichtattribute aus getProductDataStatus)
 * waren nirgends sichtbar. Die neue Phase spiegelt die Gründe in die
 * kauflandUnitsLive-Docs (invalid_missing_attributes / invalid_declined /
 * invalid_reasons_checked_at) und als persistenten Listing-Fehler
 * (KAUFLAND_PRODUCT_DATA_INVALID) aufs products_v2-Produkt.
 *
 * Wie healPendingKauflandPublishes ist die Kernlogik als exportierte Funktion
 * mit injizierbaren deps gebaut — einfache Fakes reichen, kein
 * require.cache-Patching nötig.
 */

const { syncKauflandInvalidReasons } = require('../services/kaufland-listings-sync');

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const ONE_HOUR_AGO = new Date(NOW - 3600 * 1000).toISOString();
const SEVEN_HOURS_AGO = new Date(NOW - 7 * 3600 * 1000).toISOString();

const DELETE_SENTINEL = '__FIELD_DELETE__';

function makeDeps() {
  const writes = [];
  const firestore = {
    collection: (name) => ({
      doc: (id) => ({
        set: async (payload, opts) => {
          writes.push({ kind: 'set', collection: name, id, payload, opts });
        },
        update: async (payload) => {
          writes.push({ kind: 'update', collection: name, id, payload });
        },
      }),
    }),
  };
  const FieldValue = { delete: () => DELETE_SENTINEL };
  return {
    writes,
    deps: {
      firestore,
      FieldValue,
      now: () => NOW,
      sleepMs: 0,
      kauflandApi: { getProductDataStatus: vi.fn() },
    },
  };
}

function unitDoc({
  docId = '1001',
  sku = 'SKU-A',
  ean = '4012345678901',
  productValid = false,
  status = 'AVAILABLE',
  active = true,
  checkedAt = null,
  extra = {},
} = {}) {
  return {
    docId,
    data: {
      id_unit: Number(docId),
      id_offer: sku,
      ean,
      status,
      active,
      storefront: 'de',
      product_valid: productValid,
      ...(checkedAt ? { invalid_reasons_checked_at: checkedAt } : {}),
      ...extra,
    },
  };
}

function productFor({ id = 'P1', sku = 'SKU-A', ean = '4012345678901', listingErrors = null } = {}) {
  return {
    id,
    identification: { sku, ean },
    marketplace: { kaufland: listingErrors ? { listing_errors: listingErrors } : {} },
  };
}

describe('syncKauflandInvalidReasons', () => {
  it('(a) invalider Unit-Doc → Status geholt, Mirror-Felder + listing_error geschrieben', async () => {
    const { writes, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      product_not_ready_reason: 'attributes missing',
      missing_attributes: ['Bild', 'Signalwort'],
      min_one_missing_attributes: ['Signalwort', 'Titel'],
      attribute_values: [
        { attribute: 'picture', original_value: 'x', state: 'DECLINED', message: 'reason: media_not_ready_yet' },
        { attribute: 'title', original_value: 'y', state: 'TRANSFORMED', message: '' },
        { attribute: 'category', original_value: 'z', state: 'PENDING', message: '' },
      ],
    });

    const stats = await syncKauflandInvalidReasons({
      unitDocs: [unitDoc({ docId: '1001', sku: 'SKU-A', ean: '4012345678901' })],
      products: [productFor({ id: 'P1', sku: 'SKU-A' })],
      storefront: 'de',
      deps,
    });

    expect(stats).toEqual({ candidates: 1, fetched: 1, cleared: 0 });
    expect(deps.kauflandApi.getProductDataStatus).toHaveBeenCalledTimes(1);
    expect(deps.kauflandApi.getProductDataStatus).toHaveBeenCalledWith('4012345678901');

    // Mirror-Doc: dedupe(missing + min_one), nur DECLINED, ISO-checked_at
    const mirrorWrite = writes.find((w) => w.kind === 'set' && w.collection === 'kauflandUnitsLive' && w.id === '1001');
    expect(mirrorWrite).toBeDefined();
    expect(mirrorWrite.opts).toEqual({ merge: true });
    expect(mirrorWrite.payload.invalid_missing_attributes).toEqual(['Bild', 'Signalwort', 'Titel']);
    expect(mirrorWrite.payload.invalid_declined).toEqual([
      { attribute: 'picture', message: 'media_not_ready_yet' },
    ]);
    expect(mirrorWrite.payload.invalid_reasons_checked_at).toBe(NOW_ISO);

    // Produkt: listing_error im persistKauflandListingError-Format
    const errWrite = writes.find((w) => w.kind === 'update' && w.collection === 'products_v2' && w.id === 'P1');
    expect(errWrite).toBeDefined();
    const errs = errWrite.payload['marketplace.kaufland.listing_errors'];
    expect(Array.isArray(errs)).toBe(true);
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe('KAUFLAND_PRODUCT_DATA_INVALID');
    expect(errs[0].severity).toBe('Error');
    expect(errs[0].message).toContain('Kaufland-Angebot inaktiv');
    expect(errs[0].message).toContain('fehlende Produktdaten: Bild, Signalwort, Titel');
    expect(errs[0].message).toContain('abgelehnt: picture (media_not_ready_yet)');
    expect(errWrite.payload['marketplace.kaufland.listing_errors_at']).toBe(NOW_ISO);
  });

  it('(b) TTL frisch → kein API-Call, kein Write; retired Tombstones werden ignoriert', async () => {
    const { writes, deps } = makeDeps();

    const stats = await syncKauflandInvalidReasons({
      unitDocs: [
        // vor 1h geholt → innerhalb 6h-TTL
        unitDoc({ docId: '2001', checkedAt: ONE_HOUR_AGO }),
        // STALE-Tombstone mit product_valid=false → nie abfragen
        unitDoc({ docId: '2002', status: 'STALE', active: false }),
        // ohne EAN → skip
        unitDoc({ docId: '2003', ean: '', extra: { eans: [] } }),
      ],
      products: [],
      storefront: 'de',
      deps,
    });

    expect(stats).toEqual({ candidates: 0, fetched: 0, cleared: 0 });
    expect(deps.kauflandApi.getProductDataStatus).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('(b2) TTL abgelaufen (>6h) → wird erneut geholt', async () => {
    const { deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: ['Bild'],
      min_one_missing_attributes: [],
      attribute_values: [],
    });

    const stats = await syncKauflandInvalidReasons({
      unitDocs: [unitDoc({ docId: '2100', checkedAt: SEVEN_HOURS_AGO })],
      products: [],
      storefront: 'de',
      deps,
    });

    expect(stats).toEqual({ candidates: 1, fetched: 1, cleared: 0 });
    expect(deps.kauflandApi.getProductDataStatus).toHaveBeenCalledTimes(1);
  });

  it('(c) valid geworden → Mirror-Felder gelöscht + eigener listing_error gelöscht, fremder Code bleibt', async () => {
    const { writes, deps } = makeDeps();

    const stats = await syncKauflandInvalidReasons({
      unitDocs: [
        // eigener Fehler-Code am Produkt → wird mitgelöscht
        unitDoc({
          docId: '3001', sku: 'SKU-OWN', ean: '4000000000001', productValid: true,
          extra: {
            invalid_missing_attributes: ['Bild'],
            invalid_declined: [],
            invalid_reasons_checked_at: SEVEN_HOURS_AGO,
          },
        }),
        // fremder Fehler-Code am Produkt → Mirror geräumt, Produkt-Fehler bleibt
        unitDoc({
          docId: '3002', sku: 'SKU-FOREIGN', ean: '4000000000002', productValid: true,
          extra: {
            invalid_missing_attributes: ['Signalwort'],
            invalid_declined: [],
            invalid_reasons_checked_at: SEVEN_HOURS_AGO,
          },
        }),
        // valid ohne Grund-Felder → gar kein Write
        unitDoc({ docId: '3003', sku: 'SKU-CLEAN', ean: '4000000000003', productValid: true }),
      ],
      products: [
        productFor({
          id: 'P-OWN', sku: 'SKU-OWN', ean: '4000000000001',
          listingErrors: [{ code: 'KAUFLAND_PRODUCT_DATA_INVALID', message: 'Kaufland-Angebot inaktiv — fehlende Produktdaten: Bild', severity: 'Error' }],
        }),
        productFor({
          id: 'P-FOREIGN', sku: 'SKU-FOREIGN', ean: '4000000000002',
          listingErrors: [{ code: 'KAUFLAND_MANUFACTURER_NOT_WHITELISTED', message: 'Hersteller nicht freigeschaltet', severity: 'Error' }],
        }),
      ],
      storefront: 'de',
      deps,
    });

    expect(stats).toEqual({ candidates: 0, fetched: 0, cleared: 2 });
    expect(deps.kauflandApi.getProductDataStatus).not.toHaveBeenCalled();

    // Beide Mirror-Docs: die drei invalid_*-Felder via FieldValue.delete()
    for (const id of ['3001', '3002']) {
      const clearWrite = writes.find((w) => w.kind === 'set' && w.collection === 'kauflandUnitsLive' && w.id === id);
      expect(clearWrite).toBeDefined();
      expect(clearWrite.payload.invalid_missing_attributes).toBe(DELETE_SENTINEL);
      expect(clearWrite.payload.invalid_declined).toBe(DELETE_SENTINEL);
      expect(clearWrite.payload.invalid_reasons_checked_at).toBe(DELETE_SENTINEL);
    }
    // 3003 hatte keine Grund-Felder → kein Write
    expect(writes.find((w) => w.collection === 'kauflandUnitsLive' && w.id === '3003')).toBeUndefined();

    // Eigener listing_error gelöscht …
    const ownClear = writes.find((w) => w.kind === 'update' && w.collection === 'products_v2' && w.id === 'P-OWN');
    expect(ownClear).toBeDefined();
    expect(ownClear.payload['marketplace.kaufland.listing_errors']).toBe(DELETE_SENTINEL);
    expect(ownClear.payload['marketplace.kaufland.listing_errors_at']).toBe(DELETE_SENTINEL);
    // … fremder bleibt unangetastet
    expect(writes.find((w) => w.collection === 'products_v2' && w.id === 'P-FOREIGN')).toBeUndefined();
  });

  it('(d) fremder listing_error wird nicht überschrieben, eigener schon', async () => {
    const { writes, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: ['Bild'],
      min_one_missing_attributes: [],
      attribute_values: [],
    });

    const stats = await syncKauflandInvalidReasons({
      unitDocs: [
        unitDoc({ docId: '4001', sku: 'SKU-FOREIGN', ean: '4000000000010' }),
        unitDoc({ docId: '4002', sku: 'SKU-OWN', ean: '4000000000011' }),
        // Fehler mit code=null (z.B. aus persistKauflandListingError-Default)
        // ist ebenfalls fremd — nicht wegbügeln.
        unitDoc({ docId: '4003', sku: 'SKU-NULLCODE', ean: '4000000000012' }),
      ],
      products: [
        productFor({
          id: 'P-FOREIGN', sku: 'SKU-FOREIGN', ean: '4000000000010',
          listingErrors: [{ code: 'KAUFLAND_MANUFACTURER_NOT_WHITELISTED', message: 'Hersteller nicht freigeschaltet', severity: 'Error' }],
        }),
        productFor({
          id: 'P-OWN', sku: 'SKU-OWN', ean: '4000000000011',
          listingErrors: [{ code: 'KAUFLAND_PRODUCT_DATA_INVALID', message: 'Kaufland-Angebot inaktiv — fehlende Produktdaten: Titel', severity: 'Error' }],
        }),
        productFor({
          id: 'P-NULLCODE', sku: 'SKU-NULLCODE', ean: '4000000000012',
          listingErrors: [{ code: null, message: 'Publish fehlgeschlagen', severity: 'Error' }],
        }),
      ],
      storefront: 'de',
      deps,
    });

    expect(stats).toEqual({ candidates: 3, fetched: 3, cleared: 0 });

    // Mirror-Felder werden für ALLE drei geschrieben (Gründe-Spiegel ist
    // unabhängig vom Produkt-Fehler)
    const mirrorWrites = writes.filter((w) => w.kind === 'set' && w.collection === 'kauflandUnitsLive');
    expect(mirrorWrites.map((w) => w.id).sort()).toEqual(['4001', '4002', '4003']);

    // Produkt-Fehler: nur der eigene Code wird überschrieben
    const productWrites = writes.filter((w) => w.kind === 'update' && w.collection === 'products_v2');
    expect(productWrites.map((w) => w.id)).toEqual(['P-OWN']);
    expect(productWrites[0].payload['marketplace.kaufland.listing_errors'][0].code)
      .toBe('KAUFLAND_PRODUCT_DATA_INVALID');
    expect(productWrites[0].payload['marketplace.kaufland.listing_errors'][0].message)
      .toContain('fehlende Produktdaten: Bild');
  });

  it('(e) Cap: höchstens 40 Fetches pro Lauf, Rest bleibt für den nächsten', async () => {
    const { deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: ['Bild'],
      min_one_missing_attributes: [],
      attribute_values: [],
    });

    const unitDocs = Array.from({ length: 45 }, (_, i) => unitDoc({
      docId: String(5000 + i),
      sku: `SKU-CAP-${i}`,
      ean: String(4000000100000 + i),
    }));

    const stats = await syncKauflandInvalidReasons({ unitDocs, products: [], storefront: 'de', deps });

    expect(stats.candidates).toBe(45);
    expect(stats.fetched).toBe(40);
    expect(deps.kauflandApi.getProductDataStatus).toHaveBeenCalledTimes(40);
  });

  it('(f) API-Fehler pro Doc swallowed — kein checked_at-Write (Retry im nächsten Lauf), Rest läuft weiter', async () => {
    const { writes, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus
      .mockRejectedValueOnce(new Error('kaufland-down'))
      .mockResolvedValueOnce({
        product_ready: false,
        missing_attributes: ['Signalwort'],
        min_one_missing_attributes: [],
        attribute_values: [],
      });

    const stats = await syncKauflandInvalidReasons({
      unitDocs: [
        unitDoc({ docId: '6001', sku: 'SKU-FAIL', ean: '4000000000021' }),
        unitDoc({ docId: '6002', sku: 'SKU-OK', ean: '4000000000022' }),
      ],
      products: [],
      storefront: 'de',
      deps,
    });

    expect(stats).toEqual({ candidates: 2, fetched: 1, cleared: 0 });
    // Fehlgeschlagener Doc: KEIN Write → invalid_reasons_checked_at bleibt
    // leer, der nächste Lauf versucht es erneut.
    expect(writes.find((w) => w.collection === 'kauflandUnitsLive' && w.id === '6001')).toBeUndefined();
    const okWrite = writes.find((w) => w.collection === 'kauflandUnitsLive' && w.id === '6002');
    expect(okWrite).toBeDefined();
    expect(okWrite.payload.invalid_missing_attributes).toEqual(['Signalwort']);
  });
});
