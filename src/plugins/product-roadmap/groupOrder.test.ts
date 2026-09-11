import test from 'node:test';
import assert from 'node:assert/strict';

import { moveGroupRows } from './groupOrder';
import type { PricingFeature } from './types';

const features: PricingFeature[] = [
  { id: 'a1', name: 'A1', group: 'A' },
  { id: 'b1', name: 'B1', group: 'B' },
  { id: 'a2', name: 'A2', group: 'A' },
  { id: 'b2', name: 'B2', group: 'B' },
  { id: 'c1', name: 'C1', group: 'C' },
];

test('moves a whole group before its neighbour and preserves member order', async () => {
  const moves: unknown[] = [];
  const adopted: string[][] = [];

  const count = await moveGroupRows(
    features,
    'B',
    'A',
    'before',
    async (id, anchor) => {
      moves.push({ id, anchor });
      return ['b1', 'b2', 'a1', 'a2', 'c1'];
    },
    (order) => adopted.push(order),
  );

  assert.equal(count, 2);
  assert.deepEqual(moves, [
    { id: 'b1', anchor: { before: 'a1' } },
    { id: 'b2', anchor: { after: 'b1' } },
  ]);
  assert.equal(adopted.length, 2);
});

test('moves a whole group after its neighbour and preserves member order', async () => {
  const moves: unknown[] = [];

  await moveGroupRows(
    features,
    'A',
    'B',
    'after',
    async (id, anchor) => {
      moves.push({ id, anchor });
      return ['b1', 'b2', 'a1', 'a2', 'c1'];
    },
    () => {},
  );

  assert.deepEqual(moves, [
    { id: 'a1', anchor: { after: 'b2' } },
    { id: 'a2', anchor: { after: 'a1' } },
  ]);
});

test('adopts completed host orders before a later move fails', async () => {
  const adopted: string[][] = [];

  await assert.rejects(
    moveGroupRows(
      features,
      'A',
      'B',
      'after',
      async (id) => {
        if (id === 'a2') throw new Error('failed');
        return ['b1', 'a2', 'b2', 'a1', 'c1'];
      },
      (order) => adopted.push(order),
    ),
    /failed/,
  );

  assert.deepEqual(adopted, [['b1', 'a2', 'b2', 'a1', 'c1']]);
});
