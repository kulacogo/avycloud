/* eslint-disable no-console */
/**
 * Apply manual eBay category overrides by SKU.
 *
 * Canonical category fields:
 * - details.categoryId (eBay category number as string)
 * - identification.category ("Kategorie" label; derived from categories.json breadcrumb)
 *
 * Safety:
 * - Only touches category fields + ops audit marker.
 * - Does NOT touch storage/storageBins/inventory.
 *
 * Usage:
 *   node backend/scripts/apply-category-overrides.js          # dry-run
 *   node backend/scripts/apply-category-overrides.js --apply  # write
 */

const { firestore } = require('../lib/firestore');
const { FieldValue } = require('@google-cloud/firestore');
const CATEGORIES = require('../ebay-data/categories.json');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

// User-provided category choices (by name), resolved to IDs via categories.json / DE_New_Structure CSV.
// NOTE: Add more overrides here as needed.
const overrides = [
  { sku: 'SKU-3988740005', categoryId: '260835', label: 'Leitungs- & Kabelverbinder' },
  { sku: 'SKU-1887574140', categoryId: '181383', label: 'Campinggeschirr' },
  { sku: 'SKU-2152217706', categoryId: '177008', label: 'Gewürzmühlen & -streuer' },
  { sku: 'SKU-5799111421', categoryId: '26219', label: 'Industrielle Beleuchtungen' },
  // Auto-picked (using official DE category tree + product type)
  { sku: 'SKU-7321712010', categoryId: '33665', label: 'Dichtungen & Dichtungsringe' }, // Motoren & Motorenteile branch
  { sku: 'SKU-3093460977', categoryId: '185033', label: 'Fritteusen' }, // consumer appliances (not gastro)
  { sku: 'SKU-5582443660', categoryId: '261186', label: 'Bücher' }, // general books (avoid DDR-only "Sachbücher")
];

const normalizeSku = (val) => (val == null ? '' : String(val)).trim();

async function buildSkuIndex() {
  const snap = await firestore.collection('products').get();
  const index = new Map();
  for (const doc of snap.docs) {
    const p = doc.data() || {};
    const sku = normalizeSku(p?.identification?.sku || p?.details?.identifiers?.sku);
    if (!sku) continue;
    // Keep the first occurrence; duplicates should be cleaned elsewhere.
    if (!index.has(sku)) index.set(sku, doc.ref);
  }
  return { total: snap.size, index };
}

async function applyOverride({ sku, categoryId, label }, skuIndex) {
  const docRef = skuIndex.get(sku);
  if (!docRef) {
    throw new Error(`SKU not found in products: ${sku}`);
  }

  const snap = await docRef.get();
  if (!snap.exists) {
    throw new Error(`Product doc missing for SKU ${sku}: ${docRef.path}`);
  }
  const data = snap.data() || {};
  const prevCategoryId = data?.details?.categoryId ?? data?.details?.ebayCategoryId ?? null;
  const prevCategoryLabel = data?.identification?.category ?? null;

  const breadcrumb = CATEGORIES?.[String(categoryId)]?.breadcrumb || null;
  if (!breadcrumb) {
    throw new Error(`categoryId not found in categories.json: ${categoryId} (sku=${sku}, label=${label})`);
  }

  const updateData = {
    'details.categoryId': String(categoryId),
    'identification.category': String(breadcrumb),

    // Delete legacy category fields
    'details.ebayCategoryId': FieldValue.delete(),
    'details.ebayCategoryBreadcrumb': FieldValue.delete(),
    'details.ebayCategoryPath': FieldValue.delete(),

    // Audit marker
    'ops.category_override': {
      applied_at_iso: new Date().toISOString(),
      sku,
      label: label || null,
      category_id_prev: prevCategoryId,
      category_label_prev: prevCategoryLabel,
      category_id: String(categoryId),
      category_label: String(breadcrumb),
    },
  };

  if (APPLY) {
    await docRef.update(updateData);
  }

  return { productId: snap.id, prevCategoryId, prevCategoryLabel, nextCategoryId: String(categoryId), nextCategoryLabel: String(breadcrumb) };
}

async function main() {
  const report = {
    apply: APPLY,
    scanned: 0,
    processed: 0,
    ok: [],
    errors: [],
  };

  const { total, index } = await buildSkuIndex();
  report.scanned = total;

  for (const o of overrides) {
    report.processed += 1;
    try {
      const res = await applyOverride(o, index);
      report.ok.push({ ...o, ...res });
      console.log('[ok]', o.sku, '->', o.categoryId, '/', o.label, '(productId:', res.productId + ')');
    } catch (err) {
      console.error('[error]', o.sku, err?.message || err);
      report.errors.push({ sku: o.sku, message: err?.message || String(err) });
    }
  }

  console.log('Category overrides finished:', JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Category overrides failed:', err);
  process.exit(1);
});


