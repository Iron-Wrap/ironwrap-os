import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, ClipboardCheck, RefreshCw, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { ErrorState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
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
        title="This lead-check link is not complete"
        message="No lead was found in this link. Go back to Sales and choose a lead."
      />
    );
  }
  if (!query.data && query.isPending) return <LeadTriagePrepareSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Sales could not load"
        message="No lead check was started. Go online, then open this lead again."
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
        title="A lead check is not ready"
        message="IronWrap did not allow a lead check for this lead. Go back to Sales and check it."
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
    <section className="mx-auto max-w-6xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/sales">
                <ArrowLeft aria-hidden="true" />
                Back to Sales
              </Link>
            </Button>
            <div className="mt-5 flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <ClipboardCheck className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
                  Lead check
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  Ask for a lead check
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Write a short note for a person to review. This does not call the homeowner, move
                  the lead, or change a quote.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
              Next step
            </p>
            <h2 className="mt-2 text-xl font-black tracking-[-0.025em]">A person still says yes</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              A reviewer must approve this before the lead is marked as checked.
            </p>
            <Button
              type="button"
              variant="outline"
              size="compact"
              className="mt-4"
              busy={query.isFetching}
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              Load again
            </Button>
          </div>
        </header>
      </Card>

      {offline ? (
        <Notice tone="warning" title="Go online to send this request">
          Lead checks are not saved while you are offline. Open this lead again when you are online.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="Showing the last saved sales list">
          Load this lead again before you send a check.
        </Notice>
      ) : null}
      {query.isFetching ? (
        <Notice tone="warning" title="Checking this lead">
          Sending stays locked until IronWrap confirms this lead still needs a check.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The lead check was not sent">
          {restartRequired ? (
            <>
              <p>{actionError}</p>
              <Button asChild variant="outline" size="compact" className="mt-3">
                <Link to="/sales">Open in Sales</Link>
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

      <form
        className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
        onSubmit={submit}
      >
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <h2 className="text-lg font-bold tracking-[-0.02em]">What should the reviewer know?</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
            Write the facts needed to mark this lead as checked. Keep contact choices, price
            promises, and outgoing messages out of this note.
          </p>
        </div>
        <div className="p-5 sm:p-6">
          <label htmlFor="triage-summary" className="text-sm font-bold text-foreground">
            Lead-check note
          </label>
          <Textarea
            id="triage-summary"
            value={triageSummary}
            onChange={(event) => setTriageSummary(event.target.value.slice(0, 2_000))}
            disabled={!canPrepare || mutation.isPending}
            maxLength={2_000}
            rows={5}
            required
            placeholder="For example: Hail report received. Check the address, access, and preferred visit time before any follow-up."
            className="mt-3"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>Only this note is sent with the lead.</span>
            <span>{triageSummary.length}/2000</span>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted/55 p-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="max-w-xl text-sm leading-6 text-muted">
            A reviewer sees what would change before anything is saved. This page does not mark the
            lead as checked.
          </p>
          <Button
            type="submit"
            variant="accent"
            className="shrink-0"
            busy={mutation.isPending}
            disabled={!canPrepare || mutation.isPending || trimmedSummary.length < 1}
          >
            <ClipboardCheck aria-hidden="true" />
            Send for a check
          </Button>
        </div>
      </form>

      <LeadSystemDetails lead={lead} />
    </section>
  );
}

function TriageDecisionRail({ lead }: { lead: SalesLead }) {
  return (
    <section
      className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
      aria-labelledby="triage-decision-path"
    >
      <h2
        id="triage-decision-path"
        className="px-5 py-5 text-sm font-extrabold uppercase tracking-[0.14em] text-muted sm:px-6"
      >
        How this works
      </h2>
      <ol className="grid border-t border-border sm:grid-cols-3">
        <RailStep label="This lead" detail={lead.contact.display_name ?? "Saved lead"} />
        <RailStep
          label="Person review"
          detail="Needed"
          tone="bg-warning-soft text-foreground"
          bordered
        />
        <RailStep label="Saved result" detail="Written after a yes" bordered />
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
          "mt-2 break-words text-sm font-bold leading-5",
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
      className="overflow-hidden rounded-lg border border-border bg-surface-muted/65 px-5 py-5 sm:px-6"
      aria-labelledby="triage-fence-heading"
    >
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        <div>
          <h2 id="triage-fence-heading" className="font-bold tracking-[-0.015em]">
            Lead check only
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            No customer message is sent. The lead stays where it is. This cannot make a quote,
            change prices, take payment, or change money records.
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
      className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
      aria-label="Lead check context"
    >
      <div className="grid sm:grid-cols-2">
        <div className="min-w-0 px-5 py-5 sm:px-6">
          <p className="text-sm font-bold text-muted">Lead</p>
          <p className="mt-2 break-words font-bold text-foreground">
            {lead.contact.display_name ?? "Name not found"}
          </p>
        </div>
        <div className="border-t border-border px-5 py-5 sm:border-t-0 sm:border-l sm:px-6">
          <p className="text-sm font-bold text-muted">How it arrived</p>
          <p className="mt-2 text-sm font-bold text-foreground">
            {humanize(lead.source) ?? "Source not found"}
          </p>
          <p className="mt-1 text-sm text-muted">{receivedAt ?? "Time not found"}</p>
        </div>
        <div className="border-t border-border px-5 py-5 sm:col-span-2 sm:px-6">
          <p className="text-sm font-bold text-muted">Lead check now</p>
          <p className="mt-2 inline-flex rounded-full border border-warning/45 bg-warning-soft px-2.5 py-1 text-xs font-extrabold uppercase tracking-[0.08em] text-foreground">
            Not checked
          </p>
          {lead.triage.summary ? (
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">{lead.triage.summary}</p>
          ) : (
            <p className="mt-1 text-sm leading-6 text-muted">No lead-check note is saved yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function LeadSystemDetails({ lead }: { lead: SalesLead }) {
  return (
    <details className="group rounded-lg border border-border bg-surface-raised">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-bold sm:min-h-14 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span>System details</span>
        <ChevronRight
          className="size-4 text-muted transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <dl className="grid gap-3 border-t border-border px-4 py-3 text-sm text-muted sm:grid-cols-2 sm:px-5">
        <MetadataLine label="Lead ID" value={lead.id} />
        <MetadataLine label="Saved record" value={lead.envelope_id} />
        {lead.intent_queue ? <MetadataLine label="Sales path" value={lead.intent_queue} /> : null}
      </dl>
    </details>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-foreground">{label}</dt>
      <dd className="mt-0.5 break-all">{value}</dd>
    </div>
  );
}

function LeadTriagePrepareSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading this lead"
    >
      <div className="h-40 rounded-lg border border-border bg-surface-muted/70" />
      <div className="grid min-h-28 rounded-lg border border-border bg-surface-muted/55 sm:grid-cols-3" />
      <div className="min-h-28 rounded-lg border border-border bg-surface-muted/55" />
      <div className="min-h-72 rounded-lg border border-border bg-surface-muted/55" />
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
    return "We could not send this lead check. Load the lead again before you try.";
  }
  switch (error.code) {
    case "approval_broker_not_configured":
      return "The lead-check service is not set up. Nothing was changed.";
    case "approval_broker_unavailable":
      return "The lead-check service could not be reached. Nothing was changed.";
    case "idempotency_conflict":
      return "This same ask was already sent with different details. Go back to Sales and open the lead again.";
    case "approval_store_unavailable":
      return "We could not save this ask. Nothing was changed.";
    default:
      return "We could not send this lead check. Load the lead again before you try.";
  }
}
