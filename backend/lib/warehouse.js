const { Firestore, Timestamp } = require('@google-cloud/firestore');
const { getProduct, adjustPendingIntakeQuantity } = require('./firestore');

const firestore = new Firestore({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud',
});

const ZONES = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ'];
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
// Idempotenz-Claims fuer den Bestandseingang (additiv, eigene Collection).
// Doc-ID = deterministischer Hash (siehe buildStockInClaimIds) → die Existenz
// des Docs IST der Beweis, dass die Buchung schon lief. Firestore statt
// Prozessspeicher: es laufen mehrere Cloud-Run-Instanzen (web + worker),
// in-memory waere wirkungslos.
const STOCK_IN_CLAIMS_COLLECTION = 'stock_in_claims';
const stockInClaimsCollection = firestore.collection(STOCK_IN_CLAIMS_COLLECTION);

// Dedup-Fenster fuer Clients OHNE Request-Id (Alt-Clients).
// 30 s ist bewusst gewaehlt: die belegten Doppel-Buchungen vom 05.06.2026 lagen
// zwischen 1 s und 56 s auseinander, die Dreifach-Buchung (SKU-3280641599)
// innerhalb von 10 s. Ein weiteres Fenster wuerde legitime Mehrfach-Einlagerung
// desselben Artikels blockieren (Paletten-Durchgang). Der Paletten-Takt lag bei
// 8–10 s pro VERSCHIEDENER SKU — verschiedene SKUs haben verschiedene
// Claim-Schluessel und sind vom Fenster nie betroffen. Gleiche SKU + gleicher
// BIN + gleiche Menge + gleicher Mitarbeiter innerhalb von 30 s ist genau die
// pathologische Signatur der Doppel-Absendung.
// 5 s statt 30 s. Begruendung (Abnahme 2026-07-30): das Fenster ist der UNSCHARFE
// Mechanismus — es kann eine LEGITIME zweite Buchung verschlucken, naemlich zwei gleiche
// Kartons derselben SKU in denselben Platz. Auf dem Desktop bleiben SKU und Lagerplatz
// nach dem Buchen stehen; der zweite Karton ist in ~4 s gebucht und faellt bei 30 s
// mitten ins Fenster -> Bestandsverlust. Die scharfe Absicherung ist die Request-Id,
// die der Client pro Einlager-Absicht mitsendet. 5 s deckt weiter das gesamte technische
// Doppelfeuer ab (gemessene Faelle: 1, 1, 2 s) und laesst legitime Wiederholungen durch.
// Die menschliche Wiederholung nach 44-59 s faengt jetzt die sichtbare Quittung im UI,
// nicht mehr das Fenster.
const STOCK_IN_DEDUP_DEFAULT_WINDOW_SECONDS = 5;

// Notbremse: STOCK_IN_DEDUP='off' schaltet Schluessel- UND Fenster-Pruefung ab
// (exakt das Verhalten von vor dem Fix), falls der Betrieb feststellt, dass
// legitime Buchungen blockiert werden. Default 'on' — reine Fehlerverhinderung.
function stockInDedupEnabled() {
  const raw = String(process.env.STOCK_IN_DEDUP ?? 'on').trim().toLowerCase();
  return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}

// Optionaler Ops-Knopf, Default = STOCK_IN_DEDUP_DEFAULT_WINDOW_SECONDS.
// 0 = Fenster aus (die Request-Id-Pruefung bleibt aktiv).
function stockInDedupWindowMs() {
  const raw = process.env.STOCK_IN_DEDUP_WINDOW_SECONDS;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
  }
  return STOCK_IN_DEDUP_DEFAULT_WINDOW_SECONDS * 1000;
}

// Mitarbeiter-Kennung fuer den Fenster-Schluessel. Fehlt der Actor (Script,
// Alt-Client), faellt alles auf denselben Bucket 'anon' — konservativ, aber
// genau das ist beim Doppelklick-Schutz gewuenscht.
function normalizeStockInActorKey(meta) {
  const actor = meta && meta.actor;
  if (!actor) return 'anon';
  if (typeof actor === 'string') return actor.trim().toLowerCase() || 'anon';
  const value = actor.uid || actor.email || '';
  return String(value).trim().toLowerCase() || 'anon';
}

function normalizeStockInRequestId(meta) {
  const raw = meta && (meta.requestId || meta.idempotencyKey);
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  return value.slice(0, 256);
}

/**
 * Deterministische Claim-Doc-IDs fuer eine Einlagerung.
 *   requestClaimId : nur wenn der Client eine Request-Id mitsendet — exakte
 *                    Einmal-Semantik, unabhaengig vom Zeitabstand.
 *   windowClaimId  : Kombination (tenant + Produkt + BIN + Menge + Actor) ohne
 *                    Zeit. Das Doc traegt `lastAtMs`; das Fenster wird gegen
 *                    diesen Zeitstempel geprueft (kein Bucket-Randproblem).
 * Nutzt `buildMovementEventId` aus lib/stock-core.js (bestehender, getesteter
 * Hash-Helfer) — kein zweites Hash-Schema im Repo.
 */
function buildStockInClaimIds({ tenantId = 'default', requestId = null, productKey, binCode, quantity, actorKey = 'anon' }) {
  const { buildMovementEventId } = require('./stock-core');
  const tenant = tenantId || 'default';
  const ids = { requestClaimId: null, windowClaimId: null };
  if (requestId) {
    ids.requestClaimId = buildMovementEventId({ tenantId: tenant, idempotencyKey: `stock-in:request:${requestId}` });
  }
  ids.windowClaimId = buildMovementEventId({
    tenantId: tenant,
    idempotencyKey: `stock-in:window:${productKey}|${String(binCode || '').toUpperCase()}|${Number(quantity) || 0}|${actorKey}`,
  });
  return ids;
}

// Claim-Zeitstempel robust in Millisekunden (Timestamp | ISO-String | Zahl).
function claimTimeToMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value.toMillis === 'function') {
    try { return value.toMillis(); } catch (_) { /* fallthrough */ }
  }
  if (typeof value.toDate === 'function') {
    try {
      const d = value.toDate();
      return d && typeof d.getTime === 'function' ? d.getTime() : null;
    } catch (_) { /* fallthrough */ }
  }
  if (value.seconds !== undefined && Number.isFinite(Number(value.seconds))) {
    return Number(value.seconds) * 1000;
  }
  return null;
}

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

  // WP3 cutover (flag STOCK_LEDGER, default OFF): source the authoritative
  // quantity from the LEDGER (Σ warehouseEvents) instead of from bins — bins
  // remain only the layout source (storageBins/storage). This is THE single
  // writer of inventory.quantity, so gating it here cuts the whole projection
  // over to the ledger. Fail-safe: a ledger read error falls back to the
  // bins-derived total (never blocks the refresh).
  let effectiveQty = totalQty;
  let qtySource = 'bins';
  try {
    const { stockLedgerEnabled, sumProductLedger } = require('./stock-core');
    if (stockLedgerEnabled()) {
      effectiveQty = await sumProductLedger({ productId: resolvedId, firestore });
      qtySource = 'ledger';
    }
  } catch (err) {
    console.warn(`[refreshProductInventory] ledger source failed for ${resolvedId}, falling back to bins: ${err.message}`);
    effectiveQty = totalQty;
    qtySource = 'bins-fallback';
  }

  // Use update() to avoid creating documents by mistake, and update inventory.quantity as a field path
  // so we don't overwrite other inventory metadata (inventoryId, inventoryName, etc.).
  const priorQty = productData?.inventory?.quantity;
  await docRef.update({
    'inventory.quantity': effectiveQty,
    'inventory.quantitySource': qtySource,
    storageBins,
    storage,
  });

  // Stock-Change-Notify: emit stock:changed + append inventory_ledger, wenn Qty sich aenderte.
  // Siehe CLAUDE.md Punkt 10 (Oversell-Verbot) und Plan P2.3 + P2.4.
  if (priorQty !== undefined && priorQty !== null && Number(priorQty) !== Number(effectiveQty)) {
    try {
      const { notifyStockChange } = require('./stock-change-events');
      await notifyStockChange({
        tenantId: productData.tenantId || 'default',
        productId: resolvedId,
        sku: productData.identification?.sku || productData.details?.identifiers?.sku || null,
        before: Number(priorQty),
        after: Number(effectiveQty),
        reason: 'warehouse-refresh',
        source: 'warehouse.refreshProductInventory',
      });
    } catch (err) {
      console.warn(`[refreshProductInventory] stock-change-notify failed for ${resolvedId}: ${err.message}`);
    }
  }

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
  const invQty = Number(productData.inventory?.quantity || 0);
  const newInv = Math.max(0, invQty - (Number(quantity) || 0));

  // Defensive no-op (CLAUDE.md Punkt 13): wenn bereits inventar=0 und keine Bins,
  // dann ist hier nichts mehr zu decrementieren. Wir schreiben trotzdem ein
  // warehouseEvent, damit der Aufruf nicht spurlos verschwindet, aber wir mutieren
  // weder Produkt noch Bins. Dies kann legitim auftreten, wenn `bookStockOut`
  // mit `meta.orderId` bereits per Pick-Pfad alles dekrementiert hat und
  // `_onOrderShipped` faelschlicherweise erneut Phase A ausfuehrt (defense in depth).
  if (invQty <= 0 && bins.length === 0) {
    console.warn(
      `[decrementProductByIdOrSku] no-op for productId=${productRef.id} — inventory.quantity already 0 and no bins. Possible duplicate decrement attempt; no mutation performed.`
    );
    return;
  }

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

  // Telemetrie: inventory_ledger-Eintrag (CLAUDE.md Punkt 10/13).
  if (Number(invQty) !== Number(newInv)) {
    try {
      const { notifyStockChange } = require('./stock-change-events');
      const skuValue =
        productData.identification?.sku ||
        productData.details?.identifiers?.sku ||
        (typeof productIdOrSku === 'string' && /^SKU/i.test(productIdOrSku) ? productIdOrSku : null);
      await notifyStockChange({
        tenantId: productData.tenantId || 'default',
        productId: productRef.id,
        sku: skuValue,
        before: Number(invQty),
        after: Number(newInv),
        reason: 'ship-decrement',
        source: 'warehouse.decrementProductByIdOrSku',
      });
    } catch (err) {
      console.warn(
        `[decrementProductByIdOrSku] notifyStockChange failed productId=${productRef.id}: ${err.message}`
      );
    }
  }
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

/**
 * bookStockIn — physischer Bestandseingang (Einlagern).
 *
 * IDEMPOTENZ (Incident 05.06.2026: 16 SKUs / 18 Doppel-Paare / 30 Phantom-
 * Einheiten, u. a. SKU-3280641599 dreifach in 10 s). Zwei Netze, beide IN der
 * bestehenden Firestore-Transaktion geprueft UND gesetzt — sonst bleibt ein
 * Zeitfenster fuer echte Nebenlaeufigkeit:
 *   1) `meta.requestId` (bzw. `meta.idempotencyKey`) → exakte Einmal-Semantik.
 *   2) Dedup-Fenster fuer Clients ohne Request-Id: dieselbe Kombination
 *      (tenant + Produkt + BIN + Menge + Actor) innerhalb von
 *      STOCK_IN_DEDUP_WINDOW_SECONDS (Default 30 s) gilt als Wiederholung.
 * Eine erkannte Wiederholung ist ein ERFOLG (gleiche Antwortform, `deduped:true`),
 * kein Fehler — sonst zeigt die Oberflaeche eine Stoerung, obwohl alles stimmt.
 * Notbremse: STOCK_IN_DEDUP='off'.
 */
async function bookStockIn({ productId, sku, barcode, binCode, quantity, meta }) {
  if (!binCode) throw new Error('Bin-Code fehlt.');
  if (!quantity || quantity <= 0) throw new Error('Menge muss größer als 0 sein.');

  const { ref: productRef } = await findProductDocument({ productId, sku, barcode });
  const binRef = binsCollection.doc(binCode);
  const now = Timestamp.now();
  let updatedProduct = null;
  let updatedBin = null;

  let resolvedProductId = null;

  // ── Idempotenz-Vorbereitung (vor der Tx, rein) ─────────────────────────
  const dedupEnabled = stockInDedupEnabled();
  const dedupWindowMs = stockInDedupWindowMs();
  const claimTenantId = (meta && meta.tenantId) || 'default';
  const claimRequestId = normalizeStockInRequestId(meta);
  const claimActorKey = normalizeStockInActorKey(meta);
  // Das Fenster gilt NUR fuer den interaktiven Einlager-Vorgang. Buchungen mit
  // Order-/Retouren-Kontext (WP4-Re-Credit, returns-restock) tragen ihre eigene
  // Einmal-Semantik (order-stock-recredit-claim bzw. Grading-Claim) und haben
  // keinen Actor — zwei verschiedene Orders derselben SKU/Menge/BIN innerhalb
  // des Fensters wuerden sonst zu echtem BESTANDSVERLUST fuehren.
  const hasOrderContext = Boolean(meta && (meta.orderId || meta.returnId));
  const windowDedupApplies = dedupEnabled && !hasOrderContext;
  const claimIds = dedupEnabled
    ? buildStockInClaimIds({
      tenantId: claimTenantId,
      requestId: claimRequestId,
      // Produkt-Doc-ID statt roher SKU: derselbe Artikel erzeugt denselben
      // Schluessel, egal ob der Client productId, sku oder barcode geschickt hat.
      productKey: productRef.id,
      binCode,
      quantity,
      actorKey: claimActorKey,
    })
    : null;
  const requestClaimRef = claimIds && claimIds.requestClaimId
    ? stockInClaimsCollection.doc(claimIds.requestClaimId)
    : null;
  const windowClaimRef = windowDedupApplies && claimIds && claimIds.windowClaimId
    ? stockInClaimsCollection.doc(claimIds.windowClaimId)
    : null;
  const nowMs = Date.now();
  let dedupInfo = null;

  await firestore.runTransaction(async (tx) => {
    // ─── Phase READS ─────────────────────────────────────────────────────
    // Firestore-Constraint: ALLE Reads vor JEDEM Write. Die Claim-Reads gehoeren
    // deshalb hier nach oben (und der Claim-Write unten in die Write-Phase).
    const reads = [tx.get(productRef), tx.get(binRef)];
    reads.push(requestClaimRef ? tx.get(requestClaimRef) : Promise.resolve(null));
    reads.push(windowClaimRef ? tx.get(windowClaimRef) : Promise.resolve(null));
    const [productSnap, binSnap, requestClaimSnap, windowClaimSnap] = await Promise.all(reads);

    if (dedupEnabled) {
      if (requestClaimSnap && requestClaimSnap.exists) {
        const claimData = (typeof requestClaimSnap.data === 'function' ? requestClaimSnap.data() : null) || {};
        dedupInfo = {
          reason: 'request-id',
          claimId: claimIds.requestClaimId,
          requestId: claimRequestId,
          firstAtMs: claimTimeToMillis(claimData.lastAtMs ?? claimData.lastAt ?? claimData.firstAt),
        };
        return; // KEINE Writes — die Buchung lief bereits.
      }
      if (!claimRequestId && windowDedupApplies && dedupWindowMs > 0 && windowClaimSnap && windowClaimSnap.exists) {
        const claimData = (typeof windowClaimSnap.data === 'function' ? windowClaimSnap.data() : null) || {};
        const lastAtMs = claimTimeToMillis(claimData.lastAtMs ?? claimData.lastAt);
        if (lastAtMs !== null && nowMs - lastAtMs >= 0 && nowMs - lastAtMs < dedupWindowMs) {
          dedupInfo = {
            reason: 'window',
            claimId: claimIds.windowClaimId,
            windowMs: dedupWindowMs,
            ageMs: nowMs - lastAtMs,
            firstAtMs: lastAtMs,
          };
          return; // KEINE Writes — Wiederholung innerhalb des Fensters.
        }
      }
    }

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

    // ─── Idempotenz-Claim in DERSELBEN Tx setzen ─────────────────────────
    // Ohne denselben Commit gaebe es ein Fenster, in dem zwei parallele
    // Requests beide „kein Claim vorhanden" lesen.
    if (dedupEnabled) {
      const claimBase = {
        tenantId: claimTenantId,
        productId: resolvedProductId,
        productDocId: productRef.id,
        sku: productData.details?.identifiers?.sku || productData.identification?.sku || null,
        binCode,
        quantity: Number(quantity) || 0,
        actor: claimActorKey,
        requestId: claimRequestId,
        lastAt: now,
        lastAtMs: nowMs,
      };
      if (requestClaimRef) {
        tx.set(requestClaimRef, { ...claimBase, kind: 'request', firstAtMs: nowMs }, { merge: true });
      }
      if (windowClaimRef) {
        // Auch mit Request-Id gepflegt (nur nicht erzwungen) → ein Alt-Client,
        // der dieselbe Buchung nachschickt, laeuft trotzdem ins Fenster.
        const prev = windowClaimSnap && windowClaimSnap.exists
          ? ((typeof windowClaimSnap.data === 'function' ? windowClaimSnap.data() : null) || {})
          : {};
        tx.set(windowClaimRef, {
          ...claimBase,
          kind: 'window',
          firstAtMs: Number.isFinite(Number(prev.firstAtMs)) ? Number(prev.firstAtMs) : nowMs,
          bookings: (Number(prev.bookings) || 0) + 1,
        }, { merge: true });
      }
    }

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

  // ── Wiederholung erkannt: NICHTS wurde gebucht ─────────────────────────
  // Antwort behaelt die Form (product + bin), damit die Oberflaeche keinen
  // Fehler zeigt; `deduped:true` macht es fuer Aufrufer und Log sichtbar.
  if (dedupInfo) {
    console.warn(
      `[bookStockIn] DEDUPED (${dedupInfo.reason}) productId=${productRef.id} bin=${binCode} qty=${quantity} ` +
      `actor=${claimActorKey} requestId=${claimRequestId || '-'} claim=${dedupInfo.claimId}` +
      (dedupInfo.ageMs !== undefined ? ` ageMs=${dedupInfo.ageMs} windowMs=${dedupInfo.windowMs}` : '') +
      ' — Doppel-Absendung, keine Buchung durchgefuehrt'
    );
    let bin = null;
    try {
      bin = await getBinByCode(binCode);
    } catch (err) {
      console.warn(`[bookStockIn] dedup response: bin read failed for ${binCode}: ${err.message}`);
    }
    const existingProduct = await getProduct(productRef.id);
    return { product: existingProduct || null, bin, deduped: true, dedupReason: dedupInfo.reason };
  }

  // GEGEN-PFAD zum Pick-Consume (Review-Finding 8): wird eine Einheit mit
  // Order-Kontext wieder eingelagert (Fehl-Pick → Stow-back), lebt die beim
  // Pick konsumierte Reservierung wieder auf — sonst gilt die Einheit als frei
  // verkäuflich, obwohl die offene Order sie braucht (Oversell-Fenster bis
  // Re-Pick). Das Order-Status-Gate im Restore verhindert, dass der WP4-
  // Cancel-/Return-Recredit (ruft bookStockIn ebenfalls mit meta.orderId auf)
  // die erloschene Obligation einer stornierten Order wieder öffnet.
  // Reihenfolge: VOR refreshProductInventory (siehe Pick-Hook in bookStockOut).
  const stowOrderId = meta && meta.orderId ? String(meta.orderId).trim() : null;
  if (stowOrderId) {
    try {
      const { restoreReservationOnStowBack } = require('../services/stock-reservation');
      const restored = await restoreReservationOnStowBack({
        tenantId: (meta && meta.tenantId) || 'default',
        orderId: stowOrderId,
        sku: sku || null,
        productId: productRef.id,
        quantity,
      });
      if (restored.matched && restored.restored > 0) {
        console.log(`[bookStockIn] order=${stowOrderId} reservation restored on stow-back (qty=${restored.restored})`);
      }
    } catch (resErr) {
      console.warn(`[bookStockIn] reservation restore failed order=${stowOrderId}: ${resErr.message}`);
    }
  }

  await refreshProductInventory(productRef.id);
  const freshProduct = await getProduct(productRef.id);
  return { product: freshProduct || updatedProduct, bin: updatedBin, deduped: false };
}

async function bookStockOut({ productId, sku, barcode, binCode, quantity, meta }) {
  if (!binCode) throw new Error('Bin-Code fehlt.');
  if (!quantity || quantity <= 0) throw new Error('Menge muss größer als 0 sein.');

  const { ref: productRef } = await findProductDocument({ productId, sku, barcode });
  const binRef = binsCollection.doc(binCode);
  // STOCK SINGLE WRITER INVARIANT (CLAUDE.md Punkt 13): wenn meta.orderId gesetzt ist,
  // claimen wir den Decrement atomar mit dem Bin-Decrement, damit `_onOrderShipped`
  // im Ship-Trigger nicht ein zweites Mal decrementiert.
  const orderIdMeta = meta && meta.orderId ? String(meta.orderId).trim() : null;
  const orderRef = orderIdMeta ? firestore.collection('orders').doc(orderIdMeta) : null;
  const now = Timestamp.now();
  let updatedProduct = null;
  let updatedBin = null;
  let resolvedProductId = null;
  let resolvedSkuValue = null;
  let preInventoryQty = null;
  let postInventoryQty = null;
  let claimResult = null;

  await firestore.runTransaction(async (tx) => {
    // ─── Phase READS ─────────────────────────────────────────────────────
    // Firestore-Constraint: ALLE Reads MUESSEN vor JEDEM Write erfolgen
    // (sonst: "Firestore transactions require all reads to be executed
    //  before all writes."). Wenn `orderRef` gesetzt ist, lesen wir auch
    // den Order-Claim-Zustand HIER, NICHT spaeter — siehe Bug-Fix
    // 2026-05-03 (Pick-Modul "Pick failed: Firestore transaction
    // requires all reads to be executed before all writes").
    const { readOrderClaimStateInTx, writeOrderClaimInTx, appendOrderClaimSkuInTx } = require('./order-stock-claim');
    const reads = [tx.get(productRef), tx.get(binRef)];
    if (orderRef) {
      reads.push(readOrderClaimStateInTx({ tx, orderRef }));
    }
    const [productSnap, binSnap, orderClaimState] = await Promise.all(reads);
    if (!productSnap.exists) throw new Error('Produkt nicht gefunden.');
    if (!binSnap.exists) throw new Error('BIN nicht gefunden.');

    const productData = productSnap.data();
    const binData = binSnap.data();
    const products = cloneProductsArray(binData);
    resolvedProductId = productData.id || productRef.id;
    resolvedSkuValue =
      productData.details?.identifiers?.sku ||
      productData.identification?.sku ||
      sku ||
      null;
    preInventoryQty = Number(productData?.inventory?.quantity);
    if (!Number.isFinite(preInventoryQty)) preInventoryQty = null;
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

    // ─── Claim-Entscheidung berechnen (rein) ────────────────────────────
    // Vor dem ersten Write entscheiden, was am Ende der Tx mit dem Order-
    // Claim passieren soll.
    let pendingClaimWrite = null;
    let pendingClaimSkuAppend = null;
    if (orderRef) {
      if (!orderClaimState || !orderClaimState.exists) {
        // HARDEN-8 (2026-05-20): Order-Doc-Guard.
        // Wenn `meta.orderId` gesetzt ist aber das Order-Doc nicht existiert,
        // ist das ein integrität-kritischer Zustand: wir würden Bestand
        // dekrementieren OHNE den `stockDecrementedAt`-Marker zu setzen
        // (orphan decrement). Im nächsten Ship-Flow würde `_onOrderShipped`
        // ein zweites Mal decrementieren (double-decrement window — siehe
        // CLAUDE.md Punkt 13 + Incident 2026-04-29).
        //
        // Fail-fast statt silent-write.
        throw new Error(
          `bookStockOut: order "${orderIdMeta}" nicht gefunden — Stock-Decrement abgebrochen ` +
          `(verhindert orphan-decrement gemäß CLAUDE.md Punkt 13).`
        );
      } else if (orderClaimState.alreadyClaimed) {
        claimResult = {
          claimed: false,
          alreadyClaimed: true,
          at: orderClaimState.at,
          by: orderClaimState.by,
        };
        // Multi-SKU-Order: der ERSTE Pick hat den Claim mit seiner SKU
        // gesetzt. Jeder WEITERE Pick derselben Order muss seine SKU an
        // stockDecrementedSkus anhaengen, sonst uebersieht der WP4-Re-Credit
        // (_recreditOrderStock filtert strikt auf diese Liste) die uebrigen
        // physisch dekrementierten SKUs bei Cancel → unsichtbarer
        // Bestandsverlust. Nur fuer by='pick' — ein 'ship'-Claim hat bereits
        // alle Order-SKUs erfasst.
        if (orderClaimState.by === 'pick' && resolvedSkuValue) {
          const { normalizeSkuKey } = require('./order-status-helpers');
          const alreadyListed = (orderClaimState.skus || [])
            .some((s) => normalizeSkuKey(s) === normalizeSkuKey(resolvedSkuValue));
          if (!alreadyListed) {
            pendingClaimSkuAppend = { sku: resolvedSkuValue, existingSkus: orderClaimState.skus || [] };
            claimResult.appendedSku = resolvedSkuValue;
          }
        }
      } else {
        const claimedAt = now.toDate().toISOString();
        pendingClaimWrite = {
          by: 'pick',
          skus: resolvedSkuValue ? [resolvedSkuValue] : [],
          nowIso: claimedAt,
        };
        claimResult = {
          claimed: true,
          alreadyClaimed: false,
          at: claimedAt,
          by: 'pick',
        };
      }
    }

    // ─── Phase WRITES ───────────────────────────────────────────────────
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
      postInventoryQty = 0;
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
      postInventoryQty = entry.quantity;
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
      sku: resolvedSkuValue,
      delta: -(Number(quantity) || 0),
      quantityAfter: entry.quantity <= 0 ? 0 : entry.quantity,
      binProductCountAfter: productCount,
      meta: meta || null,
    });

    // STOCK SINGLE WRITER CLAIM (CLAUDE.md Punkt 13): Phase-2-Write des
    // bereits in der Read-Phase entschiedenen Claims. Macht NUR `tx.update`,
    // verletzt also nicht die Read-before-Write-Regel.
    if (pendingClaimWrite) {
      writeOrderClaimInTx({
        tx,
        orderRef,
        by: pendingClaimWrite.by,
        skus: pendingClaimWrite.skus,
        nowIso: pendingClaimWrite.nowIso,
      });
    } else if (pendingClaimSkuAppend) {
      appendOrderClaimSkuInTx({
        tx,
        orderRef,
        sku: pendingClaimSkuAppend.sku,
        existingSkus: pendingClaimSkuAppend.existingSkus,
      });
    }

    updatedBin = {
      code: binCode,
      ...binData,
      products: newProducts,
      productCount,
      lastStoredAt: now.toDate().toISOString(),
    };
  });

  // Logging des Claim-Resultats fuer Operator-Sichtbarkeit.
  if (orderIdMeta) {
    if (claimResult && claimResult.claimed) {
      console.log(
        `[bookStockOut] order=${orderIdMeta} sku=${resolvedSkuValue} claimed stockDecrementedAt by='pick' — ship-flow will skip Phase A`
      );
    } else if (claimResult && claimResult.alreadyClaimed && claimResult.appendedSku) {
      console.log(
        `[bookStockOut] order=${orderIdMeta} sku=${resolvedSkuValue} appended to existing pick-claim (multi-SKU order) — re-credit sieht jetzt alle gepickten SKUs`
      );
    } else if (claimResult && claimResult.alreadyClaimed) {
      console.warn(
        `[bookStockOut] order=${orderIdMeta} sku=${resolvedSkuValue} stockDecrementedAt already set at=${claimResult.at} by='${claimResult.by}' — investigate possible double-decrement`
      );
    } else if (claimResult && claimResult.reason === 'order-not-found') {
      console.warn(
        `[bookStockOut] order=${orderIdMeta} (referenced in meta) not found — bin/inventory dekrementiert ohne Order-Claim`
      );
    }
  }

  // DOPPELZÄHLUNGS-FIX (Incident 2026-07-19, SKU-6656556112): die gepickte
  // Einheit hat das Lager physisch verlassen (inventory.quantity sank in der
  // Tx oben) — die Soft-Lock-Reservierung der Order MUSS jetzt um dieselbe
  // Menge sinken, sonst zählt die Einheit bis zum Versand-Scan doppelt
  // (physischer Abgang UND aktive Reservierung) und `available = physisch −
  // reserviert` unterschreitet den wahren verkäuflichen Bestand → der
  // Stock-Sync beendete bei Last-Unit-Picks eBay-Angebote trotz Bestand.
  // Reihenfolge: VOR refreshProductInventory, damit der dort emittierte
  // stock:changed-Sync bereits die konsumierte Reservierung sieht.
  // Best-effort: schlägt der Consume fehl, bleibt available lediglich bis zum
  // Versand-Confirm konservativ niedrig (kein Datenverlust, kein Oversell).
  if (orderIdMeta) {
    try {
      const { consumeReservationOnPick } = require('../services/stock-reservation');
      const consumed = await consumeReservationOnPick({
        tenantId: (meta && meta.tenantId) || 'default',
        orderId: orderIdMeta,
        sku: resolvedSkuValue,
        productId: resolvedProductId,
        quantity,
      });
      if (consumed.matched) {
        console.log(
          `[bookStockOut] order=${orderIdMeta} sku=${resolvedSkuValue} reservation consumed on pick (qty=${quantity}, closed=${consumed.confirmed === true})`
        );
      }
    } catch (resErr) {
      console.warn(
        `[bookStockOut] reservation consume failed order=${orderIdMeta} sku=${resolvedSkuValue}: ${resErr.message} — available bleibt bis Versand konservativ`
      );
    }
  }

  await refreshProductInventory(productRef.id);

  // Telemetrie: inventory_ledger-Eintrag (CLAUDE.md Punkt 10/13).
  if (
    preInventoryQty !== null &&
    postInventoryQty !== null &&
    Number(preInventoryQty) !== Number(postInventoryQty)
  ) {
    try {
      const { notifyStockChange } = require('./stock-change-events');
      await notifyStockChange({
        tenantId: 'default',
        productId: productRef.id,
        sku: resolvedSkuValue,
        before: Number(preInventoryQty),
        after: Number(postInventoryQty),
        reason: orderIdMeta ? `pick-stock-out:${orderIdMeta}` : 'manual-stock-out',
        source: 'warehouse.bookStockOut',
      });
    } catch (err) {
      console.warn(`[bookStockOut] notifyStockChange failed productId=${productRef.id}: ${err.message}`);
    }
  }

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
  // Stock-in Idempotenz (Incident 05.06.2026)
  stockInDedupEnabled,
  stockInDedupWindowMs,
  buildStockInClaimIds,
  STOCK_IN_CLAIMS_COLLECTION,
  // Exported for testing
  buildProductKeySet,
  binEntryMatchesKeySet,
  normalizeKey,
  normalizeStockInActorKey,
  claimTimeToMillis,
};
