# Self-hosting

Running Zeitlines on your own machine: the two environments a timeline can live
in, what each one can do, and what you have to decide.

Part of the Zeitlines documentation; [`AGENTS.md`](../AGENTS.md) holds the index,
the conventions and the commands. References in „quotes" name a section, with
its file when it lives in another chapter.

## Two environments, one question

A timeline's data lives in one of two places, and everything follows from one
decision: **should people edit timelines in the browser?**

| | Filesystem | Database |
| --- | --- | --- |
| Data in | `data/*.json`, or a folder of Markdown notes | PostgreSQL, yours or a Supabase project |
| Editable in the browser | on the dev server only | yes |
| Edited by | you, in the file: an editor, Git, the MCP server | anyone with access, live |
| Needs | Node.js | Node.js and a database |

**Who serves the API is a variant inside each**, not a third environment. That
distinction used to be the top level here, as three „deployment shapes", and it
mixed the two axes: „Files only" named where the data lived, „Netlify" named who
answered the requests, and the middle one named both. No set of three names for
that ever read as parallel, because they were not three things of one kind.

| Serving it | What that gives you | Start with |
| --- | --- | --- |
| an uploaded build | any static host, nothing to operate, no writes | `npm run build` |
| one Node process | the API from the same process that serves the build | `npm start` |
| a host's functions | no process to keep alive, a built-in sign-in gate | `netlify build` |

A filesystem timeline is read-only in all three, because none of them writes
files: the dev server is the one runtime that does, and it is not a deployment.
That is not a lesser setup.
A roadmap that a team reads and one person maintains in Git is a legitimate one,
and it is the only one with nothing to operate.

## Filesystem

```bash
npm install
npm run build
```

A timeline here is one `*.json` in `data/`, or a folder holding one Markdown note
per item — see „Local sources" (local-sources.md), which also covers pointing the
root at a directory you already own. Drop a `*.json` into `data/`, and the build
registers it as a view and copies it into `dist/`. Upload `dist/` anywhere. No database, no server, no configuration.

The shape of those files is described in [`docs/data-model.md`](data-model.md);
adding `"$schema": "../schema/timeline.schema.json"` at the top gets you
completion and validation in an editor.

## Database

### One command

```bash
docker compose up --build
```

[`docker-compose.yml`](../docker-compose.yml) starts a Postgres and the app,
waits for the database to be *ready* rather than merely running, applies the
migrations and serves on <http://localhost:3120>. `TIMELINES_PUBLISH_PORT`
moves the published port, which matters on a machine that also runs the dev
server — both default to 3120.

It is a starting point, not a production template: the password is the obvious
placeholder and nothing authenticates. See „Access" below before it faces anyone
else.

### Or by hand

```bash
npm install
docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
export TIMELINES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres
npm run db:migrate     # portable runner, no Supabase CLI needed
npm run build
npm start
```

`npm start` ([`scripts/serve.ts`](../scripts/serve.ts)) serves the built `dist/`
and the API from one process. It listens on `127.0.0.1:3120` by default —
`TIMELINES_SERVE_HOST` / `TIMELINES_SERVE_PORT` move it, and binding to
`0.0.0.0` is a decision to make after reading „Access".

**`npm run dev` is not this.** It serves the same API, but through Vite with a
file watcher and no build step. It is for development, and it is also the only
runtime that serves *local* sources editable, because it is the one with a
filesystem behind the request (see [`docs/local-sources.md`](local-sources.md)).

### Migrations are not optional

`npm run dev` refuses to start with migrations pending. `npm start` has no such
check — it is a server, not a workflow — so the container applies them in its
entrypoint before serving, and a failure stops the container rather than serving
against a schema older than the code.

Running by hand, `npm run db:migrate` is yours to remember. `npm run db:check`
answers whether anything is pending.

### Live updates need no setting

A Postgres without Supabase Realtime serves its timelines in polling mode
automatically: the server derives the mode from the configured backend and tells
the client in the `X-Source-Live` header. `TIMELINES_DB_LIVE` overrides it in
either direction. The reasoning is in
[`docs/database.md`](database.md) → „Live-update seam".

## Access

**The server brings no login — until you configure one.** With nothing
configured, anyone who reaches the port can edit, and every write is attributed
to `self-hosted`. That is a legitimate choice for a port only you can reach,
and the server states which mode it is in on every start rather than leaving
you to find out. For a deployment without an identity provider, there is also a
built-in Google sign-in — „A sign-in of its own" below.

For anything else, put an authenticating proxy in front — oauth2-proxy,
Authelia, an SSO ingress — and name the header it sets:

```bash
TIMELINES_TRUSTED_IDENTITY_HEADER=X-Forwarded-Email \
TIMELINES_ALLOWED_EMAIL_DOMAINS=example.com \
npm start
```

Naming the header switches a **gate** on, and this is the part worth
understanding: an `/api/*` request that arrives *without* it is refused with
`401`. Without that, putting SSO in front would protect nothing from anyone who
reaches the origin directly, which is precisely the risk that "we have SSO in
front" hides.

Two carve-outs, both deliberate:

- **`GET /api/public/plugin/<pluginId>/<id>` stays public.** It is public by
  contract (`security: []` in [`openapi.yaml`](../openapi.yaml)) and fetched by
  external pages that have no session. „Public" here means reachable without an
  identity: what is actually served is decided by three gates behind it, and a
  timeline that has not opted in answers 404 like one that does not exist (see
  „Publishing a plugin's data" (docs/plugin-public-read.md)). The retired
  `/api/pricing/<id>` is ungated for the same reason — so a stale consumer gets
  its 410 rather than a login redirect it cannot follow.
- **Static files stay ungated.** The bundle carries no timeline data, so an
  unauthenticated visitor gets a shell whose every request the API refuses, and
  gating assets breaks the redirect dance of some proxies.

The header is only trustworthy if the proxy **strips it from incoming client
requests**. The server cannot verify that, which is why naming it is an explicit
decision rather than a sniff for a well-known name. The policy itself is a pure
function in [`scripts/access.ts`](../scripts/access.ts), covered by tests.

There is no TLS option. A reverse proxy terminates it better than a bespoke
implementation would, and one is already in the picture for the gate.

## A sign-in of its own

The proxy gate assumes you already have an identity provider. When you do not,
the same `npm start` process can be the gate itself:

```bash
AUTH_REQUIRED=true \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
AUTH_SECRET=<random 32+ bytes> \
TIMELINES_ALLOWED_EMAIL_DOMAINS=example.com \
npm start
```

`AUTH_REQUIRED=true` is the same switch the Netlify gate reads, with the same
meaning: this deployment has a sign-in, and everything else about it — the
Google client, the cookie secret — is the same configuration the hosted deploy
carries (see [`docs/deploy.md`](deploy.md)). Google proves the address; a
HMAC-signed `tl_session` cookie (30 days, sliding renewal) proves it on every
later request; nothing about the proxy path above changes.

Admission follows the same policy on both runtimes, and the client cannot tell
them apart: the endpoints are the same (`/auth/login`, `/auth/callback`,
`/auth/logout`, `/auth/error`), the 401 on an expired session is the same, and
the refusal pages say the same sentences.

**Who gets in** is decided exactly as the edge gate decides it, switch for
switch — see [`docs/users.md`](users.md):

- `TIMELINES_ACCESS_CONTROL` off — `TIMELINES_ALLOWED_EMAIL_DOMAINS` decides.
  That is the domain list the proxy gate reads, not a second one: one list, two
  consumers. Empty admits nobody, on purpose.
- on — the member list decides: an invitation is the only way in,
  `TIMELINES_BOOTSTRAP_ADMIN` creates the first admin, and the sign-in is what
  accepts an invitation. The implementation is
  [`scripts/auth/gate.ts`](../scripts/auth/gate.ts), the shared policy lives in
  [`src/access.ts`](../src/access.ts).

The same three carve-outs hold, unchanged: the public plugin read answers
without a session (same `isPublicPath` the proxy gate uses — the two modes
cannot disagree about what is public by contract), the retired pricing route
answers its 410, and static files stay ungated.

Two things to know before you turn it on:

- **One gate, not two.** `AUTH_REQUIRED=true` together with
  `TIMELINES_TRUSTED_IDENTITY_HEADER` is refused at startup: the proxy already
  authenticates, and a login behind it would be decorative at best. Pick one.
- **The redirect URI is the public origin.** The callback is served at
  `/auth/callback` on whatever `Host` the request carries, so the OAuth client
  in Google's console names the address your browsers actually use, and a proxy
  in front must pass the original `Host` through.

Headless clients pass the same gate the same way they pass the Netlify one: an
`X-MCP-Token` header matching `MCP_API_TOKEN` (see [`docs/mcp.md`](mcp.md)). The
token's role comes from `MCP_TOKEN_ROLE`, as everywhere. The same token also
switches the remote MCP endpoint on — `/mcp` as Streamable HTTP, again in
[`docs/mcp.md`](mcp.md) — which carries no session because a login redirect is
not something an MCP client follows.

## What the three runtimes share

A different three from the table above, and worth saying so: those were ways to
serve a deployment, these are the three code paths that implement the API. The
API is served by the Vite dev middleware, the Netlify edge functions and
`npm start`. Routing, optimistic locking, the live-mode header and the error
mapping are **one module**
([`scripts/db/http.ts`](../scripts/db/http.ts)), so the three cannot answer
differently; what each runtime keeps is only what genuinely differs — its
credentials, who the caller is, and whether a filesystem is behind the request.
See „Three runtimes, one HTTP layer" (docs/architecture.md).

That matters when self-hosting because it is what makes the behaviour you read
about in the other chapters — optimistic locking, the `409` on a stale write, the
public plugin read — true here too, rather than approximately true.

## Instances

Nothing about a deployment needs to become a tracked file. An instance is a named
set of values in `~/.config/zeitlines/instances/<name>.env`, selected by one line
in `.env.local`. Data files for an instance live in `data/<name>/`, and every
subdirectory of `data/` is gitignored, so a stray `git add data` cannot pull your
roadmap into the history. The full cascade is in „Instances" (AGENTS.md).

## Netlify

Covered in [`docs/deploy.md`](deploy.md): the edge functions, the built-in Google
OAuth gate, and the environment variables the dashboard carries.
