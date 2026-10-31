import type { AuthenticatedSession } from "../auth/session";

export type OfficeJobIdentityScope = Readonly<{
  tenantId: string;
  userId: string;
  cacheScope: string;
}>;

// AuthBoundary supplies a new session object after sign-in or an authority change. Keep an
// opaque, memory-only namespace so an earlier request cannot satisfy that new session. Neither
// credentials nor a persisted identity DTO belong in a query key. Both estimator readers share it.
const sessionScopes = new WeakMap<AuthenticatedSession, OfficeJobIdentityScope>();

export function officeJobIdentityScope(session: AuthenticatedSession): OfficeJobIdentityScope {
  let scope = sessionScopes.get(session);
  if (!scope) {
    scope = {
      tenantId: session.tenant.id,
      userId: session.user.id,
      cacheScope: crypto.randomUUID(),
    };
    sessionScopes.set(session, scope);
  }
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
