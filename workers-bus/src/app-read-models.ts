import type { AppEnv, AuthContext, WorkObjectScope } from "./app-types.ts";
import {
  approvalBrokerConfig,
  approvalDecisionConfig,
} from "./approval-broker-client.ts";
import { quoteRevisionApprovalBrokerConfig } from "./quote-revision-approval-broker-client.ts";
import { productionScheduleApprovalBrokerConfig } from "./production-schedule-approval-broker-client.ts";
import { productionScheduleApprovalDecisionConfig } from "./production-schedule-approval-authority.ts";
import {
  listFleetCustodyFrappeResource,
  listFrappeResource,
  listFrappeResourcePage,
  listOfficeEstimatorFrappeResource,
  listOfficeProductionFrappeResource,
  listOfficeSalesFrappeResource,
  publicFrappeRow,
  readOfficeEstimatorFrappeResource,
  type FrappeFilter,
  type FrappeRow,
} from "./frappe-read.ts";
import { parseBody } from "./core.ts";
import { extractGeometry } from "./measurements.ts";
import type { GeometryModel } from "./geometry.ts";
import { takeoffFromGeometry, type TakeoffModel } from "./takeoff.ts";
import {
  approvedPricingPolicyIdentity,
  priceTakeoff,
  verifyPricingAuthority,
  type PriceList,
  type VerifiedPricingAuthority,
} from "./pricing.ts";
import {
  buildJobEconomicsProjection,
  type JobEconomicsProjection,
} from "./job-economics.ts";
import { listLeadMctbEvidence, type LeadAckReceipt } from "./store.ts";
import {
  fieldWorkPackageForAssignment,
  fieldWorkPackageProjection,
  hasWorkPackageCompletionAuthority,
} from "./work-package.ts";
import { facetLaunchConfigured } from "./facet-launch.ts";

const ACTIVE_JOB_STATUSES = ["Won", "In Production"] as const;
export const ACTIVE_ASSIGNMENT_STATUSES = [
  "Assigned",
  "Accepted",
  "In Progress",
  "Blocked",
] as const;
const FIELD_PACKET_PROOF_PAGE_SIZE = 100;
const OWNER_NOW_SOURCE_LIMIT = 50;
const SALES_SOURCE_LIMIT = 100;
const ESTIMATOR_SOURCE_LIMIT = 100;
const PRODUCTION_SOURCE_LIMIT = 100;
const MAX_ESTIMATOR_RAW_BYTES = 2 * 1024 * 1024;
const MAX_ESTIMATOR_CHECKS = 80;
const MAX_ESTIMATOR_FACETS = 120;
const MAX_ESTIMATOR_METRICS = 120;
const MAX_ESTIMATOR_TAKEOFF_ITEMS = 250;
const MAX_ESTIMATOR_COMPUTED_TRIMS = 40;
const MAX_ESTIMATOR_ESTIMATE_LINES = 60;
const ESTIMATOR_PRICING_AUTHORITY_LIMIT = 2;
const MAX_ESTIMATOR_GEOMETRY_LABEL = 240;
const MAX_ESTIMATOR_GEOMETRY_DETAIL = 600;
const MAX_ESTIMATOR_ROOF_GRAPH_JSON_LENGTH = 768 * 1024;
const MAX_ESTIMATOR_ROOF_GRAPH_POINTS = 1_000;
const MAX_ESTIMATOR_ROOF_GRAPH_EDGES = 2_000;
const MAX_ESTIMATOR_ROOF_GRAPH_FACETS = 500;
const MAX_ESTIMATOR_ROOF_GRAPH_FACET_EDGES = 200;
const MAX_ESTIMATOR_ROOF_GRAPH_IDENTIFIER = 240;
const MAX_VISUAL_SCREENSHOT_JSON_LENGTH = 32 * 1024;
const MAX_VISUAL_PREVIEW_URL_LENGTH = 2048;
const MAX_VISUAL_SCREENSHOT_CANDIDATES = 12;
const MCTB_SLA_MS = 60_000;
// Completion is created with the other lifecycle gates, but it is closeout-only.
// Keep the read model aligned with the authoritative scheduling policy instead of
// treating an expected incomplete closeout record as a dispatch blocker.
const SCHEDULING_PRODUCTION_GATES = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;
const SCHEDULING_PRODUCTION_GATE_NAMES = new Set<string>(
  SCHEDULING_PRODUCTION_GATES,
);
const NON_BLOCKING_GATE_STATES = new Set(["Ready", "Waived", "Done"]);

interface ReadModelEnvelope {
  version: number;
  source_updated_at: string | null;
  read_model_generated_at: string;
  stale_fields: string[];
  permissions: string[];
  allowed_actions: string[];
}

export interface AssignmentReadModel {
  id: string;
  assignment_id: string | null;
  type: string | null;
  status: string | null;
  crew_profile: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  blocker_reason: string | null;
}

export interface ProofStreamItem {
  id: string;
  type: string | null;
  proof_slot: string | null;
  occurred_at: string | null;
  summary: string | null;
  customer_safe: boolean | null;
  source: string | null;
  sync_state: string | null;
  blocker: boolean;
}

export interface TodayReadModel extends ReadModelEnvelope {
  date: string;
  jobs: Array<{
    id: string;
    job_number: string | null;
    brand: string | null;
    status: string | null;
    address: string | null;
    scheduled_start: string | null;
    scheduled_end: string | null;
    blocked_gate_count: number;
    next_action: string;
    assignment: AssignmentReadModel | null;
  }>;
  /** Typed non-roof physical assignments. A missing/ambiguous scope is never emitted. */
  work_objects: Array<{
    work_object_type: string;
    work_object_id: string;
    physical_context_type: string;
    physical_context_id: string;
    scheduled_start: string | null;
    scheduled_end: string | null;
    next_action: string;
    assignment: AssignmentReadModel | null;
  }>;
}

export type ProductionRunwayLane =
  | "blocked"
  | "scheduled"
  | "needs_assignment"
  | "ready_for_review"
  | "needs_verification";

/**
 * Read-only operating view. A lane is a source-backed review cue, never a dispatch command or
 * proof that a job may proceed. In particular, a full gate set only means all expected rows were
 * returned as non-blocking by this bounded read.
 */
export interface ProductionRunwayReadModel extends ReadModelEnvelope {
  /** Sources that reached the bounded query limit; displayed totals are lower bounds. */
  partial_sources: string[];
  summary: {
    active_jobs: number;
    blocked: number;
    scheduled: number;
    needs_assignment: number;
    ready_for_review: number;
    needs_verification: number;
  };
  jobs: Array<{
    id: string;
    job_number: string | null;
    brand: string | null;
    service_type: string | null;
    status: string | null;
    assignment: {
      id: string;
      type: string | null;
      status: string | null;
      scheduled_start: string | null;
      scheduled_end: string | null;
    } | null;
    /** A source-backed preparation grant, never proof that a write may run. */
    scheduling_preparation_allowed: boolean;
    lane: ProductionRunwayLane;
    next_action: string;
    gate_coverage: "complete" | "incomplete" | "unknown";
    gate_summary: {
      expected: number;
      blocked: number;
      ready: number;
      waived: number;
      done: number;
    };
    scheduling_gates: Array<{
      name: string;
      state: string | null;
    }>;
    material_attention: Array<{
      status: string;
      requested_delivery_date: string | null;
    }>;
  }>;
  /** Bounded active crew profiles for the owner-only schedule-preparation form. */
  crews: Array<{
    id: string;
    name: string;
  }>;
}

export interface JobReadModel extends ReadModelEnvelope {
  job: {
    id: string;
    roof_job_id: string | null;
    job_number: string | null;
    brand: string | null;
    service_type: string | null;
    status: string | null;
    address: string | null;
    current_gate_state: string | null;
  };
  assignment: AssignmentReadModel | null;
  gates: Array<{
    id: string;
    name: string | null;
    state: string | null;
    blocker_reason: string | null;
    owner: string | null;
    due_at: string | null;
  }>;
  packet: {
    scope_clauses: Array<{
      id: string;
      type: string | null;
      title: string | null;
      text: string | null;
      version: string | null;
    }>;
    measurements: Array<{
      id: string;
      provider: string | null;
      review_status: string | null;
      parsed_at: string | null;
    }>;
    materials: {
      takeoffs: Array<{
        id: string;
        status: string | null;
        prepared_at: string | null;
      }>;
      supplier_orders: Array<{
        id: string;
        status: string | null;
        requested_delivery_date: string | null;
        delivery_notes: string | null;
      }>;
    };
    change_orders: Array<{
      id: string;
      number: string | null;
      version: number | null;
      status: string | null;
      title: string | null;
      scope_delta: string | null;
    }>;
    safety_plan: {
      id: string;
      version: number | null;
      status: string | null;
      effective_date: string | null;
      hazard_summary: string | null;
      controls: string | null;
      emergency_plan: string | null;
      ppe_requirements: string | null;
      weather_limits: string | null;
    } | null;
    work_package: {
      id: string;
      version: number;
      status: "Released" | "Acknowledged" | "In Progress";
      title: string;
      objective: string;
      boundaries: string;
      prerequisites: string;
      expected_result: string;
      stop_conditions: string;
      make_safe_procedure: string;
      issued_at: string;
      expires_at: string;
      released_at: string;
      acknowledgement: {
        current_user_acknowledged: boolean;
        acknowledged_at: string | null;
      };
      steps: Array<{
        sequence: number;
        instruction: string;
        required_evidence: string;
        acceptance_criteria: string;
      }>;
      hold_points: Array<{
        sequence: number;
        hold_point: string;
        release_authority: string;
        required_evidence: string;
        acceptance_criteria: string;
        released: boolean;
      }>;
    } | null;
    contact: {
      display_name: string | null;
      phone: string | null;
      access_instructions: string | null;
    } | null;
  };
  proof_stream: ProofStreamItem[];
  proof_page: { next_cursor: string | null; page_size: number };
  required_proof: Array<{
    id: string;
    slot: string;
    label: string;
    state: string;
    blocker_reason: string | null;
  }>;
}

export interface ProofPageReadModel extends ReadModelEnvelope {
  items: ProofStreamItem[];
  next_cursor: string | null;
}

export interface OwnerNowReadModel extends ReadModelEnvelope {
  exceptions: Array<{
    id: string;
    kind: string;
    severity: string | null;
    title: string;
    why: string | null;
    next_action: string | null;
    job_id: string | null;
    occurred_at: string | null;
    due_at: string | null;
    received_at: string | null;
    bus_status: string | null;
    triage_status: string | null;
    mctb: MctbStatus | null;
  }>;
  /** Sources that reached the bounded query limit; displayed totals are lower bounds. */
  partial_sources: string[];
  economics: JobEconomicsProjection[];
  summary: {
    active_jobs: number;
    field_blockers: number;
    blocked_gates: number;
    open_incidents: number;
    finance_exceptions: number;
    untriaged_leads: number;
    lead_triage_unknown: number;
    mctb_unproven_due: number;
    material_exceptions: number;
    economics_needs_review: number;
  };
}

export type SalesAttentionReason =
  | "triage_unresolved"
  | "estimate_needs_review"
  | "quote_needs_review"
  | "quote_expired";

export interface SalesReadModel extends ReadModelEnvelope {
  /** Sources that reached the bounded query limit; displayed totals are lower bounds. */
  partial_sources: string[];
  summary: {
    listed_leads: number;
    triage_unresolved: number;
    estimate_needs_review: number;
    quote_needs_review: number;
    quote_expired: number;
    no_linked_consent_record: number;
  };
  leads: Array<{
    id: string;
    envelope_id: string;
    source: string | null;
    received_at: string | null;
    transport_status: string | null;
    intent_queue: string | null;
    contact: {
      display_name: string | null;
      phone: string | null;
      email: string | null;
    };
    triage: {
      status: string | null;
      summary: string | null;
    };
    job: {
      id: string;
      job_number: string | null;
      status: string | null;
      service_type: string | null;
      workflow_profile: string | null;
    } | null;
    estimate: {
      id: string;
      status: string | null;
      service_type: string | null;
      range_low: number | null;
      range_high: number | null;
      estimate_total: number | null;
      confidence: string | null;
      review_required: boolean;
      reviewed_at: string | null;
      approved_at: string | null;
      assumptions: string | null;
      exclusions: string | null;
    } | null;
    quote: {
      id: string;
      version: number | null;
      status: string | null;
      quote_total: number | null;
      currency: string | null;
      valid_until: string | null;
      payment_status: string | null;
      prepared_at: string | null;
      approved_at: string | null;
      accepted_at: string | null;
      scope_summary: string | null;
    } | null;
    proposal: {
      id: string;
      status: string | null;
      prepared_at: string | null;
      approved_at: string | null;
      signed_at: string | null;
      // `null` means the bounded source was truncated, so absence/presence is not conclusive.
      has_published_pack: boolean | null;
      published_status: string | null;
    } | null;
    consent: {
      context: "recorded" | "no_linked_record" | "partial";
      records: Array<{
        id: string;
        channel: string | null;
        purpose: string | null;
        status: string | null;
        jurisdiction: string | null;
        basis: string | null;
        captured_at: string | null;
        effective_from: string | null;
        expires_at: string | null;
        revoked_at: string | null;
      }>;
    };
    attention: SalesAttentionReason[];
  }>;
}

export interface EstimatorQuoteProjection {
  id: string;
  version: number | null;
  status: string | null;
  price_book_version: string | null;
  pricing_effective_at: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  tax_code: string | null;
  tax_rate: number | null;
  quote_total: number | null;
  currency: string | null;
  deposit_amount: number | null;
  amount_due: number | null;
  amount_paid: number | null;
  balance_due: number | null;
  payment_status: string | null;
  payment_due_date: string | null;
  valid_until: string | null;
  prepared_at: string | null;
  approved_at: string | null;
  accepted_at: string | null;
  scope_summary: string | null;
  assumptions: string | null;
  exclusions: string | null;
  supersedes: string | null;
  correction_reason: string | null;
}

export interface EstimatorQuoteRevisionDelta {
  subtotal: number | null;
  tax_amount: number | null;
  quote_total: number | null;
  deposit_amount: number | null;
  amount_due: number | null;
  balance_due: number | null;
  price_book_version_changed: boolean;
  pricing_effective_at_changed: boolean;
  tax_code_changed: boolean;
  tax_rate_changed: boolean;
  currency_changed: boolean;
  scope_summary_changed: boolean;
  assumptions_changed: boolean;
  exclusions_changed: boolean;
}

export interface EstimatorWorkbenchReadModel extends ReadModelEnvelope {
  /** Sources that reached the bounded query limit; displayed history is a lower bound. */
  partial_sources: string[];
  job: {
    id: string;
    roof_job_id: string | null;
    job_number: string | null;
    brand: string | null;
    service_type: string | null;
    status: string | null;
    workflow_profile: string | null;
  };
  economics: JobEconomicsProjection;
  lineage: {
    measurement_to_takeoff:
      "linked" | "no_measurement" | "no_takeoff" | "mismatch" | "unknown";
    quote_to_proposal:
      "linked" | "no_quote" | "no_proposal" | "mismatch" | "unknown";
  };
  measurements: {
    reports: Array<{
      id: string;
      provider: string | null;
      review_status: string | null;
      parsed_at: string | null;
      approved_at: string | null;
    }>;
    selected: {
      id: string;
      provider: string | null;
      review_status: string | null;
      parsed_at: string | null;
      approved_at: string | null;
      metrics: Array<{
        metric: string;
        value: number | null;
        unit: string | null;
        confidence: string | null;
        source_ref: string | null;
        needs_review: boolean;
      }>;
      metrics_truncated: boolean;
      geometry: EstimatorGeometryProjection;
      roof_graph: EstimatorRoofGraphProjection | null;
      computed_takeoff: EstimatorComputedTakeoffProjection;
      computed_estimate: EstimatorComputedEstimateProjection;
    } | null;
  };
  visual_model: {
    provider: string | null;
    model_state:
      "draft" | "needs_review" | "approved" | "rejected" | "unavailable";
    confidence: number | null;
    review_required: boolean;
    approval_recorded: boolean;
    captured_at: string | null;
    approved_at: string | null;
    measurement_link:
      "selected_measurement" | "other_measurement" | "unlinked" | "unavailable";
    preview: {
      state:
        | "available"
        | "not_recorded"
        | "not_configured"
        | "blocked"
        | "invalid"
        | "unavailable";
      url: string | null;
    };
  } | null;
  takeoffs: {
    records: Array<{
      id: string;
      measurement_report_id: string | null;
      status: string | null;
      prepared_at: string | null;
      approved_at: string | null;
    }>;
    selected: {
      id: string;
      measurement_report_id: string | null;
      status: string | null;
      prepared_at: string | null;
      approved_at: string | null;
      assumptions: string | null;
      exclusions: string | null;
      items: Array<{
        category: string | null;
        item_name: string | null;
        quantity: number | null;
        unit: string | null;
        waste_factor: number | null;
        source_ref: string | null;
        confidence: string | null;
        needs_review: boolean;
      }>;
      items_truncated: boolean;
    } | null;
  };
  quote: EstimatorQuoteProjection | null;
  pricing_snapshot: {
    state:
      "recorded" | "review_required" | "expired" | "incomplete" | "unavailable";
    quote_id: string | null;
    quote_version: number | null;
    price_book_version: string | null;
    pricing_effective_at: string | null;
    valid_until: string | null;
  };
  quote_revision: {
    state:
      | "no_quote"
      | "not_revised"
      | "compared"
      | "prior_quote_missing"
      | "history_incomplete"
      | "unlinked_revision"
      | "invalid_lineage";
    prior_quote: EstimatorQuoteProjection | null;
    delta: EstimatorQuoteRevisionDelta | null;
  };
  proposal: {
    id: string;
    quote_id: string | null;
    status: string | null;
    prepared_at: string | null;
    approved_at: string | null;
    signed_at: string | null;
    assumptions: string | null;
    exclusions: string | null;
  } | null;
  scope_changes: Array<{
    id: string;
    number: string | null;
    version: number | null;
    status: string | null;
    title: string | null;
    reason: string | null;
    scope_delta: string | null;
    quote_link:
      "selected_quote" | "other_quote" | "quote_unavailable" | "no_quote";
    currency: string | null;
    subtotal: number | null;
    tax_amount: number | null;
    total_amount: number | null;
    price_book_version: string | null;
    requested_at: string | null;
    approved_at: string | null;
    accepted_at: string | null;
    correction_reason: string | null;
  }>;
  insurance_supplements: Array<{
    presentation_key: string;
    version: number | null;
    status: string | null;
    measurement_state:
      "approved" | "missing" | "review_required" | "unavailable";
    evidence_roles: Array<
      | "Carrier Scope"
      | "Code/Manufacturer"
      | "Photo"
      | "Invoice"
      | "Submission"
      | "Carrier Response"
    >;
    missing_requirements: Array<
      | "approved_measurement"
      | "carrier_scope"
      | "code_or_manufacturer"
      | "photo"
      | "invoice_or_exception"
      | "submission_artifact"
      | "carrier_response_artifact"
      | "source_detail_unavailable"
    >;
    invoice_state: "recorded" | "required" | "not_required" | "unavailable";
    approval_recorded: boolean;
    submission_recorded: boolean;
    carrier_response_recorded: boolean;
    closed_recorded: boolean;
  }>;
  proposal_readiness: {
    state: "ready" | "review_required" | "blocked" | "unavailable";
    reasons: Array<
      | "measurement_missing"
      | "measurement_source_review_required"
      | "takeoff_link_missing"
      | "takeoff_not_approved"
      | "quote_missing"
      | "quote_snapshot_incomplete"
      | "quote_not_approved"
      | "scope_change_unresolved"
      | "proposal_link_mismatch"
      | "source_window_partial"
      | "stale_source_detail"
    >;
  };
  scope_clauses: Array<{
    id: string;
    type: string | null;
    title: string | null;
    text: string | null;
    version: string | null;
    status: string | null;
    source_ref: string | null;
    customer_visible: boolean;
    approved_at: string | null;
  }>;
}

export interface EstimatorGeometryProjection {
  /** This verifies the source-file math only. It is never evidence of field verification. */
  state: "recomputed" | "needs_review" | "unavailable";
  reason: string | null;
  check_count: number;
  failed_check_count: number;
  checks_truncated: boolean;
  facet_count: number;
  facets_truncated: boolean;
  metrics_truncated: boolean;
  checks: Array<{ check: string; target: string; ok: boolean; detail: string }>;
  facets: Array<{
    id: string;
    type: string;
    material: string | null;
    pitch: number | null;
    orientation: number | null;
    declared_area: number | null;
    computed_area: number | null;
    deviation: number | null;
    ring_closed: boolean;
  }>;
  metrics: Array<{ metric: string; value: number; source_ref: string | null }>;
}

/** Safe browser projection of persisted roof_graph/v1 evidence; raw artifact identity stays server-side. */
export interface EstimatorRoofGraphProjection {
  state: "available" | "needs_review" | "unavailable";
  revision: string | null;
  source: string | null;
  provider: string | null;
  confidence: number | null;
  review_status: "Approved" | "Needs Review" | "Rejected" | "Unavailable";
  captured_at: string | null;
  units: string | null;
  points: Array<{ id: string; x: number; y: number }>;
  edges: Array<{ id: string; start_point_id: string; end_point_id: string }>;
  facets: Array<{
    id: string;
    label: string | null;
    point_ids: string[];
    confidence: number | null;
    review_status: "Approved" | "Needs Review" | "Rejected" | "Unavailable";
  }>;
  check_count: number;
  failed_check_count: number;
}

interface StoredRoofGraphEdge {
  id: string;
  from: string;
  to: string;
}

export interface MctbStatus {
  state:
    | "provider_accepted_within_sla"
    | "provider_accepted_late"
    | "no_eligible_channel"
    | "awaiting_proof"
    | "unproven_after_sla"
    | "time_unavailable";
  deadline_at: string | null;
  observed_at: string | null;
  channel: "email" | null;
  proof_kind: "provider_receipt" | null;
}

export async function activeAssignmentForJob(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
): Promise<FrappeRow | null> {
  if (!validJobName(jobName)) return null;
  const assignments = await authorizedAssignments(env, auth, jobName);
  return preferredAssignment(assignments);
}

/**
 * A Cargo Load still binds an asset to a job in every one of these states, so a
 * driver on one of them is a real relationship to the asset. It mirrors
 * `CARGO_LOAD_RELEASE_FENCE_STATUSES` on the Frappe side.
 */
const FLEET_CAPTURE_OPEN_LOAD_STATUSES = [
  "Draft",
  "Loaded",
  "In Transit",
  "Delivered",
] as const;

/**
 * Resolve the Fleet Asset an authenticated field user may capture against.
 *
 * Do not trust a fleet asset identifier from the browser. Without this the rail
 * would let any paired field session post an out-of-service defect against any
 * vehicle in the fleet — grounding it immediately and irreversibly — or
 * fabricate a passing pre-trip for an asset it never touched. The relationship
 * the release fence already reads is the one that authorizes the capture:
 * custody of the asset, or driving it on an open Cargo Load.
 *
 * Returns null for both "no such asset" and "not yours", so the rail cannot be
 * used to enumerate the fleet. The Frappe command repeats this scope check
 * under its own asset lock.
 */
export async function fleetAssetForFieldActor(
  env: AppEnv,
  auth: AuthContext,
  assetId: string,
): Promise<FrappeRow | null> {
  const userId = auth.session.frappe_user_id;
  if (auth.session.role !== "field" || !userId?.trim()) return null;
  const asset = await resolveFleetAssetForCapture(env, assetId);
  if (!asset) return null;
  const holderType = text(asset.custody_holder_type);
  if (holderType === "User" && sameUser(asset.custody_user, userId)) return asset;
  if (holderType === "Crew") {
    const crewProfile = text(asset.custody_crew_profile);
    if (crewProfile && (await activeCrewProfilesForUser(env, userId)).has(crewProfile)) {
      return asset;
    }
  }
  const assetName = text(asset.name);
  if (!assetName) return null;
  return (await drivesFleetAsset(env, userId, assetName)) ? asset : null;
}

/**
 * The rail addresses an asset by its business id or its Frappe name, exactly as
 * the Frappe command's own lock does. An ambiguous match resolves to nothing.
 */
async function resolveFleetAssetForCapture(
  env: AppEnv,
  assetId: string,
): Promise<FrappeRow | null> {
  const byBusinessId = await listFleetCustodyFrappeResource(
    env,
    "Fleet Asset",
    [["Fleet Asset", "fleet_asset_id", "=", assetId]],
    2,
  );
  const rows =
    byBusinessId.length > 0
      ? byBusinessId
      : await listFleetCustodyFrappeResource(
          env,
          "Fleet Asset",
          [["Fleet Asset", "name", "=", assetId]],
          2,
        );
  if (rows.length !== 1) return null;
  return text(rows[0]!.name) ? rows[0]! : null;
}

async function drivesFleetAsset(
  env: AppEnv,
  userId: string,
  assetName: string,
): Promise<boolean> {
  const openStatuses = [...FLEET_CAPTURE_OPEN_LOAD_STATUSES];
  const [byDriverUser, authorities] = await Promise.all([
    listFleetCustodyFrappeResource(
      env,
      "Cargo Load",
      [
        ["Cargo Load", "driver_user", "=", userId],
        ["Cargo Load", "status", "in", openStatuses],
      ],
      100,
    ),
    listFleetCustodyFrappeResource(
      env,
      "Driver Authority",
      [["Driver Authority", "driver_user", "=", userId]],
      20,
    ),
  ]);
  if (byDriverUser.some((row) => loadCarriesAsset(row, assetName))) return true;
  // A planned load may name the authority before the driver user is recorded,
  // so the authority this user holds is the second, equivalent binding.
  const authorityNames = authorities
    .filter((row) => sameUser(row.driver_user, userId))
    .map((row) => text(row.name))
    .filter(notNull);
  if (authorityNames.length === 0) return false;
  const byAuthority = await listFleetCustodyFrappeResource(
    env,
    "Cargo Load",
    [
      ["Cargo Load", "driver_authority", "in", authorityNames],
      ["Cargo Load", "status", "in", openStatuses],
    ],
    100,
  );
  return byAuthority.some((row) => loadCarriesAsset(row, assetName));
}

function loadCarriesAsset(row: FrappeRow, assetName: string): boolean {
  return (
    text(row.fleet_asset) === assetName || text(row.trailer_asset) === assetName
  );
}

/**
 * Resolve one exact active assignment for a typed physical work object.  This
 * is the universal route's authority boundary: a work-object id is never
 * silently interpreted as a Roof Job, and ambiguous active assignments fail
 * closed instead of letting the browser choose a write target.
 */
export async function activeAssignmentForWorkObject(
  env: AppEnv,
  auth: AuthContext,
  scope: WorkObjectScope,
): Promise<FrappeRow | null> {
  const values = [
    scope.workObjectType,
    scope.workObjectId,
    scope.physicalContextType,
    scope.physicalContextId,
  ];
  if (
    values.some((value) => !validJobName(value)) ||
    scope.workObjectType === "Roof Job"
  ) {
    return null;
  }
  const filters: FrappeFilter[] = [
    ["Job Assignment", "work_object_type", "=", scope.workObjectType],
    ["Job Assignment", "work_object_id", "=", scope.workObjectId],
    [
      "Job Assignment",
      "physical_context_type",
      "=",
      scope.physicalContextType,
    ],
    ["Job Assignment", "physical_context_id", "=", scope.physicalContextId],
    ["Job Assignment", "status", "in", [...ACTIVE_ASSIGNMENT_STATUSES]],
  ];
  const candidates = await listFrappeResource(
    env,
    "Job Assignment",
    filters,
    100,
  );
  if (jobReadMode(auth) === "any")
    return candidates.length === 1 ? candidates[0] ?? null : null;
  const userId = auth.session.frappe_user_id;
  if (!userId) return null;
  const direct = candidates.filter((row) => sameUser(row.assigned_user, userId));
  const candidateNames = candidates
    .map((row) => text(row.name))
    .filter(notNull);
  const workerRows =
    candidateNames.length > 0
      ? await listFrappeResource(
          env,
          "Work Package Worker",
          [["Work Package Worker", "worker_user", "=", userId]],
          100,
          "Job Assignment",
        )
      : [];
  const workerAssignmentNames = new Set(
    workerRows
      .filter(
        (row) =>
          row.parenttype === "Job Assignment" &&
          row.parentfield === "assigned_workers" &&
          sameUser(row.worker_user, userId),
      )
      .map((row) => text(row.parent))
      .filter((parent): parent is string =>
        Boolean(parent && candidateNames.includes(parent)),
      ),
  );
  const authorized = candidates.filter(
    (row) =>
      sameUser(row.assigned_user, userId) ||
      workerAssignmentNames.has(text(row.name) ?? ""),
  );
  const unique = new Map(
    authorized.flatMap((row) => {
      const name = text(row.name);
      return name ? [[name, row] as const] : [];
    }),
  );
  return unique.size === 1 ? [...unique.values()][0] ?? null : null;
}

/** Build the universal work-object packet used by discovery and action clients. */
export async function buildUniversalWorkPackageReadModel(
  env: AppEnv,
  auth: AuthContext,
  scope: WorkObjectScope,
): Promise<Record<string, unknown> | null> {
  const assignment = await activeAssignmentForWorkObject(env, auth, scope);
  const assignmentId = text(assignment?.name);
  if (!assignment || !assignmentId) return null;
  const workPackage = await fieldWorkPackageForAssignment(
    env,
    scope.workObjectId,
    assignmentId,
  );
  if (
    !workPackage ||
    workPackage.workObjectType !== scope.workObjectType ||
    workPackage.workObjectId !== scope.workObjectId ||
    workPackage.physicalContextType !== scope.physicalContextType ||
    workPackage.physicalContextId !== scope.physicalContextId
  ) {
    return null;
  }
  const projection = fieldWorkPackageProjection(
    workPackage,
    auth.session.frappe_user_id,
    {
      completionAuthority: hasWorkPackageCompletionAuthority(
        workPackage,
        assignment,
        auth.session.frappe_user_id,
        auth.session.role,
      ),
    },
  );
  const allowedActions = [...projection.allowedActions];
  if (
    auth.session.role === "field" &&
    !allowedActions.includes("field.checkin.create")
  ) {
    allowedActions.push("field.checkin.create");
  }
  return {
    ...envelope(auth, [assignment], []),
    work_object: scope,
    assignment: assignmentModel(assignment),
    work_package: projection.work_package,
    allowed_actions: allowedActions,
  };
}

export async function buildTodayReadModel(
  env: AppEnv,
  auth: AuthContext,
): Promise<TodayReadModel> {
  const readMode = jobReadMode(auth);
  const assignments = await authorizedAssignments(env, auth);
  const preferredByJob = preferredAssignmentsByJob(assignments);
  const assignedJobIds = [...preferredByJob.keys()];
  const typedAssignments = preferredAssignmentsByWorkObject(assignments);
  if (
    readMode === "assigned" &&
    assignedJobIds.length === 0 &&
    typedAssignments.length === 0
  )
    return emptyToday(env, auth, assignments);
  const jobs =
    readMode === "assigned"
      ? assignedJobIds.length > 0
        ? await listFrappeResource(
          env,
          "Roof Job",
          [
            ["Roof Job", "name", "in", assignedJobIds],
            ["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]],
          ],
          100,
        )
        : []
      : await listFrappeResource(
          env,
          "Roof Job",
          [["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]]],
          100,
        );
  const jobIds = jobs.map((row) => text(row.name)).filter(notNull);
  const propertyIds = jobs
    .map((row) => text(row.roofing_property))
    .filter(notNull);
  const [blockedGates, properties] = await Promise.all([
    jobIds.length > 0
      ? listFrappeResource(
          env,
          "Production Gate State",
          [
            ["Production Gate State", "roof_job", "in", jobIds],
            ["Production Gate State", "state", "=", "Blocked"],
          ],
          100,
        )
      : Promise.resolve([]),
    propertyIds.length > 0
      ? listFrappeResource(
          env,
          "Roofing Property",
          [["Roofing Property", "name", "in", propertyIds]],
          100,
        )
      : Promise.resolve([]),
  ]);
  const propertyById = new Map(properties.map((row) => [text(row.name), row]));
  const blockedByJob = groupBy(blockedGates, "roof_job");
  const shaped = jobs
    .flatMap((row) => {
      const id = text(row.name);
      const assignmentRow = id ? preferredByJob.get(id) : undefined;
      if (!id || (readMode === "assigned" && !assignmentRow)) return [];
      const blocked = blockedByJob.get(id) ?? [];
      const assignment = assignmentRow ? assignmentModel(assignmentRow) : null;
      return [
        {
          id,
          job_number: text(row.job_number),
          brand: text(row.brand),
          status: text(row.job_status),
          address: address(propertyById.get(text(row.roofing_property))),
          scheduled_start: assignment?.scheduled_start ?? null,
          scheduled_end: assignment?.scheduled_end ?? null,
          blocked_gate_count: blocked.length,
          next_action:
            assignment?.blocker_reason ??
            text(blocked[0]?.blocker_reason) ??
            (assignment ? "Open field check-in" : "Assign field work"),
          assignment,
        },
      ];
    })
    .sort((left, right) =>
      compareSchedule(left.scheduled_start, right.scheduled_start),
    );
  const workObjects: TodayReadModel["work_objects"] = typedAssignments
    .flatMap((assignmentRow) => {
      const scope = assignmentWorkObjectScope(assignmentRow);
      if (!scope) return [];
      const assignment = assignmentModel(assignmentRow);
      return [{
        ...scope,
        scheduled_start: assignment.scheduled_start,
        scheduled_end: assignment.scheduled_end,
        next_action:
          assignment.blocker_reason ?? "Open the typed physical work package",
        assignment,
      }];
    })
    .sort(
      (left, right) =>
        compareSchedule(left.scheduled_start, right.scheduled_start) ||
        left.work_object_type.localeCompare(right.work_object_type) ||
        left.work_object_id.localeCompare(right.work_object_id) ||
        left.physical_context_id.localeCompare(right.physical_context_id),
    );
  const stale: string[] = [];
  if (properties.length < new Set(propertyIds).size) stale.push("jobs.address");
  return {
    ...envelope(
      auth,
      [...assignments, ...jobs, ...blockedGates, ...properties],
      stale,
    ),
    date: tenantDate(env.APP_TIME_ZONE),
    jobs: shaped,
    work_objects: workObjects,
  };
}

export async function buildProductionRunwayReadModel(
  env: AppEnv,
  auth: AuthContext,
): Promise<ProductionRunwayReadModel> {
  if (!auth.permissions.includes("production:read"))
    throw new Error("production_scope_required");

  const schedulePreparationConfigured =
    auth.session.role === "owner" &&
    Boolean(auth.session.frappe_user_id?.trim()) &&
    productionScheduleApprovalBrokerConfig(env) !== null &&
    productionScheduleApprovalDecisionConfig(env) !== null;
  const [jobs, assignments, crewProfiles] = await Promise.all([
    listOfficeProductionFrappeResource(
      env,
      "Roof Job",
      [["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]]],
      PRODUCTION_SOURCE_LIMIT,
    ),
    listOfficeProductionFrappeResource(
      env,
      "Job Assignment",
      [
        ["Job Assignment", "status", "in", [...ACTIVE_ASSIGNMENT_STATUSES]],
        ["Job Assignment", "assignment_type", "=", "Production"],
      ],
      PRODUCTION_SOURCE_LIMIT,
    ),
    // The roster is a bounded input list for schedule preparation, not a
    // dispatch authority. Avoid requesting it for Ops or disabled rails.
    schedulePreparationConfigured
      ? listOfficeProductionFrappeResource(
          env,
          "Crew Profile",
          [["Crew Profile", "status", "=", "Active"]],
          PRODUCTION_SOURCE_LIMIT,
        )
      : Promise.resolve([]),
  ]);
  const jobIds = jobs.map((row) => text(row.name)).filter(notNull);
  const [gates, materialExceptions] = await Promise.all([
    jobIds.length > 0
      ? listOfficeProductionFrappeResource(
          env,
          "Production Gate State",
          [["Production Gate State", "roof_job", "in", jobIds]],
          PRODUCTION_SOURCE_LIMIT,
        )
      : Promise.resolve([]),
    jobIds.length > 0
      ? listOfficeProductionFrappeResource(
          env,
          "Supplier Order",
          [
            ["Supplier Order", "roof_job", "in", jobIds],
            ["Supplier Order", "status", "in", ["Needs Review", "Shortage"]],
          ],
          PRODUCTION_SOURCE_LIMIT,
        )
      : Promise.resolve([]),
  ]);

  const partialSources: string[] = [];
  if (jobs.length === PRODUCTION_SOURCE_LIMIT)
    partialSources.push("active_jobs");
  if (assignments.length === PRODUCTION_SOURCE_LIMIT)
    partialSources.push("active_assignments");
  if (gates.length === PRODUCTION_SOURCE_LIMIT)
    partialSources.push("gate_states");
  if (materialExceptions.length === PRODUCTION_SOURCE_LIMIT)
    partialSources.push("material_exceptions");
  if (crewProfiles.length === PRODUCTION_SOURCE_LIMIT)
    partialSources.push("crew_profiles");

  const gateRowsByJob = groupBy(gates, "roof_job");
  const materialRowsByJob = groupBy(materialExceptions, "roof_job");
  const assignmentByJob = preferredAssignmentsByJob(assignments);
  const gateRowsComplete = !partialSources.includes("gate_states");
  const assignmentRowsComplete = !partialSources.includes("active_assignments");
  const materialExceptionRowsComplete = !partialSources.includes(
    "material_exceptions",
  );
  const crewProfilesComplete = !partialSources.includes("crew_profiles");
  const crews = crewProfiles
    .flatMap((row) => {
      const id = text(row.name) ?? text(row.crew_profile_id);
      const name = text(row.crew_name);
      return id && name ? [{ id, name }] : [];
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
  const shaped = jobs
    .flatMap((job) => {
      const id = text(job.name);
      if (!id) return [];
      const assignmentRow = assignmentByJob.get(id);
      const assignment = assignmentRow
        ? productionAssignmentModel(assignmentRow)
        : null;
      const jobGateRows = gateRowsByJob.get(id) ?? [];
      const latestGatesByName = latestRowsByReference(jobGateRows, "gate");
      const schedulingGateRowCounts = new Map<string, number>();
      for (const row of jobGateRows) {
        const gate = text(row.gate);
        if (!gate || !SCHEDULING_PRODUCTION_GATE_NAMES.has(gate)) continue;
        schedulingGateRowCounts.set(
          gate,
          (schedulingGateRowCounts.get(gate) ?? 0) + 1,
        );
      }
      const hasDuplicateSchedulingGate = [
        ...schedulingGateRowCounts.values(),
      ].some((count) => count > 1);
      const schedulingGates = SCHEDULING_PRODUCTION_GATES.flatMap((gate) => {
        const row = latestGatesByName.get(gate);
        return row ? [row] : [];
      });
      const schedulingGateProjection = SCHEDULING_PRODUCTION_GATES.map(
        (name) => ({
          name,
          state: text(latestGatesByName.get(name)?.state),
        }),
      );
      const gateCoverage: ProductionRunwayReadModel["jobs"][number]["gate_coverage"] =
        !gateRowsComplete
          ? "unknown"
          : !hasDuplicateSchedulingGate &&
              SCHEDULING_PRODUCTION_GATES.every((gate) =>
                latestGatesByName.has(gate),
              )
            ? "complete"
            : "incomplete";
      const gateSummary = {
        expected: SCHEDULING_PRODUCTION_GATES.length,
        blocked: schedulingGates.filter(
          (gate) => text(gate.state) === "Blocked",
        ).length,
        ready: schedulingGates.filter((gate) => text(gate.state) === "Ready")
          .length,
        waived: schedulingGates.filter((gate) => text(gate.state) === "Waived")
          .length,
        done: schedulingGates.filter((gate) => text(gate.state) === "Done")
          .length,
      };
      const materialAttention = (materialRowsByJob.get(id) ?? []).flatMap(
        (row) => {
          const status = text(row.status);
          return status
            ? [
                {
                  status,
                  requested_delivery_date: text(row.requested_delivery_date),
                },
              ]
            : [];
        },
      );
      const allReturnedGatesNonBlocking =
        materialExceptionRowsComplete &&
        gateCoverage === "complete" &&
        SCHEDULING_PRODUCTION_GATES.every((gate) => {
          const state = text(latestGatesByName.get(gate)?.state);
          return !!state && NON_BLOCKING_GATE_STATES.has(state);
        });
      const blocked =
        gateSummary.blocked > 0 ||
        assignment?.status === "Blocked" ||
        materialAttention.length > 0;
      const lane: ProductionRunwayLane = blocked
        ? "blocked"
        : assignment?.scheduled_start
          ? "scheduled"
          : !assignment && assignmentRowsComplete
            ? "needs_assignment"
            : !assignment
              ? "needs_verification"
              : allReturnedGatesNonBlocking
                ? "ready_for_review"
                : "needs_verification";
      const nextAction =
        lane === "blocked"
          ? "Resolve the source-backed blocker before dispatch review"
          : lane === "scheduled"
            ? "Confirm the schedule against current gate coverage"
            : lane === "needs_assignment"
              ? "Assign a crew and review gates before scheduling"
              : lane === "ready_for_review"
                ? "Review for scheduling; this view does not dispatch work"
                : "Verify the production-gate records before scheduling";
      const schedulingPreparationAllowed =
        schedulePreparationConfigured &&
        crewProfilesComplete &&
        crews.length > 0 &&
        assignmentRowsComplete &&
        !blocked &&
        allReturnedGatesNonBlocking;

      return [
        {
          id,
          job_number: text(job.job_number),
          brand: text(job.brand),
          service_type: text(job.service_type),
          status: text(job.job_status),
          assignment,
          scheduling_preparation_allowed: schedulingPreparationAllowed,
          lane,
          next_action: nextAction,
          gate_coverage: gateCoverage,
          gate_summary: gateSummary,
          scheduling_gates: schedulingGateProjection,
          material_attention: materialAttention,
        },
      ];
    })
    .sort(
      (left, right) =>
        productionLanePriority(left.lane) -
          productionLanePriority(right.lane) ||
        compareSchedule(
          left.assignment?.scheduled_start ?? null,
          right.assignment?.scheduled_start ?? null,
        ) ||
        left.id.localeCompare(right.id),
    );

  const stale: string[] = [];
  if (partialSources.length > 0) stale.push("jobs.partial_sources");
  if (shaped.some((job) => job.gate_coverage !== "complete"))
    stale.push("jobs.gate_coverage");
  return {
    ...envelope(
      auth,
      [
        ...jobs,
        ...assignments,
        ...gates,
        ...materialExceptions,
        ...crewProfiles,
      ],
      stale,
    ),
    allowed_actions: [
      "job.read",
      "production.read",
      ...(schedulePreparationConfigured &&
      crewProfilesComplete &&
      crews.length > 0
        ? ["production_schedule_approval.prepare"]
        : []),
    ],
    partial_sources: partialSources,
    summary: {
      active_jobs: shaped.length,
      blocked: shaped.filter((job) => job.lane === "blocked").length,
      scheduled: shaped.filter((job) => job.lane === "scheduled").length,
      needs_assignment: shaped.filter((job) => job.lane === "needs_assignment")
        .length,
      ready_for_review: shaped.filter((job) => job.lane === "ready_for_review")
        .length,
      needs_verification: shaped.filter(
        (job) => job.lane === "needs_verification",
      ).length,
    },
    jobs: shaped,
    crews,
  };
}

export async function buildJobReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
): Promise<JobReadModel | null> {
  if (!validJobName(jobName)) return null;
  const readMode = jobReadMode(auth);
  const assignmentRow = await activeAssignmentForJob(env, auth, jobName);
  if (readMode === "assigned" && !assignmentRow) return null;
  const jobs = await listFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "name", "=", jobName]],
    1,
  );
  const job = jobs[0];
  if (!job || !ACTIVE_JOB_STATUSES.includes(text(job.job_status) as never))
    return null;

  const propertyId = text(job.roofing_property);
  const customerId = text(job.customer);
  const [
    gates,
    evidence,
    checkIns,
    propertyRows,
    scopeClauses,
    measurements,
    takeoffs,
    supplierOrders,
    changeOrders,
    safetyPlans,
    customerRows,
    workPackage,
  ] = await Promise.all([
    listFrappeResource(
      env,
      "Production Gate State",
      [["Production Gate State", "roof_job", "=", jobName]],
      50,
    ),
    listFrappeResourcePage(
      env,
      "Evidence Item",
      [["Evidence Item", "roof_job", "=", jobName]],
      FIELD_PACKET_PROOF_PAGE_SIZE,
      0,
    ),
    listFrappeResource(
      env,
      "Field Check-in",
      [["Field Check-in", "roof_job", "=", jobName]],
      50,
    ),
    propertyId
      ? listFrappeResource(
          env,
          "Roofing Property",
          [["Roofing Property", "name", "=", propertyId]],
          1,
        )
      : Promise.resolve([]),
    listFrappeResource(
      env,
      "Scope Clause",
      [
        ["Scope Clause", "roof_job", "=", jobName],
        ["Scope Clause", "status", "=", "Approved"],
      ],
      100,
    ),
    listFrappeResource(
      env,
      "Measurement Report",
      [
        ["Measurement Report", "roof_job", "=", jobName],
        ["Measurement Report", "review_status", "=", "Approved"],
      ],
      50,
    ),
    listFrappeResource(
      env,
      "Material Takeoff",
      [
        ["Material Takeoff", "roof_job", "=", jobName],
        ["Material Takeoff", "status", "=", "Approved"],
      ],
      50,
    ),
    listFrappeResource(
      env,
      "Supplier Order",
      [["Supplier Order", "roof_job", "=", jobName]],
      50,
    ),
    listFrappeResource(
      env,
      "Change Order",
      [
        ["Change Order", "roof_job", "=", jobName],
        ["Change Order", "status", "in", ["Approved", "Presented", "Accepted"]],
      ],
      50,
    ),
    listFrappeResource(
      env,
      "Safety Plan",
      [
        ["Safety Plan", "roof_job", "=", jobName],
        ["Safety Plan", "status", "in", ["Ready", "Acknowledged"]],
      ],
      20,
    ),
    customerId
      ? listFrappeResource(
          env,
          "Roofing Customer",
          [["Roofing Customer", "name", "=", customerId]],
          1,
        )
      : Promise.resolve([]),
    readMode === "assigned" && assignmentRow
      ? fieldWorkPackageForAssignment(env, jobName, text(assignmentRow.name)!)
      : Promise.resolve(null),
  ]);
  const property = propertyRows[0];
  const customer = customerRows[0];
  const proofStream = [
    ...evidence.map(evidenceProofItem),
    ...checkIns.map(checkInProofItem),
  ]
    .filter(notNull)
    .sort(compareProofItems);
  const safety = safetyPlans.sort(
    (a, b) => numberValue(b.version) - numberValue(a.version),
  )[0];
  const workPackagePacket = fieldWorkPackageProjection(
    workPackage,
    readMode === "assigned" ? auth.session.frappe_user_id : null,
    {
      completionAuthority: hasWorkPackageCompletionAuthority(
        workPackage,
        assignmentRow ?? null,
        auth.session.frappe_user_id,
        auth.session.role,
      ),
    },
  );
  const stale: string[] = [];
  if (
    readMode === "any" &&
    gates.some((row) => !text(row.owner_user))
  )
    stale.push("gates.owner");
  if (propertyId && !property) stale.push("job.address");
  if (!customer || !text(customer.display_name))
    stale.push("packet.contact.display_name");
  if (!customer || !text(customer.phone)) stale.push("packet.contact.phone");
  stale.push("packet.contact.access_instructions");
  const readEnvelope = envelope(
    auth,
    [
      publicFrappeRow(job),
      ...(assignmentRow ? [assignmentRow] : []),
      ...gates,
      ...evidence,
      ...checkIns,
      ...propertyRows,
      ...customerRows,
      ...scopeClauses,
      ...measurements,
      ...takeoffs,
      ...supplierOrders,
      ...changeOrders,
      ...safetyPlans,
      ...(workPackage ? [{ modified: workPackage.modified }] : []),
    ],
    stale,
  );
  return {
    ...readEnvelope,
    allowed_actions: auth.session.role === "production"
      ? ["job.read"]
      : [...readEnvelope.allowed_actions, ...workPackagePacket.allowedActions],
    job: {
      id: text(job.name)!,
      roof_job_id: text(job.roof_job_id),
      job_number: text(job.job_number),
      brand: text(job.brand),
      service_type: text(job.service_type),
      status: text(job.job_status),
      address: address(property),
      current_gate_state: text(job.current_gate_state),
    },
    assignment: assignmentRow ? assignmentModel(assignmentRow) : null,
    gates: gates.flatMap((row) =>
      gateModel(row, readMode === "assigned"),
    ),
    packet: {
      scope_clauses: scopeClauses.flatMap((row) => {
        const id = text(row.scope_clause_id) ?? text(row.name);
        return id
          ? [
              {
                id,
                type: text(row.clause_type),
                title: text(row.title),
                text: text(row.clause_text),
                version: text(row.version),
              },
            ]
          : [];
      }),
      measurements: measurements.flatMap((row) => {
        const id = text(row.measurement_id) ?? text(row.name);
        return id
          ? [
              {
                id,
                provider: text(row.provider),
                review_status: text(row.review_status),
                parsed_at: text(row.parsed_at),
              },
            ]
          : [];
      }),
      materials: {
        takeoffs: takeoffs.flatMap((row) => {
          const id = text(row.takeoff_id) ?? text(row.name);
          return id
            ? [
                {
                  id,
                  status: text(row.status),
                  prepared_at: text(row.prepared_at),
                },
              ]
            : [];
        }),
        supplier_orders: supplierOrders.flatMap((row) => {
          const id = text(row.supplier_order_id) ?? text(row.name);
          return id
            ? [
                {
                  id,
                  status: text(row.status),
                  requested_delivery_date: text(row.requested_delivery_date),
                  delivery_notes: text(row.delivery_notes),
                },
              ]
            : [];
        }),
      },
      change_orders: changeOrders.flatMap((row) => {
        const id = text(row.change_order_id) ?? text(row.name);
        return id
          ? [
              {
                id,
                number: text(row.change_number),
                version: optionalNumber(row.version),
                status: text(row.status),
                title: text(row.title),
                scope_delta: text(row.scope_delta),
              },
            ]
          : [];
      }),
      safety_plan: safety
        ? {
            id: text(safety.safety_plan_id) ?? text(safety.name)!,
            version: optionalNumber(safety.version),
            status: text(safety.status),
            effective_date: text(safety.effective_date),
            hazard_summary: text(safety.hazard_summary),
            controls: text(safety.controls),
            emergency_plan: text(safety.emergency_plan),
            ppe_requirements: text(safety.ppe_requirements),
            weather_limits: text(safety.weather_limits),
          }
        : null,
      work_package: workPackagePacket.work_package,
      contact: customer
        ? {
            display_name: text(customer.display_name),
            phone: text(customer.phone),
            access_instructions: null,
          }
        : null,
    },
    proof_stream: proofStream,
    proof_page: {
      next_cursor:
        evidence.length === FIELD_PACKET_PROOF_PAGE_SIZE
          ? String(FIELD_PACKET_PROOF_PAGE_SIZE)
          : null,
      page_size: FIELD_PACKET_PROOF_PAGE_SIZE,
    },
    required_proof: gates.flatMap((row) => {
      const id = text(row.gate_id) ?? text(row.name);
      const slot = text(row.gate);
      if (!id || !slot) return [];
      return [
        {
          id,
          slot,
          label: `${slot} proof`,
          state: text(row.state) ?? "Blocked",
          blocker_reason: text(row.blocker_reason),
        },
      ];
    }),
  };
}

export async function buildJobProofReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
  cursor: string | null,
): Promise<ProofPageReadModel | null> {
  const readMode = jobReadMode(auth);
  const assignment = await activeAssignmentForJob(env, auth, jobName);
  if (readMode === "assigned" && !assignment) return null;
  const offset = parseProofCursor(cursor);
  if (offset === null) return null;
  const evidence = await listFrappeResourcePage(
    env,
    "Evidence Item",
    [["Evidence Item", "roof_job", "=", jobName]],
    FIELD_PACKET_PROOF_PAGE_SIZE,
    offset,
  );
  return {
    ...envelope(auth, [...(assignment ? [assignment] : []), ...evidence], []),
    items: evidence
      .map(evidenceProofItem)
      .filter(notNull)
      .sort(compareProofItems),
    next_cursor:
      evidence.length === FIELD_PACKET_PROOF_PAGE_SIZE
        ? String(offset + FIELD_PACKET_PROOF_PAGE_SIZE)
        : null,
  };
}

export async function buildOwnerNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<OwnerNowReadModel> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops")
    throw new Error("owner_scope_required");
  const [
    jobs,
    fieldBlockers,
    gates,
    incidents,
    payments,
    untriagedLeads,
    unknownTriageLeads,
    supplierOrders,
  ] = await Promise.all([
    listFrappeResource(
      env,
      "Roof Job",
      [["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]]],
      OWNER_NOW_SOURCE_LIMIT,
    ),
    listFrappeResource(
      env,
      "Field Check-in",
      [
        ["Field Check-in", "blocker_flag", "=", 1],
        ["Field Check-in", "status", "in", ["Received", "Needs Review"]],
        ["Field Check-in", "sync_state", "=", "Verified"],
      ],
      OWNER_NOW_SOURCE_LIMIT,
    ),
    listFrappeResource(
      env,
      "Production Gate State",
      [["Production Gate State", "state", "=", "Blocked"]],
      OWNER_NOW_SOURCE_LIMIT,
    ),
    listFrappeResource(
      env,
      "Automation Incident",
      [["Automation Incident", "status", "in", ["Open", "Acknowledged"]]],
      OWNER_NOW_SOURCE_LIMIT,
    ),
    listFrappeResource(
      env,
      "Payment Milestone",
      [["Payment Milestone", "status", "in", ["Webhook Seen", "Needs Review"]]],
      OWNER_NOW_SOURCE_LIMIT,
    ),
    listFrappeResource(
      env,
      "Lead Envelope",
      [["Lead Envelope", "triage_status", "=", "Untriaged"]],
      OWNER_NOW_SOURCE_LIMIT,
    ),
    listFrappeResource(
      env,
      "Lead Envelope",
      [["Lead Envelope", "triage_status", "=", "Unknown"]],
      OWNER_NOW_SOURCE_LIMIT,
    ),
    listFrappeResource(
      env,
      "Supplier Order",
      [["Supplier Order", "status", "in", ["Needs Review", "Shortage"]]],
      OWNER_NOW_SOURCE_LIMIT,
    ),
  ]);
  const economicsJobIds = jobs.map((row) => text(row.name)).filter(notNull).sort();
  const [
    economicsQuotes,
    economicsChangeOrders,
    economicsSupplierQuotes,
    economicsSupplierOrders,
    economicsMaterialLots,
    economicsShopOrders,
    economicsFieldCheckins,
    economicsPayments,
    economicsCostEvents,
    economicsReconciliations,
  ] = economicsJobIds.length
    ? await Promise.all([
        listOfficeEstimatorFrappeResource(
          env,
          "Customer Quote",
          [["Customer Quote", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Change Order",
          [["Change Order", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Supplier Quote",
          [["Supplier Quote", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Supplier Order",
          [["Supplier Order", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Material Lot",
          [["Material Lot", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Shop Order",
          [["Shop Order", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Field Check-in",
          [["Field Check-in", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Payment Milestone",
          [["Payment Milestone", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Job Cost Event",
          [
            ["Job Cost Event", "tenant", "=", auth.session.tenant_id],
            ["Job Cost Event", "roof_job", "in", economicsJobIds],
          ],
          OWNER_NOW_SOURCE_LIMIT,
        ),
        listOfficeEstimatorFrappeResource(
          env,
          "Integration Reconciliation",
          [["Integration Reconciliation", "roof_job", "in", economicsJobIds]],
          OWNER_NOW_SOURCE_LIMIT,
        ),
      ])
    : [[], [], [], [], [], [], [], [], [], []];
  const ownerEconomicsSources: Array<readonly [string, FrappeRow[]]> = [
    ["economics.customer_quotes", economicsQuotes],
    ["economics.change_orders", economicsChangeOrders],
    ["economics.supplier_quotes", economicsSupplierQuotes],
    ["economics.supplier_orders", economicsSupplierOrders],
    ["economics.material_lots", economicsMaterialLots],
    ["economics.shop_orders", economicsShopOrders],
    ["economics.field_checkins", economicsFieldCheckins],
    ["economics.payment_milestones", economicsPayments],
    ["economics.job_cost_events", economicsCostEvents],
    ["economics.integration_reconciliations", economicsReconciliations],
  ];
  const ownerEconomicsPartialSources = ownerEconomicsSources.flatMap(
    ([name, rows]) => (rows.length === OWNER_NOW_SOURCE_LIMIT ? [name] : []),
  );
  const rowsForEconomicsJob = (rows: FrappeRow[], jobId: string) =>
    rows.filter((row) => text(row.roof_job) === jobId);
  const economics = [...economicsJobIds].sort().map((jobId) =>
    buildJobEconomicsProjection({
      tenantId: auth.session.tenant_id,
      jobId,
      customerQuotes: rowsForEconomicsJob(economicsQuotes, jobId),
      changeOrders: rowsForEconomicsJob(economicsChangeOrders, jobId),
      supplierQuotes: rowsForEconomicsJob(economicsSupplierQuotes, jobId),
      supplierOrders: rowsForEconomicsJob(economicsSupplierOrders, jobId),
      materialLots: rowsForEconomicsJob(economicsMaterialLots, jobId),
      shopOrders: rowsForEconomicsJob(economicsShopOrders, jobId),
      fieldCheckins: rowsForEconomicsJob(economicsFieldCheckins, jobId),
      paymentMilestones: rowsForEconomicsJob(economicsPayments, jobId),
      costEvents: rowsForEconomicsJob(economicsCostEvents, jobId),
      accountingReconciliations: rowsForEconomicsJob(
        economicsReconciliations,
        jobId,
      ),
      partialSources: ownerEconomicsPartialSources,
    }),
  );
  const leadRows = [...untriagedLeads, ...unknownTriageLeads];
  const leadIds = leadRows
    .map((row) => text(row.envelope_id) ?? text(row.name))
    .filter(notNull);
  const leadEvidence = await listLeadMctbEvidence(env, leadIds);
  const envelopeById = new Map(
    leadEvidence.envelopes.map((row) => [row.envelope_id, row]),
  );
  const receiptsByEnvelope = new Map<string, LeadAckReceipt[]>();
  for (const receipt of leadEvidence.receipts) {
    const current = receiptsByEnvelope.get(receipt.envelope_id) ?? [];
    current.push(receipt);
    receiptsByEnvelope.set(receipt.envelope_id, current);
  }
  const leadException = (
    row: FrappeRow,
    kind: "untriaged_lead" | "lead_triage_unknown",
  ) => {
    const id = text(row.envelope_id) ?? text(row.name);
    if (!id) return [];
    const owned = envelopeById.get(id);
    const receivedAt = owned?.received_at ?? null;
    const source = text(row.source);
    const triageStatus = text(row.triage_status) ?? "Unknown";
    const mctb = mctbStatus(receivedAt, receiptsByEnvelope.get(id) ?? [], now);
    const titlePrefix =
      kind === "untriaged_lead" ? "Untriaged lead" : "Lead triage is unknown";
    return exceptionRow(row, {
      id,
      kind,
      severity: null,
      title: text(row.contact_name)
        ? `${titlePrefix}: ${text(row.contact_name)}`
        : titlePrefix,
      why:
        [source, owned?.bus_status ?? text(row.status)]
          .filter(notNull)
          .join(" · ") || null,
      jobId: text(row.job_ref),
      occurredAt: receivedAt ?? text(row.event_ts),
      receivedAt,
      busStatus: owned?.bus_status ?? text(row.status),
      triageStatus,
      mctb,
    });
  };
  const untriagedExceptions = untriagedLeads.flatMap((row) =>
    leadException(row, "untriaged_lead"),
  );
  const unknownTriageExceptions = unknownTriageLeads.flatMap((row) =>
    leadException(row, "lead_triage_unknown"),
  );
  const exceptions: OwnerNowReadModel["exceptions"] = [
    ...fieldBlockers.flatMap((row) =>
      exceptionRow(row, {
        id: text(row.checkin_id) ?? text(row.name),
        kind: "field_blocker",
        severity: null,
        title: `${text(row.blocker_category) ?? "Field"} work-stop reported`,
        why: text(row.blocker_summary),
        jobId: text(row.roof_job),
        occurredAt: text(row.submitted_at),
      }),
    ),
    ...gates.flatMap((row) =>
      exceptionRow(row, {
        id: text(row.gate_id) ?? text(row.name),
        kind: "blocked_gate",
        severity: null,
        title: `${text(row.gate) ?? "Production"} gate blocked`,
        why: text(row.blocker_reason),
        jobId: text(row.roof_job),
        occurredAt: text(row.assigned_at),
        dueAt: text(row.due_at),
      }),
    ),
    ...incidents.flatMap((row) =>
      exceptionRow(row, {
        id: text(row.incident_id) ?? text(row.name),
        kind: "automation_incident",
        severity: text(row.severity),
        title: text(row.summary) ?? "Automation incident",
        why: text(row.category),
        jobId: text(row.roof_job),
        occurredAt: text(row.detected_at),
      }),
    ),
    ...supplierOrders.flatMap((row) =>
      exceptionRow(row, {
        id: text(row.supplier_order_id) ?? text(row.name),
        kind: "material_exception",
        severity: null,
        title: `Supplier order ${text(row.status) ?? "needs review"}`,
        why: text(row.delivery_notes),
        jobId: text(row.roof_job),
        occurredAt: text(row.prepared_at),
        dueAt: text(row.requested_delivery_date),
      }),
    ),
    ...payments.flatMap((row) =>
      exceptionRow(row, {
        id: text(row.payment_milestone_id) ?? text(row.name),
        kind: "finance_exception",
        severity: null,
        title: `${text(row.milestone_type) ?? "Payment"} needs review`,
        why: text(row.notes) ?? text(row.status),
        jobId: text(row.roof_job),
        occurredAt: text(row.event_ts),
        dueAt: text(row.due_date),
      }),
    ),
    ...untriagedExceptions,
    ...unknownTriageExceptions,
  ];
  const ownerSources: Array<readonly [string, FrappeRow[]]> = [
    ["active_jobs", jobs],
    ["field_blockers", fieldBlockers],
    ["blocked_gates", gates],
    ["automation_incidents", incidents],
    ["finance_exceptions", payments],
    ["untriaged_leads", untriagedLeads],
    ["lead_triage_unknown", unknownTriageLeads],
    ["material_exceptions", supplierOrders],
    ...ownerEconomicsSources,
  ];
  const partialSources = ownerSources.flatMap(([name, rows]) =>
    rows.length === OWNER_NOW_SOURCE_LIMIT ? [name] : [],
  );
  const stale = ["exceptions.next_action"];
  if (exceptions.some((row) => row.due_at === null))
    stale.push("exceptions.due_at");
  if (partialSources.length > 0) stale.push("exceptions.partial_sources");
  return {
    ...envelope(
      auth,
      [
        ...jobs,
        ...fieldBlockers,
        ...gates,
        ...incidents,
        ...payments,
        ...leadRows,
        ...supplierOrders,
        ...economicsQuotes,
        ...economicsChangeOrders,
        ...economicsSupplierQuotes,
        ...economicsSupplierOrders,
        ...economicsMaterialLots,
        ...economicsShopOrders,
        ...economicsFieldCheckins,
        ...economicsPayments,
        ...economicsCostEvents,
        ...economicsReconciliations,
      ],
      stale,
    ),
    exceptions,
    partial_sources: partialSources,
    economics,
    summary: {
      active_jobs: jobs.length,
      field_blockers: fieldBlockers.length,
      blocked_gates: gates.length,
      open_incidents: incidents.length,
      finance_exceptions: payments.length,
      untriaged_leads: untriagedExceptions.length,
      lead_triage_unknown: unknownTriageExceptions.length,
      mctb_unproven_due: untriagedExceptions.filter((row) =>
        mctbMissedSla(row.mctb),
      ).length,
      material_exceptions: supplierOrders.length,
      economics_needs_review: economics.filter(
        (projection) => projection.state !== "complete",
      ).length,
    },
  };
}

/**
 * Office-only Sales Desk payload. This joins only the lead, estimate, quote, proposal-publication,
 * and consent context needed for a human review. It intentionally excludes raw intake payloads,
 * outbound controls, price-book internals, and generic Frappe queries.
 */
export async function buildSalesReadModel(
  env: AppEnv,
  auth: AuthContext,
): Promise<SalesReadModel> {
  if (!auth.permissions.includes("sales:read"))
    throw new Error("office_scope_required");

  const leads = await listOfficeSalesFrappeResource(
    env,
    "Lead Envelope",
    [],
    SALES_SOURCE_LIMIT,
  );
  const leadIds = leads.map((row) => text(row.name)).filter(notNull);
  const leadJobRefs = leads.map((row) => text(row.job_ref)).filter(notNull);
  const [jobsLinkedByLead, jobsByReference, estimates, leadConsents] =
    await Promise.all([
      leadIds.length > 0
        ? listOfficeSalesFrappeResource(
            env,
            "Roof Job",
            [["Roof Job", "lead_envelope", "in", leadIds]],
            SALES_SOURCE_LIMIT,
          )
        : Promise.resolve([]),
      leadJobRefs.length > 0
        ? listOfficeSalesFrappeResource(
            env,
            "Roof Job",
            [["Roof Job", "name", "in", leadJobRefs]],
            SALES_SOURCE_LIMIT,
          )
        : Promise.resolve([]),
      leadIds.length > 0
        ? listOfficeSalesFrappeResource(
            env,
            "Instant Estimate Session",
            [["Instant Estimate Session", "lead_envelope", "in", leadIds]],
            SALES_SOURCE_LIMIT,
          )
        : Promise.resolve([]),
      leadIds.length > 0
        ? listOfficeSalesFrappeResource(
            env,
            "Communication Consent",
            [["Communication Consent", "lead_envelope", "in", leadIds]],
            SALES_SOURCE_LIMIT,
          )
        : Promise.resolve([]),
    ]);

  const jobs = uniqueRows([...jobsLinkedByLead, ...jobsByReference]);

  const jobIds = jobs.map((row) => text(row.name)).filter(notNull);
  const customerIds = jobs.map((row) => text(row.customer)).filter(notNull);
  const [quotes, jobConsents, customerConsents] = await Promise.all([
    jobIds.length > 0
      ? listOfficeSalesFrappeResource(
          env,
          "Customer Quote",
          [["Customer Quote", "roof_job", "in", jobIds]],
          SALES_SOURCE_LIMIT,
        )
      : Promise.resolve([]),
    jobIds.length > 0
      ? listOfficeSalesFrappeResource(
          env,
          "Communication Consent",
          [["Communication Consent", "roof_job", "in", jobIds]],
          SALES_SOURCE_LIMIT,
        )
      : Promise.resolve([]),
    customerIds.length > 0
      ? listOfficeSalesFrappeResource(
          env,
          "Communication Consent",
          [["Communication Consent", "customer", "in", customerIds]],
          SALES_SOURCE_LIMIT,
        )
      : Promise.resolve([]),
  ]);
  const quoteNames = quotes.map((row) => text(row.name)).filter(notNull);
  const proposals =
    quoteNames.length > 0
      ? await listOfficeSalesFrappeResource(
          env,
          "Proposal Evidence Pack",
          [["Proposal Evidence Pack", "quotation", "in", quoteNames]],
          SALES_SOURCE_LIMIT,
        )
      : [];
  const proposalSourcePartial = proposals.length === SALES_SOURCE_LIMIT;

  const jobById = mapRowsByReference(jobs, "name");
  const latestJobsByLead = latestRowsByReference(jobs, "lead_envelope");
  const estimatesByLead = latestRowsByReference(estimates, "lead_envelope");
  const quotesByJob = latestRowsByReference(
    quotes,
    "roof_job",
    "quote_version",
  );
  const proposalsByQuote = latestRowsByReference(proposals, "quotation");
  const publishedProposalsByQuote = latestRowsByReference(
    proposals.filter((row) => proposalStatusIsPublished(text(row.status))),
    "quotation",
  );
  const consentRows = uniqueRows([
    ...leadConsents,
    ...jobConsents,
    ...customerConsents,
  ]);
  const directConsentsByLead = groupBy(consentRows, "lead_envelope");
  const consentsByJob = groupBy(consentRows, "roof_job");
  const consentsByCustomer = groupBy(consentRows, "customer");
  const consentSourcesPartial = [
    leadConsents,
    jobConsents,
    customerConsents,
  ].some((rows) => rows.length === SALES_SOURCE_LIMIT);

  const shaped: SalesReadModel["leads"] = leads
    .flatMap((lead) => {
      const leadId = text(lead.name);
      if (!leadId) return [];
      const linkedJob =
        latestJobsByLead.get(leadId) ??
        jobById.get(text(lead.job_ref) ?? "") ??
        null;
      const jobId = linkedJob ? text(linkedJob.name) : null;
      const customerId = linkedJob ? text(linkedJob.customer) : null;
      const linkedConsents = uniqueRows([
        ...(directConsentsByLead.get(leadId) ?? []),
        ...(jobId ? (consentsByJob.get(jobId) ?? []) : []),
        ...(customerId ? (consentsByCustomer.get(customerId) ?? []) : []),
      ]);
      const supersededConsentIds = new Set(
        linkedConsents.map((row) => text(row.supersedes)).filter(notNull),
      );
      const consentRecords = linkedConsents
        .filter((row) =>
          ![text(row.name), text(row.consent_id)]
            .filter(notNull)
            .some((id) => supersededConsentIds.has(id))
        )
        .map(salesConsentRecord)
        .filter(notNull);
      const estimate = salesEstimateModel(estimatesByLead.get(leadId));
      const quoteRow = jobId ? quotesByJob.get(jobId) : undefined;
      const quote = salesQuoteModel(quoteRow);
      const quoteName = quoteRow ? text(quoteRow.name) : null;
      const proposal = quoteName
        ? salesProposalModel(
            proposalsByQuote.get(quoteName),
            publishedProposalsByQuote.get(quoteName),
            proposalSourcePartial,
          )
        : null;
      const attention = salesAttention(lead, estimate, quote);
      const consentContext: SalesReadModel["leads"][number]["consent"]["context"] =
        consentSourcesPartial
          ? "partial"
          : consentRecords.length > 0
            ? "recorded"
            : "no_linked_record";
      return [
        {
          id: leadId,
          envelope_id: text(lead.envelope_id) ?? leadId,
          source: text(lead.source),
          received_at: text(lead.event_ts),
          transport_status: text(lead.status),
          intent_queue: text(lead.intent_queue),
          contact: {
            display_name: text(lead.contact_name),
            phone: text(lead.contact_phone),
            email: text(lead.contact_email),
          },
          triage: {
            status: text(lead.triage_status),
            summary: text(lead.triage_summary),
          },
          job:
            linkedJob && jobId
              ? {
                  id: jobId,
                  job_number: text(linkedJob.job_number),
                  status: text(linkedJob.job_status),
                  service_type: text(linkedJob.service_type),
                  workflow_profile: text(linkedJob.workflow_profile),
                }
              : null,
          estimate,
          quote,
          proposal,
          consent: {
            context: consentContext,
            records: consentRecords,
          },
          attention,
        },
      ];
    })
    .sort(compareSalesLead);

  const sourceRows: Array<readonly [string, FrappeRow[]]> = [
    ["leads", leads],
    ["roof_jobs_by_lead", jobsLinkedByLead],
    ["roof_jobs_by_reference", jobsByReference],
    ["instant_estimates", estimates],
    ["customer_quotes", quotes],
    ["proposal_evidence_packs", proposals],
    ["lead_consents", leadConsents],
    ["job_consents", jobConsents],
    ["customer_consents", customerConsents],
  ];
  const partialSources = sourceRows.flatMap(([name, rows]) =>
    rows.length === SALES_SOURCE_LIMIT ? [name] : [],
  );
  const base = envelope(
    auth,
    [
      ...leads,
      ...jobs,
      ...estimates,
      ...quotes,
      ...proposals,
      ...leadConsents,
      ...jobConsents,
      ...customerConsents,
    ],
    partialSources.length > 0 ? ["sales.partial_sources"] : [],
  );
  const leadTriagePreparationAvailable = Boolean(
    auth.permissions.includes("approvals:prepare") &&
      approvalBrokerConfig(env) &&
      auth.session.frappe_user_id?.trim(),
  );
  return {
    ...base,
    allowed_actions: [
      ...base.allowed_actions,
      ...(auth.permissions.includes("approvals:read") ? ["approval.read"] : []),
      ...(leadTriagePreparationAvailable ? ["approval.prepare"] : []),
      ...(auth.permissions.includes("estimator:read")
        ? ["estimator.read"]
        : []),
      "sales.read",
    ],
    partial_sources: partialSources,
    summary: {
      listed_leads: shaped.length,
      triage_unresolved: shaped.filter((lead) =>
        lead.attention.includes("triage_unresolved"),
      ).length,
      estimate_needs_review: shaped.filter((lead) =>
        lead.attention.includes("estimate_needs_review"),
      ).length,
      quote_needs_review: shaped.filter((lead) =>
        lead.attention.includes("quote_needs_review"),
      ).length,
      quote_expired: shaped.filter((lead) =>
        lead.attention.includes("quote_expired"),
      ).length,
      no_linked_consent_record: shaped.filter(
        (lead) => lead.consent.context === "no_linked_record",
      ).length,
    },
    leads: shaped,
  };
}

/**
 * Office-only read projection for measurement-to-proposal review. It intentionally stops before
 * pricing, proposal assembly, signature, payment, or customer communication mutations. Geometry
 * is recomputed server-side from the bounded raw source and is explicitly not field verification.
 */
export async function buildEstimatorWorkbenchReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
  asOf: Date = new Date(),
): Promise<EstimatorWorkbenchReadModel | null> {
  if (!auth.permissions.includes("estimator:read"))
    throw new Error("office_scope_required");
  if (!validJobName(jobName)) return null;
  const readModelGeneratedAt = asOf.toISOString();
  const configuredPriceList = estimatorPriceList(env, readModelGeneratedAt);

  const [job] = await listOfficeEstimatorFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "name", "=", jobName]],
    1,
  );
  const jobId = job ? text(job.name) : null;
  if (!job || !jobId) return null;
  const insuranceAccessGranted = hasRestrictedInsuranceAccess(env, auth);

  const [
    measurementRows,
    visualModelRows,
    roofAreaRows,
    takeoffRows,
    quoteRows,
    proposalRows,
    changeOrderRows,
    supplierQuoteRows,
    supplierOrderRows,
    materialLotRows,
    shopOrderRows,
    fieldCheckinRows,
    paymentMilestoneRows,
    jobCostEventRows,
    accountingReconciliationRows,
    insuranceSupplementRows,
    scopeRows,
    pricingAuthorityRows,
  ] = await Promise.all([
    listOfficeEstimatorFrappeResource(
      env,
      "Measurement Report",
      [["Measurement Report", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Visual Property Model",
      [["Visual Property Model", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Roof Area",
      [["Roof Area", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Material Takeoff",
      [["Material Takeoff", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Customer Quote",
      [["Customer Quote", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Proposal Evidence Pack",
      [["Proposal Evidence Pack", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Change Order",
      [["Change Order", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Supplier Quote",
      [["Supplier Quote", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Supplier Order",
      [["Supplier Order", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Material Lot",
      [["Material Lot", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Shop Order",
      [["Shop Order", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Field Check-in",
      [["Field Check-in", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Payment Milestone",
      [["Payment Milestone", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Job Cost Event",
      [
        ["Job Cost Event", "tenant", "=", auth.session.tenant_id],
        ["Job Cost Event", "roof_job", "=", jobId],
      ],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    listOfficeEstimatorFrappeResource(
      env,
      "Integration Reconciliation",
      [["Integration Reconciliation", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    insuranceAccessGranted
      ? listOfficeEstimatorFrappeResource(
          env,
          "Insurance Supplement",
          [["Insurance Supplement", "roof_job", "=", jobId]],
          ESTIMATOR_SOURCE_LIMIT,
        )
      : Promise.resolve([]),
    listOfficeEstimatorFrappeResource(
      env,
      "Scope Clause",
      [["Scope Clause", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
    configuredPriceList.identity &&
      configuredPriceList.identity.tenantId === auth.session.tenant_id
      ? listOfficeEstimatorFrappeResource(
          env,
          "Price Book Rule",
          [
            ["Price Book Rule", "status", "=", "Approved"],
            ["Price Book Rule", "rule_type", "=", "Pricing Policy"],
            [
              "Price Book Rule",
              "pricing_policy_id",
              "=",
              configuredPriceList.identity.policyId,
            ],
            [
              "Price Book Rule",
              "pricing_policy_revision",
              "=",
              configuredPriceList.identity.policyRevision,
            ],
          ],
          ESTIMATOR_PRICING_AUTHORITY_LIMIT,
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  const selectedMeasurementRow = latestRecord(measurementRows);
  const selectedMeasurementName = selectedMeasurementRow
    ? text(selectedMeasurementRow.name)
    : null;
  const selectedVisualModelRow = latestRecord(visualModelRows);
  const selectedVisualModelName = selectedVisualModelRow
    ? text(selectedVisualModelRow.name)
    : null;
  const visualModelSourceComplete =
    visualModelRows.length < ESTIMATOR_SOURCE_LIMIT;
  const selectedTakeoffRow = selectedMeasurementName
    ? latestRecord(
        takeoffRows.filter(
          (row) => text(row.measurement_report) === selectedMeasurementName,
        ),
      )
    : null;
  const selectedTakeoffName = selectedTakeoffRow
    ? text(selectedTakeoffRow.name)
    : null;
  const selectedQuoteRow = latestRecord(quoteRows, "quote_version");
  const selectedQuoteName = selectedQuoteRow
    ? text(selectedQuoteRow.name)
    : null;
  const selectedProposalRow = selectedQuoteName
    ? latestRecord(
        proposalRows.filter((row) => text(row.quotation) === selectedQuoteName),
      )
    : null;
  const quote = estimatorQuote(selectedQuoteRow);
  const pricingSnapshot = estimatorPricingSnapshot(quote);
  const quoteRevision = estimatorQuoteRevision(selectedQuoteRow, quoteRows);
  const scopeChanges = newestFirst(changeOrderRows).flatMap((row) =>
    estimatorScopeChange(row, selectedQuoteName, quoteRows),
  );
  const [
    measurementRead,
    visualModelRead,
    takeoffRead,
    insuranceSupplementReads,
  ] = await Promise.all([
    selectedMeasurementName
      ? safeEstimatorDetailRead(
          env,
          "Measurement Report",
          selectedMeasurementName,
        )
      : Promise.resolve({ row: null, unavailable_reason: null }),
    selectedVisualModelName && visualModelSourceComplete
      ? safeEstimatorDetailRead(
          env,
          "Visual Property Model",
          selectedVisualModelName,
        )
      : Promise.resolve({ row: null, unavailable_reason: null }),
    selectedTakeoffName
      ? safeEstimatorDetailRead(env, "Material Takeoff", selectedTakeoffName)
      : Promise.resolve({ row: null, unavailable_reason: null }),
    Promise.all(
      insuranceSupplementRows.map(async (row) => {
        const name = text(row.name);
        return {
          name,
          read: name
            ? await safeEstimatorDetailRead(env, "Insurance Supplement", name)
            : {
                row: null,
                unavailable_reason: "insurance_supplement_detail_unavailable",
              },
        };
      }),
    ),
  ]);
  const measurementDetail = matchesMeasurementDetail(
    measurementRead.row,
    selectedMeasurementName,
    jobId,
  )
    ? measurementRead.row
    : null;
  const visualModelDetail =
    visualModelSourceComplete &&
    matchesVisualModelDetail(
      visualModelRead.row,
      selectedVisualModelName,
      jobId,
    )
      ? visualModelRead.row
      : null;
  const takeoffDetail = matchesTakeoffDetail(
    takeoffRead.row,
    selectedTakeoffName,
    jobId,
    selectedMeasurementName,
  )
    ? takeoffRead.row
    : null;
  const measurementDetailIssue =
    measurementRead.unavailable_reason ??
    (measurementRead.row && !measurementDetail
      ? "measurement_detail_mismatch"
      : null);
  const takeoffDetailIssue =
    takeoffRead.unavailable_reason ??
    (takeoffRead.row && !takeoffDetail ? "takeoff_detail_mismatch" : null);

  const geometryCapture: { model?: GeometryModel } = {};
  const geometry = measurementDetail
    ? await estimatorGeometryFromRaw(env, text(measurementDetail.raw_key), geometryCapture)
    : unavailableEstimatorGeometry(
        selectedMeasurementRow
          ? (measurementDetailIssue ?? "measurement_detail_unavailable")
          : "no_measurement_report",
      );
  const roofGraph = estimatorRoofGraphProjection(measurementDetail);
  // Measurement-to-money projection: recomputed takeoff over the same verified
  // model, priced only when the tenant supplies a price list.
  const computedTakeoff = estimatorComputedTakeoff(geometryCapture.model ?? null);
  const pricingAuthority = configuredPriceList.identity && configuredPriceList.list
    ? await verifyPricingAuthority(
        configuredPriceList.list,
        pricingAuthorityRows,
        {
          pricedAt: readModelGeneratedAt,
          tenantId: auth.session.tenant_id,
        },
      )
    : undefined;
  const computedEstimate = estimatorComputedEstimate(
    configuredPriceList,
    computedTakeoff.takeoff,
    readModelGeneratedAt,
    pricingAuthority ?? undefined,
  );
  const staleFields: string[] = [];
  if (selectedMeasurementRow && !measurementDetail)
    staleFields.push("measurements.selected_detail");
  if (selectedTakeoffRow && !takeoffDetail)
    staleFields.push("takeoffs.selected_detail");
  const insuranceSupplementDetails = new Map<string, FrappeRow | null>();
  for (const { name, read } of insuranceSupplementReads) {
    if (!name) continue;
    const detail = matchesInsuranceSupplementDetail(read.row, name, jobId)
      ? read.row
      : null;
    insuranceSupplementDetails.set(name, detail);
    if (
      !detail &&
      !staleFields.includes("insurance_supplements.detail_unavailable")
    ) {
      staleFields.push("insurance_supplements.detail_unavailable");
    }
  }

  const sourceRows: Array<readonly [string, FrappeRow[]]> = [
    ["measurement_reports", measurementRows],
    ["material_takeoffs", takeoffRows],
    ["customer_quotes", quoteRows],
    ["proposal_evidence_packs", proposalRows],
    ["change_orders", changeOrderRows],
    ["supplier_quotes", supplierQuoteRows],
    ["supplier_orders", supplierOrderRows],
    ["material_lots", materialLotRows],
    ["shop_orders", shopOrderRows],
    ["field_checkins", fieldCheckinRows],
    ["payment_milestones", paymentMilestoneRows],
    ["job_cost_events", jobCostEventRows],
    ["integration_reconciliations", accountingReconciliationRows],
    ["insurance_supplements", insuranceSupplementRows],
    ["scope_clauses", scopeRows],
  ];
  const partialSources = sourceRows.flatMap(([name, rows]) =>
    rows.length === ESTIMATOR_SOURCE_LIMIT ? [name] : [],
  );
  if (pricingAuthorityRows.length === ESTIMATOR_PRICING_AUTHORITY_LIMIT) {
    partialSources.push("pricing_authority");
  }
  const economics = buildJobEconomicsProjection({
    tenantId: auth.session.tenant_id,
    jobId,
    customerQuotes: quoteRows,
    changeOrders: changeOrderRows,
    supplierQuotes: supplierQuoteRows,
    supplierOrders: supplierOrderRows,
    materialLots: materialLotRows,
    shopOrders: shopOrderRows,
    fieldCheckins: fieldCheckinRows,
    paymentMilestones: paymentMilestoneRows,
    costEvents: jobCostEventRows,
    accountingReconciliations: accountingReconciliationRows,
    partialSources,
  });
  const base = envelope(
    auth,
    [
      job,
      ...measurementRows,
      ...visualModelRows,
      ...roofAreaRows,
      ...takeoffRows,
      ...quoteRows,
      ...proposalRows,
      ...changeOrderRows,
      ...supplierQuoteRows,
      ...supplierOrderRows,
      ...materialLotRows,
      ...shopOrderRows,
      ...fieldCheckinRows,
      ...paymentMilestoneRows,
      ...jobCostEventRows,
      ...accountingReconciliationRows,
      ...insuranceSupplementRows,
      ...scopeRows,
      ...pricingAuthorityRows,
    ],
    staleFields,
    readModelGeneratedAt,
  );
  const quoteRevisionPreparationAvailable = Boolean(
    quote &&
    quote.id &&
    quote.version !== null &&
    quote.version > 0 &&
    quote.status !== "Accepted" &&
    quoteRevisionApprovalBrokerConfig(env) &&
    approvalDecisionConfig(env) &&
    auth.session.frappe_user_id?.trim(),
  );
  const facetLaunchAvailable = Boolean(
    auth.permissions.includes("facet:launch") && quote &&
    selectedQuoteName === text(job.quotation) && quote.version !== null && quote.version > 0 &&
    quote.status === "Approved" && quote.approved_at && !quote.accepted_at &&
    facetLaunchConfigured(env, auth.session.tenant_id)
  );
  return {
    ...base,
    allowed_actions: [
      ...base.allowed_actions,
      "estimator.read",
      ...(quoteRevisionPreparationAvailable
        ? ["quote_revision_approval.prepare"]
        : []),
      ...(facetLaunchAvailable ? ["facet_launch.create"] : []),
    ],
    partial_sources: partialSources,
    job: {
      id: jobId,
      roof_job_id: text(job.roof_job_id),
      job_number: text(job.job_number),
      brand: text(job.brand),
      service_type: text(job.service_type),
      status: text(job.job_status),
      workflow_profile: text(job.workflow_profile),
    },
    economics,
    lineage: {
      measurement_to_takeoff: measurementToTakeoffLineage(
        selectedMeasurementRow,
        selectedTakeoffRow,
        takeoffRows,
      ),
      quote_to_proposal: quoteToProposalLineage(
        selectedQuoteRow,
        selectedProposalRow,
        proposalRows,
      ),
    },
    measurements: {
      reports: newestFirst(measurementRows).flatMap(
        estimatorMeasurementSummary,
      ),
      selected: estimatorMeasurementSelection(
        selectedMeasurementRow,
        measurementDetail,
        geometry,
        roofGraph,
        computedTakeoff.projection,
        computedEstimate,
      ),
    },
    visual_model: estimatorVisualModel(
      env,
      selectedVisualModelRow,
      visualModelDetail,
      roofAreaRows,
      selectedMeasurementRow,
    ),
    takeoffs: {
      records: newestFirst(takeoffRows).flatMap(estimatorTakeoffSummary),
      selected: estimatorTakeoffSelection(selectedTakeoffRow, takeoffDetail),
    },
    quote,
    pricing_snapshot: pricingSnapshot,
    quote_revision: quoteRevision,
    proposal: estimatorProposal(selectedProposalRow),
    scope_changes: scopeChanges,
    insurance_supplements: newestFirst(insuranceSupplementRows).flatMap(
      (row, index) =>
        estimatorInsuranceSupplement(
          "insurance-supplement-" + (index + 1),
          row,
          insuranceSupplementDetails.get(text(row.name) ?? "") ?? null,
          measurementRows,
        ),
    ),
    proposal_readiness: estimatorProposalReadiness({
      geometry,
      measurement: selectedMeasurementRow,
      takeoff: selectedTakeoffRow,
      takeoffDetail,
      takeoffLineage: measurementToTakeoffLineage(
        selectedMeasurementRow,
        selectedTakeoffRow,
        takeoffRows,
      ),
      quote,
      pricingSnapshot,
      proposalLineage: quoteToProposalLineage(
        selectedQuoteRow,
        selectedProposalRow,
        proposalRows,
      ),
      scopeChanges,
      partialSources,
      staleFields,
    }),
    scope_clauses: newestFirst(scopeRows).flatMap(estimatorScopeClause),
  };
}

function emptyToday(
  env: AppEnv,
  auth: AuthContext,
  rows: FrappeRow[] = [],
): TodayReadModel {
  return {
    ...envelope(auth, rows, []),
    date: tenantDate(env.APP_TIME_ZONE),
    jobs: [],
    work_objects: [],
  };
}

/**
 * The Crew Profiles this user is an active member of. Membership is re-derived
 * from the child rows rather than trusted from the filter, so a widened Frappe
 * response can never enlarge the caller's authority.
 */
async function activeCrewProfilesForUser(
  env: AppEnv,
  userId: string,
): Promise<Set<string>> {
  const memberRows = await listFrappeResource(
    env,
    "Crew Member",
    [
      ["Crew Member", "crew_user", "=", userId],
      ["Crew Member", "active", "=", 1],
    ],
    100,
    "Crew Profile",
  );
  return new Set(
    memberRows.flatMap((row) => {
      const parent = text(row.parent);
      const valid =
        row.parenttype === "Crew Profile" &&
        row.parentfield === "members" &&
        booleanValue(row.active) === true;
      return parent && valid && sameUser(row.crew_user, userId) ? [parent] : [];
    }),
  );
}

async function authorizedAssignments(
  env: AppEnv,
  auth: AuthContext,
  jobName?: string,
): Promise<FrappeRow[]> {
  const baseFilters: FrappeFilter[] = [
    ["Job Assignment", "status", "in", [...ACTIVE_ASSIGNMENT_STATUSES]],
  ];
  if (jobName)
    baseFilters.unshift(["Job Assignment", "roof_job", "=", jobName]);
  if (jobReadMode(auth) === "any") {
    return await listFrappeResource(env, "Job Assignment", baseFilters, 100);
  }
  const userId = auth.session.frappe_user_id;
  if (!userId) return [];
  const [direct, crewProfiles, workerRows] = await Promise.all([
    listFrappeResource(
      env,
      "Job Assignment",
      [...baseFilters, ["Job Assignment", "assigned_user", "=", userId]],
      100,
    ),
    activeCrewProfilesForUser(env, userId),
    !jobName
      ? listFrappeResource(
          env,
          "Work Package Worker",
          [["Work Package Worker", "worker_user", "=", userId]],
          100,
          "Job Assignment",
        )
      : Promise.resolve([]),
  ]);
  const crew =
    crewProfiles.size > 0
      ? await listFrappeResource(
          env,
          "Job Assignment",
          [
            ...baseFilters,
            ["Job Assignment", "crew_profile", "in", [...crewProfiles]],
          ],
          100,
        )
      : [];
  const workerAssignmentNames = new Set(
    workerRows
      .filter(
        (row) =>
          row.parenttype === "Job Assignment" &&
          row.parentfield === "assigned_workers" &&
          sameUser(row.worker_user, userId),
      )
      .map((row) => text(row.parent))
      .filter((value): value is string => Boolean(value)),
  );
  const workerAssignments =
    workerAssignmentNames.size > 0
      ? await listFrappeResource(
          env,
          "Job Assignment",
          [
            ...baseFilters,
            ["Job Assignment", "name", "in", [...workerAssignmentNames]],
          ],
          100,
        )
      : [];
  const deduplicated = new Map<string, FrappeRow>();
  for (const row of [...direct, ...crew, ...workerAssignments]) {
    const id = text(row.name);
    const active = ACTIVE_ASSIGNMENT_STATUSES.includes(
      text(row.status) as never,
    );
    const correctJob = !jobName || text(row.roof_job) === jobName;
    const allowed =
      sameUser(row.assigned_user, userId) ||
      crewProfiles.has(text(row.crew_profile) ?? "") ||
      workerAssignmentNames.has(id ?? "");
    if (id && active && correctJob && allowed) deduplicated.set(id, row);
  }
  return [...deduplicated.values()];
}

function jobReadMode(auth: AuthContext): "any" | "assigned" {
  if (auth.permissions.includes("jobs:read:any")) return "any";
  if (auth.permissions.includes("jobs:read:assigned")) return "assigned";
  throw new Error("job_scope_required");
}

function assignmentModel(row: FrappeRow): AssignmentReadModel {
  return {
    id: text(row.name)!,
    assignment_id: text(row.assignment_id),
    type: text(row.assignment_type),
    status: text(row.status),
    crew_profile: text(row.crew_profile),
    scheduled_start: text(row.scheduled_start),
    scheduled_end: text(row.scheduled_end),
    blocker_reason: text(row.blocker_reason),
  };
}

function productionAssignmentModel(
  row: FrappeRow,
): NonNullable<ProductionRunwayReadModel["jobs"][number]["assignment"]> {
  return {
    id: text(row.name)!,
    type: text(row.assignment_type),
    status: text(row.status),
    scheduled_start: text(row.scheduled_start),
    scheduled_end: text(row.scheduled_end),
  };
}

function preferredAssignmentsByJob(rows: FrappeRow[]): Map<string, FrappeRow> {
  const grouped = groupBy(rows, "roof_job");
  return new Map(
    [...grouped.entries()].flatMap(([job, assignments]) => {
      const preferred = preferredAssignment(assignments);
      return preferred ? [[job, preferred]] : [];
    }),
  );
}

function assignmentWorkObjectScope(
  row: FrappeRow,
): Pick<
  TodayReadModel["work_objects"][number],
  | "work_object_type"
  | "work_object_id"
  | "physical_context_type"
  | "physical_context_id"
> | null {
  const workObjectType = text(row.work_object_type);
  const workObjectId = text(row.work_object_id);
  const physicalContextType = text(row.physical_context_type);
  const physicalContextId = text(row.physical_context_id);
  if (
    !workObjectType ||
    workObjectType === "Roof Job" ||
    !workObjectId ||
    !physicalContextType ||
    !physicalContextId
  ) {
    return null;
  }
  return {
    work_object_type: workObjectType,
    work_object_id: workObjectId,
    physical_context_type: physicalContextType,
    physical_context_id: physicalContextId,
  };
}

function preferredAssignmentsByWorkObject(
  rows: FrappeRow[],
): FrappeRow[] {
  const grouped = new Map<string, FrappeRow[]>();
  for (const row of rows) {
    const scope = assignmentWorkObjectScope(row);
    if (!scope) continue;
    const key = [
      scope.work_object_type,
      scope.work_object_id,
      scope.physical_context_type,
      scope.physical_context_id,
    ].join("\u0000");
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    // A typed Today row is an actionable route, so an ambiguous active
    // assignment must be withheld rather than choosing a browser write target.
    .map((candidates) => (candidates.length === 1 ? candidates[0] ?? null : null))
    .filter((row): row is FrappeRow => row !== null);
}

function preferredAssignment(rows: FrappeRow[]): FrappeRow | null {
  return (
    [...rows].sort((left, right) => {
      const priority = (value: unknown) =>
        ["In Progress", "Blocked", "Accepted", "Assigned"].indexOf(
          text(value) ?? "",
        );
      const difference = priority(left.status) - priority(right.status);
      return (
        difference ||
        compareSchedule(text(left.scheduled_start), text(right.scheduled_start))
      );
    })[0] ?? null
  );
}

function gateModel(
  row: FrappeRow,
  redactOwner: boolean,
): JobReadModel["gates"] {
  const gateId = text(row.gate_id) ?? text(row.name);
  return gateId
    ? [
        {
          id: gateId,
          name: text(row.gate),
          state: text(row.state),
          blocker_reason: text(row.blocker_reason),
          owner: redactOwner ? null : text(row.owner_user),
          due_at: text(row.due_at),
        },
      ]
    : [];
}

function evidenceProofItem(row: FrappeRow): ProofStreamItem | null {
  const id = text(row.evidence_id) ?? text(row.name);
  return id
    ? {
        id,
        type: text(row.evidence_type),
        proof_slot: text(row.proof_slot),
        occurred_at: text(row.captured_at),
        summary: text(row.summary),
        customer_safe: booleanValue(row.customer_safe),
        source: text(row.source_system),
        sync_state: text(row.sync_state),
        blocker: false,
      }
    : null;
}

function checkInProofItem(row: FrappeRow): ProofStreamItem | null {
  const id = text(row.checkin_id) ?? text(row.name);
  return id
    ? {
        id,
        type: "Field Check-in",
        proof_slot: null,
        occurred_at: text(row.submitted_at),
        summary: text(row.blocker_summary) ?? text(row.notes),
        customer_safe: false,
        source: text(row.source_system),
        sync_state: text(row.sync_state),
        blocker: booleanValue(row.blocker_flag) === true,
      }
    : null;
}

function compareProofItems(
  left: ProofStreamItem,
  right: ProofStreamItem,
): number {
  return (
    dateValue(right.occurred_at) - dateValue(left.occurred_at) ||
    right.id.localeCompare(left.id)
  );
}

function parseProofCursor(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d{1,6}$/.test(value)) return null;
  const offset = Number(value);
  return Number.isInteger(offset) && offset <= 100_000 ? offset : null;
}

function envelope(
  auth: AuthContext,
  rows: FrappeRow[],
  staleFields: string[],
  generatedAt: string = new Date().toISOString(),
): ReadModelEnvelope {
  return {
    version: 1,
    source_updated_at: newestModified(rows),
    read_model_generated_at: generatedAt,
    stale_fields: staleFields,
    permissions: auth.permissions,
    allowed_actions:
      auth.session.role === "field"
        ? ["job.read.assigned", "field.checkin.create", "field.evidence.create"]
        : [
            "job.read",
            "lead.read",
            "lead_triage.read",
            "field_blocker.read",
            "incident.read",
            "finance_exception.read",
            "material_exception.read",
          ],
  };
}

function exceptionRow(
  _row: FrappeRow,
  input: {
    id: string | null;
    kind: string;
    severity: string | null;
    title: string;
    why: string | null;
    jobId: string | null;
    occurredAt?: string | null;
    dueAt?: string | null;
    receivedAt?: string | null;
    busStatus?: string | null;
    triageStatus?: string | null;
    mctb?: MctbStatus | null;
  },
): OwnerNowReadModel["exceptions"] {
  return input.id
    ? [
        {
          id: input.id,
          kind: input.kind,
          severity: input.severity,
          title: input.title,
          why: input.why,
          next_action: null,
          job_id: input.jobId,
          occurred_at: input.occurredAt ?? null,
          due_at: input.dueAt ?? null,
          received_at: input.receivedAt ?? null,
          bus_status: input.busStatus ?? null,
          triage_status: input.triageStatus ?? null,
          mctb: input.mctb ?? null,
        },
      ]
    : [];
}

export function mctbStatus(
  receivedAt: string | null,
  receipts: readonly LeadAckReceipt[],
  now: Date = new Date(),
): MctbStatus {
  const receivedMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
  if (!Number.isFinite(receivedMs)) {
    return {
      state: "time_unavailable",
      deadline_at: null,
      observed_at: null,
      channel: null,
      proof_kind: null,
    };
  }
  const deadlineMs = receivedMs + MCTB_SLA_MS;
  const deadlineAt = new Date(deadlineMs).toISOString();
  const accepted = receipts.find(
    (receipt) => receipt.outcome === "provider_accepted",
  );
  if (accepted) {
    const observedMs = Date.parse(accepted.observed_at);
    if (Number.isFinite(observedMs)) {
      return {
        state:
          observedMs <= deadlineMs
            ? "provider_accepted_within_sla"
            : "provider_accepted_late",
        deadline_at: deadlineAt,
        observed_at: accepted.observed_at,
        channel: accepted.channel === "email" ? "email" : null,
        proof_kind: "provider_receipt",
      };
    }
  }
  const noChannel = receipts.find(
    (receipt) => receipt.outcome === "no_eligible_channel",
  );
  if (noChannel) {
    return {
      state: "no_eligible_channel",
      deadline_at: deadlineAt,
      observed_at: noChannel.observed_at,
      channel: null,
      proof_kind: null,
    };
  }
  return {
    state:
      now.getTime() <= deadlineMs ? "awaiting_proof" : "unproven_after_sla",
    deadline_at: deadlineAt,
    observed_at: null,
    channel: null,
    proof_kind: null,
  };
}

function mctbMissedSla(mctb: MctbStatus | null): boolean {
  return (
    mctb?.state === "provider_accepted_late" ||
    mctb?.state === "unproven_after_sla"
  );
}

function newestModified(rows: FrappeRow[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (
      typeof row.modified !== "string" ||
      Number.isNaN(Date.parse(row.modified))
    )
      continue;
    if (!newest || Date.parse(row.modified) > Date.parse(newest))
      newest = row.modified;
  }
  return newest;
}

function groupBy(rows: FrappeRow[], field: string): Map<string, FrappeRow[]> {
  const grouped = new Map<string, FrappeRow[]>();
  for (const row of rows) {
    const key = text(row[field]);
    if (!key) continue;
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }
  return grouped;
}

function mapRowsByReference(
  rows: FrappeRow[],
  field: string,
): Map<string, FrappeRow> {
  const mapped = new Map<string, FrappeRow>();
  for (const row of rows) {
    const key = text(row[field]);
    if (key) mapped.set(key, row);
  }
  return mapped;
}

function latestRowsByReference(
  rows: FrappeRow[],
  field: string,
  versionField?: string,
): Map<string, FrappeRow> {
  const latest = new Map<string, FrappeRow>();
  for (const row of rows) {
    const key = text(row[field]);
    if (!key) continue;
    const current = latest.get(key);
    if (!current || recordIsNewer(row, current, versionField))
      latest.set(key, row);
  }
  return latest;
}

function latestRecord(
  rows: FrappeRow[],
  versionField?: string,
): FrappeRow | null {
  let latest: FrappeRow | null = null;
  for (const row of rows)
    if (!latest || recordIsNewer(row, latest, versionField)) latest = row;
  return latest;
}

function newestFirst(rows: FrappeRow[]): FrappeRow[] {
  return [...rows].sort((left, right) => {
    if (recordIsNewer(left, right)) return -1;
    if (recordIsNewer(right, left)) return 1;
    return 0;
  });
}

function uniqueRows(rows: FrappeRow[]): FrappeRow[] {
  const unique = new Map<string, FrappeRow>();
  for (const row of rows) {
    const key = text(row.name);
    if (!key) continue;
    const current = unique.get(key);
    if (!current || recordIsNewer(row, current)) unique.set(key, row);
  }
  return [...unique.values()];
}

function recordIsNewer(
  candidate: FrappeRow,
  current: FrappeRow,
  versionField?: string,
): boolean {
  if (versionField) {
    const candidateVersion = optionalNumber(candidate[versionField]) ?? -1;
    const currentVersion = optionalNumber(current[versionField]) ?? -1;
    if (candidateVersion !== currentVersion)
      return candidateVersion > currentVersion;
  }
  const candidateModified = text(candidate.modified) ?? "";
  const currentModified = text(current.modified) ?? "";
  return (
    candidateModified.localeCompare(currentModified) > 0 ||
    (candidateModified === currentModified &&
      (text(candidate.name) ?? "").localeCompare(text(current.name) ?? "") > 0)
  );
}

function salesEstimateModel(
  row: FrappeRow | undefined,
): SalesReadModel["leads"][number]["estimate"] {
  const id = row ? (text(row.estimate_session_id) ?? text(row.name)) : null;
  if (!row || !id) return null;
  return {
    id,
    status: text(row.status),
    service_type: text(row.service_type),
    range_low: optionalNumber(row.range_low),
    range_high: optionalNumber(row.range_high),
    estimate_total: optionalNumber(row.estimate_total),
    confidence: text(row.confidence),
    review_required: booleanValue(row.review_required) === true,
    reviewed_at: text(row.reviewed_at),
    approved_at: text(row.approved_at),
    assumptions: text(row.assumptions),
    exclusions: text(row.exclusions),
  };
}

function salesQuoteModel(
  row: FrappeRow | undefined,
): SalesReadModel["leads"][number]["quote"] {
  const id = row ? (text(row.customer_quote_id) ?? text(row.name)) : null;
  if (!row || !id) return null;
  return {
    id,
    version: optionalNumber(row.quote_version),
    status: text(row.status),
    quote_total: optionalNumber(row.quote_total),
    currency: text(row.currency),
    valid_until: text(row.valid_until),
    payment_status: text(row.payment_status),
    prepared_at: text(row.prepared_at),
    approved_at: text(row.approved_at),
    accepted_at: text(row.accepted_at),
    scope_summary: text(row.scope_summary),
  };
}

function salesProposalModel(
  row: FrappeRow | undefined,
  publishedRow: FrappeRow | undefined,
  sourcePartial: boolean,
): SalesReadModel["leads"][number]["proposal"] {
  const id = row ? (text(row.pack_id) ?? text(row.name)) : null;
  if (!row || !id) return null;
  return {
    id,
    status: text(row.status),
    prepared_at: text(row.prepared_at),
    approved_at: text(row.approved_at),
    signed_at: text(row.signed_at),
    has_published_pack: sourcePartial ? null : Boolean(publishedRow),
    published_status: sourcePartial ? null : text(publishedRow?.status),
  };
}

function proposalStatusIsPublished(status: string | null): boolean {
  return status === "Approved" || status === "Sent" || status === "Signed";
}

function salesConsentRecord(
  row: FrappeRow,
): SalesReadModel["leads"][number]["consent"]["records"][number] | null {
  const id = text(row.consent_id) ?? text(row.name);
  if (!id) return null;
  return {
    id,
    channel: text(row.channel),
    purpose: text(row.purpose),
    status: text(row.status),
    jurisdiction: text(row.jurisdiction),
    basis: text(row.consent_basis),
    captured_at: text(row.captured_at),
    effective_from: text(row.effective_from),
    expires_at: text(row.expires_at),
    revoked_at: text(row.revoked_at),
  };
}

function salesAttention(
  lead: FrappeRow,
  estimate: SalesReadModel["leads"][number]["estimate"],
  quote: SalesReadModel["leads"][number]["quote"],
): SalesAttentionReason[] {
  const attention: SalesAttentionReason[] = [];
  const triage = text(lead.triage_status);
  if (triage !== "Triaged") attention.push("triage_unresolved");
  if (estimate?.status === "Captured" || estimate?.status === "Needs Review")
    attention.push("estimate_needs_review");
  if (quote?.status === "Needs Review") attention.push("quote_needs_review");
  if (quote?.status === "Expired") attention.push("quote_expired");
  return attention;
}

function compareSalesLead(
  left: SalesReadModel["leads"][number],
  right: SalesReadModel["leads"][number],
): number {
  const rank = (lead: SalesReadModel["leads"][number]) => {
    if (lead.attention.includes("triage_unresolved")) return 0;
    if (lead.attention.includes("estimate_needs_review")) return 1;
    if (lead.attention.includes("quote_needs_review")) return 2;
    if (lead.attention.includes("quote_expired")) return 3;
    return 4;
  };
  return (
    rank(left) - rank(right) ||
    dateValue(right.received_at) - dateValue(left.received_at) ||
    left.id.localeCompare(right.id)
  );
}

function estimatorMeasurementSummary(
  row: FrappeRow,
): EstimatorWorkbenchReadModel["measurements"]["reports"] {
  const id = text(row.measurement_id) ?? text(row.name);
  return id
    ? [
        {
          id,
          provider: text(row.provider),
          review_status: text(row.review_status),
          parsed_at: text(row.parsed_at),
          approved_at: text(row.approved_at),
        },
      ]
    : [];
}

async function safeEstimatorDetailRead(
  env: AppEnv,
  doctype:
    | "Measurement Report"
    | "Visual Property Model"
    | "Material Takeoff"
    | "Insurance Supplement",
  name: string,
): Promise<{ row: FrappeRow | null; unavailable_reason: string | null }> {
  try {
    return {
      row: await readOfficeEstimatorFrappeResource(env, doctype, name),
      unavailable_reason: null,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "frappe_read_response_too_large"
    ) {
      return {
        row: null,
        unavailable_reason:
          doctype === "Measurement Report"
            ? "measurement_detail_too_large"
            : doctype === "Visual Property Model"
              ? "visual_model_detail_too_large"
              : doctype === "Material Takeoff"
                ? "takeoff_detail_too_large"
                : "insurance_supplement_detail_too_large",
      };
    }
    throw error;
  }
}

function matchesMeasurementDetail(
  row: FrappeRow | null,
  expectedName: string | null,
  jobName: string,
): boolean {
  return Boolean(
    row &&
    expectedName &&
    text(row.name) === expectedName &&
    text(row.roof_job) === jobName,
  );
}

function matchesVisualModelDetail(
  row: FrappeRow | null,
  expectedName: string | null,
  jobName: string,
): boolean {
  return Boolean(
    row &&
    expectedName &&
    text(row.name) === expectedName &&
    text(row.roof_job) === jobName,
  );
}

function matchesTakeoffDetail(
  row: FrappeRow | null,
  expectedName: string | null,
  jobName: string,
  measurementName: string | null,
): boolean {
  return Boolean(
    row &&
    expectedName &&
    measurementName &&
    text(row.name) === expectedName &&
    text(row.roof_job) === jobName &&
    text(row.measurement_report) === measurementName,
  );
}

function matchesInsuranceSupplementDetail(
  row: FrappeRow | null,
  expectedName: string | null,
  jobName: string,
): boolean {
  return Boolean(
    row &&
    expectedName &&
    text(row.name) === expectedName &&
    text(row.roof_job) === jobName,
  );
}

function measurementToTakeoffLineage(
  measurement: FrappeRow | null,
  takeoff: FrappeRow | null,
  takeoffs: FrappeRow[],
): EstimatorWorkbenchReadModel["lineage"]["measurement_to_takeoff"] {
  if (!measurement) return "no_measurement";
  if (takeoff) return "linked";
  if (takeoffs.length === ESTIMATOR_SOURCE_LIMIT) return "unknown";
  return takeoffs.length > 0 ? "mismatch" : "no_takeoff";
}

function quoteToProposalLineage(
  quote: FrappeRow | null,
  proposal: FrappeRow | null,
  proposals: FrappeRow[],
): EstimatorWorkbenchReadModel["lineage"]["quote_to_proposal"] {
  if (!quote) return "no_quote";
  if (proposal) return "linked";
  if (proposals.length === ESTIMATOR_SOURCE_LIMIT) return "unknown";
  return proposals.length > 0 ? "mismatch" : "no_proposal";
}

function estimatorVisualModel(
  env: AppEnv,
  row: FrappeRow | null,
  detail: FrappeRow | null,
  roofAreas: FrappeRow[],
  selectedMeasurement: FrappeRow | null,
): EstimatorWorkbenchReadModel["visual_model"] {
  if (!row || !detail) return row ? unavailableVisualModel() : null;
  const modelName = text(row.name);
  const provider = visualText(detail.provider, 160);
  const status = visualText(detail.status, 80);
  const needsReview = booleanValue(detail.needs_review);
  const confidence = visualConfidence(detail.confidence);
  if (
    !modelName ||
    !provider ||
    !status ||
    needsReview === null ||
    confidence === undefined
  ) {
    return unavailableVisualModel();
  }

  const capturedAt = visualTimestamp(detail.captured_at);
  const approvedAt = visualTimestamp(detail.approved_at);
  const approvalRecorded =
    status === "Approved" && needsReview === false && approvedAt !== null;
  const modelState =
    status === "Draft"
      ? "draft"
      : status === "Needs Review"
        ? "needs_review"
        : status === "Approved"
          ? approvalRecorded
            ? "approved"
            : "needs_review"
          : status === "Rejected"
            ? "rejected"
            : "unavailable";
  if (modelState === "unavailable") return unavailableVisualModel();

  return {
    provider,
    model_state: modelState,
    confidence,
    review_required: needsReview || modelState === "needs_review",
    approval_recorded: approvalRecorded,
    captured_at: capturedAt,
    approved_at: approvedAt,
    measurement_link: visualMeasurementLink(
      modelName,
      roofAreas,
      selectedMeasurement,
    ),
    preview: visualPreview(
      detail.screenshots_json,
      env.APP_VISUAL_PREVIEW_ALLOWED_ORIGINS,
    ),
  };
}

function unavailableVisualModel(): NonNullable<
  EstimatorWorkbenchReadModel["visual_model"]
> {
  return {
    provider: null,
    model_state: "unavailable",
    confidence: null,
    review_required: true,
    approval_recorded: false,
    captured_at: null,
    approved_at: null,
    measurement_link: "unavailable",
    preview: { state: "unavailable", url: null },
  };
}

function visualMeasurementLink(
  visualModelName: string,
  roofAreas: FrappeRow[],
  selectedMeasurement: FrappeRow | null,
): NonNullable<
  EstimatorWorkbenchReadModel["visual_model"]
>["measurement_link"] {
  const areasForModel = roofAreas.filter(
    (area) => text(area.visual_model) === visualModelName,
  );
  if (areasForModel.length === 0) {
    return roofAreas.length === ESTIMATOR_SOURCE_LIMIT
      ? "unavailable"
      : "unlinked";
  }
  const linkedMeasurements = areasForModel
    .map((area) => text(area.measurement_report))
    .filter(notNull);
  if (linkedMeasurements.length === 0) return "unlinked";
  const selectedNames = selectedMeasurement
    ? [
        text(selectedMeasurement.name),
        text(selectedMeasurement.measurement_id),
      ].filter(notNull)
    : [];
  return selectedNames.some((name) => linkedMeasurements.includes(name))
    ? "selected_measurement"
    : "other_measurement";
}

function visualPreview(
  screenshots: unknown,
  configuredOrigins: string | undefined,
): NonNullable<EstimatorWorkbenchReadModel["visual_model"]>["preview"] {
  if (
    screenshots === null ||
    screenshots === undefined ||
    (typeof screenshots === "string" && !screenshots.trim())
  ) {
    return { state: "not_recorded", url: null };
  }
  if (typeof screenshots !== "string") return { state: "invalid", url: null };
  const raw = screenshots.trim();
  if (raw.length > MAX_VISUAL_SCREENSHOT_JSON_LENGTH)
    return { state: "invalid", url: null };

  let candidates: unknown;
  try {
    candidates = JSON.parse(raw);
  } catch {
    return { state: "invalid", url: null };
  }
  if (
    !Array.isArray(candidates) ||
    candidates.some((candidate) => typeof candidate !== "string")
  ) {
    return { state: "invalid", url: null };
  }
  if (candidates.length === 0) return { state: "not_recorded", url: null };

  const allowedOrigins = visualPreviewAllowedOrigins(configuredOrigins);
  if (allowedOrigins.size === 0) return { state: "not_configured", url: null };

  let blocked = false;
  let invalid = false;
  for (const candidate of candidates.slice(
    0,
    MAX_VISUAL_SCREENSHOT_CANDIDATES,
  )) {
    if (candidate.length > MAX_VISUAL_PREVIEW_URL_LENGTH) {
      invalid = true;
      continue;
    }
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || url.username || url.password) {
        invalid = true;
        continue;
      }
      if (allowedOrigins.has(url.origin))
        return { state: "available", url: url.href };
      blocked = true;
    } catch {
      invalid = true;
    }
  }
  return {
    state: blocked ? "blocked" : invalid ? "invalid" : "unavailable",
    url: null,
  };
}

function visualPreviewAllowedOrigins(value: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const candidate of (value ?? "").split(",").slice(0, 32)) {
    const origin = candidate.trim();
    if (!origin || origin.length > 512) continue;
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        continue;
      origins.add(url.origin);
    } catch {
      // A malformed configuration entry cannot widen the browser preview boundary.
    }
  }
  return origins;
}

function visualText(value: unknown, maximum: number): string | null {
  const result = text(value);
  return result && result.length <= maximum ? result : null;
}

function visualTimestamp(value: unknown): string | null {
  const result = visualText(value, 80);
  return result && Number.isFinite(Date.parse(result)) ? result : null;
}

function visualConfidence(value: unknown): number | null | undefined {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  const result = optionalNumber(value);
  return result !== null && result >= 0 && result <= 100 ? result : undefined;
}

// ---- computed takeoff + estimate: non-operational estimator preview ----
//
// Both are pure recomputations over the verified geometry the workbench already
// loads: no Frappe writes, no stored state, bounded like every other estimator
// projection. They intentionally use legacy preview defaults and are never
// policy-bound or approval-eligible. The governed Material Takeoff MCP/Frappe
// rail is the only operational calculation path. Pricing activates only when
// the tenant configures ESTIMATOR_PRICE_LIST_JSON; rates never live in code.

const LEGACY_PREVIEW_CALCULATION_SCHEMA = "legacy_preview/v1" as const;
const NON_OPERATIONAL_PREVIEW_AUTHORITY = "non_operational_preview" as const;

export interface EstimatorComputedTakeoffProjection {
  state: "computed" | "unavailable";
  authority: typeof NON_OPERATIONAL_PREVIEW_AUTHORITY;
  calculation_schema: typeof LEGACY_PREVIEW_CALCULATION_SCHEMA;
  policy_bound: false;
  approval_eligible: false;
  reason: string | null;
  needs_review: boolean | null;
  panel_count: number | null;
  panel_ft: number | null;
  panel_area_sqft: number | null;
  roof_area_computed_sqft: number | null;
  overage: number | null;
  skipped_facets: number | null;
  nest: { mode: string; stock_ft: number; cut_ft: number; waste_pct: number; reused_cuts: number } | null;
  trims: Array<{ profile: string; total_ft: number; sticks: number }>;
  trims_truncated: boolean;
  fasteners: { clips: number; clip_screws: number; trim_screws: number } | null;
  failed_check_count: number | null;
}

export interface EstimatorComputedEstimateProjection {
  state: "priced" | "unconfigured" | "invalid_price_list" | "unavailable";
  authority: typeof NON_OPERATIONAL_PREVIEW_AUTHORITY;
  calculation_schema: typeof LEGACY_PREVIEW_CALCULATION_SCHEMA;
  policy_bound: false;
  approval_eligible: false;
  mode: "approved_policy" | "read_only_legacy" | null;
  policy_id: string | null;
  policy_revision: number | null;
  policy_snapshot_sha256: string | null;
  currency: string | null;
  lines: Array<{ kind: string; sku: string; description: string; qty: number; unit: string; rate: number; amount: number }>;
  lines_truncated: boolean;
  subtotal: number | null;
  markup: number | null;
  tax: number | null;
  total: number | null;
  unpriced_profiles: string[];
  needs_review: boolean | null;
}

function unavailableComputedTakeoff(reason: string): EstimatorComputedTakeoffProjection {
  return {
    state: "unavailable",
    authority: NON_OPERATIONAL_PREVIEW_AUTHORITY,
    calculation_schema: LEGACY_PREVIEW_CALCULATION_SCHEMA,
    policy_bound: false,
    approval_eligible: false,
    reason, needs_review: null, panel_count: null, panel_ft: null,
    panel_area_sqft: null, roof_area_computed_sqft: null, overage: null, skipped_facets: null,
    nest: null, trims: [], trims_truncated: false, fasteners: null, failed_check_count: null,
  };
}

function estimatorComputedTakeoff(
  model: GeometryModel | null,
): { projection: EstimatorComputedTakeoffProjection; takeoff: TakeoffModel | null } {
  if (!model) return { projection: unavailableComputedTakeoff("geometry_unavailable"), takeoff: null };
  try {
    const takeoff = takeoffFromGeometry(model);
    return {
      takeoff,
      projection: {
        state: "computed",
        authority: NON_OPERATIONAL_PREVIEW_AUTHORITY,
        calculation_schema: LEGACY_PREVIEW_CALCULATION_SCHEMA,
        policy_bound: false,
        approval_eligible: false,
        reason: null,
        needs_review: takeoff.needsReview,
        panel_count: takeoff.totals.panelCount,
        panel_ft: takeoff.totals.panelFt,
        panel_area_sqft: takeoff.totals.panelAreaSqft,
        roof_area_computed_sqft: takeoff.totals.roofAreaComputedSqft,
        overage: takeoff.totals.overage,
        skipped_facets: takeoff.totals.skippedFacets,
        nest: {
          mode: takeoff.panelNest.mode,
          stock_ft: takeoff.panelNest.stockFt,
          cut_ft: takeoff.panelNest.cutFt,
          waste_pct: takeoff.panelNest.wastePct,
          reused_cuts: takeoff.panelNest.reusedCuts,
        },
        trims: takeoff.trims.slice(0, MAX_ESTIMATOR_COMPUTED_TRIMS).map((trim) => ({
          profile: boundedGeometryText(trim.profile, MAX_ESTIMATOR_GEOMETRY_LABEL),
          total_ft: trim.totalFt,
          sticks: trim.sticks,
        })),
        trims_truncated: takeoff.trims.length > MAX_ESTIMATOR_COMPUTED_TRIMS,
        fasteners: {
          clips: takeoff.fasteners.clips,
          clip_screws: takeoff.fasteners.clipScrews,
          trim_screws: takeoff.fasteners.trimScrews,
        },
        failed_check_count: takeoff.checks.filter((check) => !check.ok).length,
      },
    };
  } catch {
    return { projection: unavailableComputedTakeoff("takeoff_failed"), takeoff: null };
  }
}

type EstimatorPriceList = {
  state: "unconfigured" | "invalid" | "ok";
  list?: PriceList;
  identity?: { tenantId: string; policyId: string; policyRevision: number };
};

function estimatorPriceList(env: AppEnv, pricedAt: string): EstimatorPriceList {
  const raw = (env as { ESTIMATOR_PRICE_LIST_JSON?: string }).ESTIMATOR_PRICE_LIST_JSON;
  if (!raw || !raw.trim()) return { state: "unconfigured" };
  try {
    const parsed: unknown = JSON.parse(raw);
    // JSON shape belongs here; all commercial semantics live in priceTakeoff's
    // single closed validator so approved cents and legacy read-only inputs
    // cannot drift between the runtime path and the pricing module.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid" };
    }
    const list = parsed as PriceList;
    if (list.approvedPolicy === undefined) return { state: "ok", list };
    return {
      state: "ok",
      list,
      identity: approvedPricingPolicyIdentity(list, pricedAt),
    };
  } catch {
    return { state: "invalid" };
  }
}

function emptyComputedEstimate(
  state: EstimatorComputedEstimateProjection["state"],
): EstimatorComputedEstimateProjection {
  return {
    state,
    authority: NON_OPERATIONAL_PREVIEW_AUTHORITY,
    calculation_schema: LEGACY_PREVIEW_CALCULATION_SCHEMA,
    policy_bound: false,
    approval_eligible: false,
    mode: null, policy_id: null, policy_revision: null,
    policy_snapshot_sha256: null, currency: null, lines: [], lines_truncated: false,
    subtotal: null, markup: null, tax: null, total: null,
    unpriced_profiles: [], needs_review: null,
  };
}

function estimatorComputedEstimate(
  priceList: EstimatorPriceList,
  takeoff: TakeoffModel | null,
  pricedAt: string,
  authority?: VerifiedPricingAuthority,
): EstimatorComputedEstimateProjection {
  if (!takeoff) return emptyComputedEstimate("unavailable");
  if (priceList.state === "unconfigured") return emptyComputedEstimate("unconfigured");
  if (priceList.state === "invalid") return emptyComputedEstimate("invalid_price_list");
  try {
    const estimate = priceTakeoff(takeoff, priceList.list!, { pricedAt, authority });
    return {
      state: "priced",
      authority: NON_OPERATIONAL_PREVIEW_AUTHORITY,
      calculation_schema: LEGACY_PREVIEW_CALCULATION_SCHEMA,
      policy_bound: false,
      approval_eligible: false,
      mode: estimate.commercial.mode,
      policy_id: estimate.commercial.policyId,
      policy_revision: estimate.commercial.policyRevision,
      policy_snapshot_sha256: estimate.commercial.policySnapshotSha256,
      currency: estimate.currency,
      lines: estimate.lines.slice(0, MAX_ESTIMATOR_ESTIMATE_LINES).map((line) => ({
        kind: line.kind,
        sku: boundedGeometryText(line.sku, MAX_ESTIMATOR_GEOMETRY_LABEL),
        description: boundedGeometryText(line.description, MAX_ESTIMATOR_GEOMETRY_LABEL),
        qty: line.qty,
        unit: line.unit,
        rate: line.rate,
        amount: line.amount,
      })),
      lines_truncated: estimate.lines.length > MAX_ESTIMATOR_ESTIMATE_LINES,
      subtotal: estimate.subtotal,
      markup: estimate.markup,
      tax: estimate.tax,
      total: estimate.total,
      unpriced_profiles: estimate.unpricedProfiles.map((profile) =>
        boundedGeometryText(profile, MAX_ESTIMATOR_GEOMETRY_LABEL),
      ),
      needs_review: estimate.needsReview,
    };
  } catch {
    return emptyComputedEstimate("invalid_price_list");
  }
}

function estimatorMeasurementSelection(
  row: FrappeRow | null,
  detail: FrappeRow | null,
  geometry: EstimatorGeometryProjection,
  roofGraph: EstimatorRoofGraphProjection | null,
  computedTakeoff: EstimatorComputedTakeoffProjection,
  computedEstimate: EstimatorComputedEstimateProjection,
): EstimatorWorkbenchReadModel["measurements"]["selected"] {
  if (!row) return null;
  const [summary] = estimatorMeasurementSummary(row);
  if (!summary) return null;
  const metricRows = detail ? recordRows(detail.measurements) : [];
  return {
    ...summary,
    metrics: metricRows.slice(0, MAX_ESTIMATOR_METRICS).flatMap((metric) => {
      const name = text(metric.metric);
      return name
        ? [
            {
              metric: name,
              value: optionalNumber(metric.value),
              unit: text(metric.unit),
              confidence: text(metric.confidence),
              source_ref: text(metric.source_ref),
              needs_review: booleanValue(metric.needs_review) === true,
            },
          ]
        : [];
    }),
    metrics_truncated:
      metricRows.length > MAX_ESTIMATOR_METRICS ||
      booleanValue(detail?.__ironwrap_truncated_measurements) === true,
    geometry,
    roof_graph: roofGraph,
    computed_takeoff: computedTakeoff,
    computed_estimate: computedEstimate,
  };
}

function estimatorTakeoffSummary(
  row: FrappeRow,
): EstimatorWorkbenchReadModel["takeoffs"]["records"] {
  const id = text(row.takeoff_id) ?? text(row.name);
  return id
    ? [
        {
          id,
          measurement_report_id: text(row.measurement_report),
          status: text(row.status),
          prepared_at: text(row.prepared_at),
          approved_at: text(row.approved_at),
        },
      ]
    : [];
}

function estimatorTakeoffSelection(
  row: FrappeRow | null,
  detail: FrappeRow | null,
): EstimatorWorkbenchReadModel["takeoffs"]["selected"] {
  if (!row) return null;
  const [summary] = estimatorTakeoffSummary(row);
  if (!summary) return null;
  const itemRows = detail ? recordRows(detail.items) : [];
  return {
    ...summary,
    assumptions: detail ? text(detail.assumptions) : null,
    exclusions: detail ? text(detail.exclusions) : null,
    items: itemRows.slice(0, MAX_ESTIMATOR_TAKEOFF_ITEMS).map((item) => ({
      category: text(item.category),
      item_name: text(item.item_name),
      quantity: optionalNumber(item.quantity),
      unit: text(item.unit),
      waste_factor: optionalNumber(item.waste_factor),
      source_ref: text(item.source_ref),
      confidence: text(item.confidence),
      needs_review: booleanValue(item.needs_review) === true,
    })),
    items_truncated:
      itemRows.length > MAX_ESTIMATOR_TAKEOFF_ITEMS ||
      booleanValue(detail?.__ironwrap_truncated_items) === true,
  };
}

function estimatorQuote(
  row: FrappeRow | null,
): EstimatorQuoteProjection | null {
  const id = row ? (text(row.customer_quote_id) ?? text(row.name)) : null;
  if (!row || !id) return null;
  return {
    id,
    version: optionalNumber(row.quote_version),
    status: text(row.status),
    price_book_version: text(row.price_book_version),
    pricing_effective_at: text(row.pricing_effective_at),
    subtotal: optionalNumber(row.subtotal),
    tax_amount: optionalNumber(row.tax_amount),
    tax_code: text(row.tax_code),
    tax_rate: optionalNumber(row.tax_rate),
    quote_total: optionalNumber(row.quote_total),
    currency: text(row.currency),
    deposit_amount: optionalNumber(row.deposit_amount),
    amount_due: optionalNumber(row.amount_due),
    amount_paid: optionalNumber(row.amount_paid),
    balance_due: optionalNumber(row.balance_due),
    payment_status: text(row.payment_status),
    payment_due_date: text(row.payment_due_date),
    valid_until: text(row.valid_until),
    prepared_at: text(row.prepared_at),
    approved_at: text(row.approved_at),
    accepted_at: text(row.accepted_at),
    scope_summary: text(row.scope_summary),
    assumptions: text(row.assumptions),
    exclusions: text(row.exclusions),
    supersedes: text(row.supersedes),
    correction_reason: text(row.correction_reason),
  };
}

function estimatorPricingSnapshot(
  quote: EstimatorQuoteProjection | null,
): EstimatorWorkbenchReadModel["pricing_snapshot"] {
  if (!quote) {
    return {
      state: "unavailable",
      quote_id: null,
      quote_version: null,
      price_book_version: null,
      pricing_effective_at: null,
      valid_until: null,
    };
  }
  const complete = Boolean(
    quote.price_book_version && quote.pricing_effective_at,
  );
  const status = quote.status;
  return {
    state: !complete
      ? "incomplete"
      : status === "Expired"
        ? "expired"
        : status === "Approved" || status === "Accepted"
          ? "recorded"
          : "review_required",
    quote_id: quote.id,
    quote_version: quote.version,
    price_book_version: quote.price_book_version,
    pricing_effective_at: quote.pricing_effective_at,
    valid_until: quote.valid_until,
  };
}

function estimatorQuoteRevision(
  current: FrappeRow | null,
  quotes: FrappeRow[],
): EstimatorWorkbenchReadModel["quote_revision"] {
  if (!current) return { state: "no_quote", prior_quote: null, delta: null };
  const supersedes = text(current.supersedes);
  const currentVersion = optionalNumber(current.quote_version);
  if (!supersedes) {
    return {
      state:
        currentVersion !== null && currentVersion > 1
          ? "unlinked_revision"
          : "not_revised",
      prior_quote: null,
      delta: null,
    };
  }
  const prior = quotes.find((row) => text(row.name) === supersedes) ?? null;
  if (!prior) {
    return {
      state:
        quotes.length === ESTIMATOR_SOURCE_LIMIT
          ? "history_incomplete"
          : "prior_quote_missing",
      prior_quote: null,
      delta: null,
    };
  }
  const priorVersion = optionalNumber(prior.quote_version);
  if (
    currentVersion !== null &&
    priorVersion !== null &&
    priorVersion >= currentVersion
  ) {
    return {
      state: "invalid_lineage",
      prior_quote: estimatorQuote(prior),
      delta: null,
    };
  }
  return {
    state: "compared",
    prior_quote: estimatorQuote(prior),
    delta: estimatorQuoteRevisionDelta(current, prior),
  };
}

function estimatorQuoteRevisionDelta(
  current: FrappeRow,
  prior: FrappeRow,
): EstimatorQuoteRevisionDelta {
  return {
    subtotal: numberDelta(current.subtotal, prior.subtotal),
    tax_amount: numberDelta(current.tax_amount, prior.tax_amount),
    quote_total: numberDelta(current.quote_total, prior.quote_total),
    deposit_amount: numberDelta(current.deposit_amount, prior.deposit_amount),
    amount_due: numberDelta(current.amount_due, prior.amount_due),
    balance_due: numberDelta(current.balance_due, prior.balance_due),
    price_book_version_changed: valueChanged(
      current.price_book_version,
      prior.price_book_version,
    ),
    pricing_effective_at_changed: valueChanged(
      current.pricing_effective_at,
      prior.pricing_effective_at,
    ),
    tax_code_changed: valueChanged(current.tax_code, prior.tax_code),
    tax_rate_changed: valueChanged(current.tax_rate, prior.tax_rate),
    currency_changed: valueChanged(current.currency, prior.currency),
    scope_summary_changed: valueChanged(
      current.scope_summary,
      prior.scope_summary,
    ),
    assumptions_changed: valueChanged(current.assumptions, prior.assumptions),
    exclusions_changed: valueChanged(current.exclusions, prior.exclusions),
  };
}

function estimatorScopeChange(
  row: FrappeRow,
  selectedQuoteName: string | null,
  quoteRows: FrappeRow[],
): EstimatorWorkbenchReadModel["scope_changes"] {
  const id = text(row.change_order_id) ?? text(row.name);
  if (!id) return [];
  const quoteName = text(row.customer_quote);
  const quoteLink = !quoteName
    ? "no_quote"
    : quoteName === selectedQuoteName
      ? "selected_quote"
      : quoteRows.some((quote) => text(quote.name) === quoteName)
        ? "other_quote"
        : "quote_unavailable";
  return [
    {
      id,
      number: text(row.change_number),
      version: optionalNumber(row.version),
      status: text(row.status),
      title: text(row.title),
      reason: text(row.reason),
      scope_delta: text(row.scope_delta),
      quote_link: quoteLink,
      currency: text(row.currency),
      subtotal: optionalNumber(row.subtotal),
      tax_amount: optionalNumber(row.tax_amount),
      total_amount: optionalNumber(row.total_amount),
      price_book_version: text(row.price_book_version),
      requested_at: text(row.requested_at),
      approved_at: text(row.approved_at),
      accepted_at: text(row.accepted_at),
      correction_reason: text(row.correction_reason),
    },
  ];
}

function estimatorInsuranceSupplement(
  presentationKey: string,
  row: FrappeRow,
  detail: FrappeRow | null,
  measurementRows: FrappeRow[],
): EstimatorWorkbenchReadModel["insurance_supplements"] {
  const measurementName = text(row.measurement_report);
  const measurement = measurementName
    ? measurementRows.find(
        (candidate) =>
          text(candidate.name) === measurementName ||
          text(candidate.measurement_id) === measurementName,
      )
    : null;
  const measurementState: EstimatorWorkbenchReadModel["insurance_supplements"][number]["measurement_state"] =
    !measurementName
      ? "missing"
      : !measurement
        ? "unavailable"
        : text(measurement.review_status) === "Approved"
          ? "approved"
          : "review_required";
  const missing: EstimatorWorkbenchReadModel["insurance_supplements"][number]["missing_requirements"] =
    [];
  if (!detail) {
    missing.push("source_detail_unavailable");
    return [
      {
        presentation_key: presentationKey,
        version: optionalNumber(row.version),
        status: text(row.status),
        measurement_state: measurementState,
        evidence_roles: [],
        missing_requirements: missing,
        invoice_state: "unavailable",
        approval_recorded: Boolean(text(row.approved_at)),
        submission_recorded: Boolean(text(row.submitted_at)),
        carrier_response_recorded: Boolean(text(row.carrier_response_at)),
        closed_recorded: Boolean(text(row.closed_at)),
      },
    ];
  }

  const roleOrder = [
    "Carrier Scope",
    "Code/Manufacturer",
    "Photo",
    "Invoice",
    "Submission",
    "Carrier Response",
  ] as const;
  const availableRoles = new Set(
    recordRows(detail.evidence)
      .map((evidence) => text(evidence.evidence_role))
      .filter(
        (role): role is (typeof roleOrder)[number] =>
          role !== null &&
          roleOrder.includes(role as (typeof roleOrder)[number]),
      ),
  );
  const evidenceRoles = roleOrder.filter((role) => availableRoles.has(role));
  if (measurementState !== "approved") missing.push("approved_measurement");
  if (!availableRoles.has("Carrier Scope")) missing.push("carrier_scope");
  if (!availableRoles.has("Code/Manufacturer"))
    missing.push("code_or_manufacturer");
  if (!availableRoles.has("Photo")) missing.push("photo");
  const invoiceRequired = booleanValue(row.invoice_required) !== false;
  if (invoiceRequired && !availableRoles.has("Invoice")) {
    missing.push("invoice_or_exception");
  }
  const status = text(row.status);
  if (
    ["Submitted", "Carrier Response Recorded", "Closed"].includes(
      status ?? "",
    ) &&
    !availableRoles.has("Submission")
  ) {
    missing.push("submission_artifact");
  }
  if (
    status === "Carrier Response Recorded" &&
    !availableRoles.has("Carrier Response")
  ) {
    missing.push("carrier_response_artifact");
  }
  return [
    {
      presentation_key: presentationKey,
      version: optionalNumber(row.version),
      status,
      measurement_state: measurementState,
      evidence_roles: evidenceRoles,
      missing_requirements: missing,
      invoice_state: availableRoles.has("Invoice")
        ? "recorded"
        : invoiceRequired
          ? "required"
          : "not_required",
      approval_recorded: Boolean(text(row.approved_at)),
      submission_recorded: Boolean(text(row.submitted_at)),
      carrier_response_recorded: Boolean(text(row.carrier_response_at)),
      closed_recorded: Boolean(text(row.closed_at)),
    },
  ];
}

function estimatorProposalReadiness({
  geometry,
  measurement,
  takeoff,
  takeoffDetail,
  takeoffLineage,
  quote,
  pricingSnapshot,
  proposalLineage,
  scopeChanges,
  partialSources,
  staleFields,
}: {
  geometry: EstimatorGeometryProjection;
  measurement: FrappeRow | null;
  takeoff: FrappeRow | null;
  takeoffDetail: FrappeRow | null;
  takeoffLineage: EstimatorWorkbenchReadModel["lineage"]["measurement_to_takeoff"];
  quote: EstimatorQuoteProjection | null;
  pricingSnapshot: EstimatorWorkbenchReadModel["pricing_snapshot"];
  proposalLineage: EstimatorWorkbenchReadModel["lineage"]["quote_to_proposal"];
  scopeChanges: EstimatorWorkbenchReadModel["scope_changes"];
  partialSources: string[];
  staleFields: string[];
}): EstimatorWorkbenchReadModel["proposal_readiness"] {
  const reasons: EstimatorWorkbenchReadModel["proposal_readiness"]["reasons"] =
    [];
  if (!measurement) reasons.push("measurement_missing");
  else if (geometry.state !== "recomputed")
    reasons.push("measurement_source_review_required");
  if (takeoffLineage !== "linked" || !takeoff || !takeoffDetail)
    reasons.push("takeoff_link_missing");
  else if (text(takeoff.status) !== "Approved")
    reasons.push("takeoff_not_approved");
  if (!quote) reasons.push("quote_missing");
  else {
    if (
      pricingSnapshot.state === "incomplete" ||
      pricingSnapshot.state === "unavailable"
    ) {
      reasons.push("quote_snapshot_incomplete");
    }
    if (quote.status !== "Approved" && quote.status !== "Accepted")
      reasons.push("quote_not_approved");
  }
  if (proposalLineage === "mismatch") reasons.push("proposal_link_mismatch");
  if (
    scopeChanges.some(
      (change) =>
        change.quote_link === "selected_quote" &&
        ["Draft", "Needs Review", "Approved", "Presented"].includes(
          change.status ?? "",
        ),
    )
  ) {
    reasons.push("scope_change_unresolved");
  }
  if (partialSources.length > 0) reasons.push("source_window_partial");
  if (staleFields.length > 0) reasons.push("stale_source_detail");
  const unavailable =
    reasons.includes("source_window_partial") ||
    reasons.includes("stale_source_detail");
  const blocked = reasons.some((reason) =>
    [
      "measurement_missing",
      "takeoff_link_missing",
      "quote_missing",
      "scope_change_unresolved",
      "proposal_link_mismatch",
    ].includes(reason),
  );
  return {
    state: unavailable
      ? "unavailable"
      : blocked
        ? "blocked"
        : reasons.length > 0
          ? "review_required"
          : "ready",
    reasons,
  };
}

function estimatorProposal(
  row: FrappeRow | null,
): EstimatorWorkbenchReadModel["proposal"] {
  const id = row ? (text(row.pack_id) ?? text(row.name)) : null;
  if (!row || !id) return null;
  return {
    id,
    quote_id: text(row.quotation),
    status: text(row.status),
    prepared_at: text(row.prepared_at),
    approved_at: text(row.approved_at),
    signed_at: text(row.signed_at),
    assumptions: text(row.assumptions),
    exclusions: text(row.exclusions),
  };
}

function estimatorScopeClause(
  row: FrappeRow,
): EstimatorWorkbenchReadModel["scope_clauses"] {
  const id = text(row.scope_clause_id) ?? text(row.name);
  return id
    ? [
        {
          id,
          type: text(row.clause_type),
          title: text(row.title),
          text: text(row.clause_text),
          version: text(row.version),
          status: text(row.status),
          source_ref: text(row.source_ref),
          customer_visible: booleanValue(row.customer_visible) === true,
          approved_at: text(row.approved_at),
        },
      ]
    : [];
}

/**
 * Project a persisted canonical graph into a deliberately smaller browser contract. The graph's
 * raw key and SHA-256 revision stay in Frappe/R2; the UI only gets safe geometry and review facts.
 */
function estimatorRoofGraphProjection(
  detail: FrappeRow | null,
): EstimatorRoofGraphProjection | null {
  const serialized = detail?.roof_graph_json;
  if (serialized === null || serialized === undefined || serialized === "")
    return null;
  if (
    typeof serialized !== "string" ||
    serialized.length > MAX_ESTIMATOR_ROOF_GRAPH_JSON_LENGTH
  ) {
    return unavailableEstimatorRoofGraph();
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    return unavailableEstimatorRoofGraph();
  }
  const graph = roofGraphObject(candidate);
  if (!graph || graph.schema_version !== "roof_graph/v1")
    return unavailableEstimatorRoofGraph();

  const rawRevision = roofGraphIdentifier(graph.revision);
  const persistedRevision = roofGraphIdentifier(detail?.roof_graph_revision);
  const source = roofGraphObject(graph.source);
  const coordinateSystem = roofGraphObject(graph.coordinate_system);
  if (
    !rawRevision ||
    !roofGraphSha256(rawRevision) ||
    !persistedRevision ||
    rawRevision !== persistedRevision ||
    !source ||
    !coordinateSystem ||
    typeof graph.needs_review !== "boolean" ||
    !Array.isArray(graph.points) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.facets) ||
    !Array.isArray(graph.checks) ||
    !roofGraphObject(graph.measurements) ||
    !roofGraphObject(graph.source_refs)
  ) {
    return unavailableEstimatorRoofGraph();
  }

  const rawKey = roofGraphIdentifier(source.raw_key);
  const rawSha256 = roofGraphIdentifier(source.raw_sha256);
  const provider = roofGraphIdentifier(source.provider);
  const capture = roofGraphObject(source.capture);
  const sourceProvenance = capture
    ? roofGraphIdentifier(capture.provenance)
    : null;
  if (
    !rawKey ||
    !rawSha256 ||
    !roofGraphSha256(rawSha256) ||
    rawSha256 !== rawRevision ||
    !provider ||
    !capture ||
    !sourceProvenance ||
    !roofGraphIdentifier(source.ingested_at) ||
    !roofGraphIdentifier(coordinateSystem.kind) ||
    !roofGraphIdentifier(coordinateSystem.provenance)
  ) {
    return unavailableEstimatorRoofGraph();
  }
  const recordRawKey = text(detail?.raw_key);
  const recordProvider = text(detail?.provider);
  if (
    (recordRawKey && rawKey !== recordRawKey) ||
    (recordProvider && provider !== recordProvider)
  ) {
    return unavailableEstimatorRoofGraph();
  }
  if (
    graph.points.length > MAX_ESTIMATOR_ROOF_GRAPH_POINTS ||
    graph.edges.length > MAX_ESTIMATOR_ROOF_GRAPH_EDGES ||
    graph.facets.length > MAX_ESTIMATOR_ROOF_GRAPH_FACETS
  ) {
    return unavailableEstimatorRoofGraph();
  }

  const points = graph.points.flatMap((entry) => {
    const point = roofGraphObject(entry);
    const id = point ? roofGraphIdentifier(point.id) : null;
    const x = point ? roofGraphNumber(point.x) : null;
    const y = point ? roofGraphNumber(point.y) : null;
    return id && x !== null && y !== null ? [{ id, x, y }] : [];
  });
  if (
    points.length !== graph.points.length ||
    new Set(points.map((point) => point.id)).size !== points.length
  ) {
    return unavailableEstimatorRoofGraph();
  }
  const pointIds = new Set(points.map((point) => point.id));
  const storedEdges = graph.edges.flatMap((entry) => {
    const edge = roofGraphObject(entry);
    const id = edge ? roofGraphIdentifier(edge.id) : null;
    const from = edge ? roofGraphIdentifier(edge.from) : null;
    const to = edge ? roofGraphIdentifier(edge.to) : null;
    return id &&
      from &&
      to &&
      from !== to &&
      pointIds.has(from) &&
      pointIds.has(to)
      ? [{ id, from, to } satisfies StoredRoofGraphEdge]
      : [];
  });
  if (
    storedEdges.length !== graph.edges.length ||
    new Set(storedEdges.map((edge) => edge.id)).size !== storedEdges.length
  ) {
    return unavailableEstimatorRoofGraph();
  }
  const edgesById = new Map(storedEdges.map((edge) => [edge.id, edge]));
  const facetCandidates: Array<{
    id: string;
    label: string | null;
    point_ids: string[];
    ring_closed: boolean;
  }> = [];
  for (const entry of graph.facets) {
    const facet = roofGraphObject(entry);
    const id = facet ? roofGraphIdentifier(facet.id) : null;
    const lineIds = facet ? roofGraphLineIds(facet.lineIds) : null;
    if (!facet || !id || !lineIds || typeof facet.ringClosed !== "boolean") {
      return unavailableEstimatorRoofGraph();
    }
    const facetPointIds = roofGraphFacetPointIds(lineIds, edgesById);
    if (
      !facetPointIds ||
      facetPointIds.some((pointId) => !pointIds.has(pointId))
    ) {
      return unavailableEstimatorRoofGraph();
    }
    facetCandidates.push({
      id,
      label: roofGraphIdentifier(facet.type),
      point_ids: facetPointIds,
      ring_closed: facet.ringClosed,
    });
  }
  if (
    facetCandidates.length !== graph.facets.length ||
    new Set(facetCandidates.map((facet) => facet.id)).size !==
      facetCandidates.length
  ) {
    return unavailableEstimatorRoofGraph();
  }

  let failedChecks = 0;
  for (const entry of graph.checks) {
    const check = roofGraphObject(entry);
    if (!check || typeof check.ok !== "boolean")
      return unavailableEstimatorRoofGraph();
    if (!check.ok) failedChecks += 1;
  }
  const reportStatus = text(detail?.review_status);
  const requiresReview =
    graph.needs_review ||
    failedChecks > 0 ||
    facetCandidates.some((facet) => !facet.ring_closed) ||
    reportStatus !== "Approved";
  const reviewStatus: EstimatorRoofGraphProjection["review_status"] =
    reportStatus === "Rejected"
      ? "Rejected"
      : requiresReview
        ? "Needs Review"
        : "Approved";

  return {
    state: requiresReview ? "needs_review" : "available",
    // The canonical persisted revision is a raw SHA-256. Expose only the graph schema revision.
    revision: "roof_graph/v1",
    source: sourceProvenance,
    provider,
    confidence: null,
    review_status: reviewStatus,
    captured_at: visualTimestamp(capture.captured_at),
    units: null,
    points,
    edges: storedEdges.map((edge) => ({
      id: edge.id,
      start_point_id: edge.from,
      end_point_id: edge.to,
    })),
    facets: facetCandidates.map((facet) => ({
      id: facet.id,
      label: facet.label,
      point_ids: facet.point_ids,
      confidence: null,
      review_status:
        reviewStatus === "Rejected"
          ? "Rejected"
          : requiresReview || !facet.ring_closed
            ? "Needs Review"
            : "Approved",
    })),
    check_count: graph.checks.length,
    failed_check_count: failedChecks,
  };
}

function unavailableEstimatorRoofGraph(): EstimatorRoofGraphProjection {
  return {
    state: "unavailable",
    revision: null,
    source: null,
    provider: null,
    confidence: null,
    review_status: "Unavailable",
    captured_at: null,
    units: null,
    points: [],
    edges: [],
    facets: [],
    check_count: 0,
    failed_check_count: 0,
  };
}

function roofGraphObject(value: unknown): FrappeRow | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FrappeRow)
    : null;
}

function roofGraphIdentifier(value: unknown): string | null {
  const result = text(value);
  return result && result.length <= MAX_ESTIMATOR_ROOF_GRAPH_IDENTIFIER
    ? result
    : null;
}

function roofGraphNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roofGraphSha256(value: string): boolean {
  return (
    value.length === 64 &&
    [...value].every((character) => "0123456789abcdef".includes(character))
  );
}

function roofGraphLineIds(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    value.length > MAX_ESTIMATOR_ROOF_GRAPH_FACET_EDGES
  )
    return null;
  const lineIds = value.map(roofGraphIdentifier);
  return lineIds.every((lineId): lineId is string => !!lineId) &&
    new Set(lineIds).size === lineIds.length
    ? lineIds
    : null;
}

function roofGraphFacetPointIds(
  lineIds: string[],
  edgesById: ReadonlyMap<string, StoredRoofGraphEdge>,
): string[] | null {
  const sourceEdges = lineIds.map((lineId) => edgesById.get(lineId));
  if (sourceEdges.some((edge): edge is undefined => !edge)) return null;
  const walk = (
    first: StoredRoofGraphEdge,
    reversed: boolean,
  ): string[] | null => {
    const remaining = sourceEdges.filter(
      (edge) => edge !== first,
    ) as StoredRoofGraphEdge[];
    const ring = reversed ? [first.to, first.from] : [first.from, first.to];
    while (remaining.length > 0) {
      const current = ring[ring.length - 1];
      const nextIndex = remaining.findIndex(
        (edge) => edge.from === current || edge.to === current,
      );
      if (nextIndex < 0) return null;
      const [next] = remaining.splice(nextIndex, 1);
      ring.push(next.from === current ? next.to : next.from);
    }
    return ring[0] === ring[ring.length - 1] ? ring.slice(0, -1) : null;
  };
  const first = sourceEdges[0] as StoredRoofGraphEdge;
  return walk(first, false) ?? walk(first, true);
}

async function estimatorGeometryFromRaw(
  env: AppEnv,
  rawKey: string | null,
  capture?: { model?: GeometryModel },
): Promise<EstimatorGeometryProjection> {
  if (!rawKey) return unavailableEstimatorGeometry("raw_source_not_recorded");
  if (!validMeasurementRawKey(rawKey))
    return unavailableEstimatorGeometry("raw_source_rejected");
  try {
    const source = await env.RAW.get(rawKey);
    if (!source) return unavailableEstimatorGeometry("raw_source_not_found");
    if (source.size > MAX_ESTIMATOR_RAW_BYTES)
      return unavailableEstimatorGeometry("raw_source_too_large");
    const rawText = await source.text();
    const geometry = extractGeometry(
      rawText,
      parseBody(rawText, "application/json"),
    );
    if (!geometry)
      return unavailableEstimatorGeometry("raw_source_not_recomputable");
    if (capture) capture.model = geometry;
    const failedChecks = geometry.checks.filter((check) => !check.ok);
    return {
      state: geometry.needsReview ? "needs_review" : "recomputed",
      reason: null,
      check_count: geometry.checks.length,
      failed_check_count: failedChecks.length,
      checks_truncated: geometry.checks.length > MAX_ESTIMATOR_CHECKS,
      facet_count: geometry.facets.length,
      facets_truncated: geometry.facets.length > MAX_ESTIMATOR_FACETS,
      metrics_truncated:
        Object.keys(geometry.measurements).length > MAX_ESTIMATOR_METRICS,
      checks: geometry.checks.slice(0, MAX_ESTIMATOR_CHECKS).map((check) => ({
        check: boundedGeometryText(check.check, MAX_ESTIMATOR_GEOMETRY_LABEL),
        target: boundedGeometryText(check.target, MAX_ESTIMATOR_GEOMETRY_LABEL),
        ok: check.ok,
        detail: boundedGeometryText(
          check.detail,
          MAX_ESTIMATOR_GEOMETRY_DETAIL,
        ),
      })),
      facets: geometry.facets.slice(0, MAX_ESTIMATOR_FACETS).map((facet) => ({
        id: boundedGeometryText(facet.id, MAX_ESTIMATOR_GEOMETRY_LABEL),
        type: boundedGeometryText(facet.type, MAX_ESTIMATOR_GEOMETRY_LABEL),
        material: facet.material
          ? boundedGeometryText(facet.material, MAX_ESTIMATOR_GEOMETRY_LABEL)
          : null,
        pitch: facet.pitch,
        orientation: facet.orientation,
        declared_area: facet.areaDeclared,
        computed_area: facet.areaComputed,
        deviation: facet.deviation,
        ring_closed: facet.ringClosed,
      })),
      metrics: Object.entries(geometry.measurements)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_ESTIMATOR_METRICS)
        .map(([metric, value]) => ({
          metric: boundedGeometryText(metric, MAX_ESTIMATOR_GEOMETRY_LABEL),
          value,
          source_ref: geometry.sourceRefs[metric]
            ? boundedGeometryText(
                geometry.sourceRefs[metric],
                MAX_ESTIMATOR_GEOMETRY_DETAIL,
              )
            : null,
        })),
    };
  } catch {
    return unavailableEstimatorGeometry("raw_source_read_failed");
  }
}

function unavailableEstimatorGeometry(
  reason: string,
): EstimatorGeometryProjection {
  return {
    state: "unavailable",
    reason,
    check_count: 0,
    failed_check_count: 0,
    checks_truncated: false,
    facet_count: 0,
    facets_truncated: false,
    metrics_truncated: false,
    checks: [],
    facets: [],
    metrics: [],
  };
}

function validMeasurementRawKey(value: string): boolean {
  return /^raw\/measurements\/\d{4}-\d{2}-\d{2}\/ow_[0-9a-f-]{36}\.json$/.test(
    value,
  );
}

function boundedGeometryText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maximum
    ? `${compact.slice(0, maximum - 1)}…`
    : compact;
}

function recordRows(value: unknown): FrappeRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is FrappeRow =>
          !!row && typeof row === "object" && !Array.isArray(row),
      )
    : [];
}

function address(row: FrappeRow | undefined): string | null {
  if (!row) return null;
  const locality = [text(row.city), text(row.province), text(row.postal_code)]
    .filter(notNull)
    .join(" ");
  const parts = [
    text(row.address_line1),
    locality || null,
    text(row.country),
  ].filter(notNull);
  return parts.length > 0 ? parts.join(", ") : null;
}

function tenantDate(timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "America/Edmonton",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function compareSchedule(left: string | null, right: string | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return dateValue(left) - dateValue(right);
}

function productionLanePriority(lane: ProductionRunwayLane): number {
  return [
    "blocked",
    "scheduled",
    "needs_assignment",
    "ready_for_review",
    "needs_verification",
  ].indexOf(lane);
}

function dateValue(value: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function validJobName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _./:#()\-]{0,139}$/.test(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasRestrictedInsuranceAccess(env: AppEnv, auth: AuthContext): boolean {
  if (auth.session.role === "owner") return true;
  if (auth.session.role !== "ops") return false;
  const frappeUser = text(auth.session.frappe_user_id)?.toLowerCase();
  if (!frappeUser) return false;
  return (env.APP_INSURANCE_ESTIMATOR_FRAPPE_USERS ?? "")
    .split(",")
    .map((candidate) => candidate.trim().toLowerCase())
    .filter((candidate) => candidate.length > 0 && candidate.length <= 254)
    .slice(0, 32)
    .includes(frappeUser);
}

function sameUser(value: unknown, expected: string): boolean {
  return text(value)?.toLowerCase() === expected.trim().toLowerCase();
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function numberValue(value: unknown): number {
  return optionalNumber(value) ?? 0;
}

function optionalNumber(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  )
    return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberDelta(current: unknown, prior: unknown): number | null {
  const currentNumber = optionalNumber(current);
  const priorNumber = optionalNumber(prior);
  return currentNumber === null || priorNumber === null
    ? null
    : currentNumber - priorNumber;
}

function valueChanged(current: unknown, prior: unknown): boolean {
  const currentText = text(current);
  const priorText = text(prior);
  if (currentText !== null || priorText !== null)
    return currentText !== priorText;
  return optionalNumber(current) !== optionalNumber(prior);
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
