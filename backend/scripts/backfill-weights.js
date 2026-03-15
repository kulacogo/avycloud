#!/usr/bin/env node

/**
 * backfill-weights.js — BUG-032
 *
 * Backfills `details.weight` (in kg) for products in products_v2 that are missing it.
 *
 * Strategy:
 * 1. Query all products_v2 without a valid details.weight
 * 2. Try to extract weight from known attribute keys (Gewicht, weight, Versandgewicht, etc.)
 * 3. Write details.weight to Firestore (dry-run by default)
 *
 * Usage:
 *   node backend/scripts/backfill-weights.js --dry-run       (default)
 *   node backend/scripts/backfill-weights.js                  (writes to Firestore)
 *   node backend/scripts/backfill-weights.js --limit=100
 */

'use strict';

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'avycloud-hub',
  });
}

const firestore = admin.firestore();
const COLLECTION = 'products_v2';

const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--write');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0; // 0 = no limit

const WEIGHT_ATTR_KEYS = new Set([
  'gewicht',
  'gewicht (kg)',
  'gewicht(kg)',
  'bruttogewicht',
  'brutto gewicht',
  'nettogewicht',
  'netto gewicht',
  'artikelgewicht',
  'produktgewicht',
  'versandgewicht',
  'shipping weight',
  'gesamtgewicht',
  'eigengewicht',
  'eigengewicht (kg)',
  'eigengewicht(kg)',
  'gross weight',
  'net weight',
  'weight',
  'gewicht (g)',
  'gewicht(g)',
]);

/**
 * Parse a raw weight value into kg.
 * Accepts: number (assumed kg), "500g", "500 g", "2.5 kg", "2500 gramm", etc.
 * Returns null if unparseable.
 */
function parseWeightToKg(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // If value looks like grams (> 1000 without unit), convert
    return raw > 1000 ? raw / 1000 : raw;
  }
  const s = String(raw).trim().toLowerCase().replace(',', '.');
  const numMatch = s.match(/^(\d+(?:\.\d+)?)\s*(g|gr|gram|gramm|gramme|kg|kilogram|kilogramm)?$/);
  if (!numMatch) return null;
  const num = parseFloat(numMatch[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = numMatch[2] || '';
  if (unit === 'kg' || unit === 'kilogram' || unit === 'kilogramm') return num;
  // g / gram / gramm / no unit → determine from magnitude
  if (unit === 'g' || unit === 'gr' || unit === 'gram' || unit === 'gramm' || unit === 'gramme') return num / 1000;
  // No unit: if > 100 assume grams, else kg
  return num > 100 ? num / 1000 : num;
}

/**
 * Try to extract weight in kg from a product's attributes.
 */
function extractWeightFromAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  for (const [k, v] of Object.entries(attrs)) {
    const key = String(k || '').trim().toLowerCase();
    if (WEIGHT_ATTR_KEYS.has(key)) {
      const kg = parseWeightToKg(v);
      if (kg && kg > 0 && kg <= 500) return kg;
    }
  }
  return null;
}

async function run() {
  console.log(`[backfill-weights] Starting. dryRun=${dryRun}, limit=${LIMIT || 'none'}`);

  const snap = await firestore.collection(COLLECTION).get();
  const docs = snap.docs;
  console.log(`[backfill-weights] Total products: ${docs.length}`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  const batch = firestore.batch();
  let batchCount = 0;
  const BATCH_SIZE = 400;

  async function flushBatch() {
    if (batchCount === 0) return;
    if (!dryRun) {
      await batch.commit();
    }
    batchCount = 0;
  }

  for (const doc of docs) {
    if (LIMIT > 0 && processed >= LIMIT) break;

    const data = doc.data();
    const details = data.details || {};
    const existingWeight = Number(details.weight || 0);

    // Skip if already has valid weight
    if (existingWeight > 0 && existingWeight <= 500) {
      skipped++;
      processed++;
      continue;
    }

    // Try to extract from attributes
    const attrs = details.attributes || {};
    const weightKg = extractWeightFromAttributes(attrs);

    if (!weightKg) {
      notFound++;
      processed++;
      continue;
    }

    const roundedKg = Math.round(weightKg * 1000) / 1000;
    const sku = data.identification?.sku || data.details?.identifiers?.sku || doc.id;

    console.log(`  [update] ${sku} → details.weight = ${roundedKg} kg (from attributes)`);

    if (!dryRun) {
      batch.update(doc.ref, { 'details.weight': roundedKg, updatedAt: new Date().toISOString() });
      batchCount++;
      if (batchCount >= BATCH_SIZE) {
        await flushBatch();
      }
    }

    updated++;
    processed++;
  }

  await flushBatch();

  console.log(`\n[backfill-weights] Done.`);
  console.log(`  Total docs:    ${docs.length}`);
  console.log(`  Processed:     ${processed}`);
  console.log(`  Updated:       ${updated} (weight extracted from attributes)`);
  console.log(`  Skipped:       ${skipped} (already had weight)`);
  console.log(`  Not found:     ${notFound} (no weight in attributes — needs Improve pipeline)`);
  if (dryRun) {
    console.log(`\n  ⚠️  DRY-RUN: No Firestore writes. Re-run with --write to apply changes.`);
  }
}

run().catch((err) => {
  console.error('[backfill-weights] Fatal error:', err);
  process.exit(1);
});
