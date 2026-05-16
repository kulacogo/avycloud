#!/usr/bin/env node
'use strict';

/**
 * cleanup-stale-kaufland-unitids.js
 *
 * Findet alle products_v2-Dokumente mit `ops.kaufland.unitId` und prüft jede
 * unitId gegen den `kauflandUnitsLive` Cache. Eine unitId gilt als "stale"
 * wenn sie entweder
 *
 *   - nicht im Cache existiert, ODER
 *   - im Cache existiert aber `active === false` (Tombstone / ONHOLD / STALE).
 *
 * Bei einer stale unitId werden folgende Felder gesetzt:
 *
 *   - ops.kaufland.unitId            → null (löscht den Pointer)
 *   - ops.kaufland.last_sync_status  → 'stale-cleanup'
 *   - ops.kaufland.last_sync_iso     → <ISO timestamp>
 *   - ops.listingStatus.kaufland     → 'not_listed'
 *
 * Default ist DRY-RUN — Schreibvorgänge nur mit `--apply`.
 *
 * Usage:
 *   node scripts/cleanup-stale-kaufland-unitids.js
 *   node scripts/cleanup-stale-kaufland-unitids.js --apply
 *
 * Optionale ENV:
 *   GCLOUD_PROJECT   — Default 'avycloud'
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
}

const db = admin.firestore();
const APPLY = process.argv.includes('--apply');
const SAMPLE_SIZE = 10;

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  // 1) Snapshot kauflandUnitsLive into a map: idUnit (string) -> { active, status }
  //    We only need `active` + `status` to decide staleness, so this is cheap.
  console.log('Loading kauflandUnitsLive cache...');
  const liveSnap = await db.collection('kauflandUnitsLive').get();
  const liveById = new Map();
  for (const doc of liveSnap.docs) {
    const data = doc.data() || {};
    liveById.set(String(doc.id), {
      active: data.active === true,
      status: data.status || null,
    });
  }
  console.log(`  → ${liveById.size} cached units`);

  // 2) Stream products_v2 looking for docs with ops.kaufland.unitId set.
  //    Use a where-filter for indexability.
  console.log('Scanning products_v2 for ops.kaufland.unitId...');
  const prodSnap = await db
    .collection('products_v2')
    .where('ops.kaufland.unitId', '!=', null)
    .get();
  console.log(`  → ${prodSnap.size} products carry an ops.kaufland.unitId`);

  // Iterate and classify
  let totalWithUnit = 0;
  const staleDocs = []; // { id, sku, unitId, reason }
  for (const doc of prodSnap.docs) {
    const data = doc.data() || {};
    const unitIdRaw = data?.ops?.kaufland?.unitId;
    if (unitIdRaw == null || unitIdRaw === '') continue;
    totalWithUnit += 1;
    const unitId = String(unitIdRaw);
    const live = liveById.get(unitId);
    if (!live) {
      staleDocs.push({
        id: doc.id,
        sku: data?.identification?.sku || data?.details?.identifiers?.sku || null,
        unitId,
        reason: 'unit not in kauflandUnitsLive cache',
      });
      continue;
    }
    if (!live.active) {
      staleDocs.push({
        id: doc.id,
        sku: data?.identification?.sku || data?.details?.identifiers?.sku || null,
        unitId,
        reason: `unit inactive in cache (status=${live.status || 'unknown'})`,
      });
    }
  }

  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log(`Total products with ops.kaufland.unitId : ${totalWithUnit}`);
  console.log(`Stale (unit not active in cache)        : ${staleDocs.length}`);
  console.log('──────────────────────────────────────────────────────────────────');

  if (staleDocs.length === 0) {
    console.log('\nNothing to clean up. Done.');
    return;
  }

  const samples = staleDocs.slice(0, SAMPLE_SIZE);
  console.log(`\nSample stale productIds (first ${samples.length}):`);
  for (const s of samples) {
    console.log(`  - ${s.id} sku=${s.sku || 'n/a'} unitId=${s.unitId}  [${s.reason}]`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN: no documents were updated. Re-run with --apply to write.');
    return;
  }

  // 3) Apply updates in batches of 400 (Firestore limit 500).
  console.log(`\nApplying ${staleDocs.length} updates...`);
  let updated = 0;
  const nowIso = new Date().toISOString();
  for (let i = 0; i < staleDocs.length; i += 400) {
    const slice = staleDocs.slice(i, i + 400);
    const batch = db.batch();
    for (const s of slice) {
      const ref = db.collection('products_v2').doc(s.id);
      batch.update(ref, {
        'ops.kaufland.unitId': null,
        'ops.kaufland.last_sync_status': 'stale-cleanup',
        'ops.kaufland.last_sync_iso': nowIso,
        'ops.listingStatus.kaufland': 'not_listed',
      });
    }
    await batch.commit();
    updated += slice.length;
    console.log(`  → ${updated}/${staleDocs.length} updated`);
  }

  console.log('\nDone.');
  console.log(`Updated (--apply) : ${updated}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nERROR:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
