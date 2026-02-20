const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function safeString(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

function normalizeDashVariants(text = '') {
  // Replace common unicode dash variants with ASCII '-'
  return safeString(text).replace(/[‐‑‒–—−]/g, '-');
}

function normalizeSegment(seg) {
  return normalizeDashVariants(seg).replace(/\s+/g, ' ').trim();
}

function joinPath(segments) {
  return (segments || []).filter(Boolean).join(' > ');
}

function pathKey(segments) {
  return (segments || [])
    .map((s) => normalizeSegment(s).toLowerCase())
    .filter(Boolean)
    .join('>');
}

function resolveDefaultXlsxPath() {
  // Repo root is one level above /backend
  const env = (process.env.BASELINKER_CATEGORY_XLSX_PATH || '').toString().trim();
  if (env) return env;
  return path.join(__dirname, '..', '..', 'bl_nventory_cat.xlsx');
}

const WORKBOOK_TTL_MS = Math.max(
  5_000,
  parseInt(process.env.BASELINKER_CATEGORY_XLSX_TTL_MS || `${30 * 60 * 1000}`, 10) || 30 * 60 * 1000
);

let workbookCache = { atMs: 0, filePath: '', workbook: null };
const sheetCache = new Map(); // inventoryId -> { atMs, nodes: string[], leaves: string[], maxDepth: number }

function loadWorkbookCached() {
  const now = Date.now();
  const filePath = resolveDefaultXlsxPath();
  if (
    workbookCache.workbook &&
    workbookCache.filePath === filePath &&
    now - (workbookCache.atMs || 0) < WORKBOOK_TTL_MS
  ) {
    return workbookCache.workbook;
  }

  if (!fs.existsSync(filePath)) {
    workbookCache = { atMs: now, filePath, workbook: null };
    return null;
  }

  const wb = XLSX.readFile(filePath);
  workbookCache = { atMs: now, filePath, workbook: wb };
  // Invalidate per-sheet caches when workbook reloads
  sheetCache.clear();
  return wb;
}

function computeSheetIndex(wb, inventoryId) {
  const invKey = String(inventoryId || '').trim();
  if (!invKey) return null;
  const ws = wb.Sheets?.[invKey];
  if (!ws) return null;

  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const header = Array.isArray(aoa?.[0]) ? aoa[0] : [];
  const levelCount = header.length || 0;
  const rows = Array.isArray(aoa) ? aoa.slice(1) : [];

  const leafSet = new Set();
  const nodeSet = new Set();
  let maxDepth = 0;

  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const segs = [];
    for (let i = 0; i < levelCount; i += 1) segs.push(normalizeSegment(row[i] ?? ''));
    if (!segs.some(Boolean)) continue;

    let depth = 0;
    for (let i = 0; i < levelCount; i += 1) {
      if (!segs[i]) break;
      depth += 1;
    }
    if (depth <= 0) continue;
    maxDepth = Math.max(maxDepth, depth);

    const leafSegs = segs.slice(0, depth);
    leafSet.add(joinPath(leafSegs));
    for (let i = 1; i <= leafSegs.length; i += 1) {
      nodeSet.add(joinPath(leafSegs.slice(0, i)));
    }
  }

  const leaves = Array.from(leafSet).filter(Boolean);
  const nodes = Array.from(nodeSet).filter(Boolean);
  // Deterministic sorting (nice for UI)
  leaves.sort((a, b) => a.localeCompare(b, 'de-DE'));
  nodes.sort((a, b) => a.localeCompare(b, 'de-DE'));

  return { inventoryId: invKey, nodes, leaves, maxDepth, levelCount, rows: rows.length };
}

function getInventoryCategoryIndex(inventoryId) {
  const invKey = String(inventoryId || '').trim();
  if (!invKey) return { inventoryId: invKey, nodes: [], leaves: [], maxDepth: 0, levelCount: 0, rows: 0 };

  const now = Date.now();
  const cached = sheetCache.get(invKey);
  if (cached && now - (cached.atMs || 0) < WORKBOOK_TTL_MS) {
    return cached.value;
  }

  const wb = loadWorkbookCached();
  if (!wb) {
    const empty = { inventoryId: invKey, nodes: [], leaves: [], maxDepth: 0, levelCount: 0, rows: 0 };
    sheetCache.set(invKey, { atMs: now, value: empty });
    return empty;
  }

  const computed = computeSheetIndex(wb, invKey);
  const value =
    computed || { inventoryId: invKey, nodes: [], leaves: [], maxDepth: 0, levelCount: 0, rows: 0 };
  sheetCache.set(invKey, { atMs: now, value });
  return value;
}

function normalizeForSearch(text = '') {
  return normalizeDashVariants(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchInventoryCategoryPaths(inventoryId, query, { limit = 60, leafOnly = false } = {}) {
  const idx = getInventoryCategoryIndex(inventoryId);
  const q = normalizeForSearch(query || '');
  const capped = Math.max(1, Math.min(parseInt(String(limit || 60), 10) || 60, 200));
  const items = leafOnly ? idx.leaves : idx.nodes;
  if (!q || q.length < 2) return [];

  const leafSet = new Set(Array.isArray(idx.leaves) ? idx.leaves : []);
  const out = [];
  for (const p of items) {
    if (normalizeForSearch(p).includes(q)) {
      const depth = p.split('>').map((s) => s.trim()).filter(Boolean).length;
      out.push({ path: p, depth, isLeaf: leafSet.has(p) });
      if (out.length >= capped) break;
    }
  }
  return out;
}

module.exports = {
  getInventoryCategoryIndex,
  searchInventoryCategoryPaths,
  // exported for unit tests / future use
  resolveDefaultXlsxPath,
  normalizeSegment,
  joinPath,
  pathKey,
};

