import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleGauge,
  Clock3,
  Database,
  Headphones,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Waypoints,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { ErrorState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import { loadNewoOperations } from "./newo-operations-api";
import type {
  NewoOperationsReconciliation,
  NewoOperationsResponse,
  NewoOperationsSession,
  NewoReadinessCheckId,
} from "./newo-operations-contracts";

export function NewoOperationsPage() {
  return (
    <RoleGuard surface="newo">
      <NewoOperationsContent />
    </RoleGuard>
  );
}

function NewoOperationsContent() {
  const session = useSession();
  const query = useQuery({
    queryKey: ["newo-operations", session.tenant.id, session.user.id],
    queryFn: () => loadNewoOperations(),
    staleTime: 30_000,
  });

  if (!query.data && query.isPending) return <NewoOperationsSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Newo operations unavailable"
        message="The authenticated operations read could not be loaded. No call, booking, or control state was changed."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <NewoOperationsSkeleton />;

  return (
    <NewoOperationsScreen
      model={query.data}
      locale={session.tenant.locale}
      timeZone={session.tenant.time_zone}
      refreshFailed={query.isError}
      refreshing={query.isFetching}
      onRefresh={() => void query.refetch()}
    />
  );
}

function NewoOperationsScreen({
  model,
  locale,
  timeZone,
  refreshFailed,
  refreshing,
  onRefresh,
}: {
  model: NewoOperationsResponse;
  locale: string;
  timeZone: string;
  refreshFailed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const format = (value: string | null) => formatDateTime(value, locale, timeZone);
  const generatedAt = format(model.read_model_generated_at);

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <Headphones className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-black text-balance sm:text-4xl">Newo Operations</h1>
                <StateLabel ready={model.status === "ready"} />
              </div>
              <p className="mt-1 text-sm leading-6 text-muted sm:text-base">
                {model.counts.sessions} recorded sessions
                {generatedAt ? <> · Read generated {generatedAt}</> : null}
              </p>
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Refresh Newo operations"
            title="Refresh Newo operations"
            busy={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
        </div>
      </header>

      {refreshFailed ? (
        <div
          className="flex items-center gap-3 border-y border-warning/35 bg-warning-soft px-4 py-3 text-sm"
          role="status"
        >
          <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden="true" />
          <p>Showing the previous operations read because the latest refresh failed.</p>
        </div>
      ) : null}

      <OperationsStatus model={model} />
      <SignalStrip model={model} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0 space-y-9">
          <ExceptionQueues model={model} format={format} />
          <DeliveryRecovery model={model} format={format} />
          <RecentSessions sessions={model.recent_sessions} format={format} />
        </div>
        <aside className="space-y-8">
          <ReadinessPanel model={model} />
          <LaunchState model={model} />
          <ReconciliationPanel model={model} format={format} />
          <UsagePanel model={model} format={format} />
        </aside>
      </div>
    </section>
  );
}

function StateLabel({ ready }: { ready: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold",
        ready ? "bg-ok-soft text-ok" : "bg-warning-soft text-warning",
      )}
    >
      {ready ? (
        <CheckCircle2 className="size-3.5" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-3.5" aria-hidden="true" />
      )}
      {ready ? "Ready" : "Attention"}
    </span>
  );
}

function OperationsStatus({ model }: { model: NewoOperationsResponse }) {
  const incidentText =
    model.counts.unresolved_incidents === null
      ? "Incident status unavailable"
      : `${model.counts.unresolved_incidents} unresolved ${model.counts.unresolved_incidents === 1 ? "incident" : "incidents"}`;
  return (
    <section
      className={cn(
        "border-y px-4 py-4 sm:px-5",
        model.status === "ready" ? "border-ok/30 bg-ok-soft" : "border-warning/35 bg-warning-soft",
      )}
      aria-labelledby="newo-operating-state"
    >
      <div className="flex items-start gap-3">
        {model.status === "ready" ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        ) : (
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        )}
        <div>
          <h2 id="newo-operating-state" className="font-bold">
            {model.status === "ready"
              ? "Reception federation is ready"
              : "Reception federation requires attention"}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {incidentText} · Booking {humanize(model.readiness.booking_mode)} · Outbound{" "}
            {model.readiness.outbound_enabled ? "on" : "off"}
          </p>
        </div>
      </div>
    </section>
  );
}

function SignalStrip({ model }: { model: NewoOperationsResponse }) {
  const recoveryCount =
    model.counts.failed_sync +
    model.counts.failed_events +
    model.counts.dlq_items +
    model.counts.control_failures;
  const signals = [
    {
      label: "Missing reports",
      value: model.counts.missing_reports,
      tone: "text-danger",
      dot: "bg-danger",
    },
    {
      label: "Failed handoffs",
      value: model.counts.failed_handoffs,
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Booking requests",
      value: model.counts.pending_bookings,
      tone: "text-info",
      dot: "bg-info",
    },
    {
      label: "Recovery items",
      value: recoveryCount,
      tone: "text-warning",
      dot: "bg-warning",
    },
  ];
  return (
    <dl
      className="grid grid-cols-2 border-y border-border sm:grid-cols-4"
      aria-label="Newo signals"
    >
      {signals.map((signal, index) => (
        <div
          key={signal.label}
          className={cn(
            "min-h-20 px-3 py-3 sm:min-h-24 sm:px-4 sm:py-4",
            index % 2 === 1 && "border-l border-border",
            index >= 2 && "border-t border-border sm:border-t-0",
            index > 0 && "sm:border-l sm:border-border",
          )}
        >
          <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn("size-2 rounded-full", signal.dot)} aria-hidden="true" />
            {signal.label}
          </dt>
          <dd className={cn("mt-2 text-2xl font-black sm:text-3xl", signal.tone)}>
            {signal.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExceptionQueues({
  model,
  format,
}: {
  model: NewoOperationsResponse;
  format: (value: string | null) => string | null;
}) {
  const queues = [
    {
      id: "missing-reports",
      title: "Missing session reports",
      count: model.counts.missing_reports,
      sessions: model.exceptions.missing_reports,
      icon: Clock3,
      tone: "warning" as const,
      date: (session: NewoOperationsSession) => session.missing_report_detected_at,
      dateLabel: "Detected",
    },
    {
      id: "failed-handoffs",
      title: "Failed handoffs",
      count: model.counts.failed_handoffs,
      sessions: model.exceptions.failed_handoffs,
      icon: Waypoints,
      tone: "danger" as const,
      date: (session: NewoOperationsSession) => session.updated_at,
      dateLabel: "Updated",
    },
    {
      id: "booking-requests",
      title: "Pending appointment requests",
      count: model.counts.pending_bookings,
      sessions: model.exceptions.pending_bookings,
      icon: CalendarClock,
      tone: "info" as const,
      date: (session: NewoOperationsSession) => session.updated_at,
      dateLabel: "Requested",
    },
    {
      id: "sync-failures",
      title: "Downstream sync failures",
      count: model.counts.failed_sync,
      sessions: model.exceptions.sync_failures,
      icon: Database,
      tone: "warning" as const,
      date: (session: NewoOperationsSession) => session.updated_at,
      dateLabel: "Updated",
    },
  ];
  const visible = queues.filter((queue) => queue.count > 0 || queue.sessions.length > 0);

  if (visible.length === 0) {
    return (
      <section className="border-y border-border py-5" aria-labelledby="new-call-exceptions">
        <h2 id="new-call-exceptions" className="text-xl font-black sm:text-2xl">
          Call exceptions
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          No missing reports, failed handoffs, pending appointment requests, or sync failures were
          returned.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-7" aria-labelledby="new-call-exceptions">
      <header>
        <h2 id="new-call-exceptions" className="text-xl font-black sm:text-2xl">
          Call exceptions
        </h2>
      </header>
      {visible.map((queue) => (
        <SessionQueue key={queue.id} {...queue} format={format} />
      ))}
    </section>
  );
}

function SessionQueue({
  id,
  title,
  count,
  sessions,
  icon: Icon,
  tone,
  date,
  dateLabel,
  format,
}: {
  id: string;
  title: string;
  count: number;
  sessions: NewoOperationsSession[];
  icon: LucideIcon;
  tone: "danger" | "warning" | "info";
  date: (session: NewoOperationsSession) => string | null;
  dateLabel: string;
  format: (value: string | null) => string | null;
}) {
  const toneClasses = {
    danger: "bg-danger-soft text-danger",
    warning: "bg-warning-soft text-warning",
    info: "bg-info-soft text-info",
  };
  return (
    <section aria-labelledby={`${id}-heading`}>
      <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <span
            className={cn("grid size-9 shrink-0 place-items-center rounded-md", toneClasses[tone])}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <h3 id={`${id}-heading`} className="font-black sm:text-lg">
            {title}
          </h3>
        </div>
        <span className="text-sm font-bold text-muted">{count}</span>
      </header>
      <ol className="divide-y divide-border border-b border-border">
        {sessions.map((session) => (
          <li key={session.session_id} className="py-4">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="font-mono text-sm font-bold break-all">{session.session_id}</p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  {[session.service, session.division, session.outcome]
                    .filter((value): value is string => Boolean(value))
                    .map(humanize)
                    .join(" · ") || "Session details unavailable"}
                </p>
                <SessionStates session={session} />
              </div>
              <p className="shrink-0 text-sm text-muted sm:text-right">
                {dateLabel}
                <br />
                <span className="font-semibold text-foreground">
                  {format(date(session)) ?? "Unavailable"}
                </span>
              </p>
            </div>
          </li>
        ))}
      </ol>
      {count > sessions.length ? (
        <p className="mt-2 text-xs font-semibold text-muted">
          Showing {sessions.length} of {count}
        </p>
      ) : null}
    </section>
  );
}

function SessionStates({ session }: { session: NewoOperationsSession }) {
  const states = [
    session.handoff_status ? `Handoff ${humanize(session.handoff_status)}` : null,
    session.booking_status ? `Booking ${humanize(session.booking_status)}` : null,
    `Sync ${humanize(session.sync_status)}`,
  ].filter((value): value is string => Boolean(value));
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold text-muted">
      {states.map((state) => (
        <li key={state}>{state}</li>
      ))}
    </ul>
  );
}

function DeliveryRecovery({
  model,
  format,
}: {
  model: NewoOperationsResponse;
  format: (value: string | null) => string | null;
}) {
  const {
    failed_events: events,
    dlq_items: deadLetters,
    control_failures: controls,
  } = model.exceptions;
  const hasItems = events.length > 0 || deadLetters.length > 0 || controls.length > 0;
  if (!hasItems) return null;
  return (
    <section aria-labelledby="delivery-recovery-heading">
      <header className="border-b border-border pb-3">
        <h2 id="delivery-recovery-heading" className="text-xl font-black sm:text-2xl">
          Delivery and control recovery
        </h2>
      </header>
      <ol className="divide-y divide-border border-b border-border">
        {deadLetters.map((item) => (
          <RecoveryRow
            key={`dlq-${item.id}`}
            type="Queue dead letter"
            identity={`DLQ ${item.id}`}
            state={humanize(item.stage)}
            at={format(item.recorded_at)}
            icon={ServerCog}
          />
        ))}
        {events.map((item) => (
          <RecoveryRow
            key={item.event_id}
            type="Provider event"
            identity={item.event_id}
            state={`${humanize(item.status)} · ${item.attempts} attempts · ${humanize(item.event_type)}`}
            at={format(item.last_seen_at)}
            icon={Waypoints}
          />
        ))}
        {controls.map((item) => (
          <RecoveryRow
            key={item.action_id}
            type="Control action"
            identity={item.action_id}
            state={`${humanize(item.status)} · ${humanize(item.operation)}`}
            at={format(item.updated_at)}
            icon={CircleGauge}
          />
        ))}
      </ol>
    </section>
  );
}

function RecoveryRow({
  type,
  identity,
  state,
  at,
  icon: Icon,
}: {
  type: string;
  identity: string;
  state: string;
  at: string | null;
  icon: LucideIcon;
}) {
  return (
    <li className="flex min-w-0 gap-3 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <p className="font-bold">{type}</p>
          <p className="shrink-0 text-sm text-muted">{at ?? "Time unavailable"}</p>
        </div>
        <p className="mt-1 font-mono text-sm break-all">{identity}</p>
        <p className="mt-1 text-sm text-muted">{state}</p>
      </div>
    </li>
  );
}

function RecentSessions({
  sessions,
  format,
}: {
  sessions: NewoOperationsSession[];
  format: (value: string | null) => string | null;
}) {
  return (
    <section aria-labelledby="recent-sessions-heading">
      <header className="flex items-end justify-between gap-3 border-b border-border pb-3">
        <h2 id="recent-sessions-heading" className="text-xl font-black sm:text-2xl">
          Recent sessions
        </h2>
        <span className="text-sm font-semibold text-muted">{sessions.length} shown</span>
      </header>
      {sessions.length === 0 ? (
        <p className="border-b border-border py-5 text-sm leading-6 text-muted">
          No Newo sessions have landed in the owned session store.
        </p>
      ) : (
        <div className="overflow-x-auto border-b border-border">
          <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
            <thead className="text-xs font-bold uppercase text-muted">
              <tr>
                <th className="py-3 pr-4">Session</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="px-4 py-3">Booking</th>
                <th className="px-4 py-3">Sync</th>
                <th className="py-3 pl-4 text-right">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.map((session) => (
                <tr key={session.session_id}>
                  <td className="max-w-48 py-3 pr-4 font-mono text-xs font-bold break-all">
                    {session.session_id}
                  </td>
                  <td className="px-4 py-3">{humanize(session.service ?? "unknown")}</td>
                  <td className="px-4 py-3">{humanize(session.outcome ?? session.status)}</td>
                  <td className="px-4 py-3">{humanize(session.booking_status ?? "none")}</td>
                  <td className="px-4 py-3 font-semibold">{humanize(session.sync_status)}</td>
                  <td className="py-3 pl-4 text-right text-muted">
                    {format(session.updated_at) ?? "Unavailable"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const readinessLabels: Record<NewoReadinessCheckId, string> = {
  owned_database: "Owned database",
  raw_store: "Raw event store",
  enabled: "Newo traffic",
  webhook_credentials: "Webhook credentials",
  api_authentication: "API authentication",
  production_actor: "Production actor",
  report_webhooks: "Report webhooks",
  configuration: "Configuration match",
  queue: "Session queue",
  dlq: "Dead-letter state",
  frappe: "Frappe landing",
  jobnimbus: "JobNimbus bridge",
  booking_mode: "Booking mode",
};

function ReadinessPanel({ model }: { model: NewoOperationsResponse }) {
  return (
    <section aria-labelledby="readiness-heading">
      <header className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <h2 id="readiness-heading" className="text-lg font-black">
          Readiness
        </h2>
        <span
          className={cn(
            "text-xs font-bold uppercase",
            model.readiness.status === "ready" ? "text-ok" : "text-warning",
          )}
        >
          {humanize(model.readiness.status)}
        </span>
      </header>
      <ul className="divide-y divide-border border-b border-border">
        {model.readiness.checks.map((check) => (
          <li
            key={check.id}
            className="flex min-h-10 items-center justify-between gap-3 py-2 text-sm"
          >
            <span>{readinessLabels[check.id]}</span>
            {check.ok ? (
              <CheckCircle2 className="size-4 shrink-0 text-ok" aria-label="Ready" />
            ) : (
              <XCircle className="size-4 shrink-0 text-danger" aria-label="Not ready" />
            )}
          </li>
        ))}
      </ul>
      {model.readiness.drift_reasons.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-bold">Configuration drift</h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-5 text-muted">
            {model.readiness.drift_reasons.map((reason) => (
              <li key={reason} className="break-words">
                {humanize(reason)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function LaunchState({ model }: { model: NewoOperationsResponse }) {
  const rows = [
    ["Reception", model.readiness.enabled ? "Enabled" : "Disabled"],
    ["Booking", humanize(model.readiness.booking_mode)],
    ["Outbound", model.readiness.outbound_enabled ? "Enabled" : "Off"],
    ["Control writes", model.readiness.control_write_enabled ? "Enabled" : "Off"],
  ];
  return (
    <section aria-labelledby="launch-state-heading">
      <h2 id="launch-state-heading" className="border-b border-border pb-3 text-lg font-black">
        Launch state
      </h2>
      <dl className="divide-y divide-border border-b border-border text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-h-10 items-center justify-between gap-3 py-2">
            <dt className="text-muted">{label}</dt>
            <dd className="font-bold">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ReconciliationPanel({
  model,
  format,
}: {
  model: NewoOperationsResponse;
  format: (value: string | null) => string | null;
}) {
  return (
    <section aria-labelledby="reconciliation-heading">
      <h2 id="reconciliation-heading" className="border-b border-border pb-3 text-lg font-black">
        Reconciliation
      </h2>
      <div className="divide-y divide-border border-b border-border">
        <ReconciliationRow
          label="Five minute"
          run={model.reconciliation.five_minute}
          format={format}
        />
        <ReconciliationRow label="Daily" run={model.reconciliation.daily} format={format} />
      </div>
    </section>
  );
}

function ReconciliationRow({
  label,
  run,
  format,
}: {
  label: string;
  run: NewoOperationsReconciliation | null;
  format: (value: string | null) => string | null;
}) {
  return (
    <div className="py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="font-bold">{label}</p>
        <span
          className={cn(
            "font-bold",
            run?.status === "ok" ? "text-ok" : run ? "text-warning" : "text-muted",
          )}
        >
          {run ? humanize(run.status) : "No run"}
        </span>
      </div>
      <p className="mt-1 text-muted">{run ? format(run.ran_at) : "No evidence recorded"}</p>
    </div>
  );
}

function UsagePanel({
  model,
  format,
}: {
  model: NewoOperationsResponse;
  format: (value: string | null) => string | null;
}) {
  const usageLabel =
    model.usage.status === "unavailable_from_documented_api"
      ? "Provider minutes unavailable"
      : humanize(model.usage.status);
  return (
    <section aria-labelledby="usage-heading">
      <h2 id="usage-heading" className="border-b border-border pb-3 text-lg font-black">
        Usage
      </h2>
      <dl className="divide-y divide-border border-b border-border text-sm">
        <div className="py-3">
          <dt className="text-muted">Status</dt>
          <dd className="mt-1 font-bold">{usageLabel}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-3">
          <dt className="text-muted">Minutes</dt>
          <dd className="font-bold">{model.usage.minutes ?? "Unavailable"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-3">
          <dt className="text-muted">Approved limit</dt>
          <dd className="font-bold">{model.usage.limit_minutes ?? "Not set"}</dd>
        </div>
        <div className="py-3">
          <dt className="text-muted">Last check</dt>
          <dd className="mt-1 font-bold">{format(model.usage.checked_at) ?? "Not checked"}</dd>
        </div>
      </dl>
    </section>
  );
}

function NewoOperationsSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading Newo operations"
    >
      <div className="h-20 border-b border-border bg-surface-muted/60" />
      <div className="h-20 border-y border-border bg-surface-muted/50" />
      <div className="grid grid-cols-2 border-y border-border sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-24 border-l border-border bg-surface-muted/40 first:border-l-0"
          />
        ))}
      </div>
    </section>
  );
}

function formatDateTime(value: string | null, locale: string, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return null;
  }
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
