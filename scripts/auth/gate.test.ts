// The sign-in gate's own logic, unit-tested where it is pure, DB-backed where
// the interesting part is the database handoff.
//
// The admission *policy* (`decideSignIn`, `needsBootstrapPromotion`) is tested in
// `src/access.test.ts`; what needs proving here is the plumbing around it: that
// a cookie survives sign/verify and nothing else does, that the domain list is
// consulted exactly while membership is not, and that a first sign-in under a
// bootstrap address creates an active admin rather than a deadlock.
//
// The DB-backed cases skip without `TIMELINES_TEST_DATABASE_URL`, like their
// siblings in scripts/db — see the header there for why.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateConfig, safeRedirect, admit, REFUSAL_TEXT } from './gate.ts';
import {
  COOKIE_NAME,
  cookieString,
  nowSec,
  readSession,
  sign,
  verify,
} from './session.ts';
import { applyMigrations, freshTestDatabase, skipWithoutDatabase } from '../db/test-database.ts';
import type { GateConfig } from './gate.ts';

// The env cascade reads `process.env` first; the tests set the variables there
// and restore them, so they cannot leak a value into another test file.
const ENV_KEYS = ['AUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TIMELINES_ALLOWED_EMAIL_DOMAINS'] as const;
const saved: Record<string, string | undefined> = {};

test.beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough';
  process.env.TIMELINES_ALLOWED_EMAIL_DOMAINS = 'example.test';
});
test.afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const GATE_ON: GateConfig = {
  clientId: 'id',
  clientSecret: 'secret',
  accessControl: true,
  bootstrapAdmin: 'owner@example.test',
};

// ---------- session tokens ----------

test('a signed payload round-trips, and tampering with it is rejected', () => {
  const token = sign({ email: 'a@example.test', exp: nowSec() + 60 });
  const payload = verify(token) as { email: string };
  assert.equal(payload.email, 'a@example.test');

  const parts = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ email: 'b@example.test' })).toString('base64url')}.${parts[1]}`;
  assert.equal(verify(forged), null, 'the signature does not cover the replaced payload');
});

test('a token signed with a different secret is rejected', () => {
  const token = sign({ email: 'a@example.test', exp: nowSec() + 60 });
  process.env.AUTH_SECRET = 'a-completely-different-secret';
  assert.equal(verify(token), null);
});

test('readSession refuses an expired cookie and keeps a live one', async () => {
  const live = new Request('http://x/', {
    headers: { cookie: cookieString(COOKIE_NAME, sign({ email: 'a@example.test', exp: nowSec() + 60 }), 60) },
  });
  assert.equal((await readSession(live))?.email, 'a@example.test');

  const expired = new Request('http://x/', {
    headers: { cookie: cookieString(COOKIE_NAME, sign({ email: 'a@example.test', exp: nowSec() - 1 }), 60) },
  });
  assert.equal(await readSession(expired), null);
});

// ---------- the login flow's edges ----------

test('a redirect is only accepted when it stays on this origin', () => {
  assert.equal(safeRedirect('/timeline#x'), '/timeline#x');
  assert.equal(safeRedirect('https://evil.example/'), '/');
  assert.equal(safeRedirect('//evil.example/'), '/');
  assert.equal(safeRedirect(null), '/');
});

test('gateConfig names every missing variable at once', () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.AUTH_SECRET;
  assert.throws(() => gateConfig(), /GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET/);
});

test('every sign-in refusal carries a sentence', () => {
  // The error page must never render „Reason: not_a_member" alone — the whole
  // point of a closed instance is that somebody has to let you in.
  for (const reason of ['not_a_member', 'membership_suspended', 'membership_removed', 'invitation_expired', 'membership_unavailable']) {
    assert.ok(REFUSAL_TEXT[reason], reason);
  }
});

// ---------- admission ----------

test('without access control, the domain list decides and the database is not consulted', async () => {
  const cfg = { ...GATE_ON, accessControl: false };
  // With the list set to example.test, only that domain passes; anything else
  // is refused without the database ever being asked.
  const inDomain = await admit('someone@example.test', null, cfg, null);
  assert.deepEqual(inDomain, { allow: true });
  const out = await admit('someone@other.test', null, cfg, null);
  assert.deepEqual(out, { allow: false, reason: 'domain_not_allowed' });
});

test('access control without a database refuses rather than passes', async () => {
  const out = await admit('someone@example.test', null, GATE_ON, null);
  assert.deepEqual(out, { allow: false, reason: 'membership_unavailable' });
});

test('sign-in admission against a member list', { skip: skipWithoutDatabase() }, async (t) => {
  const sql = await freshTestDatabase('auth_gate');
  await applyMigrations(sql);
  try {
    await t.test('the bootstrap address becomes an active admin on first sign-in', async () => {
      const out = await admit('owner@example.test', 'The Owner', GATE_ON, sql);
      assert.deepEqual(out, { allow: true });
      const [row] = await sql`select role, status, name from app_users where email = 'owner@example.test'`;
      assert.equal(row.role, 'admin');
      assert.equal(row.status, 'active');
      assert.equal(row.name, 'The Owner');
    });

    await t.test('an unknown address is refused, an invited one is accepted and flipped active', async () => {
      const stranger = await admit('stranger@example.test', null, GATE_ON, sql);
      assert.deepEqual(stranger, { allow: false, reason: 'not_a_member' });

      await sql`insert into app_users (email, role, status) values ('guest@example.test', 'viewer', 'invited')`;
      const guest = await admit('guest@example.test', null, GATE_ON, sql);
      assert.deepEqual(guest, { allow: true });
      const [row] = await sql`select status from app_users where email = 'guest@example.test'`;
      assert.equal(row.status, 'active');
    });

    await t.test('a suspended member is refused', async () => {
      await sql`insert into app_users (email, role, status) values ('bad@example.test', 'editor', 'suspended')`;
      const out = await admit('bad@example.test', null, GATE_ON, sql);
      assert.deepEqual(out, { allow: false, reason: 'membership_suspended' });
    });
  } finally {
    await sql.end();
  }
});
