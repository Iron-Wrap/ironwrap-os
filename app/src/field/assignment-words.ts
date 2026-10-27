/**
 * A crew phone names the crew's part on a job as a role ("Production crew"), never the bare
 * assignment type: testers did not read "Production · Assigned" as a role (gate e-job-page-layout).
 * The types are the Job Assignment's own list; a type outside it shows as sent.
 */
const ROLE_OF_TYPE: Record<string, string> = {
  Inspection: "Inspection crew",
  Estimate: "Estimator",
  Production: "Production crew",
  Quality: "Quality checker",
  Closeout: "Closeout crew",
  Service: "Service crew",
  Field: "Field crew",
  Shop: "Shop crew",
  Warehouse: "Warehouse crew",
  Delivery: "Delivery crew",
  Fleet: "Fleet crew",
  Facility: "Facility crew",
};

const STATUS_WORDS: Record<string, string> = {
  "In Progress": "In progress",
  Completed: "Done",
  Superseded: "Replaced",
};

/** "Production crew · Assigned"; empty when the assignment says neither. */
export function assignmentRole(
  assignment: { type?: string | null; status?: string | null } | null | undefined,
): string {
  const type = assignment?.type?.trim();
  const status = assignment?.status?.trim();
  return [
    type ? (ROLE_OF_TYPE[type] ?? type) : null,
    status ? (STATUS_WORDS[status] ?? status) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
