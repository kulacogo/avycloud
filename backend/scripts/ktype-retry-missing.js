/* eslint-disable no-console */
/**
 * Retry K-Typ enrichment for fitment-category products that still miss K-Typ.
 *
 * Why:
 * - Bis 2026-07-16 lief die K-Typ-Anreicherung im Identify-Post-Processing PARALLEL
 *   zur Kategorie-Auflösung. Sie sah dadurch eine leere categoryId und skippte mit
 *   `not_fitment_category` (traceCatId=null), obwohl die Produkte heute eine gültige
 *   Fitment-Kategorie tragen (Audit 2026-07-16: 99 von 126 fehlenden K-Typ so entstanden).
 * - Dieses Script heilt den Bestand: es ruft die EXISTIERENDE enrichKTypIfPossible()
 *   erneut auf — evidenzbasiert, kein Raten — und speichert nur bei Treffer.
 *
 * Scope:
 * - Nur Produkte, deren aktuelle eBay-Kategorie eine Fahrzeugverwendungsliste
 *   unterstützt (vehicle-fitment-categories.json) und die keinen numerischen
 *   K-Typ-Wert haben. `already_has_ktype`/manuelle Werte bleiben unberührt
 *   (enrichKTypIfPossible skippt selbst).
 *
 * Usage:
 *   USE_PRODUCTS_V2=true TENANT_ID=default node backend/scripts/ktype-retry-missing.js --limit 200
 *   USE_PRODUCTS_V2=true TENANT_ID=default node backend/scripts/ktype-retry-missing.js --limit 200 --apply
 */

const { getAllProductsForTenant } = require('../lib/firestore');
const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
const { enrichKTypIfPossible } = require('../lib/ktype-enrichment');
const { saveProductV2 } = require('../lib/product-store');

// Scripts-only default per CLAUDE.md; Prod-Daten liegen unter TENANT_ID=default.
const TENANT_ID = process.env.TENANT_ID || 'avycloud';

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

function hasNumericKTyp(product) {
  const attrs = product?.details?.attributes;
  if (!attrs || typeof attrs !== 'object') return false;
  return Object.keys(attrs).some((k) => {
    const lower = safeString(k).toLowerCase();
    if (!(lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ')) return false;
    const raw = safeString(attrs[k]);
    if (!raw) return false;
    return raw.split(/[|,;]+/).map((x) => safeString(x)).filter(Boolean).some((p) => /^\d+$/.test(p));
  });
}

async function main() {
  const APPLY = argFlag('--apply');
  const limit = Math.max(1, parseInt(argValue('--limit', '200') || '200', 10));

  console.log(
    JSON.stringify({ action: 'ktype-retry-missing', tenant: TENANT_ID, dryRun: !APPLY, limit }, null, 2)
  );

  const all = await getAllProductsForTenant(TENANT_ID);
  const candidates = (all || []).filter((p) => {
    if (!p?.id) return false;
    const catId = safeString(p?.details?.categoryId) || safeString(p?.details?.ebayCategoryId);
    if (!catId || !getVehicleFitmentMode(catId)) return false;
    return !hasNumericKTyp(p);
  });

  console.log(`Candidates (fitment category, missing K-Typ): ${candidates.length} — attempting up to ${limit}`);

  const results = { attempted: 0, enriched: 0, saved: 0, no_matches: 0, other_skips: {}, errors: 0 };
  const enrichedSamples = [];

  for (const product of candidates.slice(0, limit)) {
    results.attempted += 1;
    try {
      const res = await enrichKTypIfPossible(product, { reason: 'retry-missing' });
      if (res?.ok && Array.isArray(res.ids) && res.ids.length) {
        results.enriched += 1;
        if (enrichedSamples.length < 20) {
          enrichedSamples.push({
            id: product.id,
            sku: product?.identification?.sku || null,
            count: res.ids.length,
            fitmentMode: res.fitmentMode,
          });
        }
        if (APPLY) {
          await saveProductV2(product, { mode: 'system', source: 'ktype-retry-missing' });
          results.saved += 1;
        }
      } else if (res?.reason === 'no_matches') {
        results.no_matches += 1;
        // Trace (ops.data_quality.ktype_enrich_v1) auch im no_matches-Fall persistieren,
        // damit Folge-Audits den frischen Versuch sehen — aber nur bei --apply.
        if (APPLY) {
          await saveProductV2(product, { mode: 'system', source: 'ktype-retry-missing' });
        }
      } else {
        const r = safeString(res?.reason) || 'unknown';
        results.other_skips[r] = (results.other_skips[r] || 0) + 1;
      }
    } catch (e) {
      results.errors += 1;
      console.warn(`[ktype-retry-missing] ${product.id} failed:`, e?.message || e);
    }
    if (results.attempted % 10 === 0) {
      console.log(`progress: ${results.attempted}/${Math.min(limit, candidates.length)} enriched=${results.enriched}`);
    }
  }

  console.log(JSON.stringify({ ok: true, dryRun: !APPLY, results, enrichedSamples }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error('ktype-retry-missing failed:', e?.stack || e);
  process.exit(1);
});
