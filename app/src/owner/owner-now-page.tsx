import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ChevronRight, CircleGauge, Clock3 } from "lucide-react";

import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import type { OwnerException, OwnerNowResponse } from "./owner-contracts";
import { loadOwnerNow } from "./owner-api";
import {
  formatOwnerDate,
  groupOwnerExceptions,
  severityPriority,
  type ExceptionGroup,
  validJobId,
} from "./owner-now-utils";

const summaryMetrics = [
  { key: "field_blockers", label: "Crew-reported stops", tone: "text-danger" },
  { key: "blocked_gates", label: "Blocked gates", tone: "text-danger" },
  { key: "open_incidents", label: "Incidents", tone: "text-warning" },
  { key: "material_exceptions", label: "Materials", tone: "text-warning" },
  { key: "finance_exceptions", label: "Finance", tone: "text-info" },
  { key: "untriaged_leads", label: "Untriaged leads", tone: "text-ok" },
  { key: "lead_triage_unknown", label: "Triage data quality", tone: "text-warning" },
  { key: "mctb_unproven_due", label: "MCTB proof overdue", tone: "text-danger" },
] as const;

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

  if (query.isPending) return <LoadingState label="Loading the office decision queue…" />;
  if (query.isError) {
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  }

  const model = query.data;
  const groups = groupOwnerExceptions(model.exceptions);
  return (
    <section className="space-y-6">
      <header className="border-b border-border pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-foreground text-background">
              <CircleGauge className="size-6 text-accent" aria-hidden="true" />
            </div>
            <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              Office decision queue
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">Owner Now</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-muted">
              Work-stopping gates and exceptions come before schedules, reports, or broad lists.
            </p>
          </div>
          <div
            className="rounded-xl border bg-surface-raised px-4 py-3 shadow-sm"
            aria-label="Active jobs"
          >
            <p className="text-2xl font-black tracking-[-0.04em]">{model.summary.active_jobs}</p>
            <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-muted">
              Active jobs
            </p>
          </div>
        </div>
        <ReadModelStatus model={model} />
      </header>

      <Summary model={model} />

      {groups.length === 0 ? (
        <EmptyState
          title="No current exceptions"
          message="This read model did not return a blocked gate, incident, material, finance, untriaged lead, or triage-data-quality exception. No sample work is shown here."
        />
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <ExceptionSection key={group.kind} group={group} />
          ))}
        </div>
      )}
    </section>
  );
}

function ReadModelStatus({ model }: { model: OwnerNowResponse }) {
  const hasStaleFields = model.stale_fields.length > 0;
  const sourceUnavailable = model.source_updated_at === null;
  const hasPartialSources = model.partial_sources.length > 0;
  const needsAttention = hasStaleFields || sourceUnavailable || hasPartialSources;
  return (
    <div
      className={
        needsAttention
          ? "mt-6 flex gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm"
          : "mt-6 flex gap-3 rounded-xl border border-ok/30 bg-ok-soft px-4 py-3 text-sm"
      }
      role="status"
      aria-live="polite"
    >
      {needsAttention ? (
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      ) : (
        <Clock3 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
      )}
      <div className="min-w-0 space-y-1">
        <p className="font-bold">
          {sourceUnavailable
            ? "Source update time is unavailable."
            : `Source updated ${formatOwnerDate(model.source_updated_at)}.`}
        </p>
        <p className="text-muted">
          Read model generated {formatOwnerDate(model.read_model_generated_at)}.
        </p>
        {hasStaleFields ? (
          <p className="break-words text-muted">Stale fields: {model.stale_fields.join(", ")}.</p>
        ) : null}
        {hasPartialSources ? (
          <p className="break-words text-muted">
            Some totals are lower bounds because these sources reached their query limit:{" "}
            {model.partial_sources.map(humanizeSource).join(", ")}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Summary({ model }: { model: OwnerNowResponse }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Exception totals">
      {summaryMetrics.map((metric) => (
        <div key={metric.key} className="rounded-xl border bg-surface-raised px-4 py-4 shadow-sm">
          <dt className="text-xs font-extrabold uppercase tracking-[0.11em] text-muted">
            {metric.label}
          </dt>
          <dd className={`mt-2 text-2xl font-black tracking-[-0.04em] ${metric.tone}`}>
            {model.summary[metric.key]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExceptionSection({ group }: { group: ExceptionGroup }) {
  return (
    <section aria-labelledby={`owner-exceptions-${group.kind}`}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2
          id={`owner-exceptions-${group.kind}`}
          className="text-lg font-black tracking-[-0.025em] sm:text-xl"
        >
          {group.title}
        </h2>
        <p className="text-sm font-bold text-muted">
          {group.exceptions.length} {group.exceptions.length === 1 ? "item" : "items"}
        </p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {group.exceptions.map((exception) => (
          <ExceptionCard
            key={`${group.kind}:${exception.id}`}
            exception={exception}
            tone={group.tone}
          />
        ))}
      </div>
    </section>
  );
}

function ExceptionCard({ exception, tone }: { exception: OwnerException; tone: string }) {
  const jobId = validJobId(exception.job_id) ? exception.job_id : null;
  const occurredAt = safeFormattedDate(exception.occurred_at);
  const leadException =
    exception.kind === "untriaged_lead" || exception.kind === "lead_triage_unknown";
  return (
    <Card className={`border-l-4 ${tone}`}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={severityClass(exception.severity)}>
            {severityLabel(exception.severity)}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-sm font-semibold text-muted">
            {occurredAt && occurredAt !== "Date unavailable" ? (
              <span>Recorded {occurredAt}</span>
            ) : null}
            <span>
              {exception.due_at
                ? `Due ${formatOwnerDate(exception.due_at)}`
                : "Due date unavailable"}
            </span>
          </div>
        </div>
        <CardTitle className="mt-3">{exception.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 text-sm leading-6">
          <p>
            <span className="font-extrabold">Why: </span>
            <span className="text-muted">{exception.why ?? "Reason unavailable."}</span>
          </p>
          <p>
            <span className="font-extrabold">Next: </span>
            <span className="text-muted">
              {exception.next_action ?? "No verified next action was returned."}
            </span>
          </p>
        </div>
        {leadException ? <LeadMctbEvidence exception={exception} /> : null}
        {jobId ? (
          <Link
            to="/jobs/$jobId"
            params={{ jobId }}
            className="inline-flex min-h-12 items-center gap-2 rounded-lg px-3 font-bold text-info underline decoration-info/35 underline-offset-4 transition-colors hover:bg-info-soft focus-visible:no-underline"
            aria-label={`Open job ${exception.job_id}`}
          >
            Open job
            <ChevronRight className="size-5" aria-hidden="true" />
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LeadMctbEvidence({ exception }: { exception: OwnerException }) {
  const receivedAt = safeFormattedDate(exception.received_at);
  const deadlineAt = safeFormattedDate(exception.mctb?.deadline_at ?? null);
  const observedAt = safeFormattedDate(exception.mctb?.observed_at ?? null);
  const evidence = exception.mctb ? mctbEvidenceLabel(exception.mctb.state) : null;
  if (!evidence && !receivedAt && !deadlineAt && !observedAt) return null;
  return (
    <section
      className="rounded-lg border border-info/25 bg-info-soft px-3 py-3 text-sm"
      aria-label="MCTB evidence"
    >
      <p className="font-extrabold">MCTB evidence</p>
      {evidence ? <p className="mt-1 text-muted">{evidence}</p> : null}
      {receivedAt || deadlineAt || observedAt ? (
        <dl className="mt-3 grid gap-2 sm:grid-cols-3">
          {receivedAt ? <EvidenceTime label="Received" value={receivedAt} /> : null}
          {deadlineAt ? <EvidenceTime label="Deadline" value={deadlineAt} /> : null}
          {observedAt ? <EvidenceTime label="Observed" value={observedAt} /> : null}
        </dl>
      ) : null}
    </section>
  );
}

function EvidenceTime({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-extrabold uppercase tracking-[0.1em] text-muted">{label}</dt>
      <dd className="mt-1 font-semibold">{value}</dd>
    </div>
  );
}

function severityLabel(value: string | null): string {
  return value?.trim() || "Severity unavailable";
}

function severityClass(value: string | null): string {
  switch (severityPriority(value)) {
    case 0:
    case 1:
      return "rounded-full bg-danger-soft px-3 py-1 text-xs font-extrabold text-danger";
    case 2:
      return "rounded-full bg-warning-soft px-3 py-1 text-xs font-extrabold text-warning";
    case 3:
      return "rounded-full bg-ok-soft px-3 py-1 text-xs font-extrabold text-ok";
    default:
      return "rounded-full bg-surface-muted px-3 py-1 text-xs font-extrabold text-muted";
  }
}

function humanizeSource(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeFormattedDate(value: string | null): string | null {
  const formatted = value ? formatOwnerDate(value) : null;
  return formatted === "Date unavailable" ? null : formatted;
}

function mctbEvidenceLabel(state: NonNullable<OwnerException["mctb"]>["state"]): string {
  switch (state) {
    case "provider_accepted_within_sla":
      return "provider accepted within 60s";
    case "provider_accepted_late":
      return "provider accepted after 60s";
    case "no_eligible_channel":
      return "no eligible auto-ack channel";
    case "awaiting_proof":
      return "awaiting provider proof";
    case "unproven_after_sla":
      return "no provider proof after 60s";
    case "time_unavailable":
      return "intake time unavailable";
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The office decision queue could not be loaded.";
}
