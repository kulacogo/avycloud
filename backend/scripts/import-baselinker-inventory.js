/**
 * Importiert Produkte aus einem BaseLinker-Inventory nach Firestore (avystock).
 * Holt Liste, Produktdaten, Stock, Prices, Kategorien, Hersteller und merged in Firestore.
 *
 * Usage:
 *   BASELINKER_INVENTORY_ID=78659 node backend/scripts/import-baselinker-inventory.js
 */

const { callBaseLinker } = require('../lib/baselinker');
const { saveProduct } = require('../lib/firestore');

const INVENTORY_ID = process.env.BASELINKER_INVENTORY_ID || '78659';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const getPid = (entry = {}) =>
  entry.product_id ?? entry.id ?? entry.productId ?? entry.base_product_id ?? null;

async function getAllProductsList(inventoryId) {
  const items = [];
  let page = 1;
  while (true) {
    const res = await callBaseLinker('getInventoryProductsList', {
      inventory_id: Number(inventoryId),
      page,
    });
    const list = Object.values(res?.products || res?.items || {});
    if (!list.length) break;
    items.push(...list);
    if (list.length < 100) break;
    page += 1;
    await sleep(150);
  }
  return items;
}

async function getProductsData(ids) {
  const out = {};
  const chunkSize = 50;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const res = await callBaseLinker('getInventoryProductsData', {
      inventory_id: Number(INVENTORY_ID),
      products: chunk,
    });
    Object.entries(res?.products || {}).forEach(([id, data]) => {
      out[id] = data;
    });
    await sleep(150);
  }
  return out;
}

async function getStock(ids) {
  const out = {};
  const chunkSize = 50;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const res = await callBaseLinker('getInventoryProductsStock', {
      inventory_id: Number(INVENTORY_ID),
      products: chunk,
    });
    Object.entries(res?.stocks || {}).forEach(([id, data]) => {
      out[id] = data;
    });
    await sleep(150);
  }
  return out;
}

async function getPrices(ids) {
  const out = {};
  const chunkSize = 50;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const res = await callBaseLinker('getInventoryProductsPrices', {
      inventory_id: Number(INVENTORY_ID),
      products: chunk,
    });
    Object.entries(res?.prices || {}).forEach(([id, data]) => {
      out[id] = data;
    });
    await sleep(150);
  }
  return out;
}

async function getCategories() {
  const res = await callBaseLinker('getInventoryCategories', {
    inventory_id: Number(INVENTORY_ID),
  });
  const cats = res?.categories || [];
  const map = new Map();
  cats.forEach((c) => {
    if (c?.category_id) map.set(String(c.category_id), c.name || '');
  });
  return map;
}

async function getManufacturers() {
  const res = await callBaseLinker('getInventoryManufacturers', {
    inventory_id: Number(INVENTORY_ID),
  });
  const mans = res?.manufacturers || [];
  const map = new Map();
  mans.forEach((m) => {
    if (m?.manufacturer_id) map.set(String(m.manufacturer_id), m.name || '');
  });
  return map;
}

function pickFirstPrice(pricesObj) {
  if (!pricesObj || typeof pricesObj !== 'object') return null;
  const keys = Object.keys(pricesObj);
  if (!keys.length) return null;
  const key = keys[0];
  const val = pricesObj[key];
  if (val === undefined || val === null) return null;
  return { amount: Number(val) || 0, currency: 'EUR' };
}

function pickFirstStock(stockObj) {
  if (!stockObj || typeof stockObj !== 'object') return 0;
  const vals = Object.values(stockObj);
  if (!vals.length) return 0;
  const val = vals[0];
  return Number(val) || 0;
}

async function main() {
  console.log(`Import BaseLinker Inventory ${INVENTORY_ID} -> Firestore`);
  const list = await getAllProductsList(INVENTORY_ID);
  console.log(`Produkte gelistet: ${list.length}`);
  const ids = list.map((p) => getPid(p)).filter(Boolean);

  const [dataMap, stockMap, priceMap, catMap, manMap] = await Promise.all([
    getProductsData(ids),
    getStock(ids),
    getPrices(ids),
    getCategories(),
    getManufacturers(),
  ]);

  let imported = 0;
  for (const base of list) {
    const pid = String(getPid(base) || '');
    const data = dataMap[pid] || {};
    const stock = stockMap[pid] || {};
    const prices = priceMap[pid] || {};

    const price = pickFirstPrice(prices);
    const qty = pickFirstStock(stock);
    const catId = base.category_id ? String(base.category_id) : null;
    const catName = catId ? catMap.get(catId) || '' : '';

    const imageList = Array.isArray(data.images)
      ? data.images
      : data.images && typeof data.images === 'object'
      ? Object.values(data.images)
      : [];
    const images =
      (imageList || [])
        .filter((u) => typeof u === 'string' && u.startsWith('http'))
        .slice(0, 5)
        .map((u) => ({ url_or_base64: u, source: 'baselinker' })) || [];

    const attrs = {};
    if (catName) attrs.category = catName;
    if (data.text_fields) {
      Object.entries(data.text_fields).forEach(([k, v]) => {
        if (v) attrs[`text_${k}`] = v;
      });
    }
    const manufacturerName =
      (data.manufacturer_id && manMap.get(String(data.manufacturer_id))) ||
      data.manufacturer ||
      '';

    const sku =
      (data.sku || base.sku || '').toString().trim();
    if (!sku) {
      console.warn(`Übersprungen (kein SKU) für BaseLinker-ID ${pid}`);
      continue;
    }

    const product = {
      id: sku, // Firestore ID immer SKU
      identification: {
        name: data.name || base.name || '',
        brand: manufacturerName || data?.producer || '',
        category: catName || '',
        sku,
        barcodes: data.ean ? [data.ean] : [],
      },
      details: {
        identifiers: {
          sku,
          ean: data.ean || base.ean || '',
          gtin: data.ean || base.ean || '',
        },
        pricing: price
          ? {
              lowest_price: {
                amount: price.amount,
                currency: price.currency,
                sources: [],
              },
              price_confidence: 1,
            }
          : undefined,
        images,
        attributes: attrs,
      },
      inventory: {
        quantity: qty,
      },
      storageBins: [],
      ops: {
        sync_status: 'pending',
        last_saved_iso: new Date().toISOString(),
        revision: 1,
        base_product_id: pid || null,
      },
    };

    try {
      await saveProduct(product);
      imported += 1;
    } catch (e) {
      console.error('Fehler beim Speichern', pid, e.message);
    }
  }

  console.log(`Import abgeschlossen: ${imported}/${list.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
