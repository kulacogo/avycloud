const fs = require('fs');
const path = require('path');

const CATEGORY_FILE = path.join(
  __dirname,
  '..',
  'kaufland',
  'category_tree_int_all_languages - 📕 category_tree_all_languages.csv'
);

const CACHE = [];

function loadCsv() {
  if (!fs.existsSync(CATEGORY_FILE)) {
    console.warn('[kaufland-taxonomy] Category CSV not found at', CATEGORY_FILE);
    return;
  }

  try {
    const raw = fs.readFileSync(CATEGORY_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = lines.shift();
    if (!header) {
      console.warn('[kaufland-taxonomy] CSV header missing');
      return;
    }
    for (const line of lines) {
      const cols = line.split(',');
      if (!cols.length) continue;
      const id = cols[0]?.trim();
      if (!id) continue;
      const deCols = cols.slice(1, 10).map((entry) => entry?.trim()).filter(Boolean);
      const enCols = cols.slice(10, 19).map((entry) => entry?.trim()).filter(Boolean);
      const dePath = deCols.join(' > ');
      const enPath = enCols.join(' > ');
      const normalized = `${dePath} ${enPath}`.toLowerCase();
      CACHE.push({
        id,
        dePath,
        enPath,
        normalized,
      });
    }
    if (!CACHE.length) {
      console.warn('[kaufland-taxonomy] CSV parsed but produced no entries');
    }
  } catch (error) {
    console.warn('[kaufland-taxonomy] Failed to load categories:', error.message);
  }
}

function ensureLoaded() {
  if (!CACHE.length) {
    loadCsv();
  }
}

function normalize(text) {
  return (text || '').toString().toLowerCase().trim();
}

function scoreMatch(needle, haystack) {
  if (!needle || !haystack) return 0;
  if (haystack.includes(needle)) {
    return needle.length + 5;
  }
  if (needle.includes(haystack)) {
    return haystack.length;
  }
  let score = 0;
  const tokens = needle.split(/[\s\/,;>-]+/).filter(Boolean);
  tokens.forEach((token) => {
    if (haystack.includes(token)) {
      score += token.length;
    }
  });
  return score;
}

function findKauflandCategory(rawCategory) {
  ensureLoaded();
  if (!rawCategory) return null;
  const normalizedNeedle = normalize(rawCategory);
  if (!normalizedNeedle) return null;
  let best = null;
  let bestScore = 0;

  for (const category of CACHE) {
    const score = scoreMatch(normalizedNeedle, category.normalized);
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }

  return best;
}

module.exports = {
  findKauflandCategory,
};

