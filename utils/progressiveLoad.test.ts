import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleProgressively } from './progressiveLoad.ts';

test('fast sections become visible while a slow section is still pending', async () => {
  let finish!: (v: string) => void;
  const slow = new Promise<string>(r => { finish = r; });
  const shown: number[] = [];
  const all = settleProgressively([slow, Promise.resolve('fast'), Promise.reject(new Error('offline'))], i => shown.push(i));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(shown, [1, 2]);
  finish('slow');
  const results = await all;
  assert.deepEqual(shown, [1, 2, 0]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[2].status, 'rejected');
});
