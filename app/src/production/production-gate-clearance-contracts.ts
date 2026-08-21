import { z } from "zod";

/**
 * The six scheduling locks, in the order the runway already renders them. Kept in
 * step with `SCHEDULING_PRODUCTION_GATES` in the Worker read model by
 * `production-contracts.ts`, which asserts the projection's own order.
 */
export const clearableProductionGates = [
  "Deposit",
  "Materials",
  "Safety",
  "Access",
  "Weather",
  "Crew",
] as const;

export type ClearableProductionGate = (typeof clearableProductionGates)[number];

export const productionGateClearanceBasisSchema = z.enum(["office_waiver", "deposit_settlement"]);

export type ProductionGateClearanceBasis = z.infer<typeof productionGateClearanceBasisSchema>;

export const MIN_WAIVER_REASON_LENGTH = 8;
export const MAX_WAIVER_REASON_LENGTH = 1_000;

export const productionGateClearanceResponseSchema = z
  .object({
    gate: z
      .object({
        state: z.string().min(1),
      })
      .passthrough(),
    basis: productionGateClearanceBasisSchema,
    // Said outright rather than inferred from the absence of an evidence id: a
    // waived gate is a decision somebody made, not a thing anybody proved.
    clearance: z.enum(["waived", "verified"]),
    evidence_item: z.string().min(1).nullable(),
    actor_role: z.string().min(1).nullable(),
    replayed: z.boolean(),
  })
  .strict();

export type ProductionGateClearanceResponse = z.infer<typeof productionGateClearanceResponseSchema>;

/**
 * The office manager's side of the refusals this route can return. Anything not
 * named here falls back to the generic message; nothing is invented about why.
 */
export const productionGateClearanceMessages: Record<string, string> = {
  deposit_settlement_not_observed:
    "No settled deposit invoice is recorded for this job yet. Clear it on the settlement once the payment is observed, or waive it with a reason.",
  production_gate_job_not_on_runway:
    "This job is not on your production runway, so its gates cannot be cleared here.",
  production_gate_already_cleared:
    "This gate already carries a different clearance. Reload the runway to see it.",
  production_gate_actor_role_denied:
    "Your Frappe user needs the IronWrap Owner or IronWrap Production role to clear a gate.",
  production_gate_actor_not_enabled:
    "Your Frappe user is disabled, so no clearance can be attributed to it.",
  production_gate_job_not_clearable:
    "Only a Won or In Production job has a schedule a gate can unlock.",
  production_gate_due_at_missing:
    "This gate has no due date, so it cannot be marked ready on evidence.",
  production_gate_clearance_forbidden:
    "Clearing a production gate needs an owner or production session linked to a Frappe user.",
  production_gate_receipt_unavailable:
    "The clearance receipt could not be stored, so nothing was changed.",
};
