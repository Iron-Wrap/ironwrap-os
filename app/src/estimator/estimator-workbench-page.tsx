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
import { CustomerPortalOfficeAccess } from "../portal/customer-portal-office-access";
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
    <section className="mx-auto max-w-[90rem] space-y-8 overflow-x-hidden pb-8">
      <WorkbenchHeader model={model} locale={locale} />

      {refreshFailed ? <RefreshWarning onRetry={onRetry} /> : null}
      {bounded ? <DataBoundary model={model} /> : null}

      <div className="grid min-w-0 items-start gap-8 2xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.72fr)]">
        <section className="min-w-0 space-y-8" aria-label="Estimator evidence review">
          <CommercialDecisionRail model={model} locale={locale} />
          <CommercialSnapshot model={model} locale={locale} tenantCurrency={tenantCurrency} />

          <EvidencePath
            measurement={selectedMeasurement}
            takeoff={model.takeoffs.selected}
            quote={quote}
            proposal={proposal}
            lineage={model.lineage}
          />

          <MeasurementSource model={model} locale={locale} />
          <TakeoffReview model={model} locale={locale} />
          <InsuranceEvidenceRail supplements={model.insurance_supplements} />
        </section>
        <CommercialRecord model={model} locale={locale} tenantCurrency={tenantCurrency} />
      </div>
    </section>
  );
}

function WorkbenchHeader({ model, locale }: { model: EstimatorWorkbenchResponse; locale: string }) {
  const decision = nextSafeStep(model);
  const jobIdentity = model.job.job_number ?? model.job.id;
  return (
    <header className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(20rem,0.8fr)]">
        <div className="min-w-0 p-5 sm:p-7 lg:p-8">
          <Button asChild variant="ghost" size="compact" className="-ml-2">
            <Link to="/sales">
              <ArrowLeft aria-hidden="true" />
              Back to sales
            </Link>
          </Button>
          <div className="mt-6 flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
              <Ruler className="size-6 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-muted">{jobIdentity}</p>
              <h1 className="mt-1 text-3xl font-black tracking-[-0.045em] text-balance sm:text-4xl">
                Measurement workbench
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                Review the captured measurement, material takeoff, and commercial evidence without
                changing price, scope, proposal, or customer communication.
              </p>
            </div>
          </div>
          <dl className="mt-7 grid border-t border-border sm:grid-cols-3">
            <HeaderFact label="Service" value={model.job.service_type ?? "Not recorded"} />
            <HeaderFact label="Workflow" value={model.job.workflow_profile ?? "Not recorded"} />
            <HeaderFact
              label="Read generated"
              value={formatDate(model.read_model_generated_at, locale) ?? "Unavailable"}
            />
          </dl>
        </div>
        <section
          className={cn(
            "border-t border-border p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8",
            decision.surface,
          )}
          aria-labelledby="next-safe-step-heading"
        >
          <h2
            id="next-safe-step-heading"
            className="text-xs font-bold uppercase tracking-[0.12em] text-muted"
          >
            Next safe step
          </h2>
          <p className={cn("mt-3 text-2xl font-black tracking-[-0.035em]", decision.titleTone)}>
            {decision.title}
          </p>
          <p className="mt-3 text-sm leading-6 text-muted">{decision.detail}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <StatusChip label={decision.label} tone={decision.tone} />
            <StatusChip label="Read-only evidence review" tone="bg-surface-muted text-muted" />
          </div>
          <p className="mt-6 border-t border-border/70 pt-4 text-xs leading-5 text-muted">
            This page directs human review only. It does not execute the next commercial action.
          </p>
        </section>
      </div>
    </header>
  );
}

function HeaderFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 py-4 first:pr-4 sm:px-4 sm:first:pl-0 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-border">
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function nextSafeStep(model: EstimatorWorkbenchResponse): {
  title: string;
  detail: string;
  label: string;
  tone: string;
  surface: string;
  titleTone: string;
} {
  if (model.proposal_readiness.state === "blocked") {
    return {
      title: "Resolve blocking evidence",
      detail:
        "A blocking evidence condition must be resolved before human proposal review. The proposal review gate retains the selected reason.",
      label: "Blocked by evidence",
      tone: "bg-warning-soft text-warning",
      surface: "bg-warning-soft/35",
      titleTone: "text-warning",
    };
  }
  if (model.proposal_readiness.state === "review_required") {
    return {
      title: "Complete human review",
      detail:
        "The selected evidence needs a reviewer decision before it can support a proposal. The decision rail retains the current review signals.",
      label: "Review required",
      tone: "bg-warning-soft text-warning",
      surface: "bg-warning-soft/28",
      titleTone: "text-foreground",
    };
  }
  if (model.proposal_readiness.state === "ready") {
    return {
      title: "Review the evidence pack",
      detail:
        "The bounded read found no automatic stop condition. A human still decides whether the record is ready for the next commercial step.",
      label: "Ready for review",
      tone: "bg-ok-soft text-ok",
      surface: "bg-ok-soft/28",
      titleTone: "text-foreground",
    };
  }
  return {
    title: "Keep this review bounded",
    detail:
      "One or more source details are unavailable, so use the returned evidence without treating missing values as proof of absence.",
    label: "Source incomplete",
    tone: "bg-surface-muted text-muted",
    surface: "bg-surface-muted/55",
    titleTone: "text-foreground",
  };
}

function CommercialSnapshot({
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
  if (!quote) {
    return (
      <section
        className="rounded-xl border border-border bg-surface"
        aria-labelledby="commercial-snapshot-heading"
      >
        <div className="px-5 py-5 sm:px-6">
          <h2 id="commercial-snapshot-heading" className="text-lg font-black tracking-[-0.025em]">
            Selected commercial record
          </h2>
          <EmptyInline message="No customer quote was returned. Do not infer a price, payment state, or customer-ready proposal." />
        </div>
      </section>
    );
  }
  const currency = quote.currency ?? tenantCurrency;
  return (
    <section
      className="rounded-xl border border-border bg-surface"
      aria-labelledby="commercial-snapshot-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
        <div>
          <h2 id="commercial-snapshot-heading" className="text-lg font-black tracking-[-0.025em]">
            Selected commercial record
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            The quote facts that frame the next human decision.
          </p>
        </div>
        <StatusChip
          label={humanize(quote.status) ?? "Quote state unavailable"}
          tone={quoteTone(quote.status)}
        />
      </div>
      <dl className="mt-5 grid overflow-hidden border-y border-border sm:grid-cols-4">
        <CommercialFact
          label="Quote total"
          value={formatMoney(quote.quote_total, locale, currency) ?? "Not recorded"}
          prominent
        />
        <CommercialFact
          label="Version"
          value={quote.version === null ? "Not recorded" : `Version ${quote.version}`}
        />
        <CommercialFact label="Payment" value={quote.payment_status ?? "Not recorded"} />
        <CommercialFact
          label="Proposal"
          value={
            proposal ? (humanize(proposal.status) ?? "State unavailable") : "No proposal returned"
          }
        />
      </dl>
      <p className="px-5 py-4 text-xs leading-5 text-muted sm:px-6">
        This is captured quote evidence for the selected version, not a live supplier-price or
        payment check.
      </p>
    </section>
  );
}

function CommercialFact({
  label,
  value,
  prominent = false,
}: {
  label: string;
  value: string;
  prominent?: boolean;
}) {
  return (
    <div className="min-w-0 px-5 py-4 first:bg-surface-raised sm:px-6 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:border-border">
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 break-words font-semibold text-foreground",
          prominent && "text-xl font-black tracking-[-0.03em] tabular-nums",
        )}
      >
        {value}
      </dd>
    </div>
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
    <section
      className="overflow-hidden rounded-xl border border-border bg-surface"
      aria-labelledby="evidence-path-heading"
    >
      <div className="border-b border-border px-5 py-4 sm:px-6">
        <h2
          id="evidence-path-heading"
          className="text-lg font-black tracking-[-0.025em] text-foreground"
        >
          Evidence path
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Each record stays attached to its actual upstream evidence relationship.
        </p>
      </div>
      <ol className="grid sm:grid-cols-3" aria-label="Evidence path stages">
        {steps.map((step, index) => (
          <li
            key={step.label}
            className={cn(
              "min-h-28 px-5 py-5 sm:px-6",
              index > 0 && "border-t border-border sm:border-t-0 sm:border-l",
            )}
          >
            <p className="text-sm font-bold text-muted">{step.label}</p>
            <span
              className={cn(
                "mt-3 inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold",
                step.tone,
              )}
            >
              {step.detail}
            </span>
          </li>
        ))}
      </ol>
    </section>
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

function CommercialDecisionRail({
  model,
  locale,
}: {
  model: EstimatorWorkbenchResponse;
  locale: string;
}) {
  const selectedMeasurement = model.measurements.selected;
  const sourceMath = selectedMeasurement
    ? selectedMeasurement.geometry.state === "recomputed"
      ? { detail: "Source math checked", tone: "bg-ok-soft text-ok" }
      : selectedMeasurement.geometry.state === "needs_review"
        ? { detail: "Source math needs review", tone: "bg-warning-soft text-warning" }
        : { detail: "Source math unavailable", tone: "bg-surface-muted text-muted" }
    : { detail: "No measurement returned", tone: "bg-surface-muted text-muted" };
  const takeoff = takeoffDecisionStep(model);
  const pricing = pricingDecisionStep(model.pricing_snapshot);
  const proposal = proposalDecisionStep(model.proposal_readiness);
  const steps = [
    { label: "Measurement", ...sourceMath },
    { label: "Takeoff", ...takeoff },
    { label: "Price snapshot", ...pricing },
    { label: "Proposal decision", ...proposal },
  ];
  return (
    <section
      className="rounded-xl border border-border bg-surface"
      aria-labelledby="decision-rail-heading"
    >
      <div className="px-5 py-5 sm:px-6 sm:py-6">
        <SectionHeading
          id="decision-rail-heading"
          icon={ShieldAlert}
          title="Commercial decision rail"
          description="A review gate for the selected quote version. It never refreshes a price, changes scope, or prepares customer communication."
        />
        <ol
          className="mt-5 grid overflow-hidden rounded-lg border border-border sm:grid-cols-4"
          aria-label="Commercial decision gates"
        >
          {steps.map((step, index) => (
            <li
              key={step.label}
              className={cn(
                "min-h-28 bg-surface-raised px-4 py-4",
                index > 0 && "border-t border-border sm:border-t-0 sm:border-l",
              )}
            >
              <p className="text-xs font-bold uppercase tracking-[0.09em] text-muted">
                {step.label}
              </p>
              <span
                className={cn(
                  "mt-3 inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-bold",
                  step.tone,
                )}
              >
                {step.detail}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs leading-5 text-muted">
          Snapshot checked{" "}
          {formatDate(model.read_model_generated_at, locale) ?? "at an unavailable time"}. A
          recorded price book is evidence for this quote version, not a promise that supplier
          pricing is live.
        </p>
      </div>
    </section>
  );
}

function InsuranceEvidenceRail({
  supplements,
}: {
  supplements: EstimatorWorkbenchResponse["insurance_supplements"];
}) {
  if (supplements.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-border bg-surface py-5 sm:py-6"
      aria-labelledby="insurance-evidence-heading"
    >
      <div className="px-4 sm:px-6">
        <SectionHeading
          id="insurance-evidence-heading"
          icon={ShieldAlert}
          title="Insurance supplement evidence"
          description="A restricted evidence lane for hail and insurance work. It records proof state, never a carrier decision."
        />
        <ol className="mt-5 divide-y divide-border border-y border-border">
          {supplements.map((supplement) => {
            const missing = supplement.missing_requirements;
            const readiness =
              missing.length === 0
                ? { label: "Evidence coverage recorded", tone: "bg-ok-soft text-ok" }
                : {
                    label:
                      missing.length +
                      " proof item" +
                      (missing.length === 1 ? "" : "s") +
                      " to check",
                    tone: "bg-warning-soft text-warning",
                  };
            return (
              <li key={supplement.presentation_key} className="py-5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-foreground">
                      Insurance supplement
                      {supplement.version === null ? "" : " · Version " + supplement.version}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      Proof coverage only. Carrier scope is recorded, not interpreted.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <StatusChip
                      label={humanize(supplement.status) ?? "State unavailable"}
                      tone={insuranceTone(supplement.status)}
                    />
                    <StatusChip label={readiness.label} tone={readiness.tone} />
                  </div>
                </div>

                <dl className="mt-4 grid border-y border-border sm:grid-cols-2">
                  <InsuranceEvidenceCell
                    label="Measurement"
                    value={insuranceMeasurementCopy(supplement.measurement_state)}
                  />
                  <InsuranceEvidenceCell
                    label="Evidence coverage"
                    value={
                      supplement.evidence_roles.length > 0
                        ? supplement.evidence_roles.join(" · ")
                        : "No verified evidence role returned"
                    }
                  />
                  <InsuranceEvidenceCell
                    label="Invoice"
                    value={insuranceInvoiceCopy(supplement.invoice_state)}
                  />
                  <InsuranceEvidenceCell
                    label="Recorded handoff"
                    value={insuranceHandoffCopy(supplement)}
                  />
                </dl>

                {missing.length > 0 ? (
                  <ul className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    {missing.map((requirement) => (
                      <li key={requirement} className="flex gap-2 leading-6 text-foreground">
                        <CircleAlert
                          className="mt-1 size-4 shrink-0 text-warning"
                          aria-hidden="true"
                        />
                        <span>{insuranceRequirementCopy(requirement)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-4 flex items-start gap-2 text-sm leading-6 text-ok">
                    <Check className="mt-1 size-4 shrink-0" aria-hidden="true" />
                    <span>
                      Recorded evidence coverage is complete for the current internal state. Human
                      review still controls every transition.
                    </span>
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

function InsuranceEvidenceCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-3 py-3 first:pt-3 sm:px-4 sm:[&:nth-child(even)]:border-l sm:[&:nth-child(n+3)]:border-t">
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-semibold leading-6 text-foreground">{value}</dd>
    </div>
  );
}

function insuranceTone(status: string | null): string {
  if (status === "Closed") return "bg-ok-soft text-ok";
  if (
    status === "Approved for Submission" ||
    status === "Submitted" ||
    status === "Carrier Response Recorded"
  ) {
    return "bg-info-soft text-info";
  }
  if (status === "Draft" || status === "Needs Evidence" || status === "Ready for Human Review") {
    return "bg-warning-soft text-warning";
  }
  return "bg-surface-muted text-muted";
}

function insuranceMeasurementCopy(
  state: EstimatorWorkbenchResponse["insurance_supplements"][number]["measurement_state"],
): string {
  if (state === "approved") return "Approved measurement linked";
  if (state === "review_required") return "Measurement linked, approval required";
  if (state === "missing") return "No measurement linked";
  return "Measurement source unavailable";
}

function insuranceInvoiceCopy(
  state: EstimatorWorkbenchResponse["insurance_supplements"][number]["invoice_state"],
): string {
  if (state === "recorded") return "Invoice evidence recorded";
  if (state === "not_required") return "Invoice not required in this record";
  if (state === "required") return "Invoice evidence or exception needed";
  return "Invoice state unavailable";
}

function insuranceHandoffCopy(
  supplement: EstimatorWorkbenchResponse["insurance_supplements"][number],
): string {
  if (supplement.closed_recorded) return "Closed internally";
  if (supplement.carrier_response_recorded) return "Carrier response artifact recorded";
  if (supplement.submission_recorded) return "Human submission artifact recorded";
  if (supplement.approval_recorded) return "Approved for submission";
  return "No handoff artifact recorded";
}

function insuranceRequirementCopy(
  requirement: EstimatorWorkbenchResponse["insurance_supplements"][number]["missing_requirements"][number],
): string {
  const copy = {
    approved_measurement: "Link an approved measurement report.",
    carrier_scope: "Add verified carrier-scope evidence.",
    code_or_manufacturer: "Add verified code or manufacturer evidence.",
    photo: "Add verified photo evidence.",
    invoice_or_exception: "Add invoice evidence or record a reviewer exception.",
    submission_artifact: "Record a verified human submission artifact before using Submitted.",
    carrier_response_artifact:
      "Record a verified carrier-response artifact before using this state.",
    source_detail_unavailable: "The restricted evidence detail could not be read safely.",
  } satisfies Record<
    EstimatorWorkbenchResponse["insurance_supplements"][number]["missing_requirements"][number],
    string
  >;
  return copy[requirement];
}

function takeoffDecisionStep(model: EstimatorWorkbenchResponse) {
  if (model.lineage.measurement_to_takeoff !== "linked" || !model.takeoffs.selected) {
    return model.lineage.measurement_to_takeoff === "unknown"
      ? { detail: "Linkage incomplete", tone: "bg-warning-soft text-warning" }
      : { detail: "No linked takeoff", tone: "bg-warning-soft text-warning" };
  }
  return model.takeoffs.selected.status === "Approved"
    ? { detail: "Linked & approved", tone: "bg-ok-soft text-ok" }
    : { detail: "Linked; review required", tone: "bg-warning-soft text-warning" };
}

function pricingDecisionStep(snapshot: EstimatorWorkbenchResponse["pricing_snapshot"]) {
  const version =
    snapshot.quote_version === null ? "Quote version unavailable" : `V${snapshot.quote_version}`;
  if (snapshot.state === "recorded") {
    return { detail: `${version} snapshot recorded`, tone: "bg-ok-soft text-ok" };
  }
  if (snapshot.state === "expired")
    return { detail: `${version} expired`, tone: "bg-warning-soft text-warning" };
  if (snapshot.state === "incomplete") {
    return { detail: "Snapshot incomplete", tone: "bg-warning-soft text-warning" };
  }
  if (snapshot.state === "review_required") {
    return { detail: `${version} needs review`, tone: "bg-warning-soft text-warning" };
  }
  return { detail: "No quote snapshot", tone: "bg-surface-muted text-muted" };
}

function proposalDecisionStep(readiness: EstimatorWorkbenchResponse["proposal_readiness"]) {
  if (readiness.state === "ready")
    return { detail: "Ready for proposal review", tone: "bg-ok-soft text-ok" };
  if (readiness.state === "review_required") {
    return { detail: "Review required", tone: "bg-warning-soft text-warning" };
  }
  if (readiness.state === "blocked")
    return { detail: "Blocked by evidence", tone: "bg-warning-soft text-warning" };
  return { detail: "Source window incomplete", tone: "bg-surface-muted text-muted" };
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
      <section
        className="rounded-xl border border-border bg-surface px-5 py-6 sm:px-6"
        aria-labelledby="measurement-source-heading"
      >
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
    <section
      className="rounded-xl border border-border bg-surface"
      aria-labelledby="measurement-source-heading"
    >
      <div className="px-5 py-6 sm:px-6 sm:py-7">
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

        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="space-y-5">
            <GeometryStatus geometry={geometry} />
            <dl className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-3">
              <MeasurementFact label="Reports" value={String(model.measurements.reports.length)} />
              <MeasurementFact label="Facets" value={String(geometry.facet_count)} bordered />
              <MeasurementFact
                label="Failed checks"
                value={String(geometry.failed_check_count)}
                bordered
                danger={geometry.failed_check_count > 0}
              />
            </dl>
            <p className="border-l-2 border-warning bg-warning-soft/40 px-4 py-3 text-sm leading-6 text-foreground">
              Geometry recomputation checks the captured file, not the site. It does not verify
              concealed conditions, substrate condition, access, or field dimensions.
            </p>
          </div>
          <SourceFacetPreview geometry={geometry} locale={locale} />
        </div>

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
    <div className={cn("flex gap-3 rounded-lg border p-4", copy.surface)}>
      <Icon className={cn("mt-0.5 size-5 shrink-0", copy.iconTone)} aria-hidden="true" />
      <div>
        <p className="font-bold text-foreground">{copy.title}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{copy.detail}</p>
      </div>
    </div>
  );
}

function SourceFacetPreview({ geometry, locale }: { geometry: EstimatorGeometry; locale: string }) {
  const facets = geometry.facets.slice(0, 4);
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-surface-raised"
      aria-labelledby="source-facet-preview-heading"
    >
      <div className="border-b border-border px-4 py-4">
        <h3 id="source-facet-preview-heading" className="text-sm font-black text-foreground">
          Returned facet context
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted">
          A compact index of returned source facets, not a roof plan or field measurement.
        </p>
      </div>
      {facets.length === 0 ? (
        <p className="px-4 py-5 text-sm leading-6 text-muted">
          No individual source facets were returned.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-px bg-border" aria-label="Returned source facets">
          {facets.map((facet) => {
            const flagged =
              !facet.ring_closed || (facet.deviation !== null && facet.deviation > 0.03);
            return (
              <li key={facet.id} className="min-w-0 bg-surface p-3">
                <p className="font-mono text-xs font-bold text-muted">{facet.id}</p>
                <p className="mt-2 truncate text-sm font-bold text-foreground">
                  {facet.material ?? facet.type ?? "Surface not recorded"}
                </p>
                <p className="mt-1 text-xs tabular-nums text-muted">
                  {formatArea(facet.computed_area ?? facet.declared_area, locale)}
                </p>
                <p
                  className={cn("mt-2 text-xs font-semibold", flagged ? "text-warning" : "text-ok")}
                >
                  {facet.ring_closed ? "Ring closed" : "Ring open"}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {geometry.facet_count > facets.length ? (
        <p className="border-t border-border px-4 py-3 text-xs leading-5 text-muted">
          Facet comparison below retains the returned facet evidence.
        </p>
      ) : null}
    </section>
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
      <h3 id="facet-comparison-heading" className="text-lg font-black tracking-[-0.02em]">
        Facet comparison
      </h3>
      <details open={geometry.failed_check_count > 0 || geometry.facets_truncated} className="mt-3">
        <summary className="flex cursor-pointer list-none flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4 [&::-webkit-details-marker]:hidden">
          <span className="text-sm leading-6 text-muted">
            Declared and recomputed roof areas remain side by side.
          </span>
          <span className="text-sm font-semibold text-muted">
            {geometry.facets_truncated ? "First returned facets shown" : "Facet audit detail"}
          </span>
        </summary>
        <p className="mt-3 text-xs font-semibold text-muted sm:hidden">
          Swipe the table to compare every source value.
        </p>
        <div
          className="mt-2 overflow-x-auto rounded-lg border border-border"
          aria-label="Facet comparison table"
        >
          <table className="min-w-[45rem] w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              Captured source facets with declared and recomputed roof area, deviation, pitch, and
              perimeter-ring evidence.
            </caption>
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
                    <th
                      scope="row"
                      className="px-4 py-3 text-left font-mono text-xs font-semibold text-foreground"
                    >
                      {facet.id}
                    </th>
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
      </details>
    </section>
  );
}

function GeometryChecks({ geometry }: { geometry: EstimatorGeometry }) {
  if (geometry.state === "unavailable") return null;
  return (
    <section className="mt-7" aria-labelledby="geometry-checks-heading">
      <h3 id="geometry-checks-heading" className="text-lg font-black tracking-[-0.02em]">
        Source checks
      </h3>
      <details open={geometry.failed_check_count > 0 || geometry.checks_truncated} className="mt-3">
        <summary className="flex cursor-pointer list-none flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4 [&::-webkit-details-marker]:hidden">
          <span className="text-sm leading-6 text-muted">
            File references, perimeter closure, and declared geometry are checked deterministically.
          </span>
          <span
            className={cn(
              "text-sm font-bold",
              geometry.failed_check_count > 0 ? "text-warning" : "text-ok",
            )}
          >
            {geometry.failed_check_count > 0
              ? `${geometry.failed_check_count} need review`
              : "No failed checks returned"}
          </span>
        </summary>
        {geometry.checks.length === 0 ? (
          <div className="mt-3 rounded-lg border border-border px-4 py-3 text-sm leading-6 text-muted">
            No source exceptions were returned. This is not field-verification evidence.
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {geometry.checks.map((check) => (
              <li
                key={`${check.check}:${check.target}`}
                className="flex gap-3 bg-surface-raised px-4 py-3 text-sm leading-6"
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
      </details>
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
      <details
        open={
          sourceMetrics.some((metric) => metric.needs_review) ||
          measurement.metrics_truncated ||
          measurement.geometry.metrics_truncated
        }
        className="mt-3"
      >
        <summary className="flex cursor-pointer list-none flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4 [&::-webkit-details-marker]:hidden">
          <span className="text-sm leading-6 text-muted">
            Values stay attached to their extraction or source-file reference.
          </span>
          <span className="text-sm font-semibold text-muted">Source audit detail</span>
        </summary>
        {sourceMetrics.length > 0 ? (
          <MetricList
            title="Recorded metrics"
            metrics={sourceMetrics.map((metric) => ({
              id: metric.metric,
              label: metric.metric,
              value:
                [formatNumber(metric.value), metric.unit].filter(Boolean).join(" ") ||
                "Not recorded",
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
      </details>
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
      <h4 className="px-4 py-3 text-sm font-bold text-muted">{title}</h4>
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
  const flaggedItems = selected?.items.filter((item) => item.needs_review).length ?? 0;
  return (
    <section
      className="min-w-0 rounded-xl border border-border bg-surface"
      aria-labelledby="takeoff-heading"
    >
      <div className="px-5 py-6 sm:px-6 sm:py-7">
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
            <dl className="mt-6 grid overflow-hidden rounded-lg border border-border sm:grid-cols-3">
              <MeasurementFact label="Returned items" value={String(selected.items.length)} />
              <MeasurementFact
                label="Needs review"
                value={String(flaggedItems)}
                bordered
                danger={flaggedItems > 0}
              />
              <MeasurementFact
                label="Measurement link"
                value={lineage === "linked" ? "Linked" : "Needs review"}
                bordered
                danger={lineage !== "linked"}
              />
            </dl>
            <h3 className="mt-6 text-lg font-black tracking-[-0.02em]">Material evidence</h3>
            <details open={flaggedItems > 0 || selected.items_truncated} className="mt-3">
              <summary className="flex cursor-pointer list-none flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4 [&::-webkit-details-marker]:hidden">
                <span className="text-sm leading-6 text-muted">
                  Quantities remain attached to each selected source reference.
                </span>
                <span className="text-sm font-semibold text-muted">Takeoff audit detail</span>
              </summary>
              <p className="mt-3 text-xs font-semibold text-muted sm:hidden">
                Swipe the table to review each source reference.
              </p>
              <div
                className="mt-2 overflow-x-auto rounded-lg border border-border"
                aria-label="Material takeoff table"
              >
                <table className="min-w-[48rem] w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Material takeoff items with quantities, waste factors, source references, and
                    review state.
                  </caption>
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
                          <th scope="row" className="px-4 py-3 text-left">
                            <p className="font-semibold text-foreground">
                              {item.item_name ?? "Unnamed item"}
                            </p>
                            {item.category ? (
                              <p className="mt-0.5 text-xs font-normal text-muted">
                                {item.category}
                              </p>
                            ) : null}
                          </th>
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
            </details>
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
    <aside className="min-w-0 space-y-5 2xl:sticky 2xl:top-8" aria-label="Commercial record">
      <section
        className="rounded-xl border border-border bg-surface py-6"
        aria-labelledby="quote-heading"
      >
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
            <>
              <QuoteLedger quote={quote} locale={locale} tenantCurrency={tenantCurrency} />
              <PricingSnapshot snapshot={model.pricing_snapshot} locale={locale} />
              <QuoteRevisionLedger
                quote={quote}
                revision={model.quote_revision}
                locale={locale}
                tenantCurrency={tenantCurrency}
              />
              <QuoteRevisionEntry model={model} quote={quote} />
            </>
          )}
        </div>
      </section>

      <section
        className="rounded-xl border border-border bg-surface py-6"
        aria-labelledby="proposal-heading"
      >
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
          <ProposalReadiness readiness={model.proposal_readiness} />
        </div>
      </section>

      <CustomerPortalOfficeAccess roofJobId={model.job.id} locale={locale} />

      <section
        className="rounded-xl border border-border bg-surface py-6"
        aria-labelledby="scope-heading"
      >
        <div className="px-4 sm:px-5">
          <SectionHeading
            id="scope-heading"
            icon={ClipboardList}
            title="Scope clauses"
            description="Visible scope, assumptions, exclusions, and risks remain attributable."
          />
          <ScopeClauses clauses={model.scope_clauses} locale={locale} />
          <ScopeChangeLedger
            changes={model.scope_changes}
            locale={locale}
            tenantCurrency={tenantCurrency}
          />
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

function QuoteRevisionEntry({
  model,
  quote,
}: {
  model: EstimatorWorkbenchResponse;
  quote: NonNullable<EstimatorWorkbenchResponse["quote"]>;
}) {
  if (!model.allowed_actions.includes("quote_revision_approval.prepare")) return null;
  return (
    <section
      className="mt-6 border-y border-border py-4"
      aria-labelledby="revision-request-heading"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <h3 id="revision-request-heading" className="text-sm font-bold text-foreground">
            Correct this version without carrying terms forward
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted">
            The next step creates a human-reviewed request for a blank Draft shell. It does not copy
            price, tax, scope, payment, approval, acceptance, or customer terms.
          </p>
        </div>
        <Button asChild variant="outline" size="default" className="shrink-0">
          <Link to="/estimator/jobs/$jobId/revision" params={{ jobId: model.job.id }}>
            <FileText aria-hidden="true" />
            Request draft revision
          </Link>
        </Button>
      </div>
      <p className="mt-3 break-all text-xs font-semibold text-muted">
        Source: {quote.id}
        {quote.version === null ? " · Version not recorded" : ` · Version ${quote.version}`}
      </p>
    </section>
  );
}

function PricingSnapshot({
  snapshot,
  locale,
}: {
  snapshot: EstimatorWorkbenchResponse["pricing_snapshot"];
  locale: string;
}) {
  const tone =
    snapshot.state === "recorded"
      ? "bg-ok-soft text-ok"
      : snapshot.state === "unavailable"
        ? "bg-surface-muted text-muted"
        : "bg-warning-soft text-warning";
  const label =
    snapshot.state === "recorded"
      ? "Captured snapshot"
      : snapshot.state === "expired"
        ? "Quote expired"
        : snapshot.state === "incomplete"
          ? "Snapshot incomplete"
          : snapshot.state === "review_required"
            ? "Estimator review required"
            : "No snapshot";
  return (
    <section
      className="mt-6 border-y border-border py-4"
      aria-labelledby="pricing-snapshot-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="pricing-snapshot-heading" className="text-sm font-bold text-foreground">
            Price snapshot
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Captured with this quote version. It is not a live supplier-price check.
          </p>
        </div>
        <StatusChip label={label} tone={tone} />
      </div>
      <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
        <RecordLine
          label="Quote version"
          value={
            snapshot.quote_version === null ? "Not recorded" : `Version ${snapshot.quote_version}`
          }
        />
        <RecordLine label="Price book" value={snapshot.price_book_version ?? "Not recorded"} />
        <RecordLine
          label="Captured effective"
          value={formatDate(snapshot.pricing_effective_at, locale) ?? "Not recorded"}
        />
        <RecordLine
          label="Quote valid until"
          value={
            formatDate(snapshot.valid_until, locale, { dateStyle: "medium" }) ?? "Not recorded"
          }
        />
      </dl>
    </section>
  );
}

function QuoteRevisionLedger({
  quote,
  revision,
  locale,
  tenantCurrency,
}: {
  quote: NonNullable<EstimatorWorkbenchResponse["quote"]>;
  revision: EstimatorWorkbenchResponse["quote_revision"];
  locale: string;
  tenantCurrency: string;
}) {
  const prior = revision.prior_quote;
  const delta = revision.delta;
  const currency = quote.currency ?? tenantCurrency;
  if (revision.state !== "compared" || !prior || !delta) {
    return (
      <section className="mt-6 border-y border-border py-4" aria-labelledby="revision-heading">
        <h3 id="revision-heading" className="text-sm font-bold text-foreground">
          Version comparison
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted">
          {quoteRevisionEmptyMessage(revision.state)}
        </p>
      </section>
    );
  }
  const changedFacts = [
    delta.price_book_version_changed ? "Price-book version changed" : null,
    delta.pricing_effective_at_changed ? "Pricing-effective date changed" : null,
    delta.tax_code_changed || delta.tax_rate_changed ? "Tax treatment changed" : null,
    delta.currency_changed ? "Currency changed" : null,
    delta.scope_summary_changed ? "Scope summary changed" : null,
    delta.assumptions_changed ? "Assumptions changed" : null,
    delta.exclusions_changed ? "Exclusions changed" : null,
  ].filter((value): value is string => Boolean(value));
  return (
    <section className="mt-6 border-y border-border py-4" aria-labelledby="revision-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="revision-heading" className="text-sm font-bold text-foreground">
            Version comparison
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Explicitly linked {prior.version === null ? "prior version" : `V${prior.version}`} →{" "}
            {quote.version === null ? "selected version" : `V${quote.version}`}. No amount is
            regenerated here.
          </p>
        </div>
        <StatusChip label="Linked revision" tone="bg-ok-soft text-ok" />
      </div>
      <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
        <RevisionMoneyLine
          label="Quote total"
          before={prior.quote_total}
          after={quote.quote_total}
          delta={delta.quote_total}
          locale={locale}
          currency={currency}
        />
        <RevisionMoneyLine
          label="Subtotal"
          before={prior.subtotal}
          after={quote.subtotal}
          delta={delta.subtotal}
          locale={locale}
          currency={currency}
        />
        <RevisionMoneyLine
          label="Tax"
          before={prior.tax_amount}
          after={quote.tax_amount}
          delta={delta.tax_amount}
          locale={locale}
          currency={currency}
        />
        <RevisionMoneyLine
          label="Deposit"
          before={prior.deposit_amount}
          after={quote.deposit_amount}
          delta={delta.deposit_amount}
          locale={locale}
          currency={currency}
        />
      </dl>
      {changedFacts.length > 0 ? (
        <ul className="mt-4 space-y-1.5 text-xs font-semibold leading-5 text-warning">
          {changedFacts.map((fact) => (
            <li key={fact} className="flex gap-2">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {fact}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-xs font-semibold text-muted">
          No tracked price, tax, or scope fields changed.
        </p>
      )}
      {quote.correction_reason ? (
        <section
          className="mt-4 border-l-2 border-warning pl-3"
          aria-labelledby="correction-reason-heading"
        >
          <h3 id="correction-reason-heading" className="text-sm font-bold text-foreground">
            Correction rationale
          </h3>
          <p className="mt-1 text-sm leading-6 text-foreground">{quote.correction_reason}</p>
        </section>
      ) : null}
      {delta.scope_summary_changed ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm leading-6">
          <p className="text-xs font-bold uppercase tracking-[0.09em] text-muted">Scope change</p>
          <p className="text-muted">Before: {prior.scope_summary ?? "Not recorded"}</p>
          <p className="text-foreground">Selected: {quote.scope_summary ?? "Not recorded"}</p>
        </div>
      ) : null}
    </section>
  );
}

function RevisionMoneyLine({
  label,
  before,
  after,
  delta,
  locale,
  currency,
}: {
  label: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  locale: string;
  currency: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-0 py-3">
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className="text-right font-bold tabular-nums text-foreground">
        {formatMoney(after, locale, currency) ?? "Not recorded"}
      </dd>
      <dd className="col-span-2 mt-1 text-xs text-muted">
        {[
          formatMoney(before, locale, currency) ?? "Before not recorded",
          formatSignedMoney(delta, locale, currency),
        ]
          .filter(Boolean)
          .join(" · ")}
      </dd>
    </div>
  );
}

function ScopeChangeLedger({
  changes,
  locale,
  tenantCurrency,
}: {
  changes: EstimatorWorkbenchResponse["scope_changes"];
  locale: string;
  tenantCurrency: string;
}) {
  return (
    <section className="mt-7 border-t border-border pt-5" aria-labelledby="scope-change-heading">
      <SectionHeading
        id="scope-change-heading"
        icon={CircleAlert}
        title="Scope change ledger"
        description="Each change-order record declares its quote relationship and customer-decision state."
        level="h3"
      />
      {changes.length === 0 ? (
        <EmptyInline message="No change-order records were returned for this roof job." />
      ) : (
        <ol className="mt-5 divide-y divide-border border-y border-border">
          {changes.map((change) => {
            const currency = change.currency ?? tenantCurrency;
            return (
              <li key={change.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-foreground">{change.title ?? "Untitled change"}</p>
                    <p className="mt-1 text-xs font-semibold text-muted">
                      {[change.number, change.version === null ? null : `v${change.version}`]
                        .filter(Boolean)
                        .join(" · ") || "Change identity unavailable"}
                    </p>
                  </div>
                  <StatusChip
                    label={humanize(change.status) ?? "State unavailable"}
                    tone={changeOrderTone(change.status)}
                  />
                </div>
                <p className="mt-3 text-sm leading-6 text-foreground">
                  {change.scope_delta ?? change.reason ?? "No scope delta was recorded."}
                </p>
                {change.reason ? (
                  <p className="mt-2 text-sm leading-6 text-muted">{change.reason}</p>
                ) : null}
                <dl className="mt-3 divide-y divide-border border-y border-border text-sm">
                  <RecordLine
                    label="Quote relation"
                    value={scopeChangeLinkCopy(change.quote_link)}
                  />
                  <RecordLine
                    label="Commercial delta"
                    value={formatMoney(change.total_amount, locale, currency) ?? "Not recorded"}
                  />
                  <RecordLine
                    label="Customer accepted"
                    value={formatDate(change.accepted_at, locale) ?? "Not recorded"}
                  />
                </dl>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function ProposalReadiness({
  readiness,
}: {
  readiness: EstimatorWorkbenchResponse["proposal_readiness"];
}) {
  const tone =
    readiness.state === "ready"
      ? "bg-ok-soft text-ok"
      : readiness.state === "unavailable"
        ? "bg-surface-muted text-muted"
        : "bg-warning-soft text-warning";
  const label =
    readiness.state === "ready"
      ? "Ready for review"
      : readiness.state === "review_required"
        ? "Review required"
        : readiness.state === "blocked"
          ? "Blocked"
          : "Source incomplete";
  return (
    <section
      className="mt-6 border-t border-border pt-5"
      aria-labelledby="proposal-readiness-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="proposal-readiness-heading" className="text-sm font-bold text-foreground">
            Proposal review gate
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            This gate does not create, approve, send, sign, or collect against a proposal.
          </p>
        </div>
        <StatusChip label={label} tone={tone} />
      </div>
      {readiness.reasons.length > 0 ? (
        <ul className="mt-4 divide-y divide-border border-y border-border text-sm">
          {readiness.reasons.map((reason) => (
            <li key={reason} className="py-3 leading-6 text-foreground">
              {proposalReadinessCopy(reason)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm leading-6 text-ok">
          The bounded read model found no automatic stop condition. Human review remains required.
        </p>
      )}
    </section>
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
  level = "h2",
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  level?: "h2" | "h3";
}) {
  const Heading = level;
  return (
    <div className="min-w-0">
      <Heading
        id={id}
        className="flex items-center gap-2 text-xl font-black tracking-[-0.025em] text-balance sm:text-2xl"
      >
        <Icon className="size-5 text-accent" aria-hidden="true" />
        {title}
      </Heading>
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
    <div className="flex gap-3 rounded-lg border border-warning/40 bg-warning-soft/55 p-4 text-sm leading-6">
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

function changeOrderTone(status: string | null): string {
  if (status === "Accepted") return "bg-ok-soft text-ok";
  if (status === "Approved" || status === "Presented") return "bg-info-soft text-info";
  if (status === "Draft" || status === "Needs Review") return "bg-warning-soft text-warning";
  if (status === "Rejected" || status === "Superseded") return "bg-surface-muted text-muted";
  return "bg-surface-muted text-muted";
}

function quoteRevisionEmptyMessage(
  state: EstimatorWorkbenchResponse["quote_revision"]["state"],
): string {
  if (state === "not_revised")
    return "This selected quote does not declare an earlier version to compare.";
  if (state === "unlinked_revision") {
    return "This quote has a later version number but no explicit superseded quote link. Do not infer a prior baseline.";
  }
  if (state === "prior_quote_missing") {
    return "The declared prior quote was not returned. Do not calculate or explain a revision delta.";
  }
  if (state === "history_incomplete") {
    return "The quote history reached the safe source boundary, so the declared prior version cannot be verified.";
  }
  if (state === "invalid_lineage") {
    return "The declared prior quote has an invalid version relationship. Commercial review must resolve it.";
  }
  return "No selected customer quote is available for version comparison.";
}

function scopeChangeLinkCopy(
  link: EstimatorWorkbenchResponse["scope_changes"][number]["quote_link"],
): string {
  if (link === "selected_quote") return "Linked to selected quote";
  if (link === "other_quote") return "Linked to another quote version";
  if (link === "quote_unavailable") return "Quoted version was not returned";
  return "No quote link recorded";
}

function proposalReadinessCopy(
  reason: EstimatorWorkbenchResponse["proposal_readiness"]["reasons"][number],
): string {
  const copy = {
    measurement_missing: "No selected measurement report anchors this review.",
    measurement_source_review_required:
      "Source-file math still needs review; this does not assert field verification.",
    takeoff_link_missing: "No approved material takeoff is linked to the selected measurement.",
    takeoff_not_approved: "The linked material takeoff has not reached Approved state.",
    quote_missing: "No selected customer quote anchors proposal evidence.",
    quote_snapshot_incomplete: "The selected quote lacks a complete captured price-book snapshot.",
    quote_not_approved: "The selected quote is not Approved or Accepted.",
    scope_change_unresolved:
      "A change order linked to the selected quote still needs its written customer decision.",
    proposal_link_mismatch: "Existing proposal evidence does not link to the selected quote.",
    source_window_partial: "One or more bounded source windows are incomplete.",
    stale_source_detail: "One or more selected source details are stale or unavailable.",
  } satisfies Record<EstimatorWorkbenchResponse["proposal_readiness"]["reasons"][number], string>;
  return copy[reason];
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

function formatSignedMoney(value: number | null, locale: string, currency: string): string | null {
  if (value === null) return null;
  const formatted = formatMoney(Math.abs(value), locale, currency);
  if (!formatted) return null;
  return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${formatted}`;
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
