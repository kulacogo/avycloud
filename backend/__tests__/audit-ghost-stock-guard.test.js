'use strict';

/**
 * Stock-bearing safety guard for the ghost-product audit/cleanup script.
 *
 * REGRESSION GUARD (latent data-loss risk): a ghost-shaped product doc that
 * still holds physical stock (inventory.quantity > 0, OR a non-empty
 * storageBins/warehouseBins array, OR any positive bin quantity) must NEVER be
 * classified as deletable. Otherwise a future `--apply` run would silently
 * delete inventory. Such docs land in the separate `protected_has_stock`
 * bucket instead.
 *
 * Pure-function tests only — they MUST NOT touch Firestore or run the CLI.
 */

const {
  classifyGhost,
  hasPhysicalStock,
} = require('../scripts/audit-ghost-products');

// A canonical ghost name (UUID) so the doc is ghost-shaped by name/id.
const UUID = '0060cdec-9193-411b-af64-4754ca0226bd';

function ghostShapedDoc(extra = {}) {
  // Minimal ghost: UUID doc-id, no real content, no orders/listings.
  return {
    identification: { name: '', brand: '', sku: '' },
    details: {},
    ops: {},
    ...extra,
  };
}

describe('hasPhysicalStock', () => {
  it('returns false for an empty doc', () => {
    expect(hasPhysicalStock({})).toBe(false);
    expect(hasPhysicalStock(null)).toBe(false);
    expect(hasPhysicalStock(undefined)).toBe(false);
  });

  it('returns true when inventory.quantity > 0', () => {
    expect(hasPhysicalStock({ inventory: { quantity: 1 } })).toBe(true);
    expect(hasPhysicalStock({ inventory: { quantity: 42 } })).toBe(true);
  });

  it('returns false when inventory.quantity is 0 or negative', () => {
    expect(hasPhysicalStock({ inventory: { quantity: 0 } })).toBe(false);
    expect(hasPhysicalStock({ inventory: { quantity: -3 } })).toBe(false);
  });

  it('returns true when storageBins is a non-empty array', () => {
    expect(hasPhysicalStock({ storageBins: [{ code: 'A-01-02', quantity: 0 }] })).toBe(true);
  });

  it('returns true when any bin quantity is positive', () => {
    expect(
      hasPhysicalStock({ storageBins: [{ code: 'A-01-02', quantity: 5 }] })
    ).toBe(true);
  });

  it('returns true when warehouseBins is a non-empty array', () => {
    expect(hasPhysicalStock({ warehouseBins: [{ code: 'B-02-03', quantity: 0 }] })).toBe(true);
  });

  it('returns false for empty bin arrays', () => {
    expect(hasPhysicalStock({ storageBins: [], warehouseBins: [] })).toBe(false);
  });
});

describe('classifyGhost stock-bearing safety guard', () => {
  it('does NOT classify a ghost-named doc WITH inventory.quantity > 0 as a deletable ghost', () => {
    const data = ghostShapedDoc({ inventory: { quantity: 2 } });
    const result = classifyGhost(UUID, data);
    // It is recognized as ghost-shaped but protected because it bears stock.
    expect(result).not.toBeNull();
    expect(result.protectedReason).toBe('has_stock');
    expect(result.deletable).toBe(false);
  });

  it('does NOT classify a ghost-named doc WITH a storageBin as a deletable ghost', () => {
    const data = ghostShapedDoc({
      storageBins: [{ code: 'A-01-02', quantity: 1 }],
    });
    const result = classifyGhost(UUID, data);
    expect(result).not.toBeNull();
    expect(result.protectedReason).toBe('has_stock');
    expect(result.deletable).toBe(false);
  });

  it('does NOT classify a ghost-named doc with a zero-qty bin (but the bin exists) as deletable', () => {
    const data = ghostShapedDoc({
      storageBins: [{ code: 'A-01-02', quantity: 0 }],
    });
    const result = classifyGhost(UUID, data);
    expect(result).not.toBeNull();
    expect(result.protectedReason).toBe('has_stock');
    expect(result.deletable).toBe(false);
  });

  it('STILL classifies a ghost-named doc with zero stock + no orders/listings as a deletable ghost (cleanup still works)', () => {
    const data = ghostShapedDoc({ inventory: { quantity: 0 }, storageBins: [] });
    const result = classifyGhost(UUID, data);
    expect(result).not.toBeNull();
    expect(result.type).toBe('uuid_ghost');
    expect(result.protectedReason).toBeFalsy();
    expect(result.deletable).toBe(true);
  });

  it('still protects a doc with orders (existing behavior preserved — returns null)', () => {
    const data = ghostShapedDoc({ ops: { order_count: 1 } });
    const result = classifyGhost(UUID, data);
    expect(result).toBeNull();
  });

  it('marketplace-listing ghosts remain non-deletable (existing behavior preserved)', () => {
    const data = ghostShapedDoc({ ops: { ebay: { itemId: '1234567890' } } });
    const result = classifyGhost(UUID, data);
    expect(result).not.toBeNull();
    expect(result.hasEbayListing).toBe(true);
    expect(result.deletable).toBe(false);
  });
});
