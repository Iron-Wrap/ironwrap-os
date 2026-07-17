import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  BriefcaseBusiness,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  FileSearch,
  FileText,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import { loadSales } from "./sales-api";
import type { SalesLead, SalesResponse } from "./sales-contracts";

type SalesFilter = "attention" | "all" | "triage" | "estimate" | "quote";

const attentionCopy: Record<
  SalesLead["attention"][number],
  { label: string; tone: string; icon: LucideIcon }
> = {
  triage_unresolved: {
    label: "Triage unresolved",
    tone: "bg-danger-soft text-danger",
    icon: TriangleAlert,
  },
  estimate_needs_review: {
    label: "Estimate review",
    tone: "bg-warning-soft text-warning",
    icon: FileSearch,
  },
  quote_needs_review: { label: "Quote review", tone: "bg-info-soft text-info", icon: FileText },
  quote_expired: { label: "Quote expired", tone: "bg-danger-soft text-danger", icon: Clock3 },
};

export function SalesDeskPage() {
  return (
    <RoleGuard surface="sales">
      <SalesDeskContent />
    </RoleGuard>
  );
}

function SalesDeskContent() {
  const session = useSession();
  const [filter, setFilter] = useState<SalesFilter>("attention");
  const query = useQuery({
    queryKey: ["sales", session.tenant.id, session.user.id],
    queryFn: () => loadSales(),
  });
  const model = query.data;

  if (!model && query.isPending) return <SalesDeskSkeleton />;
  if (!model && query.isError) return <SalesDeskError onRetry={() => void query.refetch()} />;
  if (!model) return <SalesDeskSkeleton />;

  return (
    <SalesDeskScreen
      filter={filter}
      model={model}
      locale={session.tenant.locale}
      currency={session.tenant.currency}
      refreshFailed={query.isError}
      onFilterChange={setFilter}
      onRetry={() => void query.refetch()}
    />
  );
}

function SalesDeskScreen({
  model,
  filter,
  locale,
  currency,
  refreshFailed,
  onFilterChange,
  onRetry,
}: {
  model: SalesResponse;
  filter: SalesFilter;
  locale: string;
  currency: string;
  refreshFailed: boolean;
  onFilterChange: (filter: SalesFilter) => void;
  onRetry: () => void;
}) {
  const leads = useMemo(
    () => model.leads.filter((lead) => matchesFilter(lead, filter)),
    [filter, model.leads],
  );
  const filters = salesFilters(model);
  const generatedAt = formatDate(model.read_model_generated_at, locale);
  const isBounded =
    model.partial_sources.length > 0 ||
    model.stale_fields.length > 0 ||
    model.source_updated_at === null;
  const canReviewApprovals = model.allowed_actions.includes("approval.read");
  const canPrepareTriage = model.allowed_actions.includes("approval.prepare");
  const canOpenWorkbench = model.allowed_actions.includes("estimator.read");
  const proposalSourcePartial = model.partial_sources.includes("proposal_evidence_packs");

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <BriefcaseBusiness className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Sales desk
              </h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                Review the lead, estimate, quote, and communication record before any follow-up.
                This surface does not send a message, issue a quote, or alter a customer record.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 xl:justify-end">
            {generatedAt ? (
              <p className="text-sm text-muted">Read generated {generatedAt}</p>
            ) : null}
            {canReviewApprovals ? (
              <Button asChild variant="outline" size="compact">
                <Link to="/approvals">
                  <ShieldCheck aria-hidden="true" />
                  Review approvals
                </Link>
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {refreshFailed ? <RefreshWarning onRetry={onRetry} /> : null}

      <SalesSignals model={model} />

      {isBounded ? <DataBoundary model={model} /> : null}

      <div className="grid gap-7 xl:grid-cols-[13.5rem_minmax(0,1fr)] xl:items-start">
        <aside className="xl:sticky xl:top-28">
          <FilterRail filters={filters} selected={filter} onChange={onFilterChange} />
        </aside>
        <main className="min-w-0">
          <LeadQueue
            leads={leads}
            filter={filter}
            locale={locale}
            currency={currency}
            canOpenWorkbench={canOpenWorkbench}
            canPrepareTriage={canPrepareTriage}
            proposalSourcePartial={proposalSourcePartial}
          />
        </main>
      </div>
    </section>
  );
}

function SalesSignals({ model }: { model: SalesResponse }) {
  const signals = [
    {
      label: "Triage open",
      value: model.summary.triage_unresolved,
      detail: "Lead classification still needs a human decision",
      tone: "text-danger",
      dot: "bg-danger",
    },
    {
      label: "Estimate review",
      value: model.summary.estimate_needs_review,
      detail: "Ranges remain non-binding until reviewed",
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Quote review",
      value: model.summary.quote_needs_review + model.summary.quote_expired,
      detail: "Quote state is visible, not inferred",
      tone: "text-info",
      dot: "bg-info",
    },
  ];
  return (
    <dl className="grid grid-cols-3 border-y border-border" aria-label="Sales review signals">
      {signals.map((signal, index) => (
        <div
          key={signal.label}
          className={cn(
            "min-h-20 px-3 py-3 sm:min-h-24 sm:px-5 sm:py-4",
            index > 0 && "border-l border-border",
          )}
        >
          <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
            <span className={cn("size-2 rounded-full", signal.dot)} aria-hidden="true" />
            {signal.label}
          </dt>
          <dd
            className={cn(
              "mt-1 text-xl font-black tracking-[-0.03em] sm:mt-2 sm:text-2xl",
              signal.tone,
            )}
          >
            {signal.value}
          </dd>
          <p className="mt-1 hidden max-w-56 text-sm leading-5 text-muted sm:block">
            {signal.detail}
          </p>
        </div>
      ))}
    </dl>
  );
}

function FilterRail({
  filters,
  selected,
  onChange,
}: {
  filters: Array<{ id: SalesFilter; label: string; count: number }>;
  selected: SalesFilter;
  onChange: (filter: SalesFilter) => void;
}) {
  return (
    <div className="pb-1">
      <div
        className="flex flex-wrap gap-2 xl:flex-col xl:border-l xl:border-border xl:pl-3"
        aria-label="Sales queue filters"
      >
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            aria-pressed={selected === filter.id}
            onClick={() => onChange(filter.id)}
            className={cn(
              "flex min-h-11 items-center justify-between gap-4 rounded-md px-3 text-sm font-bold transition-colors",
              selected === filter.id
                ? "bg-foreground text-background"
                : "bg-surface text-muted hover:bg-surface-muted hover:text-foreground",
            )}
          >
            <span>{filter.label}</span>
            <span
              className={cn("tabular-nums", selected === filter.id ? "text-accent" : "text-muted")}
            >
              {filter.count}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function LeadQueue({
  leads,
  filter,
  locale,
  currency,
  canOpenWorkbench,
  canPrepareTriage,
  proposalSourcePartial,
}: {
  leads: SalesLead[];
  filter: SalesFilter;
  locale: string;
  currency: string;
  canOpenWorkbench: boolean;
  canPrepareTriage: boolean;
  proposalSourcePartial: boolean;
}) {
  if (leads.length === 0) {
    return (
      <EmptyState
        title={emptyQueueTitle(filter)}
        message="No source-backed records match this view. Changing a filter does not create or hide a lead."
      />
    );
  }
  return (
    <section aria-labelledby="sales-queue-heading">
      <header className="flex flex-wrap items-end justify-between gap-3 pb-3">
        <div>
          <h2
            id="sales-queue-heading"
            className="text-xl font-black tracking-[-0.025em] text-balance sm:text-2xl"
          >
            {queueTitle(filter)}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Contact details are visible for office review only. Communication and proposal actions
            remain governed elsewhere.
          </p>
        </div>
        <p className="text-sm font-semibold text-muted">
          {leads.length} {leads.length === 1 ? "lead" : "leads"}
        </p>
      </header>
      <ol className="border-y border-border divide-y divide-border">
        {leads.map((lead) => (
          <li key={lead.id}>
            <LeadRow
              lead={lead}
              locale={locale}
              defaultCurrency={currency}
              canOpenWorkbench={canOpenWorkbench}
              canPrepareTriage={canPrepareTriage}
              proposalSourcePartial={proposalSourcePartial}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}

function LeadRow({
  lead,
  locale,
  defaultCurrency,
  canOpenWorkbench,
  canPrepareTriage,
  proposalSourcePartial,
}: {
  lead: SalesLead;
  locale: string;
  defaultCurrency: string;
  canOpenWorkbench: boolean;
  canPrepareTriage: boolean;
  proposalSourcePartial: boolean;
}) {
  const receivedAt = formatDate(lead.received_at, locale);
  const contact = [lead.contact.phone, lead.contact.email].filter((value): value is string =>
    Boolean(value),
  );
  const jobLabel = lead.job?.job_number ?? lead.job?.id ?? null;
  return (
    <article className="bg-surface transition-colors hover:bg-surface-raised">
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span>{humanize(lead.source) ?? "Source unavailable"}</span>
              {receivedAt ? <span>{receivedAt}</span> : null}
              {lead.intent_queue ? <span>{lead.intent_queue}</span> : null}
            </div>
            <h3 className="mt-1 text-xl font-black tracking-[-0.025em] text-balance">
              {lead.contact.display_name ?? "Unnamed lead"}
            </h3>
            {contact.length > 0 ? (
              <p className="mt-2 break-words text-sm leading-6 text-muted">{contact.join(" · ")}</p>
            ) : (
              <p className="mt-2 text-sm leading-6 text-warning">
                No phone or email was returned in the office read model.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-sm lg:justify-end">
            <StatusChip
              label={`Triage: ${humanize(lead.triage.status) ?? "Unknown"}`}
              tone={triageTone(lead.triage.status)}
            />
            {lead.attention.map((reason) => (
              <AttentionChip key={reason} reason={reason} />
            ))}
          </div>
        </div>

        {lead.triage.summary ? (
          <p className="max-w-4xl border-l border-border pl-3 text-sm leading-6 text-foreground">
            {lead.triage.summary}
          </p>
        ) : null}

        <div className="grid border-y border-border lg:grid-cols-3">
          <ReviewCell label="Estimate">
            <EstimateSummary estimate={lead.estimate} locale={locale} currency={defaultCurrency} />
          </ReviewCell>
          <ReviewCell label="Quote">
            <QuoteSummary
              quote={lead.quote}
              proposal={lead.proposal}
              proposalSourcePartial={proposalSourcePartial}
              locale={locale}
              defaultCurrency={defaultCurrency}
            />
          </ReviewCell>
          <ReviewCell label="Communication record" last>
            <ConsentSummary consent={lead.consent} locale={locale} />
          </ReviewCell>
        </div>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
          {jobLabel ? <span>Job {jobLabel}</span> : <span>No linked job record returned</span>}
          {lead.job?.service_type ? <span>{lead.job.service_type}</span> : null}
          {lead.job?.workflow_profile ? <span>{lead.job.workflow_profile}</span> : null}
          <span className="font-mono text-xs text-muted/85">Lead {lead.envelope_id}</span>
          {canOpenWorkbench && lead.job ? (
            <Link
              to="/estimator/jobs/$jobId"
              params={{ jobId: lead.job.id }}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 font-bold text-foreground transition-colors hover:bg-surface-muted"
            >
              Open measurement workbench
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Link>
          ) : null}
          {canPrepareTriage &&
          lead.triage.status === "Untriaged" &&
          lead.attention.includes("triage_unresolved") ? (
            <Link
              to="/sales/leads/$leadId/triage"
              params={{ leadId: lead.id }}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 font-bold text-foreground transition-colors hover:bg-surface-muted"
            >
              <ClipboardCheck className="size-4" aria-hidden="true" />
              Prepare triage review
            </Link>
          ) : null}
        </footer>
      </div>
    </article>
  );
}

function ReviewCell({
  label,
  children,
  last = false,
}: {
  label: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <section
      className={cn(
        "min-w-0 px-4 py-4 sm:px-5",
        !last && "border-b border-border lg:border-r lg:border-b-0",
      )}
    >
      <h4 className="text-sm font-bold text-muted">{label}</h4>
      <div className="mt-2 min-h-12">{children}</div>
    </section>
  );
}

function EstimateSummary({
  estimate,
  locale,
  currency,
}: {
  estimate: SalesLead["estimate"];
  locale: string;
  currency: string;
}) {
  if (!estimate)
    return <p className="text-sm leading-6 text-muted">No estimate session returned.</p>;
  const value = estimateValue(estimate, locale, currency);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          label={humanize(estimate.status) ?? "Status unavailable"}
          tone={estimateTone(estimate.status)}
        />
        {estimateIsNonBinding(estimate) ? (
          <StatusChip label="Non-binding" tone="bg-warning-soft text-warning" />
        ) : null}
      </div>
      {value ? <p className="text-base font-black tracking-[-0.02em]">{value}</p> : null}
      <p className="text-sm leading-6 text-muted">
        {[estimate.service_type, estimate.confidence].filter(Boolean).join(" · ") ||
          "Source detail unavailable"}
      </p>
      {estimate.assumptions ? (
        <p className="text-sm leading-6 text-muted">Assumptions: {estimate.assumptions}</p>
      ) : null}
    </div>
  );
}

function QuoteSummary({
  quote,
  proposal,
  proposalSourcePartial,
  locale,
  defaultCurrency,
}: {
  quote: SalesLead["quote"];
  proposal: SalesLead["proposal"];
  proposalSourcePartial: boolean;
  locale: string;
  defaultCurrency: string;
}) {
  if (!quote) return <p className="text-sm leading-6 text-muted">No quote record returned.</p>;
  const value =
    quote.quote_total === null
      ? null
      : formatMoney(quote.quote_total, locale, quote.currency ?? defaultCurrency);
  const validUntil = formatDate(quote.valid_until, locale, { dateStyle: "medium" });
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          label={humanize(quote.status) ?? "Status unavailable"}
          tone={quoteTone(quote.status)}
        />
        {quote.version !== null ? (
          <span className="text-xs font-bold text-muted">v{quote.version}</span>
        ) : null}
      </div>
      {value ? <p className="text-base font-black tracking-[-0.02em]">{value}</p> : null}
      <p className="text-sm leading-6 text-muted">
        {[quote.payment_status, validUntil ? `Valid until ${validUntil}` : null]
          .filter(Boolean)
          .join(" · ") || "Payment and validity unavailable"}
      </p>
      {quote.scope_summary ? (
        <p className="text-sm leading-6 text-muted">{quote.scope_summary}</p>
      ) : null}
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">
          Customer proposal
        </p>
        <ProposalPublicationSummary proposal={proposal} sourcePartial={proposalSourcePartial} />
      </div>
    </div>
  );
}

function ProposalPublicationSummary({
  proposal,
  sourcePartial,
}: {
  proposal: SalesLead["proposal"];
  sourcePartial: boolean;
}) {
  if (sourcePartial || proposal?.has_published_pack === null) {
    return (
      <div className="mt-2 space-y-1">
        {proposal ? (
          <StatusChip
            label={humanize(proposal.status) ?? "State unavailable"}
            tone={proposalTone(proposal.status)}
          />
        ) : null}
        <p className="text-sm font-bold text-warning">Publication state inconclusive</p>
        <p className="text-sm leading-6 text-warning">
          Proposal evidence reached its safe read boundary. Do not infer customer publication.
        </p>
      </div>
    );
  }
  if (!proposal) {
    return (
      <p className="mt-2 text-sm leading-6 text-warning">
        {sourcePartial
          ? "Proposal evidence reached its safe read boundary. Do not infer customer publication."
          : "No proposal evidence links to this quote. Quote terms remain office-only."}
      </p>
    );
  }
  const published = proposal.has_published_pack === true;
  const newestIsPublished = proposalIsPublished(proposal.status);
  return (
    <div className="mt-2 space-y-1">
      <StatusChip
        label={humanize(proposal.status) ?? "State unavailable"}
        tone={proposalTone(proposal.status)}
      />
      <p className={cn("text-sm font-bold", published ? "text-ok" : "text-warning")}>
        {published ? "Publication recorded" : "Not published"}
      </p>
      <p className="text-sm leading-6 text-muted">
        {published
          ? newestIsPublished
            ? "A valid customer link may show its safe summary when the portal capability is enabled."
            : `The latest returned office pack is ${humanize(proposal.status) ?? "draft"}; a valid customer link may still show the last published safe summary when the portal capability is enabled.`
          : "This pack cannot make quote terms customer-visible."}
      </p>
    </div>
  );
}

function ConsentSummary({ consent, locale }: { consent: SalesLead["consent"]; locale: string }) {
  if (consent.context === "partial") {
    return (
      <p className="text-sm leading-6 text-warning">
        Communication records reached a source limit. Do not infer permission from this summary.
      </p>
    );
  }
  if (consent.records.length === 0) {
    return (
      <p className="text-sm leading-6 text-warning">No linked communication record returned.</p>
    );
  }
  return (
    <ul className="space-y-2">
      {consent.records.slice(0, 3).map((record) => {
        const capturedAt = formatDate(record.captured_at, locale, { dateStyle: "medium" });
        return (
          <li key={record.id} className="text-sm leading-5">
            <p className="font-semibold text-foreground">
              {[record.channel, record.purpose, record.status].filter(Boolean).join(" · ")}
            </p>
            <p className="mt-0.5 text-muted">
              {[record.jurisdiction, record.basis, capturedAt].filter(Boolean).join(" · ") ||
                "Record detail unavailable"}
            </p>
          </li>
        );
      })}
      {consent.records.length > 3 ? (
        <li className="text-xs font-semibold text-muted">
          +{consent.records.length - 3} more linked records
        </li>
      ) : null}
    </ul>
  );
}

function AttentionChip({ reason }: { reason: SalesLead["attention"][number] }) {
  const copy = attentionCopy[reason];
  const Icon = copy.icon;
  return (
    <span
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-bold",
        copy.tone,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {copy.label}
    </span>
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

function DataBoundary({ model }: { model: SalesResponse }) {
  const sources = model.partial_sources
    .map(humanize)
    .filter((value): value is string => Boolean(value));
  return (
    <div
      className="flex gap-3 border border-warning/40 bg-warning-soft/55 p-4 text-sm leading-6"
      role="status"
    >
      <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div>
        <p className="font-bold text-foreground">This is a bounded review queue.</p>
        <p className="mt-1 text-muted">
          {sources.length > 0
            ? `${sources.join(", ")} ${sources.length === 1 ? "source reached" : "sources reached"} the read limit. Counts may be lower bounds.`
            : "One or more source fields are unavailable. Do not treat an empty value as proof that a record does not exist."}
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
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <p>
          Showing the last verified sales read. The refresh did not complete, so do not assume newer
          lead or quote state.
        </p>
      </div>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Refresh read
      </Button>
    </div>
  );
}

function SalesDeskError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Sales review is unavailable"
      message="No office sales records were loaded. This page will not substitute demo leads or assumed quote state."
      onRetry={onRetry}
    />
  );
}

function SalesDeskSkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-6"
      aria-busy="true"
      aria-label="Loading sales review queue"
    >
      <div className="h-20 border-b border-border bg-surface-muted/70" />
      <div className="grid grid-cols-3 border-y border-border">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={cn("min-h-24 bg-surface-muted/60", index > 0 && "border-l border-border")}
          />
        ))}
      </div>
      <div className="grid gap-7 xl:grid-cols-[13.5rem_minmax(0,1fr)]">
        <div className="h-48 bg-surface-muted/60" />
        <div className="h-96 border-y border-border bg-surface-muted/50" />
      </div>
    </section>
  );
}

function salesFilters(
  model: SalesResponse,
): Array<{ id: SalesFilter; label: string; count: number }> {
  return [
    {
      id: "attention",
      label: "Attention",
      count: model.leads.filter((lead) => lead.attention.length > 0).length,
    },
    { id: "all", label: "All leads", count: model.summary.listed_leads },
    { id: "triage", label: "Triage", count: model.summary.triage_unresolved },
    { id: "estimate", label: "Estimates", count: model.summary.estimate_needs_review },
    {
      id: "quote",
      label: "Quotes",
      count: model.summary.quote_needs_review + model.summary.quote_expired,
    },
  ];
}

function matchesFilter(lead: SalesLead, filter: SalesFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return lead.attention.length > 0;
  if (filter === "triage") return lead.attention.includes("triage_unresolved");
  if (filter === "estimate") return lead.attention.includes("estimate_needs_review");
  return lead.attention.includes("quote_needs_review") || lead.attention.includes("quote_expired");
}

function queueTitle(filter: SalesFilter): string {
  if (filter === "all") return "All lead records";
  if (filter === "triage") return "Triage needs a decision";
  if (filter === "estimate") return "Estimate review";
  if (filter === "quote") return "Quote review";
  return "Needs review";
}

function emptyQueueTitle(filter: SalesFilter): string {
  if (filter === "all") return "No lead records returned";
  return `No ${queueTitle(filter).toLowerCase()} records returned`;
}

function triageTone(status: string | null): string {
  if (status === "Triaged") return "bg-ok-soft text-ok";
  if (status === "Untriaged" || status === "Unknown") return "bg-danger-soft text-danger";
  return "bg-surface-muted text-muted";
}

function estimateTone(status: string | null): string {
  if (status === "Approved") return "bg-ok-soft text-ok";
  if (status === "Needs Review" || status === "Captured") return "bg-warning-soft text-warning";
  if (status === "Rejected") return "bg-danger-soft text-danger";
  return "bg-surface-muted text-muted";
}

function quoteTone(status: string | null): string {
  if (status === "Accepted") return "bg-ok-soft text-ok";
  if (status === "Needs Review") return "bg-warning-soft text-warning";
  if (status === "Expired" || status === "Rejected") return "bg-danger-soft text-danger";
  return "bg-surface-muted text-muted";
}

function proposalTone(status: string | null): string {
  if (proposalIsPublished(status)) return "bg-ok-soft text-ok";
  if (status === "Draft" || status === "Ready") return "bg-warning-soft text-warning";
  return "bg-surface-muted text-muted";
}

function proposalIsPublished(status: string | null): boolean {
  return status === "Approved" || status === "Sent" || status === "Signed";
}

function estimateValue(
  estimate: NonNullable<SalesLead["estimate"]>,
  locale: string,
  currency: string,
): string | null {
  if (estimate.estimate_total !== null)
    return formatMoney(estimate.estimate_total, locale, currency);
  if (estimate.range_low !== null && estimate.range_high !== null) {
    return `${formatMoney(estimate.range_low, locale, currency)} to ${formatMoney(estimate.range_high, locale, currency)}`;
  }
  if (estimate.range_low !== null)
    return `From ${formatMoney(estimate.range_low, locale, currency)}`;
  if (estimate.range_high !== null)
    return `Up to ${formatMoney(estimate.range_high, locale, currency)}`;
  return null;
}

function estimateIsNonBinding(estimate: NonNullable<SalesLead["estimate"]>): boolean {
  if (estimate.status === "Captured" || estimate.status === "Needs Review") return true;
  return (
    estimate.review_required && estimate.status !== "Approved" && estimate.status !== "Rejected"
  );
}

function formatMoney(value: number, locale: string, currency: string): string {
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

function formatDate(
  value: string | null,
  locale: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(locale, options).format(parsed);
  } catch {
    return parsed.toLocaleString();
  }
}

function humanize(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}
