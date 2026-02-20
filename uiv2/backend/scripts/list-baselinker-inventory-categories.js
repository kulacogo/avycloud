#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * List BaseLinker inventory categories with computed breadcrumb paths.
 *
 * Usage:
 *   node backend/scripts/list-baselinker-inventory-categories.js --inventory 78659
 *   node backend/scripts/list-baselinker-inventory-categories.js --inventory 78659 --json out.json
 *
 * Notes:
 * - Requires BaseLinker API token to be available via Secret Manager/env used by `backend/lib/baselinker.js`.
 * - Uses BaseLinker API method: getInventoryCategories (inventory_id required).
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { inventory: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--inventory' || a === '--inventory_id' || a === '-i') {
      out.inventory = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === '--json') {
      out.json = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return out;
}

function normalizeSegment(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function buildPathFor(id, byId, memo, stack = new Set()) {
  if (memo.has(id)) return memo.get(id);
  const node = byId.get(id);
  if (!node) {
    memo.set(id, []);
    return [];
  }
  if (stack.has(id)) {
    const segs = [node.name];
    memo.set(id, segs);
    return segs;
  }
  stack.add(id);
  const parentSegs = node.parent_id && byId.has(node.parent_id) ? buildPathFor(node.parent_id, byId, memo, stack) : [];
  stack.delete(id);
  const segs = [...parentSegs, node.name];
  memo.set(id, segs);
  return segs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inventoryId = Number(args.inventory || process.env.BASELINKER_INVENTORY_ID || 78659);
  if (!Number.isFinite(inventoryId) || inventoryId <= 0) {
    console.error('Invalid --inventory. Example: --inventory 78659');
    process.exit(1);
  }

  // Use the existing BaseLinker client (handles token + rate limiting).
  const { callBaseLinker } = require('../lib/baselinker');

  const res = await callBaseLinker('getInventoryCategories', { inventory_id: inventoryId });
  if (!res || res.status !== 'SUCCESS') {
    console.error('BaseLinker getInventoryCategories failed:', res);
    process.exit(2);
  }

  const cats = Array.isArray(res.categories) ? res.categories : [];
  const byId = new Map();
  for (const c of cats) {
    const id = Number(c?.category_id);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId.set(id, {
      category_id: id,
      name: normalizeSegment(c?.name),
      // API docs mention parent_category_id; our BaseLinker responses commonly use parent_id.
      parent_id: Number(c?.parent_id ?? c?.parent_category_id ?? 0) || 0,
    });
  }

  const memo = new Map();
  const rows = Array.from(byId.values()).map((c) => {
    const segs = buildPathFor(c.category_id, byId, memo);
    const fullPath = segs.filter(Boolean).join(' > ');
    return {
      category_id: c.category_id,
      parent_id: c.parent_id,
      name: c.name,
      path: fullPath,
      depth: segs.length,
    };
  });

  rows.sort((a, b) => String(a.path).localeCompare(String(b.path), 'de-DE'));

  const payload = {
    inventory_id: inventoryId,
    fetched_at_iso: new Date().toISOString(),
    count: rows.length,
    categories: rows,
  };

  if (args.json) {
    const target = path.isAbsolute(args.json) ? args.json : path.join(process.cwd(), args.json);
    fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`Wrote ${rows.length} categories to ${target}`);
  } else {
    // Print as a readable list.
    console.log(`Inventory ${inventoryId} categories (${rows.length}):`);
    for (const r of rows) {
      console.log(`${r.category_id}\tparent=${r.parent_id}\t${r.path || r.name}`);
    }
  }
}

main().catch((e) => {
  console.error('Failed:', e?.message || e);
  process.exit(1);
});

