// production-cancellation-window.ts - the OD-01 cancellation window (migration 0160): when it ends,
// what it holds, and a person's record of when the customer received their signed copy.
//
// The customer may cancel until 10 days after they receive their copy of the signed contract.
// Inside that window nothing is ordered from a supplier, no shop work starts and no start is
// confirmed. Nothing in D1 records that receipt (the portal's confirm step keeps its receipt in R2,
// and no email or effect delivers a signed copy), so an owner or ops person records it here. The
// register scopes the window to private dwellings, but D1 cannot tell a private dwelling from a
// commercial job, so it applies to every contract. The 15-day refund intent belongs to the
// cancellation flow (P13), not here.
//
// The window is a read-only System state next to the gates, not a gate: it has no ledger and no
// waiver, so nothing a person waives lifts it. Its state is read with D1's own clock:
//   * `unknown`, with `unknown_reason`: `signed_copy_time_missing` when nothing is recorded, or
//     `signed_copy_before_contract` when every record is from before the job's latest contract
//     signature (a later contract needs its own copy's time). The UI offers the one fix, "Add when
//     {name} received the signed copy";
//   * `open` until `ends_at`;
//   * `ended` at `ends_at`.
// While it is unknown or open, each of these is refused on the route and in D1, by name:
//   * the firm start (`firmStartGateEvidence`): `operating_job_assignment_cancellation_window_*`;
//   * the Materials attestation: `production_gate_cancellation_window_*`;
//   * a purchase order line of the job, which is how a supplier order is placed, and a job's line
//     moving back to `ordered`: `inventory_po_line_cancellation_window_*`. No route writes a line
//     today; the first that does calls `cancellationWindowHold` first, as D1 already holds it. A
//     stock line, with no job, is never held.
// Inside the window a person still assesses hazards, clears Safety and Access, asks for or decides
// a waiver (a Materials waiver lifts no hold) and drafts the plan.
//
//   POST /api/v1/production/jobs/{job}/cancellation-window/signed-copy
//     `{received_at, reason, evidence_ref}`: when the customer received their copy of the signed
//     contract. Owner or ops, people only: the CSRF token, then the person's own cookie session.
//     `received_at` is a full timestamp with its offset; the reason is at least 8 characters.
//     Each refusal names the business `time_zone`, so the times it carries read as on screen:
//       * 400 `cancellation_window_receipt_reason_required`, `..._evidence_required`, and
//         `..._reason_and_evidence_required` when both are missing (frame 20c);
//       * 409 `cancellation_window_receipt_before_contract`, with `received_at` and
//         `contract_signed_at` (frame 21). The signature time itself is allowed;
//       * 409 `cancellation_window_receipt_in_future`, with `received_at` and the server's `now`
//         (frame 22);
//       * 409 `cancellation_window_receipt_earlier_than_recorded`, with `received_at` and
//         `recorded_received_at` (frame 23). Nothing is saved, and the same time again is a no-op.
//     The window ends at the later of received + 240 hours and the same local clock time 10
//     calendar days later in the business time zone, never before the job's previous end, so a DST
//     change never ends the hold early in local time. D1 stamps the record with its own clock and
//     writes its audit row in the same statement.
//   GET /api/v1/production/jobs/{job}/gates
//     Carries `cancellation_window` next to the gates.
//   GET /api/v1/production/cancellation-window/signed-copy-missing
//     Owner and ops: the tenant's open jobs whose window is unknown, and their count. A job leaves
//     the list once its time is recorded.

import { personCookieSession, validAppCsrf } from "./app-auth.ts";
import { getCompanyProfile } from "./company-setup-store.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

export const CANCELLATION_WINDOW_DAYS = 10;
/** The business clock when the tenant names none Intl can read. */
export const FALLBACK_BUSINESS_TIME_ZONE = "America/Edmonton";
/** What the window holds while it is unknown or open. */
export const CANCELLATION_WINDOW_HOLDS = ["firm_start", "materials_attestation", "supplier_order"] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** D1's clock, in the form `Date.toISOString` writes. */
const D1_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const MAX_BODY_BYTES = 4 * 1024;
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 1_000;
const MAX_EVIDENCE_LENGTH = 300;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,160}$/;
const RECEIVED_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const MISSING_LIST_LIMIT = 100;
const RECORDER_ROLES = ["owner", "ops"] as const;

export type CancellationWindowUnknownReason =
  | "signed_copy_time_missing"
  | "signed_copy_before_contract";

export interface CancellationWindowState {
  /** A System state next to the gates: derived, never cleared or waived by anyone. */
  kind: "system_state";
  state: "unknown" | "open" | "ended";
  waivable: false;
  unknown_reason: CancellationWindowUnknownReason | null;
  ends_at: string | null;
  /** The job's latest contract, when D1 holds one. */
  contract: { acceptance_binding_id: string; signed_at: string } | null;
  /** The latest record of when the customer received their signed copy. */
  signed_copy_received: SignedCopyReceipt | null;
  holds: readonly string[];
  /** The business time zone, to read every time here on the business clock. */
  time_zone: string;
  /** D1's clock when this was read. */
  as_of: string;
}

export interface SignedCopyReceipt {
  id: string;
  received_at: string;
  window_ends_at: string;
  /** The time zone the local clock end was read in. */
  time_zone: string;
  /** The floor the record was checked against: the job's latest contract when it was made. */
  contract_signed_at: string | null;
  acceptance_binding_id: string | null;
  /** True when D1 held no contract for the job, so no floor applied. */
  no_d1_contract: boolean;
  reason: string;
  evidence_ref: string;
  recorded_at: string;
  recorded_by: { display_name: string | null; role: string };
}

export interface CancellationWindowHold {
  state: "unknown" | "open";
  /** What a one-click fix needs beside the code: the end, or why the window is unknown. */
  detail: Readonly<Record<string, string>>;
}

class CancellationWindowError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Readonly<Record<string, string>>;

  constructor(code: string, status: number, detail: Readonly<Record<string, string>> = {}) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.name = "CancellationWindowError";
  }
}

const refused = (code: string, status: number, detail?: Readonly<Record<string, string>>) =>
  new CancellationWindowError(code, status, detail);

/** The refusals D1 raises on a record (0160), as the record route answers them. */
const RECEIPT_REFUSALS: Readonly<Record<string, number>> = {
  cancellation_window_receipt_append_only: 409,
  cancellation_window_receipt_job_unknown: 404,
  cancellation_window_receipt_recorder_invalid: 403,
  cancellation_window_receipt_seed_identity_refused: 403,
  cancellation_window_receipt_reason_and_evidence_required: 400,
  cancellation_window_receipt_reason_required: 400,
  cancellation_window_receipt_evidence_required: 400,
  cancellation_window_receipt_time_invalid: 400,
  cancellation_window_receipt_in_future: 409,
  cancellation_window_receipt_contract_changed: 409,
  cancellation_window_receipt_before_contract: 409,
  cancellation_window_receipt_earlier_than_recorded: 409,
  cancellation_window_receipt_unchanged: 409,
  cancellation_window_receipt_end_invalid: 409,
  cancellation_window_receipt_recorded_at_invalid: 409,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ------------------------------------------------------------------------------- the derived state

/**
 * The window's two predicates, exactly as 0160's holds read them, over `job`. Unknown: no record at
 * or after the job's latest contract signature. Open: a record whose end is after D1's now; ends
 * never move earlier, so that is the latest record's end.
 */
const UNKNOWN_SQL = `NOT EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = job.tenant_id
       AND receipt.roof_job_id = job.roof_job_id
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings contract
          WHERE contract.tenant_id = receipt.tenant_id
            AND contract.roof_job_id = receipt.roof_job_id
            AND julianday(contract.accepted_at) > julianday(receipt.received_at)
       )
  )`;
const OPEN_SQL = `EXISTS (
    SELECT 1
      FROM production_cancellation_window_receipts receipt
     WHERE receipt.tenant_id = job.tenant_id
       AND receipt.roof_job_id = job.roof_job_id
       AND julianday(receipt.window_ends_at) > julianday('now')
  )`;
/** The job's latest contract as A2 reads it: the latest signature, then the binding id. */
const LATEST_CONTRACT_SQL = `NOT EXISTS (
      SELECT 1
        FROM commercial_acceptance_bindings later
       WHERE later.tenant_id = contract.tenant_id
         AND later.roof_job_id = contract.roof_job_id
         AND (later.accepted_at > contract.accepted_at
              OR (later.accepted_at = contract.accepted_at
                  AND later.acceptance_binding_id > contract.acceptance_binding_id))
    )`;

interface WindowFacts {
  now: string;
  unknown: number;
  open: number;
  binding_id: string | null;
  contract_signed_at: string | null;
  receipt_id: string | null;
  received_at: string | null;
  window_ends_at: string | null;
  receipt_time_zone: string | null;
  receipt_binding_id: string | null;
  receipt_contract_signed_at: string | null;
  reason: string | null;
  evidence_ref: string | null;
  recorded_at: string | null;
  recorded_by_role: string | null;
  recorded_by_name: string | null;
}

/** The window's facts for one job of the tenant, with D1's clock, or null when there is no job. */
async function windowFacts(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<WindowFacts | null> {
  return await env.DB.prepare(
    `SELECT ${D1_NOW} AS now,
            ${UNKNOWN_SQL} AS unknown,
            ${OPEN_SQL} AS open,
            contract.acceptance_binding_id AS binding_id,
            contract.accepted_at AS contract_signed_at,
            latest.receipt_id, latest.received_at, latest.window_ends_at,
            latest.time_zone AS receipt_time_zone,
            latest.acceptance_binding_id AS receipt_binding_id,
            latest.contract_signed_at AS receipt_contract_signed_at,
            latest.reason, latest.evidence_ref, latest.recorded_at, latest.recorded_by_role,
            recorder.display_name AS recorded_by_name
       FROM operating_roof_jobs job
       LEFT JOIN commercial_acceptance_bindings contract
         ON contract.tenant_id = job.tenant_id
        AND contract.roof_job_id = job.roof_job_id
        AND ${LATEST_CONTRACT_SQL}
       LEFT JOIN production_cancellation_window_receipts latest
         ON latest.tenant_id = job.tenant_id
        AND latest.roof_job_id = job.roof_job_id
        AND NOT EXISTS (
          SELECT 1
            FROM production_cancellation_window_receipts newer
           WHERE newer.tenant_id = latest.tenant_id
             AND newer.roof_job_id = latest.roof_job_id
             AND newer.received_at > latest.received_at
        )
       LEFT JOIN app_users recorder
         ON recorder.tenant_id = latest.tenant_id
        AND recorder.user_id = latest.recorded_by_user_id
      WHERE job.tenant_id = ? AND job.roof_job_id = ?`,
  ).bind(tenantId, roofJobId).first<WindowFacts>();
}

function receiptOf(facts: WindowFacts): SignedCopyReceipt | null {
  if (!facts.receipt_id) return null;
  return {
    id: facts.receipt_id,
    received_at: facts.received_at!,
    window_ends_at: facts.window_ends_at!,
    time_zone: facts.receipt_time_zone!,
    contract_signed_at: facts.receipt_contract_signed_at,
    acceptance_binding_id: facts.receipt_binding_id,
    no_d1_contract: facts.receipt_binding_id === null,
    reason: facts.reason!,
    evidence_ref: facts.evidence_ref!,
    recorded_at: facts.recorded_at!,
    recorded_by: { display_name: facts.recorded_by_name, role: facts.recorded_by_role! },
  };
}

function stateOf(facts: WindowFacts | null, timeZone: string, asOf: string): CancellationWindowState {
  if (!facts) {
    return {
      kind: "system_state",
      state: "unknown",
      waivable: false,
      unknown_reason: "signed_copy_time_missing",
      ends_at: null,
      contract: null,
      signed_copy_received: null,
      holds: CANCELLATION_WINDOW_HOLDS,
      time_zone: timeZone,
      as_of: asOf,
    };
  }
  const receipt = receiptOf(facts);
  const state = Number(facts.unknown) === 1 ? "unknown" : Number(facts.open) === 1 ? "open" : "ended";
  return {
    kind: "system_state",
    state,
    waivable: false,
    unknown_reason: state !== "unknown"
      ? null
      : receipt ? "signed_copy_before_contract" : "signed_copy_time_missing",
    ends_at: state === "unknown" ? null : receipt!.window_ends_at,
    contract: facts.binding_id
      ? { acceptance_binding_id: facts.binding_id, signed_at: facts.contract_signed_at! }
      : null,
    signed_copy_received: receipt,
    holds: state === "ended" ? [] : CANCELLATION_WINDOW_HOLDS,
    time_zone: timeZone,
    as_of: facts.now,
  };
}

/** The job's cancellation window as a System state, with the business time zone to read it in. */
export async function readCancellationWindow(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<CancellationWindowState> {
  const [facts, zone] = await Promise.all([
    windowFacts(env, tenantId, roofJobId),
    businessTimeZone(env, tenantId),
  ]);
  return stateOf(facts, zone.timeZone, facts?.now ?? new Date().toISOString());
}

/**
 * What the job's window holds now, read with D1's clock exactly as 0160's holds read it, or null
 * once it has ended. A job the tenant does not have is unknown: nothing has been recorded for it.
 */
export async function cancellationWindowHold(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<CancellationWindowHold | null> {
  const facts = await windowFacts(env, tenantId, roofJobId);
  const window = stateOf(facts, FALLBACK_BUSINESS_TIME_ZONE, facts?.now ?? "");
  if (window.state === "ended") return null;
  return window.state === "open"
    ? { state: "open", detail: { window_ends_at: window.ends_at! } }
    : { state: "unknown", detail: { unknown_reason: window.unknown_reason! } };
}

// ------------------------------------------------------------------------ the business clock

function readableTimeZone(value: string): boolean {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The tenant's business time zone: the company profile's, which before an owner confirms one is
 * the deployment's `APP_TIME_ZONE`; America/Edmonton when Intl cannot read either.
 */
export async function businessTimeZone(
  env: AppEnv,
  tenantId: string,
): Promise<{ timeZone: string; source: "company_profile" | "deployment_default" | "fallback" }> {
  let candidate = (env.APP_TIME_ZONE ?? "").trim();
  let source: "company_profile" | "deployment_default" = "deployment_default";
  try {
    const profile = await getCompanyProfile(env, tenantId);
    candidate = profile.time_zone.trim();
    source = profile.is_default ? "deployment_default" : "company_profile";
  } catch {
    // An unreadable profile falls back to the deployment's zone, then to the fallback.
  }
  return readableTimeZone(candidate)
    ? { timeZone: candidate, source }
    : { timeZone: FALLBACK_BUSINESS_TIME_ZONE, source: "fallback" };
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** The local clock reading of an instant in `timeZone`, as if that reading were UTC. */
function wallClock(instant: number, timeZone: string): number {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
  return Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
    ((instant % 1000) + 1000) % 1000,
  );
}

/**
 * The instant whose local clock in `timeZone` reads `wall`. A reading the clock shows twice (the
 * hour a DST change repeats) gives the later instant; one it skips gives the instant just after
 * the gap. Either way never earlier.
 */
function instantOfWallClock(wall: number, timeZone: string): number {
  const candidates = [wall - DAY_MS, wall + DAY_MS].map(
    (probe) => wall - (wallClock(probe, timeZone) - probe),
  );
  const exact = candidates.filter((candidate) => wallClock(candidate, timeZone) === wall);
  return Math.max(...(exact.length > 0 ? exact : candidates));
}

/**
 * When the window ends: the later of `receivedAt` + 240 hours and the same local clock time 10
 * calendar days later in `timeZone`, and never earlier than the job's previous end. D1 holds the
 * result to [received + 240 hours, received + 241 hours].
 */
export function cancellationWindowEndsAt(
  receivedAt: string,
  timeZone: string,
  previousEndsAt: string | null = null,
): string {
  const received = Date.parse(receivedAt);
  const elapsed = received + CANCELLATION_WINDOW_DAYS * DAY_MS;
  const local = instantOfWallClock(
    wallClock(received, timeZone) + CANCELLATION_WINDOW_DAYS * DAY_MS,
    timeZone,
  );
  const previous = previousEndsAt ? Date.parse(previousEndsAt) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(elapsed, local, previous)).toISOString();
}

// ------------------------------------------------------------------------------- the record step

interface ReceiptRequest {
  receivedAt: string;
  reason: string;
  evidenceRef: string;
}

/**
 * A full timestamp with its offset, as an instant in the form D1 stores; null for anything else,
 * a calendar day that does not exist included.
 */
export function receivedAtInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = RECEIVED_AT_RE.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zulu, sign, offsetHour, offsetMinute] =
    match;
  const fields = [year, month, day, hour, minute, second ?? "0"].map(Number);
  const [y, mo, d, h, mi, s] = fields as [number, number, number, number, number, number];
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  // Date.UTC reads a year below 100 as 19xx; no copy was received before 1970.
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  const offset = zulu ? 0 : (Number(offsetHour) * 60 + Number(offsetMinute)) * (sign === "-" ? -1 : 1);
  if (!zulu && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return null;
  const ms = Number((fraction ?? "0").padEnd(3, "0"));
  const instant = Date.UTC(y, mo - 1, d, h, mi, s, ms) - offset * 60_000;
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

function singleLine(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/** The body, with each missing piece refused by its own code. */
function parseReceipt(body: unknown): ReceiptRequest {
  const invalid = refused("invalid_cancellation_window_receipt", 400);
  if (!isRecord(body)) throw invalid;
  if (Object.keys(body).some((key) => !["received_at", "reason", "evidence_ref"].includes(key))) {
    throw invalid;
  }
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const reason = text(body.reason);
  const evidenceRef = text(body.evidence_ref);
  const reasonMissing = reason.length < MIN_REASON_LENGTH;
  const evidenceMissing = evidenceRef.length === 0;
  if (reasonMissing && evidenceMissing) {
    throw refused("cancellation_window_receipt_reason_and_evidence_required", 400);
  }
  if (reasonMissing) throw refused("cancellation_window_receipt_reason_required", 400);
  if (evidenceMissing) throw refused("cancellation_window_receipt_evidence_required", 400);
  if (reason.length > MAX_REASON_LENGTH || /[\u0000\r]/.test(reason)) throw invalid;
  if (evidenceRef.length > MAX_EVIDENCE_LENGTH || !singleLine(evidenceRef)) throw invalid;
  const receivedAt = receivedAtInstant(body.received_at);
  if (!receivedAt) throw refused("cancellation_window_receipt_time_invalid", 400);
  return { receivedAt, reason, evidenceRef };
}

async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    throw refused("payload_too_large", 413);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw refused("payload_too_large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw refused("invalid_json", 400);
  }
}

interface ReceiptRow {
  receipt_id: string;
  request_sha256: string;
}

async function receiptByKey(env: AppEnv, tenantId: string, keyHash: string) {
  return await env.DB.prepare(
    `SELECT receipt_id, request_sha256 FROM production_cancellation_window_receipts
      WHERE tenant_id = ? AND idempotency_key_hash = ?`,
  ).bind(tenantId, keyHash).first<ReceiptRow>();
}

function refusalResponse(error: unknown): Response {
  if (error instanceof CancellationWindowError) {
    return json({ ...error.detail, error: error.code }, error.status);
  }
  return json({ error: "cancellation_window_receipt_failed" }, 502);
}

/**
 * `POST /api/v1/production/jobs/{job}/cancellation-window/signed-copy`: an owner or ops person
 * records when the customer received their copy of the signed contract.
 */
export async function handleCancellationWindowSignedCopy(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
): Promise<Response> {
  try {
    if (!validAppCsrf(req, auth)) throw refused("csrf_failed", 403);
    const person = await personCookieSession(env, auth);
    if (!person) throw refused("person_session_required", 403);
    if (!(RECORDER_ROLES as readonly string[]).includes(person.role)) {
      throw refused("cancellation_window_receipt_owner_or_ops_required", 403);
    }
    const key = req.headers.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY_RE.test(key)) throw refused("idempotency_key_required", 400);
    const input = parseReceipt(await readBody(req));
    const tenantId = auth.session.tenant_id;

    const keyHash = await sha256Hex(key);
    const receiptId = `pcw_${(await sha256Hex(`${tenantId}:${keyHash}`)).slice(0, 40)}`;
    const requestSha256 = await sha256Hex(canonicalJson({
      route: "cancellation_window_signed_copy",
      tenant_id: tenantId,
      roof_job_id: roofJobId,
      actor_user_id: person.userId,
      received_at: input.receivedAt,
      reason: input.reason,
      evidence_ref: input.evidenceRef,
    }));
    const zone = await businessTimeZone(env, tenantId);
    const answer = async (status: number, extra: Record<string, unknown>) => {
      const window = await readCancellationWindow(env, tenantId, roofJobId);
      return json({ cancellation_window: window, ...extra }, status);
    };
    const replay = async (row: ReceiptRow) => {
      if (row.request_sha256 !== requestSha256) {
        throw refused("cancellation_window_receipt_replay_conflict", 409);
      }
      return await answer(200, { recorded: true, receipt_id: row.receipt_id, replayed: true });
    };
    const existing = await receiptByKey(env, tenantId, keyHash);
    if (existing) return await replay(existing);

    const facts = await windowFacts(env, tenantId, roofJobId);
    if (!facts) throw refused("cancellation_window_receipt_job_unknown", 404);
    const received = Date.parse(input.receivedAt);
    const times = (extra: Record<string, string>) => ({
      received_at: input.receivedAt,
      ...extra,
      time_zone: zone.timeZone,
    });
    if (received > Date.parse(facts.now)) {
      throw refused("cancellation_window_receipt_in_future", 409, times({ now: facts.now }));
    }
    if (facts.contract_signed_at && received < Date.parse(facts.contract_signed_at)) {
      throw refused(
        "cancellation_window_receipt_before_contract",
        409,
        times({ contract_signed_at: facts.contract_signed_at }),
      );
    }
    if (facts.received_at) {
      const recorded = Date.parse(facts.received_at);
      if (received < recorded) {
        throw refused(
          "cancellation_window_receipt_earlier_than_recorded",
          409,
          times({ recorded_received_at: facts.received_at, window_ends_at: facts.window_ends_at! }),
        );
      }
      if (received === recorded) {
        return await answer(200, { recorded: false, unchanged: true, replayed: false });
      }
    }

    const windowEndsAt = cancellationWindowEndsAt(input.receivedAt, zone.timeZone, facts.window_ends_at);
    try {
      // D1 re-checks every rule, stamps `recorded_at` with its own clock and writes the audit row.
      await env.DB.prepare(
        `INSERT INTO production_cancellation_window_receipts (
           receipt_id, tenant_id, roof_job_id, received_at, window_ends_at, time_zone,
           acceptance_binding_id, contract_signed_at, reason, evidence_ref,
           recorded_by_user_id, recorded_by_role, recorded_at, request_sha256, idempotency_key_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${D1_NOW}, ?, ?)`,
      ).bind(
        receiptId,
        tenantId,
        roofJobId,
        input.receivedAt,
        windowEndsAt,
        zone.timeZone,
        facts.binding_id,
        facts.contract_signed_at,
        input.reason,
        input.evidenceRef,
        person.userId,
        person.role,
        requestSha256,
        keyHash,
      ).run();
    } catch (error) {
      const raced = await receiptByKey(env, tenantId, keyHash);
      if (raced) return await replay(raced);
      const message = error instanceof Error ? error.message : String(error);
      const code = message.match(/cancellation_window_receipt_[a-z_]+/)?.[0];
      throw code && RECEIPT_REFUSALS[code]
        ? refused(code, RECEIPT_REFUSALS[code]!)
        : refused("cancellation_window_receipt_failed", 502);
    }
    return await answer(201, { recorded: true, receipt_id: receiptId, replayed: false });
  } catch (error) {
    return refusalResponse(error);
  }
}

// ------------------------------------------------------------------------------- the work queue

interface MissingRow {
  roof_job_id: string;
  job_number: string | null;
  customer_display_name: string;
  address_line1: string | null;
  contract_signed_at: string | null;
  has_record: number;
  from_old_system: number;
}

/**
 * `GET /api/v1/production/cancellation-window/signed-copy-missing`: owner and ops. The tenant's
 * open jobs whose window is unknown, oldest first, and how many there are. Each row says why: no
 * record at all, or only one from before a later contract; and whether D1 holds a contract for the
 * job and whether it came from the old system.
 */
export async function handleCancellationWindowSignedCopyMissing(
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  if (!(RECORDER_ROLES as readonly string[]).includes(auth.session.role)) {
    return json({ error: "owner_or_ops_required" }, 403);
  }
  try {
    const tenantId = auth.session.tenant_id;
    const open = `job.tenant_id = ? AND job.job_status IN ('qualified', 'in_progress')
        AND ${UNKNOWN_SQL}`;
    const [count, rows] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM operating_roof_jobs job WHERE ${open}`)
        .bind(tenantId).first<{ n: number }>(),
      env.DB.prepare(
        `SELECT job.roof_job_id, job.job_number, customer.display_name AS customer_display_name,
                property.address_line1, contract.accepted_at AS contract_signed_at,
                EXISTS (
                  SELECT 1 FROM production_cancellation_window_receipts receipt
                   WHERE receipt.tenant_id = job.tenant_id AND receipt.roof_job_id = job.roof_job_id
                ) AS has_record,
                job.jobnimbus_job_id IS NOT NULL AS from_old_system
           FROM operating_roof_jobs job
           JOIN operating_customers customer
             ON customer.tenant_id = job.tenant_id AND customer.customer_id = job.customer_id
           LEFT JOIN operating_properties property
             ON property.tenant_id = job.tenant_id AND property.property_id = job.property_id
           LEFT JOIN commercial_acceptance_bindings contract
             ON contract.tenant_id = job.tenant_id
            AND contract.roof_job_id = job.roof_job_id
            AND ${LATEST_CONTRACT_SQL}
          WHERE ${open}
          ORDER BY job.created_at ASC, job.roof_job_id ASC
          LIMIT ?`,
      ).bind(tenantId, MISSING_LIST_LIMIT + 1).all<MissingRow>(),
    ]);
    const jobs = rows.results ?? [];
    return json({
      count: Number(count?.n ?? 0),
      complete: jobs.length <= MISSING_LIST_LIMIT,
      jobs: jobs.slice(0, MISSING_LIST_LIMIT).map((row) => ({
        roof_job_id: row.roof_job_id,
        job_number: row.job_number,
        customer_display_name: row.customer_display_name,
        address_line1: row.address_line1,
        unknown_reason: Number(row.has_record) === 1
          ? "signed_copy_before_contract"
          : "signed_copy_time_missing",
        contract_signed_at: row.contract_signed_at,
        from_old_system: Number(row.from_old_system) === 1,
      })),
    });
  } catch {
    return json({ error: "cancellation_window_unavailable" }, 502);
  }
}
