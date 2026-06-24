'use strict';

/**
 * Tages-Snapshot des aktiven Marktplatz-Listing-Bestands → exakter historischer
 * "Ø Artikel online" je Zeitraum (für eBay UND Kaufland), den die Bestandsdaten
 * selbst nicht hergeben (beendete Listings tragen kein Offline-Datum).
 *
 * Geschrieben vom listing-sync-runner (1×/Tag, idempotent). Collection
 * `marketplace_daily_snapshots`, Doc-Id `${tenantId}_${YYYY-MM-DD}`. Additiv, tenant-scoped.
 */

const { firestore } = require('./firestore');

const COLLECTION = 'marketplace_daily_snapshots';

function dayKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// In-memory guard so the 15-min runner only writes once/day per instance
// (avoids ~96 redundant count-reads/writes per day).
const _lastWritten = new Map();

/** Count current active listings and upsert today's snapshot. Never throws fatally. */
async function recordDailyListingSnapshot({ tenantId = 'default', now = new Date(), force = false } = {}) {
  const date = dayKey(now);
  if (!force && _lastWritten.get(tenantId) === date) return null;
  const [ebaySnap, kauflandSnap] = await Promise.all([
    firestore.collection('ebayListingsLive').where('active', '==', true).get(),
    firestore.collection('kauflandUnitsLive').where('active', '==', true).get(),
  ]);
  const ebayActive = ebaySnap.size;
  const kauflandActive = kauflandSnap.size;
  const doc = {
    tenantId,
    date,
    ebayActive,
    kauflandActive,
    total: ebayActive + kauflandActive,
    at: now.toISOString(),
    source: 'listing-sync-runner',
  };
  await firestore.collection(COLLECTION).doc(`${tenantId}_${date}`).set(doc, { merge: true });
  _lastWritten.set(tenantId, date);
  return doc;
}

/** Snapshots whose date falls in [fromIso, toIso). Tenant-scoped; date filtered in JS. */
async function getListingSnapshotsInRange(fromIso, toIso, tenantId = 'default') {
  const from = fromIso ? dayKey(fromIso) : null;
  const toExcl = toIso ? dayKey(toIso) : null;
  const snap = await firestore.collection(COLLECTION).where('tenantId', '==', tenantId).get();
  const rows = [];
  for (const d of snap.docs) {
    const x = d.data();
    if (!x.date) continue;
    if (from && x.date < from) continue;
    if (toExcl && x.date >= toExcl) continue;
    rows.push(x);
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

/** Average of daily active counts over the snapshot days present in the window. */
function snapshotAverage(snapshots) {
  const rows = Array.isArray(snapshots) ? snapshots : [];
  if (rows.length === 0) return { avgOnline: 0, avgEbay: 0, avgKaufland: 0, days: 0 };
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    avgOnline: r1(sum('total') / rows.length),
    avgEbay: r1(sum('ebayActive') / rows.length),
    avgKaufland: r1(sum('kauflandActive') / rows.length),
    days: rows.length,
  };
}

module.exports = { recordDailyListingSnapshot, getListingSnapshotsInRange, snapshotAverage, dayKey };
