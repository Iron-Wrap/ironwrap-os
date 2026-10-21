import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  customerContractAcceptanceChallengeResponseSchema,
  customerContractAcceptancePreviewResponseSchema,
  customerContractAcceptanceConfirmResponseSchema,
  customerPortalDecisionResponseSchema,
  customerPortalResponseSchema,
  type CustomerContractAcceptanceChallengeResponse,
  type CustomerContractAcceptancePreviewResponse,
  type CustomerContractAcceptanceConfirmResponse,
  type CustomerPortalDecisionResponse,
  type CustomerPortalResponse,
} from "./portal-contracts";

/**
 * Public capability resolver: never attach an office/session cookie to this request. With
 * `staffPreview` (an office sign-in is live in this browser) the server does not record the open as
 * the customer's; the flag can only stop that record, never make one.
 */
export async function loadCustomerPortal(
  token: string,
  fetcher?: typeof fetch,
  staffPreview = false,
): Promise<CustomerPortalResponse> {
  return await apiRequest({
    path: API_PATHS.customerPortalResolve,
    method: "POST",
    body: staffPreview ? { token, staff_preview: true } : { token },
    schema: customerPortalResponseSchema,
    credentials: "omit",
    fetcher,
  });
}

/** Start an email-verified contract confirmation; a portal capability alone cannot accept terms. */
export async function requestCustomerContractAcceptanceChallenge(
  token: string,
  fetcher?: typeof fetch,
): Promise<CustomerContractAcceptanceChallengeResponse> {
  return await apiRequest({
    path: API_PATHS.customerPortalAcceptanceChallenge,
    method: "POST",
    body: { token },
    schema: customerContractAcceptanceChallengeResponseSchema,
    credentials: "omit",
    fetcher,
  });
}

/** Read the still-current quote bound to the emailed acceptance token before asking for consent. */
export async function loadCustomerContractAcceptancePreview(
  token: string,
  fetcher?: typeof fetch,
): Promise<CustomerContractAcceptancePreviewResponse> {
  return await apiRequest({
    path: API_PATHS.customerPortalAcceptancePreview,
    method: "POST",
    body: { token },
    schema: customerContractAcceptancePreviewResponseSchema,
    credentials: "omit",
    fetcher,
  });
}

/** Confirm one email-bound, single-use acceptance challenge without an office session. */
export async function confirmCustomerContractAcceptance(
  input: { token: string; signerName: string; idempotencyKey: string },
  fetcher?: typeof fetch,
): Promise<CustomerContractAcceptanceConfirmResponse> {
  return await apiRequest({
    path: API_PATHS.customerPortalAcceptanceConfirm,
    method: "POST",
    body: { token: input.token, signer_name: input.signerName, accepted: true },
    idempotencyKey: input.idempotencyKey,
    schema: customerContractAcceptanceConfirmResponseSchema,
    credentials: "omit",
    fetcher,
  });
}

/**
 * Record which curated option the customer prefers. Unlike acceptance this needs no email
 * round-trip -- a preference is provisional and an estimator confirms it before pricing moves --
 * but it still carries an idempotency key so a flaky phone connection cannot double-record a tap.
 */
export async function recordCustomerPortalDecision(
  input: { token: string; optionPackageId: string; idempotencyKey: string },
  fetcher?: typeof fetch,
): Promise<CustomerPortalDecisionResponse> {
  return await apiRequest({
    path: API_PATHS.customerPortalDecision,
    method: "POST",
    body: { token: input.token, option_package_id: input.optionPackageId },
    idempotencyKey: input.idempotencyKey,
    schema: customerPortalDecisionResponseSchema,
    credentials: "omit",
    fetcher,
  });
}
