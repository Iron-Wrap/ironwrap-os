// production-gate-clearance.ts - a production gate moves only by an entry in its ledger.
//
// The six scheduling gates (Deposit, Materials, Safety, Access, Weather, Crew) lock a roof job's
// production schedule (migration 0098). Since migration 0153, `production_gate_clearances` is the
// only way to move one: each request here appends exactly one ledger entry, and D1 re-checks who
// may append what, then applies the entry to the gate, versions it and writes its `audit_log` row
// in the same statement. Nothing updates a gate row in place.
//
//   POST /api/v1/production/jobs/{job}/gates/{gate}/clearance
//     The runway's body, `{basis, reason}`, and its strict response, unchanged.
//     * `deposit_settlement` (Deposit only, no prose): the money lane's reconciled deposit invoice
//       for this job, stored as an immutable R2 receipt before the `clear` entry that names it.
//       Until the money lane has settled it the answer is `deposit_settlement_not_observed`.
//     * `office_waiver` (Deposit, Materials, Access): a waiver is the owner's decision. From a
//       person who may not decide it (production, or an owner while another owner is active) it
//       is a `waiver_request`, answered 409 `production_gate_waiver_requested`; another holder
//       decides it on the route below. A person holds at most one open request per gate, since
//       each request moves the gate's version: a further one is answered 409
//       `production_gate_waiver_request_open` with the open request's id. From the only active
//       holder of the deciding set it is a self-approved `waiver_decision` (owner ruling D-08)
//       and the gate is waived. Safety and Weather are never waivable and Crew has no waiver:
//       409 `production_gate_not_waivable`.
//     * `person_attestation` (Materials, Safety, Access, Weather; migration 0158): the body is
//       exactly `{basis, expected_gate_version, attestation, evidence_refs?}`, with the gate's
//       typed attestation (production-gate-attestation.ts) and 0 to 10 evidence references that
//       this route resolves and checksums. The attester is on no crew; Materials needs no open
//       inventory exception, and Safety needs no active stop and the attester's current internal
//       Worker Competency. The answer is the stored entry and the gate after it.
//   POST /api/v1/production/jobs/{job}/gates/{gate}/waiver-decisions
//     `{request_id, expected_gate_version, decision: "approve" | "decline", reason}`: a holder of
//     the deciding set answers a waiver request on a job of their own runway. The requester never
//     decides their own request while another holder is active.
//   POST /api/v1/production/jobs/{job}/gates/{gate}/reversals
//     `{expected_gate_version, reverses_id, reason}`: an owner or production person appends a
//     `reverse` of the entry that holds the gate's current state, and the gate is `blocked` again.
//     Nothing is deleted. A `contract_no_deposit` entry is reversed only by a superseding contract.
//   GET /api/v1/production/jobs/{job}/gates
//     The office's read: each scheduling gate with its state, version, ledger entries and open
//     waiver requests, whose `request_id` is what a waiver decision answers.
//
// Every write is people-only: the CSRF token, then the person's own cookie session, then the
// operation set of their live role. Agents, connectors, service tokens and the effect runtime
// never hold a cookie session. The Idempotency-Key is stored only as a hash, next to the hash of
// the request: an exact replay answers as the first request did, and the same key with different
// input is `production_gate_clearance_replay_conflict`.

import { personCookieSession, validAppCsrf, type PersonSession } from "./app-auth.ts";
import { listAccountingIntents, type AccountingIntentRecord } from "./accounting-intents.ts";
import { buildProductionRunwayReadModel } from "./app-read-models.ts";
import { listJobEvidenceItemsFromD1, r2ObjectStore } from "./field-actions.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  fieldEvidenceId,
  isAttestableProductionGate,
  parseProductionGateAttestation,
  stockReservationId,
  weatherRefusal,
  type AttestableProductionGate,
  type WeatherAttestation,
} from "./production-gate-attestation.ts";
import { ROLE_PERMISSIONS, type AppEnv, type AppRole, type AuthContext } from "./app-types.ts";

/** The scheduling locks. `Completion` is a closeout gate and is not clearable here. */
export const CLEARABLE_PRODUCTION_GATES = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;

export type ClearableProductionGate = (typeof CLEARABLE_PRODUCTION_GATES)[number];

/** Owner ruling: Safety and Weather are never waivable, and Crew has no waiver. */
export const WAIVABLE_PRODUCTION_GATES: readonly ClearableProductionGate[] = [
  "Deposit",
  "Materials",
  "Access",
];

export const PRODUCTION_GATE_CLEARANCE_BASES = [
  "office_waiver",
  "deposit_settlement",
] as const;

export type ProductionGateClearanceBasis =
  (typeof PRODUCTION_GATE_CLEARANCE_BASES)[number];

/**
 * The money-lane states that mean "the provider told us money landed against this
 * invoice". This state is only ever reached through an authenticated read-back in
 * `accounting-reconciliation.ts`; it cannot be set by a local command.
 */
const SETTLED_DEPOSIT_STATES = ["reconciled"] as const;

/**
 * `production.gates.clear`: clear Deposit on settlement, attest Materials, Access and Weather,
 * request a waiver and reverse an entry.
 */
const CLEAR_PERMISSION = "production:clear_gate";
/**
 * `production.gates.safety` ("checks site safety", MD-01): attest Safety. It is its own operation
 * set, carried today by exactly the roles that carry `production.gates.clear` (owner and
 * production). This line is the whole mapping on the Worker side; migration 0158 holds it in D1.
 */
export const PRODUCTION_GATE_SAFETY_PERMISSION = CLEAR_PERMISSION;
/**
 * The role that carries the set deciding a waiver: `money.approve` for Deposit and
 * `production.gates.waive` for Materials and Access. Migration 0153 holds the same mapping.
 */
const WAIVER_DECIDER_ROLE: AppRole = "owner";
/** The QA seed owner may not append a person entry, so it never counts as a holder either. */
const QA_SEED_OWNER_CREATED_BY = "system:owner_directed_qa_seed_grant";
const RECEIPT_CONTENT_TYPE = "application/json";
const RECEIPT_PREFIX = "production-gate-clearance/v1";
const MAX_BODY_BYTES = 16 * 1024;
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 1_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,160}$/;
const CLEARANCE_ID_RE = /^pgc_[0-9a-f]{40}$/;
const AMOUNT_RE = /^-?\d+(\.\d+)?$/;
/** The read keeps the newest entries and open waiver requests of a gate up to this many each. */
const MAX_GATE_READ_ROWS = 100;
/** Reservation states that still put stock in the job's hands: neither released nor reversed. */
const LIVE_RESERVATION_STATES = ["reserved", "partially_issued", "issued"] as const;

export interface ProductionGateClearanceRequest {
  roofJobId: string;
  gate: ClearableProductionGate;
  basis: ProductionGateClearanceBasis;
  reason: string | null;
  idempotencyKey: string;
}

export interface ProductionGateWaiverDecisionRequest {
  requestId: string;
  expectedGateVersion: number;
  decision: "approve" | "decline";
  reason: string;
}

export class ProductionGateClearanceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = "ProductionGateClearanceError";
  }
}

/** The refusals D1 raises from migrations 0153 and 0158, as these routes answer them. */
const LEDGER_REFUSALS: Readonly<Record<string, number>> = {
  production_gate_version_conflict: 409,
  production_gate_already_cleared: 409,
  production_gate_not_cleared: 409,
  production_gate_not_waivable: 409,
  production_gate_safety_person_only: 409,
  deposit_settlement_not_observed: 409,
  production_gate_waiver_request_invalid: 409,
  production_gate_waiver_request_open: 409,
  production_gate_waiver_already_decided: 409,
  production_gate_waiver_self_approval_refused: 409,
  production_gate_clearance_gate_invalid: 409,
  production_gate_clearance_append_only: 409,
  production_gate_clearance_basis_invalid: 409,
  production_gate_clearance_reason_required: 400,
  production_gate_clearance_actor_invalid: 403,
  production_gate_clearance_seed_identity_refused: 403,
  production_gate_attester_on_crew: 403,
  production_gate_attestation_invalid: 400,
  production_gate_evidence_invalid: 409,
  production_gate_material_exception_open: 409,
  production_gate_safety_stop_active: 409,
  production_gate_competency_required: 403,
  production_gate_forecast_stale: 409,
  production_gate_weather_window_invalid: 409,
  production_gate_reversal_target_invalid: 409,
  production_gate_not_reversible: 409,
};

interface GateRow {
  gate_id: string;
  roof_job_id: string;
  gate: ClearableProductionGate;
  state: string;
  version: number;
}

interface LedgerRow {
  clearance_id: string;
  gate_id: string;
  entry_kind: string;
  basis: string;
  to_state: string;
  from_gate_version: number;
  request_id: string | null;
  reverses_id: string | null;
  requested_by: string | null;
  actor_user_id: string | null;
  actor_role: string | null;
  self_approval: number;
  self_approval_basis: string | null;
  attestation_json: string | null;
  evidence_refs_json: string | null;
  reason: string | null;
  reason_redacted_at: string | null;
  request_sha256: string | null;
  created_at: string;
}

interface NewEntry {
  entry_kind: "clear" | "waiver_request" | "waiver_decision" | "reverse";
  basis: ProductionGateClearanceBasis | "person_attestation" | "person_reversal";
  to_state: "complete" | "ready" | "waived" | "blocked";
  request_id: string | null;
  reverses_id?: string;
  requested_by: string | null;
  self_approval: 0 | 1;
  attestation_json?: string;
  evidence_refs_json: string | null;
  reason: string | null;
}

interface Idempotency {
  key: string;
  keyHash: string;
  clearanceId: string;
}

/** A resolved, checksummed evidence reference, as the ledger and D1 hold it. */
interface EvidenceRef {
  ref: string;
  sha256: string;
  version?: number;
}

/** The attester's current internal Worker Competency, bound into a Safety attestation. */
interface CompetencyBinding {
  readback_id: string;
  authority_record_id: string;
  authority_version: number;
  state_digest_sha256: string;
}

const LEDGER_COLUMNS = `clearance_id, gate_id, entry_kind, basis, to_state, from_gate_version,
       request_id, reverses_id, requested_by, actor_user_id, actor_role, self_approval,
       self_approval_basis, attestation_json, evidence_refs_json, reason, reason_redacted_at,
       request_sha256, created_at`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function refusal(code: string, status: number): ProductionGateClearanceError {
  return new ProductionGateClearanceError(code, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isClearableProductionGate(
  value: string,
): value is ClearableProductionGate {
  return (CLEARABLE_PRODUCTION_GATES as readonly string[]).includes(value);
}

export function isWaivableProductionGate(value: string): boolean {
  return (WAIVABLE_PRODUCTION_GATES as readonly string[]).includes(value);
}

/** Whether a live role carries a permission. A role outside the app's set carries none. */
function roleHolds(role: AppRole, permission: string): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

function waiverReason(value: unknown): string | null {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) return null;
  if (/[\u0000\r]/.test(reason)) return null;
  return reason;
}

export function parseProductionGateClearance(
  gate: string,
  roofJobId: string,
  idempotencyKey: string,
  body: unknown,
): ProductionGateClearanceRequest | null {
  if (!isClearableProductionGate(gate)) return null;
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) return null;
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "basis" && key !== "reason")) return null;
  const basis = body.basis;
  if (typeof basis !== "string") return null;
  if (!(PRODUCTION_GATE_CLEARANCE_BASES as readonly string[]).includes(basis)) return null;
  const typedBasis = basis as ProductionGateClearanceBasis;
  // A settlement clearance takes its whole statement from the money lane. Letting the caller
  // attach prose to it would invite a reason that contradicts the record the receipt is made of,
  // and only Deposit has a deposit invoice to speak for it.
  if (typedBasis === "deposit_settlement") {
    if (body.reason !== undefined) return null;
    if (gate !== "Deposit") return null;
    return { roofJobId, gate, basis: typedBasis, reason: null, idempotencyKey };
  }
  const reason = waiverReason(body.reason);
  if (!reason) return null;
  return { roofJobId, gate, basis: typedBasis, reason, idempotencyKey };
}

export function parseProductionGateWaiverDecision(
  body: unknown,
): ProductionGateWaiverDecisionRequest | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "decision,expected_gate_version,reason,request_id") return null;
  const { request_id: requestId, expected_gate_version: version, decision } = body;
  if (typeof requestId !== "string" || !CLEARANCE_ID_RE.test(requestId)) return null;
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > 1_000_000) {
    return null;
  }
  if (decision !== "approve" && decision !== "decline") return null;
  const reason = waiverReason(body.reason);
  if (!reason) return null;
  return { requestId, expectedGateVersion: version as number, decision, reason };
}

/**
 * The settled deposit invoice this clearance is allowed to be made of, or null.
 *
 * Ordered so the answer is deterministic when a job carries more than one deposit
 * intent: the most recently reconciled wins. A partial provider payment is evidence
 * for accounting review, not production admission. A settled amount that is absent
 * or not positive is not a settlement, whatever the state column says.
 */
export function settledDepositIntent(
  intents: readonly AccountingIntentRecord[],
): AccountingIntentRecord | null {
  const settled = intents.filter(
    (intent) =>
      intent.kind === "deposit_invoice" &&
      (SETTLED_DEPOSIT_STATES as readonly string[]).includes(intent.state) &&
      typeof intent.settled_amount === "string" &&
      AMOUNT_RE.test(intent.settled_amount) &&
      Number(intent.settled_amount) > 0,
  );
  if (settled.length === 0) return null;
  return [...settled].sort((left, right) =>
    (right.provider_reconciled_at ?? "").localeCompare(left.provider_reconciled_at ?? "") ||
    left.intent_id.localeCompare(right.intent_id)
  )[0] ?? null;
}

/**
 * The receipt is the artifact the gate's evidence is made of, so it records what
 * was read and nothing that was inferred. It is canonical JSON, hashed, and stored
 * immutably before the ledger entry that names it, so the evidence can never point
 * at an object that does not exist or has changed.
 *
 * Deliberately free of any wall-clock stamp. The same decision over the same money
 * record must produce the same bytes: R2 stores the receipt immutably, so a stamp
 * of "when this ran" would make every retry of a clearance collide with its own
 * first attempt and answer `production_gate_receipt_unavailable` forever - found
 * exactly that way on a real stack. The observation time that belongs on the
 * receipt is the money lane's own (`settlement_observed_at`), which is a fact
 * about the settlement rather than about this request. `decision_id` is the ledger
 * entry's id, so the receipt and its entry name each other.
 */
export function depositSettlementReceipt(input: {
  tenantId: string;
  roofJobId: string;
  decisionId: string;
  clearedByUserId: string;
  intent: AccountingIntentRecord;
}): string {
  return canonicalJson({
    version: 1,
    kind: "production_gate_clearance",
    gate: "Deposit",
    basis: "deposit_settlement",
    tenant_id: input.tenantId,
    roof_job_id: input.roofJobId,
    decision_id: input.decisionId,
    cleared_by_user_id: input.clearedByUserId,
    settlement_observed_at: settlementObservedAt(input.intent),
    money_intent: {
      intent_id: input.intent.intent_id,
      kind: input.intent.kind,
      state: input.intent.state,
      provider: input.intent.provider,
      realm_id: input.intent.realm_id,
      provider_entity_type: input.intent.provider_entity_type,
      provider_entity_id: input.intent.provider_entity_id,
      currency: input.intent.currency,
      total_amount: input.intent.total_amount,
      settled_amount: input.intent.settled_amount,
      observed_sha256: input.intent.observed_sha256,
      provider_reconciled_at: input.intent.provider_reconciled_at,
    },
  });
}

/**
 * When the money lane observed this settlement. `provider_reconciled_at` is the
 * exact fact; `updated_at` is the row's own last movement and is the fallback for a
 * `partially_settled` intent that has not been fully reconciled yet. Both are
 * stable across retries, which is the property the receipt needs.
 */
export function settlementObservedAt(intent: AccountingIntentRecord): string | null {
  for (const candidate of [intent.provider_reconciled_at, intent.updated_at]) {
    if (typeof candidate !== "string") continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/** CSRF first, then the person's own cookie session. */
async function personFor(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<PersonSession> {
  if (!validAppCsrf(req, auth)) throw refusal("csrf_failed", 403);
  const person = await personCookieSession(env, auth);
  if (!person) throw refusal("person_session_required", 403);
  return person;
}

async function idempotencyFor(req: Request, tenantId: string): Promise<Idempotency> {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY_RE.test(key)) throw refusal("idempotency_key_required", 400);
  const keyHash = await sha256Hex(key);
  const clearanceId = `pgc_${(await sha256Hex(`${tenantId}:${keyHash}`)).slice(0, 40)}`;
  return { key, keyHash, clearanceId };
}

async function readJsonBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    throw refusal("payload_too_large", 413);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw refusal("payload_too_large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw refusal("invalid_json", 400);
  }
}

async function readGate(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  gate: ClearableProductionGate,
): Promise<GateRow | null> {
  return await env.DB.prepare(
    `SELECT gate_id, roof_job_id, gate, state, version
       FROM operating_production_gates
      WHERE tenant_id = ? AND roof_job_id = ? AND gate = ?
      LIMIT 1`,
  ).bind(tenantId, roofJobId, gate).first<GateRow>();
}

async function entryById(env: AppEnv, tenantId: string, clearanceId: string) {
  return await env.DB.prepare(
    `SELECT ${LEDGER_COLUMNS} FROM production_gate_clearances
      WHERE tenant_id = ? AND clearance_id = ?`,
  ).bind(tenantId, clearanceId).first<LedgerRow>();
}

async function entryByKey(env: AppEnv, tenantId: string, keyHash: string) {
  return await env.DB.prepare(
    `SELECT ${LEDGER_COLUMNS} FROM production_gate_clearances
      WHERE tenant_id = ? AND idempotency_key_hash = ?`,
  ).bind(tenantId, keyHash).first<LedgerRow>();
}

/** Active holders of the deciding set other than this person, as D1 counts them. */
async function otherWaiverDeciders(
  env: AppEnv,
  tenantId: string,
  userId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS holders
       FROM app_users
      WHERE tenant_id = ? AND user_id != ? AND active = 1 AND access_role = ?
        AND created_by != ?`,
  ).bind(tenantId, userId, WAIVER_DECIDER_ROLE, QA_SEED_OWNER_CREATED_BY)
    .first<{ holders: number }>();
  return Number(row?.holders ?? 0);
}

/**
 * The caller's own runway read, in the caller's own tenant. A job reference is never taken on
 * trust (ELEC-112 finding 3), and the runway is exactly the set the scheduling fence consults, so
 * a job this read cannot see has no gate this session may clear, decide or reverse.
 */
async function assertOnRunway(env: AppEnv, auth: AuthContext, roofJobId: string): Promise<void> {
  let onRunway: boolean;
  try {
    const runway = await buildProductionRunwayReadModel(env, auth);
    onRunway = runway.jobs.some((candidate) => candidate.id === roofJobId);
  } catch {
    throw refusal("production_runway_unavailable", 502);
  }
  if (!onRunway) throw refusal("production_gate_job_not_on_runway", 409);
}

/** This person's undecided waiver request on this gate, as D1 counts it. */
async function openWaiverRequest(
  env: AppEnv,
  tenantId: string,
  gateId: string,
  userId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT request.clearance_id
       FROM production_gate_clearances request
      WHERE request.tenant_id = ? AND request.gate_id = ? AND request.entry_kind = 'waiver_request'
        AND request.actor_user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM production_gate_clearances decision
           WHERE decision.tenant_id = request.tenant_id AND decision.request_id = request.clearance_id
        )
      ORDER BY request.from_gate_version DESC
      LIMIT 1`,
  ).bind(tenantId, gateId, userId).first<{ clearance_id: string }>();
  return row?.clearance_id ?? null;
}

function openRequestResponse(requestId: string): Response {
  return json({ error: "production_gate_waiver_request_open", request_id: requestId }, 409);
}

function replayOf(existing: LedgerRow, requestSha256: string): LedgerRow {
  if (existing.request_sha256 !== requestSha256) {
    throw refusal("production_gate_clearance_replay_conflict", 409);
  }
  return existing;
}

function ledgerRefusal(error: unknown): ProductionGateClearanceError {
  const message = error instanceof Error ? error.message : String(error);
  const code = Object.keys(LEDGER_REFUSALS).find((candidate) => message.includes(candidate));
  return code
    ? refusal(code, LEDGER_REFUSALS[code]!)
    : refusal("production_gate_clearance_failed", 502);
}

/**
 * Append one entry: a single INSERT, which D1 validates and applies to the gate together with
 * its audit row. A concurrent request under the same key that won the race is this request's
 * replay, or its conflict.
 */
async function appendEntry(
  env: AppEnv,
  input: {
    tenantId: string;
    gate: GateRow;
    person: PersonSession;
    idempotency: Idempotency;
    requestSha256: string;
    entry: NewEntry;
  },
): Promise<{ row: LedgerRow; replayed: boolean }> {
  const { tenantId, gate, person, idempotency, requestSha256, entry } = input;
  try {
    await env.DB.prepare(
      `INSERT INTO production_gate_clearances (
         clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
         from_gate_version, request_id, reverses_id, actor_kind, actor_user_id, actor_role,
         requested_by, self_approval, self_approval_basis, attestation_json, evidence_refs_json,
         reason, request_sha256, idempotency_key_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'person', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      idempotency.clearanceId,
      tenantId,
      gate.gate_id,
      gate.roof_job_id,
      gate.gate,
      entry.entry_kind,
      entry.basis,
      entry.to_state,
      gate.version,
      entry.request_id,
      entry.reverses_id ?? null,
      person.userId,
      person.role,
      entry.requested_by,
      entry.self_approval,
      entry.self_approval === 1 ? "only_holder" : null,
      entry.attestation_json ?? null,
      entry.evidence_refs_json,
      entry.reason,
      requestSha256,
      idempotency.keyHash,
      new Date().toISOString(),
    ).run();
  } catch (error) {
    const raced = await entryByKey(env, tenantId, idempotency.keyHash);
    if (raced) return { row: replayOf(raced, requestSha256), replayed: true };
    throw ledgerRefusal(error);
  }
  const stored = await entryById(env, tenantId, idempotency.clearanceId);
  if (!stored) throw refusal("production_gate_clearance_failed", 502);
  return { row: stored, replayed: false };
}

function refusalResponse(error: unknown): Response {
  if (error instanceof ProductionGateClearanceError) {
    return json({ error: error.code }, error.status);
  }
  return json({ error: "production_gate_clearance_failed" }, 502);
}

/** The runway's response, which the PWA parses strictly: no key may be added to it. */
function clearanceResponse(gate: GateRow, entry: LedgerRow, replayed: boolean): Response {
  if (entry.entry_kind === "waiver_request") {
    return json({ error: "production_gate_waiver_requested" }, 409);
  }
  const settled = entry.basis === "deposit_settlement";
  return json({
    gate: {
      name: gate.gate_id,
      gate: gate.gate,
      roof_job: gate.roof_job_id,
      state: entry.to_state === "waived" ? "Waived" : "Ready",
    },
    basis: entry.basis,
    clearance: settled ? "verified" : "waived",
    evidence_item: settled ? `gate-clearance:${entry.clearance_id}` : null,
    actor_role: entry.actor_role,
    replayed,
  });
}

export async function handleProductionGateClearance(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
  gate: string,
): Promise<Response> {
  try {
    const person = await personFor(req, env, auth);
    if (
      !roleHolds(person.role, CLEAR_PERMISSION) &&
      !roleHolds(person.role, PRODUCTION_GATE_SAFETY_PERMISSION)
    ) {
      throw refusal("production_gate_clearance_forbidden", 403);
    }
    const tenantId = auth.session.tenant_id;
    const idempotency = await idempotencyFor(req, tenantId);
    const body = await readJsonBody(req);
    if (isRecord(body) && body.basis === "person_attestation") {
      return await attestGate(env, auth, person, idempotency, roofJobId, gate, body);
    }
    if (!roleHolds(person.role, CLEAR_PERMISSION)) {
      throw refusal("production_gate_clearance_forbidden", 403);
    }
    const input = parseProductionGateClearance(gate, roofJobId, idempotency.key, body);
    if (!input) throw refusal("invalid_production_gate_clearance", 400);

    await assertOnRunway(env, auth, input.roofJobId);
    if (input.basis === "office_waiver" && !isWaivableProductionGate(input.gate)) {
      throw refusal("production_gate_not_waivable", 409);
    }

    const current = await readGate(env, tenantId, input.roofJobId, input.gate);
    if (!current) throw refusal("production_gate_record_unavailable", 409);
    const requestSha256 = await sha256Hex(canonicalJson({
      route: "clearance",
      tenant_id: tenantId,
      roof_job_id: input.roofJobId,
      gate: input.gate,
      actor_user_id: person.userId,
      basis: input.basis,
      reason: input.reason,
    }));
    const existing = await entryByKey(env, tenantId, idempotency.keyHash);
    if (existing) return clearanceResponse(current, replayOf(existing, requestSha256), true);
    // Refuse before any receipt is stored, so a decision on a gate that is already cleared
    // leaves no orphan object behind.
    if (current.state !== "blocked") throw refusal("production_gate_already_cleared", 409);

    let entry: NewEntry;
    if (input.basis === "deposit_settlement") {
      entry = await depositSettlementEntry(env, tenantId, input, person, idempotency);
    } else {
      const decides = person.role === WAIVER_DECIDER_ROLE &&
        await otherWaiverDeciders(env, tenantId, person.userId) === 0;
      entry = decides
        ? {
          entry_kind: "waiver_decision",
          basis: "office_waiver",
          to_state: "waived",
          request_id: null,
          requested_by: person.userId,
          self_approval: 1,
          evidence_refs_json: null,
          reason: input.reason,
        }
        : {
          entry_kind: "waiver_request",
          basis: "office_waiver",
          to_state: "blocked",
          request_id: null,
          requested_by: null,
          self_approval: 0,
          evidence_refs_json: null,
          reason: input.reason,
        };
    }
    if (entry.entry_kind === "waiver_request") {
      const open = await openWaiverRequest(env, tenantId, current.gate_id, person.userId);
      if (open) return openRequestResponse(open);
    }
    try {
      const appended = await appendEntry(env, {
        tenantId,
        gate: current,
        person,
        idempotency,
        requestSha256,
        entry,
      });
      return clearanceResponse(current, appended.row, appended.replayed);
    } catch (error) {
      const open = error instanceof ProductionGateClearanceError &&
          error.code === "production_gate_waiver_request_open"
        ? await openWaiverRequest(env, tenantId, current.gate_id, person.userId)
        : null;
      if (open) return openRequestResponse(open);
      throw error;
    }
  } catch (error) {
    return refusalResponse(error);
  }
}

/** A stored entry as the gate routes show it: structured fields and the free text, no actor id. */
function entryProjection(row: LedgerRow) {
  return {
    id: row.clearance_id,
    kind: row.entry_kind,
    basis: row.basis,
    to_state: row.to_state,
    from_gate_version: Number(row.from_gate_version),
    actor_role: row.actor_role,
    created_at: row.created_at,
    request_id: row.request_id,
    reverses_id: row.reverses_id,
    self_approval: Number(row.self_approval) === 1,
    attestation: row.attestation_json
      ? JSON.parse(row.attestation_json) as Record<string, unknown>
      : null,
    // Only an attestation's references are this list. A settlement names its receipt on the gate
    // row, and a legacy entry kept whatever the gate held before the ledger.
    evidence_refs: row.basis === "person_attestation" && row.evidence_refs_json
      ? JSON.parse(row.evidence_refs_json) as EvidenceRef[]
      : null,
    // A waiver's or reversal's reason, or an attestation's note; null once redacted.
    reason: row.reason,
    reason_redacted: row.reason_redacted_at !== null,
  };
}

function gateProjection(gate: GateRow) {
  return {
    name: gate.gate_id,
    gate: gate.gate,
    roof_job: gate.roof_job_id,
    state: gate.state,
    version: Number(gate.version),
  };
}

/** An appended or replayed entry and the gate as it stands now, both read back from D1. */
async function entryResponse(
  env: AppEnv,
  tenantId: string,
  entry: LedgerRow,
  replayed: boolean,
): Promise<Response> {
  const gate = await env.DB.prepare(
    `SELECT gate_id, roof_job_id, gate, state, version
       FROM operating_production_gates
      WHERE tenant_id = ? AND gate_id = ?`,
  ).bind(tenantId, entry.gate_id).first<GateRow>();
  if (!gate) throw refusal("production_gate_record_unavailable", 409);
  return json({ entry: entryProjection(entry), gate: gateProjection(gate), replayed });
}

/** Whether an active crew membership names a login that shares a coordinate with this person. */
async function attesterOnCrew(
  env: AppEnv,
  tenantId: string,
  person: PersonSession,
): Promise<boolean> {
  const coordinates = person.identities.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT 1 AS found
       FROM fleet_crew_members membership
       JOIN app_users worker
         ON worker.tenant_id = membership.tenant_id
        AND worker.user_id = membership.user_id
      WHERE membership.tenant_id = ?
        AND membership.active = 1
        AND (lower(worker.user_id) IN (${coordinates})
          OR worker.email_normalized IN (${coordinates})
          OR lower(trim(worker.frappe_user_id)) IN (${coordinates}))
      LIMIT 1`,
  ).bind(tenantId, ...person.identities, ...person.identities, ...person.identities).first();
  return row !== null;
}

/** An inventory exception of the job that is open or contained, as the runway reads it. */
async function materialExceptionOpen(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found
       FROM inventory_exceptions
      WHERE tenant_id = ? AND aggregate_type = 'roof_job' AND aggregate_id = ?
        AND status IN ('open', 'contained')
      LIMIT 1`,
  ).bind(tenantId, roofJobId).first();
  return row !== null;
}

/** An active safety stop on the job, read exactly as the job phase reads it. */
async function safetyStopActive(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS found
       FROM safety_occurrences
      WHERE tenant_id = ? AND scope_type = 'roof_job' AND scope_id = ? AND stop_active = 1
      LIMIT 1`,
  ).bind(tenantId, roofJobId).first();
  return row !== null;
}

/**
 * The person's current internal Worker Competency, as migration 0158 checks it: under any login
 * coordinate they carry, the latest version of its record with no contradicting copy, superseded
 * by no other record, verified by an internal assessment, not revoked, in force today and not
 * bound to another job. The most recently observed one is bound into the attestation.
 */
async function currentCompetency(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  person: PersonSession,
  now: Date,
): Promise<CompetencyBinding | null> {
  const today = now.toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `SELECT competency.readback_id, competency.authority_record_id, competency.authority_version,
            competency.authority_state_digest_sha256
       FROM authority_record_readbacks competency
      WHERE competency.tenant_id = ?
        AND competency.subject_type = 'Person'
        AND competency.subject_role = 'Worker'
        AND competency.authority_kind = 'Worker Competency'
        AND lower(trim(competency.person_user)) IN (${person.identities.map(() => "?").join(", ")})
        AND (competency.roof_job IS NULL OR competency.roof_job = ?)
        AND competency.verification_state = 'verified'
        AND competency.authority_revoked_at IS NULL
        AND competency.authority_verification_method = 'Internal Competency Assessment'
        AND competency.authority_effective_from <= ?
        AND competency.authority_expires_at >= ?
        AND NOT EXISTS (
          SELECT 1
            FROM authority_record_readbacks other
           WHERE other.tenant_id = competency.tenant_id
             AND other.authority_record_id = competency.authority_record_id
             AND (other.authority_version > competency.authority_version
               OR (other.authority_version = competency.authority_version
                 AND other.authority_state_digest_sha256
                   != competency.authority_state_digest_sha256))
        )
        AND NOT EXISTS (
          SELECT 1
            FROM authority_record_readbacks successor
           WHERE successor.tenant_id = competency.tenant_id
             AND successor.supersedes_authority_record_id = competency.authority_record_id
        )
      ORDER BY competency.observed_at DESC, competency.readback_id DESC
      LIMIT 1`,
  ).bind(tenantId, ...person.identities, roofJobId, today, today).first<{
    readback_id: string;
    authority_record_id: string;
    authority_version: number;
    authority_state_digest_sha256: string;
  }>();
  return row
    ? {
      readback_id: row.readback_id,
      authority_record_id: row.authority_record_id,
      authority_version: Number(row.authority_version),
      state_digest_sha256: row.authority_state_digest_sha256,
    }
    : null;
}

/**
 * Each cited reference resolved against this job, with a checksum the Worker took, never one the
 * client sent: a verified, stored Work Package capture with the checksum of its stored object, or,
 * on Materials only, a live stock reservation of the job at its current version with the digest
 * of the reservation as read.
 */
async function resolvedEvidence(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  gate: AttestableProductionGate,
  refs: readonly string[],
): Promise<EvidenceRef[]> {
  const invalid = () => refusal("production_gate_evidence_invalid", 409);
  const evidenceIds = refs.map(fieldEvidenceId).filter((id): id is string => id !== null);
  const reservationIds = refs.map(stockReservationId).filter((id): id is string => id !== null);
  if (reservationIds.length > 0 && gate !== "Materials") throw invalid();
  const resolved = new Map<string, EvidenceRef>();
  if (evidenceIds.length > 0) {
    let rows: Awaited<ReturnType<typeof listJobEvidenceItemsFromD1>>;
    try {
      rows = await listJobEvidenceItemsFromD1(env, { tenantId, jobId: roofJobId, evidenceIds });
    } catch (error) {
      // A cited row that cannot be read as complete evidence is not evidence.
      if (error instanceof Error && error.message.startsWith("field_evidence_")) throw invalid();
      throw refusal("production_gate_evidence_unavailable", 502);
    }
    if (rows === null) throw refusal("production_gate_evidence_unavailable", 502);
    for (const row of rows) {
      const ref = `field-evidence://${row.evidenceItem}`;
      if (row.verification !== "Verified" || resolved.has(ref)) throw invalid();
      resolved.set(ref, { ref, sha256: row.checksumSha256 });
    }
  }
  if (reservationIds.length > 0) {
    const rows = await env.DB.prepare(
      `SELECT reservation_id, job_id, work_package_id, position_id, uom_id,
              reserved_quantity_scaled, issued_quantity_scaled, returned_quantity_scaled,
              status, version, command_id, updated_at
         FROM inventory_reservations
        WHERE tenant_id = ? AND job_id = ?
          AND status IN (${LIVE_RESERVATION_STATES.map(() => "?").join(", ")})
          AND reservation_id IN (${reservationIds.map(() => "?").join(", ")})`,
    ).bind(tenantId, roofJobId, ...LIVE_RESERVATION_STATES, ...reservationIds)
      .all<Record<string, unknown> & { reservation_id: string; version: number }>();
    for (const row of rows.results ?? []) {
      const ref = `stock-reservation://${row.reservation_id}`;
      resolved.set(ref, {
        ref,
        sha256: await sha256Hex(canonicalJson(row)),
        version: Number(row.version),
      });
    }
  }
  if (refs.some((ref) => !resolved.has(ref))) throw invalid();
  return refs.map((ref) => resolved.get(ref)!);
}

/**
 * `person_attestation`: one `clear` entry taking the gate to `ready`, after every rule D1 repeats
 * in migration 0158 has been read here first, so each refusal answers with its own code.
 */
async function attestGate(
  env: AppEnv,
  auth: AuthContext,
  person: PersonSession,
  idempotency: Idempotency,
  roofJobId: string,
  gate: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!isClearableProductionGate(gate)) throw refusal("invalid_production_gate_clearance", 400);
  // Deposit clears on its contract or its settlement, and Crew from the roster at scheduling.
  if (!isAttestableProductionGate(gate)) throw refusal("production_gate_not_attestable", 409);
  const operationSet = gate === "Safety" ? PRODUCTION_GATE_SAFETY_PERMISSION : CLEAR_PERMISSION;
  if (!roleHolds(person.role, operationSet)) {
    throw refusal("production_gate_clearance_forbidden", 403);
  }
  const now = new Date();
  const input = parseProductionGateAttestation(gate, body, now);
  if (!input) throw refusal("production_gate_attestation_invalid", 400);
  const tenantId = auth.session.tenant_id;
  await assertOnRunway(env, auth, roofJobId);

  const current = await readGate(env, tenantId, roofJobId, gate);
  if (!current) throw refusal("production_gate_record_unavailable", 409);
  const requestSha256 = await sha256Hex(canonicalJson({
    route: "attestation",
    tenant_id: tenantId,
    roof_job_id: roofJobId,
    gate,
    actor_user_id: person.userId,
    expected_gate_version: input.expectedGateVersion,
    attestation: input.attestation,
    note: input.note,
    evidence_refs: input.evidenceRefs,
  }));
  const existing = await entryByKey(env, tenantId, idempotency.keyHash);
  if (existing) return await entryResponse(env, tenantId, replayOf(existing, requestSha256), true);
  if (current.version !== input.expectedGateVersion) {
    throw refusal("production_gate_version_conflict", 409);
  }
  if (current.state !== "blocked") throw refusal("production_gate_already_cleared", 409);
  if (await attesterOnCrew(env, tenantId, person)) {
    throw refusal("production_gate_attester_on_crew", 403);
  }

  let attestation: Record<string, unknown> = { ...input.attestation };
  if (gate === "Materials" && await materialExceptionOpen(env, tenantId, roofJobId)) {
    throw refusal("production_gate_material_exception_open", 409);
  }
  if (gate === "Weather") {
    const weather = weatherRefusal(input.attestation as WeatherAttestation, now);
    if (weather) throw refusal(weather, 409);
  }
  if (gate === "Safety") {
    if (await safetyStopActive(env, tenantId, roofJobId)) {
      throw refusal("production_gate_safety_stop_active", 409);
    }
    const competency = await currentCompetency(env, tenantId, roofJobId, person, now);
    if (!competency) throw refusal("production_gate_competency_required", 403);
    attestation = { ...attestation, competency };
  }
  const evidence = await resolvedEvidence(env, tenantId, roofJobId, gate, input.evidenceRefs);
  const appended = await appendEntry(env, {
    tenantId,
    gate: current,
    person,
    idempotency,
    requestSha256,
    entry: {
      entry_kind: "clear",
      basis: "person_attestation",
      to_state: "ready",
      request_id: null,
      requested_by: null,
      self_approval: 0,
      attestation_json: canonicalJson(attestation),
      evidence_refs_json: canonicalJson(evidence),
      reason: input.note,
    },
  });
  return await entryResponse(env, tenantId, appended.row, appended.replayed);
}

async function depositSettlementEntry(
  env: AppEnv,
  tenantId: string,
  input: ProductionGateClearanceRequest,
  person: PersonSession,
  idempotency: Idempotency,
): Promise<NewEntry> {
  let intents: AccountingIntentRecord[];
  try {
    intents = await listAccountingIntents(env, tenantId, {
      kind: "deposit_invoice",
      roofJobId: input.roofJobId,
      states: [...SETTLED_DEPOSIT_STATES],
    });
  } catch {
    throw refusal("accounting_read_unavailable", 502);
  }
  const intent = settledDepositIntent(intents);
  const observedAt = intent ? settlementObservedAt(intent) : null;
  if (!intent || !observedAt) throw refusal("deposit_settlement_not_observed", 409);
  const receipt = depositSettlementReceipt({
    tenantId,
    roofJobId: input.roofJobId,
    decisionId: idempotency.clearanceId,
    clearedByUserId: person.userId,
    intent,
  });
  const checksum = await sha256Hex(receipt);
  const scopeSha256 = await sha256Hex(canonicalJson({
    tenant_id: tenantId,
    roof_job_id: input.roofJobId,
    gate: input.gate,
    decision_id: idempotency.clearanceId,
  }));
  const r2Key = `${RECEIPT_PREFIX}/${scopeSha256}.json`;
  try {
    await r2ObjectStore(env.RAW).ensure(r2Key, receipt, RECEIPT_CONTENT_TYPE, checksum);
  } catch {
    throw refusal("production_gate_receipt_unavailable", 503);
  }
  return {
    entry_kind: "clear",
    basis: "deposit_settlement",
    to_state: "complete",
    request_id: null,
    requested_by: null,
    self_approval: 0,
    reason: null,
    // D1 checks `money_intent_id` against a reconciled deposit invoice of the same job.
    evidence_refs_json: canonicalJson({
      r2_key: r2Key,
      content_checksum: checksum,
      content_type: RECEIPT_CONTENT_TYPE,
      content_length: new TextEncoder().encode(receipt).byteLength,
      captured_at: observedAt,
      summary: `Deposit settlement observed on money intent ${intent.intent_id}`,
      money_intent_id: intent.intent_id,
    }),
  };
}

function decisionResponse(gate: GateRow, entry: LedgerRow, replayed: boolean): Response {
  return json({
    decision: {
      clearance_id: entry.clearance_id,
      request_id: entry.request_id,
      decision: entry.to_state === "waived" ? "approve" : "decline",
      requested_by: entry.requested_by,
      decided_by: entry.actor_user_id,
      actor_role: entry.actor_role,
      self_approval: Number(entry.self_approval) === 1,
      self_approval_basis: entry.self_approval_basis,
      reason: entry.reason,
      created_at: entry.created_at,
    },
    gate: {
      name: gate.gate_id,
      gate: gate.gate,
      roof_job: gate.roof_job_id,
      state: entry.to_state,
      version: Number(entry.from_gate_version) + 1,
    },
    replayed,
  });
}

export async function handleProductionGateWaiverDecision(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
  gate: string,
): Promise<Response> {
  try {
    const person = await personFor(req, env, auth);
    if (!isClearableProductionGate(gate)) {
      throw refusal("invalid_production_gate_waiver_decision", 400);
    }
    if (!isWaivableProductionGate(gate)) throw refusal("production_gate_not_waivable", 409);
    if (person.role !== WAIVER_DECIDER_ROLE) {
      throw refusal("production_gate_waiver_decision_forbidden", 403);
    }
    const tenantId = auth.session.tenant_id;
    const idempotency = await idempotencyFor(req, tenantId);
    const input = parseProductionGateWaiverDecision(await readJsonBody(req));
    if (!input) throw refusal("invalid_production_gate_waiver_decision", 400);
    await assertOnRunway(env, auth, roofJobId);

    const current = await readGate(env, tenantId, roofJobId, gate);
    if (!current) throw refusal("production_gate_record_unavailable", 409);
    const requestSha256 = await sha256Hex(canonicalJson({
      route: "waiver_decision",
      tenant_id: tenantId,
      roof_job_id: roofJobId,
      gate,
      actor_user_id: person.userId,
      request_id: input.requestId,
      expected_gate_version: input.expectedGateVersion,
      decision: input.decision,
      reason: input.reason,
    }));
    const existing = await entryByKey(env, tenantId, idempotency.keyHash);
    if (existing) return decisionResponse(current, replayOf(existing, requestSha256), true);
    if (current.version !== input.expectedGateVersion) {
      throw refusal("production_gate_version_conflict", 409);
    }
    const request = await entryById(env, tenantId, input.requestId);
    if (
      !request ||
      request.entry_kind !== "waiver_request" ||
      request.gate_id !== current.gate_id ||
      !request.actor_user_id
    ) {
      throw refusal("production_gate_waiver_request_invalid", 409);
    }
    // Requester != decider. The only active holder may approve their own item (D-08).
    const ownItem = request.actor_user_id === person.userId;
    if (
      ownItem &&
      (input.decision !== "approve" ||
        await otherWaiverDeciders(env, tenantId, person.userId) > 0)
    ) {
      throw refusal("production_gate_waiver_self_approval_refused", 409);
    }
    const appended = await appendEntry(env, {
      tenantId,
      gate: current,
      person,
      idempotency,
      requestSha256,
      entry: {
        entry_kind: "waiver_decision",
        basis: "office_waiver",
        to_state: input.decision === "approve" ? "waived" : "blocked",
        request_id: request.clearance_id,
        requested_by: request.actor_user_id,
        self_approval: ownItem ? 1 : 0,
        evidence_refs_json: null,
        reason: input.reason,
      },
    });
    return decisionResponse(current, appended.row, appended.replayed);
  } catch (error) {
    return refusalResponse(error);
  }
}

export interface ProductionGateReversalRequest {
  expectedGateVersion: number;
  reversesId: string;
  reason: string;
}

/** A reversal body has exactly `{expected_gate_version, reverses_id, reason}`. */
export function parseProductionGateReversal(body: unknown): ProductionGateReversalRequest | null {
  if (!isRecord(body)) return null;
  if (Object.keys(body).sort().join(",") !== "expected_gate_version,reason,reverses_id") {
    return null;
  }
  const { expected_gate_version: version, reverses_id: reversesId } = body;
  if (typeof reversesId !== "string" || !CLEARANCE_ID_RE.test(reversesId)) return null;
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > 1_000_000) {
    return null;
  }
  // A reversal states its reason under the same bounds as a waiver's.
  const reason = waiverReason(body.reason);
  if (!reason) return null;
  return { expectedGateVersion: version as number, reversesId, reason };
}

export async function handleProductionGateReversal(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
  gate: string,
): Promise<Response> {
  try {
    const person = await personFor(req, env, auth);
    if (!roleHolds(person.role, CLEAR_PERMISSION)) {
      throw refusal("production_gate_reversal_forbidden", 403);
    }
    const tenantId = auth.session.tenant_id;
    const idempotency = await idempotencyFor(req, tenantId);
    const input = parseProductionGateReversal(await readJsonBody(req));
    if (!input || !isClearableProductionGate(gate)) {
      throw refusal("invalid_production_gate_reversal", 400);
    }
    await assertOnRunway(env, auth, roofJobId);

    const current = await readGate(env, tenantId, roofJobId, gate);
    if (!current) throw refusal("production_gate_record_unavailable", 409);
    const requestSha256 = await sha256Hex(canonicalJson({
      route: "reversal",
      tenant_id: tenantId,
      roof_job_id: roofJobId,
      gate,
      actor_user_id: person.userId,
      expected_gate_version: input.expectedGateVersion,
      reverses_id: input.reversesId,
      reason: input.reason,
    }));
    const existing = await entryByKey(env, tenantId, idempotency.keyHash);
    if (existing) return await entryResponse(env, tenantId, replayOf(existing, requestSha256), true);
    if (current.version !== input.expectedGateVersion) {
      throw refusal("production_gate_version_conflict", 409);
    }
    if (current.state === "blocked") throw refusal("production_gate_not_cleared", 409);
    // Only the entry that holds the gate's current state can be reversed: the one its current
    // version was produced by.
    const target = await entryById(env, tenantId, input.reversesId);
    if (
      !target ||
      target.gate_id !== current.gate_id ||
      Number(target.from_gate_version) + 1 !== Number(current.version) ||
      target.to_state !== current.state
    ) {
      throw refusal("production_gate_reversal_target_invalid", 409);
    }
    // A contract that needs no deposit is reversed by a superseding contract, never by a person.
    if (target.basis === "contract_no_deposit") throw refusal("production_gate_not_reversible", 409);
    const appended = await appendEntry(env, {
      tenantId,
      gate: current,
      person,
      idempotency,
      requestSha256,
      entry: {
        entry_kind: "reverse",
        basis: "person_reversal",
        to_state: "blocked",
        request_id: null,
        reverses_id: target.clearance_id,
        requested_by: null,
        self_approval: 0,
        evidence_refs_json: null,
        reason: input.reason,
      },
    });
    return await entryResponse(env, tenantId, appended.row, appended.replayed);
  } catch (error) {
    return refusalResponse(error);
  }
}

/** One gate as the office reads it, with its newest entries and its open waiver requests. */
async function gateRead(env: AppEnv, tenantId: string, gate: GateRow) {
  const [entries, requests] = await Promise.all([
    env.DB.prepare(
      `SELECT ${LEDGER_COLUMNS}
         FROM production_gate_clearances
        WHERE tenant_id = ? AND gate_id = ?
        ORDER BY from_gate_version DESC
        LIMIT ?`,
    ).bind(tenantId, gate.gate_id, MAX_GATE_READ_ROWS + 1).all<LedgerRow>(),
    env.DB.prepare(
      `SELECT ${LEDGER_COLUMNS}
         FROM production_gate_clearances request
        WHERE request.tenant_id = ? AND request.gate_id = ?
          AND request.entry_kind = 'waiver_request'
          AND NOT EXISTS (
            SELECT 1
              FROM production_gate_clearances decision
             WHERE decision.tenant_id = request.tenant_id
               AND decision.request_id = request.clearance_id
          )
        ORDER BY request.from_gate_version DESC
        LIMIT ?`,
    ).bind(tenantId, gate.gate_id, MAX_GATE_READ_ROWS + 1).all<LedgerRow>(),
  ]);
  const entryRows = entries.results ?? [];
  const requestRows = requests.results ?? [];
  return {
    ...gateProjection(gate),
    // False when the gate holds more entries or open requests than the read returns; the newest
    // are returned.
    ledger_complete: entryRows.length <= MAX_GATE_READ_ROWS &&
      requestRows.length <= MAX_GATE_READ_ROWS,
    entries: entryRows.slice(0, MAX_GATE_READ_ROWS).reverse().map(entryProjection),
    // A request is decided only while its gate is blocked, so only then is it open. Its
    // `request_id` is what `.../waiver-decisions` answers.
    open_waiver_requests: gate.state !== "blocked"
      ? []
      : requestRows.slice(0, MAX_GATE_READ_ROWS).reverse().map((row) => ({
        request_id: row.clearance_id,
        requested_by: row.actor_user_id,
        requested_by_role: row.actor_role,
        from_gate_version: Number(row.from_gate_version),
        reason: row.reason,
        reason_redacted: row.reason_redacted_at !== null,
        created_at: row.created_at,
      })),
  };
}

/**
 * The office's read of a job's scheduling gates (owner, ops and production: the roles holding
 * `production:read`). No other role reads it, so the free text it carries never reaches one.
 * Agents may read gates; nothing here moves one.
 */
export async function handleProductionGatesRead(
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
): Promise<Response> {
  if (!auth.permissions.includes("production:read")) {
    return json({ error: "office_role_required" }, 403);
  }
  try {
    const tenantId = auth.session.tenant_id;
    const rows = await env.DB.prepare(
      `SELECT gate_id, roof_job_id, gate, state, version
         FROM operating_production_gates
        WHERE tenant_id = ? AND roof_job_id = ?
          AND gate IN (${CLEARABLE_PRODUCTION_GATES.map(() => "?").join(", ")})`,
    ).bind(tenantId, roofJobId, ...CLEARABLE_PRODUCTION_GATES).all<GateRow>();
    const gates = CLEARABLE_PRODUCTION_GATES.flatMap((name) =>
      (rows.results ?? []).filter((row) => row.gate === name)
    );
    if (gates.length === 0) return json({ error: "production_gate_job_not_found" }, 404);
    return json({
      roof_job: roofJobId,
      gates: await Promise.all(gates.map((gate) => gateRead(env, tenantId, gate))),
    });
  } catch {
    return json({ error: "production_gates_unavailable" }, 502);
  }
}
