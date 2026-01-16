/* eslint-disable no-console */
/**
 * Fix existing fashion titles (clothing/shoes) so we don't inject meaningless model/article codes.
 *
 * This addresses cases like:
 *   "Tommy Hilfiger Pullover MW0MW28046DW5 Herren Gr.XL ..."
 * where the code-like token is not purchase-relevant and can hurt UX/search.
 *
 * Strategy:
 * - For each product, compute the deterministic title via `coerceTitleToPolicy`.
 * - If it changes the title AND the inferred schema is fashion-like, save it.
 *
 * Safety:
 * - Default DRY-RUN
 * - Uses saveProduct invariants (warehouse fields are preserved).
 *
 * Usage:
 *   node backend/scripts/fix-fashion-titles.js --dry-run
 *   node backend/scripts/fix-fashion-titles.js --apply
 */

const { getAllProducts, saveProduct } = require('../lib/firestore');
const { coerceTitleToPolicy } = require('../lib/title-policy');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, limit: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    }
    if (t === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function isLikelyFashionProduct(product) {
  const cat = safeString(product?.identification?.category).toLowerCase();
  if (cat.includes('bekleidung')) return true;
  if (cat.includes('schuhe')) return true;
  if (cat.includes('mode')) return true;
  const attrs = product?.details?.attributes || {};
  const size = safeString(attrs['Größe'] || attrs['Size'] || attrs['EU-Schuhgröße']);
  const audience = safeString(attrs['Abteilung'] || attrs['Geschlecht'] || attrs['Zielgruppe']);
  return Boolean(size && audience);
}

async function main() {
  const args = parseArgs(process.argv);
  const products = await getAllProducts();

  let changed = 0;
  let saved = 0;
  const previews = [];

  for (const p of products) {
    if (!isLikelyFashionProduct(p)) continue;
    const before = safeString(p?.identification?.name);
    if (!before) continue;
    const after = coerceTitleToPolicy(p, before, { minLen: 55, maxLen: 80, softMaxLen: 75 });
    if (!after || after === before) continue;

    changed += 1;
    if (previews.length < 10) {
      previews.push({ sku: p?.identification?.sku || null, before, after });
    }

    if (args.apply) {
      const next = JSON.parse(JSON.stringify(p));
      next.identification = next.identification || {};
      next.identification.name = after;
      next.ops = next.ops || {};
      next.ops.last_saved_source = 'title-fix-fashion';
      await saveProduct(next, { source: 'title-fix-fashion' });
      saved += 1;
      if (args.limit && saved >= args.limit) break;
    }
  }

  console.log('[title-fix-fashion] mode=', args.apply ? 'APPLY' : 'DRY_RUN');
  console.log('[title-fix-fashion] changed=', changed, 'saved=', saved);
  console.log('[title-fix-fashion] preview=', JSON.stringify(previews, null, 2));
}

main().catch((err) => {
  console.error('title-fix-fashion failed:', err);
  process.exit(1);
});

