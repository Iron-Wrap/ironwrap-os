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

  if (!query.data && query.isPending)
    return <LoadingState label="Loading signed Facet decisions…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Signed Facet evidence is unavailable"
        message="No identity, project, or quote state was inferred. Reconnect and load the immutable v2 decision chain again."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading signed Facet decisions…" />;

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
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
              Customer design evidence
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted sm:text-base">
              Every card is an exact OIDC-bound customer decision joined to its durable IronWrap
              project link and accepted commercial source. A verified decision becomes native design
              authority; it never invents pricing, contacts a customer, or posts accounting.
            </p>
          </div>
        </div>
        <Button
          className="mt-4 shrink-0 sm:mt-0"
          busy={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw aria-hidden="true" />
          Refresh evidence
        </Button>
      </header>

      {offline ? (
        <div className="border-y border-warning/35 bg-warning-soft px-4 py-3 text-sm" role="status">
          <p className="font-bold">Showing the last verified response</p>
          <p className="mt-1 leading-6 text-muted">
            Reconnect to read current receipt and projection evidence. IronWrap OS will not infer a
            newer result while offline.
          </p>
        </div>
      ) : null}
      {query.isError && query.data ? (
        <div className="border-y border-danger/30 bg-danger-soft px-4 py-3 text-sm" role="alert">
          <p className="font-bold">The latest refresh was not verified</p>
          <p className="mt-1 leading-6 text-muted">
            The cards below are the prior verified response; no newer state is claimed.
          </p>
        </div>
      ) : null}

      <div className="grid gap-px border border-border bg-border sm:grid-cols-4">
        <Metric label="Native designs" value={counts.projected} tone="ok" />
        <Metric label="Awaiting projection" value={counts.awaiting_projection} tone="warning" />
        <Metric label="Lifecycle holds" value={counts.held} tone="muted" />
        <Metric label="Needs attention" value={counts.attention_required} tone="danger" />
      </div>

      {query.data.intake_exceptions.length > 0 ? (
        <section className="space-y-3" aria-labelledby="facet-delivery-exceptions-heading">
          <div>
            <p className="text-sm font-bold text-danger">Signed delivery exceptions</p>
            <h2 id="facet-delivery-exceptions-heading" className="mt-1 text-xl font-black">
              Recover without a manual association
            </h2>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
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
          title="No signed Facet decisions yet"
          message="A customer-approved v2 decision will appear here after the signed producer delivery is accepted."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2" aria-live="polite">
          {query.data.evidence.map((evidence) => (
            <EvidenceCard key={evidence.event_id} evidence={evidence} />
          ))}
        </div>
      )}

      <p className="text-right text-xs text-muted">
        Read model generated {readableDate(query.data.read_model_generated_at)}
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
            {awaiting ? "Waiting for the exact project link" : "Signed delivery rejected"}
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted">
            {awaiting
              ? "IronWrap saved the signed delivery and is retrying reconciliation automatically. If it stays here, open the approved estimator job and issue a fresh signed Facet launch."
              : "IronWrap rejected this delivery before any native design state was recorded. Correct the source identity or decision chain, then reissue it from the approved estimator job."}
          </p>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <Detail label="Event" value={exception.event_id} mono />
            <Detail label="Reason" value={exception.status_code.replaceAll("_", " ")} />
          </dl>
          <Button asChild variant="outline" size="compact" className="mt-4">
            <Link to="/sales">Open the governed sales path</Link>
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
      <p className="mt-1 text-sm font-bold text-muted">{label}</p>
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
          <p className="text-sm font-bold capitalize text-muted">
            Customer decision · {evidence.decision_kind}
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
          <Detail label="Source quote" value={evidence.customer_quote_id} />
          <Detail label="Customer decision" value={readableDate(evidence.occurred_at)} />
          <Detail label="Identity proof" value="Google OIDC · exact project link" />
          {evidence.projection?.source_quote_revision_id ? (
            <Detail
              label="Accepted quote revision"
              value={evidence.projection.source_quote_revision_id}
            />
          ) : null}
          {evidence.projection?.source_quote_version ? (
            <Detail
              label="Accepted quote version"
              value={`Version ${evidence.projection.source_quote_version}`}
            />
          ) : null}
          {evidence.projection?.design_sequence ? (
            <Detail
              label="Design sequence"
              value={`${evidence.projection.design_sequence} · ${evidence.projection.design_state}`}
            />
          ) : null}
        </dl>
        <details className="border-t border-border pt-4 text-sm">
          <summary className="cursor-pointer font-semibold text-muted">
            Immutable evidence anchors
          </summary>
          <dl className="mt-3 grid gap-3 break-all text-xs">
            <Detail label="Facet project" value={evidence.facet_project_id} mono />
            <Detail label="Event" value={evidence.event_id} mono />
            <Detail label="Revision" value={evidence.design_revision_id} mono />
            <Detail label="Design SHA-256" value={evidence.design_revision_sha256} mono />
            <Detail label="Frozen evidence SHA-256" value={evidence.frozen_evidence_sha256} mono />
            <Detail label="Association SHA-256" value={evidence.association_sha256} mono />
            <Detail label="Project link" value={evidence.external_project_link_id} mono />
            {evidence.projection?.projection_id ? (
              <Detail label="Native projection" value={evidence.projection.projection_id} mono />
            ) : null}
            {evidence.projection?.projection_sha256 ? (
              <Detail
                label="Projection SHA-256"
                value={evidence.projection.projection_sha256}
                mono
              />
            ) : null}
            {evidence.projection?.source_proposal_revision_id ? (
              <Detail
                label="Accepted proposal"
                value={evidence.projection.source_proposal_revision_id}
                mono
              />
            ) : null}
            {evidence.projection?.source_publication_event_id ? (
              <Detail
                label="Publication event"
                value={evidence.projection.source_publication_event_id}
                mono
              />
            ) : null}
            {evidence.projection?.source_acceptance_binding_id ? (
              <Detail
                label="Acceptance binding"
                value={evidence.projection.source_acceptance_binding_id}
                mono
              />
            ) : null}
            {evidence.projection?.launch_intent_sha256 ? (
              <Detail
                label="Launch intent SHA-256"
                value={evidence.projection.launch_intent_sha256}
                mono
              />
            ) : null}
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
      label:
        evidence.projection?.outcome === "reconciled_native_design"
          ? "Reconciled"
          : "Native design ready",
      detail:
        "IronWrap verified the signed receipt and recorded native design authority against the accepted commercial source. Pricing stays unchanged until governed estimator work creates a revision.",
      tone: "text-ok",
      icon: CheckCircle2,
    };
  }
  if (evidence.projection_state === "awaiting_projection") {
    return {
      label: "Awaiting projection",
      detail:
        "The signed customer decision is accepted and queued for native design materialization.",
      tone: "text-warning",
      icon: Clock3,
    };
  }
  if (evidence.projection_state === "held") {
    return {
      label: "Lifecycle hold",
      detail:
        evidence.decision_kind === "withdrawn"
          ? "The customer withdrew this design. IronWrap preserved the chain as a native terminal state."
          : "This design was superseded. IronWrap preserved the chain as a native terminal state.",
      tone: "text-muted",
      icon: FileCheck2,
    };
  }
  return {
    label: "Needs attention",
    detail: `IronWrap failed closed before claiming native design authority (${evidence.status_code.replaceAll("_", " ")}).`,
    tone: "text-danger",
    icon: AlertTriangle,
  };
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
