const path = require('path');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');
const { firestore, getAllProducts, getProduct } = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { ensurePriceCoverage } = require('./enrichment');
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

async function resolveTargetProducts({ productIds, limit, offset }) {
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
  const products = await getAllProducts();
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

async function runExportMarketplace({ jobId, productIds = null, limit = 500, offset = 0, debug = false } = {}) {
  if (!jobId) {
    throw new Error('export_marketplace requires jobId');
  }
  const selected = await resolveTargetProducts({ productIds, limit, offset });
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

async function runBulkPrice({ apply = false, limit = 500, offset = 0, maxAgeDays = 0, force = false, debug = false, productIds = null } = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });
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
        minLen,
        maxLen,
        softMaxLen,
        extraHintTokens: insightTokens,
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
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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

async function runBulkCategory({ apply = false, limit = 500, offset = 0, debug = false, productIds = null } = {}) {
  const lookup = buildMarketplaceLookup();
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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

async function runBulkKType({ apply = false, limit = 500, offset = 0, debug = false, productIds = null } = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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

function buildKauflandComplianceContact(product, fallbackName = '') {
  const gpsr = product?.details?.gpsr && typeof product.details.gpsr === 'object' ? product.details.gpsr : {};
  const name = safeString(gpsr?.manufacturer_name || fallbackName).replace(/\s+/g, ' ').trim();
  const countryCode = normalizeKauflandCountryCode(gpsr?.country_code || gpsr?.entity_country);
  const addressParts = [
    safeString(gpsr?.manufacturer_address),
    safeString(gpsr?.manufacturer_city),
    safeString(gpsr?.manufacturer_postalcode),
    countryCode,
  ].filter(Boolean);
  const address = addressParts.join(', ');
  if (!name || !address) return null;

  const contact = { name, address };
  const email = safeString(gpsr?.email);
  const url = safeString(gpsr?.url);
  const phone = safeString(gpsr?.manufacturer_phone);
  if (email) contact.email_address = email;
  if (url) contact.url = url;
  if (phone) contact.phone_number = phone;
  return contact;
}

function buildKauflandProductDataAttributes(product, { missingAttributes = [], minOneMissingAttributes = [] } = {}) {
  const attributes = {};

  const title = safeString(product?.identification?.name).replace(/\s+/g, ' ').trim();
  if (title) attributes.title = [title.slice(0, 250)];

  const descriptionRaw = safeString(product?.details?.short_description || product?.details?.description);
  const description = stripHtmlToPlainText(descriptionRaw);
  if (description) attributes.description = [description.slice(0, 4000)];

  const pictureUrls = Array.from(
    new Set(
      (Array.isArray(product?.details?.images) ? product.details.images : [])
        .map((entry) => pickImageUrl(entry))
        .filter((url) => /^https?:\/\//i.test(url))
    )
  );
  if (pictureUrls.length) attributes.picture = pictureUrls.slice(0, 20);

  const attrsPrimary =
    product?.details?.attributes && typeof product.details.attributes === 'object' && !Array.isArray(product.details.attributes)
      ? product.details.attributes
      : {};
  const attrsExtra =
    product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object' && !Array.isArray(product.details.attributes_extra)
      ? product.details.attributes_extra
      : {};
  const pickFromAttrsByNeedle = (...needles) => {
    const wanted = new Set(needles.map((n) => normalizeKauflandAttributeToken(n)).filter(Boolean));
    const pools = [attrsPrimary, attrsExtra];
    for (const pool of pools) {
      for (const [key, raw] of Object.entries(pool)) {
        const token = normalizeKauflandAttributeToken(key);
        if (!wanted.has(token)) continue;
        const values = normalizeKauflandAttributeValues(raw);
        if (values.length) return values[0];
      }
    }
    return '';
  };

  const brand = safeString(
    product?.identification?.brand ||
      product?.details?.identifiers?.brand ||
      pickFromAttrsByNeedle('marke', 'brand', 'hersteller')
  );
  if (brand) attributes.manufacturer = [brand];
  const complianceContact = buildKauflandComplianceContact(product, brand);
  if (complianceContact) attributes.product_safety_contact = complianceContact;

  const missing = Array.from(
    new Set(
      [...(Array.isArray(missingAttributes) ? missingAttributes : []), ...(Array.isArray(minOneMissingAttributes) ? minOneMissingAttributes : [])]
        .map((x) => safeString(x))
        .filter(Boolean)
    )
  );
  if (!missing.length) return attributes;

  const sourceMaps = [
    product?.details?.attributes && typeof product.details.attributes === 'object' && !Array.isArray(product.details.attributes)
      ? product.details.attributes
      : {},
    product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object' && !Array.isArray(product.details.attributes_extra)
      ? product.details.attributes_extra
      : {},
  ];
  const sourceByToken = new Map();
  sourceMaps.forEach((source) => {
    Object.entries(source).forEach(([rawKey, rawValue]) => {
      const token = normalizeKauflandAttributeToken(rawKey);
      if (!token || sourceByToken.has(token)) return;
      sourceByToken.set(token, rawValue);
    });
  });

  missing.forEach((requiredName) => {
    const requiredToken = normalizeKauflandAttributeToken(requiredName);
    if (!requiredToken) return;
    const alreadyPresent = Object.keys(attributes).some(
      (key) => normalizeKauflandAttributeToken(key) === requiredToken
    );
    if (alreadyPresent) return;

    const isComplianceContactToken =
      requiredToken.includes('productsafetycontact') ||
      requiredToken.includes('compliancecontact') ||
      (requiredToken.includes('herstellername') && requiredToken.includes('verantwortlicheperson')) ||
      (requiredToken.includes('manufacturername') && requiredToken.includes('responsibleperson'));
    if (isComplianceContactToken) {
      if (complianceContact) {
        attributes[requiredName] = complianceContact;
        return;
      }
      const fallbackName = safeString(product?.details?.gpsr?.manufacturer_name || brand);
      if (fallbackName) {
        attributes[requiredName] = [fallbackName];
        return;
      }
    }

    if ((requiredToken.includes('titel') || requiredToken.includes('title')) && title) {
      attributes[requiredName] = [title.slice(0, 250)];
      return;
    }
    if ((requiredToken.includes('beschreibung') || requiredToken.includes('description')) && description) {
      attributes[requiredName] = [description.slice(0, 4000)];
      return;
    }
    if ((requiredToken.includes('bild') || requiredToken.includes('picture')) && pictureUrls.length) {
      attributes[requiredName] = pictureUrls.slice(0, 20);
      return;
    }
    if ((requiredToken === 'hersteller' || requiredToken.includes('manufacturer')) && brand) {
      attributes[requiredName] = [brand];
      return;
    }

    const rawValue = sourceByToken.get(requiredToken);
    if (isComplianceContactToken && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const fromSource = {
        name: safeString(rawValue?.name || rawValue?.manufacturer_name || rawValue?.herstellername),
        address: safeString(rawValue?.address || rawValue?.manufacturer_address || rawValue?.anschrift),
        email_address: safeString(rawValue?.email_address || rawValue?.email || rawValue?.e_mail),
        url: safeString(rawValue?.url || rawValue?.website || rawValue?.kontaktseite),
        phone_number: safeString(rawValue?.phone_number || rawValue?.phone || rawValue?.telefon),
      };
      if (fromSource.name && fromSource.address) {
        if (!fromSource.email_address) delete fromSource.email_address;
        if (!fromSource.url) delete fromSource.url;
        if (!fromSource.phone_number) delete fromSource.phone_number;
        attributes[requiredName] = fromSource;
        return;
      }
    }

    const values = normalizeKauflandAttributeValues(rawValue);
    if (values.length) attributes[requiredName] = values;
  });

  return attributes;
}

async function tryRepairKauflandProductData({
  product,
  ean,
  locale = 'de-DE',
} = {}) {
  const normalizedEan = safeString(ean).replace(/\D+/g, '');
  if (!normalizedEan) {
    return { attempted: false, patchedKeys: [], message: 'EAN fehlt – Product-Data-Reparatur übersprungen.' };
  }

  const normalizedLocale = safeString(locale) || 'de-DE';
  let statusBefore = null;
  let statusBeforeError = '';
  try {
    statusBefore = await getProductDataStatus(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    statusBeforeError = Number(error?.status) === 404 ? 'product-data/status=404 (noch kein Datensatz)' : safeString(error?.message);
  }
  let productDataBefore = null;
  let productDataBeforeError = '';
  try {
    productDataBefore = await getProductData(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    productDataBeforeError = Number(error?.status) === 404 ? 'product-data=404' : safeString(error?.message);
  }

  const attributes = buildKauflandProductDataAttributes(product, {
    missingAttributes: statusBefore?.missing_attributes || [],
    minOneMissingAttributes: statusBefore?.min_one_missing_attributes || [],
  });
  const patchedKeys = Object.keys(attributes);
  if (!patchedKeys.length) {
    return {
      attempted: false,
      patchedKeys,
      message: 'Keine geeigneten Product-Data-Felder aus dem Datensatz ableitbar.',
    };
  }

  let writeMode = 'patch';
  await patchProductData({ ean: [normalizedEan], locale: normalizedLocale, attributes });

  let storedProductData = null;
  let storedProductDataError = '';
  try {
    storedProductData = await getProductData(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    storedProductDataError = Number(error?.status) === 404 ? 'product-data=404 nach PATCH' : safeString(error?.message);
  }
  if (!storedProductData) {
    writeMode = 'patch+put';
    await putProductData({ ean: [normalizedEan], locale: normalizedLocale, attributes });
    try {
      storedProductData = await getProductData(normalizedEan, { locale: normalizedLocale });
      storedProductDataError = '';
    } catch (error) {
      storedProductDataError = Number(error?.status) === 404 ? 'product-data=404 nach PUT' : safeString(error?.message);
    }
  }

  // Product-data processing may be async. Poll once shortly for a fresher status snapshot.
  await wait(900);
  let statusAfter = null;
  let statusAfterError = '';
  try {
    statusAfter = await getProductDataStatus(normalizedEan, { locale: normalizedLocale });
  } catch (error) {
    statusAfterError = Number(error?.status) === 404 ? 'product-data/status=404' : safeString(error?.message);
  }

  const beforeSummary = statusBefore
    ? `vorher: ready=${String(statusBefore?.product_ready)}, update=${safeString(statusBefore?.update_status) || 'unknown'}`
    : statusBeforeError
      ? `vorher: ${statusBeforeError}`
      : 'vorher: unbekannt';
  const beforeStorageSummary = productDataBefore
    ? `speicher vorher: keys=${Object.keys(productDataBefore?.attributes || {}).join(', ') || 'keine'}`
    : productDataBeforeError
      ? `speicher vorher: ${productDataBeforeError}`
      : 'speicher vorher: unbekannt';
  const storageSummary = storedProductData
    ? `speicher nachher: keys=${Object.keys(storedProductData?.attributes || {}).join(', ') || 'keine'}`
    : storedProductDataError
      ? `speicher nachher: ${storedProductDataError}`
      : 'speicher nachher: unbekannt';
  const afterSummary = statusAfter
    ? `nachher: ready=${String(statusAfter?.product_ready)}, update=${safeString(statusAfter?.update_status) || 'unknown'}`
    : statusAfterError
      ? `nachher: ${statusAfterError}`
      : 'nachher: unbekannt';

  return {
    attempted: true,
    patchedKeys,
    message: `Product-Data via ${writeMode} aktualisiert (${patchedKeys.join(', ')}). ${beforeStorageSummary}; ${storageSummary}; ${beforeSummary}; ${afterSummary}`,
  };
}

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
} = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });
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

async function runBulkAction(action, payload = {}) {
  const a = String(action || '').trim().toLowerCase();
  const apply = parseBool(payload.apply, false);
  const limit = Math.max(1, Math.min(20000, Number(payload.limit) || 500));
  const offset = Math.max(0, Number(payload.offset) || 0);
  const debug = parseBool(payload.debug, false);
  const productIds = Array.isArray(payload.productIds) ? payload.productIds : null;
  const jobId = safeString(payload.jobId) || null;
  const inventoryId = safeString(payload.inventoryId) || null;

  if (a === 'price') {
    const maxAgeDays = Math.max(0, Number(payload.maxAgeDays) || 0);
    const force = parseBool(payload.force, false);
    return runBulkPrice({ apply, limit, offset, maxAgeDays, force, debug, productIds });
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
    });
  }
  if (a === 'title_trailing_dash' || a === 'title_trailing_dash_fix' || a === 'title_cleanup' || a === 'title-cleanup') {
    return runBulkTitleTrailingDashFix({ apply, limit, offset, debug, productIds, inventoryId });
  }
  if (a === 'highlights_html' || a === 'highlights-html' || a === 'format_highlights_html') {
    return runBulkHighlightsHtml({ apply, limit, offset, debug, productIds, inventoryId });
  }
  if (a === 'description_html' || a === 'description-html' || a === 'format_description_html') {
    return runBulkDescriptionHtml({ apply, limit, offset, debug, productIds, inventoryId });
  }
  if (a === 'listing_readiness' || a === 'listing-readiness' || a === 'audit_listing_readiness') {
    return runBulkListingReadiness({ apply, limit, offset, debug, productIds, inventoryId });
  }
  if (a === 'category') {
    return runBulkCategory({ apply, limit, offset, debug, productIds });
  }
  if (a === 'ktype' || a === 'k-typ') {
    return runBulkKType({ apply, limit, offset, debug, productIds });
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
    });
  }
  if (a === 'export_marketplace' || a === 'export' || a === 'export-marketplace') {
    return runExportMarketplace({ jobId, productIds, limit, offset, debug });
  }
  if (a === 'gpsr') {
    throw new Error('GPSR bulk action is not exposed here (use GPSR jobs/scripts).');
  }

  throw new Error(`Unknown bulk action: ${a}`);
}

module.exports = {
  runBulkAction,
};

