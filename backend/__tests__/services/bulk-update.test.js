'use strict';

/**
 * Tests for the bulk-update service field whitelist + value application.
 *
 * Guards the Produktdaten grid edit-mode save path (PATCH /api/v1/products/bulk-update):
 *  - MPN (details.identifiers.mpn) and weight (details.weight) MUST be editable so the
 *    new AdminTable columns persist when edited inline.
 *  - inventory.quantity MUST stay rejected — stock mutations go through withStockLock()
 *    + the warehouse flow (CLAUDE.md #10/#12/#13, oversell / single-writer invariant),
 *    never this generic bulk-update path.
 *  - The whitelist is fail-fast: one unknown field rejects the whole batch (HTTP 400),
 *    so a missing whitelist entry would silently break every grid save.
 */

require('../api/_patchGcp');

function patchCache(name, exportsObj) {
  const key = require.resolve(name);
  require.cache[key] = { id: key, filename: key, loaded: true, exports: exportsObj, children: [], paths: [] };
}

// In-memory product-store double — the service writes ONLY via saveProductV2.
const store = new Map();
const saved = [];
patchCache('../../lib/product-store', {
  getProductV2: async (id) => (store.has(id) ? store.get(id) : null),
  saveProductV2: async (product, options) => { saved.push({ product, options }); return product; },
});

const { bulkUpdateProducts, ALLOWED_FIELDS } = require('../../services/bulk-update');

beforeEach(() => {
  store.clear();
  saved.length = 0;
  store.set('p1', {
    id: 'p1',
    identification: { name: 'Bremsscheibe', category: 'Auto & Motorrad' },
    details: {
      identifiers: { sku: 'SKU1' },
      pricing: { lowest_price: { amount: 10, currency: 'EUR' } },
    },
    inventory: { quantity: 5 },
  });
});

describe('bulk-update field whitelist', () => {
  it('accepts MPN edits (details.identifiers.mpn) and writes them via saveProductV2(manual)', async () => {
    const res = await bulkUpdateProducts({
      productIds: ['p1'],
      updates: [{ field: 'details.identifiers.mpn', value: 'MPN-123' }],
      dryRun: false,
    });
    expect(res.errors).toHaveLength(0);
    expect(res.updated).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].product.details.identifiers.mpn).toBe('MPN-123');
    expect(saved[0].options.mode).toBe('manual');
  });

  it('accepts weight edits (details.weight)', async () => {
    const res = await bulkUpdateProducts({
      productIds: ['p1'],
      updates: [{ field: 'details.weight', value: 2.5 }],
      dryRun: false,
    });
    expect(res.errors).toHaveLength(0);
    expect(res.updated).toBe(1);
    expect(saved[0].product.details.weight).toBe(2.5);
  });

  it('accepts price edits on the displayed field (details.pricing.lowest_price.amount)', async () => {
    const res = await bulkUpdateProducts({
      productIds: ['p1'],
      updates: [{ field: 'details.pricing.lowest_price.amount', value: 19.99 }],
      dryRun: false,
    });
    expect(res.updated).toBe(1);
    expect(saved[0].product.details.pricing.lowest_price.amount).toBe(19.99);
  });

  it('REJECTS inventory.quantity to preserve the stock single-writer invariant', async () => {
    await expect(
      bulkUpdateProducts({
        productIds: ['p1'],
        updates: [{ field: 'inventory.quantity', value: 999 }],
        dryRun: false,
      })
    ).rejects.toThrow(/Unbekanntes Feld/);
    expect(saved).toHaveLength(0);
  });

  it('whitelist contains mpn + weight but never inventory.quantity', () => {
    expect(ALLOWED_FIELDS.has('details.identifiers.mpn')).toBe(true);
    expect(ALLOWED_FIELDS.has('details.weight')).toBe(true);
    expect(ALLOWED_FIELDS.has('inventory.quantity')).toBe(false);
    expect(ALLOWED_FIELDS.has('inventory.physicalQuantity')).toBe(false);
  });
});
