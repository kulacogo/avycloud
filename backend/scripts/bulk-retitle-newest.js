/**
 * Bulk re-title the N newest products using Gemini grounding.
 *
 * Usage:
 *   node scripts/bulk-retitle-newest.js            # dry-run (shows proposed titles)
 *   node scripts/bulk-retitle-newest.js --apply     # writes to Firestore
 *   node scripts/bulk-retitle-newest.js --limit 10  # only process 10 products
 */
const { firestore, PRODUCTS_COLLECTION } = require('../lib/firestore');
const { identifyProductWithGrounding } = require('../lib/gemini3-client');

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 && process.argv[idx + 1] ? Number(process.argv[idx + 1]) : 20;
})();

async function downloadImageAsBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'image/jpeg';
    return { data: buf.toString('base64'), mimeType: mime.split(';')[0] };
  } catch {
    return null;
  }
}

async function run() {
  console.log(`\n=== Bulk Re-Title (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${LIMIT} products ===\n`);

  const snap = await firestore.collection(PRODUCTS_COLLECTION)
    .orderBy('ops.last_saved_iso', 'desc')
    .limit(LIMIT)
    .get();

  console.log(`Found ${snap.size} products\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const id = doc.id;
    const currentTitle = data.identification?.name || '';
    const brand = data.identification?.brand || '';
    const sku = data.identification?.sku || '';
    const ean = data.details?.identifiers?.ean || data.identification?.barcodes?.[0] || '';

    // Skip products with already good titles (70+ chars)
    if (currentTitle.length >= 70) {
      console.log(`SKIP [${sku}] "${currentTitle}" (${currentTitle.length} chars — already good)`);
      skipped++;
      continue;
    }

    // Download up to 2 images for Gemini
    const images = (data.details?.images || []).slice(0, 2);
    const imageParts = [];
    for (const img of images) {
      const url = typeof img === 'string' ? img : String(img?.url_or_base64 || img?.url || '');
      if (!url || typeof url !== 'string' || !url.startsWith('http')) continue;
      const part = await downloadImageAsBase64(url);
      if (part) imageParts.push(part);
    }

    const barcodes = [String(ean || '')].filter(Boolean);

    try {
      console.log(`\nProcessing [${sku}] "${currentTitle}" (${currentTitle.length} chars)`);

      const result = await identifyProductWithGrounding({
        imageParts,
        ocrText: '',
        barcodes,
        locale: 'de-DE',
        hint: `${brand} ${currentTitle}`.trim(),
      });

      const newTitle = result?.title_ebay || '';
      if (!newTitle || newTitle.length < currentTitle.length) {
        console.log(`  SKIP — Gemini title worse: "${newTitle}" (${newTitle.length} chars)`);
        skipped++;
        continue;
      }

      console.log(`  OLD: "${currentTitle}" (${currentTitle.length})`);
      console.log(`  NEW: "${newTitle}" (${newTitle.length})`);

      if (APPLY) {
        await firestore.collection(PRODUCTS_COLLECTION).doc(id).update({
          'identification.name': newTitle,
          'marketplace.ebay.title': newTitle,
        });
        console.log(`  ✅ SAVED`);
      } else {
        console.log(`  (dry-run — use --apply to save)`);
      }
      updated++;
    } catch (err) {
      console.log(`  ❌ ERROR: ${err.message}`);
      errors++;
    }

    // Rate limit — 1 req/3s to respect Gemini quotas
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log(`\n=== Done: ${updated} updated, ${skipped} skipped, ${errors} errors ===`);
  if (!APPLY && updated > 0) {
    console.log('Run with --apply to persist changes.');
  }
}

run().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
