// The domain: what a construction schedule holds beyond dates, and the four rules
// that compute on it.
//
// Everything here is a pure function over the timeline, the plugin's config and a
// day. No DOM, no clock, no I/O — which is what makes a wrong lag catchable in a
// unit test rather than on a building site, and lets the same arithmetic back both
// the derived field and the two agent verbs.
//
// **The vocabulary is `lag`, not „lead time".** In CPM a *lead* is a negative lag:
// it lets a successor start before its predecessor finishes. What this plugin adds
// is the wait a successor owes its predecessor — curing, drying, an approval — and
// that is a *lag* in English, „Zeitabstand" in the German MS Project and
// „Wartezeit" in practice. Issue #135 asked for this under the name „lead time",
// and shipping a field so labelled that then *adds* days would have been wrong in
// the vocabulary of every person the plugin is for. See the README's terminology
// table.

import { durationToMs, endFromDuration, hasPlugin, isoDateOnly, shiftDays } from '../../pluginHost/api';
import type { TimelineFile, TimelineFileItem } from '../../types';
import { TRADE_ID_PATTERN } from './manifest';

export const CONSTRUCTION_PLUGIN = 'dev.zeitlines.construction';

// The five keys a person fills in. They are the manifest's `metadataKeys`, so an
// uninstall cleans them off every item — which is why they are declared once, here,
// and imported everywhere else. Two copies of `const TRADE_KEY = 'trade'` is how a
// rename fixes one reader and not the other.
export const TRADE_KEY = 'trade';
export const SECTION_KEY = 'section';
export const LAG_DAYS_KEY = 'lagDays';
export const FIXED_DATE_KEY = 'fixedDate';
export const DATE_BINDING_KEY = 'dateBinding';

/**
 * The computed field, stored nowhere.
 *
 * Deliberately **not** in `metadataKeys`: no item ever carries a value under it, so
 * listing it would promise a cleanup with nothing to clean and would suggest the
 * computed day is stored — the exact misunderstanding the derived seam prevents.
 */
export const EARLIEST_START_KEY = 'earliestStart';

/**
 * How binding a date is, as the VOB/B draws the line.
 *
 * Two ids, stored on items and never translated. Only the labels move between
 * languages („Vertragsfrist", „Kontrollfrist"), which is the rule for every select
 * option's value in this codebase.
 *
 * The distinction is the reason the field exists at all: exceeding a binding
 * *Vertragsfrist* puts the contractor in default by itself, while exceeding a mere
 * *Kontrollfrist* has no immediate consequence. Under the VOB/B only the agreed
 * start and the overall completion are Vertragsfristen by default, and every
 * intermediate date in a Bauzeitenplan is a Kontrollfrist unless the parties said
 * otherwise. The plugin carries which of the two a date is; it gives no advice, and
 * it has no way to know which contractual regime applies at all (README, open
 * question 6).
 */
export const DATE_BINDINGS = ['contract', 'control'] as const;
export type DateBinding = (typeof DATE_BINDINGS)[number];

// Declared in the manifest, because that is the file a host reads without running any
// plugin code — see the comment on it there.
const TRADE_ID_RE = new RegExp(TRADE_ID_PATTERN);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A trimmed non-empty string, or `undefined`. */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s ? s : undefined;
}

/** Is this exactly a calendar day, `YYYY-MM-DD`? */
export function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * A calendar day, or `undefined` — strictly, and that strictness is the point.
 *
 * Every date here is typed into a `text` field, because `CustomFieldType` has no date
 * type and offers no picker. A lenient parser would read „01.05.2026" as an American
 * date and place a computed start four months from where the author meant it, with
 * nothing on screen saying so. Refusing is the only outcome that is visible.
 *
 * A well-formed but impossible day (2026-02-30) parses to March 2nd, which is a date
 * the author never wrote; round-tripping through `isoDateOnly` is what catches it.
 */
export function day(value: unknown): string | undefined {
  const s = text(value);
  if (!s || !isDay(s)) return undefined;
  const parsed = new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return isoDateOnly(parsed) === s ? s : undefined;
}

/** A whole number of days, zero or more, or `undefined`. */
export function lagValue(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : text(value);
  if (raw === undefined) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = new Date(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = new Date(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// the config

/** One trade of the project's own Gewerkeliste, with the wait it imposes. */
export type TradeDef = {
  id: string;
  /**
   * The project's own word for this trade. A **value**, not interface text: it is
   * whatever the author typed into their config, so it is rendered as given and
   * never looked up in a catalogue.
   */
  label: string;
  /** Days a successor has to wait after this trade finishes. Zero is a real answer. */
  lagDays: number;
};

export type ConstructionConfig = { trades: TradeDef[] };

/**
 * The config bag, with everything unusable dropped rather than defaulted.
 *
 * **A missing `lagDays` drops the whole trade** instead of becoming zero. Zero means
 * „the next trade may start the day this one ends", which is a claim about somebody's
 * building; making it the fallback would have this plugin assert a domain rule nobody
 * wrote, on every trade whose line was incomplete. Dropped, the trade reads as unknown
 * and both verbs say they cannot judge it — which is the truthful answer.
 */
export function readConfig(raw: Record<string, unknown> | null | undefined): ConstructionConfig {
  if (!isPlainObject(raw) || !Array.isArray(raw.trades)) return { trades: [] };
  const trades: TradeDef[] = [];
  const seen = new Set<string>();
  for (const entry of raw.trades) {
    if (!isPlainObject(entry)) continue;
    const id = text(entry.id);
    const label = text(entry.label);
    const lag = lagValue(entry.lagDays);
    if (!id || !TRADE_ID_RE.test(id) || !label || lag === undefined || seen.has(id)) continue;
    seen.add(id);
    trades.push({ id, label, lagDays: lag });
  }
  return { trades };
}

/** The configured trade behind an id, or null. */
export function tradeById(config: ConstructionConfig, id: string | undefined): TradeDef | null {
  if (!id) return null;
  return config.trades.find((t) => t.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// one item, read as scheduled work

/** A value the author wrote that this plugin cannot use. */
export type BadValue = { field: string; value: string };

/** One item of the schedule, with everything this plugin reads off it resolved. */
export type Work = {
  itemId: string;
  content: string;
  /**
   * The day the work starts.
   *
   * A start carrying a time of day is **truncated** to its day here, because every rule
   * in this module compares days and that is what the domain plans in. `undefined`
   * means there is no day to compute with at all: no start, or one this plugin will not
   * parse — and the second is in `badValues` as well, so absence and refusal stay
   * distinguishable.
   */
  start?: string;
  /**
   * Where the work stops: `end` where the item carries one, otherwise
   * `start + duration`, otherwise the start itself.
   *
   * Resolved through the contract's own `durationToMs` / `endFromDuration` rather than
   * restated, because a plugin that computes a different end than the one drawn on
   * screen is wrong wherever the two are compared.
   */
  end?: string;
  /** Does the item carry an `end` of its own, as opposed to a duration or nothing? */
  hasOwnEnd: boolean;
  /**
   * Are the item's own start and end plain calendar days?
   *
   * Reading a timestamp as its day is fine and is what every rule here does. **Writing
   * one back is not**: `shiftDays` returns a day, so shifting `2026-09-08T17:00` would
   * store `2026-09-15` and drop the time somebody entered. So the shift asks this before
   * it rewrites anything, and a timed item is held with that as the reason instead of
   * being quietly flattened.
   */
  datesAreDays: boolean;
  trade?: string;
  section?: string;
  /** This item's own lag, overriding its trade's. */
  lagDays?: number;
  fixedDate?: string;
  binding?: DateBinding;
  /** Ids this item depends on: its predecessors. */
  dependsOn: string[];
  badValues: BadValue[];
};

/**
 * Which ids an item depends on, through `metadata.dependsOn`.
 *
 * Restated here rather than imported: `extractDependsOn` lives in `src/buildItems.ts`,
 * which a plugin may not import (plugin isolation), so the accepted shapes have to
 * agree with that function by hand — a list of ids, or a single id written as a bare
 * string. `dependsOn` is a core reserved metadata key and the relation graph draws an
 * edge for every entry, which is why a rule about the order of work has to read it.
 *
 * **Character for character the core's rule, including where it does not trim.** An
 * entry of a list keeps its whitespace there, so `[" P-1 "]` names no item and no edge
 * is drawn; only the single-string form is trimmed. `sprints/tools.ts` carries the same
 * copy with the same warning, and trimming both there once made that file claim a
 * dependent no arrow on the page corresponded to.
 *
 * This is the third copy of the rule in the repository. That it has to be copied at
 * all is a gap in the plugin contract rather than a fact about this plugin: the barrel
 * exports the calendar-day arithmetic for exactly this reason and stops short of the
 * dependency relation. Reported on the extension-point issues, not worked around in a
 * core file.
 */
export function dependsOnOf(item: TimelineFileItem): string[] {
  const raw = item.metadata?.dependsOn;
  if (Array.isArray(raw)) return raw.map(String).filter((entry) => entry.length > 0);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/** One binding value, or `undefined` for anything that is not one of the two ids. */
function bindingOf(value: unknown): DateBinding | undefined {
  const s = text(value);
  return s && (DATE_BINDINGS as readonly string[]).includes(s) ? (s as DateBinding) : undefined;
}

/**
 * Read one item as scheduled work.
 *
 * Unusable values are collected in `badValues` rather than dropped silently. A lag of
 * „ca. 4 Wochen" and a lag nobody entered look identical once both are `undefined`,
 * and only one of them is somebody's mistake.
 */
export function readWork(item: TimelineFileItem, config: ConstructionConfig = { trades: [] }): Work {
  const meta = isPlainObject(item.metadata) ? item.metadata : {};
  const badValues: BadValue[] = [];

  const rawStart = text(item.start);
  const start = day(isoDateOnly(item.start ?? ''));
  // A start the timeline has and this plugin will not use. It is `undefined` above,
  // which reads as „no date"; recorded here it reads as „this value, refused".
  if (rawStart && !start) badValues.push({ field: 'start', value: rawStart });

  const rawEnd = text(item.end);
  const ownEnd = day(isoDateOnly(item.end ?? ''));
  if (rawEnd && !ownEnd) badValues.push({ field: 'end', value: rawEnd });

  // Not a `badValue`: a timestamp is a perfectly good date that this plugin reads as its
  // day and refuses to *rewrite*. Reporting it as a bad value would tell the author to
  // fix something that is not broken.
  const datesAreDays = (!rawStart || isDay(rawStart)) && (!rawEnd || isDay(rawEnd));

  const lagRaw = meta[LAG_DAYS_KEY];
  const lagDays = lagValue(lagRaw);
  const lagText = typeof lagRaw === 'number' ? String(lagRaw) : text(lagRaw);
  if (lagText && lagDays === undefined) badValues.push({ field: LAG_DAYS_KEY, value: lagText });

  const fixedRaw = text(meta[FIXED_DATE_KEY]);
  const fixedDate = day(meta[FIXED_DATE_KEY]);
  if (fixedRaw && !fixedDate) badValues.push({ field: FIXED_DATE_KEY, value: fixedRaw });

  const bindingRaw = text(meta[DATE_BINDING_KEY]);
  const binding = bindingOf(meta[DATE_BINDING_KEY]);
  if (bindingRaw && !binding) badValues.push({ field: DATE_BINDING_KEY, value: bindingRaw });

  // The extent, resolved the way the viewer resolves it. `end` wins; a `duration`
  // is measured from the start; an item with neither stops where it starts, which is
  // what makes a milestone occupy no time and therefore overlap nothing.
  let end = ownEnd;
  if (!end && start) {
    const ms = durationToMs(item.duration);
    end = (ms != null ? day(endFromDuration(start, ms) ?? '') : undefined) ?? start;
  }

  return {
    itemId: item.id ?? '',
    content: item.content ?? '',
    start,
    end,
    hasOwnEnd: !!ownEnd,
    datesAreDays,
    trade: text(meta[TRADE_KEY]),
    section: text(meta[SECTION_KEY]),
    lagDays,
    fixedDate,
    binding,
    dependsOn: dependsOnOf(item),
    badValues,
  };
}

/**
 * Every item of the timeline as work, when the plugin is enabled here.
 *
 * **Every item, not only the ones carrying plugin fields.** A predecessor with no
 * trade is still a predecessor, and its dates are what a successor's earliest start is
 * measured from — filtering it out would compute the chain from a subset of it and
 * report a schedule that holds when it does not.
 */
export function readSchedule(
  file: TimelineFile | null | undefined,
  config: ConstructionConfig = { trades: [] },
): Work[] {
  if (!file || !hasPlugin(file, CONSTRUCTION_PLUGIN)) return [];
  return (file.items ?? []).filter((item) => !!item.id).map((item) => readWork(item, config));
}

/** The trade ids items actually carry, in the order they first appear. */
export function tradesOnItems(file: TimelineFile | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of file?.items ?? []) {
    const trade = text((isPlainObject(item.metadata) ? item.metadata : {})[TRADE_KEY]);
    if (!trade || seen.has(trade)) continue;
    seen.add(trade);
    out.push(trade);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the graph

/** Item id → the work under it. */
export function byId(works: readonly Work[]): Map<string, Work> {
  return new Map(works.filter((w) => !!w.itemId).map((w) => [w.itemId, w]));
}

/** Item id → the work that depends on it: its successors. */
export function dependentsOf(works: readonly Work[]): Map<string, Work[]> {
  const map = new Map<string, Work[]>();
  for (const work of works) {
    for (const target of work.dependsOn) {
      const known = map.get(target);
      if (known) known.push(work);
      else map.set(target, [work]);
    }
  }
  return map;
}

/**
 * The lag in force after this work finishes: its own value, else its trade's.
 *
 * **The lag belongs to the predecessor**, because the wait is what the finished work
 * imposes: the screed dries, and how long it dries is a property of the screed rather
 * than of whoever comes next. The item's own `lagDays` overrides its trade's, which is
 * how one thicker slab gets a longer wait without a second trade being invented.
 *
 * Whether that is the right model is the first open question in the README: a
 * practitioner may well say the wait belongs to the *pair*, since screed → parquet and
 * screed → tiling plausibly differ. `undefined` here means „not judgeable", never zero.
 */
export function lagAfter(work: Work, config: ConstructionConfig): number | undefined {
  if (work.lagDays !== undefined) return work.lagDays;
  return tradeById(config, work.trade)?.lagDays;
}

/** One edge of the schedule: a predecessor, its successor, and the wait between them. */
export type Edge = {
  predecessor: Work;
  successor: Work;
  /** `undefined` when neither the item nor its trade says how long the wait is. */
  lag?: number;
  /** The earliest day the successor may start. Absent when the lag or the end is. */
  earliest?: string;
};

/**
 * Every finish-to-start edge the timeline states, resolved.
 *
 * A `dependsOn` entry naming an item the timeline does not carry is skipped: the core
 * draws no edge for it either, so honouring it here would compute against a
 * predecessor nobody can see.
 */
export function edgesOf(works: readonly Work[], config: ConstructionConfig): Edge[] {
  const index = byId(works);
  const out: Edge[] = [];
  for (const successor of works) {
    for (const id of successor.dependsOn) {
      const predecessor = index.get(id);
      if (!predecessor) continue;
      const lag = lagAfter(predecessor, config);
      const earliest = predecessor.end != null && lag !== undefined ? shiftDays(predecessor.end, lag) : undefined;
      out.push({ predecessor, successor, lag, earliest: earliest || undefined });
    }
  }
  return out;
}

/**
 * The earliest day one item may start, from its **direct** predecessors only.
 *
 * One hop, on purpose, and it is what keeps the derived field cheap and safe: no
 * recursion means no cycle can hang a render, and the value stays a statement about
 * the edges the author drew rather than about the whole graph behind them.
 *
 * `undefined` as soon as **one** predecessor cannot be judged — an unknown trade, no
 * lag, no end to count from. A maximum taken over the judgeable subset would be too
 * early, and it would be displayed as a fact; „nothing" is the only answer that cannot
 * be mistaken for one.
 */
export function earliestStart(work: Work, works: readonly Work[], config: ConstructionConfig): string | undefined {
  const index = byId(works);
  let latest: string | undefined;
  let any = false;
  for (const id of work.dependsOn) {
    const predecessor = index.get(id);
    if (!predecessor) continue;
    any = true;
    const lag = lagAfter(predecessor, config);
    if (lag === undefined || !predecessor.end) return undefined;
    const candidate = shiftDays(predecessor.end, lag);
    if (!candidate) return undefined;
    if (!latest || candidate > latest) latest = candidate;
  }
  return any ? latest : undefined;
}

/**
 * Every cycle-carrying item, as one set of ids per cycle found.
 *
 * Reported rather than followed. A cycle has no earliest start and no order to shift
 * along, and the two verbs need to say so instead of terminating on a visited set and
 * looking as if they had computed something.
 */
export function cyclesOf(works: readonly Work[]): string[][] {
  const index = byId(works);
  const state = new Map<string, 'open' | 'done'>();
  const cycles: string[][] = [];
  const stack: string[] = [];

  const walk = (id: string): void => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'open') {
      const at = stack.indexOf(id);
      if (at >= 0) cycles.push(stack.slice(at));
      return;
    }
    const work = index.get(id);
    if (!work) return;
    state.set(id, 'open');
    stack.push(id);
    for (const target of work.dependsOn) walk(target);
    stack.pop();
    state.set(id, 'done');
  };

  for (const work of works) if (work.itemId) walk(work.itemId);
  return cycles;
}

// ---------------------------------------------------------------------------
// rule 1 and 2: what does not hold

/** One thing wrong with the schedule, or one thing about it that cannot be judged. */
export type Finding =
  /** Two trades in one section at the same time. */
  | { kind: 'section-overlap'; a: Work; b: Work; section: string; days: number }
  /** A successor starting before its predecessor's end plus the lag. */
  | { kind: 'lag-violation'; edge: Edge; earliest: string; shortBy: number }
  /** A fixed date the plan already passes. `binding` absent = the author did not say. */
  | { kind: 'fixed-date-passed'; work: Work; fixedDate: string; days: number; binding?: DateBinding }
  /** An item naming a trade the config does not define. */
  | { kind: 'unknown-trade'; work: Work; trade: string }
  /** Work something depends on, with no lag anywhere to measure the wait by. */
  | { kind: 'no-lag'; work: Work }
  /** An item sharing a section with another, carrying no trade to compare. */
  | { kind: 'no-trade'; work: Work; section: string }
  /** An item this plugin has fields on and no usable start. */
  | { kind: 'no-dates'; work: Work }
  /** A value the author wrote and this plugin refuses. */
  | { kind: 'bad-value'; work: Work; field: string; value: string }
  /** A cycle in `dependsOn`. */
  | { kind: 'cycle'; ids: string[] };

/** Does this work say anything at all that this plugin is about? */
export function carriesConstructionData(work: Work): boolean {
  return !!(work.trade || work.section || work.lagDays !== undefined || work.fixedDate || work.binding);
}

/** Do two extents overlap? Touching end to start is not an overlap. */
export function overlapDays(a: Work, b: Work): number {
  if (!a.start || !b.start || !a.end || !b.end) return 0;
  const from = a.start > b.start ? a.start : b.start;
  const to = (a.end < b.end ? a.end : b.end);
  const days = daysBetween(from, to);
  return days > 0 ? days : 0;
}

/**
 * Everything wrong with the schedule, and everything about it that cannot be judged.
 *
 * The second half is not padding. A report listing only failures answers „no conflicts"
 * for a timeline where nobody has filled in a single trade, and that silence reads as
 * safety — the same failure `check_eol_risk` was written against in the lifecycle
 * plugin.
 *
 * Nothing is ranked. Which overlap is acceptable depends on the two trades, and that is
 * not in the timeline.
 */
export function findingsOf(works: readonly Work[], config: ConstructionConfig): Finding[] {
  const findings: Finding[] = [];
  const dependents = dependentsOf(works);

  for (const cycle of cyclesOf(works)) findings.push({ kind: 'cycle', ids: cycle });

  // Rule: exclusive occupancy. Grouped by section, and only where the two items name
  // *different* trades: two bars of one trade in one place are that trade's own
  // business (two crews, two shifts), while the rule the domain states is about one
  // section being handed from one trade to the next.
  const bySection = new Map<string, Work[]>();
  for (const work of works) {
    if (!work.section) continue;
    const known = bySection.get(work.section);
    if (known) known.push(work);
    else bySection.set(work.section, [work]);
  }
  for (const [section, group] of bySection) {
    for (let i = 0; i < group.length; i += 1) {
      const a = group[i]!;
      if (group.length > 1 && !a.trade) findings.push({ kind: 'no-trade', work: a, section });
      for (let j = i + 1; j < group.length; j += 1) {
        const b = group[j]!;
        if (!a.trade || !b.trade || a.trade === b.trade) continue;
        const days = overlapDays(a, b);
        if (days > 0) findings.push({ kind: 'section-overlap', a, b, section, days });
      }
    }
  }

  // Rule: the lag on each edge.
  for (const edge of edgesOf(works, config)) {
    const { successor, earliest } = edge;
    if (!earliest || !successor.start) continue;
    const shortBy = daysBetween(successor.start, earliest);
    if (shortBy > 0) findings.push({ kind: 'lag-violation', edge, earliest, shortBy });
  }

  for (const work of works) {
    // Rule: a fixed date the plan already passes. Measured at the end of the work,
    // because that is the day the question is about: a handover is missed when the work
    // is still running, not when it started too late.
    if (work.fixedDate && work.end) {
      const days = daysBetween(work.fixedDate, work.end);
      if (days > 0) {
        findings.push({
          kind: 'fixed-date-passed',
          work,
          fixedDate: work.fixedDate,
          days,
          binding: work.binding,
        });
      }
    }

    if (work.trade && !tradeById(config, work.trade)) {
      findings.push({ kind: 'unknown-trade', work, trade: work.trade });
    }
    // Only for work something actually depends on: an item at the end of a chain owes
    // nobody a wait, so having no lag is not a gap there.
    if ((dependents.get(work.itemId) ?? []).length && lagAfter(work, config) === undefined) {
      findings.push({ kind: 'no-lag', work });
    }
    if (!work.start && carriesConstructionData(work)) findings.push({ kind: 'no-dates', work });
    for (const bad of work.badValues) {
      findings.push({ kind: 'bad-value', work, field: bad.field, value: bad.value });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// rule 3: the chain shift

/** One item the shift moves, and where to. */
export type Move = {
  work: Work;
  from: string;
  to: string;
  /** The new end, only for an item carrying an `end` of its own. */
  endTo?: string;
};

/** One item inside the chain that the shift leaves where it is, and why. */
export type Held = {
  work: Work;
  /**
   * `fixed-date` — it carries one, and a fixed date is never moved by a tool.
   * `no-start` — there is no day to move.
   * `timed-dates` — its dates carry a time of day, which a day shift would drop.
   * `bad-dates` — its start or end is a value this plugin will not parse.
   */
  why: 'fixed-date' | 'no-start' | 'timed-dates' | 'bad-dates';
};

/**
 * A fixed date the shifted chain can no longer meet.
 *
 * Measured as „what the predecessors now demand" rather than „where this item sits",
 * and the difference is the whole finding. The item does not move — that is the rule —
 * so its own end says nothing about the shift. What changed is the earliest day its
 * predecessors allow it to start, and therefore the earliest day it can be finished.
 *
 * `overByBefore` is carried because a plan that was already two days over and is now
 * nine is a different sentence from one the shift broke.
 */
export type FixedDateBreak = {
  work: Work;
  fixedDate: string;
  /** The earliest day this work could now be finished, given its predecessors. */
  neededEnd: string;
  overBy: number;
  overByBefore: number;
  binding?: DateBinding;
};

export type ShiftPlan = {
  ok: true;
  moves: Move[];
  held: Held[];
  /** Fixed dates the shifted chain can no longer meet. */
  breaks: FixedDateBreak[];
  /**
   * Edges whose lag this shift broke, or made worse.
   *
   * **Only the ones it changed.** A violation that was already in the plan is
   * `check_trade_conflicts`'s answer, and repeating it here would put a finding the
   * caller did not cause in the middle of the report of what they did — the first run
   * against the committed example did exactly that, naming a flat the shift never
   * touched.
   *
   * Excludes any edge into an item carrying a fixed date: that case is a `break`, which
   * states it in the terms the domain cares about instead of reporting one fact under
   * two names.
   */
  lagBroken: { edge: Edge; earliest: string; shortBy: number; shortByBefore: number }[];
};

export type ShiftRefusal =
  | { ok: false; reason: 'no-seed' }
  | { ok: false; reason: 'cycle'; ids: string[] };

/**
 * Move a piece of the schedule and everything downstream of it.
 *
 * **The whole chain, not the next link.** A trade running a week late moves every
 * trade that transitively depends on it by that week, which is the one thing every
 * source on the domain says and no template does.
 *
 * **An item carrying a fixed date stays put.** The chain runs into it, and this
 * function's job is then to say by how much and under which binding. A verb that
 * silently carried a Vertragsfrist along with the delay would be able to make a late
 * plan look on time, which is the one outcome nobody can afford to have automated.
 * Compressing the chain to save the date is deliberately not attempted: deciding
 * *where* a week comes out of a building programme is the site manager's call, and a
 * plugin that guessed would be guessing about the part that costs money.
 *
 * **A cycle refuses the whole plan.** A plan is one rule's answer, and applying the
 * half of it that happened to be well-formed leaves the timeline in a state the rule
 * never described.
 */
export function shiftChain(
  works: readonly Work[],
  config: ConstructionConfig,
  seedIds: readonly string[],
  days: number,
): ShiftPlan | ShiftRefusal {
  const index = byId(works);
  const seeds = seedIds.filter((id) => index.has(id));
  if (!seeds.length) return { ok: false, reason: 'no-seed' };

  const dependents = dependentsOf(works);

  // The transitive closure downstream of the seeds, seeds included. A cycle inside it
  // has no order to shift along, so it refuses here rather than terminating quietly on
  // the visited set.
  const closure = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const id = queue.shift()!;
    if (closure.has(id)) continue;
    closure.add(id);
    for (const next of dependents.get(id) ?? []) if (next.itemId) queue.push(next.itemId);
  }
  for (const cycle of cyclesOf(works)) {
    if (cycle.some((id) => closure.has(id))) return { ok: false, reason: 'cycle', ids: cycle };
  }

  const moves: Move[] = [];
  const held: Held[] = [];
  const movedTo = new Map<string, { start: string; end: string }>();

  for (const id of closure) {
    const work = index.get(id);
    if (!work) continue;
    if (work.fixedDate) {
      held.push({ work, why: 'fixed-date' });
      continue;
    }
    if (!work.start) {
      held.push({ work, why: work.badValues.some((b) => b.field === 'start') ? 'bad-dates' : 'no-start' });
      continue;
    }
    // An item whose `end` this plugin refuses is not shifted at all: moving only its
    // start would silently change its length.
    if (work.badValues.some((b) => b.field === 'end')) {
      held.push({ work, why: 'bad-dates' });
      continue;
    }
    // A timestamp is read as its day everywhere above and is never written back as one.
    if (!work.datesAreDays) {
      held.push({ work, why: 'timed-dates' });
      continue;
    }
    const to = shiftDays(work.start, days);
    if (!to) {
      held.push({ work, why: 'bad-dates' });
      continue;
    }
    // Only an item carrying its own `end` gets one written. One with a `duration` keeps
    // it, so its extent travels rather than being recomputed, and one with neither
    // never had an end to move.
    const endTo = work.hasOwnEnd && work.end ? shiftDays(work.end, days) : undefined;
    moves.push({ work, from: work.start, to, endTo: endTo || undefined });
    movedTo.set(id, { start: to, end: endTo || (work.end ? shiftDays(work.end, days) : to) });
  }

  // What the shifted schedule looks like, so the consequences below are read off the
  // result rather than off the plan that is being replaced.
  const after = works.map((work): Work => {
    const moved = movedTo.get(work.itemId);
    return moved ? { ...work, start: moved.start, end: moved.end } : work;
  });

  // How much of the fixed date is left, once the predecessors have had their say. The
  // item's own length travels with it: a handover week still needs a week after the last
  // trade clears, so what the date has to hold is the earliest start plus that length.
  const overshoot = (work: Work, schedule: readonly Work[]): { neededEnd: string; overBy: number } | null => {
    if (!work.fixedDate) return null;
    const earliest = earliestStart(work, schedule, config);
    if (!earliest) return null;
    const own = work.start && work.end ? daysBetween(work.start, work.end) : 0;
    const neededEnd = shiftDays(earliest, own > 0 ? own : 0);
    if (!neededEnd) return null;
    return { neededEnd, overBy: daysBetween(work.fixedDate, neededEnd) };
  };

  const breaks: FixedDateBreak[] = [];
  for (const work of after) {
    const now = overshoot(work, after);
    if (!now || now.overBy <= 0) continue;
    const before = overshoot(work, works);
    breaks.push({
      work,
      fixedDate: work.fixedDate!,
      neededEnd: now.neededEnd,
      overBy: now.overBy,
      overByBefore: before && before.overBy > 0 ? before.overBy : 0,
      binding: work.binding,
    });
  }

  // How short each edge was before, so the report can be about what this shift did.
  const shortfall = (schedule: readonly Work[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const edge of edgesOf(schedule, config)) {
      const { predecessor, successor, earliest } = edge;
      if (!earliest || !successor.start) continue;
      const short = daysBetween(successor.start, earliest);
      if (short > 0) out.set(`${predecessor.itemId}→${successor.itemId}`, short);
    }
    return out;
  };
  const before = shortfall(works);

  const lagBroken: ShiftPlan['lagBroken'] = [];
  for (const edge of edgesOf(after, config)) {
    const { predecessor, successor, earliest } = edge;
    // A fixed-date successor's unmet lag IS the broken fixed date, reported above in the
    // terms the domain uses. Listing it here as well would be the same fact twice.
    if (!earliest || !successor.start || successor.fixedDate) continue;
    const shortBy = daysBetween(successor.start, earliest);
    const was = before.get(`${predecessor.itemId}→${successor.itemId}`) ?? 0;
    if (shortBy > was) lagBroken.push({ edge, earliest, shortBy, shortByBefore: was });
  }

  return { ok: true, moves, held, breaks, lagBroken };
}

/** The ids a shift starts from: one item, or every item of one trade. */
export function seedsFor(works: readonly Work[], opts: { item?: string; trade?: string }): string[] {
  if (opts.item) return works.filter((w) => w.itemId === opts.item).map((w) => w.itemId);
  if (opts.trade) return works.filter((w) => w.trade === opts.trade).map((w) => w.itemId);
  return [];
}
