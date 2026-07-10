import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  listFrappeResource,
  listFrappeResourcePage,
  publicFrappeRow,
  type FrappeFilter,
  type FrappeRow,
} from "./frappe-read.ts";

const ACTIVE_JOB_STATUSES = ["Won", "In Production"] as const;
export const ACTIVE_ASSIGNMENT_STATUSES = ["Assigned", "Accepted", "In Progress", "Blocked"] as const;
const FIELD_PACKET_PROOF_PAGE_SIZE = 100;

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
    due_at: string | null;
  }>;
  summary: {
    active_jobs: number;
    blocked_gates: number;
    open_incidents: number;
    finance_exceptions: number;
    new_leads: number;
    material_exceptions: number;
  };
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

export async function buildOwnerNowReadModel(env: AppEnv, auth: AuthContext): Promise<OwnerNowReadModel> {
  if (auth.session.role !== "owner" && auth.session.role !== "ops") throw new Error("owner_scope_required");
  const [jobs, gates, incidents, payments, leads, supplierOrders] = await Promise.all([
    listFrappeResource(env, "Roof Job", [["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]]], 50),
    listFrappeResource(env, "Production Gate State", [["Production Gate State", "state", "=", "Blocked"]], 50),
    listFrappeResource(env, "Automation Incident", [["Automation Incident", "status", "in", ["Open", "Acknowledged"]]], 50),
    listFrappeResource(env, "Payment Milestone", [["Payment Milestone", "status", "in", ["Webhook Seen", "Needs Review"]]], 50),
    listFrappeResource(env, "Lead Envelope", [["Lead Envelope", "status", "in", ["received", "pending_jn_push"]]], 50),
    listFrappeResource(env, "Supplier Order", [["Supplier Order", "status", "in", ["Needs Review", "Shortage"]]], 50),
  ]);
  const exceptions: OwnerNowReadModel["exceptions"] = [
    ...gates.flatMap((row) => exceptionRow(row, {
      id: text(row.gate_id) ?? text(row.name), kind: "blocked_gate", severity: null,
      title: `${text(row.gate) ?? "Production"} gate blocked`, why: text(row.blocker_reason),
      jobId: text(row.roof_job), dueAt: text(row.due_at),
    })),
    ...incidents.flatMap((row) => exceptionRow(row, {
      id: text(row.incident_id) ?? text(row.name), kind: "automation_incident", severity: text(row.severity),
      title: text(row.summary) ?? "Automation incident", why: text(row.category), jobId: text(row.roof_job),
    })),
    ...payments.flatMap((row) => exceptionRow(row, {
      id: text(row.payment_milestone_id) ?? text(row.name), kind: "finance_exception", severity: null,
      title: `${text(row.milestone_type) ?? "Payment"} needs review`, why: text(row.notes) ?? text(row.status),
      jobId: text(row.roof_job), dueAt: text(row.due_date),
    })),
    ...leads.flatMap((row) => exceptionRow(row, {
      id: text(row.envelope_id) ?? text(row.name), kind: "new_lead", severity: null,
      title: text(row.contact_name) ? `New lead: ${text(row.contact_name)}` : "New lead",
      why: text(row.intent_queue) ?? text(row.source), jobId: text(row.job_ref),
    })),
    ...supplierOrders.flatMap((row) => exceptionRow(row, {
      id: text(row.supplier_order_id) ?? text(row.name), kind: "material_exception", severity: null,
      title: `Supplier order ${text(row.status) ?? "needs review"}`, why: text(row.delivery_notes),
      jobId: text(row.roof_job), dueAt: text(row.requested_delivery_date),
    })),
  ];
  const stale = ["exceptions.next_action"];
  if (exceptions.some((row) => row.due_at === null)) stale.push("exceptions.due_at");
  return {
    ...envelope(auth, [...jobs, ...gates, ...incidents, ...payments, ...leads, ...supplierOrders], stale),
    exceptions,
    summary: {
      active_jobs: jobs.length, blocked_gates: gates.length, open_incidents: incidents.length,
      finance_exceptions: payments.length, new_leads: leads.length, material_exceptions: supplierOrders.length,
    },
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
        "job.read", "lead.read", "incident.read", "finance_exception.read", "material_exception.read",
      ],
  };
}

function exceptionRow(
  _row: FrappeRow,
  input: { id: string | null; kind: string; severity: string | null; title: string; why: string | null; jobId: string | null; dueAt?: string | null },
): OwnerNowReadModel["exceptions"] {
  return input.id ? [{
    id: input.id, kind: input.kind, severity: input.severity, title: input.title, why: input.why,
    next_action: null, job_id: input.jobId, due_at: input.dueAt ?? null,
  }] : [];
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
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
