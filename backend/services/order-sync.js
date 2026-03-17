const { saveOrders, getOrderById, updateOrder, listOrders, listOrdersByStatus, firestore } = require('../lib/firestore');

// Increase lookback to ensure older shipped/picked orders are included for stock cleanup
const DEFAULT_ORDER_LOOKBACK_DAYS = parseInt(process.env.ORDER_SYNC_LOOKBACK_DAYS || '60', 10);

const DEFAULT_PACKED_LABEL = 'Verpackt';

async function syncNewOrders() {
  // Retrieve existing orders from Firestore for status classification and repair
  const existingOrders = await listOrders(500) || [];

  // Post-process statuses using label text to classify picked/closed
  existingOrders.forEach((order) => {
    const rawLabel = order.statusLabel || order.orderStatus || '';
    const normalized = (rawLabel || '').toLowerCase();
    const looksCancelled =
      normalized.includes('storniert') ||
      normalized.includes('cancelled') ||
      normalized.includes('canceled') ||
      normalized.includes('abgebrochen');

    if (normalized.includes('verpackt') || normalized.includes('packed')) {
      order.status = 'packed';
      return;
    }

    const looksNew =
      normalized.includes('neu') ||
      normalized.includes('new') ||
      normalized === '';

    if (looksNew) {
      order.status = 'new';
    } else if (looksCancelled) {
      order.status = 'picked';
    } else if (
      normalized.includes('kommissioniert') ||
      normalized.includes('versandt') ||
      normalized.includes('versendet') ||
      normalized.includes('zugestellt') ||
      normalized.includes('delivered') ||
      normalized.includes('storniert') ||
      normalized.includes('cancelled') ||
      normalized.includes('canceled')
    ) {
      order.status = 'picked';
    } else {
      // Unknown / not verifiable => not open (prevents phantom open orders).
      order.status = 'other';
    }
  });

  await saveOrders(existingOrders);

  // Best-effort stock reservation for new orders — prevents overselling
  try {
    const newOrders = existingOrders.filter((o) => o.status === 'new');
    if (newOrders.length > 0) {
      const { reserveStock } = require('./stock-reservation');
      const { syncStockForOrderItems } = require('./stock-sync-dispatcher');
      for (const order of newOrders) {
        const items = (order.items || [])
          .filter((item) => item.sku && item.quantity > 0)
          .map((item) => ({ sku: item.sku, productId: item.productId || null, quantity: item.quantity }));
        if (items.length > 0) {
          const result = await reserveStock({
            tenantId: 'default',
            orderId: order.id,
            items,
          });
          if (result.reserved) {
            console.log(`[order-sync] reserved stock for order ${order.id}: ${result.count} items`);
            // Push updated availability to marketplaces (prevents oversell)
            syncStockForOrderItems({
              tenantId: 'default',
              orderId: order.id,
              reason: 'order-intake',
            }).catch((err) => console.warn(`[order-sync] stock sync after reserve failed: ${err.message}`));
          }
        }
      }
    }
  } catch (reserveErr) {
    // Non-blocking: reservation failure should never prevent order sync
    console.warn('[order-sync] stock reservation failed (non-blocking):', reserveErr?.message || reserveErr);
  }

  // Repair pass for historical cache artifacts:
  // Older versions mistakenly stored the constant "order_source_id" (shop/source id) as order.number (e.g. 10129).
  // This breaks UI because multiple orders appear to have the same number.
  try {
    const recent = await listOrders(500);
    const fixes = (recent || [])
      .filter((o) => o && o.id && o.raw)
      .map((o) => ({
        id: String(o.id),
        number: o.number,
        status: o.status,
        statusLabel: o.statusLabel,
        statusId: o.statusId,
        rawSourceId: o.raw?.order_source_id,
        rawExternal: o.raw?.external_order_id,
        rawOrderId: o.raw?.order_id,
      }))
      .filter((o) => {
        const sourceId = o.rawSourceId != null ? String(o.rawSourceId) : '';
        const num = o.number != null ? String(o.number) : '';
        return sourceId && num && num === sourceId;
      })
      .slice(0, 200);

    for (const f of fixes) {
      const replacement = f.rawExternal ? String(f.rawExternal) : f.rawOrderId ? String(f.rawOrderId) : f.id;
      await updateOrder(f.id, { number: replacement });
    }
  } catch (error) {
    console.warn('Order number repair pass failed:', error?.message || error);
  }

  // Repair pass for "stuck open" cancelled orders:
  // If an order is still cached as status=new but the status label indicates cancellation, close it locally.
  try {
    const openCached = await listOrdersByStatus('new', 200);
    for (const o of openCached || []) {
      const label = (o?.statusLabel || '').toString().toLowerCase();
      const looksCancelled =
        label.includes('storniert') ||
        label.includes('cancelled') ||
        label.includes('canceled') ||
        label.includes('abgebrochen');
      if (!looksCancelled) continue;
      await updateOrder(String(o.id), { status: 'picked' });
    }
  } catch (error) {
    console.warn('Cancelled-open repair pass failed:', error?.message || error);
  }

  // IMPORTANT:
  // Do NOT decrement warehouse stock during order sync.
  //
  // Reason:
  // - Bin-accurate stock changes must be driven by explicit warehouse operations
  //   (/api/warehouse/stock-in|stock-out, etc.).
  // - Auto-decrement during sync is not idempotent and can cause repeated decrements
  //   whenever the same "closed" orders are re-synced, leading to disappearing BIN assignments.

  return existingOrders;
}

async function markOrderAsPicked(orderId) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }

  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  // Stock decrement is handled by the explicit warehouse pick endpoint (/api/warehouse/stock-out),
  // which is BIN-accurate. Do not decrement here to avoid double-decrements.

  await updateOrder(orderId, {
    status: 'picked',
    statusLabel: 'Kommissioniert',
    pickedAt: new Date().toISOString(),
  });

  return { id: orderId };
}

async function markOrderAsPacked(orderId) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }

  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  const currentLabel = (order.statusLabel || '').toString().toLowerCase();
  const currentStatus = order.status || '';
  const looksPicked =
    currentLabel.includes('kommissioniert') ||
    currentStatus === 'picked';
  if (!looksPicked) {
    throw new Error(`Order is not in status "Kommissioniert" (current: "${order.statusLabel || '—'}").`);
  }

  await updateOrder(orderId, {
    status: 'packed',
    statusLabel: DEFAULT_PACKED_LABEL,
    packedAt: new Date().toISOString(),
  });

  return { id: orderId };
}

module.exports = {
  syncNewOrders,
  markOrderAsPicked,
  markOrderAsPacked,
};

function isClosedStatus(statusLabel = '') {
  const raw = statusLabel.toLowerCase();
  return (
    raw.includes('kommissioniert') ||
    raw.includes('verpackt') ||
    raw.includes('versendet') ||
    raw.includes('zugestellt') ||
    raw.includes('delivered') ||
    raw.includes('storniert') ||
    raw.includes('cancelled') ||
    raw.includes('canceled') ||
    raw.includes('abgeschlossen') ||
    raw.includes('completed')
  );
}
