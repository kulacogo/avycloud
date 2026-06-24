'use strict';

// Pure helpers only (Firestore I/O covered via the orchestrator integration).
const { snapshotAverage, dayKey } = require('../../lib/listing-snapshot');

describe('snapshotAverage', () => {
  it('averages daily active counts across the snapshot days present', () => {
    const r = snapshotAverage([
      { date: '2026-06-01', ebayActive: 100, kauflandActive: 20, total: 120 },
      { date: '2026-06-02', ebayActive: 140, kauflandActive: 0, total: 140 },
    ]);
    expect(r.avgOnline).toBe(130); // (120 + 140) / 2
    expect(r.avgEbay).toBe(120); // (100 + 140) / 2
    expect(r.avgKaufland).toBe(10); // (20 + 0) / 2
    expect(r.days).toBe(2);
  });

  it('returns zeros for an empty set', () => {
    expect(snapshotAverage([])).toMatchObject({ avgOnline: 0, days: 0 });
  });
});

describe('dayKey', () => {
  it('formats a date as UTC YYYY-MM-DD', () => {
    expect(dayKey('2026-06-24T22:30:00Z')).toBe('2026-06-24');
  });
});
