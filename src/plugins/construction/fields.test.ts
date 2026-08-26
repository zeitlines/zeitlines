import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSTRUCTION_PLUGIN,
  DATE_BINDING_KEY,
  EARLIEST_START_KEY,
  FIXED_DATE_KEY,
  LAG_DAYS_KEY,
  SECTION_KEY,
  TRADE_KEY,
  constructionDerive,
  constructionFields,
  tradeOptions,
} from './fields';
import { constructionManifest } from './manifest';
import { DATE_BINDINGS } from './schedule';
import { LOCALES, setLocale } from '../../i18n';
import type { TimelineFile, TimelineFileItem } from '../../types';

// The fields as the item form and the grouping menu see them, and the one value behind
// the computed field. No DOM: a field definition is data.

type TradeSpec = [id: string, label: string, lagDays: number];

const TRADES: TradeSpec[] = [
  ['screed', 'Estrich', 28],
  ['flooring', 'Parkett', 0],
];

const item = (id: string, meta: Record<string, unknown> = {}, dates: Partial<TimelineFileItem> = {}) =>
  ({ id, content: id, ...dates, metadata: meta }) as TimelineFileItem;

const file = (items: TimelineFileItem[] = [], trades: TradeSpec[] = TRADES): TimelineFile =>
  ({
    id: 't',
    plugins: [
      { id: CONSTRUCTION_PLUGIN, config: { trades: trades.map(([id, label, lagDays]) => ({ id, label, lagDays })) } },
    ],
    items,
  }) as unknown as TimelineFile;

const keys = (f: TimelineFile | null) => constructionFields(f).map((d) => d.key);

test('no fields without the plugin, and none for no timeline', () => {
  assert.deepEqual(constructionFields(null), []);
  assert.deepEqual(constructionFields({ id: 't', items: [] } as unknown as TimelineFile), []);
});

test('all six fields appear as soon as the plugin is on, with no config at all', () => {
  // A timeline that has just switched the plugin on needs somewhere to write the first
  // trade. Gating the fields on a populated config would leave the user with no way to
  // produce the data the config is about.
  assert.deepEqual(keys(file([], [])), [
    TRADE_KEY,
    SECTION_KEY,
    LAG_DAYS_KEY,
    FIXED_DATE_KEY,
    DATE_BINDING_KEY,
    EARLIEST_START_KEY,
  ]);
});

test('exactly one field is derived, and it is the computed one', () => {
  const derived = constructionFields(file()).filter((d) => d.derived);
  assert.deepEqual(
    derived.map((d) => d.key),
    [EARLIEST_START_KEY],
  );
});

test('every stored field is declared in metadataKeys, and the computed one is not', () => {
  // The manifest's list is what an uninstall cleans off items. A stored key missing from
  // it survives the uninstall; the computed key listed there would promise a cleanup with
  // nothing to clean.
  const declared = new Set(constructionManifest.metadataKeys ?? []);
  for (const def of constructionFields(file())) {
    if (def.derived) assert.equal(declared.has(def.key), false, `${def.key} is computed and must not be declared`);
    else assert.equal(declared.has(def.key), true, `${def.key} is stored and must be declared`);
  }
  assert.equal(declared.size, 5);
});

test('the trade options are the configured trades, labelled as the project named them', () => {
  assert.deepEqual(tradeOptions(file()), [
    { value: 'screed', label: 'Estrich' },
    { value: 'flooring', label: 'Parkett' },
  ]);
});

test('a trade only present on items is still offered, labelled with its own id', () => {
  // The failure this prevents: a select renders only what it offers, so a trade dropped
  // from the config would leave its items in front of an empty control over a value still
  // sitting in `metadata` — invisible, and one save away from being lost.
  const f = file([item('a', { [TRADE_KEY]: 'retired-trade' }), item('b', { [TRADE_KEY]: 'screed' })]);
  assert.deepEqual(tradeOptions(f), [
    { value: 'screed', label: 'Estrich' },
    { value: 'flooring', label: 'Parkett' },
    { value: 'retired-trade', label: 'retired-trade' },
  ]);
});

test('a configured trade present on items is offered once', () => {
  const f = file([item('a', { [TRADE_KEY]: 'screed' })]);
  assert.deepEqual(
    tradeOptions(f).map((o) => o.value),
    ['screed', 'flooring'],
  );
});

test('both bindings are offered, occupied or not', () => {
  const binding = constructionFields(file()).find((d) => d.key === DATE_BINDING_KEY)!;
  assert.equal(binding.type, 'select');
  assert.deepEqual(
    (binding.options ?? []).map((o) => o.value),
    ['contract', 'control'],
  );
});

// ---------------------------------------------------------------------------
// the boundary a translation must not cross

test('a stored binding value is not a translated label', () => {
  // The worst and quietest failure this codebase has: a select stores an **id** and shows
  // a **label**, so a sweep that translated the id would leave every existing item
  // carrying a value that is no longer offered. The field renders empty, the filter loses
  // a bucket, and nothing errors.
  const before = constructionFields(file()).find((d) => d.key === DATE_BINDING_KEY)!;
  const labelsBefore = (before.options ?? []).map((o) => o.label);

  const seen: string[][] = [];
  for (const locale of LOCALES) {
    setLocale(locale);
    const def = constructionFields(file()).find((d) => d.key === DATE_BINDING_KEY)!;
    assert.deepEqual(
      (def.options ?? []).map((o) => o.value),
      [...DATE_BINDINGS],
      `the stored values moved in ${locale}`,
    );
    seen.push((def.options ?? []).map((o) => String(o.label)));
  }

  // And the labels really do move, so the assertion above is not passing because nothing
  // is translated at all.
  assert.notDeepEqual(seen[0], seen[1]);
  assert.equal(labelsBefore.length, 2);
});

test('a value stored under one language resolves under the other', () => {
  setLocale('de');
  const stored = constructionFields(file()).find((d) => d.key === DATE_BINDING_KEY)!.options![0]!.value;
  setLocale('en');
  const options = constructionFields(file()).find((d) => d.key === DATE_BINDING_KEY)!.options ?? [];
  assert.ok(options.find((o) => o.value === stored), 'a value stored in German no longer resolves in English');
});

test('a trade label from the config is never translated', () => {
  // It is a value the author typed, not interface text: „Estrich" is the project's word
  // for its own Gewerk, and looking it up in a catalogue would rename somebody's trade.
  for (const locale of LOCALES) {
    setLocale(locale);
    assert.equal(tradeOptions(file()).find((o) => o.value === 'screed')?.label, 'Estrich');
  }
});

// ---------------------------------------------------------------------------
// the computed value

const CHAIN: TimelineFileItem[] = [
  item('screed', { [TRADE_KEY]: 'screed' }, { start: '2026-09-01', end: '2026-09-05' }),
  item('floor', { [TRADE_KEY]: 'flooring', dependsOn: ['screed'] }, { start: '2026-10-03' }),
];

test('nothing is derived without the plugin', () => {
  assert.equal(constructionDerive(null), null);
  assert.equal(constructionDerive({ id: 't', items: CHAIN } as unknown as TimelineFile), null);
});

test('the derived earliest start is the predecessor end plus its lag', () => {
  const derive = constructionDerive(file(CHAIN))!;
  assert.deepEqual(derive(CHAIN[1]!), { [EARLIEST_START_KEY]: '2026-10-03' });
});

test('an item with no predecessors derives nothing rather than its own start', () => {
  const derive = constructionDerive(file(CHAIN))!;
  // „May start on the day it starts" is not a statement about a schedule, and an item
  // carrying it would be indistinguishable from one whose chain was actually computed.
  assert.deepEqual(derive(CHAIN[0]!), { [EARLIEST_START_KEY]: undefined });
});

test('an item the timeline does not carry derives nothing', () => {
  const derive = constructionDerive(file(CHAIN))!;
  assert.deepEqual(derive(item('stranger')), {});
});

test('an unknown trade upstream leaves the earliest start empty', () => {
  const chain = [
    item('mystery', { [TRADE_KEY]: 'not-configured' }, { start: '2026-09-01', end: '2026-09-05' }),
    item('floor', { [TRADE_KEY]: 'flooring', dependsOn: ['mystery'] }, { start: '2026-10-03' }),
  ];
  const derive = constructionDerive(file(chain))!;
  assert.deepEqual(derive(chain[1]!), { [EARLIEST_START_KEY]: undefined });
});

test('an empty config derives nothing anywhere, and does not throw', () => {
  const derive = constructionDerive(file(CHAIN, []))!;
  for (const one of CHAIN) assert.deepEqual(derive(one), { [EARLIEST_START_KEY]: undefined });
});

test('a malformed config is survived rather than trusted', () => {
  const f = {
    id: 't',
    plugins: [{ id: CONSTRUCTION_PLUGIN, config: { trades: [{ id: 'screed' }, 'nonsense', 7] } }],
    items: CHAIN,
  } as unknown as TimelineFile;
  // Every entry of the config is unusable, so nothing is offered from it and the two
  // trades the items carry are offered under their own ids.
  assert.deepEqual(tradeOptions(f), [
    { value: 'screed', label: 'screed' },
    { value: 'flooring', label: 'flooring' },
  ]);
  const derive = constructionDerive(f)!;
  assert.deepEqual(derive(CHAIN[1]!), { [EARLIEST_START_KEY]: undefined });
});
