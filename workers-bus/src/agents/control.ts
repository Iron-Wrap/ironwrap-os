// The owner's control over the AI team, and the internal effects of protective steps.
//
// Delegation settings and specialist controls are append-only revisions written only from an
// owner session; no agent route reaches them. Decisions on steps that ask first bind the exact
// step version and argument hash. Protective steps whose machine path is proven (an exception for
// a named person, a specialist hold) execute here with an owned-store readback, and so does an
// approved `authority.record`, inside its decision's own transaction.

import { ROLE_PERMISSIONS, type AppRole } from "../app-types.ts";
import { competencyApproverRefusal, planCompetencyCommand } from "../authority-record-native.ts";
import { CATALOG, CATALOG_VERSION, catalogAction, catalogSpecialist } from "./catalog.ts";
import { citedFacts } from "./memory.ts";
import { STEP_POLICY_ID, STEP_POLICY_VERSION, type Citation, type DelegationSetting } from "./policy.ts";
import { CEILING_SCHEMA, competencyCommandError, registryEntry, type CompetencyCommand } from "./registry.ts";
import { afterCatastrophe, decisionAgreement, shadowSetting, unqualifiedSince } from "./shadow.ts";
import { canonicalJson, validate, type JsonSchema } from "./schema.ts";
import {
  changesOf,
  getRun,
  namedPerson,
  runContext,
  runFactReader,
  type AgentDb,
  type BoundStatement,
  type RunRow,
  type StepRow,
  type StoreError,
} from "./store.ts";

export type Notify = (subject: string, text: string) => Promise<void>;

export interface HumanPrincipal {
  user_id: string;
  role: string;
  session_hash: string;
}
export const STEP_UP_MAX_AGE_MS = 5 * 60_000;
const POLICY_VERSION = `${STEP_POLICY_ID}@${STEP_POLICY_VERSION}`;

/** Re-read the signed-in person inside the write transaction; body fields grant no authority. */
export function humanGuard(
  db: AgentDb,
  tenantId: string,
  actor: HumanPrincipal,
  now: string,
  ownerOnly: boolean,
): BoundStatement {
  return db
    .prepare(
      `INSERT INTO agent_control_guard (kind) SELECT 'authority' WHERE NOT EXISTS (
    SELECT 1 FROM app_sessions s JOIN app_users u ON u.user_id = s.user_id AND u.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.session_hash = ? AND s.user_id = ? AND s.revoked_at IS NULL
      AND s.expires_at > ? AND s.created_at <= ? AND u.active = 1
      AND COALESCE(u.access_role, u.role) = ?
      AND (? = 0 OR (COALESCE(u.access_role, u.role) = 'owner' AND s.created_at >= ?))
  )`,
    )
    .bind(
      tenantId,
      actor.session_hash,
      actor.user_id,
      now,
      now,
      actor.role,
      ownerOnly ? 1 : 0,
      new Date(Date.parse(now) - STEP_UP_MAX_AGE_MS).toISOString(),
    );
}

export function changedGuard(db: AgentDb, kind: "version" | "step"): BoundStatement {
  return db.prepare("INSERT INTO agent_control_guard (kind) SELECT ? WHERE changes() <> 1").bind(kind);
}

export function controlError(error: unknown): StoreError | null {
  const text = String(error);
  if (text.includes("agent_control_authority")) return { error: "session_authority_changed", status: 403 };
  if (
    /agent_control_(version|step)|UNIQUE|agent_step_decided|agent_(delegation_settings|specialist_controls|step_decisions)_append_only/.test(
      text,
    )
  )
    return { error: "stale_version", status: 409 };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Delegation settings

export interface Ceiling {
  count: { max: number; per: "hour" | "day" | "week" };
  amount: { max_minor: number; currency: string } | null;
  recipients: string[] | null;
}

export const WINDOW_MS = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

export async function currentDelegation(
  db: AgentDb,
  tenantId: string,
  specialistId: string,
  actionId: string,
): Promise<
  | (DelegationSetting & {
      ceiling: Ceiling | null;
      revision: number;
      fallback: boolean;
      set_at: string;
      /** `person:<user id>`, or the system writer (`system:auto_demotion`). */
      set_by: string;
    })
  | null
> {
  const row = await db
    .prepare(
      `SELECT * FROM agent_delegation_settings
    WHERE tenant_id = ? AND specialist_id = ? AND action_id = ? ORDER BY revision DESC LIMIT 1`,
    )
    .bind(tenantId, specialistId, actionId)
    .first<{
      setting_id: string;
      setting: DelegationSetting["setting"];
      ceiling_json: string | null;
      revision: number;
      control_revision: number;
      catalog_version: string;
      policy_version: string;
      set_at: string;
      set_by_user_id: string;
    }>();
  if (!row) return null;
  const hold = await db
    .prepare(
      `SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_specialist_controls
    WHERE tenant_id = ? AND specialist_id = ? AND held = 1`,
    )
    .bind(tenantId, specialistId)
    .first<{ revision: number }>();
  const failed = await db
    .prepare(
      `SELECT step_id FROM agent_run_steps WHERE tenant_id = ?
    AND json_extract(permit_json, '$.delegation_id') = ?
    AND (outcome = 'unknown' OR reason_code IN ('readback_mismatch', 'done_by_person')) LIMIT 1`,
    )
    .bind(tenantId, row.setting_id)
    .first<{ step_id: string }>();
  // Each trigger holds until the owner sets the action again (contract "Delegation" item 7); a
  // release that changed without passing qualification counts from the setting's own time.
  const fallback =
    row.setting === "within_limits" &&
    (row.control_revision < Number(hold?.revision ?? 0) ||
      row.catalog_version !== CATALOG_VERSION ||
      row.policy_version !== POLICY_VERSION ||
      failed !== null ||
      (await unqualifiedSince(db, tenantId, specialistId, row.set_at)));
  return {
    delegation_id: row.setting_id,
    setting: fallback ? "asks_first" : row.setting,
    ceiling: row.ceiling_json ? JSON.parse(row.ceiling_json) : null,
    revision: row.revision,
    fallback,
    set_at: row.set_at,
    set_by: row.set_by_user_id.startsWith("system:") ? row.set_by_user_id : `person:${row.set_by_user_id}`,
  };
}

/** Whether a proposed step stays inside a within-limits ceiling: count in the window, amount, recipient. */
export async function withinCeiling(
  db: AgentDb,
  tenantId: string,
  specialistId: string,
  actionId: string,
  ceiling: Ceiling | null,
  args: unknown,
  nowMs: number,
): Promise<boolean> {
  if (!ceiling) return false;
  const since = new Date(nowMs - WINDOW_MS[ceiling.count.per]).toISOString();
  const used = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_run_steps
       WHERE tenant_id = ? AND specialist_id = ? AND action_id = ? AND created_at >= ?
         AND json_extract(permit_json, '$.kind') = 'within_limits'`,
    )
    .bind(tenantId, specialistId, actionId, since)
    .first<{ n: number }>();
  if (Number(used?.n ?? 0) >= ceiling.count.max) return false;
  return stepFitsCeiling(ceiling, args);
}

/** Whether one step's amount and recipient fit a ceiling; its count per window is checked apart. */
export function stepFitsCeiling(ceiling: Ceiling, args: unknown): boolean {
  const value = (args ?? {}) as {
    amount_minor?: unknown;
    currency?: unknown;
    to?: unknown;
  };
  if (value.amount_minor !== undefined) {
    if (!ceiling.amount) return false;
    if (
      value.currency !== ceiling.amount.currency ||
      !Number.isSafeInteger(value.amount_minor) ||
      (value.amount_minor as number) < 0 ||
      (value.amount_minor as number) > ceiling.amount.max_minor
    )
      return false;
  }
  if (value.to !== undefined) {
    if (!ceiling.recipients || typeof value.to !== "string" || !ceiling.recipients.includes(value.to)) return false;
  }
  return true;
}

export interface SetDelegationInput {
  specialist_id: string;
  action_id: string;
  setting: DelegationSetting["setting"];
  ceiling: Ceiling | null;
  reason: string;
  expected_revision: number;
}

/**
 * Records the owner's new setting for one specialist and action. Only A2 and A3 actions the
 * specialist owns, that are delegable or start off, and never protective or people-only ones.
 */
export async function setDelegation(
  db: AgentDb,
  tenantId: string,
  input: SetDelegationInput,
  actor: HumanPrincipal,
  idempotencyKey: string,
  now: string,
): Promise<{ setting_id: string; revision: number } | StoreError> {
  if (actor.role !== "owner") return { error: "owner_role_required", status: 403 };
  const action = catalogAction(input.action_id);
  if (!action || !catalogSpecialist(input.specialist_id) || !action.owners.includes(input.specialist_id))
    return { error: "unknown_action", status: 422 };
  if ((action.autonomy !== "A2" && action.autonomy !== "A3") || action.protective || action.human_only)
    return { error: "not_delegable", status: 422 };
  const startsOff = action.default_delegation === "off_until_enabled";
  const allowed = startsOff ? ["within_limits", "off"] : action.delegable ? ["asks_first", "within_limits", "off"] : [];
  if (!allowed.includes(input.setting)) return { error: "not_delegable", status: 422 };
  if ((input.setting === "within_limits") !== (input.ceiling !== null))
    return { error: "ceiling_required", status: 422 };
  if (input.ceiling && validate(CEILING_SCHEMA, input.ceiling).length > 0)
    return { error: "invalid_ceiling", status: 422 };
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 600)
    return { error: "reason_required", status: 422 };
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0)
    return { error: "invalid_version", status: 422 };
  const prior = await db
    .prepare("SELECT * FROM agent_delegation_settings WHERE tenant_id = ? AND idempotency_key = ?")
    .bind(tenantId, idempotencyKey)
    .first<{
      setting_id: string;
      revision: number;
      specialist_id: string;
      action_id: string;
      setting: string;
      ceiling_json: string | null;
      reason: string;
      set_by_user_id: string;
    }>();
  const ceiling = input.ceiling ? canonicalJson(input.ceiling) : null;
  if (prior) {
    // A replay cannot alias another specialist, ceiling, actor or expected revision.
    const matches =
      prior.specialist_id === input.specialist_id &&
      prior.action_id === input.action_id &&
      prior.setting === input.setting &&
      prior.ceiling_json === ceiling &&
      prior.reason === input.reason.trim() &&
      prior.set_by_user_id === actor.user_id &&
      prior.revision === input.expected_revision + 1;
    if (!matches) return { error: "idempotency_conflict", status: 409 };
    try {
      await db.batch([humanGuard(db, tenantId, actor, now, true)]);
    } catch (error) {
      const refusal = controlError(error);
      if (refusal) return refusal;
      throw error;
    }
    return { setting_id: prior.setting_id, revision: prior.revision };
  }
  const control = await specialistControl(db, tenantId, input.specialist_id);
  if (control.held && input.setting === "within_limits") return { error: "specialist_held", status: 409 };
  const settingId = `dlg_${crypto.randomUUID()}`;
  try {
    await db.batch([
      humanGuard(db, tenantId, actor, now, true),
      db
        .prepare(
          `INSERT INTO agent_control_guard (kind) SELECT 'version' WHERE
        (SELECT COALESCE(MAX(revision),0) FROM agent_delegation_settings WHERE tenant_id=? AND specialist_id=? AND action_id=?) <> ?
        OR (SELECT COALESCE(MAX(revision),0) FROM agent_specialist_controls WHERE tenant_id=? AND specialist_id=?) <> ?`,
        )
        .bind(
          tenantId,
          input.specialist_id,
          input.action_id,
          input.expected_revision,
          tenantId,
          input.specialist_id,
          control.revision,
        ),
      db
        .prepare(
          `INSERT INTO agent_delegation_settings (setting_id,tenant_id,specialist_id,action_id,revision,
        control_revision,catalog_version,policy_version,setting,ceiling_json,reason,set_by_user_id,set_at,idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          settingId,
          tenantId,
          input.specialist_id,
          input.action_id,
          input.expected_revision + 1,
          control.revision,
          CATALOG_VERSION,
          POLICY_VERSION,
          input.setting,
          ceiling,
          input.reason.trim(),
          actor.user_id,
          now,
          idempotencyKey,
        ),
      changedGuard(db, "version"),
      // Any other setting ends shadow for the action, in the same transaction.
      db
        .prepare(
          `INSERT INTO agent_shadow_settings (setting_id,tenant_id,specialist_id,action_id,revision,shadow,reason,set_by_user_id,set_at,idempotency_key)
        SELECT ?,?,?,?,(SELECT MAX(revision)+1 FROM agent_shadow_settings WHERE tenant_id=? AND specialist_id=? AND action_id=?),0,?,?,?,?
        WHERE (SELECT shadow FROM agent_shadow_settings WHERE tenant_id=? AND specialist_id=? AND action_id=? ORDER BY revision DESC LIMIT 1) = 1`,
        )
        .bind(
          `shd_${crypto.randomUUID()}`,
          tenantId,
          input.specialist_id,
          input.action_id,
          tenantId,
          input.specialist_id,
          input.action_id,
          input.reason.trim(),
          actor.user_id,
          now,
          `${idempotencyKey}:shadow_off`,
          tenantId,
          input.specialist_id,
          input.action_id,
        ),
      // Supersede every unexecuted permit issued under the prior setting, inside this transaction.
      db
        .prepare(
          `UPDATE agent_run_steps SET outcome='failed',reason_code='superseded',decided_at=?,version=version+1
        WHERE tenant_id=? AND specialist_id=? AND action_id=? AND outcome IS NULL
          AND json_extract(permit_json,'$.delegation_id') IS NOT NULL`,
        )
        .bind(now, tenantId, input.specialist_id, input.action_id),
    ]);
  } catch (error) {
    const refusal = controlError(error);
    if (
      refusal?.status === 409 &&
      (await db
        .prepare("SELECT setting_id FROM agent_delegation_settings WHERE tenant_id=? AND idempotency_key=?")
        .bind(tenantId, idempotencyKey)
        .first())
    )
      return await setDelegation(db, tenantId, input, actor, idempotencyKey, now);
    if (refusal) return refusal;
    throw error;
  }
  return { setting_id: settingId, revision: input.expected_revision + 1 };
}

/** Each delegable action of a specialist, its start state, current setting and decision history. */
export async function delegationOverview(db: AgentDb, tenantId: string, specialistId: string) {
  const specialist = catalogSpecialist(specialistId);
  if (!specialist) return null;
  const actions = [];
  for (const action of catalogActionsFor(specialistId)) {
    if ((action.autonomy !== "A2" && action.autonomy !== "A3") || action.human_only) continue;
    const current = await currentDelegation(db, tenantId, specialistId, action.action_id);
    actions.push({
      action_id: action.action_id,
      autonomy: action.autonomy,
      protective: action.protective,
      delegable: action.delegable,
      starts: action.default_delegation,
      setting: current
        ? {
            setting_id: current.delegation_id,
            setting: current.setting,
            ceiling: current.ceiling,
            revision: current.revision,
            fallback: current.fallback,
          }
        : null,
      history: await decisionHistory(db, tenantId, specialistId, action.action_id),
      machine_path_proven: registryEntry(action.action_id)?.machinePermitProven ?? false,
      // Shadow is the fourth delegation value, kept in its own revisions (migration 0203).
      shadow: await shadowSetting(db, tenantId, specialistId, action.action_id),
    });
  }
  return {
    specialist_id: specialistId,
    control: await specialistControl(db, tenantId, specialistId),
    actions,
  };
}

/** One action's proposals for one specialist and how people decided them. */
export async function decisionHistory(db: AgentDb, tenantId: string, specialistId: string, actionId: string) {
  const history = await db
    .prepare(
      `SELECT
         COUNT(*) AS proposed,
         SUM(CASE WHEN d.decision = 'approve' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN d.decision = 'decline' THEN 1 ELSE 0 END) AS declined,
         SUM(CASE WHEN d.decision = 'do_it_myself' THEN 1 ELSE 0 END) AS done_by_person
       FROM agent_run_steps s LEFT JOIN agent_step_decisions d ON d.step_id = s.step_id
       WHERE s.tenant_id = ? AND s.specialist_id = ? AND s.action_id = ?`,
    )
    .bind(tenantId, specialistId, actionId)
    .first<{ proposed: number; approved: number | null; declined: number | null; done_by_person: number | null }>();
  return {
    proposed: Number(history?.proposed ?? 0),
    approved: Number(history?.approved ?? 0),
    declined: Number(history?.declined ?? 0),
    done_by_person: Number(history?.done_by_person ?? 0),
  };
}

function catalogActionsFor(specialistId: string) {
  return CATALOG.actions.filter((action) => action.owners.includes(specialistId));
}

// ---------------------------------------------------------------------------------------------
// Specialist controls: the owner's pause, and the auditor's hold that only the owner clears

export interface SpecialistControl {
  paused: boolean;
  held: boolean;
  revision: number;
}

export async function specialistControl(
  db: AgentDb,
  tenantId: string,
  specialistId: string,
): Promise<SpecialistControl> {
  const row = await db
    .prepare(
      "SELECT paused, held, revision FROM agent_specialist_controls WHERE tenant_id = ? AND specialist_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .bind(tenantId, specialistId)
    .first<{ paused: number; held: number; revision: number }>();
  return {
    paused: row?.paused === 1,
    held: row?.held === 1,
    revision: row?.revision ?? 0,
  };
}

export function specialistState(control: SpecialistControl): Pick<SpecialistControl, "paused" | "held"> {
  return { paused: control.paused, held: control.held };
}

export async function changeSpecialistControl(
  db: AgentDb,
  tenantId: string,
  specialistId: string,
  change: { paused: boolean; clear_hold: boolean },
  actor: HumanPrincipal,
  reason: string,
  now: string,
  idempotencyKey: string,
  expectedRevision: number,
): Promise<SpecialistControl | StoreError> {
  if (actor.role !== "owner") return { error: "owner_role_required", status: 403 };
  if (!catalogSpecialist(specialistId)) return { error: "unknown_specialist", status: 422 };
  if (!reason.trim() || reason.length > 600 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    return { error: "invalid_control", status: 422 };
  const request = canonicalJson({
    specialist_id: specialistId,
    change,
    actor: actor.user_id,
    reason: reason.trim(),
    expected_revision: expectedRevision,
  });
  const prior = await db
    .prepare(
      "SELECT paused,held,revision,request_json FROM agent_specialist_controls WHERE tenant_id=? AND idempotency_key=?",
    )
    .bind(tenantId, idempotencyKey)
    .first<{
      paused: number;
      held: number;
      revision: number;
      request_json: string;
    }>();
  if (prior && prior.request_json !== request) return { error: "idempotency_conflict", status: 409 };
  const current = await specialistControl(db, tenantId, specialistId);
  if (!prior && current.revision !== expectedRevision) return { error: "stale_version", status: 409 };
  const next = {
    paused: change.paused,
    held: change.clear_hold ? false : current.held,
    revision: expectedRevision + 1,
  };
  try {
    const statements = [humanGuard(db, tenantId, actor, now, true)];
    if (!prior)
      statements.push(
        db
          .prepare(
            `INSERT INTO agent_specialist_controls (control_id,tenant_id,specialist_id,revision,paused,held,changed_by,reason,hold_step_id,changed_at,idempotency_key,request_json)
        SELECT ?,?,?,?, ?,?,?,?,NULL,?,?,? WHERE
          (SELECT COALESCE(MAX(revision),0) FROM agent_specialist_controls WHERE tenant_id=? AND specialist_id=?)=?`,
          )
          .bind(
            `ctl_${crypto.randomUUID()}`,
            tenantId,
            specialistId,
            next.revision,
            next.paused ? 1 : 0,
            next.held ? 1 : 0,
            actor.user_id,
            reason.trim(),
            now,
            idempotencyKey,
            request,
            tenantId,
            specialistId,
            expectedRevision,
          ),
        changedGuard(db, "version"),
        db
          .prepare(
            `UPDATE agent_run_steps SET outcome='failed',reason_code='superseded',decided_at=?,version=version+1
        WHERE tenant_id=? AND specialist_id=? AND outcome IS NULL AND json_extract(permit_json,'$.delegation_id') IS NOT NULL`,
          )
          .bind(now, tenantId, specialistId),
      );
    await db.batch(statements);
  } catch (error) {
    const refusal = controlError(error);
    if (
      refusal?.status === 409 &&
      (await db
        .prepare("SELECT control_id FROM agent_specialist_controls WHERE tenant_id=? AND idempotency_key=?")
        .bind(tenantId, idempotencyKey)
        .first())
    )
      return await changeSpecialistControl(
        db,
        tenantId,
        specialistId,
        change,
        actor,
        reason,
        now,
        idempotencyKey,
        expectedRevision,
      );
    if (refusal) return refusal;
    throw error;
  }
  return prior
    ? {
        paused: prior.paused === 1,
        held: prior.held === 1,
        revision: prior.revision,
      }
    : next;
}

// ---------------------------------------------------------------------------------------------
// Exceptions for a named person

export interface OpenException {
  source: "step" | "host_alert";
  run_id: string | null;
  step_id: string | null;
  host_id: string | null;
  alert: string | null;
  reason_code: string;
  urgency: "immediate" | "today" | "brief";
  reviewer_role: string;
  summary: string;
  dedupe_key: string;
}

export async function openException(
  db: AgentDb,
  tenantId: string,
  input: OpenException,
  now: string,
  notify: Notify | null,
): Promise<string> {
  const existing = await db
    .prepare("SELECT exception_id FROM agent_exceptions WHERE tenant_id = ? AND dedupe_key = ?")
    .bind(tenantId, input.dedupe_key)
    .first<{ exception_id: string }>();
  if (existing) return existing.exception_id;
  const exceptionId = `exc_${crypto.randomUUID()}`;
  const personId = await namedPerson(db, tenantId, input.reviewer_role);
  await db
    .prepare(
      `INSERT INTO agent_exceptions (exception_id, tenant_id, source, run_id, step_id, host_id, alert, reason_code, urgency,
        reviewer_role, assigned_user_id, summary, dedupe_key, opened_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM agent_exceptions WHERE tenant_id=? AND dedupe_key=?)`,
    )
    .bind(
      exceptionId,
      tenantId,
      input.source,
      input.run_id,
      input.step_id,
      input.host_id,
      input.alert,
      input.reason_code,
      input.urgency,
      input.reviewer_role,
      personId,
      input.summary,
      input.dedupe_key,
      now,
      tenantId,
      input.dedupe_key,
    )
    .run();
  const stored = await db
    .prepare("SELECT exception_id FROM agent_exceptions WHERE tenant_id = ? AND dedupe_key = ?")
    .bind(tenantId, input.dedupe_key)
    .first<{ exception_id: string }>();
  // The owned queue retains every exception. Optional delivery can notify immediately,
  // but an unconfigured or failed transport never establishes provider delivery proof.
  if (stored?.exception_id === exceptionId && input.urgency !== "brief" && notify) {
    try {
      await notify(
        `IronWrap AI team: ${input.urgency === "immediate" ? "act now" : "needs you today"}`,
        `${input.summary}\n\nReason: ${input.reason_code.replaceAll("_", " ")}.`,
      );
    } catch {
      // Delivery failure leaves the exception open in Now; it is never lost.
    }
  }
  if (!stored) throw new Error("exception_readback_missing");
  return stored.exception_id;
}

export async function listExceptions(db: AgentDb, tenantId: string, open: boolean, limit: number) {
  const rows = await db
    .prepare(
      `SELECT exception_id, source, run_id, step_id, host_id, alert, reason_code, urgency, reviewer_role, assigned_user_id, summary, opened_at,
              acknowledged_at, acknowledged_by_user_id
       FROM agent_exceptions WHERE tenant_id = ? AND (acknowledged_at IS NULL) = ? ORDER BY opened_at DESC LIMIT ?`,
    )
    .bind(tenantId, open ? 1 : 0, limit)
    .all<Record<string, unknown>>();
  return rows.results;
}

/** A person takes the exception over; a step that escalated it then counts as done. */
export async function acknowledgeException(
  db: AgentDb,
  tenantId: string,
  exceptionId: string,
  actor: HumanPrincipal,
  now: string,
): Promise<{ ok: true } | StoreError> {
  const row = await db
    .prepare(
      "SELECT step_id,acknowledged_at,acknowledged_by_user_id,reviewer_role,assigned_user_id FROM agent_exceptions WHERE tenant_id=? AND exception_id=?",
    )
    .bind(tenantId, exceptionId)
    .first<{
      step_id: string | null;
      acknowledged_at: string | null;
      acknowledged_by_user_id: string | null;
      reviewer_role: string;
      assigned_user_id: string | null;
    }>();
  if (!row) return { error: "exception_not_found", status: 404 };
  if (
    actor.role !== "owner" &&
    actor.role !== row.reviewer_role &&
    !(actor.role === "ops" && actor.user_id === row.assigned_user_id)
  )
    return { error: "forbidden", status: 403 };
  try {
    const statements = [humanGuard(db, tenantId, actor, now, false)];
    if (!row.acknowledged_at) {
      statements.push(
        db
          .prepare(
            "UPDATE agent_exceptions SET acknowledged_at=?,acknowledged_by_user_id=? WHERE tenant_id=? AND exception_id=? AND acknowledged_at IS NULL",
          )
          .bind(now, actor.user_id, tenantId, exceptionId),
        changedGuard(db, "version"),
      );
      if (row.step_id)
        statements.push(
          db
            .prepare(
              `UPDATE agent_run_steps SET outcome='succeeded',decided_at=?,version=version+1
        WHERE tenant_id=? AND step_id=? AND outcome IS NULL AND action_id='exception.escalate'
          AND json_extract(readback_json,'$.reference')=? AND json_extract(readback_json,'$.matched')=1`,
            )
            .bind(now, tenantId, row.step_id, exceptionId),
        );
    } else if (row.acknowledged_by_user_id !== actor.user_id) return { error: "already_acknowledged", status: 409 };
    await db.batch(statements);
  } catch (error) {
    const refusal = controlError(error);
    if (refusal) return refusal;
    throw error;
  }
  return { ok: true };
}

/** OAuth and sign-in failures the host reports are immediate exceptions for the owner. */
const IMMEDIATE_HOST_ALERTS = new Set(["claude_auth_failed", "codex_auth_failed", "codex_signin_not_refreshing", "codex_plan_lacks_model"]);

export async function escalateHostAlerts(
  db: AgentDb,
  tenantId: string,
  hostId: string,
  alerts: string[],
  now: string,
  notify: Notify | null,
): Promise<void> {
  for (const alert of alerts) {
    if (!IMMEDIATE_HOST_ALERTS.has(alert)) continue;
    const open = await db
      .prepare(
        "SELECT exception_id FROM agent_exceptions WHERE tenant_id = ? AND host_id = ? AND alert = ? AND acknowledged_at IS NULL LIMIT 1",
      )
      .bind(tenantId, hostId, alert)
      .first<{ exception_id: string }>();
    if (open) continue;
    const last = await db
      .prepare(
        "SELECT exception_id FROM agent_exceptions WHERE tenant_id=? AND host_id=? AND alert=? ORDER BY opened_at DESC,exception_id DESC LIMIT 1",
      )
      .bind(tenantId, hostId, alert)
      .first<{ exception_id: string }>();
    await openException(
      db,
      tenantId,
      {
        source: "host_alert",
        run_id: null,
        step_id: null,
        host_id: hostId,
        alert,
        reason_code: "provider_unavailable",
        urgency: "immediate",
        reviewer_role: "owner",
        summary:
          alert === "codex_plan_lacks_model"
            ? `The AI team host ${hostId} reports that its Codex sign-in's plan does not include a routed model: sign the host's Codex home in with a plan that does; the specialists on it abstain until then.`
            : `The AI team host ${hostId} reports ${alert.replaceAll("_", " ")}: an AI sign-in needs renewing, and the specialists on it abstain until it is.`,
        dedupe_key: `host:${hostId}:${alert}:${last?.exception_id ?? "initial"}`,
      },
      now,
      notify,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Executing a permitted protective step

/** Runs a within-limits step whose machine path is proven, and records its readback. */
export async function executeStep(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  step: StepRow,
  now: string,
  notify: Notify | null,
): Promise<void> {
  const entry = registryEntry(step.action_id);
  const permit = JSON.parse(step.permit_json) as {
    kind: string;
    delegation_id: string | null;
  };
  if (!entry?.machinePermitProven || permit.kind !== "within_limits" || step.outcome !== null) return;
  if (step.tool_json !== null && step.readback_json !== null) return;
  const action = catalogAction(step.action_id);
  // These two owned protective bindings are the only implemented effects. A catalog setting is
  // never evidence that another adapter exists or an old permit still has authority.
  if (!action?.protective || (entry.binding.kind !== "exception" && entry.binding.kind !== "specialist_hold")) return;
  const args = JSON.parse(step.args_json);
  if (entry.binding.kind === "exception") {
    const exceptionId = await openException(
      db,
      tenantId,
      {
        source: "step",
        run_id: run.run_id,
        step_id: step.step_id,
        host_id: null,
        alert: null,
        reason_code: args.reason_code,
        urgency: args.urgency,
        reviewer_role: args.route_to ?? catalogSpecialist(run.specialist_id)?.reviewer_role ?? "owner",
        summary: args.summary,
        dedupe_key: `step:${step.step_id}`,
      },
      now,
      notify,
    );
    await recordExecution(
      db,
      step,
      {
        name: "exception.open",
        binding: "agent_exceptions",
        idempotency_key: `step:${step.step_id}`,
      },
      exceptionId,
      null,
      now,
    ).run();
    return;
  }
  if (action.never_targets?.includes(args.specialist_id) || run.specialist_id !== "independent_auditor") return;
  // Holding a specialist that is already held changes nothing: the step succeeds on the hold in
  // force, without a new revision that would invalidate an owner's pending clear.
  const inForce = await db
    .prepare("SELECT control_id, held FROM agent_specialist_controls WHERE tenant_id = ? AND specialist_id = ? ORDER BY revision DESC LIMIT 1")
    .bind(tenantId, args.specialist_id)
    .first<{ control_id: string; held: number }>();
  if (inForce?.held === 1) {
    try {
      await db.batch([
        // The hold read above must still be the one in force; an owner clear in between makes
        // this a fresh hold below instead of a success that names a cleared revision.
        db
          .prepare(
            `INSERT INTO agent_control_guard(kind) SELECT 'version' WHERE COALESCE((SELECT control_id FROM agent_specialist_controls
          WHERE tenant_id=? AND specialist_id=? ORDER BY revision DESC LIMIT 1),'') <> ?`,
          )
          .bind(tenantId, args.specialist_id, inForce.control_id),
        recordExecution(db, step, { name: "specialist.hold", binding: "agent_specialist_controls", idempotency_key: `step:${step.step_id}` }, inForce.control_id, "succeeded", now),
        changedGuard(db, "step"),
      ]);
      return;
    } catch (error) {
      if (!controlError(error)) throw error;
    }
  }
  const controlId = `ctl_${crypto.randomUUID()}`;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO agent_control_guard(kind) SELECT 'step' WHERE NOT EXISTS (
        SELECT 1 FROM agent_run_steps WHERE tenant_id=? AND step_id=? AND version=? AND outcome IS NULL)`,
        )
        .bind(tenantId, step.step_id, step.version),
      db
        .prepare(
          `INSERT INTO agent_specialist_controls (control_id,tenant_id,specialist_id,revision,paused,held,changed_by,reason,hold_step_id,changed_at,idempotency_key,request_json)
        SELECT ?,?,?,(SELECT COALESCE(MAX(revision),0)+1 FROM agent_specialist_controls WHERE tenant_id=? AND specialist_id=?),
          COALESCE((SELECT paused FROM agent_specialist_controls WHERE tenant_id=? AND specialist_id=? ORDER BY revision DESC LIMIT 1),0),
          1,'specialist:independent_auditor',?,?,?,?,?`,
        )
        .bind(
          controlId,
          tenantId,
          args.specialist_id,
          tenantId,
          args.specialist_id,
          tenantId,
          args.specialist_id,
          args.reason,
          step.step_id,
          now,
          `step:${step.step_id}`,
          canonicalJson(args),
        ),
      changedGuard(db, "step"),
      db
        .prepare(
          `UPDATE agent_run_steps SET outcome='failed',reason_code='superseded',decided_at=?,version=version+1
        WHERE tenant_id=? AND specialist_id=? AND outcome IS NULL AND json_extract(permit_json,'$.delegation_id') IS NOT NULL`,
        )
        .bind(now, tenantId, args.specialist_id),
      recordExecution(
        db,
        step,
        {
          name: "specialist.hold",
          binding: "agent_specialist_controls",
          idempotency_key: `step:${step.step_id}`,
        },
        controlId,
        "succeeded",
        now,
      ),
      changedGuard(db, "step"),
    ]);
  } catch (error) {
    if (!controlError(error)) throw error;
  }
}

function recordExecution(
  db: AgentDb,
  step: StepRow,
  tool: { name: string; binding: string; idempotency_key: string },
  reference: string,
  outcome: "succeeded" | null,
  now: string,
): BoundStatement {
  if (tool.binding === "agent_exceptions") {
    // Read acknowledgement in the same statement that records the owned-store readback. Either
    // ordering of a concurrent acknowledgement therefore preserves a complete success receipt.
    return db
      .prepare(
        `UPDATE agent_run_steps SET tool_json=?,readback_json=?,
      outcome=(SELECT CASE WHEN acknowledged_at IS NULL THEN NULL ELSE 'succeeded' END FROM agent_exceptions WHERE exception_id=? AND step_id=?),
      decided_at=(SELECT acknowledged_at FROM agent_exceptions WHERE exception_id=? AND step_id=?),version=version+1
      WHERE step_id=? AND outcome IS NULL AND version=?`,
      )
      .bind(
        canonicalJson({ ...tool, request_hash: step.args_sha256 }),
        canonicalJson({
          source: "owned_store",
          reference,
          response_hash: step.args_sha256,
          matched: true,
        }),
        reference,
        step.step_id,
        reference,
        step.step_id,
        step.step_id,
        step.version,
      );
  }
  return db
    .prepare(
      `UPDATE agent_run_steps SET tool_json=?,readback_json=?,outcome=?,decided_at=?,version=version+1
    WHERE step_id=? AND outcome IS NULL AND version=?`,
    )
    .bind(
      canonicalJson({ ...tool, request_hash: step.args_sha256 }),
      canonicalJson({
        source: "owned_store",
        reference,
        response_hash: step.args_sha256,
        matched: true,
      }),
      outcome,
      outcome === null ? null : now,
      step.step_id,
      step.version,
    );
}

/** A close's generated fallback receipt must also reach the named exception queue. */
export async function escalateRunAbstention(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  now: string,
  notify: Notify | null,
): Promise<void> {
  // An ask's receipts that name nobody (store.ts) stay out by their null reviewer; a stopped
  // protective step or a safety close of an ask reaches the queue like any other run's.
  const rows = await db
    .prepare(
      `SELECT * FROM agent_run_steps WHERE tenant_id=? AND run_id=? AND action_id='exception.escalate'
    AND outcome='abstained' AND needs_reviewer_role IS NOT NULL`,
    )
    .bind(tenantId, run.run_id)
    .all<StepRow>();
  for (const step of rows.results) {
    const name = catalogSpecialist(run.specialist_id)?.display_name ?? "The AI team";
    await openException(
      db,
      tenantId,
      {
        source: "step",
        run_id: run.run_id,
        step_id: step.step_id,
        host_id: null,
        alert: null,
        reason_code: step.reason_code ?? "out_of_scope",
        urgency: "today",
        reviewer_role: step.needs_reviewer_role!,
        summary: `${name} stopped and needs a person.`,
        dedupe_key: `step:${step.step_id}`,
      },
      now,
      notify,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Decisions on steps that ask first

export type StepDecision = "approve" | "decline" | "do_it_myself";

export async function decideStep(
  db: AgentDb,
  tenantId: string,
  stepId: string,
  decision: StepDecision,
  expectedVersion: number,
  expectedHash: string,
  decider: HumanPrincipal,
  idempotencyKey: string,
  now: string,
  catastrophes: string[] = [],
  notify: Notify | null = null,
): Promise<{ outcome: string | null; reason_code: string | null } | StoreError> {
  const prior = await db
    .prepare(
      `SELECT d.*,s.outcome,s.reason_code,s.needs_reviewer_role FROM agent_step_decisions d JOIN agent_run_steps s ON s.step_id=d.step_id
    WHERE d.tenant_id=? AND d.idempotency_key=?`,
    )
    .bind(tenantId, idempotencyKey)
    .first<{
      step_id: string;
      decision: string;
      step_version: number;
      args_sha256: string;
      decided_by_user_id: string;
      needs_reviewer_role: string | null;
      outcome: string | null;
      reason_code: string | null;
    }>();
  if (prior) {
    if (decider.role !== "owner" && decider.role !== prior.needs_reviewer_role)
      return { error: "forbidden", status: 403 };
    if (
      prior.step_id !== stepId ||
      prior.decision !== decision ||
      prior.step_version !== expectedVersion ||
      prior.args_sha256 !== expectedHash ||
      prior.decided_by_user_id !== decider.user_id
    )
      return { error: "idempotency_conflict", status: 409 };
    try {
      await db.batch([humanGuard(db, tenantId, decider, now, false)]);
    } catch (error) {
      const refusal = controlError(error);
      if (refusal) return refusal;
      throw error;
    }
    return { outcome: prior.outcome, reason_code: prior.reason_code };
  }
  const step = await stepForDecision(db, tenantId, stepId);
  if (!step) return { error: "step_not_found", status: 404 };
  const policy = JSON.parse(step.policy_json) as { result: string; checks: unknown[]; reason_codes: string[] };
  if (step.outcome !== null || policy.result !== "needs_approval" || catalogAction(step.action_id)?.human_only)
    return { error: "not_awaiting_decision", status: 409 };
  if (step.version !== expectedVersion || step.args_sha256 !== expectedHash)
    return { error: "stale_version", status: 409 };
  if (decider.role !== "owner" && decider.role !== step.needs_reviewer_role) return { error: "forbidden", status: 403 };
  // Only an approver decides an authority record, and never the worker it is about, either way.
  if (registryEntry(step.action_id)?.binding.kind === "authority_record") {
    if (decision === "approve" && !ROLE_PERMISSIONS[decider.role as AppRole]?.includes("authority:approve"))
      return { error: "authority_approve_required", status: 403 };
    const subject = (JSON.parse(step.args_json) as { subject_ref?: unknown }).subject_ref;
    const refusal = await competencyApproverRefusal(db, tenantId, decider.user_id, typeof subject === "string" ? subject : "");
    if (refusal) return { error: refusal, status: 403 };
  }
  const run = await getRun(db, tenantId, step.run_id);
  if (decision === "approve" && (run?.catalog_version !== CATALOG_VERSION || run?.policy_version !== POLICY_VERSION))
    return { error: "policy_changed", status: 409 };
  // A revoke applies to the next permit (contract "Delegation"): an action switched off after the
  // step was proposed cannot be approved, though it can still be declined or done by hand.
  const delegation = decision === "approve" ? await currentDelegation(db, tenantId, step.specialist_id, step.action_id) : null;
  if (delegation?.setting === "off") return { error: "delegation_off", status: 409 };
  const effect = decision === "approve" && run ? await approvalEffect(db, tenantId, run, step, decider, now) : null;
  if (effect && "error" in effect) return effect;
  const finalPolicy = effect
    ? canonicalJson({
        ...policy,
        result: effect.outcome === "succeeded" ? policy.result : "deny",
        reason_codes: effect.reason ? [effect.reason] : policy.reason_codes,
        checks: [...policy.checks, effect.check],
      })
    : step.policy_json;
  const outcome = effect ? effect.outcome : "failed";
  const reason = effect ? effect.reason : decision === "decline" ? "declined" : "done_by_person";
  const decisionId = `dec_${crypto.randomUUID()}`;
  const permit = canonicalJson({
    kind: "asks_first",
    permit_id: decision === "approve" ? decisionId : null,
    approval_id: decision === "approve" ? decisionId : null,
    approved_by: decision === "approve" ? decider.user_id : null,
    delegation_id: null,
  });
  const agreement = decisionAgreement(db, tenantId, step, decision, decider.role, catastrophes, now);
  try {
    await db.batch([
      humanGuard(db, tenantId, decider, now, false),
      // The delegation the approval was read under is still the one in force at commit.
      ...(decision === "approve"
        ? [
            db
              .prepare(
                `INSERT INTO agent_control_guard (kind) SELECT 'version' WHERE (SELECT setting_id FROM agent_delegation_settings
          WHERE tenant_id=? AND specialist_id=? AND action_id=? ORDER BY revision DESC LIMIT 1) IS NOT ?`,
              )
              .bind(tenantId, step.specialist_id, step.action_id, delegation?.delegation_id ?? null),
          ]
        : []),
      db
        .prepare(
          `INSERT INTO agent_step_decisions (decision_id,tenant_id,step_id,decision,step_version,args_sha256,decided_by_user_id,decided_role,decided_at,idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          decisionId,
          tenantId,
          stepId,
          decision,
          step.version,
          step.args_sha256,
          decider.user_id,
          decider.role,
          now,
          idempotencyKey,
        ),
      ...(effect?.statements ?? []),
      db
        .prepare(
          `UPDATE agent_run_steps SET outcome=?,reason_code=?,permit_json=?,policy_json=?,needs_ask=?,tool_json=?,readback_json=?,decided_at=?,version=version+1
        WHERE tenant_id=? AND step_id=? AND version=? AND args_sha256=? AND outcome IS NULL`,
        )
        .bind(
          outcome,
          reason,
          permit,
          finalPolicy,
          decision === "approve" ? "acknowledge_and_act" : step.needs_ask,
          effect?.tool ?? step.tool_json,
          effect?.readback ?? step.readback_json,
          now,
          tenantId,
          stepId,
          expectedVersion,
          expectedHash,
        ),
      changedGuard(db, "step"),
      // The person judged the exact proposal: that is the strongest agreement signal.
      agreement.statement,
    ]);
  } catch (error) {
    const refusal = controlError(error);
    if (
      refusal?.status === 409 &&
      (await db
        .prepare("SELECT decision_id FROM agent_step_decisions WHERE tenant_id=? AND idempotency_key=?")
        .bind(tenantId, idempotencyKey)
        .first())
    )
      return await decideStep(
        db,
        tenantId,
        stepId,
        decision,
        expectedVersion,
        expectedHash,
        decider,
        idempotencyKey,
        now,
        catastrophes,
        notify,
      );
    if (refusal) return refusal;
    throw error;
  }
  if (catastrophes.length > 0)
    await afterCatastrophe(
      db,
      tenantId,
      { agreement_id: agreement.agreementId, specialist_id: step.specialist_id, action_id: step.action_id, catastrophes, run_id: step.run_id, step_id: step.step_id },
      now,
      notify,
    );
  return { outcome, reason_code: reason };
}

interface ApprovalEffect {
  outcome: "succeeded" | "failed" | "abstained";
  reason: string | null;
  check: { check: string; passed: boolean };
  statements: BoundStatement[];
  tool: string | null;
  readback: string | null;
}

/**
 * What approving a step does. Its cited facts are read again first: one that changed since the
 * proposal stops the step. Only `authority.record` has an effect binding; it runs natively inside
 * the decision's transaction. Any other approval is recorded truthfully and abstains.
 */
async function approvalEffect(
  db: AgentDb,
  tenantId: string,
  run: RunRow,
  step: StepRow,
  decider: HumanPrincipal,
  now: string,
): Promise<ApprovalEffect | StoreError> {
  const stop = (outcome: "failed" | "abstained", reason: string, check: string): ApprovalEffect => ({
    outcome,
    reason,
    check: { check, passed: false },
    statements: [],
    tool: null,
    readback: null,
  });
  const citations = (JSON.parse(step.sources_json) as Citation[]).map(({ fact_id, version }) => ({ fact_id, version }));
  const { currentVersions } = await citedFacts(citations, runContext(run).facts, runFactReader(db, tenantId, run, now));
  for (const citation of citations) {
    const current = currentVersions.get(citation.fact_id);
    if (current === undefined || current === null) return stop("abstained", "citation_unverifiable", "fresh");
    if (current !== citation.version) return stop("abstained", "fact_stale", "fresh");
  }
  if (registryEntry(step.action_id)?.binding.kind !== "authority_record")
    return stop("abstained", "policy_missing", "effect_binding");
  const args: unknown = JSON.parse(step.args_json);
  if (competencyCommandError(args)) return stop("failed", "tool_refused", "effect_binding");
  // No client can send `#` in an authority idempotency key, so no one can claim this step's first.
  const idempotencyKey = `step#${step.step_id}`;
  const plan = await planCompetencyCommand(db, {
    tenantId,
    command: args as CompetencyCommand,
    approverUserId: decider.user_id,
    actionId: `authority_${crypto.randomUUID()}`,
    idempotencyKey,
    now,
  });
  if ("refusal" in plan) {
    // Another approver can still decide a step this person may not.
    if (plan.refusal === "authority_approver_required" || plan.refusal === "authority_self_approval_forbidden")
      return { error: plan.refusal, status: 403 };
    if (plan.refusal === "authority_head_changed") return stop("abstained", "fact_stale", "fresh");
    if (plan.refusal === "authority_ambiguous" || plan.refusal === "authority_contradictory")
      return stop("abstained", "fact_conflict", "fresh");
    return stop("failed", "tool_refused", "effect_binding");
  }
  return {
    outcome: "succeeded",
    reason: null,
    check: { check: "effect_binding", passed: true },
    statements: plan.statements,
    tool: canonicalJson({
      name: "authority.record",
      binding: "authority_record_readbacks",
      idempotency_key: idempotencyKey,
      request_hash: step.args_sha256,
    }),
    readback: canonicalJson({
      source: "owned_store",
      reference: plan.readbackId,
      response_hash: plan.observationFingerprint,
      matched: true,
    }),
  };
}

export async function stepForDecision(db: AgentDb, tenantId: string, stepId: string): Promise<StepRow | null> {
  return await db
    .prepare("SELECT * FROM agent_run_steps WHERE tenant_id = ? AND step_id = ?")
    .bind(tenantId, stepId)
    .first<StepRow>();
}

export { namedPerson };
