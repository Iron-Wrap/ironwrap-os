// Closing prepared people-only drafts (Track A, AI-TEAM-CONTRACT.md "Action classes", contract f5).
//
// A draft that prepares a people-only act (policy.ts PREPARES_PEOPLE_ONLY) waits in its person's
// Needs you. It closes, still `succeeded` and with exactly one reason code, when:
// - a person acts on the same subject by hand: `applied_by_person`, whether or not they set what the
//   draft proposed. `readback.reference` names the changed record and
//   `do_it_myself.context.applied` = {field, value, by, as_proposed} says what is set now, by whom,
//   and whether it is what that draft proposed (the same stable key, and for `within_limits` the
//   same ceiling, its recipients as a set);
// - a newer draft for the same record replaces it: `superseded`, with `readback.reference` naming
//   the newer draft's step (`step/<step_id>`), where it now waits.
// No permit was approved, so `permit.approved_by` stays null. A closed draft leaves Needs you. The
// reason codes are fixed here: no route lets a client choose one. Migration 0206 lets only this
// close past the decided-step guard; `decided_at` comes from D1's clock.

import { sha256Hex } from "../app-auth.ts";
import { catalogAction } from "./catalog.ts";
import { APPLY_IN_OWN_SCREEN } from "./receipts.ts";
import { canonicalJson } from "./schema.ts";
import { changesOf, type AgentDb, type BoundStatement } from "./store.ts";

/** What a person set on the record a draft prepared: the field, its stable key and who set it. */
export interface Applied {
  field: "role" | "delegation_setting";
  value: string;
  by: string;
}

// The pair index, named: with two owners in the IN list the planner may otherwise scan the tenant.
// `doItMyself` is the new do_it_myself_json; its placeholders bind after the readback's.
const close = (doItMyself: string) => `UPDATE agent_run_steps INDEXED BY idx_agent_run_steps_pair SET reason_code = ?, policy_json = json_set(policy_json, '$.reason_codes', json_array(?)),
  needs_ask = NULL, readback_json = ?, do_it_myself_json = ${doItMyself},
  decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1
  WHERE tenant_id = ? AND action_id = ? AND outcome = 'succeeded' AND needs_ask = '${APPLY_IN_OWN_SCREEN}'`;

/**
 * Whether one draft proposed what the person set, read from that draft's own arguments: the role,
 * or the delegation setting and, for `within_limits`, its ceiling. The ceiling's count and amount
 * compare as canonical JSON and its recipients as a set (no limit, null, is not an empty list), so
 * the same recipients in another order are still as proposed. Its placeholders take
 * `proposedValues`.
 */
// json_each reads a null list as one null row, which the type check has already compared.
const SAME_RECIPIENTS = `json_type(args_json, '$.ceiling.recipients') IS json_type(?, '$.recipients')
    AND NOT EXISTS (SELECT 1 FROM json_each(args_json, '$.ceiling.recipients') AS mine
      WHERE mine.type <> 'null' AND mine.value NOT IN (SELECT value FROM json_each(?, '$.recipients')))
    AND NOT EXISTS (SELECT 1 FROM json_each(?, '$.recipients') AS theirs
      WHERE theirs.type <> 'null' AND theirs.value NOT IN (SELECT value FROM json_each(args_json, '$.ceiling.recipients')))`;
const PROPOSED: Record<string, { sql: string; values: (value: string, ceiling: string) => unknown[] }> = {
  "delegation.propose_change": {
    sql: `json_extract(args_json, '$.proposed') IS ? AND (? IS NOT 'within_limits' OR (
      json_remove(json_extract(args_json, '$.ceiling'), '$.recipients') IS json_remove(json(?), '$.recipients')
      AND ${SAME_RECIPIENTS}))`,
    values: (setting, ceiling) => [setting, setting, ceiling, ceiling, ceiling, ceiling],
  },
  "access.prepare_change": { sql: "json_extract(args_json, '$.target_role') IS ?", values: (role) => [role] },
};

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

/**
 * A person changed the record `args` names: its open drafts close `applied_by_person`, each saying
 * whether it proposed what was set (and, for a delegation, the ceiling in force as canonical JSON).
 */
async function applied(
  db: AgentDb,
  tenantId: string,
  actionId: string,
  args: Record<string, unknown>,
  reference: string,
  set: Applied,
  ceiling: string,
  extra = { sql: "", values: [] as unknown[] },
): Promise<BoundStatement> {
  const readback = canonicalJson({ source: "owned_store", reference, response_hash: await sha256Hex(canonicalJson({ [set.field]: set.value })), matched: true });
  const drafts = record(actionId, args)!;
  const proposed = PROPOSED[actionId];
  const doItMyself = `json_set(do_it_myself_json, '$.context.applied',
    json_set(json(?), '$.as_proposed', json(CASE WHEN ${proposed.sql} THEN 'true' ELSE 'false' END)))`;
  return db
    .prepare(`${close(doItMyself)} AND ${drafts.sql}${extra.sql}`)
    .bind("applied_by_person", "applied_by_person", readback, canonicalJson(set), ...proposed.values(set.value, ceiling), tenantId, actionId, ...drafts.values, ...extra.values);
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
    .prepare(`${close("do_it_myself_json")} AND ${drafts.sql} AND step_id <> ? AND EXISTS (SELECT 1 FROM agent_run_steps WHERE tenant_id = ? AND step_id = ?)`)
    .bind("superseded", "superseded", reference, tenantId, newer.action_id, ...drafts.values, newer.step_id, tenantId, newer.step_id);
}

/**
 * The owner set one specialist and action's delegation, or turned its practice on or off: that
 * pair's open delegation.propose_change drafts close `applied_by_person`, naming the pair's record.
 * `ceiling` is the ceiling in force with `within_limits`, null with any other setting; a draft that
 * proposed within limits is as proposed only at its own ceiling.
 */
export async function closeDelegationDrafts(
  db: AgentDb,
  tenantId: string,
  pair: { specialist_id: string; action_id: string },
  setting: string,
  by: string,
  ceiling: unknown,
): Promise<BoundStatement> {
  const reference = `delegation/${pair.specialist_id}:${pair.action_id}`;
  const set: Applied = { field: "delegation_setting", value: setting, by };
  return applied(db, tenantId, "delegation.propose_change", pair, reference, set, canonicalJson(ceiling));
}

/**
 * A person's role was set (the Access screen or provisioning): that person's open role-change drafts
 * close `applied_by_person`, naming the person; true when any closed. `accessVersion` is the access
 * version that role change produced: only drafts prepared against an older one close, so a draft
 * written after the change stays. Device drafts are left open. Never throws: a draft that stays
 * open is only stale.
 */
export async function closeAccessDrafts(
  db: AgentDb,
  tenantId: string,
  userId: string,
  role: string,
  by: string,
  accessVersion: number,
): Promise<boolean> {
  try {
    const person = `person:${userId}`;
    const older = { sql: " AND json_extract(args_json, '$.expected_access_version') < ?", values: [accessVersion] };
    const set: Applied = { field: "role", value: role, by };
    // D1's change count includes rows triggers touch, so it says only whether any closed.
    const draft = { person_ref: person, change: "change_role", device_ref: null };
    return changesOf(await (await applied(db, tenantId, "access.prepare_change", draft, person, set, "null", older)).run()) > 0;
  } catch (error) {
    console.error(JSON.stringify({ at: "agent_draft_close", action_id: "access.prepare_change", error: String(error) }));
    return false;
  }
}
