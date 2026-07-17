import { z } from "zod";

const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max);
const nullableText = (min: number, max: number) => boundedText(min, max).nullable();
const identifier = boundedText(1, 140);
const positiveVersion = z.number().int().positive();
const isoDateTime = z.string().datetime({ offset: true });

const productionScheduleEffectsSchema = z
  .object({
    crew_notified: z.literal(false),
    customer_notified: z.literal(false),
    accounting_mutated: z.literal(false),
  })
  .strict();

const productionScheduleGatePreviewSchema = z
  .object({
    required: z.literal(true),
    state_eligible: z.literal(true),
  })
  .strict();

const jobAssignmentTargetSchema = z
  .object({
    doctype: z.literal("Job Assignment"),
    assignment_id: identifier,
  })
  .strict();

const assignmentProjectionSchema = z
  .object({
    assignment_id: identifier,
    roof_job_id: identifier,
    crew_profile_id: identifier,
    scheduled_start: isoDateTime,
    scheduled_end: isoDateTime.nullable(),
    supersedes_assignment_id: identifier.nullable(),
    correction_reason: nullableText(1, 2_000),
  })
  .strict();

const productionScheduleApprovalPreviewSchema = z
  .object({
    would_write: z.literal(false),
    append_only: z.literal(true),
    target: jobAssignmentTargetSchema,
    assignment: assignmentProjectionSchema,
    production_schedule_gate_preview: productionScheduleGatePreviewSchema,
    effects: productionScheduleEffectsSchema,
  })
  .strict();

const productionScheduleApprovalOutcomeSchema = z
  .object({
    run_id: boundedText(8, 256),
    created: z.literal(true),
    assignment_id: identifier,
    roof_job_id: identifier,
    crew_profile_id: identifier,
    scheduled_start: isoDateTime,
    scheduled_end: isoDateTime.nullable(),
    supersedes_assignment_id: identifier.nullable(),
    audit_finalized: z.literal(true),
    ...productionScheduleEffectsSchema.shape,
  })
  .strict();

const productionScheduleApprovalReadEnvelopeSchema = z
  .object({
    version: z.literal(1),
    read_model_generated_at: boundedText(1, 80),
    permissions: z.array(boundedText(1, 100)).max(100),
    allowed_actions: z
      .array(
        z.enum([
          "production_schedule_approval.read",
          "production_schedule_approval.prepare",
          "production_schedule_approval.approve",
          "production_schedule_approval.reject",
          "production_schedule_approval.reconcile",
        ]),
      )
      .max(5),
  })
  .strict();

export const productionScheduleApprovalPreparationInputSchema = z
  .object({
    roofJobId: identifier,
    crewProfileId: identifier,
    scheduledStart: isoDateTime,
    scheduledEnd: isoDateTime.nullable().optional(),
    supersedesAssignmentId: identifier.nullable().optional(),
    correctionReason: nullableText(1, 2_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const end = input.scheduledEnd;
    if (end && Date.parse(end) <= Date.parse(input.scheduledStart)) {
      context.addIssue({
        code: "custom",
        path: ["scheduledEnd"],
        message: "scheduled_end_must_follow_start",
      });
    }
    const supersedes = input.supersedesAssignmentId ?? null;
    const correction = input.correctionReason ?? null;
    if (supersedes && !correction) {
      context.addIssue({
        code: "custom",
        path: ["correctionReason"],
        message: "correction_reason_required_for_supersede",
      });
    }
    if (!supersedes && correction) {
      context.addIssue({
        code: "custom",
        path: ["supersedesAssignmentId"],
        message: "supersedes_assignment_required_for_correction",
      });
    }
  });

export const productionScheduleApprovalRequestSchema = z
  .object({
    id: boundedText(1, 180),
    kind: z.literal("production_schedule"),
    state: z.enum([
      "pending",
      "executing",
      "executed",
      "denied",
      "expired",
      "failed",
      "audit_failed",
      "execution_uncertain",
    ]),
    version: positiveVersion,
    action: z.literal("create_job_assignment"),
    roof_job_id: identifier,
    target: jobAssignmentTargetSchema,
    crew_profile_id: identifier,
    scheduled_start: isoDateTime,
    scheduled_end: isoDateTime.nullable(),
    supersedes_assignment_id: identifier.nullable(),
    correction_reason: nullableText(1, 2_000),
    request_text: boundedText(1, 4_000),
    preview: productionScheduleApprovalPreviewSchema.nullable(),
    expires_at: boundedText(1, 80),
    requested_by: z
      .object({
        user_id: boundedText(1, 140),
        frappe_user: nullableText(1, 256),
      })
      .strict(),
    approved_by: z
      .object({
        user_id: boundedText(1, 140),
        frappe_user: boundedText(1, 256),
        approved_at: boundedText(1, 80),
      })
      .strict()
      .nullable(),
    rejection_reason: nullableText(3, 1_000),
    run_id: boundedText(8, 256),
    hermes_run_id: nullableText(1, 256),
    outcome: productionScheduleApprovalOutcomeSchema.nullable(),
    error_code: nullableText(1, 160),
    reconciliation: z
      .object({
        at: boundedText(1, 80),
        by_user_id: boundedText(1, 140),
        by_frappe_user: boundedText(1, 256),
        outcome: z.enum(["executed", "not_executed", "inconclusive"]),
        evidence: boundedText(3, 1_000),
      })
      .strict()
      .nullable(),
    created_at: boundedText(1, 80),
    updated_at: boundedText(1, 80),
    completed_at: nullableText(1, 80),
  })
  .strict()
  .superRefine((approval, context) => {
    const assignment = {
      assignment_id: approval.target.assignment_id,
      roof_job_id: approval.roof_job_id,
      crew_profile_id: approval.crew_profile_id,
      scheduled_start: approval.scheduled_start,
      scheduled_end: approval.scheduled_end,
      supersedes_assignment_id: approval.supersedes_assignment_id,
      correction_reason: approval.correction_reason,
    };
    if (
      approval.preview &&
      (approval.preview.target.assignment_id !== assignment.assignment_id ||
        Object.entries(assignment).some(
          ([key, value]) =>
            approval.preview?.assignment[key as keyof typeof approval.preview.assignment] !== value,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["preview"],
        message: "Production schedule preview does not match its approval request.",
      });
    }
    if (
      approval.outcome &&
      (approval.outcome.run_id !== approval.run_id ||
        approval.outcome.assignment_id !== assignment.assignment_id ||
        approval.outcome.roof_job_id !== assignment.roof_job_id ||
        approval.outcome.crew_profile_id !== assignment.crew_profile_id ||
        approval.outcome.scheduled_start !== assignment.scheduled_start ||
        approval.outcome.scheduled_end !== assignment.scheduled_end ||
        approval.outcome.supersedes_assignment_id !== assignment.supersedes_assignment_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Production schedule outcome does not match its approval request.",
      });
    }
  });

export const productionScheduleApprovalListResponseSchema =
  productionScheduleApprovalReadEnvelopeSchema
    .extend({ approvals: z.array(productionScheduleApprovalRequestSchema) })
    .strict();

export const productionScheduleApprovalDetailResponseSchema =
  productionScheduleApprovalReadEnvelopeSchema
    .extend({ approval: productionScheduleApprovalRequestSchema })
    .strict();

export const productionScheduleApprovalMutationResponseSchema = z
  .object({
    approval: productionScheduleApprovalRequestSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

export type ProductionScheduleApprovalPreparationInput = z.infer<
  typeof productionScheduleApprovalPreparationInputSchema
>;
export type ProductionScheduleApprovalRequest = z.infer<
  typeof productionScheduleApprovalRequestSchema
>;
export type ProductionScheduleApprovalListResponse = z.infer<
  typeof productionScheduleApprovalListResponseSchema
>;
export type ProductionScheduleApprovalDetailResponse = z.infer<
  typeof productionScheduleApprovalDetailResponseSchema
>;
export type ProductionScheduleApprovalMutationResponse = z.infer<
  typeof productionScheduleApprovalMutationResponseSchema
>;
