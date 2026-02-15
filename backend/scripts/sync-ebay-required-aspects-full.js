/* eslint-disable no-console */
/**
 * Build/refresh required item specifics for eBay categories (full leaf sync).
 *
 * Data sources (official):
 * - Taxonomy API: getDefaultCategoryTreeId
 * - Taxonomy API: getItemAspectsForCategory (for each leaf category)
 *
 * Output files:
 * - backend/ebay-data/required-aspects-full.json
 * - backend/ebay-data/required-aspects-full-meta.json
 *
 * Usage:
 *   node backend/scripts/sync-ebay-required-aspects-full.js
 *   node backend/scripts/sync-ebay-required-aspects-full.js --concurrency 4 --limit 500
 */

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default;
const { getSecretValue } = require('../lib/secret-values');

const CATEGORIES_PATH = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const OUT_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects-full.json');
const OUT_META_PATH = path.join(__dirname, '..', 'ebay-data', 'required-aspects-full-meta.json');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    concurrency: 3,
    limit: 0,
    offset: 0,
    onlyMissing: false,
    marketplaceId: process.env.EBAY_MARKETPLACE_ID || 'EBAY_DE',
    env: (process.env.EBAY_TAXONOMY_ENV || process.env.EBAY_TRADING_ENV || 'production').toLowerCase(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const t = String(argv[i] || '').trim();
    if (t === '--concurrency') out.concurrency = Math.max(1, Number(argv[i + 1] || 3)), (i += 1);
    else if (t === '--limit') out.limit = Math.max(0, Number(argv[i + 1] || 0)), (i += 1);
    else if (t === '--offset') out.offset = Math.max(0, Number(argv[i + 1] || 0)), (i += 1);
    else if (t === '--only-missing') out.onlyMissing = true;
    else if (t === '--marketplace') out.marketplaceId = String(argv[i + 1] || out.marketplaceId), (i += 1);
    else if (t === '--env') out.env = String(argv[i + 1] || out.env).toLowerCase(), (i += 1);
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

async function main() {
  const args = parseArgs();
  const categories = loadJson(CATEGORIES_PATH, {});
  const allLeafIds = getLeafCategoryIds(categories);
  const current = loadJson(OUT_PATH, {});
  const token = await getAppToken({ env: args.env });
  const categoryTreeId = await getDefaultCategoryTreeId({
    env: args.env,
    marketplaceId: args.marketplaceId,
    token,
  });

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

  saveJson(OUT_PATH, next);
  const meta = {
    generatedAt: new Date().toISOString(),
    environment: args.env,
    marketplaceId: args.marketplaceId,
    categoryTreeId,
    totalCategories: Object.keys(categories || {}).length,
    totalLeafCategories: allLeafIds.length,
    runTargetCategories: targetIds.length,
    totalAspectEntries: Object.keys(next || {}).length,
    errorsCount: errors.length,
    errorsSample: errors.slice(0, 200),
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
        processed: targetIds.length,
        storedEntries: Object.keys(next).length,
        errors: errors.length,
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

