import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  isFrappeJobAssigned,
  listFrappeResource,
  publicFrappeRow,
  type FrappeFilter,
  type FrappeRow,
} from "./frappe-read.ts";

const ACTIVE_JOB_STATUSES = ["Won", "In Production"] as const;

interface ReadModelEnvelope {
  version: number;
  source_updated_at: string | null;
  read_model_generated_at: string;
  stale_fields: string[];
  permissions: string[];
  allowed_actions: string[];
}

export interface TodayReadModel extends ReadModelEnvelope {
  date: string;
  jobs: Array<{
    id: string;
    job_number: string | null;
    brand: string | null;
    status: string | null;
    address: string | null;
    scheduled_start: null;
    scheduled_end: null;
    blocked_gate_count: number;
    next_action: string | null;
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
  gates: Array<{
    id: string;
    name: string | null;
    state: string | null;
    blocker_reason: string | null;
    owner: string | null;
    due_at: string | null;
  }>;
  proof_stream: Array<{
    id: string;
    type: string | null;
    occurred_at: string | null;
    summary: string | null;
    customer_safe: boolean | null;
    source: string | null;
  }>;
  required_proof: unknown[];
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

export async function buildTodayReadModel(env: AppEnv, auth: AuthContext): Promise<TodayReadModel> {
  const filters: FrappeFilter[] = [["Roof Job", "job_status", "in", [...ACTIVE_JOB_STATUSES]]];
  if (auth.session.role === "field") {
    const assignee = auth.session.frappe_user_id;
    if (!assignee) return {
      ...envelope(auth, [], ["jobs.scheduled_start", "jobs.scheduled_end", "jobs.next_action"]),
      date: tenantDate(env.APP_TIME_ZONE),
      jobs: [],
    };
    filters.push(["Roof Job", "_assign", "like", `%\"${escapeLike(assignee)}\"%`]);
  }

  const rows = await listFrappeResource(env, "Roof Job", filters, 50);
  const authorized = auth.session.role === "field"
    ? rows.filter((row) => isFrappeJobAssigned(row, auth.session.frappe_user_id))
    : rows;
  const jobIds = authorized.map((row) => text(row.name)).filter(notNull);
  const propertyIds = authorized.map((row) => text(row.roofing_property)).filter(notNull);
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
  const blockedByJob = new Map<string, FrappeRow[]>();
  for (const gate of blockedGates) {
    const jobId = text(gate.roof_job);
    if (!jobId) continue;
    const existing = blockedByJob.get(jobId) ?? [];
    existing.push(gate);
    blockedByJob.set(jobId, existing);
  }

  const jobs = authorized.flatMap((row) => {
    const id = text(row.name);
    if (!id) return [];
    const blocked = blockedByJob.get(id) ?? [];
    const property = propertyById.get(text(row.roofing_property));
    return [{
      id,
      job_number: text(row.job_number),
      brand: text(row.brand),
      status: text(row.job_status),
      address: address(property),
      scheduled_start: null,
      scheduled_end: null,
      blocked_gate_count: blocked.length,
      next_action: null,
    }];
  });
  const stale = ["jobs.scheduled_start", "jobs.scheduled_end", "jobs.next_action"];
  if (properties.length < new Set(propertyIds).size) stale.push("jobs.address");
  return {
    ...envelope(auth, [...authorized, ...blockedGates, ...properties], stale),
    date: tenantDate(env.APP_TIME_ZONE),
    jobs,
  };
}

export async function buildJobReadModel(
  env: AppEnv,
  auth: AuthContext,
  jobName: string,
): Promise<JobReadModel | null> {
  if (!validJobName(jobName)) return null;
  const jobs = await listFrappeResource(env, "Roof Job", [["Roof Job", "name", "=", jobName]], 1);
  const job = jobs[0];
  if (!job) return null;
  if (auth.session.role === "field" && !isFrappeJobAssigned(job, auth.session.frappe_user_id)) return null;

  const propertyId = text(job.roofing_property);
  const [gates, evidence, checkIns, propertyRows] = await Promise.all([
    listFrappeResource(env, "Production Gate State", [["Production Gate State", "roof_job", "=", jobName]], 50),
    listFrappeResource(env, "Evidence Item", [["Evidence Item", "roof_job", "=", jobName]], 100),
    listFrappeResource(env, "Field Check-in", [["Field Check-in", "roof_job", "=", jobName]], 50),
    propertyId
      ? listFrappeResource(env, "Roofing Property", [["Roofing Property", "name", "=", propertyId]], 1)
      : Promise.resolve([]),
  ]);
  const property = propertyRows[0];
  const proofStream = [
    ...evidence.flatMap((row) => {
      const id = text(row.evidence_id) ?? text(row.name);
      return id ? [{
        id,
        type: text(row.evidence_type),
        occurred_at: text(row.captured_at),
        summary: text(row.summary),
        customer_safe: booleanValue(row.customer_safe),
        source: text(row.source_system),
      }] : [];
    }),
    ...checkIns.flatMap((row) => {
      const id = text(row.checkin_id) ?? text(row.name);
      return id ? [{
        id,
        type: "Field Check-in",
        occurred_at: text(row.submitted_at),
        summary: text(row.notes),
        customer_safe: null,
        source: text(row.source_system),
      }] : [];
    }),
  ].sort((left, right) => Date.parse(right.occurred_at ?? "") - Date.parse(left.occurred_at ?? ""));

  const id = text(job.name)!;
  const stale = ["required_proof"];
  if (gates.some((row) => !text(row.owner_user))) stale.push("gates.owner");
  if (gates.some((row) => !text(row.due_at))) stale.push("gates.due_at");
  if (propertyId && !property) stale.push("job.address");
  return {
    ...envelope(auth, [publicFrappeRow(job), ...gates, ...evidence, ...checkIns, ...propertyRows], stale),
    job: {
      id,
      roof_job_id: text(job.roof_job_id),
      job_number: text(job.job_number),
      brand: text(job.brand),
      service_type: text(job.service_type),
      status: text(job.job_status),
      address: address(property),
      current_gate_state: text(job.current_gate_state),
    },
    gates: gates.flatMap((row) => {
      const gateId = text(row.gate_id) ?? text(row.name);
      return gateId ? [{
        id: gateId,
        name: text(row.gate),
        state: text(row.state),
        blocker_reason: text(row.blocker_reason),
        owner: text(row.owner_user),
        due_at: text(row.due_at),
      }] : [];
    }),
    proof_stream: proofStream,
    required_proof: [],
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
      id: text(row.gate_id) ?? text(row.name),
      kind: "blocked_gate",
      severity: null,
      title: `${text(row.gate) ?? "Production"} gate blocked`,
      why: text(row.blocker_reason),
      jobId: text(row.roof_job),
      dueAt: text(row.due_at),
    })),
    ...incidents.flatMap((row) => exceptionRow(row, {
      id: text(row.incident_id) ?? text(row.name),
      kind: "automation_incident",
      severity: text(row.severity),
      title: text(row.summary) ?? "Automation incident",
      why: text(row.category),
      jobId: text(row.roof_job),
    })),
    ...payments.flatMap((row) => exceptionRow(row, {
      id: text(row.payment_milestone_id) ?? text(row.name),
      kind: "finance_exception",
      severity: null,
      title: `${text(row.milestone_type) ?? "Payment"} needs review`,
      why: text(row.notes) ?? text(row.status),
      jobId: text(row.roof_job),
      dueAt: text(row.due_date),
    })),
    ...leads.flatMap((row) => exceptionRow(row, {
      id: text(row.envelope_id) ?? text(row.name),
      kind: "new_lead",
      severity: null,
      title: text(row.contact_name) ? `New lead: ${text(row.contact_name)}` : "New lead",
      why: text(row.intent_queue) ?? text(row.source),
      jobId: text(row.job_ref),
    })),
    ...supplierOrders.flatMap((row) => exceptionRow(row, {
      id: text(row.supplier_order_id) ?? text(row.name),
      kind: "material_exception",
      severity: null,
      title: `Supplier order ${text(row.status) ?? "needs review"}`,
      why: text(row.delivery_notes),
      jobId: text(row.roof_job),
      dueAt: text(row.requested_delivery_date),
    })),
  ];
  const stale = ["exceptions.next_action"];
  if (exceptions.some((row) => row.due_at === null)) stale.push("exceptions.due_at");
  return {
    ...envelope(
      auth,
      [...jobs, ...gates, ...incidents, ...payments, ...leads, ...supplierOrders],
      stale,
    ),
    exceptions,
    summary: {
      active_jobs: jobs.length,
      blocked_gates: gates.length,
      open_incidents: incidents.length,
      finance_exceptions: payments.length,
      new_leads: leads.length,
      material_exceptions: supplierOrders.length,
    },
  };
}

function envelope(auth: AuthContext, rows: FrappeRow[], staleFields: string[]): ReadModelEnvelope {
  return {
    version: 1,
    source_updated_at: newestModified(rows),
    read_model_generated_at: new Date().toISOString(),
    stale_fields: staleFields,
    permissions: auth.permissions,
    allowed_actions: auth.session.role === "field"
      ? ["job.read", "gate.read", "evidence.read", "checkin.read"]
      : [
        "job.read", "gate.read", "evidence.read", "checkin.read", "lead.read",
        "incident.read", "finance_exception.read", "material_exception.read",
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
    dueAt?: string | null;
  },
): OwnerNowReadModel["exceptions"] {
  return input.id ? [{
    id: input.id,
    kind: input.kind,
    severity: input.severity,
    title: input.title,
    why: input.why,
    next_action: null,
    job_id: input.jobId,
    due_at: input.dueAt ?? null,
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

function address(row: FrappeRow | undefined): string | null {
  if (!row) return null;
  const locality = [text(row.city), text(row.province), text(row.postal_code)].filter(notNull).join(" ");
  const parts = [text(row.address_line1), locality || null, text(row.country)].filter(notNull);
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

function validJobName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _./:#()\-]{0,139}$/.test(value);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}
