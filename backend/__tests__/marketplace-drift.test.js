// globals: true in vitest.config.js — describe/it/expect/vi are global

// Mock ops-alert + firestore so record=true paths are observable and hit no real deps.
const sendOpsAlertMock = vi.fn(async () => 'ok');
require.cache[require.resolve('../lib/ops-alert')] = {
  id: require.resolve('../lib/ops-alert'),
  filename: require.resolve('../lib/ops-alert'),
  loaded: true,
  exports: { sendOpsAlert: sendOpsAlertMock },
  children: [],
  paths: [],
};
const addMock = vi.fn(async () => ({ id: 'drift-1' }));
require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: { collection: () => ({ add: addMock }) } },
  children: [],
  paths: [],
};

const { checkProductDrift, getOurAvailable } = require('../lib/marketplace-drift');

const ebayReader = (qty) => Object.assign(async () => ({ channel: 'ebay', ref: 'IT1', marketplace: qty }), { channelName: 'ebay' });
const product = { id: 'p1', identification: { sku: 'SKU-X' }, inventory: { availableQuantity: 5 } };

describe('marketplace-drift', () => {
  beforeEach(() => { sendOpsAlertMock.mockClear(); addMock.mockClear(); });

  it('getOurAvailable prefers availableQuantity, else quantity-reserved', () => {
    expect(getOurAvailable({ inventory: { availableQuantity: 7 } })).toBe(7);
    expect(getOurAvailable({ inventory: { quantity: 10, reservedQuantity: 3 } })).toBe(7);
    expect(getOurAvailable({ inventory: { quantity: 2, reservedQuantity: 5 } })).toBe(0); // never negative
  });

  it('reports NO drift when marketplace equals ours', async () => {
    const { channels } = await checkProductDrift(product, { record: false, readers: [ebayReader(5)] });
    expect(channels[0].drift).toBe(false);
    expect(channels[0].delta).toBe(0);
  });

  it('detects drift and computes delta', async () => {
    const { channels } = await checkProductDrift(product, { record: false, readers: [ebayReader(2)] });
    expect(channels[0].drift).toBe(true);
    expect(channels[0].delta).toBe(-3); // market 2 - ours 5
  });

  it('alerts ONLY on oversell direction (marketplace > ours) when recording', async () => {
    await checkProductDrift(product, { record: true, readers: [ebayReader(9)] }); // market 9 > ours 5
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
    expect(sendOpsAlertMock.mock.calls[0][0].severity).toBe('critical');
  });

  it('records drift but does NOT alert when marketplace is LOWER than ours', async () => {
    await checkProductDrift(product, { record: true, readers: [ebayReader(1)] }); // market 1 < ours 5
    expect(addMock).toHaveBeenCalledTimes(1);      // still recorded
    expect(sendOpsAlertMock).not.toHaveBeenCalled(); // not an oversell risk
  });

  it('record=false never writes or alerts', async () => {
    await checkProductDrift(product, { record: false, readers: [ebayReader(9)] });
    expect(addMock).not.toHaveBeenCalled();
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  it('a channel API error does not sink the other channel', async () => {
    const boom = Object.assign(async () => { throw new Error('exceeded usage limit'); }, { channelName: 'ebay' });
    const kaufland = Object.assign(async () => ({ channel: 'kaufland', ref: 'U1', marketplace: 5 }), { channelName: 'kaufland' });
    const { channels } = await checkProductDrift(product, { record: false, readers: [boom, kaufland] });
    expect(channels.find((c) => c.channel === 'ebay').error).toMatch(/exceeded usage limit/);
    expect(channels.find((c) => c.channel === 'kaufland').drift).toBe(false);
  });
});
