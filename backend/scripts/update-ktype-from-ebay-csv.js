/* eslint-disable no-console */
/**
 * Bulk update AvyCloud "K-Typ" attribute based on an eBay compatibility export CSV.
 *
 * Input file format: same as ktype3012.csv (Revise rows + Compatibility rows).
 *
 * Writes:
 * - details.attributes["K-Typ"] = formatted string
 * - ops.last_saved_source = "ktype-import"
 * - ops.last_saved_iso = now
 * - ops.revision += 1
 * - ops.sync_status = "pending" (so UI indicates re-sync is needed)
 *
 * Usage (dry-run default):
 *   KTYPE_CSV_PATH=/path/to/ktype.csv node backend/scripts/update-ktype-from-ebay-csv.js --dry-run
 *
 * Apply:
 *   KTYPE_CSV_PATH=/path/to/ktype.csv node backend/scripts/update-ktype-from-ebay-csv.js --apply
 *
 * Note:
 * - When running from repo root, Node must resolve backend dependencies.
 *   Example:
 *     NODE_PATH=backend/node_modules KTYPE_CSV_PATH=... node backend/scripts/update-ktype-from-ebay-csv.js --apply
 */

const fs = require('fs');
const path = require('path');
const { parseKTypeEbayCsvToSkuMap } = require('../lib/ktype');
const { getAllProductsForTenant } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');

// products_v2-Migration (D.0b): Dokument-IDs sind EAN/UUID, NICHT mehr die SKU.
// Lookup läuft daher über identification.sku; Writes regelkonform über
// saveProductV2 (CLAUDE.md #7) statt direktem docRef.set auf 'products'.
const TENANT_ID = process.env.TENANT_ID || 'avycloud';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DRY_RUN = !APPLY || argv.includes('--dry-run');

const INPUT_PATH = String(process.env.KTYPE_CSV_PATH || process.env.CSV_PATH || '').trim();
if (!INPUT_PATH) {
  console.error('Missing KTYPE_CSV_PATH env. Example: KTYPE_CSV_PATH=/Users/oguz/Dev/avycloud/ktype3012.csv');
  process.exit(1);
}

const resolved = path.resolve(INPUT_PATH);
if (!fs.existsSync(resolved)) {
  console.error('CSV file not found:', resolved);
  process.exit(1);
}

const findExistingKTyp = (attrs = {}) => {
  const keys = Object.keys(attrs || {});
  const key = keys.find((k) => {
    const lower = String(k || '').trim().toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
  if (!key) return '';
  const raw = attrs[key];
  return raw == null ? '' : String(raw).trim();
};

async function main() {
  const csv = fs.readFileSync(resolved, 'utf8');
  const { skuToKTyp, stats } = parseKTypeEbayCsvToSkuMap(csv);

  const report = {
    inputPath: resolved,
    dryRun: DRY_RUN,
    parsed: stats,
    processed: 0,
    updated: 0,
    unchanged: 0,
    notFound: [],
    errors: [],
  };

  const entries = Object.entries(skuToKTyp);
  console.log(`Parsed ${entries.length} SKU mappings from CSV (${stats.entries} compatibility entries).`);
  console.log('[INFO] TENANT_ID=%s (override via env)', TENANT_ID);

  const all = await getAllProductsForTenant(TENANT_ID);
  const bySku = new Map();
  for (const p of all || []) {
    const sku = String(p?.identification?.sku || '').trim();
    if (sku && !bySku.has(sku)) bySku.set(sku, p);
  }

  for (const [sku, ktyp] of entries) {
    report.processed += 1;
    try {
      const product = bySku.get(String(sku).trim());
      if (!product) {
        report.notFound.push(sku);
        continue;
      }

      const existing = findExistingKTyp(product?.details?.attributes || {});
      if (existing === String(ktyp || '').trim()) {
        report.unchanged += 1;
        continue;
      }

      if (!DRY_RUN) {
        product.details = product.details || {};
        product.details.attributes =
          product.details.attributes && typeof product.details.attributes === 'object'
            ? product.details.attributes
            : {};
        product.details.attributes['K-Typ'] = String(ktyp).trim();
        await saveProductV2(product, { mode: 'system', source: 'ktype-import' });
      }

      report.updated += 1;
      if (report.updated <= 5) {
        console.log(`[${DRY_RUN ? 'DRY-RUN' : 'APPLY'}] ${sku}: updated K-Typ (${String(ktyp).length} chars)`);
      }
    } catch (error) {
      report.errors.push({ sku, message: error?.message || String(error) });
      console.warn(`Failed to update ${sku}:`, error?.message || error);
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


