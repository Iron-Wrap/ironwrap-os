import type { AppEnv } from "./app-types.ts";
import {
  commercialCommandFingerprint,
  type CommercialAuthorityBinding,
  type CommercialEvidenceRef,
  resolveCommercialAuthority,
} from "./commercial-authority.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export type CommercialLeadStatus = "triaged" | "qualified" | "disqualified";
export type CommercialPriority = "low" | "normal" | "high" | "urgent";
export type CommercialQuoteStatus = "draft" | "needs_review" | "approved" | "rejected" | "expired";
export type CommercialQuoteLineKind =
  | "material"
  | "labour"
  | "equipment"
  | "subcontract"
  | "allowance"
  | "discount"
  | "other";
export type CommercialPublicationState = "draft" | "published" | "withdrawn";

export interface RecordLeadTriageInput {
  tenantId: string;
  leadId: string;
  expectedLeadVersion: number;
  lifecycleStatus: CommercialLeadStatus;
  priority: CommercialPriority;
  category: string;
  summary: string;
  nextAction: string;
  authority: CommercialAuthorityBinding;
  idempotencyKey: string;
}

export interface CommercialLeadTriageRecord {
  triage_decision_id: string;
  tenant_id: string;
  lead_id: string;
  lead_version: number;
  lifecycle_status: CommercialLeadStatus;
  priority: CommercialPriority;
  category: string;
  summary: string;
  next_action: string;
  policy_permit_id: string | null;
  lead_triage_approval_id: string | null;
  authority_evidence_digest: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  decided_at: string;
}

export interface CommercialQuoteLineInput {
  lineId: string;
  sequence: number;
  kind: CommercialQuoteLineKind;
  description: string;
  quantityMicros: number;
  uom: string;
  unitPriceCents: number;
  taxCode?: string | null;
  taxCents: number;
}

export interface RecordCommercialQuoteInput {
  tenantId: string;
  quoteRevisionId: string;
  customerQuoteId: string;
  revisionNumber: number;
  roofJobId: string;
  customerId: string;
  supersedesQuoteRevisionId?: string | null;
  status: CommercialQuoteStatus;
  currency: string;
  validUntil: string;
  terms: unknown;
  evidence: readonly CommercialEvidenceRef[];
  correctionReason?: string | null;
  lines: readonly CommercialQuoteLineInput[];
  authority: CommercialAuthorityBinding;
  idempotencyKey: string;
}

export interface CommercialQuoteLineRecord {
  quote_revision_id: string;
  tenant_id: string;
  line_id: string;
  sequence: number;
  kind: CommercialQuoteLineKind;
  description: string;
  quantity_micros: number;
  uom: string;
  unit_price_cents: number;
  subtotal_cents: number;
  tax_code: string | null;
  tax_cents: number;
  total_cents: number;
}

export interface CommercialQuoteRecord {
  quote_revision_id: string;
  tenant_id: string;
  customer_quote_id: string;
  revision_number: number;
  roof_job_id: string;
  customer_id: string;
  supersedes_quote_revision_id: string | null;
  status: CommercialQuoteStatus;
  currency: string;
  valid_until: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  terms_json: string;
  terms_hash: string;
  evidence_refs_json: string;
  evidence_digest: string;
  correction_reason: string | null;
  policy_permit_id: string | null;
  quote_revision_approval_id: string | null;
  authority_evidence_digest: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

export interface PreparedCommercialQuote {
  command: Readonly<Record<string, unknown>>;
  lines: CommercialQuoteLineRecord[];
  termsJson: string;
  termsHash: string;
  evidenceRefsJson: string;
  evidenceDigest: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export interface RecordCommercialProposalInput {
  tenantId: string;
  proposalRevisionId: string;
  proposalPackId: string;
  revisionNumber: number;
  quoteRevisionId: string;
  roofJobId: string;
  customerId: string;
  supersedesProposalRevisionId?: string | null;
  title: string;
  summary: string;
  terms: unknown;
  contentRef: string;
  contentHash: string;
  evidence: readonly CommercialEvidenceRef[];
  authority: Extract<CommercialAuthorityBinding, { kind: "policy_permit" }>;
  idempotencyKey: string;
}

export interface CommercialProposalRecord {
  proposal_revision_id: string;
  tenant_id: string;
  proposal_pack_id: string;
  revision_number: number;
  quote_revision_id: string;
  roof_job_id: string;
  customer_id: string;
  supersedes_proposal_revision_id: string | null;
  title: string;
  summary: string;
  terms_json: string;
  terms_hash: string;
  content_ref: string;
  content_hash: string;
  evidence_refs_json: string;
  evidence_digest: string;
  policy_permit_id: string;
  authority_evidence_digest: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

export interface PreparedCommercialProposal {
  command: Readonly<Record<string, unknown>>;
  title: string;
  summary: string;
  termsJson: string;
  termsHash: string;
  contentRef: string;
  contentHash: string;
  evidenceRefsJson: string;
  evidenceDigest: string;
}

export function commercialPaymentTermsDays(terms: unknown): number | null {
  if (!terms || typeof terms !== "object" || Array.isArray(terms)) return null;
  const value = (terms as Record<string, unknown>).payment_terms_days;
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 365
    ? Number(value)
    : null;
}

export interface RecordCommercialPublicationInput {
  tenantId: string;
  proposalRevisionId: string;
  proposalPackId: string;
  publicationVersion: number;
  previousState: CommercialPublicationState;
  state: Exclude<CommercialPublicationState, "draft">;
  authority: CommercialAuthorityBinding;
  externalEffectId?: string | null;
  idempotencyKey: string;
}

export interface CommercialPublicationRecord {
  publication_event_id: string;
  tenant_id: string;
  proposal_revision_id: string;
  proposal_pack_id: string;
  publication_version: number;
  previous_state: CommercialPublicationState;
  state: Exclude<CommercialPublicationState, "draft">;
  policy_permit_id: string | null;
  proposal_publication_approval_id: string | null;
  external_effect_id: string | null;
  command_fingerprint: string;
  idempotency_key_hash: string;
  evidence_digest: string;
  occurred_at: string;
}

export interface CommercialAcceptanceBindingRecord {
  acceptance_binding_id: string;
  acceptance_id: string;
  tenant_id: string;
  quote_revision_id: string;
  proposal_revision_id: string;
  roof_job_id: string;
  customer_id: string;
  terms_hash: string;
  receipt_hash: string;
  accepted_at: string;
  bound_at: string;
}

export class CommercialStoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CommercialStoreError";
  }
}

export function buildLeadTriageCommand(input: RecordLeadTriageInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: "ironwrap.commercial-lead-triage.v1",
    tenant_id: tenant(input.tenantId),
    lead_id: id(input.leadId, 8, 200, "commercial_lead_id_invalid"),
    expected_lead_version: integer(input.expectedLeadVersion, 1, 999_999, "commercial_lead_version_invalid"),
    lifecycle_status: oneOf(input.lifecycleStatus, ["triaged", "qualified", "disqualified"] as const, "commercial_lead_status_invalid"),
    priority: oneOf(input.priority, ["low", "normal", "high", "urgent"] as const, "commercial_lead_priority_invalid"),
    category: text(input.category, 2, 80, "commercial_lead_category_invalid"),
    summary: text(input.summary, 1, 2_000, "commercial_lead_summary_invalid"),
    next_action: text(input.nextAction, 1, 500, "commercial_lead_next_action_invalid"),
  });
}

export async function recordLeadTriageDecision(
  env: AppEnv,
  input: RecordLeadTriageInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; decision: CommercialLeadTriageRecord }> {
  const command = buildLeadTriageCommand(input);
  const commandFingerprint = await commercialCommandFingerprint(command);
  const idempotencyKeyHash = await hashedIdempotencyKey(input.idempotencyKey);
  const existing = await findByIdempotency<CommercialLeadTriageRecord>(
    env,
    "commercial_lead_triage_decisions",
    input.tenantId,
    idempotencyKeyHash,
  );
  if (existing) return replay(existing, commandFingerprint, "commercial_triage_idempotency_conflict", "decision");

  const decidedAt = clock(now);
  const lead = await env.DB.prepare(
    `SELECT version, lifecycle_status FROM operating_leads WHERE tenant_id = ? AND lead_id = ?`,
  ).bind(input.tenantId, input.leadId).first<{ version: number; lifecycle_status: string }>();
  if (!lead) fail("commercial_lead_missing");
  if (lead.version !== input.expectedLeadVersion) fail("commercial_triage_version_conflict");
  if (!validLeadTransition(lead.lifecycle_status, input.lifecycleStatus)) {
    fail("commercial_triage_transition_invalid");
  }
  const authority = await resolveCommercialAuthority(env, input.authority, {
    tenantId: input.tenantId,
    action: "lead.triage.record",
    aggregate: { type: "lead", id: input.leadId, version: input.expectedLeadVersion },
    commandFingerprint,
    now: decidedAt,
  });
  const decisionId = await recordId("commercial-triage", input.tenantId, idempotencyKeyHash);
  try {
    await env.DB.prepare(
      `INSERT INTO commercial_lead_triage_decisions (
         triage_decision_id, tenant_id, lead_id, lead_version, lifecycle_status, priority,
         category, summary, next_action, policy_permit_id, lead_triage_approval_id,
         authority_evidence_digest, command_fingerprint, idempotency_key_hash, decided_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      decisionId, input.tenantId, input.leadId, input.expectedLeadVersion + 1,
      command.lifecycle_status, command.priority, command.category, command.summary,
      command.next_action, authority.policyPermitId, authority.approvalRequestId,
      authority.evidenceDigest, commandFingerprint, idempotencyKeyHash, decidedAt,
    ).run();
  } catch (error) {
    const concurrent = await findByIdempotency<CommercialLeadTriageRecord>(
      env, "commercial_lead_triage_decisions", input.tenantId, idempotencyKeyHash,
    );
    if (concurrent) return replay(concurrent, commandFingerprint, "commercial_triage_idempotency_conflict", "decision");
    throw error;
  }
  const decision = await requiredById<CommercialLeadTriageRecord>(
    env, "commercial_lead_triage_decisions", "triage_decision_id", input.tenantId, decisionId,
    "commercial_triage_write_failed",
  );
  return { kind: "created", decision };
}

export async function prepareCommercialQuote(
  input: RecordCommercialQuoteInput,
): Promise<PreparedCommercialQuote> {
  const tenantId = tenant(input.tenantId);
  const quoteRevisionId = id(input.quoteRevisionId, 12, 160, "commercial_quote_revision_id_invalid");
  const customerQuoteId = id(input.customerQuoteId, 8, 160, "commercial_customer_quote_id_invalid");
  const revisionNumber = integer(input.revisionNumber, 1, 1_000_000, "commercial_quote_revision_invalid");
  const roofJobId = id(input.roofJobId, 8, 200, "commercial_roof_job_id_invalid");
  const customerId = id(input.customerId, 8, 200, "commercial_customer_id_invalid");
  const supersedes = nullableId(input.supersedesQuoteRevisionId, 12, 160, "commercial_quote_predecessor_invalid");
  const correctionReason = nullableText(input.correctionReason, 3, 2_000, "commercial_quote_correction_invalid");
  if (
    revisionNumber === 1
      ? supersedes !== null || correctionReason !== null
      : supersedes === null || correctionReason === null
  ) {
    fail("commercial_quote_revision_chain_invalid");
  }
  const status = oneOf(
    input.status,
    ["draft", "needs_review", "approved", "rejected", "expired"] as const,
    "commercial_quote_status_invalid",
  );
  if (!/^[A-Z]{3}$/.test(input.currency)) fail("commercial_quote_currency_invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil) || !Number.isFinite(Date.parse(`${input.validUntil}T00:00:00.000Z`))) {
    fail("commercial_quote_valid_until_invalid");
  }
  const paymentTermsDays = commercialPaymentTermsDays(input.terms);
  if (status === "approved" && paymentTermsDays === null) {
    fail("commercial_quote_payment_terms_invalid");
  }
  const termsJson = boundedJson(input.terms, 48_000, "commercial_quote_terms_invalid");
  const termsHash = await sha256Hex(termsJson);
  const evidence = normalizedEvidence(input.evidence);
  const evidenceRefsJson = canonicalJson(evidence);
  const evidenceDigest = await sha256Hex(evidenceRefsJson);
  const lines = normalizeQuoteLines(tenantId, quoteRevisionId, input.lines);
  const subtotalCents = checkedMoneySum(lines.map((line) => line.subtotal_cents));
  const taxCents = checkedMoneySum(lines.map((line) => line.tax_cents));
  const totalCents = checkedMoneySum(lines.map((line) => line.total_cents));
  if (subtotalCents + taxCents !== totalCents) fail("commercial_quote_total_invalid");
  const command = Object.freeze({
    schema_version: "ironwrap.commercial-quote-revision.v1",
    tenant_id: tenantId,
    quote_revision_id: quoteRevisionId,
    customer_quote_id: customerQuoteId,
    revision_number: revisionNumber,
    roof_job_id: roofJobId,
    customer_id: customerId,
    supersedes_quote_revision_id: supersedes,
    status,
    currency: input.currency,
    valid_until: input.validUntil,
    subtotal_cents: subtotalCents,
    tax_cents: taxCents,
    total_cents: totalCents,
    payment_terms_days: paymentTermsDays,
    terms_hash: termsHash,
    evidence_digest: evidenceDigest,
    correction_reason: correctionReason,
    lines: lines.map(({ tenant_id: _tenant, quote_revision_id: _quote, ...line }) => line),
  });
  return {
    command,
    lines,
    termsJson,
    termsHash,
    evidenceRefsJson,
    evidenceDigest,
    subtotalCents,
    taxCents,
    totalCents,
  };
}

export async function recordCommercialQuoteRevision(
  env: AppEnv,
  input: RecordCommercialQuoteInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; quote: CommercialQuoteRecord; lines: CommercialQuoteLineRecord[] }> {
  const prepared = await prepareCommercialQuote(input);
  const commandFingerprint = await commercialCommandFingerprint(prepared.command);
  const idempotencyKeyHash = await hashedIdempotencyKey(input.idempotencyKey);
  const existing = await findByIdempotency<CommercialQuoteRecord>(
    env, "commercial_quote_revisions", input.tenantId, idempotencyKeyHash,
  );
  if (existing) return await replayQuote(env, existing, commandFingerprint);

  await assertJobLeadQualified(
    env,
    input.tenantId,
    input.roofJobId,
    input.revisionNumber > 1 && !!input.supersedesQuoteRevisionId,
  );

  const createdAt = clock(now);
  if (input.validUntil < createdAt.slice(0, 10)) fail("commercial_quote_already_expired");
  await assertJobCustomer(env, input.tenantId, input.roofJobId, input.customerId);
  const authority = await resolveCommercialAuthority(env, input.authority, {
    tenantId: input.tenantId,
    action: "quote.revision.record",
    aggregate: { type: "customer_quote", id: input.customerQuoteId, version: input.revisionNumber },
    commandFingerprint,
    amountCents: prepared.totalCents,
    roofJobId: input.roofJobId,
    customerQuoteId: input.customerQuoteId,
    now: createdAt,
  });
  const statements = [
    env.DB.prepare(
      `INSERT INTO commercial_quote_revisions (
         quote_revision_id, tenant_id, customer_quote_id, revision_number, roof_job_id,
         customer_id, supersedes_quote_revision_id, status, currency, valid_until,
         subtotal_cents, tax_cents, total_cents, terms_json, terms_hash, evidence_refs_json,
         evidence_digest, correction_reason, policy_permit_id, quote_revision_approval_id,
         authority_evidence_digest, command_fingerprint, idempotency_key_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.quoteRevisionId, input.tenantId, input.customerQuoteId, input.revisionNumber,
      input.roofJobId, input.customerId, input.supersedesQuoteRevisionId ?? null,
      prepared.command.status, input.currency, input.validUntil, prepared.subtotalCents,
      prepared.taxCents, prepared.totalCents, prepared.termsJson, prepared.termsHash,
      prepared.evidenceRefsJson, prepared.evidenceDigest, input.correctionReason?.trim() || null,
      authority.policyPermitId, authority.approvalRequestId, authority.evidenceDigest,
      commandFingerprint, idempotencyKeyHash, createdAt,
    ),
    ...prepared.lines.map((line) => env.DB.prepare(
      `INSERT INTO commercial_quote_lines (
         quote_revision_id, tenant_id, line_id, sequence, kind, description, quantity_micros,
         uom, unit_price_cents, subtotal_cents, tax_code, tax_cents, total_cents
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      line.quote_revision_id, line.tenant_id, line.line_id, line.sequence, line.kind,
      line.description, line.quantity_micros, line.uom, line.unit_price_cents,
      line.subtotal_cents, line.tax_code, line.tax_cents, line.total_cents,
    )),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const concurrent = await findByIdempotency<CommercialQuoteRecord>(
      env, "commercial_quote_revisions", input.tenantId, idempotencyKeyHash,
    );
    if (concurrent) return await replayQuote(env, concurrent, commandFingerprint);
    throw error;
  }
  const quote = await requiredById<CommercialQuoteRecord>(
    env, "commercial_quote_revisions", "quote_revision_id", input.tenantId,
    input.quoteRevisionId, "commercial_quote_write_failed",
  );
  return { kind: "created", quote, lines: await quoteLines(env, quote.tenant_id, quote.quote_revision_id) };
}

export async function recordCommercialProposalRevision(
  env: AppEnv,
  input: RecordCommercialProposalInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; proposal: CommercialProposalRecord }> {
  const normalized = await prepareCommercialProposal(input);
  const commandFingerprint = await commercialCommandFingerprint(normalized.command);
  const idempotencyKeyHash = await hashedIdempotencyKey(input.idempotencyKey);
  const existing = await findByIdempotency<CommercialProposalRecord>(
    env, "commercial_proposal_revisions", input.tenantId, idempotencyKeyHash,
  );
  if (existing) return replay(existing, commandFingerprint, "commercial_proposal_idempotency_conflict", "proposal");

  const quoteCorrection = await env.DB.prepare(
    `SELECT revision_number, supersedes_quote_revision_id
       FROM commercial_quote_revisions
      WHERE tenant_id = ? AND quote_revision_id = ? LIMIT 1`,
  ).bind(input.tenantId, input.quoteRevisionId).first<{
    revision_number: number;
    supersedes_quote_revision_id: string | null;
  }>();
  await assertJobLeadQualified(
    env,
    input.tenantId,
    input.roofJobId,
    (input.revisionNumber > 1 && !!input.supersedesProposalRevisionId) ||
      (!!quoteCorrection && quoteCorrection.revision_number > 1 && !!quoteCorrection.supersedes_quote_revision_id),
  );

  const createdAt = clock(now);
  const quote = await requiredById<CommercialQuoteRecord>(
    env, "commercial_quote_revisions", "quote_revision_id", input.tenantId,
    input.quoteRevisionId, "commercial_proposal_quote_missing",
  );
  if (
    quote.status !== "approved" || quote.roof_job_id !== input.roofJobId ||
    quote.customer_id !== input.customerId || quote.terms_hash !== normalized.termsHash
  ) fail("commercial_proposal_quote_mismatch");
  const authority = await resolveCommercialAuthority(env, input.authority, {
    tenantId: input.tenantId,
    action: "proposal.revision.record",
    aggregate: { type: "proposal", id: input.proposalPackId, version: input.revisionNumber },
    commandFingerprint,
    now: createdAt,
  });
  try {
    await env.DB.prepare(
      `INSERT INTO commercial_proposal_revisions (
         proposal_revision_id, tenant_id, proposal_pack_id, revision_number, quote_revision_id,
         roof_job_id, customer_id, supersedes_proposal_revision_id, title, summary, terms_json,
         terms_hash, content_ref, content_hash, evidence_refs_json, evidence_digest,
         policy_permit_id, authority_evidence_digest, command_fingerprint, idempotency_key_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.proposalRevisionId, input.tenantId, input.proposalPackId, input.revisionNumber,
      input.quoteRevisionId, input.roofJobId, input.customerId,
      input.supersedesProposalRevisionId ?? null, normalized.title, normalized.summary,
      normalized.termsJson, normalized.termsHash, normalized.contentRef, normalized.contentHash,
      normalized.evidenceRefsJson, normalized.evidenceDigest, authority.policyPermitId,
      authority.evidenceDigest, commandFingerprint, idempotencyKeyHash, createdAt,
    ).run();
  } catch (error) {
    const concurrent = await findByIdempotency<CommercialProposalRecord>(
      env, "commercial_proposal_revisions", input.tenantId, idempotencyKeyHash,
    );
    if (concurrent) return replay(concurrent, commandFingerprint, "commercial_proposal_idempotency_conflict", "proposal");
    throw error;
  }
  const proposal = await requiredById<CommercialProposalRecord>(
    env, "commercial_proposal_revisions", "proposal_revision_id", input.tenantId,
    input.proposalRevisionId, "commercial_proposal_write_failed",
  );
  return { kind: "created", proposal };
}

export async function recordCommercialProposalPublication(
  env: AppEnv,
  input: RecordCommercialPublicationInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; publication: CommercialPublicationRecord }> {
  const command = buildCommercialPublicationCommand(input);
  const commandFingerprint = await commercialCommandFingerprint(command);
  const idempotencyKeyHash = await hashedIdempotencyKey(input.idempotencyKey);
  const externalEffectId = nullableId(
    input.externalEffectId,
    16,
    160,
    "commercial_publication_effect_id_invalid",
  );
  const existing = await findByIdempotency<CommercialPublicationRecord>(
    env, "commercial_proposal_publication_events", input.tenantId, idempotencyKeyHash,
  );

  const occurredAt = clock(now);
  const proposal = await requiredById<CommercialProposalRecord>(
    env, "commercial_proposal_revisions", "proposal_revision_id", input.tenantId,
    input.proposalRevisionId, "commercial_publication_proposal_missing",
  );
  if (existing) return replayPublication(existing, commandFingerprint, externalEffectId);
  if (proposal.proposal_pack_id !== input.proposalPackId) fail("commercial_publication_proposal_mismatch");
  const currentProposal = await getCurrentCommercialProposal(
    env,
    input.tenantId,
    input.proposalPackId,
  );
  if (currentProposal?.proposal_revision_id !== input.proposalRevisionId) {
    fail("commercial_publication_proposal_not_current");
  }
  const quote = await requiredById<CommercialQuoteRecord>(
    env, "commercial_quote_revisions", "quote_revision_id", input.tenantId,
    proposal.quote_revision_id, "commercial_publication_quote_missing",
  );
  if (quote.status !== "approved") fail("commercial_publication_quote_not_approved");
  await assertJobLeadQualified(
    env,
    input.tenantId,
    proposal.roof_job_id,
    quote.revision_number > 1 && !!quote.supersedes_quote_revision_id,
  );
  if (quote.terms_hash !== proposal.terms_hash) fail("commercial_publication_terms_mismatch");
  const action = input.state === "published" ? "proposal.publish" : "proposal.withdraw";
  const authority = await resolveCommercialAuthority(env, input.authority, {
    tenantId: input.tenantId,
    action,
    aggregate: { type: "proposal_publication", id: input.proposalPackId, version: input.publicationVersion },
    commandFingerprint,
    roofJobId: proposal.roof_job_id,
    customerQuoteId: quote.customer_quote_id,
    proposalPackId: input.proposalPackId,
    now: occurredAt,
  });
  if (authority.kind === "policy_permit") {
    if (!externalEffectId) fail("commercial_publication_effect_required");
    await assertSucceededPublicationEffect(
      env, input.tenantId, externalEffectId, authority.policyPermitId!,
      input.proposalRevisionId, input.proposalPackId, input.publicationVersion, action,
    );
  } else if (externalEffectId || input.state !== "published") {
    fail("commercial_publication_approval_path_invalid");
  }
  const eventId = await recordId("commercial-publication", input.tenantId, idempotencyKeyHash);
  try {
    await env.DB.prepare(
      `INSERT INTO commercial_proposal_publication_events (
         publication_event_id, tenant_id, proposal_revision_id, proposal_pack_id,
         publication_version, previous_state, state, policy_permit_id,
         proposal_publication_approval_id, external_effect_id, command_fingerprint,
         idempotency_key_hash, evidence_digest, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      eventId, input.tenantId, input.proposalRevisionId, input.proposalPackId,
      input.publicationVersion, input.previousState, input.state, authority.policyPermitId,
      authority.approvalRequestId, externalEffectId, commandFingerprint,
      idempotencyKeyHash, authority.evidenceDigest, occurredAt,
    ).run();
  } catch (error) {
    const concurrent = await findByIdempotency<CommercialPublicationRecord>(
      env, "commercial_proposal_publication_events", input.tenantId, idempotencyKeyHash,
    );
    if (concurrent) return replayPublication(concurrent, commandFingerprint, externalEffectId);
    throw error;
  }
  const publication = await requiredById<CommercialPublicationRecord>(
    env, "commercial_proposal_publication_events", "publication_event_id", input.tenantId,
    eventId, "commercial_publication_write_failed",
  );
  return { kind: "created", publication };
}

export async function bindCommercialCustomerAcceptance(
  env: AppEnv,
  input: {
    tenantId: string;
    acceptanceId: string;
    quoteRevisionId: string;
    proposalRevisionId: string;
  },
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; binding: CommercialAcceptanceBindingRecord }> {
  const tenantId = tenant(input.tenantId);
  text(input.acceptanceId, 16, 100, "commercial_acceptance_id_invalid");
  id(input.quoteRevisionId, 12, 160, "commercial_quote_revision_id_invalid");
  id(input.proposalRevisionId, 12, 160, "commercial_proposal_revision_id_invalid");
  const existing = await env.DB.prepare(
    `SELECT * FROM commercial_acceptance_bindings WHERE tenant_id = ? AND acceptance_id = ?`,
  ).bind(tenantId, input.acceptanceId).first<CommercialAcceptanceBindingRecord>();
  if (existing) {
    if (
      existing.quote_revision_id !== input.quoteRevisionId ||
      existing.proposal_revision_id !== input.proposalRevisionId
    ) fail("commercial_acceptance_binding_conflict");
    return { kind: "replayed", binding: existing };
  }
  const chain = await env.DB.prepare(
    `SELECT acceptance.roof_job_id, acceptance.customer_id, acceptance.terms_hash,
            acceptance.receipt_hash, acceptance.accepted_at
       FROM customer_portal_acceptance_intents acceptance
       JOIN commercial_quote_revisions quote
         ON quote.quote_revision_id = ? AND quote.tenant_id = acceptance.tenant_id
       JOIN commercial_proposal_revisions proposal
         ON proposal.proposal_revision_id = ? AND proposal.tenant_id = acceptance.tenant_id
      WHERE acceptance.tenant_id = ? AND acceptance.acceptance_id = ?
        AND acceptance.state = 'accepted' AND acceptance.receipt_hash IS NOT NULL
        AND acceptance.quote_id = quote.customer_quote_id
        AND acceptance.quote_version = quote.revision_number
        AND acceptance.proposal_pack_id = proposal.proposal_pack_id
        AND acceptance.roof_job_id = quote.roof_job_id
        AND acceptance.roof_job_id = proposal.roof_job_id
        AND acceptance.customer_id = quote.customer_id
        AND acceptance.customer_id = proposal.customer_id
        AND quote.status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM commercial_quote_revisions successor
           WHERE successor.tenant_id = quote.tenant_id
             AND successor.supersedes_quote_revision_id = quote.quote_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_quote_revisions other
           WHERE other.tenant_id = quote.tenant_id
             AND other.customer_quote_id = quote.customer_quote_id
             AND other.quote_revision_id != quote.quote_revision_id
             AND NOT EXISTS (
               SELECT 1 FROM commercial_quote_revisions other_successor
                WHERE other_successor.tenant_id = other.tenant_id
                  AND other_successor.supersedes_quote_revision_id = other.quote_revision_id
             )
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions successor
           WHERE successor.tenant_id = proposal.tenant_id
             AND successor.supersedes_proposal_revision_id = proposal.proposal_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions other
           WHERE other.tenant_id = proposal.tenant_id
             AND other.proposal_pack_id = proposal.proposal_pack_id
             AND other.proposal_revision_id != proposal.proposal_revision_id
             AND NOT EXISTS (
               SELECT 1 FROM commercial_proposal_revisions other_successor
                WHERE other_successor.tenant_id = other.tenant_id
                  AND other_successor.supersedes_proposal_revision_id = other.proposal_revision_id
             )
        )
        AND acceptance.terms_hash = quote.terms_hash
        AND acceptance.terms_hash = proposal.terms_hash
        AND proposal.quote_revision_id = quote.quote_revision_id
        AND EXISTS (
          SELECT 1 FROM commercial_proposal_publication_events publication
           WHERE publication.tenant_id = acceptance.tenant_id
             AND publication.proposal_pack_id = proposal.proposal_pack_id
             AND publication.proposal_revision_id = proposal.proposal_revision_id
             AND publication.state = 'published'
             AND publication.occurred_at <= acceptance.accepted_at
             AND publication.publication_version = (
               SELECT MAX(prior.publication_version)
                 FROM commercial_proposal_publication_events prior
                WHERE prior.tenant_id = acceptance.tenant_id
                  AND prior.proposal_pack_id = proposal.proposal_pack_id
                  AND prior.occurred_at <= acceptance.accepted_at
             )
        )`,
  ).bind(
    input.quoteRevisionId, input.proposalRevisionId, tenantId, input.acceptanceId,
  ).first<{
    roof_job_id: string;
    customer_id: string;
    terms_hash: string;
    receipt_hash: string;
    accepted_at: string;
  }>();
  if (!chain) fail("commercial_acceptance_chain_mismatch");
  await assertAcceptanceLeadQualified(env, tenantId, chain.roof_job_id, input.quoteRevisionId);
  const boundAt = clock(now);
  if (Date.parse(chain.accepted_at) > Date.parse(boundAt)) fail("commercial_acceptance_time_invalid");
  const bindingId = await recordId(
    "commercial-acceptance", tenantId, await sha256Hex(input.acceptanceId),
  );
  try {
    await env.DB.prepare(
      `INSERT INTO commercial_acceptance_bindings (
         acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
         proposal_revision_id, roof_job_id, customer_id, terms_hash, receipt_hash,
         accepted_at, bound_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      bindingId, input.acceptanceId, tenantId, input.quoteRevisionId,
      input.proposalRevisionId, chain.roof_job_id, chain.customer_id, chain.terms_hash,
      chain.receipt_hash, chain.accepted_at, boundAt,
    ).run();
  } catch (error) {
    const concurrent = await env.DB.prepare(
      `SELECT * FROM commercial_acceptance_bindings WHERE tenant_id = ? AND acceptance_id = ?`,
    ).bind(tenantId, input.acceptanceId).first<CommercialAcceptanceBindingRecord>();
    if (concurrent) {
      if (
        concurrent.quote_revision_id !== input.quoteRevisionId ||
        concurrent.proposal_revision_id !== input.proposalRevisionId
      ) fail("commercial_acceptance_binding_conflict");
      return { kind: "replayed", binding: concurrent };
    }
    throw error;
  }
  const binding = await requiredById<CommercialAcceptanceBindingRecord>(
    env, "commercial_acceptance_bindings", "acceptance_binding_id", tenantId,
    bindingId, "commercial_acceptance_write_failed",
  );
  return { kind: "created", binding };
}

export async function getCurrentCommercialQuote(
  env: AppEnv,
  tenantId: string,
  customerQuoteId: string,
): Promise<{ quote: CommercialQuoteRecord; lines: CommercialQuoteLineRecord[] } | null> {
  const quotes = await env.DB.prepare(
    `SELECT current.* FROM commercial_quote_revisions current
      WHERE current.tenant_id = ? AND current.customer_quote_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM commercial_quote_revisions successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_quote_revision_id = current.quote_revision_id
        )
      ORDER BY current.revision_number DESC LIMIT 2`,
  ).bind(tenant(tenantId), customerQuoteId).all<CommercialQuoteRecord>();
  const quoteRows = quotes.results ?? [];
  const quote = quoteRows.length === 1 ? quoteRows[0]! : null;
  return quote ? { quote, lines: await quoteLines(env, tenantId, quote.quote_revision_id) } : null;
}

export async function getCurrentCommercialProposal(
  env: AppEnv,
  tenantId: string,
  proposalPackId: string,
): Promise<CommercialProposalRecord | null> {
  const proposals = await env.DB.prepare(
    `SELECT current.* FROM commercial_proposal_revisions current
      WHERE current.tenant_id = ? AND current.proposal_pack_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.supersedes_proposal_revision_id = current.proposal_revision_id
        )
      ORDER BY current.revision_number DESC LIMIT 2`,
  ).bind(tenant(tenantId), proposalPackId).all<CommercialProposalRecord>();
  const rows = proposals.results ?? [];
  return rows.length === 1 ? rows[0]! : null;
}

export async function getCurrentCommercialPublication(
  env: AppEnv,
  tenantId: string,
  proposalPackId: string,
): Promise<CommercialPublicationRecord | null> {
  const publications = await env.DB.prepare(
    `SELECT current.* FROM commercial_proposal_publication_events current
      WHERE current.tenant_id = ? AND current.proposal_pack_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_publication_events successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.proposal_pack_id = current.proposal_pack_id
             AND successor.publication_version > current.publication_version
        )
      ORDER BY current.publication_version DESC LIMIT 2`,
  ).bind(tenant(tenantId), proposalPackId).all<CommercialPublicationRecord>();
  const rows = publications.results ?? [];
  return rows.length === 1 ? rows[0]! : null;
}

export async function getCommercialAcceptanceForJob(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<CommercialAcceptanceBindingRecord | null> {
  const acceptances = await env.DB.prepare(
    `SELECT * FROM commercial_acceptance_bindings
      WHERE tenant_id = ? AND roof_job_id = ?
      ORDER BY accepted_at DESC, acceptance_binding_id DESC LIMIT 2`,
  ).bind(tenant(tenantId), roofJobId).all<CommercialAcceptanceBindingRecord>();
  const rows = acceptances.results ?? [];
  return rows.length === 1 ? rows[0]! : null;
}

export async function prepareCommercialProposal(
  input: RecordCommercialProposalInput,
): Promise<PreparedCommercialProposal> {
  const revisionNumber = integer(input.revisionNumber, 1, 1_000_000, "commercial_proposal_revision_invalid");
  const supersedes = nullableId(input.supersedesProposalRevisionId, 12, 160, "commercial_proposal_predecessor_invalid");
  if ((revisionNumber === 1) !== (supersedes === null)) fail("commercial_proposal_revision_chain_invalid");
  const title = text(input.title, 1, 200, "commercial_proposal_title_invalid");
  const summary = text(input.summary, 1, 4_000, "commercial_proposal_summary_invalid");
  const paymentTermsDays = commercialPaymentTermsDays(input.terms);
  if (paymentTermsDays === null) fail("commercial_proposal_payment_terms_invalid");
  const termsJson = boundedJson(input.terms, 48_000, "commercial_proposal_terms_invalid");
  const termsHash = await sha256Hex(termsJson);
  const contentRef = evidenceReference(input.contentRef, "commercial_proposal_content_ref_invalid");
  const contentHash = digest(input.contentHash, "commercial_proposal_content_hash_invalid");
  const evidence = normalizedEvidence(input.evidence);
  const evidenceRefsJson = canonicalJson(evidence);
  const evidenceDigest = await sha256Hex(evidenceRefsJson);
  const command = Object.freeze({
    schema_version: "ironwrap.commercial-proposal-revision.v1",
    tenant_id: tenant(input.tenantId),
    proposal_revision_id: id(input.proposalRevisionId, 12, 160, "commercial_proposal_revision_id_invalid"),
    proposal_pack_id: id(input.proposalPackId, 8, 160, "commercial_proposal_pack_id_invalid"),
    revision_number: revisionNumber,
    quote_revision_id: id(input.quoteRevisionId, 12, 160, "commercial_quote_revision_id_invalid"),
    roof_job_id: id(input.roofJobId, 8, 200, "commercial_roof_job_id_invalid"),
    customer_id: id(input.customerId, 8, 200, "commercial_customer_id_invalid"),
    supersedes_proposal_revision_id: supersedes,
    title,
    summary,
    payment_terms_days: paymentTermsDays,
    terms_hash: termsHash,
    content_ref: contentRef,
    content_hash: contentHash,
    evidence_digest: evidenceDigest,
  });
  return {
    command, title, summary, termsJson, termsHash, contentRef, contentHash,
    evidenceRefsJson, evidenceDigest,
  };
}

export function buildCommercialPublicationCommand(
  input: RecordCommercialPublicationInput,
): Readonly<Record<string, unknown>> {
  const state = oneOf(input.state, ["published", "withdrawn"] as const, "commercial_publication_state_invalid");
  const previousState = oneOf(
    input.previousState, ["draft", "published", "withdrawn"] as const,
    "commercial_publication_previous_state_invalid",
  );
  if (!(
    (previousState === "draft" && state === "published") ||
    (previousState === "published" && state === "withdrawn") ||
    (previousState === "withdrawn" && state === "published")
  )) fail("commercial_publication_transition_invalid");
  return Object.freeze({
    schema_version: "ironwrap.commercial-proposal-publication.v1",
    tenant_id: tenant(input.tenantId),
    proposal_revision_id: id(input.proposalRevisionId, 12, 160, "commercial_proposal_revision_id_invalid"),
    proposal_pack_id: id(input.proposalPackId, 8, 160, "commercial_proposal_pack_id_invalid"),
    publication_version: integer(input.publicationVersion, 1, 1_000_000, "commercial_publication_version_invalid"),
    previous_state: previousState,
    state,
  });
}

function normalizeQuoteLines(
  tenantId: string,
  quoteRevisionId: string,
  input: readonly CommercialQuoteLineInput[],
): CommercialQuoteLineRecord[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1_000) fail("commercial_quote_lines_invalid");
  const lines = input.map((line) => {
    const kind = oneOf(
      line.kind,
      ["material", "labour", "equipment", "subcontract", "allowance", "discount", "other"] as const,
      "commercial_quote_line_kind_invalid",
    );
    const quantityMicros = integer(line.quantityMicros, 1, 1_000_000_000_000, "commercial_quote_quantity_invalid");
    const unitPriceCents = signedMoney(line.unitPriceCents, "commercial_quote_unit_price_invalid");
    const taxCents = signedMoney(line.taxCents, "commercial_quote_line_tax_invalid");
    const subtotalCents = roundedMicros(quantityMicros, unitPriceCents);
    const totalCents = safeIntegerSum(subtotalCents, taxCents, "commercial_quote_line_total_invalid");
    if (kind !== "discount" && (unitPriceCents < 0 || subtotalCents < 0 || taxCents < 0)) {
      fail("commercial_quote_negative_line_invalid");
    }
    return {
      quote_revision_id: quoteRevisionId,
      tenant_id: tenantId,
      line_id: id(line.lineId, 3, 120, "commercial_quote_line_id_invalid"),
      sequence: integer(line.sequence, 1, 1_000, "commercial_quote_line_sequence_invalid"),
      kind,
      description: text(line.description, 1, 500, "commercial_quote_line_description_invalid"),
      quantity_micros: quantityMicros,
      uom: text(line.uom, 1, 32, "commercial_quote_line_uom_invalid"),
      unit_price_cents: unitPriceCents,
      subtotal_cents: subtotalCents,
      tax_code: nullableText(line.taxCode, 1, 40, "commercial_quote_tax_code_invalid"),
      tax_cents: taxCents,
      total_cents: totalCents,
    };
  });
  const lineIds = new Set(lines.map((line) => line.line_id));
  if (lineIds.size !== lines.length) fail("commercial_quote_line_duplicate");
  const sorted = [...lines].sort((left, right) => left.sequence - right.sequence);
  if (sorted.some((line, index) => line.sequence !== index + 1)) fail("commercial_quote_line_sequence_invalid");
  return sorted;
}

async function replayQuote(
  env: AppEnv,
  quote: CommercialQuoteRecord,
  commandFingerprint: string,
): Promise<{ kind: "replayed"; quote: CommercialQuoteRecord; lines: CommercialQuoteLineRecord[] }> {
  if (quote.command_fingerprint !== commandFingerprint) fail("commercial_quote_idempotency_conflict");
  return { kind: "replayed", quote, lines: await quoteLines(env, quote.tenant_id, quote.quote_revision_id) };
}

function replayPublication(
  publication: CommercialPublicationRecord,
  commandFingerprint: string,
  externalEffectId: string | null,
): { kind: "replayed"; publication: CommercialPublicationRecord } {
  if (
    publication.command_fingerprint !== commandFingerprint ||
    publication.external_effect_id !== externalEffectId
  ) fail("commercial_publication_idempotency_conflict");
  return { kind: "replayed", publication };
}

function validLeadTransition(current: string, next: CommercialLeadStatus): boolean {
  return (current === "untriaged" && ["triaged", "qualified", "disqualified"].includes(next)) ||
    (current === "triaged" && ["qualified", "disqualified"].includes(next));
}

async function quoteLines(
  env: AppEnv,
  tenantId: string,
  quoteRevisionId: string,
): Promise<CommercialQuoteLineRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM commercial_quote_lines
      WHERE tenant_id = ? AND quote_revision_id = ? ORDER BY sequence`,
  ).bind(tenantId, quoteRevisionId).all<CommercialQuoteLineRecord>();
  return rows.results ?? [];
}

async function assertJobCustomer(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  customerId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT customer_id FROM operating_roof_jobs WHERE tenant_id = ? AND roof_job_id = ?`,
  ).bind(tenantId, roofJobId).first<{ customer_id: string }>();
  if (!row || row.customer_id !== customerId) fail("commercial_job_customer_mismatch");
}

async function assertJobLeadQualified(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  allowConvertedForCorrection = false,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT lead.lifecycle_status
       FROM operating_roof_jobs job
       JOIN operating_leads lead
         ON lead.tenant_id = job.tenant_id AND lead.lead_id = job.lead_id
      WHERE job.tenant_id = ? AND job.roof_job_id = ?
      LIMIT 1`,
  ).bind(tenantId, roofJobId).first<{ lifecycle_status: string }>();
  if (!row ||
      (row.lifecycle_status !== "qualified" &&
        !(allowConvertedForCorrection && row.lifecycle_status === "converted"))) {
    fail("commercial_lead_not_qualified");
  }
}

// Customer acceptance is qualified-only for the initial contract. After conversion, the same
// native path may re-bind only an explicitly superseding current quote correction; production
// snapshot/commit applies the identical predicate below.
async function assertAcceptanceLeadQualified(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  quoteRevisionId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT lead.lifecycle_status, quote.revision_number, quote.supersedes_quote_revision_id
       FROM operating_roof_jobs job
       JOIN operating_leads lead
         ON lead.tenant_id = job.tenant_id AND lead.lead_id = job.lead_id
       JOIN commercial_quote_revisions quote
         ON quote.tenant_id = job.tenant_id AND quote.quote_revision_id = ?
      WHERE job.tenant_id = ? AND job.roof_job_id = ?
      LIMIT 1`,
  ).bind(quoteRevisionId, tenantId, roofJobId).first<{
    lifecycle_status: string;
    revision_number: number;
    supersedes_quote_revision_id: string | null;
  }>();
  if (
    !row ||
    (row.lifecycle_status !== "qualified" &&
      !(row.lifecycle_status === "converted" && row.revision_number > 1 && !!row.supersedes_quote_revision_id))
  ) {
    fail("commercial_lead_not_qualified");
  }
}

async function assertSucceededPublicationEffect(
  env: AppEnv,
  tenantId: string,
  effectId: string,
  permitId: string,
  proposalRevisionId: string,
  proposalPackId: string,
  publicationVersion: number,
  action: "proposal.publish" | "proposal.withdraw",
): Promise<void> {
  const effect = await env.DB.prepare(
    `SELECT state, authority_ref, intent_id, aggregate_type, aggregate_id, aggregate_version, action
       FROM external_effects WHERE effect_id = ? AND tenant_id = ?`,
  ).bind(effectId, tenantId).first<{
    state: string;
    authority_ref: string;
    intent_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: number;
    action: string;
  }>();
  if (
    !effect || effect.state !== "succeeded" || effect.authority_ref !== permitId ||
    effect.intent_id !== proposalRevisionId ||
    effect.aggregate_type !== "proposal_publication" || effect.aggregate_id !== proposalPackId ||
    effect.aggregate_version !== publicationVersion || effect.action !== action
  ) fail("commercial_publication_effect_mismatch");
}

async function findByIdempotency<T>(
  env: AppEnv,
  table: string,
  tenantId: string,
  idempotencyKeyHash: string,
): Promise<T | null> {
  return await env.DB.prepare(
    `SELECT * FROM ${safeTable(table)} WHERE tenant_id = ? AND idempotency_key_hash = ?`,
  ).bind(tenantId, idempotencyKeyHash).first<T>();
}

async function requiredById<T>(
  env: AppEnv,
  table: string,
  idColumn: string,
  tenantId: string,
  entityId: string,
  code: string,
): Promise<T> {
  const row = await env.DB.prepare(
    `SELECT * FROM ${safeTable(table)} WHERE tenant_id = ? AND ${safeColumn(idColumn)} = ?`,
  ).bind(tenantId, entityId).first<T>();
  if (!row) fail(code);
  return row;
}

function replay<T extends { command_fingerprint: string }, K extends string>(
  row: T,
  commandFingerprint: string,
  conflictCode: string,
  key: K,
): { kind: "replayed" } & Record<K, T> {
  if (row.command_fingerprint !== commandFingerprint) fail(conflictCode);
  return { kind: "replayed", [key]: row } as { kind: "replayed" } & Record<K, T>;
}

function normalizedEvidence(value: readonly CommercialEvidenceRef[]): CommercialEvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) fail("commercial_evidence_invalid");
  const evidence = value.map((entry) => ({
    ref: evidenceReference(entry?.ref, "commercial_evidence_invalid"),
    sha256: digest(entry?.sha256, "commercial_evidence_invalid"),
  })).sort((left, right) => left.ref.localeCompare(right.ref));
  if (new Set(evidence.map((entry) => entry.ref)).size !== evidence.length) fail("commercial_evidence_duplicate");
  return evidence;
}

function evidenceReference(value: unknown, code: string): string {
  if (
    typeof value !== "string" || value.length < 3 || value.length > 512 ||
    /[\s?#]/.test(value) || value.includes("..") || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) fail(code);
  return value;
}

function roundedMicros(quantityMicros: number, unitPriceCents: number): number {
  const numerator = BigInt(quantityMicros) * BigInt(unitPriceCents);
  const denominator = 1_000_000n;
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= denominator) {
    quotient += numerator < 0n ? -1n : 1n;
  }
  const result = Number(quotient);
  return signedMoney(result, "commercial_quote_line_subtotal_invalid");
}

function checkedMoneySum(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum = safeIntegerSum(sum, value, "commercial_quote_total_invalid");
  if (sum < 0) fail("commercial_quote_total_invalid");
  return sum;
}

function safeIntegerSum(left: number, right: number, code: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || Math.abs(sum) > 1_000_000_000_000) fail(code);
  return sum;
}

async function hashedIdempotencyKey(value: unknown): Promise<string> {
  return await sha256Hex(text(value, 8, 280, "commercial_idempotency_key_invalid"));
}

async function recordId(prefix: string, tenantId: string, identityHash: string): Promise<string> {
  return `${prefix}:${await sha256Hex(`${tenantId}:${identityHash}`)}`;
}

function boundedJson(value: unknown, max: number, code: string): string {
  let json: string;
  try {
    json = canonicalJson(value);
  } catch {
    fail(code);
  }
  if (json.length < 2 || json.length > max) fail(code);
  return json;
}

function tenant(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) {
    fail("commercial_tenant_invalid");
  }
  return value;
}

function id(value: unknown, min: number, max: number, code: string): string {
  if (
    typeof value !== "string" || value.length < min || value.length > max ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) fail(code);
  return value;
}

function nullableId(value: unknown, min: number, max: number, code: string): string | null {
  return value === undefined || value === null ? null : id(value, min, max, code);
}

function text(value: unknown, min: number, max: number, code: string): string {
  if (typeof value !== "string") fail(code);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) fail(code);
  return normalized;
}

function nullableText(value: unknown, min: number, max: number, code: string): string | null {
  return value === undefined || value === null ? null : text(value, min, max, code);
}

function digest(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(code);
  return value;
}

function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(code);
  return Number(value);
}

function signedMoney(value: unknown, code: string): number {
  return integer(value, -1_000_000_000_000, 1_000_000_000_000, code);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(code);
  return value as T;
}

function clock(value: Date): string {
  if (!Number.isFinite(value.getTime())) fail("commercial_clock_invalid");
  return value.toISOString();
}

function safeTable(value: string): string {
  const allowed = new Set([
    "commercial_lead_triage_decisions",
    "commercial_quote_revisions",
    "commercial_proposal_revisions",
    "commercial_proposal_publication_events",
    "commercial_acceptance_bindings",
  ]);
  if (!allowed.has(value)) fail("commercial_internal_table_invalid");
  return value;
}

function safeColumn(value: string): string {
  const allowed = new Set([
    "triage_decision_id", "quote_revision_id", "proposal_revision_id",
    "publication_event_id", "acceptance_binding_id",
  ]);
  if (!allowed.has(value)) fail("commercial_internal_column_invalid");
  return value;
}

function fail(code: string): never {
  throw new CommercialStoreError(code);
}
