// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// PRODUCT_GHOST_GATE — prevention gate that stops NEW ghost docs from being
// created in products_v2, WITHOUT ever blocking legitimate saves or any UPDATE
// to an existing in-progress product.
//
// Root cause of ~1084 ghost products: validateCanonical() already DETECTS ghost
// signatures (placeholder names, UUID/`prod-` ids with a barcode), but
// saveProductV2() only LOGS them — it never blocks the write. This gate adds an
// opt-in (default OFF) block for the narrow case of a brand-new, content-less,
// order-less, listing-less ghost doc.
//
// Mocking: require.cache patching for CJS (vi.mock does not intercept CJS
// require() in Vitest 4.x). We patch ../lib/firestore to provide a controllable
// firestore (collection().doc().get/set + product_schema_violations.add) plus a
// saveProduct() spy and PRODUCTS_COLLECTION='products_v2' (prod direct-write
// path). product-store.js re-requires { PRODUCTS_COLLECTION } inside
// saveProductV2(), so it reads from the same patched module.

const firestorePath = require.resolve('../lib/firestore');
const productStorePath = require.resolve('../lib/product-store');

// ─── Controllable in-memory Firestore ────────────────────────────────────────
// docs: Map<`${collection}/${id}`, data>. get() reports exists from the map.
const docs = new Map();
const violationAddMock = vi.fn().mockResolvedValue();
const saveProductMock = vi.fn(async (product) => ({ id: product?.id, ...product }));

function docKey(collection, id) {
  return `${collection}/${id}`;
}

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'product_schema_violations') {
      return { add: violationAddMock };
    }
    return {
      doc: vi.fn((id) => ({
        get: vi.fn(async () => {
          const key = docKey(name, id);
          const exists = docs.has(key);
          return {
            exists,
            data: () => (exists ? docs.get(key) : undefined),
          };
        }),
        set: vi.fn(async (data, opts) => {
          const key = docKey(name, id);
          const prev = docs.get(key) || {};
          docs.set(key, opts && opts.merge ? { ...prev, ...data } : data);
        }),
      })),
    };
  }),
};

require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    firestore: mockFirestore,
    saveProduct: saveProductMock,
    PRODUCTS_COLLECTION: 'products_v2',
  },
  children: [],
  paths: [],
};

// Force product-store.js to re-evaluate against the patched firestore. It
// also reads USE_PRODUCTS_V2 at module-load → set true so the prod-direct path
// (schema-validate branch) is reachable.
const ORIGINAL_ENV = {
  USE_PRODUCTS_V2: process.env.USE_PRODUCTS_V2,
  PRODUCT_GHOST_GATE: process.env.PRODUCT_GHOST_GATE,
  PRODUCT_SCHEMA_VALIDATE: process.env.PRODUCT_SCHEMA_VALIDATE,
  PRODUCT_SCHEMA_VALIDATE_RATE: process.env.PRODUCT_SCHEMA_VALIDATE_RATE,
};
process.env.USE_PRODUCTS_V2 = 'true';
delete require.cache[productStorePath];
const { saveProductV2 } = require(productStorePath);

// ─── Fixtures ─────────────────────────────────────────────────────────────────
function ghostProduct(overrides = {}) {
  // UUID id + placeholder name + no content + no barcode → ghost signature.
  return {
    id: '11111111-2222-4333-8444-555555555555',
    identification: {
      name: 'Unbekanntes Produkt',
      brand: 'Unbekannt',
      category: 'Unbekannt',
    },
    details: {},
    ...overrides,
  };
}

function realProduct(overrides = {}) {
  return {
    id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
    identification: {
      name: 'Bosch Professional GSR 18V-55 Akkuschrauber',
      brand: 'Bosch',
      category: 'Akkuschrauber',
    },
    details: {
      short_description: 'Kompakter 18V Akku-Bohrschrauber mit bürstenlosem Motor.',
    },
    ...overrides,
  };
}

function resetEnvFlags() {
  delete process.env.PRODUCT_GHOST_GATE;
  delete process.env.PRODUCT_SCHEMA_VALIDATE;
  delete process.env.PRODUCT_SCHEMA_VALIDATE_RATE;
}

beforeEach(() => {
  docs.clear();
  violationAddMock.mockClear();
  saveProductMock.mockClear();
  mockFirestore.collection.mockClear();
  resetEnvFlags();
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('PRODUCT_GHOST_GATE', () => {
  it('(i) flag OFF → a ghost NEW doc still saves (today behavior, regression guard)', async () => {
    // flag unset by beforeEach → OFF
    const product = ghostProduct();

    const result = await saveProductV2(product, { source: 'test' });

    // Underlying saveProduct ran exactly once → write happened
    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
  });

  it('(ii) flag ON + NEW ghost doc → throws PRODUCT_GHOST_REJECTED and does NOT write the product', async () => {
    process.env.PRODUCT_GHOST_GATE = 'true';
    const product = ghostProduct();

    let thrown = null;
    try {
      await saveProductV2(product, { source: 'identify-v4' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('PRODUCT_GHOST_REJECTED');
    expect(thrown).toBeInstanceOf(Error);
    // Structured error fields for the upstream identify/improve retry path
    expect(thrown.productId).toBe(product.id);
    expect(Array.isArray(thrown.validationErrors)).toBe(true);
    expect(thrown.validationErrors.length).toBeGreaterThan(0);

    // The product MUST NOT have been written
    expect(saveProductMock).not.toHaveBeenCalled();

    // Telemetry still recorded
    expect(violationAddMock).toHaveBeenCalledTimes(1);
    const violation = violationAddMock.mock.calls[0][0];
    expect(violation).toMatchObject({ productId: product.id });
    expect(violation.blocked).toBe(true);
  });

  it('(iii) flag ON + UPDATE to an existing (currently ghosty) doc → still saves, NO block', async () => {
    process.env.PRODUCT_GHOST_GATE = 'true';
    const product = ghostProduct();
    // Pre-seed: doc already exists in products_v2 → this is an UPDATE, not a NEW doc.
    docs.set(docKey('products_v2', product.id), { identification: { name: 'Unbekannt' } });

    const result = await saveProductV2(product, { source: 'improve' });

    // Enrichment of in-progress product must always go through
    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
  });

  it('(iv) flag ON + NEW doc with real content (real title/brand) → saves normally', async () => {
    process.env.PRODUCT_GHOST_GATE = 'true';
    const product = realProduct();

    const result = await saveProductV2(product, { source: 'identify-v4' });

    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
  });

  it('(v) flag ON + NEW ghost-named doc that HAS marketplace listings → saves (protected)', async () => {
    process.env.PRODUCT_GHOST_GATE = 'true';
    // Ghost name + UUID id, but has an eBay listing id → protected, must not be blocked.
    const product = ghostProduct({
      ops: { ebay: { itemId: '123456789012' } },
    });

    const result = await saveProductV2(product, { source: 'sync' });

    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
  });

  it('(v-b) flag ON + NEW ghost-named doc that HAS orders metadata → saves (protected)', async () => {
    process.env.PRODUCT_GHOST_GATE = 'true';
    const product = ghostProduct({ ops: { order_count: 3 } });

    const result = await saveProductV2(product, { source: 'sync' });

    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
  });

  // ── Echte Produktions-Formen (Incident 2026-03-23: 206 leere Hüllen) ────────
  // Alle drei Formen haben identification.name === '' (leerer String, kein
  // Platzhalter-Wort) — genau die Signatur, die im März 2026 durch die
  // Dual-Write-Bugs (BUG-084/085) entstand.
  function emptyShell(id) {
    return {
      id,
      identification: { name: '', category: '', sku: 'SKU-1341452362' },
      details: {
        identifiers: { sku: 'SKU-1341452362' },
        short_description: '',
        description: '',
        attributes: {},
        images: [],
        key_features: [],
      },
      inventory: { quantity: 0 },
      tenantId: 'default',
    };
  }

  it.each([
    ['UUID-Doc-ID', 'fab309b3-784b-4e9a-861b-a53eca92313d'],
    ['nackte EAN als Doc-ID', '0019451391762'],
    ['SKU als Doc-ID', 'SKU-0058749943'],
  ])('(vii) flag ON + NEUE leere Hülle (%s) → PRODUCT_GHOST_REJECTED', async (_label, id) => {
    process.env.PRODUCT_GHOST_GATE = 'true';

    let thrown = null;
    try {
      await saveProductV2(emptyShell(id), { source: 'test-incident-2026-03-23' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown?.code).toBe('PRODUCT_GHOST_REJECTED');
    expect(saveProductMock).not.toHaveBeenCalled();
  });

  it('(viii) flag ON + skipStockEvent + NEUE leere Hülle → trotzdem geblockt (Bypass geschlossen)', async () => {
    // Bulk-Pfade (skipStockEvent:true) haben den Gate früher komplett umgangen.
    process.env.PRODUCT_GHOST_GATE = 'true';

    let thrown = null;
    try {
      await saveProductV2(emptyShell('11111111-2222-4333-8444-555555555555'), {
        source: 'bulk-import',
        skipStockEvent: true,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown?.code).toBe('PRODUCT_GHOST_REJECTED');
    expect(saveProductMock).not.toHaveBeenCalled();
  });

  it('(viii-b) flag ON + skipStockEvent + UPDATE eines existierenden Docs → speichert (kein Block)', async () => {
    process.env.PRODUCT_GHOST_GATE = 'true';
    const product = emptyShell('22222222-3333-4444-8555-777777777777');
    docs.set(docKey('products_v2', product.id), { identification: { name: '' } });

    const result = await saveProductV2(product, { source: 'gmbh-cutover-reset', skipStockEvent: true });

    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
  });

  it('(viii-c) flag OFF + skipStockEvent → kein Existenz-Read, kein Block (Verhalten wie heute)', async () => {
    const product = emptyShell('33333333-4444-4555-8666-888888888888');

    const result = await saveProductV2(product, { source: 'bulk-import', skipStockEvent: true });

    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
    // Flag aus + skipStockEvent → kein Existenz-Read VOR dem Save
    // (Bulk-Performance-Garantie bleibt erhalten). Der erste products_v2-Zugriff
    // darf frühestens durch saveProduct()/Post-Save-Validierung passieren.
    const preSaveCalls = mockFirestore.collection.mock.invocationCallOrder
      .filter((order) => order < saveProductMock.mock.invocationCallOrder[0]);
    expect(preSaveCalls).toHaveLength(0);
  });

  it('(vi) flag ON but NOT a ghost (UUID id, NO barcode, placeholder brand only but REAL name) → saves', async () => {
    // Guard: a doc with a real name but placeholder brand/category is NOT a ghost
    // per the "has real content" check → must not be blocked.
    process.env.PRODUCT_GHOST_GATE = 'true';
    const product = {
      id: '22222222-3333-4444-8555-666666666666',
      identification: { name: 'Real Working Title Here', brand: 'Unbekannt', category: 'Unbekannt' },
      details: {},
    };

    const result = await saveProductV2(product, { source: 'identify-v4' });

    expect(saveProductMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: product.id });
  });
});
