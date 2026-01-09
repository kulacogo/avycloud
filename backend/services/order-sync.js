const { callBaseLinker } = require('../lib/baselinker');
const { getSecrets } = require('../lib/secrets');
const { saveOrders, getOrderById, updateOrder, listOrdersByStatus } = require('../lib/firestore');
const { decrementProductByIdOrSku } = require('../lib/warehouse');

// Increase lookback to ensure older shipped/picked orders are included for stock cleanup
const DEFAULT_ORDER_LOOKBACK_DAYS = parseInt(process.env.ORDER_SYNC_LOOKBACK_DAYS || '60', 10);
const BASELINKER_ORDER_PAGE_LIMIT = 100; // per docs: max 100 orders per call
const MAX_ORDER_PAGES = 1000; // safety guard
const ORDER_STATUS_ID_CACHE = {
  new: null,
  picked: null,
};

const DEFAULT_PICKED_STATUS_ID = '363183'; // BaseLinker status "Kommissioniert"
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
    }))
    : [];

  const totalAmount = items.reduce((sum, item) => sum + item.priceBrutto * item.quantity, 0);

  return {
    id: String(entry.order_id),
    baselinkerId: String(entry.order_id),
    source: 'baselinker',
    status: 'new',
    statusLabel: resolvedStatusLabel,
    statusId: statusIdRaw,
    createdAt,
    updatedAt: createdAt,
    // IMPORTANT:
    // - order_source_id is the SOURCE/SHOP id (often constant), NOT an order number.
    // - Prefer external_order_id / shop_order_id when available; otherwise fallback to BaseLinker order_id.
    number:
      entry?.external_order_id ||
      entry?.shop_order_id ||
      entry?.external_invoice_number ||
      String(entry.order_id),
    customer: {
      name: entry?.delivery_fullname || entry?.invoice_fullname || entry?.buyer || 'Unbekannt',
      city: entry?.delivery_city || entry?.invoice_city || null,
      country: entry?.delivery_country_code || entry?.invoice_country_code || null,
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
  }

  if (!baseOrderStatusNew) {
    console.warn(
      'No BaseLinker status for "new" orders could be resolved – falling back to all confirmed orders within the lookback window.'
    );
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

  // Fetch "new" orders (preferred: status filter).
  orders.push(...(await fetchByStatus({ statusId: shouldFilterStatus ? baseOrderStatusNew : null, dateFromCursor: dateFrom })));

  // Optional: refresh recently closed/picked orders in cache so they disappear from "open" UI even if they moved out of NEW.
  const PICKED_REFRESH_DAYS = parseInt(process.env.ORDER_SYNC_PICKED_REFRESH_DAYS || '14', 10);
  const pickedLookback = Math.max(1, Math.min(PICKED_REFRESH_DAYS, DEFAULT_ORDER_LOOKBACK_DAYS));
  const pickedDateFrom = Math.floor(Date.now() / 1000) - pickedLookback * 24 * 60 * 60;
  if (baseOrderStatusPicked) {
    orders.push(...(await fetchByStatus({ statusId: baseOrderStatusPicked, dateFromCursor: pickedDateFrom })));
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
  orders.forEach((order) => {
    const rawLabel = order.statusLabel || order.orderStatus || '';
    const normalized = (rawLabel || '').toLowerCase();
    const isPickedId = order.statusId && String(order.statusId) === String(pickedId);
    const looksCancelled =
      normalized.includes('storniert') ||
      normalized.includes('cancelled') ||
      normalized.includes('canceled') ||
      normalized.includes('abgebrochen');
    const isNewId = baseOrderStatusNew && order.statusId && String(order.statusId) === String(baseOrderStatusNew);

    // If we know the explicit "NEW" status id, only treat matching orders as open/new.
    if (baseOrderStatusNew && order.statusId && !isNewId) {
      // Closed/picked statuses stay picked, everything else becomes "other" (not open).
      if (isPickedId || looksCancelled) {
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
    } else if (isPickedId || looksCancelled) {
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

module.exports = {
  syncNewOrders,
  markOrderAsPicked,
};

function isClosedStatus(statusLabel = '') {
  const raw = statusLabel.toLowerCase();
  return (
    raw.includes('kommissioniert') ||
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

