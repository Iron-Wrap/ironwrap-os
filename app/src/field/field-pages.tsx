import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  ClipboardCheck,
  HardHat,
  MapPin,
  Mic,
  PackageCheck,
  Phone,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { isOfflineSession } from "../auth/session";
import { useInitialToday, useSession } from "../auth/session-context";
import { getDeviceSecret } from "../auth/device-credential";
import { OutboxStateBadge } from "../components/outbox-state-badge";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { apiCommand } from "../lib/api";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { JsonValue, OutboxAction } from "../storage/outbox-types";
import {
  hasCachedJobPacket,
  cacheToday,
  loadJob,
  loadWorkObject,
  loadProofPage,
  loadToday,
  prefetchAssignedPackets,
} from "./field-cache";
import type {
  JobResponse,
  ProofStreamItem,
  TodayResponse,
  WorkObjectResponse,
} from "./field-contracts";
import { GateChip } from "./gate-chip";
import { ProofStream } from "./proof-stream";
import { SavedWorkRecoveryPanel } from "./saved-work-recovery-panel";

const FIELD_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
]);
const MAX_MEDIA_COUNT = 12;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_ACTION_BYTES = 24 * 1024 * 1024;
const PROOF_SLOTS = [
  "Production",
  "Safety",
  "Access",
  "Weather",
  "Crew",
  "Materials",
  "Change Order",
  "Completion",
  "Other",
];
const BLOCKER_CATEGORIES = [
  "Safety",
  "Weather",
  "Access",
  "Material",
  "Crew",
  "Scope",
  "Customer",
  "Other",
];

type PacketAvailability = "checking" | "saving" | "saved" | "not_saved" | "unavailable";
type TodayJob = TodayResponse["jobs"][number];
type TodayWorkObject = TodayResponse["work_objects"][number];
type FieldDateOptions = { locale?: string; timeZone?: string };

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

export function JobPage() {
  const session = useSession();
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const query = useQuery({
    queryKey: ["job", session.tenant.id, session.user.id, jobId],
    enabled: Boolean(jobId),
    queryFn: () => loadJob(session, jobId!),
  });
  if (!jobId) return <ErrorState message="This job link is incomplete." />;
  if (query.isPending) return <LoadingState label="Loading field packet…" />;
  if (query.isError)
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  return (
    <JobSurface
      key={query.data.read_model_generated_at}
      model={query.data}
      offline={query.data.stale_fields.includes("offline.cached_packet")}
    />
  );
}

export function WorkObjectPage() {
  const session = useSession();
  const params = useParams({ strict: false }) as {
    workObjectType?: string;
    workObjectId?: string;
    physicalContextType?: string;
    physicalContextId?: string;
  };
  const scope: WorkObjectResponse["work_object"] | null =
    params.workObjectType &&
    params.workObjectId &&
    params.physicalContextType &&
    params.physicalContextId
      ? {
          workObjectType: params.workObjectType,
          workObjectId: params.workObjectId,
          physicalContextType: params.physicalContextType,
          physicalContextId: params.physicalContextId,
        }
      : null;
  const query = useQuery({
    queryKey: scope
      ? [
          "work-object",
          session.tenant.id,
          session.user.id,
          scope.workObjectType,
          scope.workObjectId,
          scope.physicalContextType,
          scope.physicalContextId,
        ]
      : ["work-object", session.tenant.id, session.user.id, "missing"],
    enabled: scope !== null,
    queryFn: () => loadWorkObject(session, scope!),
  });
  if (!scope) return <ErrorState message="This typed work link is incomplete." />;
  if (query.isPending) return <LoadingState label="Loading typed field packet…" />;
  if (query.isError)
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  return (
    <WorkObjectSurface
      key={query.data.read_model_generated_at}
      model={query.data}
      offline={query.data.stale_fields.includes("offline.cached_packet")}
    />
  );
}

function WorkObjectSurface({ model, offline }: { model: WorkObjectResponse; offline: boolean }) {
  const session = useSession();
  const workPackage = model.work_package;
  const panelModel: WorkPackagePanelModel = {
    job: { id: model.work_object.workObjectId },
    assignment: model.assignment,
    allowed_actions: model.allowed_actions,
    packet: { work_package: workPackage },
  };
  const captureAllowed =
    session.user.role === "field" && model.allowed_actions.includes("field.checkin.create");
  return (
    <RoleGuard surface="field">
      <section className="mx-auto max-w-5xl space-y-7 pb-8 lg:pb-4">
        <Button asChild variant="ghost" size="compact">
          <Link to="/today">
            <ChevronLeft aria-hidden="true" />
            Today
          </Link>
        </Button>
        <WorkObjectPacketHeader model={model} offline={offline} />
        <WorkPackagePanel
          model={panelModel}
          offline={offline}
          dateOptions={{ locale: session.tenant.locale, timeZone: session.tenant.time_zone }}
          captureAllowed={captureAllowed}
        />
        <CaptureProofPanel
          jobId={model.work_object.workObjectId}
          workObjectScope={workPackage ? workObjectScopeForPackage(workPackage) : null}
          blocked={false}
          fieldCaptureAllowed={captureAllowed}
          fieldRole={session.user.role === "field"}
        />
      </section>
    </RoleGuard>
  );
}

function WorkObjectPacketHeader({
  model,
  offline,
}: {
  model: WorkObjectResponse;
  offline: boolean;
}) {
  const assignment = [model.assignment?.type, model.assignment?.status].filter(Boolean).join(" · ");
  return (
    <header className="border-b border-border pb-5 sm:pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">{model.work_object.workObjectType}</p>
          <h1 className="mt-1 text-3xl font-black tracking-[-0.04em] text-pretty sm:text-4xl">
            {model.work_object.workObjectId}
          </h1>
          <p className="mt-2 text-base leading-6 text-muted">
            {model.work_object.physicalContextType} · {model.work_object.physicalContextId}
          </p>
        </div>
        <p className="border border-border bg-surface-raised px-3 py-2 text-sm font-bold text-muted">
          {offline ? "Offline packet" : "Typed packet read"}
        </p>
      </div>
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
        <JobFact label="Assignment" value={assignment || "Assignment detail unavailable"} />
        <JobFact
          label="Packet"
          value={model.work_package ? `v${model.work_package.version}` : "Unavailable"}
        />
      </dl>
    </header>
  );
}

function JobSurface({ model, offline }: { model: JobResponse; offline: boolean }) {
  const session = useSession();
  const [proof, setProof] = useState<ProofStreamItem[]>(model.proof_stream);
  const [cursor, setCursor] = useState(model.proof_page.next_cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const dateOptions = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };
  const blockedGates = model.gates.filter((gate) => gate.state?.trim().toLowerCase() === "blocked");
  const fieldCaptureAllowed =
    session.user.role === "field" &&
    model.assignment !== null &&
    model.allowed_actions.includes("field.checkin.create");
  const dataLimits = model.stale_fields.filter((field) => field !== "offline.cached_packet");

  async function loadOlder() {
    if (!cursor || loadingMore || offline) return;
    setLoadingMore(true);
    try {
      const page = await loadProofPage(session, model.job.id, cursor);
      setProof((current) => dedupeProof([...current, ...page.items]));
      setCursor(page.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <RoleGuard surface="job">
      <section className="mx-auto max-w-5xl space-y-7 pb-8 lg:pb-4">
        <Button asChild variant="ghost" size="compact">
          {session.user.role === "production" ? (
            <Link to="/production">
              <ChevronLeft aria-hidden="true" />
              Production
            </Link>
          ) : (
            <Link to="/today">
              <ChevronLeft aria-hidden="true" />
              Today
            </Link>
          )}
        </Button>
        <JobPacketHeader model={model} offline={offline} dateOptions={dateOptions} />
        {offline ? (
          <JobOfflineNotice generatedAt={model.read_model_generated_at} dateOptions={dateOptions} />
        ) : null}
        {dataLimits.length > 0 ? <JobDataLimits fields={dataLimits} /> : null}
        <WorkPackagePanel
          model={model}
          offline={offline}
          dateOptions={dateOptions}
          captureAllowed={fieldCaptureAllowed}
        />
        <WorkStatus model={model} blockedGates={blockedGates} dateOptions={dateOptions} />
        <CaptureProofPanel
          jobId={model.job.id}
          workObjectScope={
            model.packet.work_package ? workObjectScopeForPackage(model.packet.work_package) : null
          }
          blocked={blockedGates.length > 0}
          fieldCaptureAllowed={fieldCaptureAllowed}
          fieldRole={session.user.role === "field"}
        />
        <SafetyAndAccess model={model} dateOptions={dateOptions} />
        <section className="space-y-4" aria-labelledby="proof-stream-heading">
          <header className="border-b border-border pb-4">
            <p className="text-sm font-semibold text-muted">Verified evidence only</p>
            <h2
              id="proof-stream-heading"
              className="mt-1 text-2xl font-black tracking-[-0.03em] sm:text-3xl"
            >
              Proof Stream
            </h2>
          </header>
          <ProofStream
            items={proof}
            hasMore={Boolean(cursor) && !offline}
            loadingMore={loadingMore}
            onLoadMore={() => void loadOlder()}
            locale={dateOptions.locale}
            timeZone={dateOptions.timeZone}
          />
        </section>
        <PacketDetails model={model} dateOptions={dateOptions} />
      </section>
    </RoleGuard>
  );
}

function JobPacketHeader({
  model,
  offline,
  dateOptions,
}: {
  model: JobResponse;
  offline: boolean;
  dateOptions: FieldDateOptions;
}) {
  const assignment = [model.assignment?.type, model.assignment?.status].filter(Boolean).join(" · ");
  return (
    <header className="border-b border-border pb-5 sm:pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">
            {model.job.job_number ?? "Assigned job"}
          </p>
          <h1 className="mt-1 text-3xl font-black tracking-[-0.04em] text-pretty sm:text-4xl">
            {model.job.address ?? "Job packet"}
          </h1>
        </div>
        <p className="border border-border bg-surface-raised px-3 py-2 text-sm font-bold text-muted">
          {offline ? "Offline packet" : "Packet read"}
        </p>
      </div>
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
        <JobFact label="Service" value={model.job.service_type ?? "Service unavailable"} />
        <JobFact label="Assignment" value={assignment || "Assignment detail unavailable"} />
        <JobFact
          label="Scheduled"
          value={formatFieldSchedule(model.assignment?.scheduled_start ?? null, dateOptions)}
        />
      </dl>
      <p className="mt-4 text-sm leading-6 text-muted">
        {offline ? "Saved packet generated" : "Packet read generated"}{" "}
        {formatFieldTimestamp(model.read_model_generated_at, dateOptions)} ·{" "}
        {model.source_updated_at
          ? `Source updated ${formatFieldTimestamp(model.source_updated_at, dateOptions)}`
          : "Source update time unavailable"}
      </p>
    </header>
  );
}

function JobOfflineNotice({
  generatedAt,
  dateOptions,
}: {
  generatedAt: string;
  dateOptions: FieldDateOptions;
}) {
  return (
    <div
      className="flex items-start gap-3 border border-warning/35 bg-warning-soft p-4 text-warning"
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <p className="font-bold leading-6">
        Offline packet from {formatFieldTimestamp(generatedAt, dateOptions)}. Capture can remain
        queued on this device; reconnect before relying on changed gates, scope, or safety detail.
      </p>
    </div>
  );
}

function JobDataLimits({ fields }: { fields: string[] }) {
  return (
    <details className="border border-border bg-surface-raised">
      <summary className="min-h-14 cursor-pointer px-4 py-4 text-sm font-bold">
        Some packet data may be limited
      </summary>
      <p className="border-t border-border px-4 py-4 text-sm leading-6 text-muted">
        This read may be stale for {fields.map(humanizeFieldName).join(", ")}. Do not infer a
        missing value or change a gate from this screen.
      </p>
    </details>
  );
}

type WorkPackagePanelModel = {
  job: Pick<JobResponse["job"], "id">;
  assignment: JobResponse["assignment"];
  allowed_actions: string[];
  packet: Pick<JobResponse["packet"], "work_package">;
};

type FieldWorkPackage = NonNullable<JobResponse["packet"]["work_package"]>;
type TypedWorkObjectScope = {
  work_object_type: string;
  work_object_id: string;
  physical_context_type: string;
  physical_context_id: string;
};

function workObjectScopeForPackage(workPackage: FieldWorkPackage): TypedWorkObjectScope | null {
  if (
    workPackage.work_object_type === "Roof Job" ||
    !workPackage.work_object_type ||
    !workPackage.work_object_id ||
    !workPackage.physical_context_type ||
    !workPackage.physical_context_id
  ) {
    return null;
  }
  return {
    work_object_type: workPackage.work_object_type,
    work_object_id: workPackage.work_object_id,
    physical_context_type: workPackage.physical_context_type,
    physical_context_id: workPackage.physical_context_id,
  };
}

function workPackageActionPayload(
  workPackage: FieldWorkPackage,
  payload: Record<string, JsonValue>,
): JsonValue {
  const scope = workObjectScopeForPackage(workPackage);
  return {
    ...payload,
    ...(scope
      ? {
          work_object_type: scope.work_object_type,
          work_object_id: scope.work_object_id,
          physical_context_type: scope.physical_context_type,
          physical_context_id: scope.physical_context_id,
        }
      : {}),
  };
}

function fieldPacketQueryKey(
  session: ReturnType<typeof useSession>,
  jobId: string,
  workPackage: FieldWorkPackage,
) {
  const scope = workObjectScopeForPackage(workPackage);
  return scope
    ? [
        "work-object",
        session.tenant.id,
        session.user.id,
        scope.work_object_type,
        scope.work_object_id,
        scope.physical_context_type,
        scope.physical_context_id,
      ]
    : ["job", session.tenant.id, session.user.id, jobId];
}

function WorkPackagePanel({
  model,
  offline,
  dateOptions,
  captureAllowed,
}: {
  model: WorkPackagePanelModel;
  offline: boolean;
  dateOptions: FieldDateOptions;
  captureAllowed: boolean;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const workPackage = model.packet.work_package;
  const [acknowledgementConfirmed, setAcknowledgementConfirmed] = useState(false);
  const [stopReason, setStopReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState<
    "work_package_acknowledgement" | "work_package_stop" | null
  >(null);
  const [savedAction, setSavedAction] = useState<OutboxAction | null>(null);
  const [stopInstructionActive, setStopInstructionActive] = useState(false);
  const [startingWork, setStartingWork] = useState(false);
  const [completingWork, setCompletingWork] = useState(false);

  useEffect(() => {
    if (!savedAction || savedAction.state === "verified" || savedAction.state === "needs_attention")
      return;
    const interval = window.setInterval(() => {
      void getOutboxAction(savedAction.deviceActionId).then(
        (latest) => latest && setSavedAction(latest),
      );
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [savedAction]);

  if (!workPackage) {
    return (
      <section
        className="border-2 border-warning/45 bg-warning-soft p-4 sm:p-5"
        aria-labelledby="work-package-heading"
      >
        <p className="text-sm font-semibold text-warning">Physical work package</p>
        <h2 id="work-package-heading" className="mt-1 text-2xl font-black tracking-[-0.03em]">
          No current released Work Package
        </h2>
        <p className="mt-2 leading-6 text-muted">
          Do not start, resume, release a hold point, or change scope. Reconnect for a current
          issued package or ask production to resolve the assignment.
        </p>
      </section>
    );
  }

  const activeWorkPackage = workPackage;
  const currentWorkerUser = session.user.frappe_user_id ?? session.user.id;
  const currentWorkerInFrozenRoster = activeWorkPackage.acknowledgement.workers.some(
    (worker) =>
      worker.required && worker.worker_user.toLowerCase() === currentWorkerUser.toLowerCase(),
  );
  const canCaptureEvidence =
    captureAllowed && Boolean(activeWorkPackage.release_attempt_id) && currentWorkerInFrozenRoster;
  const canAcknowledge =
    model.allowed_actions.includes("work_package.acknowledge") &&
    Boolean(activeWorkPackage.release_attempt_id) &&
    currentWorkerInFrozenRoster &&
    !workPackage.acknowledgement.current_user_acknowledged;
  const canStop = model.allowed_actions.includes("work_package.stop_work");
  const canAttemptSync = navigator.onLine && !isOfflineSession(session);
  const canStart =
    !offline &&
    !stopInstructionActive &&
    canAttemptSync &&
    workPackage.status === "Acknowledged" &&
    Boolean(activeWorkPackage.release_attempt_id) &&
    currentWorkerInFrozenRoster &&
    workPackage.hold_points
      .filter((holdPoint) => holdPoint.release_phase === "Pre-start")
      .every((holdPoint) => holdPoint.released) &&
    model.allowed_actions.includes("work_package.start");
  const completionAllowed = model.allowed_actions.includes("work_package.complete");
  const canComplete = completionAllowed && !offline && canAttemptSync;

  async function saveWorkPackageAction(kind: "work_package_acknowledgement" | "work_package_stop") {
    setSavingAction(kind);
    setActionError(null);
    try {
      const payload =
        kind === "work_package_acknowledgement"
          ? workPackageActionPayload(activeWorkPackage, {
              work_package_id: activeWorkPackage.id,
              work_package_version: activeWorkPackage.version,
              release_attempt_id: activeWorkPackage.release_attempt_id,
            })
          : workPackageActionPayload(activeWorkPackage, {
              work_package_id: activeWorkPackage.id,
              work_package_version: activeWorkPackage.version,
              blocker_reason: stopReason.trim(),
            });
      const action = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind,
        endpoint: workPackageActionEndpoint(
          model.job.id,
          kind,
          workObjectScopeForPackage(activeWorkPackage),
        ),
        payload,
      });
      setSavedAction(action);
      const queued = await queueOutboxAction(action.deviceActionId);
      setSavedAction(queued);
      if (!canAttemptSync) return;
      await flushOutbox({
        tenantId: session.tenant.id,
        userId: session.user.id,
        csrfToken: session.csrf_token,
        deviceProof: getDeviceSecret,
      });
      const latest = await getOutboxAction(action.deviceActionId);
      if (latest) setSavedAction(latest);
      await queryClient.invalidateQueries({
        queryKey: fieldPacketQueryKey(session, model.job.id, activeWorkPackage),
      });
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setSavingAction(null);
    }
  }

  function saveAcknowledgement() {
    if (!acknowledgementConfirmed) {
      setActionError("Confirm that you reviewed this exact Work Package before acknowledging it.");
      return;
    }
    void saveWorkPackageAction("work_package_acknowledgement");
  }

  function saveStopWork() {
    if (!stopReason.trim()) {
      setActionError("Describe the condition requiring work to stop.");
      return;
    }
    setStopInstructionActive(true);
    void saveWorkPackageAction("work_package_stop");
  }

  async function startWork() {
    if (!canStart) return;
    setStartingWork(true);
    setActionError(null);
    const deviceActionId = crypto.randomUUID();
    try {
      await apiCommand({
        path: workPackageStartEndpoint(model.job.id, workObjectScopeForPackage(activeWorkPackage)),
        body: {
          device_action_id: deviceActionId,
          payload: workPackageActionPayload(activeWorkPackage, {
            work_package_id: activeWorkPackage.id,
            work_package_version: activeWorkPackage.version,
            release_attempt_id: activeWorkPackage.release_attempt_id,
          }),
        },
        csrfToken: session.csrf_token,
        idempotencyKey: deviceActionId,
        deviceActionId,
        deviceProof: getDeviceSecret,
      });
      await queryClient.invalidateQueries({
        queryKey: fieldPacketQueryKey(session, model.job.id, activeWorkPackage),
      });
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setStartingWork(false);
    }
  }

  async function completeWork() {
    if (!canComplete) return;
    setCompletingWork(true);
    setActionError(null);
    const deviceActionId = crypto.randomUUID();
    try {
      await apiCommand({
        path: workPackageCompleteEndpoint(
          model.job.id,
          workObjectScopeForPackage(activeWorkPackage),
        ),
        body: {
          device_action_id: deviceActionId,
          payload: workPackageActionPayload(activeWorkPackage, {
            work_package_id: activeWorkPackage.id,
            work_package_version: activeWorkPackage.version,
            release_attempt_id: activeWorkPackage.release_attempt_id,
          }),
        },
        csrfToken: session.csrf_token,
        idempotencyKey: deviceActionId,
        deviceActionId,
        deviceProof: getDeviceSecret,
      });
      await queryClient.invalidateQueries({
        queryKey: fieldPacketQueryKey(session, model.job.id, activeWorkPackage),
      });
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setCompletingWork(false);
    }
  }

  return (
    <section
      className="border-2 border-foreground bg-surface-raised"
      aria-labelledby="work-package-heading"
    >
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-muted">Released physical work package</p>
            <h2 id="work-package-heading" className="mt-1 text-2xl font-black tracking-[-0.03em]">
              {workPackage.title}
            </h2>
          </div>
          <p className="border border-border bg-surface px-3 py-2 text-sm font-bold">
            v{workPackage.version} · {workPackage.status}
          </p>
        </div>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3">
          <JobFact
            label="Issued"
            value={formatFieldTimestamp(workPackage.issued_at, dateOptions)}
          />
          <JobFact
            label="Released"
            value={formatFieldTimestamp(workPackage.released_at, dateOptions)}
          />
          <JobFact
            label="Expires"
            value={formatFieldTimestamp(workPackage.expires_at, dateOptions)}
          />
        </dl>
        <dl className="mt-4 grid gap-4 border-t border-border pt-4 text-sm sm:grid-cols-2">
          <JobFact
            label="Work object"
            value={`${workPackage.work_object_type} · ${workPackage.work_object_id}`}
          />
          <JobFact
            label="Physical context"
            value={`${workPackage.physical_context_type} · ${workPackage.physical_context_id}`}
          />
        </dl>
      </header>

      {offline ? (
        <div
          className="flex items-start gap-3 border-b border-warning/35 bg-warning-soft p-4 text-warning"
          role="status"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <p className="font-bold leading-6">
            This is a saved package copy. It may be expired or superseded. You may save an
            acknowledgement or Stop Work report, but neither changes package status or authorizes
            starting, resuming, releasing a hold point, or changing scope.
          </p>
        </div>
      ) : null}

      <div className="space-y-5 p-4 sm:p-5">
        <dl className="grid gap-4 sm:grid-cols-2">
          <JobFact label="Objective" value={workPackage.objective} />
          <JobFact label="Expected result" value={workPackage.expected_result} />
          <JobFact label="Boundaries" value={workPackage.boundaries} />
          <JobFact label="Prerequisites" value={workPackage.prerequisites} />
          <JobFact label="Stop conditions" value={workPackage.stop_conditions} />
          <JobFact label="Make safe" value={workPackage.make_safe_procedure} />
        </dl>

        {workPackage.supersession ? (
          <section
            className="border-2 border-warning/45 bg-warning-soft p-4"
            aria-labelledby="work-package-change-heading"
          >
            <p className="text-sm font-semibold text-warning">Changed condition</p>
            <h3 id="work-package-change-heading" className="mt-1 text-lg font-black">
              This package supersedes {workPackage.supersession.prior_id}
            </h3>
            <p className="mt-2 leading-6">{workPackage.supersession.reason}</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Changed steps:{" "}
              {workPackage.supersession.changed_steps.length
                ? workPackage.supersession.changed_steps.join(", ")
                : "none"}{" "}
              · Changed holds:{" "}
              {workPackage.supersession.changed_hold_points.length
                ? workPackage.supersession.changed_hold_points.join(", ")
                : "none"}
            </p>
          </section>
        ) : null}

        <section aria-labelledby="work-package-steps-heading">
          <h3 id="work-package-steps-heading" className="font-black">
            Ordered steps
          </h3>
          <ol className="mt-3 space-y-3">
            {workPackage.steps.map((step) => (
              <li key={step.sequence} className="border border-border p-4">
                <p className="font-black">
                  Step {step.sequence} · {step.instruction}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Evidence: {step.required_evidence}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Acceptance: {step.acceptance_criteria}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="work-package-holds-heading">
          <h3 id="work-package-holds-heading" className="font-black">
            Hold points
          </h3>
          <ol className="mt-3 space-y-3">
            {workPackage.hold_points.map((holdPoint) => (
              <li
                key={holdPoint.sequence}
                className={
                  holdPoint.released
                    ? "border border-ok/35 bg-ok-soft p-4"
                    : "border border-warning/35 bg-warning-soft p-4"
                }
              >
                <p
                  className={holdPoint.released ? "font-black text-ok" : "font-black text-warning"}
                >
                  Hold {holdPoint.sequence} · {holdPoint.hold_point}
                </p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {holdPoint.released
                    ? "Independently released in the server ledger. A current server capability is still required before starting work."
                    : `Pending independent release by ${holdPoint.release_authority}. Field evidence can be captured, but this app cannot release the hold point.`}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Phase: {holdPoint.release_phase} · Evidence: {holdPoint.required_evidence} ·
                  Acceptance: {holdPoint.acceptance_criteria}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section
          className="border border-border p-4"
          aria-labelledby="work-package-workers-heading"
        >
          <h3 id="work-package-workers-heading" className="font-black">
            Assigned workers
          </h3>
          {workPackage.acknowledgement.workers.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {workPackage.acknowledgement.workers.map((worker) => (
                <li
                  key={worker.worker_user}
                  className={
                    worker.acknowledged
                      ? "border border-ok/35 bg-ok-soft p-3"
                      : "border border-warning/35 bg-warning-soft p-3"
                  }
                >
                  <p className="font-bold">
                    {worker.worker_user} · {worker.worker_role}
                    {worker.required ? " · required" : " · optional"}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted">
                    {worker.acknowledged
                      ? `Acknowledged${worker.acknowledged_at ? ` at ${formatFieldTimestamp(worker.acknowledged_at, dateOptions)}` : ""}.`
                      : "Awaiting acknowledgement of this exact package version."}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm leading-6 text-warning">
              The assigned-worker roster is unavailable in this packet. Starting work remains fail
              closed.
            </p>
          )}
        </section>

        <section
          className="border border-border p-4"
          aria-labelledby="work-package-evidence-heading"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 id="work-package-evidence-heading" className="font-black">
              Evidence slots
            </h3>
            <span className="text-sm font-semibold text-muted">
              {workPackage.evidence_slots.length} captured event
              {workPackage.evidence_slots.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            Captures are append-only and tied to this package version, slot, actor, device, and
            capture time. Corrections add a linked event; they do not erase the prior fact.
          </p>
          <ul className="mt-3 space-y-2">
            {workPackage.steps.map((step) => {
              const slotId = `step:${step.sequence}`;
              const latest = [...workPackage.evidence_slots]
                .reverse()
                .find((item) => item.slot_id === slotId && !item.superseded);
              return (
                <li
                  key={slotId}
                  className="flex flex-wrap items-center justify-between gap-3 border border-border p-3"
                >
                  <div>
                    <p className="font-bold">
                      Step {step.sequence} · {step.required_evidence}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {latest
                        ? `${latest.disposition} · ${latest.freshness} · ${latest.conflict_state}`
                        : "No capture recorded yet"}
                    </p>
                  </div>
                  {canCaptureEvidence ? (
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="inline-flex min-h-11 items-center justify-center border border-foreground px-3 text-sm font-black underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-info focus-visible:outline-offset-3"
                        aria-label={`Capture evidence for step ${step.sequence}`}
                        href={workPackageEvidenceHref(
                          model.job.id,
                          workPackage.id,
                          workPackage.version,
                          workPackage.release_attempt_id ?? "",
                          slotId,
                          step.required_evidence,
                          undefined,
                          workObjectScopeForPackage(workPackage),
                        )}
                      >
                        Capture evidence
                      </a>
                      {latest && sameFieldActor(latest.actor_user, currentWorkerUser) ? (
                        <a
                          className="inline-flex min-h-11 items-center justify-center border border-warning/60 px-3 text-sm font-black text-warning underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-info focus-visible:outline-offset-3"
                          aria-label={`Correct evidence for step ${step.sequence}`}
                          href={workPackageEvidenceHref(
                            model.job.id,
                            workPackage.id,
                            workPackage.version,
                            workPackage.release_attempt_id ?? "",
                            slotId,
                            step.required_evidence,
                            { eventId: latest.event_id, evidenceItem: latest.evidence_item },
                            workObjectScopeForPackage(workPackage),
                          )}
                        >
                          Correct evidence
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-sm font-semibold text-muted">
                      Current field capture permission required
                    </span>
                  )}
                </li>
              );
            })}
            {workPackage.hold_points.map((holdPoint) => {
              const slotId = `hold:${holdPoint.sequence}`;
              const latest = [...workPackage.evidence_slots]
                .reverse()
                .find((item) => item.slot_id === slotId && !item.superseded);
              return (
                <li
                  key={slotId}
                  className="flex flex-wrap items-center justify-between gap-3 border border-border p-3"
                >
                  <div>
                    <p className="font-bold">
                      Hold {holdPoint.sequence} · {holdPoint.required_evidence}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      {latest
                        ? `${latest.disposition} · ${latest.freshness} · ${latest.conflict_state}`
                        : "No capture recorded yet"}
                    </p>
                  </div>
                  {canCaptureEvidence ? (
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="inline-flex min-h-11 items-center justify-center border border-foreground px-3 text-sm font-black underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-info focus-visible:outline-offset-3"
                        aria-label={`Capture evidence for hold ${holdPoint.sequence}`}
                        href={workPackageEvidenceHref(
                          model.job.id,
                          workPackage.id,
                          workPackage.version,
                          workPackage.release_attempt_id ?? "",
                          slotId,
                          holdPoint.required_evidence,
                          undefined,
                          workObjectScopeForPackage(workPackage),
                        )}
                      >
                        Capture evidence
                      </a>
                      {latest && sameFieldActor(latest.actor_user, currentWorkerUser) ? (
                        <a
                          className="inline-flex min-h-11 items-center justify-center border border-warning/60 px-3 text-sm font-black text-warning underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-3 focus-visible:outline-info focus-visible:outline-offset-3"
                          aria-label={`Correct evidence for hold ${holdPoint.sequence}`}
                          href={workPackageEvidenceHref(
                            model.job.id,
                            workPackage.id,
                            workPackage.version,
                            workPackage.release_attempt_id ?? "",
                            slotId,
                            holdPoint.required_evidence,
                            { eventId: latest.event_id, evidenceItem: latest.evidence_item },
                            workObjectScopeForPackage(workPackage),
                          )}
                        >
                          Correct evidence
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-sm font-semibold text-muted">
                      Current field capture permission required
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section
          className="border border-border p-4"
          aria-labelledby="work-package-acknowledgement-heading"
        >
          <h3 id="work-package-acknowledgement-heading" className="font-black">
            Individual acknowledgement
          </h3>
          {workPackage.acknowledgement.current_user_acknowledged ? (
            <p className="mt-2 text-sm leading-6 text-ok">
              You acknowledged this exact package
              {workPackage.acknowledgement.acknowledged_at
                ? ` at ${formatFieldTimestamp(workPackage.acknowledgement.acknowledged_at, dateOptions)}`
                : ""}
              .
            </p>
          ) : canAcknowledge ? (
            <>
              <label className="mt-3 flex items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  className="mt-1 size-5"
                  checked={acknowledgementConfirmed}
                  onChange={(event) => setAcknowledgementConfirmed(event.target.checked)}
                />
                I reviewed this exact version, its boundaries, stop conditions, make-safe procedure,
                steps, and hold points.
              </label>
              <Button
                type="button"
                size="field"
                fullWidth
                className="mt-4"
                variant="accent"
                disabled={!acknowledgementConfirmed}
                busy={savingAction === "work_package_acknowledgement"}
                onClick={saveAcknowledgement}
              >
                <Check aria-hidden="true" />
                Acknowledge this package
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm leading-6 text-muted">
              Acknowledgement is unavailable until a current server packet grants it. It is never a
              client-side work authorization.
            </p>
          )}
        </section>

        <section className="border border-border p-4" aria-labelledby="work-package-start-heading">
          <h3 id="work-package-start-heading" className="font-black">
            Start work
          </h3>
          {canStart ? (
            <>
              <p className="mt-2 text-sm leading-6 text-muted">
                This submits a fresh online request against the server's current released and
                acknowledged package. It is not saved for offline replay.
              </p>
              <Button
                type="button"
                size="field"
                fullWidth
                className="mt-4"
                variant="accent"
                busy={startingWork}
                onClick={() => void startWork()}
              >
                Start work from current packet
              </Button>
            </>
          ) : (
            <p className="mt-2 text-sm leading-6 text-muted">
              A fresh online packet and server capability are required to start work. This app never
              resumes work itself.
            </p>
          )}
        </section>

        {completionAllowed ? (
          <section
            className="border-2 border-ok/45 bg-ok-soft p-4"
            aria-labelledby="work-package-completion-heading"
          >
            <h3 id="work-package-completion-heading" className="font-black text-ok">
              Complete work package
            </h3>
            {canComplete ? (
              <>
                <p className="mt-2 text-sm leading-6 text-muted">
                  All current worker acknowledgements, hold releases, and independently accepted
                  evidence gates are present. Completion is an online production-authority action.
                </p>
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  className="mt-4"
                  variant="accent"
                  busy={completingWork}
                  onClick={() => void completeWork()}
                >
                  <Check aria-hidden="true" />
                  Complete from current ledger
                </Button>
              </>
            ) : (
              <p className="mt-2 text-sm leading-6 text-muted">
                Completion stays unavailable until the current online packet proves every required
                gate. No offline or client-only completion is allowed.
              </p>
            )}
          </section>
        ) : null}

        <section
          className="border-2 border-danger/55 bg-danger-soft/45 p-4"
          aria-labelledby="stop-work-heading"
        >
          <h3 id="stop-work-heading" className="font-black text-danger">
            Stop Work
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted">
            If a stop condition applies, stop work now and make the area safe before saving this
            report. A saved report is not a server-verified status change.
          </p>
          {stopInstructionActive ? (
            <p className="mt-3 font-bold leading-6 text-danger" role="alert">
              Stop work now. Follow the make-safe procedure while this report remains saved on the
              device for server verification.
            </p>
          ) : null}
          {canStop ? (
            <>
              <label className="mt-4 block font-bold" htmlFor="work-package-stop-reason">
                What requires work to stop?
              </label>
              <textarea
                id="work-package-stop-reason"
                className="mt-2 min-h-28 w-full border bg-surface p-4"
                maxLength={1000}
                value={stopReason}
                onChange={(event) => setStopReason(event.target.value)}
              />
              <Button
                type="button"
                size="field"
                fullWidth
                className="mt-4"
                variant="danger"
                busy={savingAction === "work_package_stop"}
                onClick={saveStopWork}
              >
                <AlertTriangle aria-hidden="true" />
                Stop Work and save report
              </Button>
            </>
          ) : (
            <p className="mt-3 text-sm leading-6 text-muted">
              This packet cannot submit another Stop Work report. Stop physically if needed and
              contact production immediately.
            </p>
          )}
        </section>

        {actionError ? (
          <p className="font-semibold text-danger" role="alert">
            {actionError}
          </p>
        ) : null}
        {savedAction ? <WorkPackageActionState action={savedAction} /> : null}
        {!offline && !canAttemptSync ? (
          <p className="text-sm leading-6 text-warning" role="status">
            This device needs a current verified sign-in before it can send a saved Work Package
            action.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function WorkPackageActionState({ action }: { action: OutboxAction }) {
  const label =
    action.kind === "work_package_acknowledgement" ? "Acknowledgement" : "Stop Work report";
  const detail =
    action.state === "verified"
      ? "The server verified this intent. Reopen the packet for a current work state."
      : action.state === "needs_attention"
        ? "This saved intent needs review. It did not change package status or unlock work."
        : `${label} is saved on this device and awaits server verification. It does not change package status or unlock work.`;
  return (
    <div
      className="flex flex-wrap items-start justify-between gap-3 border border-border bg-surface-muted p-4"
      role="status"
    >
      <p className="max-w-xl text-sm leading-6 text-muted">{detail}</p>
      <OutboxStateBadge state={action.state} />
    </div>
  );
}

function WorkStatus({
  model,
  blockedGates,
  dateOptions,
}: {
  model: JobResponse;
  blockedGates: JobResponse["gates"];
  dateOptions: FieldDateOptions;
}) {
  const blocked = blockedGates.length > 0;
  return (
    <section
      aria-labelledby="work-status-heading"
      className="border border-border bg-surface-raised"
    >
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <p className="text-sm font-semibold text-muted">Physical production locks</p>
        <h2 id="work-status-heading" className="mt-1 text-2xl font-black tracking-[-0.03em]">
          Work status
        </h2>
      </header>
      <div
        className={
          blocked ? "bg-danger-soft p-4 text-danger sm:p-5" : "bg-surface-muted p-4 sm:p-5"
        }
      >
        <div className="flex items-start gap-3">
          {blocked ? (
            <AlertTriangle className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
          ) : (
            <ClipboardCheck className="mt-0.5 size-6 shrink-0 text-info" aria-hidden="true" />
          )}
          <div>
            <p className="text-lg font-black tracking-[-0.02em]">
              {blocked
                ? `${blockedGates.length} ${blockedGates.length === 1 ? "gate blocks" : "gates block"} scheduled work`
                : model.job.current_gate_state
                  ? `Reported gate state: ${model.job.current_gate_state}`
                  : "No current gate state was returned"}
            </p>
            <p className="mt-1 text-sm leading-6 text-muted">
              {blocked
                ? "A proof capture can document the block; it cannot open, waive, or override a gate."
                : "A reported gate state is not a safety clearance. Review the safety plan and packet detail before work."}
            </p>
          </div>
        </div>
      </div>
      {model.gates.length > 0 ? (
        <ol className="divide-y divide-border">
          {model.gates.map((gate) => (
            <li key={gate.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <GateChip name={gate.name ?? "Production gate"} state={gate.state ?? "Unknown"} />
                {gate.due_at ? (
                  <p className="text-sm font-semibold text-muted">
                    Due {formatFieldSchedule(gate.due_at, dateOptions)}
                  </p>
                ) : null}
              </div>
              {gate.blocker_reason ? (
                <p className="mt-3 font-semibold leading-6">{gate.blocker_reason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function CaptureProofPanel({
  jobId,
  workObjectScope,
  blocked,
  fieldCaptureAllowed,
  fieldRole,
}: {
  jobId: string;
  workObjectScope: TypedWorkObjectScope | null;
  blocked: boolean;
  fieldCaptureAllowed: boolean;
  fieldRole: boolean;
}) {
  if (!fieldCaptureAllowed) {
    return (
      <section
        className="border border-border bg-surface-muted p-4 sm:p-5"
        aria-labelledby="capture-boundary-heading"
      >
        <p className="text-sm font-semibold text-muted">Field evidence boundary</p>
        <h2 id="capture-boundary-heading" className="mt-1 text-xl font-black tracking-[-0.025em]">
          {fieldRole ? "Active assignment required" : "Read-only job packet"}
        </h2>
        <p className="mt-2 leading-6 text-muted">
          {fieldRole
            ? "This account does not have an active assignment with field capture permission for this job."
            : "Only an assigned field account can capture proof from this packet."}
        </p>
      </section>
    );
  }
  return (
    <section
      className="border-2 border-foreground bg-surface-raised p-4 sm:p-5"
      aria-labelledby="capture-proof-heading"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold text-muted">Internal evidence only</p>
          <h2 id="capture-proof-heading" className="mt-1 text-2xl font-black tracking-[-0.03em]">
            {blocked ? "Document the blocked site" : "Document this site"}
          </h2>
          <p className="mt-2 leading-6 text-muted">
            {blocked
              ? "Capture the actual site condition or blocker. This does not change the work lock."
              : "Capture photos, a voice note, or a field note after reviewing this packet."}
          </p>
        </div>
        <Button
          asChild
          size="field"
          variant={blocked ? "outline" : "accent"}
          className="fixed inset-x-4 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-40 lg:static lg:min-w-72"
        >
          <a href={fieldCheckInHref(jobId, workObjectScope)}>
            <Camera aria-hidden="true" />
            {blocked ? "Capture blocker proof" : "Capture job proof"}
          </a>
        </Button>
      </div>
    </section>
  );
}

function SafetyAndAccess({
  model,
  dateOptions,
}: {
  model: JobResponse;
  dateOptions: FieldDateOptions;
}) {
  const safety = model.packet.safety_plan;
  const contact = model.packet.contact;
  const safetyFacts = safety
    ? [
        [
          "Effective",
          safety.effective_date ? formatFieldSchedule(safety.effective_date, dateOptions) : null,
        ],
        ["Hazards", safety.hazard_summary],
        ["Controls", safety.controls],
        ["PPE", safety.ppe_requirements],
        ["Weather limits", safety.weather_limits],
        ["Emergency plan", safety.emergency_plan],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];
  return (
    <section aria-labelledby="safety-access-heading" className="space-y-4">
      <header className="border-b border-border pb-4">
        <p className="text-sm font-semibold text-muted">Packet detail before field capture</p>
        <h2
          id="safety-access-heading"
          className="mt-1 text-2xl font-black tracking-[-0.03em] sm:text-3xl"
        >
          Safety and access
        </h2>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        <article className="border border-border bg-surface-raised p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <HardHat className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <p className="font-black">
                Safety plan{safety?.version ? ` · v${safety.version}` : ""}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {safety?.status ?? "No safety plan was returned in this packet."}
              </p>
            </div>
          </div>
          {safetyFacts.length > 0 ? (
            <dl className="mt-5 space-y-4">
              {safetyFacts.map(([label, value]) => (
                <JobFact key={label} label={label} value={value} />
              ))}
            </dl>
          ) : (
            <p className="mt-5 border-l-4 border-warning pl-3 text-sm font-semibold leading-6 text-warning">
              No plan detail is available here. Its absence does not authorize field work.
            </p>
          )}
        </article>
        <article className="border border-border bg-surface-raised p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <MapPin className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
            <div>
              <p className="font-black">Job contact and access</p>
              <p className="mt-1 text-sm leading-6 text-muted">
                {contact?.display_name ?? "Contact name unavailable"}
              </p>
            </div>
          </div>
          {contact?.phone ? (
            <Button asChild variant="outline" size="field" fullWidth className="mt-5">
              <a href={`tel:${contact.phone}`}>
                <Phone aria-hidden="true" />
                Call job contact
              </a>
            </Button>
          ) : (
            <p className="mt-5 text-sm font-semibold text-muted">Phone unavailable</p>
          )}
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-xs font-extrabold uppercase tracking-[0.1em] text-muted">
              Access instructions
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              {contact?.access_instructions ??
                "Access instructions were not returned in this packet."}
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

function PacketDetails({
  model,
  dateOptions,
}: {
  model: JobResponse;
  dateOptions: FieldDateOptions;
}) {
  const materialCount =
    model.packet.materials.takeoffs.length + model.packet.materials.supplier_orders.length;
  return (
    <section aria-labelledby="packet-details-heading" className="space-y-4">
      <header className="border-b border-border pb-4">
        <p className="text-sm font-semibold text-muted">Supporting packet records</p>
        <h2
          id="packet-details-heading"
          className="mt-1 text-2xl font-black tracking-[-0.03em] sm:text-3xl"
        >
          Packet detail
        </h2>
      </header>
      <div className="divide-y divide-border border-y border-border">
        <PacketDetail title="Approved scope" count={model.packet.scope_clauses.length}>
          {model.packet.scope_clauses.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title={item.title ?? item.type ?? "Scope"}
              detail={item.text}
            />
          ))}
        </PacketDetail>
        <PacketDetail title="Measurements" count={model.packet.measurements.length}>
          {model.packet.measurements.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title={item.provider ?? "Measurement"}
              detail={joinKnown([
                item.review_status,
                item.parsed_at
                  ? `Parsed ${formatFieldSchedule(item.parsed_at, dateOptions)}`
                  : null,
              ])}
            />
          ))}
        </PacketDetail>
        <PacketDetail title="Materials" count={materialCount}>
          {model.packet.materials.takeoffs.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title="Takeoff"
              detail={joinKnown([
                item.status,
                item.prepared_at
                  ? `Prepared ${formatFieldSchedule(item.prepared_at, dateOptions)}`
                  : null,
              ])}
            />
          ))}
          {model.packet.materials.supplier_orders.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title="Supplier order"
              detail={joinKnown([
                item.status,
                item.delivery_notes,
                item.requested_delivery_date
                  ? `Requested ${formatFieldSchedule(item.requested_delivery_date, dateOptions)}`
                  : null,
              ])}
            />
          ))}
        </PacketDetail>
        <PacketDetail title="Change orders" count={model.packet.change_orders.length}>
          {model.packet.change_orders.map((item) => (
            <PacketEvidenceLine
              key={item.id}
              title={item.title ?? item.number ?? "Change order"}
              detail={joinKnown([
                item.status,
                item.scope_delta,
                item.version !== null ? `v${item.version}` : null,
              ])}
            />
          ))}
        </PacketDetail>
      </div>
    </section>
  );
}

function PacketDetail({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details>
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-1 py-4 font-black [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <span className="text-sm font-semibold text-muted">
          {count} {count === 1 ? "record" : "records"}
        </span>
      </summary>
      <div className="space-y-3 border-t border-border pb-5 pt-4">
        {count ? (
          children
        ) : (
          <p className="text-sm leading-6 text-muted">No records were returned in this packet.</p>
        )}
      </div>
    </details>
  );
}

function PacketEvidenceLine({ title, detail }: { title: string; detail: string | null }) {
  return (
    <div className="border-b border-border pb-3 last:border-b-0 last:pb-0">
      <p className="font-bold">{title}</p>
      {detail ? <p className="mt-1 text-sm leading-6 text-muted">{detail}</p> : null}
    </div>
  );
}

function JobFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-extrabold uppercase tracking-[0.1em] text-muted">{label}</dt>
      <dd className="mt-1 font-semibold leading-6">{value}</dd>
    </div>
  );
}

function joinKnown(values: Array<string | null>): string | null {
  const known = values.filter((value): value is string => Boolean(value));
  return known.length > 0 ? known.join(" · ") : null;
}

function sameFieldActor(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function workPackageActionEndpoint(
  jobId: string,
  kind: "work_package_acknowledgement" | "work_package_stop",
  scope: TypedWorkObjectScope | null = null,
): string {
  const base = workPackageEndpointBase(jobId, scope);
  return kind === "work_package_acknowledgement" ? `${base}/acknowledgements` : `${base}/stop-work`;
}

function workPackageStartEndpoint(
  jobId: string,
  scope: TypedWorkObjectScope | null = null,
): string {
  return `${workPackageEndpointBase(jobId, scope)}/start`;
}

function workPackageCompleteEndpoint(
  jobId: string,
  scope: TypedWorkObjectScope | null = null,
): string {
  return `${workPackageEndpointBase(jobId, scope)}/complete`;
}

function workPackageEndpointBase(jobId: string, scope: TypedWorkObjectScope | null): string {
  if (!scope) return `/api/v1/jobs/${encodeURIComponent(jobId)}/work-package`;
  return `/api/v1/work-objects/${encodeURIComponent(scope.work_object_type)}/${encodeURIComponent(scope.work_object_id)}/physical-contexts/${encodeURIComponent(scope.physical_context_type)}/${encodeURIComponent(scope.physical_context_id)}/work-package`;
}

function fieldCheckInHref(jobId: string, scope: TypedWorkObjectScope | null): string {
  if (!scope) return `/check-in/${encodeURIComponent(jobId)}`;
  const query = new URLSearchParams({
    work_object_type: scope.work_object_type,
    work_object_id: scope.work_object_id,
    physical_context_type: scope.physical_context_type,
    physical_context_id: scope.physical_context_id,
  });
  return `/check-in/${encodeURIComponent(jobId)}?${query.toString()}`;
}

function fieldCheckInEndpoint(jobId: string, scope: TypedWorkObjectScope | null): string {
  if (!scope) return `/api/v1/jobs/${encodeURIComponent(jobId)}/check-ins`;
  return `${workObjectEndpointBase(scope)}/check-ins`;
}

function workObjectEndpointBase(scope: TypedWorkObjectScope): string {
  return `/api/v1/work-objects/${encodeURIComponent(scope.work_object_type)}/${encodeURIComponent(scope.work_object_id)}/physical-contexts/${encodeURIComponent(scope.physical_context_type)}/${encodeURIComponent(scope.physical_context_id)}`;
}

function workPackageEvidenceHref(
  jobId: string,
  workPackageId: string,
  version: number,
  releaseAttemptId: string,
  slotId: string,
  requirement: string,
  correction?: { eventId: string; evidenceItem: string },
  scope: TypedWorkObjectScope | null = null,
): string {
  const query = new URLSearchParams({
    work_package_id: workPackageId,
    work_package_version: String(version),
    evidence_slot_id: slotId,
    evidence_requirement: requirement,
    evidence_source: "field-companion",
    work_package_release_attempt_id: releaseAttemptId,
    ...(correction
      ? {
          evidence_correction_of: correction.eventId,
          evidence_item_correction_of: correction.evidenceItem,
        }
      : {}),
    ...(scope
      ? {
          work_object_type: scope.work_object_type,
          work_object_id: scope.work_object_id,
          physical_context_type: scope.physical_context_type,
          physical_context_id: scope.physical_context_id,
        }
      : {}),
  });
  return `/check-in/${encodeURIComponent(jobId)}?${query.toString()}`;
}

export function CheckInPage() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  if (!jobId) {
    return (
      <RoleGuard surface="field">
        <EmptyState
          title="Choose an assigned job"
          message="Open Today, then open the job packet. Check-ins are always bound to the active Job Assignment."
          action={
            <Button asChild size="field" variant="accent">
              <Link to="/today">Open Today</Link>
            </Button>
          }
        />
      </RoleGuard>
    );
  }
  return <CheckInFlow key={jobId} jobId={jobId} />;
}

type EvidenceCaptureContext = {
  workPackageId: string;
  workPackageVersion: number;
  workPackageReleaseAttemptId: string;
  evidenceSlotId: string;
  evidenceRequirement: string;
  evidenceSource: string;
  evidenceCorrectionOf: string | null;
  evidenceItemCorrectionOf: string | null;
};

function workObjectScopeFromLocation(): TypedWorkObjectScope | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const values = {
    work_object_type: params.get("work_object_type")?.trim() ?? "",
    work_object_id: params.get("work_object_id")?.trim() ?? "",
    physical_context_type: params.get("physical_context_type")?.trim() ?? "",
    physical_context_id: params.get("physical_context_id")?.trim() ?? "",
  };
  const present = Object.values(values).some(Boolean);
  if (!present) return null;
  if (Object.values(values).some((value) => !value)) return null;
  if (values.work_object_type === "Roof Job") return null;
  return values;
}

function toCheckInJobResponse(model: WorkObjectResponse): JobResponse {
  return {
    version: model.version,
    source_updated_at: model.source_updated_at,
    read_model_generated_at: model.read_model_generated_at,
    stale_fields: model.stale_fields,
    permissions: model.permissions,
    allowed_actions: model.allowed_actions,
    job: {
      id: model.work_object.workObjectId,
      roof_job_id: null,
      job_number: null,
      brand: null,
      service_type: model.work_object.workObjectType,
      status: model.work_package?.status ?? null,
      address: `${model.work_object.physicalContextType} · ${model.work_object.physicalContextId}`,
      current_gate_state: null,
    },
    assignment: model.assignment,
    gates: [],
    packet: {
      scope_clauses: [],
      measurements: [],
      materials: { takeoffs: [], supplier_orders: [] },
      change_orders: [],
      safety_plan: null,
      contact: null,
      work_package: model.work_package,
    },
    proof_stream: [],
    proof_page: { next_cursor: null, page_size: 100 },
    required_proof: [],
  };
}

function evidenceCaptureContext(): EvidenceCaptureContext | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const workPackageId = params.get("work_package_id")?.trim() ?? "";
  const evidenceSlotId = params.get("evidence_slot_id")?.trim() ?? "";
  const evidenceRequirement = params.get("evidence_requirement")?.trim() ?? "";
  const workPackageVersion = Number(params.get("work_package_version"));
  const workPackageReleaseAttemptId = params.get("work_package_release_attempt_id")?.trim() ?? "";
  const evidenceCorrectionOf = params.get("evidence_correction_of")?.trim() || null;
  const evidenceItemCorrectionOf = params.get("evidence_item_correction_of")?.trim() || null;
  if (
    !workPackageId ||
    !evidenceSlotId ||
    !evidenceRequirement ||
    !workPackageReleaseAttemptId ||
    !Number.isInteger(workPackageVersion) ||
    workPackageVersion < 1
  ) {
    return null;
  }
  if (Boolean(evidenceCorrectionOf) !== Boolean(evidenceItemCorrectionOf)) return null;
  return {
    workPackageId,
    workPackageVersion,
    workPackageReleaseAttemptId,
    evidenceSlotId,
    evidenceRequirement,
    evidenceSource: params.get("evidence_source")?.trim() || "field-companion",
    evidenceCorrectionOf,
    evidenceItemCorrectionOf,
  };
}

function CheckInFlow({ jobId }: { jobId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const stepPanelRef = useRef<HTMLElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const typedScope = workObjectScopeFromLocation();
  const jobQuery = useQuery({
    queryKey: typedScope
      ? [
          "work-object",
          session.tenant.id,
          session.user.id,
          typedScope.work_object_type,
          typedScope.work_object_id,
          typedScope.physical_context_type,
          typedScope.physical_context_id,
        ]
      : ["job", session.tenant.id, session.user.id, jobId],
    queryFn: async () =>
      typedScope
        ? toCheckInJobResponse(
            await loadWorkObject(session, {
              workObjectType: typedScope.work_object_type,
              workObjectId: typedScope.work_object_id,
              physicalContextType: typedScope.physical_context_type,
              physicalContextId: typedScope.physical_context_id,
            }),
          )
        : loadJob(session, jobId),
  });
  const startedAt = useRef(new Date().toISOString());
  const [step, setStep] = useState(1);
  const [photos, setPhotos] = useState<File[]>([]);
  const [voice, setVoice] = useState<File | null>(null);
  const [proofSlot, setProofSlot] = useState("Production");
  const [notes, setNotes] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [blocker, setBlocker] = useState(false);
  const [blockerCategory, setBlockerCategory] = useState("Safety");
  const [blockerSummary, setBlockerSummary] = useState("");
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
    accuracy: number;
  } | null>(null);
  const [locationPermissionState, setLocationPermissionState] = useState<
    "not_requested" | "granted" | "denied" | "unavailable" | "error"
  >("not_requested");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAction, setSavedAction] = useState<OutboxAction | null>(null);
  const lastScrollStep = useRef(step);
  const typedEvidence = evidenceCaptureContext();

  useEffect(() => {
    if (!savedAction || savedAction.state === "verified" || savedAction.state === "needs_attention")
      return;
    const interval = window.setInterval(() => {
      void getOutboxAction(savedAction.deviceActionId).then(
        (latest) => latest && setSavedAction(latest),
      );
    }, 1000);
    return () => window.clearInterval(interval);
  }, [savedAction]);

  useEffect(() => {
    if (lastScrollStep.current === step) return;
    lastScrollStep.current = step;
    const panel = stepPanelRef.current;
    if (!panel || typeof panel.scrollIntoView !== "function") return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    stepHeadingRef.current?.focus({ preventScroll: true });
  }, [step]);

  if (session.user.role !== "field") {
    return (
      <ErrorState
        title="Assigned field account required"
        message="Office roles can review job packets but cannot submit field capture actions."
      />
    );
  }

  if (jobQuery.isPending) return <LoadingState label="Opening assigned packet…" />;
  if (jobQuery.isError)
    return (
      <ErrorState message={messageFor(jobQuery.error)} onRetry={() => void jobQuery.refetch()} />
    );
  const model = jobQuery.data;
  if (!model.allowed_actions.includes("field.checkin.create")) {
    return (
      <ErrorState
        title="Field capture is not permitted"
        message="This packet does not grant the current field account permission to create a check-in. Return to the job packet and refresh before trying again."
      />
    );
  }
  const assignmentId = model.assignment?.id;
  if (!assignmentId) {
    return (
      <ErrorState
        title="Assignment required"
        message="This job no longer has an active field assignment. Return to Today and refresh."
      />
    );
  }
  const activeAssignmentId = assignmentId;

  function choosePhotos(files: FileList | null) {
    const next = files ? [...files] : [];
    const combined = [...photos, ...next];
    const error = validateMedia([...combined, ...(voice ? [voice] : [])]);
    setFormError(error);
    if (!error) setPhotos(combined);
  }

  function chooseVoice(files: FileList | null) {
    const next = files?.[0] ?? null;
    const error = validateMedia([...photos, ...(next ? [next] : [])]);
    setFormError(error);
    if (!error) setVoice(next);
  }

  function removePhoto(index: number) {
    setPhotos((current) => current.filter((_, currentIndex) => currentIndex !== index));
    setFormError(null);
  }

  function removeVoice() {
    setVoice(null);
    setFormError(null);
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      setLocationPermissionState("unavailable");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setLocationPermissionState("granted");
      },
      (error) => {
        setLocation(null);
        setLocationPermissionState(error.code === error.PERMISSION_DENIED ? "denied" : "error");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  function moveToStep(nextStep: number) {
    setStep(nextStep);
  }

  async function save() {
    const files = [...photos, ...(voice ? [voice] : [])];
    const mediaError = validateMedia(files);
    if (mediaError) return setFormError(mediaError);
    if (files.length === 0 && !notes.trim() && !blocker)
      return setFormError("Add a photo, voice note, field note, or blocker before saving.");
    if (typedEvidence && files.length === 0)
      return setFormError(
        "A Work Package evidence slot requires at least one photo or voice attachment.",
      );
    if (blocker && !blockerSummary.trim())
      return setFormError("Describe what is blocked so the office can act.");
    if (typedEvidence?.evidenceCorrectionOf && !correctionReason.trim())
      return setFormError("Describe why this capture corrects the prior evidence.");
    if (typedEvidence?.evidenceCorrectionOf && files.length !== 1)
      return setFormError("A correction must contain exactly one attachment.");
    setSaving(true);
    setFormError(null);
    try {
      const action = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind: "field_checkin",
        endpoint: fieldCheckInEndpoint(jobId, typedScope),
        payload: {
          assignment_id: activeAssignmentId,
          proof_slot: proofSlot,
          capture_started_at: startedAt.current,
          capture_completed_at: new Date().toISOString(),
          notes: notes.trim() || null,
          blocker,
          blocker_category: blocker ? blockerCategory : null,
          blocker_summary: blocker ? blockerSummary.trim() : null,
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
          location_accuracy_m: location?.accuracy ?? null,
          location_permission_state: locationPermissionState,
          correction_of: null,
          correction_reason: typedEvidence?.evidenceCorrectionOf ? correctionReason.trim() : null,
          evidence_correction_of: typedEvidence?.evidenceCorrectionOf ?? null,
          evidence_item_correction_of: typedEvidence?.evidenceItemCorrectionOf ?? null,
          work_package_release_attempt_id: typedEvidence
            ? typedEvidence.workPackageReleaseAttemptId
            : null,
          customer_safe_requested: false,
          ...(typedEvidence
            ? {
                work_package_id: typedEvidence.workPackageId,
                work_package_version: typedEvidence.workPackageVersion,
                evidence_slot_id: typedEvidence.evidenceSlotId,
                evidence_requirement: typedEvidence.evidenceRequirement,
                evidence_source: typedEvidence.evidenceSource,
                evidence_freshness: "Current",
                evidence_conflict_state: "None",
                evidence_verification: "Verified",
                evidence_disposition: "Open",
              }
            : {}),
        },
        attachments: files.map((file) => ({
          blob: file,
          fileName: file.name,
          lastModified: file.lastModified,
        })),
      });
      setSavedAction(action);
      const queued = await queueOutboxAction(action.deviceActionId);
      setSavedAction(queued);
      setStep(3);
      if (navigator.onLine && session.csrf_token !== "offline-session-no-csrf") {
        await flushOutbox({
          tenantId: session.tenant.id,
          userId: session.user.id,
          csrfToken: session.csrf_token,
          deviceProof: getDeviceSecret,
        });
        const latest = await getOutboxAction(action.deviceActionId);
        if (latest) setSavedAction(latest);
        await queryClient.invalidateQueries({
          queryKey: typedScope
            ? [
                "work-object",
                session.tenant.id,
                session.user.id,
                typedScope.work_object_type,
                typedScope.work_object_id,
                typedScope.physical_context_type,
                typedScope.physical_context_id,
              ]
            : ["job", session.tenant.id, session.user.id, jobId],
        });
      }
    } catch (error) {
      setFormError(messageFor(error));
    } finally {
      setSaving(false);
    }
  }

  const selectedMedia = [...photos, ...(voice ? [voice] : [])];
  const saveMessage =
    navigator.onLine && session.csrf_token !== "offline-session-no-csrf"
      ? "Saves on this device first, then sends while the app stays open."
      : "Saves on this device and queues when this app is open.";

  return (
    <RoleGuard surface="field">
      <section className="mx-auto max-w-3xl space-y-7 pb-16 lg:pb-4">
        <CheckInHeader model={model} step={step} />
        <CheckInProgress step={step} />
        {formError ? (
          <div
            className="border border-danger/35 bg-danger-soft p-4 font-bold leading-6 text-danger"
            role="alert"
          >
            {formError}
          </div>
        ) : null}
        {step === 1 ? (
          <section
            ref={stepPanelRef}
            className="scroll-mt-32 border border-border bg-surface-raised"
            aria-labelledby="capture-evidence-heading"
          >
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold text-muted">Camera and voice before typing</p>
              <h2
                ref={stepHeadingRef}
                id="capture-evidence-heading"
                tabIndex={-1}
                className="mt-1 text-2xl font-black tracking-[-0.03em]"
              >
                Capture what you see
              </h2>
            </header>
            <div className="space-y-4 p-4 sm:p-5">
              <label className="grid min-h-20 cursor-pointer place-items-center border-2 border-foreground bg-foreground px-4 text-center text-background focus-within:outline focus-within:outline-3 focus-within:outline-info focus-within:outline-offset-3">
                <span className="flex items-center gap-2 text-lg font-black">
                  <Camera aria-hidden="true" />
                  Take photos
                </span>
                <span className="mt-1 text-sm font-semibold text-background/75">
                  Up to 12 media files per check-in
                </span>
                <input
                  className="sr-only"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                  capture="environment"
                  multiple
                  onChange={(event) => choosePhotos(event.target.files)}
                />
              </label>
              <label className="grid min-h-16 cursor-pointer place-items-center border border-border bg-surface px-4 text-center text-lg font-black focus-within:outline focus-within:outline-3 focus-within:outline-info focus-within:outline-offset-3">
                <span className="flex items-center gap-2">
                  <Mic aria-hidden="true" />
                  Add voice note
                </span>
                <span className="mt-1 text-sm font-semibold text-muted">
                  Optional internal audio attachment
                </span>
                <input
                  className="sr-only"
                  type="file"
                  accept="audio/mpeg,audio/mp4,audio/webm,audio/wav,audio/x-wav"
                  capture
                  onChange={(event) => chooseVoice(event.target.files)}
                />
              </label>
              <CaptureReview
                photos={photos}
                voice={voice}
                onRemovePhoto={removePhoto}
                onRemoveVoice={removeVoice}
              />
              <details className="border border-border">
                <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 font-bold [&::-webkit-details-marker]:hidden">
                  <span>Evidence type</span>
                  <span className="text-sm text-muted">{proofSlot}</span>
                </summary>
                <div className="border-t border-border p-4">
                  <label className="block text-sm font-bold" htmlFor="proof-slot">
                    Change evidence type
                  </label>
                  <select
                    id="proof-slot"
                    className="mt-3 min-h-16 w-full border bg-surface px-4 text-lg font-bold"
                    value={proofSlot}
                    onChange={(event) => setProofSlot(event.target.value)}
                  >
                    {PROOF_SLOTS.map((slot) => (
                      <option key={slot}>{slot}</option>
                    ))}
                  </select>
                </div>
              </details>
              <p className="border-l-4 border-info pl-3 text-sm font-semibold leading-6 text-info">
                Selected media remains internal. It is only in this form until device save; keep
                this page open.
              </p>
            </div>
            <CheckInActionBar
              message={
                selectedMedia.length
                  ? "Review selected evidence, then add any needed detail."
                  : "You can continue with a note or a blocker report instead of media."
              }
            >
              <Button
                type="button"
                size="field"
                fullWidth
                variant="accent"
                onClick={() => moveToStep(2)}
              >
                Continue to review
                <ChevronRight aria-hidden="true" />
              </Button>
            </CheckInActionBar>
          </section>
        ) : null}
        {step === 2 ? (
          <section
            ref={stepPanelRef}
            className="scroll-mt-32 border border-border bg-surface-raised"
            aria-labelledby="capture-detail-heading"
          >
            <header className="border-b border-border px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold text-muted">
                Only add what the packet does not already prove
              </p>
              <h2
                ref={stepHeadingRef}
                id="capture-detail-heading"
                tabIndex={-1}
                className="mt-1 text-2xl font-black tracking-[-0.03em]"
              >
                Record the condition
              </h2>
            </header>
            <div className="space-y-4 p-4 sm:p-5">
              {typedEvidence?.evidenceCorrectionOf ? (
                <section
                  className="border-2 border-warning/45 bg-warning-soft p-4"
                  aria-labelledby="evidence-correction-heading"
                >
                  <p className="text-sm font-semibold text-warning">Correction of prior evidence</p>
                  <h3 id="evidence-correction-heading" className="mt-1 font-black">
                    This single attachment will supersede the linked capture.
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    The prior event and Evidence Item identities are preserved. Explain the changed
                    condition before saving.
                  </p>
                  <label className="mt-3 block font-bold" htmlFor="evidence-correction-reason">
                    Why is this a correction? <span aria-hidden="true">*</span>
                  </label>
                  <textarea
                    id="evidence-correction-reason"
                    className="mt-2 min-h-28 w-full border bg-surface p-4"
                    maxLength={1000}
                    required
                    value={correctionReason}
                    onChange={(event) => setCorrectionReason(event.target.value)}
                  />
                </section>
              ) : null}
              <Button
                type="button"
                size="field"
                fullWidth
                variant={blocker ? "danger" : "outline"}
                onClick={() => {
                  setBlocker((current) => !current);
                  if (blocker) setBlockerSummary("");
                }}
              >
                <AlertTriangle aria-hidden="true" />
                {blocker ? "Close blocker report" : "Report a blocker"}
              </Button>
              {blocker ? (
                <div className="space-y-4 border border-danger/35 bg-danger-soft p-4">
                  <p className="font-black text-danger">Describe what is holding work.</p>
                  <label className="block font-bold" htmlFor="blocker-category">
                    Blocker type
                  </label>
                  <select
                    id="blocker-category"
                    className="min-h-16 w-full border bg-surface px-4 text-lg font-bold"
                    value={blockerCategory}
                    onChange={(event) => setBlockerCategory(event.target.value)}
                  >
                    {BLOCKER_CATEGORIES.map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                  </select>
                  <label className="block font-bold" htmlFor="blocker-summary">
                    What must happen next?
                  </label>
                  <textarea
                    id="blocker-summary"
                    className="min-h-28 w-full border bg-surface p-4"
                    maxLength={1000}
                    value={blockerSummary}
                    onChange={(event) => setBlockerSummary(event.target.value)}
                  />
                </div>
              ) : null}
              <details className="border border-border">
                <summary className="min-h-16 cursor-pointer px-4 py-4 font-bold">
                  Add field note (optional)
                </summary>
                <div className="border-t border-border p-4">
                  <label className="block font-bold" htmlFor="field-notes">
                    What changed or was completed?
                  </label>
                  <textarea
                    id="field-notes"
                    className="mt-3 min-h-32 w-full border bg-surface p-4 text-base"
                    maxLength={2000}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </div>
              </details>
              <LocationCapture
                location={location}
                permissionState={locationPermissionState}
                onRequest={requestLocation}
              />
            </div>
            <CheckInActionBar message={saveMessage}>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  variant="outline"
                  onClick={() => moveToStep(1)}
                >
                  <ChevronLeft aria-hidden="true" />
                  Back to capture
                </Button>
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  variant="accent"
                  busy={saving}
                  onClick={() => void save()}
                >
                  <Check aria-hidden="true" />
                  Save on device
                </Button>
              </div>
            </CheckInActionBar>
          </section>
        ) : null}
        {step === 3 && savedAction ? (
          <section ref={stepPanelRef} className="scroll-mt-32">
            <CheckInSaved action={savedAction} jobId={jobId} headingRef={stepHeadingRef} />
          </section>
        ) : null}
      </section>
    </RoleGuard>
  );
}

function CheckInHeader({ model, step }: { model: JobResponse; step: number }) {
  return (
    <header className="border-b border-border pb-5 sm:pb-6">
      <p className="text-sm font-semibold text-muted">{model.job.job_number ?? "Assigned job"}</p>
      <h1 className="mt-1 text-3xl font-black tracking-[-0.04em] sm:text-4xl">Capture evidence</h1>
      <p className="mt-2 text-base leading-7 text-muted">
        {model.job.address ?? "Address unavailable"}
      </p>
      <p className="mt-4 text-sm font-semibold text-muted">
        Step {step} of 3 · {step === 1 ? "Capture" : step === 2 ? "Record condition" : "Saved"}
      </p>
    </header>
  );
}

function CheckInProgress({ step }: { step: number }) {
  return (
    <ol className="grid grid-cols-3 border-y border-border" aria-label="Check-in progress">
      {["Capture", "Record", "Saved"].map((label, index) => {
        const active = index + 1 === step;
        const complete = index + 1 < step;
        return (
          <li
            key={label}
            className={`min-h-14 px-2 py-3 text-center text-sm font-bold ${index > 0 ? "border-l border-border" : ""} ${active ? "border-b-4 border-accent text-foreground" : complete ? "text-ok" : "text-muted"}`}
            aria-current={active ? "step" : undefined}
          >
            <span className="block text-xs font-extrabold uppercase tracking-[0.08em]">
              {index + 1}
            </span>
            <span className="mt-0.5 block">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function CaptureReview({
  photos,
  voice,
  onRemovePhoto,
  onRemoveVoice,
}: {
  photos: File[];
  voice: File | null;
  onRemovePhoto: (index: number) => void;
  onRemoveVoice: () => void;
}) {
  const items = [
    ...photos.map((file, index) => ({
      id: `photo:${file.name}:${file.lastModified}:${index}`,
      kind: "Photo",
      file,
      remove: () => onRemovePhoto(index),
    })),
    ...(voice
      ? [
          {
            id: `voice:${voice.name}:${voice.lastModified}`,
            kind: "Voice note",
            file: voice,
            remove: onRemoveVoice,
          },
        ]
      : []),
  ];
  const totalBytes = items.reduce((total, item) => total + item.file.size, 0);
  return (
    <section className="border border-border" aria-labelledby="selected-evidence-heading">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h3 id="selected-evidence-heading" className="font-black">
          Selected evidence
        </h3>
        <p className="text-sm font-semibold text-muted">
          {items.length} of 12 items · {formatBytes(totalBytes)} of 24 MB
        </p>
      </header>
      {items.length === 0 ? (
        <p className="px-4 py-4 text-sm leading-6 text-muted">
          No media selected. A field note or blocker report can still be saved in the next step.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-bold">{item.kind}</p>
                <p className="truncate text-sm text-muted">
                  {item.file.name || `${item.kind} attachment`}
                </p>
              </div>
              <Button
                type="button"
                size="default"
                variant="ghost"
                onClick={item.remove}
                aria-label={`Remove ${item.file.name || item.kind}`}
              >
                <X aria-hidden="true" />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckInActionBar({ message, children }: { message: string; children: ReactNode }) {
  return (
    <div className="border-t border-border bg-surface-raised p-3 sm:p-4">
      <p className="pb-2 text-xs font-semibold leading-5 text-muted">{message}</p>
      {children}
    </div>
  );
}

function LocationCapture({
  location,
  permissionState,
  onRequest,
}: {
  location: { latitude: number; longitude: number; accuracy: number } | null;
  permissionState: "not_requested" | "granted" | "denied" | "unavailable" | "error";
  onRequest: () => void;
}) {
  const status = locationStatus(location, permissionState);
  return (
    <details className="border border-border">
      <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 font-bold [&::-webkit-details-marker]:hidden">
        <span>Add device location (optional)</span>
        <span className="text-sm text-muted">
          {permissionState === "granted" ? "Captured" : "Optional"}
        </span>
      </summary>
      <div className="border-t border-border p-4">
        <p className="text-sm leading-6 text-muted">
          The app records this device's approximate coordinates and accuracy with this check-in. It
          does not prove a crew was onsite.
        </p>
        <Button
          type="button"
          size="field"
          fullWidth
          variant="outline"
          className="mt-4"
          onClick={onRequest}
        >
          <MapPin aria-hidden="true" />
          {permissionState === "granted" ? "Refresh device location" : "Add device location"}
        </Button>
        <p className="mt-3 text-sm font-semibold leading-6 text-muted" role="status">
          {status}
        </p>
      </div>
    </details>
  );
}

function CheckInSaved({
  action,
  jobId,
  headingRef,
}: {
  action: OutboxAction;
  jobId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section className="border-2 border-foreground bg-surface-raised p-4 sm:p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-muted">Device evidence state</p>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="mt-1 text-2xl font-black tracking-[-0.03em]"
          >
            Check-in saved
          </h2>
        </div>
        <OutboxStateBadge state={action.state} />
      </div>
      <p className="mt-4 leading-7 text-muted">
        {action.state === "verified"
          ? "R2 and Frappe verified this exact device action."
          : action.state === "needs_attention"
            ? "Nothing was deleted. This preserved action and its media need review before another attempt."
            : "This action is saved on this device. While the app stays open, it queues and retries safely when it can."}
      </p>
      <Button asChild size="field" fullWidth variant="accent" className="mt-5">
        <Link to="/jobs/$jobId" params={{ jobId }}>
          Return to job packet
        </Link>
      </Button>
    </section>
  );
}

function locationStatus(
  location: { latitude: number; longitude: number; accuracy: number } | null,
  permissionState: "not_requested" | "granted" | "denied" | "unavailable" | "error",
): string {
  if (location && permissionState === "granted")
    return `Location captured · approximate accuracy ${Math.round(location.accuracy)} m.`;
  if (permissionState === "denied") return "Location was not shared because permission was denied.";
  if (permissionState === "unavailable") return "Location is not available on this device.";
  if (permissionState === "error")
    return "Location could not be captured. You can continue without it.";
  return "No device location added.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatFieldDay(value: string, options: FieldDateOptions): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "Date unavailable";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return "Date unavailable";
  return formatWithLocale(
    date,
    options,
    { weekday: "long", month: "short", day: "numeric", year: "numeric" },
    "UTC",
  );
}

function formatFieldTimestamp(value: string, options: FieldDateOptions): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "time unavailable";
  return formatWithLocale(new Date(parsed), options, { dateStyle: "medium", timeStyle: "short" });
}

function formatFieldSchedule(value: string | null, options: FieldDateOptions): string {
  if (!value) return "Not scheduled";
  const floating = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/,
  );
  if (floating) {
    const year = Number(floating[1]);
    const month = Number(floating[2]);
    const day = Number(floating[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    )
      return "Not scheduled";
    const dateText = formatWithLocale(
      date,
      options,
      { month: "short", day: "numeric", year: "numeric" },
      "UTC",
    );
    return floating[4] && floating[5] ? `${dateText} · ${floating[4]}:${floating[5]}` : dateText;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Not scheduled";
  return formatWithLocale(new Date(parsed), options, { dateStyle: "medium", timeStyle: "short" });
}

function formatWithLocale(
  date: Date,
  options: FieldDateOptions,
  format: Intl.DateTimeFormatOptions,
  fallbackTimeZone?: string,
): string {
  try {
    return new Intl.DateTimeFormat(options.locale, {
      ...format,
      timeZone: fallbackTimeZone ?? options.timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      ...format,
      timeZone: fallbackTimeZone,
    }).format(date);
  }
}

function humanizeFieldName(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "This field packet could not be loaded.";
}

function validateMedia(files: File[]): string | null {
  if (files.length > MAX_MEDIA_COUNT)
    return `Use at most ${MAX_MEDIA_COUNT} files per check-in. Submit additional check-ins for large jobs.`;
  if (files.some((file) => !FIELD_MEDIA_TYPES.has(file.type.toLowerCase())))
    return "One file format is not supported. Use a photo or voice-note format listed by the picker.";
  if (files.some((file) => file.size < 1 || file.size > MAX_MEDIA_BYTES))
    return "Each file must be between 1 byte and 12 MB.";
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_ACTION_BYTES)
    return "This check-in is over 24 MB. Split it into smaller check-ins.";
  return null;
}

function dedupeProof(items: ProofStreamItem[]): ProofStreamItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((left, right) => {
    const leftTime = Date.parse(left.occurred_at ?? "") || 0;
    const rightTime = Date.parse(right.occurred_at ?? "") || 0;
    return rightTime - leftTime || right.id.localeCompare(left.id);
  });
}
