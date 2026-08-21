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
import { loadSales, newCommercialLeadTriageKey, recordCommercialLeadTriage } from "./sales-api";
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
  const decisionKey = useRef<string | undefined>(undefined);
  const [lifecycleStatus, setLifecycleStatus] = useState<"triaged" | "qualified" | "disqualified">(
    "triaged",
  );
  const [priority, setPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [category, setCategory] = useState("");
  const [triageSummary, setTriageSummary] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [restartRequired, setRestartRequired] = useState(false);

  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const lead = query.data?.leads.find((candidate) => candidate.id === leadId);
      if (!lead) throw new Error("lead_source_unavailable");
      decisionKey.current ??= newCommercialLeadTriageKey();
      return await recordCommercialLeadTriage(
        session,
        {
          leadId: lead.id,
          expectedLeadVersion: lead.triage.version,
          lifecycleStatus,
          priority,
          category: category.trim(),
          summary: triageSummary.trim(),
          nextAction: nextAction.trim(),
        },
        decisionKey.current,
      );
    },
    onSuccess: async () => {
      await navigate({ to: "/sales" });
    },
    onError: (error) => {
      setActionError(messageFor(error));
      if (
        error instanceof ApiError &&
        [
          "commercial_triage_version_conflict",
          "commercial_permit_idempotency_conflict",
          "commercial_triage_idempotency_conflict",
        ].includes(error.code)
      ) {
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
        message="No triage decision was recorded. Reconnect and reopen the current Sales record before continuing."
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
    !query.data.allowed_actions.includes("commercial.lead_triage.record")
  ) {
    return (
      <ErrorState
        title="Triage recording is not available"
        message="IronWrap OS did not grant the native commercial action for this exact lead and policy version. Return to Sales and inspect the current recorded state."
        action={
          <Button asChild variant="outline">
            <Link to="/sales">Back to Sales</Link>
          </Button>
        }
      />
    );
  }

  const canRecord = !offline && query.isSuccess && !query.isFetching && !restartRequired;
  const trimmedSummary = triageSummary.trim();
  const trimmedCategory = category.trim();
  const trimmedNextAction = nextAction.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !canRecord ||
      mutation.isPending ||
      trimmedCategory.length < 2 ||
      trimmedSummary.length < 1 ||
      trimmedNextAction.length < 1
    )
      return;
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
                  Commercial authority
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Record native triage
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Record the bounded internal sales decision in IronWrap OS. Policy, current lead
                  version, source evidence, and idempotency are verified before the write.
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
        <Notice tone="warning" title="Reconnect to record this decision">
          Commercial decisions are never queued offline. Reopen this lead after a current connection
          is available.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="Showing the last recorded Sales read.">
          Refresh this lead before preparing a review while the connection warning remains.
        </Notice>
      ) : null}
      {query.isFetching ? (
        <Notice tone="warning" title="Checking current Sales context">
          Recording stays locked until IronWrap OS confirms that this exact native lead version is
          still eligible under the active commercial policy.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="Triage was not recorded">
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
          <h2 className="text-lg font-bold tracking-[-0.02em]">Record the commercial decision</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Classify the lead and leave the next internal action. This does not contact the
            customer, publish a proposal, or alter payment or accounting state.
          </p>
        </div>
        <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
          <label className="text-sm font-bold text-foreground">
            Outcome
            <select
              value={lifecycleStatus}
              onChange={(event) =>
                setLifecycleStatus(event.target.value as "triaged" | "qualified" | "disqualified")
              }
              disabled={!canRecord || mutation.isPending}
              className="mt-2 w-full rounded-lg border bg-surface-raised px-3 py-3 text-base"
            >
              <option value="triaged">Triaged</option>
              <option value="qualified">Qualified</option>
              <option value="disqualified">Disqualified</option>
            </select>
          </label>
          <label className="text-sm font-bold text-foreground">
            Priority
            <select
              value={priority}
              onChange={(event) =>
                setPriority(event.target.value as "low" | "normal" | "high" | "urgent")
              }
              disabled={!canRecord || mutation.isPending}
              className="mt-2 w-full rounded-lg border bg-surface-raised px-3 py-3 text-base"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="text-sm font-bold text-foreground sm:col-span-2">
            Category
            <input
              value={category}
              onChange={(event) => setCategory(event.target.value.slice(0, 80))}
              disabled={!canRecord || mutation.isPending}
              minLength={2}
              maxLength={80}
              required
              placeholder="For example: storm damage"
              className="mt-2 w-full rounded-lg border bg-surface-raised px-4 py-3 text-base"
            />
          </label>
          <div className="sm:col-span-2">
            <label htmlFor="triage-summary" className="text-sm font-bold text-foreground">
              Internal triage summary
            </label>
            <textarea
              id="triage-summary"
              value={triageSummary}
              onChange={(event) => setTriageSummary(event.target.value.slice(0, 2_000))}
              disabled={!canRecord || mutation.isPending}
              maxLength={2_000}
              rows={5}
              required
              placeholder="For example: Hail report received. Verify the property address, access, and preferred inspection window before any customer follow-up."
              className="mt-3 w-full resize-y rounded-lg border bg-surface-raised px-4 py-3 text-base leading-6 shadow-sm outline-none transition-colors placeholder:text-muted focus:border-info disabled:cursor-not-allowed disabled:bg-surface-muted"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>
                Source evidence is derived and hashed by the server, never supplied by the browser.
              </span>
              <span>{triageSummary.length}/2000</span>
            </div>
          </div>
          <label className="text-sm font-bold text-foreground sm:col-span-2">
            Next internal action
            <input
              value={nextAction}
              onChange={(event) => setNextAction(event.target.value.slice(0, 500))}
              disabled={!canRecord || mutation.isPending}
              maxLength={500}
              required
              placeholder="For example: verify access and book inspection"
              className="mt-2 w-full rounded-lg border bg-surface-raised px-4 py-3 text-base"
            />
          </label>
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            The server issues a short-lived permit for this exact lead version, records one
            append-only decision, and rejects stale or replay-drifted requests.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={
              !canRecord ||
              mutation.isPending ||
              trimmedCategory.length < 2 ||
              trimmedSummary.length < 1 ||
              trimmedNextAction.length < 1
            }
          >
            <ClipboardCheck aria-hidden="true" />
            Record triage
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
        <RailStep label="Native lead" detail={`${lead.id} · v${lead.triage.version}`} />
        <RailStep
          label="Policy permit"
          detail="Short-lived"
          tone="bg-warning-soft text-foreground"
          bordered
        />
        <RailStep label="Decision ledger" detail="Append-only" bordered />
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
    return "The native triage decision was not confirmed. Refresh the lead before trying again.";
  }
  switch (error.code) {
    case "commercial_policy_missing":
    case "commercial_policy_invalid":
    case "commercial_policy_inactive":
      return "The native commercial policy is unavailable. No triage change was made.";
    case "commercial_triage_version_conflict":
    case "commercial_permit_idempotency_conflict":
    case "commercial_triage_idempotency_conflict":
      return "This lead changed or this submission key is bound to different facts. Return to Sales and reopen the current lead.";
    default:
      return "The native triage decision was not confirmed. Refresh the lead before trying again.";
  }
}
