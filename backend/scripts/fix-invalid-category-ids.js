/* eslint-disable no-console */
/**
 * One-time fix: Find products with categoryId not in the current eBay taxonomy
 * and resolve them to valid IDs using fuzzy breadcrumb matching.
 *
 * Usage:
 *   node backend/scripts/fix-invalid-category-ids.js              # dry-run
 *   node backend/scripts/fix-invalid-category-ids.js --apply      # apply fixes
 */

const { firestore } = require('../lib/firestore');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const categories = require('../ebay-data/categories.json');

const COLLECTION = 'products_v2';
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  console.log(`=== Fix Invalid Category IDs (${DRY_RUN ? 'DRY RUN' : 'APPLY'}) ===`);

  const snapshot = await firestore.collection(COLLECTION).get();
  let total = 0;
  let invalid = 0;
  let fixed = 0;
  let unfixable = 0;

  for (const doc of snapshot.docs) {
    total++;
    const data = doc.data();
    const catId = data?.details?.categoryId || data?.details?.ebayCategoryId;
    if (!catId) continue;

    const idStr = String(catId).trim();
    if (categories[idStr]) continue; // Valid ID

    invalid++;
    const breadcrumb = data?.identification?.category || '';
    const resolved = breadcrumb ? findEbayCategory(breadcrumb) : null;

    if (resolved?.id) {
      console.log(`  ${doc.id}: ${idStr} → ${resolved.id} (${resolved.breadcrumb})`);
      if (!DRY_RUN) {
        await firestore.collection(COLLECTION).doc(doc.id).update({
          'details.categoryId': String(resolved.id),
          'identification.category': resolved.breadcrumb,
        });
      }
      fixed++;
    } else {
      console.log(`  ${doc.id}: ${idStr} "${breadcrumb}" → NO MATCH`);
      unfixable++;
    }
  }

  console.log(`\nTotal: ${total}, Invalid: ${invalid}, Fixed: ${fixed}, Unfixable: ${unfixable}`);
  if (DRY_RUN && fixed > 0) {
    console.log('\nRun with --apply to fix.');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
