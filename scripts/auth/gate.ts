// The self-hosted sign-in gate: Google OAuth login, session minting, and the
// admission decision on the callback.
//
// This is the Node twin of `netlify/edge-functions/auth.ts`, mounted by
// `scripts/serve.ts` instead of by an edge runtime. Same endpoints
// (`/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/error`), so the
// client's 401 handling (`src/editor.ts` → `/auth/login?redirect=…`) works
// against both deployments unchanged. The admission *policy* is shared:
// `src/access.ts` (`decideSignIn`, `needsBootstrapPromotion`) decides what a
// proven address means; this module only proves the address and records the
// acceptance.
//
// Enabled by `AUTH_REQUIRED=true` — the same switch and the same meaning the
// Netlify gate reads, so one variable answers "does this deployment have a
// sign-in?" on both runtimes. With it off, none of this runs and the server
// behaves exactly as before.
//
// Where the two gates genuinely differ is the member lookup: the edge function
// reaches Supabase with a service key, this one uses the same postgres.js
// handle the API dispatcher uses (`scripts/db/timeline-repo.ts`), because a
// self-hosted deployment is by definition the one holding the database
// connection already.

import { accessControlEnabled, decideSignIn, needsBootstrapPromotion } from '../../src/access.ts';
import {
  getMember,
  inviteMember,
  setMemberStatus,
  touchUser,
} from '../db/timeline-repo.ts';
import type { Sql } from 'postgres';
import { envValue } from '../db/env.ts';
import {
  COOKIE_NAME,
  STATE_COOKIE,
  SESSION_MAX_AGE,
  STATE_MAX_AGE,
  type SessionPayload,
  type StatePayload,
  sign,
  verify,
  parseCookies,
  cookieString,
  firstAllowedDomain,
  isAllowedDomain,
  escapeHtml,
  nowSec,
} from './session.ts';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Everything the gate reads from the environment, resolved once at startup. */
export type GateConfig = {
  clientId: string;
  clientSecret: string;
  accessControl: boolean;
  bootstrapAdmin: string | undefined;
};

/**
 * Read and validate the gate's configuration. Throws with a message naming
 * every missing variable at once, because finding them one per start is a
// loop of restarts for the operator.
 */
export function gateConfig(): GateConfig {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_SECRET'].filter(
    (k) => !envValue(k),
  );
  if (missing.length) {
    throw new Error(
      `AUTH_REQUIRED=true but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'The built-in sign-in needs all three (see docs/self-hosting.md → „A sign-in of its own").',
    );
  }
  return {
    clientId: envValue('GOOGLE_CLIENT_ID')!,
    clientSecret: envValue('GOOGLE_CLIENT_SECRET')!,
    accessControl: accessControlEnabled(envValue('TIMELINES_ACCESS_CONTROL')),
    bootstrapAdmin: envValue('TIMELINES_BOOTSTRAP_ADMIN') || undefined,
  };
}

/**
 * Handle `/auth/*`. Returns the Response to send, or null when the path is not
 * one of ours (the caller falls through to static serving).
 *
 * Takes a `Sql` handle rather than opening one: serve.ts already holds the
 * connection, and admitting on a second one would let a sign-in disagree with
 * the dispatcher's member read. Null is legitimate — a file-only deployment —
 * and `admit` turns it into the same `membership_unavailable` refusal the edge
 * gate answers with, rather than into a pass.
 */
export async function handleAuthRequest(
  req: Request,
  url: URL,
  cfg: GateConfig,
  sql: Sql | null,
): Promise<Response | null> {
  switch (url.pathname) {
    case '/auth/login':
      return handleLogin(url, cfg);
    case '/auth/callback':
      return handleCallback(req, url, cfg, sql);
    case '/auth/logout':
      return handleLogout(url);
    case '/auth/error':
      return errorPage(url.searchParams.get('reason') ?? 'unknown');
    default:
      return null;
  }
}

// ---------- OAuth flow ----------

/** Only same-site, same-origin paths: an open redirect would turn the login into a forwarder. */
export function safeRedirect(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

function handleLogin(url: URL, cfg: GateConfig): Response {
  const state = crypto.randomUUID();
  const stateCookieValue = sign({
    state,
    redirect: safeRedirect(url.searchParams.get('redirect')),
    exp: nowSec() + STATE_MAX_AGE,
  } satisfies StatePayload);

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${url.origin}/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
  // Domain hint only while the domain is what decides. With the member list in
  // charge, `hd` would hide exactly the accounts an invitation was sent to: it
  // restricts Google's account chooser, so an invited person outside the
  // configured domain could not even offer their address.
  if (!cfg.accessControl) {
    const hint = firstAllowedDomain();
    if (hint) params.set('hd', hint);
  }

  const headers = new Headers({ Location: `${GOOGLE_AUTH}?${params.toString()}` });
  headers.append('Set-Cookie', cookieString(STATE_COOKIE, stateCookieValue, STATE_MAX_AGE));
  return new Response(null, { status: 302, headers });
}

async function handleCallback(
  req: Request,
  url: URL,
  cfg: GateConfig,
  sql: Sql | null,
): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errParam = url.searchParams.get('error');
  if (errParam) return redirectToError(url, errParam);
  if (!code || !state) return redirectToError(url, 'missing_code_or_state');

  const cookies = parseCookies(req.headers.get('cookie'));
  const stateCookie = cookies[STATE_COOKIE];
  if (!stateCookie) return redirectToError(url, 'state_cookie_missing');
  const statePayload = verify(stateCookie) as StatePayload | null;
  if (!statePayload || statePayload.state !== state || statePayload.exp < nowSec()) {
    return redirectToError(url, 'state_mismatch');
  }

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return redirectToError(url, `token_exchange_failed_${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return redirectToError(url, 'no_access_token');

  const userRes = await fetch(GOOGLE_USERINFO, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) return redirectToError(url, `userinfo_failed_${userRes.status}`);
  const user = (await userRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  const email = (user.email ?? '').toLowerCase();
  if (!email || !user.email_verified) return redirectToError(url, 'email_unverified');

  const admitted = await admit(email, user.name ?? null, cfg, sql);
  if (!admitted.allow) return redirectToError(url, admitted.reason);

  const session = sign({
    email,
    sub: user.sub ?? email,
    name: user.name,
    exp: nowSec() + SESSION_MAX_AGE,
  } satisfies SessionPayload);

  const headers = new Headers({ Location: `${url.origin}${statePayload.redirect}` });
  headers.append('Set-Cookie', cookieString(COOKIE_NAME, session, SESSION_MAX_AGE));
  headers.append('Set-Cookie', cookieString(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}

/**
 * May this proven address in, and record it if this is an acceptance.
 *
 * Two regimes, chosen by the same switch the API layer uses:
 *
 * - **Off** — the domain allow-list decides (`TIMELINES_ALLOWED_EMAIL_DOMAINS`),
 *   exactly as the proxy path does. Fail-closed: an empty list admits nobody,
 *   because „the gate is on and names no domain" is a configuration nobody
 *   should be able to drift into silently.
 * - **On** — the member list decides, and the domain is no longer consulted.
 *
 * Mirrors `admit` in the edge gate; see there for the reasoning behind each
 * step. The one structural difference: this runtime holds its `Sql` handle the
 * whole time, so `membership_unavailable` means „no database configured", not
 * „the lookup failed".
 */
export async function admit(
  email: string,
  name: string | null,
  cfg: GateConfig,
  sql: Sql | null,
): Promise<{ allow: true } | { allow: false; reason: string }> {
  if (!cfg.accessControl) {
    return isAllowedDomain(email) ? { allow: true } : { allow: false, reason: 'domain_not_allowed' };
  }
  if (!sql) {
    // The switch is on and there is nothing to ask. Refusing is the only honest
    // answer: letting everybody in would make the switch a lie, and it is the
    // operator's own misconfiguration rather than the visitor's problem.
    return { allow: false, reason: 'membership_unavailable' };
  }

  let member = await getMember(sql, email);

  // The bootstrap address is how an instance gets its first admin. The master
  // key holds whatever state its row is in, including „already an editor" —
  // see `needsBootstrapPromotion` for why „create if missing" would have locked
  // every existing instance out of its own administration.
  if (needsBootstrapPromotion(member, email, cfg.bootstrapAdmin)) {
    await inviteMember(sql, { email, role: 'admin' });
    await setMemberStatus(sql, email, 'active');
    member = await getMember(sql, email);
  }

  const verdict = decideSignIn(member, Date.now());
  if (!verdict.allow) return { allow: false, reason: verdict.reason };

  // Accepting is the first successful sign-in, so it is recorded here rather
  // than by opening the invitation link — somebody who was invited gets in with
  // their address whether or not they ever clicked it.
  if (verdict.accept) await setMemberStatus(sql, email, 'active');
  // Keep the display name fresh while we have it; `touchUser` never clears one.
  if (name) await touchUser(sql, email, name);
  return { allow: true };
}

function handleLogout(url: URL): Response {
  const headers = new Headers({ Location: `${url.origin}/auth/login` });
  headers.append('Set-Cookie', cookieString(COOKIE_NAME, '', 0));
  return new Response(null, { status: 302, headers });
}

/**
 * One sentence per refusal, because „Reason: not_a_member" tells a visitor
 * nothing about what to do next, and the whole point of a closed instance is
 * that somebody has to let them in. Identical to the edge gate's, so a refusal
 * reads the same on both runtimes.
 */
export const REFUSAL_TEXT: Record<string, string> = {
  not_a_member: 'This address has not been invited to this instance. Ask an administrator for an invitation.',
  membership_suspended: 'This membership is suspended. Ask an administrator to restore it.',
  membership_removed: 'This membership was removed. Ask an administrator for a new invitation.',
  invitation_expired: 'This invitation has expired. Ask an administrator to send a new one.',
  membership_unavailable: 'The member list is unreachable, so nobody can be let in right now. This is a server configuration problem.',
};

export function errorPage(reason: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login failed</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  code { background: #f3f3f3; padding: 0.1em 0.4em; border-radius: 4px; }
  a.btn { display: inline-block; margin-top: 1rem; background: #1a1a1a; color: #fff; padding: 0.6rem 1.1rem; border-radius: 6px; text-decoration: none; }
</style>
</head><body>
<h1>Login failed</h1>
<p>${escapeHtml(REFUSAL_TEXT[reason] ?? 'This timeline is not open to this address.')}</p>
<p>Reason: <code>${escapeHtml(reason)}</code></p>
<a class="btn" href="/auth/login">Try again</a>
</body></html>`;
  return new Response(html, {
    status: 403,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function redirectToError(url: URL, reason: string): Response {
  const target = new URL('/auth/error', url.origin);
  target.searchParams.set('reason', reason);
  const headers = new Headers({ Location: target.toString() });
  headers.append('Set-Cookie', cookieString(STATE_COOKIE, '', 0));
  return new Response(null, { status: 302, headers });
}
