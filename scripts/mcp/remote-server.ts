// The remote MCP server's tools, shared by every runtime that serves them over
// HTTP — the Netlify function (netlify/functions/mcp.ts) and the self-hosted
// server (scripts/serve.ts → scripts/mcp/remote-http.ts).
//
// Everything here is the tool surface: the schemas, the read-modify-write
// patches, the dispatch into the shared dispatcher (scripts/db/api.ts). What is
// deliberately NOT here is the authentication, because the two runtimes prove
// the caller differently: the Netlify function accepts a per-user OAuth access
// token beside the shared service token (mcp-oauth.ts mints it), the
// self-hosted server accepts the service token only. Two transports, two
// verifiers, one tool registration — the alternative was a second copy of ~400
// lines of schemas that fixes a bug on one runtime and not the other.
//
// What the tools DO share is the verdict: both runtimes resolve their caller to
// the same `McpCallerAccess` (scripts/mcp/caller.ts) and hand it in here, so a
// write is allowed or refused for the same reason on either runtime — the
// function composes it from an OAuth e-mail or a gateway header, the Node
// server from the service token's configured role, but the gate below is one.
//
// Stateless by design: a fresh server per request, nothing shared between
// invocations. The Netlify function requires that; the Node server keeps it
// because MCP session state on a long-lived process buys nothing the DB does
// not already hold.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveAdapter, resolveRepo, type DbConnections, type ApiRequest } from '../db/api.ts';
import { MOVE_SEGMENT, handlePluginsApi, type PluginsApiRequest } from '../db/plugin-api.ts';
import { parseOperators } from '../db/operator.ts';
import { resolveGroupPatch, resolveItemPatch, type ItemPatch } from './patch.ts';
import { NO_BUCKET, SAVED_VIEW_HELP, savedViewDimensions } from './savedViewTools.ts';
import { savedViewCallerOf, writeRefusal, type McpCallerAccess } from './caller.ts';
import type { TimelineGroupDecl } from '../db/timeline-repo.ts';
import type { TimelineFileItem } from '../../src/types.ts';

/**
 * A fresh server with every tool registered, running its calls through the
 * shared dispatcher against `conns`. `access` is the caller the transport
 * resolved (see `scripts/mcp/caller.ts`): the tools reach the dispatcher
 * directly, so the membership verdict has to travel in with the request —
 * the write gate below is where it is enforced.
 */
export function buildRemoteServer(access: McpCallerAccess, conns: DbConnections): McpServer {
  const server = new McpServer({ name: 'timelines', version: '1.0.0' });

  const run = async (req: Omit<ApiRequest, 'updatedBy' | 'caller'>) => {
    if (!resolveRepo(conns)) {
      throw new Error(
        'Database not configured on the server (TIMELINES_DATABASE_URL, or TIMELINES_SUPABASE_URL + TIMELINES_SUPABASE_SERVICE_KEY).',
      );
    }
    // Write gate: reads and saved views pass (their HTTP capability is `read`),
    // every other write needs the caller's active write role. /mcp is one
    // transport endpoint, so the dispatcher's 403 surfaces as a tool error
    // carrying the dispatcher's message.
    const refusal = writeRefusal(req, access);
    if (refusal) throw new Error(`forbidden: ${refusal}`);
    const fullReq = {
      ...req,
      updatedBy: access.updatedBy,
      caller: savedViewCallerOf(access),
    } as ApiRequest;
    const result = await resolveAdapter(conns, fullReq.id).handle(fullReq);
    if (result.status >= 400) {
      const msg = (result.json as { error?: string; message?: string });
      throw new Error(msg.message || msg.error || `error ${result.status}`);
    }
    return result.json;
  };
  // The instance registry is not timeline-scoped, so it does not go through
  // `resolveAdapter` (which resolves a source). Its writes are operator
  // decisions: a caller the gateway identified needs PLUGIN_OPERATOR_EMAILS to
  // reach them, decided by the same `isOperator` the HTTP route uses. The
  // service token stays operator access — it is a server-side secret.
  const runPlugins = async (req: Omit<PluginsApiRequest, 'caller' | 'operators'>) => {
    const repo = resolveRepo(conns);
    if (!repo) throw new Error('Database not configured on the server.');
    const result = await handlePluginsApi(repo, {
      ...req,
      caller: access.email ? { email: access.email } : { mcp: true },
      operators: parseOperators(process.env.PLUGIN_OPERATOR_EMAILS),
    });
    if (result.status >= 400) {
      const msg = (result.json as { error?: string; message?: string });
      throw new Error(msg.message || msg.error || `error ${result.status}`);
    }
    return result.json;
  };

  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

  server.tool('list_timelines', 'List all DB-backed timelines (id, name, description).', {}, async () =>
    ok(await run({ method: 'GET', id: '' })),
  );
  server.tool('get_timeline', 'Get a full timeline (items + groups + phases) by id.', { id: z.string() }, async ({ id }) =>
    ok(await run({ method: 'GET', id })),
  );
  server.tool(
    'add_item',
    'Append an item to a timeline. Requires start and content.',
    { id: z.string(), item: z.record(z.any()) },
    async ({ id, item }) => ok(await run({ method: 'POST', id, sub: { kind: 'item' }, body: item })),
  );
  server.tool(
    'update_item',
    'Patch an item (only provided fields change; metadata is shallow-merged onto what the item ' +
      'already carries). Give a metadata key the value null to remove it, or metadata: null to clear ' +
      'the whole object.',
    { id: z.string(), itemId: z.string(), patch: z.record(z.any()) },
    async ({ id, itemId, patch }) => {
      // The endpoint replaces the metadata column, so the merge this tool
      // documents has to happen here, against the item's current value — see the
      // header of scripts/mcp/patch.ts for why it cannot move server-side. That
      // costs a read, and only on a patch that actually names metadata.
      let body = patch as Record<string, unknown>;
      if ('metadata' in patch) {
        const file = (await run({ method: 'GET', id })) as { items?: TimelineFileItem[] };
        const current = (file.items ?? []).find((i) => i.id === itemId);
        if (!current) throw new Error(`Item "${itemId}" not found in "${id}".`);
        body = resolveItemPatch(current, patch as ItemPatch) as Record<string, unknown>;
      }
      return ok(await run({ method: 'PATCH', id, sub: { kind: 'item', childId: itemId }, body }));
    },
  );
  server.tool('delete_item', 'Delete an item by id.', { id: z.string(), itemId: z.string() }, async ({ id, itemId }) =>
    ok(await run({ method: 'DELETE', id, sub: { kind: 'item', childId: itemId } })),
  );
  server.tool('add_group', 'Add or update a group.', { id: z.string(), group: z.record(z.any()) }, async ({ id, group }) =>
    ok(await run({ method: 'POST', id, sub: { kind: 'group' }, body: group })),
  );
  server.tool(
    'update_group',
    'Patch a group by id (only provided fields change; fields left out keep their value).',
    { id: z.string(), group: z.record(z.any()) },
    async ({ id, group }) => {
      // Groups are written through an upsert, which rewrites content,
      // nestedGroups and showNested from the body alone — so patching just
      // `content` used to drop a group's nesting. Fold the patch onto the current
      // group first so the upsert carries the untouched fields along.
      const groupId = (group as TimelineGroupDecl).id;
      if (!groupId) throw new Error('group needs id');
      const file = (await run({ method: 'GET', id })) as { groups?: TimelineGroupDecl[] };
      const current = (file.groups ?? []).find((g) => g.id === groupId);
      if (!current) throw new Error(`Group "${groupId}" not found in "${id}".`);
      const body = resolveGroupPatch(current, group as Partial<TimelineGroupDecl>);
      return ok(await run({ method: 'PATCH', id, sub: { kind: 'group' }, body }));
    },
  );
  server.tool('delete_group', 'Delete a group by id.', { id: z.string(), groupId: z.string() }, async ({ id, groupId }) =>
    ok(await run({ method: 'DELETE', id, sub: { kind: 'group', childId: groupId } })),
  );
  // ---- saved views --------------------------------------------------------
  //
  // The same four tools the stdio server carries, against the dispatcher rather
  // than over HTTP. `owner` is what makes „set this person up with the views they
  // need" possible: the row belongs to them, not to whoever holds the token. It
  // grants nothing — a saved view decides whose list it appears in and nothing
  // else — which is why writing another address here is ordinary.

  const savedViewFields = {
    name: z.string().optional().describe('What the view is called. Required when creating one.'),
    mode: z
      .string()
      .optional()
      .describe('Presentation: "timeline", "list" or "plugin:<pluginId>:<viewId>". Absent leaves it alone.'),
    groupBy: z.string().optional().describe('Grouping dimension, e.g. "status" or "cf:tier".'),
    filters: z
      .record(z.array(z.string()))
      .optional()
      .describe('Selected values per dimension. AND across dimensions, OR within one.'),
    owner: z.string().optional().describe('E-mail of the person this view is for; defaults to the caller.'),
    visibility: z.enum(['private', 'instance']).optional().describe('"instance" shares it with every member.'),
  };

  server.tool(
    'describe_view_dimensions',
    'The grouping dimensions and filter values a timeline offers, as `groupBy` keys and `filters` ' +
      `values for the saved-view tools. The value "${NO_BUCKET}" is the "Ohne …" bucket.`,
    { id: z.string() },
    async ({ id }) => ok({ id, dimensions: savedViewDimensions((await run({ method: 'GET', id })) as never) }),
  );
  server.tool(
    'list_saved_views',
    `The saved views on a timeline that this identity may see. ${SAVED_VIEW_HELP}`,
    { id: z.string() },
    async ({ id }) => ok(await run({ method: 'GET', id, sub: { kind: 'saved-view' } })),
  );
  server.tool(
    'create_saved_view',
    `Store a new saved view on a timeline. ${SAVED_VIEW_HELP}`,
    { id: z.string(), ...savedViewFields },
    async ({ id, ...view }) => ok(await run({ method: 'POST', id, sub: { kind: 'saved-view' }, body: view })),
  );
  server.tool(
    'update_saved_view',
    'Patch one saved view: only the fields given change, and null clears `mode`, `groupBy` or ' +
      '`filters`. The id is fixed, because links carry it as `sv=<id>`.',
    { id: z.string(), viewId: z.string(), ...savedViewFields },
    async ({ id, viewId, ...patch }) =>
      ok(await run({ method: 'PATCH', id, sub: { kind: 'saved-view', childId: viewId }, body: patch })),
  );
  server.tool(
    'delete_saved_view',
    'Remove a saved view. A shared one disappears for everybody.',
    { id: z.string(), viewId: z.string() },
    async ({ id, viewId }) =>
      ok(await run({ method: 'DELETE', id, sub: { kind: 'saved-view', childId: viewId } })),
  );

  server.tool(
    'replace_timeline',
    'Replace a whole timeline (bulk). Body is the full { items, groups, phases } object.',
    { id: z.string(), file: z.record(z.any()) },
    async ({ id, file }) => ok(await run({ method: 'PUT', id, body: file })),
  );
  // No set_pricing/add_feature/set_tier_value/… here: the pricing sub-resources
  // were retired with their route (#460), and those thirteen tools had been
  // answering "unknown sub-resource" ever since — the Netlify function is not
  // typechecked, so nothing flagged them. A pricing model is plugin data now,
  // written through plugin_data_* like any other plugin's rows. And no dedicated
  // version tools either: a plugin's version list is ordinary plugin CONFIG, set
  // through the generic `enable_plugin` (PUT config), the same route every
  // plugin's config uses. Keeping plugin specifics out of the MCP core is what
  // `check-plugin-isolation` enforces: a built-in plugin gets no tool a
  // third-party one could not. See the plugin's own README for the recipe.

  // ---- plugin lifecycle ----------------------------------------------------
  //
  // Two levels, and the tools keep them apart because conflating them is how a
  // plugin gets uninstalled when somebody meant to switch it off on one timeline.
  // `enable_plugin` / `disable_plugin` are per timeline and reversible;
  // `install_plugin` / `uninstall_plugin` are instance-wide and operator-only —
  // the MCP token is operator access, which is why they are reachable here at all.

  server.tool(
    'list_plugins',
    'List the plugins this instance has installed, with the host\'s verdict on each: whether it can be ' +
      'loaded, and if not, why (switched off, or a contract version this host does not satisfy).',
    {},
    async () => ok(await runPlugins({ method: 'GET' })),
  );
  server.tool(
    'enable_plugin',
    'Enable one plugin on ONE timeline, or replace its config. The plugin must already be installed on ' +
      'the instance. Config is validated against the plugin\'s declared configSchema, so a bad key fails ' +
      'here rather than inside a render. This does not touch other timelines.',
    { id: z.string(), pluginId: z.string(), config: z.record(z.any()).optional() },
    async ({ id, pluginId, config }) =>
      ok(await run({ method: 'PUT', id, sub: { kind: 'plugin', plugin: { pluginId } }, body: { config: config ?? {} } })),
  );
  server.tool(
    'disable_plugin',
    'Disable one plugin on ONE timeline. Everything it stored is KEPT, so enabling it again is lossless. ' +
      'To remove a plugin from the whole instance use uninstall_plugin.',
    { id: z.string(), pluginId: z.string() },
    async ({ id, pluginId }) =>
      ok(await run({ method: 'DELETE', id, sub: { kind: 'plugin', plugin: { pluginId } } })),
  );
  server.tool(
    'install_plugin',
    'Install a plugin on the INSTANCE, making it available to enable on timelines. Takes the plugin\'s ' +
      'manifest, which is validated against this host\'s contract version before anything is stored. ' +
      'artifact describes where the code comes from ({ kind: "builtin" | "url" | "package" | "vendored", ' +
      'source?, integrity? }); a url artifact must carry an integrity hash. capabilities is what you GRANT ' +
      'it — omit to grant exactly what the manifest declares.',
    {
      manifest: z.record(z.any()),
      artifact: z.record(z.any()).optional(),
      capabilities: z.array(z.string()).optional(),
    },
    async ({ manifest, artifact, capabilities }) =>
      ok(await runPlugins({ method: 'POST', body: { manifest, artifact, capabilities } })),
  );
  server.tool(
    'set_plugin_installed',
    'Switch a plugin on or off for the WHOLE instance without uninstalling it. Off means its code stops ' +
      'loading everywhere and its data becomes read-only; nothing is discarded.',
    { pluginId: z.string(), enabled: z.boolean() },
    async ({ pluginId, enabled }) => ok(await runPlugins({ method: 'PATCH', pluginId, body: { enabled } })),
  );
  server.tool(
    'uninstall_plugin',
    'Remove a plugin from the instance. Destructive and guarded: repeat the plugin id as `confirm`. ' +
      'purgeData defaults to false, which KEEPS every row the plugin owned so a reinstall finds them; ' +
      'passing true also deletes those rows and strips the item metadata keys the plugin declared, and ' +
      'that cannot be undone.',
    { pluginId: z.string(), confirm: z.string(), purgeData: z.boolean().optional() },
    async ({ pluginId, confirm, purgeData }) =>
      ok(
        await runPlugins({
          method: 'DELETE',
          pluginId,
          params: { confirm, purgeData: purgeData ? 'true' : 'false' },
        }),
      ),
  );

  // ---- plugin-owned rows: two tools for every plugin ----------------------
  //
  // Two generic tools, not two per plugin. The thirteen pricing tools below are
  // what one plugin costs when the surface is per plugin, and a plugin installed
  // at runtime could not add tools to a compiled server at all. What a caller may
  // write is not decided here: the dispatcher checks it against the plugin's
  // manifest, so an unknown plugin, an undeclared collection or a row that fails
  // its schema is refused the same way it is over HTTP.

  server.tool(
    'plugin_data_list',
    'List the rows a plugin stores on a timeline, in the collection\'s own order. ' +
      'Collections are declared in the plugin\'s manifest (product-roadmap: features, tiers, ' +
      'tier-values, highlights). Each row is { id, data, version } — send `version` back as ' +
      'expectedVersion when writing.',
    { id: z.string(), pluginId: z.string(), collection: z.string() },
    async ({ id, pluginId, collection }) =>
      ok(await run({ method: 'GET', id, sub: { kind: 'plugin', plugin: { pluginId, collection } } })),
  );
  server.tool(
    'plugin_data_write',
    'Write one row of a plugin collection. op="put" creates or replaces `data` wholesale; ' +
      'op="patch" merges into it (a null value removes that key); op="delete" removes the row ' +
      'and cascades to rows referencing it; op="move" repositions it in an ordered collection ' +
      '(pass after or before instead of data). rowId is required for patch, delete and move; ' +
      'for put it is derived from the key fields when the collection has them. Pass ' +
      'expectedVersion to make the write conditional — it fails rather than overwriting a ' +
      'change you did not see.',
    {
      id: z.string(),
      pluginId: z.string(),
      collection: z.string(),
      op: z.enum(['put', 'patch', 'delete', 'move']),
      rowId: z.string().optional(),
      data: z.record(z.any()).optional(),
      after: z.string().optional(),
      before: z.string().optional(),
      expectedVersion: z.number().optional(),
    },
    async ({ id, pluginId, collection, op, rowId, data, after, before, expectedVersion }) => {
      const plugin = { pluginId, collection, rowId };
      if (op === 'move') {
        if (!rowId) throw new Error('move needs rowId');
        return ok(
          await run({
            method: 'POST',
            id,
            sub: { kind: 'plugin', plugin: { pluginId, collection, rowId: MOVE_SEGMENT } },
            body: { id: rowId, after, before },
          }),
        );
      }
      if (op === 'delete') {
        if (!rowId) throw new Error('delete needs rowId');
        return ok(await run({ method: 'DELETE', id, sub: { kind: 'plugin', plugin } }));
      }
      if (!data) throw new Error(`${op} needs data`);
      if (op === 'patch') {
        if (!rowId) throw new Error('patch needs rowId');
        return ok(
          await run({ method: 'PATCH', id, sub: { kind: 'plugin', plugin }, body: { data }, ifMatch: expectedVersion }),
        );
      }
      return ok(
        await run({
          method: 'POST',
          id,
          sub: { kind: 'plugin', plugin: { pluginId, collection } },
          body: { id: rowId, data },
          ifMatch: expectedVersion,
        }),
      );
    },
  );

  return server;
}
