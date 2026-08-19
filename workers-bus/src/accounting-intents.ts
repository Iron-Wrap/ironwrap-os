// accounting-intents.ts - the IRO-52 money intent aggregate and its state machine.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md slice S1. One aggregate, one state machine, one
// command path. Everything here is provable against `main`: the module reaches the provider only
// through `MoneyEffectPort`, so it holds no credential, opens no socket, and names no realm it was
// not handed.
//
// Two invariants are enforced in both layers on purpose. The transition graph and the separation
// of duty live here for a legible error, and in D1 triggers so a handler that forgets them still
// cannot write the row. `accounting-intents.test.ts` asserts the two layers agree.

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { MoneyEffectOutcome } from "./accounting-effect-port.ts";

export const ACCOUNTING_INTENT_KINDS = [
  "deposit_invoice", "progress_invoice", "payment", "credit_memo", "refund",
  "holdback_release", "tax_remittance_proposal", "payroll_journal",
] as const;

export type AccountingIntentKind = (typeof ACCOUNTING_INTENT_KINDS)[number];

export const ACCOUNTING_INTENT_STATES = [
  "draft", "blocked", "pending_review", "rejected", "submission_pending", "submitted",
  "uncertain", "partially_settled", "reconciled", "mismatch", "reconciliation_required",
  "compensating", "compensated", "failed",
] as const;

export type AccountingIntentState = (typeof ACCOUNTING_INTENT_STATES)[number];

/**
 * The legal state graph, restating `accounting_intents_transition_guard` in
 * `0058_accounting_money_intents.sql`. A test asserts the two are identical; changing one without
 * the other is a failing test rather than a silent divergence between handler and storage.
 */
export const ACCOUNTING_INTENT_TRANSITIONS: Readonly<
  Record<AccountingIntentState, readonly AccountingIntentState[]>
> = {
  draft: ["draft", "blocked", "pending_review"],
  blocked: ["blocked", "draft", "pending_review", "rejected"],
  pending_review: ["pending_review", "blocked", "rejected", "submission_pending"],
  rejected: ["rejected"],
  submission_pending: ["submission_pending", "submitted", "uncertain", "failed", "blocked"],
  submitted: [
    "submitted", "reconciled", "partially_settled", "mismatch", "reconciliation_required",
    "uncertain",
  ],
  uncertain: [
    "uncertain", "submitted", "reconciled", "mismatch", "failed", "reconciliation_required",
  ],
  partially_settled: ["partially_settled", "reconciled", "mismatch", "reconciliation_required"],
  reconciled: ["reconciled", "reconciliation_required"],
  mismatch: ["mismatch", "reconciled", "reconciliation_required", "compensating"],
  reconciliation_required: [
    "reconciliation_required", "reconciled", "partially_settled", "mismatch", "submitted",
    "compensating", "failed",
  ],
  compensating: ["compensating", "compensated", "mismatch", "failed"],
  compensated: ["compensated", "reconciliation_required"],
  failed: ["failed", "pending_review", "reconciliation_required"],
};

export const ACCOUNTING_INTENT_COMMANDS = ["approve", "reject", "reconcile", "compensate"] as const;

export type AccountingIntentCommand = (typeof ACCOUNTING_INTENT_COMMANDS)[number];

/** Section 5.3. `unavailable` is retryable and never becomes a verdict of record. */
export const ACCOUNTING_VERDICTS = [
  "reconciled", "partially_settled", "mismatch", "identity_conflict", "not_found", "unavailable",
] as const;

export type AccountingVerdict = (typeof ACCOUNTING_VERDICTS)[number];

/** The kinds whose normalized comparison fact set carries tax, per section 5.2. */
const TAX_BEARING_KINDS: readonly AccountingIntentKind[] = [
  "deposit_invoice", "progress_invoice", "credit_memo", "holdback_release",
  "tax_remittance_proposal",
];

const PROVIDER_ENTITY_BY_KIND: Readonly<Record<AccountingIntentKind, string | null>> = {
  deposit_invoice: "Invoice",
  progress_invoice: "Invoice",
  payment: "Payment",
  credit_memo: "CreditMemo",
  refund: "RefundReceipt",
  // Section 4.1: the entitlement is IronWrap's, but the released amount is posted as an invoice.
  holdback_release: "Invoice",
  // Propose and reconcile only. IronWrap never files, so it creates no provider entity.
  tax_remittance_proposal: null,
  payroll_journal: "JournalEntry",
};

export class AccountingIntentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AccountingIntentError";
  }
}

export interface AccountingIntentRecord {
  intent_id: string;
  tenant_id: string;
  kind: AccountingIntentKind;
  roof_job_id: string;
  basis_json: string;
  basis_sha256: string;
  source_documents_json: string;
  expected_sha256: string;
  tax_policy_snapshot_sha256: string | null;
  provider: "quickbooks";
  realm_id: string;
  provider_entity_type: string | null;
  provider_payload_json: string;
  provider_payload_sha256: string;
  provider_request_id: string;
  currency: "CAD";
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  settled_amount: string | null;
  authority_permit_ref: string;
  authority_policy_ref: string;
  authority_policy_version: string;
  authority_max_amount: string;
  effect_id: string | null;
  effect_idempotency_key: string;
  compensates_effect_id: string | null;
  final_invoice_intent_id: string | null;
  compensates_intent_id: string | null;
  state: AccountingIntentState;
  version: number;
  blocker_code: string | null;
  blocker_next_step: string | null;
  reason_code: string | null;
  error_code: string | null;
  derived_by_actor_kind: "agent" | "owner" | "accounting";
  derived_by_user_id: string | null;
  derived_at: string;
  approved_by_user_id: string | null;
  approved_at: string | null;
  rejected_by_user_id: string | null;
  rejected_at: string | null;
  provider_entity_id: string | null;
  observed_sha256: string | null;
  provider_submitted_at: string | null;
  provider_reconciled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeriveAccountingIntentInput {
  tenantId: string;
  intentId: string;
  kind: AccountingIntentKind;
  roofJobId: string;
  /** The bound local commercial facts. Hashed into `basis_sha256`; never edited afterwards. */
  basis: unknown;
  /** Source document ids and versions the basis was read from. */
  sourceDocuments: unknown;
  /** The normalized fact set an authenticated readback must return. Hashed into `expected_sha256`. */
  expected: unknown;
  taxPolicySnapshotSha256?: string | null;
  realmId: string;
  providerPayload: unknown;
  providerRequestId: string;
  currency?: "CAD";
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  authority: {
    permitRef: string;
    policyRef: string;
    policyVersion: string;
    maxAmount: string;
  };
  effectIdempotencyKey: string;
  derivedBy: { actorKind: "agent" | "owner" | "accounting"; userId?: string | null };
  blocker?: { code: string; nextStep: string } | null;
  finalInvoiceIntentId?: string | null;
  compensatesIntentId?: string | null;
  compensatesEffectId?: string | null;
}

/**
 * Derive one money intent candidate.
 *
 * Derivation is not a side effect (section 6), so it needs no approval — but it is idempotent on
 * the bound basis: the same commercial facts derive the same intent, which is the first half of
 * the duplicate-create defence. The second half is the ledger's business idempotency key.
 */
export async function deriveAccountingIntent(
  env: AppEnv,
  input: DeriveAccountingIntentInput,
  now: Date = new Date(),
): Promise<AccountingIntentRecord> {
  const kind = input.kind;
  if (!ACCOUNTING_INTENT_KINDS.includes(kind)) {
    throw new AccountingIntentError("accounting_intent_kind_invalid");
  }
  if (TAX_BEARING_KINDS.includes(kind) && !input.taxPolicySnapshotSha256) {
    throw new AccountingIntentError("tax_mapping_missing");
  }
  if (input.derivedBy.actorKind === "agent" && input.derivedBy.userId) {
    throw new AccountingIntentError("accounting_intent_derivation_actor_invalid");
  }
  if (input.derivedBy.actorKind !== "agent" && !input.derivedBy.userId) {
    throw new AccountingIntentError("accounting_intent_derivation_actor_invalid");
  }
  for (const amount of [input.subtotal, input.taxAmount, input.totalAmount, input.authority.maxAmount]) {
    if (!isDecimalString(amount)) throw new AccountingIntentError("accounting_intent_amount_invalid");
  }
  // The ceiling is a magnitude, not a signed bound. A credit memo and a refund are negative
  // (section 4.1), and those are exactly the kinds section 6 gates hardest — a signed comparison
  // would exempt every reversal from the ceiling it exists to enforce.
  if (Math.abs(cents(input.totalAmount)) > Math.abs(cents(input.authority.maxAmount))) {
    throw new AccountingIntentError("effect_policy_amount_ceiling_exceeded");
  }

  const timestamp = now.toISOString();
  const basisJson = canonicalJson(input.basis);
  const basisSha256 = await sha256Hex(basisJson);
  const expectedSha256 = await sha256Hex(canonicalJson(input.expected));
  const providerPayloadJson = canonicalJson(input.providerPayload);
  const providerPayloadSha256 = await sha256Hex(providerPayloadJson);
  const state: AccountingIntentState = input.blocker ? "blocked" : "pending_review";

  await env.DB.prepare(
    `INSERT INTO accounting_intents (
       intent_id, tenant_id, kind, roof_job_id, basis_json, basis_sha256, source_documents_json,
       expected_sha256, tax_policy_snapshot_sha256, provider, realm_id, provider_entity_type,
       provider_payload_json, provider_payload_sha256, provider_request_id, currency, subtotal,
       tax_amount, total_amount, authority_permit_ref, authority_policy_ref,
       authority_policy_version, authority_max_amount, effect_idempotency_key,
       compensates_effect_id, final_invoice_intent_id, compensates_intent_id, state, version,
       blocker_code, blocker_next_step, derived_by_actor_kind, derived_by_user_id, derived_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quickbooks', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, basis_sha256) DO NOTHING`,
  ).bind(
    input.intentId, input.tenantId, kind, input.roofJobId, basisJson, basisSha256,
    canonicalJson(input.sourceDocuments), expectedSha256, input.taxPolicySnapshotSha256 ?? null,
    input.realmId, PROVIDER_ENTITY_BY_KIND[kind], providerPayloadJson, providerPayloadSha256,
    input.providerRequestId, input.currency ?? "CAD", input.subtotal, input.taxAmount,
    input.totalAmount, input.authority.permitRef, input.authority.policyRef,
    input.authority.policyVersion, input.authority.maxAmount, input.effectIdempotencyKey,
    input.compensatesEffectId ?? null, input.finalInvoiceIntentId ?? null,
    input.compensatesIntentId ?? null, state, input.blocker?.code ?? null,
    input.blocker?.nextStep ?? null, input.derivedBy.actorKind, input.derivedBy.userId ?? null,
    timestamp, timestamp, timestamp,
  ).run();

  const stored = await readAccountingIntentByBasis(env, input.tenantId, basisSha256);
  if (!stored) throw new AccountingIntentError("accounting_intent_derivation_failed");
  return stored;
}

export interface AccountingIntentCommandInput {
  tenantId: string;
  intentId: string;
  operation: AccountingIntentCommand;
  actorUserId: string;
  /** The `Idempotency-Key` header value. Hashed; never stored raw. */
  idempotencyKey: string;
  /** The command body, hashed into a request fingerprint so a replay with a different body is caught. */
  request: unknown;
  requestedVersion: number;
  reasonCode?: string | null;
}

export interface AccountingIntentCommandResult {
  intent: AccountingIntentRecord;
  /** True when the receipt already existed, so nothing was applied a second time. */
  replayed: boolean;
}

/**
 * Apply one accountant command by writing its receipt.
 *
 * The receipt is the command: the D1 trigger validates the actor, the version, the source state
 * and the money authority, then performs the transition. A retry with the same idempotency key
 * replays; a retry with the same key and a different body is a conflict, not a silent overwrite.
 */
export async function applyAccountingIntentCommand(
  env: AppEnv,
  input: AccountingIntentCommandInput,
  now: Date = new Date(),
): Promise<AccountingIntentCommandResult> {
  if (!ACCOUNTING_INTENT_COMMANDS.includes(input.operation)) {
    throw new AccountingIntentError("accounting_intent_command_invalid");
  }
  const idempotencyKeySha256 = await sha256Hex(input.idempotencyKey);
  const requestFingerprintSha256 = await sha256Hex(canonicalJson(input.request));

  const existing = await env.DB.prepare(
    `SELECT receipt_id, intent_id, operation, request_fingerprint_sha256
       FROM accounting_intent_command_receipts
      WHERE tenant_id = ? AND idempotency_key_sha256 = ?`,
  ).bind(input.tenantId, idempotencyKeySha256).first<{
    receipt_id: string;
    intent_id: string;
    operation: string;
    request_fingerprint_sha256: string;
  }>();
  if (existing) {
    if (
      existing.request_fingerprint_sha256 !== requestFingerprintSha256
      || existing.intent_id !== input.intentId
      || existing.operation !== input.operation
    ) {
      throw new AccountingIntentError("accounting_intent_command_conflict");
    }
    const replayed = await readAccountingIntent(env, input.tenantId, input.intentId);
    if (!replayed) throw new AccountingIntentError("accounting_intent_missing");
    return { intent: replayed, replayed: true };
  }

  // Fail early with a legible code. The trigger repeats each of these checks, because a future
  // caller that writes the row directly must still be refused.
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");
  if (intent.version !== input.requestedVersion) {
    throw new AccountingIntentError("accounting_intent_command_version_invalid");
  }
  if (!commandSourceStates(input.operation).includes(intent.state)) {
    throw new AccountingIntentError("accounting_intent_command_version_invalid");
  }
  if (input.operation === "approve" && intent.derived_by_user_id === input.actorUserId) {
    throw new AccountingIntentError("accounting_intent_separation_of_duty");
  }

  try {
    await env.DB.prepare(
      `INSERT INTO accounting_intent_command_receipts (
         receipt_id, tenant_id, intent_id, operation, idempotency_key_sha256,
         request_fingerprint_sha256, requested_version, actor_user_id, reason_code, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), input.tenantId, input.intentId, input.operation, idempotencyKeySha256,
      requestFingerprintSha256, input.requestedVersion, input.actorUserId,
      input.reasonCode ?? null, now.toISOString(),
    ).run();
  } catch (error) {
    throw new AccountingIntentError(triggerCode(error, "accounting_intent_command_rejected"));
  }

  const applied = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!applied) throw new AccountingIntentError("accounting_intent_missing");
  return { intent: applied, replayed: false };
}

/**
 * Record what the effect ledger settled for a dispatched intent.
 *
 * This never reaches `reconciled`: an accepted dispatch means the provider acknowledged, and
 * section 5.1 admits only an authenticated readback compared against the normalized fact set as a
 * route to reconciled. That comparison is `recordAccountingIntentVerdict`.
 */
export async function recordAccountingIntentSubmission(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    outcome: MoneyEffectOutcome<unknown>;
  },
  now: Date = new Date(),
): Promise<AccountingIntentRecord> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");
  const timestamp = now.toISOString();
  const outcome = input.outcome;

  let state: AccountingIntentState;
  switch (outcome.state) {
    case "succeeded":
    case "reconciled":
      state = "submitted";
      break;
    case "unknown":
      state = "uncertain";
      break;
    case "failed":
      state = "failed";
      break;
    case "manual_exception":
      state = "reconciliation_required";
      break;
    case "compensated":
      state = "compensated";
      break;
    case "compensating":
      state = "compensating";
      break;
    default:
      // proposed / authorized / executing / reconciling / retry: still in flight.
      state = intent.state === "submission_pending" ? "submission_pending" : intent.state;
      break;
  }
  assertTransition(intent.state, state);
  if (state === "submitted" && !outcome.providerExternalId) {
    throw new AccountingIntentError("accounting_intent_provider_identity_missing");
  }

  await env.DB.prepare(
    `UPDATE accounting_intents
        SET state = ?, version = version + 1,
            effect_id = COALESCE(effect_id, ?),
            provider_entity_id = COALESCE(provider_entity_id, ?),
            provider_submitted_at = COALESCE(provider_submitted_at, ?),
            error_code = ?, updated_at = ?
      WHERE intent_id = ? AND tenant_id = ? AND version = ?`,
  ).bind(
    state, outcome.effectId, outcome.providerExternalId,
    state === "submitted" ? timestamp : null,
    outcome.resultCode, timestamp, input.intentId, input.tenantId, intent.version,
  ).run();

  const applied = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!applied) throw new AccountingIntentError("accounting_intent_missing");
  return applied;
}

/**
 * Apply a reconciliation verdict (section 5.3).
 *
 * `unavailable` is deliberately a no-op: the provider being unreachable is not a statement about
 * the money, and writing it as a state would let an outage look like an accounting fact.
 */
export async function recordAccountingIntentVerdict(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    verdict: AccountingVerdict;
    observedSha256?: string | null;
    settledAmount?: string | null;
    reasonCode?: string | null;
  },
  now: Date = new Date(),
): Promise<AccountingIntentRecord> {
  const intent = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!intent) throw new AccountingIntentError("accounting_intent_missing");
  if (input.verdict === "unavailable") return intent;

  const state: AccountingIntentState = input.verdict === "reconciled"
    ? "reconciled"
    : input.verdict === "partially_settled"
      ? "partially_settled"
      : input.verdict === "not_found"
        ? "reconciliation_required"
        : "mismatch";

  if (input.verdict === "reconciled" && input.observedSha256 !== intent.expected_sha256) {
    // Never adjust local truth to match the provider (section 5.1). A difference is an exception.
    throw new AccountingIntentError("accounting_intent_reconciled_hash_mismatch");
  }
  if (input.verdict === "partially_settled" && !input.settledAmount) {
    throw new AccountingIntentError("accounting_intent_settled_amount_required");
  }
  assertTransition(intent.state, state);

  const timestamp = now.toISOString();
  await env.DB.prepare(
    `UPDATE accounting_intents
        SET state = ?, version = version + 1,
            observed_sha256 = ?,
            settled_amount = COALESCE(?, settled_amount),
            provider_reconciled_at = CASE WHEN ? = 'reconciled'
              THEN ? ELSE provider_reconciled_at END,
            reason_code = ?, updated_at = ?
      WHERE intent_id = ? AND tenant_id = ? AND version = ?`,
  ).bind(
    state, input.observedSha256 ?? null, input.settledAmount ?? null, state, timestamp,
    input.reasonCode ?? null, timestamp, input.intentId, input.tenantId, intent.version,
  ).run();

  const applied = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!applied) throw new AccountingIntentError("accounting_intent_missing");
  return applied;
}

export async function readAccountingIntent(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<AccountingIntentRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_intents WHERE tenant_id = ? AND intent_id = ?`,
  ).bind(tenantId, intentId).first<AccountingIntentRecord>();
}

export async function readAccountingIntentByBasis(
  env: AppEnv,
  tenantId: string,
  basisSha256: string,
): Promise<AccountingIntentRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM accounting_intents WHERE tenant_id = ? AND basis_sha256 = ?`,
  ).bind(tenantId, basisSha256).first<AccountingIntentRecord>();
}

/**
 * The event history behind `/accounting/intents/$intentId` (section 8.2).
 *
 * Scoped on `tenant_id` like every other reader here: `accounting_intents.intent_id` is a global
 * primary key and derived as `acct-intent:<roofJobId>:<kind>`, so it is guessable rather than
 * unforgeable, and an unscoped read would be a cross-tenant leak the moment a BFF route calls it.
 */
export async function listAccountingIntentEvents(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<Array<{
  event_seq: number;
  intent_version: number;
  event_type: string;
  state_from: string | null;
  state_to: string;
  actor_kind: string;
  actor_user_id: string | null;
  detail_code: string | null;
  occurred_at: string;
}>> {
  const rows = await env.DB.prepare(
    `SELECT event_seq, intent_version, event_type, state_from, state_to, actor_kind,
            actor_user_id, detail_code, occurred_at
       FROM accounting_intent_events
      WHERE tenant_id = ? AND intent_id = ? ORDER BY event_seq`,
  ).bind(tenantId, intentId).all<{
    event_seq: number;
    intent_version: number;
    event_type: string;
    state_from: string | null;
    state_to: string;
    actor_kind: string;
    actor_user_id: string | null;
    detail_code: string | null;
    occurred_at: string;
  }>();
  return rows.results ?? [];
}

function commandSourceStates(operation: AccountingIntentCommand): readonly AccountingIntentState[] {
  switch (operation) {
    case "approve":
      return ["pending_review"];
    case "reject":
      return ["pending_review", "blocked"];
    case "reconcile":
      return [
        "submitted", "uncertain", "partially_settled", "reconciled", "mismatch",
        "reconciliation_required",
      ];
    case "compensate":
      return ["mismatch", "reconciliation_required"];
  }
}

function assertTransition(from: AccountingIntentState, to: AccountingIntentState): void {
  if (!ACCOUNTING_INTENT_TRANSITIONS[from].includes(to)) {
    throw new AccountingIntentError("accounting_intent_transition_invalid");
  }
}

/** TEXT decimal with exactly two places, a single dot, and a minus only in the leading position. */
function isDecimalString(value: string): boolean {
  return /^-?\d+\.\d{2}$/.test(value);
}

/** Exact integer cents. The column CHECK guarantees two decimal places, so this never rounds. */
function cents(value: string): number {
  return Number.parseInt(value.replace(".", ""), 10);
}

/** Surface the `RAISE(ABORT, '...')` code a D1 trigger raised, rather than the driver's wrapper. */
function triggerCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/accounting_[a-z0-9_]+/);
  return match?.[0] ?? fallback;
}
