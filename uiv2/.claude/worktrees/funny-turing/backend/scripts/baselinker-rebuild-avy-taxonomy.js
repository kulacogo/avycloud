/* eslint-disable no-console */
/**
 * Rebuild BaseLinker inventory categories to a compact Avy taxonomy (few categories),
 * derived from marketplaces (see backend/avy-taxonomy/avy-taxonomy.json).
 *
 * Strategy (safe):
 * - Create/ensure Avy taxonomy categories (idempotent, no duplicates).
 * - Move ALL inventory products into the closest Avy category (based on current breadcrumb).
 * - Delete all non-Avy categories (best-effort, leaf-first, multiple passes).
 *
 * Dry-run by default (no writes). Use --apply to execute.
 *
 * Usage:
 *   node backend/scripts/baselinker-rebuild-avy-taxonomy.js --inventory 78659 --dry-run
 *   node backend/scripts/baselinker-rebuild-avy-taxonomy.js --inventory 78659 --apply
 *
 * Options:
 *   --taxonomy backend/avy-taxonomy/avy-taxonomy.json
 *   --limit-products <n>       (for testing apply on a subset)
 *   --skip-delete              (create + move products, but don't delete old categories)
 */
const fs = require('fs');
const path = require('path');
const { callBaseLinker } = require('../lib/baselinker');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
function safeInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}
function normalizeForMatch(text = '') {
  return normalizeSpaces(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' und ')
    .replace(/[\u2010-\u2015]/g, '-') // dash variants
    .replace(/[()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s:-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBreadcrumb(breadcrumb) {
  return safeString(breadcrumb)
    .split('>')
    .map((s) => normalizeSpaces(s))
    .filter(Boolean);
}

function cleanSegment(seg) {
  const raw = normalizeSpaces(seg);
  if (!raw) return '';
  return raw
    .replace(/,\s*g[üu]nstig kaufen.*$/i, '')
    .replace(/\s+g[üu]nstig kaufen.*$/i, '')
    .replace(/:\s*kaufen.*$/i, '')
    .replace(/\s+bei\s+hood\.de$/i, '')
    .replace(/\s+kaufen\s+bei\s+hood\.de$/i, '')
    .replace(/\s+\-\s*kaufen\s+bei\s+hood\.de$/i, '')
    .replace(/\s+kaufen$/i, '')
    .trim();
}

function takeNonGeneric(segments) {
  return segments.filter((s) => {
    const k = normalizeForMatch(s);
    if (!k) return false;
    if (k === 'sonstige') return false;
    if (k.startsWith('sonstig')) return false;
    return true;
  });
}

// Root mapping should match the generator logic closely
function mapRoot(rawRoot) {
  const r = normalizeForMatch(rawRoot);
  if (!r) return null;
  const has = (re) => re.test(r);
  if (has(/\b(auto|motorrad|kfz|fahrzeug)\b/)) return 'Auto & Motorrad';
  if (has(/\b(baby|kind|kinder)\b/)) return 'Baby & Kind';
  if (has(/\b(beauty|kosmetik|pflege|gesundheit|hygiene)\b/)) return 'Beauty & Gesundheit';
  if (has(/\b(business|industrie|gewerbe|grosshandel|groshandel)\b/)) return 'Business & Industrie';
  if (has(/\b(elektronik|computer|hifi|audio|telefon|smart|tv|kamera)\b/)) return 'Elektronik';
  if (has(/\b(kueche|küche|haushalt|kochen)\b/)) return 'Haushalt & Küche';
  if (has(/\b(heimwerker|garten|terrasse|baumarkt)\b/)) return 'Heimwerker & Garten';
  if (has(/\b(mode|bekleidung|kleidung|schuhe|accessoires|taschen)\b/)) return 'Mode & Accessoires';
  if (has(/\b(mobel|möbel|wohnen)\b/)) return 'Möbel & Wohnen';
  if (has(/\b(musik|instrument)\b/)) return 'Musik & Instrumente';
  if (has(/\b(sport|outdoor|camping|fitness)\b/)) return 'Sport & Outdoor';
  if (has(/\b(spielwaren|spielzeug|modellbau)\b/)) return 'Spielwaren';
  if (has(/\b(sammeln|antiquitat|antiquität|kunst|munzen|münzen|briefmarken)\b/)) return 'Sammeln & Kunst';
  if (has(/\b(buro|büro|schreibwaren)\b/)) return 'Büro & Schreibwaren';
  if (has(/\b(buch|bücher|medien|dvd|film)\b/)) return 'Bücher & Medien';
  if (has(/\b(tier|haustier)\b/)) return 'Tierbedarf';
  if (has(/\b(reise|gepack|gepäck|koffer)\b/)) return 'Reisen & Gepäck';
  return null;
}

function parseArgs(argv) {
  const args = {
    inventoryId: String(process.env.BASELINKER_INVENTORY_ID || '78659'),
    taxonomy: path.join(process.cwd(), 'backend', 'avy-taxonomy', 'avy-taxonomy.json'),
    apply: false,
    dryRun: true,
    limitProducts: 0,
    skipDelete: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--inventory' || t === '--inventory-id') args.inventoryId = String(argv[i + 1] || ''), i += 1;
    else if (t === '--taxonomy') args.taxonomy = String(argv[i + 1] || ''), i += 1;
    else if (t === '--apply') args.apply = true, args.dryRun = false;
    else if (t === '--dry-run') args.dryRun = true, args.apply = false;
    else if (t === '--limit-products') args.limitProducts = Number(argv[i + 1]), i += 1;
    else if (t === '--skip-delete') args.skipDelete = true;
  }
  return args;
}

function loadTaxonomy(filePath) {
  const p = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  const raw = fs.readFileSync(p, 'utf8');
  const json = JSON.parse(raw);
  const categories = Array.isArray(json?.categories) ? json.categories.filter(Boolean) : [];
  return { file: p, categories };
}

function buildAllowedSets(categories) {
  const paths = new Set(categories.map((p) => normalizeSpaces(p)));
  const allowed2 = new Map(); // root -> Set(l2)
  const allowed3 = new Map(); // root|||l2 -> Set(l3)
  for (const p of paths) {
    const segs = splitBreadcrumb(p);
    if (segs.length === 1) continue;
    const root = segs[0];
    const l2 = segs[1];
    if (!allowed2.has(root)) allowed2.set(root, new Set());
    allowed2.get(root).add(l2);
    if (segs.length >= 3) {
      const l3 = segs[2];
      const k = `${root}|||${l2}`;
      if (!allowed3.has(k)) allowed3.set(k, new Set());
      allowed3.get(k).add(l3);
    }
  }
  return { paths, allowed2, allowed3 };
}

function mapBreadcrumbToAvyPath(breadcrumb, allowed) {
  const segsRaw = splitBreadcrumb(breadcrumb).map(cleanSegment).filter(Boolean);
  if (!segsRaw.length) return null;
  const root = mapRoot(segsRaw[0]) || mapRoot(segsRaw.slice(0, 2).join(' '));
  if (!root) return null;
  const rest = segsRaw.slice(1);
  const meaningful = takeNonGeneric(rest);
  let lvl2 = meaningful[0] ? cleanSegment(meaningful[0]) : 'Sonstige';
  if (!allowed.allowed2.get(root)?.has(lvl2)) lvl2 = 'Sonstige';
  let lvl3 = meaningful[1] ? cleanSegment(meaningful[1]) : '';
  const k3 = `${root}|||${lvl2}`;
  if (lvl3 && !allowed.allowed3.get(k3)?.has(lvl3)) lvl3 = '';
  const candidate3 = lvl3 ? `${root} > ${lvl2} > ${lvl3}` : '';
  if (candidate3 && allowed.paths.has(candidate3)) return candidate3;
  const candidate2 = `${root} > ${lvl2}`;
  if (allowed.paths.has(candidate2)) return candidate2;
  if (allowed.paths.has(root)) return root;
  return null;
}

async function fetchCategories(inventoryId) {
  const res = await callBaseLinker('getInventoryCategories', { inventory_id: Number(inventoryId) });
  const cats = Array.isArray(res?.categories) ? res.categories : [];
  const byId = new Map();
  for (const c of cats) {
    const id = safeInt(c?.category_id ?? c?.id, 0);
    if (!id) continue;
    byId.set(id, {
      id,
      name: normalizeSpaces(c?.name || ''),
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
    const parent = node.parentId && byId.has(node.parentId) ? buildBreadcrumb(node.parentId, stack) : '';
    stack.delete(id);
    const crumb = parent ? `${parent} > ${node.name || String(id)}` : (node.name || String(id));
    memo.set(id, crumb);
    return crumb;
  };
  const rows = Array.from(byId.values()).map((c) => ({ ...c, breadcrumb: buildBreadcrumb(c.id) }));
  return { byId, rows };
}

async function listProducts(inventoryId) {
  const out = [];
  let page = 1;
  while (true) {
    const res = await callBaseLinker('getInventoryProductsList', { inventory_id: Number(inventoryId), page });
    const raw = res?.products || res?.items || {};
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    if (!list.length) break;
    for (const e of list) {
      const pid = safeInt(e?.product_id ?? e?.id, 0);
      const catId = safeInt(e?.category_id, 0);
      if (!pid) continue;
      out.push({ productId: pid, categoryId: catId });
    }
    if (list.length < 1000) break;
    page += 1;
    if (page > 5000) break;
  }
  return out;
}

function depthOfBreadcrumb(b) {
  return splitBreadcrumb(b).length;
}

function chunkArray(arr, size) {
  const s = Math.max(1, Math.min(200, Number(size) || 100));
  const out = [];
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s));
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const inventoryId = String(args.inventoryId || '').trim();
  if (!inventoryId) throw new Error('Missing --inventory');
  const dryRun = args.dryRun;
  const { file: taxonomyFile, categories: avyCategories } = loadTaxonomy(args.taxonomy);
  const allowed = buildAllowedSets(avyCategories);

  console.log(JSON.stringify({ action: 'baselinker-rebuild-avy-taxonomy', inventoryId, dryRun, taxonomyFile, avyCategories: avyCategories.length, skipDelete: args.skipDelete }, null, 2));

  const { rows: existingCats } = await fetchCategories(inventoryId);
  const existingByBreadcrumb = new Map();
  for (const c of existingCats) {
    const key = normalizeForMatch(c.breadcrumb);
    if (!key) continue;
    if (!existingByBreadcrumb.has(key)) existingByBreadcrumb.set(key, c.id);
  }

  // Create/ensure Avy categories (idempotent; no duplicates by parent+name)
  // We'll create with addInventoryCategory by path segments.
  const byParentName = new Map(); // `${parentId}:${nameKey}` -> id
  existingCats.forEach((c) => {
    const k = `${c.parentId || 0}:${normalizeForMatch(c.name)}`;
    if (!byParentName.has(k)) byParentName.set(k, c.id);
  });

  const pathToId = new Map(); // normalized breadcrumb key -> id
  existingCats.forEach((c) => {
    pathToId.set(normalizeForMatch(c.breadcrumb), c.id);
  });

  const ensurePath = async (pathStr) => {
    const segs = splitBreadcrumb(pathStr).map(cleanSegment).filter(Boolean);
    let parentId = 0;
    let built = [];
    for (const seg of segs) {
      built.push(seg);
      const bKey = normalizeForMatch(built.join(' > '));
      const cached = pathToId.get(bKey);
      if (cached) {
        parentId = cached;
        continue;
      }
      const nameKey = normalizeForMatch(seg);
      const parentNameKey = `${parentId || 0}:${nameKey}`;
      const byName = byParentName.get(parentNameKey);
      if (byName) {
        parentId = byName;
        pathToId.set(bKey, parentId);
        continue;
      }
      if (dryRun) {
        // fake id placeholder in dry-run (stable-ish)
        parentId = parentId || 0;
        continue;
      }
      const resp = await callBaseLinker('addInventoryCategory', {
        inventory_id: Number(inventoryId),
        name: seg,
        parent_id: parentId || 0,
      });
      if (resp?.status !== 'SUCCESS' || !resp?.category_id) {
        throw new Error(resp?.error_message || 'addInventoryCategory failed');
      }
      const newId = safeInt(resp.category_id, 0);
      parentId = newId;
      byParentName.set(parentNameKey, newId);
      pathToId.set(bKey, newId);
    }
    return parentId || 0;
  };

  let ensuredCats = 0;
  for (const p of avyCategories) {
    await ensurePath(p);
    ensuredCats += 1;
    if (ensuredCats % 50 === 0) console.log(`[avy-taxonomy] ensured ${ensuredCats}/${avyCategories.length}`);
  }

  // Re-fetch categories after creation to get real ids
  const { rows: catsAfterCreate } = await fetchCategories(inventoryId);
  const idToBreadcrumb = new Map(catsAfterCreate.map((c) => [c.id, c.breadcrumb]));
  const desiredBreadcrumbKeys = new Set(avyCategories.map((p) => normalizeForMatch(p)));
  const desiredIds = new Set();
  // In APPLY mode, we'll use IDs of Avy categories to protect them from deletion.
  // In DRY_RUN, IDs are not meaningful because we don't create categories; we use breadcrumb keys instead.
  for (const c of catsAfterCreate) {
    if (desiredBreadcrumbKeys.has(normalizeForMatch(c.breadcrumb))) {
      desiredIds.add(c.id);
    }
  }

  // Move products into Avy categories
  const products = await listProducts(inventoryId);
  const limited = args.limitProducts && args.limitProducts > 0 ? products.slice(0, Math.floor(args.limitProducts)) : products;

  let wouldMove = 0;
  let moved = 0;
  for (const p of limited) {
    const currentBreadcrumb = idToBreadcrumb.get(p.categoryId) || '';
    const targetPath = mapBreadcrumbToAvyPath(currentBreadcrumb, allowed) || null;
    if (!targetPath) continue;
    // DRY_RUN: compare breadcrumbs (IDs won't exist yet).
    if (dryRun) {
      const same = normalizeForMatch(currentBreadcrumb) === normalizeForMatch(targetPath);
      if (!same) wouldMove += 1;
      continue;
    }
    const targetId = await ensurePath(targetPath);
    if (!targetId) continue;
    if (p.categoryId === targetId) continue;
    wouldMove += 1;
    try {
      const resp = await callBaseLinker('addInventoryProduct', {
        inventory_id: Number(inventoryId),
        product_id: p.productId,
        category_id: targetId,
      });
      if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'addInventoryProduct failed');
      moved += 1;
    } catch (e) {
      console.warn(`[avy-taxonomy] failed to move product ${p.productId} -> ${targetId}:`, e?.message || e);
    }
  }

  // Delete non-Avy categories (best-effort)
  let wouldDelete = 0;
  let deleted = 0;
  if (!args.skipDelete) {
    const currentCats = (await fetchCategories(inventoryId)).rows;
    const candidates = currentCats.filter((c) => {
      if (dryRun) {
        // DRY_RUN: keep categories if their breadcrumb is part of Avy taxonomy (by key).
        return !desiredBreadcrumbKeys.has(normalizeForMatch(c.breadcrumb));
      }
      return !desiredIds.has(c.id);
    });
    candidates.sort((a, b) => depthOfBreadcrumb(b.breadcrumb) - depthOfBreadcrumb(a.breadcrumb));
    wouldDelete = candidates.length;
    if (!dryRun) {
      // multiple passes for parent dependency
      let remaining = candidates;
      for (let pass = 1; pass <= 6; pass += 1) {
        if (!remaining.length) break;
        let progress = 0;
        const next = [];
        for (const c of remaining) {
          try {
            const resp = await callBaseLinker('deleteInventoryCategory', { category_id: c.id }, { retries: 0 });
            if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'delete failed');
            deleted += 1;
            progress += 1;
          } catch (e) {
            const msg = String(e?.message || e || '');
            // Treat "does not exist" as success
            if (/ERROR_CATEGORY_ID/i.test(msg) || /does not exist/i.test(msg)) {
              deleted += 1;
              progress += 1;
              continue;
            }
            next.push(c);
          }
        }
        console.log(`[avy-taxonomy] delete pass ${pass} progress=${progress} remaining=${next.length}`);
        if (progress === 0) break;
        remaining = next;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        done: true,
        inventoryId,
        dryRun,
        stats: {
          existing_categories_before: existingCats.length,
          avy_categories: avyCategories.length,
          products_total: products.length,
          products_considered: limited.length,
          wouldMoveProducts: wouldMove,
          movedProducts: moved,
          wouldDeleteCategories: wouldDelete,
          deletedCategories: deleted,
        },
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

