/* eslint-disable no-console */
/**
 * Bulk update products from a CSV/TSV file (supports multi-table exports) and persist to Firestore.
 *
 * Why:
 * - After recent fixes, manual UI saves can overwrite descriptions and delete/replace attributes.
 * - This script applies a spreadsheet export reliably and deterministically.
 *
 * Expected file:
 * - CSV (comma-separated) or TSV (tab-separated), with a header row that includes "SKU".
 * - Supports multi-table exports: the file may contain multiple header rows (each starting with "SKU"),
 *   separated by blank lines. Each header starts a new section.
 * - Optional: "Title" (identification.name), "Marke" (identification.brand), "Herstellernummer" (details.identifiers.mpn).
 * - Any other columns are written to details.attributes using the column name as key.
 *
 * Deletions:
 * - Empty cell -> ignored by default (keeps existing values).
 * - Cell value "Unbekannt" (case-insensitive) -> treated as empty -> deletes.
 * - Use "--blank=delete" to delete existing attribute values when the cell is empty.
 *
 * Usage:
 *   TABLE_PATH=/path/to/updates.csv node backend/scripts/bulk-update-products-from-tsv.js --apply
 *
 * Optional:
 *   --dry-run                Print changes but do not write (default)
 *   --apply                  Write changes to Firestore
 *   --sync-baselinker        After save, sync each updated product to BaseLinker (inventory 78659 by default)
 *   --blank=delete|keep      How to treat empty cells for attributes (default: delete)
 *
 * Env:
 * - BASELINKER_INVENTORY_ID  (optional) defaults to 78659
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { getProduct, saveProduct } = require('../lib/firestore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SYNC_BASELINKER = argv.includes('--sync-baselinker');
const blankArg = argv.find((arg) => arg.startsWith('--blank='));
const BLANK_MODE = (blankArg ? blankArg.split('=')[1] : 'keep') || 'keep';
const BLANK_DELETE = BLANK_MODE.toLowerCase() === 'delete';

const INPUT_PATH = String(process.env.TABLE_PATH || process.env.TSV_PATH || '').trim();
if (!INPUT_PATH) {
  console.error(
    'Missing TABLE_PATH env. Example: TABLE_PATH=/Users/oguz/Downloads/updates.csv'
  );
  process.exit(1);
}

const resolved = path.resolve(INPUT_PATH);
if (!fs.existsSync(resolved)) {
  console.error('Input file not found:', resolved);
  process.exit(1);
}

const normalizeCell = (value) => {
  const v = value == null ? '' : String(value);
  const trimmed = v.trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === 'unbekannt') return '';
  return trimmed;
};

function inferDelimiter(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.tsv' || ext === '.tab') return '\t';
  return ','; // default CSV
}

function isEmptyRow(row = []) {
  return !Array.isArray(row) || row.every((cell) => normalizeCell(cell) === '');
}

function isHeaderRow(row = []) {
  const first = normalizeCell(row[0]);
  return first.toUpperCase() === 'SKU';
}

function parseMultiTable(content, delimiter) {
  // Official docs: https://csv.js.org/parse/api/sync/
  const rows = parse(content, {
    delimiter,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
  });

  let currentHeader = null;
  let sectionIndex = 0;
  const records = [];

  for (const row of rows) {
    if (isEmptyRow(row)) continue;
    if (isHeaderRow(row)) {
      currentHeader = row.map((h) => normalizeCell(h));
      sectionIndex += 1;
      continue;
    }
    if (!currentHeader) continue;

    const skuCell = normalizeCell(row[0]);
    if (!skuCell || !skuCell.toUpperCase().startsWith('SKU-')) continue;

    const obj = {};
    currentHeader.forEach((key, idx) => {
      if (!key) return;
      obj[key] = row[idx] ?? '';
    });
    records.push({ sectionIndex, header: currentHeader, row: obj });
  }

  return records;
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
      if (BLANK_DELETE) {
        // Delete explicit column keys when empty
        if (Object.prototype.hasOwnProperty.call(next, key)) {
          delete next[key];
        }
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
  const delimiter = inferDelimiter(resolved);
  const records = parseMultiTable(raw, delimiter);
  if (!records.length) {
    throw new Error(
      'No records found. Ensure the file contains at least one header row starting with "SKU" and data rows starting with "SKU-".'
    );
  }

  const report = {
    inputPath: resolved,
    delimiter: delimiter === '\t' ? 'tab' : 'comma',
    apply: APPLY,
    syncBaseLinker: SYNC_BASELINKER,
    blankMode: BLANK_DELETE ? 'delete' : 'keep',
    processed: 0,
    updated: 0,
    sections: {},
    notFound: [],
    errors: [],
  };

  for (const entry of records) {
    const header = entry.header || [];
    const row = entry.row || {};
    const sectionIndex = entry.sectionIndex || 0;
    report.sections[sectionIndex] = (report.sections[sectionIndex] || 0) + 1;

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

      const brand =
        normalizeCell(row.Marke) || normalizeCell(row.Hersteller) || normalizeCell(row.Verlag);
      if (brand) {
        next.identification.brand = brand;
      }

      const mpn = normalizeCell(row.Herstellernummer);
      if (mpn) {
        next.details.identifiers.mpn = mpn;
      } else if (
        BLANK_DELETE &&
        row.Herstellernummer !== undefined &&
        normalizeCell(row.Herstellernummer) === ''
      ) {
        // Explicit empty -> clear mpn
        if (Object.prototype.hasOwnProperty.call(next.details.identifiers, 'mpn')) {
          delete next.details.identifiers.mpn;
        }
      }

      // Optional identifier columns (if present in a section)
      const normalizeDigits = (val) => normalizeCell(val).replace(/\D+/g, '');
      const upsertBarcode = (digits) => {
        if (!digits) return;
        if (!next.identification) next.identification = {};
        const current = Array.isArray(next.identification.barcodes) ? next.identification.barcodes : [];
        const set = new Set(current.map((v) => normalizeDigits(v)).filter(Boolean));
        set.add(digits);
        next.identification.barcodes = Array.from(set);
      };

      const ean = row.EAN !== undefined ? normalizeDigits(row.EAN) : '';
      if (ean) {
        next.details.identifiers.ean = ean;
        upsertBarcode(ean);
      } else if (row.EAN !== undefined && BLANK_DELETE) {
        if (Object.prototype.hasOwnProperty.call(next.details.identifiers, 'ean')) {
          delete next.details.identifiers.ean;
        }
      }

      const gtin = row.GTIN !== undefined ? normalizeDigits(row.GTIN) : '';
      if (gtin) {
        next.details.identifiers.gtin = gtin;
        upsertBarcode(gtin);
      } else if (row.GTIN !== undefined && BLANK_DELETE) {
        if (Object.prototype.hasOwnProperty.call(next.details.identifiers, 'gtin')) {
          delete next.details.identifiers.gtin;
        }
      }

      const upc = row.UPC !== undefined ? normalizeDigits(row.UPC) : '';
      if (upc) {
        next.details.identifiers.upc = upc;
        upsertBarcode(upc);
      } else if (row.UPC !== undefined && BLANK_DELETE) {
        if (Object.prototype.hasOwnProperty.call(next.details.identifiers, 'upc')) {
          delete next.details.identifiers.upc;
        }
      }

      // Attributes: apply per-column updates (delete on blank)
      const existingAttrs = next.details.attributes && typeof next.details.attributes === 'object'
        ? next.details.attributes
        : {};
      next.details.attributes = computeUpdatedAttributes(existingAttrs, header, row);

      const changedPreview = {
        sku,
        section: sectionIndex,
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
        source: 'bulk-table',
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


