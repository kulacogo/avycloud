function patch(p, exports) { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const calls = [];
let liveUnit;
let unitLookupSequence = [];
patch('../services/integration-store', { resolveProviderCredentials: async () => ({ clientKey: 'test', secretKey: 'test' }) });
patch('node-fetch', async (url, opts) => {
  calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  const data = opts.method === 'GET' ? (new URL(url).pathname.endsWith('/units') ? (unitLookupSequence.length ? unitLookupSequence.shift() : [liveUnit]) : liveUnit) : {};
  return { ok: true, status: 200, text: async () => JSON.stringify({ data }), headers: { get: () => null } };
});
patch('../lib/marketplace-stock-quantity', { resolveMarketplaceQuantity: () => 2, readMarketplaceQuantity: async () => 2 });
const { updateUnit, createUnit } = require('../lib/kaufland-api');
const product = { id: 'p1', tenantId: 'default', identification: { sku: 'SKU-TEST' }, inventory: { quantity: 2 }, storageBins: [{ code: 'A-01', quantity: 2 }], details: { identifiers: { ean: '4006633144780' }, pricing: { sellPrice: 29 } } };
beforeEach(() => { unitLookupSequence = []; calls.length = 0; liveUnit = { id_unit: 1234, id_offer: 'SKU-TEST', status: 'ONHOLD', amount: 0 }; });
it.each(['ONHOLD', 'DEACTIVATED', 'INCOMPLETE', 'BLOCKED', 'UNKNOWN'])('stock update never reactivates %s', async status => {
  liveUnit.status = status;
  const result = await updateUnit(1234, product);
  expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
  expect(result).toMatchObject({ skipped: true, reason: 'manual_reactivation_required' });
});
it('AVAILABLE with zero amount stays sold out until manual activation', async () => {
  liveUnit.status = 'AVAILABLE';
  expect(await updateUnit(1234, product)).toMatchObject({ skipped: true });
  expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(0);
});
it('active units still receive stock updates without a status activation', async () => {
  liveUnit.status = 'AVAILABLE'; liveUnit.amount = 1;
  await updateUnit(1234, product);
  expect(calls.find(c => c.method === 'PATCH').body).toMatchObject({ amount: 2 });
  expect(calls.find(c => c.method === 'PATCH').body).not.toHaveProperty('status');
});
it('explicit manual publish reuses the inactive unit and activates after the stock guard', async () => {
  const result = await createUnit(product, { manualActivation: true });
  expect(result.id_unit).toBe(1234);
  expect(calls.find(c => c.method === 'PATCH').body).toMatchObject({ amount: 2, status: 'AVAILABLE' });
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
});
it('automatic pending-publish retry cannot reactivate an existing unit', async () => {
  await expect(createUnit(product)).rejects.toMatchObject({ code: 'KAUFLAND_MANUAL_ACTIVATION_REQUIRED' });
  expect(calls.filter(c => c.method === 'POST' || c.method === 'PATCH')).toHaveLength(0);
});

it('rechecks BIN stock after the live status lookup before sending quantity', async () => {
  liveUnit.status = 'AVAILABLE'; liveUnit.amount = 1;
  const spy = vi.spyOn(require('../lib/marketplace-stock-quantity'), 'readMarketplaceQuantity').mockResolvedValueOnce(2).mockResolvedValueOnce(0);
  try {
    await updateUnit(1234, product);
    expect(calls.find(c => c.method === 'PATCH').body).toMatchObject({ amount: 0, status: 'ONHOLD' });
  } finally { spy.mockRestore(); }
});

it('an automatic create retry checks again after slow catalog preparation', async () => {
  unitLookupSequence = [[], [liveUnit]];
  await expect(createUnit(product, { autoCreateProductData: false })).rejects.toMatchObject({ code: 'KAUFLAND_MANUAL_ACTIVATION_REQUIRED' });
  expect(calls.filter(c => c.method === 'POST' || c.method === 'PATCH')).toHaveLength(0);
});
