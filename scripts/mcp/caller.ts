// Who a remote MCP caller is, and what that caller may do.
//
// The Netlify /mcp function authenticates a *transport* — an OAuth token or the
// shared service token — but its tools reach the dispatcher directly, which is
// exactly why they used to skip the membership check the browser goes through:
// `scripts/db/http.ts` resolves the caller as part of routing an HTTP path, and
// the MCP tools are not routed, they call `resolveAdapter().handle()` (issue
// #54). This module answers the same question `authorize` answers there,
// composed from the SAME primitives in `src/access.ts` rather than restating
// them: `accessControlEnabled` for the switch, `memberCan` for a person's row,
// `serviceRoleFrom`/`roleAllows` for the service identity. What is left —
// reading a gateway header, and one refusal message per case — is glue, and it
// lives here so the function stays thin.
//
// Pure and DOM-free like the module it composes: the verdict is unit-tested
// against a table of cases, and the function imports nothing beyond `access.ts`
// and its own types. The member read is injected as a function, so the test
// needs neither a database nor a server.

import {
  accessControlEnabled,
  capabilityForMethod,
  memberCan,
  roleAllows,
  serviceRoleFrom,
  type MemberLike,
  type MemberRole,
} from '../../src/access.ts';
import type { SavedViewCaller } from '../../src/savedViews.ts';

/** What a resolved caller may do — the MCP-side counterpart of `Authorized` in http.ts. */
export type McpCallerAccess = {
  /** The person behind the call, or null for the service identity. */
  email: string | null;
  /**
   * Attribution for `updated_by`: the person's address, or the `mcp` service
   * label. A gateway identity writes as the real address even when its row
   * turns out to be read-only — the refusal is the verdict, the attribution is
   * the record.
   */
  updatedBy: string;
  canWrite: boolean;
  canManage: boolean;
  /**
   * The service token's configured role, or null for a person (or an instance
   * with the switch off). Present only to phrase the refusal; the booleans are
   * the verdict.
   */
  serviceRole: MemberRole | null;
};

/** The saved-view caller the dispatcher wants: the same three fields everywhere. */
export function savedViewCallerOf(access: McpCallerAccess): SavedViewCaller {
  // `updatedBy`, not `email`: for the service identity it is the `mcp` label the
  // HTTP runtime puts there as well (the edge function passes no `caller` for
  // the token, so `unrestricted` falls back to `updatedBy`), and a saved view
  // owned by `mcp` is visible to nobody — the behaviour the shared token already
  // has in the browser path.
  return { email: access.updatedBy, canWrite: access.canWrite, canManage: access.canManage };
}

/** An address-shaped value only — a login name or display name is not an identity. */
export function addressShaped(value: string | undefined | null): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/**
 * Read the caller's address out of the gateway's identity header.
 *
 * `headerName` comes from `MCP_IDENTITY_HEADER` and is read from the request
 * ONLY AFTER the constant-time Bearer check passed — the header is as
 * trustworthy as the credential that travels with it, which is the same trust
 * model `TIMELINES_TRUSTED_IDENTITY_HEADER` documents for self-hosting: a
 * proxy in front must strip the header from client requests, or whoever sets
 * it speaks for any member.
 *
 * A value that is not address-shaped is treated as no identity rather than an
 * error: a service-account call carries a login name in the subject position,
 * and it should fall through to `MCP_TOKEN_ROLE` rather than break the call.
 */
export function identityFromHeader(
  headers: { get(name: string): string | null },
  headerName: string | undefined | null,
): string | null {
  if (!headerName) return null;
  return addressShaped(headers.get(headerName.trim()) ?? '');
}

/**
 * Resolve what this call may do.
 *
 * `identity` is the person the runtime already authenticated: an OAuth token's
 * e-mail, or the address from the trusted identity header. Null is a pure
 * service call.
 *
 * - Switch off — everybody past the auth gate may do everything, exactly as
 *   before the role model; a person identity still gets the real address in
 *   `updated_by`, because attribution and authorization are separate facts.
 * - Person + switch on — the `app_users` row decides. A viewer, a suspended
 *   member or a stranger may still READ (the credential is operator-grade; the
 *   member list is what decides writes), their writes are refused.
 * - Service + switch on — `MCP_TOKEN_ROLE` (docs/users.md → „Non-human
 *   callers"), default `editor`, which is what keeps existing automations
 *   working the day the switch is turned on.
 */
export async function resolveMcpCaller(opts: {
  identity: string | null;
  accessControlRaw: string | undefined;
  tokenRoleRaw: string | undefined;
  getMember: (email: string) => Promise<MemberLike | null>;
}): Promise<McpCallerAccess> {
  const email = opts.identity;
  if (!accessControlEnabled(opts.accessControlRaw)) {
    return { email, updatedBy: email ?? 'mcp', canWrite: true, canManage: true, serviceRole: null };
  }
  if (email) {
    const member = await opts.getMember(email);
    return {
      email,
      updatedBy: email,
      canWrite: memberCan(member, 'write'),
      canManage: memberCan(member, 'manage'),
      serviceRole: null,
    };
  }
  const role = serviceRoleFrom(opts.tokenRoleRaw);
  return {
    email: null,
    updatedBy: 'mcp',
    canWrite: roleAllows(role, 'write'),
    canManage: roleAllows(role, 'manage'),
    serviceRole: role,
  };
}

/**
 * May this tool call write, and if not, why (as a message the tool returns)?
 *
 * Reads need nothing beyond the auth gate. Saved views are the one write whose
 * HTTP capability is `read` (a saved view is display state a viewer keeps of
 * their own); the finer rules travel on `caller` and are enforced by the
 * dispatcher, identically to the browser. Everything else needs `write`, and
 * the refusal is phrased the way the dispatcher phrases it — one wording per
 * case, so an agent relaying it says what the browser user would read.
 */
export function writeRefusal(req: { method: string; sub?: { kind?: string } }, access: McpCallerAccess): string | null {
  const capability = capabilityForMethod(req.method);
  if (capability === 'read' || req.sub?.kind === 'saved-view') return null;
  if (access.canWrite) return null;
  if (access.email) return `${access.email} may not write here`;
  return `this token acts as ${access.serviceRole}, which may not ${capability}`;
}
