/**
 * Audit invalid SKUs (read-only):
 * Reports how many products still have invalid SKU format.
 *
 * Usage:
 *   node scripts/sku-audit-invalid.js
 *
 * Optional env:
 *   LIMIT=200000      (default 200000)
 *   PAGE_SIZE=200     (default 200)
 *   LOG_EVERY=500     (default 500)
 */

const { firestore } = require('../lib/firestore');

function normalizeDigits(value) {
  if (value == null) return '';
  return String(value).replace(/\D+/g, '').trim();
}

function readRawSku(product) {
  return (
    (typeof product?.identification?.sku === 'string' ? product.identification.sku : '') ||
    (typeof product?.details?.identifiers?.sku === 'string' ? product.details.identifiers.sku : '') ||
    ''
  );
}

function isBadSku(product) {
  const raw = readRawSku(product);
  if (!raw) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower === 'sku-unknown' || lower === 'unknown' || lower === 'unbekannt') {
    return { bad: true, reason: 'placeholder_unknown' };
  }
  if (/\s/.test(trimmed)) return { bad: true, reason: 'whitespace' };
  if (/^SKU-\s*$/i.test(trimmed)) return { bad: true, reason: 'prefix_only' };
  if (!/^SKU-/i.test(trimmed)) return { bad: true, reason: 'missing_prefix' };
  if (!/^SKU-\d{10}$/i.test(trimmed)) return { bad: true, reason: 'invalid_format' };
  const ean = normalizeDigits(product?.details?.identifiers?.ean);
  const gtin = normalizeDigits(product?.details?.identifiers?.gtin);
  const upc = normalizeDigits(product?.details?.identifiers?.upc);
  const skuDigits = normalizeDigits(trimmed.replace(/^SKU-/i, ''));
  if (skuDigits && (skuDigits === ean || skuDigits === gtin || skuDigits === upc)) {
    return { bad: true, reason: 'sku_equals_barcode' };
  }
  return false;
}

async function main() {
  const limitTotal = Math.max(1, parseInt(process.env.LIMIT || '200000', 10));
  const pageSize = Math.min(500, Math.max(1, parseInt(process.env.PAGE_SIZE || '200', 10)));
  const logEvery = Math.max(50, parseInt(process.env.LOG_EVERY || '500', 10));

  console.log(JSON.stringify({ action: 'sku-audit', limit_total: limitTotal, page_size: pageSize }, null, 2));

  let processed = 0;
  let badCount = 0;
  const reasons = { whitespace: 0, prefix_only: 0, missing_prefix: 0, invalid_format: 0, placeholder_unknown: 0, sku_equals_barcode: 0 };
  const samples = [];

  let lastDoc = null;
  while (processed < limitTotal) {
    let q = firestore.collection('products').orderBy('__name__').limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      processed += 1;
      lastDoc = doc;
      const data = doc.data() || {};
      const product = { ...data, id: data.id || doc.id };
      const bad = isBadSku(product);
      if (bad) {
        badCount += 1;
        if (bad?.reason && Object.prototype.hasOwnProperty.call(reasons, bad.reason)) {
          reasons[bad.reason] += 1;
        }
        if (samples.length < 20) {
          samples.push({ id: product.id, sku: readRawSku(product), reason: bad.reason });
        }
      }
      if (processed % logEvery === 0) {
        console.log(JSON.stringify({ processed, badCount, reasons }, null, 2));
      }
      if (processed >= limitTotal) break;
    }
  }

  console.log(JSON.stringify({ done: true, processed, badCount, reasons, samples }, null, 2));
  if (badCount > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

