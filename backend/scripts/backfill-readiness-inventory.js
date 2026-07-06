'use strict';

/**
 * backfill-readiness-inventory.js — schreibt "Ausstehend" (pending) fest in die
 * Daten für alle Bestand-Produkte (mit Lagerplatz / Menge) ohne gültigen
 * gespeicherten Status.
 *
 * Hintergrund: Die Anzeige normalisiert "kein Status" ohnehin zu "Ausstehend"
 * (utils/readiness normalizeReadiness). Dieser Backfill macht den Wert explizit —
 * damit z. B. ein Datenexport keinen leeren Status enthält. Ändert NICHTS an
 * Produkten ohne Lagerplatz und nichts an bereits gültigen Status (ready/
 * in_progress/pending). Bestand-neutral (skipStockEvent).
 *
 * DRY-RUN by default. Braucht USE_PRODUCTS_V2=true.
 */

const VALID_READINESS = new Set(['ready', 'in_progress', 'pending']);

/** Ist das Produkt im Bestand (hat Lagerplatz oder Menge)? Spiegelt AdminTable hasBin. */
function hasInventory(product) {
  const bins = product?.storageBins;
  return (
    (Array.isArray(bins) && bins.length > 0) ||
    Number(product?.inventory?.quantity) > 0 ||
    Boolean(product?.storage?.binCode)
  );
}

/** Braucht das Produkt einen Status-Nachtrag? (im Bestand + kein gültiger Status) */
function needsReadinessBackfill(product) {
  return hasInventory(product) && !VALID_READINESS.has(product?.ops?.readiness);
}

/**
 * Setzt "pending" bei betroffenen Produkten. I/O injiziert (products + saveProduct).
 * deps: { products, saveProduct: async(p)=>{}, apply=false, nowIso, log }
 */
async function runBackfill({ products, saveProduct, apply = false, nowIso, log = () => {} }) {
  let scanned = 0;
  let backfilled = 0;
  for (const p of products) {
    scanned += 1;
    if (!needsReadinessBackfill(p)) continue;
    p.ops = p.ops || {};
    p.ops.readiness = 'pending';
    p.ops.readiness_editor = 'system-backfill';
    p.ops.readiness_set_at = nowIso;
    if (apply) await saveProduct(p);
    backfilled += 1;
    log(`  ${apply ? 'gesetzt' : 'würde setzen'} ${p.id} → Ausstehend`);
  }
  return { scanned, backfilled };
}

function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return { apply: argv.includes('--apply'), tenant: val('--tenant') || 'default' };
}

module.exports = { hasInventory, needsReadinessBackfill, runBackfill, parseArgs };

// ─── CLI (dünne Glue über den getesteten Kern) ─────────────────────────────
if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (process.env.USE_PRODUCTS_V2 !== 'true') {
      console.error('❌ USE_PRODUCTS_V2=true erforderlich. Abbruch.');
      process.exit(1);
    }
    const { getAllProductsV2ForTenant, saveProductV2 } = require('../lib/product-store');

    console.log(`[backfill-readiness] tenant=${args.tenant} mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);
    const products = await getAllProductsV2ForTenant(args.tenant);
    console.log(`  Produkte geladen: ${products.length}`);

    const result = await runBackfill({
      products,
      // gleiche sichere Optionen wie migrate-readiness-ki.js: kein Stock-Event,
      // keine Titel-/KeyFeatures-Mangelung — nur der readiness-Wert.
      saveProduct: (p) =>
        saveProductV2(p, {
          source: 'readiness-backfill',
          skipStockEvent: true,
          skipTitlePolicy: true,
          skipKeyFeaturesNormalize: true,
        }),
      apply: args.apply,
      nowIso: new Date().toISOString(),
      log: (m) => process.stdout.write(`${m}\n`),
    });

    console.log(`\n  gescannt: ${result.scanned}, ${args.apply ? 'gesetzt' : 'zu setzen'}: ${result.backfilled}`);
    console.log(args.apply
      ? '\n✅ Status-Nachtrag ausgeführt. Bestand unangetastet.'
      : '\nDRY-RUN — nichts geschrieben. Mit --apply ausführen.');
    process.exit(0);
  })().catch((err) => {
    console.error(`[backfill-readiness] FATAL: ${err.message}`, err);
    process.exit(1);
  });
}
