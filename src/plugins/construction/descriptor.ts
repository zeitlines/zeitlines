// What this plugin registers with the host: the one object the registry takes.
//
// It lives here rather than in `src/pluginHost/registry.ts` because a core file that
// knows a plugin's availability rule is a plugin with a privilege no third party can
// have. The registry imports a descriptor it does not understand, which is exactly what
// it does for a plugin loaded at runtime.
//
// **No `load()`**, because this plugin has no view. Declaring one would cost a lazily
// loaded chunk that renders nothing.

import type { PluginDescriptor } from '../../pluginHost/api';
import { hasPlugin } from '../../pluginHost/api';
import { constructionManifest } from './manifest';
import { CONSTRUCTION_PLUGIN, constructionDerive, constructionFields } from './fields';
import { constructionTools } from './tools';

export const constructionDescriptor: PluginDescriptor = {
  manifest: constructionManifest,

  // With no view, `matches` and `applies` are the same question and one line answers it:
  // the two only differ when a plugin's view needs enough data to be worth a button, and
  // there is no button here.
  matches: (file) => hasPlugin(file, CONSTRUCTION_PLUGIN),
  applies: (file) => hasPlugin(file, CONSTRUCTION_PLUGIN),

  fields: constructionFields,

  // The value behind `earliestStart`, the one field declared `derived: true`.
  derive: constructionDerive,

  // The domain rules, keyed by the tool name the manifest declares.
  tools: constructionTools,
};
