const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { isValidGtin: isValidGtinShared, normalizeDigits: normalizeDigitsShared } = require('./gtin');
const {
  computeProductIdentityKey,
  buildIdentityAliasSet,
  sanitizeIdentityValue,
} = require('./product-identity');
const { coerceTitleToPolicy } = require('./title-policy');

function isFirestoreSpecialValue(value) {
  if (!value) return false;
  if (value instanceof FieldValue) {
    return true;
  }
  const ctorName = value?.constructor?.name;
  return ctorName === 'FieldValue';
}

function sanitizeFirestoreValue(value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date || Buffer.isBuffer?.(value)) {
    return value;
  }

  if (isFirestoreSpecialValue(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => sanitizeFirestoreValue(item))
      .filter((item) => item !== undefined);
    return cleaned;
  }

  if (typeof value === 'object') {
    const cleaned = {};
    for (const [key, nested] of Object.entries(value)) {
      const sanitized = sanitizeFirestoreValue(nested);
      if (sanitized !== undefined) {
        cleaned[key] = sanitized;
      }
    }
    return cleaned;
  }

  return undefined;
}

// Initialize Firestore
const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'
});

// Collection name
const PRODUCTS_COLLECTION = 'products';
const ORDERS_COLLECTION = 'orders';
const SKU_INDEX_COLLECTION = 'baselinker_sku_index';
const INVENTORIES_COLLECTION = 'inventories';
const INVENTORY_SYNC_LOGS_COLLECTION = 'inventorySyncLogs';
const PRODUCT_LIST_LIMIT = parseInt(process.env.PRODUCT_LIST_LIMIT || '0', 10);
const MAX_ALIAS_LOOKUP = parseInt(process.env.MAX_ALIAS_LOOKUP || '50', 10);

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');

const normalizeEanValue = (val) =>
  (val || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();

const buildSkuIndexKey = (type, value) => (value ? `${type}:${value}` : null);

const inventoryCollection = () => firestore.collection(INVENTORIES_COLLECTION);

const parseInventoryNameMeta = (name = '') => {
  const match = name.trim().match(/^([A-Z]{2,6})-(\d{2})-(\d{2,})/i);
  if (!match) {
    return { vendorCode: null, fiscalYear: null, sequence: null };
  }
  const [, vendor, year, seq] = match;
  const fiscalYear = Number(`20${year}`);
  const sequence = Number(seq);
  return {
    vendorCode: vendor.toUpperCase(),
    fiscalYear: Number.isFinite(fiscalYear) ? fiscalYear : null,
    sequence: Number.isFinite(sequence) ? sequence : null,
  };
};

const collectSkuIndexKeys = (product = {}) => {
  const keys = new Set();
  const addSku = (value) => {
    const normalized = normalizeSkuValue(value);
    if (normalized) {
      keys.add(buildSkuIndexKey('sku', normalized));
    }
  };
  const addEan = (value) => {
    const normalized = normalizeEanValue(value);
    // Only index valid GTIN/EAN/UPC values. Invalid codes cause incorrect dedupe matches.
    const digits = normalizeDigitsShared(normalized);
    const validLength = digits && [8, 12, 13, 14].includes(digits.length);
    if (validLength && isValidGtinShared(digits)) {
      keys.add(buildSkuIndexKey('ean', normalized));
    }
  };

  addSku(product?.identification?.sku);
  addSku(product?.details?.identifiers?.sku);

  addEan(product?.details?.identifiers?.ean);
  addEan(product?.details?.identifiers?.gtin);
  addEan(product?.details?.identifiers?.upc);

  if (Array.isArray(product?.identification?.barcodes)) {
    product.identification.barcodes.forEach(addEan);
  }
  if (Array.isArray(product?.ops?.identity_aliases)) {
    product.ops.identity_aliases.forEach(addEan);
  }

  return Array.from(keys).filter(Boolean);
};

/**
 * Save a product to Firestore
 */
// Cache required eBay aspects
let REQUIRED_ASPECTS = null;
function getRequiredAspects() {
  if (REQUIRED_ASPECTS) return REQUIRED_ASPECTS;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    REQUIRED_ASPECTS = require('../ebay-data/required-aspects.json');
  } catch (e) {
    console.warn('Failed to load required-aspects.json:', e.message);
    REQUIRED_ASPECTS = {};
  }
  return REQUIRED_ASPECTS;
}

// Cache eBay category tree (id -> {id, name, breadcrumb})
let EBAY_CATEGORIES = null;
function getEbayCategories() {
  if (EBAY_CATEGORIES) return EBAY_CATEGORIES;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    EBAY_CATEGORIES = require('../ebay-data/categories.json');
  } catch (e) {
    console.warn('Failed to load categories.json:', e.message);
    EBAY_CATEGORIES = {};
  }
  return EBAY_CATEGORIES;
}

const WEIGHT_BUCKETS = [1, 3, 6, 9, 12, 15];
function bucketWeight(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  let best = WEIGHT_BUCKETS[0];
  let bestDiff = Math.abs(num - best);
  for (const b of WEIGHT_BUCKETS) {
    const d = Math.abs(num - b);
    if (d < bestDiff) {
      best = b;
      bestDiff = d;
    }
  }
  return Number(best.toFixed(2));
}

function parseWeightKg(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Heuristic: values > 50 are almost certainly grams, not kg (we only bucket up to 15kg).
    return value > 50 ? value / 1000 : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/([\d.,]+)\s*(kg|g|gramm|grams?|kilogramm|kilograms?)?/i);
  if (!match) return null;
  const num = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) return null;
  const unit = (match[2] || '').toLowerCase();
  if (unit) {
    if (unit === 'g' || unit.startsWith('gram')) {
      return num / 1000;
    }
    if (unit === 'kg' || unit.startsWith('kilo')) {
      return num;
    }
  }
  // No unit: apply the same heuristic as numeric inputs.
  return num > 50 ? num / 1000 : num;
}

function normalizeAttributesOrder(attrs = {}) {
  const entries = Object.entries(attrs || {});
  if (!entries.length) return {};
  entries.sort((a, b) => {
    const aKey = a[0] ? String(a[0]).toLowerCase() : '';
    const bKey = b[0] ? String(b[0]).toLowerCase() : '';
    return aKey.localeCompare(bKey, 'de', { sensitivity: 'base' });
  });
  return entries.reduce((acc, [k, v]) => {
    acc[k] = v;
    return acc;
  }, {});
}

function enforceEbayAspects(product) {
  const requiredMap = getRequiredAspects();
  const details = product.details || {};
  const attrs = details.attributes || {};
  const existingExtra =
    details.attributes_extra && typeof details.attributes_extra === 'object'
      ? details.attributes_extra
      : {};

  const normalizeKey = (v) => (v == null ? '' : String(v)).trim();
  const normalizeLower = (v) => normalizeKey(v).toLowerCase();
  const normalizeAspectKey = (key) =>
    normalizeKey(key)
      // Normalize noisy "Item Specifics" prefixes from exports/LLM output
      // Examples:
      // - "eBay Item Specifics: Besonderheiten" -> "Besonderheiten"
      // - "eBay-Item-Specifics: Besonderheiten" -> "Besonderheiten"
      // - "eBay_Item_Specifics_Marke" -> "Marke"
      .replace(/^eBay[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
      // - "Pflicht-Item-Specifics: Besonderheiten" -> "Besonderheiten"
      .replace(/^Pflicht[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
      // Normalize other noisy eBay-* attribute prefixes from exports
      // Examples: "eBay_Marke" / "eBay-Produktart" -> "Marke" / "Produktart"
      .replace(/^eBay[\s-_]+/i, '')
      // Normalize noisy Kaufland-* attribute prefixes from exports
      // Examples: "Kaufland_Marke" / "Kaufland-Produktart" -> "Marke" / "Produktart"
      .replace(/^Kaufland[\s-_]*Item[\s-_]*Specifics[\s:_-]*\s*/i, '')
      .replace(/^Kaufland[\s-_]+/i, '')
      .trim();

  // Canonical key aliases (cross-category + multilingual).
  // Goal: keep a stable internal attribute vocabulary that matches common eBay DE aspect names.
  const KEY_ALIASES = new Map(
    Object.entries({
      // Product type
      'produkttyp': 'Produktart',
      'produkt typ': 'Produktart',
      'produktart': 'Produktart',
      'product type': 'Produktart',
      'item type': 'Produktart',

      // Brand / manufacturer
      'brand': 'Marke',
      'marke': 'Marke',
      'manufacturer': 'Hersteller',
      'hersteller': 'Hersteller',

      // Condition
      'condition': 'Zustand',
      'zustand': 'Zustand',

      // Common spec keys
      'color': 'Farbe',
      'colour': 'Farbe',
      'farbe': 'Farbe',
      'material': 'Material',
      'modell': 'Modell',
      'model': 'Modell',

      // Identifiers
      'mpn': 'Herstellernummer',
      'manufacturer part number': 'Herstellernummer',
      'herstellernummer': 'Herstellernummer',
      'oem reference number': 'Referenznummer(n) OEM',
      'oem reference number(s)': 'Referenznummer(n) OEM',
      'referenznummer(n) oem': 'Referenznummer(n) OEM',

      // Weight (kg) aliases
      // We store a normalized numeric weight under the internal key `weight` (kg).
      // Category-specific required aspect names (e.g. "Gewicht(kg)", "Eigengewicht (kg)") are derived below.
      'gewicht': 'weight',
      'gewicht(kg)': 'weight',
      'gewicht (kg)': 'weight',
      'eigengewicht': 'weight',
      'eigengewicht(kg)': 'weight',
      'eigengewicht (kg)': 'weight',
      'artikelgewicht': 'weight',
      'versandgewicht': 'weight',
      'shipping weight': 'weight',
      'weight': 'weight',

      // Category path variants
      'kategorie-pfad': 'Kategorie',
      'kategorie pfad': 'Kategorie',
      'kategoriepfad': 'Kategorie',
      'category path': 'Kategorie',
      'category_path': 'Kategorie',
    }).map(([k, v]) => [k.toLowerCase(), v])
  );

  const normalizeBooleanishValue = (val) => {
    if (val === true) return 'Ja';
    if (val === false) return 'Nein';
    if (typeof val !== 'string') return val;
    const trimmed = val.trim();
    const lower = trimmed.toLowerCase();
    if (lower === 'true') return 'Ja';
    if (lower === 'false') return 'Nein';
    return val;
  };

  const META_ATTRIBUTE_KEYS = new Set(
    [
      'ebay_category_id',
      'ebaycategoryid',
      'ebay_category_path',
      'ebaycategorypath',
      'ebay_category_breadcrumb',
      'ebaycategorybreadcrumb',
      // Some exports store a whole list of item specifics under this meta key (redundant, noisy)
      'ebay_item_specifics',
      'ebayitemspecifics',
      'ebay kategorie',
      'ebay-kategorie',
      'ebay_kategorie',
      'ebay kategorie id',
      'ebay kategorie pfad',
      'kaufland_category_id',
      'kauflandcategoryid',
      'kaufland_category_path',
      'kauflandcategorypath',
      'kaufland kategorie',
      'kaufland-kategorie',
      'kaufland_kategorie',
      'kaufland kategorie pfad',
      'category_path',
      // Text-field payloads / LLM exports sometimes embed BaseLinker text fields in attributes
      'text_name',
      'text_description',
      'text_features',
      'text_features|de|ebay_9800',
      'features|de|ebay_9800',
      'features|de|ebay',
      // Category path variants (canonical key is "Kategorie")
      'kategorie-pfad',
      'kategorie pfad',
      'kategoriepfad',
      // Generic IDs that should NEVER be displayed as user-facing attributes
      // NOTE: SKU is derived from identification/details.identifiers and must not be taken from arbitrary imports/LLM output.
      'sku',
      'category_id',
      'categoryid',
      'produkt-id',
      'produkt id',
      'produkt_id',
      'produktid',
      'product-id',
      'product id',
      'product_id',
      'productid',
      'artikel-id',
      'artikel id',
      'artikel_id',
    ].map((k) => k.toLowerCase())
  );

  const PLACEHOLDER_VALUES = [
    'not provided, eu',
    'info@example.com',
    'info@example.example.com',
    'info@example.de',
    'example.com',
    'n/a',
    'na',
    'unknown',
    'unbekannt',
  ];

  const isPlaceholder = (value) => {
    if (value === null || value === undefined) return false;
    const v = normalizeLower(value);
    if (!v) return false;
    return PLACEHOLDER_VALUES.some((p) => v === p || v.includes(p));
  };

  const isMetaKey = (lowerKey) => {
    if (!lowerKey) return false;
    if (META_ATTRIBUTE_KEYS.has(lowerKey)) return true;
    // Any marketplace-specific keys must never be stored as user-facing attributes.
    if (lowerKey.includes('ebay')) return true;
    if (lowerKey.includes('kaufland')) return true;
    // Generic patterns we never want in end-user attribute tables
    if (lowerKey.startsWith('text_')) return true;
    if (lowerKey.includes('|de|')) return true;
    if (lowerKey.startsWith('features|')) return true;
    return false;
  };

  const isGpsrKey = (key) => normalizeLower(key).startsWith('gpsr ');

  // Single category system (canonical): details.categoryId
  // Backwards compatible reads from legacy fields.
  let catId =
    (details.categoryId && String(details.categoryId).trim()) ||
    (details.ebayCategoryId && String(details.ebayCategoryId).trim()) ||
    (attrs.ebay_category_id && String(attrs.ebay_category_id).trim()) ||
    null;

  // Drop non-eBay category fields
  delete details.kauflandCategoryId;
  delete details.kauflandCategoryPath;
  if (attrs.kaufland_category_id) delete attrs.kaufland_category_id;
  if (attrs.kaufland_category_path) delete attrs.kaufland_category_path;

  // Drop legacy eBay-category fields; keep only generic `categoryId` and `identification.category`.
  if (details.ebayCategoryId) delete details.ebayCategoryId;
  if (details.ebayCategoryBreadcrumb) delete details.ebayCategoryBreadcrumb;
  if (details.ebayCategoryPath) delete details.ebayCategoryPath;

  if (catId) {
    details.categoryId = String(catId).trim();
    const categories = getEbayCategories();
    const breadcrumb = categories?.[String(catId)]?.breadcrumb;
    if (breadcrumb) {
      if (!product.identification) product.identification = {};
      product.identification.category = String(breadcrumb);
    } else {
      // Prevent invalid/unknown category IDs (LLM hallucinations or bad imports).
      // We do NOT guess a replacement here.
      const invalidCategoryId = String(catId).trim();
      catId = null;
      delete details.categoryId;
      if (!product.ops) product.ops = {};
      product.ops.data_quality = {
        ...(product.ops.data_quality || {}),
        category_invalid_id_v1: {
          at_iso: new Date().toISOString(),
          value: invalidCategoryId || null,
        },
      };
    }
  }

  if (!catId) {
    // No category -> normalize keys a bit and sort alphabetically.
    const nextAttrs = {};
    const nextExtra = { ...(existingExtra || {}) };
    Object.entries(attrs || {}).forEach(([key, val]) => {
      const originalKey = normalizeKey(key);
      if (!originalKey) return;
      const normalizedKey = normalizeAspectKey(originalKey);
    const preKey = normalizedKey || originalKey;
    const lowerPre = normalizeLower(preKey);
    const aliased = KEY_ALIASES.get(lowerPre) || preKey;
    const finalKey = aliased;
    const lowerKey = normalizeLower(finalKey);
      if (isMetaKey(lowerKey)) {
        nextExtra[originalKey] = val;
        return;
      }
      if (isPlaceholder(val)) {
        // Never show placeholder values in the attribute table; preserve them for forensics.
        nextExtra[originalKey] = val;
        return;
      }
      // Move non-primitive values out of attributes to keep UI stable
      if (val && typeof val === 'object') {
        nextExtra[originalKey] = val;
        return;
      }
      nextAttrs[finalKey] = normalizeBooleanishValue(val);
    });
    return {
      ...product,
      details: {
        ...details,
        attributes: normalizeAttributesOrder(nextAttrs),
        attributes_extra: Object.keys(nextExtra).length ? nextExtra : undefined,
      },
    };
  }

  const requiredAspects = Array.isArray(requiredMap[catId]) ? requiredMap[catId] : [];
  const categoryPath = product?.identification?.category || null;
  const canonicalByLower = new Map(
    requiredAspects
      .map((n) => normalizeKey(n))
      .filter(Boolean)
      .map((n) => [normalizeLower(n), n])
  );

  const keptAspects = {};
  const keptCompliance = {};
  const nextExtra = { ...(existingExtra || {}) };

  Object.entries(attrs || {}).forEach(([key, val]) => {
    const originalKey = normalizeKey(key);
    if (!originalKey) return;
    const normalizedKey = normalizeAspectKey(originalKey);
    const preKey = normalizedKey || originalKey;
    const lowerPre = normalizeLower(preKey);
    const aliased = KEY_ALIASES.get(lowerPre) || preKey;
    const finalKey = aliased;
    const lower = normalizeLower(finalKey);

    // Normalize category path keys to one canonical attribute ("Kategorie").
    // If the input contains a conflicting value, preserve it in attributes_extra.
    if (lower === 'kategorie') {
      const incoming = normalizeKey(val);
      const canonical = categoryPath ? String(categoryPath) : '';
      if (incoming && canonical && incoming !== canonical) {
        // Never keep marketplace-specific keys anywhere (including attributes_extra).
        const originalLower = normalizeLower(originalKey);
        if (!(originalLower.includes('ebay') || originalLower.includes('kaufland'))) {
          nextExtra[originalKey] = val;
        }
      }
      return;
    }

    if (isMetaKey(lower)) {
      // Never keep marketplace-specific keys anywhere (including attributes_extra).
      const originalLower = normalizeLower(originalKey);
      if (originalLower.includes('ebay') || originalLower.includes('kaufland') || lowerPre.includes('ebay') || lowerPre.includes('kaufland')) {
        return;
      }
      nextExtra[originalKey] = val;
      return;
    }

    // Keep GPSR/compliance keys regardless of category allowlist
    if (isGpsrKey(finalKey)) {
      if (val && typeof val === 'object') {
        nextExtra[originalKey] = val;
        return;
      }
      if (isPlaceholder(val)) {
        nextExtra[originalKey] = val;
        return;
      }
      keptCompliance[finalKey] = normalizeBooleanishValue(val);
      return;
    }

    if (val && typeof val === 'object') {
      nextExtra[originalKey] = val;
      return;
    }
    if (isPlaceholder(val)) {
      nextExtra[originalKey] = val;
      return;
    }

    // Canonicalize required aspect names for consistent formatting
    const canonicalName = canonicalByLower.get(lower) || finalKey;
    if (Object.prototype.hasOwnProperty.call(keptAspects, canonicalName)) {
      // Preserve duplicates rather than overwriting
      const prev = keptAspects[canonicalName];
      const prevStr = typeof prev === 'string' ? prev.trim() : prev;
      const nextStr = typeof val === 'string' ? val.trim() : val;
      const prevEmpty = prev === null || prev === undefined || prevStr === '';
      const nextEmpty = val === null || val === undefined || nextStr === '';
      if (prevEmpty && !nextEmpty) {
        keptAspects[canonicalName] = normalizeBooleanishValue(val);
      } else {
        nextExtra[originalKey] = val;
      }
      return;
    }
    keptAspects[canonicalName] = normalizeBooleanishValue(val);
  });

  // Ensure all required aspects exist (missing ones are set to null, not guessed)
  const existingLowerKeys = new Set(Object.keys(keptAspects).map((k) => normalizeLower(k)));
  requiredAspects.forEach((reqName) => {
    const canonical = normalizeKey(reqName);
    if (!canonical) return;
    const lower = normalizeLower(canonical);
    if (existingLowerKeys.has(lower)) return;

    // Best-effort fill from known fields (no guessing beyond existing data)
    let derived = null;
    if (lower === 'marke') {
      derived = product?.identification?.brand || details?.brand || null;
    } else if (lower === 'ean') {
      derived =
        details?.identifiers?.ean ||
        details?.identifiers?.gtin ||
        details?.identifiers?.upc ||
        null;
    } else if (lower === 'sku') {
      derived =
        product?.identification?.sku ||
        details?.identifiers?.sku ||
        null;
    } else if (lower === 'herstellernummer' || lower === 'mpn') {
      derived = details?.identifiers?.mpn || null;
    } else if (lower.includes('gewicht')) {
      // Weight aspects can be required in some eBay categories (e.g. "Gewicht(kg)", "Eigengewicht (kg)", sometimes "Gewicht").
      // We do NOT ask the model here. Instead we reuse the already-bucketed internal weight in kg.
      const w = details?.attributes?.weight;
      derived = Number.isFinite(Number(w)) && Number(w) > 0 ? Number(w) : null;
    }

    keptAspects[canonical] = derived ?? null;
    existingLowerKeys.add(lower);
  });

  // Add canonical Kategorie attribute for consistent UI + exports
  if (categoryPath) {
    keptAspects.Kategorie = String(categoryPath);
  }

  const sortedAttrs = normalizeAttributesOrder({ ...keptAspects, ...keptCompliance });

  return {
    ...product,
    details: {
      ...details,
      categoryId: String(catId),
      attributes: sortedAttrs,
      attributes_extra: Object.keys(nextExtra).length ? nextExtra : undefined,
    },
  };
}

function sanitizeKeyFeatures(list, { max = 8 } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];

  const norm = (val) =>
    String(val || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

  for (const entry of list) {
    const raw = typeof entry === 'string' ? entry : entry == null ? '' : String(entry);
    const cleaned = raw.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const n = norm(cleaned);
    if (!n) continue;
    if (n === 'unknown' || n === 'unbekannt' || n === 'n/a') continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

function ensureTechnicalTitle(product, { minLen = 70, maxLen = 80 } = {}) {
  const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const normalizeMatch = (v) =>
    safeString(v)
      .toLowerCase()
      .replace(/[\s\-_/.,:;()\\[\]{}'"`´’“”!?+*=<>|]/g, '');

  const existingTitle = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const attrs = (product?.details?.attributes && typeof product.details.attributes === 'object') ? product.details.attributes : {};

  const productType = safeString(attrs['Produktart'] || attrs['Produkttyp'] || attrs['Produkttyp (Produktart)'] || '');

  const pickAttr = (...keys) => {
    for (const key of keys) {
      const val = attrs?.[key];
      const str = safeString(val);
      if (str && !/^unknown|unbekannt$/i.test(str)) return str;
    }
    return '';
  };

  const candidates = [];
  const pushCandidate = (val) => {
    const s = safeString(val);
    if (!s) return;
    if (/^unknown|unbekannt$/i.test(s)) return;
    const key = normalizeMatch(s);
    if (!key) return;
    if (candidates.some((c) => normalizeMatch(c) === key)) return;
    candidates.push(s);
  };

  // Priority: part/model numbers first, then key specs.
  pushCandidate(pickAttr('Herstellernummer'));
  pushCandidate(safeString(product?.details?.identifiers?.mpn));
  pushCandidate(pickAttr('Referenznummer(n) OEM', 'Referenznummer', 'OEM-Referenznummer'));
  pushCandidate(pickAttr('Modell', 'Model', 'Model Number'));

  // Common technical specs (best-effort, category-agnostic).
  pushCandidate(pickAttr('Spannung', 'Volt', 'Voltage'));
  pushCandidate(pickAttr('Leistung', 'Power'));
  pushCandidate(pickAttr('Fassungsvermögen gesamt', 'Fassungsvermögen', 'Volumen', 'Kapazität'));
  pushCandidate(pickAttr('Größe', 'Size', 'Maße'));
  pushCandidate(pickAttr('Farbe', 'Color'));
  pushCandidate(pickAttr('Material', 'Obermaterial', 'Gewebeart', 'Futtermaterial'));
  // Extra fillers to reach SEO target length (only if present)
  pushCandidate(pickAttr('Einbauposition', 'Position'));
  pushCandidate(pickAttr('Bremsscheibenart'));
  pushCandidate(pickAttr('Bildschirmgröße'));
  pushCandidate(pickAttr('Betriebssystem'));
  pushCandidate(pickAttr('Wiedergabeformate'));
  pushCandidate(pickAttr('Format', 'Einband'));
  pushCandidate(pickAttr('Sprache'));
  pushCandidate(pickAttr('Erscheinungsjahr', 'Herstellungsjahr', 'Baujahr'));
  pushCandidate(pickAttr('Produktlinie', 'Serie', 'Thema'));

  const isPlaceholder = (title) => {
    const t = safeString(title);
    if (!t) return true;
    if (/unknown|unbekannt/i.test(t)) return true;
    if (/\bsku[\s\-_]?\d+\b/i.test(t)) return true;
    if (/^sku[\s\-_]?\d+/i.test(t)) return true;
    if (t.length < 10) return true;
    return false;
  };

  const containsToken = (title, token) => {
    const t = normalizeMatch(title);
    const k = normalizeMatch(token);
    if (!t || !k) return false;
    return t.includes(k);
  };

  const compact = (title) => safeString(title).replace(/\s+/g, ' ').trim();

  const rebuildTechnical = () => {
    const parts = [];
    if (brand) parts.push(brand);
    if (productType) parts.push(productType);
    for (const token of candidates) {
      const next = compact([...parts, token].join(' '));
      if (!next) continue;
      if (next.length > maxLen) continue;
      parts.push(token);
    }
    let built = compact(parts.join(' '));
    if (built.length > maxLen) built = built.slice(0, maxLen).trim();
    return built;
  };

  let title = existingTitle;

  if (isPlaceholder(title)) {
    title = rebuildTechnical();
  } else {
    // Ensure brand + product type are present if known.
    if (brand && !containsToken(title, brand)) {
      title = compact(`${brand} ${title}`);
    }
    if (productType && !containsToken(title, productType)) {
      const tentative = compact(`${title} ${productType}`);
      title = tentative.length <= maxLen ? tentative : title;
    }
    // Append technical candidates if we have space.
    for (const token of candidates) {
      if (!token) continue;
      if (containsToken(title, token)) continue;
      const tentative = compact(`${title} ${token}`);
      if (tentative.length <= maxLen) {
        title = tentative;
      }
    }
    // If we still overflow, prefer a deterministic technical rebuild.
    if (title.length > maxLen) {
      const rebuilt = rebuildTechnical();
      if (rebuilt) {
        title = rebuilt;
      } else {
        title = compact(title).slice(0, maxLen).trim();
      }
    }
  }

  // Best-effort: try to hit the SEO range 70–80 chars by appending technical candidates.
  // Never invent tokens; only use known attributes/candidates.
  if (title.length < minLen) {
    for (const token of candidates) {
      if (!token) continue;
      if (containsToken(title, token)) continue;
      const tentative = compact(`${title} ${token}`);
      if (tentative.length <= maxLen) {
        title = tentative;
      }
      if (title.length >= minLen) break;
    }
  }

  return compact(title);
}

async function saveProduct(product, options = {}) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(product.id);
    const existingSnap = await docRef.get();
    const existingData = existingSnap.exists ? existingSnap.data() || {} : null;
    const hasExisting = Boolean(existingData);
    const allowWarehouseFields = options && options.allowWarehouseFields === true;
    const saveSource = (options && options.source) || null; // e.g. 'ui', 'job', 'script'

    const pickStableSku = (data) => {
      const idSku = typeof data?.identification?.sku === 'string' ? data.identification.sku.trim() : '';
      const detSku = typeof data?.details?.identifiers?.sku === 'string' ? data.details.identifiers.sku.trim() : '';
      return idSku || detSku || '';
    };

    const stableSku = pickStableSku(existingData);
    if (stableSku) {
      // Enforce SKU immutability: never overwrite existing SKU
      if (!product.identification) product.identification = {};
      if (!product.details) product.details = {};
      if (!product.details.identifiers) product.details.identifiers = {};

      const incomingSku =
        (typeof product.identification.sku === 'string' && product.identification.sku.trim()) ||
        (typeof product.details.identifiers.sku === 'string' && product.details.identifiers.sku.trim()) ||
        '';

      if (incomingSku && incomingSku !== stableSku) {
        console.warn(
          `[saveProduct] SKU change blocked for ${product.id}: incoming="${incomingSku}" kept="${stableSku}"`
        );
      }
      product.identification.sku = stableSku;
      product.details.identifiers.sku = stableSku;
    }
    
    // Merge existing product data to avoid overwriting enriched content (images/descriptions/attrs)
    const existingDetails = existingData?.details || {};
    const incomingDetails = product?.details || {};
    const allowCategoryChange = options && options.allowCategoryChange === true;
    const isManualSave = (options && options.mode === 'manual') || saveSource === 'ui';
    // Manual UI saves should be allowed to overwrite text + remove attributes.
    const overwriteTextFields = Boolean(options && options.overwriteTextFields === true) || isManualSave;
    const replaceAttributes = Boolean(options && options.replaceAttributes === true) || isManualSave;
    const syncIdentifiersFromBarcodes =
      Boolean(options && options.syncIdentifiersFromBarcodes === true) || isManualSave;

    const pickStableCategoryId = (data) => {
      const details = data?.details || {};
      const attrs = details?.attributes || {};
      const candidate =
        (details.categoryId && String(details.categoryId).trim()) ||
        (details.ebayCategoryId && String(details.ebayCategoryId).trim()) ||
        (attrs.ebay_category_id && String(attrs.ebay_category_id).trim()) ||
        null;
      return candidate ? String(candidate).trim() : null;
    };

    const mergeString = (incomingVal, existingVal, { incomingPresent = false } = {}) => {
      const normalizedIncoming = typeof incomingVal === 'string' ? incomingVal.trim() : '';
      const normalizedExisting = typeof existingVal === 'string' ? existingVal.trim() : '';
      // Automation: preserve existing text once filled (avoid accidental overwrites).
      // Manual: if the UI explicitly sent the field, allow overwriting (including shortening).
      if (overwriteTextFields && incomingPresent) {
        return normalizedIncoming;
      }
      return normalizedExisting || normalizedIncoming || '';
    };

    // Deleted images tracking
    const existingDeleted = Array.isArray(existingData?.ops?.deleted_images) ? existingData.ops.deleted_images : [];
    const incomingDeleted = Array.isArray(product?.ops?.deleted_images) ? product.ops.deleted_images : [];
    const deletedImages = Array.from(new Set([...existingDeleted, ...incomingDeleted])).filter(Boolean);
    const isDeleted = (url) => deletedImages.some((d) => d && url && d === url);

    // Images:
    // - If the incoming payload explicitly contains `details.images`, treat it as authoritative.
    // - Otherwise preserve existing images (but still filter out newly-deleted ones).
    const incomingHasImages =
      product?.details && Object.prototype.hasOwnProperty.call(product.details, 'images');
    const sourceImages = incomingHasImages
      ? Array.isArray(incomingDetails.images)
        ? incomingDetails.images
        : []
      : Array.isArray(existingDetails.images)
        ? existingDetails.images
        : [];

    const mergedImages = [];
    const seenImages = new Set();
    sourceImages.forEach((img) => {
      const key = img?.url_or_base64 || img?.url || img?.href;
      if (!key) return;
      if (isDeleted(key)) return;
      if (seenImages.has(key)) return;
      seenImages.add(key);
      mergedImages.push(img);
    });

    const incomingHasAttributes =
      product?.details && Object.prototype.hasOwnProperty.call(product.details, 'attributes');
    const normalizedIncomingAttributes =
      incomingDetails.attributes && typeof incomingDetails.attributes === 'object' && !Array.isArray(incomingDetails.attributes)
        ? incomingDetails.attributes
        : {};
    // Attributes:
    // - Automation: merge (existing survives if incoming omits keys).
    // - Manual: treat incoming as authoritative to support deletions/overwrites.
    const mergedAttributes = replaceAttributes && incomingHasAttributes
      ? { ...normalizedIncomingAttributes }
      : {
          ...(existingDetails.attributes || {}),
          ...normalizedIncomingAttributes,
        };

    // Condition lock:
    // - Default listing condition is NEU.
    // - "Gebraucht" should only be possible when explicitly set by a human in the UI.
    // We track that with ops.condition_locked.
    const pickZustand = (attrsObj) => {
      if (!attrsObj || typeof attrsObj !== 'object') return '';
      const key = Object.keys(attrsObj).find((k) => String(k || '').trim().toLowerCase() === 'zustand');
      if (!key) return '';
      const val = attrsObj[key];
      return typeof val === 'string' ? val.trim() : val == null ? '' : String(val).trim();
    };
    const normalizeZustand = (val) => String(val || '').trim().toLowerCase();
    const existingZustand = pickZustand(existingDetails.attributes || {});
    const incomingZustand = pickZustand(mergedAttributes || {});
    const shouldLockCondition =
      isManualSave &&
      Boolean(incomingZustand) &&
      normalizeZustand(incomingZustand) !== normalizeZustand(existingZustand);

    // Merge pricing with guard (do not drop existing valid price)
    const existingPrice = existingDetails?.pricing?.lowest_price;
    const incomingPrice = incomingDetails?.pricing?.lowest_price;
    const incomingValid =
      incomingPrice &&
      typeof incomingPrice.amount === 'number' &&
      Number(incomingPrice.amount) > 0;
    const mergedPricing = {
      ...(existingDetails.pricing || {}),
      ...(incomingDetails.pricing || {}),
    };
    if (existingPrice && !incomingValid) {
      mergedPricing.lowest_price = existingPrice;
    } else if (incomingValid) {
      mergedPricing.lowest_price = {
        ...incomingPrice,
        currency: incomingPrice.currency || existingPrice?.currency || 'EUR',
      };
    }

    // Build merged details
    const incomingHasShortDescription =
      product?.details && Object.prototype.hasOwnProperty.call(product.details, 'short_description');
    const incomingHasDescription =
      product?.details && Object.prototype.hasOwnProperty.call(product.details, 'description');
    const mergedDetails = {
      ...existingDetails,
      ...incomingDetails,
      short_description: mergeString(incomingDetails.short_description, existingDetails.short_description, { incomingPresent: incomingHasShortDescription }),
      description: mergeString(incomingDetails.description, existingDetails.description, { incomingPresent: incomingHasDescription }),
      attributes: mergedAttributes,
      images: mergedImages,
      pricing: Object.keys(mergedPricing).length ? mergedPricing : undefined,
    };

    // Merge identification
    const mergedIdentification = {
      ...(existingData?.identification || {}),
      ...(product?.identification || {}),
    };

    const mergedOps = {
      ...(existingData?.ops || {}),
      ...(product?.ops || {}),
    };
    // Preserve existing lock; set it only when the UI explicitly changes Zustand.
    if (shouldLockCondition) {
      mergedOps.condition_locked = true;
    } else if (typeof mergedOps.condition_locked !== 'boolean') {
      mergedOps.condition_locked = Boolean(existingData?.ops?.condition_locked);
    }

    // Optional: keep identifiers in sync with barcodes (UI edits barcodes; BaseLinker sync reads identifiers.ean first).
    // Barcode + Identifier invariants:
    // - Only keep valid GTIN/EAN/UPC codes (correct checkdigit).
    // - Never persist invalid codes in identification.barcodes (they poison dedupe and exports).
    // - Prefer identifiers (details.identifiers.ean/gtin/upc) derived from barcodes when enabled.
    {
      const normalizeBarcode = (value) => normalizeDigitsShared((value || '').toString());
      const summarize = (values = []) => {
        const normalized = Array.from(new Set(values.map(normalizeBarcode).filter(Boolean)));
        const valid = normalized.filter((v) => [8, 12, 13, 14].includes(v.length) && isValidGtinShared(v));
        const invalid = normalized.filter((v) => !valid.includes(v));
        const gtin14 = valid.find((v) => v.length === 14) || null;
        let ean13 = valid.find((v) => v.length === 13) || null;
        const upc12 = valid.find((v) => v.length === 12) || null;
        const ean8 = valid.find((v) => v.length === 8) || null;
        // If we only have GTIN14 starting with 0, derive EAN13 (safe equivalence)
        if (!ean13 && gtin14 && gtin14.startsWith('0')) {
          const derived = gtin14.slice(1);
          if (derived.length === 13 && isValidGtinShared(derived)) {
            ean13 = derived;
          }
        }
        return { normalized, valid, invalid, ean13, gtin14, upc12, ean8 };
      };

      // Always validate identifiers + barcodes to prevent storing garbage, even when not syncing.
      const rawBarcodes = Array.isArray(mergedIdentification?.barcodes) ? mergedIdentification.barcodes : [];
      const rawIds = mergedDetails?.identifiers || {};
      const candidates = [
        ...rawBarcodes,
        rawIds.ean,
        rawIds.gtin,
        rawIds.upc,
      ].filter(Boolean);
      const summary = summarize(candidates);

      if (summary.valid.length) {
        mergedIdentification.barcodes = summary.valid;
      } else if (Array.isArray(mergedIdentification?.barcodes) && mergedIdentification.barcodes.length) {
        delete mergedIdentification.barcodes;
      }

      if (!mergedDetails.identifiers) mergedDetails.identifiers = {};

      // If enabled, keep identifiers aligned with valid barcodes.
      if (syncIdentifiersFromBarcodes) {
        if (summary.ean13) mergedDetails.identifiers.ean = summary.ean13; else delete mergedDetails.identifiers.ean;
        if (summary.gtin14) mergedDetails.identifiers.gtin = summary.gtin14; else delete mergedDetails.identifiers.gtin;
        if (summary.upc12) mergedDetails.identifiers.upc = summary.upc12; else delete mergedDetails.identifiers.upc;
      } else {
        // Even if we don't sync, delete invalid identifiers (never persist invalid codes).
        const curEan = normalizeBarcode(mergedDetails.identifiers.ean);
        if (curEan && !([8, 12, 13, 14].includes(curEan.length) && isValidGtinShared(curEan))) {
          delete mergedDetails.identifiers.ean;
        }
        const curGtin = normalizeBarcode(mergedDetails.identifiers.gtin);
        if (curGtin && !([8, 12, 13, 14].includes(curGtin.length) && isValidGtinShared(curGtin))) {
          delete mergedDetails.identifiers.gtin;
        }
        const curUpc = normalizeBarcode(mergedDetails.identifiers.upc);
        if (curUpc && !([8, 12, 13, 14].includes(curUpc.length) && isValidGtinShared(curUpc))) {
          delete mergedDetails.identifiers.upc;
        }
      }

      if (summary.invalid.length) {
        mergedOps.data_quality = mergedOps.data_quality || {};
        mergedOps.data_quality.barcode_rejected_v1 = {
          iso: new Date().toISOString(),
          invalid: summary.invalid.slice(0, 50),
        };
      }
    }

    // Category invariants:
    // - eBay category assignment must be stable and NEVER jump across unrelated branches due to ambiguous strings.
    // - Only explicit user/admin actions (or dedicated scripts) should be able to change an existing category.
    //
    // Therefore: if an existing category is present, we lock it unless allowCategoryChange=true.
    const existingCategoryId = pickStableCategoryId(existingData);
    const incomingCategoryId = pickStableCategoryId({ ...product, details: mergedDetails });
    if (existingCategoryId && hasExisting && !allowCategoryChange) {
      if (incomingCategoryId && incomingCategoryId !== existingCategoryId) {
        mergedOps.category_write_blocked = {
          at_iso: new Date().toISOString(),
          kept: existingCategoryId,
          incoming: incomingCategoryId,
        };
      }
      mergedDetails.categoryId = existingCategoryId;
      // Remove legacy category fields so enforceEbayAspects can't re-introduce changes from them.
      if (mergedDetails.ebayCategoryId) delete mergedDetails.ebayCategoryId;
      if (mergedDetails.ebayCategoryPath) delete mergedDetails.ebayCategoryPath;
      if (mergedDetails.ebayCategoryBreadcrumb) delete mergedDetails.ebayCategoryBreadcrumb;
    }

    // Add timestamps and identity metadata
    const identityKey = computeProductIdentityKey({ ...product, details: mergedDetails, identification: mergedIdentification });
    const pendingIntake =
      typeof mergedOps.pending_intake_quantity === 'number' && Number.isFinite(mergedOps.pending_intake_quantity)
        ? mergedOps.pending_intake_quantity
        : 0;
    const aliasSet = buildIdentityAliasSet({ ...product, details: mergedDetails, identification: mergedIdentification });
    const existingAliases = Array.isArray(mergedOps.identity_aliases) ? mergedOps.identity_aliases.filter(Boolean) : [];
    const mergedAliases = Array.from(new Set([...existingAliases, ...aliasSet])).slice(0, 100);

    // Weight bucket (overwrite as requested)
    const incomingWeight =
      mergedDetails?.attributes?.weight ??
      mergedDetails?.weight ??
      mergedOps?.weight ??
      mergedAttributes?.weight;
    const weightKg =
      parseWeightKg(incomingWeight) ??
      parseWeightKg(existingDetails?.attributes?.weight) ??
      null;
    // Guarantee: every product has an approximate shipping weight in kg (bucketed).
    // Buckets are intentionally coarse for reliability.
    const bucketedWeight = bucketWeight(weightKg) ?? WEIGHT_BUCKETS[0];
    if (!mergedDetails.attributes) mergedDetails.attributes = {};
    mergedDetails.attributes.weight = bucketedWeight;
    mergedDetails.weight = bucketedWeight;

    // Warehouse invariants:
    // - General product saves (LLM pipelines, admin edits, reconciliation scripts, etc.) must NEVER wipe warehouse state.
    // - Only dedicated warehouse flows (bookStockIn/out, assign/remove from bin, inventory refresh) are allowed to mutate
    //   storage/storageBins/inventory.quantity.
    //
    // Therefore: for existing docs, we only accept incoming warehouse fields when explicitly allowed via options.
    const incomingStorage =
      product && Object.prototype.hasOwnProperty.call(product, 'storage') ? product.storage : undefined;
    const incomingStorageBins =
      product && Object.prototype.hasOwnProperty.call(product, 'storageBins') ? product.storageBins : undefined;
    const incomingInventory =
      product && Object.prototype.hasOwnProperty.call(product, 'inventory') ? product.inventory : undefined;

    const canWriteWarehouseFields = !hasExisting || allowWarehouseFields;

    if (hasExisting && !canWriteWarehouseFields) {
      const attempted = [];
      if (incomingStorage !== undefined) attempted.push('storage');
      if (incomingStorageBins !== undefined) attempted.push('storageBins');
      if (incomingInventory !== undefined) attempted.push('inventory');
      if (attempted.length) {
        mergedOps.warehouse_write_blocked = {
          at_iso: new Date().toISOString(),
          fields: attempted,
        };
      }
    }

    const preservedStorage = canWriteWarehouseFields
      ? (incomingStorage !== undefined ? incomingStorage : existingData?.storage || null)
      : existingData?.storage || null;
    const preservedStorageBins = canWriteWarehouseFields
      ? (Array.isArray(incomingStorageBins) ? incomingStorageBins : existingData?.storageBins || [])
      : existingData?.storageBins || [];
    const preservedInventory = canWriteWarehouseFields
      ? (incomingInventory !== undefined ? incomingInventory : existingData?.inventory || {})
      : existingData?.inventory || {};

    const productWithEbay = enforceEbayAspects({
      ...(existingData || {}),
      ...product,
      identification: mergedIdentification,
      details: mergedDetails,
      ops: mergedOps,
      storage: preservedStorage,
      storageBins: preservedStorageBins,
      inventory: preservedInventory,
    });

    // Normalize generated fields consistently across Identify / Improve / Chat saves.
    // - no duplicate highlights
    // - stable, technical title (eBay safe length)
    const normalizedKeyFeatures = sanitizeKeyFeatures(productWithEbay?.details?.key_features || [], { max: 8 });
    const AUTO_TITLE_MIN_LEN = 70;
    const AUTO_TITLE_MAX_LEN = 80;
    if (!productWithEbay.details) productWithEbay.details = {};
    productWithEbay.details.key_features = normalizedKeyFeatures;
    if (!productWithEbay.identification) productWithEbay.identification = {};
    // IMPORTANT: Do not overwrite a manually edited title.
    // We still generate a technical title for automation paths (identify/improve/import),
    // but UI saves must persist exactly what the user entered.
    if (!isManualSave) {
      productWithEbay.identification.name = coerceTitleToPolicy(
        productWithEbay,
        productWithEbay.identification.name,
        { minLen: AUTO_TITLE_MIN_LEN, maxLen: AUTO_TITLE_MAX_LEN }
      );
    }

    const productData = {
      ...productWithEbay,
      ops: {
        ...productWithEbay.ops,
        deleted_images: deletedImages.length ? deletedImages : undefined,
        identity_key: identityKey || mergedOps.identity_key || null,
        identity_aliases: mergedAliases.length ? mergedAliases : undefined,
        pending_intake_quantity: pendingIntake,
        last_saved_iso: new Date().toISOString(),
        last_saved_source: saveSource || (isManualSave ? 'ui' : 'system'),
        revision: ((mergedOps.revision || 0)) + 1,
      },
    };

    const sanitizedProduct = sanitizeFirestoreValue(productData);
    await docRef.set(sanitizedProduct);
    
    console.log(`Product saved to Firestore: ${product.id}`);
    return {
      id: product.id,
      revision: productData.ops.revision
    };
  } catch (error) {
    console.error('Failed to save product to Firestore:', error);
    throw new Error(`Failed to save product: ${error.message}`);
  }
}

/**
 * Get a product from Firestore
 */
async function getProduct(productId) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      return null;
    }
    
    const data = doc.data();
    return {
      ...data,
      id: data?.id || doc.id,
    };
  } catch (error) {
    console.error('Failed to get product from Firestore:', error);
    throw new Error(`Failed to get product: ${error.message}`);
  }
}

/**
 * Get all products from Firestore
 */
async function getAllProducts() {
  try {
    const applyLimit = Number.isFinite(PRODUCT_LIST_LIMIT) && PRODUCT_LIST_LIMIT > 0;
    if (applyLimit) {
      console.warn(
        `[firestore] PRODUCT_LIST_LIMIT=${PRODUCT_LIST_LIMIT} konfiguriert – wird ignoriert, um fehlende Produkte im Inventar zu vermeiden.`
      );
    }

    // Wichtiger Fix: orderBy auf einem optionalen Feld filtert alle Dokumente ohne dieses Feld heraus.
    // Wir holen deshalb alle Dokumente ohne orderBy, damit keine Produkte fehlen.
    const snapshot = await firestore.collection(PRODUCTS_COLLECTION).get();
    
    const products = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      products.push({
        ...data,
        id: data?.id || doc.id,
      });
    });
    
    console.log(`Loaded ${products.length} products from Firestore`);
    return products;
  } catch (error) {
    console.error('Failed to get products from Firestore:', error);
    throw new Error(`Failed to get products: ${error.message}`);
  }
}

/**
 * Delete a product from Firestore
 */
async function deleteProduct(productId, { existingData = null } = {}) {
  if (!productId) {
    throw new Error('Product ID is required for deletion.');
  }
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    let productData = existingData;
    if (!productData) {
      const snapshot = await docRef.get();
      if (!snapshot.exists) {
        console.log(`Product not found for deletion: ${productId}`);
        return false;
      }
      productData = snapshot.data() || {};
    }

    const batch = firestore.batch();
    batch.delete(docRef);

    const indexKeys = collectSkuIndexKeys(productData);
    indexKeys.forEach((key) => {
      if (!key) return;
      batch.delete(firestore.collection(SKU_INDEX_COLLECTION).doc(key));
    });

    await batch.commit();

    const suffix = indexKeys.length === 1 ? 'entry' : 'entries';
    console.log(`Product deleted from Firestore: ${productId} (removed ${indexKeys.length} SKU index ${suffix})`);
    return true;
  } catch (error) {
    console.error('Failed to delete product from Firestore:', error);
    throw new Error(`Failed to delete product: ${error.message}`);
  }
}

/**
 * Update product sync status (and optional BaseLinker linkage)
 */
async function updateProductSyncStatus(
  productId,
  status,
  lastSyncedIso = null,
  baseProductId = undefined,
  inventoryId = undefined
) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    const updateData = {
      'ops.sync_status': status
    };
    
    if (lastSyncedIso) {
      updateData['ops.last_synced_iso'] = lastSyncedIso;
    }
    
    if (baseProductId !== undefined) {
      updateData['ops.base_product_id'] = baseProductId;
      updateData['ops.baselinker'] = {
        ...(updateData['ops.baselinker'] || {}),
        product_id: baseProductId,
        synced_inventory: inventoryId || null,
      };
    }
    
    await docRef.update(updateData);
    console.log(`Product sync status updated: ${productId} -> ${status}`);
  } catch (error) {
    console.error('Failed to update product sync status:', error);
    throw new Error(`Failed to update sync status: ${error.message}`);
  }
}

async function findProductByIdentityKey(identityKey) {
  if (!identityKey) return null;
  const snapshot = await firestore
    .collection(PRODUCTS_COLLECTION)
    .where('ops.identity_key', '==', identityKey)
    .limit(1)
    .get();
  if (snapshot.empty) {
    return null;
  }
  const doc = snapshot.docs[0];
  const data = doc.data();
  return {
    ...data,
    id: data?.id || doc.id,
  };
}

async function findProductByStrictIdentifier({ barcodes = [], sku = null } = {}) {
  if (!barcodes.length && !sku) return null;

  // 1. Check barcodes (EAN/GTIN/UPC/etc)
  const uniqueBarcodes = Array.from(new Set(barcodes.filter(Boolean)));
  for (const code of uniqueBarcodes) {
    // Check identification.barcodes
    let snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('identification.barcodes', 'array-contains', code)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }
    
    // Check details.identifiers.ean
    snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('details.identifiers.ean', '==', code)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }

    // Check details.identifiers.gtin
    snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('details.identifiers.gtin', '==', code)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }
  }

  // 2. Check SKU
  if (sku) {
    // Check identification.sku
    let snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('identification.sku', '==', sku)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }

    // Check details.identifiers.sku
    snap = await firestore.collection(PRODUCTS_COLLECTION)
      .where('details.identifiers.sku', '==', sku)
      .limit(1)
      .get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ...doc.data(), id: doc.id };
    }
  }

  return null;
}

async function findProductByNameBrand(name = null, brand = null) {
  const queries = [];
  const trimmedName = (name || '').trim();
  const trimmedBrand = (brand || '').trim();

  if (!trimmedName) return null;

  // Exact name match on identification.name
  queries.push(
    firestore
      .collection(PRODUCTS_COLLECTION)
      .where('identification.name', '==', trimmedName)
      .limit(3)
      .get()
  );

  // Exact name match on details.name
  queries.push(
    firestore
      .collection(PRODUCTS_COLLECTION)
      .where('details.name', '==', trimmedName)
      .limit(3)
      .get()
  );

  const snapshots = await Promise.all(queries);

  for (const snap of snapshots) {
    if (snap.empty) continue;
    for (const doc of snap.docs) {
      const data = doc.data();
      // If brand is provided, prefer matching brand
      if (trimmedBrand) {
        const candidateBrand =
          (data?.identification?.brand || data?.details?.brand || '').trim().toLowerCase();
        if (candidateBrand && candidateBrand !== trimmedBrand.toLowerCase()) {
          continue;
        }
      }
      return { ...data, id: data?.id || doc.id };
    }
  }

  return null;
}

async function findProductByIdentityAliases(aliases = [], { excludeProductId = null, maxQueries = 12 } = {}) {
  if (!Array.isArray(aliases) || !aliases.length) {
    return null;
  }
  const uniqueAliases = Array.from(new Set(aliases.filter(Boolean))).slice(0, maxQueries);
  for (const alias of uniqueAliases) {
    const snapshot = await firestore
      .collection(PRODUCTS_COLLECTION)
      .where('ops.identity_aliases', 'array-contains', alias)
      .limit(5)
      .get();
    if (snapshot.empty) {
      continue;
    }
    for (const doc of snapshot.docs) {
      if (excludeProductId && doc.id === excludeProductId) {
        continue;
      }
      const data = doc.data();
      return {
        ...data,
        id: data?.id || doc.id,
      };
    }
  }
  return null;
}

async function findProductIdsByAliases(aliases = [], { excludeProductId = null } = {}) {
  if (!Array.isArray(aliases) || !aliases.length) {
    return [];
  }
  const filtered = Array.from(new Set(aliases.filter(Boolean))).slice(0, MAX_ALIAS_LOOKUP);
  if (!filtered.length) {
    return [];
  }
  const ids = new Set();
  for (const alias of filtered) {
    const snapshot = await firestore
      .collection(PRODUCTS_COLLECTION)
      .where('ops.identity_aliases', 'array-contains', alias)
      .get();
    snapshot.forEach((doc) => {
      if (excludeProductId && doc.id === excludeProductId) {
        return;
      }
      ids.add(doc.id);
    });
  }
  return Array.from(ids);
}

async function deleteProductsByIdentityAlias(alias, { limit = 50 } = {}) {
  const normalizedAlias = sanitizeIdentityValue(alias);
  if (!normalizedAlias) {
    return { alias: null, deletedCount: 0, productIds: [] };
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;
  const snapshot = await firestore
    .collection(PRODUCTS_COLLECTION)
    .where('ops.identity_aliases', 'array-contains', normalizedAlias)
    .limit(cap)
    .get();

  if (snapshot.empty) {
    return { alias: normalizedAlias, deletedCount: 0, productIds: [] };
  }

  const docs = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  const deletedIds = [];
  for (const doc of docs) {
    try {
      const removed = await deleteProduct(doc.id, { existingData: doc.data });
      if (removed) {
        deletedIds.push(doc.id);
      }
    } catch (error) {
      console.error(`Failed to delete product ${doc.id} for alias ${normalizedAlias}:`, error.message);
    }
  }

  return {
    alias: normalizedAlias,
    deletedCount: deletedIds.length,
    productIds: deletedIds,
  };
}

async function adjustPendingIntakeQuantity(productId, delta = 0) {
  if (!productId || !delta) {
    return null;
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error(`Product ${productId} not found for pending intake update`);
    }
    const data = snap.data() || {};
    const current = Number(data?.ops?.pending_intake_quantity) || 0;
    const next = Math.max(0, current + delta);
    tx.update(docRef, {
      'ops.pending_intake_quantity': next,
    });
    return next;
  });
}

async function appendProductIdentityAliases(productId, aliases = []) {
  if (!productId || !Array.isArray(aliases) || !aliases.length) {
    return;
  }
  const filtered = aliases.filter(Boolean);
  if (!filtered.length) {
    return;
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  await docRef.set(
    {
      ops: {
        identity_aliases: FieldValue.arrayUnion(...filtered.slice(0, 100)),
      },
    },
    { merge: true }
  );
}

async function removeProductIdentityAliases(productId, aliases = []) {
  if (!productId || !Array.isArray(aliases) || !aliases.length) {
    return;
  }
  const normalized = aliases.map((alias) => sanitizeIdentityValue(alias)).filter(Boolean);
  if (!normalized.length) {
    return;
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  await docRef.set(
    {
      ops: {
        identity_aliases: FieldValue.arrayRemove(...normalized),
      },
    },
    { merge: true }
  );

  // Clean up SKU/EAN index entries that may have been created for the alias values
  const indexKeys = normalized
    .map((alias) => buildSkuIndexKey('ean', normalizeEanValue(alias)))
    .filter(Boolean);
  if (!indexKeys.length) {
    return;
  }
  const batch = firestore.batch();
  indexKeys.forEach((key) => {
    batch.delete(firestore.collection(SKU_INDEX_COLLECTION).doc(key));
  });
  await batch.commit();
}

async function saveOrders(orders = []) {
  if (!Array.isArray(orders) || orders.length === 0) {
    return [];
  }

  const batch = firestore.batch();
  const now = new Date().toISOString();

  orders.forEach((order) => {
    if (!order?.id) return;
    const docRef = firestore.collection(ORDERS_COLLECTION).doc(order.id);
    batch.set(
      docRef,
      {
        ...order,
        createdAt: order.createdAt || now,
        updatedAt: order.updatedAt || now,
      },
      { merge: true }
    );
  });

  await batch.commit();
  return orders;
}

async function listOrders(limit = 50) {
  const snapshot = await firestore
    .collection(ORDERS_COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => doc.data());
}

/**
 * Aggregate order counts across the entire orders collection.
 * Picks are detected by:
 * - status === 'picked'
 * - statusLabel/status matching known closed labels (kommissioniert/versendet/zugestellt/…)
 * - pickedAt being present
 * - statusId matching configured picked status IDs (env) or the hard fallback.
 */
async function getOrderSummary() {
  const CLOSED_LABELS = new Set([
    'kommissioniert',
    'versendet',
    'zugestellt',
    'shipped',
    'delivered',
    'completed',
    'erledigt',
    'storniert',
    'cancelled',
    'canceled',
  ]);

  const pickedStatusIds = new Set(['363183']); // hard fallback BaseLinker picked status
  const envPickedId = process.env.BASE_ORDER_STATUS_PICKED;
  if (envPickedId) {
    pickedStatusIds.add(String(envPickedId).trim());
  }

  const snapshot = await firestore.collection(ORDERS_COLLECTION).get();

  let total = 0;
  let picked = 0;

  snapshot.forEach((doc) => {
    const order = doc.data() || {};
    total += 1;

    const statusId = order.statusId ? String(order.statusId) : null;
    const rawStatus = order.status || order.statusLabel || '';
    const normalizedStatus = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';

    const isPickedById = statusId ? pickedStatusIds.has(statusId) : false;
    const isPickedByLabel =
      CLOSED_LABELS.has(normalizedStatus) ||
      CLOSED_LABELS.has(normalizedStatus.replace(/\s+/g, ' ')) ||
      normalizedStatus.includes('versendet') ||
      normalizedStatus.includes('zugestellt');
    const isPickedStatus = normalizedStatus === 'picked';
    const isPickedByTimestamp = Boolean(order.pickedAt);

    if (isPickedById || isPickedByLabel || isPickedStatus || isPickedByTimestamp) {
      picked += 1;
    }
  });

  const open = Math.max(0, total - picked);
  return { total, picked, open };
}

async function getOrderById(orderId) {
  if (!orderId) return null;
  const doc = await firestore.collection(ORDERS_COLLECTION).doc(orderId).get();
  return doc.exists ? doc.data() : null;
}

async function updateOrder(orderId, updates = {}) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }
  const docRef = firestore.collection(ORDERS_COLLECTION).doc(orderId);
  await docRef.set(
    {
      ...updates,
      updatedAt: new Date().toISOString(),
      ...(!updates.updatedAt ? { updatedAt: new Date().toISOString() } : {}),
    },
    { merge: true }
  );
}

async function getSkuIndexEntry(key) {
  if (!key) return null;
  try {
    const doc = await firestore.collection(SKU_INDEX_COLLECTION).doc(key).get();
    if (!doc.exists) return null;
    return doc.data();
  } catch (error) {
    console.warn('Failed to read SKU index entry:', key, error.message);
    return null;
  }
}

async function setSkuIndexEntry(key, payload = {}) {
  if (!key) return;
  try {
    await firestore
      .collection(SKU_INDEX_COLLECTION)
      .doc(key)
      .set(
        {
          baseProductId: payload.baseProductId || null,
          productId: payload.productId || null,
          sku: payload.sku || null,
          ean: payload.ean || null,
          updated_at: payload.updatedAt || new Date().toISOString(),
        },
        { merge: true }
      );
  } catch (error) {
    console.warn('Failed to write SKU index entry:', key, error.message);
  }
}

async function upsertInventories(records = []) {
  if (!Array.isArray(records) || !records.length) {
    return { upserted: 0 };
  }
  const snapshot = await inventoryCollection().get();
  const existingMap = new Map();
  snapshot.forEach((doc) => existingMap.set(doc.id, doc.data()));
  const batch = firestore.batch();
  records.forEach((record) => {
    const inventoryId = String(record.inventoryId || record.id || '').trim();
    if (!inventoryId) return;
    const existing = existingMap.get(inventoryId);
    const docRef = inventoryCollection().doc(inventoryId);
    const parsedMeta = record.meta || parseInventoryNameMeta(record.name || '');
    const payload = sanitizeFirestoreValue({
      inventoryId,
      name: record.name || inventoryId,
      description: record.description || null,
      vendorCode: record.vendorCode || parsedMeta.vendorCode || null,
      fiscalYear: record.fiscalYear ?? parsedMeta.fiscalYear ?? null,
      sequence: record.sequence ?? parsedMeta.sequence ?? null,
      type: record.type || null,
      defaultWarehouse: record.defaultWarehouse || null,
      defaultPriceGroup: record.defaultPriceGroup || null,
      isActive: record.isActive !== false,
      isExternal: record.isExternal || false,
      baselinker: record.baselinker || null,
      meta: {
        vendorCode: record.vendorCode || parsedMeta.vendorCode || null,
        fiscalYear: record.fiscalYear ?? parsedMeta.fiscalYear ?? null,
        sequence: record.sequence ?? parsedMeta.sequence ?? null,
      },
      createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.set(docRef, payload, { merge: true });
  });
  await batch.commit();
  return { upserted: records.length };
}

async function listInventories({ limit = 500, vendorCode = null, search = '' } = {}) {
  let query = inventoryCollection().orderBy('name');
  if (vendorCode) {
    query = query.where('meta.vendorCode', '==', vendorCode.toUpperCase());
  }
  if (Number.isFinite(limit) && limit > 0) {
    query = query.limit(limit);
  }
  const snapshot = await query.get();
  let inventories = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      ...data,
      inventoryId: data.inventoryId || doc.id,
    };
  });
  const normalizedSearch = search?.trim().toLowerCase();
  if (normalizedSearch) {
    inventories = inventories.filter((entry) => {
      const haystacks = [
        entry.name,
        entry.inventoryId,
        entry.description,
        entry.vendorCode,
        entry.meta?.vendorCode,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return haystacks.some((value) => value.includes(normalizedSearch));
    });
  }
  return inventories;
}

async function getInventoryRecord(inventoryId) {
  if (!inventoryId) return null;
  const snapshot = await inventoryCollection().doc(inventoryId).get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  return {
    ...data,
    inventoryId: data.inventoryId || snapshot.id,
  };
}

async function setProductInventory(productId, inventory) {
  if (!productId || !inventory?.inventoryId) {
    throw new Error('Inventory ID und Produkt ID sind erforderlich.');
  }
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  await docRef.update({
    'inventory.inventoryId': inventory.inventoryId,
    'inventory.inventoryName': inventory.name || null,
  });
}

async function assignInventoryToProducts(productIds = [], inventory) {
  if (!Array.isArray(productIds) || !productIds.length) {
    return;
  }
  if (!inventory?.inventoryId) {
    throw new Error('Inventory-Datensatz ist erforderlich.');
  }
  const batch = firestore.batch();
  productIds.forEach((productId) => {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    batch.update(docRef, {
      'inventory.inventoryId': inventory.inventoryId,
      'inventory.inventoryName': inventory.name || null,
    });
  });
  await batch.commit();
}

async function logInventorySyncEvent({ productId, inventoryId, status, message }) {
  await firestore.collection(INVENTORY_SYNC_LOGS_COLLECTION).add({
    productId,
    inventoryId,
    status,
    message: message || null,
    createdAt: FieldValue.serverTimestamp(),
  });
}

module.exports = {
  saveProduct,
  getProduct,
  getAllProducts,
  deleteProduct,
  updateProductSyncStatus,
  findProductByIdentityKey,
  findProductByIdentityAliases,
  findProductIdsByAliases,
  deleteProductsByIdentityAlias,
  findProductByStrictIdentifier, // Export the new function
  adjustPendingIntakeQuantity,
  appendProductIdentityAliases,
  removeProductIdentityAliases,
  saveOrders,
  listOrders,
  getOrderSummary,
  getOrderById,
  updateOrder,
  getSkuIndexEntry,
  setSkuIndexEntry,
  upsertInventories,
  listInventories,
  getInventoryRecord,
  setProductInventory,
  assignInventoryToProducts,
  logInventorySyncEvent,
  firestore,
};