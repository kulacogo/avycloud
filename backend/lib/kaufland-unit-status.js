/**
 * Kaufland mirror status helpers.
 *
 * The `kauflandUnitsLive` cache holds two kinds of docs:
 *   - REAL listings — synced from Kaufland's /units API (status AVAILABLE / ONHOLD,
 *     carrying id_offer / ean / storefront / price fields).
 *   - RETIRE TOMBSTONES — internal markers, NOT listings:
 *       STALE      → unit no longer returned by Kaufland's /units API
 *                    (see kaufland-listings-sync reverse-drift detection).
 *       NOT_FOUND  → written by stock-sync-dispatcher.retireKauflandUnit() after a
 *                    Kaufland 404 (unit does not exist — e.g. a unit-id left over
 *                    from a previous Kaufland account). Field-shape: just
 *                    { active:false, status:'NOT_FOUND', notFoundReason, notFoundAt }.
 *
 * Tombstones exist only to stop the resolver/sync from re-selecting a dead unit.
 * They are NEITHER active nor inactive listings and MUST never surface in the
 * Kaufland Listings view or its counts. This is the single source of truth for
 * that distinction so read-paths can't drift (Incident 2026-07-09: a lone
 * NOT_FOUND tombstone showed as "1 Inaktiv" on a brand-new, empty account).
 */

const RETIRED_KAUFLAND_STATUSES = new Set(['STALE', 'NOT_FOUND']);

function normalizeKauflandStatus(status) {
  return String(status || '').trim().toUpperCase();
}

/**
 * True when a `kauflandUnitsLive` doc is a retire/tombstone marker rather than a
 * real listing — such docs must be excluded from the Listings view and counts.
 * @param {object} doc raw Firestore doc data
 * @returns {boolean}
 */
function isRetiredKauflandUnit(doc = {}) {
  return RETIRED_KAUFLAND_STATUSES.has(normalizeKauflandStatus(doc && doc.status));
}

module.exports = {
  RETIRED_KAUFLAND_STATUSES,
  normalizeKauflandStatus,
  isRetiredKauflandUnit,
};
