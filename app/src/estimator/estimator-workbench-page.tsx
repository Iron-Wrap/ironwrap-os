import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  ClipboardList,
  FileSearch,
  FileText,
  Layers3,
  RefreshCw,
  Ruler,
  ScrollText,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { ErrorState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import { loadEstimatorWorkbench } from "./estimator-api";
import type { EstimatorGeometry, EstimatorWorkbenchResponse } from "./estimator-contracts";

export function EstimatorWorkbenchPage() {
  return (
    <RoleGuard surface="sales">
      <EstimatorWorkbenchContent />
    </RoleGuard>
  );
}

function EstimatorWorkbenchContent() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const session = useSession();
  const query = useQuery({
    queryKey: ["estimator-workbench", session.tenant.id, session.user.id, jobId],
    enabled: Boolean(jobId),
    queryFn: () => loadEstimatorWorkbench(jobId!),
  });

  if (!jobId) {
    return (
      <ErrorState
        title="This workbench link is incomplete"
        message="No roof-job record was provided."
      />
    );
  }
  if (!query.data && query.isPending) return <EstimatorWorkbenchSkeleton />;
  if (!query.data && query.isError)
    return <EstimatorWorkbenchError onRetry={() => void query.refetch()} />;
  if (!query.data) return <EstimatorWorkbenchSkeleton />;

  return (
    <EstimatorWorkbenchScreen
      model={query.data}
      locale={session.tenant.locale}
      tenantCurrency={session.tenant.currency}
      refreshFailed={query.isError}
      onRetry={() => void query.refetch()}
    />
  );
}

function EstimatorWorkbenchScreen({
  model,
  locale,
  tenantCurrency,
  refreshFailed,
  onRetry,
}: {
  model: EstimatorWorkbenchResponse;
  locale: string;
  tenantCurrency: string;
  refreshFailed: boolean;
  onRetry: () => void;
}) {
  const selectedMeasurement = model.measurements.selected;
  const quote = model.quote;
  const proposal = model.proposal;
  const bounded =
    model.partial_sources.length > 0 ||
    model.stale_fields.length > 0 ||
    model.source_updated_at === null;

  return (
    <section className="mx-auto max-w-7xl space-y-7 overflow-x-hidden pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/sales">
                <ArrowLeft aria-hidden="true" />
                Back to sales
              </Link>
            </Button>
            <div className="mt-4 flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
                <Ruler className="size-5 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-muted">
                  {model.job.job_number ?? model.job.id}
                  {model.job.service_type ? ` · ${model.job.service_type}` : ""}
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Measurement workbench
                </h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted sm:text-base">
                  Trace the measurement source into the takeoff and customer-facing record. This
                  review does not change prices, assemble a proposal, or contact a customer.
                </p>
              </div>
            </div>
          </div>
          <p className="text-sm text-muted">
            Read generated {formatDate(model.read_model_generated_at, locale) ?? "time unavailable"}
          </p>
        </div>
      </header>

      {refreshFailed ? <RefreshWarning onRetry={onRetry} /> : null}
      {bounded ? <DataBoundary model={model} /> : null}

      <EvidencePath
        measurement={selectedMeasurement}
        takeoff={model.takeoffs.selected}
        quote={quote}
        proposal={proposal}
        lineage={model.lineage}
      />

      <MeasurementSource model={model} locale={locale} />

      <div className="grid min-w-0 items-start gap-7 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.85fr)]">
        <TakeoffReview model={model} locale={locale} />
        <CommercialRecord model={model} locale={locale} tenantCurrency={tenantCurrency} />
      </div>
    </section>
  );
}

function EvidencePath({
  measurement,
  takeoff,
  quote,
  proposal,
  lineage,
}: {
  measurement: EstimatorWorkbenchResponse["measurements"]["selected"];
  takeoff: EstimatorWorkbenchResponse["takeoffs"]["selected"];
  quote: EstimatorWorkbenchResponse["quote"];
  proposal: EstimatorWorkbenchResponse["proposal"];
  lineage: EstimatorWorkbenchResponse["lineage"];
}) {
  const steps = [
    {
      label: "Measurement source",
      detail: measurement
        ? `${humanize(measurement.provider) ?? "Provider unavailable"} · ${humanize(measurement.review_status) ?? "Review state unavailable"}`
        : "No report returned",
      tone: measurement
        ? measurementTone(measurement.geometry.state)
        : "bg-surface-muted text-muted",
    },
    {
      label: "Material takeoff",
      ...takeoffEvidenceStep(takeoff, lineage.measurement_to_takeoff),
    },
    {
      label: "Proposal record",
      ...proposalEvidenceStep(quote, proposal, lineage.quote_to_proposal),
    },
  ];
  return (
    <ol className="grid border-y border-border sm:grid-cols-3" aria-label="Evidence path">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={cn(
            "min-h-24 px-4 py-4 sm:px-5",
            index > 0 && "border-t border-border sm:border-t-0 sm:border-l",
          )}
        >
          <p className="text-sm font-bold text-muted">{step.label}</p>
          <span
            className={cn(
              "mt-2 inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold",
              step.tone,
            )}
          >
            {step.detail}
          </span>
        </li>
      ))}
    </ol>
  );
}

function takeoffEvidenceStep(
  takeoff: EstimatorWorkbenchResponse["takeoffs"]["selected"],
  lineage: EstimatorWorkbenchResponse["lineage"]["measurement_to_takeoff"],
) {
  if (lineage === "linked" && takeoff) {
    return {
      detail: humanize(takeoff.status) ?? "Linked record",
      tone: reviewTone(takeoff.status),
    };
  }
  if (lineage === "mismatch") {
    return { detail: "No takeoff links to this measurement", tone: "bg-warning-soft text-warning" };
  }
  if (lineage === "unknown") {
    return { detail: "Takeoff linkage incomplete", tone: "bg-warning-soft text-warning" };
  }
  if (lineage === "no_measurement") {
    return { detail: "No measurement returned", tone: "bg-surface-muted text-muted" };
  }
  return { detail: "No takeoff returned", tone: "bg-surface-muted text-muted" };
}

function proposalEvidenceStep(
  quote: EstimatorWorkbenchResponse["quote"],
  proposal: EstimatorWorkbenchResponse["proposal"],
  lineage: EstimatorWorkbenchResponse["lineage"]["quote_to_proposal"],
) {
  if (lineage === "linked" && proposal) {
    return {
      detail: humanize(proposal.status) ?? "Linked record",
      tone: proposalTone(proposal.status),
    };
  }
  if (lineage === "mismatch") {
    return { detail: "No proposal links to this quote", tone: "bg-warning-soft text-warning" };
  }
  if (lineage === "unknown") {
    return { detail: "Proposal linkage incomplete", tone: "bg-warning-soft text-warning" };
  }
  if (lineage === "no_quote") {
    return { detail: "No quote returned", tone: "bg-surface-muted text-muted" };
  }
  return {
    detail: quote
      ? `Quote ${humanize(quote.status) ?? "state unavailable"}`
      : "No proposal returned",
    tone: quote ? quoteTone(quote.status) : "bg-surface-muted text-muted",
  };
}

function MeasurementSource({
  model,
  locale,
}: {
  model: EstimatorWorkbenchResponse;
  locale: string;
}) {
  const selected = model.measurements.selected;
  if (!selected) {
    return (
      <section className="border-y border-border py-6" aria-labelledby="measurement-source-heading">
        <SectionHeading
          id="measurement-source-heading"
          icon={Ruler}
          title="Measurement source"
          description="No measurement report was returned for this roof job. A quote or takeoff should not be treated as measurement proof."
        />
      </section>
    );
  }
  const geometry = selected.geometry;
  return (
    <section className="border-y border-border" aria-labelledby="measurement-source-heading">
      <div className="px-4 py-6 sm:px-6 sm:py-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <SectionHeading
            id="measurement-source-heading"
            icon={Ruler}
            title="Measurement source"
            description="Declared values are retained alongside the values recomputed from the captured source file."
          />
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <StatusChip
              label={humanize(selected.review_status) ?? "Review state unavailable"}
              tone={reviewTone(selected.review_status)}
            />
            <StatusChip
              label={humanize(selected.provider) ?? "Provider unavailable"}
              tone="bg-surface-muted text-muted"
            />
          </div>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <GeometryStatus geometry={geometry} />
          <dl className="grid grid-cols-3 border-y border-border lg:grid-cols-1 lg:border-y-0 lg:border-l">
            <MeasurementFact label="Reports" value={String(model.measurements.reports.length)} />
            <MeasurementFact label="Facets" value={String(geometry.facet_count)} bordered />
            <MeasurementFact
              label="Failed checks"
              value={String(geometry.failed_check_count)}
              bordered
              danger={geometry.failed_check_count > 0}
            />
          </dl>
        </div>

        <p className="mt-5 max-w-4xl border border-warning/40 bg-warning-soft/55 px-4 py-3 text-sm leading-6 text-foreground">
          Geometry recomputation checks the captured file, not the site. It does not verify
          concealed conditions, substrate condition, access, or field dimensions.
        </p>

        <GeometryFacets geometry={geometry} locale={locale} />
        <GeometryChecks geometry={geometry} />
        <MeasurementMetrics measurement={selected} />
      </div>
    </section>
  );
}

function GeometryStatus({ geometry }: { geometry: EstimatorGeometry }) {
  const copy = geometryStatusCopy(geometry);
  const Icon = copy.icon;
  return (
    <div className={cn("flex gap-3 border p-4", copy.surface)} role="status">
      <Icon className={cn("mt-0.5 size-5 shrink-0", copy.iconTone)} aria-hidden="true" />
      <div>
        <p className="font-bold text-foreground">{copy.title}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{copy.detail}</p>
      </div>
    </div>
  );
}

function GeometryFacets({ geometry, locale }: { geometry: EstimatorGeometry; locale: string }) {
  if (geometry.state === "unavailable") return null;
  if (geometry.facets.length === 0) {
    return (
      <p className="mt-6 text-sm leading-6 text-muted">
        No roof facets were returned by the source parser.
      </p>
    );
  }
  return (
    <section className="mt-7" aria-labelledby="facet-comparison-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id="facet-comparison-heading" className="text-lg font-black tracking-[-0.02em]">
            Facet comparison
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted">
            Declared and recomputed roof areas remain side by side.
          </p>
        </div>
        {geometry.facets_truncated ? (
          <p className="text-sm font-semibold text-warning">First returned facets shown</p>
        ) : null}
      </div>
      <p className="mt-3 text-xs font-semibold text-muted sm:hidden">
        Swipe the table to compare every source value.
      </p>
      <div
        className="mt-2 overflow-x-auto border-y border-border"
        aria-label="Facet comparison table"
      >
        <table className="min-w-[45rem] w-full border-collapse text-left text-sm">
          <thead className="bg-surface-muted text-muted">
            <tr>
              <TableHeader>Facet</TableHeader>
              <TableHeader>Surface</TableHeader>
              <TableHeader>Declared</TableHeader>
              <TableHeader>Recomputed</TableHeader>
              <TableHeader>Deviation</TableHeader>
              <TableHeader>Pitch</TableHeader>
              <TableHeader>Ring</TableHeader>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {geometry.facets.map((facet) => {
              const flagged =
                !facet.ring_closed || (facet.deviation !== null && facet.deviation > 0.03);
              return (
                <tr key={facet.id} className={cn(flagged && "bg-warning-soft/30")}>
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-foreground">
                    {facet.id}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {[facet.type, facet.material].filter(Boolean).join(" · ") || "Not recorded"}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {formatArea(facet.declared_area, locale)}
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    {formatArea(facet.computed_area, locale)}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-3 tabular-nums font-semibold",
                      flagged ? "text-warning" : "text-muted",
                    )}
                  >
                    {formatPercent(facet.deviation, locale)}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted">
                    {facet.pitch === null ? "Not recorded" : `${facet.pitch}/12`}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-3 font-semibold",
                      facet.ring_closed ? "text-ok" : "text-warning",
                    )}
                  >
                    {facet.ring_closed ? "Closed" : "Open"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function GeometryChecks({ geometry }: { geometry: EstimatorGeometry }) {
  if (geometry.state === "unavailable") return null;
  return (
    <section className="mt-7" aria-labelledby="geometry-checks-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 id="geometry-checks-heading" className="text-lg font-black tracking-[-0.02em]">
            Source checks
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted">
            File references, perimeter closure, and declared geometry are checked deterministically.
          </p>
        </div>
        <p
          className={cn(
            "text-sm font-bold",
            geometry.failed_check_count > 0 ? "text-warning" : "text-ok",
          )}
        >
          {geometry.failed_check_count > 0
            ? `${geometry.failed_check_count} need review`
            : "No failed checks returned"}
        </p>
      </div>
      {geometry.checks.length === 0 ? (
        <div className="mt-3 border border-border px-4 py-3 text-sm leading-6 text-muted">
          No source exceptions were returned. This is not field-verification evidence.
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {geometry.checks.map((check) => (
            <li
              key={`${check.check}:${check.target}`}
              className="flex gap-3 px-4 py-3 text-sm leading-6"
            >
              {check.ok ? (
                <Check className="mt-1 size-4 shrink-0 text-ok" aria-hidden="true" />
              ) : (
                <TriangleAlert className="mt-1 size-4 shrink-0 text-warning" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <p className="font-semibold text-foreground">
                  {humanize(check.check) ?? check.check} · {check.target}
                </p>
                <p className="text-muted">{check.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {geometry.checks_truncated ? (
        <p className="mt-2 text-sm font-semibold text-warning">
          Only the first returned checks are displayed.
        </p>
      ) : null}
    </section>
  );
}

function MeasurementMetrics({
  measurement,
}: {
  measurement: NonNullable<EstimatorWorkbenchResponse["measurements"]["selected"]>;
}) {
  const sourceMetrics = measurement.metrics;
  const geometryMetrics = measurement.geometry.metrics;
  if (sourceMetrics.length === 0 && geometryMetrics.length === 0) return null;
  return (
    <section className="mt-7" aria-labelledby="measurement-metrics-heading">
      <h3 id="measurement-metrics-heading" className="text-lg font-black tracking-[-0.02em]">
        Measurement references
      </h3>
      <p className="mt-1 text-sm leading-6 text-muted">
        Values stay attached to their extraction or source-file reference.
      </p>
      {sourceMetrics.length > 0 ? (
        <MetricList
          title="Recorded metrics"
          metrics={sourceMetrics.map((metric) => ({
            id: metric.metric,
            label: metric.metric,
            value:
              [formatNumber(metric.value), metric.unit].filter(Boolean).join(" ") || "Not recorded",
            source: metric.source_ref,
            warning: metric.needs_review,
            detail: metric.confidence,
          }))}
        />
      ) : null}
      {geometryMetrics.length > 0 ? (
        <MetricList
          title="Recomputed source metrics"
          metrics={geometryMetrics.map((metric) => ({
            id: metric.metric,
            label: metric.metric,
            value: formatNumber(metric.value),
            source: metric.source_ref,
            warning: false,
            detail: "Derived from captured source geometry",
          }))}
        />
      ) : null}
      {measurement.metrics_truncated || measurement.geometry.metrics_truncated ? (
        <p className="mt-2 text-sm font-semibold text-warning">
          Only the first returned metrics are displayed.
        </p>
      ) : null}
    </section>
  );
}

function MetricList({
  title,
  metrics,
}: {
  title: string;
  metrics: Array<{
    id: string;
    label: string;
    value: string;
    source: string | null;
    warning: boolean;
    detail: string | null;
  }>;
}) {
  return (
    <div className="mt-4 border-y border-border">
      <p className="px-4 py-3 text-sm font-bold text-muted">{title}</p>
      <ul className="divide-y divide-border">
        {metrics.map((metric) => (
          <li
            key={`${title}:${metric.id}`}
            className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(9rem,0.6fr)_minmax(0,1.6fr)] sm:gap-4"
          >
            <p className="font-semibold text-foreground">
              {humanize(metric.label) ?? metric.label}
            </p>
            <p className="tabular-nums text-foreground">{metric.value}</p>
            <p
              className={cn(
                "break-words text-sm leading-5",
                metric.warning ? "text-warning" : "text-muted",
              )}
            >
              {[metric.detail, metric.source].filter(Boolean).join(" · ") ||
                "Source reference unavailable"}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TakeoffReview({ model, locale }: { model: EstimatorWorkbenchResponse; locale: string }) {
  const selected = model.takeoffs.selected;
  const lineage = model.lineage.measurement_to_takeoff;
  return (
    <section
      className="min-w-0 border-y border-border py-6 sm:py-7"
      aria-labelledby="takeoff-heading"
    >
      <div className="px-4 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <SectionHeading
            id="takeoff-heading"
            icon={Layers3}
            title="Material takeoff"
            description="Items remain linked to their measurement reference and review state."
          />
          {selected ? (
            <StatusChip
              label={humanize(selected.status) ?? "State unavailable"}
              tone={reviewTone(selected.status)}
            />
          ) : null}
        </div>

        {!selected ? (
          <EmptyInline message={takeoffEmptyMessage(model, lineage)} />
        ) : (
          <>
            <p className="mt-6 text-xs font-semibold text-muted sm:hidden">
              Swipe the table to review each source reference.
            </p>
            <div
              className="mt-2 overflow-x-auto border-y border-border"
              aria-label="Material takeoff table"
            >
              <table className="min-w-[48rem] w-full border-collapse text-left text-sm">
                <thead className="bg-surface-muted text-muted">
                  <tr>
                    <TableHeader>Item</TableHeader>
                    <TableHeader>Quantity</TableHeader>
                    <TableHeader>Waste</TableHeader>
                    <TableHeader>Source reference</TableHeader>
                    <TableHeader>Review</TableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {selected.items.length > 0 ? (
                    selected.items.map((item, index) => (
                      <tr
                        key={`${item.item_name ?? "item"}:${index}`}
                        className={cn(item.needs_review && "bg-warning-soft/30")}
                      >
                        <td className="px-4 py-3">
                          <p className="font-semibold text-foreground">
                            {item.item_name ?? "Unnamed item"}
                          </p>
                          {item.category ? (
                            <p className="mt-0.5 text-xs text-muted">{item.category}</p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {[formatNumber(item.quantity), item.unit].filter(Boolean).join(" ") ||
                            "Not recorded"}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-muted">
                          {formatPercent(
                            item.waste_factor === null ? null : item.waste_factor / 100,
                            locale,
                          )}
                        </td>
                        <td className="max-w-xs break-words px-4 py-3 text-muted">
                          {item.source_ref ?? "Source reference unavailable"}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 font-semibold",
                            item.needs_review ? "text-warning" : "text-ok",
                          )}
                        >
                          {item.needs_review ? "Needs review" : (item.confidence ?? "Recorded")}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-4 py-5 text-muted">
                        No takeoff items were returned.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {selected.items_truncated ? (
              <p className="mt-2 text-sm font-semibold text-warning">
                Only the first returned takeoff items are displayed.
              </p>
            ) : null}
            <AssumptionLedger assumptions={selected.assumptions} exclusions={selected.exclusions} />
          </>
        )}
      </div>
    </section>
  );
}

function CommercialRecord({
  model,
  locale,
  tenantCurrency,
}: {
  model: EstimatorWorkbenchResponse;
  locale: string;
  tenantCurrency: string;
}) {
  const quote = model.quote;
  const proposal = model.proposal;
  const proposalLineage = model.lineage.quote_to_proposal;
  return (
    <aside className="min-w-0 space-y-7 xl:sticky xl:top-28" aria-label="Commercial record">
      <section className="border-y border-border py-6" aria-labelledby="quote-heading">
        <div className="px-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <SectionHeading
              id="quote-heading"
              icon={FileText}
              title="Customer quote"
              description="A versioned commercial record, not a live price calculator."
            />
            {quote ? (
              <StatusChip
                label={humanize(quote.status) ?? "State unavailable"}
                tone={quoteTone(quote.status)}
              />
            ) : null}
          </div>
          {!quote ? (
            <EmptyInline message="No customer quote was returned." />
          ) : (
            <QuoteLedger quote={quote} locale={locale} tenantCurrency={tenantCurrency} />
          )}
        </div>
      </section>

      <section className="border-y border-border py-6" aria-labelledby="proposal-heading">
        <div className="px-4 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <SectionHeading
              id="proposal-heading"
              icon={ScrollText}
              title="Proposal evidence"
              description="Proposal state stays separate from quote and payment state."
            />
            {proposal ? (
              <StatusChip
                label={humanize(proposal.status) ?? "State unavailable"}
                tone={proposalTone(proposal.status)}
              />
            ) : null}
          </div>
          {!proposal ? (
            <EmptyInline message={proposalEmptyMessage(quote, model.proposal, proposalLineage)} />
          ) : (
            <div className="mt-5 space-y-3 text-sm leading-6">
              <RecordLine
                label="Prepared"
                value={formatDate(proposal.prepared_at, locale) ?? "Not recorded"}
              />
              <RecordLine
                label="Approved"
                value={formatDate(proposal.approved_at, locale) ?? "Not recorded"}
              />
              <RecordLine
                label="Signed"
                value={formatDate(proposal.signed_at, locale) ?? "Not recorded"}
              />
              <AssumptionLedger
                assumptions={proposal.assumptions}
                exclusions={proposal.exclusions}
                compact
              />
            </div>
          )}
        </div>
      </section>

      <section className="border-y border-border py-6" aria-labelledby="scope-heading">
        <div className="px-4 sm:px-5">
          <SectionHeading
            id="scope-heading"
            icon={ClipboardList}
            title="Scope clauses"
            description="Visible scope, assumptions, exclusions, and risks remain attributable."
          />
          <ScopeClauses clauses={model.scope_clauses} locale={locale} />
        </div>
      </section>
    </aside>
  );
}

function takeoffEmptyMessage(
  model: EstimatorWorkbenchResponse,
  lineage: EstimatorWorkbenchResponse["lineage"]["measurement_to_takeoff"],
): string {
  if (lineage === "mismatch") {
    const count = model.takeoffs.records.length;
    return `${count} takeoff ${count === 1 ? "record was" : "records were"} returned, but none link to the selected measurement report. Do not infer material lineage.`;
  }
  if (lineage === "unknown") {
    return "The returned takeoff history reached the safe source boundary, so linkage cannot be determined.";
  }
  if (lineage === "no_measurement") {
    return "No selected measurement report is available to anchor a material takeoff.";
  }
  return "No material takeoff was returned. Do not infer material quantities from a quote total.";
}

function proposalEmptyMessage(
  quote: EstimatorWorkbenchResponse["quote"],
  proposal: EstimatorWorkbenchResponse["proposal"],
  lineage: EstimatorWorkbenchResponse["lineage"]["quote_to_proposal"],
): string {
  if (lineage === "mismatch") {
    return "Proposal records were returned, but none link to the selected quote. Do not imply that a customer-ready proposal exists.";
  }
  if (lineage === "unknown") {
    return "The returned proposal history reached the safe source boundary, so linkage to the selected quote cannot be determined.";
  }
  if (lineage === "no_quote") {
    return "No customer quote is available to anchor proposal evidence.";
  }
  if (!quote && !proposal)
    return "No proposal evidence pack was returned. Do not imply that a customer-ready proposal exists.";
  return "No proposal evidence pack was returned for the selected quote. Do not imply that a customer-ready proposal exists.";
}

function QuoteLedger({
  quote,
  locale,
  tenantCurrency,
}: {
  quote: NonNullable<EstimatorWorkbenchResponse["quote"]>;
  locale: string;
  tenantCurrency: string;
}) {
  const currency = quote.currency ?? tenantCurrency;
  const nonBinding = quote.status === "Draft" || quote.status === "Needs Review";
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        {quote.version !== null ? (
          <p className="text-sm font-bold text-muted">Version {quote.version}</p>
        ) : null}
        {nonBinding ? (
          <StatusChip label="Not customer-ready" tone="bg-warning-soft text-warning" />
        ) : null}
      </div>
      <p className="mt-3 text-3xl font-black tracking-[-0.035em] tabular-nums">
        {formatMoney(quote.quote_total, locale, currency) ?? "Total not recorded"}
      </p>
      <dl className="mt-5 divide-y divide-border border-y border-border">
        <RecordLine label="Price book" value={quote.price_book_version ?? "Not recorded"} />
        <RecordLine
          label="Pricing effective"
          value={formatDate(quote.pricing_effective_at, locale) ?? "Not recorded"}
        />
        <RecordLine
          label="Subtotal"
          value={formatMoney(quote.subtotal, locale, currency) ?? "Not recorded"}
        />
        <RecordLine label="Tax" value={taxLabel(quote, locale, currency)} />
        <RecordLine
          label="Deposit"
          value={formatMoney(quote.deposit_amount, locale, currency) ?? "Not recorded"}
        />
        <RecordLine label="Payment record" value={quote.payment_status ?? "Not recorded"} />
        <RecordLine
          label="Valid until"
          value={formatDate(quote.valid_until, locale, { dateStyle: "medium" }) ?? "Not recorded"}
        />
      </dl>
      {!quote.price_book_version ? (
        <p className="mt-4 border border-warning/40 bg-warning-soft/55 px-3 py-3 text-sm leading-6 text-foreground">
          A price-book version was not returned. Do not treat this quote as current pricing proof.
        </p>
      ) : null}
      <div className="mt-5 text-sm leading-6">
        {quote.scope_summary ? <p className="text-foreground">{quote.scope_summary}</p> : null}
        <AssumptionLedger assumptions={quote.assumptions} exclusions={quote.exclusions} compact />
        {quote.supersedes || quote.correction_reason ? (
          <p className="mt-3 text-muted">
            {[quote.supersedes ? `Supersedes ${quote.supersedes}` : null, quote.correction_reason]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ScopeClauses({
  clauses,
  locale,
}: {
  clauses: EstimatorWorkbenchResponse["scope_clauses"];
  locale: string;
}) {
  if (clauses.length === 0) return <EmptyInline message="No scope clauses were returned." />;
  return (
    <ol className="mt-5 divide-y divide-border border-y border-border">
      {clauses.map((clause) => (
        <li key={clause.id} className="py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="font-bold text-foreground">{clause.title ?? "Untitled clause"}</p>
            <StatusChip
              label={humanize(clause.status) ?? "State unavailable"}
              tone={reviewTone(clause.status)}
            />
          </div>
          <p className="mt-1 text-sm font-semibold text-muted">
            {[clause.type, clause.version].filter(Boolean).join(" · ") ||
              "Classification unavailable"}
          </p>
          {clause.text ? (
            <p className="mt-2 text-sm leading-6 text-foreground">{clause.text}</p>
          ) : null}
          <p className="mt-2 break-words text-xs leading-5 text-muted">
            {[
              clause.customer_visible ? "Customer visible" : "Internal",
              clause.source_ref,
              formatDate(clause.approved_at, locale, { dateStyle: "medium" }),
            ]
              .filter(Boolean)
              .join(" · ") || "Source reference unavailable"}
          </p>
        </li>
      ))}
    </ol>
  );
}

function AssumptionLedger({
  assumptions,
  exclusions,
  compact = false,
}: {
  assumptions: string | null;
  exclusions: string | null;
  compact?: boolean;
}) {
  if (!assumptions && !exclusions) return null;
  return (
    <dl
      className={cn(
        "mt-5 divide-y divide-border border-y border-border text-sm leading-6",
        compact && "mt-4",
      )}
    >
      {assumptions ? <RecordLine label="Assumptions" value={assumptions} multiline /> : null}
      {exclusions ? <RecordLine label="Exclusions" value={exclusions} multiline /> : null}
    </dl>
  );
}

function SectionHeading({
  id,
  icon: Icon,
  title,
  description,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="min-w-0">
      <h2
        id={id}
        className="flex items-center gap-2 text-xl font-black tracking-[-0.025em] text-balance sm:text-2xl"
      >
        <Icon className="size-5 text-accent" aria-hidden="true" />
        {title}
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{description}</p>
    </div>
  );
}

function MeasurementFact({
  label,
  value,
  bordered = false,
  danger = false,
}: {
  label: string;
  value: string;
  bordered?: boolean;
  danger?: boolean;
}) {
  return (
    <div
      className={cn(
        "px-3 py-3 sm:px-4 lg:py-2",
        bordered && "border-l border-border lg:border-l-0 lg:border-t",
      )}
    >
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-lg font-black tabular-nums",
          danger ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function RecordLine({
  label,
  value,
  multiline = false,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-1 py-3 text-sm",
        multiline ? "grid-cols-1" : "grid-cols-[minmax(7.5rem,0.8fr)_minmax(0,1.2fr)] gap-3",
      )}
    >
      <dt className="font-bold text-muted">{label}</dt>
      <dd className={cn("min-w-0 break-words text-foreground", multiline && "leading-6")}>
        {value}
      </dd>
    </div>
  );
}

function StatusChip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      className={cn("inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold", tone)}
    >
      {label}
    </span>
  );
}

function TableHeader({ children }: { children: string }) {
  return (
    <th scope="col" className="px-4 py-3 text-xs font-bold">
      {children}
    </th>
  );
}

function EmptyInline({ message }: { message: string }) {
  return (
    <p className="mt-5 border border-border bg-surface-muted/45 px-4 py-3 text-sm leading-6 text-muted">
      {message}
    </p>
  );
}

function DataBoundary({ model }: { model: EstimatorWorkbenchResponse }) {
  const sources = model.partial_sources
    .map(humanize)
    .filter((source): source is string => Boolean(source));
  return (
    <div
      className="flex gap-3 border border-warning/40 bg-warning-soft/55 p-4 text-sm leading-6"
      role="status"
    >
      <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div>
        <p className="font-bold text-foreground">This is a bounded source review.</p>
        <p className="mt-1 text-muted">
          {sources.length > 0
            ? `${sources.join(", ")} ${sources.length === 1 ? "reached" : "reached"} the read limit. History and counts may be incomplete.`
            : "One or more source details are unavailable. Do not treat an empty field as proof that the underlying record does not exist."}
        </p>
      </div>
    </div>
  );
}

function RefreshWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex flex-col gap-3 border border-warning/40 bg-warning-soft/55 p-4 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <div className="flex gap-3 text-sm leading-6">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <p>
          Showing the last verified workbench read. The refresh did not complete, so do not assume
          newer measurement or quote state.
        </p>
      </div>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Refresh read
      </Button>
    </div>
  );
}

function EstimatorWorkbenchError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Measurement workbench is unavailable"
      message="No source-backed estimator record was loaded. This page will not create a demo takeoff or assume a quote is current."
      onRetry={onRetry}
    />
  );
}

function EstimatorWorkbenchSkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-7"
      aria-busy="true"
      aria-label="Loading measurement workbench"
    >
      <div className="h-28 border-b border-border bg-surface-muted/60" />
      <div className="grid border-y border-border sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={cn(
              "min-h-24 bg-surface-muted/50",
              index > 0 && "border-t border-border sm:border-t-0 sm:border-l",
            )}
          />
        ))}
      </div>
      <div className="h-[32rem] border-y border-border bg-surface-muted/40" />
    </section>
  );
}

function geometryStatusCopy(geometry: EstimatorGeometry): {
  title: string;
  detail: string;
  surface: string;
  iconTone: string;
  icon: LucideIcon;
} {
  if (geometry.state === "recomputed") {
    return {
      title: "Geometry recomputed from source file",
      detail:
        "Declared geometry was recomputed from the retained source. Field verification still needs separate evidence.",
      surface: "border-ok/40 bg-ok-soft/45",
      iconTone: "text-ok",
      icon: Check,
    };
  }
  if (geometry.state === "needs_review") {
    return {
      title: "Geometry needs review",
      detail: `${geometry.failed_check_count} source check${geometry.failed_check_count === 1 ? "" : "s"} failed or needs attention before a takeoff is trusted.`,
      surface: "border-warning/40 bg-warning-soft/55",
      iconTone: "text-warning",
      icon: ShieldAlert,
    };
  }
  return {
    title: "Source geometry could not be recomputed",
    detail: geometryUnavailableCopy(geometry.reason),
    surface: "border-warning/40 bg-warning-soft/55",
    iconTone: "text-warning",
    icon: FileSearch,
  };
}

function geometryUnavailableCopy(reason: string | null): string {
  if (reason === "raw_source_not_recorded")
    return "This measurement report has no retained raw source reference.";
  if (reason === "raw_source_not_found") return "The retained measurement source was not found.";
  if (reason === "raw_source_too_large")
    return "The retained source exceeds the safe recomputation limit.";
  if (reason === "raw_source_not_recomputable")
    return "The retained source does not contain a supported recomputable geometry export.";
  if (reason === "raw_source_rejected")
    return "The retained source reference was rejected by the server safety boundary.";
  if (reason === "raw_source_read_failed")
    return "The retained source could not be read safely for recomputation.";
  if (reason === "measurement_detail_unavailable")
    return "The selected measurement detail is no longer available from the operating record.";
  if (reason === "measurement_detail_too_large")
    return "The selected measurement detail exceeded the safe server read limit.";
  if (reason === "measurement_detail_mismatch")
    return "The selected measurement detail no longer matches this roof job.";
  return "No measurement source was returned for recomputation.";
}

function measurementTone(state: EstimatorGeometry["state"]): string {
  if (state === "recomputed") return "bg-ok-soft text-ok";
  if (state === "needs_review") return "bg-warning-soft text-warning";
  return "bg-surface-muted text-muted";
}

function reviewTone(status: string | null): string {
  if (status === "Approved") return "bg-ok-soft text-ok";
  if (status === "Needs Review" || status === "Parsed" || status === "Draft")
    return "bg-warning-soft text-warning";
  if (status === "Rejected") return "bg-danger-soft text-danger";
  return "bg-surface-muted text-muted";
}

function quoteTone(status: string | null): string {
  if (status === "Accepted") return "bg-ok-soft text-ok";
  if (status === "Approved") return "bg-info-soft text-info";
  if (status === "Needs Review" || status === "Draft") return "bg-warning-soft text-warning";
  if (status === "Expired" || status === "Rejected") return "bg-danger-soft text-danger";
  return "bg-surface-muted text-muted";
}

function proposalTone(status: string | null): string {
  if (status === "Signed") return "bg-ok-soft text-ok";
  if (status === "Approved" || status === "Ready") return "bg-info-soft text-info";
  if (status === "Draft") return "bg-warning-soft text-warning";
  if (status === "Rejected") return "bg-danger-soft text-danger";
  return "bg-surface-muted text-muted";
}

function formatMoney(value: number | null, locale: string, currency: string): string | null {
  if (value === null) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString(locale)}`;
  }
}

function formatArea(value: number | null, locale: string): string {
  return value === null ? "Not recorded" : `${formatNumber(value, locale)} sq ft`;
}

function formatNumber(value: number | null, locale = "en-CA"): string {
  if (value === null) return "";
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  } catch {
    return String(value);
  }
}

function formatPercent(value: number | null, locale: string): string {
  if (value === null) return "Not recorded";
  try {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
      value,
    );
  } catch {
    return `${(value * 100).toFixed(1)}%`;
  }
}

function formatDate(
  value: string | null,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function taxLabel(
  quote: NonNullable<EstimatorWorkbenchResponse["quote"]>,
  locale: string,
  currency: string,
): string {
  return (
    [
      formatMoney(quote.tax_amount, locale, currency),
      quote.tax_code,
      quote.tax_rate === null ? null : formatPercent(quote.tax_rate / 100, locale),
    ]
      .filter(Boolean)
      .join(" · ") || "Not recorded"
  );
}

function humanize(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
