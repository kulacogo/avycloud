/* eslint-disable no-console */
/**
 * Stock reconciliation report: AvyCloud (Firestore) vs BaseLinker inventory stock.
 *
 * Columns (German, for auditing):
 * - sku, name, BIN (primary), BINs (all)
 * - initial_eingelagert_menge (derived from earliest warehouseEvents stock_in/bin_assign_product)
 * - kommissionierung_stock_out_menge (sum of warehouseEvents stock_out)
 * - offene_bestellungen_new_menge / kommissioniert_bestellungen_picked_menge / verpackt_bestellungen_packed_menge
 * - aktuelle_menge_avycloud_physisch (sum of storageBins)
 * - aktuelle_menge_baselinker (sum of BL stock keys)
 * - delta_baselinker_minus_avy_available (BL - (physisch - offene_new))
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/report-stock-avycloud-vs-baselinker-78659.js
 *
 * Options:
 *   --inventory-id 78659
 *   --out exports/stock-report-78659.csv
 *   --include-zero   (include products with qty=0 too)
 */
const fs = require('fs');
const path = require('path');
const { callBaseLinker } = require('../lib/baselinker');
const { firestore } = require('../lib/firestore');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function toIso(value) {
  if (!value) return '';
  try {
    if (typeof value === 'string') return value;
    if (typeof value?.toDate === 'function') return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
  } catch {
    // ignore
  }
  return '';
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');

const normalizeEanValue = (val) => (val || '').toString().replace(/\D+/g, '').trim();

function sumStorageBins(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
}

function pickSkuRaw(product, docId) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    safeString(docId) ||
    ''
  );
}

function pickName(product, docId) {
  return safeString(product?.identification?.name) || safeString(product?.details?.name) || safeString(docId) || '';
}

function pickPrimaryBin(product) {
  const explicit = safeString(product?.storage?.binCode);
  if (explicit) return explicit;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  if (!bins.length) return '';
  const sorted = [...bins].sort((a, b) => (Number(b?.quantity) || 0) - (Number(a?.quantity) || 0));
  return safeString(sorted[0]?.code || sorted[0]?.binCode) || '';
}

function formatBinList(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const parts = bins
    .map((b) => {
      const code = safeString(b?.code || b?.binCode);
      const qty = Number(b?.quantity) || 0;
      if (!code) return '';
      return `${code}:${qty}`;
    })
    .filter(Boolean);
  return parts.join(' ; ');
}

const AMBIG = Symbol('AMBIG');

function addAlias(map, aliasRaw, skuNorm) {
  const key = safeString(aliasRaw).toLowerCase();
  if (!key) return;
  const prev = map.get(key);
  if (!prev) {
    map.set(key, skuNorm);
    return;
  }
  if (prev === skuNorm) return;
  map.set(key, AMBIG);
}

function parseProductsMap(payload) {
  const raw = payload?.products;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

async function loadBaseLinkerStockIndex(inventoryId) {
  const invId = Number(inventoryId);
  const byId = new Map(); // pid -> { pid, skuNorm, skuRaw, stockTotal, stockRaw }
  const bySku = new Map(); // skuNorm -> pid OR AMBIG
  let page = 1;
  const MAX_PAGES = 2000;
  const PER_PAGE = 1000;

  while (page <= MAX_PAGES) {
    const res = await callBaseLinker('getInventoryProductsList', {
      inventory_id: invId,
      page,
    });
    const items = parseProductsMap(res);
    if (!items.length) break;

    for (const it of items) {
      const pid = Number(it?.id ?? it?.product_id ?? 0);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const skuRaw = safeString(it?.sku ?? it?.product_sku ?? '');
      const skuNorm = normalizeSkuValue(skuRaw);
      const stockRaw = it?.stock && typeof it.stock === 'object' ? it.stock : {};
      const stockTotal = Object.values(stockRaw).reduce((sum, v) => sum + (Number(v) || 0), 0);
      byId.set(pid, { pid, skuNorm, skuRaw, stockTotal, stockRaw });

      if (skuNorm) {
        const prev = bySku.get(skuNorm);
        if (!prev) bySku.set(skuNorm, pid);
        else if (prev !== pid) bySku.set(skuNorm, AMBIG);
      }
    }

    if (items.length < PER_PAGE) break;
    page += 1;
  }

  return { byId, bySku };
}

async function main() {
  const args = {
    inventoryId: '78659',
    out: '',
    includeZero: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--inventory-id') {
      args.inventoryId = String(argv[i + 1] || '').trim() || args.inventoryId;
      i += 1;
    } else if (t === '--out') {
      args.out = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (t === '--include-zero') {
      args.includeZero = true;
    }
  }

  const stamp = nowStamp();
  const outPath = args.out
    ? path.isAbsolute(args.out)
      ? args.out
      : path.join(process.cwd(), args.out)
    : path.join(process.cwd(), 'exports', `stock-report-avycloud-vs-baselinker-${args.inventoryId}-${stamp}.csv`);
  ensureDir(path.dirname(outPath));

  console.log(
    JSON.stringify(
      {
        action: 'report-stock-avycloud-vs-baselinker',
        inventoryId: args.inventoryId,
        outPath,
        includeZero: args.includeZero,
      },
      null,
      2
    )
  );

  // 1) Load products
  console.log('[report] loading products...');
  const productsSnap = await firestore.collection('products').get();
  const products = productsSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  console.log('[report] products loaded:', products.length);

  // Build alias -> skuNorm index to resolve events/orders that only have productId or digits.
  const aliasToSku = new Map(); // key -> skuNorm | AMBIG
  const skuToProduct = new Map(); // skuNorm -> product

  for (const p of products) {
    const skuRaw = pickSkuRaw(p, p.id);
    const skuNorm = normalizeSkuValue(skuRaw);
    if (!skuNorm) continue;

    // Keep first product per SKU for reporting; collisions are already a known issue.
    if (!skuToProduct.has(skuNorm)) {
      skuToProduct.set(skuNorm, p);
    }

    addAlias(aliasToSku, p.id, skuNorm);
    addAlias(aliasToSku, p?.id, skuNorm);
    addAlias(aliasToSku, p?.identification?.sku, skuNorm);
    addAlias(aliasToSku, p?.details?.identifiers?.sku, skuNorm);

    // stripped variants
    const stripped = skuRaw.replace(/^sku[-_\s]*/i, '');
    addAlias(aliasToSku, stripped, skuNorm);
    addAlias(aliasToSku, `sku-${stripped}`, skuNorm);

    // NOTE: barcodes/EAN can collide; we only index them when they are unique (AMBIG will exclude them).
    addAlias(aliasToSku, normalizeEanValue(p?.details?.identifiers?.ean), skuNorm);
    addAlias(aliasToSku, normalizeEanValue(p?.details?.identifiers?.gtin), skuNorm);
    const barcodes = Array.isArray(p?.identification?.barcodes) ? p.identification.barcodes : [];
    for (const b of barcodes.slice(0, 12)) addAlias(aliasToSku, normalizeEanValue(b), skuNorm);
  }

  // 2) Load warehouseEvents (for initial stock-in and stock-out totals)
  console.log('[report] loading warehouseEvents...');
  const eventsSnap = await firestore.collection('warehouseEvents').get();
  const events = eventsSnap.docs.map((doc) => doc.data() || {});
  console.log('[report] warehouseEvents loaded:', events.length);

  const bySkuMetrics = new Map(); // skuNorm -> metrics
  const ensureMetrics = (skuNorm) => {
    if (!bySkuMetrics.has(skuNorm)) {
      bySkuMetrics.set(skuNorm, {
        initialQty: null,
        initialIso: '',
        initialType: '',
        initialBin: '',
        stockInTotal: 0,
        stockOutTotal: 0,
      });
    }
    return bySkuMetrics.get(skuNorm);
  };

  const resolveSkuFromEvent = (e) => {
    const direct = normalizeSkuValue(safeString(e?.sku || ''));
    if (direct) return direct;
    const pid = safeString(e?.productId || e?.productKey || '');
    if (!pid) return '';
    const key = pid.toLowerCase();
    const mapped = aliasToSku.get(key);
    if (!mapped || mapped === AMBIG) return '';
    return mapped;
  };

  for (const e of events) {
    const type = safeString(e?.type);
    if (!type) continue;
    if (!['stock_in', 'stock_out', 'bin_assign_product'].includes(type)) continue;

    const skuNorm = resolveSkuFromEvent(e);
    if (!skuNorm) continue;

    const m = ensureMetrics(skuNorm);
    const iso = toIso(e?.createdAt);

    if (type === 'stock_in') {
      const delta = Number(e?.delta || 0) || 0;
      if (delta > 0) m.stockInTotal += delta;

      // earliest event becomes initial
      if (!m.initialIso || (iso && iso < m.initialIso)) {
        m.initialIso = iso;
        m.initialType = 'stock_in';
        m.initialBin = safeString(e?.binCode);
        m.initialQty = delta > 0 ? delta : null;
      }
    }

    if (type === 'bin_assign_product') {
      const qty = Number(e?.quantity || 0) || 0;
      if (!m.initialIso || (iso && iso < m.initialIso)) {
        m.initialIso = iso;
        m.initialType = 'bin_assign_product';
        m.initialBin = safeString(e?.binCode);
        m.initialQty = qty > 0 ? qty : null;
      }
    }

    if (type === 'stock_out') {
      const delta = Number(e?.delta || 0) || 0;
      if (delta < 0) m.stockOutTotal += Math.abs(delta);
    }
  }

  // 3) Load orders (for open/picked/packed quantities)
  console.log('[report] loading orders (new/picked/packed)...');
  let orders = [];
  try {
    const snap = await firestore
      .collection('orders')
      .where('status', 'in', ['new', 'picked', 'packed'])
      .get();
    orders = snap.docs.map((d) => d.data() || {});
  } catch (e) {
    console.warn('[report] orders query failed, falling back to scan:', e?.message || e);
    const snap = await firestore.collection('orders').get();
    orders = snap.docs.map((d) => d.data() || {}).filter((o) => ['new', 'picked', 'packed'].includes(safeString(o?.status)));
  }
  console.log('[report] orders loaded:', orders.length);

  const orderQty = {
    new: new Map(),
    picked: new Map(),
    packed: new Map(),
  };
  const addOrderQty = (status, skuNorm, qty) => {
    if (!orderQty[status]) return;
    if (!skuNorm || qty <= 0) return;
    orderQty[status].set(skuNorm, (orderQty[status].get(skuNorm) || 0) + qty);
  };

  const resolveSkuFromOrderItem = (item) => {
    const raw = safeString(item?.sku || item?.productId || '');
    if (!raw) return '';
    const direct = normalizeSkuValue(raw);
    if (direct && skuToProduct.has(direct)) return direct;
    const mapped = aliasToSku.get(raw.toLowerCase());
    if (!mapped || mapped === AMBIG) return '';
    return mapped;
  };

  for (const o of orders) {
    const status = safeString(o?.status);
    if (!['new', 'picked', 'packed'].includes(status)) continue;
    const items = Array.isArray(o?.items) ? o.items : [];
    for (const it of items) {
      const skuNorm = resolveSkuFromOrderItem(it);
      const qty = Number(it?.quantity || 0) || 0;
      addOrderQty(status, skuNorm, qty);
    }
  }

  // 4) Load BaseLinker stock index
  console.log('[report] loading BaseLinker inventory stock list...');
  const { byId: blById, bySku: blBySku } = await loadBaseLinkerStockIndex(args.inventoryId);
  console.log('[report] BaseLinker products indexed:', blById.size);

  // 5) Build report rows
  const headers = [
    'sku',
    'produkt_name',
    'BIN',
    'BINs',
    'initial_eingelagert_menge',
    'initial_eingelagert_iso',
    'initial_eingelagert_typ',
    'initial_eingelagert_BIN',
    'kommissionierung_stock_out_menge',
    'offene_bestellungen_new_menge',
    'kommissioniert_bestellungen_picked_menge',
    'verpackt_bestellungen_packed_menge',
    'offene_bestellungen_total_menge',
    'aktuelle_menge_avycloud_physisch',
    'aktuelle_menge_avycloud_inventory_field',
    'avycloud_delta_inventory_minus_bins',
    'avycloud_available_minus_new',
    'baselinker_product_id',
    'aktuelle_menge_baselinker',
    'delta_baselinker_minus_avy_available_new',
    'delta_baselinker_minus_avy_physisch',
    'last_synced_iso',
  ];

  const lines = [];
  lines.push(headers.join(','));

  const rows = [];

  for (const p of products) {
    const skuRaw = pickSkuRaw(p, p.id);
    const skuNorm = normalizeSkuValue(skuRaw);
    if (!skuNorm) continue;

    const name = pickName(p, p.id);
    const binPrimary = pickPrimaryBin(p);
    const binsList = formatBinList(p);

    const qtyBins = sumStorageBins(p);
    const qtyInvField = Number(p?.inventory?.quantity || 0) || 0;
    const qtyPhysical = qtyBins || qtyInvField; // prefer bins; fallback to inventory field

    const m = bySkuMetrics.get(skuNorm) || null;
    const initialQty = m?.initialQty ?? '';
    const initialIso = m?.initialIso || '';
    const initialType = m?.initialType || '';
    const initialBin = m?.initialBin || '';
    const stockOutTotal = m?.stockOutTotal || 0;

    const qNew = orderQty.new.get(skuNorm) || 0;
    const qPicked = orderQty.picked.get(skuNorm) || 0;
    const qPacked = orderQty.packed.get(skuNorm) || 0;
    const qOpenTotal = qNew + qPicked + qPacked;

    const availableMinusNew = Math.max(0, qtyPhysical - qNew);

    // BaseLinker linkage
    const linkedPid = Number(p?.ops?.baselinker?.inventories?.[String(args.inventoryId)]?.product_id || 0) || 0;
    let blPid = linkedPid;
    if (!blPid) {
      const mapped = blBySku.get(skuNorm);
      if (mapped && mapped !== AMBIG) blPid = Number(mapped) || 0;
    }
    const blEntry = blPid ? blById.get(blPid) : null;
    const blStock = blEntry ? Number(blEntry.stockTotal || 0) : 0;

    if (!args.includeZero) {
      const hasSignal = qtyPhysical > 0 || qOpenTotal > 0 || blStock > 0 || stockOutTotal > 0;
      if (!hasSignal) continue;
    }

    const deltaBlMinusAvailNew = blStock - availableMinusNew;
    const deltaBlMinusPhys = blStock - qtyPhysical;

    rows.push({
      sku: skuRaw,
      skuNorm,
      name,
      binPrimary,
      binsList,
      initialQty,
      initialIso,
      initialType,
      initialBin,
      stockOutTotal,
      qNew,
      qPicked,
      qPacked,
      qOpenTotal,
      qtyPhysical,
      qtyInvField,
      invMinusBins: qtyInvField - qtyBins,
      availableMinusNew,
      blPid: blPid || '',
      blStock,
      deltaBlMinusAvailNew,
      deltaBlMinusPhys,
      lastSyncedIso:
        safeString(p?.ops?.baselinker?.inventories?.[String(args.inventoryId)]?.last_synced_iso) ||
        safeString(p?.ops?.last_synced_iso) ||
        '',
    });
  }

  // Sort: biggest absolute delta first
  rows.sort((a, b) => Math.abs(b.deltaBlMinusAvailNew) - Math.abs(a.deltaBlMinusAvailNew));

  for (const r of rows) {
    const row = [
      r.sku,
      r.name,
      r.binPrimary,
      r.binsList,
      r.initialQty,
      r.initialIso,
      r.initialType,
      r.initialBin,
      r.stockOutTotal,
      r.qNew,
      r.qPicked,
      r.qPacked,
      r.qOpenTotal,
      r.qtyPhysical,
      r.qtyInvField,
      r.invMinusBins,
      r.availableMinusNew,
      r.blPid,
      r.blStock,
      r.deltaBlMinusAvailNew,
      r.deltaBlMinusPhys,
      r.lastSyncedIso,
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');

  const summary = {
    inventoryId: args.inventoryId,
    products_total: products.length,
    rows_written: rows.length,
    events_total: events.length,
    bl_indexed: blById.size,
    outPath,
  };
  console.log(JSON.stringify({ ok: true, summary }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});

