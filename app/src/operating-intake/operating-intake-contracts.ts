import { z } from "zod";

const ENVELOPE_ID_RE = /^ow_[0-9a-f-]{36}$/;
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const nullableText = z.string().min(1).nullable();

const operatingIntakeLeadSchema = z
  .object({
    envelope_id: z.string().regex(ENVELOPE_ID_RE),
    source: z.string().min(1),
    status: z.string().min(1),
    contact_name: nullableText,
    contact_phone: nullableText,
    contact_email: nullableText,
    received_at: z.string().min(1),
    job_ref: nullableText,
    desk_state: z.literal("intake"),
    not_a_scheduled_job: z.literal(true),
    not_a_money_intent: z.literal(true),
  })
  .strict();

export const operatingIntakeResponseSchema = z
  .object({
    version: z.literal(1),
    operating_authority: z.literal("d1"),
    tenant_id: z.string().regex(TENANT_ID_RE),
    generated_at: z.string().min(1),
    leads: z.array(operatingIntakeLeadSchema),
  })
  .strict();

export type OperatingIntakeLead = z.infer<typeof operatingIntakeLeadSchema>;
export type OperatingIntakeResponse = z.infer<typeof operatingIntakeResponseSchema>;
