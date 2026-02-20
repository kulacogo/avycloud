/* eslint-disable no-console */
/**
 * Recover missing warehouse BIN assignments from stored BaseLinker export hints.
 *
 * Source fields:
 * - products/{id}.ops.baselinker_export.location (BIN code)
 * - products/{id}.ops.baselinker_export.stock (number)
 *
 * Safety rules (IMPORTANT):
 * - Only applies to products that currently have NO warehouse state:
 *   - storage is null/empty AND storageBins has no positive entries AND inventory.quantity <= 0
 * - Never overwrites existing BIN assignments.
 * - Uses assignProductToBin() so updates are consistent (bin doc + product doc + refresh).
 *
 * Usage:
 *   node backend/scripts/recover-warehouse-from-baselinker-export.js          # dry-run
 *   node backend/scripts/recover-warehouse-from-baselinker-export.js --apply  # write
 *
 * Optional:
 *   --sku SKU-123...   Only process a single SKU/docId
 *   --limit 50         Limit processed candidates
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');
const { assignProductToBin } = require('../lib/warehouse');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const skuArgIdx = argv.indexOf('--sku');
const ONLY_SKU = skuArgIdx !== -1 ? String(argv[skuArgIdx + 1] || '').trim() : null;
const limitIdx = argv.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? Number(argv[limitIdx + 1]) : null;

const normalizeBin = (value) => String(value || '').trim().toUpperCase();
const normalizeSkuKey = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s_]*/i, '')
    .replace(/\s+/g, '');

function hasPositiveStorageBins(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.some((b) => Number(b?.quantity || 0) > 0);
}

async function buildReservedOpenOrdersMap() {
  const map = new Map(); // normalizeSkuKey -> qty
  try {
    const snap = await firestore.collection('orders').where('status', '==', 'new').get();
    snap.forEach((doc) => {
      const order = doc.data() || {};
      const items = Array.isArray(order.items) ? order.items : [];
      for (const item of items) {
        const key = normalizeSkuKey(item?.sku || item?.productId || '');
        const qty = Number(item?.quantity || 0);
        if (!key || qty <= 0) continue;
        map.set(key, (map.get(key) || 0) + qty);
      }
    });
  } catch (error) {
    console.warn('Reserved-open-orders query failed; falling back to full scan:', error.message);
    try {
      const snap = await firestore.collection('orders').get();
      snap.forEach((doc) => {
        const order = doc.data() || {};
        if (order.status !== 'new') return;
        const items = Array.isArray(order.items) ? order.items : [];
        for (const item of items) {
          const key = normalizeSkuKey(item?.sku || item?.productId || '');
          const qty = Number(item?.quantity || 0);
          if (!key || qty <= 0) continue;
          map.set(key, (map.get(key) || 0) + qty);
        }
      });
    } catch (scanError) {
      console.warn('Reserved-open-orders full scan failed:', scanError.message);
    }
  }
  return map;
}

async function main() {
  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });

  const snap = await firestore.collection('products').get();
  const reservedMap = await buildReservedOpenOrdersMap();

  const report = {
    apply: APPLY,
    onlySku: ONLY_SKU || null,
    limit: Number.isFinite(LIMIT) && LIMIT > 0 ? Math.floor(LIMIT) : null,
    scanned: snap.size,
    candidates: 0,
    applied: 0,
    skipped: 0,
    skippedExistingWarehouse: 0,
    skippedMissingBinDoc: 0,
    errors: [],
    samples: [],
  };

  let processed = 0;
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const sku = String(data?.identification?.sku || data?.details?.identifiers?.sku || doc.id || '').trim();
    if (ONLY_SKU && sku !== ONLY_SKU && doc.id !== ONLY_SKU) {
      continue;
    }

    const bl = data?.ops?.baselinker_export || null;
    const binCode = normalizeBin(bl?.location);
    const stock = Number(bl?.stock || 0);
    if (!binCode || !Number.isFinite(stock) || stock <= 0) {
      continue;
    }

    const reservedQty = Number(reservedMap.get(normalizeSkuKey(sku)) || 0);
    // BaseLinker stock is AVAILABLE (already reduced by open orders).
    // Warehouse stock should represent PHYSICAL = available + reserved(open orders).
    const physicalQty = Math.max(0, stock + reservedQty);

    const invQty = Number(data?.inventory?.quantity || 0);
    const hasStorage = Boolean(String(data?.storage?.binCode || '').trim());
    const hasBins = hasPositiveStorageBins(data);
    const hasWarehouse = hasStorage || hasBins || invQty > 0;
    if (hasWarehouse) {
      report.skippedExistingWarehouse += 1;
      continue;
    }

    report.candidates += 1;
    if (report.limit && processed >= report.limit) {
      report.skipped += 1;
      continue;
    }

    // Ensure BIN doc exists
    const binSnap = await firestore.collection('warehouseBins').doc(binCode).get();
    if (!binSnap.exists) {
      report.skippedMissingBinDoc += 1;
      report.samples.push({ id: doc.id, sku, binCode, stock, reservedQty, physicalQty, reason: 'missingBinDoc' });
      continue;
    }

    processed += 1;
    report.samples.push({ id: doc.id, sku, binCode, stock, reservedQty, physicalQty, reason: APPLY ? 'applied' : 'dry-run' });

    if (!APPLY) {
      continue;
    }

    try {
      await assignProductToBin(binCode, doc.id, physicalQty);
      report.applied += 1;
    } catch (error) {
      report.errors.push({
        id: doc.id,
        sku,
        binCode,
        stock,
        reservedQty,
        physicalQty,
        message: error?.message || String(error),
      });
      console.error('[error]', sku || doc.id, binCode, physicalQty, error?.message || error);
    }
  }

  const outPath = path.join(outDir, 'recover-warehouse-from-baselinker-export-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Report written to:', outPath);
  console.log(JSON.stringify({ scanned: report.scanned, candidates: report.candidates, applied: report.applied, skippedMissingBinDoc: report.skippedMissingBinDoc, errors: report.errors.length }, null, 2));
}

main().catch((err) => {
  console.error('Recovery failed:', err);
  process.exit(1);
});


