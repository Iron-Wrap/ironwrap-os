import { randomToken, sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";
import {
  adapterAuthority,
  assertEffectLedgerReady,
  type EffectExecutionResult,
  type ExternalEffectRecord,
  getExternalEffectByIdempotency,
  reconcileExternalEffect,
  runExternalEffect,
} from "./effect-runtime.ts";
import { facetLaunchIntentSha256, resolveFacetLaunchTarget } from "./facet-launch.ts";
import { frappeBaseUrl, frappeRequestTimeout } from "./frappe-read.ts";
import { canonicalJson } from "./facet-design-v2-protocol.ts";

const PROJECTION_METHOD =
  "ironwrap_roofing.facet_design_projection_api.record_facet_design_proposal_evidence";
const PROJECTION_PATH = `/api/method/${PROJECTION_METHOD}`;
const PROJECTION_PROVIDER = "frappe-facet-design";
const PROJECTION_ACTION = "facet.design.v2.compatibility_projection";
const PROJECTION_BLOCK_ACTION = `${PROJECTION_ACTION}.blocked`;
const PROJECTION_BATCH_SIZE = 25;
const MAX_DECISION_CHAIN_LENGTH = 100;
const PROJECTION_RETRY_LIMIT = 3;
const MAX_FRAPPE_RESPONSE_BYTES = 64 * 1024;
const RECEIPT_SCHEMA = "ironwrap.facet-design-projection-receipt.v2";
const RECEIPT_SIGNATURE_CONTEXT = "ironwrap.facet-design-projection.receipt.v2";
const EVENT_TYPE = "facet.design.customer_approved.v2";
const ACTIVE_DECISIONS = new Set(["approved", "corrected"]);
const DECISIONS = new Set(["approved", "corrected", "superseded", "withdrawn"]);
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RECEIPT_FIELDS = [
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

const RESPONSE_FIELDS = [
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

interface StoredProjectionCandidate {
  event_id: string;
  event_type: string;
  schema_version: number;
  event_body_sha256: string;
  issuer: string;
  source_product: string;
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
  identity_assurance: string;
  decision_kind: string;
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
  native_event_id: string;
  native_projection_id: string;
  native_projection_sha256: string;
  native_design_state: "active" | "withdrawn" | "superseded";
  native_destination_tenant_id: string;
  native_source_tenant_id: string;
  native_brand_id: string;
  native_facet_project_id: string;
  native_external_project_link_id: string;
  native_producer_identity_link_id: string;
  native_external_customer_identity_link_id: string;
  native_roof_job_id: string;
  native_customer_id: string;
  native_customer_quote_id: string;
  native_source_quote_revision_id: string;
  native_source_quote_version: number;
  native_source_quote_approved_at: string;
  native_source_proposal_revision_id: string;
  native_source_proposal_pack_id: string;
  native_source_publication_event_id: string;
  native_source_acceptance_binding_id: string;
  native_source_acceptance_id: string;
  native_source_acceptance_accepted_at: string;
  native_source_acceptance_receipt_hash: string;
  native_launch_intent_sha256: string;
  native_decision_kind: string;
  native_previous_event_id: string | null;
  native_design_revision_id: string;
  native_design_revision_sha256: string;
  native_frozen_evidence_sha256: string;
  native_raw_sha256: string;
  native_design_sequence: number;
}

interface ProjectionWorkItem {
  candidate: StoredProjectionCandidate;
  blockedReason?: string;
  durablePredecessorSucceeded?: boolean;
}

interface StoredProjectionLaunch {
  facet_project_id: string;
  external_project_link_id: string;
  destination_tenant_id: string;
  source_tenant_id: string;
  brand_id: string;
  roof_job_id: string;
  customer_quote_id: string;
  quote_version: number;
  quote_approved_at: string;
  customer_party_ref: string;
  external_customer_identity_link_id: string;
  issued_by_user_id: string;
  launch_intent_sha256: string;
}

interface ProjectionClaim {
  approval_receipt_id: string;
  approval_receipt_sha256: string;
  association_sha256: string;
  brand_id: string;
  customer_party_ref: string;
  customer_quote_id: string;
  decision_kind: string;
  design_revision_id: string;
  design_revision_sha256: string;
  destination_tenant_id: string;
  event_id: string;
  event_type: typeof EVENT_TYPE;
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
  source_issuer: "facet";
  source_tenant_id: string;
}

interface ProjectionResponse {
  draft_customer_quote_id: string;
  draft_quote_version: number;
  event_id: string;
  evidence_id: string;
  idempotent_replay: boolean;
  receipt: Record<string, unknown>;
  receipt_sha256: string;
  receipt_signature: string;
  receipt_signature_algorithm: "HMAC-SHA256";
  reconciliation_id: string;
}

export interface FacetDesignFrappeProjectionDependencies {
  /** Test/release-control boundary; production uses the Worker fetch implementation. */
  fetch?: typeof fetch;
}

export type FacetDesignFrappeProjectionOutcome =
  | "disabled"
  | "succeeded"
  | "rejected"
  | "uncertain";

export interface FacetDesignFrappeProjectionResult {
  eventId: string;
  effectId: string;
  decisionKind: string;
  outcome: FacetDesignFrappeProjectionOutcome;
  evidenceId: string;
  reconciliationId: string;
  draftCustomerQuoteId: string;
  draftQuoteVersion: number | null;
  idempotentReplay: boolean | null;
  receipt: Record<string, unknown> | null;
  errorCode: string | null;
}

class FrappeProjectionReceiptError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

class FrappeProjectionHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`frappe_projection_http_${status}`);
    this.status = status;
  }
}

/**
 * Project only current, already-reconciled native D1 design heads to the
 * compatibility endpoint. Frappe receives evidence plus a blank/rejected
 * Draft shell; it never becomes the Worker authority.
 */
export async function reconcileFacetDesignFrappeProjections(
  env: AppEnv,
  now = new Date(),
  dependencies: FacetDesignFrappeProjectionDependencies = {},
): Promise<FacetDesignFrappeProjectionResult[]> {
  if (String(env.FACET_DESIGN_FRAPPE_PROJECTION_ENABLED) !== "true") return [];
  assertEffectLedgerReady(env);
  const hmacKey = env.FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY?.trim() ?? "";
  if (hmacKey.length < 32) throw new Error("facet_design_projection_hmac_not_configured");
  const injected = dependencies.fetch !== undefined;
  if (!injected) {
    if (!env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY?.trim() ||
        !env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET?.trim()) {
      throw new Error("facet_design_projection_credentials_not_configured");
    }
    frappeBaseUrl(env);
  }
  const workItems = await listProjectionCandidates(env);
  const results: FacetDesignFrappeProjectionResult[] = [];
  const outcomes = new Map<string, FacetDesignFrappeProjectionOutcome>();
  for (const { candidate, blockedReason, durablePredecessorSucceeded } of workItems) {
    if (blockedReason) {
      const blocked = await blockedResult(env, candidate, blockedReason, now);
      outcomes.set(candidate.event_id, blocked.outcome);
      results.push(blocked);
      continue;
    }
    if (candidate.previous_event_id) {
      const predecessorOutcome = outcomes.get(candidate.previous_event_id);
      if (predecessorOutcome !== "succeeded" && !durablePredecessorSucceeded) {
        const blocked = await blockedResult(
          env,
          candidate,
          "facet_frappe_predecessor_unprojected",
          now,
        );
        outcomes.set(candidate.event_id, blocked.outcome);
        results.push(blocked);
        continue;
      }
    }
    const result = await reconcileOneProjection(env, candidate, hmacKey, now, dependencies);
    outcomes.set(candidate.event_id, result.outcome);
    results.push(result);
  }
  return results;
}

async function blockedResult(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
  reason: string,
  now: Date,
): Promise<FacetDesignFrappeProjectionResult> {
  const effect = await recordBlockedProjection(env, candidate, reason, now);
  const expected = await projectionIdentifiers(candidate);
  return {
    eventId: candidate.event_id,
    effectId: effect.effect_id,
    decisionKind: candidate.decision_kind,
    outcome: "uncertain",
    evidenceId: expected.evidenceId,
    reconciliationId: expected.reconciliationId,
    draftCustomerQuoteId: expected.draftCustomerQuoteId,
    draftQuoteVersion: null,
    idempotentReplay: null,
    receipt: null,
    errorCode: reason,
  };
}

async function recordBlockedProjection(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
  reason: string,
  now: Date,
): Promise<ExternalEffectRecord> {
  const evidence = preDispatchEvidence(candidate, reason);
  const blockHash = await sha256Hex(canonicalJson(evidence));
  const idempotencyKey = `facet-design-frappe-block-v1:${blockHash}`;
  const existing = await getExternalEffectByIdempotency(
    env,
    candidate.destination_tenant_id,
    idempotencyKey,
  );
  if (existing?.state === "manual_exception") return existing;
  if (existing?.state === "failed" && existing.result_code === reason) {
    return await reconcileExternalEffect(env, existing.effect_id, {
      outcome: "inconclusive",
      evidence,
      detailCode: reason,
      now: now.toISOString(),
    });
  }
  const authority = adapterAuthority({
    tenantId: candidate.destination_tenant_id,
    provider: PROJECTION_PROVIDER,
    action: PROJECTION_BLOCK_ACTION,
    actorId: "facet-design-projection-worker",
    deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    retryLimit: 0,
  });
  const execution = await runExternalEffect(
    env,
    {
      effectId: `effect:facet-frappe-projection-block:${blockHash}`,
      tenantId: candidate.destination_tenant_id,
      actor: { type: "agent", id: "facet-design-projection-worker" },
      taskId: `facet-design-projection-block:${candidate.event_id}`,
      authority,
      aggregate: {
        type: "facet_native_design_projection",
        id: candidate.native_projection_id,
        version: Number(candidate.native_design_sequence),
      },
      intentId: candidate.event_id,
      action: PROJECTION_BLOCK_ACTION,
      request: evidence,
      provider: PROJECTION_PROVIDER,
      providerAccountRef: "facet-design-projection-service",
      idempotencyKey,
      deadlineAt: authority.expiresAt,
      preconditions: nativeAuthority(candidate),
      evidenceRefs: [
        `facet-v2:event:${candidate.event_id}`,
        `facet-native-design:${candidate.native_projection_id}`,
        `facet-frappe-block:${reason}`,
      ],
      expectedReadback: {
        disposition: "manual_reconciliation",
        reason,
      },
      retryLimit: 0,
      compensationPlan: {},
      correlationId: `facet-design:${candidate.event_id}`,
      now: now.toISOString(),
    },
    {
      async preconditions() {
        return { ok: false, detailCode: reason };
      },
      async dispatch() {
        throw new Error("facet_frappe_blocked_dispatch_forbidden");
      },
      async replay() {
        return evidence;
      },
    },
    now,
  );
  if (execution.effect.state !== "failed") {
    throw new Error("facet_frappe_block_evidence_not_failed");
  }
  return await reconcileExternalEffect(env, execution.effect.effect_id, {
    outcome: "inconclusive",
    evidence,
    detailCode: reason,
    now: now.toISOString(),
  });
}

function preDispatchEvidence(
  candidate: StoredProjectionCandidate,
  reason: string,
): Record<string, unknown> {
  return {
    schema: "ironwrap.facet-design-frappe-pre-dispatch.v1",
    destination_tenant_id: candidate.destination_tenant_id,
    event_id: candidate.event_id,
    native_event_id: candidate.native_event_id,
    native_projection_id: candidate.native_projection_id,
    native_projection_sha256: candidate.native_projection_sha256,
    reason,
  };
}

async function reconcileOneProjection(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
  hmacKey: string,
  now: Date,
  dependencies: FacetDesignFrappeProjectionDependencies,
): Promise<FacetDesignFrappeProjectionResult> {
  const expected = await projectionIdentifiers(candidate);
  const base: FacetDesignFrappeProjectionResult = {
    eventId: candidate.event_id,
    effectId: expected.effectId,
    decisionKind: candidate.decision_kind,
    outcome: "uncertain",
    evidenceId: expected.evidenceId,
    reconciliationId: expected.reconciliationId,
    draftCustomerQuoteId: expected.draftCustomerQuoteId,
    draftQuoteVersion: null,
    idempotentReplay: null,
    receipt: null,
    errorCode: null,
  };
  let authorityMatches: boolean;
  try {
    authorityMatches = await currentNativeAuthorityMatches(
      env,
      candidate,
      nativeAuthority(candidate),
    );
  } catch {
    return await blockedResult(
      env,
      candidate,
      "facet_frappe_current_authority_unavailable",
      now,
    );
  }
  if (!authorityMatches) {
    return await blockedResult(
      env,
      candidate,
      "facet_frappe_current_authority_drift",
      now,
    );
  }
  let claim: ProjectionClaim;
  try {
    claim = await buildClaim(candidate);
  } catch (error) {
    return await blockedResult(env, candidate, errorCode(error), now);
  }
  try {
    const claimJson = canonicalJson(claim);
    const claimSha256 = await sha256Hex(claimJson);
    const readback = {
      event_id: candidate.event_id,
      evidence_id: expected.evidenceId,
      reconciliation_id: expected.reconciliationId,
      draft_customer_quote_id: expected.draftCustomerQuoteId,
      decision_kind: candidate.decision_kind,
      draft_quote_status: ACTIVE_DECISIONS.has(candidate.decision_kind) ? "Draft" : "Rejected",
      blank_commercial_revision: ACTIVE_DECISIONS.has(candidate.decision_kind),
    };
    const authority = adapterAuthority({
      tenantId: candidate.destination_tenant_id,
      provider: PROJECTION_PROVIDER,
      action: PROJECTION_ACTION,
      actorId: "facet-design-projection-worker",
      deadlineAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      retryLimit: PROJECTION_RETRY_LIMIT,
    });
    const execution = await runExternalEffect(
      env,
      {
        effectId: expected.effectId,
        tenantId: candidate.destination_tenant_id,
        actor: { type: "agent", id: "facet-design-projection-worker" },
        taskId: `facet-design-projection:${candidate.event_id}`,
        authority,
        aggregate: {
          type: "facet_native_design_projection",
          id: candidate.native_projection_id,
          version: Number(candidate.native_design_sequence),
        },
        intentId: candidate.event_id,
        action: PROJECTION_ACTION,
        request: {
          protocol: "ironwrap.facet-design-projection.v2",
          path: PROJECTION_PATH,
          claim_sha256: claimSha256,
          claim_json: claimJson,
          native_projection_id: candidate.native_projection_id,
          native_projection_sha256: candidate.native_projection_sha256,
        },
        provider: PROJECTION_PROVIDER,
        providerAccountRef: "facet-design-projection-service",
        idempotencyKey: `facet-design-frappe-v2:${candidate.event_id}:${candidate.native_event_id}`,
        deadlineAt: authority.expiresAt,
        preconditions: nativeAuthority(candidate),
        evidenceRefs: [
          `facet-v2:event:${candidate.event_id}`,
          `facet-native-design:${candidate.native_projection_id}`,
        ],
        expectedReadback: readback,
        retryLimit: PROJECTION_RETRY_LIMIT,
        compensationPlan: {},
        correlationId: `facet-design:${candidate.event_id}`,
        now: now.toISOString(),
      },
      frappeExecutor(env, candidate, claimJson, hmacKey, readback, dependencies),
      now,
    );
    if (
      execution.effect.state === "unknown" &&
      execution.effect.result_code?.startsWith("frappe_projection_receipt_")
    ) {
      const reconciled = await reconcileExternalEffect(env, execution.effect.effect_id, {
        outcome: "inconclusive",
        evidence: receiptAmbiguityEvidence(candidate, execution.effect),
        detailCode: execution.effect.result_code,
        now: now.toISOString(),
      });
      return resultFromExecution(base, { ...execution, effect: reconciled });
    }
    if (
      execution.effect.state === "failed" &&
      (execution.effect.result_code === "facet_frappe_current_authority_drift" ||
        execution.effect.result_code === "effect_preconditions_unavailable")
    ) {
      const reconciled = await reconcileExternalEffect(env, execution.effect.effect_id, {
        outcome: "inconclusive",
        evidence: preDispatchEvidence(candidate, execution.effect.result_code),
        detailCode: execution.effect.result_code,
        now: now.toISOString(),
      });
      return resultFromExecution(base, { ...execution, effect: reconciled });
    }
    return resultFromExecution(base, execution);
  } catch (error) {
    if (error instanceof Error && error.message.includes("drift")) base.outcome = "rejected";
    base.errorCode = errorCode(error);
    return base;
  }
}

function receiptAmbiguityEvidence(
  candidate: StoredProjectionCandidate,
  effect: ExternalEffectRecord,
): Record<string, unknown> {
  return {
    schema: "ironwrap.facet-design-frappe-receipt-ambiguity.v1",
    destination_tenant_id: candidate.destination_tenant_id,
    event_id: candidate.event_id,
    native_event_id: candidate.native_event_id,
    native_projection_id: candidate.native_projection_id,
    native_projection_sha256: candidate.native_projection_sha256,
    effect_id: effect.effect_id,
    provider_response_hash: effect.provider_response_hash,
    reason: effect.result_code,
  };
}

function frappeExecutor(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
  claimJson: string,
  hmacKey: string,
  expectedReadback: Record<string, unknown>,
  dependencies: FacetDesignFrappeProjectionDependencies,
) {
  return {
    async preconditions({ effect }: { effect: ExternalEffectRecord }) {
      const expected = projectionAuthority(effect.preconditions_json);
      if (!expected || !(await currentNativeAuthorityMatches(env, candidate, expected))) {
        return { ok: false, detailCode: "facet_frappe_current_authority_drift" };
      }
      return { ok: true };
    },
    async dispatch({ effect }: { effect: ExternalEffectRecord }) {
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const nonce = randomToken();
      const signature = await hmacBase64Url(
        hmacKey,
        `POST\n${PROJECTION_PATH}\n${timestamp}\n${nonce}\n${await sha256Hex(claimJson)}`,
      );
      try {
        const payload = await sendProjectionRequest(
          env,
          claimJson,
          timestamp,
          nonce,
          signature,
          dependencies.fetch,
        );
        const validated = await validateProjectionResponse(
          payload,
          candidate,
          expectedReadback,
          claimJson,
          hmacKey,
        );
        const expected = projectionAuthority(effect.preconditions_json);
        if (!expected || !(await currentNativeAuthorityMatches(env, candidate, expected))) {
          return {
            outcome: "accepted" as const,
            providerExternalId: validated.reconciliationId,
            providerResponse: validated.response,
            value: validated.response,
            readback: {
              status: "conflict" as const,
              providerExternalId: validated.reconciliationId,
              observed: {
                event_id: candidate.event_id,
                reconciliation_id: validated.reconciliationId,
              },
              detailCode: "facet_v2_native_authority_drift_after_dispatch",
            },
          };
        }
        return {
          outcome: "accepted" as const,
          providerExternalId: validated.reconciliationId,
          providerResponse: validated.response,
          value: validated.response,
          readback: {
            status: "match" as const,
            providerExternalId: validated.reconciliationId,
            observed: expectedReadback,
          },
        };
      } catch (error) {
        if (error instanceof FrappeProjectionReceiptError) {
          return {
            outcome: "unknown" as const,
            detailCode: error.code,
            providerResponse: { error: error.code },
          };
        }
        if (error instanceof FrappeProjectionHttpError && error.status >= 400 && error.status < 500) {
          return {
            outcome: "rejected" as const,
            detailCode: error.message,
            providerResponse: { status: error.status },
          };
        }
        throw error;
      }
    },
    async replay({ effect }: { effect: ExternalEffectRecord }) {
      const expected = parseObject(effect.expected_readback_json) ?? {};
      return {
        event_id: expected.event_id,
        evidence_id: expected.evidence_id,
        reconciliation_id: expected.reconciliation_id,
        draft_customer_quote_id: expected.draft_customer_quote_id,
        draft_quote_status: expected.draft_quote_status,
        blank_commercial_revision: expected.blank_commercial_revision,
        idempotent_replay: true,
      } as unknown as ProjectionResponse;
    },
  };
}

function projectionAuthority(preconditionsJson: string): Record<string, unknown> | null {
  const expected = parseObject(preconditionsJson);
  return expected && typeof expected.projection_id === "string" ? expected : null;
}

async function currentNativeAuthorityMatches(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
  expected: Record<string, unknown>,
): Promise<boolean> {
  const projectionId = expected.projection_id;
  if (typeof projectionId !== "string") return false;
  const current = await env.DB.prepare(
    `SELECT projection_id, event_id, destination_tenant_id, source_tenant_id,
            brand_id, facet_project_id, external_project_link_id,
            producer_identity_link_id, external_customer_identity_link_id,
            roof_job_id, customer_id, customer_quote_id,
            source_quote_revision_id, source_quote_version,
            source_quote_approved_at, source_proposal_revision_id,
            source_proposal_pack_id, source_publication_event_id,
            source_acceptance_binding_id, source_acceptance_id,
            source_acceptance_accepted_at, source_acceptance_receipt_hash,
            launch_intent_sha256, decision_kind, design_sequence,
            design_state, previous_event_id, design_revision_id,
            design_revision_sha256, frozen_evidence_sha256, raw_sha256,
            projection_sha256
       FROM facet_v2_native_design_projections
      WHERE projection_id = ? AND event_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM facet_v2_customer_decisions child
           WHERE child.previous_event_id = facet_v2_native_design_projections.event_id
         )
        AND NOT EXISTS (
          SELECT 1 FROM facet_v2_link_revocations revoked
           WHERE revoked.destination_tenant_id =
                 facet_v2_native_design_projections.destination_tenant_id
             AND (
               (revoked.link_kind = 'project'
                AND revoked.link_id = facet_v2_native_design_projections.external_project_link_id)
               OR (revoked.link_kind = 'producer_identity'
                AND revoked.link_id = facet_v2_native_design_projections.producer_identity_link_id)
               OR (revoked.link_kind = 'customer_identity'
                AND revoked.link_id = facet_v2_native_design_projections.external_customer_identity_link_id)
             )
        )
       LIMIT 1`,
  ).bind(projectionId, candidate.native_event_id).first<Record<string, unknown>>();
  if (!current || !matchesNativeAuthority(current, expected)) return false;

  const association = await env.DB.prepare(
    `SELECT project.external_project_link_id, project.producer_identity_link_id,
            project.destination_tenant_id, project.source_tenant_id,
            project.brand_id, project.facet_project_id,
            project.customer_party_ref,
            project.external_customer_identity_link_id, project.roof_job_id,
            project.customer_quote_id, project.association_sha256,
            identity.issuer, identity.source_product,
            identity.source_environment
       FROM facet_v2_project_links project
       JOIN facet_v2_producer_identity_links identity
         ON identity.producer_identity_link_id = project.producer_identity_link_id
      WHERE project.external_project_link_id = ?
        AND project.producer_identity_link_id = ?
        AND project.destination_tenant_id = ?
        AND project.facet_project_id = ?
      LIMIT 1`,
  ).bind(
    candidate.external_project_link_id,
    candidate.producer_identity_link_id,
    candidate.destination_tenant_id,
    candidate.facet_project_id,
  ).first<Record<string, unknown>>();
  const associationHash = await sha256Hex(canonicalJson({
    brand_id: candidate.brand_id,
    customer_party_ref: candidate.customer_party_ref,
    customer_quote_id: candidate.customer_quote_id,
    destination_tenant_id: candidate.destination_tenant_id,
    external_customer_identity_link_id: candidate.external_customer_identity_link_id,
    external_project_link_id: candidate.external_project_link_id,
    facet_project_id: candidate.facet_project_id,
    producer_identity_link_id: candidate.producer_identity_link_id,
    roof_job_id: candidate.roof_job_id,
    source_tenant_id: candidate.source_tenant_id,
  }));
  if (!association || associationHash !== candidate.association_sha256 || !sameExpected({
    external_project_link_id: candidate.external_project_link_id,
    producer_identity_link_id: candidate.producer_identity_link_id,
    destination_tenant_id: candidate.destination_tenant_id,
    source_tenant_id: candidate.source_tenant_id,
    brand_id: candidate.brand_id,
    facet_project_id: candidate.facet_project_id,
    customer_party_ref: candidate.customer_party_ref,
    external_customer_identity_link_id: candidate.external_customer_identity_link_id,
    roof_job_id: candidate.roof_job_id,
    customer_quote_id: candidate.customer_quote_id,
    association_sha256: candidate.association_sha256,
    issuer: candidate.issuer,
    source_product: candidate.source_product,
    source_environment: candidate.source_environment,
  }, association)) return false;

  const launch = await env.DB.prepare(
    `SELECT facet_project_id, external_project_link_id,
            destination_tenant_id, source_tenant_id, brand_id, roof_job_id,
            customer_quote_id, quote_version, quote_approved_at,
            customer_party_ref, external_customer_identity_link_id,
            issued_by_user_id, launch_intent_sha256
       FROM facet_v2_project_launches
      WHERE destination_tenant_id = ? AND facet_project_id = ?
      LIMIT 1`,
  ).bind(
    candidate.destination_tenant_id,
    candidate.facet_project_id,
  ).first<StoredProjectionLaunch>();
  const resolved = await resolveFacetLaunchTarget(
    env,
    candidate.destination_tenant_id,
    candidate.roof_job_id,
  );
  if (!launch || !resolved.ok) return false;
  const target = resolved.value;
  const launchIntent = await facetLaunchIntentSha256({
    target,
    destinationTenantId: candidate.destination_tenant_id,
    sourceTenantId: candidate.source_tenant_id,
    issuedByUserId: launch.issued_by_user_id,
  });
  return launch.facet_project_id === candidate.facet_project_id &&
    launch.external_project_link_id === candidate.external_project_link_id &&
    launch.destination_tenant_id === candidate.destination_tenant_id &&
    launch.source_tenant_id === candidate.source_tenant_id &&
    launch.brand_id === candidate.brand_id &&
    launch.roof_job_id === candidate.roof_job_id &&
    launch.customer_quote_id === candidate.customer_quote_id &&
    Number(launch.quote_version) === Number(candidate.native_source_quote_version) &&
    launch.quote_approved_at === candidate.native_source_quote_approved_at &&
    launch.customer_party_ref === candidate.customer_party_ref &&
    launch.external_customer_identity_link_id === candidate.external_customer_identity_link_id &&
    launch.launch_intent_sha256 === candidate.native_launch_intent_sha256 &&
    launch.launch_intent_sha256 === launchIntent &&
    target.brandId === candidate.brand_id &&
    target.roofJobId === candidate.roof_job_id &&
    target.customerId === candidate.native_customer_id &&
    target.customerQuoteId === candidate.customer_quote_id &&
    target.quoteRevisionId === candidate.native_source_quote_revision_id &&
    target.quoteVersion === Number(candidate.native_source_quote_version) &&
    target.quoteApprovedAt === candidate.native_source_quote_approved_at &&
    target.proposalRevisionId === candidate.native_source_proposal_revision_id &&
    target.proposalPackId === candidate.native_source_proposal_pack_id &&
    target.publicationEventId === candidate.native_source_publication_event_id &&
    target.acceptanceBindingId === candidate.native_source_acceptance_binding_id &&
    target.acceptanceId === candidate.native_source_acceptance_id &&
    target.acceptedAt === candidate.native_source_acceptance_accepted_at &&
    target.acceptanceReceiptHash === candidate.native_source_acceptance_receipt_hash &&
    target.customerPartyRef === candidate.customer_party_ref &&
    target.externalCustomerIdentityLinkId === candidate.external_customer_identity_link_id;
}

async function sendProjectionRequest(
  env: AppEnv,
  claimJson: string,
  timestamp: string,
  nonce: string,
  signature: string,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const injected = fetchImpl !== undefined;
  const url = injected
    ? `${env.ERPNEXT_BASE_URL?.trim() || "https://injected-facets.invalid"}${PROJECTION_PATH}`
    : `${frappeBaseUrl(env)}${PROJECTION_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS),
  );
  try {
    const requestInit: RequestInit = {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY?.trim() &&
        env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET?.trim()
          ? {
              authorization:
                `token ${env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY.trim()}:${env.FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET.trim()}`,
            }
          : {}),
        "content-type": "application/json",
        "user-agent": "ironwrap-facet-design-projection/2.0",
        "x-ironwrap-facet-projection-timestamp": timestamp,
        "x-ironwrap-facet-projection-nonce": nonce,
        "x-ironwrap-facet-projection-signature": signature,
      },
      body: JSON.stringify({ facet_claim_json: claimJson }),
    };
    const response = fetchImpl
      ? await fetchImpl(url, requestInit)
      : await fetch(url, requestInit);
    if (!response.ok) throw new FrappeProjectionHttpError(response.status);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeProjectionReceiptError("frappe_projection_receipt_too_large");
    }
    const raw = await response.text();
    if (raw.length > MAX_FRAPPE_RESPONSE_BYTES) {
      throw new FrappeProjectionReceiptError("frappe_projection_receipt_too_large");
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new FrappeProjectionReceiptError("frappe_projection_receipt_invalid_json");
    }
  } catch (error) {
    if (error instanceof FrappeProjectionHttpError || error instanceof FrappeProjectionReceiptError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") throw new Error("frappe_projection_request_timeout");
    throw new Error("frappe_projection_request_network_error");
  } finally {
    clearTimeout(timer);
  }
}

async function validateProjectionResponse(
  raw: unknown,
  candidate: StoredProjectionCandidate,
  expectedReadback: Record<string, unknown>,
  claimJson: string,
  hmacKey: string,
): Promise<{ response: ProjectionResponse; reconciliationId: string }> {
  if (!isRecord(raw) || !isRecord(raw.message)) throw new FrappeProjectionReceiptError("frappe_projection_receipt_shape");
  const response = raw.message;
  if (!sameKeys(response, RESPONSE_FIELDS)) throw new FrappeProjectionReceiptError("frappe_projection_receipt_fields");
  const expected = await projectionIdentifiers(candidate);
  if (
    response.event_id !== candidate.event_id ||
    response.evidence_id !== expected.evidenceId ||
    response.reconciliation_id !== expected.reconciliationId ||
    response.draft_customer_quote_id !== expected.draftCustomerQuoteId ||
    !isSafeInteger(response.draft_quote_version) ||
    typeof response.idempotent_replay !== "boolean" ||
    response.receipt_signature_algorithm !== "HMAC-SHA256" ||
    !isRecord(response.receipt) ||
    typeof response.receipt_sha256 !== "string" ||
    typeof response.receipt_signature !== "string"
  ) {
    throw new FrappeProjectionReceiptError("frappe_projection_receipt_identity_drift");
  }
  const receipt = response.receipt;
  if (!sameKeys(receipt, RECEIPT_FIELDS)) throw new FrappeProjectionReceiptError("frappe_projection_receipt_fields");
  const expectedReceiptHash = await sha256Hex(canonicalJson(receipt));
  if (response.receipt_sha256 !== expectedReceiptHash ||
      !(await verifyHmacBase64Url(hmacKey, `${RECEIPT_SIGNATURE_CONTEXT}\n${response.receipt_sha256}`, response.receipt_signature))) {
    throw new FrappeProjectionReceiptError("frappe_projection_receipt_signature_invalid");
  }
  const claimHash = await sha256Hex(claimJson);
  const active = ACTIVE_DECISIONS.has(candidate.decision_kind);
  if (
    receipt.schema !== RECEIPT_SCHEMA || receipt.schema_version !== 2 ||
    receipt.actor_identity_assurance !== "oidc" ||
    receipt.event_type !== EVENT_TYPE || receipt.event_id !== candidate.event_id ||
    receipt.evidence_id !== expected.evidenceId || receipt.reconciliation_id !== expected.reconciliationId ||
    receipt.draft_customer_quote_id !== expected.draftCustomerQuoteId ||
    receipt.decision_kind !== candidate.decision_kind || receipt.claim_sha256 !== claimHash ||
    receipt.blank_commercial_revision !== active || receipt.draft_quote_status !== (active ? "Draft" : "Rejected") ||
    receipt.customer_safe !== false || receipt.idempotent_replay !== response.idempotent_replay ||
    receipt.approval_receipt_sha256 !== candidate.approval_receipt_sha256 ||
    receipt.association_sha256 !== candidate.association_sha256 ||
    receipt.design_revision_id !== candidate.design_revision_id ||
    receipt.design_revision_sha256 !== candidate.design_revision_sha256 ||
    receipt.destination_tenant_id !== candidate.destination_tenant_id ||
    receipt.facet_project_id !== candidate.facet_project_id ||
    receipt.frozen_evidence_sha256 !== candidate.frozen_evidence_sha256 ||
    receipt.occurred_at !== candidate.occurred_at || receipt.received_at !== candidate.received_at ||
    receipt.raw_content_length !== Number(candidate.raw_content_length) ||
    receipt.raw_key !== candidate.raw_key || receipt.raw_sha256 !== candidate.raw_sha256 ||
    receipt.roof_job_id !== candidate.roof_job_id || receipt.source_customer_quote_id !== candidate.customer_quote_id ||
    receipt.draft_quote_version !== response.draft_quote_version
  ) {
    throw new FrappeProjectionReceiptError("frappe_projection_receipt_identity_drift");
  }
  if (!sameExpected(expectedReadback, {
    event_id: response.event_id,
    evidence_id: response.evidence_id,
    reconciliation_id: response.reconciliation_id,
    draft_customer_quote_id: response.draft_customer_quote_id,
    decision_kind: receipt.decision_kind,
    draft_quote_status: receipt.draft_quote_status,
    blank_commercial_revision: receipt.blank_commercial_revision,
  })) {
    throw new FrappeProjectionReceiptError("frappe_projection_receipt_readback_drift");
  }
  return {
    response: response as unknown as ProjectionResponse,
    reconciliationId: expected.reconciliationId,
  };
}

async function buildClaim(candidate: StoredProjectionCandidate): Promise<ProjectionClaim> {
  await assertCandidate(candidate);
  const expectedAssociation = await sha256Hex(canonicalJson({
    brand_id: candidate.brand_id,
    customer_party_ref: candidate.customer_party_ref,
    customer_quote_id: candidate.customer_quote_id,
    destination_tenant_id: candidate.destination_tenant_id,
    external_customer_identity_link_id: candidate.external_customer_identity_link_id,
    external_project_link_id: candidate.external_project_link_id,
    facet_project_id: candidate.facet_project_id,
    producer_identity_link_id: candidate.producer_identity_link_id,
    roof_job_id: candidate.roof_job_id,
    source_tenant_id: candidate.source_tenant_id,
  }));
  if (expectedAssociation !== candidate.association_sha256) throw new Error("facet_v2_association_drift");
  return {
    approval_receipt_id: candidate.approval_receipt_id,
    approval_receipt_sha256: candidate.approval_receipt_sha256,
    association_sha256: candidate.association_sha256,
    brand_id: candidate.brand_id,
    customer_party_ref: candidate.customer_party_ref,
    customer_quote_id: candidate.customer_quote_id,
    decision_kind: candidate.decision_kind,
    design_revision_id: candidate.design_revision_id,
    design_revision_sha256: candidate.design_revision_sha256,
    destination_tenant_id: candidate.destination_tenant_id,
    event_id: candidate.event_id,
    event_type: EVENT_TYPE,
    external_customer_identity_link_id: candidate.external_customer_identity_link_id,
    external_project_link_id: candidate.external_project_link_id,
    facet_project_id: candidate.facet_project_id,
    frozen_evidence_sha256: candidate.frozen_evidence_sha256,
    identity_assurance: "oidc",
    occurred_at: candidate.occurred_at,
    oidc_issuer: candidate.oidc_issuer,
    oidc_subject_sha256: candidate.oidc_subject_sha256,
    previous_event_id: candidate.previous_event_id,
    producer_identity_link_id: candidate.producer_identity_link_id,
    raw_content_length: Number(candidate.raw_content_length),
    raw_key: candidate.raw_key,
    raw_sha256: candidate.raw_sha256,
    reason_sha256: candidate.reason_sha256,
    received_at: candidate.received_at,
    roof_job_id: candidate.roof_job_id,
    schema_version: 2,
    source_environment: candidate.source_environment,
    source_issuer: "facet",
    source_tenant_id: candidate.source_tenant_id,
  };
}

async function listProjectionCandidates(env: AppEnv): Promise<ProjectionWorkItem[]> {
  const heads: StoredProjectionCandidate[] = [];
  let afterOccurredAt: string | null = null;
  let afterEventId: string | null = null;
  while (heads.length < PROJECTION_BATCH_SIZE) {
    const result = await loadProjectionCandidatePage(env, afterOccurredAt, afterEventId);
    const page = result.results ?? [];
    if (page.length === 0) break;
    for (const head of page) {
      afterOccurredAt = head.occurred_at;
      afterEventId = head.event_id;
      if (!(await terminalCurrentHeadDisposition(env, head))) heads.push(head);
      if (heads.length >= PROJECTION_BATCH_SIZE) break;
    }
    if (page.length < PROJECTION_BATCH_SIZE) break;
  }
  const workItems: ProjectionWorkItem[] = [];
  for (const head of heads) {
    if (workItems.length >= PROJECTION_BATCH_SIZE) break;
    try {
      await assertCandidate(head);
    } catch (error) {
      workItems.push({ candidate: head, blockedReason: errorCode(error) });
      continue;
    }
    const chain = await loadProjectionChain(env, head);
    if (!chain) {
      workItems.push({ candidate: head, blockedReason: "facet_frappe_predecessor_chain_invalid" });
      continue;
    }
    let firstUnfinishedIndex = 0;
    while (
      firstUnfinishedIndex < chain.length &&
      await terminalSucceededProjection(env, chain[firstUnfinishedIndex]!)
    ) {
      firstUnfinishedIndex += 1;
    }
    const firstUnfinishedHasDurableNonSuccess =
      firstUnfinishedIndex < chain.length &&
      await durableNonSucceededProjection(env, chain[firstUnfinishedIndex]!);
    const chainWorkLimit = firstUnfinishedHasDurableNonSuccess
      ? firstUnfinishedIndex + 1
      : chain.length;
    for (
      let index = firstUnfinishedIndex;
      index < chainWorkLimit && workItems.length < PROJECTION_BATCH_SIZE;
      index += 1
    ) {
      workItems.push({
        candidate: chain[index]!,
        durablePredecessorSucceeded: index === firstUnfinishedIndex && index > 0,
      });
    }
  }
  return workItems;
}

async function loadProjectionCandidatePage(
  env: AppEnv,
  afterOccurredAt: string | null,
  afterEventId: string | null,
) {
  return await env.DB.prepare(
    `SELECT decision.event_id, decision.event_type, decision.schema_version,
            decision.event_body_sha256, decision.issuer, decision.source_product,
            decision.source_environment, decision.source_tenant_id,
            decision.destination_tenant_id, decision.brand_id,
            decision.facet_project_id, decision.external_project_link_id,
            decision.producer_identity_link_id, decision.association_sha256,
            decision.roof_job_id, decision.customer_quote_id,
            decision.customer_party_ref, decision.external_customer_identity_link_id,
            decision.oidc_issuer, decision.oidc_subject_sha256,
            decision.identity_assurance, decision.decision_kind,
            decision.previous_event_id, decision.reason_sha256,
            decision.approval_receipt_id, decision.approval_receipt_sha256,
            decision.design_revision_id, decision.design_revision_sha256,
            decision.frozen_evidence_sha256, decision.raw_key, decision.raw_sha256,
            decision.raw_content_length, decision.occurred_at, decision.received_at,
            projection.event_id AS native_event_id,
            projection.projection_id AS native_projection_id,
            projection.projection_sha256 AS native_projection_sha256,
            projection.design_state AS native_design_state,
            projection.destination_tenant_id AS native_destination_tenant_id,
            projection.source_tenant_id AS native_source_tenant_id,
            projection.brand_id AS native_brand_id,
            projection.facet_project_id AS native_facet_project_id,
            projection.external_project_link_id AS native_external_project_link_id,
            projection.producer_identity_link_id AS native_producer_identity_link_id,
            projection.external_customer_identity_link_id AS native_external_customer_identity_link_id,
            projection.roof_job_id AS native_roof_job_id,
            projection.customer_id AS native_customer_id,
            projection.customer_quote_id AS native_customer_quote_id,
            projection.source_quote_revision_id AS native_source_quote_revision_id,
            projection.source_quote_version AS native_source_quote_version,
            projection.source_quote_approved_at AS native_source_quote_approved_at,
            projection.source_proposal_revision_id AS native_source_proposal_revision_id,
            projection.source_proposal_pack_id AS native_source_proposal_pack_id,
            projection.source_publication_event_id AS native_source_publication_event_id,
            projection.source_acceptance_binding_id AS native_source_acceptance_binding_id,
            projection.source_acceptance_id AS native_source_acceptance_id,
            projection.source_acceptance_accepted_at AS native_source_acceptance_accepted_at,
            projection.source_acceptance_receipt_hash AS native_source_acceptance_receipt_hash,
            projection.launch_intent_sha256 AS native_launch_intent_sha256,
            projection.decision_kind AS native_decision_kind,
            projection.previous_event_id AS native_previous_event_id,
            projection.design_revision_id AS native_design_revision_id,
            projection.design_revision_sha256 AS native_design_revision_sha256,
            projection.frozen_evidence_sha256 AS native_frozen_evidence_sha256,
            projection.raw_sha256 AS native_raw_sha256,
            projection.design_sequence AS native_design_sequence
       FROM facet_v2_customer_decisions decision
       JOIN facet_v2_native_design_projections projection
         ON projection.event_id = decision.event_id
      WHERE NOT EXISTS (
        SELECT 1 FROM facet_v2_customer_decisions child
         WHERE child.previous_event_id = decision.event_id
      )
        AND (
          ? IS NULL OR decision.occurred_at > ? OR
          (decision.occurred_at = ? AND decision.event_id > ?)
        )
      ORDER BY decision.occurred_at ASC, decision.event_id ASC
      LIMIT ?`,
  ).bind(
    afterOccurredAt,
    afterOccurredAt,
    afterOccurredAt,
    afterEventId,
    PROJECTION_BATCH_SIZE,
  ).all<StoredProjectionCandidate>();
}

async function terminalCurrentHeadDisposition(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
): Promise<boolean> {
  if (await hasTerminalProjectionBlock(env, candidate)) return true;

  const effect = await getExternalEffectByIdempotency(
    env,
    candidate.destination_tenant_id,
    projectionIdempotencyKey(candidate),
  );
  if (!effect ||
      effect.state === "proposed" || effect.state === "authorized" ||
      effect.state === "retry" || effect.state === "executing" ||
      effect.state === "reconciling") return false;
  try {
    return await currentNativeAuthorityMatches(env, candidate, nativeAuthority(candidate));
  } catch {
    return false;
  }
}

async function terminalSucceededProjection(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
): Promise<boolean> {
  if (await hasTerminalProjectionBlock(env, candidate)) return false;
  const effect = await getExternalEffectByIdempotency(
    env,
    candidate.destination_tenant_id,
    projectionIdempotencyKey(candidate),
  );
  if (effect?.state !== "succeeded") return false;
  try {
    return await currentNativeAuthorityMatches(env, candidate, nativeAuthority(candidate));
  } catch {
    return false;
  }
}

async function durableNonSucceededProjection(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
): Promise<boolean> {
  if (await hasTerminalProjectionBlock(env, candidate)) return true;
  const effect = await getExternalEffectByIdempotency(
    env,
    candidate.destination_tenant_id,
    projectionIdempotencyKey(candidate),
  );
  if (!effect || effect.state === "succeeded" ||
      effect.state === "proposed" || effect.state === "authorized" ||
      effect.state === "retry" || effect.state === "executing" ||
      effect.state === "reconciling") return false;
  return true;
}

async function hasTerminalProjectionBlock(
  env: AppEnv,
  candidate: StoredProjectionCandidate,
): Promise<boolean> {
  const terminalBlock = await env.DB.prepare(
    `SELECT 1 AS found
       FROM external_effects
      WHERE tenant_id = ? AND provider = ? AND action = ?
        AND aggregate_type = 'facet_native_design_projection'
        AND aggregate_id = ? AND aggregate_version = ? AND intent_id = ?
        AND state = 'manual_exception'
        AND result_code <> 'facet_frappe_predecessor_unprojected'
      LIMIT 1`,
  ).bind(
    candidate.destination_tenant_id,
    PROJECTION_PROVIDER,
    PROJECTION_BLOCK_ACTION,
    candidate.native_projection_id,
    Number(candidate.native_design_sequence),
    candidate.event_id,
  ).first<{ found: number }>();
  return terminalBlock !== null;
}

function projectionIdempotencyKey(candidate: StoredProjectionCandidate): string {
  return `facet-design-frappe-v2:${candidate.event_id}:${candidate.native_event_id}`;
}

async function loadProjectionChain(
  env: AppEnv,
  head: StoredProjectionCandidate,
): Promise<StoredProjectionCandidate[] | null> {
  try {
    await assertCandidate(head);
  } catch {
    return null;
  }
  const chain: StoredProjectionCandidate[] = [head];
  const seen = new Set([head.event_id]);
  let previousEventId = head.previous_event_id;
  while (previousEventId) {
    if (seen.has(previousEventId) || chain.length >= MAX_DECISION_CHAIN_LENGTH) return null;
    const previous = await env.DB.prepare(
      `SELECT event_id, event_type, schema_version, event_body_sha256, issuer,
              source_product, source_environment, source_tenant_id,
              destination_tenant_id, brand_id, facet_project_id,
              external_project_link_id, producer_identity_link_id,
              association_sha256, roof_job_id, customer_quote_id,
              customer_party_ref, external_customer_identity_link_id,
              oidc_issuer, oidc_subject_sha256, identity_assurance,
              decision_kind, previous_event_id, reason_sha256,
              approval_receipt_id, approval_receipt_sha256,
              design_revision_id, design_revision_sha256,
              frozen_evidence_sha256, raw_key, raw_sha256,
              raw_content_length, occurred_at, received_at
         FROM facet_v2_customer_decisions
        WHERE event_id = ? AND destination_tenant_id = ?
          AND facet_project_id = ?
        LIMIT 1`,
    )
      .bind(previousEventId, head.destination_tenant_id, head.facet_project_id)
      .first<StoredProjectionCandidate>();
    if (!previous) return null;
    const anchored = withNativeAuthority(previous, head);
    chain.push(anchored);
    seen.add(anchored.event_id);
    previousEventId = anchored.previous_event_id;
  }
  chain.reverse();
  if (chain[0]?.decision_kind !== "approved" || chain[0].previous_event_id !== null) return null;
  for (let index = 0; index < chain.length; index += 1) {
    const current = chain[index]!;
    const previous = index === 0 ? null : chain[index - 1]!;
    try {
      await assertCandidate(current);
    } catch {
      return null;
    }
    if (
      !sameDecisionAuthority(current, head) ||
      (previous !== null &&
        (current.previous_event_id !== previous.event_id ||
          Date.parse(current.occurred_at) < Date.parse(previous.occurred_at)))
    ) return null;
    if (!previous) continue;
    const previousWasActive = previous.decision_kind === "approved" || previous.decision_kind === "corrected";
    if (!previousWasActive || current.decision_kind === "approved") return null;
    if (
      (current.decision_kind === "withdrawn" || current.decision_kind === "superseded") &&
      index !== chain.length - 1
    ) return null;
  }
  return chain.at(-1)?.event_id === head.event_id ? chain : null;
}

function withNativeAuthority(
  event: StoredProjectionCandidate,
  head: StoredProjectionCandidate,
): StoredProjectionCandidate {
  return {
    ...event,
    native_event_id: head.native_event_id,
    native_projection_id: head.native_projection_id,
    native_projection_sha256: head.native_projection_sha256,
    native_design_state: head.native_design_state,
    native_destination_tenant_id: head.native_destination_tenant_id,
    native_source_tenant_id: head.native_source_tenant_id,
    native_brand_id: head.native_brand_id,
    native_facet_project_id: head.native_facet_project_id,
    native_external_project_link_id: head.native_external_project_link_id,
    native_producer_identity_link_id: head.native_producer_identity_link_id,
    native_external_customer_identity_link_id: head.native_external_customer_identity_link_id,
    native_roof_job_id: head.native_roof_job_id,
    native_customer_id: head.native_customer_id,
    native_customer_quote_id: head.native_customer_quote_id,
    native_source_quote_revision_id: head.native_source_quote_revision_id,
    native_source_quote_version: head.native_source_quote_version,
    native_source_quote_approved_at: head.native_source_quote_approved_at,
    native_source_proposal_revision_id: head.native_source_proposal_revision_id,
    native_source_proposal_pack_id: head.native_source_proposal_pack_id,
    native_source_publication_event_id: head.native_source_publication_event_id,
    native_source_acceptance_binding_id: head.native_source_acceptance_binding_id,
    native_source_acceptance_id: head.native_source_acceptance_id,
    native_source_acceptance_accepted_at: head.native_source_acceptance_accepted_at,
    native_source_acceptance_receipt_hash: head.native_source_acceptance_receipt_hash,
    native_launch_intent_sha256: head.native_launch_intent_sha256,
    native_decision_kind: head.native_decision_kind,
    native_previous_event_id: head.native_previous_event_id,
    native_design_revision_id: head.native_design_revision_id,
    native_design_revision_sha256: head.native_design_revision_sha256,
    native_frozen_evidence_sha256: head.native_frozen_evidence_sha256,
    native_raw_sha256: head.native_raw_sha256,
    native_design_sequence: head.native_design_sequence,
  };
}

function sameDecisionAuthority(left: StoredProjectionCandidate, right: StoredProjectionCandidate): boolean {
  return left.issuer === right.issuer &&
    left.source_product === right.source_product &&
    left.source_environment === right.source_environment &&
    left.source_tenant_id === right.source_tenant_id &&
    left.destination_tenant_id === right.destination_tenant_id &&
    left.brand_id === right.brand_id &&
    left.facet_project_id === right.facet_project_id &&
    left.external_project_link_id === right.external_project_link_id &&
    left.producer_identity_link_id === right.producer_identity_link_id &&
    left.association_sha256 === right.association_sha256 &&
    left.roof_job_id === right.roof_job_id &&
    left.customer_quote_id === right.customer_quote_id &&
    left.customer_party_ref === right.customer_party_ref &&
    left.external_customer_identity_link_id === right.external_customer_identity_link_id &&
    left.oidc_issuer === right.oidc_issuer &&
    left.oidc_subject_sha256 === right.oidc_subject_sha256 &&
    left.identity_assurance === right.identity_assurance;
}

function nativeAuthority(candidate: StoredProjectionCandidate): Record<string, unknown> {
  return {
    projection_id: candidate.native_projection_id,
    projection_sha256: candidate.native_projection_sha256,
    event_id: candidate.native_event_id,
    destination_tenant_id: candidate.destination_tenant_id,
    source_tenant_id: candidate.source_tenant_id,
    brand_id: candidate.brand_id,
    facet_project_id: candidate.facet_project_id,
    external_project_link_id: candidate.external_project_link_id,
    producer_identity_link_id: candidate.producer_identity_link_id,
    external_customer_identity_link_id: candidate.external_customer_identity_link_id,
    roof_job_id: candidate.roof_job_id,
    customer_id: candidate.native_customer_id,
    customer_quote_id: candidate.customer_quote_id,
    source_quote_revision_id: candidate.native_source_quote_revision_id,
    source_quote_version: Number(candidate.native_source_quote_version),
    source_quote_approved_at: candidate.native_source_quote_approved_at,
    source_proposal_revision_id: candidate.native_source_proposal_revision_id,
    source_proposal_pack_id: candidate.native_source_proposal_pack_id,
    source_publication_event_id: candidate.native_source_publication_event_id,
    source_acceptance_binding_id: candidate.native_source_acceptance_binding_id,
    source_acceptance_id: candidate.native_source_acceptance_id,
    source_acceptance_accepted_at: candidate.native_source_acceptance_accepted_at,
    source_acceptance_receipt_hash: candidate.native_source_acceptance_receipt_hash,
    launch_intent_sha256: candidate.native_launch_intent_sha256,
    decision_kind: candidate.native_decision_kind,
    design_sequence: Number(candidate.native_design_sequence),
    design_state: candidate.native_design_state,
    previous_event_id: candidate.native_previous_event_id,
    design_revision_id: candidate.native_design_revision_id,
    design_revision_sha256: candidate.native_design_revision_sha256,
    frozen_evidence_sha256: candidate.native_frozen_evidence_sha256,
    raw_sha256: candidate.native_raw_sha256,
  };
}

function matchesNativeAuthority(current: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => Object.is(current[key], value));
}

async function projectionIdentifiers(candidate: StoredProjectionCandidate): Promise<{
  effectId: string;
  evidenceId: string;
  reconciliationId: string;
  draftCustomerQuoteId: string;
}> {
  const eventHash = await sha256Hex(candidate.event_id);
  const effectHash = await sha256Hex(`${candidate.event_id}:${candidate.native_event_id}`);
  const active = ACTIVE_DECISIONS.has(candidate.decision_kind);
  const previous = candidate.previous_event_id;
  const draftEventHash = active ? eventHash : await sha256Hex(previous ?? "");
  return {
    effectId: `effect:facet-frappe-projection:${effectHash}`,
    evidenceId: `facet-design:${eventHash}`,
    reconciliationId: `facet-design-projection:${eventHash}`,
    draftCustomerQuoteId: active
      ? `facet-quote-revision:${eventHash}`
      : `facet-quote-revision:${draftEventHash}`,
  };
}

async function assertCandidate(candidate: StoredProjectionCandidate): Promise<void> {
  const nativeEventHash = await sha256Hex(candidate.native_event_id);
  const nativeHead = candidate.native_event_id === candidate.event_id;
  if (
    candidate.event_type !== EVENT_TYPE || Number(candidate.schema_version) !== 2 ||
    candidate.source_product !== "facet" || candidate.issuer !== "facet" ||
    candidate.identity_assurance !== "oidc" ||
    (candidate.oidc_issuer !== "https://accounts.google.com" && candidate.oidc_issuer !== "accounts.google.com") ||
    !DECISIONS.has(candidate.decision_kind) || !UUID.test(candidate.native_event_id) ||
    candidate.native_destination_tenant_id !== candidate.destination_tenant_id ||
    candidate.native_source_tenant_id !== candidate.source_tenant_id || candidate.native_brand_id !== candidate.brand_id ||
    candidate.native_facet_project_id !== candidate.facet_project_id || candidate.native_external_project_link_id !== candidate.external_project_link_id ||
    candidate.native_producer_identity_link_id !== candidate.producer_identity_link_id ||
    candidate.native_external_customer_identity_link_id !== candidate.external_customer_identity_link_id ||
    candidate.native_roof_job_id !== candidate.roof_job_id || candidate.native_customer_quote_id !== candidate.customer_quote_id ||
    candidate.native_projection_id !== `facet-native-design-v2:${nativeEventHash}` ||
    !SHA256.test(candidate.native_projection_sha256) || !SHA256.test(candidate.raw_sha256) ||
    candidate.event_body_sha256 !== candidate.raw_sha256 || candidate.raw_key !== `facet-design/v2/raw/${candidate.raw_sha256}.json` ||
    candidate.design_revision_id !== `facet-json-v1:${candidate.design_revision_sha256}` ||
    !SHA256.test(candidate.design_revision_sha256) || !SHA256.test(candidate.frozen_evidence_sha256) ||
    !SHA256.test(candidate.association_sha256) || !SHA256.test(candidate.approval_receipt_sha256) ||
    !SHA256.test(candidate.oidc_subject_sha256) || !SHA256.test(candidate.customer_party_ref) ||
    !UUID.test(candidate.event_id) || !UUID.test(candidate.approval_receipt_id) || !UUID.test(candidate.facet_project_id) ||
    !UUID.test(candidate.source_tenant_id) ||
    !Number.isSafeInteger(Number(candidate.raw_content_length)) || Number(candidate.raw_content_length) < 2 || Number(candidate.raw_content_length) > 512 * 1024 ||
    !Number.isSafeInteger(Number(candidate.native_design_sequence)) || Number(candidate.native_design_sequence) < 1 ||
    !Number.isFinite(Date.parse(candidate.occurred_at)) ||
    !Number.isFinite(Date.parse(candidate.received_at)) ||
    Date.parse(candidate.received_at) < Date.parse(candidate.occurred_at) ||
    (candidate.decision_kind === "approved" && (candidate.previous_event_id !== null || candidate.reason_sha256 !== null)) ||
    (candidate.decision_kind !== "approved" && (!candidate.previous_event_id || !candidate.reason_sha256 || !UUID.test(candidate.previous_event_id) || !SHA256.test(candidate.reason_sha256))) ||
    (candidate.native_design_state !== (ACTIVE_DECISIONS.has(candidate.native_decision_kind) ? "active" : candidate.native_decision_kind)) ||
    (nativeHead && (
      candidate.native_decision_kind !== candidate.decision_kind ||
      candidate.native_previous_event_id !== candidate.previous_event_id ||
      candidate.native_design_revision_id !== candidate.design_revision_id ||
      candidate.native_design_revision_sha256 !== candidate.design_revision_sha256 ||
      candidate.native_frozen_evidence_sha256 !== candidate.frozen_evidence_sha256 ||
      candidate.native_raw_sha256 !== candidate.raw_sha256
    ))
  ) {
    throw new Error("facet_v2_native_authority_drift");
  }
}

function resultFromExecution(
  base: FacetDesignFrappeProjectionResult,
  execution: EffectExecutionResult<ProjectionResponse>,
): FacetDesignFrappeProjectionResult {
  const value = isRecord(execution.value) ? execution.value : null;
  const outcome: FacetDesignFrappeProjectionOutcome = execution.effect.state === "succeeded"
    ? "succeeded"
    : execution.effect.state === "failed"
      ? "rejected"
      : "uncertain";
  return {
    ...base,
    outcome,
    draftQuoteVersion: isSafeInteger(value?.draft_quote_version) ? value.draft_quote_version : null,
    idempotentReplay: typeof value?.idempotent_replay === "boolean" ? value.idempotent_replay : null,
    receipt: isRecord(value?.receipt) ? value.receipt : null,
    errorCode: execution.effect.result_code,
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "facet_design_projection_unexpected_error";
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameExpected(expected: Record<string, unknown>, observed: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => Object.is(observed[key], value));
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

async function hmacBase64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  )));
}

async function verifyHmacBase64Url(secret: string, value: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const normalized = signature.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((signature.length + 3) % 4);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  } catch {
    return false;
  }
  return await crypto.subtle.verify(
    "HMAC",
    key,
    bytes,
    new TextEncoder().encode(value),
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
