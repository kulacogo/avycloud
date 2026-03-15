#!/usr/bin/env node
'use strict';

/**
 * Debug: Fetch first 10 Kaufland units and print the raw API response.
 * Shows what fields are actually returned by the Kaufland API.
 * Usage: node backend/scripts/debug-kaufland-units.js
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });

const { listUnits } = require('../lib/kaufland-api');

async function main() {
  const units = await listUnits({ storefront: 'de', limit: 10, maxPages: 1 });
  console.log(`\nFetched ${units.length} units from Kaufland API\n`);

  for (const u of units.slice(0, 5)) {
    console.log('--- Unit ---');
    console.log('id_unit:', u.id_unit);
    console.log('id_offer:', u.id_offer);
    console.log('amount:', u.amount, '(type:', typeof u.amount, ')');
    console.log('status:', u.status);
    console.log('listing_price:', u.listing_price);
    console.log('price:', u.price);
    console.log('All top-level keys:', Object.keys(u).join(', '));
    if (u.product) {
      console.log('product keys:', Object.keys(u.product).join(', '));
      if (u.product.inventory) console.log('product.inventory:', u.product.inventory);
    }
    console.log('');
  }

  // Count how many have amount=0 vs >0 vs null/undefined
  let zeroCount = 0, posCount = 0, nullCount = 0;
  for (const u of units) {
    if (u.amount == null) nullCount++;
    else if (Number(u.amount) === 0) zeroCount++;
    else posCount++;
  }
  console.log(`\nTotal: ${units.length} units`);
  console.log(`  amount > 0: ${posCount}`);
  console.log(`  amount = 0: ${zeroCount}`);
  console.log(`  amount = null/undefined: ${nullCount}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
