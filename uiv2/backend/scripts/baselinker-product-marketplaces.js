#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Inspect where a product is listed in BaseLinker (marketplace/integration links)
 * and what integration text fields are available for overrides.
 *
 * Usage:
 *   node backend/scripts/baselinker-product-marketplaces.js --inventory 78659 --sku SKU-2941051529
 *   node backend/scripts/baselinker-product-marketplaces.js --inventory 78659 --product_id 449821266
 *
 * Output:
 * - resolved BaseLinker product_id
 * - `links` block from getInventoryProductsData (if present)
 * - available integration names + sample of override keys for each (from getInventoryAvailableTextFieldKeys)
 */

function parseArgs(argv) {
  const out = { inventory: 78659, sku: null, product_id: null, keysSample: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--inventory' || a === '--inventory_id' || a === '-i') {
      out.inventory = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (a === '--sku') {
      out.sku = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--product_id') {
      out.product_id = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (a === '--keys-sample') {
      out.keysSample = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
      continue;
    }
  }
  return out;
}

function normalizeSkuValue(val) {
  return (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.inventory) || args.inventory <= 0) {
    console.error('Invalid inventory id.');
    process.exit(1);
  }
  if (!args.sku && !args.product_id) {
    console.error('Provide --sku or --product_id');
    process.exit(1);
  }

  const { callBaseLinker } = require('../lib/baselinker');
  const inventory_id = Number(args.inventory);

  let productId = args.product_id ? Number(args.product_id) : null;
  if (!productId) {
    const rawSku = String(args.sku || '').trim();
    // IMPORTANT:
    // BaseLinker filter_sku expects the raw SKU as stored in BaseLinker (often includes "SKU-...").
    // Our internal helper normalizes SKUs, which can break filter_sku. Here we call the API directly.
    const tryFilter = async (value) => {
      if (!value) return null;
      const res = await callBaseLinker('getInventoryProductsList', {
        inventory_id,
        page: 1,
        filter_sku: value,
      });
      if (!res || res.status !== 'SUCCESS') return null;
      const products = res.products && typeof res.products === 'object' ? Object.values(res.products) : [];
      return products.find((p) => String(p?.sku || '').trim() === value) || products[0] || null;
    };

    const hit = (await tryFilter(rawSku)) || (await tryFilter(normalizeSkuValue(rawSku))) || null;
    const pid = hit?.product_id ?? hit?.id ?? null;
    productId = pid ? Number(pid) : null;
  }

  if (!productId) {
    console.error('Could not resolve BaseLinker product_id for', args.sku);
    process.exit(2);
  }

  const prodRes = await callBaseLinker('getInventoryProductsData', {
    inventory_id,
    products: [productId],
  });

  const product = prodRes?.products?.[String(productId)] || prodRes?.products?.[productId] || null;
  const links = product?.links || null;

  // Integrations and their overridable keys
  const integrationsRes = await callBaseLinker('getInventoryIntegrations', { inventory_id });
  const raw = integrationsRes?.integrations;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? Object.entries(raw).map(([name, value]) => ({ [name]: value }))
      : [];

  const integrations = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const [name] = Object.keys(entry);
    if (!name) continue;
    integrations.push(name);
  }
  integrations.sort((a, b) => String(a).localeCompare(String(b)));

  // Fetch the full set of keys once (includes integration-scoped keys like `features|de|ebay_0`)
  let allKeys = [];
  try {
    const keysRes = await callBaseLinker('getInventoryAvailableTextFieldKeys', { inventory_id });
    const map = keysRes?.text_field_keys && typeof keysRes.text_field_keys === 'object' ? keysRes.text_field_keys : {};
    allKeys = Object.keys(map);
  } catch {
    allKeys = [];
  }

  const keysByIntegration = {};
  const DEFAULT_LANG = 'de';
  const fields = [
    'name',
    'description',
    'description_extra1',
    'description_extra2',
    'description_extra3',
    'description_extra4',
    'features',
  ];

  // Build expected per-integration keys from integrations meta (accounts + languages),
  // then intersect with the actually available keys returned by BaseLinker.
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const [integrationName] = Object.keys(entry);
    const meta = integrationName ? entry[integrationName] : null;
    if (!integrationName || !meta || typeof meta !== 'object') continue;

    const langs = Array.isArray(meta.langs || meta.languages)
      ? (meta.langs || meta.languages).map((l) => String(l).toLowerCase()).filter(Boolean)
      : [DEFAULT_LANG];

    const accountsObj = meta.accounts && typeof meta.accounts === 'object' ? meta.accounts : {};
    const accountIds = Array.isArray(meta.accounts)
      ? meta.accounts.map((a) => String(a?.account_id ?? a?.id ?? '').trim()).filter(Boolean)
      : Object.keys(accountsObj).map((id) => String(id).trim()).filter(Boolean);

    const accounts = Array.from(new Set([`${integrationName}_0`, ...accountIds.map((id) => `${integrationName}_${id}`)]));

    const expected = [];
    for (const field of fields) {
      for (const acc of accounts) {
        expected.push(`${field}|${acc}`);
        for (const l of langs) {
          expected.push(`${field}|${l}|${acc}`);
        }
      }
    }

    const available = allKeys.length ? expected.filter((k) => allKeys.includes(k)) : expected;
    const unique = Array.from(new Set(available));
    keysByIntegration[integrationName] =
      args.keysSample > 0 ? unique.slice(0, args.keysSample) : unique;
  }

  console.log(
    JSON.stringify(
      {
        inventory_id,
        resolved_product_id: productId,
        product_snapshot: product
          ? {
              sku: product?.sku || null,
              ean: product?.ean || null,
              category_id: product?.category_id || null,
              links: links,
            }
          : null,
        integrations,
        integration_text_field_keys_sample: keysByIntegration,
        note: 'Keys are BaseLinker text_field overwrite keys (what can be sent in text_fields). Marketplace-specific “required item specifics” are not fully discoverable via these keys alone.',
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error('Failed:', e?.message || e);
  process.exit(1);
});

