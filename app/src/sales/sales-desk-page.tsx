import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowUpRight,
  BriefcaseBusiness,
  ChevronRight,
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
import { Card } from "../components/ui/card";
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
    label: "Lead check needed",
    tone: "bg-danger-soft text-danger",
    icon: TriangleAlert,
  },
  estimate_needs_review: {
    label: "Check estimate",
    tone: "bg-warning-soft text-warning",
    icon: FileSearch,
  },
  quote_needs_review: { label: "Check quote", tone: "bg-info-soft text-info", icon: FileText },
  quote_expired: { label: "Quote ended", tone: "bg-danger-soft text-danger", icon: Clock3 },
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
  const attentionCount = model.leads.filter((lead) => lead.attention.length > 0).length;

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <BriefcaseBusiness className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                  Sales work
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Sales desk
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Check each lead before you call or send anything. This page only reads saved sales
                  data.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
              Next step
            </p>
            <h2 className="mt-2 text-xl font-black tracking-[-0.025em]">
              {attentionCount === 0
                ? "No lead checks"
                : `${attentionCount} ${attentionCount === 1 ? "lead" : "leads"} to check`}
            </h2>
            {generatedAt ? (
              <p className="mt-2 text-sm text-muted">List made {generatedAt}</p>
            ) : null}
            {canReviewApprovals ? (
              <Button asChild variant="outline" size="compact" className="mt-5">
                <Link to="/approvals">
                  <ShieldCheck aria-hidden="true" />
                  Open lead reviews
                </Link>
              </Button>
            ) : null}
          </div>
        </header>
      </Card>

      {refreshFailed ? <RefreshWarning onRetry={onRetry} /> : null}

      <SalesSignals model={model} />

      {isBounded ? <DataBoundary model={model} /> : null}

      <div className="grid gap-7 xl:grid-cols-[13.5rem_minmax(0,1fr)] xl:items-start">
        <aside className="min-w-0 xl:sticky xl:top-28">
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
      label: "Lead checks",
      value: model.summary.triage_unresolved,
      detail: "A person must check the lead",
      tone: "text-danger",
      dot: "bg-danger",
    },
    {
      label: "Estimate checks",
      value: model.summary.estimate_needs_review,
      detail: "Price ranges that are not final",
      tone: "text-warning",
      dot: "bg-warning",
    },
    {
      label: "Quote checks",
      value: model.summary.quote_needs_review + model.summary.quote_expired,
      detail: "Quotes to check or renew",
      tone: "text-info",
      dot: "bg-info",
    },
  ];
  return (
    <Card className="overflow-hidden">
      <dl className="grid sm:grid-cols-3" aria-label="Sales work to check">
        {signals.map((signal, index) => (
          <div
            key={signal.label}
            className={cn(
              "min-h-24 px-5 py-4",
              index > 0 && "border-t border-border sm:border-t-0 sm:border-l",
            )}
          >
            <dt className="flex items-center gap-2 text-sm font-semibold text-muted">
              <span className={cn("size-2 rounded-full", signal.dot)} aria-hidden="true" />
              {signal.label}
            </dt>
            <dd className={cn("mt-2 text-2xl font-black tracking-[-0.03em]", signal.tone)}>
              {signal.value}
            </dd>
            <p className="mt-1 max-w-56 text-sm leading-5 text-muted">{signal.detail}</p>
          </div>
        ))}
      </dl>
    </Card>
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
    <Card className="overflow-hidden p-2">
      <p className="px-3 pb-2 pt-1 text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
        Show
      </p>
      <div
        className="flex gap-1 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible"
        aria-label="Sales filters"
      >
        {filters.map((filter) => (
          <button
            key={filter.id}
            type="button"
            aria-pressed={selected === filter.id}
            onClick={() => onChange(filter.id)}
            className={cn(
              "flex min-h-11 shrink-0 items-center justify-between gap-4 rounded-md px-3 text-sm font-bold transition-colors xl:w-full",
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
    </Card>
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
        message="No saved leads match this view. Try another tab."
      />
    );
  }
  return (
    <Card className="overflow-hidden" aria-labelledby="sales-queue-heading">
      <header className="flex flex-wrap items-end justify-between gap-3 p-5 sm:p-6">
        <div>
          <h2
            id="sales-queue-heading"
            className="text-xl font-black tracking-[-0.025em] text-balance sm:text-2xl"
          >
            {queueTitle(filter)}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Use the saved phone, email, estimate, quote, and contact rules. This page does not
            contact anyone.
          </p>
        </div>
        <p className="text-sm font-semibold text-muted">
          {leads.length} {leads.length === 1 ? "lead" : "leads"}
        </p>
      </header>
      <ol className="border-t border-border divide-y divide-border">
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
    </Card>
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
    <article className="bg-surface transition-colors hover:bg-surface-muted/35">
      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span>{humanize(lead.source) ?? "Source not found"}</span>
              {receivedAt ? <span>{receivedAt}</span> : null}
            </div>
            <h3 className="mt-1 text-xl font-black tracking-[-0.025em] text-balance">
              {lead.contact.display_name ?? "Unnamed lead"}
            </h3>
            {contact.length > 0 ? (
              <p className="mt-2 break-words text-sm leading-6 text-muted">{contact.join(" · ")}</p>
            ) : (
              <p className="mt-2 text-sm leading-6 text-warning">No phone or email was found.</p>
            )}
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-sm lg:justify-end">
            <StatusChip
              label={`Lead check: ${leadCheckLabel(lead.triage.status)}`}
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
          <ReviewCell label="Contact rule" last>
            <ConsentSummary consent={lead.consent} locale={locale} />
          </ReviewCell>
        </div>

        <footer className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
            {jobLabel ? <span>Job {jobLabel}</span> : <span>No job was found</span>}
            {lead.job?.service_type ? <span>{lead.job.service_type}</span> : null}
            {canOpenWorkbench && lead.job ? (
              <Link
                to="/estimator/jobs/$jobId"
                params={{ jobId: lead.job.id }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 font-bold text-foreground transition-colors hover:bg-surface-muted"
              >
                Open roof work
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            ) : null}
            {canPrepareTriage &&
            lead.triage.status === "Untriaged" &&
            lead.attention.includes("triage_unresolved") ? (
              <Link
                to="/sales/leads/$leadId/triage"
                params={{ leadId: lead.id }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 font-bold text-foreground transition-colors hover:bg-surface-muted"
              >
                <ClipboardCheck className="size-4" aria-hidden="true" />
                Start lead check
              </Link>
            ) : null}
          </div>
          <details className="group rounded-lg border border-border">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-bold [&::-webkit-details-marker]:hidden">
              <span>System details</span>
              <ChevronRight
                className="size-4 text-muted transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
            </summary>
            <dl className="grid gap-3 border-t border-border px-4 py-3 text-sm text-muted sm:grid-cols-2">
              <MetadataLine label="Lead ID" value={lead.envelope_id} />
              {lead.intent_queue ? (
                <MetadataLine label="Sales path" value={lead.intent_queue} />
              ) : null}
              {lead.job?.workflow_profile ? (
                <MetadataLine label="Work type" value={lead.job.workflow_profile} />
              ) : null}
              {lead.job?.status ? <MetadataLine label="Job state" value={lead.job.status} /> : null}
            </dl>
          </details>
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

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{value}</dd>
    </div>
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
  if (!estimate) return <p className="text-sm leading-6 text-muted">No estimate was found.</p>;
  const value = estimateValue(estimate, locale, currency);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          label={estimateStatusLabel(estimate.status)}
          tone={estimateTone(estimate.status)}
        />
        {estimateIsNonBinding(estimate) ? (
          <StatusChip label="Not final" tone="bg-warning-soft text-warning" />
        ) : null}
      </div>
      {value ? <p className="text-base font-black tracking-[-0.02em]">{value}</p> : null}
      <p className="text-sm leading-6 text-muted">
        {[estimate.service_type, estimate.confidence].filter(Boolean).join(" · ") ||
          "Details not found"}
      </p>
      {estimate.assumptions ? (
        <p className="text-sm leading-6 text-muted">Price notes: {estimate.assumptions}</p>
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
  if (!quote) return <p className="text-sm leading-6 text-muted">No quote was found.</p>;
  const value =
    quote.quote_total === null
      ? null
      : formatMoney(quote.quote_total, locale, quote.currency ?? defaultCurrency);
  const validUntil = formatDate(quote.valid_until, locale, { dateStyle: "medium" });
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip label={quoteStatusLabel(quote.status)} tone={quoteTone(quote.status)} />
        {quote.version !== null ? (
          <span className="text-xs font-bold text-muted">Version {quote.version}</span>
        ) : null}
      </div>
      {value ? <p className="text-base font-black tracking-[-0.02em]">{value}</p> : null}
      <p className="text-sm leading-6 text-muted">
        {[quote.payment_status, validUntil ? `Good until ${validUntil}` : null]
          .filter(Boolean)
          .join(" · ") || "Payment and end date not found"}
      </p>
      {quote.scope_summary ? (
        <p className="text-sm leading-6 text-muted">{quote.scope_summary}</p>
      ) : null}
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Customer view</p>
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
            label={proposalStatusLabel(proposal.status)}
            tone={proposalTone(proposal.status)}
          />
        ) : null}
        <p className="text-sm font-bold text-warning">Customer view is not known</p>
        <p className="text-sm leading-6 text-warning">
          Some quote-page data is missing. Do not say the customer can see it.
        </p>
      </div>
    );
  }
  if (!proposal) {
    return (
      <p className="mt-2 text-sm leading-6 text-warning">
        {sourcePartial
          ? "Some quote-page data is missing. Do not say the customer can see it."
          : "No customer view was found. Quote terms stay in the office."}
      </p>
    );
  }
  const published = proposal.has_published_pack === true;
  const newestIsPublished = proposalIsPublished(proposal.status);
  return (
    <div className="mt-2 space-y-1">
      <StatusChip
        label={proposalStatusLabel(proposal.status)}
        tone={proposalTone(proposal.status)}
      />
      <p className={cn("text-sm font-bold", published ? "text-ok" : "text-warning")}>
        {published ? "Customer view saved" : "Not shown to customer"}
      </p>
      <p className="text-sm leading-6 text-muted">
        {published
          ? newestIsPublished
            ? "A safe quote page can show this saved version when the customer portal is on."
            : `A safe quote page may still show the last saved version. The newest office version is ${proposalStatusLabel(proposal.status)}.`
          : "This version cannot show quote terms to the customer."}
      </p>
    </div>
  );
}

function ConsentSummary({ consent, locale }: { consent: SalesLead["consent"]; locale: string }) {
  if (consent.context === "partial") {
    return (
      <p className="text-sm leading-6 text-warning">
        Contact rules are not clear. Do not call or send a message from this page.
      </p>
    );
  }
  if (consent.records.length === 0) {
    return <p className="text-sm leading-6 text-warning">No contact rule was found.</p>;
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
                "Rule details not found"}
            </p>
          </li>
        );
      })}
      {consent.records.length > 3 ? (
        <li className="text-xs font-semibold text-muted">
          +{consent.records.length - 3} more rules
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
    <Card
      className="flex gap-3 border-warning/40 bg-warning-soft/55 p-4 text-sm leading-6"
      role="status"
    >
      <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
      <div>
        <p className="font-bold text-foreground">Some sales data is missing</p>
        <p className="mt-1 text-muted">
          {sources.length > 0
            ? `${sources.join(", ")} did not return a full list. Some totals may be low.`
            : "Some saved fields are missing. A blank value does not prove that a record is gone."}
        </p>
      </div>
    </Card>
  );
}

function RefreshWarning({ onRetry }: { onRetry: () => void }) {
  return (
    <Card
      className="flex flex-col gap-3 border-warning/40 bg-warning-soft/55 p-4 sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <div className="flex gap-3 text-sm leading-6">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        <p>
          <span className="font-bold">This may be an old sales list.</span>{" "}
          <span className="text-muted">The last load failed. Load again before you act.</span>
        </p>
      </div>
      <Button variant="outline" size="compact" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        Load again
      </Button>
    </Card>
  );
}

function SalesDeskError({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      title="Sales work could not load"
      message="Nothing changed. Check your link, then load the list again."
      onRetry={onRetry}
    />
  );
}

function SalesDeskSkeleton() {
  return (
    <section
      className="mx-auto max-w-7xl space-y-6"
      aria-busy="true"
      aria-label="Loading sales work"
    >
      <Card className="h-44 bg-surface-muted/70" />
      <Card className="grid overflow-hidden sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className={cn(
              "min-h-24 bg-surface-muted/60",
              index > 0 && "border-t border-border sm:border-t-0 sm:border-l",
            )}
          />
        ))}
      </Card>
      <div className="grid gap-7 xl:grid-cols-[13.5rem_minmax(0,1fr)]">
        <Card className="h-48 bg-surface-muted/60" />
        <Card className="h-96 bg-surface-muted/50" />
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
      label: "Needs a check",
      count: model.leads.filter((lead) => lead.attention.length > 0).length,
    },
    { id: "all", label: "All leads", count: model.summary.listed_leads },
    { id: "triage", label: "Lead checks", count: model.summary.triage_unresolved },
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
  if (filter === "all") return "All leads";
  if (filter === "triage") return "Lead checks";
  if (filter === "estimate") return "Estimate checks";
  if (filter === "quote") return "Quote checks";
  return "Needs a check";
}

function emptyQueueTitle(filter: SalesFilter): string {
  if (filter === "all") return "No leads were found";
  return `No ${queueTitle(filter).toLowerCase()} in this view`;
}

function leadCheckLabel(status: string | null): string {
  if (status === "Triaged") return "Checked";
  if (status === "Untriaged") return "Not checked";
  if (status === "Unknown") return "Not known";
  return humanize(status) ?? "Not known";
}

function estimateStatusLabel(status: string | null): string {
  if (status === "Needs Review") return "Needs a check";
  if (status === "Captured") return "Saved";
  if (status === "Rejected") return "Turned down";
  return humanize(status) ?? "Not known";
}

function quoteStatusLabel(status: string | null): string {
  if (status === "Needs Review") return "Needs a check";
  if (status === "Expired") return "Ended";
  if (status === "Rejected") return "Turned down";
  return humanize(status) ?? "Not known";
}

function proposalStatusLabel(status: string | null): string {
  return humanize(status) ?? "Not known";
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
