// globals: true in vitest.config.js — describe/it/expect/vi are global

// ─── Mock Setup (require.cache patching for CJS) ──────────────────────

const ledgerAddMock = vi.fn().mockResolvedValue();
const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'inventory_ledger') return { add: ledgerAddMock };
    return { add: vi.fn().mockResolvedValue(), doc: vi.fn() };
  }),
};

require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: mockFirestore },
  children: [],
  paths: [],
};

const emitSyncEventMock = vi.fn();
require.cache[require.resolve('../services/sync-event-bus')] = {
  id: require.resolve('../services/sync-event-bus'),
  filename: require.resolve('../services/sync-event-bus'),
  loaded: true,
  exports: { emitSyncEvent: emitSyncEventMock },
  children: [],
  paths: [],
};

const { notifyStockChange } = require('../lib/stock-change-events');

// ─── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  emitSyncEventMock.mockReset();
  ledgerAddMock.mockReset();
  ledgerAddMock.mockResolvedValue();
  delete process.env.STOCK_CHANGED_EMIT_ENABLED;
  delete process.env.INVENTORY_LEDGER_ENABLED;
});

describe('notifyStockChange', () => {
  it('emits stock:changed AND writes ledger when qty changes from 5 to 0', async () => {
    await notifyStockChange({
      tenantId: 'trendocean',
      productId: 'prod-1',
      sku: 'SKU-9871561937',
      before: 5,
      after: 0,
      reason: 'order-shipped',
      source: 'order-state-machine',
    });

    expect(emitSyncEventMock).toHaveBeenCalledTimes(1);
    expect(emitSyncEventMock).toHaveBeenCalledWith('stock:changed', expect.objectContaining({
      tenantId: 'trendocean',
      productId: 'prod-1',
      sku: 'SKU-9871561937',
      before: 5,
      after: 0,
      delta: -5,
      reason: 'order-shipped',
    }));

    expect(ledgerAddMock).toHaveBeenCalledTimes(1);
    const ledgerEntry = ledgerAddMock.mock.calls[0][0];
    expect(ledgerEntry).toMatchObject({
      tenantId: 'trendocean',
      productId: 'prod-1',
      sku: 'SKU-9871561937',
      before: 5,
      after: 0,
      delta: -5,
      reason: 'order-shipped',
      source: 'order-state-machine',
    });
    expect(ledgerEntry.createdAt).toBeDefined();
  });

  it('does NOT emit when before === after', async () => {
    await notifyStockChange({ productId: 'p', before: 5, after: 5 });
    expect(emitSyncEventMock).not.toHaveBeenCalled();
    expect(ledgerAddMock).not.toHaveBeenCalled();
  });

  it('does NOT emit when productId missing', async () => {
    await notifyStockChange({ before: 5, after: 0 });
    expect(emitSyncEventMock).not.toHaveBeenCalled();
    expect(ledgerAddMock).not.toHaveBeenCalled();
  });

  it('does NOT emit when before is not a number', async () => {
    await notifyStockChange({ productId: 'p', before: null, after: 3 });
    expect(emitSyncEventMock).not.toHaveBeenCalled();
    expect(ledgerAddMock).not.toHaveBeenCalled();
  });

  it('skips emit when STOCK_CHANGED_EMIT_ENABLED=false', async () => {
    process.env.STOCK_CHANGED_EMIT_ENABLED = 'false';
    await notifyStockChange({ productId: 'p', before: 1, after: 0 });
    expect(emitSyncEventMock).not.toHaveBeenCalled();
    // Ledger still runs
    expect(ledgerAddMock).toHaveBeenCalledTimes(1);
  });

  it('skips ledger when INVENTORY_LEDGER_ENABLED=false', async () => {
    process.env.INVENTORY_LEDGER_ENABLED = 'false';
    await notifyStockChange({ productId: 'p', before: 1, after: 0 });
    expect(emitSyncEventMock).toHaveBeenCalledTimes(1);
    expect(ledgerAddMock).not.toHaveBeenCalled();
  });

  it('swallows emit errors without throwing', async () => {
    emitSyncEventMock.mockImplementation(() => { throw new Error('bus down'); });
    await expect(notifyStockChange({ productId: 'p', before: 1, after: 0 })).resolves.toBeUndefined();
    expect(ledgerAddMock).toHaveBeenCalledTimes(1);
  });

  it('swallows ledger errors without throwing', async () => {
    ledgerAddMock.mockRejectedValue(new Error('firestore down'));
    await expect(notifyStockChange({ productId: 'p', before: 1, after: 0 })).resolves.toBeUndefined();
    expect(emitSyncEventMock).toHaveBeenCalledTimes(1);
  });

  it('increments delta correctly for positive change', async () => {
    await notifyStockChange({ productId: 'p', before: 0, after: 10, reason: 'restock' });
    expect(ledgerAddMock.mock.calls[0][0].delta).toBe(10);
  });

  it('records actor info when provided', async () => {
    await notifyStockChange({
      productId: 'p', before: 1, after: 0,
      actor: { uid: 'user-42', email: 'admin@example.com' },
    });
    expect(ledgerAddMock.mock.calls[0][0].actor).toEqual({ uid: 'user-42', email: 'admin@example.com' });
  });
});
