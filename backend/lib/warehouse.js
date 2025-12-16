const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { getProduct, adjustPendingIntakeQuantity } = require('./firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const ZONES = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ'];
const ETAGEN = ['GA', 'UG', 'EG'];
const MIN_GANG = 1;
const MAX_GANG = 6;
const MIN_REGAL = 1;
const MAX_REGAL = 6;
const MIN_EBENE = 'A'.charCodeAt(0);
const MAX_EBENE = 'E'.charCodeAt(0);

const zonesCollection = firestore.collection('warehouseZones');
const binsCollection = firestore.collection('warehouseBins');
const productsCollection = firestore.collection('products');

// Rebuild inventory summary (total quantity and primary BIN)
async function refreshProductInventory(productId) {
  if (!productId) return;
  const bins = await listBinsForProduct(productId);
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

  const updatePayload = {
    inventory: { quantity: totalQty },
    storageBins,
  };
  if (primary) {
    updatePayload.storage = {
      binCode: primary.code,
      zone: primary.zone,
      etage: primary.etage,
      gang: primary.gang,
      regal: primary.regal,
      ebene: primary.ebene,
      quantity: primary.quantity || 0,
      assigned_at: primary.lastUpdatedAt || primary.firstStoredAt || new Date().toISOString(),
    };
  } else {
    updatePayload.storage = null;
  }

  await productsCollection.doc(productId).set(updatePayload, { merge: true });
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

async function createWarehouseLayout({ zone, etage, gangRange, regalRange, ebeneRange }) {
  if (!ZONES.includes(zone)) throw new Error(`Ungültige Zone. Erlaubt sind ${ZONES.join(', ')}.`);
  if (!ETAGEN.includes(etage)) throw new Error(`Ungültige Etage. Erlaubt sind ${ETAGEN.join(', ')}.`);

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
  return {
    code: doc.id,
    ...data,
    createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    firstStoredAt: data.firstStoredAt ? data.firstStoredAt.toDate().toISOString() : null,
    lastStoredAt: data.lastStoredAt ? data.lastStoredAt.toDate().toISOString() : null,
  };
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
    const products = Array.isArray(binData.products) ? [...binData.products] : [];
    const updatedProducts = products.filter((p) => p.productId !== productId);
    const removedEntry = products.find((p) => p.productId === productId);
    const productCount = updatedProducts.reduce((sum, item) => sum + (item.quantity || 0), 0);
    tx.update(binRef, {
      products: updatedProducts,
      productCount,
      lastStoredAt: Timestamp.now(),
    });
    if (!options.skipProductUpdate) {
      const productData = productSnap.data();
      const shouldClearStorage = productData?.storage?.binCode === binCode;
      const remainingQuantity = Math.max(
        0,
        (productData?.inventory?.quantity || 0) - (removedEntry?.quantity || 0)
      );
      tx.update(productRef, {
        storage: shouldClearStorage ? null : productData.storage || null,
        inventory: {
          ...(productData?.inventory || {}),
          quantity: remainingQuantity,
        },
      });
    }
  });

  await refreshProductInventory(productId);
}

async function assignProductToBin(binCode, productId, quantity) {
  if (!quantity || quantity <= 0) {
    throw new Error('Menge muss größer als 0 sein.');
  }
  const product = await getProduct(productId);
  if (!product) {
    throw new Error('Produkt nicht gefunden.');
  }

  if (product.storage?.binCode && product.storage.binCode !== binCode) {
    await removeProductFromBin(product.storage.binCode, productId, { skipProductUpdate: true });
  }

  const binRef = binsCollection.doc(binCode);
  const productRef = productsCollection.doc(productId);
  const now = Timestamp.now();

  await firestore.runTransaction(async (tx) => {
    const binSnap = await tx.get(binRef);
    if (!binSnap.exists) {
      throw new Error('BIN nicht gefunden.');
    }
    const binData = binSnap.data();
    const products = Array.isArray(binData.products) ? [...binData.products] : [];
    let entry = products.find((p) => p.productId === productId);
    if (entry) {
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

    tx.update(productRef, {
      storage: {
        binCode,
        zone: binData.zone,
        etage: binData.etage,
        gang: binData.gang,
        regal: binData.regal,
        ebene: binData.ebene,
        quantity,
        assigned_at: now.toDate().toISOString(),
      },
      inventory: {
        ...(product.inventory || {}),
        quantity,
      },
    });
  });

  await refreshProductInventory(productId);
  const previousQuantity =
    product.storage?.binCode === binCode ? Number(product.storage?.quantity) || 0 : 0;
  const intakeDelta = Math.max(0, Number(quantity) - previousQuantity);
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

async function bookStockIn({ productId, sku, barcode, binCode, quantity }) {
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

    let entry = products.find((p) => p.productId === resolvedProductId);
    if (entry && productData.storage?.binCode !== binCode) {
      entry.quantity = quantity;
      entry.firstStoredAt = entry.firstStoredAt || nowIso;
      entry.lastUpdatedAt = nowIso;
    } else if (entry) {
      entry.quantity = (entry.quantity || 0) + quantity;
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

  await refreshProductInventory(resolvedProductId);
  const freshProduct = await getProduct(resolvedProductId);
  return { product: freshProduct || updatedProduct, bin: updatedBin };
}

async function bookStockOut({ productId, sku, barcode, binCode, quantity }) {
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

    updatedBin = {
      code: binCode,
      ...binData,
      products: newProducts,
      productCount,
      lastStoredAt: now.toDate().toISOString(),
    };
  });

  await refreshProductInventory(resolvedProductId);
  const freshProduct = await getProduct(resolvedProductId);
  return { product: freshProduct || updatedProduct, bin: updatedBin };
}

async function listBinsForProduct(productIdOrSku) {
  if (!productIdOrSku) throw new Error('Produkt-ID oder SKU fehlt.');
  const snapshot = await binsCollection.get();
  const matches = [];

  snapshot.forEach((doc) => {
    const data = doc.data();
    const products = Array.isArray(data.products) ? data.products : [];
    const hit = products.find(
      (p) =>
        p?.productId === productIdOrSku ||
        p?.sku === productIdOrSku ||
        p?.productId === String(productIdOrSku) ||
        p?.sku === String(productIdOrSku)
    );
    if (hit && (hit.quantity || 0) > 0) {
      matches.push({
        code: data.code || doc.id,
        zone: data.zone,
        etage: data.etage,
        gang: data.gang,
        regal: data.regal,
        ebene: data.ebene,
        quantity: hit.quantity || 0,
        productCount: hit.quantity || 0,
        productId: hit.productId,
        sku: hit.sku,
        name: hit.name,
        firstStoredAt: hit.firstStoredAt || data.firstStoredAt || null,
        lastUpdatedAt: hit.lastUpdatedAt || data.lastStoredAt || null,
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

module.exports = {
  createWarehouseLayout,
  listWarehouseZones,
  getBinsForZone,
  getBinByCode,
  assignProductToBin,
  removeProductFromBin,
  refreshProductInventory,
  findProductDocument,
  buildBinCode,
  parseNumericSelection,
  parseLetterSelection,
  bookStockIn,
  bookStockOut,
  listBinsForProduct,
  getProductBinSummaryMap,
};
