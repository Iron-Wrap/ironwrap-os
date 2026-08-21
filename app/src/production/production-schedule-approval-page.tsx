import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, CheckCircle2, ChevronRight, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
import { ApiError } from "../lib/api";
import { loadProductionRunway } from "./production-api";
import {
  newProductionScheduleApprovalPrepareKey,
  prepareProductionScheduleApproval,
} from "./production-schedule-approval-api";
import type { ProductionScheduleApprovalPreparationInput } from "./production-schedule-approval-contracts";

export function ProductionScheduleApprovalPreparePage() {
  return (
    <RoleGuard surface="owner">
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
  const prepareKey = useRef<string | undefined>(undefined);
  const [crewProfileId, setCrewProfileId] = useState("");
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [actionError, setActionError] = useState<string>();

  const mutation = useMutation({
    retry: false,
    mutationFn: async (input: ProductionScheduleApprovalPreparationInput) => {
      prepareKey.current ??= newProductionScheduleApprovalPrepareKey();
      return await prepareProductionScheduleApproval(session, input, prepareKey.current);
    },
    onSuccess: () => setActionError(undefined),
    onError: (error) => setActionError(messageFor(error)),
  });

  if (!jobId) {
    return (
      <ErrorState
        title="This start-date link is not complete"
        message="No job was found in this link. Go back to the production plan and choose a job."
      />
    );
  }
  if (!query.data && query.isPending) return <PrepareSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="The job list could not load"
        message="Nothing was saved. Go online, then open the production plan again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <PrepareSkeleton />;

  const model = query.data;
  const canPrepare = model.allowed_actions.includes("production_schedule_approval.prepare");
  if (!job || !job.scheduling_preparation_allowed || !canPrepare) {
    return (
      <ErrorState
        title="This job is not ready for a start date"
        message="IronWrap did not allow a start date for this job. Go back to the production plan and check it."
        action={
          <Button asChild variant="outline">
            <Link to="/production">Back to the production plan</Link>
          </Button>
        }
      />
    );
  }

  const crews = model.crews;
  if (crews.length === 0) {
    return (
      <ErrorState
        title="No crew is ready"
        message="No active crew was found, so a start date cannot be asked for. Go back after crews are set."
        action={
          <Button asChild variant="outline">
            <Link to="/production">Back to the production plan</Link>
          </Button>
        }
      />
    );
  }
  const roofJobId = job.id;
  const currentAssignmentId = job.assignment?.id?.trim() ?? "";
  const replacingSavedStart = currentAssignmentId.length > 0;
  const trimmedCrewProfileId = crewProfileId.trim();
  const trimmedCorrectionReason = correctionReason.trim();
  const requestPrepared = mutation.isSuccess;
  const submitDisabled =
    offline ||
    requestPrepared ||
    mutation.isPending ||
    !trimmedCrewProfileId ||
    !scheduledStart ||
    (replacingSavedStart && !trimmedCorrectionReason);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) return;

    const start = dateTimeLocalToIso(scheduledStart);
    const end = scheduledEnd ? dateTimeLocalToIso(scheduledEnd) : null;
    if (!start) {
      setActionError("Enter a start time before you send this.");
      return;
    }
    if (scheduledEnd && !end) {
      setActionError("Enter a valid end time or leave it blank.");
      return;
    }
    if (end && Date.parse(end) <= Date.parse(start)) {
      setActionError("The end time must be after the start time.");
      return;
    }

    setActionError(undefined);
    mutation.mutate({
      roofJobId,
      crewProfileId: trimmedCrewProfileId,
      scheduledStart: start,
      scheduledEnd: end,
      supersedesAssignmentId: replacingSavedStart ? currentAssignmentId : null,
      correctionReason: replacingSavedStart ? trimmedCorrectionReason : null,
    });
  }

  const jobLabel = job.job_number ?? "This job";
  const jobFacts =
    [job.brand, job.service_type, job.status].filter(Boolean).join(" · ") || "Current job";

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/production">
                <ArrowLeft aria-hidden="true" />
                Back to the production plan
              </Link>
            </Button>
            <div className="mt-5 flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <CalendarClock className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                  Start date
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Ask to set a start date
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Choose a crew and a start time. This does not send a crew or change the job yet.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
              Next step
            </p>
            <h2 className="mt-2 text-xl font-black tracking-[-0.025em]">A person still says yes</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              A manager must approve this before the start date is saved.
            </p>
          </div>
        </header>
      </Card>

      {offline ? (
        <Notice tone="warning" title="Go online to send this request">
          Start dates are not saved while you are offline. Open this job again when you are online.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The start date was not sent">
          {actionError}
        </Notice>
      ) : null}
      {requestPrepared ? (
        <Notice tone="success" title="The start date is ready for a check">
          No crew was sent. A manager must say yes before the start date is saved.
        </Notice>
      ) : null}

      <aside
        className="overflow-hidden rounded-lg border border-info/35 bg-info-soft px-4 py-4 sm:px-5"
        aria-label="What this ask does"
      >
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
          <div>
            <h2 className="font-bold tracking-[-0.01em]">Check before you save</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              The job, crew, and time stay visible for a manager. Start steps are checked again
              before the start date is saved.
            </p>
          </div>
        </div>
      </aside>

      <form
        className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
        onSubmit={submit}
      >
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">{jobLabel}</h2>
          <p className="mt-1 text-sm leading-6 text-muted">{jobFacts}</p>
        </div>

        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          <div className="sm:col-span-2">
            <label htmlFor="schedule-crew-profile" className="text-sm font-bold text-foreground">
              Crew
            </label>
            <Select
              field
              id="schedule-crew-profile"
              value={crewProfileId}
              onChange={(event) => setCrewProfileId(event.target.value)}
              disabled={offline || requestPrepared || mutation.isPending}
              required
              className="mt-3"
            >
              <option value="">Choose a crew</option>
              {crews.map((crew) => (
                <option key={crew.id} value={crew.id}>
                  {crew.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="schedule-start" className="text-sm font-bold text-foreground">
              Start time
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
            <p className="mt-2 text-xs leading-5 text-muted">Uses this phone's time.</p>
          </div>

          <div>
            <label htmlFor="schedule-end" className="text-sm font-bold text-foreground">
              End time (optional)
            </label>
            <Input
              id="schedule-end"
              type="datetime-local"
              value={scheduledEnd}
              onChange={(event) => setScheduledEnd(event.target.value)}
              disabled={offline || requestPrepared || mutation.isPending}
              className="mt-3"
            />
            <p className="mt-2 text-xs leading-5 text-muted">
              If you set an end, it must be after the start.
            </p>
          </div>

          {replacingSavedStart ? (
            <div className="sm:col-span-2">
              <label
                htmlFor="schedule-correction-reason"
                className="text-sm font-bold text-foreground"
              >
                Why replace the saved start date?
              </label>
              <p className="mt-2 text-sm leading-6 text-muted">
                This job already has a start date. The old date stays on the record. This ask adds a
                new one after a manager says yes.
              </p>
              <Textarea
                id="schedule-correction-reason"
                value={correctionReason}
                onChange={(event) => setCorrectionReason(event.target.value.slice(0, 2_000))}
                disabled={offline || requestPrepared || mutation.isPending}
                required
                maxLength={2_000}
                rows={4}
                placeholder="For example: Weather moved the install window."
                className="mt-3"
              />
              <p className="mt-2 text-xs leading-5 text-muted">
                Required when replacing a saved start date. {correctionReason.length}/2000
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            This sends only the crew, start time, and any reason. It stays a request until a manager
            says yes.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={submitDisabled}
          >
            <CalendarClock aria-hidden="true" />
            Send for a check
          </Button>
        </div>
      </form>

      <details className="group rounded-lg border border-border bg-surface-raised">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-bold sm:min-h-14 sm:px-5 [&::-webkit-details-marker]:hidden">
          <span>System details</span>
          <ChevronRight
            className="size-4 text-muted transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <dl className="grid gap-3 border-t border-border px-4 py-3 text-sm text-muted sm:grid-cols-2 sm:px-5">
          <MetadataLine label="Job ID" value={job.id} />
          <MetadataLine label="Job state" value={job.status ?? "Not found"} />
          <MetadataLine label="Saved crew record" value={job.assignment?.id ?? "Not found"} />
          <MetadataLine label="Crew state" value={job.assignment?.status ?? "Not found"} />
        </dl>
      </details>

      {requestPrepared ? (
        <Button asChild variant="outline">
          <Link to="/production">
            <CheckCircle2 aria-hidden="true" />
            Back to the production plan
          </Link>
        </Button>
      ) : null}
    </section>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{value}</dd>
    </div>
  );
}

function PrepareSkeleton() {
  return (
    <section className="mx-auto max-w-6xl space-y-6" aria-busy="true" aria-label="Loading this job">
      <div className="h-40 rounded-lg border border-border bg-surface-muted/70" />
      <div className="grid min-h-28 rounded-lg border border-border bg-surface-muted/55 sm:grid-cols-2" />
      <div className="min-h-72 rounded-lg border border-border bg-surface-muted/55" />
      <LoadingState label="Loading this job" />
    </section>
  );
}

function dateTimeLocalToIso(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "We could not send this ask. Nothing was saved. Open the job again before you try.";
  }
  switch (error.code) {
    case "idempotency_conflict":
      return "This same ask was already sent with different details. Go back to the production plan and start again.";
    case "production_schedule_not_eligible":
      return "This job is not ready for a start date. Open the production plan and check it.";
    case "active_crew_profile_required":
      return "That crew is not on the active list. Choose a crew from this list.";
    case "production_schedule_supersede_required":
      return "This job already has a start date. Say why you are replacing it.";
    case "production_schedule_supersede_invalid":
      return "This job has no saved start date to replace. Clear the replace note and try again.";
    case "production_schedule_preparation_unavailable":
    case "production_schedule_approval_store_unavailable":
      return "We could not save this ask. Nothing was changed. Try again in a moment.";
    case "production_schedule_broker_not_configured":
    case "production_schedule_broker_unavailable":
    case "production_schedule_broker_response_invalid":
      return "IronWrap could not reach the schedule service. Nothing was saved.";
    case "invalid_production_schedule_approval_request":
      return "Check the crew, start time, and any replace note, then try again.";
    case "csrf_failed":
      return "Sign in again before you send this.";
    case "timeout":
      return "The connection took too long. Nothing was saved. Try again.";
    case "network_error":
      return "You are offline. Nothing was saved. Go online and try again.";
    default:
      return "We could not send this ask. Nothing was saved. Open the job again before you try.";
  }
}
