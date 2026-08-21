import { describe, expect, it } from "vitest";

import { appRoles, navigationForRole, roleCanAccess, roleLabel } from "./roles";

describe("role-shaped navigation", () => {
  it("keeps every role anchored on Now and field devices focused on execution", () => {
    expect(navigationForRole("field").map((item) => item.to)).toEqual([
      "/now",
      "/check-in",
      "/vehicle",
      "/settings",
    ]);
    expect(navigationForRole("owner")[0]?.to).toBe("/now");
    expect(navigationForRole("ops")[0]?.to).toBe("/now");
    expect(roleLabel("field")).toBe("Crew");
    expect(roleLabel("ops")).toBe("Operations");
    expect(navigationForRole("owner").find((item) => item.to === "/facet-designs")?.label).toBe(
      "Designs",
    );
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

  // IRO-52 slice S9: the money desk is the accounting role's landing page (contract section 8.2),
  // so it leads, and the exception queue sits beside it. QuickBooks stays a setting.
  it("lands accounting on the money desk, with its queue, Now, and finance settings", () => {
    expect(appRoles).toContain("accounting");
    expect(navigationForRole("accounting").map((item) => item.to)).toEqual([
      "/accounting",
      "/accounting/exceptions",
      "/now",
      "/accounting/quickbooks",
    ]);
    expect(roleLabel("accounting")).toBe("Accounting");
  });

  // Mobile-first is a gating product rule. The shared office bar already carries nine items, which
  // on a 360 px viewport is about 38 px each; a tenth would put every office role under the
  // touch-target floor. The money desk therefore lives in the accounting role's own navigation.
  it("does not widen the shared office navigation past what a phone can carry", () => {
    expect(navigationForRole("owner")).toHaveLength(9);
    expect(navigationForRole("ops")).toHaveLength(9);
    // ELEC-87 added the vehicle rail to the field bar, not this one. Four items
    // on a 360 px bar is ~90 px each; the office bar stays where it is, and no
    // office role gets a tab to a route its role is refused at.
    expect(navigationForRole("field")).toHaveLength(4);
    expect(navigationForRole("owner").map((item) => item.to)).not.toContain("/vehicle");
    expect(navigationForRole("ops").map((item) => item.to)).not.toContain("/vehicle");
  });

  it("allows every role only onto its intended work surfaces", () => {
    const expected = {
      owner: ["owner", "sales", "production", "accounting", "newo", "job", "field", "inventory"],
      ops: ["owner", "sales", "production", "newo", "job", "field", "inventory"],
      sales: ["sales"],
      production: ["production", "job"],
      accounting: ["accounting"],
      // The fleet capture routes refuse every role but `field`, so only the
      // field role may reach the screen that calls them.
      field: ["job", "field", "fleet", "inventory"],
    } as const;
    const surfaces = [
      "owner",
      "sales",
      "production",
      "accounting",
      "newo",
      "job",
      "field",
      "fleet",
      "inventory",
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
    expect(roleCanAccess("owner", "inventory")).toBe(true);
    expect(roleCanAccess("ops", "inventory")).toBe(true);
    expect(roleCanAccess("field", "inventory")).toBe(true);
    expect(roleCanAccess("sales", "inventory")).toBe(false);
    expect(roleCanAccess("production", "inventory")).toBe(false);
    expect(roleCanAccess("accounting", "inventory")).toBe(false);
  });
});
