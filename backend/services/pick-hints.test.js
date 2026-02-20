const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__buildPickHint } = require('./pick-hints');

test('buildPickHint uses per-bin quantity when storageBins present', () => {
  const product = {
    id: 'prod-1',
    identification: { name: 'Test product' },
    details: { identifiers: { sku: 'SKU-0225495136' }, images: [] },
    storage: { binCode: 'XGA204D', quantity: 2 },
    storageBins: [
      { code: 'XGA204D', quantity: 1 },
      { code: 'XGA201E', quantity: 1 },
    ],
    inventory: { quantity: 2 },
  };

  const hint = __test__buildPickHint(product, { name: 'Fallback name', sku: 'SKU-0225495136' });
  assert.equal(hint.binCode, 'XGA204D');
  assert.equal(hint.quantityAvailable, 1);
});

test('buildPickHint falls back to best stocked bin when no primary', () => {
  const product = {
    id: 'prod-2',
    identification: { name: 'Test product 2' },
    details: { identifiers: { sku: 'SKU-ABC' }, images: [] },
    storage: null,
    storageBins: [
      { code: 'XGA201E', quantity: 1 },
      { code: 'XGA204D', quantity: 3 },
    ],
    inventory: { quantity: 4 },
  };

  const hint = __test__buildPickHint(product, { name: 'Fallback', sku: 'SKU-ABC' });
  assert.equal(hint.binCode, 'XGA204D');
  assert.equal(hint.quantityAvailable, 3);
});

