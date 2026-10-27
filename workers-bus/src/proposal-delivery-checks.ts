/**
 * A person's "Check delivery" on a proposal send (#15b-1b, migration 0167).
 *
 * The bus asks the email service what it knows about one `proposal.publish` send, inside the
 * person's own request, and keeps the answer as one append-only `proposal_delivery_checks` row.
 * There is no executor, claim, lease or expiry, so "no one answered the request" cannot happen: a
 * check that cannot finish writes nothing, and the person's request fails. A check never creates an
 * effect, a permit or a send, and it never moves the send (L04: nothing is sent again before
 * delivery is confirmed). D1's evidence guard (0167) already accepts a `sent`, `bounced` or
 * complete-scan `not_found` row as the evidence for a move; B2 makes those moves, nothing here does.
 *
 * The delivery read derives the one state Track B's frames render (DESIGN.md §6), and a `*\/5`
 * sweep hands a send forgotten in `unknown` to the owner as an effect exception.
 */
import { agentDataClass } from "./agents/api.ts";
import type { AppEnv } from "./app-types.ts";
import {
  ProposalDeliveryConfirmationError,
  proposalDeliveryLateAnswerWindowMs,
} from "./commercial-store.ts";
import { getExternalEffect, type ExternalEffectRecord } from "./effect-runtime.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

/** One check reads back within about 25 s; each provider call has its own, shorter bound. */
export const PROPOSAL_DELIVERY_CHECK_TIMEOUT_MS = 25_000;
/**
 * T: how long a proposal send may stay unknown after its attempt ended before the owner is told.
 * The 4 hours are the design's recommendation; the owner has not set T yet (DESIGN.md §4).
 */
export const PROPOSAL_DELIVERY_ESCALATION_MS = 4 * 60 * 60_000;
export const PROPOSAL_DELIVERY_STALE_REASON = "proposal_delivery_unconfirmed_stale";
/**
 * D1 keeps at most this many checks of each kind per send (0167): citable ones (a complete-scan
 * `not_found`) and every other answer each have their own room, so answers that prove nothing can
 * never use up the room the proof needs.
 */
export const PROPOSAL_DELIVERY_CHECK_LIMIT = 20;
const QA_SYNTHETIC_PROVIDER = /^qa-synthetic-[a-z0-9-]+$/;
const CHECKABLE_STATES = ["unknown", "succeeded", "manual_exception"];
/**
 * The latest move into manual_exception came from one of these when the provider answered: its
 * readback conflicted (`reconciling`), or it refused the send and a later check said otherwise
 * (`failed`). Only such a send is checked from manual_exception, and only its "not delivered" needs a
 * cited check (0164, 0167).
 */
const PROVIDER_ANSWERED_ORIGINS = ["reconciling", "failed"];

/** The latest move into manual_exception of a send: where it came from, and when. */
async function exceptionEntry(
  env: AppEnv,
  effectId: string,
): Promise<{ from_state: string | null; occurred_at: string } | null> {
  return await env.DB.prepare(
    `SELECT from_state, occurred_at FROM external_effect_events
      WHERE effect_id = ? AND to_state = 'manual_exception' ORDER BY event_seq DESC LIMIT 1`,
  ).bind(effectId).first<{ from_state: string | null; occurred_at: string }>();
}

export type ProposalDeliveryCheckOutcome =
  | "sent"
  | "bounced"
  | "not_found"
  | "unknown"
  | "provider_unavailable";

export interface ProposalDeliveryCheckRecord {
  check_id: string;
  tenant_id: string;
  effect_id: string;
  proposal_pack_id: string;
  proposal_revision_id: string;
  effect_state: string;
  requested_by_user_id: string;
  requested_by_role: string;
  outcome: ProposalDeliveryCheckOutcome;
  scan_complete: number;
  provider_external_id: string | null;
  evidence_sha256: string | null;
  unavailable_since: string | null;
  detail_code: string | null;
  created_at: string;
}

/** What a provider readback found. `not_found` counts only after a complete scan. */
export interface ProposalDeliveryReadback {
  outcome: "sent" | "bounced" | "not_found" | "unknown";
  scanComplete?: boolean;
  providerExternalId?: string | null;
  /** What the provider showed; only its hash is kept. */
  evidence?: unknown;
  detailCode?: string | null;
}

/** A provider call that got no answer: a timeout, a network error, an HTTP status, an open breaker. */
export class ProposalDeliveryTransportError extends Error {
  readonly kind: "timeout" | "network" | "breaker_open" | "http";
  readonly status: number | null;

  constructor(kind: "timeout" | "network" | "breaker_open" | "http", status: number | null = null) {
    super(`proposal_delivery_transport_${kind}`);
    this.kind = kind;
    this.status = status;
    this.name = "ProposalDeliveryTransportError";
  }
}

/**
 * Reads back one send from its provider. It throws `ProposalDeliveryTransportError` when the
 * provider gave no answer; any other error is the Worker's own, and the check writes nothing.
 * `scansCompletely` says the readback can scan completely, so its "not found" can be kept and cited;
 * no adapter can before Proof P1. `findsMessages: false` says it can never find the message (it
 * answers "unknown" whatever the provider holds).
 */
export type ProposalDeliveryReadbackAdapter = ((
  effect: ExternalEffectRecord,
  signal: AbortSignal,
) => Promise<ProposalDeliveryReadback>) & {
  readonly scansCompletely?: boolean;
  readonly findsMessages?: boolean;
};

/** The QA seed's stand-in reaches no one: it answers from the send's own provider id. */
const qaSyntheticReadback: ProposalDeliveryReadbackAdapter = async (effect) =>
  effect.provider_external_id
    ? {
      outcome: "sent",
      providerExternalId: effect.provider_external_id,
      evidence: { provider: effect.provider, provider_external_id: effect.provider_external_id },
    }
    : { outcome: "unknown", detailCode: "provider_external_id_missing" };

/** Every other provider until its readback is built (Gmail in B4). */
const unsupportedReadback: ProposalDeliveryReadbackAdapter = Object.assign(
  async (): Promise<ProposalDeliveryReadback> => ({ outcome: "unknown", detailCode: "readback_not_supported" }),
  { findsMessages: false },
);

/** The readback for a send's provider, or null when this Worker may not touch that provider. */
function readbackAdapter(env: AppEnv, provider: string): ProposalDeliveryReadbackAdapter | null {
  if (!provider.startsWith("qa-synthetic-")) return unsupportedReadback;
  // PR-S: a stand-in provider belongs only on a Worker whose data class is exactly `synthetic`.
  return agentDataClass(env.AGENT_DATA_CLASS) === "synthetic" && QA_SYNTHETIC_PROVIDER.test(provider)
    ? qaSyntheticReadback
    : null;
}

interface CheckAnswer {
  outcome: ProposalDeliveryCheckOutcome;
  scanComplete: boolean;
  providerExternalId: string | null;
  evidence: unknown;
  detailCode: string | null;
}

/**
 * Runs the readback within the check's bound. A provider that gives no answer (timeout, network
 * error, 5xx, open breaker) is `provider_unavailable`; one that refuses our credentials (401, 403)
 * answered, so it is `unknown` / `provider_auth`, never "not answering".
 */
async function readBack(
  adapter: ProposalDeliveryReadbackAdapter,
  effect: ExternalEffectRecord,
  timeoutMs: number,
): Promise<CheckAnswer> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // The bound wins first: an adapter that answers as it is told to stop answered too late.
      reject(new ProposalDeliveryTransportError("timeout"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const pending = adapter(effect, controller.signal);
    // An answer that comes after the bound is dropped, and so is a late failure.
    pending.catch(() => undefined);
    const readback = await Promise.race([pending, timedOut]);
    const scanComplete = readback.scanComplete === true;
    // "Not found" without a complete scan proves nothing.
    const outcome = readback.outcome === "not_found" && !scanComplete ? "unknown" : readback.outcome;
    return {
      outcome,
      scanComplete,
      providerExternalId: readback.providerExternalId ?? null,
      evidence: readback.evidence,
      detailCode: readback.outcome === outcome ? readback.detailCode ?? null : "scan_incomplete",
    };
  } catch (error) {
    if (!(error instanceof ProposalDeliveryTransportError)) throw error;
    const status = error.status;
    if (error.kind === "http" && (status === 401 || status === 403)) {
      return { outcome: "unknown", scanComplete: false, providerExternalId: null, evidence: undefined, detailCode: "provider_auth" };
    }
    if (error.kind === "http" && status !== null && status < 500) {
      return { outcome: "unknown", scanComplete: false, providerExternalId: null, evidence: undefined, detailCode: `provider_http_${status}` };
    }
    return {
      outcome: "provider_unavailable",
      scanComplete: false,
      providerExternalId: null,
      evidence: undefined,
      detailCode: error.kind === "http" ? `provider_http_${status ?? "error"}` : `provider_${error.kind}`,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const CHECK_COLUMNS = `check_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, effect_state,
  requested_by_user_id, requested_by_role, outcome, scan_complete, provider_external_id, evidence_sha256,
  unavailable_since, detail_code, created_at`;

/**
 * A person checks delivery of one proposal send (0167): the provider readback runs in this request
 * and one check row keeps its answer, dated when the readback started. A check never moves the send:
 * a send whose lease ran out stays as it is until the `*\/5` lease sweep records it as unknown. The
 * same key with the same request replays; anything else conflicts.
 */
export async function checkProposalDelivery(
  env: AppEnv,
  input: {
    tenantId: string;
    effectId: string;
    actorUserId: string;
    actorRole: string;
    idempotencyKey: string;
    /** Replaces the provider's readback; tests and later adapters only. */
    adapter?: ProposalDeliveryReadbackAdapter;
    timeoutMs?: number;
    /** The Worker's clock, read once as the readback starts; tests only. */
    clock?: () => number;
  },
): Promise<{ check: ProposalDeliveryCheckRecord; replayed: boolean; deliveryState: ProposalDeliveryState }> {
  const keyHash = await sha256Hex(`proposal-delivery-check\n${input.tenantId}\n${input.idempotencyKey}`);
  const requestSha = await sha256Hex(canonicalJson({ effect_id: input.effectId, actor: input.actorUserId }));
  const readCheck = async (where: string, value: string) =>
    await env.DB.prepare(
      `SELECT ${CHECK_COLUMNS}, request_sha256 FROM proposal_delivery_checks
        WHERE tenant_id = ? AND ${where} = ? LIMIT 1`,
    ).bind(input.tenantId, value).first<ProposalDeliveryCheckRecord & { request_sha256: string }>();
  const answered = async (stored: ProposalDeliveryCheckRecord & { request_sha256: string }, replayed: boolean) => {
    const { request_sha256: _hash, ...check } = stored;
    return {
      check,
      replayed,
      deliveryState: await readProposalDeliveryState(env, input.tenantId, check.proposal_pack_id, check.proposal_revision_id),
    };
  };
  const replay = async () => {
    const prior = await readCheck("idempotency_key_hash", keyHash);
    if (!prior) return null;
    if (prior.request_sha256 !== requestSha) {
      throw new ProposalDeliveryConfirmationError("proposal_delivery_check_replay_conflict", 409);
    }
    return await answered(prior, true);
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const effect = await getExternalEffect(env, input.effectId);
  if (
    !effect || effect.tenant_id !== input.tenantId || effect.action !== "proposal.publish" ||
    effect.aggregate_type !== "proposal_publication"
  ) {
    throw new ProposalDeliveryConfirmationError("proposal_delivery_effect_not_found", 404);
  }
  const answeredException = effect.state === "manual_exception" &&
    PROVIDER_ANSWERED_ORIGINS.includes((await exceptionEntry(env, effect.effect_id))?.from_state ?? "");
  // Still sending (a lapsed lease included, until the lease sweep records it), never sent, or already
  // settled: there is nothing to read back. A manual exception
  // is checked only when its provider answered (a readback conflict of either kind); one that came
  // from a provider that never answered goes to a person after 0161's wait, with no check to cite.
  if (!CHECKABLE_STATES.includes(effect.state) || (effect.state === "manual_exception" && !answeredException)) {
    throw new ProposalDeliveryConfirmationError("proposal_delivery_check_effect_invalid", 409, {
      delivery_state: effect.state,
    });
  }
  const providerReadback = readbackAdapter(env, effect.provider);
  if (!providerReadback) throw new ProposalDeliveryConfirmationError("effect_provider_not_allowed", 403);
  const adapter = input.adapter ?? providerReadback;
  const recent = await recentChecks(env, input.tenantId, effect.effect_id);
  // D1 holds the limit too; refusing here first spares a provider call nobody can keep.
  if (!checkRoom(recent, adapter)) {
    throw new ProposalDeliveryConfirmationError("proposal_delivery_check_limit", 409);
  }

  // Dated as the readback starts: a "not found" counts only if the whole scan ran after the
  // provider's own late answer could still arrive (D1's too-early rule reads this date).
  const createdAt = new Date((input.clock ?? Date.now)()).toISOString();
  const answer = await readBack(adapter, effect, input.timeoutMs ?? PROPOSAL_DELIVERY_CHECK_TIMEOUT_MS);
  const needsEvidence = answer.outcome === "sent" || answer.outcome === "bounced" || answer.outcome === "not_found";
  const evidenceSha = answer.evidence !== undefined || needsEvidence
    ? await sha256Hex(canonicalJson(answer.evidence ?? {
      outcome: answer.outcome,
      provider: effect.provider,
      provider_external_id: answer.providerExternalId,
    }))
    : null;
  // The email service has not answered since the start of this send's unbroken run of
  // unavailable checks, or since this check began.
  const unavailableSince = answer.outcome === "provider_unavailable"
    ? earliestUnavailableSince(recent) ?? createdAt
    : null;
  const checkId = `delivery-check:${keyHash.slice(0, 40)}`;
  try {
    await env.DB.prepare(
      `INSERT INTO proposal_delivery_checks
         (check_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, effect_state,
          requested_by_user_id, requested_by_role, idempotency_key_hash, request_sha256, outcome,
          scan_complete, provider_external_id, evidence_sha256, unavailable_since, detail_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      checkId, input.tenantId, effect.effect_id, effect.aggregate_id, effect.intent_id, effect.state,
      input.actorUserId, input.actorRole, keyHash, requestSha, answer.outcome, answer.scanComplete ? 1 : 0,
      answer.providerExternalId, evidenceSha, unavailableSince, answer.detailCode, createdAt,
    ).run();
  } catch (error) {
    const raced = await replay();
    if (raced) return raced;
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/proposal_delivery_check_[a-z_]+/)?.[0] ?? "proposal_delivery_check_failed";
    throw new ProposalDeliveryConfirmationError(code, code.endsWith("_failed") ? 503 : 409);
  }
  const stored = await readCheck("check_id", checkId);
  if (!stored) throw new ProposalDeliveryConfirmationError("proposal_delivery_check_failed", 503);
  return await answered(stored, false);
}

/** A send whose request died after its claim: its lease ran out, so it is unknown work now. */
function leaseLapsed(
  effect: { state: string; lease_expires_at: string | null },
  at: number,
): boolean {
  return (effect.state === "executing" || effect.state === "reconciling") &&
    effect.lease_expires_at !== null && Date.parse(effect.lease_expires_at) <= at;
}

interface RecentCheck {
  check_id: string;
  outcome: ProposalDeliveryCheckOutcome;
  scan_complete: number;
  detail_code: string | null;
  unavailable_since: string | null;
  created_at: string;
}

/** All of a send's checks, newest first (D1 keeps at most twice the per-kind limit). */
async function recentChecks(env: AppEnv, tenantId: string, effectId: string): Promise<RecentCheck[]> {
  const rows = await env.DB.prepare(
    `SELECT check_id, outcome, scan_complete, detail_code, unavailable_since, created_at
       FROM proposal_delivery_checks WHERE tenant_id = ? AND effect_id = ?
      ORDER BY julianday(created_at) DESC, rowid DESC`,
  ).bind(tenantId, effectId).all<RecentCheck>();
  return rows.results ?? [];
}

/**
 * Whether one more check of this send can be kept. Each kind has its own room (0167): any answer
 * fits while the other answers have room; a found message (`sent`) fits while the found ones have
 * room, if the readback can find one at all; a citable "not found" fits while the citable ones have
 * room, if the readback scans completely (none does before Proof P1).
 */
function checkRoom(checks: readonly RecentCheck[], adapter: ProposalDeliveryReadbackAdapter | null): boolean {
  if (!adapter) return false;
  const citable = checks.filter((row) => row.outcome === "not_found").length;
  const found = checks.filter((row) => row.outcome === "sent").length;
  return checks.length - citable - found < PROPOSAL_DELIVERY_CHECK_LIMIT ||
    (adapter.findsMessages !== false && found < PROPOSAL_DELIVERY_CHECK_LIMIT) ||
    (adapter.scansCompletely === true && citable < PROPOSAL_DELIVERY_CHECK_LIMIT);
}

/**
 * Whether a check of this send found the message sent. The send was then executed, so nobody records
 * it as not delivered, cited or not, whichever came first (0167). A bounce is not such a check.
 */
function foundByCheck(checks: readonly RecentCheck[]): boolean {
  return checks.some((row) => row.outcome === "sent");
}

/** The earliest `unavailable_since` of the newest unbroken run of unavailable checks, or null. */
function earliestUnavailableSince(checks: readonly RecentCheck[]): string | null {
  let earliest: string | null = null;
  for (const check of checks) {
    if (check.outcome !== "provider_unavailable") break;
    const since = check.unavailable_since ?? check.created_at;
    if (earliest === null || Date.parse(since) < Date.parse(earliest)) earliest = since;
  }
  return earliest;
}

/** Track B's state codes (DESIGN.md §6, with 7·u, 1·b and 8(a) as drawn). */
export type ProposalDeliveryStateCode =
  | "4/9" | "3/9b"
  | "S0" | "S1" | "S2" | "S3" | "S4" | "E1" | "Q"
  | "1" | "7e" | "7c" | "7·u" | "1·b" | "8(a)" | "7";

/**
 * The one delivery state of a proposal revision, for the PWA to render. `record_*` tell whether a
 * person may record what they found now: a 0156 confirmation while the send is unknown or a manual
 * exception, a 0161 finding once it is settled. `not_delivered_*` tell whether "didn't get it" is
 * open and which check it must cite (only a send whose readback conflicted needs one).
 */
export interface ProposalDeliveryState {
  proposal_pack_id: string;
  proposal_revision_id: string;
  state: ProposalDeliveryStateCode;
  external_effect_id: string | null;
  effect_state: string | null;
  since: string | null;
  /** The customer's first open of the proposal (B1); not recorded yet. */
  viewed_at: string | null;
  escalated_at: string | null;
  check_allowed: boolean;
  /** Off until Send works end to end (B3): there is nothing a Share control could do yet. */
  share_allowed: boolean;
  record_allowed: boolean;
  record_not_before: string | null;
  not_delivered_allowed: boolean;
  not_delivered_check_id: string | null;
  check: Pick<RecentCheck, "check_id" | "outcome" | "detail_code" | "created_at"> | null;
}

interface LatestSend {
  effect_id: string;
  state: string;
  provider: string;
  aggregate_version: number;
  deadline_at: string;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
  attempt_state: string | null;
  ended_at: string | null;
}

/**
 * Derives a proposal revision's delivery state, evaluating DESIGN.md §6 top to bottom: recorded
 * (6.1), then the send states (6.2), then frames 1, 7e, 7c, 7·u, 1·b, 8(a) and 7 (6.3). E is the
 * revision's latest send, P the pack's newest unused publish permit, K E's newest check, F the latest
 * person record on E, X an open escalation of E. Nothing is written: a send whose lease ran out
 * reads as unknown until the sweep or a check records it.
 */
export async function readProposalDeliveryState(
  env: AppEnv,
  tenantId: string,
  proposalPackId: string,
  proposalRevisionId: string,
  now = new Date(),
): Promise<ProposalDeliveryState> {
  const at = now.getTime();
  const send = await env.DB.prepare(
    `SELECT effect.effect_id, effect.state, effect.provider, effect.aggregate_version, effect.deadline_at,
            effect.lease_expires_at, effect.created_at, effect.updated_at,
            attempt.state AS attempt_state, attempt.ended_at
       FROM external_effects effect
       LEFT JOIN external_effect_attempts attempt
         ON attempt.effect_id = effect.effect_id AND attempt.attempt_number = effect.attempt_count
      WHERE effect.tenant_id = ? AND effect.action = 'proposal.publish'
        AND effect.aggregate_type = 'proposal_publication'
        AND effect.aggregate_id = ? AND effect.intent_id = ?
      ORDER BY effect.created_at DESC, effect.effect_id DESC LIMIT 1`,
  ).bind(tenantId, proposalPackId, proposalRevisionId).first<LatestSend>();
  const permit = await env.DB.prepare(
    `SELECT permit.issued_at, permit.expires_at FROM commercial_authority_permits permit
      WHERE permit.tenant_id = ? AND permit.action = 'proposal.publish'
        AND permit.aggregate_type = 'proposal_publication' AND permit.aggregate_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM external_effects effect
           WHERE effect.tenant_id = permit.tenant_id AND effect.authority_ref = permit.permit_id
        )
      ORDER BY permit.issued_at DESC LIMIT 1`,
  ).bind(tenantId, proposalPackId).first<{ issued_at: string; expires_at: string }>();
  const base: ProposalDeliveryState = {
    proposal_pack_id: proposalPackId,
    proposal_revision_id: proposalRevisionId,
    state: "S0",
    external_effect_id: send?.effect_id ?? null,
    effect_state: send?.state ?? null,
    since: null,
    viewed_at: null,
    escalated_at: null,
    check_allowed: false,
    share_allowed: false,
    record_allowed: false,
    record_not_before: null,
    not_delivered_allowed: false,
    not_delivered_check_id: null,
    check: null,
  };
  const result = (
    state: ProposalDeliveryStateCode,
    since: string | null,
    extra: Partial<ProposalDeliveryState> = {},
  ): ProposalDeliveryState => ({ ...base, state, since, ...extra });
  const permitLive = permit !== null && Date.parse(permit.expires_at) > at;
  if (!send) return permitLive ? result("S1", permit.issued_at) : result("S0", null);

  // 6.1: a person's record about E settles what the PWA shows; it may be corrected while open.
  const person = await latestPersonRecord(env, tenantId, send.effect_id);
  if (person) {
    const open = await findingOpen(env, tenantId, proposalPackId, send);
    return result(person.received ? "4/9" : "3/9b", person.created_at, {
      record_allowed: open,
      not_delivered_allowed: open,
    });
  }

  // 6.2: nothing sent yet, still sending, never started, refused, or sent and not on the page.
  const lapsed = leaseLapsed(send, at);
  const permitAfterSend = permit !== null && Date.parse(permit.issued_at) > Date.parse(send.created_at);
  const notStarted = send.state === "proposed" || send.state === "authorized" || send.state === "retry";
  if (permitLive && permitAfterSend) return result("S1", permit.issued_at);
  if (notStarted && Date.parse(send.deadline_at) > at) return result("S2", send.created_at);
  // No path compensates a proposal send today; a compensation in flight reads as sending.
  if (((send.state === "executing" || send.state === "reconciling") && !lapsed) || send.state === "compensating") {
    return result("S2", send.created_at);
  }
  if (permit !== null && !permitLive && permitAfterSend) return result("S3", permit.expires_at);
  if (notStarted) return result("S3", send.deadline_at);
  // Not executed without a person's record (a reconcile of a failed attempt), or compensated.
  if (send.state === "reconciled" || send.state === "compensated") return result("S3", send.updated_at);
  if (send.state === "failed") return result("S4", send.updated_at);
  const endedAt = send.ended_at ?? (lapsed ? send.lease_expires_at : null) ?? send.updated_at;
  const fromProvider = !send.provider.startsWith("qa-synthetic-");
  if (send.state === "succeeded" && fromProvider && !(await livePublication(env, tenantId, proposalPackId, send.aggregate_version))) {
    return result("E1", endedAt);
  }
  if (send.state === "succeeded" && !fromProvider) return result("Q", endedAt);

  // 6.3: a lapsed lease reads as unknown with no check yet; it is checkable once the lease sweep
  // has recorded it as unknown.
  if (lapsed) return result("7", endedAt);
  const checks = await recentChecks(env, tenantId, send.effect_id);
  const room = checkRoom(checks, readbackAdapter(env, send.provider));
  // A check that found the message sent closes "didn't get it" on an unsettled send (0167).
  const found = foundByCheck(checks);
  const latest = checks[0] ?? null;
  const check = latest && {
    check_id: latest.check_id,
    outcome: latest.outcome,
    detail_code: latest.detail_code,
    created_at: latest.created_at,
  };

  if (send.state === "manual_exception") {
    const entered = await exceptionEntry(env, send.effect_id);
    // The provider answered (its readback conflicted, or it refused the send and a later check said
    // otherwise). "Didn't get it" needs a complete-scan "not found" made after that move (0167);
    // until P1 no check can scan completely.
    const conflict = PROVIDER_ANSWERED_ORIGINS.includes(entered?.from_state ?? "");
    const cited = conflict && !found
      ? checks.find((row) =>
        row.outcome === "not_found" && row.scan_complete === 1 &&
        Date.parse(row.created_at) > Date.parse(entered!.occurred_at))
      : undefined;
    // A manual exception that came straight from unknown keeps 0161's late-answer wait.
    const notBefore = entered?.from_state === "unknown" ? await lateAnswerNotBefore(env, send, endedAt, at) : null;
    return result("1", entered?.occurred_at ?? send.updated_at, {
      check,
      check_allowed: conflict && room,
      record_allowed: true,
      record_not_before: notBefore,
      not_delivered_allowed: !found && (!conflict || cited !== undefined),
      not_delivered_check_id: cited?.check_id ?? null,
    });
  }

  if (send.state === "unknown") {
    const recordable = {
      check,
      record_allowed: true,
      record_not_before: await lateAnswerNotBefore(env, send, endedAt, at),
      not_delivered_allowed: !found,
    };
    const escalation = await env.DB.prepare(
      `SELECT created_at FROM external_effect_exceptions
        WHERE effect_id = ? AND reason_code = ? AND status = 'open' LIMIT 1`,
    ).bind(send.effect_id, PROPOSAL_DELIVERY_STALE_REASON).first<{ created_at: string }>();
    if (escalation) {
      return result("7e", endedAt, { ...recordable, check_allowed: room, escalated_at: escalation.created_at });
    }
    if (latest?.outcome === "provider_unavailable") {
      return result("7c", earliestUnavailableSince(checks), { ...recordable, check_allowed: room });
    }
    if (latest?.outcome === "bounced") return result("1·b", latest.created_at, recordable);
    if (latest?.outcome === "sent") return result("8(a)", endedAt, { ...recordable, check_allowed: room });
    // `unknown`, and a complete-scan `not_found`: no adapter scans completely before P1, and from
    // B2 such a check settles the send instead. The person still records what they found.
    if (latest) return result("7·u", endedAt, { ...recordable, check_allowed: room });
    return result("7", endedAt, { check_allowed: room });
  }

  // Sent by a real provider and on the customer's page; a person records it as a 0161 finding.
  const open = await findingOpen(env, tenantId, proposalPackId, send);
  const findable = { check, record_allowed: open, not_delivered_allowed: open };
  if (latest?.outcome === "bounced") return result("1·b", latest.created_at, findable);
  return result("8(a)", endedAt, { ...findable, check_allowed: room });
}

/** When "didn't get it" opens on an unknown send: its attempt's end plus the window (0161). */
async function lateAnswerNotBefore(
  env: AppEnv,
  send: LatestSend,
  endedAt: string,
  at: number,
): Promise<string | null> {
  const opensAt = Date.parse(endedAt) + await proposalDeliveryLateAnswerWindowMs(env, send.provider);
  return opensAt > at ? new Date(opensAt).toISOString() : null;
}

/** F: the newest finding of the send (0161), else its first confirmation (0156), or null. */
async function latestPersonRecord(
  env: AppEnv,
  tenantId: string,
  effectId: string,
): Promise<{ received: boolean; created_at: string } | null> {
  const findings = await env.DB.prepare(
    `SELECT finding_id, supersedes_finding_id, finding, created_at FROM proposal_delivery_findings
      WHERE tenant_id = ? AND effect_id = ?`,
  ).bind(tenantId, effectId).all<{
    finding_id: string;
    supersedes_finding_id: string | null;
    finding: string;
    created_at: string;
  }>();
  const rows = findings.results ?? [];
  const superseded = new Set(rows.map((row) => row.supersedes_finding_id));
  const newest = rows.find((row) => !superseded.has(row.finding_id));
  if (newest) return { received: newest.finding === "delivered", created_at: newest.created_at };
  const confirmation = await env.DB.prepare(
    "SELECT outcome, created_at FROM proposal_delivery_confirmations WHERE tenant_id = ? AND effect_id = ?",
  ).bind(tenantId, effectId).first<{ outcome: string; created_at: string }>();
  return confirmation ? { received: confirmation.outcome === "delivered", created_at: confirmation.created_at } : null;
}

/**
 * Whether a person may still record a finding about this settled send (0161): its last attempt was
 * confirmed or unconfirmed, and neither a later send of the proposal nor the customer's decision on
 * it has closed the record.
 */
async function findingOpen(
  env: AppEnv,
  tenantId: string,
  proposalPackId: string,
  send: LatestSend,
): Promise<boolean> {
  if (send.state !== "succeeded" && send.state !== "reconciled") return false;
  if (send.attempt_state !== "succeeded" && send.attempt_state !== "unknown") return false;
  const closed = await env.DB.prepare(
    `SELECT EXISTS (
              SELECT 1 FROM external_effects later
               WHERE later.tenant_id = ? AND later.action = 'proposal.publish'
                 AND later.aggregate_type = 'proposal_publication' AND later.aggregate_id = ?
                 AND later.effect_id != ? AND julianday(later.created_at) >= julianday(?)
            ) OR EXISTS (
              SELECT 1 FROM customer_portal_acceptance_intents acceptance
               WHERE acceptance.tenant_id = ? AND acceptance.proposal_pack_id = ?
                 AND acceptance.state != 'rejected'
            ) AS closed`,
  ).bind(tenantId, proposalPackId, send.effect_id, send.created_at, tenantId, proposalPackId)
    .first<{ closed: number }>();
  return !closed?.closed;
}

/** Whether E's publication version is the pack's live publication. */
async function livePublication(
  env: AppEnv,
  tenantId: string,
  proposalPackId: string,
  version: number,
): Promise<boolean> {
  const live = await env.DB.prepare(
    `SELECT 1 AS live FROM commercial_proposal_publication_events current
      WHERE current.tenant_id = ? AND current.proposal_pack_id = ?
        AND current.publication_version = ? AND current.state = 'published'
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_publication_events successor
           WHERE successor.tenant_id = current.tenant_id
             AND successor.proposal_pack_id = current.proposal_pack_id
             AND successor.publication_version > current.publication_version
        )
      LIMIT 1`,
  ).bind(tenantId, proposalPackId, version).first<{ live: number }>();
  return live !== null;
}

/**
 * The `*\/5` sweep: a proposal send unknown for T since its attempt ended, with nobody's record
 * (an unknown send has none: a confirmation moves it, and a finding needs a settled send), opens one
 * owner-visible effect exception. It is keyed on the action alone, as 0164's evidence guard is: the
 * aggregate type is the claimer's own word, so a stuck publish claimed under another type is
 * escalated too, never skipped. A send is escalated once, ever: 0156 resolves an exception only
 * while no resolved one of the same reason exists, so a second one could never be resolved. A
 * person's 0156 record resolves it.
 */
export async function escalateStaleProposalDeliveries(
  env: AppEnv,
  now = new Date(),
  limit = 100,
): Promise<{ opened: number }> {
  const result = await env.DB.prepare(
    `INSERT INTO external_effect_exceptions
       (exception_id, effect_id, tenant_id, reason_code, status, created_at)
     SELECT 'effect-exception:' || lower(hex(randomblob(16))), effect.effect_id, effect.tenant_id, ?, 'open', ?
       FROM external_effects effect
       LEFT JOIN external_effect_attempts attempt
         ON attempt.effect_id = effect.effect_id AND attempt.attempt_number = effect.attempt_count
      WHERE effect.state = 'unknown' AND effect.action = 'proposal.publish'
        AND julianday(COALESCE(attempt.ended_at, effect.updated_at)) <= julianday(?)
        AND NOT EXISTS (
          SELECT 1 FROM external_effect_exceptions escalated
           WHERE escalated.effect_id = effect.effect_id AND escalated.reason_code = ?
        )
      ORDER BY effect.updated_at ASC LIMIT ?`,
  ).bind(
    PROPOSAL_DELIVERY_STALE_REASON, now.toISOString(),
    // Due once its attempt ended T ago or more: compared as one instant, so the bound is exact.
    new Date(now.getTime() - PROPOSAL_DELIVERY_ESCALATION_MS).toISOString(),
    PROPOSAL_DELIVERY_STALE_REASON, limit,
  ).run();
  return { opened: Number(result.meta?.changes ?? 0) };
}
