/* eslint-disable no-console */
/**
 * Apply manufacturer GPSR registry to all products (fill missing fields, replace placeholders).
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-apply-registry-to-all-products.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-apply-registry-to-all-products.js --apply
 *
 * Options:
 *   --concurrency <n> (default 8, max 12)
 */

const PQueue = require('p-queue').default || require('p-queue');
const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { getManufacturerGpsrByName, mergePreferMoreComplete } = require('../lib/gpsr-manufacturer-registry');

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

function pickManufacturerName(p) {
  return (
    safeString(p?.details?.gpsr?.manufacturer_name) ||
    safeString(p?.identification?.brand) ||
    safeString(p?.details?.brand) ||
    ''
  );
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;
  const concurrency = Math.max(1, Math.min(12, parseInt(argValue('--concurrency', process.env.CONCURRENCY || '8') || '8', 10)));

  console.log(JSON.stringify({ action: 'gpsr-apply-registry-to-all-products', dryRun, concurrency }, null, 2));

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  const queue = new PQueue({ concurrency });
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    products.map((p) =>
      queue.add(async () => {
        processed += 1;
        try {
          const fresh = await getProduct(String(p.id)).catch(() => null);
          const cur = fresh || p;
          const manufacturer = pickManufacturerName(cur);
          if (!manufacturer) {
            skipped += 1;
            return;
          }
          const reg = await getManufacturerGpsrByName(manufacturer).catch(() => null);
          if (!reg?.gpsr || !Object.keys(reg.gpsr).length) {
            skipped += 1;
            return;
          }
          const existing = cur?.details?.gpsr && typeof cur.details.gpsr === 'object' ? { ...cur.details.gpsr } : {};
          const merged = mergePreferMoreComplete(existing, reg.gpsr);
          const changed = JSON.stringify(existing) !== JSON.stringify(merged);
          if (!changed) {
            skipped += 1;
            return;
          }

          if (!dryRun) {
            await saveProduct(
              {
                ...cur,
                details: { ...(cur.details || {}), gpsr: merged },
                ops: {
                  ...(cur.ops || {}),
                  data_quality: {
                    ...((cur.ops || {}).data_quality || {}),
                    gpsr_registry_apply_v1: {
                      at_iso: new Date().toISOString(),
                      manufacturer,
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
        } catch {
          failed += 1;
        }
        if (processed % 100 === 0 || processed === 1) {
          console.log(JSON.stringify({ progress: processed, updated, skipped, failed }, null, 2));
        }
      })
    )
  );

  console.log(JSON.stringify({ done: true, dryRun, processed, updated, skipped, failed }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

