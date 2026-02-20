/* eslint-disable no-console */
/**
 * Consolidate BaseLinker inventory categories export CSV into a canonical taxonomy.
 *
 * Why:
 * - BaseLinker category trees often contain duplicates from multiple sources
 *   (e.g. "Baby" vs "Baby & Kind", "Bekleidung" vs "Kleidung & Accessoires",
 *   "Auto & Motorrad" vs "Auto & Motorrad: Teile").
 * - This script creates a deterministic mapping (old -> canonical) and a de-duplicated
 *   canonical category list for analysis/mapping/export consistency.
 *
 * Input CSV format (as produced by export-baselinker-inventory-categories.js):
 *   category_id,parent_id,name,breadcrumb
 *
 * Output:
 * - <outDir>/<base>-consolidated.csv        (unique canonical breadcrumbs)
 * - <outDir>/<base>-consolidation-map.csv  (row-level mapping)
 * - <outDir>/<base>-consolidated.json      (same data programmatically)
 *
 * Usage:
 *   node backend/scripts/consolidate-baselinker-inventory-categories-csv.js --in exports/<file>.csv
 *   node backend/scripts/consolidate-baselinker-inventory-categories-csv.js --in exports/<file>.csv --outDir exports
 *
 * Notes:
 * - This does NOT write back to BaseLinker. It only produces files + a mapping report.
 * - The consolidation rules are intentionally conservative (root/prefix normalization + a few safe aliases).
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

function splitBreadcrumb(breadcrumb) {
  return safeString(breadcrumb)
    .split('>')
    .map((s) => normalizeSpaces(s))
    .filter(Boolean);
}

// Prefix rewrite rules: match the FIRST segments and replace with a canonical prefix.
// IMPORTANT: match keys are normalized via normalizeForMatch().
const PREFIX_RULES = [
  // Auto roots: unify colon variants.
  { match: ['auto und motorrad: teile'], replace: ['Auto & Motorrad'] },
  { match: ['auto und motorrad: fahrzeuge'], replace: ['Auto & Motorrad'] },

  // Baby roots: unify to the broader root.
  { match: ['baby'], replace: ['Baby & Kind'] },

  // Clothing roots: unify to one canonical tree (Kleidung & Accessoires).
  { match: ['bekleidung'], replace: ['Kleidung & Accessoires'] },
  { match: ['bekleidung und accessoires'], replace: ['Kleidung & Accessoires'] },
  { match: ['mode'], replace: ['Kleidung & Accessoires'] },
  { match: ['mode und bekleidung'], replace: ['Kleidung & Accessoires'] },
  // "Mode & Accessoires" sometimes has an extra "Kleidung" level – collapse it.
  { match: ['mode und accessoires', 'kleidung'], replace: ['Kleidung & Accessoires'] },
  { match: ['mode und accessoires'], replace: ['Kleidung & Accessoires'] },

  // Female-specific roots: fold into canonical clothing paths.
  { match: ['damen'], replace: ['Kleidung & Accessoires', 'Damenmode'] },
  { match: ['damenmode'], replace: ['Kleidung & Accessoires', 'Damenmode'] },
  { match: ['damenbekleidung'], replace: ['Kleidung & Accessoires', 'Damenbekleidung'] },
  { match: ['damenunterwaesche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damenunterwäsche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damen unterwaesche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damen unterwäsche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damenwasche und nachtwasche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },
  { match: ['damenwäsche und nachtwäsche'], replace: ['Kleidung & Accessoires', 'Damenmode', 'Unterwäsche & Nachtwäsche'] },

  // Common "single-topic" clothing roots.
  { match: ['herrenhosen'], replace: ['Kleidung & Accessoires', 'Herrenmode', 'Hosen'] },
  { match: ['kinderbekleidung'], replace: ['Kleidung & Accessoires', 'Kinder'] },

  // Motorcycle roots: fold into auto domain root (still conservative).
  { match: ['motorradteile'], replace: ['Auto & Motorrad'] },
  { match: ['motorradzubehor'], replace: ['Auto & Motorrad'] },
  { match: ['motorradzubehör'], replace: ['Auto & Motorrad'] },
];

const SEGMENT_ALIASES = new Map(
  Object.entries({
    // Truncation / typos
    'kostume und verkleid': 'Kostüme & Verkleidungen',
    'kostüme und verkleid': 'Kostüme & Verkleidungen',
    // Minor plural normalization
    'strings und tanga': 'Strings & Tangas',
    'strings und tangas': 'Strings & Tangas',
  })
);

function applyPrefixRules(segments) {
  const normSegs = segments.map((s) => normalizeForMatch(s));
  for (const rule of PREFIX_RULES) {
    const match = rule.match;
    if (normSegs.length < match.length) continue;
    let ok = true;
    for (let i = 0; i < match.length; i += 1) {
      if (normSegs[i] !== match[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const rest = segments.slice(match.length);
    return [...rule.replace, ...rest].map((s) => normalizeSpaces(s));
  }
  return segments.map((s) => normalizeSpaces(s));
}

function applySegmentAliases(segments) {
  return segments
    .map((seg) => {
      const norm = normalizeForMatch(seg);
      const aliased = SEGMENT_ALIASES.get(norm);
      return aliased ? aliased : normalizeSpaces(seg);
    })
    .filter(Boolean);
}

function canonicalizeBreadcrumb(breadcrumb) {
  const originalSegments = splitBreadcrumb(breadcrumb);
  const afterPrefix = applyPrefixRules(originalSegments);
  const afterAliases = applySegmentAliases(afterPrefix);
  const canonical = afterAliases.join(' > ');
  const key = afterAliases.map((s) => normalizeForMatch(s)).join(' > ');
  return { canonical, key, segments: afterAliases };
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
  if (!args.in) {
    throw new Error('Missing --in <csvPath>. Example: --in exports/baselinker-inventory-categories-78659-....csv');
  }
  const inputPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const outDir = path.isAbsolute(args.outDir) ? args.outDir : path.join(process.cwd(), args.outDir);
  ensureDir(outDir);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true });

  const baseName = guessBaseName(inputPath);
  const outMapCsv = path.join(outDir, `${baseName}-consolidation-map.csv`);
  const outConsolidatedCsv = path.join(outDir, `${baseName}-consolidated.csv`);
  const outJson = path.join(outDir, `${baseName}-consolidated.json`);

  const rows = records
    .map((r) => {
      const category_id = safeString(r.category_id);
      const parent_id = safeString(r.parent_id);
      const name = safeString(r.name);
      const breadcrumb = safeString(r.breadcrumb);
      const canon = canonicalizeBreadcrumb(breadcrumb || name);
      return {
        category_id,
        parent_id,
        name,
        breadcrumb,
        canonical_breadcrumb: canon.canonical,
        canonical_key: canon.key,
        canonical_depth: canon.segments.length,
      };
    })
    .filter((r) => r.category_id && r.canonical_breadcrumb);

  // Group by canonical key
  const groups = new Map(); // key -> rows[]
  for (const r of rows) {
    const list = groups.get(r.canonical_key) || [];
    list.push(r);
    groups.set(r.canonical_key, list);
  }

  // Pick representative category_id for each group.
  // Priority:
  // 1) Prefer rows that are already exactly at the canonical breadcrumb (no rewrite needed).
  // 2) Prefer rows whose original root matches the canonical root (stability).
  // 3) Then smallest numeric category_id (deterministic).
  const repByKey = new Map();
  const toNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  for (const [key, list] of groups.entries()) {
    const canonicalBreadcrumb = safeString(list?.[0]?.canonical_breadcrumb);
    const canonicalRoot = splitBreadcrumb(canonicalBreadcrumb)[0] || '';
    const isExact = (r) => normalizeSpaces(r.breadcrumb) === normalizeSpaces(r.canonical_breadcrumb);
    const rootOf = (r) => splitBreadcrumb(r.breadcrumb)[0] || '';
    const sorted = [...list].sort((a, b) => {
      const aExact = isExact(a);
      const bExact = isExact(b);
      if (aExact !== bExact) return aExact ? -1 : 1;

      const aRootMatch = canonicalRoot && rootOf(a) === canonicalRoot;
      const bRootMatch = canonicalRoot && rootOf(b) === canonicalRoot;
      if (aRootMatch !== bRootMatch) return aRootMatch ? -1 : 1;

      const an = toNum(a.category_id);
      const bn = toNum(b.category_id);
      if (an != null && bn != null) return an - bn;
      return String(a.category_id).localeCompare(String(b.category_id));
    });
    repByKey.set(key, sorted[0]?.category_id || '');
  }

  const mapRows = rows
    .map((r) => {
      const canonical_category_id = repByKey.get(r.canonical_key) || '';
      const action =
        canonical_category_id && String(r.category_id) !== String(canonical_category_id)
          ? 'merge_into_canonical'
          : 'keep';
      return {
        category_id: r.category_id,
        breadcrumb: r.breadcrumb,
        canonical_breadcrumb: r.canonical_breadcrumb,
        canonical_category_id,
        action,
      };
    })
    .sort((a, b) => String(a.canonical_breadcrumb).localeCompare(String(b.canonical_breadcrumb), 'de'));

  // Consolidated groups list
  const consolidated = Array.from(groups.entries())
    .map(([key, list]) => {
      const canonical_category_id = repByKey.get(key) || '';
      const canonical_breadcrumb = list[0]?.canonical_breadcrumb || '';
      const ids = list.map((x) => x.category_id).filter(Boolean);
      const roots = Array.from(
        new Set(
          list
            .map((x) => splitBreadcrumb(x.breadcrumb)[0])
            .map((x) => normalizeSpaces(x))
            .filter(Boolean)
        )
      );
      return {
        canonical_category_id,
        canonical_breadcrumb,
        depth: splitBreadcrumb(canonical_breadcrumb).length,
        merged_count: ids.length,
        merged_category_ids: ids.join('|'),
        source_roots: roots.join('|'),
      };
    })
    .sort((a, b) => String(a.canonical_breadcrumb).localeCompare(String(b.canonical_breadcrumb), 'de'));

  // Stats
  const dupGroups = consolidated.filter((c) => Number(c.merged_count) > 1);
  const stats = {
    input_rows: rows.length,
    canonical_groups: consolidated.length,
    duplicate_groups: dupGroups.length,
    rows_that_would_merge: mapRows.filter((m) => m.action === 'merge_into_canonical').length,
    top_duplicate_groups: dupGroups
      .slice()
      .sort((a, b) => Number(b.merged_count) - Number(a.merged_count))
      .slice(0, 20)
      .map((g) => ({
        canonical_breadcrumb: g.canonical_breadcrumb,
        merged_count: g.merged_count,
        source_roots: g.source_roots,
      })),
  };

  fs.writeFileSync(
    outJson,
    JSON.stringify(
      {
        meta: {
          generated_at_iso: new Date().toISOString(),
          input: inputPath,
          outDir,
          stats,
        },
        consolidated,
        mapping: mapRows,
      },
      null,
      2
    ),
    'utf8'
  );

  fs.writeFileSync(
    outMapCsv,
    toCsv(['category_id', 'breadcrumb', 'canonical_breadcrumb', 'canonical_category_id', 'action'], mapRows),
    'utf8'
  );
  fs.writeFileSync(
    outConsolidatedCsv,
    toCsv(
      ['canonical_category_id', 'canonical_breadcrumb', 'depth', 'merged_count', 'merged_category_ids', 'source_roots'],
      consolidated
    ),
    'utf8'
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        input: inputPath,
        out: { consolidated_csv: outConsolidatedCsv, mapping_csv: outMapCsv, json: outJson },
        stats,
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

