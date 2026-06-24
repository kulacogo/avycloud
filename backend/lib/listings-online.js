'use strict';

/**
 * "Ø Artikel online" — zeit­gewichteter Durchschnitt aktiver Marktplatz-Listings
 * über einen Zeitraum (NICHT neu eingestellte, sondern durchgängig online stehende).
 * Hypothese des Owners: je mehr Artikel online, desto mehr Verkäufe.
 *
 * Datenbasis: eBay (`ebayListingsLive`) hat `startTime` (Listing live) + Ende
 * (`endedAtIso` > `endTime` > `lastSeenAt`-Proxy). Kaufland hat KEINEN Start-
 * Zeitstempel → historisch nicht berechenbar (Aufrufer behandelt das separat).
 *
 * Reine Funktionen ohne Firestore — vollständig unit-getestet (listings-online.test.js).
 */

const DAY_MS = 86400000;

function parseMs(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') {
    try { return v.toDate().getTime(); } catch { return null; }
  }
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return null;
}

function isActive(l) {
  return l && (l.active === true || l.listingStatus === 'Active' || l.listingStatus === 'active');
}

/**
 * Online-Intervall [start, end) eines Listings in ms, oder null wenn kein Start bekannt.
 * end = jetzt (aktiv) bzw. endedAtIso > endTime > lastSeenAt (beendet).
 */
function listingInterval(l, nowMs) {
  const s = parseMs(l && l.startTime);
  if (s == null) return null;
  let e;
  if (isActive(l)) {
    e = nowMs; // online now → ongoing
  } else {
    // Inactive: only a DATED end is trustworthy. endedAtIso (manual) > endTime
    // (eBay scheduled) > lastSeenAt (last observed). If none exist we CANNOT date
    // when it went offline → exclude (return null) rather than fake "still online".
    e = parseMs(l.endedAtIso);
    if (e == null) e = parseMs(l.endTime);
    if (e == null) e = parseMs(l.lastSeenAt);
  }
  if (e == null || e <= s) return null;
  return [s, e];
}

/**
 * Zeit­gewichteter Durchschnitt der gleichzeitig online stehenden Listings im Fenster
 * = Σ Überlappung(Listing-Intervall, Fenster) / Fensterlänge.
 */
function avgConcurrent(listings, fromIso, toIso, nowIso) {
  const W0 = parseMs(fromIso);
  const W1 = parseMs(toIso);
  const now = parseMs(nowIso);
  if (W0 == null || W1 == null || !(W1 > W0)) return 0;
  let sumMs = 0;
  for (const l of listings || []) {
    const iv = listingInterval(l, now);
    if (!iv) continue;
    const os = Math.max(iv[0], W0);
    const oe = Math.min(iv[1], W1);
    if (oe > os) sumMs += oe - os;
  }
  return Math.round((sumMs / (W1 - W0)) * 10) / 10;
}

function computeOnlineListings(listings, { fromIso, toIso, nowIso, buckets = [] } = {}) {
  const arr = Array.isArray(listings) ? listings : [];
  const now = parseMs(nowIso);
  const avgOnline = avgConcurrent(arr, fromIso, toIso, nowIso);
  const currentActive = arr.filter(isActive).length;
  // Coverage = listings whose online interval is datable (active, or ended WITH a date).
  // Low coverage means many ended listings lack offline timestamps → historical undercount.
  const withInterval = arr.filter((l) => listingInterval(l, now) != null).length;
  const perBucket = (buckets || []).map((b) => ({
    date: b.date,
    avgOnline: avgConcurrent(arr, b.fromIso, b.toIso, nowIso),
  }));
  return {
    avgOnline,
    currentActive,
    total: arr.length,
    datableCount: withInterval,
    coverage: arr.length ? Math.round((withInterval / arr.length) * 1000) / 10 : null,
    perBucket,
  };
}

module.exports = { computeOnlineListings, avgConcurrent, listingInterval };
