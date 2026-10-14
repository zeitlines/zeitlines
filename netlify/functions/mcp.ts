// Remote Zeitlines MCP server — Streamable HTTP (Web Standard) on a Netlify
// Function (Node runtime; the MCP SDK uses node: builtins). Exposes the timeline
// tools over HTTP so colleagues add it as a remote MCP by URL — no local server.
//
// Stage 1 auth: Bearer MCP_API_TOKEN (proves the transport). OAuth (per-user
// Google login) is layered on in a later stage — see mcp-oauth.
//
// The tools themselves live in scripts/mcp/remote-server.ts, shared with the
// self-hosted server; this file keeps what is genuinely the function's own —
// the two verifiers (per-user OAuth token, shared service token), the caller
// verdict they resolve to, and the stateless transport.

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import crypto from 'node:crypto';
import type { Config } from '@netlify/functions';
import { getSql } from '../../scripts/db/sql.ts';
import { getServiceClient } from '../../scripts/db/client.ts';
import { resolveRepo, type DbConnections } from '../../scripts/db/api.ts';
import {
  identityFromHeader,
  resolveMcpCaller,
  type McpCallerAccess,
} from '../../scripts/mcp/caller.ts';
import { buildRemoteServer } from '../../scripts/mcp/remote-server.ts';

const ACCESS_TTL = 12 * 3600; // must match mcp-oauth.ts

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Verify an HMAC-signed token minted by mcp-oauth.ts (same AUTH_SECRET, same
// b64url(payload).b64url(sig) format). Returns the payload or null.
function verifySigned(token: string): Record<string, unknown> | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url');
    sig = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
}

// Resolve the caller: a valid per-user OAuth access token → their email; the
// shared MCP_API_TOKEN → "mcp", or the address a gateway forwards when the
// operator named the header (MCP_IDENTITY_HEADER). Null if none match.
function authenticate(req: Request): string | null {
  const presented = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!presented) return null;
  const shared = process.env.MCP_API_TOKEN;
  if (shared && constantTimeEqual(presented, shared)) {
    // The gateway's identity header is read ONLY here, after the constant-time
    // check passed: the header is as trustworthy as the credential that travels
    // with it, which only the gateway holds. A caller with its own OAuth token
    // already carries a proved address, and the header is ignored for it.
    return identityFromHeader(req.headers, process.env.MCP_IDENTITY_HEADER) ?? 'mcp';
  }
  const claims = verifySigned(presented);
  if (claims && claims.typ === 'access' && typeof claims.email === 'string') {
    if (typeof claims.iat === 'number' && Date.now() / 1000 - claims.iat > ACCESS_TTL) return null;
    return claims.email;
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  const identity = authenticate(req);
  if (!identity) {
    // Point the MCP client at our Protected Resource Metadata so it starts the
    // OAuth flow (per-user Google login).
    const origin = new URL(req.url).origin;
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  // Dual-adapter: postgres.js when TIMELINES_DATABASE_URL is set, else supabase-js.
  const conns: DbConnections = { sql: getSql(), supabase: getServiceClient() };

  // The caller's verdict (issue #54): what the tools may do follows the member
  // list when the instance turned the switch on, the configured service role
  // otherwise. A person identity with the switch on but no database configured
  // is the same misconfiguration the HTTP layer names with a 503 — answer it
  // here too rather than failing inside every tool call.
  const repo = resolveRepo(conns);
  if (identity !== 'mcp' && process.env.TIMELINES_ACCESS_CONTROL === 'true' && !repo) {
    return new Response(
      JSON.stringify({
        error: 'access_control_without_database',
        message: 'TIMELINES_ACCESS_CONTROL is on, but no database is configured to hold the member list.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
  let access: McpCallerAccess;
  try {
    access = await resolveMcpCaller({
      identity: identity === 'mcp' ? null : identity,
      accessControlRaw: process.env.TIMELINES_ACCESS_CONTROL,
      tokenRoleRaw: process.env.MCP_TOKEN_ROLE,
      getMember: (email) => repo!.getMember(email),
    });
  } catch (e) {
    // The switch is on and the member list cannot be read: usually pending
    // migrations. Refusing beats passing through — a database that cannot
    // answer "may this caller do this" has not answered yes.
    return new Response(
      JSON.stringify({
        error: 'membership_unavailable',
        message:
          'TIMELINES_ACCESS_CONTROL is on, but the member list could not be read. Apply the pending migrations (npm run db:migrate).',
        detail: e instanceof Error ? e.message : String(e),
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const server = buildRemoteServer(access, conns); // updated_by = person address or "mcp"
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }); // stateless
  await server.connect(transport);
  return transport.handleRequest(req);
}

export const config: Config = { path: '/mcp' };
