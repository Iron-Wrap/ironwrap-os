// accounting-api.ts - the money desk BFF surface (slice S8).
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.1 lists seventeen routes under
// `/api/v1/accounting/`, all behind the app BFF session, CSRF, and an `Idempotency-Key` header on
// every command - the exact conventions of `handleQuickBooksFinalInvoiceCommand`. This module owns
// that path space the way `service-cases.ts` owns `/api/v1/service-cases`.
//
// It contains no business logic. Every route is: check who is asking, parse a bounded request,
// call the S1-S5 engine, project the result through `accounting-desk.ts`. The state machine, the
// D1 triggers, and the reconciliation engine remain the enforcement boundary; this decides only
// who may ask and what a refusal looks like on the wire.
//
// Four rules shape the handlers below:
//
//  1. **Attribution comes from the session.** `actorUserId` is `auth.session.user_id` and nothing
//     else, which is what makes separation of duty (section 6) hold: a caller cannot approve as
//     somebody else because the body has nowhere to say so.
//  2. **No identifier is minted from the body.** The intent and exception ids come from the path
//     and are read back tenant-scoped, so a guessed id from another tenant reads as `not_found`.
//  3. **A refused transition is not a server fault.** D1's `RAISE(ABORT, 'accounting_…')` reaches
//     the caller as its own code at 409, never as a 502. Real D1 wraps every failure as
//     `D1_ERROR: <message>: SQLITE_CONSTRAINT (extended: …)`, so the code is extracted from that
//     string rather than compared against it - the defect class ELEC-22 section 5 recorded.
//  4. **Holdback and payroll are served and gated, and refuse honestly.** Slices S6 and S7 have
//     not shipped, so their six routes authenticate, authorize, and then answer `501` naming the
//     slice. A route that 404s would be indistinguishable from a typo; one that pretended to work
//     would be worse than either.
//
// Slice S11 adds the two origins section 8.1's table never had, both for the same reason deviation
// 6 added `POST /intents`: the engine function existed, nothing outside a test called it, and the
// product was therefore unreachable at that step. `POST /tax/snapshots` is the statutory rate a
// derivation binds - without it `deriveIntent` answers `tax_mapping_missing` forever on a fresh
// tenant - and `reconcile` now performs the authenticated re-read it only ever pretended to
// trigger, which is what makes `reconciled` reachable and the drift exception raisable at all.

import { configuredTenantId, validAppCsrf } from "./app-auth.ts";
import {
  moneyIntentJobEligible,
  readMoneyIntentJobReference,
  type MoneyIntentJobDirectory,
  type MoneyIntentJobEligibility,
  type MoneyIntentJobReference,
} from "./accounting-job-reference.ts";
import {
  compensationAuthorityLevel,
  offeredRemedies,
  planAccountingCompensation,
} from "./accounting-compensation.ts";
import {
  listTaxSnapshotsForPeriod,
  periodWindow,
  projectAccountingException,
  projectAccountingIntent,
  proposeTaxRemittance,
  queueStates,
  readAccountingIntentDetail,
  summarizeAccountingDesk,
  type AccountingQueue,
} from "./accounting-desk.ts";
import {
  ACCOUNTING_EXCEPTION_RESOLUTIONS,
  listAccountingExceptions,
  resolveAccountingException,
  type AccountingExceptionResolution,
  type AccountingExceptionStatus,
} from "./accounting-exceptions.ts";
import {
  ACCOUNTING_INTENT_KINDS,
  ACCOUNTING_INTENT_STATES,
  applyAccountingIntentCommand,
  deriveAccountingIntentForRequest,
  listAccountingIntents,
  readAccountingIntent,
  type AccountingIntentKind,
  type AccountingIntentState,
} from "./accounting-intents.ts";
import { recordAccountingCompensationAuthorization } from "./accounting-compensation-authorizations.ts";
import { readAccountingAuthorityCeiling } from "./accounting-authority-policy.ts";
import { localFactEnvelope, type AccountingEntityType } from "./accounting-normalizers.ts";
import {
  bindAccountingIntentTaxSnapshots,
  currentTaxPolicySnapshot,
  recordTaxPolicySnapshot,
  taxBindingSetSha256,
} from "./accounting-tax-snapshots.ts";
import {
  readNativeInitialProviderMapping,
} from "./native-final-invoice-producer.ts";
import {
  reobserveAccountingIntent,
  resolveAccountingObservationBinding,
  type AccountingObservationBinding,
} from "./accounting-reobservation.ts";
import { APP_API_VERSION, type AppEnv, type AuthContext } from "./app-types.ts";

const MAX_ACCOUNTING_BODY_BYTES = 8 * 1024;
const DEFAULT_LIST_LIMIT = 50;

/** The rejection reasons an accountant may record against a money intent. */
export const ACCOUNTING_REJECTION_REASONS = [
  "amount_disputed",
  "paperwork_missing",
  "customer_mapping_missing",
  "item_mapping_missing",
  "tax_mapping_missing",
  "terms_mapping_missing",
  "superseded_by_new_figures",
  "not_owed",
] as const;

export type AccountingRejectionReason = (typeof ACCOUNTING_REJECTION_REASONS)[number];

/** Everything this surface can do, so the browser renders the buttons the role really has. */
export const ACCOUNTING_ALLOWED_ACTIONS = [
  "accounting.read",
  "accounting.intent.approve",
  "accounting.intent.reject",
  "accounting.intent.reconcile",
  "accounting.intent.compensate",
  "accounting.exception.resolve",
  "accounting.holdback.release",
  "accounting.payroll.review",
] as const;

const ACTION_PERMISSION: Readonly<Record<(typeof ACCOUNTING_ALLOWED_ACTIONS)[number], string>> = {
  "accounting.read": "accounting:read",
  "accounting.intent.approve": "accounting:approve",
  "accounting.intent.reject": "accounting:review",
  "accounting.intent.reconcile": "accounting:reconcile",
  "accounting.intent.compensate": "accounting:compensate",
  "accounting.exception.resolve": "accounting:reconcile",
  "accounting.holdback.release": "accounting:holdback_release",
  "accounting.payroll.review": "accounting:payroll",
};

/**
 * Owns every `/api/v1/accounting` path, the way `service-cases.ts` owns its own.
 *
 * The QuickBooks connection routes that predate this slice live under `/api/v1/quickbooks/`, so
 * this path space is exclusively the money desk's and an unclaimed path here is a 404 rather than
 * a fall-through into somebody else's router.
 */
/**
 * The seams the money desk's routes take from outside `env`. Production sets none of them.
 *
 * The first is the re-observation binding, and it exists because a route that reaches QuickBooks
 * has to be provable without one: production leaves it unset and the reconcile route resolves the
 * tenant's own connection, while a test hands in the same binding shape built over a synthetic
 * Intuit double. `undefined` means "resolve it"; an explicit `null` means "there is none", which
 * is the unbound answer an unconnected tenant gets and must keep getting.
 *
 * The other two are the derive route's job gate, for the same reason in a different plane: the
 * gate reads the tenant's operating core, and a money-plane route test has no Frappe behind it.
 */
export interface AccountingRouteDeps {
  observation?: AccountingObservationBinding | null;
  /**
   * How the derive route resolves the job it is asked to bill against (ELEC-112 finding 3).
   * Unset in production, where the reference is read from the tenant's own operating core; a
   * route test hands in a double so the gate is provable without a Frappe behind the Worker.
   */
  jobDirectory?: MoneyIntentJobDirectory;
  /**
   * The eligibility predicate the job gate applies, and a test seam rather than a policy switch:
   * production never sets it, and the ruling on the eligibility semantics is a change to
   * `moneyIntentJobEligible` itself. It exists so `accounting_intent_roof_job_not_eligible` is a
   * proven wire today instead of a branch that has never been reached.
   */
  jobEligibility?: MoneyIntentJobEligibility;
}

export async function handleAccountingRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  deps: AccountingRouteDeps = {},
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/v1\/accounting\/?/, "");
  const segments = path.length === 0 ? [] : path.split("/").map(decodeSegment);
  if (segments.some((segment) => segment === null)) return json({ error: "not_found" }, 404);
  const parts = segments as string[];
  if (parts.length === 0) return json({ error: "not_found" }, 404);

  const head = parts[0];
  if (head === "summary" && parts.length === 1) {
    return req.method === "GET"
      ? await readSummary(env, auth, url)
      : json({ error: "not_found" }, 404);
  }
  if (head === "intents") return await intentRoute(req, env, auth, url, parts, deps);
  if (head === "exceptions") return await exceptionRoute(req, env, auth, url, parts);
  if (head === "tax") return await taxRoute(req, env, auth, url, parts);
  if (head === "holdback") return holdbackRoute(req, auth, parts);
  if (head === "payroll") return payrollRoute(req, auth, parts);
  return json({ error: "not_found" }, 404);
}

// ------------------------------------------------------------------------------------ summary

async function readSummary(env: AppEnv, auth: AuthContext, url: URL): Promise<Response> {
  const denied = denyUnless(auth, "accounting:read");
  if (denied) return denied;
  const staleAfterSeconds = boundedSeconds(url.searchParams.get("stale_after_seconds"));
  try {
    const now = new Date();
    const summary = await summarizeAccountingDesk(env, auth.session.tenant_id, {
      now,
      ...(staleAfterSeconds === null ? {} : { staleAfterSeconds }),
    });
    // The desk paints four queues from one request: a phone on a job site should not need five
    // round trips before an office manager can see what is waiting.
    const [needsApproval, awaitingProvider, mismatched, exceptions] = await Promise.all([
      listAccountingIntents(env, auth.session.tenant_id, {
        states: queueStates("needs_approval"),
        limit: 20,
      }),
      listAccountingIntents(env, auth.session.tenant_id, {
        states: queueStates("awaiting_provider"),
        limit: 20,
      }),
      listAccountingIntents(env, auth.session.tenant_id, {
        states: queueStates("mismatched"),
        limit: 20,
      }),
      listAccountingExceptions(env, auth.session.tenant_id),
    ]);
    const live = exceptions.filter((exception) => exception.status !== "resolved").slice(0, 20);
    return json(envelope(auth, {
      summary,
      queues: {
        needs_approval: needsApproval.map((intent) => projectAccountingIntent(intent, now)),
        awaiting_provider: awaitingProvider.map((intent) => projectAccountingIntent(intent, now)),
        mismatched: mismatched.map((intent) => projectAccountingIntent(intent, now)),
        exceptions: live.map((exception) => projectAccountingException(exception, now)),
      } satisfies Record<AccountingQueue, unknown>,
    }));
  } catch (error) {
    return engineError(error);
  }
}

// ------------------------------------------------------------------------------------- intents

async function intentRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  url: URL,
  parts: readonly string[],
  deps: AccountingRouteDeps,
): Promise<Response> {
  if (req.method === "GET" && parts.length === 1) return await listIntents(env, auth, url);
  if (req.method === "POST" && parts.length === 1)
    return await deriveIntent(req, env, auth, deps);

  const intentId = parts[1];
  if (!intentId) return json({ error: "not_found" }, 404);
  if (req.method === "GET" && parts.length === 2) return await readIntent(env, auth, intentId);
  if (req.method !== "POST" || parts.length !== 3) return json({ error: "not_found" }, 404);

  const action = parts[2];
  if (action === "approve") return await commandIntent(req, env, auth, intentId, "approve", deps);
  if (action === "reject") return await commandIntent(req, env, auth, intentId, "reject", deps);
  if (action === "reconcile") {
    return await commandIntent(req, env, auth, intentId, "reconcile", deps);
  }
  if (action === "compensate") return await compensateIntent(req, env, auth, intentId);
  return json({ error: "not_found" }, 404);
}

/**
 * Derive one money intent candidate (the production origin, contract section 4.2).
 *
 * Section 8.1's route table has no create row, and that is the gap ELEC-71 hit: derivation was
 * engine-only, so nothing outside a test could put an intent on the desk in the first place and
 * every journey started from a hand-seeded row. This is deviation 6 in section 0 - an eighteenth
 * route - and it is a *derivation* request, not a create: the caller names the job and the
 * commercial basis, and the engine computes the payload, the expectation, the tax binding and the
 * hashes. Nothing here reaches a provider; a candidate lands in `pending_review` exactly as
 * section 6 requires, because "derivation is not a side effect" and the approval is still the gate.
 *
 * Permission is `accounting:review` rather than `accounting:approve`, for the same reason: putting
 * a candidate in front of a reviewer is reviewing work, and separation of duty (section 6) is
 * enforced by the approve command refusing the deriving user, not by hiding the derive route.
 *
 * Two things ELEC-77 found missing here, both of which made a stated guarantee untrue rather than
 * merely absent: the derivation was attributed to nobody, so the approve-time separation-of-duty
 * check compared `NULL` against a real user id and never refused; and the `Idempotency-Key` this
 * route requires was never used, so one key could derive two different intents. Both are closed
 * below - attribution comes from the session like every other actor in this file (rule 1 at the top
 * of the module), and the key is enforced through `0065`'s derivation receipts exactly as
 * approve/reject/compensate are enforced through the command receipts.
 *
 * ELEC-112 finding 3 found the third thing missing, and of the same kind: `roof_job_id` was taken
 * on trust. A job that had never existed derived a real, approvable deposit invoice, because the
 * only thing standing between the body and the engine was a text pattern. `gateDerivationJob`
 * below closes that - the job must resolve in the caller's own tenant, and it must be eligible -
 * and it runs before the tax lookup so a reference nobody can honour is refused before anything is
 * computed from it.
 */
async function deriveIntent(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  deps: AccountingRouteDeps,
): Promise<Response> {
  const denied = denyUnless(auth, "accounting:review");
  if (denied) return denied;
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  // `authority_max_amount` is deliberately absent from this list, and its absence is the fix for
  // ELEC-73 finding 2: a caller that sends it now gets `unexpected_field`, rather than being
  // allowed to declare the ceiling that is supposed to gate it. The ceiling is read from the
  // tenant's policy below.
  if (!onlyKeys(body, [
    "kind", "roof_job_id", "realm_id", "customer_ref", "item_ref", "tax_code_ref", "currency_ref",
    "subtotal", "tax_amount", "txn_date", "due_date", "source_documents", "jurisdiction",
    "tax_code",
  ])) {
    return json({ error: "unexpected_field" }, 400);
  }

  const kind = oneOf<AccountingIntentKind>(body.kind, DERIVABLE_KINDS);
  const roofJobId = refText(body.roof_job_id, 1, 160);
  const realmId = refText(body.realm_id, 1, 32);
  const customerRef = refText(body.customer_ref, 1, 40);
  const itemRef = refText(body.item_ref, 1, 40);
  const taxCodeRef = refText(body.tax_code_ref, 1, 40);
  const subtotal = decimalText(body.subtotal);
  const taxAmount = decimalText(body.tax_amount);
  const txnDate = isoDate(body.txn_date);
  const dueDate = isoDate(body.due_date);
  const jurisdiction = refText(body.jurisdiction, 2, 32);
  const taxCode = refText(body.tax_code, 1, 32);
  const currencyRef = body.currency_ref === undefined ? "CAD" : refText(body.currency_ref, 3, 3);
  if (
    kind === null || roofJobId === null || realmId === null || !/^\d+$/.test(realmId)
    || customerRef === null || itemRef === null || taxCodeRef === null || subtotal === null
    || taxAmount === null || txnDate === null || dueDate === null
    || jurisdiction === null || taxCode === null || currencyRef === null
  ) {
    return json({ error: "invalid_accounting_intent_derivation" }, 400);
  }
  const sourceDocuments = sourceDocumentList(body.source_documents);
  if (sourceDocuments === null) {
    return json({ error: "invalid_accounting_intent_derivation" }, 400);
  }

  // The job reference is checked before anything is derived from it: a refusal here has written
  // nothing, so - like `tax_mapping_missing` - it does not burn the idempotency key either.
  const jobRefusal = await gateDerivationJob(env, auth, deps, roofJobId, kind);
  if (jobRefusal) return jobRefusal;

  const totalCents = centsOf(subtotal) + centsOf(taxAmount);
  const totalAmount = decimalOf(totalCents);

  try {
    const tenantId = auth.session.tenant_id;
    const mapping = await readNativeInitialProviderMapping(env, tenantId, roofJobId);
    if (mapping.status === "ambiguous") {
      return json({ error: "provider_mapping_ambiguous" }, 409);
    }
    if (mapping.status === "missing") {
      return json({
        error: "provider_mapping_missing",
        next_step: "record_native_provider_mapping",
      }, 409);
    }
    if (mapping.status === "found") {
      const binding = mapping.value;
      if (
        binding.realm_id !== realmId
        || binding.qbo_customer_id !== customerRef
        || binding.qbo_item_id !== itemRef
        || binding.qbo_tax_code_id !== taxCodeRef
        || binding.jurisdiction !== jurisdiction
        || binding.tax_code !== taxCode
      ) {
        return json({ error: "provider_mapping_request_mismatch" }, 409);
      }
    }
    // Section 5.4 binds the snapshot at derivation and never rewrites it. No current snapshot is a
    // refusal, not a derivation with an unbound rate: `tax_mapping_missing` is the blocker
    // vocabulary PR #43 already established for exactly this.
    const snapshot = await currentTaxPolicySnapshot(env, {
      tenantId, jurisdiction, taxCode, onDate: txnDate,
    });
    if (!snapshot) return json({ error: "tax_mapping_missing" }, 409);

    // Section 6's ceiling, read from the tenant's own policy rather than taken from the request.
    // A tenant that has recorded no policy gets the conservative platform default, and a
    // derivation above whichever applies refuses with `effect_policy_amount_ceiling_exceeded`
    // (403) inside `deriveAccountingIntent` rather than deriving a candidate nobody may approve.
    const ceiling = await readAccountingAuthorityCeiling(env, {
      tenantId, kind, onDate: txnDate,
    });

    const providerPayload = {
      CustomerRef: { value: customerRef },
      CurrencyRef: { value: currencyRef },
      TxnDate: txnDate,
      DueDate: dueDate,
      TotalAmt: totalAmount,
      TxnTaxDetail: { TotalTax: taxAmount },
      Line: [{
        DetailType: "SalesItemLineDetail",
        Amount: subtotal,
        SalesItemLineDetail: {
          ItemRef: { value: itemRef },
          TaxCodeRef: { value: taxCodeRef },
        },
      }],
    };
    const basis = {
      roofJobId,
      kind,
      subtotal,
      taxAmount,
      totalAmount,
      txnDate,
      dueDate,
      customerRef,
      itemRef,
      taxCodeRef,
      sourceDocuments,
      taxSnapshotSha256: snapshot.snapshot_sha256,
    };
    // Derived from the basis rather than taken from the body: an id a caller could choose is an id
    // a caller could collide, and `deriveAccountingIntent` is already idempotent on the basis hash.
    const intentId = `acct-intent:${roofJobId}:${kind}:${await shortHash(basis)}`.slice(0, 160);

    const { intent, replayed } = await deriveAccountingIntentForRequest(env, {
      tenantId,
      intentId,
      kind,
      roofJobId,
      basis,
      sourceDocuments,
      // The facts a readback must return, minus the `Id` the provider has not assigned yet; the
      // dispatcher completes it from the identity the ledger settles (accounting-expectations.ts).
      expected: localFactEnvelope({
        realmId,
        entityType: PROVIDER_ENTITY_BY_DERIVABLE_KIND[kind],
        payload: providerPayload,
      }),
      taxPolicySnapshotSha256: await taxBindingSetSha256([snapshot.snapshot_sha256]),
      realmId,
      providerPayload,
      providerRequestId: `req-${intentId}`.slice(0, 50),
      subtotal,
      taxAmount,
      totalAmount,
      authority: {
        permitRef: "permit:accounting:money",
        policyRef: "policy:accounting:money.create",
        policyVersion: "v1",
        maxAmount: ceiling.maxAmount,
      },
      effectIdempotencyKey: `acct:${intentId}:v1`,
      // The person who derived, from the session - not the literal `agent` this used to record.
      // Section 6's separation of duty is enforced by the approve command refusing the deriving
      // user, and an unattributed derivation makes that comparison `NULL = <user id>`, which is
      // never true: the check was dead code for every intent the API had ever created (ELEC-77
      // defect 1). Only `owner` and `accounting` hold `accounting:review`, so those are the two
      // actor kinds this route can record. An agent-derived intent still exists - the dispatcher
      // derives reversals that way - and it keeps `derived_by_user_id` null, which leaves the
      // approve gate open to every human, as it should for work no human claimed.
      derivedBy: {
        actorKind: auth.session.role === "owner" ? "owner" : "accounting",
        userId: auth.session.user_id,
      },
      // The `Idempotency-Key` this route has required since it shipped, now enforced rather than
      // only demanded: the same key with the same figures replays the intent it already derived,
      // and the same key with different figures is refused (ELEC-77 defect 2).
      idempotencyKey: key,
      request: {
        kind, roofJobId, realmId, customerRef, itemRef, taxCodeRef, currencyRef, subtotal,
        taxAmount, txnDate, dueDate, jurisdiction, taxCode, sourceDocuments,
      },
    });
    // A replay wrote nothing, so it binds nothing either; the binding it would repeat is already
    // on the intent it is echoing.
    if (!replayed) {
      await bindAccountingIntentTaxSnapshots(env, {
        tenantId, intentId: intent.intent_id, snapshots: [snapshot],
      });
    }

    return json(
      envelope(auth, { intent: projectAccountingIntent(intent, new Date()), replayed }),
      // Nothing was enqueued: a candidate settles locally and waits for a reviewer. A replay
      // created nothing at all, so it answers 200 the way a replayed command does.
      replayed ? 200 : 201,
    );
  } catch (error) {
    return engineError(error);
  }
}

/**
 * The job gate for a derivation: exists, is this tenant's, and is eligible (ELEC-112 finding 3).
 *
 * Three refusals, and the split between them is the point:
 *
 *  - `accounting_intent_roof_job_not_found` (404) covers both "no such job" and "not yours". Rule
 *    2 at the top of this module already says an id from another tenant reads as `not_found`, and
 *    that has to hold here too: a distinct cross-tenant refusal would confirm that the job exists
 *    somewhere, which is a disclosure the money desk has no business making. The operating core
 *    behind `ERPNEXT_BASE_URL` belongs to the configured tenant, so a session from any other
 *    tenant can have no readable job in it at all and is refused without a lookup.
 *  - `accounting_job_directory_unavailable` (503) is what an unreachable operating core gets. It
 *    is deliberately not a pass: "we could not check" must never be worth more than "we checked".
 *  - `accounting_intent_roof_job_not_eligible` (409) is the eligibility seam's refusal. It is
 *    unreachable today by construction - `moneyIntentJobEligible` accepts every existing job -
 *    and it is wired, tested and named now so the pending ruling on the eligibility semantics is
 *    a one-line change in `accounting-job-reference.ts` rather than a route change.
 */
async function gateDerivationJob(
  env: AppEnv,
  auth: AuthContext,
  deps: AccountingRouteDeps,
  roofJobId: string,
  kind: AccountingIntentKind,
): Promise<Response | null> {
  if (auth.session.tenant_id !== configuredTenantId(env)) {
    return json({ error: "accounting_intent_roof_job_not_found" }, 404);
  }
  const resolve = deps.jobDirectory ?? readMoneyIntentJobReference;
  let job: MoneyIntentJobReference | null;
  try {
    job = await resolve(env, roofJobId);
  } catch {
    return json({ error: "accounting_job_directory_unavailable" }, 503);
  }
  if (!job) return json({ error: "accounting_intent_roof_job_not_found" }, 404);
  const eligible = deps.jobEligibility ?? moneyIntentJobEligible;
  if (!eligible(job, kind)) {
    return json({ error: "accounting_intent_roof_job_not_eligible" }, 409);
  }
  return null;
}

/**
 * The kinds this route may derive.
 *
 * A Payment is observed and never created (section 4.1) and a tax remittance is proposed and never
 * filed, so neither is derivable here. Holdback and payroll belong to slices S6 and S7, and a
 * credit memo or refund is derived by the compensation path under an authorization, never typed in.
 */
const DERIVABLE_KINDS: readonly AccountingIntentKind[] = ["deposit_invoice", "progress_invoice"];

const PROVIDER_ENTITY_BY_DERIVABLE_KIND: Readonly<Record<string, AccountingEntityType>> = {
  deposit_invoice: "Invoice",
  progress_invoice: "Invoice",
};

async function listIntents(env: AppEnv, auth: AuthContext, url: URL): Promise<Response> {
  const denied = denyUnless(auth, "accounting:read");
  if (denied) return denied;

  const kindParam = url.searchParams.get("kind");
  const stateParam = url.searchParams.get("state");
  const kind = kindParam === null
    ? null
    : oneOf<AccountingIntentKind>(kindParam, ACCOUNTING_INTENT_KINDS);
  const state = stateParam === null
    ? null
    : oneOf<AccountingIntentState>(stateParam, ACCOUNTING_INTENT_STATES);
  if ((kindParam !== null && kind === null) || (stateParam !== null && state === null)) {
    return json({ error: "invalid_accounting_intent_filter" }, 400);
  }
  const job = url.searchParams.get("job");
  if (job !== null && refText(job, 1, 160) === null) {
    return json({ error: "invalid_accounting_intent_filter" }, 400);
  }

  try {
    const now = new Date();
    const intents = await listAccountingIntents(env, auth.session.tenant_id, {
      kind,
      state,
      roofJobId: job,
      limit: listLimit(url.searchParams.get("limit")),
    });
    return json(envelope(auth, {
      intents: intents.map((intent) => projectAccountingIntent(intent, now)),
    }));
  } catch (error) {
    return engineError(error);
  }
}

async function readIntent(
  env: AppEnv,
  auth: AuthContext,
  intentId: string,
): Promise<Response> {
  const denied = denyUnless(auth, "accounting:read");
  if (denied) return denied;
  try {
    const detail = await readAccountingIntentDetail(env, auth.session.tenant_id, intentId);
    return detail ? json(envelope(auth, { ...detail })) : json({ error: "not_found" }, 404);
  } catch (error) {
    return engineError(error);
  }
}

/**
 * Apply one accountant command - and, for `reconcile`, actually go and look.
 *
 * `reconcile` used to be a state-trigger flip and nothing else: the receipt moved the intent to
 * `reconciliation_required` and no code compared anything with the provider, so no production
 * surface could ever re-read an already-submitted entity and `reconciled` was unreachable in the
 * shipped product (ELEC-77). Both halves are kept, because both are true: the receipt records that
 * a named accountant asked for a re-read, and the re-read that follows is what section 5.1 admits
 * as the only route to a settled state. An unbound tenant still gets the receipt and an honest
 * `provider_unbound` answer rather than a verdict nobody checked.
 */
async function commandIntent(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  intentId: string,
  operation: "approve" | "reject" | "reconcile",
  deps: AccountingRouteDeps,
): Promise<Response> {
  const permission = operation === "approve"
    ? "accounting:approve"
    : operation === "reject"
      ? "accounting:review"
      : "accounting:reconcile";
  const denied = denyUnless(auth, permission);
  if (denied) return denied;
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  const allowed = operation === "reject" ? ["version", "reason_code"] : ["version"];
  if (!onlyKeys(body, allowed)) return json({ error: "unexpected_field" }, 400);

  const version = positiveInteger(body.version);
  if (version === null) return json({ error: "invalid_accounting_intent_command" }, 400);
  const reasonCode = operation === "reject"
    ? oneOf<AccountingRejectionReason>(body.reason_code, ACCOUNTING_REJECTION_REASONS)
    : null;
  if (operation === "reject" && reasonCode === null) {
    return json({ error: "invalid_accounting_intent_command" }, 400);
  }

  try {
    const result = await applyAccountingIntentCommand(env, {
      tenantId: auth.session.tenant_id,
      intentId,
      operation,
      // Section 6's separation of duty holds because this is the session's user and the body has
      // no field that could name a different one.
      actorUserId: auth.session.user_id,
      idempotencyKey: key,
      request: { operation, version, reason_code: reasonCode },
      requestedVersion: version,
      reasonCode,
    });
    const now = new Date();
    if (operation !== "reconcile" || result.replayed) {
      return json(
        envelope(auth, {
          intent: projectAccountingIntent(result.intent, now),
          replayed: result.replayed,
        }),
        // Approve enqueues provider work; reject settles here and now (section 8.1). A replay
        // applied nothing a second time, so it answers 200 whatever it replayed.
        operation === "reject" || result.replayed ? 200 : 202,
      );
    }

    const binding = deps.observation === undefined
      ? await resolveAccountingObservationBinding(env, { tenantId: auth.session.tenant_id })
      : deps.observation;
    if (!binding) {
      // No connected realm, so there is nothing to read. The intent stays in
      // `reconciliation_required` - which is the truth: it needs re-reading and we could not.
      return json(
        envelope(auth, {
          intent: projectAccountingIntent(result.intent, now),
          replayed: false,
          re_read: { status: "provider_unbound", verdict: null, reason_code: null },
        }),
        202,
      );
    }

    const reobserved = await reobserveAccountingIntent(env, binding, {
      tenantId: auth.session.tenant_id,
      intentId,
      // Not `sweep`: a person asked for this one, and the observation records which.
      source: "recovery_query",
    }, now);
    const settled = await readAccountingIntent(env, auth.session.tenant_id, intentId);
    return json(
      envelope(auth, {
        intent: projectAccountingIntent(settled ?? result.intent, now),
        replayed: false,
        re_read: {
          status: reobserved.status,
          verdict: reobserved.verdict,
          reason_code: reobserved.reason_code,
          detail_code: reobserved.detail_code,
          // The Payments the invoice declared, each observed by its exact id: the settled half of
          // the cumulative invariant, and the reason a paid invoice can reach `reconciled` here.
          payments_observed: reobserved.payments.length,
          exception_id: reobserved.exception_id,
        },
      }),
      // 200: the provider work this command names happened inside the request and settled. 202
      // stays for the unbound answer above, where the sweep is still what will do it.
      reobserved.status === "judged" ? 200 : 202,
    );
  } catch (error) {
    return engineError(error);
  }
}

/**
 * Authorize a compensation (section 11: propose -> authorize -> reverse).
 *
 * The plan is computed first and writes nothing, so a remedy the exception never offered, an
 * amount larger than what was posted, or a live identity conflict is refused before the command
 * receipt exists. What this route records is the accountant's authorization; deriving and
 * dispatching the reversing intent is the finance agent's work through the effect port, because a
 * screen that could dispatch a refund on its own would be exactly the auto-compensation section 11
 * rejects.
 */
async function compensateIntent(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  intentId: string,
): Promise<Response> {
  const denied = denyUnless(auth, "accounting:compensate");
  if (denied) return denied;
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!onlyKeys(body, ["version", "remedy", "amount"])) {
    return json({ error: "unexpected_field" }, 400);
  }
  const version = positiveInteger(body.version);
  const remedy = oneOf<AccountingExceptionResolution>(
    body.remedy,
    ACCOUNTING_EXCEPTION_RESOLUTIONS,
  );
  const amount = body.amount === undefined ? undefined : decimalText(body.amount);
  if (version === null || remedy === null || (body.amount !== undefined && amount === null)) {
    return json({ error: "invalid_accounting_compensation_command" }, 400);
  }

  try {
    const intent = await readAccountingIntent(env, auth.session.tenant_id, intentId);
    if (!intent) return json({ error: "not_found" }, 404);
    const plan = await planAccountingCompensation(env, {
      tenantId: auth.session.tenant_id,
      intentId,
      remedy,
      ...(amount === undefined || amount === null ? {} : { amount }),
    });
    // Section 8.1: `accounting:compensate`, owner-gated above the ceiling. The accountant that
    // authorized the original may reverse it; a reversal larger than the policy ceiling is the
    // owner's decision, which is section 6's "the same authority that authorized the original, or
    // higher" read against a magnitude rather than a sign.
    if (compensationAuthorityLevel(plan, intent) === "owner" && auth.session.role !== "owner") {
      return json({ error: "accounting_compensation_owner_required" }, 403);
    }

    // Write the authorization *before* the command receipt, and refuse a remedy that has no
    // dispatch path at all. Section 5.4's "the accountant authorizes; the remedy runs as a
    // compensating effect" needs the authorization to survive the response: until this row existed
    // the amount and remedy a human signed for were gone the moment the JSON was written, so no
    // later process could run the reversal they asked for - which is why `deriveCompensationIntent`
    // and `submitAccountingCompensation` had zero production callers (ELEC-71).
    const authorization = await recordAccountingCompensationAuthorization(env, {
      tenantId: auth.session.tenant_id,
      plan,
      authorizedByUserId: auth.session.user_id,
    });
    // A replay returns the authorization that already exists. If this request asked for a different
    // amount or remedy, it is a second decision about the same money and is refused rather than
    // silently answered with the first one.
    if (
      authorization.remedy !== plan.remedy
      || authorization.total_amount !== plan.totalAmount
    ) {
      return json({ error: "accounting_compensation_already_authorized" }, 409);
    }

    const result = await applyAccountingIntentCommand(env, {
      tenantId: auth.session.tenant_id,
      intentId,
      operation: "compensate",
      actorUserId: auth.session.user_id,
      idempotencyKey: key,
      request: { operation: "compensate", version, remedy, amount: amount ?? null },
      requestedVersion: version,
      reasonCode: plan.reasonCode,
    });
    return json(
      envelope(auth, {
        intent: projectAccountingIntent(result.intent, new Date()),
        compensation_plan: plan,
        // The reversal the dispatcher will run, so the desk can point at it before it exists.
        authorized_reversal_intent_id: authorization.reversal_intent_id,
        replayed: result.replayed,
      }),
      result.replayed ? 200 : 202,
    );
  } catch (error) {
    return engineError(error);
  }
}

// ---------------------------------------------------------------------------------- exceptions

async function exceptionRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  url: URL,
  parts: readonly string[],
): Promise<Response> {
  if (req.method === "GET" && parts.length === 1) return await listExceptions(env, auth, url);
  const exceptionId = parts[1];
  if (!exceptionId) return json({ error: "not_found" }, 404);
  if (req.method === "POST" && parts.length === 3 && parts[2] === "resolve") {
    return await resolveException(req, env, auth, exceptionId);
  }
  return json({ error: "not_found" }, 404);
}

async function listExceptions(env: AppEnv, auth: AuthContext, url: URL): Promise<Response> {
  const denied = denyUnless(auth, "accounting:read");
  if (denied) return denied;
  const statusParam = url.searchParams.get("status");
  const status = statusParam === null
    ? null
    : oneOf<AccountingExceptionStatus>(statusParam, ["open", "acknowledged", "resolved"]);
  if (statusParam !== null && status === null) {
    return json({ error: "invalid_accounting_exception_filter" }, 400);
  }
  try {
    const now = new Date();
    const exceptions = await listAccountingExceptions(env, auth.session.tenant_id, {
      ...(status === null ? {} : { status }),
    });
    return json(envelope(auth, {
      exceptions: exceptions.map((exception) => ({
        ...projectAccountingException(exception, now),
        // Section 8.2's queue renders "the proposed provider-supported remedies", so the offered
        // set travels beside the raw detail rather than being dug out by the browser.
        offered_remedies: offeredRemedies(exception),
      })),
    }));
  } catch (error) {
    return engineError(error);
  }
}

async function resolveException(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  exceptionId: string,
): Promise<Response> {
  const denied = denyUnless(auth, "accounting:reconcile");
  if (denied) return denied;
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const key = idempotencyKey(req);
  if (!key) return json({ error: "idempotency_key_required" }, 400);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!onlyKeys(body, ["resolution_action", "compensating_effect_id"])) {
    return json({ error: "unexpected_field" }, 400);
  }
  const resolutionAction = oneOf<AccountingExceptionResolution>(
    body.resolution_action,
    ACCOUNTING_EXCEPTION_RESOLUTIONS,
  );
  if (resolutionAction === null) {
    return json({ error: "invalid_accounting_exception_resolution" }, 400);
  }
  const compensatingEffectId = body.compensating_effect_id === undefined
    ? null
    : refText(body.compensating_effect_id, 8, 160);
  if (body.compensating_effect_id !== undefined && compensatingEffectId === null) {
    return json({ error: "invalid_accounting_exception_resolution" }, 400);
  }

  try {
    const resolved = await resolveAccountingException(env, {
      tenantId: auth.session.tenant_id,
      exceptionId,
      actorUserId: auth.session.user_id,
      resolutionAction,
      compensatingEffectId,
    });
    return json(envelope(auth, {
      exception: projectAccountingException(resolved, new Date()),
    }));
  } catch (error) {
    return engineError(error);
  }
}

// ----------------------------------------------------------------------------------------- tax

async function taxRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  url: URL,
  parts: readonly string[],
): Promise<Response> {
  if (req.method === "POST" && parts.length === 2 && parts[1] === "snapshots") {
    return await recordTaxSnapshot(req, env, auth);
  }
  if (req.method !== "GET") return json({ error: "not_found" }, 404);
  const denied = denyUnless(auth, "accounting:read");
  if (denied) return denied;

  if (parts.length === 2 && parts[1] === "snapshots") {
    const period = url.searchParams.get("period");
    if (period !== null && periodWindow(period) === null) {
      return json({ error: "invalid_accounting_tax_period" }, 400);
    }
    try {
      const snapshots = period === null
        ? await listTaxSnapshotsForPeriod(env, auth.session.tenant_id, currentPeriod())
        : await listTaxSnapshotsForPeriod(env, auth.session.tenant_id, period);
      return json(envelope(auth, {
        period: period ?? currentPeriod(),
        snapshots: snapshots.map(({ tenant_id: _tenantId, ...snapshot }) => snapshot),
      }));
    } catch (error) {
      return engineError(error);
    }
  }

  if (parts.length === 3 && parts[1] === "remittance") {
    const period = parts[2] ?? "";
    try {
      const proposal = await proposeTaxRemittance(env, auth.session.tenant_id, period);
      return proposal
        ? json(envelope(auth, { remittance: proposal }))
        : json({ error: "invalid_accounting_tax_period" }, 400);
    } catch (error) {
      return engineError(error);
    }
  }

  return json({ error: "not_found" }, 404);
}

/**
 * Record one statutory tax rate as an immutable snapshot (the production origin for section 5.4).
 *
 * `recordTaxPolicySnapshot` shipped with slice S2 and had zero callers in `src/`, and that was not
 * a cosmetic gap: `deriveIntent` refuses with `tax_mapping_missing` when no current snapshot binds
 * the jurisdiction and code it was given, so on a tenant that had never had a row inserted by hand
 * *no money intent could be derived at all*. The whole lane was unreachable from zero. Section
 * 8.1's route table has a `GET` for snapshots and no create row for the same reason it had no
 * create row for intents (deviation 6): the facts are supposed to come from somewhere. For a
 * statutory rate that somewhere is a person reading the statute, so this is the route.
 *
 * It is a *policy* command, not a money one, and the difference is why it is shaped the way it is:
 * it reaches no provider, creates no entity, moves no intent, and cannot touch a snapshot that
 * already exists - `0059` makes them immutable and `recordTaxPolicySnapshot` is idempotent on the
 * bound facts, so the same rate recorded twice is one snapshot rather than two versions of the same
 * number. Already-submitted intents keep the snapshot they bound, which is what section 5.4
 * requires; an un-submitted candidate whose snapshot was superseded is blocked `candidate_changed`
 * by the staleness check and must be re-derived.
 *
 * `Idempotency-Key` is required for the same reason every command under `/accounting` requires it,
 * and is enforced here by the facts hash rather than by a receipts table. That is a real difference
 * from `deriveIntent` and it is deliberate: ELEC-79's argument for derivation receipts is that one
 * key standing for two different sets of *figures* would derive money nobody asked for twice, and
 * there is no equivalent harm here - two different rates are two legitimately different snapshots,
 * and the same rate under any number of keys is one row.
 *
 * `accounting:review` gates it, matching `deriveIntent`: recording what the statute says is
 * reviewing work, and the approval on the intent that binds it is still the gate that matters.
 */
async function recordTaxSnapshot(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  const denied = denyUnless(auth, "accounting:review");
  if (denied) return denied;
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  if (!idempotencyKey(req)) return json({ error: "idempotency_key_required" }, 400);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!onlyKeys(body, [
    "jurisdiction", "tax_code", "provider_tax_code_id", "rate_percent", "effective_from",
    "effective_to", "source_ref",
  ])) {
    return json({ error: "unexpected_field" }, 400);
  }

  const jurisdiction = refText(body.jurisdiction, 2, 32);
  const taxCode = refText(body.tax_code, 1, 32);
  const providerTaxCodeId = body.provider_tax_code_id === undefined
    || body.provider_tax_code_id === null
    ? null
    : refText(body.provider_tax_code_id, 1, 40);
  const ratePercent = rateText(body.rate_percent);
  const effectiveFrom = isoDate(body.effective_from);
  const effectiveTo = body.effective_to === undefined || body.effective_to === null
    ? null
    : isoDate(body.effective_to);
  // The statute, bulletin or rate table this was read from. Section 6: evidence is cited, never
  // implied - a rate with no source is a number somebody typed. Spaces are allowed here and
  // nowhere else in this file, because a citation is prose ("CRA GST bulletin 2008-01-01") rather
  // than an identifier, and forcing it through the ref alphabet would only produce worse citations.
  const sourceRef = citationText(body.source_ref, 4, 200);
  if (
    jurisdiction === null || taxCode === null || ratePercent === null || effectiveFrom === null
    || sourceRef === null
    || (body.provider_tax_code_id !== undefined && body.provider_tax_code_id !== null
      && providerTaxCodeId === null)
    || (body.effective_to !== undefined && body.effective_to !== null && effectiveTo === null)
  ) {
    return json({ error: "invalid_accounting_tax_snapshot" }, 400);
  }

  try {
    const snapshot = await recordTaxPolicySnapshot(env, {
      tenantId: auth.session.tenant_id,
      jurisdiction,
      taxCode,
      providerTaxCodeId,
      ratePercent,
      effectiveFrom,
      effectiveTo,
      sourceRef,
    });
    const { tenant_id: _tenantId, ...row } = snapshot;
    return json(envelope(auth, { snapshot: row }), 201);
  } catch (error) {
    return engineError(error);
  }
}

// ------------------------------------------------------------------------ holdback and payroll

/**
 * Slices S6 (holdback) and S7 (payroll) have not shipped.
 *
 * These routes exist, authenticate, and enforce the same permission the shipped slice will: the
 * gate is real today, so the slice that lands behind it inherits a tested boundary rather than
 * inventing one. The answer is `501` with the slice named, which is the only honest thing a route
 * with no aggregate behind it can say.
 */
function holdbackRoute(
  req: Request,
  auth: AuthContext,
  parts: readonly string[],
): Response {
  if (req.method === "GET" && (parts.length === 1 || parts.length === 2)) {
    const denied = denyUnless(auth, "accounting:read");
    if (denied) return denied;
    return notImplemented("accounting_holdback_not_implemented", "S6");
  }
  if (req.method === "POST" && parts.length === 3 && parts[2] === "release") {
    // Section 6: releasing holdback is the owner's, with `external_authority` evidence. The
    // permission is granted to `owner` alone, so this is a permission check and not a role check.
    const denied = denyUnless(auth, "accounting:holdback_release");
    if (denied) return denied;
    if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
    if (!idempotencyKey(req)) return json({ error: "idempotency_key_required" }, 400);
    return notImplemented("accounting_holdback_not_implemented", "S6");
  }
  return json({ error: "not_found" }, 404);
}

function payrollRoute(
  req: Request,
  auth: AuthContext,
  parts: readonly string[],
): Response {
  if (parts[1] !== "runs" || parts.length < 3) return json({ error: "not_found" }, 404);
  const denied = denyUnless(auth, "accounting:payroll");
  if (denied) return denied;

  if (req.method === "GET" && parts.length === 3) {
    return notImplemented("accounting_payroll_not_implemented", "S7");
  }
  if (req.method === "POST" && parts.length === 4
    && (parts[3] === "approve" || parts[3] === "reject")) {
    if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
    if (!idempotencyKey(req)) return json({ error: "idempotency_key_required" }, 400);
    return notImplemented("accounting_payroll_not_implemented", "S7");
  }
  return json({ error: "not_found" }, 404);
}

function notImplemented(code: string, slice: string): Response {
  return json({
    error: code,
    slice,
    detail: "This surface is specified and gated but its aggregate has not shipped.",
  }, 501);
}

// ------------------------------------------------------------------------------------- helpers

function envelope(auth: AuthContext, body: Record<string, unknown>): Record<string, unknown> {
  return {
    version: APP_API_VERSION,
    read_model_generated_at: new Date().toISOString(),
    allowed_actions: allowedActions(auth),
    ...body,
  };
}

function allowedActions(auth: AuthContext): string[] {
  return ACCOUNTING_ALLOWED_ACTIONS.filter(
    (action) => auth.permissions.includes(ACTION_PERMISSION[action]),
  );
}

function denyUnless(auth: AuthContext, permission: string): Response | null {
  return auth.permissions.includes(permission)
    ? null
    : json({ error: `${permission.replace(":", "_")}_required` }, 403);
}

/**
 * Map an engine refusal onto a status a browser can act on.
 *
 * A `RAISE(ABORT, 'accounting_…')` refusal reaches this as
 * `D1_ERROR: … accounting_intent_command_version_invalid …: SQLITE_CONSTRAINT (extended: …)`, so
 * the code is extracted from the message rather than compared against it. Anything without an
 * `accounting_` code is a genuine store failure and stays a 502; conflating the two is what let a
 * whole family of 409s ship as 502s on the service-case lane.
 */
function engineError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/(?:accounting|effect|tax)_[a-z0-9_]+/)?.[0] ?? null;
  if (code === null) return json({ error: "accounting_store_unavailable" }, 502);
  if (code.endsWith("_missing") && code.startsWith("accounting_")) {
    return json({ error: "not_found" }, 404);
  }
  if (code === "effect_policy_amount_ceiling_exceeded") return json({ error: code }, 403);
  if (BAD_REQUEST_CODES.includes(code)) return json({ error: code }, 400);
  return json({ error: code }, 409);
}

/** Refusals that are about the request's own shape rather than the aggregate's state. */
const BAD_REQUEST_CODES: readonly string[] = [
  "accounting_exception_resolution_invalid",
  "accounting_exception_compensating_effect_required",
  "accounting_compensation_amount_invalid",
  "accounting_intent_command_invalid",
  "accounting_intent_kind_invalid",
  "accounting_intent_amount_invalid",
];

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 160 && !decoded.includes("/") ? decoded : null;
  } catch {
    return null;
  }
}

function idempotencyKey(req: Request): string | null {
  const value = req.headers.get("idempotency-key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{16,160}$/.test(value) ? value : null;
}

function listLimit(value: string | null): number {
  if (value === null || value.trim().length === 0) return DEFAULT_LIST_LIMIT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function boundedSeconds(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.trunc(parsed), 60), 30 * 24 * 60 * 60);
}

function oneOf<T extends string>(value: unknown, allowed: readonly string[]): T | null {
  return typeof value === "string" && allowed.includes(value) ? (value as T) : null;
}

function refText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max && /^[A-Za-z0-9._:-]+$/.test(trimmed)
    ? trimmed
    : null;
}

/**
 * A short human citation: bounded, single-line, and free of control characters.
 *
 * Deliberately not `refText`: this is the only field on the money desk that a person writes in
 * their own words, and it is evidence rather than an identifier.
 */
function citationText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  return /^[^\u0000-\u001f\u007f]+$/.test(trimmed) ? trimmed : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Two-place decimal magnitude, matching the money columns' own CHECK. */
/** A tax rate as the snapshot stores it: percent with up to four decimal places, never negative. */
function rateText(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value.toFixed(4) : null;
  }
  if (typeof value !== "string") return null;
  return /^\d{1,3}(\.\d{1,4})?$/.test(value) ? value : null;
}

function decimalText(value: unknown): string | null {
  return typeof value === "string" && /^\d+\.\d{2}$/.test(value) && value.length <= 20
    ? value
    : null;
}

/** `YYYY-MM-DD`, and a real calendar date rather than a well-shaped string. */
function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

/** Integer cents from a two-place decimal. Exact: the money columns admit exactly two places. */
function centsOf(value: string): number {
  return Number.parseInt(value.replace(".", ""), 10);
}

function decimalOf(cents: number): string {
  const magnitude = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(magnitude / 100)}.${
    String(magnitude % 100).padStart(2, "0")
  }`;
}

/** The source documents a basis was read from: bounded ids and integer versions, nothing else. */
function sourceDocumentList(
  value: unknown,
): Array<{ id: string; version: number }> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const documents: Array<{ id: string; version: number }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (!onlyKeys(record, ["id", "version"])) return null;
    const id = refText(record.id, 1, 160);
    const version = positiveInteger(record.version);
    if (id === null || version === null) return null;
    documents.push({ id, version });
  }
  return documents;
}

/** A short, stable discriminator for a derived intent id. Not a security boundary. */
async function shortHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

async function readJson(
  req: Request,
): Promise<
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string; status: number }
> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ACCOUNTING_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
  if (raw.length > MAX_ACCOUNTING_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  if (raw.trim().length === 0) return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "invalid_json", status: 400 };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
