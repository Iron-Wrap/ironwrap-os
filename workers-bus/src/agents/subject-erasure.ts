// A recorded owner's checked-subject decision, independent commitments, bounded text work and
// actual replay into an older D1 database. No envelope or provider erasure is implied.
import { sha256Hex, validAppCsrf } from "../app-auth.ts";
import type { AuthContext } from "../app-types.ts";
import { controlError, humanGuard, type HumanPrincipal } from "./control.ts";
import { parseFactId } from "./memory.ts";
import { canonicalJson } from "./schema.ts";
import type { AgentDb, BoundStatement, SignalRow } from "./store.ts";
import {
  AgentPrivacyError, decisionDigest, ensureRequestMarker, ensureSignalMarker, listPrivacyMarkers,
  parseErasureScope, readRequestMarker, readSignalMarker, signalMarkerDigest, validateDecision,
  type ErasureDecision, type PrivacyEnv, type SignalErasureMarker,
} from "./privacy-ledger.ts";

export const ERASURE_SIGNAL_BATCH = 10;
export const ERASURE_ARGUMENT_BATCH = 100;
/** A decision larger than this is refused before it is accepted; each call still claims only ten. */
export const ERASURE_MAX_SIGNALS = 100;
export const ERASURE_COPY_LIMITS = [
  "inbound_envelopes_retained_3_years_disposal_deferred", "native_customer_contact_and_operating_facts",
  "confirmed_lead_facts", "run_trigger_goal_context_and_close_copies", "step_policy_readback_and_other_actions",
  "exception_summaries", "host_logs_and_process_memory", "archived_backup_bytes", "model_provider_copies",
] as const;

interface TargetRow {
  tenant_id: string; signal_id: string; erasure_id: string; content_sha256: string; kind: SignalErasureMarker["kind"];
  subject_aggregate: string | null; subject_id: string | null; received_at: string; signal_seq_at_decision: number;
  marker_sha256: string | null; marker_confirmed_at: string | null; recorded_at: string;
}
interface ErasureInput { customer_id: string; expected_customer_version: number;
  verification: { method: "on_file_phone" | "on_file_email"; on_file_check_completed: true; evidence_ref: string } }
const DECISION_COLUMNS = "erasure_id, tenant_id, idempotency_key, request_sha256, customer_id, customer_version, scope_json, signal_seq_ceiling, requested_at, requested_by, verification_method, verification_ref_sha256";
const TARGET_COLUMNS = "tenant_id, signal_id, erasure_id, content_sha256, kind, subject_aggregate, subject_id, received_at, signal_seq_at_decision, marker_sha256, marker_confirmed_at, recorded_at";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
// Each arm uses an exact identity index and stops at one over the accepted request bound.
// Frozen accepted scopes never exceed it; the extra row detects any unexpected expansion.
const nativeSignals = (aggregate: string, identity: string) => `SELECT signal_seq FROM (SELECT signal_seq
  FROM agent_signals INDEXED BY idx_agent_signals_erasure_subject
  WHERE tenant_id = d.tenant_id AND subject_aggregate = '${aggregate}' AND subject_id ${identity}
    AND signal_seq <= d.signal_seq_ceiling AND kind IN ('event', 'owner_request', 'handoff')
  LIMIT ${ERASURE_MAX_SIGNALS + 1})`;
const scopedIds = `(${nativeSignals("customer", "= d.customer_id")}
  UNION ${nativeSignals("lead", "IN (SELECT value FROM json_each(d.scope_json, '$.leads'))")}
  UNION ${nativeSignals("job", "IN (SELECT value FROM json_each(d.scope_json, '$.jobs'))")}
  UNION SELECT signal_seq FROM (SELECT signal_seq FROM agent_signals INDEXED BY idx_agent_signals_erasure_sender
    WHERE tenant_id = d.tenant_id AND kind = 'event' AND json_extract(content_json, '$.sender.customer_id') = d.customer_id
      AND json_type(content_json, '$.sender.conflict') IS 'false'
      AND json_extract(content_json, '$.sender.matched_on') IN ('phone', 'email', 'email_and_phone')
      AND signal_seq <= d.signal_seq_ceiling LIMIT ${ERASURE_MAX_SIGNALS + 1}))`;
const scopedSignals = `FROM agent_signals s JOIN agent_subject_erasures d ON d.tenant_id = s.tenant_id
  WHERE d.tenant_id = ? AND d.erasure_id = ? AND s.signal_seq <= d.signal_seq_ceiling
    AND s.signal_id IN (SELECT json_extract(value, '$.signal_id') FROM json_each(d.scope_json, '$.signals'))`;
const signalTransform = `CASE kind
  WHEN 'event' THEN json_set(json_remove(content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'))
  WHEN 'owner_request' THEN json_set(json_remove(content_json, '$.question'), '$.redacted', json('true'))
  WHEN 'handoff' THEN json_set(json_remove(content_json, '$.reason'), '$.redacted', json('true')) END`;
const argsTransform = `json_set(args_json, '$.fields.service', NULL, '$.fields.scope', NULL,
  '$.fields.address', NULL, '$.fields.timing', NULL, '$.redacted', json('true'))`;
/** Same source/action/lead/citation binding as all three migration exceptions. */
const proposalBinding = `st.specialist_id IS 'lead_concierge' AND st.action_id IS 'lead_fact.propose'
  AND json_type(st.args_json) IS 'object' AND json_type(st.args_json, '$.fields') IS 'object'
  AND json_type(st.args_json, '$.redacted') IS NULL
  AND r.specialist_id IS st.specialist_id AND s.kind IS 'event'
  AND s.source IN ('web_form', 'instant_estimate', 'phone', 'newo_call', 'walk_in', 'office', 'gbp', 'ad', 'referral')
  AND s.subject_aggregate IS 'lead' AND s.subject_id IS json_extract(st.args_json, '$.lead_id')
  AND EXISTS (SELECT 1 FROM json_each(st.sources_json) c
    WHERE json_extract(c.value, '$.fact_id') IS 'signal/' || s.signal_id
      AND json_extract(c.value, '$.version') IS 1 AND json_extract(c.value, '$.hash') IS 'sha256:' || s.content_sha256)`;
function proposalRows(table: "agent_run_steps" | "agent_shadow_steps") {
  return `FROM ${table} st JOIN agent_runs r ON r.run_id = st.run_id AND r.tenant_id = st.tenant_id
    JOIN agent_signals s ON s.signal_id = r.signal_id AND s.tenant_id = r.tenant_id
    WHERE s.tenant_id = ? AND s.signal_id = ? AND ${proposalBinding}`;
}
const fail = (code: string, status = 503): never => { throw new AgentPrivacyError(code, status); };
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function parseInput(value: unknown): ErasureInput {
  if (!exact(value, ["customer_id", "expected_customer_version", "verification"]) || typeof value.customer_id !== "string" || !ID.test(value.customer_id) ||
      !Number.isSafeInteger(value.expected_customer_version) || (value.expected_customer_version as number) < 1 ||
      !exact(value.verification, ["method", "on_file_check_completed", "evidence_ref"]) || value.verification.on_file_check_completed !== true ||
      !["on_file_phone", "on_file_email"].includes(value.verification.method as string) ||
      typeof value.verification.evidence_ref !== "string" || !/^ver_[A-Za-z0-9_-]{8,120}$/.test(value.verification.evidence_ref)) return fail("invalid_erasure_request", 422);
  return value as unknown as ErasureInput;
}
type CurrentTime = string | (() => string);
const currentTime = (time: CurrentTime): string => typeof time === "string" ? time : time();
async function ownerBatch(db: AgentDb, tenantId: string, actor: HumanPrincipal, now: CurrentTime, statements: BoundStatement[] = []) {
  if (actor.role !== "owner") return fail("owner_role_required", 403);
  try { return await db.batch([humanGuard(db, tenantId, actor, currentTime(now), true), ...statements]); }
  catch (error) { const mapped = controlError(error); if (mapped) return fail(mapped.error, mapped.status); throw error; }
}
async function decisionFor(db: AgentDb, tenantId: string, erasureId: string): Promise<ErasureDecision | null> {
  const row = await db.prepare(`SELECT ${DECISION_COLUMNS} FROM agent_subject_erasures WHERE tenant_id = ? AND erasure_id = ?`).bind(tenantId, erasureId).first<ErasureDecision>();
  return row ? validateDecision(row, tenantId, erasureId) : null;
}
function restoreDecisionStatement(db: AgentDb, decision: ErasureDecision) {
  return db.prepare(`INSERT INTO agent_subject_erasures (${DECISION_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM agent_subject_erasures WHERE erasure_id = ? OR (tenant_id = ? AND idempotency_key = ?))`)
    .bind(...DECISION_COLUMNS.split(", ").map((key) => decision[key as keyof ErasureDecision]), decision.erasure_id, decision.tenant_id, decision.idempotency_key);
}
async function assertDecision(db: AgentDb, expected: ErasureDecision): Promise<void> {
  const actual = await decisionFor(db, expected.tenant_id, expected.erasure_id);
  if (!actual || canonicalJson(actual) !== canonicalJson(expected)) fail("privacy_marker_conflict");
}
async function markerForTarget(env: PrivacyEnv, decision: ErasureDecision, target: TargetRow): Promise<SignalErasureMarker> {
  return { version: 1, type: "signal", tenant_id: target.tenant_id, erasure_id: target.erasure_id,
    decision_sha256: await decisionDigest(decision), signal_id: target.signal_id, content_sha256: target.content_sha256,
    kind: target.kind, subject_aggregate: target.subject_aggregate, subject_id: target.subject_id,
    received_at: target.received_at, signal_seq_at_decision: target.signal_seq_at_decision, recorded_at: target.recorded_at };
}
function assertSignalIdentity(signal: SignalRow, marker: SignalErasureMarker): void {
  if (signal.tenant_id !== marker.tenant_id || signal.signal_id !== marker.signal_id || signal.content_sha256 !== marker.content_sha256 ||
      signal.kind !== marker.kind || signal.subject_aggregate !== marker.subject_aggregate || signal.subject_id !== marker.subject_id ||
      signal.received_at !== marker.received_at || signal.signal_seq !== marker.signal_seq_at_decision) fail("privacy_marker_conflict");
}
async function targetFor(db: AgentDb, tenantId: string, signalId: string) {
  return db.prepare(`SELECT ${TARGET_COLUMNS} FROM agent_signal_erasures WHERE tenant_id = ? AND signal_id = ?`).bind(tenantId, signalId).first<TargetRow>();
}
function claimStatement(db: AgentDb, marker: SignalErasureMarker) {
  return db.prepare(`INSERT INTO agent_signal_erasures (${TARGET_COLUMNS}) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?
    WHERE NOT EXISTS (SELECT 1 FROM agent_signal_erasures WHERE tenant_id = ? AND signal_id = ?)`)
    .bind(marker.tenant_id, marker.signal_id, marker.erasure_id, marker.content_sha256, marker.kind, marker.subject_aggregate,
      marker.subject_id, marker.received_at, marker.signal_seq_at_decision, marker.recorded_at, marker.tenant_id, marker.signal_id);
}
async function confirmationStatement(db: AgentDb, marker: SignalErasureMarker, now: string) {
  return db.prepare(`UPDATE agent_signal_erasures SET marker_sha256 = ?, marker_confirmed_at = ?
    WHERE tenant_id = ? AND signal_id = ? AND marker_sha256 IS NULL AND marker_confirmed_at IS NULL`)
    .bind(await signalMarkerDigest(marker), now, marker.tenant_id, marker.signal_id);
}
async function assertTarget(db: AgentDb, marker: SignalErasureMarker, confirmed: boolean): Promise<void> {
  const target = await targetFor(db, marker.tenant_id, marker.signal_id);
  if (!target || target.erasure_id !== marker.erasure_id || target.content_sha256 !== marker.content_sha256 || target.kind !== marker.kind ||
      target.subject_aggregate !== marker.subject_aggregate || target.subject_id !== marker.subject_id || target.received_at !== marker.received_at ||
      target.signal_seq_at_decision !== marker.signal_seq_at_decision || target.recorded_at !== marker.recorded_at ||
      (confirmed && (!target.marker_confirmed_at || target.marker_sha256 !== await signalMarkerDigest(marker)))) fail("privacy_marker_conflict");
}

/** Reconstruct only an independently committed original decision/target; never new verification. */
export async function materializeSignalMarker(db: AgentDb, env: PrivacyEnv, marker: SignalErasureMarker, now: CurrentTime,
  guard?: { actor: HumanPrincipal }): Promise<"present" | "absent"> {
  const request = await readRequestMarker(env, marker.tenant_id, marker.erasure_id);
  if (!request || await decisionDigest(request.decision) !== marker.decision_sha256) return fail("privacy_marker_conflict");
  const decisionInsert = restoreDecisionStatement(db, request.decision);
  if (guard) await ownerBatch(db, marker.tenant_id, guard.actor, now, [decisionInsert]); else await db.batch([decisionInsert]);
  await assertDecision(db, request.decision);
  const signal = await db.prepare("SELECT * FROM agent_signals WHERE tenant_id = ? AND signal_id = ?").bind(marker.tenant_id, marker.signal_id).first<SignalRow>();
  if (!signal) return "absent";
  assertSignalIdentity(signal, marker);
  const statements = [claimStatement(db, marker), await confirmationStatement(db, marker, currentTime(now))];
  if (guard) await ownerBatch(db, marker.tenant_id, guard.actor, now, statements); else await db.batch(statements);
  await assertTarget(db, marker, true);
  return "present";
}

/** Every signal/run response checks independent storage, including after a pre-decision restore. */
export async function assertAgentSignalAvailable(db: AgentDb, env: PrivacyEnv, tenantId: string, signalId: string, now: string): Promise<void> {
  if (!ID.test(signalId)) return fail("privacy_reference_invalid");
  const marker = await readSignalMarker(env, tenantId, signalId);
  if (marker) {
    await materializeSignalMarker(db, env, marker, now);
    return fail("agent_source_erased", 409);
  }
  // This final D1 read also catches an erasure claim that committed during the R2 await.
  const target = await targetFor(db, tenantId, signalId);
  if (target?.marker_confirmed_at) return fail("privacy_marker_missing");
  if (target) return fail("agent_source_erased", 409);
}

/** Check explicit record references, including a resumed run's complete frozen fact references. */
export async function assertAgentValueAvailable(db: AgentDb, env: PrivacyEnv, tenantId: string, value: unknown, now: string): Promise<void> {
  const signals = new Set<string>(), runs = new Set<string>(), steps = new Set<string>(), shadows = new Set<string>();
  let visited = 0;
  function collect(node: unknown, depth = 0): void {
    if (++visited > 50000 || depth > 40) return fail("privacy_reference_bounds");
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) collect(child, depth + 1); return; }
    for (const [key, child] of Object.entries(node)) {
      if (typeof child === "string") {
        if (["signal_id", "ask_id", "run_id", "step_id", "proposal_id", "shadow_step_id"].includes(key) && !ID.test(child)) continue;
        if (key === "signal_id" || key === "ask_id") signals.add(child);
        if (key === "run_id") runs.add(child);
        if (key === "step_id" || key === "proposal_id") steps.add(child);
        if (key === "shadow_step_id") shadows.add(child);
        if (key === "fact_id" || key === "source") {
          const fact = parseFactId(child);
          if (fact?.kind === "signal") signals.add(fact.id);
          if (fact?.kind === "lead_proposal") steps.add(fact.id);
        }
      } else collect(child, depth + 1);
    }
    if (signals.size + runs.size + steps.size + shadows.size > 512) return fail("privacy_reference_bounds");
  }
  collect(value);
  const checkedRuns = new Set<string>(), checkedSteps = new Set<string>(), checkedShadows = new Set<string>();
  for (;;) {
    let advanced = false;
    for (const [table, column, ids, checked] of [["agent_run_steps", "step_id", steps, checkedSteps], ["agent_shadow_steps", "shadow_step_id", shadows, checkedShadows]] as const) {
      for (const id of ids) {
        if (checked.has(id)) continue;
        checked.add(id); advanced = true;
        const row = await db.prepare(`SELECT run_id, sources_json FROM ${table} WHERE tenant_id = ? AND ${column} = ?`).bind(tenantId, id).first<{ run_id: string; sources_json: string }>();
        if (row) { runs.add(row.run_id); collect(JSON.parse(row.sources_json)); }
      }
    }
    for (const runId of runs) {
      if (checkedRuns.has(runId)) continue;
      checkedRuns.add(runId); advanced = true;
      const row = await db.prepare("SELECT signal_id, context_json FROM agent_runs WHERE tenant_id = ? AND run_id = ?").bind(tenantId, runId).first<{ signal_id: string; context_json: string }>();
      if (row) { signals.add(row.signal_id); collect(JSON.parse(row.context_json)); }
    }
    if (!advanced) break;
  }
  for (const signalId of signals) await assertAgentSignalAvailable(db, env, tenantId, signalId, now);
}

// The customer/native links and frontier are read again in the decision INSERT transaction.
const NEW_SCOPE = `WITH c AS (SELECT * FROM operating_customers WHERE tenant_id = ? AND customer_id = ?),
  d AS (SELECT tenant_id, customer_id, version AS customer_version, contact_phone, contact_email,
    json_object('customer_id', customer_id,
      'leads', json((SELECT json_group_array(lead_id) FROM (SELECT l.lead_id FROM operating_leads l WHERE l.tenant_id = c.tenant_id
        AND (l.source_envelope_id = c.source_envelope_id OR l.lead_id IN (SELECT j.lead_id FROM operating_roof_jobs j WHERE j.tenant_id = c.tenant_id AND j.customer_id = c.customer_id)) ORDER BY l.lead_id LIMIT 65))),
      'jobs', json((SELECT json_group_array(roof_job_id) FROM (SELECT j.roof_job_id FROM operating_roof_jobs j WHERE j.tenant_id = c.tenant_id AND j.customer_id = c.customer_id ORDER BY j.roof_job_id LIMIT 65)))) AS scope_json,
    COALESCE((SELECT MAX(signal_seq) FROM agent_signals WHERE tenant_id = c.tenant_id), 0) AS signal_seq_ceiling FROM c),
  frozen AS (SELECT d.*, json_set(scope_json, '$.signals', json((SELECT json_group_array(json_object('signal_id', signal_id, 'content_sha256', content_sha256))
    FROM (SELECT s.signal_id, s.content_sha256 FROM agent_signals s WHERE s.tenant_id = d.tenant_id AND s.signal_seq IN ${scopedIds}
      ORDER BY s.signal_seq LIMIT ${ERASURE_MAX_SIGNALS + 1})))) AS frozen_scope_json FROM d)`;

async function createOrContinue(db: AgentDb, env: PrivacyEnv, tenantId: string, actor: HumanPrincipal, input: ErasureInput, key: string, now: () => string) {
  await ownerBatch(db, tenantId, actor, now);
  const keyHash = await sha256Hex(key);
  const erasureId = `era_${await sha256Hex(canonicalJson([tenantId, keyHash]))}`;
  const refHash = await sha256Hex(input.verification.evidence_ref);
  const requestHash = await sha256Hex(canonicalJson({ customer_id: input.customer_id, expected_customer_version: input.expected_customer_version,
    verification_method: input.verification.method, verification_ref_sha256: refHash }));
  const surviving = await readRequestMarker(env, tenantId, erasureId);
  if (surviving) {
    if (surviving.decision.request_sha256 !== requestHash) return fail("idempotency_conflict", 409);
    await ownerBatch(db, tenantId, actor, now, [restoreDecisionStatement(db, surviving.decision)]);
    await assertDecision(db, surviving.decision);
  }
  let decision = await decisionFor(db, tenantId, erasureId);
  if (!decision) {
    const insert = db.prepare(`${NEW_SCOPE}
      INSERT INTO agent_subject_erasures (${DECISION_COLUMNS})
      SELECT ?, tenant_id, ?, ?, customer_id, customer_version, frozen_scope_json, signal_seq_ceiling, ?, ?, ?, ? FROM frozen d
      WHERE customer_version = ? AND CASE ? WHEN 'on_file_phone' THEN contact_phone IS NOT NULL AND length(trim(contact_phone)) > 0
        WHEN 'on_file_email' THEN contact_email IS NOT NULL AND length(trim(contact_email)) > 0 ELSE 0 END
      AND json_array_length(scope_json, '$.leads') + json_array_length(scope_json, '$.jobs') + 1 <= 64
      AND json_array_length(frozen_scope_json, '$.signals') <= ${ERASURE_MAX_SIGNALS}
      AND NOT EXISTS (SELECT 1 FROM agent_subject_erasures WHERE tenant_id = d.tenant_id AND idempotency_key = ?)`)
      .bind(tenantId, input.customer_id, erasureId, keyHash, requestHash, now(), actor.user_id, input.verification.method, refHash,
        input.expected_customer_version, input.verification.method, keyHash);
    await ownerBatch(db, tenantId, actor, now, [insert]);
    decision = await decisionFor(db, tenantId, erasureId);
    if (!decision) {
      const eligibility = await db.prepare(`${NEW_SCOPE} SELECT customer_version,
        CASE ? WHEN 'on_file_phone' THEN contact_phone IS NOT NULL AND length(trim(contact_phone)) > 0
          WHEN 'on_file_email' THEN contact_email IS NOT NULL AND length(trim(contact_email)) > 0 ELSE 0 END AS has_contact,
        json_array_length(scope_json, '$.leads') + json_array_length(scope_json, '$.jobs') + 1 AS identities,
        json_array_length(frozen_scope_json, '$.signals') AS signals FROM frozen`)
        .bind(tenantId, input.customer_id, input.verification.method).first<{ customer_version: number; has_contact: number; identities: number; signals: number }>();
      if (eligibility?.customer_version === input.expected_customer_version && eligibility.has_contact && (eligibility.identities > 64 || eligibility.signals > ERASURE_MAX_SIGNALS))
        return fail("erasure_supported_scope_exceeded", 422);
      return fail("customer_or_erasure_scope_not_eligible", 422);
    }
  }
  if (decision.request_sha256 !== requestHash) return fail("idempotency_conflict", 409);
  if (!surviving) {
    const claimed = await db.prepare("SELECT 1 AS present FROM agent_signal_erasures WHERE tenant_id = ? AND erasure_id = ? LIMIT 1").bind(tenantId, erasureId).first();
    if (claimed) return fail("privacy_marker_missing");
  }
  await ensureRequestMarker(env, decision);
  await ownerBatch(db, tenantId, actor, now, [db.prepare(`INSERT INTO agent_signal_erasures (${TARGET_COLUMNS})
    SELECT s.tenant_id, s.signal_id, d.erasure_id, s.content_sha256, s.kind, s.subject_aggregate, s.subject_id, s.received_at,
      s.signal_seq, NULL, NULL, ? ${scopedSignals}
      AND NOT EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = s.tenant_id AND e.signal_id = s.signal_id)
      ORDER BY s.signal_seq LIMIT ${ERASURE_SIGNAL_BATCH}`).bind(now(), tenantId, erasureId)]);
  const targets = (await db.prepare(`SELECT ${TARGET_COLUMNS.split(", ").map((v) => `e.${v}`).join(", ")}
    FROM agent_signal_erasures e JOIN agent_signals s ON s.tenant_id = e.tenant_id AND s.signal_id = e.signal_id
    WHERE e.tenant_id = ? AND e.signal_id IN (SELECT s.signal_id ${scopedSignals}) AND (e.marker_confirmed_at IS NULL OR json_type(s.content_json, '$.redacted') IS NOT 'true'
      OR EXISTS (SELECT 1 FROM agent_run_steps st JOIN agent_runs r ON r.run_id = st.run_id AND r.tenant_id = st.tenant_id WHERE r.signal_id = s.signal_id AND r.tenant_id = s.tenant_id AND ${proposalBinding})
      OR EXISTS (SELECT 1 FROM agent_shadow_steps st JOIN agent_runs r ON r.run_id = st.run_id AND r.tenant_id = st.tenant_id WHERE r.signal_id = s.signal_id AND r.tenant_id = s.tenant_id AND ${proposalBinding}))
    ORDER BY e.signal_seq_at_decision LIMIT ${ERASURE_SIGNAL_BATCH}`).bind(tenantId, tenantId, erasureId).all<TargetRow>()).results;
  let argumentBudget = ERASURE_ARGUMENT_BATCH;
  for (const target of targets) {
    const originalDecision = target.erasure_id === decision.erasure_id ? decision : await decisionFor(db, tenantId, target.erasure_id);
    if (!originalDecision) return fail("privacy_marker_conflict");
    const originalRequest = await readRequestMarker(env, tenantId, target.erasure_id);
    if (!originalRequest || canonicalJson(originalRequest.decision) !== canonicalJson(originalDecision)) return fail("privacy_marker_conflict");
    const marker = await markerForTarget(env, originalDecision, target);
    if (target.marker_confirmed_at) {
      const actual = await readSignalMarker(env, tenantId, target.signal_id);
      if (!actual) return fail("privacy_marker_missing");
      if (canonicalJson(actual) !== canonicalJson(marker)) return fail("privacy_marker_conflict");
    } else await ensureSignalMarker(env, marker);
    await ownerBatch(db, tenantId, actor, now, [await confirmationStatement(db, marker, currentTime(now))]);
    await assertTarget(db, marker, true);
    argumentBudget -= await eraseCoveredText(db, tenantId, actor, marker, now, argumentBudget);
  }
  return erasureStatus(db, env, tenantId, actor, erasureId, now);
}

async function eraseCoveredText(db: AgentDb, tenantId: string, actor: HumanPrincipal, marker: SignalErasureMarker, now: () => string, argumentBudget: number): Promise<number> {
  const statements: BoundStatement[] = [db.prepare(`UPDATE agent_signals SET content_json = ${signalTransform}
    WHERE tenant_id = ? AND signal_id = ? AND json_extract(content_json, '$.redacted') IS NULL`).bind(tenantId, marker.signal_id)];
  let count = 0;
  for (const table of ["agent_run_steps", "agent_shadow_steps"] as const) {
    const column = table === "agent_run_steps" ? "step_id" : "shadow_step_id";
    const ids = (await db.prepare(`SELECT st.${column} AS id ${proposalRows(table)} ORDER BY st.rowid LIMIT ?`).bind(tenantId, marker.signal_id, argumentBudget - count).all<{ id: string }>()).results.map((r) => r.id);
    if (ids.length) statements.push(db.prepare(`UPDATE ${table} SET args_json = ${argsTransform} WHERE tenant_id = ? AND ${column} IN (SELECT value FROM json_each(?))`).bind(tenantId, JSON.stringify(ids)));
    count += ids.length;
  }
  await ownerBatch(db, tenantId, actor, now, statements);
  return count;
}

async function erasureStatus(db: AgentDb, env: PrivacyEnv, tenantId: string, actor: HumanPrincipal, erasureId: string, now: () => string) {
  await ownerBatch(db, tenantId, actor, now);
  const decision = await decisionFor(db, tenantId, erasureId);
  if (!decision) return fail("erasure_not_found", 404);
  const request = await readRequestMarker(env, tenantId, erasureId);
  if (!request || canonicalJson(request.decision) !== canonicalJson(decision)) return fail(request ? "privacy_marker_conflict" : "privacy_marker_missing");
  const signals = (await db.prepare(`SELECT s.* ${scopedSignals} ORDER BY s.signal_seq LIMIT ${ERASURE_MAX_SIGNALS + 1}`).bind(tenantId, erasureId).all<SignalRow>()).results;
  if (signals.length > ERASURE_MAX_SIGNALS) return fail("privacy_scope_bounds");
  const frozenScope = parseErasureScope(decision.scope_json);
  const frozenHashes = new Map(frozenScope.signals.map((entry) => [entry.signal_id, entry.content_sha256]));
  const present = new Set(signals.map((signal) => signal.signal_id));
  const absent = frozenScope.signals.filter((entry) => !present.has(entry.signal_id)).map((entry) => entry.signal_id);
  let pendingSignals = absent.length, pendingArguments = 0;
  for (const signal of signals) {
    if (frozenHashes.get(signal.signal_id) !== signal.content_sha256) return fail("privacy_marker_conflict");
    const target = await targetFor(db, tenantId, signal.signal_id);
    const marker = await readSignalMarker(env, tenantId, signal.signal_id);
    if (marker) {
      assertSignalIdentity(signal, marker);
      const originalRequest = await readRequestMarker(env, tenantId, marker.erasure_id);
      if (!originalRequest || await decisionDigest(originalRequest.decision) !== marker.decision_sha256) return fail("privacy_marker_conflict");
      if (target) await assertTarget(db, marker, !!target.marker_confirmed_at);
    } else if (target?.marker_confirmed_at) return fail("privacy_marker_missing");
    if (!marker || !target?.marker_confirmed_at || JSON.parse(signal.content_json).redacted !== true) pendingSignals++;
    for (const table of ["agent_run_steps", "agent_shadow_steps"] as const) {
      const n = await db.prepare(`SELECT COUNT(*) AS n ${proposalRows(table)}`).bind(tenantId, signal.signal_id).first<{ n: number }>();
      pendingArguments += Number(n?.n ?? 0);
    }
  }
  await ownerBatch(db, tenantId, actor, now);
  return { erasure_id: erasureId, decision, completed: pendingSignals === 0 && pendingArguments === 0,
    eligible_signals: frozenScope.signals.length, present_signals: signals.length, absent_signal_ids: absent, remaining_signals: pendingSignals, remaining_argument_rows: pendingArguments,
    coverage: ["eligible_signal_text", "source_bound_live_and_shadow_lead_fact_proposal_fields"], unreached_copies: ERASURE_COPY_LIMITS };
}

interface ReplayCursor { phase: "external" | "expected"; after: string | null; last: string | null; pending: string | null; next: string | null }
function encodeReplay(value: ReplayCursor): string { return btoa(canonicalJson(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function decodeReplay(value: unknown): ReplayCursor {
  if (value === null || value === undefined) return { phase: "external", after: null, last: null, pending: null, next: null };
  if (typeof value !== "string" || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) return fail("invalid_cursor", 400);
  let parsed: unknown;
  try { parsed = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))); } catch { return fail("invalid_cursor", 400); }
  if (!exact(parsed, ["phase", "after", "last", "pending", "next"]) || !["external", "expected"].includes(parsed.phase as string) || [parsed.after, parsed.next].some((v) => v !== null && (typeof v !== "string" || v.length > 2048)) ||
      [parsed.last, parsed.pending].some((v) => v !== null && (typeof v !== "string" || !ID.test(v)))) return fail("invalid_cursor", 400);
  return parsed as unknown as ReplayCursor;
}
async function reapply(db: AgentDb, env: PrivacyEnv, tenantId: string, actor: HumanPrincipal, cursor: unknown, now: () => string) {
  await ownerBatch(db, tenantId, actor, now);
  const state = decodeReplay(cursor);
  let marker: SignalErasureMarker, next: string | null;
  if (state.pending) {
    const existing = await readSignalMarker(env, tenantId, state.pending);
    if (!existing) return fail("privacy_marker_missing");
    marker = existing; next = state.next;
  } else if (state.phase === "expected") {
    const target = await db.prepare("SELECT signal_id FROM agent_signal_erasures WHERE tenant_id = ? AND signal_id > ? ORDER BY signal_id LIMIT 1")
      .bind(tenantId, state.last ?? "").first<{ signal_id: string }>();
    if (!target) return { page_applied: true, next_cursor: null, absent_signal_ids: [], unreached_copies: ERASURE_COPY_LIMITS };
    const expected = await readSignalMarker(env, tenantId, target.signal_id);
    if (!expected) return fail("privacy_marker_missing");
    marker = expected; next = null;
  } else {
    const page = await listPrivacyMarkers(env, tenantId, "signals", 1, state.after ?? undefined);
    if (!page.markers.length) {
      if (page.next_cursor) return fail("privacy_marker_conflict");
      return { page_applied: true, next_cursor: encodeReplay({ phase: "expected", after: null, last: null, pending: null, next: null }), absent_signal_ids: [], unreached_copies: ERASURE_COPY_LIMITS };
    }
    marker = page.markers[0] as SignalErasureMarker; next = page.next_cursor;
    // R2 lists keys lexically; progress by key also rejects cycles across multiple pages.
    if (state.last !== null && marker.signal_id <= state.last) return fail("privacy_marker_conflict");
  }
  const presence = await materializeSignalMarker(db, env, marker, now, { actor });
  if (presence === "present") await eraseCoveredText(db, tenantId, actor, marker, now, ERASURE_ARGUMENT_BATCH);
  let pending = false;
  if (presence === "present") for (const table of ["agent_run_steps", "agent_shadow_steps"] as const) {
    if (await db.prepare(`SELECT 1 AS present ${proposalRows(table)} LIMIT 1`).bind(tenantId, marker.signal_id).first()) pending = true;
  }
  // Re-read both independent commitments before acknowledging this page.
  const actual = await readSignalMarker(env, tenantId, marker.signal_id);
  const request = await readRequestMarker(env, tenantId, marker.erasure_id);
  if (!actual || canonicalJson(actual) !== canonicalJson(marker) || !request || await decisionDigest(request.decision) !== marker.decision_sha256) return fail("privacy_marker_conflict");
  await ownerBatch(db, tenantId, actor, now);
  return { page_applied: !pending, next_cursor: pending ? encodeReplay({ ...state, pending: marker.signal_id, next })
    : state.phase === "expected" ? encodeReplay({ phase: "expected", after: null, last: marker.signal_id, pending: null, next: null })
    : next ? encodeReplay({ phase: "external", after: next, last: marker.signal_id, pending: null, next: null })
    : encodeReplay({ phase: "expected", after: null, last: null, pending: null, next: null }),
    absent_signal_ids: presence === "absent" ? [marker.signal_id] : [], unreached_copies: ERASURE_COPY_LIMITS };
}

const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
export function agentPrivacyResponse(error: unknown): Response | null {
  if (error instanceof AgentPrivacyError) {
    if (error.code === "erasure_supported_scope_exceeded") return response({ error: error.code, accepted: false, completed: false,
      supported_scope: { max_identities: 64, max_signals: ERASURE_MAX_SIGNALS }, next_step: "extended_scope_erasure_required" }, error.status);
    return response({ error: error.code }, error.status);
  }
  if (/no such table: agent_(subject|signal)_erasures/.test(String(error))) return response({ error: "privacy_schema_unavailable" }, 503);
  if (String(error).includes("agent_source_erased")) return response({ error: "agent_source_erased" }, 409);
  if (/agent_erasure_|agent_(signal|subject)_erasures_append_only/.test(String(error))) return response({ error: "privacy_marker_conflict" }, 503);
  return null;
}
/** Return null for other app routes; erasure routes accept only the existing browser session. */
export async function handleSubjectErasureRoute(req: Request, env: PrivacyEnv & { DB: unknown }, auth: AuthContext, clock: () => number): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (!path.startsWith("/api/v1/agent-team/privacy/")) return null;
  const db = env.DB as AgentDb, tenantId = auth.session.tenant_id;
  const actor: HumanPrincipal = { user_id: auth.session.user_id, role: auth.session.role, session_hash: auth.session.session_hash };
  const now = () => new Date(clock()).toISOString();
  await ownerBatch(db, tenantId, actor, now());
  const detail = path.match(/^\/api\/v1\/agent-team\/privacy\/erasures\/(era_[0-9a-f]{64})$/);
  if (req.method === "GET" && detail) return response(await erasureStatus(db, env, tenantId, actor, detail[1], now));
  if (req.method === "GET" && path === "/api/v1/agent-team/privacy/erasure-markers") {
    const url = new URL(req.url), kind = url.searchParams.get("kind") ?? "signals";
    if (kind !== "signals" && kind !== "requests") return fail("invalid_query", 400);
    const page = await listPrivacyMarkers(env, tenantId, kind, Number(url.searchParams.get("limit") ?? "10"), url.searchParams.get("cursor") ?? undefined);
    await ownerBatch(db, tenantId, actor, now());
    return response(page);
  }
  if (req.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  if (!validAppCsrf(req, auth)) return response({ error: "csrf_failed" }, 403);
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > 16384) return response({ error: "body_too_large" }, 413);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { return response({ error: "invalid_body" }, 400); }
  if (path === "/api/v1/agent-team/privacy/erasures/reapply") {
    if (!exact(body, ["cursor"])) return response({ error: "invalid_body" }, 400);
    return response(await reapply(db, env, tenantId, actor, body.cursor, now));
  }
  if (path !== "/api/v1/agent-team/privacy/erasures") return response({ error: "not_found" }, 404);
  const key = req.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return response({ error: "idempotency_key_required" }, 400);
  const result = await createOrContinue(db, env, tenantId, actor, parseInput(body), key, now);
  return response(result, result.completed ? 200 : 202);
}
