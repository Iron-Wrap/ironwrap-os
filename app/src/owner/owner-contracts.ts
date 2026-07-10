import { z } from "zod";

const nullableText = z.string().nullable();

const mctbSchema = z.object({
  state: z.enum([
    "provider_accepted_within_sla",
    "provider_accepted_late",
    "no_eligible_channel",
    "awaiting_proof",
    "unproven_after_sla",
    "time_unavailable",
  ]),
  deadline_at: nullableText,
  observed_at: nullableText,
  channel: z.literal("email").nullable(),
  proof_kind: z.literal("provider_receipt").nullable(),
});

const ownerReadModelEnvelopeSchema = z.object({
  version: z.literal(1),
  source_updated_at: nullableText,
  read_model_generated_at: z.string().min(1),
  stale_fields: z.array(z.string()),
  permissions: z.array(z.string()),
  allowed_actions: z.array(z.string()),
});

export const ownerExceptionSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  severity: nullableText,
  title: z.string().min(1),
  why: nullableText,
  next_action: nullableText,
  job_id: nullableText,
  occurred_at: nullableText,
  due_at: nullableText,
  received_at: nullableText,
  bus_status: nullableText,
  triage_status: nullableText,
  mctb: mctbSchema.nullable(),
});

export const ownerNowResponseSchema = ownerReadModelEnvelopeSchema.extend({
  exceptions: z.array(ownerExceptionSchema),
  partial_sources: z.array(z.string()),
  summary: z.object({
    active_jobs: z.number().int().nonnegative(),
    field_blockers: z.number().int().nonnegative(),
    blocked_gates: z.number().int().nonnegative(),
    open_incidents: z.number().int().nonnegative(),
    finance_exceptions: z.number().int().nonnegative(),
    untriaged_leads: z.number().int().nonnegative(),
    lead_triage_unknown: z.number().int().nonnegative(),
    mctb_unproven_due: z.number().int().nonnegative(),
    material_exceptions: z.number().int().nonnegative(),
  }),
});

export type OwnerException = z.infer<typeof ownerExceptionSchema>;
export type OwnerNowResponse = z.infer<typeof ownerNowResponseSchema>;
