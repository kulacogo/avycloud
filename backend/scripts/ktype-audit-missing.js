/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Override via TENANT_ID env var.
 */
/**
 * Audit missing K-Typ for products where eBay category supports vehicle fitment lists.
 *
 * Goal:
 * - quantify why products still miss K-Typ (most often missing MPN / missing fitment category)
 * - provide sample IDs for each bucket so we can iterate quickly
 *
 * Usage:
 *   node backend/scripts/ktype-audit-missing.js --limit 2000
 *   node backend/scripts/ktype-audit-missing.js --limit 2000 --show 20
 */

const { getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');

function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function hasKTyp(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  return Object.keys(attrs).some((k) => {
    const lower = String(k || '').trim().toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
}

function pickPartNumber(product) {
  const ids = product?.details?.identifiers || {};
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  return (
    safeString(ids?.mpn) ||
    safeString(attrs?.Herstellernummer) ||
    safeString(attrs?.MPN) ||
    safeString(attrs?.['Hersteller-Nr.']) ||
    safeString(attrs?.['Hersteller Nr.']) ||
    ''
  );
}

function pickCategoryId(product) {
  return (
    safeString(product?.details?.categoryId) ||
    safeString(product?.details?.ebayCategoryId) ||
    safeString(product?.details?.ebay_category_id) ||
    ''
  );
}

async function main() {
  const limit = Math.max(1, parseInt(argValue('--limit', '2000') || '2000', 10));
  const show = Math.max(0, parseInt(argValue('--show', '10') || '10', 10));

  const all = await getAllProductsForTenant(TENANT_ID);
  const products = Array.isArray(all) ? all.filter((p) => p?.id).slice(0, limit) : [];

  const counters = {
    total_scanned: products.length,
    fitment_total: 0,
    has_ktype: 0,
    missing_ktype: 0,
    missing_part_number: 0,
    mpn_present_missing_ktype: 0,
  };
  const samples = {
    missing_part_number: [],
    mpn_present_missing_ktype: [],
  };

  for (const p of products) {
    const catId = pickCategoryId(p);
    const fitmentMode = catId ? getVehicleFitmentMode(catId) : null;
    if (!fitmentMode) continue;

    counters.fitment_total += 1;
    if (hasKTyp(p)) {
      counters.has_ktype += 1;
      continue;
    }
    counters.missing_ktype += 1;
    const mpn = pickPartNumber(p);
    if (!mpn) {
      counters.missing_part_number += 1;
      if (samples.missing_part_number.length < show) samples.missing_part_number.push(p.id);
    } else {
      counters.mpn_present_missing_ktype += 1;
      if (samples.mpn_present_missing_ktype.length < show) samples.mpn_present_missing_ktype.push(p.id);
    }
  }

  console.log(JSON.stringify({ ok: true, counters, samples }, null, 2));
}

main().catch((e) => {
  console.error('ktype-audit-missing failed:', e?.message || e);
  process.exit(1);
});

