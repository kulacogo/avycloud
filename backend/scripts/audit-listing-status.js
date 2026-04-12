#!/usr/bin/env node
'use strict';

/**
 * Listing Status Audit — Verifies what the frontend API actually returns vs Firestore truth.
 *
 * Checks:
 *  1. What does /api/ebay/listings return? (simulated via listLiveListings)
 *  2. What does /api/kaufland/listings return? (simulated via Firestore query)
 *  3. Are active/inactive counts consistent between Firestore cache and API response?
 *  4. Are there status field mismatches (active boolean vs status string)?
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DIVIDER = '═'.repeat(70);
const SUBDIV = '─'.repeat(50);

async function main() {
  console.log(DIVIDER);
  console.log('  LISTING STATUS AUDIT');
  console.log(`  ${new Date().toISOString()}`);
  console.log(DIVIDER);

  // ─── 1. eBay: Raw Firestore vs API function ──────────────────
  console.log('\n🛒 EBAY LISTING STATUS ANALYSIS\n' + SUBDIV);

  // Raw Firestore data
  const ebaySnap = await db.collection('ebayListingsLive').get();
  const ebayRaw = {
    total: ebaySnap.size,
    activeTrue: 0,
    activeFalse: 0,
    activeNull: 0,
    statusActive: 0,
    statusCompleted: 0,
    statusEnded: 0,
    statusOther: 0,
    statusNull: 0,
    qtyGreaterZero: 0,
    qtyZero: 0,
    qtyNull: 0,
  };
  const ebayStatusValues = new Map();
  const ebayActiveVsStatus = [];

  for (const doc of ebaySnap.docs) {
    const d = doc.data();

    // active boolean analysis
    if (d.active === true) ebayRaw.activeTrue++;
    else if (d.active === false) ebayRaw.activeFalse++;
    else ebayRaw.activeNull++;

    // listingStatus string analysis
    const ls = d.listingStatus || null;
    if (ls === 'Active') ebayRaw.statusActive++;
    else if (ls === 'Completed') ebayRaw.statusCompleted++;
    else if (ls === 'Ended') ebayRaw.statusEnded++;
    else if (ls) ebayRaw.statusOther++;
    else ebayRaw.statusNull++;

    if (ls) ebayStatusValues.set(ls, (ebayStatusValues.get(ls) || 0) + 1);

    // quantity analysis
    const qty = d.quantityAvailable ?? d.quantity;
    if (typeof qty === 'number' && qty > 0) ebayRaw.qtyGreaterZero++;
    else if (typeof qty === 'number' && qty === 0) ebayRaw.qtyZero++;
    else ebayRaw.qtyNull++;

    // Check for inconsistencies between active boolean and listingStatus
    if (d.active === true && (ls === 'Completed' || ls === 'Ended')) {
      if (ebayActiveVsStatus.length < 10) {
        ebayActiveVsStatus.push({ itemId: doc.id, active: d.active, listingStatus: ls, qty: d.quantityAvailable });
      }
    }
    if (d.active === false && ls === 'Active') {
      if (ebayActiveVsStatus.length < 10) {
        ebayActiveVsStatus.push({ itemId: doc.id, active: d.active, listingStatus: ls, qty: d.quantityAvailable });
      }
    }
  }

  console.log(`Total eBay docs in Firestore: ${ebayRaw.total}`);
  console.log(`\n  active field:`);
  console.log(`    true:      ${ebayRaw.activeTrue}`);
  console.log(`    false:     ${ebayRaw.activeFalse}`);
  console.log(`    null/miss: ${ebayRaw.activeNull}`);
  console.log(`\n  listingStatus field:`);
  for (const [val, count] of [...ebayStatusValues.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    "${val}": ${count}`);
  }
  console.log(`    null/missing: ${ebayRaw.statusNull}`);
  console.log(`\n  quantity:`);
  console.log(`    > 0:       ${ebayRaw.qtyGreaterZero}`);
  console.log(`    = 0:       ${ebayRaw.qtyZero}`);
  console.log(`    null/miss: ${ebayRaw.qtyNull}`);

  if (ebayActiveVsStatus.length > 0) {
    console.log(`\n  ⚠️ INCONSISTENCIES (active boolean vs listingStatus): ${ebayActiveVsStatus.length}`);
    for (const item of ebayActiveVsStatus) {
      console.log(`    itemId=${item.itemId} active=${item.active} listingStatus=${item.listingStatus} qty=${item.qty}`);
    }
  }

  // Simulate what frontend would see
  console.log(`\n  Frontend would see (normalizeEbayStatus logic):`);
  let ebayFrontendActive = 0, ebayFrontendInactive = 0, ebayFrontendUnknown = 0;
  for (const doc of ebaySnap.docs) {
    const d = doc.data();
    if (d.active === false || d.listingStatus === 'Completed' || d.listingStatus === 'Ended') {
      ebayFrontendInactive++;
    } else if (d.active === true || d.listingStatus === 'Active') {
      ebayFrontendActive++;
    } else {
      ebayFrontendUnknown++;
    }
  }
  console.log(`    Active:   ${ebayFrontendActive}`);
  console.log(`    Inactive: ${ebayFrontendInactive}`);
  console.log(`    Unknown:  ${ebayFrontendUnknown}`);

  // ─── 2. Kaufland: Raw Firestore analysis ──────────────────────
  console.log('\n\n🏪 KAUFLAND LISTING STATUS ANALYSIS\n' + SUBDIV);

  const klSnap = await db.collection('kauflandUnitsLive').get();
  const klRaw = {
    total: klSnap.size,
    activeTrue: 0,
    activeFalse: 0,
    activeNull: 0,
  };
  const klStatusValues = new Map();
  const klActiveVsStatus = [];

  for (const doc of klSnap.docs) {
    const d = doc.data();

    if (d.active === true) klRaw.activeTrue++;
    else if (d.active === false) klRaw.activeFalse++;
    else klRaw.activeNull++;

    const status = d.status || null;
    if (status) klStatusValues.set(status, (klStatusValues.get(status) || 0) + 1);

    // Check for inconsistencies
    if (d.active === true && status !== 'AVAILABLE') {
      if (klActiveVsStatus.length < 10) {
        klActiveVsStatus.push({ unitId: doc.id, active: d.active, status, amount: d.amount });
      }
    }
    if (d.active === false && status === 'AVAILABLE') {
      if (klActiveVsStatus.length < 10) {
        klActiveVsStatus.push({ unitId: doc.id, active: d.active, status, amount: d.amount });
      }
    }
  }

  console.log(`Total Kaufland docs in Firestore: ${klRaw.total}`);
  console.log(`\n  active field:`);
  console.log(`    true:      ${klRaw.activeTrue}`);
  console.log(`    false:     ${klRaw.activeFalse}`);
  console.log(`    null/miss: ${klRaw.activeNull}`);
  console.log(`\n  status field:`);
  for (const [val, count] of [...klStatusValues.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    "${val}": ${count}`);
  }

  if (klActiveVsStatus.length > 0) {
    console.log(`\n  ⚠️ INCONSISTENCIES (active boolean vs status string): ${klActiveVsStatus.length}+`);
    for (const item of klActiveVsStatus) {
      console.log(`    unitId=${item.unitId} active=${item.active} status=${item.status} amount=${item.amount}`);
    }
  }

  // Simulate frontend normalization
  console.log(`\n  Frontend would see (normalizeKauflandRow logic):`);
  let klFrontendActive = 0, klFrontendInactive = 0, klFrontendUnknown = 0;
  for (const doc of klSnap.docs) {
    const d = doc.data();
    if (d.active === true) {
      klFrontendActive++;
    } else if (d.status != null) {
      const s = String(d.status).toUpperCase();
      if (s === 'AVAILABLE') klFrontendActive++;
      else klFrontendInactive++;
    } else {
      klFrontendUnknown++;
    }
  }
  console.log(`    Active:   ${klFrontendActive}`);
  console.log(`    Inactive: ${klFrontendInactive}`);
  console.log(`    Unknown:  ${klFrontendUnknown}`);

  // ─── 3. Kaufland: storefront filter issue ─────────────────────
  console.log('\n\n🔍 KAUFLAND STOREFRONT ANALYSIS\n' + SUBDIV);
  const storefrontValues = new Map();
  for (const doc of klSnap.docs) {
    const d = doc.data();
    const sf = d.storefront || 'MISSING';
    storefrontValues.set(sf, (storefrontValues.get(sf) || 0) + 1);
  }
  console.log('  Storefront field distribution:');
  for (const [val, count] of [...storefrontValues.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    "${val}": ${count}`);
  }

  // Check: does storefront='de' filter return all, or does it miss some?
  const klStorefrontSnap = await db.collection('kauflandUnitsLive')
    .where('storefront', '==', 'de')
    .get();
  console.log(`\n  Query where storefront='de': ${klStorefrontSnap.size} docs`);
  console.log(`  Query without filter (all):   ${klSnap.size} docs`);
  if (klStorefrontSnap.size !== klSnap.size) {
    console.log(`  ⚠️ MISSING ${klSnap.size - klStorefrontSnap.size} docs when filtering by storefront='de'!`);
  }

  // ─── 4. products_v2 ops.listingStatus consistency ─────────────
  console.log('\n\n📊 PRODUCTS_V2 LISTING STATUS\n' + SUBDIV);
  const prodSnap = await db.collection('products_v2').limit(5000).get();
  const prodListingStatus = {
    ebayActive: 0, ebayInactive: 0, ebayNotListed: 0, ebayNull: 0,
    klActive: 0, klInactive: 0, klNotListed: 0, klNull: 0,
  };
  for (const doc of prodSnap.docs) {
    const d = doc.data();
    const es = d.ops?.listingStatus?.ebay;
    const ks = d.ops?.listingStatus?.kaufland;
    if (es === 'active') prodListingStatus.ebayActive++;
    else if (es === 'inactive') prodListingStatus.ebayInactive++;
    else if (es === 'not_listed') prodListingStatus.ebayNotListed++;
    else prodListingStatus.ebayNull++;

    if (ks === 'active') prodListingStatus.klActive++;
    else if (ks === 'inactive') prodListingStatus.klInactive++;
    else if (ks === 'not_listed') prodListingStatus.klNotListed++;
    else prodListingStatus.klNull++;
  }
  console.log(`  eBay status on products_v2:`);
  console.log(`    active:     ${prodListingStatus.ebayActive}`);
  console.log(`    inactive:   ${prodListingStatus.ebayInactive}`);
  console.log(`    not_listed: ${prodListingStatus.ebayNotListed}`);
  console.log(`    null/miss:  ${prodListingStatus.ebayNull}`);
  console.log(`\n  Kaufland status on products_v2:`);
  console.log(`    active:     ${prodListingStatus.klActive}`);
  console.log(`    inactive:   ${prodListingStatus.klInactive}`);
  console.log(`    not_listed: ${prodListingStatus.klNotListed}`);
  console.log(`    null/miss:  ${prodListingStatus.klNull}`);

  console.log('\n' + DIVIDER);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Audit failed:', e.message);
  process.exit(1);
});
