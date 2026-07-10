import type { AppEnv } from "./app-types.ts";

export type FrappeDocType = keyof typeof FRAPPE_READ_FIELDS;
export type FrappeFilter = readonly [
  doctype: FrappeDocType,
  field: string,
  operator: string,
  value: unknown,
];
export type FrappeRow = Record<string, unknown>;

/**
 * The only DocTypes and fields the PWA BFF may ask the privileged Frappe integration user for.
 * Standard `modified` supports freshness metadata. Field authorization comes only from the
 * explicit Job Assignment domain record; Frappe's generic `_assign` field is intentionally absent.
 */
export const FRAPPE_READ_FIELDS = {
  "Roof Job": [
    "name", "roof_job_id", "job_number", "brand", "service_type", "job_status",
    "roofing_property", "customer", "current_gate_state", "modified",
  ],
  "Job Assignment": [
    "name", "assignment_id", "roof_job", "assignment_type", "status", "crew_profile",
    "assigned_user", "scheduled_start", "scheduled_end", "blocker_reason", "modified",
  ],
  "Crew Member": [
    "name", "parent", "parenttype", "parentfield", "crew_user", "crew_role", "active",
    "joined_on", "left_on", "modified",
  ],
  "Roofing Property": [
    "name", "address_line1", "city", "province", "postal_code", "country", "modified",
  ],
  "Roofing Customer": ["name", "display_name", "phone", "modified"],
  "Production Gate State": [
    "name", "gate_id", "roof_job", "gate", "state", "owner_user", "assigned_at", "due_at",
    "blocker_reason", "modified",
  ],
  "Evidence Item": [
    "name", "evidence_id", "device_action_id", "roof_job", "evidence_type", "proof_slot",
    "source_system", "r2_key", "content_checksum", "content_type", "content_length",
    "capture_actor", "captured_at", "customer_safe", "correction_of", "summary", "sync_state", "modified",
  ],
  "Field Check-in": [
    "name", "checkin_id", "device_action_id", "roof_job", "job_assignment", "source_system",
    "capture_actor", "submitted_at", "status", "sync_state", "photo_count", "blocker_flag", "blocker_category",
    "blocker_summary", "evidence_ids_json", "correction_of", "notes", "raw_key", "modified",
  ],
  "Scope Clause": [
    "name", "scope_clause_id", "roof_job", "clause_type", "title", "clause_text", "version",
    "status", "customer_visible", "modified",
  ],
  "Measurement Report": [
    "name", "measurement_id", "roof_job", "provider", "review_status", "parsed_at", "modified",
  ],
  "Material Takeoff": [
    "name", "takeoff_id", "roof_job", "measurement_report", "status", "prepared_at", "modified",
  ],
  "Change Order": [
    "name", "change_order_id", "roof_job", "change_number", "version", "status", "title",
    "reason", "scope_delta", "accepted_at", "modified",
  ],
  "Safety Plan": [
    "name", "safety_plan_id", "roof_job", "version", "status", "effective_date",
    "hazard_summary", "controls", "emergency_plan", "ppe_requirements", "weather_limits", "modified",
  ],
  "Automation Incident": [
    "name", "incident_id", "status", "severity", "category", "summary", "roof_job", "detected_at", "modified",
  ],
  "Payment Milestone": [
    "name", "payment_milestone_id", "roof_job", "milestone_type", "status", "due_date",
    "event_ts", "notes", "modified",
  ],
  "Lead Envelope": [
    "name", "envelope_id", "source", "event_ts", "status", "intent_queue", "triage_status",
    "contact_name", "job_ref", "modified",
  ],
  "Supplier Order": [
    "name", "supplier_order_id", "roof_job", "status", "prepared_at", "requested_delivery_date",
    "delivery_notes", "modified",
  ],
} as const;

export function frappeReadConfigured(env: AppEnv): boolean {
  if (!env.ERPNEXT_API_KEY?.trim() || !env.ERPNEXT_API_SECRET?.trim()) return false;
  try {
    frappeBaseUrl(env);
    return true;
  } catch {
    return false;
  }
}

const FILTER_FIELDS: Readonly<Record<FrappeDocType, ReadonlySet<string>>> = {
  "Roof Job": new Set(["name", "job_status"]),
  "Job Assignment": new Set(["name", "roof_job", "status", "assigned_user", "crew_profile"]),
  "Crew Member": new Set(["parent", "crew_user", "active"]),
  "Roofing Property": new Set(["name"]),
  "Roofing Customer": new Set(["name"]),
  "Production Gate State": new Set(["roof_job", "state"]),
  "Evidence Item": new Set(["name", "roof_job", "evidence_id", "device_action_id"]),
  "Field Check-in": new Set(["name", "roof_job", "checkin_id", "device_action_id", "blocker_flag", "status", "sync_state"]),
  "Scope Clause": new Set(["roof_job", "status"]),
  "Measurement Report": new Set(["roof_job", "review_status"]),
  "Material Takeoff": new Set(["roof_job", "status"]),
  "Change Order": new Set(["roof_job", "status"]),
  "Safety Plan": new Set(["roof_job", "status"]),
  "Automation Incident": new Set(["status"]),
  "Payment Milestone": new Set(["status"]),
  "Lead Envelope": new Set(["status", "triage_status"]),
  "Supplier Order": new Set(["roof_job", "status"]),
};

const FILTER_OPERATORS = new Set(["=", "in", "like"]);

export async function listFrappeResource(
  env: AppEnv,
  doctype: FrappeDocType,
  filters: readonly FrappeFilter[] = [],
  limit = 50,
): Promise<FrappeRow[]> {
  return await listFrappeResourcePage(env, doctype, filters, limit, 0);
}

export async function listFrappeResourcePage(
  env: AppEnv,
  doctype: FrappeDocType,
  filters: readonly FrappeFilter[] = [],
  limit = 50,
  offset = 0,
): Promise<FrappeRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("frappe_read_invalid_limit");
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error("frappe_read_invalid_offset");
  for (const filter of filters) {
    if (filter[0] !== doctype || !FILTER_FIELDS[doctype].has(filter[1]) || !FILTER_OPERATORS.has(filter[2])) {
      throw new Error("frappe_read_filter_not_allowed");
    }
  }

  const base = frappeBaseUrl(env);
  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET) throw new Error("frappe_read_not_configured");
  const params = new URLSearchParams({
    fields: JSON.stringify(FRAPPE_READ_FIELDS[doctype]),
    filters: JSON.stringify(filters),
    order_by: "modified desc, name desc",
    limit_page_length: String(limit),
    limit_start: String(offset),
  });
  const url = `${base}/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`;
  const timeout = frappeRequestTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`,
        "user-agent": "ironwrap-bff/1.0",
      },
    });
    if (!response.ok) throw new Error(`frappe_read_http_${response.status}`);
    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      throw new Error("frappe_read_invalid_json");
    }
    const data = decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as { data?: unknown }).data
      : null;
    if (!Array.isArray(data)) throw new Error("frappe_read_invalid_shape");
    return data.slice(0, limit).filter(isRecord).map((row) => projectRow(doctype, row));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("frappe_read_timeout");
    if (error instanceof Error && error.message.startsWith("frappe_read_")) throw error;
    throw new Error("frappe_read_network_error");
  } finally {
    clearTimeout(timer);
  }
}

export function publicFrappeRow(row: FrappeRow): FrappeRow {
  return { ...row };
}

function projectRow(doctype: FrappeDocType, row: FrappeRow): FrappeRow {
  const allowed = new Set<string>(FRAPPE_READ_FIELDS[doctype]);
  const projected: FrappeRow = {};
  for (const [key, value] of Object.entries(row)) if (allowed.has(key)) projected[key] = value;
  return projected;
}

export function frappeBaseUrl(env: AppEnv): string {
  if (!env.ERPNEXT_BASE_URL) throw new Error("frappe_read_not_configured");
  let url: URL;
  try {
    url = new URL(env.ERPNEXT_BASE_URL);
  } catch {
    throw new Error("frappe_read_bad_base_url");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(String(env.APP_ALLOW_INSECURE_LOCAL) === "true" && local && url.protocol === "http:")) {
    throw new Error("frappe_read_bad_base_url");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("frappe_read_bad_base_url");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

export function frappeRequestTimeout(raw: string | undefined): number {
  const parsed = Number(raw ?? "8000");
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 20_000 ? parsed : 8_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
