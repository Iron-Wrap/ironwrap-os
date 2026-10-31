// Lead proposals (Track A, AI-TEAM-CONTRACT.md `lead_fact.propose` and `lead_fact.confirm`).
//
// A proposal is a finished `lead_fact.propose` step: lead_concierge's draft of an inquiry's service,
// scope, address and timing, cited to the inbound event it came from. It stays open for
// `lead_fact.confirm` until a confirm that policy admitted names it (approved, declined or done by
// hand alike), or a newer proposal for the same lead sets every key it set. A newer proposal that
// covers only some of its keys leaves it open. A closed proposal is offered to no run. "Newer" is by
// time, then by insertion order (rowid), since step ids are random.

import type { AgentDb } from "./store.ts";

export const LEAD_FACT_KEYS = ["service", "scope", "address", "timing"] as const;
export type LeadFacts = Record<(typeof LEAD_FACT_KEYS)[number], string | null>;

/** A proposal as the `lead_proposal/<step_id>` fact shows it. */
export interface LeadProposal {
  lead_id: string;
  fields: LeadFacts;
  proposed_at: string;
  /** The inbound event the values came from. */
  source: string | null;
}

interface ProposalRow {
  step_id: string;
  row: number;
  args_json: string;
  sources_json: string;
  created_at: string;
}

const PROPOSALS = `FROM agent_run_steps WHERE tenant_id = ? AND specialist_id = 'lead_concierge' AND action_id = 'lead_fact.propose'
  AND outcome = 'succeeded' AND json_type(args_json, '$.redacted') IS NOT 'true'`;
const COLUMNS = "step_id, rowid AS row, args_json, sources_json, created_at";
/** The newest proposals of a lead read for its open ones. */
const LEAD_WINDOW = 50;

/** A finished proposal of this tenant by its step id, open or not; null for any other step. */
export async function leadProposal(db: AgentDb, tenantId: string, stepId: string): Promise<(LeadProposal & { open: boolean }) | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} ${PROPOSALS} AND step_id = ?`).bind(tenantId, stepId).first<ProposalRow>();
  if (!row) return null;
  const proposal = proposalOf(row);
  const newer = await db
    .prepare(
      `SELECT args_json ${PROPOSALS} AND json_extract(args_json, '$.lead_id') = ?
        AND (created_at > ? OR (created_at = ? AND rowid > ?))`,
    )
    .bind(tenantId, proposal.lead_id, row.created_at, row.created_at, row.row)
    .all<{ args_json: string }>();
  const superseded = (newer.results ?? []).some((entry) => covers(fieldsOf(entry.args_json), proposal.fields));
  const open = !superseded && (await usedProposals(db, tenantId, [row.step_id])).size === 0;
  return { ...proposal, open };
}

/**
 * The open proposals of one lead, newest first, at most `limit`, in two reads: the lead's newest
 * proposals (each one's newer proposals are the ones before it in that list), and which of them a
 * confirm has used.
 */
export async function openLeadProposals(db: AgentDb, tenantId: string, leadId: string, limit: number): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT ${COLUMNS} ${PROPOSALS} AND json_extract(args_json, '$.lead_id') = ? ORDER BY created_at DESC, rowid DESC LIMIT ${LEAD_WINDOW}`)
    .bind(tenantId, leadId)
    .all<ProposalRow>();
  const list = rows.results ?? [];
  if (list.length === 0) return [];
  const used = await usedProposals(db, tenantId, list.map((row) => row.step_id));
  const open: string[] = [];
  list.forEach((row, index) => {
    if (open.length >= limit || used.has(row.step_id)) return;
    const fields = fieldsOf(row.args_json);
    if (!list.slice(0, index).some((newer) => covers(fieldsOf(newer.args_json), fields))) open.push(row.step_id);
  });
  return open;
}

/** The proposals among these that a confirm policy admitted names. */
async function usedProposals(db: AgentDb, tenantId: string, stepIds: string[]): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT json_extract(args_json, '$.proposal_id') AS proposal_id FROM agent_run_steps
        WHERE tenant_id = ? AND specialist_id = 'lead_concierge' AND action_id = 'lead_fact.confirm'
          AND json_extract(policy_json, '$.result') <> 'deny'
          AND json_extract(args_json, '$.proposal_id') IN (SELECT value FROM json_each(?))`,
    )
    .bind(tenantId, JSON.stringify(stepIds))
    .all<{ proposal_id: string }>();
  return new Set((rows.results ?? []).map((row) => row.proposal_id));
}

/** Whether a newer proposal sets every key an older one set. */
function covers(newer: LeadFacts, older: LeadFacts): boolean {
  return LEAD_FACT_KEYS.every((key) => older[key] === null || newer[key] !== null);
}

function fieldsOf(argsJson: string): LeadFacts {
  return (JSON.parse(argsJson) as { fields: LeadFacts }).fields;
}

function proposalOf(row: ProposalRow): LeadProposal {
  const args = JSON.parse(row.args_json) as { lead_id: string; fields: LeadFacts };
  const sources = JSON.parse(row.sources_json) as Array<{ fact_id?: unknown }>;
  return {
    lead_id: args.lead_id,
    fields: args.fields,
    proposed_at: row.created_at,
    source: typeof sources[0]?.fact_id === "string" ? sources[0].fact_id : null,
  };
}
