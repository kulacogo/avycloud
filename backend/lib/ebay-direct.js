const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FieldValue } = require('@google-cloud/firestore');

const { firestore, getAllProducts } = require('./firestore');
const { getRequiredAspects } = require('./ebay-taxonomy');
const {
  getMyeBaySellingActive,
  getItemDetails,
  reviseFixedPriceItem,
  reviseItem,
} = require('./ebay-trading-api');

const EBAY_LISTINGS_COLLECTION = 'ebayListingsLive';
const EBAY_LINKS_COLLECTION = 'ebayListingLinks';
const EBAY_GAPS_COLLECTION = 'ebayListingGaps';
const EBAY_REPORTS_COLLECTION = 'ebayListingReports';
const CATEGORY_PROFILES_COLLECTION = 'categoryProfiles';
const PRODUCTS_COLLECTION = 'products';

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
  const lower = safeLower(value)
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
  // eBay can expose identifiers under multiple marketplace/language labels.
  if (token === 'marke' || token === 'brand') return 'brand';
  if (token === 'herstellernummer' || token === 'manufacturerpartnumber' || token === 'mpn') return 'mpn';
  // eBay can expose GTIN either as EAN or GTIN.
  if (token === 'ean' || token === 'gtin') return 'gtin';
  return token;
}

function normalizeProfileKey(value) {
  return safeString(value).replace(/\s+/g, ' ').trim();
}

function normalizeDigits(value) {
  return safeString(value).replace(/\D+/g, '');
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
  return safeString([brand, name].filter(Boolean).join(' ')) || null;
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

function deriveProductDescription(product) {
  const details = product?.details || {};
  return safeString(details?.description) || safeString(details?.short_description) || null;
}

function deriveProductCategoryId(product) {
  const details = product?.details || {};
  return safeString(details?.categoryId || details?.ebayCategoryId) || null;
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
  const pages = Math.max(1, Math.min(Number(maxPages) || 10, 200));
  const perPage = Math.max(1, Math.min(Number(entriesPerPage) || 100, 200));
  const concurrency = Math.max(1, Math.min(Number(detailConcurrency) || 4, 10));

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

  const details = [];
  const errors = [];
  for (const group of chunk(uniqueItems, concurrency)) {
    const responses = await Promise.all(
      group.map(async (entry) => {
        try {
          const detail = await getItemDetails(entry.itemId, { timeoutMs });
          return {
            ok: true,
            data: {
              ...entry,
              ...detail.item,
              itemId: entry.itemId,
            },
          };
        } catch (error) {
          return {
            ok: false,
            error: {
              itemId: entry.itemId,
              message: error?.message || String(error),
            },
          };
        }
      })
    );
    responses.forEach((result) => {
      if (result.ok) details.push(result.data);
      else errors.push(result.error);
    });
  }

  return {
    listings: details.filter((x) => safeString(x?.itemId)),
    summary: {
      pagesFetched: Math.min(totalPages, pages),
      totalPagesReported: totalPages,
      activeListings: uniqueItems.length,
      fetchedDetails: details.length,
      detailErrors: errors.length,
    },
    errors,
  };
}

async function upsertLiveListings(listings = [], { runId = null, actor = null } = {}) {
  const cleaned = listings
    .map((listing) => {
      const itemId = safeString(listing?.itemId);
      if (!itemId) return null;
      const payload = {
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

async function listLiveListings({
  limit = 100,
  search = '',
  matchStatus = '',
  includeInactive = false,
} = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 100, 500));
  let query = firestore.collection(EBAY_LISTINGS_COLLECTION).limit(capped);
  if (!includeInactive) {
    query = query.where('active', '==', true);
  }
  const snapshot = await query.get();
  const listings = snapshot.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));
  const ids = listings.map((x) => x.itemId).filter(Boolean);

  const linkRefs = ids.map((id) => firestore.collection(EBAY_LINKS_COLLECTION).doc(id));
  const gapRefs = ids.map((id) => firestore.collection(EBAY_GAPS_COLLECTION).doc(id));
  const [linkDocs, gapDocs] = await Promise.all([
    linkRefs.length ? firestore.getAll(...linkRefs) : Promise.resolve([]),
    gapRefs.length ? firestore.getAll(...gapRefs) : Promise.resolve([]),
  ]);

  const linkMap = new Map();
  const gapMap = new Map();
  linkDocs.forEach((doc) => linkMap.set(doc.id, doc.exists ? doc.data() || null : null));
  gapDocs.forEach((doc) => gapMap.set(doc.id, doc.exists ? doc.data() || null : null));

  const filteredSearch = safeLower(search);
  const rows = listings
    .map((listing) => {
      const link = linkMap.get(listing.itemId) || null;
      const gapDoc = gapMap.get(listing.itemId) || null;
      const gaps = Array.isArray(gapDoc?.gaps) ? gapDoc.gaps : [];
      const severityCritical = gaps.filter((g) => safeLower(g?.severity) === 'critical').length;
      const readyCount = gaps.filter((g) => safeLower(g?.status) === 'ready_to_sync').length;
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
        updatedAt: tsToIso(listing.updatedAt) || listing.updatedAt || null,
        viewItemUrl: listing.viewItemUrl || null,
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
    });
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

  const listingCategory = safeString(listing?.primaryCategoryId);
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

  const requiredAspects = asArray(getRequiredAspects(listingCategory)).map((x) => safeString(x)).filter(Boolean);
  const listingSpecifics = mapListingSpecifics(listing);
  const labelPolicy = buildSpecificLabelPolicy({ requiredAspects, listingSpecifics, categoryProfile });
  const relevantTokens = buildRelevantSpecificTokens({ requiredAspects, listingSpecifics, categoryProfile });
  const productSpecificsRaw = normalizeProductSpecifics(product);
  const productSpecificsAliased = applyCategoryProfileAliasesToSpecifics(productSpecificsRaw, categoryProfile);
  const productSpecificsCanonical = canonicalizeSpecificKeys(productSpecificsAliased, labelPolicy);
  const productSpecifics = filterSpecificsByRelevantTokens(productSpecificsCanonical, relevantTokens);
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
  if (
    desiredDescription &&
    normalizeComparableText(desiredDescription).slice(0, 1200) !==
      normalizeComparableText(listingDescription).slice(0, 1200)
  ) {
    addGap(gaps, existingById, {
      type: 'content',
      field: 'description',
      severity: 'warn',
      listingValue: listingDescription ? `${listingDescription.slice(0, 500)}…` : null,
      avyValue: desiredDescription ? `${desiredDescription.slice(0, 500)}…` : null,
      message: 'Beschreibung weicht zwischen AvyCloud und eBay ab.',
      syncDirection: 'accept_avy',
    });
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

function selectSyncCandidatesFromGaps(gapDoc) {
  const gaps = asArray(gapDoc?.gaps);
  return gaps.filter((gap) => {
    const status = safeLower(gap?.status);
    return status === 'accepted' || status === 'ready_to_sync';
  });
}

function computeSyncPatch({ listing, gapDoc }) {
  const selectedGaps = selectSyncCandidatesFromGaps(gapDoc);
  const listingCategory = safeString(listing?.primaryCategoryId);
  const listingSpecifics = mapListingSpecifics(listing);
  const requiredAspects = asArray(getRequiredAspects(listingCategory)).map((x) => safeString(x)).filter(Boolean);
  const labelPolicy = buildSpecificLabelPolicy({ requiredAspects, listingSpecifics, categoryProfile: null });
  const patch = {
    itemId: listing?.itemId,
  };
  const touchedGapIds = [];

  selectedGaps.forEach((gap) => {
    const field = safeLower(gap?.field);
    const type = safeLower(gap?.type);
    if (!field || !type) return;
    touchedGapIds.push(safeString(gap.id));

    if (type === 'category' && field.includes('category')) {
      const val = safeString(gap?.avyValue);
      if (val) patch.primaryCategoryId = val;
      return;
    }
    if (type === 'content') {
      if (field === 'title') {
        const val = safeString(gap?.avyValue);
        if (val) patch.title = val;
      }
      if (field === 'subtitle') {
        const val = safeString(gap?.avyValue);
        if (val) patch.subtitle = val;
      }
      if (field === 'description') {
        const val = safeString(gap?.avyValue);
        if (val) patch.description = val;
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
    asArray(gapDoc?.gaps).forEach((gap) => {
      if (safeLower(gap?.type) !== 'item_specific') return;
      const token = normalizeSpecificToken(gap?.field);
      if (!token) return;
      const values = asArray(gap?.avyValue).map((entry) => safeString(entry)).filter(Boolean);
      if (!values.length) return;
      if (!fallbackSpecificByToken.has(token)) fallbackSpecificByToken.set(token, []);
      const bucket = fallbackSpecificByToken.get(token);
      values.forEach((entry) => {
        if (!bucket.includes(entry)) bucket.push(entry);
      });
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

  return {
    patch,
    touchedGapIds: Array.from(new Set(touchedGapIds.filter(Boolean))),
  };
}

function evaluateSyncBlockers(listing, patch) {
  const blockers = [];
  const warnings = [];
  const bidCount = toNumber(listing?.bidCount) || 0;
  const hasCategoryChange = Boolean(safeString(patch?.primaryCategoryId));
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

  const patchItemSpecifics = patch?.itemSpecifics && typeof patch.itemSpecifics === 'object' ? patch.itemSpecifics : {};
  const hasItemSpecificUpdates = Object.keys(patchItemSpecifics).length > 0;
  if (hasItemSpecificUpdates) {
    const requiredAspects = asArray(getRequiredAspects(safeString(listing?.primaryCategoryId))).map((x) => safeString(x)).filter(Boolean);
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
      Boolean(Object.keys(patch?.itemSpecifics || {}).length);

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
    if (!item.canApply) {
      results.push({
        itemId: item.itemId,
        ok: false,
        skipped: true,
        message: item.blockers.join(' | '),
      });
      continue;
    }
    const callName = item.callName || 'ReviseItem';
    try {
      const response =
        callName === 'ReviseFixedPriceItem'
          ? await reviseFixedPriceItem(item.patch)
          : await reviseItem(item.patch);
      await updateGapStatusesAfterSync(item.itemId, item.touchedGapIds, 'synced', null, actor);
      await firestore
        .collection(EBAY_LISTINGS_COLLECTION)
        .doc(String(item.itemId))
        .set(
          {
            syncState: 'synced',
            lastSyncAt: FieldValue.serverTimestamp(),
            lastSyncAtIso: new Date().toISOString(),
            lastSyncCall: callName,
          },
          { merge: true }
        );
      results.push({
        itemId: item.itemId,
        ok: true,
        callName,
        ack: response?.ack || 'Success',
        touchedGapIds: item.touchedGapIds,
      });
    } catch (error) {
      const message = error?.message || String(error);
      await updateGapStatusesAfterSync(item.itemId, item.touchedGapIds, 'failed', message, actor);
      await firestore
        .collection(EBAY_LISTINGS_COLLECTION)
        .doc(String(item.itemId))
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
        itemId: item.itemId,
        ok: false,
        callName,
        message,
        touchedGapIds: item.touchedGapIds,
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
  const links = await buildProductListingLinks({ runId, actor, itemIds: ingest.listings.map((x) => x.itemId) });
  const gaps = await auditListingGaps({ runId, actor, itemIds: ingest.listings.map((x) => x.itemId) });

  const runSummary = {
    runId,
    actor,
    generatedAt: new Date().toISOString(),
    ingest: ingest.summary,
    upsert,
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

module.exports = {
  EBAY_LISTINGS_COLLECTION,
  EBAY_LINKS_COLLECTION,
  EBAY_GAPS_COLLECTION,
  fetchLiveListingsFromEbay,
  upsertLiveListings,
  listLiveListings,
  getListingDetail,
  buildProductListingLinks,
  auditListingGaps,
  applyGapAction,
  bulkApplyGapActions,
  bulkPrepareMissingSpecificGaps,
  dryRunSync,
  applySync,
  createOperationalReports,
  syncLiveListingsAndAudit,
};
