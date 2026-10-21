import {
  classifyIntent,
  newEnvelopeId,
  normalizeEmail,
  normalizePhone,
  type EnvelopeRecord,
} from "./core.ts";
import { sendInstantAck, sendOwnerAlert } from "./notify.ts";
import {
  claimNewoReceipt,
  completeNewoReceipt,
  failNewoReceipt,
  getNewoReceipt,
  getNewoSession,
  listRetryableNewoEventIds,
  markNewoMissingReports,
  newoOperationalCounts,
  recordNewoReconciliationRun,
  restartFailedNewoReceipt,
  markNewoSessionSync,
  touchNewoReceipt,
  upsertNewoSession,
  type NewoSessionRecord,
} from "./newo-store.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { handleNewoCallerLookup } from "./newo-caller.ts";
import { materializeOperatingCore, tenantIdFrom } from "./operating-core.ts";
import * as store from "./store.ts";

export { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const NEWO_EVENT_SCHEMA_VERSION = "newo.event.v1" as const;
export const NEWO_AVAILABILITY_SCHEMA_VERSION = "newo.availability.v1" as const;
export const NEWO_TOOL_RECEIPT_SCHEMA_VERSION = "newo.tool-receipt.v1" as const;

const MAX_NEWO_BODY_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EVENT_TYPES = [
  "lead_captured",
  "handoff_requested",
  "session_ended",
  "session_failed",
  "missed_call",
  "booking_requested",
  "booking_cancelled",
] as const;
const DIVISIONS = [
  "residential",
  "commercial",
  "shop_supply",
  "steel_distribution",
] as const;
const URGENCIES = ["routine", "urgent", "emergency"] as const;
const CHANNELS = ["phone", "chat"] as const;
const DIRECTIONS = ["inbound", "outbound"] as const;

export type NewoEventType = (typeof EVENT_TYPES)[number];
type NewoDivision = (typeof DIVISIONS)[number];
type NewoUrgency = (typeof URGENCIES)[number];

export interface NewoPreferredWindow {
  start: string;
  end: string | null;
}

export interface NewoEventV1 {
  schema_version: typeof NEWO_EVENT_SCHEMA_VERSION;
  event_id: string;
  session_id: string;
  event_type: NewoEventType;
  occurred_at: string;
  provider: {
    project_id: string | null;
    agent_id: string | null;
    user_actor_id: string | null;
    conversation_id: string | null;
  };
  channel: (typeof CHANNELS)[number];
  direction: (typeof DIRECTIONS)[number];
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: {
      line1: string | null;
      city: string | null;
      province: string | null;
      postal_code: string | null;
    };
  };
  intent: {
    service: string | null;
    division: NewoDivision | null;
    urgency: NewoUrgency;
    message: string | null;
  };
  consent: {
    ai_disclosed: boolean;
    recording_disclosed: boolean;
    follow_up_email: boolean;
    follow_up_phone: boolean;
  };
  appointment: {
    request_id: string | null;
    preferred_windows: NewoPreferredWindow[];
    timezone: string;
  };
  outcome: {
    status: string | null;
    summary: string | null;
    handoff_status: string | null;
    booking_status: string | null;
    transcript_ref: string | null;
    recording_ref: string | null;
    started_at: string | null;
    ended_at: string | null;
    duration_seconds: number | null;
  };
  handoff_summary: string | null;
}

export interface NewoAvailabilityRequestV1 {
  schema_version: typeof NEWO_AVAILABILITY_SCHEMA_VERSION;
  request_id: string;
  session_id: string;
  occurred_at: string;
  timezone: string;
  service: string | null;
  division: NewoDivision | null;
  preferred_windows: NewoPreferredWindow[];
}

export interface NewoToolReceipt {
  schema_version: typeof NEWO_TOOL_RECEIPT_SCHEMA_VERSION;
  event_id: string;
  session_id: string;
  status: "accepted";
  envelope_id: string | null;
  appointment_request_id: string | null;
  booking_mode: "request_only" | "confirmed";
  booking_status: "not_requested" | "requested" | "cancelled";
  message: string;
}

export type NewoQueueMessage = { newo_event_id: string };

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

type NewoRuntimeEnv = Env & {
  NEWO_ENABLED?: string;
  NEWO_BOOKING_MODE?: string;
  NEWO_BOOKING_HORIZON_DAYS?: string;
  NEWO_REPORT_TIMEOUT_MINUTES?: string;
  NEWO_SYNC_RETRY_MINUTES?: string;
  NEWO_PRODUCTION_REQUIRED?: string;
  NEWO_BOOKING_TOKEN?: string;
  NEWO_QUEUE: Queue<NewoQueueMessage>;
};

export async function handleNewoWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const runtime = env as NewoRuntimeEnv;
  if (String(runtime.NEWO_ENABLED) !== "true") return json({ error: "newo_disabled" }, 503);

  if (url.pathname === "/webhook/newo/availability") {
    const denied = authenticate(req, runtime.NEWO_BOOKING_TOKEN, "booking_not_configured");
    if (denied) return denied;
    return await handleAvailability(req, runtime);
  }

  if (url.pathname === "/webhook/newo/lookup") {
    const denied = authenticate(req, runtime.NEWO_WEBHOOK_TOKEN, "webhook_not_configured");
    if (denied) return denied;
    return await handleNewoCallerLookup(req, env);
  }

  const bookingPath = url.pathname === "/webhook/newo/booking" ||
    url.pathname === "/webhook/newo/booking/cancel";
  const denied = authenticate(
    req,
    bookingPath ? runtime.NEWO_BOOKING_TOKEN : runtime.NEWO_WEBHOOK_TOKEN,
    bookingPath ? "booking_not_configured" : "webhook_not_configured",
  );
  if (denied) return denied;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const allowed = expectedEventTypes(url.pathname);
  if (!allowed) return json({ error: "not_found" }, 404);
  const rawText = await readBounded(req);
  if (rawText === null) return json({ error: "payload_too_large" }, 413);
  const parsed = parseNewoEvent(rawText);
  if (!parsed.ok) return json({ error: "invalid_payload", issues: parsed.issues }, 422);
  if (!allowed.includes(parsed.value.event_type)) {
    return json({
      error: "event_type_not_allowed",
      expected: allowed,
      received: parsed.value.event_type,
    }, 422);
  }
  if (bookingMode(runtime) === "request_only" && parsed.value.event_type === "booking_requested") {
    parsed.value.outcome.booking_status = "requested";
  }
  return await acceptEvent(runtime, ctx, parsed.value, rawText);
}

export async function handleNewoQueueMessage(
  env: Env,
  eventId: string,
  deadLetter: boolean,
): Promise<void> {
  const receipt = await getNewoReceipt(env, eventId);
  if (!receipt) throw new Error("newo_receipt_missing");
  const session = await getNewoSession(env, receipt.session_id);
  if (!session) throw new Error("newo_session_missing");
  const now = new Date().toISOString();
  if (deadLetter) {
    await markNewoSessionSync(
      env,
      session.session_id,
      "dead",
      "newo_native_projection_retries_exhausted",
      now,
    );
    await store.recordDeadLetter(env, {
      envelope_id: receipt.envelope_id,
      stage: "newo_native_projection",
      error: "newo_native_projection_retries_exhausted",
      payload_json: JSON.stringify({ event_id: eventId, session_id: session.session_id }),
    });
    await sendOwnerAlert(
      env,
      "Newo native projection requires recovery",
      `<p>Session ${escapeHtml(session.session_id)} exhausted its native projection retries.</p>`,
    ).catch(() => {});
    return;
  }

  try {
    const projection = await projectNewoSessionToNativeCore(env, receipt.envelope_id, session);
    await markNewoSessionSync(env, session.session_id, "synced", null, now);
    await store.recordAudit(env, {
      automation: "newo_native_projection",
      trigger: "queue",
      envelope_id: receipt.envelope_id,
      source_ids: `event:${eventId},session:${session.session_id}`,
      target_ids: projection.targetIds.join(","),
      action: projection.action,
      result: "ok",
    });
  } catch (error) {
    await markNewoSessionSync(env, session.session_id, "failed", String(error), now).catch(() => {});
    throw error;
  }
}

interface NewoNativeProjection {
  action: "materialize" | "readback" | "session_readback";
  targetIds: string[];
}

async function projectNewoSessionToNativeCore(
  env: Env,
  receiptEnvelopeId: string | null,
  session: NewoSessionRecord,
): Promise<NewoNativeProjection> {
  if ((session.lead_envelope_id ?? null) !== receiptEnvelopeId) {
    throw new Error("newo_native_envelope_mismatch");
  }
  if (session.verification_status === "ambiguous" || session.verification_status === "verification_failed") {
    throw new Error(`newo_native_association_${session.verification_status}`);
  }
  if (session.verification_status === "verified") {
    return await readVerifiedNativeAssociation(env, session);
  }
  if (!receiptEnvelopeId) {
    return { action: "session_readback", targetIds: [`newo_session:${session.session_id}`] };
  }

  const envelope = await store.getEnvelope(env, receiptEnvelopeId);
  if (!envelope) throw new Error("newo_native_envelope_missing");
  const operating = await materializeOperatingCore(env, envelope);
  return {
    action: operating.reused ? "readback" : "materialize",
    targetIds: [
      `newo_session:${session.session_id}`,
      `lead:${operating.leadId}`,
      `customer:${operating.customerId}`,
      ...(operating.propertyId ? [`property:${operating.propertyId}`] : []),
      `roof_job:${operating.roofJobId}`,
    ],
  };
}

async function readVerifiedNativeAssociation(
  env: Env,
  session: NewoSessionRecord,
): Promise<NewoNativeProjection> {
  const customerId = session.matched_customer_id?.trim();
  const propertyKey = session.matched_property_id?.trim();
  const roofJobId = session.matched_roof_job_id?.trim();
  if (!customerId || !propertyKey || !roofJobId) {
    throw new Error("newo_native_association_incomplete");
  }

  // `matched_property_id` is a legacy schema name. Native caller lookup stores the tenant-owned
  // property key there, so the readback can verify the exact customer/property/job relationship.
  const association = await env.DB.prepare(
    `SELECT j.roof_job_id, j.customer_id, j.property_id, p.property_key
       FROM operating_roof_jobs j
       JOIN operating_customers c
         ON c.tenant_id = j.tenant_id AND c.customer_id = j.customer_id
       JOIN operating_properties p
         ON p.tenant_id = j.tenant_id AND p.property_id = j.property_id
      WHERE j.tenant_id = ? AND j.roof_job_id = ? AND j.customer_id = ?
        AND p.property_key = ?`,
  ).bind(tenantIdFrom(env), roofJobId, customerId, propertyKey).first<{
    roof_job_id: string;
    customer_id: string;
    property_id: string;
    property_key: string;
  }>();
  if (!association) throw new Error("newo_native_association_mismatch");
  return {
    action: "readback",
    targetIds: [
      `newo_session:${session.session_id}`,
      `customer:${association.customer_id}`,
      `property:${association.property_id}`,
      `roof_job:${association.roof_job_id}`,
    ],
  };
}

export async function reconcileNewoSessions(
  env: Env,
  now = new Date(),
): Promise<{
  retryable_syncs_requeued: number;
  newly_missing_reports: number;
}> {
  const runtime = env as NewoRuntimeEnv;
  if (String(runtime.NEWO_ENABLED) !== "true" && String(runtime.NEWO_PRODUCTION_REQUIRED) !== "true") {
    return { retryable_syncs_requeued: 0, newly_missing_reports: 0 };
  }
  const ranAt = now.toISOString();
  const configured = Number(runtime.NEWO_SYNC_RETRY_MINUTES ?? "5");
  const retryMinutes = Number.isInteger(configured) && configured >= 1 && configured <= 60
    ? configured
    : 5;
  const retryCutoff = new Date(now.getTime() - retryMinutes * 60_000).toISOString();
  const retryEventIds = await listRetryableNewoEventIds(env, retryCutoff, 100);
  if (retryEventIds.length > 0) {
    await runtime.NEWO_QUEUE.sendBatch(
      retryEventIds.map((eventId) => ({ body: { newo_event_id: eventId } })),
    );
  }

  const missing = await markNewoMissingReports(env, ranAt, 100);
  for (const session of missing) {
    await store.recordAudit(env, {
      automation: "newo_report_reconciliation",
      trigger: "five_minute_cron",
      envelope_id: session.lead_envelope_id,
      source_ids: `session:${session.session_id}`,
      action: "missing_report_detected",
      result: "error",
      error: "newo_session_report_missing",
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
  }
  if (missing.length > 0) {
    const listed = missing.slice(0, 20).map((session) => escapeHtml(session.session_id)).join(", ");
    await sendOwnerAlert(
      env,
      `${missing.length} Newo session report${missing.length === 1 ? " is" : "s are"} missing`,
      `<p>Structured session reports did not arrive by their deadline.</p><p>Sessions: ${listed}</p>`,
    ).catch(() => {});
  }

  const counts = await newoOperationalCounts(env);
  const degraded = counts.failed_events > 0 || counts.failed_sync > 0 ||
    counts.missing_reports > 0 || counts.control_failures > 0;
  await recordNewoReconciliationRun(env, {
    run_id: `newo:five-minute:${crypto.randomUUID()}`,
    run_type: "five_minute",
    status: degraded ? "degraded" : "ok",
    ran_at: ranAt,
    retryable_syncs_requeued: retryEventIds.length,
    missing_reports: counts.missing_reports,
    failed_handoffs: counts.failed_handoffs,
    pending_bookings: counts.pending_bookings,
    unresolved_incidents: null,
    drift_reasons_json: "[]",
    usage_status: "not_checked",
    usage_minutes: null,
    usage_limit_minutes: null,
    detail_json: JSON.stringify({
      retry_event_ids: retryEventIds,
      newly_missing_session_ids: missing.map((session) => session.session_id),
    }),
  });
  return {
    retryable_syncs_requeued: retryEventIds.length,
    newly_missing_reports: missing.length,
  };
}

export function parseNewoEvent(rawText: string): ParseResult<NewoEventV1> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { ok: false, issues: ["body must be valid JSON"] };
  }
  const issues: string[] = [];
  if (!isRecord(raw)) return { ok: false, issues: ["body must be an object"] };
  exactKeys(raw, [
    "schema_version", "event_id", "session_id", "event_type", "occurred_at", "provider",
    "channel", "direction", "contact", "intent", "consent", "appointment", "outcome",
    "handoff_summary",
  ], "$", issues);

  const schemaVersion = literal(raw.schema_version, NEWO_EVENT_SCHEMA_VERSION, "schema_version", issues);
  const eventId = identifier(raw.event_id, "event_id", issues);
  const sessionId = identifier(raw.session_id, "session_id", issues);
  const eventType = enumValue(raw.event_type, EVENT_TYPES, "event_type", issues);
  const occurredAt = isoTimestamp(raw.occurred_at, "occurred_at", issues);
  const provider = providerObject(raw.provider, issues);
  const channel = enumValue(raw.channel, CHANNELS, "channel", issues);
  const direction = enumValue(raw.direction, DIRECTIONS, "direction", issues);
  const contact = contactObject(raw.contact, issues);
  const intent = intentObject(raw.intent, issues);
  const consent = consentObject(raw.consent, issues);
  const appointment = appointmentObject(raw.appointment, issues);
  const outcome = outcomeObject(raw.outcome, issues);
  const handoffSummary = nullableString(raw.handoff_summary, 1_000, "handoff_summary", issues);

  if (eventType && needsContact(eventType) && !contact?.phone && !contact?.email) {
    issues.push("contact.phone or contact.email is required for this event_type");
  }
  if (eventType && requiresAiDisclosure(eventType) && consent && !consent.ai_disclosed) {
    issues.push("consent.ai_disclosed must be true for an answered session event");
  }
  if (outcome?.recording_ref && consent && !consent.recording_disclosed) {
    issues.push("consent.recording_disclosed must be true when outcome.recording_ref is present");
  }
  if (eventType === "handoff_requested" && !handoffSummary) {
    issues.push("handoff_summary is required for handoff_requested");
  }
  if (eventType === "booking_requested" && appointment?.preferred_windows.length === 0) {
    issues.push("appointment.preferred_windows must contain at least one window for booking_requested");
  }
  if (eventType === "booking_cancelled" && !appointment?.request_id) {
    issues.push("appointment.request_id is required for booking_cancelled");
  }
  if (issues.length > 0 || !schemaVersion || !eventId || !sessionId || !eventType || !occurredAt ||
    !provider || !channel || !direction || !contact || !intent || !consent || !appointment || !outcome) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      schema_version: schemaVersion,
      event_id: eventId,
      session_id: sessionId,
      event_type: eventType,
      occurred_at: occurredAt,
      provider,
      channel,
      direction,
      contact,
      intent,
      consent,
      appointment,
      outcome,
      handoff_summary: handoffSummary,
    },
  };
}

export function parseNewoAvailabilityRequest(
  rawText: string,
): ParseResult<NewoAvailabilityRequestV1> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { ok: false, issues: ["body must be valid JSON"] };
  }
  const issues: string[] = [];
  if (!isRecord(raw)) return { ok: false, issues: ["body must be an object"] };
  exactKeys(raw, [
    "schema_version", "request_id", "session_id", "occurred_at", "timezone", "service",
    "division", "preferred_windows",
  ], "$", issues);
  const schemaVersion = literal(
    raw.schema_version,
    NEWO_AVAILABILITY_SCHEMA_VERSION,
    "schema_version",
    issues,
  );
  const requestId = identifier(raw.request_id, "request_id", issues);
  const sessionId = identifier(raw.session_id, "session_id", issues);
  const occurredAt = isoTimestamp(raw.occurred_at, "occurred_at", issues);
  const timezone = requiredString(raw.timezone, 80, "timezone", issues);
  const service = nullableString(raw.service, 160, "service", issues);
  const division = nullableEnumValue(raw.division, DIVISIONS, "division", issues);
  const preferredWindows = preferredWindowsArray(raw.preferred_windows, issues);
  if (issues.length > 0 || !schemaVersion || !requestId || !sessionId || !occurredAt ||
    !timezone || !preferredWindows) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      schema_version: schemaVersion,
      request_id: requestId,
      session_id: sessionId,
      occurred_at: occurredAt,
      timezone,
      service,
      division,
      preferred_windows: preferredWindows,
    },
  };
}

async function handleAvailability(req: Request, env: NewoRuntimeEnv): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const rawText = await readBounded(req);
  if (rawText === null) return json({ error: "payload_too_large" }, 413);
  const parsed = parseNewoAvailabilityRequest(rawText);
  if (!parsed.ok) return json({ error: "invalid_payload", issues: parsed.issues }, 422);
  const mode = bookingMode(env);
  if (mode !== "request_only") {
    return json({ error: "confirmed_booking_not_proven" }, 503);
  }
  return json({
    schema_version: "newo.availability-response.v1",
    request_id: parsed.value.request_id,
    session_id: parsed.value.session_id,
    booking_mode: mode,
    horizon_days: bookingHorizonDays(env),
    available_slots: [],
    can_request: true,
    message: "Collect preferred windows and submit an appointment request.",
  });
}

async function acceptEvent(
  env: NewoRuntimeEnv,
  ctx: ExecutionContext,
  event: NewoEventV1,
  rawText: string,
): Promise<Response> {
  const hash = await sha256Hex(canonicalJson(event));
  const existing = await getNewoReceipt(env, event.event_id);
  if (existing) {
    if (existing.payload_hash !== hash) {
      const conflictKey = rawKeyFor(event, hash.slice(0, 12), "conflicts");
      await store.putRaw(env, conflictKey, rawText, "application/json");
      await recordConflict(env, event, existing.payload_hash, hash, conflictKey);
      return json({ error: "event_id_conflict", event_id: event.event_id }, 409);
    }
    await touchNewoReceipt(env, event.event_id, new Date().toISOString());
    if (existing.status === "accepted") {
      return new Response(existing.response_json, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "x-newo-replay": "true" },
      });
    }
    if (existing.status === "processing") {
      return json({ error: "event_processing", event_id: event.event_id }, 202);
    }
    if (existing.status === "dead") {
      return json({ error: "event_dead", event_id: event.event_id }, 409);
    }
  }

  const rawKey = rawKeyFor(event);
  await store.putRaw(env, rawKey, rawText, "application/json");
  if (existing?.status === "failed") {
    if (!await restartFailedNewoReceipt(env, event.event_id, new Date().toISOString())) {
      return json({ error: "event_processing", event_id: event.event_id }, 202);
    }
  } else {
    const claim = await claimNewoReceipt(env, {
      event_id: event.event_id,
      session_id: event.session_id,
      event_type: event.event_type,
      payload_hash: hash,
      raw_key: rawKey,
    }, new Date().toISOString());
    if (claim === "existing") {
      return json({ error: "event_processing", event_id: event.event_id }, 202);
    }
  }

  try {
    const existingSession = await getNewoSession(env, event.session_id);
    const envelope = await ensureSessionEnvelope(env, event, rawKey, existingSession);
    const appointmentRequestId = appointmentRequestIdFor(event, existingSession);
    const response = toolReceipt(event, envelope?.envelope_id ?? existingSession?.lead_envelope_id ?? null,
      appointmentRequestId, bookingMode(env));
    await upsertNewoSession(env, sessionRecord(
      env,
      event,
      rawKey,
      hash,
      envelope?.envelope_id ?? existingSession?.lead_envelope_id ?? null,
      appointmentRequestId,
      existingSession,
    ));
    await store.recordAudit(env, {
      automation: "newo_reception",
      trigger: event.event_type,
      envelope_id: response.envelope_id,
      source_ids: `event:${event.event_id},session:${event.session_id}`,
      action: "event_accepted",
      result: "ok",
      recovery_owner: env.OWNER_ALERT_EMAIL,
    });
    await env.NEWO_QUEUE.send({ newo_event_id: event.event_id });
    if (
      response.envelope_id
      && existingSession?.verification_status !== "verified"
      && existingSession?.verification_status !== "ambiguous"
      && existingSession?.verification_status !== "verification_failed"
    ) {
      await env.JN_QUEUE.send({ envelope_id: response.envelope_id });
    }
    scheduleNotifications(env, ctx, event, envelope);
    await completeNewoReceipt(env, event.event_id, response.envelope_id, response, new Date().toISOString());
    return json(response);
  } catch (error) {
    await failNewoReceipt(env, event.event_id, String(error), new Date().toISOString()).catch(() => {});
    await store.recordAudit(env, {
      automation: "newo_reception",
      trigger: event.event_type,
      envelope_id: null,
      source_ids: `event:${event.event_id},session:${event.session_id}`,
      action: "event_accept_failed",
      result: "error",
      error: String(error),
      recovery_owner: env.OWNER_ALERT_EMAIL,
    }).catch(() => {});
    throw error;
  }
}

async function ensureSessionEnvelope(
  env: NewoRuntimeEnv,
  event: NewoEventV1,
  rawKey: string,
  existing: NewoSessionRecord | null,
): Promise<EnvelopeRecord | null> {
  if (existing?.lead_envelope_id) return null;
  if (!event.contact.phone && !event.contact.email) return null;
  const now = new Date().toISOString();
  const envelopeId = newEnvelopeId();
  const intentText = [event.intent.service, event.intent.division, event.intent.message].filter(Boolean).join(" ");
  const payload = {
    provider: "newo",
    schema_version: event.schema_version,
    event_id: event.event_id,
    session_id: event.session_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    contact: event.contact,
    intent: event.intent,
    address_line1: event.contact.address.line1,
    city: event.contact.address.city,
    province: event.contact.address.province,
    postal_code: event.contact.address.postal_code,
    service: event.intent.service,
    service_intent: [event.intent.service, event.intent.division, event.intent.message]
      .filter(Boolean).join(" "),
    message: event.intent.message,
    consent: event.consent,
    appointment: event.appointment,
    outcome: event.outcome,
    handoff_summary: event.handoff_summary,
    ...(existing?.verification_status === "verified" ? {
      owned_association: {
        customer_id: existing.matched_customer_id,
        property_key: existing.matched_property_id,
        roof_job_id: existing.matched_roof_job_id,
        verification_status: "verified",
      },
    } : {}),
  };
  const rec: EnvelopeRecord = {
    envelope_id: envelopeId,
    source: "phone",
    contact_name: event.contact.name,
    contact_phone: event.contact.phone,
    contact_email: event.contact.email,
    job_ref: null,
    payload_json: JSON.stringify(payload),
    raw_key: rawKey,
    ts: event.occurred_at,
    status: "pending_jn_push",
    dedup_key: `newo-session:${event.session_id}`,
    dup_of: null,
    attempts: 0,
    last_error: null,
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: classifyIntent(intentText),
    created_at: now,
    updated_at: now,
  };
  await store.insertEnvelope(env, rec);
  return rec;
}

function sessionRecord(
  env: NewoRuntimeEnv,
  event: NewoEventV1,
  rawKey: string,
  hash: string,
  envelopeId: string | null,
  appointmentRequestId: string | null,
  existing: NewoSessionRecord | null,
): NewoSessionRecord {
  const now = new Date().toISOString();
  return {
    session_id: event.session_id,
    project_id: event.provider.project_id,
    agent_id: event.provider.agent_id,
    user_actor_id: event.provider.user_actor_id,
    conversation_id: event.provider.conversation_id,
    channel: event.channel,
    direction: event.direction,
    status: sessionStatus(event.event_type),
    outcome: event.outcome.status,
    contact_name: event.contact.name,
    contact_phone: event.contact.phone,
    contact_email: event.contact.email,
    address_line1: event.contact.address.line1,
    city: event.contact.address.city,
    province: event.contact.address.province,
    postal_code: event.contact.address.postal_code,
    division: event.intent.division,
    service: event.intent.service,
    urgency: event.intent.urgency,
    lead_envelope_id: envelopeId,
    appointment_request_id: appointmentRequestId,
    handoff_status: newoHandoffStatus(event),
    booking_status: bookingStatus(event),
    summary: event.outcome.summary,
    transcript_ref: event.outcome.transcript_ref,
    recording_ref: event.outcome.recording_ref,
    ai_disclosed: event.consent.ai_disclosed ? 1 : 0,
    recording_disclosed: event.consent.recording_disclosed ? 1 : 0,
    structured_json: JSON.stringify(event),
    raw_key: rawKey,
    payload_hash: hash,
    started_at: event.outcome.started_at,
    ended_at: event.outcome.ended_at,
    duration_seconds: event.outcome.duration_seconds,
    report_expected_at: isSessionReport(event.event_type) ? null : reportExpectedAt(env, event.occurred_at),
    report_received_at: isSessionReport(event.event_type) ? event.occurred_at : existing?.report_received_at ?? null,
    report_event_id: isSessionReport(event.event_type) ? event.event_id : existing?.report_event_id ?? null,
    missing_report_detected_at: isSessionReport(event.event_type)
      ? null
      : existing?.missing_report_detected_at ?? null,
    sync_status: "pending",
    sync_attempts: existing?.sync_attempts ?? 0,
    last_error: null,
    sync_updated_at: now,
    created_at: existing?.created_at ?? now,
    updated_at: event.occurred_at,
  };
}

function toolReceipt(
  event: NewoEventV1,
  envelopeId: string | null,
  appointmentRequestId: string | null,
  mode: "request_only" | "confirmed",
): NewoToolReceipt {
  const booking = bookingStatus(event);
  return {
    schema_version: NEWO_TOOL_RECEIPT_SCHEMA_VERSION,
    event_id: event.event_id,
    session_id: event.session_id,
    status: "accepted",
    envelope_id: envelopeId,
    appointment_request_id: appointmentRequestId,
    booking_mode: mode,
    booking_status: booking === "requested" || booking === "cancelled" ? booking : "not_requested",
    message: receiptMessage(event.event_type),
  };
}

function scheduleNotifications(
  env: NewoRuntimeEnv,
  ctx: ExecutionContext,
  event: NewoEventV1,
  envelope: EnvelopeRecord | null,
): void {
  if (event.event_type === "missed_call" && event.consent.follow_up_email && envelope?.contact_email) {
    ctx.waitUntil(sendInstantAck(env, envelope).catch((error) =>
      console.log(JSON.stringify({ at: "newo_missed_call_ack", event_id: event.event_id, error: String(error) }))));
  }
  for (const alert of newoOwnerAlerts(event)) {
    ctx.waitUntil(sendOwnerAlert(env, alert.subject, alert.html).catch((error) =>
      console.log(JSON.stringify({ at: `newo_${alert.kind}_alert`, event_id: event.event_id, error: String(error) }))));
  }
}

/**
 * The receptionist is callback only (owner decisions MD-05 and D-03). A handoff request that
 * reaches the Worker is a requested callback, so one sent without a status is recorded as
 * "requested". "failed" keeps its meaning: the handoff request did not arrive or could not be
 * processed, and only that opens the failed-handoff exception a person resolves.
 */
export function newoHandoffStatus(event: NewoEventV1): string | null {
  return event.outcome.handoff_status ?? (event.event_type === "handoff_requested" ? "requested" : null);
}

/** The owner alerts one accepted event raises: a callback request, or a failed handoff or session. */
export function newoOwnerAlerts(
  event: NewoEventV1,
): Array<{ kind: "handoff" | "failure"; subject: string; html: string }> {
  const alerts: Array<{ kind: "handoff" | "failure"; subject: string; html: string }> = [];
  if (event.event_type === "handoff_requested") {
    const urgent = event.intent.urgency !== "routine";
    alerts.push({
      kind: "handoff",
      subject: urgent ? `Urgent Newo callback requested - ${event.intent.urgency}` : "Newo callback requested",
      html: `<p>Session ${escapeHtml(event.session_id)} asked for a callback.</p><p>${escapeHtml(event.handoff_summary ?? "No reason supplied")}</p>`,
    });
  }
  if (event.event_type === "session_failed" || newoHandoffStatus(event) === "failed") {
    alerts.push({
      kind: "failure",
      subject: "Urgent Newo callback required",
      html: `<p>Handoff or session failed for ${escapeHtml(event.contact.name ?? event.contact.phone ?? event.session_id)}.</p>`,
    });
  }
  return alerts;
}

async function recordConflict(
  env: NewoRuntimeEnv,
  event: NewoEventV1,
  originalHash: string,
  conflictingHash: string,
  conflictKey: string,
): Promise<void> {
  const error = `event_id_conflict:${originalHash.slice(0, 12)}:${conflictingHash.slice(0, 12)}`;
  await store.recordAudit(env, {
    automation: "newo_reception",
    trigger: event.event_type,
    envelope_id: null,
    source_ids: `event:${event.event_id},session:${event.session_id},raw:${conflictKey}`,
    action: "idempotency_conflict",
    result: "error",
    error,
    recovery_owner: env.OWNER_ALERT_EMAIL,
  });
  await store.recordDeadLetter(env, {
    envelope_id: null,
    stage: "newo_event_conflict",
    error,
    payload_json: JSON.stringify({ event_id: event.event_id, session_id: event.session_id }),
  });
}

function providerObject(value: unknown, issues: string[]): NewoEventV1["provider"] | null {
  if (!isRecord(value)) {
    issues.push("provider must be an object");
    return null;
  }
  exactKeys(value, ["project_id", "agent_id", "user_actor_id", "conversation_id"], "provider", issues);
  return {
    project_id: nullableIdentifier(value.project_id, "provider.project_id", issues),
    agent_id: nullableIdentifier(value.agent_id, "provider.agent_id", issues),
    user_actor_id: nullableIdentifier(value.user_actor_id, "provider.user_actor_id", issues),
    conversation_id: nullableIdentifier(value.conversation_id, "provider.conversation_id", issues),
  };
}

function contactObject(value: unknown, issues: string[]): NewoEventV1["contact"] | null {
  if (!isRecord(value)) {
    issues.push("contact must be an object");
    return null;
  }
  exactKeys(value, ["name", "phone", "email", "address"], "contact", issues);
  const address = addressObject(value.address, issues);
  const phoneRaw = nullableString(value.phone, 40, "contact.phone", issues);
  const emailRaw = nullableString(value.email, 254, "contact.email", issues);
  const phone = phoneRaw === null ? null : normalizePhone(phoneRaw);
  const email = emailRaw === null ? null : normalizeEmail(emailRaw);
  if (phoneRaw && !phone) issues.push("contact.phone must be a valid phone number");
  if (emailRaw && !email) issues.push("contact.email must be a valid email address");
  if (!address) return null;
  return {
    name: nullableString(value.name, 160, "contact.name", issues),
    phone,
    email,
    address,
  };
}

function addressObject(value: unknown, issues: string[]): NewoEventV1["contact"]["address"] | null {
  if (!isRecord(value)) {
    issues.push("contact.address must be an object");
    return null;
  }
  exactKeys(value, ["line1", "city", "province", "postal_code"], "contact.address", issues);
  return {
    line1: nullableString(value.line1, 240, "contact.address.line1", issues),
    city: nullableString(value.city, 120, "contact.address.city", issues),
    province: nullableString(value.province, 80, "contact.address.province", issues),
    postal_code: nullableString(value.postal_code, 24, "contact.address.postal_code", issues),
  };
}

function intentObject(value: unknown, issues: string[]): NewoEventV1["intent"] | null {
  if (!isRecord(value)) {
    issues.push("intent must be an object");
    return null;
  }
  exactKeys(value, ["service", "division", "urgency", "message"], "intent", issues);
  const urgency = enumValue(value.urgency, URGENCIES, "intent.urgency", issues);
  if (!urgency) return null;
  return {
    service: nullableString(value.service, 160, "intent.service", issues),
    division: nullableEnumValue(value.division, DIVISIONS, "intent.division", issues),
    urgency,
    message: nullableString(value.message, 2_000, "intent.message", issues),
  };
}

function consentObject(value: unknown, issues: string[]): NewoEventV1["consent"] | null {
  if (!isRecord(value)) {
    issues.push("consent must be an object");
    return null;
  }
  exactKeys(value, ["ai_disclosed", "recording_disclosed", "follow_up_email", "follow_up_phone"], "consent", issues);
  return {
    ai_disclosed: booleanValue(value.ai_disclosed, "consent.ai_disclosed", issues),
    recording_disclosed: booleanValue(value.recording_disclosed, "consent.recording_disclosed", issues),
    follow_up_email: booleanValue(value.follow_up_email, "consent.follow_up_email", issues),
    follow_up_phone: booleanValue(value.follow_up_phone, "consent.follow_up_phone", issues),
  };
}

function appointmentObject(value: unknown, issues: string[]): NewoEventV1["appointment"] | null {
  if (!isRecord(value)) {
    issues.push("appointment must be an object");
    return null;
  }
  exactKeys(value, ["request_id", "preferred_windows", "timezone"], "appointment", issues);
  const windows = preferredWindowsArray(value.preferred_windows, issues);
  const timezone = requiredString(value.timezone, 80, "appointment.timezone", issues);
  if (!windows || !timezone) return null;
  return {
    request_id: nullableIdentifier(value.request_id, "appointment.request_id", issues),
    preferred_windows: windows,
    timezone,
  };
}

function preferredWindowsArray(value: unknown, issues: string[]): NewoPreferredWindow[] | null {
  if (!Array.isArray(value) || value.length > 10) {
    issues.push("preferred_windows must be an array with at most 10 entries");
    return null;
  }
  const windows: NewoPreferredWindow[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      issues.push(`preferred_windows[${index}] must be an object`);
      continue;
    }
    exactKeys(item, ["start", "end"], `preferred_windows[${index}]`, issues);
    const start = isoTimestamp(item.start, `preferred_windows[${index}].start`, issues);
    const end = nullableIsoTimestamp(item.end, `preferred_windows[${index}].end`, issues);
    if (start && end && Date.parse(end) <= Date.parse(start)) {
      issues.push(`preferred_windows[${index}].end must be after start`);
    }
    if (start) windows.push({ start, end });
  }
  return windows;
}

function outcomeObject(value: unknown, issues: string[]): NewoEventV1["outcome"] | null {
  if (!isRecord(value)) {
    issues.push("outcome must be an object");
    return null;
  }
  exactKeys(value, [
    "status", "summary", "handoff_status", "booking_status", "transcript_ref", "recording_ref",
    "started_at", "ended_at", "duration_seconds",
  ], "outcome", issues);
  const duration = value.duration_seconds;
  if (duration !== null && (typeof duration !== "number" || !Number.isInteger(duration) || duration < 0 || duration > 86_400)) {
    issues.push("outcome.duration_seconds must be null or an integer from 0 to 86400");
  }
  const startedAt = nullableIsoTimestamp(value.started_at, "outcome.started_at", issues);
  const endedAt = nullableIsoTimestamp(value.ended_at, "outcome.ended_at", issues);
  if (startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
    issues.push("outcome.ended_at must not be before outcome.started_at");
  }
  return {
    status: nullableString(value.status, 80, "outcome.status", issues),
    summary: nullableString(value.summary, 2_000, "outcome.summary", issues),
    handoff_status: nullableString(value.handoff_status, 80, "outcome.handoff_status", issues),
    booking_status: nullableString(value.booking_status, 80, "outcome.booking_status", issues),
    transcript_ref: nullableReference(value.transcript_ref, "outcome.transcript_ref", issues),
    recording_ref: nullableReference(value.recording_ref, "outcome.recording_ref", issues),
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: typeof duration === "number" && Number.isInteger(duration) ? duration : null,
  };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string, issues: string[]): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
  for (const key of expected) if (!(key in value)) issues.push(`${path}.${key} is required`);
}

function literal<T extends string>(value: unknown, expected: T, path: string, issues: string[]): T | null {
  if (value !== expected) {
    issues.push(`${path} must equal ${expected}`);
    return null;
  }
  return expected;
}

function identifier(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    issues.push(`${path} must be a non-empty provider identifier`);
    return null;
  }
  return value;
}

function nullableIdentifier(value: unknown, path: string, issues: string[]): string | null {
  if (value === null) return null;
  return identifier(value, path, issues);
}

function requiredString(value: unknown, max: number, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    issues.push(`${path} must be a non-empty string no longer than ${max} characters`);
    return null;
  }
  return value.trim();
}

function nullableString(value: unknown, max: number, path: string, issues: string[]): string | null {
  if (value === null) return null;
  return requiredString(value, max, path, issues);
}

function nullableReference(value: unknown, path: string, issues: string[]): string | null {
  const reference = nullableString(value, 500, path, issues);
  if (reference && !/^(https:\/\/|r2:|newo:)[^\s]+$/i.test(reference)) {
    issues.push(`${path} must be an https, r2, or newo pointer`);
    return null;
  }
  return reference;
}

function booleanValue(value: unknown, path: string, issues: string[]): boolean {
  if (typeof value !== "boolean") {
    issues.push(`${path} must be a boolean`);
    return false;
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: string[]): T | null {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.push(`${path} must be one of ${allowed.join(", ")}`);
    return null;
  }
  return value as T;
}

function nullableEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: string[],
): T | null {
  if (value === null) return null;
  return enumValue(value, allowed, path, issues);
}

function isoTimestamp(value: unknown, path: string, issues: string[]): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    issues.push(`${path} must be an ISO 8601 timestamp`);
    return null;
  }
  return new Date(value).toISOString();
}

function nullableIsoTimestamp(value: unknown, path: string, issues: string[]): string | null {
  if (value === null) return null;
  return isoTimestamp(value, path, issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function needsContact(type: NewoEventType): boolean {
  return type !== "session_failed";
}

function requiresAiDisclosure(type: NewoEventType): boolean {
  return type === "lead_captured" || type === "handoff_requested" || type === "session_ended" ||
    type === "booking_requested" || type === "booking_cancelled";
}

function expectedEventTypes(pathname: string): readonly NewoEventType[] | null {
  if (pathname === "/webhook/newo") return ["lead_captured"];
  if (pathname === "/webhook/newo/handoff") return ["handoff_requested"];
  if (pathname === "/webhook/newo/report") return ["session_ended", "session_failed", "missed_call"];
  if (pathname === "/webhook/newo/booking") return ["booking_requested"];
  if (pathname === "/webhook/newo/booking/cancel") return ["booking_cancelled"];
  return null;
}

function sessionStatus(type: NewoEventType): string {
  return ({
    lead_captured: "active",
    handoff_requested: "handoff_requested",
    session_ended: "ended",
    session_failed: "failed",
    missed_call: "missed",
    booking_requested: "appointment_requested",
    booking_cancelled: "appointment_cancelled",
  } as const)[type];
}

function isSessionReport(type: NewoEventType): boolean {
  return type === "session_ended" || type === "session_failed" || type === "missed_call";
}

function reportExpectedAt(env: NewoRuntimeEnv, occurredAt: string): string {
  const configured = Number(env.NEWO_REPORT_TIMEOUT_MINUTES ?? "30");
  const minutes = Number.isInteger(configured) && configured >= 5 && configured <= 24 * 60
    ? configured
    : 30;
  return new Date(Date.parse(occurredAt) + minutes * 60_000).toISOString();
}

function bookingStatus(event: NewoEventV1): string | null {
  if (event.event_type === "booking_requested") return "requested";
  if (event.event_type === "booking_cancelled") return "cancelled";
  return event.outcome.booking_status;
}

function appointmentRequestIdFor(
  event: NewoEventV1,
  existing: NewoSessionRecord | null,
): string | null {
  if (event.appointment.request_id) return event.appointment.request_id;
  if (existing?.appointment_request_id) return existing.appointment_request_id;
  return event.event_type === "booking_requested" ? `nar_${crypto.randomUUID()}` : null;
}

function receiptMessage(type: NewoEventType): string {
  if (type === "booking_requested") return "Appointment request received.";
  if (type === "booking_cancelled") return "Appointment request cancellation received.";
  if (type === "handoff_requested") return "Handoff request recorded.";
  if (type === "session_ended" || type === "session_failed" || type === "missed_call") {
    return "Session report received.";
  }
  return "Lead captured.";
}

function bookingMode(env: NewoRuntimeEnv): "request_only" | "confirmed" {
  return String(env.NEWO_BOOKING_MODE) === "confirmed" ? "confirmed" : "request_only";
}

function bookingHorizonDays(env: NewoRuntimeEnv): number {
  const value = Number(env.NEWO_BOOKING_HORIZON_DAYS ?? "30");
  return Number.isInteger(value) && value >= 1 && value <= 90 ? value : 30;
}

function rawKeyFor(event: NewoEventV1, suffix?: string, prefix = "events"): string {
  const eventId = event.event_id.replace(/[^A-Za-z0-9_.:-]/g, "_");
  const extra = suffix ? `-${suffix}` : "";
  return `raw/newo/${prefix}/${event.occurred_at.slice(0, 10)}/${eventId}${extra}.json`;
}

function authenticate(req: Request, secret: string | undefined, missingCode: string): Response | null {
  if (!secret?.trim()) return json({ error: missingCode }, 503);
  const header = req.headers.get("authorization") ?? "";
  const actual = header.startsWith("Bearer ") ? header.slice(7) : "";
  return constantTimeEqual(actual, secret) ? null : json({ error: "unauthorized" }, 401);
}

function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

async function readBounded(req: Request): Promise<string | null> {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_NEWO_BODY_BYTES) return null;
  const body = await req.text();
  return new TextEncoder().encode(body).byteLength <= MAX_NEWO_BODY_BYTES ? body : null;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
