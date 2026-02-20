/* eslint-disable no-console */
/**
 * Convert our simplified import CSV (semicolon-delimited) into Shopify's product_template.csv format.
 *
 * Input (expected):
 * - exports/Main_2026-01-20_05_00_2_import.csv
 *   header: product_index;Titel;Marke;Produkttyp;Modell/Serie;Farbe;Größe;Maße;Material;SKU;GTIN;price;Description;Highlights;Image URL 1..5
 *
 * Output:
 * - Shopify CSV with exact header columns from product_template.csv (comma-delimited)
 * - One "main row" per product + extra rows for additional images (Image Src + Image Position)
 *
 * Usage:
 *   node backend/scripts/convert-main-import-to-shopify-template-csv.js \
 *     --in exports/Main_2026-01-20_05_00_2_import.csv \
 *     --template /Users/oguz/Downloads/product_template.csv \
 *     --out exports/Main_2026-01-20_05_00_2_shopify_import.csv
 */

const fs = require('fs');
const path = require('path');

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
    in: path.join(process.cwd(), 'exports', 'Main_2026-01-20_05_00_2_import.csv'),
    template: '/Users/oguz/Downloads/product_template.csv',
    out: path.join(process.cwd(), 'exports', 'Main_2026-01-20_05_00_2_shopify_import.csv'),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in') {
      args.in = argv[i + 1];
      i += 1;
    } else if (t === '--template') {
      args.template = argv[i + 1];
      i += 1;
    } else if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
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

function toHtmlParagraphs(text) {
  const raw = safeString(text);
  if (!raw) return '';
  // Split by blank lines, but also handle single long blocks.
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

function pickSeoDescription(desc) {
  const t = safeString(desc).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

function parseSemicolonCsvWithBom(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\n/);
  const headerLine = lines.shift();
  if (!headerLine) return { header: [], rows: [] };
  const header = headerLine.split(';').map((h) => h.trim());

  const rows = [];
  let current = '';
  const pushRow = (line) => {
    // very simple CSV parse for semicolon with quotes; robust enough for our generated file
    const out = [];
    let i = 0;
    let field = '';
    let inQuotes = false;
    while (i < line.length) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ';') {
        out.push(field);
        field = '';
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }
    out.push(field);
    rows.push(out);
  };

  for (const line of lines) {
    if (line === undefined) continue;
    const l = line.replace(/\r$/, '');
    if (current) current += '\n' + l;
    else current = l;
    // naive: if quotes are balanced, flush
    const quoteCount = (current.match(/"/g) || []).length;
    if (quoteCount % 2 === 0) {
      if (current.trim()) pushRow(current);
      current = '';
    }
  }
  if (current.trim()) pushRow(current);

  return { header, rows };
}

function main() {
  const args = parseArgs(process.argv);
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  const templatePath = args.template;

  if (!fs.existsSync(inPath)) throw new Error(`Missing input: ${inPath}`);
  if (!fs.existsSync(templatePath)) throw new Error(`Missing template: ${templatePath}`);
  ensureDir(path.dirname(outPath));

  const templateHeader = fs.readFileSync(templatePath, 'utf8').split(/\r?\n/)[0].trim();
  const templateCols = templateHeader.split(',').map((x) => x.trim());

  const { header: srcHeader, rows: srcRows } = parseSemicolonCsvWithBom(inPath);
  const idx = (name) => srcHeader.indexOf(name);
  const get = (row, name) => {
    const i = idx(name);
    if (i === -1) return '';
    return safeString(row[i] || '');
  };

  const output = [];
  output.push(templateCols.map(csvEscape).join(','));

  let products = 0;
  let imageRows = 0;

  for (const row of srcRows) {
    const title = get(row, 'Titel');
    const vendor = get(row, 'Marke');
    const type = get(row, 'Produkttyp');
    const modelSeries = get(row, 'Modell/Serie');
    const color = get(row, 'Farbe');
    const size = get(row, 'Größe');
    const sku = get(row, 'SKU') || `SKU-${get(row, 'product_index')}`;
    const barcode = get(row, 'GTIN');
    const price = get(row, 'price');
    const desc = get(row, 'Description');
    const highlights = get(row, 'Highlights');
    const img1 = get(row, 'Image URL 1');
    const img2 = get(row, 'Image URL 2');
    const img3 = get(row, 'Image URL 3');
    const img4 = get(row, 'Image URL 4');
    const img5 = get(row, 'Image URL 5');
    const images = [img1, img2, img3, img4, img5].map(safeString).filter(Boolean);

    const handleBase = slugify(sku) || slugify(`${vendor}-${type}-${get(row, 'product_index')}`) || `product-${products + 1}`;
    const handle = handleBase || `product-${products + 1}`;

    const tags = [type, modelSeries, color, size]
      .map((x) => safeString(x))
      .filter(Boolean)
      .join(', ');

    const bodyHtml = toHtmlParagraphs(desc || highlights);
    const seoTitle = title;
    const seoDesc = pickSeoDescription(desc || highlights);

    const baseRow = {};
    for (const col of templateCols) baseRow[col] = '';

    // Minimal Shopify product row (single default variant)
    baseRow['Handle'] = handle;
    baseRow['Title'] = title;
    baseRow['Body (HTML)'] = bodyHtml;
    baseRow['Vendor'] = vendor;
    baseRow['Type'] = type;
    baseRow['Tags'] = tags;
    baseRow['Published'] = 'TRUE';
    baseRow['Option1 Name'] = 'Title';
    baseRow['Option1 Value'] = 'Default Title';
    baseRow['Variant SKU'] = sku;
    baseRow['Variant Inventory Qty'] = '0';
    baseRow['Variant Inventory Policy'] = 'deny';
    baseRow['Variant Fulfillment Service'] = 'manual';
    baseRow['Variant Price'] = price;
    baseRow['Variant Requires Shipping'] = 'TRUE';
    baseRow['Variant Taxable'] = 'TRUE';
    baseRow['Variant Barcode'] = barcode;
    baseRow['Gift Card'] = 'FALSE';
    baseRow['SEO Title'] = seoTitle;
    baseRow['SEO Description'] = seoDesc;
    baseRow['Google Shopping / MPN'] = modelSeries;
    baseRow['Google Shopping / Condition'] = 'new';
    baseRow['Google Shopping / Custom Product'] = 'TRUE';
    baseRow['Variant Weight Unit'] = 'g';
    baseRow['Status'] = 'active';

    if (images[0]) {
      baseRow['Image Src'] = images[0];
      baseRow['Image Position'] = '1';
      baseRow['Image Alt Text'] = title;
    }

    output.push(templateCols.map((c) => csvEscape(baseRow[c] || '')).join(','));
    products += 1;

    // Extra image rows (Shopify expects separate rows with same handle)
    for (let i = 1; i < images.length; i += 1) {
      const imgRow = {};
      for (const col of templateCols) imgRow[col] = '';
      imgRow['Handle'] = handle;
      imgRow['Image Src'] = images[i];
      imgRow['Image Position'] = String(i + 1);
      imgRow['Image Alt Text'] = title;
      output.push(templateCols.map((c) => csvEscape(imgRow[c] || '')).join(','));
      imageRows += 1;
    }
  }

  fs.writeFileSync(outPath, output.join('\n'), 'utf8');
  console.log(`[shopify-export] products=${products} extraImageRows=${imageRows} -> ${outPath}`);
}

main();

