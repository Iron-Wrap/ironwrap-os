// deposit-policy.ts - the tenant's deposit policy, the contracts it allows, and the Deposit gate
// entries it records (migration 0155).
//
// The policy is the owner's append-only setting; the latest revision is in force and a tenant with
// none is `od01_payment_on_completion`, because no prepaid licence is the safe default.
//   * `od01_payment_on_completion` (OD-01): a contract has no deposit and is paid on completion,
//     `deposit_percent: 0` with `payment_schedule: ["completion"]`. The policy records its Deposit
//     gate, with the contract version as evidence, and it reads "No deposit under this contract".
//   * `md13_deposit` (MD-13): a contract carries a deposit of 1 to 100 percent, which clears
//     Deposit once that contract's own deposit invoice is reconciled, or the owner waives it.
// Terms the policy does not allow are refused by name, `deposit_terms_not_allowed_by_policy`, at
// the quote, proposal, publication and acceptance routes; D1 aborts the acceptance as a backstop.
//
//   GET  /api/v1/owner/deposit-policy   the policy in force (version 0 when none was recorded).
//   POST /api/v1/owner/deposit-policy   `{policy, expected_version, reason}`: the owner records a
//     revision. People only: the CSRF token, then the owner's own cookie session. The
//     Idempotency-Key is stored as a hash next to the request's hash: an exact replay answers as
//     the first request did, and the same key with another body is a replay conflict.
//
// The Deposit gate entry is a policy entry in the 0153 ledger: `recordContractDepositGate` appends
// it after an acceptance has committed, never inside it, and `sweepContractDepositGates` appends
// any that is missing on the five-minute cron. Both are idempotent by acceptance binding id.

import { configuredTenantId, personCookieSession, validAppCsrf } from "./app-auth.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";

export const TENANT_DEPOSIT_POLICIES = ["od01_payment_on_completion", "md13_deposit"] as const;
export type TenantDepositPolicy = (typeof TENANT_DEPOSIT_POLICIES)[number];
/** The policy of a tenant with no revision: no prepaid licence is the safe default. */
export const DEFAULT_TENANT_DEPOSIT_POLICY: TenantDepositPolicy = "od01_payment_on_completion";
export const DEPOSIT_GATE_POLICY_VERSION = "ironwrap.deposit-gate.v1";
export const DEPOSIT_TERMS_REFUSAL = "deposit_terms_not_allowed_by_policy";
/**
 * The same refusal as the customer sees it: plain words and no policy or field names, which stay
 * in the staff routes and the log. Generic until PR-C brings Track B's copy.
 */
export const CUSTOMER_DEPOSIT_TERMS_REFUSAL = {
  error: DEPOSIT_TERMS_REFUSAL,
  message: "This contract can't be accepted online. Please contact us to update its payment terms.",
} as const;
/** How the Deposit gate reads once the policy recorded a contract with no deposit (OD-01). */
export const NO_DEPOSIT_UNDER_CONTRACT = "No deposit under this contract";

/** D1's clock, in the form `Date.toISOString` writes: the policy's own rows take D1's time. */
const D1_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const MAX_BODY_BYTES = 4 * 1024;
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 1_000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,160}$/;
/** One tick appends at most this many missing Deposit entries. */
const SWEEP_LIMIT = 100;

export interface TenantDepositPolicyState {
  policy: TenantDepositPolicy;
  /** The latest revision, or 0 when the tenant has none and the default is in force. */
  version: number;
  revision_id: string | null;
  set_by_user_id: string | null;
  set_at: string | null;
  reason: string | null;
}

export interface DepositTermsRefusal {
  error: typeof DEPOSIT_TERMS_REFUSAL;
  policy: TenantDepositPolicy;
  /** The term to change. */
  field: "terms.deposit_percent" | "terms.payment_schedule";
}

/** What a contract's recorded terms say about a deposit. */
export type ContractDepositTerms = "no_deposit" | "deposit" | "invalid";

interface RevisionRow {
  revision_id: string;
  revision: number;
  policy: TenantDepositPolicy;
  reason: string;
  set_by_user_id: string;
  set_at: string;
  request_sha256: string;
}

class DepositPolicyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.name = "DepositPolicyError";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsedTerms(terms: unknown): unknown {
  if (typeof terms !== "string") return terms;
  try {
    return JSON.parse(terms) as unknown;
  } catch {
    return null;
  }
}

/**
 * The deposit a contract's terms carry, read the way D1 reads them in 0155: an integer
 * `deposit_percent` of 0 with exactly `["completion"]` is no deposit, 1 to 100 is a deposit, and
 * anything else is neither. Terms may be the recorded JSON text or its parsed object.
 */
export function contractDepositTerms(terms: unknown): ContractDepositTerms {
  const value = parsedTerms(terms);
  if (!isRecord(value) || !Number.isInteger(value.deposit_percent)) return "invalid";
  const percent = value.deposit_percent as number;
  if (percent === 0) {
    const schedule = value.payment_schedule;
    return Array.isArray(schedule) && schedule.length === 1 && schedule[0] === "completion"
      ? "no_deposit"
      : "invalid";
  }
  return percent >= 1 && percent <= 100 ? "deposit" : "invalid";
}

/** The named refusal for terms the policy does not allow, or null when it allows them. */
export function depositTermsRefusalFor(
  policy: TenantDepositPolicy,
  terms: unknown,
): DepositTermsRefusal | null {
  const kind = contractDepositTerms(terms);
  if (policy === "md13_deposit") {
    return kind === "deposit"
      ? null
      : { error: DEPOSIT_TERMS_REFUSAL, policy, field: "terms.deposit_percent" };
  }
  if (kind === "no_deposit") return null;
  const value = parsedTerms(terms);
  const field = isRecord(value) && value.deposit_percent === 0
    ? "terms.payment_schedule"
    : "terms.deposit_percent";
  return { error: DEPOSIT_TERMS_REFUSAL, policy, field };
}

/** The same refusal under the policy the tenant has in force now. */
export async function depositTermsRefusal(
  env: AppEnv,
  tenantId: string,
  terms: unknown,
): Promise<DepositTermsRefusal | null> {
  const { policy } = await readTenantDepositPolicy(env, tenantId);
  return depositTermsRefusalFor(policy, terms);
}

function stateOf(row: RevisionRow): TenantDepositPolicyState {
  return {
    policy: row.policy,
    version: Number(row.revision),
    revision_id: row.revision_id,
    set_by_user_id: row.set_by_user_id,
    set_at: row.set_at,
    reason: row.reason,
  };
}

const REVISION_COLUMNS =
  "revision_id, revision, policy, reason, set_by_user_id, set_at, request_sha256";

export async function readTenantDepositPolicy(
  env: AppEnv,
  tenantId: string,
): Promise<TenantDepositPolicyState> {
  const row = await env.DB.prepare(
    `SELECT ${REVISION_COLUMNS} FROM tenant_deposit_policy_revisions
      WHERE tenant_id = ? ORDER BY revision DESC LIMIT 1`,
  ).bind(tenantId).first<RevisionRow>();
  return row ? stateOf(row) : {
    policy: DEFAULT_TENANT_DEPOSIT_POLICY,
    version: 0,
    revision_id: null,
    set_by_user_id: null,
    set_at: null,
    reason: null,
  };
}

async function revisionByKey(env: AppEnv, tenantId: string, keyHash: string) {
  return await env.DB.prepare(
    `SELECT ${REVISION_COLUMNS} FROM tenant_deposit_policy_revisions
      WHERE tenant_id = ? AND idempotency_key_hash = ?`,
  ).bind(tenantId, keyHash).first<RevisionRow>();
}

/** The D1 refusals 0155 raises on a revision, as this route answers them. */
const POLICY_REFUSALS: Readonly<Record<string, number>> = {
  tenant_deposit_policy_version_conflict: 409,
  tenant_deposit_policy_owner_required: 403,
  tenant_deposit_policy_append_only: 409,
};

function parseChange(body: unknown): {
  policy: TenantDepositPolicy;
  expectedVersion: number;
  reason: string;
} | null {
  if (!isRecord(body)) return null;
  if (Object.keys(body).sort().join(",") !== "expected_version,policy,reason") return null;
  const { policy, expected_version: version } = body;
  if (!(TENANT_DEPOSIT_POLICIES as readonly unknown[]).includes(policy)) return null;
  if (!Number.isInteger(version) || (version as number) < 0 || (version as number) >= 1_000_000) {
    return null;
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) return null;
  if (/[\u0000\r]/.test(reason)) return null;
  return { policy: policy as TenantDepositPolicy, expectedVersion: version as number, reason };
}

async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    throw new DepositPolicyError("payload_too_large", 413);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new DepositPolicyError("payload_too_large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DepositPolicyError("invalid_json", 400);
  }
}

/** `GET`/`POST /api/v1/owner/deposit-policy`. Owner only; a change is a person's own decision. */
export async function handleTenantDepositPolicy(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response> {
  try {
    const tenantId = auth.session.tenant_id;
    if (req.method === "GET") {
      if (auth.session.role !== "owner") throw new DepositPolicyError("owner_role_required", 403);
      return json({ deposit_policy: await readTenantDepositPolicy(env, tenantId) });
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (!validAppCsrf(req, auth)) throw new DepositPolicyError("csrf_failed", 403);
    const person = await personCookieSession(env, auth);
    if (!person) throw new DepositPolicyError("person_session_required", 403);
    if (person.role !== "owner") throw new DepositPolicyError("owner_role_required", 403);
    const key = req.headers.get("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY_RE.test(key)) throw new DepositPolicyError("idempotency_key_required", 400);
    const change = parseChange(await readBody(req));
    if (!change) throw new DepositPolicyError("invalid_tenant_deposit_policy", 400);

    const keyHash = await sha256Hex(key);
    const revisionId = `tdp_${(await sha256Hex(`${tenantId}:${keyHash}`)).slice(0, 40)}`;
    const requestSha256 = await sha256Hex(canonicalJson({
      route: "tenant_deposit_policy",
      tenant_id: tenantId,
      actor_user_id: person.userId,
      policy: change.policy,
      expected_version: change.expectedVersion,
      reason: change.reason,
    }));
    const replay = async (row: RevisionRow) => {
      if (row.request_sha256 !== requestSha256) {
        throw new DepositPolicyError("tenant_deposit_policy_replay_conflict", 409);
      }
      return json({ deposit_policy: stateOf(row), replayed: true });
    };
    const existing = await revisionByKey(env, tenantId, keyHash);
    if (existing) return await replay(existing);
    const current = await readTenantDepositPolicy(env, tenantId);
    if (current.version !== change.expectedVersion) {
      throw new DepositPolicyError("tenant_deposit_policy_version_conflict", 409);
    }
    try {
      // D1 re-checks the owner, the next revision and append-only, and writes the audit row.
      await env.DB.prepare(
        `INSERT INTO tenant_deposit_policy_revisions (
           revision_id, tenant_id, revision, policy, reason, set_by_user_id, set_by_role,
           request_sha256, idempotency_key_hash, set_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?, ${D1_NOW})`,
      ).bind(
        revisionId,
        tenantId,
        change.expectedVersion + 1,
        change.policy,
        change.reason,
        person.userId,
        requestSha256,
        keyHash,
      ).run();
    } catch (error) {
      const raced = await revisionByKey(env, tenantId, keyHash);
      if (raced) return await replay(raced);
      const message = error instanceof Error ? error.message : String(error);
      const code = Object.keys(POLICY_REFUSALS).find((candidate) => message.includes(candidate));
      throw code
        ? new DepositPolicyError(code, POLICY_REFUSALS[code]!)
        : new DepositPolicyError("tenant_deposit_policy_failed", 502);
    }
    const stored = await revisionByKey(env, tenantId, keyHash);
    if (!stored) throw new DepositPolicyError("tenant_deposit_policy_failed", 502);
    return json({ deposit_policy: stateOf(stored), replayed: false });
  } catch (error) {
    if (error instanceof DepositPolicyError) return json({ error: error.code }, error.status);
    return json({ error: "tenant_deposit_policy_failed" }, 502);
  }
}

// --------------------------------------------------------------------------- the Deposit gate

export type ContractDepositGateOutcome =
  | {
    outcome: "recorded" | "already_recorded";
    basis: "contract_no_deposit" | "contract_superseded";
    clearance_id: string;
  }
  | { outcome: "not_applicable" | "refused"; reason: string };

interface ContractFacts {
  acceptance_binding_id: string;
  acceptance_id: string;
  roof_job_id: string;
  quote_revision_id: string;
  proposal_revision_id: string;
  terms_hash: string;
  receipt_hash: string;
  accepted_at: string;
  acceptance_state: string;
  customer_quote_id: string;
  quote_revision_number: number;
  terms_json: string;
  quote_terms_hash: string;
  quote_evidence_digest: string;
  policy_permit_id: string | null;
  permit_actor_type: string | null;
  permit_actor_id: string | null;
  quote_revision_approval_id: string | null;
  approval_approved_by_user_id: string | null;
  proposal_evidence_digest: string;
  publication_event_id: string | null;
  publication_evidence_digest: string | null;
  superseded: number;
  gate_id: string | null;
  gate_state: string | null;
  gate_version: number | null;
  in_force_clearance_id: string | null;
  in_force_basis: string | null;
  in_force_binding_id: string | null;
}

/** The 0155 ledger refusals a policy entry can meet, kept by name in the outcome. */
const LEDGER_CODES = [
  "production_gate_contract_no_deposit_not_observed",
  "production_gate_contract_superseded_not_observed",
  "deposit_terms_not_allowed_by_policy",
  "production_gate_version_conflict",
  "production_gate_already_cleared",
  "production_gate_clearance_basis_invalid",
  "production_gate_clearance_append_only",
] as const;

/** The binding is the job's latest accepted contract when none of the job was accepted after it. */
const LATER_BINDING = `EXISTS (
  SELECT 1 FROM commercial_acceptance_bindings later
   WHERE later.tenant_id = binding.tenant_id
     AND later.roof_job_id = binding.roof_job_id
     AND (later.accepted_at > binding.accepted_at
          OR (later.accepted_at = binding.accepted_at
              AND later.acceptance_binding_id > binding.acceptance_binding_id)))`;

async function contractFacts(
  env: AppEnv,
  tenantId: string,
  bindingId: string,
): Promise<ContractFacts | null> {
  return await env.DB.prepare(
    `SELECT binding.acceptance_binding_id, binding.acceptance_id, binding.roof_job_id,
            binding.quote_revision_id, binding.proposal_revision_id, binding.terms_hash,
            binding.receipt_hash, binding.accepted_at, acceptance.state AS acceptance_state,
            quote.customer_quote_id, quote.revision_number AS quote_revision_number,
            quote.terms_json, quote.terms_hash AS quote_terms_hash,
            quote.evidence_digest AS quote_evidence_digest,
            quote.policy_permit_id, permit.actor_type AS permit_actor_type,
            permit.actor_id AS permit_actor_id, quote.quote_revision_approval_id,
            approval.approved_by_user_id AS approval_approved_by_user_id,
            proposal.evidence_digest AS proposal_evidence_digest,
            publication.publication_event_id,
            publication.evidence_digest AS publication_evidence_digest,
            ${LATER_BINDING} AS superseded,
            gate.gate_id, gate.state AS gate_state, gate.version AS gate_version,
            in_force.clearance_id AS in_force_clearance_id, in_force.basis AS in_force_basis,
            in_force.contract_binding_id AS in_force_binding_id
       FROM commercial_acceptance_bindings binding
       JOIN customer_portal_acceptance_intents acceptance
         ON acceptance.tenant_id = binding.tenant_id
        AND acceptance.acceptance_id = binding.acceptance_id
       JOIN commercial_quote_revisions quote
         ON quote.tenant_id = binding.tenant_id
        AND quote.quote_revision_id = binding.quote_revision_id
       JOIN commercial_proposal_revisions proposal
         ON proposal.tenant_id = binding.tenant_id
        AND proposal.proposal_revision_id = binding.proposal_revision_id
       LEFT JOIN commercial_authority_permits permit
         ON permit.tenant_id = quote.tenant_id AND permit.permit_id = quote.policy_permit_id
       LEFT JOIN quote_revision_approval_requests approval
         ON approval.tenant_id = quote.tenant_id
        AND approval.quote_revision_approval_id = quote.quote_revision_approval_id
       LEFT JOIN commercial_proposal_publication_events publication
         ON publication.tenant_id = proposal.tenant_id
        AND publication.proposal_pack_id = proposal.proposal_pack_id
        AND publication.proposal_revision_id = proposal.proposal_revision_id
        AND publication.state = 'published'
        AND publication.publication_version = (
          SELECT MAX(current.publication_version)
            FROM commercial_proposal_publication_events current
           WHERE current.tenant_id = proposal.tenant_id
             AND current.proposal_pack_id = proposal.proposal_pack_id
             AND current.occurred_at <= binding.accepted_at
        )
       LEFT JOIN operating_production_gates gate
         ON gate.tenant_id = binding.tenant_id
        AND gate.roof_job_id = binding.roof_job_id
        AND gate.gate = 'Deposit'
       LEFT JOIN production_gate_clearances in_force
         ON in_force.tenant_id = gate.tenant_id
        AND in_force.clearance_id = gate.clearance_decision_id
      WHERE binding.tenant_id = ? AND binding.acceptance_binding_id = ?
      LIMIT 1`,
  ).bind(tenantId, bindingId).first<ContractFacts>();
}

/** The facts a policy entry's evidence copies: the contract version, identifiers only. */
export type DepositGateEvidenceFacts = Pick<
  ContractFacts,
  | "acceptance_binding_id" | "acceptance_id" | "receipt_hash" | "accepted_at"
  | "quote_revision_id" | "customer_quote_id" | "quote_revision_number" | "terms_hash"
  | "terms_json" | "policy_permit_id" | "permit_actor_type" | "permit_actor_id"
  | "quote_revision_approval_id" | "approval_approved_by_user_id" | "proposal_revision_id"
  | "publication_event_id" | "quote_evidence_digest" | "proposal_evidence_digest"
  | "publication_evidence_digest" | "in_force_binding_id"
>;

/**
 * A policy entry's evidence: the contract version the entry stands on. D1 bounds the ledger's
 * `evidence_refs_json` at 4000 characters (0153). Every field is an identifier, digest, number or
 * timestamp under its own D1 bound, so the whole fits; deposit-policy.test.ts pins the margin.
 */
export function depositGateEvidence(
  facts: DepositGateEvidenceFacts,
  entry: { basis: "contract_no_deposit" | "contract_superseded"; reverses_id: string | null },
  tenantPolicy: Pick<TenantDepositPolicyState, "policy" | "version"> | null,
): string {
  const parsed = JSON.parse(facts.terms_json) as Record<string, unknown>;
  return canonicalJson({
    basis: entry.basis,
    policy_version: DEPOSIT_GATE_POLICY_VERSION,
    tenant_policy: tenantPolicy
      ? { policy: tenantPolicy.policy, version: tenantPolicy.version }
      : null,
    reverses: entry.reverses_id
      ? { clearance_id: entry.reverses_id, acceptance_binding_id: facts.in_force_binding_id }
      : null,
    contract: {
      acceptance_binding_id: facts.acceptance_binding_id,
      acceptance_id: facts.acceptance_id,
      receipt_hash: facts.receipt_hash,
      accepted_at: facts.accepted_at,
      quote_revision_id: facts.quote_revision_id,
      customer_quote_id: facts.customer_quote_id,
      quote_revision_number: Number(facts.quote_revision_number),
      terms_hash: facts.terms_hash,
      // The whole terms are bound by `terms_hash`; only the bounded deposit is copied here.
      deposit_percent: parsed.deposit_percent ?? null,
      quote_approval: quoteApproval(facts),
      proposal_revision_id: facts.proposal_revision_id,
      publication_event_id: facts.publication_event_id,
      quote_evidence_digest: facts.quote_evidence_digest,
      proposal_evidence_digest: facts.proposal_evidence_digest,
      publication_evidence_digest: facts.publication_evidence_digest,
    },
  });
}

/** Who approved the quote revision this contract was made of. */
function quoteApproval(facts: DepositGateEvidenceFacts): Record<string, string | null> {
  return facts.quote_revision_approval_id
    ? {
      kind: "approval_request",
      id: facts.quote_revision_approval_id,
      approved_by_user_id: facts.approval_approved_by_user_id,
    }
    : {
      kind: "policy_permit",
      id: facts.policy_permit_id,
      actor_type: facts.permit_actor_type,
      actor_id: facts.permit_actor_id,
    };
}

/**
 * Append the Deposit entry a signed contract calls for, by policy and never by a person:
 *   * a contract with no deposit, under OD-01, on a blocked gate: `clear` / `contract_no_deposit`;
 *   * a later contract that carries a deposit, while Deposit stands on `contract_no_deposit`:
 *     `reverse` / `contract_superseded`, so Deposit is blocked until that contract's own deposit
 *     invoice is reconciled or the owner waives it.
 * Anything else needs no entry. The key is the binding, so a retry or the sweep never appends a
 * second entry. D1 re-checks every fact in the same insert, which also writes the audit row.
 */
export async function recordContractDepositGate(
  env: AppEnv,
  input: { tenantId: string; acceptanceBindingId: string },
): Promise<ContractDepositGateOutcome> {
  const facts = await contractFacts(env, input.tenantId, input.acceptanceBindingId);
  if (!facts) return { outcome: "not_applicable", reason: "contract_missing" };
  if (!facts.gate_id || facts.gate_version === null) {
    return { outcome: "not_applicable", reason: "deposit_gate_missing" };
  }
  if (Number(facts.superseded) === 1) {
    return { outcome: "not_applicable", reason: "contract_superseded_by_later_contract" };
  }
  if (facts.acceptance_state !== "accepted" || facts.quote_terms_hash !== facts.terms_hash) {
    return { outcome: "not_applicable", reason: "contract_terms_not_bound" };
  }
  const terms = contractDepositTerms(facts.terms_json);
  let entry: {
    entry_kind: "clear" | "reverse";
    basis: "contract_no_deposit" | "contract_superseded";
    to_state: "complete" | "blocked";
    reverses_id: string | null;
  };
  let tenantPolicy: TenantDepositPolicyState | null = null;
  if (terms === "no_deposit") {
    if (facts.gate_state !== "blocked") {
      return { outcome: "not_applicable", reason: "deposit_gate_not_blocked" };
    }
    tenantPolicy = await readTenantDepositPolicy(env, input.tenantId);
    if (tenantPolicy.policy !== "od01_payment_on_completion") {
      return { outcome: "not_applicable", reason: "tenant_policy_requires_deposit" };
    }
    entry = { entry_kind: "clear", basis: "contract_no_deposit", to_state: "complete", reverses_id: null };
  } else if (terms === "deposit") {
    if (
      facts.gate_state !== "complete" ||
      facts.in_force_basis !== "contract_no_deposit" ||
      !facts.in_force_clearance_id ||
      facts.in_force_binding_id === facts.acceptance_binding_id
    ) {
      return { outcome: "not_applicable", reason: "deposit_contract" };
    }
    entry = {
      entry_kind: "reverse",
      basis: "contract_superseded",
      to_state: "blocked",
      reverses_id: facts.in_force_clearance_id,
    };
  } else {
    return { outcome: "not_applicable", reason: "contract_terms_invalid" };
  }

  // The key is made of the binding. "/" is outside the alphabet a person's Idempotency-Key may
  // use, so no person entry can take this key ahead of the policy.
  const keyHash = await sha256Hex(
    `policy/${DEPOSIT_GATE_POLICY_VERSION}/${entry.basis}/${facts.acceptance_binding_id}`,
  );
  const clearanceId = `pgc_${(await sha256Hex(`${input.tenantId}:${keyHash}`)).slice(0, 40)}`;
  const recorded = async (): Promise<boolean> =>
    !!(await env.DB.prepare(
      `SELECT 1 AS found FROM production_gate_clearances
        WHERE tenant_id = ? AND idempotency_key_hash = ? AND actor_kind = 'policy'
          AND basis = ? AND contract_binding_id = ?`,
    ).bind(input.tenantId, keyHash, entry.basis, facts.acceptance_binding_id).first());
  if (await recorded()) {
    return { outcome: "already_recorded", basis: entry.basis, clearance_id: clearanceId };
  }
  const evidence = depositGateEvidence(facts, entry, tenantPolicy);
  const requestSha256 = await sha256Hex(canonicalJson({
    route: "deposit_gate_policy",
    tenant_id: input.tenantId,
    gate_id: facts.gate_id,
    entry_kind: entry.entry_kind,
    basis: entry.basis,
    contract_binding_id: facts.acceptance_binding_id,
    terms_hash: facts.terms_hash,
    reverses_id: entry.reverses_id,
    evidence,
  }));
  try {
    await env.DB.prepare(
      `INSERT INTO production_gate_clearances (
         clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
         from_gate_version, reverses_id, actor_kind, policy_version, contract_binding_id,
         terms_hash, evidence_refs_json, request_sha256, idempotency_key_hash, created_at
       ) VALUES (?, ?, ?, ?, 'Deposit', ?, ?, ?, ?, ?, 'policy', ?, ?, ?, ?, ?, ?, ${D1_NOW})`,
    ).bind(
      clearanceId,
      input.tenantId,
      facts.gate_id,
      facts.roof_job_id,
      entry.entry_kind,
      entry.basis,
      entry.to_state,
      Number(facts.gate_version),
      entry.reverses_id,
      DEPOSIT_GATE_POLICY_VERSION,
      facts.acceptance_binding_id,
      facts.terms_hash,
      evidence,
      requestSha256,
      keyHash,
    ).run();
  } catch (error) {
    if (await recorded()) {
      return { outcome: "already_recorded", basis: entry.basis, clearance_id: clearanceId };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "refused",
      reason: LEDGER_CODES.find((code) => message.includes(code)) ?? "deposit_gate_append_failed",
    };
  }
  return { outcome: "recorded", basis: entry.basis, clearance_id: clearanceId };
}

/**
 * The five-minute sweep: each job's latest accepted contract whose Deposit entry is missing, in
 * acceptance order. It selects exactly the contracts `recordContractDepositGate` appends for, so a
 * deposit contract that needs no entry is never retried.
 */
export async function sweepContractDepositGates(
  env: AppEnv,
): Promise<{ candidates: number; recorded: number; refused: number }> {
  const tenantId = configuredTenantId(env);
  if (!tenantId) return { candidates: 0, recorded: 0, refused: 0 };
  // ponytail: one bounded scan of the tenant's contracts per tick. Move it onto a cursor, as the
  // deposit-derivation sweep has, once a tenant holds tens of thousands of accepted contracts.
  const candidates = await env.DB.prepare(
    `SELECT binding.acceptance_binding_id
       FROM commercial_acceptance_bindings binding
       JOIN commercial_quote_revisions quote
         ON quote.tenant_id = binding.tenant_id
        AND quote.quote_revision_id = binding.quote_revision_id
       JOIN operating_production_gates gate
         ON gate.tenant_id = binding.tenant_id
        AND gate.roof_job_id = binding.roof_job_id
        AND gate.gate = 'Deposit'
       LEFT JOIN production_gate_clearances in_force
         ON in_force.tenant_id = gate.tenant_id
        AND in_force.clearance_id = gate.clearance_decision_id
      WHERE binding.tenant_id = ?
        AND NOT ${LATER_BINDING}
        AND NOT EXISTS (
          SELECT 1 FROM production_gate_clearances entry
           WHERE entry.tenant_id = binding.tenant_id
             AND entry.gate_id = gate.gate_id
             AND entry.contract_binding_id = binding.acceptance_binding_id
        )
        AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
        AND (
          (gate.state = 'blocked'
            AND json_extract(quote.terms_json, '$.deposit_percent') = 0
            AND json_type(quote.terms_json, '$.payment_schedule') = 'array'
            AND json_array_length(quote.terms_json, '$.payment_schedule') = 1
            AND json_extract(quote.terms_json, '$.payment_schedule[0]') = 'completion'
            AND COALESCE((
              SELECT revision.policy FROM tenant_deposit_policy_revisions revision
               WHERE revision.tenant_id = binding.tenant_id
               ORDER BY revision.revision DESC LIMIT 1
            ), 'od01_payment_on_completion') = 'od01_payment_on_completion')
          OR (gate.state = 'complete'
            AND in_force.basis = 'contract_no_deposit'
            AND in_force.contract_binding_id != binding.acceptance_binding_id
            AND json_extract(quote.terms_json, '$.deposit_percent') BETWEEN 1 AND 100)
        )
      ORDER BY binding.accepted_at, binding.acceptance_binding_id
      LIMIT ${SWEEP_LIMIT}`,
  ).bind(tenantId).all<{ acceptance_binding_id: string }>();
  let recorded = 0;
  let refused = 0;
  // One at a time: two contracts never race for the same gate version.
  for (const row of candidates.results ?? []) {
    const result = await recordContractDepositGate(
      env,
      { tenantId, acceptanceBindingId: row.acceptance_binding_id },
    ).catch(() => ({ outcome: "refused" as const, reason: "deposit_gate_append_failed" }));
    if (result.outcome === "recorded") recorded += 1;
    else if (result.outcome === "refused") refused += 1;
  }
  return { candidates: (candidates.results ?? []).length, recorded, refused };
}
