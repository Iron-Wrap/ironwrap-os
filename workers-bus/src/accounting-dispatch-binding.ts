// accounting-dispatch-binding.ts - the production `AccountingDispatchBinding`.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 3.1, 5.1 and 8.1. ELEC-72 wired the *call*:
// `index.ts` began invoking `runAccountingDispatch` on the frequent cron. ELEC-74 then proved on
// the running stack that the call reached nothing - `runAccountingDispatch(env, { tenantId })` was
// passed no binding, no production `MoneyEffectPort` existed anywhere in `src/`, and an approved
// intent therefore sat in `submission_pending` forever while the desk read "Being sent to
// QuickBooks. Nothing else to do yet." This module is the connection that was missing.
//
// Three seams, each already specified by something older:
//
//   * **The port** is `runExternalEffect` and nothing else. `accounting-effect-port.ts` says the
//     production binding is "this projection plus a call to `runExternalEffect`", and
//     `toExternalEffectShape` is the projection - so this is a pass-through that can be read in
//     one screen rather than a second ledger with its own opinions.
//   * **The auth** is `quickBooksAuthPort`, which is this Worker's existing OAuth/refresh path
//     projected onto the money plane's port (ELEC-74 named exactly this precedent). No token is
//     minted, cached, decrypted or logged here.
//   * **The adapter** is one HTTP create per intent, against the entity type the intent already
//     names, keyed by the provider request id the intent already bound. It never chooses an
//     amount, an account or a customer: everything it sends is `provider_payload_json`, settled at
//     derivation and hashed into `provider_payload_sha256`.
//
// **Unbound stays a first-class state.** `resolveAccountingDispatchBinding` returns `null` when the
// effect ledger is disabled, when QuickBooks OAuth is unconfigured, or when the tenant has no
// connected realm. That is the behaviour ELEC-74 observed and it is deliberately preserved: a
// tenant that never connected QuickBooks must keep reporting what is waiting and dispatching
// nothing, with no crash and no state change.
//
// **No live provider calls (project rule 5).** Everything above is reachable only with a real
// QuickBooks OAuth configuration *and* a connected realm, neither of which exists on a developer
// machine. The local stack points `QB_API_BASE_LOCAL_OVERRIDE` at a loopback Intuit double, which
// `quickbooks-final-invoice.ts` honours only while `APP_ALLOW_INSECURE_LOCAL` is `"true"` - a var
// `wrangler.jsonc` sets to `"false"` in every deployed environment.

import {
  MoneyEffectError,
  toExternalEffectShape,
  type MoneyDispatchResult,
  type MoneyEffectExecutor,
  type MoneyEffectOutcome,
  type MoneyEffectPort,
  type MoneyEffectRequest,
  type MoneyEffectState,
  type MoneyAttemptState,
} from "./accounting-effect-port.ts";
import type { AccountingDispatchBinding } from "./accounting-dispatch.ts";
import type { AccountingIntentRecord } from "./accounting-intents.ts";
import {
  normalizeProviderEntity,
  providerFactEnvelope,
  type AccountingEntityType,
} from "./accounting-normalizers.ts";
import {
  assertEffectLedgerReady,
  EffectRuntimeError,
  runExternalEffect,
} from "./effect-runtime.ts";
import {
  quickBooksAuthPort,
  quickBooksConnectedRealmId,
} from "./quickbooks-final-invoice.ts";
import type { QuickBooksAuthPort } from "./quickbooks-auth-port.ts";
import type { AppEnv } from "./app-types.ts";

/** What one accounting dispatch hands back to the money plane. */
export interface AccountingDispatchValue {
  providerEntityId: string;
}

/** How long the adapter waits on one Intuit call before treating the response as lost. */
const PROVIDER_TIMEOUT_MS = 10_000;

/**
 * The production money port: `MoneyEffectPort` implemented over the universal effect ledger.
 *
 * Every guarantee the money plane relies on - `UNIQUE (tenant, idempotencyKey)`, the amount
 * ceiling, the propose/authorize/execute order, expected-vs-observed readback comparison, `unknown`
 * never being retried - is the runtime's, not a reimplementation. The only work here is shape:
 * `toExternalEffectShape` for the request, an input rename for the executor, and the ledger row
 * projected back onto `MoneyEffectOutcome`.
 *
 * Errors are re-raised as `MoneyEffectError` carrying the runtime's own code, because
 * `MONEY_EFFECT_ERROR_CODES` is the vocabulary the accounting modules branch on and a leaked
 * `EffectRuntimeError` would be an unhandled throw one layer up.
 */
export function externalEffectMoneyPort(env: AppEnv): MoneyEffectPort {
  return {
    assertReady(): void {
      try {
        assertEffectLedgerReady(env);
      } catch (error) {
        throw asMoneyEffectError(error, "effect_runtime_required");
      }
    },

    async run<T>(
      input: MoneyEffectRequest,
      executor: MoneyEffectExecutor<T>,
      now: Date = new Date(),
    ): Promise<MoneyEffectOutcome<T>> {
      const projected = toExternalEffectShape(input);
      try {
        const result = await runExternalEffect<T>(env, projected, {
          ...(executor.preconditions
            ? {
              preconditions: (runtime: { effect: { effect_id: string } }) =>
                executor.preconditions!({ effectId: runtime.effect.effect_id }),
            }
            : {}),
          dispatch: (runtime) =>
            executor.dispatch({
              effectId: runtime.effect.effect_id,
              attemptId: runtime.attemptId,
              businessIdempotencyKey: runtime.businessIdempotencyKey,
            }),
          readback: (runtime) =>
            executor.readback({
              effectId: runtime.effect.effect_id,
              providerExternalId: runtime.providerExternalId,
            }),
          replay: (runtime) => executor.replay({ effectId: runtime.effect.effect_id }),
        }, now);

        return {
          effectId: result.effect.effect_id,
          // `MONEY_EFFECT_STATES` is asserted identical to `EXTERNAL_EFFECT_STATES` in
          // `accounting-port.test.ts`, so this is a rename rather than a mapping that could drift.
          state: result.effect.state as MoneyEffectState,
          attemptId: result.attempt?.attempt_id ?? null,
          attemptState: (result.attempt?.state ?? null) as MoneyAttemptState | null,
          providerExternalId: result.effect.provider_external_id,
          requestHash: result.effect.request_hash,
          providerResponseHash: result.effect.provider_response_hash,
          readbackHash: result.effect.readback_hash,
          resultCode: result.effect.result_code,
          value: result.value,
        };
      } catch (error) {
        throw asMoneyEffectError(error, "effect_dispatch_failed");
      }
    },
  };
}

function asMoneyEffectError(error: unknown, fallback: string): MoneyEffectError {
  if (error instanceof MoneyEffectError) return error;
  if (error instanceof EffectRuntimeError) return new MoneyEffectError(error.code);
  return new MoneyEffectError(error instanceof Error ? error.message : fallback);
}

/**
 * The provider adapter for one money intent: create the entity, then read it back.
 *
 * It sends `provider_payload_json` verbatim. That matters more than it looks: the payload was
 * built at derivation, hashed into `provider_payload_sha256`, and projected into the expectation
 * this dispatch will be judged against, so an adapter that rebuilt or "corrected" it would be
 * asserting facts nobody approved.
 *
 * `requestid` is Intuit's own idempotency parameter and carries the intent's bound
 * `provider_request_id` - the second half of the duplicate-create defence, beside the ledger's
 * business key (section 5.4). A retried attempt therefore cannot create a second entity even if the
 * first response was lost.
 */
export function accountingIntentExecutor(input: {
  intent: AccountingIntentRecord;
  auth: QuickBooksAuthPort;
  fetcher?: typeof fetch;
}): MoneyEffectExecutor<AccountingDispatchValue> {
  const { intent } = input;
  const fetcher = input.fetcher ?? fetch;
  const entityType = intent.provider_entity_type as AccountingEntityType | null;

  async function readEntity(providerExternalId: string | null) {
    if (!providerExternalId || !entityType) {
      return {
        status: "unavailable" as const,
        detailCode: "accounting_provider_entity_id_missing",
      };
    }
    const realm = await input.auth.activeRealm(intent.tenant_id);
    const response = await timed(fetcher, entityUrl(realm.apiBase, realm.realmId, entityType,
      providerExternalId, realm.minorVersion), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${realm.accessToken}` },
    });
    if (response.status === 404) {
      return { status: "not_found" as const, detailCode: "provider_entity_absent" };
    }
    if (!response.ok) {
      return { status: "unavailable" as const, detailCode: providerReadCode(response.status) };
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const entity = body?.[entityType];
    if (entity === undefined || entity === null) {
      return { status: "unavailable" as const, detailCode: "provider_response_unreadable" };
    }
    const normalized = normalizeProviderEntity({
      realmId: realm.realmId,
      entityType,
      payload: entity,
    });
    return {
      status: "match" as const,
      providerExternalId: normalized.entityId,
      // The same envelope shape the expectation was hashed over, so the ledger's own
      // expected-vs-observed comparison is the section 5.2 comparison and not a second one.
      observed: providerFactEnvelope(normalized),
    };
  }

  return {
    async dispatch(): Promise<MoneyDispatchResult<AccountingDispatchValue>> {
      if (!entityType) {
        return { outcome: "rejected", detailCode: "accounting_provider_entity_type_missing" };
      }
      const realm = await input.auth.activeRealm(intent.tenant_id);
      // The realm the intent was derived against is the realm it may be dispatched into. A
      // connection that moved to a different company is a refusal, never a posting into the wrong
      // set of books.
      if (realm.realmId !== intent.realm_id) {
        return { outcome: "rejected", detailCode: "accounting_provider_realm_mismatch" };
      }
      const url = `${trimSlash(realm.apiBase)}/v3/company/${encodeURIComponent(realm.realmId)}`
        + `/${entityType.toLowerCase()}?minorversion=${encodeURIComponent(realm.minorVersion)}`
        + `&requestid=${encodeURIComponent(intent.provider_request_id)}`;
      let response: Response;
      try {
        response = await timed(fetcher, url, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${realm.accessToken}`,
            "content-type": "application/json",
          },
          body: intent.provider_payload_json,
        });
      } catch {
        // A lost request is `unknown`, never `rejected`: section 5.4 forbids retrying a create
        // whose outcome nobody observed, and the ledger's own reconciliation is what resolves it.
        return { outcome: "unknown", detailCode: "provider_unreachable" };
      }
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) {
        return response.status === 408 || response.status === 429 || response.status >= 500
          ? { outcome: "unknown", providerResponse: body, detailCode: "provider_unavailable" }
          : {
            outcome: "rejected",
            providerResponse: body,
            detailCode: "accounting_provider_create_rejected",
          };
      }
      const created = body?.[entityType] as Record<string, unknown> | undefined;
      const providerEntityId = typeof created?.Id === "string" ? created.Id : null;
      if (!providerEntityId) {
        return {
          outcome: "unknown",
          providerResponse: body,
          detailCode: "provider_response_unreadable",
        };
      }
      return {
        outcome: "accepted",
        value: { providerEntityId },
        providerExternalId: providerEntityId,
        providerResponse: body,
      };
    },

    async readback({ providerExternalId }) {
      try {
        return await readEntity(providerExternalId);
      } catch {
        return { status: "unavailable", detailCode: "provider_readback_unavailable" };
      }
    },

    async replay() {
      // Only reachable on an exact replay of an already-succeeded effect, where the ledger holds
      // the identity: re-read it rather than trusting a create response we no longer have.
      const read = await readEntity(intent.provider_entity_id);
      if (read.status !== "match" || !read.providerExternalId) {
        throw new MoneyEffectError("accounting_provider_replay_unavailable");
      }
      return { providerEntityId: read.providerExternalId };
    },
  };
}

/**
 * Build the tenant's dispatcher binding, or `null` when there is nothing to bind to.
 *
 * Three unbound answers, all normal and all silent: the effect ledger is off, QuickBooks OAuth is
 * unconfigured, or this tenant has never connected a realm. Each leaves the dispatcher in the
 * report-only mode it already implements, which is what keeps an unconfigured tenant's behaviour
 * exactly what it was before this module existed.
 */
export async function resolveAccountingDispatchBinding(
  env: AppEnv,
  input: { tenantId: string; fetcher?: typeof fetch },
): Promise<AccountingDispatchBinding | null> {
  try {
    assertEffectLedgerReady(env);
  } catch {
    return null;
  }
  const fetcher = input.fetcher ?? fetch;
  const auth = quickBooksAuthPort(env, fetcher);
  if (!auth) return null;
  // Asked without minting a token: an unconfigured tenant must not provoke a refresh attempt on
  // every cron tick just to discover there is nothing to refresh.
  const realmId = await quickBooksConnectedRealmId(env, input.tenantId).catch(() => null);
  if (!realmId) return null;

  return {
    port: externalEffectMoneyPort(env),
    executorFor: ({ intent }) => accountingIntentExecutor({ intent, auth, fetcher }),
    auth,
    fetcher,
    // `MoneyActorType` predates the accounting role, so a scheduled money mutation runs as
    // `worker`: the actor that is neither a person claiming authority they did not exercise nor an
    // agent pretending a human pressed the button. The human's decision is the approval the intent
    // already carries.
    actor: { type: "worker", id: "accounting-dispatch" },
  };
}

function entityUrl(
  apiBase: string,
  realmId: string,
  entityType: AccountingEntityType,
  entityId: string,
  minorVersion: string,
): string {
  return `${trimSlash(apiBase)}/v3/company/${encodeURIComponent(realmId)}`
    + `/${entityType.toLowerCase()}/${encodeURIComponent(entityId)}`
    + `?minorversion=${encodeURIComponent(minorVersion)}`;
}

function providerReadCode(status: number): string {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_throttled";
  return "provider_error";
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function timed(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
