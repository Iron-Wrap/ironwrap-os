import type { AuthenticatedSession } from "../auth/session";

export type OfficeJobIdentityScope = Readonly<{
  tenantId: string;
  userId: string;
  cacheScope: string;
}>;

type SessionScope = {
  snapshot: WeakRef<AuthenticatedSession>;
  scope: OfficeJobIdentityScope;
};

// Worker csrfTokenFor binds CSRF to the authenticated cookie; read/source clocks and office
// profile labels can change on an ordinary session GET. Scope the actor by its actual session
// and authority claims, not the freshly parsed DTO's identity. The current auth QueryClient holds
// the live snapshot; weak references avoid extending credential lifetime in this private cache.
// Only the opaque scope below reaches query keys or mutation variables.
const sessionScopes = new Map<string, SessionScope>();

function sameGrants(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((grant) => rightSet.has(grant));
}

function sameActorAuthority(left: AuthenticatedSession, right: AuthenticatedSession) {
  return (
    left.tenant.id === right.tenant.id &&
    left.user.id === right.user.id &&
    left.user.email === right.user.email &&
    left.user.frappe_user_id === right.user.frappe_user_id &&
    left.user.role === right.user.role &&
    left.csrf_token === right.csrf_token &&
    left.session_expires_at === right.session_expires_at &&
    sameGrants(left.permissions, right.permissions) &&
    sameGrants(left.allowed_actions, right.allowed_actions)
  );
}

export function officeJobIdentityScope(session: AuthenticatedSession): OfficeJobIdentityScope {
  for (const [key, record] of sessionScopes) {
    if (!record.snapshot.deref()) sessionScopes.delete(key);
  }
  const key = JSON.stringify([session.tenant.id, session.user.id]);
  const record = sessionScopes.get(key);
  const previous = record?.snapshot.deref();
  if (record && previous && sameActorAuthority(previous, session)) {
    record.snapshot = new WeakRef(session);
    return record.scope;
  }
  const scope = {
    tenantId: session.tenant.id,
    userId: session.user.id,
    cacheScope: crypto.randomUUID(),
  };
  sessionScopes.set(key, { snapshot: new WeakRef(session), scope });
  return scope;
}

export const estimatorWorkbenchQueryKey = (scope: OfficeJobIdentityScope, jobId?: string) =>
  [
    "estimator-workbench",
    scope.tenantId,
    scope.userId,
    jobId,
    scope.cacheScope,
    "job-identity-v1",
  ] as const;

export const quoteRevisionApprovalDetailQueryKey = (
  scope: OfficeJobIdentityScope,
  approvalId: string,
) =>
  [
    "quote-revision-approval",
    scope.tenantId,
    scope.userId,
    approvalId,
    scope.cacheScope,
    "job-identity-v1",
  ] as const;
