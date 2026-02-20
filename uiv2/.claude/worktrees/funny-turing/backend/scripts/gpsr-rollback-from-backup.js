#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Roll back GPSR changes from ops.data_quality.gpsr_backup_v1.
 *
 * This is the safety net for the enforcement rollout.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-rollback-from-backup.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-rollback-from-backup.js --apply
 *
 * Options:
 *   --brand <name>        limit to one brand (identification.brand)
 *   --limit <n>           cap products processed (default 5000)
 *   --concurrency <n>     parallel saves (default 6, max 12)
 *
 * Notes:
 * - Restores manufacturer-level GPSR keys from the normalized backup snapshot.
 * - Does NOT delete the backup record (kept for forensics).
 */

const PQueue = require('p-queue').default || require('p-queue');
const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { normalizeManufacturerKey, normalizeGpsrObject } = require('../lib/gpsr-manufacturer-registry');

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

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;

  const brandFilter = safeString(argValue('--brand', process.env.BRAND || ''));
  const brandFilterKey = brandFilter ? normalizeManufacturerKey(brandFilter) : '';
  const limit = Math.max(1, parseInt(argValue('--limit', process.env.LIMIT || '5000') || '5000', 10));
  const concurrency = Math.max(1, Math.min(12, parseInt(argValue('--concurrency', process.env.CONCURRENCY || '6') || '6', 10)));

  console.log(JSON.stringify({ action: 'gpsr-rollback-from-backup', dryRun, brandFilter, limit, concurrency }, null, 2));

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  const candidates = products
    .filter((p) => {
      const brand = pickBrand(p);
      const key = normalizeManufacturerKey(brand);
      if (!key) return false;
      if (brandFilterKey && key !== brandFilterKey) return false;
      return true;
    })
    .slice(0, limit);

  const queue = new PQueue({ concurrency });
  let processed = 0;
  let reverted = 0;
  let skipped = 0;
  let failed = 0;
  const samples = [];

  await Promise.all(
    candidates.map((p) =>
      queue.add(async () => {
        processed += 1;
        try {
          const fresh = await getProduct(String(p.id)).catch(() => null);
          const cur = fresh || p;
          const dq = cur?.ops?.data_quality || {};
          const backup = dq?.gpsr_backup_v1 || null;
          const before = backup?.before && typeof backup.before === 'object' ? backup.before : null;
          if (!before || !Object.keys(before).length) {
            skipped += 1;
            return;
          }

          const existing = pickGpsr(cur);
          const existingNorm = normalizeGpsrObject(existing);

          // Restore only manufacturer-level keys from backup (backup is normalized)
          const next = { ...(existing || {}) };
          MANUFACTURER_KEYS.forEach((k) => {
            if (before[k] != null && String(before[k]).trim() !== '') {
              next[k] = before[k];
            } else {
              // If backup doesn't have the key, leave as-is.
            }
          });

          const nextNorm = normalizeGpsrObject(next);
          const changed = JSON.stringify(existingNorm) !== JSON.stringify(nextNorm);
          if (!changed) {
            skipped += 1;
            return;
          }

          if (samples.length < 10) {
            samples.push({
              productId: cur.id,
              brand: pickBrand(cur),
              backup_at: backup?.at_iso || null,
              before: existingNorm,
              after: nextNorm,
            });
          }

          if (!dryRun) {
            await saveProduct(
              {
                ...cur,
                details: { ...(cur.details || {}), gpsr: next },
                ops: {
                  ...(cur.ops || {}),
                  data_quality: {
                    ...((cur.ops || {}).data_quality || {}),
                    gpsr_registry_rollback_v1: {
                      at_iso: new Date().toISOString(),
                      backup_at_iso: backup?.at_iso || null,
                    },
                  },
                },
              },
              { source: 'script', skipTitlePolicy: true, skipKeyFeaturesNormalize: true }
            );
          }

          reverted += 1;
        } catch {
          failed += 1;
        }

        if (processed % 200 === 0 || processed === 1) {
          console.log(JSON.stringify({ progress: processed, reverted, skipped, failed }, null, 2));
        }
      })
    )
  );

  console.log(JSON.stringify({ done: true, dryRun, processed, reverted, skipped, failed, samples }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

