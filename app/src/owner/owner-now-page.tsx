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

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
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

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <CircleGauge className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Now
              </h1>
              <p className="mt-1 text-sm leading-6 text-muted sm:text-base">
                {model.summary.active_jobs} active{" "}
                {model.summary.active_jobs === 1 ? "job" : "jobs"}
                {generatedAt ? <> · Read generated {generatedAt}</> : null}
              </p>
            </div>
          </div>
          <p className="hidden max-w-sm text-sm leading-6 text-muted sm:block sm:text-right">
            The decision board shows verified exceptions first. It does not infer missing impact,
            approvals, or follow-up.
          </p>
        </div>
      </header>

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
    ? "Checking runtime truth"
    : data
      ? "Refresh runtime truth"
      : failed
        ? "Retry runtime truth"
        : "Check runtime truth";
  if (!data) {
    return (
      <section className="border-y border-border py-5" aria-labelledby="runtime-truth-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="runtime-truth-heading" className="text-xl font-black tracking-[-0.025em]">
              Runtime truth
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
              Run a bounded server-side readiness and operations read. It changes no provider or job
              state.
            </p>
            {failed ? (
              <p className="mt-2 text-sm font-semibold text-warning" role="status">
                The runtime read was unavailable. Retry does not change operating state.
              </p>
            ) : null}
          </div>
          <Button variant="outline" size="compact" busy={checking} onClick={onCheck}>
            <RotateCcw aria-hidden="true" />
            {actionLabel}
          </Button>
        </div>
      </section>
    );
  }

  const failedChecks = data.readiness.checks.filter((check) => !check.ok);
  const readyChecks = data.readiness.checks.length - failedChecks.length;
  const heartbeat = data.operations.heartbeat;
  const heartbeatState = !heartbeat
    ? "No heartbeat"
    : heartbeat.fresh && heartbeat.reconciled
      ? "Fresh"
      : "Attention";
  const quickBooksState = !data.operations.quickbooks_receipts.available
    ? "No receipt"
    : data.operations.quickbooks_receipts.fresh
      ? "Fresh"
      : "Attention";
  const metrics = [
    { label: "Readiness groups", value: `${readyChecks}/${data.readiness.checks.length}` },
    { label: "Operations", value: data.operations.status === "ok" ? "OK" : "Degraded" },
    { label: "Heartbeat", value: heartbeatState },
    { label: "Open dead letters", value: String(data.operations.counts.open_dead_letters) },
    { label: "Stuck envelopes", value: String(data.operations.counts.stuck) },
    { label: "Frappe errors", value: String(data.operations.counts.frappe_errors) },
    {
      label: "Replay failures",
      value: String(data.operations.counts.replay_failed + data.operations.counts.replay_stuck),
    },
    {
      label: `Audit failures observed (${data.operations.audit_failure_window_hours}h, max 20)`,
      value: String(data.operations.audit_failures_observed),
    },
    { label: "QuickBooks receipts", value: quickBooksState },
  ];
  const generatedAt = safeFormattedDate(data.read_model_generated_at, locale);
  const heartbeatAt = heartbeat ? safeFormattedDate(heartbeat.ran_at, locale) : null;

  return (
    <section className="border-y border-border py-5" aria-labelledby="runtime-truth-heading">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="runtime-truth-heading" className="text-xl font-black tracking-[-0.025em]">
              Runtime truth
            </h2>
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-bold ${data.status === "ready" ? "text-ok" : "text-warning"}`}
            >
              <span
                className={`size-1.5 rounded-full ${data.status === "ready" ? "bg-ok" : "bg-warning"}`}
                aria-hidden="true"
              />
              {data.status === "ready" ? "Ready" : "Attention"}
            </span>
          </div>
          <p className="mt-1 text-sm leading-6 text-muted">
            {generatedAt ? `Read ${generatedAt}. ` : ""}
            This is a server read, not deployment or business-acceptance proof.
          </p>
        </div>
        <Button variant="outline" size="compact" busy={checking} onClick={onCheck}>
          <RotateCcw aria-hidden="true" />
          {actionLabel}
        </Button>
      </header>

      {failed ? (
        <p className="mt-3 text-sm text-warning" role="status">
          Showing the previous runtime read because the latest check failed.
        </p>
      ) : null}

      <dl className="mt-4 grid gap-x-6 gap-y-3 border-y border-border py-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt className="text-muted">{metric.label}</dt>
            <dd className="mt-0.5 font-bold text-foreground">{metric.value}</dd>
          </div>
        ))}
      </dl>
      {heartbeatAt ? (
        <p className="mt-3 text-sm leading-6 text-muted">Latest heartbeat: {heartbeatAt}.</p>
      ) : null}
      {failedChecks.length > 0 ? (
        <p className="mt-3 text-sm leading-6 text-muted">
          Readiness attention: {failedChecks.map((check) => check.id.replace(/_/g, " ")).join(", ")}
          .
        </p>
      ) : (
        <p className="mt-3 text-sm leading-6 text-muted">
          All bounded readiness groups reported ready in this read.
        </p>
      )}
    </section>
  );
}

function DecisionSummary({ model }: { model: OwnerNowResponse }) {
  const signals = [
    {
      label: "Work stopped",
      value: model.summary.field_blockers + model.summary.blocked_gates,
      detail: "Crew reports and gate locks",
      tone: "text-danger",
      dot: "bg-danger",
    },
    {
      label: "Needs review",
      value:
        model.summary.open_incidents +
        model.summary.material_exceptions +
        model.summary.finance_exceptions,
      detail: "Operations, materials, and finance",
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Lead attention",
      value: model.summary.untriaged_leads + model.summary.lead_triage_unknown,
      detail: "Triage state and acknowledgement evidence",
      tone: "text-info",
      dot: "bg-info",
    },
  ];
  return (
    <dl className="grid grid-cols-3 border-y border-border" aria-label="Current operating signals">
      {signals.map((signal, index) => (
        <div
          key={signal.label}
          className={`min-h-20 px-3 py-3 sm:min-h-24 sm:px-5 sm:py-4 ${index > 0 ? "border-l border-border" : ""}`}
        >
          <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={`size-2 rounded-full ${signal.dot}`} aria-hidden="true" />
            {signal.label}
          </dt>
          <dd
            className={`mt-1 text-xl font-black tracking-[-0.03em] sm:mt-2 sm:text-2xl ${signal.tone}`}
          >
            {signal.value}
          </dd>
          <p className="mt-1 hidden text-sm leading-5 text-muted sm:block">{signal.detail}</p>
        </div>
      ))}
    </dl>
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
      <section
        className="border-y border-border py-5"
        aria-busy="true"
        aria-label="Loading measurement intake exceptions"
      >
        <p className="text-sm leading-6 text-muted">
          Loading measurement reports needing attention…
        </p>
      </section>
    );
  }
  if (!data && refreshFailed) {
    return (
      <section className="border-y border-warning/35 bg-warning-soft px-4 py-4" role="status">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-bold tracking-[-0.015em]">Measurement intake read unavailable</h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              The report exception queue could not load. Retrying does not reprocess or change a
              report.
            </p>
          </div>
          <Button variant="outline" size="compact" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            Retry read
          </Button>
        </div>
      </section>
    );
  }
  if (!data) return null;

  const reports = data.measurements;
  return (
    <section aria-labelledby="measurement-intake-exceptions-heading">
      <header className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div>
          <h2
            id="measurement-intake-exceptions-heading"
            className="text-xl font-black tracking-[-0.025em] text-balance sm:text-2xl"
          >
            Measurement reports needing attention
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Unmatched reports wait for a job decision. The server marks other reports as scheduled,
            blocked, or at the retry limit; this panel cannot replay, assign, or alter either one.
          </p>
        </div>
        <p className="text-sm font-semibold text-muted">
          {reports.length} {reports.length === 1 ? "report" : "reports"}
        </p>
      </header>
      {refreshFailed ? (
        <p
          className="mb-3 border-y border-warning/35 bg-warning-soft px-3 py-2 text-sm text-muted"
          role="status"
        >
          Showing the previous measurement read.
        </p>
      ) : null}
      {reports.length === 0 ? (
        <div className="border-y border-border py-5">
          <p className="font-semibold">
            No unmatched or retryable measurement reports were returned.
          </p>
          <p className="mt-1 text-sm leading-6 text-muted">
            This is a read-only exception list, not a proof that every provider feed is operating.
          </p>
        </div>
      ) : (
        <ol className="border-y border-border divide-y divide-border">
          {reports.map((report) => (
            <MeasurementIntakeExceptionRow key={report.id} report={report} locale={locale} />
          ))}
        </ol>
      )}
    </section>
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
                  ? "report needs OCR review"
                  : "report needs a job match"
                : retryScheduled
                  ? "report is retrying"
                  : "report needs recovery"}
            </p>
            <span
              className={`inline-flex items-center gap-1.5 text-sm font-semibold ${unmatched || needsRecovery ? "text-warning" : "text-info"}`}
            >
              <span
                className={`size-1.5 rounded-full ${unmatched || needsRecovery ? "bg-warning" : "bg-info"}`}
                aria-hidden="true"
              />
              {unmatched
                ? "Manual review"
                : retryScheduled
                  ? "Automatic retry"
                  : recoveryBlocked
                    ? "Recovery blocked"
                    : "Retry limit reached"}
            </span>
          </div>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted">
            {measurementExceptionCopy(report)}
          </p>
          <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm leading-5 text-muted">
            {report.job_number ? <Metadata label="Supplied job" value={report.job_number} /> : null}
            {!unmatched ? <Metadata label="Attempts" value={String(report.attempts)} /> : null}
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
      return "AI extracted candidates with page references. An operator must compare them with the saved report before they become accepted measurements.";
    }
    if (report.reason === "job_number_missing") {
      return "No job number was supplied. This report waits for an operator to decide its job relationship and is not retried automatically.";
    }
    return "The supplied job did not resolve. This report waits for an operator to decide its job relationship and is not retried automatically.";
  }
  const reason = {
    ocr_failed: "The AI measurement extraction could not be completed safely.",
    drive_not_configured: "Drive filing is not configured.",
    report_fetch_failed: "The report source could not be fetched.",
    raw_source_missing: "The saved raw source is unavailable.",
    frappe_sync_failed: "The Frappe measurement sync needs recovery.",
    retry_pending: "The prior retry did not complete.",
  } as const;
  const summary =
    reason[report.reason as keyof typeof reason] ?? "The prior retry did not complete.";
  if (report.recovery_disposition === "retry_scheduled") {
    return `${summary} The Worker will retry automatically when due.`;
  }
  if (report.recovery_disposition === "recovery_blocked") {
    return `${summary} Automatic recovery is blocked and needs operator investigation.`;
  }
  if (report.recovery_disposition === "retry_exhausted") {
    return `${summary} The automatic retry limit has been reached and needs operator investigation.`;
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
  return (
    <section aria-labelledby={headingId}>
      <header className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div>
          <h2
            id={headingId}
            className="text-xl font-black tracking-[-0.025em] text-balance sm:text-2xl"
          >
            {lane.title}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">{lane.description}</p>
        </div>
        <p className="text-sm font-semibold text-muted">
          {lane.exceptions.length} {lane.exceptions.length === 1 ? "record" : "records"}
        </p>
      </header>
      <ol className="border-y border-border divide-y divide-border">
        {lane.exceptions.map((exception) => (
          <DecisionRow
            key={`${lane.id}:${exception.id}`}
            exception={exception}
            allowedActions={allowedActions}
            dueTimingAvailable={dueTimingAvailable}
            locale={locale}
          />
        ))}
      </ol>
    </section>
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
              {jobIsAvailable ? <Metadata label="Job" value={exception.job_id} /> : null}
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
            aria-label={`Open job packet for ${exception.job_id}`}
          >
            Open job packet
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
    <details className="mt-3 border-t border-border pt-1">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
        <span>Acknowledgement evidence</span>
        <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden="true" />
      </summary>
      <div className="border-l border-border pb-3 pl-3 text-sm leading-6">
        {state ? <p className="font-semibold text-foreground">{state}</p> : null}
        {deadlineAt || observedAt ? (
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-muted">
            {deadlineAt ? <Metadata label="Deadline" value={deadlineAt} /> : null}
            {observedAt ? <Metadata label="Observed" value={observedAt} /> : null}
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
      ? [`Counts are lower bounds for ${model.partial_sources.map(humanizeSource).join(", ")}.`]
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
          <dt className="font-semibold text-foreground">Source update</dt>
          <dd>{sourceUpdatedAt ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt className="font-semibold text-foreground">Queue generated</dt>
          <dd>{generatedAt ?? "Unavailable"}</dd>
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
          No source-limit or stale-field warning was returned.
        </p>
      )}
    </>
  );

  if (compact) {
    return (
      <details
        className={`rounded-lg ${limited ? "bg-warning-soft" : "bg-surface-muted"} ${className}`}
      >
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 font-bold tracking-[-0.015em]">
            {statusIcon}
            Data confidence
          </span>
          <span className="text-right text-muted">
            {sourceUpdatedAt
              ? warnings.length > 0
                ? `${warnings.length} limits`
                : "No limits"
              : "Source unavailable"}
          </span>
        </summary>
        <div className="border-t border-border px-4 pb-4">{detail}</div>
      </details>
    );
  }

  return (
    <section
      className={`rounded-lg ${limited ? "bg-warning-soft" : "bg-surface-muted"} p-4 ${className}`}
      aria-label="Data confidence"
      role={limited ? "status" : undefined}
    >
      <div className="flex items-center gap-2">
        {statusIcon}
        <h2 className="font-bold tracking-[-0.015em]">Data confidence</h2>
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
        <span className="font-bold">Showing the previous read.</span>{" "}
        <span className="text-muted">
          Refresh failed, so this board may not include the newest source state.
        </span>
      </p>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RotateCcw aria-hidden="true" />
        Retry queue
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
  const title = limited
    ? "No exceptions were returned from available sources"
    : "No exceptions in this read model";
  return (
    <section className="border-y border-border py-8" aria-live="polite">
      <div className="flex max-w-xl gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-surface-muted text-muted">
          <CircleGauge className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-xl font-black tracking-[-0.025em]">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {limited
              ? "Keep the data-confidence details visible before treating this as a clear operating state."
              : "The queue contains no blocked gates, field work-stops, operating exceptions, or lead-attention records."}
            {generatedAt ? ` Read generated ${generatedAt}.` : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

function OwnerNowError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="mx-auto max-w-2xl border-y border-danger/35 py-8" role="alert">
      <div className="flex gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-danger-soft text-danger">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-xl font-black tracking-[-0.025em]">Current queue unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            The current queue could not load. Retrying does not change jobs or acknowledgements.
          </p>
          <Button className="mt-5" variant="outline" onClick={onRetry}>
            <RotateCcw aria-hidden="true" />
            Retry queue
          </Button>
        </div>
      </div>
    </section>
  );
}

function OwnerNowSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading current decision queue"
    >
      <div className="h-20 border-b border-border bg-surface-muted/70" />
      <div className="grid border-y border-border sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`min-h-24 bg-surface-muted/60 ${index > 0 ? "border-t border-border sm:border-t-0 sm:border-l" : ""}`}
          />
        ))}
      </div>
      <div className="space-y-0 border-y border-border">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={`min-h-28 bg-surface-muted/45 ${index > 0 ? "border-t border-border" : ""}`}
          />
        ))}
      </div>
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
        label: "Materials review",
        Icon: PackageCheck,
        iconSurface: "bg-warning-soft",
        iconTone: "text-warning",
        labelTone: "text-warning",
        dot: "bg-warning",
      };
    case "finance_exception":
      return {
        label: "Finance review",
        Icon: ClipboardCheck,
        iconSurface: "bg-info-soft",
        iconTone: "text-info",
        labelTone: "text-info",
        dot: "bg-info",
      };
    case "untriaged_lead":
    case "lead_triage_unknown":
      return {
        label: "Lead attention",
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
