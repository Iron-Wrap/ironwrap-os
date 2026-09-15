import { z } from "zod";

/** Mirrors `SafetyDeskProjection` in `workers-bus/src/safety-lifecycle.ts`.
 *  The verdicts are the release gate's own judgement, not this screen's: a desk that
 *  disagreed with what stops a crew would be worse than no desk at all. */

export const safetyEquipmentVerdicts = ["serviceable", "unserviceable", "expiring"] as const;
export type SafetyEquipmentVerdict = (typeof safetyEquipmentVerdicts)[number];

export const safetyDeskEquipmentSchema = z.object({
  equipment_id: z.string(),
  equipment_kind: z.string(),
  serial_number: z.string(),
  status: z.string(),
  assigned_user_id: z.string().nullable(),
  inspection_due_at: z.string().nullable(),
  last_inspection_result: z.enum(["pass", "fail"]).nullable(),
  verdict: z.enum(safetyEquipmentVerdicts),
  detail: z.string().nullable(),
  days_left: z.number().nullable(),
});

export const safetyDeskCorrectiveActionSchema = z.object({
  corrective_action_id: z.string(),
  occurrence_id: z.string(),
  state: z.string(),
  risk_level: z.string(),
  owner_user_id: z.string(),
  due_at: z.string(),
  description: z.string(),
  blocking: z.boolean(),
  days_left: z.number(),
});

export const safetyDeskResponseSchema = z.object({
  version: z.literal(1),
  read_model_generated_at: z.string(),
  expiring_within_days: z.number(),
  actor_role: z.string(),
  // null is not []: "nothing on file" and "not yours to read" are different answers.
  equipment: z.array(safetyDeskEquipmentSchema).nullable(),
  corrective_actions: z.array(safetyDeskCorrectiveActionSchema).nullable(),
});

export type SafetyDeskEquipment = z.infer<typeof safetyDeskEquipmentSchema>;
export type SafetyDeskCorrectiveAction = z.infer<typeof safetyDeskCorrectiveActionSchema>;
export type SafetyDeskResponse = z.infer<typeof safetyDeskResponseSchema>;

/** Sentence case throughout: the repo bans shouted labels family-wide. */
export function equipmentVerdictLabel(verdict: SafetyEquipmentVerdict): string {
  if (verdict === "unserviceable") return "Not usable";
  if (verdict === "expiring") return "Inspection due";
  return "Usable";
}

export function equipmentKindLabel(kind: string): string {
  const words = kind.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What a reader has to do about a corrective action, in words rather than a colour. */
export function correctiveActionTiming(action: SafetyDeskCorrectiveAction): string {
  if (action.days_left < 0) {
    const days = Math.abs(action.days_left);
    return `Was due ${action.due_at.slice(0, 10)}, ${days} ${days === 1 ? "day" : "days"} ago`;
  }
  if (action.days_left === 0) return `Due today, ${action.due_at.slice(0, 10)}`;
  return `Due ${action.due_at.slice(0, 10)}, in ${action.days_left} days`;
}

export function correctiveActionStateLabel(state: string): string {
  if (state === "evidence_submitted") return "Evidence submitted";
  return state.charAt(0).toUpperCase() + state.slice(1);
}
