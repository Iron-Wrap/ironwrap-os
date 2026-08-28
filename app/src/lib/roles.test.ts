import { describe, expect, it } from "vitest";

import {
  appRoles,
  navigationForRole,
  roleCanAccess,
  roleLabel,
  type NavigationItem,
  type RoleSurface,
} from "./roles";

describe("role-shaped navigation", () => {
  it("keeps every role anchored on Now and field devices focused on execution", () => {
    expect(navigationForRole("field").map((item) => item.to)).toEqual([
      "/now",
      "/check-in",
      "/vehicle",
      "/inventory",
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
      "/sales/board",
    ]);
    expect(roleCanAccess("sales", "sales")).toBe(true);
    expect(roleCanAccess("sales", "owner")).toBe(false);
    expect(roleCanAccess("sales", "newo")).toBe(false);
    expect(roleCanAccess("sales", "field")).toBe(false);
    expect(roleLabel("sales")).toBe("Sales");
  });

  it("keeps owner configuration distinct from the owner-plus-operations setup surface", () => {
    expect(roleCanAccess("owner", "ownerConfiguration")).toBe(true);
    for (const role of ["ops", "sales", "production", "accounting", "field"] as const) {
      expect(roleCanAccess(role, "ownerConfiguration"), `${role} -> ownerConfiguration`).toBe(
        false,
      );
    }
  });

  it("gives production only its own daily surfaces", () => {
    expect(appRoles).toContain("production");
    expect(navigationForRole("production").map((item) => item.to)).toEqual(["/now", "/production"]);
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

  it("keeps the complete role map while marking only daily phone destinations as primary", () => {
    expect(navigationForRole("owner")).toHaveLength(11);
    expect(navigationForRole("ops")).toHaveLength(11);
    expect(navigationForRole("field")).toHaveLength(4);
    expect(
      navigationForRole("owner")
        .filter((item) => item.mobilePrimary)
        .map((item) => item.to),
    ).toEqual(["/now", "/sales", "/production"]);
    expect(
      navigationForRole("field")
        .filter((item) => item.mobilePrimary)
        .map((item) => item.to),
    ).toEqual(["/now", "/check-in", "/vehicle"]);
    expect(navigationForRole("owner").map((item) => item.to)).not.toContain("/vehicle");
    expect(navigationForRole("ops").map((item) => item.to)).not.toContain("/vehicle");
  });

  // The pipeline board is mounted per role app, not as one shared route with role
  // filtering inside it (ELEC-156 section 4). Sales reaches its own pipeline; Owner and
  // Operations reach the switcher across all of them. Production, Accounting and Field
  // get no board in M1 (PO decision D10).
  it("gives the board a tab inside each role app that owns one, and none to the rest", () => {
    expect(navigationForRole("sales").find((item) => item.to === "/sales/board")?.label).toBe(
      "Board",
    );
    expect(navigationForRole("sales").map((item) => item.to)).not.toContain("/owner/board");
    for (const role of ["owner", "ops"] as const) {
      expect(navigationForRole(role).find((item) => item.to === "/owner/board")?.workspace).toBe(
        "Revenue",
      );
      expect(navigationForRole(role).map((item) => item.to)).not.toContain("/sales/board");
    }
    for (const role of ["production", "accounting", "field"] as const) {
      const destinations = navigationForRole(role).map((item) => item.to);
      expect(destinations).not.toContain("/sales/board");
      expect(destinations).not.toContain("/owner/board");
    }
  });

  // Four phone tabs stay four phone tabs: adding a fifth primary destination would push
  // the bottom nav past the 320px floor `styles.css` sets.
  it("keeps the phone bottom nav at four destinations after the board arrives", () => {
    expect(
      navigationForRole("owner")
        .filter((item) => item.mobilePrimary)
        .map((item) => item.to),
    ).toEqual(["/now", "/sales", "/production"]);
    expect(navigationForRole("sales")).toHaveLength(3);
  });

  // ELEC-157: every role's own menu offered "/settings", but the crew-device pairing desk
  // behind it is guarded to owner/ops — so sales, production and field each had a menu
  // item that answered "this work belongs to another role". Navigation and roleCanAccess
  // are two lists that must agree; this is the test that keeps them agreeing.
  it("advertises only destinations the role can actually open", () => {
    const guardedSurfaces: Partial<Record<NavigationItem["to"], RoleSurface>> = {
      "/settings": "owner",
      "/owner": "owner",
      "/approvals": "owner",
      "/newo": "newo",
      "/facet-designs": "owner",
      "/service": "owner",
      "/sales": "sales",
      "/production": "production",
      "/accounting": "accounting",
      "/accounting/exceptions": "accounting",
      "/accounting/quickbooks": "accounting",
      "/today": "field",
      "/check-in": "field",
      "/vehicle": "fleet",
      "/inventory": "inventory",
    };

    for (const role of appRoles) {
      for (const item of navigationForRole(role)) {
        const surface = guardedSurfaces[item.to];
        if (!surface) continue;
        expect(roleCanAccess(role, surface), `${role} navigation offers ${item.to}`).toBe(true);
      }
    }
  });

  it("organizes office work around the operating flow instead of one flat list", () => {
    const ownerNavigation = navigationForRole("owner");
    expect([...new Set(ownerNavigation.map((item) => item.workspace))]).toEqual([
      "Command",
      "Revenue",
      "Delivery",
      "Resources",
      "Control",
    ]);
    expect(ownerNavigation.find((item) => item.to === "/inventory")?.workspace).toBe("Resources");
    expect(navigationForRole("accounting")[0]?.workspace).toBe("Finance");
  });

  it("allows every role only onto its intended work surfaces", () => {
    const expected = {
      owner: [
        "owner",
        "sales",
        "production",
        "accounting",
        "newo",
        "job",
        "field",
        "inventory",
        "pairing",
      ],
      ops: ["owner", "sales", "production", "newo", "job", "field", "inventory", "pairing"],
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
      "pairing",
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
    expect(roleCanAccess("owner", "pairing")).toBe(true);
    expect(roleCanAccess("ops", "pairing")).toBe(true);
    expect(roleCanAccess("sales", "pairing")).toBe(false);
    expect(roleCanAccess("production", "pairing")).toBe(false);
    expect(roleCanAccess("field", "pairing")).toBe(false);
    expect(roleCanAccess("accounting", "pairing")).toBe(false);
  });
});
