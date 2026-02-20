/* eslint-disable no-console */
/**
 * Assign BaseLinker inventory category_id for products based on Firestore product data,
 * using the compact Avy taxonomy (backend/avy-taxonomy/avy-taxonomy.json).
 *
 * Why:
 * - BaseLinker products in this inventory currently have category_id=0 (uncategorized).
 * - You want a small, structured taxonomy that still covers marketplaces for later mapping.
 *
 * Dry-run by default. Use --apply to execute.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/baselinker-assign-avy-categories-from-firestore.js --inventory 78659 --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/baselinker-assign-avy-categories-from-firestore.js --inventory 78659 --apply --limit 50
 */
const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');
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

function mapTextToAvyPath(text, allowed) {
  const segsRaw = splitBreadcrumb(text).map(cleanSegment).filter(Boolean);
  const root = segsRaw[0] ? (mapRoot(segsRaw[0]) || mapRoot(segsRaw.join(' '))) : mapRoot(text);
  if (!root) return null;
  const rest = segsRaw.length ? segsRaw.slice(1) : [text];
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

function chunkArray(arr, size) {
  const s = Math.max(1, Math.min(150, Number(size) || 100));
  const out = [];
  for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s));
  return out;
}

function parseArgs(argv) {
  const args = {
    inventoryId: String(process.env.BASELINKER_INVENTORY_ID || '78659'),
    taxonomy: path.join(process.cwd(), 'backend', 'avy-taxonomy', 'avy-taxonomy.json'),
    apply: false,
    dryRun: true,
    limit: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--inventory' || t === '--inventory-id') args.inventoryId = String(argv[i + 1] || ''), i += 1;
    else if (t === '--taxonomy') args.taxonomy = String(argv[i + 1] || ''), i += 1;
    else if (t === '--apply') args.apply = true, args.dryRun = false;
    else if (t === '--dry-run') args.dryRun = true, args.apply = false;
    else if (t === '--limit') args.limit = Number(argv[i + 1]), i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const inventoryId = String(args.inventoryId || '').trim();
  if (!inventoryId) throw new Error('Missing --inventory');
  const dryRun = args.dryRun;
  const { file: taxonomyFile, categories: avyCategories } = loadTaxonomy(args.taxonomy);
  const allowed = buildAllowedSets(avyCategories);

  console.log(JSON.stringify({ action: 'baselinker-assign-avy-from-firestore', inventoryId, dryRun, taxonomyFile, avyCategories: avyCategories.length }, null, 2));

  const { rows: cats } = await fetchCategories(inventoryId);
  const byParentName = new Map(); // `${parentId}:${nameKey}` -> id
  cats.forEach((c) => {
    const k = `${c.parentId || 0}:${normalizeForMatch(c.name)}`;
    if (!byParentName.has(k)) byParentName.set(k, c.id);
  });
  const pathToId = new Map(cats.map((c) => [normalizeForMatch(c.breadcrumb), c.id]));

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
        // In dry-run we don't create; return 0 if missing.
        return 0;
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

  // Ensure Avy categories exist (apply only)
  if (!dryRun) {
    let ensured = 0;
    for (const p of avyCategories) {
      await ensurePath(p);
      ensured += 1;
      if (ensured % 50 === 0) console.log(`[avy-taxonomy] ensured ${ensured}/${avyCategories.length}`);
    }
  }

  const products = await getAllProducts();
  const list = Array.isArray(products) ? products : [];
  const selected = args.limit && args.limit > 0 ? list.slice(0, Math.floor(args.limit)) : list;

  let missingLink = 0;
  let missingCategory = 0;
  let wouldUpdate = 0;
  let updated = 0;

  for (const p of selected) {
    const pidRaw = p?.ops?.baselinker?.product_id ?? p?.ops?.base_product_id ?? null;
    const blProductId = safeInt(pidRaw, 0);
    if (!blProductId) {
      missingLink += 1;
      continue;
    }
    const seed =
      safeString(p?.identification?.category) ||
      safeString(p?.details?.attributes?.Kategorie) ||
      safeString(p?.identification?.name);
    const avyPath = mapTextToAvyPath(seed, allowed);
    if (!avyPath) {
      missingCategory += 1;
      continue;
    }
    const catId = await ensurePath(avyPath);
    if (!catId) {
      // In dry-run, we won't create missing paths, so count but skip.
      wouldUpdate += 1;
      continue;
    }
    wouldUpdate += 1;
    if (dryRun) continue;
    try {
      const resp = await callBaseLinker('addInventoryProduct', {
        inventory_id: Number(inventoryId),
        product_id: blProductId,
        category_id: catId,
      });
      if (resp?.status !== 'SUCCESS') throw new Error(resp?.error_message || 'addInventoryProduct failed');
      updated += 1;
    } catch (e) {
      console.warn(`[assign] failed product_id=${blProductId} avy="${avyPath}":`, e?.message || e);
    }
  }

  console.log(
    JSON.stringify(
      {
        done: true,
        inventoryId,
        dryRun,
        stats: {
          products_total: list.length,
          products_selected: selected.length,
          missing_baselinker_link: missingLink,
          missing_category_seed: missingCategory,
          would_update: wouldUpdate,
          updated,
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

