const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { getProduct } = require('./firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const ZONES = ['X', 'XS', 'S', 'M', 'L', 'XL'];
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
    const binSnap = await tx.get(binRef);
    if (!binSnap.exists) {
      throw new Error('BIN nicht gefunden.');
    }
    const binData = binSnap.data();
    const products = Array.isArray(binData.products) ? [...binData.products] : [];
    const updatedProducts = products.filter((p) => p.productId !== productId);
    const productCount = updatedProducts.reduce((sum, item) => sum + (item.quantity || 0), 0);
    tx.update(binRef, {
      products: updatedProducts,
      productCount,
      lastStoredAt: Timestamp.now(),
    });
    if (!options.skipProductUpdate) {
      tx.update(productRef, {
        storage: null,
      });
    }
  });
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

  return getBinByCode(binCode);
}

module.exports = {
  createWarehouseLayout,
  listWarehouseZones,
  getBinsForZone,
  getBinByCode,
  assignProductToBin,
  removeProductFromBin,
  buildBinCode,
  parseNumericSelection,
  parseLetterSelection,
};

