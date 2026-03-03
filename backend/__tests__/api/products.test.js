/**
 * Integration-Tests: Products API (CJS)
 *
 * CJS test file (.js) — Uses require.cache patching to mock dependencies.
 * Works around Vitest 4.x's broken vi.mock() for CommonJS modules.
 *
 * Tested endpoints:
 * - GET  /api/products             → Produktliste
 * - GET  /api/products/:id         → Einzelnes Produkt
 * - DELETE /api/products/:id       → Produkt löschen
 * - POST /api/save                 → Produkt speichern
 * - GET  /api/me/permissions       → User-Permissions
 * - GET  /api/v1/products/duplicates → Duplikate
 * - GET  /api/v1/pricing/rules     → Preisregeln
 * - GET  /api/v1/forecast/:id      → Absatz-Forecast
 * - GET  /api/inventories          → Inventar-Liste
 * - GET  /api/inventories/:id      → Einzelnes Inventar
 */

// globals: true in vitest.config.js makes describe, it, expect, beforeEach, vi available
const request = require('supertest');

// ─── CRITICAL: Patch GCP first, then local modules, before requiring routes ───

require('./_patchGcp');
const localMocks = require('./_patchLocalModules');
const { spies: firebaseSpies, firestoreModule } = require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: productsRouter } = require('../../routes/products');

// ─── Test App ─────────────────────────────────────────────────────────────────

const app = createTestApp(productsRouter);

const SAMPLE_PRODUCT = {
  id: 'SKU-0362404564',
  identification: { name: 'Test Hochstuhl', brand: 'UBRAVOO', sku: 'SKU-0362404564' },
  details: {
    attributes: { Marke: 'UBRAVOO', Farbe: 'Grau', Modell: 'ACE1013' },
    images: [],
    identifiers: { ean: '4012345678901' },
  },
  ops: { totalStock: 5 },
};

const SAMPLE_INVENTORY = {
  inventoryId: 'inv-001',
  name: 'Hauptlager',
  warehouseId: 'warehouse-001',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/products', () => {
  beforeEach(() => {
    firebaseSpies.getAllProducts?.mockReset();
  });

  it('returns 200 with products array', async () => {
    firebaseSpies.getAllProducts?.mockResolvedValue([SAMPLE_PRODUCT]);
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(res.body.products.length).toBe(1);
  });

  it('returns 200 with empty array when no products exist', async () => {
    firebaseSpies.getAllProducts?.mockResolvedValue([]);
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it('returns 500 when firestore throws', async () => {
    firebaseSpies.getAllProducts?.mockRejectedValue(new Error('Firestore unavailable'));
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/products/:id', () => {
  beforeEach(() => {
    firebaseSpies.getProduct?.mockReset();
  });

  it('returns 404 when product does not exist', async () => {
    firebaseSpies.getProduct?.mockResolvedValue(null);
    const res = await request(app).get('/api/products/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('returns product with details', async () => {
    firebaseSpies.getProduct?.mockResolvedValue(SAMPLE_PRODUCT);
    const res = await request(app).get('/api/products/SKU-0362404564');
    expect(res.status).toBe(200);
    expect(res.body.product.details).toBeDefined();
  });
});

describe('DELETE /api/products/:id', () => {
  beforeEach(() => {
    firebaseSpies.getProduct?.mockReset();
    firebaseSpies.deleteProduct?.mockReset();
  });

  it('returns 200 on successful delete', async () => {
    firebaseSpies.getProduct?.mockResolvedValue(SAMPLE_PRODUCT);
    firebaseSpies.deleteProduct?.mockResolvedValue();
    const res = await request(app).delete('/api/products/SKU-0362404564');
    expect(res.status).toBe(200);
  });

  it('returns 404 when product to delete does not exist', async () => {
    firebaseSpies.getProduct?.mockResolvedValue(null);
    const res = await request(app).delete('/api/products/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/save', () => {
  beforeEach(() => {
    localMocks.spies.saveProductV2?.mockReset();
  });

  it('returns 400 when body is missing required fields', async () => {
    const res = await request(app).post('/api/save').send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 200 on valid product save', async () => {
    // Save route requires: SKU, name, description, images with URL, valid eBay category
    localMocks.spies.saveProductV2?.mockResolvedValue(SAMPLE_PRODUCT);
    localMocks.spies.findEbayCategory?.mockReturnValue({ id: '12345', breadcrumb: 'Baby > Hochstühle > Kombihochstühle' });
    const validProduct = {
      ...SAMPLE_PRODUCT,
      details: {
        ...SAMPLE_PRODUCT.details,
        short_description: 'Ein toller Hochstuhl für Babys',
        categoryId: '12345',
        images: [{ url: 'https://example.com/img.jpg' }],
      },
    };
    const res = await request(app)
      .post('/api/save')
      .send(validProduct);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/me/permissions', () => {
  beforeEach(() => {
    localMocks.spies.resolvePermissionsForUser?.mockReset();
  });

  it('returns 200 with permissions in data envelope', async () => {
    localMocks.spies.resolvePermissionsForUser?.mockResolvedValue({
      roles: ['admin'],
      permissions: { products: { read: true, write: true } },
      profile: { uid: 'test-uid-001', email: 'admin@trendocean.de', roles: ['admin'], groupIds: [] },
    });
    const res = await request(app).get('/api/me/permissions');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
  });

  it('returns 200 with fallback when resolvePermissionsForUser throws', async () => {
    localMocks.spies.resolvePermissionsForUser?.mockRejectedValue(new Error('RBAC unavailable'));
    const res = await request(app).get('/api/me/permissions');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/v1/products/duplicates', () => {
  beforeEach(() => {
    localMocks.spies.findDuplicates?.mockReset();
  });

  it('returns 200 with empty duplicates array', async () => {
    localMocks.spies.findDuplicates?.mockResolvedValue([]);
    const res = await request(app).get('/api/v1/products/duplicates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 200 with duplicate groups', async () => {
    localMocks.spies.findDuplicates?.mockResolvedValue([[SAMPLE_PRODUCT, { ...SAMPLE_PRODUCT, id: 'other-id' }]]);
    const res = await request(app).get('/api/v1/products/duplicates');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

describe('GET /api/v1/pricing/rules', () => {
  beforeEach(() => {
    localMocks.spies.listPricingRules?.mockReset();
  });

  it('returns 200 with pricing rules array', async () => {
    localMocks.spies.listPricingRules?.mockResolvedValue([]);
    const res = await request(app).get('/api/v1/pricing/rules');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/v1/forecast/:productId', () => {
  beforeEach(() => {
    localMocks.spies.calculateSalesVelocity?.mockReset();
    localMocks.spies.predictStockOut?.mockReset();
  });

  it('returns 200 with forecast data', async () => {
    localMocks.spies.calculateSalesVelocity?.mockResolvedValue({ salesVelocity: 2.5, unitsSold: 75 });
    localMocks.spies.predictStockOut?.mockResolvedValue({ predictedStockOut: '2024-06-01', daysUntilStockOut: 30 });
    const res = await request(app).get('/api/v1/forecast/SKU-0362404564');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /api/inventories', () => {
  beforeEach(() => {
    firebaseSpies.listInventories?.mockReset();
  });

  it('returns 200 with inventories array', async () => {
    firebaseSpies.listInventories?.mockResolvedValue([SAMPLE_INVENTORY]);
    const res = await request(app).get('/api/inventories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 200 with empty array', async () => {
    firebaseSpies.listInventories?.mockResolvedValue([]);
    const res = await request(app).get('/api/inventories');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/inventories/:id', () => {
  beforeEach(() => {
    firebaseSpies.getInventoryRecord?.mockReset();
  });

  it('returns 200 with inventory data', async () => {
    firebaseSpies.getInventoryRecord?.mockResolvedValue(SAMPLE_INVENTORY);
    const res = await request(app).get('/api/inventories/inv-001');
    expect(res.status).toBe(200);
    expect(res.body.data.inventoryId).toBe('inv-001');
  });

  it('returns 404 when inventory not found', async () => {
    firebaseSpies.getInventoryRecord?.mockResolvedValue(null);
    const res = await request(app).get('/api/inventories/nonexistent');
    expect(res.status).toBe(404);
  });
});
