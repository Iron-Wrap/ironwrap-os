import type { AppEnv } from "./app-types.ts";
import {
  parseFacetV2CustomerDecisionEvent,
  type FacetV2CustomerDecisionEvent,
} from "./facet-design-v2-protocol.ts";
import {
  loadFacetEstimatorReadyEvent,
  resolveFacetEstimatorReadyAnchor,
  type FacetEstimatorReadyAnchor,
} from "./facet-prequote.ts";
import type { GeometryModel } from "./geometry.ts";
import { parseMeasurementSubmission, extractGeometry } from "./measurements.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { approvedPricingPolicySnapshot, priceTakeoff, type PriceList } from "./pricing.ts";
import { PricingCatalogError, pricingCatalogEnabled, selectCatalogPricingForImport } from "./pricing-catalog.ts";
import { deriveRoofGraph } from "./roof-graph.ts";
import {
  ESTIMATOR_EVIDENCE_SCHEMA_VERSION,
  EstimatorNativeStoreError,
  readEstimatorEvidenceHead,
  readEstimatorEvidenceRevisionByIdempotencyKey,
  readCurrentEstimatorCommercialQuoteAnchor,
  readEstimatorMeasurementEvidenceAnchor,
  recordEstimatorEvidenceRevision,
  type EstimatorEvidencePayloadV1,
  type EstimatorEvidenceRevisionRecord,
  type EstimatorMeasurementAnchor,
  type EstimatorMeasurementEvidenceAnchor,
} from "./estimator-native-store.ts";
import { readNativeJobCore } from "./native-job-packet-read.ts";
import { takeoffFromGeometry, type TakeoffModel } from "./takeoff.ts";

const MAX_NATIVE_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_MEASUREMENT_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_ESTIMATOR_EXTENSION_ROWS = 100;
const MAX_TEXT = 2_000;
const PRICE_AUTHORITY_CONTRACT = canonicalJson({
  operation: "bind_canonical_pricing_snapshot",
  schema_version: "ironwrap.price-policy-authority.v1",
});

type NativeRow = Record<string, unknown>;

interface FacetDecisionAnchor {
  event_id: string;
  raw_key: string;
  raw_sha256: string;
  design_revision_id: string;
  design_revision_sha256: string;
  frozen_evidence_sha256: string;
}

type FacetVisualEvidence = {
  design_revision: { id: string; sha256: string };
  occurred_at: string;
};

interface ImportingActor {
  user_id: string;
  email_normalized: string;
  role: string;
  active: number;
}

export interface ImportEstimatorEvidenceInput {
  tenantId: string;
  roofJobId: string;
  measurementReceiptId: string;
  facetEventId?: string | null;
  estimatorReadyEventId?: string | null;
  commercialQuoteRevisionId?: string | null;
  revisionNumber: number;
  supersedesEstimatorRevisionId?: string | null;
  correctionReason?: string | null;
  importedByUserId: string;
  idempotencyKey: string;
}

export interface NativeEstimatorSources {
  estimatorRevisionId: string | null;
  estimatorCreatedAt: string | null;
  job: NativeRow;
  measurementRows: NativeRow[];
  visualModelRows: NativeRow[];
  roofAreaRows: NativeRow[];
  takeoffRows: NativeRow[];
  changeOrderRows: NativeRow[];
  insuranceSupplementRows: NativeRow[];
  scopeRows: NativeRow[];
  pricingAuthorityRows: NativeRow[];
  supplierQuoteRows: NativeRow[];
  supplierOrderRows: NativeRow[];
  materialLotRows: NativeRow[];
  shopOrderRows: NativeRow[];
  fieldCheckinRows: NativeRow[];
  paymentMilestoneRows: NativeRow[];
  jobCostEventRows: NativeRow[];
  accountingReconciliationRows: NativeRow[];
  staleFields: string[];
  partialSources: string[];
}

export type NativeEstimatorAuthority =
  | {
      state: "missing" | "ambiguous" | "stale";
      revision: EstimatorEvidenceRevisionRecord | null;
      payload: null;
      geometry: null;
      takeoff: null;
      rawText: null;
      reasons: string[];
      competingRevisionIds: string[];
    }
  | {
      state: "current";
      revision: EstimatorEvidenceRevisionRecord;
      payload: EstimatorEvidencePayloadV1;
      geometry: GeometryModel;
      takeoff: TakeoffModel;
      rawText: string;
      reasons: [];
      competingRevisionIds: [];
    };

/**
 * Import a bounded Estimator projection from immutable native evidence. The
 * request selects source ids only; browsers cannot submit measurement, visual,
 * takeoff, scope, insurance, or pricing facts.
 */
export async function importEstimatorEvidenceFromNativeSources(
  env: AppEnv,
  input: ImportEstimatorEvidenceInput,
  now = new Date(),
): Promise<{
  kind: "created" | "replayed";
  revision: EstimatorEvidenceRevisionRecord;
}> {
  const replay = await readEstimatorEvidenceRevisionByIdempotencyKey(
    env,
    input.tenantId,
    input.idempotencyKey,
  );
  if (replay) {
    assertReplayMatches(replay, input);
    return { kind: "replayed", revision: replay };
  }
  if (!env.DB) fail("estimator_db_unavailable", 503);
  const core = await readNativeJobCore(env, input.tenantId, input.roofJobId);
  if (!core) fail("estimator_job_missing", 404);
  const [measurementEvidence, actor, facet, estimatorReady] = await Promise.all([
    readEstimatorMeasurementEvidenceAnchor(
      env,
      input.tenantId,
      input.measurementReceiptId,
    ),
    firstRow<ImportingActor>(
      env,
      `SELECT user_id, email_normalized, COALESCE(access_role, role) role, active FROM app_users
        WHERE tenant_id = ? AND user_id = ? LIMIT 1`,
      input.tenantId,
      input.importedByUserId,
    ),
    input.facetEventId
      ? firstRow<FacetDecisionAnchor>(
          env,
          `SELECT event_id, raw_key, raw_sha256, design_revision_id,
                  design_revision_sha256, frozen_evidence_sha256
             FROM facet_v2_customer_decisions
            WHERE destination_tenant_id = ? AND roof_job_id = ? AND event_id = ?
            LIMIT 1`,
          input.tenantId,
          input.roofJobId,
          input.facetEventId,
        )
      : Promise.resolve(null),
    input.estimatorReadyEventId
      ? resolveFacetEstimatorReadyAnchor(
          env,
          input.tenantId,
          input.roofJobId,
          input.estimatorReadyEventId,
        )
      : Promise.resolve(null),
  ]);
  const receipt = measurementEvidence?.receipt ?? null;
  if (
    !receipt ||
    !receipt.completed_at ||
    !["matched", "unmatched"].includes(receipt.status)
  ) {
    fail("estimator_measurement_not_complete");
  }
  if (!core.job.job_number || receipt.job_number !== core.job.job_number) {
    fail("estimator_measurement_job_mismatch");
  }
  if (!actor || actor.active !== 1 || actor.role !== "owner") {
    fail("estimator_import_owner_required", 403);
  }
  if (input.facetEventId && !facet) fail("estimator_facet_head_mismatch");
  if (input.facetEventId && input.estimatorReadyEventId) {
    fail("estimator_facet_ready_sources_conflict");
  }
  if (input.estimatorReadyEventId && !estimatorReady) {
    fail("estimator_ready_head_mismatch");
  }
  if (input.estimatorReadyEventId && input.commercialQuoteRevisionId) {
    fail("estimator_ready_quote_forbidden");
  }

  await verifyMeasurementSupplementalEvidence(env, measurementEvidence!);
  const measurementSource = await verifiedJsonSource(
    env,
    receipt.raw_key,
    receipt.payload_hash,
    "estimator_measurement_source",
  );
  const submission = parseMeasurementSubmission(measurementSource.value);
  if (!submission.jobNumber || submission.jobNumber !== core.job.job_number) {
    fail("estimator_measurement_payload_job_mismatch");
  }
  const geometry = extractGeometry(
    measurementSource.text,
    measurementSource.value,
  );
  if (!geometry) fail("estimator_measurement_geometry_missing");
  const takeoff = takeoffFromGeometry(geometry);
  const geometrySha256 = await sha256Hex(canonicalJson(geometry));
  const takeoffSha256 = await sha256Hex(canonicalJson(takeoff));
  const roofGraph = deriveRoofGraph({
    geometry,
    rawKey: receipt.raw_key,
    rawSha256: receipt.payload_hash,
    provider: receipt.provider,
    ingestedAt: receipt.completed_at,
  });
  const facetEvent = facet
    ? await verifiedFacetEvent(env, facet, input.tenantId)
    : null;
  const estimatorReadyEvent = estimatorReady
    ? await verifiedEstimatorReadyEvent(env, estimatorReady, input.tenantId, input.roofJobId)
    : null;
  const extension = estimatorExtension(
    measurementSource.value,
    input.roofJobId,
    receipt,
  );
  const catalogEnabled = pricingCatalogEnabled(env);
  const selectedPricing = catalogEnabled
    ? await selectCatalogPricingForImport(env, input.tenantId, now)
    : null;
  if (selectedPricing) {
    try {
      const priced = priceTakeoff(takeoff, selectedPricing.list, {
        authority: selectedPricing.authority,
        pricedAt: selectedPricing.pricedAt,
      });
      if (priced.unpricedProfiles.length)
        throw new PricingCatalogError("pricing_catalog_missing_rates");
    } catch (error) {
      // Only the calculator's explicit missing-category refusals are catalog
      // blockers. Invalid quantities, overflow, and unexpected errors remain failures.
      if (error instanceof TypeError && (
        /^priceList\.trims\.[A-Za-z0-9][A-Za-z0-9._:-]{0,127}: approved pricing requires an explicit rate for every nonzero trim category$/.test(error.message) ||
        /^priceList\.fasteners\.(clips|clipScrews|trimScrews): approved pricing requires an explicit rate for every nonzero fastener category$/.test(error.message) ||
        error.message === "priceList.labor: approved pricing requires an explicit rate for nonzero labor quantity"
      )) {
        const blocker = new PricingCatalogError("pricing_catalog_missing_rates");
        blocker.message = `${blocker.code}: ${error.message}`;
        blocker.cause = error;
        throw blocker;
      }
      throw error;
    }
  }
  const pricingAuthority = catalogEnabled
    ? (selectedPricing?.rule ?? null)
    : await nativePricingAuthority(env, input.tenantId, actor, now);
  const measurementName = receipt.measurement_id;
  const takeoffName = `takeoff:${takeoffSha256}`;
  const measurementNeedsReview =
    geometry.needsReview ||
    Number(receipt.ocr_review_required) === 1 ||
    measurementEvidence!.deltaRows.some((row) => Number(row.ok) !== 1);
  const payload: EstimatorEvidencePayloadV1 = {
    schema_version: ESTIMATOR_EVIDENCE_SCHEMA_VERSION,
    measurement: {
      name: measurementName,
      measurement_id: receipt.measurement_id,
      roof_job: input.roofJobId,
      provider: receipt.provider,
      review_status: measurementNeedsReview ? "Needs Review" : "Parsed",
      parsed_at: receipt.completed_at,
      approved_at: null,
      raw_key: receipt.raw_key,
      raw_sha256: receipt.payload_hash,
      geometry_sha256: geometrySha256,
      roof_graph_revision: roofGraph.revision,
      modified: receipt.completed_at,
      measurements: measurementMetricRows(geometry),
      native_evidence: measurementEvidence!.projection,
    },
    visual_model: facetEvent || estimatorReadyEvent
      ? visualModelRow(
          (facetEvent ?? estimatorReadyEvent)!,
          input.roofJobId,
          measurementName,
        )
      : null,
    takeoff: {
      name: takeoffName,
      takeoff_id: takeoffName,
      roof_job: input.roofJobId,
      measurement_report: measurementName,
      status: takeoff.needsReview ? "Needs Review" : "Computed",
      prepared_at: receipt.completed_at,
      approved_at: null,
      modified: receipt.completed_at,
      takeoff_sha256: takeoffSha256,
      totals: takeoff.totals,
      source_refs: takeoff.sourceRefs,
    },
    scope_changes: extension.scope_changes,
    insurance_supplements: extension.insurance_supplements,
    scope_clauses: extension.scope_clauses,
    pricing_authority: pricingAuthority,
  };
  return await recordEstimatorEvidenceRevision(
    env,
    {
      tenantId: input.tenantId,
      roofJobId: input.roofJobId,
      operatingJobVersion: Number(core.job.version),
      revisionNumber: input.revisionNumber,
      supersedesEstimatorRevisionId: input.supersedesEstimatorRevisionId,
      measurementReceiptId: input.measurementReceiptId,
      facetEventId: input.facetEventId,
      estimatorReadyEventId: input.estimatorReadyEventId,
      commercialQuoteRevisionId: input.commercialQuoteRevisionId,
      payload,
      correctionReason: input.correctionReason,
      importedByUserId: input.importedByUserId,
      idempotencyKey: input.idempotencyKey,
    },
    now,
  );
}

/** Resolve and re-verify the one exact current aggregate plus both R2 sources. */
export async function resolveNativeEstimatorAuthority(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  asOf = new Date(),
): Promise<NativeEstimatorAuthority> {
  const head = await readEstimatorEvidenceHead(env, tenantId, roofJobId);
  if (head.state === "missing")
    return unavailable("missing", null, ["estimator_evidence.missing"]);
  if (head.state === "ambiguous") {
    return unavailable(
      "ambiguous",
      null,
      ["estimator_evidence.authority_ambiguous"],
      head.competing_revision_ids,
    );
  }
  const revision = head.revision;
  const reasons: string[] = [];
  const core = await readNativeJobCore(env, tenantId, roofJobId);
  if (
    !core ||
    Number(core.job.version) !== Number(revision.operating_job_version)
  ) {
    reasons.push("estimator_evidence.operating_job_drift");
  }
  let measurementEvidence: EstimatorMeasurementEvidenceAnchor | null = null;
  try {
    measurementEvidence = await readEstimatorMeasurementEvidenceAnchor(
      env,
      tenantId,
      revision.measurement_receipt_id,
    );
  } catch {
    reasons.push("estimator_evidence.measurement_delta_drift");
  }
  const receipt = measurementEvidence?.receipt ?? null;
  if (
    !receipt ||
    receipt.raw_key !== revision.measurement_raw_key ||
    receipt.payload_hash !== revision.measurement_raw_sha256 ||
    receipt.job_number !== core?.job.job_number ||
    !receipt.completed_at ||
    !["matched", "unmatched"].includes(receipt.status)
  ) {
    reasons.push("estimator_evidence.measurement_anchor_drift");
  }
  let payload: EstimatorEvidencePayloadV1 | null = null;
  try {
    const parsed = JSON.parse(revision.payload_json) as unknown;
    if (
      !record(parsed) ||
      parsed.schema_version !== ESTIMATOR_EVIDENCE_SCHEMA_VERSION ||
      canonicalJson(parsed) !== revision.payload_json ||
      (await sha256Hex(revision.payload_json)) !== revision.payload_sha256
    )
      throw new Error("payload");
    payload = parsed as unknown as EstimatorEvidencePayloadV1;
  } catch {
    reasons.push("estimator_evidence.payload_drift");
  }
  if (
    (await sha256Hex(revision.evidence_refs_json)) !== revision.evidence_digest
  ) {
    reasons.push("estimator_evidence.references_drift");
  }
  if (
    measurementEvidence &&
    (!payload ||
      canonicalJson(payload.measurement.native_evidence) !==
        canonicalJson(measurementEvidence.projection))
  ) {
    reasons.push("estimator_evidence.measurement_delta_drift");
  }
  let source: Awaited<ReturnType<typeof verifiedJsonSource>> | null = null;
  let geometry: GeometryModel | null = null;
  let takeoff: TakeoffModel | null = null;
  if (measurementEvidence) {
    try {
      await verifyMeasurementSupplementalEvidence(env, measurementEvidence);
    } catch {
      reasons.push("estimator_evidence.measurement_supplemental_drift");
    }
  }
  if (receipt) {
    try {
      source = await verifiedJsonSource(
        env,
        receipt.raw_key,
        receipt.payload_hash,
        "estimator_measurement_source",
      );
      geometry = extractGeometry(source.text, source.value);
      if (!geometry) throw new Error("geometry");
      takeoff = takeoffFromGeometry(geometry);
      if (
        !payload ||
        text(payload.measurement.geometry_sha256) !==
          (await sha256Hex(canonicalJson(geometry))) ||
        text(payload.takeoff.takeoff_sha256) !==
          (await sha256Hex(canonicalJson(takeoff)))
      )
        throw new Error("digest");
    } catch {
      reasons.push("estimator_evidence.measurement_source_drift");
    }
  }
  if (revision.commercial_quote_revision_id) {
    const quote = await readCurrentEstimatorCommercialQuoteAnchor(
      env,
      tenantId,
      roofJobId,
      revision.commercial_quote_revision_id,
      asOf,
    );
    if (!quote) reasons.push("estimator_evidence.commercial_quote_drift");
  }
  if (revision.facet_event_id) {
    const anchor = await firstRow<FacetDecisionAnchor>(
      env,
      `SELECT event_id, raw_key, raw_sha256, design_revision_id,
              design_revision_sha256, frozen_evidence_sha256
         FROM facet_v2_customer_decisions
        WHERE destination_tenant_id = ? AND roof_job_id = ? AND event_id = ? LIMIT 1`,
      tenantId,
      roofJobId,
      revision.facet_event_id,
    );
    if (
      !anchor ||
      anchor.raw_key !== revision.facet_raw_key ||
      anchor.raw_sha256 !== revision.facet_raw_sha256 ||
      anchor.design_revision_id !== revision.facet_design_revision_id ||
      anchor.design_revision_sha256 !== revision.facet_design_revision_sha256 ||
      anchor.frozen_evidence_sha256 !== revision.facet_frozen_evidence_sha256
    ) {
      reasons.push("estimator_evidence.facet_anchor_drift");
    } else {
      try {
        await verifiedFacetEvent(env, anchor, tenantId);
      } catch {
        reasons.push("estimator_evidence.facet_source_drift");
      }
    }
  }
  if (revision.estimator_ready_event_id) {
    if (revision.commercial_quote_revision_id) {
      reasons.push("estimator_evidence.estimator_ready_quote_drift");
    }
    const anchor = await resolveFacetEstimatorReadyAnchor(
      env,
      tenantId,
      roofJobId,
      revision.estimator_ready_event_id,
    );
    if (
      !anchor ||
      anchor.raw_key !== revision.estimator_ready_raw_key ||
      anchor.event_body_sha256 !== revision.estimator_ready_raw_sha256 ||
      anchor.design_revision_id !== revision.estimator_ready_design_revision_id ||
      anchor.design_revision_sha256 !== revision.estimator_ready_design_revision_sha256 ||
      anchor.frozen_evidence_sha256 !== revision.estimator_ready_frozen_evidence_sha256
    ) {
      reasons.push("estimator_evidence.estimator_ready_anchor_drift");
    } else {
      try {
        await verifiedEstimatorReadyEvent(env, anchor, tenantId, roofJobId);
      } catch {
        reasons.push("estimator_evidence.estimator_ready_source_drift");
      }
    }
  }
  if (reasons.length > 0 || !payload || !source || !geometry || !takeoff) {
    return unavailable("stale", revision, [...new Set(reasons)]);
  }
  return {
    state: "current",
    revision,
    payload,
    geometry,
    takeoff,
    rawText: source.text,
    reasons: [],
    competingRevisionIds: [],
  };
}

/** Adapt the verified aggregate to the existing stable Estimator UI contract. */
export async function readNativeEstimatorSources(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  asOf = new Date(),
): Promise<NativeEstimatorSources | null> {
  const [core, economics] = await Promise.all([
    readNativeJobCore(env, tenantId, roofJobId),
    nativeEstimatorEconomicsRows(env, tenantId, roofJobId),
  ]);
  if (!core) return null;
  const authority = await resolveNativeEstimatorAuthority(
    env,
    tenantId,
    roofJobId,
    asOf,
  );
  const job: NativeRow = {
    name: core.job.roof_job_id,
    roof_job_id: core.job.roof_job_id,
    job_number: core.job.job_number,
    brand: core.job.brand,
    service_type: core.job.service_type,
    job_status: core.job.job_status,
    workflow_profile: core.job.current_gate_state,
    quotation:
      authority.state === "current"
        ? authority.revision.commercial_quote_revision_id
        : null,
    modified: core.job.updated_at,
  };
  if (authority.state !== "current") {
    return {
      job,
      measurementRows: [],
      visualModelRows: [],
      roofAreaRows: [],
      takeoffRows: [],
      changeOrderRows: [],
      insuranceSupplementRows: [],
      scopeRows: [],
      pricingAuthorityRows: [],
      estimatorRevisionId: null,
      estimatorCreatedAt: null,
      ...economics.rows,
      staleFields: authority.reasons,
      partialSources: [
        ...(authority.state === "ambiguous"
          ? ["estimator_evidence_revisions"]
          : []),
        ...economics.partialSources,
      ],
    };
  }
  const measurement = { ...authority.payload.measurement } as NativeRow;
  const takeoffRow = { ...authority.payload.takeoff } as NativeRow;
  const roofGraph = deriveRoofGraph({
    geometry: authority.geometry,
    rawKey: authority.revision.measurement_raw_key,
    rawSha256: authority.revision.measurement_raw_sha256,
    provider: text(measurement.provider) ?? "native_measurement",
    ingestedAt: authority.revision.created_at,
  });
  measurement.roof_graph_json = JSON.stringify(roofGraph);
  measurement.measurements = measurementMetricRows(authority.geometry);
  takeoffRow.items = takeoffItemRows(authority.takeoff);
  const visual = authority.payload.visual_model
    ? ({ ...authority.payload.visual_model } as NativeRow)
    : null;
  const roofAreas =
    visual && Array.isArray(visual.roof_areas)
      ? visual.roof_areas.filter(record).map((row) => ({ ...row }))
      : [];
  if (visual) delete visual.roof_areas;
  return {
    job,
    measurementRows: [measurement],
    visualModelRows: visual ? [visual] : [],
    roofAreaRows: roofAreas,
    takeoffRows: [takeoffRow],
    changeOrderRows: authority.payload.scope_changes.map((row) => ({ ...row })),
    insuranceSupplementRows: authority.payload.insurance_supplements.map(
      (row) => ({ ...row }),
    ),
    scopeRows: authority.payload.scope_clauses.map((row) => ({ ...row })),
    estimatorRevisionId: authority.revision.estimator_revision_id,
    estimatorCreatedAt: authority.revision.created_at,
    pricingAuthorityRows: authority.payload.pricing_authority
      ? [authority.payload.pricing_authority]
      : [],
    ...economics.rows,
    staleFields: [],
    partialSources: economics.partialSources,
  };
}

type NativeEstimatorEconomicsRows = Pick<
  NativeEstimatorSources,
  | "supplierQuoteRows"
  | "supplierOrderRows"
  | "materialLotRows"
  | "shopOrderRows"
  | "fieldCheckinRows"
  | "paymentMilestoneRows"
  | "jobCostEventRows"
  | "accountingReconciliationRows"
>;

async function nativeEstimatorEconomicsRows(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<{
  rows: NativeEstimatorEconomicsRows;
  partialSources: string[];
}> {
  const empty: NativeEstimatorEconomicsRows = {
    supplierQuoteRows: [],
    supplierOrderRows: [],
    materialLotRows: [],
    shopOrderRows: [],
    fieldCheckinRows: [],
    paymentMilestoneRows: [],
    jobCostEventRows: [],
    accountingReconciliationRows: [],
  };
  if (!env.DB) return { rows: empty, partialSources: [] };
  try {
    const [costs, lots, intents, reconciliations] = await Promise.all([
      boundedRows<NativeRow>(
        env,
        `SELECT attribution.attribution_id, attribution.tenant_id, attribution.job_id,
                attribution.quantity_scaled, attribution.value_minor, attribution.currency,
                attribution.basis, attribution.status, attribution.quickbooks_effect_id,
                attribution.evidence_refs_json, attribution.created_at, attribution.updated_at,
                movement.event_id, movement.item_id, movement.lot_id, movement.uom_id,
                movement.occurred_at,
                provider.reconciliation_id, provider.provider, provider.provider_entity_type,
                provider.provider_entity_id, provider.observed_hash_sha256,
                provider.expected_hash_sha256, provider.state AS reconciliation_state,
                provider.updated_at AS reconciliation_updated_at
           FROM inventory_job_cost_attributions AS attribution
           JOIN inventory_events AS movement
             ON movement.tenant_id = attribution.tenant_id
            AND movement.event_id = attribution.event_id
           LEFT JOIN inventory_provider_reconciliations AS provider
             ON provider.tenant_id = attribution.tenant_id
            AND provider.aggregate_type = 'job_cost'
            AND provider.aggregate_id = attribution.attribution_id
          WHERE attribution.tenant_id = ? AND attribution.job_id = ?
          ORDER BY attribution.created_at ASC, attribution.attribution_id ASC`,
        tenantId,
        roofJobId,
      ),
      boundedRows<NativeRow>(
        env,
        `SELECT DISTINCT lot.lot_id, lot.status, lot.updated_at
           FROM inventory_positions AS position
           JOIN inventory_lots AS lot
             ON lot.tenant_id = position.tenant_id AND lot.lot_id = position.lot_id
          WHERE position.tenant_id = ? AND position.job_custody = ?
          ORDER BY lot.updated_at DESC, lot.lot_id ASC`,
        tenantId,
        roofJobId,
      ),
      boundedRows<NativeRow>(
        env,
        `SELECT intent_id, kind, roof_job_id, currency, subtotal, tax_amount,
                total_amount, settled_amount, state, version, provider_entity_type,
                provider_entity_id, observed_sha256, provider_submitted_at,
                provider_reconciled_at, created_at, updated_at
           FROM accounting_intents
          WHERE tenant_id = ? AND roof_job_id = ?
          ORDER BY created_at ASC, intent_id ASC`,
        tenantId,
        roofJobId,
      ),
      boundedRows<NativeRow>(
        env,
        `SELECT reconciliation.reconciliation_id, reconciliation.intent_id,
                reconciliation.expected_sha256, reconciliation.observed_sha256,
                reconciliation.verdict, reconciliation.decided_at,
                intent.roof_job_id, intent.currency,
                observation.entity_type, observation.entity_id, observation.read_at
           FROM accounting_reconciliations AS reconciliation
           JOIN accounting_intents AS intent
             ON intent.tenant_id = reconciliation.tenant_id
            AND intent.intent_id = reconciliation.intent_id
           LEFT JOIN accounting_observations AS observation
             ON observation.observation_id = reconciliation.observation_id
          WHERE reconciliation.tenant_id = ? AND intent.roof_job_id = ?
          ORDER BY reconciliation.decided_at ASC, reconciliation.reconciliation_id ASC`,
        tenantId,
        roofJobId,
      ),
    ]);
    const reconciliationByIntent = new Map<string, NativeRow>();
    for (const row of reconciliations.rows) {
      const intentId = text(row.intent_id);
      if (intentId) reconciliationByIntent.set(intentId, row);
    }
    const accountingReconciliationRows = reconciliations.rows.map((row) => ({
      name: row.reconciliation_id,
      reconciliation_id: row.reconciliation_id,
      roof_job: row.roof_job_id,
      status: row.verdict === "reconciled" ? "Matched" : "Exception",
      system_name: "QuickBooks",
      entity_type: row.entity_type,
      external_entity_id: row.entity_id,
      local_doctype: "Payment Milestone",
      local_name: row.intent_id,
      currency: row.currency,
      source_payload_hash: row.observed_sha256,
      detected_at: row.decided_at,
      modified: row.decided_at,
    }));
    const inventoryReconciliations: NativeRow[] = [];
    const jobCostEventRows = costs.rows.map((row) => {
      const posted =
        row.status === "reconciled" &&
        ["verified", "reconciled"].includes(String(row.reconciliation_state)) &&
        row.observed_hash_sha256 === row.expected_hash_sha256;
      if (posted) {
        inventoryReconciliations.push({
          name: row.reconciliation_id,
          reconciliation_id: row.reconciliation_id,
          roof_job: row.job_id,
          status: "Matched",
          system_name: "QuickBooks",
          entity_type: row.provider_entity_type,
          external_entity_id: row.provider_entity_id,
          local_doctype: "Job Cost Event",
          local_name: row.attribution_id,
          currency: row.currency,
          source_payload_hash: row.observed_hash_sha256,
          detected_at: row.reconciliation_updated_at,
          modified: row.reconciliation_updated_at,
        });
      }
      return {
        name: row.attribution_id,
        job_cost_event_id: row.attribution_id,
        tenant: row.tenant_id,
        roof_job: row.job_id,
        event_kind: "cost",
        category: "Material",
        quantity: String(row.quantity_scaled),
        unit: row.uom_id,
        amount_cents: row.value_minor,
        amount_basis: "Net of Recoverable Tax",
        currency: row.currency,
        source_doctype: "Material Lot",
        source_name: row.lot_id,
        source_digest: null,
        source_evidence: row.evidence_refs_json,
        accounting_state: posted ? "Posted" : "Accrued",
        accounting_system: posted ? "QuickBooks" : null,
        accounting_entity_type: posted ? row.provider_entity_type : null,
        accounting_entity_id: posted ? row.provider_entity_id : null,
        accounting_digest: posted ? row.observed_hash_sha256 : null,
        accounting_posted_at: posted ? row.reconciliation_updated_at : null,
        reconciliation: posted ? row.reconciliation_id : null,
        occurred_at: row.occurred_at,
        recorded_at: row.updated_at,
        modified: row.updated_at,
      };
    });
    const paymentMilestoneRows = intents.rows.map((row) => {
      const reconciliation = reconciliationByIntent.get(String(row.intent_id));
      const matched =
        row.state === "reconciled" && reconciliation?.verdict === "reconciled";
      return {
        name: row.intent_id,
        payment_milestone_id: row.intent_id,
        roof_job: row.roof_job_id,
        milestone_type: accountingMilestoneType(row.kind),
        milestone_version: row.version,
        status: matched ? "Matched" : "Pending",
        currency: row.currency,
        subtotal: row.subtotal,
        tax_amount: row.tax_amount,
        total_amount: row.total_amount,
        settled_amount: row.settled_amount,
        truth_source: matched ? "QuickBooks" : null,
        qb_entity_type: row.provider_entity_type,
        qb_entity_id: row.provider_entity_id,
        recognition_posted_at: matched ? row.provider_reconciled_at : null,
        recognition_digest: matched ? row.observed_sha256 : null,
        recognition_reconciliation: matched
          ? reconciliation?.reconciliation_id
          : null,
        truth_at: matched ? reconciliation?.decided_at : null,
        supersedes: null,
        modified: row.updated_at,
      };
    });
    return {
      rows: {
        supplierQuoteRows: [],
        supplierOrderRows: [],
        materialLotRows: lots.rows.map((row) => ({
          name: row.lot_id,
          roof_job: roofJobId,
          status: row.status,
          modified: row.updated_at,
        })),
        shopOrderRows: [],
        fieldCheckinRows: [],
        paymentMilestoneRows,
        jobCostEventRows,
        accountingReconciliationRows: [
          ...accountingReconciliationRows,
          ...inventoryReconciliations,
        ],
      },
      partialSources: [
        ...(costs.partial ? ["job_cost_events"] : []),
        ...(lots.partial ? ["material_lots"] : []),
        ...(intents.partial ? ["payment_milestones"] : []),
        ...(reconciliations.partial ? ["integration_reconciliations"] : []),
      ],
    };
  } catch (error) {
    if (missingNativeTable(error)) return { rows: empty, partialSources: [] };
    throw error;
  }
}

function accountingMilestoneType(value: unknown): string {
  switch (value) {
    case "payment":
      return "Payment";
    case "credit_memo":
      return "Credit";
    case "refund":
      return "Refund";
    default:
      return "Invoice";
  }
}

async function boundedRows<T>(
  env: AppEnv,
  sql: string,
  tenantId: string,
  roofJobId: string,
  limit = 100,
): Promise<{ rows: T[]; partial: boolean }> {
  const result = await env.DB.prepare(`${sql} LIMIT ?`)
    .bind(tenantId, roofJobId, limit + 1)
    .all<T>();
  const rows = result.results ?? [];
  return { rows: rows.slice(0, limit), partial: rows.length > limit };
}

function missingNativeTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|does not exist/i.test(message);
}

function measurementMetricRows(geometry: GeometryModel): NativeRow[] {
  return Object.entries(geometry.measurements)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 120)
    .map(([metric, value]) => ({
      metric,
      value,
      unit: measurementUnit(metric),
      confidence: "deterministic",
      source_ref: geometry.sourceRefs[metric] ?? null,
      needs_review: geometry.needsReview ? 1 : 0,
    }));
}

function measurementUnit(metric: string): string | null {
  const key = metric.toLowerCase();
  if (key.includes("area")) return "sq ft";
  if (/length|ridge|hip|valley|eave|rake|perimeter/.test(key)) return "ft";
  if (/count|quantity/.test(key)) return "count";
  return null;
}

function takeoffItemRows(takeoff: TakeoffModel): NativeRow[] {
  return [
    {
      category: "Panel",
      item_name: "Standing seam panels",
      quantity: takeoff.totals.panelFt,
      unit: "linear ft",
      waste_factor: takeoff.totals.overage,
      source_ref: takeoff.sourceRefs.panel_total_ft ?? null,
      confidence: "deterministic",
      needs_review: takeoff.needsReview ? 1 : 0,
    },
    ...takeoff.trims.map((trim) => ({
      category: "Trim",
      item_name: trim.profile,
      quantity: trim.sticks,
      unit: "sticks",
      waste_factor: trim.wastePct,
      source_ref: takeoff.sourceRefs[`trim_${trim.profile}_ft`] ?? null,
      confidence: "deterministic",
      needs_review: takeoff.needsReview ? 1 : 0,
    })),
    {
      category: "Fastener",
      item_name: "Clips",
      quantity: takeoff.fasteners.clips,
      unit: "each",
      waste_factor: null,
      source_ref: takeoff.sourceRefs.clips ?? null,
      confidence: "deterministic",
      needs_review: takeoff.needsReview ? 1 : 0,
    },
    {
      category: "Fastener",
      item_name: "Clip screws",
      quantity: takeoff.fasteners.clipScrews,
      unit: "each",
      waste_factor: null,
      source_ref: takeoff.sourceRefs.clips ?? null,
      confidence: "deterministic",
      needs_review: takeoff.needsReview ? 1 : 0,
    },
    {
      category: "Fastener",
      item_name: "Trim screws",
      quantity: takeoff.fasteners.trimScrews,
      unit: "each",
      waste_factor: null,
      source_ref: takeoff.sourceRefs.trim_screws ?? null,
      confidence: "deterministic",
      needs_review: takeoff.needsReview ? 1 : 0,
    },
  ];
}

function visualModelRow(
  event: FacetVisualEvidence,
  roofJobId: string,
  measurementName: string,
): NativeRow {
  const name = event.design_revision.id;
  return {
    name,
    visual_model_id: name,
    roof_job: roofJobId,
    provider: "Facet",
    status: "Approved",
    needs_review: 0,
    confidence: null,
    captured_at: event.occurred_at,
    approved_at: event.occurred_at,
    screenshots_json: "[]",
    modified: event.occurred_at,
    roof_areas: [
      {
        name: `roof-area:${event.design_revision.sha256}`,
        roof_job: roofJobId,
        visual_model: name,
        measurement_report: measurementName,
        modified: event.occurred_at,
      },
    ],
  };
}

function estimatorExtension(
  raw: NativeRow,
  roofJobId: string,
  receipt: EstimatorMeasurementAnchor,
): {
  scope_changes: NativeRow[];
  insurance_supplements: NativeRow[];
  scope_clauses: NativeRow[];
} {
  const extension = record(raw.ironwrap_estimator)
    ? raw.ironwrap_estimator
    : {};
  return {
    scope_changes: sanitizedRows(extension.scope_changes, (row, index) => ({
      name:
        bounded(row.name) ??
        `scope-change:${receipt.payload_hash}:${index + 1}`,
      change_order_id: bounded(row.change_order_id),
      roof_job: roofJobId,
      quotation: bounded(row.quotation),
      change_number: bounded(row.change_number),
      version: integer(row.version),
      status: bounded(row.status),
      title: bounded(row.title),
      reason: bounded(row.reason),
      scope_delta: bounded(row.scope_delta),
      currency: bounded(row.currency),
      subtotal: finite(row.subtotal),
      tax_amount: finite(row.tax_amount),
      total_amount: finite(row.total_amount),
      price_book_version: bounded(row.price_book_version),
      requested_at: timestamp(row.requested_at),
      approved_at: timestamp(row.approved_at),
      accepted_at: timestamp(row.accepted_at),
      correction_reason: bounded(row.correction_reason),
      modified: receipt.completed_at,
    })),
    insurance_supplements: sanitizedRows(
      extension.insurance_supplements,
      (row, index) => ({
        name:
          bounded(row.name) ?? `insurance:${receipt.payload_hash}:${index + 1}`,
        roof_job: roofJobId,
        measurement_report: receipt.measurement_id,
        version: integer(row.version),
        status: bounded(row.status),
        invoice_required: bool(row.invoice_required),
        approved_at: timestamp(row.approved_at),
        submitted_at: timestamp(row.submitted_at),
        carrier_response_at: timestamp(row.carrier_response_at),
        closed_at: timestamp(row.closed_at),
        evidence: sanitizedEvidence(row.evidence),
        modified: receipt.completed_at,
      }),
    ),
    scope_clauses: sanitizedRows(extension.scope_clauses, (row, index) => ({
      name:
        bounded(row.name) ??
        `scope-clause:${receipt.payload_hash}:${index + 1}`,
      scope_clause_id: bounded(row.scope_clause_id),
      roof_job: roofJobId,
      clause_type: bounded(row.clause_type),
      title: bounded(row.title),
      clause_text: bounded(row.clause_text),
      version: bounded(row.version),
      status: bounded(row.status),
      source_ref: bounded(row.source_ref),
      customer_visible: bool(row.customer_visible),
      approved_at: timestamp(row.approved_at),
      modified: receipt.completed_at,
    })),
  };
}

function sanitizedEvidence(value: unknown): NativeRow[] {
  return sanitizedRows(value, (row) => ({
    evidence_role: bounded(row.evidence_role),
    source_ref: bounded(row.source_ref),
  }));
}

function sanitizedRows(
  value: unknown,
  map: (row: NativeRow, index: number) => NativeRow,
): NativeRow[] {
  if (!Array.isArray(value) || value.length > MAX_ESTIMATOR_EXTENSION_ROWS)
    return [];
  return value.filter(record).map(map);
}

async function nativePricingAuthority(
  env: AppEnv,
  tenantId: string,
  actor: ImportingActor,
  now: Date,
): Promise<NativeRow | null> {
  const raw = (env as { ESTIMATOR_PRICE_LIST_JSON?: string }).ESTIMATOR_PRICE_LIST_JSON;
  if (!raw?.trim()) return null;
  let list: PriceList;
  try {
    list = JSON.parse(raw) as PriceList;
  } catch {
    fail("estimator_price_list_invalid", 503);
  }
  if (!list.approvedPolicy) return null;
  const instant = now.toISOString();
  const snapshot = await approvedPricingPolicySnapshot(list, instant).catch(() => null);
  if (!snapshot || snapshot.tenantId !== tenantId)
    fail("estimator_price_list_invalid", 503);
  return {
    name: `native-pricing:${snapshot.snapshotSha256}`,
    status: "Approved",
    rule_type: "Pricing Policy",
    currency: list.currency,
    source_ref: `native-owner-import:${actor.user_id}`,
    rule_json: PRICE_AUTHORITY_CONTRACT,
    effective_from: list.approvedPolicy.effectiveAt.slice(0, 10),
    effective_to: list.approvedPolicy.expiresAt.slice(0, 10),
    approved_by: actor.email_normalized,
    approved_at: instant.slice(0, 19).replace("T", " "),
    pricing_policy_id: snapshot.policyId,
    pricing_policy_revision: snapshot.policyRevision,
    pricing_policy_snapshot_json: snapshot.canonicalSnapshot,
    pricing_policy_snapshot_sha256: snapshot.snapshotSha256,
    modified: instant,
  };
}

async function verifiedFacetEvent(
  env: AppEnv,
  anchor: FacetDecisionAnchor,
  tenantId: string,
): Promise<FacetV2CustomerDecisionEvent> {
  const source = await verifiedJsonSource(
    env,
    anchor.raw_key,
    anchor.raw_sha256,
    "estimator_facet_source",
  );
  const event = await parseFacetV2CustomerDecisionEvent(source.value);
  if (
    !event ||
    event.event_id !== anchor.event_id ||
    event.destination.tenant_id !== tenantId ||
    event.design_revision.id !== anchor.design_revision_id ||
    event.design_revision.sha256 !== anchor.design_revision_sha256 ||
    event.approval.manifest_sha256 !== anchor.frozen_evidence_sha256 ||
    !["approved", "corrected"].includes(event.approval.decision)
  )
    fail("estimator_facet_source_invalid");
  return event;
}

async function verifiedEstimatorReadyEvent(
  env: AppEnv,
  anchor: FacetEstimatorReadyAnchor,
  tenantId: string,
  roofJobId: string,
) {
  const event = await loadFacetEstimatorReadyEvent(env, anchor);
  if (
    !event ||
    event.destination.tenant_id !== tenantId ||
    event.event_id !== anchor.event_id ||
    event.brand_id !== anchor.brand_id ||
    anchor.roof_job_id !== roofJobId ||
    event.facet_project_id !== anchor.facet_project_id ||
    event.project_link.external_project_link_id !== anchor.external_project_link_id ||
    event.project_link.producer_identity_link_id !== anchor.producer_identity_link_id ||
    event.design_revision.id !== anchor.design_revision_id ||
    event.design_revision.sha256 !== anchor.design_revision_sha256 ||
    (await sha256Hex(canonicalJson(event.frozen_evidence))) !==
      anchor.frozen_evidence_sha256
  ) fail("estimator_ready_source_invalid");
  return event;
}

async function verifyMeasurementSupplementalEvidence(
  env: AppEnv,
  evidence: EstimatorMeasurementEvidenceAnchor,
): Promise<void> {
  const receipt = evidence.receipt;
  if (receipt.report_raw_key) {
    const report = await env.RAW?.get(receipt.report_raw_key);
    if (!report || report.size > MAX_MEASUREMENT_REPORT_BYTES) {
      fail("estimator_measurement_report_unavailable");
    }
    const bytes = await report.arrayBuffer();
    if (bytes.byteLength > MAX_MEASUREMENT_REPORT_BYTES) {
      fail("estimator_measurement_report_too_large", 413);
    }
    if ((await sha256Bytes(bytes)) !== receipt.report_sha256) {
      fail("estimator_measurement_report_hash_mismatch");
    }
  }
  if (receipt.ocr_status !== "completed") return;
  const resultSlot = await sha256Hex(
    `measurement-ocr/v1\n${receipt.receipt_id}\n${receipt.report_sha256}\n${receipt.ocr_model}`,
  );
  const expectedKey = `raw/measurement-ocr/${receipt.receipt_id}/${resultSlot}.json`;
  if (receipt.ocr_result_key !== expectedKey) {
    fail("estimator_measurement_ocr_key_mismatch");
  }
  const ocr = await verifiedJsonSource(
    env,
    receipt.ocr_result_key,
    receipt.ocr_result_sha256!,
    "estimator_measurement_ocr",
  );
  const candidate = record(ocr.value.jobNumberCandidate)
    ? ocr.value.jobNumberCandidate
    : null;
  if (
    ocr.value.schemaVersion !== "ironwrap.measurement-ocr.v1" ||
    text(ocr.value.model) !== receipt.ocr_model ||
    text(ocr.value.reportSha256) !== receipt.report_sha256 ||
    ocr.value.reviewRequired !== true ||
    text(candidate?.value) !== receipt.ocr_job_number_candidate ||
    text(candidate?.sourceRef) !== receipt.ocr_job_number_source_ref
  ) {
    fail("estimator_measurement_ocr_binding_mismatch");
  }
}

async function sha256Bytes(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function verifiedJsonSource(
  env: AppEnv,
  key: string,
  expectedSha256: string,
  code: string,
): Promise<{ text: string; value: NativeRow }> {
  const object = await env.RAW?.get(key);
  if (!object || object.size > MAX_NATIVE_SOURCE_BYTES)
    fail(`${code}_unavailable`);
  const textValue = await object.text();
  if (
    new TextEncoder().encode(textValue).byteLength > MAX_NATIVE_SOURCE_BYTES
  ) {
    fail(`${code}_too_large`, 413);
  }
  if ((await sha256Hex(textValue)) !== expectedSha256)
    fail(`${code}_hash_mismatch`);
  let value: unknown;
  try {
    value = JSON.parse(textValue);
  } catch {
    fail(`${code}_invalid_json`);
  }
  if (!record(value)) fail(`${code}_invalid_json`);
  return { text: textValue, value };
}

function assertReplayMatches(
  revision: EstimatorEvidenceRevisionRecord,
  input: ImportEstimatorEvidenceInput,
): void {
  if (
    revision.roof_job_id !== input.roofJobId ||
    revision.measurement_receipt_id !== input.measurementReceiptId ||
    revision.facet_event_id !== (input.facetEventId ?? null) ||
    revision.estimator_ready_event_id !== (input.estimatorReadyEventId ?? null) ||
    revision.commercial_quote_revision_id !==
      (input.commercialQuoteRevisionId ?? null) ||
    Number(revision.revision_number) !== input.revisionNumber ||
    revision.supersedes_estimator_revision_id !==
      (input.supersedesEstimatorRevisionId ?? null) ||
    revision.correction_reason !== (input.correctionReason?.trim() || null) ||
    revision.imported_by_user_id !== input.importedByUserId
  )
    fail("estimator_idempotency_conflict");
}

function unavailable(
  state: "missing" | "ambiguous" | "stale",
  revision: EstimatorEvidenceRevisionRecord | null,
  reasons: string[],
  competingRevisionIds: string[] = [],
): NativeEstimatorAuthority {
  return {
    state,
    revision,
    payload: null,
    geometry: null,
    takeoff: null,
    rawText: null,
    reasons,
    competingRevisionIds,
  };
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
  const result = await statement.all?.<T>();
  return result?.results?.[0] ?? null;
}

function record(value: unknown): value is NativeRow {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bounded(value: unknown): string | null {
  const valueText = text(value);
  return valueText ? valueText.slice(0, MAX_TEXT) : null;
}

function finite(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function bool(value: unknown): 0 | 1 | null {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}

function timestamp(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  const date = new Date(valueText);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function fail(code: string, status = 409): never {
  throw new EstimatorNativeStoreError(code, status);
}
