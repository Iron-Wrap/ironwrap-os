import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, CircleDashed, PackageCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { useInitialToday, useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { cacheToday, hasCachedJobPacket, loadToday, prefetchAssignedPackets } from "./field-cache";
import { NOT_SAVED_ON_DEVICE, type TodayResponse } from "./field-contracts";
import {
  formatFieldDay,
  formatFieldSchedule,
  formatFieldTimestamp,
  plainFieldNames,
  type FieldDateOptions,
} from "./field-formatting";
import { messageForLoad } from "../lib/plain-error";
import { SavedWorkRecoveryPanel } from "./saved-work-recovery-panel";
import { OfflineReadiness } from "./offline-readiness";

// Office roles only (see the note where it renders). A static import made the crew phone fetch
// this chunk, in a round trip of its own, before its run sheet could render.
const OperatingIntakePanel = lazy(async () => ({
  default: (await import("../operating-intake/operating-intake-panel")).OperatingIntakePanel,
}));

type PacketAvailability = "checking" | "saving" | "saved" | "not_saved" | "unavailable";
type TodayJob = TodayResponse["jobs"][number];
type TodayWorkObject = TodayResponse["work_objects"][number];

export function TodayPage() {
  const session = useSession();
  const initialToday = useInitialToday();
  const queryClient = useQueryClient();
  const [packetAvailability, setPacketAvailability] = useState<Record<string, PacketAvailability>>(
    {},
  );
  const [packetRefreshCycle, setPacketRefreshCycle] = useState(0);
  const [bootstrapSaving, setBootstrapSaving] = useState(Boolean(initialToday));
  const query = useQuery({
    queryKey: ["today", session.tenant.id, session.user.id],
    queryFn: () => loadToday(session),
    ...(initialToday
      ? {
          initialData: initialToday,
          staleTime: 30_000,
        }
      : {}),
  });
  const today = query.data;

  useEffect(() => {
    if (!initialToday) return;
    let active = true;
    void cacheToday(session, initialToday)
      .catch(() => {
        queryClient.setQueryData<TodayResponse>(
          ["today", session.tenant.id, session.user.id],
          (current) =>
            current === initialToday
              ? {
                  ...current,
                  stale_fields: [...new Set([...current.stale_fields, NOT_SAVED_ON_DEVICE])],
                }
              : current,
        );
      })
      .finally(() => {
        if (active) setBootstrapSaving(false);
      });
    return () => {
      active = false;
    };
  }, [initialToday, queryClient, session]);

  useEffect(() => {
    const retryPacketPreparation = () => {
      if (navigator.onLine) setPacketRefreshCycle((cycle) => cycle + 1);
    };
    const retryWhenVisible = () => {
      if (document.visibilityState === "visible") retryPacketPreparation();
    };
    window.addEventListener("online", retryPacketPreparation);
    document.addEventListener("visibilitychange", retryWhenVisible);
    return () => {
      window.removeEventListener("online", retryPacketPreparation);
      document.removeEventListener("visibilitychange", retryWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!today) return;
    let active = true;
    const online = navigator.onLine;
    void (async () => {
      try {
        const cached = await Promise.all(
          today.jobs.map(
            async (job) => [job.id, await hasCachedJobPacket(session, job.id)] as const,
          ),
        );
        if (!active) return;
        setPacketAvailability((current) => ({
          ...current,
          ...Object.fromEntries(
            cached.map(([jobId, exists]) => [
              jobId,
              online ? "saving" : exists ? "saved" : "not_saved",
            ]),
          ),
        }));
        if (!online) return;
        await prefetchAssignedPackets(session, today, {
          concurrency: 3,
          onPacket(jobId, saved, model) {
            if (!active) return;
            setPacketAvailability((current) => ({
              ...current,
              [jobId]: saved ? "saved" : "not_saved",
            }));
            if (model)
              queryClient.setQueryData(["job", session.tenant.id, session.user.id, jobId], model);
          },
        });
      } catch {
        if (!active) return;
        setPacketAvailability((current) => ({
          ...current,
          ...Object.fromEntries(today.jobs.map((job) => [job.id, "unavailable"])),
        }));
      }
    })();
    return () => {
      active = false;
    };
  }, [packetRefreshCycle, queryClient, session, today]);

  if (query.isPending) return <LoadingState label="Loading assigned work…" />;
  if (query.isError) {
    return (
      <ErrorState
        message={messageForLoad(query.error)}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!today) return <LoadingState label="Loading assigned work…" />;
  const offline = today.stale_fields.includes("offline.cached_packet");
  const dateOptions = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const availabilityFor = (job: TodayJob): PacketAvailability =>
    packetAvailability[job.id] ?? "checking";
  const savedPacketCount = today.jobs.filter((job) => availabilityFor(job) === "saved").length;
  const hasCheckingPackets = today.jobs.some((job) => availabilityFor(job) === "checking");
  const hasSavingPackets = today.jobs.some((job) => availabilityFor(job) === "saving");
  const runSheetNotSaved = today.stale_fields.includes(NOT_SAVED_ON_DEVICE);
  const savingOffline =
    bootstrapSaving || query.isFetching || hasCheckingPackets || hasSavingPackets;
  const readyOffline = !runSheetNotSaved && savedPacketCount === today.jobs.length;
  const fieldCaptureAllowed =
    session.user.role === "field" && today.allowed_actions.includes("field.checkin.create");
  const dataLimits = today.stale_fields.filter((field) => field !== "offline.cached_packet");
  const assignmentCount = today.jobs.length + today.work_objects.length;

  return (
    <section className="mx-auto max-w-6xl space-y-5 pb-4">
      <TodayDispatchHeader
        date={today.date}
        jobCount={assignmentCount}
        offline={offline}
        generatedAt={today.read_model_generated_at}
        dateOptions={dateOptions}
      />
      <OfflineReadiness
        ready={readyOffline}
        saving={savingOffline}
        savedDetail={
          today.jobs.length > 0
            ? `This run sheet and ${savedPacketCount} job ${savedPacketCount === 1 ? "plan are" : "plans are"} saved on this phone. Open each plan and check its work and safety steps before you start.`
            : "This run sheet is saved on this phone."
        }
        missingDetail={
          runSheetNotSaved
            ? "This run sheet is not saved on this phone."
            : "Some job plans are not saved on this phone."
        }
        onRetry={() => {
          if (runSheetNotSaved) void query.refetch();
          else setPacketRefreshCycle((cycle) => cycle + 1);
        }}
      />
      {session.user.role === "field" ? <SavedWorkRecoveryPanel session={session} /> : null}
      {offline ? <OfflineScheduleNotice date={today.date} dateOptions={dateOptions} /> : null}
      {dataLimits.length > 0 ? <TodayDataLimits fields={dataLimits} /> : null}
      {assignmentCount === 0 ? (
        <EmptyState
          title={
            session.user.role === "field"
              ? "No jobs are on this phone today"
              : "No work is assigned today"
          }
          message={
            session.user.role === "field"
              ? "Do not leave for a site yet. Ask the office to check your work list."
              : "This list shows only the work you can open."
          }
        />
      ) : (
        <section aria-labelledby="today-run-sheet-heading">
          <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
            <div>
              <h2 id="today-run-sheet-heading" className="text-2xl font-bold tracking-[-0.035em]">
                Today's work
              </h2>
            </div>
            <p className="text-sm font-semibold text-muted">
              {assignmentCount} {assignmentCount === 1 ? "assignment" : "assignments"}
            </p>
          </header>
          <ol className="mt-4 space-y-3">
            {today.jobs.map((job) => (
              <TodayJobRow
                key={job.id}
                job={job}
                availability={availabilityFor(job)}
                dateOptions={dateOptions}
                fieldCaptureAllowed={fieldCaptureAllowed}
                canRetryPacket={navigator.onLine}
                onRetryPacket={() => setPacketRefreshCycle((cycle) => cycle + 1)}
              />
            ))}
          </ol>
          {today.work_objects.length > 0 ? (
            <>
              <h3 className="mt-8 border-b border-border pb-4 text-lg font-bold">Other work</h3>
              <ol className="divide-y divide-border">
                {today.work_objects.map((workObject) => (
                  <TodayWorkObjectRow
                    key={`${workObject.work_object_type}:${workObject.work_object_id}:${workObject.physical_context_type}:${workObject.physical_context_id}`}
                    workObject={workObject}
                    dateOptions={dateOptions}
                  />
                ))}
              </ol>
            </>
          ) : null}
        </section>
      )}
      {/* Website intake is office work and `/api/v1/operating-intake` refuses a field
          session outright. Worse than useless on a crew phone: the request carries no
          device proof, so the Worker answers 401 and expires the session cookie with it —
          the run sheet was signing the paired phone out on every visit and the next cold
          start showed "Pair this crew phone again" (ELEC-157). */}
      {session.user.role === "field" ? null : (
        <Suspense fallback={null}>
          <OperatingIntakePanel />
        </Suspense>
      )}
    </section>
  );
}

function TodayDispatchHeader({
  date,
  jobCount,
  offline,
  generatedAt,
  dateOptions,
}: {
  date: string;
  jobCount: number;
  offline: boolean;
  generatedAt: string;
  dateOptions: FieldDateOptions;
}) {
  return (
    <header className="border-b border-border pb-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold text-muted">Your work</p>
          <h1 className="mt-1 text-3xl font-bold tracking-[-0.045em] sm:text-4xl">Today</h1>
          <p className="mt-1.5 text-sm leading-6 text-muted sm:text-base">
            {formatFieldDay(date, dateOptions)} · {jobCount} {jobCount === 1 ? "site" : "sites"}
          </p>
        </div>
        <div className="flex flex-col items-start gap-1.5 sm:items-end">
          <div
            className={
              offline
                ? "inline-flex min-h-10 items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft/45 px-3 text-sm font-bold text-foreground"
                : "inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 text-sm font-bold text-foreground"
            }
            role="status"
          >
            {offline ? (
              <AlertTriangle className="size-[1.125rem] text-warning" aria-hidden="true" />
            ) : null}
            <span>{offline ? "Saved copy" : "Office update"}</span>
          </div>
          <p className="text-xs leading-5 text-muted">
            {offline ? "Saved" : "Generated"} {formatFieldTimestamp(generatedAt, dateOptions)}
          </p>
        </div>
      </div>
    </header>
  );
}

function OfflineScheduleNotice({
  date,
  dateOptions,
}: {
  date: string;
  dateOptions: FieldDateOptions;
}) {
  return (
    <div
      className="flex items-start gap-3 border border-warning/35 bg-warning-soft p-4 text-warning"
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <p className="font-bold leading-6">
        This is a saved copy for {formatFieldDay(date, dateOptions)}. Your saved work is safe. Go
        online before you trust a changed time or job.
      </p>
    </div>
  );
}

function TodayDataLimits({ fields }: { fields: string[] }) {
  const staleFields = fields.filter((field) => field !== NOT_SAVED_ON_DEVICE);
  const names = plainFieldNames(staleFields);
  return (
    <>
      {staleFields.length > 0 ? (
        <details className="border border-border bg-surface-raised">
          <summary className="min-h-14 cursor-pointer px-4 py-4 text-sm font-bold">
            Some details may be old
          </summary>
          <div className="border-t border-border px-4 py-4 text-sm leading-6 text-muted">
            {names.length
              ? `Check the job again before you use these details: ${names.join(", ")}.`
              : "Check the job again before you rely on its details."}
          </div>
        </details>
      ) : null}
    </>
  );
}

function TodayJobRow({
  job,
  availability,
  dateOptions,
  fieldCaptureAllowed,
  canRetryPacket,
  onRetryPacket,
}: {
  job: TodayJob;
  availability: PacketAvailability;
  dateOptions: FieldDateOptions;
  fieldCaptureAllowed: boolean;
  canRetryPacket: boolean;
  onRetryPacket: () => void;
}) {
  const blocked = job.blocked_gate_count > 0;
  const actionLabel = blocked
    ? "Check what blocks work"
    : fieldCaptureAllowed
      ? "Open job"
      : "Review job";
  const assignment = [job.assignment?.type, job.assignment?.status].filter(Boolean).join(" · ");
  return (
    <li>
      <article
        className={`grid overflow-hidden border bg-surface-raised lg:grid-cols-[10rem_minmax(0,1fr)_13rem] ${blocked ? "border-danger/35 shadow-[inset_0_2px_0_var(--danger)]" : "border-border"}`}
      >
        <div className="border-b border-border bg-surface-muted/55 p-4 lg:border-b-0 lg:border-r">
          <p className="text-sm font-bold text-muted">On the board</p>
          <p className="mt-1 text-base font-bold leading-6">
            {formatFieldSchedule(job.scheduled_start, dateOptions)}
          </p>
          {job.scheduled_end ? (
            <p className="mt-1 text-sm leading-5 text-muted">
              to {formatFieldSchedule(job.scheduled_end, dateOptions)}
            </p>
          ) : null}
        </div>
        <div className="min-w-0 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-bold tracking-[-0.02em]">{job.job_number ?? job.id}</p>
            {job.status ? <p className="text-sm font-semibold text-muted">{job.status}</p> : null}
          </div>
          <h3 className="mt-1 text-xl font-bold leading-7 tracking-[-0.025em] text-pretty sm:text-2xl">
            {job.address ?? "Address unavailable"}
          </h3>
          {blocked ? (
            <div className="mt-3 flex items-start gap-2 text-danger">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <p className="font-bold leading-6">
                {job.blocked_gate_count}{" "}
                {job.blocked_gate_count === 1 ? "check blocks work" : "checks block work"}
              </p>
            </div>
          ) : null}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <DispatchFact
              label="Assignment"
              value={assignment || "Assignment detail unavailable"}
            />
            <DispatchFact label="Next step" value={job.next_action} />
          </dl>
          <PacketAvailabilityBadge availability={availability} />
        </div>
        <div className="space-y-2 border-t border-border p-4 lg:flex lg:flex-col lg:justify-center lg:border-l lg:border-t-0">
          <Button asChild size="field" fullWidth variant={blocked ? "default" : "accent"}>
            <Link to="/jobs/$jobId" params={{ jobId: job.id }}>
              {actionLabel}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
          {canRetryPacket && (availability === "not_saved" || availability === "unavailable") ? (
            <Button type="button" fullWidth variant="outline" onClick={onRetryPacket}>
              Save job plan again
            </Button>
          ) : null}
        </div>
      </article>
    </li>
  );
}

function TodayWorkObjectRow({
  workObject,
  dateOptions,
}: {
  workObject: TodayWorkObject;
  dateOptions: FieldDateOptions;
}) {
  const params = {
    workObjectType: workObject.work_object_type,
    workObjectId: workObject.work_object_id,
    physicalContextType: workObject.physical_context_type,
    physicalContextId: workObject.physical_context_id,
  };
  const assignment = [workObject.assignment?.type, workObject.assignment?.status]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="py-5 sm:py-6">
      <article className="grid gap-5 lg:grid-cols-[8rem_minmax(0,1fr)_15rem] lg:items-start">
        <div className="border-b border-border pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5">
          <p className="text-sm font-bold text-muted">On the board</p>
          <p className="mt-1 text-base font-bold leading-6">
            {formatFieldSchedule(workObject.scheduled_start, dateOptions)}
          </p>
          {workObject.scheduled_end ? (
            <p className="mt-1 text-sm leading-5 text-muted">
              to {formatFieldSchedule(workObject.scheduled_end, dateOptions)}
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-bold tracking-[-0.02em]">{workObject.work_object_id}</p>
            <p className="text-sm font-semibold text-muted">{workObject.work_object_type}</p>
          </div>
          <h3 className="mt-1 text-xl font-bold leading-7 tracking-[-0.025em] text-pretty sm:text-2xl">
            {workObject.physical_context_type} · {workObject.physical_context_id}
          </h3>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <DispatchFact
              label="Assignment"
              value={assignment || "Assignment detail unavailable"}
            />
            <DispatchFact label="Next step" value={workObject.next_action} />
          </dl>
        </div>
        <div className="space-y-3 lg:pt-1">
          <Button asChild size="field" fullWidth variant="accent">
            <Link
              to="/work-objects/$workObjectType/$workObjectId/physical-contexts/$physicalContextType/$physicalContextId"
              params={params}
            >
              Open work plan
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </article>
    </li>
  );
}

function DispatchFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="mt-1 font-semibold leading-6">{value}</dd>
    </div>
  );
}

function PacketAvailabilityBadge({ availability }: { availability: PacketAvailability }) {
  const state = packetAvailabilityCopy(availability);
  const Icon = state.Icon;
  return (
    <p
      className={`mt-3 inline-flex min-h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-xs font-bold ${state.className}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {state.label}
    </p>
  );
}

function packetAvailabilityCopy(availability: PacketAvailability) {
  switch (availability) {
    case "saved":
      return {
        Icon: PackageCheck,
        label: "Saved on this device",
        className: "text-muted [&_svg]:text-ok",
      };
    case "saving":
      return {
        Icon: CircleDashed,
        label: "Saving job plan",
        className: "text-muted [&_svg]:text-warning",
      };
    case "not_saved":
      return {
        Icon: AlertTriangle,
        label: "Job plan not saved",
        className: "text-muted [&_svg]:text-warning",
      };
    case "unavailable":
      return {
        Icon: AlertTriangle,
        label: "Could not check this job plan",
        className: "text-muted [&_svg]:text-warning",
      };
    default:
      return {
        Icon: CircleDashed,
        label: "Checking job plan",
        className: "text-muted [&_svg]:text-info",
      };
  }
}
