// accounting-scenario-fixture.ts - the end-to-end money scenario harness for slices S4 and S5.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 9. `accounting-fixture.ts` gives the real-SQL
// D1 harness and the synthetic Intuit fixtures; this adds the one thing the S4/S5 scenarios need on
// top: a whole intent lifecycle assembled the way production will assemble it - derive, bind tax,
// approve under separation of duty, dispatch through the port, read back, judge.
//
// Kept out of `accounting-fixture.ts` deliberately: that file is the shared storage harness every
// slice from S1 onwards already depends on, and widening it with scenario choreography would make
// every earlier slice's tests depend on how S4 happens to stage a submission.

import {
  NOW,
  REALM,
  TENANT,
  quickBooksEntity,
  stubAuthPort,
  type FakeIntuitRoute,
} from "./accounting-fixture.ts";
import type { AppEnv } from "../src/app-types.ts";
import type {
  MoneyDispatchResult,
  MoneyEffectExecutor,
  MoneyReadback,
} from "../src/accounting-effect-port.ts";
import {
  applyAccountingIntentCommand,
  deriveAccountingIntent,
  type AccountingIntentKind,
  type AccountingIntentRecord,
} from "../src/accounting-intents.ts";
import {
  normalizeProviderEntity,
  providerFactEnvelope,
  type AccountingEntityType,
} from "../src/accounting-normalizers.ts";
import {
  bindAccountingIntentTaxSnapshots,
  recordTaxPolicySnapshot,
  taxBindingSetSha256,
  type TaxPolicySnapshotRecord,
} from "../src/accounting-tax-snapshots.ts";
import { recordAccountingCompensationAuthorization } from "../src/accounting-compensation-authorizations.ts";
import type { CompensationPlan } from "../src/accounting-compensation.ts";
import type { QuickBooksAuthPort } from "../src/quickbooks-auth-port.ts";

/** Derivation, dispatch, first readback, second readback. One ordering for every scenario. */
export const T_DERIVE = "2026-08-19T12:00:00.000Z";
export const T_SUBMIT = "2026-08-19T12:05:00.000Z";
export const T_READ = "2026-08-19T12:10:00.000Z";
export const T_LATER = "2026-08-19T12:15:00.000Z";
export const AT_SUBMIT = new Date(T_SUBMIT);
export const AT_READ = new Date(T_READ);
export const AT_LATER = new Date(T_LATER);

export const ACCOUNTANT = "appu_accounting_0001";
export const SECOND_ACCOUNTANT = "appu_accounting_0002";
export const OWNER = "appu_owner_0001";

/** Well past every `AT_*` instant, so no scenario trips the authority or deadline guards. */
export const DEADLINE = "2026-08-20T12:00:00.000Z";
export const AUTHORITY_EXPIRES = "2026-08-20T12:00:00.000Z";

/**
 * Who the ledger runs the effect as. `MoneyActorType` has no `accounting` member - the ledger's
 * actor vocabulary predates the accounting role - so a money mutation dispatches as `owner`, which
 * is the authority section 6 admits for every reversal and for anything above a ceiling.
 */
export const DISPATCH_ACTOR = { type: "owner" as const, id: OWNER };

export interface DerivedIntent {
  intent: AccountingIntentRecord;
  /** The exact envelope `expected_sha256` was taken over; `submitAccountingIntent` requires it. */
  expected: unknown;
  snapshot: TaxPolicySnapshotRecord | null;
}

export interface DeriveIntentOptions {
  intentId?: string;
  kind?: AccountingIntentKind;
  entityType?: AccountingEntityType;
  /** The fixture whose comparison facts the intent binds as its expectation. */
  entityFile?: string;
  subtotal?: string;
  taxAmount?: string;
  total?: string;
  maxAmount?: string;
  roofJobId?: string;
  effectIdempotencyKey?: string;
  providerPayload?: unknown;
  compensatesIntentId?: string | null;
  compensatesEffectId?: string | null;
  ratePercent?: string;
  /**
   * Who derived the candidate. Defaults to the finance agent, which is the production path;
   * naming a user is how a scenario reaches section 6's separation of duty, where the actor that
   * derived may not be the actor that approves.
   */
  derivedBy?: { actorKind: "agent" | "owner" | "accounting"; userId?: string | null };
}

const TAX_BEARING_KINDS: readonly AccountingIntentKind[] = [
  "deposit_invoice", "progress_invoice", "credit_memo", "holdback_release",
  "tax_remittance_proposal",
];

/**
 * Derive one intent bound to a fixture's own fact set.
 *
 * Binding the fixture is what makes the scenario end-to-end rather than a tautology: the readback
 * later in the test reads that same fixture through the normalizer, so `expected_sha256` and
 * `observed_sha256` are produced by two independent paths over the same provider bytes.
 */
export async function deriveScenarioIntent(
  env: AppEnv,
  options: DeriveIntentOptions = {},
): Promise<DerivedIntent> {
  const kind = options.kind ?? "deposit_invoice";
  const entityType = options.entityType ?? "Invoice";
  const intentId = options.intentId ?? `acct-intent:job-0001:${kind}`;
  const facts = normalizeProviderEntity({
    realmId: REALM,
    entityType,
    payload: quickBooksEntity(options.entityFile ?? "invoice-open.json", entityType),
  }).facts;
  const expected = providerFactEnvelope({ realmId: REALM, entityType, facts });

  let snapshot: TaxPolicySnapshotRecord | null = null;
  let taxPolicySnapshotSha256: string | null = null;
  if (TAX_BEARING_KINDS.includes(kind)) {
    snapshot = await recordTaxPolicySnapshot(env, {
      tenantId: TENANT,
      jurisdiction: "CA-AB",
      taxCode: "GST",
      providerTaxCodeId: "3",
      ratePercent: options.ratePercent ?? "5.0000",
      effectiveFrom: "2008-01-01",
      sourceRef: "CRA GST bulletin 2008-01-01",
    }, NOW);
    taxPolicySnapshotSha256 = await taxBindingSetSha256([snapshot.snapshot_sha256]);
  }

  const intent = await deriveAccountingIntent(env, {
    tenantId: TENANT,
    intentId,
    kind,
    roofJobId: options.roofJobId ?? "job-0001",
    basis: { roofJob: options.roofJobId ?? "job-0001", intentId },
    sourceDocuments: [{ id: "quote-0001", version: 3 }],
    expected,
    taxPolicySnapshotSha256,
    realmId: REALM,
    providerPayload: options.providerPayload ?? { TotalAmt: options.total ?? "1260.00" },
    providerRequestId: `req-${intentId}`,
    subtotal: options.subtotal ?? "1200.00",
    taxAmount: options.taxAmount ?? "60.00",
    totalAmount: options.total ?? "1260.00",
    authority: {
      permitRef: "permit:accounting:money",
      policyRef: "policy:accounting:money.create",
      policyVersion: "v1",
      maxAmount: options.maxAmount ?? "5000.00",
    },
    effectIdempotencyKey: options.effectIdempotencyKey ?? `acct:${intentId}:v1`,
    derivedBy: options.derivedBy ?? { actorKind: "agent" },
    compensatesIntentId: options.compensatesIntentId ?? null,
    compensatesEffectId: options.compensatesEffectId ?? null,
  }, NOW);

  if (snapshot) {
    await bindAccountingIntentTaxSnapshots(env, {
      tenantId: TENANT, intentId, snapshots: [snapshot],
    }, NOW);
  }
  return { intent, expected, snapshot };
}

/** Run the accountant's approve command, so the intent reaches `submission_pending`. */
export async function approveIntent(
  env: AppEnv,
  intent: AccountingIntentRecord,
  actorUserId: string = ACCOUNTANT,
  now: Date = NOW,
): Promise<AccountingIntentRecord> {
  const { intent: applied } = await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    operation: "approve",
    actorUserId,
    idempotencyKey: `approve:${intent.intent_id}`,
    request: { version: intent.version },
    requestedVersion: intent.version,
  }, now);
  return applied;
}

/**
 * Run the accountant's compensate command, so the intent reaches `compensating`.
 *
 * Pass `plan` to record the authorization first, which is the order `POST /compensate` uses: the
 * authorization row *is* the accountant's decision, and since ELEC-73 finding 3 an exception cannot
 * be closed without one. A caller that omits it is deliberately exercising the unauthorized path.
 */
export async function compensateCommand(
  env: AppEnv,
  intent: AccountingIntentRecord,
  actorUserId: string = OWNER,
  now: Date = NOW,
  plan?: CompensationPlan,
): Promise<AccountingIntentRecord> {
  if (plan) {
    await recordAccountingCompensationAuthorization(env, {
      tenantId: TENANT,
      plan,
      authorizedByUserId: actorUserId,
    }, now);
  }
  const { intent: applied } = await applyAccountingIntentCommand(env, {
    tenantId: TENANT,
    intentId: intent.intent_id,
    operation: "compensate",
    actorUserId,
    idempotencyKey: `compensate:${intent.intent_id}`,
    request: { version: intent.version },
    requestedVersion: intent.version,
  }, now);
  return applied;
}

export interface ScenarioExecutorOptions {
  providerExternalId: string;
  /** What an authenticated readback returns. Deep-matched against the request's expectation. */
  observed: unknown;
  dispatchOutcome?: MoneyDispatchResult<unknown>["outcome"];
  detailCode?: string;
  /** Model a lost response: the provider committed but we never learned the answer. */
  readbackStatus?: MoneyReadback["status"];
  /** Throw from `dispatch`, which the port settles as `unknown`. */
  dispatchThrows?: boolean;
}

export interface ScenarioExecutor extends MoneyEffectExecutor<{ providerEntityId: string }> {
  readonly dispatchCount: () => number;
  readonly replayCount: () => number;
}

/**
 * A provider adapter over the synthetic fixtures.
 *
 * Counts its own calls, because "a retried dispatch replays the stored entity rather than creating
 * a second one" (section 5.4) is only provable by asserting the provider was not called twice.
 */
export function scenarioExecutor(options: ScenarioExecutorOptions): ScenarioExecutor {
  let dispatches = 0;
  let replays = 0;
  return {
    async dispatch() {
      dispatches += 1;
      if (options.dispatchThrows) throw new Error("socket hang up");
      return {
        outcome: options.dispatchOutcome ?? "accepted",
        value: { providerEntityId: options.providerExternalId },
        providerExternalId: options.providerExternalId,
        providerResponse: { Id: options.providerExternalId },
        detailCode: options.detailCode,
      };
    },
    async readback() {
      const status = options.readbackStatus ?? "match";
      if (status !== "match") {
        return { status, detailCode: options.detailCode ?? "provider_readback_unavailable" };
      }
      return {
        status: "match",
        providerExternalId: options.providerExternalId,
        observed: options.observed,
      };
    },
    async replay() {
      replays += 1;
      return { providerEntityId: options.providerExternalId };
    },
    dispatchCount: () => dispatches,
    replayCount: () => replays,
  };
}

/** The Intuit read route for one entity, matching `readProviderEntity`'s URL shape. */
export function entityRoute(
  entityType: AccountingEntityType,
  entityFile: string,
  overrides: Partial<FakeIntuitRoute> = {},
): FakeIntuitRoute {
  return {
    path: `/v3/company/${REALM}/${entityType.toLowerCase()}/${
      (quickBooksEntity(entityFile, entityType) as { Id: string }).Id
    }`,
    body: { [entityType]: quickBooksEntity(entityFile, entityType) },
    ...overrides,
  };
}

/** The auth port every scenario uses: a synthetic realm and a token that cannot authenticate. */
export function scenarioAuth(): QuickBooksAuthPort {
  return stubAuthPort();
}
