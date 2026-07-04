'use strict';

/**
 * clear-listing-pointers-gmbh.js — After the account swap, products still carry
 * the OLD account's marketplace listing pointers. Clear them so stock-sync can
 * never revise/end a dead/foreign listing under the new token. New listings on
 * the new accounts re-populate the pointers via the listing-sync runner.
 *
 * SAFE by construction (verified by the cutover safety review):
 *  - Round-trips the FULL product doc through saveProductV2 (CLAUDE.md invariant
 *    7: all product writes go through saveProductV2), NEVER a partial patch.
 *  - saveProductV2 writes inventory VERBATIM from the DB for an existing doc
 *    (canWriteWarehouseFields=false) → inventory is untouched (GOLDENE REGEL).
 *  - Passes { skipStockEvent: true } → no pre-read, no ghost-gate, no
 *    stock:changed emit, no inventory_ledger write. Pointers are explicit null
 *    (not undefined, which sanitizeFirestoreValue would strip).
 *
 * Run only during the quiesced cutover window, AFTER the mirror collections are
 * wiped. Requires USE_PRODUCTS_V2=true. DRY-RUN by default.
 */

/** True if the product carries any old-account listing pointer. */
function hasListingPointer(product) {
  const ops = product?.ops || {};
  return !!(
    ops.ebay?.itemId ||
    ops.kaufland?.unitId ||
    (ops.listingStatus && (ops.listingStatus.ebay || ops.listingStatus.kaufland))
  );
}

/**
 * Return a COPY of the product with the marketplace listing pointers nulled and
 * everything else (inventory, other ops fields) preserved. Non-mutating.
 */
function clearListingPointers(product) {
  const ops = product?.ops || {};
  const next = { ...product, ops: { ...ops } };
  if (ops.ebay) next.ops.ebay = { ...ops.ebay, itemId: null };
  if (ops.kaufland) next.ops.kaufland = { ...ops.kaufland, unitId: null };
  if (ops.listingStatus) next.ops.listingStatus = { ...ops.listingStatus, ebay: null, kaufland: null };
  return next;
}

/**
 * Clear pointers across a set of products. I/O injected (products list +
 * saveProduct) for testability.
 * deps: { products: [...], saveProduct: async (p)=>{}, apply=false, log }
 */
async function runClearPointers({ products, saveProduct, apply = false, log = () => {} }) {
  let scanned = 0;
  let cleared = 0;
  for (const p of products) {
    scanned += 1;
    if (!hasListingPointer(p)) continue;
    const next = clearListingPointers(p);
    if (apply) await saveProduct(next);
    cleared += 1;
    log(`  ${apply ? 'cleared' : 'would clear'} ${p.id}`);
  }
  return { scanned, cleared };
}

/** Parse CLI args. DRY-RUN is the default; --apply is required to write. */
function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return { apply: argv.includes('--apply'), tenant: val('--tenant') || 'default' };
}

module.exports = {
  hasListingPointer,
  clearListingPointers,
  runClearPointers,
  parseArgs,
};

// ─── CLI entry (thin glue over the tested core) ────────────────────────────
if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const { getAllProductsV2ForTenant, saveProductV2 } = require('../lib/product-store');

    if (process.env.USE_PRODUCTS_V2 !== 'true') {
      console.error('❌ USE_PRODUCTS_V2=true erforderlich (Produkt-Store-Pfad). Abbruch.');
      process.exit(1);
    }

    console.log(`[clear-listing-pointers] tenant=${args.tenant} mode=${args.apply ? 'APPLY' : 'DRY-RUN'}`);
    const products = await getAllProductsV2ForTenant(args.tenant);
    console.log(`  Produkte geladen: ${products.length}`);

    const result = await runClearPointers({
      products,
      saveProduct: (p) => saveProductV2(p, { skipStockEvent: true, source: 'gmbh-cutover-reset' }),
      apply: args.apply,
      log: (m) => process.stdout.write(`${m}\n`),
    });

    console.log(`\n  gescannt: ${result.scanned}, ${args.apply ? 'geleert' : 'zu leeren'}: ${result.cleared}`);
    console.log(args.apply
      ? '\n✅ Listing-Zeiger geleert. Bestand/Lager unangetastet (saveProductV2 skipStockEvent).'
      : '\nDRY-RUN — nichts verändert. Mit --apply ausführen (nur im Cutover-Fenster, nach Mirror-Wipe).');
    process.exit(0);
  })().catch((err) => {
    console.error(`[clear-listing-pointers] FATAL: ${err.message}`, err);
    process.exit(1);
  });
}
