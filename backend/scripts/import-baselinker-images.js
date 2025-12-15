/**
 * Holt Produktbilder aus BaseLinker (inventory_id=78659) und verlinkt sie
 * in Firestore-Produkte (Match per SKU, Fallback EAN/barcodes).
 *
 * Usage:
 *   BASELINKER_INVENTORY_ID=78659 node backend/scripts/import-baselinker-images.js
 */

const { callBaseLinker } = require('../lib/baselinker');
const { firestore, findProductByStrictIdentifier, saveProduct } = require('../lib/firestore');

const INVENTORY_ID = Number(process.env.BASELINKER_INVENTORY_ID || 78659);

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
  const chunk = 50;
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

function mergeImages(existing = [], incoming = []) {
  const seen = new Set();
  const out = [];
  const add = (img) => {
    if (!img || !img.url_or_base64) return;
    const key = img.url_or_base64;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(img);
  };
  existing.forEach(add);
  incoming.forEach(add);
  return out.slice(0, 10);
}

async function main() {
  console.log(`Lade BaseLinker-Produkte (inventory ${INVENTORY_ID}) …`);
  const list = await listProducts(INVENTORY_ID);
  console.log(`Produkte gelistet: ${list.length}`);

  const ids = list.map((p) => p.product_id || p.id).filter(Boolean);
  const dataMap = await fetchData(ids);

  let matched = 0;
  let updated = 0;
  let skipped = 0;

  for (const base of list) {
    const pid = base.product_id || base.id;
    const data = dataMap[pid] || {};
    const imgs = normalizeImages(data.images);
    if (!imgs.length) {
      skipped += 1;
      continue;
    }

    const sku = (data.sku || base.sku || '').toString().trim();
    const ean = (data.ean || base.ean || '').toString().trim();

    let docRef = null;
    if (sku) {
      const snap = await firestore.collection('products').doc(sku).get();
      if (snap.exists) {
        docRef = snap;
      }
    }
    if (!docRef && (sku || ean)) {
      const hit = await findProductByStrictIdentifier({
        sku: sku || null,
        barcodes: ean ? [ean] : [],
      });
      if (hit) {
        docRef = await firestore.collection('products').doc(hit.id).get();
      }
    }

    if (!docRef || !docRef.exists) {
      skipped += 1;
      continue;
    }

    matched += 1;
    const dataDoc = docRef.data() || {};
    const existing = Array.isArray(dataDoc.details?.images) ? dataDoc.details.images : [];
    const merged = mergeImages(existing, imgs);
    if (merged.length === existing.length) {
      continue;
    }

    await saveProduct({
      ...dataDoc,
      id: docRef.id,
      details: {
        ...(dataDoc.details || {}),
        images: merged,
      },
    });
    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        products: list.length,
        matched,
        updated,
        skipped,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
