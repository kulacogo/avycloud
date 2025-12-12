/**
 * Import missing products from products_export_0912.csv into Firestore.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud NODE_PATH=backend/node_modules node backend/scripts/import-missing-products-from-export.js
 *
 * This script:
 *  - Reads products_export_0912.csv (headers: ID, ProductKey, Name, Brand, Category, EAN, Price, Currency, Sync Status)
 *  - Loads existing product ids from Firestore (collection "products")
 *  - Inserts ONLY rows whose ProductKey is not already present
 *
 * Notes:
 *  - Uses ProductKey as Firestore document id
 *  - Sets identification.name/brand/category and sku (from ID or ProductKey)
 *  - Sets details.identifiers.ean/sku and a simple pricing.lowest_price
 *  - Sets ops.sync_status from CSV ("pending" etc.) and last_saved_iso now
 */

const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud';
const CSV_PATH = path.join(__dirname, '..', '..', 'products_export_0912.csv');
const PRODUCTS_COLLECTION = 'products';

async function main() {
  // Load CSV
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  const exportKeys = rows.map((r) => r.ProductKey).filter(Boolean);
  console.log(`CSV rows: ${rows.length}, ProductKeys: ${exportKeys.length}`);

  const db = new Firestore({ projectId: PROJECT_ID });

  // Load existing product ids
  const snap = await db.collection(PRODUCTS_COLLECTION).get();
  const liveIds = new Set();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    liveIds.add(String(data.id || doc.id));
  });
  console.log(`Existing products in Firestore: ${liveIds.size}`);

  // Build missing list
  const missingRows = rows.filter((r) => r.ProductKey && !liveIds.has(r.ProductKey));
  console.log(`Missing products to import: ${missingRows.length}`);

  let batch = db.batch();
  let batchCount = 0;
  const inserted = [];

  const nowIso = new Date().toISOString();

  const commitBatch = async () => {
    if (batchCount === 0) return;
    await batch.commit();
    console.log(`Committed batch of ${batchCount}`);
    batch = db.batch();
    batchCount = 0;
  };

  for (const row of missingRows) {
    const id = row.ProductKey;
    const docRef = db.collection(PRODUCTS_COLLECTION).doc(id);

    const name = (row.Name || '').trim() || id;
    const brand = (row.Brand || '').trim() || null;
    const category = (row.Category || '').trim() || null;
    const ean = (row.EAN || '').trim() || null;
    const price = row.Price ? parseFloat(row.Price) : null;
    const currency = (row.Currency || 'EUR').trim() || 'EUR';
    const syncStatus = (row['Sync Status'] || 'pending').toLowerCase();
    const sku = (row.ID || row.ProductKey || '').toString().trim() || null;

    const payload = {
      id,
      identification: {
        name,
        brand,
        category,
        sku,
      },
      details: {
        identifiers: {
          sku,
          ean,
        },
        pricing: {
          lowest_price: {
            amount: price,
            currency,
          },
        },
        attributes: {},
      },
      ops: {
        sync_status: syncStatus || 'pending',
        last_saved_iso: nowIso,
      },
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    batch.set(docRef, payload, { merge: false });
    batchCount += 1;
    inserted.push(id);

    if (batchCount >= 400) {
      await commitBatch();
    }
  }

  await commitBatch();
  console.log(`Inserted products: ${inserted.length}`);
  if (inserted.length) {
    console.log('Sample inserted ids:', inserted.slice(0, 10));
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
