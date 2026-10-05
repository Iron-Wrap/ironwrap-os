import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { Status } from "../components/ui/status";
import { ErrorState } from "../components/ui/state-panel";
import { ErrorSystemDetails, SystemDetails } from "../components/ui/system-details";
import { Textarea } from "../components/ui/textarea";
import { useOnlineStatus } from "../hooks/use-online-status";
import { ApiError } from "../lib/api";
import { isRefusal, messageFor, type PlainErrorCopy } from "../lib/plain-error";
import { loadSalesLead, newCommercialLeadTriageKey, recordCommercialLeadTriage } from "./sales-api";
import type { CommercialLeadTriageInput, SalesLeadResponse } from "./sales-contracts";

export function LeadTriagePreparePage() {
  const { leadId } = useParams({ strict: false }) as { leadId?: string };
  const session = useSession();
  return (
    <RoleGuard surface="sales">
      <LeadTriagePrepareContent
        key={`${session.tenant.id}:${session.user.id}:${leadId}`}
        leadId={leadId}
      />
    </RoleGuard>
  );
}

function LeadTriagePrepareContent({ leadId }: { leadId?: string }) {
  const session = useSession();
  const online = useOnlineStatus();
  const offline = isOfflineSession(session) || !online;
  const navigate = useNavigate();
  const client = useQueryClient();
  const active = useRef(true);
  const saving = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: ["sales-lead", session.tenant.id, session.user.id, leadId],
    queryFn: () => loadSalesLead(leadId!),
    enabled: Boolean(leadId),
    retry: false,
    refetchOnMount: "always",
  });
  const submission = useRef<{ key: string; input: CommercialLeadTriageInput } | undefined>(
    undefined,
  );
  const [lifecycleStatus, setLifecycleStatus] =
    useState<CommercialLeadTriageInput["lifecycleStatus"]>();
  const [priority, setPriority] = useState<CommercialLeadTriageInput["priority"]>("normal");
  const [category, setCategory] = useState("");
  const [summary, setSummary] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [actionError, setActionError] = useState<{ text: string; error: unknown }>();
  const [readRequired, setReadRequired] = useState(false);
  const mutation = useMutation({
    retry: false,
    mutationFn: () => {
      const saved = submission.current;
      if (!saved) throw new Error("lead_submission_unavailable");
      return recordCommercialLeadTriage(session, saved.input, saved.key);
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["sales"] }),
        client.invalidateQueries({
          queryKey: ["sales-lead", session.tenant.id, session.user.id, leadId],
        }),
        client.invalidateQueries({ queryKey: ["now"] }),
      ]);
      if (active.current) await navigate({ to: "/sales" });
    },
    onError: (error) => {
      if (!active.current) return;
      setReadRequired(true);
      setActionError({ text: messageFor(error, triageRefusals), error });
    },
    onSettled: () => {
      saving.current = false;
    },
  });

  async function refresh() {
    if (query.isFetching || mutation.isPending) return;
    const result = await query.refetch();
    if (!result.isSuccess || result.data.lead.id !== leadId) return;
    submission.current = undefined;
    setReadRequired(false);
    setActionError(undefined);
  }

  if (!leadId)
    return (
      <ErrorState
        title="This lead link is incomplete"
        message="Return to Sales and choose a lead."
      />
    );
  if (!query.data && query.isPending) return <LeadReviewSkeleton />;
  if (!query.data)
    return (
      <ErrorState
        title="Lead unavailable"
        message="Reconnect and check this lead before continuing."
        onRetry={() => void query.refetch()}
      />
    );
  if (query.data.lead.id !== leadId)
    return (
      <ErrorState
        title="This is not the requested lead"
        message="Return to Sales and reopen the lead. No review can be saved from this response."
      />
    );

  const { lead, intake } = query.data;
  const eligible =
    ["Untriaged", "Triaged"].includes(lead.triage.status ?? "") &&
    query.data.allowed_actions.includes("commercial.lead_triage.record");
  // A read may confirm the previous Needs-more-information save. That does not authorize
  // changing its outcome to Qualified; the reviewer must choose the next decision.
  const outcome =
    lead.triage.status === "Triaged" && (!lifecycleStatus || lifecycleStatus === "triaged")
      ? undefined
      : (lifecycleStatus ?? "triaged");
  const canRecord =
    eligible &&
    !offline &&
    query.isSuccess &&
    !query.isFetching &&
    !readRequired &&
    !mutation.isPending;
  const valid =
    Boolean(outcome) &&
    category.trim().length >= 2 &&
    summary.trim().length >= 1 &&
    nextAction.trim().length >= 1;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRecord || !valid || !outcome || saving.current) return;
    saving.current = true;
    submission.current = {
      key: newCommercialLeadTriageKey(),
      input: {
        leadId: lead.id,
        expectedLeadVersion: lead.triage.version,
        lifecycleStatus: outcome,
        priority,
        category: category.trim(),
        summary: summary.trim(),
        nextAction: nextAction.trim(),
      },
    };
    setActionError(undefined);
    mutation.mutate();
  }

  return (
    <section className="max-w-6xl space-y-6 pb-6">
      <PageHeader
        title="Lead review"
        back={
          <Link to="/sales" className="inline-flex min-h-11 items-center gap-1.5 rounded-md">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to Sales
          </Link>
        }
        meta={
          <>
            <span>{lead.contact.display_name ?? "Name unavailable"}</span>
            <Status kind={eligible ? "attention" : "neutral"}>
              {lead.triage.status ?? "Status unavailable"}
            </Status>
          </>
        }
        actions={
          <Button
            type="button"
            variant="outline"
            aria-busy={query.isFetching}
            aria-disabled={query.isFetching || mutation.isPending}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
            Refresh lead
          </Button>
        }
      />
      {offline ? (
        <Notice tone="warning" title="Reconnect to save this review">
          Reviews are never queued offline. Reconnect and refresh this lead before saving.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="This lead could not be refreshed">
          The last saved details remain visible. Refresh successfully before saving a review.
        </Notice>
      ) : null}
      {query.isFetching ? (
        <Notice tone="info" title="Checking the current lead">
          Saving stays locked until this read finishes.
        </Notice>
      ) : null}
      {actionError && notSaved(actionError.error) ? (
        // The office said no before saving anything, and its sentence already names the next step.
        <Notice tone="danger" title="The review was not saved">
          <p>{actionError.text}</p>
          <p className="mt-2">Your notes remain here.</p>
          <ErrorSystemDetails error={actionError.error} />
        </Notice>
      ) : actionError ? (
        // No answer came back, so the review may already be saved: check before saving again.
        <Notice tone="danger" title="Check the saved review">
          <p>{actionError.text}</p>
          <p className="mt-2">
            Your notes remain here. Refresh the lead to check its saved state before starting
            another review.
          </p>
          <ErrorSystemDetails error={actionError.error} />
        </Notice>
      ) : null}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <LeadContext data={query.data} />
          {eligible ? (
            <form
              className="overflow-hidden rounded-xl border border-border bg-surface"
              onSubmit={submit}
            >
              <div className="space-y-5 p-5 sm:p-7">
                <div>
                  <h2 className="text-lg font-semibold">Your review</h2>
                  <p className="mt-1 text-sm text-muted">
                    Your interpretation, kept separate from what the person said.
                  </p>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="grid gap-2 text-sm font-medium">
                    Kind of work
                    <Input
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      disabled={!canRecord}
                      minLength={2}
                      maxLength={80}
                      required
                      placeholder="For example: roofing"
                    />
                  </label>
                  <label className="grid gap-2 text-sm font-medium">
                    Priority
                    <select
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as typeof priority)}
                      disabled={!canRecord}
                      className="min-h-11 w-full rounded-lg border border-border-strong bg-surface px-3 text-base"
                    >
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </label>
                </div>
                <div className="grid gap-2 text-sm font-medium">
                  <label htmlFor="lead-review-summary">Summary for the next person</label>
                  <Textarea
                    id="lead-review-summary"
                    aria-describedby="lead-review-summary-hint"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    disabled={!canRecord}
                    maxLength={2000}
                    rows={4}
                    required
                  />
                  <span id="lead-review-summary-hint" className="text-xs font-normal text-muted">
                    What the job is, anything unusual, and what is still unknown.
                  </span>
                </div>
              </div>
              <div className="space-y-5 border-t border-border p-5 sm:p-7">
                <fieldset disabled={!canRecord} className="space-y-3">
                  <legend className="mb-3 text-sm font-semibold">Review outcome</legend>
                  {!outcome ? (
                    <p className="text-sm text-muted">
                      Choose an outcome for this review before saving.
                    </p>
                  ) : null}
                  {lead.triage.status !== "Triaged" ? (
                    <Outcome
                      value="triaged"
                      selected={outcome}
                      onChange={setLifecycleStatus}
                      title="Needs more information"
                      description="Keep the lead open for a qualification decision."
                    />
                  ) : null}
                  <Outcome
                    value="qualified"
                    selected={outcome}
                    onChange={setLifecycleStatus}
                    title="Qualified"
                    description="The lead is ready for the next internal step."
                  />
                  <Outcome
                    value="disqualified"
                    selected={outcome}
                    onChange={setLifecycleStatus}
                    title="Decline this work"
                    description="Keep the reason in the review. No message is sent."
                  />
                </fieldset>
                <div className="grid gap-2 text-sm font-medium">
                  <label htmlFor="lead-review-next-action">Next internal action</label>
                  <Input
                    id="lead-review-next-action"
                    aria-describedby="lead-review-next-action-hint"
                    value={nextAction}
                    onChange={(e) => setNextAction(e.target.value)}
                    disabled={!canRecord}
                    maxLength={500}
                    required
                    placeholder="For example: request a site inspection"
                  />
                  <span
                    id="lead-review-next-action-hint"
                    className="text-xs font-normal text-muted"
                  >
                    A handoff note. This does not book a visit or create an estimate.
                  </span>
                </div>
              </div>
              <footer className="flex flex-wrap items-center gap-3 border-t border-border p-5 sm:px-7">
                <Button type="submit" busy={mutation.isPending} disabled={!canRecord || !valid}>
                  Save lead review
                </Button>
                <span className="text-sm text-muted">
                  Saves your review; no customer message is sent.
                </span>
              </footer>
            </form>
          ) : (
            <Notice tone="info" title="Review is not available">
              This lead is already decided, or your current access does not allow a review. The
              saved details are shown above.
            </Notice>
          )}
        </div>
        <aside className="min-w-0 space-y-5">
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold">Next step</h2>
            <p className="mt-2 text-sm leading-6">
              {eligible
                ? "Review what they need, record the outcome, and leave a clear handoff."
                : "Continue from the saved lead on the Sales desk."}
            </p>
            {lead.job && query.data.permissions.includes("estimator:read") ? (
              <Button asChild variant="outline" className="mt-4">
                <Link to="/estimator/jobs/$jobId" params={{ jobId: lead.job.id }}>
                  Open estimate workspace
                </Link>
              </Button>
            ) : null}
          </section>
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold">Saved review</h2>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
              {lead.triage.summary ?? "No review summary recorded yet."}
            </p>
          </section>
          <SystemDetails className="rounded-xl border border-border bg-surface px-5 pb-2">
            <dl className="mt-1 space-y-3 pb-3 text-sm">
              <Fact label="Lead record">{lead.id}</Fact>
              <Fact label="Source envelope">{lead.envelope_id}</Fact>
              <Fact label="Version">{lead.triage.version}</Fact>
              <Fact label="Received">{lead.received_at ?? "Not recorded"}</Fact>
              {intake?.email_consent.status === "granted" ? (
                <Fact label="Email permission recorded">
                  {intake.email_consent.recorded_at ?? "Time unavailable"}
                </Fact>
              ) : null}
            </dl>
          </SystemDetails>
        </aside>
      </div>
    </section>
  );
}

function LeadContext({ data }: { data: SalesLeadResponse }) {
  const { lead, intake } = data;
  const property = intake
    ? [intake.address, intake.city, intake.province, intake.postal_code].filter(Boolean).join(", ")
    : "";
  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-surface"
      aria-label="Lead context"
    >
      <div className="space-y-4 p-5 sm:p-7">
        <h2 className="text-lg font-semibold">What they told us</h2>
        <p className="whitespace-pre-wrap break-words rounded-lg bg-surface-muted p-4 text-sm leading-6">
          {intake?.message ?? "Their original request is not available in this view."}
        </p>
        <dl className="space-y-3 text-sm">
          <Fact label="Request">{intake?.service ?? "Not recorded"}</Fact>
          <Fact label="Property">{property || "Not recorded"}</Fact>
        </dl>
      </div>
      <div className="space-y-4 border-t border-border p-5 sm:p-7">
        <h2 className="text-lg font-semibold">Contact</h2>
        <dl className="space-y-3 text-sm">
          <Fact label="Name">{lead.contact.display_name ?? "Not recorded"}</Fact>
          <Fact label="Phone">{lead.contact.phone ?? "Not recorded"}</Fact>
          <Fact label="Email">{lead.contact.email ?? "Not recorded"}</Fact>
          <Fact label="Prefers">
            {intake?.preferred_contact_channel === "phone"
              ? "Phone"
              : intake?.preferred_contact_channel === "email"
                ? "Email"
                : "No preference recorded"}
          </Fact>
          <Fact label="Source">
            {intake?.intake_source === "walk_in"
              ? "Walk-in"
              : intake?.intake_source === "phone"
                ? "Phone call"
                : intake?.intake_source === "referral"
                  ? "Referral"
                  : (lead.source ?? "Not recorded")}
          </Fact>
          <Fact label="Email permission">
            {intake?.email_consent.status === "granted"
              ? "Estimate follow-up only"
              : lead.consent.context === "recorded" && lead.consent.records.length
                ? "Recorded permissions are available on the Sales desk."
                : "Not recorded"}
          </Fact>
        </dl>
      </div>
    </section>
  );
}
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}
function Outcome({
  value,
  selected,
  onChange,
  title,
  description,
}: {
  value: CommercialLeadTriageInput["lifecycleStatus"];
  selected: CommercialLeadTriageInput["lifecycleStatus"] | undefined;
  onChange: (value: CommercialLeadTriageInput["lifecycleStatus"]) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border-strong p-3 has-[:checked]:border-foreground has-[:checked]:bg-surface-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
      <input
        type="radio"
        name="review-outcome"
        value={value}
        checked={selected === value}
        onChange={() => onChange(value)}
        className="mt-0.5 size-4 shrink-0 accent-foreground"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm leading-5 text-muted">{description}</span>
      </span>
    </label>
  );
}
function LeadReviewSkeleton() {
  return (
    <section aria-busy="true" aria-label="Loading lead review" className="max-w-6xl space-y-6">
      <div className="h-24 rounded-lg bg-surface-muted" />
      <div className="h-80 rounded-xl bg-surface-muted" />
    </section>
  );
}
const leadChanged =
  "This lead changed while you were reviewing it. Refresh the lead before you save again.";
const policyUnavailable = "The review policy is unavailable. Ask an owner to check the setup.";
const policyCodes = [
  "commercial_policy_missing",
  "commercial_policy_invalid",
  "commercial_policy_inactive",
];

/**
 * True when the review is known not to be saved: a refusal, or a policy the server could not load
 * (it answers 503 before it writes anything). Anything else may have saved it.
 */
function notSaved(error: unknown): boolean {
  return isRefusal(error) || (error instanceof ApiError && policyCodes.includes(error.code));
}

const unconfirmed = "The save result was not confirmed. The review may already have been recorded.";

/**
 * People-written words for the refusals this screen knows. A refusal it has no code for was not
 * recorded. Anything else, a lost connection included, stays unconfirmed: the review may have
 * been recorded before the answer was lost.
 */
const triageRefusals: PlainErrorCopy = {
  byCode: {
    commercial_triage_version_conflict: leadChanged,
    commercial_permit_idempotency_conflict: leadChanged,
    commercial_triage_idempotency_conflict: leadChanged,
    commercial_policy_missing: policyUnavailable,
    commercial_policy_invalid: policyUnavailable,
    commercial_policy_inactive: policyUnavailable,
    network_error: unconfirmed,
    timeout: unconfirmed,
    // A success answer this app could not read: the review may well be saved.
    invalid_json: unconfirmed,
    invalid_response: unconfirmed,
  },
  refused:
    "The review was not accepted as entered. Check the details, then refresh the lead and save again.",
  fallback: unconfirmed,
};
