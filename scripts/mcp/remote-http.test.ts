// The remote MCP endpoint's own rules. The tool *calls* are the dispatcher's,
// tested there; what needs proving here is what this runtime adds: that the
// bearer check refuses everything but the configured token, and that the shared
// registration really registers (a tool list that silently came up empty would
// answer every client with "tool not found" and still look deployed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bearerMatches } from './remote-http.ts';
import { buildRemoteServer } from './remote-server.ts';
import { resolveMcpCaller } from './caller.ts';

// A resolved service caller, switch off: the identity the shared token has on
// an instance that never turned the member list on — the default self-host.
const tokenCaller = await resolveMcpCaller({
  identity: null,
  accessControlRaw: undefined,
  tokenRoleRaw: undefined,
  getMember: async () => null,
});

test('the bearer check admits the configured token and refuses everything else', () => {
  assert.equal(bearerMatches('the-token', 'the-token'), true);
  assert.equal(bearerMatches('wrong', 'the-token'), false);
  assert.equal(bearerMatches('', 'the-token'), false);
  assert.equal(bearerMatches('the-token', null), false, 'no token configured admits nobody');
  assert.equal(bearerMatches(null, 'the-token'), false);
});

test('the shared registration carries the tool surface', async () => {
  // No conns: registration is what is being asserted, not the database behind
  // it — a server with zero tools is the failure this catches, and it would
  // look deployed until the first client asked for a tool.
  const server = buildRemoteServer(tokenCaller, { sql: null, supabase: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'registration-test', version: '0.0.0' });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  // One representative per family: CRUD, saved views, plugin lifecycle, plugin
  // rows. The retired pricing tools are deliberately absent — they answer
  // "unknown sub-resource" since the pricing route retired. The full list is
  // the Netlify function's contract and is covered by it; here it is enough to
  // know the registration carried over.
  for (const expected of [
    'list_timelines',
    'add_item',
    'update_group',
    'list_saved_views',
    'install_plugin',
    'plugin_data_write',
  ]) {
    assert.ok(names.includes(expected), `expected tool "${expected}" to be registered`);
  }
  assert.ok(!names.includes('set_tier_value'), 'retired pricing tools must not register');
  client.close();
});

test('the write gate refuses a viewer caller before the dispatcher', async () => {
  // The verdict MCP_TOKEN_ROLE=viewer resolves to, through the same
  // resolveMcpCaller both runtimes share. The refusal is what this proves:
  // the gate lives in the shared registration now, so a read-only token is
  // read-only on the self-hosted endpoint for the same reason as on the
  // function — phrased with the role, so an agent relaying it names the
  // operator's own configuration.
  const viewer = await resolveMcpCaller({
    identity: null,
    accessControlRaw: 'true',
    tokenRoleRaw: 'viewer',
    getMember: async () => null,
  });
  // A truthy sql satisfies resolveRepo („database configured"); the refusal
  // throws before any query is built, so an empty object is the whole fixture.
  const server = buildRemoteServer(viewer, { sql: {} as never, supabase: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'write-gate-test', version: '0.0.0' });
  await client.connect(clientTransport);

  // A tool error is a result, not a protocol error: the MCP client resolves
  // `callTool` with `isError: true` and the message in its content, which is
  // what an agent relays — so the refusal is asserted on exactly that.
  const refusal = (await client.callTool({
    name: 'add_item',
    arguments: { id: 'demo', item: { start: '2026-01-01', content: 'x' } },
  })) as { isError?: boolean; content: { text?: string }[] };
  assert.equal(refusal.isError, true);
  assert.match(refusal.content[0]?.text ?? '', /forbidden: this token acts as viewer, which may not write/);
  // Reads are not asserted here: they pass the gate and would need a real
  // database to answer; that the gate lets them through is the dispatcher's
  // territory, tested there.
  client.close();
});
