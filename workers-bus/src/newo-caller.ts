import { newoAdmissionJson, newoProducerTenantCheck } from "./newo-event-admission.ts";
import type { AppEnv } from "./app-types.ts";
import { normalizePhone } from "./core.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  claimNewoReceipt,
  completeNewoReceipt,
  failNewoReceipt,
  getNewoReceipt,
  getNewoSession,
  recordNewoCallerAssociation,
  restartFailedNewoReceipt,
  touchNewoReceipt,
} from "./newo-store.ts";
import { tenantIdFrom } from "./operating-core.ts";
import * as store from "./store.ts";

const SCHEMA_VERSION = "newo.caller-lookup.v1" as const;
const RESPONSE_VERSION = "newo.caller-lookup-response.v1" as const;
const MAX_BODY_BYTES = 16 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface NewoCallerLookupRequest {
  schema_version: typeof SCHEMA_VERSION;
  request_id: string;
  session_id: string;
  occurred_at: string;
  caller_phone: string;
  provider: {
    project_id: string | null;
    agent_id: string | null;
  };
  verification: {
    address_line1: string | null;
    postal_code: string | null;
  };
}

export interface NewoCallerLookupResponse {
  schema_version: typeof RESPONSE_VERSION;
  request_id: string;
  session_id: string;
  match_status: "verified" | "not_found" | "verification_failed" | "ambiguous";
  verified: boolean;
  job_state: "Planning" | "In progress" | "Completed" | "Needs staff review" | null;
  safe_next_step:
    | "continue_verified_service"
    | "capture_new_lead"
    | "ask_for_address_or_postal_code"
    | "offer_staff_callback";
}

type Parsed =
  | { ok: true; value: NewoCallerLookupRequest }
  | { ok: false; issues: string[] };

interface VerifiedAssociation {
  customerId: string;
  propertyId: string;
  roofJobId: string;
  jobState: NewoCallerLookupResponse["job_state"];
}

interface CallerJobRow {
  roof_job_id: string;
  job_status: string;
  updated_at: string;
  property_key: string;
  address_line1: string | null;
  postal_code: string | null;
}

export async function handleNewoCallerLookup(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const rawText = await readBounded(req);
  if (rawText === null) return json({ error: "payload_too_large" }, 413);
  const parsed = parseNewoCallerLookup(rawText);
  if (!parsed.ok) return json({ error: "invalid_payload", issues: parsed.issues }, 422);
  const input = parsed.value;
  const binding = await newoProducerTenantCheck(env, input.session_id);
  if (!binding.ok) return json({ error: binding.error }, binding.status);
  const hash = await sha256Hex(canonicalJson(input));
  const existing = await getNewoReceipt(env, input.request_id);
  if (existing && existing.tenant_id !== binding.tenantId) {
    return json({ error: existing.tenant_id ? "newo_receipt_tenant_mismatch" : "newo_receipt_tenant_unresolved" },
      existing.tenant_id ? 404 : 409);
  }
  if (existing?.status === "failed" && existing.admission_json == null) {
    return json({ error: "newo_receipt_provenance_unresolved" }, 409);
  }
  if (existing) {
    if (existing.payload_hash !== hash) {
      const conflictKey = rawKey(input, `-${hash.slice(0, 12)}`, "conflicts/lookups");
      await store.putRaw(env, conflictKey, rawText, "application/json");
      await recordConflict(env, input, existing.payload_hash, hash, conflictKey);
      return json({ error: "request_id_conflict", request_id: input.request_id }, 409);
    }
    await touchNewoReceipt(env, input.request_id, new Date().toISOString());
    if (existing.status === "accepted") {
      return new Response(existing.response_json, {
        status: acceptedLookupStatus(existing.response_json),
        headers: { "content-type": "application/json; charset=utf-8", "x-newo-replay": "true" },
      });
    }
    if (existing.status === "processing") {
      return json({ error: "lookup_processing", request_id: input.request_id }, 202);
    }
    if (existing.status === "dead") {
      return json({ error: "lookup_dead", request_id: input.request_id }, 409);
    }
  }

  const key = rawKey(input);
  await store.putRaw(env, key, rawText, "application/json");
  if (existing?.status === "failed") {
    if (!await restartFailedNewoReceipt(env, input.request_id, new Date().toISOString())) {
      return json({ error: "lookup_processing", request_id: input.request_id }, 202);
    }
  } else {
    const claim = await claimNewoReceipt(env, {
      event_id: input.request_id,
      session_id: input.session_id,
      event_type: "caller_lookup",
      payload_hash: hash,
      raw_key: key,
      admission_json: newoAdmissionJson({ event_id: input.request_id, session_id: input.session_id,
        event_type: "caller_lookup", occurred_at: input.occurred_at, reported_handoff_status: null,
        reported_urgency: "routine", event_has_contact: 1 }),
    }, new Date().toISOString());
    if (claim === "existing") return json({ error: "lookup_processing" }, 202);
  }

  try {
    const result = await lookupCaller(env as AppEnv, input);
    const response = lookupResponse(input, result);
    const associationWritten = await recordNewoCallerAssociation(env, {
      event_id: input.request_id,
      session_id: input.session_id,
      project_id: input.provider.project_id,
      agent_id: input.provider.agent_id,
      contact_phone: input.caller_phone,
      address_line1: input.verification.address_line1,
      postal_code: input.verification.postal_code,
      matched_customer_id: result.kind === "verified" ? result.value.customerId : null,
      matched_property_id: result.kind === "verified" ? result.value.propertyId : null,
      matched_roof_job_id: result.kind === "verified" ? result.value.roofJobId : null,
      verification_status: response.match_status,
      structured_json: JSON.stringify(input),
      raw_key: key,
      payload_hash: hash,
      occurred_at: input.occurred_at,
    });
    if (!associationWritten) {
      const durable = await getNewoSession(env, input.session_id);
      const durableAt = durable ? Date.parse(durable.updated_at) : Number.NaN;
      if (
        !durable || durable.session_id !== input.session_id || !Number.isFinite(durableAt)
        || durableAt <= Date.parse(input.occurred_at)
      ) {
        throw new Error("newo_caller_association_readback_mismatch");
      }
      const staleResponse = {
        error: "caller_lookup_stale",
        request_id: input.request_id,
        session_id: input.session_id,
      } as const;
      await store.recordAudit(env, {
        automation: "newo_caller_lookup",
        trigger: "lookup_caller",
        envelope_id: null,
        source_ids: `request:${input.request_id},session:${input.session_id}`,
        action: "stale_association_rejected",
        result: "error",
        error: "newer_session_association_exists",
        recovery_owner: env.OWNER_ALERT_EMAIL,
      });
      await completeNewoReceipt(env, input.request_id, null, staleResponse, new Date().toISOString());
      return json(staleResponse, 409);
    }
    await store.recordAudit(env, {
      automation: "newo_caller_lookup",
      trigger: "lookup_caller",
      envelope_id: null,
      source_ids: `request:${input.request_id},session:${input.session_id}`,
      action: response.match_status,
      result: "ok",
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    await completeNewoReceipt(env, input.request_id, null, response, new Date().toISOString());
    return json(response);
  } catch (error) {
    await failNewoReceipt(env, input.request_id, String(error), new Date().toISOString()).catch(() => {});
    await store.recordAudit(env, {
      automation: "newo_caller_lookup",
      trigger: "lookup_caller",
      envelope_id: null,
      source_ids: `request:${input.request_id},session:${input.session_id}`,
      action: "lookup_failed",
      result: "error",
      error: String(error),
      recovery_owner: env.OWNER_ALERT_EMAIL,
    }).catch(() => {});
    return json({ error: "caller_lookup_unavailable" }, 503);
  }
}

function acceptedLookupStatus(responseJson: string): 200 | 409 {
  try {
    const response = JSON.parse(responseJson) as unknown;
    return isRecord(response) && response.error === "caller_lookup_stale" ? 409 : 200;
  } catch {
    return 200;
  }
}

export function parseNewoCallerLookup(rawText: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { ok: false, issues: ["body must be valid JSON"] };
  }
  const issues: string[] = [];
  if (!isRecord(raw)) return { ok: false, issues: ["body must be an object"] };
  exactKeys(raw, [
    "schema_version", "request_id", "session_id", "occurred_at", "caller_phone", "provider",
    "verification",
  ], "$", issues);
  if (raw.schema_version !== SCHEMA_VERSION) issues.push(`schema_version must equal ${SCHEMA_VERSION}`);
  const requestId = identifier(raw.request_id, "request_id", issues);
  const sessionId = identifier(raw.session_id, "session_id", issues);
  const occurredAt = isoTimestamp(raw.occurred_at, "occurred_at", issues);
  const phone = normalizePhone(raw.caller_phone);
  if (!phone) issues.push("caller_phone must be a valid phone number");
  const provider = parseProvider(raw.provider, issues);
  const verification = parseVerification(raw.verification, issues);
  if (verification && !verification.address_line1 && !verification.postal_code) {
    issues.push("verification.address_line1 or verification.postal_code is required");
  }
  if (issues.length || !requestId || !sessionId || !occurredAt || !phone || !provider || !verification) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      schema_version: SCHEMA_VERSION,
      request_id: requestId,
      session_id: sessionId,
      occurred_at: occurredAt,
      caller_phone: phone,
      provider,
      verification,
    },
  };
}

async function lookupCaller(
  env: AppEnv,
  input: NewoCallerLookupRequest,
): Promise<
  | { kind: "verified"; value: VerifiedAssociation }
  | { kind: "not_found" | "verification_failed" | "ambiguous" }
> {
  const tenantId = tenantIdFrom(env);
  const customers = await env.DB.prepare(
    `SELECT customer_id
       FROM operating_customers
      WHERE tenant_id = ? AND contact_phone = ?
      ORDER BY customer_id
      LIMIT 2`,
  ).bind(tenantId, input.caller_phone).all<{ customer_id: string }>();
  if (customers.results.length === 0) return { kind: "not_found" };
  if (customers.results.length !== 1) return { kind: "ambiguous" };
  const customerId = textValue(customers.results[0]?.customer_id);
  if (!customerId) return { kind: "ambiguous" };
  const jobs = await env.DB.prepare(
    `SELECT j.roof_job_id, j.job_status, j.updated_at,
            p.property_key, p.address_line1, p.postal_code
       FROM operating_roof_jobs j
       JOIN operating_properties p
         ON p.tenant_id = j.tenant_id AND p.property_id = j.property_id
      WHERE j.tenant_id = ? AND j.customer_id = ?
      ORDER BY j.updated_at DESC, j.roof_job_id
      LIMIT 10`,
  ).bind(tenantId, customerId).all<CallerJobRow>();
  const verified = jobs.results.filter((row) => matchesVerification(row, input.verification));
  if (verified.length === 0) return { kind: "verification_failed" };
  if (verified.length !== 1) return { kind: "ambiguous" };
  const job = verified[0];
  const propertyId = textValue(job.property_key);
  const roofJobId = textValue(job.roof_job_id);
  if (!propertyId || !roofJobId) return { kind: "ambiguous" };
  return {
    kind: "verified",
    value: {
      customerId,
      propertyId,
      roofJobId,
      jobState: broadJobState(textValue(job.job_status)),
    },
  };
}

function lookupResponse(
  input: NewoCallerLookupRequest,
  result: Awaited<ReturnType<typeof lookupCaller>>,
): NewoCallerLookupResponse {
  if (result.kind === "verified") {
    return {
      schema_version: RESPONSE_VERSION,
      request_id: input.request_id,
      session_id: input.session_id,
      match_status: "verified",
      verified: true,
      job_state: result.value.jobState,
      safe_next_step: "continue_verified_service",
    };
  }
  return {
    schema_version: RESPONSE_VERSION,
    request_id: input.request_id,
    session_id: input.session_id,
    match_status: result.kind,
    verified: false,
    job_state: null,
    safe_next_step: result.kind === "not_found"
      ? "capture_new_lead"
      : result.kind === "verification_failed"
      ? "ask_for_address_or_postal_code"
      : "offer_staff_callback",
  };
}

function matchesVerification(
  property: Pick<CallerJobRow, "address_line1" | "postal_code">,
  verification: NewoCallerLookupRequest["verification"],
): boolean {
  if (verification.postal_code &&
    normalizedPostal(verification.postal_code) !== normalizedPostal(textValue(property.postal_code))) {
    return false;
  }
  if (verification.address_line1 &&
    normalizedAddress(verification.address_line1) !== normalizedAddress(textValue(property.address_line1))) {
    return false;
  }
  return true;
}

function broadJobState(status: string): NewoCallerLookupResponse["job_state"] {
  const value = status.toLowerCase();
  if (/complete|closed|warranty/.test(value)) return "Completed";
  if (/deposit|material|schedul|production|progress|install/.test(value)) return "In progress";
  if (/lead|qualif|estimate|proposal|quote|planning/.test(value)) return "Planning";
  return "Needs staff review";
}

function parseProvider(value: unknown, issues: string[]): NewoCallerLookupRequest["provider"] | null {
  if (!isRecord(value)) {
    issues.push("provider must be an object");
    return null;
  }
  exactKeys(value, ["project_id", "agent_id"], "provider", issues);
  return {
    project_id: nullableIdentifier(value.project_id, "provider.project_id", issues),
    agent_id: nullableIdentifier(value.agent_id, "provider.agent_id", issues),
  };
}

function parseVerification(
  value: unknown,
  issues: string[],
): NewoCallerLookupRequest["verification"] | null {
  if (!isRecord(value)) {
    issues.push("verification must be an object");
    return null;
  }
  exactKeys(value, ["address_line1", "postal_code"], "verification", issues);
  return {
    address_line1: nullableString(value.address_line1, 240, "verification.address_line1", issues),
    postal_code: nullableString(value.postal_code, 24, "verification.postal_code", issues),
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string, issues: string[]): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
  for (const key of expected) if (!(key in value)) issues.push(`${path}.${key} is required`);
}

function identifier(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    issues.push(`${path} must be a non-empty provider identifier`);
    return null;
  }
  return value;
}

function nullableIdentifier(value: unknown, path: string, issues: string[]): string | null {
  return value === null ? null : identifier(value, path, issues);
}

function nullableString(value: unknown, max: number, path: string, issues: string[]): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    issues.push(`${path} must be null or a non-empty string no longer than ${max} characters`);
    return null;
  }
  return value.trim();
}

function isoTimestamp(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issues.push(`${path} must be an ISO 8601 timestamp`);
    return null;
  }
  return new Date(value).toISOString();
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedPostal(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizedAddress(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rawKey(
  input: NewoCallerLookupRequest,
  suffix = "",
  prefix = "lookups",
): string {
  return `raw/newo/${prefix}/${input.occurred_at.slice(0, 10)}/${input.request_id}${suffix}.json`;
}

async function recordConflict(
  env: Env,
  input: NewoCallerLookupRequest,
  originalHash: string,
  conflictingHash: string,
  conflictKey: string,
): Promise<void> {
  const error = `request_id_conflict:${originalHash.slice(0, 12)}:${conflictingHash.slice(0, 12)}`;
  await store.recordAudit(env, {
    automation: "newo_caller_lookup",
    trigger: "lookup_caller",
    envelope_id: null,
    source_ids: `request:${input.request_id},session:${input.session_id},raw:${conflictKey}`,
    action: "idempotency_conflict",
    result: "error",
    error,
    recovery_owner: env.OWNER_ALERT_EMAIL,
  });
  await store.recordDeadLetter(env, {
    envelope_id: null,
    stage: "newo_lookup_conflict",
    error,
    payload_json: JSON.stringify({ request_id: input.request_id, session_id: input.session_id }),
  });
}

async function readBounded(req: Request): Promise<string | null> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return null;
  const body = await req.text();
  return new TextEncoder().encode(body).byteLength <= MAX_BODY_BYTES ? body : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
