// What this plugin declares about itself. The host reads it *before* running any
// plugin code, so everything the plugin needs has to be declared rather than requested
// at runtime.
//
// `register()` refuses an invalid manifest and throws while the module loads, so a
// mistake here does not produce a plugin that fails to appear: it takes the app down.
// `manifest.test.ts` is the cheap guard against that.

import type { PluginManifest } from '../../pluginHost/api';

/**
 * The shape a trade id has to have to survive being a grouping key.
 *
 * Declared **here** and imported by the rule module rather than the other way round, and
 * that direction is load-bearing: this file is reachable from the edge function
 * (`scripts/db/plugin-manifests.ts` imports it), so importing a value out of
 * `schedule.ts` would drag the whole rule module and the plugin API barrel into a bundle
 * that only wanted static data. `scripts/ci/edge-imports.test.ts` caught exactly that.
 * A manifest holds no functions and needs no code, which is what makes it readable by a
 * host that runs none.
 */
export const TRADE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

export const constructionManifest: PluginManifest = {
  id: 'dev.zeitlines.construction',
  name: 'Construction schedule',
  version: '0.1.0',
  // `^1.7` is the floor, and each step is load-bearing rather than aspirational:
  // `^1.3` for `tools`, `^1.5` for the one `derived` field (on an older host it renders
  // as an editable control with nothing filling it, which reads as the plugin being
  // broken), `^1.6` for the calendar-day arithmetic this plugin takes from the contract
  // instead of restating, and `^1.7` for `pluginMessages`, without which the labels
  // cannot follow the reader.
  apiVersion: '^1.7',

  // `items:read` for the schedule, `items:write` because one verb moves dates, `fields`
  // for the six fields, `tools` for the two verbs.
  //
  // **No `data:own` and no `public:read`.** This plugin owns no rows: a trade is a line
  // in the config and everything else is a value on an item, so there is nothing for
  // `stripFileForPublication` to strip and nothing for a timeline to consent to.
  // Declaring a publication gate over data that does not exist would be a claim about
  // nothing. No `views` either: a trade and a section are both kinds of group, so
  // grouping by either renders the schedule, and a view is roughly ten times the work
  // of the rule that makes it worth having.
  capabilities: ['items:read', 'items:write', 'fields', 'tools'],

  catalogue: {
    summary:
      'Sequences trades by the wait each one owes the next, shifts the whole chain when one runs late, and reports the fixed dates that shift runs into.',
    // A slug: the validator demands `^[a-z][a-z0-9-]*$`, and a space here would make
    // `register()` throw at module load, which takes the whole app down rather than
    // hiding one plugin.
    domain: 'construction',
    // The words the harvest found people searching with, in both languages, not the
    // ones this code uses. „Bauzeitenplan" is the single highest-traffic term the
    // research turned up and it is untranslatable, so it stays German. „Lag time" and
    // „Wartezeit" are both here because the English and the German practice disagree
    // about which word names the wait, and „lead time" is absent on purpose: it means
    // the opposite (see the terminology table in README.md).
    keywords: [
      'bauzeitenplan',
      'construction schedule',
      'bauablaufplan',
      'gewerke',
      'trades',
      'lag time',
      'zeitabstand',
      'wartezeit',
      'bauabschnitt',
      'chain shift',
      'vertragsfrist',
      'kontrollfrist',
      'fixed date',
      'self-hosted construction schedule',
    ],
    example: 'src:example-bauzeitenplan',
  },

  // The five keys a person fills in, and therefore the five an uninstall cleans off
  // items.
  //
  // `earliestStart` is deliberately absent, and that difference is the model: it is
  // computed on every build from the item's own predecessors, so no item carries a value
  // under it and there is nothing to purge. Listing it would promise a cleanup with
  // nothing to clean and would suggest the computed day is stored.
  metadataKeys: ['trade', 'section', 'lagDays', 'fixedDate', 'dateBinding'],

  configSchema: {
    type: 'object',
    properties: {
      trades: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              // Constrained because this value is stored in `metadata.trade` and is used
              // as a grouping key. A trade id with a space or a colon in it survives
              // being written and then reads badly everywhere it is addressed.
              pattern: TRADE_ID_PATTERN,
              description: 'Stored on items as the trade. Letters, digits, dot, dash and underscore.',
            },
            label: {
              type: 'string',
              minLength: 1,
              description: 'The project’s own name for the trade („Estrich"). Shown as given, never translated.',
            },
            lagDays: {
              // **No `default`.** A missing lag defaulted to zero would be this plugin
              // asserting „the next trade may start the day this one ends", which is a
              // claim about somebody's building. The verbs report that they cannot judge
              // the trade instead, and an incomplete entry is dropped rather than
              // completed.
              type: 'integer',
              minimum: 0,
              description: 'Days a successor waits after this trade finishes. Zero is a statement, not a default.',
            },
          },
          // All three. An entry missing any of them is dropped rather than filled in.
          required: ['id', 'label', 'lagDays'],
          additionalProperties: false,
        },
        description: 'The project’s trades, each with the wait it imposes on whatever follows it.',
      },
    },
    additionalProperties: false,
  },

  // The two verbs, implemented as pure functions in `tools.ts` under the same names.
  // The descriptions are what a model reads before choosing, so each names the rule
  // **and its limit** rather than saying „applies the rule".
  //
  // Three absences are deliberate. Nothing here writes a trade or a lag: the trade list
  // is the project's decision rather than a computation. Nothing compresses a chain to
  // save a fixed date, because deciding where a week comes out of a building programme
  // is the site manager's call. And nothing moves a fixed date, in either direction — a
  // verb that could would be able to make a late plan look on time.
  tools: [
    {
      name: 'check_trade_conflicts',
      title: 'Report what the schedule does not hold',
      description:
        'Report every place the schedule contradicts itself: two different trades occupying one section at the ' +
        'same time, a successor starting before its predecessor’s end plus the lag that predecessor imposes, and a ' +
        'fixed date the plan already passes — the last split by binding, because a contract deadline and a control ' +
        'deadline have different consequences. Also names what cannot be judged at all: a trade the config does not ' +
        'define, work something depends on with no lag anywhere, an item with no usable date, a value that will not ' +
        'parse, and a cycle in the dependencies. Touching end to start is not an overlap, and two bars of the SAME ' +
        'trade in one section are not either. Ranks nothing: which overlap is acceptable depends on the two trades, ' +
        'and that is not in the timeline. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            minLength: 1,
            description: 'Report only items in this section. Absent: every item.',
          },
          trade: {
            type: 'string',
            minLength: 1,
            description: 'Report only items carrying this trade. Absent: every item.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'shift_trade_chain',
      title: 'Move a trade and everything downstream of it',
      description:
        'Move one item, or every item of one trade, by a number of days — and with it every item that TRANSITIVELY ' +
        'depends on it, along the whole chain rather than the next link. Give either "item" or "trade", not both. ' +
        'Days may be negative to pull work earlier. An item carrying a fixed date is NOT moved: the chain runs into ' +
        'it, and the answer says by how many days and under which binding, because a verb that carried a contract ' +
        'deadline along with the delay could make a late plan look on time. Nothing is compressed to save that date. ' +
        'Reports every lag the result no longer respects, which is what a negative shift usually produces. Refuses ' +
        'the whole plan, changing nothing, when the dependencies contain a cycle. Leaves an item whose start or end ' +
        'it will not parse where it is, and says which.',
      inputSchema: {
        type: 'object',
        properties: {
          // „Exactly one of these two" is not expressible in the schema subset the host
          // enforces (`SUPPORTED_KEYWORDS` in src/pluginHost/dataSchema.ts), so the
          // handler refuses both-or-neither itself. Declaring `oneOf` here would be a
          // constraint the host silently skips, which is worse than one it never
          // promised: the author reads it as checked.
          item: {
            type: 'string',
            minLength: 1,
            description: 'Id of the one item to move, with everything downstream of it.',
          },
          trade: {
            type: 'string',
            minLength: 1,
            description: 'Move every item carrying this trade instead of one named item.',
          },
          days: {
            type: 'integer',
            description: 'Calendar days to move by. Negative pulls the work earlier.',
          },
        },
        required: ['days'],
        additionalProperties: false,
      },
      writes: 'items',
    },
  ],
};
