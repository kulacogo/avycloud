/* eslint-disable no-console */
/**
 * cleanup-bad-weights.js
 *
 * Removes weight data that was set by the backfill-weight-enrichment script
 * (identified by ops.weightEnrichment.script === 'backfill-weight-enrichment').
 *
 * This is needed because the first backfill run used wrong field paths,
 * resulting in wildly inaccurate weight estimates.
 *
 * Usage:
 *   node backend/scripts/cleanup-bad-weights.js          # dry-run
 *   node backend/scripts/cleanup-bad-weights.js --apply   # apply changes
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const APPLY = process.argv.includes('--apply');

const db = new Firestore({ projectId: PROJECT });

async function run() {
  console.log('='.repeat(70));
  console.log('Cleanup Bad Weight Enrichment Data');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log('='.repeat(70));

  // Query products_v2 where ops.weightEnrichment.script exists
  const snapshot = await db.collection('products_v2').get();
  let found = 0;
  let cleaned = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const enrichment = data?.ops?.weightEnrichment;

    if (!enrichment || enrichment.script !== 'backfill-weight-enrichment') {
      continue;
    }

    found++;
    const sku = data?.identification?.sku || doc.id;
    const oldWeight = enrichment.weightKg;
    const source = enrichment.source;
    console.log(`  [${found}] ${sku} — was ${oldWeight} kg (${source})`);

    if (APPLY) {
      // Remove weight fields set by the script
      const updates = {
        'details.weight': FieldValue.delete(),
        'details.attributes.weight': FieldValue.delete(),
        'details.attributes.Gewicht': FieldValue.delete(),
        'ops.weightEnrichment': FieldValue.delete(),
      };

      // Update products_v2
      await db.collection('products_v2').doc(doc.id).update(updates);

      // Update legacy products collection (may not exist)
      try {
        await db.collection('products').doc(doc.id).update(updates);
      } catch (legacyErr) {
        if (legacyErr.code === 5) {
          // NOT_FOUND — legacy doc doesn't exist, skip
        } else {
          throw legacyErr;
        }
      }
      cleaned++;
    }
  }

  console.log(`\nFound: ${found} products with backfill weight data`);
  if (APPLY) {
    console.log(`Cleaned: ${cleaned}`);
  } else {
    console.log('Use --apply to remove bad weight data');
  }
}

run().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
