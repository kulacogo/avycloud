/* eslint-disable no-console */
'use strict';

/**
 * gpsr-backfill-orphan-brands-gemini.js
 *
 * One-shot backfill: find brands in `products_v2` for which we have ZERO GPSR
 * data anywhere (no `details.gpsr.manufacturer_name` AND no
 * `details.gpsr.manufacturer_address` on ANY product of that brand) → ask
 * Gemini-with-googleSearch (via `lib/gpsr-gemini-lookup`) → write the result
 * onto ALL products of that brand via `saveProductV2(..., skipStockEvent: true)`.
 *
 * NEVER touches stock, NEVER triggers a publish. Attribute-only update so
 * future Kaufland sync runs pick up the fresh GPSR.
 *
 * Usage:
 *   USE_PRODUCTS_V2=true node backend/scripts/gpsr-backfill-orphan-brands-gemini.js
 *
 * Optional env:
 *   DRY_RUN=1            — log decisions only, do not write
 *   ORPHAN_BRAND_LIMIT   — cap the number of brands processed (default: no cap)
 *   TENANT_ID            — scope to a single tenant (default: avycloud)
 *   ORPHAN_BRAND_SLEEP_MS — pause between Gemini calls (default 400ms)
 */

const { getAllProductsV2, saveProductV2 } = require('../lib/product-store');
const { getOrFetchBrandGpsr } = require('../lib/gpsr-gemini-lookup');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function isNonEmpty(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/**
 * Return all brands that have AT LEAST ONE product but ZERO products with
 * usable GPSR (no manufacturer_name AND no manufacturer_address).
 */
function findOrphanBrands(products) {
  const brandMap = new Map(); // brand-lc → { brandDisplay, productCount, hasAnyGpsr }
  for (const p of products) {
    const brandRaw = safeString(p?.identification?.brand || p?.details?.brand || p?.details?.identifiers?.brand);
    if (!brandRaw) continue;
    const key = brandRaw.toLowerCase();
    let entry = brandMap.get(key);
    if (!entry) {
      entry = { brandDisplay: brandRaw, productCount: 0, hasAnyGpsr: false };
      brandMap.set(key, entry);
    }
    entry.productCount += 1;
    const g = p?.details?.gpsr;
    if (g && typeof g === 'object') {
      const hasName = isNonEmpty(g.manufacturer_name) || isNonEmpty(g.name);
      const hasAddr = isNonEmpty(g.manufacturer_address) || isNonEmpty(g.address);
      if (hasName || hasAddr) entry.hasAnyGpsr = true;
    }
  }
  const orphans = [];
  for (const [, entry] of brandMap) {
    if (!entry.hasAnyGpsr && entry.productCount > 0) orphans.push(entry);
  }
  // Sort by productCount desc so the biggest fixes come first
  orphans.sort((a, b) => b.productCount - a.productCount);
  return orphans;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const dryRun = String(process.env.DRY_RUN || '').trim() === '1';
  const limit = parseInt(process.env.ORPHAN_BRAND_LIMIT || '0', 10) || 0;
  const sleepMs = parseInt(process.env.ORPHAN_BRAND_SLEEP_MS || '400', 10);
  const tenantId = (process.env.TENANT_ID || '').trim();

  console.log(JSON.stringify({
    action: 'gpsr-backfill-orphan-brands-gemini',
    dry_run: dryRun,
    limit,
    sleep_ms: sleepMs,
    tenant_id: tenantId || null,
  }, null, 2));

  // 1. Load all products
  let products;
  if (tenantId) {
    const { getAllProductsV2ForTenant } = require('../lib/product-store');
    products = await getAllProductsV2ForTenant(tenantId);
  } else {
    products = await getAllProductsV2();
  }
  console.log(`Loaded ${products.length} products from products_v2`);

  // 2. Determine orphan brands
  const orphans = findOrphanBrands(products);
  console.log(`Found ${orphans.length} orphan brands (zero GPSR anywhere)`);
  if (orphans.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // 3. Bucket products by brand-lc for fast assignment
  const productsByBrandLc = new Map();
  for (const p of products) {
    const brandRaw = safeString(p?.identification?.brand || p?.details?.brand || p?.details?.identifiers?.brand);
    if (!brandRaw) continue;
    const key = brandRaw.toLowerCase();
    if (!productsByBrandLc.has(key)) productsByBrandLc.set(key, []);
    productsByBrandLc.get(key).push(p);
  }

  // 4. For each orphan brand: Gemini lookup + (if hit) bulk-write
  let brandsProcessed = 0;
  let brandsHit = 0;
  let productsEnriched = 0;
  const todo = limit > 0 ? orphans.slice(0, limit) : orphans;

  for (const orphan of todo) {
    brandsProcessed += 1;
    const brand = orphan.brandDisplay;
    process.stdout.write(`[${brandsProcessed}/${todo.length}] ${brand} (${orphan.productCount} products) → `);

    let result = null;
    try {
      result = await getOrFetchBrandGpsr(brand);
    } catch (err) {
      console.log(`ERROR: ${err?.message || err}`);
      continue;
    }

    if (!result || !result.gpsr || (!result.gpsr.manufacturer_name && !result.gpsr.manufacturer_address)) {
      console.log('no match');
      await sleep(sleepMs);
      continue;
    }

    brandsHit += 1;
    const newGpsr = { ...result.gpsr };
    const cachedNote = result.cached ? ' (cache)' : ` (conf=${(result.confidence ?? 0).toFixed(2)})`;

    if (dryRun) {
      console.log(`HIT ${result.gpsr.manufacturer_name || '?'} → ${orphan.productCount} products (dry-run)${cachedNote}`);
      await sleep(sleepMs);
      continue;
    }

    const brandProducts = productsByBrandLc.get(brand.toLowerCase()) || [];
    let savedCount = 0;
    let failedCount = 0;
    for (const p of brandProducts) {
      try {
        const merged = { ...(p?.details?.gpsr || {}) };
        // Fill any missing field — existing values are NOT overwritten
        for (const [k, v] of Object.entries(newGpsr)) {
          if (v == null || v === '') continue;
          if (merged[k] == null || merged[k] === '') merged[k] = v;
        }
        const updated = {
          ...p,
          id: p.id,
          details: { ...(p.details || {}), gpsr: merged },
        };
        await saveProductV2(updated, {
          source: 'gemini-brand-gpsr-backfill',
          skipStockEvent: true,
        });
        savedCount += 1;
      } catch (err) {
        failedCount += 1;
        console.error(`\n  ! failed to save ${p?.id || '?'}: ${err?.message || err}`);
      }
    }
    productsEnriched += savedCount;
    console.log(`HIT → ${savedCount} saved${failedCount ? `, ${failedCount} failed` : ''}${cachedNote}`);
    await sleep(sleepMs);
  }

  console.log(JSON.stringify({
    done: true,
    brands_processed: brandsProcessed,
    brands_hit: brandsHit,
    brands_no_match: brandsProcessed - brandsHit,
    products_enriched: productsEnriched,
    dry_run: dryRun,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { findOrphanBrands };
