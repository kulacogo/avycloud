/* eslint-disable no-console */
/**
 * Export all BaseLinker inventory categories to CSV + JSON.
 *
 * Usage:
 *   node backend/scripts/export-baselinker-inventory-categories.js 78659
 *
 * Auth:
 * - Uses backend/lib/baselinker.js -> callBaseLinker() -> Secret Manager BASE_API_TOKEN.
 * - Requires ADC on your machine (gcloud auth application-default login) or Cloud Run runtime.
 */
const fs = require('fs');
const path = require('path');
const { callBaseLinker } = require('../lib/baselinker');
const { Timestamp } = require('../lib/baselinker-sync-jobs');

function safeInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function nowStamp() {
  // Use Firestore Timestamp for consistent ISO output formatting (already in deps).
  const iso = Timestamp.now().toDate().toISOString();
  return iso.replace(/[:.]/g, '-');
}

async function main() {
  const invArg = process.argv[2] || process.env.BASELINKER_INVENTORY_ID || '78659';
  const inventoryId = safeInt(invArg, 0);
  if (!inventoryId) {
    throw new Error(`Invalid inventory id: ${invArg}`);
  }

  console.log(`[baselinker] Fetching inventory categories for inventory_id=${inventoryId} ...`);
  const res = await callBaseLinker('getInventoryCategories', { inventory_id: inventoryId });
  const categories = Array.isArray(res?.categories) ? res.categories : [];
  console.log(`[baselinker] categories returned: ${categories.length}`);

  const byId = new Map();
  for (const c of categories) {
    const id = safeInt(c?.category_id ?? c?.id, 0);
    if (!id) continue;
    const name = String(c?.name || '').trim();
    const parentId = safeInt(c?.parent_id ?? c?.parent_category_id, 0);
    byId.set(id, { id, name, parentId });
  }

  const memo = new Map(); // id -> breadcrumb
  const buildBreadcrumb = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    if (!node) {
      memo.set(id, '');
      return '';
    }
    if (stack.has(id)) {
      // cycle guard
      const leaf = node.name || String(id);
      memo.set(id, leaf);
      return leaf;
    }
    stack.add(id);
    const parent = node.parentId && byId.has(node.parentId) ? buildBreadcrumb(node.parentId, stack) : '';
    stack.delete(id);
    const crumb = parent ? `${parent} > ${node.name || String(id)}` : (node.name || String(id));
    memo.set(id, crumb);
    return crumb;
  };

  const rows = Array.from(byId.values()).map((node) => ({
    category_id: node.id,
    parent_id: node.parentId || 0,
    name: node.name || '',
    breadcrumb: buildBreadcrumb(node.id),
  }));
  rows.sort((a, b) => String(a.breadcrumb).localeCompare(String(b.breadcrumb), 'de'));

  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const baseName = `baselinker-inventory-categories-${inventoryId}-${stamp}`;
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const csvPath = path.join(outDir, `${baseName}.csv`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        meta: { inventoryId, count: rows.length, exportedAtIso: new Date().toISOString() },
        categories: rows,
      },
      null,
      2
    ),
    'utf8'
  );

  const csv = [
    ['category_id', 'parent_id', 'name', 'breadcrumb'].join(','),
    ...rows.map((r) =>
      [r.category_id, r.parent_id, r.name, r.breadcrumb].map(csvEscape).join(',')
    ),
  ].join('\n');
  fs.writeFileSync(csvPath, `${csv}\n`, 'utf8');

  console.log(`[baselinker] Wrote JSON: ${jsonPath}`);
  console.log(`[baselinker] Wrote CSV : ${csvPath}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});

