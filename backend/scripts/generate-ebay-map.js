/* eslint-disable no-console */
/**
 * Utility to build an inventory category -> eBay category ID mapping.
 *
 * Usage:
 *   node backend/scripts/generate-ebay-map.js > /tmp/ebay-map.json
 *
 * The script reads:
 *   - backend/scripts/output/inventory-78659-categories.json (inventory category export)
 *   - exports/BL products.csv (current product export)
 *   - backend/ebay-data/categories.json (full eBay taxonomy incl. breadcrumbs)
 *
 * It tries to find the closest eBay category for each inventory category by:
 *   1. Exact breadcrumb match
 *   2. Unique leaf-name match
 *   3. Fuzzy token matching with scoring
 *
 * Outputs JSON with:
 *   {
 *     "<inventory category>": {
 *        "id": "<ebayId>",
 *        "breadcrumb": "<eBay breadcrumb>",
 *        "score": <confidence score>,
 *        "source": "manual|exact|leaf|fuzzy"
 *     },
 *     ...
 *   }
 *
 * The JSON can be used to update components like backend/services/ebay_mapping.js.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const BASE_DIR = path.join(__dirname, '..', '..');
const EBAY_DATA = require('../ebay-data/categories.json');
const BL_CATEGORY_EXPORT = require('./output/inventory-78659-categories.json');

const BL_PRODUCTS_CSV = path.join(BASE_DIR, 'exports', 'BL products.csv');

function normalize(raw) {
  if (!raw) return '';
  return raw
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' und ')
    .replace(/[()/]/g, ' ')
    .replace(/[-_,.]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(normalized) {
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

function loadEbayEntries() {
  return Object.values(EBAY_DATA)
    .map((entry) => {
      const breadcrumb = entry?.breadcrumb || entry?.name || '';
      if (!breadcrumb) return null;
      const segments = breadcrumb.split('>').map((s) => s.trim()).filter(Boolean);
      const leaf = segments[segments.length - 1] || '';
      const normBreadcrumb = normalize(breadcrumb.replace(/>/g, ' '));
      const normLeaf = normalize(leaf);
      return {
        id: String(entry.id),
        breadcrumb,
        leaf,
        normBreadcrumb,
        normLeaf,
        tokensBreadcrumb: tokenize(normBreadcrumb),
        tokensLeaf: tokenize(normLeaf),
      };
    })
    .filter(Boolean);
}

function loadInventoryCategories() {
  const names = new Set();
  const add = (value) => {
    if (!value) return;
    const trimmed = value.toString().trim();
    if (!trimmed || trimmed === '–' || trimmed === '-') return;
    names.add(trimmed);
  };

  BL_CATEGORY_EXPORT.forEach((entry) => add(entry?.name));

  if (fs.existsSync(BL_PRODUCTS_CSV)) {
    const csvContent = fs.readFileSync(BL_PRODUCTS_CSV, 'utf8');
    const rows = parse(csvContent, { columns: true, skip_empty_lines: true });
    rows.forEach((row) => add(row.Kategorie || row.category || row.product_category_name));
  } else {
    console.warn('[warn] Products CSV not found, using inventory export only.');
  }

  return Array.from(names).sort((a, b) => a.localeCompare(b, 'de'));
}

const EBAY_ENTRIES = loadEbayEntries();
const CATEGORIES = loadInventoryCategories();

const EXACT_BREADCRUMB = new Map();
const LEAF_BUCKET = new Map();

EBAY_ENTRIES.forEach((entry) => {
  if (entry.normBreadcrumb && !EXACT_BREADCRUMB.has(entry.normBreadcrumb)) {
    EXACT_BREADCRUMB.set(entry.normBreadcrumb, entry);
  }
  if (entry.normLeaf) {
    const bucket = LEAF_BUCKET.get(entry.normLeaf) || [];
    bucket.push(entry);
    LEAF_BUCKET.set(entry.normLeaf, bucket);
  }
});

const manualOverrides = new Map(
  Object.entries({
    Accessoires: '4250',
    'Akku-Hartbodenreiniger': '184381',
    'Akku-Staubsauger': '20617',
    Autoabdeckung: '180136',
    'Autoabdeckung / Hagelschutzplane': '180136',
    Baby: '2984',
    'Bad & Küche': '20625',
    'Beistelltisch / Side Table': '38204',
    Bürostuhl: '68464',
    Campingliege: '87099',
    'Dutch Oven / Feuertopf': '98844',
    Gartenbank: '260928',
    Hagelschutzplane: '180136',
    Hallenleuchte: '26219',
    'Heizlüfter / Keramikheizlüfter': '20613',
    Hoodie: '5084',
    'Rucksack / Rolltop': '181379',
    Standventilator: '20612',
    'Teleskopschiene / Schubladenschiene': '134642',
    'Ventilator / Windmaschine': '185114',
    Weihnachtsdeko: '166725',
    'Yogamatte / Trainingsmatte': '158928',
  })
);

function computeScore(entry, normName, tokens) {
  if (!entry.normLeaf) return 0;
  if (entry.normLeaf === normName) return 140;

  const entryTokens = entry.tokensLeaf;
  const intersectionLeaf = tokens.filter((token) => entryTokens.includes(token));
  const ratioLeaf = intersectionLeaf.length / Math.max(tokens.length, 1);
  const intersectionBreadcrumb = tokens.filter((token) => entry.tokensBreadcrumb.includes(token));

  let score = 0;
  score += intersectionLeaf.length * 14;
  score += ratioLeaf * 18;
  score += intersectionBreadcrumb.length * 4;

  const partialLeaf = tokens.some((token) =>
    entry.normLeaf.includes(token) || token.includes(entry.normLeaf)
  );
  if (partialLeaf) score += 12;

  if (entry.normLeaf.includes(normName)) score += 65;
  if (normName.includes(entry.normLeaf)) score += 45;
  if (entry.normBreadcrumb.includes(normName)) score += 10;
  if (entry.normLeaf.startsWith(normName) || normName.startsWith(entry.normLeaf)) score += 8;

  const lengthPenalty = Math.abs(entry.normLeaf.length - normName.length);
  score -= Math.min(lengthPenalty, 40) * 0.35;

  if (entry.normLeaf === 'sonstige') score -= 30;
  if (entry.normLeaf.includes('sonstige')) score -= 18;

  return score;
}

function findBestMatch(name) {
  const manual = manualOverrides.get(name);
  if (manual) {
    const entry = EBAY_ENTRIES.find((item) => item.id === manual);
    return entry
      ? { ...entry, score: 999, source: 'manual' }
      : { id: manual, breadcrumb: 'MANUAL', score: 999, source: 'manual' };
  }

  const normName = normalize(name);
  if (!normName) return null;
  const tokens = tokenize(normName);

  const exact = EXACT_BREADCRUMB.get(normName);
  if (exact) {
    return { ...exact, score: 200, source: 'exact' };
  }

  const leafMatches = LEAF_BUCKET.get(normName);
  if (leafMatches && leafMatches.length === 1) {
    return { ...leafMatches[0], score: 160, source: 'leaf' };
  }

  let best = null;
  for (const entry of EBAY_ENTRIES) {
    const score = computeScore(entry, normName, tokens);
    if (!best || score > best.score) {
      best = { ...entry, score, source: 'fuzzy' };
    }
  }
  return best;
}

const result = {};
const unresolved = [];

CATEGORIES.forEach((name) => {
  const best = findBestMatch(name);
  if (!best || best.score < 30 || !best.id) {
    unresolved.push({
      name,
      best: best
        ? { id: best.id, breadcrumb: best.breadcrumb, score: Number(best.score.toFixed(2)) }
        : null,
    });
    return;
  }
  result[name] = {
    id: best.id,
    breadcrumb: best.breadcrumb,
    score: Number(best.score.toFixed(2)),
    source: best.source,
  };
});

console.log(
  JSON.stringify(
    {
      generated_at_iso: new Date().toISOString(),
      total: CATEGORIES.length,
      mapped: Object.keys(result).length,
      unresolved: unresolved.length,
      mapping: result,
      unresolved_samples: unresolved.slice(0, 20),
    },
    null,
    2
  )
);

if (unresolved.length) {
  console.error(
    `\n[warn] ${unresolved.length} categories unresolved or low confidence. Check stdout for details.`
  );
}


