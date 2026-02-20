const { findProductByStrictIdentifier } = require('../lib/firestore');

function normalize(value) {
  if (!value) return null;
  return String(value).trim().toLowerCase();
}

function getCacheEntry(cache, keys) {
  for (const key of keys) {
    if (!key) continue;
    if (cache.has(key)) {
      return cache.get(key);
    }
  }
  return undefined;
}

function setCacheEntry(cache, keys, value) {
  keys.forEach((key) => {
    if (key) {
      cache.set(key, value || null);
    }
  });
}

function buildPickHint(product, fallbackItem) {
  if (!product) return null;
  const primaryBin =
    product.storage?.binCode ||
    (Array.isArray(product.storageBins) && product.storageBins.length > 0 ? product.storageBins[0]?.code : null);
  const primaryQuantity =
    product.storage?.quantity ||
    (Array.isArray(product.storageBins) && product.storageBins.length > 0 ? product.storageBins[0]?.quantity : null) ||
    product.inventory?.quantity ||
    null;

  return {
    productId: product.id,
    productName: product.identification?.name || fallbackItem?.name || product.id,
    sku:
      product.details?.identifiers?.sku ||
      product.identification?.sku ||
      fallbackItem?.sku ||
      product.id ||
      null,
    binCode: primaryBin || null,
    quantityAvailable: typeof primaryQuantity === 'number' ? primaryQuantity : null,
    image: product.details?.images?.[0]?.url_or_base64 || null,
  };
}

async function resolvePickHintForItem(item, cache) {
  const identifierKeys = [
    item.sku ? `sku:${normalize(item.sku)}` : null,
    item.ean ? `ean:${normalize(item.ean)}` : null,
  ].filter(Boolean);

  const cached = getCacheEntry(cache, identifierKeys);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const product = await findProductByStrictIdentifier({
      sku: item.sku || null,
      barcodes: item.ean ? [item.ean] : [],
    });
    const hint = buildPickHint(product, item);
    setCacheEntry(cache, identifierKeys, hint);
    return hint;
  } catch (error) {
    console.warn(`Failed to resolve pick hint for item ${item?.id || item?.sku}:`, error.message);
    setCacheEntry(cache, identifierKeys, null);
    return null;
  }
}

async function attachPickHintsToOrders(orders = []) {
  if (!Array.isArray(orders) || !orders.length) {
    return orders;
  }
  const productCache = new Map();
  const enriched = [];

  for (const order of orders) {
    if (!order?.items?.length) {
      enriched.push(order);
      continue;
    }
    const augmentedItems = [];
    for (const item of order.items) {
      const hint = await resolvePickHintForItem(item, productCache);
      augmentedItems.push({
        ...item,
        pickHint: hint,
      });
    }
    enriched.push({
      ...order,
      items: augmentedItems,
    });
  }

  return enriched;
}

module.exports = {
  attachPickHintsToOrders,
};

