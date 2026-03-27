# Weight Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every product in an order has a realistic weight — no fallbacks, no guessing. Missing weight is visible and manually correctable.

**Architecture:** Fix the weight key fragmentation in the frontend read path, add a product weight lookup helper to `product-store.js`, enrich order items with product weights during eBay/Kaufland intake, remove the 0.5kg fallback from the shipping engine, upgrade the backfill script with Gemini image analysis, and show per-item weights in the order detail UI.

**Tech Stack:** Node.js/Express (CJS), React/TypeScript, Firestore, Google Gemini API, Vitest

**Spec:** `docs/features/weight-reliability/spec.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `backend/lib/product-store.js` | Modify | Add `getProductWeightBySku()` helper |
| `backend/services/shipping-engine.js` | Modify | Remove 0.5kg fallback, return null, block shipping |
| `backend/services/order-intake-ebay.js` | Modify | Enrich items with product weight before save |
| `backend/services/order-intake-kaufland.js` | Modify | Enrich items with product weight before save |
| `backend/scripts/backfill-weight-enrichment.js` | Modify | Add image support for Gemini estimation |
| `components/ProductSheet.tsx` | Modify | Fix weight read with fallback chain |
| `components/OrderDetail.tsx` | Modify | Show per-item weight in Positionen tab |
| `backend/__tests__/weight-order-enrichment.test.js` | Create | Tests for weight lookup + order enrichment + shipping engine |

---

### Task 1: Product Weight Lookup Helper

**Files:**
- Modify: `backend/lib/product-store.js:86-94`
- Create: `backend/__tests__/weight-order-enrichment.test.js`

- [ ] **Step 1: Write failing tests for `getProductWeightBySku()`**

Create test file with CJS mocking pattern:

```javascript
// backend/__tests__/weight-order-enrichment.test.js

// ─── Patch GCP before anything else ────────────────────────────────────────
require('./api/_patchGcp');

const { vi } = require('vitest');

// ─── Stub firestore with controllable query mock ───────────────────────────
const mockGet = vi.fn();
const mockLimit = vi.fn(() => ({ get: mockGet }));
const mockWhere = vi.fn(() => ({ where: mockWhere, limit: mockLimit }));
const mockCollection = vi.fn(() => ({ where: mockWhere }));
const mockFirestore = { collection: mockCollection };

// Patch product-store's dependency on firestore
const path = require('path');
const firestorePath = require.resolve('../lib/firestore');
require.cache[firestorePath] = {
  id: firestorePath, filename: firestorePath, loaded: true,
  exports: {
    firestore: mockFirestore,
    saveProduct: vi.fn(),
    PRODUCTS_COLLECTION: 'products',
  },
  children: [], paths: [],
};

// Stub product-canonical (required by product-store)
const canonPath = require.resolve('../lib/product-canonical');
require.cache[canonPath] = {
  id: canonPath, filename: canonPath, loaded: true,
  exports: { normalizeProduct: vi.fn(p => p), validateCanonical: vi.fn(() => ({ valid: true })) },
  children: [], paths: [],
};

// NOW load product-store
const { getProductWeightBySku } = require('../lib/product-store');

describe('getProductWeightBySku', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ empty: true, docs: [] });
  });

  it('returns weight when product found by SKU', async () => {
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p1', data: () => ({ details: { weight: 3.6 } }) }],
    });

    const result = await getProductWeightBySku('SKU-123', 'EAN-456');
    expect(result).toBe(3.6);
    expect(mockWhere).toHaveBeenCalledWith('identification.sku', '==', 'SKU-123');
  });

  it('falls back to EAN when SKU not found', async () => {
    // First call (SKU) returns empty
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    // Second call (EAN via identification.barcodes) returns match
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p2', data: () => ({ details: { weight: 1.2 } }) }],
    });

    const result = await getProductWeightBySku(null, 'EAN-456');
    expect(result).toBe(1.2);
  });

  it('returns null when no product found', async () => {
    const result = await getProductWeightBySku('SKU-999', null);
    expect(result).toBeNull();
  });

  it('returns null when product has no weight', async () => {
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p3', data: () => ({ details: {} }) }],
    });

    const result = await getProductWeightBySku('SKU-123', null);
    expect(result).toBeNull();
  });

  it('returns null when both sku and ean are empty', async () => {
    const result = await getProductWeightBySku(null, null);
    expect(result).toBeNull();
  });

  it('tries details.attributes.weight as fallback', async () => {
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p4', data: () => ({ details: { attributes: { weight: 2.5 } } }) }],
    });

    const result = await getProductWeightBySku('SKU-123', null);
    expect(result).toBe(2.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run __tests__/weight-order-enrichment.test.js`
Expected: FAIL — `getProductWeightBySku is not a function`

- [ ] **Step 3: Implement `getProductWeightBySku()` in product-store.js**

Add before `module.exports` in `backend/lib/product-store.js`:

```javascript
/**
 * Lookup product weight by SKU or EAN.
 * Returns weight in kg (number) or null if not found / no weight.
 *
 * @param {string|null} sku
 * @param {string|null} ean
 * @returns {Promise<number|null>}
 */
async function getProductWeightBySku(sku, ean) {
  if (!sku && !ean) return null;

  const col = firestore.collection(getCollection());
  let product = null;

  // 1. Try SKU
  if (sku) {
    const snap = await col.where('identification.sku', '==', sku).limit(1).get();
    if (!snap.empty) product = snap.docs[0].data();
  }

  // 2. Fallback: EAN via identification.barcodes
  if (!product && ean) {
    const snap = await col.where('identification.barcodes', 'array-contains', ean).limit(1).get();
    if (!snap.empty) product = snap.docs[0].data();
  }

  if (!product) return null;

  // Extract weight with fallback chain
  const w = product.details?.weight
    ?? product.details?.attributes?.weight
    ?? product.details?.attributes?.['Gewicht (kg)']
    ?? product.details?.attributes?.['Gewicht']
    ?? null;

  return (typeof w === 'number' && w > 0) ? w : null;
}
```

Add to `module.exports`:

```javascript
module.exports = {
  saveProductV2,
  getProductV2,
  getAllProductsV2,
  getProductWeightBySku,
  getCollection,
  COLLECTION,
  V2_COLLECTION,
  USE_V2,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run __tests__/weight-order-enrichment.test.js`
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/lib/product-store.js backend/__tests__/weight-order-enrichment.test.js
git commit -m "feat: add getProductWeightBySku() helper for order weight enrichment"
```

---

### Task 2: Remove 0.5kg Fallback from Shipping Engine

**Files:**
- Modify: `backend/services/shipping-engine.js:408-424,491-492`
- Modify: `backend/__tests__/weight-order-enrichment.test.js`

- [ ] **Step 1: Add failing tests for shipping engine weight changes**

Append to `backend/__tests__/weight-order-enrichment.test.js`:

```javascript
// ─── Shipping Engine: calculateOrderWeight ─────────────────────────────────

// Stub shipping-engine dependencies
const shippingEnginePath = require.resolve('../services/shipping-engine');
// We need to read the actual function, so we stub its dependencies instead
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: { createParcel: vi.fn(), getLabel: vi.fn() },
  children: [], paths: [],
};

// Stub order_settings access (shipping-engine uses getDb)
function stubModule(modPath, exports) {
  try {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = {
      id: resolved, filename: resolved, loaded: true,
      exports, children: [], paths: [],
    };
  } catch { /* skip */ }
}
stubModule('../lib/secret-values', { getSecretValue: vi.fn().mockResolvedValue('') });

// Load the module — calculateOrderWeight is not exported, so we test via shipOrder behavior
// Instead, we extract the function by reading the file
const shippingEngine = require('../services/shipping-engine');

describe('calculateOrderWeight (via shipping-engine)', () => {
  it('returns order.weight when set', () => {
    // calculateOrderWeight is internal, test via the exported interface
    // For now we test the behavior: shipOrder should fail when no weight
    expect(shippingEngine.calculateOrderWeight).toBeDefined();
  });
});
```

Actually, let me check if `calculateOrderWeight` is exported. If not, we test behavior through `shipOrder`.

**Alternative approach** — add tests inline to verify the behavior:

```javascript
describe('calculateOrderWeight', () => {
  // If calculateOrderWeight is not exported, test indirectly
  // For direct testing, we'll need to export it

  it('uses order-level weight when available', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    const result = calculateOrderWeight({ weight: 5.0, items: [] });
    expect(result).toBe(5.0);
  });

  it('sums item weights when order weight missing', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    const result = calculateOrderWeight({
      items: [
        { weight: 2.0, quantity: 2 },
        { weight: 1.5, quantity: 1 },
      ],
    });
    expect(result).toBe(5.5);
  });

  it('returns null when no weights available (no fallback)', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    const result = calculateOrderWeight({ items: [{ quantity: 1 }] });
    expect(result).toBeNull();
  });

  it('returns null for empty order', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    const result = calculateOrderWeight({});
    expect(result).toBeNull();
  });
});
```

NOTE: Before writing these tests, verify that `calculateOrderWeight` is exported. If not, add it to `module.exports` in shipping-engine.js.

- [ ] **Step 2: Check if `calculateOrderWeight` is exported and export it if needed**

Check `backend/services/shipping-engine.js` exports at the end of the file. If `calculateOrderWeight` is not exported, add it:

```javascript
module.exports = {
  // ... existing exports ...
  calculateOrderWeight,
};
```

- [ ] **Step 3: Run tests to verify they fail on the null case**

Run: `cd backend && npx vitest run __tests__/weight-order-enrichment.test.js`
Expected: The "returns null when no weights" test FAILS because current code returns 0.5

- [ ] **Step 4: Remove 0.5kg fallback in `calculateOrderWeight()`**

In `backend/services/shipping-engine.js`, replace lines 408-424:

```javascript
function calculateOrderWeight(order) {
  // 1. Order-level weight (manually set or enriched from products)
  const orderLevelWeight = parseFloat(order.weight || '0') || 0;
  if (orderLevelWeight > 0) return orderLevelWeight;

  // 2. Sum of item weights
  const items = order.items || [];
  let totalKg = 0;
  for (const item of items) {
    const w = parseFloat(item.weight || '0') || 0;
    totalKg += w * (item.quantity || 1);
  }
  if (totalKg > 0) return totalKg;

  // 3. No fallback — weight must be explicitly set
  return null;
}
```

- [ ] **Step 5: Update `shipOrder()` to handle null weight**

In `backend/services/shipping-engine.js`, replace lines 491-492:

```javascript
  // Calculate weight
  const orderWeight = weight || calculateOrderWeight(order);
  if (!orderWeight) {
    throw new Error(
      'Versand nicht moeglich: Bestellgewicht fehlt. Bitte Gewicht in den Bestelldetails eintragen.'
    );
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run __tests__/weight-order-enrichment.test.js`
Expected: All tests PASS

- [ ] **Step 7: Run full test suite**

Run: `cd backend && npm test`
Expected: All existing tests still pass (shipping engine tests may need adjustment if they relied on the 0.5 fallback)

- [ ] **Step 8: Commit**

```bash
git add backend/services/shipping-engine.js backend/__tests__/weight-order-enrichment.test.js
git commit -m "feat: remove 0.5kg weight fallback, require explicit weight for shipping"
```

---

### Task 3: Enrich Order Items with Product Weight (eBay)

**Files:**
- Modify: `backend/services/order-intake-ebay.js:407-441`
- Modify: `backend/__tests__/weight-order-enrichment.test.js`

- [ ] **Step 1: Add failing tests for eBay order weight enrichment**

Append to `backend/__tests__/weight-order-enrichment.test.js`:

```javascript
describe('eBay order intake — weight enrichment', () => {
  it('enriches items with product weight from SKU lookup', async () => {
    // Mock getProductWeightBySku to return weights
    const productStore = require('../lib/product-store');
    productStore.getProductWeightBySku = vi.fn()
      .mockResolvedValueOnce(3.6)  // first item
      .mockResolvedValueOnce(1.2); // second item

    const items = [
      { name: 'Wechselrichter', sku: 'SKU-001', ean: 'EAN-001', quantity: 1, priceBrutto: 160.18 },
      { name: 'Kabel', sku: 'SKU-002', ean: null, quantity: 2, priceBrutto: 9.99 },
    ];

    // Import the enrichment helper we'll create
    const { enrichOrderItemsWithWeight } = require('../services/order-intake-ebay');

    const result = await enrichOrderItemsWithWeight(items);
    expect(result.items[0].weight).toBe(3.6);
    expect(result.items[1].weight).toBe(1.2);
    expect(result.orderWeight).toBe(3.6 + 1.2 * 2); // 6.0
  });

  it('sets orderWeight to null when any item has no weight', async () => {
    const productStore = require('../lib/product-store');
    productStore.getProductWeightBySku = vi.fn()
      .mockResolvedValueOnce(3.6)
      .mockResolvedValueOnce(null); // no weight

    const items = [
      { name: 'Wechselrichter', sku: 'SKU-001', ean: 'EAN-001', quantity: 1, priceBrutto: 160.18 },
      { name: 'Unbekannt', sku: 'SKU-002', ean: null, quantity: 1, priceBrutto: 9.99 },
    ];

    const { enrichOrderItemsWithWeight } = require('../services/order-intake-ebay');

    const result = await enrichOrderItemsWithWeight(items);
    expect(result.items[0].weight).toBe(3.6);
    expect(result.items[1].weight).toBeUndefined();
    expect(result.orderWeight).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run __tests__/weight-order-enrichment.test.js`
Expected: FAIL — `enrichOrderItemsWithWeight is not a function`

- [ ] **Step 3: Implement `enrichOrderItemsWithWeight()` in order-intake-ebay.js**

Add to `backend/services/order-intake-ebay.js`, before `saveOrderIfNew()`:

```javascript
const { getProductWeightBySku } = require('../lib/product-store');

/**
 * Enrich order items with product weights from products_v2.
 * Returns enriched items + total order weight (null if any item has no weight).
 */
async function enrichOrderItemsWithWeight(items) {
  let allHaveWeight = true;
  const enriched = [];

  for (const item of items) {
    const weight = await getProductWeightBySku(item.sku || null, item.ean || null);
    if (weight) {
      enriched.push({ ...item, weight });
    } else {
      allHaveWeight = false;
      enriched.push(item);
    }
  }

  const orderWeight = allHaveWeight
    ? enriched.reduce((sum, item) => sum + (item.weight * (item.quantity || 1)), 0)
    : null;

  return { items: enriched, orderWeight };
}
```

- [ ] **Step 4: Integrate into `saveOrderIfNew()`**

In `backend/services/order-intake-ebay.js`, in `saveOrderIfNew()` around line 404 (after `const seq = ...`, before `const doc = {`), add:

```javascript
  // Enrich items with product weights
  const { items: enrichedItems, orderWeight } = await enrichOrderItemsWithWeight(order.items);
```

Then in the `doc` object (~line 426), replace the items line:

```javascript
    items: enrichedItems.map((item, idx) => ({
      id: `${seq.formatted}-${idx + 1}`,
      ...item,
    })),
```

And add after `buyerNote`:

```javascript
    weight: orderWeight,
```

Export the helper for testing:

```javascript
module.exports = {
  // ... existing exports ...
  enrichOrderItemsWithWeight,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run __tests__/weight-order-enrichment.test.js`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite**

Run: `cd backend && npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add backend/services/order-intake-ebay.js backend/__tests__/weight-order-enrichment.test.js
git commit -m "feat: enrich eBay order items with product weight during import"
```

---

### Task 4: Enrich Order Items with Product Weight (Kaufland)

**Files:**
- Modify: `backend/services/order-intake-kaufland.js:461-494`

- [ ] **Step 1: Add the same enrichment to Kaufland intake**

In `backend/services/order-intake-kaufland.js`, add import at top:

```javascript
const { getProductWeightBySku } = require('../lib/product-store');
```

Add the same `enrichOrderItemsWithWeight()` function (copy from eBay intake — both need their own copy because they're independent modules):

```javascript
/**
 * Enrich order items with product weights from products_v2.
 * Returns enriched items + total order weight (null if any item has no weight).
 */
async function enrichOrderItemsWithWeight(items) {
  let allHaveWeight = true;
  const enriched = [];

  for (const item of items) {
    const weight = await getProductWeightBySku(item.sku || null, item.ean || null);
    if (weight) {
      enriched.push({ ...item, weight });
    } else {
      allHaveWeight = false;
      enriched.push(item);
    }
  }

  const orderWeight = allHaveWeight
    ? enriched.reduce((sum, item) => sum + (item.weight * (item.quantity || 1)), 0)
    : null;

  return { items: enriched, orderWeight };
}
```

- [ ] **Step 2: Integrate into Kaufland `saveOrderIfNew()`**

In `saveOrderIfNew()`, after the sequence number generation and before the `doc` object construction (~line 460), add:

```javascript
  // Enrich items with product weights
  const { items: enrichedItems, orderWeight } = await enrichOrderItemsWithWeight(order.items);
```

In the `doc` object (~line 479), replace items:

```javascript
    items: enrichedItems.map((item, idx) => ({
      id: `${seq.formatted}-${idx + 1}`,
      ...item,
    })),
```

Add after `buyerNote`:

```javascript
    weight: orderWeight,
```

- [ ] **Step 3: Run full test suite**

Run: `cd backend && npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/services/order-intake-kaufland.js
git commit -m "feat: enrich Kaufland order items with product weight during import"
```

---

### Task 5: Fix ProductSheet Weight Display

**Files:**
- Modify: `components/ProductSheet.tsx:1437-1449`

- [ ] **Step 1: Fix the weight read path with fallback chain**

In `components/ProductSheet.tsx`, find the Gewicht field section (~line 1437-1449).

Replace the entire `<div>` block:

```tsx
<div>
  <label className="block text-xs font-semibold text-txt-secondary mb-1">Gewicht (kg)</label>
  {(() => {
    const weightValue =
      localProduct.details?.weight
      ?? localProduct.details?.attributes?.weight
      ?? localProduct.details?.attributes?.['Gewicht (kg)']
      ?? localProduct.details?.attributes?.['Gewicht']
      ?? '';
    const displayWeight = weightValue !== '' ? `${weightValue} kg` : '—';

    return isEditing ? (
      <input
        type="number"
        step="0.01"
        value={weightValue}
        onChange={(e) => handleFieldChange('details.weight', e.target.value ? parseFloat(e.target.value) : null)}
        placeholder="z.B. 2.5"
        className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-2 outline-none focus:border-accent font-mono"
      />
    ) : (
      <p className="text-sm text-txt-primary font-mono">{displayWeight}</p>
    );
  })()}
</div>
```

Key change: Write path now uses `details.weight` (the canonical field) instead of `details.attributes.Gewicht`. This ensures `enforceEbayAspects()` normalizes it correctly when saved via `saveProductV2()`.

- [ ] **Step 2: Verify in browser**

Open a product with weight in attributes but "—" in Stammdaten tab (like the LVYUAN Wechselrichter from the screenshots). Verify:
- Stammdaten tab now shows "3.6 kg" instead of "—"
- Editing and saving works correctly

- [ ] **Step 3: Commit**

```bash
git add components/ProductSheet.tsx
git commit -m "fix: ProductSheet weight display uses fallback chain across all weight keys"
```

---

### Task 6: Show Per-Item Weight in Order Detail

**Files:**
- Modify: `components/OrderDetail.tsx:709-730`

- [ ] **Step 1: Add weight display to each order item**

In `components/OrderDetail.tsx`, find the items rendering section (~line 709-730). In the item card, add a weight indicator after the SKU/EAN line and before the pickHint section.

Replace lines 716-719 (the SKU/EAN metadata div):

```tsx
                        <div className="flex items-center gap-3 mt-1 text-xs text-txt-muted">
                          {item.sku && <span>SKU: {item.sku}</span>}
                          {item.ean && <span>EAN: {item.ean}</span>}
                          {item.weight
                            ? <span>{item.weight} kg</span>
                            : <span className="text-warning">Gewicht fehlt</span>
                          }
                        </div>
```

- [ ] **Step 2: Verify in browser**

Open an order with items. Verify:
- Items with weight show "X.X kg" in the metadata line
- Items without weight show "Gewicht fehlt" in warning color

- [ ] **Step 3: Commit**

```bash
git add components/OrderDetail.tsx
git commit -m "feat: show per-item weight in order detail Positionen tab"
```

---

### Task 7: Upgrade Backfill Script with Image Support

**Files:**
- Modify: `backend/scripts/backfill-weight-enrichment.js:160-224`

- [ ] **Step 1: Add image fetching utility**

In `backend/scripts/backfill-weight-enrichment.js`, add after the existing requires at the top:

```javascript
const https = require('https');
const http = require('http');

/**
 * Fetch image from URL and return as base64.
 * Returns null on any error (timeout, 404, etc).
 */
function fetchImageAsBase64(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 100) { resolve(null); return; } // too small, probably error
        resolve(buf.toString('base64'));
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
```

- [ ] **Step 2: Update `buildWeightPrompt()` to return parts array with image**

Replace `buildWeightPrompt()` (lines 160-192) with a new function that returns a Gemini contents array:

```javascript
async function buildWeightParts(product) {
  const title = product?.identification?.name || '';
  const brand = product?.identification?.brand || '';
  const category = product?.details?.categoryPath || product?.details?.categoryId || product?.identification?.category || '';
  const ean = product?.details?.identifiers?.ean || product?.details?.identifiers?.gtin || (Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes[0] : '') || '';
  const desc = (product?.details?.short_description || product?.details?.description || '').replace(/<[^>]*>/g, '').slice(0, 500);
  const keyFeatures = Array.isArray(product?.details?.key_features) ? product.details.key_features.join('; ') : '';
  const attrs = product?.details?.attributes || {};
  const dimensions = attrs.dimensions || attrs.Abmessungen || attrs['Maße'] || attrs['Produktmaße'] || '';
  const material = attrs.material || attrs.Material || '';
  const produktart = attrs.Produktart || '';

  const parts = [];

  // Try to include first product image
  const images = product?.details?.images || [];
  if (images.length > 0) {
    const base64 = await fetchImageAsBase64(images[0]);
    if (base64) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64,
        },
      });
    }
  }

  parts.push({
    text: `Du bist ein erfahrener Lagerarbeiter und Produktexperte. Schaetze das Gewicht des folgenden Produkts in Kilogramm.

Produktdaten:
- Titel: ${title}
- Marke: ${brand}
- Kategorie: ${category}
- Produktart: ${produktart}
- EAN: ${ean}
- Material: ${material}
- Abmessungen: ${dimensions}
- Key Features: ${keyFeatures}
- Beschreibung: ${desc}

REGELN:
1. Gib das Gewicht in kg zurueck (z.B. 0.35 fuer 350g, 3.6 fuer 3600g)
2. Sei realistisch: Ein Handy wiegt ~0.2kg, ein Wechselrichter ~3-5kg, ein Grill ~20-40kg
3. Wenn das Produktbild vorhanden ist, nutze es zur Einschaetzung der Groesse und des Materials
4. Wenn du dir unsicher bist, schaetze konservativ (eher leichter)
5. Gewicht muss > 0 und realistisch sein (Minimum 0.01 kg)
6. Runde auf 2 Dezimalstellen
7. Gib an, wie sicher du dir bist (high/medium/low)`,
  });

  return parts;
}
```

- [ ] **Step 3: Update the Gemini call to use parts**

Find the section where `buildWeightPrompt` is called and the Gemini call is made (~lines 219-224). Replace:

```javascript
    const parts = await buildWeightParts(product);
    const parsed = await gemini3GenerateJSON({
      prompt: parts,
      schema: WEIGHT_RESPONSE_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 2048,
    });
```

- [ ] **Step 4: Test manually with dry-run**

Run: `cd backend && node scripts/backfill-weight-enrichment.js --limit 3 --debug`
Expected: Script processes 3 products, shows image fetch status, Gemini responses include reasoning based on image when available.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/backfill-weight-enrichment.js
git commit -m "feat: backfill script uses product images for Gemini weight estimation"
```

---

### Task 8: Final Integration Test & Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full backend test suite**

Run: `cd backend && npm test`
Expected: All tests pass (should be 119+ existing + new weight tests)

- [ ] **Step 2: Run frontend build**

Run: `npx vite build`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 3: Verify complete data flow manually**

Checklist:
1. Open a product with weight in attributes → Stammdaten should show weight
2. Open an order → Positionen tab shows weight per item (or "Gewicht fehlt")
3. Try to ship an order without weight → error message appears
4. Order detail "Gewicht" field → editable inline as before

- [ ] **Step 4: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: integration fixes for weight reliability feature"
```
