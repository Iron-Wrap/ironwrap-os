import type { AppEnv } from "./app-types.ts";
import {
  readCommercialJobPhase,
  type CommercialJobPhaseReadModel,
} from "./commercial-job-phase.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

/**
 * What a person or an agent needs to know about one job before writing to its customer.
 *
 * Everything commercial here comes from `readCommercialJobPhase`, the one job-keyed reader that
 * already resolves quote -> proposal -> publication -> acceptance with ambiguity and terms checks.
 * The store's `getCurrentCommercial*` helpers are deliberately not used: they are keyed by quote or
 * pack rather than job, accept any status, and read "none" and "ambiguous" as the same `null`.
 *
 * The one thing added is the contact and the consent for it, and the source binding: the exact set
 * of facts a follow-up is written against. A decision about a draft records that binding's digest,
 * and anything that moves it — a triage, a contact change, a new quote revision, a withdrawn
 * proposal, a consent row — makes the decision stale rather than quietly still valid.
 *
 * Read-only. It creates no fact, no permit and no communication.
 */

export const COMMERCIAL_CONTEXT_SCHEMA = "ironwrap_commercial_context_v1";
export const COMMERCIAL_SOURCE_BINDING_SCHEMA =
  "ironwrap_commercial_source_binding_v1";

/** The chain position of the job's offer. One state, because each step depends on the one before. */
export type CommercialOfferState =
  | "no_quote"
  | "quote_not_approved"
  | "quote_ambiguous"
  | "proposal_missing"
  | "proposal_terms_mismatch"
  | "proposal_ambiguous"
  | "not_published"
  | "withdrawn"
  | "publication_ambiguous"
  | "published"
  | "accepted"
  | "acceptance_ambiguous"
  | "withdrawn_after_acceptance";

/** Nothing in the records stops a follow-up when this list is empty. Closed vocabulary. */
export type FollowUpBlocker =
  | "job_cancelled"
  | "recipient_email_missing"
  | "consent_missing"
  | "consent_not_granted"
  /** The consent row belongs to the lead's address, and the recipient is a different one. */
  | "consent_recipient_mismatch"
  | "lead_disqualified"
  | "customer_archived"
  /** The offer records do not settle into one reading: an ambiguity, or an acceptance under a
   * publication that was later withdrawn. */
  | "commercial_facts_ambiguous";

/**
 * Limits of what a recorded consent row can prove, stated rather than implied. Each is a fact about
 * the current `operating_consents` schema and its only writer, not about this customer.
 */
export const CONSENT_LIMITS = [
  "no_revocation_recorded",
  "no_expiry",
  "not_bound_to_address",
  "estimate_follow_up_only",
] as const;

export interface CommercialSourceBinding {
  schema: typeof COMMERCIAL_SOURCE_BINDING_SCHEMA;
  tenant_id: string;
  roof_job_id: string;
  job_version: number;
  lead_id: string;
  lead_version: number;
  customer_id: string;
  /**
   * Not `customer.version`: that moves whenever any of the customer's jobs is accepted, which would
   * invalidate a follow-up on this job for a change on another. The address is bound separately and
   * is immutable on the customer row; what else about the customer can stop a follow-up is this.
   */
  customer_archived: boolean;
  /** The chain position, so "no quote" and "two quotes" are not the same null. */
  offer_state: CommercialOfferState;
  /** Time moves this, not a write: a follow-up approved before the quote lapsed is not still valid. */
  quote_expired: boolean;
  quote: {
    quote_revision_id: string;
    revision_number: number;
    status: string;
    terms_hash: string;
  } | null;
  proposal: { proposal_revision_id: string; revision_number: number } | null;
  publication: {
    publication_event_id: string;
    publication_version: number;
    state: string;
  } | null;
  acceptance: { acceptance_id: string } | null;
  consent: { consent_id: string; status: string } | null;
  recipient_sha256: string | null;
}

/** The components a stale refusal can name. */
export type SourceBindingComponent =
  | "job"
  | "lead"
  | "customer"
  | "offer"
  | "quote"
  | "proposal"
  | "publication"
  | "acceptance"
  | "consent"
  | "recipient";

export interface CommercialContextReadModel {
  schema: typeof COMMERCIAL_CONTEXT_SCHEMA;
  generated_at: string;
  job: {
    roof_job_id: string;
    job_number: string | null;
    status: string;
    version: number;
    customer_display_name: string | null;
  };
  offer: {
    state: CommercialOfferState;
    quote_head: CommercialSourceBinding["quote"];
    quote: {
      quote_revision_id: string;
      revision_number: number;
      status: string;
      currency: string;
      total_cents: number;
      /** A calendar date, `YYYY-MM-DD`. */
      valid_until: string;
      terms_hash: string;
    } | null;
    proposal: { proposal_revision_id: string; revision_number: number } | null;
    publication: {
      publication_event_id: string;
      publication_version: number;
      state: string;
      occurred_at: string;
    } | null;
    acceptance: { acceptance_id: string; accepted_at: string } | null;
    /** An exact acceptance whose publication was withdrawn afterwards. Never a current acceptance. */
    withdrawn_acceptance: { acceptance_id: string; accepted_at: string } | null;
    /**
     * An approved quote whose `valid_until` date is before today's UTC date — the same comparison
     * customer acceptance enforces (`customer-contract-acceptance.ts`), so this agrees with what a
     * customer would actually be refused. Reported, not hidden in the state.
     */
    expired: boolean;
  };
  contact: {
    email: { address: string; source: "customer" | "lead" } | null;
    consent: {
      consent_id: string;
      channel: string;
      purpose: string;
      status: string;
      basis: string;
      recorded_at: string;
    } | null;
    consent_limits: typeof CONSENT_LIMITS;
  };
  follow_up: { blockers: FollowUpBlocker[] };
  source_binding: CommercialSourceBinding;
  source_binding_sha256: string;
  /** Passed through from the phase reader, so a caller sees what it could not settle. */
  stale_reasons: string[];
}

export interface CommercialContactRow {
  job_number: string | null;
  customer_display_name: string | null;
  customer_email: string | null;
  lead_email: string | null;
  consent_id: string | null;
  consent_channel: string | null;
  consent_purpose: string | null;
  consent_status: string | null;
  consent_basis: string | null;
  consent_recorded_at: string | null;
}

/**
 * Returns `null` when the job does not exist in this tenant; the route answers that as 404, the
 * same answer a job in another tenant gets.
 */
export async function readCommercialContext(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
  now: Date = new Date(),
): Promise<CommercialContextReadModel | null> {
  const phase = await readCommercialJobPhase(env, tenantId, roofJobId);
  if (!phase) return null;
  // `operating_consents` is UNIQUE (tenant_id, lead_id, channel, purpose), so the join yields at
  // most one consent row for this job's lead.
  const contact = await env.DB.prepare(
    `SELECT job.job_number,
            customer.display_name AS customer_display_name,
            customer.contact_email AS customer_email,
            lead.contact_email AS lead_email,
            consent.consent_id, consent.channel AS consent_channel,
            consent.purpose AS consent_purpose, consent.status AS consent_status,
            consent.consent_basis AS consent_basis, consent.recorded_at AS consent_recorded_at
       FROM operating_roof_jobs job
       JOIN operating_customers customer
         ON customer.tenant_id = job.tenant_id AND customer.customer_id = job.customer_id
       JOIN operating_leads lead
         ON lead.tenant_id = job.tenant_id AND lead.lead_id = job.lead_id
       LEFT JOIN operating_consents consent
         ON consent.tenant_id = job.tenant_id
        AND consent.lead_id = job.lead_id
        AND consent.channel = 'email'
        AND consent.purpose = 'estimate_follow_up'
      WHERE job.tenant_id = ? AND job.roof_job_id = ?
      LIMIT 1`,
  )
    .bind(tenantId, roofJobId)
    .first<CommercialContactRow>();
  if (!contact) return null;
  return commercialContextFrom(tenantId, phase, contact, now);
}

export async function commercialContextFrom(
  tenantId: string,
  phase: CommercialJobPhaseReadModel,
  contact: CommercialContactRow,
  now: Date,
): Promise<CommercialContextReadModel> {
  const commercial = phase.facts.commercial;
  const quote = quoteFact(commercial.quote);
  const proposal = proposalFact(commercial.proposal);
  const publication = publicationFact(commercial.publication);
  const acceptance = acceptanceFact(commercial.acceptance);
  const withdrawnAcceptance = acceptanceFact(
    commercial.acceptance_under_withdrawn_publication,
  );
  const expired =
    quote !== null && quote.valid_until < now.toISOString().slice(0, 10);
  const state = offerState(
    commercial.quote_head,
    quote,
    proposal,
    publication,
    acceptance,
    phase.stale_reasons,
  );

  // The customer record is the authority once a lead has converted; the lead's address is only a
  // fallback, and the response says which one it is.
  const customerEmail = normalizedAddress(contact.customer_email);
  const leadEmail = normalizedAddress(contact.lead_email);
  const email = customerEmail
    ? { address: customerEmail, source: "customer" as const }
    : leadEmail
      ? { address: leadEmail, source: "lead" as const }
      : null;
  const consent = contact.consent_id
    ? {
        consent_id: contact.consent_id,
        channel: contact.consent_channel ?? "email",
        purpose: contact.consent_purpose ?? "estimate_follow_up",
        status: contact.consent_status ?? "unknown",
        basis: contact.consent_basis ?? "unknown",
        recorded_at: contact.consent_recorded_at ?? "",
      }
    : null;

  const blockers: FollowUpBlocker[] = [];
  if (phase.phase === "cancelled" || phase.job.status === "cancelled")
    blockers.push("job_cancelled");
  if (commercial.lead_status === "disqualified")
    blockers.push("lead_disqualified");
  if (commercial.customer_status === "archived")
    blockers.push("customer_archived");
  if (!email) blockers.push("recipient_email_missing");
  if (!consent) blockers.push("consent_missing");
  else if (consent.status !== "granted") blockers.push("consent_not_granted");
  // The only consent writer records it for the lead's own address. Sending anywhere else — the
  // customer record can hold an older address after a phone-matched intake — is not covered by it.
  if (
    consent &&
    email &&
    (!leadEmail || email.address.toLowerCase() !== leadEmail.toLowerCase())
  )
    blockers.push("consent_recipient_mismatch");
  if (UNSETTLED_OFFER_STATES.has(state))
    blockers.push("commercial_facts_ambiguous");

  const binding: CommercialSourceBinding = {
    schema: COMMERCIAL_SOURCE_BINDING_SCHEMA,
    tenant_id: tenantId,
    roof_job_id: phase.job.roof_job_id,
    job_version: phase.job.version,
    lead_id: phase.job.lead_id,
    lead_version: commercial.lead_version,
    customer_id: phase.job.customer_id,
    customer_archived: commercial.customer_status === "archived",
    offer_state: state,
    quote_expired: expired,
    quote: commercial.quote_head,
    proposal: proposal
      ? {
          proposal_revision_id: proposal.proposal_revision_id,
          revision_number: proposal.revision_number,
        }
      : null,
    publication: publication
      ? {
          publication_event_id: publication.publication_event_id,
          publication_version: publication.publication_version,
          state: publication.state,
        }
      : null,
    acceptance: acceptance ? { acceptance_id: acceptance.acceptance_id } : null,
    consent: consent
      ? { consent_id: consent.consent_id, status: consent.status }
      : null,
    recipient_sha256: email
      ? await sha256Hex(email.address.toLowerCase())
      : null,
  };

  return {
    schema: COMMERCIAL_CONTEXT_SCHEMA,
    generated_at: now.toISOString(),
    job: {
      roof_job_id: phase.job.roof_job_id,
      job_number: contact.job_number,
      status: phase.job.status,
      version: phase.job.version,
      customer_display_name: contact.customer_display_name,
    },
    offer: {
      state,
      quote_head: commercial.quote_head,
      quote,
      proposal,
      publication,
      acceptance,
      withdrawn_acceptance: withdrawnAcceptance,
      expired,
    },
    contact: { email, consent, consent_limits: CONSENT_LIMITS },
    follow_up: { blockers },
    source_binding: binding,
    source_binding_sha256: await commercialSourceBindingDigest(binding),
    // Only the offer chain's own reasons. The phase reader also reports production gates, closeout,
    // accounting and safety, which this route's readers (sales) are refused everywhere else.
    stale_reasons: phase.stale_reasons.filter((reason) =>
      OFFER_STALE_REASON.test(reason),
    ),
  };
}

export function commercialSourceBindingDigest(
  binding: CommercialSourceBinding,
): Promise<string> {
  return sha256Hex(canonicalJson(binding));
}

/**
 * Which components differ. Any difference invalidates a decision made against `before`; the list
 * exists so a refusal can say what moved instead of only that something did.
 */
export function sourceBindingChanges(
  before: CommercialSourceBinding,
  after: CommercialSourceBinding,
): SourceBindingComponent[] {
  const changed: SourceBindingComponent[] = [];
  const differs = (left: unknown, right: unknown) =>
    canonicalJson(left) !== canonicalJson(right);
  if (
    before.tenant_id !== after.tenant_id ||
    before.roof_job_id !== after.roof_job_id ||
    before.job_version !== after.job_version ||
    before.schema !== after.schema
  )
    changed.push("job");
  if (
    before.lead_id !== after.lead_id ||
    before.lead_version !== after.lead_version
  )
    changed.push("lead");
  if (
    before.customer_id !== after.customer_id ||
    before.customer_archived !== after.customer_archived
  )
    changed.push("customer");
  if (
    before.offer_state !== after.offer_state ||
    before.quote_expired !== after.quote_expired
  )
    changed.push("offer");
  if (differs(before.quote, after.quote)) changed.push("quote");
  if (differs(before.proposal, after.proposal)) changed.push("proposal");
  if (differs(before.publication, after.publication))
    changed.push("publication");
  if (differs(before.acceptance, after.acceptance)) changed.push("acceptance");
  if (differs(before.consent, after.consent)) changed.push("consent");
  if (before.recipient_sha256 !== after.recipient_sha256)
    changed.push("recipient");
  return changed;
}

const UNSETTLED_OFFER_STATES: ReadonlySet<CommercialOfferState> = new Set([
  "quote_ambiguous",
  "proposal_ambiguous",
  "publication_ambiguous",
  "acceptance_ambiguous",
  "withdrawn_after_acceptance",
]);

const OFFER_STALE_REASON =
  /^commercial\.(quote_|proposal_|publication_|customer_acceptance_)/;

function offerState(
  quoteHead: CommercialSourceBinding["quote"],
  quote: CommercialContextReadModel["offer"]["quote"],
  proposal: CommercialContextReadModel["offer"]["proposal"],
  publication: CommercialContextReadModel["offer"]["publication"],
  acceptance: CommercialContextReadModel["offer"]["acceptance"],
  staleReasons: readonly string[],
): CommercialOfferState {
  const stale = new Set(staleReasons);
  if (stale.has("commercial.quote_head_ambiguous")) return "quote_ambiguous";
  if (!quoteHead) return "no_quote";
  // The phase reader admits only an approved head as `quote`.
  if (!quote) return "quote_not_approved";
  if (stale.has("commercial.proposal_head_ambiguous"))
    return "proposal_ambiguous";
  if (stale.has("commercial.proposal_terms_mismatch"))
    return "proposal_terms_mismatch";
  if (!proposal) return "proposal_missing";
  if (stale.has("commercial.publication_head_ambiguous"))
    return "publication_ambiguous";
  if (!publication) return "not_published";
  if (publication.state !== "published") {
    return stale.has("commercial.customer_acceptance_publication_withdrawn")
      ? "withdrawn_after_acceptance"
      : "withdrawn";
  }
  if (stale.has("commercial.customer_acceptance_ambiguous"))
    return "acceptance_ambiguous";
  return acceptance ? "accepted" : "published";
}

function normalizedAddress(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function quoteFact(
  value: Record<string, unknown> | null,
): CommercialContextReadModel["offer"]["quote"] {
  if (!value) return null;
  return {
    quote_revision_id: String(value.quote_revision_id),
    revision_number: Number(value.revision_number),
    status: String(value.status),
    currency: String(value.currency),
    total_cents: Number(value.total_cents),
    valid_until: String(value.valid_until),
    terms_hash: String(value.terms_hash),
  };
}

function proposalFact(
  value: Record<string, unknown> | null,
): CommercialContextReadModel["offer"]["proposal"] {
  if (!value) return null;
  return {
    proposal_revision_id: String(value.proposal_revision_id),
    revision_number: Number(value.revision_number),
  };
}

function publicationFact(
  value: Record<string, unknown> | null,
): CommercialContextReadModel["offer"]["publication"] {
  if (!value) return null;
  return {
    publication_event_id: String(value.publication_event_id),
    publication_version: Number(value.publication_version),
    state: String(value.state),
    occurred_at: String(value.occurred_at),
  };
}

function acceptanceFact(
  value: Record<string, unknown> | null,
): CommercialContextReadModel["offer"]["acceptance"] {
  if (!value) return null;
  return {
    acceptance_id: String(value.acceptance_id),
    accepted_at: String(value.accepted_at),
  };
}
