/* eslint-disable no-console */
/**
 * Retry K-Typ enrichment for products that previously failed with `mvl_missing`.
 *
 * Why:
 * - Some past executions ran in an image without MVL JSONL at runtime (mvl_path=null),
 *   causing ktype_enrich_v1.reason == "mvl_missing".
 * - After MVL is available in the runtime image, we can safely retry.
 *
 * What it does:
 * - Queries Firestore for products where ops.data_quality.ktype_enrich_v1.reason == "mvl_missing"
 * - For each, tries enrichKTypIfPossible(product) and saves when it changes.
 *
 * Usage:
 *   node backend/scripts/ktype-retry-mvl-missing.js --dry-run --limit 50
 *   node backend/scripts/ktype-retry-mvl-missing.js --apply --limit 500
 */

const { getProduct, firestore, saveProduct } = require('../lib/firestore');
const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function hasKTyp(product) {
  const attrs = product?.details?.attributes;
  if (!attrs || typeof attrs !== 'object') return false;
  return Object.keys(attrs).some((k) => {
    const lower = safeString(k).toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
}

async function main() {
  const APPLY = argFlag('--apply');
  const DRY_RUN = !APPLY || argFlag('--dry-run');
  // limit = how many matching docs to attempt (not how many docs to scan)
  const limit = Math.max(1, parseInt(argValue('--limit', '200') || '200', 10));
  const pageSize = Math.min(200, Math.max(10, parseInt(argValue('--page-size', '200') || '200', 10)));
  const scanLimit = Math.max(100, parseInt(argValue('--scan-limit', '5000') || '5000', 10));

  console.log(JSON.stringify({ action: 'ktype-retry-mvl-missing', dryRun: DRY_RUN, limit, pageSize, scanLimit }, null, 2));

  const col = firestore.collection('products');
  let query = col
    // We intentionally avoid composite indexes by scanning by document id and filtering in code.
    .orderBy('__name__', 'asc')
    .limit(pageSize);

  let scanned = 0;
  let attempted = 0;
  let enriched = 0;
  let stillMissing = 0;
  let skippedHasKtyp = 0;
  let skippedNotMvlMissing = 0;
  let errors = 0;

  let lastDoc = null;
  while (attempted < limit && scanned < scanLimit) {
    const snap = await (lastDoc ? query.startAfter(lastDoc).get() : query.get());
    if (snap.empty) break;
    lastDoc = snap.docs[snap.docs.length - 1];

    for (const doc of snap.docs) {
      if (attempted >= limit || scanned >= scanLimit) break;
      scanned += 1;
      const id = doc.id;
      try {
        // Use the snapshot first (cheap) to filter before loading the full doc via getProduct.
        const snapData = doc.data() || {};
        const reason = safeString(snapData?.ops?.data_quality?.ktype_enrich_v1?.reason);
        if (reason !== 'mvl_missing') {
          skippedNotMvlMissing += 1;
          continue;
        }
        const product = await getProduct(id);
        if (!product) continue;
        if (hasKTyp(product)) {
          skippedHasKtyp += 1;
          continue;
        }
        attempted += 1;
        const res = await enrichKTypIfPossible(product, { reason: 'retry_mvl_missing' });
        if (res?.ok) {
          enriched += 1;
          if (!DRY_RUN) {
            await saveProduct(product, {
              mode: 'system',
              source: 'job',
              overwriteTextFields: false,
              replaceAttributes: false,
              skipTitlePolicy: true,
              skipKeyFeaturesNormalize: true,
            });
          }
        } else {
          stillMissing += 1;
        }
      } catch (e) {
        errors += 1;
        console.warn('retry failed:', id, e?.message || e);
      }
      if (scanned % 200 === 0) {
        console.log(
          JSON.stringify(
            { progress: { scanned, attempted }, enriched, stillMissing, skippedHasKtyp, skippedNotMvlMissing, errors },
            null,
            2
          )
        );
      }
    }
  }

  console.log(
    JSON.stringify(
      { done: true, scanned, attempted, enriched, stillMissing, skippedHasKtyp, skippedNotMvlMissing, errors },
      null,
      2
    )
  );
  if (!DRY_RUN && errors > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

