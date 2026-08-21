import { z } from "zod";

const nullableText = z.string().min(1).nullable();
const nullableNumber = z.number().finite().nullable();

const salesEnvelopeSchema = z
  .object({
    version: z.literal(1),
    source_updated_at: nullableText,
    read_model_generated_at: z.string().min(1),
    stale_fields: z.array(z.string()),
    permissions: z.array(z.string()),
    allowed_actions: z.array(z.string()),
  })
  .strict();

const salesAttentionSchema = z.enum([
  "source_partial",
  "triage_unresolved",
  "estimate_needs_review",
  "quote_needs_review",
  "quote_expired",
]);

const salesPartialFieldSchema = z.enum([
  "job",
  "triage_decision",
  "estimate",
  "quote",
  "proposal",
  "proposal_publication",
  "quote_acceptance",
  "proposal_acceptance",
]);

const consentRecordSchema = z
  .object({
    id: z.string().min(1),
    channel: nullableText,
    purpose: nullableText,
    status: nullableText,
    jurisdiction: nullableText,
    basis: nullableText,
    captured_at: nullableText,
    effective_from: nullableText,
    expires_at: nullableText,
    revoked_at: nullableText,
  })
  .strict();

const salesLeadSchema = z
  .object({
    id: z.string().min(1),
    envelope_id: z.string().min(1),
    source: nullableText,
    received_at: nullableText,
    transport_status: nullableText,
    intent_queue: nullableText,
    contact: z
      .object({
        display_name: nullableText,
        phone: nullableText,
        email: nullableText,
      })
      .strict(),
    triage: z
      .object({
        status: nullableText,
        summary: nullableText,
        version: z.number().int().positive(),
      })
      .strict(),
    job: z
      .object({
        id: z.string().min(1),
        job_number: nullableText,
        status: nullableText,
        service_type: nullableText,
        workflow_profile: nullableText,
      })
      .strict()
      .nullable(),
    estimate: z
      .object({
        id: z.string().min(1),
        status: nullableText,
        service_type: nullableText,
        range_low: nullableNumber,
        range_high: nullableNumber,
        estimate_total: nullableNumber,
        confidence: nullableText,
        review_required: z.boolean(),
        reviewed_at: nullableText,
        approved_at: nullableText,
        assumptions: nullableText,
        exclusions: nullableText,
      })
      .strict()
      .nullable(),
    quote: z
      .object({
        id: z.string().min(1),
        version: z.number().int().nonnegative().nullable(),
        status: nullableText,
        quote_total: nullableNumber,
        currency: nullableText,
        valid_until: nullableText,
        payment_status: nullableText,
        prepared_at: nullableText,
        approved_at: nullableText,
        accepted_at: nullableText,
        scope_summary: nullableText,
      })
      .strict()
      .nullable(),
    proposal: z
      .object({
        id: z.string().min(1),
        status: nullableText,
        prepared_at: nullableText,
        approved_at: nullableText,
        signed_at: nullableText,
        has_published_pack: z.boolean().nullable(),
        published_status: nullableText,
      })
      .strict()
      .nullable(),
    consent: z
      .object({
        context: z.enum(["recorded", "no_linked_record", "partial"]),
        records: z.array(consentRecordSchema),
      })
      .strict(),
    partial_fields: z.array(salesPartialFieldSchema),
    attention: z.array(salesAttentionSchema),
  })
  .strict();

export const salesResponseSchema = salesEnvelopeSchema
  .extend({
    partial_sources: z.array(z.string()),
    summary: z
      .object({
        listed_leads: z.number().int().nonnegative(),
        triage_unresolved: z.number().int().nonnegative(),
        estimate_needs_review: z.number().int().nonnegative(),
        quote_needs_review: z.number().int().nonnegative(),
        quote_expired: z.number().int().nonnegative(),
        no_linked_consent_record: z.number().int().nonnegative(),
      })
      .strict(),
    leads: z.array(salesLeadSchema),
  })
  .strict();

export type SalesLead = z.infer<typeof salesLeadSchema>;
export type SalesResponse = z.infer<typeof salesResponseSchema>;

export const commercialLeadTriageDecisionResponseSchema = z
  .object({
    decision: z
      .object({
        triage_decision_id: z.string().min(1),
        lead_id: z.string().min(1),
        lead_version: z.number().int().positive(),
        lifecycle_status: z.enum(["triaged", "qualified", "disqualified"]),
        priority: z.enum(["low", "normal", "high", "urgent"]),
        category: z.string().min(2),
        summary: z.string().min(1),
        next_action: z.string().min(1),
        decided_at: z.string().min(1),
      })
      .strict(),
    replayed: z.boolean(),
    permit: z
      .object({
        permit_id: z.string().min(1),
        replayed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export interface CommercialLeadTriageInput {
  leadId: string;
  expectedLeadVersion: number;
  lifecycleStatus: "triaged" | "qualified" | "disqualified";
  priority: "low" | "normal" | "high" | "urgent";
  category: string;
  summary: string;
  nextAction: string;
}

export type CommercialLeadTriageDecisionResponse = z.infer<
  typeof commercialLeadTriageDecisionResponseSchema
>;
