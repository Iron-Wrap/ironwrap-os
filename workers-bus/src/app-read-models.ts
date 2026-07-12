import type { AppEnv, AuthContext } from "./app-types.ts";
import { approvalDecisionConfig } from "./approval-broker-client.ts";
import { quoteRevisionApprovalBrokerConfig } from "./quote-revision-approval-broker-client.ts";
import {
  listFrappeResource,
  listFrappeResourcePage,
  listOfficeEstimatorFrappeResource,
  listOfficeSalesFrappeResource,
  publicFrappeRow,
  readOfficeEstimatorFrappeResource,
  type FrappeFilter,
  type FrappeRow,
} from "./frappe-read.ts";
import { parseBody } from "./core.ts";
import { extractGeometry } from "./measurements.ts";
import { listLeadMctbEvidence, type LeadAckReceipt } from "./store.ts";

const ACTIVE_JOB_STATUSES = ["Won", "In Production"] as const;
export const ACTIVE_ASSIGNMENT_STATUSES = ["Assigned", "Accepted", "In Progress", "Blocked"] as const;
const FIELD_PACKET_PROOF_PAGE_SIZE = 100;
const OWNER_NOW_SOURCE_LIMIT = 50;
const SALES_SOURCE_LIMIT = 100;
const ESTIMATOR_SOURCE_LIMIT = 100;
const MAX_ESTIMATOR_RAW_BYTES = 2 * 1024 * 1024;
const MAX_ESTIMATOR_CHECKS = 80;
const MAX_ESTIMATOR_FACETS = 120;
const MAX_ESTIMATOR_METRICS = 120;
const MAX_ESTIMATOR_TAKEOFF_ITEMS = 250;
const MAX_ESTIMATOR_GEOMETRY_LABEL = 240;
const MAX_ESTIMATOR_GEOMETRY_DETAIL = 600;
const MCTB_SLA_MS = 60_000;

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
  lineage: {
    measurement_to_takeoff: "linked" | "no_measurement" | "no_takeoff" | "mismatch" | "unknown";
    quote_to_proposal: "linked" | "no_quote" | "no_proposal" | "mismatch" | "unknown";
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
    } | null;
  };
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
    state: "recorded" | "review_required" | "expired" | "incomplete" | "unavailable";
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
    quote_link: "selected_quote" | "other_quote" | "quote_unavailable" | "no_quote";
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

export async function buildTodayReadModel(env: AppEnv, auth: AuthContext): Promise<TodayReadModel> {
  const assignments = await authorizedAssignments(env, auth);
  const preferredByJob = preferredAssignmentsByJob(assignments);
  const assignedJobIds = [...preferredByJob.keys()];
  if (auth.session.role === "field" && assignedJobIds.length === 0) return emptyToday(env, auth, assignments);
  const jobs = auth.session.role === "field"
    ? await listFrappeResource(
      env,
      "Roof Job",
      [
        ["Roof Job", "name", "in", assignedJobIds],
        ["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]],
      ],
      100,
    )
    : await listFrappeResource(
      env,
      "Roof Job",
      [["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]]],
      100,
    );
  const jobIds = jobs.map((row) => text(row.name)).filter(notNull);
  const propertyIds = jobs.map((row) => text(row.roofing_property)).filter(notNull);
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
      ? listFrappeResource(env, "Roofing Property", [["Roofing Property", "name", "in", propertyIds]], 100)
      : Promise.resolve([]),
  ]);
  const propertyById = new Map(properties.map((row) => [text(row.name), row]));
  const blockedByJob = groupBy(blockedGates, "roof_job");
  const shaped = jobs.flatMap((row) => {
    const id = text(row.name);
    const assignmentRow = id ? preferredByJob.get(id) : undefined;
    if (!id || (auth.session.role === "field" && !assignmentRow)) return [];
    const blocked = blockedByJob.get(id) ?? [];
    const assignment = assignmentRow ? assignmentModel(assignmentRow) : null;
    return [{
      id,
      job_number: text(row.job_number),
      brand: text(row.brand),
      status: text(row.job_status),
      address: address(propertyById.get(text(row.roofing_property))),
      scheduled_start: assignment?.scheduled_start ?? null,
      scheduled_end: assignment?.scheduled_end ?? null,
      blocked_gate_count: blocked.length,
      next_action: assignment?.blocker_reason ?? text(blocked[0]?.blocker_reason) ?? (assignment ? "Open field check-in" : "Assign field work"),
      assignment,
    }];
  }).sort((left, right) => compareSchedule(left.scheduled_start, right.scheduled_start));
  const stale: string[] = [];
  if (properties.length < new Set(propertyIds).size) stale.push("jobs.address");
  return {
    ...envelope(auth, [...assignments, ...jobs, ...blockedGates, ...properties], stale),
    date: tenantDate(env.APP_TIME_ZONE),
    jobs: shaped,
  };
}

export async function buildJobReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
): Promise<JobReadModel | null> {
  if (!validJobName(jobName)) return null;
  const assignmentRow = await activeAssignmentForJob(env, auth, jobName);
  if (auth.session.role === "field" && !assignmentRow) return null;
  const jobs = await listFrappeResource(env, "Roof Job", [["Roof Job", "name", "=", jobName]], 1);
  const job = jobs[0];
  if (!job || !ACTIVE_JOB_STATUSES.includes(text(job.job_status) as never)) return null;

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
  ] = await Promise.all([
    listFrappeResource(env, "Production Gate State", [["Production Gate State", "roof_job", "=", jobName]], 50),
    listFrappeResourcePage(env, "Evidence Item", [["Evidence Item", "roof_job", "=", jobName]], FIELD_PACKET_PROOF_PAGE_SIZE, 0),
    listFrappeResource(env, "Field Check-in", [["Field Check-in", "roof_job", "=", jobName]], 50),
    propertyId
      ? listFrappeResource(env, "Roofing Property", [["Roofing Property", "name", "=", propertyId]], 1)
      : Promise.resolve([]),
    listFrappeResource(env, "Scope Clause", [
      ["Scope Clause", "roof_job", "=", jobName],
      ["Scope Clause", "status", "=", "Approved"],
    ], 100),
    listFrappeResource(env, "Measurement Report", [
      ["Measurement Report", "roof_job", "=", jobName],
      ["Measurement Report", "review_status", "=", "Approved"],
    ], 50),
    listFrappeResource(env, "Material Takeoff", [
      ["Material Takeoff", "roof_job", "=", jobName],
      ["Material Takeoff", "status", "=", "Approved"],
    ], 50),
    listFrappeResource(env, "Supplier Order", [["Supplier Order", "roof_job", "=", jobName]], 50),
    listFrappeResource(env, "Change Order", [
      ["Change Order", "roof_job", "=", jobName],
      ["Change Order", "status", "in", ["Approved", "Presented", "Accepted"]],
    ], 50),
    listFrappeResource(env, "Safety Plan", [
      ["Safety Plan", "roof_job", "=", jobName],
      ["Safety Plan", "status", "in", ["Ready", "Acknowledged"]],
    ], 20),
    customerId
      ? listFrappeResource(env, "Roofing Customer", [["Roofing Customer", "name", "=", customerId]], 1)
      : Promise.resolve([]),
  ]);
  const property = propertyRows[0];
  const customer = customerRows[0];
  const proofStream = [...evidence.map(evidenceProofItem), ...checkIns.map(checkInProofItem)]
    .filter(notNull)
    .sort(compareProofItems);
  const safety = safetyPlans.sort((a, b) => numberValue(b.version) - numberValue(a.version))[0];
  const stale: string[] = [];
  if (auth.session.role !== "field" && gates.some((row) => !text(row.owner_user))) stale.push("gates.owner");
  if (propertyId && !property) stale.push("job.address");
  if (!customer || !text(customer.display_name)) stale.push("packet.contact.display_name");
  if (!customer || !text(customer.phone)) stale.push("packet.contact.phone");
  stale.push("packet.contact.access_instructions");
  return {
    ...envelope(auth, [
      publicFrappeRow(job), ...(assignmentRow ? [assignmentRow] : []), ...gates, ...evidence, ...checkIns, ...propertyRows, ...customerRows,
      ...scopeClauses, ...measurements, ...takeoffs, ...supplierOrders, ...changeOrders, ...safetyPlans,
    ], stale),
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
    gates: gates.flatMap((row) => gateModel(row, auth.session.role === "field")),
    packet: {
      scope_clauses: scopeClauses.flatMap((row) => {
        const id = text(row.scope_clause_id) ?? text(row.name);
        return id ? [{ id, type: text(row.clause_type), title: text(row.title), text: text(row.clause_text), version: text(row.version) }] : [];
      }),
      measurements: measurements.flatMap((row) => {
        const id = text(row.measurement_id) ?? text(row.name);
        return id ? [{ id, provider: text(row.provider), review_status: text(row.review_status), parsed_at: text(row.parsed_at) }] : [];
      }),
      materials: {
        takeoffs: takeoffs.flatMap((row) => {
          const id = text(row.takeoff_id) ?? text(row.name);
          return id ? [{ id, status: text(row.status), prepared_at: text(row.prepared_at) }] : [];
        }),
        supplier_orders: supplierOrders.flatMap((row) => {
          const id = text(row.supplier_order_id) ?? text(row.name);
          return id ? [{ id, status: text(row.status), requested_delivery_date: text(row.requested_delivery_date), delivery_notes: text(row.delivery_notes) }] : [];
        }),
      },
      change_orders: changeOrders.flatMap((row) => {
        const id = text(row.change_order_id) ?? text(row.name);
        return id ? [{
          id,
          number: text(row.change_number),
          version: optionalNumber(row.version),
          status: text(row.status),
          title: text(row.title),
          scope_delta: text(row.scope_delta),
        }] : [];
      }),
      safety_plan: safety ? {
        id: text(safety.safety_plan_id) ?? text(safety.name)!,
        version: optionalNumber(safety.version),
        status: text(safety.status),
        effective_date: text(safety.effective_date),
        hazard_summary: text(safety.hazard_summary),
        controls: text(safety.controls),
        emergency_plan: text(safety.emergency_plan),
        ppe_requirements: text(safety.ppe_requirements),
        weather_limits: text(safety.weather_limits),
      } : null,
      contact: customer ? {
        display_name: text(customer.display_name),
        phone: text(customer.phone),
        access_instructions: null,
      } : null,
    },
    proof_stream: proofStream,
    proof_page: {
      next_cursor: evidence.length === FIELD_PACKET_PROOF_PAGE_SIZE ? String(FIELD_PACKET_PROOF_PAGE_SIZE) : null,
      page_size: FIELD_PACKET_PROOF_PAGE_SIZE,
    },
    required_proof: gates.flatMap((row) => {
      const id = text(row.gate_id) ?? text(row.name);
      const slot = text(row.gate);
      if (!id || !slot) return [];
      return [{
        id,
        slot,
        label: `${slot} proof`,
        state: text(row.state) ?? "Blocked",
        blocker_reason: text(row.blocker_reason),
      }];
    }),
  };
}

export async function buildJobProofReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
  cursor: string | null,
): Promise<ProofPageReadModel | null> {
  const assignment = await activeAssignmentForJob(env, auth, jobName);
  if (auth.session.role === "field" && !assignment) return null;
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
    items: evidence.map(evidenceProofItem).filter(notNull).sort(compareProofItems),
    next_cursor: evidence.length === FIELD_PACKET_PROOF_PAGE_SIZE
      ? String(offset + FIELD_PACKET_PROOF_PAGE_SIZE)
      : null,
  };
}

export async function buildOwnerNowReadModel(
  env: AppEnv,
  auth: AuthContext,
  now = new Date(),
): Promise<OwnerNowReadModel> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") throw new Error("owner_scope_required");
  const [jobs, fieldBlockers, gates, incidents, payments, untriagedLeads, unknownTriageLeads, supplierOrders] = await Promise.all([
    listFrappeResource(env, "Roof Job", [["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]]], OWNER_NOW_SOURCE_LIMIT),
    listFrappeResource(env, "Field Check-in", [
      ["Field Check-in", "blocker_flag", "=", 1],
      ["Field Check-in", "status", "in", ["Received", "Needs Review"]],
      ["Field Check-in", "sync_state", "=", "Verified"],
    ], OWNER_NOW_SOURCE_LIMIT),
    listFrappeResource(env, "Production Gate State", [["Production Gate State", "state", "=", "Blocked"]], OWNER_NOW_SOURCE_LIMIT),
    listFrappeResource(env, "Automation Incident", [["Automation Incident", "status", "in", ["Open", "Acknowledged"]]], OWNER_NOW_SOURCE_LIMIT),
    listFrappeResource(env, "Payment Milestone", [["Payment Milestone", "status", "in", ["Webhook Seen", "Needs Review"]]], OWNER_NOW_SOURCE_LIMIT),
    listFrappeResource(env, "Lead Envelope", [["Lead Envelope", "triage_status", "=", "Untriaged"]], OWNER_NOW_SOURCE_LIMIT),
    listFrappeResource(env, "Lead Envelope", [["Lead Envelope", "triage_status", "=", "Unknown"]], OWNER_NOW_SOURCE_LIMIT),
    listFrappeResource(env, "Supplier Order", [["Supplier Order", "status", "in", ["Needs Review", "Shortage"]]], OWNER_NOW_SOURCE_LIMIT),
  ]);
  const leadRows = [...untriagedLeads, ...unknownTriageLeads];
  const leadIds = leadRows.map((row) => text(row.envelope_id) ?? text(row.name)).filter(notNull);
  const leadEvidence = await listLeadMctbEvidence(env, leadIds);
  const envelopeById = new Map(leadEvidence.envelopes.map((row) => [row.envelope_id, row]));
  const receiptsByEnvelope = new Map<string, LeadAckReceipt[]>();
  for (const receipt of leadEvidence.receipts) {
    const current = receiptsByEnvelope.get(receipt.envelope_id) ?? [];
    current.push(receipt);
    receiptsByEnvelope.set(receipt.envelope_id, current);
  }
  const leadException = (row: FrappeRow, kind: "untriaged_lead" | "lead_triage_unknown") => {
    const id = text(row.envelope_id) ?? text(row.name);
    if (!id) return [];
    const owned = envelopeById.get(id);
    const receivedAt = owned?.received_at ?? null;
    const source = text(row.source);
    const triageStatus = text(row.triage_status) ?? "Unknown";
    const mctb = mctbStatus(receivedAt, receiptsByEnvelope.get(id) ?? [], now);
    const titlePrefix = kind === "untriaged_lead" ? "Untriaged lead" : "Lead triage is unknown";
    return exceptionRow(row, {
      id,
      kind,
      severity: null,
      title: text(row.contact_name) ? `${titlePrefix}: ${text(row.contact_name)}` : titlePrefix,
      why: [source, owned?.bus_status ?? text(row.status)].filter(notNull).join(" · ") || null,
      jobId: text(row.job_ref),
      occurredAt: receivedAt ?? text(row.event_ts),
      receivedAt,
      busStatus: owned?.bus_status ?? text(row.status),
      triageStatus,
      mctb,
    });
  };
  const untriagedExceptions = untriagedLeads.flatMap((row) => leadException(row, "untriaged_lead"));
  const unknownTriageExceptions = unknownTriageLeads.flatMap((row) => leadException(row, "lead_triage_unknown"));
  const exceptions: OwnerNowReadModel["exceptions"] = [
    ...fieldBlockers.flatMap((row) => exceptionRow(row, {
      id: text(row.checkin_id) ?? text(row.name), kind: "field_blocker", severity: null,
      title: `${text(row.blocker_category) ?? "Field"} work-stop reported`, why: text(row.blocker_summary),
      jobId: text(row.roof_job), occurredAt: text(row.submitted_at),
    })),
    ...gates.flatMap((row) => exceptionRow(row, {
      id: text(row.gate_id) ?? text(row.name), kind: "blocked_gate", severity: null,
      title: `${text(row.gate) ?? "Production"} gate blocked`, why: text(row.blocker_reason),
      jobId: text(row.roof_job), occurredAt: text(row.assigned_at), dueAt: text(row.due_at),
    })),
    ...incidents.flatMap((row) => exceptionRow(row, {
      id: text(row.incident_id) ?? text(row.name), kind: "automation_incident", severity: text(row.severity),
      title: text(row.summary) ?? "Automation incident", why: text(row.category), jobId: text(row.roof_job),
      occurredAt: text(row.detected_at),
    })),
    ...supplierOrders.flatMap((row) => exceptionRow(row, {
      id: text(row.supplier_order_id) ?? text(row.name), kind: "material_exception", severity: null,
      title: `Supplier order ${text(row.status) ?? "needs review"}`, why: text(row.delivery_notes),
      jobId: text(row.roof_job), occurredAt: text(row.prepared_at), dueAt: text(row.requested_delivery_date),
    })),
    ...payments.flatMap((row) => exceptionRow(row, {
      id: text(row.payment_milestone_id) ?? text(row.name), kind: "finance_exception", severity: null,
      title: `${text(row.milestone_type) ?? "Payment"} needs review`, why: text(row.notes) ?? text(row.status),
      jobId: text(row.roof_job), occurredAt: text(row.event_ts), dueAt: text(row.due_date),
    })),
    ...untriagedExceptions,
    ...unknownTriageExceptions,
  ];
  const ownerSources: Array<readonly [string, FrappeRow[]]> = [
    ["active_jobs", jobs], ["field_blockers", fieldBlockers], ["blocked_gates", gates],
    ["automation_incidents", incidents], ["finance_exceptions", payments], ["untriaged_leads", untriagedLeads],
    ["lead_triage_unknown", unknownTriageLeads],
    ["material_exceptions", supplierOrders],
  ];
  const partialSources = ownerSources.flatMap(([name, rows]) => rows.length === OWNER_NOW_SOURCE_LIMIT ? [name] : []);
  const stale = ["exceptions.next_action"];
  if (exceptions.some((row) => row.due_at === null)) stale.push("exceptions.due_at");
  if (partialSources.length > 0) stale.push("exceptions.partial_sources");
  return {
    ...envelope(auth, [...jobs, ...fieldBlockers, ...gates, ...incidents, ...payments, ...leadRows, ...supplierOrders], stale),
    exceptions,
    partial_sources: partialSources,
    summary: {
      active_jobs: jobs.length, field_blockers: fieldBlockers.length, blocked_gates: gates.length, open_incidents: incidents.length,
      finance_exceptions: payments.length,
      untriaged_leads: untriagedExceptions.length, lead_triage_unknown: unknownTriageExceptions.length,
      mctb_unproven_due: untriagedExceptions.filter((row) => mctbMissedSla(row.mctb)).length,
      material_exceptions: supplierOrders.length,
    },
  };
}

/**
 * Office-only Sales Desk payload. This joins only the lead, estimate, quote, and consent context
 * needed for a human review. It intentionally excludes raw intake payloads, outbound controls,
 * price-book internals, and generic Frappe queries.
 */
export async function buildSalesReadModel(env: AppEnv, auth: AuthContext): Promise<SalesReadModel> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") throw new Error("office_scope_required");

  const leads = await listOfficeSalesFrappeResource(env, "Lead Envelope", [], SALES_SOURCE_LIMIT);
  const leadIds = leads.map((row) => text(row.name)).filter(notNull);
  const leadJobRefs = leads.map((row) => text(row.job_ref)).filter(notNull);
  const [jobsLinkedByLead, jobsByReference, estimates, leadConsents] = await Promise.all([
    leadIds.length > 0
      ? listOfficeSalesFrappeResource(env, "Roof Job", [["Roof Job", "lead_envelope", "in", leadIds]], SALES_SOURCE_LIMIT)
      : Promise.resolve([]),
    leadJobRefs.length > 0
      ? listOfficeSalesFrappeResource(env, "Roof Job", [["Roof Job", "name", "in", leadJobRefs]], SALES_SOURCE_LIMIT)
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
      ? listOfficeSalesFrappeResource(env, "Customer Quote", [["Customer Quote", "roof_job", "in", jobIds]], SALES_SOURCE_LIMIT)
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

  const jobById = mapRowsByReference(jobs, "name");
  const latestJobsByLead = latestRowsByReference(jobs, "lead_envelope");
  const estimatesByLead = latestRowsByReference(estimates, "lead_envelope");
  const quotesByJob = latestRowsByReference(quotes, "roof_job", "quote_version");
  const consentRows = uniqueRows([...leadConsents, ...jobConsents, ...customerConsents]);
  const directConsentsByLead = groupBy(consentRows, "lead_envelope");
  const consentsByJob = groupBy(consentRows, "roof_job");
  const consentsByCustomer = groupBy(consentRows, "customer");
  const consentSourcesPartial = [leadConsents, jobConsents, customerConsents].some((rows) => rows.length === SALES_SOURCE_LIMIT);

  const shaped: SalesReadModel["leads"] = leads.flatMap((lead) => {
    const leadId = text(lead.name);
    if (!leadId) return [];
    const linkedJob = latestJobsByLead.get(leadId) ?? jobById.get(text(lead.job_ref) ?? "") ?? null;
    const jobId = linkedJob ? text(linkedJob.name) : null;
    const customerId = linkedJob ? text(linkedJob.customer) : null;
    const linkedConsents = uniqueRows([
      ...(directConsentsByLead.get(leadId) ?? []),
      ...(jobId ? consentsByJob.get(jobId) ?? [] : []),
      ...(customerId ? consentsByCustomer.get(customerId) ?? [] : []),
    ]);
    const consentRecords = linkedConsents.map(salesConsentRecord).filter(notNull);
    const estimate = salesEstimateModel(estimatesByLead.get(leadId));
    const quote = jobId ? salesQuoteModel(quotesByJob.get(jobId)) : null;
    const attention = salesAttention(lead, estimate, quote);
    const consentContext: SalesReadModel["leads"][number]["consent"]["context"] = consentSourcesPartial
      ? "partial"
      : consentRecords.length > 0
        ? "recorded"
        : "no_linked_record";
    return [{
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
      job: linkedJob && jobId ? {
        id: jobId,
        job_number: text(linkedJob.job_number),
        status: text(linkedJob.job_status),
        service_type: text(linkedJob.service_type),
        workflow_profile: text(linkedJob.workflow_profile),
      } : null,
      estimate,
      quote,
      consent: {
        context: consentContext,
        records: consentRecords,
      },
      attention,
    }];
  }).sort(compareSalesLead);

  const sourceRows: Array<readonly [string, FrappeRow[]]> = [
    ["leads", leads],
    ["roof_jobs_by_lead", jobsLinkedByLead],
    ["roof_jobs_by_reference", jobsByReference],
    ["instant_estimates", estimates],
    ["customer_quotes", quotes],
    ["lead_consents", leadConsents],
    ["job_consents", jobConsents],
    ["customer_consents", customerConsents],
  ];
  const partialSources = sourceRows.flatMap(([name, rows]) => rows.length === SALES_SOURCE_LIMIT ? [name] : []);
  const base = envelope(auth, [
    ...leads, ...jobs, ...estimates, ...quotes, ...leadConsents, ...jobConsents, ...customerConsents,
  ], partialSources.length > 0 ? ["sales.partial_sources"] : []);
  return {
    ...base,
    allowed_actions: [
      ...base.allowed_actions,
      ...(auth.permissions.includes("approvals:read") ? ["approval.read"] : []),
      ...(auth.permissions.includes("estimator:read") ? ["estimator.read"] : []),
      "sales.read",
    ],
    partial_sources: partialSources,
    summary: {
      listed_leads: shaped.length,
      triage_unresolved: shaped.filter((lead) => lead.attention.includes("triage_unresolved")).length,
      estimate_needs_review: shaped.filter((lead) => lead.attention.includes("estimate_needs_review")).length,
      quote_needs_review: shaped.filter((lead) => lead.attention.includes("quote_needs_review")).length,
      quote_expired: shaped.filter((lead) => lead.attention.includes("quote_expired")).length,
      no_linked_consent_record: shaped.filter((lead) => lead.consent.context === "no_linked_record").length,
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
): Promise<EstimatorWorkbenchReadModel | null> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") throw new Error("office_scope_required");
  if (!validJobName(jobName)) return null;

  const [job] = await listOfficeEstimatorFrappeResource(
    env,
    "Roof Job",
    [["Roof Job", "name", "=", jobName]],
    1,
  );
  const jobId = job ? text(job.name) : null;
  if (!job || !jobId) return null;

  const [measurementRows, takeoffRows, quoteRows, proposalRows, changeOrderRows, scopeRows] = await Promise.all([
    listOfficeEstimatorFrappeResource(
      env,
      "Measurement Report",
      [["Measurement Report", "roof_job", "=", jobId]],
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
      "Scope Clause",
      [["Scope Clause", "roof_job", "=", jobId]],
      ESTIMATOR_SOURCE_LIMIT,
    ),
  ]);

  const selectedMeasurementRow = latestRecord(measurementRows);
  const selectedMeasurementName = selectedMeasurementRow ? text(selectedMeasurementRow.name) : null;
  const selectedTakeoffRow = selectedMeasurementName
    ? latestRecord(takeoffRows.filter((row) => text(row.measurement_report) === selectedMeasurementName))
    : null;
  const selectedTakeoffName = selectedTakeoffRow ? text(selectedTakeoffRow.name) : null;
  const selectedQuoteRow = latestRecord(quoteRows, "quote_version");
  const selectedQuoteName = selectedQuoteRow ? text(selectedQuoteRow.name) : null;
  const selectedProposalRow = selectedQuoteName
    ? latestRecord(proposalRows.filter((row) => text(row.quotation) === selectedQuoteName))
    : null;
  const quote = estimatorQuote(selectedQuoteRow);
  const pricingSnapshot = estimatorPricingSnapshot(quote);
  const quoteRevision = estimatorQuoteRevision(selectedQuoteRow, quoteRows);
  const scopeChanges = newestFirst(changeOrderRows).flatMap((row) =>
    estimatorScopeChange(row, selectedQuoteName, quoteRows),
  );
  const [measurementRead, takeoffRead] = await Promise.all([
    selectedMeasurementName
      ? safeEstimatorDetailRead(env, "Measurement Report", selectedMeasurementName)
      : Promise.resolve({ row: null, unavailable_reason: null }),
    selectedTakeoffName
      ? safeEstimatorDetailRead(env, "Material Takeoff", selectedTakeoffName)
      : Promise.resolve({ row: null, unavailable_reason: null }),
  ]);
  const measurementDetail = matchesMeasurementDetail(measurementRead.row, selectedMeasurementName, jobId)
    ? measurementRead.row
    : null;
  const takeoffDetail = matchesTakeoffDetail(takeoffRead.row, selectedTakeoffName, jobId, selectedMeasurementName)
    ? takeoffRead.row
    : null;
  const measurementDetailIssue = measurementRead.unavailable_reason
    ?? (measurementRead.row && !measurementDetail ? "measurement_detail_mismatch" : null);
  const takeoffDetailIssue = takeoffRead.unavailable_reason
    ?? (takeoffRead.row && !takeoffDetail ? "takeoff_detail_mismatch" : null);

  const geometry = measurementDetail
    ? await estimatorGeometryFromRaw(env, text(measurementDetail.raw_key))
    : unavailableEstimatorGeometry(
      selectedMeasurementRow ? measurementDetailIssue ?? "measurement_detail_unavailable" : "no_measurement_report",
    );
  const staleFields: string[] = [];
  if (selectedMeasurementRow && !measurementDetail) staleFields.push("measurements.selected_detail");
  if (selectedTakeoffRow && !takeoffDetail) staleFields.push("takeoffs.selected_detail");

  const sourceRows: Array<readonly [string, FrappeRow[]]> = [
    ["measurement_reports", measurementRows],
    ["material_takeoffs", takeoffRows],
    ["customer_quotes", quoteRows],
    ["proposal_evidence_packs", proposalRows],
    ["change_orders", changeOrderRows],
    ["scope_clauses", scopeRows],
  ];
  const partialSources = sourceRows.flatMap(([name, rows]) => rows.length === ESTIMATOR_SOURCE_LIMIT ? [name] : []);
  const base = envelope(
    auth,
    [job, ...measurementRows, ...takeoffRows, ...quoteRows, ...proposalRows, ...changeOrderRows, ...scopeRows],
    staleFields,
  );
  const quoteRevisionPreparationAvailable = Boolean(
    quote && quote.id && quote.version !== null && quote.version > 0 && quote.status !== "Accepted" &&
      quoteRevisionApprovalBrokerConfig(env) && approvalDecisionConfig(env) &&
      auth.session.frappe_user_id?.trim(),
  );
  return {
    ...base,
    allowed_actions: [
      ...base.allowed_actions,
      "estimator.read",
      ...(quoteRevisionPreparationAvailable ? ["quote_revision_approval.prepare"] : []),
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
    lineage: {
      measurement_to_takeoff: measurementToTakeoffLineage(
        selectedMeasurementRow,
        selectedTakeoffRow,
        takeoffRows,
      ),
      quote_to_proposal: quoteToProposalLineage(selectedQuoteRow, selectedProposalRow, proposalRows),
    },
    measurements: {
      reports: newestFirst(measurementRows).flatMap(estimatorMeasurementSummary),
      selected: estimatorMeasurementSelection(selectedMeasurementRow, measurementDetail, geometry),
    },
    takeoffs: {
      records: newestFirst(takeoffRows).flatMap(estimatorTakeoffSummary),
      selected: estimatorTakeoffSelection(selectedTakeoffRow, takeoffDetail),
    },
    quote,
    pricing_snapshot: pricingSnapshot,
    quote_revision: quoteRevision,
    proposal: estimatorProposal(selectedProposalRow),
    scope_changes: scopeChanges,
    proposal_readiness: estimatorProposalReadiness({
      geometry,
      measurement: selectedMeasurementRow,
      takeoff: selectedTakeoffRow,
      takeoffDetail,
      takeoffLineage: measurementToTakeoffLineage(selectedMeasurementRow, selectedTakeoffRow, takeoffRows),
      quote,
      pricingSnapshot,
      proposalLineage: quoteToProposalLineage(selectedQuoteRow, selectedProposalRow, proposalRows),
      scopeChanges,
      partialSources,
      staleFields,
    }),
    scope_clauses: newestFirst(scopeRows).flatMap(estimatorScopeClause),
  };
}

function emptyToday(env: AppEnv, auth: AuthContext, rows: FrappeRow[] = []): TodayReadModel {
  return { ...envelope(auth, rows, []), date: tenantDate(env.APP_TIME_ZONE), jobs: [] };
}

async function authorizedAssignments(
  env: AppEnv,
  auth: AuthContext,
  jobName?: string,
): Promise<FrappeRow[]> {
  const baseFilters: FrappeFilter[] = [
    ["Job Assignment", "status", "in", [...ACTIVE_ASSIGNMENT_STATUSES]],
  ];
  if (jobName) baseFilters.unshift(["Job Assignment", "roof_job", "=", jobName]);
  if (auth.session.role !== "field") {
    return await listFrappeResource(env, "Job Assignment", baseFilters, 100);
  }
  const userId = auth.session.frappe_user_id;
  if (!userId) return [];
  const [direct, memberRows] = await Promise.all([
    listFrappeResource(
      env,
      "Job Assignment",
      [...baseFilters, ["Job Assignment", "assigned_user", "=", userId]],
      100,
    ),
    listFrappeResource(
      env,
      "Crew Member",
      [
        ["Crew Member", "crew_user", "=", userId],
        ["Crew Member", "active", "=", 1],
      ],
      100,
    ),
  ]);
  const crewProfiles = new Set(memberRows.flatMap((row) => {
    const parent = text(row.parent);
    const valid = row.parenttype === "Crew Profile" && row.parentfield === "members" && booleanValue(row.active) === true;
    return parent && valid && sameUser(row.crew_user, userId) ? [parent] : [];
  }));
  const crew = crewProfiles.size > 0
    ? await listFrappeResource(
      env,
      "Job Assignment",
      [...baseFilters, ["Job Assignment", "crew_profile", "in", [...crewProfiles]]],
      100,
    )
    : [];
  const deduplicated = new Map<string, FrappeRow>();
  for (const row of [...direct, ...crew]) {
    const id = text(row.name);
    const active = ACTIVE_ASSIGNMENT_STATUSES.includes(text(row.status) as never);
    const correctJob = !jobName || text(row.roof_job) === jobName;
    const allowed = sameUser(row.assigned_user, userId) || crewProfiles.has(text(row.crew_profile) ?? "");
    if (id && active && correctJob && allowed) deduplicated.set(id, row);
  }
  return [...deduplicated.values()];
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

function preferredAssignmentsByJob(rows: FrappeRow[]): Map<string, FrappeRow> {
  const grouped = groupBy(rows, "roof_job");
  return new Map([...grouped.entries()].flatMap(([job, assignments]) => {
    const preferred = preferredAssignment(assignments);
    return preferred ? [[job, preferred]] : [];
  }));
}

function preferredAssignment(rows: FrappeRow[]): FrappeRow | null {
  return [...rows].sort((left, right) => {
    const priority = (value: unknown) => ["In Progress", "Blocked", "Accepted", "Assigned"].indexOf(text(value) ?? "");
    const difference = priority(left.status) - priority(right.status);
    return difference || compareSchedule(text(left.scheduled_start), text(right.scheduled_start));
  })[0] ?? null;
}

function gateModel(row: FrappeRow, redactOwner: boolean): JobReadModel["gates"] {
  const gateId = text(row.gate_id) ?? text(row.name);
  return gateId ? [{
    id: gateId,
    name: text(row.gate),
    state: text(row.state),
    blocker_reason: text(row.blocker_reason),
    owner: redactOwner ? null : text(row.owner_user),
    due_at: text(row.due_at),
  }] : [];
}

function evidenceProofItem(row: FrappeRow): ProofStreamItem | null {
  const id = text(row.evidence_id) ?? text(row.name);
  return id ? {
    id,
    type: text(row.evidence_type),
    proof_slot: text(row.proof_slot),
    occurred_at: text(row.captured_at),
    summary: text(row.summary),
    customer_safe: booleanValue(row.customer_safe),
    source: text(row.source_system),
    sync_state: text(row.sync_state),
    blocker: false,
  } : null;
}

function checkInProofItem(row: FrappeRow): ProofStreamItem | null {
  const id = text(row.checkin_id) ?? text(row.name);
  return id ? {
    id,
    type: "Field Check-in",
    proof_slot: null,
    occurred_at: text(row.submitted_at),
    summary: text(row.blocker_summary) ?? text(row.notes),
    customer_safe: false,
    source: text(row.source_system),
    sync_state: text(row.sync_state),
    blocker: booleanValue(row.blocker_flag) === true,
  } : null;
}

function compareProofItems(left: ProofStreamItem, right: ProofStreamItem): number {
  return dateValue(right.occurred_at) - dateValue(left.occurred_at) || right.id.localeCompare(left.id);
}

function parseProofCursor(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d{1,6}$/.test(value)) return null;
  const offset = Number(value);
  return Number.isInteger(offset) && offset <= 100_000 ? offset : null;
}

function envelope(auth: AuthContext, rows: FrappeRow[], staleFields: string[]): ReadModelEnvelope {
  return {
    version: 1,
    source_updated_at: newestModified(rows),
    read_model_generated_at: new Date().toISOString(),
    stale_fields: staleFields,
    permissions: auth.permissions,
    allowed_actions: auth.session.role === "field"
      ? ["job.read.assigned", "field.checkin.create", "field.evidence.create"]
      : [
        "job.read", "lead.read", "lead_triage.read", "field_blocker.read", "incident.read", "finance_exception.read", "material_exception.read",
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
  return input.id ? [{
    id: input.id, kind: input.kind, severity: input.severity, title: input.title, why: input.why,
    next_action: null, job_id: input.jobId, occurred_at: input.occurredAt ?? null, due_at: input.dueAt ?? null,
    received_at: input.receivedAt ?? null, bus_status: input.busStatus ?? null,
    triage_status: input.triageStatus ?? null, mctb: input.mctb ?? null,
  }] : [];
}

export function mctbStatus(
  receivedAt: string | null,
  receipts: readonly LeadAckReceipt[],
  now: Date = new Date(),
): MctbStatus {
  const receivedMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
  if (!Number.isFinite(receivedMs)) {
    return {
      state: "time_unavailable", deadline_at: null, observed_at: null,
      channel: null, proof_kind: null,
    };
  }
  const deadlineMs = receivedMs + MCTB_SLA_MS;
  const deadlineAt = new Date(deadlineMs).toISOString();
  const accepted = receipts.find((receipt) => receipt.outcome === "provider_accepted");
  if (accepted) {
    const observedMs = Date.parse(accepted.observed_at);
    if (Number.isFinite(observedMs)) {
      return {
        state: observedMs <= deadlineMs ? "provider_accepted_within_sla" : "provider_accepted_late",
        deadline_at: deadlineAt,
        observed_at: accepted.observed_at,
        channel: accepted.channel === "email" ? "email" : null,
        proof_kind: "provider_receipt",
      };
    }
  }
  const noChannel = receipts.find((receipt) => receipt.outcome === "no_eligible_channel");
  if (noChannel) {
    return {
      state: "no_eligible_channel", deadline_at: deadlineAt, observed_at: noChannel.observed_at,
      channel: null, proof_kind: null,
    };
  }
  return {
    state: now.getTime() <= deadlineMs ? "awaiting_proof" : "unproven_after_sla",
    deadline_at: deadlineAt,
    observed_at: null,
    channel: null,
    proof_kind: null,
  };
}

function mctbMissedSla(mctb: MctbStatus | null): boolean {
  return mctb?.state === "provider_accepted_late" || mctb?.state === "unproven_after_sla";
}

function newestModified(rows: FrappeRow[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (typeof row.modified !== "string" || Number.isNaN(Date.parse(row.modified))) continue;
    if (!newest || Date.parse(row.modified) > Date.parse(newest)) newest = row.modified;
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

function mapRowsByReference(rows: FrappeRow[], field: string): Map<string, FrappeRow> {
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
    if (!current || recordIsNewer(row, current, versionField)) latest.set(key, row);
  }
  return latest;
}

function latestRecord(rows: FrappeRow[], versionField?: string): FrappeRow | null {
  let latest: FrappeRow | null = null;
  for (const row of rows) if (!latest || recordIsNewer(row, latest, versionField)) latest = row;
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

function recordIsNewer(candidate: FrappeRow, current: FrappeRow, versionField?: string): boolean {
  if (versionField) {
    const candidateVersion = optionalNumber(candidate[versionField]) ?? -1;
    const currentVersion = optionalNumber(current[versionField]) ?? -1;
    if (candidateVersion !== currentVersion) return candidateVersion > currentVersion;
  }
  const candidateModified = text(candidate.modified) ?? "";
  const currentModified = text(current.modified) ?? "";
  return candidateModified.localeCompare(currentModified) > 0
    || (candidateModified === currentModified && (text(candidate.name) ?? "").localeCompare(text(current.name) ?? "") > 0);
}

function salesEstimateModel(
  row: FrappeRow | undefined,
): SalesReadModel["leads"][number]["estimate"] {
  const id = row ? text(row.estimate_session_id) ?? text(row.name) : null;
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
  const id = row ? text(row.customer_quote_id) ?? text(row.name) : null;
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
  if (estimate?.status === "Captured" || estimate?.status === "Needs Review") attention.push("estimate_needs_review");
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
  return rank(left) - rank(right)
    || dateValue(right.received_at) - dateValue(left.received_at)
    || left.id.localeCompare(right.id);
}

function estimatorMeasurementSummary(
  row: FrappeRow,
): EstimatorWorkbenchReadModel["measurements"]["reports"] {
  const id = text(row.measurement_id) ?? text(row.name);
  return id ? [{
    id,
    provider: text(row.provider),
    review_status: text(row.review_status),
    parsed_at: text(row.parsed_at),
    approved_at: text(row.approved_at),
  }] : [];
}

async function safeEstimatorDetailRead(
  env: AppEnv,
  doctype: "Measurement Report" | "Material Takeoff",
  name: string,
): Promise<{ row: FrappeRow | null; unavailable_reason: string | null }> {
  try {
    return { row: await readOfficeEstimatorFrappeResource(env, doctype, name), unavailable_reason: null };
  } catch (error) {
    if (error instanceof Error && error.message === "frappe_read_response_too_large") {
      return {
        row: null,
        unavailable_reason: doctype === "Measurement Report"
          ? "measurement_detail_too_large"
          : "takeoff_detail_too_large",
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
  return Boolean(row && expectedName && text(row.name) === expectedName && text(row.roof_job) === jobName);
}

function matchesTakeoffDetail(
  row: FrappeRow | null,
  expectedName: string | null,
  jobName: string,
  measurementName: string | null,
): boolean {
  return Boolean(
    row
      && expectedName
      && measurementName
      && text(row.name) === expectedName
      && text(row.roof_job) === jobName
      && text(row.measurement_report) === measurementName,
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

function estimatorMeasurementSelection(
  row: FrappeRow | null,
  detail: FrappeRow | null,
  geometry: EstimatorGeometryProjection,
): EstimatorWorkbenchReadModel["measurements"]["selected"] {
  if (!row) return null;
  const [summary] = estimatorMeasurementSummary(row);
  if (!summary) return null;
  const metricRows = detail ? recordRows(detail.measurements) : [];
  return {
    ...summary,
    metrics: metricRows.slice(0, MAX_ESTIMATOR_METRICS).flatMap((metric) => {
      const name = text(metric.metric);
      return name ? [{
        metric: name,
        value: optionalNumber(metric.value),
        unit: text(metric.unit),
        confidence: text(metric.confidence),
        source_ref: text(metric.source_ref),
        needs_review: booleanValue(metric.needs_review) === true,
      }] : [];
    }),
    metrics_truncated: metricRows.length > MAX_ESTIMATOR_METRICS
      || booleanValue(detail?.__ironwrap_truncated_measurements) === true,
    geometry,
  };
}

function estimatorTakeoffSummary(
  row: FrappeRow,
): EstimatorWorkbenchReadModel["takeoffs"]["records"] {
  const id = text(row.takeoff_id) ?? text(row.name);
  return id ? [{
    id,
    measurement_report_id: text(row.measurement_report),
    status: text(row.status),
    prepared_at: text(row.prepared_at),
    approved_at: text(row.approved_at),
  }] : [];
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
    items_truncated: itemRows.length > MAX_ESTIMATOR_TAKEOFF_ITEMS
      || booleanValue(detail?.__ironwrap_truncated_items) === true,
  };
}

function estimatorQuote(row: FrappeRow | null): EstimatorQuoteProjection | null {
  const id = row ? text(row.customer_quote_id) ?? text(row.name) : null;
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
  const complete = Boolean(quote.price_book_version && quote.pricing_effective_at);
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
      state: currentVersion !== null && currentVersion > 1 ? "unlinked_revision" : "not_revised",
      prior_quote: null,
      delta: null,
    };
  }
  const prior = quotes.find((row) => text(row.name) === supersedes) ?? null;
  if (!prior) {
    return {
      state: quotes.length === ESTIMATOR_SOURCE_LIMIT ? "history_incomplete" : "prior_quote_missing",
      prior_quote: null,
      delta: null,
    };
  }
  const priorVersion = optionalNumber(prior.quote_version);
  if (currentVersion !== null && priorVersion !== null && priorVersion >= currentVersion) {
    return { state: "invalid_lineage", prior_quote: estimatorQuote(prior), delta: null };
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
    price_book_version_changed: valueChanged(current.price_book_version, prior.price_book_version),
    pricing_effective_at_changed: valueChanged(current.pricing_effective_at, prior.pricing_effective_at),
    tax_code_changed: valueChanged(current.tax_code, prior.tax_code),
    tax_rate_changed: valueChanged(current.tax_rate, prior.tax_rate),
    currency_changed: valueChanged(current.currency, prior.currency),
    scope_summary_changed: valueChanged(current.scope_summary, prior.scope_summary),
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
  return [{
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
  }];
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
  const reasons: EstimatorWorkbenchReadModel["proposal_readiness"]["reasons"] = [];
  if (!measurement) reasons.push("measurement_missing");
  else if (geometry.state !== "recomputed") reasons.push("measurement_source_review_required");
  if (takeoffLineage !== "linked" || !takeoff || !takeoffDetail) reasons.push("takeoff_link_missing");
  else if (text(takeoff.status) !== "Approved") reasons.push("takeoff_not_approved");
  if (!quote) reasons.push("quote_missing");
  else {
    if (pricingSnapshot.state === "incomplete" || pricingSnapshot.state === "unavailable") {
      reasons.push("quote_snapshot_incomplete");
    }
    if (quote.status !== "Approved" && quote.status !== "Accepted") reasons.push("quote_not_approved");
  }
  if (proposalLineage === "mismatch") reasons.push("proposal_link_mismatch");
  if (scopeChanges.some((change) =>
    change.quote_link === "selected_quote"
      && ["Draft", "Needs Review", "Approved", "Presented"].includes(change.status ?? ""),
  )) {
    reasons.push("scope_change_unresolved");
  }
  if (partialSources.length > 0) reasons.push("source_window_partial");
  if (staleFields.length > 0) reasons.push("stale_source_detail");
  const unavailable = reasons.includes("source_window_partial") || reasons.includes("stale_source_detail");
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
    state: unavailable ? "unavailable" : blocked ? "blocked" : reasons.length > 0 ? "review_required" : "ready",
    reasons,
  };
}

function estimatorProposal(row: FrappeRow | null): EstimatorWorkbenchReadModel["proposal"] {
  const id = row ? text(row.pack_id) ?? text(row.name) : null;
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
  return id ? [{
    id,
    type: text(row.clause_type),
    title: text(row.title),
    text: text(row.clause_text),
    version: text(row.version),
    status: text(row.status),
    source_ref: text(row.source_ref),
    customer_visible: booleanValue(row.customer_visible) === true,
    approved_at: text(row.approved_at),
  }] : [];
}

async function estimatorGeometryFromRaw(
  env: AppEnv,
  rawKey: string | null,
): Promise<EstimatorGeometryProjection> {
  if (!rawKey) return unavailableEstimatorGeometry("raw_source_not_recorded");
  if (!validMeasurementRawKey(rawKey)) return unavailableEstimatorGeometry("raw_source_rejected");
  try {
    const source = await env.RAW.get(rawKey);
    if (!source) return unavailableEstimatorGeometry("raw_source_not_found");
    if (source.size > MAX_ESTIMATOR_RAW_BYTES) return unavailableEstimatorGeometry("raw_source_too_large");
    const rawText = await source.text();
    const geometry = extractGeometry(rawText, parseBody(rawText, "application/json"));
    if (!geometry) return unavailableEstimatorGeometry("raw_source_not_recomputable");
    const failedChecks = geometry.checks.filter((check) => !check.ok);
    return {
      state: geometry.needsReview ? "needs_review" : "recomputed",
      reason: null,
      check_count: geometry.checks.length,
      failed_check_count: failedChecks.length,
      checks_truncated: geometry.checks.length > MAX_ESTIMATOR_CHECKS,
      facet_count: geometry.facets.length,
      facets_truncated: geometry.facets.length > MAX_ESTIMATOR_FACETS,
      metrics_truncated: Object.keys(geometry.measurements).length > MAX_ESTIMATOR_METRICS,
      checks: geometry.checks.slice(0, MAX_ESTIMATOR_CHECKS).map((check) => ({
        check: boundedGeometryText(check.check, MAX_ESTIMATOR_GEOMETRY_LABEL),
        target: boundedGeometryText(check.target, MAX_ESTIMATOR_GEOMETRY_LABEL),
        ok: check.ok,
        detail: boundedGeometryText(check.detail, MAX_ESTIMATOR_GEOMETRY_DETAIL),
      })),
      facets: geometry.facets.slice(0, MAX_ESTIMATOR_FACETS).map((facet) => ({
        id: boundedGeometryText(facet.id, MAX_ESTIMATOR_GEOMETRY_LABEL),
        type: boundedGeometryText(facet.type, MAX_ESTIMATOR_GEOMETRY_LABEL),
        material: facet.material ? boundedGeometryText(facet.material, MAX_ESTIMATOR_GEOMETRY_LABEL) : null,
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
            ? boundedGeometryText(geometry.sourceRefs[metric], MAX_ESTIMATOR_GEOMETRY_DETAIL)
            : null,
        })),
    };
  } catch {
    return unavailableEstimatorGeometry("raw_source_read_failed");
  }
}

function unavailableEstimatorGeometry(reason: string): EstimatorGeometryProjection {
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
  return /^raw\/measurements\/\d{4}-\d{2}-\d{2}\/ow_[0-9a-f-]{36}\.json$/.test(value);
}

function boundedGeometryText(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}

function recordRows(value: unknown): FrappeRow[] {
  return Array.isArray(value)
    ? value.filter((row): row is FrappeRow => !!row && typeof row === "object" && !Array.isArray(row))
    : [];
}

function address(row: FrappeRow | undefined): string | null {
  if (!row) return null;
  const locality = [text(row.city), text(row.province), text(row.postal_code)].filter(notNull).join(" ");
  const parts = [text(row.address_line1), locality || null, text(row.country)].filter(notNull);
  return parts.length > 0 ? parts.join(", ") : null;
}

function tenantDate(timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "America/Edmonton", year: "numeric", month: "2-digit", day: "2-digit",
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
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberDelta(current: unknown, prior: unknown): number | null {
  const currentNumber = optionalNumber(current);
  const priorNumber = optionalNumber(prior);
  return currentNumber === null || priorNumber === null ? null : currentNumber - priorNumber;
}

function valueChanged(current: unknown, prior: unknown): boolean {
  const currentText = text(current);
  const priorText = text(prior);
  if (currentText !== null || priorText !== null) return currentText !== priorText;
  return optionalNumber(current) !== optionalNumber(prior);
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
