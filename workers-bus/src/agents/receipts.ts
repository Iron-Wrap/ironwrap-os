// The receipt read model: one receipt per coordination-run step, with exactly the fields
// AI-TEAM-CONTRACT.md "Receipt fields" lists. `did`, `doing` and `needs_from_you.ask` come from
// fixed templates over structured fields, never from model text. They name the action by its plain
// name and carry no codes; the reason stays in `policy.reason_codes`.

import { catalogAction, catalogSpecialist } from "./catalog.ts";
import type { AgentDb, StepRow } from "./store.ts";

export interface Receipt {
  specialist_id: string;
  run_id: string;
  action_id: string;
  did: string | null;
  doing: string | null;
  needs_from_you: { reviewer_role: string; person_id: string | null; ask: string } | null;
  sources: Array<{ fact_id: string; version: number; hash: string | null }>;
  policy: { policy_id: string; version: string; result: string; checks: Array<{ check: string; passed: boolean }>; reason_codes: string[] };
  permit: { kind: string; permit_id: string | null; approval_id: string | null; approved_by: string | null; delegation_id: string | null };
  tool: unknown;
  readback: unknown;
  outcome: string | null;
  undo: { mode: string; action_id: string | null; available: boolean };
  do_it_myself: { surface: string | null; context: unknown };
}

const ASKS: Record<string, string> = {
  approve_or_decline: "Approve or decline this step.",
  acknowledge_and_act: "Take this over and act on it.",
};

/** The specialist and the action in words for a sentence people read: no ids, no codes. */
export function stepWords(specialistId: string, actionId: string): { name: string; action: string | null; work: string } {
  const action = catalogAction(actionId)?.name?.trim() || null;
  return { name: catalogSpecialist(specialistId)?.display_name ?? "The AI team", action, work: action ?? "this step" };
}

export function receiptOf(step: StepRow): Receipt {
  const { name, action, work } = stepWords(step.specialist_id, step.action_id);
  let did: string | null = null;
  let doing: string | null = null;
  if (step.outcome === "succeeded") did = `${name} finished ${work}.`;
  else if (step.outcome === "abstained") did = `${name} stopped before ${work}.`;
  else if (step.outcome === "failed") did = `${name} could not finish ${work}.`;
  else if (step.outcome === "unknown") doing = `${name} is checking whether ${work} went through.`;
  else if (step.needs_reviewer_role) doing = `${name} is waiting on a person before ${work}.`;
  else doing = action ? `${name} is ${action}.` : `${name} is working on this step.`;
  return {
    specialist_id: step.specialist_id,
    run_id: step.run_id,
    action_id: step.action_id,
    did,
    doing,
    needs_from_you:
      step.needs_reviewer_role && (step.outcome === null || step.outcome === "abstained")
        ? { reviewer_role: step.needs_reviewer_role, person_id: step.needs_person_id, ask: ASKS[step.needs_ask ?? ""] ?? ASKS.acknowledge_and_act }
        : null,
    sources: JSON.parse(step.sources_json),
    policy: JSON.parse(step.policy_json),
    permit: JSON.parse(step.permit_json),
    tool: step.tool_json ? JSON.parse(step.tool_json) : null,
    readback: step.readback_json ? JSON.parse(step.readback_json) : null,
    outcome: step.outcome,
    undo: JSON.parse(step.undo_json),
    do_it_myself: JSON.parse(step.do_it_myself_json),
  };
}

export type ReceiptView = "needs_you" | "doing" | "done";

/** Now's three lanes: steps waiting on a person, steps in progress, and closed steps. */
export async function listReceipts(db: AgentDb, tenantId: string, view: ReceiptView, limit: number, reviewer: {user_id: string; role: string} | null = null) {
  const where =
    view === "needs_you"
      ? "(outcome IS NULL OR outcome = 'abstained') AND needs_reviewer_role IS NOT NULL"
      : view === "doing"
        ? "outcome IS NULL AND needs_reviewer_role IS NULL"
        : "outcome IS NOT NULL";
  const assigned = reviewer ? " AND needs_reviewer_role = ?" : "";
  const values = reviewer ? [tenantId, reviewer.role, limit] : [tenantId, limit];
  const rows = await db
    .prepare(`SELECT * FROM agent_run_steps WHERE tenant_id = ? AND ${where}${assigned} ORDER BY created_at DESC, step_seq DESC LIMIT ?`)
    .bind(...values)
    .all<StepRow>();
  return rows.results.map((row) => ({ step_id: row.step_id, version: row.version, args_sha256: row.args_sha256, created_at: row.created_at, receipt: receiptOf(row) }));
}

export async function listHostHealth(db: AgentDb, tenantId: string) {
  const rows = await db
    .prepare("SELECT host_id, host_version, ready, alerts_json, backlog_json, in_flight, received_at FROM agent_host_heartbeats WHERE tenant_id = ? ORDER BY host_id")
    .bind(tenantId)
    .all<{ host_id: string; host_version: string; ready: number; alerts_json: string; backlog_json: string; in_flight: number; received_at: string }>();
  return rows.results.map((row) => ({
    host_id: row.host_id,
    version: row.host_version,
    ready: row.ready === 1,
    alerts: JSON.parse(row.alerts_json) as string[],
    backlog: JSON.parse(row.backlog_json),
    in_flight: row.in_flight,
    received_at: row.received_at,
  }));
}
