// accounting-provider-read.ts - the authenticated provider-detail read (slice S3).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5.1 defines `reconciled` in terms of one
// mechanism: "an authenticated provider-detail read of the exact provider entity id". This module
// is that mechanism and nothing else. It never mutates: every provider *write* goes through
// `MoneyEffectPort`, and a module that could both read and write would make it possible to reach a
// settled state without the ledger ever seeing the mutation.
//
// It holds no credential. The realm, token, host and minor version all come from
// `QuickBooksAuthPort` (slice S0), and the transport is an injected `fetcher` following the
// convention the final-invoice module already uses. Under test the fetcher is a synthetic Intuit
// double; there is no code path here that reaches a real provider by default, and project rule 5
// forbids one.

import type { QuickBooksAuthPort } from "./quickbooks-auth-port.ts";
import {
  normalizeProviderEntity,
  type AccountingEntityType,
  type NormalizedEntityFacts,
} from "./accounting-normalizers.ts";

/** How this read was triggered. A webhook is a trigger, never evidence (section 5.1). */
export type ProviderReadSource =
  | "dispatch_readback"
  | "webhook_triggered_read"
  | "sweep"
  | "recovery_query";

export type ProviderReadResult =
  | {
    status: "ok";
    realmId: string;
    entityType: AccountingEntityType;
    entityId: string;
    payload: unknown;
    normalized: NormalizedEntityFacts;
    readAt: string;
    source: ProviderReadSource;
    effectAttemptId?: string | null;
    /**
     * Other provider entities the same bounded search matched. Non-empty means the provider holds
     * a duplicate of something we created once, which section 5.4 answers with
     * `duplicate_provider_entity` - never an automatic delete.
     */
    duplicateEntityIds?: readonly string[];
  }
  | {
    status: "not_found";
    realmId: string;
    entityType: AccountingEntityType;
    entityId: string;
    readAt: string;
    source: ProviderReadSource;
    detailCode?: string | null;
  }
  | {
    /** Unreachable, throttled, or refused. Retryable, and never a verdict of record (section 5.3). */
    status: "unavailable";
    detailCode: string;
  };

export interface ReadProviderEntityInput {
  tenantId: string;
  entityType: AccountingEntityType;
  entityId: string;
  source: ProviderReadSource;
  effectAttemptId?: string | null;
}

/**
 * Read one entity by its exact provider id.
 *
 * Every non-200 becomes a status rather than a throw, because the caller's next step differs per
 * class: `not_found` is an accounting fact that opens an exception, `unavailable` is an outage that
 * must leave every money state exactly as it was.
 */
export async function readProviderEntity(
  auth: QuickBooksAuthPort,
  input: ReadProviderEntityInput,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<ProviderReadResult> {
  let realm;
  try {
    realm = await auth.activeRealm(input.tenantId);
  } catch (error) {
    return { status: "unavailable", detailCode: errorCode(error, "quickbooks_connection_required") };
  }

  const url = `${trimTrailingSlash(realm.apiBase)}/v3/company/${encodeURIComponent(realm.realmId)}`
    + `/${entityPath(input.entityType)}/${encodeURIComponent(input.entityId)}`
    + `?minorversion=${encodeURIComponent(realm.minorVersion)}`;

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: {
        // The token reaches the request and nothing else: it is never logged, never persisted,
        // and never written to evidence (section 6).
        authorization: `Bearer ${realm.accessToken}`,
        accept: "application/json",
      },
    });
  } catch (error) {
    return { status: "unavailable", detailCode: errorCode(error, "provider_unreachable") };
  }

  const readAt = now.toISOString();
  if (response.status === 404) {
    return {
      status: "not_found",
      realmId: realm.realmId,
      entityType: input.entityType,
      entityId: input.entityId,
      readAt,
      source: input.source,
      detailCode: "provider_entity_absent",
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable",
      detailCode: response.status === 401 || response.status === 403
        ? "provider_auth_failed"
        : response.status === 429
          ? "provider_throttled"
          : "provider_error",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable", detailCode: "provider_response_unreadable" };
  }

  const entity = (body as Record<string, unknown> | null)?.[input.entityType];
  if (entity === undefined || entity === null) {
    return { status: "unavailable", detailCode: "provider_response_unreadable" };
  }

  const normalized = normalizeProviderEntity({
    realmId: realm.realmId,
    entityType: input.entityType,
    payload: entity,
  });
  return {
    status: "ok",
    realmId: realm.realmId,
    entityType: input.entityType,
    entityId: normalized.entityId,
    payload: entity,
    normalized,
    readAt,
    source: input.source,
    effectAttemptId: input.effectAttemptId ?? null,
  };
}

/**
 * Read the provider's own rate for each bound tax code, for the section 5.4 drift preflight.
 *
 * A code whose read is unavailable is simply absent from the result: a rate we could not read is
 * not a rate that differs, and treating an outage as drift would block submissions for the duration
 * of a provider incident.
 */
export async function readProviderTaxRates(
  auth: QuickBooksAuthPort,
  input: {
    tenantId: string;
    /** Tax code to the provider TaxRate id recorded on its snapshot. */
    taxRateIdsByCode: ReadonlyMap<string, string>;
  },
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<Map<string, NormalizedEntityFacts>> {
  const rates = new Map<string, NormalizedEntityFacts>();
  for (const [taxCode, taxRateId] of input.taxRateIdsByCode) {
    const read = await readProviderEntity(auth, {
      tenantId: input.tenantId,
      entityType: "TaxRate",
      entityId: taxRateId,
      source: "sweep",
    }, fetcher, now);
    if (read.status === "ok") rates.set(taxCode, read.normalized);
  }
  return rates;
}

/** Intuit's path segment for an entity type: lower-case, e.g. `creditmemo`. */
function entityPath(entityType: AccountingEntityType): string {
  return entityType.toLowerCase();
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : fallback;
}
