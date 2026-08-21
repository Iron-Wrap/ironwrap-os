import { sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";
import { canonicalJson } from "./facet-design-v2-protocol.ts";
import {
  facetLaunchIntentSha256,
  resolveFacetLaunchTarget,
  type FacetLaunchTarget,
} from "./facet-launch.ts";

const PROJECTION_BATCH_SIZE = 25;
const MAX_DECISION_CHAIN_LENGTH = 100;

type DecisionKind = "approved" | "corrected" | "superseded" | "withdrawn";
type ProjectionOutcome =
  | "projected_native_design"
  | "reconciled_native_design"
  | "uncertain"
  | "rejected"
  | "held_withdrawn"
  | "held_superseded";

interface StoredFacetV2Decision {
  event_id: string;
  event_type: "facet.design.customer_approved.v2";
  schema_version: 2;
  event_body_sha256: string;
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
  prior_uncertain_count: number;
}

type DecisionChainRow = Pick<
  StoredFacetV2Decision,
  | "event_id"
  | "event_type"
  | "schema_version"
  | "event_body_sha256"
  | "issuer"
  | "source_product"
  | "source_environment"
  | "source_tenant_id"
  | "destination_tenant_id"
  | "brand_id"
  | "facet_project_id"
  | "external_project_link_id"
  | "producer_identity_link_id"
  | "association_sha256"
  | "roof_job_id"
  | "customer_quote_id"
  | "customer_party_ref"
  | "external_customer_identity_link_id"
  | "oidc_issuer"
  | "oidc_subject_sha256"
  | "identity_assurance"
  | "decision_kind"
  | "previous_event_id"
  | "reason_sha256"
  | "approval_receipt_id"
  | "approval_receipt_sha256"
  | "design_revision_id"
  | "design_revision_sha256"
  | "frozen_evidence_sha256"
  | "raw_key"
  | "raw_sha256"
  | "raw_content_length"
  | "occurred_at"
  | "received_at"
>;

interface StoredFacetLaunch {
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

interface ResolvedNativeLaunch {
  target: FacetLaunchTarget;
  launchIntentSha256: string;
}

interface NativeDesignProjection {
  outcome: Extract<
    ProjectionOutcome,
    | "projected_native_design"
    | "reconciled_native_design"
    | "held_withdrawn"
    | "held_superseded"
  >;
  projectionId: string;
  projectionSha256: string;
  destinationTenantId: string;
  sourceTenantId: string;
  brandId: string;
  facetProjectId: string;
  externalProjectLinkId: string;
  producerIdentityLinkId: string;
  externalCustomerIdentityLinkId: string;
  roofJobId: string;
  customerId: string;
  customerQuoteId: string;
  sourceQuoteRevisionId: string;
  sourceQuoteVersion: number;
  sourceQuoteApprovedAt: string;
  sourceProposalRevisionId: string;
  sourceProposalPackId: string;
  sourcePublicationEventId: string;
  sourceAcceptanceBindingId: string;
  sourceAcceptanceId: string;
  sourceAcceptanceAcceptedAt: string;
  sourceAcceptanceReceiptHash: string;
  launchIntentSha256: string;
  decisionKind: DecisionKind;
  designSequence: number;
  designState: "active" | "withdrawn" | "superseded";
  previousEventId: string | null;
  designRevisionId: string;
  designRevisionSha256: string;
  frozenEvidenceSha256: string;
  rawSha256: string;
}

interface StoredNativeDesignProjection {
  projection_id: string;
  event_id: string;
  destination_tenant_id: string;
  source_tenant_id: string;
  brand_id: string;
  facet_project_id: string;
  external_project_link_id: string;
  producer_identity_link_id: string;
  external_customer_identity_link_id: string;
  roof_job_id: string;
  customer_id: string;
  customer_quote_id: string;
  source_quote_revision_id: string;
  source_quote_version: number;
  source_quote_approved_at: string;
  source_proposal_revision_id: string;
  source_proposal_pack_id: string;
  source_publication_event_id: string;
  source_acceptance_binding_id: string;
  source_acceptance_id: string;
  source_acceptance_accepted_at: string;
  source_acceptance_receipt_hash: string;
  launch_intent_sha256: string;
  decision_kind: DecisionKind;
  design_sequence: number;
  design_state: "active" | "withdrawn" | "superseded";
  previous_event_id: string | null;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
  raw_sha256: string;
  projection_sha256: string;
  projected_at: string;
}

interface StoredProjectionAttempt {
  attempt_id: string;
  event_id: string;
  outcome: ProjectionOutcome;
  projection_id: string | null;
  projection_sha256: string | null;
  error_code: string | null;
  attempted_at: string;
}

class NativeProjectionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Materialize the current signed-v2 Facet decision head as native design authority.
 *
 * No legacy ERP configuration, secret, effect, or network call is consulted by
 * this implementation.
 */
export async function reconcileFacetDesignNativeProjections(
  env: AppEnv,
  now = new Date(),
): Promise<void> {
  if (String(env.FACET_V2_NATIVE_PROJECTION_ENABLED) !== "true") return;
  for (const event of await listProjectionCandidates(env)) {
    await reconcileOneProjection(env, event, now);
  }
}

async function reconcileOneProjection(
  env: AppEnv,
  event: StoredFacetV2Decision,
  now: Date,
): Promise<void> {
  if (!(await exactAssociationStillMatches(event))) {
    await appendOutcome(env, event, {
      outcome: "rejected",
      errorCode: "facet_v2_authority_drift",
      now,
    });
    return;
  }

  let launch: ResolvedNativeLaunch | null;
  try {
    launch = await exactNativeLaunchTarget(env, event);
  } catch {
    await appendOutcome(env, event, {
      outcome: "uncertain",
      errorCode: "facet_v2_native_authority_read_uncertain",
      now,
    });
    return;
  }
  if (!launch) {
    await appendOutcome(env, event, {
      outcome: "rejected",
      errorCode: "facet_v2_native_commercial_authority_drift",
      now,
    });
    return;
  }

  try {
    const projection = await buildNativeProjection(env, event, launch);
    await appendProjection(env, event, projection, now);
  } catch (error) {
    const deterministicErrorCode = await deterministicProjectionDrift(
      env,
      event,
      error,
    );
    await appendOutcome(env, event, {
      outcome: deterministicErrorCode ? "rejected" : "uncertain",
      errorCode:
        deterministicErrorCode ?? "facet_v2_native_projection_uncertain",
      now,
    });
  }
}

async function deterministicProjectionDrift(
  env: AppEnv,
  event: StoredFacetV2Decision,
  error: unknown,
): Promise<string | null> {
  if (error instanceof NativeProjectionError) return error.code;
  try {
    const child = await env.DB.prepare(
      `SELECT event_id
         FROM facet_v2_customer_decisions
        WHERE previous_event_id = ?
        LIMIT 1`,
    )
      .bind(event.event_id)
      .first<{ event_id: string }>();
    if (child) return "facet_v2_native_decision_not_current";

    const revocation = await env.DB.prepare(
      `SELECT revocation_id
         FROM facet_v2_link_revocations
        WHERE destination_tenant_id = ?
          AND ((link_kind = 'project' AND link_id = ?)
            OR (link_kind = 'producer_identity' AND link_id = ?)
            OR (link_kind = 'customer_identity' AND link_id = ?))
        LIMIT 1`,
    )
      .bind(
        event.destination_tenant_id,
        event.external_project_link_id,
        event.producer_identity_link_id,
        event.external_customer_identity_link_id,
      )
      .first<{ revocation_id: string }>();
    if (revocation) return "facet_v2_authority_drift";

    if (!(await exactNativeLaunchTarget(env, event))) {
      return "facet_v2_native_commercial_authority_drift";
    }
  } catch {
    return null;
  }
  return null;
}

async function listProjectionCandidates(
  env: AppEnv,
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
              WHERE (revoked.link_kind = 'project'
                     AND revoked.link_id = decision.external_project_link_id)
                 OR (revoked.link_kind = 'producer_identity'
                     AND revoked.link_id = decision.producer_identity_link_id)
                 OR (revoked.link_kind = 'customer_identity'
                     AND revoked.link_id = decision.external_customer_identity_link_id))
              AS revoked_link_count,
            (SELECT COUNT(*) FROM facet_v2_native_projection_attempts AS prior
              WHERE prior.event_id = decision.event_id
                AND prior.outcome = 'uncertain') AS prior_uncertain_count
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
         SELECT 1 FROM facet_v2_native_projection_attempts AS attempt
         WHERE attempt.event_id = decision.event_id
           AND attempt.outcome IN ('projected_native_design',
                                   'reconciled_native_design', 'rejected',
                                   'held_withdrawn',
                                   'held_superseded')
       )
       ORDER BY decision.occurred_at ASC, decision.event_id ASC
       LIMIT ?`,
  )
    .bind(PROJECTION_BATCH_SIZE)
    .all<StoredFacetV2Decision>();
  return result.results ?? [];
}

async function exactAssociationStillMatches(
  event: StoredFacetV2Decision,
): Promise<boolean> {
  if (!validStoredDecision(event)) return false;
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

async function exactNativeLaunchTarget(
  env: AppEnv,
  event: StoredFacetV2Decision,
): Promise<ResolvedNativeLaunch | null> {
  const launch = await env.DB.prepare(
    `SELECT facet_project_id, external_project_link_id, destination_tenant_id,
            source_tenant_id, brand_id, roof_job_id, customer_quote_id,
            quote_version, quote_approved_at, customer_party_ref,
            external_customer_identity_link_id, issued_by_user_id,
            launch_intent_sha256
       FROM facet_v2_project_launches
      WHERE destination_tenant_id = ? AND facet_project_id = ?
      LIMIT 1`,
  )
    .bind(event.destination_tenant_id, event.facet_project_id)
    .first<StoredFacetLaunch>();
  if (!launch) return null;

  const resolved = await resolveFacetLaunchTarget(
    env,
    event.destination_tenant_id,
    event.roof_job_id,
  );
  if (!resolved.ok) return null;
  const target = resolved.value;
  const intent = await facetLaunchIntentSha256({
    target,
    destinationTenantId: event.destination_tenant_id,
    sourceTenantId: event.source_tenant_id,
    issuedByUserId: launch.issued_by_user_id,
  });
  return launch.facet_project_id === event.facet_project_id &&
    launch.external_project_link_id === event.external_project_link_id &&
    launch.destination_tenant_id === event.destination_tenant_id &&
    launch.source_tenant_id === event.source_tenant_id &&
    launch.brand_id === event.brand_id &&
    launch.brand_id === target.brandId &&
    launch.roof_job_id === event.roof_job_id &&
    launch.roof_job_id === target.roofJobId &&
    launch.customer_quote_id === event.customer_quote_id &&
    launch.customer_quote_id === target.customerQuoteId &&
    Number(launch.quote_version) === target.quoteVersion &&
    launch.quote_approved_at === target.quoteApprovedAt &&
    launch.customer_party_ref === event.customer_party_ref &&
    launch.customer_party_ref === target.customerPartyRef &&
    launch.external_customer_identity_link_id ===
      event.external_customer_identity_link_id &&
    launch.external_customer_identity_link_id ===
      target.externalCustomerIdentityLinkId &&
    launch.launch_intent_sha256 === intent
    ? { target, launchIntentSha256: intent }
    : null;
}

async function buildNativeProjection(
  env: AppEnv,
  event: StoredFacetV2Decision,
  launch: ResolvedNativeLaunch,
): Promise<NativeDesignProjection> {
  const chain = await loadDecisionChain(env, event);
  if (!chain)
    throw new NativeProjectionError("facet_v2_native_decision_chain_invalid");
  const eventHash = await sha256Hex(event.event_id);
  const designState =
    event.decision_kind === "withdrawn"
      ? "withdrawn"
      : event.decision_kind === "superseded"
        ? "superseded"
        : "active";
  const projection = {
    projectionId: `facet-native-design-v2:${eventHash}`,
    destinationTenantId: event.destination_tenant_id,
    sourceTenantId: event.source_tenant_id,
    brandId: event.brand_id,
    facetProjectId: event.facet_project_id,
    externalProjectLinkId: event.external_project_link_id,
    producerIdentityLinkId: event.producer_identity_link_id,
    externalCustomerIdentityLinkId: event.external_customer_identity_link_id,
    roofJobId: event.roof_job_id,
    customerId: launch.target.customerId,
    customerQuoteId: event.customer_quote_id,
    sourceQuoteRevisionId: launch.target.quoteRevisionId,
    sourceQuoteVersion: launch.target.quoteVersion,
    sourceQuoteApprovedAt: launch.target.quoteApprovedAt,
    sourceProposalRevisionId: launch.target.proposalRevisionId,
    sourceProposalPackId: launch.target.proposalPackId,
    sourcePublicationEventId: launch.target.publicationEventId,
    sourceAcceptanceBindingId: launch.target.acceptanceBindingId,
    sourceAcceptanceId: launch.target.acceptanceId,
    sourceAcceptanceAcceptedAt: launch.target.acceptedAt,
    sourceAcceptanceReceiptHash: launch.target.acceptanceReceiptHash,
    launchIntentSha256: launch.launchIntentSha256,
    decisionKind: event.decision_kind,
    designSequence: chain.length,
    designState,
    previousEventId: event.previous_event_id,
    designRevisionId: event.design_revision_id,
    designRevisionSha256: event.design_revision_sha256,
    frozenEvidenceSha256: event.frozen_evidence_sha256,
    rawSha256: event.raw_sha256,
  } as const;
  const projectionSha256 = await sha256Hex(
    canonicalJson({
      schema_version: "ironwrap.facet-native-design-projection.v1",
      ...projection,
    }),
  );
  return {
    ...projection,
    projectionSha256,
    outcome:
      designState === "withdrawn"
        ? "held_withdrawn"
        : designState === "superseded"
          ? "held_superseded"
          : Number(event.prior_uncertain_count) > 0
            ? "reconciled_native_design"
            : "projected_native_design",
  };
}

async function loadDecisionChain(
  env: AppEnv,
  head: StoredFacetV2Decision,
): Promise<DecisionChainRow[] | null> {
  const chain: DecisionChainRow[] = [head];
  const seen = new Set([head.event_id]);
  let previousEventId = head.previous_event_id;
  while (previousEventId) {
    if (seen.has(previousEventId) || chain.length >= MAX_DECISION_CHAIN_LENGTH)
      return null;
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
      .first<DecisionChainRow>();
    if (!previous) return null;
    chain.push(previous);
    seen.add(previous.event_id);
    previousEventId = previous.previous_event_id;
  }
  chain.reverse();
  if (
    chain[0]?.decision_kind !== "approved" ||
    chain[0].previous_event_id !== null
  )
    return null;
  for (let index = 0; index < chain.length; index += 1) {
    const current = chain[index]!;
    const previous = index === 0 ? null : chain[index - 1]!;
    if (
      !validStoredDecision(current) ||
      !sameDecisionAuthority(current, head) ||
      (previous !== null &&
        (current.previous_event_id !== previous.event_id ||
          Date.parse(current.occurred_at) < Date.parse(previous.occurred_at)))
    )
      return null;
    if (!previous) continue;
    const previousWasActive =
      previous.decision_kind === "approved" ||
      previous.decision_kind === "corrected";
    if (!previousWasActive || current.decision_kind === "approved") return null;
    if (
      (current.decision_kind === "withdrawn" ||
        current.decision_kind === "superseded") &&
      index !== chain.length - 1
    )
      return null;
  }
  return chain.at(-1)?.event_id === head.event_id ? chain : null;
}

function validStoredDecision(event: DecisionChainRow): boolean {
  return (
    event.event_type === "facet.design.customer_approved.v2" &&
    Number(event.schema_version) === 2 &&
    event.source_product === "facet" &&
    event.identity_assurance === "oidc" &&
    validSha256(event.event_body_sha256) &&
    event.event_body_sha256 === event.raw_sha256 &&
    validSha256(event.association_sha256) &&
    validSha256(event.customer_party_ref) &&
    validSha256(event.oidc_subject_sha256) &&
    validSha256(event.approval_receipt_sha256) &&
    validSha256(event.design_revision_sha256) &&
    event.design_revision_id ===
      `facet-json-v1:${event.design_revision_sha256}` &&
    validSha256(event.frozen_evidence_sha256) &&
    event.raw_key === `facet-design/v2/raw/${event.raw_sha256}.json` &&
    Number.isSafeInteger(Number(event.raw_content_length)) &&
    Number(event.raw_content_length) >= 2 &&
    Number.isFinite(Date.parse(event.occurred_at)) &&
    Number.isFinite(Date.parse(event.received_at)) &&
    Date.parse(event.received_at) >= Date.parse(event.occurred_at) &&
    (event.decision_kind === "approved"
      ? event.previous_event_id === null && event.reason_sha256 === null
      : event.previous_event_id !== null && validSha256(event.reason_sha256))
  );
}

function sameDecisionAuthority(
  left: DecisionChainRow,
  right: DecisionChainRow,
): boolean {
  return (
    left.issuer === right.issuer &&
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
    left.external_customer_identity_link_id ===
      right.external_customer_identity_link_id &&
    left.oidc_issuer === right.oidc_issuer &&
    left.oidc_subject_sha256 === right.oidc_subject_sha256 &&
    left.identity_assurance === right.identity_assurance
  );
}

async function appendOutcome(
  env: AppEnv,
  event: StoredFacetV2Decision,
  input: {
    outcome: Extract<ProjectionOutcome, "rejected" | "uncertain">;
    errorCode: string;
    now: Date;
  },
): Promise<void> {
  if (await finalizedProjectionAttempt(env, event.event_id)) return;
  const attemptId = await projectionAttemptId(
    event.event_id,
    input.outcome,
    input.errorCode,
  );
  const expected = {
    attempt_id: attemptId,
    event_id: event.event_id,
    outcome: input.outcome,
    projection_id: null,
    projection_sha256: null,
    error_code: input.errorCode,
    attempted_at: input.now.toISOString(),
  } satisfies StoredProjectionAttempt;
  try {
    await env.DB.prepare(
      `INSERT INTO facet_v2_native_projection_attempts
       (attempt_id, event_id, outcome, projection_id, projection_sha256,
        error_code, attempted_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
    )
      .bind(
        expected.attempt_id,
        expected.event_id,
        expected.outcome,
        expected.error_code,
        expected.attempted_at,
      )
      .run();
  } catch {
    // An exact deterministic rejection may have won a concurrent insert.
  }
  const stored = await projectionAttempt(env, attemptId);
  if (!stored || !sameProjectionAttempt(stored, expected)) {
    throw new Error("facet_v2_native_projection_write_conflict");
  }
}

async function appendProjection(
  env: AppEnv,
  event: StoredFacetV2Decision,
  projection: NativeDesignProjection,
  now: Date,
): Promise<void> {
  const expectedProjection = storedProjection(event, projection, now);
  const attemptId = await projectionAttemptId(
    event.event_id,
    projection.outcome,
  );
  const expectedAttempt = {
    attempt_id: attemptId,
    event_id: event.event_id,
    outcome: projection.outcome,
    projection_id: projection.projectionId,
    projection_sha256: projection.projectionSha256,
    error_code: null,
    attempted_at: now.toISOString(),
  } satisfies StoredProjectionAttempt;
  let writeError: unknown;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO facet_v2_native_design_projections
         (projection_id, event_id, destination_tenant_id, source_tenant_id,
          brand_id, facet_project_id, external_project_link_id,
          producer_identity_link_id, external_customer_identity_link_id,
          roof_job_id, customer_id, customer_quote_id,
          source_quote_revision_id, source_quote_version,
          source_quote_approved_at, source_proposal_revision_id,
          source_proposal_pack_id, source_publication_event_id,
          source_acceptance_binding_id, source_acceptance_id,
          source_acceptance_accepted_at, source_acceptance_receipt_hash,
          launch_intent_sha256, decision_kind, design_sequence, design_state,
          previous_event_id, design_revision_id, design_revision_sha256,
          frozen_evidence_sha256, raw_sha256, projection_sha256, projected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        expectedProjection.projection_id,
        expectedProjection.event_id,
        expectedProjection.destination_tenant_id,
        expectedProjection.source_tenant_id,
        expectedProjection.brand_id,
        expectedProjection.facet_project_id,
        expectedProjection.external_project_link_id,
        expectedProjection.producer_identity_link_id,
        expectedProjection.external_customer_identity_link_id,
        expectedProjection.roof_job_id,
        expectedProjection.customer_id,
        expectedProjection.customer_quote_id,
        expectedProjection.source_quote_revision_id,
        expectedProjection.source_quote_version,
        expectedProjection.source_quote_approved_at,
        expectedProjection.source_proposal_revision_id,
        expectedProjection.source_proposal_pack_id,
        expectedProjection.source_publication_event_id,
        expectedProjection.source_acceptance_binding_id,
        expectedProjection.source_acceptance_id,
        expectedProjection.source_acceptance_accepted_at,
        expectedProjection.source_acceptance_receipt_hash,
        expectedProjection.launch_intent_sha256,
        expectedProjection.decision_kind,
        expectedProjection.design_sequence,
        expectedProjection.design_state,
        expectedProjection.previous_event_id,
        expectedProjection.design_revision_id,
        expectedProjection.design_revision_sha256,
        expectedProjection.frozen_evidence_sha256,
        expectedProjection.raw_sha256,
        expectedProjection.projection_sha256,
        expectedProjection.projected_at,
      ),
      env.DB.prepare(
        `INSERT INTO facet_v2_native_projection_attempts
         (attempt_id, event_id, outcome, projection_id, projection_sha256,
          error_code, attempted_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(
        expectedAttempt.attempt_id,
        expectedAttempt.event_id,
        expectedAttempt.outcome,
        expectedAttempt.projection_id,
        expectedAttempt.projection_sha256,
        expectedAttempt.attempted_at,
      ),
    ]);
  } catch (error) {
    writeError = error;
  }
  const [persistedProjection, persistedAttempt] = await Promise.all([
    nativeDesignProjection(env, projection.projectionId),
    projectionAttempt(env, attemptId),
  ]);
  if (!persistedProjection || !persistedAttempt) {
    if (writeError) throw writeError;
    throw new Error("facet_v2_native_projection_write_incomplete");
  }
  if (
    !sameNativeDesignProjection(persistedProjection, expectedProjection) ||
    !sameProjectionAttempt(persistedAttempt, expectedAttempt)
  ) {
    throw new NativeProjectionError(
      "facet_v2_native_projection_write_conflict",
    );
  }
}

function storedProjection(
  event: StoredFacetV2Decision,
  projection: NativeDesignProjection,
  now: Date,
): StoredNativeDesignProjection {
  return {
    projection_id: projection.projectionId,
    event_id: event.event_id,
    destination_tenant_id: projection.destinationTenantId,
    source_tenant_id: projection.sourceTenantId,
    brand_id: projection.brandId,
    facet_project_id: projection.facetProjectId,
    external_project_link_id: projection.externalProjectLinkId,
    producer_identity_link_id: projection.producerIdentityLinkId,
    external_customer_identity_link_id:
      projection.externalCustomerIdentityLinkId,
    roof_job_id: projection.roofJobId,
    customer_id: projection.customerId,
    customer_quote_id: projection.customerQuoteId,
    source_quote_revision_id: projection.sourceQuoteRevisionId,
    source_quote_version: projection.sourceQuoteVersion,
    source_quote_approved_at: projection.sourceQuoteApprovedAt,
    source_proposal_revision_id: projection.sourceProposalRevisionId,
    source_proposal_pack_id: projection.sourceProposalPackId,
    source_publication_event_id: projection.sourcePublicationEventId,
    source_acceptance_binding_id: projection.sourceAcceptanceBindingId,
    source_acceptance_id: projection.sourceAcceptanceId,
    source_acceptance_accepted_at: projection.sourceAcceptanceAcceptedAt,
    source_acceptance_receipt_hash: projection.sourceAcceptanceReceiptHash,
    launch_intent_sha256: projection.launchIntentSha256,
    decision_kind: projection.decisionKind,
    design_sequence: projection.designSequence,
    design_state: projection.designState,
    previous_event_id: projection.previousEventId,
    design_revision_id: projection.designRevisionId,
    design_revision_sha256: projection.designRevisionSha256,
    frozen_evidence_sha256: projection.frozenEvidenceSha256,
    raw_sha256: projection.rawSha256,
    projection_sha256: projection.projectionSha256,
    projected_at: now.toISOString(),
  };
}

async function nativeDesignProjection(
  env: AppEnv,
  projectionId: string,
): Promise<StoredNativeDesignProjection | null> {
  return await env.DB.prepare(
    `SELECT * FROM facet_v2_native_design_projections
      WHERE projection_id = ? LIMIT 1`,
  )
    .bind(projectionId)
    .first<StoredNativeDesignProjection>();
}

async function projectionAttempt(
  env: AppEnv,
  attemptId: string,
): Promise<StoredProjectionAttempt | null> {
  return await env.DB.prepare(
    `SELECT attempt_id, event_id, outcome, projection_id, projection_sha256,
            error_code, attempted_at
       FROM facet_v2_native_projection_attempts
      WHERE attempt_id = ? LIMIT 1`,
  )
    .bind(attemptId)
    .first<StoredProjectionAttempt>();
}

async function finalizedProjectionAttempt(
  env: AppEnv,
  eventId: string,
): Promise<StoredProjectionAttempt | null> {
  return await env.DB.prepare(
    `SELECT attempt_id, event_id, outcome, projection_id, projection_sha256,
            error_code, attempted_at
       FROM facet_v2_native_projection_attempts
      WHERE event_id = ? AND outcome <> 'uncertain'
      LIMIT 1`,
  )
    .bind(eventId)
    .first<StoredProjectionAttempt>();
}

async function projectionAttemptId(
  eventId: string,
  outcome: ProjectionOutcome,
  errorCode?: string,
): Promise<string> {
  const eventHash = await sha256Hex(eventId);
  if (outcome === "uncertain") {
    if (!errorCode)
      throw new Error("facet_v2_native_uncertainty_code_required");
    return `facet-native-projection-v2:${eventHash}:uncertain:${await sha256Hex(errorCode)}`;
  }
  if (outcome === "rejected")
    return `facet-native-projection-v2:${eventHash}:rejected`;
  return `facet-native-projection-v2:${eventHash}:success`;
}

function sameProjectionAttempt(
  stored: StoredProjectionAttempt,
  expected: StoredProjectionAttempt,
): boolean {
  const successOutcomes: ProjectionOutcome[] = [
    "projected_native_design",
    "reconciled_native_design",
  ];
  const outcomeMatches =
    stored.outcome === expected.outcome ||
    (successOutcomes.includes(stored.outcome) &&
      successOutcomes.includes(expected.outcome));
  return (
    stored.attempt_id === expected.attempt_id &&
    stored.event_id === expected.event_id &&
    outcomeMatches &&
    stored.projection_id === expected.projection_id &&
    stored.projection_sha256 === expected.projection_sha256 &&
    stored.error_code === expected.error_code
  );
}

function sameNativeDesignProjection(
  stored: StoredNativeDesignProjection,
  expected: StoredNativeDesignProjection,
): boolean {
  return (
    stored.projection_id === expected.projection_id &&
    stored.event_id === expected.event_id &&
    stored.destination_tenant_id === expected.destination_tenant_id &&
    stored.source_tenant_id === expected.source_tenant_id &&
    stored.brand_id === expected.brand_id &&
    stored.facet_project_id === expected.facet_project_id &&
    stored.external_project_link_id === expected.external_project_link_id &&
    stored.producer_identity_link_id === expected.producer_identity_link_id &&
    stored.external_customer_identity_link_id ===
      expected.external_customer_identity_link_id &&
    stored.roof_job_id === expected.roof_job_id &&
    stored.customer_id === expected.customer_id &&
    stored.customer_quote_id === expected.customer_quote_id &&
    stored.source_quote_revision_id === expected.source_quote_revision_id &&
    Number(stored.source_quote_version) === expected.source_quote_version &&
    stored.source_quote_approved_at === expected.source_quote_approved_at &&
    stored.source_proposal_revision_id ===
      expected.source_proposal_revision_id &&
    stored.source_proposal_pack_id === expected.source_proposal_pack_id &&
    stored.source_publication_event_id ===
      expected.source_publication_event_id &&
    stored.source_acceptance_binding_id ===
      expected.source_acceptance_binding_id &&
    stored.source_acceptance_id === expected.source_acceptance_id &&
    stored.source_acceptance_accepted_at ===
      expected.source_acceptance_accepted_at &&
    stored.source_acceptance_receipt_hash ===
      expected.source_acceptance_receipt_hash &&
    stored.launch_intent_sha256 === expected.launch_intent_sha256 &&
    stored.decision_kind === expected.decision_kind &&
    Number(stored.design_sequence) === expected.design_sequence &&
    stored.design_state === expected.design_state &&
    stored.previous_event_id === expected.previous_event_id &&
    stored.design_revision_id === expected.design_revision_id &&
    stored.design_revision_sha256 === expected.design_revision_sha256 &&
    stored.frozen_evidence_sha256 === expected.frozen_evidence_sha256 &&
    stored.raw_sha256 === expected.raw_sha256 &&
    stored.projection_sha256 === expected.projection_sha256
  );
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
