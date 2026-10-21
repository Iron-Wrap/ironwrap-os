// Closing prepared people-only drafts (Track A, AI-TEAM-CONTRACT.md "Action classes", contract f5).
//
// A draft that prepares a people-only act (policy.ts PREPARES_PEOPLE_ONLY) waits in its person's
// Needs you. It closes, still `succeeded` and with exactly one reason code, when:
// - the person makes the change: `applied_by_person` when it is the change the draft proposed, or
//   `superseded` when they set something else. `readback.reference` names the changed record and
//   `do_it_myself.context.applied` = {field, value, by} says what is set now and by whom;
// - a newer draft for the same record replaces it: `superseded`, with `readback.reference` naming
//   the newer draft's step (`step/<step_id>`), where it now waits.
// No permit was approved, so `permit.approved_by` stays null. A closed draft leaves Needs you.

import { sha256Hex } from "../app-auth.ts";
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
  decided_at = ?, version = version + 1
  WHERE tenant_id = ? AND action_id = ? AND outcome = 'succeeded' AND needs_ask = '${APPLY_IN_OWN_SCREEN}'`;

/** The record key of a draft's arguments that a newer draft or a person's change matches on. */
const DRAFT_KEYS: Record<string, { sql: string; values: (args: Record<string, unknown>) => unknown[] }> = {
  "delegation.propose_change": {
    sql: "json_extract(args_json, '$.specialist_id') = ? AND json_extract(args_json, '$.action_id') = ?",
    values: (args) => [args.specialist_id, args.action_id],
  },
  // One person's change of one kind: a newer device pairing does not replace a role change.
  "access.prepare_change": {
    sql: "json_extract(args_json, '$.person_ref') = ? AND json_extract(args_json, '$.change') = ?",
    values: (args) => [args.person_ref, args.change],
  },
};

async function readback(reference: string, value: unknown): Promise<string> {
  return canonicalJson({ source: "owned_store", reference, response_hash: await sha256Hex(canonicalJson(value)), matched: true });
}

/**
 * A newer draft replaces the open drafts of the same action and record: they close `superseded`,
 * naming the newer draft's step. Null for an action whose drafts no newer one replaces.
 */
export async function supersedeDrafts(
  db: AgentDb,
  tenantId: string,
  newer: { step_id: string; action_id: string; args: unknown; args_sha256: string },
  now: string,
): Promise<BoundStatement | null> {
  const key = DRAFT_KEYS[newer.action_id];
  if (!key) return null;
  const record = canonicalJson({ source: "owned_store", reference: `step/${newer.step_id}`, response_hash: newer.args_sha256, matched: true });
  return db
    // Only once the newer draft is recorded: a retry that records nothing replaces nothing.
    .prepare(`${CLOSE} AND ${key.sql} AND step_id <> ? AND EXISTS (SELECT 1 FROM agent_run_steps WHERE step_id = ?)`)
    .bind("superseded", "superseded", record, null, null, now, tenantId, newer.action_id, ...key.values(newer.args as Record<string, unknown>), newer.step_id, newer.step_id);
}

/**
 * The owner set one specialist and action's delegation (or practice): its open
 * delegation.propose_change drafts close `applied_by_person` when they proposed that setting, else
 * `superseded`, naming the pair's delegation record.
 */
export async function closeDelegationDrafts(
  db: AgentDb,
  tenantId: string,
  pair: { specialist_id: string; action_id: string },
  setting: string,
  by: string,
  now: string,
): Promise<BoundStatement> {
  const applied: Applied = { field: "delegation_setting", value: setting, by };
  const code = "CASE WHEN json_extract(args_json, '$.proposed') = ? THEN 'applied_by_person' ELSE 'superseded' END";
  return db
    .prepare(
      CLOSE.replace("SET reason_code = ?, policy_json = json_set(policy_json, '$.reason_codes', json_array(?))", `SET reason_code = ${code}, policy_json = json_set(policy_json, '$.reason_codes', json_array(${code}))`) +
        ` AND ${DRAFT_KEYS["delegation.propose_change"].sql}`,
    )
    .bind(
      setting,
      setting,
      await readback(`delegation/${pair.specialist_id}:${pair.action_id}`, { setting }),
      canonicalJson(applied),
      canonicalJson(applied),
      now,
      tenantId,
      "delegation.propose_change",
      pair.specialist_id,
      pair.action_id,
    );
}

/**
 * A person's role changed (access.change on the Access screen): that person's open role-change
 * drafts close `applied_by_person` when they proposed this role, else `superseded`, naming the
 * person. Device drafts are left open. Never throws: a draft that stays open is only stale.
 */
export async function closeAccessDrafts(db: AgentDb, tenantId: string, userId: string, role: string, by: string, now: string): Promise<boolean> {
  try {
    const applied: Applied = { field: "role", value: role, by };
    const code = "CASE WHEN json_extract(args_json, '$.target_role') = ? THEN 'applied_by_person' ELSE 'superseded' END";
    await db
      .prepare(
        CLOSE.replace("SET reason_code = ?, policy_json = json_set(policy_json, '$.reason_codes', json_array(?))", `SET reason_code = ${code}, policy_json = json_set(policy_json, '$.reason_codes', json_array(${code}))`) +
          ` AND ${DRAFT_KEYS["access.prepare_change"].sql}`,
      )
      .bind(
        role,
        role,
        await readback(`person:${userId}`, { role }),
        canonicalJson(applied),
        canonicalJson(applied),
        now,
        tenantId,
        "access.prepare_change",
        `person:${userId}`,
        "change_role",
      )
      .run();
    return true;
  } catch {
    return false;
  }
}
