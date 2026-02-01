const path = require('path');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');
const { firestore, getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { ensurePriceCoverage } = require('./enrichment');
const { coerceTitleToPolicy, validateTitleToPolicy, inferTitleCategory } = require('../lib/title-policy');
const { getRulebookConfigCached } = require('../lib/rulebook-config');

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

async function runBulkPrice({ apply = false, limit = 500, offset = 0, maxAgeDays = 0, debug = false } = {}) {
  const products = await getAllProducts();
  const list = Array.isArray(products) ? products.filter((p) => p?.id) : [];
  const selected = list.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));

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
      if (hasPrice && !stale) {
        summary.skipped_fresh += 1;
        continue;
      }
      if (hasPrice) summary.skipped_has_price += 1;

      const before = JSON.stringify(cur?.details?.pricing?.lowest_price || {});
      const serpTrace = [];
      // ensurePriceCoverage is opt-in via env flags; we still call it (no-op if disabled)
      await ensurePriceCoverage([cur], serpTrace);
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

async function runBulkTitle({ apply = false, limit = 500, offset = 0, includeUi = false, debug = false } = {}) {
  const products = await getAllProducts();
  const list = Array.isArray(products) ? products.filter((p) => p?.id) : [];
  const selected = list.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));

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

async function runBulkCategory({ apply = false, limit = 500, offset = 0, debug = false } = {}) {
  const lookup = buildMarketplaceLookup();
  const products = await getAllProducts();
  const list = Array.isArray(products) ? products.filter((p) => p?.id) : [];
  const selected = list.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, limit));

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

async function runBulkAction(action, payload = {}) {
  const a = String(action || '').trim().toLowerCase();
  const apply = parseBool(payload.apply, false);
  const limit = Math.max(1, Math.min(20000, Number(payload.limit) || 500));
  const offset = Math.max(0, Number(payload.offset) || 0);
  const debug = parseBool(payload.debug, false);

  if (a === 'price') {
    const maxAgeDays = Math.max(0, Number(payload.maxAgeDays) || 0);
    return runBulkPrice({ apply, limit, offset, maxAgeDays, debug });
  }
  if (a === 'title') {
    const includeUi = parseBool(payload.includeUi, false);
    return runBulkTitle({ apply, limit, offset, includeUi, debug });
  }
  if (a === 'category') {
    return runBulkCategory({ apply, limit, offset, debug });
  }
  if (a === 'ktype' || a === 'k-typ') {
    // Intentionally not implemented here yet (requires MVL dataset + strict evidence rules).
    // Keep as a first-class action name so we can consolidate later without breaking UI.
    throw new Error('K‑Typ bulk action is not yet consolidated. Use existing ktype scripts for now.');
  }
  if (a === 'gpsr') {
    throw new Error('GPSR bulk action is not exposed here (use GPSR jobs/scripts).');
  }

  throw new Error(`Unknown bulk action: ${a}`);
}

module.exports = {
  runBulkAction,
};

