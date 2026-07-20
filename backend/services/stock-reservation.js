/**
 * Stock Reservation Service
 *
 * Manages stock reservations when orders come in (soft-lock).
 * Prevents overselling by reserving stock before warehouse picking.
 *
 * Flow: Order received → reserveStock() → Picking → confirmReservation() (= stock-out)
 *       If order cancelled → releaseReservation()
 *
 * Collection: stock_reservations
 * Doc: { tenantId, orderId, sku, productId, quantity, status, createdAt, expiresAt }
 */

const { firestore } = require('../lib/firestore');

const RESERVATIONS_COLLECTION = 'stock_reservations';
const DEFAULT_EXPIRY_HOURS = parseInt(process.env.STOCK_RESERVATION_EXPIRY_HOURS || '72', 10);

/**
 * Firestore-Doc-IDs duerfen keinen Slash enthalten; weitere Sonderzeichen
 * werden defensiv ersetzt, damit Marktplatz-SKUs die Pfade nicht brechen.
 */
function _sanitizeIdPart(value) {
  return String(value).trim().replace(/[\/#?%\s]+/g, '_');
}

/**
 * Reserve stock for an order's items.
 *
 * Idempotent BY CONSTRUCTION: pro (tenantId, orderId, sku|productId) gibt es
 * genau eine deterministische Doc-ID, geschrieben mit create()-Semantik.
 * Der fruehere Query-then-Batch-Write-Check war eine Race: zwei ueberlappende
 * Order-Syncs (Web-Instanzen + Worker-Cron + Event-Bus) sahen beide "keine
 * Reservierung" und legten Duplikate an → availableQty faelschlich 0 →
 * Zero-Stock-Push bis hin zum eBay-Listing-End. Mit create() verliert der
 * zweite Schreiber deterministisch (ALREADY_EXISTS) und meldet skip.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (default: 'default')
 * @param {string} params.orderId - Unique order identifier
 * @param {Array<{sku: string, productId?: string, quantity: number}>} params.items
 * @returns {Object} { reserved: boolean, count: number, skipped: boolean }
 */
async function reserveStock({ tenantId = 'default', orderId, items }) {
  if (!orderId) throw new Error('orderId is required for stock reservation');
  if (!Array.isArray(items) || items.length === 0) {
    return { reserved: false, count: 0, skipped: true, reason: 'no items' };
  }

  // Fast-path (und Schutz vor Legacy-Docs mit Auto-IDs): existiert schon
  // eine aktive Reservierung fuer die Order, gar nicht erst schreiben.
  const existingSnap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved')
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    return { reserved: false, count: 0, skipped: true, reason: 'already reserved' };
  }

  // Mengen pro SKU/Produkt aggregieren (mehrere Order-Positionen derselben
  // SKU ergeben EIN Reservierungs-Doc mit Summenmenge).
  const perKey = new Map();
  for (const item of items) {
    if (!item.sku && !item.productId) continue;
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;
    const keyBase = item.sku ? `sku_${item.sku}` : `pid_${item.productId}`;
    const existing = perKey.get(keyBase);
    if (existing) {
      existing.quantity += qty;
    } else {
      perKey.set(keyBase, { sku: item.sku || null, productId: item.productId || null, quantity: qty });
    }
  }
  if (perKey.size === 0) {
    return { reserved: false, count: 0, skipped: true, reason: 'no items' };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);
  const batch = firestore.batch();
  let count = 0;

  for (const [keyBase, entry] of perKey) {
    const docId = _sanitizeIdPart(`${tenantId}__${orderId}__${keyBase}`);
    const ref = firestore.collection(RESERVATIONS_COLLECTION).doc(docId);
    // create() (nicht set()): schlaegt fehl, wenn das Doc existiert —
    // der Verlierer eines Race erzeugt kein Duplikat.
    batch.create(ref, {
      tenantId,
      orderId,
      sku: entry.sku,
      productId: entry.productId,
      quantity: entry.quantity,
      status: 'reserved',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    count++;
  }

  try {
    await batch.commit();
  } catch (err) {
    const isAlreadyExists = err?.code === 6 || /ALREADY[_ ]EXISTS/i.test(err?.message || '');
    if (isAlreadyExists) {
      console.log(`[stock-reservation] concurrent reservation detected for order=${orderId} — skipping (idempotent)`);
      return { reserved: false, count: 0, skipped: true, reason: 'already reserved (concurrent)' };
    }
    throw err;
  }

  // Überbuchungs-Wache (Oversell-Incident 2026-07-11, SKU-2510094553): eine
  // bezahlte Marktplatz-Order wird IMMER reserviert (ablehnen geht nicht),
  // aber wenn damit in Summe mehr reserviert ist als physisch existiert, muss
  // ein Mensch es SOFORT erfahren — vorher passierte die zweite Reservierung
  // stumm und der Konflikt fiel erst beim Picken auf. Best-effort: darf den
  // Intake nie brechen.
  const overbooked = [];
  try {
    for (const entry of perKey.values()) {
      const check = await detectOverbooking({ tenantId, sku: entry.sku, productId: entry.productId });
      if (check?.overbooked) overbooked.push(check);
    }
    if (overbooked.length) {
      const { emitOpsAlert } = require('../lib/ops-alert');
      for (const ob of overbooked) {
        console.error(`[stock-reservation] ⚠️ ÜBERBUCHUNG sku=${ob.sku || '-'} physisch=${ob.physicalQty} reserviert=${ob.reservedQty} (order=${orderId})`);
        emitOpsAlert({
          source: 'stock-reservation',
          severity: 'critical',
          tenantId,
          message: `ÜBERBUCHUNG: SKU ${ob.sku || ob.productId} — ${ob.reservedQty} Stück reserviert, aber nur ${ob.physicalQty} physisch im Lager (ausgelöst durch Order ${orderId}). Eine der Bestellungen kann nicht beliefert werden — nachbeschaffen oder stornieren.`,
          context: { sku: ob.sku, productId: ob.productId, physicalQty: ob.physicalQty, reservedQty: ob.reservedQty, orderId },
        });
      }
    }
  } catch (obErr) {
    console.warn(`[stock-reservation] overbooking check failed (non-fatal): ${obErr?.message}`);
  }

  return { reserved: count > 0, count, skipped: false, overbooked: overbooked.length > 0 };
}

/**
 * Prüft, ob für eine SKU/ein Produkt in Summe mehr reserviert ist als physisch
 * im Lager liegt. Liefert `{ overbooked, sku, productId, physicalQty,
 * reservedQty }` oder `null`, wenn kein Produkt auffindbar ist (dann ist keine
 * Aussage möglich). Read-only, wirft nie in den Aufrufer (Fehler → null).
 */
async function detectOverbooking({ tenantId = 'default', sku = null, productId = null } = {}) {
  try {
    let productDoc = null;
    if (productId) {
      const snap = await firestore.collection('products_v2').doc(String(productId)).get();
      if (snap.exists) productDoc = { id: snap.id, ...snap.data() };
    }
    if (!productDoc && sku) {
      // Beide historisch genutzten SKU-Felder prüfen (identification.sku ist
      // der kanonische Ort, details.identifiers.sku der Legacy-Pfad).
      for (const field of ['identification.sku', 'details.identifiers.sku']) {
        const snap = await firestore.collection('products_v2')
          .where(field, '==', String(sku))
          .limit(1)
          .get();
        if (!snap.empty) {
          productDoc = { id: snap.docs[0].id, ...snap.docs[0].data() };
          break;
        }
      }
    }
    if (!productDoc) return null;

    const physicalQty = Number(productDoc?.inventory?.quantity ?? 0);
    const reservedQty = await getReservedQuantity({
      tenantId,
      sku: sku || undefined,
      productId: sku ? undefined : (productId || undefined),
    });
    return {
      overbooked: reservedQty > physicalQty,
      sku: sku || null,
      productId: productDoc.id,
      physicalQty,
      reservedQty,
    };
  } catch (err) {
    console.warn(`[stock-reservation] detectOverbooking failed for sku=${sku}: ${err?.message}`);
    return null;
  }
}

/**
 * Release all reservations for an order (e.g., cancellation).
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.orderId
 * @returns {Object} { released: number }
 */
async function releaseReservation({ tenantId = 'default', orderId }) {
  if (!orderId) throw new Error('orderId is required');

  const snap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved')
    .get();

  if (snap.empty) return { released: 0 };

  const batch = firestore.batch();
  snap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'released',
      releasedAt: new Date().toISOString(),
    });
  });
  await batch.commit();

  return { released: snap.docs.length };
}

/**
 * Consume (part of) a reservation when its unit is physically PICKED.
 *
 * Doppelzählungs-Fix (Incident 2026-07-19, SKU-6656556112): der Pick
 * dekrementiert `inventory.quantity`, aber die Reservierung blieb bis zum
 * Versand-Scan `status='reserved'` — dieselbe Einheit zählte in
 * `available = physisch − reserviert` DOPPELT. Bei einem Last-Unit-Pick fiel
 * available fälschlich auf 0 und der Stock-Sync beendete das eBay-Angebot,
 * obwohl noch verkäuflicher Bestand existierte.
 *
 * Invariante danach: eine Einheit zählt zu jedem Zeitpunkt GENAU EINMAL —
 * entweder als offene Reservierung (noch nicht gepickt) oder als bereits
 * erfolgter physischer Abgang. Teil-Picks senken `quantity`; erreicht die
 * Rest-Obligation 0, wird die Reservierung als 'confirmed' (confirmedBy
 * 'pick') geschlossen — identische Semantik wie der Versand-Confirm.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.orderId
 * @param {string} [params.sku] - SKU der gepickten Einheit
 * @param {string} [params.productId] - Fallback-Match wenn SKU fehlt
 * @param {number} params.quantity - gepickte Menge
 * @returns {Object} { matched, consumed, confirmed, remaining }
 */
async function consumeReservationOnPick({ tenantId = 'default', orderId, sku = null, productId = null, quantity = 1 }) {
  const qty = Number(quantity) || 0;
  if (!orderId || qty <= 0) return { matched: false, consumed: 0, confirmed: false };

  const snap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved')
    .get();
  if (snap.empty) return { matched: false, consumed: 0, confirmed: false };

  const { normalizeSkuKey } = require('../lib/order-status-helpers');
  const target = snap.docs.find((doc) => {
    const data = doc.data();
    if (sku && data.sku && normalizeSkuKey(data.sku) === normalizeSkuKey(sku)) return true;
    if (productId && data.productId && String(data.productId) === String(productId)) return true;
    return false;
  });
  if (!target) return { matched: false, consumed: 0, confirmed: false };

  return firestore.runTransaction(async (tx) => {
    const fresh = await tx.get(target.ref);
    if (!fresh.exists) return { matched: false, consumed: 0, confirmed: false };
    const data = fresh.data();
    if (data.status !== 'reserved') {
      // Race mit Versand-Confirm/Release — nichts mehr zu konsumieren.
      return { matched: false, consumed: 0, confirmed: false };
    }
    const now = new Date().toISOString();
    const currentQty = Number(data.quantity) || 0;
    const remaining = currentQty - qty;
    if (remaining > 0) {
      tx.update(target.ref, {
        quantity: remaining,
        quantityOriginal: Number(data.quantityOriginal ?? currentQty),
        lastPickConsumedAt: now,
      });
      return { matched: true, consumed: qty, confirmed: false, remaining };
    }
    tx.update(target.ref, {
      quantity: 0,
      quantityOriginal: Number(data.quantityOriginal ?? currentQty),
      status: 'confirmed',
      confirmedAt: now,
      confirmedBy: 'pick',
    });
    return { matched: true, consumed: currentQty, confirmed: true, remaining: 0 };
  });
}

/**
 * Symmetrischer Gegen-Pfad zu consumeReservationOnPick (Review-Finding 8):
 * wird eine gepickte Einheit wieder EINGELAGERT (Fehl-Pick → Stow-back),
 * muss die konsumierte Reservierungs-Obligation wieder aufleben — sonst
 * zählt available die Einheit als frei verkäuflich, obwohl die offene Order
 * sie weiterhin braucht (Oversell-Fenster bis zum Re-Pick).
 *
 * SICHERHEITS-GATE: Restore NUR wenn die Order noch in einem offenen
 * Prä-Versand-Status ist (RESERVED_ORDER_STATUSES — dasselbe Set wie beim
 * Intake-Reserve). Der WP4-Cancel-/Return-Recredit ruft bookStockIn ebenfalls
 * mit meta.orderId auf — dessen Orders sind cancelled/returned und dürfen
 * NIEMALS wieder reservieren (die Obligation ist erloschen).
 *
 * @returns {Object} { restored, matched }
 */
async function restoreReservationOnStowBack({ tenantId = 'default', orderId, sku = null, productId = null, quantity = 1 }) {
  const qty = Number(quantity) || 0;
  if (!orderId || qty <= 0) return { matched: false, restored: 0 };

  // Gate: Order-Status prüfen — nur offene, unversendete Orders reservieren.
  try {
    const orderSnap = await firestore.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return { matched: false, restored: 0, reason: 'order_not_found' };
    const { RESERVED_ORDER_STATUSES } = require('../lib/order-status-helpers');
    const status = String(orderSnap.data()?.omsStatus || '').toLowerCase();
    if (!RESERVED_ORDER_STATUSES.has(status)) {
      return { matched: false, restored: 0, reason: `order_status_${status || 'unknown'}` };
    }
  } catch (err) {
    // Im Zweifel NICHT restoren (konservativ: available bleibt niedriger).
    return { matched: false, restored: 0, reason: `order_check_failed: ${err.message}` };
  }

  const snap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .get();
  if (snap.empty) return { matched: false, restored: 0 };

  const { normalizeSkuKey } = require('../lib/order-status-helpers');
  const target = snap.docs.find((doc) => {
    const data = doc.data();
    const skuMatch = sku && data.sku && normalizeSkuKey(data.sku) === normalizeSkuKey(sku);
    const pidMatch = productId && data.productId && String(data.productId) === String(productId);
    if (!skuMatch && !pidMatch) return false;
    // Nur pick-konsumierte oder teil-konsumierte Reservierungen wiederherstellen
    return (data.status === 'confirmed' && data.confirmedBy === 'pick') || data.status === 'reserved';
  });
  if (!target) return { matched: false, restored: 0 };

  return firestore.runTransaction(async (tx) => {
    const fresh = await tx.get(target.ref);
    if (!fresh.exists) return { matched: false, restored: 0 };
    const data = fresh.data();
    const pickConsumed = data.status === 'confirmed' && data.confirmedBy === 'pick';
    if (!pickConsumed && data.status !== 'reserved') return { matched: false, restored: 0 };

    const currentQty = Number(data.quantity) || 0;
    const cap = Number(data.quantityOriginal ?? (currentQty + qty));
    const newQty = Math.min(currentQty + qty, cap);
    const restored = newQty - currentQty;
    if (restored <= 0) return { matched: true, restored: 0 };

    const payload = {
      quantity: newQty,
      lastStowBackRestoreAt: new Date().toISOString(),
    };
    if (pickConsumed) {
      payload.status = 'reserved';
      payload.confirmedAt = null;
      payload.confirmedBy = null;
    }
    tx.update(target.ref, payload);
    return { matched: true, restored };
  });
}

/**
 * Confirm reservations for an order (= stock-out happened).
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.orderId
 * @returns {Object} { confirmed: number }
 */
async function confirmReservation({ tenantId = 'default', orderId }) {
  if (!orderId) throw new Error('orderId is required');

  const snap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved')
    .get();

  if (snap.empty) return { confirmed: 0 };

  const batch = firestore.batch();
  snap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    });
  });
  await batch.commit();

  return { confirmed: snap.docs.length };
}

/**
 * Get total reserved quantity for a given SKU or productId.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} [params.sku]
 * @param {string} [params.productId]
 * @returns {number} Total reserved quantity
 */
async function getReservedQuantity({ tenantId = 'default', sku, productId }) {
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved');

  if (sku) {
    query = query.where('sku', '==', sku);
  } else if (productId) {
    query = query.where('productId', '==', productId);
  } else {
    return 0;
  }

  const snap = await query.get();
  const now = new Date().toISOString();
  let total = 0;
  snap.docs.forEach((doc) => {
    const data = doc.data();
    // Skip expired reservations even if cleanup hasn't run yet
    if (data.expiresAt && data.expiresAt < now) return;
    total += Number(data.quantity) || 0;
  });
  return total;
}

/**
 * Get all active reservations for a tenant, optionally filtered.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} [params.status] - 'reserved', 'confirmed', 'released'
 * @param {number} [params.limit]
 * @returns {Array}
 */
async function listReservations({ tenantId = 'default', status, limit = 200 }) {
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('tenantId', '==', tenantId);

  if (status) {
    query = query.where('status', '==', status);
  }

  query = query.orderBy('createdAt', 'desc').limit(limit);
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Clean up expired reservations (best-effort, run periodically).
 *
 * @param {Object} [params]
 * @param {string} [params.tenantId]
 * @returns {Object} { expired: number }
 */
async function expireStaleReservations({ tenantId } = {}) {
  const now = new Date().toISOString();
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('status', '==', 'reserved')
    .where('expiresAt', '<', now)
    .limit(500);

  if (tenantId) {
    query = query.where('tenantId', '==', tenantId);
  }

  const snap = await query.get();
  if (snap.empty) return { expired: 0 };

  const batch = firestore.batch();
  snap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'expired',
      expiredAt: now,
    });
  });
  await batch.commit();

  return { expired: snap.docs.length };
}

module.exports = {
  reserveStock,
  releaseReservation,
  confirmReservation,
  consumeReservationOnPick,
  restoreReservationOnStowBack,
  getReservedQuantity,
  detectOverbooking,
  listReservations,
  expireStaleReservations,
};
