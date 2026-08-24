// production-gate-clearance.ts - the producers the six scheduling gates never had.
//
// ELEC-120 finding 3, reproduced on a real stack: a legitimately Won job reached
// `POST /api/v1/production-schedule-approvals` and was refused
// `409 production_schedule_not_eligible`, because all six production gates
// (Deposit, Materials, Safety, Access, Weather, Crew) were `Blocked` and *nothing
// in the product could move one*. Transport creates them Blocked, the validators
// and the scheduling fence enforce them correctly, and no route or surface ever
// cleared one. Same class as the Won gate before #101: validated states, zero
// producers.
//
// Two clearing bases, and which one a gate gets is a statement about what IronWrap
// can actually prove today:
//
//   * `deposit_settlement` - derived, evidence-linked, no human toggle. The money
//     lane already records when a deposit invoice settles: an `accounting_intents`
//     row of kind `deposit_invoice` for this job reaches `partially_settled` or
//     `reconciled` with a settled amount, and that state is only ever written by an
//     authenticated provider read-back (`accounting-reconciliation.ts`). This path
//     reads that record, stores an immutable receipt of exactly what it read, and
//     hands Frappe the receipt facts so the gate is cleared *on evidence*. It
//     derives no settlement of its own and it never clears a gate the money lane
//     has not settled - the refusal is `deposit_settlement_not_observed`.
//
//   * `office_waiver` - a governed manual clearance: a named actor, a stated
//     reason, a recorded time, landing in the gate's own `Waived` state, which is
//     exactly the shape `domain_policy._validate_gate` asks of a clearance that
//     carries no evidence. This is the honest v1 for Materials, Safety, Access,
//     Weather and Crew: none of the five has a product rail that produces a
//     readiness artifact yet (a weather window has no source at all; a signed-off
//     material delivery, safety plan acknowledgement and crew confirmation each
//     have domain records but no rail that binds one to its gate). It is marked as
//     a waiver everywhere it is shown, precisely so it is never mistaken for proof.
//
// The authority is not invented here. `access_control.DOCTYPE_ROLE_MATRIX` already
// gives gate authority to IronWrap Production, and the blanket owner grant gives it
// to IronWrap Owner; Frappe re-checks the actor's role and real write permission on
// the row. The Worker's job is to refuse early, in the caller's own tenant, and to
// store the receipt before anything durable is written.

import { validAppCsrf } from "./app-auth.ts";
import { listAccountingIntents, type AccountingIntentRecord } from "./accounting-intents.ts";
import { buildProductionRunwayReadModel } from "./app-read-models.ts";
import { r2ObjectStore } from "./field-actions.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

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

export const PRODUCTION_GATE_CLEARANCE_BASES = [
  "office_waiver",
  "deposit_settlement",
] as const;

export type ProductionGateClearanceBasis =
  (typeof PRODUCTION_GATE_CLEARANCE_BASES)[number];

/**
 * The money-lane states that mean "the provider told us money landed against this
 * invoice". Both are only ever reached through an authenticated read-back in
 * `accounting-reconciliation.ts`; neither can be set by a local command.
 */
const SETTLED_DEPOSIT_STATES = ["partially_settled", "reconciled"] as const;

const CLEARANCE_PERMISSION = "production:clear_gate";
const RECEIPT_CONTENT_TYPE = "application/json";
const RECEIPT_PREFIX = "production-gate-clearance/v1";
const MAX_BODY_BYTES = 16 * 1024;
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 1_000;
const DECISION_ID_RE = /^[A-Za-z0-9._:-]{16,160}$/;
const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

export interface ProductionGateClearanceRequest {
  roofJobId: string;
  gate: ClearableProductionGate;
  basis: ProductionGateClearanceBasis;
  reason: string | null;
  decisionId: string;
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

export function isClearableProductionGate(
  value: string,
): value is ClearableProductionGate {
  return (CLEARABLE_PRODUCTION_GATES as readonly string[]).includes(value);
}

/**
 * Who may ask for a clearance at the edge. Attribution is the app user and
 * role, not a leftover Frappe identity.
 */
export function mayClearProductionGate(auth: AuthContext): boolean {
  return auth.permissions.includes(CLEARANCE_PERMISSION);
}

export function parseProductionGateClearance(
  gate: string,
  roofJobId: string,
  decisionId: string,
  body: unknown,
): ProductionGateClearanceRequest | null {
  if (!isClearableProductionGate(gate)) return null;
  if (!DECISION_ID_RE.test(decisionId)) return null;
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "basis" && key !== "reason")) return null;
  const basis = body.basis;
  if (typeof basis !== "string") return null;
  if (!(PRODUCTION_GATE_CLEARANCE_BASES as readonly string[]).includes(basis)) return null;
  const typedBasis = basis as ProductionGateClearanceBasis;
  // A settlement clearance takes its whole statement from the money lane. Letting
  // the caller attach prose to it would invite a reason that contradicts the
  // record the receipt is made of.
  if (typedBasis === "deposit_settlement") {
    if (body.reason !== undefined) return null;
    if (gate !== "Deposit") return null;
    return { roofJobId, gate, basis: typedBasis, reason: null, decisionId };
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) return null;
  if (/[\u0000\r]/.test(reason)) return null;
  return { roofJobId, gate, basis: typedBasis, reason, decisionId };
}

/**
 * The settled deposit invoice this clearance is allowed to be made of, or null.
 *
 * Ordered so the answer is deterministic when a job carries more than one deposit
 * intent: fully `reconciled` outranks `partially_settled`, then the most recently
 * reconciled. A settled amount that is absent or not positive is not a settlement,
 * whatever the state column says.
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
  return [...settled].sort((left, right) => {
    const rank = (intent: AccountingIntentRecord) => (intent.state === "reconciled" ? 0 : 1);
    return (
      rank(left) - rank(right) ||
      (right.provider_reconciled_at ?? "").localeCompare(left.provider_reconciled_at ?? "") ||
      left.intent_id.localeCompare(right.intent_id)
    );
  })[0] ?? null;
}

/**
 * The receipt is the artifact the gate's evidence is made of, so it records what
 * was read and nothing that was inferred. It is canonical JSON, hashed, and stored
 * immutably before Frappe is called, so the Evidence Item can never point at an
 * object that does not exist or has changed.
 *
 * Deliberately free of any wall-clock stamp. The same decision over the same money
 * record must produce the same bytes: R2 stores the receipt immutably, so a stamp
 * of "when this ran" would make every retry of a clearance collide with its own
 * first attempt and answer `production_gate_receipt_unavailable` forever - found
 * exactly that way on a real stack. The observation time that belongs on the
 * receipt is the money lane's own (`settlement_observed_at`), which is a fact
 * about the settlement rather than about this request.
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

function depositReason(intent: AccountingIntentRecord): string {
  return (
    `Deposit invoice ${intent.intent_id} settled ${intent.settled_amount} ` +
    `${intent.currency} of ${intent.total_amount} (${intent.state}), observed from ` +
    `${intent.provider} ${intent.provider_entity_type ?? "entity"} ` +
    `${intent.provider_entity_id ?? "unknown"}.`
  );
}

export interface ProductionGateClearanceFrappeWriter {
  clear(input: {
    roofJobId: string;
    gate: ClearableProductionGate;
    clearance: "waived" | "verified";
    actorUser: string;
    decisionId: string;
    reason: string;
  }): Promise<Record<string, unknown>>;
}

/**
 * Frappe answers a refusal as `"<machine_code>: <prose>"` inside its exception
 * payload. The trailing colon is load-bearing: the module path
 * `ironwrap_roofing.production_gate_api` appears in every traceback and matches the
 * code shape otherwise, which is how a real refusal first surfaced here as the
 * meaningless code `production_gate_api`. A refusal that carries no code of its own
 * - the shipped waiver-attribution rule, for one - stays anonymous rather than
 * being given one it never claimed.
 */
export function frappeRefusalCode(body: string): string {
  const match = body.match(/\b(production_gate_[a-z0-9_]+):\s/);
  return match ? match[1] : "production_gate_frappe_refused";
}

export interface ProductionGateClearanceDeps {
  /** Leftover Frappe writer. The required path persists on D1 and ignores this. */
  frappe?: ProductionGateClearanceFrappeWriter;
}

interface NativeClearanceResult {
  gate: Record<string, unknown>;
  evidence_item: string | null;
  actor_role: string;
  replayed: boolean;
}

export async function handleProductionGateClearance(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  roofJobId: string,
  gate: string,
  deps: ProductionGateClearanceDeps = {},
): Promise<Response> {
  void deps;
  if (!mayClearProductionGate(auth)) {
    return json({ error: "production_gate_clearance_forbidden" }, 403);
  }
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const decisionId = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!DECISION_ID_RE.test(decisionId)) {
    return json({ error: "idempotency_key_required" }, 400);
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const input = parseProductionGateClearance(gate, roofJobId, decisionId, body);
  if (!input) return json({ error: "invalid_production_gate_clearance" }, 400);

  // The caller's own runway read, in the caller's own tenant. A job reference is
  // never taken on trust (ELEC-112 finding 3, the same defect one lane over), and
  // the runway is exactly the set the scheduling fence consults, so a job this
  // read cannot see has no gate this session may clear.
  let runwayJob;
  try {
    const runway = await buildProductionRunwayReadModel(env, auth);
    runwayJob = runway.jobs.find((candidate) => candidate.id === input.roofJobId);
  } catch {
    return json({ error: "production_runway_unavailable" }, 502);
  }
  if (!runwayJob) return json({ error: "production_gate_job_not_on_runway" }, 409);
  const gateRow = runwayJob.scheduling_gates.find((row) => row.name === input.gate);
  if (!gateRow || !gateRow.state) {
    return json({ error: "production_gate_record_unavailable" }, 409);
  }

  const actorUserId = auth.session.user_id.trim();
  try {
    const result = input.basis === "deposit_settlement" || input.reason === null
      ? await clearOnDepositSettlement(env, auth, input, actorUserId)
      : await persistNativeClearance(env, auth, input, {
        state: "waived",
        evidenceItem: null,
        evidenceRefs: null,
        clearedAt: new Date().toISOString(),
      });
    return json({
      gate: result.gate,
      basis: input.basis,
      clearance: input.basis === "deposit_settlement" ? "verified" : "waived",
      evidence_item: result.evidence_item ?? null,
      actor_role: result.actor_role,
      replayed: result.replayed === true,
    });
  } catch (error) {
    if (error instanceof ProductionGateClearanceError) {
      return json({ error: error.code }, error.status);
    }
    return json({ error: "production_gate_clearance_failed" }, 502);
  }
}

async function persistNativeClearance(
  env: AppEnv,
  auth: AuthContext,
  input: ProductionGateClearanceRequest,
  write: {
    state: "complete" | "waived";
    evidenceItem: string | null;
    evidenceRefs: Record<string, unknown> | null;
    clearedAt: string;
  },
): Promise<NativeClearanceResult> {
  if (!env.DB) {
    throw new ProductionGateClearanceError("production_gate_store_unavailable", 503);
  }
  const existing = await env.DB.prepare(
    `SELECT gate_id, tenant_id, roof_job_id, gate, state, version, clearance_decision_id
       FROM operating_production_gates
      WHERE tenant_id = ? AND roof_job_id = ? AND gate = ?
      LIMIT 1`,
  ).bind(auth.session.tenant_id, input.roofJobId, input.gate).first<{
    gate_id: string;
    tenant_id: string;
    roof_job_id: string;
    gate: string;
    state: string;
    version: number;
    clearance_decision_id: string | null;
  }>();
  if (!existing) {
    throw new ProductionGateClearanceError("production_gate_record_unavailable", 409);
  }
  if (existing.clearance_decision_id === input.decisionId) {
    return {
      gate: {
        name: existing.gate_id,
        gate: existing.gate,
        roof_job: existing.roof_job_id,
        state: existing.state === "waived" ? "Waived" : "Ready",
      },
      evidence_item: write.evidenceItem,
      actor_role: auth.session.role,
      replayed: true,
    };
  }
  if (existing.state === "complete" || existing.state === "waived") {
    throw new ProductionGateClearanceError("production_gate_already_cleared", 409);
  }
  const result = await env.DB.prepare(
    `UPDATE operating_production_gates
        SET state = ?,
            version = version + 1,
            updated_at = ?,
            clearance_basis = ?,
            clearance_decision_id = ?,
            cleared_by_user_id = ?,
            evidence_refs_json = ?,
            cleared_at = ?
      WHERE gate_id = ? AND tenant_id = ? AND version = ?`,
  ).bind(
    write.state,
    write.clearedAt,
    input.basis,
    input.decisionId,
    auth.session.user_id,
    write.evidenceRefs ? JSON.stringify(write.evidenceRefs) : null,
    write.clearedAt,
    existing.gate_id,
    auth.session.tenant_id,
    existing.version,
  ).run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new ProductionGateClearanceError("production_gate_version_conflict", 409);
  }
  return {
    gate: {
      name: existing.gate_id,
      gate: existing.gate,
      roof_job: existing.roof_job_id,
      state: write.state === "waived" ? "Waived" : "Ready",
    },
    evidence_item: write.evidenceItem,
    actor_role: auth.session.role,
    replayed: false,
  };
}

async function clearOnDepositSettlement(
  env: AppEnv,
  auth: AuthContext,
  input: ProductionGateClearanceRequest,
  actorUserId: string,
): Promise<NativeClearanceResult> {
  let intents: AccountingIntentRecord[];
  try {
    intents = await listAccountingIntents(env, auth.session.tenant_id, {
      kind: "deposit_invoice",
      roofJobId: input.roofJobId,
      states: [...SETTLED_DEPOSIT_STATES],
    });
  } catch {
    throw new ProductionGateClearanceError("accounting_read_unavailable", 502);
  }
  const intent = settledDepositIntent(intents);
  if (!intent) {
    throw new ProductionGateClearanceError("deposit_settlement_not_observed", 409);
  }
  const observedAt = settlementObservedAt(intent);
  if (!observedAt) {
    throw new ProductionGateClearanceError("deposit_settlement_not_observed", 409);
  }
  const receipt = depositSettlementReceipt({
    tenantId: auth.session.tenant_id,
    roofJobId: input.roofJobId,
    decisionId: input.decisionId,
    clearedByUserId: actorUserId,
    intent,
  });
  const checksum = await sha256Hex(receipt);
  const r2Key = `${RECEIPT_PREFIX}/${input.decisionId}.json`;
  try {
    await r2ObjectStore(env.RAW).ensure(r2Key, receipt, RECEIPT_CONTENT_TYPE, checksum);
  } catch {
    throw new ProductionGateClearanceError("production_gate_receipt_unavailable", 503);
  }
  const evidence = {
    r2_key: r2Key,
    content_checksum: checksum,
    content_type: RECEIPT_CONTENT_TYPE,
    content_length: new TextEncoder().encode(receipt).byteLength,
    captured_at: observedAt,
    summary: `Deposit settlement observed on money intent ${intent.intent_id}`,
  };
  return await persistNativeClearance(env, auth, input, {
    state: "complete",
    evidenceItem: `gate-clearance:${input.decisionId}`,
    evidenceRefs: evidence,
    clearedAt: observedAt,
  });
}
