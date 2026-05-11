#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Override via TENANT_ID env var.
 */
/**
 * Seed manufacturer GPSR registry from existing products, grouped by Brand (Brand == Hersteller).
 *
 * This is a bootstrap tool when:
 * - you already have some correct GPSR values on some products
 * - but many products differ / are incomplete
 *
 * Strategy per brand:
 * - pick the "best" existing GPSR object based on score + optional evidence markers
 * - upsert into gpsrManufacturers (mergePreferMoreComplete ensures no regressions)
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-seed-registry-from-products-by-brand.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-seed-registry-from-products-by-brand.js --apply
 *
 * Options:
 *   --brand <name>        limit to one brand
 *   --brand-limit <n>     limit brands processed (default 999999)
 *   --min-score <n>       only seed if scoreGpsr >= n (default 4)
 */

const {
  normalizeManufacturerKey,
  normalizeGpsrObject,
  scoreGpsr,
  upsertManufacturerGpsr,
} = require('../lib/gpsr-manufacturer-registry');
const { getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function pickBrand(p) {
  return safeString(p?.identification?.brand) || safeString(p?.details?.brand) || '';
}

function pickGpsr(p) {
  const g = p?.details?.gpsr;
  return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
}

function getEvidenceBoost(p) {
  // Prefer records that came from web enrichment / strong sources.
  const dq = p?.ops?.data_quality || {};
  const marker = dq?.gpsr_web_enrich_v1 || dq?.gpsr_manufacturer_enrich_v1 || null;
  const conf = typeof marker?.confidence === 'number' ? marker.confidence : 0;
  const hasSources = Array.isArray(marker?.sources) && marker.sources.length > 0;
  let boost = 0;
  if (hasSources) boost += 1;
  if (conf >= 0.6) boost += 1;
  if (conf >= 0.8) boost += 1;
  return boost;
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;

  const brandFilter = safeString(argValue('--brand', process.env.BRAND || ''));
  const brandFilterKey = brandFilter ? normalizeManufacturerKey(brandFilter) : '';
  const brandLimit = Math.max(1, parseInt(argValue('--brand-limit', process.env.BRAND_LIMIT || '999999') || '999999', 10));
  const minScore = Math.max(0, parseInt(argValue('--min-score', process.env.MIN_SCORE || '4') || '4', 10));

  console.log(JSON.stringify({ action: 'gpsr-seed-registry-from-products-by-brand', dryRun, brandFilter, brandLimit, minScore }, null, 2));

  const all = await getAllProductsForTenant(TENANT_ID);
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  const bestByBrand = new Map(); // brandKey -> { brand, gpsr, score, boosted, productId, confidence, sources }
  for (const p of products) {
    const brand = pickBrand(p);
    const key = normalizeManufacturerKey(brand);
    if (!key) continue;
    if (brandFilterKey && key !== brandFilterKey) continue;

    const normalized = normalizeGpsrObject(pickGpsr(p));
    if (!Object.keys(normalized).length) continue;
    // Ensure manufacturer_name matches brand for Brand==Hersteller setup
    if (!normalized.manufacturer_name) normalized.manufacturer_name = brand;

    const baseScore = scoreGpsr(normalized);
    const boost = getEvidenceBoost(p);
    const boosted = baseScore + boost;
    if (baseScore < minScore) continue;

    const cur = bestByBrand.get(key);
    if (!cur || boosted > cur.boosted) {
      const dq = p?.ops?.data_quality || {};
      const marker = dq?.gpsr_web_enrich_v1 || dq?.gpsr_manufacturer_enrich_v1 || null;
      const conf = typeof marker?.confidence === 'number' ? marker.confidence : null;
      const sources = Array.isArray(marker?.sources) ? marker.sources : [];
      bestByBrand.set(key, {
        key,
        brand,
        gpsr: normalized,
        score: baseScore,
        boosted,
        productId: p.id,
        confidence: conf,
        sources,
      });
    }
  }

  const brands = Array.from(bestByBrand.values())
    .sort((a, b) => b.boosted - a.boosted)
    .slice(0, brandLimit);

  console.log(JSON.stringify({ candidates: brands.length, preview: brands.slice(0, 5) }, null, 2));

  let upserted = 0;
  let skipped = 0;
  let failed = 0;

  for (const rec of brands) {
    if (dryRun) {
      skipped += 1;
      continue;
    }
    try {
      const res = await upsertManufacturerGpsr({
        manufacturer_name: rec.brand,
        gpsr: rec.gpsr,
        confidence: rec.confidence,
        sources: rec.sources,
        from_product_id: rec.productId,
      });
      if (res?.ok) upserted += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }

  console.log(JSON.stringify({ done: true, dryRun, candidates: brands.length, upserted, skipped, failed }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

