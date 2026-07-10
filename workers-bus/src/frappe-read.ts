import type { AppEnv } from "./app-types.ts";

export type FrappeDocType = keyof typeof FRAPPE_READ_FIELDS;
export type FrappeFilter = readonly [doctype: FrappeDocType, field: string, operator: string, value: unknown];
export type FrappeRow = Record<string, unknown>;

/**
 * The only DocTypes and fields the PWA BFF may ask the privileged Frappe integration user for.
 * Standard `modified` supports freshness metadata; `_assign` is used only for field authorization
 * and is stripped before any response is returned.
 */
export const FRAPPE_READ_FIELDS = {
  "Roof Job": [
    "name", "roof_job_id", "job_number", "brand", "service_type", "job_status",
    "roofing_property", "current_gate_state", "modified", "_assign",
  ],
  "Roofing Property": [
    "name", "address_line1", "city", "province", "postal_code", "country", "modified",
  ],
  "Production Gate State": [
    "name", "gate_id", "roof_job", "gate", "state", "owner_user", "due_at",
    "blocker_reason", "modified",
  ],
  "Evidence Item": [
    "name", "evidence_id", "roof_job", "evidence_type", "source_system", "captured_at",
    "customer_safe", "summary", "modified",
  ],
  "Field Check-in": [
    "name", "checkin_id", "roof_job", "source_system", "submitted_at", "notes", "modified",
  ],
  "Automation Incident": [
    "name", "incident_id", "status", "severity", "category", "summary", "roof_job", "modified",
  ],
  "Payment Milestone": [
    "name", "payment_milestone_id", "roof_job", "milestone_type", "status", "due_date",
    "notes", "modified",
  ],
  "Lead Envelope": [
    "name", "envelope_id", "source", "status", "intent_queue", "contact_name", "job_ref", "modified",
  ],
  "Supplier Order": [
    "name", "supplier_order_id", "roof_job", "status", "requested_delivery_date",
    "delivery_notes", "modified",
  ],
} as const;

export function frappeReadConfigured(env: AppEnv): boolean {
  if (!env.ERPNEXT_API_KEY?.trim() || !env.ERPNEXT_API_SECRET?.trim()) return false;
  try {
    normalizeFrappeBaseUrl(env);
    return true;
  } catch {
    return false;
  }
}

const FILTER_FIELDS: Readonly<Record<FrappeDocType, ReadonlySet<string>>> = {
  "Roof Job": new Set(["name", "job_status", "_assign"]),
  "Roofing Property": new Set(["name"]),
  "Production Gate State": new Set(["roof_job", "state"]),
  "Evidence Item": new Set(["roof_job"]),
  "Field Check-in": new Set(["roof_job"]),
  "Automation Incident": new Set(["status"]),
  "Payment Milestone": new Set(["status"]),
  "Lead Envelope": new Set(["status"]),
  "Supplier Order": new Set(["status"]),
};

const FILTER_OPERATORS = new Set(["=", "in", "like"]);

export async function listFrappeResource(
  env: AppEnv,
  doctype: FrappeDocType,
  filters: readonly FrappeFilter[] = [],
  limit = 50,
): Promise<FrappeRow[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("frappe_read_invalid_limit");
  for (const filter of filters) {
    if (filter[0] !== doctype || !FILTER_FIELDS[doctype].has(filter[1]) || !FILTER_OPERATORS.has(filter[2])) {
      throw new Error("frappe_read_filter_not_allowed");
    }
  }

  const base = normalizeFrappeBaseUrl(env);
  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET) throw new Error("frappe_read_not_configured");
  const params = new URLSearchParams({
    fields: JSON.stringify(FRAPPE_READ_FIELDS[doctype]),
    filters: JSON.stringify(filters),
    order_by: "modified desc",
    limit_page_length: String(limit),
  });
  const url = `${base}/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`;
  const timeout = boundedTimeout(env.APP_FRAPPE_REQUEST_TIMEOUT_MS);
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

export function isFrappeJobAssigned(row: FrappeRow, frappeUserId: string | null): boolean {
  if (!frappeUserId) return false;
  const raw = row._assign;
  if (typeof raw !== "string") return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return false;
    const expected = frappeUserId.trim().toLowerCase();
    return parsed.some((value) => typeof value === "string" && value.trim().toLowerCase() === expected);
  } catch {
    return false;
  }
}

export function publicFrappeRow(row: FrappeRow): FrappeRow {
  const { _assign: _authorizationOnly, ...safe } = row;
  return safe;
}

function projectRow(doctype: FrappeDocType, row: FrappeRow): FrappeRow {
  const allowed = new Set<string>(FRAPPE_READ_FIELDS[doctype]);
  const projected: FrappeRow = {};
  for (const [key, value] of Object.entries(row)) if (allowed.has(key)) projected[key] = value;
  return projected;
}

function normalizeFrappeBaseUrl(env: AppEnv): string {
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

function boundedTimeout(raw: string | undefined): number {
  const parsed = Number(raw ?? "8000");
  return Number.isInteger(parsed) && parsed >= 1_000 && parsed <= 20_000 ? parsed : 8_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
