const fs = require('fs');
const path = require('path');
const csvParse = require('csv-parse/sync');

// Files live in /app/kaufland when the backend directory is copied into the image
const CATEGORY_FILE = path.join(__dirname, '..', 'kaufland', 'category_tree_all_languages.csv');
const ATTRIBUTE_FILE = path.join(__dirname, '..', 'kaufland', 'attribute_values_all_languages.csv');

let CATEGORY_CACHE = [];
let ATTR_CACHE = [];

function loadCategoryCsv() {
  if (!fs.existsSync(CATEGORY_FILE)) {
    console.warn('[kaufland-taxonomy] Category CSV not found at', CATEGORY_FILE);
    return;
  }
  try {
    const raw = fs.readFileSync(CATEGORY_FILE, 'utf8');
    const rows = csvParse.parse(raw, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_quotes: true,
    });
    CATEGORY_CACHE = rows
      .map((row) => {
        const id =
          row.id_category ||
          row.category_id ||
          row.id ||
          row.CategoryId ||
          row.categoryId;
        const pathParts = [
          row.DE_level_1_title_category,
          row.DE_level_2_title_category,
          row.DE_level_3_title_category,
          row.DE_level_4_title_category,
          row.DE_level_5_title_category,
          row.DE_level_6_title_category,
          row.DE_level_7_title_category,
          row.DE_level_8_title_category,
          row.DE_level_9_title_category,
        ].map((p) => (p ? p.toString().trim() : '')).filter(Boolean);
        const dePath = pathParts.join(' > ');
        const normalized = `${dePath}`.toLowerCase().trim();
        if (!id || !normalized) return null;
        return { id: id.toString().trim(), dePath, normalized };
      })
      .filter(Boolean);
    if (!CATEGORY_CACHE.length) {
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
    const rows = csvParse.parse(raw, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      relax_quotes: true,
    });
    const unique = new Map();
    rows.forEach((row) => {
      const name = (row.attribute || row.key || row.name || '').toString().trim();
      const label = (row.title || row.value || '').toString().trim();
      if (name && label) unique.set(name, label);
    });
    ATTR_CACHE = Array.from(unique.entries())
      .map(([name, label]) => ({ name, label }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    console.warn('[kaufland-taxonomy] Failed to load attributes:', error.message);
  }
}

function ensureCategories() {
  if (!CATEGORY_CACHE.length) {
    loadCategoryCsv();
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
  if (haystack.includes(needle)) return needle.length + 5;
  if (needle.includes(haystack)) return haystack.length;
  let score = 0;
  const tokens = needle.split(/[\s\/,;>-]+/).filter(Boolean);
  tokens.forEach((token) => {
    if (haystack.includes(token)) score += token.length;
  });
  return score;
}

function findKauflandCategory(rawCategory) {
  ensureCategories();
  if (!rawCategory) return null;
  const normalizedNeedle = normalize(rawCategory);
  if (!normalizedNeedle) return null;
  let best = null;
  let bestScore = 0;
  for (const category of CATEGORY_CACHE) {
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
