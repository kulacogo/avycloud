// globals: true in vitest.config.js — describe/it/expect/vi are global

// --- Mock setup ---
const mockMovementDocs = [];
const mockAlertDocs = [];
const mockAddedAlerts = [];

const mockQueryChain = (docs) => {
  const chain = {
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    get: vi.fn(() => Promise.resolve({
      empty: docs.length === 0,
      docs: [...docs],
    })),
  };
  return chain;
};

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'warehouse_movements') return mockQueryChain(mockMovementDocs);
    if (name === 'restock_alerts') {
      const chain = mockQueryChain(mockAlertDocs);
      chain.add = vi.fn((data) => {
        mockAddedAlerts.push(data);
        return Promise.resolve({ id: `alert-${mockAddedAlerts.length}` });
      });
      return chain;
    }
    return mockQueryChain([]);
  }),
};

// Patch firestore
const firestorePath = require.resolve('../lib/firestore');
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: { firestore: mockFirestore },
};

const { checkPendingRestocks } = require('../services/restock-alert');

describe('restock-alert', () => {
  beforeEach(() => {
    mockMovementDocs.length = 0;
    mockAlertDocs.length = 0;
    mockAddedAlerts.length = 0;
    vi.clearAllMocks();
  });

  describe('checkPendingRestocks', () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

    it('creates alert for a_ware movement older than 24h', async () => {
      mockMovementDocs.push({
        id: 'mov-1',
        data: () => ({
          tenantId: 'default',
          type: 'restock_return',
          productSku: 'SKU-A',
          productName: 'Product A',
          quantity: 2,
          condition: 'a_ware',
          returnId: 'ret-1',
          orderId: 'ord-1',
          createdAt: oldDate,
        }),
      });

      const result = await checkPendingRestocks();
      expect(result.checked).toBe(1);
      expect(result.newAlerts).toBe(1);
      expect(mockAddedAlerts[0].productSku).toBe('SKU-A');
      expect(mockAddedAlerts[0].condition).toBe('a_ware');
      expect(mockAddedAlerts[0].status).toBe('pending');
    });

    it('creates alert for b_ware movement older than 24h', async () => {
      mockMovementDocs.push({
        id: 'mov-2',
        data: () => ({
          tenantId: 'default',
          type: 'restock_return',
          productSku: 'SKU-B',
          quantity: 1,
          condition: 'b_ware',
          returnId: 'ret-2',
          orderId: 'ord-2',
          createdAt: oldDate,
        }),
      });

      const result = await checkPendingRestocks();
      expect(result.newAlerts).toBe(1);
      expect(mockAddedAlerts[0].condition).toBe('b_ware');
    });

    it('ignores c_ware movements', async () => {
      mockMovementDocs.push({
        id: 'mov-3',
        data: () => ({
          tenantId: 'default',
          type: 'restock_return',
          productSku: 'SKU-C',
          quantity: 1,
          condition: 'c_ware',
          returnId: 'ret-3',
          orderId: 'ord-3',
          createdAt: oldDate,
        }),
      });

      const result = await checkPendingRestocks();
      expect(result.checked).toBe(1);
      expect(result.newAlerts).toBe(0);
      expect(mockAddedAlerts).toHaveLength(0);
    });

    it('does not create duplicate alert when alert already exists', async () => {
      mockMovementDocs.push({
        id: 'mov-4',
        data: () => ({
          tenantId: 'default',
          type: 'restock_return',
          productSku: 'SKU-D',
          quantity: 1,
          condition: 'a_ware',
          returnId: 'ret-4',
          orderId: 'ord-4',
          createdAt: oldDate,
        }),
      });

      // Simulate existing alert
      mockAlertDocs.push({
        id: 'alert-existing',
        data: () => ({ movementId: 'mov-4', status: 'pending' }),
      });

      const result = await checkPendingRestocks();
      expect(result.checked).toBe(1);
      expect(result.newAlerts).toBe(0);
      expect(mockAddedAlerts).toHaveLength(0);
    });

    it('returns zeros when no movements exist', async () => {
      const result = await checkPendingRestocks();
      expect(result.checked).toBe(0);
      expect(result.newAlerts).toBe(0);
    });
  });
});
