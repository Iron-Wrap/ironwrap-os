import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const ESTIMATOR_EVIDENCE_SCHEMA_VERSION =
  "ironwrap.estimator-evidence.v1" as const;

const MAX_PAYLOAD_BYTES = 262_144;
const MAX_IDEMPOTENCY_KEY_BYTES = 240;

export interface EstimatorEvidencePayloadV1 {
  schema_version: typeof ESTIMATOR_EVIDENCE_SCHEMA_VERSION;
  measurement: Readonly<Record<string, unknown>>;
  visual_model: Readonly<Record<string, unknown>> | null;
  takeoff: Readonly<Record<string, unknown>>;
  scope_changes: readonly Readonly<Record<string, unknown>>[];
  insurance_supplements: readonly Readonly<Record<string, unknown>>[];
  scope_clauses: readonly Readonly<Record<string, unknown>>[];
  pricing_authority: Readonly<Record<string, unknown>> | null;
}

export interface RecordEstimatorEvidenceInput {
  tenantId: string;
  roofJobId: string;
  operatingJobVersion: number;
  revisionNumber: number;
  supersedesEstimatorRevisionId?: string | null;
  measurementReceiptId: string;
  facetEventId?: string | null;
  commercialQuoteRevisionId?: string | null;
  payload: EstimatorEvidencePayloadV1;
  correctionReason?: string | null;
  importedByUserId: string;
  idempotencyKey: string;
}

export interface EstimatorEvidenceRevisionRecord {
  estimator_revision_id: string;
  tenant_id: string;
  roof_job_id: string;
  operating_job_version: number;
  revision_number: number;
  supersedes_estimator_revision_id: string | null;
  measurement_receipt_id: string;
  measurement_raw_key: string;
  measurement_raw_sha256: string;
  facet_event_id: string | null;
  facet_raw_key: string | null;
  facet_raw_sha256: string | null;
  facet_design_revision_id: string | null;
  facet_design_revision_sha256: string | null;
  facet_frozen_evidence_sha256: string | null;
  commercial_quote_revision_id: string | null;
  payload_json: string;
  payload_sha256: string;
  evidence_refs_json: string;
  evidence_digest: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  correction_reason: string | null;
  imported_by_user_id: string;
  created_at: string;
}

export type EstimatorEvidenceHead =
  | { state: "missing"; revision: null; competing_revision_ids: [] }
  | {
      state: "current";
      revision: EstimatorEvidenceRevisionRecord;
      competing_revision_ids: [];
    }
  | {
      state: "ambiguous";
      revision: null;
      competing_revision_ids: string[];
    };

export class EstimatorNativeStoreError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 409) {
    super(code);
    this.name = "EstimatorNativeStoreError";
    this.code = code;
    this.status = status;
  }
}

interface OperatingJobAnchor {
  roof_job_id: string;
  job_number: string | null;
  version: number;
}

export interface EstimatorMeasurementAnchor {
  receipt_id: string;
  payload_hash: string;
  measurement_id: string;
  provider: string;
  job_number: string | null;
  raw_key: string;
  content_type: string;
  status: string;
  completed_at: string | null;
  report_raw_key: string | null;
  report_sha256: string | null;
  report_content_type: string | null;
  ocr_status: string;
  ocr_model: string | null;
  ocr_result_key: string | null;
  ocr_result_sha256: string | null;
  ocr_job_number_candidate: string | null;
  ocr_job_number_source_ref: string | null;
  ocr_review_required: number;
  ocr_completed_at: string | null;
}

interface EstimatorMeasurementDeltaRow {
  id: number;
  tenant_id: string;
  receipt_id: string;
  measurement_id: string;
  job_number: string | null;
  provider: string;
  source: string;
  check_name: string;
  metric: string;
  ok: number;
  primary_value: number | null;
  independent_value: number | null;
  rel_diff: number | null;
  abs_diff: number | null;
  detail: string;
  error_kind: string;
  signed_error: number | null;
  created_at: string;
}

export interface EstimatorMeasurementEvidenceAnchor {
  receipt: EstimatorMeasurementAnchor;
  deltaRows: EstimatorMeasurementDeltaRow[];
  projection: Readonly<Record<string, unknown>>;
}

interface FacetAnchor {
  event_id: string;
  destination_tenant_id: string;
  roof_job_id: string;
  customer_quote_id: string;
  decision_kind: string;
  raw_key: string;
  raw_sha256: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  external_project_link_id: string;
  producer_identity_link_id: string;
  external_customer_identity_link_id: string;
  association_sha256: string;
  linked_destination_tenant_id: string | null;
  linked_roof_job_id: string | null;
  linked_customer_quote_id: string | null;
  linked_producer_identity_link_id: string | null;
  linked_external_customer_identity_link_id: string | null;
  linked_association_sha256: string | null;
  successor_count: number;
  revocation_count: number;
}

export interface EstimatorCommercialQuoteAnchor {
  quote_revision_id: string;
  customer_quote_id: string;
  roof_job_id: string;
  status: string;
  valid_until: string;
  successor_count: number;
  terminal_approved_count: number;
}

/**
 * Record one immutable Estimator evidence revision after resolving every native authority anchor.
 * The caller supplies normalized Estimator-only facts; this store never calls a provider or Frappe.
 */
export async function recordEstimatorEvidenceRevision(
  env: AppEnv,
  input: RecordEstimatorEvidenceInput,
  now = new Date(),
): Promise<{
  kind: "created" | "replayed";
  revision: EstimatorEvidenceRevisionRecord;
}> {
  if (!env.DB) fail("estimator_db_unavailable", 503);
  validateInput(input);
  const payloadJson = normalizedPayloadJson(input.payload);
  const payloadSha256 = await sha256Hex(payloadJson);
  const idempotencyKeyHash = await sha256Hex(input.idempotencyKey);
  const commandFingerprint = await sha256Hex(
    canonicalJson({
      tenant_id: input.tenantId,
      roof_job_id: input.roofJobId,
      operating_job_version: input.operatingJobVersion,
      revision_number: input.revisionNumber,
      supersedes_estimator_revision_id:
        input.supersedesEstimatorRevisionId ?? null,
      measurement_receipt_id: input.measurementReceiptId,
      facet_event_id: input.facetEventId ?? null,
      commercial_quote_revision_id: input.commercialQuoteRevisionId ?? null,
      payload_sha256: payloadSha256,
      correction_reason: input.correctionReason?.trim() || null,
      imported_by_user_id: input.importedByUserId,
    }),
  );
  const replay = await revisionByIdempotency(
    env,
    input.tenantId,
    idempotencyKeyHash,
  );
  if (replay) {
    if (replay.command_fingerprint !== commandFingerprint) {
      fail("estimator_idempotency_conflict");
    }
    return { kind: "replayed", revision: replay };
  }

  const job = await operatingJobAnchor(env, input.tenantId, input.roofJobId);
  if (!job) fail("estimator_job_missing", 404);
  const [measurementEvidence, head, quote, facet] = await Promise.all([
    readEstimatorMeasurementEvidenceAnchor(
      env,
      input.tenantId,
      input.measurementReceiptId,
    ),
    readEstimatorEvidenceHead(env, input.tenantId, input.roofJobId),
    input.commercialQuoteRevisionId
      ? readCurrentEstimatorCommercialQuoteAnchor(
          env,
          input.tenantId,
          input.roofJobId,
          input.commercialQuoteRevisionId,
          now,
        )
      : Promise.resolve(null),
    input.facetEventId
      ? facetAnchor(env, input.tenantId, input.roofJobId, input.facetEventId)
      : Promise.resolve(null),
  ]);
  const measurement = measurementEvidence?.receipt ?? null;
  if (Number(job.version) !== input.operatingJobVersion) {
    fail("estimator_job_version_drift");
  }
  if (!measurement) fail("estimator_measurement_missing", 404);
  if (
    !measurement.completed_at ||
    !["matched", "unmatched"].includes(measurement.status)
  ) {
    fail("estimator_measurement_not_complete");
  }
  if (!job.job_number || measurement.job_number !== job.job_number) {
    fail("estimator_measurement_job_mismatch");
  }
  if (
    canonicalJson(input.payload.measurement.native_evidence) !==
    canonicalJson(measurementEvidence?.projection ?? null)
  ) {
    fail("estimator_measurement_evidence_drift");
  }
  assertRevisionTransition(input, head);
  if (input.commercialQuoteRevisionId && !quote) {
    fail("estimator_quote_head_mismatch");
  }
  if (input.facetEventId && !facet) fail("estimator_facet_head_mismatch");
  if (
    facet &&
    (!quote || facet.customer_quote_id !== quote.customer_quote_id)
  ) {
    fail("estimator_facet_quote_mismatch");
  }

  const evidenceRefs = [
    {
      kind: "measurement_intake",
      receipt_id: measurement.receipt_id,
      measurement_id: measurement.measurement_id,
      provider: measurement.provider,
      raw_key: measurement.raw_key,
      sha256: measurement.payload_hash,
    },
    {
      kind: "measurement_delta_ledger",
      ...(measurementEvidence?.projection.delta_ledger as Record<
        string,
        unknown
      >),
    },
    ...(measurementEvidence?.projection.report
      ? [
          {
            kind: "measurement_report",
            ...(measurementEvidence.projection.report as Record<
              string,
              unknown
            >),
          },
        ]
      : []),
    ...(measurementEvidence?.projection.ocr
      ? [
          {
            kind: "measurement_ocr",
            ...(measurementEvidence.projection.ocr as Record<string, unknown>),
          },
        ]
      : []),
    ...(facet
      ? [
          {
            kind: "facet_v2_customer_decision",
            event_id: facet.event_id,
            raw_key: facet.raw_key,
            sha256: facet.raw_sha256,
            design_revision_id: facet.design_revision_id,
            design_revision_sha256: facet.design_revision_sha256,
            frozen_evidence_sha256: facet.frozen_evidence_sha256,
          },
        ]
      : []),
    ...(quote
      ? [
          {
            kind: "commercial_quote_revision",
            quote_revision_id: quote.quote_revision_id,
            customer_quote_id: quote.customer_quote_id,
          },
        ]
      : []),
  ];
  const evidenceRefsJson = canonicalJson(evidenceRefs);
  const evidenceDigest = await sha256Hex(evidenceRefsJson);
  const estimatorRevisionId = `estimator:${await sha256Hex(
    canonicalJson({
      tenant_id: input.tenantId,
      idempotency_key_hash: idempotencyKeyHash,
    }),
  )}`;
  const createdAt = validTimestamp(now);
  const statement = env.DB.prepare(
    `INSERT INTO estimator_evidence_revisions (
       estimator_revision_id, tenant_id, roof_job_id, operating_job_version,
       revision_number, supersedes_estimator_revision_id, measurement_receipt_id,
       measurement_raw_key, measurement_raw_sha256, facet_event_id, facet_raw_key,
       facet_raw_sha256, facet_design_revision_id, facet_design_revision_sha256,
       facet_frozen_evidence_sha256, commercial_quote_revision_id, payload_json,
       payload_sha256, evidence_refs_json, evidence_digest, command_fingerprint,
       idempotency_key_hash, correction_reason, imported_by_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    estimatorRevisionId,
    input.tenantId,
    input.roofJobId,
    input.operatingJobVersion,
    input.revisionNumber,
    input.supersedesEstimatorRevisionId ?? null,
    input.measurementReceiptId,
    measurement.raw_key,
    measurement.payload_hash,
    facet?.event_id ?? null,
    facet?.raw_key ?? null,
    facet?.raw_sha256 ?? null,
    facet?.design_revision_id ?? null,
    facet?.design_revision_sha256 ?? null,
    facet?.frozen_evidence_sha256 ?? null,
    quote?.quote_revision_id ?? null,
    payloadJson,
    payloadSha256,
    evidenceRefsJson,
    evidenceDigest,
    commandFingerprint,
    idempotencyKeyHash,
    input.correctionReason?.trim() || null,
    input.importedByUserId,
    createdAt,
  );
  try {
    await statement.run();
  } catch (error) {
    const concurrent = await revisionByIdempotency(
      env,
      input.tenantId,
      idempotencyKeyHash,
    );
    if (concurrent) {
      if (concurrent.command_fingerprint !== commandFingerprint) {
        fail("estimator_idempotency_conflict");
      }
      return { kind: "replayed", revision: concurrent };
    }
    throw error;
  }
  const revision = await revisionByIdempotency(
    env,
    input.tenantId,
    idempotencyKeyHash,
  );
  if (!revision) fail("estimator_revision_write_failed", 500);
  return { kind: "created", revision };
}

export async function readEstimatorEvidenceHead(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<EstimatorEvidenceHead> {
  if (!env.DB)
    return { state: "missing", revision: null, competing_revision_ids: [] };
  const rows = await allRows<EstimatorEvidenceRevisionRecord>(
    env,
    `SELECT revision.*
       FROM estimator_evidence_revisions AS revision
      WHERE revision.tenant_id = ? AND revision.roof_job_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM estimator_evidence_revisions AS successor
           WHERE successor.tenant_id = revision.tenant_id
             AND successor.roof_job_id = revision.roof_job_id
             AND successor.supersedes_estimator_revision_id = revision.estimator_revision_id
        )
      ORDER BY revision.revision_number DESC, revision.estimator_revision_id ASC
      LIMIT 3`,
    tenantId,
    roofJobId,
  );
  if (rows.length === 0) {
    return { state: "missing", revision: null, competing_revision_ids: [] };
  }
  if (rows.length !== 1) {
    return {
      state: "ambiguous",
      revision: null,
      competing_revision_ids: rows.map((row) => row.estimator_revision_id),
    };
  }
  return { state: "current", revision: rows[0]!, competing_revision_ids: [] };
}

export async function listEstimatorEvidenceRevisions(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  limit = 20,
): Promise<{ rows: EstimatorEvidenceRevisionRecord[]; partial: boolean }> {
  const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
  if (!env.DB) return { rows: [], partial: false };
  const rows = await allRows<EstimatorEvidenceRevisionRecord>(
    env,
    `SELECT * FROM estimator_evidence_revisions
      WHERE tenant_id = ? AND roof_job_id = ?
      ORDER BY revision_number DESC, estimator_revision_id ASC
      LIMIT ?`,
    tenantId,
    roofJobId,
    bounded + 1,
  );
  return { rows: rows.slice(0, bounded), partial: rows.length > bounded };
}

/**
 * Lost-response readback for the governed import route. The raw idempotency key
 * never reaches D1; callers can only recover the immutable revision in their
 * own tenant.
 */
export async function readEstimatorEvidenceRevisionByIdempotencyKey(
  env: AppEnv,
  tenantId: string,
  idempotencyKey: string,
): Promise<EstimatorEvidenceRevisionRecord | null> {
  const bytes = new TextEncoder().encode(idempotencyKey).byteLength;
  if (bytes < 16 || bytes > MAX_IDEMPOTENCY_KEY_BYTES) {
    fail("estimator_idempotency_key_invalid", 400);
  }
  if (!env.DB) return null;
  return await revisionByIdempotency(
    env,
    tenantId,
    await sha256Hex(idempotencyKey),
  );
}

function assertRevisionTransition(
  input: RecordEstimatorEvidenceInput,
  head: EstimatorEvidenceHead,
): void {
  if (head.state === "ambiguous") fail("estimator_revision_head_ambiguous");
  if (head.state === "missing") {
    if (
      input.revisionNumber !== 1 ||
      input.supersedesEstimatorRevisionId ||
      input.correctionReason?.trim()
    ) {
      fail("estimator_initial_revision_invalid");
    }
    return;
  }
  if (
    input.revisionNumber !== Number(head.revision.revision_number) + 1 ||
    input.supersedesEstimatorRevisionId !==
      head.revision.estimator_revision_id ||
    !input.correctionReason?.trim()
  ) {
    fail("estimator_revision_predecessor_mismatch");
  }
}

async function operatingJobAnchor(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<OperatingJobAnchor | null> {
  return await firstRow<OperatingJobAnchor>(
    env,
    `SELECT roof_job_id, job_number, version FROM operating_roof_jobs
      WHERE tenant_id = ? AND roof_job_id = ? LIMIT 1`,
    tenantId,
    roofJobId,
  );
}

async function measurementAnchor(
  env: AppEnv,
  receiptId: string,
): Promise<EstimatorMeasurementAnchor | null> {
  return await firstRow<EstimatorMeasurementAnchor>(
    env,
    `SELECT receipt_id, payload_hash, measurement_id, provider, job_number, raw_key,
            content_type, status, completed_at, report_raw_key, report_sha256,
            report_content_type, ocr_status, ocr_model, ocr_result_key,
            ocr_result_sha256, ocr_job_number_candidate, ocr_job_number_source_ref,
            ocr_review_required, ocr_completed_at
       FROM measurement_intake_receipts WHERE receipt_id = ? LIMIT 1`,
    receiptId,
  );
}

/**
 * Resolve a global intake receipt through its existing tenant-bound, append-only
 * measurement delta ledger. A job-number comparison alone is not a tenant boundary.
 */
export async function readEstimatorMeasurementEvidenceAnchor(
  env: AppEnv,
  tenantId: string,
  receiptId: string,
): Promise<EstimatorMeasurementEvidenceAnchor | null> {
  if (!env.DB) fail("estimator_db_unavailable", 503);
  const receipt = await measurementAnchor(env, receiptId);
  if (!receipt) return null;
  const deltaRows = await allRows<EstimatorMeasurementDeltaRow>(
    env,
    `SELECT id, tenant_id, receipt_id, measurement_id, job_number, provider, source,
            check_name, metric, ok, primary_value, independent_value, rel_diff,
            abs_diff, detail, error_kind, signed_error, created_at
       FROM measurement_deltas WHERE receipt_id = ? ORDER BY id ASC`,
    receiptId,
  );
  if (deltaRows.length === 0) fail("estimator_measurement_delta_missing");
  const tenantIds = [...new Set(deltaRows.map((row) => row.tenant_id))];
  if (tenantIds.length !== 1) fail("estimator_measurement_tenant_ambiguous");
  if (tenantIds[0] !== tenantId) fail("estimator_measurement_tenant_mismatch");
  if (
    deltaRows.some(
      (row) =>
        row.receipt_id !== receipt.receipt_id ||
        row.measurement_id !== receipt.measurement_id ||
        row.job_number !== receipt.job_number ||
        row.provider !== receipt.provider,
    )
  ) {
    fail("estimator_measurement_delta_drift");
  }

  const reportParts = [
    receipt.report_raw_key,
    receipt.report_sha256,
    receipt.report_content_type,
  ];
  if (reportParts.some(Boolean) && !reportParts.every(Boolean)) {
    fail("estimator_measurement_report_anchor_invalid");
  }
  const completedOcr = receipt.ocr_status === "completed";
  if (
    completedOcr &&
    (!receipt.report_sha256 ||
      !receipt.ocr_model ||
      !receipt.ocr_result_key ||
      !receipt.ocr_result_sha256 ||
      !receipt.ocr_completed_at ||
      Number(receipt.ocr_review_required) !== 1)
  ) {
    fail("estimator_measurement_ocr_anchor_invalid");
  }
  if (
    !completedOcr &&
    (receipt.ocr_result_key ||
      receipt.ocr_result_sha256 ||
      receipt.ocr_completed_at)
  ) {
    fail("estimator_measurement_ocr_anchor_invalid");
  }

  const normalizedDeltas = deltaRows.map((row) => ({
    tenant_id: row.tenant_id,
    receipt_id: row.receipt_id,
    measurement_id: row.measurement_id,
    job_number: row.job_number,
    provider: row.provider,
    source: row.source,
    check_name: row.check_name,
    metric: row.metric,
    ok: Number(row.ok) === 1,
    primary_value: row.primary_value,
    independent_value: row.independent_value,
    rel_diff: row.rel_diff,
    abs_diff: row.abs_diff,
    detail: row.detail,
    error_kind: row.error_kind,
    signed_error: row.signed_error,
    created_at: row.created_at,
  }));
  const failedChecks = normalizedDeltas
    .filter((row) => !row.ok)
    .map((row) => ({
      source: row.source,
      check_name: row.check_name,
      metric: row.metric,
    }));
  const projection = {
    delta_ledger: {
      tenant_id: tenantId,
      receipt_id: receipt.receipt_id,
      row_count: normalizedDeltas.length,
      sha256: await sha256Hex(canonicalJson(normalizedDeltas)),
      all_checks_pass: failedChecks.length === 0,
      failed_checks: failedChecks,
    },
    report: receipt.report_raw_key
      ? {
          raw_key: receipt.report_raw_key,
          sha256: receipt.report_sha256,
          content_type: receipt.report_content_type,
        }
      : null,
    ocr: completedOcr
      ? {
          status: receipt.ocr_status,
          model: receipt.ocr_model,
          result_key: receipt.ocr_result_key,
          result_sha256: receipt.ocr_result_sha256,
          report_sha256: receipt.report_sha256,
          job_number_candidate: receipt.ocr_job_number_candidate,
          job_number_source_ref: receipt.ocr_job_number_source_ref,
          review_required: true,
          completed_at: receipt.ocr_completed_at,
        }
      : {
          status: receipt.ocr_status,
          review_required: Number(receipt.ocr_review_required) === 1,
        },
  } as const;
  return { receipt, deltaRows, projection };
}

export async function readCurrentEstimatorCommercialQuoteAnchor(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  quoteRevisionId: string,
  asOf = new Date(),
): Promise<EstimatorCommercialQuoteAnchor | null> {
  const row = await firstRow<EstimatorCommercialQuoteAnchor>(
    env,
    `SELECT quote.quote_revision_id, quote.customer_quote_id, quote.roof_job_id,
            quote.status, quote.valid_until,
            (SELECT COUNT(*) FROM commercial_quote_revisions AS successor
              WHERE successor.tenant_id = quote.tenant_id
                AND successor.supersedes_quote_revision_id = quote.quote_revision_id) AS successor_count,
            (SELECT COUNT(*) FROM commercial_quote_revisions AS candidate
              WHERE candidate.tenant_id = quote.tenant_id
                AND candidate.roof_job_id = quote.roof_job_id
                AND candidate.status = 'approved'
                AND candidate.valid_until >= ?
                AND NOT EXISTS (
                  SELECT 1 FROM commercial_quote_revisions AS candidate_successor
                   WHERE candidate_successor.tenant_id = candidate.tenant_id
                     AND candidate_successor.supersedes_quote_revision_id = candidate.quote_revision_id
                )) AS terminal_approved_count
       FROM commercial_quote_revisions AS quote
      WHERE quote.tenant_id = ? AND quote.roof_job_id = ?
        AND quote.quote_revision_id = ? LIMIT 1`,
    asOf.toISOString().slice(0, 10),
    tenantId,
    roofJobId,
    quoteRevisionId,
  );
  return row &&
    ["approved"].includes(row.status) &&
    row.valid_until >= asOf.toISOString().slice(0, 10) &&
    Number(row.successor_count) === 0 &&
    Number(row.terminal_approved_count) === 1
    ? row
    : null;
}

async function facetAnchor(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  eventId: string,
): Promise<FacetAnchor | null> {
  const row = await firstRow<FacetAnchor>(
    env,
    `SELECT decision.event_id, decision.destination_tenant_id, decision.roof_job_id,
            decision.customer_quote_id, decision.decision_kind, decision.raw_key,
            decision.raw_sha256, decision.design_revision_id,
            decision.design_revision_sha256, decision.frozen_evidence_sha256,
            decision.external_project_link_id, decision.producer_identity_link_id,
            decision.external_customer_identity_link_id, decision.association_sha256,
            project.destination_tenant_id AS linked_destination_tenant_id,
            project.roof_job_id AS linked_roof_job_id,
            project.customer_quote_id AS linked_customer_quote_id,
            project.producer_identity_link_id AS linked_producer_identity_link_id,
            project.external_customer_identity_link_id AS linked_external_customer_identity_link_id,
            project.association_sha256 AS linked_association_sha256,
            (SELECT COUNT(*) FROM facet_v2_customer_decisions AS successor
              WHERE successor.previous_event_id = decision.event_id) AS successor_count,
            (SELECT COUNT(*) FROM facet_v2_link_revocations AS revoked
              WHERE (revoked.link_kind = 'project'
                     AND revoked.link_id = decision.external_project_link_id)
                 OR (revoked.link_kind = 'producer_identity'
                     AND revoked.link_id = decision.producer_identity_link_id)
                 OR (revoked.link_kind = 'customer_identity'
                     AND revoked.link_id = decision.external_customer_identity_link_id)) AS revocation_count
       FROM facet_v2_customer_decisions AS decision
       LEFT JOIN facet_v2_project_links AS project
         ON project.external_project_link_id = decision.external_project_link_id
      WHERE decision.event_id = ? AND decision.destination_tenant_id = ?
        AND decision.roof_job_id = ? LIMIT 1`,
    eventId,
    tenantId,
    roofJobId,
  );
  if (!row) return null;
  const exact =
    ["approved", "corrected"].includes(row.decision_kind) &&
    Number(row.successor_count) === 0 &&
    Number(row.revocation_count) === 0 &&
    row.linked_destination_tenant_id === row.destination_tenant_id &&
    row.linked_roof_job_id === row.roof_job_id &&
    row.linked_customer_quote_id === row.customer_quote_id &&
    row.linked_producer_identity_link_id === row.producer_identity_link_id &&
    row.linked_external_customer_identity_link_id ===
      row.external_customer_identity_link_id &&
    row.linked_association_sha256 === row.association_sha256;
  return exact ? row : null;
}

async function revisionByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyKeyHash: string,
): Promise<EstimatorEvidenceRevisionRecord | null> {
  return await firstRow<EstimatorEvidenceRevisionRecord>(
    env,
    `SELECT * FROM estimator_evidence_revisions
      WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
    tenantId,
    idempotencyKeyHash,
  );
}

async function firstRow<T>(
  env: AppEnv,
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  const statement = env.DB.prepare(sql).bind(...args) as {
    first?: <U>() => Promise<U | null>;
    all?: <U>() => Promise<{ results?: U[] }>;
  };
  if (typeof statement.first === "function") return await statement.first<T>();
  if (typeof statement.all === "function") {
    const result = await statement.all<T>();
    return result.results?.[0] ?? null;
  }
  return null;
}

async function allRows<T>(
  env: AppEnv,
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  const result = await env.DB.prepare(sql)
    .bind(...args)
    .all<T>();
  return result.results ?? [];
}

function normalizedPayloadJson(payload: EstimatorEvidencePayloadV1): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("estimator_payload_invalid", 400);
  }
  const keys = Object.keys(payload).sort();
  const expected = [
    "insurance_supplements",
    "measurement",
    "pricing_authority",
    "schema_version",
    "scope_changes",
    "scope_clauses",
    "takeoff",
    "visual_model",
  ].sort();
  if (keys.join("\u0000") !== expected.join("\u0000")) {
    fail("estimator_payload_shape_invalid", 400);
  }
  if (
    payload.schema_version !== ESTIMATOR_EVIDENCE_SCHEMA_VERSION ||
    !plainRecord(payload.measurement) ||
    (payload.visual_model !== null && !plainRecord(payload.visual_model)) ||
    !plainRecord(payload.takeoff) ||
    !Array.isArray(payload.scope_changes) ||
    !payload.scope_changes.every(plainRecord) ||
    !Array.isArray(payload.insurance_supplements) ||
    !payload.insurance_supplements.every(plainRecord) ||
    !Array.isArray(payload.scope_clauses) ||
    !payload.scope_clauses.every(plainRecord) ||
    (payload.pricing_authority !== null &&
      !plainRecord(payload.pricing_authority))
  ) {
    fail("estimator_payload_shape_invalid", 400);
  }
  const canonical = canonicalJson(payload);
  if (new TextEncoder().encode(canonical).byteLength > MAX_PAYLOAD_BYTES) {
    fail("estimator_payload_too_large", 413);
  }
  return canonical;
}

function validateInput(input: RecordEstimatorEvidenceInput): void {
  boundedIdentifier(
    input.tenantId,
    2,
    64,
    "estimator_tenant_invalid",
    /^[a-z0-9-]+$/,
  );
  boundedIdentifier(input.roofJobId, 1, 200, "estimator_job_invalid");
  boundedIdentifier(
    input.measurementReceiptId,
    20,
    120,
    "estimator_measurement_invalid",
  );
  boundedIdentifier(input.importedByUserId, 3, 160, "estimator_actor_invalid");
  if (
    !Number.isSafeInteger(input.operatingJobVersion) ||
    input.operatingJobVersion < 1
  ) {
    fail("estimator_job_version_invalid", 400);
  }
  if (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1) {
    fail("estimator_revision_number_invalid", 400);
  }
  if (input.facetEventId)
    boundedIdentifier(
      input.facetEventId,
      8,
      200,
      "estimator_facet_event_invalid",
    );
  if (input.commercialQuoteRevisionId) {
    boundedIdentifier(
      input.commercialQuoteRevisionId,
      8,
      200,
      "estimator_quote_invalid",
    );
  }
  const idempotencyBytes = new TextEncoder().encode(
    input.idempotencyKey,
  ).byteLength;
  if (idempotencyBytes < 16 || idempotencyBytes > MAX_IDEMPOTENCY_KEY_BYTES) {
    fail("estimator_idempotency_key_invalid", 400);
  }
}

function boundedIdentifier(
  value: string,
  min: number,
  max: number,
  code: string,
  pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
): void {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    !pattern.test(value)
  ) {
    fail(code, 400);
  }
}

function plainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) fail("estimator_timestamp_invalid", 400);
  return now.toISOString();
}

function fail(code: string, status = 409): never {
  throw new EstimatorNativeStoreError(code, status);
}
