const path = require('path');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');
const { firestore, getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { ensurePriceCoverage } = require('./enrichment');
const { coerceTitleToPolicy, validateTitleToPolicy, inferTitleCategory } = require('../lib/title-policy');
const { getRulebookConfigCached } = require('../lib/rulebook-config');
const fs = require('fs');
const { uploadJobFile } = require('../lib/storage');
const { createJob: createBaseLinkerSyncJob, Timestamp: BaseLinkerSyncTimestamp } = require('../lib/baselinker-sync-jobs');
const { enqueueBaseLinkerSyncJob } = require('./baselinker-sync-runner');

const EXPORT_BUCKET = 'prodsandjobs';

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

async function enqueueBaseLinkerTextOnlyJobs({ productIds, inventoryId, chunkSize = 200, requestedBy = 'admin-bulk' }) {
  const invId = String(inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
  const uniqueAll = Array.from(new Set((productIds || []).map((x) => safeString(x)).filter(Boolean)));
  if (!uniqueAll.length) return [];
  const chunks = chunkArray(uniqueAll, chunkSize);
  const jobIds = [];
  for (const ids of chunks) {
    const unique = Array.from(new Set(ids.map((x) => safeString(x)).filter(Boolean))).slice(0, 500);
    if (!unique.length) continue;
    const job = await createBaseLinkerSyncJob({
      payload: { productIds: unique, inventoryId: invId, mode: 'text_only' },
      status: 'pending',
      stage: 'queued',
      progress: { total: unique.length, processed: 0, synced: 0, failed: 0 },
      requestedBy,
      createdAt: BaseLinkerSyncTimestamp.now(),
      updatedAt: BaseLinkerSyncTimestamp.now(),
    });
    enqueueBaseLinkerSyncJob(job.id, true);
    jobIds.push(job.id);
  }
  return jobIds;
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
    const bl = cur?.ops?.baselinker || {};

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
      baselinker_product_id: bl?.product_id != null ? String(bl.product_id) : '',
      baselinker_synced_inventory: safeString(bl?.synced_inventory) || '',
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
        await saveProduct(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
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

async function runBulkTitle({ apply = false, limit = 500, offset = 0, includeUi = false, debug = false, productIds = null } = {}) {
  const selected = await resolveTargetProducts({ productIds, limit, offset });

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

      const nextTitle = coerceTitleToPolicy(cur, currentTitle, { minLen, maxLen, softMaxLen });
      const nextLen = safeString(nextTitle).length;
      const afterIssues = validateTitleToPolicy(cur, nextTitle, { maxLen, mobileMaxLen }) || [];
      if (!nextTitle || nextLen === 0 || nextLen > 80) {
        summary.invalid_after += 1;
        if (debug && samples.length < 10) {
          samples.push({ id, sku, status: 'invalid_after', before: currentTitle, after: nextTitle, beforeIssues, afterIssues });
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
        cur.ops.last_saved_source = 'admin-bulk-title-v1';
        cur.ops.last_saved_iso = nowIso();
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.title_policy_v2 = {
          iso: nowIso(),
          before: currentTitle,
          after: nextTitle,
          before_issues: beforeIssues,
          after_issues: afterIssues,
        };
        await saveProduct(cur, { source: 'admin-bulk', skipKeyFeaturesNormalize: true });
      }
      summary.updated += 1;
      if (!apply && samples.length < 15) {
        samples.push({ id, sku, before: currentTitle, after: nextTitle, beforeIssues, afterIssues });
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
    baselinkerTextOnlyJobs: 0,
  };
  const samples = [];
  const changedIds = [];

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
        await saveProduct(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true, overwriteTextFields: true });
      }

      summary.updated += 1;
      changedIds.push(String(id));
      if (!apply && samples.length < 15) samples.push({ id, sku, before: currentTitle, after: nextTitle });
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  if (apply && changedIds.length) {
    const jobs = await enqueueBaseLinkerTextOnlyJobs({
      productIds: changedIds,
      inventoryId,
      chunkSize: 200,
      requestedBy: 'admin-bulk-title-trailing-dash-v1',
    });
    summary.baselinkerTextOnlyJobs = jobs.length;
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
    baselinkerTextOnlyJobs: 0,
  };
  const samples = [];
  const changedIds = [];

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
        await saveProduct(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true, overwriteTextFields: true });
      }

      summary.updated += 1;
      changedIds.push(String(id));
      if (!apply && samples.length < 15) {
        samples.push({ id, sku, itemCount: built.itemCount, preview: built.html.slice(0, 160) });
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  if (apply && changedIds.length) {
    const jobs = await enqueueBaseLinkerTextOnlyJobs({
      productIds: changedIds,
      inventoryId,
      chunkSize: 200,
      requestedBy: 'admin-bulk-highlights-html-v1',
    });
    summary.baselinkerTextOnlyJobs = jobs.length;
  }

  return { summary, samples };
}

function looksLikeHtml(text = '') {
  const s = String(text || '').trim();
  if (!s) return false;
  return /<\s*(p|br|ul|ol|li|strong|b|em|div|span|h\d)\b/i.test(s);
}

function formatDescriptionToHtml(input = '') {
  const raw = String(input || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!raw) return '';

  // If already HTML-ish, keep as-is.
  if (looksLikeHtml(raw)) {
    return raw;
  }

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
        out.push(`<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(rest).trim()}</p>`.replace(/\s+<\/p>$/, '</p>'));
        continue;
      }
    }

    const joined = lines.join(' ');
    out.push(`<p>${escapeHtml(joined)}</p>`);
  }

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
    baselinkerTextOnlyJobs: 0,
  };
  const samples = [];
  const changedIds = [];

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
        // Ensure BaseLinker uses the formatted HTML.
        cur.details.short_description = next;
        cur.ops = cur.ops || {};
        cur.ops.data_quality = cur.ops.data_quality || {};
        cur.ops.data_quality.description_html_v1 = { at_iso: nowIso() };
        await saveProduct(cur, { source: 'admin-bulk', overwriteTextFields: true, skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
      }

      summary.updated += 1;
      changedIds.push(String(id));
      if (!apply && samples.length < 15) samples.push({ id, sku, before: src.slice(0, 120), after: next.slice(0, 120) });
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  if (apply && changedIds.length) {
    const jobs = await enqueueBaseLinkerTextOnlyJobs({
      productIds: changedIds,
      inventoryId,
      chunkSize: 200,
      requestedBy: 'admin-bulk-description-html-v1',
    });
    summary.baselinkerTextOnlyJobs = jobs.length;
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
  // Keep objects/arrays as-is; Firestore saveProduct/enforceEbayAspects will stringify where appropriate for BaseLinker.
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
    baselinkerTextOnlyJobs: 0,
  };
  const samples = [];
  const changedIds = [];

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

      // Description HTML (short_description is what we sync as BaseLinker description)
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
        await saveProduct(cur, {
          source: 'admin-bulk',
          overwriteTextFields: true,
          replaceAttributes: true,
          // allow full normalization pipeline (aliases + required aspects) to run
          skipTitlePolicy: true,
        });
      }

      summary.updated += 1;
      changedIds.push(String(id));
      if (!apply && samples.length < 15) samples.push({ id, sku, changed: true });
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  if (apply && changedIds.length) {
    const jobs = await enqueueBaseLinkerTextOnlyJobs({
      productIds: changedIds,
      inventoryId,
      chunkSize: 200,
      requestedBy: 'admin-bulk-listing-readiness-v1',
    });
    summary.baselinkerTextOnlyJobs = jobs.length;
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

  // Batch dot-path updates (fast + safe; does not overwrite whole document).
  let batch = firestore.batch();
  let batchCount = 0;
  const commit = async () => {
    if (batchCount === 0) return;
    await batch.commit();
    batch = firestore.batch();
    batchCount = 0;
  };

  for (const p of selected) {
    const id = p.id;
    const sku = pickSku(p);
    try {
      const cur = await getProduct(String(id));
      if (!cur) continue;
      const details = cur.details || {};
      const attrs = details.attributes || {};

      const update = {};

      // eBay
      const existingEbayId = details.ebayCategoryId;
      const ebayIdOk = existingEbayId && lookup.isValidEbayId(String(existingEbayId).trim());
      if (!ebayIdOk) {
        const directId =
          details.ebayCategoryId ||
          attrs.ebay_category_id ||
          attrs.ebayCategoryId ||
          attrs['ebay.category_id'] ||
          null;
        const directPath =
          details.ebayCategoryPath ||
          attrs.ebay_category_path ||
          attrs.ebay_category ||
          details.ebayCategory ||
          attrs.Kategorie ||
          attrs.category ||
          cur.identification?.category ||
          null;

        let ebayId = null;
        if (isNumericId(directId) && lookup.isValidEbayId(String(directId).trim())) {
          ebayId = String(directId).trim();
        } else {
          const sourcePath = normalizePath(directPath || cur.identification?.category);
          if (sourcePath) ebayId = lookup.lookupEbay(sourcePath);
        }

        if (ebayId) {
          update['details.ebayCategoryId'] = ebayId;
          const pathStr = normalizePath(directPath) || normalizePath(cur.identification?.category) || '';
          update['details.ebayCategoryPath'] = pathStr || `ID:${ebayId}`;
          update['details.attributes.ebay_category_id'] = ebayId;
          update['details.attributes.ebay_category_path'] = pathStr || `ID:${ebayId}`;
        }
      }

      // Kaufland
      const existingKaufId = details.kauflandCategoryId;
      const kaufIdOk = existingKaufId && lookup.isValidKauflandId(String(existingKaufId).trim());
      if (!kaufIdOk) {
        const directId =
          details.kauflandCategoryId ||
          attrs.kaufland_category_id ||
          attrs.kauflandCategoryId ||
          attrs['kaufland.category_id'] ||
          null;

        let kaufId = null;
        if (isNumericId(directId) && lookup.isValidKauflandId(String(directId).trim())) {
          kaufId = String(directId).trim();
        } else {
          const pathCandidate =
            normalizePath(details.kauflandCategoryPath) ||
            normalizePath(attrs.kaufland_category_path) ||
            normalizePath(attrs.kaufland_category) ||
            normalizePath(attrs.Kategorie) ||
            normalizePath(attrs.category) ||
            normalizePath(cur.identification?.category);
          if (pathCandidate) kaufId = lookup.lookupKaufland(pathCandidate);
        }

        if (kaufId) {
          update['details.kauflandCategoryId'] = kaufId;
          const pathStr =
            normalizePath(details.kauflandCategoryPath) ||
            normalizePath(attrs.kaufland_category_path) ||
            normalizePath(attrs.kaufland_category) ||
            normalizePath(attrs.Kategorie) ||
            normalizePath(attrs.category) ||
            normalizePath(cur.identification?.category) ||
            `ID:${kaufId}`;
          update['details.kauflandCategoryPath'] = pathStr;
          update['details.attributes.kaufland_category_id'] = kaufId;
          update['details.attributes.kaufland_category_path'] = pathStr;
        }
      }

      if (!Object.keys(update).length) {
        summary.noop += 1;
        continue;
      }

      summary.updated += 1;
      if (!apply && samples.length < 15) {
        samples.push({ id, sku, update });
      }

      if (apply) {
        const ref = firestore.collection('products').doc(String(id));
        batch.update(ref, update);
        batchCount += 1;
        if (batchCount >= 400) {
          await commit();
        }
      }
    } catch (e) {
      summary.failed += 1;
      if (samples.length < 10) samples.push({ id, sku, status: 'error', message: e?.message || String(e) });
    }
  }

  if (apply) await commit();
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
        await saveProduct(cur, { source: 'admin-bulk', skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
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
    return runBulkTitle({ apply, limit, offset, includeUi, debug, productIds });
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

