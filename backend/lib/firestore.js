const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { isValidGtin: isValidGtinShared, normalizeDigits: normalizeDigitsShared } = require('./gtin');
const {
  computeProductIdentityKey,
  buildIdentityAliasSet,
  sanitizeIdentityValue,
} = require('./product-identity');
const { coerceTitleToPolicy } = require('./title-policy');
const { normalizeBrandDisplayCase } = require('./brand-normalize');
const { getVehicleFitmentMode } = require('./vehicle-fitment');

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

function normalizeWeightKgNumber(value) {
  const kg = parseWeightKg(value);
  if (kg === null) return null;
  if (!Number.isFinite(kg) || kg <= 0) return null;
  // Keep as a pure number in KG (no units). Round to 2 decimals for stability.
  const rounded = Math.round(kg * 100) / 100;
  if (!Number.isFinite(rounded) || rounded <= 0) return null;
  // Prefer integers when exact after rounding (e.g. 1kg -> 1).
  if (Number.isInteger(rounded)) return rounded;
  return Number(rounded.toFixed(2));
}

function normalizeAttributesOrder(attrs = {}, { requiredOrder = [], preferredOrder = [] } = {}) {
  const entries = Object.entries(attrs || {});
  if (!entries.length) return {};

  const norm = (v) => (v == null ? '' : String(v)).trim().toLowerCase();
  const byKey = new Map(entries);
  const remaining = new Set(byKey.keys());
  const lowerToKey = new Map();
  for (const key of byKey.keys()) {
    const lower = norm(key);
    if (!lower) continue;
    // Preserve first occurrence (keys should already be deduped upstream)
    if (!lowerToKey.has(lower)) lowerToKey.set(lower, key);
  }

  const orderedKeys = [];
  const pushKey = (name) => {
    const lower = norm(name);
    if (!lower) return;
    const actual = lowerToKey.get(lower);
    if (!actual) return;
    if (!remaining.has(actual)) return;
    orderedKeys.push(actual);
    remaining.delete(actual);
  };

  // 1) Category-required aspects first (keeps the order from taxonomy file)
  (Array.isArray(requiredOrder) ? requiredOrder : []).forEach((k) => pushKey(k));
  // 2) Global preferred keys next (brand/identifiers/specs)
  (Array.isArray(preferredOrder) ? preferredOrder : []).forEach((k) => pushKey(k));

  // 3) The rest: alphabetic for stability
  const rest = Array.from(remaining);
  rest.sort((a, b) => norm(a).localeCompare(norm(b), 'de', { sensitivity: 'base' }));
  orderedKeys.push(...rest);

  return orderedKeys.reduce((acc, key) => {
    acc[key] = byKey.get(key);
    return acc;
  }, {});
}

// Stable, cross-category attribute ordering hints (UI + exports).
// When a category is known, requiredOrder (eBay required aspects) is applied first, then this list, then A-Z.
const DEFAULT_ATTRIBUTE_ORDER = [
  'Marke',
  'Hersteller',
  'Produktart',
  'Produkttyp',
  'Artikeltyp',
  'Gerätetyp',
  'Bauteil',
  'Herstellernummer',
  'Referenznummer(n) OEM',
  'Referenznummer',
  'OEM-Referenznummer',
  'Modell',
  'Fahrzeugmarke',
  'Fahrzeugmodell',
  'Baureihe',
  'Einbauposition',
  'K-Typ',
  'Abteilung',
  'Geschlecht',
  'Größe',
  'EU-Schuhgröße',
  'Schuhgröße',
  'Farbe',
  'Material',
  'weight', // internal numeric (kg) – may be mapped to a category-specific weight aspect below
  'Zustand',
  'Kategorie',
];

// --- Category Profiles (for attribute key normalization) ---
// Stored by Category Management UI in Firestore: categoryProfiles/{ebayCategoryId}
const CATEGORY_PROFILES_COLLECTION = 'categoryProfiles';
let categoryProfileCache = new Map(); // id -> { atMs, data }
const CATEGORY_PROFILE_CACHE_TTL_MS = parseInt(process.env.CATEGORY_PROFILE_CACHE_TTL_MS || '120000', 10); // 2 min

async function getCategoryProfileById(categoryId) {
  const id = categoryId == null ? '' : String(categoryId).trim();
  if (!id) return null;
  const now = Date.now();
  const cached = categoryProfileCache.get(id);
  if (cached && now - cached.atMs < CATEGORY_PROFILE_CACHE_TTL_MS) {
    return cached.data || null;
  }
  try {
    const snap = await firestore.collection(CATEGORY_PROFILES_COLLECTION).doc(id).get();
    const data = snap.exists ? snap.data() || null : null;
    categoryProfileCache.set(id, { atMs: now, data });
    return data;
  } catch (e) {
    return null;
  }
}

function normalizeAttrKeyProfile(key) {
  return (key == null ? '' : String(key)).replace(/\s+/g, ' ').trim();
}

function lowerKeyProfile(key) {
  return normalizeAttrKeyProfile(key).toLowerCase();
}

function applyAttributeAliasesProfile(attrs = {}, { canonicalAttributes = [], attributeAliases = {} } = {}, { onConflict } = {}) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return attrs;

  // Normalize whitespace in keys
  const normalized = {};
  Object.keys(attrs).forEach((k) => {
    const nk = normalizeAttrKeyProfile(k);
    if (!nk) return;
    normalized[nk] = attrs[k];
  });

  const canonicalLowerToExact = new Map();
  (Array.isArray(canonicalAttributes) ? canonicalAttributes : []).forEach((k) => {
    const nk = normalizeAttrKeyProfile(k);
    if (!nk) return;
    canonicalLowerToExact.set(nk.toLowerCase(), nk);
  });

  const findKeyByLower = (obj, needleLower) =>
    Object.keys(obj || {}).find((k) => lowerKeyProfile(k) === needleLower) || null;

  const aliasObj =
    attributeAliases && typeof attributeAliases === 'object' && !Array.isArray(attributeAliases) ? attributeAliases : {};

  Object.keys(aliasObj).forEach((aliasRaw) => {
    const alias = normalizeAttrKeyProfile(aliasRaw);
    const canonicalRaw = normalizeAttrKeyProfile(aliasObj[aliasRaw]);
    if (!alias || !canonicalRaw) return;

    const aliasKey = findKeyByLower(normalized, alias.toLowerCase());
    if (!aliasKey) return;

    const canonicalExact = canonicalLowerToExact.get(canonicalRaw.toLowerCase()) || canonicalRaw;
    const canonicalKey = findKeyByLower(normalized, canonicalExact.toLowerCase());

    const aliasVal = normalized[aliasKey];
    const canonicalVal = canonicalKey ? normalized[canonicalKey] : undefined;
    const aliasEmpty = aliasVal == null || (typeof aliasVal === 'string' && aliasVal.trim() === '');
    const canonicalEmpty = canonicalVal == null || (typeof canonicalVal === 'string' && canonicalVal.trim() === '');

    if (!canonicalKey || canonicalEmpty) {
      normalized[canonicalExact] = aliasVal;
    } else if (!aliasEmpty && !canonicalEmpty && canonicalVal !== aliasVal) {
      if (typeof onConflict === 'function') onConflict({ alias: aliasKey, canonical: canonicalKey, aliasVal, canonicalVal });
    }
    if (aliasKey !== canonicalExact) delete normalized[aliasKey];
  });

  // Normalize casing/spelling to exact canonical keys
  canonicalLowerToExact.forEach((canonicalExact, canonicalLower) => {
    const existingKey = findKeyByLower(normalized, canonicalLower);
    if (!existingKey) return;
    if (existingKey === canonicalExact) return;
    const v = normalized[existingKey];
    delete normalized[existingKey];
    normalized[canonicalExact] = v;
  });

  return normalized;
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
      'brand name': 'Marke',
      'brandname': 'Marke',
      'brand_name': 'Marke',
      'marke': 'Marke',
      'manufacturer': 'Hersteller',
      'manufacturer name': 'Hersteller',
      'manufacturer_name': 'Hersteller',
      'herstellername': 'Hersteller',
      'hersteller name': 'Hersteller',
      'hersteller': 'Hersteller',
      'department': 'Abteilung',
      'abteilung': 'Abteilung',
      'gender': 'Geschlecht',

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
      'bruttogewicht': 'weight',
      'brutto gewicht': 'weight',
      'nettogewicht': 'weight',
      'netto gewicht': 'weight',
      'gross weight': 'weight',
      'net weight': 'weight',
      'eigengewicht': 'weight',
      'eigengewicht(kg)': 'weight',
      'eigengewicht (kg)': 'weight',
      'artikelgewicht': 'weight',
      'versandgewicht': 'weight',
      'shipping weight': 'weight',
      'weight': 'weight',

      // Use-case / usage (mergeable)
      'geeignet für': 'Verwendungszweck',
      'geeignet fur': 'Verwendungszweck',
      'geeignetfuer': 'Verwendungszweck',
      'geeignetfuer ': 'Verwendungszweck',
      'verwendungszweck': 'Verwendungszweck',
      'use case': 'Verwendungszweck',
      'usage': 'Verwendungszweck',

      // Dishwasher safe (canonical)
      'spülmaschinengeeignet': 'Spülmaschinengeeignet',
      'spulmaschinengeeignet': 'Spülmaschinengeeignet',
      'spülmachinengeeignet': 'Spülmaschinengeeignet',
      'spulmachinengeeignet': 'Spülmaschinengeeignet',
      'spülmaschinenfest': 'Spülmaschinengeeignet',
      'spulmaschinenfest': 'Spülmaschinengeeignet',
      'spülmachinenfest': 'Spülmaschinengeeignet',
      'spulmachinenfest': 'Spülmaschinengeeignet',

      // Category path variants
      'kategorie-pfad': 'Kategorie',
      'kategorie pfad': 'Kategorie',
      'kategoriepfad': 'Kategorie',
      'category path': 'Kategorie',
      'category_path': 'Kategorie',
    }).map(([k, v]) => [k.toLowerCase(), v])
  );

  // Keys where multiple values should be merged (instead of keeping "duplicate" keys).
  const MERGEABLE_KEYS = new Set(['verwendungszweck']);

  const normalizeListTokens = (value) => {
    const raw = value == null ? '' : String(value);
    const parts = raw
      .split(/[,;|\n]+/)
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const k = p.toLowerCase().replace(/\s+/g, ' ');
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  };

  const mergeListValues = (a, b) => {
    const merged = [...normalizeListTokens(a), ...normalizeListTokens(b)];
    const seen = new Set();
    const out = [];
    for (const p of merged) {
      const k = p.toLowerCase().replace(/\s+/g, ' ');
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out.join(', ');
  };

  const extractDishwasherFromProperties = (obj, { extraTarget }) => {
    if (!obj || typeof obj !== 'object') return;
    const keys = Object.keys(obj);
    const propKeys = keys.filter((k) => {
      const lower = normalizeLower(k);
      return lower === 'eigenschaft' || lower === 'eigenschaften' || lower === 'property' || lower === 'properties';
    });
    if (!propKeys.length) return;

    const dishwasherTokens = [
      'spülmaschinenfest',
      'spulmaschinenfest',
      'spülmachinenfest',
      'spulmachinenfest',
      'spülmaschinengeeignet',
      'spulmaschinengeeignet',
      'spülmachinengeeignet',
      'spulmachinengeeignet',
    ];

    for (const key of propKeys) {
      const raw = obj[key];
      if (raw == null) continue;
      const parts = normalizeListTokens(raw);
      if (!parts.length) continue;
      const kept = [];
      let found = false;
      for (const p of parts) {
        const lower = p.toLowerCase().replace(/\s+/g, '');
        if (dishwasherTokens.some((t) => lower.includes(t.replace(/\s+/g, '')))) {
          found = true;
          continue;
        }
        kept.push(p);
      }
      if (found) {
        // Set canonical dishwasher boolean-ish attribute.
        obj['Spülmaschinengeeignet'] = 'Ja';
        if (kept.length) {
          obj[key] = kept.join(', ');
        } else {
          // remove empty property key; keep original in extra for forensics
          if (extraTarget && typeof extraTarget === 'object') {
            extraTarget[key] = raw;
          }
          delete obj[key];
        }
      }
    }
  };

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

  const addWarning = (msg) => {
    const text = (msg == null ? '' : String(msg)).replace(/\s+/g, ' ').trim();
    if (!text) return;
    product.notes = product.notes || {};
    const existing = Array.isArray(product.notes.warnings) ? product.notes.warnings : [];
    // Preserve existing, dedupe case-insensitive.
    const lower = new Set(existing.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
    if (!lower.has(text.toLowerCase())) {
      product.notes.warnings = [...existing, text];
    }
  };

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

  // GPSR (EU compliance) fields should be stored in a dedicated structured object, not in the user-facing
  // attributes table. This avoids duplicated values like "Marke" == "GPSR Manufacturer name" and makes
  // downstream mappings (BaseLinker, etc.) deterministic.
  const gpsr =
    details.gpsr && typeof details.gpsr === 'object' ? { ...details.gpsr } : {};
  const ingestGpsrAttribute = (finalKey, val, nextExtra, originalKey) => {
    if (!isGpsrKey(finalKey)) return false;
    const keyLower = normalizeLower(finalKey);
    const rawValue =
      val === null || val === undefined ? '' : typeof val === 'string' ? val.trim() : String(val).trim();

    // Preserve placeholders/empty/objects for forensics, but never show as attributes.
    if (!rawValue || isPlaceholder(rawValue) || (val && typeof val === 'object')) {
      nextExtra[originalKey] = val;
      return true;
    }

    if (keyLower.includes('manufacturer') && keyLower.includes('name')) {
      gpsr.manufacturer_name = rawValue;
      return true;
    }
    if (
      keyLower.includes('manufacturer') &&
      (keyLower.includes('address') || keyLower.includes('adresse'))
    ) {
      gpsr.manufacturer_address = rawValue;
      return true;
    }
    if (keyLower.includes('email') || keyLower.includes('e-mail')) {
      gpsr.email = rawValue;
      return true;
    }
    if (keyLower.includes('url') || keyLower.includes('website') || keyLower.includes('webseite')) {
      gpsr.url = rawValue;
      return true;
    }

    // Unknown GPSR-* keys: keep in extra, never as attributes.
    nextExtra[originalKey] = val;
    return true;
  };

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

      // GPSR/compliance keys are stored separately (details.gpsr), never as attributes.
      if (ingestGpsrAttribute(finalKey, val, nextExtra, originalKey)) {
        return;
      }
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

    // Consolidation pass (no-category):
    // - Merge usage fields to one canonical key
    // - Extract "Spülmaschinengeeignet" from Eigenschaft(en)
    // - Ensure only ONE weight-like field survives (others moved to attributes_extra via aliasing)
    extractDishwasherFromProperties(nextAttrs, { extraTarget: nextExtra });
    if (nextAttrs.Verwendungszweck && nextAttrs['Geeignet für']) {
      nextAttrs.Verwendungszweck = mergeListValues(nextAttrs.Verwendungszweck, nextAttrs['Geeignet für']);
      nextExtra['Geeignet für'] = nextAttrs['Geeignet für'];
      delete nextAttrs['Geeignet für'];
    }
    if (nextAttrs['Verwendungszweck'] && nextAttrs['Use case']) {
      nextAttrs.Verwendungszweck = mergeListValues(nextAttrs.Verwendungszweck, nextAttrs['Use case']);
      nextExtra['Use case'] = nextAttrs['Use case'];
      delete nextAttrs['Use case'];
    }
    // Prefer showing a user-friendly key for weight when no required weight aspect exists.
    if (Object.prototype.hasOwnProperty.call(nextAttrs, 'weight')) {
      const w = nextAttrs.weight;
      nextAttrs['Gewicht (kg)'] = w;
      delete nextAttrs.weight;
    }

    // Safe dedupe: collapse obvious synonym duplicates when values are identical (case/space),
    // but NEVER drop a required aspect (none known in the no-category path).
    const normVal = (v) =>
      (v == null ? '' : String(v))
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    const dropIfSame = (keepKey, dropKey) => {
      if (!nextAttrs[keepKey] || !nextAttrs[dropKey]) return;
      const a = normVal(nextAttrs[keepKey]);
      const b = normVal(nextAttrs[dropKey]);
      if (!a || !b) return;
      if (a !== b) return;
      // Preserve in extra for forensics, but keep UI clean.
      nextExtra[dropKey] = nextAttrs[dropKey];
      delete nextAttrs[dropKey];
    };
    dropIfSame('Marke', 'Hersteller');
    dropIfSame('Abteilung', 'Zielgruppe');

    return {
      ...product,
      details: {
        ...details,
        gpsr: Object.keys(gpsr).length ? gpsr : details.gpsr,
        attributes: normalizeAttributesOrder(nextAttrs, { preferredOrder: DEFAULT_ATTRIBUTE_ORDER }),
        attributes_extra: Object.keys(nextExtra).length ? nextExtra : undefined,
      },
    };
  }

  const requiredAspects = Array.isArray(requiredMap[catId]) ? requiredMap[catId] : [];
  const categoryPath = product?.identification?.category || null;

  // Vehicle fitment (K-Typ) enforcement for categories where eBay supports vehicle fitment lists.
  // We do NOT invent K-Typ here. If missing (and we have an MPN), we add a warning so automation/UI can surface it.
  const fitmentMode = getVehicleFitmentMode(catId);
  if (fitmentMode) {
    const ids = product?.details?.identifiers || {};
    const mpn = (typeof ids?.mpn === 'string' ? ids.mpn.trim() : ids?.mpn == null ? '' : String(ids.mpn).trim());
    const hasKTyp = Object.keys(attrs || {}).some((k) => {
      const lower = String(k || '').trim().toLowerCase();
      return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
    });
    if (mpn && !hasKTyp) {
      addWarning(
        `K-Typ fehlt: Kategorie unterstützt Fahrzeugverwendungsliste (${fitmentMode}) und Herstellernummer/MPN ist gesetzt.`
      );
    }
  }
  const canonicalByLower = new Map(
    requiredAspects
      .map((n) => normalizeKey(n))
      .filter(Boolean)
      .map((n) => [normalizeLower(n), n])
  );

  const keptAspects = {};
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

    // GPSR/compliance keys are stored separately (details.gpsr), never as attributes.
    if (ingestGpsrAttribute(finalKey, val, nextExtra, originalKey)) {
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
      } else if (
        !prevEmpty &&
        !nextEmpty &&
        canonicalName &&
        MERGEABLE_KEYS.has(normalizeLower(canonicalName))
      ) {
        // Merge list-like values instead of treating them as conflicting duplicates.
        keptAspects[canonicalName] = mergeListValues(prevStr, nextStr);
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
    } else if (lower === 'hersteller') {
      // Many categories require "Hersteller" (manufacturer). Use Brand when we don't have a separate field.
      derived = product?.identification?.brand || details?.brand || null;
    } else if (lower === 'produktart') {
      // Derive product type from breadcrumb leaf (no guessing beyond existing category path).
      const leaf =
        categoryPath && String(categoryPath).includes('>')
          ? String(categoryPath).split('>').pop()?.trim()
          : (categoryPath ? String(categoryPath).trim() : '');
      derived = leaf || null;
    } else if (lower === 'zustand' || lower === 'condition') {
      // Default condition (system invariant): NEU unless manually locked otherwise elsewhere.
      derived = (product?.details?.attributes && product.details.attributes.Zustand) || 'NEU';
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

  // Consolidation pass (category-known):
  // - Extract dishwasher-safe boolean from Eigenschaft(en)
  // - (Usage merging is handled via MERGEABLE_KEYS when aliasing maps to Verwendungszweck)
  extractDishwasherFromProperties(keptAspects, { extraTarget: nextExtra });

  // Avoid duplicate weight fields:
  // - We keep the category-specific required weight aspect (e.g. "Gewicht(kg)") when present/required.
  // - Internal numeric kg is still stored in details.weight for downstream integrations.
  const weightAspect = (requiredAspects || []).find((name) => normalizeLower(name).includes('gewicht'));
  if (weightAspect) {
    const internalWeightKey = Object.keys(keptAspects).find((k) => normalizeLower(k) === 'weight') || null;
    if (internalWeightKey) {
      const internalVal = keptAspects[internalWeightKey];
      const existingVal = keptAspects[weightAspect];
      const existingEmpty = existingVal == null || String(existingVal).trim() === '';
      const internalNonEmpty = internalVal != null && String(internalVal).trim() !== '';
      if (existingEmpty && internalNonEmpty) {
        keptAspects[weightAspect] = internalVal;
      }
      delete keptAspects[internalWeightKey];
    }
  } else {
    // No category-required weight aspect -> keep a user-friendly weight key in attributes (still numeric kg).
    const internalWeightKey = Object.keys(keptAspects).find((k) => normalizeLower(k) === 'weight') || null;
    if (internalWeightKey) {
      keptAspects['Gewicht (kg)'] = keptAspects[internalWeightKey];
      delete keptAspects[internalWeightKey];
    }
  }

  // Safe dedupe: collapse obvious synonym duplicates when values are identical (case/space),
  // but NEVER drop a required aspect key for this category.
  const requiredLowerSet = new Set((requiredAspects || []).map((k) => normalizeLower(k)).filter(Boolean));
  const normVal = (v) =>
    (v == null ? '' : String(v))
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  const dropIfSame = (keepKey, dropKey) => {
    if (!keptAspects[keepKey] || !keptAspects[dropKey]) return;
    if (requiredLowerSet.has(normalizeLower(dropKey))) return; // cannot drop required aspect
    const a = normVal(keptAspects[keepKey]);
    const b = normVal(keptAspects[dropKey]);
    if (!a || !b) return;
    if (a !== b) return;
    nextExtra[dropKey] = keptAspects[dropKey];
    delete keptAspects[dropKey];
  };
  dropIfSame('Marke', 'Hersteller');
  dropIfSame('Abteilung', 'Zielgruppe');

  const sortedAttrs = normalizeAttributesOrder(
    { ...keptAspects },
    { requiredOrder: requiredAspects, preferredOrder: DEFAULT_ATTRIBUTE_ORDER }
  );

  return {
    ...product,
    details: {
      ...details,
      categoryId: String(catId),
      gpsr: Object.keys(gpsr).length ? gpsr : details.gpsr,
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

  // Best-effort: try to keep titles in the SEO-friendly range (optimal 65–75, hard max 80) by appending technical candidates.
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
    // Normalize brand casing deterministically (UI + title consistency)
    if (mergedIdentification?.brand) {
      const normalizedBrand = normalizeBrandDisplayCase(mergedIdentification.brand, {
        titleHint: mergedIdentification?.name || product?.identification?.name || '',
      });
      if (normalizedBrand) {
        mergedIdentification.brand = normalizedBrand;
      }
    }

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

    // Condition invariants (business rule):
    // - Automated pipelines (Improve/Enrich/Imports/Jobs) must NEVER create/propagate "Gebraucht/Used".
    // - If a non-UI save attempts to persist Zustand=Gebraucht/used (often inferred from titles/marketplaces),
    //   normalize it to "NEU" and clear accidental locks.
    //
    // NOTE: Manual UI saves may still set Zustand explicitly; the lock mechanism exists for that.
    {
      const USED_CONDITION_RE =
        /\b(gebraucht|used|pre[-\s]?owned|second hand|secondhand|b-ware|refurb(?:ished)?|renewed|open box|openbox)\b/i;
      const zustandKey =
        mergedDetails?.attributes && typeof mergedDetails.attributes === 'object'
          ? Object.keys(mergedDetails.attributes).find(
              (k) => String(k || '').trim().toLowerCase() === 'zustand'
            )
          : null;
      if (!isManualSave && zustandKey) {
        const raw = mergedDetails.attributes[zustandKey];
        const val = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
        if (val && USED_CONDITION_RE.test(val)) {
          mergedDetails.attributes[zustandKey] = 'NEU';
          // Clear lock if it was introduced outside UI or if an old lock would keep leaking "Gebraucht" into titles.
          mergedOps.condition_locked = false;
          mergedOps.data_quality = mergedOps.data_quality || {};
          mergedOps.data_quality.condition_normalized_neu_v1 = {
            at_iso: new Date().toISOString(),
            previous: val,
            source: saveSource || (isManualSave ? 'ui' : 'system'),
          };
        }
      }
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

    // Weight invariant:
    // - Always store weight in KG as a NUMBER (no "kg" suffix, no strings).
    // - Never invent a weight if unknown; keep it empty so Quality Gate can flag it.
    const incomingWeight =
      mergedDetails?.attributes?.weight ??
      mergedDetails?.weight ??
      mergedOps?.weight ??
      mergedAttributes?.weight;
    if (!mergedDetails.attributes) mergedDetails.attributes = {};
    const normalizedWeight =
      normalizeWeightKgNumber(incomingWeight) ??
      normalizeWeightKgNumber(existingDetails?.attributes?.weight) ??
      normalizeWeightKgNumber(existingDetails?.weight) ??
      null;
    if (normalizedWeight === null) {
      // Delete invalid/non-normalizable values (never persist "1 kg" or "1000g" strings).
      if (Object.prototype.hasOwnProperty.call(mergedDetails.attributes, 'weight')) {
        delete mergedDetails.attributes.weight;
      }
      if (Object.prototype.hasOwnProperty.call(mergedDetails, 'weight')) {
        delete mergedDetails.weight;
      }
    } else {
      mergedDetails.attributes.weight = normalizedWeight;
      mergedDetails.weight = normalizedWeight;
    }

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

    // Attribute/Parameter consolidation:
    // Apply category-specific alias mappings (from Category Profiles) BEFORE enforceEbayAspects(),
    // so that downstream pipelines (Identify/Improve/Chat/UI saves) stop drifting in key names.
    try {
      const catIdForProfile =
        (mergedDetails.categoryId && String(mergedDetails.categoryId).trim()) ||
        (mergedDetails.ebayCategoryId && String(mergedDetails.ebayCategoryId).trim()) ||
        null;
      const profile = catIdForProfile ? await getCategoryProfileById(catIdForProfile) : null;
      if (profile && profile.enabled) {
        const conflicts = [];
        mergedDetails.attributes = applyAttributeAliasesProfile(
          mergedDetails.attributes || {},
          {
            canonicalAttributes: profile.canonicalAttributes || [],
            attributeAliases: profile.attributeAliases || {},
          },
          {
            onConflict: (c) => {
              if (conflicts.length < 25) conflicts.push(c);
            },
          }
        );
        if (conflicts.length) {
          mergedOps.data_quality = mergedOps.data_quality || {};
          mergedOps.data_quality.attribute_alias_conflict_v1 = {
            at_iso: new Date().toISOString(),
            categoryId: catIdForProfile,
            conflicts,
          };
        }
      }
    } catch (e) {
      console.warn('[saveProduct] category profile attribute normalization failed (non-blocking):', e?.message || e);
    }

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

    // Keep attribute "Marke"/"Hersteller" in sync (case-only) with identification.brand for UI consistency.
    try {
      const brand = normalizeBrandDisplayCase(productWithEbay?.identification?.brand || '', {
        titleHint: productWithEbay?.identification?.name || '',
      });
      if (brand) {
        productWithEbay.identification = productWithEbay.identification || {};
        productWithEbay.identification.brand = brand;
        const attrs =
          productWithEbay?.details?.attributes && typeof productWithEbay.details.attributes === 'object'
            ? productWithEbay.details.attributes
            : null;
        if (attrs) {
          const findKey = (needle) =>
            Object.keys(attrs).find((k) => String(k || '').trim().toLowerCase() === needle) || null;
          const markeKey = findKey('marke');
          if (markeKey && typeof attrs[markeKey] === 'string') {
            const v = String(attrs[markeKey]).trim();
            if (v && v.toLowerCase() === brand.toLowerCase() && v !== brand) {
              attrs[markeKey] = brand;
            }
          }
          const herstellerKey = findKey('hersteller');
          if (herstellerKey && typeof attrs[herstellerKey] === 'string') {
            const v = String(attrs[herstellerKey]).trim();
            if (v && v.toLowerCase() === brand.toLowerCase() && v !== brand) {
              attrs[herstellerKey] = brand;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[saveProduct] brand normalization failed (non-blocking):', e?.message || e);
    }

    // Normalize generated fields consistently across Identify / Improve / Chat saves.
    // - no duplicate highlights
    // - stable, technical title (eBay safe length)
    const normalizedKeyFeatures = sanitizeKeyFeatures(productWithEbay?.details?.key_features || [], { max: 8 });
    const AUTO_TITLE_MIN_LEN = 65;
    const AUTO_TITLE_MAX_LEN = 80;
    const AUTO_TITLE_SOFT_MAX_LEN = 75;
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
        { minLen: AUTO_TITLE_MIN_LEN, maxLen: AUTO_TITLE_MAX_LEN, softMaxLen: AUTO_TITLE_SOFT_MAX_LEN }
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

/**
 * Update product BigCommerce sync status (and optional BigCommerce linkage)
 */
async function updateProductBigCommerceSyncStatus(
  productId,
  status,
  lastSyncedIso = null,
  bigCommerceProductId = undefined
) {
  try {
    const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
    const updateData = {
      'ops.bigcommerce.sync_status': status,
    };

    if (lastSyncedIso) {
      updateData['ops.bigcommerce.last_synced_iso'] = lastSyncedIso;
    }

    if (bigCommerceProductId !== undefined) {
      updateData['ops.bigcommerce.product_id'] = bigCommerceProductId;
    }

    await docRef.update(updateData);
  } catch (error) {
    console.error('Failed to update product BigCommerce sync status:', error);
    throw new Error(`Failed to update BigCommerce sync status: ${error.message}`);
  }
}

async function setProductBigCommerceDisabled(productId, disabled, { reason = '' } = {}) {
  const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(productId);
  const updateData = {
    'ops.bigcommerce.disabled': Boolean(disabled),
  };
  if (disabled) {
    updateData['ops.bigcommerce.disabled_at_iso'] = new Date().toISOString();
    if (reason) updateData['ops.bigcommerce.disabled_reason'] = String(reason).trim();
  } else {
    updateData['ops.bigcommerce.disabled_at_iso'] = null;
    updateData['ops.bigcommerce.disabled_reason'] = null;
  }
  await docRef.update(updateData);
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

async function listOrdersByStatus(status, limit = 200) {
  const normalized = String(status || '').trim();
  if (!normalized) return [];
  const capped = Math.min(Math.max(Number(limit) || 0, 1), 500);
  const snapshot = await firestore
    .collection(ORDERS_COLLECTION)
    .where('status', '==', normalized)
    .limit(capped)
    .get();
  const rows = snapshot.docs.map((doc) => doc.data());
  // Best-effort stable ordering without requiring a composite index.
  rows.sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')));
  return rows;
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

/**
 * Compute mobile dashboard metrics from the orders collection.
 *
 * Notes:
 * - Uses best-effort heuristics for "completed" (picked/shipped/etc.) and "returns".
 * - Returns are detected by statusLabel/status text containing "retour/return/rücksend".
 * - Revenue is derived from totalAmount (best-effort, assumes a single currency).
 */
async function getDashboardMetrics({ days = 7 } = {}) {
  const windowDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(60, Number(days))) : 7;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  windowStart.setUTCDate(windowStart.getUTCDate() - (windowDays - 1));

  const CLOSED_LABELS = new Set([
    'kommissioniert',
    'versendet',
    'zugestellt',
    'shipped',
    'delivered',
    'completed',
    'erledigt',
  ]);
  const CANCEL_LABELS = new Set([
    'storniert',
    'cancelled',
    'canceled',
    'abgebrochen',
  ]);
  const pickedStatusIds = new Set(['363183']); // hard fallback BaseLinker picked status
  const envPickedId = process.env.BASE_ORDER_STATUS_PICKED;
  if (envPickedId) pickedStatusIds.add(String(envPickedId).trim());

  const normalize = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v == null ? '' : String(v).trim().toLowerCase());
  const dayKey = (iso) => {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    } catch {
      return null;
    }
  };
  const isClosed = (order) => {
    const statusId = order?.statusId != null ? String(order.statusId) : null;
    const rawStatus = order?.status || order?.statusLabel || '';
    const s = normalize(rawStatus);
    if (order?.pickedAt) return true;
    if (s === 'picked') return true;
    if (statusId && pickedStatusIds.has(statusId)) return true;
    if (CLOSED_LABELS.has(s)) return true;
    if (s.includes('versendet') || s.includes('zugestellt')) return true;
    return false;
  };
  const isCancelled = (order) => {
    const raw = normalize(order?.statusLabel || order?.status || '');
    if (CANCEL_LABELS.has(raw)) return true;
    return raw.includes('storniert') || raw.includes('cancel');
  };
  const isReturn = (order) => {
    const raw = normalize(order?.statusLabel || order?.status || '');
    return raw.includes('retour') || raw.includes('return') || raw.includes('rücksend') || raw.includes('ruecksend');
  };
  const parseIso = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  // Initialize last-N-days buckets
  const daysArr = [];
  for (let i = 0; i < windowDays; i += 1) {
    const d = new Date(windowStart);
    d.setUTCDate(windowStart.getUTCDate() + i);
    daysArr.push({ date: d.toISOString().slice(0, 10), orders: 0, revenue: 0 });
  }
  const dayIndex = new Map(daysArr.map((d, idx) => [d.date, idx]));

  const snapshot = await firestore.collection(ORDERS_COLLECTION).get();

  let currency = 'EUR';
  let revenueTotal = 0;
  let revenueMonth = 0;
  let revenueAllNonCancelledTotal = 0;
  let completedTotal = 0;
  let completedMonth = 0;
  let returnsTotal = 0;
  let returnsMonth = 0;
  let openCurrent = 0;

  const statusBreakdown = {
    neu: 0,
    kommissioniert: 0,
    versendet: 0,
    zugestellt: 0,
    cancelled: 0,
    other: 0,
  };

  const categorizeStatus = (order) => {
    const raw = normalize(order?.statusLabel || order?.status || '');
    // prefer explicit "new" state if present
    if (order?.status === 'new' || raw.includes('neu') || raw.includes('new')) return 'neu';
    if (raw.includes('kommission') || raw.includes('picked')) return 'kommissioniert';
    if (raw.includes('versendet') || raw.includes('shipped') || raw.includes('dispatched')) return 'versendet';
    if (raw.includes('zugestellt') || raw.includes('delivered')) return 'zugestellt';
    return 'other';
  };

  snapshot.forEach((doc) => {
    const order = doc.data() || {};
    const cur = (order.currency || 'EUR').toString().trim().toUpperCase();
    if (cur) currency = cur;

    const createdAt = parseIso(order.createdAt) || parseIso(order.updatedAt) || null;
    if (!createdAt) return;
    const totalAmount = Number(order.totalAmount || 0) || 0;

    const cancelled = isCancelled(order);
    const returned = isReturn(order);
    const closed = isClosed(order);

    // Status breakdown (for dashboards)
    if (cancelled) {
      statusBreakdown.cancelled += 1;
    } else {
      const cat = categorizeStatus(order);
      statusBreakdown[cat] += 1;
    }

    if (order.status === 'new') {
      openCurrent += 1;
    }

    // Volume (last N days) based on order creation date (incoming order volume)
    const dk = dayKey(createdAt.toISOString());
    if (dk && dayIndex.has(dk)) {
      const idx = dayIndex.get(dk);
      daysArr[idx].orders += 1;
      if (!cancelled) {
        daysArr[idx].revenue += totalAmount;
      }
    }

    // Revenue across ALL orders excluding cancelled (regardless of closed/return)
    if (!cancelled) {
      revenueAllNonCancelledTotal += totalAmount;
    }

    // Returns (best-effort)
    if (returned) {
      returnsTotal += 1;
      if (createdAt >= monthStart) returnsMonth += 1;
    }

    // Completed (picked/shipped/etc.) + revenue based on completion date if available
    if (closed && !cancelled && !returned) {
      completedTotal += 1;
      revenueTotal += totalAmount;
      const completedAt = parseIso(order.pickedAt) || createdAt;
      if (completedAt && completedAt >= monthStart) {
        completedMonth += 1;
        revenueMonth += totalAmount;
      }
    } else if (closed && !cancelled) {
      // still count completion even if return; revenue excluded above
      completedTotal += 1;
      const completedAt = parseIso(order.pickedAt) || createdAt;
      if (completedAt && completedAt >= monthStart) {
        completedMonth += 1;
      }
    }
  });

  const revenueWindowNonCancelledTotal = daysArr.reduce((s, d) => s + (Number(d.revenue || 0) || 0), 0);

  return {
    generated_at_iso: new Date().toISOString(),
    currency,
    revenue: {
      total: Number(revenueTotal.toFixed(2)),
      month: Number(revenueMonth.toFixed(2)),
      month_start_iso: monthStart.toISOString(),
      all_non_cancelled_total: Number(revenueAllNonCancelledTotal.toFixed(2)),
      window_non_cancelled_total: Number(revenueWindowNonCancelledTotal.toFixed(2)),
      window_start_iso: windowStart.toISOString(),
      window_days: windowDays,
    },
    orders: {
      open_current: openCurrent,
      completed_total: completedTotal,
      completed_month: completedMonth,
      returns_total: returnsTotal,
      returns_month: returnsMonth,
      status_breakdown: statusBreakdown,
    },
    volume_7d: {
      window_days: windowDays,
      days: daysArr,
    },
  };
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
  updateProductBigCommerceSyncStatus,
  setProductBigCommerceDisabled,
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
  listOrdersByStatus,
  getOrderSummary,
  getDashboardMetrics,
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