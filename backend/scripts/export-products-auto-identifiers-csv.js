/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Export Firestore `products` as a CSV for the "Auto" category (Auto & Motorrad).
 *
 * Columns (as requested):
 * - EAN
 * - SKU
 * - Teilenummer/Herstellernummer
 * - OE/OEM
 * - Name
 *
 * Category filter:
 * - Matches eBay breadcrumb starting with/containing "Auto & Motorrad"
 * - Uses product.identification.category, details.attributes.Kategorie, or ebay categories map via details.categoryId
 *
 * Usage:
 *   node backend/scripts/export-products-auto-identifiers-csv.js --out exports/products_auto_identifiers.csv
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts, getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
const { isValidGtin, normalizeDigits } = require('../lib/gtin');

let EBAY_CATEGORIES = null;
function getEbayCategories() {
  if (EBAY_CATEGORIES) return EBAY_CATEGORIES;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    EBAY_CATEGORIES = require('../ebay-data/categories.json');
  } catch (e) {
    console.warn('Failed to load ebay categories.json:', e.message);
    EBAY_CATEGORIES = {};
  }
  return EBAY_CATEGORIES;
}

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

function lower(s) {
  return safeString(s).toLowerCase();
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickValidEanOrGtin(product) {
  const ids = product?.details?.identifiers || {};
  const candidates = []
    .concat([ids.ean, ids.gtin, ids.upc])
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

function pickPartNumber(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};

  const mpn = safeString(ids.mpn);
  if (mpn) return mpn;

  if (attrs && typeof attrs === 'object') {
    const candidates = [
      'herstellernummer',
      'teilenummer',
      'teilnummer',
      'mpn',
      'manufacturer part number',
      'manufacturerpartnumber',
      'artikelnummer hersteller',
      'artikelnummer',
      'model number',
      'modelnumber',
      'modellnummer',
    ];
    for (const key of Object.keys(attrs)) {
      const k = lower(key);
      if (!candidates.includes(k)) continue;
      const val = safeString(attrs[key]);
      if (val) return val;
    }
  }

  return '';
}

function extractOeFromTitle(title = '') {
  const t = safeString(title);
  if (!t) return '';
  // Examples: "OE 2048660221", "(OE 1403300051)", "OEM 1K0-..."
  const m = t.match(/\b(?:oe|oem)\b[^\w]*([A-Z0-9][A-Z0-9\-]{4,})/i);
  return m && m[1] ? String(m[1]).trim() : '';
}

function pickOeOem(product) {
  const attrs = product?.details?.attributes || {};
  const keys = Object.keys(attrs || {});
  const keyCandidates = [
    'oe/oem referenznummer(n)',
    'referenznummer(n) oem',
    'oem-referenznummer',
    'oem referenznummer',
    'referenznummer',
    'oe nummer',
    'oe-nummer',
    'oe',
    'oem',
  ];

  for (const k of keys) {
    const lk = lower(k);
    if (!keyCandidates.includes(lk)) continue;
    const v = safeString(attrs[k]);
    if (v) return v;
  }

  // Fallback: extract from title if explicitly present (not guessed)
  return extractOeFromTitle(product?.identification?.name || '');
}

function resolveCategoryBreadcrumb(product) {
  const direct = safeString(product?.identification?.category);
  if (direct) return direct;
  const attrs = product?.details?.attributes || {};
  const attrCat = safeString(attrs?.Kategorie);
  if (attrCat) return attrCat;
  const catId = safeString(product?.details?.categoryId);
  if (catId) {
    const categories = getEbayCategories();
    const breadcrumb = categories?.[catId]?.breadcrumb;
    if (breadcrumb) return String(breadcrumb);
  }
  return '';
}

function isAutoCategory(product) {
  const breadcrumb = lower(resolveCategoryBreadcrumb(product));
  if (!breadcrumb) return false;
  // eBay German taxonomy: "Auto & Motorrad: Teile ..." / "Auto & Motorrad: Fahrzeuge ..."
  if (breadcrumb.includes('auto & motorrad')) return true;
  // Defensive fallbacks
  if (breadcrumb.includes('autoteile')) return true;
  if (breadcrumb.includes('kfz')) return true;
  if (breadcrumb.includes('motorrad')) return true;
  return false;
}

function parseArgs(argv) {
  const args = { out: path.join(process.cwd(), 'exports', 'products_auto_identifiers.csv') };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  ensureDir(path.dirname(outPath));

  const products = await getAllProductsForTenant(TENANT_ID);
  const headers = ['EAN', 'SKU', 'Teilenummer/Herstellernummer', 'OE/OEM', 'Name'];
  const lines = [];
  lines.push(headers.join(','));

  let exported = 0;
  let considered = 0;
  for (const product of products) {
    considered += 1;
    if (!isAutoCategory(product)) continue;
    exported += 1;
    const row = [
      pickValidEanOrGtin(product),
      pickSku(product),
      pickPartNumber(product),
      pickOeOem(product),
      safeString(product?.identification?.name),
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`[export] auto_identifiers considered=${considered} rows=${exported} -> ${outPath}`);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});

