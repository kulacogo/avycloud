const path = require('path');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');
const { firestore, getAllProducts, getAllProductsForTenant, getProduct } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { ensurePriceCoverage } = require('./enrichment');
const { applyEnrichmentToProduct } = require('./content-enrich-runner');
const { coerceTitleToPolicy, validateTitleToPolicy, inferTitleCategory } = require('../lib/title-policy');
const { getRulebookConfigCached } = require('../lib/rulebook-config');
const { fetchCategoryTitleInsights } = require('../lib/ebay-browse-title-insights');
const fs = require('fs');
const { uploadJobFile } = require('../lib/storage');
const {
  findUnit,
  createUnit,
  updateUnit,
  pickUnitData,
  getUnit,
  getProductData,
  getProductDataStatus,
  putProductData,
  patchProductData,
} = require('../lib/kaufland-api');
const {
  tryRepairKauflandProductData,
  buildKauflandProductDataAttributes,
  buildKauflandComplianceContact,
} = require('./kaufland-product-data-repair');

const normalizeBucketName = (raw) => {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return '';
  return s.replace(/^gs:\/\//i, '').replace(/\/+$/, '').trim();
};
const EXPORT_BUCKET = normalizeBucketName(process.env.STORAGE_BUCKET) || 'prodsandjobs';

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

const TITLE_INSIGHTS_ALLOWED_HINT_TOKEN_RE = /^[0-9a-zA-ZäöüÄÖÜß+\-_/().]{2,24}$/;

function normalizeTitleHintToken(raw) {
  const token = safeString(raw)
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!token) return '';
  return token.normalize('NFKC');
}

function isValidTitleHintToken(token) {
  if (!token) return false;
  if (!TITLE_INSIGHTS_ALLOWED_HINT_TOKEN_RE.test(token)) return false;
  // Skip likely barcode/EAN fragments in hints.
  if (/^\d{8,14}$/.test(token)) return false;
  // Skip explicit marketplace labels.
  if (/^(ean|gtin|upc|isbn)$/i.test(token)) return false;
  return true;
}

function collectEbayCategoryIdCandidates(product) {
  const attrs = product?.details?.attributes;
  const attrCategoryId =
    attrs && typeof attrs === 'object'
      ? safeString(
          attrs.ebay_category_id ||
            attrs.ebayCategoryId ||
            attrs.ebay_category ||
            attrs.ebayCategory ||
            attrs.category_id ||
            attrs.categoryId ||
            attrs.eBayCategoryId ||
            attrs.eBayCategoryID
        )
      : '';
  const details = product?.details || {};
  const identification = product?.identification || {};
  return [
    safeString(details.categoryId),
    safeString(details.ebayCategoryId),
    safeString(details.eBayCategoryId),
    safeString(identification.ebayCategoryId),
    safeString(identification.eBayCategoryId),
    safeString(identification.categoryId),
    attrCategoryId,
  ].filter(Boolean);
}

function daysSinceIso(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

function parseBool(v, def = false) {
  if (typeof v === 'boolean') return v;
  const s = String(v || '').trim().toLowerCase();
  if (!s) return def;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n') return false;
  return def;
}

function chunkArray(arr, chunkSize) {
  const out = [];
  const s = Math.max(1, Math.min(500, Number(chunkSize) || 200));
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s));
  return out;
}

function buildMarketplaceLookup() {
  const EBAY_CATEGORY_CSV = path.join(__dirname, '..', 'ebay', 'DE_New_Structure_(May2023).csv');
  const KAUFLAND_CATEGORY_CSV = path.join(__dirname, '..', 'kaufland', 'category_tree_all_languages.csv');
  return new MarketplaceLookup({
    ebayCsvPath: EBAY_CATEGORY_CSV,
    kauflandCsvPath: KAUFLAND_CATEGORY_CSV,
    ebayPathColumn: 'category_path',
    kauflandPathColumn: 'category_path',
  });
}

function isNumericId(id) {
  return id !== undefined && id !== null && /^\d+$/.test(String(id).trim());
}

function normalizePath(value) {
  if (!value) return null;
  return value.toString().trim();
}

function normalizeHsnTsn(raw) {
  const s = safeString(raw);
  if (!s) return '';
  // common formats: "0588 AFK", "0588/AFK", "HSN:0588 TSN:AFK"
  const m = s.match(/\b(\d{4})\b[^\p{L}\p{N}]+([a-z0-9]{3})\b/i);
  if (!m) return '';
  return `${m[1]}|${m[2].toUpperCase()}`;
}

function extractHsnTsnCandidates(text = '') {
  const s = String(text || '');
  const out = new Set();
  const push = (hsn, tsn) => {
    const h = String(hsn || '').trim();
    const t = String(tsn || '').trim().toUpperCase();
    if (!/^\d{4}$/.test(h)) return;
    if (!/^[A-Z0-9]{3}$/.test(t)) return;
    out.add(`${h}|${t}`);
  };
  // Strict extraction only: require explicit HSN and TSN labels nearby.
  const re2 = /\bHSN\b[^0-9]{0,40}(\d{4}).{0,120}?\bTSN\b[^A-Z0-9]{0,40}([A-Z0-9]{3})\b/gi;
  let m;
  while ((m = re2.exec(s)) !== null) {
    push(m[1], m[2]);
  }
  return Array.from(out);
}

function pickKTypeKey(attrs) {
  if (!attrs || typeof attrs !== 'object') return null;
  const keys = Object.keys(attrs);
  return keys.find((k) => ['k-typ', 'ktyp', 'k typ', 'ktyp id', 'ktypids', 'k-typ id'].includes(String(k).trim().toLowerCase())) || null;
}

function loadMvlIndex(jsonlPath) {
  const text = fs.readFileSync(jsonlPath, 'utf8');
  const byHsnTsn = new Map(); // "0588|AFK" -> Set<ktype>
  const lines = text.split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    const rec = JSON.parse(s);
    const k = Number(rec?.k);
    if (!Number.isFinite(k)) continue;
    const raw = safeString(rec?.hsn_tsn);
    if (!raw) continue;
    // MVL may contain multiple pairs separated by "<>"
    const parts = raw.split('<>').map((p) => normalizeHsnTsn(p)).filter(Boolean);
    for (const h of parts) {
      const set = byHsnTsn.get(h) || new Set();
      set.add(k);
      byHsnTsn.set(h, set);
    }
  }
  return { byHsnTsn };
}

function getMvlPath() {
  const env = safeString(process.env.MVL_JSONL);
  if (env && fs.existsSync(env)) return env;
  const fallback = path.join(process.cwd(), 'exports', 'DE_MVL_2025_10.compact.jsonl');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

async function resolveTargetProducts({ productIds, limit, offset, tenantId }) {
  const ids = Array.isArray(productIds) ? Array.from(new Set(productIds.map((x) => safeString(x)).filter(Boolean))) : [];
  if (ids.length) {
    const selected = ids.slice(0, Math.max(1, limit || ids.length));
    const out = [];
    for (const id of selected) {
      const p = await getProduct(String(id));
      if (p?.id) out.push(p);
    }
    return out;
  }
  // D.0b — Prefer tenant-scoped read when payload carries tenantId. Falls
  // back to getAllProducts() for callers that have not yet been migrated
  // (TODO D.0c: must iterate over all tenants before flipping the legacy
  // helper to throw).
  const products = tenantId
    ? await getAllProductsForTenant(tenantId)
    : await getAllProducts();
  const list = Array.isArray(products) ? products.filter((p) => p?.id) : [];
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Number(limit) || 500);
  return list.slice(off, off + lim);
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function pickImages(p, limit = 10) {
  const imgs = Array.isArray(p?.details?.images) ? p.details.images : [];
  const urls = [];
  for (const img of imgs) {
    const u = safeString(img?.url_or_base64 || img?.url || img?.href || '');
    if (!u) continue;
    if (/^data:/i.test(u)) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    urls.push(u);
    if (urls.length >= limit) break;
  }
  return urls;
}

function pickKTypeValue(p) {
  const attrs = p?.details?.attributes && typeof p.details.attributes === 'object' ? p.details.attributes : {};
  const key = Object.keys(attrs).find((k) =>
    ['k-typ', 'ktyp', 'k typ', 'ktyp id', 'ktypids', 'k-typ id'].includes(String(k).trim().toLowerCase())
  );
  return key ? safeString(attrs[key]) : '';
}

async function runExportMarketplace({ jobId, productIds = null, limit = 500, offset = 0, debug = false, tenantId = null } = {}) {
  if (!jobId) {
    throw new Error('export_marketplace requires jobId');
  }
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });
  const rows = [];

  for (const p of selected) {
    const id = safeString(p?.id);
    const cur = id ? await getProduct(id) : p;
    if (!cur) continue;

    const ids = cur?.details?.identifiers || {};
    const lp = cur?.details?.pricing?.lowest_price || {};
    const gpsr = cur?.details?.gpsr || {};
    const attrs = cur?.details?.attributes && typeof cur.details.attributes === 'object' ? cur.details.attributes : {};
    const images = pickImages(cur, 12);
    const qty = Number(cur?.inventory?.quantity || 0);
    const bin = safeString(cur?.storage?.binCode) || '';

    rows.push({
      product_id: id,
      sku: safeString(cur?.identification?.sku) || safeString(ids?.sku) || '',
      ean: safeString(ids?.ean) || '',
      gtin: safeString(ids?.gtin) || '',
      upc: safeString(ids?.upc) || '',
      mpn: safeString(ids?.mpn) || safeString(attrs?.Herstellernummer) || safeString(attrs?.mpn) || '',
      title: safeString(cur?.identification?.name) || '',
      brand: safeString(cur?.identification?.brand) || '',
      category_breadcrumb: safeString(cur?.identification?.category) || '',
      ebayCategoryId: safeString(cur?.details?.ebayCategoryId) || '',
      ebayCategoryPath: safeString(cur?.details?.ebayCategoryPath) || '',
      kauflandCategoryId: safeString(cur?.details?.kauflandCategoryId) || '',
      kauflandCategoryPath: safeString(cur?.details?.kauflandCategoryPath) || '',
      price_amount: typeof lp?.amount === 'number' && Number.isFinite(lp.amount) ? String(lp.amount) : '',
      price_currency: safeString(lp?.currency) || 'EUR',
      price_confidence:
        cur?.details?.pricing?.price_confidence != null ? String(cur.details.pricing.price_confidence) : '',
      price_last_checked_iso: safeString(lp?.last_checked_iso) || '',
      qty: Number.isFinite(qty) ? String(qty) : '',
      bin,
      storageBins_json: Array.isArray(cur?.storageBins) ? JSON.stringify(cur.storageBins) : '',
      images_primary: images[0] || '',
      images_all: images.join('|'),
      gpsr_entity_country: safeString(gpsr?.entity_country) || '',
      gpsr_manufacturer_name: safeString(gpsr?.manufacturer_name) || '',
      gpsr_manufacturer_address: safeString(gpsr?.manufacturer_address) || '',
      gpsr_manufacturer_city: safeString(gpsr?.manufacturer_city) || '',
      gpsr_manufacturer_postalcode: safeString(gpsr?.manufacturer_postalcode) || '',
      gpsr_manufacturer_state_province: safeString(gpsr?.manufacturer_state_province) || '',
      gpsr_email: safeString(gpsr?.email) || '',
      gpsr_manufacturer_phone: safeString(gpsr?.manufacturer_phone) || '',
      gpsr_url: safeString(gpsr?.url) || '',
      ktyp: pickKTypeValue(cur),
      attributes_json: JSON.stringify(attrs || {}),
    });
  }

  const headers = Object.keys(rows[0] || { product_id: '' });
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h] ?? '')).join(','))].join('\n');

  const json = JSON.stringify(
    {
      meta: { exported_at: nowIso(), count: rows.length, debug: Boolean(debug) },
      rows,
    },
    null,
    2
  );

  const csvMeta = await uploadJobFile(Buffer.from(csv, 'utf8'), 'text/csv', jobId, 'marketplace-export.csv');
  const jsonMeta = await uploadJobFile(Buffer.from(json, 'utf8'), 'application/json', jobId, 'marketplace-export.json');

  const toUrl = (m) => `https://storage.googleapis.com/${EXPORT_BUCKET}/${m.path}`;

  return {
    summary: { action: 'export_marketplace', selected: rows.length },
    files: [
      { ...csvMeta, url: toUrl(csvMeta) },
      { ...jsonMeta, url: toUrl(jsonMeta) },
    ],
  };
}

async function runBulkPrice({ apply = false, limit = 500, offset = 0, maxAgeDays = 0, force = false, debug = false, productIds = null, tenantId = null } = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const summary = {
    action: 'price',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    updated: 0,
    skipped_fresh: 0,
    skipped_has_price: 0,
    missing: 0,
    failed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      const lp = cur?.details?.pricing?.lowest_price || {};
      const hasPrice =
        typeof lp.amount === 'number' && Number.isFinite(lp.amount) && lp.amount > 0 && Array.isArray(lp.sources) && lp.sources.length > 0;
      const stale = maxAgeDays > 0 && daysSinceIso(lp.last_checked_iso) > maxAgeDays;
      if (!force && hasPrice && !stale) {
        summary.skipped_fresh += 1;
        continue;
      }
      if (hasPrice) summary.skipped_has_price += 1;

      const before = JSON.stringify(cur?.details?.pricing?.lowest_price || {});
      const serpTrace = [];
      // ensurePriceCoverage is opt-in via env flags; we still call it (no-op if disabled)
      await ensurePriceCoverage([cur], serpTrace, { force, maxAgeDays });
      const afterObj = cur?.details?.pricing?.lowest_price || {};
      const after = JSON.stringify(afterObj);
      const hasNow =
        typeof afterObj.amount === 'number' && Number.isFinite(afterObj.amount) && afterObj.amount > 0 && Array.isArray(afterObj.sources) && afterObj.sources.length > 0;

      if (!hasNow) {
        summary.missing += 1;
        if (debug && samples.length < 10) {
          samples.push({ id, sku, status: 'no_price', serpTrace: serpTrace.slice(0, 2) });
        }
        continue;
      }

      const changed = before !== after;
      if (apply && changed) {
        cur.ops = cur.ops || {};
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.price_bulk_v1 = {
          at_iso: nowIso(),
          maxAgeDays: Number(maxAgeDays) || 0,
        };
        await saveProductV2(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
      }
      if (changed) summary.updated += 1;

      if (!apply && samples.length < 15) {
        samples.push({ id, sku, amount: afterObj.amount, sources: (afterObj.sources || []).slice(0, 2) });
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  return { summary, samples };
}

async function runBulkTitle({
  apply = false,
  limit = 500,
  offset = 0,
  includeUi = false,
  debug = false,
  productIds = null,
  titleInsights = true,
  titleInsightsQuery = '',
  titleInsightsForceRefresh = false,
  titleInsightsLimit = 80,
  titleInsightsMaxHints = 8,
  marketplaceId = '',
  tenantId = null,
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });
  const useTitleInsights = parseBool(titleInsights, true);
  const insightsForceRefresh = parseBool(titleInsightsForceRefresh, false);
  const insightsQuery = safeString(titleInsightsQuery);
  const insightsLimit = Math.max(10, Math.min(200, Number(titleInsightsLimit) || 80));
  const insightsMaxHints = Math.max(0, Math.min(20, Number(titleInsightsMaxHints) || 8));
  const requestedMarketplaceId = safeString(marketplaceId);
  const categoryInsightCache = new Map();

  const summary = {
    action: 'title',
    apply: Boolean(apply),
    limit,
    offset,
    includeUi: Boolean(includeUi),
    selected: selected.length,
    considered: 0,
    updated: 0,
    skipped_ui: 0,
    noop: 0,
    invalid_after: 0,
    failed: 0,
    titleInsights: useTitleInsights,
    titleInsightsUsed: 0,
    titleInsightsMissingCategory: 0,
    titleInsightsFetchFailed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;

      const lastSource = safeString(cur?.ops?.last_saved_source) || 'unknown';
      if (!includeUi && lastSource === 'ui') {
        summary.skipped_ui += 1;
        continue;
      }
      summary.considered += 1;

      const currentTitle = safeString(cur?.identification?.name);
      const cfg = getRulebookConfigCached();
      const bucket = inferTitleCategory(cur);
      const bySchema = cfg?.title?.rulesBySchema && typeof cfg.title.rulesBySchema === 'object' ? cfg.title.rulesBySchema : {};
      const rule = (bySchema && bySchema[bucket]) || cfg?.title || {};
      const minLen = Number(rule?.minLen || 65);
      const softMaxLen = Number(rule?.softMaxLen || 75);
      const maxLen = Number(rule?.maxLen || 80);
      const mobileMaxLen = Number(rule?.mobileMaxLen || 60);

      const beforeIssues = validateTitleToPolicy(cur, currentTitle, { maxLen, mobileMaxLen }) || [];
      if (!Array.isArray(beforeIssues) || beforeIssues.length === 0) {
        summary.noop += 1;
        continue;
      }

      let insightTokens = [];
      let insightCategoryId = '';
      if (useTitleInsights && insightsMaxHints > 0) {
        const categoryCandidates = collectEbayCategoryIdCandidates(cur);
        insightCategoryId = categoryCandidates.find(Boolean) || '';
        if (!insightCategoryId) {
          summary.titleInsightsMissingCategory += 1;
        } else {
          const cacheKey = [insightCategoryId, insightsQuery, requestedMarketplaceId, String(insightsLimit)].join('|');
          if (!categoryInsightCache.has(cacheKey)) {
            try {
              const insights = await fetchCategoryTitleInsights({
                categoryId: insightCategoryId,
                query: insightsQuery,
                marketplaceId: requestedMarketplaceId || undefined,
                limit: insightsLimit,
                forceRefresh: insightsForceRefresh,
              });
              const topTokensRaw = Array.isArray(insights?.topTokens) ? insights.topTokens : [];
              const normalizedTokens = topTokensRaw
                .map((entry) => {
                  if (typeof entry === 'string') return entry;
                  if (entry && typeof entry === 'object') return safeString(entry.token || entry.value || entry.word);
                  return '';
                })
                .map(normalizeTitleHintToken)
                .filter(isValidTitleHintToken);
              const deduped = [];
              const seen = new Set();
              for (const token of normalizedTokens) {
                const key = token.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                deduped.push(token);
              }
              categoryInsightCache.set(cacheKey, deduped);
            } catch (insightError) {
              summary.titleInsightsFetchFailed += 1;
              categoryInsightCache.set(cacheKey, []);
              if (debug && samples.length < 10) {
                samples.push({
                  id,
                  sku,
                  status: 'title_insight_error',
                  categoryId: insightCategoryId,
                  message: insightError?.message || String(insightError),
                });
              }
            }
          }
          insightTokens = (categoryInsightCache.get(cacheKey) || []).slice(0, insightsMaxHints);
        }
      }

      const nextTitle = coerceTitleToPolicy(cur, currentTitle, {
        minLen: 0,
        maxLen,
        softMaxLen,
        extraHintTokens: insightTokens,
        forcePolicy: false,
      });
      const nextLen = safeString(nextTitle).length;
      const afterIssues = validateTitleToPolicy(cur, nextTitle, { maxLen, mobileMaxLen }) || [];
      if (!nextTitle || nextLen === 0 || nextLen > 80) {
        summary.invalid_after += 1;
        if (debug && samples.length < 10) {
          samples.push({
            id,
            sku,
            status: 'invalid_after',
            before: currentTitle,
            after: nextTitle,
            beforeIssues,
            afterIssues,
            categoryId: insightCategoryId,
            insightTokens,
          });
        }
        continue;
      }

      if (nextTitle === currentTitle) {
        summary.noop += 1;
        continue;
      }

      if (apply) {
        cur.identification = { ...(cur.identification || {}), name: nextTitle };
        cur.ops = cur.ops || {};
        cur.ops.last_saved_source = 'admin-bulk-title-v2';
        cur.ops.last_saved_iso = nowIso();
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.title_policy_v3 = {
          iso: nowIso(),
          before: currentTitle,
          after: nextTitle,
          before_issues: beforeIssues,
          after_issues: afterIssues,
          categoryId: insightCategoryId,
          insight_tokens: insightTokens,
          insights_enabled: useTitleInsights,
        };
        await saveProductV2(cur, { source: 'admin-bulk', skipKeyFeaturesNormalize: true });
      }
      summary.updated += 1;
      if (insightTokens.length > 0) summary.titleInsightsUsed += 1;
      if (!apply && samples.length < 15) {
        samples.push({ id, sku, before: currentTitle, after: nextTitle, beforeIssues, afterIssues, categoryId: insightCategoryId, insightTokens });
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  return { summary, samples };
}

function cleanupTitleTrailingDash(rawTitle = '') {
  const original = typeof rawTitle === 'string' ? rawTitle : rawTitle == null ? '' : String(rawTitle);
  let t = original.replace(/\s+/g, ' ').trim();
  if (!t) return { title: '', changed: false };
  // Remove trailing dash variants (hyphen-minus, en/em dash, non-breaking hyphen) + surrounding spaces.
  t = t.replace(/[\s\u00A0]*[-–—‑]+[\s\u00A0]*$/g, '').trim();
  t = t.replace(/\s+/g, ' ').trim();
  return { title: t, changed: t !== original };
}

async function runBulkTitleTrailingDashFix({
  apply = false,
  limit = 500,
  offset = 0,
  debug = false,
  productIds = null,
  inventoryId = null,
  tenantId = null,
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const summary = {
    action: 'title_trailing_dash_fix',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    considered: 0,
    updated: 0,
    invalid_after: 0,
    noop: 0,
    failed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      summary.considered += 1;
      const currentTitle = safeString(cur?.identification?.name);
      if (!currentTitle) {
        summary.noop += 1;
        continue;
      }
      const cleaned = cleanupTitleTrailingDash(currentTitle);
      const nextTitle = cleaned.title;
      if (!nextTitle) {
        summary.invalid_after += 1;
        if (debug && samples.length < 10) samples.push({ id, sku, status: 'invalid_after', before: currentTitle, after: nextTitle });
        continue;
      }
      if (nextTitle === currentTitle) {
        summary.noop += 1;
        continue;
      }

      if (apply) {
        cur.identification = { ...(cur.identification || {}), name: nextTitle };
        cur.ops = cur.ops || {};
        cur.ops.last_saved_source = 'admin-bulk-title-trailing-dash-v1';
        cur.ops.last_saved_iso = nowIso();
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.title_trailing_dash_v1 = {
          at_iso: nowIso(),
          before: currentTitle,
          after: nextTitle,
        };
        await saveProductV2(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true, overwriteTextFields: true });
      }

      summary.updated += 1;
      if (!apply && samples.length < 15) samples.push({ id, sku, before: currentTitle, after: nextTitle });
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  return { summary, samples };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeBulletLine(line) {
  const s = String(line || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!s) return '';
  // Remove common bullet prefixes.
  return s.replace(/^[•·*\-–—]+\s*/g, '').replace(/\s+/g, ' ').trim();
}

function buildHighlightsHtmlFromLines(lines = [], { maxChars = 3500 } = {}) {
  const items = (Array.isArray(lines) ? lines : [lines])
    .map((l) => normalizeBulletLine(l))
    .filter(Boolean);
  if (!items.length) return { html: '', itemCount: 0 };
  const chosen = [];
  let currentLen = '<ul></ul>'.length;
  for (const item of items) {
    const li = `<li>${escapeHtml(item)}</li>`;
    if (currentLen + li.length > maxChars && chosen.length > 0) break;
    if (currentLen + li.length > maxChars && chosen.length === 0) {
      // still include a single truncated item (keeps valid HTML)
      const maxInner = Math.max(10, maxChars - '<ul><li></li></ul>'.length);
      const truncated = escapeHtml(item).slice(0, maxInner).trim();
      chosen.push(truncated || escapeHtml(item).slice(0, Math.max(10, maxInner)));
      currentLen = maxChars;
      break;
    }
    chosen.push(item);
    currentLen += li.length;
  }
  const html = `<ul>${chosen.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
  return { html, itemCount: chosen.length };
}

async function runBulkHighlightsHtml({
  apply = false,
  limit = 500,
  offset = 0,
  debug = false,
  productIds = null,
  inventoryId = null,
  tenantId = null,
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const summary = {
    action: 'highlights_html',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    considered: 0,
    updated: 0,
    noop: 0,
    invalid_after: 0,
    failed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      summary.considered += 1;

      const existing = safeString(cur?.details?.description_extra1 || cur?.details?.descriptionExtra1);
      const alreadyHtml = /<\s*ul\b/i.test(existing) && /<\s*li\b/i.test(existing);
      if (alreadyHtml) {
        summary.noop += 1;
        continue;
      }

      const features = Array.isArray(cur?.details?.key_features) ? cur.details.key_features : [];
      const built = buildHighlightsHtmlFromLines(features, { maxChars: 3500 });
      if (!built.html) {
        summary.invalid_after += 1;
        if (debug && samples.length < 10) samples.push({ id, sku, status: 'no_key_features' });
        continue;
      }

      if (apply) {
        cur.details = cur.details || {};
        cur.details.description_extra1 = built.html;
        cur.ops = cur.ops || {};
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.highlights_html_v1 = { at_iso: nowIso(), itemCount: built.itemCount };
        await saveProductV2(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true, overwriteTextFields: true });
      }

      summary.updated += 1;
      if (!apply && samples.length < 15) {
        samples.push({ id, sku, itemCount: built.itemCount, preview: built.html.slice(0, 160) });
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  return { summary, samples };
}

function looksLikeHtml(text = '') {
  const s = String(text || '').trim();
  if (!s) return false;
  // Only treat as "already HTML" when structural/block tags are present.
  // Inline-only tags like <strong> were causing us to skip formatting (and leave one long blob).
  return /<\s*(p|br|ul|ol|li|div|h\d)\b/i.test(s);
}

function formatDescriptionToHtml(input = '') {
  const raw = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!raw) return '';

  const hasBlockTags = looksLikeHtml(raw);
  const hasInlineOnly =
    !hasBlockTags && /<\s*(strong|b|em|i|u|span)\b/i.test(raw) && /<\/\s*\w+\s*>/i.test(raw);

  const KEY_LABELS = [
    'Zustand',
    'Lieferumfang',
    'Kompatibilität',
    'Maße',
    'Details',
    'Hinweise',
  ];
  const keyRe = new RegExp(`^(${KEY_LABELS.map((k) => k.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('|')})\\s*:\\s*(.*)$`, 'i');

  const paragraphs = raw
    .split(/\n{2,}/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  for (const para of paragraphs) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    const bulletLines = lines.filter((l) => /^[•·*\-–—]\s+/.test(l));
    if (bulletLines.length >= Math.max(2, Math.ceil(lines.length / 2))) {
      const built = buildHighlightsHtmlFromLines(bulletLines, { maxChars: 9000 });
      if (built.html) out.push(built.html);
      continue;
    }

    // Label lines -> <p><strong>Label:</strong> rest</p>
    if (lines.length === 1) {
      const m = lines[0].match(keyRe);
      if (m) {
        const label = m[1];
        const rest = m[2] || '';
        if (hasInlineOnly) {
          out.push(
            `<p><strong>${escapeHtml(label)}:</strong> ${String(rest).trim()}</p>`.replace(/\s+<\/p>$/, '</p>')
          );
        } else {
          out.push(
            `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(rest).trim()}</p>`.replace(/\s+<\/p>$/, '</p>')
          );
        }
        continue;
      }
    }

    const joined = lines.join(' ');
    out.push(`<p>${hasInlineOnly ? joined : escapeHtml(joined)}</p>`);
  }

  // If block tags already exist, we still want to preserve them but avoid double-wrapping.
  // In that case just return as-is.
  if (hasBlockTags) return raw;
  return out.join('');
}

async function runBulkDescriptionHtml({
  apply = false,
  limit = 500,
  offset = 0,
  debug = false,
  productIds = null,
  inventoryId = null,
  tenantId = null,
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const summary = {
    action: 'description_html',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    considered: 0,
    updated: 0,
    noop: 0,
    invalid_after: 0,
    failed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      summary.considered += 1;

      const src =
        safeString(cur?.details?.short_description) ||
        safeString(cur?.details?.description) ||
        '';
      if (!src) {
        summary.invalid_after += 1;
        if (debug && samples.length < 10) samples.push({ id, sku, status: 'missing_description' });
        continue;
      }

      const next = formatDescriptionToHtml(src);
      if (!next) {
        summary.invalid_after += 1;
        if (debug && samples.length < 10) samples.push({ id, sku, status: 'invalid_after' });
        continue;
      }
      if (next === src) {
        summary.noop += 1;
        continue;
      }

      if (apply) {
        cur.details = cur.details || {};
        cur.details.short_description = next;
        cur.ops = cur.ops || {};
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.description_html_v1 = { at_iso: nowIso() };
        await saveProductV2(cur, { source: 'admin-bulk', overwriteTextFields: true, skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
      }

      summary.updated += 1;
      if (!apply && samples.length < 15) samples.push({ id, sku, before: src.slice(0, 120), after: next.slice(0, 120) });
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  return { summary, samples };
}

function normalizeAttrValue(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const v = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
    return v;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  // Keep objects/arrays as-is; Firestore saveProduct/enforceEbayAspects will stringify where appropriate.
  return value;
}

function normalizeAttributesForListing(attrsRaw = {}) {
  const attrs = attrsRaw && typeof attrsRaw === 'object' && !Array.isArray(attrsRaw) ? attrsRaw : {};
  const out = {};

  const dropKeysLower = new Set([
    'category_path',
    'category id',
    'category_id',
    'ebay_category_id',
    'ebay_category_path',
    'kaufland_category_id',
    'kaufland_category_path',
    'product_id',
    'id',
  ]);

  for (const [rawKey, rawVal] of Object.entries(attrs)) {
    const key = safeString(rawKey).replace(/\s+/g, ' ').trim();
    if (!key) continue;
    const keyLower = key.toLowerCase();
    if (dropKeysLower.has(keyLower)) continue;
    if (keyLower.startsWith('ebay_category')) continue;
    if (keyLower.startsWith('kaufland_category')) continue;
    if (keyLower.includes('category_path')) continue;
    if (keyLower.endsWith('_category_id')) continue;
    if (keyLower.endsWith('_category_path')) continue;

    const val = normalizeAttrValue(rawVal);
    // Drop empty strings
    if (typeof val === 'string' && !val.trim()) continue;
    out[key] = val;
  }
  return out;
}

async function runBulkListingReadiness({
  apply = false,
  limit = 500,
  offset = 0,
  debug = false,
  productIds = null,
  inventoryId = null,
  tenantId = null,
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const summary = {
    action: 'listing_readiness',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    considered: 0,
    updated: 0,
    noop: 0,
    invalid_after: 0,
    failed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      summary.considered += 1;

      const before = JSON.stringify({
        t: safeString(cur?.identification?.name),
        b: safeString(cur?.identification?.brand),
        d: safeString(cur?.details?.short_description || cur?.details?.description),
        x1: safeString(cur?.details?.description_extra1 || cur?.details?.descriptionExtra1),
        h: Array.isArray(cur?.details?.key_features) ? cur.details.key_features : [],
        a: cur?.details?.attributes && typeof cur.details.attributes === 'object' && !Array.isArray(cur.details.attributes) ? cur.details.attributes : {},
        c: safeString(cur?.details?.categoryId || cur?.details?.ebayCategoryId || ''),
      });

      // Title: remove trailing dash + normalize spaces
      const currentTitle = safeString(cur?.identification?.name);
      if (currentTitle) {
        const cleaned = cleanupTitleTrailingDash(currentTitle);
        if (cleaned.title && cleaned.title !== currentTitle) {
          cur.identification = { ...(cur.identification || {}), name: cleaned.title };
        }
      }

      // Description HTML
      const srcDesc =
        safeString(cur?.details?.short_description) || safeString(cur?.details?.description) || '';
      if (srcDesc && !looksLikeHtml(srcDesc)) {
        const formatted = formatDescriptionToHtml(srcDesc);
        if (formatted) {
          cur.details = cur.details || {};
          cur.details.short_description = formatted;
        }
      }

      // Highlights HTML into description_extra1 (preferred sync target)
      const existingExtra1 = safeString(cur?.details?.description_extra1 || cur?.details?.descriptionExtra1);
      const alreadyHtml = /<\s*ul\b/i.test(existingExtra1) && /<\s*li\b/i.test(existingExtra1);
      if (!alreadyHtml) {
        const features = Array.isArray(cur?.details?.key_features) ? cur.details.key_features : [];
        const built = buildHighlightsHtmlFromLines(features, { maxChars: 3500 });
        if (built?.html) {
          cur.details = cur.details || {};
          cur.details.description_extra1 = built.html;
        }
      }

      // Attributes: normalize obvious junk + whitespace; allow deletions by using replaceAttributes on save.
      const attrsNormalized = normalizeAttributesForListing(cur?.details?.attributes || {});
      cur.details = cur.details || {};
      cur.details.attributes = attrsNormalized;

      // Brand consistency: keep identification.brand in sync with attributes where possible.
      const brand = safeString(cur?.identification?.brand);
      const attrs = cur.details.attributes || {};
      const attrBrandKey =
        Object.keys(attrs).find((k) => String(k || '').trim().toLowerCase() === 'marke') ||
        Object.keys(attrs).find((k) => String(k || '').trim().toLowerCase() === 'hersteller') ||
        null;
      const attrBrandVal = attrBrandKey ? safeString(attrs[attrBrandKey]) : '';
      if (!brand && attrBrandVal) {
        cur.identification = { ...(cur.identification || {}), brand: attrBrandVal };
      } else if (brand && !attrBrandVal) {
        cur.details.attributes = { ...(cur.details.attributes || {}), Marke: brand };
      }

      const after = JSON.stringify({
        t: safeString(cur?.identification?.name),
        b: safeString(cur?.identification?.brand),
        d: safeString(cur?.details?.short_description || cur?.details?.description),
        x1: safeString(cur?.details?.description_extra1 || cur?.details?.descriptionExtra1),
        h: Array.isArray(cur?.details?.key_features) ? cur.details.key_features : [],
        a: cur?.details?.attributes && typeof cur.details.attributes === 'object' && !Array.isArray(cur.details.attributes) ? cur.details.attributes : {},
        c: safeString(cur?.details?.categoryId || cur?.details?.ebayCategoryId || ''),
      });

      if (before === after) {
        summary.noop += 1;
        continue;
      }

      // Guard: never allow empty title after changes
      if (!safeString(cur?.identification?.name)) {
        summary.invalid_after += 1;
        if (debug && samples.length < 10) samples.push({ id, sku, status: 'invalid_after_empty_title' });
        continue;
      }

      if (apply) {
        cur.ops = cur.ops || {};
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.listing_readiness_v1 = { at_iso: nowIso() };
        cur.ops.last_saved_source = 'admin-bulk-listing-readiness-v1';
        cur.ops.last_saved_iso = nowIso();
        await saveProductV2(cur, {
          source: 'admin-bulk',
          overwriteTextFields: true,
          replaceAttributes: true,
          // allow full normalization pipeline (aliases + required aspects) to run
          skipTitlePolicy: true,
        });
      }

      summary.updated += 1;
      if (!apply && samples.length < 15) samples.push({ id, sku, changed: true });
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  return { summary, samples };
}

async function runBulkCategory({ apply = false, limit = 500, offset = 0, debug = false, productIds = null, tenantId = null } = {}) {
  const lookup = buildMarketplaceLookup();
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const summary = {
    action: 'category',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    updated: 0,
    noop: 0,
    failed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      const details = cur.details || {};
      const attrs = details.attributes || {};
      const identCategory = normalizePath(cur?.identification?.category);
      const directIdCandidates = [
        details.categoryId,
        details.ebayCategoryId,
        attrs.ebay_category_id,
        attrs.ebayCategoryId,
        attrs['ebay.category_id'],
      ]
        .map((v) => safeString(v))
        .filter(Boolean);

      const pathCandidates = [
        normalizePath(details.ebayCategoryPath),
        normalizePath(details.ebayCategoryBreadcrumb),
        normalizePath(attrs.ebay_category_path),
        normalizePath(attrs.ebay_category),
        normalizePath(attrs['eBay Kategorie'] || attrs['eBay-Kategorie']),
        normalizePath(attrs.Kategorie),
        normalizePath(attrs.category),
        // free-text fallback only when it already looks like a real breadcrumb.
        identCategory && identCategory.includes('>')
          ? identCategory
          : '',
      ].filter(Boolean);

      let resolvedCategoryId = '';
      let resolvedSource = '';
      for (const candidate of directIdCandidates) {
        if (!isNumericId(candidate)) continue;
        if (!lookup.isValidEbayId(String(candidate).trim())) continue;
        resolvedCategoryId = String(candidate).trim();
        resolvedSource = 'direct_id';
        break;
      }

      if (!resolvedCategoryId) {
        for (const candidate of pathCandidates) {
          const byPath = lookup.lookupEbay(candidate);
          if (!byPath) continue;
          if (!lookup.isValidEbayId(String(byPath).trim())) continue;
          resolvedCategoryId = String(byPath).trim();
          resolvedSource = `path:${candidate.slice(0, 80)}`;
          break;
        }
      }

      if (!resolvedCategoryId) {
        summary.failed += 1;
        if (samples.length < 15) {
          samples.push({
            id,
            sku,
            status: 'no_valid_ebay_category',
            directIdCandidates: directIdCandidates.slice(0, 5),
            pathCandidates: pathCandidates.slice(0, 5),
          });
        }
        continue;
      }

      const canonical = findEbayCategory(resolvedCategoryId);
      const canonicalBreadcrumb = safeString(canonical?.breadcrumb || '');
      if (!canonicalBreadcrumb || !canonicalBreadcrumb.includes('>')) {
        summary.failed += 1;
        if (samples.length < 15) {
          samples.push({
            id,
            sku,
            status: 'resolved_category_not_canonical',
            resolvedCategoryId,
          });
        }
        continue;
      }

      const currentCategoryId = safeString(details.categoryId);
      const currentCategoryText = safeString(cur?.identification?.category);
      const hasLegacyFields = Boolean(
        details.ebayCategoryId ||
          details.ebayCategoryPath ||
          details.ebayCategoryBreadcrumb ||
          details.kauflandCategoryId ||
          details.kauflandCategoryPath
      );

      if (
        currentCategoryId === resolvedCategoryId &&
        currentCategoryText === canonicalBreadcrumb &&
        !hasLegacyFields
      ) {
        summary.noop += 1;
        continue;
      }

      summary.updated += 1;
      if (!apply && samples.length < 15) {
        samples.push({
          id,
          sku,
          resolvedSource,
          update: {
            'details.categoryId': resolvedCategoryId,
            'identification.category': canonicalBreadcrumb,
            cleanupLegacyCategoryFields: hasLegacyFields,
          },
        });
        continue;
      }

      if (apply) {
        const next = JSON.parse(JSON.stringify(cur));
        next.details = next.details || {};
        next.identification = next.identification || {};
        next.details.categoryId = resolvedCategoryId;
        next.identification.category = canonicalBreadcrumb;

        // Hard cleanup: prevent future drift from legacy marketplace fields.
        if (next.details.ebayCategoryId) delete next.details.ebayCategoryId;
        if (next.details.ebayCategoryPath) delete next.details.ebayCategoryPath;
        if (next.details.ebayCategoryBreadcrumb) delete next.details.ebayCategoryBreadcrumb;
        if (next.details.kauflandCategoryId) delete next.details.kauflandCategoryId;
        if (next.details.kauflandCategoryPath) delete next.details.kauflandCategoryPath;

        await saveProductV2(next, {
          source: 'admin-bulk-category-v2',
          allowCategoryChange: true,
        });
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }
  return { summary, samples };
}

/**
 * B3 — Bulk audit run "recategorize_v2".
 *
 * Iterates all (or a subset) of products, invokes category-resolver v2
 * (`resolveCategoryV2`), and optionally rewrites `details.categoryId` /
 * `details.categorySource` / `identification.category`.
 *
 * Safety mechanisms:
 *  - Default is DryRun (`apply: false`) — no product is written.
 *  - Pre-flight count guard: callers pass `expectedCount`; when the collection
 *    size diverges we abort before writing.
 *  - Post-flight count guard: re-check the collection size after the run.
 *  - Skip UI-edited products (`ops.last_saved_source === 'ui'`) unless
 *    `includeUi: true` is explicitly set.
 *  - Skip products with `details.categorySource === 'manual'`.
 *  - Reports (summary + per-product audit) are uploaded via `uploadJobFile`.
 */
// Data-integrity threshold: auto-apply only when the resolver is this confident.
// Mirrors STRATEGY_ACCEPT_THRESHOLD in backend/services/category-resolver.js so
// below-threshold "best candidate" fallbacks are never written to products.
const MIN_APPLY_CONFIDENCE = 0.8;

async function runBulkRecategorizeV2({
  apply = false,
  limit = 20000,
  offset = 0,
  productIds = null,
  includeUi = false,
  concurrency = 2,
  expectedCount = null,
  minConfidence = null,
  jobId = null,
  debug = false,
  tenantId = null,
} = {}) {
  const startedAt = Date.now();
  const PQueue = require('p-queue').default || require('p-queue');
  const conc = Math.max(1, Math.min(5, Number(concurrency) || 2));
  const queue = new PQueue({ concurrency: conc });
  const effectiveMinConfidence =
    Number.isFinite(Number(minConfidence)) && Number(minConfidence) > 0
      ? Math.min(1, Math.max(0, Number(minConfidence)))
      : MIN_APPLY_CONFIDENCE;

  // Pre-flight count guard — only enforced when applying and an expected
  // count was provided by the caller. Protects against runs scheduled for a
  // different tenant/dataset size.
  if (apply && typeof expectedCount === 'number' && Number.isFinite(expectedCount)) {
    // D.0b — When tenantId is present, use tenant-scoped count to avoid
    // false alarms across tenants. Fallback to legacy global count when
    // no tenantId is in scope.
    const all = tenantId ? await getAllProductsForTenant(tenantId) : await getAllProducts();
    const preCount = Array.isArray(all) ? all.length : 0;
    if (preCount !== expectedCount) {
      throw new Error(
        `Pre-flight count mismatch: expected ${expectedCount}, got ${preCount}`
      );
    }
  }

  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });
  const total = selected.length;

  const summary = {
    action: 'recategorize_v2',
    apply: Boolean(apply),
    limit,
    offset,
    includeUi: Boolean(includeUi),
    concurrency: conc,
    selected: total,
    updated: 0,
    would_update: 0,
    noop: 0,
    skipped_ui: 0,
    skipped_manual: 0,
    unresolved: 0,
    not_found: 0,
    failed: 0,
    durationMs: 0,
    dryRun: !apply,
  };
  const samples = [];
  const auditRows = [];

  let processed = 0;

  const maybeUpdateJob = async (patch) => {
    if (!jobId) return;
    try {
      const { updateJob } = require('../lib/admin-bulk-jobs');
      await updateJob(jobId, patch);
    } catch (err) {
      if (debug) console.warn('[recategorize_v2] updateJob failed:', err?.message || err);
    }
  };

  const resolverMod = require('./category-resolver');

  const workOne = async (p) => {
    const id = p?.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) {
        summary.not_found += 1;
        auditRows.push({ id, sku, status: 'not_found' });
        return;
      }

      // Skip UI-edited products unless explicitly included.
      if (!includeUi && cur?.ops?.last_saved_source === 'ui') {
        summary.skipped_ui += 1;
        auditRows.push({ id, sku, status: 'skipped_ui' });
        return;
      }

      // Skip manually categorised products — never auto-override.
      if (cur?.details?.categorySource === 'manual') {
        summary.skipped_manual += 1;
        auditRows.push({ id, sku, status: 'skipped_manual' });
        return;
      }

      const result = await resolverMod.resolveCategoryV2(cur, { reason: 'bulk-audit-v2' });
      if (!result || !result.categoryId || !result.breadcrumb) {
        summary.unresolved += 1;
        auditRows.push({
          id,
          sku,
          status: 'unresolved',
          log: Array.isArray(result?.log) ? result.log : undefined,
        });
        if (samples.length < 100) {
          samples.push({ id, sku, status: 'unresolved', log: result?.log });
        }
        return;
      }

      // Data-integrity guard: never overwrite an existing category with a
      // low-confidence resolver result. resolveCategoryV2 can return its
      // best-below-threshold candidate when no strategy cleared the accept
      // threshold — that must never be auto-applied.
      const confidence = Number(result.confidence) || 0;
      if (confidence < effectiveMinConfidence) {
        summary.low_confidence = (summary.low_confidence || 0) + 1;
        const row = {
          id,
          sku,
          status: 'low_confidence',
          confidence,
          threshold: effectiveMinConfidence,
          source: result.source,
          from: { id: safeString(cur?.details?.categoryId) || null, breadcrumb: safeString(cur?.identification?.category) || null },
          to: { id: String(result.categoryId), breadcrumb: String(result.breadcrumb) },
        };
        auditRows.push(row);
        if (samples.length < 100) samples.push(row);
        return;
      }

      const currentId = safeString(cur?.details?.categoryId);
      const currentBreadcrumb = safeString(cur?.identification?.category);
      if (currentId === String(result.categoryId) && currentBreadcrumb === String(result.breadcrumb)) {
        summary.noop += 1;
        auditRows.push({ id, sku, status: 'noop', categoryId: currentId });
        return;
      }

      const fromPayload = {
        id: currentId || null,
        breadcrumb: currentBreadcrumb || null,
      };
      const toPayload = {
        id: String(result.categoryId),
        breadcrumb: String(result.breadcrumb),
      };

      if (!apply) {
        summary.would_update += 1;
        const row = {
          id,
          sku,
          status: 'would_update',
          from: fromPayload,
          to: toPayload,
          source: result.source,
          confidence: result.confidence,
        };
        auditRows.push(row);
        if (samples.length < 100) samples.push(row);
        return;
      }

      // Apply mode — clone and rewrite.
      const next = JSON.parse(JSON.stringify(cur));
      next.details = next.details || {};
      next.details.categoryId = String(result.categoryId);
      next.details.categorySource = `auto:${result.source}`;
      next.identification = next.identification || {};
      next.identification.category = String(result.breadcrumb);

      // Hard cleanup — legacy marketplace fields would otherwise reintroduce
      // drift when the write path falls back to them.
      if (next.details.ebayCategoryId) delete next.details.ebayCategoryId;
      if (next.details.ebayCategoryPath) delete next.details.ebayCategoryPath;
      if (next.details.ebayCategoryBreadcrumb) delete next.details.ebayCategoryBreadcrumb;
      if (next.details.kauflandCategoryId) delete next.details.kauflandCategoryId;
      if (next.details.kauflandCategoryPath) delete next.details.kauflandCategoryPath;

      next.ops = next.ops || {};
      next.ops.data_quality = next.ops.data_quality || {};
      next.ops.data_quality.recategorize_v2 = {
        at_iso: new Date().toISOString(),
        from: fromPayload,
        to: toPayload,
        source: result.source,
        confidence: result.confidence,
      };

      await saveProductV2(next, {
        source: 'admin-bulk-recategorize-v2',
        allowCategoryChange: true,
      });
      summary.updated += 1;
      const row = {
        id,
        sku,
        status: 'updated',
        from: fromPayload,
        to: toPayload,
        source: result.source,
        confidence: result.confidence,
      };
      auditRows.push(row);
      if (samples.length < 100) samples.push(row);
    } catch (e) {
      summary.failed += 1;
      const msg = e?.message || String(e);
      auditRows.push({ id, sku, status: 'error', message: msg });
      if (samples.length < 100) samples.push({ id, sku, status: 'error', message: msg });
      if (debug) console.error(`[recategorize_v2] ${id}: ${msg}`);
    }
  };

  for (const p of selected) {
    queue.add(async () => {
      await workOne(p);
      processed += 1;
      if (processed % 10 === 0) {
        await maybeUpdateJob({
          stage: `processing ${processed}/${total}`,
          progress: {
            current: processed,
            total,
            updated: summary.updated,
            skipped: summary.skipped_ui + summary.skipped_manual,
          },
        });
      }
    });
  }

  await queue.onIdle();

  summary.durationMs = Date.now() - startedAt;

  // Upload reports BEFORE the post-flight count guard so audit trail survives
  // even if the guard throws afterwards. Failures here must not destroy the
  // summary — we log and continue so the caller still sees the in-memory result.
  const files = [];
  if (jobId) {
    try {
      const summaryBuf = Buffer.from(JSON.stringify(summary, null, 2), 'utf8');
      const summaryMeta = await uploadJobFile(
        summaryBuf,
        'application/json',
        jobId,
        'summary.json'
      );
      files.push(summaryMeta);
    } catch (err) {
      console.warn('[recategorize_v2] summary upload failed:', err?.message || err);
    }
    try {
      const auditName = apply ? 'apply_repairs.json' : 'dryrun_repairs.json';
      const auditBuf = Buffer.from(JSON.stringify(auditRows, null, 2), 'utf8');
      const auditMeta = await uploadJobFile(
        auditBuf,
        'application/json',
        jobId,
        auditName
      );
      files.push(auditMeta);
    } catch (err) {
      console.warn('[recategorize_v2] audit upload failed:', err?.message || err);
    }
  }

  // Post-flight count guard — ensure we did not accidentally trigger deletes.
  // Tolerance allows for concurrent creates during the run (realistic in prod).
  if (apply && typeof expectedCount === 'number' && Number.isFinite(expectedCount)) {
    // D.0b — Match pre-flight read scope to keep counts apples-to-apples.
    const after = tenantId ? await getAllProductsForTenant(tenantId) : await getAllProducts();
    const postCount = Array.isArray(after) ? after.length : 0;
    const COUNT_DELTA_TOLERANCE = 10;
    if (Math.abs(postCount - expectedCount) > COUNT_DELTA_TOLERANCE) {
      throw new Error(
        `Post-flight count mismatch: expected ≈${expectedCount} (±${COUNT_DELTA_TOLERANCE}), got ${postCount}`
      );
    }
    if (postCount !== expectedCount) {
      summary.post_count_delta = postCount - expectedCount;
    }
  }

  return {
    summary,
    samples: samples.slice(0, 100),
    files,
  };
}

async function runBulkKType({ apply = false, limit = 500, offset = 0, debug = false, productIds = null, tenantId = null } = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const summary = {
    action: 'ktype',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    updated: 0,
    skipped_already_set: 0,
    skipped_not_auto: 0,
    skipped_no_hsn_tsn: 0,
    skipped_no_mvl: 0,
    failed: 0,
  };
  const samples = [];

  const mvlPath = getMvlPath();
  if (!mvlPath) {
    summary.skipped_no_mvl = selected.length;
    return {
      summary,
      samples: [
        {
          status: 'no_mvl',
          message: 'MVL_JSONL not configured (and default exports/DE_MVL_2025_10.compact.jsonl not present). K‑Typ enrichment skipped.',
        },
      ],
    };
  }

  const mvl = loadMvlIndex(mvlPath);

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;

      const catId = safeString(cur?.details?.categoryId || cur?.details?.ebayCategoryId || '');
      // Only attempt for fitment categories (same rule as existing scripts).
      let isAuto = false;
      try {
        const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
        isAuto = Boolean(catId && getVehicleFitmentMode(String(catId)));
      } catch {
        isAuto = false;
      }
      if (!isAuto) {
        summary.skipped_not_auto += 1;
        continue;
      }

      const attrs = cur?.details?.attributes && typeof cur.details.attributes === 'object' ? cur.details.attributes : {};
      const kKey = pickKTypeKey(attrs);
      if (kKey && safeString(attrs[kKey])) {
        summary.skipped_already_set += 1;
        continue;
      }

      const blob = [
        safeString(cur?.identification?.name),
        safeString(cur?.identification?.brand),
        safeString(cur?.details?.identifiers?.mpn),
        JSON.stringify(attrs || {}),
      ].filter(Boolean).join(' ');

      const candidates = extractHsnTsnCandidates(blob);
      if (!candidates.length) {
        summary.skipped_no_hsn_tsn += 1;
        continue;
      }

      const hits = new Set();
      for (const c of candidates) {
        const set = mvl.byHsnTsn.get(c);
        if (!set) continue;
        for (const k of set) hits.add(k);
      }
      if (!hits.size) {
        summary.skipped_no_hsn_tsn += 1;
        continue;
      }

      const chosen = Array.from(hits).sort((a, b) => a - b)[0];
      const nextAttrs = { ...(attrs || {}) };
      nextAttrs['K-Typ'] = String(chosen);
      nextAttrs['HSN/TSN'] = nextAttrs['HSN/TSN'] || candidates[0];

      if (apply) {
        cur.details = cur.details || {};
        cur.details.attributes = nextAttrs;
        cur.ops = cur.ops || {};
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.ktype_bulk_v1 = { at_iso: nowIso(), source: 'mvl_hsn_tsn', hsn_tsn: candidates[0] };
        await saveProductV2(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
      }
      summary.updated += 1;
      if (debug && samples.length < 15) {
        samples.push({ id, sku, ktype: String(chosen), hsnTsn: candidates[0] });
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  return { summary, samples };
}

function formatKauflandApiError(error) {
  const base = safeString(error?.message) || String(error || 'Unknown Kaufland error');
  const status = Number(error?.status);
  const payloadErrors = Array.isArray(error?.payload?.errors) ? error.payload.errors : [];
  const fieldErrors = payloadErrors
    .slice(0, 5)
    .map((entry) => {
      const field = safeString(entry?.field);
      const message = safeString(entry?.message);
      if (!field && !message) return '';
      return field ? `${field}: ${message || 'invalid'}` : message;
    })
    .filter(Boolean);
  const prefix = Number.isFinite(status) && status > 0 ? `[HTTP ${status}] ` : '';
  if (!fieldErrors.length) return `${prefix}${base}`;
  return `${prefix}${base} (${fieldErrors.join('; ')})`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function stripHtmlToPlainText(input) {
  const raw = safeString(input);
  if (!raw) return '';
  return raw
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKauflandAttributeToken(value) {
  return safeString(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s._:;,\-/\\()[\]{}]+/g, '');
}

const KAUFLAND_COUNTRY_CODE_FALLBACK = {
  germany: 'DE',
  deutschland: 'DE',
  austria: 'AT',
  osterreich: 'AT',
  'österreich': 'AT',
  poland: 'PL',
  polen: 'PL',
  france: 'FR',
  frankreich: 'FR',
  italy: 'IT',
  italien: 'IT',
  czechia: 'CZ',
  'czech republic': 'CZ',
  tschechien: 'CZ',
  slovakia: 'SK',
  slowakei: 'SK',
};

function normalizeKauflandCountryCode(value) {
  const raw = safeString(value);
  if (!raw) return '';
  const compact = raw.replace(/[^a-zA-Z]/g, '').toUpperCase();
  if (/^[A-Z]{2}$/.test(compact)) return compact;
  const token = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return KAUFLAND_COUNTRY_CODE_FALLBACK[token] || '';
}

function normalizeKauflandAttributeValues(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((entry) => {
      if (entry == null) return [];
      if (typeof entry === 'object' && !Array.isArray(entry)) return [];
      const text = safeString(entry);
      if (!text) return [];
      if (typeof entry === 'string' && text.includes('|')) {
        return text
          .split('|')
          .map((part) => safeString(part))
          .filter(Boolean);
      }
      return [text];
    })
    .filter(Boolean)
    .slice(0, 25);
}

function pickImageUrl(entry) {
  if (typeof entry === 'string') return safeString(entry);
  if (!entry || typeof entry !== 'object') return '';
  return safeString(entry?.url_or_base64 || entry?.url || entry?.src || entry?.link);
}

// buildKauflandComplianceContact, buildKauflandProductDataAttributes, and
// tryRepairKauflandProductData have been extracted to
// services/kaufland-product-data-repair.js and are re-imported at the top of
// this file. Inline definitions removed to keep a single source of truth.

async function buildKauflandPostSyncValidationError({ unitId, storefront = 'de', ean = '', locale = 'de-DE' } = {}) {
  const numericUnitId = Number(unitId);
  if (!Number.isFinite(numericUnitId) || numericUnitId <= 0) return '';

  let unit = null;
  try {
    unit = await getUnit(numericUnitId, { storefront: safeString(storefront) || 'de', embedded: ['products'] });
  } catch {
    // Best-effort: if this probe fails, do not block a successful create/update call.
    return '';
  }

  const unitStatus = safeString(unit?.status).toUpperCase();
  const product = unit?.product && typeof unit.product === 'object' ? unit.product : {};
  const productIsValid =
    typeof product?.is_valid === 'boolean'
      ? product.is_valid
      : typeof unit?.is_valid === 'boolean'
        ? unit.is_valid
        : null;

  const invalidByUnit = unitStatus === 'INCOMPLETE';
  const invalidByProduct = productIsValid === false;
  if (!invalidByUnit && !invalidByProduct) return '';

  const reasons = [];
  reasons.push(
    `Kaufland meldet das Produkt als unvollständig/ungültig (unit.status=${unitStatus || 'unknown'}, product.is_valid=${
      productIsValid == null ? 'unknown' : String(productIsValid)
    })`
  );

  const idProduct = Number(unit?.id_product || product?.id_product || 0);
  if (Number.isFinite(idProduct) && idProduct > 0) {
    reasons.push(`id_product=${idProduct}`);
  }

  const productTitle = safeString(product?.title);
  if (!productTitle) {
    reasons.push('Produkttitel fehlt auf Kaufland');
  }

  const normalizedEan = safeString(ean).replace(/\D+/g, '');
  if (normalizedEan) {
    try {
      const status = await getProductDataStatus(normalizedEan, { locale: safeString(locale) || 'de-DE' });
      const productReady = typeof status?.product_ready === 'boolean' ? status.product_ready : null;
      const notReadyReason = safeString(status?.product_not_ready_reason);
      const updateFailReason = safeString(status?.update_fail_reason);
      const missing = Array.isArray(status?.missing_attributes)
        ? status.missing_attributes.map((x) => safeString(x)).filter(Boolean)
        : [];
      const minOneMissing = Array.isArray(status?.min_one_missing_attributes)
        ? status.min_one_missing_attributes.map((x) => safeString(x)).filter(Boolean)
        : [];

      reasons.push(
        `product-data/status: product_ready=${productReady == null ? 'unknown' : String(productReady)}${
          notReadyReason ? `, reason=${notReadyReason}` : ''
        }${updateFailReason ? `, update_fail_reason=${updateFailReason}` : ''}`
      );
      if (missing.length) {
        reasons.push(
          `missing_attributes: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+${missing.length - 10} weitere)` : ''}`
        );
      }
      if (minOneMissing.length) {
        reasons.push(
          `min_one_missing_attributes: ${minOneMissing.slice(0, 10).join(', ')}${
            minOneMissing.length > 10 ? ` (+${minOneMissing.length - 10} weitere)` : ''
          }`
        );
      }
    } catch (error) {
      if (Number(error?.status) === 404) {
        reasons.push(`Für EAN ${normalizedEan} ist bei Kaufland kein Product-Data-Datensatz vorhanden (GET /product-data/status -> 404).`);
      } else {
        reasons.push(`Product-Data-Status konnte nicht gelesen werden: ${safeString(error?.message) || String(error)}`);
      }
    }
  }

  return reasons.join(' | ');
}

async function runBulkKauflandSync({
  apply = false,
  limit = 500,
  offset = 0,
  debug = false,
  productIds = null,
  storefront = 'de',
  mode = 'upsert',
  tenantId = null,
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });
  const opMode = String(mode || 'upsert').toLowerCase();

  const summary = {
    action: opMode === 'update_only' ? 'kaufland_update' : 'kaufland_create',
    apply: Boolean(apply),
    mode: opMode,
    storefront: safeString(storefront) || 'de',
    selected: selected.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };
  const samples = [];

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;

      const picked = pickUnitData(cur, {
        mode: opMode === 'create_only' ? 'create' : 'update',
        storefront: summary.storefront,
      });
      const idOffer = safeString(picked?.idOffer || picked?.unitData?.id_offer);
      const ean = safeString(picked?.ean || picked?.unitData?.ean);

      const existingUnit = await findUnit({
        storefront: summary.storefront,
        idOffer: idOffer || undefined,
        ean: ean || undefined,
      });

      if (!apply) {
        if (debug && samples.length < 40) {
          samples.push({
            id,
            sku,
            id_offer: idOffer,
            ean,
            found_unit: existingUnit ? Number(existingUnit.id_unit || 0) || null : null,
            action:
              existingUnit && opMode !== 'create_only'
                ? 'would_update'
                : !existingUnit && opMode !== 'update_only'
                  ? 'would_create'
                  : 'would_skip',
          });
        }
        continue;
      }

      if (existingUnit && opMode === 'create_only') {
        summary.skipped += 1;
        if (samples.length < 40) {
          samples.push({ id, sku, status: 'skipped', message: `Unit already exists (${existingUnit.id_unit})` });
        }
        continue;
      }

      if (!existingUnit && opMode === 'update_only') {
        summary.skipped += 1;
        if (samples.length < 40) {
          samples.push({ id, sku, status: 'skipped', message: 'Unit not found for update' });
        }
        continue;
      }

      let result = null;
      if (existingUnit) {
        result = await updateUnit(existingUnit.id_unit, cur, { storefront: summary.storefront });
      } else {
        result = await createUnit(cur, { storefront: summary.storefront });
      }
      const resolvedUnitId = existingUnit
        ? Number(existingUnit.id_unit || 0) || null
        : Number(result?.id_unit || result?.data?.data?.id_unit || 0) || null;

      let postSyncValidationError = await buildKauflandPostSyncValidationError({
        unitId: resolvedUnitId,
        storefront: summary.storefront,
        ean,
      });
      if (postSyncValidationError) {
        const repair = await tryRepairKauflandProductData({
          product: cur,
          ean,
          locale: 'de-DE',
        });
        postSyncValidationError = await buildKauflandPostSyncValidationError({
          unitId: resolvedUnitId,
          storefront: summary.storefront,
          ean,
        });
        if (postSyncValidationError) {
          const repairNote = repair?.message ? ` | Reparaturversuch: ${repair.message}` : '';
          const err = new Error(`${postSyncValidationError}${repairNote}`);
          err.code = 'KAUFLAND_PRODUCT_INVALID_AFTER_SYNC';
          throw err;
        }
        if (repair?.attempted && debug && samples.length < 40) {
          samples.push({
            id,
            sku,
            status: 'repaired',
            id_offer: idOffer,
            id_unit: resolvedUnitId,
            message: repair.message,
            patched_keys: repair.patchedKeys,
          });
        }
      }

      if (existingUnit) summary.updated += 1;
      else summary.created += 1;

      cur.ops = cur.ops || {};
      cur.ops.kaufland = {
        ...(cur.ops.kaufland || {}),
        storefront: summary.storefront,
        last_sync_iso: nowIso(),
        last_sync_status: 'ok',
        last_action: existingUnit ? 'update' : 'create',
        id_offer: idOffer || null,
        id_unit: resolvedUnitId,
      };
      await saveProductV2(cur, { source: 'admin-bulk-kaufland' });

      if (debug && samples.length < 40) {
        samples.push({
          id,
          sku,
          status: existingUnit ? 'updated' : 'created',
          id_offer: idOffer,
          id_unit: resolvedUnitId,
          response: result?.data || null,
        });
      }
    } catch (e) {
      summary.failed += 1;
      const formattedError = formatKauflandApiError(e);
      if (samples.length < 60) {
        const sample = { id, sku, status: 'error', message: formattedError };
        const apiErrors = Array.isArray(e?.payload?.errors) ? e.payload.errors.slice(0, 5) : null;
        if (apiErrors && apiErrors.length) sample.errors = apiErrors;
        samples.push(sample);
      }
      try {
        const cur = await getProduct(String(id));
        if (cur) {
          cur.ops = cur.ops || {};
          cur.ops.kaufland = {
            ...(cur.ops.kaufland || {}),
            storefront: summary.storefront,
            last_sync_iso: nowIso(),
            last_sync_status: 'failed',
            last_error: formattedError,
          };
          await saveProductV2(cur, { source: 'admin-bulk-kaufland' });
        }
      } catch {
        // ignore secondary save errors
      }
    }
  }

  return { summary, samples };
}

// ── reenrich_content — bring existing datasheets up to the eBay-ready standard ──
// CONTENT ONLY, in-place, never touches inventory/sku/storage, never publishes.
// Manual only (no cron). Dry-run by default. See content-enrich-runner.js.
async function runBulkReenrichContent({
  apply = false,
  limit = 500,
  offset = 0,
  debug = false,
  productIds = null,
  tenantId = null,
  brands = null,
  maxIter = 4,
  marketplace = 'EBAY_DE',
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset, tenantId });

  const targetBrands =
    Array.isArray(brands) && brands.length
      ? new Set(brands.map((b) => safeString(b).toLowerCase()).filter(Boolean))
      : null;
  const filtered = targetBrands
    ? selected.filter((p) => targetBrands.has(safeString(p && p.identification && p.identification.brand).toLowerCase()))
    : selected;

  const summary = {
    action: 'reenrich_content',
    apply: Boolean(apply),
    limit,
    offset,
    selected: selected.length,
    filtered: filtered.length,
    considered: 0,
    ready: 0,
    improved: 0,
    needs_human: 0,
    applied: 0,
    failed: 0,
  };
  const samples = [];
  const needsHuman = [];

  for (const p of filtered) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      summary.considered += 1;

      const r = await applyEnrichmentToProduct(cur, { apply, maxIter, marketplace });
      summary[r.bucket] = (summary[r.bucket] || 0) + 1;
      if (r.applied) summary.applied += 1;

      if (!r.ready && needsHuman.length < 500) {
        needsHuman.push({ id, sku, bucket: r.bucket, changed: r.changedFields, missing: (r.remainingIssues || []).slice(0, 10) });
      }
      if (samples.length < 25) {
        samples.push({
          id,
          sku,
          bucket: r.bucket,
          applied: r.applied,
          ready: r.ready,
          changed: r.changedFields,
          remaining: (r.remainingIssues || []).slice(0, 8),
        });
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 25) samples.push({ id, sku, status: 'error', message: e && e.message ? e.message : String(e) });
    }
  }

  return { summary, samples, needsHuman: needsHuman.slice(0, 200) };
}

async function runBulkAction(action, payload = {}) {
  const a = String(action || '').trim().toLowerCase();
  const apply = parseBool(payload.apply, false);
  const limit = Math.max(1, Math.min(20000, Number(payload.limit) || 500));
  const offset = Math.max(0, Number(payload.offset) || 0);
  const debug = parseBool(payload.debug, false);
  const productIds = Array.isArray(payload.productIds) ? payload.productIds : null;
  const jobId = safeString(payload.jobId) || null;
  const inventoryId = safeString(payload.inventoryId) || null;
  // D.0b — tenantId is propagated through every sub-action so resolveTargetProducts
  // can scope its read. Bulk jobs are queued via /api/admin/bulk/run which now
  // injects req.user.tenantId into the payload.
  const tenantId = safeString(payload.tenantId) || null;

  if (a === 'price') {
    const maxAgeDays = Math.max(0, Number(payload.maxAgeDays) || 0);
    const force = parseBool(payload.force, false);
    return runBulkPrice({ apply, limit, offset, maxAgeDays, force, debug, productIds, tenantId });
  }
  if (a === 'title') {
    const includeUi = parseBool(payload.includeUi, false);
    const titleInsights = parseBool(payload.titleInsights, true);
    const titleInsightsQuery = safeString(payload.titleInsightsQuery || payload.query);
    const titleInsightsForceRefresh = parseBool(payload.titleInsightsForceRefresh, false);
    const titleInsightsLimit = Math.max(10, Math.min(200, Number(payload.titleInsightsLimit) || 80));
    const titleInsightsMaxHints = Math.max(0, Math.min(20, Number(payload.titleInsightsMaxHints) || 8));
    const marketplaceId = safeString(payload.marketplaceId || payload.ebayMarketplaceId || '');
    return runBulkTitle({
      apply,
      limit,
      offset,
      includeUi,
      debug,
      productIds,
      titleInsights,
      titleInsightsQuery,
      titleInsightsForceRefresh,
      titleInsightsLimit,
      titleInsightsMaxHints,
      marketplaceId,
      tenantId,
    });
  }
  if (a === 'title_trailing_dash' || a === 'title_trailing_dash_fix' || a === 'title_cleanup' || a === 'title-cleanup') {
    return runBulkTitleTrailingDashFix({ apply, limit, offset, debug, productIds, inventoryId, tenantId });
  }
  if (a === 'highlights_html' || a === 'highlights-html' || a === 'format_highlights_html') {
    return runBulkHighlightsHtml({ apply, limit, offset, debug, productIds, inventoryId, tenantId });
  }
  if (a === 'description_html' || a === 'description-html' || a === 'format_description_html') {
    return runBulkDescriptionHtml({ apply, limit, offset, debug, productIds, inventoryId, tenantId });
  }
  if (a === 'listing_readiness' || a === 'listing-readiness' || a === 'audit_listing_readiness') {
    return runBulkListingReadiness({ apply, limit, offset, debug, productIds, inventoryId, tenantId });
  }
  if (a === 'category') {
    return runBulkCategory({ apply, limit, offset, debug, productIds, tenantId });
  }
  if (a === 'recategorize_v2' || a === 'recategorize-v2') {
    return runBulkRecategorizeV2({
      apply,
      limit,
      offset,
      productIds,
      debug,
      includeUi: parseBool(payload.includeUi, false),
      concurrency: Math.max(1, Math.min(5, Number(payload.concurrency) || 2)),
      expectedCount:
        payload.expectedCount === undefined || payload.expectedCount === null
          ? null
          : Number(payload.expectedCount),
      minConfidence:
        payload.minConfidence === undefined || payload.minConfidence === null
          ? null
          : Number(payload.minConfidence),
      jobId: jobId || null,
      tenantId,
    });
  }
  if (a === 'ktype' || a === 'k-typ') {
    return runBulkKType({ apply, limit, offset, debug, productIds, tenantId });
  }
  if (a === 'kaufland_create' || a === 'kaufland-create') {
    return runBulkKauflandSync({
      apply,
      limit,
      offset,
      debug,
      productIds,
      storefront: safeString(payload.storefront) || 'de',
      mode: 'create_only',
      tenantId,
    });
  }
  if (a === 'kaufland_update' || a === 'kaufland-update') {
    return runBulkKauflandSync({
      apply,
      limit,
      offset,
      debug,
      productIds,
      storefront: safeString(payload.storefront) || 'de',
      mode: 'update_only',
      tenantId,
    });
  }
  if (a === 'export_marketplace' || a === 'export' || a === 'export-marketplace') {
    return runExportMarketplace({ jobId, productIds, limit, offset, debug, tenantId });
  }
  if (a === 'validate' || a === 'schnell-check' || a === 'quick-check') {
    const { runBatchValidate } = require('./product-validator');
    return runBatchValidate({ productIds, dryRun: !apply });
  }
  if (a === 'reenrich_content' || a === 'reenrich-content' || a === 'veredeln') {
    return runBulkReenrichContent({
      apply,
      limit,
      offset,
      debug,
      productIds,
      tenantId,
      brands: Array.isArray(payload.brands) ? payload.brands : null,
      maxIter: Math.max(1, Math.min(8, Number(payload.maxIter) || 4)),
      marketplace: safeString(payload.marketplace) || 'EBAY_DE',
    });
  }
  if (a === 'gpsr') {
    throw new Error('GPSR bulk action is not exposed here (use GPSR jobs/scripts).');
  }

  throw new Error(`Unknown bulk action: ${a}`);
}

module.exports = {
  runBulkAction,
};

