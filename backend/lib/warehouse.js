const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { getProduct, adjustPendingIntakeQuantity } = require('./firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const ZONES = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ', 'P'];
const ETAGEN = ['GA', 'UG', 'EG'];
const MIN_GANG = 1;
const MAX_GANG = 10;
const MIN_REGAL = 1;
const MAX_REGAL = 15;
const MIN_EBENE = 'A'.charCodeAt(0);
const MAX_EBENE = 'G'.charCodeAt(0);

const zonesCollection = firestore.collection('warehouseZones');
const binsCollection = firestore.collection('warehouseBins');
const _whUseV2Raw = (process.env.USE_PRODUCTS_V2 || '').toString().trim().toLowerCase();
const _whUseV2 = _whUseV2Raw === '1' || _whUseV2Raw === 'true' || _whUseV2Raw === 'yes' || _whUseV2Raw === 'on';
const PRODUCTS_COLL_NAME = _whUseV2 ? 'products_v2' : 'products';
const PRODUCTS_LEGACY_COLL_NAME = _whUseV2 ? 'products' : 'products_v2';
const productsCollection = firestore.collection(PRODUCTS_COLL_NAME);
const productsLegacyCollection = firestore.collection(PRODUCTS_LEGACY_COLL_NAME);
const warehouseEventsCollection = firestore.collection('warehouseEvents');

function writeWarehouseEventTx(tx, payload = {}) {
  const ref = warehouseEventsCollection.doc();
  tx.set(ref, {
    ...payload,
    createdAt: Timestamp.now(),
  });
}

// Rebuild inventory summary (total quantity and primary BIN)
async function refreshProductInventory(productId) {
  if (!productId) return;
  const resolvedId = String(productId).trim();
  if (!resolvedId) return;

  // IMPORTANT: never create a new product doc as a side-effect of inventory refresh.
  // If callers pass SKU/EAN instead of the Firestore doc id, a set({merge:true}) would silently create
  // an "empty" product document containing only inventory/storageBins, which then breaks UI and indexing.
  const docRef = productsCollection.doc(resolvedId);
  const snap = await docRef.get();
  if (!snap.exists) {
    console.warn(
      `[refreshProductInventory] skip: product '${resolvedId}' not found (would create stub doc)`
    );
    return;
  }

  const productData = snap.data() || {};

  // Build comprehensive keySet from product data using central function
  const keySet = buildProductKeySet(productData);
  keySet.add(normalizeKey(resolvedId));

  const snapshot = await binsCollection.get();
  const bins = [];
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const products = Array.isArray(data.products) ? data.products : [];
    const matches = products.filter((p) => binEntryMatchesKeySet(p, keySet));

    const quantity = matches.reduce((sum, entry) => sum + (Number(entry?.quantity) || 0), 0);
    if (!quantity) return;

    // Prefer timestamps from matched entries; fallback to bin-level timestamps
    const firstStoredAt =
      matches
        .map((m) => toIsoString(m?.firstStoredAt))
        .filter(Boolean)
        .sort()[0] ||
      toIsoString(data.firstStoredAt) ||
      null;
    const lastUpdatedAt =
      matches
        .map((m) => toIsoString(m?.lastUpdatedAt))
        .filter(Boolean)
        .sort()
        .slice(-1)[0] ||
      toIsoString(data.lastStoredAt) ||
      null;
    const first = matches[0] || {};

    bins.push({
      code: data.code || doc.id,
      zone: data.zone,
      etage: data.etage,
      gang: data.gang,
      regal: data.regal,
      ebene: data.ebene,
      quantity,
      productCount: quantity,
      productId: first.productId,
      sku: first.sku,
      name: first.name,
      firstStoredAt,
      lastUpdatedAt,
    });
  });

  const totalQty = bins.reduce((sum, b) => sum + (b.quantity || 0), 0);
  const sorted = [...bins].sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
  const primary = sorted[0] || null;

  const storageBins = bins.map((b) => ({
    code: b.code,
    quantity: b.quantity || 0,
    zone: b.zone,
    etage: b.etage,
    gang: b.gang,
    regal: b.regal,
    ebene: b.ebene,
    firstStoredAt: b.firstStoredAt || null,
    lastUpdatedAt: b.lastUpdatedAt || null,
  }));

  const storage =
    primary
      ? {
      binCode: primary.code,
      zone: primary.zone,
      etage: primary.etage,
      gang: primary.gang,
      regal: primary.regal,
      ebene: primary.ebene,
      quantity: primary.quantity || 0,
      assigned_at: primary.lastUpdatedAt || primary.firstStoredAt || new Date().toISOString(),
        }
      : null;

  // Use update() to avoid creating documents by mistake, and update inventory.quantity as a field path
  // so we don't overwrite other inventory metadata (inventoryId, inventoryName, etc.).
  await docRef.update({
    'inventory.quantity': totalQty,
    storageBins,
    storage,
  });

  // Dual-write: keep legacy collection in sync (best-effort)
  try {
    const legacyRef = productsLegacyCollection.doc(resolvedId);
    const legacySnap = await legacyRef.get();
    if (legacySnap.exists) {
      await legacyRef.update({
        'inventory.quantity': totalQty,
        storageBins,
        storage,
      });
    }
  } catch (e) {
    console.warn(`[refreshProductInventory] Dual-write to ${PRODUCTS_LEGACY_COLL_NAME} failed for ${resolvedId}:`, e.message);
  }
}

async function findProductDocument({ productId, sku, barcode }) {
  if (productId) {
    const ref = productsCollection.doc(productId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Produkt nicht gefunden.');
    return { ref, data: snap.data() };
  }

  const queries = [];
  if (sku) {
    const normalizedSku = sku.trim();
    queries.push({ field: 'identification.sku', op: '==', value: normalizedSku });
    queries.push({ field: 'details.identifiers.sku', op: '==', value: normalizedSku });
  }
  if (barcode) {
    const normalizedBarcode = barcode.trim();
    queries.push({ field: 'details.identifiers.ean', op: '==', value: normalizedBarcode });
    queries.push({ field: 'details.identifiers.gtin', op: '==', value: normalizedBarcode });
    queries.push({ field: 'details.identifiers.upc', op: '==', value: normalizedBarcode });
    queries.push({ field: 'identification.barcodes', op: 'array-contains', value: normalizedBarcode });
  }

  for (const query of queries) {
    let snap;
    if (query.op === 'array-contains') {
      snap = await productsCollection.where(query.field, 'array-contains', query.value).limit(1).get();
    } else {
      snap = await productsCollection.where(query.field, '==', query.value).limit(1).get();
    }
    if (!snap.empty) {
      const doc = snap.docs[0];
      return { ref: doc.ref, data: doc.data() };
    }
  }

  throw new Error('Kein Produkt mit dieser Kennung gefunden.');
}

const buildBinCode = (zone, etage, gang, regal, ebene) => {
  const gangCode = String(gang).padStart(2, '0');
  const regalCode = String(regal).padStart(2, '0');
  return `${zone}${etage}${gangCode}${regalCode}${ebene}`;
};

function parseNumericSelection(input, min, max) {
  if (!input) throw new Error(`Bitte einen Wertebereich zwischen ${min} und ${max} angeben.`);
  const trimmed = String(input).trim();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (value < min || value > max) throw new Error(`Wert ${value} muss zwischen ${min} und ${max} liegen.`);
    return [value];
  }
  if (/^\d+\s*-\s*\d+$/.test(trimmed)) {
    const [startStr, endStr] = trimmed.split('-').map((x) => Number(x.trim()));
    if (isNaN(startStr) || isNaN(endStr)) throw new Error('Ungültiger Bereich.');
    if (startStr > endStr) throw new Error('Startwert darf nicht größer als Endwert sein.');
    if (startStr < min || endStr > max) throw new Error(`Bereich muss zwischen ${min} und ${max} liegen.`);
    const result = [];
    for (let i = startStr; i <= endStr; i += 1) {
      result.push(i);
    }
    return result;
  }
  throw new Error('Bitte eine einzelne Zahl oder einen Bereich im Format "Start-Ende" angeben.');
}

function parseLetterSelection(input, minChar = 'A', maxChar = 'E') {
  if (!input) throw new Error(`Bitte Buchstaben zwischen ${minChar} und ${maxChar} angeben.`);
  const trimmed = String(input).trim().toUpperCase();
  if (/^[A-Z]$/.test(trimmed)) {
    const code = trimmed.charCodeAt(0);
    if (code < minChar.charCodeAt(0) || code > maxChar.charCodeAt(0)) {
      throw new Error(`Buchstabe muss zwischen ${minChar} und ${maxChar} liegen.`);
    }
    return [trimmed];
  }
  if (/^[A-Z]\s*-\s*[A-Z]$/.test(trimmed)) {
    const [startStr, endStr] = trimmed.split('-').map((x) => x.trim().toUpperCase());
    const startCode = startStr.charCodeAt(0);
    const endCode = endStr.charCodeAt(0);
    if (startCode > endCode) throw new Error('Startbuchstabe darf nicht größer sein als Endbuchstabe.');
    if (startCode < MIN_EBENE || endCode > MAX_EBENE) {
      throw new Error(`Bereich muss zwischen ${minChar} und ${maxChar} liegen.`);
    }
    const result = [];
    for (let code = startCode; code <= endCode; code += 1) {
      result.push(String.fromCharCode(code));
    }
    return result;
  }
  throw new Error('Bitte einen Buchstaben oder einen Bereich im Format "A-E" angeben.');
}

/**
 * Create palette bins with sequential numbering (P-zone special logic).
 * Format: P{ETAGE}{NNN} e.g. PGA001, PGA002, ...
 */
async function createPaletteBins(etage, count) {
  if (!ETAGEN.includes(etage)) throw new Error(`Ungültige Etage. Erlaubt sind ${ETAGEN.join(', ')}.`);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error('Bitte eine Anzahl zwischen 1 und 100 für neue Paletten angeben.');
  }

  // Find the highest existing palette number for this etage
  // Use simple where('zone') only — avoids composite index requirement (FAILED_PRECONDITION).
  // Filter etage + find max paletteNumber client-side (palette count is always small).
  const prefix = `P${etage}`;
  const existing = await binsCollection
    .where('zone', '==', 'P')
    .get();

  let startNumber = 1;
  let maxNum = 0;
  existing.docs.forEach((doc) => {
    const d = doc.data() || {};
    if (d.etage === etage && typeof d.paletteNumber === 'number' && d.paletteNumber > maxNum) {
      maxNum = d.paletteNumber;
    }
  });
  if (maxNum > 0) startNumber = maxNum + 1;

  const combinations = [];
  for (let i = 0; i < count; i++) {
    const num = startNumber + i;
    const code = `${prefix}${String(num).padStart(3, '0')}`;
    combinations.push({
      code,
      zone: 'P',
      etage,
      gang: 0,
      regal: 0,
      ebene: '-',
      paletteNumber: num,
      createdAt: Timestamp.now(),
      productCount: 0,
      products: [],
      firstStoredAt: null,
      lastStoredAt: null,
    });
  }

  const chunkSize = 400;
  for (let i = 0; i < combinations.length; i += chunkSize) {
    const batch = firestore.batch();
    const slice = combinations.slice(i, i + chunkSize);
    slice.forEach((bin) => {
      batch.set(binsCollection.doc(bin.code), bin, { merge: true });
    });
    await batch.commit();
  }

  // Update or create zone doc
  const zoneDocRef = zonesCollection.doc(`P_${etage}`);
  const zoneSnap = await zoneDocRef.get();
  const prevCount = zoneSnap.exists ? (zoneSnap.data().binCount || 0) : 0;

  await zoneDocRef.set(
    {
      zone: 'P',
      etage,
      gangs: [],
      regale: [],
      ebenen: [],
      isPalette: true,
      binCount: prevCount + count,
      createdAt: Timestamp.now(),
    },
    { merge: true }
  );

  return { zone: 'P', etage, binCount: count, totalBins: prevCount + count, startNumber, endNumber: startNumber + count - 1 };
}

async function createWarehouseLayout({ zone, etage, gangRange, regalRange, ebeneRange }) {
  if (!ZONES.includes(zone)) throw new Error(`Ungültige Zone. Erlaubt sind ${ZONES.join(', ')}.`);
  if (!ETAGEN.includes(etage)) throw new Error(`Ungültige Etage. Erlaubt sind ${ETAGEN.join(', ')}.`);

  // Zone P = Palette: gangRange is count of palettes, regale/ebene ignored
  if (zone === 'P') {
    const count = parseInt(gangRange, 10);
    return createPaletteBins(etage, count);
  }

  const gangs = parseNumericSelection(gangRange, MIN_GANG, MAX_GANG);
  const regale = parseNumericSelection(regalRange, MIN_REGAL, MAX_REGAL);
  const ebenen = parseLetterSelection(ebeneRange);

  const combinations = [];
  gangs.forEach((gang) => {
    regale.forEach((regal) => {
      ebenen.forEach((ebene) => {
        const code = buildBinCode(zone, etage, gang, regal, ebene);
        combinations.push({
          code,
          zone,
          etage,
          gang,
          regal,
          ebene,
          createdAt: Timestamp.now(),
          productCount: 0,
          products: [],
          firstStoredAt: null,
          lastStoredAt: null,
        });
      });
    });
  });

  const chunkSize = 400;
  for (let i = 0; i < combinations.length; i += chunkSize) {
    const batch = firestore.batch();
    const slice = combinations.slice(i, i + chunkSize);
    slice.forEach((bin) => {
      const ref = binsCollection.doc(bin.code);
      batch.set(
        ref,
        {
          zone: bin.zone,
          etage: bin.etage,
          gang: bin.gang,
          regal: bin.regal,
          ebene: bin.ebene,
          createdAt: bin.createdAt,
          productCount: bin.productCount,
          products: bin.products,
          firstStoredAt: bin.firstStoredAt,
          lastStoredAt: bin.lastStoredAt,
        },
        { merge: true }
      );
    });
    await batch.commit();
  }

  await zonesCollection.doc(`${zone}_${etage}`).set(
    {
      zone,
      etage,
      gangs,
      regale,
      ebenen,
      binCount: combinations.length,
      createdAt: Timestamp.now(),
    },
    { merge: true }
  );

  return { zone, etage, gangs, regale, ebenen, binCount: combinations.length };
}

async function listWarehouseZones() {
  const snapshot = await zonesCollection.get();
  const layouts = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const binsSnap = await binsCollection
      .where('zone', '==', data.zone)
      .where('etage', '==', data.etage)
      .get();
    const totalProducts = binsSnap.docs.reduce((sum, b) => sum + (b.get('productCount') || 0), 0);
    layouts.push({
      id: doc.id,
      zone: data.zone,
      etage: data.etage,
      gangs: data.gangs || [],
      regale: data.regale || [],
      ebenen: data.ebenen || [],
      binCount: data.binCount || binsSnap.size,
      createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
      totalProducts,
    });
  }
  return layouts;
}

async function getBinsForZone(zone, etage) {
  const snapshot = await binsCollection.where('zone', '==', zone).where('etage', '==', etage).get();
  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      code: doc.id,
      zone: data.zone,
      etage: data.etage,
      gang: data.gang,
      regal: data.regal,
      ebene: data.ebene,
      productCount: data.productCount || 0,
      createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
      firstStoredAt: data.firstStoredAt ? data.firstStoredAt.toDate().toISOString() : null,
      lastStoredAt: data.lastStoredAt ? data.lastStoredAt.toDate().toISOString() : null,
    };
  });
}

async function getBinByCode(binCode) {
  const doc = await binsCollection.doc(binCode).get();
  if (!doc.exists) {
    return null;
  }
  const data = doc.data();
  const result = {
    code: doc.id,
    ...data,
    createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    firstStoredAt: data.firstStoredAt ? data.firstStoredAt.toDate().toISOString() : null,
    lastStoredAt: data.lastStoredAt ? data.lastStoredAt.toDate().toISOString() : null,
  };

  // If this BIN has children, load them and attach aggregated info
  const childCodes = Array.isArray(data.childBinCodes) ? data.childBinCodes : [];
  if (childCodes.length > 0) {
    const childSnap = await binsCollection.where('parentBinCode', '==', binCode).get();
    const children = childSnap.docs
      .map((d) => {
        const cd = d.data();
        return {
          code: d.id,
          containerIndex: cd.containerIndex,
          productCount: cd.productCount || 0,
          products: Array.isArray(cd.products) ? cd.products : [],
          createdAt: cd.createdAt ? cd.createdAt.toDate().toISOString() : null,
          firstStoredAt: toIsoString(cd.firstStoredAt),
          lastStoredAt: toIsoString(cd.lastStoredAt),
        };
      })
      .sort((a, b) => (a.containerIndex || 0) - (b.containerIndex || 0));
    result.children = children;
    result.childrenProductCount = children.reduce((sum, c) => sum + (c.productCount || 0), 0);
  }

  return result;
}

async function removeProductFromBin(binCode, productId, options = {}) {
  const binRef = binsCollection.doc(binCode);
  const productRef = productsCollection.doc(productId);
  await firestore.runTransaction(async (tx) => {
    const [binSnap, productSnap] = await Promise.all([tx.get(binRef), tx.get(productRef)]);
    if (!binSnap.exists) {
      throw new Error('BIN nicht gefunden.');
    }
    if (!productSnap.exists) {
      throw new Error('Produkt nicht gefunden.');
    }

    const binData = binSnap.data();
    const productData = productSnap.data();
    const products = Array.isArray(binData.products) ? [...binData.products] : [];
    // Build comprehensive keySet from product data for robust matching
    const keySet = buildProductKeySet(productData);
    keySet.add(normalizeKey(productId));
    const matches = (p) => binEntryMatchesKeySet(p, keySet);
    const updatedProducts = products.filter((p) => !matches(p));
    const removedEntries = products.filter((p) => matches(p));
    const removedQty = removedEntries.reduce((sum, p) => sum + Number(p.quantity || 0), 0);
    const productCount = updatedProducts.reduce((sum, item) => sum + (item.quantity || 0), 0);
    tx.update(binRef, {
      products: updatedProducts,
      productCount,
      lastStoredAt: Timestamp.now(),
    });
    writeWarehouseEventTx(tx, {
      type: 'bin_remove_product',
      binCode,
      productId: String(productId),
      removedQty,
      remainingBinProductCount: productCount,
      skipProductUpdate: Boolean(options.skipProductUpdate),
    });
    if (!options.skipProductUpdate) {
      const shouldClearStorage = productData?.storage?.binCode === binCode;
      const updatedStorageBins = Array.isArray(productData?.storageBins)
        ? productData.storageBins.filter((b) => String(b.code || '').trim() !== String(binCode).trim())
        : [];
      const remainingQuantity = Math.max(
        0,
        (productData?.inventory?.quantity || 0) - removedQty
      );
      tx.update(productRef, {
        storage: shouldClearStorage ? null : productData.storage || null,
        storageBins: updatedStorageBins,
        inventory: {
          ...(productData?.inventory || {}),
          quantity: remainingQuantity,
        },
      });
    }
  });

  await refreshProductInventory(productId);
}

/**
 * Decrement product quantity by productId/SKU when an order is closed (no explicit BIN info).
 * Strategy:
 *  - Reduce storageBins quantities first, then inventory.quantity.
 *  - Remove empty bin entries; clear storage if primary bin disappears.
 *  - Keep warehouseBins collection consistent for touched bins.
 */
async function decrementProductByIdOrSku(productIdOrSku, quantity) {
  if (!quantity || quantity <= 0) return;
  const id = String(productIdOrSku).trim();
  let productRef = productsCollection.doc(id);
  let productSnap = await productRef.get();
  if (!productSnap.exists) {
    try {
      const { ref } = await findProductDocument({ productId: null, sku: id, barcode: id });
      productRef = ref;
      productSnap = await ref.get();
    } catch (e) {
      // CRITICAL: Do NOT silently return. Throwing ensures the caller knows stock was NOT decremented,
      // so it can log a failure and the oversell-prevention system can intervene.
      const msg = `[decrementProductByIdOrSku] CRITICAL: product not found for '${id}' — stock NOT decremented`;
      console.error(msg);
      throw new Error(msg);
    }
  }
  const productData = productSnap.data() || {};
  let remaining = Number(quantity) || 0;
  const bins = Array.isArray(productData.storageBins) ? [...productData.storageBins] : [];
  const binDeltas = [];

  for (const b of bins) {
    if (!b?.code || remaining <= 0) continue;
    const current = Number(b.quantity || 0);
    if (current <= 0) continue;
    const take = Math.min(current, remaining);
    b.quantity = current - take;
    remaining -= take;
    binDeltas.push({ code: String(b.code).trim(), delta: -take });
  }

  const cleanedBins = bins.filter((b) => Number(b.quantity || 0) > 0);
  // Correct inventory calculation: always subtract the FULL requested quantity from inventory,
  // not just the leftover `remaining` (which would be 0 if bins covered everything).
  // refreshProductInventory() will re-derive from bins afterwards, but within the transaction
  // window we need inventory.quantity to reflect the actual decrement.
  const invQty = Number(productData.inventory?.quantity || 0);
  const newInv = Math.max(0, invQty - (Number(quantity) || 0));

  let newStorage = productData.storage || null;
  if (newStorage?.binCode && !cleanedBins.find((b) => String(b.code).trim() === String(newStorage.binCode).trim())) {
    newStorage = null;
  }

  await firestore.runTransaction(async (tx) => {
    // Alle Reads vor Writes: hole Bin-Snapshots vor Updates
    const binSnapshots = [];
    for (const delta of binDeltas) {
      const binRef = binsCollection.doc(delta.code);
      const binSnap = await tx.get(binRef);
      binSnapshots.push({ binRef, binSnap, delta });
    }

    tx.update(productRef, {
      storageBins: cleanedBins,
      storage: newStorage,
      inventory: {
        ...(productData.inventory || {}),
        quantity: newInv,
      },
    });
    writeWarehouseEventTx(tx, {
      type: 'order_decrement',
      productId: productRef.id,
      productKey: id,
      requestedQty: Number(quantity) || 0,
      appliedBinDeltas: binDeltas,
      inventoryAfter: newInv,
      binCountAfter: cleanedBins.length,
    });

    for (const { binRef, binSnap, delta } of binSnapshots) {
      if (!binSnap.exists) continue;
      const binData = binSnap.data() || {};
      const products = Array.isArray(binData.products) ? [...binData.products] : [];
      const match = (p) =>
        p &&
        (String(p.productId || '').trim() === id ||
          String(p.sku || '').trim() === id ||
          String(p.sku || '').trim() === String(productData.identification?.sku || '').trim());
      const updated = [];
      for (const entry of products) {
        if (!match(entry)) {
          updated.push(entry);
          continue;
        }
        const nextQty = Math.max(0, Number(entry.quantity || 0) + delta.delta);
        if (nextQty > 0) {
          updated.push({ ...entry, quantity: nextQty, lastUpdatedAt: new Date().toISOString() });
        }
      }
      const productCount = updated.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      tx.update(binRef, { products: updated, productCount, lastStoredAt: Timestamp.now() });
    }
  });

  await refreshProductInventory(productRef.id);
}

async function assignProductToBin(binCode, productId, quantity) {
  if (!quantity || quantity <= 0) {
    throw new Error('Menge muss größer als 0 sein.');
  }
  const product = await getProduct(productId);
  if (!product) {
    throw new Error('Produkt nicht gefunden.');
  }

  const binRef = binsCollection.doc(binCode);
  const productRef = productsCollection.doc(productId);
  const now = Timestamp.now();
  let previousBinQty = 0;

  // Build comprehensive keySet from product data for robust matching
  const keySet = buildProductKeySet(product);
  keySet.add(normalizeKey(productId));

  await firestore.runTransaction(async (tx) => {
    const binSnap = await tx.get(binRef);
    if (!binSnap.exists) {
      throw new Error('BIN nicht gefunden.');
    }
    const binData = binSnap.data();
    const products = Array.isArray(binData.products) ? [...binData.products] : [];
    let entry = products.find((p) => binEntryMatchesKeySet(p, keySet));
    if (entry) {
      previousBinQty = Number(entry.quantity || 0) || 0;
      entry.quantity = quantity;
      entry.lastUpdatedAt = now.toDate().toISOString();
      if (!entry.firstStoredAt) entry.firstStoredAt = now.toDate().toISOString();
    } else {
      entry = {
        productId,
        name: product.identification?.name || product.id,
        sku: product.details?.identifiers?.sku || product.id,
        quantity,
        firstStoredAt: now.toDate().toISOString(),
        lastUpdatedAt: now.toDate().toISOString(),
        image: product.details?.images?.[0]?.url_or_base64 || null,
      };
      products.push(entry);
    }
    const productCount = products.reduce((sum, item) => sum + (item.quantity || 0), 0);
    tx.update(binRef, {
      products,
      productCount,
      firstStoredAt: binData.firstStoredAt || now,
      lastStoredAt: now,
    });
    writeWarehouseEventTx(tx, {
      type: 'bin_assign_product',
        binCode,
      productId: String(productId),
      quantity: Number(quantity) || 0,
      mode: 'set',
    });
  });

  await refreshProductInventory(productId);
  const intakeDelta = Math.max(0, Number(quantity) - Number(previousBinQty || 0));
  if (intakeDelta > 0) {
    try {
      await adjustPendingIntakeQuantity(productId, -intakeDelta);
    } catch (error) {
      console.warn(`Failed to decrement pending intake for ${productId}:`, error);
    }
  }
  return getBinByCode(binCode);
}

function cloneProductsArray(binData) {
  return Array.isArray(binData.products) ? binData.products.map((entry) => ({ ...entry })) : [];
}

function calculateBinProductCount(products) {
  return products.reduce((sum, item) => sum + (item.quantity || 0), 0);
}

async function bookStockIn({ productId, sku, barcode, binCode, quantity, meta }) {
  if (!binCode) throw new Error('Bin-Code fehlt.');
  if (!quantity || quantity <= 0) throw new Error('Menge muss größer als 0 sein.');

  const { ref: productRef } = await findProductDocument({ productId, sku, barcode });
  const binRef = binsCollection.doc(binCode);
  const now = Timestamp.now();
  let updatedProduct = null;
  let updatedBin = null;

  let resolvedProductId = null;

  await firestore.runTransaction(async (tx) => {
    const [productSnap, binSnap] = await Promise.all([tx.get(productRef), tx.get(binRef)]);
    if (!productSnap.exists) throw new Error('Produkt nicht gefunden.');
    if (!binSnap.exists) throw new Error('BIN nicht gefunden.');

    const productData = productSnap.data();
    const binData = binSnap.data();
    const products = cloneProductsArray(binData);
    resolvedProductId = productData.id || productRef.id;
    const nowIso = now.toDate().toISOString();

    // Consistency check: if parent has children, warn if same product exists in a child
    const parentChildCodes = Array.isArray(binData.childBinCodes) ? binData.childBinCodes : [];
    if (parentChildCodes.length > 0) {
      const keySetCheck = buildProductKeySet(productData);
      keySetCheck.add(normalizeKey(resolvedProductId));
      keySetCheck.add(normalizeKey(productRef.id));
      for (const childCode of parentChildCodes) {
        const childSnap = await tx.get(binsCollection.doc(childCode));
        if (!childSnap.exists) continue;
        const childProducts = Array.isArray(childSnap.data().products) ? childSnap.data().products : [];
        const inChild = childProducts.some((p) => binEntryMatchesKeySet(p, keySetCheck) && Number(p.quantity || 0) > 0);
        if (inChild) {
          throw new Error(`Produkt liegt bereits in Behälter ${childCode}. Bitte dort einlagern oder zuerst entfernen.`);
        }
      }
    }

    // Build comprehensive keySet for robust duplicate detection
    const keySet = buildProductKeySet(productData);
    keySet.add(normalizeKey(resolvedProductId));
    keySet.add(normalizeKey(productRef.id));
    let entry = products.find((p) => binEntryMatchesKeySet(p, keySet));
    if (entry) {
      // Stock-in is additive, regardless of whether this BIN is currently the product's primary location.
      entry.quantity = (Number(entry.quantity) || 0) + quantity;
      entry.firstStoredAt = entry.firstStoredAt || nowIso;
      entry.lastUpdatedAt = nowIso;
    } else {
      entry = {
        productId: resolvedProductId,
        name: productData.identification?.name || resolvedProductId,
        sku: productData.details?.identifiers?.sku || resolvedProductId,
        quantity,
        firstStoredAt: nowIso,
        lastUpdatedAt: nowIso,
        image: productData.details?.images?.[0]?.url_or_base64 || null,
      };
      products.push(entry);
    }

    const productCount = calculateBinProductCount(products);
    tx.update(binRef, {
      products,
      productCount,
      firstStoredAt: binData.firstStoredAt || now,
      lastStoredAt: now,
    });

    const storageQuantity = entry.quantity;
    const inventoryQuantity =
      productData.storage?.binCode && productData.storage.binCode !== binCode
        ? (productData.inventory?.quantity || 0) + quantity
        : storageQuantity;
    // Keep existing storage if Produkt liegt bereits in anderem BIN, um den ersten Standort nicht zu überschreiben
    const storagePayload =
      productData.storage && productData.storage.binCode && productData.storage.binCode !== binCode
        ? productData.storage
        : {
          binCode,
          zone: binData.zone,
          etage: binData.etage,
          gang: binData.gang,
          regal: binData.regal,
          ebene: binData.ebene,
          quantity: storageQuantity,
          assigned_at: productData.storage?.assigned_at || nowIso,
        };

    const currentPending = Number(productData?.ops?.pending_intake_quantity) || 0;
    const nextPending = Math.max(0, currentPending - quantity);
    tx.update(productRef, {
      storage: storagePayload,
      inventory: {
        ...(productData.inventory || {}),
        quantity: inventoryQuantity,
      },
      'ops.pending_intake_quantity': nextPending,
    });
    writeWarehouseEventTx(tx, {
      type: 'stock_in',
      binCode,
      productId: resolvedProductId,
      sku: productData.details?.identifiers?.sku || productData.identification?.sku || null,
      delta: Number(quantity) || 0,
      quantityAfter: inventoryQuantity,
      binQuantityAfter: entry.quantity,
      meta: meta || null,
    });

    updatedProduct = {
      ...productData,
      id: resolvedProductId,
      ops: {
        ...(productData.ops || {}),
        pending_intake_quantity: nextPending,
      },
      storage: storagePayload,
      inventory: {
        ...(productData.inventory || {}),
        quantity: inventoryQuantity,
      },
    };

    updatedBin = {
      code: binCode,
      ...binData,
      products,
      productCount,
      firstStoredAt: (binData.firstStoredAt || now).toDate ? (binData.firstStoredAt || now).toDate().toISOString() : binData.firstStoredAt,
      lastStoredAt: nowIso,
    };
  });

  await refreshProductInventory(productRef.id);
  const freshProduct = await getProduct(productRef.id);
  return { product: freshProduct || updatedProduct, bin: updatedBin };
}

async function bookStockOut({ productId, sku, barcode, binCode, quantity, meta }) {
  if (!binCode) throw new Error('Bin-Code fehlt.');
  if (!quantity || quantity <= 0) throw new Error('Menge muss größer als 0 sein.');

  const { ref: productRef } = await findProductDocument({ productId, sku, barcode });
  const binRef = binsCollection.doc(binCode);
  const now = Timestamp.now();
  let updatedProduct = null;
  let updatedBin = null;
  let resolvedProductId = null;

  await firestore.runTransaction(async (tx) => {
    const [productSnap, binSnap] = await Promise.all([tx.get(productRef), tx.get(binRef)]);
    if (!productSnap.exists) throw new Error('Produkt nicht gefunden.');
    if (!binSnap.exists) throw new Error('BIN nicht gefunden.');

    const productData = productSnap.data();
    const binData = binSnap.data();
    const products = cloneProductsArray(binData);
    resolvedProductId = productData.id || productRef.id;
    let entry = products.find((p) => p.productId === resolvedProductId);
    if (!entry) {
      // Fallback: match per SKU aus Produktdaten
      const skuCandidate =
        (productData.details?.identifiers?.sku ||
          productData.identification?.sku ||
          '').toString().trim();
      if (skuCandidate) {
        const normalized = skuCandidate.replace(/^sku[-_\s]*/i, '');
        entry = products.find(
          (p) =>
            p.productId === skuCandidate ||
            p.productId === normalized ||
            p.sku === skuCandidate ||
            p.sku === normalized
        );
      }
    }
    if (!entry) throw new Error('Produkt befindet sich nicht in diesem BIN.');

    if (entry.quantity < quantity) {
      throw new Error('Nicht genügend Bestand im BIN.');
    }

    entry.quantity -= quantity;
    entry.lastUpdatedAt = now.toDate().toISOString();

    let newProducts = products;
    let storagePayload = null;
    if (entry.quantity <= 0) {
      newProducts = products.filter((p) => p.productId !== resolvedProductId);
      tx.update(productRef, {
        storage: null,
        inventory: { ...(productData.inventory || {}), quantity: 0 },
      });
      updatedProduct = {
        ...productData,
        id: resolvedProductId,
        storage: null,
        inventory: { ...(productData.inventory || {}), quantity: 0 },
      };
    } else {
      storagePayload = {
        binCode,
        zone: binData.zone,
        etage: binData.etage,
        gang: binData.gang,
        regal: binData.regal,
        ebene: binData.ebene,
        quantity: entry.quantity,
        assigned_at: productData.storage?.assigned_at || now.toDate().toISOString(),
      };
      tx.update(productRef, {
        storage: storagePayload,
        inventory: {
          ...(productData.inventory || {}),
          quantity: entry.quantity,
        },
      });
      updatedProduct = {
        ...productData,
        id: resolvedProductId,
        storage: storagePayload,
        inventory: {
          ...(productData.inventory || {}),
          quantity: entry.quantity,
        },
      };
    }

    const productCount = calculateBinProductCount(newProducts);
    tx.update(binRef, {
      products: newProducts,
      productCount,
      lastStoredAt: now,
    });
    writeWarehouseEventTx(tx, {
      type: 'stock_out',
      binCode,
      productId: resolvedProductId,
      sku: productData.details?.identifiers?.sku || productData.identification?.sku || null,
      delta: -(Number(quantity) || 0),
      quantityAfter: entry.quantity <= 0 ? 0 : entry.quantity,
      binProductCountAfter: productCount,
      meta: meta || null,
    });

    updatedBin = {
      code: binCode,
      ...binData,
      products: newProducts,
      productCount,
      lastStoredAt: now.toDate().toISOString(),
    };
  });

  await refreshProductInventory(productRef.id);
  const freshProduct = await getProduct(productRef.id);
  return { product: freshProduct || updatedProduct, bin: updatedBin };
}

async function listBinsForProduct(productIdOrSku) {
  if (!productIdOrSku) throw new Error('Produkt-ID oder SKU fehlt.');

  // Build comprehensive keySet using central function
  const raw = String(productIdOrSku).trim();
  const keySet = buildProductKeySet(raw);

  // Load product document to enrich keySet with ALL identifiers (SKU, EAN, etc.)
  const productRef = productsCollection.doc(raw);
  const productSnap = await productRef.get();
  if (productSnap.exists) {
    const productData = productSnap.data() || {};
    const dataKeySet = buildProductKeySet(productData);
    dataKeySet.forEach((k) => keySet.add(k));
  }

  const snapshot = await binsCollection.get();
  const matches = [];

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const products = Array.isArray(data.products) ? data.products : [];
    const hits = products.filter((p) => binEntryMatchesKeySet(p, keySet));
    const quantity = hits.reduce((sum, entry) => sum + (Number(entry?.quantity) || 0), 0);
    if (quantity > 0) {
      const first = hits[0] || {};
      const firstStoredAt =
        hits
          .map((m) => toIsoString(m?.firstStoredAt))
          .filter(Boolean)
          .sort()[0] ||
        toIsoString(data.firstStoredAt) ||
        null;
      const lastUpdatedAt =
        hits
          .map((m) => toIsoString(m?.lastUpdatedAt))
          .filter(Boolean)
          .sort()
          .slice(-1)[0] ||
        toIsoString(data.lastStoredAt) ||
        null;
      matches.push({
        code: data.code || doc.id,
        zone: data.zone,
        etage: data.etage,
        gang: data.gang,
        regal: data.regal,
        ebene: data.ebene,
        quantity,
        productCount: quantity,
        productId: first.productId,
        sku: first.sku,
        name: first.name,
        firstStoredAt,
        lastUpdatedAt,
      });
    }
  });

  return matches;
}

function normalizeKey(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.toLowerCase() : null;
}

function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/**
 * Baut ein umfassendes Set von normalisierten Keys für Product-Matching.
 * Wird von ALLEN Warehouse-Funktionen genutzt die Produkte in BINs suchen.
 * @param {string|object} productIdOrData - Firestore docId (string) oder Produkt-Daten (object)
 * @returns {Set<string>} Normalisierte Keys (lowercase, SKU-Varianten)
 */
function buildProductKeySet(productIdOrData) {
  const keySet = new Set();
  const addKey = (value) => {
    const normalized = normalizeKey(value);
    if (normalized) keySet.add(normalized);
  };
  const addSkuVariants = (value) => {
    if (!value) return;
    const raw = String(value).trim();
    addKey(raw);
    const stripped = raw.replace(/^sku[-_\s]*/i, '');
    addKey(stripped);
    if (stripped) addKey(`sku-${stripped}`);
  };

  if (typeof productIdOrData === 'string') {
    addKey(productIdOrData);
    addSkuVariants(productIdOrData);
  }

  if (typeof productIdOrData === 'object' && productIdOrData) {
    addKey(productIdOrData.id);
    addSkuVariants(productIdOrData?.identification?.sku);
    addSkuVariants(productIdOrData?.details?.identifiers?.sku);
    addKey(productIdOrData?.details?.identifiers?.ean);
    addKey(productIdOrData?.details?.identifiers?.gtin);
    addKey(productIdOrData?.details?.identifiers?.upc);
    const barcodes = Array.isArray(productIdOrData?.identification?.barcodes)
      ? productIdOrData.identification.barcodes : [];
    barcodes.forEach((b) => addKey(b));
  }

  return keySet;
}

/**
 * Prüft ob ein Bin-Entry (p) zu einem keySet passt.
 * @param {object} p - Bin products[] Entry mit .productId und .sku
 * @param {Set<string>} keySet - Von buildProductKeySet() erzeugt
 * @returns {boolean}
 */
function binEntryMatchesKeySet(p, keySet) {
  if (!p) return false;
  const pid = normalizeKey(p.productId);
  const sku = normalizeKey(p.sku);
  const pidStripped = pid ? pid.replace(/^sku[-_\s]*/i, '') : null;
  const skuStripped = sku ? sku.replace(/^sku[-_\s]*/i, '') : null;
  return (
    (pid && keySet.has(pid)) ||
    (sku && keySet.has(sku)) ||
    (pidStripped && keySet.has(pidStripped)) ||
    (skuStripped && keySet.has(skuStripped))
  );
}

async function getProductBinSummaryMap(productIds = [], skuToProductIdMap = new Map()) {
  const filterSet =
    Array.isArray(productIds) && productIds.length
      ? new Set(productIds.map((id) => (id == null ? null : String(id))))
      : null;

  const snapshot = await binsCollection.get();
  const summaries = new Map();

  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const binCode = doc.id;
    const products = Array.isArray(data.products) ? data.products : [];

    products.forEach((entry) => {
      const quantity = Number(entry?.quantity) || 0;
      if (!quantity) return;

      let targetId = entry?.productId ? String(entry.productId) : null;
      if (entry?.sku && skuToProductIdMap && skuToProductIdMap.size) {
        const rawSku = String(entry.sku).trim();
        const normalizedSku = normalizeKey(entry.sku);
        if (rawSku && skuToProductIdMap.has(rawSku)) {
          targetId = skuToProductIdMap.get(rawSku);
        } else if (normalizedSku && skuToProductIdMap.has(normalizedSku)) {
          targetId = skuToProductIdMap.get(normalizedSku);
        } else {
          const trimmed = rawSku.replace(/^sku[-_\\s]*/i, '');
          if (trimmed && skuToProductIdMap.has(trimmed)) {
            targetId = skuToProductIdMap.get(trimmed);
          }
        }
      }

      if (!targetId) return;
      if (filterSet && !filterSet.has(targetId)) return;

      if (!summaries.has(targetId)) {
        summaries.set(targetId, { totalQuantity: 0, bins: [] });
      }
      const summary = summaries.get(targetId);
      summary.totalQuantity += quantity;
      summary.bins.push({
        code: binCode,
        zone: data.zone,
        etage: data.etage,
        gang: data.gang,
        regal: data.regal,
        ebene: data.ebene,
        quantity,
        firstStoredAt: entry.firstStoredAt || toIsoString(data.firstStoredAt) || null,
        lastUpdatedAt: entry.lastUpdatedAt || toIsoString(data.lastStoredAt) || null,
      });
    });
  });

  return summaries;
}

async function recomputeWarehouseZoneLayout(zone, etage) {
  if (!zone || !etage) {
    throw new Error('Zone und Etage sind erforderlich.');
  }
  const zoneKey = String(zone).toUpperCase();
  const etageKey = String(etage).toUpperCase();
  const docId = `${zoneKey}_${etageKey}`;

  const snapshot = await binsCollection.where('zone', '==', zoneKey).where('etage', '==', etageKey).get();
  const gangs = new Set();
  const regale = new Set();
  const ebenen = new Set();
  let totalProducts = 0;
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    if (typeof data.gang === 'number') gangs.add(data.gang);
    if (typeof data.regal === 'number') regale.add(data.regal);
    if (data.ebene) ebenen.add(String(data.ebene).toUpperCase());
    totalProducts += Number(data.productCount || 0) || 0;
  });

  const layoutPatch = {
    zone: zoneKey,
    etage: etageKey,
    gangs: Array.from(gangs).sort((a, b) => a - b),
    regale: Array.from(regale).sort((a, b) => a - b),
    ebenen: Array.from(ebenen).sort(),
    binCount: snapshot.size,
    totalProducts,
    updatedAt: Timestamp.now(),
  };

  await zonesCollection.doc(docId).set(layoutPatch, { merge: true });
  return layoutPatch;
}

function buildBinsQueryForFilter({ zone, etage, gang, regal, ebene }) {
  if (!zone || !etage) throw new Error('Zone und Etage sind erforderlich.');
  let query = binsCollection.where('zone', '==', String(zone).toUpperCase()).where('etage', '==', String(etage).toUpperCase());
  if (gang !== undefined && gang !== null) {
    query = query.where('gang', '==', Number(gang));
  }
  if (regal !== undefined && regal !== null) {
    query = query.where('regal', '==', Number(regal));
  }
  if (ebene !== undefined && ebene !== null) {
    query = query.where('ebene', '==', String(ebene).toUpperCase());
  }
  return query;
}

async function deleteWarehouseBinsByFilter(filter, { dryRun = false } = {}) {
  const query = buildBinsQueryForFilter(filter);
  const snapshot = await query.get();
  const bins = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  if (!bins.length) {
    return { deleted: 0, binCodes: [], layout: await recomputeWarehouseZoneLayout(filter.zone, filter.etage) };
  }

  // Collect child-BINs of matched parents
  const childBins = [];
  for (const { data } of bins) {
    const childCodes = Array.isArray(data.childBinCodes) ? data.childBinCodes : [];
    for (const cc of childCodes) {
      if (!bins.some((b) => b.id === cc)) {
        const childSnap = await binsCollection.doc(cc).get();
        if (childSnap.exists) {
          childBins.push({ id: cc, data: childSnap.data() || {} });
        }
      }
    }
  }
  const allBins = [...bins, ...childBins];

  const nonEmpty = allBins
    .filter(({ data }) => {
      const count = Number(data.productCount || 0) || 0;
      const products = Array.isArray(data.products) ? data.products : [];
      return count > 0 || products.some((p) => Number(p.quantity || 0) > 0);
    })
    .slice(0, 10)
    .map(({ id, data }) => ({ code: id, productCount: Number(data.productCount || 0) || 0 }));

  if (nonEmpty.length) {
    throw new Error(
      `Kann nicht löschen: ${nonEmpty.length} BIN(s) sind nicht leer (z.B. ${nonEmpty
        .map((b) => `${b.code}:${b.productCount}`)
        .join(', ')}). Bitte zuerst auslagern/entfernen.`
    );
  }

  const binCodes = allBins.map((b) => b.id);
  if (dryRun) {
    return { deleted: 0, binCodes, layout: null, dryRun: true };
  }

  // Firestore batch writes: max 500 operations per batch (official docs).
  const chunkSize = 450;
  for (let i = 0; i < allBins.length; i += chunkSize) {
    const batch = firestore.batch();
    const slice = allBins.slice(i, i + chunkSize);
    slice.forEach(({ id }) => {
      batch.delete(binsCollection.doc(id));
    });
    await batch.commit();
  }

  const layout = await recomputeWarehouseZoneLayout(filter.zone, filter.etage);
  try {
    await warehouseEventsCollection.add({
      type: 'layout_delete',
      filter,
      deletedBins: binCodes.length,
      createdAt: Timestamp.now(),
    });
  } catch {
    // best-effort
  }

  return { deleted: binCodes.length, binCodes, layout };
}

// ── Child-BIN (Container) Functions ──────────────────────────────────

async function createChildBin(parentBinCode, options = {}) {
  const code = String(parentBinCode || '').trim().toUpperCase();
  if (!code) throw new Error('Parent-BIN-Code fehlt.');

  return firestore.runTransaction(async (tx) => {
    const parentRef = binsCollection.doc(code);
    const parentSnap = await tx.get(parentRef);
    if (!parentSnap.exists) throw new Error('Parent-BIN nicht gefunden.');

    const parentData = parentSnap.data();
    if (parentData.isContainer) {
      throw new Error('Ein Behälter kann keine weiteren Behälter enthalten.');
    }

    const existing = Array.isArray(parentData.childBinCodes) ? parentData.childBinCodes : [];
    // Find next free index (1-99)
    const usedIndices = new Set(existing.map((c) => {
      const suffix = c.slice(code.length);
      return parseInt(suffix, 10);
    }).filter((n) => !isNaN(n)));

    let nextIndex = 1;
    while (usedIndices.has(nextIndex) && nextIndex <= 99) nextIndex++;
    if (nextIndex > 99) throw new Error('Maximale Anzahl an Behältern (99) erreicht.');

    const childCode = `${code}${String(nextIndex).padStart(2, '0')}`;
    const childRef = binsCollection.doc(childCode);

    const childDoc = {
      code: childCode,
      zone: parentData.zone,
      etage: parentData.etage,
      gang: parentData.gang,
      regal: parentData.regal,
      ebene: parentData.ebene,
      parentBinCode: code,
      isContainer: true,
      containerIndex: nextIndex,
      createdAt: Timestamp.now(),
      productCount: 0,
      products: [],
      firstStoredAt: null,
      lastStoredAt: null,
    };

    tx.set(childRef, childDoc);
    tx.update(parentRef, {
      childBinCodes: [...existing, childCode],
    });

    writeWarehouseEventTx(tx, {
      type: 'child_bin_created',
      parentBinCode: code,
      childBinCode: childCode,
      containerIndex: nextIndex,
    });

    return {
      ...childDoc,
      createdAt: childDoc.createdAt.toDate().toISOString(),
    };
  });
}

async function deleteChildBin(childBinCode) {
  const code = String(childBinCode || '').trim().toUpperCase();
  if (!code) throw new Error('Child-BIN-Code fehlt.');

  return firestore.runTransaction(async (tx) => {
    const childRef = binsCollection.doc(code);
    const childSnap = await tx.get(childRef);
    if (!childSnap.exists) throw new Error('Behälter nicht gefunden.');

    const childData = childSnap.data();
    if (!childData.isContainer || !childData.parentBinCode) {
      throw new Error('Diese BIN ist kein Behälter.');
    }

    // Check if empty
    const products = Array.isArray(childData.products) ? childData.products : [];
    const hasStock = products.some((p) => Number(p.quantity || 0) > 0);
    if (hasStock) {
      throw new Error('Behälter ist nicht leer. Bitte zuerst alle Produkte entfernen.');
    }

    const parentRef = binsCollection.doc(childData.parentBinCode);
    const parentSnap = await tx.get(parentRef);

    tx.delete(childRef);

    if (parentSnap.exists) {
      const parentData = parentSnap.data();
      const updatedCodes = (Array.isArray(parentData.childBinCodes) ? parentData.childBinCodes : [])
        .filter((c) => c !== code);
      tx.update(parentRef, { childBinCodes: updatedCodes });
    }

    writeWarehouseEventTx(tx, {
      type: 'child_bin_deleted',
      parentBinCode: childData.parentBinCode,
      childBinCode: code,
    });

    return { deleted: true, parentBinCode: childData.parentBinCode };
  });
}

async function listChildBins(parentBinCode) {
  const code = String(parentBinCode || '').trim().toUpperCase();
  if (!code) throw new Error('Parent-BIN-Code fehlt.');

  const snapshot = await binsCollection.where('parentBinCode', '==', code).get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        code: doc.id,
        containerIndex: data.containerIndex,
        parentBinCode: data.parentBinCode,
        isContainer: true,
        zone: data.zone,
        etage: data.etage,
        gang: data.gang,
        regal: data.regal,
        ebene: data.ebene,
        productCount: data.productCount || 0,
        products: Array.isArray(data.products) ? data.products : [],
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        firstStoredAt: toIsoString(data.firstStoredAt),
        lastStoredAt: toIsoString(data.lastStoredAt),
      };
    })
    .sort((a, b) => (a.containerIndex || 0) - (b.containerIndex || 0));
}

async function deleteWarehouseGang(zone, etage, gang, opts = {}) {
  return deleteWarehouseBinsByFilter({ zone, etage, gang }, opts);
}

async function deleteWarehouseRegal(zone, etage, gang, regal, opts = {}) {
  return deleteWarehouseBinsByFilter({ zone, etage, gang, regal }, opts);
}

async function deleteWarehouseEbene(zone, etage, gang, regal, ebene, opts = {}) {
  return deleteWarehouseBinsByFilter({ zone, etage, gang, regal, ebene }, opts);
}

module.exports = {
  createWarehouseLayout,
  listWarehouseZones,
  getBinsForZone,
  getBinByCode,
  assignProductToBin,
  removeProductFromBin,
  decrementProductByIdOrSku,
  refreshProductInventory,
  findProductDocument,
  buildBinCode,
  parseNumericSelection,
  parseLetterSelection,
  bookStockIn,
  bookStockOut,
  listBinsForProduct,
  getProductBinSummaryMap,
  recomputeWarehouseZoneLayout,
  deleteWarehouseBinsByFilter,
  deleteWarehouseGang,
  deleteWarehouseRegal,
  deleteWarehouseEbene,
  // Child-BIN (Container) functions
  createChildBin,
  deleteChildBin,
  listChildBins,
  // Exported for testing
  buildProductKeySet,
  binEntryMatchesKeySet,
  normalizeKey,
};
