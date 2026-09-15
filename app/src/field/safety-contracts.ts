import { z } from "zod";

/**
 * Contracts for the global safety rail.
 *
 * These are deliberately separate from the work-package contracts: the safety
 * panel must render, and must accept a report, when no job packet has ever been
 * opened on this device.
 */

export const safetyScopeTypes = ["tenant", "roof_job", "work_package", "shop", "vehicle"] as const;
export type SafetyScopeType = (typeof safetyScopeTypes)[number];

export const safetyOccurrenceKinds = [
  "injury",
  "near_miss",
  "hazard",
  "environmental",
  "emergency",
] as const;
export type SafetyOccurrenceKind = (typeof safetyOccurrenceKinds)[number];

export const safetySeverities = ["low", "moderate", "high", "critical"] as const;
export type SafetySeverity = (typeof safetySeverities)[number];

export const safetyActionKinds = [
  "report_occurrence",
  "make_safe",
  "equipment_defect",
  "rescue_request",
] as const;
export type SafetyActionKind = (typeof safetyActionKinds)[number];

export const safetyOccurrenceKindLabels: Record<SafetyOccurrenceKind, string> = {
  injury: "Injury",
  near_miss: "Near miss",
  hazard: "Hazard",
  environmental: "Environmental event",
  emergency: "Emergency",
};

export const safetySeverityLabels: Record<SafetySeverity, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  critical: "Critical",
};

export const safetyBlockerSchema = z.object({
  code: z.string().min(1),
  subject_type: z.enum(["occurrence", "equipment", "notification", "corrective_action"]),
  subject_id: z.string().min(1),
  detail: z.string().min(1),
});
export type SafetyBlocker = z.infer<typeof safetyBlockerSchema>;

export const safetyPanelResponseSchema = z.object({
  version: z.literal(1),
  panel: z.object({
    version: z.literal(1),
    actor_role: z.string().min(1),
    assigned_equipment: z.array(
      z.object({
        equipment_id: z.string().min(1),
        equipment_kind: z.string().min(1),
        serial_number: z.string().min(1),
        status: z.enum(["in_service", "quarantined", "defective", "replaced", "retired"]),
        inspection_due_at: z.string().nullable(),
      }),
    ),
    open_occurrences: z.array(
      z.object({
        occurrence_id: z.string().min(1),
        occurrence_kind: z.enum(safetyOccurrenceKinds),
        severity: z.enum(safetySeverities),
        state: z.enum(["reported", "made_safe", "investigating", "controlled", "closed"]),
        stop_active: z.boolean(),
        scope_type: z.enum(safetyScopeTypes),
        scope_id: z.string().min(1),
        summary: z.string().min(1),
      }),
    ),
    my_corrective_actions: z.array(
      z.object({
        corrective_action_id: z.string().min(1),
        state: z.enum(["open", "evidence_submitted", "verified", "closed", "rejected"]),
        risk_level: z.enum(safetySeverities),
        due_at: z.string().min(1),
        description: z.string().min(1),
      }),
    ),
    allowed_actions: z.array(z.string().min(1)),
  }),
});
export type SafetyPanelResponse = z.infer<typeof safetyPanelResponseSchema>;
export type SafetyPanel = SafetyPanelResponse["panel"];

export const safetyReadinessResponseSchema = z.object({
  version: z.literal(1),
  readiness: z.object({
    ready: z.boolean(),
    blockers: z.array(safetyBlockerSchema),
    evaluated_at: z.string().min(1),
  }),
});

export const safetyEquipmentStatusLabels: Record<
  SafetyPanel["assigned_equipment"][number]["status"],
  string
> = {
  in_service: "In service",
  quarantined: "Quarantined",
  defective: "Out of service",
  replaced: "Replaced",
  retired: "Retired",
};

export const safetyBlockerLabels: Record<string, string> = {
  safety_stop_active: "An active safety stop is in force",
  safety_event_uncontrolled: "A safety event is not yet controlled",
  safety_equipment_unserviceable: "Assigned safety equipment is not usable",
  safety_notification_outstanding: "A required notification is unresolved",
  safety_corrective_action_overdue: "A high-risk corrective action is overdue",
};

/** The exact body the durable outbox replays to `/api/v1/safety/actions`. */
export interface SafetyActionPayload {
  kind: SafetyActionKind;
  scope_type: SafetyScopeType;
  scope_id: string;
  captured_at: string;
  detail: string;
  occurrence_kind?: SafetyOccurrenceKind;
  severity?: SafetySeverity;
  occurrence_id?: string;
  equipment_id?: string;
}

export function safetyActionLabel(kind: SafetyActionKind): string {
  return kind === "report_occurrence"
    ? "Safety report"
    : kind === "make_safe"
      ? "Make safe record"
      : kind === "equipment_defect"
        ? "Equipment defect report"
        : "Rescue call";
}

export const safetyEquipmentResponseSchema = z.object({
  version: z.literal(1),
  equipment: z.object({
    equipment_id: z.string().min(1),
    equipment_kind: z.string().min(1),
    serial_number: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(["in_service", "quarantined", "defective", "replaced", "retired"]),
    assigned_user_id: z.string().nullable(),
    inspection_interval_days: z.number().int().positive(),
    last_inspection_at: z.string().nullable(),
    last_inspection_result: z.enum(["pass", "fail"]).nullable(),
    inspection_due_at: z.string().nullable(),
    replaced_by_equipment_id: z.string().nullable(),
    updated_at: z.string().min(1),
  }),
});

export type SafetyEquipment = z.infer<typeof safetyEquipmentResponseSchema>["equipment"];

export const correctiveEvidenceSchema = z
  .object({
    detail: z.string().trim().min(3).max(4000),
    evidence_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    evidence_refs_json: z
      .string()
      .max(20000)
      .refine((value) => {
        try {
          return z
            .array(
              z.object({
                ref: z
                  .string()
                  .trim()
                  .min(3)
                  .max(512)
                  .regex(/^\P{Cc}+$/u),
                sha256: z.string().regex(/^[0-9a-f]{64}$/),
              }),
            )
            .min(1)
            .max(100)
            .safeParse(JSON.parse(value)).success;
        } catch {
          return false;
        }
      }),
  })
  .strict();
export type CorrectiveEvidence = z.infer<typeof correctiveEvidenceSchema>;

export const correctiveActionSchema = z.object({
  corrective_action_id: z.string().min(1),
  occurrence_id: z.string().min(1),
  version: z.number().int().positive(),
  state: z.enum(["open", "evidence_submitted", "verified", "closed", "rejected"]),
  risk_level: z.enum(safetySeverities),
  owner_user_id: z.string().min(1),
  description: z.string().min(1),
  due_at: z.string().min(1),
  evidence_refs_json: z.string().nullable(),
  evidence_sha256: z.string().nullable(),
  evidence_captured_by_user_id: z.string().nullable(),
  evidence_submitted_at: z.string().nullable(),
  verified_by_user_id: z.string().nullable(),
  verified_at: z.string().nullable(),
  closed_at: z.string().nullable(),
});
export const correctiveActionResponseSchema = z.object({
  version: z.literal(1),
  corrective_action: correctiveActionSchema,
});
export const correctiveActionDetailSchema = correctiveActionResponseSchema.extend({
  allowed_actions: z.array(z.enum(["submit_evidence", "verify", "reject", "close"])),
  verification_unavailable_reason: z.string().nullable(),
});
export type CorrectiveActionDetail = z.infer<typeof correctiveActionDetailSchema>;
