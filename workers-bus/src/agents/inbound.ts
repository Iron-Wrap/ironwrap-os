// The inbound producer (AI-TEAM-CONTRACT.md "The inbound signal", watch `new_inbound`).
//
// Every inbound envelope becomes one `event` signal for the AI receptionist, about the lead the
// envelope materializes. insertEnvelope (src/store.ts) appends it right after the envelope row for
// the three paths that write one (generic ingest, the estimator and Newo), best effort; the
// five-minute cron sweeps any inbound envelope still without one. `inbound:<envelope_id>` makes the
// two count once. Both stay off until AGENT_INBOUND_FROM names the instant from which envelopes
// are inbound. A CRM import writes its envelopes without insertEnvelope and is never inbound, and
// a release-smoke row produces nothing.
//
// The content has no field for the sender's name, phone or email. A match against the tenant's
// customers is recorded only and links nothing. The excerpt and the form fields are what the
// sender wrote, so they may hold a name, a number or an address (the form's address is one); like
// all signal content they are untrusted text, read only by the receptionist's run on the signal.

import { ALLOWED_SOURCES, normalizeEmail, normalizePhone, type EnvelopeRecord } from "../core.ts";
import { stableId } from "../operating-core.ts";
import { INBOUND_CHANNELS } from "./policy.ts";
import { appendSignal, type AgentDb } from "./store.ts";

export { INBOUND_CHANNELS };

export type InboundChannel =
  | "web_form"
  | "instant_estimate"
  | "phone"
  | "newo_call"
  | "walk_in"
  | "office"
  | "gbp"
  | "ad"
  | "referral";

/** The tenant's customer the sender's email or phone already belongs to, if any. */
export interface InboundSender {
  customer_id: string | null;
  matched_on: "email" | "phone" | "email_and_phone" | null;
  conflict: boolean;
}

export interface InboundContent {
  envelope_id: string;
  channel: InboundChannel;
  brand: "ironwrap" | "iroof" | null;
  /** Which of the tenant's addresses or numbers it reached; null until intake records that. */
  received_via: null;
  sender: InboundSender;
  has_phone: boolean;
  has_email: boolean;
  service: string | null;
  excerpt: string | null;
  form_fields: { address: string | null; scope: string | null; timing: string | null };
}

/** The envelope sources the intake paths write; no other is inbound. */
const SOURCES: readonly string[] = ALLOWED_SOURCES;
const NO_MATCH: InboundSender = { customer_id: null, matched_on: null, conflict: false };
// The lengths lead_fact.propose takes for each value (registry.ts LEAD_FACT_FIELDS), and the
// excerpt's.
const SERVICE_MAX = 200;
const ADDRESS_MAX = 600;
const SCOPE_MAX = 2000;
const TIMING_MAX = 600;
const EXCERPT_MAX = 1000;
/** How far back the cron's sweep looks for an envelope without its signal. */
export const SWEEP_WINDOW_MS = 48 * 3_600_000;
/** How long intake waits on the hook before it goes on; the sweep produces what that leaves. */
const HOOK_WAIT_MS = 2_000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

const log = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

/**
 * The instant from which envelopes are inbound (AGENT_INBOUND_FROM), in the envelopes' own ISO
 * form so the two compare as text. Unset, blank or not an ISO instant with its zone, the producer
 * is off.
 */
export function inboundFrom(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!ISO_INSTANT.test(value)) return null;
  // Date.parse rolls 2026-02-30 or T24:00 forward; a date the calendar lacks is off, not shifted.
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second)
    return null;
  return new Date(Date.parse(value)).toISOString();
}

/**
 * The tenant's customer whose email or phone the sender's equals, both normalized; the customer
 * this envelope itself created is no match. Recorded only, it links nothing. Email and phone that
 * belong to two different customers are a conflict, which names neither.
 */
export async function senderMatch(db: AgentDb, tenantId: string, envelope: EnvelopeRecord): Promise<InboundSender> {
  const email = normalizeEmail(envelope.contact_email);
  const phone = normalizePhone(envelope.contact_phone);
  if (email === null && phone === null) return NO_MATCH;
  const rows = await db
    .prepare(
      `SELECT customer_id, contact_email, contact_phone FROM operating_customers
        WHERE tenant_id = ? AND source_envelope_id <> ? AND (contact_email = ? OR contact_phone = ?)`,
    )
    .bind(tenantId, envelope.envelope_id, email, phone)
    .all<{ customer_id: string; contact_email: string | null; contact_phone: string | null }>();
  const found = rows.results ?? [];
  const byEmail = email === null ? undefined : found.find((row) => row.contact_email === email)?.customer_id;
  const byPhone = phone === null ? undefined : found.find((row) => row.contact_phone === phone)?.customer_id;
  if (byEmail && byPhone)
    return byEmail === byPhone ? { customer_id: byEmail, matched_on: "email_and_phone", conflict: false } : { customer_id: null, matched_on: null, conflict: true };
  if (byEmail) return { customer_id: byEmail, matched_on: "email", conflict: false };
  if (byPhone) return { customer_id: byPhone, matched_on: "phone", conflict: false };
  return NO_MATCH;
}

/**
 * The `new_inbound` signal of one envelope, with its sender match: its subject is the lead the
 * envelope materializes, whether or not that lead exists yet. Null for a source no intake path
 * writes.
 */
export async function inboundSignal(tenantId: string, envelope: EnvelopeRecord, sender: InboundSender) {
  const payload = payloadOf(envelope.payload_json);
  const channel = channelOf(envelope.source, payload);
  if (channel === null) return null;
  const estimator = objectOf(payload.public_estimator);
  const content: InboundContent = {
    envelope_id: envelope.envelope_id,
    channel,
    brand: brandOf(payload.brand) ?? brandOf(estimator?.brand),
    received_via: null,
    sender,
    has_phone: normalizePhone(envelope.contact_phone) !== null,
    has_email: normalizeEmail(envelope.contact_email) !== null,
    service: firstText([payload.service, payload.service_intent], SERVICE_MAX),
    // The customer's own words: a form's message, or what a Newo call handed off.
    excerpt: firstText([payload.message, payload.handoff_summary], EXCERPT_MAX),
    form_fields: {
      address: addressOf(payload),
      scope: firstText([payload.scope, payload.project_scope, estimator?.scope], SCOPE_MAX),
      timing: firstText([payload.timing, payload.preferred_time, payload.timeline], TIMING_MAX),
    },
  };
  return {
    kind: "event" as const,
    specialist_id: "lead_concierge",
    watch_id: "new_inbound",
    source: channel,
    // materializeOperatingCore's lead id for this envelope (operating-core.ts).
    subject: { aggregate: "lead", id: await stableId("lead", tenantId, envelope.envelope_id.trim()) },
    content,
    dedupe_key: `inbound:${envelope.envelope_id}`,
  };
}

/**
 * Appends an envelope's `new_inbound` signal once; a repeat answers the signal already there. Null
 * for a source no intake path writes; a signal the store cannot append throws.
 */
export async function produceInbound(
  db: AgentDb,
  tenantId: string,
  envelope: EnvelopeRecord,
  now: string,
): Promise<{ signal_id: string; created: boolean } | null> {
  const signal = await inboundSignal(tenantId, envelope, await senderMatch(db, tenantId, envelope));
  if (signal === null) return null;
  const appended = await appendSignal(db, tenantId, signal, now);
  if ("error" in appended) throw new Error(appended.error);
  return appended;
}

/**
 * The producer's call at the end of insertEnvelope (src/store.ts): best effort, and it never
 * throws, so intake never fails for the AI team; the sweep produces what it misses. With the
 * producer off it reads nothing.
 */
export async function inboundAfterInsert(
  env: { DB: unknown; AGENT_INBOUND_FROM?: string },
  tenantId: string,
  envelope: EnvelopeRecord,
): Promise<void> {
  try {
    const from = inboundFrom(env.AGENT_INBOUND_FROM);
    if (from === null || !isInbound(envelope, from)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("inbound_hook_timeout")), HOOK_WAIT_MS)));
    try {
      await Promise.race([produceInbound(env.DB as AgentDb, tenantId, envelope, new Date().toISOString()), late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (error) {
    log({ at: "agent_inbound", envelope_id: envelope.envelope_id, error: String(error) });
  }
}

/**
 * The cron's backstop: produces the signal of each inbound envelope recorded in the last
 * SWEEP_WINDOW_MS, and at or after `from` (as inboundFrom gives it), that has none, oldest first, at
 * most `limit` a tick. One that fails is counted and logged and comes back on the next tick; the
 * others still run. The window keeps each tick's read bounded; an envelope its hook and two days of
 * ticks all missed gets no signal.
 */
export async function sweepInbound(
  db: AgentDb,
  tenantId: string,
  from: string,
  now: string,
  limit = 25,
): Promise<{ produced: number; failed: number }> {
  // The same envelopes isInbound admits.
  const floor = new Date(Math.max(Date.parse(from), Date.parse(now) - SWEEP_WINDOW_MS)).toISOString();
  const pending = await db
    .prepare(
      `SELECT * FROM envelopes e
        WHERE e.tenant_id = ? AND e.created_at >= ? AND e.release_smoke <> 1 AND e.raw_key IS NOT NULL
          AND e.envelope_id NOT LIKE 'ow\\_imp\\_%' ESCAPE '\\' AND e.source IN (${SOURCES.map(() => "?").join(", ")})
          AND NOT EXISTS (SELECT 1 FROM agent_signals s WHERE s.tenant_id = e.tenant_id AND s.dedupe_key = 'inbound:' || e.envelope_id)
        ORDER BY e.created_at ASC, e.envelope_id ASC LIMIT ?`,
    )
    .bind(tenantId, floor, ...SOURCES, limit)
    .all<EnvelopeRecord>();
  let produced = 0;
  let failed = 0;
  for (const envelope of pending.results ?? []) {
    try {
      if ((await produceInbound(db, tenantId, envelope, now))?.created) produced += 1;
    } catch (error) {
      failed += 1;
      log({ at: "agent_inbound_sweep", envelope_id: envelope.envelope_id, error: String(error) });
    }
  }
  return { produced, failed };
}

/**
 * An envelope is inbound from `from` on, unless it is a release smoke, has no raw body, or a CRM
 * import wrote it.
 */
function isInbound(envelope: EnvelopeRecord, from: string): boolean {
  return (
    envelope.release_smoke !== 1 &&
    envelope.raw_key !== null &&
    !envelope.envelope_id.startsWith("ow_imp_") &&
    SOURCES.includes(envelope.source) &&
    envelope.created_at >= from
  );
}

/** The channel an envelope came by, read from its intake path's own payload marks. */
function channelOf(source: string, payload: Record<string, unknown>): InboundChannel | null {
  switch (source) {
    case "website":
      return payload.instant_estimate === true ? "instant_estimate" : "web_form";
    case "phone":
      return payload.provider === "newo" ? "newo_call" : "phone";
    case "manual":
      return objectOf(payload.office_capture)?.intake_source === "walk_in" ? "walk_in" : "office";
    case "gbp":
    case "ad":
    case "referral":
      return source;
    default:
      return null;
  }
}

/**
 * The address as the sender gave it, from the keys the operating core reads (operating-core.ts) and
 * the public estimator's `state_text`: street, city, province and postal code, the blank ones
 * skipped.
 */
function addressOf(payload: Record<string, unknown>): string | null {
  const parts = [
    firstText([payload.address, payload.address1, payload.address_line1], ADDRESS_MAX),
    text(payload.city, ADDRESS_MAX),
    firstText([payload.province, payload.state, payload.state_text], ADDRESS_MAX),
    firstText([payload.postal, payload.postal_code, payload.zip], ADDRESS_MAX),
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? text(parts.join(", "), ADDRESS_MAX) : null;
}

/** The brand, as the operating core reads it (operating-core.ts normalizedBrand). */
function brandOf(value: unknown): "ironwrap" | "iroof" | null {
  const brand = typeof value === "string" ? value.trim().toLowerCase() : null;
  return brand === "ironwrap" || brand === "iroof" ? brand : null;
}

/** Trimmed text of at most `max` characters as the argument schemas count them; null if blank. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? [...trimmed].slice(0, max).join("").trimEnd() : null;
}

function firstText(values: unknown[], max: number): string | null {
  for (const value of values) {
    const found = text(value, max);
    if (found !== null) return found;
  }
  return null;
}

/** A payload that does not parse reads as empty: the signal still comes, with nothing from it. */
function payloadOf(json: string): Record<string, unknown> {
  try {
    return objectOf(JSON.parse(json)) ?? {};
  } catch {
    return {};
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
