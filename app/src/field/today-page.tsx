import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, CircleDashed, PackageCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { useInitialToday, useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { cacheToday, loadToday } from "./field-cache";
import { hasSavedPlan, prefetchSavedPlans } from "./saved-plan";
import { captureSavedPlanReadContext, useSavedPlanReadContext } from "./saved-plan-read-context";
import {
  assignedPlanTargets,
  savedPlanTargetKey,
  type SavedPlanTarget,
} from "./saved-plan-context";
import { NOT_SAVED_ON_DEVICE, type TodayResponse } from "./field-contracts";
import {
  formatFieldDay,
  formatFieldSchedule,
  formatFieldTimestamp,
  plainFieldNames,
  type FieldDateOptions,
} from "./field-formatting";
import { messageForLoad } from "../lib/plain-error";
import { ASSIGNMENT_ROLE_MISSING, assignmentRole, assignmentRoleLabel } from "./assignment-words";
import { SavedWorkRecoveryPanel } from "./saved-work-recovery-panel";
import {
  AssignmentStopBanner,
  JobStopBanner,
  StopStatusUnavailableBanner,
  TenantStopBanner,
} from "./stop-banner";
import { STOP_WORDS, uniqueStops } from "./stop-words";
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
  const {
    id: contextId,
    blocked: contextBlocked,
    isCurrent: contextIsCurrent,
    observation: readObservation,
  } = useSavedPlanReadContext(session);
  const initialToday = useInitialToday();
  const queryClient = useQueryClient();
  const [packetAvailability, setPacketAvailability] = useState<Record<string, PacketAvailability>>(
    {},
  );
  const [packetRefreshCycle, setPacketRefreshCycle] = useState(0);
  const [bootstrapSaving, setBootstrapSaving] = useState(Boolean(initialToday));
  const query = useQuery({
    queryKey: ["today", session.tenant.id, session.user.id, contextId],
    enabled: !contextBlocked,
    queryFn: async () => {
      const readContext = await captureSavedPlanReadContext(
        session,
        contextIsCurrent,
        readObservation,
      );
      const model = await loadToday(session);
      await readContext.assertCurrent();
      return model;
    },
    ...(initialToday
      ? {
          initialData: initialToday,
          staleTime: 30_000,
        }
      : {}),
  });
  const today = query.data;

  useEffect(() => {
    if (!initialToday || contextBlocked) return;
    let active = true;
    void cacheToday(session, initialToday)
      .catch(() => {
        queryClient.setQueryData<TodayResponse>(
          ["today", session.tenant.id, session.user.id, contextId],
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
  }, [initialToday, queryClient, session, contextBlocked, contextId]);

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
    if (!today || contextBlocked) return;
    let active = true;
    const online = navigator.onLine;
    const targets = assignedPlanTargets(today);
    void (async () => {
      try {
        const cached = await Promise.all(
          targets.map(
            async (target) =>
              [savedPlanTargetKey(target), await hasSavedPlan(session, target)] as const,
          ),
        );
        if (!active || !contextIsCurrent()) return;
        setPacketAvailability((current) => ({
          ...current,
          ...Object.fromEntries(
            cached.map(([key, exists]) => [
              `${contextId}:${key}`,
              online ? "saving" : exists ? "saved" : "not_saved",
            ]),
          ),
        }));
        if (!online) return;
        await prefetchSavedPlans(session, today, {
          concurrency: 3,
          isCurrent: contextIsCurrent,
          observation: readObservation,
          onPacket(target, saved) {
            if (!active || !contextIsCurrent()) return;
            setPacketAvailability((current) => ({
              ...current,
              [`${contextId}:${savedPlanTargetKey(target)}`]: saved ? "saved" : "not_saved",
            }));
          },
        });
      } catch {
        if (!active || !contextIsCurrent()) return;
        setPacketAvailability((current) => ({
          ...current,
          ...Object.fromEntries(
            targets.map((target) => [`${contextId}:${savedPlanTargetKey(target)}`, "unavailable"]),
          ),
        }));
      }
    })();
    return () => {
      active = false;
    };
  }, [
    packetRefreshCycle,
    session,
    today,
    contextBlocked,
    contextId,
    contextIsCurrent,
    readObservation,
  ]);

  if (contextBlocked)
    return (
      <ErrorState
        title="Work list unavailable"
        message="Your sign-in or paired device changed or expired. Keep work stopped. Go online and reload to verify the current work list and saved plans."
        onRetry={() => window.location.reload()}
      />
    );
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
  const targets = assignedPlanTargets(today);
  const availabilityFor = (target: SavedPlanTarget): PacketAvailability =>
    packetAvailability[`${contextId}:${savedPlanTargetKey(target)}`] ?? "checking";
  const savedPacketCount = targets.filter((target) => availabilityFor(target) === "saved").length;
  const hasCheckingPackets = targets.some((target) => availabilityFor(target) === "checking");
  const hasSavingPackets = targets.some((target) => availabilityFor(target) === "saving");
  const runSheetNotSaved = today.stale_fields.includes(NOT_SAVED_ON_DEVICE);
  const savingOffline =
    bootstrapSaving || query.isFetching || hasCheckingPackets || hasSavingPackets;
  const readyOffline = !runSheetNotSaved && savedPacketCount === targets.length;
  const fieldCaptureAllowed =
    session.user.role === "field" && today.allowed_actions.includes("field.checkin.create");
  const stopStatusUnavailable =
    today.stale_fields.includes("jobs.active_stops_unavailable") ||
    today.jobs.some((job) => job.active_stops == null) ||
    today.work_objects.some((workObject) => workObject.active_stops == null);
  const assignmentStops = uniqueStops([
    ...today.jobs.map((job) => job.active_stops ?? []),
    ...today.work_objects.map((workObject) => workObject.active_stops ?? []),
  ]);
  const tenantStopActive = assignmentStops.some((stop) => stop.scope === "tenant");
  const dataLimits = today.stale_fields.filter(
    (field) => field !== "offline.cached_packet" && field !== "jobs.active_stops_unavailable",
  );
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
          targets.length > 0
            ? `This run sheet and ${savedPacketCount} ${today.work_objects.length ? "work" : "job"} ${savedPacketCount === 1 ? "plan is" : "plans are"} saved on this phone. Before starting, choose ${today.jobs.length ? "Review saved job plan on each job card" : "Review saved work plan on each work card"}${today.jobs.length && today.work_objects.length ? " or Review saved work plan on each work card" : ""} and check its work and safety steps. The office must release every applicable stop, and all open work checks must also be cleared.`
            : "This run sheet is saved on this phone."
        }
        missingDetail={
          runSheetNotSaved
            ? "This run sheet is not saved on this phone."
            : "Some work plans are missing, unavailable, or not saved on this phone."
        }
        onRetry={() => {
          if (runSheetNotSaved) void query.refetch();
          else setPacketRefreshCycle((cycle) => cycle + 1);
        }}
      />
      {session.user.role === "field" ? <SavedWorkRecoveryPanel session={session} /> : null}
      {offline ? <OfflineScheduleNotice date={today.date} dateOptions={dateOptions} /> : null}
      {stopStatusUnavailable ? (
        <StopStatusUnavailableBanner
          officePhone={session.tenant.office_phone}
          canRetry={navigator.onLine}
          checking={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}
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
          <div className="mb-4 empty:hidden">
            <TenantStopBanner
              stops={assignmentStops}
              dateOptions={dateOptions}
              checkedAt={today.read_model_generated_at}
              offline={offline}
              officePhone={session.tenant.office_phone}
              hasOtherWork={today.work_objects.length > 0}
            />
          </div>
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
                availability={availabilityFor({ kind: "job", jobId: job.id })}
                dateOptions={dateOptions}
                checkedAt={today.read_model_generated_at}
                offline={offline}
                stopStatusUnavailable={stopStatusUnavailable}
                tenantStopActive={tenantStopActive}
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
                    availability={availabilityFor(workObjectPlanTarget(workObject))}
                    canRetryPacket={navigator.onLine}
                    onRetryPacket={() => setPacketRefreshCycle((cycle) => cycle + 1)}
                    dateOptions={dateOptions}
                    checkedAt={today.read_model_generated_at}
                    offline={offline}
                    stopStatusUnavailable={stopStatusUnavailable}
                    tenantStopActive={tenantStopActive}
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

/** The Worker's next step for a job when no work check gives a reason (app-read-models.ts). */
const GENERIC_NEXT_ACTIONS = new Set(["Open field check-in", "Assign field work"]);

function TodayJobRow({
  job,
  availability,
  dateOptions,
  checkedAt,
  offline,
  stopStatusUnavailable,
  tenantStopActive,
  fieldCaptureAllowed,
  canRetryPacket,
  onRetryPacket,
}: {
  job: TodayJob;
  availability: PacketAvailability;
  dateOptions: FieldDateOptions;
  checkedAt: string;
  offline: boolean;
  stopStatusUnavailable: boolean;
  tenantStopActive: boolean;
  fieldCaptureAllowed: boolean;
  canRetryPacket: boolean;
  onRetryPacket: () => void;
}) {
  const blocked = job.blocked_gate_count > 0;
  // A work stop holds this job (its own, or one that holds every job): the card waits on the
  // office, and a work check on it never reads as the way to restart work.
  const held = tenantStopActive || (job.active_stops ?? []).length > 0;
  const officePhone = useSession().tenant.office_phone;
  const actionLabel = stopStatusUnavailable
    ? "Review job details"
    : blocked
      ? "Check what blocks work"
      : fieldCaptureAllowed
        ? "Open job"
        : "Review job";
  const assignment = assignmentRole(job.assignment);
  const roleLabel = assignmentRoleLabel(useSession().user.role);
  // The card follows its own width, not the window's: the crew shell centres a phone-wide column
  // on a desktop, where window breakpoints squeezed three columns into it.
  return (
    <li className="@container">
      <article
        className={`grid overflow-hidden border bg-surface-raised @3xl:grid-cols-[10rem_minmax(0,1fr)_13rem] ${blocked ? "border-danger/35 shadow-[inset_0_2px_0_var(--danger)]" : "border-border"}`}
      >
        <div className="border-b border-border bg-surface-muted/55 p-4 @3xl:border-b-0 @3xl:border-r">
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
        <div className="@container min-w-0 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-bold tracking-[-0.02em]">{job.job_number ?? job.id}</p>
            {job.status ? <p className="text-sm font-semibold text-muted">{job.status}</p> : null}
          </div>
          <h3 className="mt-1 text-xl font-bold leading-7 tracking-[-0.025em] text-pretty sm:text-2xl">
            {job.address ?? "Address unavailable"}
          </h3>
          <div className="mt-3 empty:hidden">
            <JobStopBanner
              stops={job.active_stops ?? []}
              job={{ address: job.address, code: job.job_number }}
              dateOptions={dateOptions}
              checkedAt={checkedAt}
              offline={offline}
              officePhone={officePhone}
            />
          </div>
          {blocked && held ? (
            <p className="mt-3 text-sm leading-6 text-muted">
              {STOP_WORDS.separateCheck(
                // The run sheet's own next steps when a check gives no reason are not a check's name.
                GENERIC_NEXT_ACTIONS.has(job.next_action) ? null : job.next_action,
              )}
            </p>
          ) : blocked ? (
            <div className="mt-3 flex items-start gap-2 text-danger">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <p className="font-bold leading-6">
                {job.blocked_gate_count}{" "}
                {job.blocked_gate_count === 1 ? "check blocks work" : "checks block work"}
              </p>
            </div>
          ) : null}
          <dl className="mt-4 grid gap-3 text-sm @sm:grid-cols-2">
            <DispatchFact label={roleLabel} value={assignment || ASSIGNMENT_ROLE_MISSING} />
            <DispatchFact
              label="Next step"
              value={
                stopStatusUnavailable
                  ? STOP_WORDS.unavailableNextStep
                  : held
                    ? STOP_WORDS.nextStep
                    : job.next_action
              }
            />
          </dl>
          <PacketAvailabilityBadge availability={availability} />
        </div>
        <div className="space-y-2 border-t border-border p-4 @3xl:flex @3xl:flex-col @3xl:justify-center @3xl:border-l @3xl:border-t-0">
          <Button
            asChild
            size="field"
            fullWidth
            variant={held || stopStatusUnavailable ? "outline" : blocked ? "default" : "accent"}
          >
            <Link to="/jobs/$jobId" params={{ jobId: job.id }}>
              {actionLabel}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="field" fullWidth variant="outline">
            <Link to="/jobs/$jobId/plan" params={{ jobId: job.id }}>
              {availability === "saved" ? "Review saved job plan" : "Review job plan"}
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
  availability,
  canRetryPacket,
  onRetryPacket,
  dateOptions,
  checkedAt,
  offline,
  stopStatusUnavailable,
  tenantStopActive,
}: {
  workObject: TodayWorkObject;
  availability: PacketAvailability;
  canRetryPacket: boolean;
  onRetryPacket: () => void;
  dateOptions: FieldDateOptions;
  checkedAt: string;
  offline: boolean;
  stopStatusUnavailable: boolean;
  tenantStopActive: boolean;
}) {
  const held = tenantStopActive || (workObject.active_stops ?? []).length > 0;
  const reviewOnly = held || stopStatusUnavailable;
  const officePhone = useSession().tenant.office_phone;
  const params = {
    workObjectType: workObject.work_object_type,
    workObjectId: workObject.work_object_id,
    physicalContextType: workObject.physical_context_type,
    physicalContextId: workObject.physical_context_id,
  };
  const assignment = assignmentRole(workObject.assignment);
  const roleLabel = assignmentRoleLabel(useSession().user.role);
  return (
    <li className="@container py-5 sm:py-6">
      <article className="grid gap-5 @3xl:grid-cols-[8rem_minmax(0,1fr)_15rem] @3xl:items-start">
        <div className="border-b border-border pb-3 @3xl:border-b-0 @3xl:border-r @3xl:pb-0 @3xl:pr-5">
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
        <div className="@container min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-bold tracking-[-0.02em]">{workObject.work_object_id}</p>
            <p className="text-sm font-semibold text-muted">{workObject.work_object_type}</p>
          </div>
          <h3 className="mt-1 text-xl font-bold leading-7 tracking-[-0.025em] text-pretty sm:text-2xl">
            {workObject.physical_context_type} · {workObject.physical_context_id}
          </h3>
          <div className="mt-3 empty:hidden">
            <AssignmentStopBanner
              stops={workObject.active_stops ?? []}
              dateOptions={dateOptions}
              checkedAt={checkedAt}
              offline={offline}
              officePhone={officePhone}
            />
          </div>
          <dl className="mt-4 grid gap-4 text-sm @sm:grid-cols-2">
            <DispatchFact label={roleLabel} value={assignment || ASSIGNMENT_ROLE_MISSING} />
            <DispatchFact
              label="Next step"
              value={
                stopStatusUnavailable
                  ? STOP_WORDS.unavailableNextStep
                  : held
                    ? STOP_WORDS.nextStep
                    : workObject.next_action
              }
            />
          </dl>
          <PacketAvailabilityBadge availability={availability} kind="work" />
        </div>
        <div className="space-y-3 @3xl:pt-1">
          <Button asChild size="field" fullWidth variant={reviewOnly ? "outline" : "accent"}>
            <Link
              to="/work-objects/$workObjectType/$workObjectId/physical-contexts/$physicalContextType/$physicalContextId"
              params={params}
            >
              {reviewOnly ? "Review work plan" : "Open work plan"}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild size="field" fullWidth variant="outline">
            <Link
              to="/work-objects/$workObjectType/$workObjectId/physical-contexts/$physicalContextType/$physicalContextId/plan"
              params={params}
            >
              {availability === "saved" ? "Review saved work plan" : "Review work and safety steps"}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
          {canRetryPacket && (availability === "not_saved" || availability === "unavailable") ? (
            <Button type="button" fullWidth variant="outline" onClick={onRetryPacket}>
              Save work plan again
            </Button>
          ) : null}
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

function workObjectPlanTarget(work: TodayWorkObject): SavedPlanTarget {
  return {
    kind: "work-object",
    scope: {
      workObjectType: work.work_object_type,
      workObjectId: work.work_object_id,
      physicalContextType: work.physical_context_type,
      physicalContextId: work.physical_context_id,
    },
  };
}

function PacketAvailabilityBadge({
  availability,
  kind = "job",
}: {
  availability: PacketAvailability;
  kind?: "job" | "work";
}) {
  const state = packetAvailabilityCopy(availability);
  const Icon = state.Icon;
  return (
    <p
      className={`mt-3 inline-flex min-h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-xs font-bold ${state.className}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {kind === "work"
        ? state.label.replace(/job/gi, (word) => (word === "Job" ? "Work" : "work"))
        : state.label}
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
