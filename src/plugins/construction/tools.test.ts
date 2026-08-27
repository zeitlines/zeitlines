import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkTradeConflicts, constructionTools, shiftTradeChain } from './tools';
import { constructionManifest } from './manifest';
import {
  CONSTRUCTION_PLUGIN,
  DATE_BINDING_KEY,
  FIXED_DATE_KEY,
  LAG_DAYS_KEY,
  SECTION_KEY,
  TRADE_KEY,
} from './schedule';
import { validateToolArgs, validateToolPlan, type ToolPlan } from '../../pluginHost/api';
import type { TimelineFile, TimelineFileItem } from '../../types';

// The rules themselves are pinned in `schedule.test.ts`. These tests are about the two
// verbs as the host sees them: the arguments they accept, the plans they return, and the
// refusals a caller has to be able to act on.
//
// Every plan is checked against `validateToolPlan`, which is the frame the host puts
// around a rule — ids that exist, no rename, nothing host-managed, and no `changes` from
// a verb that declared no `writes`. Cheaper to assert here than to discover through a
// refused call.

type Decl = NonNullable<typeof constructionManifest.tools>[number];
const decl = (name: string): Decl => constructionManifest.tools!.find((t) => t.name === name)!;

const NOW = '2026-08-25';

type Spec = {
  start?: string;
  end?: string;
  duration?: string | number;
  content?: string;
  trade?: string;
  section?: string;
  lagDays?: unknown;
  fixedDate?: unknown;
  dateBinding?: unknown;
  dependsOn?: unknown;
};

const item = (id: string, spec: Spec = {}): TimelineFileItem => {
  const metadata: Record<string, unknown> = {};
  if (spec.trade !== undefined) metadata[TRADE_KEY] = spec.trade;
  if (spec.section !== undefined) metadata[SECTION_KEY] = spec.section;
  if (spec.lagDays !== undefined) metadata[LAG_DAYS_KEY] = spec.lagDays;
  if (spec.fixedDate !== undefined) metadata[FIXED_DATE_KEY] = spec.fixedDate;
  if (spec.dateBinding !== undefined) metadata[DATE_BINDING_KEY] = spec.dateBinding;
  if (spec.dependsOn !== undefined) metadata.dependsOn = spec.dependsOn;
  return {
    id,
    content: spec.content ?? id,
    ...(spec.start ? { start: spec.start } : {}),
    ...(spec.end ? { end: spec.end } : {}),
    ...(spec.duration !== undefined ? { duration: spec.duration } : {}),
    metadata,
  };
};

type TradeSpec = [id: string, label: string, lagDays: number];
const TRADES: TradeSpec[] = [
  ['screed', 'Estrich', 28],
  ['flooring', 'Parkett', 0],
  ['painting', 'Malerarbeiten', 2],
];

const CONFIG = { trades: TRADES.map(([id, label, lagDays]) => ({ id, label, lagDays })) };

const file = (items: TimelineFileItem[]): TimelineFile =>
  ({ id: 't', plugins: [{ id: CONSTRUCTION_PLUGIN, config: CONFIG }], items }) as unknown as TimelineFile;

/** Run a verb the way the host does, and hold its plan to the host's own frame. */
const run = (
  name: string,
  handler: (ctx: {
    file: TimelineFile;
    config: Record<string, unknown>;
    args: Record<string, unknown>;
    now: string;
  }) => ToolPlan,
  f: TimelineFile,
  args: Record<string, unknown> = {},
  config: Record<string, unknown> = CONFIG,
): ToolPlan => {
  const argProblems = validateToolArgs(decl(name), args);
  assert.deepEqual(argProblems, [], `the host would refuse these arguments: ${argProblems.join(', ')}`);
  const plan = handler({ file: f, config, args, now: NOW });
  assert.deepEqual(validateToolPlan(decl(name), f, plan), [], 'the host would refuse this plan');
  return plan;
};

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail('expected a refusal');
};

const CHAIN: TimelineFileItem[] = [
  item('screed', { start: '2026-09-01', end: '2026-09-05', trade: 'screed', section: 'WE-3' }),
  item('floor', { start: '2026-10-03', end: '2026-10-10', trade: 'flooring', section: 'WE-3', dependsOn: ['screed'] }),
  item('paint', { start: '2026-10-10', end: '2026-10-14', trade: 'painting', section: 'WE-3', dependsOn: ['floor'] }),
];

// ---------------------------------------------------------------------------
// check_trade_conflicts

test('a schedule that holds is reported as holding, with the day it was checked', () => {
  const plan = run('check_trade_conflicts', checkTradeConflicts, file(CHAIN));
  assert.equal(plan.changes, undefined);
  assert.ok(plan.notes!.some((n) => n.includes(NOW)));
  assert.ok(plan.notes!.some((n) => n.includes('nothing in conflict')));
});

test('an empty timeline says there is no schedule rather than reporting nothing wrong', () => {
  const plan = run('check_trade_conflicts', checkTradeConflicts, file([]));
  assert.ok(plan.notes!.some((n) => n.includes('no items')));
});

test('a timeline with no trades configured says which check did not run', () => {
  // „Nothing in conflict" would otherwise read as covering the order of the work, which
  // was not checked at all.
  const plan = run('check_trade_conflicts', checkTradeConflicts, file(CHAIN), {}, { trades: [] });
  assert.ok(plan.notes!.some((n) => n.includes('configures no trades')));
});

test('an overlap names both items, both trades and the section', () => {
  const plan = run(
    'check_trade_conflicts',
    checkTradeConflicts,
    file([
      item('a', { start: '2026-09-01', end: '2026-09-08', trade: 'screed', section: 'WE-3', content: 'Estrich WE-3' }),
      item('b', { start: '2026-09-05', end: '2026-09-09', trade: 'painting', section: 'WE-3', content: 'Malern WE-3' }),
    ]),
  );
  const note = plan.notes!.find((n) => n.includes('overlap'))!;
  assert.ok(note.includes('WE-3'));
  assert.ok(note.includes('Estrich'));
  assert.ok(note.includes('Malerarbeiten'));
  assert.ok(note.includes('3 days'));
});

test('a broken fixed date names its binding and what that binding means', () => {
  const plan = run(
    'check_trade_conflicts',
    checkTradeConflicts,
    file([
      item('handover', {
        start: '2026-09-01',
        end: '2026-12-15',
        fixedDate: '2026-12-01',
        dateBinding: 'contract',
      }),
    ]),
  );
  const note = plan.notes!.find((n) => n.includes('2026-12-01'))!;
  assert.ok(note.includes('Vertragsfrist'));
  assert.ok(note.includes('default in itself'));
});

test('a control deadline is reported as carrying no consequence of its own', () => {
  const plan = run(
    'check_trade_conflicts',
    checkTradeConflicts,
    file([
      item('rough-in', { start: '2026-09-01', end: '2026-12-15', fixedDate: '2026-12-01', dateBinding: 'control' }),
    ]),
  );
  assert.ok(plan.notes!.some((n) => n.includes('Kontrollfrist')));
});

test('a fixed date with no binding says the binding is unstated', () => {
  const plan = run(
    'check_trade_conflicts',
    checkTradeConflicts,
    file([item('x', { start: '2026-09-01', end: '2026-12-15', fixedDate: '2026-12-01' })]),
  );
  assert.ok(plan.notes!.some((n) => n.includes('unstated binding')));
});

test('a value the plugin refuses is reported with the value and the shape it wants', () => {
  const plan = run(
    'check_trade_conflicts',
    checkTradeConflicts,
    file([item('x', { start: '2026-09-01', trade: 'screed', lagDays: '4 Wochen' })]),
  );
  const note = plan.notes!.find((n) => n.includes('4 Wochen'))!;
  assert.ok(note.includes('YYYY-MM-DD'));
});

test('a cycle is reported first, whatever else is wrong', () => {
  const plan = run(
    'check_trade_conflicts',
    checkTradeConflicts,
    file([
      item('a', { start: '2026-09-01', trade: 'screed', dependsOn: ['b'] }),
      item('b', { start: '2026-09-02', trade: 'not-configured', dependsOn: ['a'] }),
    ]),
  );
  // Everything computed on a cyclic graph is worth less than the news that the graph is
  // cyclic, so it leads. Note 0 is the count line.
  assert.ok(plan.notes![1]!.includes('cycle'));
});

test('a section filter narrows the report and keeps the whole chain in the arithmetic', () => {
  const plan = run('check_trade_conflicts', checkTradeConflicts, file(CHAIN), { section: 'WE-3' });
  assert.ok(plan.notes!.some((n) => n.includes('nothing in conflict')));
});

test('a filter matching nothing says so instead of reporting a clean schedule', () => {
  const plan = run('check_trade_conflicts', checkTradeConflicts, file(CHAIN), { section: 'WE-9' });
  assert.ok(plan.notes!.some((n) => n.includes('WE-9')));
  assert.equal(
    plan.notes!.some((n) => n.includes('nothing in conflict')),
    false,
  );
});

test('a cycle survives a filter that excludes it', () => {
  // A cycle is a property of the graph rather than of one section, and a filtered-out
  // cycle would silently invalidate every other finding in the answer.
  const plan = run(
    'check_trade_conflicts',
    checkTradeConflicts,
    file([
      item('a', { start: '2026-09-01', trade: 'screed', section: 'WE-3' }),
      item('x', { start: '2026-09-01', dependsOn: ['y'] }),
      item('y', { start: '2026-09-02', dependsOn: ['x'] }),
    ]),
    { section: 'WE-3' },
  );
  assert.ok(plan.notes!.some((n) => n.includes('cycle')));
});

test('the check verb returns no changes, which is what the host enforces', () => {
  // `validateToolPlan` inside `run` refuses `changes` from a verb declaring no `writes`,
  // so this is the assertion that the declaration stayed true.
  const plan = run('check_trade_conflicts', checkTradeConflicts, file(CHAIN));
  assert.equal(plan.changes, undefined);
});

// ---------------------------------------------------------------------------
// shift_trade_chain

test('a shift patches only dates, and never the plugin’s own fields', () => {
  const plan = run('shift_trade_chain', shiftTradeChain, file(CHAIN), { item: 'screed', days: 7 });
  assert.equal(plan.changes!.length, 3);
  for (const change of plan.changes!) {
    assert.equal(change.op, 'update');
    const patch = change.op === 'update' ? change.patch : {};
    assert.deepEqual(
      Object.keys(patch).sort(),
      ['end', 'start'],
      'a shift must move dates and nothing else',
    );
    // The three absences the manifest names, asserted so a later edit cannot lose them:
    // moving work in time says nothing about who does it, where, or what a contract makes
    // binding.
    assert.equal('metadata' in patch, false);
  }
});

test('an item with a duration gets no end written', () => {
  const plan = run(
    'shift_trade_chain',
    shiftTradeChain,
    file([item('a', { start: '2026-09-01', duration: '7d', trade: 'screed' })]),
    { item: 'a', days: 3 },
  );
  const patch = plan.changes![0]!.op === 'update' ? plan.changes![0]!.patch : {};
  assert.deepEqual(Object.keys(patch), ['start']);
  assert.equal(patch.start, '2026-09-04');
});

test('a shift by a trade moves every item carrying it', () => {
  const plan = run(
    'shift_trade_chain',
    shiftTradeChain,
    file([...CHAIN, item('screed-2', { start: '2026-09-06', end: '2026-09-09', trade: 'screed' })]),
    { trade: 'screed', days: 7 },
  );
  assert.equal(plan.changes!.length, 4);
  assert.ok(plan.notes![0]!.includes('2 starting points'));
});

test('the direction and the size of the shift are both stated', () => {
  const later = run('shift_trade_chain', shiftTradeChain, file(CHAIN), { item: 'screed', days: 7 });
  assert.ok(later.notes![0]!.includes('7 days later'));
  const earlier = run('shift_trade_chain', shiftTradeChain, file(CHAIN), { item: 'paint', days: -3 });
  assert.ok(earlier.notes![0]!.includes('3 days earlier'));
});

test('a shift of zero days writes nothing and says so', () => {
  const plan = run('shift_trade_chain', shiftTradeChain, file(CHAIN), { item: 'screed', days: 0 });
  assert.equal(plan.changes, undefined);
  assert.ok(plan.notes![0]!.includes('changes nothing'));
});

test('a held fixed date is reported as held, with its date', () => {
  const plan = run(
    'shift_trade_chain',
    shiftTradeChain,
    file([
      ...CHAIN,
      item('handover', {
        start: '2026-10-16',
        end: '2026-10-16',
        fixedDate: '2026-10-16',
        dateBinding: 'contract',
        dependsOn: ['paint'],
        content: 'Übergabe',
      }),
    ]),
    { item: 'screed', days: 7 },
  );
  assert.equal(plan.changes!.length, 3);
  assert.ok(plan.notes!.some((n) => n.includes('was NOT moved') && n.includes('2026-10-16')));
  const broken = plan.notes!.find((n) => n.includes('can no longer meet'))!;
  assert.ok(broken.includes('2026-10-23'), 'the note has to say the day the chain now needs');
  assert.ok(broken.includes('7 days over'));
  assert.ok(broken.includes('Vertragsfrist'));
  assert.ok(broken.includes('Nothing was compressed'));
});

test('a negative shift reports the lag it breaks', () => {
  const plan = run('shift_trade_chain', shiftTradeChain, file(CHAIN), { item: 'floor', days: -7 });
  const note = plan.notes!.find((n) => n.includes('after the shift'))!;
  assert.ok(note.includes('2026-10-03'));
  assert.ok(note.includes('Estrich'));
  assert.ok(note.includes('28-day wait'));
});

test('both selectors at once is refused, and so is neither', () => {
  const f = file(CHAIN);
  assert.match(
    refusal(() => shiftTradeChain({ file: f, config: CONFIG, args: { item: 'screed', trade: 'screed', days: 7 }, now: NOW })),
    /not both/,
  );
  assert.match(
    refusal(() => shiftTradeChain({ file: f, config: CONFIG, args: { days: 7 }, now: NOW })),
    /give "item" or "trade"/,
  );
});

test('an id the timeline does not carry is refused by name', () => {
  const f = file(CHAIN);
  assert.match(
    refusal(() => shiftTradeChain({ file: f, config: CONFIG, args: { item: 'ghost', days: 7 }, now: NOW })),
    /no item "ghost"/,
  );
  assert.match(
    refusal(() => shiftTradeChain({ file: f, config: CONFIG, args: { trade: 'roofing', days: 7 }, now: NOW })),
    /nothing to move/,
  );
});

test('a cycle refuses the whole plan and says nothing was changed', () => {
  const f = file([
    item('a', { start: '2026-09-01', dependsOn: ['b'] }),
    item('b', { start: '2026-09-02', dependsOn: ['a'] }),
  ]);
  const message = refusal(() => shiftTradeChain({ file: f, config: CONFIG, args: { item: 'a', days: 7 }, now: NOW }));
  assert.match(message, /cycle/);
  assert.match(message, /Nothing was changed/);
});

test('a chain in which nothing can move says that instead of returning an empty plan', () => {
  const f = file([item('only', { start: '2026-09-01', fixedDate: '2026-09-30' })]);
  const plan = run('shift_trade_chain', shiftTradeChain, f, { item: 'only', days: 7 });
  assert.equal(plan.changes?.length ?? 0, 0);
  assert.ok(plan.notes![0]!.includes('nothing moved'));
});

test('both verbs are the two the manifest declares', () => {
  assert.deepEqual(Object.keys(constructionTools).sort(), ['check_trade_conflicts', 'shift_trade_chain']);
});
