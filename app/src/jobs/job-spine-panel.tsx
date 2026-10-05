import { useQuery } from "@tanstack/react-query";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Notice } from "../components/ui/notice";
import { Status } from "../components/ui/status";
import { loadQuoteRevisionApprovals } from "../estimator/quote-revision-approval-api";
import { ApprovalReceipt } from "../owner/approval-receipt";
import { formatOwnerDate } from "../owner/owner-now-utils";
import { loadProposalPublicationApprovals } from "../proposal/proposal-publication-api";
import { loadJobEconomics, type JobEconomics } from "./job-economics-read-view";

/** Connections read existing contracts independently; a failed source never becomes an empty ledger. */
export function JobSpinePanel({ jobId }: { jobId: string }) {
  const session = useSession();
  const offline = isOfflineSession(session);
  const canReadMoney = session.permissions.includes("estimator:read");
  const canReadApprovals = session.permissions.includes("approvals:read");
  const key = [session.tenant.id, session.user.id, jobId];
  const money = useQuery({
    queryKey: ["job-economics", ...key],
    enabled: canReadMoney && !offline,
    retry: false,
    queryFn: () => loadJobEconomics(session.tenant.id, jobId),
  });
  const revisions = useQuery({
    queryKey: ["job-quote-approval-history", ...key],
    enabled: canReadApprovals && !offline,
    retry: false,
    queryFn: () => loadQuoteRevisionApprovals(),
  });
  const publications = useQuery({
    queryKey: ["job-publication-approval-history", ...key],
    enabled: canReadApprovals && !offline,
    retry: false,
    queryFn: () => loadProposalPublicationApprovals(jobId),
  });
  const revisionsPaused = revisions.fetchStatus === "paused";
  const publicationsPaused = publications.fetchStatus === "paused";
  const approvals = [
    ...(revisions.data?.approvals ?? []).filter((approval) => approval.roof_job_id === jobId),
    ...(publications.data?.approvals ?? []).filter((approval) => approval.roof_job_id === jobId),
  ].sort((left, right) => right.created_at.localeCompare(left.created_at));
  const locale = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };

  return (
    <div className="grid gap-8" id="job-spine-connections">
      <section className="grid gap-4" aria-labelledby="job-spine-money-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <h2 className="text-xl font-semibold" id="job-spine-money-heading">
            Money and source coverage
          </h2>
          {canReadMoney ? (
            <a
              className="inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
              href={`/estimator/jobs/${encodeURIComponent(jobId)}`}
            >
              Open estimate record
            </a>
          ) : null}
        </div>
        {!canReadMoney ? (
          <p className="text-sm text-muted">
            Money records are not available to your role on this job.
          </p>
        ) : offline ? (
          <p className="text-sm text-muted">Reconnect to read this job's money sources.</p>
        ) : money.fetchStatus === "paused" ? (
          <Notice tone="warning" title="Money read paused">
            Reconnect to read this job's money sources. Amounts and completeness are unknown until
            the read completes.
          </Notice>
        ) : money.isPending ? (
          <p role="status" className="text-sm text-muted">
            Reading money sources…
          </p>
        ) : money.isError || !money.data ? (
          <Notice tone="warning" title="Money sources could not be read">
            The job proof is still available. Money amounts and completeness are unknown.{" "}
            <button
              className="min-h-11 font-semibold underline"
              onClick={() => void money.refetch()}
            >
              Try the money read again
            </button>
          </Notice>
        ) : (
          <>
            <p className="text-sm text-muted">
              Money read {formatOwnerDate(money.data.read_model_generated_at, locale)} · source
              updated{" "}
              {money.data.source_updated_at
                ? formatOwnerDate(money.data.source_updated_at, locale)
                : "not provided"}
            </p>
            {money.data.partial_sources.length || money.data.stale_fields.length ? (
              <Notice tone="warning" title="Money read has source limits">
                <ul className="grid gap-1 [overflow-wrap:anywhere]">
                  {[...new Set([...money.data.partial_sources, ...money.data.stale_fields])].map(
                    (source) => (
                      <li key={source}>{source.replaceAll("_", " ")}</li>
                    ),
                  )}
                </ul>
              </Notice>
            ) : null}
            <JobEconomicsSummary model={money.data.economics} locale={session.tenant.locale} />
          </>
        )}
      </section>
      <section className="grid gap-4" aria-labelledby="job-spine-approvals-heading">
        <h2
          className="border-b border-border pb-3 text-xl font-semibold"
          id="job-spine-approvals-heading"
        >
          Approval ledger
        </h2>
        {!canReadApprovals ? (
          <p className="text-sm text-muted">Approval receipts are not available to your role.</p>
        ) : offline ? (
          <p className="text-sm text-muted">Reconnect to read the approval receipts.</p>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted">
              Loaded quote-change and proposal-publication requests for this job. Lead reviews are
              separate because their records do not carry a job link.
            </p>
            {revisions.data || publications.data ? (
              <p className="text-sm text-muted">
                {revisions.data
                  ? `Quote approval read ${formatOwnerDate(revisions.data.read_model_generated_at, locale)}. `
                  : ""}
                {publications.data
                  ? `Publication approval read ${formatOwnerDate(publications.data.read_model_generated_at, locale)}.`
                  : ""}
              </p>
            ) : null}
            {(revisions.isPending && !revisionsPaused) ||
            (publications.isPending && !publicationsPaused) ? (
              <p role="status" className="text-sm text-muted">
                Reading approval sources…
              </p>
            ) : null}
            {revisionsPaused ? (
              <Notice tone="warning" title="Quote approval read paused">
                Reconnect to read the quote approval history. Coverage is unknown until the read
                completes.
              </Notice>
            ) : null}
            {publicationsPaused ? (
              <Notice tone="warning" title="Publication approval read paused">
                Reconnect to read the publication approval history. Coverage is unknown until the
                read completes.
              </Notice>
            ) : null}
            {revisions.isError ? (
              <Notice tone="warning" title="Quote approval history unavailable">
                This is not an empty history.{" "}
                <button
                  className="min-h-11 font-semibold underline"
                  onClick={() => void revisions.refetch()}
                >
                  Try again
                </button>
              </Notice>
            ) : null}
            {publications.isError ? (
              <Notice tone="warning" title="Publication approval history unavailable">
                This is not an empty history.{" "}
                <button
                  className="min-h-11 font-semibold underline"
                  onClick={() => void publications.refetch()}
                >
                  Try again
                </button>
              </Notice>
            ) : null}
            {approvals.length ? (
              <ol className="grid divide-y divide-border" aria-label="Loaded job approval records">
                {approvals.map((approval) => (
                  <li key={approval.id} className="grid gap-3 py-5 first:pt-0">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h3 className="font-semibold">
                        {approval.kind === "quote_revision"
                          ? `Quote correction draft v${approval.target.quote_version}`
                          : "Proposal publication"}
                      </h3>
                      <Status
                        kind={
                          approval.state === "executed" && approval.outcome?.audit_finalized
                            ? "confirmed"
                            : approval.state === "pending"
                              ? "pending"
                              : "attention"
                        }
                      >
                        {approval.state.replaceAll("_", " ")}
                      </Status>
                    </div>
                    <p className="text-sm leading-6">{approval.request_text}</p>
                    <p className="text-sm text-muted">Current request v{approval.version}</p>
                    <ApprovalReceipt approval={approval} locale={locale} />
                    <a
                      className="inline-flex min-h-11 items-center justify-self-start text-sm font-semibold underline underline-offset-4"
                      href={
                        approval.kind === "quote_revision"
                          ? `/quote-revision-approvals/${encodeURIComponent(approval.id)}`
                          : `/estimator/jobs/${encodeURIComponent(jobId)}#proposal-publication`
                      }
                    >
                      {approval.kind === "quote_revision"
                        ? "Open approval record"
                        : "Open publication in estimate"}
                    </a>
                  </li>
                ))}
              </ol>
            ) : !revisions.isPending &&
              !publications.isPending &&
              !revisionsPaused &&
              !publicationsPaused &&
              !revisions.isError &&
              !publications.isError ? (
              <p className="text-sm text-muted">No matching approvals in the loaded records.</p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

export function JobEconomicsSummary({ model, locale }: { model: JobEconomics; locale: string }) {
  const metrics = [
    ["Forecast revenue", model.metrics.forecast_revenue],
    ["Forecast cost", model.metrics.forecast_cost],
    ["Committed cost", model.metrics.committed_cost],
    ["Accrued actual cost", model.metrics.accrued_actual_cost],
    ["Posted actual cost", model.metrics.posted_actual_cost],
    ["Invoiced revenue before tax", model.metrics.invoiced_revenue_ex_tax],
    ["Cash collected", model.metrics.cash_collected],
  ] as const;
  return (
    <>
      <Status kind={model.state === "complete" ? "confirmed" : "attention"}>
        {model.state === "complete" ? "Source coverage complete" : "Source coverage needs review"}
      </Status>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map(([label, metric]) => (
          <div key={label} className="border-b border-border-soft pb-3">
            <dt className="text-sm font-semibold text-muted">{label}</dt>
            <dd className="mt-1 font-mono">
              {metric.known_cents === null || !model.currency
                ? "Amount unavailable"
                : formatMoney(metric.known_cents, model.currency, locale)}
              {metric.known_cents !== null && !metric.complete ? " known" : ""}
            </dd>
            <dd className="mt-1 text-sm text-muted">
              {metric.source_count} qualifying {metric.source_count === 1 ? "source" : "sources"} ·{" "}
              {metric.complete ? "complete source sum" : "incomplete source sum"}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted">
        Actual profit is unavailable: posted revenue recognition is not supplied. Known amounts are
        not complete job totals when source coverage is incomplete.
      </p>
      <details className="border border-border px-4 py-2">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
          Cost lineage and missing sources
        </summary>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Material lots observed</dt>
            <dd>{model.source_coverage.material_lots}</dd>
          </div>
          <div>
            <dt className="text-muted">Cost events observed</dt>
            <dd>{model.source_coverage.cost_events}</dd>
          </div>
          <div>
            <dt className="text-muted">Posted cost events</dt>
            <dd>{model.source_coverage.posted_cost_events}</dd>
          </div>
          <div>
            <dt className="text-muted">Matched cost reconciliations</dt>
            <dd>{model.source_coverage.matched_cost_reconciliations}</dd>
          </div>
        </dl>
        <p className="my-3 text-sm text-muted">
          NCR records, rework cost, scrap cost, and yield impact are not supplied by this read.
        </p>
        {model.reconciliation_gaps.length ? (
          <ul
            className="grid gap-2 pb-3 text-sm [overflow-wrap:anywhere]"
            aria-label="Money reconciliation gaps"
          >
            {model.reconciliation_gaps.map((gap) => (
              <li key={gap}>{gap.replaceAll("_", " ")}</li>
            ))}
          </ul>
        ) : (
          <p className="pb-3 text-sm text-muted">
            No reconciliation gaps were reported by this read.
          </p>
        )}
      </details>
    </>
  );
}

function formatMoney(cents: number, currency: string, locale: string) {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "code",
    }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}
