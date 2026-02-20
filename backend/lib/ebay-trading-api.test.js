const test = require('node:test');
const assert = require('node:assert/strict');

const { mapListingDetail } = require('./ebay-trading-api');

test('mapListingDetail extracts variation SKUs from GetItem payload', () => {
  const detail = mapListingDetail({
    ItemID: '1234567890',
    SKU: '',
    Variations: {
      Variation: [{ SKU: 'SKU-ONE' }, { SKU: 'SKU-TWO' }, { SKU: 'SKU-ONE' }, {}],
    },
  });

  assert.deepEqual(detail.variationSkus, ['SKU-ONE', 'SKU-TWO']);
});

