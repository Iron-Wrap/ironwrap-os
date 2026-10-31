import { Dialog } from "../components/ui/dialog";
import type { JobResponse } from "./field-contracts";
import { formatFieldStamp, type FieldDateOptions } from "./field-formatting";
import { jobPlanBadge, type StampClock } from "./job-plan-status";

/** A focused read of the same plan, with its complete proof requirements at the end. */
export function JobPlanDetailsDialog({
  open,
  onClose,
  plan,
  activeStops,
  dateOptions,
  clock,
  jobLabel,
}: {
  open: boolean;
  onClose: () => void;
  plan: NonNullable<JobResponse["packet"]["work_package"]>;
  activeStops: JobResponse["active_stops"];
  dateOptions: FieldDateOptions;
  clock: StampClock;
  jobLabel: string;
}) {
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Plan and proof"
      description={jobLabel}
      className="w-[min(64rem,calc(100vw-2rem))]"
    >
      <section className="space-y-5 pb-5 text-foreground">
        <div>
          <h3 className="text-2xl font-bold">{plan.title}</h3>
          <p className="mt-2 font-semibold">
            {jobPlanBadge(plan, activeStops, dateOptions, clock)}
          </p>
          <p className="mt-2 text-sm">
            Issued to the crew · {formatFieldStamp(plan.released_at, dateOptions, { clock })}
          </p>
          <p className="text-sm">
            Expires · {formatFieldStamp(plan.expires_at, dateOptions, { clock })}
          </p>
        </div>
        <dl className="grid gap-4 sm:grid-cols-2">
          {[
            ["Goal", plan.objective],
            ["Done looks like", plan.expected_result],
            ["Work scope", plan.boundaries],
            ["Before you start", plan.prerequisites],
            ["When to stop", plan.stop_conditions],
            ["Make it safe", plan.make_safe_procedure],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm font-semibold text-muted">{label}</dt>
              <dd className="mt-1">{value}</dd>
            </div>
          ))}
        </dl>
        <section aria-label="Plan steps">
          <h3 className="font-bold">Work steps</h3>
          <ol className="mt-2 space-y-3">
            {plan.steps.map((step) => (
              <li key={step.sequence} className="border border-border p-3">
                <p className="font-semibold">
                  Step {step.sequence} · {step.instruction}
                </p>
                <p className="mt-1 text-sm">Done when: {step.acceptance_criteria}</p>
              </li>
            ))}
          </ol>
        </section>
        <section aria-label="Crew reviews">
          <h3 className="font-bold">Crew reviews</h3>
          {plan.acknowledgement.workers.length ? (
            <ul className="mt-2 space-y-2">
              {plan.acknowledgement.workers.map((worker) => (
                <li
                  key={`${worker.worker_user}:${worker.worker_role}`}
                  className="[overflow-wrap:anywhere]"
                >
                  {worker.worker_user} ·{" "}
                  {worker.acknowledged ? "Reviewed" : "Has not reviewed this plan"}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2">The crew list is missing.</p>
          )}
        </section>
        <section aria-label="Complete proof requirements" className="border border-border p-4">
          <h3 className="font-bold">Proof needed</h3>
          <p className="mt-2 text-sm">
            The crew must add these photos or notes. Each item stays with this job plan.
          </p>
          <ul className="mt-3 space-y-3">
            {plan.steps.map((step) => (
              <li key={`step:${step.sequence}`}>
                <p className="font-semibold">
                  Step {step.sequence} · {step.required_evidence}
                </p>
                <p className="mt-1 text-sm">Done when: {step.acceptance_criteria}</p>
              </li>
            ))}
            {plan.hold_points.map((hold) => (
              <li key={`hold:${hold.sequence}`}>
                <p className="font-semibold">
                  Check {hold.sequence} · {hold.hold_point}
                </p>
                <p className="mt-1">Proof: {hold.required_evidence}</p>
                <p className="mt-1 text-sm">Pass when: {hold.acceptance_criteria}</p>
                <p className="mt-1 text-sm">
                  {hold.released
                    ? "The office cleared this check."
                    : `Waiting for ${hold.release_authority}. This check is separate from a crew stop.`}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </section>
    </Dialog>
  );
}
