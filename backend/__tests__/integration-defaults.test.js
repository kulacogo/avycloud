/**
 * Tests for lib/integration-defaults.js
 *
 * Uses require.cache patching to mock Firestore (CJS pattern).
 */

const path = require('path');

// ─── Mock Firestore ───────────────────────────────────────────────────────

const mockDocData = {};
const mockDocGet = vi.fn(async () => ({
  exists: !!mockDocData.data,
  data: () => mockDocData.data,
}));
const mockDocSet = vi.fn(async () => {});
const mockDoc = vi.fn(() => ({
  get: mockDocGet,
  set: mockDocSet,
}));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

const firestorePath = require.resolve('../lib/firestore.js');
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    firestore: { collection: mockCollection },
  },
  children: [],
  paths: [],
};

// ─── Import after patching ────────────────────────────────────────────────

const {
  getIntegrationDefaults,
  mergeEbayOverrides,
  mergeKauflandOverrides,
} = require('../lib/integration-defaults');

// ─── Tests ────────────────────────────────────────────────────────────────

describe('integration-defaults', () => {
  beforeEach(() => {
    mockDocData.data = null;
    vi.clearAllMocks();
  });

  describe('getIntegrationDefaults', () => {
    it('returns empty object when no settings doc exists', async () => {
      mockDocData.data = null;
      const result = await getIntegrationDefaults('ebay');
      expect(result).toEqual({});
      expect(mockCollection).toHaveBeenCalledWith('integration_settings');
      expect(mockDoc).toHaveBeenCalledWith('default__ebay');
    });

    it('returns defaults from Firestore doc', async () => {
      mockDocData.data = {
        defaults: { shippingPolicyId: '123', returnPolicyId: '456' },
      };
      const result = await getIntegrationDefaults('ebay');
      expect(result).toEqual({ shippingPolicyId: '123', returnPolicyId: '456' });
    });

    it('uses custom tenantId', async () => {
      mockDocData.data = null;
      await getIntegrationDefaults('kaufland', { tenantId: 'trendocean' });
      expect(mockDoc).toHaveBeenCalledWith('trendocean__kaufland');
    });

    it('returns empty object on Firestore error', async () => {
      mockDocGet.mockRejectedValueOnce(new Error('Firestore down'));
      const result = await getIntegrationDefaults('ebay');
      expect(result).toEqual({});
    });
  });

  describe('mergeEbayOverrides', () => {
    it('returns overrides unchanged when no Firestore defaults', async () => {
      mockDocData.data = null;
      const result = await mergeEbayOverrides({
        shippingProfileId: 'my-id',
      });
      expect(result.shippingProfileId).toBe('my-id');
      expect(result.returnProfileId).toBeUndefined();
      expect(result.paymentProfileId).toBeUndefined();
    });

    it('merges Firestore defaults when no overrides', async () => {
      mockDocData.data = {
        defaults: {
          shippingPolicyId: 'fs-ship',
          returnPolicyId: 'fs-ret',
          paymentPolicyId: 'fs-pay',
        },
      };
      const result = await mergeEbayOverrides({});
      expect(result.shippingProfileId).toBe('fs-ship');
      expect(result.returnProfileId).toBe('fs-ret');
      expect(result.paymentProfileId).toBe('fs-pay');
    });

    it('overrides take priority over Firestore defaults', async () => {
      mockDocData.data = {
        defaults: {
          shippingPolicyId: 'fs-ship',
          returnPolicyId: 'fs-ret',
        },
      };
      const result = await mergeEbayOverrides({
        shippingProfileId: 'override-ship',
      });
      expect(result.shippingProfileId).toBe('override-ship');
      expect(result.returnProfileId).toBe('fs-ret');
    });
  });

  describe('mergeKauflandOverrides', () => {
    it('returns overrides unchanged when no Firestore defaults', async () => {
      mockDocData.data = null;
      const result = await mergeKauflandOverrides({
        shippingGroupId: 999,
      });
      expect(result.shippingGroupId).toBe(999);
      expect(result.warehouseId).toBeUndefined();
    });

    it('merges Firestore defaults when no overrides', async () => {
      mockDocData.data = {
        defaults: {
          shippingGroupId: 144080,
          warehouseId: 70462,
        },
      };
      const result = await mergeKauflandOverrides({});
      expect(result.shippingGroupId).toBe(144080);
      expect(result.warehouseId).toBe(70462);
    });

    it('overrides take priority over Firestore defaults', async () => {
      mockDocData.data = {
        defaults: {
          shippingGroupId: 144080,
          warehouseId: 70462,
        },
      };
      const result = await mergeKauflandOverrides({
        shippingGroupId: 555,
      });
      expect(result.shippingGroupId).toBe(555);
      expect(result.warehouseId).toBe(70462);
    });
  });
});
