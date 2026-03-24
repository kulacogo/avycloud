/* eslint-disable no-console */
/**
 * Deduplicate products_v2 — Cleanup for BUG-085.
 *
 * Finds duplicate products created by the Dual-Write + _pickCanonicalId bug:
 *   - saveProduct() writes under original ID (e.g. UUID)
 *   - Dual-Write normalizeProduct() → _pickCanonicalId() changes ID to EAN
 *   - Second document created under EAN → duplicate
 *
 * Detection: Groups by SKU (normalized, case-insensitive).
 * For each group with >1 document:
 *   - Picks the "primary" (more fields, newer save date)
 *   - Merges any unique warehouse/BIN data from the duplicate
 *   - Deletes the duplicate
 *
 * Safety:
 *   - Dry-run by default (nur Report)
 *   - --apply → löscht Duplikate und merged Daten
 *   - Produkte mit Marketplace-Listings werden NICHT gelöscht
 *
 * Usage:
 *   node backend/scripts/dedupe-products-v2.js
 *   node backend/scripts/dedupe-products-v2.js --apply
 */

const { firestore } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

function safeStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeSku(sku) {
  return safeStr(sku).toLowerCase().replace(/\s+/g, '');
}

/**
 * Score a product document — higher is "better" (more data, newer).
 */
function scoreProduct(data) {
  let score = 0;

  // Has identification name
  if (safeStr(data?.identification?.name)) score += 10;
  // Has brand
  if (safeStr(data?.identification?.brand)) score += 5;
  // Has description
  if (safeStr(data?.details?.short_description)) score += 5;
  // Has images
  const images = Array.isArray(data?.details?.images) ? data.details.images.filter(Boolean) : [];
  score += images.length * 3;
  // Has attributes
  const attrs = data?.details?.attributes;
  const attrCount = attrs && typeof attrs === 'object' ? Object.keys(attrs).length : 0;
  score += attrCount;
  // Has pricing
  if (data?.details?.pricing?.lowest_price?.amount > 0) score += 5;
  // Has categoryId
  if (safeStr(data?.details?.categoryId)) score += 3;
  // Recency (newer = better)
  const savedAt = data?.ops?.last_saved_iso || data?.ops?._normalizedAt || '';
  if (savedAt) {
    try {
      score += Math.floor(new Date(savedAt).getTime() / 1e10); // rough recency bonus
    } catch { /* ignore */ }
  }

  return score;
}

/**
 * Check if a product has marketplace activity (should NOT be deleted).
 */
function hasMarketplaceActivity(data) {
  const ops = data?.ops || {};
  if (ops.ebay?.itemId || ops.ebay?.listingId) return true;
  if (ops.kaufland?.unitId || ops.kaufland?.offerId) return true;
  if (data?.marketplace_listings && Object.keys(data.marketplace_listings).length > 0) return true;
  return false;
}

async function main() {
  console.log('=== BUG-085: Deduplicate products_v2 ===');
  console.log(`Mode: ${APPLY ? '🔴 APPLY (will delete duplicates)' : '🟢 DRY-RUN (report only)'}\n`);

  // 1. Load all products
  const snap = await firestore.collection('products_v2').get();
  console.log(`Loaded ${snap.size} documents from products_v2\n`);

  // 2. Group by normalized SKU
  const bySku = new Map();
  const skipped = { noSku: 0 };

  snap.forEach((doc) => {
    const data = doc.data();
    const sku = normalizeSku(data?.identification?.sku);
    if (!sku) {
      skipped.noSku++;
      return;
    }
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push({ id: doc.id, data });
  });

  console.log(`SKU groups: ${bySku.size} (skipped ${skipped.noSku} docs without SKU)\n`);

  // 3. Find duplicates
  const duplicates = [];
  for (const [sku, docs] of bySku) {
    if (docs.length <= 1) continue;

    // Score each document — highest score is primary
    const scored = docs
      .map((d) => ({ ...d, score: scoreProduct(d.data), hasListings: hasMarketplaceActivity(d.data) }))
      .sort((a, b) => b.score - a.score);

    const primary = scored[0];
    const dupes = scored.slice(1);

    duplicates.push({ sku, primary, dupes });
  }

  console.log(`Found ${duplicates.length} SKU groups with duplicates\n`);

  if (duplicates.length === 0) {
    console.log('No duplicates found. Done.');
    return;
  }

  // 4. Report & optionally apply
  let deletedCount = 0;
  let mergedCount = 0;
  let skippedListings = 0;

  for (const { sku, primary, dupes } of duplicates) {
    console.log(`\n--- SKU: ${sku} (${dupes.length + 1} docs) ---`);
    console.log(`  PRIMARY: ${primary.id} (score: ${primary.score}, listings: ${primary.hasListings})`);
    console.log(`    Name: ${safeStr(primary.data?.identification?.name)}`);

    for (const dupe of dupes) {
      console.log(`  DUPLICATE: ${dupe.id} (score: ${dupe.score}, listings: ${dupe.hasListings})`);
      console.log(`    Name: ${safeStr(dupe.data?.identification?.name)}`);

      if (dupe.hasListings) {
        console.log(`  ⚠️  SKIPPED — duplicate has marketplace listings, manual review needed`);
        skippedListings++;
        continue;
      }

      if (APPLY) {
        // Merge any warehouse BIN data from duplicate into primary
        const dupeBins = dupe.data?.storageBins || {};
        const primaryBins = primary.data?.storageBins || {};
        const newBins = { ...primaryBins };
        let binsMerged = false;
        for (const [binId, binData] of Object.entries(dupeBins)) {
          if (!newBins[binId]) {
            newBins[binId] = binData;
            binsMerged = true;
          }
        }
        if (binsMerged) {
          await firestore.collection('products_v2').doc(primary.id).update({ storageBins: newBins });
          console.log(`  ✅ Merged BIN data from ${dupe.id} → ${primary.id}`);
          mergedCount++;
        }

        // Delete the duplicate
        await firestore.collection('products_v2').doc(dupe.id).delete();
        console.log(`  🗑️  Deleted: ${dupe.id}`);
        deletedCount++;
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Duplicate groups: ${duplicates.length}`);
  console.log(`${APPLY ? 'Deleted' : 'Would delete'}: ${APPLY ? deletedCount : duplicates.reduce((s, d) => s + d.dupes.filter((x) => !x.hasListings).length, 0)}`);
  console.log(`${APPLY ? 'Merged BIN data' : 'Would merge BIN data'}: ${APPLY ? mergedCount : '(unknown until apply)'}`);
  console.log(`Skipped (has listings): ${skippedListings}`);

  if (!APPLY && duplicates.length > 0) {
    console.log('\n⚠️  Run with --apply to actually delete duplicates.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
