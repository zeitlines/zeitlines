// The item fields this plugin contributes, and the value behind the computed one.
//
// Six fields, and the split between them is the model:
//
//   - Five are **input**, declared in the manifest's `metadataKeys`, so an uninstall
//     cleans them off items.
//   - One is **computed** and stored nowhere: the earliest day an item may start, given
//     its predecessors and the wait each of them imposes. Keeping a copy would let the
//     predecessor move out from under it, and a stale „may start on the 14th" is
//     indistinguishable from a true one.
//
// **Every date and number field is `type: 'text'`, and that is a limit rather than a
// choice.** `CustomFieldType` is `text | select | multi-select` — no date type and no
// number type — so the form offers no picker and this plugin parses and refuses in
// `schedule.ts` instead.
//
// This module is imported by the registry **statically**, so it stays data-only: types,
// the contract barrel and this plugin's own modules. Anything reaching view code would
// land the plugin in the generic bundle and undo the lazy split.

import { hasPlugin, pluginConfig, type DeriveFn } from '../../pluginHost/api';
import type { CustomFieldDef, CustomFieldOption, TimelineFile } from '../../types';
import { t } from './messages';
import {
  CONSTRUCTION_PLUGIN,
  DATE_BINDINGS,
  DATE_BINDING_KEY,
  EARLIEST_START_KEY,
  FIXED_DATE_KEY,
  LAG_DAYS_KEY,
  SECTION_KEY,
  TRADE_KEY,
  byId,
  earliestStart,
  readConfig,
  readSchedule,
  tradeById,
  tradesOnItems,
} from './schedule';

// Re-exported rather than declared twice: the keys and the plugin id belong to the data
// model (`schedule.ts`).
export {
  CONSTRUCTION_PLUGIN,
  DATE_BINDING_KEY,
  EARLIEST_START_KEY,
  FIXED_DATE_KEY,
  LAG_DAYS_KEY,
  SECTION_KEY,
  TRADE_KEY,
} from './schedule';

/**
 * The options of the trade field: the configured trades, plus every trade id items
 * already carry.
 *
 * **The second half is what keeps stored data reachable.** A select renders only what it
 * offers, so dropping a trade from the config would leave every item carrying it in
 * front of an empty control over a value still sitting in `metadata` — invisible, and
 * one save away from being lost. Offered, the retired trade stays visible and
 * `check_trade_conflicts` reports it as unknown to the config, which is the truthful
 * answer rather than a silent one.
 *
 * A trade present on items but not in the config is labelled with its own id: there is
 * nowhere else to read a name from, and inventing one would hide exactly the mismatch
 * this is here to show.
 */
export function tradeOptions(file: TimelineFile | null | undefined): CustomFieldOption[] {
  const config = readConfig(pluginConfig(file, CONSTRUCTION_PLUGIN));
  const out: CustomFieldOption[] = config.trades.map((trade) => ({ value: trade.id, label: trade.label }));
  for (const id of tradesOnItems(file)) {
    if (tradeById(config, id)) continue;
    out.push({ value: id, label: id });
  }
  return out;
}

/**
 * The plugin's fields, in the order they render.
 *
 * All six as soon as the plugin is enabled, with **no config requirement**. A timeline
 * that has just switched the plugin on needs somewhere to write the first trade and the
 * first fixed date; gating the fields on a populated config would leave the user with no
 * way to produce the data the config is about.
 */
export function constructionFields(file: TimelineFile | null | undefined): CustomFieldDef[] {
  if (!file || !hasPlugin(file, CONSTRUCTION_PLUGIN)) return [];

  return [
    {
      key: TRADE_KEY,
      // Half of what the interface shows: the core prefixes the plugin name, so this
      // reads „Bauzeitenplan · Gewerk" in the grouping menu. Renaming either half
      // renames both.
      label: t('field.trade'),
      // A select, because this is a field the domain groups by: „who is on site in
      // which week" is one grouping away once the buckets exist.
      type: 'select',
      options: tradeOptions(file),
    },
    // Free text, unlike the trade: a section is a floor, a flat or a riser, and the
    // project names them. There is no config to derive an option set from, and deriving
    // one from the values already present would offer a typo as a choice.
    { key: SECTION_KEY, label: t('field.section'), type: 'text' },
    { key: LAG_DAYS_KEY, label: t('field.lagDays'), type: 'text' },
    { key: FIXED_DATE_KEY, label: t('field.fixedDate'), type: 'text' },
    {
      key: DATE_BINDING_KEY,
      label: t('field.dateBinding'),
      type: 'select',
      // Both offered rather than only the occupied one: two fixed states, so an empty
      // bucket is a real answer („nothing here is contractually binding") rather than a
      // lane out to the end of a raster. The values are stored ids and stay English.
      options: DATE_BINDINGS.map((value) => ({ value, label: t(`binding.${value}`) })),
    },
    {
      key: EARLIEST_START_KEY,
      label: t('field.earliestStart'),
      // A date rather than a choice, so `text`: the options of a select would be every
      // day in the calendar.
      type: 'text',
      derived: true,
    },
  ];
}

/**
 * The value behind the one `derived: true` field.
 *
 * The factory shape is the contract: the config and the whole schedule are read once per
 * build here, and the function handed back is pure over one item — which is what makes
 * the rule testable in this folder and lets the tool handlers reuse exactly the same
 * arithmetic.
 *
 * An item with no predecessors yields nothing rather than its own start. „May start on
 * the day it starts" is not a statement about a schedule, and an item carrying it would
 * be indistinguishable from one whose chain was actually computed.
 */
export function constructionDerive(file: TimelineFile | null | undefined): DeriveFn | null {
  if (!file || !hasPlugin(file, CONSTRUCTION_PLUGIN)) return null;
  const config = readConfig(pluginConfig(file, CONSTRUCTION_PLUGIN));
  const works = readSchedule(file, config);
  const index = byId(works);

  return (item) => {
    const work = item.id ? index.get(item.id) : undefined;
    if (!work) return {};
    return { [EARLIEST_START_KEY]: earliestStart(work, works, config) ?? undefined };
  };
}
