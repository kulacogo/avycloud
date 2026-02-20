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

function normalizeBinCode(value) {
  if (!value) return '';
  return String(value).trim().toUpperCase();
}

function buildPickHint(product, fallbackItem) {
  if (!product) return null;

  const rawBins = Array.isArray(product.storageBins) ? product.storageBins : [];
  const bins = rawBins
    .map((b) => ({
      code: normalizeBinCode(b?.code || b?.binCode),
      quantity: Number(b?.quantity || 0) || 0,
    }))
    .filter((b) => Boolean(b.code));

  // Prefer a stable "primary" bin if the product has one, but ensure the quantity matches THAT bin
  // (not a potentially aggregated product.storage.quantity).
  const storagePrimaryCode = normalizeBinCode(product.storage?.binCode);
  const primaryFromBins = storagePrimaryCode ? bins.find((b) => b.code === storagePrimaryCode) : null;

  let primaryBin = storagePrimaryCode || null;
  let primaryQuantity = null;

  if (primaryBin) {
    if (primaryFromBins) {
      primaryQuantity = primaryFromBins.quantity;
    } else if (typeof product.storage?.quantity === 'number' && Number.isFinite(product.storage.quantity)) {
      primaryQuantity = product.storage.quantity;
    }
  } else if (bins.length) {
    // No explicit primary bin → pick the bin with stock (or the first known bin as fallback).
    const candidates = bins.filter((b) => b.quantity > 0);
    const list = candidates.length ? candidates : bins;
    list.sort((a, b) => (b.quantity - a.quantity) || a.code.localeCompare(b.code));
    primaryBin = list[0]?.code || null;
    primaryQuantity = typeof list[0]?.quantity === 'number' ? list[0].quantity : null;
  }

  if (primaryQuantity == null) {
    const invQty = product.inventory?.quantity;
    primaryQuantity = typeof invQty === 'number' && Number.isFinite(invQty) ? invQty : null;
  }

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
  __test__buildPickHint: buildPickHint,
};

