import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCaptureSellPrice } from './captureSellPrice.ts';

test('allows a missing research result to be saved or completed directly', () => {
  assert.deepEqual(validateCaptureSellPrice(''), {});
  assert.deepEqual(validateCaptureSellPrice('49.95'), { amount: 49.95 });
});
test('does not silently preserve a sale price the user cleared or changed to an invalid value', () => {
  for (const input of ['', ' ', '0', '-1', 'NaN', 'Infinity', '12.345']) {
    assert.ok(validateCaptureSellPrice(input, 59.99).error, input);
  }
  assert.deepEqual(validateCaptureSellPrice('39.9', 59.99), { amount: 39.9 });
  assert.deepEqual(validateCaptureSellPrice('0.01'), { amount: 0.01 });
});
