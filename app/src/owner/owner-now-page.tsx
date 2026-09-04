import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronRight,
  CircleGauge,
  ClipboardCheck,
  Clock3,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { useSession } from "../auth/session-context";
import { WorkspaceHeader } from "../components/workspace-header";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { RoleGuard } from "../components/role-guard";
import type {
  MeasurementIntakeOwnerException,
  MeasurementIntakeOwnerExceptionsResponse,
  OwnerException,
  OwnerNowResponse,
  OwnerRuntimeResponse,
} from "./owner-contracts";
import { loadMeasurementIntakeExceptions, loadOwnerNow, loadOwnerRuntime } from "./owner-api";
import {
  buildDecisionLanes,
  canOpenJob,
  formatOwnerDate,
  humanizeSource,
  humanizeStaleField,
  mctbEvidenceLabel,
  severityPriority,
  type OwnerDateFormatOptions,
} from "./owner-now-utils";

const DECISION_LANE_PREVIEW_LIMIT = 3;

export function OwnerNowPage() {
  return (
    <RoleGuard surface="owner">
      <OwnerNowContent />
    </RoleGuard>
  );
}

function OwnerNowContent() {
  const session = useSession();
  const query = useQuery({
    queryKey: ["owner-now", session.tenant.id, session.user.id],
    queryFn: () => loadOwnerNow(),
  });
  const measurementQuery = useQuery({
    queryKey: ["measurement-intake-exceptions", session.tenant.id, session.user.id],
    queryFn: () => loadMeasurementIntakeExceptions(),
  });
  const runtimeQuery = useQuery({
    queryKey: ["owner-runtime", session.tenant.id, session.user.id],
    queryFn: () => loadOwnerRuntime(),
    enabled: false,
  });
  const model = query.data;

  if (!model && query.isPending) return <OwnerNowSkeleton />;
  if (!model && query.isError) return <OwnerNowError onRetry={() => void query.refetch()} />;
  if (!model) return <OwnerNowSkeleton />;

  return (
    <OwnerNowScreen
      model={model}
      locale={{ locale: session.tenant.locale, timeZone: session.tenant.time_zone }}
      refreshFailed={query.isError}
      onRetry={() => void query.refetch()}
      measurementExceptions={measurementQuery.data}
      measurementLoading={measurementQuery.isPending}
      measurementRefreshFailed={measurementQuery.isError}
      onRetryMeasurements={() => void measurementQuery.refetch()}
      runtime={runtimeQuery.data}
      runtimeChecking={runtimeQuery.isFetching}
      runtimeFailed={runtimeQuery.isError}
      onCheckRuntime={() => void runtimeQuery.refetch()}
    />
  );
}

function OwnerNowScreen({
  model,
  locale,
  refreshFailed,
  onRetry,
  measurementExceptions,
  measurementLoading,
  measurementRefreshFailed,
  onRetryMeasurements,
  runtime,
  runtimeChecking,
  runtimeFailed,
  onCheckRuntime,
}: {
  model: OwnerNowResponse;
  locale: OwnerDateFormatOptions;
  refreshFailed: boolean;
  onRetry: () => void;
  measurementExceptions: MeasurementIntakeOwnerExceptionsResponse | undefined;
  measurementLoading: boolean;
  measurementRefreshFailed: boolean;
  onRetryMeasurements: () => void;
  runtime: OwnerRuntimeResponse | undefined;
  runtimeChecking: boolean;
  runtimeFailed: boolean;
  onCheckRuntime: () => void;
}) {
  const dueTimingAvailable = !model.stale_fields.includes("exceptions.due_at");
  const lanes = buildDecisionLanes(model.exceptions, { dueTimingAvailable });
  const hasDataLimits =
    model.source_updated_at === null ||
    model.partial_sources.length > 0 ||
    model.stale_fields.length > 0;
  const generatedAt = safeFormattedDate(model.read_model_generated_at, locale);
  const stoppedCount = model.summary.field_blockers + model.summary.blocked_gates;
  const checkCount = model.exceptions.length + (measurementExceptions?.measurements.length ?? 0);

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-6">
      <WorkspaceHeader
        icon={<CircleGauge aria-hidden="true" />}
        title="Now"
        description="See work that needs a choice. IronWrap does not guess when a fact is missing."
        aside={
          <>
            <p className="text-sm font-bold text-muted">Next step</p>
            <h2 className="mt-2 text-xl font-bold tracking-[-0.025em]">
              {stoppedCount > 0
                ? `${stoppedCount} ${stoppedCount === 1 ? "work stop" : "work stops"}`
                : checkCount > 0
                  ? `${checkCount} ${checkCount === 1 ? "item" : "items"} to check`
                  : "No open checks"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {model.summary.active_jobs} open {model.summary.active_jobs === 1 ? "job" : "jobs"}
              {generatedAt ? ` · List made ${generatedAt}` : ""}
            </p>
          </>
        }
      />

      {refreshFailed ? <RefreshWarning onRetry={onRetry} /> : null}

      <DataConfidence model={model} locale={locale} compact className="lg:hidden" />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <main className="min-w-0 space-y-8">
          <DecisionSummary model={model} />
          <RuntimeTruthPanel
            data={runtime}
            checking={runtimeChecking}
            failed={runtimeFailed}
            locale={locale}
            onCheck={onCheckRuntime}
          />
          <MeasurementIntakeExceptionsPanel
            data={measurementExceptions}
            loading={measurementLoading}
            refreshFailed={measurementRefreshFailed}
            locale={locale}
            onRetry={onRetryMeasurements}
          />
          {lanes.length > 0 ? (
            <div className="space-y-9">
              {lanes.map((lane) => (
                <DecisionLane
                  key={lane.id}
                  lane={lane}
                  allowedActions={model.allowed_actions}
                  dueTimingAvailable={dueTimingAvailable}
                  locale={locale}
                />
              ))}
            </div>
          ) : (
            <EmptyDecisionBoard limited={hasDataLimits} generatedAt={generatedAt} />
          )}
        </main>
        <aside className="hidden lg:block">
          <DataConfidence model={model} locale={locale} />
        </aside>
      </div>
    </section>
  );
}

function RuntimeTruthPanel({
  data,
  checking,
  failed,
  locale,
  onCheck,
}: {
  data: OwnerRuntimeResponse | undefined;
  checking: boolean;
  failed: boolean;
  locale: OwnerDateFormatOptions;
  onCheck: () => void;
}) {
  const actionLabel = checking
    ? "Running check"
    : data
      ? "Run again"
      : failed
        ? "Try again"
        : "Run system check";
  if (!data) {
    return (
      <Card className="p-5 sm:p-6" aria-labelledby="system-check-heading">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2
              id="system-check-heading"
              className="scroll-mt-36 text-xl font-bold tracking-[-0.025em] sm:scroll-mt-24"
            >
              System check
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
              Read saved app health. This does not change a job or a linked app.
            </p>
            {failed ? (
              <p className="mt-2 text-sm font-semibold text-warning" role="status">
                The check could not load. Trying again will not change work.
              </p>
            ) : null}
          </div>
          <Button variant="outline" size="compact" busy={checking} onClick={onCheck}>
            <RotateCcw aria-hidden="true" />
            {actionLabel}
          </Button>
        </div>
      </Card>
    );
  }

  const failedChecks = data.readiness.checks.filter((check) => !check.ok);
  const readyChecks = data.readiness.checks.length - failedChecks.length;
  const heartbeat = data.operations.heartbeat;
  const heartbeatState = !heartbeat
    ? "Not found"
    : heartbeat.fresh && heartbeat.reconciled
      ? "Current"
      : "Needs a check";
  const quickBooksState = !data.operations.quickbooks_receipts.available
    ? "Not found"
    : data.operations.quickbooks_receipts.fresh
      ? "Current"
      : "Needs a check";
  const issueCount =
    data.operations.counts.open_dead_letters +
    data.operations.counts.stuck +
    data.operations.counts.frappe_errors +
    data.operations.counts.replay_failed +
    data.operations.counts.replay_stuck +
    data.operations.audit_failures_observed;
  const summaryMetrics = [
    { label: "Checks passed", value: `${readyChecks}/${data.readiness.checks.length}` },
    { label: "App work", value: data.operations.status === "ok" ? "Good" : "Needs a check" },
    { label: "Last app check", value: heartbeatState },
    { label: "Items to fix", value: String(issueCount) },
  ];
  const systemMetrics = [
    {
      label: "Messages not finished",
      value: String(data.operations.counts.open_dead_letters),
    },
    { label: "Work queue items stuck", value: String(data.operations.counts.stuck) },
    { label: "Job record errors", value: String(data.operations.counts.frappe_errors) },
    {
      label: "Failed retry work",
      value: String(data.operations.counts.replay_failed + data.operations.counts.replay_stuck),
    },
    {
      label: `Save record errors in ${data.operations.audit_failure_window_hours} hours`,
      value: String(data.operations.audit_failures_observed),
    },
    { label: "QuickBooks save proof", value: quickBooksState },
  ];
  const generatedAt = safeFormattedDate(data.read_model_generated_at, locale);
  const heartbeatAt = heartbeat ? safeFormattedDate(heartbeat.ran_at, locale) : null;

  return (
    <Card className="p-5 sm:p-6" aria-labelledby="system-check-heading">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="system-check-heading"
              className="scroll-mt-36 text-xl font-bold tracking-[-0.025em] sm:scroll-mt-24"
            >
              System check
            </h2>
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-bold ${data.status === "ready" ? "text-ok" : "text-warning"}`}
            >
              <span
                className={`size-1.5 rounded-full ${data.status === "ready" ? "bg-ok" : "bg-warning"}`}
                aria-hidden="true"
              />
              {data.status === "ready" ? "Ready" : "Needs a check"}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-muted">
            {generatedAt ? `Checked ${generatedAt}. ` : ""}
            This does not prove that customers can use every part.
          </p>
        </div>
        <Button variant="outline" size="compact" busy={checking} onClick={onCheck}>
          <RotateCcw aria-hidden="true" />
          {actionLabel}
        </Button>
      </header>

      {failed ? (
        <p className="mt-3 text-sm text-warning" role="status">
          The last check failed. The old result is still shown.
        </p>
      ) : null}

      <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
        {summaryMetrics.map((metric) => (
          <div key={metric.label} className="bg-surface-raised p-4">
            <dt className="text-sm font-semibold text-muted">{metric.label}</dt>
            <dd className="mt-1 font-bold tracking-[-0.02em] text-foreground">{metric.value}</dd>
          </div>
        ))}
      </dl>
      <details className="group mt-4 rounded-lg border border-border">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 font-bold [&::-webkit-details-marker]:hidden">
          <span>System details</span>
          <ChevronRight
            className="size-5 text-muted transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
        </summary>
        <div className="border-t border-border p-4">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {systemMetrics.map((metric) => (
              <div key={metric.label}>
                <dt className="text-muted">{metric.label}</dt>
                <dd className="mt-0.5 font-bold text-foreground">{metric.value}</dd>
              </div>
            ))}
          </dl>
          {heartbeatAt ? (
            <p className="mt-4 text-sm leading-6 text-muted">Last app check: {heartbeatAt}.</p>
          ) : null}
          <p className="mt-2 text-sm leading-6 text-muted">
            {failedChecks.length > 0
              ? `Checks to fix: ${failedChecks.map((check) => systemCheckName(check.id)).join(", ")}.`
              : "All saved checks passed."}
          </p>
        </div>
      </details>
    </Card>
  );
}

function DecisionSummary({ model }: { model: OwnerNowResponse }) {
  const signals = [
    {
      label: "Work stopped",
      value: model.summary.field_blockers + model.summary.blocked_gates,
      detail: "Crew reports and job gates",
      tone: "text-danger",
      dot: "bg-danger",
    },
    {
      label: "Needs a check",
      value:
        model.summary.open_incidents +
        model.summary.material_exceptions +
        model.summary.finance_exceptions,
      detail: "App, material, and money work",
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Lead checks",
      value: model.summary.untriaged_leads + model.summary.lead_triage_unknown,
      detail: "New leads and reply proof",
      tone: "text-info",
      dot: "bg-info",
    },
  ];
  return (
    <Card className="overflow-hidden">
      <dl className="grid sm:grid-cols-3" aria-label="Work to check">
        {signals.map((signal, index) => (
          <div
            key={signal.label}
            className={`min-h-24 px-5 py-4 ${index > 0 ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
          >
            <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
              <span className={`size-2 rounded-full ${signal.dot}`} aria-hidden="true" />
              {signal.label}
            </dt>
            <dd className={`mt-2 text-2xl font-bold tracking-[-0.03em] ${signal.tone}`}>
              {signal.value}
            </dd>
            <p className="mt-1 text-sm leading-5 text-muted">{signal.detail}</p>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function MeasurementIntakeExceptionsPanel({
  data,
  loading,
  refreshFailed,
  locale,
  onRetry,
}: {
  data: MeasurementIntakeOwnerExceptionsResponse | undefined;
  loading: boolean;
  refreshFailed: boolean;
  locale: OwnerDateFormatOptions;
  onRetry: () => void;
}) {
  if (!data && loading) {
    return (
      <Card className="p-5 sm:p-6" aria-busy="true" aria-label="Loading roof reports">
        <p className="text-sm leading-6 text-muted">Loading roof reports…</p>
      </Card>
    );
  }
  if (!data && refreshFailed) {
    return (
      <Card className="border-warning/35 bg-warning-soft p-5" role="status">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-bold tracking-[-0.015em]">Roof reports could not load</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              No report changed. Check your link, then load the list again.
            </p>
          </div>
          <Button variant="outline" size="compact" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            Load again
          </Button>
        </div>
      </Card>
    );
  }
  if (!data) return null;

  const reports = data.measurements;
  return (
    <Card className="overflow-hidden" aria-labelledby="roof-reports-heading">
      <header className="flex flex-wrap items-end justify-between gap-3 p-5 sm:p-6">
        <div>
          <h2
            id="roof-reports-heading"
            className="text-xl font-bold tracking-[-0.025em] text-balance sm:text-2xl"
          >
            Roof reports to check
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            These reports need a job match or a safe try. This screen cannot change them.
          </p>
        </div>
        <p className="text-sm font-semibold text-muted">
          {reports.length} {reports.length === 1 ? "report" : "reports"}
        </p>
      </header>
      {refreshFailed ? (
        <p
          className="border-t border-warning/35 bg-warning-soft px-5 py-3 text-sm text-muted"
          role="status"
        >
          The last load failed. The old list is still shown.
        </p>
      ) : null}
      {reports.length === 0 ? (
        <div className="border-t border-border px-5 py-5 sm:px-6">
          <p className="font-semibold">No roof reports need a check.</p>
          <p className="mt-1 text-sm leading-6 text-muted">
            This list does not show if each roof service is online.
          </p>
        </div>
      ) : (
        <ol className="border-t border-border divide-y divide-border px-5 sm:px-6">
          {reports.map((report) => (
            <MeasurementIntakeExceptionRow key={report.id} report={report} locale={locale} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function MeasurementIntakeExceptionRow({
  report,
  locale,
}: {
  report: MeasurementIntakeOwnerException;
  locale: OwnerDateFormatOptions;
}) {
  const unmatched = report.status === "unmatched";
  const retryScheduled = report.recovery_disposition === "retry_scheduled";
  const recoveryBlocked = report.recovery_disposition === "recovery_blocked";
  const retryExhausted = report.recovery_disposition === "retry_exhausted";
  const needsRecovery = recoveryBlocked || retryExhausted;
  const reportUrl = trustedDriveUrl(report.drive_report_url);
  const folderUrl = trustedDriveUrl(report.drive_folder_url);
  const updatedAt = safeFormattedDate(report.updated_at, locale);
  return (
    <li className="py-4 sm:py-5">
      <div className="flex min-w-0 gap-3">
        <span
          className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-md ${unmatched || needsRecovery ? "bg-warning-soft text-warning" : "bg-info-soft text-info"}`}
        >
          {unmatched || needsRecovery ? (
            <AlertTriangle className="size-4" aria-hidden="true" />
          ) : (
            <RotateCcw className="size-4" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-bold tracking-[-0.015em]">
              {report.provider}{" "}
              {unmatched
                ? report.reason === "ocr_review_required"
                  ? "report needs a text check"
                  : "report needs a job"
                : retryScheduled
                  ? "report will try again"
                  : "report needs help"}
            </p>
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-semibold ${unmatched || needsRecovery ? "text-warning" : "text-info"}`}
            >
              <span
                className={`size-1.5 rounded-full ${unmatched || needsRecovery ? "bg-warning" : "bg-info"}`}
                aria-hidden="true"
              />
              {unmatched
                ? "Needs a person"
                : retryScheduled
                  ? "Will try again"
                  : recoveryBlocked
                    ? "Help needed"
                    : "No more tries"}
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted">
            {measurementExceptionCopy(report)}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm leading-5 text-muted">
            {report.job_number ? <Metadata label="Job given" value={report.job_number} /> : null}
            {!unmatched ? <Metadata label="Tries" value={String(report.attempts)} /> : null}
            {updatedAt ? <Metadata label="Last update" value={updatedAt} /> : null}
          </dl>
          {reportUrl || folderUrl ? (
            <p className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold">
              {reportUrl ? <GoogleDriveLink href={reportUrl} label="Open report" /> : null}
              {folderUrl ? <GoogleDriveLink href={folderUrl} label="Open folder" /> : null}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function GoogleDriveLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-offset-3"
    >
      {label}
    </a>
  );
}

function measurementExceptionCopy(report: MeasurementIntakeOwnerException): string {
  if (report.status === "unmatched") {
    if (report.reason === "ocr_review_required") {
      return "The app found roof numbers and page links. A person must check them against the saved report before they are used.";
    }
    if (report.reason === "job_number_missing") {
      return "The report has no job number. Pick the right job. The app will not try again on its own.";
    }
    return "The job number did not match a saved job. Pick the right job. The app will not try again on its own.";
  }
  const reason = {
    ocr_failed: "The app could not read the roof report safely.",
    drive_not_configured: "The Google Drive folder is not set up.",
    report_fetch_failed: "The app could not get the roof report.",
    raw_source_missing: "The saved roof report is missing.",
    frappe_sync_failed: "The native measurement projection needs recovery.",
    retry_pending: "The last try did not finish.",
  } as const;
  const summary = reason[report.reason as keyof typeof reason] ?? "The last try did not finish.";
  if (report.recovery_disposition === "retry_scheduled") {
    return `${summary} The app will try again at the saved time.`;
  }
  if (report.recovery_disposition === "recovery_blocked") {
    return `${summary} The app cannot try again. A team member must check it.`;
  }
  if (report.recovery_disposition === "retry_exhausted") {
    return `${summary} The app has used all tries. A team member must check it.`;
  }
  return summary;
}

function trustedDriveUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "drive.google.com" || url.hostname === "docs.google.com")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function DecisionLane({
  lane,
  allowedActions,
  dueTimingAvailable,
  locale,
}: {
  lane: ReturnType<typeof buildDecisionLanes>[number];
  allowedActions: readonly string[];
  dueTimingAvailable: boolean;
  locale: OwnerDateFormatOptions;
}) {
  const headingId = `owner-decision-lane-${lane.id}`;
  const [expanded, setExpanded] = useState(false);
  const visibleExceptions = expanded
    ? lane.exceptions
    : lane.exceptions.slice(0, DECISION_LANE_PREVIEW_LIMIT);
  const remaining = lane.exceptions.length - DECISION_LANE_PREVIEW_LIMIT;
  return (
    <Card className="overflow-hidden" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-end justify-between gap-3 p-5 sm:p-6">
        <div>
          <h2
            id={headingId}
            className="text-xl font-bold tracking-[-0.025em] text-balance sm:text-2xl"
          >
            {lane.title}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">{lane.description}</p>
        </div>
        <p className="text-sm font-semibold text-muted">
          {lane.exceptions.length} {lane.exceptions.length === 1 ? "item" : "items"}
        </p>
      </header>
      <ol
        id={`${headingId}-items`}
        className="border-t border-border divide-y divide-border px-5 sm:px-6"
      >
        {visibleExceptions.map((exception) => (
          <DecisionRow
            key={`${lane.id}:${exception.id}`}
            exception={exception}
            allowedActions={allowedActions}
            dueTimingAvailable={dueTimingAvailable}
            locale={locale}
          />
        ))}
      </ol>
      {remaining > 0 ? (
        <footer className="border-t border-border px-5 py-3 sm:px-6">
          <Button
            type="button"
            variant="ghost"
            size="compact"
            aria-controls={`${headingId}-items`}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show fewer" : `Show ${remaining} more`}
          </Button>
        </footer>
      ) : null}
    </Card>
  );
}

function DecisionRow({
  exception,
  allowedActions,
  dueTimingAvailable,
  locale,
}: {
  exception: OwnerException;
  allowedActions: readonly string[];
  dueTimingAvailable: boolean;
  locale: OwnerDateFormatOptions;
}) {
  const state = stateFor(exception);
  const StateIcon = state.Icon;
  const jobIsAvailable = canOpenJob(allowedActions, exception);
  const occurredAt = safeFormattedDate(exception.occurred_at, locale);
  const dueAt = dueTimingAvailable ? safeFormattedDate(exception.due_at, locale) : null;
  const receivedAt = safeFormattedDate(exception.received_at, locale);
  const jobLabel = exception.job_id?.startsWith("job:") ? "Attached" : (exception.job_id ?? "");
  const openJobLabel = jobLabel === "Attached" ? "Open attached job" : `Open job ${jobLabel}`;

  return (
    <li className="py-4 sm:py-5">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="flex min-w-0 gap-3">
          <span
            className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-md ${state.iconSurface}`}
          >
            <StateIcon className={`size-4 ${state.iconTone}`} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p className="font-bold tracking-[-0.015em] text-pretty">{exception.title}</p>
              <span
                className={`inline-flex items-center gap-1.5 text-sm font-semibold ${state.labelTone}`}
              >
                <span className={`size-1.5 rounded-full ${state.dot}`} aria-hidden="true" />
                {state.label}
              </span>
            </div>
            {exception.why ? (
              <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted">{exception.why}</p>
            ) : null}
            <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm leading-5 text-muted">
              {jobIsAvailable ? <Metadata label="Job" value={jobLabel} /> : null}
              {occurredAt ? <Metadata label="Recorded" value={occurredAt} /> : null}
              {receivedAt && receivedAt !== occurredAt ? (
                <Metadata label="Received" value={receivedAt} />
              ) : null}
              {dueAt ? <Metadata label="Due" value={dueAt} /> : null}
            </dl>
            <LeadAcknowledgementEvidence exception={exception} locale={locale} />
          </div>
        </div>
        {jobIsAvailable ? (
          <Link
            to="/jobs/$jobId"
            params={{ jobId: exception.job_id }}
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-bold text-background transition-colors hover:bg-foreground/88 focus-visible:outline-offset-3 sm:mt-0"
            aria-label={openJobLabel}
          >
            Open job
            <ChevronRight className="size-5" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function Metadata({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="sr-only">{label}</dt>
      <dd>
        <span className="font-semibold text-foreground">{label}:</span> {value}
      </dd>
    </div>
  );
}

function LeadAcknowledgementEvidence({
  exception,
  locale,
}: {
  exception: OwnerException;
  locale: OwnerDateFormatOptions;
}) {
  const deadlineAt = safeFormattedDate(exception.mctb?.deadline_at ?? null, locale);
  const observedAt = safeFormattedDate(exception.mctb?.observed_at ?? null, locale);
  const state = exception.mctb ? mctbEvidenceLabel(exception.mctb.state) : null;
  if (!state && !deadlineAt && !observedAt) return null;
  return (
    <details className="group mt-3 border-t border-border pt-1">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
        <span>Reply proof</span>
        <ChevronRight
          className="size-5 shrink-0 text-muted transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div className="border-l border-border pb-3 pl-3 text-sm leading-6">
        {state ? <p className="font-semibold text-foreground">{state}</p> : null}
        {deadlineAt || observedAt ? (
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-muted">
            {deadlineAt ? <Metadata label="Reply due" value={deadlineAt} /> : null}
            {observedAt ? <Metadata label="Proof saved" value={observedAt} /> : null}
          </dl>
        ) : null}
      </div>
    </details>
  );
}

function DataConfidence({
  model,
  locale,
  compact = false,
  className = "",
}: {
  model: OwnerNowResponse;
  locale: OwnerDateFormatOptions;
  compact?: boolean;
  className?: string;
}) {
  const sourceUpdatedAt = safeFormattedDate(model.source_updated_at, locale);
  const generatedAt = safeFormattedDate(model.read_model_generated_at, locale);
  const warnings = [
    ...model.stale_fields.map(humanizeStaleField),
    ...(model.partial_sources.length > 0
      ? [`Some counts may be low for ${model.partial_sources.map(humanizeSource).join(", ")}.`]
      : []),
  ];
  const limited = !sourceUpdatedAt || warnings.length > 0;
  const statusIcon = limited ? (
    <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
  ) : (
    <Clock3 className="size-4 shrink-0 text-ok" aria-hidden="true" />
  );
  const detail = (
    <>
      <dl className="mt-3 space-y-2 text-sm leading-5 text-muted">
        <div>
          <dt className="font-semibold text-foreground">Work data updated</dt>
          <dd>{sourceUpdatedAt ?? "Not known"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-foreground">List made</dt>
          <dd>{generatedAt ?? "Not known"}</dd>
        </div>
      </dl>
      {warnings.length > 0 ? (
        <ul className="mt-4 space-y-2 border-t border-warning/30 pt-3 text-sm leading-5 text-muted">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 border-t border-border pt-3 text-sm leading-5 text-muted">
          No data warning was found.
        </p>
      )}
    </>
  );

  if (compact) {
    return (
      <details
        className={`rounded-lg border border-border ${limited ? "bg-warning-soft" : "bg-surface-muted"} ${className}`}
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 font-bold tracking-[-0.015em]">
            {statusIcon}
            Data check
          </span>
          <span className="text-right text-muted">
            {sourceUpdatedAt
              ? warnings.length > 0
                ? `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`
                : "Looks current"
              : "Data not found"}
          </span>
        </summary>
        <div className="border-t border-border px-4 pb-4">{detail}</div>
      </details>
    );
  }

  return (
    <section
      className={`rounded-lg border border-border ${limited ? "bg-warning-soft" : "bg-surface-muted"} p-4 ${className}`}
      aria-label="Data check"
      role={limited ? "status" : undefined}
    >
      <div className="flex items-center gap-2">
        {statusIcon}
        <h2 className="font-bold tracking-[-0.015em]">Data check</h2>
      </div>
      {detail}
    </section>
  );
}

function RefreshWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex flex-col gap-3 border-y border-warning/35 bg-warning-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <p className="text-sm leading-6">
        <span className="font-bold">This may be an old list.</span>{" "}
        <span className="text-muted">The last load failed. Load again before you choose.</span>
      </p>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        Load again
      </Button>
    </div>
  );
}

function EmptyDecisionBoard({
  limited,
  generatedAt,
}: {
  limited: boolean;
  generatedAt: string | null;
}) {
  const title = limited ? "No work was found in the data we have" : "No work needs a check";
  return (
    <Card className="p-5 sm:p-6" aria-live="polite">
      <div className="flex max-w-xl gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-muted text-muted">
          <CircleGauge className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-[-0.025em]">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {limited
              ? "Open Data check before you call this list clear."
              : "There are no work stops, job gates, saved app issues, or lead checks in this list."}
            {generatedAt ? ` List made ${generatedAt}.` : ""}
          </p>
        </div>
      </div>
    </Card>
  );
}

function OwnerNowError({ onRetry }: { onRetry: () => void }) {
  return (
    <Card className="mx-auto max-w-2xl border-danger/35 p-6" role="alert">
      <div className="flex gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-danger-soft text-danger">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-[-0.025em]">
            Today&apos;s work could not load
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Nothing changed. Check your link, then load the list again.
          </p>
          <Button className="mt-5" variant="outline" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            Load again
          </Button>
        </div>
      </div>
    </Card>
  );
}

function OwnerNowSkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-6"
      aria-busy="true"
      aria-label="Loading owner work"
    >
      <Card className="h-44 bg-surface-muted/70" />
      <Card className="grid overflow-hidden sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`min-h-24 bg-surface-muted/60 ${index > 0 ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
          />
        ))}
      </Card>
      <Card className="space-y-0 overflow-hidden">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`min-h-28 bg-surface-muted/45 ${index > 0 ? "border-t border-border" : ""}`}
          />
        ))}
      </Card>
    </section>
  );
}

function stateFor(exception: OwnerException): {
  label: string;
  Icon: LucideIcon;
  iconSurface: string;
  iconTone: string;
  labelTone: string;
  dot: string;
} {
  switch (exception.kind) {
    case "field_blocker":
    case "blocked_gate":
      return {
        label: "Work stopped",
        Icon: AlertTriangle,
        iconSurface: "bg-danger-soft",
        iconTone: "text-danger",
        labelTone: "text-danger",
        dot: "bg-danger",
      };
    case "automation_incident":
      return severityPriority(exception.severity) <= 1
        ? {
            label: "Needs review",
            Icon: CircleGauge,
            iconSurface: "bg-danger-soft",
            iconTone: "text-danger",
            labelTone: "text-danger",
            dot: "bg-danger",
          }
        : {
            label: "Needs review",
            Icon: CircleGauge,
            iconSurface: "bg-warning-soft",
            iconTone: "text-warning",
            labelTone: "text-warning",
            dot: "bg-warning",
          };
    case "material_exception":
      return {
        label: "Check materials",
        Icon: PackageCheck,
        iconSurface: "bg-warning-soft",
        iconTone: "text-warning",
        labelTone: "text-warning",
        dot: "bg-warning",
      };
    case "finance_exception":
      return {
        label: "Check money",
        Icon: ClipboardCheck,
        iconSurface: "bg-info-soft",
        iconTone: "text-info",
        labelTone: "text-info",
        dot: "bg-info",
      };
    case "untriaged_lead":
    case "lead_triage_unknown":
      return {
        label: "Check lead",
        Icon: UsersRound,
        iconSurface: "bg-info-soft",
        iconTone: "text-info",
        labelTone: "text-info",
        dot: "bg-info",
      };
    default:
      return {
        label: "Needs review",
        Icon: ShieldCheck,
        iconSurface: "bg-surface-muted",
        iconTone: "text-foreground",
        labelTone: "text-foreground",
        dot: "bg-foreground",
      };
  }
}

function safeFormattedDate(value: string | null, locale: OwnerDateFormatOptions): string | null {
  const formatted = value ? formatOwnerDate(value, locale) : null;
  return formatted === "Date unavailable" ? null : formatted;
}

function systemCheckName(value: string): string {
  const names: Record<string, string> = {
    owned_persistence: "Saved data",
    queue: "Work queue",
    core_auth: "Sign in",
    provider_delivery: "Linked apps",
    office_bff: "Office app link",
    customer_portal: "Customer portal",
    production_schedule: "Job plan",
    public_estimate: "Estimate form",
    newo: "Phone desk",
  };
  return names[value] ?? humanizeSource(value);
}
