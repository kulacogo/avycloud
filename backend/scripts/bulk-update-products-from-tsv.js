/* eslint-disable no-console */
/**
 * Bulk update products from a TSV (tab-separated) file and persist to Firestore.
 *
 * Why:
 * - After recent fixes, manual UI saves can overwrite descriptions and delete/replace attributes.
 * - This script applies a spreadsheet export reliably and deterministically.
 *
 * Expected TSV:
 * - First row is the header.
 * - Must include column "SKU" (Firestore product id).
 * - Optional: "Title" (identification.name), "Marke" (identification.brand), "Herstellernummer" (details.identifiers.mpn).
 * - Any other columns are written to details.attributes using the column name as key.
 *
 * Deletions:
 * - Empty cell -> deletes that attribute key from details.attributes.
 * - Cell value "Unbekannt" (case-insensitive) -> treated as empty -> deletes.
 *
 * Usage:
 *   TSV_PATH=/path/to/updates.tsv node backend/scripts/bulk-update-products-from-tsv.js --apply
 *
 * Optional:
 *   --dry-run                Print changes but do not write (default)
 *   --apply                  Write changes to Firestore
 *   --sync-baselinker        After save, sync each updated product to BaseLinker (inventory 78659 by default)
 *
 * Env:
 * - BASELINKER_INVENTORY_ID  (optional) defaults to 78659
 */

const fs = require('fs');
const path = require('path');
const { getProduct, saveProduct } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SYNC_BASELINKER = argv.includes('--sync-baselinker');

const TSV_PATH = process.env.TSV_PATH ? String(process.env.TSV_PATH) : '';
if (!TSV_PATH) {
  console.error('Missing TSV_PATH env. Example: TSV_PATH=/Users/oguz/Downloads/updates.tsv');
  process.exit(1);
}

const resolved = path.resolve(TSV_PATH);
if (!fs.existsSync(resolved)) {
  console.error('TSV file not found:', resolved);
  process.exit(1);
}

const normalizeCell = (value) => {
  const v = value == null ? '' : String(value);
  const trimmed = v.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'unbekannt') return '';
  return trimmed;
};

function parseTsv(content) {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.replace(/\uFEFF/g, '')) // BOM
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return { header: [], rows: [] };
  const header = lines[0].split('\t').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cols = line.split('\t');
    const row = {};
    header.forEach((key, idx) => {
      row[key] = cols[idx] ?? '';
    });
    return row;
  });
  return { header, rows };
}

function computeUpdatedAttributes(existingAttrs, header, row) {
  const next = { ...(existingAttrs || {}) };
  for (const key of header) {
    if (!key) continue;
    if (key === 'SKU' || key === 'Title') continue;
    // "Herstellernummer" is handled both as attribute and as identifiers.mpn (below)
    const raw = row[key];
    const value = normalizeCell(raw);
    if (!value) {
      // Delete explicit column keys when empty
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        delete next[key];
      }
      continue;
    }
    next[key] = value;
  }
  return next;
}

async function maybeSyncToBaseLinker(product) {
  if (!SYNC_BASELINKER) return null;
  const { syncProductToBaseLinker } = require('../lib/baselinker');
  const invId = String(process.env.BASELINKER_INVENTORY_ID || '78659').trim();
  return await syncProductToBaseLinker(product, invId);
}

async function main() {
  const raw = fs.readFileSync(resolved, 'utf8');
  const { header, rows } = parseTsv(raw);
  if (!header.length) {
    throw new Error('TSV has no header row');
  }
  if (!header.includes('SKU')) {
    throw new Error('TSV header must include column "SKU"');
  }

  const report = {
    tsvPath: resolved,
    apply: APPLY,
    syncBaseLinker: SYNC_BASELINKER,
    processed: 0,
    updated: 0,
    notFound: [],
    errors: [],
  };

  for (const row of rows) {
    const sku = normalizeCell(row.SKU);
    if (!sku) continue;
    report.processed += 1;

    try {
      const existing = await getProduct(sku);
      if (!existing) {
        report.notFound.push(sku);
        continue;
      }

      const next = JSON.parse(JSON.stringify(existing));
      if (!next.identification) next.identification = {};
      if (!next.details) next.details = {};
      if (!next.details.identifiers) next.details.identifiers = {};

      const title = normalizeCell(row.Title);
      if (title) {
        next.identification.name = title;
      }

      const brand = normalizeCell(row.Marke) || normalizeCell(row.Hersteller);
      if (brand) {
        next.identification.brand = brand;
      }

      const mpn = normalizeCell(row.Herstellernummer);
      if (mpn) {
        next.details.identifiers.mpn = mpn;
      } else if (row.Herstellernummer !== undefined && normalizeCell(row.Herstellernummer) === '') {
        // Explicit empty -> clear mpn
        if (Object.prototype.hasOwnProperty.call(next.details.identifiers, 'mpn')) {
          delete next.details.identifiers.mpn;
        }
      }

      // Attributes: apply per-column updates (delete on blank)
      const existingAttrs = next.details.attributes && typeof next.details.attributes === 'object'
        ? next.details.attributes
        : {};
      next.details.attributes = computeUpdatedAttributes(existingAttrs, header, row);

      const changedPreview = {
        sku,
        title: title || undefined,
        brand: brand || undefined,
        mpn: mpn || undefined,
        attrKeys: Object.keys(next.details.attributes || {}).length,
      };

      if (!APPLY) {
        console.log('[dry-run]', JSON.stringify(changedPreview));
        continue;
      }

      await saveProduct(next, {
        allowCategoryChange: true,
        mode: 'manual',
        source: 'bulk-tsv',
        overwriteTextFields: true,
        // We pass a full attribute map (existing + modifications), so replacement is safe and enables deletions.
        replaceAttributes: true,
        // We are not providing barcode columns here; do not change identifiers based on barcodes in bulk imports.
        syncIdentifiersFromBarcodes: false,
      });

      report.updated += 1;
      console.log('[updated]', sku);

      const syncRes = await maybeSyncToBaseLinker(await getProduct(sku));
      if (syncRes) {
        console.log('[baselinker]', sku, syncRes.status, syncRes.message || '');
      }
    } catch (err) {
      const message = err?.message || String(err);
      report.errors.push({ sku, message });
      console.error('[error]', sku, message);
    }
  }

  console.log('Bulk update finished:', JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


