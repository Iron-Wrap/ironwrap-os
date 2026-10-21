import {
  pricingCatalogEnabled,
  resolveFrozenCatalogPricing,
  resolveFrozenLegacyPricing,
} from "./pricing-catalog.ts";
import {
  appUserIdentities,
  type AppEnv,
  type AppRole,
  type AuthContext,
  type WorkObjectScope,
} from "./app-types.ts";
import {
  canMoveCards,
  canViewPipeline,
  NO_PIPELINE_ROLE_ACCESS,
  parsePipelineCardTemplate,
  PIPELINE_UNDO_WINDOW_MS,
  renderCardSummary,
  satisfiesStageRole,
  templateRelations,
  type PipelineCardSummary,
  type PipelineCardTemplate,
  type PipelineRecord,
  type PipelineRoleAccess,
  type PipelineStageRecord,
} from "./pipeline-board.ts";
import {
  cardCountsByPipeline,
  pipelineRoleAccessFor,
  listCards,
  listPipelines,
  listStages,
  resolveCardRelations,
} from "./pipeline-board-store.ts";
import { approvalDecisionConfig } from "./approval-broker-client.ts";
import { quoteRevisionApprovalBrokerConfig } from "./quote-revision-approval-broker-client.ts";
import {
  type FrappeRow,
} from "./frappe-read.ts";
import { parseBody } from "./core.ts";
import { getCompanyProfile } from "./company-setup-store.ts";
import { publicCompanyContact } from "./company-profile.ts";
import { NO_DEPOSIT_UNDER_CONTRACT } from "./deposit-policy.ts";
import {
  listCurrentJobMeasurements,
  type JobMeasurementSummary,
} from "./measurement-intake-store.ts";
import { extractGeometry } from "./measurements.ts";
import type { GeometryModel } from "./geometry.ts";
import { takeoffFromGeometry, type TakeoffModel } from "./takeoff.ts";
import {
  approvedPricingPolicyIdentity,
  priceTakeoff,
  type PriceList,
  type VerifiedPricingAuthority,
} from "./pricing.ts";
import {
  buildJobEconomicsProjection,
  type JobEconomicsProjection,
} from "./job-economics.ts";
import { listLeadMctbEvidence, type LeadAckReceipt } from "./store.ts";
import {
  listFieldWorkPackageEvidenceFromD1,
  listJobEvidenceFromD1,
  type FieldWorkPackageEvidenceD1Row,
} from "./field-actions.ts";
import {
  FIELD_MEASUREMENT_READ_LIMIT,
  listFieldMeasurementsFromD1,
  type FieldMeasurementCapture,
  type FieldMeasurementCursor,
} from "./field-measurements.ts";

import {
  fieldWorkPackageForAssignment,
  fieldWorkPackageProjection,
  currentWorkPackageAuthorityDenials,
  hasWorkPackageCompletionAuthority,
  nativeFieldWorkPackageForAssignment,
  type FieldWorkPackage,
} from "./work-package.ts";
import { nativeAssignments } from "./work-package-store.ts";
import {
  listCurrentOperatingJobAssignments,
  type OperatingJobAssignmentRecord,
} from "./operating-job-assignment-store.ts";
import {
  listCurrentOperatingWorkObjectAssignments,
  type OperatingWorkObjectAssignmentRecord,
} from "./operating-work-object-assignment-store.ts";
import { safetyReadinessForScope } from "./safety-release-gate.ts";
import { facetLaunchConfigured } from "./facet-launch.ts";
import { commercialActionConfigured } from "./commercial-authority.ts";
import {
  readCommercialSalesSources,
  type CommercialSalesSources,
  type OperatingSalesLeadRecord,
  type OperatingSalesConsentRecord,
  type OperatingSalesEstimateRecord,
} from "./commercial-sales-read.ts";
import type { CommercialQuoteRecord } from "./commercial-store.ts";
import {
  readNativeCommercialJobPacket,
  readNativeJobCore,
  type NativeCommercialJobPacket,
  type NativeCustomerRecord,
  type NativeJobCoreRecord,
  type NativePropertyRecord,
} from "./native-job-packet-read.ts";
import { readNativeEstimatorSources } from "./estimator-native.ts";

/** A missing or damaged optional measurement panel must not hide the live work packet. */
async function embeddedFieldMeasurements(
  env: AppEnv,
  input: Parameters<typeof listFieldMeasurementsFromD1>[1],
): ReturnType<typeof listFieldMeasurementsFromD1> {
  try {
    return await listFieldMeasurementsFromD1(env, input);
  } catch {
    return null;
  }
}

export interface FieldMeasurementReadItem extends FieldMeasurementCapture {
  allowed_actions: Array<"field.measurement.correct">;
  correction_target:
    | { correction_of: string }
    | { evidence_correction_of: string; evidence_item_correction_of: string }
    | null;
}

/** A current-action hint for one actor and assignment; the write checks authority again. */
function fieldMeasurementReadItems(
  items: FieldMeasurementCapture[],
  auth: AuthContext,
  assignmentId: string | null,
  workPackage: FieldWorkPackage | null,
): FieldMeasurementReadItem[] {
  const identities = appUserIdentities(auth.session).map((value) =>
    value.toLowerCase(),
  );
  return items.map((item) => {
    let correctionTarget: FieldMeasurementReadItem["correction_target"] = null;
    const actorCanCorrect =
      auth.session.active === 1 &&
      auth.session.role === "field" &&
      !!auth.session.device_id &&
      item.recorded_by === auth.session.user_id &&
      item.assignment_id === assignmentId &&
      item.superseded_by === null;
    if (actorCanCorrect && item.work_package_id === null) {
      if (
        item.work_package_version === null &&
        item.work_package_release_attempt_id === null &&
        item.evidence_slot_id === null
      )
        correctionTarget = { correction_of: item.checkin_id };
    } else if (
      actorCanCorrect &&
      workPackage &&
      item.work_package_id === workPackage.id &&
      item.work_package_version === workPackage.version &&
      item.work_package_release_attempt_id === workPackage.releaseAttemptId &&
      workPackage.workerRosterKnown === true &&
      workPackage.evidenceLedgerAvailable === true &&
      Date.parse(workPackage.expiresAt) > Date.now() &&
      workPackage.assignedWorkers?.some((worker) =>
        identities.includes(worker.workerUser.toLowerCase()),
      )
    ) {
      const events = (workPackage.evidence ?? []).filter(
        (event) =>
          event.deviceActionId === item.device_action_id &&
          event.slotId === item.evidence_slot_id &&
          identities.includes(event.actorUser.toLowerCase()) &&
          event.releaseAttemptId === workPackage.releaseAttemptId &&
          event.verification === "Verified" &&
          event.disposition !== "Superseded" &&
          !(workPackage.evidence ?? []).some(
            (next) => next.correctionOf === event.eventId,
          ),
      );
      if (events.length === 1)
        correctionTarget = {
          evidence_correction_of: events[0].eventId,
          evidence_item_correction_of: events[0].evidenceItem,
        };
    }
    return {
      ...item,
      allowed_actions: correctionTarget ? ["field.measurement.correct"] : [],
      correction_target: correctionTarget,
    };
  });
}

const ACTIVE_JOB_STATUSES = ["Won", "In Production"] as const;
const FIELD_PACKET_PROOF_PAGE_SIZE = 100;
const OWNER_NOW_SOURCE_LIMIT = 50;
const OWNER_ECONOMICS_NATIVE_UNAVAILABLE = [
  "change_order",
  "supplier_quote",
  "supplier_order",
  "material_lot",
  "shop_order",
  "field_checkin.cost_basis",
  "job_cost_event.tax_basis",
] as const;
const OWNER_FINANCE_ATTENTION_STATES = new Set([
  "blocked",
  "pending_review",
  "uncertain",
  "partially_settled",
  "mismatch",
  "reconciliation_required",
  "failed",
]);
const OWNER_ACCOUNTING_PROVIDER_ENTITY = {
  deposit_invoice: "Invoice",
  progress_invoice: "Invoice",
  final_invoice: "Invoice",
  payment: "Payment",
  credit_memo: "CreditMemo",
  refund: "RefundReceipt",
} as const;
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
const NON_BLOCKING_GATE_STATES = new Set(["ready", "waived", "complete"]);

type NativeProductionJobRow = NativeJobCoreRecord;

interface NativeProductionGateRow {
  gate_id: string;
  roof_job_id: string;
  gate: string;
  state: string;
  blocker_reason: string;
  owner_user: string;
  assigned_at: string;
  due_at: string;
  updated_at: string;
  /** The basis of the ledger entry the gate stands on (0153), when one does. */
  basis_in_force: string | null;
}

interface NativeProductionCrewRow {
  crew_id: string;
  display_name: string;
  version: number;
  updated_at: string;
}

interface NativeMaterialExceptionRow {
  exception_id: string;
  aggregate_id: string;
  exception_type: string;
  status: string;
  reason_code: string;
  created_at: string;
  updated_at: string;
}

interface NativeOwnerFieldBlockerRow {
  work_package_id: string;
  version: number;
  job_id: string;
  stop_event_id: string | null;
  blocker_reason: string | null;
  occurred_at: string | null;
  manifest_key: string | null;
  updated_at: string;
}

interface NativeOwnerUnknownStopRow {
  occurrence_id: string;
  reported_at: string;
  reported_by_name: string | null;
  summary: string;
  updated_at: string;
}

/**
 * The owner's exception for an active work stop that names a job the tenant does not have (Track
 * B's final copy). The stop's raw job id is not shown. The item has no controls and no link.
 */
export const STOP_JOB_UNKNOWN_TITLE = "This work stop names a job that doesn’t exist";
export const STOP_JOB_UNKNOWN_WHY = "Safety stays held on every job while this work stop is active.";

/** The owner's exception for an active stop that names a Work Package the tenant does not have. */
export const STOP_WORK_PACKAGE_UNKNOWN_TITLE =
  "This stop names a work package that doesn't exist — fix which job it is for";

interface NativeOwnerEffectExceptionRow {
  exception_id: string;
  effect_id: string;
  reason_code: string;
  action: string;
  provider: string;
  aggregate_type: string;
  aggregate_id: string;
  created_at: string;
  updated_at: string;
}

interface NativeOwnerAccountingIntentRow {
  intent_id: string;
  roof_job_id: string;
  kind: string;
  state: string;
  currency: string;
  subtotal: string;
  total_amount: string;
  expected_sha256: string;
  provider_entity_type: string | null;
  provider_entity_id: string | null;
  blocker_code: string | null;
  blocker_next_step: string | null;
  reason_code: string | null;
  error_code: string | null;
  provider_submitted_at: string | null;
  provider_reconciled_at: string | null;
  updated_at: string;
}

interface NativeOwnerAccountingReconciliationRow {
  reconciliation_id: string;
  intent_id: string;
  expected_sha256: string;
  observed_sha256: string | null;
  verdict: string;
  reason_code: string | null;
  decided_at: string;
}

interface NativeOwnerAccountingExceptionRow {
  exception_id: string;
  subject_ref: string;
  intent_id: string | null;
  reason_code: string;
  status: string;
  roof_job_id: string | null;
  opened_at: string;
  updated_at: string;
}

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
  modified: string | null;
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
    version: number;
    assignment: {
      id: string;
      type: string | null;
      status: string | null;
      assignment_version: number;
      roof_job_version: number;
      crew_id: string;
      crew_version: number;
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
    version: number;
  }>;
}

export interface JobReadModel extends ReadModelEnvelope {
  field_measurements: FieldMeasurementReadItem[];
  field_measurements_more: boolean;
  /** Owner-saved public company contact; never a staff or customer identity. */
  office_contact: { phone: string | null; email: string | null } | null;
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
      status: "Released" | "Acknowledged" | "In Progress" | "Blocked";
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

async function officeContactForRead(
  env: AppEnv,
  tenantId: string,
): Promise<{
  contact: { phone: string | null; email: string | null } | null;
  updatedAt: string | null;
  unavailable: boolean;
}> {
  try {
    const profile = await getCompanyProfile(env, tenantId);
    return {
      contact: publicCompanyContact(profile),
      updatedAt: profile.updated_at,
      unavailable: false,
    };
  } catch {
    // Losing the optional directory read must not hide an assigned work plan.
    return { contact: null, updatedAt: null, unavailable: true };
  }
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
    /**
     * Who raised the work stop (`stop_job_unknown`): their display name in this tenant, or null
     * when they have none. When it was raised is `occurred_at`. Null on every other kind.
     */
    reported_by_name: string | null;
    /**
     * The work stop's own summary, raw as it was written (`stop_job_unknown`); the UI wraps and
     * truncates it. Null on every other kind.
     */
    summary: string | null;
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
  | "source_partial"
  | "triage_unresolved"
  | "estimate_needs_review"
  | "quote_needs_review"
  | "quote_expired";

export type SalesPartialField =
  | "job"
  | "triage_decision"
  | "estimate"
  | "quote"
  | "proposal"
  | "proposal_publication"
  | "quote_acceptance"
  | "proposal_acceptance";

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
      version: number;
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
    /** Null child values for these fields are unknown because a bounded source omitted rows. */
    partial_fields: SalesPartialField[];
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
  const tenantId = (env.APP_TENANT_ID ?? "ironwrap").trim();
  if (
    tenantId !== auth.session.tenant_id ||
    typeof env.DB?.prepare !== "function"
  )
    return null;
  return await activeNativeAssignmentForJob(env, auth, jobName);
}

async function activeNativeAssignmentForJob(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
  readMode: "any" | "assigned" = jobReadMode(auth),
): Promise<FrappeRow | null> {
  if (!validJobName(jobName) || typeof env.DB?.prepare !== "function")
    return null;
  const actorUsers =
    readMode === "assigned" ? appUserIdentities(auth.session) : undefined;
  const assignments = await listCurrentOperatingJobAssignments(
    env,
    auth.session.tenant_id,
    {
      roofJobId: jobName,
      ...(actorUsers ? { actorUsers } : {}),
    },
  );
  return assignments.length === 1
    ? nativeOperatingAssignmentRow(assignments[0]!)
    : null;
}

/**
 * Resolve the Fleet Asset an authenticated field user may capture against.
 *
 * Do not trust a fleet asset identifier from the browser. Without this the rail
 * would let any paired field session post an out-of-service defect against any
 * vehicle in the fleet — grounding it immediately and irreversibly — or
 * fabricate a passing pre-trip for an asset it never touched. The relationship
 * native authority reads is the one that authorizes the capture: custody of
 * the asset, active crew membership, or driving it on an open Cargo Load.
 *
 * Returns null for both "no such asset" and "not yours", so the rail cannot be
 * used to enumerate the fleet. The D1 insert trigger repeats this scope check.
 */
export async function fleetAssetForFieldActor(
  env: AppEnv,
  auth: AuthContext,
  assetId: string,
): Promise<{ fleet_asset_id: string; tenant_id: string } | null> {
  if (auth.session.role !== "field") return null;
  return await env.DB.prepare(
    `SELECT asset.fleet_asset_id, asset.tenant_id
       FROM fleet_assets asset
      WHERE asset.tenant_id = ? AND asset.fleet_asset_id = ?
        AND asset.status != 'Retired'
        AND (
          (asset.custody_holder_type = 'User' AND asset.custody_user_id = ?)
          OR (asset.custody_holder_type = 'Crew' AND EXISTS (
            SELECT 1 FROM fleet_crew_members member
            JOIN fleet_crews crew
              ON crew.tenant_id = member.tenant_id
             AND crew.crew_id = member.crew_id
             WHERE member.tenant_id = asset.tenant_id
               AND member.crew_id = asset.custody_crew_id
               AND member.user_id = ? AND member.active = 1
               AND crew.status = 'Active'
          ))
          OR EXISTS (
            SELECT 1 FROM fleet_cargo_loads load
            JOIN fleet_driver_authorities authority
              ON authority.tenant_id = load.tenant_id
             AND authority.driver_authority_id = load.driver_authority_id
            JOIN app_users driver
              ON driver.tenant_id = load.tenant_id
             AND driver.user_id = load.driver_user_id
            WHERE load.tenant_id = asset.tenant_id
              AND (load.fleet_asset_id = asset.fleet_asset_id
                   OR load.trailer_asset_id = asset.fleet_asset_id)
              AND asset.status = 'Active'
              AND load.status IN ('Loaded', 'In Transit', 'Delivered')
              AND load.driver_user_id = ?
              AND authority.user_id = load.driver_user_id
              AND authority.user_id = ?
              AND authority.status = 'Active'
              AND authority.authority_source = 'Physical Document'
              AND driver.active = 1
              AND COALESCE(driver.access_role, driver.role) = 'field'
          )
        )
      LIMIT 1`,
  )
    .bind(
      auth.session.tenant_id,
      assetId,
      auth.session.user_id,
      auth.session.user_id,
      auth.session.user_id,
      auth.session.user_id,
    )
    .first<{ fleet_asset_id: string; tenant_id: string }>();
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
    scope.workObjectType === "Roof Job" ||
    (env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id ||
    typeof env.DB?.prepare !== "function"
  ) {
    return null;
  }
  const candidates = await listCurrentOperatingWorkObjectAssignments(
    env,
    auth.session.tenant_id,
    {
      scope,
      ...(jobReadMode(auth) === "assigned"
        ? { actorUsers: appUserIdentities(auth.session) }
        : {}),
    },
  );
  return candidates.length === 1
    ? nativeOperatingWorkObjectAssignmentRow(candidates[0]!)
    : null;
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
    auth.session.tenant_id,
  );
  const officeRole = ["owner", "ops", "production"].includes(auth.session.role);
  if (
    (!workPackage && !officeRole) ||
    (workPackage &&
      (workPackage.workObjectType !== scope.workObjectType ||
        workPackage.workObjectId !== scope.workObjectId ||
        workPackage.physicalContextType !== scope.physicalContextType ||
        workPackage.physicalContextId !== scope.physicalContextId))
  ) {
    return null;
  }
  const evaluatedAt = new Date().toISOString();
  const [safetyBlockers, authorityDenials] = workPackage
    ? await Promise.all([
        safetyReadinessForScope(env, {
          tenantId: auth.session.tenant_id,
          scope: { type: "work_package", id: workPackage.id },
          jobId: scope.workObjectId,
          subjectUserIds: [auth.session.user_id],
          now: evaluatedAt,
        }).then((readiness) => readiness.blockers),
        currentWorkPackageAuthorityDenials(
          env,
          auth.session.tenant_id,
          workPackage,
          evaluatedAt,
        ),
      ])
    : [[], []];
  const projection = fieldWorkPackageProjection(
    workPackage,
    jobReadMode(auth) === "assigned" ? appUserIdentities(auth.session) : null,
    {
      completionAuthority: hasWorkPackageCompletionAuthority(
        workPackage,
        assignment,
        appUserIdentities(auth.session),
        auth.session.role,
      ),
      completionActorUser: appUserIdentities(auth.session),
      // The device must see the same verdict the action endpoint will apply, so
      // a blocked crew is told why instead of being refused after tapping.
      safetyBlockers,
      authorityDenials,
    },
  );
  const allowedActions = [...projection.allowedActions];
  allowedActions.push(
    ...officeWorkPackageActions(auth.session.role, assignment, workPackage),
  );
  if (
    auth.session.role === "field" &&
    !allowedActions.includes("field.checkin.create")
  ) {
    allowedActions.push("field.checkin.create");
  }
  const fieldMeasurements = await embeddedFieldMeasurements(env, {
    tenantId: auth.session.tenant_id,
    jobId: scope.workObjectId,
    scope,
  });
  const officeContact = await officeContactForRead(env, auth.session.tenant_id);
  return {
    ...envelope(
      auth,
      [assignment, { modified: officeContact.updatedAt }],
      [
        ...(fieldMeasurements === null ? ["field_measurements.native_unavailable"] : []),
        ...(officeContact.unavailable ? ["office_contact.unavailable"] : []),
      ],
    ),
    field_measurements: fieldMeasurementReadItems(
      fieldMeasurements?.items ?? [],
      auth,
      assignmentId,
      workPackage,
    ),
    field_measurements_more: fieldMeasurements?.more ?? false,
    office_contact: officeContact.contact,
    work_object: scope,
    assignment: assignmentModel(assignment),
    work_package: projection.work_package,
    allowed_actions: [...new Set(allowedActions)],
  };
}

export async function buildTodayReadModel(
  env: AppEnv,
  auth: AuthContext,
): Promise<TodayReadModel> {
  const readMode = jobReadMode(auth);
  const assignments = await nativeTodayAssignments(env, auth);
  const preferredByJob = preferredAssignmentsByJob(assignments);
  const assignedJobIds = [...preferredByJob.keys()];
  const typedAssignments = preferredAssignmentsByWorkObject(assignments);
  if (
    readMode === "assigned" &&
    assignedJobIds.length === 0 &&
    typedAssignments.length === 0
  )
    return emptyToday(env, auth, assignments);
  const jobSource = await nativeActiveJobs(
    env,
    auth.session.tenant_id,
    readMode === "assigned" ? assignedJobIds : undefined,
  );
  const jobs = jobSource.rows.map(nativeOperatingJobRow);
  const jobIds = jobs.map((row) => text(row.name)).filter(notNull);
  const propertyIds = jobs
    .map((row) => text(row.roofing_property))
    .filter(notNull);
  const [gateSource, propertySource] = await Promise.all([
    nativeProductionGates(env, auth.session.tenant_id, jobIds, "blocked"),
    nativeProperties(env, auth.session.tenant_id, propertyIds),
  ]);
  const blockedGates = gateSource.rows.map(nativeProductionGateFrappeRow);
  const properties = propertySource.rows
    .map(nativePropertyFrappeRow)
    .filter((row): row is FrappeRow => row !== null);
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
      return [
        {
          ...scope,
          scheduled_start: assignment.scheduled_start,
          scheduled_end: assignment.scheduled_end,
          next_action:
            assignment.blocker_reason ?? "Open the typed physical work package",
          assignment,
        },
      ];
    })
    .sort(
      (left, right) =>
        compareSchedule(left.scheduled_start, right.scheduled_start) ||
        left.work_object_type.localeCompare(right.work_object_type) ||
        left.work_object_id.localeCompare(right.work_object_id) ||
        left.physical_context_id.localeCompare(right.physical_context_id),
    );
  const stale: string[] = [];
  if (jobSource.partial) stale.push("jobs.partial_source");
  if (gateSource.partial) stale.push("jobs.blocked_gates_partial");
  if (propertySource.partial) stale.push("jobs.address_partial");
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

  const schedulePreparationConfigured = ["owner", "ops", "production"].includes(
    auth.session.role,
  );
  const gateClearanceAllowed =
    auth.permissions.includes("production:clear_gate") &&
    Boolean(auth.session.frappe_user_id?.trim());
  const [jobSource, nativeAssignmentsSource, crewSource] = await Promise.all([
    nativeActiveJobs(env, auth.session.tenant_id),
    listCurrentOperatingJobAssignments(env, auth.session.tenant_id),
    nativeProductionCrews(env, auth.session.tenant_id),
  ]);
  const jobs = jobSource.rows.map(nativeOperatingJobRow);
  const assignments = nativeAssignmentsSource.map(nativeOperatingAssignmentRow);
  const jobIds = jobs.map((row) => text(row.name)).filter(notNull);
  const [gateSource, materialSource] = await Promise.all([
    nativeProductionGates(env, auth.session.tenant_id, jobIds),
    nativeMaterialExceptions(env, auth.session.tenant_id, jobIds),
  ]);
  const gates = gateSource.rows.map(nativeProductionGateFrappeRow);
  const materialExceptions = materialSource.rows.map(
    nativeMaterialExceptionFrappeRow,
  );

  const partialSources: string[] = [];
  if (jobSource.partial) partialSources.push("active_jobs");
  if (assignments.length === PRODUCTION_SOURCE_LIMIT)
    partialSources.push("active_assignments");
  if (gateSource.partial) partialSources.push("gate_states");
  if (materialSource.partial) partialSources.push("material_exceptions");
  if (crewSource.partial) partialSources.push("crew_profiles");

  const gateRowsByJob = groupBy(gates, "roof_job");
  const materialRowsByJob = groupBy(materialExceptions, "roof_job");
  const assignmentByJob = preferredAssignmentsByJob(assignments);
  const gateRowsComplete = !partialSources.includes("gate_states");
  const assignmentRowsComplete = !partialSources.includes("active_assignments");
  const materialExceptionRowsComplete = !partialSources.includes(
    "material_exceptions",
  );
  const crewProfilesComplete = !partialSources.includes("crew_profiles");
  const crews = crewSource.rows
    .map((row) => ({
      id: row.crew_id,
      name: row.display_name,
      version: row.version,
    }))
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
          state: productionGateStateLabel(latestGatesByName.get(name)),
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
          (gate) => text(gate.state) === "blocked",
        ).length,
        ready: schedulingGates.filter((gate) => text(gate.state) === "ready")
          .length,
        waived: schedulingGates.filter((gate) => text(gate.state) === "waived")
          .length,
        done: schedulingGates.filter(
          (gate) => text(gate.state) === "complete" && !depositNotRequiredByContract(gate),
        ).length,
      };
      const materialAttention = (materialRowsByJob.get(id) ?? []).flatMap(
        (row) => {
          const status = text(row.status);
          return status
            ? [
                {
                  status: text(row.exception_type) ?? status,
                  requested_delivery_date: null,
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
        : !assignmentRowsComplete ||
            !gateRowsComplete ||
            !materialExceptionRowsComplete
          ? "needs_verification"
          : assignment?.scheduled_start
            ? "scheduled"
            : allReturnedGatesNonBlocking && crews.length > 0
              ? "ready_for_review"
              : gateCoverage === "complete"
                ? "needs_assignment"
                : "needs_verification";
      const nextAction =
        lane === "blocked"
          ? "Resolve the source-backed blocker before dispatch review"
          : lane === "scheduled"
            ? "Confirm the schedule against current gate coverage"
            : lane === "needs_assignment"
              ? "Create an active native crew before scheduling"
              : lane === "ready_for_review"
                ? "Choose a crew and schedule this job"
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
          version: Number(job.version),
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
        ...crewSource.rows.map(nativeProductionCrewFrappeRow),
      ],
      stale,
    ),
    allowed_actions: [
      "job.read",
      "production.read",
      ...(gateClearanceAllowed ? ["production_gate.clear"] : []),
      ...(schedulePreparationConfigured &&
      crewProfilesComplete &&
      crews.length > 0
        ? ["operating_job_assignment.create"]
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
  options: { estimatorReadOnly?: boolean } = {},
): Promise<JobReadModel | null> {
  if (!validJobName(jobName)) return null;
  const estimatorReadOnly = options.estimatorReadOnly === true;
  if (
    estimatorReadOnly &&
    (auth.session.role !== "sales" ||
      !auth.permissions.includes("estimator:read"))
  )
    return null;
  const readMode = estimatorReadOnly ? "any" : jobReadMode(auth);
  const assignmentRow = await activeNativeAssignmentForJob(
    env,
    auth,
    jobName,
    readMode,
  );
  if (readMode === "assigned" && !assignmentRow) return null;
  const nativeJobCore = await readNativeJobCore(
    env,
    auth.session.tenant_id,
    jobName,
  );
  if (!nativeJobCore) return null;
  const job = nativeOperatingJobRow(nativeJobCore.job);
  if (!ACTIVE_JOB_STATUSES.includes(text(job.job_status) as never)) return null;

  const propertyId = text(job.roofing_property);
  const [gateSource, workPackage, measurementRows, fieldMeasurements, officeContact] =
    await Promise.all([
      nativeProductionGates(env, auth.session.tenant_id, [jobName]),
      assignmentRow
        ? nativeFieldWorkPackageForAssignment(
            env,
            auth.session.tenant_id,
            jobName,
            text(assignmentRow.name)!,
          )
        : Promise.resolve(null),
      // The crew on the roof could not see the measurements anyone had taken of it: this slot was
      // returned empty on the owned path while `native_measurement_revisions` held the rows the
      // whole time. `null` on failure rather than a throw, so a measurement read that goes wrong
      // costs the crew this one panel and keeps the rest of the job packet — and the stale marker
      // below stays on, which is the difference between "none" and "could not read".
      listCurrentJobMeasurements(env, auth.session.tenant_id, jobName).catch(
        () => null as JobMeasurementSummary[] | null,
      ),
      embeddedFieldMeasurements(env, {
        tenantId: auth.session.tenant_id,
        jobId: jobName,
      }),
      officeContactForRead(env, auth.session.tenant_id),
    ]);
  const gates = gateSource.rows.map(nativeProductionGateFrappeRow);
  const property = nativePropertyFrappeRow(nativeJobCore.property);
  const customer = nativeCustomerFrappeRow(nativeJobCore.customer);
  const nativeWorkPackageEvidence =
    assignmentRow && workPackage
      ? await nativeWorkPackageProofRows(
          env,
          auth.session.tenant_id,
          jobName,
          text(assignmentRow.name)!,
          workPackage,
        )
      : [];
  if (nativeWorkPackageEvidence === null)
    throw new Error("native_job_proof_unavailable");
  const proofEvidenceRows = nativeWorkPackageEvidence.slice(
    0,
    FIELD_PACKET_PROOF_PAGE_SIZE,
  );
  const proofStream = proofEvidenceRows
    .map(evidenceProofItem)
    .filter(notNull)
    .sort(compareProofItems);
  const workPackageEvaluatedAt = new Date().toISOString();
  const [workPackageSafetyBlockers, workPackageAuthorityDenials] = workPackage
    ? await Promise.all([
        safetyReadinessForScope(env, {
          tenantId: auth.session.tenant_id,
          scope: { type: "work_package", id: workPackage.id },
          jobId: jobName,
          subjectUserIds: [auth.session.user_id],
          now: workPackageEvaluatedAt,
        }).then((readiness) => readiness.blockers),
        currentWorkPackageAuthorityDenials(
          env,
          auth.session.tenant_id,
          workPackage,
          workPackageEvaluatedAt,
        ),
      ])
    : [[], []];
  const workPackagePacket = fieldWorkPackageProjection(
    workPackage,
    readMode === "assigned" ? appUserIdentities(auth.session) : null,
    {
      completionAuthority: hasWorkPackageCompletionAuthority(
        workPackage,
        assignmentRow ?? null,
        appUserIdentities(auth.session),
        auth.session.role,
      ),
      completionActorUser: appUserIdentities(auth.session),
      safetyBlockers: workPackageSafetyBlockers,
      authorityDenials: workPackageAuthorityDenials,
    },
  );
  const stale = [
    "packet.contact.access_instructions",
    "packet.scope_clauses.native_unavailable",
    ...(measurementRows === null ? ["packet.measurements.native_unavailable"] : []),
    ...(fieldMeasurements === null ? ["field_measurements.native_unavailable"] : []),
    "packet.materials.takeoffs.native_unavailable",
    "packet.materials.supplier_orders.native_unavailable",
    "packet.change_orders.native_unavailable",
    "packet.safety_plan.native_unavailable",
  ];
  if (gateSource.partial) stale.push("gates.partial_source");
  if (
    new Set(gates.map((row) => text(row.gate)).filter(notNull)).size <
    SCHEDULING_PRODUCTION_GATES.length
  )
    stale.push("gates.native_incomplete");
  if (propertyId && !property) stale.push("job.address");
  if (!customer || !text(customer.display_name))
    stale.push("packet.contact.display_name");
  if (!customer || !text(customer.phone)) stale.push("packet.contact.phone");
  if (assignmentRow && !workPackage)
    stale.push("packet.work_package.native_unavailable");
  if (!assignmentRow || !workPackage)
    stale.push("proof_stream.native_scope_unavailable");
  if (officeContact.unavailable) stale.push("office_contact.unavailable");
  const readEnvelope = envelope(
    auth,
    [
      job,
      ...(assignmentRow ? [assignmentRow] : []),
      ...gates,
      ...proofEvidenceRows,
      ...(property ? [property] : []),
      ...(customer ? [customer] : []),
      ...(workPackage ? [{ modified: workPackage.modified }] : []),
      ...(measurementRows ?? []).map((row) => ({ modified: row.created_at })),
      { modified: officeContact.updatedAt },
    ],
    stale,
  );
  return {
    ...readEnvelope,
    office_contact: officeContact.contact,
    field_measurements: fieldMeasurementReadItems(
      fieldMeasurements?.items ?? [],
      auth,
      text(assignmentRow?.name),
      workPackage,
    ),
    field_measurements_more: fieldMeasurements?.more ?? false,
    allowed_actions: estimatorReadOnly
      ? ["job.read"]
      : [
          ...new Set([
            ...(auth.session.role === "production"
              ? ["job.read"]
              : readEnvelope.allowed_actions),
            ...(readMode === "assigned"
              ? workPackagePacket.allowedActions
              : []),
            ...officeWorkPackageActions(
              auth.session.role,
              assignmentRow,
              workPackage,
            ),
          ]),
        ],
    job: {
      id: text(job.name)!,
      roof_job_id: text(job.roof_job_id),
      job_number: text(job.job_number),
      brand: text(job.brand),
      service_type: text(job.service_type),
      status: text(job.job_status),
      address: address(property ?? undefined),
      current_gate_state: text(job.current_gate_state),
    },
    assignment: assignmentRow ? assignmentModel(assignmentRow) : null,
    gates: gates.flatMap((row) => gateModel(row, readMode === "assigned")),
    packet: {
      scope_clauses: [],
      measurements: (measurementRows ?? []).map((row) => ({
        id: row.measurement_revision_id,
        provider: row.provider,
        // Exactly what the column means and nothing further. `review_required` is never cleared on
        // this append-only table -- a correction arrives as a new revision -- so "reviewed" would
        // be a claim no row here can support.
        review_status:
          row.review_required === 1 ? "Flagged for review" : "No review flagged",
        parsed_at: row.created_at,
      })),
      materials: {
        takeoffs: [],
        supplier_orders: [],
      },
      change_orders: [],
      safety_plan: null,
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
        nativeWorkPackageEvidence.length > FIELD_PACKET_PROOF_PAGE_SIZE
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
          blocker_reason: productionGateReason(row),
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
  options: { estimatorReadOnly?: boolean } = {},
): Promise<ProofPageReadModel | null> {
  if (!validJobName(jobName)) return null;
  const estimatorReadOnly = options.estimatorReadOnly === true;
  if (
    estimatorReadOnly &&
    (auth.session.role !== "sales" ||
      !auth.permissions.includes("estimator:read"))
  )
    return null;
  const readMode = estimatorReadOnly ? "any" : jobReadMode(auth);
  const assignment = await activeNativeAssignmentForJob(
    env,
    auth,
    jobName,
    readMode,
  );
  if (readMode === "assigned" && !assignment) return null;
  const offset = parseProofCursor(cursor);
  if (offset === null) return null;
  const nativeJobCore = await readNativeJobCore(
    env,
    auth.session.tenant_id,
    jobName,
  );
  if (
    !nativeJobCore ||
    !ACTIVE_JOB_STATUSES.includes(
      nativeJobStatusLabel(nativeJobCore.job.job_status) as never,
    )
  )
    return null;
  const workPackage = assignment
    ? await nativeFieldWorkPackageForAssignment(
        env,
        auth.session.tenant_id,
        jobName,
        text(assignment.name)!,
      )
    : null;
  const nativeEvidence =
    assignment && workPackage
      ? await nativeWorkPackageProofRows(
          env,
          auth.session.tenant_id,
          jobName,
          text(assignment.name)!,
          workPackage,
        )
      : [];
  if (nativeEvidence === null) throw new Error("native_job_proof_unavailable");
  const pageRows = nativeEvidence.slice(
    offset,
    offset + FIELD_PACKET_PROOF_PAGE_SIZE,
  );
  return {
    ...envelope(
      auth,
      [
        nativeOperatingJobRow(nativeJobCore.job),
        ...(assignment ? [assignment] : []),
        ...pageRows,
      ],
      !assignment || !workPackage
        ? ["proof_stream.native_scope_unavailable"]
        : [],
    ),
    ...(estimatorReadOnly ? { allowed_actions: ["job.read"] } : {}),
    items: pageRows
      .map(evidenceProofItem)
      .filter(notNull)
      .sort(compareProofItems),
    next_cursor:
      nativeEvidence.length > offset + FIELD_PACKET_PROOF_PAGE_SIZE
        ? String(offset + FIELD_PACKET_PROOF_PAGE_SIZE)
        : null,
  };
}

export interface JobHistoryReadModel extends ReadModelEnvelope {
  field_measurements: FieldMeasurementReadItem[];
  field_measurements_more: boolean;
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
  customer: { display_name: string | null; phone: string | null } | null;
  gates: ReturnType<typeof gateModel>;
  proof: { items: ProofStreamItem[]; next_cursor: string | null };
  /** Whether the live job route will open this job. False once the work is finished. */
  openable: boolean;
  /** True when the evidence read could not run, so an empty stream is not read as "nothing done". */
  proof_unavailable: boolean;
}

export interface JobFieldMeasurementPageReadModel extends ReadModelEnvelope {
  items: FieldMeasurementReadItem[];
  next_cursor: string | null;
  page_size: number;
}

/** A complete, stable history read under the same job/assignment gate as the live packet. */
export async function buildJobFieldMeasurementPageReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
  cursor: FieldMeasurementCursor | null,
): Promise<JobFieldMeasurementPageReadModel | null> {
  if (!validJobName(jobName)) return null;
  const readMode = jobReadMode(auth);
  const assignment = await activeNativeAssignmentForJob(env, auth, jobName);
  if (readMode === "assigned" && !assignment) return null;
  const nativeJobCore = await readNativeJobCore(
    env,
    auth.session.tenant_id,
    jobName,
  );
  if (!nativeJobCore) return null;
  const job = nativeOperatingJobRow(nativeJobCore.job);
  if (
    readMode === "assigned" &&
    !ACTIVE_JOB_STATUSES.includes(text(job.job_status) as never)
  )
    return null;
  const page = await listFieldMeasurementsFromD1(env, {
    tenantId: auth.session.tenant_id,
    jobId: jobName,
    cursor,
  });
  if (!page) throw new Error("field_measurements_native_unavailable");
  const workPackage =
    assignment && auth.session.role === "field"
      ? await nativeFieldWorkPackageForAssignment(
          env,
          auth.session.tenant_id,
          jobName,
          text(assignment.name)!,
        ).catch(() => null)
      : null;
  return {
    ...envelope(auth, [job, ...(assignment ? [assignment] : [])], []),
    allowed_actions: [],
    items: fieldMeasurementReadItems(
      page.items,
      auth,
      text(assignment?.name),
      workPackage,
    ),
    next_cursor: page.nextCursor,
    page_size: FIELD_MEASUREMENT_READ_LIMIT,
  };
}

/**
 * The record of one job in any status, finished included.
 *
 * `buildJobReadModel` is a work plan: it refuses anything outside the two live statuses because
 * everything it carries — the work package, the assignment, the actions — stops existing when the
 * work does. That left a completed job unreachable by any route, so the office had nothing to open
 * when a customer called about a roof done two winters ago.
 *
 * This is the other thing a job is: what happened. It authorizes nothing (`allowed_actions` is
 * deliberately empty), carries no work package and no assignment, and reads its proof through
 * `field_actions.job_id`, which outlives the assignment and release attempt the live proof read is
 * keyed on.
 */
export async function buildJobHistoryReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
  cursor: string | null,
): Promise<JobHistoryReadModel | null> {
  if (!validJobName(jobName)) return null;
  const offset = parseProofCursor(cursor);
  if (offset === null) return null;
  const nativeJobCore = await readNativeJobCore(
    env,
    auth.session.tenant_id,
    jobName,
  );
  if (!nativeJobCore) return null;
  const job = nativeOperatingJobRow(nativeJobCore.job);
  const property = nativePropertyFrappeRow(nativeJobCore.property);
  const customer = nativeCustomerFrappeRow(nativeJobCore.customer);
  const [gateSource, evidence, fieldMeasurements] = await Promise.all([
    nativeProductionGates(env, auth.session.tenant_id, [jobName]),
    listJobEvidenceFromD1(env, {
      tenantId: auth.session.tenant_id,
      jobId: jobName,
      limit: FIELD_PACKET_PROOF_PAGE_SIZE,
      offset,
    }),
    embeddedFieldMeasurements(env, {
      tenantId: auth.session.tenant_id,
      jobId: jobName,
    }),
  ]);
  const gates = gateSource.rows.map(nativeProductionGateFrappeRow);
  const evidenceRows = (evidence?.rows ?? []).map(nativeWorkPackageEvidenceRow);
  const readEnvelope = envelope(
    auth,
    [
      job,
      ...gates,
      ...evidenceRows,
      ...(property ? [property] : []),
      ...(customer ? [customer] : []),
    ],
    [
      ...(gateSource.partial ? ["gates.partial_source"] : []),
      ...(evidence === null ? ["proof_stream.unavailable"] : []),
      ...(fieldMeasurements === null
        ? ["field_measurements.native_unavailable"]
        : []),
    ],
  );
  return {
    ...readEnvelope,
    field_measurements: fieldMeasurementReadItems(
      fieldMeasurements?.items ?? [],
      auth,
      null,
      null,
    ),
    field_measurements_more: fieldMeasurements?.more ?? false,
    // A history read grants nothing. Nothing on this page may be mistaken for a control.
    allowed_actions: [],
    job: {
      id: text(job.name)!,
      roof_job_id: text(job.roof_job_id),
      job_number: text(job.job_number),
      brand: text(job.brand),
      service_type: text(job.service_type),
      status: text(job.job_status),
      address: address(property ?? undefined),
      current_gate_state: text(job.current_gate_state),
    },
    customer: customer
      ? {
          display_name: text(customer.display_name),
          phone: text(customer.phone),
        }
      : null,
    gates: gates.flatMap((row) => gateModel(row, false)),
    proof: {
      items: evidenceRows.map(evidenceProofItem).filter(notNull).sort(compareProofItems),
      next_cursor: evidence?.more
        ? String(offset + FIELD_PACKET_PROOF_PAGE_SIZE)
        : null,
    },
    openable: ACTIVE_JOB_STATUSES.includes(text(job.job_status) as never),
    proof_unavailable: evidence === null,
  };
}

export async function buildOwnerNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<OwnerNowReadModel> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops")
    throw new Error("owner_scope_required");

  const jobSource = await nativeActiveJobs(
    env,
    auth.session.tenant_id,
    undefined,
    OWNER_NOW_SOURCE_LIMIT,
  );
  const jobs = jobSource.rows.map(nativeOperatingJobRow);
  const jobIds = jobSource.rows.map((row) => row.roof_job_id).sort();
  const [
    fieldBlockerSource,
    gateSource,
    incidentSource,
    accountingIntentSource,
    accountingReconciliationSource,
    accountingExceptionSource,
    untriagedLeadSource,
    materialExceptionSource,
    quoteSource,
    unknownJobStopSource,
    unknownWorkPackageStopSource,
  ] = await Promise.all([
    nativeOwnerFieldBlockers(env, auth.session.tenant_id, jobIds),
    nativeProductionGates(
      env,
      auth.session.tenant_id,
      jobIds,
      "blocked",
      OWNER_NOW_SOURCE_LIMIT,
    ),
    nativeOwnerEffectExceptions(env, auth.session.tenant_id),
    nativeOwnerAccountingIntents(env, auth.session.tenant_id, jobIds),
    nativeOwnerAccountingReconciliations(env, auth.session.tenant_id, jobIds),
    nativeOwnerAccountingExceptions(env, auth.session.tenant_id),
    nativeOwnerUntriagedLeads(env, auth.session.tenant_id),
    nativeMaterialExceptions(
      env,
      auth.session.tenant_id,
      jobIds,
      OWNER_NOW_SOURCE_LIMIT,
    ),
    nativeOwnerCommercialQuotes(env, auth.session.tenant_id, jobIds),
    nativeOwnerUnknownJobStops(env, auth.session.tenant_id),
    nativeOwnerUnknownWorkPackageStops(env, auth.session.tenant_id),
  ]);

  const fieldBlockers = fieldBlockerSource.rows.map(
    nativeOwnerFieldBlockerFrappeRow,
  );
  const gates = gateSource.rows.map(nativeProductionGateFrappeRow);
  const incidents = incidentSource.rows.map(
    nativeOwnerEffectExceptionFrappeRow,
  );
  const materialExceptions = materialExceptionSource.rows.map(
    nativeMaterialExceptionFrappeRow,
  );
  const untriagedLeads = untriagedLeadSource.rows.map(nativeOwnerLeadFrappeRow);
  const unknownTriageLeads: FrappeRow[] = [];

  const reconciliationByIntent = new Map<
    string,
    NativeOwnerAccountingReconciliationRow
  >();
  const ambiguousReconciliationIntents = new Set<string>();
  for (const [intentId, rows] of groupedRows(
    accountingReconciliationSource.rows,
    (row) => row.intent_id,
  )) {
    const ordered = [...rows].sort(
      (left, right) =>
        right.decided_at.localeCompare(left.decided_at) ||
        left.reconciliation_id.localeCompare(right.reconciliation_id),
    );
    const latest = ordered[0];
    const latestRows = latest
      ? ordered.filter((row) => row.decided_at === latest.decided_at)
      : [];
    if (latestRows.length === 1) reconciliationByIntent.set(intentId, latest!);
    else if (latestRows.length > 1)
      ambiguousReconciliationIntents.add(intentId);
  }
  const matchedReconciliation = (
    intent: NativeOwnerAccountingIntentRow,
  ): NativeOwnerAccountingReconciliationRow | null => {
    if (accountingReconciliationSource.partial) return null;
    const reconciliation = reconciliationByIntent.get(intent.intent_id);
    const expectedProviderEntity =
      OWNER_ACCOUNTING_PROVIDER_ENTITY[
        intent.kind as keyof typeof OWNER_ACCOUNTING_PROVIDER_ENTITY
      ];
    if (
      !reconciliation ||
      ambiguousReconciliationIntents.has(intent.intent_id) ||
      !expectedProviderEntity ||
      intent.provider_entity_type !== expectedProviderEntity ||
      !nativeOwnerAccountingMoney(intent) ||
      intent.state !== "reconciled" ||
      reconciliation.verdict !== "reconciled" ||
      reconciliation.expected_sha256 !== intent.expected_sha256 ||
      reconciliation.observed_sha256 !== intent.expected_sha256 ||
      !intent.provider_entity_type ||
      !intent.provider_entity_id ||
      !intent.provider_submitted_at ||
      !intent.provider_reconciled_at
    )
      return null;
    const submittedAt = Date.parse(intent.provider_submitted_at);
    const decidedAt = Date.parse(reconciliation.decided_at);
    const reconciledAt = Date.parse(intent.provider_reconciled_at);
    return Number.isFinite(submittedAt) &&
      Number.isFinite(decidedAt) &&
      Number.isFinite(reconciledAt) &&
      submittedAt <= decidedAt &&
      decidedAt <= reconciledAt
      ? reconciliation
      : null;
  };
  const milestoneType = (kind: string): string | null =>
    kind === "deposit_invoice" ||
    kind === "progress_invoice" ||
    kind === "final_invoice"
      ? "Invoice"
      : kind === "credit_memo"
        ? "Credit"
        : kind === "payment"
          ? "Payment"
          : kind === "refund"
            ? "Refund"
            : null;
  const accountingRows = accountingIntentSource.rows.flatMap((intent) => {
    const type = milestoneType(intent.kind);
    if (!type) return [];
    const money = nativeOwnerAccountingMoney(intent);
    const reconciliation = matchedReconciliation(intent);
    return [
      {
        name: intent.intent_id,
        payment_milestone_id: intent.intent_id,
        roof_job: intent.roof_job_id,
        milestone_type: type,
        status: reconciliation ? "Matched" : "Needs Review",
        subtotal: money?.subtotal ?? intent.subtotal,
        total_amount: money?.totalAmount ?? intent.total_amount,
        currency: intent.currency,
        qb_entity_type: intent.provider_entity_type,
        qb_entity_id: intent.provider_entity_id,
        recognition_posted_at: intent.provider_submitted_at,
        truth_at: intent.provider_reconciled_at,
        truth_source: reconciliation ? "QuickBooks" : null,
        recognition_digest: reconciliation ? intent.expected_sha256 : null,
        recognition_reconciliation: reconciliation?.reconciliation_id ?? null,
        notes:
          intent.reason_code ??
          intent.blocker_code ??
          intent.error_code ??
          (money ? null : "accounting_money_sign_invalid"),
        modified: intent.updated_at,
      } satisfies FrappeRow,
    ];
  });
  const economicsReconciliations = accountingIntentSource.rows.flatMap(
    (intent) => {
      const reconciliation = matchedReconciliation(intent);
      return reconciliation
        ? [
            {
              name: reconciliation.reconciliation_id,
              reconciliation_id: reconciliation.reconciliation_id,
              roof_job: intent.roof_job_id,
              status: "Matched",
              system_name: "QuickBooks",
              entity_type: intent.provider_entity_type,
              external_entity_id: intent.provider_entity_id,
              local_doctype: "Payment Milestone",
              local_name: intent.intent_id,
              currency: intent.currency,
              source_payload_hash: reconciliation.observed_sha256,
              detected_at: reconciliation.decided_at,
              modified: reconciliation.decided_at,
            } satisfies FrappeRow,
          ]
        : [];
    },
  );

  const explicitFinanceIntentIds = new Set(
    accountingExceptionSource.rows.map((row) => row.intent_id).filter(notNull),
  );
  const payments: FrappeRow[] = [
    ...accountingExceptionSource.rows.map((row): FrappeRow => ({
      name: row.exception_id,
      payment_milestone_id: row.exception_id,
      roof_job: row.roof_job_id,
      milestone_type: "Accounting exception",
      status: salesStatus(row.status),
      notes: row.reason_code,
      event_ts: row.opened_at,
      modified: row.updated_at,
    })),
    ...accountingIntentSource.rows
      .filter(
        (row) =>
          !explicitFinanceIntentIds.has(row.intent_id) &&
          (OWNER_FINANCE_ATTENTION_STATES.has(row.state) ||
            (row.state === "reconciled" && !matchedReconciliation(row))),
      )
      .map((row): FrappeRow => ({
        name: row.intent_id,
        payment_milestone_id: row.intent_id,
        roof_job: row.roof_job_id,
        milestone_type: salesStatus(row.kind),
        status: salesStatus(row.state),
        notes:
          row.reason_code ??
          row.blocker_code ??
          row.error_code ??
          (row.state === "reconciled"
            ? "reconciliation_evidence_incomplete"
            : null),
        event_ts: row.updated_at,
        modified: row.updated_at,
      })),
  ];

  const currentQuotesByJob = new Map<string, CommercialQuoteRecord[]>();
  for (const [jobId, rows] of groupedRows(
    quoteSource.rows,
    (row) => row.roof_job_id,
  )) {
    const superseded = new Set(
      rows.map((row) => row.supersedes_quote_revision_id).filter(notNull),
    );
    currentQuotesByJob.set(
      jobId,
      rows.filter(
        (row) =>
          row.status === "approved" && !superseded.has(row.quote_revision_id),
      ),
    );
  }
  const ownerEconomicsPartialSources = [
    ...(quoteSource.partial ? ["economics.customer_quotes"] : []),
    ...(accountingIntentSource.partial ? ["economics.payment_milestones"] : []),
    ...(accountingReconciliationSource.partial
      ? ["economics.accounting_reconciliations"]
      : []),
  ];
  const rowsForEconomicsJob = (rows: FrappeRow[], jobId: string) =>
    rows.filter((row) => text(row.roof_job) === jobId);
  const economics = jobIds.map((jobId) => {
    const quoteCandidates = currentQuotesByJob.get(jobId) ?? [];
    const selectedQuotes =
      !quoteSource.partial && quoteCandidates.length === 1
        ? quoteCandidates.map(nativeOwnerQuoteFrappeRow)
        : [];
    const projection = buildJobEconomicsProjection({
      tenantId: auth.session.tenant_id,
      jobId,
      customerQuotes: selectedQuotes,
      changeOrders: [],
      supplierQuotes: [],
      supplierOrders: [],
      materialLots: [],
      shopOrders: [],
      fieldCheckins: [],
      paymentMilestones: rowsForEconomicsJob(accountingRows, jobId),
      costEvents: [],
      accountingReconciliations: rowsForEconomicsJob(
        economicsReconciliations,
        jobId,
      ),
      partialSources: ownerEconomicsPartialSources,
    });
    for (const metric of [
      "forecast_cost",
      "committed_cost",
      "accrued_actual_cost",
      "posted_actual_cost",
    ] as const) {
      projection.metrics[metric] = {
        known_cents: null,
        complete: false,
        source_count: 0,
      };
    }
    projection.source_coverage.customer_quotes = quoteCandidates.length;
    if (quoteSource.partial || quoteCandidates.length !== 1) {
      projection.metrics.forecast_revenue = {
        known_cents: null,
        complete: false,
        source_count: quoteCandidates.length,
      };
    }
    const gaps = new Set([
      ...projection.reconciliation_gaps,
      ...OWNER_ECONOMICS_NATIVE_UNAVAILABLE.map(
        (source) => `${source}.native_unavailable`,
      ),
    ]);
    if (quoteCandidates.length > 1)
      gaps.add("customer_quote.selection_ambiguous");
    for (const intent of accountingIntentSource.rows) {
      if (
        intent.roof_job_id === jobId &&
        ambiguousReconciliationIntents.has(intent.intent_id)
      )
        gaps.add(
          `accounting_reconciliation.selection_ambiguous:${intent.intent_id}`,
        );
    }
    projection.reconciliation_gaps = [...gaps].sort();
    projection.state = Object.values(projection.metrics).some(
      (metric) => "known_cents" in metric && metric.known_cents === null,
    )
      ? "incomplete"
      : projection.reconciliation_gaps.length > 0
        ? "needs_review"
        : "complete";
    return projection;
  });

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
        title: "Field work stopped",
        why: text(row.blocker_summary),
        jobId: text(row.roof_job),
        occurredAt: text(row.submitted_at),
      }),
    ),
    // The stop holds Safety on every job while it is active; the item names who raised it, when,
    // and what they wrote.
    ...unknownJobStopSource.rows.flatMap((row) =>
      exceptionRow({}, {
        id: row.occurrence_id,
        kind: "stop_job_unknown",
        severity: null,
        title: STOP_JOB_UNKNOWN_TITLE,
        why: STOP_JOB_UNKNOWN_WHY,
        jobId: null,
        occurredAt: row.reported_at,
        reportedByName: text(row.reported_by_name),
        summary: row.summary,
      }),
    ),
    // So does a stop naming a Work Package the tenant does not have (0159).
    ...unknownWorkPackageStopSource.rows.flatMap((row) =>
      exceptionRow({}, {
        id: row.occurrence_id,
        kind: "stop_work_package_unknown",
        severity: null,
        title: STOP_WORK_PACKAGE_UNKNOWN_TITLE,
        why: `Names work package ${row.scope_id}`,
        jobId: null,
        occurredAt: row.reported_at,
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
        severity: null,
        title: `${salesStatus(text(row.action)) ?? "Automation"} needs reconciliation`,
        why:
          [text(row.provider), text(row.reason_code)]
            .filter(notNull)
            .join(" · ") || null,
        jobId: text(row.roof_job),
        occurredAt: text(row.detected_at),
      }),
    ),
    ...materialExceptions.flatMap((row) =>
      exceptionRow(row, {
        id: text(row.name),
        kind: "material_exception",
        severity: null,
        title: `${salesStatus(text(row.exception_type)) ?? "Material"} exception`,
        why: text(row.reason_code) ?? text(row.status),
        jobId: text(row.roof_job),
        occurredAt: text(row.created_at),
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
  const partialSources = [
    ...(jobSource.partial ? ["active_jobs"] : []),
    ...(fieldBlockerSource.partial ? ["field_blockers"] : []),
    ...(unknownJobStopSource.partial ? ["unknown_job_stops"] : []),
    ...(unknownWorkPackageStopSource.partial ? ["unknown_work_package_stops"] : []),
    ...(gateSource.partial ? ["blocked_gates"] : []),
    ...(incidentSource.partial ? ["automation_incidents"] : []),
    ...(accountingIntentSource.partial ||
    accountingReconciliationSource.partial ||
    accountingExceptionSource.partial
      ? ["finance_exceptions"]
      : []),
    ...(untriagedLeadSource.partial ? ["untriaged_leads"] : []),
    ...(materialExceptionSource.partial ? ["material_exceptions"] : []),
    ...ownerEconomicsPartialSources,
  ];
  const stale = [
    "exceptions.next_action",
    ...OWNER_ECONOMICS_NATIVE_UNAVAILABLE.map(
      (source) => `economics.${source}.native_unavailable`,
    ),
  ];
  if (exceptions.some((row) => row.due_at === null))
    stale.push("exceptions.due_at");
  if (exceptions.some((row) => row.why === null)) stale.push("exceptions.why");
  if (exceptions.some((row) => row.occurred_at === null))
    stale.push("exceptions.occurred_at");
  if (fieldBlockerSource.rows.some((row) => row.manifest_key === null))
    stale.push("field_blockers.evidence");
  if (partialSources.length > 0) stale.push("exceptions.partial_sources");
  return {
    ...envelope(
      auth,
      [
        ...jobs,
        ...fieldBlockers,
        ...[...unknownJobStopSource.rows, ...unknownWorkPackageStopSource.rows].map((row) => ({
          name: row.occurrence_id,
          modified: row.updated_at,
        })),
        ...gates,
        ...incidents,
        ...payments,
        ...leadRows,
        ...materialExceptions,
        ...quoteSource.rows.map(nativeOwnerQuoteFrappeRow),
        ...accountingRows,
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
      material_exceptions: materialExceptions.length,
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
  leadId?: string,
): Promise<SalesReadModel> {
  if (!auth.permissions.includes("sales:read"))
    throw new Error("office_scope_required");

  const sources = await readCommercialSalesSources(
    env,
    auth.session.tenant_id,
    SALES_SOURCE_LIMIT,
    leadId,
  );
  const jobsByLead = firstRowsBy(sources.jobs, (row) => row.lead_id);
  const estimatesByLead = firstRowsBy(sources.estimates, (row) => row.lead_id);
  const triageByLead = firstRowsBy(
    sources.triageDecisions,
    (row) => row.lead_id,
  );
  const quotesByJob = firstRowsBy(sources.quotes, (row) => row.roof_job_id);
  const proposalsByQuote = firstRowsBy(
    sources.proposals,
    (row) => row.quote_revision_id,
  );
  const publicationsByPack = firstRowsBy(
    sources.publications,
    (row) => row.proposal_pack_id,
  );
  const acceptancesByQuote = firstRowsBy(
    sources.acceptances,
    (row) => row.quote_revision_id,
  );
  const acceptancesByProposal = firstRowsBy(
    sources.acceptances,
    (row) => row.proposal_revision_id,
  );
  const consentsByLead = groupedRows(sources.consents, (row) => row.lead_id);
  const partialSourceSet = new Set(sources.partialSources);
  const consentSourcePartial = partialSourceSet.has("operating_consents");

  const shaped: SalesReadModel["leads"] = sources.leads
    .map((lead) => {
      const linkedJob = jobsByLead.get(lead.lead_id) ?? null;
      const estimateRow = estimatesByLead.get(lead.lead_id);
      const estimate = nativeSalesEstimate(estimateRow);
      const quoteRow = linkedJob
        ? quotesByJob.get(linkedJob.roof_job_id)
        : undefined;
      const quoteAcceptance = quoteRow
        ? acceptancesByQuote.get(quoteRow.quote_revision_id)
        : undefined;
      const quote = nativeSalesQuote(quoteRow, quoteAcceptance);
      const proposalRow = quoteRow
        ? proposalsByQuote.get(quoteRow.quote_revision_id)
        : undefined;
      const publication = proposalRow
        ? publicationsByPack.get(proposalRow.proposal_pack_id)
        : undefined;
      const proposalAcceptance = proposalRow
        ? acceptancesByProposal.get(proposalRow.proposal_revision_id)
        : undefined;
      const triage = triageByLead.get(lead.lead_id);
      const jobPartial =
        !linkedJob && partialSourceSet.has("operating_roof_jobs");
      const estimatePartial =
        !estimateRow && partialSourceSet.has("operating_instant_estimates");
      const triagePartial =
        !triage && partialSourceSet.has("commercial_lead_triage_decisions");
      const quotePartial =
        jobPartial ||
        Boolean(
          linkedJob &&
          !quoteRow &&
          partialSourceSet.has("commercial_quote_revisions"),
        );
      const proposalPartial =
        quotePartial ||
        Boolean(
          quoteRow &&
          !proposalRow &&
          partialSourceSet.has("commercial_proposal_revisions"),
        );
      const publicationPartial =
        proposalPartial ||
        Boolean(
          proposalRow &&
          !publication &&
          partialSourceSet.has("commercial_proposal_publication_events"),
        );
      const quoteAcceptancePartial =
        quotePartial ||
        Boolean(
          quoteRow &&
          !quoteAcceptance &&
          partialSourceSet.has("commercial_acceptance_bindings"),
        );
      const proposalAcceptancePartial =
        proposalPartial ||
        Boolean(
          proposalRow &&
          !proposalAcceptance &&
          partialSourceSet.has("commercial_acceptance_bindings"),
        );
      const partialFields: SalesPartialField[] = [
        ...(jobPartial ? ["job" as const] : []),
        ...(triagePartial ? ["triage_decision" as const] : []),
        ...(estimatePartial ? ["estimate" as const] : []),
        ...(quotePartial ? ["quote" as const] : []),
        ...(proposalPartial ? ["proposal" as const] : []),
        ...(publicationPartial ? ["proposal_publication" as const] : []),
        ...(quoteAcceptancePartial ? ["quote_acceptance" as const] : []),
        ...(proposalAcceptancePartial ? ["proposal_acceptance" as const] : []),
      ];
      const proposal = nativeSalesProposal(
        proposalRow,
        publication,
        proposalAcceptance,
        publicationPartial,
      );
      const triageStatus = salesStatus(lead.lifecycle_status);
      const consentRecords = (consentsByLead.get(lead.lead_id) ?? []).map(
        nativeSalesConsent,
      );
      return {
        id: lead.lead_id,
        envelope_id: lead.source_envelope_id,
        source: lead.source,
        received_at: lead.created_at,
        transport_status: null,
        intent_queue: null,
        contact: {
          display_name: lead.contact_name,
          phone: lead.contact_phone,
          email: lead.contact_email,
        },
        triage: {
          status: triageStatus,
          summary: triage?.summary ?? null,
          version: lead.version,
        },
        job: linkedJob
          ? {
              id: linkedJob.roof_job_id,
              job_number: linkedJob.job_number,
              status: salesStatus(linkedJob.job_status),
              service_type: linkedJob.service_type,
              workflow_profile: null,
            }
          : null,
        estimate,
        quote,
        proposal,
        consent: {
          context: consentSourcePartial
            ? ("partial" as const)
            : consentRecords.length > 0
              ? ("recorded" as const)
              : ("no_linked_record" as const),
          records: consentRecords,
        },
        partial_fields: partialFields,
        attention: salesAttention(triageStatus, estimate, quote, partialFields),
      };
    })
    .sort(compareSalesLead);

  const partialSources = sources.partialSources;
  const base = envelope(
    auth,
    nativeSalesEnvelopeRows(sources),
    partialSources.length > 0 ? ["sales.partial_sources"] : [],
  );
  const actorType = auth.session.role === "owner" ? "owner" : "worker";
  const leadTriageAvailable = Boolean(
    auth.permissions.includes("approvals:prepare") &&
    commercialActionConfigured(
      env,
      auth.session.tenant_id,
      "lead.triage.record",
      actorType,
    ),
  );
  return {
    ...base,
    allowed_actions: [
      ...base.allowed_actions,
      ...(auth.permissions.includes("approvals:read") ? ["approval.read"] : []),
      ...(leadTriageAvailable ? ["commercial.lead_triage.record"] : []),
      ...(auth.permissions.includes("estimator:read")
        ? ["estimator.read"]
        : []),
      ...(auth.permissions.includes("sales:lead_create")
        ? ["sales.lead.create"]
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
  const [nativeSources, nativeCommercial] = await Promise.all([
    readNativeEstimatorSources(env, auth.session.tenant_id, jobName, asOf),
    readNativeCommercialJobPacket(
      env,
      auth.session.tenant_id,
      jobName,
      ESTIMATOR_SOURCE_LIMIT,
    ),
  ]);
  if (!nativeSources) return null;
  const job = nativeSources.job;
  const jobId = text(job.name);
  if (!jobId) return null;
  const insuranceAccessGranted = hasRestrictedInsuranceAccess(auth);
  const measurementRows = nativeSources.measurementRows;
  const visualModelRows = nativeSources.visualModelRows;
  const roofAreaRows = nativeSources.roofAreaRows;
  const takeoffRows = nativeSources.takeoffRows;
  const commercialSelection = nativeCommercial
    ? nativeEstimatorCommercialSelection(nativeCommercial, asOf)
    : { quoteRows: [], proposalRows: [], staleFields: [] };
  const quoteRows = nativeSources.staleFields.includes(
    "estimator_evidence.commercial_quote_drift",
  )
    ? []
    : commercialSelection.quoteRows;
  const proposalRows = nativeSources.staleFields.includes(
    "estimator_evidence.commercial_quote_drift",
  )
    ? []
    : commercialSelection.proposalRows;
  const changeOrderRows = nativeSources.changeOrderRows;
  const supplierQuoteRows = nativeSources.supplierQuoteRows;
  const supplierOrderRows = nativeSources.supplierOrderRows;
  const materialLotRows = nativeSources.materialLotRows;
  const shopOrderRows = nativeSources.shopOrderRows;
  const fieldCheckinRows = nativeSources.fieldCheckinRows;
  const paymentMilestoneRows = nativeSources.paymentMilestoneRows;
  const jobCostEventRows = nativeSources.jobCostEventRows;
  const accountingReconciliationRows =
    nativeSources.accountingReconciliationRows;
  const insuranceSupplementRows = insuranceAccessGranted
    ? nativeSources.insuranceSupplementRows
    : [];
  const scopeRows = nativeSources.scopeRows;
  const pricingAuthorityRows = nativeSources.pricingAuthorityRows;

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
  const measurementRead = {
    row: selectedMeasurementRow,
    unavailable_reason: null,
  };
  const visualModelRead = {
    row: selectedVisualModelRow,
    unavailable_reason: null,
  };
  const takeoffRead = { row: selectedTakeoffRow, unavailable_reason: null };
  const insuranceSupplementReads = insuranceSupplementRows.map((row) => ({
    name: text(row.name),
    read: { row, unavailable_reason: null },
  }));
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
    ? await estimatorGeometryFromRaw(
        env,
        text(measurementDetail.raw_key),
        geometryCapture,
      )
    : unavailableEstimatorGeometry(
        selectedMeasurementRow
          ? (measurementDetailIssue ?? "measurement_detail_unavailable")
          : "no_measurement_report",
      );
  const roofGraph = estimatorRoofGraphProjection(measurementDetail);
  // Measurement-to-money projection: recomputed takeoff over the same verified
  // model, priced only when the tenant supplies a price list.
  const computedTakeoff = estimatorComputedTakeoff(
    geometryCapture.model ?? null,
  );
  // Saved imports keep their own authority, even after a catalog cutover or
  // rollback. Only an import without authority uses the old environment preview.
  let configuredPriceList: EstimatorPriceList = { state: "unconfigured" };
  let pricingAuthority: VerifiedPricingAuthority | undefined;
  let pricingInstant = readModelGeneratedAt;
  if (pricingAuthorityRows.length === 1) {
    try {
      const rule = pricingAuthorityRows[0];
      const pinned = rule.catalog_revision_id
        ? await resolveFrozenCatalogPricing(
            env,
            auth.session.tenant_id,
            rule,
            nativeSources.estimatorRevisionId,
          )
        : await resolveFrozenLegacyPricing(
            auth.session.tenant_id,
            rule,
            nativeSources.estimatorCreatedAt,
          );
      if (!pinned) throw new Error("pricing_authority_missing");
      configuredPriceList = { state: "ok", list: pinned.list };
      pricingAuthority = pinned.authority;
      pricingInstant = pinned.pricedAt;
    } catch { configuredPriceList = { state: "invalid" }; }
  } else if (pricingAuthorityRows.length > 1) configuredPriceList = { state: "invalid" };
  else if (!pricingCatalogEnabled(env))
    configuredPriceList = estimatorPriceList(env, readModelGeneratedAt);
  const computedEstimate = estimatorComputedEstimate(configuredPriceList, computedTakeoff.takeoff, pricingInstant, pricingAuthority);
  const staleFields: string[] = [
    ...nativeSources.staleFields,
    ...commercialSelection.staleFields,
  ];
  if (selectedMeasurementRow && !measurementDetail)
    staleFields.push("measurements.selected_detail");
  if (selectedTakeoffRow && !takeoffDetail)
    staleFields.push("takeoffs.selected_detail");
  if (quoteRows.length > 0) {
    staleFields.push("quote_revision.scope_summary.native_unavailable");
    staleFields.push("quote_revision.assumptions.native_unavailable");
    staleFields.push("quote_revision.exclusions.native_unavailable");
  }
  if (proposalRows.length > 0) {
    staleFields.push("proposal.assumptions.native_unavailable");
    staleFields.push("proposal.exclusions.native_unavailable");
  }
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
  const partialSources = [
    ...nativeSources.partialSources,
    ...sourceRows.flatMap(([name, rows]) =>
      rows.length === ESTIMATOR_SOURCE_LIMIT ? [name] : [],
    ),
  ];
  if (nativeCommercial) {
    if (
      nativeCommercial.partial_sources.includes("commercial_quote_revisions")
    ) {
      partialSources.push("customer_quotes");
    }
    if (
      nativeCommercial.partial_sources.includes("commercial_proposal_revisions")
    ) {
      partialSources.push("proposal_evidence_packs");
    }
    if (
      nativeCommercial.partial_sources.includes(
        "commercial_proposal_publication_events",
      )
    ) {
      partialSources.push("proposal_evidence_packs");
    }
    if (
      nativeCommercial.partial_sources.includes(
        "commercial_acceptance_bindings",
      )
    ) {
      partialSources.push("customer_quotes", "proposal_evidence_packs");
    }
  }
  if (pricingAuthorityRows.length === ESTIMATOR_PRICING_AUTHORITY_LIMIT) {
    partialSources.push("pricing_authority");
  }
  const uniquePartialSources = [...new Set(partialSources)];
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
    partialSources: uniquePartialSources,
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
    approvalDecisionConfig(env),
  );
  const facetLaunchAvailable = Boolean(
    auth.permissions.includes("facet:launch") &&
    quote &&
    selectedQuoteName === text(job.quotation) &&
    quote.version !== null &&
    quote.version > 0 &&
    quote.status === "Approved" &&
    quote.approved_at &&
    !quote.accepted_at &&
    facetLaunchConfigured(env, auth.session.tenant_id),
  );
  return {
    ...base,
    allowed_actions: [
      ...base.allowed_actions,
      "estimator.read",
      ...(auth.session.role === "owner" && env.DB && env.RAW
        ? ["estimator.import"]
        : []),
      ...(quoteRevisionPreparationAvailable
        ? ["quote_revision_approval.prepare"]
        : []),
      ...(facetLaunchAvailable ? ["facet_launch.create"] : []),
    ],
    partial_sources: uniquePartialSources,
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

async function boundedNativeRows<T>(
  env: AppEnv,
  sql: string,
  bindings: readonly unknown[],
  limit: number,
): Promise<{ rows: T[]; partial: boolean }> {
  const result = await env.DB.prepare(`${sql} LIMIT ?`)
    .bind(...bindings, limit + 1)
    .all<T>();
  const rows = result.results ?? [];
  return { rows: rows.slice(0, limit), partial: rows.length > limit };
}

async function nativeActiveJobs(
  env: AppEnv,
  tenantId: string,
  jobIds?: readonly string[],
  limit = PRODUCTION_SOURCE_LIMIT,
): Promise<{ rows: NativeProductionJobRow[]; partial: boolean }> {
  if (jobIds?.length === 0) return { rows: [], partial: false };
  const selected = [...new Set(jobIds ?? [])].slice(0, PRODUCTION_SOURCE_LIMIT);
  return await boundedNativeRows<NativeProductionJobRow>(
    env,
    `SELECT roof_job_id, customer_id, property_id, brand, job_number, service_type,
            job_status, current_gate_state, version, updated_at
       FROM operating_roof_jobs
      WHERE tenant_id = ?
        AND job_status IN ('qualified', 'in_progress')
        ${jobIds ? `AND roof_job_id IN (${selected.map(() => "?").join(", ")})` : ""}
      ORDER BY updated_at DESC, roof_job_id ASC`,
    [tenantId, ...selected],
    limit,
  );
}

async function nativeProductionGates(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
  state?: string,
  limit = PRODUCTION_SOURCE_LIMIT * SCHEDULING_PRODUCTION_GATES.length,
): Promise<{ rows: NativeProductionGateRow[]; partial: boolean }> {
  const selected = [...new Set(jobIds)].slice(0, PRODUCTION_SOURCE_LIMIT);
  if (selected.length === 0) return { rows: [], partial: false };
  return await boundedNativeRows<NativeProductionGateRow>(
    env,
    `SELECT gate.gate_id, gate.roof_job_id, gate.gate, gate.state, gate.blocker_reason,
            gate.owner_user, gate.assigned_at, gate.due_at, gate.updated_at,
            entry.basis AS basis_in_force
       FROM operating_production_gates gate
       LEFT JOIN production_gate_clearances entry
         ON entry.tenant_id = gate.tenant_id AND entry.clearance_id = gate.clearance_decision_id
      WHERE gate.tenant_id = ?
        AND gate.roof_job_id IN (${selected.map(() => "?").join(", ")})
        ${state ? "AND gate.state = ?" : ""}
      ORDER BY gate.roof_job_id ASC, gate.gate ASC, gate.updated_at DESC, gate.gate_id ASC`,
    [tenantId, ...selected, ...(state ? [state] : [])],
    limit,
  );
}

async function nativeProperties(
  env: AppEnv,
  tenantId: string,
  propertyIds: readonly string[],
): Promise<{ rows: NativePropertyRecord[]; partial: boolean }> {
  const selected = [...new Set(propertyIds)].slice(0, PRODUCTION_SOURCE_LIMIT);
  if (selected.length === 0) return { rows: [], partial: false };
  return await boundedNativeRows<NativePropertyRecord>(
    env,
    `SELECT property_id, address_line1, city, province, postal_code, country, updated_at
       FROM operating_properties
      WHERE tenant_id = ?
        AND property_id IN (${selected.map(() => "?").join(", ")})
      ORDER BY property_id ASC`,
    [tenantId, ...selected],
    PRODUCTION_SOURCE_LIMIT,
  );
}

async function nativeProductionCrews(
  env: AppEnv,
  tenantId: string,
): Promise<{ rows: NativeProductionCrewRow[]; partial: boolean }> {
  return await boundedNativeRows<NativeProductionCrewRow>(
    env,
    `SELECT crew_id, display_name, version, updated_at
       FROM fleet_crews
      WHERE tenant_id = ? AND status = 'Active'
      ORDER BY display_name ASC, crew_id ASC`,
    [tenantId],
    PRODUCTION_SOURCE_LIMIT,
  );
}

async function nativeMaterialExceptions(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
  limit = PRODUCTION_SOURCE_LIMIT,
): Promise<{ rows: NativeMaterialExceptionRow[]; partial: boolean }> {
  const selected = [...new Set(jobIds)].slice(0, PRODUCTION_SOURCE_LIMIT);
  if (selected.length === 0) return { rows: [], partial: false };
  return await boundedNativeRows<NativeMaterialExceptionRow>(
    env,
    `SELECT exception_id, aggregate_id, exception_type, status, reason_code,
            created_at, updated_at
       FROM inventory_exceptions
      WHERE tenant_id = ?
        AND aggregate_type = 'roof_job'
        AND aggregate_id IN (${selected.map(() => "?").join(", ")})
        AND status IN ('open', 'contained')
      ORDER BY updated_at DESC, exception_id ASC`,
    [tenantId, ...selected],
    limit,
  );
}

async function nativeOwnerFieldBlockers(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
): Promise<{ rows: NativeOwnerFieldBlockerRow[]; partial: boolean }> {
  const selected = [...new Set(jobIds)].slice(0, OWNER_NOW_SOURCE_LIMIT);
  if (selected.length === 0) return { rows: [], partial: false };
  return await boundedNativeRows<NativeOwnerFieldBlockerRow>(
    env,
    `SELECT package.work_package_id, package.version, package.job_id,
            stopped.event_id AS stop_event_id,
            json_extract(stopped.payload_json, '$.blocker_reason') AS blocker_reason,
            stopped.occurred_at, stopped.manifest_key, package.updated_at
       FROM work_packages AS package
       LEFT JOIN work_package_events AS stopped
         ON stopped.tenant_id = package.tenant_id
        AND stopped.work_package_id = package.work_package_id
        AND stopped.work_package_version = package.version
        AND stopped.event_kind = 'stop_work'
        AND NOT EXISTS (
          SELECT 1 FROM work_package_events AS later
           WHERE later.tenant_id = stopped.tenant_id
             AND later.work_package_id = stopped.work_package_id
             AND later.work_package_version = stopped.work_package_version
             AND later.event_kind = 'stop_work'
             AND (later.occurred_at > stopped.occurred_at
               OR (later.occurred_at = stopped.occurred_at
                 AND later.event_id > stopped.event_id))
        )
      WHERE package.tenant_id = ? AND package.status = 'Blocked'
        AND package.job_id IN (${selected.map(() => "?").join(", ")})
      ORDER BY package.updated_at DESC, package.work_package_id ASC`,
    [tenantId, ...selected],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

/**
 * Active safety stops that name a job this tenant does not have. Recording a stop never fails, so
 * a mistyped job is caught here: such a stop holds Safety on every job (0158) until it is opened
 * and fixed or lifted.
 */
async function nativeOwnerUnknownJobStops(
  env: AppEnv,
  tenantId: string,
): Promise<{ rows: NativeOwnerUnknownStopRow[]; partial: boolean }> {
  return await boundedNativeRows<NativeOwnerUnknownStopRow>(
    env,
    `SELECT occurrence.occurrence_id, occurrence.reported_at, occurrence.summary,
            reporter.display_name AS reported_by_name, occurrence.updated_at
       FROM safety_occurrences AS occurrence
       LEFT JOIN app_users AS reporter
         ON reporter.tenant_id = occurrence.tenant_id
        AND reporter.user_id = occurrence.reported_by_user_id
      WHERE occurrence.tenant_id = ?
        AND occurrence.stop_active = 1
        AND occurrence.scope_type = 'roof_job'
        AND NOT EXISTS (
          SELECT 1 FROM operating_roof_jobs AS job
           WHERE job.tenant_id = occurrence.tenant_id AND job.roof_job_id = occurrence.scope_id
        )
      ORDER BY occurrence.reported_at ASC, occurrence.occurrence_id ASC`,
    [tenantId],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

/**
 * Active safety stops that name a Work Package this tenant does not have. Like a stop on a job that
 * doesn't exist, such a stop is recorded and holds Safety on every job (0159) until it is opened
 * and fixed or lifted.
 */
async function nativeOwnerUnknownWorkPackageStops(
  env: AppEnv,
  tenantId: string,
): Promise<{ rows: Array<NativeOwnerUnknownStopRow & { scope_id: string }>; partial: boolean }> {
  return await boundedNativeRows<NativeOwnerUnknownStopRow & { scope_id: string }>(
    env,
    `SELECT occurrence.occurrence_id, occurrence.scope_id, occurrence.reported_at,
            occurrence.summary, reporter.display_name AS reported_by_name, occurrence.updated_at
       FROM safety_occurrences AS occurrence
       LEFT JOIN app_users AS reporter
         ON reporter.tenant_id = occurrence.tenant_id
        AND reporter.user_id = occurrence.reported_by_user_id
      WHERE occurrence.tenant_id = ?
        AND occurrence.stop_active = 1
        AND occurrence.scope_type = 'work_package'
        AND NOT EXISTS (
          SELECT 1 FROM work_packages AS package
           WHERE package.tenant_id = occurrence.tenant_id
             AND package.work_package_id = occurrence.scope_id
        )
      ORDER BY occurrence.reported_at ASC, occurrence.occurrence_id ASC`,
    [tenantId],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

async function nativeOwnerEffectExceptions(
  env: AppEnv,
  tenantId: string,
): Promise<{ rows: NativeOwnerEffectExceptionRow[]; partial: boolean }> {
  return await boundedNativeRows<NativeOwnerEffectExceptionRow>(
    env,
    `SELECT exception.exception_id, exception.effect_id, exception.reason_code,
            effect.action, effect.provider, effect.aggregate_type,
            effect.aggregate_id, exception.created_at, effect.updated_at
       FROM external_effect_exceptions AS exception
       JOIN external_effects AS effect
         ON effect.effect_id = exception.effect_id
        AND effect.tenant_id = exception.tenant_id
      WHERE exception.tenant_id = ? AND exception.status = 'open'
      ORDER BY exception.created_at ASC, exception.exception_id ASC`,
    [tenantId],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

async function nativeOwnerUntriagedLeads(
  env: AppEnv,
  tenantId: string,
): Promise<{ rows: OperatingSalesLeadRecord[]; partial: boolean }> {
  return await boundedNativeRows<OperatingSalesLeadRecord>(
    env,
    `SELECT lead_id, tenant_id, source_envelope_id, source_raw_key, source,
            contact_name, contact_phone, contact_email, job_ref,
            lifecycle_status, version, created_at, updated_at
       FROM operating_leads
      WHERE tenant_id = ? AND lifecycle_status = 'untriaged'
      ORDER BY updated_at DESC, version DESC, lead_id ASC`,
    [tenantId],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

async function nativeOwnerCommercialQuotes(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
): Promise<{ rows: CommercialQuoteRecord[]; partial: boolean }> {
  const selected = [...new Set(jobIds)].slice(0, OWNER_NOW_SOURCE_LIMIT);
  if (selected.length === 0) return { rows: [], partial: false };
  return await boundedNativeRows<CommercialQuoteRecord>(
    env,
    `SELECT * FROM commercial_quote_revisions
      WHERE tenant_id = ?
        AND roof_job_id IN (${selected.map(() => "?").join(", ")})
      ORDER BY created_at DESC, revision_number DESC, quote_revision_id ASC`,
    [tenantId, ...selected],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

async function nativeOwnerAccountingIntents(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
): Promise<{ rows: NativeOwnerAccountingIntentRow[]; partial: boolean }> {
  const selected = [...new Set(jobIds)].slice(0, OWNER_NOW_SOURCE_LIMIT);
  if (selected.length === 0) return { rows: [], partial: false };
  return await boundedNativeRows<NativeOwnerAccountingIntentRow>(
    env,
    `SELECT intent_id, roof_job_id, kind, state, currency, subtotal,
            total_amount, expected_sha256, provider_entity_type,
            provider_entity_id, blocker_code, blocker_next_step, reason_code,
            error_code, provider_submitted_at, provider_reconciled_at, updated_at
       FROM accounting_intents
      WHERE tenant_id = ?
        AND roof_job_id IN (${selected.map(() => "?").join(", ")})
        AND kind IN ('deposit_invoice', 'progress_invoice', 'final_invoice',
          'payment', 'credit_memo', 'refund')
      ORDER BY updated_at DESC, intent_id ASC`,
    [tenantId, ...selected],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

async function nativeOwnerAccountingReconciliations(
  env: AppEnv,
  tenantId: string,
  jobIds: readonly string[],
): Promise<{
  rows: NativeOwnerAccountingReconciliationRow[];
  partial: boolean;
}> {
  const selected = [...new Set(jobIds)].slice(0, OWNER_NOW_SOURCE_LIMIT);
  if (selected.length === 0) return { rows: [], partial: false };
  return await boundedNativeRows<NativeOwnerAccountingReconciliationRow>(
    env,
    `SELECT reconciliation.reconciliation_id, reconciliation.intent_id,
            reconciliation.expected_sha256, reconciliation.observed_sha256,
            reconciliation.verdict, reconciliation.reason_code,
            reconciliation.decided_at
       FROM accounting_reconciliations AS reconciliation
       JOIN accounting_intents AS intent
         ON intent.intent_id = reconciliation.intent_id
        AND intent.tenant_id = reconciliation.tenant_id
      WHERE reconciliation.tenant_id = ? AND intent.tenant_id = ?
        AND intent.roof_job_id IN (${selected.map(() => "?").join(", ")})
      ORDER BY reconciliation.decided_at DESC,
               reconciliation.reconciliation_id ASC`,
    [tenantId, tenantId, ...selected],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

async function nativeOwnerAccountingExceptions(
  env: AppEnv,
  tenantId: string,
): Promise<{ rows: NativeOwnerAccountingExceptionRow[]; partial: boolean }> {
  return await boundedNativeRows<NativeOwnerAccountingExceptionRow>(
    env,
    `SELECT exception.exception_id, exception.subject_ref,
            exception.intent_id, exception.reason_code, exception.status,
            intent.roof_job_id, exception.opened_at, exception.updated_at
       FROM accounting_exceptions AS exception
       LEFT JOIN accounting_intents AS intent
         ON intent.intent_id = exception.intent_id
        AND intent.tenant_id = exception.tenant_id
      WHERE exception.tenant_id = ?
        AND exception.status IN ('open', 'acknowledged')
      ORDER BY exception.opened_at ASC, exception.exception_id ASC`,
    [tenantId],
    OWNER_NOW_SOURCE_LIMIT,
  );
}

function nativeOperatingJobRow(row: NativeProductionJobRow): FrappeRow {
  return {
    name: row.roof_job_id,
    roof_job_id: row.roof_job_id,
    roofing_property: row.property_id,
    customer: row.customer_id,
    brand: row.brand,
    job_number: row.job_number,
    service_type: row.service_type,
    job_status: nativeJobStatusLabel(row.job_status),
    current_gate_state: nativeGateStateLabel(row.current_gate_state),
    version: row.version,
    modified: row.updated_at,
  };
}

function nativeOperatingAssignmentRow(
  row: OperatingJobAssignmentRecord,
): FrappeRow {
  return {
    name: row.assignment_id,
    assignment_id: row.assignment_id,
    roof_job: row.roof_job_id,
    assignment_type: "Production",
    status: "Assigned",
    crew_profile: row.crew_id,
    crew_id: row.crew_id,
    crew_version: row.crew_version,
    assignment_version: row.assignment_version,
    roof_job_version: row.roof_job_version,
    assigned_user: row.assigned_users[0] ?? null,
    assigned_workers: row.assigned_users.map((workerUser, index) => ({
      sequence: index + 1,
      worker_user: workerUser,
      worker_role: "Field Worker",
      required: 1,
    })),
    authority_requirements_json: row.authority_requirements_json,
    authority_requirements_sha256: row.authority_requirements_sha256,
    assignment_command_fingerprint: row.command_fingerprint,
    scheduled_start: row.scheduled_start,
    scheduled_end: row.scheduled_end,
    blocker_reason: null,
    source_system: "ironwrap-d1",
    modified: row.created_at,
  };
}

async function nativeTodayAssignments(
  env: AppEnv,
  auth: AuthContext,
): Promise<FrappeRow[]> {
  const actorUsers =
    jobReadMode(auth) === "assigned"
      ? appUserIdentities(auth.session)
      : undefined;
  const [scheduled, typed, packages] = await Promise.all([
    listCurrentOperatingJobAssignments(env, auth.session.tenant_id, {
      ...(actorUsers ? { actorUsers } : {}),
    }),
    listCurrentOperatingWorkObjectAssignments(env, auth.session.tenant_id, {
      ...(actorUsers ? { actorUsers } : {}),
    }),
    nativeAssignments(env, auth.session.tenant_id, {
      ...(actorUsers ? { actorUsers } : {}),
    }),
  ]);
  const assignments = new Map<string, FrappeRow>();
  for (const row of scheduled.map(nativeOperatingAssignmentRow)) {
    const id = text(row.name);
    if (id) assignments.set(id, row);
  }
  for (const row of typed.map(nativeOperatingWorkObjectAssignmentRow)) {
    const id = text(row.name);
    if (id) assignments.set(id, row);
  }
  for (const row of packages) {
    const id = text(row.name);
    const assignment = id ? assignments.get(id) : null;
    if (id && assignment) assignments.set(id, { ...assignment, ...row });
  }
  return [...assignments.values()];
}

function nativeOperatingWorkObjectAssignmentRow(
  row: OperatingWorkObjectAssignmentRecord,
): FrappeRow {
  return {
    name: row.assignment_id,
    assignment_id: row.assignment_id,
    assignment_type: "Production",
    status: "Assigned",
    assigned_user: row.assigned_users[0] ?? null,
    assigned_workers: row.assigned_users.map((workerUser, index) => ({
      sequence: index + 1,
      worker_user: workerUser,
      worker_role: "Field Worker",
      required: 1,
    })),
    authority_requirements_json: row.authority_requirements_json,
    authority_requirements_sha256: row.authority_requirements_sha256,
    assignment_command_fingerprint: row.command_fingerprint,
    work_object_type: row.work_object_type,
    work_object_id: row.work_object_id,
    physical_context_type: row.physical_context_type,
    physical_context_id: row.physical_context_id,
    authority_user: row.authority_user_id,
    authority_role:
      row.authority_role === "owner" ? "IronWrap Owner" : "IronWrap Production",
    assignment_version: row.assignment_version,
    scheduled_start: row.scheduled_start,
    scheduled_end: row.scheduled_end,
    blocker_reason: null,
    source_system: "ironwrap-d1",
    modified: row.created_at,
  };
}

function nativeProductionGateFrappeRow(
  row: NativeProductionGateRow,
): FrappeRow {
  return {
    name: row.gate_id,
    gate_id: row.gate_id,
    roof_job: row.roof_job_id,
    gate: row.gate,
    state: row.state,
    blocker_reason: row.blocker_reason,
    owner_user: row.owner_user,
    assigned_at: row.assigned_at,
    due_at: row.due_at,
    modified: row.updated_at,
    basis_in_force: row.basis_in_force,
  };
}

function nativeMaterialExceptionFrappeRow(
  row: NativeMaterialExceptionRow,
): FrappeRow {
  return {
    name: row.exception_id,
    roof_job: row.aggregate_id,
    exception_type: row.exception_type,
    status: row.status,
    reason_code: row.reason_code,
    created_at: row.created_at,
    modified: row.updated_at,
  };
}

function nativeOwnerFieldBlockerFrappeRow(
  row: NativeOwnerFieldBlockerRow,
): FrappeRow {
  return {
    name: row.stop_event_id ?? row.work_package_id,
    checkin_id: row.stop_event_id ?? row.work_package_id,
    roof_job: row.job_id,
    blocker_summary: row.blocker_reason,
    submitted_at: row.occurred_at,
    manifest_key: row.manifest_key,
    modified: row.occurred_at ?? row.updated_at,
  };
}

function nativeOwnerEffectExceptionFrappeRow(
  row: NativeOwnerEffectExceptionRow,
): FrappeRow {
  return {
    name: row.exception_id,
    incident_id: row.exception_id,
    action: row.action,
    provider: row.provider,
    reason_code: row.reason_code,
    roof_job: row.aggregate_type === "roof_job" ? row.aggregate_id : null,
    detected_at: row.created_at,
    modified: row.updated_at,
  };
}

function nativeOwnerLeadFrappeRow(row: OperatingSalesLeadRecord): FrappeRow {
  return {
    name: row.lead_id,
    envelope_id: row.source_envelope_id,
    source: row.source,
    contact_name: row.contact_name,
    job_ref: row.job_ref,
    triage_status: "Untriaged",
    event_ts: row.created_at,
    modified: row.updated_at,
  };
}

function nativeOwnerQuoteFrappeRow(row: CommercialQuoteRecord): FrappeRow {
  return {
    name: row.quote_revision_id,
    customer_quote_id: row.customer_quote_id,
    quote_version: row.revision_number,
    roof_job: row.roof_job_id,
    status: salesStatus(row.status),
    subtotal: moneyFromCents(row.subtotal_cents),
    tax_amount: moneyFromCents(row.tax_cents),
    quote_total: moneyFromCents(row.total_cents),
    currency: row.currency,
    valid_until: row.valid_until,
    supersedes: row.supersedes_quote_revision_id,
    modified: row.created_at,
  };
}

function nativeOwnerAccountingMoney(
  row: NativeOwnerAccountingIntentRow,
): { subtotal: string; totalAmount: string } | null {
  const subtotal = nativeOwnerAccountingMagnitude(
    row.subtotal,
    row.kind === "credit_memo",
  );
  const totalAmount = nativeOwnerAccountingMagnitude(
    row.total_amount,
    row.kind === "credit_memo" || row.kind === "refund",
  );
  return subtotal !== null && totalAmount !== null
    ? { subtotal, totalAmount }
    : null;
}

function nativeOwnerAccountingMagnitude(
  value: string,
  expectNegative: boolean,
): string | null {
  const negative = value.startsWith("-");
  const magnitude = negative ? value.slice(1) : value;
  if (
    negative !== expectNegative ||
    !/^(?:0|[1-9]\d*)\.\d{2}$/.test(magnitude) ||
    (expectNegative && magnitude === "0.00")
  )
    return null;
  return magnitude;
}

function nativeProductionCrewFrappeRow(
  row: NativeProductionCrewRow,
): FrappeRow {
  return {
    name: row.crew_id,
    crew_name: row.display_name,
    version: row.version,
    modified: row.updated_at,
  };
}

/** The job status label every office and field surface shows. Shared with `app-search.ts`. */
export function nativeJobStatusLabel(value: string | null): string | null {
  if (value === "qualified") return "Won";
  if (value === "in_progress") return "In Production";
  if (value === "complete") return "Complete";
  if (value === "cancelled") return "Cancelled";
  return value;
}

function nativeGateStateLabel(value: string | null): string | null {
  if (value === "blocked") return "Blocked";
  if (value === "ready") return "Ready";
  if (value === "in_progress") return "In Progress";
  if (value === "complete") return "Done";
  if (value === "waived") return "Waived";
  return value;
}

/**
 * OD-01 (0155): the policy recorded that the signed contract has no deposit. That gate is
 * complete, but nothing was done or paid: it reads as a system state, "No deposit under this
 * contract", and never reads or counts as done.
 */
function depositNotRequiredByContract(row: FrappeRow | undefined): boolean {
  return text(row?.gate) === "Deposit" && text(row?.state) === "complete" &&
    text(row?.basis_in_force) === "contract_no_deposit";
}

function productionGateStateLabel(row: FrappeRow | undefined): string | null {
  return depositNotRequiredByContract(row)
    ? NO_DEPOSIT_UNDER_CONTRACT
    : nativeGateStateLabel(text(row?.state));
}

/** The gate's recorded reason, or the system state when the contract has no deposit. */
function productionGateReason(row: FrappeRow): string | null {
  return depositNotRequiredByContract(row) ? NO_DEPOSIT_UNDER_CONTRACT : text(row.blocker_reason);
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
    modified: text(row.modified),
  };
}

function officeWorkPackageActions(
  role: AppRole,
  assignment: FrappeRow | null,
  workPackage: FieldWorkPackage | null,
): string[] {
  if (!assignment || !["owner", "ops", "production"].includes(role)) return [];
  return [
    "work_package.issue",
    ...(workPackage
      ? ["work_package.hold.release", "work_package.evidence.review"]
      : []),
  ];
}

function productionAssignmentModel(
  row: FrappeRow,
): NonNullable<ProductionRunwayReadModel["jobs"][number]["assignment"]> {
  return {
    id: text(row.name)!,
    type: text(row.assignment_type),
    status: text(row.status),
    assignment_version: Number(row.assignment_version),
    roof_job_version: Number(row.roof_job_version),
    crew_id: text(row.crew_id)!,
    crew_version: Number(row.crew_version),
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

function preferredAssignmentsByWorkObject(rows: FrappeRow[]): FrappeRow[] {
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
  return (
    [...grouped.values()]
      // A typed Today row is an actionable route, so an ambiguous active
      // assignment must be withheld rather than choosing a browser write target.
      .map((candidates) =>
        candidates.length === 1 ? (candidates[0] ?? null) : null,
      )
      .filter((row): row is FrappeRow => row !== null)
  );
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
          state: productionGateStateLabel(row),
          blocker_reason: productionGateReason(row),
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

async function nativeWorkPackageProofRows(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  assignmentId: string,
  workPackage: FieldWorkPackage,
): Promise<FrappeRow[] | null> {
  if (!workPackage.releaseAttemptId) return [];
  const evidence = await listFieldWorkPackageEvidenceFromD1(env, {
    tenantId,
    jobId,
    assignmentId,
    workPackageId: workPackage.id,
    version: workPackage.version,
    releaseAttemptId: workPackage.releaseAttemptId,
    scope: {
      workObjectType: workPackage.workObjectType ?? "Roof Job",
      workObjectId: workPackage.workObjectId ?? jobId,
      physicalContextType: workPackage.physicalContextType ?? "Roof Site",
      physicalContextId: workPackage.physicalContextId ?? jobId,
    },
  });
  return (
    (evidence?.map(nativeWorkPackageEvidenceRow) ?? null)?.sort(
      compareEvidenceRowsByProofOrder,
    ) ?? null
  );
}

function nativeWorkPackageEvidenceRow(
  row: FieldWorkPackageEvidenceD1Row,
): FrappeRow {
  return {
    name: row.eventId,
    evidence_id: row.evidenceItem,
    evidence_type: "Work Package Evidence",
    proof_slot: row.slotId,
    captured_at: row.capturedAt,
    summary: row.requirement,
    customer_safe: 0,
    source_system: row.source,
    sync_state: row.verification,
    modified: row.occurredAt,
  };
}

function nativeCustomerFrappeRow(
  row: NativeCustomerRecord | null | undefined,
): FrappeRow | null {
  if (!row) return null;
  return {
    name: row.customer_id,
    display_name: row.display_name,
    phone: row.contact_phone,
    modified: row.updated_at,
  };
}

function nativePropertyFrappeRow(
  row: NativePropertyRecord | null | undefined,
): FrappeRow | null {
  if (!row) return null;
  return {
    name: row.property_id,
    address_line1: row.address_line1,
    city: row.city,
    province: row.province,
    postal_code: row.postal_code,
    country: row.country,
    modified: row.updated_at,
  };
}

function compareEvidenceRowsByProofOrder(
  left: FrappeRow,
  right: FrappeRow,
): number {
  const leftItem = evidenceProofItem(left);
  const rightItem = evidenceProofItem(right);
  if (!leftItem || !rightItem) return 0;
  return compareProofItems(leftItem, rightItem);
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
    reportedByName?: string | null;
    summary?: string | null;
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
          reported_by_name: input.reportedByName ?? null,
          summary: input.summary ?? null,
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

function firstRowsBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const row of rows) {
    const value = key(row);
    if (!indexed.has(value)) indexed.set(value, row);
  }
  return indexed;
}

function groupedRows<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function nativeSalesEstimate(
  row: OperatingSalesEstimateRecord | undefined,
): SalesReadModel["leads"][number]["estimate"] {
  if (!row) return null;
  return {
    id: row.estimate_session_id,
    status: salesStatus(row.status),
    service_type: row.service_type,
    range_low: moneyFromCents(row.range_low_cents),
    range_high: moneyFromCents(row.range_high_cents),
    estimate_total: moneyFromCents(row.estimate_total_cents),
    confidence: row.confidence,
    review_required: row.review_required === 1,
    reviewed_at: null,
    approved_at: null,
    assumptions: row.assumptions,
    exclusions: row.exclusions,
  };
}

function nativeSalesQuote(
  row: CommercialSalesSources["quotes"][number] | undefined,
  acceptance: CommercialSalesSources["acceptances"][number] | undefined,
): SalesReadModel["leads"][number]["quote"] {
  if (!row) return null;
  return {
    id: row.customer_quote_id,
    version: row.revision_number,
    status: acceptance ? "Accepted" : salesStatus(row.status),
    quote_total: moneyFromCents(row.total_cents),
    currency: row.currency,
    valid_until: row.valid_until,
    payment_status: null,
    prepared_at: row.created_at,
    approved_at: row.status === "approved" ? row.created_at : null,
    accepted_at: acceptance?.accepted_at ?? null,
    scope_summary: null,
  };
}

function nativeCommercialQuoteRows(
  packet: NativeCommercialJobPacket,
): FrappeRow[] {
  const acceptancesByQuote = firstRowsBy(
    packet.acceptances,
    (row) => row.quote_revision_id,
  );
  return packet.quotes.map((row) => ({
    name: row.quote_revision_id,
    customer_quote_id: row.customer_quote_id,
    quote_version: row.revision_number,
    status: acceptancesByQuote.get(row.quote_revision_id)
      ? "Accepted"
      : salesStatus(row.status),
    price_book_version: null,
    pricing_effective_at: null,
    subtotal: moneyFromCents(row.subtotal_cents),
    tax_amount: moneyFromCents(row.tax_cents),
    tax_code: null,
    tax_rate: null,
    quote_total: moneyFromCents(row.total_cents),
    currency: row.currency,
    deposit_amount: null,
    amount_due: null,
    amount_paid: null,
    balance_due: null,
    payment_status: null,
    payment_due_date: null,
    valid_until: row.valid_until,
    prepared_at: row.created_at,
    approved_at: row.status === "approved" ? row.created_at : null,
    accepted_at:
      acceptancesByQuote.get(row.quote_revision_id)?.accepted_at ?? null,
    scope_summary: null,
    assumptions: null,
    exclusions: null,
    supersedes: row.supersedes_quote_revision_id,
    correction_reason: row.correction_reason,
    modified:
      acceptancesByQuote.get(row.quote_revision_id)?.accepted_at ??
      row.created_at,
  }));
}

function nativeEstimatorCommercialSelection(
  packet: NativeCommercialJobPacket,
  asOf: Date,
): {
  quoteRows: FrappeRow[];
  proposalRows: FrappeRow[];
  staleFields: string[];
} {
  if (
    packet.partial_sources.includes("commercial_quote_revisions") ||
    packet.partial_sources.includes("commercial_proposal_revisions")
  ) {
    return {
      quoteRows: [],
      proposalRows: [],
      staleFields: ["commercial_quote.source_window_partial"],
    };
  }
  const superseded = new Set(
    packet.quotes
      .map((row) => row.supersedes_quote_revision_id)
      .filter((id): id is string => Boolean(id)),
  );
  const currentDate = asOf.toISOString().slice(0, 10);
  const heads = packet.quotes.filter(
    (row) =>
      row.status === "approved" &&
      row.valid_until >= currentDate &&
      !superseded.has(row.quote_revision_id),
  );
  if (heads.length !== 1) {
    return {
      quoteRows: [],
      proposalRows: [],
      staleFields:
        heads.length > 1
          ? ["commercial_quote.authority_ambiguous"]
          : packet.quotes.length > 0
            ? ["commercial_quote.current_missing"]
            : [],
    };
  }
  const quotesById = new Map(
    packet.quotes.map((row) => [row.quote_revision_id, row] as const),
  );
  const lineage = new Set<string>();
  let cursor: (typeof packet.quotes)[number] | undefined = heads[0];
  while (cursor && !lineage.has(cursor.quote_revision_id)) {
    lineage.add(cursor.quote_revision_id);
    cursor = cursor.supersedes_quote_revision_id
      ? quotesById.get(cursor.supersedes_quote_revision_id)
      : undefined;
  }
  const selectedPacket: NativeCommercialJobPacket = {
    ...packet,
    quotes: packet.quotes.filter((row) => lineage.has(row.quote_revision_id)),
    proposals: packet.proposals.filter((row) =>
      lineage.has(row.quote_revision_id),
    ),
  };
  return {
    quoteRows: nativeCommercialQuoteRows(selectedPacket),
    proposalRows: nativeCommercialProposalRows(selectedPacket),
    staleFields: [],
  };
}

function nativeSalesProposal(
  row: CommercialSalesSources["proposals"][number] | undefined,
  publication: CommercialSalesSources["publications"][number] | undefined,
  acceptance: CommercialSalesSources["acceptances"][number] | undefined,
  sourcePartial: boolean,
): SalesReadModel["leads"][number]["proposal"] {
  if (!row) return null;
  return {
    id: row.proposal_pack_id,
    status: acceptance ? "Signed" : salesStatus(publication?.state ?? "draft"),
    prepared_at: row.created_at,
    approved_at: null,
    signed_at: acceptance?.accepted_at ?? null,
    has_published_pack: sourcePartial
      ? null
      : publication?.state === "published",
    published_status: sourcePartial
      ? null
      : salesStatus(publication?.state ?? null),
  };
}

function nativeCommercialProposalRows(
  packet: NativeCommercialJobPacket,
): FrappeRow[] {
  const publicationsByPack = firstRowsBy(
    packet.publications,
    (row) => row.proposal_pack_id,
  );
  const acceptancesByProposal = firstRowsBy(
    packet.acceptances,
    (row) => row.proposal_revision_id,
  );
  return packet.proposals.map((row) => {
    const publication = publicationsByPack.get(row.proposal_pack_id);
    const acceptance = acceptancesByProposal.get(row.proposal_revision_id);
    return {
      name: row.proposal_revision_id,
      pack_id: row.proposal_pack_id,
      quotation: row.quote_revision_id,
      status: acceptance
        ? "Signed"
        : publication?.state === "published"
          ? "Sent"
          : publication?.state === "withdrawn"
            ? "Withdrawn"
            : "Draft",
      prepared_at: row.created_at,
      approved_at: null,
      signed_at: acceptance?.accepted_at ?? null,
      assumptions: null,
      exclusions: null,
      modified:
        acceptance?.accepted_at ?? publication?.occurred_at ?? row.created_at,
    };
  });
}

function nativeSalesConsent(
  row: OperatingSalesConsentRecord,
): SalesReadModel["leads"][number]["consent"]["records"][number] {
  return {
    id: row.consent_id,
    channel: salesStatus(row.channel),
    purpose: salesStatus(row.purpose),
    status: salesStatus(row.status),
    jurisdiction: row.jurisdiction,
    basis: salesStatus(row.consent_basis),
    captured_at: row.recorded_at,
    effective_from: null,
    expires_at: null,
    revoked_at: row.status === "revoked" ? row.recorded_at : null,
  };
}

function salesAttention(
  triageStatus: string | null,
  estimate: SalesReadModel["leads"][number]["estimate"],
  quote: SalesReadModel["leads"][number]["quote"],
  partialFields: SalesPartialField[],
): SalesAttentionReason[] {
  const attention: SalesAttentionReason[] = [];
  if (partialFields.length > 0) attention.push("source_partial");
  if (!["Triaged", "Qualified", "Disqualified"].includes(triageStatus ?? ""))
    attention.push("triage_unresolved");
  if (estimate?.status === "Captured" || estimate?.status === "Needs Review")
    attention.push("estimate_needs_review");
  if (quote?.status === "Needs Review") attention.push("quote_needs_review");
  if (quote?.status === "Expired") attention.push("quote_expired");
  return attention;
}

function salesStatus(value: string | null): string | null {
  if (!value) return null;
  return value
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function moneyFromCents(value: number | null): number | null {
  return value === null ? null : value / 100;
}

function nativeSalesEnvelopeRows(sources: CommercialSalesSources): FrappeRow[] {
  return [
    ...sources.leads.map((row) => ({
      name: row.lead_id,
      modified: row.updated_at,
    })),
    ...sources.jobs.map((row) => ({
      name: row.roof_job_id,
      modified: row.updated_at,
    })),
    ...sources.estimates.map((row) => ({
      name: row.estimate_session_id,
      modified: row.updated_at,
    })),
    ...sources.consents.map((row) => ({
      name: row.consent_id,
      modified: row.recorded_at,
    })),
    ...sources.triageDecisions.map((row) => ({
      name: row.triage_decision_id,
      modified: row.decided_at,
    })),
    ...sources.quotes.map((row) => ({
      name: row.quote_revision_id,
      modified: row.created_at,
    })),
    ...sources.proposals.map((row) => ({
      name: row.proposal_revision_id,
      modified: row.created_at,
    })),
    ...sources.publications.map((row) => ({
      name: row.publication_event_id,
      modified: row.occurred_at,
    })),
    ...sources.acceptances.map((row) => ({
      name: row.acceptance_binding_id,
      modified: row.bound_at,
    })),
  ];
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
// a human approves a D1 catalog revision and a new import pins its exact receipt.

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
  nest: {
    mode: string;
    stock_ft: number;
    cut_ft: number;
    waste_pct: number;
    reused_cuts: number;
  } | null;
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
  lines: Array<{
    kind: string;
    sku: string;
    description: string;
    qty: number;
    unit: string;
    rate: number;
    amount: number;
  }>;
  lines_truncated: boolean;
  subtotal: number | null;
  markup: number | null;
  tax: number | null;
  total: number | null;
  unpriced_profiles: string[];
  needs_review: boolean | null;
}

function unavailableComputedTakeoff(
  reason: string,
): EstimatorComputedTakeoffProjection {
  return {
    state: "unavailable",
    authority: NON_OPERATIONAL_PREVIEW_AUTHORITY,
    calculation_schema: LEGACY_PREVIEW_CALCULATION_SCHEMA,
    policy_bound: false,
    approval_eligible: false,
    reason,
    needs_review: null,
    panel_count: null,
    panel_ft: null,
    panel_area_sqft: null,
    roof_area_computed_sqft: null,
    overage: null,
    skipped_facets: null,
    nest: null,
    trims: [],
    trims_truncated: false,
    fasteners: null,
    failed_check_count: null,
  };
}

function estimatorComputedTakeoff(model: GeometryModel | null): {
  projection: EstimatorComputedTakeoffProjection;
  takeoff: TakeoffModel | null;
} {
  if (!model)
    return {
      projection: unavailableComputedTakeoff("geometry_unavailable"),
      takeoff: null,
    };
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
        trims: takeoff.trims
          .slice(0, MAX_ESTIMATOR_COMPUTED_TRIMS)
          .map((trim) => ({
            profile: boundedGeometryText(
              trim.profile,
              MAX_ESTIMATOR_GEOMETRY_LABEL,
            ),
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
    return {
      projection: unavailableComputedTakeoff("takeoff_failed"),
      takeoff: null,
    };
  }
}

type EstimatorPriceList = {
  state: "unconfigured" | "invalid" | "ok";
  list?: PriceList;
  identity?: { tenantId: string; policyId: string; policyRevision: number };
};

function estimatorPriceList(env: AppEnv, pricedAt: string): EstimatorPriceList {
  const raw = env.ESTIMATOR_PRICE_LIST_JSON;
  if (!raw?.trim()) return { state: "unconfigured" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { state: "invalid" };
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
    mode: null,
    policy_id: null,
    policy_revision: null,
    policy_snapshot_sha256: null,
    currency: null,
    lines: [],
    lines_truncated: false,
    subtotal: null,
    markup: null,
    tax: null,
    total: null,
    unpriced_profiles: [],
    needs_review: null,
  };
}

function estimatorComputedEstimate(
  priceList: EstimatorPriceList,
  takeoff: TakeoffModel | null,
  pricedAt: string,
  authority?: VerifiedPricingAuthority,
): EstimatorComputedEstimateProjection {
  if (!takeoff) return emptyComputedEstimate("unavailable");
  if (priceList.state === "unconfigured")
    return emptyComputedEstimate("unconfigured");
  if (priceList.state === "invalid")
    return emptyComputedEstimate("invalid_price_list");
  try {
    const estimate = priceTakeoff(takeoff, priceList.list!, {
      pricedAt,
      authority,
    });
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
      lines: estimate.lines
        .slice(0, MAX_ESTIMATOR_ESTIMATE_LINES)
        .map((line) => ({
          kind: line.kind,
          sku: boundedGeometryText(line.sku, MAX_ESTIMATOR_GEOMETRY_LABEL),
          description: boundedGeometryText(
            line.description,
            MAX_ESTIMATOR_GEOMETRY_LABEL,
          ),
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
  return (
    /^raw\/measurements\/[0-9a-f]{64}\.json$/.test(value) ||
    /^raw\/measurements\/\d{4}-\d{2}-\d{2}\/ow_[0-9a-f-]{36}\.json$/.test(
      value,
    )
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

function hasRestrictedInsuranceAccess(auth: AuthContext): boolean {
  return auth.session.role === "owner" || auth.session.role === "ops";
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

/* ------------------------------------------------------------------ pipeline board ------ */

export interface PipelineSummaryReadModel {
  pipeline_id: string;
  key: string;
  name: string;
  entity_type: string;
  owning_role: string | null;
  position: number;
  version: number;
  card_count: number;
  can_move: boolean;
  /**
   * The parsed card template, sent on the board payload only. The board surface renders card slots
   * from it, so it must not have to re-fetch or re-parse the stored `card_template_json`; the
   * pipeline LIST omits it, because a switcher never renders a card.
   */
  card_template?: PipelineCardTemplate;
}

export interface PipelineListReadModel extends ReadModelEnvelope {
  pipelines: PipelineSummaryReadModel[];
}

export interface PipelineBoardStageReadModel {
  stage_id: string;
  key: string;
  name: string;
  color: string | null;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  min_role_to_enter: string | null;
  can_enter: boolean;
  card_count: number;
  total_amount_cents: number;
}

export interface PipelineBoardCardReadModel {
  card_id: string;
  stage_id: string;
  position_in_stage: number;
  entity_type: string;
  entity_id: string;
  version: number;
  stage_entered_at: string;
  summary: PipelineCardSummary;
}

export interface PipelineBoardReadModel extends ReadModelEnvelope {
  pipeline: PipelineSummaryReadModel;
  stages: PipelineBoardStageReadModel[];
  cards: PipelineBoardCardReadModel[];
  undo_window_seconds: number;
}

export class PipelineReadModelError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "PipelineReadModelError";
  }
}

/**
 * Every pipeline this session may see.  Role-scoped through `pipelines.owning_role` (PO decision
 * D8) plus the administrator-configured per-pipeline grants (0122): the owner and ops see all of
 * them, another role sees the boards its role owns or has been granted, and a role with neither
 * sees an empty list rather than a widened one.
 */
export async function buildPipelineListReadModel(
  env: AppEnv,
  auth: AuthContext,
  access?: PipelineRoleAccess,
): Promise<PipelineListReadModel> {
  const roleAccess =
    access ?? (await pipelineRoleAccessFor(env, auth.session.tenant_id, auth.session.role));
  const pipelines = (await listPipelines(env, auth.session.tenant_id)).filter((pipeline) =>
    canViewPipeline(auth, pipeline, roleAccess),
  );
  const counts = await cardCountsByPipeline(env, auth.session.tenant_id);
  const base = envelope(auth, pipelineEnvelopeRows(pipelines), []);
  return {
    ...base,
    allowed_actions: [...base.allowed_actions, "pipeline.read"],
    pipelines: pipelines.map((pipeline) =>
      pipelineSummary(auth, pipeline, counts.get(pipeline.pipeline_id) ?? 0, roleAccess),
    ),
  };
}

/**
 * The mobile-first board payload: flat, pre-aggregated, no client-side joins and no N+1.  Stage
 * card counts and value roll-ups are summed here so a phone renders a column header without
 * walking the card list, and every card's `summary` is rendered from the pipeline's own
 * `card_template_json` rather than from a per-vertical field list baked into this function.
 */
export async function buildPipelineBoardReadModel(
  env: AppEnv,
  auth: AuthContext,
  pipeline: PipelineRecord,
  access: PipelineRoleAccess = NO_PIPELINE_ROLE_ACCESS,
): Promise<PipelineBoardReadModel> {
  if (!canViewPipeline(auth, pipeline, access))
    throw new PipelineReadModelError("pipeline_read_forbidden");

  let template;
  try {
    template = parsePipelineCardTemplate(JSON.parse(pipeline.card_template_json) as unknown);
  } catch {
    throw new PipelineReadModelError("pipeline_card_template_invalid");
  }

  const [stages, cards] = await Promise.all([
    listStages(env, auth.session.tenant_id, pipeline.pipeline_id),
    listCards(env, auth.session.tenant_id, pipeline.pipeline_id),
  ]);
  const stageById = new Map(stages.map((stage) => [stage.stage_id, stage]));
  const relations = await resolveCardRelations(
    env,
    auth.session.tenant_id,
    cards,
    templateRelations(template),
  );

  const shapedCards: PipelineBoardCardReadModel[] = cards.map((card) => {
    const stage = stageById.get(card.stage_id);
    const bag = relations.get(card.card_id) ?? {};
    // `stage` is a relation like any other, so a template binds the won badge by name instead of
    // the read model deciding per vertical what "won" looks like.
    bag.stage = stage
      ? { is_won: stage.is_won === 1, is_lost: stage.is_lost === 1, name: stage.name, key: stage.key }
      : null;
    return {
      card_id: card.card_id,
      stage_id: card.stage_id,
      position_in_stage: card.position_in_stage,
      entity_type: card.entity_type,
      entity_id: card.entity_id,
      version: card.version,
      stage_entered_at: card.stage_entered_at,
      summary: renderCardSummary(template, bag, card.entity_id),
    };
  });

  const byStage = new Map<string, PipelineBoardCardReadModel[]>();
  for (const card of shapedCards) {
    const bucket = byStage.get(card.stage_id);
    if (bucket) bucket.push(card);
    else byStage.set(card.stage_id, [card]);
  }

  const staleFields = shapedCards.some((card) => !stageById.has(card.stage_id))
    ? ["pipeline.cards.stage"]
    : [];
  const base = envelope(
    auth,
    [...pipelineEnvelopeRows([pipeline]), ...stageEnvelopeRows(stages)],
    staleFields,
  );
  const movable = canMoveCards(auth, pipeline, access);
  return {
    ...base,
    allowed_actions: [
      ...base.allowed_actions,
      "pipeline.read",
      ...(movable ? ["pipeline.card.move"] : []),
    ],
    pipeline: pipelineSummary(auth, pipeline, shapedCards.length, access, template),
    stages: stages.map((stage) => {
      const stageCards = byStage.get(stage.stage_id) ?? [];
      return {
        stage_id: stage.stage_id,
        key: stage.key,
        name: stage.name,
        color: stage.color,
        position: stage.position,
        is_won: stage.is_won === 1,
        is_lost: stage.is_lost === 1,
        min_role_to_enter: stage.min_role_to_enter,
        can_enter:
          movable &&
          (stage.min_role_to_enter === null ||
            satisfiesStageRole(auth.session.role, stage.min_role_to_enter)),
        card_count: stageCards.length,
        total_amount_cents: stageCards.reduce(
          (total, card) => total + (card.summary.amount_cents ?? 0),
          0,
        ),
      };
    }),
    cards: shapedCards,
    undo_window_seconds: Math.round(PIPELINE_UNDO_WINDOW_MS / 1000),
  };
}

function pipelineSummary(
  auth: AuthContext,
  pipeline: PipelineRecord,
  cardCount: number,
  access: PipelineRoleAccess,
  template?: PipelineCardTemplate,
): PipelineSummaryReadModel {
  return {
    ...(template ? { card_template: template } : {}),
    pipeline_id: pipeline.pipeline_id,
    key: pipeline.key,
    name: pipeline.name,
    entity_type: pipeline.entity_type,
    owning_role: pipeline.owning_role,
    position: pipeline.position,
    version: pipeline.version,
    card_count: cardCount,
    can_move: canMoveCards(auth, pipeline, access),
  };
}

function pipelineEnvelopeRows(pipelines: readonly PipelineRecord[]): FrappeRow[] {
  return pipelines.map((pipeline) => ({
    name: pipeline.pipeline_id,
    modified: pipeline.updated_at,
  }));
}

function stageEnvelopeRows(stages: readonly PipelineStageRecord[]): FrappeRow[] {
  return stages.map((stage) => ({ name: stage.stage_id, modified: stage.updated_at }));
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
