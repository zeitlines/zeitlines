# MCP server

Reading and writing DB-backed timelines from an agent.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## MCP server (Claude Code)

A stdio MCP server (`scripts/mcp/server.ts`) lets Claude Code read and
manipulate DB-backed timelines. It **always works against the live site**
(`TIMELINES_LIVE_URL`, **required**, with no default; the server aborts with a
clear message if the variable is missing): every read and write goes through
`/api/source(s)` → the `timelines-api` edge function → the DB. That keeps the DB
the single source of truth and makes changes immediately live.

**Only DB-backed timelines** are exposed. File-based sources are read-only on the
live site and therefore not manipulable here.

### Tools

| Tool                | Effect                                                        |
| ------------------- | ------------------------------------------------------------- |
| `list_timelines`    | Lists all DB timelines (id, name, description)                |
| `list_users`        | Lists the linkable users (email, name) for `metadata.owner`   |
| `get_timeline`      | A complete timeline (items + groups) by id                    |
| `add_item`          | Appends an item (required: `start`, `content`)                 |
| `update_item`       | Patches an item (only the given fields; `metadata` is merged, a `null` value removes its key) |
| `delete_item`       | Removes an item by id                                         |
| `add_group`         | Adds a group                                                  |
| `update_group`      | Patches a group, `color` included                             |
| `delete_group`      | Removes a group                                               |
| `set_layout`        | `groupOrder` (`alpha` / `declared`) and the graph's `bandRootGroup` / `referenceGroup` |
| `replace_timeline`  | Replaces a whole timeline (bulk)                              |
| `read_plugin_data`  | The rows one plugin owns on a timeline; one collection or all of them |
| `write_plugin_data` | One row of one collection: `put`, `patch`, `delete` or `move`  |
| `configure_plugin`  | Enables a plugin on a timeline, sets its config, or turns it off |
| `describe_view_dimensions` | The grouping dimensions and filter values a timeline actually offers |
| `list_saved_views`  | The saved views on a timeline this identity may see                     |
| `create_saved_view` | Stores one; `owner` decides whose list it lands in                      |
| `update_saved_view` | Patches one (null clears `mode` / `groupBy` / `filters`)                |
| `delete_saved_view` | Removes one                                                            |

### Saved views: writing one FOR somebody

An **Ansicht** is a named combination of presentation, grouping dimension and filter
selection, stored on the timeline („Gespeicherte Ansichten" (docs/editing.md)). „Set
this person up with the views they need" is what these tools exist for, and it needs
two things the other tools do not have.

**The owner is explicit.** `owner` takes an address from `list_users`, and the row then
belongs to that person: it appears in *their* list rather than in the token's. Writing
somebody else's address needs `write` and is deliberately not restricted to `manage`,
because owning a saved view grants nothing — it is the same kind of statement
`metadata.owner` already makes about an item. Without an `owner` the view belongs to
the calling identity, which for the shared service token is `mcp` and therefore
visible to nobody.

**The vocabulary has to be read, not guessed.** A filter is
`{ "<dimension>": ["<value>"] }`, and neither half is inventable from outside: `cf:tier`
is not a field name anybody would guess, and the status bucket is `Open`, not „open". So
`describe_view_dimensions` reports what one timeline offers, through the very functions
the interface's own „Gruppieren" and „Filter" controls read
([`scripts/mcp/savedViewTools.ts`](../scripts/mcp/savedViewTools.ts)) — an agent is
offered exactly what a person is. A dimension or value that does not exist narrows
nothing rather than failing, which is the same forgiving rule the panel applies when a
custom field is removed, so writing one is a quiet no-op rather than an error.

Both servers carry all five. The remote one resolves the caller before the
dispatcher sees anything („Caller identity on the remote server" below): an
OAuth caller acts as their membership row, a gateway-forwarded identity as that
person's row, the shared service token as `MCP_TOKEN_ROLE`. The verdict is one
object, so the saved-view visibility and the write refusal cannot disagree.

The granular item and group tools run read-modify-write: the local server fetches
the timeline, mutates it in memory and writes it back with a PUT (bulk replace);
the remote one reads it to resolve the patch and then writes the single row.

**Why they read at all, on both servers.** The write underneath replaces a whole
column, and it has to: the viewer sends the complete `metadata` object on every
save and depends on the replace to drop a key the user emptied (see
`CLEARABLE_ITEM_FIELDS` in [`src/persistence.ts`](../src/persistence.ts)). Moving
the merge down into the endpoint would make removing the last tag impossible. So
the *patch* these two tools document is resolved against the current value first,
by one shared rule in [`scripts/mcp/patch.ts`](../scripts/mcp/patch.ts). The
remote `update_item` skipped that step and replaced `metadata` wholesale, which
silently dropped every key the caller had not resent, and `update_group` wrote
through an upsert that nulled an unmentioned `nestedGroups`.

`dependsOn`, `parent` and `owner` live under `metadata`; `owner` carries the
e-mail of a user from `list_users` (see „Item owner" (docs/items.md)), and a
free-text name is stored but renders as unlinked. `parent` is the id of the item
this one is part of, at most one — a self-link, an unknown id or one that would
close a cycle is dropped when the timeline is built, so a tool call that writes
one succeeds and the link simply is not there (see „Parent and children"
(docs/items.md)).

**The three plugin tools name no plugin.** There used to be thirteen tools for
one plugin's entities — `set_pricing`, `add_feature`, `set_tier_value` and the
rest — and that was the clearest form the old privilege took: authoring a
third-party plugin's data would have required editing this server first. What a
collection is called and what a row may contain now comes from the plugin's
manifest and is checked server-side, so the tools carry no schema of their own
(see „The generic store" (docs/plugin-storage.md)). They write one row per call,
straight to its endpoint, with no read-modify-write and no full dump; `ifMatch`
carries the row's lock counter so a concurrent edit answers 409 instead of being
overwritten. Bulk seeding is `replace_timeline` with `pluginData`.

### Auth: service-token bypass

The server attaches an `X-MCP-Token: <MCP_API_TOKEN>` header to every request.
The `timelines-api` edge function lets requests carrying a valid token through
without a Google login (comparing in constant time) and reaches the DB
server-side with the service key. MCP edits are attributed as `mcp` through
`updated_by`.

### Configuration

Server-side (locally, read through the cascade `process.env` → `.env.local` →
`TIMELINES_ENV_FILE`, see „Credential cascade" (docs/database.md)):

| Var                  | Meaning                                                      |
| -------------------- | ------------------------------------------------------------ |
| `MCP_API_TOKEN`      | Bypass token; must match the env var of the same name on the deploy |
| `TIMELINES_LIVE_URL` | Target site (**required**, e.g. `https://<site>.netlify.app`; no default) |

Registering it as a user-global MCP server (usable from any directory):

```bash
claude mcp add -s user timelines -- \
  <repo>/node_modules/.bin/tsx <repo>/scripts/mcp/server.ts
```

(Or directly as an `mcpServers.timelines` entry in `~/.claude.json`.)

### Netlify env (in addition to the Supabase vars)

| Var             | Where              | Notes                                                        |
| --------------- | ------------------ | ------------------------------------------------------------ |
| `MCP_API_TOKEN` | dashboard (secret) | Activates the bypass; identical to the local server's token   |
| `MCP_IDENTITY_HEADER` | dashboard | Name of the header a gateway sets to the caller's e-mail address (e.g. `X-Forwarded-Email`). Unset (the default) keeps the token-only behaviour. |
| `PLUGIN_OPERATOR_EMAILS` | dashboard | Comma-separated addresses that may install or uninstall plugins through the remote server once an identity header names them. |

## Caller identity on the remote server

The remote server authenticates the *transport*: the Netlify function accepts
a per-user OAuth token (minted by `mcp-oauth`, checked against the member list
at sign-in) or the shared `MCP_API_TOKEN`; the self-hosted endpoint accepts the
token only. Authentication answers *who reached the server*; with
`TIMELINES_ACCESS_CONTROL=true` the write tools additionally answer *what this
identity may do*, through the same rules the browser gate uses
([`src/access.ts`](../src/access.ts) — one rule, one place) and the same
resolution module on both runtimes
([`scripts/mcp/caller.ts`](../scripts/mcp/caller.ts)), so the two cannot judge
differently:

- **An OAuth caller** acts as their `app_users` row. An active `editor` or
  `admin` may write; a `viewer`, a suspended member or an address without a
  row may read and is refused on every write.
- **A caller behind a gateway** acts as the address the gateway forwards.
  Operators running zeitlines behind an MCP gateway that authenticates users
  itself name the header it sets with `MCP_IDENTITY_HEADER`; the runtime then
  reads that address *only after* the constant-time Bearer check passed, and
  resolves it against `app_users` exactly like an OAuth caller. The trust model
  is the one `TIMELINES_TRUSTED_IDENTITY_HEADER` documents for self-hosting
  ([„Access"](self-hosting.md)): the header is as trustworthy as the credential
  that travels with it, which here means the token only the gateway holds — a
  proxy in front of the server must strip the header from client requests,
  or whoever sets it impersonates any member.
- **The shared service token alone** (no OAuth claims, no identity header)
  acts as `MCP_TOKEN_ROLE`, default `editor` — the behaviour every existing
  automation already has. An operator wanting a read-only agent sets
  `viewer`, and writes answer with a refusal that names the role.

With the switch off, nothing changes for anyone: the member list decides
nothing, and only the attribution does — an OAuth or gateway identity writes
as their own address rather than the generic `mcp`.

Two deliberate edges:

- **A non-member may still read over MCP** although the browser gate refuses
  them entirely. The remote server's credential is operator-grade either way,
  and the member list is what decides *writes*; a deployment that wants reads
  member-gated too does not hand out the token.
- **Saved views stay exempt from the write gate**, because `read` is their
  capability over HTTP as well: a saved view is display state a viewer keeps
  of their own. The finer rules — seeing only your own unless a view is shared,
  publishing needs `write` — travel on the same `caller` object and are
  enforced by the dispatcher, identically to the browser.

Plugin registry writes (`install_plugin`, `set_plugin_installed`,
`uninstall_plugin`) are operator decisions rather than timeline edits, so an
identity caller needs `PLUGIN_OPERATOR_EMAILS` to reach them — the same list
and the same check as over HTTP. The service token remains operator access,
because it is a server-side secret.

Prerequisites: `TIMELINES_SUPABASE_URL` / `TIMELINES_SUPABASE_SERVICE_KEY` **and**
`AUTH_REQUIRED=true` must be set, or `timelines-api` does not take effect. If
`MCP_API_TOKEN` is unset the bypass is inactive and the site stays gated behind
the Google login for everyone.

### Self-hosted: remote MCP by URL

A self-hosted deployment (`npm start`) can be the target of the stdio server
above — point `TIMELINES_LIVE_URL` at it, and the same `X-MCP-Token` bypass that
the Netlify API honours applies to `scripts/serve.ts` (see „Access" in
(docs/self-hosting.md)).

It can also serve the remote endpoint itself: with `MCP_API_TOKEN` set, `npm
start` exposes `/mcp` as a Streamable HTTP MCP server with the same tool surface
as the Netlify function (the tool registration is shared,
scripts/mcp/remote-server.ts), so colleagues add it as a remote MCP by URL
without a local server or a checkout:

| Var             | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `MCP_API_TOKEN` | Bearer token for `/mcp`; without it the endpoint does not exist |
| `MCP_TOKEN_ROLE` | Role the shared token acts as with `TIMELINES_ACCESS_CONTROL=true`; default `editor`, `viewer` for a read-only agent |
| `MCP_IDENTITY_HEADER` | Name of the header a gateway sets to the caller's e-mail address, as on the function; unset keeps the token-only behaviour |

Authorization is `Bearer <MCP_API_TOKEN>`, nothing else: per-user OAuth tokens
are minted by the Netlify path's `mcp-oauth.ts`, which a self-hosted deployment
does not run. The caller verdict is the function's, resolved by the same module
(„Caller identity on the remote server" above): the token acts as
`MCP_TOKEN_ROLE`, a gateway identity as that person's row, and writes are
refused and attributed accordingly — `MCP_TOKEN_ROLE=viewer` makes the agent
read-only here the same way it does on the function. The endpoint sits outside
the login gate — an MCP client cannot follow a Google redirect — so `/mcp` works
with the gate on or off.

## Agent-facing text is English, all of it

A tool's `title` and `description` are read by a model and have always been
English. The **notes** a tool returns are relayed to a person, so „which language"
became a real question once the interface stopped having one answer (#153). The
rule is English, unconditionally.

One language for the whole tool surface, rather than notes that follow a reader
while the descriptions beside them do not. A model relaying a note can translate
it for whoever it is talking to; it cannot reliably parse a note in a language its
tool surface does not otherwise speak. And a service token has no person behind it
to have a preference, so any other rule would need a second answer for that case
anyway.

This is a decision, not an oversight, and it is the one place in the product where
text deliberately does **not** follow `#settings=account`.
