# Changing this plugin

Conventions for `src/plugins/construction/`. The product-wide rules are in the
repository's [`AGENTS.md`](../../../AGENTS.md); what follows is only what is specific
to this folder. The domain model, the confidence statement and the open questions are
in [`README.md`](README.md), which is also the public page.

## Where things live

| File | What |
| --- | --- |
| `manifest.ts` | the declaration: id, capabilities, fields it owns, config schema, the two verbs, the catalogue entry. Also `TRADE_ID_PATTERN`, see below |
| `schedule.ts` | the domain. Every rule, as pure functions over the timeline |
| `schedule.test.ts` | those rules, at the boundaries the domain cares about |
| `fields.ts` | the six contributed fields and the one derived value |
| `tools.ts` | the two verbs: arguments in, a plan of item changes and English notes out |
| `messages.ts` | the interface text, in both languages |
| `../../../data/example-bauzeitenplan.json` | the example timeline, and the source of `preview.png` |

## Invariants, each with the failure it prevents

**`TRADE_ID_PATTERN` lives in `manifest.ts`, and `schedule.ts` imports it — never the
other way round.** `scripts/db/plugin-manifests.ts` imports this manifest, which puts
it in the edge function's bundle. A value imported out of `schedule.ts` drags the rule
module and the plugin API barrel in with it, and Deno then fails to resolve the
extensionless relative specifiers inside them: the deploy breaks while every local
check passes. `scripts/ci/edge-imports.test.ts` catches it, and it caught it here.

**`lagDays` is never defaulted to zero.** Zero says „the next trade may start the day
this one ends", which is a claim about somebody's building. A trade whose config entry
is incomplete is dropped, and both verbs then report that they cannot judge it. The
same rule governs the config schema, which has no `default` anywhere.

**The lag belongs to the predecessor.** `lagAfter(work)` reads the item's own
`lagDays`, falling back to its trade's. Changing this to the *pair* is open question 1
in the README and would be a model change rather than a refactor: it needs somewhere
to put an edge, which the core has no representation for.

**A fixed date is never moved, in either direction, by anything here.** `shiftChain`
holds such an item and reports what the chain now demands of it. A verb that carried a
Vertragsfrist along with a delay could make a late plan look on time.

**Nothing defaults `dateBinding`.** Under the VOB/B an unqualified intermediate date
*is* a Kontrollfrist, so defaulting would even be the sourced answer — and it is still
refused, because this plugin cannot know whether a given item is the overall
completion, which is binding by default. A silent default would label the one date
somebody is liable for as the one that carries no consequence.

**A shift reports what the shift did, not what was already wrong.** `lagBroken` and
`breaks` both compare the schedule before against the schedule after, and only report
what got worse. The first run against the committed example named a flat the shift
never touched; the standing state is `check_trade_conflicts`'s answer.

**A timestamp is read as its day and never written back as one.** `datesAreDays` is
what the shift asks before it rewrites anything. `shiftDays` returns a calendar day, so
shifting `2026-09-08T17:00` would store `2026-09-15` and drop the time somebody
entered.

**The stored values `contract` and `control` are ids and are never translated.** Only
their labels move. `fields.test.ts` asserts both halves: the values stay put across
every locale, *and* the labels really do change, so the first assertion cannot pass
because nothing is translated at all.

**`dependsOnOf` is a hand-kept copy of the core's `extractDependsOn`**, including where
the core does not trim: a list entry keeps its whitespace, only the single-string form
is trimmed. Trimming both in `sprints/tools.ts` once made that file claim a dependent
no arrow on the page corresponded to. This is the third copy in the repository and that
is a gap in the plugin contract, reported on the extension-point issues rather than
worked around in a core file.

## What must not be renamed

`trade`, `section`, `lagDays`, `fixedDate` and `dateBinding` are `metadata` keys on
real items and are declared in the manifest's `metadataKeys`. Renaming one orphans the
data and breaks the uninstall cleanup. `earliestStart` is computed and stored nowhere,
which is why it is deliberately absent from that list.

Core vocabulary stays core vocabulary. A Gewerk is a **kind of** group and a Fixtermin
is an **item with a rule attached**; neither renames anything. The mapping is the
terminology table in the README.

**„Lag", not „lead time".** A lead is the opposite in CPM — a negative lag. Issue #135
asked for this under the wrong word, and the whole argument is in the README's
terminology table. Changing the label back is not a wording preference, it inverts the
meaning.

## How to verify a change

```bash
npx tsx --test 'src/plugins/construction/*.test.ts'
npm test && npm run typecheck && npm run schema:check
npm run plugins:catalogue:check && node scripts/ci/check-plugin-isolation.mjs
```

`schema:check` validates the example timeline, so a change to the field shape that
forgets it fails loudly.

**Changing what a reader sees means retaking the picture** (playbook 5.5):

```bash
npm run plugins:preview -- construction --param sv=nach-gewerk --size 1280x620
```

The saved view is not optional. The grouping dimension is per-timeline display state
and is not addressable in the hash, so without `sv=nach-gewerk` the preview renders
grouped by the core group and shows nothing this plugin contributes.
