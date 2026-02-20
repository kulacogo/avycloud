/* eslint-disable no-console */
/**
 * Convert a "Main_*.xlsx" style sheet where data is mostly stored in column A as:
 * - "Key: Value" lines
 * - free-text description / bullets / <li> lines
 * - occasional concatenated blob lines containing SKU/EAN/URLs/prices
 *
 * Outputs:
 * 1) Wide product CSV: one row per product with dynamic columns for each key
 * 2) Long CSV: (product_index, row, type, key, value) for auditing/import mapping
 *
 * Usage:
 *   node backend/scripts/convert-main-xlsx-to-import-csv.js \
 *     --in "Main_2026-01-20_05_00 2.xlsx" \
 *     --out exports/Main_2026-01-20_05_00_2_import.csv \
 *     --outLong exports/Main_2026-01-20_05_00_2_import_long.csv \
 *     --delimiter ";" \
 *     --bom true
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { isValidGtin, normalizeDigits } = require('../lib/gtin');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseBool(v, defaultValue) {
  if (v === undefined || v === null) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false;
  return defaultValue;
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function csvEscape(value, delimiter) {
  if (value === null || value === undefined) return '';
  const str = normalizeNewlines(value);
  const needsQuote =
    str.includes('"') || str.includes('\n') || str.includes('\r') || str.includes(delimiter) || /^\s|\s$/.test(str);
  if (needsQuote) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseArgs(argv) {
  const args = {
    in: path.join(process.cwd(), 'Main_2026-01-20_05_00 2.xlsx'),
    out: path.join(process.cwd(), 'exports', 'Main_import.csv'),
    outLong: path.join(process.cwd(), 'exports', 'Main_import_long.csv'),
    delimiter: ';',
    bom: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in') {
      args.in = argv[i + 1];
      i += 1;
    } else if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (t === '--outLong') {
      args.outLong = argv[i + 1];
      i += 1;
    } else if (t === '--delimiter') {
      args.delimiter = argv[i + 1] || ';';
      i += 1;
    } else if (t === '--bom') {
      args.bom = parseBool(argv[i + 1], true);
      i += 1;
    }
  }
  return args;
}

function extractUrls(text) {
  const s = safeString(text);
  if (!s) return [];
  // Some inputs contain URLs concatenated without whitespace:
  //   https://a.pnghttps://b.pngdb|...
  // We slice between occurrences of "http(s)://" to recover individual URLs.
  const starts = [];
  const re = /https?:\/\//g;
  let m;
  while ((m = re.exec(s)) !== null) {
    starts.push(m.index);
  }
  if (!starts.length) return [];
  const candidates = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : s.length;
    let piece = s.slice(from, to).trim();
    // Cut off known non-url tails.
    piece = piece.split('db|')[0].trim();
    // Trim trailing chars that often stick (commas, quotes, parentheses)
    piece = piece.replace(/[)"'\],.]+$/g, '').trim();
    if (!piece) continue;
    if (!/^https?:\/\//i.test(piece)) continue;
    // Heuristic validity: must contain a dot and be reasonably short.
    if (!piece.includes('.')) continue;
    if (piece.length > 2000) continue;
    candidates.push(piece);
  }
  // de-dupe, keep order
  const seen = new Set();
  const out = [];
  for (const u of candidates) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

function extractSku(text) {
  const s = safeString(text);
  if (!s) return '';
  const m = s.match(/\bSKU[-_\s]?\d+\b/i);
  if (!m) return '';
  return m[0].replace(/\s+/g, '').replace(/_/g, '-').toUpperCase();
}

function extractValidGtin(text) {
  const s = safeString(text);
  if (!s) return '';
  const candidates = (s.match(/\d[\d\s\-]{7,16}\d/g) || []).map((x) => normalizeDigits(x));
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (isValidGtin(c)) return c;
  }
  return '';
}

function extractPrice(text) {
  const s = safeString(text);
  if (!s) return '';
  // Prefer explicit "db|...:<price>" patterns seen in the sheet.
  const m1 = s.match(/db\|\d+:(\d+[.,]\d{2})/i);
  if (m1?.[1]) return m1[1].replace(',', '.');
  // Fallback: any standalone xx.xx
  const m2 = s.match(/\b(\d+[.,]\d{2})\b/);
  if (m2?.[1]) return m2[1].replace(',', '.');
  return '';
}

function parseBlobKeyValues(blob) {
  const s = safeString(blob);
  if (!s) return {};
  const labels = [
    'Produkttyp',
    'Marke',
    'Modell',
    'Serie',
    'Farbe',
    'Größe',
    'Maße',
    'Material',
    'Artikelnummer',
    'Artikelcode',
    'EAN',
    'GTIN',
    'SKU',
    'Kategorie',
    'Preis',
  ];
  const hits = [];
  for (const label of labels) {
    const idx = s.indexOf(label);
    if (idx !== -1) hits.push({ label, idx });
  }
  hits.sort((a, b) => a.idx - b.idx);
  if (hits.length < 2) return {};
  const out = {};
  for (let i = 0; i < hits.length; i += 1) {
    const cur = hits[i];
    const next = hits[i + 1];
    const start = cur.idx + cur.label.length;
    const end = next ? next.idx : s.length;
    const rawVal = s.slice(start, end);
    const val = safeString(rawVal)
      // stop at first URL if it leaks into value
      .split(/https?:\/\//)[0]
      .trim();
    if (val) out[normalizeKey(cur.label)] = val;
  }
  return out;
}

function isKeyValueLine(line) {
  const s = safeString(line);
  if (!s) return false;
  if (s.startsWith('<li>')) return false;
  // Key: Value (with colon)
  return /^[^:]{1,80}:\s*\S+/.test(s);
}

function parseKeyValue(line) {
  const s = safeString(line);
  const idx = s.indexOf(':');
  if (idx === -1) return null;
  const key = safeString(s.slice(0, idx));
  const value = safeString(s.slice(idx + 1));
  if (!key) return null;
  return { key, value };
}

function normalizeKey(key) {
  // Keep user-facing keys, but normalize whitespace.
  return safeString(key).replace(/\s+/g, ' ');
}

function main() {
  const args = parseArgs(process.argv);
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  const outLongPath = path.isAbsolute(args.outLong) ? args.outLong : path.join(process.cwd(), args.outLong);
  ensureDir(path.dirname(outPath));
  ensureDir(path.dirname(outLongPath));

  const wb = XLSX.readFile(inPath, { cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const range = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (!ws || !range) {
    throw new Error(`No sheet data found in ${inPath}`);
  }

  // Read column A lines (1-based excel rows)
  const lines = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const addr = XLSX.utils.encode_cell({ r, c: 0 }); // A column
    const v = ws[addr]?.v;
    const s = safeString(v);
    if (!s) continue;
    lines.push({ row: r + 1, text: s });
  }

  const products = [];
  const longRows = [];

  let current = null;
  let inFreeText = false;

  const startNew = () => {
    if (current) products.push(current);
    current = {
      index: products.length + 1,
      fields: {},
      fieldsSource: {}, // key -> 'kv' | 'blob'
      descriptionParts: [],
      highlightParts: [],
      rawBlobs: [],
      images: [],
      sku: '',
      gtin: '',
      price: '',
    };
    inFreeText = false;
  };

  for (const { row, text } of lines) {
    // Some rows contain concatenated product blobs like "Produkttyp...Marke...SKU-...http..."
    // They often indicate a new product boundary, sometimes appended after free text.
    const blobIdx = text.indexOf('Produkttyp');
    const hasBlobMarkers = blobIdx !== -1 && text.includes('Marke') && text.length >= 180;
    if (hasBlobMarkers) {
      // If "Produkttyp" occurs mid-line, treat the prefix as continuation of current description.
      if (blobIdx > 0 && current) {
        const prefix = text.slice(0, blobIdx).trim();
        if (prefix) {
          longRows.push({ product_index: current.index, row, type: 'text', key: '', value: prefix });
          current.descriptionParts.push(prefix);
        }
      }
      // Split blob suffix into multiple segments when it contains multiple "Produkttyp" occurrences.
      const suffix = blobIdx > 0 ? text.slice(blobIdx) : text;
      const starts = [];
      const re = /Produkttyp/g;
      let mm;
      while ((mm = re.exec(suffix)) !== null) starts.push(mm.index);
      const segments = [];
      if (starts.length <= 1) {
        segments.push(suffix);
      } else {
        for (let i = 0; i < starts.length; i += 1) {
          const from = starts[i];
          const to = i + 1 < starts.length ? starts[i + 1] : suffix.length;
          const seg = suffix.slice(from, to).trim();
          if (seg) segments.push(seg);
        }
      }

      for (const seg of segments) {
        startNew();
        current.rawBlobs.push(seg);
        const blobFields = parseBlobKeyValues(seg);
        for (const [k, v] of Object.entries(blobFields)) {
          const key = normalizeKey(k);
          if (current.fieldsSource[key] === 'kv') continue; // kv wins over blob
          const existing = safeString(current.fields[key]);
          if (!existing) current.fields[key] = v;
          else if (!existing.split(' | ').includes(v)) current.fields[key] = `${existing} | ${v}`;
          current.fieldsSource[key] = 'blob';
        }
        const sku = extractSku(seg);
        const gtin = extractValidGtin(seg);
        const price = extractPrice(seg);
        const urls = extractUrls(seg);
        if (sku && !current.sku) current.sku = sku;
        if (gtin && !current.gtin) current.gtin = gtin;
        if (price && !current.price) current.price = price;
        for (const u of urls) {
          if (!current.images.includes(u)) current.images.push(u);
        }
      }
      inFreeText = false;
      continue;
    }

    // Record starts when we see a Produkttyp key-value line.
    if (/^Produkttyp\s*:/i.test(text)) {
      // If current record is only a preceding blob placeholder (no kv parsed yet),
      // do NOT split; treat this as the same record starting its kv section.
      const hasKv = current && Object.values(current.fieldsSource || {}).some((x) => x === 'kv');
      const hasText = current && ((current.descriptionParts || []).length || (current.highlightParts || []).length);
      const hasOnlyBlob = current && !hasKv && !hasText && (current.rawBlobs || []).length > 0;
      if (!hasOnlyBlob) startNew();
    }
    if (!current) {
      // If file begins with blobs before first Produkttyp:, keep them until first record.
      startNew();
    }

    const kv = isKeyValueLine(text) ? parseKeyValue(text) : null;
    if (kv) {
      const key = normalizeKey(kv.key);
      const value = kv.value;
      longRows.push({ product_index: current.index, row, type: 'kv', key, value });
      // Key:Value lines are authoritative: overwrite blob/noise and keep latest kv.
      current.fields[key] = value;
      current.fieldsSource[key] = 'kv';
      // also extract special fields
      if (!current.sku) current.sku = extractSku(text);
      if (!current.gtin) current.gtin = extractValidGtin(text);
      if (!current.price) current.price = extractPrice(text);
      inFreeText = false;
      continue;
    }

    // Non-kv lines: could be HTML bullets, highlights, or description paragraphs, or concatenated blobs.
    longRows.push({ product_index: current.index, row, type: 'text', key: '', value: text });

    // Extract from blobs where possible.
    const sku = extractSku(text);
    const gtin = extractValidGtin(text);
    const price = extractPrice(text);
    const urls = extractUrls(text);
    if (sku && !current.sku) current.sku = sku;
    if (gtin && !current.gtin) current.gtin = gtin;
    if (price && !current.price) current.price = price;
    for (const u of urls) {
      if (!current.images.includes(u)) current.images.push(u);
    }

    const isHtmlLi = text.trim().toLowerCase().startsWith('<li>');
    const cleanedLi = isHtmlLi ? text.replace(/^<li>\s*/i, '').trim() : text.trim();
    const isShort = cleanedLi.length > 0 && cleanedLi.length <= 180;
    const looksLikeBullet = isHtmlLi || (/^\s*[-•]\s+/.test(cleanedLi) && cleanedLi.length <= 220) || (isShort && /:/.test(cleanedLi) && !cleanedLi.endsWith('.'));

    if (looksLikeBullet) {
      current.highlightParts.push(cleanedLi.replace(/^\s*[-•]\s+/, '').trim());
      inFreeText = true;
      continue;
    }

    if (cleanedLi.length >= 120 || inFreeText) {
      current.descriptionParts.push(cleanedLi);
      inFreeText = true;
      continue;
    }

    // Otherwise keep as blob.
    current.rawBlobs.push(text);
  }

  if (current) products.push(current);

  const pickField = (fields, ...keys) => {
    const all = Object.keys(fields || {});
    const lowered = new Map(all.map((k) => [k.toLowerCase(), k]));
    for (const k of keys) {
      const hit = lowered.get(String(k).toLowerCase());
      if (hit && safeString(fields[hit])) return safeString(fields[hit]);
    }
    return '';
  };

  // Simple import-friendly columns
  const simpleHeaders = [
    'product_index',
    'Titel',
    'Marke',
    'Produkttyp',
    'Modell/Serie',
    'Farbe',
    'Größe',
    'Maße',
    'Material',
    'SKU',
    'GTIN',
    'price',
    'Description',
    'Highlights',
    'Image URL 1',
    'Image URL 2',
    'Image URL 3',
    'Image URL 4',
    'Image URL 5',
  ];

  const simpleLines = [];
  simpleLines.push(simpleHeaders.map((h) => csvEscape(h, args.delimiter)).join(args.delimiter));
  for (const p of products) {
    const brand = pickField(p.fields, 'Marke');
    const productType = pickField(p.fields, 'Produkttyp');
    const modelOrSeries = pickField(p.fields, 'Modell', 'Serie');
    const color = pickField(p.fields, 'Farbe');
    const size = pickField(p.fields, 'Größe');
    const measure = pickField(p.fields, 'Maße', 'Abmessungen');
    const material = pickField(p.fields, 'Material', 'Obermaterial');
    const desc = p.descriptionParts.join('\n\n');
    const highlights = p.highlightParts.join(' | ');
    const title = [brand, modelOrSeries, productType, color, size].filter(Boolean).join(' ').trim();

    const row = [
      p.index,
      title,
      brand,
      productType,
      modelOrSeries,
      color,
      size,
      measure,
      material,
      p.sku,
      p.gtin,
      p.price,
      desc,
      highlights,
      p.images[0] || '',
      p.images[1] || '',
      p.images[2] || '',
      p.images[3] || '',
      p.images[4] || '',
    ];
    simpleLines.push(row.map((v) => csvEscape(v, args.delimiter)).join(args.delimiter));
  }

  const bom = args.bom ? '\ufeff' : '';
  fs.writeFileSync(outPath, bom + simpleLines.join('\n'), 'utf8');

  const longHeaders = ['product_index', 'row', 'type', 'key', 'value'];
  const longCsv = [longHeaders.map((h) => csvEscape(h, args.delimiter)).join(args.delimiter)];
  for (const r of longRows) {
    longCsv.push(
      [
        r.product_index,
        r.row,
        r.type,
        r.key || '',
        r.value || '',
      ]
        .map((v) => csvEscape(v, args.delimiter))
        .join(args.delimiter)
    );
  }
  fs.writeFileSync(outLongPath, bom + longCsv.join('\n'), 'utf8');

  console.log(`[convert] sheet="${sheetName}" inputLines=${lines.length} products=${products.length}`);
  console.log(`[convert] out=${outPath}`);
  console.log(`[convert] outLong=${outLongPath}`);
}

main();

