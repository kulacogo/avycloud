'use strict';

/**
 * Tests for scripts/clear-listing-pointers-gmbh.js
 *
 * After the account swap, products still carry the OLD account's listing
 * pointers (ops.ebay.itemId / ops.kaufland.unitId / ops.listingStatus.*).
 * This clears them SAFELY: full-doc round-trip through saveProductV2 with
 * skipStockEvent (proven inventory-neutral by the safety review — saveProductV2
 * writes inventory verbatim from the DB for an existing doc).
 *
 * GOLDENE REGEL: inventory must never change. The pure transform test asserts
 * inventory is preserved; the runner injects a fake saveProduct so no real write.
 */

const {
  clearListingPointers,
  hasListingPointer,
  runClearPointers,
} = require('../../scripts/clear-listing-pointers-gmbh');

describe('clearListingPointers', () => {
  it('nulls the ebay/kaufland pointers + listing status, preserving inventory and other ops', () => {
    const product = {
      id: 'p1',
      inventory: { quantity: 7 },
      ops: {
        ebay: { itemId: '110123', foo: 'keep' },
        kaufland: { unitId: 'u-9', bar: 'keep' },
        listingStatus: { ebay: 'active', kaufland: 'active' },
        other: 'keep',
      },
    };
    const out = clearListingPointers(product);
    expect(out.ops.ebay.itemId).toBeNull();
    expect(out.ops.kaufland.unitId).toBeNull();
    expect(out.ops.listingStatus).toEqual({ ebay: null, kaufland: null });
    // preserved — GOLDENE REGEL + no collateral loss
    expect(out.inventory.quantity).toBe(7);
    expect(out.ops.ebay.foo).toBe('keep');
    expect(out.ops.kaufland.bar).toBe('keep');
    expect(out.ops.other).toBe('keep');
  });

  it('does not throw when ops or sub-objects are missing', () => {
    expect(() => clearListingPointers({ id: 'p2' })).not.toThrow();
    expect(clearListingPointers({ id: 'p2' }).id).toBe('p2');
  });

  it('does not mutate the input object', () => {
    const product = { id: 'p3', ops: { ebay: { itemId: 'x' } } };
    clearListingPointers(product);
    expect(product.ops.ebay.itemId).toBe('x'); // original untouched
  });
});

describe('hasListingPointer', () => {
  it('detects any set pointer', () => {
    expect(hasListingPointer({ ops: { ebay: { itemId: 'x' } } })).toBe(true);
    expect(hasListingPointer({ ops: { kaufland: { unitId: 'u' } } })).toBe(true);
    expect(hasListingPointer({ ops: { listingStatus: { ebay: 'active' } } })).toBe(true);
  });
  it('is false when nothing is set', () => {
    expect(hasListingPointer({ ops: {} })).toBe(false);
    expect(hasListingPointer({})).toBe(false);
  });
});

describe('runClearPointers', () => {
  it('apply: clears + saves only products that carry a pointer', async () => {
    const saved = [];
    const products = [
      { id: 'p1', inventory: { quantity: 1 }, ops: { ebay: { itemId: 'x' } } },
      { id: 'p2', inventory: { quantity: 2 }, ops: {} }, // no pointer → skipped
    ];
    const res = await runClearPointers({ products, saveProduct: async (p) => saved.push(p), apply: true });
    expect(res.scanned).toBe(2);
    expect(res.cleared).toBe(1);
    expect(saved.map((p) => p.id)).toEqual(['p1']);
    expect(saved[0].ops.ebay.itemId).toBeNull();
    expect(saved[0].inventory.quantity).toBe(1); // untouched
  });

  it('dry-run: saves nothing but counts what would be cleared', async () => {
    const saved = [];
    const products = [{ id: 'p1', ops: { ebay: { itemId: 'x' } } }];
    const res = await runClearPointers({ products, saveProduct: async (p) => saved.push(p), apply: false });
    expect(saved).toEqual([]);
    expect(res.cleared).toBe(1);
  });
});
