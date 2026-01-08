/* eslint-disable no-console */
/**
 * Audit potential data impact of the barcode-backfill-web APPLY run.
 *
 * We do NOT have historical Firestore versions, so we compare:
 * - A baseline CSV export captured BEFORE the web backfill run (default: exports/products_export_after_barcode_cleanup.csv)
 * - Current Firestore state for the products that were "applied" in apply_report.json
 *
 * Output:
 * - exports/barcode-web-impact/<stamp>/impact_report.csv
 * - exports/barcode-web-impact/<stamp>/impact_report.json
 *
 * Usage:
 *   node backend/scripts/audit-barcode-web-impact.js \
 *     --apply-report exports/barcode-backfill-web/20260107-020803/apply_report.json \
 *     --baseline exports/products_export_after_barcode_cleanup.csv
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { getProduct } = require('../lib/firestore');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeLower(v) {
  return safeString(v).toLowerCase();
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function parseArgs(argv) {
  const out = {
    applyReport: 'exports/barcode-backfill-web/20260107-020803/apply_report.json',
    baseline: 'exports/products_export_after_barcode_cleanup.csv',
    outDir: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply-report') out.applyReport = argv[i + 1], (i += 1);
    else if (a === '--baseline') out.baseline = argv[i + 1], (i += 1);
    else if (a === '--out') out.outDir = argv[i + 1], (i += 1);
  }
  return out;
}

function loadBaselineBySku(csvPath) {
  const abs = path.isAbsolute(csvPath) ? csvPath : path.join(process.cwd(), csvPath);
  const content = fs.readFileSync(abs, 'utf8');
  const rows = parse(content, { columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
  const map = new Map();
  for (const row of rows) {
    const sku = safeString(row.SKU || row.sku);
    if (!sku) continue;
    map.set(sku, {
      title: safeString(row.Titel || row.Title),
      brand: safeString(row.Brand || row.Marke),
      category: safeString(row.Kategorie || row.Category),
      barcode: safeString(row['Barcode (EAN/GTIN)'] || row.Barcode || row.EAN || row.GTIN),
    });
  }
  return map;
}

function pickApplySources(entry) {
  const urls = [];
  const push = (u) => {
    const s = safeString(u);
    if (!s) return;
    if (!/^https?:\/\//i.test(s)) return;
    urls.push(s);
  };
  // Newer reports have candidate.sources[].url
  if (entry?.candidate?.sources && Array.isArray(entry.candidate.sources)) {
    entry.candidate.sources.forEach((s) => push(s?.url));
  }
  // Some reports have choice.sources[]
  if (entry?.choice?.sources && Array.isArray(entry.choice.sources)) {
    entry.choice.sources.forEach((u) => push(u));
  }
  const uniq = Array.from(new Set(urls));
  const hosts = uniq
    .map((u) => {
      try {
        return new URL(u).host.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const uniqHosts = Array.from(new Set(hosts));
  return { urls: uniq, hosts: uniqHosts };
}

function riskFlag({ baseline, current, applyEntry }) {
  const sources = pickApplySources(applyEntry);
  const hostBlob = sources.hosts.join(' ');
  const hasMarketplaceSource = /(kaufland\.de|ebay\.|amazon\.)/i.test(hostBlob);

  const baseBrand = safeString(baseline?.brand);
  const curBrand = safeString(current?.identification?.brand);
  const baseTitle = safeString(baseline?.title);
  const curTitle = safeString(current?.identification?.name);

  const brandChanged = baseBrand && curBrand && normalizeLower(baseBrand) !== normalizeLower(curBrand);
  const titleChanged = baseTitle && curTitle && normalizeLower(baseTitle) !== normalizeLower(curTitle);

  // High risk: brand changed OR title changed AND barcode came from marketplace page.
  if (brandChanged) return 'HIGH_brand_changed';
  if (titleChanged && hasMarketplaceSource) return 'HIGH_title_changed_marketplace_source';
  if (hasMarketplaceSource) return 'MED_marketplace_source';
  return 'LOW';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = nowStamp();
  const outDir = args.outDir || path.join(process.cwd(), 'exports', 'barcode-web-impact', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const applyReportPath = path.isAbsolute(args.applyReport) ? args.applyReport : path.join(process.cwd(), args.applyReport);
  const applyReport = JSON.parse(fs.readFileSync(applyReportPath, 'utf8'));
  const applied = (applyReport || []).filter((e) => e && e.status === 'applied' && e.productId);

  const baselineBySku = loadBaselineBySku(args.baseline);

  const out = [];
  for (const e of applied) {
    const productId = safeString(e.productId);
    const sku = safeString(e.sku) || productId;
    const baseline = baselineBySku.get(sku) || null;
    const current = await getProduct(productId);
    if (!current) {
      out.push({ productId, sku, status: 'missing_in_firestore' });
      continue;
    }

    const curTitle = safeString(current?.identification?.name);
    const curBrand = safeString(current?.identification?.brand);
    const curCategory = safeString(current?.identification?.category);
    const curEan = safeString(current?.details?.identifiers?.ean);
    const curGtin = safeString(current?.details?.identifiers?.gtin);
    const curUpc = safeString(current?.details?.identifiers?.upc);
    const curBarcodes = Array.isArray(current?.identification?.barcodes) ? current.identification.barcodes.map((x) => safeString(x)).filter(Boolean) : [];

    const baseTitle = safeString(baseline?.title);
    const baseBrand = safeString(baseline?.brand);
    const baseCategory = safeString(baseline?.category);
    const baseBarcode = safeString(baseline?.barcode);

    const applySources = pickApplySources(e);
    const risk = riskFlag({ baseline, current, applyEntry: e });

    const diffs = [];
    if (baseline) {
      if (baseTitle && curTitle && normalizeLower(baseTitle) !== normalizeLower(curTitle)) diffs.push('title_changed');
      if (baseBrand && curBrand && normalizeLower(baseBrand) !== normalizeLower(curBrand)) diffs.push('brand_changed');
      if (baseCategory && curCategory && normalizeLower(baseCategory) !== normalizeLower(curCategory)) diffs.push('category_changed');
      if (baseBarcode && (curEan || curGtin || curUpc) && normalizeLower(baseBarcode) !== normalizeLower(curEan || curGtin || curUpc)) diffs.push('barcode_changed');
      if (!baseBarcode && (curEan || curGtin || curUpc || curBarcodes.length)) diffs.push('barcode_added');
    } else {
      diffs.push('no_baseline_row');
    }

    out.push({
      productId,
      sku,
      apply_query: safeString(e.query),
      chosen_in_apply: safeString(e.chosen),
      apply_source_hosts: applySources.hosts.join('|'),
      apply_source_urls: applySources.urls.join('|'),
      risk,
      last_saved_source: safeString(current?.ops?.last_saved_source),
      dq_backfilled: safeString(current?.ops?.data_quality?.barcode_backfilled_web_v1?.value),
      dq_rollback: safeString(current?.ops?.data_quality?.barcode_backfill_rollback_v1?.removed),
      baseline_title: baseTitle,
      current_title: curTitle,
      baseline_brand: baseBrand,
      current_brand: curBrand,
      baseline_category: baseCategory,
      current_category: curCategory,
      baseline_barcode: baseBarcode,
      current_identifiers: [curEan, curGtin, curUpc].filter(Boolean).join('|'),
      current_barcodes: curBarcodes.join('|'),
      diffs,
    });
  }

  const jsonPath = path.join(outDir, 'impact_report.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ at_iso: new Date().toISOString(), out }, null, 2), 'utf8');

  const headers = [
    'productId',
    'sku',
    'risk',
    'apply_query',
    'chosen_in_apply',
    'apply_source_hosts',
    'apply_source_urls',
    'last_saved_source',
    'dq_backfilled',
    'dq_rollback',
    'baseline_title',
    'current_title',
    'baseline_brand',
    'current_brand',
    'baseline_category',
    'current_category',
    'baseline_barcode',
    'current_identifiers',
    'current_barcodes',
    'diffs',
  ];
  const csvLines = [headers.join(',')].concat(
    out.map((row) =>
      headers
        .map((h) => {
          const v = h === 'diffs' ? (Array.isArray(row.diffs) ? row.diffs.join('|') : '') : row[h];
          return csvEscape(v);
        })
        .join(',')
    )
  );
  fs.writeFileSync(path.join(outDir, 'impact_report.csv'), csvLines.join('\n'), 'utf8');

  console.log(`[audit-barcode-web-impact] wrote ${out.length} rows to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


