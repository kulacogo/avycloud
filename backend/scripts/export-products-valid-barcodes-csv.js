/* eslint-disable no-console */
/**
 * Export Firestore `products` as a CSV containing ONLY products with a VALID EAN (13) or GTIN (14).
 *
 * Output columns (as requested):
 * - Name
 * - Marke
 * - EAN
 * - Herstellernummer
 * - Artikelnummer
 *
 * Usage:
 *   node backend/scripts/export-products-valid-barcodes-csv.js --out exports/products_valid_barcodes.csv --tenant avycloud
 *
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 */

const fs = require('fs');
const path = require('path');
const { getAllProductsForTenant } = require('../lib/firestore');
const { isValidGtin, normalizeDigits } = require('../lib/gtin');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = normalizeNewlines(value);
  // Quote if contains delimiter/quote/newline or leading/trailing spaces (Excel safety)
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickHerstellernummer(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};

  const mpn = safeString(ids.mpn);
  if (mpn) return mpn;

  if (attrs && typeof attrs === 'object') {
    // Case-insensitive key match across common variants
    const candidates = [
      'herstellernummer',
      'mpn',
      'manufacturer part number',
      'manufacturerpartnumber',
      'modellnummer',
      'model number',
      'modelnumber',
      'artikelnummer hersteller',
    ];
    for (const key of Object.keys(attrs)) {
      const lower = String(key || '').trim().toLowerCase();
      if (!candidates.includes(lower)) continue;
      const val = safeString(attrs[key]);
      if (val) return val;
    }
  }

  return '';
}

function pickValidEanOrGtin(product) {
  const ids = product?.details?.identifiers || {};
  const candidates = []
    .concat([ids.ean, ids.gtin])
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .filter(Boolean)
    .map((v) => normalizeDigits(String(v)));

  const unique = Array.from(new Set(candidates)).filter(Boolean);
  const isValid13or14 = (code) =>
    (code.length === 13 || code.length === 14) && isValidGtin(code);

  // Prefer EAN-13, then GTIN-14
  const ean13 = unique.find((c) => c.length === 13 && isValidGtin(c));
  if (ean13) return ean13;
  const gtin14 = unique.find((c) => c.length === 14 && isValidGtin(c));
  if (gtin14) return gtin14;
  const any = unique.find(isValid13or14);
  return any || '';
}

function parseArgs(argv) {
  const args = { out: path.join(process.cwd(), 'exports', 'products_valid_barcodes.csv') };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (token === '--tenant') {
      args.tenant = argv[i + 1];
      i += 1;
    }
  }
  if (!args.tenant || typeof args.tenant !== 'string' || !args.tenant.trim()) {
    console.warn('[export-products-valid-barcodes-csv] No --tenant provided, defaulting to "avycloud".');
    args.tenant = 'avycloud';
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  ensureDir(path.dirname(outPath));

  const products = await getAllProductsForTenant(args.tenant);
  const headers = ['Name', 'Marke', 'EAN', 'Herstellernummer', 'Artikelnummer'];
  const lines = [];
  lines.push(headers.join(','));

  let exported = 0;
  for (const product of products) {
    const eanOrGtin = pickValidEanOrGtin(product);
    if (!eanOrGtin) continue;
    exported += 1;
    const row = [
      safeString(product?.identification?.name),
      safeString(product?.identification?.brand),
      eanOrGtin,
      pickHerstellernummer(product),
      pickSku(product),
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`[export] valid_barcodes rows=${exported} -> ${outPath}`);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});

