const fs = require('fs');
const path = require('path');

// Fix paths to point to the root kaufland directory from backend/lib
const CATEGORY_FILE = path.join(
  __dirname,
  '..',
  '..',
  'kaufland',
  'category_tree_int_all_languages - 📗 category_tree_all_languages.csv'
);

const ATTRIBUTE_FILE = path.join(
  __dirname,
  '..',
  '..',
  'kaufland',
  'attributeValues_all_languages - 📗 all_attribute_values.csv'
);

const CACHE = [];
const ATTR_CACHE = [];

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

function loadAttributes() {
  if (!fs.existsSync(ATTRIBUTE_FILE)) {
    console.warn('[kaufland-taxonomy] Attribute CSV not found at', ATTRIBUTE_FILE);
    return;
  }

  try {
    const raw = fs.readFileSync(ATTRIBUTE_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    // Remove header
    lines.shift();

    const uniqueAttrs = new Map(); // key -> label

    for (const line of lines) {
      // Simple parsing assuming Key is 2nd column and Title is last column.
      const parts = line.split(',');
      if (parts.length < 2) continue;

      const rawKey = parts[1];
      const rawTitle = parts[parts.length - 1]; // Title is specifically the last column in this file structure

      if (rawKey && rawTitle) {
        const keyClean = rawKey.replace(/^"|"$/g, '').trim();
        const titleClean = rawTitle.replace(/^"|"$/g, '').trim();

        if (keyClean && titleClean && keyClean !== 'attribute') {
          uniqueAttrs.set(keyClean, titleClean);
        }
      }
    }

    uniqueAttrs.forEach((label, name) => {
      ATTR_CACHE.push({ name, label });
    });

    ATTR_CACHE.sort((a, b) => a.name.localeCompare(b.name));

  } catch (error) {
    console.warn('[kaufland-taxonomy] Failed to load attributes:', error.message);
  }
}

function ensureLoaded() {
  if (!CACHE.length) {
    loadCsv();
  }
}

function getKauflandAttributes() {
  if (!ATTR_CACHE.length) {
    loadAttributes();
  }
  return ATTR_CACHE;
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
  getKauflandAttributes,
};
