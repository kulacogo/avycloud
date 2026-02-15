/* eslint-disable no-console */
/**
 * Build/refresh required item specifics for eBay categories.
 *
 * Data sources (official):
 * - Taxonomy API: getDefaultCategoryTreeId
 * - Taxonomy API: fetchItemAspects (bulk marketplace export)
 * - Taxonomy API: getItemAspectsForCategory (fallback/per-category mode)
 *
 * Output files:
 * - backend/ebay-data/required-aspects-full.json
 * - backend/ebay-data/required-aspects-full-meta.json
 *
 * Usage:
 *   node backend/scripts/sync-ebay-required-aspects-full.js
 *   node backend/scripts/sync-ebay-required-aspects-full.js --mode bulk
 *   node backend/scripts/sync-ebay-required-aspects-full.js --mode auto --concurrency 2 --only-missing
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const zlib = require('zlib');
const PQueue = require('p-queue').default;
const { parser } = require('stream-json');
const { pick } = require('stream-json/filters/Pick');
const { streamArray } = require('stream-json/streamers/StreamArray');
const { getSecretValue } = require('../lib/secret-values');

const CATEGORIES_PATH = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const OUT_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects-full.json');
const OUT_META_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects-full-meta.json');

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    mode: (process.env.EBAY_TAXONOMY_SYNC_MODE || 'auto').toLowerCase(), // auto | bulk | per_category
    concurrency: 3,
    limit: 0,
    offset: 0,
    onlyMissing: false,
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE',
    env: (process.env.EBAY_TAXONOMY_ENV || process.env.EBAY_TRADING_ENV || 'production').toLowerCase(),
    categoryTreeId: String(process.env.EBAY_CATEGORY_TREE_ID || '').trim(),
    bulkTimeoutSec: Math.max(30, Number(process.env.EBAY_TAXONOMY_BULK_TIMEOUT_SEC || 900) || 900),
    bulkRawOut: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = String(argv[i] || '').trim();
    if (t === '--mode') out.mode = String(argv[i + 1] || out.mode).toLowerCase(), (i += 1);
    else if (t === '--concurrency') out.concurrency = Math.max(1, Number(argv[i + 1] || 3)), (i += 1);
    else if (t === '--limit') out.limit = Math.max(0, Number(argv[i + 1] || 0)), (i += 1);
    else if (t === '--offset') out.offset = Math.max(0, Number(argv[i + 1] || 0)), (i += 1);
    else if (t === '--only-missing') out.onlyMissing = true;
    else if (t === '--marketplace') out.marketplaceId = String(argv[i + 1] || out.marketplaceId), (i += 1);
    else if (t === '--env') out.env = String(argv[i + 1] || out.env).toLowerCase(), (i += 1);
    else if (t === '--category-tree-id') out.categoryTreeId = String(argv[i + 1] || '').trim(), (i += 1);
    else if (t === '--bulk-timeout-sec') out.bulkTimeoutSec = Math.max(30, Number(argv[i + 1] || out.bulkTimeoutSec) || out.bulkTimeoutSec), (i += 1);
    else if (t === '--bulk-raw-out') out.bulkRawOut = String(argv[i + 1] || ''), (i += 1);
  }
  if (!['auto', 'bulk', 'per_category'].includes(out.mode)) {
    throw new Error(`Invalid --mode "${out.mode}". Supported: auto, bulk, per_category`);
  }
  return out;
}

function normalizeAspectName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizeToken(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function dedupeAspectNames(values = []) {
  const out = [];
  const seen = new Set();
  values.forEach((raw) => {
    const name = normalizeAspectName(raw);
    if (!name) return;
    const token = normalizeToken(name);
    const key = token || name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out;
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function getLeafCategoryIds(categoriesObj) {
  const entries = Object.values(categoriesObj || {})
    .map((entry) => ({
      id: String(entry?.id ?? entry?.categoryId ?? '').trim(),
      breadcrumb: String(entry?.breadcrumb || '').trim(),
    }))
    .filter((x) => x.id && x.breadcrumb);

  const breadcrumbs = entries.map((x) => x.breadcrumb);
  const breadcrumbSet = new Set(breadcrumbs);
  const leafIds = [];

  entries.forEach((entry) => {
    const prefix = `${entry.breadcrumb} > `;
    let isLeaf = true;
    for (const b of breadcrumbSet) {
      if (b !== entry.breadcrumb && b.startsWith(prefix)) {
        isLeaf = false;
        break;
      }
    }
    if (isLeaf) leafIds.push(entry.id);
  });

  return Array.from(new Set(leafIds));
}

async function resolveCredential(nameCandidates = []) {
  for (const name of nameCandidates) {
    const direct = String(process.env[name] || '').trim();
    if (direct) return direct;
  }
  for (const name of nameCandidates) {
    try {
      const secret = String((await getSecretValue(name)) || '').trim();
      if (secret) return secret;
    } catch {
      // best effort
    }
  }
  return '';
}

function getIdentityBase(env) {
  return env === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
}

function isGzipBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

async function getAppToken({ env }) {
  const clientId = await resolveCredential(['EBAY_TRADING_APP_ID', 'EBAY_APP_ID', 'EBAY_CLIENT_ID']);
  const clientSecret = await resolveCredential(['EBAY_TRADING_CERT_ID', 'EBAY_CERT_ID', 'EBAY_CLIENT_SECRET']);
  if (!clientId || !clientSecret) {
    throw new Error('Missing eBay OAuth credentials (client id/secret).');
  }

  const tokenUrl = `${getIdentityBase(env)}/identity/v1/oauth2/token`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'https://api.ebay.com/oauth/api_scope',
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `OAuth token failed (${res.status}): ${text.slice(
        0,
        400
      )}. Check eBay OAuth client credentials (EBAY_TRADING_APP_ID + EBAY_TRADING_CERT_ID or EBAY_CLIENT_ID + EBAY_CLIENT_SECRET).`
    );
  }
  const payload = JSON.parse(text);
  const token = String(payload?.access_token || '').trim();
  if (!token) throw new Error('OAuth token response missing access_token');
  return token;
}

async function getDefaultCategoryTreeId({ env, marketplaceId, token }) {
  const base = `${getIdentityBase(env)}/commerce/taxonomy/v1`;
  const url = `${base}/get_default_category_tree_id?marketplace_id=${encodeURIComponent(marketplaceId)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`get_default_category_tree_id failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const payload = JSON.parse(text);
  const treeId = String(payload?.categoryTreeId || '').trim();
  if (!treeId) throw new Error('Missing categoryTreeId in taxonomy response');
  return treeId;
}

async function resolveCategoryTreeId({ args, token }) {
  const explicit = String(args?.categoryTreeId || '').trim();
  if (explicit) {
    return {
      categoryTreeId: explicit,
      categoryTreeIdSource: 'arg_or_env',
    };
  }

  const cachedMeta = loadJson(OUT_META_PATH, {});
  const cachedMarketplace = String(cachedMeta?.marketplaceId || '').trim().toUpperCase();
  const requestedMarketplace = String(args?.marketplaceId || '').trim().toUpperCase();
  const cachedTreeId = String(cachedMeta?.categoryTreeId || '').trim();
  if (cachedTreeId && cachedMarketplace && requestedMarketplace && cachedMarketplace === requestedMarketplace) {
    return {
      categoryTreeId: cachedTreeId,
      categoryTreeIdSource: 'cached_meta',
    };
  }

  const categoryTreeId = await getDefaultCategoryTreeId({
    env: args.env,
    marketplaceId: args.marketplaceId,
    token,
  });
  return {
    categoryTreeId,
    categoryTreeIdSource: 'api',
  };
}

function extractRequiredAspects(payload) {
  const aspects = Array.isArray(payload?.aspects) ? payload.aspects : [];
  const required = aspects.filter((aspect) => {
    const c = aspect?.aspectConstraint || {};
    if (typeof c?.aspectRequired === 'boolean') return c.aspectRequired;
    const req = String(aspect?.aspectRequirement || c?.aspectUsage || '').toUpperCase().trim();
    return req === 'REQUIRED';
  });
  return dedupeAspectNames(required.map((aspect) => aspect?.localizedAspectName || aspect?.aspectName || ''));
}

async function fetchItemAspectsBulkGzip({ env, token, categoryTreeId, timeoutSec = 900 }) {
  const base = `${getIdentityBase(env)}/commerce/taxonomy/v1`;
  const url = `${base}/category_tree/${encodeURIComponent(categoryTreeId)}/fetch_item_aspects`;
  const controller = new AbortController();
  const timeoutMs = Math.max(30, Number(timeoutSec) || 900) * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    const ab = await res.arrayBuffer();
    const body = Buffer.from(ab);
    if (!res.ok) {
      const text = body.toString('utf8');
      throw new Error(`fetch_item_aspects failed (${res.status}): ${text.slice(0, 400)}`);
    }
    if (!body.length) {
      throw new Error('fetch_item_aspects returned empty payload');
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`fetch_item_aspects timed out after ${Math.max(30, Number(timeoutSec) || 900)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseItemAspectsBulkPayload(bodyBuffer) {
  const source = Readable.from(bodyBuffer);
  return isGzipBuffer(bodyBuffer) ? source.pipe(zlib.createGunzip()) : source;
}

async function buildRequiredAspectsMapFromBulkBuffer(bodyBuffer) {
  const rawMap = {};
  let streamedCategories = 0;

  await new Promise((resolve, reject) => {
    const jsonInput = parseItemAspectsBulkPayload(bodyBuffer);
    const aspectStream = jsonInput.pipe(parser()).pipe(pick({ filter: 'categoryAspects' })).pipe(streamArray());

    aspectStream.on('data', ({ value }) => {
      const categoryId = String(value?.category?.categoryId || '').trim();
      if (!categoryId) return;
      const aspects = Array.isArray(value?.aspects) ? value.aspects : [];
      rawMap[categoryId] = extractRequiredAspects({ aspects });
      streamedCategories += 1;
      if (streamedCategories % 1000 === 0) {
        console.log(`[taxonomy-sync] bulk streamed ${streamedCategories} categories`);
      }
    });
    aspectStream.on('error', reject);
    aspectStream.on('end', resolve);
    jsonInput.on('error', reject);
  });

  return {
    rawMap,
    streamedCategories,
  };
}

function applyTargetSelection({ sourceMap = {}, current = {}, args = {}, allLeafIds = [] }) {
  const leafSet = new Set(asArray(allLeafIds).map((id) => String(id)));
  let entries = Object.entries(sourceMap || {}).filter(([id]) => Boolean(id));
  if (leafSet.size) {
    entries = entries.filter(([id]) => leafSet.has(String(id)));
  }
  entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (args.onlyMissing) {
    entries = entries.filter(([id]) => !Object.prototype.hasOwnProperty.call(current, id));
  }
  if (args.offset > 0) entries = entries.slice(args.offset);
  if (args.limit > 0) entries = entries.slice(0, args.limit);
  const next = { ...(current && typeof current === 'object' ? current : {}) };
  entries.forEach(([id, aspects]) => {
    next[String(id)] = Array.isArray(aspects) ? aspects : [];
  });
  return { next, selectedEntries: entries };
}

async function fetchRequiredAspectsForCategory({ env, token, categoryTreeId, categoryId }) {
  const base = `${getIdentityBase(env)}/commerce/taxonomy/v1`;
  const url = `${base}/category_tree/${encodeURIComponent(categoryTreeId)}/get_item_aspects_for_category?category_id=${encodeURIComponent(
    categoryId
  )}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 500),
      requiredAspects: [],
    };
  }
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  return {
    ok: true,
    status: res.status,
    requiredAspects: extractRequiredAspects(payload),
  };
}

async function runPerCategorySync({ args, categoryTreeId, token, current, allLeafIds }) {
  let targetIds = allLeafIds.slice();
  if (args.onlyMissing) {
    targetIds = targetIds.filter((id) => !Object.prototype.hasOwnProperty.call(current, id));
  }
  if (args.offset > 0) targetIds = targetIds.slice(args.offset);
  if (args.limit > 0) targetIds = targetIds.slice(0, args.limit);

  const queue = new PQueue({ concurrency: Math.max(1, args.concurrency) });
  const next = { ...(current && typeof current === 'object' ? current : {}) };
  const errors = [];
  let done = 0;

  const startedAt = Date.now();
  for (const categoryId of targetIds) {
    queue.add(async () => {
      const res = await fetchRequiredAspectsForCategory({
        env: args.env,
        token,
        categoryTreeId,
        categoryId,
      });
      if (res.ok) {
        next[categoryId] = res.requiredAspects;
      } else {
        errors.push({
          categoryId,
          status: res.status,
          error: res.error,
        });
      }
      done += 1;
      if (done % 100 === 0 || done === targetIds.length) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`[taxonomy-sync] processed ${done}/${targetIds.length} (elapsed ${elapsed}s, errors ${errors.length})`);
      }
    });
  }
  await queue.onIdle();

  return {
    modeUsed: 'per_category',
    next,
    errors,
    processed: targetIds.length,
    sourceEntries: targetIds.length,
    categoryTreeVersion: null,
  };
}

async function runBulkSync({ args, categoryTreeId, token, current, allLeafIds }) {
  const startedAt = Date.now();
  const body = await fetchItemAspectsBulkGzip({
    env: args.env,
    token,
    categoryTreeId,
    timeoutSec: args.bulkTimeoutSec,
  });
  if (args.bulkRawOut) {
    fs.writeFileSync(path.resolve(process.cwd(), args.bulkRawOut), body);
  }
  const bulkParsed = await buildRequiredAspectsMapFromBulkBuffer(body);
  const rawMap = bulkParsed.rawMap || {};
  const selection = applyTargetSelection({
    sourceMap: rawMap,
    current,
    args,
    allLeafIds,
  });
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[taxonomy-sync] bulk processed ${selection.selectedEntries.length}/${Object.keys(rawMap).length} categories (elapsed ${elapsed}s)`
  );
  return {
    modeUsed: 'bulk',
    next: selection.next,
    errors: [],
    processed: selection.selectedEntries.length,
    sourceEntries: Object.keys(rawMap).length,
    categoryTreeVersion: null,
  };
}

async function main() {
  const args = parseArgs();
  const categories = loadJson(CATEGORIES_PATH, {});
  const allLeafIds = getLeafCategoryIds(categories);
  const current = loadJson(OUT_PATH, {});
  const token = await getAppToken({ env: args.env });
  const categoryTree = await resolveCategoryTreeId({ args, token });
  const categoryTreeId = categoryTree.categoryTreeId;

  let runResult = null;
  let fallbackReason = null;
  if (args.mode === 'bulk') {
    runResult = await runBulkSync({ args, categoryTreeId, token, current, allLeafIds });
  } else if (args.mode === 'per_category') {
    runResult = await runPerCategorySync({ args, categoryTreeId, token, current, allLeafIds });
  } else {
    try {
      runResult = await runBulkSync({ args, categoryTreeId, token, current, allLeafIds });
    } catch (error) {
      fallbackReason = error?.message || String(error);
      console.warn(`[taxonomy-sync] bulk mode failed, fallback to per_category: ${fallbackReason}`);
      runResult = await runPerCategorySync({ args, categoryTreeId, token, current, allLeafIds });
    }
  }

  const next = runResult?.next && typeof runResult.next === 'object' ? runResult.next : {};
  const errors = Array.isArray(runResult?.errors) ? runResult.errors : [];

  saveJson(OUT_PATH, next);
  const meta = {
    generatedAt: new Date().toISOString(),
    environment: args.env,
    marketplaceId: args.marketplaceId,
    categoryTreeId,
    categoryTreeIdSource: categoryTree.categoryTreeIdSource,
    categoryTreeVersion: runResult?.categoryTreeVersion || null,
    totalCategories: Object.keys(categories || {}).length,
    totalLeafCategories: allLeafIds.length,
    runTargetCategories: runResult?.processed || 0,
    sourceCategories: runResult?.sourceEntries || 0,
    totalAspectEntries: Object.keys(next || {}).length,
    errorsCount: errors.length,
    errorsSample: errors.slice(0, 200),
    modeRequested: args.mode,
    modeUsed: runResult?.modeUsed || null,
    fallbackReason: fallbackReason || null,
    args,
  };
  saveJson(OUT_META_PATH, meta);

  console.log(
    JSON.stringify(
      {
        ok: true,
        output: OUT_PATH,
        meta: OUT_META_PATH,
        totalLeafCategories: allLeafIds.length,
        processed: runResult?.processed || 0,
        storedEntries: Object.keys(next).length,
        errors: errors.length,
        modeUsed: runResult?.modeUsed || null,
        fallback: Boolean(fallbackReason),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('[taxonomy-sync] fatal:', error?.message || error);
  process.exit(1);
});

