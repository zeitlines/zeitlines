// A production server for a self-hosted deployment: serves the built `dist/`
// and the API from one Node process.
//
// Why this exists: the `/api/*` layer used to live only in the Vite dev-server
// middleware and in the Netlify edge functions. So anyone self-hosting with
// their own Postgres had no supported way to run an editable deployment — the
// README's quickstart ended at `npm run dev`, which is a development server, not
// something to leave running. Read-only file sources deploy to any static host;
// anything editable was effectively Netlify-only.
//
// It is deliberately thin. The routing, locking and error semantics come from
// `scripts/db/http.ts`, the same module the other two runtimes use, so this file
// only has to do what is genuinely its own: open the DB handles, translate
// between `node:http` and Fetch, and serve static files.
//
// NOT in here, on purpose:
//   - TLS. A reverse proxy does that better than a bespoke option would.
//   - The JIRA proxy and the dev-only config.json override, which belong to the
//     dev server.
//
// Authentication is optional and mounted from `scripts/auth/`: a Google
// sign-in with membership admission (AUTH_REQUIRED=true), or the operator's own
// proxy via TIMELINES_TRUSTED_IDENTITY_HEADER. Off entirely, the server is open
// and says so on every start.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { toRequest, writeResponse } from './node-http.ts';
/**
 * The request handler reuses `isPublicPath` from `admission.ts` when the login
 * gate is on, so the two gates can never disagree about which routes are
 * public by contract.
 */
import { decideAccess, isPublicPath, parseDomains, type AccessConfig } from './admission.ts';
import { gateConfig, handleAuthRequest, type GateConfig } from './auth/gate.ts';
import {
  COOKIE_NAME,
  SESSION_MAX_AGE,
  SESSION_RENEW_THRESHOLD,
  cookieString,
  hasValidMcpToken,
  readSession,
  sign,
  nowSec,
  type SessionPayload,
} from './auth/session.ts';
import { envValue, hydrateProcessEnv } from './db/env.ts';
import { getSql, getSqlForSource } from './db/sql.ts';
import { getServiceClient } from './db/client.ts';
import {
  accessControlEnabled,
  handleApiRequest,
  liveOverride,
  serviceRoleFrom,
  type ApiContext,
} from './db/http.ts';
import type { DbConnections } from './db/api.ts';

hydrateProcessEnv();

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = resolve(envValue('TIMELINES_DIST_DIR') || join(ROOT, 'dist'));
const PORT = Number(envValue('TIMELINES_SERVE_PORT') || envValue('TIMELINES_PORT')) || 3120;
const HOST = envValue('TIMELINES_SERVE_HOST') || '127.0.0.1';

/**
 * The access policy, read once. Naming a header both switches the gate on and
 * says which header carries the identity — a header is only trustworthy if
 * something upstream strips it from client requests, and this process cannot
 * verify that, so it stays an explicit statement by the operator rather than a
 * sniff for a well-known name.
 *
 * The decision itself is in `./admission.ts`, pure and unit-tested.
 */
const ACCESS: AccessConfig = {
  identityHeader: envValue('TIMELINES_TRUSTED_IDENTITY_HEADER')?.toLowerCase() || undefined,
  allowedDomains: parseDomains(envValue('TIMELINES_ALLOWED_EMAIL_DOMAINS')),
};

/**
 * The built-in sign-in gate, off unless AUTH_REQUIRED=true. Same switch, same
 * meaning as the Netlify edge gate. Configured eagerly rather than lazily: a
 * half-configured gate (client id missing, secret missing) has to fail at
 * startup, where the operator reads it, rather than on the first login.
 */
const GATE: GateConfig | null =
  envValue('AUTH_REQUIRED') === 'true' ? gateConfig() : null;

// Two gates at once would mean two different claims about who is trusted. A
// proxy that already authenticates makes the login decorative at best and a lie
 // at worst — the operator must pick one, and the server refuses to guess which.
if (GATE && ACCESS.identityHeader) {
  throw new Error(
    'AUTH_REQUIRED=true and TIMELINES_TRUSTED_IDENTITY_HEADER are both set. ' +
      'Use the built-in sign-in (AUTH_REQUIRED) OR an authenticating proxy ' +
      '(TIMELINES_TRUSTED_IDENTITY_HEADER), not both.',
  );
}

/**
 * Session-gate admission: what the login gate answers instead of the proxy
 * policy. Public paths pass unchanged (same carve-outs), everything else needs a
 * valid session, and the refusal is the same machine-readable 401 the Netlify
 * gate sends — the client sends the top window to the login on exactly that.
 */
async function sessionGate(
  req: Request,
  pathname: string,
): Promise<SessionPayload | null | Response> {
  // Public by contract, same list the proxy gate uses (`isPublicPath`), so the
  // two admission modes can never disagree about what stays reachable.
  if (isPublicPath(pathname)) return null;
  const session = await readSession(req);
  if (session) return session;
  // A fetch() from the loaded SPA can't follow a 302 to Google's login across
  // origins — the redirect just produces a diffuse failure and the edit
  // silently vanishes. Answer with a machine-readable 401 so the client can
  // surface „session expired" and send the top window to the login
  // (`src/editor.ts`). Same body, same status, same header as the edge gate.
  return new Response(JSON.stringify({ error: 'session_expired' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // Let the client find the login without hardcoding the path.
      'WWW-Authenticate': 'Session',
    },
  });
}

function identityOf(req: IncomingMessage): string | undefined {
  if (!ACCESS.identityHeader) return undefined;
  const raw = req.headers[ACCESS.identityHeader];
  return Array.isArray(raw) ? raw[0] : raw;
}

const dbConns = (): DbConnections => ({
  sql: getSql(),
  supabase: getServiceClient(),
  sqlFor: getSqlForSource,
  // No `local`: this process serves a *built* site, where local sources were
  // already materialised into static JSON by `build:data` and are read-only —
  // the same answer a static deploy gives (see docs/local-sources.md).
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a URL path to a file inside `dist/`, or null if it escapes.
 *
 * The containment check compares the *resolved* path, which is what catches the
 * encodings a character blocklist misses — the same reasoning as the guard in
 * `scripts/local/file-repo.ts`.
 */
function resolveStatic(pathname: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return null;
    }
  })();
  if (decoded == null || decoded.includes('\0')) return null;
  const candidate = resolve(join(DIST, normalize(decoded)));
  if (candidate !== DIST && !candidate.startsWith(DIST + sep)) return null;
  return candidate;
}

async function sendFile(res: ServerResponse, file: string, status = 200): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    res.writeHead(status, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      // The entry document must never be cached: it names the hashed asset files,
      // so a stale copy pins a browser to a previous deploy. Hashed assets under
      // /assets/ can be cached hard for the same reason.
      'Cache-Control': file.endsWith('.html')
        ? 'no-cache'
        : file.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (url.pathname.startsWith('/api/')) {
        const fetchReq = await toRequest(req);

        // The MCP service token authenticates a program: it passes either gate
        // without a session or a proxy, exactly as it passes the Netlify gate,
        // because there is no membership row behind it — its role is configured
        // (`MCP_TOKEN_ROLE`) rather than looked up.
        const mcp = hasValidMcpToken(fetchReq);

        // Two admission modes, configured once at startup: the login gate
        // (session cookie proves the identity) or the proxy policy (trusted
        // header does). They answer with the same shape — a caller or a refusal
        // — so everything below stays mode-agnostic.
        let email: string | undefined;
        let name: string | undefined;
        let renewal: string | undefined;
        if (mcp) {
          // no caller identity: a program, attributed as `mcp`
        } else if (GATE) {
          const outcome = await sessionGate(fetchReq, url.pathname);
          if (outcome instanceof Response) return void (await writeResponse(res, outcome));
          if (outcome) {
            email = outcome.email;
            name = outcome.name ?? undefined;
            // Sliding renewal: once the session is in the second half of its
            // life, re-issue the cookie with a fresh expiry on the way out. An
            // actively used session is therefore continually topped up and
            // never expires from under the user. Off the hot path — most
            // requests skip straight to the handler.
            if (outcome.exp - nowSec() < SESSION_RENEW_THRESHOLD) {
              renewal = cookieString(
                COOKIE_NAME,
                sign({ ...outcome, exp: nowSec() + SESSION_MAX_AGE }),
                SESSION_MAX_AGE,
              );
            }
          }
        } else {
          const access = decideAccess(url.pathname, identityOf(req), ACCESS);
          if (!access.allow) {
            res.writeHead(access.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return void res.end(JSON.stringify({ error: access.error, detail: access.detail }));
          }
          email = access.email;
        }
        const ctx: ApiContext = {
          conns: dbConns(),
          caller: email ? { email, name } : undefined,
          // Attribution: the service token has no person behind it (a program,
          // attributed as `mcp`, its role from MCP_TOKEN_ROLE — docs/users.md →
          // „Non-human callers"); a gated caller by their address; and without
          // a gate there is no identity to attribute to, and inventing one per
          // request would make the audit panel lie. One honest label for "this
          // deployment does not know who edits".
          updatedBy: mcp ? 'mcp' : (email ?? 'self-hosted'),
          // Admission (above) asked whether a trusted identity is present at
          // all; this asks what that identity may do. Both are opt-in, and
          // turning this on without either gate refuses everything, which is
          // the honest outcome of asking for roles without a caller.
          accessControl: accessControlEnabled(envValue('TIMELINES_ACCESS_CONTROL')),
          live: liveOverride(envValue('TIMELINES_DB_LIVE')),
          serviceToken: mcp || undefined,
          serviceRole: mcp ? serviceRoleFrom(envValue('MCP_TOKEN_ROLE')) : undefined,
          // The whole cascade, not `process.env`: a self-hosted instance keeps
          // its values in an instance profile or a credential file, and reading
          // only the process environment would report „not set" for settings the
          // very same server is using.
          env: envValue,
        };
        const out = await handleApiRequest(fetchReq, ctx);
        if (out) {
          if (renewal) out.headers.append('Set-Cookie', renewal);
          return void (await writeResponse(res, out));
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ error: 'not found' }));
      }

      // The login endpoints exist only when the gate is on; with it off, /auth/*
      // falls through to static serving and answers 404 like any unknown path,
      // which keeps "the gate is disabled" from looking like "the login is broken".
      if (GATE && url.pathname.startsWith('/auth/')) {
        // The member lookup on the callback uses the same handle the dispatcher
        // will use, so a sign-in and the very next request cannot disagree
        // about who is a member.
        const out = await handleAuthRequest(await toRequest(req), url, GATE, dbConns().sql ?? null);
        if (out) return void (await writeResponse(res, out));
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return void res.end('not found');
      }

      // Static files are served ungated on purpose, even with the gate on. The
      // built bundle carries no timeline data — every read goes through the API,
      // which just refused — so all an ungated visitor gets is an empty shell
      // that immediately errors. Gating it would also break the redirect dance
      // of some proxies, which fetch assets before a session exists.
      const file = resolveStatic(url.pathname);
      if (!file) {
        res.writeHead(400);
        return void res.end('bad request');
      }
      if (await sendFile(res, file)) return;
      // A directory URL, then the SPA fallback: the viewer keeps its state in the
      // hash, but a deep link to a sub-path must still boot the app rather than
      // 404 (and a real missing asset shows up as a failed fetch, not as HTML,
      // because only non-file paths get here).
      if (await sendFile(res, join(file, 'index.html'))) return;
      if (await sendFile(res, join(DIST, 'index.html'))) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (err) {
      console.error('[serve]', err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error' }));
    }
  })();
});

server.listen(PORT, HOST, () => {
  const conns = dbConns();
  console.log(`[serve] http://${HOST}:${PORT} — serving ${DIST}`);
  console.log(
    conns.sql
      ? '[serve] database: postgres.js (TIMELINES_DATABASE_URL)'
      : conns.supabase
        ? '[serve] database: supabase-js (TIMELINES_SUPABASE_URL)'
        : '[serve] database: none configured — DB timelines will fail loudly, static sources still serve',
  );
  // Said every time on purpose. An unauthenticated editable deployment is a
  // decision, and it should not be one somebody makes by not reading a document.
  if (GATE) {
    console.log(
      `[serve] access: sign-in gate on — Google login at /auth/login, admission by ${
        GATE.accessControl ? 'the member list (TIMELINES_ACCESS_CONTROL)' : 'TIMELINES_ALLOWED_EMAIL_DOMAINS'
      }`,
    );
  } else if (ACCESS.identityHeader) {
    const domains = ACCESS.allowedDomains?.length ? ACCESS.allowedDomains.join(', ') : 'any';
    console.log(
      `[serve] access: gated on ${ACCESS.identityHeader} (domains: ${domains}) — your proxy MUST strip that header from client requests`,
    );
  } else {
    console.log(
      '[serve] access: OPEN — every visitor can edit, and every edit is attributed to "self-hosted".',
    );
    console.log(
      '[serve]         Set TIMELINES_TRUSTED_IDENTITY_HEADER behind an authenticating proxy, or keep this port private.',
    );
  }
});
