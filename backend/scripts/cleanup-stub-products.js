/* eslint-disable no-console */
/**
 * Cleanup "stub" product documents that were accidentally created (typically by inventory refresh paths)
 * and contain only partial fields like inventory/storageBins.
 *
 * Safety:
 * - Dry-run by default.
 * - Will NOT delete a product if it is referenced by any warehouse bin entry or sku_index entry.
 *
 * Usage:
 *   node backend/scripts/cleanup-stub-products.js
 *
 * Options:
 *   --apply      Actually delete (default: dry-run)
 *
 * Outputs:
 *   exports/reconciliation/cleanup-stub-products-report.json
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

const productsCol = firestore.collection('products');
const binsCol = firestore.collection('warehouseBins');
const skuIndexCol = firestore.collection('sku_index');

const normalizeKey = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.toLowerCase() : null;
};

const isEmptyObject = (obj) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 0;

function isStubProduct(docId, data = {}) {
  const identification = data.identification || null;
  const details = data.details || null;
  const ops = data.ops || null;

  const hasIdentificationMeaningful =
    identification &&
    typeof identification === 'object' &&
    (Boolean(identification.sku) ||
      Boolean(identification.name) ||
      Boolean(identification.brand) ||
      Boolean(identification.category) ||
      (Array.isArray(identification.barcodes) && identification.barcodes.length > 0));

  const identifiers = details?.identifiers || details?.identifiers === null ? details.identifiers : null;
  const hasDetailsMeaningful =
    details &&
    typeof details === 'object' &&
    (Boolean(details.short_description) ||
      Boolean(details.description) ||
      (Array.isArray(details.images) && details.images.length > 0) ||
      (details.pricing && typeof details.pricing === 'object' && details.pricing.lowest_price) ||
      (identifiers &&
        typeof identifiers === 'object' &&
        (Boolean(identifiers.sku) || Boolean(identifiers.ean) || Boolean(identifiers.gtin) || Boolean(identifiers.upc))) ||
      (details.attributes && typeof details.attributes === 'object' && Object.keys(details.attributes).length > 0));

  const hasOpsMeaningful =
    ops &&
    typeof ops === 'object' &&
    (Boolean(ops.sync_status) ||
      Boolean(ops.last_saved_iso) ||
      Boolean(ops.last_synced_iso) ||
      Boolean(ops.base_product_id) ||
      Boolean(ops.identity_key) ||
      (Array.isArray(ops.identity_aliases) && ops.identity_aliases.length > 0));

  const inventoryQty = Number(data?.inventory?.quantity || 0);
  const hasInventoryQty = Number.isFinite(inventoryQty) && inventoryQty > 0;

  const hasStorage = Boolean(data.storage && data.storage.binCode);
  const storageBins = Array.isArray(data.storageBins) ? data.storageBins : [];
  const hasStorageBins = storageBins.some((b) => Number(b?.quantity || 0) > 0);

  // If it has any meaningful product data or any warehouse stock -> not a stub.
  if (hasIdentificationMeaningful || hasDetailsMeaningful || hasOpsMeaningful) return false;
  if (hasInventoryQty || hasStorage || hasStorageBins) return false;

  // Doc contains only a tiny set of fields (typical stub signature)
  const allowedKeys = new Set(['id', 'inventory', 'storage', 'storageBins', 'updatedAt', 'createdAt']);
  const keys = Object.keys(data || {});
  const hasOnlyAllowedKeys = keys.every((k) => allowedKeys.has(k));

  // Some stubs have only inventory + storageBins; accept those even if extra timestamps exist.
  if (!hasOnlyAllowedKeys && keys.length > 10) return false;

  // Also avoid deleting documents whose id field points elsewhere (shouldn't happen, but be safe)
  if (data.id && String(data.id).trim() && String(data.id).trim() !== String(docId).trim()) return false;

  // Ensure nested objects are not hiding content
  if (identification && !isEmptyObject(identification)) return false;
  if (details && !isEmptyObject(details)) return false;
  if (ops && !isEmptyObject(ops)) return false;

  return true;
}

async function buildReferences() {
  const binSnap = await binsCol.get();
  const referenced = new Set();
  binSnap.forEach((doc) => {
    const data = doc.data() || {};
    const list = Array.isArray(data.products) ? data.products : [];
    for (const item of list) {
      const pid = normalizeKey(item?.productId);
      const sku = normalizeKey(item?.sku);
      if (pid) referenced.add(pid);
      if (sku) referenced.add(sku);
    }
  });

  const skuSnap = await skuIndexCol.get();
  const skuIndexRefs = new Set();
  skuSnap.forEach((doc) => {
    const data = doc.data() || {};
    const pid = normalizeKey(data.productId);
    if (pid) skuIndexRefs.add(pid);
  });

  return { binRefs: referenced, skuIndexRefs };
}

async function main() {
  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });

  const { binRefs, skuIndexRefs } = await buildReferences();

  const snap = await productsCol.get();
  const candidates = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (isStubProduct(doc.id, data)) {
      candidates.push({
        docId: doc.id,
        keys: Object.keys(data),
        inventory: data.inventory || null,
        storageBins: data.storageBins || null,
      });
    }
  });

  const report = {
    apply: APPLY,
    scanned: snap.size,
    stubCandidates: candidates.length,
    deleted: 0,
    skippedReferenced: 0,
    skipped: 0,
    deletedIds: [],
    referencedIds: [],
  };

  for (const c of candidates) {
    const idKey = normalizeKey(c.docId);
    const isReferenced = (idKey && (binRefs.has(idKey) || skuIndexRefs.has(idKey))) || false;
    if (isReferenced) {
      report.skippedReferenced += 1;
      report.referencedIds.push(c.docId);
      continue;
    }
    if (APPLY) {
      await productsCol.doc(c.docId).delete();
      report.deleted += 1;
      report.deletedIds.push(c.docId);
    } else {
      report.skipped += 1;
    }
  }

  const outPath = path.join(outDir, 'cleanup-stub-products-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Cleanup stubs finished:', JSON.stringify(report, null, 2));
  console.log('Report written to:', outPath);
}

main().catch((err) => {
  console.error('Cleanup stubs failed:', err);
  process.exit(1);
});


