import { z } from "zod";

const nullableText = z.string().min(1).nullable();

const readModelEnvelopeSchema = z
  .object({
    version: z.literal(1),
    source_updated_at: nullableText,
    read_model_generated_at: z.string().min(1),
    stale_fields: z.array(z.string()),
    permissions: z.array(z.string()),
    allowed_actions: z.array(z.string()),
  })
  .strict();

const assignmentSchema = z
  .object({
    id: z.string().min(1),
    type: nullableText,
    status: nullableText,
    scheduled_start: nullableText,
    scheduled_end: nullableText,
  })
  .strict();

export const productionRunwayLaneSchema = z.enum([
  "blocked",
  "scheduled",
  "needs_assignment",
  "ready_for_review",
  "needs_verification",
]);

const schedulingGateNames = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;
const schedulingGateProjectionSchema = z
  .array(
    z
      .object({
        name: z.enum(schedulingGateNames),
        state: nullableText,
      })
      .strict(),
  )
  .length(schedulingGateNames.length)
  .superRefine((gates, context) => {
    gates.forEach((gate, index) => {
      if (gate.name === schedulingGateNames[index]) return;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "name"],
        message: "scheduling_gate_order_invalid",
      });
    });
  });

const productionJobSchema = z
  .object({
    id: z.string().min(1),
    job_number: nullableText,
    brand: nullableText,
    service_type: nullableText,
    status: nullableText,
    assignment: assignmentSchema.nullable(),
    scheduling_preparation_allowed: z.boolean(),
    lane: productionRunwayLaneSchema,
    next_action: z.string().min(1),
    gate_coverage: z.enum(["complete", "incomplete", "unknown"]),
    gate_summary: z
      .object({
        expected: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        waived: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
      })
      .strict(),
    scheduling_gates: schedulingGateProjectionSchema,
    material_attention: z.array(
      z
        .object({
          status: z.string().min(1),
          requested_delivery_date: nullableText,
        })
        .strict(),
    ),
  })
  .strict();

export const productionRunwayResponseSchema = readModelEnvelopeSchema
  .extend({
    partial_sources: z.array(z.string()),
    summary: z
      .object({
        active_jobs: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        scheduled: z.number().int().nonnegative(),
        needs_assignment: z.number().int().nonnegative(),
        ready_for_review: z.number().int().nonnegative(),
        needs_verification: z.number().int().nonnegative(),
      })
      .strict(),
    jobs: z.array(productionJobSchema),
    crews: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type ProductionRunwayJob = z.infer<typeof productionJobSchema>;
export type ProductionRunwayLane = z.infer<typeof productionRunwayLaneSchema>;
export type ProductionRunwayResponse = z.infer<typeof productionRunwayResponseSchema>;
