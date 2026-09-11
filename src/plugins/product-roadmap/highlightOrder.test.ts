import assert from 'node:assert/strict';
import test from 'node:test';
import { highlightNeighbours, moveHighlightRows } from './highlightOrder';
import type { PricingHighlight } from './types';

const highlight = (id: string, section?: string): PricingHighlight => ({ id, label: id, featureIds: [id], section });

test('finds neighbours only inside the same section', () => {
  const rows = [highlight('a', 'One'), highlight('x', 'Two'), highlight('b', 'One'), highlight('c', 'One')];
  assert.deepEqual(highlightNeighbours(rows, 'b'), { previous: rows[0], next: rows[3] });
});

test('treats missing and blank sections as the same section', () => {
  const rows = [highlight('a'), highlight('b', '  ')];
  assert.deepEqual(highlightNeighbours(rows, 'a'), { previous: undefined, next: rows[1] });
});

test('reorders inside a section and keeps section order stable', async () => {
  const rows = [highlight('a1', 'A'), highlight('b1', 'B'), highlight('a2', 'A')];
  const moves: unknown[] = [];
  await moveHighlightRows(
    rows,
    'a1',
    'a2',
    async (id, anchor) => {
      moves.push({ id, anchor });
      return ['a2', 'a1', 'b1'];
    },
    () => {},
  );
  assert.deepEqual(moves, [
    { id: 'a1', anchor: { after: 'a2' } },
    { id: 'b1', anchor: { after: 'a1' } },
  ]);
});

test('refuses movement across sections', async () => {
  const rows = [highlight('a', 'A'), highlight('b', 'B')];
  assert.equal(await moveHighlightRows(rows, 'a', 'b', async () => [], () => {}), 0);
});
