const fs = require('fs');
const path = require('path');

const CATEGORY_PATH = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const ASPECT_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects.json');

let categories = {};
let requiredAspects = {};
let uniqueNameToId = new Map();

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

  // Build a unique name index to avoid ambiguous leaf-name matches ("Sonstige", "Elektronik & Computer", ...).
  const counts = new Map(); // name -> count
  const firstId = new Map(); // name -> id (first seen)
  for (const key of Object.keys(categories || {})) {
    const cat = categories[key];
    const n = normalize(cat?.name);
    if (!n) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
    if (!firstId.has(n)) {
      const idCandidate = cat?.id ?? cat?.categoryId ?? key;
      firstId.set(n, String(idCandidate));
    }
  }
  uniqueNameToId = new Map();
  counts.forEach((count, name) => {
    if (count === 1) {
      uniqueNameToId.set(name, firstId.get(name));
    }
  });
}

hydrate();

function normalize(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .trim()
    // Normalize German umlauts for more robust matching across sources.
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    // Treat hyphens/dashes as spaces.
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findEbayCategory(rawCategory) {
  if (rawCategory && typeof rawCategory === 'number') {
    const byId = categories[String(rawCategory)] || categories[rawCategory];
    if (byId) return byId;
  }
  // Support numeric-string IDs as well.
  if (rawCategory && typeof rawCategory === 'string') {
    const trimmed = rawCategory.trim();
    if (/^\d+$/.test(trimmed)) {
      const byId = categories[trimmed];
      if (byId) return byId;
    }
  }

  const needleRaw = (rawCategory || '').toString();
  const needle = normalize(needleRaw);
  if (!needle) return null;

  // Leaf-name only (no breadcrumb separators) is extremely ambiguous on eBay.
  // Only allow it when the name is unique across the taxonomy.
  if (!needleRaw.includes('>')) {
    const uniqueId = uniqueNameToId.get(needle);
    if (uniqueId && categories[String(uniqueId)]) {
      return categories[String(uniqueId)];
    }
    return null;
  }

  const needleSegs = needle
    .split('>')
    .map((s) => normalize(s))
    .filter(Boolean);
  const needleLast = needleSegs[needleSegs.length - 1] || '';
  const needleTokens = needleLast.split(/[^a-z0-9]+/).filter(Boolean);

  const matchToken = (token, candidate) => {
    if (!token || !candidate) return false;
    return token === candidate || token.includes(candidate) || candidate.includes(token);
  };

  const minPrefix = needleSegs.length >= 2 ? 2 : 1;
  let best = null;
  let bestScore = -1;

  for (const key of Object.keys(categories)) {
    const cat = categories[key];
    const breadcrumb = cat?.breadcrumb ? String(cat.breadcrumb) : '';
    if (!breadcrumb) continue;
    const haySegs = breadcrumb
      .split('>')
      .map((s) => normalize(s))
      .filter(Boolean);

    let prefix = 0;
    for (let i = 0; i < Math.min(needleSegs.length, haySegs.length); i += 1) {
      if (needleSegs[i] === haySegs[i]) {
        prefix += 1;
      } else {
        break;
      }
    }
    if (prefix < minPrefix) continue;

    const nameTokens = normalize(cat?.name || '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const overlapLast = nameTokens.filter((t) => needleTokens.some((n) => matchToken(n, t))).length;

    // Score: prefer stronger breadcrumb prefix matches, then prefer leaf-token overlap.
    const score = prefix * 100 + overlapLast * 25 + haySegs.length;
    if (score > bestScore) {
      bestScore = score;
      best = cat;
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
