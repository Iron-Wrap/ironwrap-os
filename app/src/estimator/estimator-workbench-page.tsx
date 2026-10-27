import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleAlert,
  FileSearch,
  FileText,
  Layers3,
  Palette,
  RefreshCw,
  Ruler,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { CapabilityUnavailable } from "../capabilities/capability-unavailable";
import { capabilityPreventsUse, useCapability } from "../capabilities/capability-signal";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { ErrorState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import { useOnlineStatus } from "../hooks/use-online-status";
import { ApiError } from "../lib/api";
import { CustomerPortalOfficeAccess } from "../portal/customer-portal-office-access";
import { ProposalPublicationAction } from "../proposal/proposal-publication-action";
import {
  createFacetLaunch,
  loadEstimatorWorkbench,
  navigateToFacetLaunch,
  newFacetLaunchKey,
} from "./estimator-api";
import type { EstimatorGeometry, EstimatorWorkbenchResponse } from "./estimator-contracts";
import { RoofGraphEvidence } from "./roof-graph-evidence";
import { ManualMeasurementPanel } from "./manual-measurement-panel";

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
  const { measurementRequest } = useSearch({ strict: false }) as { measurementRequest?: string };
  const selectedMeasurement = model.measurements.selected;
  const bounded =
    model.partial_sources.length > 0 ||
    model.stale_fields.length > 0 ||
    model.source_updated_at === null;

  return (
    <section className="mx-auto max-w-[86rem] space-y-6 overflow-x-hidden pb-8 sm:space-y-8">
      <WorkbenchHeader model={model} locale={locale} />

      {refreshFailed ? <RefreshWarning onRetry={onRetry} /> : null}
      {bounded ? <DataBoundary model={model} /> : null}

      <CommercialSnapshot model={model} locale={locale} tenantCurrency={tenantCurrency} />

      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:gap-8">
        <section
          className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface"
          aria-labelledby="review-workspace-heading"
        >
          <header className="border-b border-border px-5 py-5 sm:px-6">
            <h2
              id="review-workspace-heading"
              tabIndex={-1}
              className="scroll-mt-24 text-lg font-bold tracking-[-0.02em]"
            >
              What needs review
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Open a section only when you need its evidence.
            </p>
          </header>
          <div className="divide-y divide-border">
            <ReviewGroup
              title="Roof details"
              reveal={measurementRequest}
              description="Property drawing, roof graph, checks, and saved measurements."
              status={
                selectedMeasurement
                  ? (humanize(selectedMeasurement.review_status) ?? "Check needed")
                  : "No roof data"
              }
              tone={
                selectedMeasurement
                  ? reviewTone(selectedMeasurement.review_status)
                  : "bg-surface-muted text-muted"
              }
            >
              <VisualEvidence visual={model.visual_model} locale={locale} />
              <RoofGraphEvidence
                roofGraph={selectedMeasurement?.roof_graph ?? null}
                locale={locale}
              />
              <MeasurementSource model={model} locale={locale} />
              <ManualMeasurementPanel jobId={model.job.id} />
            </ReviewGroup>

            <ReviewGroup
              title="Materials and insurance"
              description="Material list and any insurance proof for this job."
              status={
                model.takeoffs.selected
                  ? (humanize(model.takeoffs.selected.status) ?? "Check needed")
                  : "No material list"
              }
              tone={
                model.takeoffs.selected
                  ? reviewTone(model.takeoffs.selected.status)
                  : "bg-surface-muted text-muted"
              }
            >
              <TakeoffReview model={model} locale={locale} />
              <InsuranceEvidenceRail supplements={model.insurance_supplements} />
            </ReviewGroup>
          </div>
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
    <header className="grid min-w-0 gap-4 border-b border-border pb-5 sm:gap-6 sm:pb-8 md:grid-cols-[minmax(0,1fr)_18rem] md:gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-10">
      <div className="min-w-0">
        <Button asChild variant="ghost" size="compact" className="-ml-2">
          <Link to="/sales">
            <ArrowLeft aria-hidden="true" />
            Back to sales
          </Link>
        </Button>
        <div className="mt-3 min-w-0 sm:mt-6">
          <p className="text-sm font-bold break-all text-muted">{jobIdentity}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-[-0.04em] text-balance sm:text-[2.5rem] sm:leading-[1.05]">
            Roof and quote review
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted sm:text-base">
            Check the roof data, materials, and quote. Manual observations are recorded separately
            and do not alter geometry, takeoff, or approved quotes.
          </p>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:mt-7 sm:grid-cols-3 sm:gap-y-4">
          <HeaderFact label="Service" value={model.job.service_type ?? "Not recorded"} />
          <HeaderFact label="Job plan" value={model.job.workflow_profile ?? "Not recorded"} />
          <HeaderFact
            label="Last checked"
            value={formatDate(model.read_model_generated_at, locale) ?? "Unavailable"}
          />
        </dl>
      </div>
      <section
        className={cn("self-end rounded-xl border border-border/80 p-4 sm:p-6", decision.surface)}
        aria-labelledby="next-safe-step-heading"
      >
        <h2 id="next-safe-step-heading" className="text-sm font-bold text-muted">
          Next step
        </h2>
        <p
          className={cn(
            "mt-1 text-lg font-bold tracking-[-0.03em] sm:mt-2 sm:text-xl",
            decision.titleTone,
          )}
        >
          {decision.title}
        </p>
        <p className="mt-2 text-sm leading-6 text-muted sm:mt-3">{decision.detail}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 sm:mt-5">
          <StatusChip label={decision.label} tone={decision.tone} />
          <span className="sr-only text-xs font-semibold text-muted sm:not-sr-only">
            Review before acting
          </span>
        </div>
        <Button asChild variant="outline" className="mt-3 w-full sm:hidden">
          <a href="#review-workspace-heading">Open review sections</a>
        </Button>
      </section>
    </header>
  );
}

function HeaderFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
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
      title: "Fix the blocked items",
      detail: "Fix the marked items before you review the proposal. The reason is shown below.",
      label: "Work is blocked",
      tone: "bg-warning-soft text-warning",
      surface: "bg-warning-soft/35",
      titleTone: "text-warning",
    };
  }
  if (model.proposal_readiness.state === "review_required") {
    return {
      title: "Review the roof and quote",
      detail: "Check the marked items before the proposal can move on.",
      label: "Review needed",
      tone: "bg-warning-soft text-warning",
      surface: "bg-warning-soft/28",
      titleTone: "text-foreground",
    };
  }
  if (model.proposal_readiness.state === "ready") {
    return {
      title: "Review the proposal",
      detail: "No system check is stopping this job. A person must still make the final choice.",
      label: "Ready for review",
      tone: "bg-ok-soft text-ok",
      surface: "bg-ok-soft/28",
      titleTone: "text-foreground",
    };
  }
  return {
    title: "Use the saved details only",
    detail: "Some details are missing. A blank field does not mean no record exists.",
    label: "Some details are missing",
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
        className="border-y border-border py-5"
        aria-labelledby="commercial-snapshot-heading"
      >
        <div>
          <h2 id="commercial-snapshot-heading" className="text-lg font-bold tracking-[-0.025em]">
            Quote at a glance
          </h2>
          <EmptyInline message="No customer quote was found. Do not guess the price, payment, or proposal state." />
        </div>
      </section>
    );
  }
  const currency = quote.currency ?? tenantCurrency;
  return (
    <section className="border-y border-border py-5" aria-labelledby="commercial-snapshot-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="commercial-snapshot-heading" className="text-lg font-bold tracking-[-0.025em]">
            Quote at a glance
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Use these saved facts for this review.
          </p>
        </div>
        <StatusChip
          label={humanize(quote.status) ?? "Quote state unavailable"}
          tone={quoteTone(quote.status)}
        />
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4 sm:gap-x-8">
        <CommercialFact
          label="Quote total"
          value={formatMoney(quote.quote_total, locale, currency) ?? "Not recorded"}
          prominent
        />
        <CommercialFact label="Payment" value={quote.payment_status ?? "Not recorded"} />
        {/* Two quotes are told apart by when they were made, never by a version number. */}
        <CommercialFact
          label="Prepared"
          value={formatDate(quote.prepared_at, locale) ?? "Not recorded"}
        />
        <CommercialFact
          label="Proposal"
          value={
            proposal ? (humanize(proposal.status) ?? "State unavailable") : "No proposal returned"
          }
        />
      </dl>
      <p className="mt-4 text-xs leading-5 text-muted">
        These values were saved with this quote. They are not a live supplier or payment check.
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
    <div className="min-w-0">
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 break-words font-semibold text-foreground",
          prominent && "text-xl font-bold tracking-[-0.03em] tabular-nums",
        )}
      >
        {value}
      </dd>
    </div>
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
          title="Insurance proof"
          description="See what proof is saved for hail and insurance work. This does not make an insurer choice."
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
                    <p className="text-sm font-bold text-foreground">Insurance supplement</p>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      This only shows saved proof. IronWrap does not decide what the insurer means.
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
                    label="Saved proof"
                    value={
                      supplement.evidence_roles.length > 0
                        ? supplement.evidence_roles.join(" · ")
                        : "No checked proof type found"
                    }
                  />
                  <InsuranceEvidenceCell
                    label="Invoice"
                    value={insuranceInvoiceCopy(supplement.invoice_state)}
                  />
                  <InsuranceEvidenceCell
                    label="Last step"
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
                      The needed proof is saved. A person must still review the next step.
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
  if (state === "approved") return "Approved roof data linked";
  if (state === "review_required") return "Roof data linked; review needed";
  if (state === "missing") return "No roof data linked";
  return "Roof data unavailable";
}

function insuranceInvoiceCopy(
  state: EstimatorWorkbenchResponse["insurance_supplements"][number]["invoice_state"],
): string {
  if (state === "recorded") return "Invoice proof saved";
  if (state === "not_required") return "No invoice is needed here";
  if (state === "required") return "Add an invoice or explain why it is missing";
  return "Invoice state is missing";
}

function insuranceHandoffCopy(
  supplement: EstimatorWorkbenchResponse["insurance_supplements"][number],
): string {
  if (supplement.closed_recorded) return "Closed internally";
  if (supplement.carrier_response_recorded) return "Insurer reply saved";
  if (supplement.submission_recorded) return "Sent proof saved";
  if (supplement.approval_recorded) return "Approved for submission";
  return "No next-step proof saved";
}

function insuranceRequirementCopy(
  requirement: EstimatorWorkbenchResponse["insurance_supplements"][number]["missing_requirements"][number],
): string {
  const copy = {
    approved_measurement: "Link an approved roof report.",
    carrier_scope: "Add the saved insurer scope.",
    code_or_manufacturer: "Add the code or maker proof.",
    photo: "Add checked photos.",
    invoice_or_exception: "Add the invoice or explain why it is missing.",
    submission_artifact: "Save proof that a person sent it before using Submitted.",
    carrier_response_artifact: "Save the insurer reply before using this state.",
    source_detail_unavailable: "The proof details could not be loaded.",
  } satisfies Record<
    EstimatorWorkbenchResponse["insurance_supplements"][number]["missing_requirements"][number],
    string
  >;
  return copy[requirement];
}

function proposalDecisionStep(readiness: EstimatorWorkbenchResponse["proposal_readiness"]) {
  if (readiness.state === "ready")
    return { detail: "Ready for proposal review", tone: "bg-ok-soft text-ok" };
  if (readiness.state === "review_required") {
    return { detail: "Review required", tone: "bg-warning-soft text-warning" };
  }
  if (readiness.state === "blocked")
    return { detail: "Proof blocks this step", tone: "bg-warning-soft text-warning" };
  return { detail: "Some source details are missing", tone: "bg-surface-muted text-muted" };
}

function VisualEvidence({
  visual,
  locale,
}: {
  visual: EstimatorWorkbenchResponse["visual_model"];
  locale: string;
}) {
  if (!visual) {
    return (
      <section
        className="rounded-xl border border-border bg-surface px-5 py-6 sm:px-6"
        aria-labelledby="visual-evidence-heading"
      >
        <SectionHeading
          id="visual-evidence-heading"
          icon={Layers3}
          title="Property drawing"
          description="No property drawing was found for this roof job. Roof data and the quote stay separate."
        />
      </section>
    );
  }

  const modelState = visualModelState(visual.model_state);
  const preview = visualPreviewState(visual.preview.state);
  return (
    <section
      className="rounded-xl border border-border bg-surface"
      aria-labelledby="visual-evidence-heading"
    >
      <div className="px-5 py-6 sm:px-6 sm:py-7">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <SectionHeading
            id="visual-evidence-heading"
            icon={Layers3}
            title="Property drawing"
            description="See the saved property drawing. It does not prove site size, final scope, or a customer-ready design."
          />
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <StatusChip label={modelState.label} tone={modelState.tone} />
            <StatusChip
              label={visual.review_required ? "Review required" : "No review flag"}
              tone={
                visual.review_required
                  ? "bg-warning-soft text-warning"
                  : "bg-surface-muted text-muted"
              }
            />
          </div>
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
            {visual.preview.state === "available" && visual.preview.url ? (
              <figure>
                <img
                  src={visual.preview.url}
                  alt="Saved property drawing"
                  className="aspect-[16/10] w-full object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
                <figcaption className="border-t border-border px-4 py-3 text-xs leading-5 text-muted">
                  This saved image is safe to view. It is not a site-checked roof plan.
                </figcaption>
              </figure>
            ) : (
              <div className="flex min-h-48 flex-col justify-center px-5 py-6">
                <p className="font-bold text-foreground">{preview.title}</p>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{preview.detail}</p>
              </div>
            )}
          </div>

          <dl className="grid overflow-hidden rounded-lg border border-border sm:grid-cols-2 xl:grid-cols-1">
            <MeasurementFact label="Provider" value={visual.provider ?? "Unavailable"} />
            <MeasurementFact
              label="Confidence"
              value={formatVisualConfidence(visual.confidence, locale)}
              bordered
            />
            <MeasurementFact
              label="Roof data link"
              value={visualMeasurementLinkCopy(visual.measurement_link)}
              bordered
            />
            <MeasurementFact
              label="Approval"
              value={visual.approval_recorded ? "Recorded" : "Not approved"}
              bordered
            />
            <MeasurementFact
              label="Captured"
              value={formatDate(visual.captured_at, locale) ?? "Not recorded"}
              bordered
            />
            <MeasurementFact
              label="Approved at"
              value={formatDate(visual.approved_at, locale) ?? "Not recorded"}
              bordered
            />
          </dl>
        </div>

        <p className="mt-5 border-l-2 border-warning bg-warning-soft/40 px-4 py-3 text-sm leading-6 text-foreground">
          Images open only from an approved secure website. This view cannot open saved model files.
          It does not change roof data, price, scope, or proposal state.
        </p>
      </div>
    </section>
  );
}

function visualModelState(
  state: NonNullable<EstimatorWorkbenchResponse["visual_model"]>["model_state"],
): { label: string; tone: string } {
  const copy = {
    approved: { label: "Drawing approved", tone: "bg-ok-soft text-ok" },
    needs_review: { label: "Drawing needs review", tone: "bg-warning-soft text-warning" },
    draft: { label: "Draft drawing", tone: "bg-warning-soft text-warning" },
    rejected: { label: "Drawing rejected", tone: "bg-warning-soft text-warning" },
    unavailable: { label: "Drawing unavailable", tone: "bg-surface-muted text-muted" },
  } satisfies Record<
    NonNullable<EstimatorWorkbenchResponse["visual_model"]>["model_state"],
    { label: string; tone: string }
  >;
  return copy[state];
}

function visualPreviewState(
  state: NonNullable<EstimatorWorkbenchResponse["visual_model"]>["preview"]["state"],
): { title: string; detail: string } {
  const copy = {
    available: {
      title: "Preview available",
      detail: "The saved image is ready to view.",
    },
    not_recorded: {
      title: "No image saved",
      detail: "This property drawing has no saved image.",
    },
    not_configured: {
      title: "Image site is not set up",
      detail: "An image exists, but this office is not set up to open it.",
    },
    blocked: {
      title: "Image blocked",
      detail: "The image did not come from an approved secure website.",
    },
    invalid: {
      title: "Image could not be read",
      detail: "The saved image data is not valid.",
    },
    unavailable: {
      title: "Image unavailable",
      detail: "The saved drawing details could not be loaded.",
    },
  } satisfies Record<
    NonNullable<EstimatorWorkbenchResponse["visual_model"]>["preview"]["state"],
    { title: string; detail: string }
  >;
  return copy[state];
}

function visualMeasurementLinkCopy(
  link: NonNullable<EstimatorWorkbenchResponse["visual_model"]>["measurement_link"],
): string {
  const copy = {
    selected_measurement: "Linked to this roof data",
    other_measurement: "Linked to other roof data",
    unlinked: "No roof data linked",
    unavailable: "Link unavailable",
  } satisfies Record<
    NonNullable<EstimatorWorkbenchResponse["visual_model"]>["measurement_link"],
    string
  >;
  return copy[link];
}

function formatVisualConfidence(value: number | null, locale: string): string {
  return value === null ? "Not recorded" : formatPercent(value / 100, locale);
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
          title="Roof measurements"
          description="No roof report was found. Do not use the quote or material list as roof proof."
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
            title="Roof measurements"
            description="Saved values are shown next to values checked from the roof file."
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
              These checks use the saved file, not the job site. They do not confirm hidden damage,
              deck condition, access, or site size.
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
        <h3 id="source-facet-preview-heading" className="text-sm font-bold text-foreground">
          Roof faces
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted">
          A short list of roof faces from the file. This is not a site check.
        </p>
      </div>
      {facets.length === 0 ? (
        <p className="px-4 py-5 text-sm leading-6 text-muted">
          No roof faces were found in the file.
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
                  {facet.ring_closed ? "Shape closed" : "Shape open"}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {geometry.facet_count > facets.length ? (
        <p className="border-t border-border px-4 py-3 text-xs leading-5 text-muted">
          Open the roof face check below to see all saved values.
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
        No roof faces were found in the saved file.
      </p>
    );
  }
  return (
    <section className="mt-7" aria-labelledby="facet-comparison-heading">
      <h3 id="facet-comparison-heading" className="text-lg font-bold tracking-[-0.02em]">
        Roof face check
      </h3>
      <details open={geometry.failed_check_count > 0 || geometry.facets_truncated} className="mt-3">
        <summary className="flex cursor-pointer list-none flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4 [&::-webkit-details-marker]:hidden">
          <span className="text-sm leading-6 text-muted">
            Saved and checked roof areas are shown side by side.
          </span>
          <span className="text-sm font-semibold text-muted">
            {geometry.facets_truncated ? "First roof faces shown" : "Roof face details"}
          </span>
        </summary>
        <p className="mt-3 text-xs font-semibold text-muted sm:hidden">
          Swipe the table to see every value.
        </p>
        <div
          className="mt-2 overflow-x-auto rounded-lg border border-border"
          aria-label="Roof face check table"
        >
          <table className="min-w-[45rem] w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              Roof faces with saved area, checked area, difference, pitch, and closed shape.
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
      <h3 id="geometry-checks-heading" className="text-lg font-bold tracking-[-0.02em]">
        Source checks
      </h3>
      <details open={geometry.failed_check_count > 0 || geometry.checks_truncated} className="mt-3">
        <summary className="flex cursor-pointer list-none flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4 [&::-webkit-details-marker]:hidden">
          <span className="text-sm leading-6 text-muted">
            The file name, closed shapes, and saved roof math are checked.
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
            No file issues were found. This is still not a site check.
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
      <h3 id="measurement-metrics-heading" className="text-lg font-bold tracking-[-0.02em]">
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
            Each value stays tied to its place in the roof file.
          </span>
          <span className="text-sm font-semibold text-muted">Roof value details</span>
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
            title="Checked roof values"
            metrics={geometryMetrics.map((metric) => ({
              id: metric.metric,
              label: metric.metric,
              value: formatNumber(metric.value),
              source: metric.source_ref,
              warning: false,
              detail: "Checked from the saved roof shape",
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
            title="Materials"
            description="Each item stays linked to its roof data and review state."
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
            <h3 className="mt-6 text-lg font-bold tracking-[-0.02em]">Material list</h3>
            <details open={flaggedItems > 0 || selected.items_truncated} className="mt-3">
              <summary className="flex cursor-pointer list-none flex-wrap items-end justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4 [&::-webkit-details-marker]:hidden">
                <span className="text-sm leading-6 text-muted">
                  Each amount stays tied to the roof value used to make it.
                </span>
                <span className="text-sm font-semibold text-muted">Material details</span>
              </summary>
              <p className="mt-3 text-xs font-semibold text-muted sm:hidden">
                Swipe the table to see every item.
              </p>
              <div
                className="mt-2 overflow-x-auto rounded-lg border border-border"
                aria-label="Material takeoff table"
              >
                <table className="min-w-[48rem] w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Materials with amount, waste, roof value, and review state.
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
                          No material items were found.
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
  const quoteCurrency = quote?.currency ?? tenantCurrency;
  return (
    <aside
      className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface xl:sticky xl:top-20"
      aria-labelledby="commercial-record-heading"
    >
      <div className="px-5 py-5">
        <h2 id="commercial-record-heading" className="text-lg font-bold tracking-[-0.02em]">
          Commercial outcome
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Quote, document, delivery, and job boundaries.
        </p>
      </div>
      <details className="group border-t border-border" aria-labelledby="quote-heading">
        <summary className="flex min-h-20 cursor-pointer list-none items-start justify-between gap-4 p-5 transition-colors hover:bg-surface-raised [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <h3 id="quote-heading" className="text-base font-bold tracking-[-0.02em]">
              Customer quote
            </h3>
            <span className="mt-1 block text-xl font-bold tracking-[-0.03em] tabular-nums">
              {quote
                ? (formatMoney(quote.quote_total, locale, quoteCurrency) ?? "Total not recorded")
                : "No quote returned"}
            </span>
            {quote ? (
              <span className="mt-2 flex flex-wrap gap-2">
                <StatusChip
                  label={humanize(quote.status) ?? "State unavailable"}
                  tone={quoteTone(quote.status)}
                />
                {quote.status === "Draft" || quote.status === "Needs Review" ? (
                  <StatusChip label="Not customer-ready" tone="bg-warning-soft text-warning" />
                ) : null}
              </span>
            ) : null}
          </span>
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface-raised">
            <ChevronDown
              className="size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="border-t border-border px-5 pb-5">
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
            </>
          )}
        </div>
      </details>

      {quote ? <QuoteRevisionEntry model={model} quote={quote} /> : null}

      <details className="group border-t border-border" aria-labelledby="proposal-heading">
        <summary className="flex min-h-20 cursor-pointer list-none items-start justify-between gap-4 p-5 transition-colors hover:bg-surface-raised [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <h3 id="proposal-heading" className="text-base font-bold tracking-[-0.02em]">
              Proposal
            </h3>
            <span className="mt-2 flex flex-wrap gap-2">
              {proposal ? (
                <StatusChip
                  label={humanize(proposal.status) ?? "State unavailable"}
                  tone={proposalTone(proposal.status)}
                />
              ) : (
                <StatusChip
                  label={
                    proposalLineage === "mismatch"
                      ? "No proposal links to this quote"
                      : "No proposal"
                  }
                  tone={
                    proposalLineage === "mismatch"
                      ? "bg-warning-soft text-warning"
                      : "bg-surface-muted text-muted"
                  }
                />
              )}
              <StatusChip
                label={humanize(model.proposal_readiness.state) ?? "Readiness unavailable"}
                tone={proposalDecisionStep(model.proposal_readiness).tone}
              />
            </span>
          </span>
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface-raised">
            <ChevronDown
              className="size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="border-t border-border px-5 pb-5">
          {!proposal ? (
            <EmptyInline message={proposalEmptyMessage(quote, model.proposal, proposalLineage)} />
          ) : (
            <div className="mt-5 text-sm leading-6">
              <dl className="divide-y divide-border border-y border-border">
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
              </dl>
              <AssumptionLedger
                assumptions={proposal.assumptions}
                exclusions={proposal.exclusions}
                compact
              />
            </div>
          )}
          <ProposalReadiness readiness={model.proposal_readiness} />
        </div>
      </details>

      <details className="group border-t border-border">
        <summary className="flex min-h-20 cursor-pointer list-none items-center justify-between gap-4 p-5 transition-colors hover:bg-surface-raised [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-base font-bold tracking-[-0.02em]">Customer delivery</span>
            <span
              className={cn(
                "mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-bold",
                proposalDecisionStep(model.proposal_readiness).tone,
              )}
            >
              {model.proposal_readiness.state === "ready"
                ? "Ready for delivery review"
                : "Finish review first"}
            </span>
          </span>
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface-raised">
            <ChevronDown
              className="size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="border-t border-border bg-surface-raised/35">
          <ProposalPublicationAction
            roofJobId={model.job.id}
            proposalEvidencePackId={proposal?.id ?? null}
            proposalStatus={proposal?.status ?? null}
            locale={locale}
          />
          <CustomerPortalOfficeAccess roofJobId={model.job.id} locale={locale} />
        </div>
      </details>

      <details className="group border-t border-border" aria-labelledby="scope-heading">
        <summary className="flex min-h-20 cursor-pointer list-none items-center justify-between gap-4 p-5 transition-colors hover:bg-surface-raised [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <h3 id="scope-heading" className="text-base font-bold tracking-[-0.02em]">
              Scope and risks
            </h3>
            <span className="mt-1 block text-xs text-muted">
              {model.scope_clauses.length} clauses · {model.scope_changes.length} changes
            </span>
          </span>
          <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-surface-raised">
            <ChevronDown
              className="size-4 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </span>
        </summary>
        <div className="border-t border-border px-5 pb-5">
          <ScopeClauses clauses={model.scope_clauses} locale={locale} />
          <ScopeChangeLedger
            changes={model.scope_changes}
            locale={locale}
            tenantCurrency={tenantCurrency}
          />
        </div>
      </details>
    </aside>
  );
}

function takeoffEmptyMessage(
  model: EstimatorWorkbenchResponse,
  lineage: EstimatorWorkbenchResponse["lineage"]["measurement_to_takeoff"],
): string {
  if (lineage === "mismatch") {
    const count = model.takeoffs.records.length;
    return `${count} material ${count === 1 ? "list was" : "lists were"} found, but none use this roof report. Do not use their amounts.`;
  }
  if (lineage === "unknown") {
    return "Some material history could not be loaded, so the link cannot be checked.";
  }
  if (lineage === "no_measurement") {
    return "No roof report is ready for a material list.";
  }
  return "No material list was found. Do not guess amounts from the quote total.";
}

function proposalEmptyMessage(
  quote: EstimatorWorkbenchResponse["quote"],
  proposal: EstimatorWorkbenchResponse["proposal"],
  lineage: EstimatorWorkbenchResponse["lineage"]["quote_to_proposal"],
): string {
  if (lineage === "mismatch") {
    return "Proposals were found, but none use this quote. Do not show one to the customer.";
  }
  if (lineage === "unknown") {
    return "Some proposal history could not be loaded, so the quote link cannot be checked.";
  }
  if (lineage === "no_quote") {
    return "No customer quote is ready for a proposal.";
  }
  if (!quote && !proposal) return "No proposal was found. Do not show a proposal to the customer.";
  return "No proposal was found for this quote. Do not show one to the customer.";
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
  return (
    <div className="mt-5">
      <p className="mt-3 text-3xl font-bold tracking-[-0.035em] tabular-nums">
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
  const session = useSession();
  const online = useOnlineStatus();
  const launchKey = useRef(newFacetLaunchKey());
  // "Design in Facet" was live whatever the Facet launch configuration said, so an office user
  // whose deployment has no Facet route for this tenant learned that only from a failed request
  // after the tap. The permission says the role may launch; the capability says whether launching
  // can work at all, and both have to be true (ELEC-236 AC3).
  const facetLaunch = useCapability("facet_launch");
  const facetLaunchUnusable = capabilityPreventsUse(facetLaunch);
  const canLaunch = model.allowed_actions.includes("facet_launch.create");
  const canRevise = model.allowed_actions.includes("quote_revision_approval.prepare");
  const launch = useMutation({
    retry: false,
    mutationFn: () => createFacetLaunch(model.job.id, session.csrf_token, launchKey.current),
    onSuccess: navigateToFacetLaunch,
  });
  if (!canLaunch && !canRevise) return null;
  const launchDisabled = !online || isOfflineSession(session) || launch.isPending;
  return (
    <section
      className="border-t border-border bg-surface-raised/35 p-5"
      aria-labelledby="revision-request-heading"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <h3 id="revision-request-heading" className="text-sm font-bold text-foreground">
            {canLaunch ? "Open this approved quote in Facet" : "Fix this quote safely"}
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted">
            {canLaunch
              ? "Open the design for this customer and job. IronWrap does not send the address, price, scope, proposal, payment, or a promise to Facet."
              : "Ask for an empty draft quote. A person must review it. Price, tax, scope, payment, approvals, and customer terms are not copied."}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {canLaunch ? (
            <Button
              type="button"
              size="default"
              disabled={launchDisabled || facetLaunchUnusable}
              onClick={() => launch.mutate(undefined)}
            >
              <Palette aria-hidden="true" />
              {launch.isPending ? "Opening Facet…" : "Design in Facet"}
            </Button>
          ) : null}
          {canRevise ? (
            <Button asChild variant="outline" size="default">
              <Link to="/estimator/jobs/$jobId/revision" params={{ jobId: model.job.id }}>
                <FileText aria-hidden="true" />
                Request draft revision
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
      {canLaunch && (!online || isOfflineSession(session)) ? (
        <p className="mt-3 text-xs font-semibold text-muted">Reconnect to open this design.</p>
      ) : null}
      {canLaunch ? (
        <div className="mt-4">
          <CapabilityUnavailable read={facetLaunch} />
        </div>
      ) : null}
      {launch.isError ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-danger">
          {launch.error instanceof ApiError &&
          [
            "facet_design_current_approved_quote_required",
            "facet_launch_idempotency_conflict",
          ].includes(launch.error.code)
            ? "The approved quote or design link changed. Reload this job before opening Facet."
            : "Facet could not be opened. IronWrap did not change the quote; try again."}
        </p>
      ) : null}
      <p className="mt-3 break-all text-xs font-semibold text-muted">Source: {quote.id}</p>
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
      ? "Saved price checked"
      : snapshot.state === "expired"
        ? "Quote expired"
        : snapshot.state === "incomplete"
          ? "Saved price incomplete"
          : snapshot.state === "review_required"
            ? "Estimator review needed"
            : "No saved price";
  return (
    <section
      className="mt-6 border-y border-border py-4"
      aria-labelledby="pricing-snapshot-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="pricing-snapshot-heading" className="text-sm font-bold text-foreground">
            Saved price
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Saved with this quote. It is not a live supplier price.
          </p>
        </div>
        <StatusChip label={label} tone={tone} />
      </div>
      <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
        <RecordLine label="Price book" value={snapshot.price_book_version ?? "Not recorded"} />
        <RecordLine
          label="Price date"
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
          Quote changes
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
            Quote changes
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Compared with the earlier quote. This page does not make new amounts.
          </p>
        </div>
        <StatusChip label="Quotes linked" tone="bg-ok-soft text-ok" />
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
            Why it changed
          </h3>
          <p className="mt-1 text-sm leading-6 text-foreground">{quote.correction_reason}</p>
        </section>
      ) : null}
      {delta.scope_summary_changed ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm leading-6">
          <p className="text-xs font-bold text-muted">Scope change</p>
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
        title="Job changes"
        description="See which quote each job change uses and if the customer said yes."
        level="h3"
      />
      {changes.length === 0 ? (
        <EmptyInline message="No job changes were found." />
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
                      {change.number ?? "Change identity unavailable"}
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
                    label="Price change"
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
            Proposal check
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            This check does not create, approve, send, sign, or take money for a proposal.
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
          No system check is stopping this proposal. A person must still review it.
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

function ReviewGroup({
  title,
  description,
  status,
  tone,
  children,
  reveal,
}: {
  title: string;
  description: string;
  status: string;
  tone: string;
  children: ReactNode;
  reveal?: string;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (reveal && details.current) details.current.open = true;
  }, [reveal]);
  return (
    <details ref={details} className="group overflow-hidden bg-surface">
      <summary className="flex min-h-20 cursor-pointer list-none flex-col items-stretch gap-3 px-5 py-4 transition-colors hover:bg-surface-raised focus-visible:outline-offset-[-3px] [&::-webkit-details-marker]:hidden sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <span className="min-w-0">
          <span className="block text-lg font-bold tracking-[-0.02em] text-foreground">
            {title}
          </span>
          <span className="mt-1 block max-w-2xl text-sm leading-6 text-muted">{description}</span>
        </span>
        <span className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
          <StatusChip label={status} tone={tone} />
          <ChevronDown
            className="size-5 text-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className="space-y-6 border-t border-border bg-surface-muted/30 p-3 sm:p-4">
        {children}
      </div>
    </details>
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
        className="flex items-center gap-2 text-xl font-bold tracking-[-0.025em] text-balance sm:text-2xl"
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
          "mt-1 text-lg font-bold tabular-nums",
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
        <p className="font-bold text-foreground">Some details may be missing</p>
        <p className="mt-1 text-muted">
          {sources.length > 0
            ? `${sources.join(", ")} reached the safe read limit. The list and totals may be short.`
            : "One or more details could not be loaded. A blank field does not mean no record exists."}
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
          Showing the last saved review. Refresh failed, so newer roof or quote details may exist.
        </p>
      </div>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}

function EstimatorWorkbenchError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Roof and quote review is unavailable"
      message="No saved review could be loaded. Nothing was created or changed."
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
      title: "Roof math checked from the file",
      detail: "The saved roof math was checked again. A site check is still needed.",
      surface: "border-ok/40 bg-ok-soft/45",
      iconTone: "text-ok",
      icon: Check,
    };
  }
  if (geometry.state === "needs_review") {
    return {
      title: "Roof math needs review",
      detail: `${geometry.failed_check_count} file check${geometry.failed_check_count === 1 ? "" : "s"} must be fixed before the material list can be trusted.`,
      surface: "border-warning/40 bg-warning-soft/55",
      iconTone: "text-warning",
      icon: ShieldAlert,
    };
  }
  return {
    title: "Roof math could not be checked",
    detail: geometryUnavailableCopy(geometry.reason),
    surface: "border-warning/40 bg-warning-soft/55",
    iconTone: "text-warning",
    icon: FileSearch,
  };
}

function geometryUnavailableCopy(reason: string | null): string {
  if (reason === "raw_source_not_recorded") return "This roof report has no saved source file.";
  if (reason === "raw_source_not_found") return "The saved roof file was not found.";
  if (reason === "raw_source_too_large") return "The saved roof file is too large to check here.";
  if (reason === "raw_source_not_recomputable")
    return "The saved file does not have a roof shape IronWrap can check.";
  if (reason === "raw_source_rejected") return "The saved roof file did not pass the safety check.";
  if (reason === "raw_source_read_failed") return "The saved roof file could not be read safely.";
  if (reason === "measurement_detail_unavailable")
    return "The chosen roof details are no longer available.";
  if (reason === "measurement_detail_too_large")
    return "The chosen roof details are too large to load here.";
  if (reason === "measurement_detail_mismatch")
    return "The chosen roof details no longer match this job.";
  return "No roof file was found for this check.";
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
  if (state === "not_revised") return "This quote does not name an older quote to compare.";
  if (state === "unlinked_revision") {
    return "This quote has a higher version number, but no older quote link. Do not guess what changed.";
  }
  if (state === "prior_quote_missing") {
    return "The older quote was not found. Do not guess or explain the price change.";
  }
  if (state === "history_incomplete") {
    return "Some quote history could not be loaded, so the older quote cannot be checked.";
  }
  if (state === "invalid_lineage") {
    return "The older quote link is wrong. Fix it before this review moves on.";
  }
  return "No customer quote is ready to compare.";
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
    measurement_missing: "No roof report is ready for this review.",
    measurement_source_review_required:
      "Roof math from the file still needs review. This is not a site check.",
    takeoff_link_missing: "No approved material list uses this roof report.",
    takeoff_not_approved: "The linked material list is not approved.",
    quote_missing: "No customer quote is ready for this proposal.",
    quote_snapshot_incomplete: "The quote does not have a full saved price.",
    quote_not_approved: "The quote is not approved or accepted.",
    scope_change_unresolved: "A job change still needs the customer's written choice.",
    proposal_link_mismatch: "The proposal does not use this quote.",
    source_window_partial: "Some source history could not be loaded.",
    stale_source_detail: "Some chosen details are old or missing.",
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
