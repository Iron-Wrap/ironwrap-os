/**
 * The owner's items for a work stop that names a job or a job plan that doesn't exist (A3 kind
 * `stop_job_unknown`, A4 kind `stop_work_package_unknown`; Product UI frames N1 1527:582 and N1b
 * 1597:737). The title and the why come from the Worker in Track B's final copy; these are the
 * lines around them.
 *
 * PROVISIONAL, like every gate-train string, pending the rework lead's fix pass. The frames name
 * the job the stop meant and IronWrap support's phone and email; no read carries either, so these
 * lines leave them out.
 */
export const ownerStopCopy = {
  workStop: "Work stop",
  raisedBy: "Raised by",
  raisedByLine: (name: string | null, stamp: string | null) =>
    [name ?? "Name not on record", stamp]
      .filter((part): part is string => Boolean(part))
      .join(" · "),
  theyWrote: "They wrote",
  quoted: (summary: string) => `“${summary}”`,
  notInAppJob:
    "Releasing it, or raising it again on the right job, isn’t in the app yet. Clearing it needs IronWrap support.",
  notInAppPlan:
    "Releasing it, or raising it again on the right job plan, isn’t in the app yet. Clearing it needs IronWrap support.",
  stateLabel: "Work stopped",
} as const;
