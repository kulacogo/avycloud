/**
 * One-time repair for malformed SKUs created by Identify:
 * - whitespace/newlines in SKU (common: "SKU-\n123...")
 * - missing "SKU-" prefix (e.g. "15305033")
 * This normalizes SKU via saveProduct(), without changing titles/key features.
 *
 * Usage:
 *   node backend/scripts/fix-malformed-sku-from-identify.js
 *
 * Optional env:
 *   LIMIT=2000         (default 2000)
 *   PAGE_SIZE=200      (default 200)
 *   DRY_RUN=1          (default 0)
 */

const { firestore, saveProduct } = require('../lib/firestore');

async function main() {
  const limitTotal = Math.max(1, parseInt(process.env.LIMIT || '2000', 10));
  const pageSize = Math.min(500, Math.max(1, parseInt(process.env.PAGE_SIZE || '200', 10)));
  const dryRun = String(process.env.DRY_RUN || '').trim() === '1';

  console.log(JSON.stringify({ action: 'fix-malformed-sku', limit_total: limitTotal, page_size: pageSize, dry_run: dryRun }, null, 2));

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  // Firestore can't do regex; we scan by ordering on last_saved_iso and checking in code.
  let lastDoc = null;
  while (processed < limitTotal) {
    let q = firestore.collection('products').orderBy('ops.last_saved_iso', 'desc').limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      processed += 1;
      lastDoc = doc;
      const data = doc.data() || {};
      const rawSku =
        (typeof data?.identification?.sku === 'string' && data.identification.sku) ||
        (typeof data?.details?.identifiers?.sku === 'string' && data.details.identifiers.sku) ||
        '';

      const hasWhitespace = /\s/.test(rawSku);
      const isPrefixOnly = /^SKU-\s*$/i.test(String(rawSku || ''));
      const hasPrefix = /^SKU-/i.test(String(rawSku || '').trim());
      if (!rawSku || (!hasWhitespace && !isPrefixOnly && hasPrefix)) {
        skipped += 1;
        continue;
      }

      const product = { ...data, id: data.id || doc.id };
      if (!product.id) {
        skipped += 1;
        continue;
      }

      try {
        if (!dryRun) {
          await saveProduct(product, { source: 'script', skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
          updated += 1;
        }
      } catch (err) {
        failed += 1;
        console.error(`[fix-malformed-sku] Failed for ${product.id}:`, err?.message || err);
      }

      if (processed >= limitTotal) break;
    }
  }

  console.log(JSON.stringify({ done: true, processed, updated, skipped, failed }, null, 2));
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

