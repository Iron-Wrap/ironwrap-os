import { apiRequest } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import {
  customerContractAcceptanceChallengeResponseSchema,
  customerContractAcceptanceConfirmResponseSchema,
  customerPortalDecisionResponseSchema,
  customerPortalResponseSchema,
  type CustomerContractAcceptanceChallengeResponse,
  type CustomerContractAcceptanceConfirmResponse,
  type CustomerPortalDecisionResponse,
  type CustomerPortalResponse,
} from "./portal-contracts";

/** Public capability resolver: never attach an office/session cookie to this request. */
export async function loadCustomerPortal(
  token: string,
  fetcher?: typeof fetch,
): Promise<CustomerPortalResponse> {
  return await apiRequest({
    path: API_PATHS.customerPortalResolve,
    method: "POST",
    body: { token },
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
