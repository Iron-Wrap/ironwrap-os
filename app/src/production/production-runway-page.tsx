import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  RefreshCw,
  ShieldCheck,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";

import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { GateChip } from "../field/gate-chip";
import { Button } from "../components/ui/button";
import { ErrorState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import { loadProductionRunway } from "./production-api";
import type {
  ProductionRunwayJob,
  ProductionRunwayLane,
  ProductionRunwayResponse,
} from "./production-contracts";

const laneOrder: readonly ProductionRunwayLane[] = [
  "blocked",
  "scheduled",
  "needs_assignment",
  "ready_for_review",
  "needs_verification",
];

const laneCopy: Record<
  ProductionRunwayLane,
  { title: string; description: string; icon: LucideIcon; tone: string; iconTone: string }
> = {
  blocked: {
    title: "Blocked",
    description: "A gate, crew assignment, or material exception needs human resolution.",
    icon: AlertTriangle,
    tone: "border-danger/30 bg-danger-soft",
    iconTone: "bg-danger text-white",
  },
  scheduled: {
    title: "Scheduled",
    description: "A recorded schedule is visible; gate coverage still requires review.",
    icon: CalendarClock,
    tone: "border-info/30 bg-info-soft",
    iconTone: "bg-info text-white",
  },
  needs_assignment: {
    title: "Needs a crew",
    description: "No active crew assignment is returned for this active job.",
    icon: UserRoundPlus,
    tone: "border-warning/30 bg-warning-soft",
    iconTone: "bg-warning text-white",
  },
  ready_for_review: {
    title: "Ready to review",
    description:
      "All expected gate rows are returned non-blocking; a human still decides scheduling.",
    icon: ClipboardCheck,
    tone: "border-ok/30 bg-ok-soft",
    iconTone: "bg-ok text-white",
  },
  needs_verification: {
    title: "Needs gate verification",
    description: "An assignment exists, but the required gate record is incomplete or unavailable.",
    icon: ShieldCheck,
    tone: "border-border bg-surface-muted/50",
    iconTone: "bg-foreground text-background",
  },
};

export function ProductionRunwayPage() {
  return (
    <RoleGuard surface="owner">
      <ProductionRunwayContent />
    </RoleGuard>
  );
}

function ProductionRunwayContent() {
  const session = useSession();
  const query = useQuery({
    queryKey: ["production-runway", session.tenant.id, session.user.id],
    queryFn: () => loadProductionRunway(),
  });
  const model = query.data;

  if (!model && query.isPending) return <ProductionRunwaySkeleton />;
  if (!model && query.isError)
    return <ProductionRunwayError onRetry={() => void query.refetch()} />;
  if (!model) return <ProductionRunwaySkeleton />;

  return (
    <ProductionRunwayScreen
      model={model}
      locale={session.tenant.locale}
      timeZone={session.tenant.time_zone}
      refreshFailed={query.isError}
      onRetry={() => void query.refetch()}
    />
  );
}

function ProductionRunwayScreen({
  model,
  locale,
  timeZone,
  refreshFailed,
  onRetry,
}: {
  model: ProductionRunwayResponse;
  locale: string;
  timeZone: string;
  refreshFailed: boolean;
  onRetry: () => void;
}) {
  const lanes = laneOrder.map((lane) => ({
    lane,
    jobs: model.jobs.filter((job) => job.lane === lane),
  }));
  const bounded =
    model.source_updated_at === null ||
    model.partial_sources.length > 0 ||
    model.stale_fields.length > 0;
  const canPrepareSchedule = model.allowed_actions.includes("production_schedule_approval.prepare");

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <CalendarClock className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Production runway
              </h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                Review crew coverage, production gates, and material exceptions in one source-backed
                read. This view does not schedule, dispatch, or alter a job.
              </p>
            </div>
          </div>
          <p className="text-sm text-muted">
            {formatDateTime(model.read_model_generated_at, locale, timeZone)
              ? `Read generated ${formatDateTime(model.read_model_generated_at, locale, timeZone)}`
              : "Read timing unavailable"}
          </p>
        </div>
      </header>

      {refreshFailed ? <RefreshWarning onRetry={onRetry} /> : null}

      <RunwaySignals model={model} />
      {bounded ? <DataBoundary model={model} /> : null}

      <div className="space-y-9">
        {lanes.map(({ lane, jobs }) => (
          <RunwayLane
            key={lane}
            lane={lane}
            jobs={jobs}
            locale={locale}
            timeZone={timeZone}
            canPrepareSchedule={canPrepareSchedule}
          />
        ))}
      </div>
    </section>
  );
}

function RunwaySignals({ model }: { model: ProductionRunwayResponse }) {
  const signals = [
    { label: "Blocked", value: model.summary.blocked, tone: "text-danger", dot: "bg-danger" },
    { label: "Scheduled", value: model.summary.scheduled, tone: "text-info", dot: "bg-info" },
    {
      label: "Needs crew",
      value: model.summary.needs_assignment,
      tone: "text-warning",
      dot: "bg-warning",
    },
    { label: "Review ready", value: model.summary.ready_for_review, tone: "text-ok", dot: "bg-ok" },
    {
      label: "Needs proof",
      value: model.summary.needs_verification,
      tone: "text-muted",
      dot: "bg-surface-muted",
    },
  ];
  return (
    <dl
      className="grid grid-cols-2 border-y border-border sm:grid-cols-5"
      aria-label="Production runway signals"
    >
      {signals.map((signal, index) => (
        <div
          key={signal.label}
          className={cn(
            "min-h-20 px-3 py-3 sm:min-h-24 sm:px-4 sm:py-4",
            index > 0 && "border-l border-border",
            index === 2 && "sm:border-l sm:border-t-0 border-t border-border",
            index === 4 && "col-span-2 sm:col-span-1 border-t border-border sm:border-t-0",
          )}
        >
          <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn("size-2 rounded-full", signal.dot)} aria-hidden="true" />
            {signal.label}
          </dt>
          <dd
            className={cn(
              "mt-1 text-xl font-black tracking-[-0.03em] sm:mt-2 sm:text-2xl",
              signal.tone,
            )}
          >
            {signal.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DataBoundary({ model }: { model: ProductionRunwayResponse }) {
  const sourceLabels = model.partial_sources.map(humanizeSource);
  const staleLabels = model.stale_fields.map(humanizeSource);
  return (
    <aside
      className="border border-warning/35 bg-warning-soft px-4 py-4"
      aria-label="Production data boundary"
    >
      <div className="flex items-start gap-3">
        <Clock3 className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <div>
          <h2 className="font-bold tracking-[-0.01em]">Source boundary needs review</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            This is a bounded read. It does not infer missing gates or make a job safe to dispatch.
          </p>
          {sourceLabels.length > 0 ? (
            <p className="mt-2 text-sm text-muted">Limited source: {sourceLabels.join(", ")}.</p>
          ) : null}
          {staleLabels.length > 0 ? (
            <p className="mt-1 text-sm text-muted">Review: {staleLabels.join(", ")}.</p>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function RunwayLane({
  lane,
  jobs,
  locale,
  timeZone,
  canPrepareSchedule,
}: {
  lane: ProductionRunwayLane;
  jobs: readonly ProductionRunwayJob[];
  locale: string;
  timeZone: string;
  canPrepareSchedule: boolean;
}) {
  const copy = laneCopy[lane];
  const Icon = copy.icon;
  const headingId = `production-lane-${lane}`;
  return (
    <section aria-labelledby={headingId}>
      <header className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div className="flex items-start gap-3">
          <span className={cn("grid size-9 place-items-center rounded-md", copy.iconTone)}>
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h2 id={headingId} className="text-xl font-black tracking-[-0.025em] sm:text-2xl">
              {copy.title}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">{copy.description}</p>
          </div>
        </div>
        <p className="text-sm font-semibold text-muted">
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
        </p>
      </header>
      {jobs.length > 0 ? (
        <ol className="grid gap-3 lg:grid-cols-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <RunwayJobCard
                job={job}
                locale={locale}
                timeZone={timeZone}
                tone={copy.tone}
                canPrepareSchedule={canPrepareSchedule}
              />
            </li>
          ))}
        </ol>
      ) : (
        <div className="border border-dashed border-border px-4 py-5 text-sm leading-6 text-muted">
          No source records currently fall in this lane.
        </div>
      )}
    </section>
  );
}

function RunwayJobCard({
  job,
  locale,
  timeZone,
  tone,
  canPrepareSchedule,
}: {
  job: ProductionRunwayJob;
  locale: string;
  timeZone: string;
  tone: string;
  canPrepareSchedule: boolean;
}) {
  const schedule = formatDateTime(job.assignment?.scheduled_start ?? null, locale, timeZone);
  const gateCoverage =
    job.gate_coverage === "complete"
      ? `${job.gate_summary.expected}/${job.gate_summary.expected} expected gate records returned`
      : job.gate_coverage === "incomplete"
        ? "Expected gate records are incomplete"
        : "Gate coverage is unavailable in this bounded read";

  return (
    <article className={cn("border p-4 sm:p-5", tone)}>
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">
            {job.brand ?? "Unbranded job"}
          </p>
          <h3 className="mt-1 text-lg font-black tracking-[-0.02em]">{job.job_number ?? job.id}</h3>
          <p className="mt-1 text-sm text-muted">
            {[job.service_type, job.status].filter(Boolean).join(" · ") ||
              "Operational state unavailable"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          <Button asChild variant="outline" size="compact">
            <Link
              to="/jobs/$jobId"
              params={{ jobId: job.id }}
              aria-label={`Open ${job.job_number ?? job.id}`}
            >
              Open
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
          {canPrepareSchedule && job.scheduling_preparation_allowed ? (
            <Button asChild variant="outline" size="compact">
              <Link
                to="/production/schedule/$jobId"
                params={{ jobId: job.id }}
                aria-label={`Prepare schedule request for ${job.job_number ?? job.id}`}
              >
                Prepare schedule
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="mt-4 grid gap-x-4 gap-y-3 border-y border-border/80 py-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-muted">Crew assignment</dt>
          <dd className="mt-0.5 leading-5">
            {job.assignment
              ? [
                  job.assignment.type ?? "Assignment",
                  job.assignment.status ?? "Status unavailable",
                ].join(" · ")
              : "No active assignment returned"}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Schedule</dt>
          <dd className="mt-0.5 leading-5">{schedule ?? "No start time returned"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Scheduling-gate coverage</dt>
          <dd className="mt-0.5 leading-5">{gateCoverage}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Gate signals</dt>
          <dd className="mt-0.5 leading-5">
            {job.gate_summary.blocked > 0
              ? `${job.gate_summary.blocked} blocked`
              : `${job.gate_summary.ready + job.gate_summary.waived + job.gate_summary.done} non-blocking returned`}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <p className="text-sm font-semibold text-muted">Scheduling locks</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {job.scheduling_gates.map((gate) => (
            <GateChip key={gate.name} name={gate.name} state={gate.state ?? "Unavailable"} />
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">
          Completion is reviewed at closeout, not before scheduling.
        </p>
      </div>

      {job.material_attention.length > 0 ? (
        <section className="mt-3 border-l-2 border-danger pl-3" aria-label="Material attention">
          <p className="text-sm font-semibold text-danger">Material attention</p>
          <ul className="mt-1 space-y-1 text-sm leading-6 text-danger">
            {job.material_attention.map((item, index) => (
              <li key={`${item.status}:${item.requested_delivery_date ?? "unknown"}:${index}`}>
                <span className="font-semibold">
                  {item.status} · Requested delivery:{" "}
                  {formatDeliveryDate(item.requested_delivery_date, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="mt-3 text-sm leading-6 text-muted">{job.next_action}</p>
    </article>
  );
}

function RefreshWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border border-warning/35 bg-warning-soft px-4 py-3">
      <p className="text-sm leading-6">
        The last refresh failed; the visible runway is the previous read.
      </p>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Retry
      </Button>
    </div>
  );
}

function ProductionRunwayError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="mx-auto max-w-7xl">
      <ErrorState
        title="Production runway is unavailable"
        message="The operating read could not be refreshed. No scheduling or job data was changed."
        action={<Button onClick={onRetry}>Retry</Button>}
      />
    </section>
  );
}

function ProductionRunwaySkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-6"
      aria-busy="true"
      aria-label="Loading production runway"
    >
      <div className="h-24 border-b border-border bg-surface-muted/60" />
      <div className="grid grid-cols-2 border-y border-border sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="min-h-24 border-l border-border bg-surface-muted/45" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <div key={index} className="h-56 border border-border bg-surface-muted/40" />
        ))}
      </div>
    </section>
  );
}

function formatDateTime(value: string | null, locale: string, timeZone: string): string | null {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatDeliveryDate(value: string | null, locale: string): string {
  if (!value) return "Delivery date unavailable";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "Delivery date unavailable";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "Delivery date unavailable";
  }
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  } catch {
    return value;
  }
}

function humanizeSource(value: string): string {
  return value.replace(/[._]/g, " ");
}
