import { describe, expect, it } from "vitest";

import {
  officeLeadReceiptResponseSchema,
  officeLeadReadbackSchema,
  salesLeadDetailResponseSchema,
  salesResponseSchema,
} from "./sales-contracts";

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
        triage: {
          status: "Untriaged",
          summary: "Confirm the inspection window.",
          version: 1,
        },
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
        partial_fields: [],
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

describe("office intake contracts", () => {
  const details = {
    name: "Morgan Example",
    email: "morgan@example.invalid",
    phone: null,
    address: null,
    city: null,
    province: null,
    postal_code: null,
    service: "Custom trim",
    message: null,
    source: "referral",
    intake_source: "referral",
    preferred_contact_channel: null,
    email_consent: {
      status: "not_recorded",
      purpose: "estimate_follow_up",
      recorded_at: null,
      captured_by: null,
      jurisdiction: null,
      wording_version: null,
    },
  };
  const receipt = {
    request_id: "office-lead:11111111-1111-4111-8111-111111111111",
    state: "recorded",
    outcome: "created",
    canonical_envelope_id: "ow_original",
    lead_id: null,
    submitted_details_applied: true,
    captured_at: "2026-09-30T12:00:00.000Z",
    details,
  };
  it("keeps no preference and unrecorded consent distinct from permission to contact", () => {
    expect(officeLeadReadbackSchema.parse(details).preferred_contact_channel).toBeNull();
    expect(
      officeLeadReadbackSchema.safeParse({
        ...details,
        email_consent: { ...details.email_consent, purpose: "marketing" },
      }).success,
    ).toBe(false);
    expect(
      officeLeadReadbackSchema.safeParse({ ...details, raw_payload: "unexpected" }).success,
    ).toBe(false);
  });
  it("rejects fabricated results, unsafe lead IDs and processing details", () => {
    expect(officeLeadReceiptResponseSchema.safeParse({ version: 1, receipt }).success).toBe(true);
    for (const change of [
      { outcome: "duplicate" },
      { details: null },
      { canonical_envelope_id: null },
      { state: "processing" },
      { lead_id: ".." },
      { request_id: "../other" },
    ]) {
      expect(
        officeLeadReceiptResponseSchema.safeParse({
          version: 1,
          receipt: { ...receipt, ...change },
        }).success,
      ).toBe(false);
    }
    expect(
      officeLeadReceiptResponseSchema.safeParse({
        version: 1,
        receipt: { ...receipt, outcome: "duplicate", submitted_details_applied: false },
      }).success,
    ).toBe(true);
  });
  it("validates exact native lead detail without changing the legacy desk shape", () => {
    const desk = salesPayload();
    const detail = {
      version: 1,
      read_model_generated_at: desk.read_model_generated_at,
      permissions: desk.permissions,
      allowed_actions: desk.allowed_actions,
      stale_fields: [],
      partial_sources: [],
      lead: { ...desk.leads[0], id: `lead:ironwrap:${"a".repeat(64)}` },
      intake: details,
    };
    expect(salesLeadDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(salesLeadDetailResponseSchema.safeParse({ ...detail, rows: [] }).success).toBe(false);
    expect(salesResponseSchema.safeParse(desk).success).toBe(true);
  });
});
