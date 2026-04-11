const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { requirePermission } = require('../lib/rbac');
const {
  firestore,
  getProduct,
  setSkuIndexEntry,
  findProductByStrictIdentifier,
} = require('../lib/firestore');
const { parseKTypeEbayCsvToSkuMap } = require('../lib/ktype');
const { FieldValue } = require('../lib/jobs');
const { isBannedEbayBreadcrumb } = require('../lib/ebay-category-governance');
const { getCategoryAspectCatalog } = require('../lib/ebay-taxonomy');

const router = express.Router();

// --- Constants ---
const MAX_KTYPE_UPLOAD_SIZE = parseInt(process.env.KTYPE_UPLOAD_MAX_SIZE || `${10 * 1024 * 1024}`, 10); // 10 MB

// --- Multer config for KType CSV uploads ---
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

// --- Helper functions ---

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

const searchEbayCategories = (query, limit = 50, options = {}) => {
  const leafOnly = options && options.leafOnly === true;
  const needle = normalizeCategoryText(query);
  if (!needle || needle.length < 2) return [];
  const tokens = needle.split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const { entries } = getEbayCategoryEntries();
  const results = [];
  for (const entry of entries) {
    if (leafOnly && !entry.leaf) continue;
    if (entry.banned) continue;
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
    leaf: Boolean(entry.leaf),
  }));
};

function normalizeMarketplaceSku(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeMarketplaceEan(value) {
  return String(value || '').replace(/\D+/g, '').trim();
}

// =====================================================================
// eBay OAuth
// =====================================================================

router.get('/ebay/oauth/start', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { createOAuthState, buildConsentUrl } = require('../lib/ebay-oauth');
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
router.get('/ebay/oauth/callback', async (req, res) => {
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
    } = require('../lib/ebay-oauth');

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

// =====================================================================
// eBay Status
// =====================================================================

router.get('/ebay/status', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { getEbayIntegration, publicStatus } = require('../lib/ebay-oauth');
    const doc = await getEbayIntegration();
    return res.status(200).json({ ok: true, data: publicStatus(doc) });
  } catch (error) {
    console.error('Failed to load eBay status:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: 'Failed to load eBay status', details: error.message } });
  }
});

// eBay API rate limit usage stats
router.get('/ebay/rate-limit-status', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { getUsage } = require('../lib/ebay-rate-limiter');
    return res.status(200).json({ ok: true, data: getUsage() });
  } catch (error) {
    console.error('[GET /ebay/rate-limit-status]', error.message);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// Direct eBay Trading status (Auth'n'Auth token mode, no OAuth flow).
router.get('/ebay/trading/status', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { fetchTradingStatus } = require('../lib/ebay-trading-api');
    const status = await fetchTradingStatus();
    return res.status(200).json({ ok: true, data: status });
  } catch (error) {
    const code = error?.code === 'EBAY_TRADING_CONFIG_MISSING' ? 400 : 500;
    console.error('Failed to load eBay Trading status:', error);
    return res.status(code).json({
      ok: false,
      error: {
        code,
        message: error?.message || 'Failed to load eBay Trading status',
      },
    });
  }
});

router.get('/ebay/seller-profiles', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { getSellerProfiles } = require('../lib/ebay-trading-api');
    const data = await getSellerProfiles();
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    const code = error?.code === 'EBAY_TRADING_CONFIG_MISSING' ? 400 : 500;
    console.error('Failed to load eBay seller profiles:', error);
    return res.status(code).json({
      ok: false,
      error: { code, message: error?.message || 'Failed to load eBay seller profiles' },
    });
  }
});

// =====================================================================
// eBay Categories & Specifics
// =====================================================================

router.get('/ebay/category-info/:categoryId', requirePermission('products', 'read'), async (req, res) => {
  try {
    const categoryId = String(req.params.categoryId || '').trim();
    if (!categoryId) return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing categoryId' } });
    const { getCategoryInfo } = require('../lib/ebay-trading-api');
    const data = await getCategoryInfo(categoryId);
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    console.error('Failed to get eBay category info:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: error?.message || 'Failed to get category info' } });
  }
});

router.get('/ebay/category-specifics/:categoryId', requirePermission('products', 'read'), async (req, res) => {
  try {
    const categoryId = String(req.params.categoryId || '').trim();
    if (!categoryId) return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing categoryId' } });
    const { getCategorySpecifics } = require('../lib/ebay-trading-api');
    const data = await getCategorySpecifics(categoryId);
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    console.error('Failed to get eBay category specifics:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: error?.message || 'Failed to get category specifics' } });
  }
});

// =====================================================================
// Competitor Prices (eBay + Kaufland) — on-demand lookup by EAN
// =====================================================================

router.get('/competitor-prices', requirePermission('products', 'read'), async (req, res) => {
  try {
    const ean = typeof req.query?.ean === 'string' ? req.query.ean.replace(/\D+/g, '').trim() : '';
    if (!ean || ean.length < 8) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing or invalid EAN/GTIN' } });
    }
    const { getCompetitorPrices, logPriceHistory } = require('../lib/competitor-prices');
    const data = await getCompetitorPrices(ean);
    // If productId is provided, log to priceHistory for trend analysis (best-effort)
    const productId = typeof req.query?.productId === 'string' ? req.query.productId.trim() : '';
    if (productId && !data.cached) {
      logPriceHistory(productId, data).catch(() => {});
    }
    return res.status(200).json({ ok: true, data });
  } catch (error) {
    console.error('Failed to fetch competitor prices:', error);
    return res.status(500).json({ ok: false, error: { code: 500, message: error?.message || 'Failed to fetch competitor prices' } });
  }
});

// =====================================================================
// eBay Offers
// =====================================================================

router.get('/ebay/offers', requirePermission('products', 'read'), async (req, res) => {
  try {
    const sku = typeof req.query?.sku === 'string' ? req.query.sku : '';
    if (!sku) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing sku' } });
    }
    const { getOffersBySku } = require('../lib/ebay-api');
    const offers = await getOffersBySku(sku);
    return res.status(200).json({ ok: true, data: offers });
  } catch (error) {
    console.error('Failed to fetch eBay offers:', error);
    const status = error?.statusCode && Number.isFinite(Number(error.statusCode)) ? Number(error.statusCode) : 500;
    return res.status(status).json({ ok: false, error: { code: status, message: error.message || 'Failed to fetch offers' } });
  }
});

// =====================================================================
// eBay Listings
// =====================================================================

router.post('/ebay/listings/sync', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const maxPages = Number.isFinite(Number(body.maxPages)) ? Math.max(1, Math.min(200, Number(body.maxPages))) : 10;
    const entriesPerPage = Number.isFinite(Number(body.entriesPerPage))
      ? Math.max(1, Math.min(200, Number(body.entriesPerPage)))
      : 100;
    const detailConcurrency = Number.isFinite(Number(body.detailConcurrency))
      ? Math.max(1, Math.min(10, Number(body.detailConcurrency)))
      : 4;
    const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Math.max(5000, Math.min(120000, Number(body.timeoutMs))) : 25000;
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : `api-${Date.now()}`;

    const { syncLiveListingsAndAudit } = require('../lib/ebay-direct');
    const summary = await syncLiveListingsAndAudit({
      runId,
      maxPages,
      entriesPerPage,
      detailConcurrency,
      timeoutMs,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: summary });
  } catch (error) {
    console.error('Failed to sync eBay live listings:', error);
    const status = error?.code === 'EBAY_TRADING_CONFIG_MISSING' ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: {
        code: status,
        message: error?.message || 'Failed to sync eBay listings',
      },
    });
  }
});

// Fast/cheap refresh for "is listed" indicators: Trading API ActiveList only (no GetItem per listing).
// Uses server-side cooldown/lock to avoid spam and cost.
router.post('/ebay/listings/light-sync', requirePermission('products', 'read'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const maxPages = Number.isFinite(Number(body.maxPages)) ? Math.max(1, Math.min(200, Number(body.maxPages))) : 50;
    const entriesPerPage = Number.isFinite(Number(body.entriesPerPage))
      ? Math.max(1, Math.min(200, Number(body.entriesPerPage)))
      : 200;
    const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Math.max(5000, Math.min(120000, Number(body.timeoutMs))) : 25000;
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : `light-${Date.now()}`;

    const { syncLiveListingsLight } = require('../lib/ebay-direct');
    const summary = await syncLiveListingsLight({
      runId,
      maxPages,
      entriesPerPage,
      timeoutMs,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: summary });
  } catch (error) {
    console.error('Failed to light-sync eBay live listings:', error);
    const status = error?.code === 'EBAY_TRADING_CONFIG_MISSING' ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: {
        code: status,
        message: error?.message || 'Failed to light-sync eBay listings',
      },
    });
  }
});

router.get('/ebay/listings', requirePermission('products', 'read'), async (req, res) => {
  try {
    const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 100;
    const search = typeof req.query?.search === 'string' ? req.query.search : '';
    const matchStatus = typeof req.query?.matchStatus === 'string' ? req.query.matchStatus : '';
    const includeInactive =
      String(req.query?.includeInactive || '')
        .trim()
        .toLowerCase() === 'true';
    const { listLiveListings } = require('../lib/ebay-direct');
    const data = await listLiveListings({ limit, search, matchStatus, includeInactive });
    const body = { ok: true, data };
    const etag = '"' + crypto.createHash('md5').update(JSON.stringify(body)).digest('hex') + '"';
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    return res.status(200).json(body);
  } catch (error) {
    console.error('Failed to list eBay listings:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to list eBay listings' },
    });
  }
});

router.get('/ebay/listings/:itemId/detail', requirePermission('products', 'read'), async (req, res) => {
  try {
    const itemId = String(req.params.itemId || '').trim();
    if (!itemId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing itemId' } });
    }
    const { getListingDetail } = require('../lib/ebay-direct');
    const detail = await getListingDetail(itemId);
    if (!detail) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Listing not found' } });
    }
    return res.status(200).json({ ok: true, data: detail });
  } catch (error) {
    console.error('Failed to load eBay listing detail:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to load listing detail' },
    });
  }
});

router.get('/ebay/listings/:itemId/audit', requirePermission('products', 'read'), async (req, res) => {
  try {
    const itemId = String(req.params.itemId || '').trim();
    if (!itemId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing itemId' } });
    }
    const { getListingAudit } = require('../lib/ebay-listing-audit');
    const audit = await getListingAudit(itemId);
    if (!audit) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Audit not found' } });
    }
    return res.status(200).json({ ok: true, data: audit });
  } catch (error) {
    console.error('Failed to load eBay listing audit:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to load listing audit' },
    });
  }
});

router.post('/ebay/listings/:itemId/audit', requirePermission('products', 'read'), async (req, res) => {
  try {
    const itemId = String(req.params.itemId || '').trim();
    if (!itemId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing itemId' } });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const forceRefresh = body.forceRefresh === true;
    const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Math.max(5000, Math.min(120000, Number(body.timeoutMs))) : 25000;
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : `audit-${Date.now()}`;

    const { computeListingAudit } = require('../lib/ebay-listing-audit');
    const audit = await computeListingAudit(itemId, {
      forceRefresh,
      timeoutMs,
      runId,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: audit });
  } catch (error) {
    console.error('Failed to compute eBay listing audit:', error);
    const status = error?.code === 'EBAY_LISTING_NOT_FOUND' ? 404 : 500;
    return res.status(status).json({
      ok: false,
      error: { code: status, message: error?.message || 'Failed to compute listing audit' },
    });
  }
});

router.post('/ebay/listings/:itemId/apply', requirePermission('products', 'write'), async (req, res) => {
  try {
    const itemId = String(req.params.itemId || '').trim();
    if (!itemId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing itemId' } });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const suggestionIds = Array.isArray(body.suggestionIds)
      ? body.suggestionIds.map((x) => String(x || '').trim()).filter(Boolean)
      : null;
    const patch = body.patch && typeof body.patch === 'object' ? body.patch : null;
    const timeoutMs = Number.isFinite(Number(body.timeoutMs)) ? Math.max(5000, Math.min(120000, Number(body.timeoutMs))) : 25000;
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : `apply-${Date.now()}`;

    const { applyListingAuditSuggestions } = require('../lib/ebay-listing-audit');
    const result = await applyListingAuditSuggestions(itemId, {
      suggestionIds,
      patch,
      timeoutMs,
      runId,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error('Failed to apply eBay listing suggestions:', error);
    const code = error?.code || '';
    const status =
      code === 'EBAY_APPLY_ITEM_ID_REQUIRED' || code === 'EBAY_APPLY_NO_PATCH' || code === 'EBAY_AUDIT_NOT_FOUND'
        ? 400
        : code === 'EBAY_APPLY_INVENTORY_MODEL'
          ? 409
          : 500;
    return res.status(status).json({
      ok: false,
      error: { code: status, message: error?.message || 'Failed to apply listing suggestions' },
    });
  }
});

// MIP CSV import — must come BEFORE the :sku catch-all
router.post('/ebay/listings/import/mip', requirePermission('products', 'write'), ktypeUploadMiddleware, async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing CSV file' } });
    }
    const { importMipCsvBuffer } = require('../lib/ebay-listings');
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

// :sku catch-all — MUST come AFTER all /ebay/listings/:itemId/* and /ebay/listings/import/* routes
router.get('/ebay/listings/:sku', requirePermission('products', 'read'), async (req, res) => {
  try {
    const sku = String(req.params.sku || '').trim();
    if (!sku) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing sku' } });
    }
    const { getEbayListingBySku } = require('../lib/ebay-listings');
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

// =====================================================================
// eBay Listing Links
// =====================================================================

router.post('/ebay/listing-links/rebuild', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean) : null;
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : `links-${Date.now()}`;
    const { buildProductListingLinks } = require('../lib/ebay-direct');
    const summary = await buildProductListingLinks({
      itemIds,
      runId,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: summary });
  } catch (error) {
    console.error('Failed to rebuild eBay listing links:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to rebuild listing links' },
    });
  }
});

router.get('/ebay/listing-links', requirePermission('products', 'read'), async (req, res) => {
  try {
    const limit = Number.isFinite(Number(req.query?.limit)) ? Math.max(1, Math.min(500, Number(req.query.limit))) : 200;
    const snapshot = await firestore.collection('ebayListingLinks').limit(limit).get();
    const rows = snapshot.docs.map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }));
    return res.status(200).json({ ok: true, data: rows });
  } catch (error) {
    console.error('Failed to list eBay listing links:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to list eBay listing links' },
    });
  }
});

// =====================================================================
// eBay SKU Index
// =====================================================================

// Lightweight SKU-index: returns all active eBay listings as [{sku, productId, itemId, viewItemUrl}]
// Joins ebayListingsLive (sku, viewItemUrl) with ebayListingLinks (productId) for full coverage.
// Used by the AdminTable eBay badge to match products by SKU or productId.
router.get('/ebay/sku-index', requirePermission('products', 'read'), async (req, res) => {
  try {
    const [liveSnap, linksSnap] = await Promise.all([
      firestore.collection('ebayListingsLive').where('active', '==', true).get(),
      firestore.collection('ebayListingLinks').where('status', '==', 'matched').get(),
    ]);
    // Build itemId → {skus[], viewItemUrl} from live listings
    const liveByItemId = new Map();
    liveSnap.docs.forEach((doc) => {
      const d = doc.data() || {};
      const rawList = Array.isArray(d.skuIndex) ? d.skuIndex : d.sku ? [d.sku] : [];
      const skus = (Array.isArray(rawList) ? rawList : [rawList])
        .map((v) => String(v || '').trim())
        .filter(Boolean);
      liveByItemId.set(doc.id, { skus, viewItemUrl: d.viewItemUrl || null });
    });
    // Build itemId → productId from matched links
    const productIdByItemId = new Map();
    linksSnap.docs.forEach((doc) => {
      const d = doc.data() || {};
      // Only trust links for itemIds confirmed active via Trading API ingest (ebayListingsLive.active=true).
      // This prevents stale link docs from marking inactive/ended listings as "listed".
      if (!liveByItemId.has(doc.id)) return;
      if (d.productId) productIdByItemId.set(doc.id, d.productId);
    });
    // Merge: all itemIds from both sources
    const allItemIds = new Set([...liveByItemId.keys(), ...productIdByItemId.keys()]);
    const rows = [];
    const seen = new Set();
    Array.from(allItemIds).forEach((itemId) => {
      const live = liveByItemId.get(itemId) || {};
      const productId = productIdByItemId.get(itemId) || null;
      const viewItemUrl = live.viewItemUrl || null;
      const skus = Array.isArray(live.skus) ? live.skus : [];
      if (skus.length) {
        skus.forEach((sku) => {
          const key = `${itemId}::${sku}`;
          if (seen.has(key)) return;
          seen.add(key);
          rows.push({ itemId, sku, productId, viewItemUrl });
        });
      } else {
        const key = `${itemId}::`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ itemId, sku: null, productId, viewItemUrl });
      }
    });
    const filtered = rows.filter((r) => r.sku || r.productId);
    return res.status(200).json({ ok: true, data: filtered });
  } catch (error) {
    console.error('Failed to build eBay SKU index:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to build eBay SKU index' },
    });
  }
});

// =====================================================================
// Kaufland
// =====================================================================

// Pull latest Kaufland units and cache them in Firestore for fast Inventory UI indicators.
router.post('/kaufland/listings/sync', requirePermission('products', 'write'), async (req, res) => {
  try {
    const storefront = String(req.body?.storefront || req.query?.storefront || 'de').trim().toLowerCase();
    const { listUnits } = require('../lib/kaufland-api');
    const { Timestamp } = require('@google-cloud/firestore');

    const units = await listUnits({ storefront, limit: 100, maxPages: 300 });
    const now = Timestamp.now();
    const collection = firestore.collection('kauflandUnitsLive');
    const seenIds = new Set();

    let batch = firestore.batch();
    let batchCount = 0;
    const commitBatch = async () => {
      if (!batchCount) return;
      await batch.commit();
      batch = firestore.batch();
      batchCount = 0;
    };

    for (const unit of units) {
      const idUnit = Number(unit?.id_unit || 0);
      if (!Number.isFinite(idUnit) || idUnit <= 0) continue;
      const docId = String(idUnit);
      seenIds.add(docId);

      const product = unit?.product && typeof unit.product === 'object' ? unit.product : {};
      const productEans = Array.isArray(product?.eans) ? product.eans : [];
      const normalizedEans = Array.from(
        new Set(
          productEans
            .map((v) => normalizeMarketplaceEan(v))
            .filter(Boolean)
        )
      );

      const idProduct = Number(unit?.id_product || product?.id_product || 0);
      const normalizedIdProduct = Number.isFinite(idProduct) && idProduct > 0 ? idProduct : null;
      const productUrl = String(product?.url || '').trim();
      const viewItemUrl = productUrl || (normalizedIdProduct ? `https://www.kaufland.de/product/${normalizedIdProduct}/` : null);

      // Extract title and price from Kaufland API response
      const klTitle = typeof product?.title === 'string' && product.title.trim() ? product.title.trim() : null;
      const rawPrice = unit?.listing_price ?? unit?.price ?? null;
      const klListingPrice = Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : null;

      const payload = {
        id_unit: idUnit,
        id_offer: String(unit?.id_offer || '').trim() || null,
        id_offer_normalized: normalizeMarketplaceSku(unit?.id_offer),
        ean: normalizeMarketplaceEan(unit?.ean),
        eans: normalizedEans,
        id_product: normalizedIdProduct,
        view_item_url: viewItemUrl,
        amount: Number.isFinite(Number(unit?.amount)) ? Number(unit.amount) : null,
        status: String(unit?.status || '').trim() || null,
        storefront: String(unit?.storefront || storefront || 'de').trim().toLowerCase(),
        active: String(unit?.status || '').trim().toUpperCase() === 'AVAILABLE',
        title: klTitle,
        listing_price: klListingPrice,
        updatedAt: now,
        source: 'kaufland-sync',
      };

      batch.set(collection.doc(docId), payload, { merge: true });
      batchCount += 1;
      if (batchCount >= 400) await commitBatch();
    }
    await commitBatch();

    // Mark stale cached rows inactive (units no longer returned by API).
    const existingSnap = await collection.where('storefront', '==', storefront).where('active', '==', true).get();
    if (!existingSnap.empty) {
      batch = firestore.batch();
      batchCount = 0;
      existingSnap.docs.forEach((doc) => {
        if (seenIds.has(doc.id)) return;
        batch.set(
          collection.doc(doc.id),
          { active: false, updatedAt: now, source: 'kaufland-sync' },
          { merge: true }
        );
        batchCount += 1;
      });
      await commitBatch();
    }

    // ── Backfill ops.kaufland.unitId into products_v2 ────────────────────────
    // For every active unit, find the matching product_v2 doc (by SKU/EAN) and
    // write ops.kaufland.unitId so the stock-sync-dispatcher can push to
    // Kaufland without a separate lookup. Fire-and-forget, non-critical.
    try {
      const { getAllProductsV2 } = require('../lib/product-store');
      const allProds = await getAllProductsV2();
      const skuToProduct = new Map();
      const eanToProduct = new Map();
      for (const p of allProds) {
        const sku = (p?.identification?.sku || p?.details?.identifiers?.sku || '').trim();
        if (sku) skuToProduct.set(sku.toLowerCase(), p);
        const ean = (p?.identification?.ean || p?.details?.identifiers?.ean || '').trim();
        if (ean) eanToProduct.set(ean, p);
      }

      let opsBatch = firestore.batch();
      let opsBatchCount = 0;
      for (const unit of units) {
        const idUnit = Number(unit?.id_unit || 0);
        if (!Number.isFinite(idUnit) || idUnit <= 0) continue;
        const unitSku = String(unit?.id_offer || '').trim();
        const unitEan = String(unit?.ean || '').trim();
        const prod = (unitSku && skuToProduct.get(unitSku.toLowerCase()))
          || (unitEan && eanToProduct.get(unitEan)) || null;
        if (!prod) continue;
        const existing = prod?.ops?.kaufland?.unitId;
        if (String(existing || '') === String(idUnit)) continue; // already correct
        opsBatch.update(firestore.collection('products_v2').doc(prod.id), {
          'ops.kaufland.unitId': String(idUnit),
        });
        opsBatchCount++;
        if (opsBatchCount >= 400) {
          await opsBatch.commit();
          opsBatch = firestore.batch();
          opsBatchCount = 0;
        }
      }
      if (opsBatchCount > 0) await opsBatch.commit();
      if (opsBatchCount > 0) console.log(`[kaufland-sync] Backfilled ops.kaufland.unitId for ${opsBatchCount} products`);
    } catch (opsErr) {
      console.error('[kaufland-sync] ops backfill error (non-fatal):', opsErr.message);
    }

    // ── Inventory reconciliation ──────────────────────────────────────────────
    // When Kaufland reports amount > 0 for a unit that is matched to a
    // products_v2 doc with inventory.quantity = 0, sync the warehouse quantity
    // from Kaufland. This prevents active listings appearing with 0 stock.
    const { getAllProductsV2 } = require('../lib/product-store');
    let reconciledCount = 0;
    try {
      const products = await getAllProductsV2();
      const skuMap = new Map();
      const eanMap = new Map();
      for (const p of products) {
        const sku = (p?.identification?.sku || '').trim().toLowerCase();
        if (sku) skuMap.set(sku, p);
        const ean = (p?.identification?.ean || '').trim();
        if (ean) eanMap.set(ean, p);
      }

      let reconBatch = firestore.batch();
      let reconCount = 0;
      const commitRecon = async () => {
        if (!reconCount) return;
        await reconBatch.commit();
        reconBatch = firestore.batch();
        reconCount = 0;
      };

      for (const unit of units) {
        const klAmount = Number(unit?.amount || 0);
        if (klAmount <= 0) continue; // Kaufland reports 0 — nothing to reconcile

        const idOffer = String(unit?.id_offer || '').trim().toLowerCase();
        const ean = String(unit?.ean || '').trim();
        const matched = (idOffer && skuMap.get(idOffer)) || (ean && eanMap.get(ean)) || null;
        if (!matched) continue;

        const whQty = typeof matched.inventory?.quantity === 'number' ? matched.inventory.quantity : null;
        if (whQty !== 0) continue; // Only reconcile when warehouse shows exactly 0

        // Kaufland says >0, warehouse says 0 → update warehouse to Kaufland amount
        const docRef = firestore.collection('products_v2').doc(matched.id);
        reconBatch.update(docRef, {
          'inventory.quantity': klAmount,
          updatedAt: new Date().toISOString(),
        });
        reconCount++;
        reconciledCount++;
        console.log(`[kaufland-sync] Reconciled inventory: ${matched.identification?.sku} warehouse 0 → ${klAmount} (from Kaufland)`);
        if (reconCount >= 400) await commitRecon();
      }
      await commitRecon();
    } catch (reconErr) {
      console.error('[kaufland-sync] Reconciliation error (non-fatal):', reconErr.message);
    }

    return res.status(200).json({
      ok: true,
      data: {
        storefront,
        fetched: units.length,
        active: seenIds.size,
        reconciled: reconciledCount,
      },
    });
  } catch (error) {
    console.error('Failed to sync Kaufland listings:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to sync Kaufland listings' },
    });
  }
});

// Cached index used by Inventory table for Kaufland listed/not-listed badges.
router.get('/kaufland/sku-index', requirePermission('products', 'read'), async (req, res) => {
  try {
    const storefront = String(req.query?.storefront || 'de').trim().toLowerCase();
    const snap = await firestore
      .collection('kauflandUnitsLive')
      .where('storefront', '==', storefront)
      .where('active', '==', true)
      .get();
    const rows = [];
    snap.docs.forEach((doc) => {
      const d = doc.data() || {};
      rows.push({
        idUnit: doc.id,
        sku: d.id_offer || null,
        skuNormalized: d.id_offer_normalized || null,
        ean: d.ean || null,
        eans: Array.isArray(d.eans) ? d.eans : [],
        status: d.status || null,
        idProduct: Number.isFinite(Number(d.id_product)) ? Number(d.id_product) : null,
        viewItemUrl: d.view_item_url || null,
      });
    });
    return res.status(200).json({ ok: true, data: rows });
  } catch (error) {
    console.error('Failed to build Kaufland SKU index:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to build Kaufland SKU index' },
    });
  }
});

// Enriched Kaufland listings — joins kauflandUnitsLive with products_v2
router.get('/kaufland/listings', requirePermission('products', 'read'), async (req, res) => {
  try {
    const storefront = String(req.query?.storefront || 'de').trim().toLowerCase();
    const { getAllProductsV2 } = require('../lib/product-store');

    // Fetch both collections in parallel
    // Try with storefront filter first, fall back to all units if empty
    let unitsSnap = await firestore
      .collection('kauflandUnitsLive')
      .where('storefront', '==', storefront)
      .get();
    if (unitsSnap.empty) {
      // Storefront field might be missing or use different case — fetch all
      unitsSnap = await firestore.collection('kauflandUnitsLive').get();
    }
    const products = await getAllProductsV2();

    // BUG-070: storageBins are in `products` (legacy), not products_v2.
    // Build a lookup from legacy docs to merge BIN data.
    const legacySnap = await firestore.collection('products').select('storageBins', 'storage').get();
    const legacyBinMap = new Map();
    legacySnap.docs.forEach((doc) => {
      const ld = doc.data() || {};
      if (ld.storageBins || ld.storage) legacyBinMap.set(doc.id, ld);
    });
    // Merge BIN data into products_v2
    for (const p of products) {
      if (!p.storageBins && p.id && legacyBinMap.has(p.id)) {
        const legacy = legacyBinMap.get(p.id);
        p.storageBins = legacy.storageBins || [];
        p.storage = legacy.storage || null;
      }
    }

    // Build multi-key lookup map from products
    const skuMap = new Map();  // lowercase sku → product
    const eanMap = new Map();  // ean → product
    for (const p of products) {
      const sku = (p?.identification?.sku || p?.details?.identifiers?.sku || '').trim();
      if (sku) {
        skuMap.set(sku.toLowerCase(), p);
        // Also index without common prefixes (SKU-, sku-)
        const stripped = sku.replace(/^sku[-_]?/i, '').trim();
        if (stripped && stripped !== sku.toLowerCase()) {
          skuMap.set(stripped.toLowerCase(), p);
        }
      }
      // Index by EAN/barcode
      const barcodes = p?.identification?.barcodes || p?.details?.identifiers?.barcodes || [];
      const eanList = Array.isArray(barcodes) ? barcodes : [barcodes];
      for (const ean of eanList) {
        const e = String(ean || '').trim();
        if (e) eanMap.set(e, p);
      }
      // Also index by identification.ean and details.identifiers.ean
      const singleEan = p?.identification?.ean || p?.details?.identifiers?.ean || '';
      if (singleEan) eanMap.set(String(singleEan).trim(), p);
    }

    let matchCount = 0;
    const rows = [];
    unitsSnap.docs.forEach((doc) => {
      const d = doc.data() || {};
      const unitSku = (d.id_offer || '').trim();
      const unitEan = (d.ean || '').trim();

      // Try matching: exact SKU → stripped SKU → EAN
      let matched = null;
      if (unitSku) {
        matched = skuMap.get(unitSku.toLowerCase()) || null;
        if (!matched) {
          const stripped = unitSku.replace(/^sku[-_]?/i, '').trim();
          if (stripped) matched = skuMap.get(stripped.toLowerCase()) || null;
        }
      }
      if (!matched && unitEan) {
        matched = eanMap.get(unitEan) || null;
      }
      if (matched) matchCount++;

      // Use Kaufland product title as fallback if no AvyCloud product match
      const klTitle = typeof d.title === 'string' ? d.title : null;
      const klPrice = Number.isFinite(Number(d.listing_price)) ? Number(d.listing_price) / 100
        : Number.isFinite(Number(d.price)) ? Number(d.price) / 100
        : null;

      // updatedAt for "Letztes Update" column
      const updatedAtRaw = d.updatedAt;
      const updatedAtIso = updatedAtRaw?.toDate?.()?.toISOString?.() || (typeof updatedAtRaw === 'string' ? updatedAtRaw : null);

      // Warehouse stock enrichment — prefer storageBins sum, fallback to inventory.quantity
      const storageBins = Array.isArray(matched?.storageBins) ? matched.storageBins : [];
      const binsTotal = storageBins.length > 0 ? storageBins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0) : null;
      const fallbackQty = typeof matched?.inventory?.availableQuantity === 'number' ? matched.inventory.availableQuantity
        : (typeof matched?.inventory?.quantity === 'number' ? matched.inventory.quantity : null);
      const whStock = binsTotal !== null ? binsTotal : fallbackQty;
      const binLoc = (storageBins.length > 0 ? (storageBins[0]?.code || storageBins[0]?.binCode || null) : null)
        || matched?.storage?.binCode
        || matched?.binCode
        || null;
      const mpQty = Number.isFinite(Number(d.amount)) ? Number(d.amount) : null;
      const mismatch = typeof whStock === 'number' && mpQty !== null && whStock !== mpQty;

      // Price: prefer matched product price, then Kaufland unit price fields
      const matchedPrice = matched?.details?.pricing?.sellPrice ?? null;
      const unitPrice = matchedPrice !== null ? matchedPrice : klPrice;

      // Category: try multiple sources from matched product
      const categoryName = matched?.identification?.category || matched?.details?.category || matched?.details?.categoryId || null;

      rows.push({
        idUnit: doc.id,
        sku: unitSku || null,
        ean: unitEan || null,
        status: d.status || null,
        active: d.active === true,
        quantity: mpQty,
        idProduct: Number.isFinite(Number(d.id_product)) ? Number(d.id_product) : null,
        viewItemUrl: d.view_item_url || null,
        updatedAt: updatedAtIso,
        // Enriched product data (AvyCloud match → Kaufland data fallback)
        productId: matched?.id || null,
        title: matched?.identification?.name || klTitle || null,
        brand: matched?.identification?.brand || null,
        price: unitPrice,
        imageUrl: matched?.details?.images?.[0]?.url_or_base64 || matched?.details?.images?.[0]?.url || null,
        category: categoryName,
        warehouseStock: typeof whStock === 'number' ? whStock : null,
        binLocation: binLoc,
        stockMismatch: mismatch,
      });
    });

    // Diagnostic: log unmatched units with their price fields
    const unmatched = rows.filter(r => !r.productId);
    if (unmatched.length > 0 && unmatched.length <= 20) {
      for (const u of unmatched) {
        console.info(`[Kaufland] unmatched: sku=${u.sku || 'NONE'}, ean=${u.ean || 'NONE'}, price=${u.price ?? 'NULL'}`);
      }
    }
    console.info(`[GET /api/kaufland/listings] ${matchCount}/${rows.length} units matched (${products.length} products, ${skuMap.size} SKU keys, ${eanMap.size} EAN keys)`);
    return res.status(200).json({ ok: true, data: rows });
  } catch (error) {
    console.error('[GET /api/kaufland/listings]', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to load Kaufland listings' },
    });
  }
});

// =====================================================================
// Kaufland Publish
// =====================================================================

router.post('/kaufland/publish', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { productId, storefront = 'de' } = req.body || {};
    if (!productId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_PRODUCT_ID', message: 'productId is required' } });
    }
    const { getProductV2 } = require('../lib/product-store');
    const product = await getProductV2(productId);
    if (!product) {
      return res.status(404).json({ ok: false, error: { code: 'PRODUCT_NOT_FOUND', message: `Product ${productId} not found` } });
    }
    const { createUnit } = require('../lib/kaufland-api');
    const result = await createUnit(product, { storefront });
    return res.status(201).json({ ok: true, data: result });
  } catch (error) {
    console.error(`[POST /api/marketplace/kaufland/publish] ${error.message}`, error);
    if (error.code === 'KAUFLAND_PRODUCT_DATA_PENDING') {
      return res.status(202).json({
        ok: true,
        data: { productDataSubmitted: true, message: error.message },
      });
    }
    const status = error.code === 'KAUFLAND_EAN_INVALID' || error.code === 'KAUFLAND_EAN_MISSING' ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: { code: error.code || 'INTERNAL', message: error.message },
    });
  }
});

router.post('/kaufland/publish/bulk', requirePermission('products', 'write'), async (req, res) => {
  // Load Kaufland defaults from Firestore, fall back to legacy hardcoded values
  const { mergeKauflandOverrides } = require('../lib/integration-defaults');
  const klDefaults = await mergeKauflandOverrides({}, { tenantId: req.user?.tenantId || 'default' });
  let KL_DEFAULT_SHIPPING_GROUP = klDefaults.shippingGroupId || 144080;
  let KL_DEFAULT_WAREHOUSE = klDefaults.warehouseId || 70462;

  function autoFixProduct(product) {
    const fixes = [];
    const p = JSON.parse(JSON.stringify(product));
    const pricing = p.details?.pricing || {};
    const identifiers = p.details?.identifiers || p.identification || {};

    // --- EAN check ---
    const ean =
      String(identifiers?.ean || '').replace(/\D+/g, '') ||
      (Array.isArray(p.identification?.barcodes)
        ? p.identification.barcodes.map((v) => String(v || '').replace(/\D+/g, '')).find((v) => v.length === 13 || v.length === 14) || ''
        : '');
    if (!ean) {
      return { product: p, fixes, skip: true, reason: 'Keine EAN vorhanden' };
    }

    // --- Price fix ---
    const sellPrice = parseFloat(pricing.sellPrice) || 0;
    if (sellPrice <= 0) {
      const buyPrice = parseFloat(pricing.buyPrice) || 0;
      const lowestPrice = parseFloat(pricing.lowest_price?.amount ?? pricing.lowest_price ?? 0) || 0;
      if (buyPrice > 0) {
        const derived = Math.round(buyPrice * 1.40 * 100) / 100;
        if (!p.details) p.details = {};
        if (!p.details.pricing) p.details.pricing = {};
        p.details.pricing.sellPrice = derived;
        fixes.push(`Preis aus EK abgeleitet (${buyPrice.toFixed(2)} x 1.40 = ${derived.toFixed(2)})`);
      } else if (lowestPrice > 0) {
        if (!p.details) p.details = {};
        if (!p.details.pricing) p.details.pricing = {};
        p.details.pricing.sellPrice = lowestPrice;
        fixes.push(`Preis aus Niedrigstpreis uebernommen (${lowestPrice.toFixed(2)})`);
      } else {
        return { product: p, fixes, skip: true, reason: 'Kein Preis ableitbar (weder VK, EK noch Niedrigstpreis)' };
      }
    }

    // --- Shipping group default ---
    const kl = p.details?.kaufland || p.details?.marketplaces?.kaufland || {};
    const hasShippingGroup = kl.id_shipping_group != null && Number(kl.id_shipping_group) > 0;
    if (!hasShippingGroup) {
      if (!p.details) p.details = {};
      if (!p.details.kaufland) p.details.kaufland = {};
      p.details.kaufland.id_shipping_group = KL_DEFAULT_SHIPPING_GROUP;
      fixes.push('Versandgruppe: Standard (SendCloud DPD DE)');
    }

    // --- Warehouse default ---
    const hasWarehouse = kl.id_warehouse != null && Number(kl.id_warehouse) > 0;
    if (!hasWarehouse) {
      if (!p.details) p.details = {};
      if (!p.details.kaufland) p.details.kaufland = {};
      p.details.kaufland.id_warehouse = KL_DEFAULT_WAREHOUSE;
      fixes.push('Lager: Standard (Temp Warehouse)');
    }

    return { product: p, fixes, skip: false };
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const productIds = Array.isArray(body.productIds)
      ? body.productIds.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (!productIds.length) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_PRODUCT_IDS', message: 'productIds array is required' } });
    }
    const storefront = body.storefront || 'de';
    // Per-request overrides from publish dialog take priority over Firestore defaults
    const requestOverrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const reqShippingGroup = Number(requestOverrides.shippingGroupId) || 0;
    const reqWarehouse = Number(requestOverrides.warehouseId) || 0;
    if (reqShippingGroup > 0) KL_DEFAULT_SHIPPING_GROUP = reqShippingGroup;
    if (reqWarehouse > 0) KL_DEFAULT_WAREHOUSE = reqWarehouse;
    const { getProductV2 } = require('../lib/product-store');
    const { createUnit } = require('../lib/kaufland-api');
    const results = [];
    for (const id of productIds) {
      try {
        const product = await getProductV2(id);
        if (!product) {
          results.push({ productId: id, ok: false, status: 'skipped', reason: `Produkt ${id} nicht gefunden` });
          continue;
        }

        const { product: fixedProduct, fixes, skip, reason } = autoFixProduct(product);
        if (skip) {
          results.push({ productId: id, ok: false, status: 'skipped', reason });
          continue;
        }

        try {
          const result = await createUnit(fixedProduct, { storefront });
          const status = result.productDataSubmitted
            ? 'fixed'
            : (fixes.length ? 'fixed' : 'published');
          if (result.productDataSubmitted) fixes.push('Produktdaten bei Kaufland eingereicht');
          results.push({
            productId: id,
            ok: true,
            status,
            fixes: fixes.length ? fixes : undefined,
            data: result,
          });
        } catch (publishErr) {
          if (publishErr.code === 'KAUFLAND_PRODUCT_DATA_PENDING') {
            fixes.push('Produktdaten bei Kaufland eingereicht (asynchrone Verarbeitung)');
            results.push({
              productId: id,
              ok: false,
              status: 'pending',
              reason: publishErr.message,
              fixes,
            });
          } else {
            results.push({ productId: id, ok: false, status: 'failed', error: publishErr.message || 'Publish fehlgeschlagen' });
          }
        }
      } catch (err) {
        results.push({ productId: id, ok: false, status: 'failed', error: err.message || 'Unbekannter Fehler' });
      }
    }
    const published = results.filter((r) => r.ok && r.status === 'published').length;
    const fixed = results.filter((r) => r.ok && r.status === 'fixed').length;
    const pending = results.filter((r) => r.status === 'pending').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    return res.status(200).json({
      ok: true,
      data: {
        summary: { total: productIds.length, success: published + fixed, published, fixed, pending, skipped, failed },
        results,
      },
    });
  } catch (error) {
    console.error(`[POST /api/kaufland/publish/bulk] ${error.message}`, error);
    return res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL', message: error.message },
    });
  }
});

// ── Kaufland: Bulk update units (price + stock) ─────────────────────
router.post('/kaufland/units/bulk-update', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { unitIds } = req.body || {};
    if (!Array.isArray(unitIds) || !unitIds.length) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_UNIT_IDS', message: 'unitIds array is required' } });
    }
    const { updateUnit } = require('../lib/kaufland-api');
    const { getProductV2 } = require('../lib/product-store');

    // Look up products by unitId from kauflandUnitsLive
    const results = [];
    for (const unitId of unitIds.slice(0, 100)) {
      try {
        const unitSnap = await firestore.collection('kauflandUnitsLive').doc(String(unitId)).get();
        if (!unitSnap.exists) {
          results.push({ unitId, ok: false, error: 'Unit nicht gefunden' });
          continue;
        }
        const unitData = unitSnap.data();
        const sku = unitData.id_offer || unitData.id_offer_normalized;
        if (!sku) {
          results.push({ unitId, ok: false, error: 'Keine SKU fuer Unit' });
          continue;
        }
        // Find product by SKU
        const prodSnap = await firestore.collection('products_v2')
          .where('identification.sku', '==', sku)
          .limit(1)
          .get();
        if (prodSnap.empty) {
          results.push({ unitId, ok: false, error: `Kein Produkt fuer SKU ${sku}` });
          continue;
        }
        const product = { id: prodSnap.docs[0].id, ...prodSnap.docs[0].data() };
        const result = await updateUnit(unitId, product, { storefront: 'de' });
        results.push({ unitId, ok: true, updated: result?.updated || false });
      } catch (err) {
        results.push({ unitId, ok: false, error: err.message });
      }
    }
    const success = results.filter(r => r.ok).length;
    res.json({ ok: true, data: { total: unitIds.length, success, failed: unitIds.length - success, results } });
  } catch (error) {
    console.error(`[POST /api/kaufland/units/bulk-update] ${error.message}`, error);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// ── Kaufland: Bulk set unit status (AVAILABLE / ONHOLD) ─────────────
router.post('/kaufland/units/bulk-status', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { unitIds, status } = req.body || {};
    if (!Array.isArray(unitIds) || !unitIds.length) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_UNIT_IDS', message: 'unitIds array is required' } });
    }
    if (!['AVAILABLE', 'ONHOLD'].includes(status)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_STATUS', message: 'status must be AVAILABLE or ONHOLD' } });
    }
    const { setUnitStatus } = require('../lib/kaufland-api');
    const results = [];
    for (const unitId of unitIds.slice(0, 100)) {
      try {
        await setUnitStatus(unitId, status, { storefront: 'de' });
        results.push({ unitId, ok: true });
        // Update local status in kauflandUnitsLive
        await firestore.collection('kauflandUnitsLive').doc(String(unitId)).set(
          { status, active: status === 'AVAILABLE', updatedAt: new Date().toISOString() },
          { merge: true }
        ).catch(() => {});
      } catch (err) {
        results.push({ unitId, ok: false, error: err.message });
      }
    }
    const success = results.filter(r => r.ok).length;
    res.json({ ok: true, data: { total: unitIds.length, success, failed: unitIds.length - success, results } });
  } catch (error) {
    console.error(`[POST /api/kaufland/units/bulk-status] ${error.message}`, error);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// =====================================================================
// eBay Gaps
// =====================================================================

router.post('/ebay/gaps/rebuild', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean) : null;
    const runId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : `gaps-${Date.now()}`;
    const { auditListingGaps } = require('../lib/ebay-direct');
    const summary = await auditListingGaps({
      itemIds,
      runId,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: summary });
  } catch (error) {
    console.error('Failed to rebuild eBay gaps:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to rebuild gaps' },
    });
  }
});

router.get('/ebay/gaps', requirePermission('products', 'read'), async (req, res) => {
  try {
    const limit = Number.isFinite(Number(req.query?.limit)) ? Math.max(1, Math.min(500, Number(req.query.limit))) : 200;
    const statusFilter = typeof req.query?.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const severityFilter = typeof req.query?.severity === 'string' ? req.query.severity.trim().toLowerCase() : '';
    const itemIdFilter = typeof req.query?.itemId === 'string' ? req.query.itemId.trim() : '';
    const snapshot = await firestore.collection('ebayListingGaps').limit(limit).get();
    const rows = snapshot.docs
      .map((doc) => ({ ...(doc.data() || {}), itemId: doc.id }))
      .filter((row) => {
        if (itemIdFilter && row.itemId !== itemIdFilter) return false;
        const gaps = Array.isArray(row.gaps) ? row.gaps : [];
        if (statusFilter) {
          const hasStatus = gaps.some((gap) => String(gap?.status || '').toLowerCase() === statusFilter);
          if (!hasStatus) return false;
        }
        if (severityFilter) {
          const hasSeverity = gaps.some((gap) => String(gap?.severity || '').toLowerCase() === severityFilter);
          if (!hasSeverity) return false;
        }
        return true;
      });
    return res.status(200).json({ ok: true, data: rows });
  } catch (error) {
    console.error('Failed to list eBay gaps:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to list eBay gaps' },
    });
  }
});

router.post('/ebay/gaps/:id/actions', requirePermission('products', 'write'), async (req, res) => {
  try {
    const itemId = String(req.params.id || '').trim();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const gapId = typeof body.gapId === 'string' ? body.gapId.trim() : '';
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const note = typeof body.note === 'string' ? body.note : null;
    const alias = body.alias && typeof body.alias === 'object' ? body.alias : null;
    if (!itemId || !gapId || !action) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'itemId, gapId and action are required' },
      });
    }
    const { applyGapAction } = require('../lib/ebay-direct');
    const out = await applyGapAction(itemId, {
      gapId,
      action,
      note,
      alias,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to update eBay gap lifecycle:', error);
    const status = error?.code && String(error.code).startsWith('EBAY_GAP_') ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: { code: status, message: error?.message || 'Failed to update gap lifecycle' },
    });
  }
});

router.post('/ebay/gaps/:id/bulk-actions', requirePermission('products', 'write'), async (req, res) => {
  try {
    const itemId = String(req.params.id || '').trim();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const gapIds = Array.isArray(body.gapIds) ? body.gapIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const note = typeof body.note === 'string' ? body.note : null;
    const alias = body.alias && typeof body.alias === 'object' ? body.alias : null;
    if (!itemId || !gapIds.length || !action) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'itemId, gapIds and action are required' },
      });
    }
    const { bulkApplyGapActions } = require('../lib/ebay-direct');
    const out = await bulkApplyGapActions(itemId, {
      gapIds,
      action,
      note,
      alias,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to apply bulk eBay gap lifecycle action:', error);
    const status = error?.code && String(error.code).startsWith('EBAY_GAP_') ? 400 : 500;
    return res.status(status).json({
      ok: false,
      error: { code: status, message: error?.message || 'Failed to apply bulk gap lifecycle action' },
    });
  }
});

router.post('/ebay/gaps/bulk-prepare-missing', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean) : null;
    const mode = typeof body.mode === 'string' && body.mode.trim() ? body.mode.trim() : 'missing_ebay';
    const { bulkPrepareMissingSpecificGaps } = require('../lib/ebay-direct');
    const out = await bulkPrepareMissingSpecificGaps({
      itemIds,
      mode,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to bulk-prepare missing eBay specifics:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to bulk-prepare missing specifics' },
    });
  }
});

router.post('/ebay/gaps/bulk-prepare-item-specifics', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean) : null;
    const mode = typeof body.mode === 'string' && body.mode.trim() ? body.mode.trim() : 'all';
    const { bulkPrepareMissingSpecificGaps } = require('../lib/ebay-direct');
    const out = await bulkPrepareMissingSpecificGaps({
      itemIds,
      mode,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to bulk-prepare eBay item specifics:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to bulk-prepare item specifics' },
    });
  }
});

// =====================================================================
// eBay Sync
// =====================================================================

router.post('/ebay/sync/dry-run', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean) : null;
    const { dryRunSync } = require('../lib/ebay-direct');
    const out = await dryRunSync({
      itemIds,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to run eBay sync dry-run:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to run dry-run' },
    });
  }
});

router.post('/ebay/sync/apply', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean) : null;
    const { applySync } = require('../lib/ebay-direct');
    const out = await applySync({
      itemIds,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to apply eBay sync:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to apply eBay sync' },
    });
  }
});

router.post('/ebay/update/bulk', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.map((x) => String(x || '').trim()).filter(Boolean)
      : null;
    const applyAll = body.applyAll === true;
    if (!applyAll && (!itemIds || !itemIds.length)) {
      return res.status(400).json({
        ok: false,
        error: { code: 400, message: 'itemIds oder applyAll erforderlich.' },
      });
    }
    const { bulkReviseListingsFromProducts } = require('../lib/ebay-direct');
    const out = await bulkReviseListingsFromProducts({
      itemIds,
      applyAll,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: out });
  } catch (error) {
    console.error('Failed to bulk update eBay listings:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to bulk update eBay listings' },
    });
  }
});

// =====================================================================
// eBay End Listing
// =====================================================================

router.post('/ebay/listings/end', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const itemId = String(body.itemId || '').trim();
    if (!itemId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'itemId is required.' } });
    }
    const reason = String(body.reason || 'NotAvailable').trim();

    // Determine listing type to pick correct API call
    const { getItemDetails, endItem, endFixedPriceItem } = require('../lib/ebay-trading-api');
    let listingType = '';
    try {
      const detail = await getItemDetails(itemId);
      listingType = String(detail?.item?.listingType || '').toLowerCase();
    } catch (err) {
      // If we can't fetch, default to EndFixedPriceItem (most common for TrendOcean)
      console.warn(`[POST /ebay/listings/end] Could not fetch listing type for ${itemId}: ${err.message}`);
    }

    const result = listingType.includes('fixed')
      ? await endFixedPriceItem(itemId, { reason })
      : listingType
        ? await endItem(itemId, { reason })
        : await endFixedPriceItem(itemId, { reason });

    // Update local cache: mark listing inactive
    const { firestore } = require('../lib/firestore');
    const { FieldValue } = require('@google-cloud/firestore');
    const EBAY_LISTINGS_COLLECTION = process.env.EBAY_LISTINGS_COLLECTION || 'ebayListingsLive';
    await firestore.collection(EBAY_LISTINGS_COLLECTION).doc(itemId).set(
      {
        active: false,
        listingStatus: 'Ended',
        endedAt: FieldValue.serverTimestamp(),
        endedAtIso: new Date().toISOString(),
        endedBy: req.user?.email || req.user?.uid || 'api',
        endingReason: reason,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error(`[POST /ebay/listings/end] ${error.message}`, error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to end eBay listing' },
    });
  }
});

// =====================================================================
// eBay Reports
// =====================================================================

router.post('/ebay/reports/generate', requirePermission('products', 'read'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const outDir = typeof body.outDir === 'string' && body.outDir.trim() ? body.outDir.trim() : null;
    const { createOperationalReports } = require('../lib/ebay-direct');
    const report = await createOperationalReports({ outDir });
    return res.status(200).json({ ok: true, data: report });
  } catch (error) {
    console.error('Failed to generate eBay reports:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to generate reports' },
    });
  }
});

// =====================================================================
// eBay Publish (AddFixedPriceItem)
// =====================================================================

router.post('/ebay/publish/verify', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const productId = String(body.productId || '').trim();
    if (!productId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing productId' } });
    }
    const rawOverrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const { mergeEbayOverrides } = require('../lib/integration-defaults');
    const overrides = await mergeEbayOverrides(rawOverrides, { tenantId: req.user?.tenantId || 'default' });
    const { verifyPublishProduct } = require('../lib/ebay-direct');
    const result = await verifyPublishProduct(productId, overrides);
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error('Failed to verify eBay publish:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to verify eBay publish' },
    });
  }
});

router.post('/ebay/publish', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const productId = String(body.productId || '').trim();
    if (!productId) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing productId' } });
    }
    const rawOverrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const { mergeEbayOverrides } = require('../lib/integration-defaults');
    const overrides = await mergeEbayOverrides(rawOverrides, { tenantId: req.user?.tenantId || 'default' });
    const { publishProduct } = require('../lib/ebay-direct');
    const result = await publishProduct(productId, overrides, {
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error('Failed to publish to eBay:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to publish to eBay' },
    });
  }
});

router.post('/ebay/publish/bulk/verify', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const productIds = Array.isArray(body.productIds) ? body.productIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!productIds.length) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing productIds array' } });
    }
    const rawOverrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const { mergeEbayOverrides } = require('../lib/integration-defaults');
    const overrides = await mergeEbayOverrides(rawOverrides, { tenantId: req.user?.tenantId || 'default' });
    const { bulkVerifyPublishProducts } = require('../lib/ebay-direct');
    const result = await bulkVerifyPublishProducts(productIds, overrides);
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error('Failed to bulk verify eBay publish:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to bulk verify eBay publish' },
    });
  }
});

router.post('/ebay/publish/bulk', requirePermission('products', 'write'), async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const productIds = Array.isArray(body.productIds) ? body.productIds.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!productIds.length) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Missing productIds array' } });
    }
    const rawOverrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const { mergeEbayOverrides } = require('../lib/integration-defaults');
    const overrides = await mergeEbayOverrides(rawOverrides, { tenantId: req.user?.tenantId || 'default' });
    const { bulkPublishProducts } = require('../lib/ebay-direct');
    const result = await bulkPublishProducts(productIds, overrides, {
      actor: req.user?.email || req.user?.uid || 'api',
    });
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error('Failed to bulk publish to eBay:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to bulk publish to eBay' },
    });
  }
});

// =====================================================================
// eBay Categories (breadcrumb-based search)
// =====================================================================

router.get('/ebay/categories', (req, res) => {
  try {
    const query = (req.query.q || '').toString().trim();
    const id = (req.query.id || '').toString().trim();
    const leafOnly =
      String(req.query.leafOnly || req.query.leaf_only || '')
        .trim()
        .toLowerCase() === 'true';
    const limitRaw = parseInt(req.query.limit || '50', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const items = [];
    if (id) {
      const found = getEbayCategoryById(id);
      if (found) items.push(found);
    }
    if (query && query.length >= 2) {
      const matches = searchEbayCategories(query, limit, { leafOnly });
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

// =====================================================================
// eBay Taxonomy (Admin viewer)
// =====================================================================

// Provides a complete category list (incl. leaf flag) and per-category aspects catalog (required/recommended/optional).
router.get('/ebay/taxonomy/categories', requirePermission('products', 'read'), (req, res) => {
  try {
    const includeBanned =
      String(req.query.includeBanned || req.query.include_banned || '')
        .trim()
        .toLowerCase() === 'true';
    const leafOnly =
      String(req.query.leafOnly || req.query.leaf_only || '')
        .trim()
        .toLowerCase() === 'true';

    const { entries } = getEbayCategoryEntries();
    const items = entries
      .filter((entry) => (includeBanned ? true : !entry.banned))
      .filter((entry) => (leafOnly ? Boolean(entry.leaf) : true))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        breadcrumb: entry.breadcrumb,
        root: entry.root || '',
        leaf: Boolean(entry.leaf),
        banned: Boolean(entry.banned),
      }));

    return res.status(200).json({
      ok: true,
      data: {
        items,
        total: items.length,
        includeBanned,
        leafOnly,
      },
    });
  } catch (error) {
    console.error('Failed to load eBay taxonomy categories:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to load eBay taxonomy categories.' },
    });
  }
});

router.get('/ebay/taxonomy/categories/:id/aspects', requirePermission('products', 'read'), (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: { code: 400, message: 'Category id is required.' } });
    }
    const { byId } = getEbayCategoryEntries();
    const entry = byId.get(id) || null;
    if (!entry) {
      return res.status(404).json({ ok: false, error: { code: 404, message: 'Category not found.' } });
    }

    const catalog = getCategoryAspectCatalog(id);
    return res.status(200).json({
      ok: true,
      data: {
        category: {
          id: entry.id,
          name: entry.name,
          breadcrumb: entry.breadcrumb,
          root: entry.root || '',
          leaf: Boolean(entry.leaf),
          banned: Boolean(entry.banned),
        },
        catalog,
      },
    });
  } catch (error) {
    console.error('Failed to load eBay taxonomy aspects:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: 'Failed to load eBay taxonomy aspects.' },
    });
  }
});

// =====================================================================
// KType
// =====================================================================

// Upload K-Type CSV (eBay compatibility export) and update products' details.attributes["K-Typ"]
router.post('/ktype/upload', ktypeUploadMiddleware, async (req, res) => {
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

module.exports = router;
