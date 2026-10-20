// Lead proposals (Track A, AI-TEAM-CONTRACT.md `lead_fact.propose` and `lead_fact.confirm`).
//
// A proposal is a finished `lead_fact.propose` step: lead_concierge's draft of an inquiry's service,
// scope, address and timing, cited to the inbound event it came from. It stays open for
// `lead_fact.confirm` until a confirm that policy admitted names it (approved, declined or done by
// hand alike), or a newer proposal for the same lead sets every key it set. A newer proposal that
// covers only some of its keys leaves it open. A closed proposal is offered to no run.

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
  args_json: string;
  sources_json: string;
  created_at: string;
}

const PROPOSALS = `FROM agent_run_steps WHERE tenant_id = ? AND specialist_id = 'lead_concierge' AND action_id = 'lead_fact.propose'
  AND outcome = 'succeeded'`;

/** A finished proposal of this tenant by its step id, open or not; null for any other step. */
export async function leadProposal(db: AgentDb, tenantId: string, stepId: string): Promise<(LeadProposal & { open: boolean }) | null> {
  const row = await db
    .prepare(`SELECT step_id, args_json, sources_json, created_at ${PROPOSALS} AND step_id = ?`)
    .bind(tenantId, stepId)
    .first<ProposalRow>();
  if (!row) return null;
  const proposal = proposalOf(row);
  return { ...proposal, open: await isOpen(db, tenantId, row, proposal) };
}

/** The open proposals of one lead, newest first, at most `limit`. */
export async function openLeadProposals(db: AgentDb, tenantId: string, leadId: string, limit: number): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT step_id, args_json, sources_json, created_at ${PROPOSALS} AND json_extract(args_json, '$.lead_id') = ?
      ORDER BY created_at DESC, step_id DESC LIMIT 50`)
    .bind(tenantId, leadId)
    .all<ProposalRow>();
  const open: string[] = [];
  for (const row of rows.results ?? []) {
    if (open.length >= limit) break;
    if (await isOpen(db, tenantId, row, proposalOf(row))) open.push(row.step_id);
  }
  return open;
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

async function isOpen(db: AgentDb, tenantId: string, row: ProposalRow, proposal: LeadProposal): Promise<boolean> {
  // A confirm that policy admitted names it: it was used, whatever a person then decided.
  const used = await db
    .prepare(
      `SELECT 1 AS found FROM agent_run_steps WHERE tenant_id = ? AND specialist_id = 'lead_concierge' AND action_id = 'lead_fact.confirm'
        AND json_extract(args_json, '$.proposal_id') = ? AND json_extract(policy_json, '$.result') <> 'deny' LIMIT 1`,
    )
    .bind(tenantId, row.step_id)
    .first();
  if (used) return false;
  // A newer proposal for the same lead that sets every key this one set supersedes it.
  const keys = LEAD_FACT_KEYS.filter((key) => proposal.fields[key] !== null);
  const newer = await db
    .prepare(
      `SELECT args_json ${PROPOSALS} AND json_extract(args_json, '$.lead_id') = ?
        AND (created_at > ? OR (created_at = ? AND step_id > ?))`,
    )
    .bind(tenantId, proposal.lead_id, row.created_at, row.created_at, row.step_id)
    .all<{ args_json: string }>();
  return !(newer.results ?? []).some((entry) => {
    const fields = (JSON.parse(entry.args_json) as { fields: LeadFacts }).fields;
    return keys.every((key) => fields[key] !== null);
  });
}
