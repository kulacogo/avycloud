/* eslint-disable no-console */
/**
 * Apply manual BaseLinker ID overrides to specific product docs + sku index entries.
 *
 * This is used to resolve conflicts where the BaseLinker export (or old data)
 * doesn't match the known-correct BaseLinker product IDs.
 *
 * Safety:
 * - Only touches ops linkage fields + baselinker_sku_index.
 * - Does NOT touch storage/storageBins/inventory/warehouse collections.
 *
 * Usage:
 *   node backend/scripts/apply-baselinker-id-overrides.js          # dry-run
 *   node backend/scripts/apply-baselinker-id-overrides.js --apply  # write
 */

const { firestore, setSkuIndexEntry } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s_]*/i, '')
    .replace(/\s+/g, '');

const normalizeEanValue = (val) =>
  (val || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();

const buildSkuIndexKey = (type, value) => (value ? `${type}:${value}` : null);

async function updateSkuIndexForProduct({ productId, baseProductId }) {
  const productSnap = await firestore.collection('products').doc(productId).get();
  if (!productSnap.exists) {
    throw new Error(`Product not found: ${productId}`);
  }
  const product = productSnap.data() || {};
  const skuFull =
    product?.identification?.sku || product?.details?.identifiers?.sku || productId;

  const normalizedSku = normalizeSkuValue(skuFull);
  const skuKey = buildSkuIndexKey('sku', normalizedSku);
  if (!skuKey) return { updated: 0 };

  // Prefer existing sku index EAN to avoid accidentally rewriting it
  const skuIndexSnap = await firestore.collection('baselinker_sku_index').doc(skuKey).get();
  const existingSkuIndex = skuIndexSnap.exists ? skuIndexSnap.data() || {} : {};

  const eanValue =
    existingSkuIndex?.ean ||
    product?.details?.identifiers?.ean ||
    product?.details?.identifiers?.gtin ||
    product?.details?.identifiers?.upc ||
    null;
  const normalizedEan = normalizeEanValue(eanValue);
  const eanKey = normalizedEan ? buildSkuIndexKey('ean', normalizedEan) : null;

  const payload = {
    baseProductId,
    productId,
    sku: skuFull || null,
    ean: normalizedEan || null,
    updatedAt: new Date().toISOString(),
  };

  let updated = 0;
  if (APPLY) {
    await setSkuIndexEntry(skuKey, payload);
    updated += 1;
    if (eanKey) {
      await setSkuIndexEntry(eanKey, payload);
      updated += 1;
    }
  }
  return { updated, skuKey, eanKey };
}

async function updateProductBaselinker({ productId, baseProductId }) {
  const docRef = firestore.collection('products').doc(productId);
  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error(`Product not found: ${productId}`);
  }
  const data = snap.data() || {};
  const prevBase = data?.ops?.base_product_id ?? null;
  const prevBl = data?.ops?.baselinker?.product_id ?? null;

  const updateData = {
    'ops.base_product_id': baseProductId,
    'ops.baselinker.product_id': baseProductId,
    'ops.baselinker_override': {
      applied_at_iso: new Date().toISOString(),
      base_product_id_prev: prevBase ?? null,
      baselinker_product_id_prev: prevBl ?? null,
    },
  };

  if (APPLY) {
    await docRef.update(updateData);
  }

  return { prevBase, prevBl, updateKeys: Object.keys(updateData) };
}

async function main() {
  // User-provided correct BaseLinker IDs
  const overrides = [
    { productId: 'SKU-6603765179', baseProductId: 449822072 },
    { productId: 'SKU-2633108165', baseProductId: 465090922 },
    { productId: 'SKU-0403766178', baseProductId: 458470419 },
    { productId: 'SKU-0000524938', baseProductId: 462089163 },
  ];

  const report = {
    apply: APPLY,
    processed: 0,
    productUpdates: [],
    skuIndexUpdates: [],
    errors: [],
  };

  for (const o of overrides) {
    report.processed += 1;
    try {
      const productResult = await updateProductBaselinker(o);
      const skuIndexResult = await updateSkuIndexForProduct(o);
      report.productUpdates.push({ ...o, ...productResult });
      report.skuIndexUpdates.push({ ...o, ...skuIndexResult });
      console.log('[ok]', o.productId, '->', o.baseProductId);
    } catch (err) {
      console.error('[error]', o.productId, err?.message || err);
      report.errors.push({ productId: o.productId, message: err?.message || String(err) });
    }
  }

  console.log('Overrides finished:', JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Overrides failed:', err);
  process.exit(1);
});


