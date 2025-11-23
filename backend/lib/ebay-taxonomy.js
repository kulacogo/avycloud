const fs = require('fs');
const path = require('path');

const CATEGORY_PATH = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const ASPECT_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects.json');

let categories = {};
let requiredAspects = {};

function loadJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[ebay-taxonomy] Failed to load ${filePath}:`, error.message);
    return {};
  }
}

function hydrate() {
  categories = loadJsonSafe(CATEGORY_PATH);
  requiredAspects = loadJsonSafe(ASPECT_PATH);
}

hydrate();

function normalize(text) {
  return (text || '').toString().toLowerCase().trim();
}

function findEbayCategory(rawCategory) {
  if (rawCategory && typeof rawCategory === 'number') {
    const byId = categories[String(rawCategory)] || categories[rawCategory];
    if (byId) return byId;
  }
  const needle = normalize(rawCategory);
  if (!needle) return null;
  let best = null;
  let bestScore = 0;

  for (const key of Object.keys(categories)) {
    const cat = categories[key];
    const hay = normalize(cat.breadcrumb);
    if (!hay) continue;

    // simple scoring: substring match weighted by length of overlap
    if (hay.includes(needle)) {
      const score = needle.length;
      if (score > bestScore) {
        bestScore = score;
        best = cat;
      }
    } else {
      const name = normalize(cat.name);
      if (name && needle.includes(name)) {
        const score = name.length;
        if (score > bestScore) {
          bestScore = score;
          best = cat;
        }
      }
    }
  }

  return best;
}

function getRequiredAspects(categoryId) {
  if (!categoryId) return [];
  const key = typeof categoryId === 'number' ? String(categoryId) : categoryId.toString();
  const list = requiredAspects[key];
  if (Array.isArray(list)) return list;
  return [];
}

module.exports = {
  findEbayCategory,
  getRequiredAspects,
};
