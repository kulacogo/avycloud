'use strict';

const { createHash, randomUUID } = require('node:crypto');
const activeStatus = (order) => ['confirmed', 'picking'].includes(order.omsStatus || order.status);
const tenantOf = (order) => order.tenantId || 'default';
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const itemKey = (item) => key(String(item.productId || ''), String(item.sku || '').trim().toUpperCase());
function fail(message, code = 'PICK_CONFLICT') {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  throw error;
}
function requireActor(actor, tenantId) {
  if (!actor?.uid || !tenantId) fail('Mitarbeiter-Anmeldung fehlt.', 'PICK_AUTH');
}
function initialWork(order, actor, sessionId) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length || items.some((item) => !item.id || !Number.isSafeInteger(Number(item.quantity)) || Number(item.quantity) <= 0)
    || new Set(items.map((item) => String(item.id))).size !== items.length) {
    fail('Auftragspositionen müssen geprüft werden.', 'PICK_REVIEW');
  }
  return {
    version: 1, ownerUid: actor.uid, ownerName: actor.email || actor.uid,
    sessionId, token: randomUUID(), status: 'active', updatedAt: new Date().toISOString(),
    lines: items.map((item) => ({ itemId: String(item.id), itemKey: itemKey(item), required: Number(item.quantity), picked: 0 })),
    receipts: {},
  };
}
function assertOwner(order, { tenantId, actor, token }) {
  requireActor(actor, tenantId);
  if (tenantOf(order) !== tenantId) fail('Auftrag nicht gefunden.', 'PICK_NOT_FOUND');
  if (!order.pickWork || order.pickWork.ownerUid !== actor.uid) fail('Auftrag gehört einem anderen Mitarbeiter.');
  if (!token || order.pickWork.token !== token) fail('Auftrag ist auf einem anderen Scanner geöffnet.');
}

// Called on the order snapshot read IN THE SAME transaction as the BIN write.
// No side effects; the caller persists work with the stock event atomically.
function preparePickBooking(order, request) {
  assertOwner(order, request);
  const { itemId, requestId, quantity, productId, sku, binCode } = request;
  if (!requestId || typeof requestId !== 'string' || requestId.length > 200) fail('Buchungskennung fehlt. Ansicht neu laden.');
  if (!Number.isSafeInteger(quantity) || quantity <= 0) fail('Menge muss eine positive ganze Zahl sein.');
  const fingerprint = key(itemId, productId || null, sku || null, binCode, quantity);
  const receiptKey = key(requestId);
  const previous = order.pickWork.receipts?.[receiptKey];
  if (previous) {
    if (previous.fingerprint !== fingerprint) fail('Buchungskennung wurde für andere Daten verwendet.');
    return { work: order.pickWork, deduped: true };
  }
  if (!activeStatus(order) || order.pickWork.status !== 'active') fail('Auftrag ist nicht zum Picken freigegeben.');
  const item = order.items?.find((entry) => String(entry.id) === String(itemId));
  const line = order.pickWork.lines.find((entry) => entry.itemId === String(itemId));
  if (!item || !line) fail('Auftragsposition nicht gefunden.');
  const normalize = (value) => String(value || '').trim().toUpperCase().replace(/^SKU[-_\s]*/, '');
  const matchesId = item.productId && String(item.productId) === String(productId);
  const matchesSku = item.sku && normalize(item.sku) === normalize(sku);
  if (!matchesId && !matchesSku) fail('Gescanntes Produkt gehört nicht zur Auftragsposition.');
  if ((line.itemKey && line.itemKey !== itemKey(item)) || line.required !== Number(item.quantity)) fail('Auftragsmenge wurde geändert. Auftrag prüfen.', 'PICK_REVIEW');
  if (quantity > line.required - line.picked) fail('Menge wurde bereits gepickt oder überschreitet die offene Menge.');
  // Orders are small; bounding receipts avoids approaching Firestore's 1 MiB limit.
  if (Object.keys(order.pickWork.receipts || {}).length >= 1000) fail('Buchungsprotokoll muss geprüft werden.', 'PICK_REVIEW');
  return { deduped: false, work: {
    ...order.pickWork,
    updatedAt: new Date().toISOString(),
    lines: order.pickWork.lines.map((entry) => entry.itemId === line.itemId ? { ...entry, picked: entry.picked + quantity } : entry),
    receipts: { ...order.pickWork.receipts, [receiptKey]: { fingerprint, itemId, quantity, binCode } },
  } };
}

function validatePickTransition(order, toStatus, actor) {
  const work = order.pickWork;
  if (!work) return null;
  const lines = Array.isArray(work.lines) ? work.lines : [];
  const items = Array.isArray(order.items) ? order.items : [];
  const unchanged = items.length > 0 && items.length === lines.length && items.every((item) => {
    const matches = lines.filter((line) => line.itemId === String(item.id));
    return matches.length === 1 && matches[0].required === Number(item.quantity)
      && (!matches[0].itemKey || matches[0].itemKey === itemKey(item));
  });
  if (!unchanged && ['picked', 'packing', 'packed', 'shipped', 'cancelled'].includes(toStatus)) {
    return 'Auftragspositionen wurden geändert. Gepickte Ware prüfen.';
  }
  const complete = unchanged && lines.every((line) => line.picked === line.required);
  if (['picked', 'packing', 'packed', 'shipped'].includes(toStatus) && !complete) return 'Auftrag ist noch nicht vollständig gepickt.';
  if (toStatus === 'picked' && work.ownerUid !== actor?.uid) return 'Auftrag gehört einem anderen Mitarbeiter.';
  if (toStatus === 'cancelled' && !complete && lines.some((line) => line.picked > 0)) {
    return 'Teilweise gepickte Ware vor Stornierung prüfen und zurückbuchen.';
  }
  return null;
}

function createPickWorkService({ db, listCandidates }) {
  const assignmentRef = (tenantId, uid) => db.collection('pick_assignments').doc(key(tenantId, uid));
  async function current({ tenantId, actor }) {
    requireActor(actor, tenantId);
    const assignment = await assignmentRef(tenantId, actor.uid).get();
    const orderId = assignment.exists && assignment.data().orderId;
    if (!orderId) return null;
    const snap = await db.collection('orders').doc(orderId).get();
    if (!snap.exists || tenantOf(snap.data()) !== tenantId) return null;
    return { ...snap.data(), id: snap.id };
  }
  async function claim({ tenantId, actor, sessionId, takeover = false, orderId: requestedId = null }) {
    requireActor(actor, tenantId);
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 200) fail('Scanner-Kennung fehlt.');
    const candidates = (await listCandidates(tenantId)).filter((order) => tenantOf(order) === tenantId && activeStatus(order))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const assignment = assignmentRef(tenantId, actor.uid);
    return db.runTransaction(async (tx) => {
      const prior = await tx.get(assignment);
      const currentId = prior.exists && prior.data().orderId;
      if (currentId) {
        const ref = db.collection('orders').doc(currentId);
        const snap = await tx.get(ref);
        if (snap.exists && tenantOf(snap.data()) === tenantId && snap.data().pickWork?.ownerUid === actor.uid) {
          const order = { ...snap.data(), id: snap.id };
          const work = order.pickWork;
          if (requestedId && requestedId !== order.id && activeStatus(order)) fail('Zuerst den zugewiesenen Auftrag abschließen.');
          // No timer frees physical goods on a cart. Held/partially picked orders
          // stay assigned until an explicit, audited recovery is performed.
          const cancelledEmpty = (order.omsStatus || order.status) === 'cancelled' && work.lines.every((line) => line.picked === 0);
          if (!cancelledEmpty && !['picked', 'packing', 'packed', 'shipped', 'delivered', 'completed'].includes(order.omsStatus || order.status)) {
            if (work.sessionId !== sessionId && !takeover) fail('Auftrag ist auf einem anderen Scanner geöffnet.', 'PICK_OTHER_DEVICE');
            const next = { ...work, sessionId, token: work.sessionId === sessionId ? work.token : randomUUID(),
              status: activeStatus(order) ? 'active' : 'paused', updatedAt: new Date().toISOString() };
            tx.update(ref, { pickWork: next });
            return { ...order, pickWork: next };
          }
        }
      }
      // Read candidates within the transaction. Firestore retries a conflicting
      // order claim so two users never receive the same unclaimed order.
      for (const candidate of candidates) {
        if (requestedId && candidate.id !== requestedId) continue;
        const ref = db.collection('orders').doc(candidate.id);
        const snap = await tx.get(ref);
        if (!snap.exists) continue;
        const order = { ...snap.data(), id: snap.id };
        if (tenantOf(order) !== tenantId || !activeStatus(order) || order.pickWork || order.stockDecrementedAt) continue;
        const work = initialWork(order, actor, sessionId);
        tx.update(ref, { pickWork: work });
        tx.set(assignment, { tenantId, ownerUid: actor.uid, orderId: order.id, updatedAt: work.updatedAt });
        return { ...order, pickWork: work };
      }
      return null;
    });
  }
  async function pause({ tenantId, actor, orderId, token }) {
    const ref = db.collection('orders').doc(orderId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) fail('Auftrag nicht gefunden.');
      const order = snap.data();
      assertOwner(order, { tenantId, actor, token });
      const work = { ...order.pickWork, status: 'paused', updatedAt: new Date().toISOString() };
      tx.update(ref, { pickWork: work });
      return { ...order, id: orderId, pickWork: work };
    });
  }
  return { current, claim, pause };
}

module.exports = { createPickWorkService, preparePickBooking, validatePickTransition };
