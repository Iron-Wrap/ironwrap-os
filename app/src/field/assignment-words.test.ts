import { describe, expect, it } from "vitest";

import { assignmentRole, assignmentRoleLabel } from "./assignment-words";

describe("assignmentRole", () => {
  it("names the crew's part as a role, then the assignment's state", () => {
    expect(assignmentRole({ type: "Production", status: "Assigned" })).toBe(
      "Production crew · Assigned",
    );
    expect(assignmentRole({ type: "Estimate", status: "In Progress" })).toBe(
      "Estimate crew · In progress",
    );
    expect(assignmentRole({ type: "Service", status: "Completed" })).toBe("Service crew · Done");
  });

  it("shows a type or state it has no words for as sent, and nothing for neither", () => {
    expect(assignmentRole({ type: "Gutters", status: "Paused" })).toBe("Gutters · Paused");
    expect(assignmentRole({ type: null, status: "Assigned" })).toBe("Assigned");
    expect(assignmentRole({ type: " Production ", status: "  " })).toBe("Production crew");
    expect(assignmentRole(null)).toBe("");
  });

  it("has a crew noun for every Job Assignment type", () => {
    const types = [
      "Inspection",
      "Estimate",
      "Production",
      "Quality",
      "Closeout",
      "Service",
      "Field",
      "Shop",
      "Warehouse",
      "Delivery",
      "Fleet",
      "Facility",
    ];
    for (const type of types) {
      expect(assignmentRole({ type, status: null })).toBe(`${type} crew`);
    }
  });

  it("says Your role only on a crew phone", () => {
    expect(assignmentRoleLabel("field")).toBe("Your role");
    expect(assignmentRoleLabel("owner")).toBe("Crew role");
    expect(assignmentRoleLabel("production")).toBe("Crew role");
  });
});
