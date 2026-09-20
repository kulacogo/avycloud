'use strict';

/**
 * performance-scoreboard.js — per-employee work counts for the Mitarbeiter-Leistung view.
 *
 * Sources (who-did-it must be recorded at the source):
 *   erfasst        ← audit_log action=product.identified  (userId)
 *   angereichert   ← legacy raw save count; NOT proof of enrichment
 *   productCareEdited ← meaningful data changes/readiness, see classifyCareEvent
 *   eingelagert    ← warehouseEvents type=stock_in         (meta.actor.uid)
 *   kommissioniert ← order_events toStatus=picked          (actor.uid)
 *   verpackt       ← order_events toStatus=packed          (actor.uid)
 *
 * Automatic/system actors (uid 'system') are never counted. Metrics that need
 * newly-added tracking (erfasst/eingelagert) only count from the deploy day —
 * they are not retroactive.
 */

const SYSTEM_UID = 'system';
const { classifyCareEvent } = require('../lib/product-care-evidence');

/**
 * Pure aggregation over already-fetched event arrays.
 *
 * erfasst/angereichert zählen EINDEUTIGE PRODUKTE pro Nutzer (dedupliziert über
 * resourceId/details.productId) — nicht Speichervorgänge. Wer dasselbe Produkt
 * fünfmal speichert, hat EIN gespeichertes Produkt (keinen Pflegebeleg). Massen-Aktionen
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

/** Credit documented data work or a human readiness completion once per product
 * and account. Capturing photos is a separate task and never cancels this work.
 * Existing raw save counts remain unchanged; missing legacy evidence is not invented. */
function productCareEvidence(auditLogs = []) {
  const byUser = new Map();
  for (const event of auditLogs) {
    const uid = event?.userId;
    const id = event?.resourceId || event?.details?.productId;
    if (!uid || uid === SYSTEM_UID || !id || !['product.updated', 'product.created'].includes(event.action)) continue;
    if (!byUser.has(uid)) byUser.set(uid, { edited: new Set(), content: new Set(), ready: new Set() });
    const entry = byUser.get(uid);
    const { edited, ready } = classifyCareEvent(event);
    if (edited || ready) entry.edited.add(String(id));
    if (edited) entry.content.add(String(id));
    if (ready) entry.ready.add(String(id));
  }
  return Object.fromEntries([...byUser].map(([uid, entry]) => [uid, { productCareEdited: entry.edited.size, productContentEdited: entry.content.size, productReady: entry.ready.size }]));
}

/** Legacy overlap metadata retained for API compatibility; no longer deducted
 * from care credit because photographing and enriching are separate work. */
function productCareOverlaps(auditLogs = []) {
  const byUser = new Map();
  for (const event of auditLogs) {
    const uid = event?.userId;
    const id = event?.resourceId || event?.details?.productId;
    if (!uid || uid === SYSTEM_UID || !id) continue;
    if (!byUser.has(uid)) byUser.set(uid, { captured: new Set(), cared: new Set() });
    const entry = byUser.get(uid);
    if (event.action === 'product.identified') entry.captured.add(String(id));
    else if (event.action === 'product.created' || event.action === 'product.updated') entry.cared.add(String(id));
  }
  return Object.fromEntries([...byUser].map(([uid, entry]) => [uid, [...entry.cared].filter((id) => entry.captured.has(id)).length]));
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
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  return 0;
}

/** Coverage is independent of the selected user; missing data must not become a low score. */
function sourceCoverage(rows, limit, timeField, fromMs) {
  const times = rows.map((row) => toMillis(row?.[timeField]));
  if (times.some((time) => !Number.isFinite(time) || time <= 0)) return 'limited';
  if (rows.length >= limit && Math.min(...times) >= fromMs) return 'limited';
  return 'complete';
}

// Legacy untagged events belong only to the original tenant, never every tenant.
function belongsToTenant(event, tenantId) {
  return (event?.tenantId || event?.meta?.tenantId || 'default') === tenantId;
}

/**
 * Fetch the window + aggregate + join names.
 *
 * IMPORTANT: these event collections (audit_log/order_events/warehouseEvents)
 * have single-field index exemptions on their time fields, so a `where(time>=x)`
 * range query fails. We therefore mirror the known-working pattern: fetch recent
 * docs via the indexed path (queryAuditLog for audit; orderBy(time desc) for the
 * others) and filter the window in-memory. Available detail counts remain visible if one source fails, but dataQuality
 * then explicitly prevents any combined assessment from incomplete counts.
 */
async function getPerformance({ tenantId = 'default', range = 'week', from, to } = {}) {
  const { firestore } = require('../lib/firestore');
  const { listUsers } = require('../lib/rbac');
  const { fromMs, toMs, label } = computeWindow({ range, from, to });
  const inWindow = (t) => t >= fromMs && t < toMs;

  const sources = {};
  const safe = async (name, limit, timeField, fn) => {
    try {
      const rows = await fn();
      if (name) sources[name] = sourceCoverage(rows, limit, timeField, fromMs);
      return rows;
    } catch (e) {
      if (name) sources[name] = 'unavailable';
      console.warn(`[performance] source fetch failed: ${e.message}`);
      return [];
    }
  };

  // Audit sources (erfasst + angereichert) — direkte Query (tenant-Equality +
  // orderBy timestamp, gleicher Index-Pfad wie queryAuditLog, aber OHNE dessen
  // 500er-Kappung: die reichte für eine Monats-Sicht nicht → Untererfassung).
  const auditLogs = (await safe('audit', 10000, 'timestamp', async () => {
    const snap = await firestore.collection('audit_log')
      .where('tenantId', '==', tenantId)
      .orderBy('timestamp', 'desc')
      .limit(10000)
      .get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  })).filter((a) => inWindow(toMillis(a.timestamp)));

  // Order events (kommissioniert/verpackt) — single-field orderBy, window in-memory.
  const orderEvents = (await safe('orders', 8000, 'timestamp', async () => {
    const snap = await firestore.collection('order_events').orderBy('timestamp', 'desc').limit(8000).get();
    return snap.docs.map((d) => d.data());
  })).filter((e) => belongsToTenant(e, tenantId) && inWindow(toMillis(e.timestamp)));

  // Warehouse events (eingelagert) — single-field orderBy, window in-memory.
  const warehouseEvents = (await safe('warehouse', 8000, 'createdAt', async () => {
    const snap = await firestore.collection('warehouseEvents').orderBy('createdAt', 'desc').limit(8000).get();
    return snap.docs.map((d) => d.data());
  })).filter((w) => belongsToTenant(w, tenantId) && inWindow(toMillis(w.createdAt)));

  const counts = aggregatePerformance({ auditLogs, orderEvents, warehouseEvents });
  console.log(`[performance] window=${label} audit=${auditLogs.length} orders=${orderEvents.length} warehouse=${warehouseEvents.length} people=${Object.keys(counts).length}`);

  // Join names from the user list (uid → Vorname Nachname / E-Mail).
  const users = await safe(null, 1000, null, () => listUsers({ limit: 1000 }));
  const nameByUid = new Map(
    users.map((u) => {
      const uid = u.uid || u.id;
      const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
      return [uid, { name: u.displayName || full || u.username || u.email || uid, email: u.email || null }];
    })
  );

  const careOverlaps = productCareOverlaps(auditLogs);
  const careEvidence = productCareEvidence(auditLogs);
  const rows = Object.entries(counts).map(([uid, c]) => ({
    uid,
    name: nameByUid.get(uid)?.name || uid,
    email: nameByUid.get(uid)?.email || null,
    ...c,
    productCareOverlap: careOverlaps[uid] || 0,
    ...(careEvidence[uid] || { productCareEdited: 0, productContentEdited: 0, productReady: 0 }),
  }));
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return { range: label, rows, contributionDataVersion: 3, dataQuality: { complete: Object.values(sources).every((status) => status === 'complete'), sources } };
}

module.exports = { aggregatePerformance, computeCutoff, computeWindow, getPerformance, sourceCoverage, belongsToTenant, productCareOverlaps, productCareEvidence };
