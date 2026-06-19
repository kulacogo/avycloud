// globals: true in vitest.config.js
'use strict';

// ─── Harness: mock firestore + ebay-trading-api before loading dispatcher ───
const reviseCalls = [];
let getItemImpl = async () => ({ ack: 'Success', item: { minimumBestOfferPrice: null } });

const mockFirestore = {
  collection: () => ({
    add: async () => {},
    doc: () => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} }),
    where: function () { return this; },
    limit: function () { return this; },
    get: async () => ({ empty: true, docs: [] }),
  }),
};

function patch(path, exports) {
  require.cache[require.resolve(path)] = {
    id: require.resolve(path), filename: require.resolve(path), loaded: true, exports, children: [], paths: [],
  };
}
patch('../lib/firestore', { firestore: mockFirestore });
patch('../lib/ebay-trading-api', {
  reviseFixedPriceItem: async (payload) => { reviseCalls.push(payload); return { ack: 'Success' }; },
  getEbayItem: async (itemId) => getItemImpl(itemId),
});

const { syncPriceToAllChannels } = require('../services/stock-sync-dispatcher');

const PREV = process.env.BEST_OFFER_PRICE_GUARD;
beforeEach(() => {
  reviseCalls.length = 0;
  getItemImpl = async () => ({ ack: 'Success', item: { minimumBestOfferPrice: null } });
});
afterEach(() => {
  if (PREV === undefined) delete process.env.BEST_OFFER_PRICE_GUARD;
  else process.env.BEST_OFFER_PRICE_GUARD = PREV;
});

const product = (price) => ({ id: 'p1', ops: { ebay: { itemId: 'EBAY-1' } }, pricing: { sellPrice: price } });

describe('syncPriceToAllChannels — Best-Offer price guard (WP2 Task 3)', () => {
  it('flag ON: blocks a price at/below the auto-decline threshold (no revise sent)', async () => {
    process.env.BEST_OFFER_PRICE_GUARD = 'true';
    getItemImpl = async () => ({ ack: 'Success', item: { minimumBestOfferPrice: 10 } });

    const res = await syncPriceToAllChannels({ tenantId: 'default', product: product(8) });
    expect(reviseCalls.length).toBe(0); // the unsafe price never reaches eBay
    const ebay = res.results.find((r) => r.channel === 'ebay');
    expect(ebay.status).toBe('skipped');
    expect(ebay.reason).toMatch(/best-offer/i);
  });

  it('flag ON: allows a price safely above the threshold (revise sent)', async () => {
    process.env.BEST_OFFER_PRICE_GUARD = 'true';
    getItemImpl = async () => ({ ack: 'Success', item: { minimumBestOfferPrice: 10 } });

    await syncPriceToAllChannels({ tenantId: 'default', product: product(20) });
    expect(reviseCalls.length).toBe(1);
    expect(reviseCalls[0].startPrice).toBe(20);
  });

  it('flag OFF: legacy behaviour — pushes the price unguarded', async () => {
    process.env.BEST_OFFER_PRICE_GUARD = 'false';
    getItemImpl = async () => ({ ack: 'Success', item: { minimumBestOfferPrice: 10 } });

    await syncPriceToAllChannels({ tenantId: 'default', product: product(8) });
    expect(reviseCalls.length).toBe(1);
    expect(reviseCalls[0].startPrice).toBe(8);
  });

  it('flag ON: fails open when the threshold cannot be read (does not block legit pushes)', async () => {
    process.env.BEST_OFFER_PRICE_GUARD = 'true';
    getItemImpl = async () => { throw new Error('GetItem down'); };

    await syncPriceToAllChannels({ tenantId: 'default', product: product(8) });
    expect(reviseCalls.length).toBe(1); // read failed → guard can't judge → proceed
  });
});
