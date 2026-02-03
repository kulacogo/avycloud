/* eslint-disable no-console */
/**
 * Consolidate (semantic-dedupe) BaseLinker inventory categories *in place*.
 *
 * What it does:
 * - Uses our canonical category-path rules (root/prefix normalization) to group categories
 *   that are semantically duplicates (e.g. "Baby" vs "Baby & Kind", "Auto & Motorrad: Teile" etc.)
 * - Ensures canonical categories exist.
 * - Moves products from duplicate categories to the canonical category.
 * - Reparents children out of duplicate categories into canonical parents.
 * - Deletes the duplicate categories.
 *
 * SAFE DEFAULT: dry-run (no writes). Pass --apply to execute.
 *
 * Usage:
 *   node backend/scripts/consolidate-baselinker-inventory-categories.js 78659 --dry-run
 *   node backend/scripts/consolidate-baselinker-inventory-categories.js 78659 --apply
 *
 * Notes:
 * - This does not touch Firestore products (only BaseLinker inventory).
 * - It is conservative but still powerful; review dry-run output before applying.
 */
const { callBaseLinker } = require('../lib/baselinker');
const { canonicalizeBaselinkerCategoryPath, canonicalKeyForPath, splitBreadcrumb } = require('../lib/baselinker-category-canonical');

function safeInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
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
      name: safeString(c?.name),
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
      memo.set(id, node.name || String(id));
      return node.name || String(id);
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

async function listAllProductsWithCategory(inventoryId) {
  const items = [];
  let page = 1;
  const MAX_PAGES = 5000;
  while (page <= MAX_PAGES) {
    const res = await callBaseLinker('getInventoryProductsList', { inventory_id: inventoryId, page });
    const listRaw = res?.products || res?.items || {};
    const list = Array.isArray(listRaw) ? listRaw : Object.values(listRaw);
    if (!list.length) break;
    for (const entry of list) {
      const pid = safeInt(entry?.product_id ?? entry?.id, 0);
      const catId = safeInt(entry?.category_id, 0);
      if (!pid) continue;
      items.push({ productId: pid, categoryId: catId });
    }
    // BaseLinker docs: up to 1000 per page; stop when below that.
    if (list.length < 1000) break;
    page += 1;
  }
  return items;
}

function chunkArray(arr, size) {
  const s = Math.max(1, Math.min(200, Number(size) || 100));
  const out = [];
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s));
  return out;
}

function pickRepresentativeIdForGroup(group, canonicalBreadcrumb) {
  const canonicalRoot = splitBreadcrumb(canonicalBreadcrumb)[0] || '';
  const isExact = (r) => safeString(r.breadcrumb) === safeString(canonicalBreadcrumb);
  const rootOf = (r) => splitBreadcrumb(r.breadcrumb)[0] || '';
  const sorted = [...group].sort((a, b) => {
    const aExact = isExact(a);
    const bExact = isExact(b);
    if (aExact !== bExact) return aExact ? -1 : 1;

    const aRootMatch = canonicalRoot && rootOf(a) === canonicalRoot;
    const bRootMatch = canonicalRoot && rootOf(b) === canonicalRoot;
    if (aRootMatch !== bRootMatch) return aRootMatch ? -1 : 1;

    return a.id - b.id;
  });
  return sorted[0]?.id || group[0]?.id || 0;
}

async function main() {
  const invArg = process.argv[2] || process.env.BASELINKER_INVENTORY_ID || '78659';
  const inventoryId = safeInt(invArg, 0);
  if (!inventoryId) throw new Error(`Invalid inventory id: ${invArg}`);

  const apply = process.argv.includes('--apply');
  const dryRun = !apply || process.argv.includes('--dry-run');
  const limitArgIdx = process.argv.indexOf('--limit');
  const limit = limitArgIdx !== -1 ? safeInt(process.argv[limitArgIdx + 1], 0) : 0;

  console.log(`[consolidate] inventory_id=${inventoryId} mode=${dryRun ? 'DRY_RUN' : 'APPLY'} limit=${limit || 'none'}`);

  const { byId, rows } = await fetchCategories(inventoryId);
  console.log(`[consolidate] categories: ${rows.length}`);

  // Build canonical mapping for categories
  const enriched = rows
    .map((r) => {
      const canonicalBreadcrumb = canonicalizeBaselinkerCategoryPath(r.breadcrumb) || safeString(r.breadcrumb);
      const key = canonicalKeyForPath(canonicalBreadcrumb);
      return {
        ...r,
        canonicalBreadcrumb,
        canonicalKey: key,
        depth: splitBreadcrumb(r.breadcrumb).length,
      };
    })
    .filter((r) => r.canonicalBreadcrumb && r.canonicalKey);

  // Group by canonicalKey
  const byCanonical = new Map(); // key -> list
  for (const r of enriched) {
    const list = byCanonical.get(r.canonicalKey) || [];
    list.push(r);
    byCanonical.set(r.canonicalKey, list);
  }

  // Identify duplicate groups (semantic)
  const groups = Array.from(byCanonical.values()).filter((g) => g.length > 1);
  groups.sort((a, b) => (b[0]?.canonicalBreadcrumb || '').length - (a[0]?.canonicalBreadcrumb || '').length);
  console.log(`[consolidate] duplicate canonical groups: ${groups.length}`);

  // Canonical leaf ID mapping:
  // IMPORTANT:
  // - We intentionally do NOT create new categories here. Cleanup should reduce duplicates, not grow the tree.
  // - The "canonical" category for a canonical breadcrumb is picked as an existing representative within that group.
  const canonicalLeafIdByKey = new Map();
  const allCanonicalEntries = Array.from(byCanonical.entries()).map(([key, list]) => ({
    key,
    canonicalBreadcrumb: list[0]?.canonicalBreadcrumb || '',
    group: list,
  }));

  for (const c of allCanonicalEntries) {
    const rep = pickRepresentativeIdForGroup(c.group, c.canonicalBreadcrumb);
    if (rep) canonicalLeafIdByKey.set(c.key, safeInt(rep, 0));
  }

  // Build product usage map (category_id -> productIds)
  const products = await listAllProductsWithCategory(inventoryId);
  const catToProducts = new Map();
  for (const p of products) {
    if (!p.categoryId) continue;
    if (!catToProducts.has(p.categoryId)) catToProducts.set(p.categoryId, []);
    catToProducts.get(p.categoryId).push(p.productId);
  }
  // de-dupe
  for (const [k, list] of catToProducts.entries()) {
    catToProducts.set(k, Array.from(new Set(list)));
  }

  let movedProducts = 0;
  let reparentedCats = 0;
  let renamedCats = 0;
  let deletedCats = 0;
  let failed = 0;
  const missingCategoryIds = new Set(); // categories that disappeared during this run

  // Process duplicates deepest-first (children first) for safer reparenting.
  const allById = new Map(enriched.map((r) => [r.id, r]));
  const duplicates = enriched
    .filter((r) => {
      const canonicalId = canonicalLeafIdByKey.get(r.canonicalKey);
      return canonicalId && r.id !== canonicalId;
    })
    .sort((a, b) => (b.depth || 0) - (a.depth || 0));

  console.log(`[consolidate] duplicate category nodes to merge: ${duplicates.length}`);

  // Helper: compute canonical parent id from canonical breadcrumb.
  // We map parent breadcrumb -> canonicalKey -> representative existing category id.
  const resolveCanonicalParentId = async (canonicalBreadcrumb, fallbackParentId) => {
    const segs = splitBreadcrumb(canonicalBreadcrumb);
    if (segs.length <= 1) return 0;
    const parentPath = segs.slice(0, -1).join(' > ');
    const parentKey = canonicalKeyForPath(parentPath);
    const parentId = parentKey ? canonicalLeafIdByKey.get(parentKey) : 0;
    return safeInt(parentId || fallbackParentId, 0) || 0;
  };

  for (const dup of duplicates) {
    // If this category disappeared earlier in this run, skip it.
    if (missingCategoryIds.has(dup.id) || !byId.has(dup.id)) {
      continue;
    }
    const canonicalLeafId = canonicalLeafIdByKey.get(dup.canonicalKey) || 0;
    if (!canonicalLeafId) continue;
    if (dup.id === canonicalLeafId) continue;

    // 1) Move products assigned to duplicate category id
    const pids = catToProducts.get(dup.id) || [];
    if (pids.length) {
      if (dryRun) {
        movedProducts += pids.length;
      } else {
        for (const chunk of chunkArray(pids, 150)) {
          for (const pid of chunk) {
            try {
              const resp = await callBaseLinker(
                'addInventoryProduct',
                {
                  inventory_id: inventoryId,
                  product_id: pid,
                  category_id: canonicalLeafId,
                },
                { retries: 0 }
              );
              if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'product category update failed');
              movedProducts += 1;
            } catch (e) {
              failed += 1;
              console.warn(`[consolidate] failed to move product ${pid} category ${dup.id} -> ${canonicalLeafId}:`, e?.message || e);
            }
          }
        }
      }
    }

    // 2) Reparent children of dup to their canonical parent
    const children = [];
    for (const node of byId.values()) {
      if (node.parentId === dup.id) children.push(node);
    }
    if (children.length) {
      for (const child of children) {
        if (missingCategoryIds.has(child.id) || !byId.has(child.id)) {
          continue;
        }
        const childInfo = allById.get(child.id);
        const childCanonical = childInfo?.canonicalBreadcrumb || canonicalizeBaselinkerCategoryPath(childInfo?.breadcrumb || '') || '';
        const targetParentId = childCanonical
          ? await resolveCanonicalParentId(childCanonical, canonicalLeafId)
          : canonicalLeafId;
        const targetName = (() => {
          const segs = splitBreadcrumb(childCanonical);
          return segs[segs.length - 1] || child.name;
        })();
        const needsRename = targetName && safeString(targetName) && safeString(targetName) !== safeString(child.name);
        const needsReparent = safeInt(targetParentId, 0) !== safeInt(child.parentId, 0);

        if (!needsRename && !needsReparent) continue;

        if (dryRun) {
          reparentedCats += needsReparent ? 1 : 0;
          renamedCats += needsRename ? 1 : 0;
          child.parentId = safeInt(targetParentId, 0);
          child.name = needsRename ? safeString(targetName) : child.name;
          continue;
        }

        try {
          const resp = await callBaseLinker(
            'addInventoryCategory',
            {
              inventory_id: inventoryId,
              category_id: child.id,
              name: needsRename ? safeString(targetName) : child.name,
              parent_id: safeInt(targetParentId, 0),
            },
            { retries: 0 }
          );
          if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'update category failed');
          if (needsReparent) reparentedCats += 1;
          if (needsRename) renamedCats += 1;
          child.parentId = safeInt(targetParentId, 0);
          child.name = needsRename ? safeString(targetName) : child.name;
        } catch (e) {
          // If it vanished (common during consolidation), mark and continue.
          const msg = String(e?.message || e || '');
          if (/ERROR_CATEGORY_ID/i.test(msg) || /does not exist/i.test(msg)) {
            missingCategoryIds.add(child.id);
            byId.delete(child.id);
          }
          failed += 1;
          console.warn(`[consolidate] failed to reparent/rename child category ${child.id}:`, e?.message || e);
        }
      }
    }

    // 3) Delete duplicate category (now should be empty)
    if (dryRun) {
      deletedCats += 1;
      continue;
    }
    try {
      const resp = await callBaseLinker('deleteInventoryCategory', { category_id: dup.id }, { retries: 0 });
      if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'delete failed');
      deletedCats += 1;
      missingCategoryIds.add(dup.id);
      byId.delete(dup.id);
    } catch (e) {
      const msg = String(e?.message || e || '');
      if (/ERROR_CATEGORY_ID/i.test(msg) || /does not exist/i.test(msg)) {
        // Treat as already deleted.
        deletedCats += 1;
        missingCategoryIds.add(dup.id);
        byId.delete(dup.id);
        continue;
      }
      failed += 1;
      console.warn(`[consolidate] failed to delete category ${dup.id}:`, e?.message || e);
    }
  }

  console.log(
    JSON.stringify(
      {
        done: true,
        inventoryId: inventoryId,
        dryRun,
        stats: {
          categories_total: rows.length,
          canonical_groups: byCanonical.size,
          duplicate_groups: groups.length,
          duplicate_nodes: duplicates.length,
          products_total: products.length,
          movedProducts,
          reparentedCats,
          renamedCats,
          deletedCats,
          failed,
        },
        hint: dryRun ? 'Re-run with --apply to execute changes.' : null,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});

