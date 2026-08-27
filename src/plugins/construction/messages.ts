// This plugin's interface text, in the two languages the host ships.
//
// The contract is „Text in more than one language" (docs/plugin-authoring.md). Its
// **agent-facing** text is not here and is not translated: a tool's notes and refusals
// are English like the rest of the tool surface (docs/mcp.md), and they live at the
// site that produces them, in `tools.ts`.
//
// **Two kinds of string are deliberately absent.** The stored option values
// (`contract`, `control`) are ids in item metadata, so only their labels are below. And
// a trade's `label` comes out of the timeline's config: it is the project's own word for
// its Gewerk, which makes it a value the host renders as given rather than a label to
// look up.
//
// Every key here is a plain label, so none of the four exempt key shapes („Interface
// text" in AGENTS.md) applies. Adding a `refusal.` prefix to buy room for a longer label
// would be a visible lie in a diff.

import { pluginMessages } from '../../pluginHost/api';

export const t = pluginMessages('dev.zeitlines.construction', {
  en: {
    // What the manifest declares, in the reader's language. A manifest holds no
    // functions and cannot call `t()`, so the host looks this up here and falls back to
    // the literal in `manifest.ts` — see `manifestText` in src/pluginHost/messages.ts.
    'manifest.name': 'Construction schedule',

    // The five stored fields. „Lag" rather than „lead time", which is the opposite in
    // CPM — the terminology table in the README carries the whole argument.
    'field.trade': 'Trade',
    'field.section': 'Section',
    'field.lagDays': 'Lag (days)',
    'field.fixedDate': 'Fixed date',
    'field.dateBinding': 'Binding',

    // The computed field. Read-only in the form and stored nowhere.
    'field.earliestStart': 'Earliest start',

    // The two binding values, as labels. The ids stay English and unstored.
    'binding.contract': 'Contract deadline',
    'binding.control': 'Control deadline',
  },
  de: {
    'manifest.name': 'Bauzeitenplan',

    // „Gewerk" and „Bauabschnitt" are the words the trade itself uses, and they are
    // what a German searcher types. „Wartezeit" for the lag: „Zeitabstand" is the
    // German MS Project's word and precise, but it is software vocabulary rather than
    // site vocabulary. „Vorlaufzeit" is deliberately avoided — the sources use it for
    // the notice a trade needs before it can come, which is a different wait (README,
    // open question 2).
    'field.trade': 'Gewerk',
    'field.section': 'Bauabschnitt',
    'field.lagDays': 'Wartezeit (Tage)',
    'field.fixedDate': 'Fixtermin',
    'field.dateBinding': 'Verbindlichkeit',

    'field.earliestStart': 'Frühester Beginn',

    // The VOB/B's own two words. Translating them into anything plainer would lose the
    // distinction, which is the whole reason the field exists.
    'binding.contract': 'Vertragsfrist',
    'binding.control': 'Kontrollfrist',
  },
});
