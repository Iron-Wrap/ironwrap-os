import type { AuthenticatedSession } from "../auth/session";
import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  accountingCommandResponseSchema,
  accountingExceptionListResponseSchema,
  accountingExceptionResolveResponseSchema,
  accountingIdSchema,
  accountingIntentDetailResponseSchema,
  accountingIntentListResponseSchema,
  accountingSummaryResponseSchema,
  type AccountingCommandResponse,
  type AccountingExceptionListResponse,
  type AccountingExceptionResolveResponse,
  type AccountingIntentDetailResponse,
  type AccountingIntentListResponse,
  type AccountingRejectionReason,
  type AccountingRemedy,
  type AccountingSummaryResponse,
} from "./money-contracts";

// The money desk's calls into the bus BFF (IRO-52 slice S9).
//
// Every command carries the session's CSRF token and a caller-supplied `Idempotency-Key`, which is
// the convention `handleQuickBooksFinalInvoiceCommand` established and which
// `docs/ACCOUNTING-RECONCILIATION-CONTRACT.md` section 8.1 requires of every route here. The key is
// minted once per action attempt by the screen and reused across retries, so a user who taps twice
// on a slow connection replays their own command rather than issuing a second one.

export async function loadAccountingSummary(
  fetcher: typeof fetch = fetch,
): Promise<AccountingSummaryResponse> {
  return await apiRequest({
    path: API_PATHS.accountingSummary,
    schema: accountingSummaryResponseSchema,
    fetcher,
  });
}

export async function loadAccountingIntents(
  filter: { kind?: string; state?: string; job?: string } = {},
  fetcher: typeof fetch = fetch,
): Promise<AccountingIntentListResponse> {
  const query = new URLSearchParams();
  if (filter.kind) query.set("kind", filter.kind);
  if (filter.state) query.set("state", filter.state);
  if (filter.job) query.set("job", filter.job);
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return await apiRequest({
    path: `${API_PATHS.accountingIntents}${suffix}`,
    schema: accountingIntentListResponseSchema,
    fetcher,
  });
}

export async function loadAccountingIntent(
  intentId: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountingIntentDetailResponse> {
  return await apiRequest({
    path: API_PATHS.accountingIntent(accountingIdSchema.parse(intentId)),
    schema: accountingIntentDetailResponseSchema,
    fetcher,
  });
}

export async function loadAccountingExceptions(
  status: "open" | "acknowledged" | "resolved" | undefined,
  fetcher: typeof fetch = fetch,
): Promise<AccountingExceptionListResponse> {
  const suffix = status === undefined ? "" : `?status=${status}`;
  return await apiRequest({
    path: `${API_PATHS.accountingExceptions}${suffix}`,
    schema: accountingExceptionListResponseSchema,
    fetcher,
  });
}

export async function approveAccountingIntent(
  session: AuthenticatedSession,
  intentId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountingCommandResponse> {
  return await command(
    session,
    API_PATHS.accountingIntentApprove(accountingIdSchema.parse(intentId)),
    { version },
    idempotencyKey,
    fetcher,
  );
}

export async function rejectAccountingIntent(
  session: AuthenticatedSession,
  intentId: string,
  version: number,
  reasonCode: AccountingRejectionReason,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountingCommandResponse> {
  return await command(
    session,
    API_PATHS.accountingIntentReject(accountingIdSchema.parse(intentId)),
    { version, reason_code: reasonCode },
    idempotencyKey,
    fetcher,
  );
}

export async function reconcileAccountingIntent(
  session: AuthenticatedSession,
  intentId: string,
  version: number,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountingCommandResponse> {
  return await command(
    session,
    API_PATHS.accountingIntentReconcile(accountingIdSchema.parse(intentId)),
    { version },
    idempotencyKey,
    fetcher,
  );
}

/**
 * Authorize a reversal.
 *
 * The screen never dispatches one: this records the accountant's authorization and returns the
 * plan the server computed, which is section 11's propose -> authorize -> reverse with the middle
 * step being the only one a browser is allowed to take.
 */
export async function compensateAccountingIntent(
  session: AuthenticatedSession,
  intentId: string,
  version: number,
  remedy: AccountingRemedy,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountingCommandResponse> {
  return await command(
    session,
    API_PATHS.accountingIntentCompensate(accountingIdSchema.parse(intentId)),
    { version, remedy },
    idempotencyKey,
    fetcher,
  );
}

export async function resolveAccountingException(
  session: AuthenticatedSession,
  exceptionId: string,
  resolutionAction: AccountingRemedy,
  compensatingEffectId: string | null,
  idempotencyKey: string,
  fetcher: typeof fetch = fetch,
): Promise<AccountingExceptionResolveResponse> {
  return await apiRequest({
    path: API_PATHS.accountingExceptionResolve(accountingIdSchema.parse(exceptionId)),
    schema: accountingExceptionResolveResponseSchema,
    method: "POST",
    body: {
      resolution_action: resolutionAction,
      ...(compensatingEffectId === null ? {} : { compensating_effect_id: compensatingEffectId }),
    },
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

async function command(
  session: AuthenticatedSession,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  fetcher: typeof fetch,
): Promise<AccountingCommandResponse> {
  return await apiRequest({
    path,
    schema: accountingCommandResponseSchema,
    method: "POST",
    body,
    csrfToken: session.csrf_token,
    idempotencyKey,
    fetcher,
  });
}

/** One key per action attempt, stable across retries of that attempt. */
export function newAccountingActionKey(action: string): string {
  return `accounting:${action}:${crypto.randomUUID()}`;
}
