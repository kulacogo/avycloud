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

/**
 * Pure aggregation over already-fetched event arrays.
 *
 * erfasst/angereichert zählen EINDEUTIGE PRODUKTE pro Nutzer (dedupliziert über
 * resourceId/details.productId) — nicht Speichervorgänge. Wer dasselbe Produkt
 * fünfmal speichert, hat EIN Produkt angereichert. Massen-Aktionen
 * (bulk_update/bulk_import = 1 Audit-Eintrag pro Lauf ohne Produkt-ID) zählen
 * bewusst nicht — sie sind keine Einzel-Anreicherung.
 * Kommissioniert/verpackt/eingelagert bleiben Vorgangs-Zählungen (jeder Pick
 * ist reale Arbeit).
 */
function aggregatePerformance({ auditLogs = [], orderEvents = [], warehouseEvents = [] } = {}) {
  const counts = {};
  const distinct = {}; // uid -> { erfasst:Set, angereichert:Set }
  const ensure = (uid) => {
    if (!counts[uid]) {
      counts[uid] = { erfasst: 0, angereichert: 0, eingelagert: 0, kommissioniert: 0, verpackt: 0 };
      distinct[uid] = { erfasst: new Set(), angereichert: new Set() };
    }
  };
  const bump = (uid, key) => {
    if (!uid || uid === SYSTEM_UID) return;
    ensure(uid);
    counts[uid][key] += 1;
  };
  const addDistinct = (uid, key, productKey) => {
    if (!uid || uid === SYSTEM_UID || !productKey) return;
    ensure(uid);
    distinct[uid][key].add(String(productKey));
  };

  let anon = 0;
  for (const a of auditLogs) {
    const productKey = a?.resourceId || a?.details?.productId || `__eintrag_${anon++}`;
    if (a?.action === 'product.identified') addDistinct(a.userId, 'erfasst', productKey);
    else if (a?.action === 'product.updated' || a?.action === 'product.created') {
      addDistinct(a.userId, 'angereichert', productKey);
    }
  }
  for (const uid of Object.keys(distinct)) {
    counts[uid].erfasst = distinct[uid].erfasst.size;
    counts[uid].angereichert = distinct[uid].angereichert.size;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Fenster [fromMs, toMs) aus Preset ODER Kalender-Auswahl (from/to, YYYY-MM-DD,
 * inklusive Endtag). Ungültige Datumsangaben fallen auf das Preset zurück.
 */
function computeWindow({ range = 'week', from, to, now = new Date() } = {}) {
  if (DATE_RE.test(String(from || '')) && DATE_RE.test(String(to || ''))) {
    const fromMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`) + 24 * 3600 * 1000; // Endtag inklusive
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
      return { fromMs, toMs, label: `${from}–${to}` };
    }
  }
  return { fromMs: computeCutoff(range, now).getTime(), toMs: now.getTime() + 1, label: range };
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
async function getPerformance({ tenantId = 'default', range = 'week', from, to } = {}) {
  const { firestore } = require('../lib/firestore');
  const { listUsers } = require('../lib/rbac');
  const { fromMs, toMs, label } = computeWindow({ range, from, to });
  const inWindow = (t) => t >= fromMs && t < toMs;

  const safe = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      console.warn(`[performance] source fetch failed: ${e.message}`);
      return [];
    }
  };

  // Audit sources (erfasst + angereichert) — direkte Query (tenant-Equality +
  // orderBy timestamp, gleicher Index-Pfad wie queryAuditLog, aber OHNE dessen
  // 500er-Kappung: die reichte für eine Monats-Sicht nicht → Untererfassung).
  const auditLogs = (await safe(async () => {
    const snap = await firestore.collection('audit_log')
      .where('tenantId', '==', tenantId)
      .orderBy('timestamp', 'desc')
      .limit(10000)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  })).filter((a) => inWindow(toMillis(a.timestamp)));

  // Order events (kommissioniert/verpackt) — single-field orderBy, window in-memory.
  const orderEvents = (await safe(async () => {
    const snap = await firestore.collection('order_events').orderBy('timestamp', 'desc').limit(8000).get();
    return snap.docs.map((d) => d.data());
  })).filter((e) => (!e.tenantId || e.tenantId === tenantId) && inWindow(toMillis(e.timestamp)));

  // Warehouse events (eingelagert) — single-field orderBy, window in-memory.
  const warehouseEvents = (await safe(async () => {
    const snap = await firestore.collection('warehouseEvents').orderBy('createdAt', 'desc').limit(8000).get();
    return snap.docs.map((d) => d.data());
  })).filter((w) => inWindow(toMillis(w.createdAt)));

  const counts = aggregatePerformance({ auditLogs, orderEvents, warehouseEvents });
  console.log(`[performance] window=${label} audit=${auditLogs.length} orders=${orderEvents.length} warehouse=${warehouseEvents.length} people=${Object.keys(counts).length}`);

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

  return { range: label, rows };
}

module.exports = { aggregatePerformance, computeCutoff, computeWindow, getPerformance };
