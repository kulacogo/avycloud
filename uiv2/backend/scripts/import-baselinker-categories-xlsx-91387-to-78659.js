/* eslint-disable no-console */
/**
 * Import BaseLinker category taxonomy from `bl_nventory_cat.xlsx` sheet 91387 into inventory 78659.
 *
 * - Resume-safe: if categories already exist, it only creates missing nodes.
 * - Parent tree is built via BaseLinker `parent_id` using ensureInventoryCategory().
 * - Retries transient network/DNS issues instead of aborting.
 *
 * Usage:
 *   BASELINKER_MAX_PARALLEL_REQUESTS=1 BASELINKER_MIN_REQUEST_INTERVAL_MS=650 \\
 *   node backend/scripts/import-baselinker-categories-xlsx-91387-to-78659.js
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const { callBaseLinker, ensureInventoryCategory } = require('../lib/baselinker');

function safeString(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function normalizeSegment(seg) {
  return safeString(seg)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[‐‑‒–—−]/g, '-')
    .trim();
}

function pathKeyFromSegments(segs) {
  return segs.map((s) => normalizeSegment(s).toLowerCase()).filter(Boolean).join('>');
}

function pathStringFromSegments(segs) {
  return segs.filter(Boolean).join(' > ');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientNetworkError(err) {
  const msg = (err?.message || '').toString();
  const code = (err?.code || '').toString();
  return (
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    msg.includes('getaddrinfo ENOTFOUND') ||
    msg.includes('fetch failed') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('timeout')
  );
}

async function retry(fn, { retries = 12, baseDelayMs = 2000, maxDelayMs = 60000 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (e) {
      attempt += 1;
      const transient = isTransientNetworkError(e);
      if (!transient || attempt > retries) {
        throw e;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.min(attempt - 1, 6)));
      console.warn(`[import] transient error (attempt ${attempt}/${retries}), retrying in ${delay}ms:`, e?.message || e);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const TARGET_INVENTORY_ID = '78659';
  const SOURCE_SHEET = '91387';

  const filePath = path.resolve(__dirname, '..', '..', 'bl_nventory_cat.xlsx');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing xlsx: ${filePath}`);
  }

  console.log(
    JSON.stringify(
      {
        action: 'import-baselinker-categories-xlsx-91387-to-78659',
        started_at_iso: nowIso(),
        file: filePath,
        source_sheet: SOURCE_SHEET,
        target_inventory_id: TARGET_INVENTORY_ID,
        rate: {
          max_parallel: process.env.BASELINKER_MAX_PARALLEL_REQUESTS || null,
          min_interval_ms: process.env.BASELINKER_MIN_REQUEST_INTERVAL_MS || null,
        },
      },
      null,
      2
    )
  );

  const startCats = await retry(async () => {
    const res = await callBaseLinker('getInventoryCategories', { inventory_id: Number(TARGET_INVENTORY_ID) });
    return Array.isArray(res?.categories) ? res.categories.length : 0;
  });
  console.log(JSON.stringify({ target_inventory_id: TARGET_INVENTORY_ID, categories_before: startCats }, null, 2));

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets?.[SOURCE_SHEET];
  if (!ws) throw new Error(`Sheet not found: ${SOURCE_SHEET}`);

  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const header = aoa[0] || [];
  const levelCount = header.length;
  const rows = aoa.slice(1);

  const nodeMap = new Map(); // pathKey -> { path, depth }
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const segsRaw = [];
    for (let i = 0; i < levelCount; i += 1) {
      segsRaw.push(normalizeSegment(row[i] ?? ''));
    }
    if (!segsRaw.some(Boolean)) continue;

    let depth = 0;
    for (let i = 0; i < levelCount; i += 1) {
      if (!segsRaw[i]) break;
      depth += 1;
    }
    if (depth <= 0) continue;

    const segs = segsRaw.slice(0, depth);
    for (let i = 1; i <= segs.length; i += 1) {
      const prefixSegs = segs.slice(0, i);
      const key = pathKeyFromSegments(prefixSegs);
      if (!key) continue;
      if (nodeMap.has(key)) continue;
      nodeMap.set(key, { depth: prefixSegs.length, path: pathStringFromSegments(prefixSegs) });
    }
  }

  const nodes = Array.from(nodeMap.values());
  nodes.sort((a, b) => (a.depth - b.depth) || a.path.localeCompare(b.path, 'de-DE'));
  console.log(
    JSON.stringify(
      { target_inventory_id: TARGET_INVENTORY_ID, source_sheet: SOURCE_SHEET, rows: rows.length, unique_nodes: nodes.length },
      null,
      2
    )
  );

  const startedMs = Date.now();
  let processed = 0;
  for (const n of nodes) {
    // ensureInventoryCategory is already resume-safe (reuses existing by path and by parent+name).
    // We still wrap with retries to survive transient DNS/network issues.
    // eslint-disable-next-line no-await-in-loop
    await retry(() => ensureInventoryCategory(TARGET_INVENTORY_ID, n.path, { canonicalize: false }));
    processed += 1;

    if (processed % 50 === 0) {
      const elapsedS = Math.round((Date.now() - startedMs) / 1000);
      console.log(JSON.stringify({ target_inventory_id: TARGET_INVENTORY_ID, progress: processed, total: nodes.length, elapsed_s: elapsedS }, null, 2));
    }

    // Occasionally verify counts (low frequency)
    if (processed % 1000 === 0) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const cnt = await retry(async () => {
          const res = await callBaseLinker('getInventoryCategories', { inventory_id: Number(TARGET_INVENTORY_ID) });
          return Array.isArray(res?.categories) ? res.categories.length : 0;
        });
        console.log(JSON.stringify({ target_inventory_id: TARGET_INVENTORY_ID, categories_now: cnt, at_progress: processed }, null, 2));
      } catch (e) {
        console.warn('[import] count check failed (continuing):', e?.message || e);
      }
    }
  }

  const endCats = await retry(async () => {
    const res = await callBaseLinker('getInventoryCategories', { inventory_id: Number(TARGET_INVENTORY_ID) });
    return Array.isArray(res?.categories) ? res.categories.length : 0;
  });
  const elapsedS = Math.round((Date.now() - startedMs) / 1000);
  console.log(JSON.stringify({ target_inventory_id: TARGET_INVENTORY_ID, ok: true, categories_after: endCats, elapsed_s: elapsedS }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});

