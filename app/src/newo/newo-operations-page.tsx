import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleGauge,
  Clock3,
  Database,
  Headphones,
  PhoneCall,
  RefreshCw,
  ServerCog,
  ShieldAlert,
  Waypoints,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { CapabilityUnavailable } from "../capabilities/capability-unavailable";
import { useCapability } from "../capabilities/capability-signal";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { ErrorState } from "../components/ui/state-panel";
import { SystemDetails } from "../components/ui/system-details";
import { cn } from "../lib/cn";
import { loadNewoOperations } from "./newo-operations-api";
import type {
  NewoOperationsOpenCallback,
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
  // `readiness.enabled` used to be one row in a fact table, at the same visual weight as every
  // other fact. Reception staff need "why is nothing happening" before they read a table, and the
  // table alone could never say whether Newo is off or on-with-unfinished-setup (ELEC-234 §6.5).
  const newo = useCapability("newo");
  const query = useQuery({
    queryKey: ["newo-operations", session.tenant.id, session.user.id],
    queryFn: () => loadNewoOperations(),
    staleTime: 30_000,
  });

  if (!query.data && query.isPending) return <NewoOperationsSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Reception could not load"
        message="Nothing changed. Check the link and try again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <NewoOperationsSkeleton />;

  return (
    <NewoOperationsScreen
      model={query.data}
      capability={<CapabilityUnavailable read={newo} />}
      capabilityKnown={newo.status === "known"}
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
  capability,
  capabilityKnown,
  locale,
  timeZone,
  refreshFailed,
  refreshing,
  onRefresh,
}: {
  capability: ReactNode;
  capabilityKnown: boolean;
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
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background">
                <Headphones className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <h1 className="text-3xl font-bold tracking-[-0.035em] text-balance sm:text-4xl">
                    Reception
                  </h1>
                  <StateLabel ready={model.status === "ready"} />
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Watch calls, booking requests, and calls sent to staff. This page does not call or
                  book for you.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Saved calls</p>
            <h2 className="mt-2 text-xl font-bold tracking-[-0.025em]">
              {model.counts.sessions} {model.counts.sessions === 1 ? "call" : "calls"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {generatedAt ? `List made ${generatedAt}` : "List time not found"}
            </p>
            <Button
              size="compact"
              variant="outline"
              className="mt-4"
              aria-label="Refresh Reception"
              title="Refresh Reception"
              busy={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </header>
      </Card>

      {refreshFailed ? (
        <Notice tone="warning" title="The new list did not load">
          The last saved list is still shown. Try Refresh again.
        </Notice>
      ) : null}

      {capability}
      {/*
        The capability signal is the honest answer. When it could not be read, this page still has
        the Worker's own `enabled` flag, which is a real runtime fact — it simply cannot tell off
        apart from on-with-unfinished-setup, and this says so rather than picking one.
      */}
      {!capabilityKnown && !model.readiness.enabled ? (
        <Notice tone="warning" title="Reception is turned off for this company">
          Calls are not being answered by Newo. IronWrap could not read the capability signal on
          this load, so it cannot say whether the setup behind reception is finished either.
        </Notice>
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
      {ready ? "Ready" : "Check"}
    </span>
  );
}

function OperationsStatus({ model }: { model: NewoOperationsResponse }) {
  const incidentText =
    model.counts.unresolved_incidents === null
      ? "Issue count not found"
      : `${model.counts.unresolved_incidents} open ${model.counts.unresolved_incidents === 1 ? "issue" : "issues"}`;
  return (
    <Card
      className={cn(
        "px-4 py-4 sm:px-5",
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
            {model.status === "ready" ? "Reception is ready" : "Reception needs a check"}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {incidentText} · Booking: {humanize(model.readiness.booking_mode)} · Calls out:{" "}
            {model.readiness.outbound_enabled ? "On" : "Off"}
          </p>
        </div>
      </div>
    </Card>
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
      label: "Reports missing",
      value: model.counts.missing_reports,
      tone: "text-danger",
      dot: "bg-danger",
    },
    {
      label: "Calls not passed on",
      value: model.counts.failed_handoffs,
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Calls to return",
      value: model.counts.open_callbacks,
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Bookings to check",
      value: model.counts.pending_bookings,
      tone: "text-info",
      dot: "bg-info",
    },
    {
      label: "System fixes",
      value: recoveryCount,
      tone: "text-warning",
      dot: "bg-warning",
    },
  ];
  return (
    <Card className="overflow-hidden">
      <dl className="grid grid-cols-2 sm:grid-cols-5" aria-label="Reception counts">
        {signals.map((signal, index) => (
          <div
            key={signal.label}
            className={cn(
              "min-h-20 px-3 py-3 sm:min-h-24 sm:px-4 sm:py-4",
              index % 2 === 1 && "border-l border-border",
              index >= 2 && "border-t border-border sm:border-t-0",
              index > 0 && "sm:border-l sm:border-border",
              index === signals.length - 1 && "col-span-2 sm:col-span-1",
            )}
          >
            <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
              <span className={cn("size-2 rounded-full", signal.dot)} aria-hidden="true" />
              {signal.label}
            </dt>
            <dd className={cn("mt-2 text-2xl font-bold sm:text-3xl", signal.tone)}>
              {signal.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
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
      title: "Call reports missing",
      count: model.counts.missing_reports,
      sessions: model.exceptions.missing_reports,
      icon: Clock3,
      tone: "warning" as const,
      date: (session: NewoOperationsSession) => session.missing_report_detected_at,
      dateLabel: "Found",
    },
    {
      id: "failed-handoffs",
      title: "Calls not passed on",
      count: model.counts.failed_handoffs,
      sessions: model.exceptions.failed_handoffs,
      icon: Waypoints,
      tone: "danger" as const,
      date: (session: NewoOperationsSession) => session.updated_at,
      dateLabel: "Last change",
    },
    {
      id: "booking-requests",
      title: "Booking requests",
      count: model.counts.pending_bookings,
      sessions: model.exceptions.pending_bookings,
      icon: CalendarClock,
      tone: "info" as const,
      date: (session: NewoOperationsSession) => session.updated_at,
      dateLabel: "Asked",
    },
    {
      id: "sync-failures",
      title: "Calls not saved",
      count: model.counts.failed_sync,
      sessions: model.exceptions.sync_failures,
      icon: Database,
      tone: "warning" as const,
      date: (session: NewoOperationsSession) => session.updated_at,
      dateLabel: "Last change",
    },
  ];
  const visible = queues.filter((queue) => queue.count > 0 || queue.sessions.length > 0);
  const hasCallbacks =
    model.counts.open_callbacks > 0 || model.exceptions.open_callbacks.length > 0;

  if (visible.length === 0 && !hasCallbacks) {
    return (
      <Card className="p-5 sm:p-6" aria-labelledby="new-call-exceptions">
        <h2 id="new-call-exceptions" className="text-xl font-bold sm:text-2xl">
          Calls to check
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">No call or booking needs a check.</p>
      </Card>
    );
  }

  return (
    <section className="space-y-7" aria-labelledby="new-call-exceptions">
      <header>
        <h2 id="new-call-exceptions" className="text-xl font-bold sm:text-2xl">
          Calls to check
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">Check the lists below.</p>
      </header>
      {hasCallbacks ? (
        <CallbackQueue
          count={model.counts.open_callbacks}
          callbacks={model.exceptions.open_callbacks}
          format={format}
        />
      ) : null}
      {visible.map((queue) => (
        <SessionQueue key={queue.id} {...queue} format={format} />
      ))}
    </section>
  );
}

function CallbackQueue({
  count,
  callbacks,
  format,
}: {
  count: number;
  callbacks: NewoOperationsOpenCallback[];
  format: (value: string | null) => string | null;
}) {
  const reasons: Record<NewoOperationsOpenCallback["reason"], string> = {
    callback_requested: "Call back requested",
    session_failed: "Call failed",
  };
  const urgencyLabels: Record<NewoOperationsOpenCallback["urgency"], string> = {
    routine: "Routine",
    urgent: "Urgent",
    emergency: "Emergency",
  };
  const urgencyClasses: Record<NewoOperationsOpenCallback["urgency"], string> = {
    routine: "bg-info-soft text-info",
    urgent: "bg-warning-soft text-warning",
    emergency: "bg-danger-soft text-danger",
  };

  return (
    <Card role="region" className="overflow-hidden" aria-labelledby="open-callbacks-heading">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
            <PhoneCall className="size-4" aria-hidden="true" />
          </span>
          <h3 id="open-callbacks-heading" className="font-bold sm:text-lg">
            Calls to return
          </h3>
        </div>
        <span className="text-sm font-bold text-muted">Total reported: {count}</span>
      </header>
      <p className="px-5 py-3 text-sm leading-6 text-muted sm:px-6">
        {callbacks.length} shown here. Most urgent first, then oldest request.
      </p>
      {callbacks.length === 0 ? (
        <p className="border-t border-border px-5 py-4 text-sm leading-6 text-muted sm:px-6">
          Call details are not in this list. Try Refresh.
        </p>
      ) : (
        <ol className="divide-y divide-border border-t border-border">
          {callbacks.map((callback) => (
            <li key={callback.callback_id} className="px-5 py-4 sm:px-6">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-bold tracking-[-0.01em]">{reasons[callback.reason]}</p>
                  <span
                    className={cn(
                      "mt-2 inline-block rounded-md px-2 py-1 text-xs font-semibold",
                      urgencyClasses[callback.urgency],
                    )}
                  >
                    {urgencyLabels[callback.urgency]}
                  </span>
                </div>
                <p className="text-sm text-muted sm:text-right">
                  Requested
                  <br />
                  <span className="font-semibold text-foreground">
                    {format(callback.requested_at) ?? "Request time not found"}
                  </span>
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {callbacks.length > count ? (
        <p className="border-t border-border px-5 py-3 text-sm leading-6 text-warning sm:px-6">
          The total and list differ. Try Refresh.
        </p>
      ) : null}
    </Card>
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
    <Card className="overflow-hidden" aria-labelledby={`${id}-heading`}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <span
            className={cn("grid size-9 shrink-0 place-items-center rounded-md", toneClasses[tone])}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <h3 id={`${id}-heading`} className="font-bold sm:text-lg">
            {title}
          </h3>
        </div>
        <span className="text-sm font-bold text-muted">{count}</span>
      </header>
      <ol className="divide-y divide-border">
        {sessions.map((session) => (
          <li key={session.session_id} className="px-5 py-4 sm:px-6">
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="font-bold tracking-[-0.01em]">
                  {humanize(session.service ?? "Call")} ·{" "}
                  {humanize(session.outcome ?? session.status)}
                </p>
                <p className="mt-1 text-sm leading-6 text-muted capitalize">
                  {[session.division, session.channel, session.direction]
                    .filter((value): value is string => Boolean(value))
                    .map(humanize)
                    .join(" · ") || "Call details not found"}
                </p>
                <SessionStates session={session} />
                <SystemDetails className="mt-3 text-xs text-muted">
                  <p className="break-all leading-5">Call ID {session.session_id}</p>
                </SystemDetails>
              </div>
              <p className="shrink-0 text-sm text-muted sm:text-right">
                {dateLabel}
                <br />
                <span className="font-semibold text-foreground">
                  {format(date(session)) ?? "Time not found"}
                </span>
              </p>
            </div>
          </li>
        ))}
      </ol>
      {count > sessions.length ? (
        <p className="border-t border-border px-5 py-3 text-xs font-semibold text-muted sm:px-6">
          Showing {sessions.length} of {count}
        </p>
      ) : null}
    </Card>
  );
}

function SessionStates({ session }: { session: NewoOperationsSession }) {
  const states = [
    session.handoff_status ? `Pass to staff: ${humanize(session.handoff_status)}` : null,
    session.booking_status ? `Booking: ${humanize(session.booking_status)}` : null,
    `Save: ${humanize(session.sync_status)}`,
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
    <Card className="overflow-hidden" aria-labelledby="delivery-recovery-heading">
      <header className="border-b border-border px-5 py-4 sm:px-6">
        <h2 id="delivery-recovery-heading" className="text-xl font-bold sm:text-2xl">
          System fixes
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          These items need a system check. They do not call or book.
        </p>
      </header>
      <ol className="divide-y divide-border">
        {deadLetters.map((item) => (
          <RecoveryRow
            key={`dlq-${item.id}`}
            type="Saved call list"
            details={`List item ${item.id} · ${humanize(item.stage)}`}
            at={format(item.recorded_at)}
            icon={ServerCog}
          />
        ))}
        {events.map((item) => (
          <RecoveryRow
            key={item.event_id}
            type="Call report"
            details={`${item.event_id} · ${humanize(item.status)}. ${item.attempts} tries. ${humanize(item.event_type)}.`}
            at={format(item.last_seen_at)}
            icon={Waypoints}
          />
        ))}
        {controls.map((item) => (
          <RecoveryRow
            key={item.action_id}
            type="System change"
            details={`${item.action_id} · ${humanize(item.status)}. ${humanize(item.operation)}.`}
            at={format(item.updated_at)}
            icon={CircleGauge}
          />
        ))}
      </ol>
    </Card>
  );
}

function RecoveryRow({
  type,
  details,
  at,
  icon: Icon,
}: {
  type: string;
  details: string;
  at: string | null;
  icon: LucideIcon;
}) {
  return (
    <li className="flex min-w-0 gap-3 px-5 py-4 sm:px-6">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-warning-soft text-warning">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <p className="font-bold">{type}</p>
          <p className="shrink-0 text-sm text-muted">{at ?? "Time not found"}</p>
        </div>
        <p className="mt-1 text-sm text-muted">Needs a check</p>
        <SystemDetails className="mt-2 text-xs text-muted">
          <p className="break-all leading-5">{details}</p>
        </SystemDetails>
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
    <Card className="overflow-hidden" aria-labelledby="recent-sessions-heading">
      <header className="flex items-end justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
        <h2 id="recent-sessions-heading" className="text-xl font-bold sm:text-2xl">
          Latest calls
        </h2>
        <span className="text-sm font-semibold text-muted">{sessions.length} shown</span>
      </header>
      {sessions.length === 0 ? (
        <p className="px-5 py-5 text-sm leading-6 text-muted sm:px-6">No saved calls were found.</p>
      ) : (
        <ol className="divide-y divide-border">
          {sessions.map((session) => (
            <li key={session.session_id} className="px-5 py-4 sm:px-6">
              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-bold tracking-[-0.01em]">
                    {humanize(session.service ?? "Call")}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted">
                    {humanize(session.outcome ?? session.status)}
                  </p>
                  <SessionStates session={session} />
                  <SystemDetails className="mt-3 text-xs text-muted">
                    <p className="break-all leading-5">Call ID {session.session_id}</p>
                  </SystemDetails>
                </div>
                <p className="shrink-0 text-sm font-semibold text-muted sm:text-right">
                  {format(session.updated_at) ?? "Time not found"}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

const readinessLabels: Record<NewoReadinessCheckId, string> = {
  owned_database: "Main save",
  raw_store: "Call log",
  enabled: "Call center",
  webhook_credentials: "Report key",
  api_authentication: "Sign-in",
  production_actor: "Live helper",
  report_webhooks: "Call reports",
  configuration: "Setup match",
  queue: "Call list",
  dlq: "Failed saves",
  frappe: "Main office save",
  jobnimbus: "JobNimbus link",
  booking_mode: "Booking rule",
};

function ReadinessPanel({ model }: { model: NewoOperationsResponse }) {
  return (
    <Card className="overflow-hidden" aria-labelledby="readiness-heading">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 id="readiness-heading" className="text-lg font-bold">
          System checks
        </h2>
        <span
          className={cn(
            "text-xs font-bold",
            model.readiness.status === "ready" ? "text-ok" : "text-warning",
          )}
        >
          {humanize(model.readiness.status)}
        </span>
      </header>
      <ul className="divide-y divide-border">
        {model.readiness.checks.map((check) => (
          <li
            key={check.id}
            className="flex min-h-10 items-center justify-between gap-3 px-5 py-2 text-sm"
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
        <SystemDetails className="border-t border-border px-5 pb-4 text-sm text-muted">
          <ul className="space-y-1.5 leading-5">
            {model.readiness.drift_reasons.map((reason) => (
              <li key={reason} className="break-words">
                {humanize(reason)}
              </li>
            ))}
          </ul>
        </SystemDetails>
      ) : null}
    </Card>
  );
}

function LaunchState({ model }: { model: NewoOperationsResponse }) {
  const rows = [
    ["Reception", model.readiness.enabled ? "On" : "Off"],
    ["Booking", humanize(model.readiness.booking_mode)],
    ["Calls out", model.readiness.outbound_enabled ? "On" : "Off"],
    ["System changes", model.readiness.control_write_enabled ? "On" : "Off"],
  ];
  return (
    <Card className="overflow-hidden" aria-labelledby="launch-state-heading">
      <h2 id="launch-state-heading" className="border-b border-border px-5 py-4 text-lg font-bold">
        Live settings
      </h2>
      <dl className="divide-y divide-border text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-h-10 items-center justify-between gap-3 px-5 py-2">
            <dt className="text-muted">{label}</dt>
            <dd className="font-bold">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
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
    <Card className="overflow-hidden" aria-labelledby="reconciliation-heading">
      <h2
        id="reconciliation-heading"
        className="border-b border-border px-5 py-4 text-lg font-bold"
      >
        Save checks
      </h2>
      <div className="divide-y divide-border px-5">
        <ReconciliationRow
          label="Every 5 min"
          run={model.reconciliation.five_minute}
          format={format}
        />
        <ReconciliationRow label="Each day" run={model.reconciliation.daily} format={format} />
      </div>
    </Card>
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
          {run ? humanize(run.status) : "Not run"}
        </span>
      </div>
      <p className="mt-1 text-muted">{run ? format(run.ran_at) : "No saved check"}</p>
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
      ? "Call time not found"
      : humanize(model.usage.status);
  return (
    <Card className="overflow-hidden" aria-labelledby="usage-heading">
      <h2 id="usage-heading" className="border-b border-border px-5 py-4 text-lg font-bold">
        Call time
      </h2>
      <dl className="divide-y divide-border px-5 text-sm">
        <div className="py-3">
          <dt className="text-muted">Status</dt>
          <dd className="mt-1 font-bold">{usageLabel}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-3">
          <dt className="text-muted">Minutes used</dt>
          <dd className="font-bold">{model.usage.minutes ?? "Not found"}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-3">
          <dt className="text-muted">Time limit</dt>
          <dd className="font-bold">{model.usage.limit_minutes ?? "Not set"}</dd>
        </div>
        <div className="py-3">
          <dt className="text-muted">Last check</dt>
          <dd className="mt-1 font-bold">{format(model.usage.checked_at) ?? "Not checked"}</dd>
        </div>
      </dl>
    </Card>
  );
}

function NewoOperationsSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading Reception"
    >
      <Card className="h-36 bg-surface-muted/60" />
      <Card className="h-20 bg-surface-muted/50" />
      <Card className="grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-24 border-l border-border bg-surface-muted/40 first:border-l-0"
          />
        ))}
      </Card>
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

const plainLabels: Record<string, string> = {
  callback_required: "Call back needed",
  dead: "Failed",
  degraded: "Needs a check",
  disabled: "Off",
  enabled: "On",
  ended: "Done",
  failed: "Failed",
  inconclusive: "Not known",
  inbound: "Call in",
  newo_frappe_sync: "Main office save",
  none: "None",
  not_checked: "Not checked",
  not_ready: "Needs a check",
  ok: "Ready",
  outbound: "Call out",
  pending: "Waiting",
  production_agent_id_missing: "Live helper is not set",
  request_only: "Ask first",
  requested: "Asked",
  session_ended: "Call ended",
  unavailable_from_documented_api: "Time not found",
  update_agent: "Update helper",
};

function humanize(value: string): string {
  return (
    plainLabels[value] ??
    value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}
