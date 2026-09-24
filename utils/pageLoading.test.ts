import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocksOnProductCatalog } from './pageLoading.ts';

test('independent pages stay mounted when the initial catalog request begins', () => {
  for (const view of ['dashboard', 'home', 'finance', 'marketplace-ebay', 'marketplace-kaufland']) {
    assert.equal(blocksOnProductCatalog(view, false, 0), false);
    assert.equal(blocksOnProductCatalog(view, true, 0), false);
  }
});
test('product screens wait for first data but keep existing results during polling', () => {
  for (const view of ['products', 'inventory', 'search', 'operations-stow']) {
    assert.equal(blocksOnProductCatalog(view, true, 0), true);
    assert.equal(blocksOnProductCatalog(view, true, 12), false);
    assert.equal(blocksOnProductCatalog(view, false, 0), false);
  }
});
