// quickbooks-native-final-invoice.ts - native accounting authority for the legacy final-invoice UI.
//
// The final-invoice workflow predates the native accounting ledger and historically asked Frappe
// to discover commercial candidates, bind the provider identity, and decide the readback. This
// module is the deliberately narrow anti-corruption layer between that UI/work queue and the
// native `accounting_intents` aggregate. It never assembles commercial truth: the Job Packet owns
// that job. Missing or malformed source truth is a hold, never a synthesized invoice.

import type { AppEnv } from "./app-types.ts";
import {
  AccountingIntentError,
  applyAccountingIntentCommand,
  readAccountingIntent,
  recordAccountingIntentSubmission,
  type AccountingIntentRecord,
} from "./accounting-intents.ts";
import type { MoneyEffectOutcome } from "./accounting-effect-port.ts";
import { readAccountingIntentExpectation } from "./accounting-expectations.ts";
import {
  localFactEnvelope,
  normalizeProviderEntity,
} from "./accounting-normalizers.ts";
import { reconcileAccountingIntent } from "./accounting-reconciliation.ts";
import {
  assertAccountingIntentTaxBindingIntegrity,
  listAccountingIntentTaxBindings,
  readTaxPolicySnapshot,
} from "./accounting-tax-snapshots.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type {
  QuickBooksCandidate,
  QuickBooksCandidateBlocker,
  QuickBooksCitation,
} from "./quickbooks-final-invoice.ts";

const PURPOSE = "quickbooks_final_invoice" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const QBO_ID = /^[1-9][0-9]{0,31}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MONEY = /^(0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const TAX_RATE = /^(0|[1-9][0-9]{0,2})\.[0-9]{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COMPLETION_PACKAGES = 50;
const MAX_COMPLETION_EVENTS = 250;
const MAX_COMPLETION_EVIDENCE = 250;
const MAX_PRIOR_INVOICES = 100;

/**
 * The smallest source-basis contract the Job Packet must bind before a final invoice can exist.
 *
 * `roof_job_id`, realm, provider request identity, authority, tax snapshot and effect key remain
 * first-class accounting-intent columns. Everything here is immutable commercial source truth.
 */
export interface NativeFinalInvoiceBasisV1 {
  schema_version: 1;
  purpose: typeof PURPOSE;
  shop_order_id: string | null;
  completion: { id: string; version: number; sha256: string };
  accepted_quote: { id: string; version: number; sha256: string };
  accepted_changes_sha256: string;
  qbo: {
    customer_id: string;
    item_id: string;
    tax_code_id: string;
    terms_id: string;
  };
  commercial: QuickBooksCandidate["commercial"];
  evidence: QuickBooksCitation[];
}

export interface NativeFinalInvoiceBasisV2 {
  schema_version: 2;
  purpose: typeof PURPOSE;
  shop_order_id: string | null;
  completion: { id: string; version: number; sha256: string };
  accepted_quote: { id: string; version: number; sha256: string };
  accepted_changes_sha256: string;
  commercial_head: {
    proposal: { id: string; version: number; sha256: string };
    publication: { id: string; version: number; sha256: string };
    acceptance: { id: string; version: 1; sha256: string };
    accepted_amounts: {
      subtotal: string;
      tax_amount: string;
      total_amount: string;
    };
  };
  prior_invoices: Array<{
    intent_id: string;
    version: number;
    kind: "deposit_invoice" | "progress_invoice";
    basis_sha256: string;
    subtotal: string;
    tax_amount: string;
    total_amount: string;
    provider_entity_id: string;
    observed_sha256: string;
  }>;
  provider_binding: {
    id: string;
    version: number;
    source_ref: string;
    source_sha256: string;
  };
  qbo: {
    customer_id: string;
    item_id: string;
    tax_code_id: string;
    terms_id: string;
  };
  commercial: QuickBooksCandidate["commercial"];
  evidence: QuickBooksCitation[];
}

export type NativeFinalInvoiceBasis = NativeFinalInvoiceBasisV1 | NativeFinalInvoiceBasisV2;

export interface NativeFinalInvoiceListing {
  candidates: QuickBooksCandidate[];
  blockers: QuickBooksCandidateBlocker[];
}

export interface NativeFinalInvoiceLegacyBinding {
  tenantId: string;
  intentId: string;
  roofJobId: string;
  realmId: string;
  basisSha256: string;
  providerPayloadSha256: string;
  providerRequestId: string;
  candidateFingerprintSha256: string;
}

export class NativeFinalInvoiceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "NativeFinalInvoiceError";
  }
}

/** Deterministic Intuit `requestid`; the Job Packet and compatibility queue bind the same key. */
export async function nativeFinalInvoiceProviderRequestId(input: {
  tenantId: string;
  realmId: string;
  intentId: string;
  providerPayloadSha256: string;
}): Promise<string> {
  return `iwfi-${(
    await sha256Hex(
      `${input.tenantId}\n${input.realmId}\n${input.intentId}\n${input.providerPayloadSha256}`,
    )
  ).slice(0, 43)}`;
}

/** The universal-effect business key. It is stable across every safe retry. */
export function nativeFinalInvoiceEffectIdempotencyKey(input: {
  providerRequestId: string;
  providerPayloadSha256: string;
}): string {
  return `quickbooks:invoice:${input.providerRequestId}:${input.providerPayloadSha256}`;
}

/** Build the exact provider payload whose canonical hash the accounting intent must bind. */
export function nativeFinalInvoiceProviderPayload(
  basis: NativeFinalInvoiceBasis,
): Record<string, unknown> {
  return {
    CustomerRef: { value: basis.qbo.customer_id },
    CurrencyRef: { value: "CAD" },
    TxnDate: basis.commercial.invoice_date,
    DueDate: basis.commercial.due_date,
    SalesTermRef: { value: basis.qbo.terms_id },
    Line: basis.commercial.lines.map((line) => ({
      Amount: Number(line.amount),
      Description:
        line.description_code === "RESIDENTIAL_ACCEPTED_QUOTE"
          ? "Residential roofing contract"
          : "Accepted change order",
      DetailType: "SalesItemLineDetail",
      SalesItemLineDetail: {
        ItemRef: { value: basis.qbo.item_id },
        TaxCodeRef: { value: basis.qbo.tax_code_id },
      },
    })),
  };
}

/** The identity-free expectation the accounting reconciliation ledger must hold. */
export function nativeFinalInvoiceExpectedReadback(input: {
  realmId: string;
  basis: NativeFinalInvoiceBasis;
}): ReturnType<typeof localFactEnvelope> {
  const payload = nativeFinalInvoiceProviderPayload(input.basis);
  const lines = Array.isArray(payload.Line) ? payload.Line : [];
  return localFactEnvelope({
    realmId: input.realmId,
    entityType: "Invoice",
    // QuickBooks materializes one official subtotal line on the detail read even though the
    // create request contains only sales-item lines. Binding that deterministic provider shape is
    // not a guessed amount: it is the exact sum already proved in the basis, represented in the
    // response form the normalizer compares.
    payload: {
      ...payload,
      TotalAmt: input.basis.commercial.total_amount,
      TxnTaxDetail: { TotalTax: input.basis.commercial.tax_amount },
      Line: [
        ...lines,
        {
          Amount: Number(input.basis.commercial.subtotal),
          DetailType: "SubTotalLineDetail",
          SubTotalLineDetail: {},
        },
      ],
    },
  });
}

/**
 * Discover only explicitly marked native final-invoice intents.
 *
 * A progress invoice without `final_invoice_intent_id` is not silently reclassified. For a
 * job-scoped request, no marked intent is itself an explicit `basis_missing` hold.
 */
export async function listNativeFinalInvoiceCandidates(
  env: AppEnv,
  input: {
    tenantId: string;
    realmId: string;
    roofJobId?: string;
    limit: number;
  },
): Promise<NativeFinalInvoiceListing> {
  const rows = await env.DB.prepare(
    `SELECT * FROM accounting_intents
      WHERE tenant_id = ? AND realm_id = ? AND kind = 'progress_invoice'
        AND final_invoice_intent_id IS NOT NULL
        AND (? IS NULL OR roof_job_id = ?)
        AND state IN ('pending_review','blocked')
      ORDER BY derived_at, intent_id LIMIT ?`,
  )
    .bind(
      input.tenantId,
      input.realmId,
      input.roofJobId ?? null,
      input.roofJobId ?? null,
      input.limit,
    )
    .all<AccountingIntentRecord>();

  const candidates: QuickBooksCandidate[] = [];
  const blockers: QuickBooksCandidateBlocker[] = [];
  for (const row of rows.results ?? []) {
    const converted = await candidateFromAccountingIntent(
      env,
      row,
      input.realmId,
    );
    if (converted.candidate) candidates.push(converted.candidate);
    else
      blockers.push(
        blocker(row.roof_job_id, converted.code, converted.citations),
      );
  }
  if (input.roofJobId && (rows.results ?? []).length === 0) {
    // A scoped refresh may legitimately happen after approval/submission, when the intent is no
    // longer a discoverable candidate. Do not rewrite that existing native truth as "missing".
    const existing = await env.DB.prepare(
      `SELECT intent_id FROM accounting_intents
        WHERE tenant_id = ? AND realm_id = ? AND roof_job_id = ?
          AND kind = 'progress_invoice'
          AND final_invoice_intent_id IS NOT NULL
        LIMIT 1`,
    )
      .bind(input.tenantId, input.realmId, input.roofJobId)
      .first<{ intent_id: string }>();
    if (!existing) {
      blockers.push(
        blocker(input.roofJobId, "native_final_invoice_basis_missing", []),
      );
    }
  }
  return { candidates, blockers };
}

export async function checkNativeFinalInvoiceFreshness(
  env: AppEnv,
  input: NativeFinalInvoiceLegacyBinding,
): Promise<"exact" | "changed"> {
  const row = await readAccountingIntent(env, input.tenantId, input.intentId);
  if (!row) return "changed";
  const converted = await candidateFromAccountingIntent(
    env,
    row,
    input.realmId,
  );
  if (!converted.candidate) return "changed";
  if (
    row.roof_job_id !== input.roofJobId ||
    row.basis_sha256 !== input.basisSha256 ||
    row.provider_payload_sha256 !== input.providerPayloadSha256 ||
    row.provider_request_id !== input.providerRequestId
  )
    return "changed";
  return (await sha256Hex(canonicalJson(converted.candidate))) ===
    input.candidateFingerprintSha256
    ? "exact"
    : "changed";
}

/** Move the native accounting aggregate through the same human approval as the compatibility UI. */
export async function approveNativeFinalInvoice(
  env: AppEnv,
  input: NativeFinalInvoiceLegacyBinding & {
    actorUserId: string;
    idempotencyKey: string;
    now: Date;
  },
): Promise<AccountingIntentRecord> {
  const freshness = await checkNativeFinalInvoiceFreshness(env, input);
  if (freshness !== "exact")
    throw new NativeFinalInvoiceError("native_final_invoice_basis_changed");
  const intent = await readAccountingIntent(
    env,
    input.tenantId,
    input.intentId,
  );
  if (!intent)
    throw new NativeFinalInvoiceError("native_final_invoice_basis_missing");
  try {
    const approved = await applyAccountingIntentCommand(
      env,
      {
        tenantId: input.tenantId,
        intentId: input.intentId,
        operation: "approve",
        actorUserId: input.actorUserId,
        idempotencyKey: `final-invoice:${input.idempotencyKey}`,
        request: {
          operation: "approve_final_invoice",
          intent_id: input.intentId,
          basis_sha256: input.basisSha256,
          provider_payload_sha256: input.providerPayloadSha256,
        },
        requestedVersion: intent.version,
      },
      input.now,
    );
    if (approved.intent.state !== "submission_pending") {
      throw new NativeFinalInvoiceError(
        "native_final_invoice_not_submission_pending",
      );
    }
    return approved.intent;
  } catch (error) {
    if (error instanceof NativeFinalInvoiceError) throw error;
    throw new NativeFinalInvoiceError(
      error instanceof AccountingIntentError
        ? error.code
        : "native_final_invoice_approval_failed",
    );
  }
}

/** Record the compatibility reviewer's rejection on the native accounting aggregate. */
export async function rejectNativeFinalInvoice(
  env: AppEnv,
  input: NativeFinalInvoiceLegacyBinding & {
    actorUserId: string;
    idempotencyKey: string;
    reasonCode: string;
    now: Date;
  },
): Promise<AccountingIntentRecord> {
  const freshness = await checkNativeFinalInvoiceFreshness(env, input);
  if (freshness !== "exact")
    throw new NativeFinalInvoiceError("native_final_invoice_basis_changed");
  const intent = await readAccountingIntent(
    env,
    input.tenantId,
    input.intentId,
  );
  if (!intent)
    throw new NativeFinalInvoiceError("native_final_invoice_basis_missing");
  if (intent.state === "rejected") {
    if (intent.reason_code !== input.reasonCode)
      throw new NativeFinalInvoiceError("native_final_invoice_rejection_conflict");
    return intent;
  }
  try {
    const rejected = await applyAccountingIntentCommand(
      env,
      {
        tenantId: input.tenantId,
        intentId: input.intentId,
        operation: "reject",
        actorUserId: input.actorUserId,
        idempotencyKey: `final-invoice-reject:${input.idempotencyKey}`,
        request: {
          operation: "reject_final_invoice",
          intent_id: input.intentId,
          basis_sha256: input.basisSha256,
          reason_code: input.reasonCode,
        },
        requestedVersion: intent.version,
        reasonCode: input.reasonCode,
      },
      input.now,
    );
    if (rejected.intent.state !== "rejected") {
      throw new NativeFinalInvoiceError("native_final_invoice_not_rejected");
    }
    return rejected.intent;
  } catch (error) {
    if (error instanceof NativeFinalInvoiceError) throw error;
    throw new NativeFinalInvoiceError(
      error instanceof AccountingIntentError
        ? error.code
        : "native_final_invoice_rejection_failed",
    );
  }
}

/** Bind the provider identity and universal-effect evidence onto the native accounting aggregate. */
export async function recordNativeFinalInvoiceSubmission(
  env: AppEnv,
  input: NativeFinalInvoiceLegacyBinding & {
    outcome: MoneyEffectOutcome<unknown>;
    now: Date;
  },
): Promise<AccountingIntentRecord> {
  const intent = await assertNativeFinalInvoiceBinding(env, input);
  if (
    input.outcome.state !== "succeeded" ||
    !input.outcome.providerExternalId
  ) {
    throw new NativeFinalInvoiceError(
      "native_final_invoice_submission_unsettled",
    );
  }
  if (intent.effect_id || intent.provider_entity_id) {
    if (
      intent.effect_id !== input.outcome.effectId ||
      intent.provider_entity_id !== input.outcome.providerExternalId
    )
      throw new NativeFinalInvoiceError(
        "native_final_invoice_provider_identity_conflict",
      );
    return intent;
  }
  if (intent.state !== "submission_pending") {
    throw new NativeFinalInvoiceError(
      "native_final_invoice_not_submission_pending",
    );
  }
  try {
    const applied = await recordAccountingIntentSubmission(
      env,
      {
        tenantId: input.tenantId,
        intentId: input.intentId,
        outcome: input.outcome,
      },
      input.now,
    );
    if (
      applied.state !== "submitted" ||
      applied.effect_id !== input.outcome.effectId ||
      applied.provider_entity_id !== input.outcome.providerExternalId
    )
      throw new NativeFinalInvoiceError(
        "native_final_invoice_provider_binding_failed",
      );
    return applied;
  } catch (error) {
    if (error instanceof NativeFinalInvoiceError) throw error;
    throw new NativeFinalInvoiceError(
      error instanceof AccountingIntentError
        ? error.code
        : "native_final_invoice_provider_binding_failed",
    );
  }
}

/** Verify the compatibility row and accounting row still name one immutable provider mutation. */
export async function assertNativeFinalInvoiceBinding(
  env: AppEnv,
  input: Omit<NativeFinalInvoiceLegacyBinding, "candidateFingerprintSha256"> &
    Partial<
      Pick<NativeFinalInvoiceLegacyBinding, "candidateFingerprintSha256">
    >,
): Promise<AccountingIntentRecord> {
  const intent = await readAccountingIntent(
    env,
    input.tenantId,
    input.intentId,
  );
  if (!intent)
    throw new NativeFinalInvoiceError("native_final_invoice_basis_missing");
  const expectedEffectKey = nativeFinalInvoiceEffectIdempotencyKey({
    providerRequestId: input.providerRequestId,
    providerPayloadSha256: input.providerPayloadSha256,
  });
  if (
    intent.final_invoice_intent_id !== input.intentId ||
    intent.roof_job_id !== input.roofJobId ||
    intent.realm_id !== input.realmId ||
    intent.basis_sha256 !== input.basisSha256 ||
    intent.provider_payload_sha256 !== input.providerPayloadSha256 ||
    intent.provider_request_id !== input.providerRequestId ||
    intent.effect_idempotency_key !== expectedEffectKey
  )
    throw new NativeFinalInvoiceError("native_final_invoice_binding_conflict");
  return intent;
}

/** Record and judge the authenticated QuickBooks detail read in the native reconciliation ledger. */
export async function reconcileNativeFinalInvoiceReadback(
  env: AppEnv,
  input: NativeFinalInvoiceLegacyBinding & {
    providerInvoiceId: string;
    providerInvoice: unknown;
    effectAttemptId: string | null;
    now: Date;
  },
): Promise<"matched" | "mismatch"> {
  const intent = await assertNativeFinalInvoiceBinding(env, input);
  if (
    intent.provider_entity_id !== input.providerInvoiceId ||
    intent.provider_entity_type !== "Invoice" ||
    ![
      "submitted",
      "partially_settled",
      "reconciled",
      "mismatch",
      "reconciliation_required",
    ].includes(intent.state)
  )
    throw new NativeFinalInvoiceError(
      "native_final_invoice_provider_identity_conflict",
    );
  let normalized;
  try {
    normalized = normalizeProviderEntity({
      realmId: input.realmId,
      entityType: "Invoice",
      payload: input.providerInvoice,
    });
  } catch {
    throw new NativeFinalInvoiceError("native_final_invoice_readback_invalid");
  }
  const judged = await reconcileAccountingIntent(
    env,
    {
      tenantId: input.tenantId,
      intentId: input.intentId,
      read: {
        status: "ok",
        realmId: input.realmId,
        entityType: "Invoice",
        entityId: normalized.entityId,
        payload: input.providerInvoice,
        normalized,
        readAt: input.now.toISOString(),
        source: "dispatch_readback",
        effectAttemptId: input.effectAttemptId,
      },
    },
    input.now,
  );
  return judged.verdict === "reconciled" ||
    judged.verdict === "partially_settled"
    ? "matched"
    : "mismatch";
}

export async function nativeFinalInvoiceResolution(
  env: AppEnv,
  input: { tenantId: string; intentId: string; providerInvoiceId: string },
): Promise<"matched" | "mismatch" | "pending"> {
  const intent = await readAccountingIntent(
    env,
    input.tenantId,
    input.intentId,
  );
  if (!intent || intent.provider_entity_id !== input.providerInvoiceId)
    return "mismatch";
  if (intent.state === "reconciled" || intent.state === "partially_settled")
    return "matched";
  if (["mismatch", "reconciliation_required", "failed"].includes(intent.state))
    return "mismatch";
  return "pending";
}

async function candidateFromAccountingIntent(
  env: AppEnv,
  row: AccountingIntentRecord,
  realmId: string,
): Promise<
  | {
      candidate: QuickBooksCandidate;
      code: null;
      citations: QuickBooksCitation[];
    }
  | { candidate: null; code: string; citations: QuickBooksCitation[] }
> {
  const parsed = parseBasis(row.basis_json);
  if (!parsed.basis)
    return { candidate: null, code: parsed.code, citations: [] };
  const basis = parsed.basis;
  const citations = basis.evidence;
  try {
    if (
      row.final_invoice_intent_id !== row.intent_id ||
      row.realm_id !== realmId ||
      row.provider_entity_type !== "Invoice" ||
      row.currency !== "CAD" ||
      row.subtotal !== basis.commercial.subtotal ||
      row.tax_amount !== basis.commercial.tax_amount ||
      row.total_amount !== basis.commercial.total_amount ||
      row.total_amount !== basis.commercial.final_balance
    )
      throw new Error("binding");

    const providerPayload = nativeFinalInvoiceProviderPayload(basis);
    const providerPayloadJson = canonicalJson(providerPayload);
    const providerPayloadSha256 = await sha256Hex(providerPayloadJson);
    const providerRequestId = await nativeFinalInvoiceProviderRequestId({
      tenantId: row.tenant_id,
      realmId: row.realm_id,
      intentId: row.intent_id,
      providerPayloadSha256,
    });
    if (
      row.provider_payload_json !== providerPayloadJson ||
      row.provider_payload_sha256 !== providerPayloadSha256 ||
      row.provider_request_id !== providerRequestId ||
      row.effect_idempotency_key !==
        nativeFinalInvoiceEffectIdempotencyKey({
          providerRequestId,
          providerPayloadSha256,
        })
    )
      throw new Error("provider");

    const basisSha256 = await sha256Hex(canonicalJson(basis));
    if (row.basis_sha256 !== basisSha256) throw new Error("basis");
    if (!sourceDocumentsMatch(row.source_documents_json, basis))
      throw new Error("sources");
    if (basis.schema_version === 2) {
      await assertV2SourceFreshness(env, row, basis);
    }
    await assertAccountingIntentTaxBindingIntegrity(
      env,
      row.tenant_id,
      row.intent_id,
    );
    await assertFinalInvoiceTaxBinding(env, row, basis);

    const expectation = await readAccountingIntentExpectation(
      env,
      row.tenant_id,
      row.intent_id,
    );
    const expected = nativeFinalInvoiceExpectedReadback({
      realmId: row.realm_id,
      basis,
    });
    if (
      !expectation ||
      expectation.omits_identity !== 1 ||
      expectation.envelope_json !== canonicalJson(expected) ||
      expectation.expected_sha256 !== row.expected_sha256
    )
      throw new Error("expectation");

    return {
      candidate: {
        roof_job_id: row.roof_job_id,
        shop_order_id: basis.shop_order_id,
        qbo: {
          realm_id: row.realm_id,
          customer_id: basis.qbo.customer_id,
          item_id: basis.qbo.item_id,
          tax_code_id: basis.qbo.tax_code_id,
          terms_id: basis.qbo.terms_id,
        },
        commercial: basis.commercial,
        basis: {
          intent_id: row.intent_id,
          basis_sha256: row.basis_sha256,
          completion_packet_id: basis.completion.id,
          completion_version: String(basis.completion.version),
          completion_sha256: basis.completion.sha256,
          customer_quote_id: basis.accepted_quote.id,
          quote_version: basis.accepted_quote.version,
          quote_sha256: basis.accepted_quote.sha256,
          changes_sha256: basis.accepted_changes_sha256,
          evidence: basis.evidence,
        },
      },
      code: null,
      citations,
    };
  } catch {
    return {
      candidate: null,
      code: "native_final_invoice_basis_invalid",
      citations,
    };
  }
}

/**
 * A phase may report financial closure only for a settled native V2 final invoice whose immutable
 * completion/commercial/provider basis is still current.  This is intentionally read-only: a
 * stale or malformed intent is evidence for a blocker, never a reason to mutate accounting state.
 */
export async function isNativeFinalInvoiceCurrent(
  env: AppEnv,
  row: AccountingIntentRecord,
): Promise<boolean> {
  if (
    row.kind !== "progress_invoice" ||
    row.final_invoice_intent_id !== row.intent_id ||
    row.state !== "reconciled" ||
    row.settled_amount !== row.total_amount
  ) return false;
  const parsed = parseBasis(row.basis_json);
  if (
    !parsed.basis ||
    parsed.basis.schema_version !== 2 ||
    row.basis_sha256 !== await sha256Hex(canonicalJson(parsed.basis)) ||
    !sourceDocumentsMatch(row.source_documents_json, parsed.basis)
  ) return false;
  try {
    await assertV2SourceFreshness(env, row, parsed.basis);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-read every mutable native head behind a V2 basis before it enters the review queue.
 *
 * The basis proves what was derived. These reads prove the same facts are still current. A
 * scheduler can create a durable replacement/blocker later, but it cannot be the only protection:
 * a reviewer may click Approve between scheduled ticks.
 */
async function assertV2SourceFreshness(
  env: AppEnv,
  row: AccountingIntentRecord,
  basis: NativeFinalInvoiceBasisV2,
): Promise<void> {
  await assertCompletionSourceFreshness(env, row, basis);
  await assertCommercialSourceFreshness(env, row, basis);
  await assertProviderSourceFreshness(env, row, basis);
  await assertPriorInvoiceSourceFreshness(env, row, basis);
}

async function assertCompletionSourceFreshness(
  env: AppEnv,
  row: AccountingIntentRecord,
  basis: NativeFinalInvoiceBasisV2,
): Promise<void> {
  const packet = await env.DB.prepare(
    `SELECT * FROM native_completion_packets
      WHERE tenant_id = ? AND roof_job_id = ? AND completion_packet_id = ?`,
  )
    .bind(row.tenant_id, row.roof_job_id, basis.completion.id)
    .first<{
      packet_version: number;
      packet_json: string;
      packet_sha256: string;
      work_package_set_sha256: string;
      commercial_head_sha256: string;
    }>();
  if (
    !packet ||
    Number(packet.packet_version) !== basis.completion.version ||
    packet.packet_sha256 !== basis.completion.sha256 ||
    (await sha256Hex(packet.packet_json)) !== packet.packet_sha256
  ) {
    throw new Error("completion_packet");
  }
  let packetBody: Record<string, unknown> | null = null;
  try {
    packetBody = asRecord(JSON.parse(packet.packet_json) as unknown);
  } catch {
    throw new Error("completion_packet");
  }
  const packetAssignment = asRecord(packetBody?.current_assignment);
  const packetPackages = packetBody?.work_packages;
  if (
    !packetBody ||
    packetBody.tenant_id !== row.tenant_id ||
    packetBody.roof_job_id !== row.roof_job_id ||
    packetBody.work_package_set_sha256 !== packet.work_package_set_sha256 ||
    packetBody.commercial_head_sha256 !== packet.commercial_head_sha256 ||
    !packetAssignment ||
    !Array.isArray(packetPackages)
  ) {
    throw new Error("completion_packet");
  }

  const assignments = await env.DB.prepare(
    `SELECT current.assignment_id, current.assignment_version
       FROM operating_job_assignments current
      WHERE current.tenant_id = ? AND current.roof_job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM operating_job_assignments successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_assignment_id = current.assignment_id
        )
      ORDER BY current.assignment_version DESC LIMIT 2`,
  )
    .bind(row.tenant_id, row.roof_job_id)
    .all<Record<string, unknown>>();
  if (
    (assignments.results ?? []).length !== 1 ||
    canonicalJson(assignments.results![0]) !== canonicalJson(packetAssignment)
  ) {
    throw new Error("completion_assignment");
  }
  const assignmentId = text(packetAssignment.assignment_id);
  const packages = await env.DB.prepare(
    `SELECT work_package_id, tenant_id, version, job_id, assignment_id, work_object_type,
            work_object_id, physical_context_type, physical_context_id, status, definition_json,
            completed_at, updated_at
       FROM work_packages
      WHERE tenant_id = ? AND job_id = ? AND status != 'Superseded'
      ORDER BY work_package_id, version LIMIT ?`,
  )
    .bind(row.tenant_id, row.roof_job_id, MAX_COMPLETION_PACKAGES + 1)
    .all<Record<string, unknown>>();
  const packageRows = packages.results ?? [];
  if (
    packageRows.length === 0 ||
    packageRows.length > MAX_COMPLETION_PACKAGES ||
    packageRows.length !== packetPackages.length
  ) {
    throw new Error("completion_packages");
  }
  const frozen: Record<string, unknown>[] = [];
  for (const packageRow of packageRows) {
    const completedAt = text(packageRow.completed_at);
    if (packageRow.status !== "Completed" || packageRow.assignment_id !== assignmentId || !completedAt) {
      throw new Error("completion_packages");
    }
    const events = await env.DB.prepare(
      `SELECT event_id, work_package_id, work_package_version, event_kind, occurred_at,
              payload_json, created_at
         FROM work_package_events
        WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
        ORDER BY occurred_at, event_id LIMIT ?`,
    )
      .bind(row.tenant_id, text(packageRow.work_package_id), Number(packageRow.version), MAX_COMPLETION_EVENTS + 1)
      .all<Record<string, unknown>>();
    const eventRows = events.results ?? [];
    if (
      eventRows.length > MAX_COMPLETION_EVENTS ||
      eventRows.filter((event) => event.event_kind === "complete_work").length !== 1 ||
      eventRows.some((event) => text(event.occurred_at) > completedAt)
    ) {
      throw new Error("completion_events");
    }
    const evidence = await env.DB.prepare(
      `SELECT action.device_action_id, media.evidence_id, action.evidence_slot_id,
              action.evidence_freshness, action.evidence_conflict_state,
              action.evidence_verification, action.evidence_disposition,
              action.evidence_correction_of, action.evidence_item_correction_of,
              media.checksum_sha256, media.r2_key, action.created_at,
              action.capture_completed_at, media.r2_stored_at
         FROM field_actions action
         JOIN field_action_media media ON media.device_action_id = action.device_action_id
        WHERE action.tenant_id = ? AND action.job_id = ? AND action.assignment_id = ?
          AND action.work_package_id = ? AND action.work_package_version = ?
          AND action.status = 'verified' AND action.manifest_key IS NOT NULL
          AND media.r2_stored_at IS NOT NULL
        ORDER BY action.created_at, action.device_action_id, media.attachment_id LIMIT ?`,
    )
      .bind(
        row.tenant_id,
        row.roof_job_id,
        assignmentId,
        text(packageRow.work_package_id),
        Number(packageRow.version),
        MAX_COMPLETION_EVIDENCE + 1,
      )
      .all<Record<string, unknown>>();
    const evidenceRows = evidence.results ?? [];
    if (
      evidenceRows.length > MAX_COMPLETION_EVIDENCE ||
      evidenceRows.some(
        (item) =>
          text(item.created_at) > completedAt ||
          (item.capture_completed_at !== null && text(item.capture_completed_at) > completedAt) ||
          text(item.r2_stored_at) > completedAt,
      )
    ) {
      throw new Error("completion_evidence");
    }
    frozen.push({
      work_package_id: packageRow.work_package_id,
      version: Number(packageRow.version),
      assignment_id: packageRow.assignment_id,
      completed_at: packageRow.completed_at,
      definition_sha256: await sha256Hex(text(packageRow.definition_json)),
      events_sha256: await sha256Hex(canonicalJson(eventRows)),
      evidence_sha256: await sha256Hex(canonicalJson(evidenceRows)),
    });
  }
  if (
    canonicalJson(frozen) !== canonicalJson(packetPackages) ||
    (await sha256Hex(canonicalJson(frozen))) !== packet.work_package_set_sha256
  ) {
    throw new Error("completion_sources_changed");
  }
}

async function assertCommercialSourceFreshness(
  env: AppEnv,
  row: AccountingIntentRecord,
  basis: NativeFinalInvoiceBasisV2,
): Promise<void> {
  const quote = await env.DB.prepare(
    `SELECT * FROM commercial_quote_revisions
      WHERE tenant_id = ? AND quote_revision_id = ?`,
  )
    .bind(row.tenant_id, basis.accepted_quote.id)
    .first<Record<string, unknown>>();
  if (!quote) throw new Error("commercial_quote");
  const lines = await env.DB.prepare(
    `SELECT * FROM commercial_quote_lines WHERE quote_revision_id = ?
      ORDER BY sequence, line_id LIMIT 101`,
  )
    .bind(basis.accepted_quote.id)
    .all<Record<string, unknown>>();
  const quoteLines = lines.results ?? [];
  if (
    quoteLines.length === 0 ||
    quoteLines.length > 100 ||
    quote.roof_job_id !== row.roof_job_id ||
    (await sha256Hex(canonicalJson({ quote, lines: quoteLines }))) !== basis.accepted_quote.sha256 ||
    Number(quote.subtotal_cents) !== cents(basis.commercial_head.accepted_amounts.subtotal) ||
    Number(quote.tax_cents) !== cents(basis.commercial_head.accepted_amounts.tax_amount) ||
    Number(quote.total_cents) !== cents(basis.commercial_head.accepted_amounts.total_amount)
  ) {
    throw new Error("commercial_quote");
  }
  const proposal = await env.DB.prepare(
    `SELECT * FROM commercial_proposal_revisions
      WHERE tenant_id = ? AND proposal_revision_id = ?`,
  )
    .bind(row.tenant_id, basis.commercial_head.proposal.id)
    .first<Record<string, unknown>>();
  const publication = await env.DB.prepare(
    `SELECT * FROM commercial_proposal_publication_events
      WHERE tenant_id = ? AND publication_event_id = ?`,
  )
    .bind(row.tenant_id, basis.commercial_head.publication.id)
    .first<Record<string, unknown>>();
  const acceptance = await env.DB.prepare(
    `SELECT * FROM commercial_acceptance_bindings
      WHERE tenant_id = ? AND acceptance_binding_id = ?`,
  )
    .bind(row.tenant_id, basis.commercial_head.acceptance.id)
    .first<Record<string, unknown>>();
  if (
    !proposal ||
    !publication ||
    !acceptance ||
    (await sha256Hex(canonicalJson(proposal))) !== basis.commercial_head.proposal.sha256 ||
    (await sha256Hex(canonicalJson(publication))) !== basis.commercial_head.publication.sha256 ||
    (await sha256Hex(canonicalJson(acceptance))) !== basis.commercial_head.acceptance.sha256
  ) {
    throw new Error("commercial_chain");
  }
  const currentQuote = await env.DB.prepare(
    `SELECT current.quote_revision_id FROM commercial_quote_revisions current
      WHERE current.tenant_id = ? AND current.roof_job_id = ? AND current.customer_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM commercial_quote_revisions successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_quote_revision_id = current.quote_revision_id
        )
      ORDER BY current.revision_number DESC, current.quote_revision_id ASC LIMIT 2`,
  )
    .bind(row.tenant_id, row.roof_job_id, quote.customer_id)
    .all<{ quote_revision_id: string }>();
  const currentProposal = await env.DB.prepare(
    `SELECT current.proposal_revision_id FROM commercial_proposal_revisions current
      WHERE current.tenant_id = ? AND current.roof_job_id = ? AND current.customer_id = ?
        AND current.quote_revision_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_proposal_revision_id = current.proposal_revision_id
        )
      ORDER BY current.revision_number DESC, current.proposal_revision_id ASC LIMIT 2`,
  )
    .bind(row.tenant_id, row.roof_job_id, quote.customer_id, quote.quote_revision_id)
    .all<{ proposal_revision_id: string }>();
  const currentPublication = await env.DB.prepare(
    `SELECT current.publication_event_id FROM commercial_proposal_publication_events current
      WHERE current.tenant_id = ? AND current.proposal_pack_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_publication_events successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.proposal_pack_id = current.proposal_pack_id
             AND successor.publication_version > current.publication_version
        )
      ORDER BY current.publication_version DESC LIMIT 2`,
  )
    .bind(row.tenant_id, proposal.proposal_pack_id)
    .all<{ publication_event_id: string }>();
  const currentAcceptances = await env.DB.prepare(
    `SELECT acceptance_binding_id, accepted_at FROM commercial_acceptance_bindings
      WHERE tenant_id = ? AND roof_job_id = ?
      ORDER BY accepted_at DESC, acceptance_binding_id DESC LIMIT 2`,
  )
    .bind(row.tenant_id, row.roof_job_id)
    .all<{ acceptance_binding_id: string; accepted_at: string }>();
  const acceptanceHeads = currentAcceptances.results ?? [];
  if (
    (currentQuote.results ?? []).length !== 1 ||
    currentQuote.results![0]!.quote_revision_id !== basis.accepted_quote.id ||
    (currentProposal.results ?? []).length !== 1 ||
    currentProposal.results![0]!.proposal_revision_id !== basis.commercial_head.proposal.id ||
    (currentPublication.results ?? []).length !== 1 ||
    currentPublication.results![0]!.publication_event_id !== basis.commercial_head.publication.id ||
    acceptanceHeads[0]?.acceptance_binding_id !== basis.commercial_head.acceptance.id ||
    (acceptanceHeads.length > 1 && acceptanceHeads[0]!.accepted_at === acceptanceHeads[1]!.accepted_at)
  ) {
    throw new Error("commercial_head_changed");
  }
  const commercialHeadSha256 = await sha256Hex(
    canonicalJson({
      quote_sha256: basis.accepted_quote.sha256,
      proposal_sha256: basis.commercial_head.proposal.sha256,
      publication_sha256: basis.commercial_head.publication.sha256,
      acceptance_sha256: basis.commercial_head.acceptance.sha256,
    }),
  );
  const packet = await env.DB.prepare(
    `SELECT commercial_head_sha256 FROM native_completion_packets
      WHERE tenant_id = ? AND completion_packet_id = ?`,
  )
    .bind(row.tenant_id, basis.completion.id)
    .first<{ commercial_head_sha256: string }>();
  if (packet?.commercial_head_sha256 !== commercialHeadSha256) {
    throw new Error("commercial_packet_changed");
  }
}

async function assertProviderSourceFreshness(
  env: AppEnv,
  row: AccountingIntentRecord,
  basis: NativeFinalInvoiceBasisV2,
): Promise<void> {
  const binding = await env.DB.prepare(
    `SELECT * FROM native_final_invoice_provider_bindings
      WHERE tenant_id = ? AND roof_job_id = ? AND provider_binding_id = ?`,
  )
    .bind(row.tenant_id, row.roof_job_id, basis.provider_binding.id)
    .first<Record<string, unknown>>();
  const heads = await env.DB.prepare(
    `SELECT current.provider_binding_id
       FROM native_final_invoice_provider_bindings current
      WHERE current.tenant_id = ? AND current.roof_job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM native_final_invoice_provider_bindings successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_binding_id = current.provider_binding_id
        )
      ORDER BY current.binding_version DESC LIMIT 2`,
  )
    .bind(row.tenant_id, row.roof_job_id)
    .all<{ provider_binding_id: string }>();
  if (
    !binding ||
    (heads.results ?? []).length !== 1 ||
    heads.results![0]!.provider_binding_id !== basis.provider_binding.id ||
    Number(binding.binding_version) !== basis.provider_binding.version ||
    binding.realm_id !== row.realm_id ||
    binding.qbo_customer_id !== basis.qbo.customer_id ||
    binding.qbo_item_id !== basis.qbo.item_id ||
    binding.qbo_tax_code_id !== basis.qbo.tax_code_id ||
    binding.qbo_terms_id !== basis.qbo.terms_id ||
    binding.source_ref !== basis.provider_binding.source_ref ||
    binding.source_sha256 !== basis.provider_binding.source_sha256
  ) {
    throw new Error("provider_binding_changed");
  }
}

async function assertPriorInvoiceSourceFreshness(
  env: AppEnv,
  row: AccountingIntentRecord,
  basis: NativeFinalInvoiceBasisV2,
): Promise<void> {
  const priorRead = await env.DB.prepare(
    `SELECT * FROM accounting_intents
      WHERE tenant_id = ? AND roof_job_id = ?
        AND kind IN ('deposit_invoice','progress_invoice')
        AND (final_invoice_intent_id IS NULL OR final_invoice_intent_id != intent_id)
      ORDER BY intent_id LIMIT ?`,
  )
    .bind(row.tenant_id, row.roof_job_id, MAX_PRIOR_INVOICES + 1)
    .all<AccountingIntentRecord>();
  const rows = priorRead.results ?? [];
  if (
    rows.length > MAX_PRIOR_INVOICES ||
    rows.some((intent) => intent.state !== "rejected" && !["reconciled", "partially_settled"].includes(intent.state))
  ) {
    throw new Error("prior_invoice_unresolved");
  }
  const current = rows.filter((intent) => ["reconciled", "partially_settled"].includes(intent.state));
  if (current.length !== basis.prior_invoices.length) {
    throw new Error("prior_invoice_set_changed");
  }
  for (let index = 0; index < current.length; index += 1) {
    const intent = current[index]!;
    const frozen = basis.prior_invoices[index]!;
    if (
      intent.intent_id !== frozen.intent_id ||
      Number(intent.version) !== frozen.version ||
      intent.kind !== frozen.kind ||
      intent.basis_sha256 !== frozen.basis_sha256 ||
      intent.subtotal !== frozen.subtotal ||
      intent.tax_amount !== frozen.tax_amount ||
      intent.total_amount !== frozen.total_amount ||
      intent.provider_entity_id !== frozen.provider_entity_id ||
      intent.observed_sha256 !== frozen.observed_sha256
    ) {
      throw new Error("prior_invoice_changed");
    }
    const latestObservation = await env.DB.prepare(
      `SELECT observation.observation_id, reconciliation.intent_id,
              reconciliation.observed_sha256, reconciliation.verdict
         FROM accounting_observations observation
         JOIN accounting_reconciliations reconciliation
           ON reconciliation.tenant_id = observation.tenant_id
          AND reconciliation.observation_id = observation.observation_id
        WHERE observation.tenant_id = ? AND observation.realm_id = ?
          AND observation.entity_type = 'Invoice' AND observation.entity_id = ?
        ORDER BY observation.observation_seq DESC LIMIT 1`,
    )
      .bind(row.tenant_id, intent.realm_id, frozen.provider_entity_id)
      .first<{
        intent_id: string;
        observed_sha256: string | null;
        verdict: string;
      }>();
    if (
      latestObservation?.intent_id !== frozen.intent_id ||
      latestObservation.observed_sha256 !== frozen.observed_sha256 ||
      latestObservation.verdict !== intent.state
    ) {
      throw new Error("prior_invoice_readback_changed");
    }
  }
}

function parseBasis(value: string):
  | { basis: NativeFinalInvoiceBasis; code: null }
  | {
      basis: null;
      code: "native_final_invoice_basis_missing" | "native_final_invoice_basis_invalid";
    } {
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch {
    return { basis: null, code: "native_final_invoice_basis_missing" };
  }
  const basis = asRecord(raw);
  if (!basis || basis.purpose === undefined || basis.schema_version === undefined) {
    return { basis: null, code: "native_final_invoice_basis_missing" };
  }
  const commonKeys = [
    "schema_version",
    "purpose",
    "shop_order_id",
    "completion",
    "accepted_quote",
    "accepted_changes_sha256",
    "qbo",
    "commercial",
    "evidence",
  ];
  const v1 = basis.schema_version === 1;
  const v2 = basis.schema_version === 2;
  if (
    (!v1 && !v2) ||
    !exactKeys(basis, v2 ? [...commonKeys, "commercial_head", "prior_invoices", "provider_binding"] : commonKeys) ||
    basis.purpose !== PURPOSE
  ) {
    return { basis: null, code: "native_final_invoice_basis_invalid" };
  }
  const completion = asRecord(basis.completion);
  const quote = asRecord(basis.accepted_quote);
  const qbo = asRecord(basis.qbo);
  const commercial = asRecord(basis.commercial);
  if (
    !(basis.shop_order_id === null || SAFE_ID.test(text(basis.shop_order_id))) ||
    !source(completion) ||
    !source(quote) ||
    !SHA256.test(text(basis.accepted_changes_sha256)) ||
    !qbo ||
    !exactKeys(qbo, ["customer_id", "item_id", "tax_code_id", "terms_id"]) ||
    ![qbo.customer_id, qbo.item_id, qbo.tax_code_id, qbo.terms_id].every((id) => QBO_ID.test(text(id))) ||
    !commercial ||
    !validCommercial(commercial, quote, v2) ||
    !Array.isArray(basis.evidence) ||
    basis.evidence.length < 2 ||
    basis.evidence.length > 50 ||
    basis.evidence.some((citation) => !nativeCitation(citation)) ||
    !evidenceBindsBasis(basis.evidence, completion, quote, commercial) ||
    (v2 && !validV2Basis(basis, commercial))
  )
    return { basis: null, code: "native_final_invoice_basis_invalid" };
  return { basis: raw as NativeFinalInvoiceBasis, code: null };
}

function validCommercial(
  value: Record<string, unknown>,
  acceptedQuote: Record<string, unknown> | null,
  allowPriorBilling: boolean,
): boolean {
  if (
    !exactKeys(value, [
      "currency",
      "subtotal",
      "tax_amount",
      "total_amount",
      "already_invoiced",
      "final_balance",
      "tax_code",
      "tax_rate",
      "invoice_date",
      "due_date",
      "lines",
    ])
  )
    return false;
  if (
    value.currency !== "CAD" ||
    !MONEY.test(text(value.subtotal)) ||
    !MONEY.test(text(value.tax_amount)) ||
    !MONEY.test(text(value.total_amount)) ||
    !MONEY.test(text(value.already_invoiced)) ||
    (!allowPriorBilling && value.already_invoiced !== "0.00") ||
    !MONEY.test(text(value.final_balance)) ||
    !SAFE_ID.test(text(value.tax_code)) ||
    !TAX_RATE.test(text(value.tax_rate)) ||
    !validCalendarDate(value.invoice_date) ||
    !validCalendarDate(value.due_date) ||
    text(value.due_date) < text(value.invoice_date) ||
    !Array.isArray(value.lines) ||
    value.lines.length < 1 ||
    value.lines.length > 50
  )
    return false;
  let lineCents = 0;
  let quoteLines = 0;
  for (const item of value.lines) {
    const line = asRecord(item);
    if (
      !line ||
      !exactKeys(line, ["source_type", "source_id", "source_version", "description_code", "amount"]) ||
      !["Customer Quote", "Change Order"].includes(text(line.source_type)) ||
      !SAFE_ID.test(text(line.source_id)) ||
      !Number.isInteger(line.source_version) ||
      Number(line.source_version) < 1 ||
      !["RESIDENTIAL_ACCEPTED_QUOTE", "RESIDENTIAL_ACCEPTED_CHANGE"].includes(text(line.description_code)) ||
      !MONEY.test(text(line.amount))
    )
      return false;
    const sourceType = text(line.source_type);
    const descriptionCode = text(line.description_code);
    const sourceId = text(line.source_id);
    const sourceVersion = Number(line.source_version);
    if (
      (sourceType === "Customer Quote") !== (descriptionCode === "RESIDENTIAL_ACCEPTED_QUOTE") ||
      (sourceType === "Change Order") !== (descriptionCode === "RESIDENTIAL_ACCEPTED_CHANGE")
    )
      return false;
    if (sourceType === "Customer Quote") {
      quoteLines += 1;
      if (!acceptedQuote || sourceId !== acceptedQuote.id || sourceVersion !== acceptedQuote.version) return false;
    }
    lineCents += cents(text(line.amount));
  }
  const subtotal = cents(text(value.subtotal));
  const tax = cents(text(value.tax_amount));
  const total = cents(text(value.total_amount));
  return (
    quoteLines >= 1 && lineCents === subtotal && subtotal + tax === total && cents(text(value.final_balance)) === total
  );
}

function validV2Basis(basis: Record<string, unknown>, commercial: Record<string, unknown>): boolean {
  const head = asRecord(basis.commercial_head);
  const accepted = asRecord(head?.accepted_amounts);
  const provider = asRecord(basis.provider_binding);
  if (
    !head ||
    !exactKeys(head, ["proposal", "publication", "acceptance", "accepted_amounts"]) ||
    !source(asRecord(head.proposal)) ||
    !source(asRecord(head.publication)) ||
    !source(asRecord(head.acceptance)) ||
    Number(asRecord(head.acceptance)?.version) !== 1 ||
    !accepted ||
    !exactKeys(accepted, ["subtotal", "tax_amount", "total_amount"]) ||
    ![accepted.subtotal, accepted.tax_amount, accepted.total_amount].every((amount) => MONEY.test(text(amount))) ||
    cents(text(accepted.subtotal)) + cents(text(accepted.tax_amount)) !== cents(text(accepted.total_amount)) ||
    !provider ||
    !exactKeys(provider, ["id", "version", "source_ref", "source_sha256"]) ||
    !SAFE_ID.test(text(provider.id)) ||
    !Number.isInteger(provider.version) ||
    Number(provider.version) < 1 ||
    text(provider.source_ref).trim().length < 8 ||
    text(provider.source_ref).length > 200 ||
    !SHA256.test(text(provider.source_sha256)) ||
    !Array.isArray(basis.prior_invoices) ||
    basis.prior_invoices.length > 48
  ) {
    return false;
  }

  let priorSubtotal = 0;
  let priorTax = 0;
  let priorTotal = 0;
  let previousIntentId = "";
  for (const value of basis.prior_invoices) {
    const prior = asRecord(value);
    if (
      !prior ||
      !exactKeys(prior, [
        "intent_id",
        "version",
        "kind",
        "basis_sha256",
        "subtotal",
        "tax_amount",
        "total_amount",
        "provider_entity_id",
        "observed_sha256",
      ]) ||
      !SAFE_ID.test(text(prior.intent_id)) ||
      text(prior.intent_id) <= previousIntentId ||
      !Number.isInteger(prior.version) ||
      Number(prior.version) < 1 ||
      !["deposit_invoice", "progress_invoice"].includes(text(prior.kind)) ||
      !SHA256.test(text(prior.basis_sha256)) ||
      ![prior.subtotal, prior.tax_amount, prior.total_amount].every((amount) => MONEY.test(text(amount))) ||
      cents(text(prior.subtotal)) + cents(text(prior.tax_amount)) !== cents(text(prior.total_amount)) ||
      !QBO_ID.test(text(prior.provider_entity_id)) ||
      !SHA256.test(text(prior.observed_sha256))
    ) {
      return false;
    }
    previousIntentId = text(prior.intent_id);
    priorSubtotal += cents(text(prior.subtotal));
    priorTax += cents(text(prior.tax_amount));
    priorTotal += cents(text(prior.total_amount));
  }

  return (
    priorTotal === cents(text(commercial.already_invoiced)) &&
    priorSubtotal + cents(text(commercial.subtotal)) === cents(text(accepted.subtotal)) &&
    priorTax + cents(text(commercial.tax_amount)) === cents(text(accepted.tax_amount)) &&
    priorTotal + cents(text(commercial.total_amount)) === cents(text(accepted.total_amount)) &&
    evidenceBindsV2(basis.evidence as unknown[], head, provider, basis.prior_invoices)
  );
}

function evidenceBindsV2(
  evidence: unknown[],
  head: Record<string, unknown>,
  provider: Record<string, unknown>,
  priorInvoices: unknown[],
): boolean {
  const binds = (doctype: string, sourceValue: unknown, sha256?: unknown) => {
    const sourceRecord = asRecord(sourceValue);
    return (
      !!sourceRecord &&
      evidence.some((value) => {
        const citation = asRecord(value);
        return (
          citation?.doctype === doctype &&
          citation.name === sourceRecord.id &&
          (sha256 === undefined || citation.sha256 === sha256)
        );
      })
    );
  };
  if (
    !binds("Commercial Proposal", head.proposal, asRecord(head.proposal)?.sha256) ||
    !binds("Proposal Publication", head.publication, asRecord(head.publication)?.sha256) ||
    !binds("Customer Acceptance", head.acceptance, asRecord(head.acceptance)?.sha256) ||
    !binds("QuickBooks Provider Binding", provider, provider.source_sha256)
  ) {
    return false;
  }
  return priorInvoices.every((value) => {
    const prior = asRecord(value);
    return (
      prior &&
      evidence.some((candidate) => {
        const citation = asRecord(candidate);
        return (
          citation?.doctype === "Accounting Intent" &&
          citation.name === prior.intent_id &&
          citation.sha256 === prior.basis_sha256
        );
      })
    );
  });
}

function evidenceBindsBasis(
  evidence: unknown[],
  completion: Record<string, unknown> | null,
  quote: Record<string, unknown> | null,
  commercial: Record<string, unknown>,
): boolean {
  if (!completion || !quote || !Array.isArray(commercial.lines)) return false;
  const binds = (doctype: string, name: unknown, sha256?: unknown) =>
    evidence.some((value) => {
      const citation = asRecord(value);
      return (
        citation?.doctype === doctype && citation.name === name && (sha256 === undefined || citation.sha256 === sha256)
      );
    });
  if (!binds("Completion Packet", completion.id, completion.sha256) || !binds("Customer Quote", quote.id, quote.sha256))
    return false;
  return commercial.lines.every((value) => {
    const line = asRecord(value);
    return line?.source_type !== "Change Order" || binds("Change Order", line.source_id);
  });
}

function source(value: Record<string, unknown> | null): boolean {
  return (
    !!value &&
    exactKeys(value, ["id", "version", "sha256"]) &&
    SAFE_ID.test(text(value.id)) &&
    Number.isInteger(value.version) &&
    Number(value.version) > 0 &&
    SHA256.test(text(value.sha256))
  );
}

function nativeCitation(value: unknown): value is QuickBooksCitation {
  const citation = asRecord(value);
  if (
    !citation ||
    citation.source !== "IronWrap" ||
    !SHA256.test(text(citation.sha256))
  )
    return false;
  return (
    exactKeys(citation, ["source", "doctype", "name", "sha256"]) &&
    /^[A-Za-z][A-Za-z0-9 _-]{0,79}$/.test(text(citation.doctype)) &&
    SAFE_ID.test(text(citation.name))
  );
}

/** The basis tax fields, provider mapping, and immutable bound snapshot must describe one rate. */
async function assertFinalInvoiceTaxBinding(
  env: AppEnv,
  row: AccountingIntentRecord,
  basis: NativeFinalInvoiceBasis,
): Promise<void> {
  const bindings = await listAccountingIntentTaxBindings(
    env,
    row.tenant_id,
    row.intent_id,
  );
  if (bindings.length !== 1) throw new Error("tax_binding");
  const binding = bindings[0]!;
  const snapshot = await readTaxPolicySnapshot(
    env,
    row.tenant_id,
    binding.snapshot_id,
  );
  if (
    !snapshot ||
    binding.tax_code !== basis.commercial.tax_code ||
    snapshot.tax_code !== basis.commercial.tax_code ||
    snapshot.provider_tax_code_id !== basis.qbo.tax_code_id ||
    snapshot.rate_percent !== basis.commercial.tax_rate
  ) {
    throw new Error("tax_binding");
  }
}

function sourceDocumentsMatch(value: string, basis: NativeFinalInvoiceBasis): boolean {
  try {
    const documents = JSON.parse(value) as unknown;
    if (!Array.isArray(documents)) return false;
    const matches = (id: string, version: number) =>
      documents.some((item) => {
        const document = asRecord(item);
        return document?.id === id && Number(document.version) === version;
      });
    const required = [
      basis.completion,
      basis.accepted_quote,
      ...basis.commercial.lines.map((line) => ({
        id: line.source_id,
        version: line.source_version,
      })),
    ];
    if (basis.schema_version === 2) {
      required.push(
        basis.commercial_head.proposal,
        basis.commercial_head.publication,
        basis.commercial_head.acceptance,
        {
          id: basis.provider_binding.id,
          version: basis.provider_binding.version,
        },
        ...basis.prior_invoices.map((prior) => ({
          id: prior.intent_id,
          version: prior.version,
        })),
      );
    }
    return required.every((source) => matches(source.id, source.version));
  } catch {
    return false;
  }
}

function blocker(
  roofJobId: string,
  code: string,
  citations: QuickBooksCitation[],
): QuickBooksCandidateBlocker {
  return {
    roof_job_id: roofJobId,
    code,
    message:
      code === "native_final_invoice_basis_missing"
        ? "The native Job Packet has not produced a final-invoice basis."
        : "The native final-invoice basis does not match its accounting ledger bindings.",
    citations,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validCalendarDate(value: unknown): boolean {
  const candidate = text(value);
  if (!DATE.test(candidate)) return false;
  const timestamp = Date.parse(`${candidate}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === candidate
  );
}

function cents(value: string): number {
  const [whole, fraction] = value.split(".");
  return Number(whole) * 100 + Number(fraction);
}
