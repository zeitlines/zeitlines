import test from 'node:test';
import assert from 'node:assert/strict';

import { renameGroupRows } from './groupRename';
import { ConflictError } from '../../pluginHost/api';
import type { PricingFeature } from './types';

const features: PricingFeature[] = [
  { id: 'a', name: 'A', group: 'Calls', rowVersion: 3 },
  { id: 'b', name: 'B', group: ' Calls ', rowVersion: 8 },
  { id: 'c', name: 'C', group: 'Messages', rowVersion: 5 },
];

test('renames every feature in the displayed group with its own lock counter', async () => {
  const writes: unknown[] = [];
  const mirrored: string[] = [];

  const count = await renameGroupRows(
    features,
    'Calls',
    'Telephony',
    async (id, patch, rowVersion) => {
      writes.push({ id, patch, rowVersion });
      return { id, data: { name: id.toUpperCase(), group: patch.group }, version: (rowVersion ?? 0) + 1 };
    },
    async () => [],
    (row) => mirrored.push(row.id),
  );

  assert.equal(count, 2);
  assert.deepEqual(writes, [
    { id: 'a', patch: { group: 'Telephony' }, rowVersion: 3 },
    { id: 'b', patch: { group: 'Telephony' }, rowVersion: 8 },
  ]);
  assert.deepEqual(mirrored, ['a', 'b']);
});

test('mirrors completed writes before a later member fails', async () => {
  const attempted: string[] = [];
  const mirrored: string[] = [];

  await assert.rejects(
    renameGroupRows(
      features,
      'Calls',
      'Telephony',
      async (id) => {
        attempted.push(id);
        if (id === 'b') throw new Error('conflict');
        return { id, data: { name: id.toUpperCase(), group: 'Telephony' } };
      },
      async () => [],
      (row) => mirrored.push(row.id),
    ),
    /conflict/,
  );

  assert.deepEqual(attempted, ['a', 'b']);
  assert.deepEqual(mirrored, ['a']);
});

test('does not write an empty or unchanged title', async () => {
  let writes = 0;
  const update = async () => {
    writes++;
    return { id: 'a', data: {} };
  };

  assert.equal(await renameGroupRows(features, 'Calls', ' Calls ', update, async () => [], () => {}), 0);
  assert.equal(await renameGroupRows(features, 'Calls', '   ', update, async () => [], () => {}), 0);
  assert.equal(writes, 0);
});

test('refreshes a file-backed row after the preceding write changed the file lock', async () => {
  const attempts: unknown[] = [];
  const mirrored: string[] = [];

  await renameGroupRows(
    features.slice(0, 2),
    'Calls',
    'Telephony',
    async (id, patch, rowVersion) => {
      attempts.push({ id, rowVersion });
      if (id === 'b' && rowVersion === 8) throw new ConflictError();
      return { id, data: { name: id.toUpperCase(), group: patch.group }, version: rowVersion === 8 ? 9 : 12 };
    },
    async () => [{ id: 'b', data: { name: 'B', group: 'Calls' }, version: 11 }],
    (row) => mirrored.push(row.id),
  );

  assert.deepEqual(attempts, [
    { id: 'a', rowVersion: 3 },
    { id: 'b', rowVersion: 8 },
    { id: 'b', rowVersion: 11 },
  ]);
  assert.deepEqual(mirrored, ['a', 'b']);
});

test('keeps a concurrent group change as a conflict', async () => {
  await assert.rejects(
    renameGroupRows(
      [features[0]],
      'Calls',
      'Telephony',
      async () => {
        throw new ConflictError();
      },
      async () => [{ id: 'a', data: { name: 'A', group: 'Elsewhere' }, version: 4 }],
      () => {},
    ),
    ConflictError,
  );
});
