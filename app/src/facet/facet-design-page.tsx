import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock3, FileCheck2, Palette, RefreshCw } from "lucide-react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import { loadFacetDesignEvidence } from "./facet-design-api";
import type { FacetDesignEvidence, FacetDesignIntakeException } from "./facet-design-contracts";

export function FacetDesignPage() {
  return (
    <RoleGuard surface="owner">
      <FacetDesignContent />
    </RoleGuard>
  );
}

function FacetDesignContent() {
  const session = useSession();
  const online = useOnlineStatus();
  const query = useQuery({
    queryKey: ["facet-design-evidence-v2", session.tenant.id, session.user.id],
    queryFn: () => loadFacetDesignEvidence(),
    retry: false,
  });

  if (!query.data && query.isPending) return <LoadingState label="Loading Facet designs…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Facet designs are unavailable"
        message="Nothing was linked or changed. Reconnect and try again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading Facet designs…" />;

  const counts = query.data.evidence.reduce(
    (result, evidence) => ({
      ...result,
      [evidence.projection_state]: result[evidence.projection_state] + 1,
    }),
    { awaiting_projection: 0, projected: 0, held: 0, attention_required: 0 },
  );
  const offline = !online || isOfflineSession(session);

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-6">
      <header className="border-b border-border pb-5 sm:flex sm:items-end sm:justify-between sm:gap-6 sm:pb-6">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
            <Palette className="size-5 text-accent" aria-hidden="true" />
          </span>
          <div>
            <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              Facet designs
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
              Customer designs
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted sm:text-base">
              See each design choice Facet sent to IronWrap. A choice starts an empty quote draft.
              It does not change the price, email the customer, or send anything to QuickBooks.
            </p>
          </div>
        </div>
        <Button
          className="mt-4 shrink-0 sm:mt-0"
          busy={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </header>

      {offline ? (
        <div className="border-y border-warning/35 bg-warning-soft px-4 py-3 text-sm" role="status">
          <p className="font-bold">Showing saved designs</p>
          <p className="mt-1 leading-6 text-muted">
            Reconnect to check for new customer choices. IronWrap will not guess while offline.
          </p>
        </div>
      ) : null}
      {query.isError && query.data ? (
        <div className="border-y border-danger/30 bg-danger-soft px-4 py-3 text-sm" role="alert">
          <p className="font-bold">Refresh failed</p>
          <p className="mt-1 leading-6 text-muted">
            The designs below are the last saved copy. No new state is shown.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
        <Metric label="Quote drafts ready" value={counts.projected} tone="ok" />
        <Metric label="Waiting to start" value={counts.awaiting_projection} tone="warning" />
        <Metric label="On hold" value={counts.held} tone="muted" />
        <Metric label="Needs help" value={counts.attention_required} tone="danger" />
      </div>

      {query.data.intake_exceptions.length > 0 ? (
        <section className="space-y-3" aria-labelledby="facet-delivery-exceptions-heading">
          <div>
            <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-danger">
              Design link issues
            </p>
            <h2 id="facet-delivery-exceptions-heading" className="mt-1 text-xl font-black">
              Fix a design link
            </h2>
          </div>
          <div
            className={
              query.data.intake_exceptions.length > 1 ? "grid gap-3 lg:grid-cols-2" : "grid gap-3"
            }
          >
            {query.data.intake_exceptions.map((exception) => (
              <IntakeExceptionCard
                key={`${exception.event_id}:${exception.received_at}`}
                exception={exception}
              />
            ))}
          </div>
        </section>
      ) : null}

      {query.data.evidence.length === 0 ? (
        <EmptyState
          title="No Facet design choices yet"
          message="A customer choice will show here after Facet sends it to IronWrap."
        />
      ) : (
        <div
          className={query.data.evidence.length > 1 ? "grid gap-4 lg:grid-cols-2" : "grid gap-4"}
          aria-live="polite"
        >
          {query.data.evidence.map((evidence) => (
            <EvidenceCard key={evidence.event_id} evidence={evidence} />
          ))}
        </div>
      )}

      <p className="text-right text-xs text-muted">
        Last checked {readableDate(query.data.read_model_generated_at)}
      </p>
    </section>
  );
}

function IntakeExceptionCard({ exception }: { exception: FacetDesignIntakeException }) {
  const awaiting = exception.state === "awaiting_association";
  return (
    <Card className="border-danger/25 bg-danger-soft/35">
      <div className="flex items-start gap-3">
        {awaiting ? (
          <Clock3 className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-black">
            {awaiting ? "Waiting for the right job" : "Design could not be linked"}
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted">
            {awaiting
              ? "IronWrap saved this design and is trying to find its job. If it stays here, open the right job in Facet and send it again."
              : "No quote draft was made. Check the customer and job in Facet. Then send the design again from that job."}
          </p>
          <details className="mt-3 border-t border-current/15 pt-2">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold">
              System details
            </summary>
            <dl className="grid gap-2 pt-2 text-xs sm:grid-cols-2">
              <Detail label="Event" value={exception.event_id} mono />
              <Detail label="Reason" value={exception.status_code.replaceAll("_", " ")} />
            </dl>
          </details>
          <Button asChild variant="outline" size="compact" className="mt-4">
            <Link to="/sales">Open sales</Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warning" | "muted" | "danger";
}) {
  const toneClass = {
    ok: "text-ok",
    warning: "text-warning",
    muted: "text-muted",
    danger: "text-danger",
  }[tone];
  return (
    <div className="bg-surface px-5 py-4">
      <p className={`text-3xl font-black tracking-[-0.04em] ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs font-bold uppercase tracking-[0.12em] text-muted">{label}</p>
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: FacetDesignEvidence }) {
  const presentation = statusPresentation(evidence);
  const Icon = presentation.icon;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
            {decisionLabel(evidence.decision_kind)} in Facet
          </p>
          <h2 className="mt-1 truncate text-lg font-black">Design for {evidence.roof_job_id}</h2>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-bold ${presentation.tone}`}
        >
          <Icon className="size-4" aria-hidden="true" />
          {presentation.label}
        </span>
      </div>

      <div className="space-y-4 px-5 py-4">
        <p className="text-sm leading-6 text-muted">{presentation.detail}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Detail label="Roof job" value={evidence.roof_job_id} />
          <Detail label="Quote" value={evidence.customer_quote_id} />
          <Detail label="Customer choice" value={readableDate(evidence.occurred_at)} />
          <Detail label="Match" value="Customer and job matched" />
          {evidence.projection?.draft_customer_quote_id ? (
            <Detail label="Quote draft" value={evidence.projection.draft_customer_quote_id} />
          ) : null}
        </dl>
        <details className="border-t border-border pt-4 text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-muted">
            System details
          </summary>
          <dl className="mt-3 grid gap-3 break-all text-xs">
            <Detail label="Facet project" value={evidence.facet_project_id} mono />
            <Detail label="Event" value={evidence.event_id} mono />
            <Detail label="Revision" value={evidence.design_revision_id} mono />
            <Detail label="Design check code" value={evidence.design_revision_sha256} mono />
            <Detail label="Saved choice code" value={evidence.frozen_evidence_sha256} mono />
            <Detail label="Link check code" value={evidence.association_sha256} mono />
            <Detail label="Project link" value={evidence.external_project_link_id} mono />
            {evidence.projection?.draft_quote_version ? (
              <Detail
                label="Quote draft version"
                value={String(evidence.projection.draft_quote_version)}
              />
            ) : null}
            {evidence.projection?.evidence_id ? (
              <Detail label="IronWrap record" value={evidence.projection.evidence_id} mono />
            ) : null}
            {evidence.projection?.reconciliation_id ? (
              <Detail label="Check record" value={evidence.projection.reconciliation_id} mono />
            ) : null}
            <Detail label="Status code" value={evidence.status_code.replaceAll("_", " ")} />
          </dl>
        </details>
      </div>
    </Card>
  );
}

function statusPresentation(evidence: FacetDesignEvidence): {
  label: string;
  detail: string;
  tone: string;
  icon: typeof CheckCircle2;
} {
  if (evidence.projection_state === "projected") {
    return {
      label: "Quote draft ready",
      detail:
        "IronWrap matched the customer and job. It made an empty quote draft for the estimator.",
      tone: "text-ok",
      icon: CheckCircle2,
    };
  }
  if (evidence.projection_state === "awaiting_projection") {
    return {
      label: "Waiting to start",
      detail: "IronWrap saved the customer choice. It will make an empty quote draft.",
      tone: "text-warning",
      icon: Clock3,
    };
  }
  if (evidence.projection_state === "held") {
    return {
      label: evidence.decision_kind === "withdrawn" ? "Customer removed it" : "Newer design used",
      detail:
        evidence.decision_kind === "withdrawn"
          ? "The customer removed this design. IronWrap kept the record. It did not make a quote draft."
          : "A newer design replaced this one. IronWrap kept the record. It did not make a quote draft.",
      tone: "text-muted",
      icon: FileCheck2,
    };
  }
  return {
    label: "Needs help",
    detail: "IronWrap stopped before making a quote draft. No price or customer record changed.",
    tone: "text-danger",
    icon: AlertTriangle,
  };
}

function decisionLabel(decision: FacetDesignEvidence["decision_kind"]): string {
  const labels: Record<FacetDesignEvidence["decision_kind"], string> = {
    approved: "Customer picked this",
    corrected: "Customer changed this",
    withdrawn: "Customer removed this",
    superseded: "Newer design replaced this",
  };
  return labels[decision];
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="font-bold text-muted">{label}</dt>
      <dd className={`mt-1 text-foreground ${mono ? "font-mono" : "font-semibold"}`}>{value}</dd>
    </div>
  );
}

function readableDate(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : "date unavailable";
}
