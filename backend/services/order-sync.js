const { callBaseLinker } = require('../lib/baselinker');
const { getSecrets } = require('../lib/secrets');
const { saveOrders, getOrderById, updateOrder } = require('../lib/firestore');
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
    statusLabel: entry?.status_name || entry?.order_status_name || 'Neue Bestellung',
    statusId: entry?.order_status_id ? String(entry.order_status_id) : entry?.status_id ? String(entry.status_id) : null,
    createdAt,
    updatedAt: createdAt,
    number: entry?.order_source_id || entry?.custom_source_id || entry?.external_invoice_number || null,
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

  // Also resolve "picked" status to correctly classify orders if they are fetched by mistake (e.g. fallback mode)
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
  const baseParams = {
    date_from: dateFrom,
    get_unconfirmed_orders: false,
  };

  // Fetch all confirmed orders in the window (no status filter) so picked/shipped are included
  const statusList = await callBaseLinker('getOrderStatusList', {})?.then((r) => r?.statuses || []).catch(() => []);
  const statusNameById = new Map(statusList.map((s) => [String(s.id), s.name || '']));

  const orders = [];
  let cursor = dateFrom;
  let page = 0;

  // Paginate according to official guidance: date_confirmed_from cursor, limit 100, stop when <100
  // and advance cursor to last date_confirmed (+1s).
  while (page < MAX_ORDER_PAGES) {
    page += 1;
    const response = await callBaseLinker('getOrders', {
      ...baseParams,
      date_confirmed_from: cursor,
      limit: BASELINKER_ORDER_PAGE_LIMIT,
    });

    const pageOrdersRaw = Array.isArray(response?.orders) ? response.orders : [];
    if (!pageOrdersRaw.length) {
      break;
    }

    orders.push(...pageOrdersRaw.map(mapBaseLinkerOrder));

    // Advance cursor: last confirmed date (fallback date_add) +1s
    const lastRaw = pageOrdersRaw[pageOrdersRaw.length - 1];
    const lastConfirmed = Number(lastRaw?.date_confirmed || lastRaw?.date_add || 0);
    if (!Number.isFinite(lastConfirmed) || lastConfirmed <= 0) {
      break; // cannot safely paginate, stop to avoid loop
    }
    cursor = lastConfirmed + 1;

    if (pageOrdersRaw.length < BASELINKER_ORDER_PAGE_LIMIT) {
      break; // no more pages
    }
  }

  // Post-process statuses using resolved names to classify picked/closed
  const pickedId = ORDER_STATUS_ID_CACHE.picked || DEFAULT_PICKED_STATUS_ID;
  orders.forEach((order) => {
    const rawLabel = statusNameById.get(order.statusId || '') || order.statusLabel || order.orderStatus || '';
    order.statusLabel = rawLabel || order.statusLabel;
    const normalized = (rawLabel || '').toLowerCase();
    const isPickedId = order.statusId && String(order.statusId) === String(pickedId);
    const looksCancelled =
      normalized.includes('storniert') ||
      normalized.includes('cancelled') ||
      normalized.includes('canceled') ||
      normalized.includes('abgebrochen');
    const isNewId = baseOrderStatusNew && order.statusId && String(order.statusId) === String(baseOrderStatusNew);
    const looksNew =
      isNewId ||
      normalized.includes('neu') ||
      normalized.includes('new') ||
      normalized.includes('bestellung') ||
      normalized.includes('bestellungen') ||
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
      // Default: unknown status => treat as open so Picks nicht verschwinden
      order.status = 'new';
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

