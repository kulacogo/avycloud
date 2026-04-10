const fs = require('fs');
const path = require('path');
const { decodeHtmlEntitiesDeep } = require('./html-entities');

const CATEGORY_PATH = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const ASPECT_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects.json');
const FULL_ASPECT_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects-full.json');
const ASPECT_CATALOG_PATH = path.join(__dirname, '..', 'ebay-data', 'aspects-full.json');
const AUTO_ASPECT_PATH = path.join(
  __dirname,
  '..',
  'ebay-data',
  'required-aspects-auto-motorradteile.json'
);

let categories = {};
let requiredAspects = {};
let autoRequiredAspects = {};
let aspectCatalogByCategory = {};
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
  const baseRequiredAspects = loadJsonSafe(ASPECT_PATH);
  const fullRequiredAspects = loadJsonSafe(FULL_ASPECT_PATH);
  const fullAspectCatalog = loadJsonSafe(ASPECT_CATALOG_PATH);
  requiredAspects = {
    ...(baseRequiredAspects && typeof baseRequiredAspects === 'object' ? baseRequiredAspects : {}),
    ...(fullRequiredAspects && typeof fullRequiredAspects === 'object' ? fullRequiredAspects : {}),
  };
  aspectCatalogByCategory = fullAspectCatalog && typeof fullAspectCatalog === 'object' ? fullAspectCatalog : {};
  const autoRaw = loadJsonSafe(AUTO_ASPECT_PATH);
  autoRequiredAspects =
    autoRaw && typeof autoRaw === 'object' && autoRaw.required_aspects_by_category_id
      ? autoRaw.required_aspects_by_category_id
      : {};

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
  return decodeHtmlEntitiesDeep((text || '').toString())
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

  // Require at least 2 matching breadcrumb segments (strict prefix match).
  // This prevents cross-branch mismatches (e.g. "Grillkörbe" → "Blumentöpfe").
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
    const overlapLast = nameTokens.filter((t) =>
      needleTokens.some((n) => n === t || n.includes(t) || t.includes(n))
    ).length;

    // Score: prefix match strength + leaf token overlap + depth bonus
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
  const catalog = getCategoryAspectCatalog(key);
  const base = catalog.requiredAspects.length ? catalog.requiredAspects : requiredAspects[key];
  const auto = autoRequiredAspects[key];
  const out = [];
  const push = (v) => {
    const s = v == null ? '' : String(v).trim();
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };
  if (Array.isArray(base)) base.forEach(push);
  if (Array.isArray(auto)) auto.forEach(push);
  return out;
}

function isKnownEbayCategoryId(categoryId) {
  if (!categoryId) return false;
  const key = typeof categoryId === 'number' ? String(categoryId) : String(categoryId).trim();
  if (!key) return false;
  return Boolean(categories[key]);
}

function normalizeAspectKey(raw) {
  return normalize(raw)
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCatalogAspectName(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeAspectNames(values = []) {
  const out = [];
  const seen = new Set();
  values.forEach((raw) => {
    const name = normalizeCatalogAspectName(raw);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out;
}

function getCategoryAspectCatalog(categoryId) {
  if (!categoryId) {
    return {
      categoryId: null,
      hasCatalogEntry: false,
      hasAspectData: false,
      requiredAspects: [],
      recommendedAspects: [],
      optionalAspects: [],
      allAspects: [],
      aspects: [],
    };
  }
  const key = String(categoryId).trim();
  if (!key) {
    return {
      categoryId: null,
      hasCatalogEntry: false,
      hasAspectData: false,
      requiredAspects: [],
      recommendedAspects: [],
      optionalAspects: [],
      allAspects: [],
      aspects: [],
    };
  }
  const hasCatalogEntry = Object.prototype.hasOwnProperty.call(aspectCatalogByCategory || {}, key);
  const entry = aspectCatalogByCategory?.[key];
  const aspectRows = Array.isArray(entry?.aspects) ? entry.aspects : [];
  const requiredFromRows = dedupeAspectNames(
    aspectRows
      .filter((a) => Boolean(a?.required))
      .map((a) => a?.name)
  );
  const recommendedFromRows = dedupeAspectNames(
    aspectRows
      .filter((a) => String(a?.usage || '').toUpperCase() === 'RECOMMENDED')
      .map((a) => a?.name)
  );
  const optionalFromRows = dedupeAspectNames(
    aspectRows
      .filter((a) => String(a?.usage || '').toUpperCase() === 'OPTIONAL')
      .map((a) => a?.name)
  );
  const allFromRows = dedupeAspectNames(aspectRows.map((a) => a?.name));
  const fallbackRequired = dedupeAspectNames(
    Array.isArray(requiredAspects?.[key]) ? requiredAspects[key] : []
  );
  const fallbackAutoRequired = dedupeAspectNames(
    Array.isArray(autoRequiredAspects?.[key]) ? autoRequiredAspects[key] : []
  );
  const requiredAspectsOut = dedupeAspectNames(
    [
      ...(Array.isArray(entry?.required) ? entry.required : requiredFromRows),
      ...fallbackRequired,
      ...fallbackAutoRequired,
    ]
  );
  const recommendedAspectsOut = dedupeAspectNames(
    Array.isArray(entry?.recommended) ? entry.recommended : recommendedFromRows
  );
  const optionalAspectsOut = dedupeAspectNames(
    Array.isArray(entry?.optional) ? entry.optional : optionalFromRows
  );
  const allAspectsOut = dedupeAspectNames(
    [
      ...(Array.isArray(entry?.all) ? entry.all : allFromRows),
      ...requiredAspectsOut,
    ]
  );
  const aspectsOut = Array.isArray(entry?.aspects) ? entry.aspects : [];
  const hasAspectData =
    requiredAspectsOut.length > 0 ||
    recommendedAspectsOut.length > 0 ||
    optionalAspectsOut.length > 0 ||
    allAspectsOut.length > 0 ||
    aspectsOut.length > 0;

  return {
    categoryId: key,
    hasCatalogEntry,
    hasAspectData,
    requiredAspects: requiredAspectsOut,
    recommendedAspects: recommendedAspectsOut,
    optionalAspects: optionalAspectsOut,
    allAspects: allAspectsOut,
    aspects: aspectsOut,
  };
}

function toAttributeMap(attributes) {
  if (!attributes) return {};
  if (Array.isArray(attributes)) {
    const out = {};
    attributes.forEach((entry) => {
      const key = entry && typeof entry === 'object' ? String(entry.key || '').trim() : '';
      const value = entry && typeof entry === 'object' ? String(entry.value || '').trim() : '';
      if (!key || !value) return;
      out[key] = value;
    });
    return out;
  }
  if (typeof attributes === 'object') return attributes;
  return {};
}

function buildRequiredAspectMeta(categoryId, attributes = null) {
  const key = categoryId == null ? '' : String(categoryId).trim();
  if (!key) {
    return {
      categoryId: null,
      categoryKnown: false,
      hasAspectData: false,
      requiredAspects: [],
      missingAspects: [],
      providedRequiredAspects: [],
      coverageStatus: 'missing_category',
      category: null,
    };
  }
  const required = getRequiredAspects(key);
  const categoryKnown = isKnownEbayCategoryId(key);
  const catalogHasAspectData = Object.prototype.hasOwnProperty.call(aspectCatalogByCategory, key);
  const mapHasAspectData =
    Object.prototype.hasOwnProperty.call(requiredAspects, key) ||
    Object.prototype.hasOwnProperty.call(autoRequiredAspects, key) ||
    catalogHasAspectData;
  // Treat known categories with zero required aspects as valid "empty" metadata,
  // so downstream LLM prompts can still enforce category governance consistently.
  const hasAspectData = categoryKnown || mapHasAspectData;
  const attributeMap = toAttributeMap(attributes);
  const isNonEmptyValue = (v) => {
    if (v === null || v === undefined) return false;
    if (Array.isArray(v)) return v.some((x) => x != null && String(x).trim() !== '');
    const s = typeof v === 'string' ? v.trim() : String(v).trim();
    return Boolean(s);
  };
  const providedKeys = new Set(
    Object.entries(attributeMap || {})
      .filter(([k, v]) => normalizeAspectKey(k) && isNonEmptyValue(v))
      .map(([k]) => normalizeAspectKey(k))
      .filter(Boolean)
  );
  const missing = required.filter((aspect) => !providedKeys.has(normalizeAspectKey(aspect)));
  const providedRequired = required.filter((aspect) => providedKeys.has(normalizeAspectKey(aspect)));

  return {
    categoryId: key,
    categoryKnown,
    hasAspectData,
    requiredAspects: required,
    missingAspects: missing,
    providedRequiredAspects: providedRequired,
    coverageStatus: hasAspectData ? (required.length ? 'available' : 'available_empty') : 'not_available',
    category: categories[key] || null,
  };
}

function getRequiredAspectCatalogStats() {
  const categoryIds = Object.keys(categories || {});
  const withAspectData = categoryIds.filter(
    (id) =>
      Object.prototype.hasOwnProperty.call(requiredAspects, id) ||
      Object.prototype.hasOwnProperty.call(aspectCatalogByCategory, id)
  );
  const withAutoAspectData = categoryIds.filter((id) => Object.prototype.hasOwnProperty.call(autoRequiredAspects, id));
  const withCatalogAspectData = categoryIds.filter((id) => Object.prototype.hasOwnProperty.call(aspectCatalogByCategory, id));
  return {
    totalCategories: categoryIds.length,
    categoriesWithAspectData: withAspectData.length,
    categoriesWithoutAspectData: Math.max(0, categoryIds.length - withAspectData.length),
    categoriesWithAutoAspectData: withAutoAspectData.length,
    categoriesWithCatalogAspectData: withCatalogAspectData.length,
  };
}

module.exports = {
  findEbayCategory,
  getRequiredAspects,
  getCategoryAspectCatalog,
  isKnownEbayCategoryId,
  buildRequiredAspectMeta,
  getRequiredAspectCatalogStats,
};
