/**
 * Import/Enrichment aus BaseLinker-CSV
 * - Match per SKU, sonst EAN
 * - Ergänzt fehlende Felder: Name, Kategorie, Beschreibung, Bilder, Preis, Bestand
 * - Überschreibt keine vorhandenen Preise/Bilder/Beschreibung, wenn schon gesetzt
 *
 * Usage:
 *   CSV_PATH=/Users/oguz/Dev/avycloud/BL__Products__default_CSV_2025-12-17_18_28.csv node backend/scripts/import-csv-baselinker.js
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { firestore, findProductByStrictIdentifier, saveProduct } = require('../lib/firestore');

const CSV_PATH =
  process.env.CSV_PATH || '/Users/oguz/Dev/avycloud/BL__Products__default_CSV_2025-12-17_18_28.csv';

const normalize = (v) => (v == null ? '' : String(v).trim());
const toNumber = (v) => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

function mergeImages(existing = [], urls = []) {
  const seen = new Set();
  const out = [];
  const add = (url) => {
    const u = normalize(url);
    if (!u || !u.startsWith('http')) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push({ url_or_base64: u, source: 'baselinker-csv' });
  };
  (existing || []).forEach((img) => add(img.url_or_base64 || img.url || img.downloadUrl));
  urls.forEach(add);
  return out.slice(0, 10);
}

async function main() {
  const csvAbs = path.resolve(CSV_PATH);
  if (!fs.existsSync(csvAbs)) {
    throw new Error(`CSV not found: ${csvAbs}`);
  }
  const raw = fs.readFileSync(csvAbs, 'utf8');
  const records = parse(raw, {
    columns: true,
    delimiter: ';',
    skip_empty_lines: true,
    relax_quotes: true,
  });

  let matched = 0;
  let created = 0;
  let updated = 0;
  let errors = 0;

  for (const row of records) {
    try {
      const sku = normalize(row.product_sku);
      const ean = normalize(row.product_ean);
      const name = normalize(row.product_name);
      const category = normalize(row.product_category_name);
      const price = toNumber(row.price);
      const qty = toNumber(row.quantity) ?? 0;

      // collect images from photo + additional_photo_*
      const imageKeys = Object.keys(row).filter((k) => k.toLowerCase().startsWith('additional_photo') || k === 'photo');
      const urls = imageKeys.map((k) => row[k]).filter(Boolean);

      let docRef = null;
      if (sku) {
        const snap = await firestore.collection('products').doc(sku).get();
        if (snap.exists) docRef = snap;
      }
      if (!docRef && (sku || ean)) {
        const hit = await findProductByStrictIdentifier({ sku: sku || null, barcodes: ean ? [ean] : [] });
        if (hit) {
          docRef = await firestore.collection('products').doc(hit.id).get();
        }
      }

      let data = {};
      if (docRef && docRef.exists) {
        data = docRef.data() || {};
        matched += 1;
      } else {
        // create skeleton
        data = {
          id: sku || ean || row.product_id || `csv-${Date.now()}`,
          identification: {
            sku: sku || ean || row.product_id || '',
            name: name || 'Unbenanntes Produkt',
            brand: normalize(row.product_manufacturer_name) || '',
            category: category || '',
            barcodes: ean ? [ean] : [],
          },
          details: {
            identifiers: {
              sku: sku || undefined,
              ean: ean || undefined,
              gtin: ean || undefined,
            },
            pricing: {
              lowest_price: {
                amount: price || 0,
                currency: 'EUR',
                sources: [],
              },
              price_confidence: price ? 1 : 0,
            },
            images: mergeImages([], urls),
            attributes: {},
            short_description: name || '',
          },
          inventory: { quantity: qty || 0 },
          ops: { sync_status: 'pending', revision: 0 },
        };
        created += 1;
      }

      // merge (only fill gaps)
      data.identification = data.identification || {};
      if (name && !data.identification.name) data.identification.name = name;
      if (category && !data.identification.category) data.identification.category = category;
      if (ean) {
        if (!Array.isArray(data.identification.barcodes)) data.identification.barcodes = [];
        if (!data.identification.barcodes.includes(ean)) data.identification.barcodes.push(ean);
      }
      data.details = data.details || {};
      data.details.identifiers = data.details.identifiers || {};
      if (ean && !data.details.identifiers.ean) data.details.identifiers.ean = ean;
      if (ean && !data.details.identifiers.gtin) data.details.identifiers.gtin = ean;
      if (sku && !data.details.identifiers.sku) data.details.identifiers.sku = sku;

      // description
      if (row.description && !data.details.short_description) {
        data.details.short_description = normalize(row.description);
      }

      // images merge
      const existingImgs = Array.isArray(data.details.images) ? data.details.images : [];
      data.details.images = mergeImages(existingImgs, urls);

      // price: only if none set
      const existingPrice = data.details?.pricing?.lowest_price;
      const existingValid = existingPrice && Number(existingPrice.amount) > 0;
      if (price && !existingValid) {
        data.details.pricing = {
          lowest_price: { amount: price, currency: 'EUR', sources: [] },
          price_confidence: 1,
        };
      }

      // quantity: take max to avoid losing stock
      const existingQty = Number(data.inventory?.quantity) || 0;
      data.inventory = { ...(data.inventory || {}), quantity: Math.max(existingQty, qty || 0) };

      await saveProduct({ ...data, id: data.id || sku || ean });
      if (docRef && docRef.exists) updated += 1;
    } catch (err) {
      errors += 1;
      console.error('Fehler bei Zeile', row.product_sku || row.product_ean || row.product_id, err.message);
    }
  }

  console.log(
    JSON.stringify(
      { records: records.length, matched, created, updated, errors },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
