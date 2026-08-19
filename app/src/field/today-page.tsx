import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronRight,
  CircleDashed,
  ClipboardCheck,
  PackageCheck,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useInitialToday, useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { cacheToday, hasCachedJobPacket, loadToday, prefetchAssignedPackets } from "./field-cache";
import type { TodayResponse } from "./field-contracts";
import {
  formatFieldDay,
  formatFieldSchedule,
  formatFieldTimestamp,
  humanizeFieldName,
  messageFor,
  type FieldDateOptions,
} from "./field-formatting";
import { SavedWorkRecoveryPanel } from "./saved-work-recovery-panel";

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
    void cacheToday(session, initialToday).catch((error: unknown) => {
      console.error("Could not cache the initial Field Companion run sheet", error);
    });
  }, [initialToday, session]);

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
              exists ? "saved" : online ? "saving" : "not_saved",
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
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  }
  if (!today) return <LoadingState label="Loading assigned work…" />;
  const offline = today.stale_fields.includes("offline.cached_packet");
  const dateOptions = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const availabilityFor = (job: TodayJob): PacketAvailability =>
    packetAvailability[job.id] ?? "checking";
  const savedPacketCount = today.jobs.filter((job) => availabilityFor(job) === "saved").length;
  const hasCheckingPackets = today.jobs.some((job) => availabilityFor(job) === "checking");
  const hasSavingPackets = today.jobs.some((job) => availabilityFor(job) === "saving");
  const fieldCaptureAllowed =
    session.user.role === "field" && today.allowed_actions.includes("field.checkin.create");
  const dataLimits = today.stale_fields.filter((field) => field !== "offline.cached_packet");
  const assignmentCount = today.jobs.length + today.work_objects.length;

  return (
    <section className="mx-auto max-w-5xl space-y-7 pb-4">
      <TodayDispatchHeader
        date={today.date}
        jobCount={assignmentCount}
        offline={offline}
        generatedAt={today.read_model_generated_at}
        dateOptions={dateOptions}
      />
      {session.user.role === "field" ? <SavedWorkRecoveryPanel session={session} /> : null}
      {offline ? <OfflineScheduleNotice date={today.date} dateOptions={dateOptions} /> : null}
      {dataLimits.length > 0 ? <TodayDataLimits fields={dataLimits} /> : null}
      {today.jobs.length > 0 ? (
        <PacketAvailabilityPanel
          jobCount={today.jobs.length}
          savedCount={savedPacketCount}
          checking={hasCheckingPackets}
          saving={hasSavingPackets}
          offline={offline}
        />
      ) : null}
      {assignmentCount === 0 ? (
        <EmptyState
          title={
            session.user.role === "field"
              ? "No job packets are assigned to this device today"
              : "No active assignments were returned today"
          }
          message={
            session.user.role === "field"
              ? "Do not travel based on this screen. Ask the office to confirm an active assignment before leaving."
              : "This list reflects only assignments available to your current role."
          }
        />
      ) : (
        <section aria-labelledby="today-run-sheet-heading">
          <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
            <div>
              <p className="text-sm font-semibold text-muted">Departure and site preparation</p>
              <h2
                id="today-run-sheet-heading"
                className="mt-1 text-2xl font-black tracking-[-0.03em] sm:text-3xl"
              >
                Run sheet
              </h2>
            </div>
            <p className="text-sm font-semibold text-muted">
              {assignmentCount} {assignmentCount === 1 ? "assignment" : "assignments"}
            </p>
          </header>
          <ol className="divide-y divide-border">
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
              <h3 className="mt-8 border-b border-border pb-4 text-lg font-black">
                Typed physical work
              </h3>
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
    <header className="border-b border-border pb-5 sm:pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-muted">Field dispatch</p>
          <h1 className="mt-1 text-4xl font-black tracking-[-0.045em] sm:text-5xl">Today</h1>
          <p className="mt-2 text-base leading-6 text-muted sm:text-lg">
            {formatFieldDay(date, dateOptions)} · {jobCount} {jobCount === 1 ? "site" : "sites"}
          </p>
        </div>
        <div
          className={
            offline
              ? "flex min-h-12 items-center gap-2 border border-warning/35 bg-warning-soft px-3 text-sm font-bold text-warning"
              : "flex min-h-12 items-center gap-2 border border-info/35 bg-info-soft px-3 text-sm font-bold text-info"
          }
          role="status"
        >
          {offline ? (
            <AlertTriangle className="size-5" aria-hidden="true" />
          ) : (
            <ClipboardCheck className="size-5" aria-hidden="true" />
          )}
          <span>{offline ? "Offline snapshot" : "Current assignment read"}</span>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-muted">
        {offline ? "Saved schedule" : "Read generated"}{" "}
        {formatFieldTimestamp(generatedAt, dateOptions)}
      </p>
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
        Offline snapshot for {formatFieldDay(date, dateOptions)}. Saved work remains queued;
        reconnect before relying on a changed schedule.
      </p>
    </div>
  );
}

function TodayDataLimits({ fields }: { fields: string[] }) {
  return (
    <details className="border border-border bg-surface-raised">
      <summary className="min-h-14 cursor-pointer px-4 py-4 text-sm font-bold">
        Some dispatch data may be limited
      </summary>
      <div className="border-t border-border px-4 py-4 text-sm leading-6 text-muted">
        This read may be stale for {fields.map(humanizeFieldName).join(", ")}. Open the job packet
        before relying on a field that may have changed.
      </div>
    </details>
  );
}

function PacketAvailabilityPanel({
  jobCount,
  savedCount,
  checking,
  saving,
  offline,
}: {
  jobCount: number;
  savedCount: number;
  checking: boolean;
  saving: boolean;
  offline: boolean;
}) {
  const state = checking
    ? {
        Icon: CircleDashed,
        label: "Checking saved packets",
        detail: "Packet availability is still being checked on this device.",
        className: "border-info/35 bg-info-soft text-info",
      }
    : saving
      ? {
          Icon: CircleDashed,
          label: "Saving packets for offline use",
          detail: "Keep the app open while remaining site packets are being saved.",
          className: "border-warning/35 bg-warning-soft text-warning",
        }
      : savedCount === jobCount
        ? {
            Icon: PackageCheck,
            label: "Packets saved on this device",
            detail: "Open the job packet for current gate and safety detail before work.",
            className: "border-ok/35 bg-ok-soft text-ok",
          }
        : {
            Icon: AlertTriangle,
            label: offline
              ? "Some packets are not saved on this device"
              : "Some packets need saving",
            detail: offline
              ? "Reconnect to save missing packets before leaving for those sites."
              : "The run sheet will retry preparation when this app reconnects or returns to the foreground.",
            className: "border-warning/35 bg-warning-soft text-warning",
          };
  const StateIcon = state.Icon;
  return (
    <section className={`border p-4 sm:p-5 ${state.className}`} aria-label="Packet availability">
      <div className="flex items-start gap-3">
        <StateIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-black">{state.label}</p>
          <p className="mt-1 text-sm leading-6">
            {savedCount} of {jobCount} saved on this device.
          </p>
          <p className="mt-1 text-sm leading-6 opacity-90">{state.detail}</p>
        </div>
      </div>
    </section>
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
    ? "Review gate and packet"
    : fieldCaptureAllowed
      ? "Open job packet"
      : "Review job packet";
  const assignment = [job.assignment?.type, job.assignment?.status].filter(Boolean).join(" · ");
  return (
    <li className="py-5 sm:py-6">
      <article className="grid gap-5 lg:grid-cols-[8rem_minmax(0,1fr)_15rem] lg:items-start">
        <div className="border-b border-border pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5">
          <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">Scheduled</p>
          <p className="mt-1 text-base font-black leading-6">
            {formatFieldSchedule(job.scheduled_start, dateOptions)}
          </p>
          {job.scheduled_end ? (
            <p className="mt-1 text-sm leading-5 text-muted">
              to {formatFieldSchedule(job.scheduled_end, dateOptions)}
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-black tracking-[-0.02em]">{job.job_number ?? job.id}</p>
            {job.status ? <p className="text-sm font-semibold text-muted">{job.status}</p> : null}
          </div>
          <h3 className="mt-1 text-xl font-black leading-7 tracking-[-0.025em] text-pretty sm:text-2xl">
            {job.address ?? "Address unavailable"}
          </h3>
          {blocked ? (
            <div className="mt-4 flex items-start gap-2 border-l-4 border-danger pl-3 text-danger">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <p className="font-black leading-6">
                {job.blocked_gate_count}{" "}
                {job.blocked_gate_count === 1 ? "gate blocks work" : "gates block work"}
              </p>
            </div>
          ) : null}
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <DispatchFact
              label="Assignment"
              value={assignment || "Assignment detail unavailable"}
            />
            <DispatchFact label="Status note" value={job.next_action} />
          </dl>
          <PacketAvailabilityBadge availability={availability} />
        </div>
        <div className="space-y-3 lg:pt-1">
          <Button asChild size="field" fullWidth variant={blocked ? "outline" : "accent"}>
            <Link to="/jobs/$jobId" params={{ jobId: job.id }}>
              {actionLabel}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
          {canRetryPacket && (availability === "not_saved" || availability === "unavailable") ? (
            <Button type="button" size="field" fullWidth variant="outline" onClick={onRetryPacket}>
              Retry saving packet
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
          <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">Scheduled</p>
          <p className="mt-1 text-base font-black leading-6">
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
            <p className="font-black tracking-[-0.02em]">{workObject.work_object_id}</p>
            <p className="text-sm font-semibold text-muted">{workObject.work_object_type}</p>
          </div>
          <h3 className="mt-1 text-xl font-black leading-7 tracking-[-0.025em] text-pretty sm:text-2xl">
            {workObject.physical_context_type} · {workObject.physical_context_id}
          </h3>
          <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <DispatchFact
              label="Assignment"
              value={assignment || "Assignment detail unavailable"}
            />
            <DispatchFact label="Status note" value={workObject.next_action} />
          </dl>
        </div>
        <div className="space-y-3 lg:pt-1">
          <Button asChild size="field" fullWidth variant="accent">
            <Link
              to="/work-objects/$workObjectType/$workObjectId/physical-contexts/$physicalContextType/$physicalContextId"
              params={params}
            >
              Open typed work packet
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
      <dt className="text-xs font-extrabold uppercase tracking-[0.1em] text-muted">{label}</dt>
      <dd className="mt-1 font-semibold leading-6">{value}</dd>
    </div>
  );
}

function PacketAvailabilityBadge({ availability }: { availability: PacketAvailability }) {
  const state = packetAvailabilityCopy(availability);
  const Icon = state.Icon;
  return (
    <p
      className={`mt-4 inline-flex min-h-9 items-center gap-2 text-sm font-bold ${state.className}`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {state.label}
    </p>
  );
}

function packetAvailabilityCopy(availability: PacketAvailability) {
  switch (availability) {
    case "saved":
      return { Icon: PackageCheck, label: "Saved on this device", className: "text-ok" };
    case "saving":
      return {
        Icon: CircleDashed,
        label: "Saving packet for offline use",
        className: "text-warning",
      };
    case "not_saved":
      return {
        Icon: AlertTriangle,
        label: "Packet not saved on this device",
        className: "text-warning",
      };
    case "unavailable":
      return {
        Icon: AlertTriangle,
        label: "Packet availability could not be checked",
        className: "text-warning",
      };
    default:
      return { Icon: CircleDashed, label: "Checking packet availability", className: "text-info" };
  }
}
