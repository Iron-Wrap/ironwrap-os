// D1 persistence for the AI team: signals, coordination runs, steps (the receipts) and host
// heartbeats. Every write goes through a deterministic decision made here or in policy.ts; the
// agent host only transports proposals.

import { sha256Hex } from "../app-auth.ts";
import { CATALOG, CATALOG_VERSION, catalogAction, catalogSpecialist, toolName } from "./catalog.ts";
import { APPLY_IN_OWN_SCREEN } from "./receipts.ts";
import { DEFAULT_CEILINGS, evaluateStep, INBOUND_ONLY, PERSON_REQUEST_ONLY, PREPARES_PEOPLE_ONLY, STEP_POLICY_ID, STEP_POLICY_VERSION, type Citation, type PolicyDecision, type StepInput } from "./policy.ts";
import { evaluateAuthority, type AuthorityEvaluation, type AuthorityReadRefusal } from "./authority-read.ts";
import { currentDelegation, escalateRunAbstention, specialistControl, specialistState, withinCeiling, executeStep, type Notify } from "./control.ts";
import { actorWord, ASK_UNANSWERED_MS, askerRole, PERSON_CODES, recordAskClose, signalActor, VIEW_SCHEMA, viewSources, type AskRun, type ViewVerdict } from "./face.ts";
import { citedFacts, factHash, factReader, hydrate, refOf, subjectFacts, subjectsFacts, type ContextFact, type FactRef, type OmittedFact, type Reader } from "./memory.ts";
import { OBJECT_MODELS, REPORT_MODELS } from "./read-models.ts";
import { CANDIDATE_BAR, currentQualifications, delegationCandidates, qualificationHolds, recordShadowStep, runMode, shadowSetting, signalActions, type QualificationHint, type ShadowStepRow } from "./shadow.ts";
import { OWNER_REPORTS, WATCH_SIGNAL_SOURCE } from "./watches.ts";
import { registryEntry } from "./registry.ts";
import { canonicalJson, validate, type JsonSchema } from "./schema.ts";
import { LEAD_FACT_KEYS, leadProposal, type LeadFacts } from "./lead-proposals.ts";
import { supersedeDrafts } from "./drafts.ts";

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
  close_json: string | null;
  attempt: number;
  attempt_started_at: string;
  started_at: string;
  correlation_id: string;
  catalog_version: string;
  policy_version: string;
  /** `live`, or `shadow` when every action the run can lead to is in shadow (migration 0203). */
  mode?: "live" | "shadow";
}

/**
 * What the host needs to route a run: its mode, its one expected action, the run it reviews and the
 * specialist's current qualifications. `close_model: 3` says this Worker takes the v3 close model
 * block; an older host reads neither, nor `review_of.family`, and closes as it always has.
 */
export interface RunHints {
  mode: "live" | "shadow";
  expected_action_id: string | null;
  /** The reviewed run's provider id and, when it is known, its model family. */
  review_of: { run_id: string; provider: string; family?: string } | null;
  qualifications: QualificationHint[];
  close_model: 3;
  output_extension?: { view: JsonSchema };
}

/** What data a Worker holds (`AGENT_DATA_CLASS`): `business`, or `synthetic` on a QA or dev Worker's seed data. */
export type DataClass = "business" | "synthetic";

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

export type { ContextFact, FactRef } from "./memory.ts";

/** A run's context as the host receives it: facts with their values, read from the canonical rows. */
export interface RunContext {
  snapshot_hash: string;
  facts: Array<ContextFact & { current?: false }>;
  omitted: OmittedFact[];
}

/** What the host needs beyond the context and tools: an ask run may also return a view. */
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
/** A signal's time as toISOString writes it: migration 0207's age check compares this form as text. */
const STORED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The time a signal is stored under; any other form is a bug in its writer, so it throws. */
function signalTime(now: string): string {
  if (!STORED_INSTANT.test(now)) throw new Error("invalid_signal_time");
  return now;
}

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
  /** Statements that must pass in the insert's transaction, such as a person's live session. */
  guards: BoundStatement[] = [],
  /** A condition the insert itself checks, such as a person's limits; refused, it answers `signal_not_admitted`. */
  admission: { where: string; values: unknown[] } | null = null,
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
  const insert = db
    .prepare(
      `INSERT INTO agent_signals (signal_id, tenant_id, kind, specialist_id, watch_id, source,
        subject_aggregate, subject_id, content_json, content_sha256, dedupe_key, parent_run_id,
        handoff_depth, received_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM agent_signals WHERE tenant_id = ? AND dedupe_key = ?)${admission ? ` AND ${admission.where}` : ""}`,
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
      signalTime(now),
      tenantId,
      input.dedupe_key,
      ...(admission?.values ?? []),
    );
  const inserted = guards.length > 0 ? (await db.batch([...guards, insert])).at(-1) : await insert.run();
  if (changesOf(inserted) > 0) return { signal_id: signalId, created: true };
  const winner = await db.prepare("SELECT signal_id FROM agent_signals WHERE tenant_id = ? AND dedupe_key = ?")
    .bind(tenantId, input.dedupe_key).first<{signal_id: string}>();
  if (winner) return { signal_id: winner.signal_id, created: false };
  return admission ? { error: "signal_not_admitted", status: 429 } : { error: "signal_unavailable", status: 503 };
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

/**
 * A signal as the host and the model see it. A person's ask or request shows its route's word and
 * who made it (face.ts `signalActor`); the column keeps `ask:<user_id>` for the asker's check.
 * Every other signal carries `actor: null` and its source as recorded.
 */
function signalView(row: SignalRow) {
  const actor = signalActor(row);
  return {
    signal_id: row.signal_id,
    kind: row.kind,
    specialist_id: row.specialist_id,
    watch_id: row.watch_id,
    source: actor ? actorWord(row) : row.source,
    actor,
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
    if (!entry || entry.binding.kind === "unavailable" || action.autonomy === "H" || action.human_only) continue;
    tools.push({
      action_id: action.action_id,
      tool_name: toolName(action.action_id),
      autonomy: action.autonomy,
      side_effect_class: action.side_effect_class,
      undo: action.undo,
      description: `${action.action_id} on ${action.aggregate}: ${action.name ?? action.action_id}${action.protective ? " (protective)" : ""}.`,
      args_schema: entry.args,
    });
  }
  return tools;
}

/**
 * The people-only acts a specialist's run may name in its receipts, by catalog name: the H actions
 * it owns. Names only, never tools. The Worker reads no allowlist, and an allowlist names no H
 * action (agent-host/specialists/README.md), so these are all of them.
 */
export function peopleOnlyFor(specialistId: string): Array<{ action_id: string; name: string }> {
  return catalogActionsOwnedBy(specialistId)
    .filter((action) => action.autonomy === "H" || action.human_only)
    .map((action) => ({ action_id: action.action_id, name: action.name ?? action.action_id }));
}

function catalogActionsOwnedBy(specialistId: string) {
  return CATALOG.actions.filter((action) => action.owners.includes(specialistId));
}

export async function openRun(
  db: AgentDb,
  tenantId: string,
  input: { signal_id: string; specialist_id: string; host_run_key: string },
  now: string,
): Promise<{ run: RunRow; resumed: boolean; context: RunContext; hints: RunHints } | StoreError> {
  const existing = await runByKey(db, tenantId, input.host_run_key);
  if (existing) return await resumeRun(db, tenantId, existing, input, now);
  const signal = await db
    .prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?")
    .bind(tenantId, input.signal_id)
    .first<SignalRow>();
  if (!signal) return { error: "signal_not_found", status: 422 };
  if (signal.specialist_id !== input.specialist_id) return { error: "specialist_mismatch", status: 422 };
  // A signal past its text retention no longer holds what a run would read (retention.ts), so no
  // run starts on it (409: the host skips it). The INSERT repeats this check atomically after the
  // awaited context reads, so redaction cannot win admission while this cached row still has text.
  if (redacted(signal)) return { error: "signal_redacted", status: 409 };

  const subject = signal.subject_aggregate && signal.subject_id ? { aggregate: signal.subject_aggregate, id: signal.subject_id } : null;
  // The face answering a person's ask reads as that person's role at ask time (face.ts). An ask
  // older than its wait already reads not answered, so no run starts on it (409: the host skips it).
  const asker = askerRole(signal);
  if (asker !== null && Date.parse(now) - Date.parse(signal.received_at) > ASK_UNANSWERED_MS) return { error: "ask_expired", status: 409 };
  // A watch names the objects its condition found; the run starts from each of them.
  const watchObjects = watchSubjects(signal);
  // An owner report's run writes for a wider audience: it reads no lead proposal.
  const reportRun = signal.kind === "watch" && signal.source === WATCH_SIGNAL_SOURCE && signal.watch_id !== null && Object.hasOwn(OWNER_REPORTS, signal.watch_id);
  const memory = watchObjects
    ? await subjectsFacts(db, reportRun ? REPORT_MODELS : OBJECT_MODELS, tenantId, signal.specialist_id, watchObjects, now)
    : await subjectFacts(db, OBJECT_MODELS, tenantId, asker === null ? signal.specialist_id : { role: asker }, subject, now);
  // A handoff run also starts from the person's ask or request at the root of its chain.
  const root = signal.kind === "handoff" ? await rootOf(db, tenantId, signal) : null;
  const request = root ? await rootRequestFact(root, signal.specialist_id) : null;
  const facts = [signalFact(signal), ...(request ? [request] : []), ...memory.facts];
  const snapshotHash = await sha256Hex(canonicalJson(facts.map(({ fact_id, version, hash }) => ({ fact_id, version, hash }))));
  const tools = toolsFor(signal.specialist_id);
  const manifestHash = await sha256Hex(canonicalJson(tools));
  const mode = await runMode(db, tenantId, signal.specialist_id, signalActions(signal));
  const run: RunRow = {
    run_id: `run_${crypto.randomUUID()}`,
    tenant_id: tenantId,
    specialist_id: signal.specialist_id,
    signal_id: signal.signal_id,
    host_run_key: input.host_run_key,
    goal: goalFor(signal),
    // The run row keeps fact refs only; values stay in the canonical rows (memory.ts). An ask run
    // also keeps whose role it reads as, so a resume or a citation reads exactly as the open did.
    context_json: canonicalJson({
      snapshot_hash: snapshotHash,
      facts: facts.map(refOf),
      omitted: memory.omitted,
      ...(asker === null ? {} : { asker_role: asker }),
    }),
    context_snapshot_hash: snapshotHash,
    tool_manifest_json: canonicalJson(tools),
    state: "open",
    result: null,
    close_json: null,
    attempt: 1,
    attempt_started_at: now,
    started_at: now,
    correlation_id: signal.parent_run_id ?? signal.signal_id,
    catalog_version: CATALOG_VERSION,
    policy_version: `${STEP_POLICY_ID}@${STEP_POLICY_VERSION}`,
    mode,
  };
  const inserted = await db
    .prepare(
      `INSERT INTO agent_runs (run_id, tenant_id, specialist_id, signal_id, host_run_key, goal,
        trigger_json, context_json, context_snapshot_hash, tool_manifest_json, tool_manifest_hash,
        catalog_version, policy_version, parent_run_id, correlation_id, state, attempt,
        attempt_started_at, started_at, mode)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE tenant_id = ? AND host_run_key = ?)
         AND EXISTS (SELECT 1 FROM agent_signals WHERE tenant_id = ? AND signal_id = ?
           AND json_type(content_json, '$.redacted') IS NOT 'true')`,
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
      mode,
      tenantId,
      input.host_run_key,
      tenantId,
      input.signal_id,
    )
    .run();
  if (changesOf(inserted) >= 1) {
    // Admission checks the triggering row atomically, but a handoff also copied its root ask.
    // Re-read every canonical signal value after that boundary, just as resume does. Retention
    // keeps the trigger's original hash and can change a root fact's hash; hydrate then supplies
    // reduced content or a stale/null fact, never the plaintext cached before the INSERT.
    const admittedSignals = await hydrate(facts.filter((fact) => fact.kind === "signal").map(refOf), runFactReader(db, tenantId, run, now));
    const signalsById = new Map(admittedSignals.map((fact) => [fact.fact_id, fact]));
    const admittedFacts = facts.map((fact) => fact.kind === "signal" ? signalsById.get(fact.fact_id)! : fact);
    return { run, resumed: false, context: { snapshot_hash: snapshotHash, facts: admittedFacts, omitted: memory.omitted }, hints: await runHints(db, tenantId, run, signal) };
  }
  // Another open for the same key won the insert: that run is the one, so resume it.
  const winner = await runByKey(db, tenantId, input.host_run_key);
  if (winner) return await resumeRun(db, tenantId, winner, input, now);
  const currentSignal = await db.prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?")
    .bind(tenantId, input.signal_id).first<SignalRow>();
  if (currentSignal && redacted(currentSignal)) return { error: "signal_redacted", status: 409 };
  return { error: "run_unavailable", status: 503 };
}

async function runByKey(db: AgentDb, tenantId: string, hostRunKey: string): Promise<RunRow | null> {
  return await db.prepare("SELECT * FROM agent_runs WHERE tenant_id = ? AND host_run_key = ?").bind(tenantId, hostRunKey).first<RunRow>();
}

/** A host that stopped mid-run re-delivers the signal; the still-open run resumes where it was. */
async function resumeRun(
  db: AgentDb,
  tenantId: string,
  existing: RunRow,
  input: { signal_id: string; specialist_id: string },
  now: string,
): Promise<{ run: RunRow; resumed: boolean; context: RunContext; hints: RunHints } | StoreError> {
  if (existing.signal_id !== input.signal_id || existing.specialist_id !== input.specialist_id) {
    return { error: "run_key_conflict", status: 422 };
  }
  if (existing.state === "closed") return { error: "run_closed", status: 409 };
  // A run past its wall-time ceiling can take no step; it closes now instead of staying open.
  if (Date.parse(now) - Date.parse(existing.started_at) > DEFAULT_CEILINGS.wallTimeMs) {
    await expireRun(db, tenantId, existing, now);
    return { error: "run_expired", status: 409 };
  }
  const resumed = await db
    .prepare("UPDATE agent_runs SET attempt = attempt + 1, attempt_started_at = ?, version = version + 1 WHERE run_id = ? AND state = 'open'")
    .bind(now, existing.run_id)
    .run();
  if (changesOf(resumed) < 1) return { error: "run_closed", status: 409 };
  // The same refs, read again: a fact that changed since the run opened comes back marked stale.
  const stored = runContext(existing);
  const facts = await hydrate(stored.facts, runFactReader(db, tenantId, existing, now));
  const signal = await db.prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?").bind(tenantId, existing.signal_id).first<SignalRow>();
  return {
    run: { ...existing, attempt: existing.attempt + 1, attempt_started_at: now },
    resumed: true,
    context: { snapshot_hash: stored.snapshot_hash, facts, omitted: stored.omitted },
    hints: await runHints(db, tenantId, existing, signal),
  };
}

/**
 * Routing hints for the host, all from Worker records: the run's mode; the single action the
 * signal expects (a handoff's, or a watch that proposes one action); for the auditor's review of
 * another run, that run, its provider and the model family that ran it, so the gateway can pick a
 * reviewer of a different family (contract "Model routing"); and the qualifications the
 * specialist's live and shadow routes must match (contract "Qualification").
 */
async function runHints(db: AgentDb, tenantId: string, run: RunRow, signal: SignalRow | null): Promise<RunHints> {
  const actions = signal ? signalActions(signal) : [];
  const reviewed = signal ? await reviewedRun(db, tenantId, run.specialist_id, signal) : null;
  return {
    mode: run.mode ?? "live",
    expected_action_id: actions.length === 1 ? actions[0] : null,
    // A family this Worker cannot name is left out; the host then finds no route to review it with.
    review_of: reviewed && { run_id: reviewed.run_id, provider: reviewed.provider, ...(reviewed.family === null ? {} : { family: reviewed.family }) },
    qualifications: await currentQualifications(db, tenantId, run.specialist_id),
    close_model: 3,
    // Only an ask run may return a view, so only its open carries the view schema (face.ts).
    ...(askRun(run) ? { output_extension: { view: VIEW_SCHEMA } } : {}),
  };
}

/** The run an audit reviews, with the provider and family its close recorded (null when unknown). */
async function reviewedRun(
  db: AgentDb,
  tenantId: string,
  specialistId: string,
  signal: SignalRow,
): Promise<{ run_id: string; provider: string; family: string | null } | null> {
  if (specialistId !== "independent_auditor" || signal.subject_aggregate !== "coordination_run" || !signal.subject_id) return null;
  const reviewed = await db
    .prepare("SELECT run_id, close_json FROM agent_runs WHERE tenant_id = ? AND run_id = ?")
    .bind(tenantId, signal.subject_id)
    .first<{ run_id: string; close_json: string | null }>();
  const model = reviewed?.close_json ? (JSON.parse(reviewed.close_json) as { model?: { provider?: unknown } | null }).model : undefined;
  return reviewed && typeof model?.provider === "string" ? { run_id: reviewed.run_id, provider: model.provider, family: familyOf(model) } : null;
}

export async function getRun(db: AgentDb, tenantId: string, runId: string): Promise<RunRow | null> {
  return await db.prepare("SELECT * FROM agent_runs WHERE tenant_id = ? AND run_id = ?").bind(tenantId, runId).first<RunRow>();
}

/** `asker_role` is set only on a run that answers a person's ask: the role its facts are read as. */
export function runContext(run: RunRow): { snapshot_hash: string; facts: FactRef[]; omitted: OmittedFact[]; asker_role: string | null } {
  const context = JSON.parse(run.context_json) as { snapshot_hash: string; facts: FactRef[]; omitted?: OmittedFact[]; asker_role?: string };
  return {
    snapshot_hash: context.snapshot_hash,
    facts: context.facts.map(refOnly),
    omitted: context.omitted ?? [],
    asker_role: context.asker_role ?? null,
  };
}

/** The run as an ask run's close is checked, or null for any other run. */
function askRun(run: RunRow): AskRun | null {
  const context = runContext(run);
  return context.asker_role === null ? null : { run_id: run.run_id, facts: context.facts, asker_role: context.asker_role };
}

/** Whose read rights a run's facts follow: the asker's role on an ask run, else the specialist's. */
function runReader(run: RunRow): Reader {
  const asker = runContext(run).asker_role;
  return asker === null ? run.specialist_id : { role: asker };
}

/** A ref without any value a row written before refs-only storage may still carry. */
function refOnly(fact: FactRef & { data?: unknown }): FactRef {
  const { data: _value, ...ref } = fact;
  return ref;
}

/**
 * Reads a run's facts again: canonical objects through the read models, and from their rows the
 * run's signal and, on a handoff run, the ask or request at the root of its chain.
 */
export function runFactReader(db: AgentDb, tenantId: string, run: RunRow, now: string) {
  return factReader(db, OBJECT_MODELS, tenantId, runReader(run), now, async (ref) => {
    try {
      const signal = await runSignalRow(db, tenantId, run);
      if (ref.fact_id === `signal/${signal.signal_id}`) return signalFact(signal);
      const root = signal.kind === "handoff" ? await rootOf(db, tenantId, signal) : null;
      return root && ref.fact_id === `signal/${root.signal_id}` ? await rootRequestFact(root, run.specialist_id) : null;
    } catch {
      return null; // Unreadable now: unverifiable, never assumed current.
    }
  });
}

/**
 * The signal a chain of handoffs started from: each handoff leads to the run that created it
 * (`parent_run_id`) and on to that run's signal. Null when a link is missing, or when more handoffs
 * than the depth ceiling allows lead back from it, which also ends a chain that loops. Any other
 * signal is its own root.
 */
async function rootOf(db: AgentDb, tenantId: string, signal: SignalRow): Promise<SignalRow | null> {
  let current = signal;
  for (let hops = 0; current.kind === "handoff"; hops += 1) {
    if (!current.parent_run_id || hops >= DEFAULT_CEILINGS.handoffDepth) return null;
    const parent = await db
      .prepare(
        `SELECT s.* FROM agent_runs r JOIN agent_signals s ON s.tenant_id = r.tenant_id AND s.signal_id = r.signal_id
          WHERE r.tenant_id = ? AND r.run_id = ?`,
      )
      .bind(tenantId, current.parent_run_id)
      .first<SignalRow>();
    if (!parent) return null;
    current = parent;
  }
  return current;
}

/**
 * The person's ask or request at the root of a handoff run's chain, as fact `signal/<id>` at version
 * 1, or null when the root is no such signal. Its `source` and `actor` are the Worker's record. An
 * ask reads back only for its asker and the owner (ask.ts `askFor`), and a run reads as a role, so
 * `content` is there only for a run that reads as the owner; a fact with it is untrusted text, as
 * every signal's content is, and one without it is the Worker's own.
 */
async function rootRequestFact(root: SignalRow, specialistId: string): Promise<ContextFact | null> {
  const actor = signalActor(root);
  if (!actor) return null;
  const readsContent = catalogSpecialist(specialistId)?.reviewer_role === "owner";
  const data = {
    signal_id: root.signal_id,
    kind: root.kind,
    source: actorWord(root),
    actor,
    ...(readsContent ? { content: JSON.parse(root.content_json) as unknown } : {}),
  };
  return {
    fact_id: `signal/${root.signal_id}`,
    kind: "signal",
    version: 1,
    hash: await factHash(data),
    trust: readsContent ? "untrusted_text" : "owned",
    observed_at: root.received_at,
    fresh_until: null,
    data,
  };
}

/** The signal a run answers, for policy's `requester`: its own, or the root of its handoff chain. */
async function runRequest(db: AgentDb, tenantId: string, run: RunRow): Promise<StepInput["requester"]> {
  const root = await rootOf(db, tenantId, await runSignalRow(db, tenantId, run));
  if (!root) return null;
  const actor = signalActor(root);
  const content: unknown = JSON.parse(root.content_json);
  const expected = typeof content === "object" && content !== null ? (content as { expected_action_id?: unknown }).expected_action_id : undefined;
  return {
    signal_ref: `signal/${root.signal_id}`,
    kind: root.kind,
    source: actor ? actorWord(root) : root.source,
    actor,
    expected_action_id: typeof expected === "string" ? expected : null,
    subject: root.subject_aggregate && root.subject_id ? { aggregate: root.subject_aggregate, id: root.subject_id } : null,
  };
}

export function runTools(run: RunRow): RunTool[] {
  return JSON.parse(run.tool_manifest_json);
}

/** Whether a signal's text was redacted at the end of its retention (migration 0207). */
function redacted(signal: SignalRow): boolean {
  const content: unknown = JSON.parse(signal.content_json);
  return typeof content === "object" && content !== null && (content as { redacted?: unknown }).redacted === true;
}

/** The objects a scheduler watch's condition named, or null for any other signal. */
function watchSubjects(signal: SignalRow): Array<{ aggregate: string; id: string }> | null {
  if (signal.kind !== "watch" || signal.source !== WATCH_SIGNAL_SOURCE) return null;
  const objects = (JSON.parse(signal.content_json) as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return null;
  return objects.filter(
    (entry): entry is { aggregate: string; id: string } =>
      typeof entry === "object" && entry !== null && typeof (entry as { aggregate?: unknown }).aggregate === "string" && typeof (entry as { id?: unknown }).id === "string",
  );
}

/**
 * The signal itself is the first fact of every run, under the hash of what was received, which
 * redaction keeps (retention.ts). Its text is untrusted, except a watch the Worker's scheduler wrote
 * from its own records.
 */
function signalFact(signal: SignalRow): ContextFact {
  return {
    fact_id: `signal/${signal.signal_id}`,
    kind: "signal",
    version: 1,
    hash: `sha256:${signal.content_sha256}`,
    trust: signal.kind === "watch" && signal.source === WATCH_SIGNAL_SOURCE ? "owned" : "untrusted_text",
    observed_at: signal.received_at,
    fresh_until: null,
    data: JSON.parse(signal.content_json),
  };
}

/** A person's ask or request reads "ask from sales" or "request from owner", never "owner request" for anyone else. */
function goalFor(signal: SignalRow): string {
  const subject = signal.subject_aggregate ? ` about ${signal.subject_aggregate}/${signal.subject_id}` : "";
  const actor = signalActor(signal);
  const origin =
    signal.kind === "watch"
      ? `watch ${signal.watch_id}`
      : actor
        ? `${actorWord(signal)} from ${actor.role}`
        : `${signal.kind.replace("_", " ")} from ${signal.source}`;
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
export async function proposeStep(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  input: ProposeInput,
  nowMs: number,
  notify: Notify | null = null,
): Promise<(StepRow & StepRead) | { shadow: ShadowStepRow } | StoreError> {
  const argsJson = canonicalJson(input.args ?? null);
  const argsSha = await sha256Hex(argsJson);
  const priorShadow = await db.prepare("SELECT * FROM agent_shadow_steps WHERE run_id = ? AND step_key = ?").bind(run.run_id, input.step_key).first<ShadowStepRow>();
  if (priorShadow) {
    return priorShadow.action_id === input.action_id && priorShadow.args_sha256 === argsSha ? { shadow: priorShadow } : { error: "step_key_conflict", status: 409 };
  }
  const prior = await stepByKey(db, run.run_id, input.step_key);
  if (prior) {
    const replay = await replayStep(db, tenantId, run, prior, input, argsSha);
    if ("error" in replay) return replay;
    await executeStep(db, tenantId, run, replay, new Date(nowMs).toISOString(), notify);
    // A repeated read answers with the records as they read now.
    const repeated = (await stepByKey(db, run.run_id, input.step_key)) ?? replay;
    return answered(repeated, repeated.outcome === "succeeded" ? await stepRead(db, tenantId, run, repeated.action_id, input.args, new Date(nowMs).toISOString()) : null);
  }
  // Shadow steps count toward the run's step ceiling like receipts do.
  const count = await db
    .prepare("SELECT (SELECT COUNT(*) FROM agent_run_steps WHERE run_id = ?) + (SELECT COUNT(*) FROM agent_shadow_steps WHERE run_id = ?) AS steps")
    .bind(run.run_id, run.run_id)
    .first<{ steps: number }>();
  const context = runContext(run);
  // Every cited fact is read again now; one this Worker cannot read is unverifiable, never current.
  const { snapshot, currentVersions } = await citedFacts(
    input.citations,
    context.facts,
    runFactReader(db, tenantId, run, new Date(nowMs).toISOString()),
  );
  let handoff: { depth: number; samePair: number } | null = null;
  if (input.action_id === "handoff.create") handoff = await handoffLimits(db, tenantId, run, input.args);

  const control = await specialistControl(db, tenantId, run.specialist_id);
  const delegation = await currentDelegation(db, tenantId, run.specialist_id, input.action_id);
  // Read once: whether the action practises, and whether its practice stopped. A practice-only action
  // whose practice runs stopped neither practises nor runs: policy reads it as switched off until the
  // owner confirms it again (shadow.ts practiceStopped).
  const practice = await shadowSetting(db, tenantId, run.specialist_id, input.action_id);
  const practiceStopped = practice.stopped;
  const ceilingMet =
    delegation?.setting === "within_limits"
      ? await withinCeiling(db, tenantId, run.specialist_id, input.action_id, delegation.ceiling, input.args, nowMs)
      : false;
  // An action only a person's own request may start is checked against the request the run answers.
  const requester = PERSON_REQUEST_ONLY.has(input.action_id) || INBOUND_ONLY.has(input.action_id) ? await runRequest(db, tenantId, run) : undefined;
  let decision = evaluateStep({
    requester,
    specialistId: run.specialist_id,
    specialistState: specialistState(control),
    actionId: input.action_id,
    args: input.args,
    citations: input.citations,
    snapshot,
    currentVersions,
    delegation: practiceStopped ? { delegation_id: delegation?.delegation_id ?? "practice_stopped", setting: "off" } : delegation,
    withinCeiling: ceilingMet,
    stepsOnRun: Number(count?.steps ?? 0),
    runStartedAt: Date.parse(run.started_at),
    now: nowMs,
    handoff,
  });
  // A run cannot acquire tools or policy authority introduced after its immutable manifest.
  if (
    decision.result !== "deny" &&
    (run.catalog_version !== CATALOG_VERSION ||
      run.policy_version !== `${STEP_POLICY_ID}@${STEP_POLICY_VERSION}` ||
      !runTools(run).some((tool) => tool.action_id === input.action_id))
  ) {
    decision = {
      ...decision,
      result: "deny",
      outcome: "abstained",
      reason_codes: ["policy_missing"],
      permit_kind: "none",
      delegation_id: null,
      reviewer_role: catalogSpecialist(run.specialist_id)?.reviewer_role ?? "owner",
    };
  }
  // The system proposes acting within limits only where the action meets the earned-autonomy bar
  // for that specialist (contract "Delegation" item 13): below it, policy refuses the proposal.
  if (decision.result !== "deny" && input.action_id === "delegation.propose_change" && (input.args as { proposed?: unknown }).proposed === "within_limits") {
    const pair = input.args as { specialist_id: string; action_id: string };
    const earned = (await delegationCandidates(db, tenantId, CANDIDATE_BAR, { specialist_id: pair.specialist_id, action_id: pair.action_id })).length > 0;
    decision = earned
      ? { ...decision, checks: [...decision.checks, { check: "earned_autonomy", passed: true }] }
      : {
          ...decision,
          result: "deny",
          outcome: "failed",
          reason_codes: ["policy_denied"],
          checks: [...decision.checks, { check: "earned_autonomy", passed: false }],
          permit_kind: "none",
          delegation_id: null,
          reviewer_role: null,
        };
  }
  // A confirm names an open proposal of the same lead and tenant and confirms only what it proposed
  // (a non-null value equals the proposal's); a person who wants another value edits the lead by hand.
  if (decision.result !== "deny" && input.action_id === "lead_fact.confirm") {
    const confirm = input.args as { lead_id: string; proposal_id: string; fields: LeadFacts };
    const proposal = await leadProposal(db, tenantId, confirm.proposal_id);
    const refusal =
      !proposal || proposal.lead_id !== confirm.lead_id
        ? "fact_missing"
        : !proposal.open
          ? "fact_stale"
          : LEAD_FACT_KEYS.some((key) => confirm.fields[key] !== null && confirm.fields[key] !== proposal.fields[key])
            ? "fact_conflict"
            : null;
    decision = refusal
      ? {
          ...decision,
          result: "deny",
          outcome: "abstained",
          reason_codes: [refusal],
          checks: [...decision.checks, { check: "proposal", passed: false }],
          permit_kind: "none",
          delegation_id: null,
          reviewer_role: catalogSpecialist(run.specialist_id)?.reviewer_role ?? "owner",
        }
      : { ...decision, checks: [...decision.checks, { check: "proposal", passed: true }] };
  }
  const now = new Date(nowMs).toISOString();
  // An admitted read reads now. One its reader may not make, or that fails, stops as an
  // abstention instead of being recorded as done.
  const read = decision.outcome === "succeeded" ? await stepRead(db, tenantId, run, input.action_id, input.args, now) : null;
  if (read && "reason" in read.evaluation) decision = readStop(decision, read.evaluation.reason, run.specialist_id);
  decision = askReviewer(run, input.action_id, decision);
  // A shadowed action is decided as it would be, then recorded as a shadow step: no receipt, permit,
  // person, handoff or effect can come of it (migration 0203).
  // A step past the run's ceiling is not diverted: it abstains as a receipt that names a person.
  // Only an action the owner shadowed for this specialist, never a protective one, is diverted.
  if (!decision.reason_codes.includes("ceiling_reached") && practice.shadow && !practice.stopped && !catalogAction(input.action_id)?.protective) {
    const signal = await db
      .prepare("SELECT subject_aggregate, subject_id FROM agent_signals WHERE tenant_id = ? AND signal_id = ?")
      .bind(tenantId, run.signal_id)
      .first<{ subject_aggregate: string | null; subject_id: string | null }>();
    const sources = input.citations.map((citation) => ({
      fact_id: citation.fact_id,
      version: citation.version,
      hash: snapshot.get(citation.fact_id)?.hash ?? null,
    }));
    const shadow = await recordShadowStep(
      db,
      tenantId,
      { run_id: run.run_id, specialist_id: run.specialist_id, subject_aggregate: signal?.subject_aggregate, subject_id: signal?.subject_id },
      input,
      argsJson,
      argsSha,
      sources,
      decision,
      now,
    );
    return "error" in shadow ? shadow : { shadow };
  }
  const person = decision.reviewer_role ? await namedPerson(db, tenantId, decision.reviewer_role) : null;
  const protective = catalogAction(input.action_id)?.protective === true;
  const delegatedCeiling = !protective && decision.delegation_id ? delegation?.ceiling : null;
  const windowMs = {
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
  } as const;
  const admission: AdmissionSnapshot | null =
    decision.result === "deny"
      ? null
      : {
          guardControls: !protective,
          controlRevision: control.revision,
          delegationId: delegation?.delegation_id ?? null,
          delegatedPermitId: decision.delegation_id,
          windowSince: delegatedCeiling ? new Date(nowMs - windowMs[delegatedCeiling.count.per]).toISOString() : null,
          windowMax: delegatedCeiling?.count.max ?? null,
          proposalId: input.action_id === "lead_fact.confirm" ? (input.args as { proposal_id: string }).proposal_id : null,
        };
  try {
    // An admitted step counts against the run's step ceiling inside the insert itself, so parallel
    // proposals cannot jointly pass it; a step that loses that race is recorded as abstained.
    const ceiling = decision.result === "deny" ? null : DEFAULT_CEILINGS.stepsPerRun;
    const stepId = `step_${crypto.randomUUID()}`;
    const insert = stepInsert(
      db,
      tenantId,
      run,
      input,
      argsJson,
      argsSha,
      decision,
      person,
      now,
      ceiling,
      stepId,
      admission,
      snapshot,
    );
    if (input.action_id === "handoff.create" && decision.outcome === "succeeded") {
      // The count reservation, receipt and canonical signal commit together. A failed delivery
      // rolls back the receipt and its audit event; an exact retry can start the same proposal.
      await db.batch([
        insert,
        await handoffSignalInsert(
          db,
          tenantId,
          run,
          input.args as HandoffArgs,
          input.step_key,
          handoff!.depth,
          now,
          stepId,
        ),
      ]);
    } else {
      // A people-only draft replaces the open drafts of the same record, in the same transaction.
      const replaces =
        PREPARES_PEOPLE_ONLY.has(input.action_id) && decision.permit_kind === "draft" && decision.outcome === "succeeded"
          ? await supersedeDrafts(db, tenantId, { step_id: stepId, action_id: input.action_id, args: input.args, args_sha256: argsSha })
          : null;
      if (replaces) await db.batch([insert, replaces]);
      else await insert.run();
    }
    if (ceiling !== null && !(await stepByKey(db, run.run_id, input.step_key))) {
      const reviewer = catalogSpecialist(run.specialist_id)?.reviewer_role ?? "owner";
      const latestControl = admission?.guardControls
        ? await specialistControl(db, tenantId, run.specialist_id)
        : control;
      const latestDelegation = admission?.guardControls
        ? await currentDelegation(db, tenantId, run.specialist_id, input.action_id)
        : delegation;
      const superseded =
        admission?.guardControls &&
        (latestControl.revision !== control.revision ||
          latestDelegation?.delegation_id !== delegation?.delegation_id ||
          latestDelegation?.setting !== delegation?.setting ||
          latestDelegation?.fallback !== delegation?.fallback);
      // Another confirm of the same proposal landed first: the proposal is used, so this one stops
      // as a confirm of a proposal no longer open.
      const proposalTaken = admission?.proposalId ? (await leadProposal(db, tenantId, admission.proposalId))?.open === false : false;
      // A proposal overtaken by a committed owner control fails `superseded` (contract reason codes):
      // the owner's own change decided it, so no person is handed a task. A ceiling loser abstains.
      const capped = askReviewer(run, input.action_id, {
        ...decision,
        result: "deny",
        outcome: superseded ? "failed" : "abstained",
        reason_codes: [superseded ? "superseded" : proposalTaken ? "fact_stale" : "ceiling_reached"],
        checks: [...decision.checks, { check: superseded ? "delegation" : proposalTaken ? "proposal" : "budget", passed: false }],
        permit_kind: "none",
        delegation_id: null,
        reviewer_role: superseded ? null : reviewer,
      });
      await stepInsert(
        db,
        tenantId,
        run,
        input,
        argsJson,
        argsSha,
        capped,
        capped.reviewer_role ? await namedPerson(db, tenantId, capped.reviewer_role) : null,
        now,
        null,
        undefined,
        null,
        snapshot,
      ).run();
    }
  } catch (error) {
    if (String(error).includes("agent_run_closed")) return { error: "run_closed", status: 409 };
    throw error;
  }
  const step = await stepByKey(db, run.run_id, input.step_key);
  if (!step) return { error: "step_unavailable", status: 503 };
  const replay = await replayStep(db, tenantId, run, step, input, argsSha);
  if ("error" in replay) return replay;
  await executeStep(db, tenantId, run, step, now, notify);
  return answered((await stepByKey(db, run.run_id, input.step_key)) ?? step, read);
}

/**
 * What a read step answers besides its decision (`authority.evaluate`, registry binding
 * `authority_read`): the authority records as its run's reader may read them, or why they were not
 * read. Empty for every other step.
 */
export interface StepRead {
  evaluation?: AuthorityEvaluation | AuthorityReadRefusal;
}

/** The closest abstention code, and the failed check the receipt keeps, for a read that stopped. */
const READ_STOPS = {
  role_may_not_read: { code: "out_of_scope", check: "read_rights" },
  read_failed: { code: "fact_missing", check: "read" },
} as const;

async function stepRead(db: AgentDb, tenantId: string, run: RunRow, actionId: string, args: unknown, now: string): Promise<Required<StepRead> | null> {
  if (registryEntry(actionId)?.binding.kind !== "authority_read") return null;
  const reader = runReader(run);
  const role = typeof reader === "string" ? (catalogSpecialist(reader)?.reviewer_role ?? null) : reader.role;
  return { evaluation: await evaluateAuthority(db, tenantId, role, args as { authority_id: string; job_id: string; assignment_id: string }, now) };
}

/** A read that stopped abstains for the specialist's reviewer, with the reason the read gave. */
function readStop(decision: PolicyDecision, reason: AuthorityReadRefusal["reason"], specialistId: string): PolicyDecision {
  return {
    ...decision,
    result: "deny",
    outcome: "abstained",
    reason_codes: [READ_STOPS[reason].code],
    checks: [...decision.checks, { check: READ_STOPS[reason].check, passed: false }],
    permit_kind: "none",
    delegation_id: null,
    reviewer_role: catalogSpecialist(specialistId)?.reviewer_role ?? "owner",
  };
}

/**
 * The step with what its read answers: the evaluation only when the step is recorded as done, and
 * the reason when the read stopped it, which a repeat reads back from the receipt's failed check.
 */
function answered(step: StepRow, read: Required<StepRead> | null): StepRow & StepRead {
  if (registryEntry(step.action_id)?.binding.kind !== "authority_read") return step;
  const checks = (JSON.parse(step.policy_json) as { checks: Array<{ check: string; passed: boolean }> }).checks;
  const stopped = (Object.keys(READ_STOPS) as Array<AuthorityReadRefusal["reason"]>).find((reason) =>
    checks.some((check) => check.check === READ_STOPS[reason].check && !check.passed),
  );
  if (stopped) return { ...step, evaluation: { reason: stopped } };
  return step.outcome === "succeeded" && read ? { ...step, evaluation: read.evaluation } : step;
}

/**
 * A question to the face asks nothing of anyone else: on an ask run, a step that stops waits on no
 * reviewer, so a question never lands in a Needs you lane. A protective step (an escalation that
 * names its role, a hold) keeps naming its role.
 */
function askReviewer(run: RunRow, actionId: string, decision: PolicyDecision): PolicyDecision {
  if (decision.outcome !== "abstained" || !askRun(run) || catalogAction(actionId)?.protective === true) return decision;
  return { ...decision, reviewer_role: null };
}

async function runSignalRow(db: AgentDb, tenantId: string, run: RunRow): Promise<SignalRow> {
  const signal = await db.prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?").bind(tenantId, run.signal_id).first<SignalRow>();
  if (!signal) throw new Error("run_signal_missing");
  return signal;
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

interface AdmissionSnapshot {
  guardControls: boolean;
  controlRevision: number;
  delegationId: string | null;
  delegatedPermitId: string | null;
  windowSince: string | null;
  windowMax: number | null;
  /** A confirm's proposal: no other admitted confirm may name it by the time this one lands. */
  proposalId: string | null;
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
  admission: AdmissionSnapshot | null = null,
  /** The decided snapshot: it also holds the hash of each field a pointer citation names. */
  snapshot: Map<string, { hash: string }> | null = null,
): BoundStatement {
  const action = catalogAction(input.action_id);
  const context = runContext(run);
  const sources = input.citations.map((citation) => ({
    fact_id: citation.fact_id,
    version: citation.version,
    hash: snapshot?.get(citation.fact_id)?.hash ?? context.facts.find((fact) => fact.fact_id === citation.fact_id)?.hash ?? null,
  }));
  const policy = canonicalJson({
    policy_id: STEP_POLICY_ID,
    version: STEP_POLICY_VERSION,
    result: decision.result,
    checks: decision.checks,
    reason_codes: decision.reason_codes,
  });
  const permit = canonicalJson({
    kind: decision.permit_kind,
    permit_id: null,
    approval_id: null,
    approved_by: null,
    delegation_id: decision.delegation_id,
  });
  const ask = decision.reviewer_role
    ? decision.result === "needs_approval"
      ? "approve_or_decline"
      : decision.permit_kind === "draft"
        ? APPLY_IN_OWN_SCREEN
        : "acknowledge_and_act"
    : null;
  // Sequence, budgets and the policy/control/delegation snapshot are checked in the insert.
  // A committed pause, hold or revoke cannot leave a permit from the earlier policy read. Scalar subqueries, not HAVING without GROUP BY,
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
           AND json_extract(content_json, '$.from_specialist_id') = ?) < ?)
         AND (? = 0 OR EXISTS (SELECT 1 FROM agent_runs WHERE run_id=? AND catalog_version=? AND policy_version=?))
         AND (? = 0 OR (SELECT COALESCE(MAX(revision),0) FROM agent_specialist_controls
           WHERE tenant_id=? AND specialist_id=?) = ?)
         AND (? = 0 OR (SELECT setting_id FROM agent_delegation_settings WHERE tenant_id=?
           AND specialist_id=? AND action_id=? ORDER BY revision DESC LIMIT 1) IS ?)
         AND (? IS NULL OR (SELECT COUNT(*) FROM agent_run_steps WHERE tenant_id=? AND specialist_id=?
           AND action_id=? AND created_at>=? AND json_extract(permit_json,'$.kind')='within_limits') < ?)
         AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM agent_run_steps WHERE tenant_id=? AND specialist_id=? AND action_id=?
           AND json_extract(permit_json,'$.delegation_id')=?
           AND (outcome='unknown' OR reason_code IN ('readback_mismatch','done_by_person'))))
         AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM agent_run_steps WHERE tenant_id=? AND specialist_id='lead_concierge'
           AND action_id='lead_fact.confirm' AND json_extract(args_json,'$.proposal_id')=?
           AND json_extract(policy_json,'$.result')<>'deny'))`,
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
      canonicalJson({
        mode: action?.undo ?? "none",
        action_id: null,
        available: false,
      }),
      canonicalJson({
        surface: null,
        context: { run_id: run.run_id, action_id: input.action_id },
      }),
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
      admission ? 1 : 0,
      run.run_id,
      CATALOG_VERSION,
      `${STEP_POLICY_ID}@${STEP_POLICY_VERSION}`,
      admission?.guardControls ? 1 : 0,
      tenantId,
      run.specialist_id,
      admission?.controlRevision ?? 0,
      admission?.guardControls ? 1 : 0,
      tenantId,
      run.specialist_id,
      input.action_id,
      admission?.delegationId ?? null,
      admission?.windowMax ?? null,
      tenantId,
      run.specialist_id,
      input.action_id,
      admission?.windowSince ?? null,
      admission?.windowMax ?? null,
      admission?.delegatedPermitId ?? null,
      tenantId,
      run.specialist_id,
      input.action_id,
      admission?.delegatedPermitId ?? null,
      admission?.proposalId ?? null,
      tenantId,
      admission?.proposalId ?? null,
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
      signalTime(now),
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
    // Checked separately: a host on gateway config v2 also reports its route (MODEL_ROUTED_SCHEMA).
    model: { type: "null" },
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

const MODEL_PROPERTIES: Record<string, JsonSchema> = {
  provider: { type: "string", maxLength: 32 },
  model: { type: "string", maxLength: 128 },
  models_used: { type: "array", maxItems: 8, items: { type: "string", maxLength: 128 } },
  auth_mode: { type: "string", maxLength: 32 },
  tier: { type: "string", maxLength: 16 },
};
const MODEL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(MODEL_PROPERTIES),
  properties: MODEL_PROPERTIES,
};
const MODEL_ROUTED_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [...Object.keys(MODEL_PROPERTIES), "route_id", "review_of", "mode"],
  properties: {
    ...MODEL_PROPERTIES,
    route_id: { type: "string", pattern: "^[a-z][a-z0-9_.]{1,80}$" },
    review_of: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["run_id", "provider"],
      properties: { run_id: { type: "string", maxLength: 80 }, provider: { type: "string", maxLength: 32 } },
    },
    mode: { type: "string", enum: ["live", "shadow"] },
  },
};

const PROVIDER_ID = { type: "string", pattern: "^[a-z][a-z0-9_]{1,30}$" };
const FAMILY = { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$" };
const MODEL_ID = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$" };
const ROUTE_ID = { type: "string", pattern: "^[a-z][a-z0-9_]{1,40}$" };
/** As agent_qualifications holds it (migration 0203). */
const EFFORT = { type: "string", pattern: "^[a-z][a-z0-9_]{0,15}$" };
const HEX64 = "^[0-9a-f]{64}$";
const COMPLIANCE_REF = "^[a-z][a-z0-9._-]{1,63}$";
/** The run classes that decide which provider accounts may serve a run (docs/COMPLIANCE-REGISTER.md "AI model providers"). */
const RUN_CLASSES = ["live", "shadow", "eval_history", "synthetic"];

/**
 * The close model block of a host on gateway config v3, sent once the open advertised
 * `close_model: 3` (agent-host/src/host/worker.ts `CloseModelV3`): the account (`provider`) and its
 * adapter, the model's family, the route and the hops it passed over, the qualification it relied
 * on, the specialist's release, the gateway configuration and the provider terms it ran under.
 */
const MODEL_V3_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "provider", "adapter", "family", "model", "effort", "models_used", "auth_mode", "billing", "tier", "route_id", "route", "failover",
    "qualification_ref", "release_sha256", "gateway_config_sha256", "review_of", "mode", "compliance_ref", "run_class", "risk_acceptance",
  ],
  properties: {
    provider: PROVIDER_ID,
    adapter: { type: "string", enum: ["openai_compatible", "anthropic_messages", "gemini", "bedrock", "vertex", "claude_agent_sdk", "codex"] },
    family: FAMILY,
    model: MODEL_ID,
    /** The effort of the route that answered, which its qualification names. */
    effort: EFFORT,
    models_used: MODEL_PROPERTIES.models_used,
    /** The account's credential mode. */
    auth_mode: { type: "string", enum: ["api_key", "oauth", "cloud_identity"] },
    billing: { type: "string", enum: ["api", "subscription"] },
    tier: { type: "string", enum: ["routine", "hard", "audit"] },
    route_id: ROUTE_ID,
    route: { type: "string", enum: ["primary", "declared_fallback"] },
    failover: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["route_id", "provider", "model", "family", "reason", "retry_at"],
        properties: {
          route_id: ROUTE_ID,
          provider: PROVIDER_ID,
          model: MODEL_ID,
          /** The family of the hop's registry entry; null when the route had none. */
          family: { type: ["string", "null"], pattern: FAMILY.pattern },
          reason: { type: "string", pattern: "^[a-z][a-z_]{1,63}$" },
          retry_at: { type: ["number", "null"], minimum: 0 },
        },
      },
    },
    qualification_ref: { type: ["string", "null"], pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$" },
    release_sha256: { type: ["string", "null"], pattern: HEX64 },
    gateway_config_sha256: { type: "string", pattern: HEX64 },
    review_of: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["run_id", "family"],
      properties: { run_id: { type: "string", maxLength: 80 }, family: FAMILY },
    },
    mode: { type: "string", enum: ["live", "shadow"] },
    compliance_ref: { type: ["string", "null"], pattern: COMPLIANCE_REF },
    run_class: { type: "string", enum: RUN_CLASSES },
    risk_acceptance: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["ref", "run_class", "reason"],
      properties: { ref: { type: "string", pattern: COMPLIANCE_REF }, run_class: { type: "string", enum: RUN_CLASSES }, reason: { type: "string", maxLength: 500 } },
    },
  },
};

/** A v3 close model block as validated, with the fields the Worker reads. */
interface ModelV3 {
  provider: string;
  family: string;
  model: string;
  effort: string;
  failover: Array<{ provider: string; model: string; family: string | null }>;
  qualification_ref: string | null;
  release_sha256: string | null;
  run_class: string;
}

/** The v3 block of a validated close, or null for a legacy or routed block or none (`family` is v3's alone). */
function modelV3(model: unknown): ModelV3 | null {
  return typeof model === "object" && model !== null && Object.hasOwn(model, "family") ? (model as ModelV3) : null;
}

/** The run classes a close may carry here: eval runs never close on a Worker, and synthetic ones only on synthetic data. */
const CLOSE_RUN_CLASSES: Record<DataClass, ReadonlySet<string>> = {
  business: new Set(["live", "shadow"]),
  synthetic: new Set(["live", "shadow", "synthetic"]),
};

/**
 * The family each provider id of a gateway config v2 host stands for, which a legacy or routed
 * close names in place of a family. No v3 family takes either name (agent-host registry.ts).
 */
const LEGACY_FAMILIES: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai" };

/** A close model block's family: a v3 block's own, a legacy provider's, or null when it names none. */
function familyOf(model: unknown): string | null {
  if (typeof model !== "object" || model === null) return null;
  const v3 = modelV3(model);
  if (v3) return v3.family;
  const provider = (model as { provider?: unknown }).provider;
  return typeof provider === "string" && Object.hasOwn(LEGACY_FAMILIES, provider) ? LEGACY_FAMILIES[provider] : null;
}

/**
 * Whether an audit ran off the reviewed run's family: its own family is known and another, and so
 * is the family of every hop a v3 close passed over. A hop that names no family fails closed.
 */
function independentOf(model: unknown, reviewedFamily: string | null): boolean {
  const family = familyOf(model);
  if (reviewedFamily === null || family === null || family === reviewedFamily) return false;
  const v3 = modelV3(model);
  return !v3 || v3.failover.every((hop) => hop.family !== null && hop.family !== reviewedFamily);
}

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
  no_independent_route: "provider_unavailable",
  no_qualified_route: "no_qualified_route",
  unknown_run_mode: "policy_missing",
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
  dataClass: DataClass = "business",
): Promise<{ result: RunResult } | StoreError> {
  if (run.state === "closed") return { error: "run_closed", status: 409 };
  if (!closeShapeValid(body)) return { error: "invalid_close", status: 422 };
  const close = body as {
    status: "ok" | "abstained";
    reason: string | null;
    output: { decision?: string; reason_code?: string | null } | null;
    model: unknown;
  };
  // Only an ask run may carry a view; the view is checked apart from the run output (face.ts), so
  // on any other run a `view` is an unknown field.
  const ask = askRun(run);
  if (close.status === "ok" && (close.output === null || validate(runOutputSchema, ask ? withoutView(close.output) : close.output).length > 0)) {
    return { error: "invalid_close", status: 422 };
  }
  // A synthetic run needs no qualification and may run on consumer accounts, so it closes only on a
  // Worker that holds synthetic data; an eval run never closes on a Worker. Refused, never recorded.
  const v3 = modelV3(close.model);
  if (v3 && !CLOSE_RUN_CLASSES[dataClass].has(v3.run_class)) return { error: "run_class_refused", status: 422 };
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
  // Per-run independence (contract "Model routing"): an audit of another run that came back from
  // the same model family as that run is not an audit, so it abstains instead of completing. When
  // the reviewed run recorded a model it fails closed: the audit and the reviewed run must each name
  // a known family, and different ones. A reviewed run that recorded no model (it closed without a
  // model's answer, as an expired run does) has no output to be independent of, so it is not checked.
  let refusal: string | null = null;
  if (close.status === "ok" && run.specialist_id === "independent_auditor") {
    const signal = await db.prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?").bind(tenantId, run.signal_id).first<SignalRow>();
    const reviewed = signal ? await reviewedRun(db, tenantId, run.specialist_id, signal) : null;
    if (reviewed && !independentOf(close.model, reviewed.family)) refusal = "provider_unavailable";
  }
  // A live or shadow run relies on its route's qualification (contract "Qualification"): output that
  // came from a route without a current passed qualification of the specialist is not the
  // specialist's work, so the run abstains. A synthetic run needs none; an abstention is left as it is.
  if (close.status === "ok" && refusal === null && v3 && (v3.run_class === "live" || v3.run_class === "shadow")) {
    const holds = await qualificationHolds(db, tenantId, run.specialist_id, v3);
    if (!holds) refusal = "no_qualified_route";
  }
  if (refusal) {
    result = "abstained";
    // Refused output keeps none of its work (the record drops it, below), but an emergency, a safety
    // event or suspected injection it raised stays the reason, so it still reaches a person, on a
    // question's run too.
    const alarm = close.output?.reason_code ?? "";
    reasonCode = PERSON_CODES.has(alarm) ? alarm : refusal;
  }
  const checked = ask ? recordAskClose(body, ask) : { body, verdict: null };
  // Pausing a specialist stops its drafting (contract "Delegation"): a paused specialist's run
  // closes, but its drafts are withheld from the record, counted and never kept.
  const stamped = withDataClass(checked.body, dataClass);
  const kept = (await specialistControl(db, tenantId, run.specialist_id)).paused ? withheldClose(stamped) : stamped;
  const recorded = refusal ? refusedClose(kept, refusal) : kept;
  // The abstention receipt and the close commit together, receipt first, so a closed run never
  // lacks the receipt that names a person and no step lands after the close. A completed ask
  // closes with the face's answer receipt the same way.
  const statements: BoundStatement[] = [];
  // An ask's abstention goes back to its asker: the close always records its receipt, which names
  // nobody, so it lands in no one's Needs you. A question that raises an emergency, a safety event
  // or suspected injection is the exception: its receipt names a person exactly as on any other
  // run, unless an escalating step of the run already named one (that step's exception stands).
  const named = reasonCode ? await namesAPerson(db, run.run_id) : false;
  if (reasonCode && (ask || !named))
    statements.push(await abstentionStep(db, tenantId, run, reasonCode, now, !ask || (PERSON_CODES.has(reasonCode) && !named)));
  // A run that completes yet raises an emergency, a safety event or suspected injection still
  // reaches a named person, unless one of its steps already named one.
  const raised = result === "completed" && PERSON_CODES.has(close.output?.reason_code ?? "") ? (close.output?.reason_code as string) : null;
  if (raised && !(await namesAPerson(db, run.run_id))) statements.push(await abstentionStep(db, tenantId, run, raised, now, true));
  if (ask && result === "completed") statements.push(await answerStep(db, tenantId, run, checked.verdict, now));
  statements.push(
    db
      .prepare("UPDATE agent_runs SET state = 'closed', result = ?, close_json = ?, ended_at = ?, version = version + 1 WHERE run_id = ? AND state = 'open'")
      .bind(result, canonicalJson(recorded), now, run.run_id),
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

/** The close the Worker records for a run that outlived its wall-time ceiling with no close from its host. */
export function expiredClose(run: RunRow, now: string) {
  return {
    status: "abstained",
    reason: "run_expired",
    detail: `No close arrived within the run's ${DEFAULT_CEILINGS.wallTimeMs / 60_000}-minute wall-time ceiling.`,
    output: null,
    model: null,
    hashes: null,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    cost_usd: 0,
    attempts: 0,
    duration_ms: Math.max(0, Date.parse(now) - Date.parse(run.started_at)),
    tool_calls: [],
  };
}

/**
 * Closes an open run past its wall-time ceiling as a ceiling close does: `ceiling_reached`, with its
 * abstention receipt in the same batch, then the receipt's exception. A question's receipt names
 * nobody, as on any close of an ask, and so does an owner report's: its report shows the result.
 * False when the run had closed already.
 */
export async function expireRun(db: AgentDb, tenantId: string, run: RunRow, now: string): Promise<boolean> {
  const ask = askRun(run) !== null;
  const signal = await db.prepare("SELECT watch_id, source FROM agent_signals WHERE tenant_id = ? AND signal_id = ?").bind(tenantId, run.signal_id).first<{ watch_id: string | null; source: string }>();
  const report = signal?.source === WATCH_SIGNAL_SOURCE && signal.watch_id !== null && Object.hasOwn(OWNER_REPORTS, signal.watch_id);
  const named = await namesAPerson(db, run.run_id);
  const statements: BoundStatement[] = [];
  if (ask || !named) statements.push(await abstentionStep(db, tenantId, run, "ceiling_reached", now, !ask && !report));
  statements.push(
    db
      .prepare("UPDATE agent_runs SET state = 'closed', result = 'ceiling_reached', close_json = ?, ended_at = ?, version = version + 1 WHERE run_id = ? AND state = 'open'")
      .bind(canonicalJson(expiredClose(run, now)), now, run.run_id),
  );
  try {
    const results = await db.batch(statements);
    if (changesOf(results.at(-1)) < 1) return false;
  } catch (error) {
    if (String(error).includes("agent_run_closed")) return false;
    throw error;
  }
  await escalateRunAbstention(db, tenantId, run, now, null);
  return true;
}

/**
 * How long past its wall-time ceiling the cron leaves a run open: longer than the host's longest
 * model call chain (agent-host/config/gateway.json: a route and up to three failover hops, each up
 * to 3 attempts of 240 s with backoff, about 48 minutes), so a close still on its way lands instead
 * of meeting `run_closed`. A run the host opens again closes at the ceiling itself (resumeRun).
 * ponytail: a fixed margin; raise it if the gateway's retry, timeout or failover limits grow.
 */
export const EXPIRY_GRACE_MS = 60 * 60_000;

/**
 * Closes every open run past its wall-time ceiling and the grace (expireRun), oldest first, at most
 * `limit` per cron tick. One run that fails to close does not stop the others.
 */
export async function expireRuns(db: AgentDb, tenantId: string, now: string, limit = 50): Promise<{ expired: number; failed: number }> {
  const before = new Date(Date.parse(now) - DEFAULT_CEILINGS.wallTimeMs - EXPIRY_GRACE_MS).toISOString();
  const open = await db
    .prepare("SELECT * FROM agent_runs WHERE tenant_id = ? AND state = 'open' AND started_at < ? ORDER BY started_at ASC, run_id ASC LIMIT ?")
    .bind(tenantId, before, limit)
    .all<RunRow>();
  let expired = 0;
  let failed = 0;
  for (const run of open.results ?? []) {
    try {
      if (await expireRun(db, tenantId, run, now)) expired += 1;
    } catch {
      failed += 1;
    }
  }
  return { expired, failed };
}

/** A close as the Worker records it before any pause: an ask run's view checked, else as received. */
export function recordedClose(run: RunRow, body: unknown, dataClass: DataClass = "business"): unknown {
  const ask = askRun(run);
  return withDataClass(ask ? recordAskClose(body, ask).body : body, dataClass);
}

/** A v3 close also records the data class of the Worker it closed on, beside the run class in its model block. */
function withDataClass(body: unknown, dataClass: DataClass): unknown {
  return modelV3((body as { model?: unknown } | null)?.model) ? { ...(body as Record<string, unknown>), data_class: dataClass } : body;
}

function withoutView(output: unknown): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return output;
  const { view: _view, ...rest } = output as Record<string, unknown>;
  return rest;
}

/**
 * A close whose output the Worker refused (an audit off independence, or a route without the
 * qualification it named): recorded without that output, so no answer, view or draft of it is read
 * back, and with the reason.
 */
export function refusedClose(body: unknown, reason: string): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const { withheld: _withheld, ...close } = body as Record<string, unknown>;
  return { ...close, output: null, refused: { reason } };
}

/** A close as recorded for a paused specialist: drafts removed and counted. Unchanged without drafts. */
export function withheldClose(body: unknown): unknown {
  const close = body as { output?: { drafts?: unknown[] } | null };
  const drafts = close?.output?.drafts;
  if (!Array.isArray(drafts) || drafts.length === 0) return body;
  return { ...close, output: { ...close.output, drafts: [] }, withheld: { drafts: drafts.length, reason: "specialist_paused" } };
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

/** The specialist's own receipt for an abstaining or escalating run: it names a person, except on an ask. */
async function abstentionStep(db: AgentDb, tenantId: string, run: RunRow, reasonCode: string, now: string, namesPerson: boolean): Promise<BoundStatement> {
  const reviewer = namesPerson ? (catalogSpecialist(run.specialist_id)?.reviewer_role ?? "owner") : null;
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
      checks: reviewer ? [{ check: "named_person", passed: true }] : [],
      permit_kind: "within_limits",
      delegation_id: null,
      autonomy: "A2",
      reviewer_role: reviewer,
    },
    reviewer ? await namedPerson(db, tenantId, reviewer) : null,
    now,
  );
}

/**
 * A completed ask's close receipt: the face answered (`fact.explain`, nothing to permit) from the
 * facts its admitted steps cited and the facts its shown view cites, and, when it returned a view,
 * whether the view was shown. A refused view gives the one reason code `view_spec_invalid`, its
 * issues stay in the run record, and its unchecked sources are not the answer's.
 */
async function answerStep(db: AgentDb, tenantId: string, run: RunRow, verdict: ViewVerdict | null, now: string): Promise<BoundStatement> {
  const cited = await citedSources(db, run.run_id);
  const sources = [...cited, ...viewSources(verdict?.view ?? null).filter((source) => !cited.some((fact) => fact.fact_id === source.fact_id))];
  const args = { ask_id: run.signal_id };
  const argsJson = canonicalJson(args);
  const refused = verdict?.issues.length ? ["view_spec_invalid"] : [];
  return stepInsert(
    db,
    tenantId,
    run,
    { action_id: "fact.explain", args, citations: sources.map(({ fact_id, version }) => ({ fact_id, version })), step_key: `answer:${run.run_id}` },
    argsJson,
    await sha256Hex(argsJson),
    {
      result: "allow",
      outcome: "succeeded",
      reason_codes: refused,
      checks: verdict?.offered ? [{ check: "view_spec", passed: refused.length === 0 }] : [],
      permit_kind: "none",
      delegation_id: null,
      autonomy: "A0",
      reviewer_role: null,
    },
    null,
    now,
    null,
    undefined,
    null,
    new Map(sources.map((source) => [source.fact_id, { hash: source.hash }])),
  );
}

/**
 * The facts a run's admitted steps cited, each once, in step order. A step policy admitted (open,
 * succeeded or awaiting its readback) passed the cited and fresh checks; a refused or abstained
 * step's citations (stale, outside the snapshot, denied) stay out. Read before the answer receipt.
 */
export async function citedSources(db: AgentDb, runId: string): Promise<Array<{ fact_id: string; version: number; hash: string }>> {
  const rows = await db
    .prepare("SELECT sources_json FROM agent_run_steps WHERE run_id = ? AND (outcome IS NULL OR outcome IN ('succeeded', 'unknown')) ORDER BY step_seq")
    .bind(runId)
    .all<{ sources_json: string }>();
  const seen = new Set<string>();
  const sources: Array<{ fact_id: string; version: number; hash: string }> = [];
  for (const row of rows.results) {
    for (const source of JSON.parse(row.sources_json) as Array<{ fact_id: string; version: number; hash: string | null }>) {
      if (source.hash === null || seen.has(source.fact_id)) continue;
      seen.add(source.fact_id);
      sources.push({ fact_id: source.fact_id, version: source.version, hash: source.hash });
    }
  }
  return sources;
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
  const model = value.model;
  if (model !== null) {
    // A v3 block is the one with a family; a routed one (gateway config v2) has a route but none.
    const block = typeof model === "object" && !Array.isArray(model) ? (model as object) : null;
    const schema = block && Object.hasOwn(block, "family") ? MODEL_V3_SCHEMA : block && Object.hasOwn(block, "route_id") ? MODEL_ROUTED_SCHEMA : MODEL_SCHEMA;
    if (validate(schema, model).length > 0) return false;
  }
  return validate(CLOSE_SCHEMA, { ...value, output: null, tool_calls: null, model: null }).length === 0;
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
