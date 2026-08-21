// native-final-invoice-producer.ts - derive a reviewable final invoice from native facts only.
//
// The scheduled loop is deliberately a projection, not an accounting side effect. It freezes an
// exact completion/commercial packet and derives one pending-review accounting intent. Missing,
// ambiguous, stale, or provider-unreconciled truth is retained as a durable blocker instead of
// being filled from Frappe, display names, or an agent's guess.

import { readAccountingAuthorityCeiling } from "./accounting-authority-policy.ts";
import { deriveAccountingIntent, type AccountingIntentRecord } from "./accounting-intents.ts";
import {
  bindAccountingIntentTaxSnapshots,
  currentTaxPolicySnapshot,
  taxBindingSetSha256,
  type TaxPolicySnapshotRecord,
} from "./accounting-tax-snapshots.ts";
import type { AppEnv } from "./app-types.ts";
import { commercialPaymentTermsDays } from "./commercial-store.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  nativeFinalInvoiceEffectIdempotencyKey,
  nativeFinalInvoiceExpectedReadback,
  nativeFinalInvoiceProviderPayload,
  nativeFinalInvoiceProviderRequestId,
  type NativeFinalInvoiceBasisV2,
} from "./quickbooks-native-final-invoice.ts";

const MAX_JOBS = 50;
const MAX_PACKAGES = 50;
const MAX_EVENTS_PER_PACKAGE = 250;
const MAX_EVIDENCE_PER_PACKAGE = 250;
const MAX_PRIOR_INTENTS = 100;
const SHA256 = /^[a-f0-9]{64}$/;
const QBO_ID = /^[1-9][0-9]{0,31}$/;
const SAFE_SOURCE_REF = /^[^\r\n]{8,200}$/;

interface JobRow {
  tenant_id: string;
  roof_job_id: string;
  customer_id: string;
  version: number;
  job_status: string;
  updated_at: string;
}

interface AssignmentRow {
  assignment_id: string;
  assignment_version: number;
}

interface WorkPackageRow {
  work_package_id: string;
  tenant_id: string;
  version: number;
  job_id: string;
  assignment_id: string;
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
  status: string;
  definition_json: string;
  completed_at: string | null;
  updated_at: string;
}

interface WorkPackageEventRow {
  event_id: string;
  work_package_id: string;
  work_package_version: number;
  event_kind: string;
  occurred_at: string;
  payload_json: string;
  created_at: string;
}

interface EvidenceRow {
  device_action_id: string;
  evidence_id: string;
  evidence_slot_id: string;
  evidence_freshness: string;
  evidence_conflict_state: string;
  evidence_verification: string;
  evidence_disposition: string;
  evidence_correction_of: string | null;
  evidence_item_correction_of: string | null;
  checksum_sha256: string;
  r2_key: string;
  created_at: string;
  capture_completed_at: string | null;
  r2_stored_at: string;
}

interface QuoteRow {
  quote_revision_id: string;
  customer_quote_id: string;
  revision_number: number;
  roof_job_id: string;
  customer_id: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  terms_json: string;
  terms_hash: string;
  [key: string]: unknown;
}

interface QuoteLineRow {
  quote_revision_id: string;
  line_id: string;
  sequence: number;
  subtotal_cents: number;
  tax_code: string | null;
  tax_cents: number;
  total_cents: number;
  [key: string]: unknown;
}

interface ProposalRow {
  proposal_revision_id: string;
  proposal_pack_id: string;
  revision_number: number;
  quote_revision_id: string;
  roof_job_id: string;
  customer_id: string;
  terms_hash: string;
  [key: string]: unknown;
}

interface PublicationRow {
  publication_event_id: string;
  proposal_revision_id: string;
  proposal_pack_id: string;
  publication_version: number;
  state: string;
  occurred_at: string;
  [key: string]: unknown;
}

interface AcceptanceRow {
  acceptance_binding_id: string;
  acceptance_id: string;
  quote_revision_id: string;
  proposal_revision_id: string;
  roof_job_id: string;
  customer_id: string;
  terms_hash: string;
  receipt_hash: string;
  accepted_at: string;
  bound_at: string;
  [key: string]: unknown;
}

export interface NativeFinalInvoiceProviderBindingRecord {
  provider_binding_id: string;
  tenant_id: string;
  realm_id: string;
  roof_job_id: string;
  binding_version: number;
  qbo_customer_id: string;
  qbo_item_id: string;
  qbo_tax_code_id: string;
  qbo_terms_id: string;
  jurisdiction: string;
  tax_code: string;
  payment_terms_days: number;
  source_ref: string;
  source_sha256: string;
  commercial_terms_hash: string | null;
  commercial_head_sha256: string | null;
  supersedes_binding_id: string | null;
  correction_reason: string | null;
  recorded_at: string;
}

interface CompletionPacketRecord {
  completion_packet_id: string;
  tenant_id: string;
  roof_job_id: string;
  packet_version: number;
  work_package_set_sha256: string;
  commercial_head_sha256: string;
  packet_json: string;
  packet_sha256: string;
  completed_at: string;
  created_at: string;
}

interface CompletionSnapshot {
  assignment: AssignmentRow;
  packages: Array<{
    work_package_id: string;
    version: number;
    assignment_id: string;
    completed_at: string;
    definition_sha256: string;
    events_sha256: string;
    evidence_sha256: string;
  }>;
  completedAt: string;
  sha256: string;
}

interface CommercialHead {
  quote: QuoteRow;
  lines: QuoteLineRow[];
  proposal: ProposalRow;
  publication: PublicationRow;
  acceptance: AcceptanceRow;
  quoteSha256: string;
  proposalSha256: string;
  publicationSha256: string;
  acceptanceSha256: string;
  sha256: string;
}

interface PriorInvoice {
  intent_id: string;
  version: number;
  kind: "deposit_invoice" | "progress_invoice";
  basis_sha256: string;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  provider_entity_id: string;
  observed_sha256: string;
}

interface ProviderFacts {
  realmId: string;
  customerId: string;
  itemId: string;
  taxCodeId: string;
  termsId: string;
  paymentTermsDays: number;
  jurisdiction: string;
  taxCode: string;
}

interface PriorInvoiceRead {
  invoices: PriorInvoice[];
  providerFacts: ProviderFacts[];
  sourceSha256: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

interface BlockedRead {
  code: string;
  nextStep: string;
  facts: unknown;
}

type Checked<T> = { value: T; blocked?: never } | { value?: never; blocked: BlockedRead };

export type NativeFinalInvoiceDerivationResult =
  | {
      outcome: "blocked";
      roof_job_id: string;
      observation_id: string;
      blocker_code: string;
      blocker_next_step: string;
    }
  | {
      outcome: "no_balance";
      roof_job_id: string;
      observation_id: string;
      completion_packet_id: string;
    }
  | {
      outcome: "intent_derived";
      roof_job_id: string;
      observation_id: string;
      completion_packet_id: string;
      accounting_intent_id: string;
      replayed: boolean;
    };

export interface NativeFinalInvoiceDerivationCounts {
  scanned: number;
  blocked: number;
  no_balance: number;
  intents_derived: number;
  intents_replayed: number;
}

export async function recordNativeFinalInvoiceProviderBinding(
  env: AppEnv,
  input: {
    tenantId: string;
    realmId: string;
    roofJobId: string;
    qboCustomerId: string;
    qboItemId: string;
    qboTaxCodeId: string;
    qboTermsId: string;
    jurisdiction: string;
    taxCode: string;
    paymentTermsDays: number;
    sourceRef: string;
    sourceSha256: string;
    commercialTermsHash: string;
    commercialHeadSha256: string;
    correctionReason?: string | null;
  },
  now = new Date(),
): Promise<NativeFinalInvoiceProviderBindingRecord> {
  if (
    ![input.realmId, input.qboCustomerId, input.qboItemId, input.qboTaxCodeId, input.qboTermsId].every((value) =>
      QBO_ID.test(value),
    ) ||
    !/^[A-Za-z0-9._:-]{2,32}$/.test(input.jurisdiction) ||
    !/^[A-Za-z0-9._:-]{1,32}$/.test(input.taxCode) ||
    !Number.isInteger(input.paymentTermsDays) ||
    input.paymentTermsDays < 0 ||
    input.paymentTermsDays > 365 ||
    !SAFE_SOURCE_REF.test(input.sourceRef) ||
    !SHA256.test(input.sourceSha256) ||
    !SHA256.test(input.commercialTermsHash) ||
    !SHA256.test(input.commercialHeadSha256)
  ) {
    throw new Error("native_final_invoice_provider_binding_invalid");
  }
  const facts = {
    realm_id: input.realmId,
    qbo_customer_id: input.qboCustomerId,
    qbo_item_id: input.qboItemId,
    qbo_tax_code_id: input.qboTaxCodeId,
    qbo_terms_id: input.qboTermsId,
    jurisdiction: input.jurisdiction,
    tax_code: input.taxCode,
    payment_terms_days: input.paymentTermsDays,
    source_ref: input.sourceRef,
    source_sha256: input.sourceSha256,
    commercial_terms_hash: input.commercialTermsHash,
    commercial_head_sha256: input.commercialHeadSha256,
  };
  const priorSource = await env.DB.prepare(
    `SELECT * FROM native_final_invoice_provider_bindings
      WHERE tenant_id = ? AND roof_job_id = ? AND source_ref = ?
      ORDER BY binding_version DESC LIMIT 2`,
  )
    .bind(input.tenantId, input.roofJobId, input.sourceRef)
    .all<NativeFinalInvoiceProviderBindingRecord>();
  const priorSourceRows = priorSource.results ?? [];
  if (priorSourceRows.length > 1) {
    throw new Error("native_final_invoice_provider_binding_idempotency_ambiguous");
  }
  if (priorSourceRows[0]) {
    if (canonicalJson(bindingFacts(priorSourceRows[0])) === canonicalJson(facts)) {
      return priorSourceRows[0];
    }
    throw new Error("native_final_invoice_provider_binding_idempotency_conflict");
  }
  const heads = await currentProviderBindingHeads(env, input.tenantId, input.roofJobId);
  if (heads.length > 1) {
    throw new Error("native_final_invoice_provider_binding_ambiguous");
  }
  const current = heads[0] ?? null;
  if (current && canonicalJson(bindingFacts(current)) === canonicalJson(facts)) return current;
  if (current && !input.correctionReason?.trim()) {
    throw new Error("native_final_invoice_provider_binding_correction_required");
  }
  if (!current && input.correctionReason) {
    throw new Error("native_final_invoice_provider_binding_correction_invalid");
  }
  const version = (current?.binding_version ?? 0) + 1;
  const identitySha256 = await sha256Hex(
    canonicalJson({
      tenant_id: input.tenantId,
      roof_job_id: input.roofJobId,
      binding_version: version,
      ...facts,
    }),
  );
  const bindingId = `nfpb_${identitySha256}`;
  try {
    await env.DB.prepare(
      `INSERT INTO native_final_invoice_provider_bindings (
         provider_binding_id, tenant_id, realm_id, roof_job_id, binding_version,
         qbo_customer_id, qbo_item_id, qbo_tax_code_id, qbo_terms_id, jurisdiction, tax_code,
         payment_terms_days, source_ref, source_sha256, commercial_terms_hash,
         commercial_head_sha256, supersedes_binding_id, correction_reason, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        bindingId,
        input.tenantId,
        input.realmId,
        input.roofJobId,
        version,
        input.qboCustomerId,
        input.qboItemId,
        input.qboTaxCodeId,
        input.qboTermsId,
        input.jurisdiction,
        input.taxCode,
        input.paymentTermsDays,
        input.sourceRef,
        input.sourceSha256,
        input.commercialTermsHash,
        input.commercialHeadSha256,
        current?.provider_binding_id ?? null,
        input.correctionReason?.trim() || null,
        now.toISOString(),
      )
      .run();
  } catch (error) {
    const raced = await env.DB.prepare(
      `SELECT * FROM native_final_invoice_provider_bindings
        WHERE tenant_id = ? AND roof_job_id = ? AND source_ref = ?`,
    )
      .bind(input.tenantId, input.roofJobId, input.sourceRef)
      .first<NativeFinalInvoiceProviderBindingRecord>();
    if (!raced) throw error;
    if (canonicalJson(bindingFacts(raced)) !== canonicalJson(facts)) {
      throw new Error("native_final_invoice_provider_binding_idempotency_conflict");
    }
    return raced;
  }
  const stored = await env.DB.prepare(
    `SELECT * FROM native_final_invoice_provider_bindings
      WHERE tenant_id = ? AND provider_binding_id = ?`,
  )
    .bind(input.tenantId, bindingId)
    .first<NativeFinalInvoiceProviderBindingRecord>();
  if (!stored) throw new Error("native_final_invoice_provider_binding_write_failed");
  return stored;
}

export async function deriveNativeFinalInvoiceForJob(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
  now = new Date(),
): Promise<NativeFinalInvoiceDerivationResult> {
  const job = await env.DB.prepare(
    `SELECT tenant_id, roof_job_id, customer_id, version, job_status, updated_at
       FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?`,
  )
    .bind(input.tenantId, input.roofJobId)
    .first<JobRow>();
  if (!job) {
    throw new Error("native_final_invoice_job_missing");
  }
  const baseFacts = {
    schema_version: 1,
    tenant_id: input.tenantId,
    roof_job_id: input.roofJobId,
    job_version: Number(job.version),
    job_status: job.job_status,
  };

  const completion = await readCompletionSnapshot(env, input);
  if (completion.blocked) return await recordBlocked(env, input, completion.blocked, baseFacts, now);
  const commercial = await readCommercialHead(env, input, job.customer_id);
  if (commercial.blocked)
    return await recordBlocked(
      env,
      input,
      commercial.blocked,
      {
        ...baseFacts,
        completion_sha256: completion.value.sha256,
      },
      now,
    );
  const prior = await readPriorInvoices(env, input);
  if (prior.blocked)
    return await recordBlocked(
      env,
      input,
      prior.blocked,
      {
        ...baseFacts,
        completion_sha256: completion.value.sha256,
        commercial_head_sha256: commercial.value.sha256,
      },
      now,
    );
  const provider = await resolveProviderBinding(env, input, commercial.value, prior.value, now);
  if (provider.blocked)
    return await recordBlocked(
      env,
      input,
      provider.blocked,
      {
        ...baseFacts,
        completion_sha256: completion.value.sha256,
        commercial_head_sha256: commercial.value.sha256,
        prior_invoices_sha256: prior.value.sourceSha256,
      },
      now,
    );

  const invoiceDate = completion.value.completedAt.slice(0, 10);
  const taxSnapshot = await currentTaxPolicySnapshot(env, {
    tenantId: input.tenantId,
    jurisdiction: provider.value.jurisdiction,
    taxCode: provider.value.tax_code,
    onDate: invoiceDate,
  });
  if (!taxSnapshot || taxSnapshot.provider_tax_code_id !== provider.value.qbo_tax_code_id) {
    return await recordBlocked(
      env,
      input,
      {
        code: "tax_mapping_missing",
        nextStep: "record_current_native_tax_mapping",
        facts: {
          provider_binding_id: provider.value.provider_binding_id,
          jurisdiction: provider.value.jurisdiction,
          tax_code: provider.value.tax_code,
          invoice_date: invoiceDate,
          snapshot_id: taxSnapshot?.snapshot_id ?? null,
          snapshot_provider_tax_code_id: taxSnapshot?.provider_tax_code_id ?? null,
        },
      },
      baseFacts,
      now,
    );
  }

  const monetary = validateMoneyTruth(commercial.value, prior.value, provider.value, taxSnapshot);
  if (monetary.blocked)
    return await recordBlocked(
      env,
      input,
      monetary.blocked,
      {
        ...baseFacts,
        commercial_head_sha256: commercial.value.sha256,
        prior_invoices_sha256: prior.value.sourceSha256,
        tax_snapshot_sha256: taxSnapshot.snapshot_sha256,
      },
      now,
    );

  const packet = await ensureCompletionPacket(env, input, completion.value, commercial.value, now);
  if (monetary.value.totalCents === 0) {
    const observation = await recordObservation(
      env,
      input,
      {
        outcome: "no_balance",
        completionPacketId: packet.completion_packet_id,
        accountingIntentId: null,
        basisSha256: null,
        blocker: null,
        facts: {
          packet_sha256: packet.packet_sha256,
          prior_invoices_sha256: prior.value.sourceSha256,
          accepted_total: money(commercial.value.quote.total_cents),
          prior_total: money(prior.value.totalCents),
        },
      },
      now,
    );
    return {
      outcome: "no_balance",
      roof_job_id: input.roofJobId,
      observation_id: observation,
      completion_packet_id: packet.completion_packet_id,
    };
  }

  const dueDate = addUtcDays(invoiceDate, provider.value.payment_terms_days);
  const acceptedChangesSha256 = await sha256Hex(canonicalJson([]));
  const priorInvoices = [...prior.value.invoices].sort((left, right) => left.intent_id.localeCompare(right.intent_id));
  const evidence: NativeFinalInvoiceBasisV2["evidence"] = [
    citation("Completion Packet", packet.completion_packet_id, packet.packet_sha256),
    citation("Customer Quote", commercial.value.quote.quote_revision_id, commercial.value.quoteSha256),
    citation("Commercial Proposal", commercial.value.proposal.proposal_revision_id, commercial.value.proposalSha256),
    citation(
      "Proposal Publication",
      commercial.value.publication.publication_event_id,
      commercial.value.publicationSha256,
    ),
    citation(
      "Customer Acceptance",
      commercial.value.acceptance.acceptance_binding_id,
      commercial.value.acceptanceSha256,
    ),
    citation("QuickBooks Provider Binding", provider.value.provider_binding_id, provider.value.source_sha256),
    ...priorInvoices.map((priorInvoice) =>
      citation("Accounting Intent", priorInvoice.intent_id, priorInvoice.basis_sha256),
    ),
  ];
  if (evidence.length > 50) {
    return await recordBlocked(
      env,
      input,
      {
        code: "native_final_invoice_evidence_overflow",
        nextStep: "consolidate_prior_invoice_evidence",
        facts: { evidence_count: evidence.length },
      },
      baseFacts,
      now,
    );
  }
  const basis: NativeFinalInvoiceBasisV2 = {
    schema_version: 2,
    purpose: "quickbooks_final_invoice",
    shop_order_id: null,
    completion: {
      id: packet.completion_packet_id,
      version: packet.packet_version,
      sha256: packet.packet_sha256,
    },
    accepted_quote: {
      id: commercial.value.quote.quote_revision_id,
      version: commercial.value.quote.revision_number,
      sha256: commercial.value.quoteSha256,
    },
    accepted_changes_sha256: acceptedChangesSha256,
    commercial_head: {
      proposal: {
        id: commercial.value.proposal.proposal_revision_id,
        version: commercial.value.proposal.revision_number,
        sha256: commercial.value.proposalSha256,
      },
      publication: {
        id: commercial.value.publication.publication_event_id,
        version: commercial.value.publication.publication_version,
        sha256: commercial.value.publicationSha256,
      },
      acceptance: {
        id: commercial.value.acceptance.acceptance_binding_id,
        version: 1,
        sha256: commercial.value.acceptanceSha256,
      },
      accepted_amounts: {
        subtotal: money(commercial.value.quote.subtotal_cents),
        tax_amount: money(commercial.value.quote.tax_cents),
        total_amount: money(commercial.value.quote.total_cents),
      },
    },
    prior_invoices: priorInvoices,
    provider_binding: {
      id: provider.value.provider_binding_id,
      version: provider.value.binding_version,
      source_ref: provider.value.source_ref,
      source_sha256: provider.value.source_sha256,
    },
    qbo: {
      customer_id: provider.value.qbo_customer_id,
      item_id: provider.value.qbo_item_id,
      tax_code_id: provider.value.qbo_tax_code_id,
      terms_id: provider.value.qbo_terms_id,
    },
    commercial: {
      currency: "CAD",
      subtotal: money(monetary.value.subtotalCents),
      tax_amount: money(monetary.value.taxCents),
      total_amount: money(monetary.value.totalCents),
      already_invoiced: money(prior.value.totalCents),
      final_balance: money(monetary.value.totalCents),
      tax_code: provider.value.tax_code,
      tax_rate: taxSnapshot.rate_percent,
      invoice_date: invoiceDate,
      due_date: dueDate,
      lines: [
        {
          source_type: "Customer Quote",
          source_id: commercial.value.quote.quote_revision_id,
          source_version: commercial.value.quote.revision_number,
          description_code: "RESIDENTIAL_ACCEPTED_QUOTE",
          amount: money(monetary.value.subtotalCents),
        },
      ],
    },
    evidence,
  };
  const basisJson = canonicalJson(basis);
  const basisSha256 = await sha256Hex(basisJson);
  const finalIntentRead = await env.DB.prepare(
    `SELECT * FROM accounting_intents
      WHERE tenant_id = ? AND roof_job_id = ? AND final_invoice_intent_id = intent_id
      ORDER BY derived_at, intent_id LIMIT 11`,
  )
    .bind(input.tenantId, input.roofJobId)
    .all<AccountingIntentRecord>();
  const finalIntents = finalIntentRead.results ?? [];
  if (finalIntents.length > 10 || finalIntents.some((row) => row.basis_sha256 !== basisSha256)) {
    return await recordBlocked(
      env,
      input,
      {
        code: "existing_final_invoice_requires_reconciliation",
        nextStep: "reconcile_existing_final_invoice_intent",
        facts: {
          proposed_basis_sha256: basisSha256,
          existing: finalIntents.map((row) => ({
            intent_id: row.intent_id,
            basis_sha256: row.basis_sha256,
            state: row.state,
          })),
        },
      },
      baseFacts,
      now,
    );
  }
  const existing = finalIntents.find((row) => row.basis_sha256 === basisSha256) ?? null;
  if (existing?.state === "rejected") {
    return await recordBlocked(
      env,
      input,
      {
        code: "final_invoice_previously_rejected",
        nextStep: "review_rejected_final_invoice_intent",
        facts: {
          intent_id: existing.intent_id,
          basis_sha256: existing.basis_sha256,
        },
      },
      baseFacts,
      now,
    );
  }
  const intentId = `acct-fi-${basisSha256.slice(0, 56)}`;
  const providerPayload = nativeFinalInvoiceProviderPayload(basis);
  const providerPayloadSha256 = await sha256Hex(canonicalJson(providerPayload));
  const providerRequestId = await nativeFinalInvoiceProviderRequestId({
    tenantId: input.tenantId,
    realmId: provider.value.realm_id,
    intentId,
    providerPayloadSha256,
  });
  const ceiling = await readAccountingAuthorityCeiling(env, {
    tenantId: input.tenantId,
    kind: "progress_invoice",
    onDate: invoiceDate,
  });
  if (monetary.value.totalCents > parseMoney(ceiling.maxAmount)) {
    return await recordBlocked(
      env,
      input,
      {
        code: "effect_policy_amount_ceiling_exceeded",
        nextStep: "record_accounting_authority_policy",
        facts: {
          final_total: money(monetary.value.totalCents),
          authority_max_amount: ceiling.maxAmount,
          authority_source: ceiling.source,
          authority_policy_version: ceiling.policyVersion,
        },
      },
      baseFacts,
      now,
    );
  }
  const taxPolicySnapshotSha256 = await taxBindingSetSha256([taxSnapshot.snapshot_sha256]);
  const sourceDocuments = [
    document(packet.completion_packet_id, packet.packet_version, packet.packet_sha256),
    document(
      commercial.value.quote.quote_revision_id,
      commercial.value.quote.revision_number,
      commercial.value.quoteSha256,
    ),
    document(
      commercial.value.proposal.proposal_revision_id,
      commercial.value.proposal.revision_number,
      commercial.value.proposalSha256,
    ),
    document(
      commercial.value.publication.publication_event_id,
      commercial.value.publication.publication_version,
      commercial.value.publicationSha256,
    ),
    document(commercial.value.acceptance.acceptance_binding_id, 1, commercial.value.acceptanceSha256),
    document(provider.value.provider_binding_id, provider.value.binding_version, provider.value.source_sha256),
    ...priorInvoices.map((priorInvoice) =>
      document(priorInvoice.intent_id, priorInvoice.version, priorInvoice.basis_sha256),
    ),
  ];
  if (existing && !["pending_review", "blocked"].includes(existing.state)) {
    const observation = await recordObservation(
      env,
      input,
      {
        outcome: "intent_derived",
        completionPacketId: packet.completion_packet_id,
        accountingIntentId: existing.intent_id,
        basisSha256,
        blocker: null,
        facts: {
          packet_sha256: packet.packet_sha256,
          provider_binding_id: provider.value.provider_binding_id,
          prior_invoices_sha256: prior.value.sourceSha256,
          tax_snapshot_sha256: taxSnapshot.snapshot_sha256,
          basis_sha256: basisSha256,
          existing_state: existing.state,
        },
      },
      now,
    );
    return {
      outcome: "intent_derived",
      roof_job_id: input.roofJobId,
      observation_id: observation,
      completion_packet_id: packet.completion_packet_id,
      accounting_intent_id: existing.intent_id,
      replayed: true,
    };
  }
  const intent = await deriveAccountingIntent(
    env,
    {
      tenantId: input.tenantId,
      intentId,
      kind: "progress_invoice",
      roofJobId: input.roofJobId,
      basis,
      sourceDocuments,
      expected: nativeFinalInvoiceExpectedReadback({
        realmId: provider.value.realm_id,
        basis,
      }),
      taxPolicySnapshotSha256,
      realmId: provider.value.realm_id,
      providerPayload,
      providerRequestId,
      subtotal: basis.commercial.subtotal,
      taxAmount: basis.commercial.tax_amount,
      totalAmount: basis.commercial.total_amount,
      authority: {
        permitRef: "agent-derivation:pending-human-review",
        policyRef:
          ceiling.source === "tenant_policy" ? "accounting-authority-policy" : "accounting-authority-platform-default",
        policyVersion: ceiling.policyVersion ?? "platform-default-v1",
        maxAmount: ceiling.maxAmount,
      },
      effectIdempotencyKey: nativeFinalInvoiceEffectIdempotencyKey({
        providerRequestId,
        providerPayloadSha256,
      }),
      derivedBy: { actorKind: "agent" },
      finalInvoiceIntentId: intentId,
    },
    now,
  );
  await bindAccountingIntentTaxSnapshots(
    env,
    {
      tenantId: input.tenantId,
      intentId: intent.intent_id,
      snapshots: [taxSnapshot],
    },
    now,
  );
  const observation = await recordObservation(
    env,
    input,
    {
      outcome: "intent_derived",
      completionPacketId: packet.completion_packet_id,
      accountingIntentId: intent.intent_id,
      basisSha256,
      blocker: null,
      facts: {
        packet_sha256: packet.packet_sha256,
        provider_binding_id: provider.value.provider_binding_id,
        provider_source_sha256: provider.value.source_sha256,
        prior_invoices_sha256: prior.value.sourceSha256,
        tax_snapshot_sha256: taxSnapshot.snapshot_sha256,
        basis_sha256: basisSha256,
      },
    },
    now,
  );
  return {
    outcome: "intent_derived",
    roof_job_id: input.roofJobId,
    observation_id: observation,
    completion_packet_id: packet.completion_packet_id,
    accounting_intent_id: intent.intent_id,
    replayed: existing !== null,
  };
}

export async function deriveNativeFinalInvoiceIntents(
  env: AppEnv,
  now = new Date(),
  requestedLimit = 25,
): Promise<NativeFinalInvoiceDerivationCounts> {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(MAX_JOBS, Math.trunc(requestedLimit))) : 25;
  const cursor = await env.DB.prepare(
    `SELECT last_tenant_id, last_roof_job_id
       FROM native_final_invoice_derivation_cursors WHERE cursor_name = 'scheduled-v1'`,
  ).first<{ last_tenant_id: string; last_roof_job_id: string }>();
  const after = await env.DB.prepare(
    `SELECT job.tenant_id, job.roof_job_id
       FROM operating_roof_jobs job
      WHERE EXISTS (
        SELECT 1 FROM work_packages package
         WHERE package.tenant_id = job.tenant_id AND package.job_id = job.roof_job_id
           AND package.status != 'Superseded'
      )
        AND (
          job.tenant_id > ?
          OR (job.tenant_id = ? AND job.roof_job_id > ?)
        )
      ORDER BY job.tenant_id, job.roof_job_id LIMIT ?`,
  )
    .bind(cursor?.last_tenant_id ?? "", cursor?.last_tenant_id ?? "", cursor?.last_roof_job_id ?? "", limit)
    .all<{ tenant_id: string; roof_job_id: string }>();
  const jobs = [...(after.results ?? [])];
  if (cursor && jobs.length < limit) {
    const wrapped = await env.DB.prepare(
      `SELECT job.tenant_id, job.roof_job_id
         FROM operating_roof_jobs job
        WHERE EXISTS (
          SELECT 1 FROM work_packages package
           WHERE package.tenant_id = job.tenant_id AND package.job_id = job.roof_job_id
             AND package.status != 'Superseded'
        )
          AND (
            job.tenant_id < ?
            OR (job.tenant_id = ? AND job.roof_job_id <= ?)
          )
        ORDER BY job.tenant_id, job.roof_job_id LIMIT ?`,
    )
      .bind(cursor.last_tenant_id, cursor.last_tenant_id, cursor.last_roof_job_id, limit - jobs.length)
      .all<{ tenant_id: string; roof_job_id: string }>();
    jobs.push(...(wrapped.results ?? []));
  }
  const counts: NativeFinalInvoiceDerivationCounts = {
    scanned: 0,
    blocked: 0,
    no_balance: 0,
    intents_derived: 0,
    intents_replayed: 0,
  };
  for (const job of jobs) {
    counts.scanned += 1;
    try {
      const result = await deriveNativeFinalInvoiceForJob(
        env,
        {
          tenantId: job.tenant_id,
          roofJobId: job.roof_job_id,
        },
        now,
      );
      if (result.outcome === "blocked") counts.blocked += 1;
      if (result.outcome === "no_balance") counts.no_balance += 1;
      if (result.outcome === "intent_derived") {
        if (result.replayed) counts.intents_replayed += 1;
        else counts.intents_derived += 1;
      }
    } catch {
      counts.blocked += 1;
      await recordBlocked(
        env,
        {
          tenantId: job.tenant_id,
          roofJobId: job.roof_job_id,
        },
        {
          code: "native_final_invoice_derivation_failed",
          nextStep: "inspect_native_derivation_observation",
          facts: { stage: "unexpected_failure" },
        },
        { schema_version: 1 },
        now,
      ).catch(() => {});
    }
  }
  const lastJob = jobs.at(-1);
  if (lastJob) {
    await env.DB.prepare(
      `INSERT INTO native_final_invoice_derivation_cursors (
         cursor_name, last_tenant_id, last_roof_job_id, updated_at
       ) VALUES ('scheduled-v1', ?, ?, ?)
       ON CONFLICT(cursor_name) DO UPDATE SET
         last_tenant_id = excluded.last_tenant_id,
         last_roof_job_id = excluded.last_roof_job_id,
         updated_at = excluded.updated_at`,
    )
      .bind(lastJob.tenant_id, lastJob.roof_job_id, now.toISOString())
      .run();
  }
  return counts;
}

async function readCompletionSnapshot(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
): Promise<Checked<CompletionSnapshot>> {
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
    .bind(input.tenantId, input.roofJobId)
    .all<AssignmentRow>();
  if ((assignments.results ?? []).length !== 1) {
    return blocked("work_package_assignment_ambiguous", "record_current_native_assignment", {
      current_assignment_count: (assignments.results ?? []).length,
      assignment_ids: (assignments.results ?? []).map((row) => row.assignment_id),
    });
  }
  const assignment = assignments.results![0]!;
  const packagesRead = await env.DB.prepare(
    `SELECT work_package_id, tenant_id, version, job_id, assignment_id, work_object_type,
            work_object_id, physical_context_type, physical_context_id, status, definition_json,
            completed_at, updated_at
       FROM work_packages
      WHERE tenant_id = ? AND job_id = ? AND status != 'Superseded'
      ORDER BY work_package_id, version LIMIT ?`,
  )
    .bind(input.tenantId, input.roofJobId, MAX_PACKAGES + 1)
    .all<WorkPackageRow>();
  const packages = packagesRead.results ?? [];
  if (packages.length === 0 || packages.length > MAX_PACKAGES) {
    return blocked("work_package_set_invalid", "complete_bounded_native_work_package_set", {
      package_count: packages.length,
      maximum: MAX_PACKAGES,
    });
  }
  if (packages.some((row) => row.assignment_id !== assignment.assignment_id)) {
    return blocked("work_package_assignment_stale", "supersede_stale_work_packages", {
      current_assignment_id: assignment.assignment_id,
      package_assignments: [...new Set(packages.map((row) => row.assignment_id))].sort(),
    });
  }
  if (packages.some((row) => row.status !== "Completed" || !row.completed_at)) {
    return blocked("work_package_set_incomplete", "complete_and_review_all_work_packages", {
      packages: packages.map((row) => ({
        id: row.work_package_id,
        version: Number(row.version),
        status: row.status,
        completed_at: row.completed_at,
      })),
    });
  }

  const frozen: CompletionSnapshot["packages"] = [];
  for (const packageRow of packages) {
    const definition = parseRecord(packageRow.definition_json);
    const steps = Array.isArray(definition?.steps) ? definition.steps : [];
    const holds = Array.isArray(definition?.hold_points) ? definition.hold_points : [];
    const requiredSlots = [
      ...steps.map((value) => `step:${integerField(value, "sequence")}`),
      ...holds.map((value) => `hold:${integerField(value, "sequence")}`),
    ];
    if (
      requiredSlots.length === 0 ||
      requiredSlots.some((slot) => slot.endsWith(":0")) ||
      new Set(requiredSlots).size !== requiredSlots.length
    ) {
      return blocked("work_package_definition_invalid", "correct_work_package_definition", {
        work_package_id: packageRow.work_package_id,
        version: Number(packageRow.version),
      });
    }
    const eventRead = await env.DB.prepare(
      `SELECT event_id, work_package_id, work_package_version, event_kind, occurred_at,
              payload_json, created_at
         FROM work_package_events
        WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
        ORDER BY occurred_at, event_id LIMIT ?`,
    )
      .bind(input.tenantId, packageRow.work_package_id, packageRow.version, MAX_EVENTS_PER_PACKAGE + 1)
      .all<WorkPackageEventRow>();
    const events = eventRead.results ?? [];
    if (events.length > MAX_EVENTS_PER_PACKAGE) {
      return blocked("work_package_event_set_unbounded", "review_work_package_event_volume", {
        work_package_id: packageRow.work_package_id,
        event_count: events.length,
      });
    }
    const completionEvents = events.filter((event) => event.event_kind === "complete_work");
    if (
      completionEvents.length !== 1 ||
      completionEvents[0]!.occurred_at !== packageRow.completed_at ||
      events.some((event) => event.occurred_at > packageRow.completed_at!)
    ) {
      return blocked("work_package_completion_unstable", "reconcile_work_package_completion", {
        work_package_id: packageRow.work_package_id,
        completed_at: packageRow.completed_at,
        completion_event_count: completionEvents.length,
        latest_event_at: events.at(-1)?.occurred_at ?? null,
      });
    }
    const releasedHolds = new Set(
      events.flatMap((event) => {
        if (event.event_kind !== "hold_released") return [];
        const payload = parseRecord(event.payload_json);
        const sequence = integerField(payload, "hold_point_sequence");
        return sequence > 0 ? [sequence] : [];
      }),
    );
    if (holds.some((hold) => !releasedHolds.has(integerField(hold, "sequence")))) {
      return blocked("work_package_hold_unreleased", "release_all_work_package_holds", {
        work_package_id: packageRow.work_package_id,
      });
    }
    const reviewDisposition = new Map<string, string>();
    for (const event of events) {
      if (event.event_kind !== "evidence_reviewed") continue;
      const payload = parseRecord(event.payload_json);
      const target = textField(payload, "target_event_id");
      const disposition = textField(payload, "disposition");
      if (target && disposition) reviewDisposition.set(target, disposition);
    }
    const evidenceRead = await env.DB.prepare(
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
        input.tenantId,
        input.roofJobId,
        assignment.assignment_id,
        packageRow.work_package_id,
        packageRow.version,
        MAX_EVIDENCE_PER_PACKAGE + 1,
      )
      .all<EvidenceRow>();
    const evidence = evidenceRead.results ?? [];
    if (evidence.length > MAX_EVIDENCE_PER_PACKAGE) {
      return blocked("work_package_evidence_set_unbounded", "review_work_package_evidence_volume", {
        work_package_id: packageRow.work_package_id,
        evidence_count: evidence.length,
      });
    }
    if (
      evidence.some(
        (row) =>
          row.created_at > packageRow.completed_at! ||
          (row.capture_completed_at !== null && row.capture_completed_at > packageRow.completed_at!) ||
          row.r2_stored_at > packageRow.completed_at!,
      )
    ) {
      return blocked("work_package_evidence_changed_after_completion", "recomplete_work_package", {
        work_package_id: packageRow.work_package_id,
      });
    }
    const superseded = new Set(
      evidence.map((row) => row.evidence_correction_of).filter((value): value is string => !!value),
    );
    const current = new Map<string, EvidenceRow | null>();
    for (const capture of evidence) {
      const eventId = evidenceEventId(capture.evidence_id);
      if (superseded.has(eventId)) continue;
      if (current.has(capture.evidence_slot_id)) {
        current.set(capture.evidence_slot_id, null);
      } else {
        current.set(capture.evidence_slot_id, capture);
      }
    }
    const invalidSlot = requiredSlots.find((slot) => {
      const capture = current.get(slot);
      return (
        !capture ||
        capture.evidence_verification !== "Verified" ||
        capture.evidence_disposition !== "Open" ||
        capture.evidence_freshness !== "Current" ||
        !["None", "Resolved"].includes(capture.evidence_conflict_state) ||
        reviewDisposition.get(evidenceEventId(capture.evidence_id)) !== "Accepted"
      );
    });
    if (invalidSlot) {
      return blocked("work_package_evidence_not_accepted", "complete_independent_evidence_review", {
        work_package_id: packageRow.work_package_id,
        evidence_slot_id: invalidSlot,
      });
    }
    frozen.push({
      work_package_id: packageRow.work_package_id,
      version: Number(packageRow.version),
      assignment_id: packageRow.assignment_id,
      completed_at: packageRow.completed_at!,
      definition_sha256: await sha256Hex(packageRow.definition_json),
      events_sha256: await sha256Hex(canonicalJson(events)),
      evidence_sha256: await sha256Hex(canonicalJson(evidence)),
    });
  }
  const completedAt = frozen
    .map((row) => row.completed_at)
    .sort()
    .at(-1)!;
  return {
    value: {
      assignment,
      packages: frozen,
      completedAt,
      sha256: await sha256Hex(canonicalJson(frozen)),
    },
  };
}

async function readCommercialHead(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
  customerId: string,
): Promise<Checked<CommercialHead>> {
  const acceptanceRead = await env.DB.prepare(
    `SELECT * FROM commercial_acceptance_bindings
      WHERE tenant_id = ? AND roof_job_id = ?
      ORDER BY accepted_at DESC, acceptance_binding_id DESC LIMIT 2`,
  )
    .bind(input.tenantId, input.roofJobId)
    .all<AcceptanceRow>();
  const acceptances = acceptanceRead.results ?? [];
  if (
    acceptances.length === 0 ||
    (acceptances.length > 1 && acceptances[0]!.accepted_at === acceptances[1]!.accepted_at)
  ) {
    return blocked("commercial_acceptance_ambiguous", "record_one_current_customer_acceptance", {
      acceptance_count: acceptances.length,
      acceptance_ids: acceptances.map((row) => row.acceptance_binding_id),
    });
  }
  const acceptance = acceptances[0]!;
  const quote = await env.DB.prepare(
    `SELECT * FROM commercial_quote_revisions
      WHERE tenant_id = ? AND quote_revision_id = ?`,
  )
    .bind(input.tenantId, acceptance.quote_revision_id)
    .first<QuoteRow>();
  const proposal = await env.DB.prepare(
    `SELECT * FROM commercial_proposal_revisions
      WHERE tenant_id = ? AND proposal_revision_id = ?`,
  )
    .bind(input.tenantId, acceptance.proposal_revision_id)
    .first<ProposalRow>();
  if (!quote || !proposal) {
    return blocked("commercial_acceptance_chain_missing", "repair_native_commercial_chain", {
      acceptance_binding_id: acceptance.acceptance_binding_id,
      quote_found: !!quote,
      proposal_found: !!proposal,
    });
  }
  const currentQuote = await env.DB.prepare(
    `SELECT quote_revision_id FROM commercial_quote_revisions
      WHERE tenant_id = ? AND customer_quote_id = ?
      ORDER BY revision_number DESC LIMIT 1`,
  )
    .bind(input.tenantId, quote.customer_quote_id)
    .first<{ quote_revision_id: string }>();
  const currentProposal = await env.DB.prepare(
    `SELECT proposal_revision_id FROM commercial_proposal_revisions
      WHERE tenant_id = ? AND proposal_pack_id = ?
      ORDER BY revision_number DESC LIMIT 1`,
  )
    .bind(input.tenantId, proposal.proposal_pack_id)
    .first<{ proposal_revision_id: string }>();
  const publication = await env.DB.prepare(
    `SELECT * FROM commercial_proposal_publication_events
      WHERE tenant_id = ? AND proposal_pack_id = ?
      ORDER BY publication_version DESC LIMIT 1`,
  )
    .bind(input.tenantId, proposal.proposal_pack_id)
    .first<PublicationRow>();
  if (
    quote.status !== "approved" ||
    quote.currency !== "CAD" ||
    quote.roof_job_id !== input.roofJobId ||
    quote.customer_id !== customerId ||
    proposal.quote_revision_id !== quote.quote_revision_id ||
    proposal.roof_job_id !== input.roofJobId ||
    proposal.customer_id !== customerId ||
    proposal.terms_hash !== quote.terms_hash ||
    acceptance.customer_id !== customerId ||
    acceptance.terms_hash !== quote.terms_hash ||
    currentQuote?.quote_revision_id !== quote.quote_revision_id ||
    currentProposal?.proposal_revision_id !== proposal.proposal_revision_id ||
    !publication ||
    publication.state !== "published" ||
    publication.proposal_revision_id !== proposal.proposal_revision_id ||
    publication.occurred_at > acceptance.accepted_at
  ) {
    return blocked("commercial_head_changed", "accept_and_publish_current_commercial_head", {
      acceptance_binding_id: acceptance.acceptance_binding_id,
      accepted_quote_revision_id: quote.quote_revision_id,
      current_quote_revision_id: currentQuote?.quote_revision_id ?? null,
      accepted_proposal_revision_id: proposal.proposal_revision_id,
      current_proposal_revision_id: currentProposal?.proposal_revision_id ?? null,
      current_publication_id: publication?.publication_event_id ?? null,
      current_publication_state: publication?.state ?? null,
    });
  }
  const lineRead = await env.DB.prepare(
    `SELECT * FROM commercial_quote_lines WHERE quote_revision_id = ?
      ORDER BY sequence, line_id LIMIT 101`,
  )
    .bind(quote.quote_revision_id)
    .all<QuoteLineRow>();
  const lines = lineRead.results ?? [];
  if (
    lines.length === 0 ||
    lines.length > 100 ||
    lines.reduce((sum, row) => sum + Number(row.subtotal_cents), 0) !== Number(quote.subtotal_cents) ||
    lines.reduce((sum, row) => sum + Number(row.tax_cents), 0) !== Number(quote.tax_cents) ||
    Number(quote.subtotal_cents) + Number(quote.tax_cents) !== Number(quote.total_cents)
  ) {
    return blocked("commercial_quote_amounts_invalid", "correct_current_commercial_quote", {
      quote_revision_id: quote.quote_revision_id,
      line_count: lines.length,
    });
  }
  const quoteSha256 = await sha256Hex(canonicalJson({ quote, lines }));
  const proposalSha256 = await sha256Hex(canonicalJson(proposal));
  const publicationSha256 = await sha256Hex(canonicalJson(publication));
  const acceptanceSha256 = await sha256Hex(canonicalJson(acceptance));
  return {
    value: {
      quote,
      lines,
      proposal,
      publication,
      acceptance,
      quoteSha256,
      proposalSha256,
      publicationSha256,
      acceptanceSha256,
      sha256: await sha256Hex(
        canonicalJson({
          quote_sha256: quoteSha256,
          proposal_sha256: proposalSha256,
          publication_sha256: publicationSha256,
          acceptance_sha256: acceptanceSha256,
        }),
      ),
    },
  };
}

export async function readAcceptedCommercialPaymentTerms(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string; customerId: string },
): Promise<
  | { ok: true; paymentTermsDays: number; termsHash: string; commercialHeadSha256: string }
  | { ok: false; code: string }
> {
  const head = await readCommercialHead(
    env,
    { tenantId: input.tenantId, roofJobId: input.roofJobId },
    input.customerId,
  );
  if (head.blocked) return { ok: false, code: head.blocked.code };
  let terms: unknown;
  try {
    terms = JSON.parse(head.value.quote.terms_json);
  } catch {
    return { ok: false, code: "commercial_payment_terms_invalid" };
  }
  const paymentTermsDays = commercialPaymentTermsDays(terms);
  return paymentTermsDays === null
    ? { ok: false, code: "commercial_payment_terms_invalid" }
    : {
        ok: true,
        paymentTermsDays,
        termsHash: head.value.quote.terms_hash,
        commercialHeadSha256: head.value.sha256,
      };
}

async function readPriorInvoices(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
): Promise<Checked<PriorInvoiceRead>> {
  const read = await env.DB.prepare(
    `SELECT * FROM accounting_intents
      WHERE tenant_id = ? AND roof_job_id = ?
        AND kind IN ('deposit_invoice','progress_invoice')
        AND (final_invoice_intent_id IS NULL OR final_invoice_intent_id != intent_id)
      ORDER BY derived_at, intent_id LIMIT ?`,
  )
    .bind(input.tenantId, input.roofJobId, MAX_PRIOR_INTENTS + 1)
    .all<AccountingIntentRecord>();
  const rows = read.results ?? [];
  if (rows.length > MAX_PRIOR_INTENTS) {
    return blocked("prior_invoice_set_unbounded", "reconcile_prior_invoice_inventory", {
      invoice_count: rows.length,
      maximum: MAX_PRIOR_INTENTS,
    });
  }
  const unresolved = rows.filter(
    (row) => row.state !== "rejected" && !["reconciled", "partially_settled"].includes(row.state),
  );
  if (unresolved.length > 0) {
    return blocked("prior_invoice_truth_unresolved", "reconcile_or_reject_prior_invoices", {
      intents: unresolved.map((row) => ({
        intent_id: row.intent_id,
        state: row.state,
      })),
    });
  }
  const invoices: PriorInvoice[] = [];
  const providerFacts: ProviderFacts[] = [];
  for (const row of rows.filter((candidate) => ["reconciled", "partially_settled"].includes(candidate.state))) {
    if (
      !row.provider_entity_id ||
      !QBO_ID.test(row.provider_entity_id) ||
      row.provider_entity_type !== "Invoice" ||
      row.provider !== "quickbooks" ||
      row.currency !== "CAD" ||
      !row.observed_sha256 ||
      row.observed_sha256 !== row.expected_sha256 ||
      row.subtotal.startsWith("-") ||
      row.tax_amount.startsWith("-") ||
      row.total_amount.startsWith("-") ||
      parseMoney(row.subtotal) + parseMoney(row.tax_amount) !== parseMoney(row.total_amount)
    ) {
      return blocked("prior_invoice_evidence_invalid", "reconcile_prior_invoice_evidence", {
        intent_id: row.intent_id,
        state: row.state,
      });
    }
    const observation = await env.DB.prepare(
      `SELECT observation.observation_id, observation.observation_seq,
              observation.total_amount_cents, reconciliation.verdict,
              reconciliation.observed_sha256
         FROM accounting_observations observation
         JOIN accounting_reconciliations reconciliation
           ON reconciliation.observation_id = observation.observation_id
          AND reconciliation.tenant_id = observation.tenant_id
        WHERE observation.tenant_id = ? AND reconciliation.intent_id = ?
        ORDER BY observation.observation_seq DESC LIMIT 1`,
    )
      .bind(input.tenantId, row.intent_id)
      .first<{
        observation_id: string;
        observation_seq: number;
        total_amount_cents: number | null;
        verdict: string;
        observed_sha256: string | null;
      }>();
    const currentObservation = await env.DB.prepare(
      `SELECT observation_id FROM accounting_observations
        WHERE tenant_id = ? AND realm_id = ? AND entity_type = 'Invoice' AND entity_id = ?
        ORDER BY observation_seq DESC LIMIT 1`,
    )
      .bind(input.tenantId, row.realm_id, row.provider_entity_id)
      .first<{ observation_id: string }>();
    if (
      !observation ||
      currentObservation?.observation_id !== observation.observation_id ||
      observation.total_amount_cents !== parseMoney(row.total_amount) ||
      observation.observed_sha256 !== row.expected_sha256 ||
      observation.verdict !== row.state
    ) {
      return blocked("prior_invoice_readback_not_current", "reobserve_prior_provider_invoice", {
        intent_id: row.intent_id,
        state: row.state,
        observation_id: observation?.observation_id ?? null,
        current_observation_id: currentObservation?.observation_id ?? null,
      });
    }
    const taxRows = await env.DB.prepare(
      `SELECT snapshot.* FROM accounting_intent_tax_bindings binding
        JOIN tax_policy_snapshots snapshot
          ON snapshot.tenant_id = binding.tenant_id
         AND snapshot.snapshot_id = binding.snapshot_id
        WHERE binding.tenant_id = ? AND binding.intent_id = ?
        ORDER BY binding.tax_code LIMIT 2`,
    )
      .bind(input.tenantId, row.intent_id)
      .all<TaxPolicySnapshotRecord>();
    if ((taxRows.results ?? []).length !== 1) {
      return blocked("prior_invoice_tax_evidence_ambiguous", "reconcile_prior_invoice_tax_binding", {
        intent_id: row.intent_id,
        binding_count: (taxRows.results ?? []).length,
      });
    }
    const provider = providerFactsFromIntent(row, taxRows.results![0]!);
    if (!provider) {
      return blocked("prior_invoice_provider_evidence_invalid", "reconcile_prior_provider_mapping", {
        intent_id: row.intent_id,
      });
    }
    providerFacts.push(provider);
    invoices.push({
      intent_id: row.intent_id,
      version: Number(row.version),
      kind: row.kind as PriorInvoice["kind"],
      basis_sha256: row.basis_sha256,
      subtotal: row.subtotal,
      tax_amount: row.tax_amount,
      total_amount: row.total_amount,
      provider_entity_id: row.provider_entity_id,
      observed_sha256: row.observed_sha256,
    });
  }
  invoices.sort((left, right) => left.intent_id.localeCompare(right.intent_id));
  return {
    value: {
      invoices,
      providerFacts,
      sourceSha256: await sha256Hex(canonicalJson(invoices)),
      subtotalCents: invoices.reduce((sum, row) => sum + parseMoney(row.subtotal), 0),
      taxCents: invoices.reduce((sum, row) => sum + parseMoney(row.tax_amount), 0),
      totalCents: invoices.reduce((sum, row) => sum + parseMoney(row.total_amount), 0),
    },
  };
}

async function resolveProviderBinding(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
  commercial: CommercialHead,
  prior: PriorInvoiceRead,
  now: Date,
): Promise<Checked<NativeFinalInvoiceProviderBindingRecord>> {
  const allHeads = await env.DB.prepare(
    `SELECT current.* FROM native_final_invoice_provider_bindings current
      WHERE current.tenant_id = ? AND current.roof_job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM native_final_invoice_provider_bindings successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_binding_id = current.provider_binding_id
        )
      ORDER BY current.binding_version DESC LIMIT 2`,
  )
    .bind(input.tenantId, input.roofJobId)
    .all<NativeFinalInvoiceProviderBindingRecord>();
  const heads = allHeads.results ?? [];
  if (heads.length > 1) {
    return blocked("provider_mapping_ambiguous", "correct_native_provider_mapping", {
      binding_ids: heads.map((row) => row.provider_binding_id),
    });
  }
  if (heads[0]) {
    if (
      heads[0].commercial_terms_hash === null ||
      heads[0].commercial_head_sha256 === null
    ) {
      return blocked("provider_mapping_commercial_anchor_missing", "reverify_native_provider_mapping", {
        provider_binding_id: heads[0].provider_binding_id,
        mapped_terms_hash: heads[0].commercial_terms_hash,
        mapped_commercial_head_sha256: heads[0].commercial_head_sha256,
      });
    }
    if (
      heads[0].commercial_terms_hash !== commercial.quote.terms_hash ||
      heads[0].commercial_head_sha256 !== commercial.sha256
    ) {
      return blocked("provider_mapping_commercial_head_changed", "reverify_native_provider_mapping", {
        provider_binding_id: heads[0].provider_binding_id,
        mapped_terms_hash: heads[0].commercial_terms_hash,
        current_terms_hash: commercial.quote.terms_hash,
        mapped_commercial_head_sha256: heads[0].commercial_head_sha256,
        current_commercial_head_sha256: commercial.sha256,
      });
    }
    if (
      prior.providerFacts.some(
        (facts) => facts.realmId !== heads[0]!.realm_id || facts.customerId !== heads[0]!.qbo_customer_id,
      )
    ) {
      return blocked("provider_mapping_conflicts_with_readback", "correct_native_provider_mapping", {
        provider_binding_id: heads[0].provider_binding_id,
        prior_realms: [...new Set(prior.providerFacts.map((facts) => facts.realmId))],
        prior_customers: [...new Set(prior.providerFacts.map((facts) => facts.customerId))],
      });
    }
    return { value: heads[0] };
  }
  if (prior.providerFacts.length === 0) {
    return blocked("provider_mapping_missing", "record_native_provider_mapping", {
      exact_prior_provider_evidence_count: 0,
    });
  }
  const first = prior.providerFacts[0]!;
  if (prior.providerFacts.some((facts) => canonicalJson(facts) !== canonicalJson(first))) {
    return blocked("provider_evidence_ambiguous", "record_native_provider_mapping", {
      exact_prior_provider_evidence_count: prior.providerFacts.length,
      provider_evidence_sha256: await sha256Hex(canonicalJson(prior.providerFacts)),
    });
  }
  const sourceSha256 = await sha256Hex(
    canonicalJson({
      prior_invoices_sha256: prior.sourceSha256,
      provider_facts: first,
    }),
  );
  return {
    value: await recordNativeFinalInvoiceProviderBinding(
      env,
      {
        tenantId: input.tenantId,
        realmId: first.realmId,
        roofJobId: input.roofJobId,
        qboCustomerId: first.customerId,
        qboItemId: first.itemId,
        qboTaxCodeId: first.taxCodeId,
        qboTermsId: first.termsId,
        jurisdiction: first.jurisdiction,
        taxCode: first.taxCode,
        paymentTermsDays: first.paymentTermsDays,
        sourceRef: `native-accounting-evidence:${sourceSha256.slice(0, 48)}`,
        sourceSha256,
        commercialTermsHash: commercial.quote.terms_hash,
        commercialHeadSha256: commercial.sha256,
      },
      now,
    ),
  };
}

function validateMoneyTruth(
  commercial: CommercialHead,
  prior: PriorInvoiceRead,
  provider: NativeFinalInvoiceProviderBindingRecord,
  tax: TaxPolicySnapshotRecord,
): Checked<{ subtotalCents: number; taxCents: number; totalCents: number }> {
  if (commercial.lines.some((line) => line.tax_code !== provider.tax_code)) {
    return blocked("commercial_tax_code_ambiguous", "correct_commercial_tax_mapping", {
      quote_revision_id: commercial.quote.quote_revision_id,
      quote_tax_codes: [...new Set(commercial.lines.map((line) => line.tax_code))],
      provider_tax_code: provider.tax_code,
    });
  }
  const acceptedSubtotal = Number(commercial.quote.subtotal_cents);
  const acceptedTax = Number(commercial.quote.tax_cents);
  const acceptedTotal = Number(commercial.quote.total_cents);
  if (
    ![acceptedSubtotal, acceptedTax, acceptedTotal].every(Number.isSafeInteger) ||
    prior.subtotalCents > acceptedSubtotal ||
    prior.taxCents > acceptedTax ||
    prior.totalCents > acceptedTotal
  ) {
    return blocked("prior_invoice_total_exceeds_contract", "reconcile_commercial_and_invoice_totals", {
      accepted: {
        subtotal: acceptedSubtotal,
        tax: acceptedTax,
        total: acceptedTotal,
      },
      prior: {
        subtotal: prior.subtotalCents,
        tax: prior.taxCents,
        total: prior.totalCents,
      },
    });
  }
  const subtotalCents = acceptedSubtotal - prior.subtotalCents;
  const taxCents = acceptedTax - prior.taxCents;
  const totalCents = acceptedTotal - prior.totalCents;
  if (subtotalCents + taxCents !== totalCents) {
    return blocked("final_invoice_balance_inconsistent", "reconcile_prior_invoice_components", {
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      total_cents: totalCents,
    });
  }
  const expectedTax = taxForSubtotal(subtotalCents, tax.rate_percent);
  if (expectedTax === null || expectedTax !== taxCents) {
    return blocked("final_invoice_tax_amount_ambiguous", "review_final_invoice_tax_balance", {
      subtotal_cents: subtotalCents,
      recorded_tax_cents: taxCents,
      current_rate_percent: tax.rate_percent,
      calculated_tax_cents: expectedTax,
    });
  }
  return { value: { subtotalCents, taxCents, totalCents } };
}

async function ensureCompletionPacket(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
  completion: CompletionSnapshot,
  commercial: CommercialHead,
  now: Date,
): Promise<CompletionPacketRecord> {
  const packetBody = {
    schema_version: 1,
    tenant_id: input.tenantId,
    roof_job_id: input.roofJobId,
    work_package_set_sha256: completion.sha256,
    commercial_head_sha256: commercial.sha256,
    current_assignment: completion.assignment,
    work_packages: completion.packages,
    commercial_head: {
      quote_revision_id: commercial.quote.quote_revision_id,
      quote_sha256: commercial.quoteSha256,
      proposal_revision_id: commercial.proposal.proposal_revision_id,
      proposal_sha256: commercial.proposalSha256,
      publication_event_id: commercial.publication.publication_event_id,
      publication_sha256: commercial.publicationSha256,
      acceptance_binding_id: commercial.acceptance.acceptance_binding_id,
      acceptance_sha256: commercial.acceptanceSha256,
    },
  };
  const packetJson = canonicalJson(packetBody);
  const packetSha256 = await sha256Hex(packetJson);
  const existing = await env.DB.prepare(
    `SELECT * FROM native_completion_packets
      WHERE tenant_id = ? AND roof_job_id = ? AND packet_sha256 = ?`,
  )
    .bind(input.tenantId, input.roofJobId, packetSha256)
    .first<CompletionPacketRecord>();
  if (existing) return existing;
  const highest = await env.DB.prepare(
    `SELECT MAX(packet_version) AS version FROM native_completion_packets
      WHERE tenant_id = ? AND roof_job_id = ?`,
  )
    .bind(input.tenantId, input.roofJobId)
    .first<{ version: number | null }>();
  const version = Number(highest?.version ?? 0) + 1;
  const packetId = `ncp_${packetSha256}`;
  try {
    await env.DB.prepare(
      `INSERT INTO native_completion_packets (
         completion_packet_id, tenant_id, roof_job_id, packet_version,
         work_package_set_sha256, commercial_head_sha256, packet_json, packet_sha256,
         completed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        packetId,
        input.tenantId,
        input.roofJobId,
        version,
        completion.sha256,
        commercial.sha256,
        packetJson,
        packetSha256,
        completion.completedAt,
        now.toISOString(),
      )
      .run();
  } catch (error) {
    const raced = await env.DB.prepare(
      `SELECT * FROM native_completion_packets
        WHERE tenant_id = ? AND roof_job_id = ? AND packet_sha256 = ?`,
    )
      .bind(input.tenantId, input.roofJobId, packetSha256)
      .first<CompletionPacketRecord>();
    if (!raced) throw error;
    return raced;
  }
  const stored = await env.DB.prepare(
    `SELECT * FROM native_completion_packets
      WHERE tenant_id = ? AND completion_packet_id = ?`,
  )
    .bind(input.tenantId, packetId)
    .first<CompletionPacketRecord>();
  if (!stored) throw new Error("native_completion_packet_write_failed");
  return stored;
}

async function recordBlocked(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
  blocker: BlockedRead,
  baseFacts: unknown,
  now: Date,
): Promise<NativeFinalInvoiceDerivationResult> {
  const observation = await recordObservation(
    env,
    input,
    {
      outcome: "blocked",
      completionPacketId: null,
      accountingIntentId: null,
      basisSha256: null,
      blocker,
      facts: { base: baseFacts, blocker: blocker.facts },
    },
    now,
  );
  return {
    outcome: "blocked",
    roof_job_id: input.roofJobId,
    observation_id: observation,
    blocker_code: blocker.code,
    blocker_next_step: blocker.nextStep,
  };
}

async function recordObservation(
  env: AppEnv,
  input: { tenantId: string; roofJobId: string },
  record: {
    outcome: "blocked" | "intent_derived" | "no_balance";
    completionPacketId: string | null;
    accountingIntentId: string | null;
    basisSha256: string | null;
    blocker: BlockedRead | null;
    facts: unknown;
  },
  now: Date,
): Promise<string> {
  const details = {
    schema_version: 1,
    outcome: record.outcome,
    blocker_code: record.blocker?.code ?? null,
    blocker_next_step: record.blocker?.nextStep ?? null,
    facts: record.facts,
  };
  const detailsJson = canonicalJson(details);
  const inputSha256 = await sha256Hex(detailsJson);
  const existing = await env.DB.prepare(
    `SELECT derivation_observation_id FROM native_final_invoice_derivation_observations
      WHERE tenant_id = ? AND roof_job_id = ? AND input_sha256 = ?`,
  )
    .bind(input.tenantId, input.roofJobId, inputSha256)
    .first<{ derivation_observation_id: string }>();
  if (existing) return existing.derivation_observation_id;
  const observationId = `nfid_${inputSha256}`;
  try {
    await env.DB.prepare(
      `INSERT INTO native_final_invoice_derivation_observations (
         derivation_observation_id, tenant_id, roof_job_id, input_sha256, outcome,
         blocker_code, blocker_next_step, completion_packet_id, accounting_intent_id,
         basis_sha256, details_json, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        observationId,
        input.tenantId,
        input.roofJobId,
        inputSha256,
        record.outcome,
        record.blocker?.code ?? null,
        record.blocker?.nextStep ?? null,
        record.completionPacketId,
        record.accountingIntentId,
        record.basisSha256,
        detailsJson,
        now.toISOString(),
      )
      .run();
  } catch (error) {
    const raced = await env.DB.prepare(
      `SELECT derivation_observation_id FROM native_final_invoice_derivation_observations
        WHERE tenant_id = ? AND roof_job_id = ? AND input_sha256 = ?`,
    )
      .bind(input.tenantId, input.roofJobId, inputSha256)
      .first<{ derivation_observation_id: string }>();
    if (!raced) throw error;
    return raced.derivation_observation_id;
  }
  return observationId;
}

export type NativeInitialProviderMapping =
  | { status: "found"; value: NativeFinalInvoiceProviderBindingRecord }
  | { status: "missing" }
  | { status: "ambiguous"; bindingIds: string[] }
  | { status: "unavailable" };

/**
 * First-invoice / deposit derivation reads the native provider mapping rather than trusting
 * typed-in QuickBooks IDs. A missing table is the money-desk unit-test harness, not production.
 */
export async function readNativeInitialProviderMapping(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<NativeInitialProviderMapping> {
  if (!env.DB) return { status: "unavailable" };
  try {
    const heads = await currentProviderBindingHeads(env, tenantId, roofJobId);
    if (heads.length > 1) {
      return {
        status: "ambiguous",
        bindingIds: heads.map((row) => row.provider_binding_id),
      };
    }
    if (!heads[0]) return { status: "missing" };
    return { status: "found", value: heads[0] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (/no such table: native_final_invoice_provider_bindings/i.test(message)) {
      return { status: "unavailable" };
    }
    throw error;
  }
}

async function currentProviderBindingHeads(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<NativeFinalInvoiceProviderBindingRecord[]> {
  const read = await env.DB.prepare(
    `SELECT current.* FROM native_final_invoice_provider_bindings current
      WHERE current.tenant_id = ? AND current.roof_job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM native_final_invoice_provider_bindings successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_binding_id = current.provider_binding_id
        )
      ORDER BY current.binding_version DESC LIMIT 2`,
  )
    .bind(tenantId, roofJobId)
    .all<NativeFinalInvoiceProviderBindingRecord>();
  return read.results ?? [];
}

function providerFactsFromIntent(row: AccountingIntentRecord, snapshot: TaxPolicySnapshotRecord): ProviderFacts | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.provider_payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const customerId = nestedValue(payload.CustomerRef);
  const termsId = nestedValue(payload.SalesTermRef);
  const currency =
    isRecord(payload.CurrencyRef) && typeof payload.CurrencyRef.value === "string" ? payload.CurrencyRef.value : "";
  const transactionDate = typeof payload.TxnDate === "string" ? payload.TxnDate : "";
  const dueDate = typeof payload.DueDate === "string" ? payload.DueDate : "";
  const lines = Array.isArray(payload.Line) ? payload.Line : [];
  const itemIds = new Set<string>();
  const taxCodeIds = new Set<string>();
  for (const value of lines) {
    const line = isRecord(value) ? value : null;
    if (line?.DetailType !== "SalesItemLineDetail") continue;
    const detail = isRecord(line.SalesItemLineDetail) ? line.SalesItemLineDetail : null;
    const itemId = nestedValue(detail?.ItemRef);
    const taxCodeId = nestedValue(detail?.TaxCodeRef);
    if (itemId) itemIds.add(itemId);
    if (taxCodeId) taxCodeIds.add(taxCodeId);
  }
  const paymentTermsDays = daysBetween(transactionDate, dueDate);
  if (
    !QBO_ID.test(row.realm_id) ||
    row.currency !== "CAD" ||
    currency !== "CAD" ||
    !customerId ||
    !termsId ||
    itemIds.size !== 1 ||
    taxCodeIds.size !== 1 ||
    paymentTermsDays === null ||
    !snapshot.provider_tax_code_id ||
    [...taxCodeIds][0] !== snapshot.provider_tax_code_id
  ) {
    return null;
  }
  return {
    realmId: row.realm_id,
    customerId,
    itemId: [...itemIds][0]!,
    taxCodeId: [...taxCodeIds][0]!,
    termsId,
    paymentTermsDays,
    jurisdiction: snapshot.jurisdiction,
    taxCode: snapshot.tax_code,
  };
}

function bindingFacts(record: NativeFinalInvoiceProviderBindingRecord): Record<string, unknown> {
  return {
    realm_id: record.realm_id,
    qbo_customer_id: record.qbo_customer_id,
    qbo_item_id: record.qbo_item_id,
    qbo_tax_code_id: record.qbo_tax_code_id,
    qbo_terms_id: record.qbo_terms_id,
    jurisdiction: record.jurisdiction,
    tax_code: record.tax_code,
    payment_terms_days: Number(record.payment_terms_days),
    source_ref: record.source_ref,
    source_sha256: record.source_sha256,
    commercial_terms_hash: record.commercial_terms_hash,
    commercial_head_sha256: record.commercial_head_sha256,
  };
}

function blocked<T>(code: string, nextStep: string, facts: unknown): Checked<T> {
  return { blocked: { code, nextStep, facts } };
}

function citation(doctype: string, name: string, sha256: string): NativeFinalInvoiceBasisV2["evidence"][number] {
  return { source: "IronWrap", doctype, name, sha256 };
}

function document(id: string, version: number, sha256: string) {
  return { id, version, sha256 };
}

function parseMoney(value: string): number {
  if (!/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/.test(value)) return Number.NaN;
  const cents = Number(value.replace(".", ""));
  return Number.isSafeInteger(cents) ? cents : Number.NaN;
}

function money(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("native_invoice_money_invalid");
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function taxForSubtotal(subtotalCents: number, ratePercent: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,2})\.[0-9]{4}$/.test(ratePercent)) return null;
  const units = BigInt(ratePercent.replace(".", ""));
  const numerator = BigInt(subtotalCents) * units;
  return Number((numerator + 500_000n) / 1_000_000n);
}

function addUtcDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) throw new Error("native_invoice_date_invalid");
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const days = (endMs - startMs) / 86_400_000;
  return Number.isInteger(days) && days <= 365 ? days : null;
}

function evidenceEventId(evidenceId: string): string {
  return /^evi_[0-9a-f]{32}$/.test(evidenceId)
    ? `wpe_${evidenceId.slice(4)}`
    : `wpe_${evidenceId.replace(/[^A-Za-z0-9._:-]/g, "_")}`;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integerField(value: unknown, key: string): number {
  if (!isRecord(value) || !Number.isInteger(value[key])) return 0;
  return Number(value[key]);
}

function textField(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

function nestedValue(value: unknown): string | null {
  return isRecord(value) && typeof value.value === "string" && QBO_ID.test(value.value) ? value.value : null;
}
