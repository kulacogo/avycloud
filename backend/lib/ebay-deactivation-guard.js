/**
 * ebay-deactivation-guard.js — durable fix for the frozen active-listing sync.
 *
 * Problem: the listing-sync deactivation has a "catastrophic collapse" ceiling
 * (default 60%). When a seller GENUINELY ends many listings (e.g. 199 of 305 =
 * 65%), a COMPLETE eBay fetch reporting that drop was permanently blocked as
 * "suspected broken fetch" — AvyCloud froze at the old count forever.
 *
 * Fix: a large drop on a COMPLETE ingest is no longer blocked forever. It must
 * be CONFIRMED across two consecutive complete ingests reporting the same active
 * set. A genuine drop persists → confirmed within ~2 sync cycles → executed. A
 * one-off broken fetch won't reproduce the same active set → never confirmed.
 * Incomplete ingests stay hard-blocked (untrustworthy).
 *
 * Pure decision function — the caller persists `observation` in the sync lock doc.
 */

'use strict';

const DEFAULTS = Object.freeze({
  conservativeRatio: 0.2,   // incomplete-ingest ceiling
  catastrophicRatio: 0.6,   // complete-ingest ceiling
  confirmWindowMs: 6 * 3600 * 1000,
  tolerance: 0.1,           // active-set size match tolerance (±10%)
  minToGuard: 5,            // below this absolute count, never guard
});

/**
 * @param {Object} p
 * @param {boolean} p.ingestComplete
 * @param {number} p.ratio - wouldDeactivate / activeDocs
 * @param {number} p.wouldDeactivate
 * @param {number} p.activeSetSize - eBay's reported active count this run
 * @param {?{activeSetSize:number, atMs:number}} p.prior - previous pending observation (from lock doc)
 * @param {number} p.nowMs
 * @param {Object} [p.options]
 * @returns {{action:'proceed'|'block'|'pending', reason:string, observation?:Object}}
 */
function decideLargeDeactivation({ ingestComplete, ratio, wouldDeactivate, activeSetSize, prior, nowMs, options } = {}) {
  const o = { ...DEFAULTS, ...(options || {}) };
  const ceiling = ingestComplete ? o.catastrophicRatio : o.conservativeRatio;

  // Ein LEERES Active-Set ("alles offline") ist immer bestätigungspflichtig —
  // minToGuard gilt hier bewusst nicht: auch 3 verbleibende Docs dürfen nicht
  // durch einen einzelnen kaputten Fetch auf null gewischt werden (2026-07-05).
  const emptySet = activeSetSize === 0 && wouldDeactivate > 0;

  // Within ceiling, or too few in absolute terms → just proceed (normal drift).
  if (!emptySet && !(ratio > ceiling && wouldDeactivate > o.minToGuard)) {
    return { action: 'proceed', reason: 'within_ceiling' };
  }

  // Over ceiling on an incomplete ingest → untrustworthy, hard block.
  if (!ingestComplete) {
    return { action: 'block', reason: 'safety_threshold_exceeded_incomplete_ingest' };
  }

  // Over the catastrophic ceiling on a COMPLETE ingest → require confirmation
  // across two consecutive complete ingests reporting the same active set.
  const observation = { activeSetSize, ratio, atMs: nowMs };
  if (prior && Number.isFinite(prior.atMs)
      && (nowMs - prior.atMs) <= o.confirmWindowMs
      && Math.abs((prior.activeSetSize || 0) - activeSetSize) <= Math.max(1, o.tolerance * activeSetSize)) {
    return { action: 'proceed', reason: 'confirmed_across_two_complete_ingests' };
  }
  return { action: 'pending', reason: 'awaiting_second_complete_ingest_confirmation', observation };
}

module.exports = { decideLargeDeactivation, DEACTIVATION_GUARD_DEFAULTS: DEFAULTS };
