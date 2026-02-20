/* eslint-disable no-console */
/**
 * Reconcile GPSR data by manufacturer:
 * - Build a canonical GPSR record per manufacturer (from best existing products)
 * - Apply it to all products of that manufacturer (fill missing fields, replace placeholder-like values)
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-reconcile-by-manufacturer.js --dry-run --manufacturer Adidas
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/gpsr-reconcile-by-manufacturer.js --apply --manufacturer Adidas
 *
 * Options:
 *   --manufacturer <name>   limit to one manufacturer (case-insensitive)
 *   --limit <n>             limit products processed (default 5000)
 *   --concurrency <n>       parallel saves (default 3)
 */

const PQueue = require('p-queue').default || require('p-queue');
const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const {
  normalizeManufacturerKey,
  normalizeGpsrObject,
  scoreGpsr,
  mergePreferMoreComplete,
  isGpsrPlaceholderLike,
  upsertManufacturerGpsr,
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

function pickManufacturerName(p) {
  return (
    safeString(p?.details?.gpsr?.manufacturer_name) ||
    safeString(p?.identification?.brand) ||
    safeString(p?.details?.brand) ||
    ''
  );
}

function needsAnyGpsrField(p) {
  const g = p?.details?.gpsr && typeof p.details.gpsr === 'object' ? p.details.gpsr : {};
  const fields = [
    'entity_country',
    'manufacturer_city',
    'manufacturer_address',
    'manufacturer_name',
    'email',
    'manufacturer_phone',
    'manufacturer_state_province',
    'manufacturer_postalcode',
  ];
  for (const f of fields) {
    const v = safeString(g[f]);
    if (!v || isGpsrPlaceholderLike(v)) return true;
  }
  return false;
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;
  const manufacturerFilterRaw = safeString(argValue('--manufacturer', process.env.MANUFACTURER || ''));
  const manufacturerFilterKey = manufacturerFilterRaw ? normalizeManufacturerKey(manufacturerFilterRaw) : '';
  const limit = Math.max(1, parseInt(argValue('--limit', process.env.LIMIT || '5000') || '5000', 10));
  const concurrency = Math.max(1, Math.min(10, parseInt(argValue('--concurrency', process.env.CONCURRENCY || '3') || '3', 10)));

  console.log(JSON.stringify({ action: 'gpsr-reconcile-by-manufacturer', dryRun, manufacturerFilterRaw, limit, concurrency }, null, 2));

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  // Build best-per-manufacturer candidate from existing products.
  const best = new Map(); // key -> { manufacturer_name, gpsr, score, confidence, sources, productId }

  for (const p of products) {
    const mName = pickManufacturerName(p);
    const key = normalizeManufacturerKey(mName);
    if (!key) continue;
    if (manufacturerFilterKey && key !== manufacturerFilterKey) continue;

    const gpsr = normalizeGpsrObject(p?.details?.gpsr);
    if (!Object.keys(gpsr).length) continue;

    const s = scoreGpsr(gpsr);
    const marker = p?.ops?.data_quality?.gpsr_web_enrich_v1;
    const conf = typeof marker?.confidence === 'number' ? marker.confidence : 0;
    const sources = Array.isArray(marker?.sources) ? marker.sources : [];
    const hasSources = Array.isArray(sources) && sources.length > 0;
    const boosted = s + (hasSources ? 1 : 0) + (conf >= 0.6 ? 1 : 0);

    const cur = best.get(key);
    if (!cur || boosted > cur.boosted) {
      best.set(key, {
        key,
        manufacturer_name: mName,
        gpsr,
        score: s,
        boosted,
        confidence: conf,
        sources: sources,
        productId: p.id,
      });
    }
  }

  console.log(JSON.stringify({ manufacturers: best.size, preview: Array.from(best.values()).slice(0, 5) }, null, 2));

  // Upsert registry docs.
  let registryOk = 0;
  for (const rec of best.values()) {
    if (dryRun) continue;
    const res = await upsertManufacturerGpsr({
      manufacturer_name: rec.manufacturer_name,
      gpsr: rec.gpsr,
      confidence: rec.confidence,
      sources: rec.sources,
      from_product_id: rec.productId,
    }).catch((e) => ({ ok: false, reason: e?.message || 'error' }));
    if (res?.ok) registryOk += 1;
  }

  // Apply to products
  const queue = new PQueue({ concurrency });
  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  const selected = products
    .filter((p) => p?.id)
    .filter((p) => {
      const key = normalizeManufacturerKey(pickManufacturerName(p));
      if (!key) return false;
      if (manufacturerFilterKey && key !== manufacturerFilterKey) return false;
      return true;
    })
    .slice(0, limit);

  await Promise.all(
    selected.map((p) =>
      queue.add(async () => {
        processed += 1;
        try {
          const fresh = await getProduct(String(p.id)).catch(() => null);
          const cur = fresh || p;
          const mName = pickManufacturerName(cur);
          const reg = await getManufacturerGpsrByName(mName).catch(() => null);
          if (!reg?.gpsr || !Object.keys(reg.gpsr).length) {
            skipped += 1;
            return;
          }
          const existingGpsr = cur?.details?.gpsr && typeof cur.details.gpsr === 'object' ? { ...cur.details.gpsr } : {};
          const merged = mergePreferMoreComplete(existingGpsr, reg.gpsr);
          const changed = JSON.stringify(existingGpsr) !== JSON.stringify(merged);
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
                      manufacturer: mName,
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
        }
        if (processed % 50 === 0 || processed === 1) {
          console.log(JSON.stringify({ progress: processed, updated, skipped, failed }, null, 2));
        }
      })
    )
  );

  console.log(JSON.stringify({ done: true, dryRun, registryOk, processed, updated, skipped, failed }, null, 2));

  if (!dryRun) {
    // Show remaining need for this manufacturer (quick check)
    const again = await getAllProducts();
    const ps = Array.isArray(again) ? again.filter((p) => p?.id) : [];
    const remaining = ps.filter((p) => {
      const key = normalizeManufacturerKey(pickManufacturerName(p));
      if (manufacturerFilterKey && key !== manufacturerFilterKey) return false;
      return needsAnyGpsrField(p);
    });
    console.log(JSON.stringify({ remaining_needs_gpsr: remaining.length }, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

