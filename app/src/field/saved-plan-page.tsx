import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { SystemDetails } from "../components/ui/system-details";
import { messageForLoad } from "../lib/plain-error";
import { formatFieldTimestamp } from "./field-formatting";
import { loadSavedPlan } from "./saved-plan";
import { savedPlanTargetKey, type SavedPlanTarget } from "./saved-plan-context";
import { useSavedPlanReadContext } from "./saved-plan-read-context";

/** An actual, read-only destination: no lifecycle component, acknowledgement, outbox or marker. */
export function SavedPlanPage() {
  const session = useSession();
  const context = useSavedPlanReadContext(session);
  const params = useParams({ strict: false }) as {
    jobId?: string;
    workObjectType?: string;
    workObjectId?: string;
    physicalContextType?: string;
    physicalContextId?: string;
  };
  const target: SavedPlanTarget | null = params.jobId
    ? { kind: "job", jobId: params.jobId }
    : params.workObjectType &&
        params.workObjectId &&
        params.physicalContextType &&
        params.physicalContextId
      ? {
          kind: "work-object",
          scope: {
            workObjectType: params.workObjectType,
            workObjectId: params.workObjectId,
            physicalContextType: params.physicalContextType,
            physicalContextId: params.physicalContextId,
          },
        }
      : null;
  const query = useQuery({
    queryKey: [
      "saved-plan",
      session.tenant.id,
      session.user.id,
      context.id,
      target ? savedPlanTargetKey(target) : "missing",
    ],
    enabled: target !== null && !context.blocked,
    queryFn: () =>
      loadSavedPlan(session, target!, undefined, context.isCurrent, context.observation),
    // A first visit without signal must run the IndexedDB fallback instead of pausing this read.
    networkMode: "always",
    retry: false,
  });
  const back = (
    <Button asChild variant="ghost" size="compact">
      <Link to="/today">
        <ChevronLeft aria-hidden="true" />
        Today
      </Link>
    </Button>
  );
  if (!target) return <ErrorState message="This work-plan link is incomplete." />;
  if (context.blocked)
    return (
      <section className="mx-auto max-w-5xl space-y-5">
        {back}
        <ErrorState
          title="Plan unavailable"
          message="Your sign-in or paired device changed or expired. Keep work stopped. Go online and reload to verify the current work list and plan."
          onRetry={() => window.location.reload()}
        />
      </section>
    );
  if (query.isPending) return <LoadingState label="Opening work and safety plan…" />;
  if (query.isError) {
    return (
      <section className="mx-auto max-w-5xl space-y-5">
        {back}
        <ErrorState
          title="Plan unavailable"
          message={messageForLoad(query.error, {
            byCode: {
              saved_plan_unavailable:
                "A complete plan for this work could not be verified on this phone. Keep work stopped. Go online and ask the office for the current work and safety plan.",
              saved_plan_context_changed:
                "Your sign-in or paired device changed or expired. Keep work stopped. Go online and reload to verify the current work list and plan.",
              offline_packet_unavailable:
                "This phone has no saved plan for this work. Keep work stopped. Go online and ask the office for the current work and safety plan.",
            },
          })}
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </section>
    );
  }
  const { model, plan, offline, saved } = query.data;
  const dateOptions = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const stamp = (value: string) => formatFieldTimestamp(value, dateOptions);
  const job = "job" in model ? model.job : null;
  const safety = "job" in model ? model.packet.safety_plan : null;
  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-8">
      {back}
      <header className="space-y-3 border-b border-border pb-5">
        <p className="text-sm font-semibold text-muted">
          {offline
            ? "Saved copy"
            : saved
              ? "Current copy saved on this phone"
              : "Current copy · not saved on this phone"}
        </p>
        <h1 className="text-3xl font-bold tracking-[-0.03em]">{plan.title}</h1>
        <p className="font-bold">Work and safety instructions</p>
        <p className="text-sm leading-6 text-muted">
          {job
            ? `${job.job_number ?? job.id} · ${job.address ?? "Address unavailable"}`
            : `${plan.work_object_type} · ${plan.work_object_id} · ${plan.physical_context_type} · ${plan.physical_context_id}`}
        </p>
        <p className="text-sm leading-6 text-muted">
          Copy received {stamp(model.read_model_generated_at)}
        </p>
        <SystemDetails>
          <div className="space-y-2 text-sm">
            <p>
              Version {plan.version} · {plan.status}
            </p>
            <p>Work plan reference {plan.id}</p>
            {plan.supersession ? <p>Replaces plan reference {plan.supersession.prior_id}</p> : null}
          </div>
        </SystemDetails>
      </header>
      <div className="space-y-2 border-2 border-warning/45 bg-warning-soft p-4" role="status">
        {offline ? (
          <p className="font-bold">
            This saved plan may be old. Go online to check for a newer version before starting.
          </p>
        ) : null}
        {!saved ? (
          <p className="font-bold">
            This copy is not saved for offline use. Keep signal and try opening it again.
          </p>
        ) : null}
        <p className="font-bold leading-6">
          Reading this plan does not record a review or give permission to start. The office must
          release every applicable stop, and all open work checks must also be cleared.
        </p>
      </div>
      <dl className="grid gap-4 border border-border bg-surface-raised p-4 sm:grid-cols-2">
        <PlanFact label="Issued" value={stamp(plan.issued_at)} />
        <PlanFact label="Plan released" value={stamp(plan.released_at)} />
        <PlanFact label="Plan expires" value={stamp(plan.expires_at)} />
        <PlanFact label="Goal" value={plan.objective} />
        <PlanFact label="Limits" value={plan.boundaries} />
        <PlanFact label="Before you start" value={plan.prerequisites} />
        <PlanFact label="Done looks like" value={plan.expected_result} />
      </dl>
      {plan.supersession ? (
        <section
          className="space-y-2 border border-warning/45 bg-warning-soft p-4"
          aria-labelledby="saved-plan-changes"
        >
          <h2 id="saved-plan-changes" className="text-xl font-bold">
            Plan changed
          </h2>
          <p>This plan replaces an earlier plan. {plan.supersession.reason}</p>
          <p className="text-sm">
            Changed steps: {plan.supersession.changed_steps.join(", ") || "none"} · Changed checks:{" "}
            {plan.supersession.changed_hold_points.join(", ") || "none"}
          </p>
        </section>
      ) : null}
      <section aria-labelledby="saved-plan-steps" className="space-y-3">
        <h2 id="saved-plan-steps" className="text-2xl font-bold">
          Work steps
        </h2>
        <ol className="space-y-3">
          {plan.steps.map((step) => (
            <li
              key={step.sequence}
              className="space-y-2 border border-border bg-surface-raised p-4"
            >
              <h3 className="font-bold">
                Step {step.sequence} · {step.instruction}
              </h3>
              <p className="text-sm leading-6">Proof: {step.required_evidence}</p>
              <p className="text-sm leading-6">Pass when: {step.acceptance_criteria}</p>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="saved-plan-safety" className="space-y-3">
        <h2 id="saved-plan-safety" className="text-2xl font-bold">
          Safety instructions in this work plan
        </h2>
        <dl className="grid gap-4 border border-border bg-surface-raised p-4 sm:grid-cols-2">
          <PlanFact label="When to stop" value={plan.stop_conditions} />
          <PlanFact label="Make it safe" value={plan.make_safe_procedure} />
        </dl>
        {job ? (
          safety ? (
            <div className="space-y-3 border border-border p-4">
              <h3 className="font-bold">Site safety plan</h3>
              <SystemDetails>
                <p>
                  Version {safety.version ?? "unavailable"} ·{" "}
                  {safety.status ?? "Status unavailable"}
                </p>
              </SystemDetails>
              <dl className="grid gap-4 sm:grid-cols-2">
                <PlanFact label="Hazards" value={safety.hazard_summary} />
                <PlanFact label="Controls" value={safety.controls} />
                <PlanFact label="PPE" value={safety.ppe_requirements} />
                <PlanFact label="Weather limits" value={safety.weather_limits} />
                <PlanFact label="Emergency plan" value={safety.emergency_plan} />
              </dl>
            </div>
          ) : (
            <p className="border border-warning/45 bg-warning-soft p-4 font-bold leading-6">
              A separate site safety plan is unavailable in this packet. Keep work stopped and ask
              the office for the required safety information.
            </p>
          )
        ) : null}
      </section>
      <section aria-labelledby="saved-plan-holds" className="space-y-3">
        <h2 id="saved-plan-holds" className="text-2xl font-bold">
          Stop and check
        </h2>
        {plan.hold_points.length === 0 ? (
          <p>
            No hold points are listed in this plan. Independent work and safety checks still apply.
          </p>
        ) : (
          <ol className="space-y-3">
            {plan.hold_points.map((hold) => (
              <li
                key={hold.sequence}
                className="space-y-2 border border-border bg-surface-raised p-4"
              >
                <h3 className="font-bold">
                  Check {hold.sequence} · {hold.hold_point}
                </h3>
                <p>
                  {hold.released
                    ? "This copy records this check as cleared. Other stops and checks still apply."
                    : `This check is open. Release authority: ${hold.release_authority}.`}
                </p>
                <p className="text-sm leading-6">
                  When: {hold.release_phase} · Proof: {hold.required_evidence}
                </p>
                <p className="text-sm leading-6">Pass when: {hold.acceptance_criteria}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function PlanFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-muted">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap leading-6">
        {value || "Unavailable. Ask the office before starting."}
      </dd>
    </div>
  );
}
