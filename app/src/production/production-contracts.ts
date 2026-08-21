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
    assignment_version: z.number().int().positive(),
    roof_job_version: z.number().int().positive(),
    crew_id: z.string().min(1),
    crew_version: z.number().int().positive(),
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
    version: z.number().int().positive(),
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
          version: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const operatingJobAssignmentInputSchema = z
  .object({
    roofJobId: z.string().min(8).max(200),
    expectedRoofJobVersion: z.number().int().positive(),
    crewId: z.string().min(8).max(200),
    expectedCrewVersion: z.number().int().positive(),
    scheduledStart: z.string().datetime({ offset: true }),
    scheduledEnd: z.string().datetime({ offset: true }).nullable(),
    supersedesAssignmentId: z.string().min(8).max(200).nullable(),
    correctionReason: z.string().trim().min(3).max(1_200).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scheduledEnd && Date.parse(value.scheduledEnd) <= Date.parse(value.scheduledStart)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduledEnd"],
        message: "scheduled_end_must_follow_start",
      });
    }
    if (Boolean(value.supersedesAssignmentId) !== Boolean(value.correctionReason)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctionReason"],
        message: "assignment_correction_pair_required",
      });
    }
  });

export const operatingJobAssignmentResponseSchema = z
  .object({
    version: z.literal(1),
    assignment: z
      .object({
        id: z.string().min(8),
        assignment_version: z.number().int().positive(),
        roof_job_id: z.string().min(8),
        roof_job_version: z.number().int().positive(),
        crew_id: z.string().min(8),
        crew_version: z.number().int().positive(),
        assigned_users: z.array(z.string().min(1)).min(1),
        scheduled_start: z.string().datetime({ offset: true }),
        scheduled_end: z.string().datetime({ offset: true }).nullable(),
        supersedes_assignment_id: z.string().min(8).nullable(),
        correction_reason: z.string().min(3).nullable(),
        actor_user_id: z.string().min(1),
        created_at: z.string().datetime({ offset: true }),
      })
      .strict(),
    replayed: z.boolean(),
  })
  .strict();

export type ProductionRunwayJob = z.infer<typeof productionJobSchema>;
export type ProductionRunwayLane = z.infer<typeof productionRunwayLaneSchema>;
export type ProductionRunwayResponse = z.infer<typeof productionRunwayResponseSchema>;
export type OperatingJobAssignmentInput = z.infer<typeof operatingJobAssignmentInputSchema>;
export type OperatingJobAssignmentResponse = z.infer<typeof operatingJobAssignmentResponseSchema>;
