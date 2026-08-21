import { useQuery } from "@tanstack/react-query";
import { CircleGauge, RefreshCw } from "lucide-react";
import { lazy, Suspense, useId } from "react";

import type { AuthenticatedSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import { loadNow } from "./now-api";
import type { NowAction, NowCard, NowResponse, QuickBooksNowCard } from "./now-contracts";

type NowCitation = NowCard["citations"][number];

const FieldTodayPage = lazy(async () => ({
  default: (await import("../field/today-page")).TodayPage,
}));

const cardTone = {
  critical: "border-danger/35 border-l-danger bg-danger-soft",
  warning: "border-warning/35 border-l-warning bg-warning-soft",
  neutral: "border-border border-l-border bg-surface-raised",
  positive: "border-ok/35 border-l-ok bg-ok-soft",
} as const;

const quickBooksCardTone: Record<QuickBooksNowCard["tone"], string> = {
  attention: "border-warning/35 border-l-warning bg-warning-soft",
  blocked: "border-warning/35 border-l-warning bg-surface-muted",
  critical: "border-danger/35 border-l-danger bg-danger-soft",
  muted: "border-border border-l-border bg-surface-muted",
};

const sourceLabel: Record<NowResponse["sources"][number]["id"], string> = {
  owner: "Owner work",
  postiz: "Marketing",
  facet: "Facet designs",
  sales: "Sales",
  production: "Jobs",
  quickbooks_final_invoices: "Invoices",
};

const sourceStateLabel: Record<NowResponse["sources"][number]["state"], string> = {
  current: "Ready",
  limited: "Needs a check",
  unavailable: "Not found",
};

export function NowPage() {
  const session = useSession();
  if (session.user.role === "field") {
    return (
      <Suspense fallback={<LoadingState label="Loading assigned work…" />}>
        <FieldTodayPage />
      </Suspense>
    );
  }
  return <OfficeNowPage session={session} />;
}

function OfficeNowPage({ session }: { session: AuthenticatedSession }) {
  const query = useQuery({
    queryKey: ["now", session.tenant.id, session.user.id],
    queryFn: () => loadNow(),
  });
  const model = query.data;

  if (!model && query.isPending) return <LoadingState label="Loading your work…" />;
  if (!model && query.isError) {
    return (
      <ErrorState
        title="Your work did not load"
        message="Check your link and try again. No work was changed."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!model) return <LoadingState label="Loading your work…" />;
  if (model.role !== session.user.role) {
    return (
      <ErrorState
        title="Sign in again"
        message="This work is for a different job role. Sign in again before you make a choice."
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <NowScreen
      model={model}
      locale={session.tenant.locale}
      timeZone={session.tenant.time_zone}
      refreshing={query.isFetching}
      refreshFailed={query.isError}
      onRefresh={() => void query.refetch()}
    />
  );
}

function NowScreen({
  model,
  locale,
  timeZone,
  refreshing,
  refreshFailed,
  onRefresh,
}: {
  model: NowResponse;
  locale: string;
  timeZone: string;
  refreshing: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
}) {
  const generatedAt = formatDateTime(model.read_model_generated_at, locale, timeZone);
  const primaryCitations = model.ui.primary_action
    ? citationsForAction(
        model.ui.primary_action,
        model.ui.sections.flatMap((section) => section.cards.flatMap((card) => card.citations)),
      )
    : [];

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-4">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <CircleGauge className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                  Work list
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  {model.ui.title}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  {model.ui.explanation}
                </p>
              </div>
            </div>
          </div>
          {model.ui.primary_action ? (
            <aside className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
              <p className="mb-3 text-xs font-extrabold tracking-[0.14em] text-muted uppercase">
                Next step
              </p>
              <ActionWithContext
                action={model.ui.primary_action}
                citations={primaryCitations}
                primary
                refreshing={refreshing}
                onRefresh={onRefresh}
              />
            </aside>
          ) : null}
        </header>
      </Card>

      {refreshFailed ? (
        <Card
          className="flex flex-col gap-3 border-warning/35 bg-warning-soft p-4 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <div>
            <p className="font-bold">The new list did not load</p>
            <p className="mt-1 text-sm leading-6 text-muted">
              The last saved list is still shown. Try again.
            </p>
          </div>
          <Button variant="outline" size="compact" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
        <div className="space-y-8 lg:col-start-1 lg:row-start-1">
          {model.ui.sections.map((section, sectionIndex) => (
            <section key={section.id} aria-labelledby={`now-section-${sectionIndex}`}>
              <header className="mb-4 border-l-4 border-accent pl-4 sm:pl-5">
                <h2
                  id={`now-section-${sectionIndex}`}
                  className="text-xl font-black tracking-[-0.025em] sm:text-2xl"
                >
                  {section.title}
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted">{section.summary}</p>
              </header>
              {section.cards.length > 0 ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {section.cards.map((card) => (
                    <NowCardView
                      key={card.id}
                      card={card}
                      refreshing={refreshing}
                      onRefresh={onRefresh}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>

        <aside
          className={cn(
            "rounded-xl border p-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-start-1",
            model.ui.state === "limited"
              ? "border-warning/35 bg-warning-soft"
              : "border-border bg-surface-muted/45",
          )}
          aria-labelledby="now-sync-heading"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <RefreshCw
              className={cn("mt-0.5 size-5 shrink-0", refreshing && "animate-spin")}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <h2 id="now-sync-heading" className="font-bold">
                List status
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted">{model.ui.sync_label}</p>
              <p className="mt-2 text-xs text-muted">
                {generatedAt ? `List made ${generatedAt}` : "List time not found"}
              </p>
            </div>
          </div>
          <details className="mt-5 border-t border-border pt-4">
            <summary className="cursor-pointer text-sm font-bold">System details</summary>
            <ul className="mt-2 divide-y divide-border" aria-label="Work list status">
              {model.sources.map((source) => (
                <li
                  key={source.id}
                  className="flex items-center justify-between gap-3 py-3 text-sm"
                >
                  <span className="font-medium">{sourceLabel[source.id]}</span>
                  <span
                    className={cn(
                      "shrink-0 font-bold",
                      source.state === "current"
                        ? "text-ok"
                        : source.state === "limited"
                          ? "text-warning"
                          : "text-danger",
                    )}
                  >
                    {sourceStateLabel[source.state]}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </aside>
      </div>
    </section>
  );
}

function NowCardView({
  card,
  refreshing,
  onRefresh,
}: {
  card: NowCard;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const contextId = useId();
  if ("kind" in card) return <QuickBooksNowCardView card={card} />;
  return (
    <Card className={cn("flex flex-col border-l-4 p-5 sm:p-6", cardTone[card.tone])}>
      <p className="text-xs font-bold tracking-[0.12em] text-muted uppercase">{card.eyebrow}</p>
      <h3 className="mt-2 text-xl font-black tracking-[-0.025em]">{card.title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted">{card.detail}</p>

      <div className="mt-auto pt-5">
        {card.action ? (
          <ActionWithContext
            action={card.action}
            citations={citationsForAction(card.action, card.citations)}
            contextId={contextId}
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        ) : (
          <CitationLinks citations={card.citations} />
        )}
      </div>
    </Card>
  );
}

function QuickBooksNowCardView({ card }: { card: QuickBooksNowCard }) {
  const reason = card.blocker_code
    ? humanizeBoundedCode(card.blocker_code)
    : card.rejection_reason
      ? humanizeBoundedCode(card.rejection_reason)
      : "This invoice needs a money check.";
  return (
    <Card className={cn("flex flex-col border-l-4 p-5 sm:p-6", quickBooksCardTone[card.tone])}>
      <p className="text-xs font-bold tracking-[0.12em] text-muted uppercase">{card.eyebrow}</p>
      <h3 className="mt-2 text-xl font-black tracking-[-0.025em]">{card.title}</h3>
      <p className="mt-3 text-2xl font-black tracking-[-0.03em]">{card.detail}</p>
      <dl className="mt-4 space-y-3 border-t border-current/15 pt-4 text-sm">
        <div>
          <dt className="font-semibold text-muted">Job</dt>
          <dd className="mt-1 break-all font-bold">{card.job_id}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Why</dt>
          <dd className="mt-1 font-bold">{reason}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Next step</dt>
          <dd className="mt-1 font-bold">{humanizeBoundedCode(card.next_step)}</dd>
        </div>
      </dl>
      <div className="mt-auto pt-5">
        <Button asChild variant="accent" className="w-full sm:w-auto">
          <a href={card.action.href}>{card.action.label}</a>
        </Button>
        <CitationLinks citations={card.citations} />
      </div>
    </Card>
  );
}

function ActionControl({
  action,
  describedBy,
  primary = false,
  refreshing,
  onRefresh,
}: {
  action: NowAction;
  describedBy?: string;
  primary?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const props = {
    variant: primary ? ("accent" as const) : ("outline" as const),
    size: primary ? ("default" as const) : ("compact" as const),
    fullWidth: primary,
  };

  if (action.kind === "navigate") {
    return (
      <Button asChild {...props}>
        <a href={action.href} aria-describedby={describedBy}>
          {action.label}
        </a>
      </Button>
    );
  }
  return (
    <Button {...props} busy={refreshing} onClick={onRefresh} aria-describedby={describedBy}>
      <RefreshCw aria-hidden="true" />
      {action.label}
    </Button>
  );
}

function ActionWithContext({
  action,
  citations,
  contextId: suppliedContextId,
  primary = false,
  refreshing,
  onRefresh,
}: {
  action: NowAction;
  citations: NowCitation[];
  contextId?: string;
  primary?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const generatedContextId = useId();
  const contextId = suppliedContextId ?? generatedContextId;
  const reasonId = `${contextId}-reason`;
  const citationsId = `${contextId}-citations`;
  const describedBy = citations.length > 0 ? `${reasonId} ${citationsId}` : reasonId;

  return (
    <div>
      <ActionControl
        action={action}
        describedBy={describedBy}
        primary={primary}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
      <p id={reasonId} className="mt-2 text-xs leading-5 text-muted">
        {action.reason}
      </p>
      <CitationLinks id={citationsId} citations={citations} />
    </div>
  );
}

function CitationLinks({ id, citations }: { id?: string; citations: NowCitation[] }) {
  if (citations.length === 0) return null;
  return (
    <ul id={id} className="mt-4 flex flex-wrap gap-x-4 gap-y-2" aria-label="Work records">
      {citations.map((citation) => (
        <li key={citation.id}>
          <a
            className="inline-flex min-h-11 items-center text-xs font-semibold underline underline-offset-4"
            href={citation.href}
          >
            {citation.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function citationsForAction(action: NowAction, citations: NowCitation[]): NowCitation[] {
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  return action.citation_ids.flatMap((id) => {
    const citation = byId.get(id);
    return citation ? [citation] : [];
  });
}

function formatDateTime(value: string, locale: string, timeZone: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

function humanizeBoundedCode(value: string): string {
  const text = value.replaceAll("_", " ");
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}
