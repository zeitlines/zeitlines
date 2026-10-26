import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dependsOnOf } from './dependsOn';

const item = (dependsOn?: unknown) => ({
  content: 'Item',
  ...(dependsOn === undefined ? {} : { metadata: { dependsOn } }),
});

test('dependsOnOf keeps whitespace in list entries', () => {
  assert.deepEqual(dependsOnOf(item([' P-1 ', 'P-2', ''])), [' P-1 ', 'P-2']);
});

test('dependsOnOf trims the single-string form', () => {
  assert.deepEqual(dependsOnOf(item('  P-1  ')), ['P-1']);
  assert.deepEqual(dependsOnOf(item('   ')), []);
});

test('dependsOnOf returns no ids for missing and invalid values', () => {
  assert.deepEqual(dependsOnOf(item()), []);
  assert.deepEqual(dependsOnOf({ content: 'Item', metadata: {} }), []);
  assert.deepEqual(dependsOnOf(item(42)), []);
  assert.deepEqual(dependsOnOf(item({ id: 'P-1' })), []);
});
