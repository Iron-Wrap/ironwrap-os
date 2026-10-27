import { Timeline, type TimelineEntry } from "../components/ui/timeline";
import { RefTag } from "../components/ui/ref-tag";
import { Status } from "../components/ui/status";
import { SystemDetails } from "../components/ui/system-details";
import type { QuoteRevisionApprovalRequest } from "../estimator/quote-revision-approval-contracts";
import type { ProposalPublicationApprovalRequest } from "../proposal/proposal-publication-contracts";
import type { ApprovalRequest } from "./approval-contracts";
import { formatOwnerDate, type OwnerDateFormatOptions } from "./owner-now-utils";

export type RecordedApproval =
  ApprovalRequest | QuoteRevisionApprovalRequest | ProposalPublicationApprovalRequest;

/** Displays only persisted receipt facts; request version is never called the approved version. */
export function ApprovalReceipt({
  approval,
  locale,
}: {
  approval: RecordedApproval;
  locale: OwnerDateFormatOptions;
}) {
  if (!approval.approved_by && !approval.outcome && !approval.reconciliation) return null;
  const events: TimelineEntry[] = [
    {
      id: `${approval.id}:requested`,
      actor: approval.requested_by.frappe_user ?? approval.requested_by.user_id,
      text: "requested this review",
      at: approval.created_at,
      when: formatOwnerDate(approval.created_at, locale),
    },
  ];
  if (approval.approved_by)
    events.push({
      id: `${approval.id}:approved`,
      actor: approval.approved_by.frappe_user,
      text: "recorded approval",
      at: approval.approved_by.approved_at,
      when: formatOwnerDate(approval.approved_by.approved_at, locale),
    });
  if (approval.outcome?.audit_finalized)
    events.push({
      id: `${approval.id}:result`,
      actor: "Saved result",
      text:
        approval.kind === "lead_triage"
          ? "lead note updated; audit receipt finalized"
          : approval.kind === "quote_revision"
            ? "empty quote draft created; audit receipt finalized"
            : "proposal publication recorded; audit receipt finalized",
      ...(approval.completed_at ? { at: approval.completed_at } : {}),
      when: formatOwnerDate(approval.completed_at, locale),
    });
  if (approval.reconciliation)
    events.push({
      id: `${approval.id}:reconciled`,
      actor: approval.reconciliation.by_frappe_user,
      text: `checked the result: ${approval.reconciliation.outcome.replaceAll("_", " ")}`,
      at: approval.reconciliation.at,
      when: formatOwnerDate(approval.reconciliation.at, locale),
    });
  return (
    <section
      className="grid gap-4 border-t border-border pt-5 [overflow-wrap:anywhere]"
      aria-label="Approval receipt"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Approval receipt</h3>
        <Status kind={approval.outcome?.audit_finalized ? "confirmed" : "attention"}>
          {approval.outcome?.audit_finalized ? "Result recorded" : "Result still needs a check"}
        </Status>
      </div>
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <Timeline entries={events} label="Recorded approval events" />
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        {approval.kind === "quote_revision" ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-muted">Exact observed quote</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
              <RefTag kind="record" id={approval.source.customer_quote_id} />
              <span>
                {approval.source.status} · observed{" "}
                {formatOwnerDate(approval.source.modified, locale)}
              </span>
            </dd>
          </div>
        ) : null}
        {approval.kind === "lead_triage" ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-muted">Observed lead record</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
              <RefTag kind="record" id={approval.target.lead_envelope_id} />
              <span>
                {approval.preview
                  ? `Previous triage: ${approval.preview.before.triage_status}`
                  : "Review snapshot not provided"}
              </span>
            </dd>
          </div>
        ) : null}
        {approval.kind === "proposal_publication" ? (
          <div className="sm:col-span-2">
            <dt className="font-semibold text-muted">Exact observed proposal</dt>
            <dd className="mt-1 flex flex-wrap items-center gap-2">
              <RefTag kind="record" id={approval.proposal_evidence_pack_id} />
              <span>
                {approval.preview
                  ? `${approval.preview.before.status} · quote ${approval.preview.before.quotation}`
                  : `${approval.pack_status_before} · full review snapshot not provided`}
              </span>
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="text-sm leading-6 text-muted">
        {approval.kind === "lead_triage"
          ? "This approval covers the lead note. It does not release material, shop work, or a crew."
          : approval.kind === "quote_revision"
            ? "This approval creates an empty correction draft. Customer terms, acceptance, material release, and crew dispatch still require their own recorded steps."
            : "Publication makes this proposal visible through an already-issued customer link. Issuing a link and recording customer acceptance remain separate steps."}
      </p>
      {/* Said in words, outside System details: the receipt cannot show the approved edit. */}
      <p className="text-sm leading-6 text-muted">
        This receipt does not record which edit of the request was approved.
      </p>
      {approval.reconciliation ? (
        <p className="text-sm leading-6">
          Result-check evidence: {approval.reconciliation.evidence}
        </p>
      ) : null}
      {/* Version numbers stay out of a person's lines; the audit keeps them here. */}
      <SystemDetails className="text-sm text-muted">
        <dl className="grid gap-2">
          <div>
            <dt className="font-semibold">Request version</dt>
            <dd>{approval.version}</dd>
          </div>
          <div>
            <dt className="font-semibold">Approved snapshot version</dt>
            <dd>Not provided by the saved receipt</dd>
          </div>
          {approval.kind === "quote_revision" ? (
            <>
              <div>
                <dt className="font-semibold">Observed quote version</dt>
                <dd>{approval.source.quote_version}</dd>
              </div>
              <div>
                <dt className="font-semibold">New draft version</dt>
                <dd>{approval.target.quote_version}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </SystemDetails>
    </section>
  );
}
