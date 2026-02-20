/* eslint-disable no-console */
/**
 * Reconcile Firestore products with a BaseLinker product export CSV (comma-delimited).
 *
 * Goals (SAFE by default):
 * - Match products by SKU/EAN and fill ONLY missing metadata (name/category/identifiers).
 * - Backfill BaseLinker linkage (ops.baselinker.product_id, ops.base_product_id) when missing.
 * - Update baselinker_sku_index entries for SKU/EAN -> productId (Firestore doc id).
 * - NEVER touch warehouse fields: storage, storageBins, inventory (unless explicitly enabled later).
 *
 * Usage:
 *   BL_CSV_PATH=/Users/oguz/Dev/avycloud/exports/BL\\ products.csv node backend/scripts/reconcile-baselinker-export-products.js
 *
 * Flags:
 *   --apply                 Actually write changes to Firestore. Default: dry-run.
 *   --create-missing        Create missing products (skeleton) when no match is found.
 *   --force-baselinker-id   If product already has a different ops.baselinker.product_id, overwrite it.
 *
 * Outputs:
 *   exports/reconciliation/reconcile-baselinker-export-report.json
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { firestore, findProductByStrictIdentifier, setSkuIndexEntry } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CREATE_MISSING = argv.includes('--create-missing');
const FORCE_BASELINKER_ID = argv.includes('--force-baselinker-id');

const CSV_PATH =
  process.env.BL_CSV_PATH ||
  process.env.CSV_PATH ||
  path.join(process.cwd(), 'exports', 'BL products.csv');

const normalizeString = (v) => (v == null ? '' : String(v).trim());

const normalizeSku = (v) => {
  const raw = normalizeString(v);
  return raw || null;
};

const normalizeDigits = (v) => {
  const digits = normalizeString(v).replace(/\D+/g, '');
  return digits || null;
};

const normalizeEan = (v) => {
  const digits = normalizeDigits(v);
  if (!digits) return null;
  // Keep shorter barcodes too (some exports lose leading zeros); we will add padded variants for lookup.
  if (digits.length < 6) return null;
  return digits;
};

const parseIntSafe = (v) => {
  const n = Number(normalizeString(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const parsePrice = (v) => {
  const raw = normalizeString(v);
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
};

const normalizeLocation = (v) => {
  const raw = normalizeString(v);
  if (!raw) return null;
  if (raw === '–' || raw === '—' || raw.toLowerCase() === 'null') return null;
  return raw;
};

const padLeft = (digits, len) => {
  const s = String(digits || '');
  if (!s) return null;
  if (s.length >= len) return s;
  return s.padStart(len, '0');
};

const buildBarcodeCandidates = (digits) => {
  const out = [];
  const add = (x) => {
    if (!x) return;
    const d = normalizeDigits(x);
    if (!d) return;
    if (!out.includes(d)) out.push(d);
  };

  add(digits);
  // Common: spreadsheet drops leading zeros; Firestore may store padded strings (UPC12 / EAN13)
  add(padLeft(digits, 12));
  add(padLeft(digits, 13));
  add(padLeft(digits, 14));
  return out.filter(Boolean);
};

const buildSkuIndexKey = (type, value) => {
  const v = normalizeString(value).toLowerCase().replace(/^sku[-\s_]*/i, '').replace(/\s+/g, '');
  return v ? `${type}:${v}` : null;
};

async function upsertSkuIndex({ productId, sku, ean, baseProductId }) {
  if (!baseProductId) return;
  const updatedAt = new Date().toISOString();
  const payload = {
    baseProductId,
    productId,
    sku: sku || null,
    ean: ean || null,
    updatedAt,
  };
  const keys = [
    sku ? buildSkuIndexKey('sku', sku) : null,
    ean ? buildSkuIndexKey('ean', ean) : null,
  ].filter(Boolean);
  if (!keys.length) return;
  await Promise.all(keys.map((key) => setSkuIndexEntry(key, payload)));
}

function buildProductSkeleton({ docId, sku, ean, name, category, baselinkerId, price, currency }) {
  const identifiers = {};
  if (sku) identifiers.sku = sku;
  if (ean) {
    identifiers.ean = ean;
    identifiers.gtin = ean;
  }
  const pricing =
    price && price > 0
      ? {
          lowest_price: {
            amount: price,
            currency: currency || 'EUR',
            sources: [],
          },
          price_confidence: 1,
        }
      : undefined;
  return {
    id: docId,
    identification: {
      method: 'barcode',
      name: name || docId,
      brand: '',
      category: category || '',
      confidence: 0,
      sku: sku || undefined,
      barcodes: ean ? [ean] : [],
    },
    details: {
      short_description: '',
      key_features: [],
      attributes: {},
      identifiers,
      images: [],
      pricing,
    },
    ops: {
      sync_status: 'pending',
      revision: 0,
      base_product_id: baselinkerId || null,
      baselinker: baselinkerId
        ? {
            product_id: baselinkerId,
          }
        : undefined,
      last_saved_iso: new Date().toISOString(),
    },
  };
}

async function main() {
  const csvAbs = path.resolve(CSV_PATH);
  if (!fs.existsSync(csvAbs)) {
    throw new Error(`BaseLinker export CSV not found: ${csvAbs}`);
  }

  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });

  const raw = fs.readFileSync(csvAbs, 'utf8');
  const records = parse(raw, {
    columns: true,
    delimiter: ',',
    skip_empty_lines: true,
    relax_quotes: true,
    bom: true,
  });

  const report = {
    csvPath: csvAbs,
    apply: APPLY,
    createMissing: CREATE_MISSING,
    forceBaselinkerId: FORCE_BASELINKER_ID,
    processed: 0,
    matched: 0,
    updated: 0,
    created: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
    samples: {
      conflicts: [],
      created: [],
      updated: [],
      errors: [],
    },
  };

  for (const row of records) {
    report.processed += 1;
    const baselinkerIdRaw = normalizeString(row.ID);
    const baselinkerId = baselinkerIdRaw ? Number(baselinkerIdRaw) : null;
    const sku = normalizeSku(row.SKU);
    const ean = normalizeEan(row.EAN);
    const name = normalizeString(row.Name) || null;
    const category = normalizeString(row.Kategorie) || null;
    const stock = parseIntSafe(row.Bestand);
    const price = parsePrice(row.Preis);
    const currency = normalizeString(row.Preis).includes('EUR') ? 'EUR' : null;
    const location = normalizeLocation(row.Location);

    try {
      const barcodeCandidates = ean ? buildBarcodeCandidates(ean) : [];
      let hit = null;
      if (sku || barcodeCandidates.length) {
        hit = await findProductByStrictIdentifier({
          sku: sku || null,
          barcodes: barcodeCandidates,
        });
      }

      let docId = hit?.id || null;
      let docSnap = null;
      if (docId) {
        docSnap = await firestore.collection('products').doc(docId).get();
        if (docSnap.exists) report.matched += 1;
      }

      if (!docSnap || !docSnap.exists) {
        if (!CREATE_MISSING) {
          report.skipped += 1;
          continue;
        }

        docId = sku || (barcodeCandidates[0] || null) || (baselinkerId ? `bl-${baselinkerId}` : null);
        if (!docId) {
          report.skipped += 1;
          continue;
        }

        const skeleton = buildProductSkeleton({
          docId,
          sku,
          ean: barcodeCandidates[0] || ean,
          name,
          category,
          baselinkerId: baselinkerId || null,
          price,
          currency,
        });

        if (APPLY) {
          await firestore.collection('products').doc(docId).set(skeleton, { merge: true });
          await upsertSkuIndex({
            productId: docId,
            sku,
            ean: barcodeCandidates[0] || ean,
            baseProductId: baselinkerId,
          });
        }

        report.created += 1;
        if (report.samples.created.length < 10) {
          report.samples.created.push({
            docId,
            sku,
            ean: barcodeCandidates[0] || ean,
            baselinkerId,
            name,
            category,
            stock,
            price,
            location,
          });
        }
        continue;
      }

      const data = docSnap.data() || {};
      const existingOps = data.ops || {};
      const existingIdentification = data.identification || {};
      const existingDetails = data.details || {};
      const existingIdentifiers = existingDetails.identifiers || {};

      const existingBaselinkerId =
        existingOps?.baselinker?.product_id != null ? Number(existingOps.baselinker.product_id) : null;
      const existingBaseProductId =
        existingOps?.base_product_id != null ? Number(existingOps.base_product_id) : null;

      if (
        baselinkerId &&
        // Conflict rules (safe defaults):
        // - If ops.baselinker.product_id is set and different -> conflict (unless forced)
        // - If ops.baselinker.product_id is NOT set, but ops.base_product_id is set and different -> conflict (unless forced)
        // - If ops.baselinker.product_id matches, but base_product_id differs, we will fix it (not a conflict)
        ((existingBaselinkerId && existingBaselinkerId !== baselinkerId) ||
          (!existingBaselinkerId && existingBaseProductId && existingBaseProductId !== baselinkerId)) &&
        !FORCE_BASELINKER_ID
      ) {
        report.conflicts += 1;
        if (report.samples.conflicts.length < 20) {
          report.samples.conflicts.push({
            docId,
            sku,
            ean: barcodeCandidates[0] || ean,
            baselinkerId_new: baselinkerId,
            baselinkerId_existing: existingBaselinkerId,
            baseProductId_existing: existingBaseProductId,
          });
        }
        continue;
      }

      const updateData = {};
      const setIfMissing = (pathKey, currentValue, nextValue) => {
        const cur = normalizeString(currentValue);
        const next = normalizeString(nextValue);
        if (!next) return;
        if (cur) return;
        updateData[pathKey] = nextValue;
      };

      // Identification basics (only fill gaps)
      setIfMissing('identification.name', existingIdentification.name, name);
      setIfMissing('identification.category', existingIdentification.category, category);
      setIfMissing('identification.sku', existingIdentification.sku, sku);

      // Identifiers (only fill gaps)
      setIfMissing('details.identifiers.sku', existingIdentifiers.sku, sku);
      const preferredEan = barcodeCandidates[0] || ean;
      setIfMissing('details.identifiers.ean', existingIdentifiers.ean, preferredEan);
      setIfMissing('details.identifiers.gtin', existingIdentifiers.gtin, preferredEan);
      setIfMissing('details.identifiers.upc', existingIdentifiers.upc, preferredEan);

      // Add barcode to identification.barcodes (append if missing)
      if (preferredEan) {
        const existingBarcodes = Array.isArray(existingIdentification.barcodes)
          ? existingIdentification.barcodes.map((x) => String(x))
          : [];
        if (!existingBarcodes.includes(preferredEan)) {
          updateData['identification.barcodes'] = [...existingBarcodes, preferredEan];
        }
      }

      // BaseLinker linkage (safe by default)
      if (baselinkerId) {
        updateData['ops.base_product_id'] = baselinkerId;
        updateData['ops.baselinker.product_id'] = baselinkerId;
        // Keep a snapshot for audit/debugging (does not affect warehouse logic)
        updateData['ops.baselinker_export'] = {
          product_id: baselinkerId,
          sku: sku || null,
          ean: preferredEan || null,
          stock: stock ?? null,
          price: price ?? null,
          currency: currency || null,
          location: location || null,
          seen_at_iso: new Date().toISOString(),
        };
      }

      const shouldWrite = Object.keys(updateData).length > 0;
      if (!shouldWrite) {
        report.skipped += 1;
        continue;
      }

      if (APPLY) {
        await firestore.collection('products').doc(docId).update(updateData);
        await upsertSkuIndex({
          productId: docId,
          sku: sku || existingIdentification.sku || existingIdentifiers.sku || null,
          ean: preferredEan || existingIdentifiers.ean || existingIdentifiers.gtin || null,
          baseProductId: baselinkerId || existingBaselinkerId || null,
        });
      }

      report.updated += 1;
      if (report.samples.updated.length < 10) {
        report.samples.updated.push({
          docId,
          sku,
          ean: preferredEan || null,
          baselinkerId,
          updatedFields: Object.keys(updateData),
        });
      }
    } catch (error) {
      report.errors += 1;
      if (report.samples.errors.length < 10) {
        report.samples.errors.push({
          rowSku: normalizeString(row.SKU),
          rowEan: normalizeString(row.EAN),
          message: error?.message || String(error),
        });
      }
      console.error('Reconcile error:', row.SKU || row.EAN || row.ID, error?.message || error);
    }
  }

  const outPath = path.join(outDir, 'reconcile-baselinker-export-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('Reconcile finished:', JSON.stringify(report, null, 2));
  console.log('Report written to:', outPath);
}

main().catch((err) => {
  console.error('Reconcile failed:', err);
  process.exit(1);
});


