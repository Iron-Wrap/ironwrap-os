// Closing prepared people-only drafts (Track A, AI-TEAM-CONTRACT.md "Action classes", contract f5).
//
// A draft that prepares a people-only act (policy.ts PREPARES_PEOPLE_ONLY) waits in its person's
// Needs you. It closes, still `succeeded` and with exactly one reason code, when:
// - a person acts on the same subject by hand: `applied_by_person`, whether or not they set what the
//   draft proposed. `readback.reference` names the changed record and
//   `do_it_myself.context.applied` = {field, value, by} says what is set now and by whom;
// - a newer draft for the same record replaces it: `superseded`, with `readback.reference` naming
//   the newer draft's step (`step/<step_id>`), where it now waits.
// No permit was approved, so `permit.approved_by` stays null. A closed draft leaves Needs you. The
// reason codes are fixed here: no route lets a client choose one. Migration 0206 lets only this
// close past the decided-step guard; `decided_at` comes from D1's clock.

import { sha256Hex } from "../app-auth.ts";
import { catalogAction } from "./catalog.ts";
import { APPLY_IN_OWN_SCREEN } from "./receipts.ts";
import { canonicalJson } from "./schema.ts";
import type { AgentDb, BoundStatement } from "./store.ts";

/** What a person set on the record a draft prepared: the field, its stable key and who set it. */
export interface Applied {
  field: "role" | "delegation_setting";
  value: string;
  by: string;
}

const CLOSE = `UPDATE agent_run_steps SET reason_code = ?, policy_json = json_set(policy_json, '$.reason_codes', json_array(?)),
  needs_ask = NULL, readback_json = ?, do_it_myself_json = CASE WHEN ? IS NULL THEN do_it_myself_json
    ELSE json_set(do_it_myself_json, '$.context.applied', json(?)) END,
  decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1
  WHERE tenant_id = ? AND action_id = ? AND outcome = 'succeeded' AND needs_ask = '${APPLY_IN_OWN_SCREEN}'`;

/** The record key of a draft's arguments that a newer draft or a person's change matches on. */
const DRAFT_KEYS: Record<string, { sql: string; values: (args: Record<string, unknown>) => unknown[] }> = {
  "delegation.propose_change": {
    sql: "json_extract(args_json, '$.specialist_id') = ? AND json_extract(args_json, '$.action_id') = ?",
    values: (args) => [args.specialist_id, args.action_id],
  },
  // One person's change of one kind to one device: a newer device pairing does not replace a role
  // change, nor a revoke of the tablet one of the phone.
  "access.prepare_change": {
    sql: "json_extract(args_json, '$.person_ref') = ? AND json_extract(args_json, '$.change') = ? AND json_extract(args_json, '$.device_ref') IS ?",
    values: (args) => [args.person_ref, args.change, args.device_ref ?? null],
  },
};

/** The open drafts of one record. Null for an action whose drafts never close here. */
function record(actionId: string, args: Record<string, unknown>): { sql: string; values: unknown[] } | null {
  const key = DRAFT_KEYS[actionId];
  if (!key) return null;
  // A draft's specialist is one of the action's owners (policy scope), which keeps the close on the
  // pair index instead of every succeeded step of the tenant.
  const owners = catalogAction(actionId)?.owners ?? [];
  return { sql: `specialist_id IN (${owners.map(() => "?").join(", ")}) AND ${key.sql}`, values: [...owners, ...key.values(args)] };
}

/** A person changed the record `args` names: its open drafts close `applied_by_person`. */
async function applied(db: AgentDb, tenantId: string, actionId: string, args: Record<string, unknown>, reference: string, set: Applied): Promise<BoundStatement> {
  const readback = canonicalJson({ source: "owned_store", reference, response_hash: await sha256Hex(canonicalJson({ [set.field]: set.value })), matched: true });
  const drafts = record(actionId, args)!;
  return db
    .prepare(`${CLOSE} AND ${drafts.sql}`)
    .bind("applied_by_person", "applied_by_person", readback, canonicalJson(set), canonicalJson(set), tenantId, actionId, ...drafts.values);
}

/**
 * A newer draft replaces the open drafts of the same action and record: they close `superseded`,
 * naming the newer draft's step. Null for an action whose drafts no newer one replaces.
 */
export async function supersedeDrafts(
  db: AgentDb,
  tenantId: string,
  newer: { step_id: string; action_id: string; args: unknown; args_sha256: string },
): Promise<BoundStatement | null> {
  const drafts = record(newer.action_id, newer.args as Record<string, unknown>);
  if (!drafts) return null;
  const reference = canonicalJson({ source: "owned_store", reference: `step/${newer.step_id}`, response_hash: newer.args_sha256, matched: true });
  return db
    // Only once the newer draft is recorded: a retry that records nothing replaces nothing.
    .prepare(`${CLOSE} AND ${drafts.sql} AND step_id <> ? AND EXISTS (SELECT 1 FROM agent_run_steps WHERE tenant_id = ? AND step_id = ?)`)
    .bind("superseded", "superseded", reference, null, null, tenantId, newer.action_id, ...drafts.values, newer.step_id, tenantId, newer.step_id);
}

/**
 * The owner set one specialist and action's delegation, or turned its practice on or off: that
 * pair's open delegation.propose_change drafts close `applied_by_person`, naming the pair's record.
 */
export async function closeDelegationDrafts(
  db: AgentDb,
  tenantId: string,
  pair: { specialist_id: string; action_id: string },
  setting: string,
  by: string,
): Promise<BoundStatement> {
  const reference = `delegation/${pair.specialist_id}:${pair.action_id}`;
  return applied(db, tenantId, "delegation.propose_change", pair, reference, { field: "delegation_setting", value: setting, by });
}

/**
 * A person's role changed (access.change on the Access screen): that person's open role-change
 * drafts close `applied_by_person`, naming the person. Device drafts are left open. Never throws: a
 * draft that stays open is only stale.
 */
export async function closeAccessDrafts(db: AgentDb, tenantId: string, userId: string, role: string, by: string): Promise<boolean> {
  try {
    const person = `person:${userId}`;
    await (await applied(db, tenantId, "access.prepare_change", { person_ref: person, change: "change_role", device_ref: null }, person, { field: "role", value: role, by })).run();
    return true;
  } catch (error) {
    console.error(JSON.stringify({ at: "agent_draft_close", action_id: "access.prepare_change", error: String(error) }));
    return false;
  }
}
