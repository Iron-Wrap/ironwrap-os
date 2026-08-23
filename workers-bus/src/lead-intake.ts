/**
 * The one lead-intake path: raw to R2 first, canonical envelope to D1, instant-ack off the owned
 * write, then the JobNimbus push enqueued for the queue consumer (which is also what materializes
 * the native operating core).
 *
 * It used to live inside `index.ts` as a private handler wired only to the bearer-token
 * `POST /ingest/<source>` route, which meant the only ways a lead could enter the system were a
 * curl call with the ingest secret, live telephony, or a live JobNimbus account — a fresh tenant
 * had no way at all to take its first lead (ELEC-158 B1). Extracting the body here lets the
 * authenticated office API create a lead through exactly the same envelope, dedup, audit and
 * materialization path instead of growing a second, divergent one.
 */
import {
  ALLOWED_SOURCES,
  type EnvelopeRecord,
  type Source,
  classifyIntent,
  dedupKey,
  newEnvelopeId,
  normalizeEnvelope,
  operatingTenantId,
  parseBody,
  validateInbound,
} from "./core.ts";
import { sendInstantAck } from "./notify.ts";
import * as store from "./store.ts";

export const MAX_LEAD_INTAKE_BYTES = 256 * 1024;

export interface LeadIntakeInput {
  source: string;
  provider?: string;
  rawText: string;
  contentType: string | null;
}

export interface LeadIntakeAccepted {
  ok: true;
  body: {
    envelope_id: string;
    canonical_envelope_id: string;
    tenant_id: string;
    status: string;
    duplicate: boolean;
    queue: string | null;
  };
}

export interface LeadIntakeRejected {
  ok: false;
  status: number;
  error: string;
}

export type LeadIntakeResult = LeadIntakeAccepted | LeadIntakeRejected;

export async function ingestLead(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  input: LeadIntakeInput,
  onError: (entry: Record<string, unknown>) => void = () => {},
): Promise<LeadIntakeResult> {
  if (!(ALLOWED_SOURCES as readonly string[]).includes(input.source)) {
    return { ok: false, status: 400, error: "bad_source" };
  }

  const tenantId = operatingTenantId((env as Env & { APP_TENANT_ID?: string }).APP_TENANT_ID);
  if (!tenantId) return { ok: false, status: 403, error: "tenant_identity_required" };
  if (input.rawText.length > MAX_LEAD_INTAKE_BYTES) {
    return { ok: false, status: 413, error: "payload_too_large" };
  }

  const parsed = parseBody(input.rawText, input.contentType);
  const raw = input.provider ? { ...parsed, provider: input.provider } : parsed;
  const envelopeId = newEnvelopeId();
  const now = new Date().toISOString();
  const rawKey = `raw/${now.slice(0, 10)}/${envelopeId}.json`;

  // 1) Raw to R2 FIRST — nothing is lost even if everything after this throws.
  await store.putRaw(env, rawKey, input.rawText, "application/json");

  // 2) Canonical envelope.
  const envelope = normalizeEnvelope(input.source as Source, raw, now);
  const valid = validateInbound(envelope);
  const key = dedupKey(envelope.contact);

  // 3) Dedup across all inbound paths (phone/email, within the window).
  let dupOf: string | null = null;
  if (key) {
    const windowH = Number(env.DEDUP_WINDOW_HOURS ?? "72");
    const since = new Date(Date.now() - windowH * 3600_000).toISOString();
    dupOf = await store.claimDedup(env, key, envelopeId, now, since);
  }

  const intentText = `${raw["service"] ?? ""} ${raw["service_intent"] ?? ""} ${raw["message"] ?? ""}`;
  const intentQueue = classifyIntent(intentText);

  // Replay of a claimed contact returns the original identity. A second D1 lead
  // row (even status=duplicate) would mint a second operating record.
  if (dupOf) {
    await store.recordAudit(env, {
      automation: "ingest",
      trigger: input.source,
      envelope_id: dupOf,
      source_ids: input.provider ? `provider:${input.provider}` : undefined,
      action: "dedup",
      result: "ok",
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    return {
      ok: true,
      body: {
        envelope_id: dupOf,
        canonical_envelope_id: dupOf,
        tenant_id: tenantId,
        status: "duplicate",
        duplicate: true,
        queue: intentQueue,
      },
    };
  }

  const rec: EnvelopeRecord = {
    envelope_id: envelopeId,
    source: input.source,
    contact_name: envelope.contact.name ?? null,
    contact_phone: envelope.contact.phone ?? null,
    contact_email: envelope.contact.email ?? null,
    job_ref: envelope.job_ref,
    payload_json: JSON.stringify(envelope.payload),
    raw_key: rawKey,
    ts: now,
    status: valid.ok ? "pending_jn_push" : "received",
    dedup_key: key,
    dup_of: null,
    attempts: 0,
    last_error: valid.ok ? null : (valid.reason ?? null),
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: intentQueue,
    tenant_id: tenantId,
    created_at: now,
    updated_at: now,
  };

  // 4) Owned store write (system of record).
  await store.insertEnvelope(env, rec);
  await store.recordAudit(env, {
    automation: "ingest",
    trigger: input.source,
    envelope_id: envelopeId,
    source_ids: input.provider ? `provider:${input.provider}` : undefined,
    action: "received",
    result: "ok",
    error: rec.last_error,
    recovery_owner: env.OWNER_ALERT_EMAIL,
  });

  // 5) Instant-ack fires OFF the first owned-store write (never off a duplicate/retry).
  ctx.waitUntil(
    sendInstantAck(env, rec).catch((error) =>
      onError({ at: "instant_ack", envelope_id: envelopeId, error: String(error) }),
    ),
  );

  // 6) Enqueue the JobNimbus push (skip unroutable-no-contact rows).
  if (valid.ok) await env.JN_QUEUE.send({ envelope_id: envelopeId });

  return {
    ok: true,
    body: {
      envelope_id: envelopeId,
      canonical_envelope_id: envelopeId,
      tenant_id: tenantId,
      status: rec.status,
      duplicate: false,
      queue: rec.intent_queue,
    },
  };
}

export interface OfficeLeadInput {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  service: string | null;
  message: string | null;
}

const OFFICE_LEAD_FIELDS = [
  "name", "email", "phone", "address", "city", "province", "postal_code", "service", "message",
] as const;

const OFFICE_LEAD_LIMITS: Readonly<Record<(typeof OFFICE_LEAD_FIELDS)[number], number>> = {
  name: 120,
  email: 160,
  phone: 32,
  address: 200,
  city: 80,
  province: 80,
  postal_code: 24,
  service: 120,
  message: 2000,
};

/**
 * What an office user types on the "Add a lead" screen. It is deliberately looser than the public
 * estimate form's schema: `service` is free text because an account's service list is its own
 * configuration and custom services not known in advance are an explicit product requirement, and
 * the intent classifier already reads it as text.
 */
export function parseOfficeLead(
  value: unknown,
): { ok: true; value: OfficeLeadInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "invalid_body" };
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(OFFICE_LEAD_FIELDS);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return { ok: false, error: "unexpected_field" };
  }
  const fields: Record<string, string> = {};
  for (const field of OFFICE_LEAD_FIELDS) {
    const supplied = record[field];
    if (supplied === undefined || supplied === null) {
      fields[field] = "";
      continue;
    }
    if (typeof supplied !== "string") return { ok: false, error: `invalid_${field}` };
    const trimmed = supplied.trim();
    if (trimmed.length > OFFICE_LEAD_LIMITS[field]) return { ok: false, error: `invalid_${field}` };
    fields[field] = trimmed;
  }
  if (fields.name!.length < 2) return { ok: false, error: "invalid_name" };
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) {
    return { ok: false, error: "invalid_email" };
  }
  if (fields.phone && !/^\+?[\d()\s.-]{7,32}$/.test(fields.phone)) {
    return { ok: false, error: "invalid_phone" };
  }
  // A lead with neither an email nor a phone cannot be worked and would be stored unroutable.
  if (!fields.email && !fields.phone) return { ok: false, error: "contact_required" };

  return {
    ok: true,
    value: {
      name: fields.name!,
      email: fields.email || null,
      phone: fields.phone || null,
      address: fields.address || null,
      city: fields.city || null,
      province: fields.province || null,
      postal_code: fields.postal_code || null,
      service: fields.service || null,
      message: fields.message || null,
    },
  };
}

/** The ingest payload an office-entered lead becomes, so it travels the existing envelope path. */
export function officeLeadPayload(
  input: OfficeLeadInput,
  actorEmail: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: input.name,
    entered_by: actorEmail,
    entered_in: "office_app",
  };
  if (input.email) payload.email = input.email;
  if (input.phone) payload.phone = input.phone;
  if (input.address) payload.address = input.address;
  if (input.city) payload.city = input.city;
  if (input.province) payload.province = input.province;
  if (input.postal_code) payload.postal_code = input.postal_code;
  if (input.service) payload.service = input.service;
  if (input.message) payload.message = input.message;
  return payload;
}
