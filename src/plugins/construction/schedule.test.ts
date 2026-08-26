import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSTRUCTION_PLUGIN,
  DATE_BINDING_KEY,
  FIXED_DATE_KEY,
  LAG_DAYS_KEY,
  SECTION_KEY,
  TRADE_KEY,
  cyclesOf,
  day,
  daysBetween,
  dependsOnOf,
  earliestStart,
  edgesOf,
  findingsOf,
  lagAfter,
  lagValue,
  overlapDays,
  readConfig,
  readSchedule,
  readWork,
  seedsFor,
  shiftChain,
  tradesOnItems,
} from './schedule';
import type { TimelineFile, TimelineFileItem } from '../../types';

// The rules, without a `ToolContext` and without a DOM. This is where a wrong lag or a
// wrong chain gets caught — the verbs on top of them are pinned in `tools.test.ts`.
//
// The boundaries the domain cares about are all here and each has its own test: a lag of
// zero, a cycle in the dependencies, a shift crossing a fixed date, and two trades in one
// section touching end to start.

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

const file = (items: TimelineFileItem[], trades: TradeSpec[] = []): TimelineFile =>
  ({
    id: 't',
    plugins: [
      { id: CONSTRUCTION_PLUGIN, config: { trades: trades.map(([id, label, lagDays]) => ({ id, label, lagDays })) } },
    ],
    items,
  }) as unknown as TimelineFile;

const TRADES: TradeSpec[] = [
  ['screed', 'Estrich', 28],
  ['flooring', 'Parkett', 0],
  ['painting', 'Malerarbeiten', 2],
];

const config = (trades: TradeSpec[] = TRADES) =>
  readConfig({ trades: trades.map(([id, label, lagDays]) => ({ id, label, lagDays })) });

// ---------------------------------------------------------------------------
// parsing

test('a day is accepted only as YYYY-MM-DD', () => {
  assert.equal(day('2026-09-01'), '2026-09-01');
  // The failure this strictness exists for: a German date read as an American one puts
  // every computed day months from where the author meant it.
  assert.equal(day('01.05.2026'), undefined);
  assert.equal(day('2026-9-1'), undefined);
  assert.equal(day(''), undefined);
  assert.equal(day(42), undefined);
});

test('a well-formed but impossible day is refused, not rolled over', () => {
  // 2026-02-30 parses to March 2nd, which is a date nobody wrote.
  assert.equal(day('2026-02-30'), undefined);
  assert.equal(day('2026-02-28'), '2026-02-28');
});

test('a lag of zero is a value, and a negative one is not', () => {
  assert.equal(lagValue('0'), 0);
  assert.equal(lagValue(0), 0);
  assert.equal(lagValue('28'), 28);
  assert.equal(lagValue('-1'), undefined);
  assert.equal(lagValue('4 Wochen'), undefined);
  assert.equal(lagValue('3.5'), undefined);
  assert.equal(lagValue(undefined), undefined);
});

test('daysBetween counts whole days in both directions', () => {
  assert.equal(daysBetween('2026-09-01', '2026-09-08'), 7);
  assert.equal(daysBetween('2026-09-08', '2026-09-01'), -7);
  assert.equal(daysBetween('2026-09-01', '2026-09-01'), 0);
});

test('an incomplete trade is dropped rather than completed', () => {
  const cfg = readConfig({
    trades: [
      { id: 'screed', label: 'Estrich', lagDays: 28 },
      // No lag: dropped, because zero would be this plugin claiming that nothing has to
      // dry.
      { id: 'tiling', label: 'Fliesen' },
      { id: 'bad id', label: 'Whatever', lagDays: 1 },
      { id: 'screed', label: 'Duplicate', lagDays: 99 },
    ],
  });
  assert.deepEqual(
    cfg.trades.map((t) => [t.id, t.lagDays]),
    [['screed', 28]],
  );
});

test('a config that is not a trades array reads as no trades', () => {
  assert.deepEqual(readConfig(undefined).trades, []);
  assert.deepEqual(readConfig({}).trades, []);
  assert.deepEqual(readConfig({ trades: 'screed' }).trades, []);
});

test('dependsOn is read exactly as the core reads it, whitespace included', () => {
  // A list entry keeps its whitespace, so `" P-1 "` names no item — character for
  // character `extractDependsOn`. Only the single-string form is trimmed. Trimming both
  // would claim a dependent that no arrow on the page corresponds to.
  assert.deepEqual(dependsOnOf(item('a', { dependsOn: [' P-1 ', 'P-2', ''] })), [' P-1 ', 'P-2']);
  assert.deepEqual(dependsOnOf(item('a', { dependsOn: '  P-1  ' })), ['P-1']);
  assert.deepEqual(dependsOnOf(item('a', { dependsOn: '   ' })), []);
  assert.deepEqual(dependsOnOf(item('a')), []);
});

// ---------------------------------------------------------------------------
// the extent

test('the extent comes from end, else from duration, else from the start alone', () => {
  const cfg = config();
  assert.equal(readWork(item('a', { start: '2026-09-01', end: '2026-09-08' }), cfg).end, '2026-09-08');
  assert.equal(readWork(item('b', { start: '2026-09-01', duration: '7d' }), cfg).end, '2026-09-08');
  // A milestone stops where it starts, which is what makes it occupy no time and
  // therefore overlap nothing.
  assert.equal(readWork(item('c', { start: '2026-09-01' }), cfg).end, '2026-09-01');
});

test('only an item carrying its own end is marked as having one', () => {
  const cfg = config();
  assert.equal(readWork(item('a', { start: '2026-09-01', end: '2026-09-08' }), cfg).hasOwnEnd, true);
  assert.equal(readWork(item('b', { start: '2026-09-01', duration: '7d' }), cfg).hasOwnEnd, false);
});

test('a value the plugin refuses is recorded, not silently absent', () => {
  const work = readWork(
    item('a', { start: '2026-09-01', lagDays: '4 Wochen', fixedDate: '31.12.2026', dateBinding: 'binding' }),
    config(),
  );
  assert.equal(work.lagDays, undefined);
  assert.equal(work.fixedDate, undefined);
  assert.equal(work.binding, undefined);
  assert.deepEqual(
    work.badValues.map((b) => b.field).sort(),
    [DATE_BINDING_KEY, FIXED_DATE_KEY, LAG_DAYS_KEY].sort(),
  );
});

test('a timestamp is read as its day and marked as not rewritable', () => {
  const work = readWork(item('a', { start: '2026-09-01T09:30:00' }), config());
  // Read as a day, because every rule here compares days. Not a bad value: it is a
  // perfectly good date that this plugin refuses to WRITE, which is a different fact and
  // would send the author to fix something that is not broken.
  assert.equal(work.start, '2026-09-01');
  assert.deepEqual(work.badValues, []);
  assert.equal(work.datesAreDays, false);
});

test('plain calendar days are rewritable', () => {
  const work = readWork(item('a', { start: '2026-09-01', end: '2026-09-08' }), config());
  assert.equal(work.datesAreDays, true);
});

test('the schedule is read only when the plugin is enabled, and then for every item', () => {
  const items = [item('a', { start: '2026-09-01', trade: 'screed' }), item('b', { start: '2026-09-10' })];
  assert.equal(readSchedule({ id: 't', items } as unknown as TimelineFile, config()).length, 0);
  // Item „b" carries nothing of this plugin's and is still read: a predecessor with no
  // trade is still a predecessor, and its dates are what a successor is measured from.
  assert.equal(readSchedule(file(items, TRADES), config()).length, 2);
});

test('trade ids present on items are collected in first-seen order', () => {
  const f = file([
    item('a', { trade: 'screed' }),
    item('b', { trade: 'flooring' }),
    item('c', { trade: 'screed' }),
    item('d'),
  ]);
  assert.deepEqual(tradesOnItems(f), ['screed', 'flooring']);
});

// ---------------------------------------------------------------------------
// rule: the lag belongs to the predecessor

test('the lag comes from the predecessor trade, and the item overrides it', () => {
  const cfg = config();
  assert.equal(lagAfter(readWork(item('a', { trade: 'screed' }), cfg), cfg), 28);
  assert.equal(lagAfter(readWork(item('a', { trade: 'screed', lagDays: '35' }), cfg), cfg), 35);
  // A zero override is honoured rather than falling through to the trade's 28, which is
  // the whole point of `lagDays !== undefined` instead of a truthiness check.
  assert.equal(lagAfter(readWork(item('a', { trade: 'screed', lagDays: '0' }), cfg), cfg), 0);
  assert.equal(lagAfter(readWork(item('a', { trade: 'unknown' }), cfg), cfg), undefined);
  assert.equal(lagAfter(readWork(item('a'), cfg), cfg), undefined);
});

test('a zero lag lets the successor start the day the predecessor ends', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('floor', { start: '2026-09-01', end: '2026-09-05', trade: 'flooring' }),
        item('paint', { start: '2026-09-05', end: '2026-09-07', trade: 'painting', dependsOn: ['floor'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  // „flooring" imposes zero days, so the earliest start is the predecessor's end itself.
  assert.equal(earliestStart(works[1]!, works, cfg), '2026-09-05');
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'lag-violation').length, 0);
});

test('the earliest start is the latest of every predecessor', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('screed', { start: '2026-09-01', end: '2026-09-05', trade: 'screed' }),
        item('paint', { start: '2026-09-01', end: '2026-09-10', trade: 'painting' }),
        item('floor', { start: '2026-10-03', trade: 'flooring', dependsOn: ['screed', 'paint'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  // screed ends 09-05 + 28 = 10-03; painting ends 09-10 + 2 = 09-12. The later wins.
  assert.equal(earliestStart(works[2]!, works, cfg), '2026-10-03');
});

test('one unjudgeable predecessor yields no earliest start at all', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('screed', { start: '2026-09-01', end: '2026-09-05', trade: 'screed' }),
        item('mystery', { start: '2026-09-01', end: '2026-09-10', trade: 'not-configured' }),
        item('floor', { start: '2026-10-03', trade: 'flooring', dependsOn: ['screed', 'mystery'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  // A maximum over the judgeable subset would be too EARLY and would be shown as a
  // fact. „Nothing" is the only answer that cannot be mistaken for one.
  assert.equal(earliestStart(works[2]!, works, cfg), undefined);
});

test('an item with no predecessors has no earliest start', () => {
  const cfg = config();
  const works = readSchedule(file([item('a', { start: '2026-09-01', trade: 'screed' })], TRADES), cfg);
  assert.equal(earliestStart(works[0]!, works, cfg), undefined);
});

test('a dependsOn naming an item the timeline does not carry is skipped', () => {
  const cfg = config();
  const works = readSchedule(
    file([item('a', { start: '2026-09-01', trade: 'screed', dependsOn: ['ghost'] })], TRADES),
    cfg,
  );
  assert.deepEqual(edgesOf(works, cfg), []);
  assert.equal(earliestStart(works[0]!, works, cfg), undefined);
});

test('a successor starting too early is reported with the days it is short by', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('screed', { start: '2026-09-01', end: '2026-09-05', trade: 'screed' }),
        item('floor', { start: '2026-09-20', trade: 'flooring', dependsOn: ['screed'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  const found = findingsOf(works, cfg).filter((f) => f.kind === 'lag-violation');
  assert.equal(found.length, 1);
  const violation = found[0]!;
  assert.equal(violation.kind === 'lag-violation' && violation.earliest, '2026-10-03');
  assert.equal(violation.kind === 'lag-violation' && violation.shortBy, 13);
});

// ---------------------------------------------------------------------------
// rule: exclusive occupancy

test('two trades touching end to start in one section do not overlap', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', end: '2026-09-05', trade: 'screed', section: 'WE-3' }),
        item('b', { start: '2026-09-05', end: '2026-09-09', trade: 'painting', section: 'WE-3' }),
      ],
      TRADES,
    ),
    cfg,
  );
  assert.equal(overlapDays(works[0]!, works[1]!), 0);
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'section-overlap').length, 0);
});

test('two trades overlapping in one section are reported with the overlap', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', end: '2026-09-08', trade: 'screed', section: 'WE-3' }),
        item('b', { start: '2026-09-05', end: '2026-09-09', trade: 'painting', section: 'WE-3' }),
      ],
      TRADES,
    ),
    cfg,
  );
  const found = findingsOf(works, cfg).filter((f) => f.kind === 'section-overlap');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind === 'section-overlap' && found[0]!.days, 3);
});

test('one trade overlapping itself in a section is its own business', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', end: '2026-09-08', trade: 'screed', section: 'WE-3' }),
        item('b', { start: '2026-09-05', end: '2026-09-09', trade: 'screed', section: 'WE-3' }),
      ],
      TRADES,
    ),
    cfg,
  );
  // Two crews of one trade, two shifts. The rule the domain states is about a section
  // being handed from one trade to the next.
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'section-overlap').length, 0);
});

test('work in a shared section with no trade is reported as unjudgeable', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', end: '2026-09-08', section: 'WE-3' }),
        item('b', { start: '2026-09-05', end: '2026-09-09', trade: 'painting', section: 'WE-3' }),
      ],
      TRADES,
    ),
    cfg,
  );
  const found = findingsOf(works, cfg).filter((f) => f.kind === 'no-trade');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind === 'no-trade' && found[0]!.work.itemId, 'a');
});

test('a milestone occupies no time, so it shares a section with anything', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', end: '2026-09-08', trade: 'screed', section: 'WE-3' }),
        item('check', { start: '2026-09-04', trade: 'painting', section: 'WE-3' }),
      ],
      TRADES,
    ),
    cfg,
  );
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'section-overlap').length, 0);
});

// ---------------------------------------------------------------------------
// rule: fixed dates and their binding

test('a plan running past its fixed date is reported with the binding stated', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('handover', {
          start: '2026-09-01',
          end: '2026-12-15',
          trade: 'painting',
          fixedDate: '2026-12-01',
          dateBinding: 'contract',
        }),
      ],
      TRADES,
    ),
    cfg,
  );
  const found = findingsOf(works, cfg).filter((f) => f.kind === 'fixed-date-passed');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind === 'fixed-date-passed' && found[0]!.days, 14);
  assert.equal(found[0]!.kind === 'fixed-date-passed' && found[0]!.binding, 'contract');
});

test('a plan ending exactly on its fixed date holds', () => {
  const cfg = config();
  const works = readSchedule(
    file([item('handover', { start: '2026-09-01', end: '2026-12-01', fixedDate: '2026-12-01' })], TRADES),
    cfg,
  );
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'fixed-date-passed').length, 0);
});

test('a breached fixed date with no binding keeps the binding absent', () => {
  const cfg = config();
  const works = readSchedule(
    file([item('handover', { start: '2026-09-01', end: '2026-12-15', fixedDate: '2026-12-01' })], TRADES),
    cfg,
  );
  const found = findingsOf(works, cfg).filter((f) => f.kind === 'fixed-date-passed');
  // Not defaulted to `control`, even though that is the VOB/B's own default for an
  // intermediate date: the plugin cannot know whether this item is the overall
  // completion, which IS binding by default, so a silent default would label the one
  // date that matters as the one that does not.
  assert.equal(found[0]!.kind === 'fixed-date-passed' && found[0]!.binding, undefined);
});

// ---------------------------------------------------------------------------
// what cannot be judged

test('an unknown trade and a missing lag are reported separately', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', end: '2026-09-05', trade: 'not-configured' }),
        item('b', { start: '2026-09-10', trade: 'flooring', dependsOn: ['a'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  const kinds = findingsOf(works, cfg).map((f) => f.kind);
  assert.ok(kinds.includes('unknown-trade'));
  assert.ok(kinds.includes('no-lag'));
});

test('work nothing depends on needs no lag', () => {
  const cfg = config();
  const works = readSchedule(file([item('a', { start: '2026-09-01', trade: 'not-configured' })], TRADES), cfg);
  // An item at the end of a chain owes nobody a wait, so having no lag is not a gap.
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'no-lag').length, 0);
});

test('an item with plugin fields and no start is reported, a bare one is not', () => {
  const cfg = config();
  const works = readSchedule(file([item('a', { trade: 'screed' }), item('b')], TRADES), cfg);
  const found = findingsOf(works, cfg).filter((f) => f.kind === 'no-dates');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind === 'no-dates' && found[0]!.work.itemId, 'a');
});

test('a timeline with no trades configured reports every trade as unknown', () => {
  const cfg = config([]);
  const works = readSchedule(file([item('a', { start: '2026-09-01', trade: 'screed' })], []), cfg);
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'unknown-trade').length, 1);
});

// ---------------------------------------------------------------------------
// cycles

test('a cycle in the dependencies is found, not followed', () => {
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', dependsOn: ['c'] }),
        item('b', { start: '2026-09-02', dependsOn: ['a'] }),
        item('c', { start: '2026-09-03', dependsOn: ['b'] }),
      ],
      TRADES,
    ),
    config(),
  );
  const cycles = cyclesOf(works);
  assert.equal(cycles.length, 1);
  assert.deepEqual([...cycles[0]!].sort(), ['a', 'b', 'c']);
});

test('an item depending on itself is a cycle', () => {
  const works = readSchedule(file([item('a', { start: '2026-09-01', dependsOn: ['a'] })], TRADES), config());
  assert.deepEqual(cyclesOf(works), [['a']]);
});

test('a diamond is not a cycle', () => {
  const works = readSchedule(
    file(
      [
        item('root', { start: '2026-09-01' }),
        item('left', { start: '2026-09-02', dependsOn: ['root'] }),
        item('right', { start: '2026-09-02', dependsOn: ['root'] }),
        item('join', { start: '2026-09-03', dependsOn: ['left', 'right'] }),
      ],
      TRADES,
    ),
    config(),
  );
  assert.deepEqual(cyclesOf(works), []);
});

// ---------------------------------------------------------------------------
// rule: the chain shift

const CHAIN: TimelineFileItem[] = [
  item('screed', { start: '2026-09-01', end: '2026-09-05', trade: 'screed', section: 'WE-3' }),
  item('floor', { start: '2026-10-03', end: '2026-10-10', trade: 'flooring', section: 'WE-3', dependsOn: ['screed'] }),
  item('paint', { start: '2026-10-10', end: '2026-10-14', trade: 'painting', section: 'WE-3', dependsOn: ['floor'] }),
];

test('a shift moves the whole chain, not the next link', () => {
  const cfg = config();
  const works = readSchedule(file(CHAIN, TRADES), cfg);
  const result = shiftChain(works, cfg, ['screed'], 7);
  assert.ok(result.ok);
  assert.deepEqual(
    result.moves.map((m) => [m.work.itemId, m.to, m.endTo]),
    [
      ['screed', '2026-09-08', '2026-09-12'],
      ['floor', '2026-10-10', '2026-10-17'],
      ['paint', '2026-10-17', '2026-10-21'],
    ],
  );
  // A uniform shift preserves every relative distance, so nothing is broken by it.
  assert.deepEqual(result.lagBroken, []);
});

test('a shift from the middle leaves the predecessor alone', () => {
  const cfg = config();
  const works = readSchedule(file(CHAIN, TRADES), cfg);
  const result = shiftChain(works, cfg, ['floor'], 7);
  assert.ok(result.ok);
  assert.deepEqual(
    result.moves.map((m) => m.work.itemId),
    ['floor', 'paint'],
  );
  // Pushing the successor later never violates its own lag, and the screed did not move.
  assert.deepEqual(result.lagBroken, []);
});

test('an item with a duration keeps it: only the start moves', () => {
  const cfg = config();
  const works = readSchedule(
    file([item('a', { start: '2026-09-01', duration: '7d', trade: 'screed' })], TRADES),
    cfg,
  );
  const result = shiftChain(works, cfg, ['a'], 3);
  assert.ok(result.ok);
  assert.equal(result.moves[0]!.to, '2026-09-04');
  // No `endTo`, so the patch carries no `end` and the extent travels rather than being
  // recomputed into a field the item never had.
  assert.equal(result.moves[0]!.endTo, undefined);
});

test('a negative shift that breaks a lag reports it', () => {
  const cfg = config();
  const works = readSchedule(file(CHAIN, TRADES), cfg);
  const result = shiftChain(works, cfg, ['floor'], -7);
  assert.ok(result.ok);
  const broken = result.lagBroken;
  assert.equal(broken.length, 1);
  // The flooring now starts 09-26, seven days before the screed's 09-05 + 28 = 10-03.
  assert.equal(broken[0]!.earliest, '2026-10-03');
  assert.equal(broken[0]!.shortBy, 7);
  assert.equal(broken[0]!.shortByBefore, 0);
});

test('a violation the shift did not cause is not reported by the shift', () => {
  const cfg = config();
  // The parquet in a second flat is laid before its screed allows it, and the shift never
  // touches that flat. The first run against the committed example put exactly this
  // finding in the middle of the report of what the caller had done.
  const works = readSchedule(
    file(
      [
        ...CHAIN,
        item('screed-b', { start: '2026-09-17', end: '2026-09-19', trade: 'screed', section: 'WE-4' }),
        item('floor-b', {
          start: '2026-10-05',
          end: '2026-10-10',
          trade: 'flooring',
          section: 'WE-4',
          dependsOn: ['screed-b'],
        }),
      ],
      TRADES,
    ),
    cfg,
  );
  const result = shiftChain(works, cfg, ['screed'], 7);
  assert.ok(result.ok);
  assert.deepEqual(result.lagBroken, []);
  // And it is still there to be found by the verb that owns the standing state.
  assert.equal(findingsOf(works, cfg).filter((f) => f.kind === 'lag-violation').length, 1);
});

test('a violation the shift made worse is reported with both numbers', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('screed', { start: '2026-09-01', end: '2026-09-05', trade: 'screed' }),
        // Two days early already: the screed allows 10-03 and this starts 10-01.
        item('floor', { start: '2026-10-01', end: '2026-10-06', trade: 'flooring', dependsOn: ['screed'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  // Seeded on the SUCCESSOR, which is the only way an existing violation can worsen: a
  // uniform shift of a closed set preserves every distance inside it, so seeding on the
  // screed would move both and leave the shortfall exactly where it was.
  const result = shiftChain(works, cfg, ['floor'], -7);
  assert.ok(result.ok);
  assert.equal(result.lagBroken.length, 1);
  assert.equal(result.lagBroken[0]!.shortByBefore, 2);
  assert.equal(result.lagBroken[0]!.shortBy, 9);
});

test('shifting a whole chain never worsens a lag inside it', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('screed', { start: '2026-09-01', end: '2026-09-05', trade: 'screed' }),
        item('floor', { start: '2026-10-01', end: '2026-10-06', trade: 'flooring', dependsOn: ['screed'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  const result = shiftChain(works, cfg, ['screed'], 7);
  assert.ok(result.ok);
  // Both moved, so the two-day shortfall is still two days and this shift did not cause
  // it. It stays `check_trade_conflicts`'s finding.
  assert.deepEqual(result.lagBroken, []);
});

// The chain above plus a contractual handover that the plan currently meets exactly:
// painting ends 10-14, imposes two days, so the handover may start 10-16 and its own day
// lands on its fixed date.
const WITH_HANDOVER: TimelineFileItem[] = [
  ...CHAIN,
  item('handover', {
    start: '2026-10-16',
    end: '2026-10-16',
    fixedDate: '2026-10-16',
    dateBinding: 'contract',
    dependsOn: ['paint'],
  }),
];

test('the plan with a handover holds before anything is shifted', () => {
  const cfg = config();
  const works = readSchedule(file(WITH_HANDOVER, TRADES), cfg);
  assert.deepEqual(findingsOf(works, cfg), []);
});

test('a fixed date is held, and the chain running into it is reported as a break', () => {
  const cfg = config();
  const works = readSchedule(file(WITH_HANDOVER, TRADES), cfg);
  const result = shiftChain(works, cfg, ['screed'], 7);
  assert.ok(result.ok);
  assert.deepEqual(
    result.moves.map((m) => m.work.itemId),
    ['screed', 'floor', 'paint'],
  );
  assert.deepEqual(
    result.held.map((h) => [h.work.itemId, h.why]),
    [['handover', 'fixed-date']],
  );
  // The finding is what the predecessors now DEMAND, not where the handover sits: it
  // did not move, so its own dates say nothing about the shift. Painting now ends 10-21,
  // plus its two days, so the earliest the handover can be done is 10-23.
  assert.equal(result.breaks.length, 1);
  const broken = result.breaks[0]!;
  assert.equal(broken.work.itemId, 'handover');
  assert.equal(broken.neededEnd, '2026-10-23');
  assert.equal(broken.overBy, 7);
  assert.equal(broken.overByBefore, 0);
  assert.equal(broken.binding, 'contract');
  // Not reported twice: the same fact as a bare lag violation would be the weaker
  // sentence, so an edge into a fixed-date item is left to `breaks`.
  assert.deepEqual(result.lagBroken, []);
});

test('a break that was already there is distinguished from one the shift caused', () => {
  const cfg = config();
  // The handover is a day earlier than the plan can deliver it, so it starts two days
  // over. Shifting by seven makes that nine, and both numbers are reported.
  const chain = [
    ...CHAIN,
    item('handover', {
      start: '2026-10-14',
      end: '2026-10-14',
      fixedDate: '2026-10-14',
      dateBinding: 'contract',
      dependsOn: ['paint'],
    }),
  ];
  const works = readSchedule(file(chain, TRADES), cfg);
  const result = shiftChain(works, cfg, ['screed'], 7);
  assert.ok(result.ok);
  assert.equal(result.breaks[0]!.overBy, 9);
  assert.equal(result.breaks[0]!.overByBefore, 2);
});

test('a handover keeps its own length when the date it needs is computed', () => {
  const cfg = config();
  const chain = [
    ...CHAIN,
    // A handover week rather than a handover day: what the fixed date has to hold is the
    // earliest start plus that week.
    item('handover', {
      start: '2026-10-16',
      end: '2026-10-23',
      fixedDate: '2026-10-23',
      dependsOn: ['paint'],
    }),
  ];
  const works = readSchedule(file(chain, TRADES), cfg);
  const result = shiftChain(works, cfg, ['screed'], 7);
  assert.ok(result.ok);
  // 10-23 earliest start plus the seven days the handover itself takes.
  assert.equal(result.breaks[0]!.neededEnd, '2026-10-30');
  assert.equal(result.breaks[0]!.overBy, 7);
});

test('a shift over a cycle refuses the whole plan', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', dependsOn: ['b'] }),
        item('b', { start: '2026-09-02', dependsOn: ['a'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  const result = shiftChain(works, cfg, ['a'], 7);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'cycle');
});

test('a cycle elsewhere on the timeline does not refuse an unrelated shift', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', trade: 'screed' }),
        item('x', { start: '2026-09-01', dependsOn: ['y'] }),
        item('y', { start: '2026-09-02', dependsOn: ['x'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  const result = shiftChain(works, cfg, ['a'], 7);
  assert.ok(result.ok);
  assert.equal(result.moves.length, 1);
});

test('an item with no start is held rather than moved', () => {
  const cfg = config();
  const works = readSchedule(
    file(
      [
        item('a', { start: '2026-09-01', end: '2026-09-05', trade: 'screed' }),
        item('later', { trade: 'flooring', dependsOn: ['a'] }),
      ],
      TRADES,
    ),
    cfg,
  );
  const result = shiftChain(works, cfg, ['a'], 7);
  assert.ok(result.ok);
  assert.deepEqual(
    result.held.map((h) => [h.work.itemId, h.why]),
    [['later', 'no-start']],
  );
});

test('an item whose dates carry a time of day is held rather than flattened', () => {
  const cfg = config();
  const works = readSchedule(file([item('a', { start: '2026-09-01', end: '2026-09-08T17:00:00' })], TRADES), cfg);
  const result = shiftChain(works, cfg, ['a'], 7);
  assert.ok(result.ok);
  // A day shift would store `2026-09-15` and drop the 17:00 somebody entered.
  assert.deepEqual(result.moves, []);
  assert.deepEqual(
    result.held.map((h) => [h.work.itemId, h.why]),
    [['a', 'timed-dates']],
  );
});

test('an item whose end will not parse at all is held with that as the reason', () => {
  const cfg = config();
  const works = readSchedule(file([item('a', { start: '2026-09-01', end: '31.12.2026' })], TRADES), cfg);
  const result = shiftChain(works, cfg, ['a'], 7);
  assert.ok(result.ok);
  assert.deepEqual(result.moves, []);
  assert.deepEqual(
    result.held.map((h) => [h.work.itemId, h.why]),
    [['a', 'bad-dates']],
  );
});

test('a shift naming nothing that exists is refused', () => {
  const cfg = config();
  const works = readSchedule(file(CHAIN, TRADES), cfg);
  const result = shiftChain(works, cfg, ['ghost'], 7);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'no-seed');
});

test('a trade seeds every item carrying it', () => {
  const cfg = config();
  const works = readSchedule(
    file([...CHAIN, item('screed-2', { start: '2026-09-06', end: '2026-09-09', trade: 'screed' })], TRADES),
    cfg,
  );
  assert.deepEqual(seedsFor(works, { trade: 'screed' }), ['screed', 'screed-2']);
  assert.deepEqual(seedsFor(works, { item: 'floor' }), ['floor']);
  assert.deepEqual(seedsFor(works, {}), []);
});
