// core.ts — PURE logic for the IronWrap integration bus.
// No I/O, no Workers globals (except crypto.randomUUID, which exists in Node 22 too),
// so this file is unit-testable with `node --test`. All side effects live in the adapters.

export const ALLOWED_SOURCES = [
  "website", "phone", "gbp", "ad", "referral", "manual",
] as const;
export type Source = (typeof ALLOWED_SOURCES)[number];
export const MAX_SOURCE_COUNT = 1_000_000;

export interface Contact {
  name?: string;
  phone?: string;
  email?: string;
}

/** The canonical lead envelope (spec 03). job_ref is optional; some owned estimate flows provide it before JobNimbus. */
export interface Envelope {
  source: Source;
  contact: Contact;
  job_ref: string | null;
  payload: Record<string, unknown>;
  ts: string; // ISO 8601
}

export type Status =
  | "received"        // raw stored + envelope written
  | "pending_jn_push" // queued for JobNimbus
  | "pushed"          // landed in JobNimbus
  | "jn_skipped"      // JOBNIMBUS_ENABLED=false: honest skip, not a fake push
  | "reconciled"      // confirmed by daily reconcile
  | "duplicate"       // deduped against an earlier envelope
  | "dead";           // exhausted retries → dead-letter

/** The D1 row shape for a stored envelope. */
export interface EnvelopeRecord {
  envelope_id: string;
  source: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  job_ref: string | null;
  payload_json: string;
  raw_key: string | null;
  ts: string;
  status: Status;
  dedup_key: string | null;
  dup_of: string | null;
  attempts: number;
  last_error: string | null;
  jn_contact_id: string | null;
  jn_job_id: string | null;
  estimate_submission_key?: string | null;
  erpnext_lead_envelope_id?: string | null;
  erpnext_roofing_property_id?: string | null;
  erpnext_roof_job_id?: string | null;
  erpnext_instant_estimate_session_id?: string | null;
  erpnext_synced_at?: string | null;
  erpnext_error?: string | null;
  intent_queue: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReconcileRow {
  channel: string;
  source: number; // independent ground-truth count
  landed: number; // envelopes recorded
  gap: number;    // source - landed; > 0 means a source event never became an envelope
}

export type SourceCountValidation =
  | { ok: true; day: string; channel: Source; count: number }
  | { ok: false; reason: "invalid_day" | "invalid_channel" | "invalid_count" };

/** Stable owned-intake identity for an event. */
export function newEnvelopeId(): string {
  return "ow_" + crypto.randomUUID();
}

/**
 * Normalize a phone to E.164-ish. Canadian/US default to +1 for bare 10-digit numbers.
 * Returns null when there aren't enough digits to be a phone (so dedup doesn't key on junk).
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  const hadPlus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (!hadPlus && digits.length === 10) return "+1" + digits;
  if (!hadPlus && digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return (hadPlus ? "+" : "") + digits;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  // intentionally lenient: a single @ with a dotted domain. Validation, not RFC parsing.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

const FIELD_ALIASES: Record<keyof Contact, string[]> = {
  name: ["name", "full_name", "fullname", "contact_name", "customer", "customer_name"],
  phone: ["phone", "phone_number", "tel", "telephone", "mobile", "cell"],
  email: ["email", "email_address", "e-mail"],
};

function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of Object.keys(raw)) {
    if (keys.includes(k.toLowerCase())) return raw[k];
  }
  return undefined;
}

/** Build the canonical contact from arbitrary inbound form fields. */
export function extractContact(raw: Record<string, unknown>): Contact {
  let name = pick(raw, FIELD_ALIASES.name);
  if (name == null) {
    const first = pick(raw, ["first_name", "firstname", "fname"]);
    const last = pick(raw, ["last_name", "lastname", "lname"]);
    name = [first, last].filter(Boolean).join(" ") || undefined;
  }
  const contact: Contact = {};
  if (typeof name === "string" && name.trim()) contact.name = name.trim();
  const phone = normalizePhone(pick(raw, FIELD_ALIASES.phone));
  if (phone) contact.phone = phone;
  const email = normalizeEmail(pick(raw, FIELD_ALIASES.email));
  if (email) contact.email = email;
  return contact;
}

/** Normalize any inbound submission into the canonical envelope. Pure. */
export function normalizeEnvelope(
  source: Source,
  raw: Record<string, unknown>,
  nowIso: string,
): Envelope {
  const jobRef = raw["job_ref"] ?? raw["job_number"] ?? raw["jobNumber"];
  const job_ref = typeof jobRef === "string" && jobRef.trim() ? jobRef.trim() : null;
  return {
    source,
    contact: extractContact(raw),
    job_ref,
    payload: raw,
    ts: nowIso,
  };
}

/** Idempotency/dedup key: phone is strongest, email is secondary (spec 03). */
export function dedupKey(contact: Contact): string | null {
  if (contact.phone) return "p:" + contact.phone;
  if (contact.email) return "e:" + contact.email;
  return null;
}

export function validateInbound(env: Envelope): { ok: boolean; reason?: string } {
  if (!ALLOWED_SOURCES.includes(env.source)) return { ok: false, reason: "unknown_source" };
  if (!env.contact.phone && !env.contact.email) {
    return { ok: false, reason: "no_contact_handle" }; // can't dedup or follow up
  }
  return { ok: true };
}

// Intent → queue routing. Order matters: most specific first.
const ROUTES: Array<[RegExp, string]> = [
  [/\b(warranty|complaint|dispute|leak|emergency)\b/i, "human_escalation"],
  [/\b(insurance|hail|claim|class\s*4)\b/i, "insurance_sales"],
  [/\b(commercial)\b/i, "commercial_queue"],
  [/\b(shop|supply|steel|slit|distribution|coil)\b/i, "shop_supply_queue"],
  [/\b(metal roof|roof|roofing|siding|cladding|gutter|soffit|fascia)\b/i, "residential_sales"],
];

/** Map free-text service intent to an owner queue. Defaults to human qualification. */
export function classifyIntent(text: unknown): string {
  const s = typeof text === "string" ? text : "";
  for (const [re, queue] of ROUTES) if (re.test(s)) return queue;
  return "human_qualification";
}

/** Daily reconciliation: per-channel source events vs envelopes landed. gap>0 ⇒ lost lead. */
export function reconcileDiff(
  sourceCounts: Record<string, number>,
  landedCounts: Record<string, number>,
): ReconcileRow[] {
  const channels = new Set([...Object.keys(sourceCounts), ...Object.keys(landedCounts)]);
  const rows: ReconcileRow[] = [];
  for (const channel of channels) {
    const source = sourceCounts[channel] ?? 0;
    const landed = landedCounts[channel] ?? 0;
    rows.push({ channel, source, landed, gap: source - landed });
  }
  return rows.sort((a, b) => b.gap - a.gap);
}

/** Strict UTC calendar-day validation (rejects impossible dates such as 2026-02-30). */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Validate one independent source-count observation before it reaches D1. */
export function validateSourceCount(
  day: unknown,
  channel: unknown,
  count: unknown,
): SourceCountValidation {
  if (!isIsoDay(day)) return { ok: false, reason: "invalid_day" };
  if (typeof channel !== "string" || !(ALLOWED_SOURCES as readonly string[]).includes(channel)) {
    return { ok: false, reason: "invalid_channel" };
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_SOURCE_COUNT) {
    return { ok: false, reason: "invalid_count" };
  }
  return { ok: true, day, channel: channel as Source, count };
}

/** Exponential backoff for the retry sweep (cap 1h). */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}

/** A push is "stuck" if still pending past the threshold — the sweep re-drives it. */
export function isStuck(updatedAtIso: string, nowMs: number, thresholdMin: number): boolean {
  const updated = Date.parse(updatedAtIso);
  if (Number.isNaN(updated)) return true; // unparseable timestamp → treat as stuck, re-drive
  return nowMs - updated > thresholdMin * 60_000;
}

/** Boolean feature flag from a string env var ("true" = on). */
export function isOn(flag: string | undefined): boolean {
  return flag === "true";
}

/** Voice-note detection by attachment extension (gate 9: field voice/photo proof). Pure. */
export function isVoiceNoteUri(uri: string): boolean {
  return /\.(m4a|mp3|wav|ogg|amr|aac)(\?|$)/i.test(uri.split("#")[0]);
}

/** Parse an inbound body by content-type (JSON or form-urlencoded), best-effort. Pure. */
export function parseBody(text: string, contentType: string | null): Record<string, unknown> {
  const ct = (contentType ?? "").toLowerCase();
  try {
    if (ct.includes("application/json")) return parsedObjectOrRaw(JSON.parse(text), text);
    if (ct.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
    return parsedObjectOrRaw(JSON.parse(text), text); // best-effort
  } catch {
    return { _raw: text };
  }
}

function parsedObjectOrRaw(value: unknown, raw: string): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { _raw: raw };
}
