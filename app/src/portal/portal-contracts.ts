import { z } from "zod";

const nullableText = z.string().nullable();
const nullableNumber = z.number().finite().nullable();

export const customerPortalResponseSchema = z
  .object({
    version: z.literal(1),
    brand: z.string(),
    source_updated_at: nullableText,
    read_model_generated_at: z.string(),
    job: z
      .object({
        job_number: nullableText,
        service_type: nullableText,
        status: nullableText,
      })
      .strict(),
    proposal: z
      .object({
        status: nullableText,
        prepared_at: nullableText,
        approved_at: nullableText,
        signed_at: nullableText,
        quote: z
          .object({
            version: nullableNumber,
            status: nullableText,
            total: nullableNumber,
            currency: nullableText,
            deposit_amount: nullableNumber,
            balance_due: nullableNumber,
            payment_status: nullableText,
            payment_due_date: nullableText,
            valid_until: nullableText,
            scope_summary: nullableText,
            assumptions: nullableText,
            exclusions: nullableText,
          })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
    scope: z.array(
      z
        .object({
          id: z.string(),
          type: nullableText,
          title: nullableText,
          text: nullableText,
          version: nullableText,
        })
        .strict(),
    ),
    progress: z.array(
      z
        .object({
          id: z.string(),
          type: nullableText,
          proof_slot: nullableText,
          captured_at: nullableText,
          summary: nullableText,
        })
        .strict(),
    ),
    closeout: z
      .object({
        approved_at: nullableText,
        warranty_ready: z.boolean(),
      })
      .strict()
      .nullable(),
    warranty: z
      .object({
        status: nullableText,
        material_system: nullableText,
        terms: nullableText,
        coverage_start: nullableText,
        coverage_years: nullableNumber,
        exclusions: nullableText,
        issued_at: nullableText,
      })
      .strict()
      .nullable(),
  })
  .strict();

export type CustomerPortalResponse = z.infer<typeof customerPortalResponseSchema>;

export const customerContractAcceptanceChallengeResponseSchema = z
  .object({
    status: z.literal("challenge_sent"),
    expires_at: z.string().min(1).max(64),
  })
  .strict();

export const customerContractAcceptanceConfirmResponseSchema = z
  .object({
    status: z.union([z.literal("accepted"), z.literal("uncertain")]),
    acceptance_id: z.string().min(8).max(140),
  })
  .strict();

export type CustomerContractAcceptanceChallengeResponse = z.infer<
  typeof customerContractAcceptanceChallengeResponseSchema
>;
export type CustomerContractAcceptanceConfirmResponse = z.infer<
  typeof customerContractAcceptanceConfirmResponseSchema
>;
