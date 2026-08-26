// The two verbs an agent can call, and nothing else.
//
// The domain rules live in `schedule.ts` and are tested there. This module is the
// adapter: it reads the arguments, calls one rule, and turns the result into a plan of
// item changes plus the notes an agent has to relay. Keeping the split means the
// arithmetic is testable without constructing a `ToolContext`, and the same rules back
// the derived field.
//
// **The text here is English and stays English.** A tool's notes are part of the agent
// surface (docs/mcp.md), not the interface, so they do not go through `messages.ts`.
//
// Three constraints, all following from „a tool is a pure function":
//
//   - It returns changes; it does not perform them. The host applies the plan through
//     its own write path, which keeps capabilities, optimistic locking and the audit
//     trail in force.
//   - It reads `now` from its context and never the clock.
//   - No I/O, no DOM. This module is imported statically by the registry and by the
//     process that serves agent calls, which has no DOM.

import type { ToolHandler, ToolPlan } from '../../pluginHost/api';
import {
  type ConstructionConfig,
  type DateBinding,
  type Edge,
  type Finding,
  type Work,
  findingsOf,
  readConfig,
  readSchedule,
  seedsFor,
  shiftChain,
} from './schedule';

/** How an item is named in a note: its content, falling back to its id. */
function nameOf(work: Work): string {
  return `"${work.content || work.itemId}"`;
}

/**
 * „1 day" rather than „1 days". Small, and it is in every second note here.
 *
 * Not called `days`: `shiftTradeChain` reads its own `days` argument into a local of that
 * name, which shadowed this and turned every note in that verb into a TypeError.
 */
function dayCount(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

/**
 * What a trade is called in a note.
 *
 * The config's label where there is one, because that is the word the project uses. The
 * bare id otherwise, which is exactly the case `unknown-trade` reports — and printing the
 * id beside a known label as well read as „Parkett (Parkett (flooring))" on the first run
 * against the committed example, since the note wraps it in brackets of its own.
 */
function tradeName(config: ConstructionConfig, id: string | undefined): string {
  if (!id) return 'no trade';
  return config.trades.find((t) => t.id === id)?.label ?? id;
}

/**
 * How a missed fixed date is described.
 *
 * The binding is stated, and its absence is stated too. Under the VOB/B an
 * unqualified intermediate date is a control deadline, so defaulting to that would even
 * be the sourced answer — and it is refused anyway: the plugin cannot know whether a
 * given item is the overall completion, which IS binding by default, so a silent default
 * would label the one date that matters as the one that does not. Saying „not stated"
 * puts the question back where it can be answered.
 */
function bindingPhrase(binding: DateBinding | undefined): string {
  if (binding === 'contract') return 'a contract deadline (Vertragsfrist), so exceeding it is a default in itself';
  if (binding === 'control') return 'a control deadline (Kontrollfrist), which has no consequence of its own';
  return 'of unstated binding, so whether it carries a consequence cannot be read off the timeline';
}

/** One lag violation as a sentence. */
function lagNote(edge: Edge, earliest: string, shortBy: number, config: ConstructionConfig): string {
  const { predecessor, successor, lag } = edge;
  return (
    `${nameOf(successor)} starts ${successor.start}, ${dayCount(shortBy)} before it may: ${nameOf(predecessor)} ` +
    `(${tradeName(config, predecessor.trade)}) ends ${predecessor.end} and imposes a ${lag}-day wait, ` +
    `so the earliest start is ${earliest}.`
  );
}

/** One finding as a sentence an agent can relay without the reader seeing the timeline. */
function findingNote(finding: Finding, config: ConstructionConfig): string {
  switch (finding.kind) {
    case 'section-overlap':
      return (
        `section "${finding.section}": ${nameOf(finding.a)} (${tradeName(config, finding.a.trade)}) and ` +
        `${nameOf(finding.b)} (${tradeName(config, finding.b.trade)}) overlap by ${dayCount(finding.days)}.`
      );
    case 'lag-violation':
      return lagNote(finding.edge, finding.earliest, finding.shortBy, config);
    case 'fixed-date-passed':
      return (
        `${nameOf(finding.work)} runs to ${finding.work.end}, ${dayCount(finding.days)} past its fixed date ` +
        `${finding.fixedDate}. That date is ${bindingPhrase(finding.binding)}.`
      );
    case 'unknown-trade':
      return (
        `${nameOf(finding.work)} carries the trade "${finding.trade}", which this timeline's config does not ` +
        'define, so no wait can be read from it.'
      );
    case 'no-lag':
      return (
        `${nameOf(finding.work)} has work depending on it and no lag anywhere — neither on the item nor on its ` +
        `trade (${tradeName(config, finding.work.trade)}) — so nothing downstream of it can be dated.`
      );
    case 'no-trade':
      return (
        `${nameOf(finding.work)} sits in section "${finding.section}" with other work and names no trade, so ` +
        'whether it may share the place cannot be judged.'
      );
    case 'no-dates':
      return `${nameOf(finding.work)} carries schedule fields and no usable start, so it takes no place in the order.`;
    case 'bad-value':
      return (
        `${nameOf(finding.work)}: "${finding.field}" is "${finding.value}", which is not a value this plugin ` +
        'will use. A day is written YYYY-MM-DD and a lag is a whole number of days.'
      );
    case 'cycle':
      return (
        `the dependencies ${finding.ids.map((id) => `"${id}"`).join(' → ')} form a cycle, so there is no order ` +
        'to compute along.'
      );
  }
}

/**
 * The order findings are reported in: by section, then by what it is.
 *
 * Grouped so one place's findings arrive together rather than interleaved with four
 * others', because the reader acts per section. Cycles come first whatever they touch:
 * everything else computed on a cyclic graph is worth less than the news that the graph
 * is cyclic.
 */
const KIND_ORDER: Finding['kind'][] = [
  'cycle',
  'section-overlap',
  'lag-violation',
  'fixed-date-passed',
  'unknown-trade',
  'no-lag',
  'no-trade',
  'no-dates',
  'bad-value',
];

function sectionOf(finding: Finding): string {
  if (finding.kind === 'section-overlap' || finding.kind === 'no-trade') return finding.section;
  if (finding.kind === 'lag-violation') return finding.edge.successor.section ?? '';
  if (finding.kind === 'cycle') return '';
  return finding.work.section ?? '';
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const byKind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (a.kind === 'cycle' || b.kind === 'cycle') return byKind;
    const sa = sectionOf(a);
    const sb = sectionOf(b);
    if (sa !== sb) return !sa ? 1 : !sb ? -1 : sa < sb ? -1 : 1;
    return byKind;
  });
}

/** Does this finding concern the section or the trade the caller asked about? */
function matchesFilter(finding: Finding, section: string, trade: string): boolean {
  if (!section && !trade) return true;
  // A cycle is reported whatever the filter says. It is a property of the graph rather
  // than of one section, and a filtered-out cycle would silently invalidate every other
  // finding in the answer.
  if (finding.kind === 'cycle') return true;
  const works: Work[] =
    finding.kind === 'section-overlap'
      ? [finding.a, finding.b]
      : finding.kind === 'lag-violation'
        ? [finding.edge.predecessor, finding.edge.successor]
        : [finding.work];
  if (section && !works.some((w) => w.section === section)) return false;
  if (trade && !works.some((w) => w.trade === trade)) return false;
  return true;
}

/**
 * Report every place the schedule contradicts itself, and every place it cannot be
 * judged. Declares no `writes`, so the notes are the entire answer.
 *
 * It reports what it cannot judge as loudly as what is wrong. A verb listing only
 * failures would answer „no conflicts" for a timeline where nobody has filled in a
 * single trade, and that silence reads as safety.
 */
export const checkTradeConflicts: ToolHandler = ({ file, config, args, now }): ToolPlan => {
  const cfg = readConfig(config);
  const works = readSchedule(file, cfg);
  const section = typeof args.section === 'string' ? args.section.trim() : '';
  const trade = typeof args.trade === 'string' ? args.trade.trim() : '';

  if (!works.length) {
    return { notes: ['this timeline carries no items, so there is no schedule to check.'] };
  }

  const scoped = works.filter((w) => (!section || w.section === section) && (!trade || w.trade === trade));
  if ((section || trade) && !scoped.length) {
    return {
      notes: [
        section && trade
          ? `no item on this timeline is in section "${section}" carrying trade "${trade}".`
          : section
            ? `no item on this timeline is in section "${section}".`
            : `no item on this timeline carries the trade "${trade}".`,
      ],
    };
  }

  // Computed over the WHOLE schedule and filtered afterwards. Computing over the subset
  // would drop every predecessor outside the filter and report a chain that holds
  // because half of it was not looked at.
  const all = findingsOf(works, cfg);
  const findings = sortFindings(all.filter((f) => matchesFilter(f, section, trade)));

  if (!findings.length) {
    const notes = [`${scoped.length} items checked against ${now}, nothing in conflict.`];
    // Named rather than left implicit: with no trades configured, no lag exists
    // anywhere, and „nothing in conflict" would otherwise read as covering the order of
    // the work — which was not checked at all.
    if (!cfg.trades.length) {
      notes.push('this timeline configures no trades, so no wait between trades could be checked.');
    }
    return { notes };
  }

  const notes = findings.map((finding) => findingNote(finding, cfg));
  notes.unshift(`${findings.length} findings across ${scoped.length} items, checked against ${now}.`);
  if (!cfg.trades.length) {
    notes.push('this timeline configures no trades, so every wait had to be read off the items themselves.');
  }
  return { notes };
};

/**
 * Move a trade and everything downstream of it.
 *
 * Throws rather than returning an empty plan for each refusal, because an empty plan
 * reads as „nothing to do" and every case here is a different fact the caller has to act
 * on: both selectors given, neither given, an id the timeline does not carry, or a cycle.
 */
export const shiftTradeChain: ToolHandler = ({ file, config, args }): ToolPlan => {
  const cfg = readConfig(config);
  const works = readSchedule(file, cfg);
  const item = typeof args.item === 'string' ? args.item.trim() : '';
  const trade = typeof args.trade === 'string' ? args.trade.trim() : '';
  const days = typeof args.days === 'number' ? args.days : Number.NaN;

  if (!Number.isSafeInteger(days)) throw new Error('"days" must be a whole number of days.');
  if (item && trade) {
    throw new Error('give either "item" or "trade", not both: one names a starting point, the other a set of them.');
  }
  if (!item && !trade) throw new Error('give "item" or "trade" to say what should move.');

  const seeds = seedsFor(works, { item: item || undefined, trade: trade || undefined });
  if (!seeds.length) {
    throw new Error(
      item
        ? `no item "${item}" on this timeline.`
        : `no item on this timeline carries the trade "${trade}", so there is nothing to move.`,
    );
  }

  if (days === 0) {
    return { notes: ['a shift of zero days changes nothing. Nothing was written.'] };
  }

  const result = shiftChain(works, cfg, seeds, days);
  if (result.ok === false) {
    if (result.reason === 'cycle') {
      throw new Error(
        `the dependencies ${result.ids.map((id) => `"${id}"`).join(' → ')} form a cycle, so there is no order to ` +
          'shift along. Nothing was changed.',
      );
    }
    throw new Error('nothing on this timeline matches what should move.');
  }

  const direction = days > 0 ? 'later' : 'earlier';
  const magnitude = Math.abs(days);
  const notes: string[] = [];

  if (!result.moves.length) {
    notes.push(
      `nothing moved: every item in the chain is held where it is. ${result.held.length} were held, see below.`,
    );
  } else {
    notes.push(
      `${result.moves.length} ${result.moves.length === 1 ? 'item' : 'items'} moved ${dayCount(magnitude)} ` +
        `${direction}, along the whole chain from ${seeds.length === 1 ? 'one' : `${seeds.length}`} starting ` +
        `${seeds.length === 1 ? 'point' : 'points'}.`,
    );
  }

  for (const held of result.held) {
    notes.push(
      held.why === 'fixed-date'
        ? `${nameOf(held.work)} was NOT moved: it carries the fixed date ${held.work.fixedDate}, and a fixed date ` +
          'is never moved by this verb.'
        : held.why === 'no-start'
          ? `${nameOf(held.work)} was not moved: it has no start to move.`
          : held.why === 'timed-dates'
            ? `${nameOf(held.work)} was not moved: its dates carry a time of day, and this verb writes calendar ` +
              'days, which would drop it.'
            : `${nameOf(held.work)} was not moved: its start or end is not a value this plugin will rewrite.`,
    );
  }

  for (const broken of result.breaks) {
    notes.push(
      `${nameOf(broken.work)} can no longer meet its fixed date ${broken.fixedDate}: what it depends on now lets ` +
        `it finish on ${broken.neededEnd} at the earliest, ${dayCount(broken.overBy)} over` +
        `${broken.overByBefore ? ` (it was already ${dayCount(broken.overByBefore)} over before this shift)` : ''}. ` +
        `That date is ${bindingPhrase(broken.binding)}. Nothing was compressed to save it: where the time comes ` +
        'out of the programme is not a decision this plugin makes.',
    );
  }

  for (const { edge, earliest, shortBy, shortByBefore } of result.lagBroken) {
    notes.push(
      `after the shift, ${lagNote(edge, earliest, shortBy, cfg)}` +
        (shortByBefore ? ` It was ${dayCount(shortByBefore)} short before this shift.` : ''),
    );
  }

  return {
    changes: result.moves.map(({ work, to, endTo }) => ({
      op: 'update' as const,
      itemId: work.itemId,
      // Only the dates. The trade, the section and the lag are untouched on purpose:
      // moving work in time says nothing about who does it or where.
      patch: endTo ? { start: to, end: endTo } : { start: to },
    })),
    notes,
  };
};

/**
 * Keyed by the tool names the manifest declares. The two must agree — the host reports a
 * declaration with no handler and a handler with no declaration, and neither is callable.
 *
 * Neither handler above patches `trade`, `section`, `lagDays`, `fixedDate` or
 * `dateBinding`, and that is the manifest's three absences in code: which dates a
 * contract makes binding is a fact about that contract, the trade list is the project's
 * decision, and a verb able to set either could demote the one date somebody is liable
 * for. `tools.test.ts` asserts it, so the omission cannot be lost in a later edit.
 */
export const constructionTools: Record<string, ToolHandler> = {
  check_trade_conflicts: checkTradeConflicts,
  shift_trade_chain: shiftTradeChain,
};
