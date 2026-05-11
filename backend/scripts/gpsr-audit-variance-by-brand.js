#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Override via TENANT_ID env var.
 */
/**
 * Audit GPSR variance per Brand (Brand == Hersteller).
 *
 * Outputs:
 * - CSV report: backend/exports/gpsr-audit/gpsr-variance-<stamp>.csv
 *
 * What it measures:
 * - total products per brand
 * - distinct GPSR "raw" signatures (trimmed strings; includes placeholders)
 * - distinct GPSR "normalized" signatures (placeholders dropped)
 * - registry presence + mismatch counts vs registry (per brand, cached)
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-audit-variance-by-brand.js
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-audit-variance-by-brand.js --brand "TT. BAGATT"
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-audit-variance-by-brand.js --limit 2000
 *
 * Notes:
 * - This is read-only.
 */
const fs = require('fs');
const path = require('path');

const { getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
const {
  getManufacturerGpsrByName,
  normalizeGpsrObject,
  normalizeManufacturerKey,
  isGpsrPlaceholderLike,
} = require('../lib/gpsr-manufacturer-registry');

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

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds()
  )}`;
}

const MANUFACTURER_KEYS = [
  'entity_country',
  'manufacturer_name',
  'manufacturer_address',
  'manufacturer_city',
  'manufacturer_postalcode',
  'manufacturer_state_province',
  'email',
  'manufacturer_phone',
  'url',
];

function pickBrand(product) {
  // Per requirement: Brand == Hersteller (single grouping key).
  return safeString(product?.identification?.brand) || safeString(product?.details?.brand) || '';
}

function pickGpsrObj(product) {
  const g = product?.details?.gpsr;
  return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
}

function normalizeForSignatureRaw(gpsrObj) {
  const g = gpsrObj && typeof gpsrObj === 'object' ? gpsrObj : {};
  const out = {};
  for (const k of MANUFACTURER_KEYS) {
    const v = g[k];
    if (v === null || v === undefined) continue;
    const s = typeof v === 'string' ? v.trim() : String(v).trim();
    if (!s) continue;
    out[k] = s;
  }
  return out;
}

function stableJson(obj) {
  const keys = Object.keys(obj || {}).sort();
  const out = {};
  keys.forEach((k) => {
    out[k] = obj[k];
  });
  return JSON.stringify(out);
}

function toCsv(rows, header) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((h) => esc(r[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

async function main() {
  if (argFlag('--help') || argFlag('-h')) {
    console.log(
      [
        'gpsr-audit-variance-by-brand.js',
        '',
        'Options:',
        '  --brand <name>     limit to one brand (case-insensitive exact key normalization)',
        '  --limit <n>        cap products processed (default: 999999)',
        '',
      ].join('\n')
    );
    process.exit(0);
  }

  const brandFilter = safeString(argValue('--brand', process.env.BRAND || ''));
  const brandFilterKey = brandFilter ? normalizeManufacturerKey(brandFilter) : '';
  const limit = Math.max(1, parseInt(argValue('--limit', process.env.LIMIT || '999999') || '999999', 10));

  const all = await getAllProductsForTenant(TENANT_ID);
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];
  const selected = products.slice(0, limit);

  // Cache registry lookups per brand key (1 call per brand)
  const registryCache = new Map(); // brandKey -> { key, gpsr } | null
  const getRegForBrand = async (brand) => {
    const b = safeString(brand);
    const key = normalizeManufacturerKey(b);
    if (!key) return null;
    if (registryCache.has(key)) return registryCache.get(key);
    const reg = await getManufacturerGpsrByName(b).catch(() => null);
    const gpsr = reg?.gpsr && typeof reg.gpsr === 'object' ? reg.gpsr : null;
    const out = gpsr && Object.keys(gpsr).length ? { key: reg.key || key, gpsr } : null;
    registryCache.set(key, out);
    return out;
  };

  const byBrand = new Map(); // key -> { brand, products: [] }
  for (const p of selected) {
    const brand = pickBrand(p);
    const key = normalizeManufacturerKey(brand);
    if (!key) continue;
    if (brandFilterKey && key !== brandFilterKey) continue;
    const entry = byBrand.get(key) || { brand, key, products: [] };
    entry.products.push(p);
    // keep first observed display brand for reporting
    if (!entry.brand) entry.brand = brand;
    byBrand.set(key, entry);
  }

  const rows = [];
  for (const entry of byBrand.values()) {
    const brand = entry.brand;
    const brandKey = entry.key;
    const ps = entry.products;
    const rawSigs = new Set();
    const normalizedSigs = new Set();
    let placeholderHits = 0;

    // registry mismatch counters (normalized compare)
    const reg = await getRegForBrand(brand);
    const regNorm = reg?.gpsr ? normalizeGpsrObject(reg.gpsr) : null;
    const hasRegistry = Boolean(regNorm && Object.keys(regNorm).length);
    let mismatchToRegistry = 0;
    let missingAnyRequired = 0;

    for (const p of ps) {
      const g = pickGpsrObj(p);
      const raw = normalizeForSignatureRaw(g);
      rawSigs.add(stableJson(raw));

      // count placeholder-like in manufacturer keys
      for (const k of MANUFACTURER_KEYS) {
        const v = safeString(g?.[k]);
        if (v && isGpsrPlaceholderLike(v)) {
          placeholderHits += 1;
          break;
        }
      }

      const norm = normalizeGpsrObject(g);
      normalizedSigs.add(stableJson(norm));

      // quick missing required: treat placeholder-like as missing
      const required = ['entity_country', 'manufacturer_name', 'manufacturer_address', 'manufacturer_city', 'manufacturer_postalcode', 'email'];
      const hasMissing = required.some((k) => {
        const v = safeString(g?.[k]);
        return !v || isGpsrPlaceholderLike(v);
      });
      if (hasMissing) missingAnyRequired += 1;

      if (hasRegistry) {
        const same = stableJson(norm) === stableJson(regNorm);
        if (!same) mismatchToRegistry += 1;
      }
    }

    rows.push({
      brand: brand || brandKey,
      brand_key: brandKey,
      products_total: ps.length,
      distinct_gpsr_raw: rawSigs.size,
      distinct_gpsr_normalized: normalizedSigs.size,
      has_registry: hasRegistry ? 1 : 0,
      mismatching_registry_products: hasRegistry ? mismatchToRegistry : '',
      products_missing_required_or_placeholder: missingAnyRequired,
      placeholder_like_any: placeholderHits,
    });
  }

  // sort: most severe first
  rows.sort((a, b) => {
    const av = Number(a.distinct_gpsr_normalized || 0);
    const bv = Number(b.distinct_gpsr_normalized || 0);
    if (bv !== av) return bv - av;
    return Number(b.products_total || 0) - Number(a.products_total || 0);
  });

  const outDir = path.resolve('backend/exports/gpsr-audit');
  ensureDir(outDir);
  const outPath = path.join(outDir, `gpsr-variance-${nowStamp()}.csv`);

  const header = [
    'brand',
    'brand_key',
    'products_total',
    'distinct_gpsr_raw',
    'distinct_gpsr_normalized',
    'has_registry',
    'mismatching_registry_products',
    'products_missing_required_or_placeholder',
    'placeholder_like_any',
  ];
  fs.writeFileSync(outPath, toCsv(rows, header), 'utf8');
  console.log(JSON.stringify({ ok: true, brands: rows.length, output: outPath }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

