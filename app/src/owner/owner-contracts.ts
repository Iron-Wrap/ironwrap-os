import { z } from "zod";

const nullableText = z.string().nullable();
const isoTimestampSchema = z.string().datetime({ offset: true });

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

export const measurementIntakeOwnerExceptionSchema = z
  .object({
    id: z.string().regex(/^measurement_[0-9a-f]{64}$/),
    provider: z.string().min(3).max(80),
    job_number: z.string().min(1).max(160).nullable(),
    status: z.enum(["unmatched", "retryable_error"]),
    reason: z.enum([
      "job_number_missing",
      "job_match_required",
      "drive_not_configured",
      "report_fetch_failed",
      "raw_source_missing",
      "frappe_sync_failed",
      "retry_pending",
    ]),
    drive_report_url: z.string().url().max(2_048).nullable(),
    drive_folder_url: z.string().url().max(2_048).nullable(),
    attempts: z.number().int().positive(),
    recovery_disposition: z.enum([
      "manual_review",
      "retry_scheduled",
      "recovery_blocked",
      "retry_exhausted",
    ]),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((exception, context) => {
    const dispositionMatchesStatus =
      exception.status === "unmatched"
        ? exception.recovery_disposition === "manual_review"
        : exception.recovery_disposition !== "manual_review";
    if (!dispositionMatchesStatus) {
      context.addIssue({
        code: "custom",
        path: ["recovery_disposition"],
        message: "measurement_recovery_disposition_status_mismatch",
      });
    }
  });

export const measurementIntakeOwnerExceptionsResponseSchema = z
  .object({ measurements: z.array(measurementIntakeOwnerExceptionSchema) })
  .strict();

export type OwnerException = z.infer<typeof ownerExceptionSchema>;
export type OwnerNowResponse = z.infer<typeof ownerNowResponseSchema>;
export type MeasurementIntakeOwnerException = z.infer<typeof measurementIntakeOwnerExceptionSchema>;
export type MeasurementIntakeOwnerExceptionsResponse = z.infer<
  typeof measurementIntakeOwnerExceptionsResponseSchema
>;
