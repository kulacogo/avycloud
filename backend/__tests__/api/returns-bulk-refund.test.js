/**
 * POST /api/returns/bulk-action (action: 'refund') — a failed marketplace refund
 * must be reported as { ok:false }, NOT { ok:true }.
 *
 * Bug (2026-07): issueMarketplaceRefund() does NOT throw on a failed refund — it
 * returns { ok:false, error }. The bulk loop pushed { returnId, ok:true }
 * regardless, so the operator believed a refund succeeded when it did not.
 * Fix mirrors the single-route guard (routes/returns.js: `if (!result.ok)`).
 *
 * Pattern: require.cache patching (no vi.mock for CJS). See returns-patch-refund.test.js.
 */

const request = require('supertest');

require('./_patchGcp');

const issueMarketplaceRefundMock = vi.fn();
const transitionReturnMock = vi.fn(async () => ({ id: 'ret-x', status: 'abgeschlossen' }));

function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}
patchCjsModule('../../services/returns-engine.js', {
  issueMarketplaceRefund: issueMarketplaceRefundMock,
  transitionReturn: transitionReturnMock,
  processReturn: vi.fn(),
  syncAllReturns: vi.fn(),
  RETURN_REASONS: [],
});

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const returnsRouter = require('../../routes/returns');

const app = createTestApp(returnsRouter.router || returnsRouter);

describe('POST /api/returns/bulk-action refund', () => {
  beforeEach(() => {
    issueMarketplaceRefundMock.mockReset();
    transitionReturnMock.mockClear();
  });

  it('reports ok:false for a return whose refund returns { ok:false }', async () => {
    issueMarketplaceRefundMock.mockImplementation(async ({ returnId }) => {
      if (returnId === 'ret-bad') return { ok: false, marketplace: 'ebay', error: 'No eBay return ID' };
      return { ok: true, marketplace: 'ebay' };
    });

    const res = await request(app)
      .post('/api/returns/bulk-action')
      .send({ returnIds: ['ret-good', 'ret-bad'], action: 'refund' });

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.results.map((r) => [r.returnId, r]));
    expect(byId['ret-good'].ok).toBe(true);
    expect(byId['ret-bad'].ok).toBe(false);
    expect(byId['ret-bad'].error).toMatch(/No eBay return ID/);
    // success counts only the genuinely successful refund
    expect(res.body.data.success).toBe(1);
  });

  it('reports ok:true only when the refund actually succeeds', async () => {
    issueMarketplaceRefundMock.mockResolvedValue({ ok: true, marketplace: 'kaufland', unitsAccepted: 1 });

    const res = await request(app)
      .post('/api/returns/bulk-action')
      .send({ returnIds: ['ret-1'], action: 'refund' });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toMatchObject({ returnId: 'ret-1', ok: true });
    expect(res.body.data.success).toBe(1);
  });

  it('still surfaces thrown errors as ok:false', async () => {
    issueMarketplaceRefundMock.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post('/api/returns/bulk-action')
      .send({ returnIds: ['ret-throw'], action: 'refund' });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toMatchObject({ returnId: 'ret-throw', ok: false, error: 'boom' });
    expect(res.body.data.success).toBe(0);
  });
});
