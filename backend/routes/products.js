const router = require('express').Router();
const crypto = require('crypto');
const path = require('path');
const {
  PRODUCTS_COLLECTION,
  saveProduct,
  getProduct,
  getAllProducts,
  deleteProduct,
  updateProductSyncStatus,
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
} = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');
const { buildIdentityAliasSet, computeProductIdentityKey } = require('../lib/product-identity');
const {
  createJob: createImproveJob,
  getJob: getImproveJob,
  updateJob,
  Timestamp,
} = require('../lib/improve-jobs');
const { uploadBase64Image, deleteProductImages } = require('../lib/storage');
const { recordManualProductImage } = require('../lib/product-images');
const { requirePermission, resolvePermissionsForUser } = require('../lib/rbac');
const { fetchWithUnlocker } = require('../lib/web-unlocker');
const { isBannedEbayBreadcrumb } = require('../lib/ebay-category-governance');
const { getCategoryAspectCatalog, findEbayCategory } = require('../lib/ebay-taxonomy');
const { improveExistingProduct } = require('../services/improve');
const { enrichPriceForProductBestEffort } = require('../lib/price-enrichment');
const { FieldValue } = require('../lib/jobs');
const {
  listBinsForProduct,
  getProductBinSummaryMap,
} = require('../lib/warehouse');
const {
  buildProductLabelsHtml,
  buildBinLabelHtml,
  buildBinLabelsHtml,
  buildBinLabelsPdf,
  buildInventoryLabelPdf,
} = require('../services/label-printer');
const { scanToBuffer } = require('../services/scanner');
const { createJob: createAdminBulkJob, getJob: getAdminBulkJob } = require('../lib/admin-bulk-jobs');
const { enqueueAdminBulkJob } = require('../services/admin-bulk-runner');
const { createJob: createQualityJob, getJob: getQualityJob, Timestamp: QualityTimestamp, updateJob: updateQualityJob } = require('../lib/quality-jobs');
const { enqueueQualityJob } = require('../services/quality-runner');
const { enqueueImproveJob } = require('../services/improve-runner');
const { getSecretValue } = require('../lib/secret-values');
const { generateImagesForProduct } = require('../services/image-generation');
const { calculateOptimalPrice, savePricingRule, listPricingRules, runRepricingJob } = require('../services/pricing-engine');
const { calculateSalesVelocity, predictStockOut, generateReorderAlerts } = require('../services/inventory-forecast');
const { createWebhook, listWebhooks, deleteWebhook } = require('../services/webhooks');
const { findDuplicates, suggestMerge, executeMerge } = require('../services/deduplication');
const { logAudit, diffProduct } = require('../services/audit-log');
const { generateChannelListings } = require('../services/listing-pipeline');

// ── Constants ────────────────────────────────────────────────────────
const IMAGE_PROXY_TIMEOUT_MS = parseInt(process.env.IMAGE_PROXY_TIMEOUT_MS || '10000', 10);
const IMAGE_PROXY_MAX_BYTES = parseInt(process.env.IMAGE_PROXY_MAX_BYTES || `${5 * 1024 * 1024}`, 10); // 5 MB by default
const MAX_IMPROVE_BATCH = parseInt(process.env.MAX_IMPROVE_BATCH || '100', 10);
// IMPORTANT: Inline-Improve causes request timeouts for anything but tiny batches (Cloud Run / reverse proxies).
// Therefore it is OFF by default and must be explicitly enabled via IMPROVE_INLINE=true.
const IMPROVE_INLINE = (process.env.IMPROVE_INLINE ?? 'false') === 'true';
const MAX_QUALITY_BATCH = parseInt(process.env.MAX_QUALITY_BATCH || '50', 10);
const GENERATED_IMAGE_SIGNATURE = /\b(generated|gpt|gemini|ai[-\s]?image|ai[-\s]?render)\b/i;

// ── Helper Functions ─────────────────────────────────────────────────

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

// Orders that don't count as sold (everything else = sold)
const EXCLUDED_ORDER_STATUSES = new Set(['cancelled', 'returned']);
// Orders where the item has already left the warehouse
const SHIPPED_ORDER_STATUSES = new Set(['shipped', 'delivered', 'completed']);

async function buildSoldQuantityMap() {
  const map = new Map(); // normalizeSkuKey -> { sold: number, open: number }
  try {
    const snap = await firestore.collection('orders').get();
    snap.forEach((doc) => {
      const order = doc.data() || {};
      const status = (order.omsStatus || order.status || '').toLowerCase();
      if (!status || EXCLUDED_ORDER_STATUSES.has(status)) return;
      const items = Array.isArray(order.items) ? order.items : [];
      const isShipped = SHIPPED_ORDER_STATUSES.has(status);
      for (const item of items) {
        const key = normalizeSkuKey(item?.sku || item?.productId || '');
        const qty = Number(item?.quantity || 0);
        if (!key || qty <= 0) continue;
        const entry = map.get(key) || { sold: 0, open: 0 };
        if (isShipped) {
          entry.sold += qty;
        } else {
          entry.open += qty;
        }
        map.set(key, entry);
      }
    });
  } catch (error) {
    console.warn('buildSoldQuantityMap failed:', error.message);
  }
  return map;
}

function attachReservedAvailability(products = [], reservedMap, soldMap) {
  if (!Array.isArray(products) || !products.length) return products;
  const rMap = reservedMap instanceof Map ? reservedMap : new Map();
  const sMap = soldMap instanceof Map ? soldMap : new Map();
  return products.map((product) => {
    const skuCandidate =
      product?.details?.identifiers?.sku || product?.identification?.sku || product?.id;
    const key = normalizeSkuKey(skuCandidate);
    const reservedQuantity = key ? Number(rMap.get(key) || 0) : 0;
    const soldEntry = key ? sMap.get(key) : null;
    const soldQuantity = soldEntry ? soldEntry.sold : 0;
    const openOrderQuantity = soldEntry ? soldEntry.open : 0;
    const physicalQuantity = Number(product?.inventory?.quantity || 0);
    const availableQuantity = Math.max(0, physicalQuantity - reservedQuantity);
    return {
      ...product,
      inventory: {
        ...(product.inventory || {}),
        physicalQuantity,
        reservedQuantity,
        availableQuantity,
        soldQuantity,
        openOrderQuantity,
      },
    };
  });
}

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
  const hasOpsLink = Boolean(ops?.sync_status);

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

// ── eBay Category Helpers (needed by normalizeProductForApi) ─────────
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

const normalizeBreadcrumbKey = (value = '') =>
  value
    .toString()
    .split('>')
    .map((segment) => segment.toString().trim())
    .filter(Boolean)
    .join(' > ');

const getEbayCategoryEntries = () => {
  if (EBAY_CATEGORY_ENTRIES && EBAY_CATEGORY_BY_ID) {
    return { entries: EBAY_CATEGORY_ENTRIES, byId: EBAY_CATEGORY_BY_ID };
  }
  const filePath = path.join(__dirname, '..', 'ebay-data', 'categories.json');
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
      breadcrumb: normalizeBreadcrumbKey(breadcrumb),
      leaf: false,
    };
    entry.search = normalizeCategoryText(`${entry.breadcrumb} ${entry.name}`);
    entry.root = String(entry.breadcrumb || '').split('>').map((s) => s.trim()).filter(Boolean)[0] || '';
    entry.banned = Boolean(isBannedEbayBreadcrumb(entry.breadcrumb));
    entries.push(entry);
    byId.set(entry.id, entry);
  });

  // Mark leaf nodes once so callers can enforce listing-safe category selection.
  const parentBreadcrumbs = new Set();
  entries.forEach((entry) => {
    const parts = entry.breadcrumb.split('>').map((s) => s.trim()).filter(Boolean);
    for (let i = 1; i < parts.length; i += 1) {
      parentBreadcrumbs.add(parts.slice(0, i).join(' > ').toLowerCase());
    }
  });
  entries.forEach((entry) => {
    const key = normalizeBreadcrumbKey(entry.breadcrumb).toLowerCase();
    entry.leaf = !parentBreadcrumbs.has(key);
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
  if (entry.banned) return null;
  return {
    id: entry.id,
    name: entry.name,
    breadcrumb: entry.breadcrumb,
    leaf: Boolean(entry.leaf),
  };
};

// Ensure API responses always have the minimum nested structure expected by the frontend.
// This prevents UI crashes when Firestore contains partial/stub documents.
function normalizeProductForApi(product = {}) {
  const p = product && typeof product === 'object' ? product : {};
  const identification =
    p.identification && typeof p.identification === 'object' ? p.identification : {};
  const details = p.details && typeof p.details === 'object' ? { ...p.details } : {};
  const identifiers =
    details.identifiers && typeof details.identifiers === 'object' ? details.identifiers : {};
  const pricing = details.pricing && typeof details.pricing === 'object' ? details.pricing : {};
  const lowest =
    pricing.lowest_price && typeof pricing.lowest_price === 'object' ? pricing.lowest_price : {};
  const ops = p.ops && typeof p.ops === 'object' ? p.ops : {};

  const rawCategoryId =
    details.categoryId || details.ebayCategoryId || details.ebay_category_id || null;
  const normalizedCategoryId = rawCategoryId
    ? String(rawCategoryId).replace(/\D+/g, '').trim()
    : '';
  const ebayCategory = normalizedCategoryId ? getEbayCategoryById(normalizedCategoryId) : null;
  const categoryIdForApi = ebayCategory?.id || normalizedCategoryId || '';
  const categoryPathForApi = ebayCategory?.breadcrumb || '';

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
      category: categoryPathForApi,
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
      categoryId: categoryIdForApi || undefined,
    },
    ops: {
      ...ops,
      sync_status: ops.sync_status || 'pending',
      revision: typeof ops.revision === 'number' ? ops.revision : 0,
    },
    storageBins: Array.isArray(p.storageBins) ? p.storageBins : [],
  };
}

// ── Category Profile Helpers ─────────────────────────────────────────
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

// ── Improve Job Inline Helper ────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════
// ── Routes ───────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// --- Product-bins route delegated to warehouse domain ---
router.get('/products/:id/bins', requirePermission('warehouse', 'read'), async (req, res) => {
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

// --- Product Bulk Actions (selected products from Inventory table) ---
// Same engine as AdminBulk, but permission is products.write (so Catalog/Admin can use it from inventory UI).
router.post('/products/bulk/run', requirePermission('products', 'write'), async (req, res) => {
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
      inventoryId: typeof body.inventoryId === 'string' ? body.inventoryId : undefined,
      marketplaceId: typeof body.marketplaceId === 'string' ? body.marketplaceId : undefined,
      titleInsights: body.titleInsights === undefined ? undefined : Boolean(body.titleInsights),
      titleInsightsQuery: typeof body.titleInsightsQuery === 'string' ? body.titleInsightsQuery : undefined,
      titleInsightsForceRefresh:
        body.titleInsightsForceRefresh === undefined ? undefined : Boolean(body.titleInsightsForceRefresh),
      titleInsightsLimit: Number.isFinite(Number(body.titleInsightsLimit)) ? Number(body.titleInsightsLimit) : undefined,
      titleInsightsMaxHints:
        Number.isFinite(Number(body.titleInsightsMaxHints)) ? Number(body.titleInsightsMaxHints) : undefined,
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

router.get('/products/bulk/jobs/:id', requirePermission('products', 'read'), async (req, res) => {
  try {
    const job = await getAdminBulkJob(String(req.params.id));
    if (!job) return res.status(404).json({ ok: false, error: { code: 404, message: 'Job not found' } });
    return res.status(200).json({ ok: true, data: job });
  } catch (error) {
    console.error('Failed to load product bulk job:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load job', details: error.message } });
  }
});

// --- Inventories ---
router.get('/inventories', requirePermission('inventories', 'read'), async (req, res) => {
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

router.get('/inventories/:id', requirePermission('inventories', 'read'), async (req, res) => {
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

router.get('/inventories/:id/label.pdf', requirePermission('inventories', 'read'), async (req, res) => {
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

router.post('/inventories/assign', async (req, res) => {
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

router.post('/products/:productId/inventory', requirePermission('products', 'write'), async (req, res) => {
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
router.get('/me/permissions', async (req, res) => {
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

// --- Image Proxy ---
router.get('/image-proxy', async (req, res) => {
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
    // GCS URLs from our own bucket: fetch directly (faster, no BrightData needed)
    const isOwnGcs = target.hostname === 'storage.googleapis.com' && target.pathname.startsWith('/prodsandjobs/');
    let upstream;
    if (isOwnGcs) {
      const directRes = await fetch(target.toString(), {
        headers: { Accept: 'image/*,*/*;q=0.8' },
        signal: AbortSignal.timeout(IMAGE_PROXY_TIMEOUT_MS),
      });
      upstream = {
        success: directRes.ok,
        status: directRes.status,
        contentType: directRes.headers.get('content-type') || 'image/jpeg',
        body: Buffer.from(await directRes.arrayBuffer()),
      };
    } else {
      // Try direct fetch first (works for most CDNs: eBay, Amazon, Google, etc.)
      try {
        const directRes = await fetch(target.toString(), {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Accept: 'image/*,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(IMAGE_PROXY_TIMEOUT_MS),
          redirect: 'follow',
        });
        if (directRes.ok) {
          const ct = directRes.headers.get('content-type') || '';
          if (ct.startsWith('image/') || ct === 'application/octet-stream') {
            upstream = {
              success: true,
              status: directRes.status,
              contentType: ct || 'image/jpeg',
              body: Buffer.from(await directRes.arrayBuffer()),
            };
          }
        }
      } catch {
        // Direct fetch failed — fall through to BrightData
      }

      // Fallback to BrightData unlocker if direct fetch didn't work
      if (!upstream) {
        upstream = await fetchWithUnlocker({
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
      }
    }

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

// --- Intake Resolver ---
// If a product already exists (strict EAN/GTIN/SKU match), we must NOT create/overwrite a new datasheet.
// Instead, we only bump pending intake quantity (and optionally inventory) and return the canonical product.
router.post('/intake/resolve', async (req, res) => {
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
router.post('/generate-images', async (req, res) => {
  try {
    const { productId, product, referenceImage } = req.body || {};

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

// --- AI Listing Pipeline ---
router.post('/listing-pipeline', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const productId = String(body.productId || '').trim();
    if (!productId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Missing productId' } });
    }
    const channels = Array.isArray(body.channels) ? body.channels : undefined;
    const result = await generateChannelListings(productId, { channels });
    return res.json({ ok: true, data: result });
  } catch (err) {
    console.error(`[POST /api/products/listing-pipeline] ${err.message}`, err);
    const status = err.status || 500;
    const code = err.code || 'INTERNAL';
    return res.status(status).json({ ok: false, error: { code, message: err.message } });
  }
});

// --- Scanner ---
router.post('/scanner/capture', requirePermission('identify', 'run'), async (req, res) => {
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

// --- Category Profiles ---
router.get('/categories/profiles', requirePermission('categories', 'read'), async (req, res) => {
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

router.put('/categories/profiles/:id', requirePermission('categories', 'write'), async (req, res) => {
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

// --- Product Labels (batch — must be before /:id routes) ---
router.get('/products/labels', requirePermission('products', 'read'), async (req, res) => {
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

// --- Bulk Delete (must be before /:id routes) ---
router.post('/products/bulk-delete', requirePermission('products', 'delete'), async (req, res) => {
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

// --- Cleanup by Alias (must be before /:id routes) ---
router.delete('/products/cleanup-by-alias/:alias', async (req, res) => {
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

// --- Bulk Improve (must be before /:id routes) ---
router.post('/products/bulk-improve', requirePermission('ai', 'improve'), async (req, res) => {
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

// --- Get all products ---
router.get('/products', requirePermission('products', 'read'), async (req, res) => {
  try {
    // Parallelise independent Firestore queries to cut latency (mobile timeout fix)
    const [products, reservedMap, soldMap] = await Promise.all([
      getAllProducts(),
      buildReservedOpenOrderMap(),
      buildSoldQuantityMap(),
    ]);
    const filteredProducts = Array.isArray(products)
      ? products.filter((p) => !isGhostProduct(p))
      : [];
    // NOTE: Filter ghost/stub docs early to avoid showing meaningless rows in the AdminTable.
    // Rebuild enriched pipeline using the filtered set to keep counts consistent.
    const enrichedFiltered = await enrichProductsWithBinSummaries(filteredProducts);
    const withReservedFiltered = attachReservedAvailability(enrichedFiltered, reservedMap, soldMap);
    const withCompletenessFiltered = withReservedFiltered.map((p) => {
      const normalized = normalizeProductForApi(p);
      return {
        ...normalized,
        completeness: computeCompleteness(normalized),
      };
    });

    res.json({ ok: true, products: withCompletenessFiltered });
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

// --- SSE Product Stream — real-time product updates via Firestore onSnapshot ---
router.get('/products/stream', requirePermission('products', 'read'), (req, res) => {
  const COLLECTION = process.env.USE_PRODUCTS_V2 === 'true' ? 'products_v2' : (process.env.PRODUCT_COLLECTION || 'products');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');

  let isFirst = true;
  const unsubscribe = firestore.collection(COLLECTION).onSnapshot((snapshot) => {
    if (isFirst) {
      // Skip initial full snapshot — client already has data from initial GET
      isFirst = false;
      res.write(`event: connected\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
      return;
    }
    const changes = snapshot.docChanges().map((change) => ({
      type: change.type,
      id: change.doc.id,
      data: change.type !== 'removed' ? change.doc.data() : undefined,
    }));
    if (changes.length > 0) {
      res.write(`event: update\ndata: ${JSON.stringify({ changes, ts: new Date().toISOString() })}\n\n`);
    }
  }, (err) => {
    console.error(`[SSE] Product stream error: ${err.message}`);
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// --- Get single product ---
router.get('/products/:id', requirePermission('products', 'read'), async (req, res) => {
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

// --- Product Label (single) ---
router.get('/products/:id/label', requirePermission('products', 'read'), async (req, res) => {
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

// --- Save product ---
router.post('/save', requirePermission('products', 'write'), async (req, res) => {
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
    const categoryId = String(product?.details?.categoryId || '').trim();
    const resolvedCategory = categoryId ? findEbayCategory(categoryId) : null;
    const breadcrumb = resolvedCategory?.breadcrumb ? String(resolvedCategory.breadcrumb) : '';
    const hasValidCategory = Boolean(
      categoryId &&
      resolvedCategory &&
      breadcrumb &&
      breadcrumb.includes('>') &&
      !isBannedEbayBreadcrumb(breadcrumb)
    );

    if (
      !skuCandidate ||
      !nameCandidate ||
      !descCandidate ||
      !hasImages ||
      !hasValidCategory
    ) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 400,
          message:
            'Produkt unvollständig: SKU, Name, Beschreibung, Kategorie oder Bilder fehlen/ungültig.',
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
        if (typeof image.url_or_base64 === 'string' && image.url_or_base64.startsWith('data:')) {
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

    // Read existing product for audit diff (fire-and-forget on failure)
    let productBefore = null;
    try {
      const snap = await firestore.collection(PRODUCTS_COLLECTION).doc(product.id).get();
      if (snap.exists) productBefore = { id: product.id, ...snap.data() };
    } catch { /* ignore */ }

    // Save to Firestore
    // Manual UI saves:
    // - allowed to change category
    // - allowed to overwrite descriptions
    // - allowed to delete/replace attributes
    // - should sync identifiers (ean/gtin) from edited barcodes
    const result = await saveProductV2(product, {
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

    // Auto-push price to marketplaces when pricing changes (async, non-blocking)
    try {
      const sellPrice = product.details?.pricing?.sellPrice ?? product.pricing?.sellPrice;
      if (Number.isFinite(sellPrice) && sellPrice > 0) {
        const { syncPriceToAllChannels } = require('../services/stock-sync-dispatcher');
        // Read fresh product from Firestore so we have marketplace.ebay.itemId
        // (publishProduct writes itemId to 'products' collection, not in req.body)
        const freshSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(product.id).get();
        const freshProduct = freshSnap.exists ? { id: product.id, ...freshSnap.data() } : product;
        // Merge current sellPrice in case it hasn't propagated to Firestore yet
        if (!freshProduct.details) freshProduct.details = {};
        if (!freshProduct.details.pricing) freshProduct.details.pricing = {};
        freshProduct.details.pricing.sellPrice = sellPrice;
        syncPriceToAllChannels({
          tenantId: req.user?.tenantId || 'default',
          product: freshProduct,
        }).then((syncResult) => {
          const pushed = (syncResult?.results || []).filter((r) => r.status === 'success');
          if (pushed.length > 0) {
            console.log(`[auto-price-push] product=${product.id} pushed to ${pushed.map((r) => r.channel).join(', ')}`);
          }
        }).catch((err) => {
          console.warn(`[auto-price-push] failed for product=${product.id}:`, err?.message);
        });
      }
    } catch (priceErr) {
      console.warn('[auto-price-push] setup error:', priceErr?.message);
    }

    // Audit log: product updated/created
    try {
      const isNew = !productBefore;
      const changes = isNew ? [] : diffProduct(productBefore, product);
      logAudit({
        action: isNew ? 'product.created' : 'product.updated',
        userId: req.user?.uid,
        userEmail: req.user?.email,
        tenantId: req.user?.tenantId || 'default',
        resourceType: 'product',
        resourceId: product.id,
        details: {
          productName: product.identification?.name || product.details?.title || '',
          sku: product.identification?.sku || '',
          source: 'ui',
          changedFields: changes.map(c => c.field),
          changes: changes.slice(0, 50),
        },
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
      });
    } catch { /* audit must never break save */ }

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

// --- Delete product ---
router.delete('/products/:id', requirePermission('products', 'delete'), async (req, res) => {
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

    // Audit log: product deleted
    try {
      logAudit({
        action: 'product.deleted',
        userId: req.user?.uid,
        userEmail: req.user?.email,
        tenantId: req.user?.tenantId || 'default',
        resourceType: 'product',
        resourceId: productId,
        details: {
          productName: product.identification?.name || product.details?.title || '',
          sku: product.identification?.sku || '',
        },
        ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
      });
    } catch { /* audit must never break delete */ }

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

// --- Price Refresh ---
router.post('/price-refresh', async (req, res) => {
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
      await saveProductV2(product, { source: 'script' });
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

// --- AI Improve ---
router.post('/products/:id/improve', requirePermission('ai', 'improve'), async (req, res) => {
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

// --- Improve Jobs ---
router.post('/improve/jobs', requirePermission('ai', 'improve'), async (req, res) => {
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

router.get('/improve/jobs/:id', requirePermission('ai', 'improve'), async (req, res) => {
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
router.post('/quality/jobs', requirePermission('jobs', 'read'), async (req, res) => {
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

router.get('/quality/jobs/:id', requirePermission('jobs', 'read'), async (req, res) => {
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

// --- Pricing Engine (v1) ---
router.post('/v1/pricing/suggest/:productId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const analysis = await calculateOptimalPrice(req.params.productId);
    res.json({ ok: true, data: analysis });
  } catch (error) {
    console.error('[POST /api/v1/pricing/suggest] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/v1/pricing/rules', requirePermission('products', 'write'), async (req, res) => {
  try {
    const rule = await savePricingRule(req.body);
    res.json({ ok: true, data: rule });
  } catch (error) {
    console.error('[POST /api/v1/pricing/rules] Error:', error.message);
    res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: error.message } });
  }
});

router.get('/v1/pricing/rules', requirePermission('products', 'read'), async (req, res) => {
  try {
    const all = req.query.all === 'true';
    if (all) {
      const snap = await firestore.collection('pricingRules').get();
      const rules = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return res.json({ ok: true, data: rules });
    }
    const rules = await listPricingRules();
    res.json({ ok: true, data: rules });
  } catch (error) {
    console.error('[GET /api/v1/pricing/rules] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/v1/pricing/reprice-batch', requirePermission('admin', 'jobs.run'), async (req, res) => {
  try {
    const results = await runRepricingJob();
    res.json({ ok: true, data: results });
  } catch (error) {
    console.error('[POST /api/v1/pricing/reprice-batch] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.delete('/v1/pricing/rules/:ruleId', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { ruleId } = req.params;
    const docRef = firestore.collection('pricingRules').doc(ruleId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Regel nicht gefunden' } });
    }
    await docRef.delete();
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/v1/pricing/rules/:ruleId] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.patch('/v1/pricing/rules/:ruleId/toggle', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { ruleId } = req.params;
    const docRef = firestore.collection('pricingRules').doc(ruleId);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Regel nicht gefunden' } });
    }
    const currentActive = doc.data().active !== false;
    await docRef.update({ active: !currentActive, updatedAt: new Date().toISOString() });
    res.json({ ok: true, data: { id: ruleId, active: !currentActive } });
  } catch (error) {
    console.error('[PATCH /api/v1/pricing/rules/:ruleId/toggle] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// --- Inventory Forecasting (v1) ---
router.get('/v1/forecast/:productId', requirePermission('products', 'read'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const velocity = await calculateSalesVelocity(req.params.productId, days);
    const stockOut = await predictStockOut(req.params.productId);
    res.json({ ok: true, data: { ...velocity, ...stockOut } });
  } catch (error) {
    console.error('[GET /api/v1/forecast] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/v1/forecast/alerts', requirePermission('products', 'read'), async (req, res) => {
  try {
    const alerts = await generateReorderAlerts();
    res.json({ ok: true, data: alerts });
  } catch (error) {
    console.error('[GET /api/v1/forecast/alerts] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// --- Webhook System (v1) ---
router.post('/v1/webhooks', requirePermission('admin', 'webhooks.write'), async (req, res) => {
  try {
    const webhook = await createWebhook({ ...req.body, createdBy: req.user?.uid });
    res.json({ ok: true, data: webhook });
  } catch (error) {
    console.error('[POST /api/v1/webhooks] Error:', error.message);
    res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: error.message } });
  }
});

router.get('/v1/webhooks', requirePermission('admin', 'webhooks.read'), async (req, res) => {
  try {
    const webhooks = await listWebhooks();
    res.json({ ok: true, data: webhooks });
  } catch (error) {
    console.error('[GET /api/v1/webhooks] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.delete('/v1/webhooks/:id', requirePermission('admin', 'webhooks.write'), async (req, res) => {
  try {
    await deleteWebhook(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/v1/webhooks] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// --- Produkt-Deduplizierung (v1) ---
router.get('/v1/products/duplicates', requirePermission('products', 'read'), async (req, res) => {
  try {
    const duplicates = await findDuplicates();
    res.json({ ok: true, data: duplicates });
  } catch (error) {
    console.error('[GET /api/v1/products/duplicates] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/v1/products/merge/suggest', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { a, b } = req.query;
    if (!a || !b) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Query params a and b required' } });
    }
    const result = await suggestMerge(String(a), String(b));
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('[GET /api/v1/products/merge/suggest] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/v1/products/merge', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { keepId, removeId } = req.body;
    if (!keepId || !removeId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'keepId and removeId required' } });
    }
    const result = await executeMerge(keepId, removeId);
    logAudit({
      action: 'product.merged',
      userId: req.user?.uid,
      userEmail: req.user?.email,
      tenantId: req.user?.tenantId || 'default',
      resourceType: 'product',
      resourceId: keepId,
      details: { keepId, removeId, merged: result.merged },
    });
    res.json({ ok: true, data: result });
  } catch (error) {
    console.error('[POST /api/v1/products/merge] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// --- Competitor Intelligence (v1) ---
router.get('/v1/competitors/:productId/history', requirePermission('products', 'read'), async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const snap = await firestore.collection('priceHistory')
      .where('productId', '==', req.params.productId)
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(500)
      .get();
    const history = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: history });
  } catch (error) {
    console.error('[GET /api/v1/competitors/history] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/v1/competitors/overview', requirePermission('products', 'read'), async (req, res) => {
  try {
    const snap = await firestore.collection('priceHistory')
      .orderBy('timestamp', 'desc')
      .limit(100)
      .get();
    const history = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, data: history });
  } catch (error) {
    console.error('[GET /api/v1/competitors/overview] Error:', error.message);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// ─── Bulk Field Update ───────────────────────────────────────

/**
 * PATCH /api/v1/products/bulk-update
 * Bulk update fields on multiple products.
 * Supports dryRun mode for preview/diff.
 */
router.patch('/v1/products/bulk-update', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { bulkUpdateProducts } = require('../services/bulk-update');
    const { productIds, updates, dryRun } = req.body;
    const tenantId = req.user?.tenantId || 'default';

    const result = await bulkUpdateProducts({
      productIds,
      updates,
      dryRun: Boolean(dryRun),
      tenantId,
    });

    if (!dryRun) {
      logAudit({
        action: 'product.bulk_update',
        userId: req.user?.uid,
        userEmail: req.user?.email,
        tenantId,
        resourceType: 'product',
        details: {
          updated: result.updated,
          skipped: result.skipped,
          errors: result.errors.length,
          fields: updates.map((u) => u.field),
          productCount: productIds.length,
        },
      });
    }

    res.json({ ok: true, data: result });
  } catch (err) {
    const status = err.statusCode || 500;
    const code = err.code || 'INTERNAL';
    console.error(`[PATCH /api/v1/products/bulk-update] ${err.message}`, err);
    res.status(status).json({ ok: false, error: { code, message: err.message } });
  }
});

// ─── CSV Export / Import ──────────────────────────────────────

/**
 * GET /api/v1/products/export/csv
 * Download products as CSV.
 * Query: ?columns=name,brand,sku (optional subset)
 */
router.get('/products/export/csv', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { exportProductsCsv } = require('../services/import-export');
    const columns = req.query.columns ? String(req.query.columns).split(',').map((s) => s.trim()) : undefined;
    const { csv, count } = await exportProductsCsv({ columns });
    const filename = `avycloud-produkte-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // BOM for Excel UTF-8 compatibility
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('[GET /api/v1/products/export/csv]', err.message, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/v1/products/import/preview
 * Preview CSV import — validates rows without saving.
 * Body: { csvText: string, mapping: ColumnMapping[], delimiter?: string }
 */
router.post('/products/import/preview', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { parseCsv, validateImportRows } = require('../services/import-export');
    const { csvText, mapping, delimiter } = req.body;
    if (!csvText) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'csvText required' } });
    if (!Array.isArray(mapping) || mapping.length === 0) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'mapping required' } });

    const { headers, rows } = parseCsv(csvText, delimiter || ';');
    const { valid, errors } = validateImportRows(rows, mapping);
    res.json({
      ok: true,
      data: {
        headers,
        totalRows: rows.length,
        validCount: valid.length,
        errorCount: errors.length,
        errors: errors.slice(0, 50),
        preview: valid.slice(0, 10).map((p) => ({
          name: p.identification?.name,
          brand: p.identification?.brand,
          sku: p.identification?.sku,
          ean: p.identification?.barcodes?.[0],
          sellPrice: p.details?.pricing?.sellPrice,
        })),
      },
    });
  } catch (err) {
    console.error('[POST /api/v1/products/import/preview]', err.message, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

/**
 * POST /api/v1/products/import/execute
 * Execute CSV import — validates and saves products.
 * Body: { csvText: string, mapping: ColumnMapping[], delimiter?: string }
 */
router.post('/products/import/execute', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { parseCsv, validateImportRows, importProducts } = require('../services/import-export');
    const { csvText, mapping, delimiter } = req.body;
    if (!csvText) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'csvText required' } });
    if (!Array.isArray(mapping) || mapping.length === 0) return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'mapping required' } });

    const { rows } = parseCsv(csvText, delimiter || ';');
    const { valid, errors: validationErrors } = validateImportRows(rows, mapping);

    if (valid.length === 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION', message: 'Keine gültigen Zeilen gefunden' },
        data: { validationErrors: validationErrors.slice(0, 50) },
      });
    }

    const tenantId = req.user?.tenantId || 'default';
    const result = await importProducts(valid, tenantId);
    logAudit({
      action: 'product.bulk_import',
      userId: req.user?.uid,
      userEmail: req.user?.email,
      tenantId,
      resourceType: 'product',
      details: { imported: result.imported, failed: result.failed, totalRows: rows.length },
    });
    res.json({
      ok: true,
      data: {
        imported: result.imported,
        failed: result.failed,
        totalRows: rows.length,
        validationErrors: validationErrors.slice(0, 20),
        importErrors: result.errors.slice(0, 20),
      },
    });
  } catch (err) {
    console.error('[POST /api/v1/products/import/execute]', err.message, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// --- Pre-Listing Validation (VAL-001) ---
const { validateProduct: validateProductForMarketplaces, SUPPORTED_MARKETPLACES: VALIDATION_MARKETPLACES } = require('../services/listing-validator');

router.post('/v1/products/validate', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { product, marketplaces } = req.body || {};
    if (!product || typeof product !== 'object') {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Product data is required' },
      });
    }

    // Validate marketplace names
    const targets = Array.isArray(marketplaces) && marketplaces.length
      ? marketplaces
      : VALIDATION_MARKETPLACES;
    for (const mp of targets) {
      if (!VALIDATION_MARKETPLACES.includes(mp)) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: `Unknown marketplace: ${mp}` },
        });
      }
    }

    const results = validateProductForMarketplaces(product, targets);
    res.json({ ok: true, results });
  } catch (err) {
    console.error(`[POST /api/v1/products/validate] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

router.post('/v1/products/validate-batch', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { productIds, marketplaces } = req.body || {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'productIds array is required' },
      });
    }
    if (productIds.length > 100) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Batch size exceeds limit of 100' },
      });
    }

    const targets = Array.isArray(marketplaces) && marketplaces.length
      ? marketplaces
      : VALIDATION_MARKETPLACES;
    for (const mp of targets) {
      if (!VALIDATION_MARKETPLACES.includes(mp)) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: `Unknown marketplace: ${mp}` },
        });
      }
    }

    const results = [];
    let ebayReady = 0;
    let kauflandReady = 0;

    for (const pid of productIds) {
      const product = await getProduct(String(pid).trim());
      if (!product) {
        results.push({ productId: pid, productName: null, error: 'Product not found' });
        continue;
      }
      const validation = validateProductForMarketplaces(product, targets);
      const entry = {
        productId: pid,
        productName: product?.identification?.name || null,
      };
      for (const mp of targets) {
        entry[mp] = {
          score: validation[mp].score,
          ready: validation[mp].ready,
          counts: validation[mp].counts,
        };
        if (mp === 'ebay' && validation[mp].ready) ebayReady++;
        if (mp === 'kaufland' && validation[mp].ready) kauflandReady++;
      }
      results.push(entry);
    }

    res.json({
      ok: true,
      results,
      summary: {
        total: productIds.length,
        ebay_ready: targets.includes('ebay') ? ebayReady : undefined,
        kaufland_ready: targets.includes('kaufland') ? kauflandReady : undefined,
      },
    });
  } catch (err) {
    console.error(`[POST /api/v1/products/validate-batch] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

module.exports = { router };
