import { randomToken, sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";
import {
  assertEffectLedgerReady,
  adapterAuthority,
  runExternalEffect,
} from "./effect-runtime.ts";
import { canonicalJson } from "./facet-design-v2-protocol.ts";
import { frappeBaseUrl, frappeRequestTimeout } from "./frappe-read.ts";

const MAX_FRAPPE_RESPONSE_BYTES = 64 * 1024;
const PROJECTION_BATCH_SIZE = 25;
const PROJECTION_METHOD =
  "ironwrap_roofing.facet_design_projection_api.record_facet_design_proposal_evidence";
const PROJECTION_PATH = `/api/method/${PROJECTION_METHOD}`;
const RECEIPT_SCHEMA = "ironwrap.facet-design-projection-receipt.v2";
const RECEIPT_SIGNATURE_CONTEXT = "ironwrap.facet-design-projection.receipt.v2";
const RESPONSE_KEYS = [
  "draft_customer_quote_id",
  "draft_quote_version",
  "event_id",
  "evidence_id",
  "idempotent_replay",
  "receipt",
  "receipt_sha256",
  "receipt_signature",
  "receipt_signature_algorithm",
  "reconciliation_id",
] as const;
const RECEIPT_KEYS = [
  "actor_identity_assurance",
  "approval_receipt_sha256",
  "association_sha256",
  "blank_commercial_revision",
  "claim_sha256",
  "customer_safe",
  "decision_kind",
  "design_revision_id",
  "design_revision_sha256",
  "destination_tenant_id",
  "draft_customer_quote_id",
  "draft_quote_status",
  "draft_quote_version",
  "event_id",
  "event_type",
  "evidence_id",
  "facet_project_id",
  "frozen_evidence_sha256",
  "idempotent_replay",
  "occurred_at",
  "raw_content_length",
  "raw_key",
  "raw_sha256",
  "received_at",
  "reconciliation_id",
  "roof_job_id",
  "schema",
  "schema_version",
  "source_customer_quote_id",
] as const;
const BLANK_QUOTE_READBACK_FIELDS = [
  "price_book_version",
  "pricing_effective_at",
  "price_rule_snapshot_json",
  "subtotal",
  "tax_amount",
  "tax_code",
  "tax_rate",
  "tax_policy_snapshot_json",
  "quote_total",
  "currency",
  "deposit_amount",
  "amount_due",
  "amount_paid",
  "balance_due",
  "payment_status",
  "payment_due_date",
  "payment_truth_source",
  "payment_truth_at",
  "qb_item_ref",
  "qb_tax_code_ref",
  "qb_terms_ref",
  "qb_terms_due_days",
  "valid_until",
  "approved_by",
  "approved_at",
  "acceptance_evidence",
  "contract_acceptance",
  "accepted_at",
  "scope_summary",
  "assumptions",
  "exclusions",
  "quote_summary_json",
  "notes",
] as const;

type DecisionKind = "approved" | "corrected" | "superseded" | "withdrawn";
type ProjectionOutcome =
  | "projected_blank_draft"
  | "projected_terminal_hold"
  | "reconciled"
  | "rejected_frappe"
  | "uncertain"
  | "held_withdrawn"
  | "held_superseded";

interface StoredFacetV2Decision {
  event_id: string;
  event_type: "facet.design.customer_approved.v2";
  schema_version: 2;
  issuer: string;
  source_product: "facet";
  source_environment: string;
  source_tenant_id: string;
  destination_tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  external_project_link_id: string;
  producer_identity_link_id: string;
  association_sha256: string;
  roof_job_id: string;
  customer_quote_id: string;
  customer_party_ref: string;
  external_customer_identity_link_id: string;
  oidc_issuer: string;
  oidc_subject_sha256: string;
  identity_assurance: "oidc";
  decision_kind: DecisionKind;
  previous_event_id: string | null;
  reason_sha256: string | null;
  approval_receipt_id: string;
  approval_receipt_sha256: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  raw_key: string;
  raw_sha256: string;
  raw_content_length: number;
  occurred_at: string;
  received_at: string;
  linked_external_project_link_id: string | null;
  linked_producer_identity_link_id: string | null;
  linked_destination_tenant_id: string | null;
  linked_source_tenant_id: string | null;
  linked_brand_id: string | null;
  linked_facet_project_id: string | null;
  linked_customer_party_ref: string | null;
  linked_external_customer_identity_link_id: string | null;
  linked_roof_job_id: string | null;
  linked_customer_quote_id: string | null;
  linked_association_sha256: string | null;
  linked_issuer: string | null;
  linked_source_product: string | null;
  linked_source_environment: string | null;
  revoked_link_count: number;
}

interface ProjectionSettings {
  hmacKey: string;
  frappeApiKey: string;
  frappeApiSecret: string;
}

interface FacetV2ProjectionClaim {
  approval_receipt_id: string;
  approval_receipt_sha256: string;
  association_sha256: string;
  brand_id: string;
  customer_party_ref: string;
  customer_quote_id: string;
  decision_kind: DecisionKind;
  design_revision_id: string;
  design_revision_sha256: string;
  destination_tenant_id: string;
  event_id: string;
  event_type: "facet.design.customer_approved.v2";
  external_customer_identity_link_id: string;
  external_project_link_id: string;
  facet_project_id: string;
  frozen_evidence_sha256: string;
  identity_assurance: "oidc";
  occurred_at: string;
  oidc_issuer: string;
  oidc_subject_sha256: string;
  previous_event_id: string | null;
  producer_identity_link_id: string;
  raw_content_length: number;
  raw_key: string;
  raw_sha256: string;
  reason_sha256: string | null;
  received_at: string;
  roof_job_id: string;
  schema_version: 2;
  source_environment: string;
  source_issuer: string;
  source_tenant_id: string;
}

interface ProjectionResult {
  evidenceId: string;
  reconciliationId: string;
  draftCustomerQuoteId: string;
  draftQuoteVersion: number;
  idempotentReplay: boolean;
}

interface FrappeResourceRead {
  status: "ok" | "conflict" | "unavailable" | "not_found";
  data?: Record<string, unknown>;
  detailCode?: string;
}

class FrappeProjectionHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`facet_design_projection_frappe_http_${status}`);
    this.status = status;
  }
}

class FrappeProjectionTransportError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Project only an immutable, associated, OIDC-assured v2 decision chain head. */
export async function reconcileFacetDesignFrappeProjections(
  env: Env,
  now = new Date(),
): Promise<void> {
  if (String(env.FACET_V2_FRAPPE_PROJECTION_ENABLED) !== "true") return;
  const settings = projectionSettings(env);
  if (!settings) throw new Error("facet_v2_projection_not_configured");
  for (const event of await listProjectionCandidates(env)) {
    await reconcileOneProjection(env, settings, event, now);
  }
}

async function reconcileOneProjection(
  env: Env,
  settings: ProjectionSettings,
  event: StoredFacetV2Decision,
  now: Date,
): Promise<void> {
  if (!(await exactAuthorityStillMatches(event))) {
    await appendOutcome(env, event, {
      outcome: "rejected_frappe",
      errorCode: "facet_v2_authority_drift",
      now,
    });
    return;
  }
  try {
    const projected = await projectToFrappe(env, settings, event);
    await appendOutcome(env, event, {
      outcome: projected.idempotentReplay
        ? "reconciled"
        : event.decision_kind === "approved" ||
            event.decision_kind === "corrected"
          ? "projected_blank_draft"
          : "projected_terminal_hold",
      evidenceId: projected.evidenceId,
      reconciliationId: projected.reconciliationId,
      draftCustomerQuoteId: projected.draftCustomerQuoteId,
      draftQuoteVersion: projected.draftQuoteVersion,
      now,
    });
  } catch (error) {
    await appendOutcome(env, event, {
      outcome: projectionFailureOutcome(error),
      errorCode: errorCode(error),
      now,
    });
  }
}

async function listProjectionCandidates(
  env: Env,
): Promise<StoredFacetV2Decision[]> {
  const result = await env.DB.prepare(
    `SELECT decision.*,
            project.external_project_link_id AS linked_external_project_link_id,
            project.producer_identity_link_id AS linked_producer_identity_link_id,
            project.destination_tenant_id AS linked_destination_tenant_id,
            project.source_tenant_id AS linked_source_tenant_id,
            project.brand_id AS linked_brand_id,
            project.facet_project_id AS linked_facet_project_id,
            project.customer_party_ref AS linked_customer_party_ref,
            project.external_customer_identity_link_id AS linked_external_customer_identity_link_id,
            project.roof_job_id AS linked_roof_job_id,
            project.customer_quote_id AS linked_customer_quote_id,
            project.association_sha256 AS linked_association_sha256,
            identity.issuer AS linked_issuer,
            identity.source_product AS linked_source_product,
            identity.source_environment AS linked_source_environment,
            (SELECT COUNT(*) FROM facet_v2_link_revocations AS revoked
              WHERE (revoked.link_kind = 'project' AND revoked.link_id = decision.external_project_link_id)
                 OR (revoked.link_kind = 'producer_identity' AND revoked.link_id = decision.producer_identity_link_id)
                 OR (revoked.link_kind = 'customer_identity'
                     AND revoked.link_id = decision.external_customer_identity_link_id)) AS revoked_link_count
       FROM facet_v2_customer_decisions AS decision
       LEFT JOIN facet_v2_project_links AS project
         ON project.external_project_link_id = decision.external_project_link_id
       LEFT JOIN facet_v2_producer_identity_links AS identity
         ON identity.producer_identity_link_id = decision.producer_identity_link_id
       WHERE NOT EXISTS (
         SELECT 1 FROM facet_v2_customer_decisions AS child
         WHERE child.previous_event_id = decision.event_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM facet_v2_projection_attempts AS attempt
         WHERE attempt.event_id = decision.event_id
           AND attempt.outcome IN ('projected_blank_draft', 'projected_terminal_hold',
                                   'reconciled', 'rejected_frappe',
                                   'held_withdrawn', 'held_superseded')
       )
       ORDER BY decision.occurred_at ASC, decision.event_id ASC
       LIMIT ?`,
  )
    .bind(PROJECTION_BATCH_SIZE)
    .all<StoredFacetV2Decision>();
  return result.results ?? [];
}

async function exactAuthorityStillMatches(
  event: StoredFacetV2Decision,
): Promise<boolean> {
  const expectedAssociation = await sha256Hex(
    canonicalJson({
      brand_id: event.brand_id,
      customer_party_ref: event.customer_party_ref,
      customer_quote_id: event.customer_quote_id,
      destination_tenant_id: event.destination_tenant_id,
      external_customer_identity_link_id:
        event.external_customer_identity_link_id,
      external_project_link_id: event.external_project_link_id,
      facet_project_id: event.facet_project_id,
      producer_identity_link_id: event.producer_identity_link_id,
      roof_job_id: event.roof_job_id,
      source_tenant_id: event.source_tenant_id,
    }),
  );
  return (
    Number(event.revoked_link_count) === 0 &&
    event.identity_assurance === "oidc" &&
    event.linked_external_project_link_id === event.external_project_link_id &&
    event.linked_producer_identity_link_id ===
      event.producer_identity_link_id &&
    event.linked_destination_tenant_id === event.destination_tenant_id &&
    event.linked_source_tenant_id === event.source_tenant_id &&
    event.linked_brand_id === event.brand_id &&
    event.linked_facet_project_id === event.facet_project_id &&
    event.linked_customer_party_ref === event.customer_party_ref &&
    event.linked_external_customer_identity_link_id ===
      event.external_customer_identity_link_id &&
    event.linked_roof_job_id === event.roof_job_id &&
    event.linked_customer_quote_id === event.customer_quote_id &&
    event.linked_association_sha256 === event.association_sha256 &&
    event.linked_issuer === event.issuer &&
    event.linked_source_product === "facet" &&
    event.linked_source_environment === event.source_environment &&
    expectedAssociation === event.association_sha256
  );
}

async function appendOutcome(
  env: Env,
  event: StoredFacetV2Decision,
  input: {
    outcome: ProjectionOutcome;
    evidenceId?: string;
    reconciliationId?: string;
    draftCustomerQuoteId?: string;
    draftQuoteVersion?: number;
    errorCode?: string;
    now: Date;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO facet_v2_projection_attempts
     (attempt_id, event_id, outcome, evidence_id, reconciliation_id,
      draft_customer_quote_id, draft_quote_version, error_code, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `facet-v2-projection:${crypto.randomUUID()}`,
      event.event_id,
      input.outcome,
      input.evidenceId ?? null,
      input.reconciliationId ?? null,
      input.draftCustomerQuoteId ?? null,
      input.draftQuoteVersion ?? null,
      input.errorCode ?? null,
      input.now.toISOString(),
    )
    .run();
}

async function projectToFrappe(
  env: Env,
  settings: ProjectionSettings,
  event: StoredFacetV2Decision,
): Promise<ProjectionResult> {
  const claim: FacetV2ProjectionClaim = {
    approval_receipt_id: event.approval_receipt_id,
    approval_receipt_sha256: event.approval_receipt_sha256,
    association_sha256: event.association_sha256,
    brand_id: event.brand_id,
    customer_party_ref: event.customer_party_ref,
    customer_quote_id: event.customer_quote_id,
    decision_kind: event.decision_kind,
    design_revision_id: event.design_revision_id,
    design_revision_sha256: event.design_revision_sha256,
    destination_tenant_id: event.destination_tenant_id,
    event_id: event.event_id,
    event_type: event.event_type,
    external_customer_identity_link_id:
      event.external_customer_identity_link_id,
    external_project_link_id: event.external_project_link_id,
    facet_project_id: event.facet_project_id,
    frozen_evidence_sha256: event.frozen_evidence_sha256,
    identity_assurance: event.identity_assurance,
    occurred_at: event.occurred_at,
    oidc_issuer: event.oidc_issuer,
    oidc_subject_sha256: event.oidc_subject_sha256,
    previous_event_id: event.previous_event_id,
    producer_identity_link_id: event.producer_identity_link_id,
    raw_content_length: Number(event.raw_content_length),
    raw_key: event.raw_key,
    raw_sha256: event.raw_sha256,
    reason_sha256: event.reason_sha256,
    received_at: event.received_at,
    roof_job_id: event.roof_job_id,
    schema_version: event.schema_version,
    source_environment: event.source_environment,
    source_issuer: event.issuer,
    source_tenant_id: event.source_tenant_id,
  };
  const claimJson = canonicalJson(claim);
  const eventHash = await sha256Hex(claim.event_id);
  const draftCustomerQuoteId = await projectionTargetQuoteId(claim);
  const request = { claimJson };
  const requestHash = await sha256Hex(canonicalJson(request));
  const appEnv = env as AppEnv;
  assertEffectLedgerReady(appEnv);
  const idempotencyKey = `facet-v2-projection:${eventHash}`;
  const deadlineAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const result = await runExternalEffect(
    appEnv,
    {
      tenantId: claim.destination_tenant_id,
      actor: { type: "agent", id: "facet-v2-projection" },
      taskId: `facet-v2-projection:${claim.event_id}`,
      authority: adapterAuthority({
        tenantId: claim.destination_tenant_id,
        provider: "frappe",
        action: "facet.design.v2.projection",
        actorId: "facet-v2-projection",
        deadlineAt,
        retryLimit: 1,
      }),
      aggregate: {
        type: "facet_v2_customer_decision",
        id: claim.event_id,
        version: 2,
      },
      intentId: idempotencyKey,
      action: "facet.design.v2.projection",
      request,
      requestHash,
      provider: "frappe",
      idempotencyKey,
      deadlineAt,
      expectedReadback: {
        local_name: draftCustomerQuoteId,
        reconciliation_id: `facet-design-projection:${eventHash}`,
      },
      retryLimit: 1,
      compensationPlan: {},
      correlationId: idempotencyKey,
    },
    {
      async dispatch() {
        try {
          const value = await projectToFrappeDirect(
            env,
            settings,
            claim,
            claimJson,
          );
          return {
            outcome: "accepted" as const,
            value,
            providerExternalId: value.reconciliationId,
            providerResponse: value,
          };
        } catch (error) {
          if (
            error instanceof FrappeProjectionHttpError &&
            error.status === 409
          ) {
            return {
              outcome: "rejected" as const,
              detailCode: "frappe_http_409",
            };
          }
          if (!(error instanceof FrappeProjectionTransportError)) throw error;
          // The reconciliation id is deterministic. A response can be lost
          // after Frappe commits, so prove the complete immutable trio before
          // settling the effect. Never issue a second POST at this boundary.
          const providerExternalId = `facet-design-projection:${eventHash}`;
          const readback = await facetProjectionReadback(
            env,
            settings,
            providerExternalId,
            claim,
          );
          if (readback.status === "match") {
            const value = projectionResultFromMatchedReadback(
              readback.observed,
            );
            return {
              outcome: "accepted" as const,
              value,
              providerExternalId,
              readback,
              detailCode:
                "frappe_projection_response_recovered_by_exact_readback",
            };
          }
          return {
            outcome: "unknown" as const,
            providerExternalId,
            readback,
            detailCode: error.code,
          };
        }
      },
      async readback({ providerExternalId }) {
        return await facetProjectionReadback(
          env,
          settings,
          providerExternalId,
          claim,
        );
      },
      async replay({ effect }) {
        return await replayProjectionResult(
          env,
          settings,
          claim,
          effect.provider_external_id,
        );
      },
    },
  );
  if (result.effect.state !== "succeeded" || result.value === undefined) {
    if (result.effect.result_code === "frappe_http_409") {
      throw new FrappeProjectionHttpError(409);
    }
    throw new FrappeProjectionTransportError(
      result.effect.result_code ?? "frappe_projection_effect_not_succeeded",
    );
  }
  return result.value;
}

async function projectToFrappeDirect(
  env: Env,
  settings: ProjectionSettings,
  claim: FacetV2ProjectionClaim,
  claimJson: string,
): Promise<ProjectionResult> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = randomToken();
  const signature = await hmacBase64Url(
    settings.hmacKey,
    `POST\n${PROJECTION_PATH}\n${timestamp}\n${nonce}\n${await sha256Hex(claimJson)}`,
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    frappeRequestTimeout((env as AppEnv).APP_FRAPPE_REQUEST_TIMEOUT_MS),
  );
  try {
    const response = await fetch(
      `${frappeBaseUrl(env as AppEnv)}${PROJECTION_PATH}`,
      {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: `token ${settings.frappeApiKey}:${settings.frappeApiSecret}`,
          "content-type": "application/json",
          "user-agent": "ironwrap-facet-v2-projection/2.0",
          "x-ironwrap-facet-projection-timestamp": timestamp,
          "x-ironwrap-facet-projection-nonce": nonce,
          "x-ironwrap-facet-projection-signature": signature,
        },
        body: JSON.stringify({ facet_claim_json: claimJson }),
      },
    );
    if (!response.ok) throw new FrappeProjectionHttpError(response.status);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_FRAPPE_RESPONSE_BYTES)
      throw new FrappeProjectionTransportError(
        "frappe_projection_response_too_large",
      );
    const raw = await response.text();
    if (raw.length > MAX_FRAPPE_RESPONSE_BYTES)
      throw new FrappeProjectionTransportError(
        "frappe_projection_response_too_large",
      );
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      throw new FrappeProjectionTransportError(
        "frappe_projection_response_invalid_json",
      );
    }
    return await validatedProjectionResponse(
      decoded,
      claim,
      claimJson,
      settings.hmacKey,
    );
  } catch (error) {
    if (
      error instanceof FrappeProjectionHttpError ||
      error instanceof FrappeProjectionTransportError
    )
      throw error;
    if (error instanceof Error && error.name === "AbortError")
      throw new FrappeProjectionTransportError(
        "frappe_projection_request_timeout",
      );
    throw new FrappeProjectionTransportError(
      "frappe_projection_request_network_error",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function facetProjectionReadback(
  env: Env,
  settings: ProjectionSettings,
  providerExternalId: string | null,
  claim: FacetV2ProjectionClaim,
): Promise<{
  status: "match" | "conflict" | "unavailable" | "not_found";
  providerExternalId?: string;
  observed?: unknown;
  detailCode?: string;
}> {
  if (!providerExternalId) {
    return {
      status: "unavailable",
      detailCode: "facet_projection_readback_id_missing",
    };
  }
  const eventHash = await sha256Hex(claim.event_id);
  const expectedReconciliationId = `facet-design-projection:${eventHash}`;
  const expectedEvidenceId = `facet-design:${eventHash}`;
  const expectedDraftCustomerQuoteId = await projectionTargetQuoteId(claim);
  if (providerExternalId !== expectedReconciliationId) {
    return {
      status: "conflict",
      detailCode: "facet_projection_readback_identity_mismatch",
    };
  }
  const [reconciliationResult, evidenceResult, draftResult] = await Promise.all(
    [
      readFrappeResource(
        env,
        settings,
        "Integration Reconciliation",
        providerExternalId,
      ),
      readFrappeResource(env, settings, "Evidence Item", expectedEvidenceId),
      readFrappeResource(
        env,
        settings,
        "Customer Quote",
        expectedDraftCustomerQuoteId,
      ),
    ],
  );
  const results = [reconciliationResult, evidenceResult, draftResult];
  const unavailable = results.find((result) => result.status === "unavailable");
  if (unavailable)
    return { status: "unavailable", detailCode: unavailable.detailCode };
  const missing = results.find((result) => result.status === "not_found");
  if (missing) return { status: "not_found", detailCode: missing.detailCode };
  if (results.some((result) => result.status !== "ok")) {
    return {
      status: "conflict",
      detailCode: "facet_projection_readback_invalid_shape",
    };
  }
  if (
    reconciliationResult.status !== "ok" ||
    evidenceResult.status !== "ok" ||
    draftResult.status !== "ok"
  )
    return {
      status: "conflict",
      detailCode: "facet_projection_readback_invalid_shape",
    };
  const reconciliation = reconciliationResult.data!;
  const evidence = evidenceResult.data!;
  const draft = draftResult.data!;
  const activeDecision =
    claim.decision_kind === "approved" || claim.decision_kind === "corrected";
  const previousDraftCustomerQuoteId = claim.previous_event_id
    ? `facet-quote-revision:${await sha256Hex(claim.previous_event_id)}`
    : null;
  const expectedDiff = {
    association_sha256: claim.association_sha256,
    blank_commercial_revision: activeDecision,
    customer_party_ref: claim.customer_party_ref,
    customer_safe: false,
    decision_kind: claim.decision_kind,
    destination_tenant_id: claim.destination_tenant_id,
    draft_customer_quote_id: expectedDraftCustomerQuoteId,
    event_id: claim.event_id,
    external_customer_identity_link_id:
      claim.external_customer_identity_link_id,
    external_project_link_id: claim.external_project_link_id,
    facet_project_id: claim.facet_project_id,
    identity_assurance: "oidc",
    oidc_issuer: claim.oidc_issuer,
    oidc_subject_sha256: claim.oidc_subject_sha256,
    previous_draft_customer_quote_id: previousDraftCustomerQuoteId,
    previous_event_id: claim.previous_event_id,
    producer_identity_link_id: claim.producer_identity_link_id,
    schema: "ironwrap.facet-design-projection.v2",
    source_tenant_id: claim.source_tenant_id,
    state: activeDecision
      ? "pending_estimator_rebuild"
      : claim.decision_kind === "withdrawn"
        ? "customer_withdrew_design"
        : "customer_superseded_design",
  };
  const diff = parseCanonicalRecord(reconciliation.diff_json);
  const roofJob =
    typeof draft.roof_job === "string" && draft.roof_job
      ? draft.roof_job
      : null;
  const expectedLocalPayloadHash = roofJob
    ? await sha256Hex(
        canonicalJson({
          association_sha256: claim.association_sha256,
          draft_customer_quote_id: expectedDraftCustomerQuoteId,
          event_id: claim.event_id,
          roof_job: roofJob,
          source_customer_quote_id: claim.customer_quote_id,
        }),
      )
    : null;
  const observedReconciliationId =
    typeof reconciliation.reconciliation_id === "string"
      ? reconciliation.reconciliation_id
      : reconciliation.name;
  const expectedSupersedes = claim.previous_event_id
    ? `facet-design-projection:${await sha256Hex(claim.previous_event_id)}`
    : null;
  const expectedCorrectionReason = claim.reason_sha256
    ? `Facet ${claim.decision_kind} reason SHA-256: ${claim.reason_sha256}`
    : null;
  const draftIsExact =
    draft.customer_quote_id === expectedDraftCustomerQuoteId &&
    draft.status === (activeDecision ? "Draft" : "Rejected") &&
    positiveInteger(draft.quote_version) &&
    roofJob !== null &&
    typeof draft.customer === "string" &&
    !!draft.customer &&
    (!activeDecision ||
      (draft.correction_reason ===
        `Facet customer decision ${claim.event_id} requires estimator rebuild from current evidence.` &&
        typeof draft.supersedes === "string" &&
        !!draft.supersedes &&
        BLANK_QUOTE_READBACK_FIELDS.every((field) =>
          blankFrappeValue(draft[field]),
        )));
  const evidenceIsExact =
    evidence.evidence_id === expectedEvidenceId &&
    evidence.device_action_id === `facet-v2-projection:${eventHash}` &&
    evidence.roof_job === roofJob &&
    evidence.evidence_type === "Other" &&
    evidence.proof_slot === "Estimate" &&
    evidence.source_system === "ironwrap-facet-design" &&
    evidence.r2_key === claim.raw_key &&
    evidence.content_checksum === claim.raw_sha256 &&
    evidence.checksum_algorithm === "SHA-256" &&
    evidence.content_type === "application/json" &&
    Number(evidence.content_length) === claim.raw_content_length &&
    evidence.sync_state === "Verified" &&
    evidence.verification_source ===
      "ironwrap-worker-r2-facet-design-projection" &&
    (evidence.customer_safe === 0 ||
      evidence.customer_safe === false ||
      evidence.customer_safe === "0");
  const reconciliationIsExact =
    observedReconciliationId === expectedReconciliationId &&
    reconciliation.roof_job === roofJob &&
    reconciliation.system_name === "Facet" &&
    reconciliation.entity_type === "Design Revision" &&
    reconciliation.external_entity_id === `facet-event:${eventHash}` &&
    reconciliation.local_doctype === "Customer Quote" &&
    reconciliation.local_name === expectedDraftCustomerQuoteId &&
    reconciliation.direction === "Inbound" &&
    reconciliation.status === (activeDecision ? "Pending" : "Superseded") &&
    reconciliation.raw_key === claim.raw_key &&
    reconciliation.source_version === claim.design_revision_id &&
    reconciliation.source_payload_hash === claim.frozen_evidence_sha256 &&
    reconciliation.local_payload_hash === expectedLocalPayloadHash &&
    blankEquivalent(reconciliation.supersedes, expectedSupersedes) &&
    blankEquivalent(
      reconciliation.correction_reason,
      expectedCorrectionReason,
    ) &&
    diff !== null &&
    canonicalJson(diff) === canonicalJson(expectedDiff);
  if (!draftIsExact || !evidenceIsExact || !reconciliationIsExact) {
    return {
      status: "conflict",
      providerExternalId,
      observed: { draft, evidence, reconciliation },
      detailCode: "facet_projection_readback_conflict",
    };
  }
  return {
    status: "match",
    providerExternalId,
    observed: {
      draft_customer_quote_id: expectedDraftCustomerQuoteId,
      draft_quote_version: draft.quote_version,
      evidence_id: expectedEvidenceId,
      local_name: expectedDraftCustomerQuoteId,
      reconciliation_id: expectedReconciliationId,
    },
  };
}

async function replayProjectionResult(
  env: Env,
  settings: ProjectionSettings,
  claim: FacetV2ProjectionClaim,
  providerExternalId: string | null,
): Promise<ProjectionResult> {
  const eventHash = await sha256Hex(claim.event_id);
  const evidenceId = `facet-design:${eventHash}`;
  const reconciliationId = `facet-design-projection:${eventHash}`;
  const draftCustomerQuoteId = await projectionTargetQuoteId(claim);
  if (providerExternalId !== reconciliationId) {
    throw new FrappeProjectionTransportError(
      "facet_projection_effect_identity_mismatch",
    );
  }
  const readback = await facetProjectionReadback(
    env,
    settings,
    providerExternalId,
    claim,
  );
  if (readback.status !== "match") {
    throw new FrappeProjectionTransportError(
      readback.detailCode ?? "facet_projection_effect_readback_unavailable",
    );
  }
  const observed = isRecord(readback.observed) ? readback.observed : {};
  const draftQuoteVersion = observed.draft_quote_version;
  if (!positiveInteger(draftQuoteVersion))
    throw new FrappeProjectionTransportError(
      "facet_projection_draft_readback_conflict",
    );
  return {
    evidenceId,
    reconciliationId,
    draftCustomerQuoteId,
    draftQuoteVersion,
    idempotentReplay: true,
  };
}

function projectionResultFromMatchedReadback(
  observed: unknown,
): ProjectionResult {
  const value = isRecord(observed) ? observed : {};
  if (
    typeof value.evidence_id !== "string" ||
    typeof value.reconciliation_id !== "string" ||
    typeof value.draft_customer_quote_id !== "string" ||
    !positiveInteger(value.draft_quote_version)
  )
    throw new FrappeProjectionTransportError(
      "facet_projection_readback_result_invalid",
    );
  return {
    evidenceId: value.evidence_id,
    reconciliationId: value.reconciliation_id,
    draftCustomerQuoteId: value.draft_customer_quote_id,
    draftQuoteVersion: value.draft_quote_version,
    idempotentReplay: true,
  };
}

async function readFrappeResource(
  env: Env,
  settings: ProjectionSettings,
  doctype: string,
  name: string,
): Promise<FrappeResourceRead> {
  try {
    const response = await fetch(
      `${frappeBaseUrl(env as AppEnv)}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `token ${settings.frappeApiKey}:${settings.frappeApiSecret}`,
        },
      },
    );
    if (response.status === 404) {
      return {
        status: "not_found",
        detailCode: `facet_projection_${doctype.toLowerCase().replaceAll(" ", "_")}_not_found`,
      };
    }
    if (!response.ok) {
      return {
        status: "unavailable",
        detailCode: `facet_projection_readback_${response.status}`,
      };
    }
    const raw = await response.text();
    if (raw.length > MAX_FRAPPE_RESPONSE_BYTES) {
      return {
        status: "conflict",
        detailCode: "facet_projection_readback_too_large",
      };
    }
    const payload = JSON.parse(raw) as unknown;
    if (!isRecord(payload) || !isRecord(payload.data)) {
      return {
        status: "conflict",
        detailCode: "facet_projection_readback_invalid_shape",
      };
    }
    return { status: "ok", data: payload.data };
  } catch {
    return {
      status: "unavailable",
      detailCode: "facet_projection_readback_unavailable",
    };
  }
}

async function projectionTargetQuoteId(
  claim: FacetV2ProjectionClaim,
): Promise<string> {
  const eventId =
    claim.decision_kind === "approved" || claim.decision_kind === "corrected"
      ? claim.event_id
      : claim.previous_event_id;
  if (!eventId)
    throw new FrappeProjectionTransportError(
      "facet_projection_predecessor_missing",
    );
  return `facet-quote-revision:${await sha256Hex(eventId)}`;
}

function blankFrappeValue(value: unknown): boolean {
  return value === null || value === "";
}

function blankEquivalent(value: unknown, expected: string | null): boolean {
  return expected === null ? blankFrappeValue(value) : value === expected;
}

function parseCanonicalRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && canonicalJson(parsed) === value ? parsed : null;
  } catch {
    return null;
  }
}

async function validatedProjectionResponse(
  response: unknown,
  claim: FacetV2ProjectionClaim,
  claimJson: string,
  hmacKey: string,
): Promise<ProjectionResult> {
  if (
    !isRecord(response) ||
    !isRecord(response.message) ||
    !sameKeys(response.message, RESPONSE_KEYS)
  )
    throw new FrappeProjectionTransportError(
      "frappe_projection_response_invalid_shape",
    );
  const message = response.message;
  if (
    typeof message.idempotent_replay !== "boolean" ||
    message.receipt_signature_algorithm !== "HMAC-SHA256" ||
    !validSha256(message.receipt_sha256) ||
    !validSignature(message.receipt_signature) ||
    !isRecord(message.receipt) ||
    !sameKeys(message.receipt, RECEIPT_KEYS)
  )
    throw new FrappeProjectionTransportError(
      "frappe_projection_response_invalid_receipt",
    );
  const eventHash = await sha256Hex(claim.event_id);
  const evidenceId = `facet-design:${eventHash}`;
  const reconciliationId = `facet-design-projection:${eventHash}`;
  const draftCustomerQuoteId = await projectionTargetQuoteId(claim);
  if (
    message.event_id !== claim.event_id ||
    message.evidence_id !== evidenceId ||
    message.reconciliation_id !== reconciliationId ||
    message.draft_customer_quote_id !== draftCustomerQuoteId ||
    !positiveInteger(message.draft_quote_version)
  )
    throw new FrappeProjectionTransportError(
      "frappe_projection_response_anchor_mismatch",
    );
  const receipt = message.receipt;
  const activeDecision =
    claim.decision_kind === "approved" || claim.decision_kind === "corrected";
  const receiptSha256 = await sha256Hex(canonicalJson(receipt));
  const expectedSignature = await hmacBase64Url(
    hmacKey,
    `${RECEIPT_SIGNATURE_CONTEXT}\n${receiptSha256}`,
  );
  if (
    !constantTimeEqual(message.receipt_sha256, receiptSha256) ||
    !constantTimeEqual(message.receipt_signature, expectedSignature)
  )
    throw new FrappeProjectionTransportError(
      "frappe_projection_response_signature_mismatch",
    );
  if (
    receipt.schema !== RECEIPT_SCHEMA ||
    receipt.claim_sha256 !== (await sha256Hex(claimJson)) ||
    receipt.event_id !== claim.event_id ||
    receipt.event_type !== claim.event_type ||
    receipt.schema_version !== 2 ||
    receipt.decision_kind !== claim.decision_kind ||
    receipt.approval_receipt_sha256 !== claim.approval_receipt_sha256 ||
    receipt.actor_identity_assurance !== "oidc" ||
    receipt.destination_tenant_id !== claim.destination_tenant_id ||
    receipt.facet_project_id !== claim.facet_project_id ||
    receipt.association_sha256 !== claim.association_sha256 ||
    receipt.design_revision_id !== claim.design_revision_id ||
    receipt.design_revision_sha256 !== claim.design_revision_sha256 ||
    receipt.frozen_evidence_sha256 !== claim.frozen_evidence_sha256 ||
    receipt.raw_key !== claim.raw_key ||
    receipt.raw_sha256 !== claim.raw_sha256 ||
    receipt.raw_content_length !== claim.raw_content_length ||
    receipt.occurred_at !== claim.occurred_at ||
    receipt.received_at !== claim.received_at ||
    receipt.roof_job_id !== claim.roof_job_id ||
    receipt.source_customer_quote_id !== claim.customer_quote_id ||
    receipt.draft_customer_quote_id !== draftCustomerQuoteId ||
    receipt.draft_quote_version !== message.draft_quote_version ||
    receipt.draft_quote_status !== (activeDecision ? "Draft" : "Rejected") ||
    receipt.blank_commercial_revision !== activeDecision ||
    receipt.customer_safe !== false ||
    receipt.evidence_id !== evidenceId ||
    receipt.reconciliation_id !== reconciliationId ||
    receipt.idempotent_replay !== message.idempotent_replay
  )
    throw new FrappeProjectionTransportError(
      "frappe_projection_response_receipt_mismatch",
    );
  return {
    evidenceId,
    reconciliationId,
    draftCustomerQuoteId,
    draftQuoteVersion: message.draft_quote_version,
    idempotentReplay: message.idempotent_replay,
  };
}

function projectionSettings(env: Env): ProjectionSettings | null {
  const hmacKey = env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY?.trim() ?? "";
  const frappeApiKey =
    env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY?.trim() ?? "";
  const frappeApiSecret =
    env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET?.trim() ?? "";
  if (hmacKey.length < 32 || !frappeApiKey || !frappeApiSecret) return null;
  try {
    frappeBaseUrl(env as AppEnv);
  } catch {
    return null;
  }
  return { hmacKey, frappeApiKey, frappeApiSecret };
}

function projectionFailureOutcome(
  error: unknown,
): "rejected_frappe" | "uncertain" {
  return error instanceof FrappeProjectionHttpError && error.status === 409
    ? "rejected_frappe"
    : "uncertain";
}

function errorCode(error: unknown): string {
  if (error instanceof FrappeProjectionHttpError)
    return `frappe_http_${error.status}`;
  if (error instanceof FrappeProjectionTransportError) return error.code;
  return "facet_v2_projection_unknown_error";
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return base64Url(new Uint8Array(signed));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function constantTimeEqual(left: unknown, right: unknown): boolean {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length
  )
    return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validSignature(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
