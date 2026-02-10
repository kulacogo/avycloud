
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const {
  saveProduct,
  getProduct,
  getAllProducts,
  deleteProduct,
  updateProductSyncStatus,
  listOrders,
  getOrderSummary,
  getDashboardMetrics,
  findProductIdsByAliases,
  findProductByStrictIdentifier,
  adjustPendingIntakeQuantity,
  deleteProductsByIdentityAlias,
  listInventories,
  getInventoryRecord,
  setProductInventory,
  assignInventoryToProducts,
  setSkuIndexEntry,
  firestore,
} = require('./lib/firestore');
const { buildIdentityAliasSet, computeProductIdentityKey } = require('./lib/product-identity');
const {
  createJob: createImproveJob,
  getJob: getImproveJob,
} = require('./lib/improve-jobs');
const { uploadBase64Image, deleteProductImages, uploadJobFile } = require('./lib/storage');
const { recordManualProductImage } = require('./lib/product-images');
const { createJob, getJob, listJobs, FieldValue } = require('./lib/jobs');
// SKU is allocated/validated centrally in saveProduct() (firestore) to guarantee uniqueness & format.
const { parseKTypeEbayCsvToSkuMap } = require('./lib/ktype');
const {
  runProductIdentification,
  ensurePriceCoverage,
  runDatasheetReview,
  prefetchWebEvidenceForIdentify,
  applyEbayTaxonomy,
  applyKauflandTaxonomy,
  BARCODE_LIMIT_ERROR,
  IMAGE_PAYLOAD_ERROR,
  MAX_BARCODE_COUNT,
  MAX_IMAGE_PAYLOAD_BYTES,
  TOOL_ITERATION_ERROR,
} = require('./services/enrichment');
const { runSerpapiFreePipeline } = require('./services/enrichment-v2');
const { buildProductFromV2Record } = require('./lib/v2-product-builder');
const { syncInventoriesFromBaseLinker } = require('./services/inventory-sync');
const { runProductChat } = require('./services/product-chat');
const { improveExistingProduct } = require('./services/improve');
const { getSecretValue } = require('./lib/secret-values');
const { fetchWithUnlocker } = require('./lib/web-unlocker');
const { search: searchEvidence, searchSite: searchEvidenceSite } = require('./lib/evidence-provider');
const { enqueueJob, startJobRunner } = require('./services/job-runner');
const { runCloudRunJob } = require('./lib/cloud-run-jobs');
const { enqueueImproveJob, startImproveRunner } = require('./services/improve-runner');
const { enqueueQualityJob, startQualityRunner } = require('./services/quality-runner');
const { enqueueBaseLinkerSyncJob, startBaseLinkerSyncRunner } = require('./services/baselinker-sync-runner');
const { startRulebookRunner } = require('./services/rulebook-runner');
const { createJob: createAdminBulkJob, getJob: getAdminBulkJob } = require('./lib/admin-bulk-jobs');
const { enqueueAdminBulkJob, startAdminBulkRunner } = require('./services/admin-bulk-runner');
const { createJob: createQualityJob, getJob: getQualityJob, Timestamp: QualityTimestamp, updateJob: updateQualityJob } = require('./lib/quality-jobs');
const { createJob: createBaseLinkerSyncJob, getJob: getBaseLinkerSyncJob, updateJob: updateBaseLinkerSyncJob, Timestamp: BaseLinkerSyncTimestamp } = require('./lib/baselinker-sync-jobs');
const {
  createWarehouseLayout,
  listWarehouseZones,
  getBinsForZone,
  getBinByCode,
  deleteWarehouseGang,
  deleteWarehouseRegal,
  deleteWarehouseEbene,
  assignProductToBin,
  removeProductFromBin,
  refreshProductInventory,
  findProductDocument,
  bookStockIn,
  bookStockOut,
  listBinsForProduct,
  getProductBinSummaryMap,
} = require('./lib/warehouse');
const {
  buildProductLabelsHtml,
  buildBinLabelHtml,
  buildBinLabelsHtml,
  buildBinLabelsPdf,
  buildInventoryLabelPdf,
} = require('./services/label-printer');
const { scanToBuffer } = require('./services/scanner');
const { syncNewOrders, markOrderAsPicked, markOrderAsPacked } = require('./services/order-sync');
const { requireAuth } = require('./lib/auth');
const { ensureDefaultRoles, requirePermission, resolvePermissionsForUser } = require('./lib/rbac');
const {
  inviteUser,
  listUsers: listUsersAdmin,
  setUserRoles: setUserRolesAdmin,
  setUserGroups: setUserGroupsAdmin,
  setUserOverrides: setUserOverridesAdmin,
  listRoles: listRolesAdmin,
  updateRole: updateRoleAdmin,
  listGroups: listGroupsAdmin,
  createGroup: createGroupAdmin,
  updateGroup: updateGroupAdmin,
  deleteGroup: deleteGroupAdmin,
} = require('./services/admin-api');
const { requestPasswordReset } = require('./services/public-auth');
const { ensureBootstrapAdmin } = require('./lib/bootstrap-admin');
const {
  ensureDefaultLlmScopes,
  listLlmScopes,
  getScope,
  listScopeVersions,
  createScopeVersion,
  activateScopeVersion,
} = require('./lib/llm-config');

const normalizeIdentifyToken = (value) => String(value || '').trim();
const extractDigitBarcode = (value) =>
  String(value || '')
    .replace(/\D+/g, '')
    .trim();

const parseBarcodeListFromText = (barcodesText) => {
  const raw = normalizeIdentifyToken(barcodesText);
  if (!raw) return [];
  const tokens = raw
    .split(/[\n,;|]+/)
    .map((t) => normalizeIdentifyToken(t))
    .filter(Boolean);
  const digitCodes = tokens.map(extractDigitBarcode).filter(Boolean);
  return Array.from(new Set(digitCodes));
};

const parseSkuCandidateFromText = (barcodesText) => {
  const raw = normalizeIdentifyToken(barcodesText);
  if (!raw) return null;
  const tokens = raw
    .split(/[\n,;|]+/)
    .map((t) => normalizeIdentifyToken(t))
    .filter(Boolean);
  // SKU tokens are often like "SKU-123" or other non-digit identifiers.
  const skuToken =
    tokens.find((t) => /[a-z]/i.test(t) && !/^\d+$/.test(t)) ||
    null;
  return skuToken ? skuToken : null;
};
const { attachPickHintsToOrders } = require('./services/pick-hints');
const { updateJob, Timestamp } = require('./lib/improve-jobs');

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'avycloud'; // Auto-detect from Cloud Run or fallback
const IMAGE_PROXY_TIMEOUT_MS = parseInt(process.env.IMAGE_PROXY_TIMEOUT_MS || '10000', 10);
const IMAGE_PROXY_MAX_BYTES = parseInt(process.env.IMAGE_PROXY_MAX_BYTES || `${5 * 1024 * 1024}`, 10); // 5 MB by default
const PRICE_REFRESH_TIMEOUT_MS = parseInt(process.env.PRICE_REFRESH_TIMEOUT_MS || '20000', 10);
const ADMIN_DELETE_TOKEN = process.env.ADMIN_DELETE_TOKEN || '';
const REQUEST_BODY_LIMIT =
  process.env.API_REQUEST_BODY_LIMIT ||
  process.env.REQUEST_BODY_LIMIT ||
  '50mb';

// --- Price enrichment helpers (SerpAPI optional; BrightData/HTML fallback) ---
const PRICE_MARKETPLACE_SITES = ['ebay.de', 'kaufland.de', 'hood.de'];
const PRICE_USED_HINT = /\b(gebraucht|used|refurb|refurbished|renewed|b-ware|pre-owned|second hand|open box)\b/i;

function priceSafeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function medianNumber(values = []) {
  const nums = values
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function parseEurAmount(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const cleaned = s
    .replace(/\s+/g, '')
    .replace(/€/g, '')
    .replace(/EUR/gi, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '') // 1.234,56 -> 1234,56
    .replace(',', '.');
  const v = parseFloat(cleaned);
  if (!Number.isFinite(v)) return null;
  if (v < 0.5 || v > 50000) return null;
  return v;
}

function extractJsonLdBlocks(html = '') {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const txt = (m[1] || '').trim();
    if (txt) blocks.push(txt);
    if (blocks.length >= 8) break;
  }
  return blocks;
}

function tryParseJsonLenient(text) {
  const raw = (text == null ? '' : String(text)).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function collectPricesFromJsonLd(obj) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object') return;
    const offers = node.offers;
    if (offers) visit(offers);
    const price = node.price;
    const currency = node.priceCurrency || node.pricecurrency;
    if (price != null) {
      const amount = parseEurAmount(price);
      const cur = priceSafeString(currency).toUpperCase();
      if (amount != null && (!cur || cur === 'EUR')) {
        out.push(amount);
      }
    }
    if (node['@graph']) visit(node['@graph']);
    for (const v of Object.values(node)) {
      visit(v);
    }
  };
  visit(obj);
  return out;
}

function extractPriceCandidates(html) {
  const candidates = [];
  const body = String(html || '');

  const metaAmount =
    body.match(/property=["']?product:price:amount["']?[^>]*content=["']?([\d.,]+)/i)?.[1] ||
    body.match(/itemprop=["']?price["']?[^>]*content=["']?([\d.,]+)/i)?.[1] ||
    body.match(/itemprop=["']?price["']?[^>]*content=["']?(\d+(?:[.,]\d{2})?)/i)?.[1];
  const metaCurrency =
    body.match(/property=["']?product:price:currency["']?[^>]*content=["']?([A-Z]{3})/i)?.[1] ||
    body.match(/itemprop=["']?priceCurrency["']?[^>]*content=["']?([A-Z]{3})/i)?.[1];
  if (metaAmount) {
    const amount = parseEurAmount(metaAmount);
    const cur = priceSafeString(metaCurrency).toUpperCase();
    if (amount != null && (!cur || cur === 'EUR')) {
      candidates.push(amount);
    }
  }

  for (const block of extractJsonLdBlocks(body)) {
    const parsed = tryParseJsonLenient(block);
    if (!parsed) continue;
    const prices = collectPricesFromJsonLd(parsed);
    prices.forEach((p) => candidates.push(p));
  }

  const re = /(?:EUR\s*)?(\d{1,5}(?:[.,]\d{2}))\s*€/gi;
  let m;
  while ((m = re.exec(body))) {
    const amount = parseEurAmount(m[1]);
    if (amount != null) candidates.push(amount);
    if (candidates.length >= 20) break;
  }
  const re2 = /EUR\s*(\d{1,5}(?:[.,]\d{2}))/gi;
  while ((m = re2.exec(body))) {
    const amount = parseEurAmount(m[1]);
    if (amount != null) candidates.push(amount);
    if (candidates.length >= 20) break;
  }

  return Array.from(new Set(candidates)).sort((a, b) => a - b);
}

async function fetchHtmlForPrice(url) {
  const result = await fetchWithUnlocker({
    url,
    method: 'GET',
    format: 'raw',
    timeoutMs: PRICE_REFRESH_TIMEOUT_MS,
    headers: {
      'User-Agent': 'avystock-price-refresh/3.0',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
    },
  });
  if (!result?.success) {
    throw new Error(result?.error || result?.statusText || 'Web Unlocker request failed');
  }
  return String(result.body || '');
}

function hasValidPriceEvidence(lowestPrice) {
  const amount = lowestPrice?.amount;
  const sources = Array.isArray(lowestPrice?.sources) ? lowestPrice.sources : [];
  const hasEvidence = sources.some((s) => s && typeof s.url === 'string' && s.url.trim());
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 1 && hasEvidence;
}

async function findWebPriceForProductV1(product) {
  const brand = priceSafeString(product?.identification?.brand);
  const title = priceSafeString(product?.identification?.name);
  const mpn =
    priceSafeString(product?.details?.identifiers?.mpn) ||
    priceSafeString(product?.details?.attributes?.Herstellernummer) ||
    priceSafeString(product?.details?.attributes?.MPN) ||
    priceSafeString(product?.details?.attributes?.mpn);
  const barcode =
    (Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
      .map((x) => priceSafeString(x))
      .find((x) => x.length >= 8) ||
    priceSafeString(product?.details?.identifiers?.ean) ||
    priceSafeString(product?.details?.identifiers?.gtin) ||
    priceSafeString(product?.details?.identifiers?.upc) ||
    '';
  const sku =
    priceSafeString(product?.identification?.sku) ||
    priceSafeString(product?.details?.identifiers?.sku) ||
    priceSafeString(product?.id);

  const negativeTerms = '-gebraucht -used -refurb -refurbished -renewed -b-ware -openbox';
  const queries = [];
  if (barcode) queries.push(`${barcode} neu preis ${negativeTerms}`);
  if (brand && mpn) queries.push(`${brand} ${mpn} neu preis ${negativeTerms}`);
  if (brand && title) queries.push(`${brand} ${title} neu preis ${negativeTerms}`);
  if (title) queries.push(`${title} neu preis ${negativeTerms}`);
  if (sku && sku !== title) queries.push(`${sku} neu preis ${negativeTerms}`);

  const tried = [];
  let results = [];
  let usedQuery = '';
  let usedEngine = null;

  for (const q of queries.slice(0, 3)) {
    for (const site of PRICE_MARKETPLACE_SITES) {
      const res = await searchEvidenceSite(q, site, { limit: 4, locale: 'de-DE' });
      tried.push({ q, site, ok: res.ok, engine: res.engine || null, error: res.error || null });
      if (res.ok && Array.isArray(res.results) && res.results.length) {
        results = res.results;
        usedQuery = `${q} site:${site}`;
        usedEngine = res.engine;
        break;
      }
    }
    if (results.length) break;
  }

  if (!results.length) {
    for (const q of queries.slice(0, 3)) {
      const res = await searchEvidence(q, { limit: 6, locale: 'de-DE' });
      tried.push({ q, site: null, ok: res.ok, engine: res.engine || null, error: res.error || null });
      if (res.ok && Array.isArray(res.results) && res.results.length) {
        results = res.results;
        usedQuery = q;
        usedEngine = res.engine;
        break;
      }
    }
  }

  const urls = (results || [])
    .map((r) => priceSafeString(r?.url))
    .filter((u) => u.startsWith('http'))
    .slice(0, 3);

  const sourceCandidates = [];
  for (const url of urls) {
    try {
      const html = await fetchHtmlForPrice(url);
      const pageTitle = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i)?.[1] || '';
      const textBlob = `${pageTitle} ${html.slice(0, 4000)}`;
      if (PRICE_USED_HINT.test(textBlob)) continue;
      const prices = extractPriceCandidates(html);
      if (prices.length) sourceCandidates.push({ url, prices });
    } catch {
      // ignore fetch failures
    }
  }

  if (!sourceCandidates.length) {
    return { ok: false, reason: 'no_price_found', usedQuery, usedEngine, tried, sources: [], amount: null };
  }

  const perSource = sourceCandidates
    .map((c) => {
      const representative = medianNumber(c.prices) ?? c.prices[0] ?? null;
      return { url: c.url, amount: representative };
    })
    .filter((x) => typeof x.amount === 'number' && Number.isFinite(x.amount));

  if (!perSource.length) {
    return { ok: false, reason: 'no_price_found', usedQuery, usedEngine, tried, sources: [], amount: null };
  }

  const target = medianNumber(perSource.map((x) => x.amount));
  const best =
    typeof target === 'number' && Number.isFinite(target)
      ? perSource
          .slice()
          .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target) || a.amount - b.amount)[0]
      : perSource.slice().sort((a, b) => a.amount - b.amount)[0];

  const timestamp = new Date().toISOString();
  const sources = perSource.slice(0, 5).map((c) => ({
    name: (() => {
      try {
        return new URL(c.url).host;
      } catch {
        return 'web';
      }
    })(),
    url: c.url,
    price: c.amount,
    checked_at: timestamp,
  }));

  return {
    ok: true,
    amount: best.amount,
    currency: 'EUR',
    sources,
    usedQuery,
    usedEngine,
    tried,
  };
}

async function enrichPriceForProductBestEffort(product, { force = false, reason = 'price-refresh' } = {}) {
  if (!product) return { ok: false, updated: false, error: 'product_missing' };
  product.details = product.details || {};
  product.details.pricing = product.details.pricing || {};

  const existing = product.details?.pricing?.lowest_price;
  if (!force && hasValidPriceEvidence(existing)) {
    return {
      ok: true,
      updated: false,
      data: {
        lowest_price: existing,
        price_confidence: product.details?.pricing?.price_confidence || 0.8,
      },
      serpTrace: [],
    };
  }

  const serpTrace = [];
  try {
    await ensurePriceCoverage([product], serpTrace, { force });
  } catch (e) {
    // best-effort: SerpAPI may be disabled
  }

  const afterSerp = product.details?.pricing?.lowest_price;
  if (hasValidPriceEvidence(afterSerp)) {
    product.ops = product.ops || {};
    product.ops.data_quality = product.ops.data_quality || {};
    product.ops.data_quality.price_enrich_v1 = {
      at_iso: new Date().toISOString(),
      via: 'serpapi',
      reason,
      sources: (afterSerp.sources || []).map((s) => s?.url).filter(Boolean).slice(0, 5),
    };
    return {
      ok: true,
      updated: true,
      data: {
        lowest_price: afterSerp,
        price_confidence: product.details?.pricing?.price_confidence || 0.8,
      },
      serpTrace,
    };
  }

  const web = await findWebPriceForProductV1(product);
  if (!web.ok || !web.amount || !Array.isArray(web.sources) || !web.sources.length) {
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([...(product.notes.warnings || []), 'Preis konnte nicht zuverlässig ermittelt werden – bitte prüfen.'])
    );
    return { ok: false, updated: false, error: web.reason || 'no_price_found', serpTrace };
  }

  const timestamp = new Date().toISOString();
  const data = {
    lowest_price: {
      amount: web.amount,
      currency: 'EUR',
      sources: web.sources,
      last_checked_iso: timestamp,
    },
    price_confidence: 0.75,
  };

  product.details.pricing.lowest_price = data.lowest_price;
  product.details.pricing.price_confidence = data.price_confidence;
  product.ops = product.ops || {};
  product.ops.data_quality = product.ops.data_quality || {};
  product.ops.data_quality.price_enrich_v1 = {
    at_iso: timestamp,
    via: 'web',
    reason,
    query: web.usedQuery || null,
    engine: web.usedEngine || null,
    sources: (web.sources || []).map((s) => s?.url).filter(Boolean).slice(0, 5),
  };

  return { ok: true, updated: true, data, serpTrace };
}

const normalizeIdentityKey = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.toLowerCase();
};

const buildSkuToProductIdMap = (products = []) => {
  const map = new Map();
  products.forEach((product) => {
    if (!product || !product.id) return;
    const productId = String(product.id);
    const addKey = (value) => {
      const key = normalizeIdentityKey(value);
      if (key) {
        map.set(key, productId);
        // Zusätzlich SKU-Präfix entfernen, um BIN-Einträge mit/ohne SKU- vorzureifizieren
        const trimmed = key.replace(/^sku[-_\\s]*/, '');
        if (trimmed && !map.has(trimmed)) {
          map.set(trimmed, productId);
        }
      }
    };
    addKey(productId);
    addKey(product.identification?.sku);
    addKey(product.details?.identifiers?.sku);
    addKey(product.details?.identifiers?.ean);
    addKey(product.details?.identifiers?.gtin);
    addKey(product.details?.identifiers?.upc);
  });
  return map;
};

const enrichProductsWithBinSummaries = async (products = []) => {
  if (!Array.isArray(products) || products.length === 0) return products;
  const productIds = products
    .map((product) => (product?.id ? String(product.id) : null))
    .filter(Boolean);
  if (!productIds.length) return products;

  const skuMap = buildSkuToProductIdMap(products);
  const summaryMap = await getProductBinSummaryMap(productIds, skuMap);

  return products.map((product) => {
    const key = product?.id ? String(product.id) : null;
    if (!key || !summaryMap.has(key)) {
      return product;
    }
    const summary = summaryMap.get(key);
    const mergedInventory = {
      ...(product.inventory || {}),
      quantity: summary.totalQuantity,
      physicalQuantity: summary.totalQuantity,
    };
    return {
      ...product,
      inventory: mergedInventory,
      storageBins: summary.bins,
    };
  });
};

const normalizeSkuKey = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-_\s]*/i, '')
    .replace(/\s+/g, '');

let EBAY_CATEGORY_ENTRIES = null;
let EBAY_CATEGORY_BY_ID = null;

const normalizeCategoryText = (value = '') =>
  value
    .toString()
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const getEbayCategoryEntries = () => {
  if (EBAY_CATEGORY_ENTRIES && EBAY_CATEGORY_BY_ID) {
    return { entries: EBAY_CATEGORY_ENTRIES, byId: EBAY_CATEGORY_BY_ID };
  }
  const filePath = path.join(__dirname, 'ebay-data', 'categories.json');
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const raw = require(filePath);
  const entries = [];
  const byId = new Map();
  Object.keys(raw || {}).forEach((key) => {
    const cat = raw[key];
    if (!cat) return;
    const id = cat.id ?? cat.categoryId ?? key;
    const breadcrumb = cat.breadcrumb || cat.path || cat.name || '';
    if (!id || !breadcrumb) return;
    const entry = {
      id: String(id),
      name: cat.name ? String(cat.name) : '',
      breadcrumb: String(breadcrumb),
    };
    entry.search = normalizeCategoryText(`${entry.breadcrumb} ${entry.name}`);
    entries.push(entry);
    byId.set(entry.id, entry);
  });
  EBAY_CATEGORY_ENTRIES = entries;
  EBAY_CATEGORY_BY_ID = byId;
  return { entries, byId };
};

const getEbayCategoryById = (id) => {
  if (!id) return null;
  const { byId } = getEbayCategoryEntries();
  const entry = byId.get(String(id));
  if (!entry) return null;
  return { id: entry.id, name: entry.name, breadcrumb: entry.breadcrumb };
};

const searchEbayCategories = (query, limit = 50) => {
  const needle = normalizeCategoryText(query);
  if (!needle || needle.length < 2) return [];
  const tokens = needle.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const { entries } = getEbayCategoryEntries();
  const results = [];
  for (const entry of entries) {
    const hay = entry.search || '';
    if (!hay) continue;
    let ok = true;
    for (const token of tokens) {
      if (!hay.includes(token)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const score = hay.indexOf(needle);
    results.push({
      entry,
      score: score === -1 ? 9999 : score,
      len: hay.length,
    });
  }
  results.sort((a, b) => a.score - b.score || a.len - b.len);
  return results.slice(0, limit).map(({ entry }) => ({
    id: entry.id,
    name: entry.name,
    breadcrumb: entry.breadcrumb,
  }));
};

async function buildReservedOpenOrderMap() {
  const map = new Map(); // normalizeSkuKey -> qty
  try {
    const snap = await firestore.collection('orders').where('status', '==', 'new').get();
    snap.forEach((doc) => {
      const order = doc.data() || {};
      const items = Array.isArray(order.items) ? order.items : [];
      for (const item of items) {
        const key = normalizeSkuKey(item?.sku || item?.productId || '');
        const qty = Number(item?.quantity || 0);
        if (!key || qty <= 0) continue;
        map.set(key, (map.get(key) || 0) + qty);
      }
    });
  } catch (error) {
    console.warn('buildReservedOpenOrderMap failed:', error.message);
  }
  return map;
}

function attachReservedAvailability(products = [], reservedMap) {
  if (!Array.isArray(products) || !products.length) return products;
  const map = reservedMap instanceof Map ? reservedMap : new Map();
  return products.map((product) => {
    const skuCandidate =
      product?.details?.identifiers?.sku || product?.identification?.sku || product?.id;
    const key = normalizeSkuKey(skuCandidate);
    const reservedQuantity = key ? Number(map.get(key) || 0) : 0;
    const physicalQuantity = Number(product?.inventory?.quantity || 0);
    const availableQuantity = Math.max(0, physicalQuantity - reservedQuantity);
    return {
      ...product,
      inventory: {
        ...(product.inventory || {}),
        physicalQuantity,
        reservedQuantity,
        availableQuantity,
      },
    };
  });
}

// --- Initialization ---
const app = express();
const MAX_IMAGE_FILES = 25;
const MAX_CHAT_ATTACHMENTS = parseInt(process.env.CHAT_ATTACHMENT_MAX_FILES || '6', 10);
const MAX_CHAT_ATTACHMENT_SIZE = parseInt(process.env.CHAT_ATTACHMENT_MAX_SIZE || `${6 * 1024 * 1024}`, 10); // 6 MB per attachment
const CHAT_ATTACHMENT_TEXT_LIMIT = parseInt(process.env.CHAT_ATTACHMENT_TEXT_LIMIT || '6000', 10);
const MAX_KTYPE_UPLOAD_SIZE = parseInt(process.env.KTYPE_UPLOAD_MAX_SIZE || `${10 * 1024 * 1024}`, 10); // 10 MB
const CHAT_ATTACHMENT_MIME_WHITELIST = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_IMAGE_FILE_SIZE = 8 * 1024 * 1024; // 8 MB per file, total tracked separately
const MAX_IMPROVE_BATCH = parseInt(process.env.MAX_IMPROVE_BATCH || '100', 10);
// IMPORTANT: Inline-Improve causes request timeouts for anything but tiny batches (Cloud Run / reverse proxies).
// Therefore it is OFF by default and must be explicitly enabled via IMPROVE_INLINE=true.
const IMPROVE_INLINE = (process.env.IMPROVE_INLINE ?? 'false') === 'true';
const GENERATED_IMAGE_SIGNATURE = /\b(generated|gpt|gemini|ai[-\s]?image|ai[-\s]?render)\b/i;
const JOB_STATUS_FILTERS = ['pending', 'processing', 'failed', 'done'];

function looksGeneratedImageMeta(image = {}) {
  if (!image || typeof image !== 'object') {
    return false;
  }
  const source = (image.source || '').toString().toLowerCase();
  const notes = (image.notes || '').toString().toLowerCase();
  return GENERATED_IMAGE_SIGNATURE.test(source) || GENERATED_IMAGE_SIGNATURE.test(notes);
}

function isVertexAiImage(image = {}) {
  if (!image || typeof image !== 'object') {
    return false;
  }
  const source = (image.source || '').toString().toLowerCase();
  const notes = (image.notes || '').toString().toLowerCase();
  return (
    source.includes('ai-derived') ||
    source.includes('vertex') ||
    /gemini/.test(source) ||
    /gemini/.test(notes) ||
    /vertex/.test(notes)
  );
}

const normalizeJobStatuses = (raw) => {
  if (!raw) {
    return null;
  }
  const values = Array.isArray(raw) ? raw : String(raw).split(',');
  const normalized = values
    .map((value) => value && value.toString().trim().toLowerCase())
    .filter((value) => value && JOB_STATUS_FILTERS.includes(value));
  return normalized.length ? Array.from(new Set(normalized)) : null;
};

// --- Helper: order sync best-effort in background; never block responses ---
const ORDER_SYNC_TIMEOUT_MS = parseInt(process.env.ORDER_SYNC_TIMEOUT_MS || '8000', 10);
const ORDER_SYNC_THROTTLE_MS = parseInt(process.env.ORDER_SYNC_THROTTLE_MS || '60000', 10);
let ordersSyncInFlight = false;
let lastOrdersSyncAtMs = 0;
const BASELINKER_AUTO_STOCK_SYNC = (process.env.BASELINKER_AUTO_STOCK_SYNC ?? 'true') === 'true';
const BASELINKER_AUTO_STOCK_SYNC_THROTTLE_MS = parseInt(
  process.env.BASELINKER_AUTO_STOCK_SYNC_THROTTLE_MS || '15000',
  10
);
const lastAutoStockSyncAtMs = new Map(); // productId -> epoch ms

function backgroundSyncOrders() {
  const now = Date.now();
  if (ordersSyncInFlight) return;
  if (Number.isFinite(lastOrdersSyncAtMs) && now - lastOrdersSyncAtMs < ORDER_SYNC_THROTTLE_MS) {
    return;
  }
  ordersSyncInFlight = true;
  lastOrdersSyncAtMs = now;

  const timer = setTimeout(() => {
    // best-effort safety: release lock even if something hangs
    ordersSyncInFlight = false;
  }, ORDER_SYNC_TIMEOUT_MS);

  syncNewOrders()
    .catch((err) => console.warn('Background order sync failed:', err?.message || err))
    .finally(() => {
      clearTimeout(timer);
      ordersSyncInFlight = false;
    });
}

function backgroundSyncProductStockToBaseLinker(product, reason = 'warehouse') {
  if (!BASELINKER_AUTO_STOCK_SYNC) return;
  const productId = product?.id ? String(product.id) : null;
  if (!productId) return;

  // Only auto-sync products that are linked/synced to BaseLinker to avoid creating accidental listings
  const hasLink = Boolean(product?.ops?.base_product_id || product?.ops?.baselinker?.product_id);
  if (!hasLink) return;

  const now = Date.now();
  const last = Number(lastAutoStockSyncAtMs.get(productId) || 0);
  if (Number.isFinite(last) && now - last < BASELINKER_AUTO_STOCK_SYNC_THROTTLE_MS) {
    return;
  }
  lastAutoStockSyncAtMs.set(productId, now);

  const invId = process.env.BASELINKER_INVENTORY_ID || '78659';
  // Best-effort background sync; never block warehouse ops responses
  setTimeout(() => {
    syncProductToBaseLinker(product, invId)
      .then((result) => {
        console.log(
          `[auto-sync-baselinker] reason=${reason} product=${productId} status=${result?.status || 'unknown'}`
        );
      })
      .catch((err) => {
        console.warn(
          `[auto-sync-baselinker] failed reason=${reason} product=${productId}:`,
          err?.message || err
        );
      });
  }, 0);
}

// Produkt-Vollständigkeit bewerten
function computeCompleteness(product = {}) {
  const missing = [];
  const details = product.details || {};
  const attrs = details.attributes || {};

  const hasSku =
    !!product.identification?.sku || !!details.identifiers?.sku;
  const hasName = !!product.identification?.name;
  const hasBrand = !!product.identification?.brand;
  const hasBarcode =
    !!details.identifiers?.ean ||
    !!details.identifiers?.gtin ||
    (Array.isArray(product.identification?.barcodes) && product.identification.barcodes.length > 0);
  const hasImages = Array.isArray(details.images) && details.images.length > 0;
  const hasDescription = !!(details.description || details.short_description);
  const lowest = details.pricing?.lowest_price;
  const priceCandidate =
    product.pricing?.price ??
    details.price ??
    (lowest && typeof lowest.amount === 'number' ? lowest.amount : null) ??
    product.inventory?.price ??
    null;
  const hasPrice = priceCandidate !== null && priceCandidate !== undefined && Number(priceCandidate) > 0;
  const categoryId =
    details.categoryId ||
    details.ebayCategoryId ||
    attrs.ebay_category_id ||
    attrs.ebayCategoryId ||
    attrs['ebay.category_id'];
  const hasCategory = !!categoryId;

  if (!hasSku) missing.push('sku');
  if (!hasName) missing.push('name');
  if (!hasBrand) missing.push('brand');
  if (!hasBarcode) missing.push('barcode');
  if (!hasImages) missing.push('images');
  if (!hasDescription) missing.push('description');
  if (!hasPrice) missing.push('price');
  if (!hasCategory) missing.push('category');

  const total = 8;
  const filled = total - missing.length;
  const percent = Math.round((filled / total) * 100);

  return {
    percent,
    missing,
    total,
    filled,
    complete: missing.length === 0,
  };
}

function isGhostProduct(product = {}) {
  const identification = product?.identification || {};
  const details = product?.details || {};
  const identifiers = details?.identifiers || {};
  const ops = product?.ops || {};

  const hasName = typeof identification?.name === 'string' && identification.name.trim().length > 0;
  const hasSku =
    (typeof identification?.sku === 'string' && identification.sku.trim().length > 0) ||
    (typeof identifiers?.sku === 'string' && identifiers.sku.trim().length > 0);
  const hasBarcode =
    Boolean(identifiers?.ean || identifiers?.gtin || identifiers?.upc) ||
    (Array.isArray(identification?.barcodes) && identification.barcodes.length > 0);
  const hasImages = Array.isArray(details?.images) && details.images.length > 0;
  const hasAttrs = details?.attributes && typeof details.attributes === 'object' && Object.keys(details.attributes).length > 0;
  const hasPricing = Boolean(details?.pricing?.lowest_price?.amount);
  const hasPendingIntake = Number(ops?.pending_intake_quantity || 0) > 0;
  const hasOpsLink = Boolean(ops?.base_product_id || ops?.baselinker?.product_id || ops?.sync_status);

  const invQty = Number(product?.inventory?.quantity || 0);
  const hasStock =
    (Number.isFinite(invQty) && invQty > 0) ||
    Boolean(product?.storage?.binCode) ||
    (Array.isArray(product?.storageBins) && product.storageBins.some((b) => Number(b?.quantity || 0) > 0));

  return !(
    hasName ||
    hasSku ||
    hasBarcode ||
    hasImages ||
    hasAttrs ||
    hasPricing ||
    hasPendingIntake ||
    hasOpsLink ||
    hasStock
  );
}

// Ensure API responses always have the minimum nested structure expected by the frontend.
// This prevents UI crashes when Firestore contains partial/stub documents.
function normalizeProductForApi(product = {}) {
  const p = product && typeof product === 'object' ? product : {};
  const identification =
    p.identification && typeof p.identification === 'object' ? p.identification : {};
  const details = p.details && typeof p.details === 'object' ? p.details : {};
  const identifiers =
    details.identifiers && typeof details.identifiers === 'object' ? details.identifiers : {};
  const pricing = details.pricing && typeof details.pricing === 'object' ? details.pricing : {};
  const lowest =
    pricing.lowest_price && typeof pricing.lowest_price === 'object' ? pricing.lowest_price : {};
  const ops = p.ops && typeof p.ops === 'object' ? p.ops : {};

  const images = Array.isArray(details.images) ? details.images.filter(Boolean) : [];
  const barcodes = Array.isArray(identification.barcodes)
    ? identification.barcodes.filter(Boolean)
    : [];

  return {
    ...p,
    identification: {
      ...identification,
      method: identification.method || 'image',
      name: identification.name || '',
      brand: identification.brand || '',
      category: identification.category || '',
      confidence: typeof identification.confidence === 'number' ? identification.confidence : 0,
      barcodes,
    },
    details: {
      ...details,
      short_description: details.short_description || '',
      key_features: Array.isArray(details.key_features) ? details.key_features.filter(Boolean) : [],
      attributes:
        details.attributes && typeof details.attributes === 'object' && !Array.isArray(details.attributes)
          ? details.attributes
          : {},
      identifiers: {
        ...identifiers,
      },
      images,
      pricing: {
        ...pricing,
        price_confidence: typeof pricing.price_confidence === 'number' ? pricing.price_confidence : 0,
        lowest_price: {
          ...lowest,
          amount: typeof lowest.amount === 'number' ? lowest.amount : 0,
          currency: lowest.currency || 'EUR',
          sources: Array.isArray(lowest.sources) ? lowest.sources : [],
        },
      },
    },
    ops: {
      ...ops,
      sync_status: ops.sync_status || 'pending',
      revision: typeof ops.revision === 'number' ? ops.revision : 0,
    },
    storageBins: Array.isArray(p.storageBins) ? p.storageBins : [],
  };
}

const summarizeJobPayload = (payload = {}) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const files = Array.isArray(payload.files)
    ? payload.files.map((file) => ({
      path: file?.path || null,
      originalName: file?.originalName || null,
      mimeType: file?.mimeType || null,
      size: Number.isFinite(file?.size) ? file.size : null,
    }))
    : [];
  return {
    locale: payload.locale || null,
    model: payload.model || null,
    barcodes: payload.barcodes || '',
    fileCount: files.length,
    files,
  };
};

const summarizeJobResult = (job = {}) => {
  if (!job || !job.result) {
    return null;
  }
  const products = Array.isArray(job.result?.products) ? job.result.products : [];
  if (!products.length) {
    return { productCount: 0, products: [] };
  }
  return {
    productCount: products.length,
    products: products.slice(0, 5).map((product) => ({
      id: product?.id || null,
      name: product?.identification?.name || product?.details?.identifiers?.sku || null,
      sku:
        product?.identification?.sku ||
        product?.details?.identifiers?.sku ||
        product?.details?.identifiers?.ean ||
        null,
    })),
  };
};

const formatJobForResponse = (job = {}) => ({
  id: job.id,
  status: job.status,
  attempts: job.attempts || 0,
  createdAt: job.createdAt || null,
  updatedAt: job.updatedAt || null,
  startedAt: job.startedAt || null,
  finishedAt: job.finishedAt || null,
  model: job.modelUsed || job.payload?.model || null,
  payload: summarizeJobPayload(job.payload),
  error: job.error || null,
  result: summarizeJobResult(job),
  reuseEvents: Array.isArray(job.reuseEvents) ? job.reuseEvents : undefined,
});
const allowedOrigins = [
  'https://avycloud.web.app',
  'https://avycloud.firebaseapp.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
];
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_FILE_SIZE,
    files: MAX_IMAGE_FILES,
  },
});

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_CHAT_ATTACHMENT_SIZE,
    files: MAX_CHAT_ATTACHMENTS,
  },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    if (CHAT_ATTACHMENT_MIME_WHITELIST.has(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error('UNSUPPORTED_CHAT_ATTACHMENT'));
  },
});

const ktypeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_KTYPE_UPLOAD_SIZE,
    files: 1,
  },
  fileFilter(req, file, cb) {
    const name = (file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    const looksCsv =
      name.endsWith('.csv') ||
      mime.includes('text/csv') ||
      mime.includes('application/vnd.ms-excel') ||
      mime.includes('application/csv');
    if (looksCsv) return cb(null, true);
    return cb(new Error('UNSUPPORTED_KTYPE_FILE'));
  },
});

const chatUploadMiddleware = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    return chatUpload.array('attachments', MAX_CHAT_ATTACHMENTS)(req, res, (error) => {
      if (error) {
        const message =
          error.message === 'UNSUPPORTED_CHAT_ATTACHMENT'
            ? 'Unsupported attachment type. Allowed: JPG, PNG, WEBP, PDF, TXT, CSV, JSON.'
            : error.message;
        return res.status(400).json({
          ok: false,
          error: {
            code: 400,
            message,
          },
        });
      }
      return next();
    });
  }
  return next();
};

const ktypeUploadMiddleware = (req, res, next) =>
  ktypeUpload.single('file')(req, res, (error) => {
    if (error) {
      const message =
        error.message === 'UNSUPPORTED_KTYPE_FILE'
          ? 'Unsupported file type. Please upload a CSV file.'
          : error.message;
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message,
        },
      });
    }
    return next();
  });

startJobRunner();
startImproveRunner();
startQualityRunner();
startBaseLinkerSyncRunner();
startRulebookRunner();
try {
  startAdminBulkRunner();
} catch (e) {
  console.warn('[AdminBulkRunner] failed to start (non-blocking):', e?.message || e);
}
ensureDefaultRoles()
  .then(() => console.log('RBAC default roles ensured.'))
  .catch((error) => console.error('RBAC role seeding failed:', error));
ensureBootstrapAdmin()
  .then((r) => console.log(`Bootstrap admin ensured (${r.email})${r.created ? ' [created]' : ''}`))
  .catch((error) => console.error('Bootstrap admin failed:', error));
ensureDefaultLlmScopes()
  .then(async () => {
    console.log('LLM scopes ensured.');
    try {
      const { ensureDefaultLlmScopeVersions } = require('./lib/llm-config');
      await ensureDefaultLlmScopeVersions();
      console.log('LLM default scope versions ensured.');
    } catch (e) {
      console.error('LLM default version seeding failed:', e?.message || e);
    }
  })
  .catch((error) => console.error('LLM scope seeding failed:', error));
syncInventoriesFromBaseLinker()
  .then((result) => {
    console.log(`Initial inventory sync completed (${result.fetched} entries)`);
  })
  .catch((error) => {
    console.error('Initial inventory sync failed:', error);
  });


// --- Middleware ---
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      ok: false,
      error: {
        code: 403,
        message: 'Origin not allowed by CORS policy.',
      },
    });
  }
  return next(err);
});
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// --- API Endpoints ---

app.get('/', (req, res) => {
  res.status(200).send('Product Intelligence Backend is running.');
});

// Default-deny: everything under /api requires authentication by default.
// Allowlist endpoints that must be public for technical reasons (e.g., <img src> cannot send headers).
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/image-proxy') return next();
  if (req.path === '/auth/password-reset') return next();
  return requireAuth(req, res, next);
});

// --- Public Auth API ---
app.post('/api/auth/password-reset', async (req, res) => {
  try {
    const email = req.body?.email;
    await requestPasswordReset({ email, ip: req.ip });
    // Always return success (anti-enumeration). Rate-limit is still enforced via 429.
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Password reset failed' } });
  }
});

// --- Admin API (RBAC-managed) ---
app.get('/api/admin/users', requirePermission('admin', 'users.read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 500, 1), 1000);
    const users = await listUsersAdmin({ limit });
    res.json({ ok: true, data: users });
  } catch (error) {
    console.error('Admin list users failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list users' } });
  }
});

app.post('/api/admin/users', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const email = req.body?.email;
    const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
    const result = await inviteUser({ actorUid: req.user?.uid, email, roles });
    res.json({ ok: true, data: { uid: result.uid, email: result.email } });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin invite user failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Invite failed' } });
  }
});

app.put('/api/admin/users/:uid/roles', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const targetUid = req.params?.uid;
    const roles = Array.isArray(req.body?.roles) ? req.body.roles : [];
    await setUserRolesAdmin({ actorUid: req.user?.uid, targetUid, roles });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin set user roles failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to set roles' } });
  }
});

app.put('/api/admin/users/:uid/groups', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const targetUid = req.params?.uid;
    const groupIds = Array.isArray(req.body?.groupIds) ? req.body.groupIds : [];
    await setUserGroupsAdmin({ actorUid: req.user?.uid, targetUid, groupIds });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin set user groups failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to set groups' } });
  }
});

app.put('/api/admin/users/:uid/overrides', requirePermission('admin', 'users.write'), async (req, res) => {
  try {
    const targetUid = req.params?.uid;
    const overrides = req.body?.overrides || req.body || {};
    await setUserOverridesAdmin({ actorUid: req.user?.uid, targetUid, overrides });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin set user overrides failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to set overrides' } });
  }
});

app.get('/api/admin/groups', requirePermission('admin', 'groups.read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 200, 1), 1000);
    const groups = await listGroupsAdmin({ limit });
    res.json({ ok: true, data: groups });
  } catch (error) {
    console.error('Admin list groups failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list groups' } });
  }
});

app.post('/api/admin/groups', requirePermission('admin', 'groups.write'), async (req, res) => {
  try {
    const name = req.body?.name;
    const groupId = req.body?.groupId;
    const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds : [];
    const created = await createGroupAdmin({ actorUid: req.user?.uid, name, groupId, roleIds });
    res.json({ ok: true, data: created });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin create group failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to create group' } });
  }
});

app.put('/api/admin/groups/:groupId', requirePermission('admin', 'groups.write'), async (req, res) => {
  try {
    const groupId = req.params?.groupId;
    const patch = req.body || {};
    await updateGroupAdmin({ actorUid: req.user?.uid, groupId, patch });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin update group failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to update group' } });
  }
});

app.delete('/api/admin/groups/:groupId', requirePermission('admin', 'groups.write'), async (req, res) => {
  try {
    const groupId = req.params?.groupId;
    await deleteGroupAdmin({ actorUid: req.user?.uid, groupId });
    res.status(204).send();
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin delete group failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to delete group' } });
  }
});

app.get('/api/admin/roles', requirePermission('admin', 'roles.read'), async (req, res) => {
  try {
    const roles = await listRolesAdmin();
    res.json({ ok: true, data: roles });
  } catch (error) {
    console.error('Admin list roles failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list roles' } });
  }
});

app.put('/api/admin/roles/:roleId', requirePermission('admin', 'roles.write'), async (req, res) => {
  try {
    const roleId = req.params?.roleId;
    const patch = req.body || {};
    await updateRoleAdmin({ actorUid: req.user?.uid, roleId, patch });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin update role failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to update role' } });
  }
});

// --- LLM Management (RBAC-managed) ---
app.get('/api/admin/llm/scopes', requirePermission('admin', 'llm.read'), async (req, res) => {
  try {
    const scopes = await listLlmScopes();
    res.json({ ok: true, data: scopes });
  } catch (error) {
    console.error('Admin list LLM scopes failed:', error);
    res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to list llm scopes' } });
  }
});

// --- Rulebook Management (RBAC-managed) ---
const { getActiveRulebook, createRulebookVersion } = require('./lib/rulebook-admin');
const { createJob: createRulebookApplyJob, getJob: getRulebookApplyJob } = require('./lib/rulebook-apply-jobs');
const { enqueueRulebookJob } = require('./services/rulebook-runner');

app.get('/api/admin/rulebook', requirePermission('admin', 'rules.read'), async (req, res) => {
  try {
    const active = await getActiveRulebook();
    return res.status(200).json({ ok: true, data: active });
  } catch (error) {
    console.error('Failed to load rulebook:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load rulebook', details: error.message } });
  }
});

app.put('/api/admin/rulebook', requirePermission('admin', 'rules.write'), async (req, res) => {
  try {
    const config = req.body?.config;
    const note = req.body?.note || null;
    const updatedBy = req.user?.email || req.user?.uid || 'admin';
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'config object required' } });
    }
    const version = await createRulebookVersion({ config, note, updatedBy });
    return res.status(200).json({ ok: true, data: { versionId: version.id } });
  } catch (error) {
    console.error('Failed to update rulebook:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to update rulebook', details: error.message } });
  }
});

app.post('/api/admin/rulebook/apply', requirePermission('admin', 'jobs.run'), async (req, res) => {
  try {
    const invId = String(req.body?.inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
    const limit = Number(req.body?.limit || 0);
    const chunkSize = Number(req.body?.chunkSize || 200);
    const minQty =
      req.body?.minQty != null && String(req.body.minQty).trim() !== '' ? Math.max(1, Math.min(9999, Number(req.body.minQty))) : null;
    const requireBin = typeof req.body?.requireBin === 'boolean' ? req.body.requireBin : null;
    const job = await createRulebookApplyJob({
      payload: { inventoryId: invId, limit, chunkSize, minQty, requireBin },
      requestedBy: req.user?.email || req.user?.uid || 'admin',
    });
    enqueueRulebookJob(job.id, true);
    return res.status(202).json({ ok: true, data: { jobId: job.id } });
  } catch (error) {
    console.error('Failed to enqueue rulebook apply job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to enqueue rulebook job', details: error.message } });
  }
});

app.get('/api/admin/rulebook/apply/:id', requirePermission('admin', 'jobs.read'), async (req, res) => {
  try {
    const job = await getRulebookApplyJob(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    return res.status(200).json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load rulebook apply job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load rulebook apply job', details: error.message } });
  }
});

// --- Admin Metrics (RBAC-managed) ---
// Small dashboard metrics for Admin Panel (product coverage for GPSR and K-Typ, title health).
// NOTE: This endpoint currently scans products (OK for ~hundreds). If the dataset grows,
// we should move to an aggregated collection / scheduled job.
app.get('/api/admin/metrics/product-coverage', requirePermission('admin', 'users.read'), async (req, res) => {
  try {
    const { getAllProducts } = require('./lib/firestore');
    const { getVehicleFitmentMode } = require('./lib/vehicle-fitment');
    const { coerceTitleToPolicy, validateTitleToPolicy, inferTitleCategory } = require('./lib/title-policy');
    const { getRulebookConfigCached } = require('./lib/rulebook-config');
    const { normalizeManufacturerKey, normalizeGpsrObject } = require('./lib/gpsr-manufacturer-registry');
    const products = await getAllProducts();

    const safe = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
    const lower = (v) => safe(v).toLowerCase();
    const isPlaceholder = (val) => {
      const v = lower(val);
      if (!v) return false;
      return (
        v.includes('musterstraße') ||
        v.includes('muster str') ||
        v.includes('musterstadt') ||
        v.includes('musterbundesland') ||
        v === '12345' ||
        v.includes('info@muster') ||
        v.includes('+49 000') ||
        v === 'germany'
      );
    };

    const gpsrRequired = [
      'entity_country',
      'manufacturer_address',
      'manufacturer_city',
      'manufacturer_postalcode',
      'manufacturer_state_province',
      'manufacturer_name',
      'email',
      'manufacturer_phone',
    ];

    // Histogram uses "non-placeholder" values (so 8/8 means truly complete).
    const gpsrRequiredFilledHistogram = {}; // filledCount(no placeholders) -> number of products
    const gpsrRequiredFilledHistogramIncludingPlaceholders = {}; // filledCount(non-empty incl placeholders) -> number of products
    const totalProducts = Array.isArray(products) ? products.length : 0;

    // Title policy (rule-conform):
    // - strict compliance: validateTitleToPolicy has NO issues AND title length is within [idealMinLen..idealMaxLen]
    // - rulebook compliance: validateTitleToPolicy has NO issues (length may vary if data is missing)
    const cfg = getRulebookConfigCached();
    const idealMinLen = 65;
    const idealMaxLen = 75;
    const hardMaxLen = Number(cfg?.title?.maxLen || 80);
    const defaultMobileMaxLen = Number(cfg?.title?.mobileMaxLen || 60);

    let titlePolicyOk = 0;
    let titlePolicyNotOk = 0;
    let titleIdealLenOk = 0;
    let ktypWithValue = 0;
    let gpsrAnyFieldPresent = 0;
    let gpsrFullRequiredPresent = 0;
    let gpsrFullRequiredNoPlaceholders = 0;
    let gpsrCandidatesNeedingEnrich = 0;

    // Drilldown buckets
    const titleNotOkIds = [];
    const titleOkIds = [];
    const titleNotIdealLenIds = [];
    let ktypFitmentTotal = 0;
    const ktypWithValueIds = [];
    const ktypMissingInFitmentIds = [];
    const gpsrFilledCountIds = {}; // filledCount(no placeholders) -> ids[]
    const gpsrFilledCountInclPlaceholdersIds = {}; // filledCount(non-empty) -> ids[]
    const gpsrFullRequiredIds = [];
    const gpsrFullRequiredNoPlaceholdersIds = [];
    const gpsrCandidatesNeedingEnrichIds = [];

    // Price sanity (optional bounds via query: ?minPrice=&maxPrice=)
    const minPrice =
      req.query?.minPrice != null && String(req.query.minPrice).trim() !== '' ? Number(req.query.minPrice) : null;
    const maxPrice =
      req.query?.maxPrice != null && String(req.query.maxPrice).trim() !== '' ? Number(req.query.maxPrice) : null;
    const priceMissingIds = [];
    const priceOkIds = [];
    const priceOutOfRangeIds = [];
    const priceNoSourcesIds = [];
    const priceStaleIds = [];
    const priceLowConfidenceIds = [];
    const priceSimilarMatchIds = [];
    const priceMaxAgeDays =
      req.query?.priceMaxAgeDays != null && String(req.query.priceMaxAgeDays).trim() !== ''
        ? Math.max(0, Number(req.query.priceMaxAgeDays) || 0)
        : 14;
    const daysSinceIso = (iso) => {
      if (!iso) return Infinity;
      const t = Date.parse(String(iso));
      if (!Number.isFinite(t)) return Infinity;
      return (Date.now() - t) / (1000 * 60 * 60 * 24);
    };
    const hasSimilarPriceWarning = (p) => {
      const warnings = Array.isArray(p?.notes?.warnings) ? p.notes.warnings : [];
      return warnings.some((w) => String(w || '').includes('Preis basiert auf ähnlichem Produkt (Specs-Match)'));
    };

    // Main categories (top-level only)
    const mainCategoryCounts = {};
    const mainCategoryIds = {};
    const metricErrors = [];

    const hasBin = (p) => {
      const direct = safe(p?.storage?.binCode);
      if (direct) return true;
      const bins = Array.isArray(p?.storageBins) ? p.storageBins : [];
      return bins.some((b) => safe(b?.code || b?.binCode) && (Number(b?.quantity) || 0) > 0);
    };
    const pickQty = (p) => {
      const inv = p?.inventory?.quantity;
      if (typeof inv === 'number' && Number.isFinite(inv) && inv >= 0) return inv;
      const bins = Array.isArray(p?.storageBins) ? p.storageBins : [];
      return bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
    };
    const pickCategoryId = (p) =>
      safe(p?.details?.categoryId) || safe(p?.details?.ebayCategoryId) || safe(p?.details?.ebay_category_id) || '';
    const isFitmentCategory = (p) => {
      const catId = pickCategoryId(p);
      if (!catId) return false;
      try {
        return Boolean(getVehicleFitmentMode(String(catId)));
      } catch {
        return false;
      }
    };
    const hasKTyp = (p) => {
      const attrs = p?.details?.attributes && typeof p.details.attributes === 'object' ? p.details.attributes : {};
      const key = Object.keys(attrs).find((k) => {
        const l = lower(k);
        return l === 'k-typ' || l === 'ktyp' || l === 'k typ';
      });
      return Boolean(key && safe(attrs[key]));
    };
    const pickPrice = (p) => {
      // Prefer canonical amount field, fallback to legacy price.
      const lp = p?.details?.pricing?.lowest_price || {};
      const v = lp?.amount != null ? lp.amount : lp?.price;
      const n = typeof v === 'string' ? Number(String(v).replace(',', '.')) : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const pickMainCategory = (p) => {
      const raw = safe(p?.identification?.category);
      if (!raw) return 'Uncategorized';
      const first = raw.split('>').map((x) => safe(x)).filter(Boolean)[0];
      return first || 'Uncategorized';
    };

    // --- GPSR Registry variance monitoring (Brand == Hersteller) ---
    const stableJson = (obj) => {
      const o = obj && typeof obj === 'object' ? obj : {};
      const keys = Object.keys(o).sort();
      const out = {};
      keys.forEach((k) => {
        out[k] = o[k];
      });
      return JSON.stringify(out);
    };

    // Load registry once (small collection) to avoid N Firestore reads.
    const registryByKey = new Map(); // normalizedBrandKey -> normalized gpsr
    try {
      const snap = await firestore.collection('gpsrManufacturers').get();
      snap.forEach((doc) => {
        const data = doc.data() || {};
        const gpsr = normalizeGpsrObject(data.gpsr);
        if (gpsr && Object.keys(gpsr).length) {
          registryByKey.set(String(doc.id || '').trim(), gpsr);
        }
      });
    } catch (e) {
      // non-blocking: registry metrics will degrade gracefully
    }
    const gpsrRegistryStats = new Map(); // brandKey -> { brand, total, distinctGpsr, mismatchingRegistry, missingRegistry }

    for (const p of Array.isArray(products) ? products : []) {
      try {
      const pid = safe(p?.id);
      const currentTitle = safe(p?.identification?.name);
      const bucket = inferTitleCategory(p);
      const bySchema = cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
      const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
      const minLen = Number(rule?.minLen || idealMinLen);
      const softMaxLen = Number(rule?.softMaxLen || idealMaxLen);
      const maxLen = Number(rule?.maxLen || hardMaxLen);
      const ruleMobileMaxLen = Number(rule?.mobileMaxLen || defaultMobileMaxLen);

      // IMPORTANT: For metrics, validate the *stored* title, not a hypothetical coerced title.
      const issues = validateTitleToPolicy(p, currentTitle, { maxLen, mobileMaxLen: ruleMobileMaxLen }) || [];
      const ok = Array.isArray(issues) ? issues.length === 0 : true;
      const len = safe(currentTitle).length;
      const idealOk = ok && len >= idealMinLen && len <= idealMaxLen;

      if (ok) {
        titlePolicyOk += 1;
        if (pid) titleOkIds.push(pid);
      } else {
        titlePolicyNotOk += 1;
        if (pid) titleNotOkIds.push(pid);
      }
      if (idealOk) {
        titleIdealLenOk += 1;
      } else if (pid) {
        titleNotIdealLenIds.push(pid);
      }

      const fitment = isFitmentCategory(p);
      if (fitment) ktypFitmentTotal += 1;
      const ktyp = hasKTyp(p);
      if (ktyp) {
        ktypWithValue += 1;
        if (pid) ktypWithValueIds.push(pid);
      } else if (fitment && pid) {
        ktypMissingInFitmentIds.push(pid);
      }

      const g = p?.details?.gpsr && typeof p.details.gpsr === 'object' ? p.details.gpsr : {};

      // Registry monitoring (per brand)
      const brand = safe(p?.identification?.brand);
      if (brand) {
        const brandKey = normalizeManufacturerKey(brand);
        if (brandKey) {
          const rec =
            gpsrRegistryStats.get(brandKey) || {
              brand,
              total: 0,
              distinctGpsr: new Set(),
              mismatchingRegistry: 0,
              missingRegistry: 0,
            };
          rec.total += 1;
          const normalized = normalizeGpsrObject(g);
          rec.distinctGpsr.add(stableJson(normalized));
          const registryGpsr = registryByKey.get(brandKey) || null;
          if (!registryGpsr) {
            rec.missingRegistry += 1;
          } else {
            const same = stableJson(normalized) === stableJson(registryGpsr);
            if (!same) rec.mismatchingRegistry += 1;
          }
          gpsrRegistryStats.set(brandKey, rec);
        }
      }

      if (gpsrRequired.some((k) => safe(g[k]))) gpsrAnyFieldPresent += 1;

      const filledNonEmpty = gpsrRequired.reduce((n, k) => (safe(g[k]) ? n + 1 : n), 0);
      gpsrRequiredFilledHistogramIncludingPlaceholders[String(filledNonEmpty)] =
        (gpsrRequiredFilledHistogramIncludingPlaceholders[String(filledNonEmpty)] || 0) + 1;
      if (pid) {
        gpsrFilledCountInclPlaceholdersIds[String(filledNonEmpty)] =
          gpsrFilledCountInclPlaceholdersIds[String(filledNonEmpty)] || [];
        gpsrFilledCountInclPlaceholdersIds[String(filledNonEmpty)].push(pid);
      }

      const filledNoPH = gpsrRequired.reduce((n, k) => {
        const v = safe(g[k]);
        return v && !isPlaceholder(v) ? n + 1 : n;
      }, 0);
      gpsrRequiredFilledHistogram[String(filledNoPH)] = (gpsrRequiredFilledHistogram[String(filledNoPH)] || 0) + 1;
      if (pid) {
        gpsrFilledCountIds[String(filledNoPH)] = gpsrFilledCountIds[String(filledNoPH)] || [];
        gpsrFilledCountIds[String(filledNoPH)].push(pid);
      }

      const full = gpsrRequired.every((k) => safe(g[k]));
      if (full) {
        gpsrFullRequiredPresent += 1;
        if (pid) gpsrFullRequiredIds.push(pid);
      }

      const fullNoPH = gpsrRequired.every((k) => {
        const v = safe(g[k]);
        return v && !isPlaceholder(v);
      });
      if (fullNoPH) {
        gpsrFullRequiredNoPlaceholders += 1;
        if (pid) gpsrFullRequiredNoPlaceholdersIds.push(pid);
      }

      const needsGpsr = gpsrRequired.some((k) => {
        const v = safe(g[k]);
        return !v || isPlaceholder(v);
      });
      if (hasBin(p) && pickQty(p) >= 1 && needsGpsr) {
        gpsrCandidatesNeedingEnrich += 1;
        if (pid) gpsrCandidatesNeedingEnrichIds.push(pid);
      }

      // Price buckets
      const price = pickPrice(p);
      if (price == null || price <= 0) {
        if (pid) priceMissingIds.push(pid);
      } else {
        const lp = p?.details?.pricing?.lowest_price || {};
        const src = Array.isArray(lp?.sources) ? lp.sources : [];
        if (!src.length && pid) priceNoSourcesIds.push(pid);
        const conf = p?.details?.pricing?.price_confidence;
        if (typeof conf === 'number' && Number.isFinite(conf) && conf > 0 && conf < 0.5 && pid) {
          priceLowConfidenceIds.push(pid);
        }
        if (priceMaxAgeDays > 0 && daysSinceIso(lp?.last_checked_iso) > priceMaxAgeDays && pid) {
          priceStaleIds.push(pid);
        }
        if (hasSimilarPriceWarning(p) && pid) priceSimilarMatchIds.push(pid);
        const outOfRange =
          (Number.isFinite(minPrice) && minPrice != null && price < minPrice) ||
          (Number.isFinite(maxPrice) && maxPrice != null && price > maxPrice);
        if (outOfRange) {
          if (pid) priceOutOfRangeIds.push(pid);
        } else {
          if (pid) priceOkIds.push(pid);
        }
      }

      // Main category distribution
      const main = pickMainCategory(p);
      mainCategoryCounts[main] = (mainCategoryCounts[main] || 0) + 1;
      if (pid) {
        mainCategoryIds[main] = mainCategoryIds[main] || [];
        mainCategoryIds[main].push(pid);
      }
      } catch (e) {
        // Never fail the whole dashboard due to one bad product shape.
        // Keep only a small sample to avoid huge payloads.
        if (metricErrors.length < 20) {
          metricErrors.push({
            id: safe(p?.id),
            message: e?.message || String(e),
          });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      data: {
        totalProducts,
        title: {
          policyOkCount: titlePolicyOk,
          policyNotOkCount: titlePolicyNotOk,
          idealLenOkCount: titleIdealLenOk,
          idealMinLen,
          idealMaxLen,
          hardMaxLen,
          mobileMaxLen: defaultMobileMaxLen,
        },
        ktyp: { withValue: ktypWithValue, fitmentTotal: ktypFitmentTotal },
        gpsr: {
          requiredFields: gpsrRequired,
          requiredFilledHistogram: gpsrRequiredFilledHistogram,
          requiredFilledHistogramIncludingPlaceholders: gpsrRequiredFilledHistogramIncludingPlaceholders,
          anyFieldPresent: gpsrAnyFieldPresent,
          fullRequiredFieldsPresent: gpsrFullRequiredPresent,
          fullRequiredFieldsNoPlaceholders: gpsrFullRequiredNoPlaceholders,
          candidatesNeedingEnrich: gpsrCandidatesNeedingEnrich,
        },
        gpsr_registry: (() => {
          const entries = Array.from(gpsrRegistryStats.entries()).map(([brandKey, rec]) => ({
            brandKey,
            brand: rec.brand,
            total: rec.total,
            distinctGpsr: rec.distinctGpsr.size,
            mismatchingRegistry: rec.mismatchingRegistry,
            missingRegistry: rec.missingRegistry,
          }));
          const brandsTotal = entries.length;
          const brandsWithVariance = entries.filter((e) => e.distinctGpsr > 1).length;
          const brandsMissingRegistry = entries.filter((e) => e.missingRegistry === e.total).length;
          const productsMismatchingRegistry = entries.reduce((s, e) => s + (Number(e.mismatchingRegistry) || 0), 0);
          const topBrandsByMismatch = [...entries]
            .filter((e) => (e.mismatchingRegistry || 0) > 0)
            .sort((a, b) => (b.mismatchingRegistry - a.mismatchingRegistry) || (b.total - a.total))
            .slice(0, 12);
          return {
            brandsTotal,
            brandsWithVariance,
            brandsMissingRegistry,
            productsMismatchingRegistry,
            topBrandsByMismatch,
          };
        })(),
        price: {
          minPrice: Number.isFinite(minPrice) ? minPrice : null,
          maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
          missingCount: priceMissingIds.length,
          okCount: priceOkIds.length,
          outOfRangeCount: priceOutOfRangeIds.length,
          noSourcesCount: priceNoSourcesIds.length,
          staleCount: priceStaleIds.length,
          lowConfidenceCount: priceLowConfidenceIds.length,
          similarMatchCount: priceSimilarMatchIds.length,
          priceMaxAgeDays,
        },
        categories: {
          mainCategoryCounts,
        },
        errors: metricErrors.length ? { count: metricErrors.length, sample: metricErrors } : null,
        buckets: {
          titleOkIds,
          titleNotOkIds,
          titleNotIdealLenIds,
          ktypWithValueIds,
          ktypMissingInFitmentIds,
          gpsrFilledCountIds,
          gpsrFilledCountInclPlaceholdersIds,
          gpsrFullRequiredIds,
          gpsrFullRequiredNoPlaceholdersIds,
          gpsrCandidatesNeedingEnrichIds,
          priceMissingIds,
          priceOkIds,
          priceOutOfRangeIds,
          priceNoSourcesIds,
          priceStaleIds,
          priceLowConfidenceIds,
          priceSimilarMatchIds,
          mainCategoryIds,
        },
      },
    });
  } catch (error) {
    console.error('Error in GET /api/admin/metrics/product-coverage:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to compute product coverage metrics', details: error.message },
    });
  }
});

// --- Admin Bulk Actions (consolidated) ---
// Creates an async job in Firestore and processes it via AdminBulkRunner.
app.post('/api/admin/bulk/run', requirePermission('admin', 'jobs.run'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '').trim().toLowerCase();
    if (!action) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing action' } });
    }
    const payload = {
      action,
      apply: Boolean(body.apply),
      limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : 500,
      offset: Number.isFinite(Number(body.offset)) ? Number(body.offset) : 0,
      debug: Boolean(body.debug),
      maxAgeDays: Number.isFinite(Number(body.maxAgeDays)) ? Number(body.maxAgeDays) : undefined,
      includeUi: Boolean(body.includeUi),
      requestedBy: req.user?.email || req.user?.uid || 'admin',
    };

    const job = await createAdminBulkJob({ payload, requestedBy: payload.requestedBy, action });
    enqueueAdminBulkJob(job.id, true);
    return res.status(202).json({ ok: true, data: { jobId: job.id } });
  } catch (error) {
    console.error('Failed to enqueue admin bulk job:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to enqueue admin bulk job', details: error.message },
    });
  }
});

app.get('/api/admin/bulk/jobs/:id', requirePermission('admin', 'jobs.read'), async (req, res) => {
  try {
    const job = await getAdminBulkJob(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    return res.status(200).json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load admin bulk job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load job', details: error.message } });
  }
});

// --- Product Bulk Actions (selected products from Inventory table) ---
// Same engine as AdminBulk, but permission is products.write (so Catalog/Admin can use it from inventory UI).
app.post('/api/products/bulk/run', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const action = String(body.action || '').trim().toLowerCase();
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    if (!action) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing action' } });
    }
    if (!productIds.length) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing productIds' } });
    }
    const payload = {
      action,
      productIds,
      apply: body.apply !== false, // default true
      debug: Boolean(body.debug),
      maxAgeDays: Number.isFinite(Number(body.maxAgeDays)) ? Number(body.maxAgeDays) : undefined,
      force: Boolean(body.force),
      includeUi: Boolean(body.includeUi),
      requestedBy: req.user?.email || req.user?.uid || 'user',
    };
    const job = await createAdminBulkJob({ payload, requestedBy: payload.requestedBy, action });
    enqueueAdminBulkJob(job.id, true);
    return res.status(202).json({ ok: true, data: { jobId: job.id } });
  } catch (error) {
    console.error('Failed to enqueue product bulk job:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to enqueue bulk job', details: error.message },
    });
  }
});

app.get('/api/products/bulk/jobs/:id', requirePermission('products', 'read'), async (req, res) => {
  try {
    const job = await getAdminBulkJob(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    return res.status(200).json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load product bulk job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load job', details: error.message } });
  }
});

// --- eBay Integration (OAuth + listing snapshots) ---
// References:
// - Consent request: https://developer.ebay.com/api-docs/static/oauth-consent-request.html
// - Auth code exchange: https://developer.ebay.com/api-docs/static/oauth-auth-code-grant-request.html
// - Refresh token: https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html
// - getOffers (by SKU): https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffers

app.get('/api/ebay/oauth/start', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { createOAuthState, buildConsentUrl } = require('./lib/ebay-oauth');
    const locale = typeof req.query?.locale === 'string' ? req.query.locale : 'de-DE';
    const prompt = req.query?.prompt === 'login' ? 'login' : null;
    const state = await createOAuthState({ provider: 'ebay', actor: req.user || null });
    const url = await buildConsentUrl({ state, locale, prompt });
    return res.status(200).json({ ok: true, data: { url } });
  } catch (error) {
    console.error('Failed to start eBay OAuth:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to start eBay OAuth', details: error.message },
    });
  }
});

// NOTE: callback is called by eBay redirect → no Authorization header.
app.get('/api/ebay/oauth/callback', async (req, res) => {
  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  const state = typeof req.query?.state === 'string' ? req.query.state : '';
  try {
    if (!code || !state) {
      return res.status(400).send('Missing code/state');
    }
    const {
      consumeOAuthState,
      exchangeAuthorizationCodeForToken,
      upsertEbayTokenSet,
    } = require('./lib/ebay-oauth');

    const consumed = await consumeOAuthState(state, 'ebay');
    if (!consumed) {
      return res.status(400).send('Invalid state');
    }

    const tokenSet = await exchangeAuthorizationCodeForToken({ code });
    await upsertEbayTokenSet(tokenSet, { actor: consumed?.actor || null });

    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>AvyCloud – eBay</title></head>
  <body style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto; padding: 24px;">
    <h2>eBay Verbindung hergestellt</h2>
    <p>Du kannst dieses Fenster jetzt schließen.</p>
    <script>
      (function () {
        try {
          if (window.opener) {
            window.opener.postMessage({ type: 'avycloud:ebay_oauth_complete' }, '*');
          }
        } catch (e) {}
        try { window.close(); } catch (e) {}
      })();
    </script>
  </body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (error) {
    console.error('eBay OAuth callback failed:', error);
    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>AvyCloud – eBay</title></head>
  <body style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto; padding: 24px;">
    <h2>eBay Verbindung fehlgeschlagen</h2>
    <pre style="white-space: pre-wrap;">${String(error?.message || error)}</pre>
  </body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(html);
  }
});

app.get('/api/ebay/status', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { getEbayIntegration, publicStatus } = require('./lib/ebay-oauth');
    const doc = await getEbayIntegration();
    return res.status(200).json({ ok: true, data: publicStatus(doc) });
  } catch (error) {
    console.error('Failed to load eBay status:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load eBay status', details: error.message } });
  }
});

app.get('/api/ebay/offers', requirePermission('products', 'read'), async (req, res) => {
  try {
    const sku = typeof req.query?.sku === 'string' ? req.query.sku : '';
    if (!sku) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing sku' } });
    }
    const { getOffersBySku } = require('./lib/ebay-api');
    const offers = await getOffersBySku(sku);
    return res.status(200).json({ ok: true, data: offers });
  } catch (error) {
    console.error('Failed to fetch eBay offers:', error);
    const status = error?.statusCode && Number.isFinite(Number(error.statusCode)) ? Number(error.statusCode) : 500;
    return res.status(status).json({ ok: false, error: { code: status, message: error.message || 'Failed to fetch offers' } });
  }
});

app.post('/api/ebay/listings/import/mip', requirePermission('products', 'write'), ktypeUploadMiddleware, async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing CSV file' } });
    }
    const { importMipCsvBuffer } = require('./lib/ebay-listings');
    const report = await importMipCsvBuffer(file.buffer, {
      filename: file.originalname || null,
      actor: req.user || null,
    });
    return res.status(200).json({ ok: true, data: report });
  } catch (error) {
    console.error('Failed to import eBay MIP CSV:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to import eBay CSV', details: error.message } });
  }
});

app.get('/api/ebay/listings/:sku', requirePermission('products', 'read'), async (req, res) => {
  try {
    const sku = String(req.params.sku || '').trim();
    if (!sku) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing sku' } });
    }
    const { getEbayListingBySku } = require('./lib/ebay-listings');
    const listing = await getEbayListingBySku(sku);
    if (!listing) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Listing not found' } });
    }
    return res.status(200).json({ ok: true, data: listing });
  } catch (error) {
    console.error('Failed to load eBay listing:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load listing', details: error.message } });
  }
});

// --- Admin Jobs (RBAC-managed) ---
// Triggers the Cloud Run Job that performs initial GPSR enrichment (BIN set & qty>=1 & needsGpsr).
app.post('/api/admin/jobs/gpsr-web-enrich/run', requirePermission('admin', 'jobs.run'), async (req, res) => {
  try {
    const jobName = String(process.env.GPSR_WEB_ENRICH_JOB_NAME || '').trim(); // full name preferred
    const location = String(process.env.CLOUD_RUN_JOBS_LOCATION || '').trim();
    const jobId = String(process.env.GPSR_WEB_ENRICH_JOB_ID || '').trim();

    // If full name is not provided, require location+jobId (project is derived from GOOGLE_CLOUD_PROJECT).
    if (!jobName && (!location || !jobId)) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message:
            'Cloud Run Job config missing. Set GPSR_WEB_ENRICH_JOB_NAME (recommended) or CLOUD_RUN_JOBS_LOCATION + GPSR_WEB_ENRICH_JOB_ID.',
          details: {
            GPSR_WEB_ENRICH_JOB_NAME: jobName ? 'set' : 'missing',
            CLOUD_RUN_JOBS_LOCATION: location ? 'set' : 'missing',
            GPSR_WEB_ENRICH_JOB_ID: jobId ? 'set' : 'missing',
          },
        },
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const limit = Number.isFinite(Number(body.limit)) ? Math.max(1, Math.min(20000, Number(body.limit))) : null;
    const concurrency = Number.isFinite(Number(body.concurrency))
      ? Math.max(1, Math.min(10, Number(body.concurrency)))
      : null;
    const minQty = Number.isFinite(Number(body.minQty)) ? Math.max(1, Math.min(9999, Number(body.minQty))) : null;
    const requireBin = body.requireBin === false ? false : true;
    const apply = body.apply === true;
    const debug = body.debug === true;

    // Optional overrides:
    // We use containerOverrides.env so the job can pick up run parameters without relying on args.
    // NOTE: This requires IAM permission run.jobs.runWithOverrides.
    const containerName = String(process.env.GPSR_WEB_ENRICH_CONTAINER || '').trim();
    let overrides = null;
    if (containerName && (apply || limit || concurrency || minQty || debug)) {
      const env = [];
      if (apply) env.push({ name: 'APPLY', value: '1' });
      if (debug) env.push({ name: 'DEBUG', value: '1' });
      if (limit) env.push({ name: 'LIMIT', value: String(limit) });
      if (concurrency) env.push({ name: 'CONCURRENCY', value: String(concurrency) });
      if (minQty) env.push({ name: 'MIN_QTY', value: String(minQty) });
      env.push({ name: 'REQUIRE_BIN', value: requireBin ? '1' : '0' });
      overrides = {
        containerOverrides: [
          {
            name: containerName,
            env,
          },
        ],
      };
    }

    const operation = await runCloudRunJob({
      name: jobName || '',
      projectId: GCP_PROJECT,
      location,
      jobId,
      overrides,
      validateOnly: false,
    });

    // Best-effort: persist run metadata so Admin UI can display "last run" and we can query operation status later.
    try {
      const { createJobRun } = require('./lib/admin-job-runs');
      const opName = operation?.name ? String(operation.name).trim() : null;
      await createJobRun({
        type: 'gpsr-web-enrich',
        operationName: opName,
        params: { apply, limit, concurrency, minQty, requireBin, debug },
        requestedBy: req.user?.email || req.user?.uid || 'admin',
      });
    } catch (e) {
      console.warn('[admin-job-runs] failed to persist gpsr-web-enrich run (non-blocking):', e?.message || e);
    }

    return res.json({ ok: true, data: operation });
  } catch (error) {
    console.error('Failed to run GPSR Cloud Run Job:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to run GPSR Cloud Run Job',
        details: error?.message || String(error),
      },
    });
  }
});

// Aggregate status endpoint so Admin can see whether jobs are currently running without using GCP console.
app.get('/api/admin/jobs/status', requirePermission('admin', 'jobs.read'), async (req, res) => {
  try {
    const { listJobsByStatus } = require('./lib/rulebook-apply-jobs');
    const { listJobRunsByType } = require('./lib/admin-job-runs');
    const { getCloudRunOperation } = require('./lib/cloud-run-jobs');
    const { listJobsByStatus: listAdminBulkJobsByStatus } = require('./lib/admin-bulk-jobs');

    const rulebookRunning = await listJobsByStatus(['pending', 'processing']);
    const adminBulkRunning = await listAdminBulkJobsByStatus(['pending', 'processing']);

    const gpsrRuns = await listJobRunsByType('gpsr-web-enrich', { limit: 5 });
    const latestGpsr = gpsrRuns?.[0] || null;

    let gpsrOperation = null;
    if (latestGpsr?.operationName) {
      try {
        gpsrOperation = await getCloudRunOperation({ name: latestGpsr.operationName });
      } catch (e) {
        gpsrOperation = { ok: false, error: e?.message || String(e) };
      }
    }

    res.json({
      ok: true,
      data: {
        rulebookApply: {
          runningCount: Array.isArray(rulebookRunning) ? rulebookRunning.length : 0,
          running: Array.isArray(rulebookRunning) ? rulebookRunning.slice(0, 10) : [],
        },
        adminBulk: {
          runningCount: Array.isArray(adminBulkRunning) ? adminBulkRunning.length : 0,
          running: Array.isArray(adminBulkRunning) ? adminBulkRunning.slice(0, 10) : [],
        },
        gpsrWebEnrich: {
          latestRun: latestGpsr,
          operation: gpsrOperation,
          recentRuns: Array.isArray(gpsrRuns) ? gpsrRuns : [],
        },
      },
    });
  } catch (error) {
    console.error('Failed to load admin jobs status:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to load admin jobs status', details: error?.message || String(error) },
    });
  }
});

app.get('/api/admin/llm/scopes/:scopeId', requirePermission('admin', 'llm.read'), async (req, res) => {
  try {
    const scopeId = req.params?.scopeId;
    const scope = await getScope(scopeId);
    if (!scope) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Scope not found' } });
    }
    const versions = await listScopeVersions(scopeId, { limit: 25 });
    res.json({ ok: true, data: { scope, versions } });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin get LLM scope failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to load scope' } });
  }
});

app.post('/api/admin/llm/scopes/:scopeId/versions', requirePermission('admin', 'llm.write'), async (req, res) => {
  try {
    const scopeId = req.params?.scopeId;
    const version = req.body || {};
    const created = await createScopeVersion({ actorUid: req.user?.uid, scopeId, version });
    res.json({ ok: true, data: created });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin create LLM version failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to create version' } });
  }
});

app.post('/api/admin/llm/scopes/:scopeId/activate/:versionId', requirePermission('admin', 'llm.write'), async (req, res) => {
  try {
    const scopeId = req.params?.scopeId;
    const versionId = req.params?.versionId;
    await activateScopeVersion({ actorUid: req.user?.uid, scopeId, versionId });
    res.json({ ok: true });
  } catch (error) {
    const code = error?.statusCode || 500;
    console.error('Admin activate LLM version failed:', error);
    res.status(code).json({ ok: false, error: { code, message: error?.message || 'Failed to activate version' } });
  }
});

app.post('/api/jobs', upload.array('images'), async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: {
      code: 410,
      message: 'Legacy Identify-Jobs werden nicht mehr unterstützt. Bitte /api/v2/enrich verwenden.',
    },
  });
});

app.get('/api/inventories', requirePermission('inventories', 'read'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 500, 1), 1000);
    const vendorCode =
      typeof req.query?.vendor === 'string' && req.query.vendor ? req.query.vendor : null;
    const search = typeof req.query?.search === 'string' ? req.query.search : '';
    const inventories = await listInventories({ limit, vendorCode, search });
    res.json({
      ok: true,
      data: inventories,
      meta: {
        limit,
        vendor: vendorCode,
        search,
      },
    });
  } catch (error) {
    console.error('Failed to list inventories:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Inventories konnten nicht geladen werden.',
        details: error.message,
      },
    });
  }
});

app.get('/api/inventories/:id', requirePermission('inventories', 'read'), async (req, res) => {
  try {
    const inventoryId = req.params?.id;
    const inventory = await getInventoryRecord(inventoryId);
    if (!inventory) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Inventory wurde nicht gefunden.',
        },
      });
    }
    return res.json({ ok: true, data: inventory });
  } catch (error) {
    console.error('Failed to fetch inventory:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Inventory konnte nicht geladen werden.',
        details: error.message,
      },
    });
  }
});

app.get('/api/inventories/:id/label.pdf', requirePermission('inventories', 'read'), async (req, res) => {
  try {
    const inventoryId = req.params?.id;
    const inventory = await getInventoryRecord(inventoryId);
    if (!inventory) {
      return res.status(404).json({
        ok: false,
        error: { code: 404, message: 'Inventory wurde nicht gefunden.' },
      });
    }
    const pdfBuffer = await buildInventoryLabelPdf(inventory);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="inventory-${inventoryId}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Failed to build inventory label:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Inventory-Label konnte nicht erstellt werden.', details: error.message },
    });
  }
});

// Inventory sync pulls from BaseLinker; protect it like other integration sync operations.
app.post('/api/inventories/sync', requirePermission('baselinker', 'sync'), async (req, res) => {
  try {
    const result = await syncInventoriesFromBaseLinker();
    res.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error('Inventory sync failed:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Inventory-Sync fehlgeschlagen.',
        details: error.message,
      },
    });
  }
});

app.post('/api/inventories/assign', async (req, res) => {
  try {
    return res.status(410).json({
        ok: false,
      error: { code: 410, message: 'Inventory-Zuordnung wird nicht mehr unterstützt.' },
      });
  } catch (error) {
    console.error('Failed to assign inventory:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Inventory konnte nicht zugewiesen werden.', details: error.message },
    });
  }
});

app.post('/api/products/:productId/inventory', requirePermission('products', 'write'), async (req, res) => {
  try {
    const productId = req.params?.productId;
    const inventoryId = req.body?.inventoryId;
    if (!productId) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Produkt-ID ist erforderlich.' },
      });
    }
    if (!inventoryId) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Inventory ID ist erforderlich.' },
      });
    }
    const inventory = await getInventoryRecord(inventoryId);
    if (!inventory) {
      return res.status(404).json({
        ok: false,
        error: { code: 404, message: 'Inventory wurde nicht gefunden.' },
      });
    }
    await setProductInventory(productId, inventory);
    res.json({ ok: true, data: { productId, inventoryId } });
  } catch (error) {
    console.error('Failed to set product inventory:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Inventory konnte nicht gesetzt werden.', details: error.message },
    });
  }
});

// --- Current user RBAC snapshot (for UI gating) ---
app.get('/api/me/permissions', async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) {
      return res.status(401).json({ ok: false, error: { code: 401, message: 'Unauthorized' } });
    }
    const { profile, permissions, roles } = await resolvePermissionsForUser(uid);
    return res.json({
      ok: true,
      data: {
        roles: Array.isArray(roles) ? roles : [],
        permissions: permissions && typeof permissions === 'object' ? permissions : {},
        profile: profile
          ? {
              uid: profile.uid || null,
              email: profile.email || null,
              roles: Array.isArray(profile.roles) ? profile.roles : [],
              groupIds: Array.isArray(profile.groupIds) ? profile.groupIds : [],
            }
          : null,
      },
    });
  } catch (error) {
    // For UI purposes, don't fail hard; return empty permission set.
    console.warn('Failed to resolve /api/me/permissions:', error?.message || error);
    return res.json({ ok: true, data: { roles: [], permissions: {}, profile: null } });
  }
});

app.post('/api/v2/enrich', requirePermission('identify', 'run'), upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';
    if (!files.length && (!barcodes || !barcodes.trim())) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Bitte mindestens ein Bild oder einen Barcode bereitstellen.',
        },
      });
    }

    const locale = req.body?.locale || 'de-DE';
    const result = await runSerpapiFreePipeline({ files, barcodes, locale });

    return res.json({
      ok: true,
      data: result.record,
      meta: {
        locale: result.locale,
        barcodes: result.barcodes,
        ocr: result.ocr,
        llm: result.llm,
        barcodeInsights: result.barcodeInsights,
        quality: result.quality,
      },
    });
  } catch (error) {
    console.error('SerpAPI-free enrichment failed:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'SerpAPI-freies Enrichment fehlgeschlagen.',
        details: error?.message || 'Unknown error',
      },
    });
  }
});

// v2 Identify (single pipeline): runs serpapi-free pipeline + server-side datasheet review,
// persists product in SYSTEM mode (so invariants like title policy + condition rules apply),
// and returns the saved product (already ready for Quality Gate).
app.post('/api/v2/identify', requirePermission('identify', 'run'), upload.array('images'), async (req, res) => {
  try {
    const files = req.files || [];
    const barcodes = req.body?.barcodes || '';
    const locale = req.body?.locale || 'de-DE';
    const inventoryId = req.body?.inventoryId || null;

    if (!files.length && (!barcodes || !barcodes.trim())) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Bitte mindestens ein Bild oder einen Barcode bereitstellen.' },
      });
    }

    // 1) Identify + OCR + record
    const result = await runSerpapiFreePipeline({ files, barcodes, locale, inventoryId });

    // 2) Stock protection: if this identifier already exists, never overwrite datasheet.
    const strictBarcodes = []
      .concat(Array.isArray(result?.barcodeInsights?.ranked) ? result.barcodeInsights.ranked.map((r) => r?.code) : [])
      .concat([result?.barcodeInsights?.selected?.ean, result?.barcodeInsights?.selected?.gtin])
      .concat(Array.isArray(result?.barcodes) ? result.barcodes : [])
      .filter(Boolean)
      .map((c) => String(c).trim())
      .filter(Boolean)
      .slice(0, 8);
    const strictSku =
      result?.record?.sku && typeof result.record.sku === 'string' && result.record.sku.trim() && result.record.sku.trim().toLowerCase() !== 'unknown'
        ? result.record.sku.trim()
        : null;

    const existing = await findProductByStrictIdentifier({ barcodes: strictBarcodes, sku: strictSku });
    if (existing?.id) {
      // Best-effort: mark incoming stock as pending intake (do not touch the datasheet)
      try {
        await adjustPendingIntakeQuantity(existing.id, 1);
      } catch (e) {
        console.warn('Failed to adjust pending intake for existing product:', e?.message || e);
      }
      const refreshed = await getProduct(existing.id);
      return res.json({
        ok: true,
        data: refreshed || existing,
        meta: {
          reused_existing: true,
          locale: result.locale,
          barcodes: result.barcodes,
          ocr: result.ocr,
          llm: result.llm,
          barcodeInsights: result.barcodeInsights,
          quality: result.quality,
        },
      });
    }

    // 3) Build initial product (server-side), then run taxonomy + datasheet review using OCR evidence.
    let product = buildProductFromV2Record(result.record, {
      fallbackId: crypto.randomUUID(),
      barcodes,
      locale,
      inventoryId: inventoryId || null,
    });

    product = applyEbayTaxonomy(product);
    product = applyKauflandTaxonomy(product);

    // Provide evidence to the review step (OCR/web hints). This avoids "invented" specs and helps granularity.
    const evidence = {
      ocr: result.ocr || null,
      barcodes: result.barcodes || [],
      barcodeInsights: result.barcodeInsights || null,
      llm: result.llm || null,
    };

    // Optional: prefetch small web excerpts (BrightData-backed when configured) to push Identify towards 99% completeness.
    // This is SerpAPI-free and is used as *evidence only* (no guessing).
    const enablePrefetch =
      String(process.env.IDENTIFY_PREFETCH_WEB_EVIDENCE || 'true').toLowerCase() === 'true';
    if (enablePrefetch) {
      try {
        const webEnrich = await prefetchWebEvidenceForIdentify({
          barcodeList: result.barcodes || [],
          ocrTextSnippets: result?.ocr?.textSnippets || [],
          locale,
        });
        if (webEnrich) {
          evidence.web_enrich = webEnrich;
        }
      } catch (e) {
        // Best-effort: never fail Identify because web prefetch failed.
        console.warn('Identify web evidence prefetch failed (continuing):', e?.message || e);
      }
    }

    await runDatasheetReview([product], {
      locale,
      webEvidence: evidence,
      marketplaceEvidence: true,
      llmScopeId: 'identify.v2',
    });

    // Retry once if still not eBay-ready (title/desc/highlights/attrs). This keeps Identify outputs stable.
    try {
      const { evaluateEbayReady } = require('./lib/datasheet-quality');
      const eval1 = evaluateEbayReady(product);
      if (!eval1.ok && eval1.issues && eval1.issues.length) {
        await runDatasheetReview([product], {
          locale,
          webEvidence: evidence,
          qualityIssuesById: { [product.id]: eval1.issues },
          marketplaceEvidence: true,
          llmScopeId: 'identify.v2',
        });
      }
    } catch (e) {
      console.warn('Identify post-review evaluation failed (continuing):', e?.message || e);
    }

    // 3.5) K-Typ enrichment (AUTO/MOTO only, MVL-backed, never guessing).
    // Best-effort: do not fail Identify if enrichment can't be done.
    try {
      const { enrichKTypIfPossible } = require('./lib/ktype-enrichment');
      await enrichKTypIfPossible(product, { reason: 'identify' });
    } catch (e) {
      console.warn('Identify K-Typ enrichment failed (continuing):', e?.message || e);
    }

    // 3.6) Price enrichment (best-effort). Identify outputs should include a price when possible.
    // This uses SerpAPI when enabled, otherwise falls back to BrightData-backed web search + unlocker scraping.
    try {
      await enrichPriceForProductBestEffort(product, { force: false, reason: 'identify' });
    } catch (e) {
      console.warn('Identify price enrichment failed (continuing):', e?.message || e);
    }

    // 3.7) BaseLinker category assignment (single inventory: 78659, best-effort).
    // We constrain the choice to the BaseLinker category tree and store:
    // - details.baselinkerCategoryPath (breadcrumb)
    // - details.baselinkerCategoryId (category_id)
    try {
      const { assignBaselinkerCategoryBestEffort } = require('./services/baselinker-category');
      await assignBaselinkerCategoryBestEffort(product, { inventoryId: '78659', locale });
    } catch (e) {
      console.warn('Identify BaseLinker category assignment failed (continuing):', e?.message || e);
    }

    // 4) Persist (SYSTEM mode => invariants enforced; never treated as manual UI edit).
    await saveProduct(product, {
      allowCategoryChange: true,
      mode: 'system',
      source: 'identify',
      overwriteTextFields: true,
      replaceAttributes: true,
      syncIdentifiersFromBarcodes: true,
    });

    const saved = await getProduct(product.id);
    return res.json({
      ok: true,
      data: saved || product,
      meta: {
        reused_existing: false,
        locale: result.locale,
        barcodes: result.barcodes,
        ocr: result.ocr,
        llm: result.llm,
        barcodeInsights: result.barcodeInsights,
        quality: result.quality,
      },
    });
  } catch (error) {
    console.error('v2 identify failed:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Identify (v2) fehlgeschlagen.',
        details: error?.message || 'Unknown error',
      },
    });
  }
});

app.get('/api/jobs', requirePermission('jobs', 'read'), async (req, res) => {
  try {
    const statuses = normalizeJobStatuses(req.query?.status) || ['pending', 'processing'];
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100);
    const cursor = typeof req.query?.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
    const order = req.query?.order === 'asc' ? 'asc' : 'desc';

    const { jobs, nextCursor } = await listJobs({
      statuses,
      limit,
      cursor,
      order,
    });

    const formatted = jobs.map(formatJobForResponse);
    const stats = formatted.reduce(
      (acc, job) => {
        const key = job.status || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      { total: 0 }
    );

    res.json({
      ok: true,
      data: {
        jobs: formatted,
        nextCursor,
        hasMore: Boolean(nextCursor),
        stats,
        filters: {
          statuses,
          limit,
          order,
        },
      },
    });
  } catch (error) {
    console.error('Failed to list identification jobs:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load identification jobs.',
      },
    });
  }
});

app.get('/api/jobs/:id', requirePermission('jobs', 'read'), async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Job not found',
        },
      });
    }

    const response = {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      model: job.payload?.model || null,
    };

    if (job.status === 'done') {
      response.result = job.result;
      response.serpTrace = job.serpTrace;
    }
    if (job.status === 'failed') {
      response.error = job.error;
    }

    res.json({
      ok: true,
      data: response,
    });
  } catch (error) {
    console.error('Failed to load job:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load job',
        details: error.message,
      },
    });
  }
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const jobId = req.params?.id;
  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Job-ID fehlt.',
      },
    });
  }
  try {
    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Job nicht gefunden.',
        },
      });
    }

    await updateJob(jobId, {
      status: 'pending',
      startedAt: FieldValue.delete(),
      finishedAt: FieldValue.delete(),
      error: FieldValue.delete(),
      result: FieldValue.delete(),
      serpTrace: FieldValue.delete(),
      reuseEvents: FieldValue.delete(),
    });
    enqueueJob(jobId, true);
    res.json({
      ok: true,
      data: {
        id: jobId,
        status: 'pending',
      },
    });
  } catch (error) {
    console.error(`Failed to retry job ${jobId}:`, error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Job konnte nicht neu gestartet werden.',
      },
    });
  }
});

app.get('/api/image-proxy', async (req, res) => {
  const sourceUrl = req.query?.url;
  if (!sourceUrl || typeof sourceUrl !== 'string') {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Missing url query parameter.',
      },
    });
  }

  let target;
  try {
    target = new URL(sourceUrl);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Invalid image URL.',
      },
    });
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return res.status(400).json({
      ok: false,
      error: {
        code: 400,
        message: 'Only http/https protocols are supported.',
      },
    });
  }

  try {
    const upstream = await fetchWithUnlocker({
      url: target.toString(),
      method: 'GET',
      format: 'raw',
      timeoutMs: IMAGE_PROXY_TIMEOUT_MS,
      headers: {
        'User-Agent': 'avystock-image-proxy/1.0',
        Accept: 'image/*,*/*;q=0.8',
        Referer: '',
      },
    });

    if (!upstream.success) {
      return res.status(502).json({
        ok: false,
        error: {
          code: 502,
          message: `Upstream image request failed: ${upstream.error || 'Unknown error'}`,
        },
      });
    }

    if (upstream.bytes && upstream.bytes > IMAGE_PROXY_MAX_BYTES) {
      return res.status(413).json({
        ok: false,
        error: {
          code: 413,
          message: 'Remote image exceeds proxy size limit.',
        },
      });
    }

    const body = upstream.body_base64
      ? Buffer.from(upstream.body_base64, 'base64')
      : Buffer.from(upstream.body || '', 'binary');
    if (body.length > IMAGE_PROXY_MAX_BYTES) {
      return res.status(413).json({
        ok: false,
        error: {
          code: 413,
          message: 'Remote image exceeds proxy size limit.',
        },
      });
    }

    const contentType = upstream.contentType || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.status(200).send(body);
  } catch (error) {
    console.error('Image proxy failed:', error);
    return res.status(502).json({
      ok: false,
      error: {
        code: 502,
        message: 'Failed to fetch upstream image.',
      },
    });
  }
});

app.post('/api/identify', upload.array('images'), async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: {
      code: 410,
      message: 'Legacy /api/identify wird nicht mehr unterstützt. Bitte /api/v2/enrich verwenden.',
    },
  });
});

// Intake resolver for Identify v2:
// If a product already exists (strict EAN/GTIN/SKU match), we must NOT create/overwrite a new datasheet.
// Instead, we only bump pending intake quantity (and optionally inventory) and return the canonical product.
app.post('/api/intake/resolve', async (req, res) => {
  try {
    const barcodesText = req.body?.barcodes || '';
    const sku = req.body?.sku || null;
    const inventoryId = req.body?.inventoryId || null;

    const barcodes = parseBarcodeListFromText(barcodesText);
    const skuCandidate = normalizeIdentifyToken(sku) || parseSkuCandidateFromText(barcodesText) || null;

    const match = await findProductByStrictIdentifier({ barcodes, sku: skuCandidate });
    if (!match?.id) {
      return res.status(200).json({
        ok: true,
        data: { matched: false },
      });
    }

    let inventoryRecord = null;
    if (inventoryId) {
      inventoryRecord = await getInventoryRecord(String(inventoryId));
    }

    const pendingQuantity =
      (await adjustPendingIntakeQuantity(match.id, 1)) ??
      ((match.ops?.pending_intake_quantity || 0) + 1);

    if (inventoryRecord && match.inventory?.inventoryId !== inventoryRecord.inventoryId) {
      // Best-effort; never fail intake resolve.
      setProductInventory(match.id, inventoryRecord).catch((err) => {
        console.warn(`Failed to update inventory for ${match.id}:`, err?.message || err);
      });
    }

    const canonical = (await getProduct(match.id)) || match;
    const resolvedProduct = {
      ...canonical,
      id: canonical?.id || match.id,
      ops: {
        ...(canonical.ops || {}),
        pending_intake_quantity: pendingQuantity,
      },
    };

    return res.status(200).json({
      ok: true,
      data: {
        matched: true,
        product: resolvedProduct,
        pendingIntakeQuantity: pendingQuantity,
      },
    });
  } catch (error) {
    console.error('Error in /api/intake/resolve:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Intake resolve failed.',
        details: error?.message || 'Unknown error',
      },
    });
  }
});


// --- Image Generation Endpoint ---
const { generateImagesForProduct } = require('./services/image-generation');

app.post('/api/generate-images', async (req, res) => {
  try {
    const { productId, product, referenceImage, sampleCount } = req.body || {};

    let targetProduct = product;
    if (!targetProduct && productId) {
      targetProduct = await getProduct(productId);
    }

    if (!targetProduct) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Product ID or object required' }
      });
    }

    if (!referenceImage?.url_or_base64) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'referenceImage with url_or_base64 is required' }
      });
    }

    const matchExists = Array.isArray(targetProduct.details?.images)
      ? targetProduct.details.images.some((img) => img.url_or_base64 === referenceImage.url_or_base64)
      : false;

    if (!matchExists) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Reference image must belong to the target product' }
      });
    }

    const { images, prompts } = await generateImagesForProduct(targetProduct, {
      referenceImage,
      sampleCount,
    });

    res.json({
      ok: true,
      data: {
        images,
        prompts,
      }
    });

  } catch (error) {
    console.error('Image generation failed:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to generate images',
        details: error.message
      }
    });
  }
});

// --- BaseLinker sync endpoint ---
const {
  syncProductToBaseLinker,
  syncProductsToBaseLinker,
  findProductsBySkus,
  getInventoryProductLinksSummary,
} = require('./lib/baselinker');

// --- BaseLinker sync jobs (async, resilient) ---
app.post('/api/baselinker/sync/jobs', requirePermission('baselinker', 'sync'), async (req, res) => {
  try {
    const { productIds, inventoryId } = req.body || {};
    const invId = String(inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'productIds array required' },
      });
    }

    const ids = Array.from(new Set(productIds.map((id) => String(id).trim()).filter(Boolean))).slice(0, 500);
    const job = await createBaseLinkerSyncJob({
      payload: { productIds: ids, inventoryId: invId },
      status: 'pending',
      stage: 'queued',
      progress: { total: ids.length, processed: 0, synced: 0, failed: 0 },
      requestedBy: 'ui',
      createdAt: BaseLinkerSyncTimestamp.now(),
      updatedAt: BaseLinkerSyncTimestamp.now(),
    });
    enqueueBaseLinkerSyncJob(job.id, true);
    return res.status(202).json({ ok: true, jobId: job.id });
  } catch (error) {
    console.error('Failed to create BaseLinker sync job:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to create BaseLinker sync job', details: error.message },
    });
  }
});

app.get('/api/baselinker/sync/jobs/:id', requirePermission('baselinker', 'read'), async (req, res) => {
  try {
    const job = await getBaseLinkerSyncJob(String(req.params.id));
    if (!job) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    }
    return res.status(200).json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load BaseLinker sync job:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to load BaseLinker sync job', details: error.message },
    });
  }
});

app.post('/api/baselinker/sync/jobs/:id/retry', requirePermission('baselinker', 'sync'), async (req, res) => {
  try {
    const jobId = String(req.params.id);
    const job = await getBaseLinkerSyncJob(jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    }
    await updateBaseLinkerSyncJob(jobId, {
      status: 'pending',
      stage: 'queued',
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
      progress: job?.progress || { total: 0, processed: 0, synced: 0, failed: 0 },
    });
    enqueueBaseLinkerSyncJob(jobId, true);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Failed to retry BaseLinker sync job:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to retry BaseLinker sync job', details: error.message },
    });
  }
});

app.post('/api/sync-baselinker', requirePermission('baselinker', 'sync'), async (req, res) => {
  console.log('Received request on /api/sync-baselinker');

  try {
    const { product, products, productId, productIds, inventoryId } = req.body || {};
    // Prefer request-provided inventoryId (frontend sends it), fall back to env/default.
    const invId = String(
      (inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659')
    ).trim();

    // Validate input
    if (!product && !products && !productId && !productIds) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Please provide either a product or products array' }
      });
    }

    // Safety bridge: bulk sync via jobs to avoid Cloud Run 10-minute request timeouts (504/failed-to-fetch).
    // This keeps legacy callers working even if they still hit /api/sync-baselinker.
    if (Array.isArray(productIds) && productIds.length >= 10) {
      const ids = Array.from(new Set(productIds.map((id) => String(id).trim()).filter(Boolean))).slice(0, 500);
      const job = await createBaseLinkerSyncJob({
        payload: { productIds: ids, inventoryId: invId },
        status: 'pending',
        stage: 'queued',
        progress: { total: ids.length, processed: 0, synced: 0, failed: 0 },
        requestedBy: 'legacy',
        createdAt: BaseLinkerSyncTimestamp.now(),
        updatedAt: BaseLinkerSyncTimestamp.now(),
      });
      enqueueBaseLinkerSyncJob(job.id, true);
      return res.status(202).json({ ok: true, jobId: job.id, queued: true });
    }

    let results;

    // Handle single product by ID (preferred)
    if (productId && !products && !product) {
      const canonical = await getProduct(String(productId)).catch(() => null);
      if (!canonical) {
        return res.status(404).json({ ok: false, error: { code: 404, message: `Product not found: ${productId}` } });
      }
      results = [await syncProductToBaseLinker(canonical, invId)];
    }
    // Handle single product (legacy payload)
    else if (product && !products) {
      const canonical = product?.id ? await getProduct(String(product.id)).catch(() => null) : null;
      results = [await syncProductToBaseLinker(canonical || product, invId)];
    }
    // Handle multiple products
    else if (productIds && Array.isArray(productIds)) {
      if (productIds.length === 0) {
        return res.status(400).json({
          ok: false,
          error: { code: 400, message: 'productIds array cannot be empty' }
        });
      }

      // Chunk klein halten, damit Request < Cloud-Run-Timeout bleibt
      const CHUNK_SIZE = 5;
      results = [];
      for (let i = 0; i < productIds.length; i += CHUNK_SIZE) {
        const chunkIds = productIds.slice(i, i + CHUNK_SIZE).map((id) => String(id));
        const canonicalChunk = (await Promise.all(chunkIds.map((id) => getProduct(id).catch(() => null))))
          .filter(Boolean);
        if (!canonicalChunk.length) continue;
        const chunkResults = await syncProductsToBaseLinker(canonicalChunk, invId);
        results.push(...chunkResults);
      }
    }
    else if (products && Array.isArray(products)) {
      if (products.length === 0) {
        return res.status(400).json({
          ok: false,
          error: { code: 400, message: 'Products array cannot be empty' }
        });
      }
      const CHUNK_SIZE = 5;
      results = [];
      for (let i = 0; i < products.length; i += CHUNK_SIZE) {
        const chunk = products.slice(i, i + CHUNK_SIZE);
        const canonicalChunk = await Promise.all(
          chunk.map(async (p) => {
            const pid = p?.id ? String(p.id) : null;
            if (!pid) return p;
            const canonical = await getProduct(pid).catch(() => null);
            return canonical || p;
          })
        );
        const chunkResults = await syncProductsToBaseLinker(canonicalChunk, invId);
        results.push(...chunkResults);
      }
    }
    else {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Invalid request format' }
      });
    }

    // Check if all succeeded
    const allSucceeded = results.every(r => r.status === 'synced');
    const failedResults = results.filter(r => r.status === 'failed');

    try {
      await Promise.all(
        results.map((result) =>
          updateProductSyncStatus(
            result.id,
            result.status,
            result.status === 'synced' ? new Date().toISOString() : null
          ).catch((error) => {
            console.error(`Failed to update sync status for ${result.id}:`, error);
          })
        )
      );
    } catch (statusError) {
      console.error('Error while updating sync status metadata:', statusError);
    }

    const responsePayload = {
      ok: allSucceeded,
      results,
    };

    if (failedResults.length) {
      responsePayload.error = {
        code: 502,
        message: failedResults
          .map((entry) => `${entry.id}: ${entry.message || 'Sync fehlgeschlagen'}`)
          .join(' | '),
      };
    }

    res.status(200).json(responsePayload);

  } catch (error) {
    console.error('Error in sync-baselinker endpoint:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'An internal server error occurred during sync',
        details: error.message
      }
    });
  }
});

// BaseLinker SKU/EAN lookup (existiert in Inventory?)
app.post('/api/baselinker/lookup', requirePermission('baselinker', 'read'), async (req, res) => {
  try {
    const { skus } = req.body || {};
    if (!Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'skus array required' },
      });
    }
    const invId = process.env.BASELINKER_INVENTORY_ID || '78659';
    const results = await findProductsBySkus(invId, skus);
    return res.status(200).json({ ok: true, results });
  } catch (error) {
    console.error('Error in /api/baselinker/lookup:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to lookup BaseLinker SKUs', details: error.message },
    });
  }
});

// --- Product Management Endpoints ---

// Upload K-Type CSV (eBay compatibility export) and update products' details.attributes["K-Typ"]
app.post('/api/ktype/upload', ktypeUploadMiddleware, async (req, res) => {
  try {
    const dryRunRaw =
      req.query?.dryRun ?? req.body?.dryRun ?? req.body?.dry_run ?? req.body?.dryrun ?? '';
    const dryRun =
      String(dryRunRaw || '')
        .trim()
        .toLowerCase() === '1' ||
      String(dryRunRaw || '')
        .trim()
        .toLowerCase() === 'true';

    const file = req.file;
    if (!file || !file.buffer) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'CSV file missing (multipart field: "file")' },
      });
    }

    const csv = file.buffer.toString('utf8');
    const { skuToKTyp, stats } = parseKTypeEbayCsvToSkuMap(csv);
    const entries = Object.entries(skuToKTyp);

    const findExistingKTyp = (attrs = {}) => {
      const keys = Object.keys(attrs || {});
      const key = keys.find((k) => {
        const lower = String(k || '').trim().toLowerCase();
        return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
      });
      if (!key) return '';
      const raw = attrs[key];
      return raw == null ? '' : String(raw).trim();
    };

    const report = {
      dryRun,
      parsed: stats,
      processed: entries.length,
      updated: 0,
      unchanged: 0,
      notFound: [],
      errors: [],
      samples: {
        updated: [],
        notFound: [],
      },
    };

    const buildSkuCandidates = (value) => {
      const raw = String(value || '').trim();
      if (!raw) return [];
      const withoutPrefix = raw.replace(/^sku[-_\\s]*/i, '').trim();
      const withPrefix = withoutPrefix ? `SKU-${withoutPrefix}` : '';
      const candidates = [raw, withoutPrefix, withPrefix].filter(Boolean);
      return Array.from(new Set(candidates));
    };

    const resolveProductForSku = async (sku) => {
      const candidates = buildSkuCandidates(sku);
      for (const candidate of candidates) {
        const direct = await getProduct(candidate);
        if (direct) return direct;
        const bySku = await findProductByStrictIdentifier({ sku: candidate });
        if (bySku) return bySku;
      }
      return null;
    };

    // Simple concurrency-limited worker pool
    let cursor = 0;
    const concurrency = 10;
    const workers = Array.from({ length: concurrency }, async () => {
      while (cursor < entries.length) {
        const idx = cursor++;
        const [sku, ktyp] = entries[idx];
        try {
          const product = await resolveProductForSku(sku);
          if (!product) {
            report.notFound.push(sku);
            if (report.samples.notFound.length < 10) report.samples.notFound.push(sku);
            continue;
          }

          const existing = findExistingKTyp(product?.details?.attributes || {});
          const nextVal = String(ktyp || '').trim();
          if (!nextVal) {
            // Nothing to set
            report.unchanged += 1;
            continue;
          }
          if (existing === nextVal) {
            report.unchanged += 1;
            continue;
          }

          if (!dryRun) {
            const docRef = firestore.collection('products').doc(String(product.id || sku));
            await docRef.set(
              {
                details: {
                  attributes: {
                    'K-Typ': nextVal,
                  },
                },
                ops: {
                  last_saved_source: 'ktype-upload',
                  last_saved_iso: new Date().toISOString(),
                  revision: FieldValue.increment(1),
                  sync_status: 'pending',
                },
              },
              { merge: true }
            );
          }

          report.updated += 1;
          if (report.samples.updated.length < 10) {
            report.samples.updated.push({ sku, length: nextVal.length });
          }
        } catch (error) {
          report.errors.push({ sku, message: error?.message || String(error) });
        }
      }
    });

    await Promise.all(workers);

    return res.status(200).json({ ok: true, report });
  } catch (error) {
    console.error('Error in /api/ktype/upload:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to process K-Type upload', details: error.message },
    });
  }
});

// Search eBay categories (breadcrumb-based)
app.get('/api/ebay/categories', (req, res) => {
  try {
    const query = (req.query.q || '').toString().trim();
    const id = (req.query.id || '').toString().trim();
    const limitRaw = parseInt(req.query.limit || '50', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const items = [];
    if (id) {
      const found = getEbayCategoryById(id);
      if (found) items.push(found);
    }
    if (query && query.length >= 2) {
      const matches = searchEbayCategories(query, limit);
      matches.forEach((item) => {
        if (!items.find((existing) => existing.id === item.id)) {
          items.push(item);
        }
      });
    }

    res.json({ items });
  } catch (error) {
    console.error('Failed to search eBay categories:', error);
    res.status(500).json({ error: { message: 'Failed to search categories.' } });
  }
});

// Search BaseLinker inventory categories (single inventory: 78659)
const {
  getInventoryCategoryIndex: getBaseLinkerCategoryIndex,
  searchInventoryCategories: searchBaseLinkerCategories,
  getInventoryCategoryById: getBaseLinkerCategoryById,
} = require('./lib/baselinker-inventory-category-index');

app.get('/api/baselinker/categories', requirePermission('products', 'read'), async (req, res) => {
  try {
    const inventoryId = String(req.query.inventoryId || req.query.inventory_id || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
    const query = (req.query.q || req.query.query || '').toString().trim();
    const id = (req.query.id || '').toString().trim();
    const leafOnly =
      String(req.query.leafOnly || req.query.leaf_only || '')
        .trim()
        .toLowerCase() === 'true';
    const limitRaw = parseInt(req.query.limit || '60', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 60;

    const meta = await getBaseLinkerCategoryIndex(inventoryId);

    let items = [];
    if (id) {
      const found = await getBaseLinkerCategoryById(inventoryId, id);
      if (found) items.push(found);
    }
    if (query && query.length >= 2) {
      const matches = await searchBaseLinkerCategories(inventoryId, query, { limit, leafOnly });
      matches.forEach((m) => {
        if (!items.find((x) => x.id === m.id)) items.push(m);
      });
    }

    return res.status(200).json({
      ok: true,
      inventoryId,
      meta: {
        inventoryId,
        fetchedAtIso: meta?.fetchedAtIso || null,
        count: meta?.count || 0,
      },
      items,
    });
  } catch (error) {
    console.error('Failed to search BaseLinker categories:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to search BaseLinker categories.' } });
  }
});

// --- Category Profiles (Category Management) ---
// Firestore collection: categoryProfiles/{ebayCategoryId}
//
// Purpose:
// - Store per-category canonical attribute keys + alias mappings.
// - These profiles are used by saveProduct() to normalize datasheet attributes consistently.
const CATEGORY_PROFILES_COLLECTION = 'categoryProfiles';

function parseCommaList(value) {
  const raw = value == null ? '' : String(value);
  return raw
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function sanitizeStringArray(value, { max = 250 } = {}) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const s = v == null ? '' : String(v).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeAliasMap(value, { max = 500 } = {}) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  const keys = Object.keys(obj);
  for (const k of keys) {
    const alias = k == null ? '' : String(k).trim();
    const canonical = obj[k] == null ? '' : String(obj[k]).trim();
    if (!alias || !canonical) continue;
    out[alias] = canonical;
    if (Object.keys(out).length >= max) break;
  }
  return out;
}

app.get('/api/categories/profiles', requirePermission('categories', 'read'), async (req, res) => {
  try {
    const ids = parseCommaList(req.query?.ids);
    const enabledOnly =
      String(req.query?.enabledOnly || req.query?.enabled_only || '')
        .trim()
        .toLowerCase() === 'true';

    // If ids are provided, fetch those docs only.
    if (ids.length) {
      const unique = Array.from(new Set(ids)).slice(0, 200);
      const refs = unique.map((id) => firestore.collection(CATEGORY_PROFILES_COLLECTION).doc(String(id)));
      const snaps = await firestore.getAll(...refs);
      const items = [];
      snaps.forEach((snap) => {
        if (!snap.exists) return;
        const data = snap.data() || {};
        items.push({ id: snap.id, ...data });
      });
      return res.status(200).json({ ok: true, items });
    }

    // Otherwise: list enabled profiles (or a small default sample) for future use.
    let query = firestore.collection(CATEGORY_PROFILES_COLLECTION);
    if (enabledOnly) {
      query = query.where('enabled', '==', true);
    }
    const snap = await query.limit(300).get();
    const items = [];
    snap.forEach((doc) => items.push({ id: doc.id, ...(doc.data() || {}) }));
    return res.status(200).json({ ok: true, items });
  } catch (error) {
    console.error('Failed to load category profiles:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load category profiles.' } });
  }
});

app.put('/api/categories/profiles/:id', requirePermission('categories', 'write'), async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Category id is required' } });
    }

    const ebay = getEbayCategoryById(id);
    if (!ebay) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Unknown eBay category id (not found in taxonomy)', details: id },
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const enabled = Boolean(body.enabled);
    const canonicalAttributes = sanitizeStringArray(body.canonicalAttributes, { max: 300 });
    const attributeAliases = sanitizeAliasMap(body.attributeAliases, { max: 800 });
    const notesRaw = body.notes == null ? '' : String(body.notes);
    const notes = notesRaw.trim().slice(0, 5000);

    const payload = {
      id,
      name: ebay.name || '',
      breadcrumb: ebay.breadcrumb || '',
      enabled,
      canonicalAttributes,
      attributeAliases,
      notes,
      updatedAtIso: new Date().toISOString(),
    };

    await firestore
      .collection(CATEGORY_PROFILES_COLLECTION)
      .doc(id)
      .set(payload, { merge: true });

    return res.status(200).json({ ok: true, data: payload });
  } catch (error) {
    console.error('Failed to save category profile:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to save category profile.' } });
  }
});

// Get all products
app.get('/api/products', requirePermission('products', 'read'), async (req, res) => {
  try {
    const products = await getAllProducts();
    const filteredProducts = Array.isArray(products)
      ? products.filter((p) => !isGhostProduct(p))
      : [];
    const reservedMap = await buildReservedOpenOrderMap();
    // NOTE: Filter ghost/stub docs early to avoid showing meaningless rows in the AdminTable.
    // Rebuild enriched pipeline using the filtered set to keep counts consistent.
    const enrichedFiltered = await enrichProductsWithBinSummaries(filteredProducts);
    const withReservedFiltered = attachReservedAvailability(enrichedFiltered, reservedMap);
    const withCompletenessFiltered = withReservedFiltered.map((p) => {
      const normalized = normalizeProductForApi(p);
      return {
        ...normalized,
        completeness: computeCompleteness(normalized),
      };
    });

    // Optional: Resolve BaseLinker product_id for items that are not yet linked in Firestore.
    // WARNING: This can be very slow (one BaseLinker request per SKU/EAN). Disabled by default to keep /api/products fast.
    const toBool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
    const resolveBaselinkerIdsEnabled =
      toBool(process.env.PRODUCTS_RESOLVE_BASELINKER_IDS) || toBool(req.query?.resolveBaselinkerIds);
    const resolveBaselinkerLimit = Math.max(
      0,
      parseInt(process.env.PRODUCTS_RESOLVE_BASELINKER_IDS_LIMIT || '10', 10)
    );

    let withBaselinkerIdsFiltered = withCompletenessFiltered;
    if (resolveBaselinkerIdsEnabled) {
      const normalizeSkuKey = (raw) =>
        String(raw || '')
          .trim()
          .toLowerCase()
          .replace(/^sku[-\s]*/i, '')
          .replace(/\s+/g, '');
      const normalizeEanKey = (raw) => String(raw || '').replace(/\D+/g, '').trim();

      const resolveCandidateSkus = withCompletenessFiltered
        .filter((p) => !(p?.ops?.baselinker?.product_id ?? p?.ops?.base_product_id))
        .map(
          (p) => p?.identification?.sku || p?.details?.identifiers?.sku || p?.details?.identifiers?.ean || null
        )
        .filter(Boolean);

      const cappedResolveCandidateSkus =
        resolveBaselinkerLimit > 0 ? resolveCandidateSkus.slice(0, resolveBaselinkerLimit) : [];

      let resolvedBySku = {};
      try {
        resolvedBySku = cappedResolveCandidateSkus.length
          ? await findProductsBySkus(null, cappedResolveCandidateSkus)
          : {};
      } catch (error) {
        console.warn('[products] findProductsBySkus failed:', error?.message || error);
        resolvedBySku = {};
      }

      if (resolvedBySku && Object.keys(resolvedBySku).length) {
        withBaselinkerIdsFiltered = withCompletenessFiltered.map((p) => {
          const already = p?.ops?.baselinker?.product_id ?? p?.ops?.base_product_id ?? null;
          if (already) return p;
          const key =
            p?.identification?.sku || p?.details?.identifiers?.sku || p?.details?.identifiers?.ean || null;
          const skuKey = normalizeSkuKey(key);
          const eanKey = normalizeEanKey(key);
          // findProductsBySkus returns normalized keys (skuKey OR eanKey)
          const match = (skuKey && resolvedBySku[skuKey]) || (eanKey && resolvedBySku[eanKey]) || null;
          if (!match?.product_id) return p;
          return {
            ...p,
            ops: {
              ...(p.ops || {}),
              baselinker: {
                ...((p.ops && p.ops.baselinker) || {}),
                product_id: match.product_id,
                synced_inventory: match.inventoryId || (p?.ops?.baselinker?.synced_inventory ?? null),
                matched_sku: match.sku || null,
                matched_ean: match.ean || null,
              },
            },
          };
        });
      }
    }

    // BaseLinker marketplace links ("listed on at least one marketplace") enrichment.
    // This is cached + chunked in baselinker.js to keep /api/products responsive.
    const baseProductIds = withBaselinkerIdsFiltered
      .map((p) => p?.ops?.baselinker?.product_id ?? p?.ops?.base_product_id ?? null)
      .filter(Boolean);
    const linksSummary = await getInventoryProductLinksSummary(null, baseProductIds);
    const withLinksFiltered = withBaselinkerIdsFiltered.map((p) => {
      const pidRaw = p?.ops?.baselinker?.product_id ?? p?.ops?.base_product_id ?? null;
      const pid = pidRaw != null ? String(Number(pidRaw) || '') : '';
      const summary = pid ? linksSummary[pid] : null;
      if (!summary) return p;
      return {
        ...p,
        ops: {
          ...(p.ops || {}),
          baselinker: {
            ...((p.ops && p.ops.baselinker) || {}),
            links_count: Number(summary.linksCount) || 0,
            has_links: Boolean(summary.hasLinks),
          },
        },
      };
    });

    res.json({ ok: true, products: withLinksFiltered });
  } catch (error) {
    console.error('Error getting products:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load products',
        details: error.message
      }
    });
  }
});

// Batch product labels (needs to be defined before /:id routes)
app.get('/api/products/labels', requirePermission('products', 'read'), async (req, res) => {
  try {
    const idsParam = req.query.ids;
    if (!idsParam) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Es wurden keine Produkt-IDs angegeben.' },
      });
    }
    const ids = Array.isArray(idsParam)
      ? idsParam
      : String(idsParam)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
    if (!ids.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Es wurden keine gültigen Produkt-IDs angegeben.' },
      });
    }

    const labels = [];
    const missing = [];
    for (const id of ids) {
      const product = await getProduct(id);
      if (!product) {
        missing.push(`Produkt ${id} wurde nicht gefunden`);
        continue;
      }
      const sku =
        product.identification?.sku || product.details?.identifiers?.sku || product.details?.identifiers?.ean;
      if (!sku) {
        missing.push(`${product.identification?.name || id} (keine SKU)`);
        continue;
      }
      const skuLine = sku.startsWith('SKU-') ? sku : `SKU-${sku}`;
      const name = (product.identification?.name || '').trim() || skuLine;
      labels.push({
        code: skuLine,
        skuLine,
        description: name,
      });
    }

    if (!labels.length) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: missing.length ? missing.join(', ') : 'Keine druckbaren Labels vorhanden.',
        },
      });
    }

    const html = await buildProductLabelsHtml(labels);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (error) {
    console.error('Failed to build product labels:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Labeldruck fehlgeschlagen', details: error.message },
    });
  }
});

// Get single product
app.get('/api/products/:id', requirePermission('products', 'read'), async (req, res) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found'
        }
      });
    }
    const [enriched] = await enrichProductsWithBinSummaries([product]);
    const hydrated = normalizeProductForApi(enriched || product);
    res.json({
      ok: true,
      product: {
        ...hydrated,
        completeness: computeCompleteness(hydrated),
      },
    });
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to load product',
        details: error.message
      }
    });
  }
});

app.get('/api/products/:id/label', requirePermission('products', 'read'), async (req, res) => {
  try {
    const product = await getProduct(req.params.id);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found',
        },
      });
    }

    const sku =
      product.identification?.sku ||
      product.details?.identifiers?.sku ||
      product.details?.identifiers?.ean ||
      null;

    if (!sku) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Product has no SKU assigned yet.',
        },
      });
    }

    const skuLine = sku.startsWith('SKU-') ? sku : `SKU-${sku}`;

    const html = await buildProductLabelsHtml([
      {
        code: skuLine,
        skuLine,
        description: product.identification?.name || skuLine,
      },
    ]);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch (error) {
    console.error('Failed to generate label:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to generate SKU label',
        details: error.message,
      },
    });
  }
});

// Warehouse APIs
app.get('/api/warehouse/zones', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const zones = await listWarehouseZones();
    res.json({ ok: true, data: zones });
  } catch (error) {
    console.error('Failed to load warehouse zones:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden der Lagerzonen', details: error.message },
    });
  }
});

app.post('/api/warehouse/layouts', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { zone, etage, gangs, regale, ebenen } = req.body || {};
    if (!zone || !etage || !gangs || !regale || !ebenen) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Zone, Etage, Gänge, Regale und Ebenen sind erforderlich.' },
      });
    }
    const layout = await createWarehouseLayout({
      zone: String(zone).toUpperCase(),
      etage: String(etage).toUpperCase(),
      gangRange: gangs,
      regalRange: regale,
      ebeneRange: ebenen,
    });
    res.json({ ok: true, data: layout });
  } catch (error) {
    console.error('Failed to create warehouse layout:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Fehler beim Anlegen der Lagerstruktur.' },
    });
  }
});

const parseTruthy = (value) => {
  if (value === true || value === 1) return true;
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
};

app.delete('/api/warehouse/layouts/:zone/:etage/gangs/:gang', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const gang = Number(req.params.gang);
    const dryRun = parseTruthy(req.query?.dryRun) || !parseTruthy(req.query?.confirm);

    const result = await deleteWarehouseGang(zone, etage, gang, { dryRun });
    res.json({ ok: true, data: { ...result, dryRun } });
  } catch (error) {
    console.error('Failed to delete warehouse gang:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Gang konnte nicht gelöscht werden.' },
    });
  }
});

app.delete('/api/warehouse/layouts/:zone/:etage/gangs/:gang/regale/:regal', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const gang = Number(req.params.gang);
    const regal = Number(req.params.regal);
    const dryRun = parseTruthy(req.query?.dryRun) || !parseTruthy(req.query?.confirm);

    const result = await deleteWarehouseRegal(zone, etage, gang, regal, { dryRun });
    res.json({ ok: true, data: { ...result, dryRun } });
  } catch (error) {
    console.error('Failed to delete warehouse regal:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Regal konnte nicht gelöscht werden.' },
    });
  }
});

app.delete('/api/warehouse/layouts/:zone/:etage/gangs/:gang/regale/:regal/ebenen/:ebene', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const gang = Number(req.params.gang);
    const regal = Number(req.params.regal);
    const ebene = String(req.params.ebene).toUpperCase();
    const dryRun = parseTruthy(req.query?.dryRun) || !parseTruthy(req.query?.confirm);

    const result = await deleteWarehouseEbene(zone, etage, gang, regal, ebene, { dryRun });
    res.json({ ok: true, data: { ...result, dryRun } });
  } catch (error) {
    console.error('Failed to delete warehouse ebene:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Ebene konnte nicht gelöscht werden.' },
    });
  }
});

app.get('/api/warehouse/zones/:zone/:etage', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const zone = req.params.zone.toUpperCase();
    const etage = req.params.etage.toUpperCase();
    const bins = await getBinsForZone(zone, etage);
    res.json({ ok: true, data: bins });
  } catch (error) {
    console.error('Failed to load bins:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden der Bins', details: error.message },
    });
  }
});

// BIN label endpoints – define before generic /:code route to avoid shadowing
app.get('/api/warehouse/bins/labels', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const codes = await resolveBinCodes({
      codesInput: req.query.codes,
      zone: req.query.zone,
      etage: req.query.etage,
      gang: req.query.gang,
      regal: req.query.regal,
    });
    await sendBinLabelHtml(res, codes);
  } catch (error) {
    console.error('Failed to generate batch bin labels:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/labels', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const { zone, etage, gang, regal } = req.body || {};
    const bodyCodes = req.body?.codes ?? req.body?.['codes[]'];
    const resolvedCodes = await resolveBinCodes({
      codesInput: bodyCodes,
      zone,
      etage,
      gang,
      regal,
    });
    await sendBinLabelHtml(res, resolvedCodes);
  } catch (error) {
    console.error('Failed to generate batch bin labels (POST):', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels', details: error.message },
    });
  }
});

app.get('/api/warehouse/bins/labels.pdf', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const codes = await resolveBinCodes({
      codesInput: req.query.codes,
      zone: req.query.zone,
      etage: req.query.etage,
      gang: req.query.gang,
      regal: req.query.regal,
    });
    await sendBinLabelsPdf(res, codes);
  } catch (error) {
    console.error('Failed to generate batch bin labels PDF:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels (PDF)', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/labels.pdf', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const { zone, etage, gang, regal } = req.body || {};
    const bodyCodes = req.body?.codes ?? req.body?.['codes[]'];
    const resolvedCodes = await resolveBinCodes({
      codesInput: bodyCodes,
      zone,
      etage,
      gang,
      regal,
    });
    await sendBinLabelsPdf(res, resolvedCodes);
  } catch (error) {
    console.error('Failed to generate batch bin labels PDF (POST):', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels (PDF)', details: error.message },
    });
  }
});

app.get('/api/warehouse/bins/:code', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const bin = await getBinByCode(code);
    if (!bin) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'BIN nicht gefunden.' } });
    }
    res.json({ ok: true, data: bin });
  } catch (error) {
    console.error('Failed to load bin:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden des BINs', details: error.message },
    });
  }
});

app.get('/api/products/:id/bins', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const bins = await listBinsForProduct(req.params.id);
    res.json({ ok: true, data: bins });
  } catch (error) {
    console.error('Failed to load product bins:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Laden der BINs für dieses Produkt.', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/:code/assign', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { productId, quantity = 1 } = req.body || {};
    if (!productId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'productId ist erforderlich.' } });
    }
    const bin = await assignProductToBin(code, productId, Number(quantity));
    const updatedProduct = await getProduct(productId);
    if (updatedProduct) {
      backgroundSyncProductStockToBaseLinker(updatedProduct, 'bin-assign');
    }
    res.json({ ok: true, data: { bin, product: updatedProduct } });
  } catch (error) {
    console.error('Failed to assign product to bin:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Fehler bei der Einlagerung.' },
    });
  }
});

app.delete('/api/warehouse/bins/:code/products/:productId', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const { productId } = req.params;
    await removeProductFromBin(code, productId);
    try {
      const updatedProduct = await getProduct(productId);
      if (updatedProduct) {
        backgroundSyncProductStockToBaseLinker(updatedProduct, 'bin-remove');
      }
    } catch (syncErr) {
      console.warn('Background BaseLinker stock sync after bin-remove failed:', syncErr?.message || syncErr);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to remove product from bin:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Fehler beim Entfernen des Produkts.' },
    });
  }
});

app.post('/api/warehouse/stock-in', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { sku, productId, barcode, binCode, quantity, meta } = req.body || {};
    if (!binCode) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Bin-Code ist erforderlich.' } });
    }
    const amount = Number(quantity);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Menge muss größer als 0 sein.' } });
    }
    const result = await bookStockIn({
      sku,
      productId,
      barcode,
      binCode: binCode.toUpperCase(),
      quantity: amount,
      meta: {
        ...(meta && typeof meta === 'object' ? meta : {}),
        source: 'api',
        action: 'stock-in',
      },
    });
    if (result?.product) {
      backgroundSyncProductStockToBaseLinker(result.product, 'stock-in');
    }
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('Stow workflow failed:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Einlagerung fehlgeschlagen.' },
    });
  }
});

app.post('/api/warehouse/stock-out', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { sku, productId, barcode, binCode, quantity, meta, orderId, orderItemId } = req.body || {};
    if (!binCode) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Bin-Code ist erforderlich.' } });
    }
    const amount = Number(quantity);
    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Menge muss größer als 0 sein.' } });
    }
    const result = await bookStockOut({
      sku,
      productId,
      barcode,
      binCode: binCode.toUpperCase(),
      quantity: amount,
      meta: {
        ...(meta && typeof meta === 'object' ? meta : {}),
        source: 'api',
        action: 'stock-out',
        orderId: orderId || null,
        orderItemId: orderItemId || null,
      },
    });
    if (result?.product) {
      backgroundSyncProductStockToBaseLinker(result.product, 'stock-out');
    }
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('Pick workflow failed:', error);
    res.status(400).json({
      ok: false,
      error: { code: 400, message: error.message || 'Auslagerung fehlgeschlagen.' },
    });
  }
});

app.post('/api/warehouse/refresh-inventory', requirePermission('warehouse', 'write'), async (req, res) => {
  try {
    const { productId, sku, barcode } = req.body || {};
    if (!productId && !sku && !barcode) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'productId, sku oder barcode ist erforderlich.' },
      });
    }

    const { ref } = await findProductDocument({ productId, sku, barcode });
    const resolvedProductId = ref.id;
    await refreshProductInventory(resolvedProductId);
    const product = await getProduct(resolvedProductId);

    res.json({ ok: true, data: { product } });
  } catch (error) {
    console.error('Failed to refresh inventory for product:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Inventar konnte nicht aktualisiert werden.', details: error.message },
    });
  }
});

function normalizeCodeList(input) {
  if (!input) return [];
  const values = Array.isArray(input) ? input : [input];
  return values
    .flatMap((entry) =>
      String(entry || '')
        .split(/[,\s]+/)
        .map((code) => code.trim().toUpperCase())
    )
    .filter(Boolean);
}

async function resolveBinCodes({ codesInput, zone, etage, gang, regal }) {
  const directCodes = normalizeCodeList(codesInput);
  if (directCodes.length) {
    return directCodes;
  }
  if (zone && etage) {
    const zoneCode = String(zone).toUpperCase();
    const etageCode = String(etage).toUpperCase();
    const binsForZone = await getBinsForZone(zoneCode, etageCode);
    const gangNumber = gang != null ? Number(gang) : undefined;
    const regalNumber = regal != null ? Number(regal) : undefined;
    return binsForZone
      .filter((bin) => {
        if (Number.isFinite(gangNumber) && bin.gang !== gangNumber) return false;
        if (Number.isFinite(regalNumber) && bin.regal !== regalNumber) return false;
        return true;
      })
      .map((bin) => bin.code);
  }
  return [];
}

async function sendBinLabelHtml(res, codes) {
  if (!codes.length) {
    return res.status(400).json({
      ok: false,
      error: { code: 400, message: 'Keine BIN-Codes gefunden. Bitte Codes oder Zone/Etage angeben.' },
    });
  }
  const uniqueCodes = [...new Set(codes)];
  const html = await buildBinLabelsHtml(uniqueCodes);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(html);
}

async function sendBinLabelsPdf(res, codes) {
  if (!codes.length) {
    return res.status(400).json({
      ok: false,
      error: { code: 400, message: 'Keine BIN-Codes gefunden. Bitte Codes oder Zone/Etage angeben.' },
    });
  }
  const uniqueCodes = [...new Set(codes)];
  const pdfBuffer = await buildBinLabelsPdf(uniqueCodes);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'inline; filename="bin-labels.pdf"');
  return res.send(pdfBuffer);
}

app.get('/api/warehouse/bins/:code/label', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'BIN-Code ist erforderlich.' } });
    }
    const bin = await getBinByCode(code);
    if (!bin) {
      console.warn(`BIN ${code} nicht gefunden – Label wird trotzdem erzeugt.`);
    }
    const html = await buildBinLabelHtml({ code });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (error) {
    console.error('Failed to generate bin label:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen des BIN-Labels', details: error.message },
    });
  }
});

app.get('/api/warehouse/bins/labels', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const codes = await resolveBinCodes({
      codesInput: req.query.codes,
      zone: req.query.zone,
      etage: req.query.etage,
      gang: req.query.gang,
      regal: req.query.regal,
    });
    await sendBinLabelHtml(res, codes);
  } catch (error) {
    console.error('Failed to generate batch bin labels:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/labels', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const { zone, etage, gang, regal } = req.body || {};
    const bodyCodes = req.body?.codes ?? req.body?.['codes[]'];
    const resolvedCodes = await resolveBinCodes({
      codesInput: bodyCodes,
      zone,
      etage,
      gang,
      regal,
    });
    await sendBinLabelHtml(res, resolvedCodes);
  } catch (error) {
    console.error('Failed to generate batch bin labels (POST):', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels', details: error.message },
    });
  }
});

app.get('/api/warehouse/bins/labels.pdf', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const codes = await resolveBinCodes({
      codesInput: req.query.codes,
      zone: req.query.zone,
      etage: req.query.etage,
      gang: req.query.gang,
      regal: req.query.regal,
    });
    await sendBinLabelsPdf(res, codes);
  } catch (error) {
    console.error('Failed to generate batch bin labels PDF:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels (PDF)', details: error.message },
    });
  }
});

app.post('/api/warehouse/bins/labels.pdf', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const { zone, etage, gang, regal } = req.body || {};
    const bodyCodes = req.body?.codes ?? req.body?.['codes[]'];
    const resolvedCodes = await resolveBinCodes({
      codesInput: bodyCodes,
      zone,
      etage,
      gang,
      regal,
    });
    await sendBinLabelsPdf(res, resolvedCodes);
  } catch (error) {
    console.error('Failed to generate batch bin labels PDF (POST):', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Fehler beim Erstellen der BIN-Labels (PDF)', details: error.message },
    });
  }
});

// --- Product BIN lookup ---
app.get('/api/products/:productId/bins', requirePermission('warehouse', 'read'), async (req, res) => {
  try {
    const productId = String(req.params.productId || '').trim();
    if (!productId) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Product ID ist erforderlich.' },
      });
    }
    const bins = await listBinsForProduct(productId);
    return res.json({ ok: true, data: bins });
  } catch (error) {
    console.error('Failed to load product bins:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Produkt-BINs konnten nicht geladen werden.', details: error.message },
    });
  }
});

app.post('/api/scanner/capture', requirePermission('identify', 'run'), async (req, res) => {
  try {
    const buffer = await scanToBuffer();
    const mimeType = process.env.SCAN_MIME_TYPE || 'image/png';
    res.json({
      ok: true,
      data: {
        mimeType,
        base64: buffer.toString('base64'),
        capturedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Scanner capture failed:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Scanner konnte nicht gestartet werden.', details: error.message },
    });
  }
});

// Save product
app.post('/api/save', requirePermission('products', 'write'), async (req, res) => {
  try {
    const product = req.body;

    // Hard guard: block saving incomplete identify/enrichment results
    const skuCandidate =
      product?.identification?.sku ||
      product?.details?.identifiers?.sku ||
      product?.id;
    const nameCandidate =
      product?.identification?.name ||
      product?.details?.name ||
      product?.details?.title;
    const descCandidate =
      product?.details?.short_description ||
      product?.details?.description;
    const hasImages =
      Array.isArray(product?.details?.images) &&
      product.details.images.some(
        (img) => img && (img.url_or_base64 || img.url || img.href)
      );

    if (
      !skuCandidate ||
      !nameCandidate ||
      !descCandidate ||
      !hasImages
    ) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message:
            'Produkt unvollständig: SKU, Name, Beschreibung oder Bilder fehlen.',
        },
      });
    }


    if (!product || !product.id) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Invalid product data'
        }
      });
    }

    // SKU is allocated/validated in saveProduct(); do not generate here to avoid diverging behavior.

    // Process and upload images to Cloud Storage
    if (product.details && product.details.images) {
      const processedImages = [];

      for (let i = 0; i < product.details.images.length; i++) {
        const image = product.details.images[i];

        // Only process base64 images
        if (image.url_or_base64 && image.url_or_base64.startsWith('data:')) {
          try {
            const variant = image.variant || `image_${i}`;
            const uploadResult = await uploadBase64Image(image.url_or_base64, product.id, variant);
            const manualUpload = !image.source || image.source === 'upload' || image.source === 'uploaded';
            if (manualUpload) {
              await recordManualProductImage({
                productId: product.id,
                publicUrl: uploadResult.url,
                source: image.source || 'upload',
                variant,
                notes: image.notes || null,
                width: uploadResult.width,
                height: uploadResult.height,
              });
            }

            processedImages.push({
              ...image,
              url_or_base64: uploadResult.url,
              source: image.source || 'uploaded',
              width: uploadResult.width ?? image.width ?? null,
              height: uploadResult.height ?? image.height ?? null,
              mimeType: uploadResult.mimeType || image.mimeType || null,
            });
          } catch (error) {
            console.error('Failed to upload image:', error);
            // Keep original image if upload fails
            processedImages.push(image);
          }
        } else {
          // Keep URLs as-is
          processedImages.push(image);
        }
      }

      const filteredImages = processedImages.filter((img) => {
        if (looksGeneratedImageMeta(img) && !isVertexAiImage(img)) {
          console.warn('Rejecting generated image metadata during save:', img?.url_or_base64 || img?.url || '');
          return false;
        }
        return true;
      });

      product.details.images = filteredImages;
    }

    // Save to Firestore
    // Manual UI saves:
    // - allowed to change category
    // - allowed to overwrite descriptions
    // - allowed to delete/replace attributes
    // - should sync identifiers (ean/gtin) from edited barcodes
    const result = await saveProduct(product, {
      allowCategoryChange: true,
      mode: 'manual',
      source: 'ui',
      overwriteTextFields: true,
      replaceAttributes: true,
      syncIdentifiersFromBarcodes: true,
    });

    // Auto-trigger Quality Gate after every UI save (async via runner).
    try {
      const jobId = crypto.randomUUID();
      await createQualityJob(
        {
          payload: { productId: product.id },
          productId: product.id,
          productName: product.identification?.name || '',
          locale: product.locale || 'de-DE',
          reason: 'auto_after_save',
          requestedBy: 'ui',
          force: false,
        },
        jobId
      );
      enqueueQualityJob(jobId, true);
    } catch (qErr) {
      console.warn('Failed to enqueue quality job after save:', qErr?.message || qErr);
    }

    res.json({
      ok: true,
      data: {
        ...result,
        sku: product.identification?.sku || null,
      },
    });
  } catch (error) {
    console.error('Error saving product:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to save product',
        details: error.message
      }
    });
  }
});
// Delete product
app.delete('/api/products/:id', requirePermission('products', 'delete'), async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await getProduct(productId);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found',
        },
      });
    }

    await deleteProductImages(productId);
    await deleteProduct(productId);

    // Safety: by default, delete ONLY the requested product.
    // Optional: allow operators to also purge duplicate docs that share identity aliases.
    const purgeDuplicates = String(req.query?.purgeDuplicates || '').toLowerCase() === 'true';
    let purgedDuplicates = [];
    if (purgeDuplicates) {
      const aliasSeeds = [
        ...(product.ops?.identity_aliases || []),
        ...(product.identification?.barcodes || []),
        product.identification?.sku,
        product.details?.identifiers?.ean,
        product.details?.identifiers?.gtin,
        product.details?.identifiers?.upc,
        product.details?.identifiers?.mpn,
        product.details?.identifiers?.sku,
        product.id,
      ];
      const aliasCandidates = Array.from(
        new Set(aliasSeeds.filter((token) => typeof token === 'string' && token.trim()))
      );
      if (aliasCandidates.length) {
        const duplicateIds = await findProductIdsByAliases(aliasCandidates, { excludeProductId: productId });
        if (duplicateIds.length) {
          await Promise.all(
            duplicateIds.map(async (dupId) => {
              await deleteProductImages(dupId);
              await deleteProduct(dupId);
            })
          );
          purgedDuplicates = duplicateIds;
        }
      }
    }

    res.json({ ok: true, purgedDuplicates });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to delete product',
        details: error.message
      }
    });
  }
});

// Bulk delete products (permanent)
app.post('/api/products/bulk-delete', requirePermission('products', 'delete'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!ids.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'ids[] is required' },
      });
    }
    // Safety: default false (do not delete extra docs unless explicitly requested)
    const purgeDuplicates = Boolean(req.body?.purgeDuplicates);

    const deleted = [];
    const notFound = [];
    const failed = [];
    const purgedDuplicatesById = {};

    for (const id of ids) {
      try {
        const product = await getProduct(id);
        if (!product) {
          notFound.push(id);
          continue;
        }
        await deleteProductImages(id);
        await deleteProduct(id);
        deleted.push(id);

        if (purgeDuplicates) {
          const aliasSeeds = [
            ...(product.ops?.identity_aliases || []),
            ...(product.identification?.barcodes || []),
            product.identification?.sku,
            product.details?.identifiers?.ean,
            product.details?.identifiers?.gtin,
            product.details?.identifiers?.upc,
            product.details?.identifiers?.mpn,
            product.details?.identifiers?.sku,
            product.id,
          ];
          const aliasCandidates = Array.from(
            new Set(aliasSeeds.filter((token) => typeof token === 'string' && token.trim()))
          );
          if (aliasCandidates.length) {
            const duplicateIds = await findProductIdsByAliases(aliasCandidates, { excludeProductId: id });
            if (duplicateIds.length) {
              await Promise.all(
                duplicateIds.map(async (dupId) => {
                  await deleteProductImages(dupId);
                  await deleteProduct(dupId);
                })
              );
              purgedDuplicatesById[id] = duplicateIds;
            }
          }
        }
      } catch (e) {
        failed.push({ id, error: e?.message || String(e) });
      }
    }

    return res.json({
      ok: true,
      deleted,
      notFound,
      failed,
      purgedDuplicatesById,
    });
  } catch (error) {
    console.error('Error bulk deleting products:', error);
    return res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to bulk delete products',
        details: error.message,
      },
    });
  }
});

app.delete('/api/products/cleanup-by-alias/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    if (!alias || !alias.trim()) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Alias parameter is required',
        },
      });
    }
    const requestedLimit = req.query?.limit ? parseInt(req.query.limit, 10) : undefined;
    const options = Number.isFinite(requestedLimit) ? { limit: requestedLimit } : undefined;
    const result = await deleteProductsByIdentityAlias(alias, options || {});
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Error deleting products by alias:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to delete products by alias',
        details: error.message,
      },
    });
  }
});

app.post('/api/chat', requirePermission('ai', 'chat'), chatUploadMiddleware, async (req, res) => {
  try {
    const { productId, message, model: bodyModel, scope } = req.body;
    const modelOverride = req.query?.model || bodyModel || null;
    const attachments =
      Array.isArray(req.files) && req.files.length
        ? req.files.map((file) => ({
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          buffer: file.buffer,
        }))
        : [];
    const hasAttachments = attachments.length > 0;
    const normalizedMessage = typeof message === 'string' ? message.trim() : '';

    if (!productId || (!normalizedMessage && !hasAttachments)) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Product ID und entweder eine Nachricht oder Dateianhänge sind erforderlich.',
        },
      });
    }

    const product = await getProduct(productId);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found',
        },
      });
    }

    const chatResult = await runProductChat(product, normalizedMessage || 'Bitte analysiere die angehängten Dateien.', {
      modelOverride,
      attachments,
      scope: typeof scope === 'string' ? scope.trim() : null,
    });

    res.json({
      ok: true,
      model: chatResult.modelUsed,
      data: chatResult,
    });
  } catch (error) {
    console.error('Error in chat endpoint:', error);
    res.status(500).json({
      ok: false,
      model: error.modelUsed,
      error: {
        code: 500,
        message: 'Failed to process chat request',
        details: error.message,
      },
    });
  }
});

app.get('/api/orders', requirePermission('orders', 'read'), async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    // Return cached orders immediately; trigger background sync best-effort
    let rawOrders = await listOrders(limit);
    backgroundSyncOrders();

    if (!Array.isArray(rawOrders)) {
      rawOrders = [];
    }

    const cappedOrders = Array.isArray(rawOrders) ? rawOrders.slice(0, limit) : [];
    const orders = await attachPickHintsToOrders(cappedOrders);
    res.json({ ok: true, data: orders });
  } catch (error) {
    console.error('Failed to load orders:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Aufträge konnten nicht geladen werden.',
        details: error.message,
      },
    });
  }
});

app.get('/api/dashboard/metrics', requirePermission('dashboard', 'read'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query?.days || '7', 10) || 7, 1), 60);
    const preset = typeof req.query?.preset === 'string' ? String(req.query.preset).trim() : null;
    // Best-effort: trigger order sync in background so metrics converge to BaseLinker truth.
    // Do NOT await (avoid slow dashboard loads).
    try {
      backgroundSyncOrders();
    } catch {
      // ignore
    }
    const metrics = await getDashboardMetrics({ days, preset });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: metrics });
  } catch (error) {
    console.error('Failed to load dashboard metrics:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Dashboard-Metriken konnten nicht geladen werden.',
        details: error.message,
      },
    });
  }
});

app.post('/api/orders/sync', requirePermission('orders', 'read'), async (req, res) => {
  try {
    // Kick off background sync, but respond immediately with cached orders
    backgroundSyncOrders();
    const rawOrders = await listOrders(Math.min(Number(req.query?.limit) || 200, 100));

    const orders = await attachPickHintsToOrders(rawOrders || []);
    res.json({ ok: true, data: orders });
  } catch (error) {
    console.error('Failed to sync orders:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragssync fehlgeschlagen.',
        details: error.message,
      },
    });
  }
});

app.post('/api/orders/:orderId/complete', requirePermission('orders', 'pick'), async (req, res) => {
  try {
    const { orderId } = req.params;
    await markOrderAsPicked(orderId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to complete order:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragsstatus konnte nicht aktualisiert werden.',
        details: error.message,
      },
    });
  }
});

app.post('/api/orders/:orderId/pack', requirePermission('orders', 'pack'), async (req, res) => {
  try {
    const { orderId } = req.params;
    await markOrderAsPacked(orderId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to mark order as packed:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Auftragsstatus konnte nicht aktualisiert werden.',
        details: error.message,
      },
    });
  }
});

// --- Price Refresh Endpoint ---
app.post('/api/price-refresh', async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Product ID is required'
        }
      });
    }

    // Load product from Firestore
    const product = await getProduct(productId);
    if (!product) {
      return res.status(404).json({
        ok: false,
        error: {
          code: 404,
          message: 'Product not found'
        }
      });
    }

    const force = Boolean(req.body?.force);
    const result = await enrichPriceForProductBestEffort(product, { force, reason: 'api/price-refresh' });
    if (!result.ok) {
      return res.json({
        ok: false,
        error: { code: 404, message: 'No reliable price candidates found (min €1, evidence required).' },
        serpTrace: result.serpTrace || [],
      });
    }

    if (result.updated) {
      await saveProduct(product, { source: 'script' });
    }

    return res.json({
      ok: true,
      data: result.data,
      serpTrace: result.serpTrace || [],
    });

  } catch (error) {
    console.error('Error in price refresh:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Failed to refresh price',
        details: error.message
      }
    });
  }
});

app.post('/api/products/:id/improve', requirePermission('ai', 'improve'), async (req, res) => {
  try {
    const productId = req.params.id;
    if (!productId) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Product ID is required' },
      });
    }
    const improved = await improveExistingProduct(productId);
    res.json({ ok: true, data: improved });
  } catch (error) {
    const status = error.code === 404 ? 404 : 500;
    res.status(status).json({
      ok: false,
      error: { code: status, message: error.message || 'Failed to improve product' },
    });
  }
});

app.post('/api/products/bulk-improve', requirePermission('ai', 'improve'), async (req, res) => {
  try {
    const products = await getAllProducts();
    const queuedJobs = [];

    console.log(`[bulk-improve] Starting bulk improvement for ${products.length} products...`);

    for (const product of products) {
      if (!product.id) continue;

      const jobId = crypto.randomUUID();
      await createImproveJob(
        {
          payload: {
            productId: product.id,
            triggeredBy: 'bulk-api',
          },
          productId: product.id,
          productName: product.identification?.name || 'Bulk Update',
        },
        jobId
      );
      enqueueImproveJob(jobId);
      queuedJobs.push({
        jobId,
        productId: product.id,
      });
    }

    console.log(`[bulk-improve] Enqueued ${queuedJobs.length} jobs.`);

    res.json({
      ok: true,
      data: {
        enqueuedParams: queuedJobs.length,
        jobs: queuedJobs,
      },
    });
  } catch (error) {
    console.error('Failed to start bulk improvement:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Bulk improvement failed.',
        details: error.message,
      },
    });
  }
});

async function runImproveJobInline(jobId, productId) {
  // Fallback: verarbeitet den Improve-Job synchron im Request, wenn IMPROVE_INLINE=true
  try {
    await updateJob(jobId, { status: 'processing', stage: 'inline', startedAt: Timestamp.now() });
    const improvedProduct = await improveExistingProduct(productId, async (stage) => {
      try {
        await updateJob(jobId, { stage });
      } catch (err) {
        console.warn(`Inline updateJob stage failed for ${jobId}:`, err.message);
      }
    });
    await updateJob(jobId, {
      status: 'done',
      stage: 'complete',
      finishedAt: Timestamp.now(),
      result: { product: improvedProduct },
      error: null,
    });
  } catch (error) {
    console.error(`Inline improve job ${jobId} failed:`, error);
    await updateJob(jobId, {
      status: 'failed',
      stage: 'error',
      finishedAt: Timestamp.now(),
      error: { message: error.message, stack: error.stack?.slice(0, 500) },
    });
  }
}

app.post('/api/improve/jobs', requirePermission('ai', 'improve'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const uniqueIds = [...new Set(rawIds.map((id) => String(id || '').trim()))].filter(Boolean);
    if (!uniqueIds.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Es wurden keine gültigen Produkt-IDs übermittelt.' },
      });
    }
    if (uniqueIds.length > MAX_IMPROVE_BATCH) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: `Maximal ${MAX_IMPROVE_BATCH} Produkte können gleichzeitig verbessert werden.`,
        },
      });
    }

    const jobs = [];
    const missing = [];

    for (const productId of uniqueIds) {
      const product = await getProduct(productId);
      if (!product) {
        missing.push(productId);
        continue;
      }
      const jobId = crypto.randomUUID();
      await createImproveJob(
        {
          payload: { productId },
          productId,
          productName: product.identification?.name || '',
        },
        jobId
      );
      enqueueImproveJob(jobId);
      jobs.push({ jobId, productId });
    }

    if (!jobs.length) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message: 'Keine Improve-Jobs konnten erstellt werden (Produkte nicht gefunden).',
          missing,
        },
      });
    }

    // Inline-Modus: nur für sehr kleine Batches (sonst HTTP-Timeouts)
    const inlineAllowed = IMPROVE_INLINE && jobs.length <= 3;
    if (inlineAllowed) {
      for (const job of jobs) {
        await runImproveJobInline(job.jobId, job.productId);
      }
    }

    res.json({
      ok: true,
      data: {
        jobs,
        missing,
      },
    });
  } catch (error) {
    console.error('Failed to create improve jobs:', error);
    res.status(500).json({
      ok: false,
      error: {
        code: 500,
        message: 'Improve-Jobs konnten nicht angelegt werden.',
        details: error.message,
      },
    });
  }
});

app.get('/api/improve/jobs/:id', requirePermission('ai', 'improve'), async (req, res) => {
  try {
    const job = await getImproveJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: { code: 404, message: 'Improve-Job wurde nicht gefunden.' },
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load improve job:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Improve-Job konnte nicht geladen werden.', details: error.message },
    });
  }
});

// --- Quality Gate Jobs ---
const MAX_QUALITY_BATCH = parseInt(process.env.MAX_QUALITY_BATCH || '50', 10);
app.post('/api/quality/jobs', requirePermission('jobs', 'read'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    const uniqueIds = [...new Set(rawIds.map((id) => String(id || '').trim()))].filter(Boolean);
    if (!uniqueIds.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Es wurden keine gültigen Produkt-IDs übermittelt.' },
      });
    }
    if (uniqueIds.length > MAX_QUALITY_BATCH) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: `Maximal ${MAX_QUALITY_BATCH} Produkte können gleichzeitig geprüft werden.` },
      });
    }

    const jobs = [];
    const missing = [];
    for (const productId of uniqueIds) {
      const product = await getProduct(productId);
      if (!product) {
        missing.push(productId);
        continue;
      }
      const jobId = crypto.randomUUID();
      await createQualityJob(
        {
          payload: { productId },
          productId,
          productName: product.identification?.name || '',
          locale: product.locale || 'de-DE',
          reason: req.body?.reason || 'manual',
          requestedBy: req.body?.requestedBy || 'ui',
          force: Boolean(req.body?.force),
        },
        jobId
      );
      enqueueQualityJob(jobId);
      jobs.push({ jobId, productId });
    }

    if (!jobs.length) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'Keine Quality-Jobs konnten erstellt werden (Produkte nicht gefunden).', missing },
      });
    }

    res.json({ ok: true, data: { jobs, missing } });
  } catch (error) {
    console.error('Failed to create quality jobs:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Quality-Jobs konnten nicht angelegt werden.', details: error.message },
    });
  }
});

app.get('/api/quality/jobs/:id', requirePermission('jobs', 'read'), async (req, res) => {
  try {
    const job = await getQualityJob(req.params.id);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: { code: 404, message: 'Quality-Job wurde nicht gefunden.' },
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load quality job:', error);
    res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Quality-Job konnte nicht geladen werden.', details: error.message },
    });
  }
});

// --- Server Start ---
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);

  // Best-effort periodic order status refresh so BaseLinker-internal status changes
  // (e.g. "Versendet") are reflected in AvyCloud without requiring user interaction.
  const ORDER_SYNC_INTERVAL_MS = parseInt(process.env.ORDER_SYNC_INTERVAL_MS || String(2 * 60 * 60 * 1000), 10);
  try {
    setTimeout(() => backgroundSyncOrders(), 10_000);
    setInterval(() => backgroundSyncOrders(), ORDER_SYNC_INTERVAL_MS);
    console.log(`[order-sync] periodic refresh enabled: every ${ORDER_SYNC_INTERVAL_MS}ms`);
  } catch (err) {
    console.warn('[order-sync] failed to start periodic refresh:', err?.message || err);
  }
});
