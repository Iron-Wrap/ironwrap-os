import type { AppEnv } from "./app-types.ts";
import type { EnvelopeRecord } from "./core.ts";
import {
  newEnvelopeId,
  operatingTenantId,
  normalizePhone,
  extractContact,
} from "./core.ts";
import {
  ingestLead,
  officeLeadPayload,
  parseOfficeLead,
  type OfficeLeadInput,
} from "./lead-intake.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const OFFICE_LEAD_REQUEST_ID =
  /^office-lead:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const OFFICE_CONSENT_WORDING_VERSION = "office-estimate-follow-up-v1";
export interface OfficeCaptureInput extends OfficeLeadInput {
  intake_source: "phone" | "referral" | "walk_in";
  preferred_contact_channel: "email" | "phone" | null;
  email_estimate_follow_up_consent: boolean;
}
interface ReceiptRecord {
  tenant_id: string;
  request_id: string;
  actor_user_id: string;
  request_hash: string;
  envelope_id: string;
  captured_at: string;
  input_json: string;
  payload_json: string;
  payload_sha256: string;
  consent_jurisdiction: string | null;
  consent_wording_version: string | null;
  state: "processing" | "recorded";
  outcome: "created" | "duplicate" | null;
  canonical_envelope_id: string | null;
}
export class OfficeIntakeError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function parseOfficeCapture(
  value: unknown,
): { ok: true; value: OfficeCaptureInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "invalid_body" };
  const {
    intake_source,
    preferred_contact_channel,
    email_estimate_follow_up_consent,
    ...base
  } = value as Record<string, unknown>;
  const parsed = parseOfficeLead(base);
  if (!parsed.ok) return parsed;
  if (parsed.value.phone && !normalizePhone(parsed.value.phone))
    return { ok: false, error: "invalid_phone" };
  if (
    intake_source !== "phone" &&
    intake_source !== "referral" &&
    intake_source !== "walk_in"
  )
    return { ok: false, error: "invalid_intake_source" };
  if (
    preferred_contact_channel !== undefined &&
    preferred_contact_channel !== null &&
    preferred_contact_channel !== "email" &&
    preferred_contact_channel !== "phone"
  )
    return { ok: false, error: "invalid_preferred_contact_channel" };
  if (preferred_contact_channel && !parsed.value[preferred_contact_channel])
    return { ok: false, error: "preferred_contact_channel_missing" };
  if (
    email_estimate_follow_up_consent !== undefined &&
    typeof email_estimate_follow_up_consent !== "boolean"
  )
    return { ok: false, error: "invalid_email_estimate_follow_up_consent" };
  if (email_estimate_follow_up_consent === true && !parsed.value.email)
    return { ok: false, error: "consent_email_required" };
  return {
    ok: true,
    value: {
      ...parsed.value,
      intake_source,
      preferred_contact_channel: preferred_contact_channel ?? null,
      email_estimate_follow_up_consent:
        email_estimate_follow_up_consent === true,
    },
  };
}

async function receiptRecord(
  db: D1Database,
  tenantId: string,
  requestId: string,
): Promise<ReceiptRecord | null> {
  return db
    .prepare(
      "SELECT * FROM office_lead_intake_receipts WHERE tenant_id = ? AND request_id = ?",
    )
    .bind(tenantId, requestId)
    .first<ReceiptRecord>();
}

/** Stable key replay repairs only the original write; it never reinterprets the submitted intent. */
export async function recordOfficeIntake(
  env: AppEnv,
  actor: { tenantId: string; userId: string; email: string },
  requestId: string,
  input: OfficeCaptureInput,
) {
  if (operatingTenantId(env.APP_TENANT_ID) !== actor.tenantId)
    throw new OfficeIntakeError("tenant_identity_required", 403);
  if (!OFFICE_LEAD_REQUEST_ID.test(requestId))
    throw new OfficeIntakeError("invalid_intake_request_id", 400);
  const requestHash = await sha256Hex(canonicalJson(input));
  let receipt = await receiptRecord(env.DB, actor.tenantId, requestId);
  if (!receipt) {
    const jurisdiction =
      env.PUBLIC_ESTIMATE_CONSENT_JURISDICTION?.trim() || null;
    if (
      input.email_estimate_follow_up_consent &&
      (!jurisdiction || jurisdiction.length < 2 || jurisdiction.length > 120)
    )
      throw new OfficeIntakeError(
        "office_consent_jurisdiction_unconfigured",
        503,
      );
    const capturedAt = new Date().toISOString();
    const payload = {
      ...officeLeadPayload(input, actor.email),
      source_detail: "ironwrap_office_intake",
      office_intake_request_id: requestId,
      office_capture: {
        intake_source: input.intake_source,
        preferred_contact_channel: input.preferred_contact_channel,
        email_consent: {
          granted: input.email_estimate_follow_up_consent,
          purpose: "estimate_follow_up",
          recorded_at: input.email_estimate_follow_up_consent
            ? capturedAt
            : null,
          captured_by: input.email_estimate_follow_up_consent
            ? actor.userId
            : null,
          jurisdiction: input.email_estimate_follow_up_consent
            ? jurisdiction
            : null,
          wording_version: input.email_estimate_follow_up_consent
            ? OFFICE_CONSENT_WORDING_VERSION
            : null,
        },
      },
    };
    const payloadJson = JSON.stringify(payload);
    await env.DB.prepare(
      `INSERT INTO office_lead_intake_receipts
      (tenant_id, request_id, actor_user_id, request_hash, envelope_id, captured_at, input_json,
       payload_json, payload_sha256, consent_jurisdiction, consent_wording_version)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS
        (SELECT 1 FROM office_lead_intake_receipts WHERE tenant_id = ? AND request_id = ?)`,
    )
      .bind(
        actor.tenantId,
        requestId,
        actor.userId,
        requestHash,
        newEnvelopeId(),
        capturedAt,
        JSON.stringify(input),
        payloadJson,
        await sha256Hex(canonicalJson(payload)),
        input.email_estimate_follow_up_consent ? jurisdiction : null,
        input.email_estimate_follow_up_consent
          ? OFFICE_CONSENT_WORDING_VERSION
          : null,
        actor.tenantId,
        requestId,
      )
      .run();
    receipt = await receiptRecord(env.DB, actor.tenantId, requestId);
  }
  if (!receipt) throw new OfficeIntakeError("office_intake_unavailable", 503);
  if (receipt.actor_user_id !== actor.userId)
    throw new OfficeIntakeError("intake_not_found", 404);
  if (receipt.request_hash !== requestHash)
    throw new OfficeIntakeError("intake_request_conflict", 409);
  if (receipt.state === "processing") {
    const result = await ingestLead(
      env,
      { waitUntil: () => {} },
      {
        source:
          input.intake_source === "walk_in" ? "manual" : input.intake_source,
        rawText: receipt.payload_json,
        contentType: "application/json",
        ownedIdentity: {
          envelopeId: receipt.envelope_id,
          capturedAt: receipt.captured_at,
        },
        suppressAcknowledgement: true,
      },
    );
    if (!result.ok) throw new OfficeIntakeError(result.error, result.status);
    await env.DB.prepare(
      `UPDATE office_lead_intake_receipts SET state = 'recorded', outcome = ?, canonical_envelope_id = ?
      WHERE tenant_id = ? AND request_id = ? AND state = 'processing'`,
    )
      .bind(
        result.body.duplicate ? "duplicate" : "created",
        result.body.canonical_envelope_id,
        actor.tenantId,
        requestId,
      )
      .run();
  }
  return readOfficeIntakeReceipt(env, actor.tenantId, actor.userId, requestId);
}

/** Continue only an existing immutable request. This operation cannot allocate a new identity. */
export async function resumeOfficeIntake(
  env: AppEnv,
  actor: { tenantId: string; userId: string; email: string },
  requestId: string,
) {
  if (operatingTenantId(env.APP_TENANT_ID) !== actor.tenantId)
    throw new OfficeIntakeError("tenant_identity_required", 403);
  const receipt = await receiptRecord(env.DB, actor.tenantId, requestId);
  if (!receipt || receipt.actor_user_id !== actor.userId)
    throw new OfficeIntakeError("intake_not_found", 404);
  let savedInput: unknown;
  try {
    savedInput = JSON.parse(receipt.input_json);
  } catch {
    throw new OfficeIntakeError("office_intake_snapshot_invalid", 503);
  }
  const parsed = parseOfficeCapture(savedInput);
  if (
    !parsed.ok ||
    (await sha256Hex(canonicalJson(parsed.value))) !== receipt.request_hash
  )
    throw new OfficeIntakeError("office_intake_snapshot_invalid", 503);
  return recordOfficeIntake(env, actor, requestId, parsed.value);
}

/** Read-only receipt recovery. A missing receipt is not evidence that a timed-out write failed. */
export async function readOfficeIntakeReceipt(
  env: AppEnv,
  tenantId: string,
  actorUserId: string,
  requestId: string,
) {
  const receipt = await receiptRecord(env.DB, tenantId, requestId);
  if (!receipt || receipt.actor_user_id !== actorUserId)
    throw new OfficeIntakeError("intake_not_found", 404);
  const canonical =
    receipt.state === "recorded" ? receipt.canonical_envelope_id : null;
  const lead = canonical
    ? await env.DB.prepare(
        `SELECT lead_id FROM operating_leads WHERE tenant_id = ? AND source_envelope_id = ?`,
      )
        .bind(tenantId, canonical)
        .first<{ lead_id: string }>()
    : null;
  const details = canonical
    ? await readOfficeLeadFacts(env.DB, tenantId, canonical)
    : null;
  if (canonical && !details)
    throw new OfficeIntakeError("intake_source_unavailable", 503);
  return {
    version: 1 as const,
    receipt: {
      request_id: requestId,
      state: receipt.state,
      outcome: receipt.outcome,
      canonical_envelope_id: canonical,
      lead_id: lead?.lead_id ?? null,
      submitted_details_applied:
        receipt.state === "recorded" ? receipt.outcome === "created" : null,
      captured_at: receipt.captured_at,
      details,
    },
  };
}

/** Trust the office capture only when it is bound to this exact tenant, envelope and immutable payload. */
export async function trustedOfficeCapture(
  db: D1Database,
  tenantId: string,
  rec: EnvelopeRecord,
): Promise<ReceiptRecord | null> {
  const row = await db
    .prepare(
      "SELECT * FROM office_lead_intake_receipts WHERE tenant_id = ? AND envelope_id = ?",
    )
    .bind(tenantId, rec.envelope_id)
    .first<ReceiptRecord>();
  if (!row) return null;
  const payload = JSON.parse(rec.payload_json) as Record<string, unknown>;
  const input = JSON.parse(row.input_json) as OfficeCaptureInput;
  const contact = extractContact(payload);
  if (
    rec.source !==
      (input.intake_source === "walk_in" ? "manual" : input.intake_source) ||
    (contact.email ?? null) !== rec.contact_email ||
    (contact.phone ?? null) !== rec.contact_phone ||
    (contact.name ?? null) !== rec.contact_name ||
    rec.ts !== row.captured_at ||
    row.payload_sha256 !== (await sha256Hex(canonicalJson(payload))) ||
    rec.raw_key !==
      `raw/${row.captured_at.slice(0, 10)}/${row.envelope_id}.json`
  )
    throw new Error("office_intake_provenance_conflict");
  return row;
}

export async function readOfficeLeadFacts(
  db: D1Database,
  tenantId: string,
  envelopeId: string,
) {
  const rec = await db
    .prepare("SELECT * FROM envelopes WHERE tenant_id = ? AND envelope_id = ?")
    .bind(tenantId, envelopeId)
    .first<EnvelopeRecord>();
  if (!rec) return null;
  const payload = JSON.parse(rec.payload_json) as Record<string, unknown>;
  const capture =
    payload.source_detail === "ironwrap_office_intake"
      ? await trustedOfficeCapture(db, tenantId, rec)
      : null;
  const input = capture
    ? (JSON.parse(capture.input_json) as OfficeCaptureInput)
    : null;
  const consent = await db
    .prepare(
      `SELECT status, recorded_at, captured_by, jurisdiction FROM operating_consents
    WHERE tenant_id = ? AND source_envelope_id = ? AND channel = 'email' AND purpose = 'estimate_follow_up'
    ORDER BY recorded_at DESC, consent_id ASC LIMIT 1`,
    )
    .bind(tenantId, envelopeId)
    .first<{
      status: string;
      recorded_at: string;
      captured_by: string;
      jurisdiction: string;
    }>();
  const granted = consent
    ? consent.status === "granted"
    : input?.email_estimate_follow_up_consent === true;
  const value = (key: keyof OfficeLeadInput) =>
    input?.[key] ?? text(payload[key]);
  return {
    name: input?.name ?? rec.contact_name ?? "Unnamed lead",
    email: rec.contact_email,
    phone: rec.contact_phone,
    address: value("address"),
    city: value("city"),
    province: value("province"),
    postal_code: value("postal_code"),
    service: value("service"),
    message: value("message"),
    source: rec.source,
    intake_source: input?.intake_source ?? null,
    preferred_contact_channel: input?.preferred_contact_channel ?? null,
    email_consent: {
      status: granted ? ("granted" as const) : ("not_recorded" as const),
      purpose: "estimate_follow_up" as const,
      recorded_at: granted
        ? (consent?.recorded_at ?? capture?.captured_at ?? null)
        : null,
      captured_by: granted
        ? (consent?.captured_by ?? capture?.actor_user_id ?? null)
        : null,
      jurisdiction: granted
        ? (consent?.jurisdiction ?? capture?.consent_jurisdiction ?? null)
        : null,
      wording_version: granted
        ? (capture?.consent_wording_version ?? null)
        : null,
    },
  };
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
