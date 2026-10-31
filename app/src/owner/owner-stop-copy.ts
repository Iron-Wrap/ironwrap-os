/**
 * The owner's items for a work stop that names a job or a job plan that doesn't exist (A3 kind
 * `stop_job_unknown`, A4 kind `stop_work_package_unknown`; Product UI frames N1 1527:582 and N1b
 * 1597:737). The title and policy explanation come from the Worker; these surrounding lines
 * adapt the source-only held-frame records to the fields the owner read actually exposes.
 *
 * PROVISIONAL. Source-only held N1/N1b records supply the global-stop wording, with the actual
 * reporter from the read. The owner read proves this office record exists, not that a separate
 * notification was delivered. Missing reporter/reason stays explicit; no job or contact is invented.
 */
export const ownerStopCopy = {
  workStop: "Work stop",
  scopeReport: (name: string | null) =>
    `Work is stopped on every job. ${
      name?.trim() ? `${name.trim()} reported a stop` : "A stop was reported"
    }, and we couldn't tell which job it's for. The stop is recorded for the office.`,
  job: "Job",
  jobUnknown: "Couldn't tell which one",
  raisedBy: "Raised by",
  raisedByLine: (name: string | null, stamp: string | null) =>
    [name?.trim() || "Name not on record", stamp]
      .filter((part): part is string => Boolean(part))
      .join(" · "),
  reason: "Reason",
  reasonMissing: "Reason not on record",
  notInAppJob:
    "Releasing it, or raising it again on the right job, isn’t in the app yet. Clearing it needs IronWrap support.",
  notInAppPlan:
    "Releasing it, or raising it again on the right job plan, isn’t in the app yet. Clearing it needs IronWrap support.",
  stateLabel: "Work stopped",
} as const;
