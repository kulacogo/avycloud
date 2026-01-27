/* eslint-disable no-console */
/**
 * BaseLinker categories-only sync (NO products).
 *
 * Intended use:
 * - After you delete all inventory categories in BaseLinker (because of duplicates),
 *   run this to recreate a clean category tree based on AvyCloud's product category paths.
 *
 * Source of truth for paths:
 * - product.identification.category (preferred)
 * - fallback: details.attributes.Kategorie (if present)
 *
 * Usage:
 *   node backend/scripts/baselinker-sync-categories-only.js --inventory 78659 --apply
 *   node backend/scripts/baselinker-sync-categories-only.js --inventory 78659 --dry-run --limit 2000
 */

const { getAllProducts } = require('../lib/firestore');
const { ensureInventoryCategory } = require('../lib/baselinker');

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

function pickCategoryPath(product) {
  const direct = safeString(product?.identification?.category);
  if (direct) return direct;
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const fromAttr = safeString(attrs?.Kategorie);
  return fromAttr;
}

async function main() {
  const inventoryId = String(argValue('--inventory', process.env.BASELINKER_INVENTORY_ID || '78659')).trim();
  const dryRun = argFlag('--dry-run') || !argFlag('--apply');
  const limit = Math.max(1, parseInt(argValue('--limit', '5000') || '5000', 10));

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id).slice(0, limit) : [];

  const paths = new Set();
  for (const p of products) {
    const path = pickCategoryPath(p);
    if (!path) continue;
    // Avoid obviously garbage categories
    const lower = path.toLowerCase();
    if (lower === 'unknown' || lower === 'unbekannt') continue;
    paths.add(path);
  }

  const sorted = Array.from(paths).sort((a, b) => {
    const da = a.split('>').filter(Boolean).length;
    const db = b.split('>').filter(Boolean).length;
    if (da !== db) return da - db;
    return String(a).localeCompare(String(b), 'de-DE');
  });

  console.log(
    JSON.stringify(
      {
        action: 'baselinker-sync-categories-only',
        inventoryId,
        dryRun,
        products_scanned: products.length,
        unique_paths: sorted.length,
        sample_paths: sorted.slice(0, 12),
      },
      null,
      2
    )
  );

  if (dryRun) return;

  let createdOrEnsured = 0;
  for (const p of sorted) {
    // ensureInventoryCategory is idempotent (loads remote categories and creates missing segments).
    await ensureInventoryCategory(inventoryId, p);
    createdOrEnsured += 1;
    if (createdOrEnsured % 50 === 0) {
      console.log(JSON.stringify({ progress: createdOrEnsured, total: sorted.length }, null, 2));
    }
  }
  console.log(JSON.stringify({ done: true, total: sorted.length }, null, 2));
}

main().catch((e) => {
  console.error('baselinker-sync-categories-only failed:', e?.message || e);
  process.exit(1);
});

