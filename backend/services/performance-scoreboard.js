'use strict';

/**
 * performance-scoreboard.js — per-employee work counts for the Mitarbeiter-Leistung view.
 *
 * Sources (who-did-it must be recorded at the source):
 *   erfasst        ← audit_log action=product.identified  (userId)
 *   angereichert   ← audit_log action=product.updated|product.created (userId)
 *   eingelagert    ← warehouseEvents type=stock_in         (meta.actor.uid)
 *   kommissioniert ← order_events toStatus=picked          (actor.uid)
 *   verpackt       ← order_events toStatus=packed          (actor.uid)
 *
 * Automatic/system actors (uid 'system') are never counted. Metrics that need
 * newly-added tracking (erfasst/eingelagert) only count from the deploy day —
 * they are not retroactive.
 */

const SYSTEM_UID = 'system';

/** Pure aggregation over already-fetched event arrays. */
function aggregatePerformance({ auditLogs = [], orderEvents = [], warehouseEvents = [] } = {}) {
  const counts = {};
  const bump = (uid, key) => {
    if (!uid || uid === SYSTEM_UID) return;
    if (!counts[uid]) counts[uid] = { erfasst: 0, angereichert: 0, eingelagert: 0, kommissioniert: 0, verpackt: 0 };
    counts[uid][key] += 1;
  };

  const ANGEREICHERT_ACTIONS = new Set([
    'product.updated', 'product.created', 'product.bulk_update', 'product.bulk_import',
  ]);
  for (const a of auditLogs) {
    if (a?.action === 'product.identified') bump(a.userId, 'erfasst');
    else if (ANGEREICHERT_ACTIONS.has(a?.action)) bump(a.userId, 'angereichert');
  }
  for (const e of orderEvents) {
    if (e?.toStatus === 'picked') bump(e?.actor?.uid, 'kommissioniert');
    else if (e?.toStatus === 'packed') bump(e?.actor?.uid, 'verpackt');
  }
  for (const w of warehouseEvents) {
    if (w?.type === 'stock_in') bump(w?.meta?.actor?.uid, 'eingelagert');
  }

  return counts;
}

/** Start of the requested window. */
function computeCutoff(range, now = new Date()) {
  if (range === 'today') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (range === 'month') return new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  return new Date(now.getTime() - 7 * 24 * 3600 * 1000); // 'week' default
}

/** Milliseconds from an ISO string, a Firestore Timestamp, or a Date. */
function toMillis(v) {
  if (!v) return 0;
  if (typeof v === 'string') return Date.parse(v) || 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (v instanceof Date) return v.getTime();
  return 0;
}

/**
 * Fetch the window + aggregate + join names.
 *
 * IMPORTANT: these event collections (audit_log/order_events/warehouseEvents)
 * have single-field index exemptions on their time fields, so a `where(time>=x)`
 * range query fails. We therefore mirror the known-working pattern: fetch recent
 * docs via the indexed path (queryAuditLog for audit; orderBy(time desc) for the
 * others) and filter the window in-memory. Each source is defensive — a failure
 * degrades that one metric to 0 rather than breaking the scoreboard.
 */
async function getPerformance({ tenantId = 'default', range = 'week' } = {}) {
  const { firestore } = require('../lib/firestore');
  const { listUsers } = require('../lib/rbac');
  const { queryAuditLog } = require('./audit-log');
  const cutoffMs = computeCutoff(range).getTime();

  const safe = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      console.warn(`[performance] source fetch failed: ${e.message}`);
      return [];
    }
  };

  // Audit sources (erfasst + angereichert) — via the indexed queryAuditLog.
  const auditLogs = (await safe(() => queryAuditLog({ tenantId, limit: 500 })))
    .filter((a) => toMillis(a.timestamp) >= cutoffMs);

  // Order events (kommissioniert/verpackt) — single-field orderBy, window in-memory.
  const orderEvents = (await safe(async () => {
    const snap = await firestore.collection('order_events').orderBy('timestamp', 'desc').limit(3000).get();
    return snap.docs.map((d) => d.data());
  })).filter((e) => (!e.tenantId || e.tenantId === tenantId) && toMillis(e.timestamp) >= cutoffMs);

  // Warehouse events (eingelagert) — single-field orderBy, window in-memory.
  const warehouseEvents = (await safe(async () => {
    const snap = await firestore.collection('warehouseEvents').orderBy('createdAt', 'desc').limit(4000).get();
    return snap.docs.map((d) => d.data());
  })).filter((w) => toMillis(w.createdAt) >= cutoffMs);

  const counts = aggregatePerformance({ auditLogs, orderEvents, warehouseEvents });
  console.log(`[performance] range=${range} audit=${auditLogs.length} orders=${orderEvents.length} warehouse=${warehouseEvents.length} people=${Object.keys(counts).length}`);

  // Join names from the user list (uid → Vorname Nachname / E-Mail).
  const users = await safe(() => listUsers({ limit: 1000 }));
  const nameByUid = new Map(
    users.map((u) => {
      const uid = u.uid || u.id;
      const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      return [uid, { name: u.displayName || full || u.username || u.email || uid, email: u.email || null }];
    })
  );

  const rows = Object.entries(counts).map(([uid, c]) => ({
    uid,
    name: nameByUid.get(uid)?.name || uid,
    email: nameByUid.get(uid)?.email || null,
    ...c,
  }));
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return { range, rows };
}

module.exports = { aggregatePerformance, computeCutoff, getPerformance };
