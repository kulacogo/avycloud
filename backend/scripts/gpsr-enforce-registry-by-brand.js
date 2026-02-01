#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Enforce manufacturer GPSR registry per Brand (Brand == Hersteller):
 * - Backup existing per-product GPSR into ops.data_quality.gpsr_backup_v1
 * - Overwrite manufacturer-level GPSR keys from registry (even if different)
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-enforce-registry-by-brand.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-enforce-registry-by-brand.js --apply
 *
 * Options:
 *   --brand <name>        limit to one brand
 *   --limit <n>           cap products (default 5000)
 *   --concurrency <n>     parallel saves (default 6, max 12)
 *
 * Notes:
 * - This does not invent data. It only applies registry values.
 * - saveProduct() will apply its own deterministic normalizations too.
 */

const PQueue = require('p-queue').default || require('p-queue');
const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const {
  normalizeManufacturerKey,
  normalizeGpsrObject,
  getManufacturerGpsrByName,
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

function pickBrand(p) {
  return safeString(p?.identification?.brand) || safeString(p?.details?.brand) || '';
}

function pickGpsr(p) {
  const g = p?.details?.gpsr;
  return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
}

function diffKeys(before, after) {
  const changes = [];
  for (const k of MANUFACTURER_KEYS) {
    const a = safeString(before?.[k]);
    const b = safeString(after?.[k]);
    if (a !== b) changes.push(k);
  }
  return changes;
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;

  const brandFilter = safeString(argValue('--brand', process.env.BRAND || ''));
  const brandFilterKey = brandFilter ? normalizeManufacturerKey(brandFilter) : '';
  const limit = Math.max(1, parseInt(argValue('--limit', process.env.LIMIT || '5000') || '5000', 10));
  const concurrency = Math.max(
    1,
    Math.min(12, parseInt(argValue('--concurrency', process.env.CONCURRENCY || '6') || '6', 10))
  );

  console.log(JSON.stringify({ action: 'gpsr-enforce-registry-by-brand', dryRun, brandFilter, limit, concurrency }, null, 2));

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  const selected = products
    .filter((p) => {
      const brand = pickBrand(p);
      const key = normalizeManufacturerKey(brand);
      if (!key) return false;
      if (brandFilterKey && key !== brandFilterKey) return false;
      return true;
    })
    .slice(0, limit);

  // Cache registry lookups per brandKey
  const registryCache = new Map(); // brandKey -> { key, gpsr, confidence } | null
  const getReg = async (brand) => {
    const key = normalizeManufacturerKey(brand);
    if (!key) return null;
    if (registryCache.has(key)) return registryCache.get(key);
    const reg = await getManufacturerGpsrByName(brand).catch(() => null);
    const gpsr = reg?.gpsr && typeof reg.gpsr === 'object' ? reg.gpsr : null;
    const out = gpsr && Object.keys(gpsr).length ? { key: reg.key || key, gpsr, confidence: reg.confidence ?? null } : null;
    registryCache.set(key, out);
    return out;
  };

  const queue = new PQueue({ concurrency });
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let missingRegistry = 0;
  let failed = 0;

  const sampleDiffs = [];

  await Promise.all(
    selected.map((p) =>
      queue.add(async () => {
        processed += 1;
        try {
          const fresh = await getProduct(String(p.id)).catch(() => null);
          const cur = fresh || p;
          const brand = pickBrand(cur);
          if (!brand) {
            skipped += 1;
            return;
          }
          const reg = await getReg(brand);
          if (!reg?.gpsr) {
            missingRegistry += 1;
            return;
          }

          const existingGpsr = pickGpsr(cur);
          const normalizedExisting = normalizeGpsrObject(existingGpsr);
          const normalizedReg = normalizeGpsrObject(reg.gpsr);

          // Overwrite manufacturer-level keys from registry; keep any extra keys that might exist
          const nextGpsr = { ...(existingGpsr || {}) };
          MANUFACTURER_KEYS.forEach((k) => {
            if (normalizedReg[k] != null && normalizedReg[k] !== '') {
              nextGpsr[k] = normalizedReg[k];
            }
          });
          // Ensure manufacturer_name is present (Brand==Hersteller)
          if (!safeString(nextGpsr.manufacturer_name)) {
            nextGpsr.manufacturer_name = brand;
          }

          const normalizedNext = normalizeGpsrObject(nextGpsr);
          const changes = diffKeys(normalizedExisting, normalizedNext);
          if (!changes.length) {
            skipped += 1;
            return;
          }

          if (sampleDiffs.length < 10) {
            sampleDiffs.push({
              productId: cur.id,
              brand,
              changedKeys: changes,
              before: normalizedExisting,
              after: normalizedNext,
              registryKey: reg.key,
            });
          }

          if (!dryRun) {
            const backup = {
              at_iso: new Date().toISOString(),
              brand,
              registry_key: reg.key,
              registry_confidence: reg.confidence ?? null,
              before: normalizedExisting,
              // keep a small hint of what changed (for quick rollback triage)
              changed_keys: changes,
            };

            await saveProduct(
              {
                ...cur,
                details: { ...(cur.details || {}), gpsr: nextGpsr },
                ops: {
                  ...(cur.ops || {}),
                  data_quality: {
                    ...((cur.ops || {}).data_quality || {}),
                    gpsr_backup_v1: backup,
                    gpsr_registry_enforce_v1: {
                      at_iso: new Date().toISOString(),
                      brand,
                      registry_key: reg.key,
                      registry_confidence: reg.confidence ?? null,
                    },
                  },
                },
              },
              { source: 'script', skipTitlePolicy: true, skipKeyFeaturesNormalize: true }
            );
          }

          updated += 1;
        } catch (e) {
          failed += 1;
          if (sampleDiffs.length < 10) {
            sampleDiffs.push({ error: e?.message || String(e) });
          }
        }

        if (processed % 200 === 0 || processed === 1) {
          console.log(JSON.stringify({ progress: processed, updated, skipped, missingRegistry, failed }, null, 2));
        }
      })
    )
  );

  console.log(
    JSON.stringify(
      { done: true, dryRun, processed, updated, skipped, missingRegistry, failed, sampleDiffs },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

