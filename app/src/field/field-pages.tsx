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
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { getDeviceSecret } from "../auth/device-credential";
import { OutboxStateBadge } from "../components/outbox-state-badge";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { getOutboxAction, queueOutboxAction, saveOutboxAction } from "../storage/outbox";
import { flushOutbox } from "../storage/outbox-processor";
import type { OutboxAction } from "../storage/outbox-types";
import {
  hasCachedJobPacket,
  loadJob,
  loadProofPage,
  loadToday,
  prefetchAssignedPackets,
} from "./field-cache";
import type { JobResponse, ProofStreamItem, TodayResponse } from "./field-contracts";
import { GateChip } from "./gate-chip";
import { ProofStream } from "./proof-stream";

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
type FieldDateOptions = { locale?: string; timeZone?: string };

export function TodayPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [packetAvailability, setPacketAvailability] = useState<Record<string, PacketAvailability>>(
    {},
  );
  const [packetRefreshCycle, setPacketRefreshCycle] = useState(0);
  const query = useQuery({
    queryKey: ["today", session.tenant.id, session.user.id],
    queryFn: () => loadToday(session),
  });
  const today = query.data;

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

  return (
    <section className="mx-auto max-w-5xl space-y-7 pb-4">
      <TodayDispatchHeader
        date={today.date}
        jobCount={today.jobs.length}
        offline={offline}
        generatedAt={today.read_model_generated_at}
        dateOptions={dateOptions}
      />
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
      {today.jobs.length === 0 ? (
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
              {today.jobs.length} {today.jobs.length === 1 ? "assignment" : "assignments"}
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
    <RoleGuard surface="field">
      <section className="mx-auto max-w-5xl space-y-7 pb-8 lg:pb-4">
        <Button asChild variant="ghost" size="compact">
          <Link to="/today">
            <ChevronLeft aria-hidden="true" />
            Today
          </Link>
        </Button>
        <JobPacketHeader model={model} offline={offline} dateOptions={dateOptions} />
        {offline ? (
          <JobOfflineNotice generatedAt={model.read_model_generated_at} dateOptions={dateOptions} />
        ) : null}
        {dataLimits.length > 0 ? <JobDataLimits fields={dataLimits} /> : null}
        <WorkStatus model={model} blockedGates={blockedGates} dateOptions={dateOptions} />
        <CaptureProofPanel
          jobId={model.job.id}
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
  blocked,
  fieldCaptureAllowed,
  fieldRole,
}: {
  jobId: string;
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
          <Link to="/check-in/$jobId" params={{ jobId }}>
            <Camera aria-hidden="true" />
            {blocked ? "Capture blocker proof" : "Capture job proof"}
          </Link>
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

function CheckInFlow({ jobId }: { jobId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const jobQuery = useQuery({
    queryKey: ["job", session.tenant.id, session.user.id, jobId],
    queryFn: () => loadJob(session, jobId),
  });
  const startedAt = useRef(new Date().toISOString());
  const [step, setStep] = useState(1);
  const [photos, setPhotos] = useState<File[]>([]);
  const [voice, setVoice] = useState<File | null>(null);
  const [proofSlot, setProofSlot] = useState("Production");
  const [notes, setNotes] = useState("");
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
    const error = validateMedia([...next, ...(voice ? [voice] : [])]);
    setFormError(error);
    if (!error) setPhotos(next);
  }

  function chooseVoice(files: FileList | null) {
    const next = files?.[0] ?? null;
    const error = validateMedia([...photos, ...(next ? [next] : [])]);
    setFormError(error);
    if (!error) setVoice(next);
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      setLocationPermissionState("unavailable");
      setFormError("Location is not available on this device. You can continue without it.");
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
        setFormError(null);
      },
      (error) => {
        setLocation(null);
        setLocationPermissionState(error.code === error.PERMISSION_DENIED ? "denied" : "error");
        setFormError("Location was not captured. You can continue without it.");
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  async function save() {
    const files = [...photos, ...(voice ? [voice] : [])];
    const mediaError = validateMedia(files);
    if (mediaError) return setFormError(mediaError);
    if (files.length === 0 && !notes.trim() && !blocker)
      return setFormError("Add a photo, voice note, field note, or blocker before saving.");
    if (blocker && !blockerSummary.trim())
      return setFormError("Describe what is blocked so the office can act.");
    setSaving(true);
    setFormError(null);
    try {
      const action = await saveOutboxAction({
        tenantId: session.tenant.id,
        userId: session.user.id,
        kind: "field_checkin",
        endpoint: `/api/v1/jobs/${encodeURIComponent(jobId)}/check-ins`,
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
          correction_reason: null,
          evidence_correction_of: null,
          customer_safe_requested: false,
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
          queryKey: ["job", session.tenant.id, session.user.id, jobId],
        });
      }
    } catch (error) {
      setFormError(messageFor(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RoleGuard surface="field">
      <section className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          eyebrow={model.job.job_number ?? "Assigned job"}
          title="Field check-in"
          description={model.job.address ?? "Address unavailable"}
        />
        <ol className="grid grid-cols-3 gap-2" aria-label="Check-in progress">
          {["Capture", "Details", "Saved"].map((label, index) => (
            <li
              key={label}
              className={
                index + 1 <= step
                  ? "rounded-lg bg-accent px-2 py-3 text-center text-sm font-black text-accent-foreground"
                  : "rounded-lg bg-surface-muted px-2 py-3 text-center text-sm font-bold text-muted"
              }
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        {formError ? (
          <div
            className="rounded-lg border border-danger/30 bg-danger-soft p-4 font-bold text-danger"
            role="alert"
          >
            {formError}
          </div>
        ) : null}
        {step === 1 ? (
          <Card>
            <CardHeader>
              <CardTitle>Capture proof</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="block text-sm font-extrabold" htmlFor="proof-slot">
                Proof slot
              </label>
              <select
                id="proof-slot"
                className="min-h-16 w-full rounded-lg border bg-surface px-4 text-lg font-bold"
                value={proofSlot}
                onChange={(event) => setProofSlot(event.target.value)}
              >
                {PROOF_SLOTS.map((slot) => (
                  <option key={slot}>{slot}</option>
                ))}
              </select>
              <label className="grid min-h-16 cursor-pointer place-items-center rounded-lg border-2 border-dashed bg-surface p-4 text-center text-lg font-black">
                <span className="flex items-center gap-2">
                  <Camera aria-hidden="true" />
                  Add photos
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
              <p className="text-sm text-muted" role="status">
                {photos.length} photo{photos.length === 1 ? "" : "s"} saved for this action
              </p>
              <label className="grid min-h-16 cursor-pointer place-items-center rounded-lg border-2 border-dashed bg-surface p-4 text-center text-lg font-black">
                <span className="flex items-center gap-2">
                  <Mic aria-hidden="true" />
                  Optional voice note
                </span>
                <input
                  className="sr-only"
                  type="file"
                  accept="audio/mpeg,audio/mp4,audio/webm,audio/wav,audio/x-wav"
                  capture
                  onChange={(event) => chooseVoice(event.target.files)}
                />
              </label>
              <p className="rounded-lg bg-info-soft p-3 text-sm font-bold text-info">
                All field media starts internal. This flow cannot mark it customer-safe.
              </p>
              <Button
                type="button"
                size="field"
                fullWidth
                variant="accent"
                onClick={() => setStep(2)}
              >
                Continue <ChevronRight aria-hidden="true" />
              </Button>
            </CardContent>
          </Card>
        ) : null}
        {step === 2 ? (
          <Card>
            <CardHeader>
              <CardTitle>Details and blockers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <label className="block font-extrabold" htmlFor="field-notes">
                Field note
              </label>
              <textarea
                id="field-notes"
                className="min-h-32 w-full rounded-lg border bg-surface p-4 text-base"
                maxLength={2000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="What changed or was completed?"
              />
              <label className="flex min-h-16 items-center gap-4 rounded-lg border bg-surface px-4 text-lg font-black">
                <input
                  className="size-6"
                  type="checkbox"
                  checked={blocker}
                  onChange={(event) => setBlocker(event.target.checked)}
                />
                Work is blocked
              </label>
              {blocker ? (
                <div className="space-y-4 rounded-lg border border-danger/30 bg-danger-soft p-4">
                  <label className="block font-extrabold" htmlFor="blocker-category">
                    Blocker type
                  </label>
                  <select
                    id="blocker-category"
                    className="min-h-16 w-full rounded-lg border bg-surface px-4 text-lg font-bold"
                    value={blockerCategory}
                    onChange={(event) => setBlockerCategory(event.target.value)}
                  >
                    {BLOCKER_CATEGORIES.map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                  </select>
                  <label className="block font-extrabold" htmlFor="blocker-summary">
                    What must happen next?
                  </label>
                  <textarea
                    id="blocker-summary"
                    className="min-h-28 w-full rounded-lg border bg-surface p-4"
                    maxLength={1000}
                    value={blockerSummary}
                    onChange={(event) => setBlockerSummary(event.target.value)}
                  />
                </div>
              ) : null}
              <Button
                type="button"
                size="field"
                fullWidth
                variant="outline"
                onClick={requestLocation}
              >
                <MapPin aria-hidden="true" />
                {location ? "Location captured" : "Add device location"}
              </Button>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  size="field"
                  fullWidth
                  variant="outline"
                  onClick={() => setStep(1)}
                >
                  <ChevronLeft aria-hidden="true" />
                  Back
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
            </CardContent>
          </Card>
        ) : null}
        {step === 3 && savedAction ? (
          <Card aria-live="polite">
            <CardHeader>
              <div className="flex items-center justify-between gap-4">
                <CardTitle>Check-in saved</CardTitle>
                <OutboxStateBadge state={savedAction.state} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="leading-7 text-muted">
                {savedAction.state === "verified"
                  ? "R2 and Frappe verified this exact device action."
                  : savedAction.state === "needs_attention"
                    ? "Nothing was deleted. The office can review this preserved action and its media."
                    : "It remains on this device and will retry safely while the app is open."}
              </p>
              <Button asChild size="field" fullWidth variant="accent">
                <Link to="/jobs/$jobId" params={{ jobId }}>
                  Return to job
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </section>
    </RoleGuard>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header>
      <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">{eyebrow}</p>
      <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">{title}</h1>
      <p className="mt-3 text-base leading-7 text-muted">{description}</p>
    </header>
  );
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
