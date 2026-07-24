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
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/newo");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/sales");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/production");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/approvals");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/newo");
    expect(navigationForRole("ops").find((item) => item.to === "/newo")?.mobileLabel).toBe("Calls");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/approvals");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/production");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/newo");
    expect(roleCanAccess("field", "owner")).toBe(false);
    expect(roleCanAccess("field", "sales")).toBe(false);
    expect(roleCanAccess("field", "newo")).toBe(false);
    expect(roleCanAccess("ops", "newo")).toBe(true);
    expect(roleCanAccess("owner", "field")).toBe(true);
  });
});
