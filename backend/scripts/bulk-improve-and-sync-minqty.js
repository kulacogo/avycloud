/* eslint-disable no-console */
/**
 * Bulk improve + BaseLinker sync for products with quantity >= minQty.
 *
 * What it does (per product):
 *  1) improveExistingProduct(productId)  (LLM + BrightData evidence)
 *  2) syncProductToBaseLinker(improvedProduct, inventoryId) (push all fields)
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud \
 *   node backend/scripts/bulk-improve-and-sync-minqty.js --inventory-id 78659 --min-qty 1 --concurrency 2
 *
 * Options:
 *   --inventory-id <id>     BaseLinker inventory id (default: BASELINKER_INVENTORY_ID or 78659)
 *   --min-qty <n>           default 1
 *   --limit <n>             optional limit (for testing)
 *   --offset <n>            optional offset (resume)
 *   --concurrency <n>       parallel workers (default 2)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PQueue = require('p-queue').default;
const { getAllProducts } = require('../lib/firestore');
const { improveExistingProduct } = require('../services/improve');
const { syncProductToBaseLinker } = require('../lib/baselinker');

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
    concurrency: 2,
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
    if (t === '--concurrency' || t === '--workers') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
  }
  args.minQty = Number.isFinite(args.minQty) ? Math.max(1, Math.floor(args.minQty)) : 1;
  args.limit = Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : 0;
  args.offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  args.concurrency = Number.isFinite(args.concurrency) ? Math.max(1, Math.floor(args.concurrency)) : 2;
  args.inventoryId = String(args.inventoryId || '78659').trim() || '78659';
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'bulk-improve-sync', stamp);
  ensureDir(outDir);

  const inventoryId = args.inventoryId;
  console.log(`[bulk-improve-sync] inventoryId=${inventoryId} minQty=${args.minQty} concurrency=${args.concurrency} out=${outDir}`);

  const all = await getAllProducts();
  const total = Array.isArray(all) ? all.length : 0;
  console.log(`[bulk-improve-sync] loaded products=${total}`);

  const eligible = (Array.isArray(all) ? all : [])
    .filter((p) => p?.id)
    .map((p) => ({ product: p, qty: pickQuantity(p) }))
    .filter((x) => Number(x.qty) >= args.minQty);

  eligible.sort((a, b) => {
    const as = pickSku(a.product).toLowerCase();
    const bs = pickSku(b.product).toLowerCase();
    if (as && bs && as !== bs) return as.localeCompare(bs, 'de', { sensitivity: 'base' });
    return safeString(a.product?.id).localeCompare(safeString(b.product?.id), 'de', { sensitivity: 'base' });
  });

  const offsetList = args.offset ? eligible.slice(args.offset) : eligible;
  const selected = args.limit && args.limit > 0 ? offsetList.slice(0, args.limit) : offsetList;

  const summary = {
    inventoryId,
    minQty: args.minQty,
    limit: args.limit || null,
    offset: args.offset || 0,
    concurrency: args.concurrency,
    counts: {
      total,
      eligible: eligible.length,
      selected: selected.length,
    },
    started_at_iso: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const resultsJsonlPath = path.join(outDir, 'results.jsonl');
  fs.writeFileSync(resultsJsonlPath, '', { encoding: 'utf8', flag: 'w' });

  const progressPath = path.join(outDir, 'progress.json');
  const progress = {
    ...summary,
    done: 0,
    improved_ok: 0,
    improved_failed: 0,
    synced_ok: 0,
    synced_failed: 0,
    last: null,
    updated_at_iso: new Date().toISOString(),
  };
  fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');

  const queue = new PQueue({ concurrency: args.concurrency });

  const tasks = selected.map((entry, idx) => {
    const productId = entry.product.id;
    const sku = pickSku(entry.product);
    const qty = entry.qty;
    const runId = crypto.randomUUID();

    return queue.add(async () => {
      const startedAt = new Date().toISOString();
      const logPrefix = `[bulk-improve-sync] (${idx + 1}/${selected.length}) id=${productId} sku=${sku} qty=${qty}`;
      console.log(`${logPrefix} START`);

      let improved = null;
      let improveError = null;
      try {
        improved = await improveExistingProduct(productId, async (stage) => {
          // keep logs short but visible
          if (stage) console.log(`${logPrefix} stage=${stage}`);
        });
      } catch (e) {
        improveError = e?.message || String(e);
      }

      let syncResult = null;
      let syncError = null;
      if (improved && !improveError) {
        try {
          syncResult = await syncProductToBaseLinker(improved, inventoryId, {
            onProgress: null,
          });
        } catch (e) {
          syncError = e?.message || String(e);
        }
      }

      const finishedAt = new Date().toISOString();
      const record = {
        runId,
        index: idx,
        total: selected.length,
        productId,
        sku,
        qty,
        startedAt,
        finishedAt,
        improve: improved
          ? { ok: true, title: safeString(improved?.identification?.name), warnings: improved?.notes?.warnings || [] }
          : { ok: false, error: improveError || 'unknown' },
        baselinker: syncResult
          ? { ok: syncResult.status === 'synced', ...syncResult }
          : improved
            ? { ok: false, error: syncError || 'unknown' }
            : { ok: false, skipped: true },
      };

      fs.appendFileSync(resultsJsonlPath, `${JSON.stringify(record)}\n`, 'utf8');

      // update progress
      progress.done += 1;
      if (record.improve.ok) progress.improved_ok += 1;
      else progress.improved_failed += 1;
      if (record.baselinker.ok) progress.synced_ok += 1;
      else if (!record.baselinker.skipped) progress.synced_failed += 1;
      progress.last = { productId, sku, improve: record.improve, baselinker: record.baselinker };
      progress.updated_at_iso = new Date().toISOString();
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2), 'utf8');

      const statusLine = `${logPrefix} DONE improve=${record.improve.ok ? 'ok' : 'fail'} sync=${record.baselinker.ok ? 'ok' : record.baselinker.skipped ? 'skipped' : 'fail'}`;
      console.log(statusLine);
      return record;
    });
  });

  await Promise.all(tasks);
  await queue.onIdle();

  const final = {
    ...progress,
    finished_at_iso: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'final.json'), JSON.stringify(final, null, 2), 'utf8');
  console.log(
    `[bulk-improve-sync] DONE selected=${selected.length} improved_ok=${final.improved_ok} improved_failed=${final.improved_failed} synced_ok=${final.synced_ok} synced_failed=${final.synced_failed}`
  );
  console.log(`[bulk-improve-sync] results: ${resultsJsonlPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

