import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemberLike } from '../../src/access.ts';
import {
  addressShaped,
  identityFromHeader,
  resolveMcpCaller,
  savedViewCallerOf,
  writeRefusal,
} from './caller.ts';

// The verdict is the policy, and it is pure: every case is one table row with a
// stubbed member read, no database and no server — the same approach the HTTP
// layer's tests take for `authorize` (scripts/db/http.test.ts).

const ON = 'true';
const OFF = undefined;

const members: Record<string, MemberLike> = {
  'admin@example.test': { role: 'admin', status: 'active' },
  'editor@example.test': { role: 'editor', status: 'active' },
  'viewer@example.test': { role: 'viewer', status: 'active' },
  'suspended@example.test': { role: 'admin', status: 'suspended' },
};

const resolve = (opts: {
  identity: string | null;
  accessControlRaw?: string;
  tokenRoleRaw?: string;
  members?: Record<string, MemberLike>;
}) =>
  resolveMcpCaller({
    identity: opts.identity,
    accessControlRaw: opts.accessControlRaw,
    tokenRoleRaw: opts.tokenRoleRaw,
    getMember: (email: string) => Promise.resolve((opts.members ?? members)[email] ?? null),
  });

// ---- resolveMcpCaller -------------------------------------------------------

test('switch off: everybody may everything, the person still gets attribution', async () => {
  const person = await resolve({ identity: 'viewer@example.test', accessControlRaw: OFF });
  assert.deepEqual(person, {
    email: 'viewer@example.test',
    updatedBy: 'viewer@example.test',
    canWrite: true,
    canManage: true,
    serviceRole: null,
  });

  const service = await resolve({ identity: null, accessControlRaw: OFF });
  assert.equal(service.updatedBy, 'mcp');
  assert.equal(service.canWrite, true);
});

test('switch on + person: the row decides, and reads survive a refusal', async () => {
  const editor = await resolve({ identity: 'editor@example.test', accessControlRaw: ON });
  assert.equal(editor.canWrite, true);
  assert.equal(editor.canManage, false);
  assert.equal(editor.updatedBy, 'editor@example.test');

  const admin = await resolve({ identity: 'admin@example.test', accessControlRaw: ON });
  assert.equal(admin.canWrite, true);
  assert.equal(admin.canManage, true);

  const viewer = await resolve({ identity: 'viewer@example.test', accessControlRaw: ON });
  assert.equal(viewer.canWrite, false);
  // Read stays open: the credential is operator-grade, the member list decides
  // writes. The writeRefusal tests below pin the refusal itself.
  const gone = await resolve({ identity: 'suspended@example.test', accessControlRaw: ON });
  assert.equal(gone.canWrite, false, 'status decides before the role does');
});

test('switch on + no row: the person may read, and the refusal does not probe', async () => {
  const stranger = await resolve({ identity: 'stranger@example.test', accessControlRaw: ON });
  const viewer = await resolve({ identity: 'viewer@example.test', accessControlRaw: ON });
  assert.equal(stranger.canWrite, viewer.canWrite);
  assert.equal(stranger.canManage, viewer.canManage);
});

test('switch on + service: MCP_TOKEN_ROLE, editor by default', async () => {
  const byDefault = await resolve({ identity: null, accessControlRaw: ON });
  assert.equal(byDefault.canWrite, true);
  assert.equal(byDefault.updatedBy, 'mcp');
  assert.equal(byDefault.serviceRole, 'editor');

  const readonly = await resolve({ identity: null, accessControlRaw: ON, tokenRoleRaw: 'viewer' });
  assert.equal(readonly.canWrite, false);
  assert.equal(readonly.serviceRole, 'viewer');

  // A value that is not one of ours acts as the default, not as a refusal.
  const nonsense = await resolve({ identity: null, accessControlRaw: ON, tokenRoleRaw: 'nonsense' });
  assert.equal(nonsense.canWrite, true);
  assert.equal(nonsense.serviceRole, 'editor');
});

test('the switch reads only the literal string true', async () => {
  const notTrue = await resolve({ identity: null, accessControlRaw: 'yes', tokenRoleRaw: 'viewer' });
  assert.equal(notTrue.canWrite, true, '"yes" leaves it off, so the role is not consulted');
});

// ---- identityFromHeader -----------------------------------------------------

test('no configured header means no identity — the default keeps today\'s behaviour', () => {
  assert.equal(identityFromHeader({ get: () => 'editor@example.test' }, undefined), null);
  assert.equal(identityFromHeader({ get: () => 'editor@example.test' }, ''), null);
});

test('the configured header is read and lower-cased to an address', () => {
  const headers = new Headers({ 'X-Forwarded-Email': ' Editor@Example.TEST ' });
  assert.equal(identityFromHeader(headers, 'X-Forwarded-Email'), 'editor@example.test');
});

test('a value that is not address-shaped is no identity, not an error', () => {
  // A service account carries a login name in the subject position; it falls
  // through to the service identity and MCP_TOKEN_ROLE rather than breaking.
  const headers = new Headers({ 'X-Subject': 'svc-deployer' });
  assert.equal(identityFromHeader(headers, 'X-Subject'), null);
  assert.equal(identityFromHeader({ get: () => null }, 'X-Email'), null);
});

test('addressShaped accepts addresses only', () => {
  assert.equal(addressShaped('a@b.co'), 'a@b.co');
  assert.equal(addressShaped('  A@B.CO '), 'a@b.co');
  assert.equal(addressShaped('b.co'), null);
  assert.equal(addressShaped('a b@c.co'), null);
  assert.equal(addressShaped('a@'), null);
  assert.equal(addressShaped(null), null);
});

// ---- writeRefusal ------------------------------------------------------------

test('reads and saved views never hit the write gate', async () => {
  const viewer = await resolve({ identity: 'viewer@example.test', accessControlRaw: ON });
  assert.equal(writeRefusal({ method: 'GET', sub: { kind: 'item' } }, viewer), null);
  assert.equal(writeRefusal({ method: 'GET' }, viewer), null);
  assert.equal(writeRefusal({ method: 'POST', sub: { kind: 'saved-view' } }, viewer), null);
});

test('a write without the role refuses, with the dispatcher\'s message', async () => {
  const viewer = await resolve({ identity: 'viewer@example.test', accessControlRaw: ON });
  assert.match(writeRefusal({ method: 'PATCH', sub: { kind: 'item' } }, viewer)!, /viewer@example\.test may not write/);
  assert.match(writeRefusal({ method: 'DELETE', sub: { kind: 'group' } }, viewer)!, /may not write/);
});

test('the service refusal names the configured role', async () => {
  const service = await resolve({ identity: null, accessControlRaw: ON, tokenRoleRaw: 'viewer' });
  assert.match(writeRefusal({ method: 'POST', sub: { kind: 'item' } }, service)!, /this token acts as viewer/);
});

test('a write the role allows passes the gate', async () => {
  const editor = await resolve({ identity: 'editor@example.test', accessControlRaw: ON });
  assert.equal(writeRefusal({ method: 'PUT', sub: { kind: 'tier-value' } }, editor), null);
});

// ---- savedViewCallerOf -------------------------------------------------------

test('the saved-view caller follows the updatedBy the HTTP runtime would set', async () => {
  const person = await resolve({ identity: 'editor@example.test', accessControlRaw: ON });
  assert.deepEqual(savedViewCallerOf(person), { email: 'editor@example.test', canWrite: true, canManage: false });

  const service = await resolve({ identity: null, accessControlRaw: ON, tokenRoleRaw: 'viewer' });
  assert.deepEqual(savedViewCallerOf(service), { email: 'mcp', canWrite: false, canManage: false });
});
