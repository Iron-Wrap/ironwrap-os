import { z } from "zod";

/**
 * IRO-52 leftover PWA contract: holdback register, release wizard, and payroll
 * review are specified (S10) and remain unimplemented. The desk must not render
 * a live posting target or invent accountant acceptance.
 */

export const holdbackPayrollSlices = ["S6", "S7", "S10", "S12"] as const;
export type HoldbackPayrollSlice = (typeof holdbackPayrollSlices)[number];

export const holdbackPayrollSurfaceSchema = z
  .object({
    holdback: z.object({
      implemented: z.literal(false),
      slice: z.literal("S6"),
      review_slice: z.literal("S10"),
    }),
    payroll: z.object({
      implemented: z.literal(false),
      slice: z.literal("S7"),
      review_slice: z.literal("S10"),
    }),
    sandbox_acceptance: z.object({
      implemented: z.literal(false),
      slice: z.literal("S12"),
      live_accountant_acceptance: z.literal(false),
      live_quickbooks_call: z.literal(false),
    }),
    posting_target: z.null(),
  })
  .strict();

export type HoldbackPayrollSurface = z.infer<typeof holdbackPayrollSurfaceSchema>;

export function holdbackPayrollSurface(): HoldbackPayrollSurface {
  return {
    holdback: { implemented: false, slice: "S6", review_slice: "S10" },
    payroll: { implemented: false, slice: "S7", review_slice: "S10" },
    sandbox_acceptance: {
      implemented: false,
      slice: "S12",
      live_accountant_acceptance: false,
      live_quickbooks_call: false,
    },
    posting_target: null,
  };
}

export const holdbackPayrollRefusalSchema = z
  .object({
    error: z.enum(["accounting_holdback_not_implemented", "accounting_payroll_not_implemented"]),
    slice: z.enum(["S6", "S7"]),
    status: z.literal(501),
  })
  .strict();

export type HoldbackPayrollRefusal = z.infer<typeof holdbackPayrollRefusalSchema>;
