const { callBaseLinker } = require('./baselinker');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function normalizeForSearch(text = '') {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s>:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const INDEX_TTL_MS = Math.max(
  10_000,
  parseInt(process.env.BASELINKER_CATEGORY_INDEX_TTL_MS || `${10 * 60 * 1000}`, 10) || 10 * 60 * 1000
);

const cache = new Map(); // inventoryId -> { atMs, rows, byId, byBreadcrumbKey }

function buildIndexFromCategories(categories = []) {
  const byId = new Map();
  const hasChild = new Set();
  for (const c of categories) {
    const id = Number(c?.category_id ?? c?.id ?? 0);
    if (!Number.isFinite(id) || id <= 0) continue;
    const name = normalizeSpaces(c?.name || '');
    const parentId = Number(c?.parent_id ?? c?.parent_category_id ?? 0) || 0;
    byId.set(id, { id, name, parentId });
    if (parentId && Number.isFinite(parentId)) {
      hasChild.add(parentId);
    }
  }

  const memo = new Map(); // id -> segments
  const buildSegments = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const node = byId.get(id);
    if (!node || !node.name) {
      memo.set(id, []);
      return [];
    }
    if (stack.has(id)) {
      const segs = [node.name];
      memo.set(id, segs);
      return segs;
    }
    stack.add(id);
    const parentSegs =
      node.parentId && byId.has(node.parentId) ? buildSegments(node.parentId, stack) : [];
    stack.delete(id);
    const segs = [...parentSegs, node.name];
    memo.set(id, segs);
    return segs;
  };

  const rows = Array.from(byId.values()).map((node) => {
    const segs = buildSegments(node.id);
    const breadcrumb = segs.filter(Boolean).join(' > ');
    const depth = segs.length;
    return {
      id: node.id,
      category_id: node.id,
      parent_id: node.parentId || 0,
      name: node.name || '',
      breadcrumb,
      depth,
      isLeaf: !hasChild.has(node.id),
      search: normalizeForSearch(`${breadcrumb} ${node.name || ''}`),
    };
  });
  rows.sort((a, b) => String(a.breadcrumb).localeCompare(String(b.breadcrumb), 'de-DE'));

  const byBreadcrumbKey = new Map(); // normalized breadcrumb -> smallest category_id
  for (const r of rows) {
    const k = normalizeForSearch(r.breadcrumb);
    if (!k) continue;
    const existing = byBreadcrumbKey.get(k);
    if (!existing || r.id < existing) byBreadcrumbKey.set(k, r.id);
  }

  return { rows, byId, byBreadcrumbKey };
}

async function getInventoryCategoryIndex(inventoryId) {
  const invKey = safeString(inventoryId || '');
  if (!invKey) {
    return { inventoryId: invKey, count: 0, rows: [], byId: new Map(), byBreadcrumbKey: new Map() };
  }

  const now = Date.now();
  const cached = cache.get(invKey);
  if (cached && now - (cached.atMs || 0) < INDEX_TTL_MS) {
    return cached.value;
  }

  const res = await callBaseLinker('getInventoryCategories', { inventory_id: Number(invKey) });
  const categories = Array.isArray(res?.categories) ? res.categories : [];
  const built = buildIndexFromCategories(categories);
  const value = {
    inventoryId: invKey,
    count: built.rows.length,
    rows: built.rows,
    byId: built.byId,
    byBreadcrumbKey: built.byBreadcrumbKey,
    fetchedAtIso: new Date().toISOString(),
  };
  cache.set(invKey, { atMs: now, value });
  return value;
}

async function searchInventoryCategories(inventoryId, query, { limit = 60, leafOnly = false } = {}) {
  const q = normalizeForSearch(query || '');
  const capped = Math.max(1, Math.min(parseInt(String(limit || 60), 10) || 60, 200));
  if (!q || q.length < 2) return [];

  const idx = await getInventoryCategoryIndex(inventoryId);
  const out = [];
  for (const r of idx.rows) {
    if (leafOnly && !r?.isLeaf) continue;
    if (!r?.search) continue;
    if (r.search.includes(q)) {
      out.push({
        id: String(r.category_id),
        name: r.name || '',
        breadcrumb: r.breadcrumb || r.name || '',
        parent_id: r.parent_id || 0,
        depth: r.depth || 0,
        isLeaf: Boolean(r.isLeaf),
      });
      if (out.length >= capped) break;
    }
  }
  return out;
}

async function getInventoryCategoryById(inventoryId, categoryId) {
  const invKey = safeString(inventoryId || '');
  const id = Number(categoryId || 0);
  if (!invKey || !Number.isFinite(id) || id <= 0) return null;
  const idx = await getInventoryCategoryIndex(invKey);
  const node = idx.byId.get(id);
  if (!node) return null;
  // Find breadcrumb in rows (cheap: small map would be nicer, but OK for 11k)
  const row = idx.rows.find((r) => r.id === id) || null;
  return {
    id: String(id),
    name: node.name || '',
    breadcrumb: row?.breadcrumb || node.name || '',
    parent_id: node.parentId || 0,
    depth: row?.depth || 0,
    isLeaf: Boolean(row?.isLeaf),
  };
}

async function resolveInventoryCategoryIdByBreadcrumb(inventoryId, breadcrumb) {
  const invKey = safeString(inventoryId || '');
  const b = normalizeSpaces(breadcrumb || '');
  if (!invKey || !b) return 0;
  const idx = await getInventoryCategoryIndex(invKey);
  const key = normalizeForSearch(b);
  const id = idx.byBreadcrumbKey.get(key);
  return Number(id || 0) || 0;
}

module.exports = {
  getInventoryCategoryIndex,
  searchInventoryCategories,
  getInventoryCategoryById,
  resolveInventoryCategoryIdByBreadcrumb,
  normalizeForSearch,
  normalizeSpaces,
};

