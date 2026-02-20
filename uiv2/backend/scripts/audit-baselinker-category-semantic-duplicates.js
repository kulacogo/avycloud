/* eslint-disable no-console */
/**
 * Audit semantic duplicates in a BaseLinker category export CSV.
 *
 * Motivation:
 * - "Duplicate" does not always mean identical breadcrumb text.
 * - We want to catch cases like:
 *   - "Motoröle" under multiple branches in the same root domain
 *   - "Unterwäsche" / "Unterwäsche & Nachtwäsche" variants
 *
 * This script produces a review report (no writes):
 * - groups by (root-domain, normalized leaf) and scores similarity of parent context
 * - outputs CSV + JSON so you can decide which branch becomes canonical
 *
 * Usage:
 *   node backend/scripts/audit-baselinker-category-semantic-duplicates.js --in exports/<bl-cats>.csv
 *
 * Output:
 *   exports/<base>-semantic-duplicates.json
 *   exports/<base>-semantic-duplicates.csv
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}
function normalizeForMatch(text = '') {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[\u2010-\u2015]/g, '-') // dash variants
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBreadcrumb(breadcrumb) {
  return safeString(breadcrumb)
    .split('>')
    .map((s) => normalizeSpaces(s))
    .filter(Boolean);
}

function tokenize(text) {
  const t = normalizeForMatch(text);
  if (!t) return [];
  const stop = new Set([
    'und',
    'oder',
    'fur',
    'fuer',
    'für',
    'mit',
    'ohne',
    'set',
    'teile',
    'zubehor',
    'zubehör',
    'sonstige',
    'weitere',
    'anderes',
    'andere',
    'auto',
    'motorrad',
    'kfz',
  ]);
  return t
    .split(/[^a-z0-9]+/g)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stop.has(w));
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s) || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseArgs(argv) {
  const args = { in: null, outDir: path.join(process.cwd(), 'exports') };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in' || t === '--input') {
      args.in = argv[i + 1];
      i += 1;
      continue;
    }
    if (t === '--outDir' || t === '--outdir' || t === '--out') {
      args.outDir = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

function guessBaseName(inputPath) {
  const base = path.basename(inputPath);
  return base.toLowerCase().endsWith('.csv') ? base.slice(0, -4) : base;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function toCsv(header, rows) {
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((k) => csvEscape(r[k])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.in) throw new Error('Missing --in <csvPath>');
  const inputPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(process.cwd(), args.outDir);
  ensureDir(outDir);
  if (!fs.existsSync(inputPath)) throw new Error(`Input not found: ${inputPath}`);

  const raw = fs.readFileSync(inputPath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true });

  const rows = records
    .map((r) => {
      const id = safeString(r.category_id);
      const breadcrumb = safeString(r.breadcrumb);
      const segs = splitBreadcrumb(breadcrumb);
      const root = segs[0] || '';
      const leaf = segs[segs.length - 1] || '';
      const parentCtx = segs.slice(0, -1).join(' > ');
      const leafKey = normalizeForMatch(leaf);
      const rootKey = normalizeForMatch(root);
      return {
        id,
        breadcrumb,
        root,
        rootKey,
        leaf,
        leafKey,
        parentCtx,
        parentTokens: tokenize(parentCtx),
      };
    })
    .filter((r) => r.id && r.leafKey && r.rootKey);

  // Bucket by (rootKey, leafKey)
  const buckets = new Map();
  for (const r of rows) {
    const k = `${r.rootKey}|||${r.leafKey}`;
    const list = buckets.get(k) || [];
    list.push(r);
    buckets.set(k, list);
  }

  const groups = [];
  for (const [k, list] of buckets.entries()) {
    if (list.length <= 1) continue;
    // Compute max similarity between any two contexts
    let maxSim = 0;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const sim = jaccard(list[i].parentTokens, list[j].parentTokens);
        if (sim > maxSim) maxSim = sim;
      }
    }
    groups.push({
      key: k,
      root: list[0].root,
      leaf: list[0].leaf,
      count: list.length,
      max_parent_similarity: Number(maxSim.toFixed(3)),
      items: list.map((x) => ({ id: x.id, breadcrumb: x.breadcrumb, parentCtx: x.parentCtx })),
    });
  }

  // Sort by: larger groups first, then higher similarity
  groups.sort((a, b) => b.count - a.count || b.max_parent_similarity - a.max_parent_similarity || String(a.leaf).localeCompare(String(b.leaf), 'de'));

  // Flatten for CSV
  const csvRows = [];
  for (const g of groups) {
    for (const item of g.items) {
      csvRows.push({
        root: g.root,
        leaf: g.leaf,
        group_count: g.count,
        max_parent_similarity: g.max_parent_similarity,
        category_id: item.id,
        breadcrumb: item.breadcrumb,
        parent_context: item.parentCtx,
      });
    }
  }

  const baseName = guessBaseName(inputPath);
  const outJson = path.join(outDir, `${baseName}-semantic-duplicates.json`);
  const outCsv = path.join(outDir, `${baseName}-semantic-duplicates.csv`);

  fs.writeFileSync(
    outJson,
    JSON.stringify(
      {
        meta: {
          generated_at_iso: new Date().toISOString(),
          input: inputPath,
          total_categories: rows.length,
          duplicate_groups: groups.length,
        },
        groups,
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    outCsv,
    toCsv(['root', 'leaf', 'group_count', 'max_parent_similarity', 'category_id', 'breadcrumb', 'parent_context'], csvRows),
    'utf8'
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        input: inputPath,
        out: { json: outJson, csv: outCsv },
        stats: { total_categories: rows.length, duplicate_groups: groups.length, duplicate_rows: csvRows.length },
        top_groups: groups.slice(0, 15).map((g) => ({ root: g.root, leaf: g.leaf, count: g.count, max_parent_similarity: g.max_parent_similarity })),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});

