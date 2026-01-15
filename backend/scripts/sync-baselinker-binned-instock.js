/* eslint-disable no-console */
/**
 * Bulk BaseLinker sync for products that:
 * - have quantity >= 1
 * - are assigned to a BIN
 *
 * This is intended to push recent datasheet/title changes + stock to BaseLinker for "ready to sell" items.
 *
 * Safety:
 * - Default is DRY-RUN (no BaseLinker API calls).
 * - Use --apply to actually sync.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/sync-baselinker-binned-instock.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/sync-baselinker-binned-instock.js --apply --expected-count 531
 *
 * Options:
 *   --inventory-id <id>      BaseLinker inventory id (default: BASELINKER_INVENTORY_ID or 78659)
 *   --min-qty <n>            Default 1
 *   --limit <n>              Limit number of products to sync (useful for testing)
 *   --expected-count <n>     Safety guard for --apply: must match Firestore products count
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

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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
  // Fallback: sum storageBins if present (some imports store stock there)
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const sum = bins.reduce((acc, b) => acc + (Number(b?.quantity) || 0), 0);
  return Number.isFinite(sum) ? sum : 0;
}

function pickBinCode(product) {
  const direct = safeString(product?.storage?.binCode);
  if (direct) return direct;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  for (const b of bins) {
    const code = safeString(b?.code || b?.binCode);
    if (code) return code;
  }
  return '';
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    expectedCount: 0,
    limit: 0,
    offset: 0,
    minQty: 1,
    inventoryId: process.env.BASELINKER_INVENTORY_ID || '78659',
  };
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
    if (t === '--expected-count') {
      args.expectedCount = Number(argv[i + 1]);
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
    if (t === '--min-qty') {
      args.minQty = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--inventory-id' || t === '--inventory') {
      args.inventoryId = String(argv[i + 1] || '').trim();
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'baselinker-sync', stamp);
  ensureDir(outDir);

  const inventoryId = String(args.inventoryId || '').trim() || '78659';
  const mode = args.apply ? 'APPLY' : 'DRY_RUN';
  console.log(`[baselinker-sync] mode=${mode} inventoryId=${inventoryId} out=${outDir}`);

  const products = await getAllProducts();
  const preCount = products.length;
  console.log(`[baselinker-sync] loaded products=${preCount}`);

  if (args.apply) {
    if (!Number.isFinite(args.expectedCount) || args.expectedCount <= 0) {
      throw new Error('[baselinker-sync] ABORT: --apply requires --expected-count <number>');
    }
    if (preCount !== args.expectedCount) {
      throw new Error(`[baselinker-sync] ABORT: expected=${args.expectedCount} but got=${preCount}`);
    }
  }

  const eligible = [];
  const rows = [];
  for (const p of products) {
    const qty = pickQuantity(p);
    const bin = pickBinCode(p);
    const okQty = Number(qty) >= Number(args.minQty);
    const okBin = Boolean(bin);
    const isEligible = okQty && okBin;
    if (isEligible) {
      eligible.push(p);
    }
    rows.push({
      sku: pickSku(p),
      productId: safeString(p?.id),
      qty,
      bin,
      eligible: isEligible ? 'yes' : 'no',
      baselinker_linked: p?.ops?.baselinker?.product_id || p?.ops?.base_product_id ? 'yes' : 'no',
      last_saved_source: safeString(p?.ops?.last_saved_source),
      title: safeString(p?.identification?.name),
    });
  }

  // Deterministic ordering so we can batch via --offset/--limit
  eligible.sort((a, b) => {
    const as = pickSku(a).toLowerCase();
    const bs = pickSku(b).toLowerCase();
    if (as && bs && as !== bs) return as.localeCompare(bs, 'de', { sensitivity: 'base' });
    const ai = safeString(a?.id);
    const bi = safeString(b?.id);
    return ai.localeCompare(bi, 'de', { sensitivity: 'base' });
  });

  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
  let selected = offset ? eligible.slice(offset) : eligible;
  if (Number.isFinite(args.limit) && args.limit > 0) {
    selected = selected.slice(0, Math.max(0, Math.floor(args.limit)));
  }

  const summary = {
    mode,
    inventoryId,
    minQty: args.minQty,
    limit: args.limit || null,
    offset,
    counts: {
      total: preCount,
      eligible: eligible.length,
      selected: selected.length,
    },
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const headers = ['sku', 'productId', 'qty', 'bin', 'eligible', 'baselinker_linked', 'last_saved_source', 'title'];
  const csvLines = [headers.join(',')];
  rows.forEach((r) => {
    csvLines.push(headers.map((h) => csvEscape(r[h] ?? '')).join(','));
  });
  fs.writeFileSync(path.join(outDir, 'products.csv'), csvLines.join('\n'), 'utf8');

  console.log(
    `[baselinker-sync] eligible=${eligible.length} selected=${selected.length} (qty>=${args.minQty} & BIN assigned)`
  );

  if (!args.apply) {
    console.log('[baselinker-sync] DRY_RUN complete. No BaseLinker API calls were made.');
    return;
  }

  console.log(`[baselinker-sync] Syncing ${selected.length} products to BaseLinker inventory ${inventoryId}...`);
  const results = await syncProductsToBaseLinker(selected, inventoryId);

  const success = results.filter((r) => r && r.status === 'synced').length;
  const failed = results.filter((r) => r && r.status === 'failed').length;
  const unknown = results.length - success - failed;

  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'results_summary.json'),
    JSON.stringify({ ...summary, results: { success, failed, unknown } }, null, 2),
    'utf8'
  );

  console.log(`[baselinker-sync] DONE success=${success} failed=${failed} unknown=${unknown}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

