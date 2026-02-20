/* eslint-disable no-console */
/**
 * Deduplicate BaseLinker inventory categories by breadcrumb:
 * - Picks canonical category_id = smallest id per identical breadcrumb.
 * - Re-parents subcategories from duplicates to canonical.
 * - Moves products assigned to duplicate category_id to canonical category_id.
 * - Deletes duplicate categories (now empty).
 *
 * SAFE DEFAULT: dry-run (no writes). Pass --apply to execute.
 *
 * Usage:
 *   node backend/scripts/dedupe-baselinker-inventory-categories.js 78659 --dry-run
 *   node backend/scripts/dedupe-baselinker-inventory-categories.js 78659 --apply
 */
const { callBaseLinker } = require('../lib/baselinker');

function safeInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function normalizeNameKey(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function fetchCategories(inventoryId) {
  const res = await callBaseLinker('getInventoryCategories', { inventory_id: inventoryId });
  const cats = Array.isArray(res?.categories) ? res.categories : [];
  const byId = new Map();
  for (const c of cats) {
    const id = safeInt(c?.category_id ?? c?.id, 0);
    if (!id) continue;
    byId.set(id, {
      id,
      name: String(c?.name || '').trim(),
      parentId: safeInt(c?.parent_id ?? c?.parent_category_id, 0),
    });
  }
  const memo = new Map();
  const buildBreadcrumb = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    if (!node) {
      memo.set(id, '');
      return '';
    }
    if (stack.has(id)) {
      const leaf = node.name || String(id);
      memo.set(id, leaf);
      return leaf;
    }
    stack.add(id);
    const parent =
      node.parentId && byId.has(node.parentId) ? buildBreadcrumb(node.parentId, stack) : '';
    stack.delete(id);
    const crumb = parent ? `${parent} > ${node.name || String(id)}` : (node.name || String(id));
    memo.set(id, crumb);
    return crumb;
  };
  const rows = Array.from(byId.values()).map((c) => ({
    ...c,
    breadcrumb: buildBreadcrumb(c.id),
  }));
  return { byId, rows };
}

async function listAllProductIds(inventoryId) {
  const ids = [];
  let page = 1;
  while (true) {
    const res = await callBaseLinker('getInventoryProductsList', { inventory_id: inventoryId, page });
    const productsObj = res?.products && typeof res.products === 'object' ? res.products : {};
    const pageIds = Object.keys(productsObj || {})
      .map((k) => safeInt(k, 0))
      .filter((n) => n > 0);
    ids.push(...pageIds);
    if (pageIds.length < 1000) break;
    page += 1;
    if (page > 5000) break;
  }
  return Array.from(new Set(ids));
}

function chunkArray(arr, size) {
  const s = Math.max(1, Math.min(500, Number(size) || 100));
  const out = [];
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s));
  return out;
}

async function buildCategoryToProductsMap(inventoryId, productIds) {
  const map = new Map(); // category_id -> number[]
  const chunks = chunkArray(productIds, 100);
  for (const chunk of chunks) {
    const res = await callBaseLinker('getInventoryProductsData', { inventory_id: inventoryId, products: chunk });
    const productsObj = res?.products && typeof res.products === 'object' ? res.products : {};
    for (const [pidKey, pdata] of Object.entries(productsObj)) {
      const pid = safeInt(pidKey, 0);
      const catId = safeInt(pdata?.category_id, 0);
      if (!pid || !catId) continue;
      if (!map.has(catId)) map.set(catId, []);
      map.get(catId).push(pid);
    }
  }
  // de-dupe lists
  for (const [k, list] of map.entries()) {
    map.set(k, Array.from(new Set(list)));
  }
  return map;
}

async function main() {
  const invArg = process.argv[2] || process.env.BASELINKER_INVENTORY_ID || '78659';
  const inventoryId = safeInt(invArg, 0);
  if (!inventoryId) throw new Error(`Invalid inventory id: ${invArg}`);

  const apply = process.argv.includes('--apply');
  const dryRun = !apply;

  console.log(`[dedupe] inventory_id=${inventoryId} mode=${dryRun ? 'DRY_RUN' : 'APPLY'}`);

  const { byId, rows } = await fetchCategories(inventoryId);
  console.log(`[dedupe] categories: ${rows.length}`);

  // Group by breadcrumb
  const byBreadcrumb = new Map();
  for (const r of rows) {
    const b = String(r.breadcrumb || '').trim();
    if (!b) continue;
    if (!byBreadcrumb.has(b)) byBreadcrumb.set(b, []);
    byBreadcrumb.get(b).push(r);
  }

  const duplicates = [];
  for (const [breadcrumb, list] of byBreadcrumb.entries()) {
    if (list.length <= 1) continue;
    list.sort((a, b) => a.id - b.id);
    duplicates.push({ breadcrumb, list });
  }
  duplicates.sort((a, b) => b.breadcrumb.length - a.breadcrumb.length);
  console.log(`[dedupe] duplicate breadcrumbs: ${duplicates.length}`);
  if (!duplicates.length) return;

  // Build product category usage map
  const productIds = await listAllProductIds(inventoryId);
  console.log(`[dedupe] inventory products: ${productIds.length}`);
  const catToProducts = await buildCategoryToProductsMap(inventoryId, productIds);
  console.log(`[dedupe] categories referenced by products: ${catToProducts.size}`);

  // Process each duplicate breadcrumb group
  let movedProducts = 0;
  let reparentedCats = 0;
  let deletedCats = 0;
  let failed = 0;

  for (const group of duplicates) {
    const canonical = group.list[0];
    const dupes = group.list.slice(1);
    if (!dupes.length) continue;

    for (const dup of dupes) {
      const dupId = dup.id;
      const canonicalId = canonical.id;

      // 1) Reparent children of dup to canonical
      const children = [];
      for (const node of byId.values()) {
        if (node.parentId === dupId) children.push(node);
      }
      if (children.length) {
        for (const child of children) {
          if (dryRun) {
            reparentedCats += 1;
            child.parentId = canonicalId;
            continue;
          }
          try {
            const resp = await callBaseLinker('addInventoryCategory', {
              inventory_id: inventoryId,
              category_id: child.id,
              name: child.name,
              parent_id: canonicalId,
            });
            if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'update category failed');
            reparentedCats += 1;
            child.parentId = canonicalId;
          } catch (e) {
            failed += 1;
            console.warn(`[dedupe] failed to reparent child category ${child.id} -> ${canonicalId}:`, e?.message || e);
          }
        }
      }

      // 2) Move products assigned to dup category id
      const pids = catToProducts.get(dupId) || [];
      if (pids.length) {
        if (dryRun) {
          movedProducts += pids.length;
        } else {
          for (const chunk of chunkArray(pids, 150)) {
            // BaseLinker addInventoryProduct supports updating fields for an existing product_id.
            // We update only category_id.
            for (const pid of chunk) {
              try {
                const resp = await callBaseLinker('addInventoryProduct', {
                  inventory_id: inventoryId,
                  product_id: pid,
                  category_id: canonicalId,
                });
                if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'product category update failed');
                movedProducts += 1;
              } catch (e) {
                failed += 1;
                console.warn(`[dedupe] failed to move product ${pid} category ${dupId} -> ${canonicalId}:`, e?.message || e);
              }
            }
          }
        }
      }

      // 3) Delete duplicate category (now should be empty)
      if (dryRun) {
        deletedCats += 1;
        continue;
      }
      try {
        const resp = await callBaseLinker('deleteInventoryCategory', { category_id: dupId });
        if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'delete failed');
        deletedCats += 1;
      } catch (e) {
        failed += 1;
        console.warn(`[dedupe] failed to delete category ${dupId}:`, e?.message || e);
      }
    }
  }

  console.log(
    `[dedupe] done. movedProducts=${movedProducts} reparentedCategories=${reparentedCats} deletedCategories=${deletedCats} failed=${failed}`
  );
  if (dryRun) {
    console.log('[dedupe] Dry-run only. Re-run with --apply to execute changes.');
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});

