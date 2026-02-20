/* eslint-disable no-console */
/**
 * Bulk BaseLinker sync (PARAMS ONLY) for products that:
 * - have quantity >= minQty (default 1)
 *
 * This pushes:
 * - Parameters (from AvyCloud details.attributes)
 * - GPSR fields (from details.gpsr)
 * - K-Typ (as extra_field_18699)
 *
 * It does NOT touch:
 * - title/name, descriptions, highlights
 * - images, category, manufacturer
 * - stock/prices
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/sync-baselinker-params-only-minqty.js --inventory-id 78659 --min-qty 1
 *
 * Optional:
 *   --limit <n>
 *   --offset <n>
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');
const { syncProductsToBaseLinker } = require('../lib/baselinker');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickQuantity(product) {
  const candidates = [
    product?.inventory?.quantity,
    product?.storage?.quantity,
    product?.details?.attributes?.stock,
  ];
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string') {
      const numeric = Number(val);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const sum = bins.reduce((acc, b) => acc + (Number(b?.quantity) || 0), 0);
  return Number.isFinite(sum) ? sum : 0;
}

function parseArgs(argv) {
  const args = {
    inventoryId: process.env.BASELINKER_INVENTORY_ID || '78659',
    minQty: 1,
    limit: 0,
    offset: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--inventory-id' || t === '--inventory') {
      args.inventoryId = String(argv[i + 1] || '').trim();
      i += 1;
    }
    if (t === '--min-qty') {
      args.minQty = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--offset' || t === '--skip') {
      args.offset = Number(argv[i + 1]);
      i += 1;
    }
  }
  args.minQty = Number.isFinite(args.minQty) ? Math.max(1, Math.floor(args.minQty)) : 1;
  args.limit = Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : 0;
  args.offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  args.inventoryId = String(args.inventoryId || '78659').trim();
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'baselinker-params-only-sync', stamp);
  ensureDir(outDir);

  const inventoryId = args.inventoryId;
  console.log(`[baselinker-params-only] inventoryId=${inventoryId} out=${outDir}`);

  const products = await getAllProducts();
  const preCount = Array.isArray(products) ? products.length : 0;
  console.log(`[baselinker-params-only] loaded products=${preCount}`);

  const eligible = (Array.isArray(products) ? products : [])
    .filter((p) => p?.id)
    .filter((p) => pickQuantity(p) >= args.minQty);

  eligible.sort((a, b) => {
    const as = pickSku(a).toLowerCase();
    const bs = pickSku(b).toLowerCase();
    if (as && bs && as !== bs) return as.localeCompare(bs, 'de', { sensitivity: 'base' });
    return safeString(a?.id).localeCompare(safeString(b?.id), 'de', { sensitivity: 'base' });
  });

  const offset = args.offset ? eligible.slice(args.offset) : eligible;
  const selected = args.limit && args.limit > 0 ? offset.slice(0, args.limit) : offset;

  const summary = {
    mode: 'APPLY',
    syncMode: 'params_only',
    inventoryId,
    minQty: args.minQty,
    limit: args.limit || null,
    offset: args.offset || 0,
    counts: {
      total: preCount,
      eligible: eligible.length,
      selected: selected.length,
    },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[baselinker-params-only] syncing selected=${selected.length} (qty>=${args.minQty})…`);

  const results = await syncProductsToBaseLinker(selected, inventoryId, {
    mode: 'params_only',
    onProgress: async ({ index, total, result }) => {
      if ((index + 1) % 25 === 0 || index + 1 === total) {
        console.log(`[baselinker-params-only] ${index + 1}/${total} ${result?.status || 'unknown'} ${result?.id || ''}`);
      }
    },
  });

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('[baselinker-params-only] done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

