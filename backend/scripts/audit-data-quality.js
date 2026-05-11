/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Audit Firestore `products` for data-quality regressions.
 *
 * Usage:
 *   node backend/scripts/audit-data-quality.js
 *
 * Output:
 *   exports/audit/<timestamp>/audit_summary.json
 *   exports/audit/<timestamp>/audit_rows.csv
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts, getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
const { isValidGtin } = require('../lib/gtin');
const { containsBannedListingText, PRICE_SENTENCE_RE, PLACEHOLDER_RE, UI_TEMPLATE_RE } = require('../lib/listing-sanitize');
const { findEbayCategory } = require('../lib/ebay-taxonomy');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickBarcodes(product) {
  const ids = product?.details?.identifiers || {};
  const list = []
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .concat([ids.ean, ids.gtin, ids.upc])
    .filter(Boolean)
    .map((v) => String(v).replace(/\D+/g, '').trim())
    .filter((v) => v.length >= 6);
  return Array.from(new Set(list));
}

function hasMetaAttrKey(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return false;
  if (k === 'sku' || k === 'id' || k === 'product_id' || k === 'product id') return true;
  if (k.includes('|de|')) return true;
  if (k.startsWith('text_')) return true;
  if (k.startsWith('features|')) return true;
  if (k.endsWith('_id')) return true;
  if (k.includes('ebay') || k.includes('kaufland')) return true;
  if (k.includes('category_id') || k === 'categoryid') return true;
  return false;
}

function buildFlags(product) {
  const flags = [];
  const title = safeString(product?.identification?.name);
  const shortDesc = safeString(product?.details?.short_description);
  const highlights = Array.isArray(product?.details?.key_features) ? product.details.key_features : [];
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  const category = safeString(product?.identification?.category);
  const categoryId = safeString(product?.details?.categoryId);

  const titleLen = title.length;
  if (titleLen < 70) flags.push('title_lt_70');
  if (titleLen > 80) flags.push('title_gt_80');

  const titleLower = title.toLowerCase();
  const hasUsedWord = /\b(gebraucht|used|pre[-\s]?owned|second hand|b-ware|refurb)/i.test(titleLower);
  if (hasUsedWord && !product?.ops?.condition_locked) flags.push('title_mentions_used_without_lock');

  if (containsBannedListingText(shortDesc)) flags.push('short_description_banned_text');
  if (PLACEHOLDER_RE.test(shortDesc) || UI_TEMPLATE_RE.test(shortDesc)) flags.push('short_description_placeholder');
  if (PRICE_SENTENCE_RE.test(shortDesc)) flags.push('short_description_price');

  if (highlights.some((h) => PRICE_SENTENCE_RE.test(String(h || '')))) flags.push('highlights_price');
  if (highlights.some((h) => PLACEHOLDER_RE.test(String(h || '')))) flags.push('highlights_placeholder');

  const attrKeys = Object.keys(attrs || {});
  if (attrKeys.some((k) => String(k || '').trim().toLowerCase() === 'sku')) flags.push('attributes_has_sku_key');
  if (attrKeys.some((k) => hasMetaAttrKey(k))) flags.push('attributes_has_meta_keys');

  const codes = pickBarcodes(product);
  if (!codes.length) flags.push('barcode_missing');
  const invalid = codes.filter((c) => [8, 12, 13, 14].includes(c.length) && !isValidGtin(c));
  if (invalid.length) flags.push('barcode_invalid_checkdigit');
  const weirdLength = codes.filter((c) => ![8, 12, 13, 14].includes(c.length));
  if (weirdLength.length) flags.push('barcode_nonstandard_length');

  // Category quality:
  // - Prefer having a canonical eBay categoryId
  // - Prefer having a breadcrumb path (>=2 levels) for listing/category consistency
  if (!categoryId) {
    flags.push('category_id_missing');
  } else {
    const resolved = findEbayCategory(categoryId);
    const breadcrumb = safeString(resolved?.breadcrumb);
    if (!breadcrumb) {
      flags.push('category_id_unknown');
    } else if (!breadcrumb.includes('>')) {
      flags.push('category_too_broad');
    }
  }
  if (!category) flags.push('category_text_missing');
  if (category && !category.includes('>')) flags.push('category_text_not_breadcrumb');

  return { flags, invalidBarcodes: invalid, nonstandardBarcodes: weirdLength };
}

async function main() {
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'audit', stamp);
  ensureDir(outDir);

  const products = await getAllProductsForTenant(TENANT_ID);
  const summary = {
    total: products.length,
    flags: {},
  };

  const rows = [];
  for (const product of products) {
    const sku = pickSku(product);
    const title = safeString(product?.identification?.name);
    const brand = safeString(product?.identification?.brand);
    const category = safeString(product?.identification?.category);
    const codes = pickBarcodes(product);
    const { flags, invalidBarcodes, nonstandardBarcodes } = buildFlags(product);

    flags.forEach((flag) => {
      summary.flags[flag] = (summary.flags[flag] || 0) + 1;
    });

    rows.push({
      productId: safeString(product?.id),
      sku,
      title,
      title_len: title.length,
      brand,
      category,
      barcode_count: codes.length,
      invalid_barcodes: invalidBarcodes.join('|'),
      nonstandard_barcodes: nonstandardBarcodes.join('|'),
      flags: flags.join('|'),
    });
  }

  // Write CSV rows (stable headers)
  const headers = [
    'productId',
    'sku',
    'title',
    'title_len',
    'brand',
    'category',
    'barcode_count',
    'invalid_barcodes',
    'nonstandard_barcodes',
    'flags',
  ];
  const lines = [];
  lines.push(headers.join(','));
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? '')).join(','));
  }

  fs.writeFileSync(path.join(outDir, 'audit_rows.csv'), lines.join('\n'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'audit_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[audit] total=${summary.total}`);
  console.log(`[audit] summary=${path.join(outDir, 'audit_summary.json')}`);
  console.log(`[audit] rows=${path.join(outDir, 'audit_rows.csv')}`);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});


