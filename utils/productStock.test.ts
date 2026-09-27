import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProductPhysicalQuantity, getProductAvailableQuantity } from './product.ts';
const product = (extra: any = {}) => ({ inventory: { quantity: 5 }, storageBins: [], ...extra } as any);
test('no location means zero warehouse and available stock, without exceptions', () => {
 const p = product({ inventory: { quantity: 5, physicalQuantity: 5, availableQuantity: 5 }, ops: { relocation: { unassignedQuantity: 5 } } });
 assert.equal(getProductPhysicalQuantity(p), 0); assert.equal(getProductAvailableQuantity(p), 0);
});
test('only allocated units count, then reservations are deducted', () => {
 const p = product({ inventory: { quantity: 5, availableQuantity: 4, reservedQuantity: 1 }, storageBins: [{ code: 'A-01', quantity: 2 }] });
 assert.equal(getProductPhysicalQuantity(p), 2); assert.equal(getProductAvailableQuantity(p), 1);
});
test('stale primary location and unnamed allocations never restore empty stock', () => {
 assert.equal(getProductPhysicalQuantity(product({storage: { binCode: 'A-01', quantity: 5 }})), 0);
 assert.equal(getProductPhysicalQuantity(product({storageBins: [{quantity: 5}]})), 0);
});
