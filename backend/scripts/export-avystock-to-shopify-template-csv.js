/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Export AvyStock (Firestore products) into Shopify product_template.csv format.
 *
 * Requirements (user):
 * - NO fake SKUs (never generate SKU-1/2/3). Only export products with a real SKU.
 * - Keep the template header exactly, fill rows with AvyStock data.
 *
 * Output:
 * - One main row per product + extra rows for additional images (same Handle).
 *
 * Usage:
 *   node backend/scripts/export-avystock-to-shopify-template-csv.js \
 *     --template /Users/oguz/Downloads/product_template.csv \
 *     --out exports/avystock_shopify_import.csv \
 *     --minStock 1
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts, getAllProductsForTenant } = require('../lib/firestore');


// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

function parseArgs(argv) {
  const args = {
    template: '/Users/oguz/Downloads/product_template.csv',
    out: path.join(process.cwd(), 'exports', 'avystock_shopify_import.csv'),
    minStock: 1,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--template') {
      args.template = argv[i + 1];
      i += 1;
    } else if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (t === '--minStock') {
      args.minStock = Number(argv[i + 1] || '1');
      i += 1;
    }
  }
  if (!Number.isFinite(args.minStock)) args.minStock = 1;
  return args;
}

function slugify(input) {
  const s = safeString(input).toLowerCase();
  return s
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    ''
  );
}

function pickBarcode(product) {
  return (
    safeString(product?.details?.identifiers?.ean) ||
    safeString(product?.details?.identifiers?.gtin) ||
    safeString(product?.details?.identifiers?.upc) ||
    (Array.isArray(product?.identification?.barcodes) ? safeString(product.identification.barcodes[0]) : '') ||
    ''
  );
}

function pickBrand(product) {
  return safeString(product?.identification?.brand) || safeString(product?.details?.attributes?.Marke) || '';
}

function pickTitle(product) {
  return safeString(product?.identification?.name) || '';
}

function pickType(product) {
  const attrs = product?.details?.attributes || {};
  return (
    safeString(attrs.Produktart) ||
    safeString(attrs.Produkttyp) ||
    safeString(attrs.Artikeltyp) ||
    safeString(String(product?.identification?.category || '').split('>').pop() || '') ||
    ''
  );
}

function pickCategory(product) {
  // Shopify template expects Google Product Category (string or numeric id).
  // We use our existing breadcrumb/category string; user can remap later if needed.
  return safeString(product?.identification?.category) || '';
}

function pickPrice(product) {
  const amount = product?.details?.pricing?.lowest_price?.amount;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return Number(amount).toFixed(2);
  const legacy = product?.details?.pricing?.price;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) return Number(legacy).toFixed(2);
  return '';
}

function sumStock(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const binSum = bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
  if (binSum > 0) return binSum;
  const physical = Number(product?.inventory?.physicalQuantity) || 0;
  if (physical > 0) return physical;
  const qty = Number(product?.inventory?.quantity) || 0;
  if (qty > 0) return qty;
  const legacyStorage = Number(product?.storage?.quantity) || 0;
  return legacyStorage > 0 ? legacyStorage : 0;
}

function pickImages(product, max = 30) {
  const imgs = Array.isArray(product?.details?.images) ? product.details.images : [];
  const urls = imgs
    .map((img) => safeString(img?.url_or_base64))
    .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')));
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function toHtmlParagraphs(text) {
  const raw = safeString(text);
  if (!raw) return '';
  // If it already looks like HTML, keep it.
  if (/<p[\s>]|<\/p>/.test(raw)) return raw;
  const parts = raw
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const escaped = (s) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return parts.map((p) => `<p>${escaped(p)}</p>`).join('');
}

function pickSeoDescription(text) {
  const t = safeString(text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  ensureDir(path.dirname(outPath));

  if (!fs.existsSync(args.template)) {
    throw new Error(`Missing template: ${args.template}`);
  }
  const templateHeader = fs.readFileSync(args.template, 'utf8').split(/\r?\n/)[0].trim();
  const templateCols = templateHeader.split(',').map((x) => x.trim());

  const products = await getAllProductsForTenant(TENANT_ID);

  const lines = [];
  lines.push(templateCols.map(csvEscape).join(','));

  const stats = {
    total: products.length,
    exported: 0,
    skipped_missing_sku: 0,
    skipped_below_min_stock: 0,
    image_rows: 0,
  };

  for (const p of products) {
    const sku = pickSku(p);
    if (!sku) {
      stats.skipped_missing_sku += 1;
      continue;
    }

    const stock = sumStock(p);
    if (stock < args.minStock) {
      stats.skipped_below_min_stock += 1;
      continue;
    }

    const title = pickTitle(p);
    const vendor = pickBrand(p);
    const type = pickType(p);
    const category = pickCategory(p);
    const price = pickPrice(p);
    const barcode = pickBarcode(p);
    const desc = safeString(p?.details?.description) || safeString(p?.details?.short_description) || '';
    const bodyHtml = toHtmlParagraphs(desc);
    const seoTitle = title;
    const seoDesc = pickSeoDescription(desc);

    const images = pickImages(p, 30);

    const handle = slugify(sku) || slugify(`${vendor}-${type}-${p.id}`) || `product-${stats.exported + 1}`;

    const tags = [
      type,
      safeString(p?.details?.attributes?.Farbe),
      safeString(p?.details?.attributes?.Größe),
    ]
      .filter(Boolean)
      .join(', ');

    const baseRow = {};
    for (const col of templateCols) baseRow[col] = '';

    baseRow['Handle'] = handle;
    baseRow['Title'] = title;
    baseRow['Body (HTML)'] = bodyHtml;
    baseRow['Vendor'] = vendor;
    baseRow['Product Category'] = category;
    baseRow['Type'] = type;
    baseRow['Tags'] = tags;
    baseRow['Published'] = 'TRUE';

    // Single default variant
    baseRow['Option1 Name'] = 'Title';
    baseRow['Option1 Value'] = 'Default Title';

    baseRow['Variant SKU'] = sku;
    baseRow['Variant Inventory Qty'] = String(stock);
    baseRow['Variant Inventory Policy'] = 'deny';
    baseRow['Variant Fulfillment Service'] = 'manual';
    baseRow['Variant Price'] = price;
    baseRow['Variant Requires Shipping'] = 'TRUE';
    baseRow['Variant Taxable'] = 'TRUE';
    baseRow['Variant Barcode'] = barcode;

    baseRow['Gift Card'] = 'FALSE';
    baseRow['SEO Title'] = seoTitle;
    baseRow['SEO Description'] = seoDesc;
    baseRow['Google Shopping / Google Product Category'] = '';
    baseRow['Google Shopping / Condition'] = 'new';
    baseRow['Google Shopping / Custom Product'] = 'TRUE';
    baseRow['Variant Weight Unit'] = 'g';
    baseRow['Status'] = 'active';

    if (images[0]) {
      baseRow['Image Src'] = images[0];
      baseRow['Image Position'] = '1';
      baseRow['Image Alt Text'] = title;
    }

    lines.push(templateCols.map((c) => csvEscape(baseRow[c] || '')).join(','));
    stats.exported += 1;

    for (let i = 1; i < images.length; i += 1) {
      const imgRow = {};
      for (const col of templateCols) imgRow[col] = '';
      imgRow['Handle'] = handle;
      imgRow['Image Src'] = images[i];
      imgRow['Image Position'] = String(i + 1);
      imgRow['Image Alt Text'] = title;
      lines.push(templateCols.map((c) => csvEscape(imgRow[c] || '')).join(','));
      stats.image_rows += 1;
    }
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`[shopify-avystock] out=${outPath}`);
  console.log('[shopify-avystock] stats=', JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});

