/* eslint-disable no-console */
/**
 * Build a compact "Avy" canonical taxonomy from marketplace category trees (Kaufland/eBay/hood),
 * aiming to cover marketplace concepts with far fewer categories for inventory mapping.
 *
 * Output:
 * - backend/avy-taxonomy/avy-taxonomy.json  (taxonomy tree + mapping helpers metadata)
 * - exports/avy-taxonomy/avy-taxonomy.csv  (flat list of paths)
 * - exports/avy-taxonomy/avy-taxonomy-stats.json
 *
 * Usage:
 *   node backend/scripts/build-avy-taxonomy-from-marketplaces.js \
 *     --kaufland "kaufland categories.csv" \
 *     --ebay "all ebay kategorien mit struktur.csv" \
 *     --hood "backend/exports/hood/categories-hood.csv"
 *
 * Notes:
 * - This is deterministic and heuristic-based (no LLM).
 * - It intentionally prunes long tails into "Sonstige".
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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value, delimiter = ',') {
  const s = value == null ? '' : String(value);
  const needs = s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delimiter) || /^\s|\s$/.test(s);
  if (!needs) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function parseArgs(argv) {
  const args = {
    kaufland: path.join(process.cwd(), 'kaufland categories.csv'),
    ebay: path.join(process.cwd(), 'all ebay kategorien mit struktur.csv'),
    hood: path.join(process.cwd(), 'backend', 'exports', 'hood', 'categories-hood.csv'),
    outDir: path.join(process.cwd(), 'exports', 'avy-taxonomy'),
    outJson: path.join(process.cwd(), 'backend', 'avy-taxonomy', 'avy-taxonomy.json'),
    // pruning
    topK2: 18,
    minCount2: 8,
    topK3: 8,
    minCount3: 5,
    maxDepth: 3,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--kaufland') args.kaufland = argv[i + 1], i += 1;
    else if (t === '--ebay') args.ebay = argv[i + 1], i += 1;
    else if (t === '--hood') args.hood = argv[i + 1], i += 1;
    else if (t === '--outDir') args.outDir = argv[i + 1], i += 1;
    else if (t === '--outJson') args.outJson = argv[i + 1], i += 1;
    else if (t === '--topK2') args.topK2 = Number(argv[i + 1]), i += 1;
    else if (t === '--minCount2') args.minCount2 = Number(argv[i + 1]), i += 1;
    else if (t === '--topK3') args.topK3 = Number(argv[i + 1]), i += 1;
    else if (t === '--minCount3') args.minCount3 = Number(argv[i + 1]), i += 1;
    else if (t === '--maxDepth') args.maxDepth = Number(argv[i + 1]), i += 1;
  }
  return args;
}

// --- Root mapping (few global domains) ---
const ROOTS = [
  'Auto & Motorrad',
  'Baby & Kind',
  'Beauty & Gesundheit',
  'Business & Industrie',
  'Elektronik',
  'Haushalt & Küche',
  'Heimwerker & Garten',
  'Mode & Accessoires',
  'Möbel & Wohnen',
  'Musik & Instrumente',
  'Sport & Outdoor',
  'Spielwaren',
  'Sammeln & Kunst',
  'Büro & Schreibwaren',
  'Bücher & Medien',
  'Tierbedarf',
  'Reisen & Gepäck',
];

function mapRoot(rawRoot) {
  const r = normalizeForMatch(rawRoot);
  if (!r) return null;
  const has = (re) => re.test(r);
  if (has(/\b(auto|motorrad|kfz|fahrzeug)\b/)) return 'Auto & Motorrad';
  if (has(/\b(baby|kind|kinder)\b/)) return 'Baby & Kind';
  if (has(/\b(beauty|kosmetik|pflege|gesundheit|hygiene)\b/)) return 'Beauty & Gesundheit';
  if (has(/\b(business|industrie|gewerbe|grosshandel|groshandel)\b/)) return 'Business & Industrie';
  if (has(/\b(elektronik|computer|hifi|audio|telefon|smart|tv|kamera)\b/)) return 'Elektronik';
  if (has(/\b(kueche|küche|haushalt|kochen)\b/)) return 'Haushalt & Küche';
  if (has(/\b(heimwerker|garten|terrasse|baumarkt)\b/)) return 'Heimwerker & Garten';
  if (has(/\b(mode|bekleidung|kleidung|schuhe|accessoires|taschen)\b/)) return 'Mode & Accessoires';
  if (has(/\b(mobel|möbel|wohnen)\b/)) return 'Möbel & Wohnen';
  if (has(/\b(musik|instrument)\b/)) return 'Musik & Instrumente';
  if (has(/\b(sport|outdoor|camping|fitness)\b/)) return 'Sport & Outdoor';
  if (has(/\b(spielwaren|spielzeug|modellbau)\b/)) return 'Spielwaren';
  if (has(/\b(sammeln|antiquitat|antiquität|kunst|munzen|münzen|briefmarken)\b/)) return 'Sammeln & Kunst';
  if (has(/\b(buro|büro|schreibwaren)\b/)) return 'Büro & Schreibwaren';
  if (has(/\b(buch|bücher|medien|dvd|film)\b/)) return 'Bücher & Medien';
  if (has(/\b(tier|haustier)\b/)) return 'Tierbedarf';
  if (has(/\b(reise|gepack|gepäck|koffer)\b/)) return 'Reisen & Gepäck';
  // Fallback: keep closest by exact known roots
  const exact = ROOTS.find((x) => normalizeForMatch(x) === r);
  return exact || null;
}

const SEGMENT_ALIASES = new Map(
  Object.entries({
    // Fashion
    herrenmode: 'Herren',
    damenmode: 'Damen',
    'shirts und hemden': 'Shirts & Hemden',
    't-shirts und hemden': 'Shirts & Hemden',
    'hemden und oberteile': 'Shirts & Hemden',
    // Auto
    'ole und flussigkeiten': 'Öle & Flüssigkeiten',
    'öle und flüssigkeiten': 'Öle & Flüssigkeiten',
    // Generic cleanup
    sonstige: 'Sonstige',
  })
);

function cleanSegment(seg) {
  const raw = normalizeSpaces(seg);
  if (!raw) return '';
  // Remove common marketplace marketing suffixes
  const stripped = raw
    .replace(/,\s*g[üu]nstig kaufen.*$/i, '')
    .replace(/\s+g[üu]nstig kaufen.*$/i, '')
    .replace(/:\s*kaufen.*$/i, '')
    .replace(/\s+bei\s+hood\.de$/i, '')
    .replace(/\s+kaufen\s+bei\s+hood\.de$/i, '')
    .replace(/\s+\-\s*kaufen\s+bei\s+hood\.de$/i, '')
    .replace(/\s+kaufen$/i, '')
    .trim();
  const key = normalizeForMatch(stripped);
  const aliased = SEGMENT_ALIASES.get(key);
  return aliased ? aliased : stripped;
}

function takeNonGeneric(segments) {
  return segments.filter((s) => {
    const k = normalizeForMatch(s);
    if (!k) return false;
    if (k === 'sonstige') return false;
    if (k.startsWith('sonstig')) return false;
    return true;
  });
}

function parseKaufland(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, delimiter: ';', relax_quotes: true });
  const paths = [];
  for (const r of records) {
    const segs = [];
    for (let i = 1; i <= 9; i += 1) {
      const v = r[`DE_level_${i}_title_category`];
      const s = cleanSegment(v);
      if (s) segs.push(s);
    }
    if (segs.length) paths.push({ source: 'kaufland', segments: segs });
  }
  return paths;
}

// eBay: hierarchical rows with sparse L1..L6 columns.
function parseEbay(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, { columns: false, skip_empty_lines: true, relax_quotes: true });
  // Find header row index containing L1..Kategorienummer
  let startIdx = 0;
  for (let i = 0; i < Math.min(records.length, 20); i += 1) {
    const row = records[i] || [];
    if (String(row[0] || '').trim() === 'L1' && String(row[6] || '').toLowerCase().includes('kategorienummer')) {
      startIdx = i + 1;
      break;
    }
  }
  const current = ['', '', '', '', '', ''];
  const paths = [];
  for (let i = startIdx; i < records.length; i += 1) {
    const row = records[i] || [];
    // row[0..5] are L1..L6, row[6] is category id
    let hasAny = false;
    for (let lvl = 0; lvl < 6; lvl += 1) {
      const cell = cleanSegment(row[lvl]);
      if (cell) {
        current[lvl] = cell;
        // clear deeper
        for (let d = lvl + 1; d < 6; d += 1) current[d] = '';
        hasAny = true;
      }
    }
    if (!hasAny) continue;
    const segs = current.filter(Boolean);
    if (segs.length) paths.push({ source: 'ebay', segments: segs });
  }
  return paths;
}

// hood: use parentId chain, ignore the "path" column (contains marketing noise)
function parseHood(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const records = parse(raw, { columns: true, skip_empty_lines: true, relax_quotes: true });
  const byId = new Map();
  for (const r of records) {
    const id = safeString(r.id);
    if (!id) continue;
    const name = cleanSegment(r.name);
    const parentId = safeString(r.parentId);
    byId.set(id, { id, name, parentId: parentId && parentId !== '0' ? parentId : null });
  }
  const memo = new Map();
  const build = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    if (!node || !node.name) {
      memo.set(id, []);
      return [];
    }
    if (stack.has(id)) {
      memo.set(id, [node.name]);
      return [node.name];
    }
    stack.add(id);
    const parentSegs = node.parentId ? build(node.parentId, stack) : [];
    stack.delete(id);
    const segs = [...parentSegs, node.name];
    memo.set(id, segs);
    return segs;
  };
  const paths = [];
  for (const id of byId.keys()) {
    const segs = build(id).filter(Boolean);
    if (segs.length) paths.push({ source: 'hood', segments: segs });
  }
  return paths;
}

function buildAvyPathFromMarketplaceSegments(segments, { maxDepth }) {
  const cleaned = segments.map(cleanSegment).filter(Boolean);
  if (!cleaned.length) return null;
  const root = mapRoot(cleaned[0]) || mapRoot(cleaned.slice(0, 2).join(' '));
  if (!root) return null;
  const rest = cleaned.slice(1);
  // take first two meaningful segments after root
  const meaningful = takeNonGeneric(rest);
  const lvl2 = meaningful[0] ? cleanSegment(meaningful[0]) : 'Sonstige';
  const lvl3 = meaningful[1] ? cleanSegment(meaningful[1]) : '';
  const out = [root, lvl2].filter(Boolean);
  if (maxDepth >= 3 && lvl3) out.push(lvl3);
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const kPath = path.isAbsolute(args.kaufland) ? args.kaufland : path.join(process.cwd(), args.kaufland);
  const ePath = path.isAbsolute(args.ebay) ? args.ebay : path.join(process.cwd(), args.ebay);
  const hPath = path.isAbsolute(args.hood) ? args.hood : path.join(process.cwd(), args.hood);

  if (!fs.existsSync(kPath)) throw new Error(`Missing kaufland file: ${kPath}`);
  if (!fs.existsSync(ePath)) throw new Error(`Missing ebay file: ${ePath}`);
  if (!fs.existsSync(hPath)) throw new Error(`Missing hood file: ${hPath}`);

  ensureDir(args.outDir);
  ensureDir(path.dirname(args.outJson));

  const rawPaths = []
    .concat(parseKaufland(kPath))
    .concat(parseEbay(ePath))
    .concat(parseHood(hPath));

  const mapped = rawPaths
    .map((p) => {
      const avySegs = buildAvyPathFromMarketplaceSegments(p.segments, { maxDepth: args.maxDepth });
      if (!avySegs || avySegs.length < 2) return null;
      const root = avySegs[0];
      const lvl2 = avySegs[1];
      const lvl3 = avySegs[2] || '';
      return {
        source: p.source,
        root,
        lvl2,
        lvl3,
        path: [root, lvl2, lvl3].filter(Boolean).join(' > '),
      };
    })
    .filter(Boolean);

  // Frequency counts
  const count2 = new Map(); // root|||lvl2 -> count
  const count3 = new Map(); // root|||lvl2|||lvl3 -> count
  const rootsCount = new Map(); // root -> count
  for (const m of mapped) {
    rootsCount.set(m.root, (rootsCount.get(m.root) || 0) + 1);
    const k2 = `${m.root}|||${m.lvl2}`;
    count2.set(k2, (count2.get(k2) || 0) + 1);
    if (m.lvl3) {
      const k3 = `${m.root}|||${m.lvl2}|||${m.lvl3}`;
      count3.set(k3, (count3.get(k3) || 0) + 1);
    }
  }

  // Determine kept lvl2 per root
  const kept2ByRoot = new Map(); // root -> Set(lvl2)
  for (const root of ROOTS) kept2ByRoot.set(root, new Set(['Sonstige']));
  const byRoot2 = new Map(); // root -> [{lvl2,count}]
  for (const [k, c] of count2.entries()) {
    const [root, lvl2] = k.split('|||');
    if (!byRoot2.has(root)) byRoot2.set(root, []);
    byRoot2.get(root).push({ lvl2, count: c });
  }
  for (const [root, list] of byRoot2.entries()) {
    list.sort((a, b) => b.count - a.count || a.lvl2.localeCompare(b.lvl2, 'de'));
    const kept = kept2ByRoot.get(root) || new Set(['Sonstige']);
    for (const item of list.slice(0, args.topK2)) {
      if (item.count >= args.minCount2) kept.add(item.lvl2);
    }
    kept2ByRoot.set(root, kept);
  }

  // Determine kept lvl3 per (root,lvl2)
  const kept3ByRoot2 = new Map(); // `${root}|||${lvl2}` -> Set(lvl3)
  const byRoot23 = new Map(); // root|||lvl2 -> [{lvl3,count}]
  for (const [k, c] of count3.entries()) {
    const [root, lvl2, lvl3] = k.split('|||');
    const key = `${root}|||${lvl2}`;
    if (!byRoot23.has(key)) byRoot23.set(key, []);
    byRoot23.get(key).push({ lvl3, count: c });
  }
  for (const [key, list] of byRoot23.entries()) {
    list.sort((a, b) => b.count - a.count || a.lvl3.localeCompare(b.lvl3, 'de'));
    const kept = new Set();
    for (const item of list.slice(0, args.topK3)) {
      if (item.count >= args.minCount3) kept.add(item.lvl3);
    }
    if (kept.size) kept3ByRoot2.set(key, kept);
  }

  // Build final taxonomy paths
  const finalPaths = new Set();
  ROOTS.forEach((r) => finalPaths.add(r));
  for (const [root, set2] of kept2ByRoot.entries()) {
    for (const lvl2 of set2) {
      finalPaths.add([root, lvl2].join(' > '));
      const key = `${root}|||${lvl2}`;
      const set3 = kept3ByRoot2.get(key);
      if (set3) {
        for (const lvl3 of set3) {
          finalPaths.add([root, lvl2, lvl3].join(' > '));
        }
      }
    }
  }

  const taxonomyList = Array.from(finalPaths).sort((a, b) => a.localeCompare(b, 'de'));

  // Persist JSON
  const outJson = {
    meta: {
      generated_at_iso: new Date().toISOString(),
      sources: { kaufland: kPath, ebay: ePath, hood: hPath },
      pruning: {
        topK2: args.topK2,
        minCount2: args.minCount2,
        topK3: args.topK3,
        minCount3: args.minCount3,
        maxDepth: args.maxDepth,
      },
      stats: {
        raw_paths: rawPaths.length,
        mapped_paths: mapped.length,
        final_categories: taxonomyList.length,
      },
    },
    roots: ROOTS,
    categories: taxonomyList,
  };
  fs.writeFileSync(args.outJson, JSON.stringify(outJson, null, 2), 'utf8');

  // Persist CSV
  const outCsvPath = path.join(args.outDir, 'avy-taxonomy.csv');
  const csv = ['path', ...taxonomyList.map((p) => csvEscape(p))].join('\n') + '\n';
  fs.writeFileSync(outCsvPath, csv, 'utf8');

  const outStatsPath = path.join(args.outDir, 'avy-taxonomy-stats.json');
  fs.writeFileSync(outStatsPath, JSON.stringify(outJson.meta, null, 2), 'utf8');

  console.log(
    JSON.stringify(
      {
        ok: true,
        out: { json: args.outJson, csv: outCsvPath, stats: outStatsPath },
        stats: outJson.meta.stats,
        sample: taxonomyList.slice(0, 25),
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

