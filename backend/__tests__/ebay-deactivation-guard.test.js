'use strict';

const { decideLargeDeactivation } = require('../lib/ebay-deactivation-guard');

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-06-22T18:00:00Z');
const opts = { conservativeRatio: 0.2, catastrophicRatio: 0.6, confirmWindowMs: 6 * HOUR, tolerance: 0.1, minToGuard: 5 };

describe('decideLargeDeactivation', () => {
  it('proceeds when the drop is within the ceiling (normal drift)', () => {
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 0.1, wouldDeactivate: 30, activeSetSize: 300, prior: null, nowMs: NOW, options: opts });
    expect(d.action).toBe('proceed');
  });

  it('proceeds when only a few would deactivate, even above ratio (small absolute count)', () => {
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 0.9, wouldDeactivate: 4, activeSetSize: 5, prior: null, nowMs: NOW, options: opts });
    expect(d.action).toBe('proceed');
  });

  it('BLOCKS a large drop on an INCOMPLETE ingest (untrustworthy fetch)', () => {
    const d = decideLargeDeactivation({ ingestComplete: false, ratio: 0.65, wouldDeactivate: 199, activeSetSize: 106, prior: null, nowMs: NOW, options: opts });
    expect(d.action).toBe('block');
    expect(d.reason).toMatch(/incomplete/i);
  });

  // ── the bug case: complete ingest, genuine large drop ─────────────────
  it('on the FIRST complete-ingest large drop: pending (records observation), does not act yet', () => {
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 0.65, wouldDeactivate: 199, activeSetSize: 106, prior: null, nowMs: NOW, options: opts });
    expect(d.action).toBe('pending');
    expect(d.observation).toMatchObject({ activeSetSize: 106, atMs: NOW });
  });

  it('on the SECOND consecutive complete-ingest confirming the same drop: proceeds', () => {
    const prior = { activeSetSize: 106, ratio: 0.65, atMs: NOW - 30 * 60 * 1000 }; // 30 min ago
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 0.65, wouldDeactivate: 199, activeSetSize: 106, prior, nowMs: NOW, options: opts });
    expect(d.action).toBe('proceed');
    expect(d.reason).toMatch(/confirmed/i);
  });

  it('does NOT confirm a stale prior observation (outside the window) → pending again', () => {
    const prior = { activeSetSize: 106, ratio: 0.65, atMs: NOW - 10 * HOUR }; // older than 6h window
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 0.65, wouldDeactivate: 199, activeSetSize: 106, prior, nowMs: NOW, options: opts });
    expect(d.action).toBe('pending');
  });

  it('does NOT confirm when the prior active-set size differs materially (inconsistent fetches) → pending', () => {
    const prior = { activeSetSize: 250, ratio: 0.18, atMs: NOW - 30 * 60 * 1000 }; // very different active set
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 0.65, wouldDeactivate: 199, activeSetSize: 106, prior, nowMs: NOW, options: opts });
    expect(d.action).toBe('pending');
  });

  it('confirms within tolerance (active set 106 vs prior 110 — same genuine drop)', () => {
    const prior = { activeSetSize: 110, ratio: 0.64, atMs: NOW - 20 * 60 * 1000 };
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 0.65, wouldDeactivate: 199, activeSetSize: 106, prior, nowMs: NOW, options: opts });
    expect(d.action).toBe('proceed');
  });

  // ── Leeres Active-Set (0 Angebote online) — 2026-07-05 ────────────────
  // Ein leeres Set umgeht NIE die Bestätigung, auch nicht bei kleinen
  // absoluten Zahlen (minToGuard gilt hier nicht: "alles weg" ist immer
  // bestätigungspflichtig, egal ob 3 oder 300 Docs betroffen sind).
  it('empty set: FIRST complete ingest → pending, even with tiny absolute count', () => {
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 1, wouldDeactivate: 4, activeSetSize: 0, prior: null, nowMs: NOW, options: opts });
    expect(d.action).toBe('pending');
    expect(d.observation).toMatchObject({ activeSetSize: 0, atMs: NOW });
  });

  it('empty set: SECOND matching complete ingest → proceed', () => {
    const prior = { activeSetSize: 0, ratio: 1, atMs: NOW - 30 * 60 * 1000 };
    const d = decideLargeDeactivation({ ingestComplete: true, ratio: 1, wouldDeactivate: 56, activeSetSize: 0, prior, nowMs: NOW, options: opts });
    expect(d.action).toBe('proceed');
  });

  it('empty set: INCOMPLETE ingest → hard block', () => {
    const d = decideLargeDeactivation({ ingestComplete: false, ratio: 1, wouldDeactivate: 56, activeSetSize: 0, prior: null, nowMs: NOW, options: opts });
    expect(d.action).toBe('block');
  });
});
