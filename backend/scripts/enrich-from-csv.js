/**
 * Ergänzt vorhandene Firestore-Produkte mit Daten aus einem CSV-Backup
 * Matching per EAN (barcodes/details.identifiers).
 *
 * Usage:
 *   CSV_PATH=/Users/oguz/Downloads/products_backup_1412.csv node backend/scripts/enrich-from-csv.js
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const {
  findProductByStrictIdentifier,
  saveProduct,
} = require('../lib/firestore');

const CSV_PATH =
  process.env.CSV_PATH || '/Users/oguz/Downloads/products_backup_1412.csv';

function normalizeNumberString(val) {
  return (val || '').toString().replace(/\D+/g, '').trim();
}

function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const csvAbs = path.resolve(CSV_PATH);
  if (!fs.existsSync(csvAbs)) {
    throw new Error(`CSV nicht gefunden: ${csvAbs}`);
  }
  const raw = fs.readFileSync(csvAbs, 'utf8');
  // CSV enthält teils ungequotete Kommata in Category -> manuelle Normalisierung
  const rows = parse(raw, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
  });

  if (!rows.length) {
    console.log('Keine Zeilen im CSV gefunden');
    return;
  }

  const header = rows[0];
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    let r = rows[i];
    if (!Array.isArray(r)) continue;
    if (r.length < 9) continue;
    if (r.length > 9) {
      const extra = r.length - 9;
      const catParts = r.slice(4, 5 + extra);
      const fixed = [
        r[0], // ID
        r[1], // ProductKey
        r[2], // Name
        r[3], // Brand
        catParts.join(', '), // Category (zusammengeführt)
        ...r.slice(5 + extra), // EAN, Price, Currency, Sync
      ];
      r = fixed;
    }
    if (r.length !== 9) continue;
    records.push({
      ID: r[0],
      ProductKey: r[1],
      Name: r[2],
      Brand: r[3],
      Category: r[4],
      EAN: r[5],
      Price: r[6],
      Currency: r[7],
      SyncStatus: r[8],
    });
  }

  let matched = 0;
  let updated = 0;
  let noMatch = 0;

  for (const row of records) {
    const ean =
      normalizeNumberString(row.EAN) ||
      normalizeNumberString(row.ProductKey) ||
      normalizeNumberString(row.ID);
    if (!ean || ean.length < 6) {
      continue;
    }

    const product = await findProductByStrictIdentifier({
      barcodes: [ean],
    });
    if (!product) {
      noMatch += 1;
      continue;
    }

    matched += 1;
    const next = JSON.parse(JSON.stringify(product));

    next.identification = next.identification || {};
    next.details = next.details || {};
    next.details.identifiers = next.details.identifiers || {};

    // Name
    if (!next.identification.name && row.Name) {
      next.identification.name = row.Name;
    }
    // Brand
    if (!next.identification.brand && row.Brand) {
      next.identification.brand = row.Brand;
    }
    // Category
    if (!next.identification.category && row.Category) {
      next.identification.category = row.Category;
    }
    // EAN/GTIN
    if (!next.details.identifiers.ean) {
      next.details.identifiers.ean = ean;
    }
    if (!next.details.identifiers.gtin) {
      next.details.identifiers.gtin = ean;
    }
    if (!Array.isArray(next.identification.barcodes)) {
      next.identification.barcodes = [];
    }
    if (!next.identification.barcodes.includes(ean)) {
      next.identification.barcodes.push(ean);
    }

    // Price
    const price = toNumber(row.Price);
    const hasIncomingPrice = price !== null && price > 0;
    const existingPrice = next?.details?.pricing?.lowest_price;
    const existingValid =
      existingPrice &&
      typeof existingPrice.amount === 'number' &&
      Number(existingPrice.amount) > 0;
    if (hasIncomingPrice && !existingValid) {
      next.details.pricing = {
        lowest_price: {
          amount: price,
          currency: row.Currency || 'EUR',
          sources: [],
        },
        price_confidence: 1,
      };
    }

    // Only save if something changed
    const before = JSON.stringify(product);
    const after = JSON.stringify(next);
    if (before !== after) {
      await saveProduct(next);
      updated += 1;
    }
  }

  console.log(
    JSON.stringify(
      { records: records.length, matched, updated, noMatch },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
