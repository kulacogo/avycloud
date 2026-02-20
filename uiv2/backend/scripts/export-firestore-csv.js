/* eslint-disable no-console */
/**
 * Export Firestore products and warehouseBins as CSV + a mismatch report.
 * Usage:
 *   node backend/scripts/export-firestore-csv.js
 *
 * Outputs:
 *   exports/products.csv
 *   exports/warehouse_bins.csv
 *   exports/bin_mismatches.csv   (bins contain product but product missing bin)
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const productsCollection = firestore.collection('products');
const binsCollection = firestore.collection('warehouseBins');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function exportProducts(filePath) {
  const snap = await productsCollection.get();
  const lines = [];
  lines.push([
    'id',
    'sku',
    'name',
    'brand',
    'ean',
    'inventory_quantity',
    'storage_bin',
    'storage_qty',
    'storageBins_json',
    'pending_intake',
  ].join(','));

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const sku =
      data?.identification?.sku ||
      data?.details?.identifiers?.sku ||
      doc.id;
    const name = data?.identification?.name || '';
    const brand = data?.identification?.brand || '';
    const ean =
      data?.details?.identifiers?.ean ||
      data?.details?.identifiers?.gtin ||
      '';
    const invQty = data?.inventory?.quantity ?? '';
    const storageBin = data?.storage?.binCode || '';
    const storageQty = data?.storage?.quantity ?? '';
    const pending = data?.ops?.pending_intake_quantity ?? '';
    const storageBinsJson = JSON.stringify(data?.storageBins || []);

    lines.push([
      csvEscape(doc.id),
      csvEscape(sku),
      csvEscape(name),
      csvEscape(brand),
      csvEscape(ean),
      csvEscape(invQty),
      csvEscape(storageBin),
      csvEscape(storageQty),
      csvEscape(storageBinsJson),
      csvEscape(pending),
    ].join(','));
  });

  fs.writeFileSync(filePath, lines.join('\n'));
  console.log(`Products exported: ${snap.size} -> ${filePath}`);
}

async function exportBins(filePath) {
  const snap = await binsCollection.get();
  const lines = [];
  lines.push([
    'code',
    'zone',
    'etage',
    'gang',
    'regal',
    'ebene',
    'productCount',
    'products_json',
    'firstStoredAt',
    'lastStoredAt',
  ].join(','));

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const productsJson = JSON.stringify(data?.products || []);
    lines.push([
      csvEscape(doc.id),
      csvEscape(data.zone || ''),
      csvEscape(data.etage || ''),
      csvEscape(data.gang || ''),
      csvEscape(data.regal || ''),
      csvEscape(data.ebene || ''),
      csvEscape(data.productCount || 0),
      csvEscape(productsJson),
      csvEscape(data.firstStoredAt ? data.firstStoredAt.toDate().toISOString() : ''),
      csvEscape(data.lastStoredAt ? data.lastStoredAt.toDate().toISOString() : ''),
    ].join(','));
  });

  fs.writeFileSync(filePath, lines.join('\n'));
  console.log(`Bins exported: ${snap.size} -> ${filePath}`);
}

async function exportMismatches(filePath) {
  const binSnap = await binsCollection.get();
  const productSnap = await productsCollection.get();

  const productsMap = new Map();
  productSnap.forEach((doc) => {
    productsMap.set(doc.id, doc.data() || {});
  });

  const bySku = new Map();
  productSnap.forEach((doc) => {
    const data = doc.data() || {};
    const skuCandidates = [
      doc.id,
      data?.identification?.sku,
      data?.details?.identifiers?.sku,
    ].filter(Boolean);
    skuCandidates.forEach((sku) => {
      const key = String(sku).trim().toLowerCase();
      if (!key) return;
      if (!bySku.has(key)) bySku.set(key, []);
      bySku.get(key).push(doc.id);
    });
  });

  const lines = [];
  lines.push([
    'binCode',
    'productId',
    'sku',
    'bin_qty',
    'product_storage_bin',
    'product_storage_qty',
    'product_storageBins_json',
  ].join(','));

  let mismatchCount = 0;

  binSnap.forEach((doc) => {
    const data = doc.data() || {};
    const binCode = doc.id;
    const products = Array.isArray(data.products) ? data.products : [];
    products.forEach((entry) => {
      const entrySku = entry?.sku ? String(entry.sku).trim().toLowerCase() : '';
      let pid = entry?.productId || null;
      if (!pid && entrySku && bySku.has(entrySku)) {
        pid = bySku.get(entrySku)[0];
      }
      if (!pid) return;
      const prod = productsMap.get(pid);
      if (!prod) return;
      const storageBin = prod?.storage?.binCode || '';
      const storageQty = prod?.storage?.quantity ?? '';
      const storageBinsJson = JSON.stringify(prod?.storageBins || []);
      // mismatch if product has no storageBins entry matching binCode
      const hasBin = Array.isArray(prod?.storageBins)
        ? prod.storageBins.some((b) => String(b.code || b.binCode).trim() === binCode)
        : false;
      if (!hasBin || storageBin !== binCode) {
        mismatchCount += 1;
        lines.push([
          csvEscape(binCode),
          csvEscape(pid),
          csvEscape(entry.sku || ''),
          csvEscape(entry.quantity || 0),
          csvEscape(storageBin),
          csvEscape(storageQty),
          csvEscape(storageBinsJson),
        ].join(','));
      }
    });
  });

  fs.writeFileSync(filePath, lines.join('\n'));
  console.log(`Mismatches exported: ${mismatchCount} -> ${filePath}`);
}

async function main() {
  const outDir = path.join(process.cwd(), 'exports');
  ensureDir(outDir);
  await exportProducts(path.join(outDir, 'products.csv'));
  await exportBins(path.join(outDir, 'warehouse_bins.csv'));
  await exportMismatches(path.join(outDir, 'bin_mismatches.csv'));
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});


