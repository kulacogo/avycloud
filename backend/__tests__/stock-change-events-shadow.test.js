// globals: true in vitest.config.js
'use strict';

// Patch firestore + sync-event-bus + the shadow lib BEFORE loading the module.
const mockFirestore = { collection: () => ({ add: async () => {}, doc: () => ({}) }) };
function patch(path, exports) {
  require.cache[require.resolve(path)] = { id: require.resolve(path), filename: require.resolve(path), loaded: true, exports, children: [], paths: [] };
}
patch('../lib/firestore', { firestore: mockFirestore });
patch('../services/sync-event-bus', { emitSyncEvent: () => {} });

const shadowCalls = [];
patch('../lib/stock-ledger-shadow', {
  ledgerShadowEnabled: () => String(process.env.STOCK_LEDGER_SHADOW || '').toLowerCase() === 'true',
  recordLedgerShadowDiff: async (args) => { shadowCalls.push(args); return { inSync: true, diff: 0 }; },
});

const { notifyStockChange } = require('../lib/stock-change-events');

const PREV = process.env.STOCK_LEDGER_SHADOW;
beforeEach(() => { shadowCalls.length = 0; });
afterEach(() => { if (PREV === undefined) delete process.env.STOCK_LEDGER_SHADOW; else process.env.STOCK_LEDGER_SHADOW = PREV; });

const move = () => notifyStockChange({ tenantId: 'default', productId: 'prod-1', sku: 'SKU-1', before: 5, after: 3, reason: 'order-shipped', source: 'test' });

describe('notifyStockChange — ledger shadow hook (WP3)', () => {
  it('flag ON: invokes the shadow with the new projection (after)', async () => {
    process.env.STOCK_LEDGER_SHADOW = 'true';
    await move();
    expect(shadowCalls.length).toBe(1);
    expect(shadowCalls[0]).toMatchObject({ productId: 'prod-1', projectionAfter: 3 });
  });

  it('flag OFF (default): never touches the shadow', async () => {
    delete process.env.STOCK_LEDGER_SHADOW;
    await move();
    expect(shadowCalls.length).toBe(0);
  });

  it('a shadow error never breaks notifyStockChange', async () => {
    process.env.STOCK_LEDGER_SHADOW = 'true';
    patch('../lib/stock-ledger-shadow', {
      ledgerShadowEnabled: () => true,
      recordLedgerShadowDiff: async () => { throw new Error('boom'); },
    });
    // require.cache replaced; re-require notify picks the new shadow lazily.
    await expect(move()).resolves.toBeUndefined();
    // restore for other tests
    patch('../lib/stock-ledger-shadow', {
      ledgerShadowEnabled: () => String(process.env.STOCK_LEDGER_SHADOW || '').toLowerCase() === 'true',
      recordLedgerShadowDiff: async (args) => { shadowCalls.push(args); return { inSync: true, diff: 0 }; },
    });
  });
});
