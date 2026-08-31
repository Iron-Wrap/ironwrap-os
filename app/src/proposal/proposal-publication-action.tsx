import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, RefreshCw, Send } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { CapabilityUnavailable } from "../capabilities/capability-unavailable";
import {
  capabilityHasNotice,
  capabilityPreventsUse,
  useCapability,
} from "../capabilities/capability-signal";
import { Button } from "../components/ui/button";
import { NoAccessState } from "../components/ui/state-panel";
import { cn } from "../lib/cn";
import {
  approveProposalPublication,
  loadProposalPublicationApprovals,
  newProposalPublicationDecisionKey,
  newProposalPublicationPrepareKey,
  prepareProposalPublication,
  rejectProposalPublication,
} from "./proposal-publication-api";
import type { ProposalPublicationApprovalRequest } from "./proposal-publication-contracts";

/**
 * The owner-facing door onto proposal publication.
 *
 * An owner could already issue a customer portal link from this page but could
 * not publish the proposal that link is meant to show: publication existed only
 * as an owner-operator MCP command. This surface performs exactly that bounded
 * command through the same signed dry-run/approval receipts, in two deliberate
 * taps — prepare, then confirm what the customer will see.
 */
export function ProposalPublicationAction({
  roofJobId,
  proposalEvidencePackId,
  proposalStatus,
  locale,
}: {
  roofJobId: string;
  proposalEvidencePackId: string | null;
  proposalStatus: string | null;
  locale: string;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const officeRole = session.user.role === "owner" || session.user.role === "ops";
  // Two flags with two different fixes: switching publication on, and finishing the proposal
  // document template. One "not available on this runtime" string hid which one applied, and a
  // reader could not tell whether to ask for a switch or for a setup step (ELEC-234 §6.8).
  const publication = useCapability("proposal_publication");
  const template = useCapability("proposal_template");
  const publicationUnusable = capabilityPreventsUse(publication) || capabilityPreventsUse(template);
  const [failure, setFailure] = useState<string>();
  const prepareInFlight = useRef(false);
  const decideInFlight = useRef(false);

  const queryKey = [
    "proposal-publication-approvals",
    session.tenant.id,
    session.user.id,
    roofJobId,
  ] as const;
  const query = useQuery({
    queryKey,
    enabled: officeRole && !offline && Boolean(roofJobId),
    queryFn: () => loadProposalPublicationApprovals(roofJobId),
    retry: false,
  });

  const approvals = (query.data?.approvals ?? []).filter(
    (approval) => approval.roof_job_id === roofJobId,
  );
  const allowed = query.data?.allowed_actions ?? [];
  const canPrepare = allowed.includes("proposal_publication_approval.prepare");
  const canApprove = allowed.includes("proposal_publication_approval.approve");
  const pending = approvals.find(
    (approval) =>
      approval.state === "pending" && approval.proposal_evidence_pack_id === proposalEvidencePackId,
  );
  const published = approvals.find(
    (approval) =>
      approval.state === "executed" &&
      approval.proposal_evidence_pack_id === proposalEvidencePackId,
  );
  const uncertain = approvals.find((approval) => approval.state === "execution_uncertain");

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey });
    await queryClient.invalidateQueries({
      queryKey: ["estimator-workbench", session.tenant.id, session.user.id, roofJobId],
    });
  }

  const prepare = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!proposalEvidencePackId) throw new Error("proposal_evidence_pack_required");
      return await prepareProposalPublication(
        session,
        { roofJobId, proposalEvidencePackId },
        newProposalPublicationPrepareKey(),
      );
    },
    onSuccess: async () => {
      setFailure(undefined);
      await refresh();
    },
    onError: () => setFailure("prepare"),
    onSettled: () => {
      prepareInFlight.current = false;
    },
  });

  const publish = useMutation({
    retry: false,
    mutationFn: async (approval: ProposalPublicationApprovalRequest) =>
      await approveProposalPublication(
        session,
        approval.id,
        approval.version,
        newProposalPublicationDecisionKey(),
      ),
    onSuccess: async () => {
      setFailure(undefined);
      await refresh();
    },
    onError: () => setFailure("publish"),
    onSettled: () => {
      decideInFlight.current = false;
    },
  });

  const discard = useMutation({
    retry: false,
    mutationFn: async (approval: ProposalPublicationApprovalRequest) =>
      await rejectProposalPublication(
        session,
        approval.id,
        approval.version,
        "Owner cancelled the prepared publication before confirming.",
        newProposalPublicationDecisionKey(),
      ),
    onSuccess: async () => {
      setFailure(undefined);
      await refresh();
    },
    onError: () => setFailure("discard"),
    onSettled: () => {
      decideInFlight.current = false;
    },
  });

  const busy = prepare.isPending || publish.isPending || discard.isPending;

  // Rendering nothing told a crew member or an estimator that publication does not exist, rather
  // than that it is not theirs. "No access" is its own state in annex §6.1 and never collapses
  // into "no work" or "no configuration".
  if (!officeRole) {
    return (
      <section
        className="border-b border-border py-6"
        aria-labelledby="proposal-publication-heading"
      >
        <div className="px-4 sm:px-5">
          <h2 id="proposal-publication-heading" className="sr-only">
            Publish to the customer
          </h2>
          <NoAccessState
            title="Publishing to the customer is not your role"
            message="This proposal can be published to the customer link, but only an owner or operations account may do it. Nothing is missing from your account and nothing here has failed."
            nextAction="An owner or operations account publishes the reviewed proposal from this job."
            personPath="Ask your owner or operations lead to publish it once the proposal is ready."
          />
        </div>
      </section>
    );
  }

  return (
    <section className="border-b border-border py-6" aria-labelledby="proposal-publication-heading">
      <div className="px-4 sm:px-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-foreground text-background">
            <Send className="size-4 text-accent" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="proposal-publication-heading" className="text-lg font-bold tracking-[-0.02em]">
              Publish to the customer
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Publishing shows the reviewed proposal on the customer link. It never sends a message,
              issues a link, signs anything, or changes the quote.
            </p>
          </div>
        </div>

        {/*
          Above the whole branch chain, because it applies to preparing AND to confirming: a flag
          switched off after an approval was prepared must not leave a live confirm button behind.
          Publication first when both are unavailable — turning publication on is the blocking
          step, and finishing the template cannot matter until it is (ELEC-234 §6.8).
        */}
        {capabilityHasNotice(publication) ? (
          <div className="mt-5">
            <CapabilityUnavailable read={publication} />
          </div>
        ) : capabilityHasNotice(template) ? (
          <div className="mt-5">
            <CapabilityUnavailable read={template} />
          </div>
        ) : null}

        {offline ? (
          <PublicationNotice tone="warning" title="Publication is unavailable offline.">
            Reconnect before publishing. Nothing was published from this saved session.
          </PublicationNotice>
        ) : !proposalEvidencePackId ? (
          <PublicationNotice tone="warning" title="No proposal evidence pack links to this quote.">
            Prepare the proposal evidence pack first. Quote terms stay office-only until a pack is
            published.
          </PublicationNotice>
        ) : query.isPending ? (
          <div
            className="mt-5 h-24 animate-pulse border border-border bg-surface-muted/45"
            aria-busy="true"
          />
        ) : query.isError ? (
          <PublicationNotice tone="warning" title="Publication state could not be read.">
            Nothing was published. Re-read this project before preparing a publication.
            <Button
              type="button"
              variant="outline"
              size="compact"
              className="mt-3"
              onClick={() => void query.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
          </PublicationNotice>
        ) : published ? (
          <div className="mt-5 border border-ok/40 bg-ok-soft/45 p-4" role="status">
            <div className="flex gap-3">
              <Check className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-bold text-foreground">
                  The proposal is live on the customer link.
                </p>
                <p className="mt-1 text-sm leading-6 text-muted">
                  A customer holding a valid link now sees the proposal and can accept the contract.
                  Published {formatWhen(published.approved_by?.approved_at, locale)}
                </p>
              </div>
            </div>
          </div>
        ) : pending ? (
          <div className="mt-5 border border-border bg-surface-muted/45 p-4">
            <p className="font-bold text-foreground">Confirm what the customer will see</p>
            <dl className="mt-3 space-y-2 text-sm leading-6">
              <PreviewLine label="Proposal" value={pending.proposal_evidence_pack_id} />
              <PreviewLine label="Quote" value={pending.customer_quote_id} />
              <PreviewLine label="Pack status" value={`${pending.pack_status_before} → Approved`} />
              <PreviewLine label="Customer message sent" value="No" />
              <PreviewLine label="New portal link issued" value="No" />
              <PreviewLine label="Quote changed" value="No" />
            </dl>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <Button
                type="button"
                busy={publish.isPending}
                disabled={busy || !canApprove || publicationUnusable}
                onClick={() => {
                  if (decideInFlight.current) return;
                  decideInFlight.current = true;
                  publish.mutate(pending);
                }}
              >
                <Send aria-hidden="true" />
                Publish to customer portal
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (decideInFlight.current) return;
                  decideInFlight.current = true;
                  discard.mutate(pending);
                }}
              >
                Cancel
              </Button>
            </div>
            {!canApprove ? (
              <p className="mt-3 text-sm font-semibold text-warning">
                An owner must confirm this publication.
              </p>
            ) : null}
          </div>
        ) : proposalStatus !== "Draft" ? (
          <PublicationNotice
            tone="warning"
            title={`This proposal is ${proposalStatus ?? "in an unreadable state"}.`}
          >
            Only a Draft proposal evidence pack can be published. Nothing was changed.
          </PublicationNotice>
        ) : (
          <div className="mt-5">
            <Button
              type="button"
              busy={prepare.isPending}
              disabled={busy || !canPrepare || publicationUnusable}
              onClick={() => {
                if (prepareInFlight.current) return;
                prepareInFlight.current = true;
                prepare.mutate();
              }}
            >
              <Send aria-hidden="true" />
              Prepare publication
            </Button>
            {!capabilityHasNotice(publication) && !capabilityHasNotice(template) && !canPrepare ? (
              <p className="mt-3 text-sm font-semibold text-warning">
                This runtime does not offer publication for your account. Ask your owner or
                operations lead who administers this IronWrap deployment.
              </p>
            ) : null}
          </div>
        )}

        {uncertain ? (
          <PublicationNotice tone="danger" title="A publication attempt is unresolved.">
            The publication command may already have run. Reconcile the recorded run before trying
            again. Do not publish a second time.
          </PublicationNotice>
        ) : null}

        {failure ? (
          <PublicationNotice
            tone="danger"
            title={
              failure === "prepare"
                ? "The publication was not prepared."
                : failure === "publish"
                  ? "The proposal was not published."
                  : "The prepared publication was not cancelled."
            }
          >
            Nothing partial was applied. Refresh this project and read the current state before
            trying again.
          </PublicationNotice>
        ) : null}
      </div>
    </section>
  );
}

function PreviewLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-right font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function PublicationNotice({
  tone,
  title,
  children,
}: {
  tone: "warning" | "danger";
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mt-5 flex gap-3 border p-4 text-sm leading-6",
        tone === "warning"
          ? "border-warning/40 bg-warning-soft/55"
          : "border-danger/40 bg-danger-soft/55",
      )}
      role="status"
    >
      <CircleAlert
        className={cn(
          "mt-0.5 size-5 shrink-0",
          tone === "warning" ? "text-warning" : "text-danger",
        )}
        aria-hidden="true"
      />
      <div>
        <p className="font-bold text-foreground">{title}</p>
        <div className="mt-1 text-muted">{children}</div>
      </div>
    </div>
  );
}

function formatWhen(value: string | undefined, locale: string): string {
  if (!value) return "just now";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
    : "just now";
}
