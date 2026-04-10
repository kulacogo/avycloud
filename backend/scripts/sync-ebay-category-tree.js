/* eslint-disable no-console */
/**
 * Fetch the complete eBay DE category tree from the Taxonomy API
 * and rebuild `backend/ebay-data/categories.json`.
 *
 * Replaces the static May 2023 CSV approach with live API data.
 * Uses application token (client credentials) — no user auth needed.
 *
 * Usage:
 *   node backend/scripts/sync-ebay-category-tree.js
 */

const fs = require('fs');
const path = require('path');
const { getSecretValue } = require('../lib/secret-values');

const OUT_PATH = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const META_PATH = path.join(__dirname, '..', 'ebay-data', 'category-tree-meta.json');
const MARKETPLACE_ID = 'EBAY_DE';

// ---------------------------------------------------------------------------
// OAuth (client credentials — same pattern as sync-ebay-required-aspects-full)
// ---------------------------------------------------------------------------

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

async function getAppToken() {
  const clientId = await resolveCredential(['EBAY_TRADING_APP_ID', 'EBAY_APP_ID', 'EBAY_CLIENT_ID']);
  const clientSecret = await resolveCredential(['EBAY_TRADING_CERT_ID', 'EBAY_CERT_ID', 'EBAY_CLIENT_SECRET']);
  if (!clientId || !clientSecret) {
    throw new Error('Missing eBay OAuth credentials (EBAY_CLIENT_ID + EBAY_CLIENT_SECRET).');
  }

  const tokenUrl = 'https://api.ebay.com/identity/v1/oauth2/token';
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
    throw new Error(`OAuth token failed (${res.status}): ${text.slice(0, 400)}`);
  }
  const payload = JSON.parse(text);
  const token = String(payload?.access_token || '').trim();
  if (!token) throw new Error('OAuth response missing access_token');
  return token;
}

// ---------------------------------------------------------------------------
// Taxonomy API
// ---------------------------------------------------------------------------

async function getCategoryTreeId(token) {
  const url = `https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=${MARKETPLACE_ID}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`get_default_category_tree_id failed (${res.status}): ${text.slice(0, 400)}`);
  const payload = JSON.parse(text);
  return String(payload?.categoryTreeId || '').trim();
}

async function fetchCategoryTree(token, treeId) {
  const url = `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}`;
  console.log(`Fetching category tree ${treeId}...`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`category_tree/${treeId} failed (${res.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Transform eBay tree into flat categories.json format
// ---------------------------------------------------------------------------

function flattenTree(tree) {
  const categories = {};

  function walk(node, ancestors) {
    const id = node?.category?.categoryId;
    const name = node?.category?.categoryName || '';
    if (!id) return;

    const breadcrumbParts = [...ancestors, name];
    const breadcrumb = breadcrumbParts.join(' > ');

    categories[String(id)] = {
      id: Number(id),
      name,
      breadcrumb,
    };

    const children = node?.childCategoryTreeNodes || [];
    for (const child of children) {
      walk(child, breadcrumbParts);
    }
  }

  const root = tree?.rootCategoryNode;
  if (!root) throw new Error('No rootCategoryNode in API response');

  // Process children of root (root itself is "eBay" top-level, not useful)
  const topLevel = root?.childCategoryTreeNodes || [];
  for (const child of topLevel) {
    walk(child, []);
  }

  return categories;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== eBay Category Tree Sync ===');

  const token = await getAppToken();
  console.log('Got application token.');

  const treeId = await getCategoryTreeId(token);
  console.log(`Category tree ID: ${treeId}`);

  const tree = await fetchCategoryTree(token, treeId);
  console.log(`Tree version: ${tree?.categoryTreeVersion || 'unknown'}`);

  const categories = flattenTree(tree);
  const count = Object.keys(categories).length;
  if (count < 1000) {
    throw new Error(`Only ${count} categories parsed — seems incomplete. Aborting.`);
  }

  // Write atomically
  const tmpPath = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(categories, null, 2)}\n`);
  fs.renameSync(tmpPath, OUT_PATH);

  // Write metadata
  const meta = {
    marketplaceId: MARKETPLACE_ID,
    categoryTreeId: treeId,
    categoryTreeVersion: tree?.categoryTreeVersion || null,
    categoryCount: count,
    syncedAt: new Date().toISOString(),
  };
  fs.writeFileSync(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);

  console.log(`Done! ${count} categories written to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
