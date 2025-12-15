/**
 * Importiert/angereichert Produktdaten aus BaseLinker Inventory in Firestore.
 * - Match per SKU (Doc-ID), Fallback EAN/barcodes
 * - Ergänzt fehlende Felder (Name, EAN/GTIN, Beschreibung, Features->attributes)
 * - Ergänzt Preise, wenn noch keiner vorhanden
 * - Setzt Bestand aus stock und BIN-Code aus locations (ohne Zonendetails)
 * - Setzt Bilder aus BaseLinker, wenn vorhanden
 *
 * Usage:
 *   BASELINKER_INVENTORY_ID=78659 node backend/scripts/import-baselinker-full.js
 */

const { callBaseLinker } = require('../lib/baselinker');
const { firestore, findProductByStrictIdentifier, saveProduct } = require('../lib/firestore');

const INVENTORY_ID = Number(process.env.BASELINKER_INVENTORY_ID || 78659);
const binCache = new Map(); // binCode -> metadata from warehouseBins

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listProducts(inventoryId) {
  const items = [];
  let page = 1;
  while (true) {
    const res = await callBaseLinker('getInventoryProductsList', {
      inventory_id: inventoryId,
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

async function fetchData(ids) {
  const out = {};
  const chunk = 40;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const res = await callBaseLinker('getInventoryProductsData', {
      inventory_id: INVENTORY_ID,
      products: slice,
    });
    Object.entries(res?.products || {}).forEach(([pid, data]) => {
      out[pid] = data;
    });
    await sleep(150);
  }
  return out;
}

async function fetchCategories() {
  const res = await callBaseLinker('getInventoryCategories', { inventory_id: INVENTORY_ID });
  const map = new Map();
  (res?.categories || []).forEach((c) => {
    if (c?.category_id) map.set(String(c.category_id), c.name || '');
  });
  return map;
}

function normalizeImages(images) {
  if (!images) return [];
  const arr = Array.isArray(images)
    ? images
    : typeof images === 'object'
    ? Object.values(images)
    : [];
  return arr
    .filter((u) => typeof u === 'string' && u.startsWith('http'))
    .map((u) => ({ url_or_base64: u, source: 'baselinker' }));
}

function mergeUnique(existing = [], incoming = []) {
  const seen = new Set();
  const out = [];
  const add = (img) => {
    if (!img || !img.url_or_base64) return;
    if (seen.has(img.url_or_base64)) return;
    seen.add(img.url_or_base64);
    out.push(img);
  };
  existing.forEach(add);
  incoming.forEach(add);
  return out.slice(0, 10);
}

function firstPrice(prices) {
  if (!prices || typeof prices !== 'object') return null;
  const val = Object.values(prices)[0];
  const amount = Number(val);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: 'EUR' };
}

function sumStock(stock) {
  if (!stock || typeof stock !== 'object') return 0;
  return Object.values(stock).reduce((s, v) => s + (Number(v) || 0), 0);
}

function pickBin(locations) {
  if (!locations || typeof locations !== 'object') return null;
  const val = Object.values(locations)[0];
  return val || null;
}

async function getBinMeta(binCode) {
  if (!binCode) return null;
  if (binCache.has(binCode)) return binCache.get(binCode);
  const snap = await firestore.collection('warehouseBins').doc(binCode).get();
  const meta = snap.exists ? snap.data() || {} : null;
  binCache.set(binCode, meta);
  return meta;
}

function mergeAttributes(existing = {}, textFields = {}, features = {}) {
  const out = { ...(existing || {}) };
  // text_fields.features is object of key/value
  Object.entries(features || {}).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    if (!out[k]) out[k] = v;
  });
  // keep everything flat
  return out;
}

async function main() {
  console.log(`Lade BaseLinker-Produkte (inventory ${INVENTORY_ID}) …`);
  const list = await listProducts(INVENTORY_ID);
  console.log(`Produkte gelistet: ${list.length}`);

  const ids = list.map((p) => p.product_id || p.id).filter(Boolean);
  const [dataMap, catMap] = await Promise.all([fetchData(ids), fetchCategories()]);

  let matched = 0;
  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const base of list) {
    const pid = base.product_id || base.id;
    const data = dataMap[pid] || {};

    const sku = (data.sku || base.sku || '').toString().trim();
    const ean = (data.ean || base.ean || '').toString().trim();
    if (!sku && !ean) {
      skipped += 1;
      continue;
    }

    let docSnap = null;
    if (sku) {
      const snap = await firestore.collection('products').doc(sku).get();
      if (snap.exists) docSnap = snap;
    }
    if (!docSnap) {
      const hit = await findProductByStrictIdentifier({
        sku: sku || null,
        barcodes: ean ? [ean] : [],
      });
      if (hit) docSnap = await firestore.collection('products').doc(hit.id).get();
    }
    let dataDoc = {};
    if (docSnap && docSnap.exists) {
      dataDoc = docSnap.data() || {};
      matched += 1;
    } else {
      // create new
      dataDoc = {
        id: sku || ean,
        identification: {
          sku: sku || ean,
          name: '',
          brand: '',
          category: '',
          barcodes: ean ? [ean] : [],
        },
        details: { identifiers: { sku: sku || ean, ean, gtin: ean } },
        inventory: { quantity: 0 },
        storageBins: [],
        ops: { sync_status: 'pending', revision: 1 },
      };
      created += 1;
    }

    // Merge fields (only fill gaps)
    const name = data.text_fields?.name || base.name;
    if (!dataDoc.identification) dataDoc.identification = {};
    if (name && !dataDoc.identification.name) dataDoc.identification.name = name;

    if (!dataDoc.identification.brand && data.manufacturer) {
      dataDoc.identification.brand = data.manufacturer;
    }

    if (!dataDoc.identification.category && data.category_id) {
      const catName = catMap.get(String(data.category_id));
      if (catName) dataDoc.identification.category = catName;
    }

    if (!dataDoc.details) dataDoc.details = {};
    if (!dataDoc.details.identifiers) dataDoc.details.identifiers = {};
    if (ean && !dataDoc.details.identifiers.ean) dataDoc.details.identifiers.ean = ean;
    if (ean && !dataDoc.details.identifiers.gtin) dataDoc.details.identifiers.gtin = ean;
    if (!Array.isArray(dataDoc.identification.barcodes)) dataDoc.identification.barcodes = [];
    if (ean && !dataDoc.identification.barcodes.includes(ean)) dataDoc.identification.barcodes.push(ean);

    // description
    if (data.text_fields?.description && !dataDoc.details.description) {
      dataDoc.details.description = data.text_fields.description;
    }

    // attributes / features
    const features = data.text_fields?.features || {};
    dataDoc.details.attributes = mergeAttributes(dataDoc.details.attributes, data.text_fields || {}, features);

    // pricing
    const incomingPrice = firstPrice(data.prices);
    const existingPrice = dataDoc.details?.pricing?.lowest_price;
    const existingValid = existingPrice && Number(existingPrice.amount) > 0;
    if (incomingPrice && !existingValid) {
      dataDoc.details.pricing = {
        lowest_price: {
          amount: incomingPrice.amount,
          currency: incomingPrice.currency,
          sources: [],
        },
        price_confidence: 1,
      };
    }

    // images
    const imgs = normalizeImages(data.images);
    const existingImgs = Array.isArray(dataDoc.details?.images) ? dataDoc.details.images : [];
    const mergedImgs = mergeUnique(existingImgs, imgs);
    dataDoc.details.images = mergedImgs;

    // inventory qty
    const qty = sumStock(base.stock);
    if (!dataDoc.inventory) dataDoc.inventory = {};
    dataDoc.inventory.quantity = Math.max(Number(dataDoc.inventory.quantity) || 0, qty);

    // storage/bin (only set if none)
    const binCode = pickBin(base.locations);
    if (binCode) {
      // try to map quantity per same location key
      const locKeys = base.locations ? Object.keys(base.locations) : [];
      let locQty = dataDoc.inventory.quantity;
      if (locKeys.length) {
        const firstKey = locKeys[0];
        const locStock = Number(base.stock?.[firstKey]) || 0;
        if (locStock > 0) locQty = locStock;
      }
      const binMeta = await getBinMeta(binCode);
      const binPayload = {
        code: binCode,
        quantity: locQty,
        zone: binMeta?.zone,
        etage: binMeta?.etage,
        gang: binMeta?.gang,
        regal: binMeta?.regal,
        ebene: binMeta?.ebene,
        firstStoredAt: binMeta?.firstStoredAt || null,
        lastUpdatedAt: binMeta?.lastStoredAt || null,
      };
      if (!dataDoc.storage) {
        dataDoc.storage = {
          binCode,
          zone: binMeta?.zone,
          etage: binMeta?.etage,
          gang: binMeta?.gang,
          regal: binMeta?.regal,
          ebene: binMeta?.ebene,
          quantity: locQty,
          assigned_at: dataDoc.storage?.assigned_at || new Date().toISOString(),
        };
      }
      if (!Array.isArray(dataDoc.storageBins) || !dataDoc.storageBins.length) {
        dataDoc.storageBins = [binPayload];
      }
    }

    // ops baselinker meta
    dataDoc.ops = dataDoc.ops || {};
    dataDoc.ops.baselinker = {
      ...(dataDoc.ops.baselinker || {}),
      product_id: pid,
      category_id: data.category_id || null,
      manufacturer_id: data.manufacturer_id || null,
    };

    await saveProduct({
      ...dataDoc,
      id: dataDoc.id || sku || ean,
      identification: {
        ...(dataDoc.identification || {}),
        sku: dataDoc.identification?.sku || sku || ean,
      },
      details: dataDoc.details,
    });
    updated += 1;
  }

  console.log(
    JSON.stringify(
      { products: list.length, matched, created, updated, skipped },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
