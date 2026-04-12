#!/usr/bin/env node
'use strict';

/**
 * Purge stale listing cache entries.
 *
 * Removes docs from ebayListingsLive and kauflandUnitsLive that are:
 *  - inactive (active=false) AND older than X days
 *  - OR not seen by the API in the last Y sync cycles
 *
 * This reduces the cache to only relevant current data, so the UI
 * shows accurate active/inactive counts.
 *
 * Usage: node backend/scripts/purge-stale-listings.js [--dry-run] [--max-age-days=30]
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_AGE_DAYS = parseInt(
  (process.argv.find(a => a.startsWith('--max-age-days=')) || '').split('=')[1] || '30',
  10
);

function toIsoString(val) {
  if (!val) return null;
  if (typeof val?.toDate === 'function') {
    const d = val.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof val === 'string') return val;
  return null;
}

async function main() {
  console.log(`\n🧹 PURGE STALE LISTINGS ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`   Max age for inactive entries: ${MAX_AGE_DAYS} days\n`);

  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ─── 1. eBay ──────────────────────────────────────────────────
  console.log('🛒 eBay (ebayListingsLive)...');
  const ebaySnap = await db.collection('ebayListingsLive').get();
  let ebayPurged = 0;
  let ebayKept = 0;

  for (let i = 0; i < ebaySnap.docs.length; i += 400) {
    const chunk = ebaySnap.docs.slice(i, i + 400);
    const batch = db.batch();
    let batchCount = 0;

    for (const doc of chunk) {
      const d = doc.data();
      const isActive = d.active === true;
      const updatedAt = toIsoString(d.updatedAt) || toIsoString(d.lastSeenAt) || toIsoString(d.lastChangedAt) || null;
      const isStale = !updatedAt || updatedAt < cutoff;

      // Keep active listings and recently updated inactive ones
      if (isActive || !isStale) {
        ebayKept++;
        continue;
      }

      // Purge: inactive AND older than cutoff
      if (!DRY_RUN) {
        batch.delete(doc.ref);
        batchCount++;
      }
      ebayPurged++;
    }

    if (batchCount > 0) await batch.commit();
  }
  console.log(`  Total: ${ebaySnap.size}, Kept: ${ebayKept}, Purged: ${ebayPurged}\n`);

  // ─── 2. Kaufland ──────────────────────────────────────────────
  console.log('🏪 Kaufland (kauflandUnitsLive)...');
  const klSnap = await db.collection('kauflandUnitsLive').get();
  let klPurged = 0;
  let klKept = 0;

  for (let i = 0; i < klSnap.docs.length; i += 400) {
    const chunk = klSnap.docs.slice(i, i + 400);
    const batch = db.batch();
    let batchCount = 0;

    for (const doc of chunk) {
      const d = doc.data();
      const isActive = d.active === true;
      const updatedAt = toIsoString(d.updatedAt) || null;
      const isStale = !updatedAt || updatedAt < cutoff;

      if (isActive || !isStale) {
        klKept++;
        continue;
      }

      if (!DRY_RUN) {
        batch.delete(doc.ref);
        batchCount++;
      }
      klPurged++;
    }

    if (batchCount > 0) await batch.commit();
  }
  console.log(`  Total: ${klSnap.size}, Kept: ${klKept}, Purged: ${klPurged}\n`);

  // ─── 3. Also purge stale ebayListingLinks ─────────────────────
  console.log('🔗 eBay Listing Links (ebayListingLinks)...');
  const linksSnap = await db.collection('ebayListingLinks').get();
  const activeEbayIds = new Set();
  ebaySnap.docs.forEach((doc) => {
    const d = doc.data();
    if (d.active === true) activeEbayIds.add(doc.id);
  });
  let linksPurged = 0;

  for (let i = 0; i < linksSnap.docs.length; i += 400) {
    const chunk = linksSnap.docs.slice(i, i + 400);
    const batch = db.batch();
    let batchCount = 0;

    for (const doc of chunk) {
      if (activeEbayIds.has(doc.id)) continue;
      // Link points to an inactive/purged listing — remove
      if (!DRY_RUN) {
        batch.delete(doc.ref);
        batchCount++;
      }
      linksPurged++;
    }

    if (batchCount > 0) await batch.commit();
  }
  console.log(`  Total: ${linksSnap.size}, Purged orphans: ${linksPurged}\n`);

  console.log('✅ Summary:');
  console.log(`  eBay:     ${ebayPurged} stale entries purged, ${ebayKept} kept`);
  console.log(`  Kaufland: ${klPurged} stale entries purged, ${klKept} kept`);
  console.log(`  Links:    ${linksPurged} orphaned links purged`);
  if (DRY_RUN) console.log('  (DRY RUN — no changes made)');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Purge failed:', e.message);
  process.exit(1);
});
