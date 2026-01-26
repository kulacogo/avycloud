/**
 * One-time SKU backfill:
 * - Detects invalid/malformed SKU formats (no SKU- prefix, whitespace/newlines, prefix-only, SKU==EAN/GTIN/UPC)
 * - Re-saves product via saveProduct() so canonicalization applies (without changing titles/key-features).
 *
 * Usage (local or Cloud Run Job):
 *   node scripts/sku-backfill-all-products.js
 *
 * Optional env:
 *   LIMIT=200000      (default 200000)
 *   PAGE_SIZE=200     (default 200)
 *   DRY_RUN=1         (default 0)
 *   LOG_EVERY=200     (default 200)
 */

const { firestore, saveProduct } = require('../lib/firestore');

function normalizeDigits(value) {
  if (value == null) return '';
  const digits = String(value).replace(/\D+/g, '').trim();
  return digits;
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

  // whitespace/newlines
  if (/\s/.test(trimmed)) return { bad: true, reason: 'whitespace' };

  // prefix-only
  if (/^SKU-\s*$/i.test(trimmed)) return { bad: true, reason: 'prefix_only' };

  // missing prefix
  if (!/^SKU-/i.test(trimmed)) return { bad: true, reason: 'missing_prefix' };

  // SKU equals barcode (should be treated as barcode, not SKU)
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
  const dryRun = String(process.env.DRY_RUN || '').trim() === '1';
  const logEvery = Math.max(10, parseInt(process.env.LOG_EVERY || '200', 10));

  console.log(
    JSON.stringify(
      { action: 'sku-backfill', limit_total: limitTotal, page_size: pageSize, dry_run: dryRun },
      null,
      2
    )
  );

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const reasons = { whitespace: 0, prefix_only: 0, missing_prefix: 0, sku_equals_barcode: 0 };

  let lastDoc = null;
  while (processed < limitTotal) {
    // Deterministic full scan by document id.
    let q = firestore.collection('products').orderBy('__name__').limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      processed += 1;
      lastDoc = doc;
      const data = doc.data() || {};
      const product = { ...data, id: data.id || doc.id };
      if (!product.id) {
        skipped += 1;
        continue;
      }

      const bad = isBadSku(product);
      if (!bad) {
        skipped += 1;
        continue;
      }
      if (bad?.reason && Object.prototype.hasOwnProperty.call(reasons, bad.reason)) {
        reasons[bad.reason] += 1;
      }

      try {
        if (!dryRun) {
          await saveProduct(product, {
            source: 'script',
            skipTitlePolicy: true,
            skipKeyFeaturesNormalize: true,
          });
        }
        updated += 1;
      } catch (err) {
        failed += 1;
        console.error(`[sku-backfill] Failed for ${product.id}:`, err?.message || err);
      }

      if (processed % logEvery === 0) {
        console.log(JSON.stringify({ processed, updated, skipped, failed, reasons }, null, 2));
      }
      if (processed >= limitTotal) break;
    }
  }

  console.log(JSON.stringify({ done: true, processed, updated, skipped, failed, reasons }, null, 2));
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

