'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { isAvailablePick, acquirePickWork, intactPickProgress } = require('./pick-work');
const { compareBinsNear, lastPickBin } = require('./pick-route');
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const active = o => ['confirmed', 'picking'].includes(o.omsStatus || o.status);
const unfinished = o => !['picked', 'packing', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'returned'].includes(o.omsStatus || o.status);
const remaining = o => o.pickWork.lines.some(l => l.picked < l.required);
const tenantOf = o => o.tenantId || 'default';
function fail(message, code = 'PICK_CONFLICT') { throw Object.assign(new Error(message), { code, status: 409 }); }
function context({ tenantId, actor, sessionId }) {
  if (!tenantId || !actor?.uid) fail('Mitarbeiter-Anmeldung fehlt.', 'PICK_AUTH');
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 200) fail('Scanner-Kennung fehlt.');
}

function createPickRoundService({ db, listCandidates, loadStops }) {
  const refFor = (tenantId, uid) => db.collection('pick_assignments').doc(key(tenantId, uid));
  async function ownedInTx(tx, prior, candidates, tenantId, uid) {
    const ids = [...new Set([...(prior.orderIds || []), prior.orderId,
      ...candidates.filter(o => o.pickWork?.ownerUid === uid).map(o => o.id)].filter(Boolean))];
    const docs = await Promise.all(ids.map(id => tx.get(db.collection('orders').doc(id))));
    return docs.filter(d => d.exists).map(d => ({ ...d.data(), id: d.id }))
      .filter(o => tenantOf(o) === tenantId && o.pickWork?.ownerUid === uid && o.pickWork.status !== 'released');
  }
  async function next(request) {
    context(request);
    const { tenantId, actor, sessionId, takeover = false, roundId: expectedRound } = request;
    const candidates = (await listCandidates(tenantId)).filter(o => tenantOf(o) === tenantId && active(o));
    const assignment = refFor(tenantId, actor.uid);
    return db.runTransaction(async tx => {
      const snap = await tx.get(assignment); const prior = snap.exists ? snap.data() : {};
      if (expectedRound && (prior.roundId !== expectedRound || prior.roundStatus === 'ended')) fail('Pickrunde ist beendet.', 'PICK_ROUND_ENDED');
      const owned = await ownedInTx(tx, prior, candidates, tenantId, actor.uid);
      // Keep on-hold work indexed too: it is not offered, but must still be
      // fenced on scanner takeover and released by an explicit round end.
      const held = owned.filter(unfinished);
      if (held.some(o => !intactPickProgress(o))) fail('Auftragspositionen müssen geprüft werden.', 'PICK_REVIEW');
      const previousSession = prior.roundStatus === 'active' ? prior.sessionId : null;
      if (!takeover && ((previousSession && previousSession !== sessionId) || held.some(o => o.pickWork.sessionId !== sessionId))) {
        fail('Pickrunde ist auf einem anderen Scanner geöffnet.', 'PICK_OTHER_DEVICE');
      }
      const completed = held.find(o => active(o) && !remaining(o));
      if (completed) throw Object.assign(new Error('Gepickten Auftrag abschließen.'), { status: 409, code: 'PICK_COMPLETE_REQUIRED', orderId: completed.id });
      const roundId = prior.roundStatus === 'active' ? prior.roundId : randomUUID();
      const current = owned.find(o => o.id === prior.orderId);
      const anchor = lastPickBin(current) || (prior.roundStatus === 'active' ? prior.lastBinCode : null) || null;
      const offers = [...held.filter(o => active(o) && !(o.pickWork.status === 'paused' && o.pickWork.roundId === roundId)),
        ...candidates.filter(o => !held.some(h => h.id === o.id) && isAvailablePick(o))];
      let locations;
      try { locations = await loadStops({ tenantId, orders: offers, lastBinCode: anchor }); }
      catch (cause) { throw Object.assign(new Error('Pick-Route derzeit nicht verfügbar. Bitte erneut versuchen.'), { status: 503, code: 'PICK_ROUTE_UNAVAILABLE', cause }); }
      const options = offers.map(order => ({ order, stop: [...(locations.get(order.id) || [])]
        .sort((a, b) => compareBinsNear(a.binCode, b.binCode, anchor))[0] || null }))
        .sort((a, b) => compareBinsNear(a.stop?.binCode, b.stop?.binCode, anchor)
          || String(a.order.createdAt || '').localeCompare(String(b.order.createdAt || '')) || a.order.id.localeCompare(b.order.id));
      let chosen = null;
      for (const option of options) {
        const latest = await tx.get(db.collection('orders').doc(option.order.id));
        if (!latest.exists) continue;
        const order = { ...latest.data(), id: latest.id };
        if (tenantOf(order) !== tenantId || !active(order)) continue;
        const own = order.pickWork?.ownerUid === actor.uid && order.pickWork.status !== 'released';
        if (!own && !isAvailablePick(order)) continue;
        if (own && (!intactPickProgress(order) || !remaining(order))) continue;
        // Candidate locations are advisory; bookStockOut still checks the BIN
        // and central remaining quantity atomically. No stock is reserved here.
        chosen = { order, stop: option.stop, own }; break;
      }
      const now = new Date().toISOString();
      // Takeover fences ALL held orders, including a partial order not shown now.
      for (const order of held) {
        if (order.id === chosen?.order.id || order.pickWork.sessionId === sessionId) continue;
        tx.update(db.collection('orders').doc(order.id), { pickWork: { ...order.pickWork,
          sessionId, token: randomUUID(), roundId, updatedAt: now } });
      }
      if (chosen) {
        const work = chosen.own ? { ...chosen.order.pickWork, status: 'active', sessionId,
          token: chosen.order.pickWork.sessionId === sessionId ? chosen.order.pickWork.token : randomUUID(), updatedAt: now }
          : acquirePickWork(chosen.order, actor, sessionId);
        chosen.order = { ...chosen.order, pickWork: { ...work, roundId } };
        tx.update(db.collection('orders').doc(chosen.order.id), { pickWork: chosen.order.pickWork });
      }
      const orderIds = [...new Set([...held.map(o => o.id), chosen?.order.id].filter(Boolean))];
      tx.set(assignment, { ...prior, tenantId, ownerUid: actor.uid, sessionId, roundId, roundStatus: 'active',
        startedAt: prior.roundStatus === 'active' ? prior.startedAt || now : now,
        orderIds, orderId: chosen?.order.id || null, lastBinCode: anchor, updatedAt: now });
      return { roundId, order: chosen?.order || null, stop: chosen?.stop || null };
    });
  }
  async function end(request) {
    context(request);
    const { tenantId, actor, sessionId, roundId } = request;
    if (!roundId) fail('Pickrunde fehlt.');
    const candidates = (await listCandidates(tenantId)).filter(o => tenantOf(o) === tenantId);
    const assignment = refFor(tenantId, actor.uid);
    return db.runTransaction(async tx => {
      const snap = await tx.get(assignment); const prior = snap.exists ? snap.data() : {};
      if (prior.roundId !== roundId) fail('Pickrunde hat sich geändert.', 'PICK_ROUND_ENDED');
      if (prior.sessionId !== sessionId) fail('Pickrunde ist auf einem anderen Scanner geöffnet.', 'PICK_OTHER_DEVICE');
      if (prior.roundStatus === 'ended') return prior.endResult;
      const owned = await ownedInTx(tx, prior, candidates, tenantId, actor.uid);
      const held = owned.filter(unfinished);
      for (const order of held) {
        if (!intactPickProgress(order)) fail('Auftragspositionen müssen geprüft werden.', 'PICK_REVIEW');
        if (!remaining(order)) throw Object.assign(new Error('Gepickten Auftrag abschließen.'), { status: 409, code: 'PICK_COMPLETE_REQUIRED', orderId: order.id });
      }
      const now = new Date().toISOString();
      for (const order of held) {
        // Additive release state preserves the entire progress/receipt record.
        // The stock/OMS fields are deliberately untouched.
        tx.update(db.collection('orders').doc(order.id), { pickWork: { ...order.pickWork,
          status: 'released', token: randomUUID(), releasedAt: now, releasedBy: actor.uid, updatedAt: now,
          releaseHistory: { ...order.pickWork.releaseHistory, [roundId]: { ownerUid: actor.uid,
            ownerName: order.pickWork.ownerName, at: now,
            pickedByItemId: Object.fromEntries(order.pickWork.lines.map(l => [l.itemId, l.picked])) } } } });
      }
      const result = { roundId, releasedOrders: held.length, endedAt: now };
      tx.set(assignment, { ...prior, orderId: null, orderIds: [], roundStatus: 'ended', endedAt: now, updatedAt: now, endResult: result });
      return result;
    });
  }
  return { next, end };
}
module.exports = { createPickRoundService };
