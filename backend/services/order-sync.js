const { callBaseLinker } = require('../lib/baselinker');
const { getSecrets } = require('../lib/secrets');
const { saveOrders, getOrderById, updateOrder, listOrders, listOrdersByStatus, firestore } = require('../lib/firestore');
const { decrementProductByIdOrSku } = require('../lib/warehouse');

// Increase lookback to ensure older shipped/picked orders are included for stock cleanup
const DEFAULT_ORDER_LOOKBACK_DAYS = parseInt(process.env.ORDER_SYNC_LOOKBACK_DAYS || '60', 10);
const BASELINKER_ORDER_PAGE_LIMIT = 100; // per docs: max 100 orders per call
const MAX_ORDER_PAGES = 1000; // safety guard
const ORDER_STATUS_ID_CACHE = {
  new: null,
  picked: null,
  packed: null,
  cancelled: null,
  shipped: null,
  delivered: null,
};

const DEFAULT_NEW_STATUS_ID = '363182'; // BaseLinker status "Neue Bestellung"
const DEFAULT_PICKED_STATUS_ID = '363183'; // BaseLinker status "Kommissioniert"
const DEFAULT_PACKED_STATUS_ID = '409364'; // BaseLinker status "Verpackt"
const DEFAULT_SHIPPED_STATUS_ID = '363184'; // BaseLinker status "Versendet"
const DEFAULT_PACKED_LABEL = 'Verpackt';
const DEFAULT_CANCELLED_LABEL = 'Storniert';
const DEFAULT_SHIPPED_LABEL = 'Versendet';
const DEFAULT_DELIVERED_LABEL = 'Zugestellt';
const ORDER_STATUS_NAME_CACHE = {
  byId: new Map(), // string id -> name
  loadedAtMs: 0,
};

async function ensureOrderStatusNameCache() {
  const now = Date.now();
  // refresh at most every 15 minutes
  if (ORDER_STATUS_NAME_CACHE.loadedAtMs && now - ORDER_STATUS_NAME_CACHE.loadedAtMs < 15 * 60 * 1000) {
    return ORDER_STATUS_NAME_CACHE.byId;
  }
  try {
    const response = await callBaseLinker('getOrderStatusList');
    const statuses = Array.isArray(response?.statuses) ? response.statuses : [];
    const next = new Map();
    statuses.forEach((s) => {
      if (s?.id == null) return;
      const id = String(s.id);
      const name = (s?.name || '').toString().trim();
      if (!id || !name) return;
      next.set(id, name);
    });
    ORDER_STATUS_NAME_CACHE.byId = next;
    ORDER_STATUS_NAME_CACHE.loadedAtMs = now;
    return ORDER_STATUS_NAME_CACHE.byId;
  } catch (error) {
    // keep existing map on failure
    return ORDER_STATUS_NAME_CACHE.byId;
  }
}

const normalizeStatusIdInput = (value) => {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return String(numeric);
  }
  return null;
};

function normalizeStatusName(value) {
  return (value || '').trim().toLowerCase();
}

async function resolveOrderStatusIdByName(cacheKey, envNameKey, fallbackLabel) {
  if (ORDER_STATUS_ID_CACHE[cacheKey]) {
    return ORDER_STATUS_ID_CACHE[cacheKey];
  }

  const envLabel = envNameKey ? process.env[envNameKey] : null;
  const targetLabel = (envLabel || fallbackLabel || '').trim();
  if (!targetLabel) {
    return null;
  }

  try {
    const response = await callBaseLinker('getOrderStatusList');
    const statuses = Array.isArray(response?.statuses) ? response.statuses : [];
    // Also warm status name cache for label rendering.
    try {
      statuses.forEach((s) => {
        if (s?.id == null) return;
        const id = String(s.id);
        const name = (s?.name || '').toString().trim();
        if (!id || !name) return;
        ORDER_STATUS_NAME_CACHE.byId.set(id, name);
      });
      ORDER_STATUS_NAME_CACHE.loadedAtMs = Date.now();
    } catch {
      // ignore
    }
    const normalizedTarget = normalizeStatusName(targetLabel);
    const match =
      statuses.find(
        (status) => normalizeStatusName(status?.name) === normalizedTarget
      ) ||
      statuses.find((status) =>
        normalizeStatusName(status?.name).includes(normalizedTarget)
      );

    if (match?.id != null) {
      ORDER_STATUS_ID_CACHE[cacheKey] = String(match.id);
      console.info(
        `Resolved BaseLinker status "${targetLabel}" to ID ${ORDER_STATUS_ID_CACHE[cacheKey]}`
      );
      return ORDER_STATUS_ID_CACHE[cacheKey];
    }
  } catch (error) {
    console.error(
      `Failed to resolve BaseLinker status "${targetLabel}" via getOrderStatusList:`,
      error.message
    );
  }

  return null;
}

function mapBaseLinkerOrder(entry) {
  const createdAt = entry?.date_add ? new Date(Number(entry.date_add) * 1000).toISOString() : new Date().toISOString();
  const statusIdRaw = entry?.order_status_id != null ? String(entry.order_status_id) : entry?.status_id != null ? String(entry.status_id) : null;
  const orderSource = entry?.order_source ? String(entry.order_source).trim() : '';
  const orderSourceId =
    entry?.order_source_id != null && String(entry.order_source_id).trim()
      ? String(entry.order_source_id).trim()
      : null;
  const sourceScopedOrderKey = `${String(entry.order_id)}::${orderSource || '-'}::${orderSourceId || '-'}`;
  const resolvedStatusLabel =
    entry?.status_name ||
    entry?.order_status_name ||
    (statusIdRaw ? ORDER_STATUS_NAME_CACHE.byId.get(String(statusIdRaw)) : null) ||
    '—';
  const items = Array.isArray(entry?.products)
    ? entry.products.map((product) => ({
      id:
        String(product?.order_product_id || '') ||
        `${entry.order_id}-${product?.product_id || product?.sku || product?.ean || Math.random().toString(36).slice(2)}`,
      productId: product?.product_id ? String(product.product_id) : null,
      name: product?.name || product?.product_name || 'Produkt',
      sku: product?.sku || product?.code || product?.ean || '',
      quantity: Number(product?.quantity || product?.quantity_confirmed || 1),
      ean: product?.ean || null,
      priceBrutto: Number(product?.price_brutto || product?.price || 0),
      currency: entry?.currency || 'EUR',
      weight: product?.weight ? Number(product.weight) : null, // kg
    }))
    : [];

  const totalAmount = items.reduce((sum, item) => sum + item.priceBrutto * item.quantity, 0);

  return {
    id: String(entry.order_id),
    baselinkerId: String(entry.order_id),
    baselinkerOrderKey: sourceScopedOrderKey,
    orderSource: orderSource || null,
    orderSourceId,
    marketplace: orderSource ? orderSource.toLowerCase() : null,
    marketplaceOrderId: entry?.external_order_id || null,
    source: 'baselinker',
    status: 'new',
    statusLabel: resolvedStatusLabel,
    statusId: statusIdRaw,
    createdAt,
    updatedAt: createdAt,
    // IMPORTANT:
    // - order_source_id is the SOURCE/SHOP id (often constant), NOT an order number.
    // - Prefer external_order_id / shop_order_id when available; otherwise fallback to BaseLinker order_id.
    // Display order number: always unique and stable.
    // Prefer external_order_id when present, otherwise fallback to BaseLinker order_id.
    number: entry?.external_order_id || entry?.external_invoice_number || String(entry.order_id),
    customer: {
      name: entry?.delivery_fullname || entry?.invoice_fullname || entry?.buyer || 'Unbekannt',
      street: [entry?.delivery_address, entry?.delivery_address2].filter(Boolean).join(', ')
        || [entry?.invoice_address, entry?.invoice_address2].filter(Boolean).join(', ')
        || null,
      city: entry?.delivery_city || entry?.invoice_city || null,
      zip: entry?.delivery_postcode || entry?.invoice_postcode || null,
      country: entry?.delivery_country_code || entry?.invoice_country_code || null,
      phone: entry?.delivery_phone || entry?.invoice_phone || entry?.phone || null,
      email: entry?.email || entry?.invoice_email || null,
    },
    currency: entry?.currency || 'EUR',
    totalAmount,
    items,
    notes: entry?.admin_comments || null,
    raw: entry,
  };
}

async function syncNewOrders() {
  const secrets = await getSecrets();
  await ensureOrderStatusNameCache().catch(() => {});
  let baseOrderStatusNew = normalizeStatusIdInput(secrets.baseOrderStatusNew);
  if (baseOrderStatusNew) {
    ORDER_STATUS_ID_CACHE.new = baseOrderStatusNew;
  } else {
    const labelFallback =
      typeof secrets.baseOrderStatusNew === 'string' && secrets.baseOrderStatusNew.trim()
        ? secrets.baseOrderStatusNew.trim()
        : null;
    baseOrderStatusNew = await resolveOrderStatusIdByName(
      'new',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_NEW_NAME',
      labelFallback || 'Neue Bestellung'
    );
    if (!baseOrderStatusNew) {
      baseOrderStatusNew = DEFAULT_NEW_STATUS_ID;
      ORDER_STATUS_ID_CACHE.new = DEFAULT_NEW_STATUS_ID;
      console.warn(
        `BaseLinker NEW status resolved via hard fallback DEFAULT_NEW_STATUS_ID=${DEFAULT_NEW_STATUS_ID}`
      );
    }
  }

  // Also resolve "picked" status to classify orders and (optionally) refresh closed orders in cache.
  let baseOrderStatusPicked = normalizeStatusIdInput(secrets.baseOrderStatusPicked);
  if (baseOrderStatusPicked) {
    ORDER_STATUS_ID_CACHE.picked = baseOrderStatusPicked;
  } else if (!ORDER_STATUS_ID_CACHE.picked) {
    const labelFallback =
      typeof secrets.baseOrderStatusPicked === 'string' && secrets.baseOrderStatusPicked.trim()
        ? secrets.baseOrderStatusPicked.trim()
        : null;
    baseOrderStatusPicked = await resolveOrderStatusIdByName(
      'picked',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_PICKED_NAME',
      labelFallback || 'Kommissioniert'
    );
    if (!baseOrderStatusPicked) {
      baseOrderStatusPicked = DEFAULT_PICKED_STATUS_ID;
      ORDER_STATUS_ID_CACHE.picked = DEFAULT_PICKED_STATUS_ID;
      console.warn(
        `BaseLinker PICKED status resolved via hard fallback DEFAULT_PICKED_STATUS_ID=${DEFAULT_PICKED_STATUS_ID}`
      );
    }
  }

  // Resolve "packed" status so Kommissioniert → Verpackt transitions are visible in cached orders.
  let baseOrderStatusPacked = normalizeStatusIdInput(secrets.baseOrderStatusPacked);
  if (baseOrderStatusPacked) {
    ORDER_STATUS_ID_CACHE.packed = baseOrderStatusPacked;
  } else if (!ORDER_STATUS_ID_CACHE.packed) {
    const labelFallback =
      typeof secrets.baseOrderStatusPacked === 'string' && secrets.baseOrderStatusPacked.trim()
        ? secrets.baseOrderStatusPacked.trim()
        : null;
    baseOrderStatusPacked = await resolveOrderStatusIdByName(
      'packed',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_PACKED_NAME',
      labelFallback || DEFAULT_PACKED_LABEL
    );
    if (!baseOrderStatusPacked) {
      baseOrderStatusPacked = DEFAULT_PACKED_STATUS_ID;
      ORDER_STATUS_ID_CACHE.packed = DEFAULT_PACKED_STATUS_ID;
      console.warn(
        `BaseLinker PACKED status resolved via hard fallback DEFAULT_PACKED_STATUS_ID=${DEFAULT_PACKED_STATUS_ID}`
      );
    } else {
      ORDER_STATUS_ID_CACHE.packed = baseOrderStatusPacked;
    }
  }

  if (!baseOrderStatusNew) {
    console.warn(
      'No BaseLinker status for "new" orders could be resolved – falling back to all confirmed orders within the lookback window.'
    );
  }

  // Resolve "cancelled" status to ensure cancelled orders are removed from "open" UI.
  let baseOrderStatusCancelled = normalizeStatusIdInput(secrets.baseOrderStatusCancelled);
  if (baseOrderStatusCancelled) {
    ORDER_STATUS_ID_CACHE.cancelled = baseOrderStatusCancelled;
  } else if (!ORDER_STATUS_ID_CACHE.cancelled) {
    const labelFallback =
      typeof secrets.baseOrderStatusCancelled === 'string' && secrets.baseOrderStatusCancelled.trim()
        ? secrets.baseOrderStatusCancelled.trim()
        : null;
    baseOrderStatusCancelled = await resolveOrderStatusIdByName(
      'cancelled',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_CANCELLED_NAME',
      labelFallback || DEFAULT_CANCELLED_LABEL
    );
    if (baseOrderStatusCancelled) {
      ORDER_STATUS_ID_CACHE.cancelled = baseOrderStatusCancelled;
    }
  }

  // Resolve shipped + delivered statuses so cached orders get updated as they move through the pipeline.
  // Without this, many orders remain stuck as "Kommissioniert" even after they were shipped/delivered in BaseLinker.
  let baseOrderStatusShipped = normalizeStatusIdInput(secrets.baseOrderStatusShipped);
  if (baseOrderStatusShipped) {
    ORDER_STATUS_ID_CACHE.shipped = baseOrderStatusShipped;
  } else if (!ORDER_STATUS_ID_CACHE.shipped) {
    const labelFallback =
      typeof secrets.baseOrderStatusShipped === 'string' && secrets.baseOrderStatusShipped.trim()
        ? secrets.baseOrderStatusShipped.trim()
        : null;
    baseOrderStatusShipped = await resolveOrderStatusIdByName(
      'shipped',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_SHIPPED_NAME',
      labelFallback || DEFAULT_SHIPPED_LABEL
    );
    if (!baseOrderStatusShipped) {
      baseOrderStatusShipped = DEFAULT_SHIPPED_STATUS_ID;
      ORDER_STATUS_ID_CACHE.shipped = DEFAULT_SHIPPED_STATUS_ID;
      console.warn(
        `BaseLinker SHIPPED status resolved via hard fallback DEFAULT_SHIPPED_STATUS_ID=${DEFAULT_SHIPPED_STATUS_ID}`
      );
    } else {
      ORDER_STATUS_ID_CACHE.shipped = baseOrderStatusShipped;
    }
  }

  let baseOrderStatusDelivered = normalizeStatusIdInput(secrets.baseOrderStatusDelivered);
  if (baseOrderStatusDelivered) {
    ORDER_STATUS_ID_CACHE.delivered = baseOrderStatusDelivered;
  } else if (!ORDER_STATUS_ID_CACHE.delivered) {
    const labelFallback =
      typeof secrets.baseOrderStatusDelivered === 'string' && secrets.baseOrderStatusDelivered.trim()
        ? secrets.baseOrderStatusDelivered.trim()
        : null;
    baseOrderStatusDelivered = await resolveOrderStatusIdByName(
      'delivered',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_DELIVERED_NAME',
      labelFallback || DEFAULT_DELIVERED_LABEL
    );
    if (baseOrderStatusDelivered) {
      ORDER_STATUS_ID_CACHE.delivered = baseOrderStatusDelivered;
    }
  }

  const dateFrom = Math.floor(Date.now() / 1000) - DEFAULT_ORDER_LOOKBACK_DAYS * 24 * 60 * 60;

  // We keep open orders up-to-date. BaseLinker getOrders supports filtering by status_id (official docs).
  // If "new" status id is resolved, use it to avoid scanning all statuses every time.
  const shouldFilterStatus = Boolean(baseOrderStatusNew);

  const fetchByStatus = async ({ statusId, dateFromCursor }) => {
    const out = [];
    let cursor = dateFromCursor;
    let page = 0;
    while (page < MAX_ORDER_PAGES) {
      page += 1;
      const response = await callBaseLinker('getOrders', {
        date_from: dateFromCursor,
        get_unconfirmed_orders: false,
        date_confirmed_from: cursor,
        ...(statusId ? { status_id: Number(statusId) } : {}),
      });

      const pageOrdersRaw = Array.isArray(response?.orders) ? response.orders : [];
      if (!pageOrdersRaw.length) {
        break;
      }

      out.push(...pageOrdersRaw.map(mapBaseLinkerOrder));

      const lastRaw = pageOrdersRaw[pageOrdersRaw.length - 1];
      const lastConfirmed = Number(lastRaw?.date_confirmed || lastRaw?.date_add || 0);
      if (!Number.isFinite(lastConfirmed) || lastConfirmed <= 0) {
        break;
      }
      cursor = lastConfirmed + 1;

      if (pageOrdersRaw.length < BASELINKER_ORDER_PAGE_LIMIT) {
        break;
      }
    }
    return out;
  };

  const orders = [];

  // Fetch the entire operational pipeline in the lookback window (NEW → PICKED → SHIPPED → DELIVERED + CANCELLED).
  // This prevents stale status labels and incorrect dashboard counts.
  const statusIdsToRefresh = Array.from(
    new Set(
      [
        shouldFilterStatus ? baseOrderStatusNew : null,
        baseOrderStatusPicked,
        baseOrderStatusPacked,
        baseOrderStatusShipped,
        baseOrderStatusDelivered,
        baseOrderStatusCancelled,
      ]
        .filter(Boolean)
        .map((v) => String(v))
    )
  );

  if (statusIdsToRefresh.length) {
    for (const sid of statusIdsToRefresh) {
      orders.push(...(await fetchByStatus({ statusId: sid, dateFromCursor: dateFrom })));
    }
  } else {
    // fallback: no status IDs could be resolved → fetch all orders in window
    orders.push(...(await fetchByStatus({ statusId: null, dateFromCursor: dateFrom })));
  }

  // IMPORTANT (official docs):
  // getOrders supports "order_id" to fetch exactly one specific order.
  // We use this to refresh any cached "open/new" orders that might have moved to another status
  // (e.g. cancelled) and would otherwise stay stuck in Firestore.
  try {
    const openCached = await listOrdersByStatus('new', 200);
    const uniqueIds = Array.from(
      new Set(
        (openCached || [])
          .map((o) => o?.baselinkerId || o?.id)
          .filter(Boolean)
          .map((v) => String(v))
      )
    ).slice(0, 200);

    for (const id of uniqueIds) {
      const numericId = Number(id);
      if (!Number.isFinite(numericId) || numericId <= 0) continue;
      const response = await callBaseLinker('getOrders', { order_id: numericId, get_unconfirmed_orders: false });
      const raw = Array.isArray(response?.orders) ? response.orders : [];
      if (!raw.length) continue;
      orders.push(...raw.map(mapBaseLinkerOrder));
    }
  } catch (error) {
    console.warn('Failed to refresh open orders by order_id:', error?.message || error);
  }

  // Post-process statuses using resolved names to classify picked/closed
  const pickedId = ORDER_STATUS_ID_CACHE.picked || DEFAULT_PICKED_STATUS_ID;
  const packedId = ORDER_STATUS_ID_CACHE.packed || null;
  const cancelledId = ORDER_STATUS_ID_CACHE.cancelled || null;
  orders.forEach((order) => {
    const rawLabel = order.statusLabel || order.orderStatus || '';
    const normalized = (rawLabel || '').toLowerCase();
    const isPickedId = order.statusId && String(order.statusId) === String(pickedId);
    const isPackedId = packedId && order.statusId && String(order.statusId) === String(packedId);
    const isCancelledId = cancelledId && order.statusId && String(order.statusId) === String(cancelledId);
    const looksCancelled =
      normalized.includes('storniert') ||
      normalized.includes('cancelled') ||
      normalized.includes('canceled') ||
      normalized.includes('abgebrochen');
    const isNewId = baseOrderStatusNew && order.statusId && String(order.statusId) === String(baseOrderStatusNew);

    if (isPackedId || normalized.includes('verpackt') || normalized.includes('packed')) {
      order.status = 'packed';
      return;
    }

    // If we know the explicit "NEW" status id, only treat matching orders as open/new.
    if (baseOrderStatusNew && order.statusId && !isNewId) {
      // Closed/picked statuses stay picked, everything else becomes "other" (not open).
      if (isPickedId || isCancelledId || looksCancelled) {
        order.status = 'picked';
      } else if (
        normalized.includes('kommissioniert') ||
        normalized.includes('versandt') ||
        normalized.includes('versendet') ||
        normalized.includes('zugestellt') ||
        normalized.includes('delivered') ||
        looksCancelled
      ) {
        order.status = 'picked';
      } else {
        order.status = 'other';
      }
      return;
    }

    const looksNew =
      isNewId ||
      normalized.includes('neu') ||
      normalized.includes('new') ||
      normalized === '';

    if (looksNew) {
      order.status = 'new';
    } else if (isPickedId || isCancelledId || looksCancelled) {
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

  await saveOrders(orders);

  // Best-effort stock reservation for new orders — prevents overselling
  try {
    const newOrders = orders.filter((o) => o.status === 'new');
    if (newOrders.length > 0) {
      const { reserveStock } = require('./stock-reservation');
      for (const order of newOrders) {
        const items = (order.items || [])
          .filter((item) => item.sku && item.quantity > 0)
          .map((item) => ({ sku: item.sku, productId: item.productId || null, quantity: item.quantity }));
        if (items.length > 0) {
          const result = await reserveStock({
            tenantId: 'default',
            orderId: order.id || order.baselinkerId,
            items,
          });
          if (result.reserved) {
            console.log(`[order-sync] reserved stock for order ${order.id}: ${result.count} items`);
          }
        }
      }
    }
  } catch (reserveErr) {
    // Non-blocking: reservation failure should never prevent order sync
    console.warn('[order-sync] stock reservation failed (non-blocking):', reserveErr?.message || reserveErr);
  }

  // Prune old orders beyond lookback window to keep dashboard counts consistent and prevent unbounded growth.
  // This is best-effort and safe: it only deletes very old orders that are outside our sync window anyway.
  try {
    const pruneEnabled = (process.env.ORDER_SYNC_PRUNE_OLD ?? 'true').toString().toLowerCase() === 'true';
    if (pruneEnabled) {
      const cutoffIso = new Date(Date.now() - DEFAULT_ORDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
      let deleted = 0;
      // Delete in small batches to avoid timeouts.
      while (deleted < 2000) {
        const snap = await firestore
          .collection('orders')
          .where('createdAt', '<', cutoffIso)
          .limit(200)
          .get();
        if (snap.empty) break;
        const batch = firestore.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        deleted += snap.docs.length;
        if (snap.docs.length < 200) break;
      }
      if (deleted > 0) {
        console.log(`[order-sync] pruned old orders: ${deleted} (cutoff ${cutoffIso})`);
      }
    }
  } catch (error) {
    console.warn('Order prune pass failed:', error?.message || error);
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

  return orders;
}

async function markOrderAsPicked(orderId) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }

  const secrets = await getSecrets();
  let baseOrderStatusPicked = normalizeStatusIdInput(secrets.baseOrderStatusPicked);
  if (baseOrderStatusPicked) {
    ORDER_STATUS_ID_CACHE.picked = baseOrderStatusPicked;
  } else {
    const labelFallback =
      typeof secrets.baseOrderStatusPicked === 'string' && secrets.baseOrderStatusPicked.trim()
        ? secrets.baseOrderStatusPicked.trim()
        : null;
    baseOrderStatusPicked = await resolveOrderStatusIdByName(
      'picked',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_PICKED_NAME',
      labelFallback || 'Kommissioniert'
    );
    // Hard fallback to known ID if name lookup fails
    if (!baseOrderStatusPicked) {
      baseOrderStatusPicked = DEFAULT_PICKED_STATUS_ID;
      ORDER_STATUS_ID_CACHE.picked = DEFAULT_PICKED_STATUS_ID;
      console.warn(
        `BaseLinker picked status resolved via hard fallback DEFAULT_PICKED_STATUS_ID=${DEFAULT_PICKED_STATUS_ID}`
      );
    }
  }

  if (!baseOrderStatusPicked) {
    throw new Error('BASE_ORDER_STATUS_PICKED secret, env variable, or fallback name is required to mark orders as picked.');
  }

  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  const baselinkerOrderId = Number(order.baselinkerId || order.id);
  const baselinkerStatusId = Number(baseOrderStatusPicked);

  const response = await callBaseLinker('setOrderStatus', {
    order_id: baselinkerOrderId,
    status_id: baselinkerStatusId,
  });

  if (response?.status !== 'SUCCESS') {
    throw new Error(
      `BaseLinker setOrderStatus failed for order ${orderId} (BL ${baselinkerOrderId}) to status ${baselinkerStatusId}: ${response?.error_message || 'unknown error'
      }`
    );
  }

  // Stock decrement is handled by the explicit warehouse pick endpoint (/api/warehouse/stock-out),
  // which is BIN-accurate. Do not decrement here to avoid double-decrements.

  await updateOrder(orderId, {
    status: 'picked',
    statusLabel: 'Kommissioniert',
    statusId: String(baseOrderStatusPicked),
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

  const secrets = await getSecrets();

  // Resolve picked status id to enforce the precondition (Kommissioniert).
  let baseOrderStatusPicked = normalizeStatusIdInput(secrets.baseOrderStatusPicked);
  if (baseOrderStatusPicked) {
    ORDER_STATUS_ID_CACHE.picked = baseOrderStatusPicked;
  } else {
    const labelFallback =
      typeof secrets.baseOrderStatusPicked === 'string' && secrets.baseOrderStatusPicked.trim()
        ? secrets.baseOrderStatusPicked.trim()
        : null;
    baseOrderStatusPicked = await resolveOrderStatusIdByName(
      'picked',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_PICKED_NAME',
      labelFallback || 'Kommissioniert'
    );
    // Hard fallback to known ID if name lookup fails
    if (!baseOrderStatusPicked) {
      baseOrderStatusPicked = DEFAULT_PICKED_STATUS_ID;
      ORDER_STATUS_ID_CACHE.picked = DEFAULT_PICKED_STATUS_ID;
    }
  }

  const currentLabel = (order.statusLabel || '').toString().toLowerCase();
  const currentStatusId = order.statusId != null ? String(order.statusId) : null;
  const looksPicked =
    currentLabel.includes('kommissioniert') ||
    (currentStatusId && String(currentStatusId) === String(baseOrderStatusPicked));
  if (!looksPicked) {
    throw new Error(`Order is not in status "Kommissioniert" (current: "${order.statusLabel || '—'}").`);
  }

  // Resolve packed status id (Verpackt)
  let baseOrderStatusPacked = normalizeStatusIdInput(secrets.baseOrderStatusPacked);
  if (baseOrderStatusPacked) {
    ORDER_STATUS_ID_CACHE.packed = baseOrderStatusPacked;
  } else {
    const labelFallback =
      typeof secrets.baseOrderStatusPacked === 'string' && secrets.baseOrderStatusPacked.trim()
        ? secrets.baseOrderStatusPacked.trim()
        : null;
    baseOrderStatusPacked = await resolveOrderStatusIdByName(
      'packed',
      labelFallback ? undefined : 'BASE_ORDER_STATUS_PACKED_NAME',
      labelFallback || DEFAULT_PACKED_LABEL
    );
  }

  if (!baseOrderStatusPacked) {
    throw new Error('BASE_ORDER_STATUS_PACKED (or BASE_ORDER_STATUS_PACKED_NAME) is required to mark orders as packed.');
  }

  const baselinkerOrderId = Number(order.baselinkerId || order.id);
  const baselinkerStatusId = Number(baseOrderStatusPacked);

  const response = await callBaseLinker('setOrderStatus', {
    order_id: baselinkerOrderId,
    status_id: baselinkerStatusId,
  });

  if (response?.status !== 'SUCCESS') {
    throw new Error(
      `BaseLinker setOrderStatus failed for order ${orderId} (BL ${baselinkerOrderId}) to status ${baselinkerStatusId}: ${response?.error_message || 'unknown error'}`
    );
  }

  await updateOrder(orderId, {
    status: 'packed',
    statusLabel: DEFAULT_PACKED_LABEL,
    statusId: String(baseOrderStatusPacked),
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

