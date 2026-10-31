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
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { useShopReading } from "../components/shop-reading";
import { WorkspaceHeader } from "../components/workspace-header";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ErrorState } from "../components/ui/state-panel";
import { SystemDetails } from "../components/ui/system-details";
import { GateChip } from "../field/gate-chip";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { roleCanAccess, type AppRole } from "../lib/roles";
import { scopes } from "../lib/theme";
import { loadProductionRunway } from "./production-api";
import { GateClearancePanel } from "./production-gate-clearance-panel";
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

const RUNWAY_LANE_PREVIEW_LIMIT = 3;

const laneCopy: Record<
  ProductionRunwayLane,
  { title: string; description: string; icon: LucideIcon; tone: string; iconTone: string }
> = {
  blocked: {
    title: "Work stopped",
    description: "A step, crew, or material issue stops work.",
    icon: AlertTriangle,
    tone: "border-danger/35 bg-danger-soft",
    iconTone: "bg-danger text-danger-foreground",
  },
  scheduled: {
    title: "Start date set",
    description: "A start date is saved. Check every step before the crew goes.",
    icon: CalendarClock,
    tone: "border-info/35 bg-info-soft",
    iconTone: "bg-info text-background",
  },
  needs_assignment: {
    title: "Crew needed",
    description: "This job has no active crew.",
    icon: UserRoundPlus,
    tone: "border-warning/35 bg-warning-soft",
    iconTone: "bg-warning text-background",
  },
  ready_for_review: {
    title: "Ready to check",
    description: "All saved start steps look clear. A person still sets the date.",
    icon: ClipboardCheck,
    tone: "border-ok/35 bg-ok-soft",
    iconTone: "bg-ok text-background",
  },
  needs_verification: {
    title: "Steps need a check",
    description: "A crew is named, but one or more start steps are missing.",
    icon: ShieldCheck,
    tone: "border-border bg-surface-muted",
    iconTone: "bg-foreground text-background",
  },
};

export function ProductionRunwayPage() {
  return (
    <RoleGuard surface="production">
      <ProductionRunwayContent />
    </RoleGuard>
  );
}

function ProductionRunwayContent() {
  const session = useSession();
  const authority = JSON.stringify([
    session.user.role,
    [...session.permissions].sort(),
    [...session.allowed_actions].sort(),
  ]);
  // The session has no public session ID. Keep its CSRF token out of query keys;
  // a local opaque scope rotates when this mounted view's sign-in or grants change.
  const sessionScope = useMemo(
    () => ({
      tenantId: session.tenant.id,
      userId: session.user.id,
      csrfToken: session.csrf_token,
      expiresAt: session.session_expires_at,
      authority,
      cacheScope: crypto.randomUUID(),
    }),
    [session.tenant.id, session.user.id, session.csrf_token, session.session_expires_at, authority],
  );
  const query = useQuery({
    queryKey: [
      "production-runway",
      session.tenant.id,
      session.user.id,
      sessionScope.cacheScope,
      "job-identity-v1",
    ],
    queryFn: ({ signal }) => loadProductionRunway(fetch, signal),
  });
  const authorityRefused =
    query.error instanceof ApiError && [401, 403].includes(query.error.status);
  const model = authorityRefused ? undefined : query.data;

  if (!model && query.isPending) return <ProductionRunwaySkeleton />;
  if (!model && query.isError)
    return <ProductionRunwayError onRetry={() => void query.refetch()} />;
  if (!model) return <ProductionRunwaySkeleton />;

  return (
    <ProductionRunwayScreen
      model={model}
      locale={session.tenant.locale}
      timeZone={session.tenant.time_zone}
      role={session.user.role}
      refreshFailed={query.isError}
      onRetry={() => void query.refetch()}
    />
  );
}

function ProductionRunwayScreen({
  model,
  locale,
  timeZone,
  role,
  refreshFailed,
  onRetry,
}: {
  model: ProductionRunwayResponse;
  locale: string;
  timeZone: string;
  role: AppRole;
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
  const canOpenJob = roleCanAccess(role, "job");
  const canOpenHistory = roleCanAccess(role, "jobHistory");
  const [shopMode, setShopMode] = useShopReading(() =>
    Boolean(window.matchMedia?.("(max-width: 1023px)").matches),
  );
  // Server-derived, not role-derived: the read model already knows whether this
  // session's app user carries the Frappe identity a clearance is attributed to,
  // so a button that would only ever 403 is never drawn.
  const canClearGates = model.allowed_actions.includes("production_gate.clear");

  return (
    <section {...(shopMode ? scopes.shopReading : {})} className="mx-auto max-w-7xl space-y-6 pb-4">
      <WorkspaceHeader
        icon={<CalendarClock aria-hidden="true" />}
        title="Production plan"
        description="Check crews, start dates, safety steps, and material needs. This page does not change a job."
        aside={
          <>
            <p className="text-sm font-bold text-muted">Today</p>
            <h2 className="mt-2 text-xl font-bold tracking-[-0.025em]">
              {model.summary.active_jobs}{" "}
              {model.summary.active_jobs === 1 ? "active job" : "active jobs"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {formatDateTime(model.read_model_generated_at, locale, timeZone)
                ? `List made ${formatDateTime(model.read_model_generated_at, locale, timeZone)}`
                : "List time not found"}
            </p>
            <p className="mt-4 text-sm font-semibold text-foreground">Check stopped work first.</p>
            <Button
              className="mt-3"
              variant="secondary"
              aria-pressed={shopMode}
              onClick={() => setShopMode((current) => !current)}
            >
              <Warehouse aria-hidden="true" />
              {shopMode ? "Shop reading on" : "Shop reading"}
            </Button>
          </>
        }
      />

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
            canOpenJob={canOpenJob}
            canOpenHistory={canOpenHistory}
            canClearGates={canClearGates}
          />
        ))}
      </div>
    </section>
  );
}

function RunwaySignals({ model }: { model: ProductionRunwayResponse }) {
  const signals = [
    {
      label: "Work stopped",
      value: model.summary.blocked,
      tone: "text-danger",
      dot: "bg-danger",
    },
    { label: "Start date set", value: model.summary.scheduled, tone: "text-info", dot: "bg-info" },
    {
      label: "Crew needed",
      value: model.summary.needs_assignment,
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Ready to check",
      value: model.summary.ready_for_review,
      tone: "text-ok",
      dot: "bg-ok",
    },
    {
      label: "Steps to check",
      value: model.summary.needs_verification,
      tone: "text-muted",
      dot: "bg-border-strong",
    },
  ];
  return (
    <Card className="overflow-hidden">
      <dl className="grid grid-cols-2 sm:grid-cols-5" aria-label="Production job counts">
        {signals.map((signal, index) => (
          <div
            key={signal.label}
            className={cn(
              "min-h-20 px-4 py-3 sm:min-h-24 sm:px-4 sm:py-4",
              index % 2 === 1 && "border-l border-border",
              index >= 2 && "border-t border-border sm:border-t-0",
              index > 0 && "sm:border-l sm:border-border",
              index === 4 && "col-span-2 sm:col-span-1",
            )}
          >
            <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
              <span className={cn("size-2 rounded-full", signal.dot)} aria-hidden="true" />
              {signal.label}
            </dt>
            <dd className={cn("mt-2 text-2xl font-bold tracking-[-0.03em]", signal.tone)}>
              {signal.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function DataBoundary({ model }: { model: ProductionRunwayResponse }) {
  const sourceLabels = model.partial_sources.map(humanizeSource);
  const staleLabels = model.stale_fields.map(humanizeSource);
  return (
    <Card className="border-warning/35 bg-warning-soft/45 p-4 sm:p-5">
      <aside aria-label="Production data check">
        <div className="flex items-start gap-3">
          <Clock3 className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="font-bold tracking-[-0.01em]">Some job data is missing</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Do not send a crew until you check the job.
            </p>
            {sourceLabels.length > 0 ? (
              <p className="mt-2 text-sm text-muted">Missing from: {sourceLabels.join(", ")}.</p>
            ) : null}
            {staleLabels.length > 0 ? (
              <p className="mt-1 text-sm text-muted">May be old: {staleLabels.join(", ")}.</p>
            ) : null}
          </div>
        </div>
      </aside>
    </Card>
  );
}

function RunwayLane({
  lane,
  jobs,
  locale,
  timeZone,
  canOpenJob,
  canOpenHistory,
  canClearGates,
}: {
  lane: ProductionRunwayLane;
  jobs: readonly ProductionRunwayJob[];
  locale: string;
  timeZone: string;
  canOpenJob: boolean;
  canOpenHistory: boolean;
  canClearGates: boolean;
}) {
  const copy = laneCopy[lane];
  const Icon = copy.icon;
  const headingId = `production-lane-${lane}`;
  const [expanded, setExpanded] = useState(false);
  const visibleJobs = expanded ? jobs : jobs.slice(0, RUNWAY_LANE_PREVIEW_LIMIT);
  const remaining = jobs.length - RUNWAY_LANE_PREVIEW_LIMIT;
  return (
    <Card className={cn("scroll-mt-28 overflow-hidden", copy.tone)}>
      <section aria-labelledby={headingId}>
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border p-5 sm:p-6">
          <div className="flex min-w-0 items-start gap-3">
            <span className={cn("grid size-9 place-items-center rounded-md", copy.iconTone)}>
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id={headingId} className="text-xl font-bold tracking-[-0.025em] sm:text-2xl">
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
          <ol id={`${headingId}-jobs`} className="grid gap-3 p-3 sm:p-4 lg:grid-cols-2">
            {visibleJobs.map((job) => (
              <li key={job.id}>
                <RunwayJobCard
                  job={job}
                  locale={locale}
                  timeZone={timeZone}
                  canOpenJob={canOpenJob}
                  canOpenHistory={canOpenHistory}
                  canClearGates={canClearGates}
                />
              </li>
            ))}
          </ol>
        ) : (
          <div className="p-5 text-sm leading-6 text-muted sm:p-6">No jobs are in this group.</div>
        )}
        {remaining > 0 ? (
          <footer className="border-t border-border px-4 py-3 sm:px-5">
            <Button
              type="button"
              variant="ghost"
              size="compact"
              aria-controls={`${headingId}-jobs`}
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Show fewer" : `Show ${remaining} more`}
            </Button>
          </footer>
        ) : null}
      </section>
    </Card>
  );
}

function RunwayJobCard({
  job,
  locale,
  timeZone,
  canOpenJob,
  canOpenHistory,
  canClearGates,
}: {
  job: ProductionRunwayJob;
  locale: string;
  timeZone: string;
  canOpenJob: boolean;
  canOpenHistory: boolean;
  canClearGates: boolean;
}) {
  const jobNumber = job.job_number?.trim() || null;
  const schedule = formatDateTime(job.assignment?.scheduled_start ?? null, locale, timeZone);
  const gateCoverage =
    job.gate_coverage === "complete"
      ? `${job.gate_summary.expected} of ${job.gate_summary.expected} start steps found`
      : job.gate_coverage === "incomplete"
        ? "Some start steps are missing"
        : "Start steps are not known";

  return (
    <article className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-muted">{job.brand ?? "Unbranded job"}</p>
          <h3 className="mt-1 break-words text-lg font-bold tracking-[-0.02em] [overflow-wrap:anywhere]">
            <span className="block text-xs font-semibold tracking-normal text-muted">
              Job number
            </span>
            <span>{jobNumber ?? "Not recorded"}</span>
          </h3>
          <p className="mt-1 text-sm text-muted">{job.service_type ?? "Work type not found"}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {canOpenJob ? (
            <Button asChild variant="outline" size="compact">
              <Link
                to="/jobs/$jobId"
                params={{ jobId: job.id }}
                aria-label={jobNumber ? `Open ${jobNumber}` : "Open job with no recorded number"}
              >
                Open job
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
          {canOpenHistory ? (
            <Button asChild variant="quiet" size="compact">
              <Link
                to="/jobs/$jobId/history"
                params={{ jobId: job.id }}
                aria-label={
                  jobNumber ? `History of ${jobNumber}` : "History of job with no recorded number"
                }
              >
                Job record
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <dl className="mt-3 space-y-2 text-sm">
        <div className="min-w-0">
          <dt className="font-semibold text-muted">Customer</dt>
          <dd className="mt-0.5 break-words leading-5 [overflow-wrap:anywhere]">
            {job.customer_display_name ?? "Customer not recorded"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-semibold text-muted">Job site</dt>
          <dd className="mt-0.5 break-words leading-5 [overflow-wrap:anywhere]">
            {job.address ?? "Job site not recorded"}
          </dd>
        </div>
      </dl>

      <dl className="mt-4 grid gap-x-4 gap-y-3 border-y border-border/80 py-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-muted">Crew</dt>
          <dd className="mt-0.5 leading-5">{job.assignment ? "Crew set" : "No crew found"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Start time</dt>
          <dd className="mt-0.5 leading-5">{schedule ?? "No start time found"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Start steps</dt>
          <dd className="mt-0.5 leading-5">{gateCoverage}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Step check</dt>
          <dd className="mt-0.5 leading-5">
            {job.gate_summary.blocked > 0
              ? `${job.gate_summary.blocked} ${job.gate_summary.blocked === 1 ? "step stops" : "steps stop"} work`
              : `${job.gate_summary.ready + job.gate_summary.waived + job.gate_summary.done} saved steps look clear`}
          </dd>
        </div>
      </dl>

      <div className="mt-4">
        <p className="text-sm font-semibold text-muted">Start steps</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {job.scheduling_gates.map((gate) => (
            <GateChip key={gate.name} name={gate.name} state={gate.state ?? "Unavailable"} />
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">
          Final work is checked when the job is done. It is not a start step.
        </p>
        {canClearGates ? <GateClearancePanel job={job} /> : null}
      </div>

      {job.material_attention.length > 0 ? (
        <section
          className="mt-3 rounded-md bg-danger-soft/40 px-3 py-2"
          aria-label="Material issue"
        >
          <p className="text-sm font-semibold text-danger">Material issue</p>
          <ul className="mt-1 space-y-1 text-sm leading-6 text-danger">
            {job.material_attention.map((item, index) => (
              <li key={`${item.status}:${item.requested_delivery_date ?? "unknown"}:${index}`}>
                <span className="font-semibold">
                  {item.status} · Asked for:{" "}
                  {formatDeliveryDate(item.requested_delivery_date, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="mt-3 text-sm font-semibold leading-6 text-foreground">
        Next: {laneNextStep(job.lane)}
      </p>
      <SystemDetails className="mt-3 rounded-lg border border-border" summaryClassName="px-4">
        <dl className="grid gap-3 border-t border-border px-4 py-3 text-sm text-muted sm:grid-cols-2">
          <MetadataLine label="Job ID" value={job.id} />
          <MetadataLine label="Job state" value={job.status ?? "Not found"} />
          <MetadataLine label="Crew record" value={job.assignment?.id ?? "Not found"} />
          <MetadataLine label="Crew state" value={job.assignment?.status ?? "Not found"} />
          <MetadataLine label="Step data" value={job.gate_coverage} />
          <MetadataLine label="Saved next step" value={job.next_action} />
        </dl>
      </SystemDetails>
    </article>
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

function laneNextStep(lane: ProductionRunwayLane): string {
  if (lane === "blocked") return "Clear the issue before you set a start date.";
  if (lane === "scheduled") return "Check every start step before the crew goes.";
  if (lane === "needs_assignment") return "Choose a crew before you set a start date.";
  if (lane === "ready_for_review") return "A manager can check this job for a start date.";
  return "Find the missing start step before you set a date.";
}

function RefreshWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 border-warning/35 bg-warning-soft/45 p-4">
      <p className="text-sm leading-6">
        This may be an old job list. The last load failed. Load again before you act.
      </p>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Load again
      </Button>
    </Card>
  );
}

function ProductionRunwayError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="mx-auto max-w-7xl">
      <ErrorState
        title="Job plan could not load"
        message="Nothing changed. Check your link, then load the job list again."
        action={<Button onClick={onRetry}>Load again</Button>}
      />
    </section>
  );
}

function ProductionRunwaySkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-6"
      aria-busy="true"
      aria-label="Loading the production plan"
    >
      <Card className="h-56 bg-surface-muted/60" />
      <Card className="grid grid-cols-2 overflow-hidden sm:grid-cols-5">
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="min-h-24 border-l border-border bg-surface-muted/45" />
        ))}
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index} className="h-56 bg-surface-muted/40" />
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
  if (!value) return "date not found";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "date not found";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "date not found";
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
