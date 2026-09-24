const request = require('supertest');
require('./_patchGcp');
const { spies } = require('./_patchLocalModules');
const { firestoreModule } = require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const router = require('../../routes/marketplace');
const app = createTestApp(router);
const { MARKETPLACE_PRODUCT_FIELDS } = require('../../lib/product-read-models');

test('Kaufland reads the full projected catalog in parallel, retaining pricing, validity and authoritative empty bins', async () => {
  const products = [{ id: 'p1', identification: { sku: 'SKU-1', name: 'Article', brand: 'Brand', category: 'Category' }, details: { images: [{ url: 'https://example.org/a.jpg' }] }, inventory: { quantity: 4 }, storageBins: [] }];
  const select = vi.fn(() => ({}));
  let unitsStarted = false;
  spies.getAllProductsV2ForTenant.mockImplementation(async (tenantId, options) => {
    expect(tenantId).toBe('default');
    options.queryFn({ select });
    expect(unitsStarted).toBe(true);
    return products;
  });
  const originalGetAll = firestoreModule.firestore.getAll;
  const legacy = vi.fn();
  firestoreModule.firestore.getAll = legacy;
  const collection = vi.spyOn(firestoreModule.firestore, 'collection').mockImplementation(name => {
    expect(name).toBe('kauflandUnitsLive');
    const query = { where: () => query, get: async () => {
      unitsStarted = true;
      return { empty: false, docs: [
        { id: 'unit-1', data: () => ({ id_offer: 'SKU-1', status: 'AVAILABLE', active: true, product_valid: false, current_price: 1900, listing_price: 2100, minimum_price: 1700, amount: 3, invalid_missing_attributes: ['Bild'] }) },
        { id: 'old', data: () => ({ id_offer: 'SKU-1', status: 'STALE' }) },
      ] };
    } };
    return query;
  });
  try {
    const res = await request(app).get('/api/kaufland/listings?storefront=de');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ productId: 'p1', title: 'Article', price: 19, listingPrice: 21, minimumPrice: 17, warehouseStock: 4, binLocation: null, stockMismatch: true, productValid: false, invalidMissingAttributes: ['Bild'] });
    expect(select).toHaveBeenCalledWith(...MARKETPLACE_PRODUCT_FIELDS);
    expect(legacy).not.toHaveBeenCalled();
  } finally { collection.mockRestore(); firestoreModule.firestore.getAll = originalGetAll; }
});
