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
const { isRetiredKauflandUnit } = require('../lib/kaufland-unit-status');
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

/**
 * Optimistic upsert into kauflandUnitsLive after a successful createUnit().
 *
 * Why: the periodic kaufland-listings-sync runs every few minutes, so without
 * this helper a freshly published unit only appears in the UI after the next
 * sync + manual hard refresh. The frontend already subscribes to changes on
 * `system/kaufland-sync-state` via Firestore onSnapshot — writing the unit row
 * + bumping the marker doc means the UI updates within <1s of publish.
 *
 * Best-effort: must never throw / never block the publish response.
 */
async function optimisticUpsertKauflandUnit({ product, createResult, storefront }) {
  try {
    if (!createResult || !createResult.id_unit) return;
    const { Timestamp } = require('@google-cloud/firestore');
    const idUnit = String(createResult.id_unit);
    const sf = String(storefront || 'de').trim().toLowerCase();

    // Best-available EAN (mirror autoFixProduct/pickUnitData logic).
    const ean =
      String(product?.identification?.ean || product?.details?.identifiers?.ean || '').replace(/\D+/g, '') ||
      (Array.isArray(product?.identification?.barcodes)
        ? product.identification.barcodes
            .map((v) => String(v || '').replace(/\D+/g, ''))
            .find((v) => v.length === 13 || v.length === 14) || null
        : null);

    // Quantity mirrors pickUnitData precedence.
    const binStock = Array.isArray(product?.storageBins)
      ? product.storageBins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0)
      : null;
    const qtyRaw = product?.inventory?.availableQuantity
      ?? product?.inventory?.quantity
      ?? binStock
      ?? product?.storage?.quantity
      ?? 0;
    const amount = Math.max(0, Number(qtyRaw) || 0);
    const status = amount > 0 ? 'AVAILABLE' : 'ONHOLD';
    const active = status === 'AVAILABLE';

    // Pricing in cents (Kaufland API contract — matches pickUnitData output).
    const toCents = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.round(n * 100);
    };
    const listingPrice = toCents(
      product?.details?.pricing?.sellPrice
        ?? product?.pricing?.sellPrice
        ?? product?.details?.pricing?.amount
    );
    const minimumPrice = toCents(
      product?.details?.pricing?.minimum_price?.amount
        ?? product?.details?.pricing?.minimum_price
        ?? product?.details?.pricing?.minimumPrice
    );

    const now = Timestamp.now();
    const sku = String(product?.identification?.sku || product?.details?.identifiers?.sku || '').trim() || null;
    const title = (typeof product?.identification?.name === 'string' && product.identification.name.trim())
      ? product.identification.name.trim()
      : null;

    await firestore.collection('kauflandUnitsLive').doc(idUnit).set({
      id_unit: Number(idUnit),
      id_offer: sku,
      ean: ean || null,
      amount,
      status,
      storefront: sf,
      active,
      title,
      listing_price: listingPrice,
      current_price: listingPrice, // initial = listing; auto-pricer will adjust
      minimum_price: minimumPrice,
      product_valid: null, // validity-refresh phase sets this later
      source: 'kaufland-publish-optimistic',
      updatedAt: now,
    }, { merge: true });

    // Bump the realtime marker so any open frontend listener invalidates instantly.
    await firestore.collection('system').doc('kaufland-sync-state').set({
      lastSyncAt: now,
      source: 'optimistic-publish',
    }, { merge: true });
  } catch (e) {
    // Non-blocking — publish must never fail because of cache write.
    try { console.warn('[kaufland-publish] optimistic upsert failed (non-fatal):', e.message); } catch (_) {}
  }
}

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

router.get('/ebay/oauth/start', requirePermission('integrations', 'write'), async (req, res) => {
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
// eBay Artikelzustand
// =====================================================================

/**
 * GET /api/ebay/conditions?categoryId=261588
 *
 * Liefert die Artikelzustaende, die eBay in DIESER Kategorie zulaesst — mit den
 * dort gueltigen Anzeigenamen. Beides haengt an der Kategorie: ConditionID 1000
 * heisst meist "Neu", in Bekleidungs-Kategorien "Neu mit Etikett".
 *
 * Ohne categoryId kommt die allgemeine Liste zurueck, damit das Datenblatt auch
 * ohne zugewiesene Kategorie etwas anzeigen kann.
 */
router.get('/ebay/conditions', requirePermission('products', 'read'), async (req, res) => {
  try {
    const {
      getConditionsForCategory,
      GENERIC_CONDITION_NAMES,
      DEFAULT_CONDITION_ID,
      getTableSyncedAt,
    } = require('../lib/ebay-conditions');

    const categoryId = String(req.query.categoryId || '').trim();
    const result = categoryId ? getConditionsForCategory(categoryId) : { known: false, required: false, conditions: [] };

    // Rueckfall: keine Kategorie oder Kategorie unbekannt -> allgemeine Liste.
    // `known:false` signalisiert dem Frontend, dass die Auswahl nicht
    // kategoriegenau geprueft ist.
    const conditions = result.conditions.length
      ? result.conditions
      : Object.entries(GENERIC_CONDITION_NAMES).map(([id, name]) => ({ id, name }));

    res.json({
      ok: true,
      categoryId: categoryId || null,
      known: result.known,
      required: result.required,
      defaultConditionId: DEFAULT_CONDITION_ID,
      conditions,
      syncedAt: getTableSyncedAt(),
    });
  } catch (err) {
    console.error(`[GET /api/ebay/conditions] ${err.message}`, err);
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
  }
});

// =====================================================================
// eBay Status
// =====================================================================

router.get('/ebay/status', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { getEbayIntegration, publicStatus } = require('../lib/ebay-oauth');
    const doc = await getEbayIntegration();
    const status = publicStatus(doc);
    // Ehrlicher Sync-Zustand (letzter ERFOLGREICHER Abruf, aktueller Fehler) —
    // best effort, darf den Status-Endpoint nie brechen.
    try {
      const { getEbayListingSyncHealth } = require('../lib/ebay-direct');
      status.listingSync = await getEbayListingSyncHealth();
    } catch (err) {
      status.listingSync = null;
    }
    return res.status(200).json({ ok: true, data: status });
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
    const { bus } = require('../services/sync-event-bus');
    const summary = await syncLiveListingsAndAudit({
      runId,
      maxPages,
      entriesPerPage,
      detailConcurrency,
      timeoutMs,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    bus.emit('listings:sync_completed', { source: 'api', active: summary?.ingest?.activeListings || 0 });
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
    const { bus } = require('../services/sync-event-bus');
    const summary = await syncLiveListingsLight({
      runId,
      maxPages,
      entriesPerPage,
      timeoutMs,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    if (!summary?.skipped) {
      bus.emit('listings:sync_completed', { source: 'api-light', active: summary?.ingest?.activeListings || 0 });
    }
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

// Repair wrongly deactivated listings — reactivates listings that are
// `active: false` + `listingStatus: 'Active'` + `deactivation.reason: 'not_in_active_list'`
router.post('/ebay/listings/repair', requirePermission('products', 'write'), async (req, res) => {
  try {
    const { reactivateWronglyDeactivatedListings } = require('../lib/ebay-direct');
    const { bus } = require('../services/sync-event-bus');
    const result = await reactivateWronglyDeactivatedListings({
      runId: `repair-${Date.now()}`,
      actor: req.user?.email || req.user?.uid || 'api',
    });
    if (result.repaired > 0) {
      bus.emit('listings:sync_completed', { source: 'repair', repaired: result.repaired });
    }
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error('Failed to repair eBay listings:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Repair failed' },
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
    // D.0b — Tenant-scoped read in buildProductListingLinks.
    const tenantId = req.user?.tenantId || 'default';
    const summary = await buildProductListingLinks({
      itemIds,
      runId,
      actor: req.user?.email || req.user?.uid || 'api',
      tenantId,
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
// Sync-Logik lebt in services/kaufland-listings-sync.js (Plan-D.0d Extract). Derselbe
// Service wird vom Safety-Net-Cron in backend/index.js verwendet. Response-Shape ist
// identisch zur pre-extraction Implementierung (storefront, fetched, active,
// driftsDetected, reconciled, reverseDriftsDetected, reverseDriftSamples).
router.post('/kaufland/listings/sync', requirePermission('products', 'write'), async (req, res) => {
  try {
    const storefront = String(req.body?.storefront || req.query?.storefront || 'de').trim().toLowerCase();
    const { syncKauflandListingsCache } = require('../services/kaufland-listings-sync');
    const tenantId = req.user?.tenantId;
    const result = await syncKauflandListingsCache({ tenantId, storefront });
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    console.error('Failed to sync Kaufland listings:', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to sync Kaufland listings' },
    });
  }
});

// Bookings/payout data from Kaufland Reports API (true payouts, not the
// 0.8334 estimate the dashboard currently shows).
// GET /api/marketplace/kaufland/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD&storefront=de
router.get('/kaufland/bookings', requirePermission('products', 'read'), async (req, res) => {
  try {
    const from = String(req.query?.from || '').trim();
    const to = String(req.query?.to || '').trim();
    const storefront = String(req.query?.storefront || 'de').trim().toLowerCase();
    const limit = Math.max(0, parseInt(req.query?.limit, 10) || 0);
    const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'INVALID_DATE_RANGE',
          message: 'from and to query params must be YYYY-MM-DD',
        },
      });
    }

    const { getBookings } = require('../lib/kaufland-api');
    const result = await getBookings({ from, to, storefront, limit, offset });

    return res.status(200).json({
      ok: true,
      data: {
        from: result.from,
        to: result.to,
        storefront: result.storefront,
        total_payout_cents: result.total_payout_cents,
        total_payout_eur: result.total_payout_eur,
        currency: result.currency,
        count: result.count,
        bookings: result.bookings,
        reportId: result.reportId,
        reportUrl: result.reportUrl,
        endpointUsed: result.endpointUsed,
      },
    });
  } catch (error) {
    console.error(`[GET /api/marketplace/kaufland/bookings] ${error.message}`, error);
    const status =
      error.code === 'KAUFLAND_BOOKINGS_DATE_INVALID' ? 400 :
      error.code === 'KAUFLAND_BOOKINGS_TIMEOUT' ? 504 :
      error.code === 'KAUFLAND_BOOKINGS_ENDPOINT_UNKNOWN' ? 502 :
      500;
    return res.status(status).json({
      ok: false,
      error: { code: error.code || 'INTERNAL', message: error.message },
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
      const normalizedStatus = String(d.status || '').trim().toUpperCase();
      rows.push({
        idUnit: doc.id,
        sku: d.id_offer || null,
        skuNormalized: d.id_offer_normalized || null,
        ean: d.ean || null,
        eans: Array.isArray(d.eans) ? d.eans : [],
        status: normalizedStatus || null,
        // Trust the `active` flag set by the sync after Kaufland's /units
        // API confirms the unit is live AVAILABLE. The old fallback
        // (status === 'AVAILABLE' || active === true) coerced ghost docs
        // (active=false with stale status='AVAILABLE') back to active=true,
        // producing false-positive "gelistet" badges in the Inventory table.
        active: d.active === true,
        // product.is_valid as cached by the validity-refresh phase of the
        // listings-sync. true = Kaufland Portal "Aktiv", false = "Indexierung
        // läuft" (typically <24h after first publish), null = legacy doc or
        // validity not yet checked (fall back to legacy "active" semantics).
        productValid: typeof d.product_valid === 'boolean' ? d.product_valid : null,
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
    const { getAllProductsV2, getAllProductsV2ForTenant } = require('../lib/product-store');

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
    // D.0c-style tenant fallback: prefer Firestore-side filter when a
    // tenantId is on req.user, else read globally (legacy behaviour).
    const tenantIdForListings = req.user?.tenantId;
    const products = tenantIdForListings
      ? await getAllProductsV2ForTenant(tenantIdForListings)
      : await getAllProductsV2();

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
    // Track which SKUs have a live (non-STALE) unit, so a SKU whose Kaufland
    // unit-ID changed (e.g. ZMH Pendelleuchte 391697909106 → 392125425300)
    // does not also surface its old STALE ghost as a separate "inactive" row.
    const liveSkus = new Set();
    unitsSnap.docs.forEach((doc) => {
      const d = doc.data() || {};
      if (!isRetiredKauflandUnit(d)) {
        const s = String(d.id_offer_normalized || d.id_offer || '').trim().toLowerCase();
        if (s) liveSkus.add(s);
      }
    });

    unitsSnap.docs.forEach((doc) => {
      const d = doc.data() || {};
      const unitSku = (d.id_offer || '').trim();
      const unitEan = (d.ean || '').trim();

      // Exclude retire-tombstones — they are internal markers, NOT listings:
      //   STALE     → unit no longer returned by Kaufland's /units API. Keeping
      //               them inflated the total (cache 865 vs real 397) and lumped
      //               468 dead rows into a misleading "Inaktiv" count.
      //               (Verified 2026-05-24: 394 AVAILABLE + 3 ONHOLD + 468 STALE.)
      //   NOT_FOUND → retireKauflandUnit() marker after a Kaufland 404 (unit does
      //               not exist, e.g. a leftover unit-id from a previous account).
      //               (Incident 2026-07-09: a lone NOT_FOUND tombstone showed as
      //               "1 Inaktiv" on a brand-new, empty Kaufland account.)
      // The current marketplace reality is exactly the non-retired rows.
      if (isRetiredKauflandUnit(d)) return;

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

      // Three distinct Kaufland prices, all stored in cents in cache:
      //   currentPrice  → what Kaufland's auto-pricer shows customers now (Portal-bold)
      //   listingPrice  → max price set by seller (our setting)
      //   minimumPrice  → min price floor (auto-pricer won't go below)
      const klCurrentPrice = Number.isFinite(Number(d.current_price)) ? Number(d.current_price) / 100 : null;
      const klListingPrice = Number.isFinite(Number(d.listing_price)) ? Number(d.listing_price) / 100 : null;
      const klMinimumPrice = Number.isFinite(Number(d.minimum_price)) ? Number(d.minimum_price) / 100 : null;

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

      // Primary price = Kaufland's actual customer-facing sell price (Portal-truth).
      // Fallback chain: current → listing → matched product sellPrice.
      const matchedPrice = matched?.details?.pricing?.sellPrice ?? null;
      const unitPrice = klCurrentPrice !== null ? klCurrentPrice
        : klListingPrice !== null ? klListingPrice
        : matchedPrice;

      // Category: try multiple sources from matched product
      const categoryName = matched?.identification?.category || matched?.details?.category || matched?.details?.categoryId || null;

      const normalizedStatus = String(d.status || '').trim().toUpperCase();
      // Trust the `active` flag set by the sync — see comment in the
      // /kaufland/sku-index route above for the rationale.
      const isActive = d.active === true;
      rows.push({
        idUnit: doc.id,
        sku: unitSku || null,
        ean: unitEan || null,
        status: normalizedStatus || null,
        active: isActive,
        // product.is_valid as cached by the validity-refresh phase of the
        // listings-sync. true = Portal "Aktiv" (Live), false = "Indexierung
        // läuft", null = legacy doc / validity not yet checked.
        productValid: typeof d.product_valid === 'boolean' ? d.product_valid : null,
        quantity: mpQty,
        idProduct: Number.isFinite(Number(d.id_product)) ? Number(d.id_product) : null,
        viewItemUrl: d.view_item_url || null,
        updatedAt: updatedAtIso,
        // Enriched product data (AvyCloud match → Kaufland data fallback)
        productId: matched?.id || null,
        title: matched?.identification?.name || klTitle || null,
        brand: matched?.identification?.brand || null,
        price: unitPrice,
        // All three Kaufland prices so the UI can show the spread (max/current/min).
        // When currentPrice < listingPrice the seller is being underbid; min shows
        // the floor before pricing engine stops competing.
        currentPrice: klCurrentPrice,
        listingPrice: klListingPrice,
        minimumPrice: klMinimumPrice,
        imageUrl: matched?.details?.images?.[0]?.url_or_base64 || matched?.details?.images?.[0]?.url || null,
        category: categoryName,
        warehouseStock: typeof whStock === 'number' ? whStock : null,
        binLocation: binLoc,
        stockMismatch: mismatch,
        // Kaufland invalidity reasons (invalid-reasons phase of the listings
        // sync, services/kaufland-listings-sync.js). Only populated while
        // product_valid === false; self-healing clears them on re-validation.
        //   invalidMissingAttributes → Kauflands fehlende Pflichtattribute
        //                              (deutsche Labels, z.B. 'Bild')
        //   invalidDeclined          → abgelehnte Werte inkl. Grund
        //   invalidCheckedAt         → ISO, wann Gründe zuletzt geholt
        invalidMissingAttributes: Array.isArray(d.invalid_missing_attributes)
          ? d.invalid_missing_attributes.map((a) => String(a || '').trim()).filter(Boolean)
          : [],
        invalidDeclined: Array.isArray(d.invalid_declined)
          ? d.invalid_declined
            .map((e) => ({ attribute: String(e?.attribute || ''), message: String(e?.message || '') }))
            .filter((e) => e.attribute || e.message)
          : [],
        invalidCheckedAt: typeof d.invalid_reasons_checked_at === 'string'
          ? d.invalid_reasons_checked_at
          : (d.invalid_reasons_checked_at?.toDate?.()?.toISOString?.() || null),
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

// --- Listing-Fehler-Persistenz (Kaufland) ------------------------------------
// Spiegelt eBays `marketplace.ebay.listing_errors`: fehlgeschlagene Kaufland-
// Listings bleiben pro Produkt gespeichert (nicht flüchtig im Modal) bis behoben,
// und werden bei erfolgreichem Publish automatisch gelöscht. `update()` (statt
// set+merge) verhindert Ghost-Docs, falls die Produkt-ID nicht existiert.
async function persistKauflandListingError(productId, message, code = null) {
  if (!productId || !message) return;
  try {
    await firestore.collection('products_v2').doc(String(productId)).update({
      'marketplace.kaufland.listing_errors': [{ code: code || null, message: String(message), severity: 'Error' }],
      'marketplace.kaufland.listing_errors_at': new Date().toISOString(),
    });
  } catch (e) {
    if (e?.code !== 5 /* NOT_FOUND — kein Doc, kein Ghost */) {
      console.warn(`[kaufland] persist listing error ${productId}: ${e?.message}`);
    }
  }
}

async function clearKauflandListingError(productId) {
  if (!productId) return;
  try {
    await firestore.collection('products_v2').doc(String(productId)).update({
      'marketplace.kaufland.listing_errors': FieldValue.delete(),
      'marketplace.kaufland.listing_errors_at': FieldValue.delete(),
    });
  } catch (e) {
    if (e?.code !== 5) console.warn(`[kaufland] clear listing error ${productId}: ${e?.message}`);
  }
}

// --- Pending-Publish-Marker (Kaufland) ----------------------------------------
// KAUFLAND_PRODUCT_DATA_PENDING heißt: Produktdaten sind eingereicht, aber
// Kaufland validiert asynchron und POST /units schlug (noch) fehl. Die Route
// antwortet 202 — ohne Marker retried danach NICHTS und das Produkt hängt für
// immer im Portal-Bucket "Angebotsdaten fehlen". Der Sync-Runner
// (services/kaufland-listings-sync.js, Phase "pending-publish heal") liest den
// Marker und versucht createUnit erneut, sobald Kaufland product_ready meldet.
// update() statt set+merge: NOT_FOUND-safe, keine Ghost-Docs (gleiches Pattern
// wie persistKauflandListingError).
async function markKauflandPublishPending(productId, storefront = 'de') {
  if (!productId) return;
  try {
    await firestore.collection('products_v2').doc(String(productId)).update({
      'marketplace.kaufland.publish_pending_at': new Date().toISOString(),
      'marketplace.kaufland.publish_pending': {
        reason: 'product_data_pending',
        storefront: String(storefront || 'de'),
        attempts: FieldValue.increment(1),
      },
    });
  } catch (e) {
    if (e?.code !== 5) console.warn(`[kaufland] mark publish pending ${productId}: ${e?.message}`);
  }
}

async function clearKauflandPublishPending(productId) {
  if (!productId) return;
  try {
    await firestore.collection('products_v2').doc(String(productId)).update({
      'marketplace.kaufland.publish_pending_at': FieldValue.delete(),
      'marketplace.kaufland.publish_pending': FieldValue.delete(),
    });
  } catch (e) {
    if (e?.code !== 5) console.warn(`[kaufland] clear publish pending ${productId}: ${e?.message}`);
  }
}

// Gebündeltes Listing-Fehler-Cockpit: jedes Produkt, das auf eBay ODER Kaufland
// nicht gelistet werden konnte, mit klassifizierten Gründen + Aggregat nach Grund.
// Quelle: `marketplace.{ebay,kaufland}.listing_errors` (persistiert bis behoben).
router.get('/listing-errors', requirePermission('products', 'read'), async (req, res) => {
  try {
    const { classifyListingError } = require('../lib/listing-error-classify');
    const { getAllProductsV2, getAllProductsV2ForTenant } = require('../lib/product-store');
    const tenantId = req.user?.tenantId;
    const products = tenantId ? await getAllProductsV2ForTenant(tenantId) : await getAllProductsV2();

    const rows = [];
    const groups = new Map();
    let ebayCount = 0;
    let kauflandCount = 0;

    const addRow = (product, channel, errs) => {
      const list = Array.isArray(errs) ? errs.filter(Boolean) : [];
      if (!list.length) return;
      const classified = list.map((e) => classifyListingError(e));
      const primary = classified[0];
      rows.push({
        productId: product.id,
        sku: product?.identification?.sku || product?.details?.identifiers?.sku || null,
        title: product?.identification?.name || product?.details?.title || null,
        imageUrl: product?.details?.images?.[0]?.url_or_base64 || product?.details?.images?.[0]?.url || null,
        channel,
        primaryGroupKey: primary.groupKey,
        primaryLabel: primary.label,
        errors: classified.map((c, i) => ({
          code: c.code, message: c.message, label: c.label, groupKey: c.groupKey,
          severity: list[i]?.severity || 'Error',
        })),
        at: channel === 'ebay'
          ? (product?.marketplace?.ebay?.listing_errors_at || null)
          : (product?.marketplace?.kaufland?.listing_errors_at || null),
      });
      if (channel === 'ebay') ebayCount += 1; else kauflandCount += 1;
      const g = groups.get(primary.groupKey)
        || { groupKey: primary.groupKey, label: primary.label, count: 0, ebay: 0, kaufland: 0 };
      g.count += 1; g[channel] += 1;
      groups.set(primary.groupKey, g);
    };

    for (const p of products) {
      addRow(p, 'ebay', p?.marketplace?.ebay?.listing_errors);
      addRow(p, 'kaufland', p?.marketplace?.kaufland?.listing_errors);
    }

    rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const groupList = Array.from(groups.values()).sort((a, b) => b.count - a.count);

    return res.status(200).json({
      ok: true,
      data: {
        summary: { total: rows.length, ebay: ebayCount, kaufland: kauflandCount },
        groups: groupList,
        rows,
      },
    });
  } catch (error) {
    console.error('[GET /api/marketplace/listing-errors]', error);
    return res.status(500).json({
      ok: false,
      error: { code: 500, message: error?.message || 'Failed to load listing errors' },
    });
  }
});

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
    // Realtime: optimistic upsert into kauflandUnitsLive so UI listeners see
    // the row immediately, no wait for next periodic sync.
    await optimisticUpsertKauflandUnit({ product, createResult: result, storefront });
    await clearKauflandListingError(productId);
    await clearKauflandPublishPending(productId);
    return res.status(201).json({ ok: true, data: result });
  } catch (error) {
    console.error(`[POST /api/marketplace/kaufland/publish] ${error.message}`, error);
    if (error.code === 'KAUFLAND_PRODUCT_DATA_PENDING') {
      // 202 allein wäre ein Dead-End — Marker setzen, damit der Sync-Runner
      // den Publish automatisch nachholt sobald Kaufland fertig validiert hat.
      await markKauflandPublishPending(req.body?.productId, req.body?.storefront || 'de');
      return res.status(202).json({
        ok: true,
        data: { productDataSubmitted: true, message: error.message },
      });
    }
    await persistKauflandListingError(req.body?.productId, error.message, error.code);
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

  // Body-level Optionen werden in der äußeren try gelesen — Default für die
  // autoFixProduct-Closure aber bereits hier setzen, damit es nie undefined ist.
  let publishWithOnHold = true;

  async function autoFixProduct(product) {
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

    // --- 0-Stock Handling (Deliverable 3): publishWithOnHold default = true ---
    // Spiegelt pickUnitData(): availableQuantity || quantity || storageBins-sum || storage.quantity
    const binStockSum = Array.isArray(p?.storageBins)
      ? p.storageBins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0)
      : null;
    const qtyRaw = p?.inventory?.availableQuantity
      ?? p?.inventory?.quantity
      ?? binStockSum
      ?? p?.storage?.quantity
      ?? 0;
    const qty = Math.max(0, Number(qtyRaw) || 0);
    if (qty <= 0) {
      if (publishWithOnHold) {
        fixes.push('Listing mit 0 Bestand (ONHOLD bis Stock-Eingang)');
      } else {
        return { product: p, fixes, skip: true, reason: 'Kein Bestand vorhanden (publishWithOnHold=false)' };
      }
    }

    // --- GPSR auto-enrichment via web-fallback (Deliverable 2, best-effort, timeout 8s) ---
    const hasGpsr = (p?.details?.gpsr?.manufacturer_name || p?.details?.gpsr?.name)
                 && (p?.details?.gpsr?.address || p?.details?.gpsr?.manufacturer_address);
    if (!hasGpsr) {
      try {
        const { lookupGpsrFromWeb } = require('../lib/gpsr-web-fallback');
        const brand = p?.identification?.brand || p?.details?.brand || '';
        if (brand) {
          const result = await Promise.race([
            lookupGpsrFromWeb(brand, { timeout: 8000 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('gpsr-timeout')), 8000)),
          ]);
          const gotName = result && (result.manufacturer_name || result.name);
          const gotAddr = result && (result.manufacturer_address || result.address);
          if (gotName || gotAddr) {
            p.details = p.details || {};
            p.details.gpsr = { ...(p.details.gpsr || {}), ...result };
            fixes.push('GPSR-Daten via Web-Lookup ergaenzt');
          }
        }
      } catch (_) { /* swallow — non-blocking */ }
    }

    return { product: p, fixes, skip: false };
  }

  // Bulk-Run-Audit (Deliverable 1, best-effort — Publish darf nie blockieren)
  let audit = null;
  let runId = null;

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const productIds = Array.isArray(body.productIds)
      ? body.productIds.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (!productIds.length) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_PRODUCT_IDS', message: 'productIds array is required' } });
    }
    const storefront = body.storefront || 'de';
    // publishWithOnHold default true — falls explizit false gesetzt, bisheriges Skip-Verhalten
    if (body.publishWithOnHold === false) publishWithOnHold = false;
    // Per-request overrides from publish dialog take priority over Firestore defaults
    const requestOverrides = body.overrides && typeof body.overrides === 'object' ? body.overrides : {};
    const reqShippingGroup = Number(requestOverrides.shippingGroupId) || 0;
    const reqWarehouse = Number(requestOverrides.warehouseId) || 0;
    if (reqShippingGroup > 0) KL_DEFAULT_SHIPPING_GROUP = reqShippingGroup;
    if (reqWarehouse > 0) KL_DEFAULT_WAREHOUSE = reqWarehouse;
    const { getProductV2 } = require('../lib/product-store');
    const { createUnit } = require('../lib/kaufland-api');

    // Audit-Run starten — best-effort, Publish darf nie blockieren
    try {
      audit = require('../services/kaufland-publish-audit');
      runId = await audit.startRun({
        tenantId: req.user?.tenantId,
        storefront,
        source: 'ui-bulk',
        requestedProductIds: productIds,
      }).catch(() => null);
    } catch (_) {
      audit = null;
      runId = null;
    }

    const results = [];
    let repairedCount = 0;
    for (const id of productIds) {
      const startedAt = Date.now();
      let perProductFixes = [];
      let perProductSku = null;
      let perProductIdUnit = null;
      let perProductRepaired = false;
      let perProductOk = false;
      let perProductStatus = 'failed';
      let perProductReason = null;
      try {
        const product = await getProductV2(id);
        if (!product) {
          perProductStatus = 'skipped';
          perProductReason = `Produkt ${id} nicht gefunden`;
          results.push({ productId: id, ok: false, status: perProductStatus, reason: perProductReason });
          continue;
        }

        perProductSku = product?.identification?.sku || product?.details?.identifiers?.sku || null;

        const { product: fixedProduct, fixes, skip, reason } = await autoFixProduct(product);
        perProductFixes = fixes || [];
        if (skip) {
          perProductStatus = 'skipped';
          perProductReason = reason;
          results.push({ productId: id, ok: false, status: perProductStatus, reason: perProductReason });
          continue;
        }

        try {
          const result = await createUnit(fixedProduct, { storefront });
          perProductIdUnit = result?.id_unit || null;
          perProductOk = true;
          perProductStatus = result.productDataSubmitted
            ? 'fixed'
            : (perProductFixes.length ? 'fixed' : 'published');
          if (result.productDataSubmitted) perProductFixes.push('Produktdaten bei Kaufland eingereicht');
          // Realtime: optimistic upsert into kauflandUnitsLive so UI listeners
          // see the row immediately, no wait for next periodic sync.
          await optimisticUpsertKauflandUnit({ product: fixedProduct, createResult: result, storefront });
          results.push({
            productId: id,
            ok: true,
            status: perProductStatus,
            fixes: perProductFixes.length ? perProductFixes : undefined,
            data: result,
          });
        } catch (publishErr) {
          if (publishErr.code === 'KAUFLAND_PRODUCT_DATA_PENDING') {
            // Marker für den Self-Heal-Loop im Sync-Runner — deckt sowohl
            // 'pending' als auch 'pending-repaired' ab (beide enden ohne Unit).
            await markKauflandPublishPending(id, storefront).catch(() => null);
            // Deliverable 4: try-repair-hook post-create
            if (publishErr.productDataSubmitted) {
              try {
                const repair = require('../services/kaufland-product-data-repair');
                let pickedEan = null;
                try {
                  const { pickUnitData } = require('../lib/kaufland-api');
                  const picked = pickUnitData(fixedProduct, { mode: 'create', storefront });
                  pickedEan = picked?.ean || null;
                } catch (_) { /* fallback to identifiers below */ }
                if (!pickedEan) {
                  pickedEan =
                    String(fixedProduct?.details?.identifiers?.ean || '').replace(/\D+/g, '') ||
                    (Array.isArray(fixedProduct?.identification?.barcodes)
                      ? fixedProduct.identification.barcodes
                          .map((v) => String(v || '').replace(/\D+/g, ''))
                          .find((v) => v.length === 13 || v.length === 14) || null
                      : null);
                }
                const repairResult = await repair.tryRepairKauflandProductData({
                  product: fixedProduct,
                  ean: pickedEan,
                  idUnit: null,
                  storefront,
                });
                // Repair service may use either `repaired` (legacy contract) or
                // `attempted + patchedKeys.length > 0` (actual implementation).
                const didRepair = !!(
                  repairResult && (
                    repairResult.repaired === true ||
                    (repairResult.attempted === true && Array.isArray(repairResult.patchedKeys) && repairResult.patchedKeys.length > 0)
                  )
                );
                if (didRepair) {
                  perProductRepaired = true;
                  repairedCount += 1;
                  perProductStatus = 'pending-repaired';
                  perProductReason = 'Produktdaten ergaenzt — Kaufland indexiert asynchron (24h)';
                  perProductFixes.push('Produktdaten ergaenzt (Repair-Hook)');
                  results.push({
                    productId: id,
                    ok: false,
                    status: perProductStatus,
                    reason: perProductReason,
                    fixes: perProductFixes,
                    repaired: true,
                  });
                  continue;
                }
              } catch (_) { /* swallow — repair is best-effort */ }
            }
            perProductFixes.push('Produktdaten bei Kaufland eingereicht (asynchrone Verarbeitung)');
            perProductStatus = 'pending';
            perProductReason = publishErr.message;
            results.push({
              productId: id,
              ok: false,
              status: perProductStatus,
              reason: perProductReason,
              fixes: perProductFixes,
            });
          } else {
            perProductStatus = 'failed';
            perProductReason = publishErr.message || 'Publish fehlgeschlagen';
            results.push({ productId: id, ok: false, status: perProductStatus, error: perProductReason });
          }
        }
      } catch (err) {
        perProductStatus = 'failed';
        perProductReason = err.message || 'Unbekannter Fehler';
        results.push({ productId: id, ok: false, status: perProductStatus, error: perProductReason });
      } finally {
        if (runId && audit) {
          await audit.appendResult({
            runId,
            productId: id,
            sku: perProductSku,
            ok: perProductOk,
            status: perProductStatus,
            reason: perProductReason,
            fixes: perProductFixes,
            idUnit: perProductIdUnit,
            durationMs: Date.now() - startedAt,
            repaired: perProductRepaired,
          }).catch(() => null);
        }
        // Listing-Fehler pro Produkt festhalten/löschen (Cockpit). Nur harte
        // Fehler/Skips; 'pending'/'pending-repaired' sind asynchron unterwegs.
        if (perProductOk) {
          await clearKauflandListingError(id).catch(() => null);
          await clearKauflandPublishPending(id).catch(() => null);
        } else if (perProductStatus === 'failed' || perProductStatus === 'skipped') {
          await persistKauflandListingError(id, perProductReason || 'Publish fehlgeschlagen').catch(() => null);
        }
      }
    }
    const published = results.filter((r) => r.ok && r.status === 'published').length;
    const fixed = results.filter((r) => r.ok && r.status === 'fixed').length;
    const pending = results.filter((r) => r.status === 'pending' || r.status === 'pending-repaired').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const success = published + fixed;

    // Audit-Run abschließen — best-effort
    if (runId && audit) {
      await audit.finalizeRun({
        runId,
        summary: {
          total: productIds.length,
          success,
          failed,
          fixed,
          pending,
          skipped,
          repaired: repairedCount,
        },
      }).catch(() => null);
    }

    return res.status(200).json({
      ok: true,
      data: {
        summary: { total: productIds.length, success, published, fixed, pending, skipped, failed, repaired: repairedCount },
        results,
        auditRunId: runId || null,
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

// ── Kaufland: List recent publish runs (Deliverable 5) ──────────────
router.get('/kaufland/publish-runs', requirePermission('products', 'read'), async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    let q = firestore.collection('kaufland_publish_runs').orderBy('startedAt', 'desc').limit(limit);
    if (req.user?.tenantId) q = q.where('tenantId', '==', req.user.tenantId);
    const snap = await q.get();
    const runs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, data: runs });
  } catch (err) {
    console.error(`[GET /api/kaufland/publish-runs] ${err.message}`, err);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: err.message } });
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
