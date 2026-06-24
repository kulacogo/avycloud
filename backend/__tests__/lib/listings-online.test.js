'use strict';

const { computeOnlineListings, avgConcurrent } = require('../../lib/listings-online');

const NOW = '2026-06-24T00:00:00Z';
const JUNE = { fromIso: '2026-06-01T00:00:00Z', toIso: '2026-07-01T00:00:00Z' };

// helpers to build listings
const live = (startTime) => ({ active: true, startTime });
const ended = (startTime, endIso) => ({ active: false, startTime, endedAtIso: endIso });

describe('avgConcurrent — time-weighted average online count', () => {
  it('a listing online for the entire window counts as 1.0', () => {
    const v = avgConcurrent([live('2026-05-01T00:00:00Z')], JUNE.fromIso, JUNE.toIso, '2026-07-01T00:00:00Z');
    expect(v).toBeCloseTo(1.0, 1);
  });

  it('two listings online the whole window count as 2.0', () => {
    const v = avgConcurrent([live('2026-05-01T00:00:00Z'), live('2026-04-01T00:00:00Z')], JUNE.fromIso, JUNE.toIso, '2026-07-01T00:00:00Z');
    expect(v).toBeCloseTo(2.0, 1);
  });

  it('a listing online for exactly half the window counts as ~0.5', () => {
    // ends 2026-06-16 (15 of 30 days)
    const v = avgConcurrent([ended('2026-05-01T00:00:00Z', '2026-06-16T00:00:00Z')], JUNE.fromIso, JUNE.toIso, '2026-07-01T00:00:00Z');
    expect(v).toBeCloseTo(0.5, 1);
  });

  it('a listing that starts mid-window is only counted for the part it was online', () => {
    // active, started 2026-06-21 → online 10 of 30 days (to 2026-07-01)
    const v = avgConcurrent([live('2026-06-21T00:00:00Z')], JUNE.fromIso, JUNE.toIso, '2026-07-01T00:00:00Z');
    expect(v).toBeCloseTo(10 / 30, 1);
  });

  it('a listing entirely outside the window contributes 0', () => {
    const v = avgConcurrent([ended('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')], JUNE.fromIso, JUNE.toIso, '2026-07-01T00:00:00Z');
    expect(v).toBe(0);
  });

  it('falls back to lastSeenAt when an inactive listing has no explicit end', () => {
    const l = { active: false, startTime: '2026-05-01T00:00:00Z', lastSeenAt: '2026-06-16T00:00:00Z' };
    const v = avgConcurrent([l], JUNE.fromIso, JUNE.toIso, '2026-07-01T00:00:00Z');
    expect(v).toBeCloseTo(0.5, 1);
  });

  it('ignores listings with no startTime', () => {
    expect(avgConcurrent([{ active: true }], JUNE.fromIso, JUNE.toIso, NOW)).toBe(0);
  });

  it('EXCLUDES inactive listings with no datable end (never fakes "still online")', () => {
    // Only startTime, inactive, no end/lastSeenAt → we cannot know when it went offline.
    const l = { active: false, startTime: '2026-04-08T00:00:00Z' };
    expect(avgConcurrent([l], JUNE.fromIso, JUNE.toIso, '2026-07-01T00:00:00Z')).toBe(0);
  });
});

describe('computeOnlineListings', () => {
  const listings = [
    live('2026-05-01T00:00:00Z'), // online all June
    live('2026-04-01T00:00:00Z'), // online all June
    ended('2026-05-01T00:00:00Z', '2026-06-16T00:00:00Z'), // half June
    { active: true }, // no startTime → ignored for avg, but counts as active
  ];

  it('reports avgOnline, currentActive, total and coverage', () => {
    const r = computeOnlineListings(listings, { fromIso: JUNE.fromIso, toIso: JUNE.toIso, nowIso: '2026-07-01T00:00:00Z' });
    expect(r.avgOnline).toBeCloseTo(2.5, 1); // 1 + 1 + 0.5 + 0
    expect(r.currentActive).toBe(3); // three active=true
    expect(r.total).toBe(4);
    expect(r.coverage).toBeCloseTo(75, 0); // 3 of 4 have startTime
  });

  it('handles an empty collection safely', () => {
    const r = computeOnlineListings([], { fromIso: JUNE.fromIso, toIso: JUNE.toIso, nowIso: NOW });
    expect(r).toMatchObject({ avgOnline: 0, currentActive: 0, total: 0 });
  });
});
