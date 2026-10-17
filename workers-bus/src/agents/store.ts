// D1 persistence for the AI team: signals, coordination runs, steps (the receipts) and host
// heartbeats. Every write goes through a deterministic decision made here or in policy.ts; the
// agent host only transports proposals.

import { sha256Hex } from "../app-auth.ts";
import { CATALOG, CATALOG_VERSION, catalogAction, catalogSpecialist, toolName } from "./catalog.ts";
import { DEFAULT_CEILINGS, evaluateStep, STEP_POLICY_ID, STEP_POLICY_VERSION, type Citation, type PolicyDecision, type SnapshotFact } from "./policy.ts";
import { registryEntry } from "./registry.ts";
import { canonicalJson, validate, type JsonSchema } from "./schema.ts";

export interface BoundStatement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface AgentDb {
  prepare(sql: string): { bind(...values: unknown[]): BoundStatement };
  /** D1 runs a batch as one transaction: all statements commit or none do. */
  batch(statements: BoundStatement[]): Promise<unknown[]>;
}

/**
 * Rows changed by a D1 run result. D1 reports a `total_changes()` delta, which includes rows the
 * event triggers write, so callers test for zero versus at least one, never for exactly one (see
 * effect-runtime.ts, ELEC-75). Every guarded write here is a compare-and-set, so zero means it lost.
 */
export function changesOf(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);
}

export interface SignalRow {
  signal_seq: number;
  signal_id: string;
  tenant_id: string;
  kind: "event" | "watch" | "owner_request" | "handoff";
  specialist_id: string;
  watch_id: string | null;
  source: string;
  subject_aggregate: string | null;
  subject_id: string | null;
  content_json: string;
  content_sha256: string;
  dedupe_key: string;
  parent_run_id: string | null;
  handoff_depth: number;
  received_at: string;
}

export interface RunRow {
  run_id: string;
  tenant_id: string;
  specialist_id: string;
  signal_id: string;
  host_run_key: string;
  goal: string;
  context_json: string;
  context_snapshot_hash: string;
  tool_manifest_json: string;
  state: "open" | "closed";
  result: string | null;
  attempt: number;
  attempt_started_at: string;
  started_at: string;
  correlation_id: string;
}

export interface StepRow {
  step_id: string;
  run_id: string;
  step_seq: number;
  step_key: string;
  specialist_id: string;
  action_id: string;
  autonomy: string | null;
  args_json: string;
  args_sha256: string;
  sources_json: string;
  policy_json: string;
  permit_json: string;
  tool_json: string | null;
  readback_json: string | null;
  outcome: string | null;
  reason_code: string | null;
  needs_reviewer_role: string | null;
  needs_person_id: string | null;
  needs_ask: string | null;
  undo_json: string;
  do_it_myself_json: string;
  created_at: string;
  decided_at: string | null;
  version: number;
}

export interface ContextFact extends SnapshotFact {
  kind: string;
  observed_at: string;
  data: unknown;
}

export interface RunTool {
  action_id: string;
  tool_name: string;
  autonomy: string;
  side_effect_class: string;
  undo: string;
  description: string;
  args_schema: JsonSchema;
}

export type StoreError = { error: string; status: number };

const SIGNAL_KINDS = new Set(["event", "watch", "owner_request", "handoff"]);

export async function appendSignal(
  db: AgentDb,
  tenantId: string,
  input: {
    kind: SignalRow["kind"];
    specialist_id: string;
    watch_id: string | null;
    source: string;
    subject: { aggregate: string; id: string } | null;
    content: unknown;
    dedupe_key: string;
    parent_run_id?: string | null;
    handoff_depth?: number;
  },
  now: string,
): Promise<{ signal_id: string; created: boolean } | StoreError> {
  if (!SIGNAL_KINDS.has(input.kind)) return { error: "invalid_signal_kind", status: 422 };
  if (!catalogSpecialist(input.specialist_id)) return { error: "unknown_specialist", status: 422 };
  const existing = await db
    .prepare("SELECT signal_id FROM agent_signals WHERE tenant_id = ? AND dedupe_key = ?")
    .bind(tenantId, input.dedupe_key)
    .first<{ signal_id: string }>();
  if (existing) return { signal_id: existing.signal_id, created: false };
  const contentJson = canonicalJson(input.content ?? null);
  const signalId = `sig_${crypto.randomUUID()}`;
  const inserted = await db
    .prepare(
      `INSERT INTO agent_signals (signal_id, tenant_id, kind, specialist_id, watch_id, source,
        subject_aggregate, subject_id, content_json, content_sha256, dedupe_key, parent_run_id,
        handoff_depth, received_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM agent_signals WHERE tenant_id = ? AND dedupe_key = ?)`,
    )
    .bind(
      signalId,
      tenantId,
      input.kind,
      input.specialist_id,
      input.watch_id,
      input.source,
      input.subject?.aggregate ?? null,
      input.subject?.id ?? null,
      contentJson,
      await sha256Hex(contentJson),
      input.dedupe_key,
      input.parent_run_id ?? null,
      input.handoff_depth ?? 0,
      now,
      tenantId,
      input.dedupe_key,
    )
    .run();
  if (changesOf(inserted) > 0) return { signal_id: signalId, created: true };
  const winner = await db.prepare("SELECT signal_id FROM agent_signals WHERE tenant_id = ? AND dedupe_key = ?")
    .bind(tenantId, input.dedupe_key).first<{signal_id: string}>();
  return winner ? {signal_id: winner.signal_id, created: false} : {error: "signal_unavailable", status: 503};
}

export async function listSignals(db: AgentDb, tenantId: string, after: number, limit: number) {
  const rows = await db
    .prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_seq > ? ORDER BY signal_seq LIMIT ?")
    .bind(tenantId, after, limit)
    .all<SignalRow>();
  const signals = rows.results.map(signalView);
  const last = rows.results.at(-1);
  return { signals, next_cursor: last ? String(last.signal_seq) : after > 0 ? String(after) : null };
}

function signalView(row: SignalRow) {
  return {
    signal_id: row.signal_id,
    kind: row.kind,
    specialist_id: row.specialist_id,
    watch_id: row.watch_id,
    source: row.source,
    subject: row.subject_aggregate && row.subject_id ? { aggregate: row.subject_aggregate, id: row.subject_id } : null,
    content: JSON.parse(row.content_json),
    received_at: row.received_at,
  };
}

/** The tools a specialist's run may call: owned, not people-only, with registered arguments. */
export function toolsFor(specialistId: string): RunTool[] {
  const tools: RunTool[] = [];
  for (const action of catalogActionsOwnedBy(specialistId)) {
    const entry = registryEntry(action.action_id);
    if (!entry || action.autonomy === "H" || action.human_only) continue;
    tools.push({
      action_id: action.action_id,
      tool_name: toolName(action.action_id),
      autonomy: action.autonomy,
      side_effect_class: action.side_effect_class,
      undo: action.undo,
      description: `${action.action_id} on ${action.aggregate}${action.protective ? " (protective)" : ""}.`,
      args_schema: entry.args,
    });
  }
  return tools;
}

function catalogActionsOwnedBy(specialistId: string) {
  return CATALOG.actions.filter((action) => action.owners.includes(specialistId));
}

export async function openRun(
  db: AgentDb,
  tenantId: string,
  input: { signal_id: string; specialist_id: string; host_run_key: string },
  now: string,
): Promise<{ run: RunRow; resumed: boolean } | StoreError> {
  const existing = await runByKey(db, tenantId, input.host_run_key);
  if (existing) return await resumeRun(db, existing, input, now);
  const signal = await db
    .prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?")
    .bind(tenantId, input.signal_id)
    .first<SignalRow>();
  if (!signal) return { error: "signal_not_found", status: 422 };
  if (signal.specialist_id !== input.specialist_id) return { error: "specialist_mismatch", status: 422 };

  const facts = [signalFact(signal)];
  const snapshotHash = await sha256Hex(canonicalJson(facts.map(({ fact_id, version, hash }) => ({ fact_id, version, hash }))));
  const tools = toolsFor(signal.specialist_id);
  const manifestHash = await sha256Hex(canonicalJson(tools));
  const run: RunRow = {
    run_id: `run_${crypto.randomUUID()}`,
    tenant_id: tenantId,
    specialist_id: signal.specialist_id,
    signal_id: signal.signal_id,
    host_run_key: input.host_run_key,
    goal: goalFor(signal),
    context_json: canonicalJson({ snapshot_hash: snapshotHash, facts }),
    context_snapshot_hash: snapshotHash,
    tool_manifest_json: canonicalJson(tools),
    state: "open",
    result: null,
    attempt: 1,
    attempt_started_at: now,
    started_at: now,
    correlation_id: signal.parent_run_id ?? signal.signal_id,
  };
  const inserted = await db
    .prepare(
      `INSERT INTO agent_runs (run_id, tenant_id, specialist_id, signal_id, host_run_key, goal,
        trigger_json, context_json, context_snapshot_hash, tool_manifest_json, tool_manifest_hash,
        catalog_version, policy_version, parent_run_id, correlation_id, state, attempt,
        attempt_started_at, started_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE tenant_id = ? AND host_run_key = ?)`,
    )
    .bind(
      run.run_id,
      tenantId,
      run.specialist_id,
      run.signal_id,
      run.host_run_key,
      run.goal,
      canonicalJson({ kind: signal.kind, watch_id: signal.watch_id, source: signal.source, signal_id: signal.signal_id }),
      run.context_json,
      snapshotHash,
      run.tool_manifest_json,
      manifestHash,
      CATALOG_VERSION,
      `${STEP_POLICY_ID}@${STEP_POLICY_VERSION}`,
      signal.parent_run_id,
      run.correlation_id,
      now,
      now,
      tenantId,
      input.host_run_key,
    )
    .run();
  if (changesOf(inserted) >= 1) return { run, resumed: false };
  // Another open for the same key won the insert: that run is the one, so resume it.
  const winner = await runByKey(db, tenantId, input.host_run_key);
  if (!winner) return { error: "run_unavailable", status: 503 };
  return await resumeRun(db, winner, input, now);
}

async function runByKey(db: AgentDb, tenantId: string, hostRunKey: string): Promise<RunRow | null> {
  return await db.prepare("SELECT * FROM agent_runs WHERE tenant_id = ? AND host_run_key = ?").bind(tenantId, hostRunKey).first<RunRow>();
}

/** A host that stopped mid-run re-delivers the signal; the still-open run resumes where it was. */
async function resumeRun(
  db: AgentDb,
  existing: RunRow,
  input: { signal_id: string; specialist_id: string },
  now: string,
): Promise<{ run: RunRow; resumed: boolean } | StoreError> {
  if (existing.signal_id !== input.signal_id || existing.specialist_id !== input.specialist_id) {
    return { error: "run_key_conflict", status: 422 };
  }
  if (existing.state === "closed") return { error: "run_closed", status: 409 };
  if (Date.parse(now) - Date.parse(existing.started_at) > DEFAULT_CEILINGS.wallTimeMs)
    return {error: "run_expired", status: 409};
  const resumed = await db
    .prepare("UPDATE agent_runs SET attempt = attempt + 1, attempt_started_at = ?, version = version + 1 WHERE run_id = ? AND state = 'open'")
    .bind(now, existing.run_id)
    .run();
  if (changesOf(resumed) < 1) return { error: "run_closed", status: 409 };
  return { run: { ...existing, attempt: existing.attempt + 1, attempt_started_at: now }, resumed: true };
}

export async function getRun(db: AgentDb, tenantId: string, runId: string): Promise<RunRow | null> {
  return await db.prepare("SELECT * FROM agent_runs WHERE tenant_id = ? AND run_id = ?").bind(tenantId, runId).first<RunRow>();
}

export function runContext(run: RunRow): { snapshot_hash: string; facts: ContextFact[] } {
  return JSON.parse(run.context_json);
}

export function runTools(run: RunRow): RunTool[] {
  return JSON.parse(run.tool_manifest_json);
}

/** The signal itself is the first fact of every run: immutable, and untrusted as text. */
function signalFact(signal: SignalRow): ContextFact {
  return {
    fact_id: `signal/${signal.signal_id}`,
    kind: "signal",
    version: 1,
    hash: `sha256:${signal.content_sha256}`,
    trust: "untrusted_text",
    observed_at: signal.received_at,
    fresh_until: null,
    data: JSON.parse(signal.content_json),
  };
}

function goalFor(signal: SignalRow): string {
  const subject = signal.subject_aggregate ? ` about ${signal.subject_aggregate}/${signal.subject_id}` : "";
  const origin = signal.kind === "watch" ? `watch ${signal.watch_id}` : `${signal.kind.replace("_", " ")} from ${signal.source}`;
  return `Act on the ${origin}${subject} (signal ${signal.signal_id}).`;
}

export interface ProposeInput {
  action_id: string;
  args: unknown;
  citations: Citation[];
  step_key: string;
}

/**
 * Records one proposed step with its policy decision. A repeated step_key returns the step it
 * named, and only for the same proposal; concurrent proposals each get their own sequence number.
 */
export async function proposeStep(db: AgentDb, tenantId: string, run: RunRow, input: ProposeInput, nowMs: number): Promise<StepRow | StoreError> {
  const argsJson = canonicalJson(input.args ?? null);
  const argsSha = await sha256Hex(argsJson);
  const prior = await stepByKey(db, run.run_id, input.step_key);
  if (prior) return await replayStep(db, tenantId, run, prior, input, argsSha);
  const count = await db
    .prepare("SELECT COUNT(*) AS steps FROM agent_run_steps WHERE run_id = ?")
    .bind(run.run_id)
    .first<{ steps: number }>();
  const context = runContext(run);
  const snapshot = new Map(context.facts.map((fact) => [fact.fact_id, fact]));
  // Facts in the snapshot are signals (immutable) until the shared-memory read models land; a
  // cited fact this Worker cannot read again is unverifiable, never assumed current.
  const currentVersions = new Map(
    input.citations.map((citation) => [citation.fact_id, snapshot.get(citation.fact_id)?.kind === "signal" ? 1 : null] as const),
  );
  let handoff: { depth: number; samePair: number } | null = null;
  if (input.action_id === "handoff.create") handoff = await handoffLimits(db, tenantId, run, input.args);

  const decision = evaluateStep({
    specialistId: run.specialist_id,
    specialistState: "active",
    actionId: input.action_id,
    args: input.args,
    citations: input.citations,
    snapshot,
    currentVersions,
    delegation: null,
    stepsOnRun: Number(count?.steps ?? 0),
    runStartedAt: Date.parse(run.started_at),
    now: nowMs,
    handoff,
  });
  const now = new Date(nowMs).toISOString();
  const person = decision.reviewer_role ? await namedPerson(db, tenantId, decision.reviewer_role) : null;
  try {
    // An admitted step counts against the run's step ceiling inside the insert itself, so parallel
    // proposals cannot jointly pass it; a step that loses that race is recorded as abstained.
    const ceiling = decision.result === "deny" ? null : DEFAULT_CEILINGS.stepsPerRun;
    const stepId = `step_${crypto.randomUUID()}`;
    const insert = stepInsert(db, tenantId, run, input, argsJson, argsSha, decision, person, now, ceiling, stepId);
    if (input.action_id === "handoff.create" && decision.outcome === "succeeded") {
      // The count reservation, receipt and canonical signal commit together. A failed delivery
      // rolls back the receipt and its audit event; an exact retry can start the same proposal.
      await db.batch([insert, await handoffSignalInsert(db, tenantId, run, input.args as HandoffArgs,
        input.step_key, handoff!.depth, now, stepId)]);
    } else await insert.run();
    if (ceiling !== null && !(await stepByKey(db, run.run_id, input.step_key))) {
      const reviewer = catalogSpecialist(run.specialist_id)?.reviewer_role ?? "owner";
      const capped: PolicyDecision = {
        ...decision,
        result: "deny",
        outcome: "abstained",
        reason_codes: ["ceiling_reached"],
        checks: [...decision.checks, { check: "budget", passed: false }],
        permit_kind: "none",
        delegation_id: null,
        reviewer_role: reviewer,
      };
      await stepInsert(db, tenantId, run, input, argsJson, argsSha, capped, await namedPerson(db, tenantId, reviewer), now, null).run();
    }
  } catch (error) {
    if (String(error).includes("agent_run_closed")) return { error: "run_closed", status: 409 };
    throw error;
  }
  const step = await stepByKey(db, run.run_id, input.step_key);
  if (!step) return { error: "step_unavailable", status: 503 };
  return await replayStep(db, tenantId, run, step, input, argsSha);
}

async function stepByKey(db: AgentDb, runId: string, stepKey: string): Promise<StepRow | null> {
  return await db.prepare("SELECT * FROM agent_run_steps WHERE run_id = ? AND step_key = ?").bind(runId, stepKey).first<StepRow>();
}

async function replayStep(db: AgentDb, tenantId: string, run: RunRow, prior: StepRow, input: ProposeInput, argsSha: string): Promise<StepRow | StoreError> {
  const sameCitations = canonicalJson(JSON.parse(prior.sources_json).map((source: Citation) => ({ fact_id: source.fact_id, version: source.version }))) ===
    canonicalJson(input.citations.map((citation) => ({ fact_id: citation.fact_id, version: citation.version })));
  if (prior.action_id !== input.action_id || prior.args_sha256 !== argsSha || !sameCitations) return { error: "step_key_conflict", status: 409 };
  if (prior.outcome === "succeeded" && prior.action_id === "handoff.create") {
    const depth = (await handoffLimits(db, tenantId, run, JSON.parse(prior.args_json))).depth;
    await createHandoffSignal(db, tenantId, run, JSON.parse(prior.args_json) as HandoffArgs, prior.step_key, depth, prior.created_at);
  }
  return prior;
}

/**
 * The person an escalation or a waiting step names (contract "Escalation to a named person"):
 * the on-duty holder of the reviewer role, then ops, then the owner. Until object owners and duty
 * rosters exist, the earliest active holder of the role stands in for the on-duty one.
 */
export async function namedPerson(db: AgentDb, tenantId: string, reviewerRole: string): Promise<string | null> {
  for (const role of [reviewerRole, "ops", "owner"]) {
    const user = await db
      .prepare(
        "SELECT user_id FROM app_users WHERE tenant_id = ? AND active = 1 AND COALESCE(access_role, role) = ? ORDER BY created_at, user_id LIMIT 1",
      )
      .bind(tenantId, role)
      .first<{ user_id: string }>();
    if (user) return user.user_id;
  }
  return null;
}

function stepInsert(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  input: ProposeInput,
  argsJson: string,
  argsSha: string,
  decision: PolicyDecision,
  personId: string | null,
  now: string,
  ceiling: number | null = null,
  stepId = `step_${crypto.randomUUID()}`,
): BoundStatement {
  const action = catalogAction(input.action_id);
  const context = runContext(run);
  const sources = input.citations.map((citation) => ({
    fact_id: citation.fact_id,
    version: citation.version,
    hash: context.facts.find((fact) => fact.fact_id === citation.fact_id)?.hash ?? null,
  }));
  const policy = canonicalJson({
    policy_id: STEP_POLICY_ID,
    version: STEP_POLICY_VERSION,
    result: decision.result,
    checks: decision.checks,
    reason_codes: decision.reason_codes,
  });
  const permit = canonicalJson({ kind: decision.permit_kind, permit_id: null, approval_id: null, approved_by: null, delegation_id: decision.delegation_id });
  const ask = decision.reviewer_role ? (decision.result === "needs_approval" ? "approve_or_decline" : "acknowledge_and_act") : null;
  // The sequence number and the ceiling are read inside the insert, so concurrent proposals never
  // share a number or jointly pass the ceiling. Scalar subqueries, not HAVING without GROUP BY,
  // which older SQLite builds reject.
  return db
    .prepare(
      `INSERT INTO agent_run_steps (step_id, tenant_id, run_id, step_seq, step_key, specialist_id,
        action_id, autonomy, args_json, args_sha256, sources_json, policy_json, permit_json,
        tool_json, readback_json, outcome, reason_code, needs_reviewer_role, needs_person_id,
        needs_ask, undo_json, do_it_myself_json, created_at, decided_at)
       SELECT ?, ?, ?, (SELECT COALESCE(MAX(step_seq), 0) + 1 FROM agent_run_steps WHERE run_id = ?),
              ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM agent_run_steps WHERE run_id = ? AND step_key = ?)
         AND (? IS NULL OR (SELECT COUNT(*) FROM agent_run_steps WHERE run_id = ?) < ?)
         AND (? = 0 OR (SELECT COUNT(*) FROM agent_signals WHERE tenant_id = ? AND kind = 'handoff'
           AND specialist_id = ? AND subject_aggregate = ? AND subject_id = ?
           AND json_extract(content_json, '$.from_specialist_id') = ?) < ?)`,
    )
    .bind(
      stepId,
      tenantId,
      run.run_id,
      run.run_id,
      input.step_key,
      run.specialist_id,
      input.action_id,
      decision.autonomy,
      argsJson,
      argsSha,
      canonicalJson(sources),
      policy,
      permit,
      decision.outcome,
      decision.reason_codes[0] ?? null,
      decision.reviewer_role,
      personId,
      ask,
      canonicalJson({ mode: action?.undo ?? "none", action_id: null, available: false }),
      canonicalJson({ surface: null, context: { run_id: run.run_id, action_id: input.action_id } }),
      now,
      decision.outcome === null ? null : now,
      run.run_id,
      input.step_key,
      ceiling,
      run.run_id,
      ceiling,
      input.action_id === "handoff.create" && decision.outcome === "succeeded" ? 1 : 0,
      tenantId,
      (input.args as Partial<HandoffArgs> | null)?.to_specialist_id ?? "",
      (input.args as Partial<HandoffArgs> | null)?.object?.aggregate ?? "",
      (input.args as Partial<HandoffArgs> | null)?.object?.id ?? "",
      run.specialist_id,
      DEFAULT_CEILINGS.sameHandoff,
    );
}

interface HandoffArgs {
  to_specialist_id: string;
  object: { aggregate: string; id: string; version: number };
  reason: string;
  expected_action_id: string;
}

async function handoffLimits(db: AgentDb, tenantId: string, run: RunRow, args: unknown) {
  const signal = await db
    .prepare("SELECT handoff_depth FROM agent_signals WHERE tenant_id = ? AND signal_id = ?")
    .bind(tenantId, run.signal_id)
    .first<{ handoff_depth: number }>();
  const target = (args as Partial<HandoffArgs> | null)?.to_specialist_id ?? "";
  const object = (args as Partial<HandoffArgs> | null)?.object;
  const same = await db
    .prepare(
      `SELECT COUNT(*) AS handoffs FROM agent_signals
       WHERE tenant_id = ? AND kind = 'handoff' AND specialist_id = ? AND subject_aggregate = ? AND subject_id = ?
         AND json_extract(content_json, '$.from_specialist_id') = ?`,
    )
    .bind(tenantId, target, object?.aggregate ?? "", object?.id ?? "", run.specialist_id)
    .first<{ handoffs: number }>();
  return { depth: Number(signal?.handoff_depth ?? 0) + 1, samePair: Number(same?.handoffs ?? 0) };
}

async function handoffSignalInsert(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  args: HandoffArgs,
  stepKey: string,
  depth: number,
  now: string,
  stepId: string,
): Promise<BoundStatement> {
  const content = canonicalJson({
    from_specialist_id: run.specialist_id,
    from_run_id: run.run_id,
    object: args.object,
    reason: args.reason,
    expected_action_id: args.expected_action_id,
  });
  return db
    .prepare(
      `INSERT INTO agent_signals (signal_id,tenant_id,kind,specialist_id,watch_id,source,
    subject_aggregate,subject_id,content_json,content_sha256,dedupe_key,parent_run_id,handoff_depth,received_at)
    SELECT ?,?,'handoff',?,'handoff.created',?,?,?,?,?,?,?,?,?
    WHERE EXISTS (SELECT 1 FROM agent_run_steps WHERE step_id=? AND outcome='succeeded')
      AND NOT EXISTS (SELECT 1 FROM agent_signals WHERE tenant_id=? AND dedupe_key=?)
      AND (SELECT COUNT(*) FROM agent_signals WHERE tenant_id=? AND kind='handoff'
        AND specialist_id=? AND subject_aggregate=? AND subject_id=?
        AND json_extract(content_json,'$.from_specialist_id')=?) < ?`,
    )
    .bind(
      `sig_${crypto.randomUUID()}`,
      tenantId,
      args.to_specialist_id,
      run.specialist_id,
      args.object.aggregate,
      args.object.id,
      content,
      await sha256Hex(content),
      `handoff:${run.run_id}:${stepKey}`,
      run.run_id,
      depth,
      now,
      stepId,
      tenantId,
      `handoff:${run.run_id}:${stepKey}`,
      tenantId,
      args.to_specialist_id,
      args.object.aggregate,
      args.object.id,
      run.specialist_id,
      DEFAULT_CEILINGS.sameHandoff,
    );
}

async function createHandoffSignal(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  args: HandoffArgs,
  stepKey: string,
  depth: number,
  now: string,
) {
  const prior = await stepByKey(db, run.run_id, stepKey);
  if (!prior) throw new Error("handoff_step_missing");
  await (
    await handoffSignalInsert(
      db,
      tenantId,
      run,
      args,
      stepKey,
      depth,
      now,
      prior.step_id,
    )
  ).run();
  const delivered = await db
    .prepare(
      "SELECT signal_id FROM agent_signals WHERE tenant_id=? AND dedupe_key=?",
    )
    .bind(tenantId, `handoff:${run.run_id}:${stepKey}`)
    .first();
  if (!delivered) throw new Error("handoff_signal_unavailable");
}

// ---------------------------------------------------------------------------------------------
// Closing a run

const CLOSE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reason", "detail", "output", "model", "hashes", "usage", "cost_usd", "attempts", "duration_ms", "tool_calls"],
  properties: {
    status: { type: "string", enum: ["ok", "abstained"] },
    reason: { type: ["string", "null"], maxLength: 64 },
    detail: { type: ["string", "null"], maxLength: 300 },
    // Checked separately: against the run output schema when the run produced output.
    output: { type: "null" },
    model: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["provider", "model", "models_used", "auth_mode", "tier"],
      properties: {
        provider: { type: "string", maxLength: 32 },
        model: { type: "string", maxLength: 128 },
        models_used: { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } },
        auth_mode: { type: "string", maxLength: 32 },
        tier: { type: "string", maxLength: 16 },
      },
    },
    hashes: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["system", "prompt", "schema"],
      properties: {
        system: { type: "string", maxLength: 64 },
        prompt: { type: "string", maxLength: 64 },
        schema: { type: "string", maxLength: 64 },
      },
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["input_tokens", "cached_input_tokens", "output_tokens"],
      properties: {
        input_tokens: { type: "integer", minimum: 0 },
        cached_input_tokens: { type: "integer", minimum: 0 },
        output_tokens: { type: "integer", minimum: 0 },
      },
    },
    cost_usd: { type: "number", minimum: 0 },
    attempts: { type: "integer", minimum: 0, maximum: 10 },
    duration_ms: { type: "integer", minimum: 0 },
    // Checked separately: a bounded list of {tool, arguments}; arguments are the model's, as sent.
    tool_calls: { type: "null" },
  },
};

export type RunResult = "completed" | "abstained" | "escalated" | "ceiling_reached" | "cancelled";

const GATEWAY_REASON_TO_CODE: Record<string, string> = {
  kill_switch: "provider_unavailable",
  provider_disabled: "provider_unavailable",
  credential_missing: "provider_unavailable",
  auth_failed: "provider_unavailable",
  rate_limited: "provider_unavailable",
  provider_error: "provider_unavailable",
  call_ceiling: "ceiling_reached",
  cost_ceiling: "ceiling_reached",
  ledger_unavailable: "ceiling_reached",
  invalid_output: "no_progress",
  model_mismatch: "provider_unavailable",
  unknown_specialist: "policy_missing",
  tier_not_allowed: "policy_missing",
  specialist_unavailable: "policy_missing",
  aborted: "no_progress",
};

export async function closeRun(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  body: unknown,
  runOutputSchema: JsonSchema,
  now: string,
): Promise<{ result: RunResult } | StoreError> {
  if (run.state === "closed") return { error: "run_closed", status: 409 };
  if (!closeShapeValid(body)) return { error: "invalid_close", status: 422 };
  const close = body as {
    status: "ok" | "abstained";
    reason: string | null;
    output: { decision?: string; reason_code?: string | null } | null;
  };
  if (close.status === "ok" && (close.output === null || validate(runOutputSchema, close.output).length > 0)) {
    return { error: "invalid_close", status: 422 };
  }
  let result: RunResult;
  let reasonCode: string | null = null;
  if (close.status === "abstained") {
    reasonCode = GATEWAY_REASON_TO_CODE[close.reason ?? ""] ?? "provider_unavailable";
    result = reasonCode === "ceiling_reached" ? "ceiling_reached" : "abstained";
  } else {
    const decision = close.output?.decision;
    result = decision === "abstain" ? "abstained" : decision === "escalate" ? "escalated" : "completed";
    if (result !== "completed") reasonCode = close.output?.reason_code ?? "out_of_scope";
  }
  // The abstention receipt and the close commit together, receipt first, so a closed run never
  // lacks the receipt that names a person and no step lands after the close.
  const statements: BoundStatement[] = [];
  if (reasonCode && !(await namesAPerson(db, run.run_id))) statements.push(await abstentionStep(db, tenantId, run, reasonCode, now));
  statements.push(
    db
      .prepare("UPDATE agent_runs SET state = 'closed', result = ?, close_json = ?, ended_at = ?, version = version + 1 WHERE run_id = ? AND state = 'open'")
      .bind(result, canonicalJson(body), now, run.run_id),
  );
  try {
    const results = await db.batch(statements);
    if (changesOf(results.at(-1)) < 1) throw new Error("agent_run_closed");
  } catch (error) {
    if (!String(error).includes("agent_run_closed")) throw error;
    return { error: "run_closed", status: 409 };
  }
  return { result };
}

/** Whether the run already holds a step that hands it to a named person. */
async function namesAPerson(db: AgentDb, runId: string): Promise<boolean> {
  const step = await db
    .prepare(
      `SELECT step_id FROM agent_run_steps
       WHERE run_id = ? AND action_id = 'exception.escalate' AND needs_reviewer_role IS NOT NULL
         AND (outcome IS NULL OR outcome = 'abstained') LIMIT 1`,
    )
    .bind(runId)
    .first<{ step_id: string }>();
  return step !== null;
}

/** The specialist's own receipt for an abstaining or escalating run: it names a person. */
async function abstentionStep(db: AgentDb, tenantId: string, run: RunRow, reasonCode: string, now: string): Promise<BoundStatement> {
  const reviewer = catalogSpecialist(run.specialist_id)?.reviewer_role ?? "owner";
  const args = { reason_code: reasonCode };
  const argsJson = canonicalJson(args);
  return stepInsert(
    db,
    tenantId,
    run,
    { action_id: "exception.escalate", args, citations: [], step_key: `abstention:${run.run_id}` },
    argsJson,
    await sha256Hex(argsJson),
    {
      result: "allow",
      outcome: "abstained",
      reason_codes: [reasonCode],
      checks: [{ check: "named_person", passed: true }],
      permit_kind: "within_limits",
      delegation_id: null,
      autonomy: "A2",
      reviewer_role: reviewer,
    },
    await namedPerson(db, tenantId, reviewer),
    now,
  );
}

function closeShapeValid(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  const calls = value.tool_calls;
  if (!Array.isArray(calls) || calls.length > 64) return false;
  for (const call of calls) {
    if (typeof call !== "object" || call === null || Array.isArray(call)) return false;
    const keys = Object.keys(call);
    if (keys.length !== 2 || !keys.includes("tool") || !keys.includes("arguments")) return false;
    if (typeof (call as { tool: unknown }).tool !== "string" || (call as { tool: string }).tool.length > 64) return false;
  }
  if (canonicalJson(calls).length > 65_536) return false;
  return validate(CLOSE_SCHEMA, { ...value, output: null, tool_calls: null }).length === 0;
}

// ---------------------------------------------------------------------------------------------
// Host heartbeats

const HEARTBEAT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["host_id", "version", "ready", "alerts", "providers", "in_flight", "backlog"],
  properties: {
    host_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
    version: { type: "string", maxLength: 32 },
    ready: { type: "boolean" },
    alerts: { type: "array", maxItems: 32, items: { type: "string", pattern: "^[a-z0-9_]{1,64}$" } },
    providers: { type: "object", additionalProperties: false, required: [], properties: {} },
    in_flight: { type: "integer", minimum: 0, maximum: 1000 },
    backlog: {
      type: "object",
      additionalProperties: false,
      required: ["pending_closes", "oldest_pending_ms", "rejected_closes", "rejected_signals"],
      properties: {
        pending_closes: { type: "integer", minimum: 0 },
        oldest_pending_ms: { type: ["integer", "null"], minimum: 0 },
        rejected_closes: { type: "integer", minimum: 0 },
        rejected_signals: { type: "integer", minimum: 0 },
      },
    },
  },
};

export async function recordHeartbeat(db: AgentDb, tenantId: string, body: unknown, now: string): Promise<{ ok: true } | StoreError> {
  // Provider health is a free-form report; it is stored as received, after the rest validates.
  const providers = (body as { providers?: unknown } | null)?.providers;
  const shaped = typeof body === "object" && body !== null ? { ...(body as Record<string, unknown>), providers: {} } : body;
  if (validate(HEARTBEAT_SCHEMA, shaped).length > 0) return { error: "invalid_heartbeat", status: 422 };
  const beat = body as { host_id: string; version: string; ready: boolean; alerts: string[]; in_flight: number; backlog: unknown };
  const providersJson = canonicalJson(typeof providers === "object" && providers !== null ? providers : {});
  if (providersJson.length > 16_384) return { error: "invalid_heartbeat", status: 422 };
  await db
    .prepare(
      `INSERT INTO agent_host_heartbeats (tenant_id, host_id, host_version, ready, alerts_json, providers_json, backlog_json, in_flight, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, host_id) DO UPDATE SET host_version = excluded.host_version, ready = excluded.ready,
         alerts_json = excluded.alerts_json, providers_json = excluded.providers_json, backlog_json = excluded.backlog_json,
         in_flight = excluded.in_flight, received_at = excluded.received_at`,
    )
    .bind(tenantId, beat.host_id, beat.version, beat.ready ? 1 : 0, canonicalJson(beat.alerts), providersJson, canonicalJson(beat.backlog), beat.in_flight, now)
    .run();
  return { ok: true };
}
