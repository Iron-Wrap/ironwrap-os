import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, CheckCircle2, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import {
  loadProductionRunway,
  newProductionScheduleKey,
  scheduleProductionJob,
} from "./production-api";
import type { OperatingJobAssignmentInput } from "./production-contracts";

export function ProductionScheduleApprovalPreparePage() {
  return (
    <RoleGuard surface="production">
      <ProductionScheduleApprovalPrepareContent />
    </RoleGuard>
  );
}

function ProductionScheduleApprovalPrepareContent() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const session = useSession();
  const offline = isOfflineSession(session);
  const query = useQuery({
    queryKey: ["production-runway", session.tenant.id, session.user.id],
    queryFn: () => loadProductionRunway(),
    retry: false,
  });
  const job = query.data?.jobs.find((candidate) => candidate.id === jobId);
  const scheduleKey = useRef<string | undefined>(undefined);
  const [crewId, setCrewId] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [actionError, setActionError] = useState<string>();

  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: OperatingJobAssignmentInput) => {
      scheduleKey.current ??= newProductionScheduleKey();
      return await scheduleProductionJob(session, input, scheduleKey.current);
    },
    onSuccess: () => {
      setActionError(undefined);
      void query.refetch();
    },
    onError: (error) => setActionError(messageFor(error)),
  });

  if (!jobId) {
    return (
      <ErrorState
        title="This scheduling request link is incomplete"
        message="No job record was provided. Return to the production runway and choose an eligible job."
      />
    );
  }
  if (!query.data && query.isPending) return <LoadingState label="Loading production schedule…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Production schedule unavailable"
        message="No schedule was recorded. Reconnect and re-open the current production runway before trying again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading production schedule…" />;

  const model = query.data;
  const canPrepare = model.allowed_actions.includes("operating_job_assignment.create");
  if (!job || !job.scheduling_preparation_allowed || !canPrepare) {
    return (
      <ErrorState
        title="Scheduling is not available"
        message="IronWrap OS did not grant the native scheduling command for this job in the current production read. Return to the runway and refresh before trying again."
        action={
          <Button asChild variant="outline">
            <Link to="/production">Back to production runway</Link>
          </Button>
        }
      />
    );
  }
  const selectedJob = job;

  const crews = model.crews;
  if (crews.length === 0) {
    return (
      <ErrorState
        title="No active crew profile is available"
        message="IronWrap OS did not return a bounded active crew list, so this schedule cannot be recorded. Refresh the production runway after the crew source is corrected."
        action={
          <Button asChild variant="outline">
            <Link to="/production">Back to production runway</Link>
          </Button>
        }
      />
    );
  }
  const selectedCrewId = crewId || job.assignment?.crew_id || "";
  const selectedCrew = crews.find((crew) => crew.id === selectedCrewId);
  const hasSupersede = job.assignment !== null;
  const trimmedCorrectionReason = correctionReason.trim();
  const requestPrepared = mutation.isSuccess;
  const submitDisabled =
    offline ||
    requestPrepared ||
    mutation.isPending ||
    !selectedCrew ||
    !scheduledStart ||
    (hasSupersede && !trimmedCorrectionReason);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) return;

    const start = dateTimeLocalToIso(scheduledStart);
    const end = scheduledEnd ? dateTimeLocalToIso(scheduledEnd) : null;
    if (!start) {
      setActionError("Enter a valid scheduled start before recording this schedule.");
      return;
    }
    if (scheduledEnd && !end) {
      setActionError("Enter a valid scheduled end or leave it blank.");
      return;
    }
    if (end && Date.parse(end) <= Date.parse(start)) {
      setActionError("Scheduled end must be after the scheduled start.");
      return;
    }

    setActionError(undefined);
    mutation.mutate({
      roofJobId: selectedJob.id,
      expectedRoofJobVersion: selectedJob.version,
      crewId: selectedCrew.id,
      expectedCrewVersion: selectedCrew.version,
      scheduledStart: start,
      scheduledEnd: end,
      supersedesAssignmentId: selectedJob.assignment?.id ?? null,
      correctionReason: hasSupersede ? trimmedCorrectionReason : null,
    });
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="overflow-hidden rounded-xl border border-border bg-surface lg:grid lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="p-5 sm:p-7">
          <Button asChild variant="ghost" size="compact" className="-ml-2">
            <Link to="/production">
              <ArrowLeft aria-hidden="true" />
              Back to production runway
            </Link>
          </Button>
          <div className="mt-5 flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
              <CalendarClock className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-3xl font-black tracking-[-0.04em] text-balance sm:text-4xl">
                Schedule production job
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                Set the crew and install window. IronWrap rechecks the current job, roster, and
                production gates before it records anything.
              </p>
            </div>
          </div>
        </div>

        <aside className="border-t border-border bg-surface-muted/55 p-5 lg:border-l lg:border-t-0 lg:p-7">
          <p className="text-sm font-bold text-muted">Current job</p>
          <h2 className="mt-2 text-2xl font-black tracking-[-0.03em]">
            {job.job_number ?? job.id}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {[job.brand, job.service_type, job.status].filter(Boolean).join(" · ") ||
              "Current production job"}
          </p>
          <div className="mt-5 border-t border-border pt-5">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
              <div>
                <p className="font-bold">Atomic authority check</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  All {job.gate_summary.expected} production gates and the chosen crew are rechecked
                  together.
                </p>
              </div>
            </div>
          </div>
        </aside>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect to record this schedule">
          Scheduling is not queued offline. Re-open this job when the current production read is
          available.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Schedule was not recorded">
          {actionError}
        </Notice>
      ) : null}
      {requestPrepared ? (
        <Notice tone="success" title="Schedule recorded">
          The native assignment is append-only. IronWrap OS will show the recorded crew and time on
          the refreshed production runway.
        </Notice>
      ) : null}

      <form
        className="overflow-hidden rounded-xl border border-border bg-surface"
        onSubmit={submit}
      >
        <div className="flex flex-col gap-3 border-b border-border px-5 py-5 sm:flex-row sm:items-end sm:justify-between sm:px-6">
          <div>
            <h2 className="text-xl font-black tracking-[-0.025em]">Crew and timing</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Choose one active crew and the exact local install window.
            </p>
          </div>
          <span className="w-fit rounded-md border border-border bg-surface-muted px-2.5 py-1.5 text-xs font-bold text-muted">
            {hasSupersede ? "Schedule correction" : "New assignment"}
          </span>
        </div>

        <div className="grid gap-6 p-5 sm:grid-cols-2 sm:p-6 lg:p-7">
          <div className="sm:col-span-2">
            <label htmlFor="schedule-crew-profile" className="text-sm font-bold text-foreground">
              Crew
            </label>
            <Select
              id="schedule-crew-profile"
              value={selectedCrewId}
              onChange={(event) => setCrewId(event.target.value)}
              disabled={offline || requestPrepared || mutation.isPending}
              required
              field
              className="mt-3"
            >
              <option value="">Choose an active crew</option>
              {crews.map((crew) => (
                <option key={crew.id} value={crew.id}>
                  {crew.name} · v{crew.version}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="schedule-start" className="text-sm font-bold text-foreground">
              Scheduled start
            </label>
            <Input
              id="schedule-start"
              type="datetime-local"
              value={scheduledStart}
              onChange={(event) => setScheduledStart(event.target.value)}
              disabled={offline || requestPrepared || mutation.isPending}
              required
              className="mt-3"
            />
            <p className="mt-2 text-xs leading-5 text-muted">Uses this device’s local time.</p>
          </div>

          <div>
            <label htmlFor="schedule-end" className="text-sm font-bold text-foreground">
              Scheduled end (optional)
            </label>
            <Input
              id="schedule-end"
              type="datetime-local"
              value={scheduledEnd}
              onChange={(event) => setScheduledEnd(event.target.value)}
              disabled={offline || requestPrepared || mutation.isPending}
              className="mt-3"
            />
            <p className="mt-2 text-xs leading-5 text-muted">If set, it must follow the start.</p>
          </div>

          {hasSupersede ? (
            <div className="sm:col-span-2">
              <label
                htmlFor="schedule-correction-reason"
                className="text-sm font-bold text-foreground"
              >
                Correction reason
              </label>
              <textarea
                id="schedule-correction-reason"
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value.slice(0, 1_200))}
                disabled={offline || requestPrepared || mutation.isPending}
                required
                maxLength={1_200}
                rows={4}
                placeholder="For example: Weather moved the install window."
                className="mt-3 w-full resize-y rounded-md border bg-surface-raised px-4 py-3 text-base leading-6 transition-[border-color,box-shadow,background-color] placeholder:text-muted/75 hover:border-border-strong focus-visible:border-focus focus-visible:outline-focus focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_15%,transparent)] disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-55"
              />
              <p className="mt-2 text-xs leading-5 text-muted">
                Replaces {job.assignment?.id} with a new append-only version.{" "}
                {correctionReason.length}/1200
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-7">
          <p className="max-w-xl text-sm leading-6 text-muted">
            Records the selected crew and time only. It does not release a Work Package or send a
            customer or crew message.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={submitDisabled}
          >
            <CalendarClock aria-hidden="true" />
            Record schedule
          </Button>
        </div>
      </form>

      {requestPrepared ? (
        <Button asChild variant="outline">
          <Link to="/production">
            <CheckCircle2 aria-hidden="true" />
            Return to production runway
          </Link>
        </Button>
      ) : null}
    </section>
  );
}

function dateTimeLocalToIso(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "The schedule could not be recorded. Re-open the current production read before trying again.";
}
