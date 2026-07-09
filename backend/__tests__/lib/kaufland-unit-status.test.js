/**
 * Incident 2026-07-09: a brand-new (empty) Kaufland account showed "1 Inaktiv"
 * in the Listings view. The lone doc in `kauflandUnitsLive` was a NOT_FOUND
 * retire-tombstone (from a previous account's unit-id), and the read-path only
 * excluded STALE. This locks the tombstone-vs-listing distinction.
 */

const {
  isRetiredKauflandUnit,
  normalizeKauflandStatus,
} = require('../../lib/kaufland-unit-status');

describe('isRetiredKauflandUnit', () => {
  it('treats a NOT_FOUND tombstone as retired (the incident doc)', () => {
    const doc = {
      active: false,
      status: 'NOT_FOUND',
      notFoundReason: 'unit_not_found',
      notFoundAt: '2026-07-08T18:45:15.824Z',
    };
    expect(isRetiredKauflandUnit(doc)).toBe(true);
  });

  it('treats a STALE tombstone as retired', () => {
    expect(isRetiredKauflandUnit({ status: 'STALE' })).toBe(true);
  });

  it('is case/whitespace insensitive', () => {
    expect(isRetiredKauflandUnit({ status: ' not_found ' })).toBe(true);
    expect(isRetiredKauflandUnit({ status: 'stale' })).toBe(true);
  });

  it('treats real live units as NOT retired', () => {
    expect(isRetiredKauflandUnit({ status: 'AVAILABLE' })).toBe(false);
    expect(isRetiredKauflandUnit({ status: 'ONHOLD' })).toBe(false);
  });

  it('does not retire docs with missing/empty status (legacy real units)', () => {
    expect(isRetiredKauflandUnit({})).toBe(false);
    expect(isRetiredKauflandUnit({ status: '' })).toBe(false);
    expect(isRetiredKauflandUnit(undefined)).toBe(false);
  });

  it('normalizeKauflandStatus upper-cases and trims', () => {
    expect(normalizeKauflandStatus(' available ')).toBe('AVAILABLE');
    expect(normalizeKauflandStatus(null)).toBe('');
  });
});
