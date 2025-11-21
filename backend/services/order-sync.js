const { callBaseLinker } = require('../lib/baselinker');
const { getSecrets } = require('../lib/secrets');
const { saveOrders, getOrderById, updateOrder } = require('../lib/firestore');

const DEFAULT_ORDER_LOOKBACK_DAYS = parseInt(process.env.ORDER_SYNC_LOOKBACK_DAYS || '7', 10);
const ORDER_STATUS_ID_CACHE = {
  new: null,
  picked: null,
};

function normalizeStatusName(value) {
  return (value || '').trim().toLowerCase();
}

async function resolveOrderStatusIdByName(cacheKey, envNameKey, fallbackLabel) {
  if (ORDER_STATUS_ID_CACHE[cacheKey]) {
    return ORDER_STATUS_ID_CACHE[cacheKey];
  }

  const targetLabel = (process.env[envNameKey] || fallbackLabel || '').trim();
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
    statusLabel: entry?.status_name || 'Neue Bestellung',
    statusId: entry?.status_id ? String(entry.status_id) : null,
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
  let baseOrderStatusNew = secrets.baseOrderStatusNew;
  if (!baseOrderStatusNew) {
    baseOrderStatusNew = await resolveOrderStatusIdByName(
      'new',
      'BASE_ORDER_STATUS_NEW_NAME',
      'Neue Bestellung'
    );
  } else {
    ORDER_STATUS_ID_CACHE.new = String(baseOrderStatusNew);
  }
  if (!baseOrderStatusNew) {
    throw new Error('BASE_ORDER_STATUS_NEW secret, env variable, or fallback name is required to sync orders.');
  }

  const dateFrom = Math.floor(Date.now() / 1000) - DEFAULT_ORDER_LOOKBACK_DAYS * 24 * 60 * 60;
  const response = await callBaseLinker('getOrders', {
    status_id: Number(baseOrderStatusNew),
    date_confirmed_from: dateFrom,
    get_unconfirmed_orders: true,
  });

  const orders = Array.isArray(response?.orders) ? response.orders.map(mapBaseLinkerOrder) : [];
  await saveOrders(orders);
  return orders;
}

async function markOrderAsPicked(orderId) {
  if (!orderId) {
    throw new Error('Order ID is required');
  }

  const secrets = await getSecrets();
  let baseOrderStatusPicked = secrets.baseOrderStatusPicked;
  if (!baseOrderStatusPicked) {
    baseOrderStatusPicked = await resolveOrderStatusIdByName(
      'picked',
      'BASE_ORDER_STATUS_PICKED_NAME',
      'Kommissioniert'
    );
  } else {
    ORDER_STATUS_ID_CACHE.picked = String(baseOrderStatusPicked);
  }

  if (!baseOrderStatusPicked) {
    throw new Error('BASE_ORDER_STATUS_PICKED secret, env variable, or fallback name is required to mark orders as picked.');
  }

  const order = await getOrderById(orderId);
  if (!order) {
    throw new Error('Order not found');
  }

  await callBaseLinker('setOrderStatus', {
    order_id: Number(order.baselinkerId || order.id),
    status_id: Number(baseOrderStatusPicked),
  });

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

