import { describe, expect, it } from "vitest";

import {
  holdbackPayrollRefusalSchema,
  holdbackPayrollSurface,
  holdbackPayrollSurfaceSchema,
} from "./holdback-payroll-contracts";

describe("holdback and payroll PWA contracts", () => {
  it("pin the leftover surfaces as unimplemented with no posting target", () => {
    const surface = holdbackPayrollSurface();
    expect(holdbackPayrollSurfaceSchema.parse(surface)).toEqual(surface);
    expect(surface.holdback.implemented).toBe(false);
    expect(surface.payroll.implemented).toBe(false);
    expect(surface.sandbox_acceptance.live_accountant_acceptance).toBe(false);
    expect(surface.sandbox_acceptance.live_quickbooks_call).toBe(false);
    expect(surface.posting_target).toBeNull();
  });

  it("accepts the Worker 501 refusal and rejects a pretended live accept", () => {
    expect(
      holdbackPayrollRefusalSchema.parse({
        error: "accounting_holdback_not_implemented",
        slice: "S6",
        status: 501,
      }),
    ).toEqual({
      error: "accounting_holdback_not_implemented",
      slice: "S6",
      status: 501,
    });
    expect(() =>
      holdbackPayrollRefusalSchema.parse({
        error: "ok",
        slice: "S6",
        status: 200,
      }),
    ).toThrow();
  });
});
