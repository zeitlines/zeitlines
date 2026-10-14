// The remote MCP endpoint for `npm start` — the self-hosted twin of the Netlify
// function (netlify/functions/mcp.ts).
//
// Same tools (shared registration in remote-server.ts), same transport
// (Streamable HTTP, stateless), same caller model: the service token acts as
// MCP_TOKEN_ROLE, the address a gateway forwards under MCP_IDENTITY_HEADER acts
// as its member row — both resolved by the same `resolveMcpCaller` the function
// uses, so the two runtimes issue the same verdict from the same source. The
// one difference is per-user OAuth tokens, minted by mcp-oauth.ts, which lives
// on the Netlify path; a self-hosted deployment that wants per-user MCP can add
// it by following that file, and nothing about the tools would change.
//
// Bearer only, no session: an MCP client cannot follow a Google login redirect,
// which is also why the gate's session check never sees /mcp (serve.ts mounts
// this outside /api/ and before the static fallback).

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildRemoteServer } from './remote-server.ts';
import { getSql } from '../db/sql.ts';
import { getServiceClient } from '../db/client.ts';
import { resolveRepo, type DbConnections } from '../db/api.ts';
import { identityFromHeader, resolveMcpCaller, type McpCallerAccess } from './caller.ts';

/**
 * Does the presented bearer match the configured token? Pure, so the refusal
 * and admission cases are testable without a transport. `configured` null (the
 * variable unset) means the endpoint does not exist, which the caller checks
 * separately — an unset token must not admit an empty header.
 */
export function bearerMatches(presented: string | null | undefined, configured: string | null): boolean {
  if (!configured || !presented) return false;
  const ab = Buffer.from(presented);
  const bb = Buffer.from(configured);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Node's IncomingMessage.headers is a lowercased plain object rather than the
// Web-standard Headers the function side sees; adapt it so
// `identityFromHeader` needs no duplicate here. A repeated header joins as one
// comma-separated string in Node, which fails `addressShaped` — one header, one
// address, same as the function's Headers.get() returns for it.
function headerGet(req: IncomingMessage): (name: string) => string | null {
  return (name) => {
    const value = req.headers[name.trim().toLowerCase()];
    return typeof value === 'string' ? value : (value?.[0] ?? null);
  };
}

/**
 * Serve one MCP request from the Node server. The token comes in from the
 * caller (the whole env cascade on serve.ts, `process.env` on a bare import)
 * rather than being read here, so an instance profile is respected the same way
 * it is on the API paths. Answers 401 itself when it does not match, so the
 * caller can hand every /mcp request to this one function.
 *
 * The caller resolution mirrors the Netlify function handler: the same
 * `resolveMcpCaller`, the same 503s for a switch-on without a database or an
 * unreadable member list, the same verdict handed to the shared tool
 * registration. The env it reads beside the token is the same cascade — serve.ts
 * hydrates `process.env` — so both runtimes judge from the same source.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  configuredToken: string | null,
): Promise<void> {
  const auth = req.headers.authorization ?? '';
  const presented = auth.replace(/^Bearer\s+/i, '').trim() || null;
  if (!bearerMatches(presented, configuredToken)) {
    // Same shape the Netlify function answers with, minus the
    // resource-metadata pointer: there is no OAuth flow to start here.
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  // The gateway's identity header is read ONLY here, after the constant-time
  // check passed: the header is as trustworthy as the credential that travels
  // with it, which only the gateway holds — same trust model as the Netlify
  // function and as TIMELINES_TRUSTED_IDENTITY_HEADER: a proxy in front must
  // strip the header from client requests, or whoever sets it speaks for any
  // member. Unset (the default), the token acts as the service identity alone.
  const identity = identityFromHeader({ get: headerGet(req) }, process.env.MCP_IDENTITY_HEADER);

  // Dual-adapter: postgres.js when TIMELINES_DATABASE_URL is set, else supabase-js.
  const conns: DbConnections = { sql: getSql(), supabase: getServiceClient() };

  // The same misconfiguration the function (and the HTTP layer) name with a
  // 503: a person identity, the switch on, and no database to hold the member
  // list. The service identity does not need one to resolve — its role is
  // configuration, not a row.
  const repo = resolveRepo(conns);
  const accessControlRaw = process.env.TIMELINES_ACCESS_CONTROL;
  if (identity && accessControlRaw === 'true' && !repo) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'access_control_without_database',
        message: 'TIMELINES_ACCESS_CONTROL is on, but no database is configured to hold the member list.',
      }),
    );
    return;
  }
  let access: McpCallerAccess;
  try {
    access = await resolveMcpCaller({
      identity,
      accessControlRaw,
      tokenRoleRaw: process.env.MCP_TOKEN_ROLE,
      getMember: (email) => repo!.getMember(email),
    });
  } catch (e) {
    // The switch is on and the member list cannot be read: usually pending
    // migrations. Refusing beats passing through — a database that cannot
    // answer "may this caller do this" has not answered yes.
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'membership_unavailable',
        message:
          'TIMELINES_ACCESS_CONTROL is on, but the member list could not be read. Apply the pending migrations (npm run db:migrate).',
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    return;
  }

  // Stateless by design, like the function: a fresh server per request, no
  // session state on a long-lived process. The DB is the source of truth; MCP
  // session state would be a second one.
  const server = buildRemoteServer(access, conns);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
