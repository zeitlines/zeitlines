// Session cookies for the self-hosted sign-in gate (`scripts/serve.ts`).
//
// A Node port of `netlify/edge-functions/_shared/session.ts`, deliberately
// parallel rather than shared: the edge variant reads `Deno.env` at call sites
// and imports nothing from `scripts/`, and unifying the two would mean editing
// the Netlify path — which a self-hosting feature has no reason to touch. The
// *policy* is shared where it counts (`src/access.ts` decides what a sign-in
// means; this module only proves who is asking), and the wire format is
// identical, so a deployment that copies its `AUTH_SECRET` from Netlify keeps
// its sessions.
//
// Same cookie, same shape, same refusal behaviour as the edge gate:
//   tl_session     — HMAC-SHA256-signed JSON payload, 30 days, sliding renewal
//   tl_oauth_state — short-lived OAuth state carrying the post-login redirect

import { createHmac, timingSafeEqual } from 'node:crypto';
import { accessControlEnabled } from '../../src/access.ts';
import { envValue } from '../db/env.ts';
import { parseDomains } from '../admission.ts';

export const COOKIE_NAME = 'tl_session';
export const STATE_COOKIE = 'tl_oauth_state';
// Base session lifetime. The gate re-issues the cookie with a fresh expiry once
// a request lands in the second half of this window (see serve.ts → sliding
// renewal), so an actively used session effectively never expires. The 30-day
// base only bites after a genuine stretch of inactivity.
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30d
export const SESSION_RENEW_THRESHOLD = SESSION_MAX_AGE / 2;
export const STATE_MAX_AGE = 10 * 60; // 10m

export type SessionPayload = {
  email: string;
  sub: string;
  name?: string;
  exp: number;
};

export type StatePayload = {
  state: string;
  redirect: string;
  exp: number;
};

// ---------- sign / verify ----------
//
// `payloadB64url.sigB64url` — JWT-style but hand-rolled, because pulling in a
// JWT library for three fields is a dependency for nothing. Node's `createHmac`
// rather than WebCrypto: this module never runs in a browser or on the edge, so
// the Buffer round-trip is the shorter path.

function secret(): string {
  const s = envValue('AUTH_SECRET');
  if (!s) throw new Error('Missing env var: AUTH_SECRET');
  return s;
}

export function sign(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = createHmac('sha256', secret()).update(data).digest();
  return `${data.toString('base64url')}.${sig.toString('base64url')}`;
}

export function verify(token: string): unknown | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload: Buffer;
  let sig: Buffer;
  try {
    payload = Buffer.from(payloadB64, 'base64url');
    sig = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }
  if (sig.length === 0 || payload.length === 0) return null;
  const expected = createHmac('sha256', secret()).update(payload).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
}

// ---------- cookies ----------

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(/;\s*/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * `Secure` unconditionally, like the edge gate. Browsers accept Secure cookies
 * on `http://localhost` (a loopback host is a secure context), so local
 * verification works; any other plain-HTTP deployment was already told to put
 * TLS in front (docs/self-hosting.md → „Access").
 */
export function cookieString(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}

// ---------- session read ----------

export async function readSession(req: Request): Promise<SessionPayload | null> {
  const cookies = parseCookies(req.headers.get('cookie'));
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const payload = verify(raw) as SessionPayload | null;
  if (!payload) return null;
  if (!payload.email) return null;
  // The domain is only an access rule while membership is not.
  //
  // With TIMELINES_ACCESS_CONTROL on, an invited person may sit on any domain —
  // that is the point of inviting them — so testing the list here would refuse
  // exactly the people the invitation was for. It stays in force while the
  // switch is off, because then it is the ONLY thing standing between a signed
  // cookie and the data. Read the order carefully before changing it: emptying
  // TIMELINES_ALLOWED_EMAIL_DOMAINS while this still tested it would invalidate
  // every session at once.
  if (
    !accessControlEnabled(envValue('TIMELINES_ACCESS_CONTROL')) &&
    !isAllowedDomain(payload.email)
  ) {
    return null;
  }
  if (payload.exp < nowSec()) return null;
  return payload;
}

// ---------- domain checks ----------
//
// Same variable the proxy path reads (`scripts/admission.ts`), not the Netlify
// gate's `ALLOWED_EMAIL_DOMAINS`: one domain list per runtime, not two that
// almost agree.

export function allowedDomains(): string[] {
  return parseDomains(envValue('TIMELINES_ALLOWED_EMAIL_DOMAINS'));
}

export function firstAllowedDomain(): string {
  return allowedDomains()[0] ?? '';
}

export function isAllowedDomain(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains().includes(domain);
}

// ---------- misc ----------

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------- MCP service-token bypass ----------
//
// Lets a headless client (the MCP server) past the gate without an interactive
// Google login. Mirrors the edge gate's helper (same header, same variable), so
// the two runtimes refuse and admit the same clients.

export const MCP_TOKEN_HEADER = 'x-mcp-token';

/** Constant-time comparison — avoids leaking token length/prefix via timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when the request presents a valid MCP token (and one is configured). */
export function hasValidMcpToken(req: Request): boolean {
  const configured = envValue('MCP_API_TOKEN');
  if (!configured) return false;
  const presented = req.headers.get(MCP_TOKEN_HEADER);
  if (!presented) return false;
  return constantTimeEqual(presented, configured);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
