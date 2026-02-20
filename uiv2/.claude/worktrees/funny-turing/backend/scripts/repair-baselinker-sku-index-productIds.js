/* eslint-disable no-console */
/**
 * Repair baselinker_sku_index entries whose `productId` points to a missing/stub product document.
 *
 * Motivation:
 * - Historically, some code paths accidentally created stub product docs (only inventory/storageBins),
 *   and sku_index entries may have ended up pointing to those stub ids.
 * - This script retargets sku_index.productId to the best real product doc.
 *
 * Safety:
 * - Dry-run by default.
 * - Does NOT modify warehouse data.
 *
 * Usage:
 *   node backend/scripts/repair-baselinker-sku-index-productIds.js
 *
 * Options:
 *   --apply   Actually write changes (default: dry-run)
 */

const { firestore, findProductByStrictIdentifier, setSkuIndexEntry } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');

const normalizeEanValue = (val) =>
  (val || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();

const buildSkuIndexKey = (type, value) => (value ? `${type}:${value}` : null);

const normalizeKey = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.toLowerCase() : null;
};

function isStubProduct(docId, data = {}) {
  const identification = data.identification || null;
  const details = data.details || null;
  const ops = data.ops || null;

  const meaningful =
    (identification &&
      typeof identification === 'object' &&
      (identification.sku ||
        identification.name ||
        identification.brand ||
        identification.category ||
        (Array.isArray(identification.barcodes) && identification.barcodes.length))) ||
    (details &&
      typeof details === 'object' &&
      ((details.identifiers && Object.keys(details.identifiers || {}).some((k) => details.identifiers[k])) ||
        (Array.isArray(details.images) && details.images.length) ||
        details.short_description ||
        details.description)) ||
    (ops && typeof ops === 'object' && Object.keys(ops).length > 0);

  if (meaningful) return false;

  const invQty = Number(data?.inventory?.quantity || 0);
  const hasQty = Number.isFinite(invQty) && invQty > 0;
  const hasStorage = Boolean(data.storage && data.storage.binCode);
  const hasBins =
    Array.isArray(data.storageBins) && data.storageBins.some((b) => Number(b?.quantity || 0) > 0);
  if (hasQty || hasStorage || hasBins) return false;

  const keys = Object.keys(data || {});
  if (data.id && String(data.id).trim() && String(data.id).trim() !== String(docId).trim()) return false;
  // Typical stub: {id, inventory, storageBins} (+ maybe timestamps)
  if (keys.length > 10) return false;
  return true;
}

async function resolveBestProductId({ sku, ean }) {
  const skuNorm = normalizeSkuValue(sku);
  const eanNorm = normalizeEanValue(ean);

  // 1) Prefer doc(sku) if exists and not stub
  if (sku && sku.trim()) {
    const snap = await firestore.collection('products').doc(sku).get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (!isStubProduct(sku, data)) return sku;
    }
  }

  // 2) Strict identifier lookup (handles doc ids that are not SKU)
  const barcodes = eanNorm ? [eanNorm] : [];
  const hit = await findProductByStrictIdentifier({
    sku: sku ? String(sku).trim() : null,
    barcodes,
  });
  if (hit?.id) {
    const snap = await firestore.collection('products').doc(hit.id).get();
    if (snap.exists && !isStubProduct(hit.id, snap.data() || {})) {
      return hit.id;
    }
  }

  // 3) Try doc(ean) if exists and not stub
  if (eanNorm) {
    const snap = await firestore.collection('products').doc(eanNorm).get();
    if (snap.exists && !isStubProduct(eanNorm, snap.data() || {})) return eanNorm;
  }

  // 4) Try padded EAN/UPC variants (leading zeros often lost in CSV exports)
  const padTo = (n) => (eanNorm && eanNorm.length < n ? eanNorm.padStart(n, '0') : null);
  for (const cand of [padTo(12), padTo(13), padTo(14)].filter(Boolean)) {
    const snap = await firestore.collection('products').doc(cand).get();
    if (snap.exists && !isStubProduct(cand, snap.data() || {})) return cand;
  }

  return null;
}

async function main() {
  const snap = await firestore.collection('baselinker_sku_index').get();
  const report = {
    apply: APPLY,
    scanned: snap.size,
    fixed: 0,
    skipped: 0,
    unresolved: 0,
    changes: [],
  };

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const currentProductId = data.productId ? String(data.productId) : '';
    const currentKey = doc.id;
    const sku = data.sku || null;
    const ean = data.ean || null;
    const baseProductId = data.baseProductId || null;

    if (!currentProductId) {
      report.skipped += 1;
      continue;
    }

    const prodSnap = await firestore.collection('products').doc(currentProductId).get();
    const prodMissing = !prodSnap.exists;
    const prodStub = prodSnap.exists && isStubProduct(currentProductId, prodSnap.data() || {});
    if (!prodMissing && !prodStub) {
      report.skipped += 1;
      continue;
    }

    const bestId = await resolveBestProductId({ sku, ean });
    if (!bestId) {
      report.unresolved += 1;
      continue;
    }
    if (String(bestId) === String(currentProductId)) {
      report.skipped += 1;
      continue;
    }

    const normalizedSku = normalizeSkuValue(sku);
    const normalizedEan = normalizeEanValue(ean);
    const payload = {
      baseProductId: baseProductId || null,
      productId: bestId,
      sku: sku || null,
      ean: ean || null,
      updatedAt: new Date().toISOString(),
    };

    if (APPLY) {
      await setSkuIndexEntry(currentKey, payload);

      // Ensure we also have an ean:<digits> entry if possible (some legacy entries only had sku:*)
      const eanKey = buildSkuIndexKey('ean', normalizedEan);
      if (eanKey) {
        await setSkuIndexEntry(eanKey, payload);
      }
      // And ensure sku:<digits> exists for SKU too (normalization removes prefix)
      const skuKey = buildSkuIndexKey('sku', normalizedSku);
      if (skuKey) {
        await setSkuIndexEntry(skuKey, payload);
      }
    }

    report.fixed += 1;
    report.changes.push({
      key: currentKey,
      fromProductId: currentProductId,
      toProductId: bestId,
      sku: sku || null,
      ean: ean || null,
      missing: prodMissing,
      stub: prodStub,
    });
  }

  console.log('repair sku_index finished:', JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('repair sku_index failed:', err);
  process.exit(1);
});


