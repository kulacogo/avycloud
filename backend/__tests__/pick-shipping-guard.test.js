'use strict';
const { mockDoc, mockQuery } = require('./api/_patchGcp');
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = { id: sendcloudPath, filename: sendcloudPath, loaded: true, exports: { lookupCsvPrice: vi.fn() } };
const statePath = require.resolve('../services/order-state-machine');
const transitionOrder = vi.fn().mockResolvedValue({ ok: false, error: 'Unvollständig' });
require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: { transitionOrder } };
const { shipOrder } = require('../services/shipping-engine');
const { packOrder } = require('../services/order-source-router');
const incomplete = { tenantId: 'default', omsStatus: 'picking', items: [{ id: '1', quantity: 2 }],
  pickWork: { ownerUid: 'alice', lines: [{ itemId: '1', required: 2, picked: 1 }] } };
beforeEach(() => {
  mockDoc.get.mockResolvedValue({ exists: true, id: 'order-1', data: () => incomplete });
  mockQuery.get.mockClear();
  transitionOrder.mockClear();
});
it('stops incomplete picking before any label lookup or purchase, including bulk and additional label callers', async () => {
  for (const additionalLabel of [false, true]) {
    await expect(shipOrder({ orderId: 'order-1', weight: 2, shippingOptionCode: 'dhl:paket', additionalLabel })).rejects.toThrow(/vollständig/);
  }
  expect(mockQuery.get).not.toHaveBeenCalled();
});
it('does not report successful packing after a rejected status transition', async () => {
  await expect(packOrder({ orderId: 'order-1', actor: { uid: 'alice' } })).rejects.toThrow(/Unvollständig/);
});
it('rejects packing or shipping a different tenant order before mutation', async () => {
  await expect(packOrder({ orderId: 'order-1', tenantId: 'other' })).rejects.toThrow(/not found/);
  await expect(shipOrder({ orderId: 'order-1', tenantId: 'other', weight: 2 })).rejects.toThrow(/nicht gefunden/);
  expect(transitionOrder).not.toHaveBeenCalled();
});
