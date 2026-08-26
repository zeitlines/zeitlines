import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TRADE_ID_PATTERN, constructionManifest } from './manifest';
import { constructionDescriptor } from './descriptor';
import { constructionTools } from './tools';
import { CONSTRUCTION_PLUGIN } from './schedule';
import { validateManifest, validateToolArgs } from '../../pluginHost/api';
// The checks the host runs before it stores anything, and the one `plugins:catalogue:check`
// runs before it publishes. Reaching past the contract barrel is allowed here and nowhere
// else: tests are exempt from the plugin-isolation check, and asserting a declaration
// against the very functions the host applies is the point — an assertion on the schema's
// own keywords would only restate what is written above it.
import { catalogueProblems } from '../../pluginHost/manifest';
import { unsupportedKeywords, validateRow } from '../../pluginHost/dataSchema';

// Cheap, and it catches the one failure that is not local to this plugin: `register()`
// validates a manifest and THROWS at module load, so an invalid one here does not produce
// a plugin that fails to appear. It takes the whole app down, for everyone, on the first
// import.

const decl = (name: string) => constructionManifest.tools!.find((t) => t.name === name)!;

test('the manifest validates against the host contract', () => {
  const result = validateManifest(constructionManifest);
  assert.deepEqual(result.ok ? [] : result.problems, []);
});

test('the id is the one the code keys its data with', () => {
  // Two copies of the id is how a rename keys new rows one way and reads them another.
  assert.equal(constructionManifest.id, CONSTRUCTION_PLUGIN);
  assert.equal(constructionDescriptor.manifest.id, CONSTRUCTION_PLUGIN);
});

test('the api version floor is high enough for everything declared', () => {
  // `tools` arrived in 1.3, `derived` fields in 1.5, the calendar-day arithmetic in 1.6
  // and `pluginMessages` in 1.7. Claiming less would load on an older host with the verbs
  // listed nowhere and the computed field rendered as an empty editable control.
  assert.equal(constructionManifest.apiVersion, '^1.7');
});

test('the capabilities are exactly what is declared and nothing more', () => {
  assert.deepEqual([...(constructionManifest.capabilities ?? [])].sort(), [
    'fields',
    'items:read',
    'items:write',
    'tools',
  ]);
  // No rows, so no publication gate to declare and nothing for the materializer to
  // strip. No view, so no chunk.
  assert.equal(constructionManifest.collections, undefined);
  assert.equal(constructionManifest.publicRead, undefined);
  assert.equal(constructionManifest.views, undefined);
  assert.equal(constructionDescriptor.load, undefined);
});

test('the catalogue entry is publishable', () => {
  // The same function `plugins:catalogue:check` applies, so the plugin cannot ship an
  // entry the catalogue then refuses.
  assert.deepEqual(catalogueProblems(constructionManifest.catalogue), []);
});

test('the keywords carry both languages and not the word that means the opposite', () => {
  const keywords = constructionManifest.catalogue!.keywords.map((k) => k.toLowerCase());
  assert.ok(keywords.includes('bauzeitenplan'));
  assert.ok(keywords.includes('construction schedule'));
  assert.ok(keywords.includes('lag time'));
  // „lead time" is what issue #135 called this and it means the opposite in CPM — a
  // negative lag. Searching for it should not land on a plugin that adds days.
  assert.equal(
    keywords.some((k) => k.includes('lead time')),
    false,
  );
});

test('every declared tool has a handler, and every handler is declared', () => {
  // The host reports both mismatches and neither is callable: a declaration without a
  // handler is a verb an agent can see and cannot call, and a handler without a
  // declaration is a rule nobody approved on install.
  const declared = (constructionManifest.tools ?? []).map((t) => t.name).sort();
  const implemented = Object.keys(constructionTools).sort();
  assert.deepEqual(declared, implemented);
  assert.deepEqual(declared, ['check_trade_conflicts', 'shift_trade_chain']);
  assert.deepEqual(Object.keys(constructionDescriptor.tools ?? {}).sort(), implemented);
});

test('only the verb that moves dates declares writes', () => {
  assert.equal(decl('check_trade_conflicts').writes, undefined);
  assert.equal(decl('shift_trade_chain').writes, 'items');
});

test('every tool input schema is one the host can actually apply', () => {
  for (const tool of constructionManifest.tools ?? []) {
    assert.deepEqual(unsupportedKeywords(tool.inputSchema ?? {}), [], `${tool.name} uses a keyword nothing checks`);
  }
});

test('the config schema is one the host can actually apply', () => {
  assert.deepEqual(unsupportedKeywords(constructionManifest.configSchema ?? {}), []);
});

test('a trade entry needs an id, a label and a lag', () => {
  const schema = constructionManifest.configSchema!;
  const ok = validateRow(schema, { trades: [{ id: 'screed', label: 'Estrich', lagDays: 28 }] }, 'config');
  assert.deepEqual(ok, []);
  // A missing lag is refused rather than defaulted to zero, which would be this plugin
  // asserting that nothing has to dry.
  assert.equal(validateRow(schema, { trades: [{ id: 'screed', label: 'Estrich' }] }, 'config').length > 0, true);
  assert.equal(validateRow(schema, { trades: [{ id: 'screed', label: 'Estrich', lagDays: -1 }] }, 'config').length > 0, true);
  assert.equal(
    validateRow(schema, { trades: [{ id: 'a b', label: 'Estrich', lagDays: 1 }] }, 'config').length > 0,
    true,
  );
  assert.equal(validateRow(schema, { minParallelRunDays: 30 }, 'config').length > 0, true);
});

test('a lag of zero passes the config schema', () => {
  // Zero is a statement („the next trade may start the day this one ends"), so the schema
  // has to accept it while refusing an absent value.
  assert.deepEqual(
    validateRow(constructionManifest.configSchema!, { trades: [{ id: 'floor', label: 'Parkett', lagDays: 0 }] }, 'config'),
    [],
  );
});

test('the trade id pattern is the one the code enforces', () => {
  // Declared once in the manifest and referenced by the rule module, so a widened pattern
  // cannot be accepted by the write path and rejected by the reader.
  const props = (constructionManifest.configSchema!.properties as Record<string, any>).trades.items.properties;
  assert.equal(props.id.pattern, TRADE_ID_PATTERN);
});

test('the shift verb takes days and refuses an unknown argument', () => {
  const shift = decl('shift_trade_chain');
  assert.deepEqual(validateToolArgs(shift, { item: 'a', days: 7 }), []);
  assert.deepEqual(validateToolArgs(shift, { trade: 'screed', days: -7 }), []);
  assert.deepEqual(validateToolArgs(shift, { days: 0 }), []);
  assert.equal(validateToolArgs(shift, { item: 'a' }).length > 0, true);
  assert.equal(validateToolArgs(shift, { item: 'a', days: 1.5 }).length > 0, true);
  assert.equal(validateToolArgs(shift, { item: 'a', days: 7, weather: 'rain' }).length > 0, true);
  // „Exactly one of item or trade" is not expressible in the enforced subset, so the
  // schema lets both through and the handler refuses them. Asserted here so the split
  // stays visible: `tools.test.ts` holds the other half.
  assert.deepEqual(validateToolArgs(shift, { item: 'a', trade: 'screed', days: 7 }), []);
});

test('the check verb takes its two filters and nothing else', () => {
  const check = decl('check_trade_conflicts');
  assert.deepEqual(validateToolArgs(check, {}), []);
  assert.deepEqual(validateToolArgs(check, { section: 'WE-3', trade: 'screed' }), []);
  assert.equal(validateToolArgs(check, { section: '' }).length > 0, true);
  assert.equal(validateToolArgs(check, { days: 7 }).length > 0, true);
});

test('no tool declares an argument named id', () => {
  // The host passes the timeline under that name, so a declared `id` would not fail — it
  // would send the rule someone else's timeline.
  for (const tool of constructionManifest.tools ?? []) {
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
    assert.equal('id' in props, false, `${tool.name} shadows the timeline id`);
  }
});

test('every tool description says what the rule refuses, not only what it does', () => {
  // It is the only thing a model reads before choosing, so „applies the rule" is not a
  // description. Each of these names its own limit.
  for (const tool of constructionManifest.tools ?? []) {
    assert.ok(/refus|not moved|nothing|cannot|Ranks nothing/i.test(tool.description), `${tool.name}`);
  }
});
