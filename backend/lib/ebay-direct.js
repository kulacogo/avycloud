const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FieldValue } = require('@google-cloud/firestore');

const { firestore, getAllProducts, PRODUCTS_COLLECTION } = require('./firestore');
const { getRequiredAspects, getCategoryAspectCatalog, findEbayCategory } = require('./ebay-taxonomy');

function resolveCategoryNameFromId(categoryId) {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  const id = typeof categoryId === 'number' ? String(categoryId) : String(categoryId).trim();
  if (!/^\d+$/.test(id)) return null;
  const cat = findEbayCategory(id);
  return cat?.breadcrumb || null;
}
const {
  getMyeBaySellingActive,
  getItemDetails,
  getCategoryInfo,
  getCategorySpecifics,
  reviseFixedPriceItem,
  reviseItem,
  addFixedPriceItem,
  verifyAddFixedPriceItem,
} = require('./ebay-trading-api');
const { decodeHtmlEntitiesDeep } = require('./html-entities');

const EBAY_LISTINGS_COLLECTION = 'ebayListingsLive';
const EBAY_LINKS_COLLECTION = 'ebayListingLinks';
const EBAY_GAPS_COLLECTION = 'ebayListingGaps';
const EBAY_REPORTS_COLLECTION = 'ebayListingReports';
const CATEGORY_PROFILES_COLLECTION = 'categoryProfiles';

function safeString(value) {
  return value == null ? '' : String(value).trim();
}

function safeLower(value) {
  return safeString(value).toLowerCase();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tsToIso(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeToken(value) {
  const lower = safeLower(decodeHtmlEntitiesDeep(value))
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
  return lower.replace(/[^a-z0-9]+/g, '');
}

function normalizeSpecificToken(value) {
  const token = normalizeToken(value);
  if (!token) return '';
  // German/English synonyms for required marketplace specifics.
  if (token === 'groesse' || token === 'size') return 'size';
  if (
    token === 'hoehe' ||
    token === 'height' ||
    token === 'dicke' ||
    token === 'staerke' ||
    token === 'materialstaerke' ||
    token === 'thickness'
  ) {
    return 'hoehe';
  }
  // eBay can expose identifiers under multiple marketplace/language labels.
  if (
    token === 'marke' ||
    token === 'brand' ||
    token === 'hersteller' ||
    token === 'manufacturer' ||
    token === 'herstellername' ||
    token === 'manufacturername'
  ) {
    return 'brand';
  }
  if (token === 'herstellernummer' || token === 'manufacturerpartnumber' || token === 'mpn') return 'mpn';
  // eBay can expose GTIN either as EAN or GTIN.
  if (token === 'ean' || token === 'gtin') return 'gtin';
  // Bicycle categories often expose localized variants like "Für Fahrradtyp".
  if (token.includes('fahrradtyp')) return 'fahrradtyp';
  if (token.includes('fahrradgroesse') || token.includes('fahrradsize')) return 'fahrradgroesse';
  return token;
}

function normalizeProfileKey(value) {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

function normalizeDigits(value) {
  return safeString(value).replace(/\D+/g, '');
}

function coerceEbayCategoryId(value) {
  const raw = safeString(value);
  if (!raw) return '';
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  // Common display formats: "Foo (26196)" or "Foo [26196]"
  const paren = trimmed.match(/\((\d{1,10})\)\s*$/);
  if (paren) return paren[1];
  const bracket = trimmed.match(/\[(\d{1,10})\]\s*$/);
  if (bracket) return bracket[1];
  // Conservative fallback: only accept a short digits-only extraction from short strings.
  const digits = trimmed.replace(/\D+/g, '');
  if (/^\d{1,10}$/.test(digits) && trimmed.length <= 70) return digits;
  return '';
}

function isCatalogBasedListing(listing) {
  const pld = listing?.productListingDetails;
  if (!pld || typeof pld !== 'object') return false;
  const id = safeString(
    pld?.ProductReferenceID ||
      pld?.ProductReferenceId ||
      pld?.productReferenceID ||
      pld?.productReferenceId
  );
  if (id) return true;
  // Trading API: GTIN fields can also indicate catalog adoption (EAN/UPC/ISBN)
  const ean = safeString(pld?.EAN || pld?.GTIN || pld?.gtin);
  const upc = safeString(pld?.UPC || pld?.upc);
  const isbn = safeString(pld?.ISBN || pld?.isbn);
  if (ean || upc || isbn) return true;
  // BrandMPN is a catalog identifier only as a pair
  const brand = safeString(pld?.BrandMPN?.Brand);
  const mpn = safeString(pld?.BrandMPN?.MPN);
  if (brand && mpn) return true;
  return false;
}

const TECHNICAL_SPECIFIC_TOKENS = new Set([
  'category',
  'kategorie',
  'categoryid',
  'ebaycategoryid',
  'categorypath',
  'ebaycategorypath',
  'categorybreadcrumb',
  'ebaycategorybreadcrumb',
]);

// K-Typ (TecDoc kType) keys as they appear in product attributes (Baselinker format).
// Values can be canonical pipe-separated entries ("12345|67890" or "12345,note|67890")
// or legacy plain numeric lists ("12345,67890"). They must NOT be sent as ItemSpecifics —
// they belong in ItemCompatibilityList instead.
const KTYPE_SPECIFIC_KEYS = new Set(['k-typ', 'ktyp', 'k typ', 'ktyp id', 'ktypids', 'k-typ id']);

function extractKTypeNumbers(itemSpecifics) {
  const kTypeNumbers = [];
  const seen = new Set();
  const pushUnique = (value) => {
    const n = safeString(value).trim();
    if (!n || !/^\d+$/.test(n)) return;
    if (seen.has(n)) return;
    seen.add(n);
    kTypeNumbers.push(n);
  };
  const parseEntry = (entryRaw) => {
    const entry = safeString(entryRaw).trim();
    if (!entry) return;

    // Legacy fallback: plain numeric comma/semicolon list (without notes).
    if (/^\d+(?:\s*[,;]\s*\d+)+$/.test(entry)) {
      entry
        .split(/[,;]/)
        .map((part) => part.trim())
        .forEach((part) => pushUnique(part));
      return;
    }

    // Canonical K-Typ with optional note: "<id>" or "<id>,<note>".
    const withOptionalNote = entry.match(/^(\d+)(?:\s*,.*)?$/);
    if (withOptionalNote) {
      pushUnique(withOptionalNote[1]);
      return;
    }
  };

  let foundKey = null;
  for (const [key] of Object.entries(itemSpecifics)) {
    if (KTYPE_SPECIFIC_KEYS.has(safeString(key).toLowerCase())) {
      foundKey = key;
      break;
    }
  }
  if (!foundKey) return { kTypeNumbers, foundKey };
  asArray(itemSpecifics[foundKey]).forEach((raw) => {
    const value = safeString(raw);
    if (!value) return;
    if (value.includes('|')) {
      value.split('|').forEach((part) => parseEntry(part));
      return;
    }
    if (/[\r\n]/.test(value)) {
      value.split(/\r?\n/).forEach((part) => parseEntry(part));
      return;
    }
    parseEntry(value);
  });
  return { kTypeNumbers, foundKey };
}

function buildAspectTokenMeta(categoryId) {
  const catalog = getCategoryAspectCatalog(categoryId);
  const rows = Array.isArray(catalog?.aspects) ? catalog.aspects : [];
  const byToken = new Map();
  rows.forEach((row) => {
    const name = safeString(row?.name);
    const token = normalizeSpecificToken(name);
    if (!token) return;
    if (byToken.has(token)) return;
    const applicableTo = Array.isArray(row?.applicableTo) ? row.applicableTo.map((x) => safeString(x)).filter(Boolean) : [];
    const maxLength = typeof row?.maxLength === 'number' && Number.isFinite(row.maxLength) ? row.maxLength : null;
    const itemToAspectCardinality = safeString(row?.itemToAspectCardinality);
    byToken.set(token, {
      name,
      required: Boolean(row?.required),
      applicableTo,
      maxLength,
      itemToAspectCardinality,
    });
  });
  return { catalog, byToken };
}

function sanitizeSpecificValues(valuesRaw, meta) {
  const values = asArray(valuesRaw).map((x) => safeString(x)).filter(Boolean);
  if (!values.length) return [];
  const cardinality = safeString(meta?.itemToAspectCardinality).toUpperCase();
  const maxLength = typeof meta?.maxLength === 'number' && Number.isFinite(meta.maxLength) ? meta.maxLength : null;
  const limited = cardinality && cardinality !== 'MULTI' ? values.slice(0, 1) : values;
  return limited
    .map((v) => {
      const trimmed = safeString(v).replace(/\s+/g, ' ').trim();
      if (!trimmed) return '';
      if (maxLength && trimmed.length > maxLength) return trimmed.slice(0, maxLength).trim();
      return trimmed;
    })
    .filter(Boolean);
}

function filterPatchItemSpecificsForListing({ categoryId, listing, itemSpecifics }) {
  const specifics = itemSpecifics && typeof itemSpecifics === 'object' ? itemSpecifics : {};
  const requestedCategoryId = safeString(categoryId);
  const listingCategoryId =
    coerceEbayCategoryId(listing?.primaryCategoryId) || safeString(listing?.primaryCategoryId);
  const primaryMeta = buildAspectTokenMeta(requestedCategoryId);
  const primaryByToken = primaryMeta?.byToken instanceof Map ? primaryMeta.byToken : new Map();
  const fallbackByToken = (() => {
    if (!listingCategoryId || listingCategoryId === requestedCategoryId) return new Map();
    const fallbackMeta = buildAspectTokenMeta(listingCategoryId);
    return fallbackMeta?.byToken instanceof Map ? fallbackMeta.byToken : new Map();
  })();
  const catalogBased = isCatalogBasedListing(listing);
  const out = {};
  const dropped = [];

  Object.entries(specifics).forEach(([rawKey, rawVals]) => {
    const key = safeString(rawKey);
    if (!key) return;
    const token = normalizeSpecificToken(key);
    if (TECHNICAL_SPECIFIC_TOKENS.has(token)) {
      dropped.push({ key, reason: 'technical' });
      return;
    }
    const primaryTokenMeta = primaryByToken.get(token) || null;
    const fallbackTokenMeta = fallbackByToken.get(token) || null;
    const meta = primaryTokenMeta || fallbackTokenMeta || null;
    if (catalogBased) {
      if (primaryTokenMeta) {
        const applicableTo = Array.isArray(primaryTokenMeta.applicableTo) ? primaryTokenMeta.applicableTo : [];
        // If the requested category's metadata doesn't tell us if this is PRODUCT vs ITEM,
        // fall back to the listing category's metadata when available.
        if (applicableTo.length) {
          const productOnly = applicableTo.includes('PRODUCT') && !applicableTo.includes('ITEM');
          if (productOnly) {
            dropped.push({ key, reason: 'product_aspect' });
            return;
          }
        } else if (fallbackTokenMeta) {
          const fbApplicableTo = Array.isArray(fallbackTokenMeta.applicableTo) ? fallbackTokenMeta.applicableTo : [];
          const productOnly = fbApplicableTo.includes('PRODUCT') && !fbApplicableTo.includes('ITEM');
          if (productOnly) {
            dropped.push({ key, reason: 'product_aspect' });
            return;
          }
        }
      } else if (fallbackTokenMeta) {
        const applicableTo = Array.isArray(fallbackTokenMeta.applicableTo) ? fallbackTokenMeta.applicableTo : [];
        const productOnly = applicableTo.includes('PRODUCT') && !applicableTo.includes('ITEM');
        if (productOnly) {
          dropped.push({ key, reason: 'product_aspect' });
          return;
        }
      }
    }
    const values = sanitizeSpecificValues(rawVals, meta);
    if (!values.length) return;
    out[key] = values;
  });

  return { itemSpecifics: out, dropped, catalogBased, metaCategoryId: requestedCategoryId || null };
}

function cleanUndefined(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => cleanUndefined(item)).filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      const cleaned = cleanUndefined(v);
      if (cleaned !== undefined) {
        out[k] = cleaned;
      }
    });
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((x) => stableStringify(x)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashObject(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function chunk(list, size = 250) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

function mapListingSpecifics(listing) {
  const raw = listing?.itemSpecifics && typeof listing.itemSpecifics === 'object' ? listing.itemSpecifics : {};
  const variationSpecifics =
    listing?.variationSpecificsSet && typeof listing.variationSpecificsSet === 'object' ? listing.variationSpecificsSet : {};
  const pld =
    listing?.productListingDetails && typeof listing.productListingDetails === 'object'
      ? listing.productListingDetails
      : {};
  const out = {};

  const appendValues = (name, value) => {
    const key = safeString(name);
    if (!key) return;
    const values = asArray(value).map((x) => safeString(x)).filter(Boolean);
    if (!values.length) return;
    if (!out[key]) out[key] = [];
    values.forEach((entry) => {
      if (!out[key].includes(entry)) out[key].push(entry);
    });
  };

  Object.entries(raw).forEach(([k, v]) => appendValues(k, v));
  Object.entries(variationSpecifics).forEach(([k, v]) => appendValues(k, v));

  // GetItem can return identifiers under ProductListingDetails instead of ItemSpecifics.
  // Include these in comparison input to avoid false "missing on eBay" gaps.
  appendValues('EAN', pld?.EAN);
  appendValues('GTIN', pld?.GTIN);
  appendValues('UPC', pld?.UPC);
  appendValues('ISBN', pld?.ISBN);
  appendValues('Brand', pld?.BrandMPN?.Brand);
  appendValues('MPN', pld?.BrandMPN?.MPN);
  appendValues('SKU', listing?.sku);

  return out;
}

function normalizeSpecificsMap(map) {
  const out = {};
  Object.entries(map || {}).forEach(([k, v]) => {
    const nk = normalizeSpecificToken(k);
    if (!nk) return;
    const values = asArray(v).map((x) => safeString(x)).filter(Boolean);
    if (!values.length) return;
    out[nk] = values;
  });
  return out;
}

function normalizeProductSpecifics(product) {
  const out = {};
  const append = (name, value) => {
    const key = safeString(name);
    if (!key) return;
    const values = asArray(value).map((x) => safeString(x)).filter(Boolean);
    if (!values.length) return;
    if (!out[key]) out[key] = [];
    values.forEach((entry) => {
      if (!out[key].includes(entry)) out[key].push(entry);
    });
  };
  const candidates = [
    product?.details?.attributes,
    product?.details?.itemSpecifics,
    product?.classification?.attributes,
    product?.marketplace?.ebay?.itemSpecifics,
    product?.itemSpecifics,
  ];
  candidates.forEach((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    Object.entries(candidate).forEach(([k, v]) => {
      append(k, v);
    });
  });

  const id = product?.details?.identifiers || {};

  append('Brand', product?.identification?.brand);
  append('MPN', id?.mpn);
  append('EAN', id?.ean);
  append('GTIN', id?.gtin);
  append('UPC', id?.upc);
  append('SKU', product?.identification?.sku || id?.sku);
  return out;
}

const ALWAYS_RELEVANT_SPECIFIC_TOKENS = new Set(['brand', 'gtin', 'upc', 'isbn', 'mpn', 'sku', 'herstellernummer']);

function applyCategoryProfileAliasesToSpecifics(specifics = {}, categoryProfile = null) {
  if (!specifics || typeof specifics !== 'object') return {};
  const canonicalLowerToExact = new Map();
  asArray(categoryProfile?.canonicalAttributes).forEach((entry) => {
    const exact = normalizeProfileKey(entry);
    if (!exact) return;
    canonicalLowerToExact.set(exact.toLowerCase(), exact);
  });
  const aliasObj =
    categoryProfile?.attributeAliases &&
    typeof categoryProfile.attributeAliases === 'object' &&
    !Array.isArray(categoryProfile.attributeAliases)
      ? categoryProfile.attributeAliases
      : {};
  const aliasLowerToCanonical = new Map();
  Object.entries(aliasObj).forEach(([aliasRaw, canonicalRaw]) => {
    const alias = normalizeProfileKey(aliasRaw).toLowerCase();
    const canonical = normalizeProfileKey(canonicalRaw);
    if (!alias || !canonical) return;
    const canonicalExact = canonicalLowerToExact.get(canonical.toLowerCase()) || canonical;
    aliasLowerToCanonical.set(alias, canonicalExact);
  });

  const out = {};
  const append = (name, values) => {
    const key = normalizeProfileKey(name);
    if (!key) return;
    const list = asArray(values).map((x) => safeString(x)).filter(Boolean);
    if (!list.length) return;
    if (!out[key]) out[key] = [];
    list.forEach((entry) => {
      if (!out[key].includes(entry)) out[key].push(entry);
    });
  };

  Object.entries(specifics).forEach(([rawKey, rawVals]) => {
    const key = normalizeProfileKey(rawKey);
    if (!key) return;
    const lower = key.toLowerCase();
    const canonical =
      aliasLowerToCanonical.get(lower) ||
      canonicalLowerToExact.get(lower) ||
      key;
    append(canonical, rawVals);
  });
  return out;
}

function buildSpecificLabelPolicy({ requiredAspects = [], listingSpecifics = {}, categoryProfile = null } = {}) {
  const byToken = new Map(); // token -> { label, priority }
  const upsert = (labelRaw, priority) => {
    const label = normalizeProfileKey(labelRaw);
    if (!label) return;
    const token = normalizeSpecificToken(label);
    if (!token) return;
    const existing = byToken.get(token);
    if (!existing || priority < existing.priority) {
      byToken.set(token, { label, priority });
    }
  };

  asArray(requiredAspects).forEach((name) => upsert(name, 1));
  Object.keys(listingSpecifics || {}).forEach((name) => upsert(name, 2));
  asArray(categoryProfile?.canonicalAttributes).forEach((name) => upsert(name, 3));
  Object.values(
    categoryProfile?.attributeAliases &&
      typeof categoryProfile.attributeAliases === 'object' &&
      !Array.isArray(categoryProfile.attributeAliases)
      ? categoryProfile.attributeAliases
      : {}
  ).forEach((name) => upsert(name, 3));

  upsert('Marke', 4);
  upsert('EAN', 4);
  upsert('UPC', 4);
  upsert('ISBN', 4);
  upsert('MPN', 4);
  upsert('SKU', 4);
  upsert('Herstellernummer', 4);

  const out = new Map();
  byToken.forEach((entry, token) => out.set(token, entry.label));
  return out;
}

function canonicalizeSpecificKeys(specifics = {}, labelPolicy = new Map()) {
  const out = {};
  const append = (name, values) => {
    const key = normalizeProfileKey(name);
    if (!key) return;
    const list = asArray(values).map((x) => safeString(x)).filter(Boolean);
    if (!list.length) return;
    if (!out[key]) out[key] = [];
    list.forEach((entry) => {
      if (!out[key].includes(entry)) out[key].push(entry);
    });
  };
  Object.entries(specifics || {}).forEach(([rawKey, rawValues]) => {
    const key = normalizeProfileKey(rawKey);
    if (!key) return;
    const token = normalizeSpecificToken(key);
    const canonical = token && labelPolicy.has(token) ? labelPolicy.get(token) : key;
    append(canonical, rawValues);
  });
  return out;
}

function buildRelevantSpecificTokens({ requiredAspects = [], listingSpecifics = {}, categoryProfile = null } = {}) {
  const out = new Set(ALWAYS_RELEVANT_SPECIFIC_TOKENS);
  const add = (rawKey) => {
    const token = normalizeSpecificToken(rawKey);
    if (token) out.add(token);
  };
  asArray(requiredAspects).forEach((name) => add(name));
  Object.keys(listingSpecifics || {}).forEach((name) => add(name));
  asArray(categoryProfile?.canonicalAttributes).forEach((name) => add(name));
  Object.values(
    categoryProfile?.attributeAliases &&
      typeof categoryProfile.attributeAliases === 'object' &&
      !Array.isArray(categoryProfile.attributeAliases)
      ? categoryProfile.attributeAliases
      : {}
  ).forEach((name) => add(name));
  return out;
}

function filterSpecificsByRelevantTokens(specifics = {}, relevantTokens = new Set()) {
  const out = {};
  Object.entries(specifics || {}).forEach(([key, value]) => {
    const token = normalizeSpecificToken(key);
    if (!token) return;
    if (relevantTokens instanceof Set && relevantTokens.size && !relevantTokens.has(token)) {
      return;
    }
    const values = asArray(value).map((x) => safeString(x)).filter(Boolean);
    if (!values.length) return;
    out[key] = values;
  });
  return out;
}

function deriveProductTitle(product) {
  const brand = safeString(product?.identification?.brand);
  const name = safeString(product?.identification?.name);
  // Use product name as-is. Brand is already sent via ItemSpecifics ("Marke"),
  // so prepending it to the title wastes valuable character space (80 char limit).
  let title = name || brand || '';
  if (title && title.length > 80) {
    title = `${title.slice(0, 79).trimEnd()}…`;
  }
  return safeString(title) || null;
}

function deriveProductSubtitle(product) {
  const attrs = product?.details?.attributes || {};
  return (
    safeString(attrs?.SubTitle) ||
    safeString(attrs?.Subtitle) ||
    safeString(attrs?.Untertitel) ||
    safeString(attrs?.sub_title) ||
    null
  );
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeHtmlEntities(value) {
  return decodeHtmlEntitiesDeep(value);
}

function stripHtmlToText(value) {
  return String(value == null ? '' : value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function normalizeComparableRichText(value) {
  return decodeHtmlEntities(stripHtmlToText(value))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBulletLine(value) {
  const text = decodeHtmlEntities(stripHtmlToText(value));
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^[•·*\-–—]+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBulletList(list = []) {
  const out = [];
  const seen = new Set();
  asArray(list).forEach((entry) => {
    const normalized = normalizeBulletLine(entry);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  });
  return out;
}

function parseListItemsFromHtml(html) {
  const source = safeString(html);
  if (!source) return [];
  const items = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match = re.exec(source);
  while (match) {
    const line = normalizeBulletLine(match[1]);
    if (line) items.push(line);
    match = re.exec(source);
  }
  return normalizeBulletList(items);
}

function extractTrendOceanDescriptionParts(descriptionHtml) {
  const raw = safeString(descriptionHtml);
  const out = {
    isTemplate: /START TrendOcean eBay Listing Template/i.test(raw),
    highlights: [],
    descriptionHtml: '',
    descriptionText: '',
  };
  if (!raw) return out;

  const highlightsMatch = raw.match(
    /<div[^>]*class=["'][^"']*section-title[^"']*["'][^>]*>\s*Produkt-Highlights\s*<\/div>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/i
  );
  if (highlightsMatch && highlightsMatch[1]) {
    out.highlights = parseListItemsFromHtml(highlightsMatch[1]);
  }

  const descriptionHeaderMatch = raw.match(
    /<div[^>]*class=["'][^"']*section-title[^"']*["'][^>]*>\s*Produktbeschreibung\s*<\/div>/i
  );
  if (descriptionHeaderMatch && descriptionHeaderMatch.index >= 0) {
    const start = descriptionHeaderMatch.index + descriptionHeaderMatch[0].length;
    const afterHeader = raw.slice(start);
    const beforeCta = afterHeader.split(/<div[^>]*class=["'][^"']*cta[^"']*["'][^>]*>/i)[0] || afterHeader;
    const innerDiv = beforeCta.match(/<div[^>]*>([\s\S]*?)<\/div>/i);
    out.descriptionHtml = safeString(innerDiv ? innerDiv[1] : beforeCta);
  }

  if (!out.descriptionHtml) out.descriptionHtml = raw;
  out.descriptionText = normalizeComparableRichText(out.descriptionHtml);
  return out;
}

function deriveProductHighlights(product) {
  const details = product?.details || {};
  const listCandidates = [
    details?.key_features,
    details?.highlights,
    product?.key_features,
    product?.highlights,
  ];
  const textCandidates = [
    details?.key_features_text,
    details?.highlights_text,
  ];

  const lines = [];
  listCandidates.forEach((candidate) => {
    asArray(candidate).forEach((entry) => {
      const line = normalizeBulletLine(entry);
      if (line) lines.push(line);
    });
  });
  textCandidates.forEach((candidate) => {
    const raw = safeString(candidate);
    if (!raw) return;
    raw
      .split(/\r?\n|\|/)
      .map((line) => normalizeBulletLine(line))
      .filter(Boolean)
      .forEach((line) => lines.push(line));
  });
  return normalizeBulletList(lines);
}

function deriveProductDescription(product) {
  const details = product?.details || {};
  return safeString(details?.short_description) || safeString(details?.description) || null;
}

function deriveProductManufacturer(product, listing = null) {
  const direct =
    safeString(product?.identification?.brand) ||
    safeString(product?.details?.identifiers?.brand) ||
    safeString(product?.details?.brand);
  if (direct) return direct;

  const productSpecifics = normalizeProductSpecifics(product);
  for (const [key, values] of Object.entries(productSpecifics || {})) {
    if (normalizeSpecificToken(key) !== 'brand') continue;
    const first = asArray(values).map((entry) => safeString(entry)).find(Boolean);
    if (first) return first;
  }

  const listingSpecifics = mapListingSpecifics(listing || {});
  for (const [key, values] of Object.entries(listingSpecifics || {})) {
    if (normalizeSpecificToken(key) !== 'brand') continue;
    const first = asArray(values).map((entry) => safeString(entry)).find(Boolean);
    if (first) return first;
  }
  return null;
}

function deriveProductPhotoUrl(product, listing = null) {
  const candidates = [];
  asArray(product?.details?.images).forEach((entry) => {
    if (!entry) return;
    if (typeof entry === 'string') candidates.push(entry);
    if (typeof entry === 'object') {
      candidates.push(entry.url_or_base64);
      candidates.push(entry.url);
      candidates.push(entry.src);
      candidates.push(entry.imageUrl);
    }
  });
  asArray(product?.images).forEach((entry) => {
    if (!entry) return;
    if (typeof entry === 'string') candidates.push(entry);
    if (typeof entry === 'object') {
      candidates.push(entry.url_or_base64);
      candidates.push(entry.url);
      candidates.push(entry.src);
    }
  });
  candidates.push(product?.details?.imageUrl);
  candidates.push(product?.details?.image);
  candidates.push(product?.details?.mainImage);
  candidates.push(product?.details?.main_image);
  candidates.push(product?.marketplace?.ebay?.image);
  candidates.push(product?.marketplace?.ebay?.imageUrl);
  candidates.push(listing?.pictureUrl);
  candidates.push(listing?.galleryUrl);

  const fromDescription = safeString(listing?.description).match(/<img[^>]+src=["']([^"']+)["']/i);
  if (fromDescription && fromDescription[1]) candidates.push(fromDescription[1]);

  return (
    candidates
      .map((entry) => safeString(entry))
      .find((entry) => /^https?:\/\//i.test(entry)) || null
  );
}

const EBAY_PICTURE_URL_MAX_COUNT = 24;
const EBAY_PICTURE_URL_MAX_LEN = 500;
const EBAY_PICTURE_URLS_TOTAL_MAX_LEN = 3975;

function sanitizeEbayPictureUrls(urls = []) {
  const out = [];
  const seen = new Set();
  let total = 0;
  asArray(urls).forEach((raw) => {
    if (out.length >= EBAY_PICTURE_URL_MAX_COUNT) return;
    let url = safeString(raw);
    if (!url) return;
    url = url.replace(/\s/g, '%20');
    // Per Trading API docs: picture URLs must be HTTPS.
    if (!/^https:\/\//i.test(url)) return;
    // Per Trading API docs: semicolons are not allowed.
    if (url.includes(';')) return;
    if (url.length > EBAY_PICTURE_URL_MAX_LEN) return;
    const key = url.toLowerCase();
    if (seen.has(key)) return;
    // Per Trading API docs: total length of all URLs must not exceed 3975 characters.
    if (total + url.length > EBAY_PICTURE_URLS_TOTAL_MAX_LEN) return;
    seen.add(key);
    out.push(url);
    total += url.length;
  });
  return out;
}

function extractProductPictureUrls(product, overrides = {}) {
  const urls = [];
  asArray(overrides.pictureUrls || product?.details?.images).forEach((entry) => {
    if (!entry) return;
    const url = safeString(
      typeof entry === 'string' ? entry : entry?.url_or_base64 || entry?.url || entry?.src || entry?.imageUrl
    );
    if (url) urls.push(url);
  });
  // Include legacy locations too (some products store images outside details.images)
  asArray(product?.images).forEach((entry) => {
    if (!entry) return;
    const url = safeString(
      typeof entry === 'string' ? entry : entry?.url_or_base64 || entry?.url || entry?.src || entry?.imageUrl
    );
    if (url) urls.push(url);
  });
  return sanitizeEbayPictureUrls(urls);
}

function sameStringList(a = [], b = []) {
  const left = asArray(a).map((x) => safeString(x)).filter(Boolean);
  const right = asArray(b).map((x) => safeString(x)).filter(Boolean);
  if (left.length !== right.length) return false;
  return left.every((v, i) => v === right[i]);
}

function buildTrendOceanDescriptionTemplate({ listing, product, titleOverride = null, photoOverride = null, relatedProducts = [] }) {
  const auctionName = safeString(titleOverride) || safeString(listing?.title) || safeString(deriveProductTitle(product));
  const manufacturer = safeString(deriveProductManufacturer(product, listing)) || 'Unbekannt';
  const photo = safeString(photoOverride) || safeString(deriveProductPhotoUrl(product, listing));
  const highlights = deriveProductHighlights(product);
  const highlightItemsHtml = highlights.map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  const rawDescription = safeString(deriveProductDescription(product))
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Build related products HTML (max 5)
  const related = asArray(relatedProducts).slice(0, 5);
  let relatedHtml = '';
  if (related.length >= 2) {
    const cards = related.map((rp) => {
      const rpTitle = safeString(rp.title || deriveProductTitle(rp)).slice(0, 60);
      const rpPhoto = safeString(rp.photo || deriveProductPhotoUrl(rp, null));
      const rpPrice = rp.price ? parseFloat(rp.price).toFixed(2).replace('.', ',') : null;
      const rpItemId = safeString(rp.itemId);
      const rpUrl = rpItemId ? `https://www.ebay.de/itm/${rpItemId}` : '';
      const imgTag = rpPhoto ? `<img src="${escapeHtml(rpPhoto)}" alt="${escapeHtml(rpTitle)}" style="width:100%;aspect-ratio:1/1;object-fit:contain;background:#fafafa;">` : '';
      const priceTag = rpPrice ? `<div style="font-weight:700;font-size:15px;color:#111;margin-top:6px;">${rpPrice} &euro;</div>` : '';
      const titleTag = `<div style="font-size:12px;color:#444;margin-top:4px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(rpTitle)}</div>`;
      const inner = `${imgTag}${priceTag}${titleTag}`;
      if (rpUrl) {
        return `<a href="${escapeHtml(rpUrl)}" target="_blank" style="flex:1 1 140px;max-width:170px;text-decoration:none;color:inherit;">${inner}</a>`;
      }
      return `<div style="flex:1 1 140px;max-width:170px;">${inner}</div>`;
    }).join('');
    relatedHtml = `
  <div class="to-related">
    <div class="to-section-label">Weitere Artikel des Verk\u00e4ufers</div>
    <div class="to-related-grid">
      ${cards}
    </div>
  </div>`;
  }

  return `<!-- START TrendOcean eBay Listing Template -->

<style>
body {
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  color: #1a1a1a;
  line-height: 1.7;
  background: #ffffff;
  margin: 0;
  padding: 0;
  -webkit-font-smoothing: antialiased;
}

.to-wrap {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 16px;
}

/* ── Header ── */
.to-header {
  text-align: center;
  padding: 32px 0 28px;
  margin-bottom: 28px;
  background: #fafafa;
  border-bottom: 2px solid #111;
}

.to-logo {
  display: block;
  margin: 0 auto 16px auto;
  max-width: 1280px;
  width: 100%;
}

.to-tagline {
  font-size: 12px;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: #888;
  margin: 0;
}

/* ── Titel ── */
.to-title {
  font-size: 24px;
  font-weight: 700;
  text-align: center;
  margin: 0 0 28px;
  color: #111;
  letter-spacing: -0.3px;
}

/* ── Produkt-Hero ── */
.to-product {
  display: flex;
  flex-wrap: wrap;
  gap: 32px;
  align-items: flex-start;
  margin-bottom: 36px;
}

.to-product-image {
  flex: 1 1 300px;
  text-align: center;
}

.to-product-image img {
  width: 100%;
  max-width: 280px;
}

.to-product-info {
  flex: 1 1 340px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── Trust-Punkte ── */
.to-trust {
  list-style: none;
  padding: 20px;
  margin: 0;
  background: #fafafa;
  border: 1px solid #eee;
}

.to-trust li {
  padding: 8px 0;
  border-bottom: 1px solid #e8e8e8;
  font-size: 14px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.to-trust li:last-child {
  border-bottom: none;
}

.to-trust-icon {
  flex-shrink: 0;
  font-size: 14px;
  color: #111;
}

/* ── Sektionen ── */
.to-section {
  margin-bottom: 32px;
}

.to-section-label {
  font-size: 12px;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: #111;
  font-weight: 700;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 2px solid #111;
}

.to-section ul {
  padding-left: 18px;
  margin: 0;
}

.to-section li {
  margin-bottom: 6px;
  font-size: 14px;
  line-height: 1.7;
}

.to-section p, .to-section div {
  font-size: 14px;
  line-height: 1.7;
  color: #333;
}

/* ── Verpackungshinweis ── */
.to-packaging {
  background: #fafafa;
  border: 1px solid #eee;
  padding: 18px 20px;
  margin: 32px 0;
  font-size: 13px;
  color: #555;
  line-height: 1.7;
}

.to-packaging-title {
  font-size: 12px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: #111;
  font-weight: 700;
  margin-bottom: 8px;
}

.to-packaging-title span {
  color: #2e7d32;
}

/* ── CTA ── */
.to-cta {
  text-align: center;
  padding: 22px;
  background: #111;
  margin-bottom: 32px;
}

.to-cta-text {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
  margin: 0;
  letter-spacing: 0.5px;
}

/* ── Related ── */
.to-related {
  margin-bottom: 32px;
}

.to-related-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  justify-content: flex-start;
}

/* ── Footer ── */
.to-footer {
  text-align: center;
  padding-top: 18px;
  border-top: 2px solid #111;
  font-size: 11px;
  color: #999;
  letter-spacing: 0.3px;
}
</style>

<div class="to-wrap">

  <div class="to-header">
    <img src="https://storage.googleapis.com/trendocean/desc_logo.png"
         alt="TrendOcean"
         class="to-logo">
    <p class="to-tagline">Qualit\u00e4t \u00b7 Verantwortung \u00b7 Fairness</p>
  </div>

  <h1 class="to-title">${escapeHtml(auctionName)}</h1>

  <div class="to-product">

    <div class="to-product-image">
      <img src="${escapeHtml(photo)}" alt="${escapeHtml(auctionName)}">
    </div>

    <div class="to-product-info">
      <ul class="to-trust">
        <li><span class="to-trust-icon">\u2714</span> <strong>Hersteller</strong> \u2014 ${escapeHtml(manufacturer)}</li>
        <li><span class="to-trust-icon">\u2714</span> <strong>Zustand</strong> \u2014 Neu</li>
        <li><span class="to-trust-icon">\u2714</span> <strong>Versand</strong> \u2014 Schnell &amp; kostenlos aus Deutschland</li>
        <li><span class="to-trust-icon">\u2714</span> <strong>Pr\u00fcfung</strong> \u2014 Manuell kontrolliert</li>
      </ul>
    </div>

  </div>

  <div class="to-section">
    <div class="to-section-label">Produkt-Highlights</div>
    <ul>
      ${highlightItemsHtml}
    </ul>
  </div>

  <div class="to-section">
    <div class="to-section-label">Produktbeschreibung</div>
    <div>
      ${rawDescription}
    </div>
  </div>

  <div class="to-packaging">
    <div class="to-packaging-title"><span>\u267b</span> Hinweis zur Verpackung &amp; Nachhaltigkeit</div>
    Alle Artikel sind neuwertig. Die Originalverpackung kann je nach Lagerhaltung oder Versandweg Gebrauchsspuren aufweisen \u2013 in diesem Fall versenden wir den Artikel neutral verpackt. Im Sinne der Nachhaltigkeit verwenden wir, wo immer m\u00f6glich, bereits gebrauchte Versandkartons wieder. Das \u00e4ndert nichts am Zustand des Artikels.
  </div>

  ${relatedHtml}

  <div class="to-cta">
    <p class="to-cta-text">Jetzt sichern \u2013 nur solange der Vorrat reicht.</p>
  </div>

  <div class="to-footer">
    Markenrechte liegen beim jeweiligen Rechteinhaber. Abbildungen dienen der Veranschaulichung.
  </div>

</div>

<!-- END TrendOcean eBay Listing Template -->`;
}

function deriveProductCategoryId(product) {
  const details = product?.details || {};
  const raw = safeString(details?.categoryId || details?.ebayCategoryId);
  const coerced = coerceEbayCategoryId(raw);
  return coerced || null;
}

function collectListingIdentifiers(listing) {
  const specifics = mapListingSpecifics(listing);
  const out = {
    sku: safeString(listing?.sku) || null,
    eanValues: [],
    gtinValues: [],
    upcValues: [],
    mpnValues: [],
    brandValues: [],
  };
  Object.entries(specifics).forEach(([k, values]) => {
    const key = normalizeToken(k);
    const list = asArray(values).map((v) => safeString(v)).filter(Boolean);
    if (!list.length) return;
    if (key === 'ean') out.eanValues.push(...list);
    if (key === 'gtin') out.gtinValues.push(...list);
    if (key === 'upc') out.upcValues.push(...list);
    if (key === 'mpn' || key === 'herstellernummer') out.mpnValues.push(...list);
    if (key === 'brand' || key === 'marke') out.brandValues.push(...list);
  });
  out.eanValues = Array.from(new Set(out.eanValues));
  out.gtinValues = Array.from(new Set(out.gtinValues));
  out.upcValues = Array.from(new Set(out.upcValues));
  out.mpnValues = Array.from(new Set(out.mpnValues));
  out.brandValues = Array.from(new Set(out.brandValues));
  return out;
}

function listingHashPayload(listing) {
  return {
    itemId: safeString(listing?.itemId),
    sku: safeString(listing?.sku),
    skuIndex: asArray(listing?.skuIndex).map((v) => safeString(v)).filter(Boolean),
    title: safeString(listing?.title),
    subtitle: safeString(listing?.subtitle),
    description: safeString(listing?.description),
    categoryId: safeString(listing?.primaryCategoryId),
    listingType: safeString(listing?.listingType),
    listingStatus: safeString(listing?.listingStatus),
    itemSpecifics: mapListingSpecifics(listing),
    quantityAvailable: toNumber(listing?.quantityAvailable),
    currentPrice: toNumber(listing?.currentPrice),
    currency: safeString(listing?.currency),
  };
}

async function fetchLiveListingsFromEbay({
  maxPages = 10,
  entriesPerPage = 100,
  detailConcurrency = 4,
  timeoutMs = 25000,
} = {}) {
  const concurrency = Math.max(1, Math.min(Number(detailConcurrency) || 4, 10));
  const summary = await fetchLiveListingSummariesFromEbay({ maxPages, entriesPerPage, timeoutMs });
  const uniqueItems = Array.isArray(summary?.listings) ? summary.listings : [];
  const details = [];
  const errors = Array.isArray(summary?.errors) ? summary.errors.slice() : [];
  for (const group of chunk(uniqueItems, concurrency)) {
    const responses = await Promise.all(
      group.map(async (entry) => {
        try {
          const detail = await getItemDetails(entry.itemId, { timeoutMs });
          return {
            ok: true,
            entry,
            data: {
              ...entry,
              ...detail.item,
              itemId: entry.itemId,
            },
          };
        } catch (error) {
          return {
            ok: false,
            entry,
            error: {
              itemId: entry.itemId,
              message: error?.message || String(error),
            },
          };
        }
      })
    );
    responses.forEach((result) => {
      if (result.ok) {
        details.push(result.data);
      } else {
        // GetItem failed — fall back to basic entry from GetMyeBaySelling so the item is
        // not incorrectly deactivated by deactivateListingsMissingFromActiveSet.
        // Basic entry already contains sku, title, viewItemUrl from the listing page.
        if (result.entry) details.push(result.entry);
        errors.push(result.error);
      }
    });
  }

  return {
    listings: details.filter((x) => safeString(x?.itemId)),
    summary: {
      pagesFetched: Number(summary?.summary?.pagesFetched) || 0,
      totalPagesReported: Number(summary?.summary?.totalPagesReported) || 0,
      activeListings: Number(summary?.summary?.activeListings) || uniqueItems.length,
      fetchedDetails: details.length,
      detailErrors: errors.length,
    },
    errors,
  };
}

async function fetchLiveListingSummariesFromEbay({
  maxPages = 10,
  entriesPerPage = 100,
  timeoutMs = 25000,
} = {}) {
  const pages = Math.max(1, Math.min(Number(maxPages) || 10, 200));
  const perPage = Math.max(1, Math.min(Number(entriesPerPage) || 100, 200));

  const activeItems = [];
  let totalPages = 1;
  for (let page = 1; page <= pages; page += 1) {
    const result = await getMyeBaySellingActive({
      pageNumber: page,
      entriesPerPage: perPage,
      timeoutMs,
    });
    totalPages = Math.max(totalPages, Number(result?.pagination?.totalPages) || 1);
    activeItems.push(...(result?.items || []));
    if (page >= totalPages) break;
  }

  const byItemId = new Map();
  activeItems.forEach((item) => {
    if (item?.itemId) byItemId.set(String(item.itemId), item);
  });
  const uniqueItems = Array.from(byItemId.values());

  return {
    listings: uniqueItems.filter((x) => safeString(x?.itemId)),
    summary: {
      pagesFetched: Math.min(totalPages, pages),
      totalPagesReported: totalPages,
      activeListings: uniqueItems.length,
    },
    errors: [],
  };
}

async function upsertLiveListings(listings = [], { runId = null, actor = null } = {}) {
  const cleaned = listings
    .map((listing) => {
      const itemId = safeString(listing?.itemId);
      if (!itemId) return null;
      const primarySku = safeString(listing?.sku);
      const variationSkus = Array.from(
        new Set(asArray(listing?.variationSkus).map((v) => safeString(v)).filter(Boolean))
      );
      const skuIndex = Array.from(new Set([primarySku, ...variationSkus].map((v) => safeString(v)).filter(Boolean)));
      const payload = {
        itemId,
        sku: primarySku || null,
        skuIndex: skuIndex.length ? skuIndex : null,
        variationSkus: variationSkus.length ? variationSkus : null,
        title: safeString(listing?.title) || null,
        subtitle: safeString(listing?.subtitle) || null,
        description: safeString(listing?.description) || null,
        listingType: safeString(listing?.listingType) || null,
        listingStatus: safeString(listing?.listingStatus) || null,
        quantityAvailable: toNumber(listing?.quantityAvailable),
        quantityTotal: toNumber(listing?.quantityTotal),
        bidCount: toNumber(listing?.bidCount),
        inventoryTrackingMethod: safeString(listing?.inventoryTrackingMethod) || null,
        primaryCategoryId: safeString(listing?.primaryCategoryId) || null,
        primaryCategoryName: safeString(listing?.primaryCategoryName) || null,
        viewItemUrl: safeString(listing?.viewItemUrl) || null,
        startTime: safeString(listing?.startTime) || null,
        endTime: safeString(listing?.endTime) || null,
        timeLeft: safeString(listing?.timeLeft) || null,
        location: safeString(listing?.location) || null,
        country: safeString(listing?.country) || null,
        currency: safeString(listing?.currency) || null,
        currentPrice: toNumber(listing?.currentPrice),
        itemSpecifics: mapListingSpecifics(listing),
        productListingDetails: listing?.productListingDetails || null,
      };
      const hash = hashObject(listingHashPayload(payload));
      return { ...payload, snapshotHash: hash };
    })
    .filter(Boolean);

  if (!cleaned.length) {
    return { total: 0, written: 0, changed: 0, unchanged: 0 };
  }

  const refs = cleaned.map((item) => firestore.collection(EBAY_LISTINGS_COLLECTION).doc(item.itemId));
  const existingSnaps = await firestore.getAll(...refs);
  const existingById = new Map();
  existingSnaps.forEach((snap) => {
    if (snap.exists) {
      existingById.set(snap.id, snap.data() || {});
    }
  });

  let written = 0;
  let changed = 0;
  let unchanged = 0;
  const nowIso = new Date().toISOString();
  for (const group of chunk(cleaned, 350)) {
    const batch = firestore.batch();
    group.forEach((item) => {
      const existing = existingById.get(item.itemId) || null;
      const sameHash = safeString(existing?.snapshotHash) === safeString(item.snapshotHash);
      if (sameHash) unchanged += 1;
      else changed += 1;
      const docRef = firestore.collection(EBAY_LISTINGS_COLLECTION).doc(item.itemId);
      const payload = cleanUndefined({
        ...item,
        active: true,
        runId: runId || null,
        source: {
          mode: 'trading_api',
          ingestedAt: nowIso,
          actor: actor || null,
        },
        firstSeenAt: existing?.firstSeenAt || FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
        lastChangedAt: sameHash ? existing?.lastChangedAt || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(docRef, payload, { merge: true });
      written += 1;
    });
    await batch.commit();
  }

  return { total: cleaned.length, written, changed, unchanged };
}

function listingSummaryHashPayload(listing) {
  return {
    itemId: safeString(listing?.itemId),
    sku: safeString(listing?.sku),
    title: safeString(listing?.title),
    subtitle: safeString(listing?.subtitle),
    categoryId: safeString(listing?.primaryCategoryId),
    listingType: safeString(listing?.listingType),
    listingStatus: safeString(listing?.listingStatus),
    quantityAvailable: toNumber(listing?.quantityAvailable),
    quantityTotal: toNumber(listing?.quantityTotal),
    currentPrice: toNumber(listing?.currentPrice?.value ?? listing?.currentPrice),
    currency: safeString(listing?.currency || listing?.currentPrice?.currency),
    viewItemUrl: safeString(listing?.viewItemUrl),
    startTime: safeString(listing?.startTime),
    endTime: safeString(listing?.endTime),
    bidCount: toNumber(listing?.bidCount),
    primaryCategoryName: safeString(listing?.primaryCategoryName),
  };
}

async function upsertLiveListingSummaries(listings = [], { runId = null, actor = null } = {}) {
  const cleaned = listings
    .map((listing) => {
      const itemId = safeString(listing?.itemId);
      if (!itemId) return null;
      const currentPrice = listing?.currentPrice && typeof listing.currentPrice === 'object' ? listing.currentPrice : null;
      const payload = {
        itemId,
        sku: safeString(listing?.sku) || null,
        title: safeString(listing?.title) || null,
        subtitle: safeString(listing?.subtitle) || null,
        listingType: safeString(listing?.listingType) || null,
        listingStatus: safeString(listing?.listingStatus) || null,
        quantityAvailable: toNumber(listing?.quantityAvailable),
        quantityTotal: toNumber(listing?.quantityTotal),
        bidCount: toNumber(listing?.bidCount),
        primaryCategoryId: safeString(listing?.primaryCategoryId) || null,
        primaryCategoryName: safeString(listing?.primaryCategoryName) || null,
        viewItemUrl: safeString(listing?.viewItemUrl) || null,
        startTime: safeString(listing?.startTime) || null,
        endTime: safeString(listing?.endTime) || null,
        currency: safeString(currentPrice?.currency || listing?.currency) || null,
        currentPrice: toNumber(currentPrice?.value ?? listing?.currentPrice),
      };
      const hash = hashObject(listingSummaryHashPayload(payload));
      return { ...payload, snapshotHashSummary: hash };
    })
    .filter(Boolean);

  if (!cleaned.length) {
    return { total: 0, written: 0, changed: 0, unchanged: 0 };
  }

  const refs = cleaned.map((item) => firestore.collection(EBAY_LISTINGS_COLLECTION).doc(item.itemId));
  const existingSnaps = await firestore.getAll(...refs);
  const existingById = new Map();
  existingSnaps.forEach((snap) => {
    if (snap.exists) {
      existingById.set(snap.id, snap.data() || {});
    }
  });

  let written = 0;
  let changed = 0;
  let unchanged = 0;
  const nowIso = new Date().toISOString();
  for (const group of chunk(cleaned, 350)) {
    const batch = firestore.batch();
    group.forEach((item) => {
      const existing = existingById.get(item.itemId) || null;
      const sameHash = safeString(existing?.snapshotHashSummary) === safeString(item.snapshotHashSummary);
      if (sameHash) unchanged += 1;
      else changed += 1;
      const docRef = firestore.collection(EBAY_LISTINGS_COLLECTION).doc(item.itemId);
      // IMPORTANT: Summary sync must not null-out detail fields (description, specifics, pictures, ...)
      // → only write summary-level keys here.
      const payload = cleanUndefined({
        itemId: item.itemId,
        sku: item.sku,
        title: item.title,
        subtitle: item.subtitle,
        listingType: item.listingType,
        listingStatus: item.listingStatus,
        quantityAvailable: item.quantityAvailable,
        quantityTotal: item.quantityTotal,
        bidCount: item.bidCount,
        primaryCategoryId: item.primaryCategoryId,
        primaryCategoryName: item.primaryCategoryName,
        viewItemUrl: item.viewItemUrl,
        startTime: item.startTime,
        endTime: item.endTime,
        currency: item.currency,
        currentPrice: item.currentPrice,
        snapshotHashSummary: item.snapshotHashSummary,
        active: true,
        runId: runId || null,
        source: {
          mode: 'trading_api',
          level: 'summary',
          ingestedAt: nowIso,
          actor: actor || null,
        },
        firstSeenAt: existing?.firstSeenAt || FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
        lastChangedAt: sameHash ? existing?.lastChangedAt || FieldValue.serverTimestamp() : FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      batch.set(docRef, payload, { merge: true });
      written += 1;
    });
    await batch.commit();
  }

  return { total: cleaned.length, written, changed, unchanged };
}

async function syncLiveListingsLight(options = {}) {
  const runId = safeString(options?.runId) || `light-${Date.now()}`;
  const actor = options?.actor || null;
  const maxPages = Number.isFinite(Number(options?.maxPages)) ? Number(options.maxPages) : 50;
  const entriesPerPage = Number.isFinite(Number(options?.entriesPerPage)) ? Number(options.entriesPerPage) : 200;
  const timeoutMs = Number.isFinite(Number(options?.timeoutMs)) ? Number(options.timeoutMs) : 25000;

  const lockRef = firestore.collection('ops').doc('ebayLightSync');
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const lockSnap = await lockRef.get();
  const lock = lockSnap.exists ? lockSnap.data() || {} : {};

  const lastCompletedAtIso = safeString(lock?.lastCompletedAtIso);
  const lastCompletedAtMs = lastCompletedAtIso ? Date.parse(lastCompletedAtIso) : NaN;
  const running = Boolean(lock?.running);
  const runningAtIso = safeString(lock?.runningAtIso);
  const runningAtMs = runningAtIso ? Date.parse(runningAtIso) : NaN;

  if (running && Number.isFinite(runningAtMs) && runningAtMs > now - 3 * 60_000) {
    return { skipped: true, reason: 'running', runningAtIso, runId };
  }
  const cooldownMs = parseInt(process.env.EBAY_LIGHT_SYNC_COOLDOWN_MS || String(10 * 60_000), 10); // 10 min default (was 1 min)
  if (Number.isFinite(lastCompletedAtMs) && lastCompletedAtMs > now - cooldownMs) {
    return { skipped: true, reason: 'cooldown', lastCompletedAtIso, runId };
  }

  await lockRef.set(
    cleanUndefined({
      running: true,
      runningRunId: runId,
      runningAtIso: nowIso,
      runningActor: actor || null,
      updatedAt: FieldValue.serverTimestamp(),
    }),
    { merge: true }
  );

  try {
    const ingest = await fetchLiveListingSummariesFromEbay({ maxPages, entriesPerPage, timeoutMs });
    const upsert = await upsertLiveListingSummaries(ingest.listings, { runId, actor });
    const ingestPagesFetched = Number(ingest?.summary?.pagesFetched) || 0;
    const ingestTotalPages = Number(ingest?.summary?.totalPagesReported) || 0;
    const ingestIsComplete = ingestPagesFetched > 0 && ingestTotalPages > 0 && ingestPagesFetched >= ingestTotalPages;
    const deactivation = ingestIsComplete
      ? await deactivateListingsMissingFromActiveSet({
          activeItemIds: ingest.listings.map((x) => safeString(x?.itemId)).filter(Boolean),
          runId,
          actor,
        })
      : {
          scanned: 0,
          deactivated: 0,
          keptActive: 0,
          skipped: true,
          reason: 'partial_ingest_window',
          pagesFetched: ingestPagesFetched,
          totalPagesReported: ingestTotalPages,
        };

    const summary = {
      runId,
      actor,
      generatedAt: new Date().toISOString(),
      mode: 'light_sync',
      ingest: ingest.summary,
      upsert,
      deactivation,
    };

    await lockRef.set(
      cleanUndefined({
        running: false,
        lastCompletedAtIso: new Date().toISOString(),
        lastCompletedRunId: runId,
        lastSummary: summary,
        lastError: null,
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );

    return summary;
  } catch (error) {
    await lockRef.set(
      cleanUndefined({
        running: false,
        lastError: { message: error?.message || String(error), atIso: new Date().toISOString(), runId },
        updatedAt: FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );
    throw error;
  }
}

async function deactivateListingsMissingFromActiveSet({ activeItemIds = [], runId = null, actor = null } = {}) {
  const keepSet = new Set(asArray(activeItemIds).map((id) => safeString(id)).filter(Boolean));
  const snapshot = await firestore.collection(EBAY_LISTINGS_COLLECTION).where('active', '==', true).get();
  const docs = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
  if (!docs.length) {
    return { scanned: 0, deactivated: 0, keptActive: 0 };
  }

  // ── Safety threshold: refuse to deactivate >20% of active listings ──
  // Prevents mass deactivation from partial/rate-limited API responses.
  const MAX_DEACTIVATION_RATIO = 0.20;
  const wouldDeactivate = docs.filter((d) => !keepSet.has(safeString(d?.id))).length;
  const ratio = docs.length > 0 ? wouldDeactivate / docs.length : 0;

  if (ratio > MAX_DEACTIVATION_RATIO && wouldDeactivate > 5) {
    console.warn(
      `[ebay-deactivation] BLOCKED: would deactivate ${wouldDeactivate}/${docs.length} (${(ratio * 100).toFixed(1)}%) — exceeds safety threshold of ${MAX_DEACTIVATION_RATIO * 100}%. activeSet=${keepSet.size}, runId=${runId}`
    );
    return {
      scanned: docs.length,
      deactivated: 0,
      keptActive: docs.length,
      blocked: true,
      reason: 'safety_threshold_exceeded',
      wouldHaveDeactivated: wouldDeactivate,
      ratio: Math.round(ratio * 100),
      activeSetSize: keepSet.size,
    };
  }

  let scanned = 0;
  let deactivated = 0;
  const nowIso = new Date().toISOString();
  for (const group of chunk(docs, 350)) {
    const batch = firestore.batch();
    let touched = 0;
    group.forEach((doc) => {
      scanned += 1;
      const itemId = safeString(doc?.id);
      if (!itemId || keepSet.has(itemId)) return;
      touched += 1;
      deactivated += 1;
      batch.set(
        firestore.collection(EBAY_LISTINGS_COLLECTION).doc(itemId),
        cleanUndefined({
          active: false,
          runId: runId || null,
          inactiveAt: FieldValue.serverTimestamp(),
          inactiveAtIso: nowIso,
          deactivation: {
            reason: 'not_in_active_list',
            actor: actor || null,
            runId: runId || null,
            at: nowIso,
          },
          updatedAt: FieldValue.serverTimestamp(),
        }),
        { merge: true }
      );
    });
    if (touched > 0) {
      await batch.commit();
    }
  }

  return {
    scanned,
    deactivated,
    keptActive: Math.max(0, scanned - deactivated),
  };
}

/**
 * Repair: reactivate listings that were wrongly deactivated.
 * Targets listings with `active: false` AND `deactivation.reason: 'not_in_active_list'`.
 * The `not_in_active_list` reason means the listing was deactivated because it wasn't
 * in the fetched active set — but that set was incomplete due to pagination/rate limits.
 * Only skips listings with explicitly ended/completed status.
 */
async function reactivateWronglyDeactivatedListings({ runId = null, actor = null } = {}) {
  const snapshot = await firestore.collection(EBAY_LISTINGS_COLLECTION)
    .where('active', '==', false)
    .get();

  const docs = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
  let repaired = 0;
  let skipped = 0;
  const nowIso = new Date().toISOString();

  // Statuses that mean the listing is truly ended on eBay — don't reactivate these
  const TRULY_ENDED = new Set(['completed', 'ended', 'deleted', 'cancelled']);

  for (const group of chunk(docs, 350)) {
    const batch = firestore.batch();
    let touched = 0;
    group.forEach((doc) => {
      const data = doc.data() || {};
      const listingStatus = safeString(data.listingStatus).toLowerCase();
      const reason = safeString(data.deactivation?.reason);

      // Reactivate if deactivated by the automated not_in_active_list logic
      // UNLESS the listing has an explicitly ended/completed status
      if (reason === 'not_in_active_list' && !TRULY_ENDED.has(listingStatus)) {
        touched += 1;
        repaired += 1;
        batch.set(
          firestore.collection(EBAY_LISTINGS_COLLECTION).doc(doc.id),
          cleanUndefined({
            active: true,
            reactivation: {
              reason: 'repair_wrongly_deactivated',
              previousDeactivation: data.deactivation || null,
              actor: actor || null,
              runId: runId || null,
              at: nowIso,
            },
            updatedAt: FieldValue.serverTimestamp(),
          }),
          { merge: true }
        );
      } else {
        skipped += 1;
      }
    });
    if (touched > 0) {
      await batch.commit();
    }
  }

  console.log(`[ebay-repair] Reactivated ${repaired} wrongly deactivated listings, skipped ${skipped}`);
  return { repaired, skipped, runId };
}

async function listLiveListings({
  limit = 100,
  search = '',
  matchStatus = '',
  includeInactive = false,
} = {}) {
  const safeLimit = Math.max(1, Number(limit) || 100);
  let query = firestore.collection(EBAY_LISTINGS_COLLECTION).limit(safeLimit);
  if (!includeInactive) {
    query = query.where('active', '==', true);
  }
  const snapshot = await query.get();
  const listings = snapshot.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));
  const ids = listings.map((x) => x.itemId).filter(Boolean);

  // Firestore getAll() supports max 500 refs per call — batch if needed
  const batchGetAll = async (refs) => {
    if (!refs.length) return [];
    const BATCH = 500;
    if (refs.length <= BATCH) return firestore.getAll(...refs);
    const results = [];
    for (let i = 0; i < refs.length; i += BATCH) {
      const chunk = refs.slice(i, i + BATCH);
      const docs = await firestore.getAll(...chunk);
      results.push(...docs);
    }
    return results;
  };
  const linkRefs = ids.map((id) => firestore.collection(EBAY_LINKS_COLLECTION).doc(id));
  const gapRefs = ids.map((id) => firestore.collection(EBAY_GAPS_COLLECTION).doc(id));
  const [linkDocs, gapDocs] = await Promise.all([
    batchGetAll(linkRefs),
    batchGetAll(gapRefs),
  ]);

  const linkMap = new Map();
  const gapMap = new Map();
  linkDocs.forEach((doc) => linkMap.set(doc.id, doc.exists ? doc.data() || null : null));
  gapDocs.forEach((doc) => gapMap.set(doc.id, doc.exists ? doc.data() || null : null));

  // 4) Batch-fetch linked products from products_v2 for warehouse stock enrichment
  const uniqueProductIds = [...new Set(
    [...linkMap.values()]
      .filter((v) => v?.productId)
      .map((v) => String(v.productId))
  )];
  const productMap = new Map();
  if (uniqueProductIds.length > 0) {
    const prodRefs = uniqueProductIds.map((id) => firestore.collection('products_v2').doc(id));
    const prodDocs = await batchGetAll(prodRefs);
    prodDocs.forEach((doc) => {
      if (doc.exists) productMap.set(doc.id, doc.data() || {});
    });
    // BUG-070: storageBins/storage are written to `products` (legacy) by warehouse.js,
    // not to products_v2. Merge BIN data from legacy collection so listings show BIN codes.
    const legacyRefs = uniqueProductIds.map((id) => firestore.collection('products').doc(id));
    const legacyDocs = await batchGetAll(legacyRefs);
    legacyDocs.forEach((doc) => {
      if (!doc.exists) return;
      const ld = doc.data() || {};
      const existing = productMap.get(doc.id);
      if (existing && !existing.storageBins && (ld.storageBins || ld.storage)) {
        existing.storageBins = ld.storageBins || [];
        existing.storage = ld.storage || null;
      }
    });
  }

  // ── BUG-070 Diagnostics ──
  let _diagTotal = 0, _diagLinked = 0, _diagWithBins = 0, _diagWithInv = 0, _diagWithMpQty = 0, _diagWithStock = 0, _diagWithBin = 0;
  const _diagUnmatched = [];
  const _diagBinDebug = [];

  const filteredSearch = safeLower(search);
  const rows = listings
    .map((listing) => {
      const link = linkMap.get(listing.itemId) || null;
      const gapDoc = gapMap.get(listing.itemId) || null;
      const gaps = Array.isArray(gapDoc?.gaps) ? gapDoc.gaps : [];
      const severityCritical = gaps.filter((g) => safeLower(g?.severity) === 'critical').length;
      const readyCount = gaps.filter((g) => safeLower(g?.status) === 'ready_to_sync').length;

      // Warehouse stock enrichment
      const prodId = link?.productId ? String(link.productId) : null;
      const prod = prodId ? productMap.get(prodId) || null : null;
      const bins = Array.isArray(prod?.storageBins) ? prod.storageBins : [];
      const binsExist = bins.length > 0;
      const binsTotal = binsExist ? bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0) : null;
      const fallbackQty = typeof prod?.inventory?.availableQuantity === 'number' ? prod.inventory.availableQuantity
        : (typeof prod?.inventory?.quantity === 'number' ? prod.inventory.quantity : null);
      // Last resort: use eBay's own quantityAvailable when no product match exists
      const ebayQty = typeof listing.quantityAvailable === 'number' ? listing.quantityAvailable : null;
      const whStock = binsTotal !== null ? binsTotal : (fallbackQty !== null ? fallbackQty : ebayQty);

      // Diagnostics
      _diagTotal++;
      if (prod) _diagLinked++;
      if (binsExist) _diagWithBins++;
      if (fallbackQty !== null) _diagWithInv++;
      if (ebayQty !== null) _diagWithMpQty++;
      if (typeof whStock === 'number') _diagWithStock++;
      if (!link && _diagUnmatched.length < 5) _diagUnmatched.push({ itemId: listing.itemId, title: (listing.title || '').slice(0, 60) });

      // BIN location: check all known field paths in products_v2
      const binLoc = (binsExist ? (bins[0]?.code || bins[0]?.binCode || null) : null)
        || prod?.storage?.binCode
        || prod?.binCode
        || null;
      if (binLoc) _diagWithBin++;
      // Debug: log bin field paths for first 5 matched products
      if (prod && _diagBinDebug.length < 5) {
        _diagBinDebug.push({
          id: prodId,
          'storage.binCode': prod?.storage?.binCode || null,
          'storageBins[0].code': bins[0]?.code || null,
          binCode: prod?.binCode || null,
          binsLen: bins.length,
        });
      }
      const mpQty = typeof listing.quantityAvailable === 'number' ? listing.quantityAvailable : null;
      const mismatch = typeof whStock === 'number' && mpQty !== null && whStock !== mpQty;

      return {
        itemId: listing.itemId,
        sku: listing.sku || null,
        title: listing.title || null,
        subtitle: listing.subtitle || null,
        listingType: listing.listingType || null,
        listingStatus: listing.listingStatus || null,
        active: Boolean(listing.active),
        primaryCategoryId: listing.primaryCategoryId || null,
        productId: link?.productId || null,
        matchStatus: link?.status || 'unmatched',
        matchMethod: link?.method || null,
        matchConfidence: typeof link?.confidence === 'number' ? link.confidence : null,
        gapCount: gaps.length,
        gapCriticalCount: severityCritical,
        gapReadyCount: readyCount,
        gapDocUpdatedAt: tsToIso(gapDoc?.updatedAt) || gapDoc?.updatedAt || null,
        updatedAt: tsToIso(listing.updatedAt) || listing.updatedAt || tsToIso(listing.lastSeenAt) || tsToIso(listing.lastChangedAt) || null,
        viewItemUrl: listing.viewItemUrl || null,
        currentPrice: typeof listing.currentPrice === 'number' ? listing.currentPrice : null,
        currency: listing.currency || null,
        quantityAvailable: typeof listing.quantityAvailable === 'number' ? listing.quantityAvailable : null,
        categoryName: listing.categoryName || listing.primaryCategoryName || resolveCategoryNameFromId(listing.primaryCategoryId) || prod?.identification?.category || null,
        warehouseStock: typeof whStock === 'number' ? whStock : null,
        binLocation: binLoc,
        stockMismatch: mismatch,
      };
    })
    .filter((row) => {
      if (filteredSearch) {
        const hay = [row.itemId, row.sku, row.title, row.primaryCategoryId]
          .map((x) => safeLower(x))
          .join(' ');
        if (!hay.includes(filteredSearch)) return false;
      }
      if (matchStatus && safeLower(row.matchStatus) !== safeLower(matchStatus)) return false;
      return true;
    })
    .sort((a, b) => {
      const aMs = Date.parse(String(a?.updatedAt || ''));
      const bMs = Date.parse(String(b?.updatedAt || ''));
      if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) return bMs - aMs;
      return safeString(b?.itemId).localeCompare(safeString(a?.itemId));
    });

  // BUG-070 diagnostic log
  console.info(`[eBay Listings] Total: ${_diagTotal}, Linked: ${_diagLinked} (${_diagTotal ? Math.round(_diagLinked / _diagTotal * 100) : 0}%), WithBins: ${_diagWithBins}, WithInv: ${_diagWithInv}, WithMpQty: ${_diagWithMpQty}, WithStock: ${_diagWithStock}, WithBinLoc: ${_diagWithBin}`);
  if (_diagUnmatched.length > 0) {
    console.info(`[eBay Listings] First ${_diagUnmatched.length} unmatched:`, _diagUnmatched.map(u => `${u.itemId}: ${u.title}`).join(' | '));
  }
  if (_diagBinDebug.length > 0) {
    console.info('[eBay Listings] BIN debug (first 5 matched):', JSON.stringify(_diagBinDebug));
  }

  return rows;
}

async function getListingDetail(itemId) {
  const key = safeString(itemId);
  if (!key) return null;
  const [listingSnap, linkSnap, gapSnap] = await Promise.all([
    firestore.collection(EBAY_LISTINGS_COLLECTION).doc(key).get(),
    firestore.collection(EBAY_LINKS_COLLECTION).doc(key).get(),
    firestore.collection(EBAY_GAPS_COLLECTION).doc(key).get(),
  ]);
  if (!listingSnap.exists) return null;
  const link = linkSnap.exists ? linkSnap.data() || null : null;
  let product = null;
  if (link?.productId) {
    const productSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(String(link.productId)).get();
    if (productSnap.exists) {
      product = { ...(productSnap.data() || {}), id: productSnap.id };
    }
  }
  return {
    listing: { ...(listingSnap.data() || {}), itemId: key },
    link,
    product,
    gaps: gapSnap.exists ? gapSnap.data() || null : null,
  };
}

function buildProductIndexes(products = []) {
  const sku = new Map();
  const digits = new Map();
  const brandMpn = new Map();
  const productById = new Map();

  const addToMap = (map, key, productId) => {
    if (!key || !productId) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(productId);
  };

  products.forEach((product) => {
    const productId = safeString(product?.id);
    if (!productId) return;
    productById.set(productId, product);
    const identifiers = product?.details?.identifiers || {};

    const skuCandidates = [
      product?.identification?.sku,
      identifiers?.sku,
      ...(Array.isArray(product?.ops?.identity_aliases) ? product.ops.identity_aliases : []),
    ];
    skuCandidates.forEach((candidate) => {
      const key = normalizeToken(candidate);
      if (key) addToMap(sku, key, productId);
    });

    const digitCandidates = [
      identifiers?.ean,
      identifiers?.gtin,
      identifiers?.upc,
      ...(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : []),
    ];
    digitCandidates.forEach((candidate) => {
      const key = normalizeDigits(candidate);
      if (key) addToMap(digits, key, productId);
    });

    const brand = normalizeToken(product?.identification?.brand);
    const mpn = normalizeToken(identifiers?.mpn);
    if (brand && mpn) {
      addToMap(brandMpn, `${brand}::${mpn}`, productId);
    }
  });

  const normalizeMap = (map) => {
    const out = new Map();
    map.forEach((set, key) => out.set(key, Array.from(set)));
    return out;
  };

  return {
    sku: normalizeMap(sku),
    digits: normalizeMap(digits),
    brandMpn: normalizeMap(brandMpn),
    productById,
  };
}

function pickBestCandidates(candidates = []) {
  const unique = Array.from(new Set(candidates.filter(Boolean)));
  return unique;
}

function chooseMatchFromCandidates(candidates = [], method = 'none') {
  const unique = pickBestCandidates(candidates);
  if (!unique.length) {
    return { status: 'unmatched', productId: null, candidateProductIds: [], confidence: 0, method };
  }
  if (unique.length === 1) {
    const confidenceByMethod = {
      sku: 0.99,
      identifier: 0.92,
      brand_mpn: 0.82,
      none: 0.5,
    };
    return {
      status: 'matched',
      productId: unique[0],
      candidateProductIds: unique,
      confidence: confidenceByMethod[method] || 0.8,
      method,
    };
  }
  return {
    status: 'ambiguous',
    productId: null,
    candidateProductIds: unique,
    confidence: 0.4,
    method,
  };
}

function collectIdentifierCandidates(indexes, identifiers) {
  const hits = [];
  [...identifiers.eanValues, ...identifiers.gtinValues, ...identifiers.upcValues].forEach((value) => {
    const key = normalizeDigits(value);
    if (!key) return;
    const products = indexes.digits.get(key) || [];
    hits.push(...products);
  });
  return hits;
}

function collectBrandMpnCandidates(indexes, identifiers) {
  const hits = [];
  identifiers.brandValues.forEach((brand) => {
    identifiers.mpnValues.forEach((mpn) => {
      const key = `${normalizeToken(brand)}::${normalizeToken(mpn)}`;
      if (!key || key === '::') return;
      const products = indexes.brandMpn.get(key) || [];
      hits.push(...products);
    });
  });
  return hits;
}

async function buildProductListingLinks({ itemIds = null, runId = null, actor = null } = {}) {
  const allListingsSnapshot = itemIds?.length
    ? await firestore.getAll(
        ...itemIds.map((id) => firestore.collection(EBAY_LISTINGS_COLLECTION).doc(String(id)))
      )
    : await firestore.collection(EBAY_LISTINGS_COLLECTION).where('active', '==', true).get();

  const listings = Array.isArray(allListingsSnapshot.docs)
    ? allListingsSnapshot.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }))
    : allListingsSnapshot
        .filter((doc) => doc?.exists)
        .map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));

  if (!listings.length) {
    return { total: 0, matched: 0, ambiguous: 0, unmatched: 0 };
  }

  const products = await getAllProducts();
  const indexes = buildProductIndexes(products);
  const nowIso = new Date().toISOString();

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;

  for (const group of chunk(listings, 350)) {
    const batch = firestore.batch();
    group.forEach((listing) => {
      const itemId = safeString(listing.itemId);
      if (!itemId) return;
      const identifiers = collectListingIdentifiers(listing);
      const skuKey = normalizeToken(identifiers.sku);

      let decision = null;
      let evidence = null;

      const skuCandidates = skuKey ? indexes.sku.get(skuKey) || [] : [];
      if (skuCandidates.length) {
        decision = chooseMatchFromCandidates(skuCandidates, 'sku');
        evidence = { sku: identifiers.sku };
      }
      if (!decision || decision.status !== 'matched') {
        const idCandidates = collectIdentifierCandidates(indexes, identifiers);
        if (idCandidates.length) {
          decision = chooseMatchFromCandidates(idCandidates, 'identifier');
          evidence = {
            ean: identifiers.eanValues,
            gtin: identifiers.gtinValues,
            upc: identifiers.upcValues,
          };
        }
      }
      if (!decision || decision.status !== 'matched') {
        const bmCandidates = collectBrandMpnCandidates(indexes, identifiers);
        if (bmCandidates.length) {
          decision = chooseMatchFromCandidates(bmCandidates, 'brand_mpn');
          evidence = {
            brand: identifiers.brandValues,
            mpn: identifiers.mpnValues,
          };
        }
      }
      if (!decision) {
        decision = chooseMatchFromCandidates([], 'none');
        evidence = {};
      }

      if (decision.status === 'matched') matched += 1;
      else if (decision.status === 'ambiguous') ambiguous += 1;
      else unmatched += 1;

      const docRef = firestore.collection(EBAY_LINKS_COLLECTION).doc(itemId);
      const payload = cleanUndefined({
        itemId,
        listingSku: listing.sku || null,
        status: decision.status,
        method: decision.method,
        confidence: decision.confidence,
        productId: decision.productId,
        candidateProductIds: decision.candidateProductIds,
        evidence,
        actor: actor || null,
        runId: runId || null,
        updatedAt: FieldValue.serverTimestamp(),
        updatedAtIso: nowIso,
      });
      batch.set(docRef, payload, { merge: true });
    });
    await batch.commit();
  }

  return {
    total: listings.length,
    matched,
    ambiguous,
    unmatched,
  };
}

function createGapId(type, field) {
  return `${safeLower(type)}:${normalizeToken(field) || 'general'}`;
}

function normalizeComparableText(value) {
  return safeLower(value).replace(/\s+/g, ' ').trim();
}

function toFlatText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((x) => safeString(x)).filter(Boolean).join(' | ');
  return safeString(value);
}

function diffSpecificValues(a = [], b = []) {
  const aa = Array.from(new Set(asArray(a).map((x) => safeString(x)).filter(Boolean)));
  const bb = Array.from(new Set(asArray(b).map((x) => safeString(x)).filter(Boolean)));
  const missingOnEbay = aa.filter((x) => !bb.includes(x));
  const extraOnEbay = bb.filter((x) => !aa.includes(x));
  return { missingOnEbay, extraOnEbay };
}

function addGap(gaps, existingById, gap) {
  const id = createGapId(gap.type, gap.field);
  const signature = hashObject({
    type: gap.type,
    field: gap.field,
    listingValue: gap.listingValue,
    avyValue: gap.avyValue,
    suggestion: gap.suggestion || null,
  });

  const existing = existingById.get(id) || null;
  const keepStatus = existing && safeString(existing?.signature) === signature;
  const status = keepStatus ? safeString(existing.status) || 'new' : 'new';
  const history = Array.isArray(existing?.history) ? existing.history.slice(-30) : [];

  gaps.push(
    cleanUndefined({
      id,
      type: gap.type,
      field: gap.field,
      severity: gap.severity || 'info',
      status,
      listingValue: gap.listingValue ?? null,
      avyValue: gap.avyValue ?? null,
      message: gap.message || null,
      suggestion: gap.suggestion || null,
      syncDirection: gap.syncDirection || 'accept_avy',
      signature,
      updatedAt: new Date().toISOString(),
      history,
    })
  );
}

const IDENTIFIER_GROUP_BY_TOKEN = new Map([
  ['gtin', 'gtin'],
  ['upc', 'gtin'],
  ['isbn', 'isbn'],
  ['mpn', 'mpn'],
  ['sku', 'sku'],
  ['brand', 'brand'],
]);

function specificConceptToken(token) {
  const t = safeString(token).toLowerCase();
  if (!t) return '';
  if (t.includes('gewicht') || t.includes('weight')) return 'weight';
  if (t.includes('farbe') || t.includes('color') || t.includes('colour')) return 'color';
  if (t.includes('grose') || t.includes('grsse') || t.includes('size') || t.includes('schuhgrose')) return 'size';
  if (t.includes('zustand') || t.includes('condition')) return 'condition';
  if (t.includes('material')) return 'material';
  return '';
}

function splitKeyWords(value) {
  return safeLower(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isRenameCandidateCompatible(fromKey, fromToken, toKey, toToken) {
  if (!fromToken || !toToken) return false;
  if (fromToken === toToken) return false;

  const fromIdentifierGroup = IDENTIFIER_GROUP_BY_TOKEN.get(fromToken) || null;
  const toIdentifierGroup = IDENTIFIER_GROUP_BY_TOKEN.get(toToken) || null;
  if (fromIdentifierGroup || toIdentifierGroup) {
    return Boolean(fromIdentifierGroup && toIdentifierGroup && fromIdentifierGroup === toIdentifierGroup);
  }

  const fromConcept = specificConceptToken(fromToken);
  const toConcept = specificConceptToken(toToken);
  if (fromConcept || toConcept) {
    return Boolean(fromConcept && toConcept && fromConcept === toConcept);
  }

  const fromWords = new Set(splitKeyWords(fromKey));
  const toWords = splitKeyWords(toKey);
  return toWords.some((word) => fromWords.has(word));
}

function buildRenameSuggestionGap(productSpecifics, listingSpecifics, relevantTokens = null) {
  const suggestions = [];
  const listingNorm = normalizeSpecificsMap(listingSpecifics);
  const listingLabelByToken = new Map();
  Object.keys(listingSpecifics || {}).forEach((name) => {
    const token = normalizeSpecificToken(name);
    if (!token) return;
    if (!listingLabelByToken.has(token)) {
      listingLabelByToken.set(token, safeString(name) || token);
    }
  });

  Object.entries(productSpecifics).forEach(([prodKey, prodVals]) => {
    const prodNorm = normalizeSpecificToken(prodKey);
    if (!prodNorm) return;
    if (relevantTokens instanceof Set && relevantTokens.size && !relevantTokens.has(prodNorm)) return;
    const listingExactExists = Object.keys(listingSpecifics).some((k) => normalizeSpecificToken(k) === prodNorm);
    if (listingExactExists) return;

    const valueToken = normalizeToken(toFlatText(prodVals));
    if (!valueToken) return;
    Object.entries(listingNorm).forEach(([listKeyNorm, listVals]) => {
      const listValueToken = normalizeToken(toFlatText(listVals));
      if (!listValueToken) return;
      if (valueToken !== listValueToken) return;
      const toLabel = listingLabelByToken.get(listKeyNorm) || listKeyNorm;
      if (!isRenameCandidateCompatible(prodKey, prodNorm, toLabel, listKeyNorm)) return;
      suggestions.push({
        from: prodKey,
        to: toLabel,
      });
    });
  });
  const unique = new Map();
  suggestions.forEach((entry) => {
    const from = safeString(entry?.from);
    const to = safeString(entry?.to);
    if (!from || !to) return;
    const key = `${from}::${to}`;
    if (!unique.has(key)) unique.set(key, { from, to });
  });
  return Array.from(unique.values());
}

function buildGapsForListing({ listing, link, product, existingGapDoc, categoryProfile = null }) {
  const gaps = [];
  const existingById = new Map(
    asArray(existingGapDoc?.gaps).map((gap) => [safeString(gap?.id), gap]).filter(([id]) => Boolean(id))
  );

  if (!product) {
    addGap(gaps, existingById, {
      type: 'link',
      field: 'product_match',
      severity: 'critical',
      listingValue: listing?.itemId || null,
      avyValue: null,
      message: 'Listing konnte keinem AvyCloud-Produkt eindeutig zugeordnet werden.',
      syncDirection: 'accept_avy',
    });
    return gaps;
  }

  const listingCategory = coerceEbayCategoryId(listing?.primaryCategoryId) || safeString(listing?.primaryCategoryId);
  const productCategory = safeString(deriveProductCategoryId(product));
  if (listingCategory && productCategory && listingCategory !== productCategory) {
    addGap(gaps, existingById, {
      type: 'category',
      field: 'primary_category_id',
      severity: 'critical',
      listingValue: listingCategory,
      avyValue: productCategory,
      message: 'Kategorie-Abweichung zwischen eBay Listing und AvyCloud.',
      syncDirection: 'accept_avy',
    });
  }

  const rawRequiredAspects = asArray(getRequiredAspects(listingCategory)).map((x) => safeString(x)).filter(Boolean);
  const listingSpecifics = mapListingSpecifics(listing);
  const { byToken: aspectMetaByToken } = buildAspectTokenMeta(listingCategory);
  const catalogBased = isCatalogBasedListing(listing);
  const productOnlyTokens = new Set();
  if (catalogBased) {
    aspectMetaByToken.forEach((meta, token) => {
      const applicableTo = Array.isArray(meta?.applicableTo) ? meta.applicableTo : [];
      const productOnly = applicableTo.includes('PRODUCT') && !applicableTo.includes('ITEM');
      if (productOnly) productOnlyTokens.add(token);
    });
  }
  const requiredAspects = catalogBased
    ? rawRequiredAspects.filter((label) => !productOnlyTokens.has(normalizeSpecificToken(label)))
    : rawRequiredAspects;
  const labelPolicy = buildSpecificLabelPolicy({ requiredAspects, listingSpecifics, categoryProfile });
  const relevantTokens = buildRelevantSpecificTokens({ requiredAspects, listingSpecifics, categoryProfile });
  if (catalogBased && productOnlyTokens.size) {
    productOnlyTokens.forEach((token) => relevantTokens.delete(token));
  }
  const productSpecificsRaw = normalizeProductSpecifics(product);
  const productSpecificsAliased = applyCategoryProfileAliasesToSpecifics(productSpecificsRaw, categoryProfile);
  const productSpecificsCanonical = canonicalizeSpecificKeys(productSpecificsAliased, labelPolicy);
  const productSpecifics = filterSpecificsByRelevantTokens(productSpecificsCanonical, relevantTokens);
  const productSpecificsNorm = normalizeSpecificsMap(productSpecifics);
  const listingSpecificsNorm = normalizeSpecificsMap(listingSpecifics);

  Object.entries(productSpecifics).forEach(([key, value]) => {
    const keyNorm = normalizeSpecificToken(key);
    const ebayValues = listingSpecificsNorm[keyNorm] || [];
    const desiredValues = asArray(value).map((x) => safeString(x)).filter(Boolean);
    if (!desiredValues.length) return;

    if (!ebayValues.length) {
      addGap(gaps, existingById, {
        type: 'item_specific',
        field: key,
        severity: requiredAspects.some((req) => normalizeSpecificToken(req) === keyNorm) ? 'critical' : 'warn',
        listingValue: null,
        avyValue: desiredValues,
        message: 'Item Specific in AvyCloud vorhanden, aber auf eBay nicht gesetzt.',
        syncDirection: 'accept_avy',
      });
      return;
    }

    const diff = diffSpecificValues(desiredValues, ebayValues);
    if (diff.missingOnEbay.length || diff.extraOnEbay.length) {
      addGap(gaps, existingById, {
        type: 'item_specific',
        field: key,
        severity: 'warn',
        listingValue: ebayValues,
        avyValue: desiredValues,
        message: 'Item Specific Werte unterscheiden sich.',
        suggestion: {
          missingOnEbay: diff.missingOnEbay,
          extraOnEbay: diff.extraOnEbay,
        },
        syncDirection: 'accept_avy',
      });
    }
  });

  // Ensure required eBay aspects are visible as gaps even when AvyCloud has no value yet.
  // This keeps the UI focused on "which eBay parameters are empty".
  requiredAspects.forEach((requiredAspect) => {
    const requiredLabel = safeString(requiredAspect);
    const token = normalizeSpecificToken(requiredLabel);
    if (!token) return;
    const ebayValues = listingSpecificsNorm[token] || [];
    if (ebayValues.length) return;

    const avyValues = asArray(productSpecificsNorm[token]).map((x) => safeString(x)).filter(Boolean);
    const alreadyPresent = gaps.some(
      (gap) =>
        safeLower(gap?.type) === 'item_specific' &&
        normalizeSpecificToken(gap?.field) === token &&
        !hasGapListingValue(gap)
    );
    if (alreadyPresent) return;

    addGap(gaps, existingById, {
      type: 'item_specific',
      field: requiredLabel,
      severity: 'critical',
      listingValue: null,
      avyValue: avyValues.length ? avyValues : null,
      message: avyValues.length
        ? 'eBay Pflichtmerkmal ist leer und kann aus AvyCloud gefuellt werden.'
        : 'eBay Pflichtmerkmal ist leer (in AvyCloud aktuell ohne Wert).',
      syncDirection: 'accept_avy',
    });
  });

  Object.entries(listingSpecifics).forEach(([key, value]) => {
    const keyNorm = normalizeSpecificToken(key);
    const inAvy = Object.keys(productSpecifics).some((prodKey) => normalizeSpecificToken(prodKey) === keyNorm);
    if (inAvy) return;
    addGap(gaps, existingById, {
      type: 'item_specific',
      field: key,
      severity: 'info',
      listingValue: value,
      avyValue: null,
      message: 'Item Specific auf eBay vorhanden, aber in AvyCloud nicht gepflegt.',
      syncDirection: 'accept_ebay',
    });
  });

  const renameSuggestions = buildRenameSuggestionGap(productSpecificsRaw, listingSpecifics, relevantTokens);
  renameSuggestions.slice(0, 20).forEach((suggestion) => {
    addGap(gaps, existingById, {
      type: 'rename_suggestion',
      field: suggestion.from,
      severity: 'info',
      listingValue: suggestion.to,
      avyValue: suggestion.from,
      message: 'Potenzieller Attribut-Alias gefunden (AvyCloud Name vs eBay Name).',
      suggestion,
      syncDirection: 'accept_avy',
    });
  });

  const desiredTitle = deriveProductTitle(product);
  const desiredSubtitle = deriveProductSubtitle(product);
  const desiredDescription = deriveProductDescription(product);
  const desiredDescriptionNorm = normalizeComparableRichText(desiredDescription);
  const desiredHighlights = normalizeBulletList(deriveProductHighlights(product));

  const listingTitle = safeString(listing?.title);
  if (desiredTitle && normalizeComparableText(desiredTitle) !== normalizeComparableText(listingTitle)) {
    addGap(gaps, existingById, {
      type: 'content',
      field: 'title',
      severity: 'warn',
      listingValue: listingTitle || null,
      avyValue: desiredTitle,
      message: 'Titel weicht zwischen AvyCloud und eBay ab.',
      syncDirection: 'accept_avy',
    });
  }

  const listingSubtitle = safeString(listing?.subtitle);
  if (
    desiredSubtitle &&
    normalizeComparableText(desiredSubtitle) !== normalizeComparableText(listingSubtitle)
  ) {
    addGap(gaps, existingById, {
      type: 'content',
      field: 'subtitle',
      severity: 'info',
      listingValue: listingSubtitle || null,
      avyValue: desiredSubtitle,
      message: 'Untertitel weicht zwischen AvyCloud und eBay ab.',
      syncDirection: 'accept_avy',
    });
  }

  const listingDescription = safeString(listing?.description);
  const listingDescriptionParts = extractTrendOceanDescriptionParts(listingDescription);
  const listingDescriptionForCompare = safeString(listingDescriptionParts.descriptionHtml || listingDescription);
  const listingDescriptionNorm = normalizeComparableRichText(listingDescriptionForCompare);
  const listingHighlights = normalizeBulletList(listingDescriptionParts.highlights);

  const descriptionComparable = Boolean(desiredDescriptionNorm || listingDescriptionNorm);
  const descriptionMatches = !descriptionComparable
    ? true
    : desiredDescriptionNorm === listingDescriptionNorm ||
      (desiredDescriptionNorm.length > 120 &&
        listingDescriptionNorm.length > 120 &&
        (desiredDescriptionNorm.includes(listingDescriptionNorm) ||
          listingDescriptionNorm.includes(desiredDescriptionNorm)));

  const highlightsComparable = desiredHighlights.length > 0 || listingHighlights.length > 0;
  const desiredHighlightsSorted = desiredHighlights.slice().sort((a, b) => a.localeCompare(b));
  const listingHighlightsSorted = listingHighlights.slice().sort((a, b) => a.localeCompare(b));
  const highlightsMatches =
    !highlightsComparable ||
    (desiredHighlightsSorted.length === listingHighlightsSorted.length &&
      desiredHighlightsSorted.every((entry, idx) => entry === listingHighlightsSorted[idx]));

  if ((descriptionComparable || highlightsComparable) && (!descriptionMatches || !highlightsMatches)) {
    const mismatchParts = [];
    if (!descriptionMatches) mismatchParts.push('Beschreibung');
    if (!highlightsMatches) mismatchParts.push('Highlights');
    addGap(gaps, existingById, {
      type: 'content',
      field: 'description',
      severity: 'warn',
      listingValue: listingDescriptionForCompare ? `${listingDescriptionForCompare.slice(0, 500)}…` : null,
      avyValue: desiredDescription ? `${desiredDescription.slice(0, 500)}…` : null,
      message: `${mismatchParts.join(' + ')} weicht zwischen AvyCloud und eBay ab.`,
      suggestion: {
        templateDetected: listingDescriptionParts.isTemplate,
        descriptionMatches,
        highlightsMatches,
        listingHighlightsCount: listingHighlights.length,
        avyHighlightsCount: desiredHighlights.length,
      },
      syncDirection: 'accept_avy',
    });
  }

  const desiredPictureUrls = extractProductPictureUrls(product);
  if (desiredPictureUrls.length) {
    // Compare against last applied source URLs (not EPS URLs returned by GetItem),
    // because eBay may return EPS-hosted equivalents that don't match the original source URLs.
    const lastApplied = sanitizeEbayPictureUrls(listing?.pictureUrlsSource || []);
    const needsUpdate = !lastApplied.length || !sameStringList(lastApplied, desiredPictureUrls);
    if (needsUpdate) {
      addGap(gaps, existingById, {
        type: 'pictures',
        field: 'picture_urls',
        severity: 'warn',
        listingValue: lastApplied.length ? lastApplied : null,
        avyValue: desiredPictureUrls,
        message: lastApplied.length
          ? 'Produktbilder wurden in AvyCloud geaendert und sollten auf eBay aktualisiert werden.'
          : 'Produktbilder wurden noch nicht nach eBay synchronisiert (oder Vergleichsbasis fehlt).',
        syncDirection: 'accept_avy',
      });
    }
  }

  return gaps;
}

function summarizeGaps(gaps = []) {
  const summary = {
    total: gaps.length,
    critical: 0,
    warn: 0,
    info: 0,
    byStatus: {
      new: 0,
      reviewed: 0,
      accepted: 0,
      ignored: 0,
      ready_to_sync: 0,
      synced: 0,
      failed: 0,
    },
  };
  gaps.forEach((gap) => {
    const sev = safeLower(gap?.severity);
    if (sev === 'critical') summary.critical += 1;
    else if (sev === 'warn') summary.warn += 1;
    else summary.info += 1;
    const status = safeLower(gap?.status);
    if (Object.prototype.hasOwnProperty.call(summary.byStatus, status)) {
      summary.byStatus[status] += 1;
    }
  });
  return summary;
}

async function getProductsByIds(productIds = []) {
  const ids = Array.from(new Set(productIds.map((id) => safeString(id)).filter(Boolean)));
  if (!ids.length) return new Map();
  const refs = ids.map((id) => firestore.collection(PRODUCTS_COLLECTION).doc(id));
  const docs = await firestore.getAll(...refs);
  const out = new Map();
  docs.forEach((doc) => {
    if (!doc.exists) return;
    out.set(doc.id, { ...(doc.data() || {}), id: doc.id });
  });
  return out;
}

async function getCategoryProfilesByIds(categoryIds = []) {
  const ids = Array.from(new Set(categoryIds.map((id) => safeString(id)).filter(Boolean)));
  if (!ids.length) return new Map();
  const refs = ids.map((id) => firestore.collection(CATEGORY_PROFILES_COLLECTION).doc(id));
  const docs = await firestore.getAll(...refs);
  const out = new Map();
  docs.forEach((doc) => {
    if (!doc.exists) return;
    out.set(doc.id, doc.data() || null);
  });
  return out;
}

async function auditListingGaps({ itemIds = null, runId = null, actor = null } = {}) {
  const listingDocs = itemIds?.length
    ? await firestore.getAll(
        ...itemIds.map((id) => firestore.collection(EBAY_LISTINGS_COLLECTION).doc(String(id)))
      )
    : await firestore.collection(EBAY_LISTINGS_COLLECTION).where('active', '==', true).get();
  const listings = Array.isArray(listingDocs.docs)
    ? listingDocs.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }))
    : listingDocs.filter((doc) => doc?.exists).map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));

  if (!listings.length) {
    return { total: 0, withGaps: 0, withoutGaps: 0, criticalListings: 0 };
  }

  const ids = listings.map((x) => x.itemId);
  const [linkDocs, existingGapDocs] = await Promise.all([
    firestore.getAll(...ids.map((id) => firestore.collection(EBAY_LINKS_COLLECTION).doc(id))),
    firestore.getAll(...ids.map((id) => firestore.collection(EBAY_GAPS_COLLECTION).doc(id))),
  ]);

  const linkMap = new Map();
  const existingGapMap = new Map();
  linkDocs.forEach((doc) => linkMap.set(doc.id, doc.exists ? doc.data() || null : null));
  existingGapDocs.forEach((doc) => existingGapMap.set(doc.id, doc.exists ? doc.data() || null : null));

  const matchedProductIds = Array.from(
    new Set(
      ids
        .map((id) => safeString(linkMap.get(id)?.productId))
        .filter(Boolean)
    )
  );
  const listingCategoryIds = Array.from(new Set(listings.map((x) => safeString(x?.primaryCategoryId)).filter(Boolean)));
  const [productMap, categoryProfileMap] = await Promise.all([
    getProductsByIds(matchedProductIds),
    getCategoryProfilesByIds(listingCategoryIds),
  ]);
  const nowIso = new Date().toISOString();

  let withGaps = 0;
  let criticalListings = 0;
  for (const group of chunk(listings, 250)) {
    const batch = firestore.batch();
    group.forEach((listing) => {
      const itemId = safeString(listing.itemId);
      if (!itemId) return;
      const link = linkMap.get(itemId) || null;
      const product = link?.productId ? productMap.get(String(link.productId)) || null : null;
      const existingGapDoc = existingGapMap.get(itemId) || null;
      const categoryProfile = categoryProfileMap.get(safeString(listing?.primaryCategoryId)) || null;
      const gaps = buildGapsForListing({ listing, link, product, existingGapDoc, categoryProfile });
      if (gaps.length) withGaps += 1;
      const summary = summarizeGaps(gaps);
      if (summary.critical > 0) criticalListings += 1;
      const docRef = firestore.collection(EBAY_GAPS_COLLECTION).doc(itemId);
      const payload = cleanUndefined({
        itemId,
        listingSku: listing.sku || null,
        productId: link?.productId || null,
        linkStatus: link?.status || 'unmatched',
        gaps,
        summary,
        runId: runId || null,
        actor: actor || null,
        updatedAt: FieldValue.serverTimestamp(),
        updatedAtIso: nowIso,
        events: Array.isArray(existingGapDoc?.events) ? existingGapDoc.events.slice(-200) : [],
      });
      batch.set(docRef, payload, { merge: true });
    });
    await batch.commit();
  }

  return {
    total: listings.length,
    withGaps,
    withoutGaps: Math.max(0, listings.length - withGaps),
    criticalListings,
  };
}

function applyActionToGap(gap, action, payload = {}) {
  const next = { ...(gap || {}) };
  const note = safeString(payload.note) || null;
  const strategyByAction = {
    review: 'review',
    accept_avy: 'accept_avy',
    accept_ebay: 'accept_ebay',
    ignore: 'ignore',
    ready_to_sync: 'ready_to_sync',
    reset: 'reset',
    rename_alias: 'rename_alias',
  };
  const statusByAction = {
    review: 'reviewed',
    accept_avy: 'accepted',
    accept_ebay: 'accepted',
    ignore: 'ignored',
    ready_to_sync: 'ready_to_sync',
    reset: 'new',
    rename_alias: 'accepted',
  };
  const normalizedAction = safeLower(action);
  if (!statusByAction[normalizedAction]) {
    const error = new Error(`Unsupported gap action: ${action}`);
    error.code = 'EBAY_GAP_ACTION_INVALID';
    throw error;
  }
  next.status = statusByAction[normalizedAction];
  next.resolution = cleanUndefined({
    strategy: strategyByAction[normalizedAction],
    note,
    alias: normalizedAction === 'rename_alias' ? payload.alias || null : null,
    at: new Date().toISOString(),
  });
  const history = Array.isArray(next.history) ? next.history.slice(-40) : [];
  history.push({
    action: normalizedAction,
    status: next.status,
    note,
    at: new Date().toISOString(),
  });
  next.history = history.slice(-40);
  next.updatedAt = new Date().toISOString();
  return next;
}

function gapValueList(value) {
  return asArray(value).map((entry) => safeString(entry)).filter(Boolean);
}

function hasGapListingValue(gap) {
  return gapValueList(gap?.listingValue).length > 0;
}

function hasGapAvyValue(gap) {
  return gapValueList(gap?.avyValue).length > 0;
}

function matchesItemSpecificPrepareMode(gap, mode = 'missing_ebay') {
  if (safeLower(gap?.type) !== 'item_specific') return false;
  const hasListing = hasGapListingValue(gap);
  const hasAvy = hasGapAvyValue(gap);
  const normalizedMode = safeLower(mode) || 'missing_ebay';
  if (normalizedMode === 'all') return hasAvy;
  if (normalizedMode === 'different') return hasListing && hasAvy;
  if (normalizedMode === 'missing_avy') return hasListing && !hasAvy;
  return !hasListing && hasAvy;
}

async function applyGapAction(itemId, { gapId, action, note = null, alias = null, actor = null } = {}) {
  const key = safeString(itemId);
  const targetGapId = safeString(gapId);
  if (!key || !targetGapId) {
    const error = new Error('itemId and gapId are required');
    error.code = 'EBAY_GAP_ACTION_INPUT_INVALID';
    throw error;
  }
  const docRef = firestore.collection(EBAY_GAPS_COLLECTION).doc(key);
  const snap = await docRef.get();
  if (!snap.exists) {
    const error = new Error(`Gap document not found for listing ${key}`);
    error.code = 'EBAY_GAP_NOT_FOUND';
    throw error;
  }
  const data = snap.data() || {};
  const gaps = asArray(data.gaps);
  const idx = gaps.findIndex((gap) => safeString(gap?.id) === targetGapId);
  if (idx < 0) {
    const error = new Error(`Gap ${targetGapId} not found`);
    error.code = 'EBAY_GAP_ITEM_NOT_FOUND';
    throw error;
  }
  const updatedGap = applyActionToGap(gaps[idx], action, { note, alias });
  const nextGaps = [...gaps];
  nextGaps[idx] = updatedGap;
  const summary = summarizeGaps(nextGaps);
  const event = cleanUndefined({
    at: new Date().toISOString(),
    actor: actor || null,
    gapId: targetGapId,
    action: safeLower(action),
    note: safeString(note) || null,
    alias: alias || null,
  });
  const events = Array.isArray(data.events) ? [...data.events, event].slice(-200) : [event];

  await docRef.set(
    {
      gaps: nextGaps,
      summary,
      events,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtIso: new Date().toISOString(),
    },
    { merge: true }
  );

  return {
    itemId: key,
    gap: updatedGap,
    summary,
  };
}

async function bulkApplyGapActions(itemId, { gapIds = [], action, note = null, alias = null, actor = null } = {}) {
  const key = safeString(itemId);
  const targetIds = Array.from(new Set(asArray(gapIds).map((id) => safeString(id)).filter(Boolean)));
  const actionKey = safeLower(action);
  if (!key || !targetIds.length || !actionKey) {
    const error = new Error('itemId, gapIds and action are required');
    error.code = 'EBAY_GAP_ACTION_INPUT_INVALID';
    throw error;
  }

  const docRef = firestore.collection(EBAY_GAPS_COLLECTION).doc(key);
  const snap = await docRef.get();
  if (!snap.exists) {
    const error = new Error(`Gap document not found for listing ${key}`);
    error.code = 'EBAY_GAP_NOT_FOUND';
    throw error;
  }

  const data = snap.data() || {};
  const gaps = asArray(data.gaps);
  let changed = 0;
  const nextGaps = gaps.map((gap) => {
    const id = safeString(gap?.id);
    if (!targetIds.includes(id)) return gap;
    changed += 1;
    return applyActionToGap(gap, actionKey, { note, alias });
  });

  if (!changed) {
    const error = new Error('No matching gaps found for bulk action');
    error.code = 'EBAY_GAP_ITEM_NOT_FOUND';
    throw error;
  }

  const summary = summarizeGaps(nextGaps);
  const event = cleanUndefined({
    at: new Date().toISOString(),
    actor: actor || null,
    action: actionKey,
    gapIds: targetIds,
    note: safeString(note) || null,
    alias: alias || null,
  });
  const events = Array.isArray(data.events) ? [...data.events, event].slice(-200) : [event];

  await docRef.set(
    {
      gaps: nextGaps,
      summary,
      events,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtIso: new Date().toISOString(),
    },
    { merge: true }
  );

  return {
    itemId: key,
    updatedCount: changed,
    updatedGapIds: targetIds,
    summary,
  };
}

async function bulkPrepareMissingSpecificGaps({ itemIds = null, actor = null, mode = 'missing_ebay' } = {}) {
  const targetIds = Array.isArray(itemIds)
    ? Array.from(new Set(itemIds.map((id) => safeString(id)).filter(Boolean)))
    : null;
  const snapshot = targetIds?.length
    ? await firestore.getAll(...targetIds.map((id) => firestore.collection(EBAY_GAPS_COLLECTION).doc(id)))
    : await firestore.collection(EBAY_GAPS_COLLECTION).get();
  const docs = Array.isArray(snapshot.docs) ? snapshot.docs : snapshot;

  let docsTouched = 0;
  let gapsPrepared = 0;
  const byItem = [];
  const nowIso = new Date().toISOString();

  for (const group of chunk(docs, 250)) {
    const batch = firestore.batch();
    group.forEach((doc) => {
      if (!doc?.exists) return;
      const itemId = safeString(doc.id);
      const data = doc.data() || {};
      const gaps = asArray(data.gaps);
      let changed = 0;
      const nextGaps = gaps.map((gap) => {
        const status = safeLower(gap?.status);
        if (!matchesItemSpecificPrepareMode(gap, mode)) return gap;
        if (status === 'ignored' || status === 'synced') return gap;

        const history = Array.isArray(gap?.history) ? gap.history.slice(-40) : [];
        history.push({
          action: `bulk_prepare_item_specific_${safeLower(mode) || 'missing_ebay'}`,
          status: 'ready_to_sync',
          note: null,
          at: nowIso,
        });
        changed += 1;
        return {
          ...gap,
          status: 'ready_to_sync',
          resolution: cleanUndefined({
            strategy: `bulk_prepare_item_specific_${safeLower(mode) || 'missing_ebay'}`,
            note: null,
            alias: null,
            at: nowIso,
          }),
          history,
          updatedAt: nowIso,
        };
      });

      if (!changed) return;
      docsTouched += 1;
      gapsPrepared += changed;
      byItem.push({ itemId, prepared: changed });
      const summary = summarizeGaps(nextGaps);
      const events = Array.isArray(data.events) ? data.events.slice(-199) : [];
      events.push({
        at: nowIso,
        actor: actor || null,
        action: `bulk_prepare_item_specific_${safeLower(mode) || 'missing_ebay'}`,
        prepared: changed,
      });
      const ref = firestore.collection(EBAY_GAPS_COLLECTION).doc(itemId);
      batch.set(
        ref,
        {
          gaps: nextGaps,
          summary,
          events,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: nowIso,
        },
        { merge: true }
      );
    });
    await batch.commit();
  }

  return {
    mode: safeLower(mode) || 'missing_ebay',
    docsTotal: docs.length,
    docsTouched,
    gapsPrepared,
    byItem: byItem.slice(0, 200),
  };
}

async function bulkPrepareUpdateGaps({
  itemIds = null,
  actor = null,
  types = ['content'],
} = {}) {
  const targetIds = Array.isArray(itemIds)
    ? Array.from(new Set(itemIds.map((id) => safeString(id)).filter(Boolean)))
    : null;
  const snapshot = targetIds?.length
    ? await firestore.getAll(...targetIds.map((id) => firestore.collection(EBAY_GAPS_COLLECTION).doc(id)))
    : await firestore.collection(EBAY_GAPS_COLLECTION).get();
  const docs = Array.isArray(snapshot.docs) ? snapshot.docs : snapshot;

  const typeSet = new Set(asArray(types).map((t) => safeLower(t)).filter(Boolean));
  if (!typeSet.size) typeSet.add('content');

  let docsTouched = 0;
  let gapsPrepared = 0;
  const byItem = [];
  const nowIso = new Date().toISOString();

  for (const group of chunk(docs, 250)) {
    const batch = firestore.batch();
    group.forEach((doc) => {
      if (!doc?.exists) return;
      const itemId = safeString(doc.id);
      const data = doc.data() || {};
      const gaps = asArray(data.gaps);
      let changed = 0;

      const nextGaps = gaps.map((gap) => {
        const type = safeLower(gap?.type);
        if (!typeSet.has(type)) return gap;
        const direction = safeLower(gap?.syncDirection);
        if (direction !== 'accept_avy') return gap;
        const status = safeLower(gap?.status);
        if (status === 'ignored' || status === 'synced') return gap;

        // Only prepare gaps that have an Avy value (or description which is templated at apply-time).
        const field = safeLower(gap?.field);
        const hasAvy = hasGapAvyValue(gap);
        if (type === 'content' && field === 'description') {
          // ok (computeSyncPatch will build a full template when product link exists)
        } else if (!hasAvy) {
          return gap;
        }

        const history = Array.isArray(gap?.history) ? gap.history.slice(-40) : [];
        history.push({
          action: 'bulk_update_ready_to_sync',
          status: 'ready_to_sync',
          note: null,
          at: nowIso,
        });
        changed += 1;
        return {
          ...gap,
          status: 'ready_to_sync',
          resolution: cleanUndefined({
            strategy: 'bulk_update_ready_to_sync',
            note: null,
            alias: null,
            at: nowIso,
          }),
          history: history.slice(-40),
          updatedAt: nowIso,
        };
      });

      if (!changed) return;
      docsTouched += 1;
      gapsPrepared += changed;
      byItem.push({ itemId, prepared: changed });

      const summary = summarizeGaps(nextGaps);
      const events = Array.isArray(data.events) ? data.events.slice(-199) : [];
      events.push({
        at: nowIso,
        actor: actor || null,
        action: 'bulk_update_ready_to_sync',
        prepared: changed,
      });
      const ref = firestore.collection(EBAY_GAPS_COLLECTION).doc(itemId);
      batch.set(
        ref,
        {
          gaps: nextGaps,
          summary,
          events,
          updatedAt: FieldValue.serverTimestamp(),
          updatedAtIso: nowIso,
        },
        { merge: true }
      );
    });
    await batch.commit();
  }

  return {
    types: Array.from(typeSet),
    docsTotal: docs.length,
    docsTouched,
    gapsPrepared,
    byItem: byItem.slice(0, 200),
  };
}

function selectSyncCandidatesFromGaps(gapDoc) {
  const gaps = asArray(gapDoc?.gaps);
  return gaps.filter((gap) => {
    const status = safeLower(gap?.status);
    return status === 'accepted' || status === 'ready_to_sync';
  });
}

function computeSyncPatch({ listing, gapDoc, product = null }) {
  const selectedGaps = selectSyncCandidatesFromGaps(gapDoc);
  const listingCategory = coerceEbayCategoryId(listing?.primaryCategoryId) || safeString(listing?.primaryCategoryId);
  const targetCategoryFromGap = selectedGaps
    .map((gap) => ({
      type: safeLower(gap?.type),
      field: safeLower(gap?.field),
      value: coerceEbayCategoryId(gap?.avyValue) || safeString(gap?.avyValue),
    }))
    .find((entry) => entry.type === 'category' && entry.field.includes('category') && entry.value);
  const effectiveCategoryId = coerceEbayCategoryId(targetCategoryFromGap?.value || listingCategory) || safeString(targetCategoryFromGap?.value || listingCategory);
  const listingSpecifics = mapListingSpecifics(listing);
  const rawRequiredAspects = asArray(getRequiredAspects(effectiveCategoryId)).map((x) => safeString(x)).filter(Boolean);
  const { byToken: aspectMetaByToken } = buildAspectTokenMeta(effectiveCategoryId);
  const catalogBased = isCatalogBasedListing(listing);
  const productOnlyTokens = new Set();
  if (catalogBased) {
    aspectMetaByToken.forEach((meta, token) => {
      const applicableTo = Array.isArray(meta?.applicableTo) ? meta.applicableTo : [];
      const productOnly = applicableTo.includes('PRODUCT') && !applicableTo.includes('ITEM');
      if (productOnly) productOnlyTokens.add(token);
    });
  }
  const requiredAspects = catalogBased
    ? rawRequiredAspects.filter((label) => !productOnlyTokens.has(normalizeSpecificToken(label)))
    : rawRequiredAspects;
  const labelPolicy = buildSpecificLabelPolicy({ requiredAspects, listingSpecifics, categoryProfile: null });
  const patch = {
    itemId: listing?.itemId,
  };
  const touchedGapIds = [];
  const desiredSpecificByToken = new Map();
  const gapTokenById = new Map();
  const touch = (gap) => {
    const id = safeString(gap?.id);
    if (id) touchedGapIds.push(id);
  };
  const sameValueList = (a, b) => {
    const left = asArray(a).map((x) => safeString(x)).filter(Boolean).slice().sort((x, y) => x.localeCompare(y));
    const right = asArray(b).map((x) => safeString(x)).filter(Boolean).slice().sort((x, y) => x.localeCompare(y));
    if (left.length !== right.length) return false;
    return left.every((v, i) => v === right[i]);
  };

  selectedGaps.forEach((gap) => {
    const field = safeLower(gap?.field);
    const type = safeLower(gap?.type);
    if (!field || !type) return;

    if (type === 'category' && field.includes('category')) {
      const val = coerceEbayCategoryId(gap?.avyValue);
      if (val) {
        patch.primaryCategoryId = val;
        touch(gap);
      }
      return;
    }
    if (type === 'content') {
      if (field === 'title') {
        const val = safeString(gap?.avyValue);
        if (val) {
          patch.title = val;
          touch(gap);
        }
      }
      if (field === 'subtitle') {
        const val = safeString(gap?.avyValue);
        if (val) {
          patch.subtitle = val;
          touch(gap);
        }
      }
      if (field === 'description') {
        const val =
          buildTrendOceanDescriptionTemplate({
            listing,
            product,
            titleOverride: patch.title || listing?.title || null,
          }) || safeString(deriveProductDescription(product)) || safeString(gap?.avyValue);
        if (val) {
          patch.description = val;
          touch(gap);
        }
      }
      return;
    }
    if (type === 'pictures') {
      const urls = sanitizeEbayPictureUrls(gap?.avyValue);
      if (urls.length) {
        patch.pictureUrls = urls;
        touch(gap);
      }
      return;
    }
    if (type === 'item_specific') {
      const rawField = safeString(gap?.field);
      const token = normalizeSpecificToken(rawField);
      const key = token && labelPolicy.has(token) ? safeString(labelPolicy.get(token)) : rawField;
      if (!key) return;
      if (!patch.itemSpecifics) patch.itemSpecifics = {};
      const values = asArray(gap?.avyValue).map((v) => safeString(v)).filter(Boolean);
      if (values.length) {
        patch.itemSpecifics[key] = values;
        if (token) {
          desiredSpecificByToken.set(token, values);
          gapTokenById.set(safeString(gap?.id), token);
        }
      }
    }
  });

  if (patch.itemSpecifics && typeof patch.itemSpecifics === 'object' && Object.keys(patch.itemSpecifics).length) {
    // Trading API revise calls are more stable when required specifics are sent together.
    // Merge current listing specifics, then override with approved patch values.
    const listingSpecificsCanonical = canonicalizeSpecificKeys(listingSpecifics, labelPolicy);
    const mergedSpecifics = { ...listingSpecificsCanonical };
    Object.entries(patch.itemSpecifics).forEach(([key, rawValues]) => {
      const values = asArray(rawValues).map((entry) => safeString(entry)).filter(Boolean);
      if (!values.length) return;
      mergedSpecifics[safeString(key)] = values;
    });

    const fallbackSpecificByToken = new Map();
    const addFallbackValues = (tokenRaw, valuesRaw) => {
      const token = normalizeSpecificToken(tokenRaw);
      if (!token) return;
      const values = asArray(valuesRaw).map((entry) => safeString(entry)).filter(Boolean);
      if (!values.length) return;
      if (!fallbackSpecificByToken.has(token)) fallbackSpecificByToken.set(token, []);
      const bucket = fallbackSpecificByToken.get(token);
      values.forEach((entry) => {
        if (!bucket.includes(entry)) bucket.push(entry);
      });
    };
    asArray(gapDoc?.gaps).forEach((gap) => {
      if (safeLower(gap?.type) !== 'item_specific') return;
      addFallbackValues(gap?.field, gap?.avyValue);
    });
    // Do not rely solely on precomputed gaps. Pull fallback values directly from
    // the linked AvyCloud product to cover naming/alias mismatches in old gaps.
    const productSpecifics = normalizeProductSpecifics(product);
    Object.entries(productSpecifics || {}).forEach(([key, values]) => {
      addFallbackValues(key, values);
    });

    const mergedNorm = normalizeSpecificsMap(mergedSpecifics);
    requiredAspects.forEach((aspectName) => {
      const token = normalizeSpecificToken(aspectName);
      if (!token) return;
      const alreadyPresent = asArray(mergedNorm[token]).map((entry) => safeString(entry)).filter(Boolean).length > 0;
      if (alreadyPresent) return;
      const fallbackValues = asArray(fallbackSpecificByToken.get(token)).map((entry) => safeString(entry)).filter(Boolean);
      if (!fallbackValues.length) return;
      const key = token && labelPolicy.has(token) ? safeString(labelPolicy.get(token)) : safeString(aspectName);
      if (!key) return;
      mergedSpecifics[key] = fallbackValues;
      mergedNorm[token] = fallbackValues;
    });

    patch.itemSpecifics = mergedSpecifics;
  }

  if (patch.primaryCategoryId) {
    const coerced = coerceEbayCategoryId(patch.primaryCategoryId);
    if (coerced) patch.primaryCategoryId = coerced;
    else delete patch.primaryCategoryId;
  }

  if (patch.pictureUrls) {
    const urls = sanitizeEbayPictureUrls(patch.pictureUrls);
    if (urls.length) {
      patch.pictureUrls = urls;
    } else {
      delete patch.pictureUrls;
    }
  }

  if (patch.itemSpecifics && typeof patch.itemSpecifics === 'object' && Object.keys(patch.itemSpecifics).length) {
    const filtered = filterPatchItemSpecificsForListing({
      categoryId: effectiveCategoryId,
      listing,
      itemSpecifics: patch.itemSpecifics,
    });
    patch.itemSpecifics = filtered.itemSpecifics;

    // Only mark item-specific gaps as touched when their desired token survives filtering.
    if (gapTokenById.size) {
      const norm = normalizeSpecificsMap(patch.itemSpecifics);
      for (const [gapId, token] of gapTokenById.entries()) {
        if (!gapId || !token) continue;
        const desired = desiredSpecificByToken.get(token) || [];
        const patched = norm[token] || [];
        if (patched.length && sameValueList(patched, desired)) {
          // Ensure the gap is considered touched (it may have been skipped earlier due to filtering).
          touchedGapIds.push(gapId);
        }
      }
    }

    // If everything was filtered out, do not send ItemSpecifics at all.
    if (!patch.itemSpecifics || Object.keys(patch.itemSpecifics).length === 0) {
      delete patch.itemSpecifics;
    }
  }

  // Price sync: include sellPrice when it differs from the current listing price
  if (product) {
    const sellPrice = parseFloat(product?.details?.pricing?.sellPrice);
    const listingPrice = parseFloat(
      listing?.currentPrice?.value ?? listing?.currentPrice
    );
    if (Number.isFinite(sellPrice) && sellPrice > 0) {
      const priceDiffers = !Number.isFinite(listingPrice) || Math.abs(sellPrice - listingPrice) > 0.001;
      if (priceDiffers) {
        patch.startPrice = sellPrice;
        patch.currency = safeString(listing?.currency) || 'EUR';
      }
    }
  }

  return {
    patch,
    touchedGapIds: Array.from(new Set(touchedGapIds.filter(Boolean))),
  };
}

function evaluateSyncBlockers(listing, patch) {
  const blockers = [];
  const warnings = [];
  const bidCount = toNumber(listing?.bidCount) || 0;
  const patchCategoryRaw = safeString(patch?.primaryCategoryId);
  const patchCategoryId = patchCategoryRaw ? coerceEbayCategoryId(patchCategoryRaw) : '';
  if (patchCategoryRaw && !patchCategoryId) {
    blockers.push('Kategorie-Änderung blockiert: Ungültige Kategorie-ID (erwarte numerische CategoryID).');
  }
  const hasCategoryChange = Boolean(patchCategoryId);
  if (hasCategoryChange && bidCount > 0) {
    blockers.push('Kategorie-Änderung blockiert: Listing hat bereits Gebote.');
  }
  const endTimeMs = Date.parse(String(listing?.endTime || ''));
  if (hasCategoryChange && Number.isFinite(endTimeMs)) {
    const remainingMs = endTimeMs - Date.now();
    if (remainingMs > 0 && remainingMs < 12 * 60 * 60 * 1000) {
      blockers.push('Kategorie-Änderung blockiert: Listing endet in unter 12 Stunden.');
    }
  }
  const listingType = safeString(listing?.listingType);
  if (!listingType) {
    warnings.push('Listing-Typ unbekannt. Fallback auf ReviseItem.');
  }

  const patchPictures = sanitizeEbayPictureUrls(patch?.pictureUrls || []);
  if (patch?.pictureUrls && !patchPictures.length) {
    blockers.push('Bild-Update blockiert: Keine gueltigen HTTPS Picture URLs gefunden (mindestens 1 Bild erforderlich).');
  }
  if (patchPictures.length > EBAY_PICTURE_URL_MAX_COUNT) {
    blockers.push(`Bild-Update blockiert: Zu viele Bilder (${patchPictures.length}). Max: ${EBAY_PICTURE_URL_MAX_COUNT}.`);
  }

  const patchItemSpecifics = patch?.itemSpecifics && typeof patch.itemSpecifics === 'object' ? patch.itemSpecifics : {};
  const hasItemSpecificUpdates = Object.keys(patchItemSpecifics).length > 0;
  if (hasItemSpecificUpdates) {
    const effectiveCategoryId =
      patchCategoryId ||
      coerceEbayCategoryId(listing?.primaryCategoryId) ||
      safeString(listing?.primaryCategoryId);
    const rawRequiredAspects = asArray(getRequiredAspects(effectiveCategoryId)).map((x) => safeString(x)).filter(Boolean);
    const { byToken: aspectMetaByToken } = buildAspectTokenMeta(effectiveCategoryId);
    const catalogBased = isCatalogBasedListing(listing);
    const requiredAspects = catalogBased
      ? rawRequiredAspects.filter((label) => {
          const token = normalizeSpecificToken(label);
          if (!token) return true;
          const meta = aspectMetaByToken.get(token);
          if (!meta) return true;
          const applicableTo = Array.isArray(meta?.applicableTo) ? meta.applicableTo : [];
          const productOnly = applicableTo.includes('PRODUCT') && !applicableTo.includes('ITEM');
          return !productOnly;
        })
      : rawRequiredAspects;
    if (requiredAspects.length) {
      const listingNorm = normalizeSpecificsMap(mapListingSpecifics(listing));
      const patchNorm = normalizeSpecificsMap(patchItemSpecifics);
      requiredAspects.forEach((aspectName) => {
        const token = normalizeSpecificToken(aspectName);
        if (!token) return;
        const listingHas = asArray(listingNorm[token]).map((x) => safeString(x)).filter(Boolean).length > 0;
        const patchHas = asArray(patchNorm[token]).map((x) => safeString(x)).filter(Boolean).length > 0;
        if (!listingHas && !patchHas) {
          blockers.push(`Pflicht-Item-Specific fehlt: ${aspectName}.`);
        }
      });
    }
  }

  return { blockers, warnings };
}

function resolveReviseCallName(listing) {
  const type = safeLower(listing?.listingType);
  if (type.includes('fixed')) return 'ReviseFixedPriceItem';
  return 'ReviseItem';
}

async function dryRunSync({ itemIds = null, actor = null } = {}) {
  const gapsSnapshot = itemIds?.length
    ? await firestore.getAll(
        ...itemIds.map((id) => firestore.collection(EBAY_GAPS_COLLECTION).doc(String(id)))
      )
    : await firestore.collection(EBAY_GAPS_COLLECTION).get();
  const gapDocs = Array.isArray(gapsSnapshot.docs)
    ? gapsSnapshot.docs
    : gapsSnapshot.filter((doc) => doc?.exists);

  const candidates = gapDocs
    .filter((doc) => doc?.exists)
    .map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }))
    .filter((gapDoc) => selectSyncCandidatesFromGaps(gapDoc).length > 0);

  if (!candidates.length) {
    return { summary: { total: 0, ready: 0, blocked: 0 }, items: [] };
  }

  const listingDocs = await firestore.getAll(
    ...candidates.map((entry) => firestore.collection(EBAY_LISTINGS_COLLECTION).doc(String(entry.itemId)))
  );
  const listingMap = new Map();
  listingDocs.forEach((doc) => {
    if (!doc.exists) return;
    listingMap.set(doc.id, { ...(doc.data() || {}), itemId: doc.id });
  });

  const items = candidates.map((entry) => {
    const listing = listingMap.get(entry.itemId) || null;
    if (!listing) {
      return {
        itemId: entry.itemId,
        callName: null,
        canApply: false,
        blockers: ['Listing-Snapshot nicht gefunden.'],
        warnings: [],
        patch: null,
        touchedGapIds: [],
      };
    }
    const { patch, touchedGapIds } = computeSyncPatch({ listing, gapDoc: entry });
    const hasPatchFields =
      Boolean(patch?.primaryCategoryId) ||
      Boolean(patch?.title) ||
      Boolean(patch?.subtitle) ||
      Boolean(patch?.description) ||
      (Array.isArray(patch?.pictureUrls) && patch.pictureUrls.length > 0) ||
      Boolean(Object.keys(patch?.itemSpecifics || {}).length) ||
      Boolean(patch?.startPrice);

    const { blockers, warnings } = evaluateSyncBlockers(listing, patch);
    if (!hasPatchFields) {
      blockers.push('Keine synchronisierbaren Änderungen in den ausgewählten Gaps.');
    }
    const callName = resolveReviseCallName(listing);
    return {
      itemId: entry.itemId,
      callName,
      canApply: blockers.length === 0,
      blockers,
      warnings,
      patch: cleanUndefined(patch),
      touchedGapIds,
      actor: actor || null,
    };
  });

  return {
    summary: {
      total: items.length,
      ready: items.filter((x) => x.canApply).length,
      blocked: items.filter((x) => !x.canApply).length,
    },
    items,
  };
}

async function updateGapStatusesAfterSync(itemId, gapIds = [], nextStatus = 'synced', message = null, actor = null) {
  const docRef = firestore.collection(EBAY_GAPS_COLLECTION).doc(String(itemId));
  const snap = await docRef.get();
  if (!snap.exists) return;
  const data = snap.data() || {};
  const gaps = asArray(data.gaps).map((gap) => {
    const id = safeString(gap?.id);
    if (!gapIds.includes(id)) return gap;
    const history = Array.isArray(gap.history) ? gap.history.slice(-40) : [];
    history.push({
      action: `sync_${nextStatus}`,
      status: nextStatus,
      note: safeString(message) || null,
      at: new Date().toISOString(),
    });
    return {
      ...gap,
      status: nextStatus,
      syncMessage: safeString(message) || null,
      history: history.slice(-40),
      updatedAt: new Date().toISOString(),
    };
  });
  const summary = summarizeGaps(gaps);
  const event = {
    at: new Date().toISOString(),
    actor: actor || null,
    action: `sync_${nextStatus}`,
    gapIds,
    message: safeString(message) || null,
  };
  const events = Array.isArray(data.events) ? [...data.events, event].slice(-200) : [event];
  await docRef.set(
    {
      gaps,
      summary,
      events,
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtIso: new Date().toISOString(),
    },
    { merge: true }
  );
}

async function applySync({ itemIds = null, actor = null } = {}) {
  const preview = await dryRunSync({ itemIds, actor });
  const results = [];

  for (const item of preview.items) {
    const itemId = safeString(item?.itemId);
    if (!itemId) continue;

    let detail = null;
    try {
      detail = await getListingDetail(itemId);
    } catch (error) {
      results.push({
        itemId,
        ok: false,
        skipped: true,
        message: error?.message || String(error),
      });
      continue;
    }

    const gapDoc = detail?.gaps || null;
    if (!detail?.listing || !gapDoc) {
      results.push({
        itemId,
        ok: false,
        skipped: true,
        message: 'Listing- oder Gap-Dokument nicht gefunden.',
      });
      continue;
    }

    let listing = { ...(detail.listing || {}), itemId };
    const warnings = [];

    // Re-fetch latest listing details from eBay before apply to avoid stale
    // local snapshots that can drop required specifics in revise payloads.
    try {
      const live = await getItemDetails(itemId);
      if (live?.item && typeof live.item === 'object') {
        listing = { ...listing, ...live.item, itemId };
        await firestore
          .collection(EBAY_LISTINGS_COLLECTION)
          .doc(itemId)
          .set(
            cleanUndefined({
              itemId,
              sku: safeString(listing?.sku) || null,
              title: safeString(listing?.title) || null,
              subtitle: safeString(listing?.subtitle) || null,
              description: safeString(listing?.description) || null,
              listingType: safeString(listing?.listingType) || null,
              listingStatus: safeString(listing?.listingStatus) || null,
              quantityAvailable: toNumber(listing?.quantityAvailable),
              quantityTotal: toNumber(listing?.quantityTotal),
              bidCount: toNumber(listing?.bidCount),
              inventoryTrackingMethod: safeString(listing?.inventoryTrackingMethod) || null,
              primaryCategoryId: safeString(listing?.primaryCategoryId) || null,
              primaryCategoryName: safeString(listing?.primaryCategoryName) || null,
              viewItemUrl: safeString(listing?.viewItemUrl) || null,
              pictureUrls:
                Array.isArray(listing?.pictureUrls) && listing.pictureUrls.length ? listing.pictureUrls : null,
              startTime: safeString(listing?.startTime) || null,
              endTime: safeString(listing?.endTime) || null,
              timeLeft: safeString(listing?.timeLeft) || null,
              location: safeString(listing?.location) || null,
              country: safeString(listing?.country) || null,
              currency: safeString(listing?.currency) || null,
              currentPrice: toNumber(listing?.currentPrice),
              itemSpecifics: mapListingSpecifics(listing),
              productListingDetails: listing?.productListingDetails || null,
              active: true,
              lastDetailRefreshAt: FieldValue.serverTimestamp(),
              lastDetailRefreshAtIso: new Date().toISOString(),
              updatedAt: FieldValue.serverTimestamp(),
            }),
            { merge: true }
          );
      }
    } catch (error) {
      warnings.push(`Live-Refresh fehlgeschlagen, verwende Snapshot: ${error?.message || String(error)}`);
    }

    const { patch, touchedGapIds } = computeSyncPatch({
      listing,
      gapDoc,
      product: detail?.product || null,
    });
    const hasPatchFields =
      Boolean(patch?.primaryCategoryId) ||
      Boolean(patch?.title) ||
      Boolean(patch?.subtitle) ||
      Boolean(patch?.description) ||
      (Array.isArray(patch?.pictureUrls) && patch.pictureUrls.length > 0) ||
      Boolean(Object.keys(patch?.itemSpecifics || {}).length) ||
      Boolean(patch?.startPrice);
    const guard = evaluateSyncBlockers(listing, patch);
    const blockers = Array.isArray(guard?.blockers) ? guard.blockers.slice() : [];
    warnings.push(...(Array.isArray(guard?.warnings) ? guard.warnings : []));
    if (!hasPatchFields) {
      blockers.push('Keine synchronisierbaren Änderungen in den ausgewählten Gaps.');
    }
    if (blockers.length) {
      results.push({
        itemId,
        ok: false,
        skipped: true,
        message: blockers.join(' | '),
        warnings: warnings.length ? warnings : undefined,
      });
      continue;
    }

    const callName = resolveReviseCallName(listing);
    try {
      const response =
        callName === 'ReviseFixedPriceItem' ? await reviseFixedPriceItem(patch) : await reviseItem(patch);
      await updateGapStatusesAfterSync(itemId, touchedGapIds, 'synced', null, actor);
      await firestore
        .collection(EBAY_LISTINGS_COLLECTION)
        .doc(String(itemId))
        .set(
          cleanUndefined({
            syncState: 'synced',
            lastSyncAt: FieldValue.serverTimestamp(),
            lastSyncAtIso: new Date().toISOString(),
            lastSyncCall: callName,
            lastSyncError: null,
            pictureUrlsSource:
              Array.isArray(patch?.pictureUrls) && patch.pictureUrls.length
                ? sanitizeEbayPictureUrls(patch.pictureUrls)
                : undefined,
            pictureUrlsSourceHash:
              Array.isArray(patch?.pictureUrls) && patch.pictureUrls.length
                ? hashObject(sanitizeEbayPictureUrls(patch.pictureUrls))
                : undefined,
            pictureUrlsSourceUpdatedAtIso:
              Array.isArray(patch?.pictureUrls) && patch.pictureUrls.length ? new Date().toISOString() : undefined,
          }),
          { merge: true }
        );
      results.push({
        itemId,
        ok: true,
        callName,
        ack: response?.ack || 'Success',
        touchedGapIds,
        warnings: warnings.length ? warnings : undefined,
      });
    } catch (error) {
      const message = error?.message || String(error);
      await updateGapStatusesAfterSync(itemId, touchedGapIds, 'failed', message, actor);
      await firestore
        .collection(EBAY_LISTINGS_COLLECTION)
        .doc(String(itemId))
        .set(
          {
            syncState: 'failed',
            lastSyncAt: FieldValue.serverTimestamp(),
            lastSyncAtIso: new Date().toISOString(),
            lastSyncError: message,
            lastSyncCall: callName,
          },
          { merge: true }
        );
      results.push({
        itemId,
        ok: false,
        callName,
        message,
        touchedGapIds,
        warnings: warnings.length ? warnings : undefined,
      });
    }
  }

  const summary = {
    total: results.length,
    success: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok && !x.skipped).length,
    skipped: results.filter((x) => x.skipped).length,
  };

  return { summary, results, dryRun: preview.summary };
}

function csvEscape(value) {
  const raw = value == null ? '' : String(value);
  if (/[,"\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
}

async function createOperationalReports({ applyResults = [], outDir = null } = {}) {
  const baseDir =
    outDir ||
    path.join(process.cwd(), 'backend', 'exports', 'ebay-direct', stamp());
  ensureDir(baseDir);

  const [listingSnap, linksSnap, gapsSnap] = await Promise.all([
    firestore.collection(EBAY_LISTINGS_COLLECTION).get(),
    firestore.collection(EBAY_LINKS_COLLECTION).get(),
    firestore.collection(EBAY_GAPS_COLLECTION).get(),
  ]);

  const listings = listingSnap.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));
  const links = linksSnap.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));
  const gaps = gapsSnap.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));

  const matchedRows = links
    .filter((link) => safeLower(link.status) === 'matched')
    .map((link) => ({
      itemId: link.itemId,
      productId: link.productId || '',
      listingSku: link.listingSku || '',
      method: link.method || '',
      confidence: link.confidence ?? '',
      updatedAtIso: link.updatedAtIso || tsToIso(link.updatedAt) || '',
    }));

  const unmatchedRows = links
    .filter((link) => safeLower(link.status) !== 'matched')
    .map((link) => ({
      itemId: link.itemId,
      status: link.status || '',
      listingSku: link.listingSku || '',
      candidateProductIds: asArray(link.candidateProductIds).join('|'),
      method: link.method || '',
      updatedAtIso: link.updatedAtIso || tsToIso(link.updatedAt) || '',
    }));

  const gapRows = [];
  const renameRows = [];
  gaps.forEach((doc) => {
    asArray(doc.gaps).forEach((gap) => {
      const row = {
        itemId: doc.itemId,
        productId: doc.productId || '',
        gapId: gap.id || '',
        type: gap.type || '',
        field: gap.field || '',
        severity: gap.severity || '',
        status: gap.status || '',
        message: gap.message || '',
        listingValue: toFlatText(gap.listingValue),
        avyValue: toFlatText(gap.avyValue),
      };
      gapRows.push(row);
      if (safeLower(gap.type) === 'rename_suggestion') {
        renameRows.push({
          itemId: doc.itemId,
          productId: doc.productId || '',
          from: gap?.suggestion?.from || gap.field || '',
          to: gap?.suggestion?.to || '',
          status: gap.status || '',
        });
      }
    });
  });

  const applyRows = asArray(applyResults).map((item) => ({
    itemId: item?.itemId || '',
    ok: item?.ok ? 'true' : 'false',
    skipped: item?.skipped ? 'true' : 'false',
    callName: item?.callName || '',
    message: item?.message || '',
    ack: item?.ack || '',
    touchedGapIds: asArray(item?.touchedGapIds).join('|'),
  }));

  writeCsv(path.join(baseDir, 'matched.csv'), ['itemId', 'productId', 'listingSku', 'method', 'confidence', 'updatedAtIso'], matchedRows);
  writeCsv(
    path.join(baseDir, 'unmatched.csv'),
    ['itemId', 'status', 'listingSku', 'candidateProductIds', 'method', 'updatedAtIso'],
    unmatchedRows
  );
  writeCsv(
    path.join(baseDir, 'gaps.csv'),
    ['itemId', 'productId', 'gapId', 'type', 'field', 'severity', 'status', 'message', 'listingValue', 'avyValue'],
    gapRows
  );
  writeCsv(path.join(baseDir, 'rename_suggestions.csv'), ['itemId', 'productId', 'from', 'to', 'status'], renameRows);
  writeCsv(path.join(baseDir, 'apply_results.csv'), ['itemId', 'ok', 'skipped', 'callName', 'message', 'ack', 'touchedGapIds'], applyRows);

  const summary = {
    generatedAt: new Date().toISOString(),
    listings: listings.length,
    links: {
      total: links.length,
      matched: links.filter((x) => safeLower(x.status) === 'matched').length,
      unmatched: links.filter((x) => safeLower(x.status) === 'unmatched').length,
      ambiguous: links.filter((x) => safeLower(x.status) === 'ambiguous').length,
    },
    gaps: {
      docs: gaps.length,
      total: gapRows.length,
      critical: gapRows.filter((x) => safeLower(x.severity) === 'critical').length,
      readyToSync: gapRows.filter((x) => safeLower(x.status) === 'ready_to_sync').length,
    },
    renameSuggestions: renameRows.length,
    applyResults: applyRows.length,
  };

  fs.writeFileSync(path.join(baseDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  return {
    outDir: baseDir,
    summary,
    files: {
      summary: path.join(baseDir, 'summary.json'),
      matched: path.join(baseDir, 'matched.csv'),
      unmatched: path.join(baseDir, 'unmatched.csv'),
      gaps: path.join(baseDir, 'gaps.csv'),
      renameSuggestions: path.join(baseDir, 'rename_suggestions.csv'),
      applyResults: path.join(baseDir, 'apply_results.csv'),
    },
  };
}

async function syncLiveListingsAndAudit(options = {}) {
  const runId = safeString(options?.runId) || `run-${Date.now()}`;
  const actor = options?.actor || null;
  const ingest = await fetchLiveListingsFromEbay({
    maxPages: options?.maxPages,
    entriesPerPage: options?.entriesPerPage,
    detailConcurrency: options?.detailConcurrency,
    timeoutMs: options?.timeoutMs,
  });
  const upsert = await upsertLiveListings(ingest.listings, { runId, actor });
  const ingestPagesFetched = Number(ingest?.summary?.pagesFetched) || 0;
  const ingestTotalPages = Number(ingest?.summary?.totalPagesReported) || 0;
  const ingestIsComplete = ingestPagesFetched > 0 && ingestTotalPages > 0 && ingestPagesFetched >= ingestTotalPages;
  const deactivation = ingestIsComplete
    ? await deactivateListingsMissingFromActiveSet({
        activeItemIds: ingest.listings.map((x) => safeString(x?.itemId)).filter(Boolean),
        runId,
        actor,
      })
    : {
        scanned: 0,
        deactivated: 0,
        keptActive: 0,
        skipped: true,
        reason: 'partial_ingest_window',
        pagesFetched: ingestPagesFetched,
        totalPagesReported: ingestTotalPages,
      };
  const links = await buildProductListingLinks({ runId, actor, itemIds: ingest.listings.map((x) => x.itemId) });
  const gaps = await auditListingGaps({ runId, actor, itemIds: ingest.listings.map((x) => x.itemId) });

  const runSummary = {
    runId,
    actor,
    generatedAt: new Date().toISOString(),
    ingest: ingest.summary,
    upsert,
    deactivation,
    links,
    gaps,
    detailErrors: ingest.errors,
  };

  await firestore.collection(EBAY_REPORTS_COLLECTION).doc(runId).set(
    {
      ...runSummary,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  return runSummary;
}

// ---------------------------------------------------------------------------
// Publish products to eBay (AddFixedPriceItem)
// ---------------------------------------------------------------------------

const EBAY_PUBLISH_LOG_COLLECTION = 'ebayPublishLog';

function mapProductToEbayItem(product, overrides = {}) {
  const details = product?.details || {};
  const identifiers = details?.identifiers || {};
  const pricing = details?.pricing?.lowest_price || {};
  const attrs = details?.attributes && typeof details.attributes === 'object' ? details.attributes : {};
  const attrsExtra =
    details?.attributes_extra && typeof details.attributes_extra === 'object' ? details.attributes_extra : {};

  const title = safeString(overrides.title) || safeString(deriveProductTitle(product));
  if (!title) throw Object.assign(new Error('Produkt hat keinen Titel'), { code: 'EBAY_PUBLISH_NO_TITLE' });

  const subtitle = safeString(overrides.subtitle) || safeString(deriveProductSubtitle(product)) || undefined;

  const primaryCategoryId =
    safeString(overrides.primaryCategoryId) ||
    safeString(product?.details?.categoryId) ||
    safeString(product?.classification?.ebayCategoryId) ||
    safeString(product?.marketplace?.ebay?.categoryId) ||
    safeString(product?.categoryId);
  if (!primaryCategoryId) throw Object.assign(new Error('Produkt hat keine eBay-Kategorie'), { code: 'EBAY_PUBLISH_NO_CATEGORY' });

  const price =
    overrides.startPrice ??
    overrides.price ??
    pricing?.amount ??
    product?.marketplace?.ebay?.price ??
    null;
  if (price == null) throw Object.assign(new Error('Produkt hat keinen Preis'), { code: 'EBAY_PUBLISH_NO_PRICE' });

  const currency = safeString(overrides.currency) || safeString(pricing?.currency) || 'EUR';

  // Use actual stock: storageBins sum → inventory.quantity → marketplace override → fallback 1
  const binStock = Array.isArray(product?.storageBins)
    ? product.storageBins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0)
    : 0;
  const physicalStock = binStock || Number(product?.inventory?.quantity ?? 0);
  const quantity = overrides.quantity ?? (physicalStock > 0 ? physicalStock : (product?.marketplace?.ebay?.quantity ?? 1));

  const conditionId =
    safeString(overrides.conditionId) ||
    safeString(product?.marketplace?.ebay?.conditionId) ||
    safeString(product?.details?.conditionId) ||
    '1000';

  const sku = safeString(overrides.sku) || safeString(identifiers?.sku) || safeString(product?.sku) || undefined;

  const pictureUrls = [];
  asArray(overrides.pictureUrls || product?.details?.images).forEach((entry) => {
    if (!entry) return;
    const url = safeString(typeof entry === 'string' ? entry : entry?.url_or_base64 || entry?.url || entry?.src);
    if (/^https?:\/\//i.test(url) && !pictureUrls.includes(url)) pictureUrls.push(url);
  });

  // eBay rejects listings that mix EPS-hosted images (i.ebayimg.com / ebaystatic.com —
  // typically catalog/competitor stock photos pulled during enrichment) with
  // self-hosted ones: "EPS-Bilder und selbstverwaltete Bilder können nicht kombiniert
  // werden." When both kinds are present, drop the EPS URLs so only the seller's own
  // photos remain. If ONLY EPS URLs exist, keep them — otherwise the listing would
  // have no pictures at all.
  const isEbayHostedUrl = (u) => /(^https?:\/\/)?(i\.ebayimg\.com|[a-z0-9.-]*\.ebaystatic\.com)\//i.test(u);
  const hasOwnPicture = pictureUrls.some((u) => !isEbayHostedUrl(u));
  if (hasOwnPicture) {
    const beforeCount = pictureUrls.length;
    for (let i = pictureUrls.length - 1; i >= 0; i -= 1) {
      if (isEbayHostedUrl(pictureUrls[i])) pictureUrls.splice(i, 1);
    }
    if (pictureUrls.length < beforeCount) {
      console.info(`[buildListingFromProduct] Dropped ${beforeCount - pictureUrls.length} EPS-hosted image(s) to avoid EPS/self-managed mix rejection.`);
    }
  }

  const heroPhoto = pictureUrls[0] || safeString(deriveProductPhotoUrl(product, null)) || '';
  const description =
    safeString(overrides.description) ||
    buildTrendOceanDescriptionTemplate({
      listing: null,
      product,
      titleOverride: title,
      photoOverride: heroPhoto,
    });

  const pickAttributeValue = (...candidates) => {
    const pools = [attrs, attrsExtra];
    for (const candidate of candidates) {
      const needle = safeString(candidate).toLowerCase();
      if (!needle) continue;
      for (const pool of pools) {
        const key = Object.keys(pool).find((k) => safeString(k).toLowerCase() === needle);
        if (!key) continue;
        const value = safeString(pool[key]);
        if (value) return value;
      }
    }
    return '';
  };

  // Weight in kg — same fallback chain as product-store.js getProductWeightBySku()
  const rawWeight = overrides.weight
    ?? details?.weight
    ?? attrs?.weight
    ?? attrs?.['Gewicht (kg)']
    ?? attrs?.['Gewicht']
    ?? null;
  const weightKg = (typeof rawWeight === 'number' && rawWeight > 0)
    ? rawWeight
    : (typeof rawWeight === 'string' && parseFloat(rawWeight) > 0 ? parseFloat(rawWeight) : null);

  const ean = safeString(overrides.ean) || safeString(identifiers?.ean) || safeString(identifiers?.gtin) || undefined;
  const isbn =
    safeString(overrides.isbn) ||
    safeString(identifiers?.isbn) ||
    pickAttributeValue('ISBN', 'ISBN-13', 'ISBN 13', 'ISBN13', 'ISBN-10', 'ISBN 10', 'ISBN10') ||
    undefined;
  const mpn = safeString(overrides.mpn) || safeString(identifiers?.mpn) || undefined;
  const brand =
    safeString(overrides.brand) ||
    safeString(product?.identification?.brand) ||
    safeString(identifiers?.brand) ||
    undefined;

  const itemSpecifics = {};
  const productSpecs = normalizeProductSpecifics(product);
  Object.entries(productSpecs || {}).forEach(([key, values]) => {
    const cleanValues = asArray(values).map((v) => safeString(v)).filter(Boolean);
    if (cleanValues.length) itemSpecifics[key] = cleanValues;
  });
  if (overrides.itemSpecifics && typeof overrides.itemSpecifics === 'object') {
    Object.entries(overrides.itemSpecifics).forEach(([key, values]) => {
      const cleanValues = asArray(values).map((v) => safeString(v)).filter(Boolean);
      if (cleanValues.length) itemSpecifics[key] = cleanValues;
    });
  }
  if (brand && !itemSpecifics['Marke'] && !itemSpecifics['Brand']) {
    itemSpecifics['Marke'] = [brand];
  }
  const hasIsbnSpecific = Object.keys(itemSpecifics).some((key) => normalizeSpecificToken(key) === 'isbn');
  if (isbn && !hasIsbnSpecific) {
    itemSpecifics.ISBN = [isbn];
  }

  // Extract K-Typ fitment numbers before filtering. K-Typ must not be sent as
  // an ItemSpecific (eBay enforces a 65-char value limit), but via ItemCompatibilityList.
  const { kTypeNumbers, foundKey: kTypeKey } = extractKTypeNumbers(itemSpecifics);
  if (kTypeKey) delete itemSpecifics[kTypeKey];
  // eBay caps: each KType entry counts as 3 against the 3000-compatibility limit → max 1000.
  const itemCompatibilityList = kTypeNumbers.length
    ? kTypeNumbers.slice(0, 1000).map((n) => ({ ktype: n }))
    : null;

  // Publish path: Always remove technical keys (e.g. "Kategorie") and enforce maxLength.
  // Do NOT pre-drop PRODUCT aspects here because catalog matching may fail; eBay will then require seller-provided specifics.
  // If eBay returns the PBSE/catalog "product aspects vs custom item specifics" error, the Trading API layer will retry
  // with the offending specifics removed based on the API error payload.
  const filteredSpecifics = filterPatchItemSpecificsForListing({
    categoryId: primaryCategoryId,
    listing: null,
    itemSpecifics,
  });

  // eBay caps ItemSpecifics at 45 per listing. Trim here pre-flight (instead of relying
  // solely on the post-error auto-fix) because the builder pulls aspects from multiple
  // sources and can easily exceed the cap. Priority: identifiers first (Brand, MPN, EAN,
  // etc.), then remaining keys in insertion order. Dropped keys are logged.
  const EBAY_ITEM_SPECIFICS_CAP = 45;
  const specificKeys = Object.keys(filteredSpecifics.itemSpecifics || {});
  if (specificKeys.length > EBAY_ITEM_SPECIFICS_CAP) {
    const priorityNames = ['Marke', 'Brand', 'Hersteller', 'Herstellernummer', 'MPN', 'EAN', 'UPC', 'GTIN', 'ISBN', 'SKU', 'Produktart', 'Modell', 'Farbe', 'Material', 'Größe', 'Gewicht'];
    const keysLower = new Map(specificKeys.map((k) => [k.toLowerCase(), k]));
    const kept = new Set();
    for (const name of priorityNames) {
      if (kept.size >= EBAY_ITEM_SPECIFICS_CAP) break;
      const matchKey = keysLower.get(String(name).toLowerCase());
      if (matchKey) kept.add(matchKey);
    }
    for (const k of specificKeys) {
      if (kept.size >= EBAY_ITEM_SPECIFICS_CAP) break;
      kept.add(k);
    }
    const next = {};
    for (const k of specificKeys) {
      if (kept.has(k)) next[k] = filteredSpecifics.itemSpecifics[k];
    }
    const dropped = specificKeys.filter((k) => !kept.has(k));
    filteredSpecifics.itemSpecifics = next;
    console.info(`[buildListingFromProduct] ItemSpecifics capped at ${EBAY_ITEM_SPECIFICS_CAP}; dropped ${dropped.length}: ${dropped.slice(0, 10).join(', ')}${dropped.length > 10 ? '…' : ''}`);
  }

  // --- GPSR: Manufacturer data from product ---
  const gpsr = product?.details?.gpsr || null;

  // --- Responsible Person: EU-based entity (seller or authorized rep) ---
  // Loaded from ENV or integration settings — this is the SELLER's EU contact,
  // not the manufacturer. Required by GPSR for non-EU manufacturers.
  const responsiblePerson = {
    companyName: safeString(overrides.responsiblePersonName) || safeString(process.env.EBAY_RESPONSIBLE_PERSON_NAME) || 'TrendOcean',
    street: safeString(overrides.responsiblePersonStreet) || safeString(process.env.EBAY_RESPONSIBLE_PERSON_STREET) || undefined,
    city: safeString(overrides.responsiblePersonCity) || safeString(process.env.EBAY_RESPONSIBLE_PERSON_CITY) || undefined,
    postalCode: safeString(overrides.responsiblePersonZip) || safeString(process.env.EBAY_RESPONSIBLE_PERSON_ZIP) || undefined,
    countryCode: safeString(overrides.responsiblePersonCountry) || safeString(process.env.EBAY_RESPONSIBLE_PERSON_COUNTRY) || 'DE',
    phone: safeString(overrides.responsiblePersonPhone) || safeString(process.env.EBAY_RESPONSIBLE_PERSON_PHONE) || undefined,
    email: safeString(overrides.responsiblePersonEmail) || safeString(process.env.EBAY_RESPONSIBLE_PERSON_EMAIL) || undefined,
  };
  // Only include if at least company name + one contact field is set
  const hasResponsiblePerson = responsiblePerson.companyName && (responsiblePerson.street || responsiblePerson.email || responsiblePerson.phone);

  // --- Item location: warehouse address ---
  const postalCode = safeString(overrides.postalCode) || safeString(process.env.EBAY_ITEM_POSTAL_CODE) || undefined;
  const location = safeString(overrides.location) || safeString(process.env.EBAY_ITEM_LOCATION) || undefined;

  return {
    title,
    subtitle,
    primaryCategoryId,
    description,
    startPrice: price,
    currency,
    quantity,
    conditionId,
    sku,
    pictureUrls,
    ean,
    isbn,
    mpn,
    brand,
    itemSpecifics: filteredSpecifics.itemSpecifics,
    itemCompatibilityList,
    skipProductListingDetails: product?.details?.skipEbayCatalogLookup === true,
    weightKg,
    country: safeString(overrides.country) || 'DE',
    postalCode,
    location,
    vatPercent: overrides.vatPercent ?? 19.0,
    gpsr: gpsr || undefined,
    responsiblePerson: hasResponsiblePerson ? responsiblePerson : undefined,
    listingDuration: safeString(overrides.listingDuration) || 'GTC',
    dispatchTimeMax: overrides.dispatchTimeMax ?? 3,
    shippingProfileId: safeString(overrides.shippingProfileId) || safeString(process.env.EBAY_DEFAULT_SHIPPING_PROFILE_ID) || undefined,
    returnProfileId: safeString(overrides.returnProfileId) || safeString(process.env.EBAY_DEFAULT_RETURN_PROFILE_ID) || undefined,
    paymentProfileId: safeString(overrides.paymentProfileId) || safeString(process.env.EBAY_DEFAULT_PAYMENT_PROFILE_ID) || undefined,
  };
}

function validatePublishReadiness(product, overrides = {}) {
  const blockers = [];
  const warnings = [];
  const details = product?.details || {};
  const identifiers = details?.identifiers || {};
  const pricing = details?.pricing?.lowest_price || {};
  const attrs = details?.attributes && typeof details.attributes === 'object' ? details.attributes : {};
  const attrsExtra =
    details?.attributes_extra && typeof details.attributes_extra === 'object' ? details.attributes_extra : {};

  const title = safeString(overrides.title) || safeString(deriveProductTitle(product));
  if (!title) blockers.push('Kein Titel vorhanden.');
  else if (title.length > 80) warnings.push(`Titel ist ${title.length} Zeichen lang (max 80).`);

  const categoryId =
    safeString(overrides.primaryCategoryId) ||
    safeString(product?.details?.categoryId) ||
    safeString(product?.classification?.ebayCategoryId) ||
    safeString(product?.marketplace?.ebay?.categoryId) ||
    safeString(product?.categoryId);
  if (!categoryId) blockers.push('Keine eBay-Kategorie zugewiesen.');

  const price =
    overrides.startPrice ?? overrides.price ?? pricing?.amount ?? product?.marketplace?.ebay?.price ?? null;
  if (price == null) blockers.push('Kein Preis vorhanden.');
  else if (Number(price) <= 0) blockers.push('Preis muss größer als 0 sein.');

  const pictureUrls = [];
  asArray(overrides.pictureUrls || product?.details?.images).forEach((entry) => {
    if (!entry) return;
    const url = safeString(typeof entry === 'string' ? entry : entry?.url_or_base64 || entry?.url || entry?.src);
    if (/^https?:\/\//i.test(url)) pictureUrls.push(url);
  });
  if (!pictureUrls.length) blockers.push('Keine Bilder mit gültiger URL – Template benötigt mindestens 1 Bild.');

  const pickAttributeValue = (...candidates) => {
    const pools = [attrs, attrsExtra];
    for (const candidate of candidates) {
      const needle = safeString(candidate).toLowerCase();
      if (!needle) continue;
      for (const pool of pools) {
        const key = Object.keys(pool).find((k) => safeString(k).toLowerCase() === needle);
        if (!key) continue;
        const value = safeString(pool[key]);
        if (value) return value;
      }
    }
    return '';
  };
  const ean = safeString(overrides.ean) || safeString(identifiers?.ean) || safeString(identifiers?.gtin);
  const isbn =
    safeString(overrides.isbn) ||
    safeString(identifiers?.isbn) ||
    pickAttributeValue('ISBN', 'ISBN-13', 'ISBN 13', 'ISBN13', 'ISBN-10', 'ISBN 10', 'ISBN10');
  if (!ean && !isbn) warnings.push('Keine EAN/GTIN/ISBN vorhanden.');

  const highlights = deriveProductHighlights(product);
  if (!highlights.length) warnings.push('Keine Produkt-Highlights vorhanden – Template-Sektion wird leer.');

  const desc = safeString(deriveProductDescription(product));
  if (!desc) warnings.push('Keine Produktbeschreibung vorhanden – Template-Sektion wird leer.');

  const hasShippingProfile = Boolean(
    safeString(overrides.shippingProfileId) || safeString(process.env.EBAY_DEFAULT_SHIPPING_PROFILE_ID)
  );
  if (!hasShippingProfile) {
    blockers.push('Kein Versandprofil konfiguriert. Bitte EBAY_DEFAULT_SHIPPING_PROFILE_ID setzen oder /api/ebay/seller-profiles aufrufen.');
  }

  return { canPublish: blockers.length === 0, blockers, warnings };
}

function isEbayListingStatusActive(listingStatus) {
  return safeLower(listingStatus) === 'active';
}

function isEbayListingStatusInactive(listingStatus) {
  const s = safeLower(listingStatus);
  return s === 'ended' || s === 'completed';
}

async function resolveItemIsActive(itemId, { timeoutMs = 12000 } = {}) {
  const id = safeString(itemId);
  if (!id) return { itemId: id, isActive: false, listingStatus: null, source: 'none', uncertain: false };

  let local = null;
  try {
    const snap = await firestore.collection(EBAY_LISTINGS_COLLECTION).doc(id).get();
    if (snap.exists) local = snap.data() || {};
  } catch {
    local = null;
  }

  const localStatus = safeString(local?.listingStatus) || null;
  const localActiveFlag = local?.active === true;
  const localInactiveFlag = local?.active === false;

  // Fast path: if we already know it's inactive locally, don't block relisting.
  if (localInactiveFlag || isEbayListingStatusInactive(localStatus)) {
    return { itemId: id, isActive: false, listingStatus: localStatus, source: 'firestore', uncertain: false };
  }

  // If local snapshot says active (or we don't have one), confirm with Trading API GetItem.
  try {
    const live = await getItemDetails(id, { timeoutMs });
    const liveStatus = safeString(live?.item?.listingStatus) || null;
    const liveIsActive = isEbayListingStatusActive(liveStatus);

    // Heal stale local snapshots: item is no longer active on eBay.
    if (!liveIsActive && localActiveFlag) {
      await firestore
        .collection(EBAY_LISTINGS_COLLECTION)
        .doc(id)
        .set(
          cleanUndefined({
            active: false,
            inactiveAt: FieldValue.serverTimestamp(),
            inactiveAtIso: new Date().toISOString(),
            deactivation: {
              reason: 'verified_not_active',
              actor: 'publish_guard',
              at: new Date().toISOString(),
            },
            updatedAt: FieldValue.serverTimestamp(),
          }),
          { merge: true }
        );
    }

    return { itemId: id, isActive: liveIsActive, listingStatus: liveStatus, source: 'ebay', uncertain: false };
  } catch (error) {
    // Can't verify against eBay right now → be conservative and block relisting unless we had proven inactivity above.
    return { itemId: id, isActive: true, listingStatus: localStatus, source: local ? 'firestore' : 'unknown', uncertain: true, error };
  }
}

async function checkCategoryIsLeaf(product, overrides) {
  const categoryId =
    safeString(overrides.primaryCategoryId) ||
    safeString(product?.details?.categoryId) ||
    safeString(product?.classification?.ebayCategoryId) ||
    safeString(product?.marketplace?.ebay?.categoryId) ||
    safeString(product?.categoryId);
  if (!categoryId) return null;
  try {
    const info = await getCategoryInfo(categoryId);
    if (!info.isLeaf) {
      return `Kategorie ${categoryId}${info.name ? ` (${info.name})` : ''} ist keine Unterkategorie. Bitte eine spezifischere Kategorie wählen.`;
    }
    return null;
  } catch {
    return null; // Bei API-Fehler nicht blockieren
  }
}

async function checkExistingEbayLink(productId) {
  const snap = await firestore
    .collection(EBAY_LINKS_COLLECTION)
    .where('productId', '==', productId)
    .where('status', '==', 'matched')
    .limit(10)
    .get();
  if (snap.empty) return null;

  const itemIds = snap.docs
    .map((doc) => safeString(doc.data()?.itemId) || safeString(doc.id))
    .filter(Boolean);
  if (!itemIds.length) return null;

  // Prefer local "active" evidence to avoid unnecessary API calls.
  const listingSnaps = await firestore.getAll(
    ...itemIds.map((id) => firestore.collection(EBAY_LISTINGS_COLLECTION).doc(String(id)))
  );
  const localActiveIds = [];
  listingSnaps.forEach((docSnap) => {
    if (!docSnap.exists) return;
    const data = docSnap.data() || {};
    if (data?.active === true && safeString(docSnap.id)) {
      localActiveIds.push(String(docSnap.id));
    }
  });

  // If we have one locally-active candidate, confirm it against eBay before blocking.
  if (localActiveIds.length) {
    const check = await resolveItemIsActive(localActiveIds[0]);
    if (check.isActive) return check.itemId;
    return null;
  }

  // No local evidence of an active listing → allow relisting.
  return null;
}

async function verifyPublishProduct(productId, overrides = {}) {
  const id = safeString(productId);
  if (!id) throw Object.assign(new Error('productId is required'), { code: 'EBAY_PUBLISH_ID_REQUIRED' });
  const doc = await firestore.collection(PRODUCTS_COLLECTION).doc(id).get();
  if (!doc.exists) throw Object.assign(new Error(`Produkt ${id} nicht gefunden`), { code: 'EBAY_PUBLISH_PRODUCT_NOT_FOUND' });
  const product = { id: doc.id, ...doc.data() };

  const existingItemId = safeString(product?.marketplace?.ebay?.itemId);
  if (existingItemId) {
    const state = await resolveItemIsActive(existingItemId);
    if (state.isActive) {
      return {
        productId: id,
        canPublish: false,
        blockers: [`Bereits auf eBay gelistet (ItemID: ${existingItemId}). Artikel kann nicht erneut gelistet werden.`],
        warnings: [],
        fees: null,
      };
    }
  }

  const linkedItemId = await checkExistingEbayLink(id);
  if (linkedItemId) {
    return {
      productId: id,
      canPublish: false,
      blockers: [`Bereits auf eBay gelistet (ItemID: ${linkedItemId}). Artikel kann nicht erneut gelistet werden.`],
      warnings: [],
      fees: null,
    };
  }

  const readiness = validatePublishReadiness(product, overrides);
  if (!readiness.canPublish) {
    return { productId: id, canPublish: false, blockers: readiness.blockers, warnings: readiness.warnings, fees: null };
  }

  const item = mapProductToEbayItem(product, overrides);
  const verifyResult = await verifyAddFixedPriceItem(item);
  return {
    productId: id,
    canPublish: true,
    blockers: [],
    warnings: [
      ...readiness.warnings,
      ...asArray(verifyResult?.warnings).map((w) => safeString(w?.longMessage || w?.shortMessage)).filter(Boolean),
    ],
    fees: verifyResult?.fees || [],
    item,
  };
}

async function publishProduct(productId, overrides = {}, { actor = null } = {}) {
  const id = safeString(productId);
  if (!id) throw Object.assign(new Error('productId is required'), { code: 'EBAY_PUBLISH_ID_REQUIRED' });
  const doc = await firestore.collection(PRODUCTS_COLLECTION).doc(id).get();
  if (!doc.exists) throw Object.assign(new Error(`Produkt ${id} nicht gefunden`), { code: 'EBAY_PUBLISH_PRODUCT_NOT_FOUND' });
  const product = { id: doc.id, ...doc.data() };

  // Check Firestore link first (free, no API call)
  const linkedItemId = await checkExistingEbayLink(id);
  if (linkedItemId) {
    return {
      productId: id,
      ok: false,
      blockers: [`Bereits auf eBay gelistet (ItemID: ${linkedItemId}). Artikel kann nicht erneut gelistet werden.`],
      warnings: [],
    };
  }

  // Only call eBay API as fallback when product has a stored itemId but no Firestore link
  const existingItemId = safeString(product?.marketplace?.ebay?.itemId);
  if (existingItemId) {
    const state = await resolveItemIsActive(existingItemId);
    if (state.isActive) {
      return {
        productId: id,
        ok: false,
        blockers: [`Bereits auf eBay gelistet (ItemID: ${existingItemId}). Artikel kann nicht erneut gelistet werden.`],
        warnings: [],
      };
    }
  }

  const readiness = validatePublishReadiness(product, overrides);
  if (!readiness.canPublish) {
    // Persist readiness blockers so they're visible in the Marktplätze tab
    const listingErrors = readiness.blockers.map((msg) => ({ code: 'READINESS', message: msg, severity: 'Error' }));
    try {
      await firestore.collection(PRODUCTS_COLLECTION).doc(id).set(
        { marketplace: { ebay: { listing_errors: listingErrors, listing_errors_at: new Date().toISOString() } } },
        { merge: true }
      );
    } catch (persistErr) {
      console.error(`[publishProduct] Failed to persist readiness blockers for ${id}:`, persistErr?.message);
    }
    return { productId: id, ok: false, blockers: readiness.blockers, warnings: readiness.warnings };
  }

  // Auto-Fix-aware publish loop: up to MAX_AUTOFIX_ATTEMPTS retries with progressive
  // remediation (category strip, aspect fill via Gemini). See backend/services/ebay-auto-fix.js.
  const MAX_AUTOFIX_ATTEMPTS = 2;
  let workingProduct = product;
  let item = mapProductToEbayItem(workingProduct, overrides);
  const appliedFixes = [];
  let result;
  let lastPublishErr = null;

  for (let attempt = 0; attempt <= MAX_AUTOFIX_ATTEMPTS; attempt += 1) {
    try {
      result = await addFixedPriceItem(item);
      lastPublishErr = null;
      break;
    } catch (publishErr) {
      lastPublishErr = publishErr;
      if (attempt >= MAX_AUTOFIX_ATTEMPTS) break;

      let fixOutcome;
      try {
        const { autoFixEbayProduct } = require('../services/ebay-auto-fix');
        fixOutcome = await autoFixEbayProduct(workingProduct, { lastError: publishErr });
      } catch (fixErr) {
        console.error(`[publishProduct] Auto-fix threw for ${id}:`, fixErr?.message);
        break;
      }

      if (!fixOutcome || fixOutcome.skip || !fixOutcome.fixes?.length) break;

      workingProduct = fixOutcome.product;
      appliedFixes.push(...fixOutcome.fixes);

      try {
        const { saveProductV2 } = require('./product-store');
        await saveProductV2(workingProduct, { source: 'ebay-auto-fix', mode: 'system' });
      } catch (persistErr) {
        console.error(`[publishProduct] Failed to persist auto-fix for ${id}:`, persistErr?.message);
        // Even if persist fails, retry the publish with the in-memory fix.
      }

      item = mapProductToEbayItem(workingProduct, overrides);
    }
  }

  if (lastPublishErr) {
    const publishErr = lastPublishErr;
    // Persist the eBay error on the product so it's visible in the Marktplätze tab
    const errorMessage = safeString(publishErr?.message) || 'Unbekannter eBay-Fehler';
    const ebayErrors = asArray(publishErr?.details?.errors).map((e) => ({
      code: safeString(e?.errorCode || e?.code) || null,
      message: safeString(e?.longMessage || e?.shortMessage) || errorMessage,
      severity: safeString(e?.severityCode) || 'Error',
    }));
    const listingErrors = ebayErrors.length ? ebayErrors : [{ code: null, message: errorMessage, severity: 'Error' }];
    try {
      await firestore.collection(PRODUCTS_COLLECTION).doc(id).set(
        {
          marketplace: {
            ebay: {
              listing_errors: listingErrors,
              listing_errors_at: new Date().toISOString(),
              autoFixAttempts: appliedFixes.length ? appliedFixes : FieldValue.delete(),
            },
          },
        },
        { merge: true }
      );
    } catch (persistErr) {
      console.error(`[publishProduct] Failed to persist listing errors for ${id}:`, persistErr?.message);
    }
    if (appliedFixes.length) {
      publishErr.appliedFixes = appliedFixes;
    }
    throw publishErr;
  }

  // Note: downstream code reads `workingProduct` directly (not `product`).
  // The original `product` const stays as the input snapshot.

  const itemId = safeString(result?.itemId);

  await firestore.collection(EBAY_PUBLISH_LOG_COLLECTION).add({
    productId: id,
    itemId,
    sku: safeString(item?.sku) || null,
    title: safeString(item?.title),
    ack: result?.ack || null,
    fees: result?.fees || [],
    actor: safeString(actor) || null,
    appliedFixes: appliedFixes.length ? appliedFixes : null,
    createdAt: FieldValue.serverTimestamp(),
    createdAtIso: new Date().toISOString(),
  });

  if (itemId) {
    await firestore.collection(PRODUCTS_COLLECTION).doc(id).set(
      {
        marketplace: {
          ebay: {
            itemId,
            publishedAt: new Date().toISOString(),
            publishedBy: safeString(actor) || null,
            listing_errors: FieldValue.delete(),
            listing_errors_at: FieldValue.delete(),
          },
        },
      },
      { merge: true }
    );
  }

  return {
    productId: id,
    ok: true,
    itemId,
    ack: result?.ack || null,
    fees: result?.fees || [],
    warnings: [
      ...readiness.warnings,
      ...asArray(result?.warnings).map((w) => safeString(w?.longMessage || w?.shortMessage)).filter(Boolean),
    ],
    appliedFixes: appliedFixes.length ? appliedFixes : null,
    startTime: result?.startTime || null,
    endTime: result?.endTime || null,
  };
}

async function bulkVerifyPublishProducts(productIds, overrides = {}) {
  const BULK_DELAY_MS = parseInt(process.env.EBAY_BULK_PUBLISH_DELAY_MS || '300', 10);
  const ids = asArray(productIds).map((x) => safeString(x)).filter(Boolean);
  if (!ids.length) return { summary: { total: 0, ready: 0, blocked: 0 }, items: [] };
  const items = [];
  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && BULK_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, BULK_DELAY_MS));
    }
    try {
      const result = await verifyPublishProduct(ids[i], overrides);
      items.push(result);
    } catch (err) {
      items.push({ productId: ids[i], canPublish: false, blockers: [safeString(err?.message)], warnings: [], fees: null });
    }
  }
  const ready = items.filter((x) => x.canPublish).length;
  return { summary: { total: ids.length, ready, blocked: ids.length - ready }, items };
}

async function bulkPublishProducts(productIds, overrides = {}, { actor = null } = {}) {
  const BULK_DELAY_MS = parseInt(process.env.EBAY_BULK_PUBLISH_DELAY_MS || '300', 10);
  const ids = asArray(productIds).map((x) => safeString(x)).filter(Boolean);
  if (!ids.length) return { summary: { total: 0, success: 0, failed: 0 }, results: [] };
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    if (i > 0 && BULK_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, BULK_DELAY_MS));
    }
    try {
      const result = await publishProduct(ids[i], overrides, { actor });
      results.push(result);
    } catch (err) {
      results.push({ productId: ids[i], ok: false, blockers: [safeString(err?.message)], warnings: [] });
    }
  }
  const success = results.filter((x) => x.ok).length;
  return { summary: { total: ids.length, success, failed: ids.length - success }, results };
}

async function bulkUpdateListedProducts({ itemIds = null, applyAll = false, actor = null } = {}) {
  let resolvedItemIds;

  if (applyAll) {
    const snap = await firestore
      .collection(EBAY_LISTINGS_COLLECTION)
      .where('active', '==', true)
      .get();
    resolvedItemIds = snap.docs.map((doc) => doc.id);
  } else if (Array.isArray(itemIds) && itemIds.length > 0) {
    resolvedItemIds = itemIds.map((x) => String(x || '').trim()).filter(Boolean);
  } else {
    return { summary: { total: 0, success: 0, failed: 0, skipped: 0 }, results: [], dryRun: null };
  }

  if (!resolvedItemIds.length) {
    return { summary: { total: 0, success: 0, failed: 0, skipped: 0 }, results: [], dryRun: null };
  }

  // Ensure listing→product links exist before auditing gaps.
  // Otherwise, gap computation cannot derive Avy-side desired values (title/pictures/description),
  // and "update" appears to do nothing even though the listing is live (SKU-index match).
  try {
    const linkDocs = await firestore.getAll(
      ...resolvedItemIds.map((id) => firestore.collection(EBAY_LINKS_COLLECTION).doc(String(id)))
    );
    const needsLinking = [];
    linkDocs.forEach((doc) => {
      if (!doc?.exists) {
        needsLinking.push(String(doc.id));
        return;
      }
      const data = doc.data() || {};
      const status = safeLower(data?.status);
      const productId = safeString(data?.productId);
      if (status !== 'matched' || !productId) {
        needsLinking.push(String(doc.id));
      }
    });
    if (needsLinking.length) {
      await buildProductListingLinks({
        itemIds: needsLinking,
        runId: `update-links-${Date.now()}`,
        actor,
      });
    }
  } catch (e) {
    // best-effort; do not block update
  }

  // Gaps neu berechnen damit applySync aktuelle Diffs vorfindet
  const runId = `update-${Date.now()}`;
  await auditListingGaps({ itemIds: resolvedItemIds, runId, actor });

  // The AdminTable "eBay aktualisieren" action is meant to be a push-update:
  // mark content gaps ready_to_sync so applySync actually has candidates.
  await bulkPrepareUpdateGaps({ itemIds: resolvedItemIds, actor, types: ['content', 'pictures', 'category', 'item_specific'] });

  return applySync({ itemIds: resolvedItemIds, actor });
}

/**
 * Direct full-listing update: push ALL AvyCloud product data to an existing eBay listing.
 * Bypasses the gap system — builds a complete revise payload from product data.
 */
async function reviseListingFromProduct(itemId, product, { actor = null, relatedProducts = [] } = {}) {
  const id = safeString(itemId);
  if (!id) throw Object.assign(new Error('itemId is required'), { code: 'EBAY_REVISE_ITEM_ID_REQUIRED' });

  // Determine call type (FixedPrice vs Auction) — prefer Firestore cache to save an API call
  let listing = {};
  try {
    const cachedDoc = await firestore.collection(EBAY_LISTINGS_COLLECTION).doc(id).get();
    if (cachedDoc.exists) {
      const cached = cachedDoc.data() || {};
      const CACHE_MAX_AGE_MS = parseInt(process.env.EBAY_REVISE_CACHE_MAX_AGE_MS || String(24 * 60 * 60 * 1000), 10);
      const cacheAge = Date.now() - Date.parse(cached.lastSyncAtIso || cached.lastSyncAt || '1970-01-01');
      if (cacheAge < CACHE_MAX_AGE_MS && cached.listingType) {
        listing = cached;
      }
    }
  } catch (cacheErr) {
    console.warn(`[reviseListingFromProduct] Cache read failed for ${id}: ${cacheErr?.message}`);
  }
  // Fallback to live API call only if cache miss or stale
  if (!listing.listingType) {
    try {
      const live = await getItemDetails(id);
      if (live?.item && typeof live.item === 'object') listing = live.item;
    } catch (e) {
      console.warn(`[reviseListingFromProduct] Live fetch failed for ${id}, using defaults: ${e?.message}`);
    }
  }

  // Build full item data from product (same logic as publish)
  const item = mapProductToEbayItem(product);
  const title = safeString(item.title);
  const heroPhoto = item.pictureUrls?.[0] || safeString(deriveProductPhotoUrl(product, null)) || '';
  const description = buildTrendOceanDescriptionTemplate({
    listing,
    product,
    titleOverride: title,
    photoOverride: heroPhoto,
    relatedProducts,
  });

  const patch = {
    itemId: id,
    primaryCategoryId: item.primaryCategoryId,
    title,
    subtitle: item.subtitle,
    description,
    pictureUrls: sanitizeEbayPictureUrls(item.pictureUrls),
    startPrice: item.startPrice,
    currency: item.currency || 'EUR',
    quantity: item.quantity,
    conditionId: item.conditionId,
    ean: item.ean,
    isbn: item.isbn,
    mpn: item.mpn,
    brand: item.brand,
    weightKg: item.weightKg,
    itemSpecifics: item.itemSpecifics,
    itemCompatibilityList: item.itemCompatibilityList,
  };

  console.info(`[reviseListingFromProduct] itemId=${id} productId=${product?.id || '?'} title="${patch.title}" imgs=${patch.pictureUrls?.length || 0} price=${patch.startPrice} qty=${patch.quantity} cat=${patch.primaryCategoryId} cond=${patch.conditionId} weight=${patch.weightKg || '-'} specifics=${Object.keys(patch.itemSpecifics || {}).length} compat=${patch.itemCompatibilityList?.length || 0}`);

  const callName = resolveReviseCallName(listing);
  const response = callName === 'ReviseFixedPriceItem'
    ? await reviseFixedPriceItem(patch)
    : await reviseItem(patch);

  // Update local listing cache
  await firestore.collection(EBAY_LISTINGS_COLLECTION).doc(id).set(
    cleanUndefined({
      title: patch.title || null,
      primaryCategoryId: patch.primaryCategoryId || null,
      syncState: 'synced',
      lastSyncAt: FieldValue.serverTimestamp(),
      lastSyncAtIso: new Date().toISOString(),
      lastSyncCall: callName,
      lastSyncError: null,
      pictureUrlsSource: patch.pictureUrls?.length ? patch.pictureUrls : undefined,
      pictureUrlsSourceUpdatedAtIso: patch.pictureUrls?.length ? new Date().toISOString() : undefined,
    }),
    { merge: true }
  );

  return {
    itemId: id,
    ok: true,
    callName,
    ack: response?.ack || 'Success',
    updatedFields: Object.keys(patch).filter((k) => k !== 'itemId' && patch[k] != null),
  };
}

/**
 * Bulk full-update: push AvyCloud data to multiple eBay listings.
 * Uses direct revise (not gap system) for reliable updates.
 */
async function bulkReviseListingsFromProducts({ itemIds = null, applyAll = false, actor = null } = {}) {
  let resolvedItemIds;
  if (applyAll) {
    const snap = await firestore.collection(EBAY_LISTINGS_COLLECTION).where('active', '==', true).get();
    resolvedItemIds = snap.docs.map((doc) => doc.id);
  } else if (Array.isArray(itemIds) && itemIds.length > 0) {
    resolvedItemIds = itemIds.map((x) => String(x || '').trim()).filter(Boolean);
  } else {
    return { summary: { total: 0, success: 0, failed: 0, skipped: 0 }, results: [] };
  }

  // Ensure links exist
  try {
    const linkDocs = await firestore.getAll(
      ...resolvedItemIds.map((id) => firestore.collection(EBAY_LINKS_COLLECTION).doc(String(id)))
    );
    const needsLinking = [];
    linkDocs.forEach((doc) => {
      if (!doc?.exists || safeLower(doc.data()?.status) !== 'matched' || !safeString(doc.data()?.productId)) {
        needsLinking.push(String(doc.id));
      }
    });
    if (needsLinking.length) {
      await buildProductListingLinks({ itemIds: needsLinking, runId: `revise-links-${Date.now()}`, actor });
    }
  } catch (e) {
    // best-effort
  }

  // Resolve links to products
  const linkDocs = await firestore.getAll(
    ...resolvedItemIds.map((id) => firestore.collection(EBAY_LINKS_COLLECTION).doc(String(id)))
  );
  const linkMap = new Map();
  linkDocs.forEach((doc) => {
    if (doc?.exists) linkMap.set(doc.id, doc.data());
  });

  // Load all linked products in one batch
  const productIds = Array.from(new Set(
    resolvedItemIds
      .map((id) => safeString(linkMap.get(id)?.productId))
      .filter(Boolean)
  ));
  const productMap = new Map();
  if (productIds.length) {
    const productDocs = await firestore.getAll(
      ...productIds.map((pid) => firestore.collection(PRODUCTS_COLLECTION).doc(pid))
    );
    productDocs.forEach((doc) => {
      if (doc?.exists) productMap.set(doc.id, { id: doc.id, ...doc.data() });
    });
  }

  // Build itemId-to-productId reverse map for related products
  const itemToProductId = new Map();
  resolvedItemIds.forEach((id) => {
    const pid = safeString(linkMap.get(id)?.productId);
    if (pid) itemToProductId.set(id, pid);
  });

  // Pre-build related product data for template cross-sell section
  const relatedPool = [];
  for (const [ebayItemId, pid] of itemToProductId) {
    const p = productMap.get(pid);
    if (!p) continue;
    const mapped = mapProductToEbayItem(p);
    const rpPhoto = safeString(mapped.pictureUrls?.[0] || deriveProductPhotoUrl(p, null));
    const rpTitle = safeString(mapped.title || deriveProductTitle(p));
    const rpPrice = mapped.startPrice || null;
    if (rpTitle && rpPhoto) {
      relatedPool.push({ itemId: ebayItemId, productId: pid, title: rpTitle, photo: rpPhoto, price: rpPrice });
    }
  }

  const results = [];
  for (const itemId of resolvedItemIds) {
    const link = linkMap.get(itemId);
    const productId = safeString(link?.productId);
    if (!productId) {
      results.push({ itemId, ok: false, skipped: true, message: 'Kein Produkt verknuepft.' });
      continue;
    }
    const product = productMap.get(productId);
    if (!product) {
      results.push({ itemId, ok: false, skipped: true, message: `Produkt ${productId} nicht gefunden.` });
      continue;
    }

    // Pick up to 5 related products (different from current)
    const related = relatedPool
      .filter((rp) => rp.productId !== productId)
      .slice(0, 5);

    try {
      const result = await reviseListingFromProduct(itemId, product, { actor, relatedProducts: related });
      results.push(result);
    } catch (err) {
      results.push({
        itemId,
        ok: false,
        message: err?.message || 'Unbekannter Fehler',
      });
    }
  }

  return {
    summary: {
      total: results.length,
      success: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok && !x.skipped).length,
      skipped: results.filter((x) => x.skipped).length,
    },
    results,
  };
}

module.exports = {
  EBAY_LISTINGS_COLLECTION,
  EBAY_LINKS_COLLECTION,
  EBAY_GAPS_COLLECTION,
  fetchLiveListingSummariesFromEbay,
  fetchLiveListingsFromEbay,
  upsertLiveListings,
  upsertLiveListingSummaries,
  listLiveListings,
  getListingDetail,
  buildProductListingLinks,
  auditListingGaps,
  applyGapAction,
  bulkApplyGapActions,
  bulkPrepareMissingSpecificGaps,
  bulkPrepareUpdateGaps,
  dryRunSync,
  applySync,
  createOperationalReports,
  syncLiveListingsLight,
  syncLiveListingsAndAudit,
  mapProductToEbayItem,
  validatePublishReadiness,
  verifyPublishProduct,
  publishProduct,
  bulkVerifyPublishProducts,
  bulkPublishProducts,
  bulkUpdateListedProducts,
  reviseListingFromProduct,
  bulkReviseListingsFromProducts,
  reactivateWronglyDeactivatedListings,
  resolveCategoryNameFromId,
};
