'use strict';

/**
 * Tests für healPendingKauflandPublishes (services/kaufland-listings-sync.js).
 *
 * Hintergrund (Incident 2026-07-10): Publish endet mit
 * KAUFLAND_PRODUCT_DATA_PENDING → Route antwortet 202 — und NICHTS retried.
 * Die Auto-Repair-Phase iteriert nur über kauflandUnitsLive (Produkte MIT
 * Unit), Produkte ohne Unit hängen für immer in Kauflands Portal-Bucket
 * "Angebotsdaten fehlen". Die Heal-Phase greift Produkte mit dem
 * `marketplace.kaufland.publish_pending_at`-Marker auf und holt createUnit
 * nach, sobald Kaufland product_ready meldet.
 *
 * Die Heal-Logik ist als exportierte Funktion mit injizierbaren deps gebaut
 * — dadurch reichen einfache Fakes, kein require.cache-Patching nötig
 * (Modul-Top-Level von kaufland-listings-sync.js hat keine requires).
 */

const { healPendingKauflandPublishes } = require('../services/kaufland-listings-sync');

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const ONE_HOUR_AGO = new Date(NOW - 3600 * 1000).toISOString();
const TEN_MIN_AGO = new Date(NOW - 10 * 60 * 1000).toISOString();
const EIGHT_DAYS_AGO = new Date(NOW - 8 * 24 * 3600 * 1000).toISOString();

const DELETE_SENTINEL = '__FIELD_DELETE__';

function makeDeps() {
  const updates = [];
  const firestore = {
    collection: (name) => ({
      doc: (id) => ({
        update: async (payload) => {
          updates.push({ collection: name, id, payload });
        },
      }),
    }),
  };
  const FieldValue = {
    delete: () => DELETE_SENTINEL,
    increment: (n) => ({ __increment: n }),
  };
  return {
    updates,
    deps: {
      firestore,
      FieldValue,
      now: () => NOW,
      kauflandApi: {
        getProductDataStatus: vi.fn(),
        createUnit: vi.fn(),
      },
      enrichProductForKaufland: vi.fn(),
      tryRepairKauflandProductData: vi.fn().mockResolvedValue({ attempted: true, patchedKeys: [] }),
      saveProductV2: vi.fn().mockResolvedValue({}),
      mergeKauflandOverrides: vi.fn().mockResolvedValue({ shippingGroupId: 144080, warehouseId: 70462 }),
    },
  };
}

function buildPendingProduct({
  id = 'P1',
  ean = '4036231080920',
  sellPrice = 19.99,
  pendingAt = ONE_HOUR_AGO,
  unitId = null,
  attempts = 1,
} = {}) {
  return {
    id,
    identification: { sku: `SKU-${id}` },
    details: {
      identifiers: { ean },
      pricing: sellPrice != null ? { sellPrice } : {},
    },
    ops: unitId ? { kaufland: { unitId } } : {},
    marketplace: {
      kaufland: pendingAt
        ? {
            publish_pending_at: pendingAt,
            publish_pending: { reason: 'product_data_pending', storefront: 'de', attempts },
          }
        : {},
    },
  };
}

describe('healPendingKauflandPublishes', () => {
  it('heals: product_ready=true + Preis vorhanden → createUnit + Marker gelöscht', async () => {
    const { updates, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: true,
      missing_attributes: [],
      min_one_missing_attributes: [],
    });
    deps.kauflandApi.createUnit.mockResolvedValue({ created: true, id_unit: 4711 });

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'P1' })],
      storefront: 'de',
      tenantId: 'default',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 1, attempted: 1, healed: 1 });
    expect(deps.kauflandApi.createUnit).toHaveBeenCalledTimes(1);
    // Defaults (Versandgruppe/Lager) wurden vor createUnit angewendet
    const productArg = deps.kauflandApi.createUnit.mock.calls[0][0];
    expect(productArg.details.kaufland.id_shipping_group).toBe(144080);
    expect(productArg.details.kaufland.id_warehouse).toBe(70462);
    expect(deps.kauflandApi.createUnit.mock.calls[0][1]).toEqual({ storefront: 'de' });

    // Marker + Listing-Fehler gelöscht
    const clearUpdate = updates.find(
      (u) => u.collection === 'products_v2' && u.id === 'P1'
        && u.payload['marketplace.kaufland.publish_pending_at'] === DELETE_SENTINEL
    );
    expect(clearUpdate).toBeDefined();
    expect(clearUpdate.payload['marketplace.kaufland.publish_pending']).toBe(DELETE_SENTINEL);
    expect(clearUpdate.payload['marketplace.kaufland.listing_errors']).toBe(DELETE_SENTINEL);
    expect(clearUpdate.payload['marketplace.kaufland.listing_errors_at']).toBe(DELETE_SENTINEL);
  });

  it('repariert statt zu publishen: product_ready=false mit missing_attributes → enrich+repair, KEIN createUnit, Marker bleibt', async () => {
    const { updates, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: ['Bild', 'Hersteller'],
      min_one_missing_attributes: [],
    });
    const product = buildPendingProduct({ id: 'P2' });
    deps.enrichProductForKaufland.mockResolvedValue({
      enriched: { ...product, details: { ...product.details, enrichedFlag: true } },
      enrichedFields: ['manufacturer'],
    });

    const stats = await healPendingKauflandPublishes({
      products: [product],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 1, attempted: 1, healed: 0 });
    expect(deps.enrichProductForKaufland).toHaveBeenCalledTimes(1);
    expect(deps.enrichProductForKaufland.mock.calls[0][1]).toEqual(['Bild', 'Hersteller']);
    expect(deps.saveProductV2).toHaveBeenCalledTimes(1);
    expect(deps.saveProductV2.mock.calls[0][1]).toEqual(expect.objectContaining({ skipStockEvent: true }));
    expect(deps.tryRepairKauflandProductData).toHaveBeenCalledTimes(1);
    expect(deps.tryRepairKauflandProductData.mock.calls[0][0]).toEqual(expect.objectContaining({
      ean: '4036231080920',
      idUnit: null,
      storefront: 'de',
    }));
    expect(deps.kauflandApi.createUnit).not.toHaveBeenCalled();
    // Marker wurde NICHT gelöscht
    const markerDelete = updates.find(
      (u) => u.payload && u.payload['marketplace.kaufland.publish_pending_at'] === DELETE_SENTINEL
    );
    expect(markerDelete).toBeUndefined();
  });

  it('Repair-TTL: kürzlich reparierte Produkte werden nur status-gecheckt (kein enrich/repair-Spam alle 15min)', async () => {
    const { deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({
      product_ready: false,
      missing_attributes: ['Bild'],
      min_one_missing_attributes: [],
    });
    const product = buildPendingProduct({ id: 'P2b' });
    // last_repair_at vor 10 Minuten → innerhalb des 6h-Repair-TTL
    product.marketplace.kaufland.publish_pending.last_repair_at = TEN_MIN_AGO;

    const stats = await healPendingKauflandPublishes({
      products: [product],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 1, attempted: 1, healed: 0 });
    expect(deps.kauflandApi.getProductDataStatus).toHaveBeenCalledTimes(1);
    expect(deps.enrichProductForKaufland).not.toHaveBeenCalled();
    expect(deps.tryRepairKauflandProductData).not.toHaveBeenCalled();
    expect(deps.kauflandApi.createUnit).not.toHaveBeenCalled();
  });

  it('lässt Produkte ohne publish_pending_at unangetastet', async () => {
    const { updates, deps } = makeDeps();

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'P3', pendingAt: null })],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 0, attempted: 0, healed: 0 });
    expect(deps.kauflandApi.getProductDataStatus).not.toHaveBeenCalled();
    expect(deps.kauflandApi.createUnit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('überspringt Produkte mit bekannter Unit (ops.kaufland.unitId) und zu junge Marker (<30min)', async () => {
    const { updates, deps } = makeDeps();

    const stats = await healPendingKauflandPublishes({
      products: [
        buildPendingProduct({ id: 'P4', unitId: '999' }),
        buildPendingProduct({ id: 'P5', pendingAt: TEN_MIN_AGO }),
      ],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 0, attempted: 0, healed: 0 });
    expect(deps.kauflandApi.getProductDataStatus).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('createUnit wirft erneut KAUFLAND_PRODUCT_DATA_PENDING → attempts hochgezählt, Marker bleibt, kein Crash', async () => {
    const { updates, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({ product_ready: true });
    const pendingErr = new Error('Kaufland verarbeitet asynchron');
    pendingErr.code = 'KAUFLAND_PRODUCT_DATA_PENDING';
    deps.kauflandApi.createUnit.mockRejectedValue(pendingErr);

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'P6' })],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 1, attempted: 1, healed: 0 });
    const incrementUpdate = updates.find(
      (u) => u.id === 'P6' && u.payload['marketplace.kaufland.publish_pending.attempts']
    );
    expect(incrementUpdate).toBeDefined();
    expect(incrementUpdate.payload['marketplace.kaufland.publish_pending.attempts']).toEqual({ __increment: 1 });
    // Marker wurde NICHT gelöscht
    const markerDelete = updates.find(
      (u) => u.payload && u.payload['marketplace.kaufland.publish_pending_at'] === DELETE_SENTINEL
    );
    expect(markerDelete).toBeUndefined();
  });

  it('kein Preis ableitbar → listing_error persistiert, KEIN createUnit, Marker bleibt', async () => {
    const { updates, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({ product_ready: true });

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'P7', sellPrice: null })],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 1, attempted: 1, healed: 0 });
    expect(deps.kauflandApi.createUnit).not.toHaveBeenCalled();
    const errUpdate = updates.find(
      (u) => u.id === 'P7' && Array.isArray(u.payload['marketplace.kaufland.listing_errors'])
    );
    expect(errUpdate).toBeDefined();
    expect(errUpdate.payload['marketplace.kaufland.listing_errors'][0]).toEqual(expect.objectContaining({
      code: 'KAUFLAND_PRICE_INVALID',
      severity: 'Error',
    }));
    expect(errUpdate.payload['marketplace.kaufland.listing_errors_at']).toBeDefined();
    // Marker wurde NICHT gelöscht
    const markerDelete = updates.find(
      (u) => u.payload && u.payload['marketplace.kaufland.publish_pending_at'] === DELETE_SENTINEL
    );
    expect(markerDelete).toBeUndefined();
  });

  it('>24h alter Marker VERFÄLLT: kein API-Call, kein createUnit, Marker gelöscht + Audit-Feld (Betreiber-Entscheidung 2026-08-21)', async () => {
    // Vorher blieb der Marker EWIG stehen (nach 7 Tagen nur Cockpit-Warnung)
    // — ein wochenalter, längst vergessener Publish-Klick konnte plötzlich
    // ein Live-Angebot erzeugen (gemessen: 7 Marker vom 11.07. standen am
    // 21.08. noch offen). Neu: der Klick darf nur noch am selben Tag
    // vollendet werden, danach verfällt er lautlos und sauber.
    const { updates, deps } = makeDeps();

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'P8', pendingAt: EIGHT_DAYS_AGO })],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 0, attempted: 0, healed: 0, expired: 1 });
    // Kein Status-Check, kein createUnit — der Verfall ist ein reiner Cleanup.
    expect(deps.kauflandApi.getProductDataStatus).not.toHaveBeenCalled();
    expect(deps.kauflandApi.createUnit).not.toHaveBeenCalled();
    // Marker gelöscht + Audit-Feld gesetzt
    const expireUpdate = updates.find(
      (u) => u.id === 'P8' && u.payload['marketplace.kaufland.publish_pending_at'] === DELETE_SENTINEL
    );
    expect(expireUpdate).toBeDefined();
    expect(expireUpdate.payload['marketplace.kaufland.publish_pending_expired_at']).toBeTruthy();
  });

  it('NUR recherchierter Marktpreis (lowest_price) vorhanden → wird NICHT gelistet (Betreiber-Entscheidung 2026-08-21)', async () => {
    // Der frühere Fallback bis auf details.pricing.lowest_price.amount hätte
    // einen nie bestätigten Recherche-Preis unbeaufsichtigt online gestellt.
    // Im unbeaufsichtigten Heal-Pfad darf NUR ein ausdrücklich gesetzter
    // Verkaufspreis (sellPrice) live gehen.
    const { updates, deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({ product_ready: true });

    const product = buildPendingProduct({ id: 'P10', sellPrice: null });
    product.details.pricing = { lowest_price: { amount: 25.99 } };

    const stats = await healPendingKauflandPublishes({
      products: [product],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 1, attempted: 1, healed: 0 });
    expect(deps.kauflandApi.createUnit).not.toHaveBeenCalled();
    const errUpdate = updates.find(
      (u) => u.id === 'P10' && Array.isArray(u.payload['marketplace.kaufland.listing_errors'])
    );
    expect(errUpdate).toBeDefined();
    expect(errUpdate.payload['marketplace.kaufland.listing_errors'][0].message).toContain('Verkaufspreis');
  });

  it('ohne EAN → skip (kein API-Call), zählt nicht als attempted', async () => {
    const { deps } = makeDeps();

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'P9', ean: '' })],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 1, attempted: 0, healed: 0 });
    expect(deps.kauflandApi.getProductDataStatus).not.toHaveBeenCalled();
  });

  it('cap: verarbeitet höchstens 20 Kandidaten pro Lauf', async () => {
    const { deps } = makeDeps();
    deps.kauflandApi.getProductDataStatus.mockResolvedValue({ product_ready: true });
    deps.kauflandApi.createUnit.mockResolvedValue({ created: true, id_unit: 1 });

    const products = Array.from({ length: 25 }, (_, i) => buildPendingProduct({ id: `CAP-${i}` }));
    const stats = await healPendingKauflandPublishes({ products, storefront: 'de', deps: deps });

    expect(stats.candidates).toBe(25);
    expect(stats.attempted).toBe(20);
    expect(stats.healed).toBe(20);
    expect(deps.kauflandApi.createUnit).toHaveBeenCalledTimes(20);
  });

  it('per-Produkt-Fehler crashen den Lauf nicht (getProductDataStatus-Ausfall → weiter mit nächstem)', async () => {
    const { deps } = makeDeps();
    // Erster Kandidat: Status-API kaputt (catch → null → not-ready-Pfad ohne
    // missing list). Zweiter Kandidat: ready → healed.
    deps.kauflandApi.getProductDataStatus
      .mockRejectedValueOnce(new Error('kaufland-down'))
      .mockResolvedValueOnce({ product_ready: true });
    deps.kauflandApi.createUnit.mockResolvedValue({ created: true, id_unit: 2 });

    const stats = await healPendingKauflandPublishes({
      products: [buildPendingProduct({ id: 'PA' }), buildPendingProduct({ id: 'PB' })],
      storefront: 'de',
      deps: deps,
    });

    expect(stats).toEqual({ candidates: 2, attempted: 2, healed: 1 });
  });
});
