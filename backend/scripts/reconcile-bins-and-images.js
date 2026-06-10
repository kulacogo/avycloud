/**
 * Rekonstruiert BIN-Zuordnungen aus warehouseBins und verlinkt generierte
 * Bilder aus improveJobs zurück in die Produktdatenblätter. Entfernt Dubletten
 * (gleiche SKU), indem Daten zusammengeführt werden.
 *
 * Usage:
 *   node backend/scripts/reconcile-bins-and-images.js
 */

const { firestore } = require('../lib/firestore');
const { getProductBinSummaryMap } = require('../lib/warehouse');
const { parseApplyArgs } = require('./_apply-guard');

function normSku(val) {
  return (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-_\s]*/, '');
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function loadProducts() {
  const snap = await firestore.collection('products').get();
  const byId = new Map();
  const bySku = new Map();
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const id = doc.id;
    const skuCandidates = [
      id,
      data.identification?.sku,
      data.details?.identifiers?.sku,
    ].filter(Boolean);
    skuCandidates.forEach((sku) => {
      const key = normSku(sku);
      if (!key) return;
      if (!bySku.has(key)) bySku.set(key, []);
      bySku.get(key).push(id);
    });
    byId.set(id, { id, ...data });
  });
  return { byId, bySku };
}

function choosePrimaryId(ids, skuKey) {
  if (!ids || !ids.length) return null;
  // Bevorzugt docId, die direkt dem SKU entspricht
  const exact = ids.find((id) => normSku(id) === skuKey);
  if (exact) return exact;
  return ids[0];
}

function mergeProducts(primary, duplicate) {
  const merged = JSON.parse(JSON.stringify(primary));
  const dupe = duplicate || {};

  merged.identification = merged.identification || {};
  merged.details = merged.details || {};
  merged.details.identifiers = merged.details.identifiers || {};
  merged.inventory = merged.inventory || {};
  merged.ops = merged.ops || {};

  // Name/Brand/Category
  if (!merged.identification.name && dupe.identification?.name) merged.identification.name = dupe.identification.name;
  if (!merged.identification.brand && dupe.identification?.brand) merged.identification.brand = dupe.identification.brand;
  if (!merged.identification.category && dupe.identification?.category) merged.identification.category = dupe.identification.category;

  // EAN/GTIN
  if (!merged.details.identifiers.ean && dupe.details?.identifiers?.ean) merged.details.identifiers.ean = dupe.details.identifiers.ean;
  if (!merged.details.identifiers.gtin && dupe.details?.identifiers?.gtin) merged.details.identifiers.gtin = dupe.details.identifiers.gtin;
  if (!Array.isArray(merged.identification.barcodes)) merged.identification.barcodes = [];
  if (Array.isArray(dupe.identification?.barcodes)) {
    merged.identification.barcodes.push(...dupe.identification.barcodes);
  }
  merged.identification.barcodes = Array.from(new Set(merged.identification.barcodes.filter(Boolean)));

  // Pricing: wenn primär fehlt, übernehme gültigen Preis
  const primaryPrice = merged.details?.pricing?.lowest_price;
  const primaryValid = primaryPrice && Number(primaryPrice.amount) > 0;
  const dupePrice = dupe.details?.pricing?.lowest_price;
  const dupeValid = dupePrice && Number(dupePrice.amount) > 0;
  if (!primaryValid && dupeValid) {
    merged.details.pricing = {
      lowest_price: {
        amount: Number(dupePrice.amount),
        currency: dupePrice.currency || 'EUR',
        sources: dupePrice.sources || [],
      },
      price_confidence: dupe.details?.pricing?.price_confidence || 1,
    };
  }

  // Images union (by URL)
  const toUrl = (img) =>
    (img && (img.url_or_base64 || img.url || img.downloadUrl || (typeof img === 'string' ? img : null))) || null;
  const images = [];
  if (Array.isArray(merged.details?.images)) images.push(...merged.details.images);
  if (Array.isArray(dupe.details?.images)) images.push(...dupe.details.images);
  merged.details.images = uniqBy(images, (img) => toUrl(img)).slice(0, 10);

  // Storage bins union
  const bins = [];
  if (Array.isArray(merged.storageBins)) bins.push(...merged.storageBins);
  if (Array.isArray(dupe.storageBins)) bins.push(...dupe.storageBins);
  merged.storageBins = uniqBy(
    bins.map((b) => ({
      ...b,
      code: b.code || b.binCode,
    })),
    (b) => b.code
  );

  // Inventory quantity: Summe (um Verlust zu vermeiden)
  const qtyA = Number(merged.inventory.quantity) || 0;
  const qtyB = Number(dupe.inventory?.quantity) || 0;
  merged.inventory.quantity = qtyA + qtyB;

  // Storage: wähle Bin mit höchster Menge
  const primaryBin = [...merged.storageBins].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))[0];
  if (primaryBin) {
    merged.storage = {
      binCode: primaryBin.code,
      zone: primaryBin.zone,
      etage: primaryBin.etage,
      gang: primaryBin.gang,
      regal: primaryBin.regal,
      ebene: primaryBin.ebene,
      quantity: primaryBin.quantity || merged.inventory.quantity || 0,
      assigned_at: merged.storage?.assigned_at || primaryBin.lastUpdatedAt || primaryBin.firstStoredAt || new Date().toISOString(),
    };
  }

  // Identity aliases union
  const aliases = new Set();
  (merged.ops.identity_aliases || []).forEach((x) => aliases.add(x));
  (dupe.ops?.identity_aliases || []).forEach((x) => aliases.add(x));
  merged.ops.identity_aliases = Array.from(aliases);

  return merged;
}

async function dedupeProducts(byId, bySku, apply) {
  let deduped = 0;
  for (const [skuKey, ids] of bySku.entries()) {
    if (ids.length <= 1) continue;
    const primaryId = choosePrimaryId(ids, skuKey);
    if (!primaryId) continue;
    const primary = byId.get(primaryId);
    if (!primary) continue;
    let merged = primary;
    for (const id of ids) {
      if (id === primaryId) continue;
      const dupe = byId.get(id);
      if (!dupe) continue;
      merged = mergeProducts(merged, dupe);
      if (apply) {
        await firestore.collection('products').doc(id).delete();
      } else {
        console.log('  [DRY-RUN] would delete duplicate product', id, '(merge into', primaryId + ')');
      }
      deduped += 1;
    }
    if (apply) {
      await firestore.collection('products').doc(primaryId).set(merged, { merge: true });
    } else {
      console.log('  [DRY-RUN] would merge into primary product', primaryId);
    }
    byId.set(primaryId, merged);
  }
  return deduped;
}

async function reconcileBins(byId, bySku, apply) {
  const skuToId = new Map();
  for (const [skuKey, ids] of bySku.entries()) {
    const primaryId = choosePrimaryId(ids, skuKey);
    if (primaryId) skuToId.set(skuKey, primaryId);
  }
  const binSummary = await getProductBinSummaryMap([], skuToId);
  let updated = 0;
  for (const [productId, summary] of binSummary.entries()) {
    const product = byId.get(productId);
    if (!product) continue;
    const bins = (summary.bins || []).map((b) => ({
      code: b.code,
      zone: b.zone,
      etage: b.etage,
      gang: b.gang,
      regal: b.regal,
      ebene: b.ebene,
      quantity: b.quantity || 0,
      firstStoredAt: b.firstStoredAt || null,
      lastUpdatedAt: b.lastUpdatedAt || null,
    }));
    const primaryBin = [...bins].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))[0];
    const storage =
      primaryBin &&
      primaryBin.quantity > 0
        ? {
            binCode: primaryBin.code,
            zone: primaryBin.zone,
            etage: primaryBin.etage,
            gang: primaryBin.gang,
            regal: primaryBin.regal,
            ebene: primaryBin.ebene,
            quantity: primaryBin.quantity,
            assigned_at: product.storage?.assigned_at || primaryBin.lastUpdatedAt || primaryBin.firstStoredAt || new Date().toISOString(),
          }
        : null;
    if (apply) {
      await firestore.collection('products').doc(productId).set(
        {
          storageBins: bins,
          storage,
          inventory: {
            ...(product.inventory || {}),
            quantity: summary.totalQuantity || 0,
          },
        },
        { merge: true }
      );
    } else {
      console.log('  [DRY-RUN] would update bins/storage for product', productId);
    }
    updated += 1;
  }
  return updated;
}

function extractSkuFromJob(job) {
  const candidates = [];
  candidates.push(job.productId);
  candidates.push(job.payload?.product?.identification?.sku);
  candidates.push(job.payload?.product?.details?.identifiers?.sku);
  candidates.push(job.payload?.product?.sku);
  candidates.push(job.payload?.sku);
  const key = candidates
    .map((x) => normSku(x))
    .find((x) => x);
  return key || null;
}

function normalizeImages(imgs = []) {
  const list = [];
  for (const img of imgs) {
    if (!img) continue;
    const url =
      (typeof img === 'string' && img) ||
      img.url_or_base64 ||
      img.url ||
      img.downloadUrl ||
      null;
    if (!url) continue;
    list.push({
      url_or_base64: url,
      source: img.source || 'improve',
    });
  }
  return list;
}

async function reconcileImages(byId, bySku, apply) {
  const skuToId = new Map();
  for (const [skuKey, ids] of bySku.entries()) {
    const primaryId = choosePrimaryId(ids, skuKey);
    if (primaryId) skuToId.set(skuKey, primaryId);
  }
  const snap = await firestore.collection('improveJobs').get();
  let updated = 0;
  snap.forEach((doc) => {
    const job = doc.data() || {};
    const imgsRaw = job?.result?.images;
    if (!Array.isArray(imgsRaw) || !imgsRaw.length) return;
    const skuKey = extractSkuFromJob(job);
    if (!skuKey) return;
    const productId = skuToId.get(skuKey);
    if (!productId) return;
    const product = byId.get(productId);
    if (!product) return;
    const existing = Array.isArray(product.details?.images) ? product.details.images : [];
    const merged = uniqBy([...existing, ...normalizeImages(imgsRaw)], (img) => img.url_or_base64).slice(0, 10);
    if (apply) {
      firestore.collection('products').doc(productId).set(
        {
          details: {
            ...(product.details || {}),
            images: merged,
          },
        },
        { merge: true }
      );
    } else {
      console.log('  [DRY-RUN] would relink', merged.length, 'images for product', productId);
    }
    updated += 1;
  });
  return updated;
}

async function main() {
  const { apply } = parseApplyArgs();

  console.log('Lade Produkte …');
  const { byId, bySku } = await loadProducts();

  console.log('Dedupliziere Produkte mit gleicher SKU …');
  const deduped = await dedupeProducts(byId, bySku, apply);

  console.log('Rekonstruiere BIN-Zuordnungen aus warehouseBins …');
  const binsUpdated = await reconcileBins(byId, bySku, apply);

  console.log('Verknüpfe Improve-Job-Bilder zurück in Produkte …');
  const imagesUpdated = await reconcileImages(byId, bySku, apply);

  console.log(
    JSON.stringify(
      { deduped, binsUpdated, imagesUpdated },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
