#!/usr/bin/env node
/**
 * Read-only Deep-Dive eines einzelnen Produkt-SKUs.
 *
 * Liefert einen JSON-Report mit:
 *   - Product-Doc (inventory.quantity, ops.ebay/kaufland, storageBins, intake history)
 *   - warehouseBins-Treffer (echte Bin-Zuordnungen aus der Bins-Collection)
 *   - inventory_ledger (alle Stock-Mutationen, append-only)
 *   - stock_sync_log (Marketplace-Sync-Versuche)
 *   - stock_reservations (offene Reservierungen)
 *   - stock_operation_failures (mit SKU-/productId-Treffern)
 *   - warehouseEvents (Bin-bezogene Events fuer das Produkt)
 *   - orders (alle Orders die diesen SKU enthalten, inkl. Items, Shipping, OmsStatus)
 *   - shipments (zu jeder Order)
 *   - returns (zu jeder Order oder mit dem SKU)
 *   - Live-Marketplace-State (ebayListingsLive, ebayListingLinks, kauflandUnitsLive)
 *
 * Aufruf:
 *   node backend/scripts/deepdive-sku.js --sku SKU-0000108900
 *   node backend/scripts/deepdive-sku.js --sku SKU-0000041030 --tenantId default
 *
 * Read-only: schreibt nichts.
 */

'use strict';

const { firestore, getProduct, findProductByStrictIdentifier } = require('../lib/firestore');

function parseArgs(argv) {
  const out = { sku: null, productId: null, tenantId: 'default', orderLimit: 200 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--sku' && v) { out.sku = v; i++; }
    else if (a === '--productId' && v) { out.productId = v; i++; }
    else if (a === '--tenantId' && v) { out.tenantId = v; i++; }
    else if (a === '--orderLimit' && v) { out.orderLimit = parseInt(v, 10) || 200; i++; }
  }
  return out;
}

async function loadProduct({ sku, productId }) {
  if (productId) {
    const p = await getProduct(productId);
    return p || null;
  }
  if (sku) {
    const p = await findProductByStrictIdentifier({ sku });
    return p || null;
  }
  return null;
}

function safe(fn) {
  return fn().catch((err) => ({ error: err.message }));
}

async function loadBinAssignments({ productId, sku }) {
  // Scan warehouseBins and find products[] entries matching productId or sku.
  const snap = await firestore.collection('warehouseBins').get();
  const matches = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const products = Array.isArray(data.products) ? data.products : [];
    const hits = products.filter((p) => {
      if (!p) return false;
      const pid = p.productId || p.id || p.refId || null;
      const psku = (p.sku || '').toString();
      const eq = (a, b) => (a && b && String(a).toLowerCase() === String(b).toLowerCase());
      return eq(pid, productId) || eq(psku, sku);
    });
    if (hits.length) {
      matches.push({
        binCode: doc.id,
        zone: data.zone || null,
        etage: data.etage || null,
        gang: data.gang || null,
        regal: data.regal || null,
        ebene: data.ebene || null,
        productCount: data.productCount ?? null,
        firstStoredAt: data.firstStoredAt || null,
        lastUpdatedAt: data.lastUpdatedAt || null,
        entries: hits.map((h) => ({
          sku: h.sku || null,
          productId: h.productId || h.id || h.refId || null,
          ean: h.ean || null,
          quantity: h.quantity ?? null,
          firstStoredAt: h.firstStoredAt || null,
          lastUpdatedAt: h.lastUpdatedAt || null,
          source: h.source || null,
        })),
      });
    }
  });
  return matches;
}

async function loadInventoryLedger({ productId }) {
  // Append-only ledger; filter only by productId to avoid composite index requirement.
  const snap = await firestore.collection('inventory_ledger')
    .where('productId', '==', productId)
    .limit(500)
    .get();
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  rows.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return rows;
}

async function loadStockSyncLog({ productId }) {
  const snap = await firestore.collection('stock_sync_log')
    .where('productId', '==', productId)
    .limit(200)
    .get();
  const rows = [];
  snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
  rows.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return rows;
}

async function loadStockReservations({ productId, sku }) {
  // No composite index — scan limited result.
  const candidates = [];
  try {
    const snap1 = await firestore.collection('stock_reservations')
      .where('productId', '==', productId)
      .limit(100)
      .get();
    snap1.forEach((d) => candidates.push({ id: d.id, ...d.data() }));
  } catch (err) {
    candidates.push({ error: err.message });
  }
  if (sku) {
    try {
      const snap2 = await firestore.collection('stock_reservations')
        .where('sku', '==', sku)
        .limit(100)
        .get();
      snap2.forEach((d) => {
        if (!candidates.some((c) => c.id === d.id)) {
          candidates.push({ id: d.id, ...d.data() });
        }
      });
    } catch (err) {
      candidates.push({ error: err.message });
    }
  }
  return candidates;
}

async function loadStockFailures({ tenantId, productId, sku }) {
  // No orderBy — scan latest by where().
  const snap = await firestore.collection('stock_operation_failures')
    .where('tenantId', '==', tenantId)
    .limit(500)
    .get();
  const related = [];
  snap.forEach((doc) => {
    const data = doc.data();
    const failures = Array.isArray(data.failures) ? data.failures : [];
    const hit = failures.some((f) => (sku && f.sku === sku) || (productId && f.productId === productId));
    if (hit) related.push({ id: doc.id, ...data });
  });
  return related;
}

async function loadWarehouseEvents({ productId, sku }) {
  // Scan a recent slice; warehouseEvents has no canonical productId field on every entry, so we do a broad scan.
  const snap = await firestore.collection('warehouseEvents')
    .orderBy('createdAt', 'desc')
    .limit(2000)
    .get();
  const related = [];
  snap.forEach((d) => {
    const data = d.data();
    const matches = (() => {
      if (data.productId === productId) return true;
      if (data.sku && data.sku === sku) return true;
      const products = Array.isArray(data.products) ? data.products : [];
      if (products.some((p) => (p?.productId === productId) || (p?.sku === sku))) return true;
      return false;
    })();
    if (matches) related.push({ id: d.id, ...data });
  });
  return related.slice(0, 50);
}

async function loadOrdersWithSku({ tenantId, sku, limit }) {
  // No composite index — fetch by tenantId only, filter in memory.
  const snap = await firestore.collection('orders')
    .where('tenantId', '==', tenantId)
    .limit(limit)
    .get();
  const matches = [];
  snap.forEach((d) => {
    const data = d.data();
    const items = Array.isArray(data.items) ? data.items : [];
    const hit = items.some((it) => it && it.sku === sku);
    if (!hit) return;
    matches.push({
      id: d.id,
      source: data.source || null,
      marketplace: data.marketplace || null,
      marketplaceOrderId: data.marketplaceOrderId || null,
      orderId: data.orderId || null,
      number: data.number || null,
      omsStatus: data.omsStatus || null,
      stockDecrementedAt: data.stockDecrementedAt || null,
      stockDecrementedSkus: data.stockDecrementedSkus || null,
      shippedAt: data.shippedAt || null,
      paidAt: data.paidAt || null,
      cancelledAt: data.cancelledAt || null,
      buyerEmail: data.buyerEmail || null,
      buyerCountry: data.shippingAddress?.country || null,
      tracking: data.tracking || null,
      total: data.total ?? data.totalAmount ?? null,
      currency: data.currency || null,
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
      items: items.filter((it) => it && it.sku === sku).map((it) => ({
        sku: it.sku,
        quantity: it.quantity,
        title: it.title || it.name || null,
        unitPrice: it.unitPrice ?? it.price ?? null,
      })),
    });
  });
  matches.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return matches;
}

async function loadShipments({ tenantId, orderIds }) {
  if (!orderIds.length) return [];
  const out = [];
  for (const oid of orderIds) {
    try {
      const snap = await firestore.collection('shipments')
        .where('tenantId', '==', tenantId)
        .where('orderId', '==', oid)
        .limit(20)
        .get();
      snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    } catch (err) {
      out.push({ orderId: oid, error: err.message });
    }
  }
  return out;
}

async function loadReturns({ tenantId, orderIds, sku }) {
  const out = [];
  for (const oid of orderIds) {
    try {
      const snap = await firestore.collection('returns')
        .where('tenantId', '==', tenantId)
        .where('orderId', '==', oid)
        .limit(20)
        .get();
      snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
    } catch (err) {
      out.push({ orderId: oid, error: err.message });
    }
  }
  // Returns by SKU but without order filter (in case)
  try {
    const snap = await firestore.collection('returns')
      .where('tenantId', '==', tenantId)
      .limit(500)
      .get();
    snap.forEach((d) => {
      const data = d.data();
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.some((it) => it && it.sku === sku) && !out.some((o) => o.id === d.id)) {
        out.push({ id: d.id, ...data });
      }
    });
  } catch (err) {
    out.push({ error: err.message });
  }
  return out;
}

async function loadEbayLinks({ sku }) {
  const out = { listings: [], links: [], gaps: [] };
  try {
    const snap = await firestore.collection('ebayListingLinks').where('sku', '==', sku).limit(20).get();
    snap.forEach((d) => out.links.push({ id: d.id, ...d.data() }));
  } catch (err) { out.linksError = err.message; }
  try {
    const snap = await firestore.collection('ebayListingsLive').where('sku', '==', sku).limit(20).get();
    snap.forEach((d) => out.listings.push({ id: d.id, ...d.data() }));
  } catch (err) { out.listingsError = err.message; }
  try {
    const snap = await firestore.collection('ebayListingGaps').where('sku', '==', sku).limit(20).get();
    snap.forEach((d) => out.gaps.push({ id: d.id, ...d.data() }));
  } catch (err) { out.gapsError = err.message; }
  return out;
}

async function loadKauflandUnits({ sku }) {
  const out = [];
  try {
    const snap = await firestore.collection('kauflandUnitsLive').where('sku', '==', sku).limit(20).get();
    snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  } catch (err) {
    out.push({ error: err.message });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sku && !args.productId) {
    console.error('Usage: node backend/scripts/deepdive-sku.js --sku <SKU> [--tenantId <tenant>]');
    process.exit(1);
  }

  const product = await loadProduct(args);
  if (!product) {
    console.log(JSON.stringify({ error: 'product not found', args }, null, 2));
    process.exit(1);
  }

  const productId = product.id;
  const sku = args.sku || product?.identification?.sku || product?.details?.identifiers?.sku || null;

  const summary = {
    id: productId,
    sku,
    title: product?.details?.name || product?.identification?.title || null,
    brand: product?.details?.brand || product?.identification?.brand || null,
    inventoryQuantity: product?.inventory?.quantity ?? null,
    inventoryReservedQuantity: product?.inventory?.reservedQuantity ?? null,
    inventoryAvailable:
      typeof product?.inventory?.quantity === 'number' && typeof product?.inventory?.reservedQuantity === 'number'
        ? product.inventory.quantity - product.inventory.reservedQuantity
        : null,
    storageBinsOnProduct: Array.isArray(product?.storageBins)
      ? product.storageBins.map((b) => ({
          bin: b.bin || b.binCode,
          quantity: b.quantity,
          firstStoredAt: b.firstStoredAt || null,
          lastUpdatedAt: b.lastUpdatedAt || null,
        }))
      : [],
    storageSummary: product?.storage || null,
    pendingIntake: product?.inventory?.pendingIntake ?? null,
    initialStockHints: {
      ops_first_seen_at: product?.ops?.first_seen_at || null,
      ops_first_saved_at: product?.ops?.first_saved_at || product?.ops?.created_at || null,
      ops_last_saved_iso: product?.ops?.last_saved_iso || null,
      created: product?.created || null,
      updated: product?.updated || null,
    },
    ops: {
      ebay: {
        itemId: product?.ops?.ebay?.itemId || product?.ops?.ebay?.item_id || null,
        syncedQuantity: product?.ops?.ebay?.syncedQuantity ?? null,
        syncedAt: product?.ops?.ebay?.syncedAt ?? null,
        itemIdCleared: product?.ops?.ebay?.itemIdCleared || null,
        previousItemId: product?.ops?.ebay?.previousItemId || null,
        listingStatus: product?.ops?.ebay?.listingStatus || null,
      },
      kaufland: {
        unitId: product?.ops?.kaufland?.unitId || product?.ops?.kaufland?.id_unit || null,
        syncedQuantity: product?.ops?.kaufland?.syncedQuantity ?? null,
        syncedAt: product?.ops?.kaufland?.syncedAt ?? null,
      },
    },
  };

  const [
    binAssignments,
    inventoryLedger,
    stockSyncLog,
    stockReservations,
    stockFailures,
    warehouseEvents,
    orders,
  ] = await Promise.all([
    safe(() => loadBinAssignments({ productId, sku })),
    safe(() => loadInventoryLedger({ productId })),
    safe(() => loadStockSyncLog({ productId })),
    safe(() => loadStockReservations({ productId, sku })),
    safe(() => loadStockFailures({ tenantId: args.tenantId, productId, sku })),
    safe(() => loadWarehouseEvents({ productId, sku })),
    safe(() => loadOrdersWithSku({ tenantId: args.tenantId, sku, limit: args.orderLimit })),
  ]);

  const orderIds = Array.isArray(orders) ? orders.map((o) => o.marketplaceOrderId || o.orderId || o.id).filter(Boolean) : [];

  const [shipments, returns, ebayLinks, kauflandUnits] = await Promise.all([
    safe(() => loadShipments({ tenantId: args.tenantId, orderIds })),
    safe(() => loadReturns({ tenantId: args.tenantId, orderIds, sku })),
    safe(() => loadEbayLinks({ sku })),
    safe(() => loadKauflandUnits({ sku })),
  ]);

  // Initial qty heuristic from inventory_ledger
  let initialQtyFromLedger = null;
  if (Array.isArray(inventoryLedger) && inventoryLedger.length) {
    const stockIn = inventoryLedger.find((row) => /stock-?in|intake|initial|first/.test(String(row.reason || '')));
    if (stockIn) {
      initialQtyFromLedger = { reason: stockIn.reason, before: stockIn.before, after: stockIn.after, delta: stockIn.delta, createdAt: stockIn.createdAt };
    } else {
      const first = inventoryLedger[0];
      initialQtyFromLedger = { reason: first.reason || 'first-event', before: first.before, after: first.after, delta: first.delta, createdAt: first.createdAt };
    }
  }
  // Fallback to stockSyncLog
  let initialQtyFromSyncLog = null;
  if (Array.isArray(stockSyncLog) && stockSyncLog.length) {
    const stockIn = stockSyncLog.find((row) => String(row.reason || '').toLowerCase().includes('stock-in'));
    if (stockIn) {
      initialQtyFromSyncLog = { reason: stockIn.reason, quantity: stockIn.quantity, availableQuantity: stockIn.availableQuantity, createdAt: stockIn.createdAt };
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    args,
    summary,
    initialQty: {
      fromInventoryLedger: initialQtyFromLedger,
      fromStockSyncLog: initialQtyFromSyncLog,
    },
    binAssignmentsLive: binAssignments,
    inventoryLedger,
    stockSyncLog,
    stockReservations,
    stockOperationFailures: stockFailures,
    warehouseEvents,
    orders,
    shipments,
    returns,
    marketplace: {
      ebay: ebayLinks,
      kaufland: kauflandUnits,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
