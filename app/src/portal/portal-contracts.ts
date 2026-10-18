import { z } from "zod";

const nullableText = z.string().nullable();
const nullableNumber = z.number().finite().nullable();

export const customerPortalResponseSchema = z
  .object({
    version: z.literal(1),
    brand: z.string(),
    contract_acceptance_available: z.boolean(),
    material_decision_available: z.boolean(),
    source_updated_at: nullableText,
    read_model_generated_at: z.string(),
    job: z
      .object({
        job_number: nullableText,
        service_type: nullableText,
        status: nullableText,
      })
      .strict(),
    // Optional while an older Worker response is still in use. Present only when the owner
    // saved a customer-facing company contact; never a staff identity.
    company_contact: z
      .object({
        phone: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/)
          .nullable(),
        // Mirrors the Worker's acceptance rule exactly: a stricter browser check would fail the
        // whole page on an address the Worker shares.
        email: z
          .string()
          .regex(/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i)
          .nullable(),
      })
      .strict()
      .nullable()
      .optional(),
    // Optional while an older Worker response is still in use. A present window is an
    // office-committed native assignment, not evidence of customer acknowledgment.
    install_window: z
      .object({
        scheduled_start: z.string().datetime({ offset: true }),
        scheduled_end: z.string().datetime({ offset: true }).nullable(),
        confirmed: z.literal(true),
        confirmation_basis: z.literal("office_committed_assignment"),
      })
      .strict()
      .nullable()
      .optional(),
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
    option_packages: z.array(
      z
        .object({
          id: z.string(),
          package_name: nullableText,
          tier: nullableText,
          material_system: nullableText,
          price_delta: nullableNumber,
          currency: nullableText,
          // Office-authored and deliberately unconstrained beyond "a JSON object". The section
          // renders it as text pairs only, so a shape it has not seen before degrades to a plain
          // list rather than to a crash.
          options: z.record(z.string(), z.unknown()).nullable(),
          warranty_summary: nullableText,
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

export const customerContractAcceptancePreviewResponseSchema = z
  .object({
    status: z.literal("ready"),
    quote_version: z.number().int().min(1),
    total_cents: z.number().int().min(0).max(1_000_000_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    proposal_title: z.string().min(1).max(200),
    proposal_summary: z.string().min(1).max(4_000),
    terms: z.record(z.string(), z.unknown()),
  })
  .strict();

export const customerContractAcceptanceConfirmResponseSchema = z
  .object({
    status: z.union([z.literal("accepted"), z.literal("uncertain")]),
    acceptance_id: z.string().min(8).max(140),
  })
  .strict();

export const customerPortalDecisionResponseSchema = z
  .object({
    status: z.union([z.literal("recorded"), z.literal("uncertain")]),
    decision_id: z.string().min(8).max(140),
  })
  .strict();

export type CustomerPortalOptionPackage = CustomerPortalResponse["option_packages"][number];
export type CustomerPortalDecisionResponse = z.infer<typeof customerPortalDecisionResponseSchema>;

export type CustomerContractAcceptanceChallengeResponse = z.infer<
  typeof customerContractAcceptanceChallengeResponseSchema
>;
export type CustomerContractAcceptancePreviewResponse = z.infer<
  typeof customerContractAcceptancePreviewResponseSchema
>;
export type CustomerContractAcceptanceConfirmResponse = z.infer<
  typeof customerContractAcceptanceConfirmResponseSchema
>;
