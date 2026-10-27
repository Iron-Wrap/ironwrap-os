import { describe, expect, it } from "vitest";

import { assignmentRole } from "./assignment-words";

describe("assignmentRole", () => {
  it("names the crew's part as a role, then the assignment's state", () => {
    expect(assignmentRole({ type: "Production", status: "Assigned" })).toBe(
      "Production crew · Assigned",
    );
    expect(assignmentRole({ type: "Estimate", status: "In Progress" })).toBe(
      "Estimator · In progress",
    );
    expect(assignmentRole({ type: "Service", status: "Completed" })).toBe("Service crew · Done");
  });

  it("shows a type or state it has no words for as sent, and nothing for neither", () => {
    expect(assignmentRole({ type: "Gutters", status: "Paused" })).toBe("Gutters · Paused");
    expect(assignmentRole({ type: null, status: "Assigned" })).toBe("Assigned");
    expect(assignmentRole({ type: "Production", status: "  " })).toBe("Production crew");
    expect(assignmentRole(null)).toBe("");
  });
});
