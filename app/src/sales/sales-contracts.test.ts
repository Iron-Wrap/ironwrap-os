import { describe, expect, it } from "vitest";

import { salesResponseSchema } from "./sales-contracts";

function salesPayload() {
  return {
    version: 1,
    source_updated_at: "2026-07-11T12:00:00.000Z",
    read_model_generated_at: "2026-07-11T12:00:01.000Z",
    stale_fields: [],
    permissions: ["sales:read"],
    allowed_actions: ["sales.read"],
    partial_sources: [],
    summary: {
      listed_leads: 1,
      triage_unresolved: 1,
      estimate_needs_review: 1,
      quote_needs_review: 1,
      quote_expired: 0,
      no_linked_consent_record: 0,
    },
    leads: [
      {
        id: "LEAD-A",
        envelope_id: "lead_a",
        source: "website",
        received_at: "2026-07-11T12:00:00.000Z",
        transport_status: "received",
        intent_queue: "Estimator",
        contact: { display_name: "Pat Prospect", phone: "+14035559999", email: "pat@example.com" },
        triage: { status: "Untriaged", summary: "Confirm the inspection window." },
        job: {
          id: "JOB-A",
          job_number: "IW-1001",
          status: "Proposal",
          service_type: "Roofing",
          workflow_profile: "Residential Retail",
        },
        estimate: {
          id: "estimate_a",
          status: "Needs Review",
          service_type: "Roofing",
          range_low: 12400,
          range_high: 15900,
          estimate_total: null,
          confidence: "Preliminary",
          review_required: true,
          reviewed_at: null,
          approved_at: null,
          assumptions: "Pitch still needs verification.",
          exclusions: "No final contract.",
        },
        quote: {
          id: "quote_a",
          version: 2,
          status: "Needs Review",
          quote_total: 14750,
          currency: "CAD",
          valid_until: "2026-07-20",
          payment_status: "Not Due",
          prepared_at: "2026-07-11T12:00:00.000Z",
          approved_at: null,
          accepted_at: null,
          scope_summary: "Replace affected roof system.",
        },
        proposal: {
          id: "pack_a",
          status: "Draft",
          prepared_at: "2026-07-11T12:00:00.000Z",
          approved_at: null,
          signed_at: null,
          has_published_pack: false,
          published_status: null,
        },
        consent: {
          context: "recorded",
          records: [
            {
              id: "consent_a",
              channel: "Email",
              purpose: "Estimate Follow-up",
              status: "Granted",
              jurisdiction: "AB",
              basis: "Express",
              captured_at: "2026-07-11T12:00:00.000Z",
              effective_from: "2026-07-11T12:00:00.000Z",
              expires_at: null,
              revoked_at: null,
            },
          ],
        },
        attention: ["triage_unresolved", "estimate_needs_review", "quote_needs_review"],
      },
    ],
  };
}

describe("Sales browser contract", () => {
  it("accepts only the bounded office review DTO", () => {
    const payload = salesPayload();
    expect(salesResponseSchema.parse(payload)).toEqual(payload);
  });

  it("fails closed if raw intake, commercial policy, or generic CRM data crosses the boundary", () => {
    const rawLead = salesPayload();
    const lead = rawLead.leads[0]!;
    expect(
      salesResponseSchema.safeParse({
        ...rawLead,
        leads: [{ ...lead, payload_json: "never-browser-visible" }],
      }).success,
    ).toBe(false);

    const rawQuote = salesPayload();
    const quoteLead = rawQuote.leads[0]!;
    expect(
      salesResponseSchema.safeParse({
        ...rawQuote,
        leads: [
          {
            ...quoteLead,
            quote: { ...quoteLead.quote, tax_policy_snapshot_json: "private" },
          },
        ],
      }).success,
    ).toBe(false);

    const rawProposal = salesPayload();
    const proposalLead = rawProposal.leads[0]!;
    expect(
      salesResponseSchema.safeParse({
        ...rawProposal,
        leads: [
          {
            ...proposalLead,
            proposal: { ...proposalLead.proposal, evidence_summary_json: "private" },
          },
        ],
      }).success,
    ).toBe(false);

    const rawConsent = salesPayload();
    const consentLead = rawConsent.leads[0]!;
    const consentRecord = consentLead.consent.records[0]!;
    expect(
      salesResponseSchema.safeParse({
        ...rawConsent,
        leads: [
          {
            ...consentLead,
            consent: {
              ...consentLead.consent,
              records: [{ ...consentRecord, source_reference: "private-form-reference" }],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
