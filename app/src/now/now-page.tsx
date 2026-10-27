import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { PageHeader } from "../components/ui/page-header";
import { RefTag } from "../components/ui/ref-tag";
import { Segmented, SegmentedCount } from "../components/ui/segmented";
import { Status } from "../components/ui/status";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { SystemDetails } from "../components/ui/system-details";
import { cn } from "../lib/cn";
import { OperatingIntakePanel } from "../operating-intake/operating-intake-panel";
import { formatOwnerDate } from "../owner/owner-now-utils";
import { loadNow } from "./now-api";
import type { DecisionItem, DecisionKind, NowAction, NowCard, NowResponse } from "./now-contracts";
import { decisionLabels, decisionStatus, decisionsView } from "./decision-presentation";

import "./now-page.css";

type NowCitation = NowCard["citations"][number];

const FieldTodayPage = lazy(async () => ({
  default: (await import("../field/today-page")).TodayPage,
}));

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

export function NowPage({ showDecisions = false }: { showDecisions?: boolean }) {
  const session = useSession();
  if (session.user.role === "field") {
    return (
      <Suspense fallback={<LoadingState label="Loading assigned work…" />}>
        <FieldTodayPage />
      </Suspense>
    );
  }
  return <OfficeNowPage session={session} showDecisions={showDecisions} />;
}

function OfficeNowPage({
  session,
  showDecisions,
}: {
  session: AuthenticatedSession;
  showDecisions: boolean;
}) {
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

  if (showDecisions) {
    return (
      <DecisionsNowScreen
        key={`${session.tenant.id}:${session.user.id}`}
        snapshot={query.dataUpdatedAt}
        model={model}
        locale={session.tenant.locale}
        timeZone={session.tenant.time_zone}
        offline={isOfflineSession(session)}
        refreshing={query.isFetching}
        refreshFailed={query.isError}
        onRefresh={() => void query.refetch()}
      />
    );
  }

  return (
    <NowScreen
      key={`${session.tenant.id}:${session.user.id}:${showDecisions}`}
      model={model}
      showDecisions={showDecisions}
      offline={isOfflineSession(session)}
      locale={session.tenant.locale}
      timeZone={session.tenant.time_zone}
      refreshing={query.isFetching}
      refreshFailed={query.isError}
      onRefresh={() => void query.refetch()}
    />
  );
}

function DecisionsNowScreen({
  model,
  snapshot,
  ...props
}: {
  model: NowResponse;
  snapshot: number;
  locale: string;
  timeZone: string;
  offline: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
}) {
  // Reset pages without replacing focused controls. An older in-flight page
  // remains bound to its snapshot and cannot enter the newly refreshed list.
  const [pageState, setPageState] = useState({ snapshot, decisions: model.decisions });
  if (pageState.snapshot !== snapshot) setPageState({ snapshot, decisions: model.decisions });
  const assembled = pageState.snapshot === snapshot ? pageState.decisions : model.decisions;
  const pagination = useMutation({
    retry: false,
    mutationFn: async ({ kind }: { kind: DecisionKind; snapshot: number }) => {
      const source = assembled?.sources.find((entry) => entry.kind === kind);
      const page = await loadNow(undefined, {
        source: kind,
        cursor: source?.next_cursor ?? undefined,
      });
      const next = page.decisions;
      const nextSource = next?.sources[0];
      if (
        page.role !== model.role ||
        !next ||
        !nextSource ||
        next.sources.length !== 1 ||
        nextSource.kind !== kind ||
        nextSource.state === "unavailable" ||
        nextSource.state === "retired" ||
        next.items.some((item) => item.kind !== kind)
      ) {
        throw new Error("The next requests could not be checked.");
      }
      return { source: nextSource, items: next.items };
    },
    onSuccess: (page, request) =>
      setPageState((currentState) => {
        const current = currentState.decisions;
        if (!current || currentState.snapshot !== request.snapshot) return currentState;
        const source = page.source;
        const rows = new Map(current.items.map((item) => [item.key, item]));
        for (const item of page.items) rows.set(item.key, item);
        const items = [...rows.values()];
        const sources = current.sources.map((entry) =>
          entry.kind === source.kind
            ? { ...source, loaded_count: items.filter((item) => item.kind === source.kind).length }
            : entry,
        );
        return {
          ...currentState,
          decisions: {
            ...current,
            items,
            sources,
            state: sources.some(
              (entry) => entry.state === "limited" || entry.state === "unavailable",
            )
              ? "limited"
              : items.length
                ? "ready"
                : "empty",
          },
        };
      }),
  });
  const currentPageRequest = pagination.variables?.snapshot === snapshot;
  return (
    <NowScreen
      {...props}
      model={decisionsView({ ...model, decisions: assembled })}
      showDecisions
      loadingMore={
        currentPageRequest && pagination.isPending ? pagination.variables?.kind : undefined
      }
      pageError={currentPageRequest && pagination.isError ? pagination.variables?.kind : undefined}
      onLoadMore={(kind) => {
        if (
          !(currentPageRequest && pagination.isPending) &&
          !props.refreshing &&
          !props.offline &&
          !props.refreshFailed
        )
          pagination.mutate({ kind, snapshot });
      }}
    />
  );
}

function NowScreen({
  model,
  showDecisions,
  offline,
  locale,
  timeZone,
  refreshing,
  refreshFailed,
  onRefresh,
  onLoadMore,
  loadingMore,
  pageError,
}: {
  model: NowResponse;
  showDecisions: boolean;
  offline: boolean;
  locale: string;
  timeZone: string;
  refreshing: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
  onLoadMore?: (kind: DecisionKind) => void;
  loadingMore?: DecisionKind;
  pageError?: DecisionKind;
}) {
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const wide = useWideInspector();
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const filterButtons = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const previousSelection = useRef<string | null>(null);
  const instanceId = useId();
  const inspectorId = `${instanceId}-inspector`;
  // The read model owns section meaning and order. Tone cannot tell us whether work
  // is stopped, waiting, or a decision, and loaded counts are not business totals.
  const activeFilter = model.ui.sections.some((section) => section.id === filter) ? filter : null;
  const sections = model.ui.sections.filter(
    (section) => activeFilter === null || section.id === activeFilter,
  );
  const rows = sections.flatMap((section) =>
    section.cards.map((card) => ({
      key: JSON.stringify([section.id, card.id]),
      card,
      sectionTitle: section.title,
    })),
  );
  const selected = rows.find((row) => row.key === selectedKey);
  // Forget removed work, rather than reopening its drawer if a later read includes it.
  // A guarded render-time adjustment prevents an intermediate stale selection commit.
  if (selectedKey !== null && !selected) setSelectedKey(null);
  const selectionId = selected?.key ?? null;
  useEffect(() => {
    if (previousSelection.current && !selectionId) {
      const active = document.activeElement;
      if (
        active === document.body ||
        page.current?.querySelector(".now-drawer")?.contains(active)
      ) {
        filterButtons.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    }
    previousSelection.current = selectionId;
  }, [selectionId]);
  const generatedAt = formatDateTime(model.read_model_generated_at, locale, timeZone);
  const decisionByKey = new Map(
    (showDecisions ? (model.decisions?.items ?? []) : []).map((item) => [item.key, item]),
  );
  const primaryCitations = model.ui.primary_action
    ? citationsForAction(
        model.ui.primary_action,
        model.ui.sections.flatMap((section) => section.cards.flatMap((card) => card.citations)),
      )
    : [];
  const closeDetails = () => {
    setSelectedKey(null);
    const button = selectedKey ? rowButtons.current.get(selectedKey) : undefined;
    (button ?? filterButtons.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  };
  const moveSelection = (event: KeyboardEvent<HTMLElement>) => {
    if (!wide || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (!target.closest("[data-now-select]")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDetails();
      return;
    }
    if (!["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    const focused = rows.findIndex((row) => rowButtons.current.get(row.key) === target);
    const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
    const row = rows[Math.max(0, Math.min(rows.length - 1, focused + direction))];
    if (!row) return;
    event.preventDefault();
    setSelectedKey(row.key);
    rowButtons.current.get(row.key)?.focus();
  };

  return (
    <section ref={page} className="now-page" data-view={showDecisions ? "decisions" : "work"}>
      <PageHeader
        title={model.ui.title}
        back={
          showDecisions ? (
            <a className="inline-flex min-h-11 items-center hover:text-foreground" href="/now">
              Back to Now
            </a>
          ) : undefined
        }
        meta={
          <>
            <span>{model.ui.explanation}</span>
            <span>{generatedAt ? `List made ${generatedAt}` : "List time not found"}</span>
          </>
        }
        actions={
          <>
            {showDecisions ? (
              sessionCanReviewLeads(model) ? (
                <Button asChild variant="quiet">
                  <a href="/approvals?view=leads">Lead review history</a>
                </Button>
              ) : null
            ) : model.decisions?.sources.some((source) => source.state !== "retired") ? (
              <Button asChild variant="secondary">
                <a href="/now?show=decide">
                  Decisions{" "}
                  <span
                    className="segmented-count"
                    aria-label={`${model.decisions.items.length} loaded requests`}
                  >
                    {model.decisions.items.length}
                  </span>
                </a>
              </Button>
            ) : null}
            <Button
              variant="secondary"
              aria-busy={refreshing}
              aria-disabled={refreshing}
              onClick={() => {
                if (!refreshing) onRefresh();
              }}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      >
        <div ref={filterButtons}>
          <Segmented variant="filters" label="Show work">
            <button
              type="button"
              aria-pressed={activeFilter === null}
              onClick={() => {
                setFilter(null);
                setSelectedKey(null);
              }}
            >
              {showDecisions ? "All requests" : "All work"}{" "}
              <SegmentedCount>
                {model.ui.sections.reduce((count, section) => count + section.cards.length, 0)}
              </SegmentedCount>
            </button>
            {model.ui.sections.map((section) => (
              <button
                key={section.id}
                type="button"
                aria-pressed={activeFilter === section.id}
                onClick={() => {
                  setFilter(section.id);
                  setSelectedKey(null);
                }}
              >
                {section.title} <SegmentedCount>{section.cards.length}</SegmentedCount>
              </button>
            ))}
          </Segmented>
        </div>
      </PageHeader>

      {model.ui.primary_action ? (
        <div className="now-next-step">
          <p className="font-semibold">Next step</p>
          <ActionWithContext
            action={model.ui.primary_action}
            citations={primaryCitations}
            primary
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        </div>
      ) : null}

      {showDecisions && offline ? (
        <div className="now-refresh-error" role="status">
          <div>
            <p className="font-semibold">You are viewing a saved list</p>
            <p className="mt-1 text-sm">Go online and refresh before reviewing a request.</p>
          </div>
        </div>
      ) : null}

      {showDecisions && model.ui.state === "limited" ? (
        <div className="now-refresh-error" role="status">
          <div>
            <p className="font-semibold">The decisions list is incomplete</p>
            <p className="mt-1 text-sm">{model.ui.sync_label}</p>
          </div>
        </div>
      ) : null}

      {refreshFailed ? (
        <div className="now-refresh-error" role="alert">
          <div>
            <p className="font-semibold">The new list did not load</p>
            <p className="mt-1 text-sm">The last saved list is still shown. Try again.</p>
          </div>
          <Button variant="secondary" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </div>
      ) : null}

      <div className="now-workspace">
        <div className="now-work-list" onKeyDown={moveSelection}>
          {sections.map((section, sectionIndex) => (
            <section key={section.id} aria-labelledby={`${instanceId}-section-${sectionIndex}`}>
              <header className="now-section-heading">
                <h2 id={`${instanceId}-section-${sectionIndex}`}>
                  {section.title} <span className="segmented-count">{section.cards.length}</span>
                </h2>
                <p>{section.summary}</p>
              </header>
              {section.cards.length ? (
                <ul className="now-rows" aria-label={section.title}>
                  {section.cards.map((card) => {
                    const key = JSON.stringify([section.id, card.id]);
                    return (
                      <NowRow
                        key={key}
                        card={card}
                        decision={decisionByKey.get(card.id)}
                        selected={selected?.key === key}
                        inspectorId={wide ? inspectorId : undefined}
                        drawer={!wide}
                        onSelect={() => setSelectedKey(key)}
                        register={(button) => {
                          if (button) rowButtons.current.set(key, button);
                          else rowButtons.current.delete(key);
                        }}
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                      />
                    );
                  })}
                </ul>
              ) : (
                <p className="now-empty">
                  {showDecisions &&
                  model.decisions?.sources.find((source) => source.kind === section.id)?.state ===
                    "unavailable"
                    ? "Requests could not be checked. Refresh to try again."
                    : "No items in this loaded section."}
                </p>
              )}
              {showDecisions && onLoadMore
                ? model.decisions?.sources
                    .filter(
                      (source) =>
                        source.kind === section.id &&
                        (source.next_cursor || source.state === "unavailable"),
                    )
                    .map((source) => (
                      <div key={source.kind} className="mt-3 grid justify-items-start gap-2">
                        {pageError === source.kind ? (
                          <p role="alert" className="text-sm text-warning">
                            The next requests did not load. The list is still incomplete. Try again.
                          </p>
                        ) : null}
                        <Button
                          variant="secondary"
                          busy={loadingMore === source.kind}
                          disabled={Boolean(loadingMore) || refreshing || offline || refreshFailed}
                          onClick={() => onLoadMore(source.kind)}
                        >
                          {source.state === "unavailable"
                            ? `Retry ${decisionLabels[source.kind].toLowerCase()}`
                            : `Load more ${decisionLabels[source.kind].toLowerCase()}`}
                        </Button>
                      </div>
                    ))
                : null}
            </section>
          ))}
          {sections.length === 0 ? (
            <p className="now-empty">
              {showDecisions && !model.decisions
                ? "Refresh to load decision sources."
                : "No items in this loaded list."}
            </p>
          ) : null}
        </div>

        <div className="now-sidebar">
          {wide ? (
            <aside
              id={inspectorId}
              className="now-inspector"
              aria-label={selected ? "Selected item" : "Work overview"}
            >
              {selected ? (
                <>
                  <header className="now-inspector-heading">
                    <span>{selected.sectionTitle}</span>
                    <Button
                      variant="quiet"
                      size="icon"
                      aria-label="Close details"
                      onClick={closeDetails}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </header>
                  <h2>{selected.card.title}</h2>
                  <NowCardDetails
                    card={selected.card}
                    decision={decisionByKey.get(selected.card.id)}
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                  />
                </>
              ) : (
                <>
                  <h2>Work in this view</h2>
                  <p>
                    {rows.length} {rows.length === 1 ? "item" : "items"} in this loaded list. Select
                    an item to see its details here.
                  </p>
                  <p className="now-keyboard-hint">
                    J / K or arrow keys move between rows. Enter shows details.
                  </p>
                </>
              )}
            </aside>
          ) : null}
          {!showDecisions ? <NowEvidenceSummary model={model} locale={locale} /> : null}
          <aside
            className={cn("now-list-status", model.ui.state === "limited" && "now-list-limited")}
            aria-labelledby={`${instanceId}-status`}
            aria-live="polite"
          >
            <h2 id={`${instanceId}-status`}>List status</h2>
            <p>{model.ui.sync_label}</p>
            <p className="text-xs">Counts cover this loaded list.</p>
            <SystemDetails>
              <ul className="divide-y divide-border" aria-label="Work list status">
                {showDecisions
                  ? model.decisions?.sources.map((source) => (
                      <li key={source.kind} className="py-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">{decisionLabels[source.kind]}</span>
                          <Status
                            kind={
                              source.state === "retired"
                                ? "retired"
                                : source.state === "current"
                                  ? "confirmed"
                                  : "attention"
                            }
                          >
                            {source.state === "retired"
                              ? "Retired"
                              : source.state === "current"
                                ? "Ready"
                                : source.state === "unavailable"
                                  ? "Unavailable"
                                  : "More requests"}
                          </Status>
                        </div>
                        <p className="mt-1 text-muted">
                          {source.state === "retired"
                            ? "Scheduling is handled in the production workspace."
                            : source.state === "unavailable"
                              ? "The request count is unknown."
                              : `${source.loaded_count} loaded${source.has_more ? "; the full source has more requests" : ""}.`}
                        </p>
                      </li>
                    ))
                  : model.sources.map((source) => (
                      <li
                        key={source.id}
                        className="flex items-center justify-between gap-3 py-3 text-sm"
                      >
                        <span className="font-medium">{sourceLabel[source.id]}</span>
                        <span
                          className={cn(
                            "font-semibold",
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
            </SystemDetails>
          </aside>
        </div>
      </div>

      {!showDecisions ? <OperatingIntakePanel /> : null}

      <Dialog
        open={!wide && Boolean(selected)}
        onClose={closeDetails}
        side="end"
        title={selected?.card.title ?? "Work details"}
        className="now-drawer"
      >
        {selected && !wide ? (
          <>
            {refreshFailed ? (
              <div className="now-refresh-error" role="alert">
                <p>The new list did not load. The last saved list is still shown. Try again.</p>
                <Button variant="secondary" busy={refreshing} onClick={onRefresh}>
                  Try again
                </Button>
              </div>
            ) : null}
            <NowCardDetails
              card={selected.card}
              decision={decisionByKey.get(selected.card.id)}
              refreshing={refreshing}
              onRefresh={onRefresh}
            />
          </>
        ) : null}
      </Dialog>
    </section>
  );
}

function useWideInspector() {
  const [wide, setWide] = useState(
    () => window.matchMedia?.("(min-width: 1280px)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(min-width: 1280px)");
    if (!query) return;
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

function NowRow({
  card,
  decision,
  selected,
  inspectorId,
  drawer,
  onSelect,
  register,
  refreshing,
  onRefresh,
}: {
  card: NowCard;
  decision?: DecisionItem;
  selected: boolean;
  inspectorId?: string;
  drawer: boolean;
  onSelect: () => void;
  register: (button: HTMLButtonElement | null) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const id = useId();
  return (
    <li className="now-row" data-tone={card.tone} aria-current={selected || undefined}>
      <div className="now-row-main">
        <h3>
          <button
            ref={register}
            data-now-select
            type="button"
            aria-expanded={selected}
            aria-controls={inspectorId}
            aria-haspopup={drawer ? "dialog" : undefined}
            onClick={onSelect}
          >
            {card.title}
          </button>
        </h3>
        <div className="now-row-context flex flex-wrap items-center gap-2">
          {decision ? (
            <>
              <Status kind={decisionStatus(decision).kind}>{decisionStatus(decision).label}</Status>
              {decision.job_id ? (
                <RefTag
                  id={decision.job_id}
                  className="h-auto! min-h-6 max-w-full whitespace-normal! py-1! leading-4!"
                />
              ) : null}
            </>
          ) : "kind" in card ? (
            card.job_id
          ) : (
            card.eyebrow
          )}
        </div>
        <p className="now-row-detail">{card.detail}</p>
      </div>
      <div className="now-row-action">
        {"kind" in card ? (
          <Button asChild variant="quiet" size="compact">
            <a href={card.action.href} aria-describedby={`${id}-reason`}>
              {card.action.label}
              <ArrowRight aria-hidden="true" />
            </a>
          </Button>
        ) : card.action ? (
          <ActionControl
            action={card.action}
            describedBy={`${id}-reason`}
            quiet
            refreshing={refreshing}
            onRefresh={onRefresh}
          />
        ) : (
          <Button variant="quiet" size="compact" onClick={onSelect}>
            View details
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
      <div id={`${id}-reason`} className="now-row-reason">
        {"kind" in card ? humanizeBoundedCode(card.next_step) : card.action?.reason}
        <span className="sr-only">
          {" "}
          {("kind" in card || !card.action
            ? card.citations
            : citationsForAction(card.action, card.citations)
          )
            .map((citation) => citation.label)
            .join(" ")}
        </span>
      </div>
    </li>
  );
}

function NowCardDetails({
  card,
  decision,
  refreshing,
  onRefresh,
}: {
  card: NowCard;
  decision?: DecisionItem;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="now-card-details">
      {decision ? (
        <div className="flex flex-wrap items-center gap-2">
          <Status kind={decisionStatus(decision).kind}>{decisionStatus(decision).label}</Status>
          {decision.job_id ? (
            <RefTag
              id={decision.job_id}
              className="h-auto! min-h-6 max-w-full whitespace-normal! py-1! leading-4! [overflow-wrap:anywhere]"
            />
          ) : null}
        </div>
      ) : null}
      <p>{card.detail}</p>
      {"kind" in card ? (
        <>
          <dl className="now-facts">
            <div>
              <dt>Job</dt>
              <dd>{card.job_id}</dd>
            </div>
            <div>
              <dt>Why</dt>
              <dd>
                {card.blocker_code
                  ? humanizeBoundedCode(card.blocker_code)
                  : card.rejection_reason
                    ? humanizeBoundedCode(card.rejection_reason)
                    : "This invoice needs a money check."}
              </dd>
            </div>
            <div>
              <dt>Next step</dt>
              <dd>{humanizeBoundedCode(card.next_step)}</dd>
            </div>
          </dl>
          <Button asChild>
            <a href={card.action.href}>{card.action.label}</a>
          </Button>
          <CitationLinks citations={card.citations} />
        </>
      ) : (
        <>
          <p className="text-sm text-faint">{card.eyebrow}</p>
          {card.action ? (
            <>
              <ActionWithContext
                action={card.action}
                citations={citationsForAction(card.action, card.citations)}
                refreshing={refreshing}
                onRefresh={onRefresh}
              />
              <CitationLinks
                citations={card.citations.filter(
                  (citation) => !card.action!.citation_ids.includes(citation.id),
                )}
              />
            </>
          ) : (
            <CitationLinks citations={card.citations} />
          )}
          {!card.action && card.citations.length === 0 ? (
            <p className="text-sm text-muted">
              No action or linked work record is available for this item.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function sessionCanReviewLeads(model: NowResponse) {
  return model.role === "owner" || model.role === "ops";
}

function NowEvidenceSummary({ model, locale }: { model: NowResponse; locale: string }) {
  const invoices = [
    ...new Map(
      model.ui.sections
        .flatMap((section) => section.cards)
        .filter((card) => "kind" in card && card.kind === "quickbooks_final_invoice")
        .map((card) => [card.id, card] as const),
    ).values(),
  ];
  const invoiceCents = invoices.reduce((sum, card) => {
    if (!("kind" in card)) return sum;
    const [whole, fraction] = card.final_balance.split(".");
    return sum + Number(whole) * 100 + Number(fraction);
  }, 0);
  const proposalSources = model.decisions?.sources.filter(
    (source) => source.kind === "quote_revision" || source.kind === "proposal_publication",
  );
  const proposals =
    model.decisions?.items.filter(
      (item) => item.kind === "quote_revision" || item.kind === "proposal_publication",
    ) ?? [];
  const proposalsUnknown =
    new Set(proposalSources?.map((source) => source.kind)).size < 2 ||
    proposalSources?.some(
      (source) => source.state === "unavailable" || source.state === "limited" || source.has_more,
    );
  const moneySource = model.sources.find((source) => source.id === "quickbooks_final_invoices");

  return (
    <aside className="now-evidence-summary" aria-label="Handoffs and evidence">
      <section aria-labelledby="now-handoffs-heading">
        <h2 id="now-handoffs-heading">Handoffs in this list</h2>
        <p className="mt-1 text-sm text-muted">The next step is shown with each work record.</p>
        <dl className="mt-3 divide-y divide-border-soft">
          {model.ui.sections.map((section) => (
            <div key={section.id} className="flex items-center justify-between gap-3 py-2">
              <dt className="min-w-0 break-words text-sm">{section.title}</dt>
              <dd className="shrink-0 font-mono text-sm">{section.cards.length}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section aria-labelledby="now-money-heading">
        <h2 id="now-money-heading">Invoice balances to review</h2>
        {invoices.length ? (
          <>
            <p className="mt-2 font-mono text-lg font-semibold">
              {new Intl.NumberFormat(locale, {
                style: "currency",
                currency: "CAD",
                currencyDisplay: "code",
              }).format(invoiceCents / 100)}
            </p>
            <p className="mt-1 text-sm text-muted">
              {invoices.length} loaded{" "}
              {invoices.length === 1 ? "invoice balance" : "invoice balances"}. This is not total
              receivables.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {!moneySource
              ? "Money amounts are not included in this work list."
              : moneySource.state === "current"
                ? "No invoice balances in the loaded list."
                : "Invoice balances could not be fully checked."}
          </p>
        )}
        {invoices.length && moneySource?.state !== "current" ? (
          <p className="mt-2 text-sm text-warning">The invoice source is incomplete.</p>
        ) : null}
      </section>
      <section aria-labelledby="now-verdicts-heading">
        <h2 id="now-verdicts-heading">Proposal verdicts</h2>
        <p className="mt-1 text-sm text-muted">
          Open review and result-check requests. Job records show matching approvals from the loaded
          records; older receipts may be absent. Agent authorship is not recorded in this list.
        </p>
        {proposals.length ? (
          <ul className="mt-3 grid gap-3" aria-label="Loaded proposal verdicts">
            {proposals.slice(0, 3).map((item) => (
              <li key={item.key} className="grid gap-1">
                <a
                  className="inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
                  href={item.review_href}
                >
                  {item.title}
                </a>
                <Status kind={decisionStatus(item).kind}>{decisionStatus(item).label}</Status>
                <p className="text-xs text-muted">
                  Updated {formatOwnerDate(item.updated_at, { locale })}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {proposalsUnknown
              ? "Proposal verdicts are unavailable or incomplete."
              : "No open proposals in the loaded list."}
          </p>
        )}
        {proposals.length > 3 || proposalsUnknown ? (
          <p className="mt-2 text-sm text-muted">
            Check Decisions for the available sources and remaining requests.
          </p>
        ) : null}
      </section>
    </aside>
  );
}

function ActionControl({
  action,
  describedBy,
  primary = false,
  quiet = false,
  refreshing,
  onRefresh,
}: {
  action: NowAction;
  describedBy?: string;
  primary?: boolean;
  quiet?: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const props = {
    variant: primary ? ("accent" as const) : quiet ? ("quiet" as const) : ("outline" as const),
    size: primary ? ("default" as const) : ("compact" as const),
    fullWidth: primary,
  };

  if (action.kind === "navigate") {
    return (
      <Button asChild {...props}>
        <a href={action.href} aria-describedby={describedBy}>
          {action.label === "Open stop" ? "Review work stop" : action.label}
          {quiet ? <ArrowRight aria-hidden="true" /> : null}
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
