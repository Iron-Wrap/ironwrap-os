import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, CheckCircle2, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
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
  const [supersedesAssignmentId, setSupersedesAssignmentId] = useState<string>();
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
        title="This scheduling request link is incomplete"
        message="No job record was provided. Return to the production runway and choose an eligible job."
      />
    );
  }
  if (!query.data && query.isPending)
    return <LoadingState label="Loading production schedule review…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Production review unavailable"
        message="No scheduling request was created. Reconnect and re-open the current production runway before preparing a decision."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading production schedule review…" />;

  const model = query.data;
  const canPrepare = model.allowed_actions.includes("production_schedule_approval.prepare");
  if (!job || !job.scheduling_preparation_allowed || !canPrepare) {
    return (
      <ErrorState
        title="Scheduling request is not available"
        message="IronWrap OS did not grant a safe scheduling request for this job in the current production read. Return to the runway and refresh before deciding."
        action={
          <Button asChild variant="outline">
            <Link to="/production">Back to production runway</Link>
          </Button>
        }
      />
    );
  }

  const crews = model.crews;
  if (crews.length === 0) {
    return (
      <ErrorState
        title="No active crew profile is available"
        message="IronWrap OS did not return a bounded active crew profile list, so this schedule request cannot be prepared. Refresh the production runway after the crew source is corrected."
        action={
          <Button asChild variant="outline">
            <Link to="/production">Back to production runway</Link>
          </Button>
        }
      />
    );
  }
  const roofJobId = job.id;
  const selectedSupersedesAssignmentId = supersedesAssignmentId ?? job.assignment?.id ?? "";
  const hasSupersede = selectedSupersedesAssignmentId.trim().length > 0;
  const trimmedCrewProfileId = crewProfileId.trim();
  const trimmedCorrectionReason = correctionReason.trim();
  const requestPrepared = mutation.isSuccess;
  const submitDisabled =
    offline ||
    requestPrepared ||
    mutation.isPending ||
    !trimmedCrewProfileId ||
    !scheduledStart ||
    (hasSupersede && !trimmedCorrectionReason);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitDisabled) return;

    const start = dateTimeLocalToIso(scheduledStart);
    const end = scheduledEnd ? dateTimeLocalToIso(scheduledEnd) : null;
    if (!start) {
      setActionError("Enter a valid scheduled start before preparing this request.");
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
      roofJobId,
      crewProfileId: trimmedCrewProfileId,
      scheduledStart: start,
      scheduledEnd: end,
      supersedesAssignmentId: hasSupersede ? selectedSupersedesAssignmentId.trim() : null,
      correctionReason: hasSupersede ? trimmedCorrectionReason : null,
    });
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <Button asChild variant="ghost" size="compact" className="-ml-2">
          <Link to="/production">
            <ArrowLeft aria-hidden="true" />
            Back to production runway
          </Link>
        </Button>
        <div className="mt-4 flex min-w-0 items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
            <CalendarClock className="size-5 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              Owner request
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
              Prepare production schedule
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Stage a schedule request for owner approval. This does not schedule a crew, dispatch a
              job, or notify anyone yet.
            </p>
          </div>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect to prepare this request">
          Scheduling requests are not queued offline. Re-open this job when the current production
          read is available.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Schedule request was not prepared">
          {actionError}
        </Notice>
      ) : null}
      {requestPrepared ? (
        <Notice tone="success" title="Schedule request is staged for owner approval">
          No crew assignment has been recorded. A designated owner must approve the current request
          before the append-only assignment can be created.
        </Notice>
      ) : null}

      <aside
        className="border border-info/35 bg-info-soft px-4 py-4"
        aria-label="Scheduling boundary"
      >
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
          <div>
            <h2 className="font-bold tracking-[-0.01em]">Decision before assignment</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              The request keeps its job, crew, time, and any correction visible for owner review.
              The production gates are checked again before an assignment is recorded.
            </p>
          </div>
        </div>
      </aside>

      <form className="border border-border bg-surface" onSubmit={submit}>
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">{job.job_number ?? job.id}</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {[job.brand, job.service_type, job.status].filter(Boolean).join(" · ") ||
              "Current production job"}
          </p>
        </div>

        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          <div className="sm:col-span-2">
            <label htmlFor="schedule-crew-profile" className="text-sm font-bold text-foreground">
              Crew profile
            </label>
            <select
              id="schedule-crew-profile"
              value={crewProfileId}
              onChange={(event) => setCrewProfileId(event.target.value)}
              disabled={offline || requestPrepared || mutation.isPending}
              required
              className="mt-3 min-h-16 w-full rounded-lg border bg-surface-raised px-4 text-base shadow-inner shadow-black/3 outline-none focus:border-info focus:outline-info disabled:cursor-not-allowed disabled:opacity-55"
            >
              <option value="">Choose an active crew profile</option>
              {crews.map((crew) => (
                <option key={crew.id} value={crew.id}>
                  {crew.name}
                </option>
              ))}
            </select>
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

          <div className="sm:col-span-2">
            <label htmlFor="schedule-supersedes" className="text-sm font-bold text-foreground">
              Supersede assignment (optional)
            </label>
            <Input
              id="schedule-supersedes"
              value={selectedSupersedesAssignmentId}
              onChange={(event) => {
                setSupersedesAssignmentId(event.target.value);
                if (!event.target.value.trim()) setCorrectionReason("");
              }}
              disabled={offline || requestPrepared || mutation.isPending}
              autoComplete="off"
              placeholder="Existing assignment ID"
              className="mt-3"
            />
            <p className="mt-2 text-sm leading-6 text-muted">
              Existing assignments are corrected by a new append-only assignment; this request does
              not edit the old one.
            </p>
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
                onChange={(event) => setCorrectionReason(event.target.value.slice(0, 2_000))}
                disabled={offline || requestPrepared || mutation.isPending}
                required
                maxLength={2_000}
                rows={4}
                placeholder="For example: Weather moved the install window."
                className="mt-3 w-full resize-y rounded-lg border bg-surface-raised px-4 py-3 text-base leading-6 shadow-sm outline-none transition-colors placeholder:text-muted focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
              />
              <p className="mt-2 text-xs leading-5 text-muted">
                Required when replacing an existing assignment. {correctionReason.length}/2000
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            This submits only the selected crew, proposed time, and any correction. It remains a
            request until a designated owner approves it.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={submitDisabled}
          >
            <CalendarClock aria-hidden="true" />
            Prepare owner review
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

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger" | "success";
  title: string;
  children: ReactNode;
}) {
  const toneClasses = {
    warning: "border-warning/35 bg-warning-soft",
    danger: "border-danger/35 bg-danger-soft",
    success: "border-ok/35 bg-ok-soft",
  }[tone];
  return (
    <section
      className={`border px-4 py-4 ${toneClasses}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm leading-6 text-muted">{children}</p>
    </section>
  );
}

function dateTimeLocalToIso(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "The request could not be prepared. Re-open the current production read before trying again.";
}
