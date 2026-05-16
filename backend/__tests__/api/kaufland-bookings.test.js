/**
 * Integration tests for GET /api/marketplace/kaufland/bookings — verifies
 * Reports API payout aggregation flows through the route correctly.
 *
 * Reverse-drift detection in the kaufland-listings-sync service is covered
 * in __tests__/services/kaufland-listings-sync.test.js (extracted Plan-D.0d).
 *
 * Pattern: require.cache patching (no vi.mock for CJS). See _patchGcp.js +
 * _patchLocalModules.js + _setupMocks.js.
 */

const request = require('supertest');

require('./_patchGcp');
const { spies: localSpies } = require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const marketplaceRouter = require('../../routes/marketplace');

const app = createTestApp(marketplaceRouter);

// ─────────────────────────────────────────────────────────────────────────────
// GET /kaufland/bookings route
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/marketplace/kaufland/bookings', () => {
  beforeEach(() => {
    localSpies.kauflandGetBookings.mockReset();
  });

  it('returns 400 when from is missing or malformed', async () => {
    const res = await request(app).get('/api/kaufland/bookings').query({ to: '2026-01-31' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    expect(localSpies.kauflandGetBookings).not.toHaveBeenCalled();
  });

  it('returns 400 when to is missing or malformed', async () => {
    const res = await request(app)
      .get('/api/kaufland/bookings')
      .query({ from: '2026-01-01', to: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
  });

  it('returns 200 with aggregated payout data on success', async () => {
    localSpies.kauflandGetBookings.mockResolvedValue({
      from: '2026-01-01',
      to: '2026-01-31',
      storefront: 'de',
      bookings: [
        { amount_cents: 12345, currency: 'EUR', type: 'PAYOUT', date: '2026-01-15', order_id: 'KL-1', raw: {} },
        { amount_cents: 6789, currency: 'EUR', type: 'PAYOUT', date: '2026-01-20', order_id: 'KL-2', raw: {} },
      ],
      count: 2,
      total_payout_cents: 19134,
      total_payout_eur: 191.34,
      currency: 'EUR',
      reportId: 99887,
      reportUrl: 'https://kaufland.de/report_files/99887/',
      endpointUsed: '/reports/bookings-new',
    });

    const res = await request(app)
      .get('/api/kaufland/bookings')
      .query({ from: '2026-01-01', to: '2026-01-31', storefront: 'de' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      from: '2026-01-01',
      to: '2026-01-31',
      storefront: 'de',
      total_payout_cents: 19134,
      total_payout_eur: 191.34,
      currency: 'EUR',
      count: 2,
      reportId: 99887,
      endpointUsed: '/reports/bookings-new',
    });
    expect(res.body.data.bookings).toHaveLength(2);
    expect(localSpies.kauflandGetBookings).toHaveBeenCalledWith({
      from: '2026-01-01',
      to: '2026-01-31',
      storefront: 'de',
      limit: 0,
      offset: 0,
    });
  });

  it('passes limit and offset to getBookings when provided', async () => {
    localSpies.kauflandGetBookings.mockResolvedValue({
      from: '2026-01-01', to: '2026-01-31', storefront: 'de',
      bookings: [], count: 0, total_payout_cents: 0, total_payout_eur: 0,
      currency: 'EUR', reportId: 1, reportUrl: 'u', endpointUsed: '/reports/bookings-new',
    });
    await request(app)
      .get('/api/kaufland/bookings')
      .query({ from: '2026-01-01', to: '2026-01-31', limit: 50, offset: 100 });
    expect(localSpies.kauflandGetBookings).toHaveBeenCalledWith({
      from: '2026-01-01', to: '2026-01-31', storefront: 'de', limit: 50, offset: 100,
    });
  });

  it('returns 504 when getBookings reports a timeout', async () => {
    const err = new Error('Kaufland bookings report 123 did not finish within 60000ms');
    err.code = 'KAUFLAND_BOOKINGS_TIMEOUT';
    localSpies.kauflandGetBookings.mockRejectedValue(err);
    const res = await request(app)
      .get('/api/kaufland/bookings')
      .query({ from: '2026-01-01', to: '2026-01-31' });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('KAUFLAND_BOOKINGS_TIMEOUT');
  });

  it('returns 502 when no known endpoint path responds', async () => {
    const err = new Error('Kaufland bookings report could not be queued at any known path');
    err.code = 'KAUFLAND_BOOKINGS_ENDPOINT_UNKNOWN';
    localSpies.kauflandGetBookings.mockRejectedValue(err);
    const res = await request(app)
      .get('/api/kaufland/bookings')
      .query({ from: '2026-01-01', to: '2026-01-31' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('KAUFLAND_BOOKINGS_ENDPOINT_UNKNOWN');
  });

  it('returns 500 with structured error on unexpected failure', async () => {
    localSpies.kauflandGetBookings.mockRejectedValue(new Error('boom'));
    const res = await request(app)
      .get('/api/kaufland/bookings')
      .query({ from: '2026-01-01', to: '2026-01-31' });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toBe('boom');
  });
});
