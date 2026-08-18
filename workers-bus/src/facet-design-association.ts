import { sha256Hex } from "./app-auth.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import { listOfficeEstimatorFrappeResource } from "./frappe-read.ts";

export interface FacetDesignAssociationAnchor {
  event_id: string;
  tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  roof_job_id: string;
  customer_quote_id: string;
}

export interface FacetDesignAssociationInput {
  eventId: string;
  brandId: string;
  facetProjectId: string;
  designRevisionId: string;
  designRevisionSha256: string;
  frozenEvidenceSha256: string;
  roofJobId: string;
  customerQuoteId: string;
  reason: string;
}

interface FacetDesignWorkflowEvidenceBase {
  event_id: string;
  tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  occurred_at: string;
  received_at: string;
  provenance: "customer_approved";
  identity_assurance: "bearer_capability_only";
}

export type FacetDesignWorkflowEvidence =
  | (FacetDesignWorkflowEvidenceBase & { association_state: "required" })
  | (FacetDesignWorkflowEvidenceBase & {
    association_state: "associated";
    roof_job_id: string;
    customer_quote_id: string;
    association_anchor_sha256: string;
    associated_at: string;
  })
  | (FacetDesignWorkflowEvidenceBase & {
    association_state: "revision_prepared";
    roof_job_id: string;
    customer_quote_id: string;
    association_anchor_sha256: string;
    associated_at: string;
    quote_revision_approval_id: string;
    quote_revision_approval_state:
      | "pending"
      | "executing"
      | "failed"
      | "audit_failed"
      | "execution_uncertain";
  });

export interface FacetDesignAssociationTarget {
  roof_job_id: string;
  job_name: string;
  job_number: string;
  brand_id: string;
  service_type: string | null;
  job_status: string | null;
  customer_quote_id: string;
  quote_name: string;
  quote_version: number;
  approved_at: string;
}

export interface FacetDesignAssociationTargetList {
  targets: FacetDesignAssociationTarget[];
  partial_targets: boolean;
}

export interface FacetDesignAssociationProjection extends FacetDesignAssociationAnchor {
  association_anchor_sha256: string;
  associated_at: string;
}

export type ResolvedFacetDesignAssociation =
  | { kind: "resolved"; association: FacetDesignAssociationProjection }
  | { kind: "missing" }
  | { kind: "invalid" };

interface StoredFacetCustomerApprovalEvent {
  event_id: string;
  tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  occurred_at: string;
  received_at: string;
  identity_assurance: "bearer_capability_only";
}

interface StoredFacetDesignWorkflowEvent extends StoredFacetCustomerApprovalEvent {
  association_event_id: string | null;
  roof_job_id: string | null;
  customer_quote_id: string | null;
  association_anchor_sha256: string | null;
  associated_at: string | null;
  quote_revision_approval_id: string | null;
  quote_revision_approval_state: string | null;
}

interface StoredFacetDesignAssociation extends FacetDesignAssociationAnchor {
  associated_by_user_id: string;
  reason: string;
  idempotency_key_sha256: string;
  association_intent_sha256: string;
  association_anchor_sha256: string;
  associated_at: string;
}

export function canPrepareFacetQuoteRevision(
  env: AppEnv,
  auth: AuthContext,
): boolean {
  return hasFacetQuoteRevisionPreparationPermissions(auth) &&
    String(env.APP_FACET_QUOTE_REVISION_PREPARE_ENABLED) === "true";
}

export function hasFacetQuoteRevisionPreparationPermissions(
  auth: AuthContext,
): boolean {
  return auth.permissions.includes("facet:associate") &&
    auth.permissions.includes("approvals:prepare") &&
    auth.permissions.includes("estimator:read");
}

export type FacetDesignAssociationResult =
  | {
    kind: "created" | "replayed";
    association: FacetDesignAssociationProjection;
  }
  | {
    kind: "rejected";
    code:
      | "facet_design_evidence_not_found"
      | "facet_design_provenance_not_association_ready"
      | "facet_design_evidence_anchor_mismatch"
      | "facet_design_association_idempotency_conflict"
      | "facet_design_event_already_associated"
      | "facet_design_roof_job_not_found"
      | "facet_design_brand_mismatch"
      | "facet_design_current_approved_quote_required";
    status: 404 | 409;
  };

export function parseFacetDesignAssociationInput(
  value: unknown,
): FacetDesignAssociationInput | null {
  const keys = [
    "event_id",
    "brand_id",
    "facet_project_id",
    "design_revision_id",
    "design_revision_sha256",
    "frozen_evidence_sha256",
    "roof_job_id",
    "customer_quote_id",
    "reason",
  ] as const;
  if (!isRecord(value) || !sameKeys(value, keys)) return null;
  const eventId = validEventId(value.event_id) ? value.event_id : null;
  const brandId = validBrandId(value.brand_id) ? value.brand_id : null;
  const facetProjectId = validEventId(value.facet_project_id)
    ? value.facet_project_id
    : null;
  const designRevisionId = validEventId(value.design_revision_id)
    ? value.design_revision_id
    : null;
  const designRevisionSha256 = validSha256(value.design_revision_sha256)
    ? value.design_revision_sha256
    : null;
  const frozenEvidenceSha256 = validSha256(value.frozen_evidence_sha256)
    ? value.frozen_evidence_sha256
    : null;
  const roofJobId = validOpaqueId(value.roof_job_id) ? value.roof_job_id : null;
  const customerQuoteId = validOpaqueId(value.customer_quote_id)
    ? value.customer_quote_id
    : null;
  const reason = boundedReason(value.reason);
  if (
    !eventId || !brandId || !facetProjectId || !designRevisionId ||
    !designRevisionSha256 || !frozenEvidenceSha256 || !roofJobId ||
    !customerQuoteId || !reason ||
    designRevisionId !== `facet-json-v1:${designRevisionSha256}`
  ) return null;
  return {
    eventId,
    brandId,
    facetProjectId,
    designRevisionId,
    designRevisionSha256,
    frozenEvidenceSha256,
    roofJobId,
    customerQuoteId,
    reason,
  };
}

export async function listFacetDesignWorkflowEvidence(
  env: Env,
  tenantId: string,
  limit = 50,
): Promise<FacetDesignWorkflowEvidence[]> {
  const result = await env.DB.prepare(
    `SELECT event.event_id, event.tenant_id, event.brand_id, event.facet_project_id,
            event.design_revision_id, event.design_revision_sha256,
            event.frozen_evidence_sha256, event.occurred_at, event.received_at,
            event.identity_assurance, association.event_id AS association_event_id,
            association.roof_job_id, association.customer_quote_id,
            association.association_anchor_sha256, association.associated_at,
            approval.quote_revision_approval_id, approval.state AS quote_revision_approval_state
       FROM facet_customer_approval_events AS event
       LEFT JOIN facet_design_evidence_associations AS association
         ON association.event_id = event.event_id
       LEFT JOIN quote_revision_approval_requests AS approval
         ON approval.tenant_id = event.tenant_id
        AND approval.prepare_idempotency_key =
          ('facet-quote-revision:' || association.association_anchor_sha256)
       WHERE event.tenant_id = ?
         AND event.event_type = 'facet.design.customer_approved.v2'
         AND event.schema_version = 2
         AND event.approval_actor_type = 'customer_capability'
         AND event.identity_assurance = 'bearer_capability_only'
         AND (
           approval.quote_revision_approval_id IS NULL
           OR approval.state IN ('pending', 'executing', 'failed', 'audit_failed', 'execution_uncertain')
         )
       ORDER BY event.occurred_at ASC, event.event_id ASC
       LIMIT ?`,
  ).bind(tenantId, Math.max(1, Math.min(100, limit))).all<StoredFacetDesignWorkflowEvent>();
  return (result.results ?? []).map(workflowEvidenceProjection);
}

export async function listFacetDesignAssociationTargets(
  env: AppEnv,
): Promise<FacetDesignAssociationTargetList> {
  const limit = 100;
  const [jobs, quotes] = await Promise.all([
    listOfficeEstimatorFrappeResource(env, "Roof Job", [], limit),
    listOfficeEstimatorFrappeResource(
      env,
      "Customer Quote",
      [["Customer Quote", "status", "=", "Approved"]],
      limit,
    ),
  ]);
  const quotesByName = new Map(
    quotes.flatMap((quote) => {
      const name = text(quote.name);
      return name ? [[name, quote] as const] : [];
    }),
  );
  const targets = jobs.flatMap((job): FacetDesignAssociationTarget[] => {
    const jobName = text(job.name);
    const roofJobId = text(job.roof_job_id);
    const jobNumber = text(job.job_number);
    const brandId = text(job.brand);
    const quoteName = text(job.quotation);
    const quote = quoteName ? quotesByName.get(quoteName) : null;
    const customerQuoteId = text(quote?.customer_quote_id);
    const quoteVersion = positiveInteger(quote?.quote_version);
    const approvedAt = text(quote?.approved_at);
    if (
      !jobName || !roofJobId || !jobNumber || !brandId || !quoteName ||
      !quote || text(quote.roof_job) !== jobName || text(quote.status) !== "Approved" ||
      !customerQuoteId || quoteVersion === null || !approvedAt
    ) return [];
    return [{
      roof_job_id: roofJobId,
      job_name: jobName,
      job_number: jobNumber,
      brand_id: brandId,
      service_type: text(job.service_type),
      job_status: text(job.job_status),
      customer_quote_id: customerQuoteId,
      quote_name: quoteName,
      quote_version: quoteVersion,
      approved_at: approvedAt,
    }];
  });
  return {
    targets,
    partial_targets: jobs.length === limit || quotes.length === limit,
  };
}

export async function createFacetDesignAssociation(
  env: AppEnv,
  input: FacetDesignAssociationInput & {
    tenantId: string;
    actorUserId: string;
    idempotencyKey: string;
    associatedAt: string;
  },
): Promise<FacetDesignAssociationResult> {
  const requestedAnchor: FacetDesignAssociationAnchor = {
    event_id: input.eventId,
    tenant_id: input.tenantId,
    brand_id: input.brandId,
    facet_project_id: input.facetProjectId,
    design_revision_id: input.designRevisionId,
    design_revision_sha256: input.designRevisionSha256,
    frozen_evidence_sha256: input.frozenEvidenceSha256,
    roof_job_id: input.roofJobId,
    customer_quote_id: input.customerQuoteId,
  };
  const associationAnchorSha256 = await facetDesignAssociationAnchorSha256(requestedAnchor);
  const idempotencyKeySha256 = await sha256Hex(`${input.tenantId}\n${input.idempotencyKey}`);
  const associationIntentSha256 = await sha256Hex(JSON.stringify({
    actor_user_id: input.actorUserId,
    association_anchor_sha256: associationAnchorSha256,
    reason: input.reason,
  }));

  const existingIdempotency = await associationByIdempotency(env, idempotencyKeySha256);
  if (existingIdempotency) {
    return existingIdempotency.association_intent_sha256 === associationIntentSha256
      ? { kind: "replayed", association: associationProjection(existingIdempotency) }
      : rejected("facet_design_association_idempotency_conflict", 409);
  }

  const event = await customerApprovalEvent(env, input.eventId);
  if (!event || event.tenant_id !== input.tenantId) {
    const legacy = await legacyEventTenant(env, input.eventId);
    return legacy === input.tenantId
      ? rejected("facet_design_provenance_not_association_ready", 409)
      : rejected("facet_design_evidence_not_found", 404);
  }
  if (!eventMatchesInput(event, input)) {
    return rejected("facet_design_evidence_anchor_mismatch", 409);
  }
  if (await associationByEvent(env, input.eventId)) {
    return rejected("facet_design_event_already_associated", 409);
  }

  const target = await validateAssociationTarget(env, event, input);
  if (!target.ok) return rejected(target.code, target.status);

  const inserted = await env.DB.prepare(
    `INSERT INTO facet_design_evidence_associations
       (event_id, tenant_id, brand_id, facet_project_id, design_revision_id,
        design_revision_sha256, frozen_evidence_sha256, roof_job_id, customer_quote_id,
        associated_by_user_id, reason, idempotency_key_sha256, association_intent_sha256,
        association_anchor_sha256, associated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).bind(
    requestedAnchor.event_id,
    requestedAnchor.tenant_id,
    requestedAnchor.brand_id,
    requestedAnchor.facet_project_id,
    requestedAnchor.design_revision_id,
    requestedAnchor.design_revision_sha256,
    requestedAnchor.frozen_evidence_sha256,
    requestedAnchor.roof_job_id,
    requestedAnchor.customer_quote_id,
    input.actorUserId,
    input.reason,
    idempotencyKeySha256,
    associationIntentSha256,
    associationAnchorSha256,
    input.associatedAt,
  ).run();
  if (d1Changes(inserted) === 1) {
    return {
      kind: "created",
      association: {
        ...requestedAnchor,
        association_anchor_sha256: associationAnchorSha256,
        associated_at: input.associatedAt,
      },
    };
  }

  const racedIdempotency = await associationByIdempotency(env, idempotencyKeySha256);
  if (racedIdempotency) {
    return racedIdempotency.association_intent_sha256 === associationIntentSha256
      ? { kind: "replayed", association: associationProjection(racedIdempotency) }
      : rejected("facet_design_association_idempotency_conflict", 409);
  }
  return rejected("facet_design_event_already_associated", 409);
}

export async function resolveFacetDesignAssociation(
  env: AppEnv,
  tenantId: string,
  eventId: string,
): Promise<ResolvedFacetDesignAssociation> {
  if (!validEventId(eventId)) return { kind: "missing" };
  const stored = await associationByEvent(env, eventId);
  if (!stored || stored.tenant_id !== tenantId) return { kind: "missing" };
  const event = await customerApprovalEvent(env, eventId);
  const association = associationProjection(stored);
  if (
    !event || !associationMatchesEvent(association, event) ||
    await facetDesignAssociationAnchorSha256(association) !==
      stored.association_anchor_sha256
  ) return { kind: "invalid" };
  return { kind: "resolved", association };
}

export async function facetDesignAssociationAnchorSha256(
  anchor: FacetDesignAssociationAnchor,
): Promise<string> {
  return await sha256Hex(JSON.stringify({
    brand_id: anchor.brand_id,
    customer_quote_id: anchor.customer_quote_id,
    design_revision_id: anchor.design_revision_id,
    design_revision_sha256: anchor.design_revision_sha256,
    event_id: anchor.event_id,
    facet_project_id: anchor.facet_project_id,
    frozen_evidence_sha256: anchor.frozen_evidence_sha256,
    roof_job_id: anchor.roof_job_id,
    tenant_id: anchor.tenant_id,
  }));
}

async function validateAssociationTarget(
  env: AppEnv,
  event: StoredFacetCustomerApprovalEvent,
  input: FacetDesignAssociationInput,
): Promise<
  | { ok: true }
  | {
    ok: false;
    code:
      | "facet_design_roof_job_not_found"
      | "facet_design_brand_mismatch"
      | "facet_design_current_approved_quote_required";
    status: 404 | 409;
  }
> {
  const jobs = await listOfficeEstimatorFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "roof_job_id", "=", input.roofJobId]],
    2,
  );
  if (jobs.length !== 1 || text(jobs[0]?.roof_job_id) !== input.roofJobId) {
    return { ok: false, code: "facet_design_roof_job_not_found", status: 404 };
  }
  const job = jobs[0]!;
  if (text(job.brand) !== event.brand_id) {
    return { ok: false, code: "facet_design_brand_mismatch", status: 409 };
  }
  const jobName = text(job.name);
  const currentQuoteName = text(job.quotation);
  if (!jobName || !currentQuoteName) {
    return {
      ok: false,
      code: "facet_design_current_approved_quote_required",
      status: 409,
    };
  }
  const quotes = await listOfficeEstimatorFrappeResource(
    env,
    "Customer Quote",
    [["Customer Quote", "roof_job", "=", jobName]],
    100,
  );
  const quote = quotes.find((candidate) =>
    text(candidate.name) === currentQuoteName &&
    text(candidate.customer_quote_id) === input.customerQuoteId
  );
  if (
    !quote || text(quote.roof_job) !== jobName || text(quote.status) !== "Approved" ||
    !text(quote.approved_at)
  ) {
    return {
      ok: false,
      code: "facet_design_current_approved_quote_required",
      status: 409,
    };
  }
  return { ok: true };
}

async function customerApprovalEvent(
  env: Env,
  eventId: string,
): Promise<StoredFacetCustomerApprovalEvent | null> {
  return await env.DB.prepare(
    `SELECT event_id, tenant_id, brand_id, facet_project_id, design_revision_id,
            design_revision_sha256, frozen_evidence_sha256, occurred_at, received_at,
            identity_assurance
       FROM facet_customer_approval_events
       WHERE event_id = ?
         AND event_type = 'facet.design.customer_approved.v2'
         AND schema_version = 2
         AND approval_actor_type = 'customer_capability'
         AND identity_assurance = 'bearer_capability_only'
       LIMIT 1`,
  ).bind(eventId).first<StoredFacetCustomerApprovalEvent>();
}

async function legacyEventTenant(env: Env, eventId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT tenant_id FROM facet_design_events
     WHERE event_id = ? AND event_type = 'facet.design.approved.v1' AND schema_version = 1
     LIMIT 1`,
  ).bind(eventId).first<{ tenant_id: string }>();
  return row?.tenant_id ?? null;
}

async function associationByIdempotency(
  env: Env,
  idempotencyKeySha256: string,
): Promise<StoredFacetDesignAssociation | null> {
  return await env.DB.prepare(
    `${associationSelect()}
     WHERE idempotency_key_sha256 = ?
     LIMIT 1`,
  ).bind(idempotencyKeySha256).first<StoredFacetDesignAssociation>();
}

async function associationByEvent(
  env: Env,
  eventId: string,
): Promise<StoredFacetDesignAssociation | null> {
  return await env.DB.prepare(
    `${associationSelect()}
     WHERE event_id = ?
     LIMIT 1`,
  ).bind(eventId).first<StoredFacetDesignAssociation>();
}

function associationSelect(): string {
  return `SELECT event_id, tenant_id, brand_id, facet_project_id, design_revision_id,
                 design_revision_sha256, frozen_evidence_sha256, roof_job_id,
                 customer_quote_id, associated_by_user_id, reason, idempotency_key_sha256,
                 association_intent_sha256, association_anchor_sha256, associated_at
          FROM facet_design_evidence_associations`;
}

function associationProjection(
  association: StoredFacetDesignAssociation,
): FacetDesignAssociationProjection {
  return {
    event_id: association.event_id,
    tenant_id: association.tenant_id,
    brand_id: association.brand_id,
    facet_project_id: association.facet_project_id,
    design_revision_id: association.design_revision_id,
    design_revision_sha256: association.design_revision_sha256,
    frozen_evidence_sha256: association.frozen_evidence_sha256,
    roof_job_id: association.roof_job_id,
    customer_quote_id: association.customer_quote_id,
    association_anchor_sha256: association.association_anchor_sha256,
    associated_at: association.associated_at,
  };
}

function workflowEvidenceProjection(
  event: StoredFacetDesignWorkflowEvent,
): FacetDesignWorkflowEvidence {
  const base: FacetDesignWorkflowEvidenceBase = {
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    brand_id: event.brand_id,
    facet_project_id: event.facet_project_id,
    design_revision_id: event.design_revision_id,
    design_revision_sha256: event.design_revision_sha256,
    frozen_evidence_sha256: event.frozen_evidence_sha256,
    occurred_at: event.occurred_at,
    received_at: event.received_at,
    provenance: "customer_approved",
    identity_assurance: "bearer_capability_only",
  };
  if (!event.association_event_id) return { ...base, association_state: "required" };
  const association = {
    roof_job_id: requiredStoredText(event.roof_job_id),
    customer_quote_id: requiredStoredText(event.customer_quote_id),
    association_anchor_sha256: requiredStoredText(event.association_anchor_sha256),
    associated_at: requiredStoredText(event.associated_at),
  };
  if (!event.quote_revision_approval_id) {
    return { ...base, ...association, association_state: "associated" };
  }
  const approvalState = activeQuoteRevisionState(event.quote_revision_approval_state);
  if (!approvalState) throw new Error("facet_design_workflow_state_invalid");
  return {
    ...base,
    ...association,
    association_state: "revision_prepared",
    quote_revision_approval_id: event.quote_revision_approval_id,
    quote_revision_approval_state: approvalState,
  };
}

function eventMatchesInput(
  event: StoredFacetCustomerApprovalEvent,
  input: FacetDesignAssociationInput,
): boolean {
  return event.event_id === input.eventId &&
    event.brand_id === input.brandId &&
    event.facet_project_id === input.facetProjectId &&
    event.design_revision_id === input.designRevisionId &&
    event.design_revision_sha256 === input.designRevisionSha256 &&
    event.frozen_evidence_sha256 === input.frozenEvidenceSha256;
}

function associationMatchesEvent(
  association: FacetDesignAssociationProjection,
  event: StoredFacetCustomerApprovalEvent,
): boolean {
  return association.event_id === event.event_id &&
    association.tenant_id === event.tenant_id &&
    association.brand_id === event.brand_id &&
    association.facet_project_id === event.facet_project_id &&
    association.design_revision_id === event.design_revision_id &&
    association.design_revision_sha256 === event.design_revision_sha256 &&
    association.frozen_evidence_sha256 === event.frozen_evidence_sha256;
}

function rejected(
  code: Extract<FacetDesignAssociationResult, { kind: "rejected" }>["code"],
  status: 404 | 409,
): FacetDesignAssociationResult {
  return { kind: "rejected", code, status };
}

function validEventId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(value);
}

function validBrandId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,31}$/.test(value);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,139}$/.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function boundedReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= 8 && reason.length <= 1_000 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason)
    ? reason
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requiredStoredText(value: unknown): string {
  const stored = text(value);
  if (!stored) throw new Error("facet_design_workflow_state_invalid");
  return stored;
}

function activeQuoteRevisionState(
  value: unknown,
): Extract<FacetDesignWorkflowEvidence, { association_state: "revision_prepared" }>["quote_revision_approval_state"] | null {
  return value === "pending" || value === "executing" || value === "failed" ||
      value === "audit_failed" || value === "execution_uncertain"
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function d1Changes(result: { meta?: { changes?: number } } | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}
