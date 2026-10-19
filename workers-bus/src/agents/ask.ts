// Ask IronWrap for people on their app session (api.ts; contract "Requests through the face"). An
// ask becomes an `owner_request` signal to the face (face.ts), read back only by the person who
// asked or by the owner. A press on a view's action becomes an `owner_request` to the action's
// owning specialist, whose own run proposes it for policy to decide: nothing here executes an
// action. A screen re-checks the facts it shows by version and hash, read as the viewer's role.
// Each person's asks and requests are limited, so one session cannot spend the team's ceilings.

import { sha256Hex } from "../app-auth.ts";
import { catalogAction, catalogSpecialist, type CatalogAction } from "./catalog.ts";
import { currentDelegation, humanGuard, specialistControl, specialistState, type HumanPrincipal } from "./control.ts";
import { ASK_SOURCE, ASK_UNANSWERED_MS, askerRole, FACE, REQUEST_SOURCE } from "./face.ts";
import { currentFacts } from "./memory.ts";
import { DEFAULT_CEILINGS, effectiveDelegation } from "./policy.ts";
import { OBJECT_MODELS } from "./read-models.ts";
import { receiptOf, type Receipt } from "./receipts.ts";
import { registryEntry } from "./registry.ts";
import { canonicalJson, validate, type JsonSchema } from "./schema.ts";
import { appendSignal, citedSources, type AgentDb, type RunRow, type SignalRow, type StepRow, type StoreError } from "./store.ts";
import { actionRequestKind } from "./view-spec.ts";

const INVALID: StoreError = { error: "invalid_body", status: 400 };

/** Asks, and requests, one person may make in the window; and asks of theirs that may wait at once. */
const PER_PERSON = { max: 20, windowMs: 10 * 60_000 };
const PENDING_ASKS = 5;

const OBJECT_REF = {
  type: "object",
  additionalProperties: false,
  required: ["aggregate", "id"],
  properties: {
    aggregate: { type: "string", pattern: "^[a-z][a-z_]{1,40}$" },
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" },
  },
};

const ASK_BODY: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["question", "context"],
  properties: {
    question: { type: "string", minLength: 1, maxLength: 2000 },
    // Where the person asked from: an app path and the object on screen, never free text.
    context: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["route", "object"],
      properties: {
        route: { type: "string", pattern: "^/[A-Za-z0-9._~:@/-]{0,199}$" },
        object: { ...OBJECT_REF, type: ["object", "null"] },
      },
    },
  },
};

const FACTS_BODY: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fact_ids"],
  properties: { fact_ids: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 160 } } },
};

const REQUEST_BODY: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action_id", "target", "ask_id"],
  properties: {
    action_id: { type: "string", maxLength: 128 },
    target: OBJECT_REF,
    ask_id: { type: ["string", "null"], pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" },
  },
};

type ObjectRef = { aggregate: string; id: string };

/** Records a person's question for the face; the question is untrusted text, the rest is the Worker's. */
export async function postAsk(
  db: AgentDb,
  tenantId: string,
  actor: HumanPrincipal,
  body: unknown,
  idempotencyKey: string,
  now: string,
): Promise<{ ask_id: string } | Limited> {
  if (validate(ASK_BODY, body).length > 0) return INVALID;
  const { question, context } = body as { question: string; context: { route: string; object: ObjectRef | null } | null };
  const asked = { question: question.trim(), context };
  if (!asked.question) return INVALID;
  const signal = await appendPersonSignal(
    db,
    tenantId,
    actor,
    {
      kind: "owner_request",
      specialist_id: FACE,
      // The face's watch for the owner, or for anyone else, the crew phone included.
      watch_id: actor.role === "owner" ? "owner_requests" : "role_questions",
      source: `${ASK_SOURCE}${actor.user_id}`,
      subject: context?.object ?? null,
      content: { ...asked, asker_role: actor.role },
      dedupe_key: `${ASK_SOURCE}${actor.user_id}:${await sha256Hex(idempotencyKey)}`,
    },
    asked,
    now,
    true,
  );
  return "error" in signal ? signal : { ask_id: signal.signal_id };
}

/** The delegation an action shows, by the names of design/system-v2/TEMPLATES.md 5.2. */
export type DelegationShown =
  | "reads"
  | "prepares"
  | "within_limits"
  | "asks_first"
  | "people_only"
  | "paused"
  | "off_until_enabled"
  | "always_on"
  | "always_asks_first";

type AnswerSource = { fact_id: string; version: number; hash: string };

export interface AskView {
  ask_id: string;
  status: "pending" | "done" | "abstained";
  run_id: string | null;
  answer: { text: string; sources: AnswerSource[] } | null;
  view: unknown;
  receipt: Receipt | null;
  actions: Array<{ action_id: string; delegation: DelegationShown }>;
  /** Why an ask reads abstained without the face's say: no run answered it in time, or it was cancelled. */
  reason: "not_answered" | "cancelled" | null;
}

/**
 * An ask as the face's run left it: pending while no run of it has closed; done when the run
 * completed, with the answer and its sources from the answer receipt, the checked view and that
 * receipt; otherwise abstained, with the close's abstention receipt, which asks nothing of the
 * asker (`needs_from_you` is null). An ask
 * no run answered in time reads abstained with `reason` not_answered and no receipt. Null when the
 * person may not read the ask.
 */
export async function readAsk(db: AgentDb, tenantId: string, actor: HumanPrincipal, askId: string, now: string): Promise<AskView | null> {
  const signal = await askFor(db, tenantId, actor, askId);
  if (!signal) return null;
  const runs = await db
    .prepare("SELECT * FROM agent_runs WHERE tenant_id = ? AND signal_id = ? ORDER BY started_at DESC, run_id DESC")
    .bind(tenantId, askId)
    .all<RunRow>();
  const run = runs.results.find((row) => row.state === "closed") ?? runs.results[0] ?? null;
  if (!run || run.state !== "closed") {
    // Decided at read time and never written: no run took the ask up in time, or its run outlived
    // the run lifetime, after which it can neither resume nor take a step. A late close still shows.
    const stale = run
      ? Date.parse(now) - Date.parse(run.started_at) > DEFAULT_CEILINGS.wallTimeMs
      : Date.parse(now) - Date.parse(signal.received_at) > ASK_UNANSWERED_MS;
    return {
      ask_id: askId,
      status: stale ? "abstained" : "pending",
      run_id: run?.run_id ?? null,
      answer: null,
      view: null,
      receipt: null,
      actions: [],
      reason: stale ? "not_answered" : null,
    };
  }
  const close = JSON.parse(run.close_json ?? "null") as { status?: unknown; reason?: unknown; output?: { final_text?: unknown; view?: unknown } | null } | null;
  // A run the Worker closed at its wall-time ceiling (store.ts expireRun) never answered: the ask
  // reads as it did while that run stood open past its lifetime.
  if (close?.status === "abstained" && close.reason === "run_expired")
    return { ask_id: askId, status: "abstained", run_id: run.run_id, answer: null, view: null, receipt: null, actions: [], reason: "not_answered" };
  const done = run.result === "completed";
  const output = close?.status === "ok" ? (close.output ?? null) : null;
  // Only a completed ask shows its view; the answer receipt holds every fact the answer and view cite.
  const view = done ? (output?.view ?? null) : null;
  const receipt = await closeReceipt(db, run);
  const sources = done && receipt ? (receipt.sources as AnswerSource[]) : await citedSources(db, run.run_id);
  return {
    ask_id: askId,
    status: done ? "done" : "abstained",
    run_id: run.run_id,
    answer: typeof output?.final_text === "string" ? { text: output.final_text, sources } : null,
    view,
    // A close that names a person (an emergency, a safety event, suspected injection) reaches that
    // person through their Needs you; the asker is not the one who must act, so the ask never says.
    receipt: receipt && { ...receipt, needs_from_you: null },
    actions: view ? await viewActions(db, tenantId, view, actor.role) : [],
    reason: run.result === "cancelled" ? "cancelled" : null,
  };
}

/**
 * The current version and hash of each fact as this person's role reads it now; never a value. An
 * ask's own question (`signal/<ask_id>`) reads for its asker and the owner; no other signal does.
 */
export async function readCurrentFacts(db: AgentDb, tenantId: string, actor: HumanPrincipal, body: unknown, now: string) {
  if (validate(FACTS_BODY, body).length > 0) return INVALID;
  const factIds = [...new Set((body as { fact_ids: string[] }).fact_ids)];
  const objects = await currentFacts(db, OBJECT_MODELS, tenantId, { role: actor.role }, factIds.filter((id) => !id.startsWith("signal/")), now);
  const current = new Map(objects.facts.map((fact) => [fact.fact_id, fact]));
  const facts: AnswerSource[] = [];
  const unreadable: string[] = [];
  for (const factId of factIds) {
    const fact = factId.startsWith("signal/") ? await askFact(db, tenantId, actor, factId.slice("signal/".length)) : (current.get(factId) ?? null);
    if (fact) facts.push(fact);
    else unreadable.push(factId);
  }
  return { facts, unreadable };
}

/** An ask's question as its run read it: the immutable signal, version 1, by its content hash. */
async function askFact(db: AgentDb, tenantId: string, actor: HumanPrincipal, askId: string): Promise<AnswerSource | null> {
  const signal = await askFor(db, tenantId, actor, askId);
  return signal ? { fact_id: `signal/${askId}`, version: 1, hash: `sha256:${signal.content_sha256}` } : null;
}

/**
 * A press on a view's action: an `owner_request` to the owning specialist with the expected action
 * and the bound target. Its run proposes the action and policy decides; an action that asks first
 * lands on Decisions. Refused: an action outside the catalog, owned by no specialist, people only,
 * one a view may not offer, or one the person's role may not request.
 */
export async function postRequest(
  db: AgentDb,
  tenantId: string,
  actor: HumanPrincipal,
  body: unknown,
  idempotencyKey: string,
  now: string,
): Promise<{ signal_id: string } | Limited> {
  if (validate(REQUEST_BODY, body).length > 0) return INVALID;
  const request = body as { action_id: string; target: ObjectRef; ask_id: string | null };
  const action = catalogAction(request.action_id);
  if (!action) return { error: "unknown_action", status: 422 };
  if (action.owners.length === 0) return { error: "unowned_action", status: 422 };
  if (action.autonomy === "H" || action.human_only) return { error: "people_only", status: 422 };
  // A read, a run-only step, the AI team's own controls, or an A1/A2 effect outside the company.
  if (actionRequestKind(action) === null) return { error: "not_requestable", status: 422 };
  const specialist = requestOwner(action, actor.role);
  if (!specialist) return { error: "role_may_not_request", status: 403 };
  if (request.ask_id !== null && !(await askFor(db, tenantId, actor, request.ask_id))) return { error: "ask_not_found", status: 404 };
  const requested = { expected_action_id: action.action_id, target: request.target, ask_id: request.ask_id };
  return await appendPersonSignal(
    db,
    tenantId,
    actor,
    {
      kind: "owner_request",
      specialist_id: specialist,
      watch_id: null,
      source: `${REQUEST_SOURCE}${actor.user_id}`,
      subject: request.target,
      content: { ...requested, requester_role: actor.role },
      dedupe_key: `${REQUEST_SOURCE}${actor.user_id}:${await sha256Hex(idempotencyKey)}`,
    },
    requested,
    now,
    false,
  );
}

/**
 * The specialist a person's request goes to, or null when their role may not request the action:
 * the owner may request any owned action; anyone else an action of a specialist their role reviews,
 * or one they are the action's own reviewer for. With several owners, the first in catalog order.
 */
export function requestOwner(action: CatalogAction, role: string): string | null {
  if (role === "owner") return action.owners[0] ?? null;
  const reviewed = action.owners.find((owner) => catalogSpecialist(owner)?.reviewer_role === role);
  return reviewed ?? (action.reviewer_role === role ? (action.owners[0] ?? null) : null);
}

/** A refusal a person may retry later, with the seconds to wait (Retry-After). */
export type Limited = StoreError & { retryAfterSeconds?: number };

/**
 * Appends a person's signal inside a re-read of their live session, once per idempotency key: a
 * replay of the same request returns the same signal, before any limit; another request under that
 * key conflicts. A new one is admitted only within the person's limits, which the insert itself
 * checks, so simultaneous requests cannot share a last slot; past them it waits (429).
 */
async function appendPersonSignal(
  db: AgentDb,
  tenantId: string,
  actor: HumanPrincipal,
  input: Parameters<typeof appendSignal>[2],
  request: Record<string, unknown>,
  now: string,
  ask: boolean,
): Promise<{ signal_id: string } | Limited> {
  const prior = await replayOf(db, tenantId, input.dedupe_key, request);
  if (prior) return prior;
  const limits = personLimits(tenantId, ask ? ASK_SOURCE : REQUEST_SOURCE, actor.user_id, now, ask);
  let appended: Awaited<ReturnType<typeof appendSignal>>;
  try {
    appended = await appendSignal(db, tenantId, input, now, [humanGuard(db, tenantId, actor, now, false)], limits.admission);
  } catch (error) {
    if (String(error).includes("agent_control_authority")) return { error: "session_authority_changed", status: 403 };
    throw error;
  }
  if ("error" in appended) return appended.error === "signal_not_admitted" ? await refusal(db, limits, now) : appended;
  if (appended.created) return appended;
  // Another request under the same key won the insert.
  return (await replayOf(db, tenantId, input.dedupe_key, request)) ?? { error: "signal_unavailable", status: 503 };
}

/** The signal already recorded under this key: the same request's, or a conflict. Null when there is none. */
async function replayOf(db: AgentDb, tenantId: string, dedupeKey: string, request: Record<string, unknown>): Promise<{ signal_id: string } | StoreError | null> {
  const prior = await db
    .prepare("SELECT signal_id, content_json FROM agent_signals WHERE tenant_id = ? AND dedupe_key = ?")
    .bind(tenantId, dedupeKey)
    .first<{ signal_id: string; content_json: string }>();
  if (!prior) return null;
  const content = JSON.parse(prior.content_json) as Record<string, unknown> | null;
  const same = content !== null && Object.keys(request).every((key) => canonicalJson(content[key]) === canonicalJson(request[key]));
  return same ? { signal_id: prior.signal_id } : { error: "idempotency_conflict", status: 409 };
}

type Selection = { from: string; values: unknown[] };

/**
 * A person's limits as SQL the signal insert checks itself: 20 of their asks (or requests) in any
 * ten minutes, found by their dedupe keys (`ask:<user_id>:…`, `request:<user_id>:…`), and, for an
 * ask, 5 of theirs that still read pending as `readAsk` decides it. Only asks of the last 25
 * minutes can be pending: a run starts within 15 minutes of its ask (`openRun`) and lives 10.
 */
function personLimits(tenantId: string, source: string, userId: string, now: string, ask: boolean) {
  const [from, to] = [`${source}${userId}:`, `${source}${userId};`];
  const since = (ms: number) => new Date(Date.parse(now) - ms).toISOString();
  const recent: Selection = {
    from: "agent_signals WHERE tenant_id = ? AND dedupe_key >= ? AND dedupe_key < ? AND received_at > ?",
    values: [tenantId, from, to, since(PER_PERSON.windowMs)],
  };
  const waiting: Selection | null = ask
    ? {
        from: `agent_signals s WHERE s.tenant_id = ? AND s.dedupe_key >= ? AND s.dedupe_key < ? AND s.received_at >= ?
          AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.tenant_id = s.tenant_id AND r.signal_id = s.signal_id AND r.state = 'closed')
          AND (EXISTS (SELECT 1 FROM agent_runs r WHERE r.tenant_id = s.tenant_id AND r.signal_id = s.signal_id AND r.state = 'open' AND r.started_at >= ?)
            OR (s.received_at >= ? AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.tenant_id = s.tenant_id AND r.signal_id = s.signal_id)))`,
        values: [tenantId, from, to, since(ASK_UNANSWERED_MS + DEFAULT_CEILINGS.wallTimeMs), since(DEFAULT_CEILINGS.wallTimeMs), since(ASK_UNANSWERED_MS)],
      }
    : null;
  return {
    recent,
    waiting,
    admission: {
      where: `(SELECT COUNT(*) FROM ${recent.from}) < ?${waiting ? ` AND (SELECT COUNT(*) FROM ${waiting.from}) < ?` : ""}`,
      values: [...recent.values, PER_PERSON.max, ...(waiting ? [...waiting.values, PENDING_ASKS] : [])],
    },
  };
}

/** Which limit turned the signal away, and the seconds until a slot frees: the window's oldest leaves, or a pending ask stops counting. */
async function refusal(db: AgentDb, limits: ReturnType<typeof personLimits>, now: string): Promise<Limited> {
  const wait = (at: number) => Math.max(1, Math.ceil((at - Date.parse(now)) / 1000));
  const recent = await db
    .prepare(`SELECT COUNT(*) AS n, MIN(received_at) AS oldest FROM ${limits.recent.from}`)
    .bind(...limits.recent.values)
    .first<{ n: number; oldest: string | null }>();
  const rate: Limited | null =
    Number(recent?.n ?? 0) >= PER_PERSON.max || !limits.waiting
      ? { error: "rate_limited", status: 429, retryAfterSeconds: wait(recent?.oldest ? Date.parse(recent.oldest) + PER_PERSON.windowMs : 0) }
      : null;
  if (!limits.waiting) return rate as Limited;
  const waiting = await db
    .prepare(
      `SELECT s.received_at, (SELECT MAX(r.started_at) FROM agent_runs r WHERE r.tenant_id = s.tenant_id AND r.signal_id = s.signal_id AND r.state = 'open') AS started_at
         FROM ${limits.waiting.from}`,
    )
    .bind(...limits.waiting.values)
    .all<{ received_at: string; started_at: string | null }>();
  const frees = waiting.results.map((ask) =>
    ask.started_at ? Date.parse(ask.started_at) + DEFAULT_CEILINGS.wallTimeMs : Date.parse(ask.received_at) + ASK_UNANSWERED_MS,
  );
  const pending: Limited | null = frees.length >= PENDING_ASKS ? { error: "too_many_pending_asks", status: 429, retryAfterSeconds: wait(Math.min(...frees)) } : null;
  // Both full: a slot is free only once both are, so the longer wait stands.
  if (rate && pending) return (rate.retryAfterSeconds ?? 0) >= (pending.retryAfterSeconds ?? 0) ? rate : pending;
  return rate ?? pending ?? { error: "too_many_pending_asks", status: 429, retryAfterSeconds: 1 };
}

/** The ask, when this person may read it: the person who asked, or the owner. */
async function askFor(db: AgentDb, tenantId: string, actor: HumanPrincipal, askId: string): Promise<SignalRow | null> {
  const signal = await db.prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?").bind(tenantId, askId).first<SignalRow>();
  if (!signal || askerRole(signal) === null) return null;
  return signal.source === `${ASK_SOURCE}${actor.user_id}` || actor.role === "owner" ? signal : null;
}

/**
 * The face run's close receipt: a completed run's answer receipt; otherwise the close's own
 * abstention receipt, or, for a run closed before asks had one, the escalation the close relied on.
 */
async function closeReceipt(db: AgentDb, run: RunRow): Promise<Receipt | null> {
  const step =
    run.result === "completed"
      ? await db.prepare("SELECT * FROM agent_run_steps WHERE run_id = ? AND step_key = ?").bind(run.run_id, `answer:${run.run_id}`).first<StepRow>()
      : await db
          .prepare(
            `SELECT * FROM agent_run_steps WHERE run_id = ?
               AND (step_key = ? OR (action_id = 'exception.escalate' AND needs_reviewer_role IS NOT NULL))
             ORDER BY step_key = ? DESC, step_seq DESC LIMIT 1`,
          )
          .bind(run.run_id, `abstention:${run.run_id}`, `abstention:${run.run_id}`)
          .first<StepRow>();
  return step ? receiptOf(step) : null;
}

/** Each action a view offers, with the delegation the Worker holds for the specialist a press would reach. */
async function viewActions(db: AgentDb, tenantId: string, view: unknown, role: string): Promise<AskView["actions"]> {
  const offered = (view as { actions?: Array<{ action_id: string }> }).actions ?? [];
  const actions: AskView["actions"] = [];
  for (const actionId of new Set(offered.map((action) => action.action_id))) {
    // A recorded view passed the validator, so every action it offers is in the catalog.
    const action = catalogAction(actionId);
    const specialist = action ? (requestOwner(action, role) ?? action.owners[0]) : undefined;
    if (action) actions.push({ action_id: actionId, delegation: specialist ? await delegationFor(db, tenantId, action, specialist) : "people_only" });
  }
  return actions;
}

const OUTSIDE_EFFECTS = new Set(["money", "legal", "safety", "external_irreversible", "external_reversible"]);

/**
 * The Worker's current delegation of an action for one owning specialist, never the model's
 * (TEMPLATES.md 5.2): people only; always on for a protective action; paused; asks first while the
 * AI auditor holds the specialist (always asks first when not delegable); then by class and the
 * owner's setting in force. Within limits shows only where the machine path is proven and the
 * effect stays inside the company (the proof-first and launch rules).
 */
async function delegationFor(db: AgentDb, tenantId: string, action: CatalogAction, specialistId: string): Promise<DelegationShown> {
  if (action.human_only || action.autonomy === "H") return "people_only";
  if (action.protective) return "always_on";
  const control = await specialistControl(db, tenantId, specialistId);
  if (control.paused) return "paused";
  if (control.held) return action.delegable ? "asks_first" : "always_asks_first";
  if (action.autonomy === "A0") return "reads";
  if (action.autonomy === "A1") return "prepares";
  const delegation = await currentDelegation(db, tenantId, specialistId, action.action_id);
  const setting = effectiveDelegation(action, { delegation, specialistState: specialistState(control) });
  if (setting === "off") return "off_until_enabled";
  if (!action.delegable) return "always_asks_first";
  const proven = registryEntry(action.action_id)?.machinePermitProven === true;
  return setting === "within_limits" && proven && !OUTSIDE_EFFECTS.has(action.side_effect_class) ? "within_limits" : "asks_first";
}
