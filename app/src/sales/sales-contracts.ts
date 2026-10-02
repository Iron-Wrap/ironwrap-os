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

/** The office "Add a lead" form. Every value is optional to type; the server decides what is enough. */
export interface NewLeadInput {
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  province: string;
  postal_code: string;
  service: string;
  message: string;
  intake_source?: "phone" | "referral" | "walk_in";
  preferred_contact_channel?: "email" | "phone" | null;
  email_estimate_follow_up_consent?: boolean;
}

export const nativeSalesLeadIdSchema = z
  .string()
  .regex(/^lead:[a-z0-9][a-z0-9-]{1,63}:[a-f0-9]{64}$/);
export const officeLeadRequestIdSchema = z
  .string()
  .regex(/^office-lead:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const officeLeadReadbackSchema = z
  .object({
    name: z.string().min(1),
    email: nullableText,
    phone: nullableText,
    address: nullableText,
    city: nullableText,
    province: nullableText,
    postal_code: nullableText,
    service: nullableText,
    message: nullableText,
    source: z.string().min(1),
    intake_source: z.enum(["phone", "referral", "walk_in"]).nullable(),
    preferred_contact_channel: z.enum(["email", "phone"]).nullable(),
    email_consent: z
      .object({
        status: z.enum(["granted", "not_recorded"]),
        purpose: z.literal("estimate_follow_up"),
        recorded_at: nullableText,
        captured_by: nullableText,
        jurisdiction: nullableText,
        wording_version: nullableText,
      })
      .strict(),
  })
  .strict();
export type OfficeLeadReadback = z.infer<typeof officeLeadReadbackSchema>;
export const officeLeadReceiptResponseSchema = z
  .object({
    version: z.literal(1),
    receipt: z
      .object({
        request_id: officeLeadRequestIdSchema,
        state: z.enum(["processing", "recorded"]),
        outcome: z.enum(["created", "duplicate"]).nullable(),
        canonical_envelope_id: nullableText,
        lead_id: nativeSalesLeadIdSchema.nullable(),
        submitted_details_applied: z.boolean().nullable(),
        captured_at: z.string().min(1),
        details: officeLeadReadbackSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine(({ receipt }, ctx) => {
    if (
      receipt.state === "recorded" &&
      (!receipt.outcome ||
        !receipt.canonical_envelope_id ||
        !receipt.details ||
        receipt.submitted_details_applied !== (receipt.outcome === "created"))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Recorded intake needs its canonical persisted result.",
      });
    }
    if (
      receipt.state === "processing" &&
      (receipt.outcome !== null ||
        receipt.canonical_envelope_id !== null ||
        receipt.lead_id !== null ||
        receipt.details !== null ||
        receipt.submitted_details_applied !== null)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Unconfirmed intake cannot claim a recorded result.",
      });
    }
  });
export type OfficeLeadReceiptResponse = z.infer<typeof officeLeadReceiptResponseSchema>;
export type OfficeLeadReceipt = OfficeLeadReceiptResponse["receipt"];
export const salesLeadDetailResponseSchema = z
  .object({
    version: z.literal(1),
    read_model_generated_at: z.string().min(1),
    permissions: z.array(z.string()),
    allowed_actions: z.array(z.string()),
    stale_fields: z.array(z.string()),
    partial_sources: z.array(z.string()),
    lead: salesLeadSchema.extend({ id: nativeSalesLeadIdSchema }),
    intake: officeLeadReadbackSchema.nullable(),
  })
  .strict();
export type SalesLeadDetailResponse = z.infer<typeof salesLeadDetailResponseSchema>;
export type SalesLeadResponse = SalesLeadDetailResponse;

export const newLeadResponseSchema = z.object({
  version: z.literal(1),
  lead: z.object({
    envelope_id: z.string().min(1),
    canonical_envelope_id: z.string().min(1),
    tenant_id: z.string().min(1),
    status: z.string().min(1),
    duplicate: z.boolean(),
    queue: z.string().nullable(),
  }),
});

export type NewLeadResponse = z.infer<typeof newLeadResponseSchema>;
