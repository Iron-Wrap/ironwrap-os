import { createHash } from "node:crypto";
import { z } from "zod";

export const JOB_COST_EVENT_CATEGORIES = Object.freeze([
  "Material",
  "Labour",
  "Machine",
  "Equipment",
  "Subcontractor",
  "Freight",
  "Disposal",
  "Permit",
  "Warranty",
  "Other",
]);

export const JOB_COST_EVENT_SOURCE_DOCTYPES = Object.freeze([
  "Evidence Item",
  "Material Lot",
  "Supplier Order",
  "Shop Order",
  "Field Check-in",
  "Integration Reconciliation",
]);

const StableIdSchema = z.string().trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const BoundedReferenceSchema = z.string().trim().min(1).max(140);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const JobCostEventInputSchema = z.object({
  job_cost_event_id: StableIdSchema,
  roof_job_id: StableIdSchema,
  event_kind: z.enum(["cost", "reversal"]),
  category: z.enum(JOB_COST_EVENT_CATEGORIES),
  quantity: z.number().positive().finite().max(1_000_000_000_000),
  unit: StableIdSchema,
  amount_cents: z.number().int().positive().max(2_147_483_647),
  amount_basis: z.enum([
    "Net of Recoverable Tax",
    "Includes Non-Recoverable Tax",
    "No Tax",
  ]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurred_at: IsoDateTimeSchema,
  source_doctype: z.enum(JOB_COST_EVENT_SOURCE_DOCTYPES),
  source_name: StableIdSchema,
  source_digest: Sha256Schema,
  source_evidence_id: StableIdSchema,
  accounting_state: z.enum(["Operational", "Submitted", "Posted"]),
  accounting_system: BoundedReferenceSchema.optional(),
  accounting_entity_type: BoundedReferenceSchema.optional(),
  accounting_entity_id: BoundedReferenceSchema.optional(),
  accounting_digest: Sha256Schema.optional(),
  accounting_posted_at: IsoDateTimeSchema.optional(),
  reconciliation_id: StableIdSchema.optional(),
  reversal_of: StableIdSchema.optional(),
  reversal_reason: z.string().trim().min(1).max(2000).optional(),
  authority_ref: StableIdSchema,
  approved_at: IsoDateTimeSchema,
  approval_reference: StableIdSchema,
}).strict().superRefine((value, context) => {
  const reversalFields = [value.reversal_of, value.reversal_reason];
  if (value.event_kind === "cost" && reversalFields.some(Boolean)) {
    context.addIssue({
      code: "custom",
      path: ["event_kind"],
      message: "job_cost_event_cost_cannot_carry_reversal",
    });
  }
  if (value.event_kind === "reversal" && reversalFields.some((field) => !field)) {
    context.addIssue({
      code: "custom",
      path: ["reversal_of"],
      message: "job_cost_event_reversal_fields_required",
    });
  }

  const submittedFields = [
    value.accounting_system,
    value.accounting_entity_type,
    value.accounting_entity_id,
  ];
  const postedOnlyFields = [
    value.accounting_digest,
    value.accounting_posted_at,
    value.reconciliation_id,
  ];
  if (value.accounting_state === "Operational"
      && [...submittedFields, ...postedOnlyFields].some(Boolean)) {
    context.addIssue({
      code: "custom",
      path: ["accounting_state"],
      message: "job_cost_event_operational_accounting_fields_forbidden",
    });
  }
  if (value.accounting_state === "Submitted"
      && (submittedFields.some((field) => !field) || postedOnlyFields.some(Boolean))) {
    context.addIssue({
      code: "custom",
      path: ["accounting_state"],
      message: "job_cost_event_submitted_accounting_binding_invalid",
    });
  }
  if (value.accounting_state === "Posted"
      && [...submittedFields, ...postedOnlyFields].some((field) => !field)) {
    context.addIssue({
      code: "custom",
      path: ["accounting_state"],
      message: "job_cost_event_posted_accounting_binding_required",
    });
  }
});

function timestamp(value, label) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) throw new Error(`${label}_invalid`);
  return parsed;
}

function recordIdentity(record) {
  return record?.name
    ?? record?.tenant_id
    ?? record?.roof_job_id
    ?? record?.job_cost_event_id
    ?? null;
}

function normalizedQuantity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function sourceBinding(record) {
  return [
    "tenant",
    "roof_job",
    "category",
    "unit",
    "amount_cents",
    "amount_basis",
    "currency",
    "source_doctype",
    "source_name",
    "source_digest",
    "source_evidence",
  ].map((field) => String(record?.[field] ?? ""));
}

function eventSemanticSnapshot(record) {
  const fields = [
    "job_cost_event_id",
    "tenant",
    "roof_job",
    "event_kind",
    "category",
    "unit",
    "amount_cents",
    "amount_basis",
    "currency",
    "occurred_at",
    "source_doctype",
    "source_name",
    "source_digest",
    "source_evidence",
    "accounting_state",
    "accounting_system",
    "accounting_entity_type",
    "accounting_entity_id",
    "accounting_digest",
    "accounting_posted_at",
    "reconciliation",
    "reversal_of",
    "reversal_reason",
    "actor_type",
    "actor_id",
    "authority_ref",
    "approved_by",
    "approved_at",
    "approval_reference",
  ];
  return {
    ...Object.fromEntries(fields.map((field) => [field, String(record?.[field] ?? "")])),
    quantity: normalizedQuantity(record?.quantity),
  };
}

function actorIdForUser(actorUser) {
  const digest = createHash("sha256").update(String(actorUser ?? "")).digest("hex");
  return `frappe-user:${digest.slice(0, 32)}`;
}

export function buildJobCostEventCandidate(input, {
  tenantId,
  actorUser,
  approverId,
  nowIso = new Date().toISOString(),
} = {}) {
  const args = JobCostEventInputSchema.parse(input);
  StableIdSchema.parse(tenantId);
  BoundedReferenceSchema.parse(actorUser);
  BoundedReferenceSchema.parse(approverId);
  IsoDateTimeSchema.parse(nowIso);

  const occurredAt = timestamp(args.occurred_at, "job_cost_event_occurred_at");
  const approvedAt = timestamp(args.approved_at, "job_cost_event_approved_at");
  const recordedAt = timestamp(nowIso, "job_cost_event_recorded_at");
  if (occurredAt > approvedAt || approvedAt > recordedAt) {
    throw new Error("job_cost_event_timestamp_order_invalid");
  }
  if (args.accounting_posted_at) {
    const postedAt = timestamp(args.accounting_posted_at, "job_cost_event_accounting_posted_at");
    if (postedAt < occurredAt || postedAt > recordedAt) {
      throw new Error("job_cost_event_accounting_timestamp_invalid");
    }
  }

  return {
    job_cost_event_id: args.job_cost_event_id,
    tenant: tenantId,
    roof_job: args.roof_job_id,
    event_kind: args.event_kind,
    category: args.category,
    quantity: args.quantity,
    unit: args.unit,
    amount_cents: args.amount_cents,
    amount_basis: args.amount_basis,
    currency: args.currency,
    occurred_at: args.occurred_at,
    source_doctype: args.source_doctype,
    source_name: args.source_name,
    source_digest: args.source_digest,
    source_evidence: args.source_evidence_id,
    accounting_state: args.accounting_state,
    ...(args.accounting_system ? { accounting_system: args.accounting_system } : {}),
    ...(args.accounting_entity_type
      ? { accounting_entity_type: args.accounting_entity_type }
      : {}),
    ...(args.accounting_entity_id ? { accounting_entity_id: args.accounting_entity_id } : {}),
    ...(args.accounting_digest ? { accounting_digest: args.accounting_digest } : {}),
    ...(args.accounting_posted_at
      ? { accounting_posted_at: args.accounting_posted_at }
      : {}),
    ...(args.reconciliation_id ? { reconciliation: args.reconciliation_id } : {}),
    ...(args.reversal_of ? { reversal_of: args.reversal_of } : {}),
    ...(args.reversal_reason ? { reversal_reason: args.reversal_reason } : {}),
    actor_type: "agent",
    actor_id: actorIdForUser(actorUser),
    authority_ref: args.authority_ref,
    recorded_at: nowIso,
    approved_by: approverId,
    approved_at: args.approved_at,
    approval_reference: args.approval_reference,
  };
}

export function assertJobCostEventSources(candidate, {
  tenant,
  roofJob,
  sourceRecord,
  evidence,
  reversalTarget = null,
  existingReversals = [],
  reconciliation = null,
} = {}) {
  if (recordIdentity(tenant) !== candidate.tenant || tenant?.status !== "Active") {
    throw new Error("job_cost_event_tenant_not_active");
  }
  if (recordIdentity(roofJob) !== candidate.roof_job) {
    throw new Error("job_cost_event_roof_job_invalid");
  }
  if (!sourceRecord
      || sourceRecord.name !== candidate.source_name
      || sourceRecord.roof_job !== candidate.roof_job) {
    throw new Error("job_cost_event_source_job_mismatch");
  }
  const evidenceIds = new Set([evidence?.name, evidence?.evidence_id].filter(Boolean));
  if (!evidence
      || !evidenceIds.has(candidate.source_evidence)
      || evidence.roof_job !== candidate.roof_job) {
    throw new Error("job_cost_event_evidence_job_mismatch");
  }
  if (evidence.sync_state !== "Verified"
      || evidence.checksum_algorithm !== "SHA-256"
      || evidence.content_checksum !== candidate.source_digest
      || !evidence.verified_at
      || !evidence.verification_source) {
    throw new Error("job_cost_event_evidence_not_verified");
  }
  if (timestamp(evidence.verified_at, "job_cost_event_evidence_verified_at")
      > timestamp(candidate.recorded_at, "job_cost_event_recorded_at")) {
    throw new Error("job_cost_event_evidence_from_future");
  }
  if (candidate.source_doctype === "Evidence Item") {
    if (!evidenceIds.has(candidate.source_name)
        || !evidenceIds.has(candidate.source_evidence)) {
      throw new Error("job_cost_event_evidence_source_mismatch");
    }
  }

  if (candidate.event_kind === "reversal") {
    if (!reversalTarget
        || ![reversalTarget.name, reversalTarget.job_cost_event_id]
          .filter(Boolean)
          .includes(candidate.reversal_of)
        || reversalTarget.event_kind !== "cost") {
      throw new Error("job_cost_event_reversal_target_invalid");
    }
    if (sourceBinding(reversalTarget).join("\u0000")
        !== sourceBinding(candidate).join("\u0000")
        || normalizedQuantity(reversalTarget.quantity) !== normalizedQuantity(candidate.quantity)) {
      throw new Error("job_cost_event_reversal_binding_mismatch");
    }
    if (existingReversals.length > 0) {
      throw new Error("job_cost_event_already_reversed");
    }
  }

  if (candidate.accounting_state === "Posted") {
    if (!reconciliation
        || ![reconciliation.name, reconciliation.reconciliation_id]
          .filter(Boolean)
          .includes(candidate.reconciliation)
        || reconciliation.roof_job !== candidate.roof_job
        || reconciliation.system_name !== candidate.accounting_system
        || reconciliation.entity_type !== candidate.accounting_entity_type
        || reconciliation.external_entity_id !== candidate.accounting_entity_id
        || reconciliation.local_doctype !== "Job Cost Event"
        || reconciliation.local_name !== candidate.job_cost_event_id
        || !["Matched", "Resolved"].includes(reconciliation.status)
        || reconciliation.currency !== candidate.currency
        || reconciliation.source_payload_hash !== candidate.accounting_digest
        || !reconciliation.detected_at) {
      throw new Error("job_cost_event_posted_reconciliation_invalid");
    }
    const detectedAt = timestamp(
      reconciliation.detected_at,
      "job_cost_event_reconciliation_detected_at",
    );
    const postedAt = timestamp(
      candidate.accounting_posted_at,
      "job_cost_event_accounting_posted_at",
    );
    if (detectedAt < postedAt
        || detectedAt > timestamp(candidate.recorded_at, "job_cost_event_recorded_at")) {
      throw new Error("job_cost_event_reconciliation_timestamp_invalid");
    }
  }
}

export function classifyJobCostEventReplay(candidate, existing) {
  if (!existing) return "new";
  return JSON.stringify(eventSemanticSnapshot(existing))
      === JSON.stringify(eventSemanticSnapshot(candidate))
    ? "identical_replay"
    : "id_conflict";
}
