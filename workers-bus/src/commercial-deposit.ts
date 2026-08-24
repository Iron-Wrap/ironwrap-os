// commercial-deposit.ts - the native acceptance to deposit-intent handoff.
//
// A binding is the customer-facing commercial fact.  This module never accepts accounting or
// provider identifiers from a request; it reads the durable binding queue, the exact approved
// quote, the current native provider mapping, the tax snapshot, and the accounting ceiling.  A
// missing or conflicting prerequisite is recorded as a retryable blocker, never guessed through.

import type { AppEnv } from "./app-types.ts";
import {
  deriveAccountingIntent,
  readAccountingIntent,
  readAccountingIntentByBasis,
  type AccountingIntentRecord,
} from "./accounting-intents.ts";
import { readAccountingAuthorityCeiling } from "./accounting-authority-policy.ts";
import {
  bindAccountingIntentTaxSnapshots,
  currentTaxPolicySnapshot,
  taxBindingSetSha256,
  type TaxPolicySnapshotRecord,
} from "./accounting-tax-snapshots.ts";
import { localFactEnvelope, decimalFromCents } from "./accounting-normalizers.ts";
import {
  readAcceptedCommercialPaymentTerms,
  readNativeInitialProviderMapping,
  taxForSubtotal,
} from "./native-final-invoice-producer.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export interface CommercialDepositDerivationRecord {
  derivation_id: string;
  acceptance_binding_id: string;
  acceptance_id: string;
  tenant_id: string;
  quote_revision_id: string;
  proposal_revision_id: string;
  proposal_version: number;
  publication_event_id: string;
  publication_version: number;
  roof_job_id: string;
  customer_id: string;
  customer_quote_id: string;
  quote_version: number;
  quote_currency: "CAD";
  quote_subtotal_cents: number;
  quote_tax_cents: number;
  quote_total_cents: number;
  deposit_percent: number;
  terms_hash: string;
  receipt_hash: string;
  accepted_at: string;
  basis_json: string;
  basis_sha256: string | null;
  evidence_refs_json: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  state: "pending" | "blocked" | "derived";
  intent_id: string | null;
  blocker_code: string | null;
  blocker_next_step: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CommercialDepositDerivationResult {
  derivation: CommercialDepositDerivationRecord;
  intent: AccountingIntentRecord | null;
  replayed: boolean;
}

export interface CommercialDepositDerivationRequestRecord {
  request_id: string;
  tenant_id: string;
  derivation_id: string;
  acceptance_id: string;
  actor_user_id: string;
  idempotency_key_hash: string;
  command_fingerprint: string;
  authority_ref: string;
  policy_version: string;
  evidence_refs_json: string;
  state: "pending" | "derived" | "blocked" | "failed";
  version: number;
  derivation_version: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommercialDepositDerivationRequestResult {
  request: CommercialDepositDerivationRequestRecord;
  replayed: boolean;
}

export interface CommercialDepositDerivationEventRecord {
  event_id: string;
  derivation_id: string;
  tenant_id: string;
  event_version: number;
  event_type: "enqueued" | "blocked" | "derived";
  state: "pending" | "blocked" | "derived";
  intent_id: string | null;
  blocker_code: string | null;
  blocker_next_step: string | null;
  basis_sha256: string | null;
  command_fingerprint: string;
  evidence_refs_json: string;
  occurred_at: string;
}

interface DepositBasis {
  schema_version: "ironwrap.commercial-deposit-basis.v1";
  tenant_id: string;
  acceptance_id: string;
  acceptance_binding_id: string;
  quote_revision_id: string;
  quote_evidence_digest: string;
  proposal_revision_id: string;
  proposal_version: number;
  proposal_evidence_digest: string;
  publication_event_id: string;
  publication_version: number;
  publication_evidence_digest: string;
  roof_job_id: string;
  customer_id: string;
  customer_quote_id: string;
  quote_version: number;
  quote_currency: "CAD";
  quote_subtotal_cents: number;
  quote_tax_cents: number;
  quote_total_cents: number;
  deposit_percent: number;
  terms_hash: string;
  receipt_hash: string;
  accepted_at: string;
}

interface DerivedDepositFacts {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  txnDate: string;
  dueDate: string;
  providerBindingId: string;
  realmId: string;
  customerRef: string;
  itemRef: string;
  taxCodeRef: string;
  termsRef: string;
  jurisdiction: string;
  taxCode: string;
  taxSnapshot: TaxPolicySnapshotRecord;
}

export async function readCommercialDepositDerivation(
  env: AppEnv,
  tenantId: string,
  acceptanceId: string,
): Promise<CommercialDepositDerivationRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM commercial_deposit_derivations
      WHERE tenant_id = ? AND acceptance_id = ? LIMIT 1`,
  ).bind(tenantId, acceptanceId).first<CommercialDepositDerivationRecord>();
}

export async function readCommercialDepositDerivationEvent(
  env: AppEnv,
  tenantId: string,
  derivationId: string,
  version: number,
): Promise<CommercialDepositDerivationEventRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM commercial_deposit_derivation_events
      WHERE tenant_id = ? AND derivation_id = ? AND event_version = ? LIMIT 1`,
  ).bind(tenantId, derivationId, version).first<CommercialDepositDerivationEventRecord>();
}

/**
 * Record the authenticated recovery command before doing any work.  The request is separate from
 * the acceptance queue so a lost response can be replayed with the same actor/key while the queue
 * remains the single source of deposit intent truth.
 */
export async function beginCommercialDepositDerivationRequest(
  env: AppEnv,
  input: {
    tenantId: string;
    acceptanceId: string;
    actorUserId: string;
    idempotencyKey: string;
    policyVersion: string;
    evidenceRefs: readonly string[];
  },
  now = new Date(),
): Promise<CommercialDepositDerivationRequestResult | null> {
  const derivation = await readCommercialDepositDerivation(
    env,
    input.tenantId,
    input.acceptanceId,
  );
  if (!derivation) return null;
  const policyVersion = normalizedReconcilePolicyVersion(input.policyVersion);
  const evidenceRefs = normalizedReconcileEvidenceRefs(input.evidenceRefs);
  const evidenceRefsJson = canonicalJson(evidenceRefs);
  const idempotencyKeyHash = await sha256Hex(input.idempotencyKey);
  const commandFingerprint = await sha256Hex(canonicalJson({
    schema_version: "ironwrap.commercial-deposit-reconcile.v2",
    tenant_id: input.tenantId,
    acceptance_id: input.acceptanceId,
    policy_version: policyVersion,
    evidence_refs: evidenceRefs,
  }));
  const legacyCommandFingerprint = await sha256Hex(canonicalJson({
    schema_version: "ironwrap.commercial-deposit-reconcile.v1",
    tenant_id: input.tenantId,
    acceptance_id: input.acceptanceId,
  }));
  const existing = await env.DB.prepare(
    `SELECT * FROM commercial_deposit_derivation_requests
      WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
  ).bind(input.tenantId, idempotencyKeyHash)
    .first<CommercialDepositDerivationRequestRecord>();
  if (existing) {
    if (
      (existing.command_fingerprint !== commandFingerprint && existing.command_fingerprint !== legacyCommandFingerprint) ||
      existing.acceptance_id !== input.acceptanceId ||
      existing.actor_user_id !== input.actorUserId ||
      existing.policy_version !== policyVersion ||
      existing.evidence_refs_json !== evidenceRefsJson
    ) throw new Error("commercial_deposit_reconcile_idempotency_conflict");
    return { request: existing, replayed: true };
  }
  const request: CommercialDepositDerivationRequestRecord = {
    request_id: `commercial-deposit-reconcile:${input.tenantId}:${idempotencyKeyHash}`.slice(0, 180),
    tenant_id: input.tenantId,
    derivation_id: derivation.derivation_id,
    acceptance_id: input.acceptanceId,
    actor_user_id: input.actorUserId,
    idempotency_key_hash: idempotencyKeyHash,
    command_fingerprint: commandFingerprint,
    authority_ref: `app-session:${input.actorUserId}:commercial-deposit-reconcile`,
    policy_version: policyVersion,
    evidence_refs_json: evidenceRefsJson,
    state: "pending",
    version: 1,
    derivation_version: derivation.version,
    error_code: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  try {
    await env.DB.prepare(
      `INSERT INTO commercial_deposit_derivation_requests (
        request_id, tenant_id, derivation_id, acceptance_id, actor_user_id,
        idempotency_key_hash, command_fingerprint, authority_ref, policy_version,
        evidence_refs_json, state, version, derivation_version, error_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      request.request_id,
      request.tenant_id,
      request.derivation_id,
      request.acceptance_id,
      request.actor_user_id,
      request.idempotency_key_hash,
      request.command_fingerprint,
      request.authority_ref,
      request.policy_version,
      request.evidence_refs_json,
      request.state,
      request.version,
      request.derivation_version,
      request.error_code,
      request.created_at,
      request.updated_at,
    ).run();
  } catch (error) {
    const replay = await env.DB.prepare(
      `SELECT * FROM commercial_deposit_derivation_requests
        WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
    ).bind(input.tenantId, idempotencyKeyHash)
      .first<CommercialDepositDerivationRequestRecord>();
    if (!replay) throw error;
    if (
      (replay.command_fingerprint !== commandFingerprint && replay.command_fingerprint !== legacyCommandFingerprint) ||
      replay.acceptance_id !== input.acceptanceId ||
      replay.actor_user_id !== input.actorUserId ||
      replay.policy_version !== policyVersion ||
      replay.evidence_refs_json !== evidenceRefsJson
    ) throw new Error("commercial_deposit_reconcile_idempotency_conflict");
    return { request: replay, replayed: true };
  }
  return { request, replayed: false };
}

export async function finishCommercialDepositDerivationRequest(
  env: AppEnv,
  input: {
    tenantId: string;
    requestId: string;
    expectedVersion: number;
    state: "derived" | "blocked" | "failed";
    derivationVersion: number;
    errorCode?: string | null;
  },
  now = new Date(),
): Promise<CommercialDepositDerivationRequestRecord | null> {
  await env.DB.prepare(
    `UPDATE commercial_deposit_derivation_requests
        SET state = ?, version = version + 1, derivation_version = ?, error_code = ?, updated_at = ?
      WHERE tenant_id = ? AND request_id = ? AND version = ? AND state = 'pending'`,
  ).bind(
    input.state,
    input.derivationVersion,
    input.state === "failed" ? (input.errorCode ?? "commercial_deposit_reconcile_failed").slice(0, 120) : null,
    now.toISOString(),
    input.tenantId,
    input.requestId,
    input.expectedVersion,
  ).run();
  return await env.DB.prepare(
    `SELECT * FROM commercial_deposit_derivation_requests
      WHERE tenant_id = ? AND request_id = ? LIMIT 1`,
  ).bind(input.tenantId, input.requestId)
    .first<CommercialDepositDerivationRequestRecord>();
}

/**
 * Derive or replay the one deposit candidate for an accepted contract.
 *
 * The queue row is the recoverable handoff.  The only successful terminal state here is one with
 * an accounting intent id; blocked rows retain the exact reason and can be retried after the owner
 * repairs provider/tax/policy evidence.  No provider call is made by this function.
 */
export async function ensureCommercialDepositDerivation(
  env: AppEnv,
  input: { tenantId: string; acceptanceId: string },
  now = new Date(),
): Promise<CommercialDepositDerivationResult | null> {
  const row = await readCommercialDepositDerivation(env, input.tenantId, input.acceptanceId);
  if (!row) return null;

  let basis: DepositBasis;
  try {
    basis = parseBasis(row);
  } catch {
    return await blockDerivation(env, row, "commercial_deposit_basis_invalid", "rebuild_native_acceptance", now);
  }
  const basisSha256 = await sha256Hex(canonicalJson(basis));
  if (row.basis_sha256 && row.basis_sha256 !== basisSha256) {
    return await blockDerivation(env, row, "commercial_deposit_basis_changed", "reconcile_native_acceptance", now, basisSha256);
  }
  const commercial = await readAcceptedCommercialPaymentTerms(env, {
    tenantId: input.tenantId,
    roofJobId: basis.roof_job_id,
    customerId: basis.customer_id,
  });
  if (!commercial.ok || !commercialHeadMatchesBasis(commercial, basis)) {
    const code = commercial.ok ? "commercial_deposit_commercial_head_changed" : commercial.code;
    if (row.state === "derived") throw new Error(code);
    return await blockDerivation(env, row, code, commercialHeadNextStep(code), now, basisSha256);
  }
  if (row.state === "derived" && row.intent_id) {
    return {
      derivation: row,
      intent: await readAccountingIntent(env, input.tenantId, row.intent_id),
      replayed: true,
    };
  }
  if (basis.deposit_percent <= 0 || basis.deposit_percent > 100) {
    return await blockDerivation(env, row, "commercial_deposit_terms_invalid", "correct_approved_quote_terms", now, basisSha256);
  }

  const mapping = await readNativeInitialProviderMapping(env, input.tenantId, basis.roof_job_id);
  if (mapping.status === "unavailable") {
    return await blockDerivation(env, row, "provider_mapping_unavailable", "reconcile_native_provider_mapping", now, basisSha256);
  }
  if (mapping.status === "missing") {
    return await blockDerivation(env, row, "provider_mapping_missing", "record_native_provider_mapping", now, basisSha256);
  }
  if (mapping.status === "ambiguous") {
    return await blockDerivation(env, row, "provider_mapping_ambiguous", "reconcile_native_provider_mapping", now, basisSha256);
  }
  const provider = mapping.value;
  if (
    provider.commercial_terms_hash === null ||
    provider.commercial_terms_hash !== basis.terms_hash ||
    provider.commercial_head_sha256 === null ||
    provider.commercial_head_sha256 !== commercial.commercialHeadSha256
  ) {
    return await blockDerivation(env, row, "provider_mapping_commercial_head_changed", "reverify_native_provider_mapping", now, basisSha256);
  }

  const txnDate = basis.accepted_at.slice(0, 10);
  const snapshot = await currentTaxPolicySnapshot(env, {
    tenantId: input.tenantId,
    jurisdiction: provider.jurisdiction,
    taxCode: provider.tax_code,
    onDate: txnDate,
  });
  if (!snapshot) {
    return await blockDerivation(env, row, "tax_mapping_missing", "record_tax_policy_snapshot", now, basisSha256);
  }
  if (snapshot.provider_tax_code_id !== provider.qbo_tax_code_id) {
    return await blockDerivation(env, row, "provider_tax_mapping_mismatch", "correct_native_provider_mapping", now, basisSha256);
  }

  const taxContract = await validateDepositTaxContract(env, basis, provider, snapshot);
  if (!taxContract.ok) {
    return await blockDerivation(
      env,
      row,
      taxContract.code,
      taxContract.nextStep,
      now,
      basisSha256,
    );
  }
  const refreshedCommercial = await readAcceptedCommercialPaymentTerms(env, {
    tenantId: input.tenantId,
    roofJobId: basis.roof_job_id,
    customerId: basis.customer_id,
  });
  if (!refreshedCommercial.ok || !commercialHeadMatchesBasis(refreshedCommercial, basis)) {
    const code = refreshedCommercial.ok ? "commercial_deposit_commercial_head_changed" : refreshedCommercial.code;
    return await blockDerivation(env, row, code, commercialHeadNextStep(code), now, basisSha256);
  }
  if (
    provider.commercial_head_sha256 === null ||
    provider.commercial_head_sha256 !== refreshedCommercial.commercialHeadSha256
  ) {
    return await blockDerivation(
      env,
      row,
      "provider_mapping_commercial_head_changed",
      "reverify_native_provider_mapping",
      now,
      basisSha256,
    );
  }
  const facts = depositFacts(
    basis,
    provider,
    snapshot,
    taxContract.depositSubtotalCents,
    taxContract.depositTaxCents,
  );
  const accountingBasis = {
    schema_version: "ironwrap.accounting-commercial-deposit.v1",
    commercial_basis: basis,
    provider_binding: {
      provider_binding_id: provider.provider_binding_id,
      realm_id: provider.realm_id,
      qbo_customer_id: provider.qbo_customer_id,
      qbo_item_id: provider.qbo_item_id,
      qbo_tax_code_id: provider.qbo_tax_code_id,
      qbo_terms_id: provider.qbo_terms_id,
      jurisdiction: provider.jurisdiction,
      tax_code: provider.tax_code,
      payment_terms_days: provider.payment_terms_days,
      commercial_terms_hash: provider.commercial_terms_hash,
    },
    tax_snapshot_sha256: snapshot.snapshot_sha256,
    deposit: {
      subtotal: decimalFromCents(facts.subtotalCents),
      tax_amount: decimalFromCents(facts.taxCents),
      total: decimalFromCents(facts.totalCents),
      txn_date: facts.txnDate,
      due_date: facts.dueDate,
    },
  };
  const accountingBasisSha256 = await sha256Hex(canonicalJson(accountingBasis));
  const existing = await readAccountingIntentByBasis(
    env,
    input.tenantId,
    accountingBasisSha256,
  );
  if (existing) {
    await bindAccountingIntentTaxSnapshots(env, {
      tenantId: input.tenantId,
      intentId: existing.intent_id,
      snapshots: [snapshot],
    }, now);
    return await deriveSuccess(env, row, existing, basisSha256, now);
  }

  const ceiling = await readAccountingAuthorityCeiling(env, {
    tenantId: input.tenantId,
    kind: "deposit_invoice",
    onDate: txnDate,
  });
  const providerPayload = {
    CustomerRef: { value: facts.customerRef },
    CurrencyRef: { value: "CAD" },
    TxnDate: facts.txnDate,
    DueDate: facts.dueDate,
    SalesTermRef: { value: facts.termsRef },
    TotalAmt: decimalFromCents(facts.totalCents),
    TxnTaxDetail: { TotalTax: decimalFromCents(facts.taxCents) },
    Line: [{
      DetailType: "SalesItemLineDetail",
      Amount: decimalFromCents(facts.subtotalCents),
      SalesItemLineDetail: {
        ItemRef: { value: facts.itemRef },
        TaxCodeRef: { value: facts.taxCodeRef },
      },
    }],
  };
  const expected = localFactEnvelope({
    realmId: facts.realmId,
    entityType: "Invoice",
    payload: providerPayload,
  });
  const sourceDocuments = [
    { type: "commercial_acceptance_binding", id: basis.acceptance_binding_id, version: 1, sha256: basis.receipt_hash },
    { type: "commercial_quote_revision", id: basis.quote_revision_id, version: basis.quote_version, sha256: basis.quote_evidence_digest },
    { type: "commercial_proposal_revision", id: basis.proposal_revision_id, version: basis.proposal_version, sha256: basis.proposal_evidence_digest },
    { type: "commercial_proposal_publication", id: basis.publication_event_id, version: basis.publication_version, sha256: basis.publication_evidence_digest },
  ];
  const intentId = `acct-intent:${basis.roof_job_id}:deposit_invoice:${accountingBasisSha256.slice(0, 24)}`.slice(0, 160);
  let intent: AccountingIntentRecord;
  try {
    intent = await deriveAccountingIntent(env, {
      tenantId: input.tenantId,
      intentId,
      kind: "deposit_invoice",
      roofJobId: basis.roof_job_id,
      basis: accountingBasis,
      sourceDocuments,
      expected,
      taxPolicySnapshotSha256: await taxBindingSetSha256([snapshot.snapshot_sha256]),
      realmId: facts.realmId,
      providerPayload,
      providerRequestId: `req-${accountingBasisSha256.slice(0, 40)}`,
      subtotal: decimalFromCents(facts.subtotalCents),
      taxAmount: decimalFromCents(facts.taxCents),
      totalAmount: decimalFromCents(facts.totalCents),
      authority: {
        permitRef: `permit:commercial-acceptance:${basis.acceptance_id}`.slice(0, 160),
        policyRef: "policy:accounting:deposit-from-acceptance",
        policyVersion: ceiling.policyVersion ?? "platform-default-v1",
        maxAmount: ceiling.maxAmount,
      },
      effectIdempotencyKey: `acct:commercial-deposit:${basis.acceptance_id}:v1`.slice(0, 160),
      derivedBy: { actorKind: "agent", userId: null },
    }, now);
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    return await blockDerivation(
      env,
      row,
      commercialAccountingBlockCode(code),
      commercialAccountingNextStep(code),
      now,
      basisSha256,
    );
  }
  await bindAccountingIntentTaxSnapshots(env, {
    tenantId: input.tenantId,
    intentId: intent.intent_id,
    snapshots: [snapshot],
  }, now);
  return await deriveSuccess(env, row, intent, basisSha256, now);
}

function parseBasis(row: CommercialDepositDerivationRecord): DepositBasis {
  const parsed = JSON.parse(row.basis_json) as Partial<DepositBasis>;
  if (
    parsed.schema_version !== "ironwrap.commercial-deposit-basis.v1" ||
    parsed.tenant_id !== row.tenant_id ||
    parsed.acceptance_id !== row.acceptance_id ||
    parsed.acceptance_binding_id !== row.acceptance_binding_id ||
    parsed.quote_revision_id !== row.quote_revision_id ||
    !/^[0-9a-f]{64}$/.test(parsed.quote_evidence_digest ?? "") ||
    parsed.proposal_revision_id !== row.proposal_revision_id ||
    parsed.proposal_version !== row.proposal_version ||
    !/^[0-9a-f]{64}$/.test(parsed.proposal_evidence_digest ?? "") ||
    parsed.publication_event_id !== row.publication_event_id ||
    parsed.publication_version !== row.publication_version ||
    !/^[0-9a-f]{64}$/.test(parsed.publication_evidence_digest ?? "") ||
    parsed.roof_job_id !== row.roof_job_id ||
    parsed.customer_id !== row.customer_id ||
    parsed.customer_quote_id !== row.customer_quote_id ||
    parsed.quote_version !== row.quote_version ||
    parsed.quote_currency !== row.quote_currency ||
    parsed.quote_subtotal_cents !== row.quote_subtotal_cents ||
    parsed.quote_tax_cents !== row.quote_tax_cents ||
    parsed.quote_total_cents !== row.quote_total_cents ||
    parsed.deposit_percent !== row.deposit_percent ||
    parsed.terms_hash !== row.terms_hash ||
    parsed.receipt_hash !== row.receipt_hash ||
    parsed.accepted_at !== row.accepted_at
  ) throw new Error("commercial_deposit_basis_changed");
  return parsed as DepositBasis;
}

function commercialHeadMatchesBasis(
  commercial: {
    ok: true;
    termsHash: string;
    receiptHash: string;
    quoteRevisionId: string;
    quoteEvidenceDigest: string;
    proposalRevisionId: string;
    proposalEvidenceDigest: string;
    publicationEventId: string;
    publicationEvidenceDigest: string;
    acceptanceBindingId: string;
  },
  basis: DepositBasis,
): boolean {
  return commercial.quoteRevisionId === basis.quote_revision_id &&
    commercial.quoteEvidenceDigest === basis.quote_evidence_digest &&
    commercial.proposalRevisionId === basis.proposal_revision_id &&
    commercial.proposalEvidenceDigest === basis.proposal_evidence_digest &&
    commercial.publicationEventId === basis.publication_event_id &&
    commercial.publicationEvidenceDigest === basis.publication_evidence_digest &&
    commercial.acceptanceBindingId === basis.acceptance_binding_id &&
    commercial.termsHash === basis.terms_hash &&
    commercial.receiptHash === basis.receipt_hash;
}

function commercialHeadNextStep(code: string): string {
  return code.includes("acceptance") || code.includes("head")
    ? "reconcile_native_commercial_chain"
    : "repair_native_commercial_chain";
}

function depositFacts(
  basis: DepositBasis,
  provider: {
    provider_binding_id: string;
    realm_id: string;
    qbo_customer_id: string;
    qbo_item_id: string;
    qbo_tax_code_id: string;
    qbo_terms_id: string;
    jurisdiction: string;
    tax_code: string;
    payment_terms_days: number;
  },
  taxSnapshot: TaxPolicySnapshotRecord,
  subtotalCents: number,
  taxCents: number,
): DerivedDepositFacts {
  const totalCents = subtotalCents + taxCents;
  const txnDate = basis.accepted_at.slice(0, 10);
  const due = new Date(`${txnDate}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() + provider.payment_terms_days);
  return {
    subtotalCents,
    taxCents,
    totalCents,
    txnDate,
    dueDate: due.toISOString().slice(0, 10),
    providerBindingId: provider.provider_binding_id,
    realmId: provider.realm_id,
    customerRef: provider.qbo_customer_id,
    itemRef: provider.qbo_item_id,
    taxCodeRef: provider.qbo_tax_code_id,
    termsRef: provider.qbo_terms_id,
    jurisdiction: provider.jurisdiction,
    taxCode: provider.tax_code,
    taxSnapshot,
  };
}

type DepositTaxContract =
  | {
    ok: true;
    depositSubtotalCents: number;
    depositTaxCents: number;
  }
  | {
    ok: false;
    code: string;
    nextStep: string;
  };

/**
 * The deposit provider payload has one line and one TaxCodeRef.  Until the accounting contract
 * grows a multi-code representation, an accepted quote is usable here only when every immutable
 * quote line carries that same non-null provider code and the accepted aggregate tax agrees with
 * the immutable rate snapshot.  Deposit tax is then calculated from the deposit taxable subtotal,
 * never by scaling browser-supplied quote tax.
 */
async function validateDepositTaxContract(
  env: AppEnv,
  basis: DepositBasis,
  provider: { tax_code: string },
  taxSnapshot: TaxPolicySnapshotRecord,
): Promise<DepositTaxContract> {
  let lines: Array<{ tax_code: string | null }>;
  try {
    const result = await env.DB.prepare(
      `SELECT tax_code FROM commercial_quote_lines
        WHERE tenant_id = ? AND quote_revision_id = ?
        ORDER BY sequence`,
    ).bind(basis.tenant_id, basis.quote_revision_id).all<{ tax_code: string | null }>();
    lines = result.results ?? [];
  } catch {
    return {
      ok: false,
      code: "commercial_tax_mapping_unavailable",
      nextStep: "reconcile_commercial_tax_mapping",
    };
  }
  const codes = lines.map((line) => line.tax_code);
  const uniqueCodes = new Set(codes);
  if (
    lines.length === 0 ||
    codes.some((code) => typeof code !== "string" || code.trim().length === 0) ||
    uniqueCodes.size !== 1 ||
    codes[0] !== provider.tax_code
  ) {
    return {
      ok: false,
      code: "commercial_tax_code_ambiguous",
      nextStep: "correct_commercial_tax_mapping",
    };
  }

  const acceptedTax = taxForSubtotal(basis.quote_subtotal_cents, taxSnapshot.rate_percent);
  if (acceptedTax === null || acceptedTax !== basis.quote_tax_cents) {
    return {
      ok: false,
      code: "commercial_tax_snapshot_mismatch",
      nextStep: "correct_approved_quote_tax",
    };
  }

  const depositSubtotalCents = scaleCents(basis.quote_subtotal_cents, basis.deposit_percent);
  const depositTaxCents = depositSubtotalCents === null
    ? null
    : taxForSubtotal(depositSubtotalCents, taxSnapshot.rate_percent);
  if (depositSubtotalCents === null || depositTaxCents === null) {
    return {
      ok: false,
      code: "commercial_deposit_tax_amount_ambiguous",
      nextStep: "reconcile_commercial_deposit_tax",
    };
  }
  return { ok: true, depositSubtotalCents, depositTaxCents };
}

function scaleCents(cents: number, percent: number): number | null {
  if (
    !Number.isSafeInteger(cents) || cents < 0 ||
    !Number.isSafeInteger(percent) || percent < 0 || percent > 100
  ) return null;
  return Number((BigInt(cents) * BigInt(percent) + 50n) / 100n);
}

export async function deriveSuccess(
  env: AppEnv,
  row: CommercialDepositDerivationRecord,
  intent: AccountingIntentRecord,
  basisSha256: string,
  now: Date,
): Promise<CommercialDepositDerivationResult> {
  if (row.state === "derived" && row.intent_id === intent.intent_id) {
    return { derivation: row, intent, replayed: true };
  }
  const updated = await env.DB.prepare(
    `UPDATE commercial_deposit_derivations
        SET basis_sha256 = ?, state = 'derived', intent_id = ?, blocker_code = NULL,
            blocker_next_step = NULL, version = version + 1, updated_at = ?
      WHERE tenant_id = ? AND derivation_id = ? AND version = ?
        AND state IN ('pending', 'blocked')`,
  ).bind(
    basisSha256,
    intent.intent_id,
    now.toISOString(),
    row.tenant_id,
    row.derivation_id,
    row.version,
  ).run();
  const stored = await readCommercialDepositDerivation(env, row.tenant_id, row.acceptance_id);
  if (!stored) throw new Error("commercial_deposit_derivation_missing");
  if (stored.state === "derived" && stored.intent_id === intent.intent_id) {
    return { derivation: stored, intent, replayed: Number(updated.meta?.changes ?? 0) === 0 };
  }
  if (stored.state === "derived" && stored.intent_id !== intent.intent_id) {
    throw new Error("commercial_deposit_intent_conflict");
  }
  // The accounting insert can commit before this derivation CAS.  If another worker won with a
  // blocker (or has not published its own winner yet), the durable derivation row is authoritative
  // and this caller must not expose its locally-created intent as if it were bound to that row.
  return { derivation: stored, intent: null, replayed: false };
}

async function blockDerivation(
  env: AppEnv,
  row: CommercialDepositDerivationRecord,
  blockerCode: string,
  nextStep: string,
  now: Date,
  basisSha256?: string,
): Promise<CommercialDepositDerivationResult> {
  const updated = await env.DB.prepare(
    `UPDATE commercial_deposit_derivations
        SET basis_sha256 = COALESCE(?, basis_sha256), state = 'blocked', intent_id = NULL,
            blocker_code = ?, blocker_next_step = ?, version = version + 1, updated_at = ?
      WHERE tenant_id = ? AND derivation_id = ? AND version = ?
        AND state IN ('pending', 'blocked')
        AND (
          state != 'blocked' OR blocker_code != ? OR blocker_next_step != ?
          OR (? IS NOT NULL AND (basis_sha256 IS NULL OR basis_sha256 != ?))
        )`,
  ).bind(
    basisSha256 ?? null,
    blockerCode.slice(0, 120),
    nextStep.slice(0, 160),
    now.toISOString(),
    row.tenant_id,
    row.derivation_id,
    row.version,
    blockerCode,
    nextStep,
    basisSha256 ?? null,
    basisSha256 ?? null,
  ).run();
  const stored = await readCommercialDepositDerivation(env, row.tenant_id, row.acceptance_id);
  if (!stored) throw new Error("commercial_deposit_derivation_missing");
  // Another worker may have won the CAS between the blocker read and this update.  The durable
  // row is the authority in that race: return its exact accounting intent instead of reporting a
  // derived queue item with `intent: null` to the authenticated recovery caller.
  const intent = stored.state === "derived" && stored.intent_id
    ? await readAccountingIntent(env, stored.tenant_id, stored.intent_id)
    : null;
  return {
    derivation: stored,
    intent,
    replayed: Number(updated.meta?.changes ?? 0) === 0,
  };
}

function commercialAccountingBlockCode(code: string): string {
  if (code.includes("ceiling")) return "effect_policy_amount_ceiling_exceeded";
  if (code.includes("tax_mapping")) return "tax_mapping_missing";
  if (code.includes("amount")) return "accounting_amount_invalid";
  return "accounting_derivation_blocked";
}

function commercialAccountingNextStep(code: string): string {
  if (code.includes("ceiling")) return "review_accounting_authority_ceiling";
  if (code.includes("tax_mapping")) return "record_tax_policy_snapshot";
  return "reconcile_commercial_deposit_derivation";
}

function normalizedReconcilePolicyVersion(value: unknown): string {
  if (typeof value !== "string") throw new Error("commercial_deposit_reconcile_policy_invalid");
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("commercial_deposit_reconcile_policy_invalid");
  }
  return normalized;
}

function normalizedReconcileEvidenceRefs(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("commercial_deposit_reconcile_evidence_invalid");
  }
  const refs = value.map((entry) => {
    if (typeof entry !== "string") throw new Error("commercial_deposit_reconcile_evidence_invalid");
    const normalized = entry.trim();
    if (
      normalized.length < 3 || normalized.length > 512 || /[\s?#]/.test(normalized) ||
      normalized.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(normalized)
    ) throw new Error("commercial_deposit_reconcile_evidence_invalid");
    return normalized;
  }).sort();
  if (new Set(refs).size !== refs.length) throw new Error("commercial_deposit_reconcile_evidence_duplicate");
  return refs;
}
