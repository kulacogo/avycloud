/**
 * Debug helper: Fetch a BaseLinker inventory product by product_id and print its text_fields.
 *
 * Why:
 * - BaseLinker descriptions can be stored under integration-scoped text_fields keys like:
 *   "description|de|ebay_301" (not only "description" / "description|de")
 * - The BaseLinker UI "Beschreibung" field may show one of those scoped keys.
 *
 * Official docs (method examples/response shape):
 * - getInventoryProductsData
 * - getInventoryIntegrations
 * - getInventoryAvailableTextFieldKeys (returns "text_field_keys")
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud NODE_PATH=backend/node_modules \\
 *   BASELINKER_DEBUG_TEXT_FIELDS=true \\
 *   node backend/scripts/debug-baselinker-product-text-fields.js
 *
 * Env:
 * - PRODUCT_ID (required): BaseLinker product_id, e.g. 467527271
 * - INVENTORY_IDS (optional): comma list, e.g. "85403,85404,78659"
 *
 * Notes:
 * - Requires BaseLinker token available via backend/lib/secrets (same as the running service).
 */

const { callBaseLinker } = require('../lib/baselinker');

const PRODUCT_ID = Number(process.env.PRODUCT_ID || 0);
if (!PRODUCT_ID) {
  console.error('Missing PRODUCT_ID env, e.g. PRODUCT_ID=467527271');
  process.exit(1);
}

const DEFAULT_INVENTORY_IDS = [
  process.env.BASELINKER_INVENTORY_ID,
  '85403', // eBay (used by sync script)
  '85404', // Kaufland (used by sync script)
  '78659', // fallback mentioned in code
].filter(Boolean);

const INVENTORY_IDS = (process.env.INVENTORY_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const inventoriesToTry = Array.from(new Set([...(INVENTORY_IDS.length ? INVENTORY_IDS : []), ...DEFAULT_INVENTORY_IDS]));

function pickTextFields(product) {
  // BaseLinker returns "text_fields" in getInventoryProductsData example.
  // Be tolerant to alternate shapes.
  return product?.text_fields || product?.textFields || {};
}

async function main() {
  console.log('Debug BaseLinker product:', { PRODUCT_ID, inventoriesToTry });

  for (const invId of inventoriesToTry) {
    try {
      const res = await callBaseLinker('getInventoryProductsData', {
        inventory_id: String(invId),
        products: [PRODUCT_ID],
      });

      const productsMap = res?.products || {};
      const product = productsMap[String(PRODUCT_ID)] || productsMap[PRODUCT_ID];
      if (!product) {
        continue;
      }

      console.log(`\n=== FOUND in inventory_id=${invId} ===`);
      console.log('sku:', product.sku || product.product_sku || null);
      console.log('ean:', product.ean || null);

      const textFields = pickTextFields(product);
      const keys = Object.keys(textFields).sort();
      console.log(`text_fields count: ${keys.length}`);

      const interesting = keys.filter((k) => /description/i.test(k));
      console.log('\n-- description-related keys --');
      interesting.forEach((k) => {
        const v = textFields[k];
        console.log(`${k}: ${String(v || '').slice(0, 240)}`);
      });

      const needle = (process.env.NEEDLE || 'Beschreibung folgt').toLowerCase();
      const matches = keys.filter((k) => String(textFields[k] || '').toLowerCase().includes(needle));
      if (matches.length) {
        console.log(`\n-- keys whose value contains "${needle}" --`);
        matches.forEach((k) => console.log(`${k}: ${String(textFields[k] || '').slice(0, 240)}`));
      }

      // Also print what BaseLinker says is available to overwrite (optional but useful)
      try {
        const available = await callBaseLinker('getInventoryAvailableTextFieldKeys', {
          inventory_id: String(invId),
        });
        const map = available?.text_field_keys || {};
        const mapKeys = Object.keys(map).sort();
        console.log(`\navailable text_field_keys (default) count: ${mapKeys.length}`);
        console.log(mapKeys.filter((k) => /description/i.test(k)).slice(0, 40));
      } catch (e) {
        console.warn('getInventoryAvailableTextFieldKeys failed (non-fatal):', e.message);
      }

      try {
        const integrations = await callBaseLinker('getInventoryIntegrations', {
          inventory_id: String(invId),
        });
        console.log('\ngetInventoryIntegrations:', JSON.stringify(integrations?.integrations || integrations, null, 2).slice(0, 2500));
      } catch (e) {
        console.warn('getInventoryIntegrations failed (non-fatal):', e.message);
      }

      return;
    } catch (e) {
      // try next inventory id
    }
  }

  console.error('Product not found in tried inventory IDs:', inventoriesToTry);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


