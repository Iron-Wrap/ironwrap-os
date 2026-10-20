import type { AppEnv } from "./app-types.ts";
import { isNativeFinalInvoiceCurrent } from "./quickbooks-native-final-invoice.ts";
import type { AccountingIntentRecord } from "./accounting-intents.ts";
import { contractDepositTerms } from "./deposit-policy.ts";

const MAX_CURRENT_HEAD_ROWS = 2;
const MAX_ACCEPTANCE_ROWS = 101;
const MAX_DEPOSIT_ROWS = 101;
const MAX_SAFETY_STOP_ROWS = 21;
const MAX_SERVICE_CASE_ROWS = 21;

export type CommercialJobPhase =
  | "cancelled"
  | "qualification_pending"
  | "qualified"
  | "commercial_in_progress"
  | "deposit_pending"
  | "production_blocked"
  | "safety_blocked"
  | "production_ready"
  | "scheduled"
  | "in_progress"
  | "substantially_complete"
  | "financially_closed";

interface JobRow {
  roof_job_id: string;
  lead_id: string;
  customer_id: string;
  property_id: string | null;
  job_status: string;
  current_gate_state: string;
  version: number;
  updated_at: string;
  lead_status: string;
  lead_version: number;
  customer_status: string;
  customer_version: number;
  property_version: number | null;
}

interface QuoteRow {
  quote_revision_id: string;
  customer_quote_id: string;
  revision_number: number;
  status: string;
  terms_hash: string;
  terms_json: string;
  currency: string;
  total_cents: number;
  valid_until: string;
  created_at: string;
}

interface ProposalRow {
  proposal_revision_id: string;
  proposal_pack_id: string;
  revision_number: number;
  quote_revision_id: string;
  terms_hash: string;
  created_at: string;
}

interface PublicationRow {
  publication_event_id: string;
  proposal_revision_id: string;
  proposal_pack_id: string;
  publication_version: number;
  state: "published" | "withdrawn";
  occurred_at: string;
}

interface AcceptanceRow {
  acceptance_binding_id: string;
  acceptance_id: string;
  quote_revision_id: string;
  proposal_revision_id: string;
  terms_hash: string;
  accepted_at: string;
  bound_at: string;
}

interface DepositRow {
  derivation_id: string;
  acceptance_id: string;
  state: "pending" | "blocked" | "derived";
  intent_id: string | null;
  blocker_code: string | null;
  blocker_next_step: string | null;
  version: number;
  updated_at: string;
}

interface GateRow {
  gate: string;
  state: string;
  blocker_reason: string;
  version: number;
  updated_at: string;
  /** The basis of the ledger entry the gate stands on (0153), when one does. */
  basis_in_force: string | null;
}

interface AssignmentRow {
  assignment_id: string;
  assignment_version: number;
  crew_id: string;
  scheduled_start: string;
  scheduled_end: string | null;
  updated_at: string;
}

interface WorkPackageRow {
  work_package_id: string;
  version: number;
  status: string;
  updated_at: string;
}

interface SafetyRow {
  occurrence_id: string;
  severity: string;
  state: string;
  stop_active: number;
  updated_at: string;
}

type AccountingRow = AccountingIntentRecord;

export function depositIntentIsReconciled(
  intentId: string | null,
  rows: readonly Pick<AccountingRow, "intent_id" | "state">[],
): boolean {
  return !!intentId && rows.some((row) => row.intent_id === intentId && row.state === "reconciled");
}

interface CompletionRow {
  completion_packet_id: string;
  packet_version: number;
  packet_sha256: string;
  completed_at: string;
}

interface ServiceCaseRow {
  service_case_id: string;
  state: string;
  warranty_packet_id: string | null;
  updated_at: string;
}

interface HeadSelection<T> {
  row: T | null;
  ambiguous: boolean;
}

export interface CommercialJobPhaseReadModel {
  version: 1;
  read_model_generated_at: string;
  phase: CommercialJobPhase;
  job: {
    roof_job_id: string;
    lead_id: string;
    customer_id: string;
    property_id: string | null;
    status: string;
    current_gate_state: string;
    version: number;
  };
  facts: {
    commercial: {
      lead_status: string;
      lead_version: number;
      customer_status: string;
      customer_version: number;
      property_version: number | null;
      /**
       * The job's sole quote head in any status, or null when there is none or more than one.
       * `quote` below only admits an approved head, so on its own it cannot tell "no quote yet"
       * from "a quote exists but is still a draft, or was rejected".
       */
      quote_head: {
        quote_revision_id: string;
        revision_number: number;
        status: string;
        terms_hash: string;
      } | null;
      quote: Record<string, unknown> | null;
      proposal: Record<string, unknown> | null;
      publication: Record<string, unknown> | null;
      acceptance: Record<string, unknown> | null;
      /**
       * An exact acceptance of the current quote and proposal whose publication has since been
       * withdrawn. It never counts as `acceptance` — the phase does not advance on it — but hiding it
       * would let a reader believe the customer never accepted anything.
       */
      acceptance_under_withdrawn_publication: Record<string, unknown> | null;
      deposit_derivation: Record<string, unknown> | null;
      /**
       * `no_deposit_under_contract` once the deposit policy recorded that the accepted contract has
       * no deposit (OD-01, migration 0155): the Deposit gate is complete by `contract_no_deposit`.
       * That reads "No deposit under this contract", never done or paid. Null otherwise.
       */
      deposit_requirement: "no_deposit_under_contract" | null;
    };
    production: {
      gates: Array<Record<string, unknown>>;
      all_required_gates_ready: boolean;
      assignment: Record<string, unknown> | null;
      work_package: Record<string, unknown> | null;
    };
    safety: {
      active_stops: Array<Record<string, unknown>>;
      blocked: boolean;
    };
    accounting: {
      deposit_intents: Array<Record<string, unknown>>;
      final_invoice_intents: Array<Record<string, unknown>>;
      deposit_reconciled: boolean;
      final_invoice_reconciled: boolean;
    };
    closeout: {
      completion_packet: Record<string, unknown> | null;
    };
    warranty: {
      warranty_declared: boolean;
      service_cases: Array<Record<string, unknown>>;
    };
  };
  stale_reasons: string[];
}

/**
 * Build a read-only phase from independent native facts.  This function deliberately has no
 * writes and never uses the phase as an input to an authority or gate command.  A missing fact is
 * surfaced as stale/blocked rather than inferred as progress.
 */
export async function readCommercialJobPhase(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<CommercialJobPhaseReadModel | null> {
  const job = await env.DB.prepare(
    `SELECT job.roof_job_id, job.lead_id, job.customer_id, job.property_id,
            job.job_status, job.current_gate_state, job.version, job.updated_at,
            lead.lifecycle_status AS lead_status, lead.version AS lead_version,
            customer.lifecycle_status AS customer_status, customer.version AS customer_version,
            property.version AS property_version
       FROM operating_roof_jobs job
       JOIN operating_leads lead
         ON lead.tenant_id = job.tenant_id AND lead.lead_id = job.lead_id
       JOIN operating_customers customer
         ON customer.tenant_id = job.tenant_id AND customer.customer_id = job.customer_id
       LEFT JOIN operating_properties property
         ON property.tenant_id = job.tenant_id AND property.property_id = job.property_id
      WHERE job.tenant_id = ? AND job.roof_job_id = ? LIMIT 1`,
  ).bind(tenantId, roofJobId).first<JobRow>();
  if (!job) return null;

  const [quotes, proposals, publications, acceptance, deposit, gates, assignmentRead,
    workPackageRead, safetyStops, accounting, completion, serviceCases] = await Promise.all([
    env.DB.prepare(
      `SELECT quote_revision_id, customer_quote_id, revision_number, status, terms_hash,
              terms_json, currency, total_cents, valid_until, created_at
        FROM commercial_quote_revisions current
       WHERE current.tenant_id = ? AND current.roof_job_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM commercial_quote_revisions successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_quote_revision_id = current.quote_revision_id
         )
        ORDER BY current.revision_number DESC, current.quote_revision_id DESC
        LIMIT ${MAX_CURRENT_HEAD_ROWS}`,
    ).bind(tenantId, roofJobId).all<QuoteRow>(),
    env.DB.prepare(
      `SELECT proposal_revision_id, proposal_pack_id, revision_number, quote_revision_id,
              terms_hash, created_at
        FROM commercial_proposal_revisions current
       WHERE current.tenant_id = ? AND current.roof_job_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM commercial_proposal_revisions successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_proposal_revision_id = current.proposal_revision_id
         )
        ORDER BY current.revision_number DESC, current.proposal_revision_id DESC
        LIMIT ${MAX_CURRENT_HEAD_ROWS}`,
    ).bind(tenantId, roofJobId).all<ProposalRow>(),
    env.DB.prepare(
      `SELECT publication_event_id, proposal_revision_id, proposal_pack_id,
              publication_version, state, occurred_at
         FROM commercial_proposal_publication_events current
        WHERE current.tenant_id = ? AND current.proposal_pack_id IN (
          SELECT proposal_pack_id FROM commercial_proposal_revisions
           WHERE tenant_id = ? AND roof_job_id = ?
        )
          AND NOT EXISTS (
            SELECT 1 FROM commercial_proposal_publication_events successor
             WHERE successor.tenant_id = current.tenant_id
               AND successor.proposal_pack_id = current.proposal_pack_id
               AND successor.publication_version > current.publication_version
          )
        ORDER BY current.publication_version DESC, current.publication_event_id DESC
        LIMIT ${MAX_CURRENT_HEAD_ROWS}`,
    ).bind(tenantId, tenantId, roofJobId).all<PublicationRow>(),
    env.DB.prepare(
      `SELECT acceptance_binding_id, acceptance_id, quote_revision_id, proposal_revision_id,
              terms_hash, accepted_at, bound_at
         FROM commercial_acceptance_bindings
        WHERE tenant_id = ? AND roof_job_id = ?
        ORDER BY accepted_at DESC, acceptance_binding_id DESC
        LIMIT ${MAX_ACCEPTANCE_ROWS}`,
    ).bind(tenantId, roofJobId).all<AcceptanceRow>(),
    env.DB.prepare(
      `SELECT derivation_id, acceptance_id, state, intent_id, blocker_code,
              blocker_next_step, version, updated_at
         FROM commercial_deposit_derivations
        WHERE tenant_id = ? AND roof_job_id = ?
        ORDER BY accepted_at DESC, derivation_id DESC
        LIMIT ${MAX_DEPOSIT_ROWS}`,
    ).bind(tenantId, roofJobId).all<DepositRow>(),
    env.DB.prepare(
      `SELECT gate.gate, gate.state, gate.blocker_reason, gate.version, gate.updated_at,
              entry.basis AS basis_in_force
         FROM operating_production_gates gate
         LEFT JOIN production_gate_clearances entry
           ON entry.tenant_id = gate.tenant_id AND entry.clearance_id = gate.clearance_decision_id
        WHERE gate.tenant_id = ? AND gate.roof_job_id = ?
        ORDER BY gate.gate ASC`,
    ).bind(tenantId, roofJobId).all<GateRow>(),
    env.DB.prepare(
      `SELECT current.assignment_id, current.assignment_version, current.crew_id,
              current.scheduled_start, current.scheduled_end, current.created_at AS updated_at
         FROM operating_job_assignments current
        WHERE current.tenant_id = ? AND current.roof_job_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM operating_job_assignments successor
             WHERE successor.tenant_id = current.tenant_id
               AND successor.supersedes_assignment_id = current.assignment_id
          )
        ORDER BY current.assignment_version DESC LIMIT ${MAX_CURRENT_HEAD_ROWS}`,
    ).bind(tenantId, roofJobId).all<AssignmentRow>(),
    env.DB.prepare(
      `SELECT work_package_id, version, status, updated_at
         FROM work_packages
        WHERE tenant_id = ? AND job_id = ? AND status != 'Superseded'
        ORDER BY CASE WHEN status = 'In Progress' THEN 0 ELSE 1 END,
                 updated_at DESC, version DESC LIMIT ${MAX_CURRENT_HEAD_ROWS}`,
    ).bind(tenantId, roofJobId).all<WorkPackageRow>(),
    env.DB.prepare(
      `SELECT occurrence_id, severity, state, stop_active, updated_at
         FROM safety_occurrences
        WHERE tenant_id = ? AND scope_type = 'roof_job' AND scope_id = ?
          AND stop_active = 1
        ORDER BY updated_at DESC, occurrence_id DESC LIMIT ${MAX_SAFETY_STOP_ROWS}`,
    ).bind(tenantId, roofJobId).all<SafetyRow>(),
    env.DB.prepare(
      `SELECT *
         FROM accounting_intents
        WHERE tenant_id = ? AND roof_job_id = ?
        ORDER BY updated_at DESC, intent_id DESC`,
    ).bind(tenantId, roofJobId).all<AccountingRow>(),
    env.DB.prepare(
      `SELECT completion_packet_id, packet_version, packet_sha256, completed_at
         FROM native_completion_packets
        WHERE tenant_id = ? AND roof_job_id = ?
        ORDER BY packet_version DESC, completed_at DESC LIMIT 1`,
    ).bind(tenantId, roofJobId).first<CompletionRow>(),
    env.DB.prepare(
      `SELECT service_case_id, state, warranty_packet_id, updated_at
         FROM service_cases
        WHERE tenant_id = ? AND roof_job_id = ?
        ORDER BY updated_at DESC, service_case_id DESC LIMIT ${MAX_SERVICE_CASE_ROWS}`,
    ).bind(tenantId, roofJobId).all<ServiceCaseRow>(),
  ]);

  const quoteSelection = latestQuote(quotes.results ?? []);
  const quote = quoteSelection.row;
  const proposalRows = proposals.results ?? [];
  const proposalHead = quote
    ? latestProposal(proposalRows.filter((row) => row.quote_revision_id === quote.quote_revision_id))
    : { row: null, ambiguous: false };
  const proposalTermsMismatch = !!quote && !!proposalHead.row && proposalHead.row.terms_hash !== quote.terms_hash;
  const proposalSelection: HeadSelection<ProposalRow> = {
    row: proposalTermsMismatch ? null : proposalHead.row,
    ambiguous: proposalHead.ambiguous || proposalRows.length > 1,
  };
  const proposal = proposalSelection.row;
  const publicationRows = publications.results ?? [];
  const publicationSelection = proposal
    ? latestPublication(publicationRows.filter((row) => row.proposal_revision_id === proposal.proposal_revision_id))
    : { row: null, ambiguous: false };
  if (publicationRows.length > 1) publicationSelection.ambiguous = true;
  const publication = publicationSelection.row;
  const acceptanceRows = acceptance.results ?? [];
  const exactAcceptanceCandidates = quote && proposal && publication && publication.state === "published"
    ? acceptanceRows.filter((row) =>
        row.quote_revision_id === quote.quote_revision_id &&
        row.proposal_revision_id === proposal.proposal_revision_id &&
        row.terms_hash === quote.terms_hash)
    : [];
  const withdrawnAcceptanceCandidates = quote && proposal && publication && publication.state !== "published"
    ? acceptanceRows.filter((row) =>
        row.quote_revision_id === quote.quote_revision_id &&
        row.proposal_revision_id === proposal.proposal_revision_id &&
        row.terms_hash === quote.terms_hash)
    : [];
  const acceptanceAmbiguous = exactAcceptanceCandidates.length > 1;
  const exactAcceptance = exactAcceptanceCandidates.length === 1
    ? exactAcceptanceCandidates[0]!
    : null;
  const depositRows = deposit.results ?? [];
  const exactDepositCandidates = exactAcceptance
    ? depositRows.filter((row) => row.acceptance_id === exactAcceptance.acceptance_id)
    : [];
  const depositAmbiguous = exactDepositCandidates.length > 1;
  const exactDeposit = exactDepositCandidates.length === 1
    ? exactDepositCandidates[0]!
    : null;
  const gateRows = gates.results ?? [];
  // OD-01 (0155): a contract with no deposit, which the policy recorded on the Deposit gate.
  const quoteHasNoDeposit = !!quote && contractDepositTerms(quote.terms_json) === "no_deposit";
  const depositGate = gateRows.find((row) => row.gate === "Deposit");
  const depositNotRequired = !!exactAcceptance && quoteHasNoDeposit &&
    depositGate?.state === "complete" && depositGate.basis_in_force === "contract_no_deposit";
  const requiredGateNames = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"];
  const allRequiredGatesReady = requiredGateNames.every((name) => {
    const gate = gateRows.find((row) => row.gate === name);
    return !!gate && ["ready", "complete", "waived"].includes(gate.state);
  });
  const stopRows = safetyStops.results ?? [];
  const accountingRows = accounting.results ?? [];
  const depositIntents = accountingRows.filter((row) => row.kind === "deposit_invoice");
  const finalInvoiceIntents = accountingRows.filter(
    (row) => row.final_invoice_intent_id === row.intent_id,
  );
  const depositReconciled = depositIntentIsReconciled(exactDeposit?.intent_id ?? null, depositIntents);
  const finalInvoiceCurrent = await Promise.all(
    finalInvoiceIntents.map((row) => isNativeFinalInvoiceCurrent(env, row)),
  );
  const finalInvoiceReconciled = finalInvoiceCurrent.some(Boolean);
  const completionPacket = completion ?? null;
  const warrantyDeclared = quote ? warrantyDeclaredInTerms(quote.terms_json) : false;
  const assignmentRows = assignmentRead.results ?? [];
  const workPackageRows = workPackageRead.results ?? [];
  const assignment = assignmentRows.length === 1 ? assignmentRows[0]! : null;
  const workPackage = selectPhaseWorkPackage(workPackageRows);
  const phase = derivePhase({
    jobStatus: job.job_status,
    leadStatus: job.lead_status,
    quote,
    proposal,
    publication,
    acceptance: exactAcceptance,
    deposit: exactDeposit,
    depositReconciled,
    depositNotRequired,
    finalInvoiceReconciled,
    allRequiredGatesReady,
    safetyBlocked: stopRows.length > 0,
    assignment,
    workPackage,
    completionPacket,
  });
  const staleReasons = phaseStaleReasons({
    quote,
    proposal,
    publication,
    acceptance: exactAcceptance,
    deposit: exactDeposit,
    quoteHasNoDeposit,
    depositNotRequired,
    gateRows,
    requiredGateNames,
    completionPacket,
    quoteAmbiguous: quoteSelection.ambiguous,
    quoteHeadPresent: (quotes.results ?? []).length === 1,
    withdrawnAcceptanceCount: withdrawnAcceptanceCandidates.length,
    proposalAmbiguous: proposalSelection.ambiguous,
    publicationAmbiguous: publicationSelection.ambiguous,
    proposalTermsMismatch,
    acceptanceAmbiguous,
    depositAmbiguous,
    finalInvoiceIntentCount: finalInvoiceIntents.length,
    finalInvoiceReconciled,
    assignmentAmbiguous: assignmentRows.length > 1,
    safetyOverflow: stopRows.length >= MAX_SAFETY_STOP_ROWS,
    serviceCaseOverflow: (serviceCases.results ?? []).length >= MAX_SERVICE_CASE_ROWS,
    acceptanceOverflow: acceptanceRows.length >= MAX_ACCEPTANCE_ROWS,
    depositOverflow: depositRows.length >= MAX_DEPOSIT_ROWS,
  });
  return {
    version: 1,
    read_model_generated_at: new Date().toISOString(),
    phase,
    job: {
      roof_job_id: job.roof_job_id,
      lead_id: job.lead_id,
      customer_id: job.customer_id,
      property_id: job.property_id,
      status: job.job_status,
      current_gate_state: job.current_gate_state,
      version: job.version,
    },
    facts: {
      commercial: {
        lead_status: job.lead_status,
        lead_version: job.lead_version,
        customer_status: job.customer_status,
        customer_version: job.customer_version,
        property_version: job.property_version,
        quote_head: quoteHeadProjection(quotes.results ?? []),
        quote: quote ? quoteProjection(quote) : null,
        proposal: proposal ? proposalProjection(proposal) : null,
        publication: publication ? publicationProjection(publication) : null,
        acceptance: exactAcceptance ? acceptanceProjection(exactAcceptance) : null,
        acceptance_under_withdrawn_publication: withdrawnAcceptanceCandidates.length === 1
          ? acceptanceProjection(withdrawnAcceptanceCandidates[0]!)
          : null,
        deposit_derivation: exactDeposit ? depositProjection(exactDeposit) : null,
        deposit_requirement: depositNotRequired ? "no_deposit_under_contract" : null,
      },
      production: {
        gates: gateRows.map(gateProjection),
        all_required_gates_ready: allRequiredGatesReady,
        assignment: assignment ? assignmentProjection(assignment) : null,
        work_package: workPackage ? workPackageProjection(workPackage) : null,
      },
      safety: {
        active_stops: stopRows.map(safetyProjection),
        blocked: stopRows.length > 0,
      },
      accounting: {
        deposit_intents: depositIntents.map(accountingProjection),
        final_invoice_intents: finalInvoiceIntents.map(accountingProjection),
        deposit_reconciled: depositReconciled,
        final_invoice_reconciled: finalInvoiceReconciled,
      },
      closeout: {
        completion_packet: completionPacket ? completionProjection(completionPacket) : null,
      },
      warranty: {
        warranty_declared: warrantyDeclared,
        service_cases: (serviceCases.results ?? []).map(serviceCaseProjection),
      },
    },
    stale_reasons: staleReasons,
  };
}

function latestQuote(rows: QuoteRow[]): HeadSelection<QuoteRow> {
  if (rows.length > 1) return { row: null, ambiguous: true };
  const row = rows[0] ?? null;
  return { row: row?.status === "approved" ? row : null, ambiguous: false };
}

function latestProposal(rows: ProposalRow[]): HeadSelection<ProposalRow> {
  if (rows.length > 1) return { row: null, ambiguous: true };
  return { row: rows[0] ?? null, ambiguous: false };
}

export function selectPhaseWorkPackage(
  rows: readonly WorkPackageRow[],
): WorkPackageRow | null {
  return rows.find((row) => row.status === "In Progress") ?? rows[0] ?? null;
}

function latestPublication(rows: PublicationRow[]): HeadSelection<PublicationRow> {
  if (rows.length > 1) return { row: null, ambiguous: true };
  return { row: rows[0] ?? null, ambiguous: false };
}

function warrantyDeclaredInTerms(termsJson: string): boolean {
  try {
    const terms = JSON.parse(termsJson) as unknown;
    return !!terms && typeof terms === "object" && !Array.isArray(terms) &&
      Number((terms as Record<string, unknown>).warranty_years) > 0;
  } catch {
    return false;
  }
}

export function derivePhase(input: {
  jobStatus: string;
  leadStatus: string;
  quote: QuoteRow | null;
  proposal: ProposalRow | null;
  publication: PublicationRow | null;
  acceptance: AcceptanceRow | null;
  deposit: DepositRow | null;
  depositReconciled: boolean;
  /** OD-01 (0155): the policy recorded Deposit as not required by the accepted contract. */
  depositNotRequired?: boolean;
  finalInvoiceReconciled: boolean;
  allRequiredGatesReady: boolean;
  safetyBlocked: boolean;
  assignment: AssignmentRow | null;
  workPackage: WorkPackageRow | null;
  completionPacket: CompletionRow | null;
}): CommercialJobPhase {
  if (input.jobStatus === "cancelled") return "cancelled";
  if (input.safetyBlocked) return "safety_blocked";
  if (!["qualified", "converted"].includes(input.leadStatus)) return "qualification_pending";
  if (!input.quote || !input.proposal || !input.publication || input.publication.state !== "published")
    return input.quote || input.proposal || input.publication ? "commercial_in_progress" : "qualified";
  if (!input.acceptance) return "commercial_in_progress";
  // A contract with no deposit has no deposit pending.
  if (
    !input.depositNotRequired &&
    (!input.deposit || input.deposit.state !== "derived" || !input.depositReconciled)
  )
    return "deposit_pending";
  if (!input.allRequiredGatesReady) return "production_blocked";
  if (input.finalInvoiceReconciled && input.completionPacket) return "financially_closed";
  if (input.completionPacket) return "substantially_complete";
  if (input.workPackage?.status === "In Progress") return "in_progress";
  if (input.assignment) return "scheduled";
  return "production_ready";
}

function phaseStaleReasons(input: {
  quote: QuoteRow | null;
  proposal: ProposalRow | null;
  publication: PublicationRow | null;
  acceptance: AcceptanceRow | null;
  deposit: DepositRow | null;
  quoteHasNoDeposit: boolean;
  depositNotRequired: boolean;
  gateRows: GateRow[];
  requiredGateNames: string[];
  completionPacket: CompletionRow | null;
  quoteAmbiguous: boolean;
  quoteHeadPresent: boolean;
  withdrawnAcceptanceCount: number;
  proposalAmbiguous: boolean;
  publicationAmbiguous: boolean;
  proposalTermsMismatch: boolean;
  acceptanceAmbiguous: boolean;
  depositAmbiguous: boolean;
  finalInvoiceIntentCount: number;
  finalInvoiceReconciled: boolean;
  assignmentAmbiguous: boolean;
  safetyOverflow: boolean;
  serviceCaseOverflow: boolean;
  acceptanceOverflow: boolean;
  depositOverflow: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.quoteAmbiguous) reasons.push("commercial.quote_head_ambiguous");
  // A sole head that is still a draft, under review, rejected or expired is not "missing".
  else if (!input.quote && input.quoteHeadPresent) reasons.push("commercial.quote_head_not_approved");
  else if (!input.quote) reasons.push("commercial.quote_head_missing");
  if (input.proposalAmbiguous) reasons.push("commercial.proposal_head_ambiguous");
  else if (input.proposalTermsMismatch) reasons.push("commercial.proposal_terms_mismatch");
  else if (!input.proposal) reasons.push("commercial.proposal_head_missing");
  if (input.publicationAmbiguous) reasons.push("commercial.publication_head_ambiguous");
  else if (!input.publication || input.publication.state !== "published") reasons.push("commercial.publication_not_settled");
  if (input.withdrawnAcceptanceCount > 0) {
    reasons.push("commercial.customer_acceptance_publication_withdrawn");
  }
  if (input.acceptanceAmbiguous) reasons.push("commercial.customer_acceptance_ambiguous");
  else if (!input.acceptance) reasons.push("commercial.customer_acceptance_missing");
  if (input.acceptanceOverflow) reasons.push("commercial.customer_acceptance_scan_overflow");
  if (input.depositAmbiguous) reasons.push("commercial.deposit_derivation_ambiguous");
  // A quote with no deposit (OD-01) never has a derivation; once accepted, the open fact is the
  // policy's Deposit record.
  else if (input.quoteHasNoDeposit) {
    if (input.acceptance && !input.depositNotRequired) {
      reasons.push("commercial.no_deposit_record_missing");
    }
  }
  else if (!input.deposit) reasons.push("commercial.deposit_derivation_missing");
  else if (input.deposit.state !== "derived") reasons.push(`commercial.deposit_${input.deposit.state}`);
  if (input.depositOverflow) reasons.push("commercial.deposit_derivation_scan_overflow");
  for (const gate of input.requiredGateNames) {
    const row = input.gateRows.find((candidate) => candidate.gate === gate);
    if (!row) reasons.push(`production.gate_${gate.toLowerCase()}_missing`);
    else if (!["ready", "complete", "waived"].includes(row.state)) reasons.push(`production.gate_${gate.toLowerCase()}_${row.state}`);
  }
  if (!input.completionPacket) {
    reasons.push("closeout.completion_packet_missing");
  }
  if (input.finalInvoiceIntentCount === 0) reasons.push("accounting.final_invoice_missing");
  else if (!input.finalInvoiceReconciled) reasons.push("accounting.final_invoice_not_current");
  if (input.assignmentAmbiguous) reasons.push("production.assignment_head_ambiguous");
  if (input.safetyOverflow) reasons.push("safety.active_stop_scan_overflow");
  if (input.serviceCaseOverflow) reasons.push("warranty.service_case_scan_overflow");
  return reasons;
}

function quoteHeadProjection(
  rows: readonly QuoteRow[],
): CommercialJobPhaseReadModel["facts"]["commercial"]["quote_head"] {
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    quote_revision_id: row.quote_revision_id,
    revision_number: row.revision_number,
    status: row.status,
    terms_hash: row.terms_hash,
  };
}

function quoteProjection(row: QuoteRow): Record<string, unknown> {
  return {
    quote_revision_id: row.quote_revision_id,
    customer_quote_id: row.customer_quote_id,
    revision_number: row.revision_number,
    status: row.status,
    terms_hash: row.terms_hash,
    currency: row.currency,
    total_cents: row.total_cents,
    valid_until: row.valid_until,
  };
}

function proposalProjection(row: ProposalRow): Record<string, unknown> {
  return {
    proposal_revision_id: row.proposal_revision_id,
    proposal_pack_id: row.proposal_pack_id,
    revision_number: row.revision_number,
    quote_revision_id: row.quote_revision_id,
    terms_hash: row.terms_hash,
  };
}

function publicationProjection(row: PublicationRow): Record<string, unknown> {
  return {
    publication_event_id: row.publication_event_id,
    proposal_revision_id: row.proposal_revision_id,
    proposal_pack_id: row.proposal_pack_id,
    publication_version: row.publication_version,
    state: row.state,
    occurred_at: row.occurred_at,
  };
}

function acceptanceProjection(row: AcceptanceRow): Record<string, unknown> {
  return {
    acceptance_binding_id: row.acceptance_binding_id,
    acceptance_id: row.acceptance_id,
    quote_revision_id: row.quote_revision_id,
    proposal_revision_id: row.proposal_revision_id,
    terms_hash: row.terms_hash,
    accepted_at: row.accepted_at,
    bound_at: row.bound_at,
  };
}

function depositProjection(row: DepositRow): Record<string, unknown> {
  return {
    derivation_id: row.derivation_id,
    acceptance_id: row.acceptance_id,
    state: row.state,
    intent_id: row.intent_id,
    blocker_code: row.blocker_code,
    blocker_next_step: row.blocker_next_step,
    version: row.version,
    updated_at: row.updated_at,
  };
}

function gateProjection(row: GateRow): Record<string, unknown> {
  return { gate: row.gate, state: row.state, blocker_reason: row.blocker_reason, version: row.version, updated_at: row.updated_at };
}

function assignmentProjection(row: AssignmentRow): Record<string, unknown> {
  return { assignment_id: row.assignment_id, assignment_version: row.assignment_version, crew_id: row.crew_id, scheduled_start: row.scheduled_start, scheduled_end: row.scheduled_end, updated_at: row.updated_at };
}

function workPackageProjection(row: WorkPackageRow): Record<string, unknown> {
  return { work_package_id: row.work_package_id, version: row.version, status: row.status, updated_at: row.updated_at };
}

function safetyProjection(row: SafetyRow): Record<string, unknown> {
  return { occurrence_id: row.occurrence_id, severity: row.severity, state: row.state, updated_at: row.updated_at };
}

function accountingProjection(row: AccountingRow): Record<string, unknown> {
  return { intent_id: row.intent_id, kind: row.kind, state: row.state, version: row.version, total_amount: row.total_amount, settled_amount: row.settled_amount, final_invoice_intent_id: row.final_invoice_intent_id, updated_at: row.updated_at };
}

function completionProjection(row: CompletionRow): Record<string, unknown> {
  return { completion_packet_id: row.completion_packet_id, packet_version: row.packet_version, packet_sha256: row.packet_sha256, completed_at: row.completed_at };
}

function serviceCaseProjection(row: ServiceCaseRow): Record<string, unknown> {
  return { service_case_id: row.service_case_id, state: row.state, warranty_packet_id: row.warranty_packet_id, updated_at: row.updated_at };
}
