// globals: true in vitest.config.js — describe/it/expect/vi are global

// --- Patch firestore BEFORE importing the module under test ---
const mockDocs = [];

const mockQueryChain = () => {
  const chain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    get: vi.fn(() => Promise.resolve({
      empty: mockDocs.length === 0,
      docs: [...mockDocs],
    })),
  };
  return chain;
};

const mockBatchSet = vi.fn();
const mockBatchUpdate = vi.fn();
const mockBatchCommit = vi.fn(() => Promise.resolve());

const mockFirestore = {
  collection: vi.fn(() => {
    const chain = mockQueryChain();
    chain.doc = vi.fn(() => ({ id: `mock-${Date.now()}` }));
    chain.add = vi.fn(() => Promise.resolve({ id: 'log-id' }));
    return chain;
  }),
  batch: vi.fn(() => ({
    set: mockBatchSet,
    update: mockBatchUpdate,
    commit: mockBatchCommit,
  })),
};

// Patch require.cache so stock-reservation.js sees our mock
const firestorePath = require.resolve('../lib/firestore');
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: { firestore: mockFirestore },
};

const {
  reserveStock,
  releaseReservation,
  confirmReservation,
  getReservedQuantity,
} = require('./stock-reservation');

describe('stock-reservation', () => {
  beforeEach(() => {
    mockDocs.length = 0;
    vi.clearAllMocks();
  });

  describe('reserveStock', () => {
    it('should reserve stock for order items', async () => {
      const result = await reserveStock({
        tenantId: 'default',
        orderId: 'ORD-001',
        items: [
          { sku: 'SKU-A', quantity: 2 },
          { sku: 'SKU-B', quantity: 1 },
        ],
      });

      expect(result.reserved).toBe(true);
      expect(result.count).toBe(2);
      expect(result.skipped).toBe(false);
      expect(mockBatchCommit).toHaveBeenCalled();
    });

    it('should skip if items array is empty', async () => {
      const result = await reserveStock({
        tenantId: 'default',
        orderId: 'ORD-002',
        items: [],
      });

      expect(result.reserved).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('no items');
    });

    it('should be idempotent — skip if already reserved', async () => {
      // Simulate existing reservation found by the idempotency check
      mockDocs.push({ id: 'existing', data: () => ({ orderId: 'ORD-003', status: 'reserved' }) });

      const result = await reserveStock({
        tenantId: 'default',
        orderId: 'ORD-003',
        items: [{ sku: 'SKU-A', quantity: 1 }],
      });

      expect(result.reserved).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('already reserved');
      expect(mockBatchCommit).not.toHaveBeenCalled();
    });

    it('should skip items without sku or productId', async () => {
      const result = await reserveStock({
        tenantId: 'default',
        orderId: 'ORD-004',
        items: [
          { quantity: 5 }, // no sku or productId
          { sku: 'SKU-A', quantity: 3 },
        ],
      });

      expect(result.count).toBe(1);
      expect(result.reserved).toBe(true);
    });

    it('should throw if orderId is missing', async () => {
      await expect(
        reserveStock({ tenantId: 'default', items: [{ sku: 'A', quantity: 1 }] })
      ).rejects.toThrow('orderId is required');
    });
  });

  describe('releaseReservation', () => {
    it('should release existing reservations', async () => {
      mockDocs.push(
        { id: 'r1', ref: { id: 'r1' }, data: () => ({ status: 'reserved' }) },
        { id: 'r2', ref: { id: 'r2' }, data: () => ({ status: 'reserved' }) },
      );

      const result = await releaseReservation({ tenantId: 'default', orderId: 'ORD-005' });
      expect(result.released).toBe(2);
      expect(mockBatchUpdate).toHaveBeenCalledTimes(2);
    });

    it('should return 0 if no reservations exist', async () => {
      const result = await releaseReservation({ tenantId: 'default', orderId: 'ORD-006' });
      expect(result.released).toBe(0);
    });
  });

  describe('confirmReservation', () => {
    it('should confirm existing reservations', async () => {
      mockDocs.push(
        { id: 'r1', ref: { id: 'r1' }, data: () => ({ status: 'reserved' }) },
      );

      const result = await confirmReservation({ tenantId: 'default', orderId: 'ORD-007' });
      expect(result.confirmed).toBe(1);
      expect(mockBatchUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('getReservedQuantity', () => {
    it('should sum quantities for reserved items by sku', async () => {
      mockDocs.push(
        { data: () => ({ quantity: 3 }) },
        { data: () => ({ quantity: 2 }) },
      );

      const total = await getReservedQuantity({ tenantId: 'default', sku: 'SKU-A' });
      expect(total).toBe(5);
    });

    it('should return 0 if no sku or productId provided', async () => {
      const total = await getReservedQuantity({ tenantId: 'default' });
      expect(total).toBe(0);
    });

    it('should ignore expired reservations (expiresAt < now)', async () => {
      const past = new Date(Date.now() - 3600_000).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();
      mockDocs.push(
        { data: () => ({ quantity: 5, expiresAt: past }) },   // expired → skip
        { data: () => ({ quantity: 3, expiresAt: future }) },  // valid → count
      );

      const total = await getReservedQuantity({ tenantId: 'default', sku: 'SKU-X' });
      expect(total).toBe(3);
    });

    it('should count reservations without expiresAt (backwards compat)', async () => {
      mockDocs.push(
        { data: () => ({ quantity: 4 }) },  // no expiresAt → count
        { data: () => ({ quantity: 2 }) },
      );

      const total = await getReservedQuantity({ tenantId: 'default', sku: 'SKU-Y' });
      expect(total).toBe(6);
    });
  });
});
