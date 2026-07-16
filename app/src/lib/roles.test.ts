import { describe, expect, it } from "vitest";

import { navigationForRole, roleCanAccess } from "./roles";

describe("role-shaped navigation", () => {
  it("keeps field devices focused on Today and Check-in", () => {
    expect(navigationForRole("field").map((item) => item.to)).toEqual([
      "/today",
      "/check-in",
      "/settings",
    ]);
  });

  it("shows exception and sales surfaces only to office roles", () => {
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/owner");
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/production");
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/approvals");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/sales");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/production");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/approvals");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/approvals");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/production");
    expect(roleCanAccess("field", "owner")).toBe(false);
    expect(roleCanAccess("field", "sales")).toBe(false);
    expect(roleCanAccess("owner", "field")).toBe(true);
  });
});
