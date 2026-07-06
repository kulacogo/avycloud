/**
 * PATCH /api/returns/:id — refundAmount + reason dürfen bei gleichzeitigem
 * Statuswechsel NICHT verworfen werden.
 *
 * Vorher: der Status-Zweig rief transitionReturn ohne refundAmount auf und
 * returnte early — der Operator korrigierte den Erstattungsbetrag, bekam
 * ok:true, aber der Betrag war weg.
 */

const request = require('supertest');

require('./_patchGcp');

// returns-engine VOR dem Route-Require mocken (lazy require im Handler)
const transitionReturnMock = vi.fn(async () => ({ id: 'ret-1', status: 'erstattet' }));
function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath, filename: resolvedPath, loaded: true,
    exports: mockExports, children: [], paths: [],
  };
}
patchCjsModule('../../services/returns-engine.js', {
  transitionReturn: transitionReturnMock,
  issueMarketplaceRefund: vi.fn(),
  processReturn: vi.fn(),
  syncAllReturns: vi.fn(),
  RETURN_REASONS: [],
});

require('./_patchLocalModules');
const { spies } = require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const returnsRouter = require('../../routes/returns');

const app = createTestApp(returnsRouter.router || returnsRouter);

describe('PATCH /api/returns/:id', () => {
  beforeEach(() => {
    transitionReturnMock.mockClear();
  });

  it('reicht refundAmount an transitionReturn durch, wenn Status + Betrag zusammen kommen', async () => {
    const res = await request(app)
      .patch('/api/returns/ret-1')
      .send({ status: 'erstattet', refundAmount: 25, reason: 'Defekt bei Ankunft' });

    expect(res.status).toBe(200);
    expect(transitionReturnMock).toHaveBeenCalledTimes(1);
    expect(transitionReturnMock.mock.calls[0][0]).toMatchObject({
      returnId: 'ret-1',
      toStatus: 'erstattet',
      refundAmount: 25,
    });
  });

  it('lässt refundAmount weg, wenn nicht im Request enthalten', async () => {
    const res = await request(app)
      .patch('/api/returns/ret-2')
      .send({ status: 'erstattet' });

    expect(res.status).toBe(200);
    expect(transitionReturnMock.mock.calls[0][0]).not.toHaveProperty('refundAmount');
  });

  it('refundAmount 0 wird durchgereicht (explizit gesetzt)', async () => {
    const res = await request(app)
      .patch('/api/returns/ret-3')
      .send({ status: 'erstattet', refundAmount: 0 });

    expect(res.status).toBe(200);
    expect(transitionReturnMock.mock.calls[0][0]).toMatchObject({ refundAmount: 0 });
  });
});
