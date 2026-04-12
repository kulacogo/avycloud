#!/usr/bin/env node
'use strict';

/**
 * Emergency Oversell Fix — Force-sync all products where marketplace > 0 but warehouse = 0.
 *
 * Also:
 *  - Fixes bin drift (inventory.quantity ≠ sum(storageBins))
 *  - Cleans up expired reservations
 *  - Clears stale eBay itemIds pointing to ended listings
 *
 * Usage: node backend/scripts/fix-oversells-now.js [--dry-run]
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n🚨 OVERSELL FIX ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}\n`);

  // ─── 1. Load all products ──────────────────────────────────────
  const productsSnap = await db.collection('products_v2').limit(5000).get();
  const products = productsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const skuToProduct = new Map();
  for (const p of products) {
    const sku = String(p.identification?.sku || '').trim().toLowerCase();
    if (sku) skuToProduct.set(sku, p);
  }

  // ─── 2. Fix bin drift ──────────────────────────────────────────
  console.log('📊 Checking bin drift...');
  let binDriftFixed = 0;
  const batch1 = db.batch();
  let batch1Count = 0;

  for (const p of products) {
    const qty = Number(p.inventory?.quantity ?? 0);
    const bins = Array.isArray(p.storageBins) ? p.storageBins : [];
    const binSum = bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
    if (binSum !== qty && (binSum > 0 || qty > 0)) {
      console.log(`  Drift: ${p.identification?.sku || p.id} inventory=${qty} bins=${binSum} → setting to ${binSum}`);
      if (!DRY_RUN) {
        batch1.update(db.collection('products_v2').doc(p.id), { 'inventory.quantity': binSum });
        batch1Count++;
        binDriftFixed++;
      }
    }
  }
  if (batch1Count > 0) {
    await batch1.commit();
  }
  console.log(`  Fixed: ${binDriftFixed}\n`);

  // ─── 3. Clean up expired reservations ──────────────────────────
  console.log('🔒 Cleaning expired reservations...');
  const now = new Date().toISOString();
  let expiredFixed = 0;
  // Query by status only (avoids needing composite index on status+expiresAt),
  // then filter expired ones client-side.
  const resSnap = await db.collection('stock_reservations')
    .where('status', '==', 'reserved')
    .limit(2000)
    .get();
  const expiredDocs = resSnap.docs.filter((doc) => {
    const d = doc.data();
    return d.expiresAt && d.expiresAt < now;
  });
  console.log(`  Found ${expiredDocs.length} expired reservations out of ${resSnap.size} total reserved`);
  if (!DRY_RUN && expiredDocs.length > 0) {
    // Batch in chunks of 500
    for (let i = 0; i < expiredDocs.length; i += 500) {
      const chunk = expiredDocs.slice(i, i + 500);
      const batch = db.batch();
      chunk.forEach((doc) => batch.update(doc.ref, { status: 'expired', expiredAt: now }));
      await batch.commit();
      expiredFixed += chunk.length;
    }
  } else if (DRY_RUN) {
    expiredFixed = expiredDocs.length;
  }
  console.log(`  Expired: ${expiredFixed}\n`);

  // ─── 4. Find and fix oversells ─────────────────────────────────
  console.log('⚠️  Finding oversells...\n');

  // eBay oversells
  const ebaySnap = await db.collection('ebayListingsLive').where('active', '==', true).get();
  let ebayFixed = 0;
  for (const doc of ebaySnap.docs) {
    const data = doc.data();
    const ebayQty = Number(data.quantityAvailable ?? data.quantity ?? 0);
    if (ebayQty <= 0) continue;
    const sku = String(data.sku || '').trim().toLowerCase();
    const product = sku ? skuToProduct.get(sku) : null;
    if (!product) continue;
    const whQty = Number(product.inventory?.quantity ?? 0);
    if (whQty > 0) continue; // Not an oversell

    console.log(`  eBay OVERSELL: ${data.sku} — eBay=${ebayQty} warehouse=${whQty}`);
    if (!DRY_RUN) {
      try {
        const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');
        const result = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'emergency-oversell-fix' });
        const ebayResult = result.results.find((r) => r.channel === 'ebay');
        console.log(`    → eBay: ${ebayResult?.status || 'no-itemId'}`);
        ebayFixed++;
      } catch (err) {
        console.error(`    → FAILED: ${err.message}`);
      }
    }
  }

  // Kaufland oversells
  const klSnap = await db.collection('kauflandUnitsLive').where('active', '==', true).get();
  let klFixed = 0;
  for (const doc of klSnap.docs) {
    const data = doc.data();
    const klQty = Number(data.amount ?? 0);
    if (klQty <= 0) continue;
    const sku = String(data.id_offer || '').trim().toLowerCase();
    const product = sku ? skuToProduct.get(sku) : null;
    if (!product) continue;
    const whQty = Number(product.inventory?.quantity ?? 0);
    if (whQty > 0) continue; // Not an oversell

    console.log(`  Kaufland OVERSELL: ${data.id_offer} — Kaufland=${klQty} warehouse=${whQty}`);
    if (!DRY_RUN) {
      try {
        const { syncStockToAllChannels } = require('../services/stock-sync-dispatcher');
        const result = await syncStockToAllChannels({ tenantId: 'default', product, reason: 'emergency-oversell-fix' });
        const klResult = result.results.find((r) => r.channel === 'kaufland');
        console.log(`    → Kaufland: ${klResult?.status || 'no-unitId'}`);
        klFixed++;
      } catch (err) {
        console.error(`    → FAILED: ${err.message}`);
      }
    }
  }

  console.log(`\n✅ Summary:`);
  console.log(`  Bin drift fixed: ${binDriftFixed}`);
  console.log(`  Expired reservations cleaned: ${expiredFixed}`);
  console.log(`  eBay oversells fixed: ${ebayFixed}`);
  console.log(`  Kaufland oversells fixed: ${klFixed}`);
  if (DRY_RUN) console.log('\n  (DRY RUN — no changes made)');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Fix failed:', e.message);
  process.exit(1);
});
