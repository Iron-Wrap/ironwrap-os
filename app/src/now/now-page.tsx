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
  default: (await import("../field/field-pages")).TodayPage,
}));

const cardTone = {
  critical: "border-danger/35 bg-danger-soft",
  warning: "border-warning/35 bg-warning-soft",
  neutral: "border-border bg-surface-raised",
  positive: "border-ok/35 bg-ok-soft",
} as const;

const quickBooksCardTone: Record<QuickBooksNowCard["tone"], string> = {
  attention: "border-warning/35 bg-warning-soft",
  blocked: "border-warning/35 bg-surface-muted",
  critical: "border-danger/35 bg-danger-soft",
  muted: "border-border bg-surface-muted",
};

const sourceLabel: Record<NowResponse["sources"][number]["id"], string> = {
  owner: "Owner exceptions",
  postiz: "Marketing intent",
  facet: "Facet design reviews",
  sales: "Sales",
  production: "Production",
  quickbooks_final_invoices: "QuickBooks final invoices",
};

const sourceStateLabel: Record<NowResponse["sources"][number]["state"], string> = {
  current: "Current",
  limited: "Limited",
  unavailable: "Unavailable",
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

  if (!model && query.isPending) return <LoadingState label="Loading what needs you now…" />;
  if (!model && query.isError) {
    return (
      <ErrorState
        title="Now is unavailable"
        message="IronWrap could not load the current work. Check your connection, then try again. No work was changed."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!model) return <LoadingState label="Loading what needs you now…" />;
  if (model.role !== session.user.role) {
    return (
      <ErrorState
        title="This view needs a fresh sign-in"
        message="IronWrap received work for a different role. Refresh your session before making a decision."
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
    <section className="mx-auto max-w-6xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
              <CircleGauge className="size-5 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                {model.ui.title}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                {model.ui.explanation}
              </p>
            </div>
          </div>
          {model.ui.primary_action ? (
            <div className="sm:max-w-xs sm:text-right">
              <ActionWithContext
                action={model.ui.primary_action}
                citations={primaryCitations}
                primary
                refreshing={refreshing}
                onRefresh={onRefresh}
              />
            </div>
          ) : null}
        </div>
      </header>

      {refreshFailed ? (
        <div
          className="flex flex-col gap-3 border border-warning/35 bg-warning-soft p-4 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p className="text-sm leading-6">
            Couldn’t refresh this view. The last verified read is still shown. Check your
            connection, then try again.
          </p>
          <Button variant="outline" size="compact" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : null}

      <section
        className={cn(
          "border p-4 sm:p-5",
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
              Sync status
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">{model.ui.sync_label}</p>
            <p className="mt-1 text-xs text-muted">
              {generatedAt ? `Read generated ${generatedAt}` : "Read time unavailable"}
            </p>
          </div>
        </div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-3" aria-label="Owned source status">
          {model.sources.map((source) => (
            <li
              key={source.id}
              className="flex items-center justify-between gap-3 border-t border-border pt-2 text-sm sm:border-t-0 sm:pt-0"
            >
              <span className="font-medium">{sourceLabel[source.id]}</span>
              <span
                className={cn(
                  "font-bold",
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
      </section>

      <div className="space-y-8">
        {model.ui.sections.map((section, sectionIndex) => (
          <section key={section.id} aria-labelledby={`now-section-${sectionIndex}`}>
            <header className="mb-4">
              <h2
                id={`now-section-${sectionIndex}`}
                className="text-xl font-black tracking-[-0.025em] sm:text-2xl"
              >
                {section.title}
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted">{section.summary}</p>
            </header>
            {section.cards.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
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
    <Card className={cn("flex flex-col p-5 sm:p-6", cardTone[card.tone])}>
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
      : "Current owned records require finance attention.";
  return (
    <Card className={cn("flex flex-col p-5 sm:p-6", quickBooksCardTone[card.tone])}>
      <p className="text-xs font-bold tracking-[0.12em] text-muted uppercase">{card.eyebrow}</p>
      <h3 className="mt-2 text-xl font-black tracking-[-0.025em]">{card.title}</h3>
      <p className="mt-3 text-2xl font-black tracking-[-0.03em]">{card.detail}</p>
      <dl className="mt-4 space-y-3 border-t border-current/15 pt-4 text-sm">
        <div>
          <dt className="font-semibold text-muted">Job</dt>
          <dd className="mt-1 break-all font-bold">{card.job_id}</dd>
        </div>
        <div>
          <dt className="font-semibold text-muted">Reason</dt>
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
    <ul id={id} className="mt-4 flex flex-wrap gap-x-4 gap-y-2" aria-label="Source records">
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
