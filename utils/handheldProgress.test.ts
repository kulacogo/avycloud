import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProgress, packProgress, mayReprintLabel } from './handheldProgress.ts';

test('pick progress uses central quantities and counts positions separately from units', () => {
  assert.deepEqual(pickProgress([{ itemId: 'a', required: 3, picked: 2 }, { itemId: 'b', required: 1, picked: 1 }]),
    { totalItems: 2, completedItems: 1, totalUnits: 4, pickedUnits: 3, complete: false });
});
test('empty work is not completed work', () => assert.equal(pickProgress([]).complete, false));
test('packing requires verification of every position of this order', () => {
  assert.equal(packProgress(['a', 'b'], { a: true, other: true }).complete, false);
  assert.equal(packProgress(['a', 'b'], { a: true, b: true }).complete, true);
});

test('a timed-out or still queued print never offers a second job', () => {
  for (const state of [null, 'queued', 'claimed', 'dispatching']) assert.equal(mayReprintLabel(state), false);
  for (const state of ['done', 'failed', 'uncertain']) assert.equal(mayReprintLabel(state), true);
});
