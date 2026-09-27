require('./api/_patchGcp');
require('./api/_patchLocalModules');
function patch(p, exports) { const id = require.resolve(p); require.cache[id] = { id, filename: id, loaded: true, exports }; }
let local = {}, live = {}, links = [], rows = [];
const writes = [];
const getItemDetails = vi.fn(async id => { if (live[id] instanceof Error) throw live[id]; return { item: { listingStatus: live[id] } }; });
patch('../lib/ebay-trading-api', { getItemDetails });
patch('../lib/firestore', { firestore: {
  collection(name) {
    const chain = { where: () => chain, limit: () => chain, get: async () => ({ empty: !(name === 'ebayListingLinks' ? links : rows).length, docs: (name === 'ebayListingLinks' ? links : rows).map(id => ({ id, data: () => ({ itemId: id, tenantId: 'default', ...local[id] }) })) }),
      doc: id => ({ get: async () => ({ exists: !!local[id], data: () => local[id] }), set: async payload => writes.push({ id, ...payload }) }) };
    return chain;
  },
}, PRODUCTS_COLLECTION: 'products_v2' });
const { resolveItemIsActive, checkExistingEbayLink } = require('../lib/ebay-direct');
beforeEach(() => { local = {}; live = {}; links = []; rows = []; writes.length = 0; getItemDetails.mockClear(); });
it('a stale inactive flag cannot permit a duplicate of a live eBay item', async () => {
  local.old = { active: false }; live.old = 'Active';
  expect(await resolveItemIsActive('old')).toMatchObject({ isActive: true, uncertain: false });
});
it('a confirmed ended item can be manually republished and both cached status fields are healed', async () => {
  local.old = { active: true, listingStatus: 'Active' }; live.old = 'Completed';
  expect(await resolveItemIsActive('old')).toMatchObject({ isActive: false, uncertain: false });
  expect(writes).toContainEqual(expect.objectContaining({ id: 'old', active: false, listingStatus: 'Completed' }));
});
it.each([undefined, 'Unknown'])('an unrecognized live status %s cannot permit duplicate publishing', async status => {
  live.old = status;
  expect(await resolveItemIsActive('old')).toMatchObject({ isActive: true, uncertain: true });
});
it('an authentication/business error is not proof that the listing ended', async () => {
  live.old = Object.assign(new Error('token invalid'), { details: { errors: [{ code: '931' }] } });
  expect(await resolveItemIsActive('old')).toMatchObject({ isActive: true, uncertain: true });
});
it('confirmed removal still permits manual publishing', async () => {
  live.old = Object.assign(new Error('removed'), { details: { errors: [{ code: '21920397' }] } });
  expect(await resolveItemIsActive('old')).toMatchObject({ isActive: false, uncertain: false });
});
it('checks every linked candidate rather than stopping after the first ended one', async () => {
  links = ['ended', 'active']; live.ended = 'Completed'; live.active = 'Active';
  expect(await checkExistingEbayLink('p1', { tenantId: 'default' })).toBe('active');
});
it('also detects active SKU mirror rows without a product link', async () => {
  rows = ['unlinked']; live.unlinked = 'Active';
  expect(await checkExistingEbayLink('p1', { tenantId: 'default', identification: { sku: 'SKU-1' } })).toBe('unlinked');
});

it('checks both product pointers when marketplace and ops disagree', async () => {
  live.ended = 'Completed'; live.active = 'Active';
  expect(await checkExistingEbayLink('p1', { tenantId: 'default', marketplace: { ebay: { itemId: 'ended' } }, ops: { ebay: { itemId: 'active' } } })).toBe('active');
});
it('reports an uncertain status instead of allowing publication', async () => {
  links = ['unknown'];
  await expect(checkExistingEbayLink('p1')).rejects.toMatchObject({ code: 'EBAY_LISTING_STATUS_UNCERTAIN' });
});
