#!/usr/bin/env node
/**
 * Read-only Diagnose-Skript fuer Oversell-Incidents.
 *
 * Liefert einen strukturierten JSON-Report zu einer einzelnen SKU (oder productId):
 *   - Product-Doc (inventory.quantity, ops.ebay/kaufland ids, storageBins)
 *   - stock_sync_log (letzte 20 Eintraege fuer diesen Product)
 *   - stock_operation_failures (alle pending/abandoned mit SKU-Bezug)
 *   - orders (letzte 10 mit diesem SKU, omsStatus, stockDecrementedAt)
 *   - Live-eBay-State via getItemDetails(itemId)
 *   - Live-Kaufland-State via getUnit(unitId)
 *
 * Aufruf:
 *   node backend/scripts/diagnose-stock-sku.js --sku SKU-9871561937 --tenantId trendocean
 *   node backend/scripts/diagnose-stock-sku.js --productId abc123 --tenantId trendocean
 *
 * Exit 0 = Report erfolgreich erstellt. Exit 1 = Argument- oder Laufzeitfehler.
 */

'use strict';

const { firestore, getProduct, findProductByStrictIdentifier } = require('../lib/firestore');

function parseArgs(argv) {
  const out = { sku: null, productId: null, tenantId: 'trendocean' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--sku' && v) { out.sku = v; i++; }
    else if (a === '--productId' && v) { out.productId = v; i++; }
    else if (a === '--tenantId' && v) { out.tenantId = v; i++; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

function usage() {
  console.error('Usage: node backend/scripts/diagnose-stock-sku.js --sku <SKU> [--tenantId <tenant>]');
  console.error('   or: node backend/scripts/diagnose-stock-sku.js --productId <id> [--tenantId <tenant>]');
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

async function loadStockSyncLog(productId, limit = 20) {
  try {
    const snap = await firestore.collection('stock_sync_log')
      .where('productId', '==', productId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    return { error: err.message };
  }
}

async function loadStockFailures({ tenantId, productId, sku }) {
  try {
    const snap = await firestore.collection('stock_operation_failures')
      .where('tenantId', '==', tenantId)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    const related = [];
    snap.forEach((doc) => {
      const data = doc.data();
      const hits = (data.failures || []).some((f) => (sku && f.sku === sku) || (productId && f.productId === productId));
      if (hits) related.push({ id: doc.id, ...data });
    });
    return related;
  } catch (err) {
    return { error: err.message };
  }
}

async function loadRecentOrders({ tenantId, sku }) {
  try {
    const snap = await firestore.collection('orders')
      .where('tenantId', '==', tenantId)
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();
    const related = [];
    snap.forEach((doc) => {
      const data = doc.data();
      const items = Array.isArray(data.items) ? data.items : [];
      const hit = items.some((it) => it && it.sku === sku);
      if (hit) {
        related.push({
          id: doc.id,
          source: data.source,
          omsStatus: data.omsStatus,
          stockDecrementedAt: data.stockDecrementedAt || null,
          stockDecrementedSkus: data.stockDecrementedSkus || null,
          createdAt: data.createdAt,
          items: items.filter((it) => it && it.sku === sku).map((it) => ({ sku: it.sku, quantity: it.quantity })),
        });
      }
      if (related.length >= 10) return;
    });
    return related;
  } catch (err) {
    return { error: err.message };
  }
}

async function loadEbayState(itemId) {
  if (!itemId) return { skipped: 'no ops.ebay.itemId' };
  try {
    const { getItemDetails } = require('../lib/ebay-trading-api');
    const detail = await getItemDetails(String(itemId));
    return {
      itemId: String(itemId),
      quantity: detail?.Item?.Quantity ?? detail?.Quantity ?? null,
      quantitySold: detail?.Item?.SellingStatus?.QuantitySold ?? null,
      listingStatus: detail?.Item?.SellingStatus?.ListingStatus ?? null,
      title: detail?.Item?.Title ?? null,
    };
  } catch (err) {
    return { itemId: String(itemId), error: err.message };
  }
}

async function loadKauflandState(unitId) {
  if (!unitId) return { skipped: 'no ops.kaufland.unitId' };
  try {
    const { getUnit } = require('../lib/kaufland-api');
    const unit = await getUnit(String(unitId));
    return {
      unitId: String(unitId),
      amount: unit?.amount ?? null,
      status: unit?.status ?? null,
      price: unit?.price ?? null,
      raw_listed_on: unit?.listed_on ?? null,
    };
  } catch (err) {
    return { unitId: String(unitId), error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.sku && !args.productId)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    args: { sku: args.sku, productId: args.productId, tenantId: args.tenantId },
  };

  const product = await loadProduct(args);
  if (!product) {
    report.error = 'product not found';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  if (product.tenantId && product.tenantId !== args.tenantId) {
    report.warning = `product tenantId mismatch: product=${product.tenantId}, requested=${args.tenantId}`;
  }

  const productId = product.id;
  const resolvedSku = args.sku || product?.identification?.sku || product?.details?.identifiers?.sku;

  report.product = {
    id: productId,
    tenantId: product.tenantId || null,
    sku: resolvedSku || null,
    title: product?.details?.name || product?.identification?.title || null,
    inventoryQuantity: product?.inventory?.quantity ?? null,
    storageBins: Array.isArray(product?.storageBins)
      ? product.storageBins.map((b) => ({ bin: b.bin || b.binCode, quantity: b.quantity }))
      : [],
    ops: {
      ebay: {
        itemId: product?.ops?.ebay?.itemId || product?.ops?.ebay?.item_id || null,
        syncedQuantity: product?.ops?.ebay?.syncedQuantity ?? null,
        syncedAt: product?.ops?.ebay?.syncedAt ?? null,
        itemIdCleared: product?.ops?.ebay?.itemIdCleared || null,
      },
      kaufland: {
        unitId: product?.ops?.kaufland?.unitId || product?.ops?.kaufland?.id_unit || null,
        syncedQuantity: product?.ops?.kaufland?.syncedQuantity ?? null,
        syncedAt: product?.ops?.kaufland?.syncedAt ?? null,
      },
    },
  };

  const [syncLog, failures, orders, ebayState, kauflandState] = await Promise.all([
    loadStockSyncLog(productId),
    loadStockFailures({ tenantId: args.tenantId, productId, sku: resolvedSku }),
    resolvedSku ? loadRecentOrders({ tenantId: args.tenantId, sku: resolvedSku }) : Promise.resolve([]),
    loadEbayState(report.product.ops.ebay.itemId),
    loadKauflandState(report.product.ops.kaufland.unitId),
  ]);

  report.stockSyncLog = syncLog;
  report.stockOperationFailures = failures;
  report.recentOrders = orders;
  report.liveState = { ebay: ebayState, kaufland: kauflandState };

  const localQty = report.product.inventoryQuantity;
  const ebayQty = typeof ebayState?.quantity === 'number' ? ebayState.quantity - (ebayState.quantitySold || 0) : null;
  const kauflandQty = typeof kauflandState?.amount === 'number' ? kauflandState.amount : null;
  report.driftAssessment = {
    localQty,
    ebayAvailable: ebayQty,
    kauflandAmount: kauflandQty,
    ebayDrift: ebayQty !== null && localQty !== null && ebayQty !== localQty,
    kauflandDrift: kauflandQty !== null && localQty !== null && kauflandQty !== localQty,
    oversellRisk: localQty === 0 && ((ebayQty !== null && ebayQty > 0) || (kauflandQty !== null && kauflandQty > 0)),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: err.message, stack: err.stack }, null, 2));
  process.exit(1);
});
