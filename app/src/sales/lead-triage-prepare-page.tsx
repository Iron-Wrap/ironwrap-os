import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, ClipboardCheck, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { ErrorState } from "../components/ui/state-panel";
import { ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { newLeadTriageApprovalPrepareKey, prepareLeadTriageApproval } from "../owner/approval-api";
import { loadSales } from "./sales-api";
import type { SalesLead } from "./sales-contracts";

export function LeadTriagePreparePage() {
  return (
    <RoleGuard surface="sales">
      <LeadTriagePrepareContent />
    </RoleGuard>
  );
}

function LeadTriagePrepareContent() {
  const { leadId } = useParams({ strict: false }) as { leadId?: string };
  const session = useSession();
  const offline = isOfflineSession(session);
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["sales", session.tenant.id, session.user.id],
    queryFn: () => loadSales(),
    retry: false,
    refetchOnMount: "always",
  });
  const prepareKey = useRef<string | undefined>(undefined);
  const [triageSummary, setTriageSummary] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [restartRequired, setRestartRequired] = useState(false);

  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const lead = query.data?.leads.find((candidate) => candidate.id === leadId);
      if (!lead) throw new Error("lead_source_unavailable");
      prepareKey.current ??= newLeadTriageApprovalPrepareKey();
      return await prepareLeadTriageApproval(
        session,
        { leadEnvelopeId: lead.id, triageSummary: triageSummary.trim() },
        prepareKey.current,
      );
    },
    onSuccess: async () => {
      await navigate({ to: "/approvals" });
    },
    onError: (error) => {
      setActionError(messageFor(error));
      if (error instanceof ApiError && error.code === "idempotency_conflict") {
        setRestartRequired(true);
      }
    },
  });

  if (!leadId) {
    return (
      <ErrorState
        title="This triage link is incomplete"
        message="No Lead Envelope was provided. Return to Sales and choose a source-backed lead."
      />
    );
  }
  if (!query.data && query.isPending) return <LeadTriagePrepareSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Sales context unavailable"
        message="No triage review was prepared. Reconnect and reopen the current Sales record before starting a human review."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <LeadTriagePrepareSkeleton />;

  const lead = query.data.leads.find((candidate) => candidate.id === leadId);
  if (
    !lead ||
    lead.triage.status !== "Untriaged" ||
    !lead.attention.includes("triage_unresolved") ||
    !query.data.allowed_actions.includes("approval.prepare")
  ) {
    return (
      <ErrorState
        title="Triage preparation is not available"
        message="IronWrap OS did not grant a local-triage review for this exact Lead Envelope. Return to Sales and inspect the current recorded state."
        action={
          <Button asChild variant="outline">
            <Link to="/sales">Back to Sales</Link>
          </Button>
        }
      />
    );
  }

  const canPrepare = !offline && query.isSuccess && !query.isFetching && !restartRequired;
  const trimmedSummary = triageSummary.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPrepare || mutation.isPending || trimmedSummary.length < 1) return;
    setActionError(undefined);
    mutation.mutate();
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/sales">
                <ArrowLeft aria-hidden="true" />
                Back to Sales
              </Link>
            </Button>
            <div className="mt-4 flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-md bg-foreground text-background">
                <ClipboardCheck className="size-5 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                  Sales preparation
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Prepare local triage
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Capture the factual internal summary needed for a human decision. This does not
                  contact the homeowner, move lead transport, or change a quote.
                </p>
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="compact"
            busy={query.isFetching}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw aria-hidden="true" />
            Refresh context
          </Button>
        </div>
      </header>

      {offline ? (
        <Notice tone="warning" title="Reconnect to prepare this review">
          Triage preparation is never queued offline. Reopen this lead after a current connection is
          available.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="Showing the last recorded Sales read.">
          Refresh this lead before preparing a review while the connection warning remains.
        </Notice>
      ) : null}
      {query.isFetching ? (
        <Notice tone="warning" title="Checking current Sales context">
          Preparation stays locked until IronWrap OS confirms that this exact Lead Envelope is still
          eligible for a local triage review.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Triage review was not prepared">
          {restartRequired ? (
            <>
              <p>{actionError}</p>
              <Button asChild variant="outline" size="compact" className="mt-3">
                <Link to="/sales">Reopen in Sales</Link>
              </Button>
            </>
          ) : (
            actionError
          )}
        </Notice>
      ) : null}

      <TriageDecisionRail lead={lead} />
      <LocalTriageFence />
      <LeadContext lead={lead} locale={session.tenant.locale} timeZone={session.tenant.time_zone} />

      <form className="border border-border bg-surface" onSubmit={submit}>
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">What should the approver know?</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Write the factual context required to mark this Lead Envelope triaged. Keep contact
            decisions, commercial promises, and outbound messages out of this note.
          </p>
        </div>
        <div className="p-5 sm:p-6">
          <label htmlFor="triage-summary" className="text-sm font-bold text-foreground">
            Internal triage summary
          </label>
          <textarea
            id="triage-summary"
            value={triageSummary}
            onChange={(event) => setTriageSummary(event.target.value.slice(0, 2_000))}
            disabled={!canPrepare || mutation.isPending}
            maxLength={2_000}
            rows={5}
            required
            placeholder="For example: Hail report received. Verify the property address, access, and preferred inspection window before any customer follow-up."
            className="mt-3 w-full resize-y rounded-lg border bg-surface-raised px-4 py-3 text-base leading-6 shadow-sm outline-none transition-colors placeholder:text-muted focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>Only this summary and the Lead Envelope identity are submitted.</span>
            <span>{triageSummary.length}/2000</span>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            A designated approver sees the broker-generated local diff before the one bounded write.
            This page never marks the lead triaged directly.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={!canPrepare || mutation.isPending || trimmedSummary.length < 1}
          >
            <ClipboardCheck aria-hidden="true" />
            Prepare triage review
          </Button>
        </div>
      </form>
    </section>
  );
}

function TriageDecisionRail({ lead }: { lead: SalesLead }) {
  return (
    <section aria-labelledby="triage-decision-path">
      <h2
        id="triage-decision-path"
        className="text-sm font-extrabold uppercase tracking-[0.14em] text-muted"
      >
        Controlled path
      </h2>
      <ol className="mt-3 grid border border-border sm:grid-cols-3">
        <RailStep label="Lead Envelope" detail={lead.id} />
        <RailStep
          label="Human decision"
          detail="Required"
          tone="bg-warning-soft text-foreground"
          bordered
        />
        <RailStep label="Hermes Run" detail="Recorded after approval" bordered />
      </ol>
    </section>
  );
}

function RailStep({
  label,
  detail,
  tone,
  bordered = false,
}: {
  label: string;
  detail: string;
  tone?: string;
  bordered?: boolean;
}) {
  return (
    <li
      className={cn(
        "min-h-24 min-w-0 px-4 py-4 sm:px-5",
        bordered && "border-t border-border sm:border-t-0 sm:border-l",
      )}
    >
      <p className="text-sm font-bold text-muted">{label}</p>
      <p
        className={cn(
          "mt-2 break-all text-sm font-bold leading-5",
          tone ? "inline-flex rounded-full px-2.5 py-1.5 text-xs" : "text-foreground",
          tone,
        )}
      >
        {detail}
      </p>
    </li>
  );
}

function LocalTriageFence() {
  return (
    <section
      className="border border-border bg-surface-muted/65 px-5 py-5 sm:px-6"
      aria-labelledby="triage-fence-heading"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="triage-fence-heading" className="font-bold tracking-[-0.015em]">
            Local triage only
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            No customer message is sent. Lead transport remains unchanged. This cannot issue a
            quote, modify commercial terms, collect payment, or change accounting.
          </p>
        </div>
      </div>
    </section>
  );
}

function LeadContext({
  lead,
  locale,
  timeZone,
}: {
  lead: SalesLead;
  locale: string;
  timeZone: string;
}) {
  const receivedAt = formatDate(lead.received_at, locale, timeZone);
  return (
    <section
      className="grid border-y border-border sm:grid-cols-2"
      aria-label="Lead triage context"
    >
      <div className="min-w-0 px-4 py-5 sm:px-5">
        <p className="text-sm font-bold text-muted">Lead</p>
        <p className="mt-2 break-words font-bold text-foreground">
          {lead.contact.display_name ?? "Name unavailable"}
        </p>
        <p className="mt-1 break-all text-sm text-muted">{lead.id}</p>
      </div>
      <div className="border-t border-border px-4 py-5 sm:border-t-0 sm:border-l sm:px-5">
        <p className="text-sm font-bold text-muted">Received context</p>
        <p className="mt-2 text-sm font-bold text-foreground">
          {humanize(lead.source) ?? "Source unavailable"}
        </p>
        <p className="mt-1 text-sm text-muted">
          {[receivedAt, lead.intent_queue].filter(Boolean).join(" · ") || "Time unavailable"}
        </p>
      </div>
      <div className="border-t border-border px-4 py-5 sm:col-span-2 sm:px-5">
        <p className="text-sm font-bold text-muted">Current triage state</p>
        <p className="mt-2 inline-flex rounded-full border border-warning/45 bg-warning-soft px-2.5 py-1 text-xs font-extrabold uppercase tracking-[0.08em] text-foreground">
          {humanize(lead.triage.status) ?? "Status unavailable"}
        </p>
        {lead.triage.summary ? (
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{lead.triage.summary}</p>
        ) : (
          <p className="mt-1 text-sm leading-6 text-muted">
            No local triage summary is recorded yet.
          </p>
        )}
      </div>
    </section>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger";
  title: string;
  children: ReactNode;
}) {
  const Icon = tone === "danger" ? TriangleAlert : RefreshCw;
  return (
    <section
      className={cn(
        "border px-5 py-4 text-sm leading-6",
        tone === "danger" ? "border-danger/40 bg-danger-soft" : "border-warning/40 bg-warning-soft",
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 size-5 shrink-0",
            tone === "danger" ? "text-danger" : "text-warning",
          )}
          aria-hidden="true"
        />
        <div>
          <p className="font-bold">{title}</p>
          <div className="mt-1 text-muted">{children}</div>
        </div>
      </div>
    </section>
  );
}

function LeadTriagePrepareSkeleton() {
  return (
    <section
      className="mx-auto max-w-5xl space-y-6"
      aria-busy="true"
      aria-label="Loading lead triage context"
    >
      <div className="h-28 border-b border-border bg-surface-muted/70" />
      <div className="grid min-h-28 border border-border bg-surface-muted/55 sm:grid-cols-3" />
      <div className="min-h-28 border border-border bg-surface-muted/55" />
      <div className="min-h-72 border border-border bg-surface-muted/55" />
    </section>
  );
}

function humanize(value: string | null): string | null {
  if (!value) return null;
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDate(value: string | null, locale: string, timeZone: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(timestamp);
}

function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "The local triage review was not confirmed. Refresh the lead and prepare a current review before trying again.";
  }
  switch (error.code) {
    case "approval_broker_not_configured":
      return "The local-triage review service is not configured. No triage change was made.";
    case "approval_broker_unavailable":
      return "The local-triage review service is unavailable. No triage change was made.";
    case "idempotency_conflict":
      return "This preparation key is already bound to a different request. Return to Sales and reopen the current Lead Envelope before preparing another review.";
    case "approval_store_unavailable":
      return "The approval ledger is unavailable. No triage change was made.";
    default:
      return "The local triage review was not confirmed. Refresh the lead before preparing another review.";
  }
}
