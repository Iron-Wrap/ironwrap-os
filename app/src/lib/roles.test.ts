import { describe, expect, it } from "vitest";

import { appRoles, navigationForRole, roleCanAccess, roleLabel } from "./roles";

describe("role-shaped navigation", () => {
  it("keeps every role anchored on Now and field devices focused on execution", () => {
    expect(navigationForRole("field").map((item) => item.to)).toEqual([
      "/now",
      "/check-in",
      "/settings",
    ]);
    expect(navigationForRole("owner")[0]?.to).toBe("/now");
    expect(navigationForRole("ops")[0]?.to).toBe("/now");
  });

  it("gives sales only its own daily surfaces", () => {
    expect(appRoles).toContain("sales");
    expect(navigationForRole("sales").map((item) => item.to)).toEqual([
      "/now",
      "/sales",
      "/settings",
    ]);
    expect(roleCanAccess("sales", "sales")).toBe(true);
    expect(roleCanAccess("sales", "owner")).toBe(false);
    expect(roleCanAccess("sales", "newo")).toBe(false);
    expect(roleCanAccess("sales", "field")).toBe(false);
    expect(roleLabel("sales")).toBe("Sales");
  });

  it("gives production only its own daily surfaces", () => {
    expect(appRoles).toContain("production");
    expect(navigationForRole("production").map((item) => item.to)).toEqual([
      "/now",
      "/production",
      "/settings",
    ]);
    expect(roleCanAccess("production", "production")).toBe(true);
    expect(roleCanAccess("production", "owner")).toBe(false);
    expect(roleCanAccess("production", "sales")).toBe(false);
    expect(roleCanAccess("production", "newo")).toBe(false);
    expect(roleCanAccess("production", "field")).toBe(false);
    expect(roleCanAccess("production", "job")).toBe(true);
    expect(roleCanAccess("sales", "job")).toBe(false);
    expect(roleLabel("production")).toBe("Production");
  });

  it("gives accounting only Now and its finance settings", () => {
    expect(appRoles).toContain("accounting");
    expect(navigationForRole("accounting").map((item) => item.to)).toEqual([
      "/now",
      "/accounting/quickbooks",
    ]);
    expect(roleLabel("accounting")).toBe("Accounting");
  });

  it("allows every role only onto its intended work surfaces", () => {
    const expected = {
      owner: ["owner", "sales", "production", "accounting", "newo", "job", "field"],
      ops: ["owner", "sales", "production", "newo", "job", "field"],
      sales: ["sales"],
      production: ["production", "job"],
      accounting: ["accounting"],
      field: ["job", "field"],
    } as const;
    const surfaces = [
      "owner",
      "sales",
      "production",
      "accounting",
      "newo",
      "job",
      "field",
    ] as const;

    for (const role of appRoles) {
      for (const surface of surfaces) {
        expect(roleCanAccess(role, surface), `${role} -> ${surface}`).toBe(
          (expected[role] as readonly string[]).includes(surface),
        );
      }
    }
  });

  it("shows exception and sales surfaces only to office roles", () => {
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/now");
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/production");
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/approvals");
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/newo");
    expect(navigationForRole("owner").map((item) => item.to)).toContain("/facet-designs");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/sales");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/production");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/approvals");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/newo");
    expect(navigationForRole("ops").map((item) => item.to)).toContain("/facet-designs");
    expect(navigationForRole("ops").find((item) => item.to === "/newo")?.mobileLabel).toBe("Calls");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/approvals");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/production");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/newo");
    expect(navigationForRole("field").map((item) => item.to)).not.toContain("/facet-designs");
    expect(roleCanAccess("field", "owner")).toBe(false);
    expect(roleCanAccess("field", "sales")).toBe(false);
    expect(roleCanAccess("field", "newo")).toBe(false);
    expect(roleCanAccess("ops", "newo")).toBe(true);
    expect(roleCanAccess("owner", "field")).toBe(true);
    expect(roleCanAccess("owner", "production")).toBe(true);
    expect(roleCanAccess("ops", "production")).toBe(true);
  });
});
