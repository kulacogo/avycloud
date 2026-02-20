/* eslint-disable no-console */
/**
 * Autofill the category review CSV using results from `fix-suspicious-categories-with-web.js --dry-run`.
 *
 * Policy:
 * - Only fill TargetCategoryBreadcrumb/TargetCategoryId when the dry-run status is "would_update"
 *   (taxonomy-validated + evidence-guarded).
 * - For all other rows, keep targets empty and add an explanatory Notes string (reason/query/proposedPath).
 *
 * Usage:
 *   node backend/scripts/autofill-category-review-csv.js \
 *     --in exports/category_review_suspicious_roots_*.csv \
 *     --report exports/category-fix-web/<stamp>/dryrun_report.json \
 *     --out exports/category_review_suspicious_roots_autofilled.csv
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = normalizeNewlines(value);
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = { in: null, report: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in') {
      args.in = argv[i + 1];
      i += 1;
    } else if (t === '--report') {
      args.report = argv[i + 1];
      i += 1;
    } else if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  if (!args.in || !args.report) {
    throw new Error('Missing required args: --in <csv> --report <dryrun_report.json>');
  }
  return args;
}

function loadCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    bom: true,
  });
}

function buildReportMap(reportPath) {
  const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const map = new Map();
  for (const entry of Array.isArray(data) ? data : []) {
    const sku = safeString(entry?.sku);
    if (!sku) continue;
    map.set(sku, entry);
  }
  return map;
}

function main() {
  const args = parseArgs(process.argv);
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const reportPath = path.isAbsolute(args.report) ? args.report : path.join(process.cwd(), args.report);
  const stamp = nowStamp();
  const defaultOut = path.join(process.cwd(), 'exports', `category_review_suspicious_roots_autofilled_${stamp}.csv`);
  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : defaultOut;
  ensureDir(path.dirname(outPath));

  const rows = loadCsv(inPath);
  const reportMap = buildReportMap(reportPath);

  const headers = [
    'SKU',
    'DocId',
    'Titel',
    'Brand',
    'Produktart',
    'CurrentCategoryId',
    'CurrentBreadcrumb',
    'CurrentRoot',
    'TargetCategoryBreadcrumb',
    'TargetCategoryId',
    'Notes',
  ];

  let filled = 0;
  let noted = 0;

  const outLines = [];
  outLines.push(headers.join(','));

  for (const row of rows) {
    const sku = safeString(row.SKU);
    const rep = sku ? reportMap.get(sku) : null;

    let targetBreadcrumb = safeString(row.TargetCategoryBreadcrumb);
    let targetId = safeString(row.TargetCategoryId);
    let notes = safeString(row.Notes);

    if (rep) {
      const status = safeString(rep.status);
      if (status === 'would_update') {
        targetBreadcrumb = safeString(rep.canonical);
        targetId = safeString(rep.resolvedId);
        const autoNote = `AUTO would_update (query=${safeString(rep.query)}; proposed=${safeString(rep.proposedPath)}; resolvedBy=${safeString(rep.resolvedBy)})`;
        notes = notes ? `${autoNote} | ${notes}` : autoNote;
        filled += 1;
      } else if (status === 'noop') {
        const autoNote = `AUTO noop (query=${safeString(rep.query)}; resolvedId=${safeString(rep.resolvedId)}; resolvedBy=${safeString(rep.resolvedBy)})`;
        notes = notes ? `${autoNote} | ${notes}` : autoNote;
        noted += 1;
      } else if (status === 'skip') {
        const autoNote = `AUTO skip reason=${safeString(rep.reason)} (query=${safeString(rep.query)}; proposed=${safeString(rep.proposedPath || '')})`;
        notes = notes ? `${autoNote} | ${notes}` : autoNote;
        noted += 1;
      }
    } else if (sku) {
      const autoNote = 'AUTO no_suggestion (not in dryrun_report)';
      notes = notes ? `${autoNote} | ${notes}` : autoNote;
      noted += 1;
    }

    outLines.push(
      [
        safeString(row.SKU),
        safeString(row.DocId),
        safeString(row.Titel),
        safeString(row.Brand),
        safeString(row.Produktart),
        safeString(row.CurrentCategoryId),
        safeString(row.CurrentBreadcrumb),
        safeString(row.CurrentRoot),
        targetBreadcrumb,
        targetId,
        notes,
      ].map(csvEscape).join(',')
    );
  }

  fs.writeFileSync(outPath, `${outLines.join('\n')}\n`, 'utf8');
  console.log(`[autofill-category-review] filled=${filled} noted=${noted} -> ${outPath}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}


