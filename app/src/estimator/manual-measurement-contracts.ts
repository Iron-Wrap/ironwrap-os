import { z } from "zod";

export const manualMeasurementRequestIdSchema = z
  .string()
  .regex(
    /^manual-measurement:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const manualObservationIdSchema = z.string().regex(/^mobs_[0-9a-f]{64}$/);
export const manualAreaIdSchema = z.string().regex(/^marea_[0-9a-f]{64}$/);
const jobId = z
  .string()
  .min(8)
  .max(200)
  .refine((value) => !/[\s/\\?#]/.test(value) && value !== "..", "Invalid native job identity");
const tenantId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().min(1).max(1_000_000);
const facts = {
  area_sq_ft: z.number().finite().positive().max(250_000).nullable(),
  area_basis: z.enum(["roof_surface", "horizontal_plan", "unknown"]),
  pitch_rise_per_12: z.number().finite().min(0).max(24).nullable(),
  method: z.enum(["tape", "laser", "plans", "drone"]),
  uncertainty: z.string().trim().min(1).max(500).nullable(),
  correction_reason: z.string().trim().min(3).max(500).nullable(),
};
export const manualMeasurementInputSchema = z
  .object({
    expected_job_version: integer,
    expected_observation_head: manualObservationIdSchema.nullable(),
    target: z.union([
      z.object({ area_id: manualAreaIdSchema }).strict(),
      z.object({ new_area_label: z.string().trim().min(1).max(120) }).strict(),
    ]),
    ...facts,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.area_sq_ft === null && value.pitch_rise_per_12 === null)
      ctx.addIssue({ code: "custom", path: ["area_sq_ft"], message: "Record an area or pitch" });
    if (value.area_sq_ft === null && value.area_basis !== "unknown")
      ctx.addIssue({
        code: "custom",
        path: ["area_basis"],
        message: "An absent area has an unknown basis",
      });
    if ("area_id" in value.target && value.correction_reason === null)
      ctx.addIssue({
        code: "custom",
        path: ["correction_reason"],
        message: "Explain the correction",
      });
    if ("new_area_label" in value.target && value.correction_reason !== null)
      ctx.addIssue({
        code: "custom",
        path: ["correction_reason"],
        message: "A new area is not a correction",
      });
  });
export const manualObservationSchema = z
  .object({
    id: manualObservationIdSchema,
    job_id: jobId,
    area_id: manualAreaIdSchema,
    area_label: z.string().min(1).max(120),
    revision: integer,
    sequence: integer,
    ...facts,
    supersedes_observation_id: manualObservationIdSchema.nullable(),
    previous_head_id: manualObservationIdSchema.nullable(),
    job_version: integer,
    recorded_by: z.string().min(1).max(200),
    recorded_at: z.string().datetime(),
    sha256,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.area_sq_ft === null && value.pitch_rise_per_12 === null)
      ctx.addIssue({ code: "custom", message: "Observation contains no measurement" });
    if (
      (value.revision === 1) !== (value.supersedes_observation_id === null) ||
      (value.revision === 1) !== (value.correction_reason === null)
    )
      ctx.addIssue({ code: "custom", message: "Observation correction lineage mismatch" });
  });
export const manualMeasurementReceiptSchema = z
  .object({
    request_id: manualMeasurementRequestIdSchema,
    request_hash: sha256,
    observation: manualObservationSchema,
  })
  .strict();
export const manualMeasurementResultSchema = z
  .object({
    version: z.literal(1),
    tenant_id: tenantId,
    job_id: jobId,
    receipt: manualMeasurementReceiptSchema,
    replayed: z.boolean(),
  })
  .strict()
  .refine((value) => value.receipt.observation.job_id === value.job_id, "Job identity mismatch");
export const manualMeasurementsResponseSchema = z
  .object({
    version: z.literal(1),
    tenant_id: tenantId,
    read_model_generated_at: z.string().datetime(),
    job: z
      .object({ id: jobId, version: integer, job_number: z.string().min(1).max(160).nullable() })
      .strict(),
    allowed_actions: z.array(z.literal("manual_measurement.record")),
    observation_head: manualObservationIdSchema.nullable(),
    areas: z.array(manualObservationSchema).max(100),
    history: z
      .object({ items: z.array(manualObservationSchema).max(25), next_before: integer.nullable() })
      .strict(),
    requested_request_id: manualMeasurementRequestIdSchema.nullable(),
    receipt: manualMeasurementReceiptSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const all = [
      ...value.areas,
      ...value.history.items,
      ...(value.receipt ? [value.receipt.observation] : []),
    ];
    if (all.some((item) => item.job_id !== value.job.id))
      ctx.addIssue({ code: "custom", message: "Job identity mismatch" });
    if (value.receipt && value.receipt.request_id !== value.requested_request_id)
      ctx.addIssue({ code: "custom", message: "Receipt identity mismatch" });
  });
export type ManualMeasurementInput = z.infer<typeof manualMeasurementInputSchema>;
export type ManualObservation = z.infer<typeof manualObservationSchema>;
export type ManualMeasurementReceipt = z.infer<typeof manualMeasurementReceiptSchema>;
export type ManualMeasurementResult = z.infer<typeof manualMeasurementResultSchema>;
export type ManualMeasurementsResponse = z.infer<typeof manualMeasurementsResponseSchema>;
