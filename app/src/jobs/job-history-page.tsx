import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, MapPin, Phone } from "lucide-react";
import { useState } from "react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { PageHeader } from "../components/ui/page-header";
import { Queue, QueueRow } from "../components/ui/queue";
import { Status } from "../components/ui/status";
import { Timeline } from "../components/ui/timeline";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { GateChip } from "../field/gate-chip";
import { JobLabelText } from "../field/job-label-text";
import { jobLabelParts } from "../lib/job-label";
import { messageForLoad } from "../lib/plain-error";
import type { ProofStreamItem } from "../field/field-contracts";
import { formatOwnerDate } from "../owner/owner-now-utils";
import { loadJobHistory } from "./job-history-api";
import { jobHistoryQueryKey, type JobHistoryResponse } from "./job-history-contracts";
import { JobSpinePanel } from "./job-spine-panel";

/**
 * What happened on one job, including a job that is over.
 *
 * The work plan at `/jobs/$jobId` refuses anything that is not live, which left a finished job with
 * no route at all: the office could not open the roof a customer was calling about, and nobody
 * could see what had been done to it. This page is the other reading of a job — the record — and it
 * is read-only by construction: the server returns no allowed actions. Links connect the record
 * to existing live plans and permission-gated money and approval records.
 */
export function JobHistoryPage() {
  const session = useSession();
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const query = useQuery({
    queryKey: jobHistoryQueryKey(session.tenant.id, session.user.id, jobId ?? ""),
    enabled: Boolean(jobId),
    queryFn: () => loadJobHistory(jobId!),
  });

  if (!jobId) return <ErrorState message="This job link is incomplete." />;
  if (query.isPending) return <LoadingState label="Loading this job's record…" />;
  if (query.isError && !query.data)
    return (
      <ErrorState
        message={messageForLoad(query.error)}
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data)
    return (
      <ErrorState message="This job is not one you can open, or it does not exist on this account." />
    );

  return (
    <JobHistorySurface
      key={JSON.stringify([session.tenant.id, session.user.id, jobId])}
      model={query.data}
      jobId={jobId}
      refreshFailed={query.isError}
    />
  );
}

function JobHistorySurface({
  model,
  jobId,
  refreshFailed,
}: {
  model: JobHistoryResponse;
  jobId: string;
  refreshFailed: boolean;
}) {
  const session = useSession();
  const [loadedProof, setLoadedProof] = useState({
    firstPage: model.proof,
    items: model.proof.items,
    cursor: model.proof.next_cursor,
    paged: false,
  });
  // A fresh first page updates matching events without discarding pages already read.
  // Only the identity key above resets this history; a refresh must not rewind its cursor.
  if (loadedProof.firstPage !== model.proof) {
    setLoadedProof({
      firstPage: model.proof,
      items: model.proof_unavailable
        ? loadedProof.items
        : mergeProofItems(model.proof.items, loadedProof.items),
      cursor:
        loadedProof.paged || model.proof_unavailable ? loadedProof.cursor : model.proof.next_cursor,
      paged: loadedProof.paged,
    });
  }
  const { items, cursor } = loadedProof;
  const [loadingMore, setLoadingMore] = useState(false);
  const [olderError, setOlderError] = useState<string>();
  const identity = {
    customer: model.customer?.display_name,
    address: model.job.address,
    code: model.job.job_number,
  };
  const { lead, code } = jobLabelParts(identity);
  const locale = { locale: session.tenant.locale, timeZone: session.tenant.time_zone };

  async function loadOlder() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setOlderError(undefined);
    try {
      const page = await loadJobHistory(jobId, cursor);
      if (!page || page.job.id !== model.job.id || page.proof_unavailable) {
        setOlderError("Older events could not be read. The loaded events remain here.");
        return;
      }
      setLoadedProof((current) => ({
        ...current,
        items: mergeProofItems(current.items, page.proof.items),
        cursor: page.proof.next_cursor,
        paged: true,
      }));
    } catch {
      setOlderError("Older events could not be read. The loaded events remain here.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="mx-auto max-w-5xl space-y-7 pb-8 [overflow-wrap:anywhere] lg:pb-4">
      <PageHeader
        title={
          lead ? (
            <>
              Job record for: <JobLabelText {...identity} />
            </>
          ) : code ? (
            <>
              {"Job record\u00a0· "}
              <span className="whitespace-nowrap">{`Reference ${code}`}</span>
            </>
          ) : (
            "Job record"
          )
        }
        back={
          <Button asChild variant="ghost" size="compact">
            <Link to="/now">
              <ChevronLeft aria-hidden="true" />
              Now
            </Link>
          </Button>
        }
        meta={
          <>
            <span>
              {model.job.status ?? "Status unknown"}
              {model.job.service_type ? ` · ${model.job.service_type}` : ""}
            </span>
            <span>Read {formatOwnerDate(model.read_model_generated_at, locale)}</span>
          </>
        }
      >
        {/*
          Said once, at the top, because everything below is a record and none of it can be acted
          on. A reader who misses that will look for buttons that are deliberately not here.
        */}
        <p className="mt-2 text-sm leading-6 text-muted">
          This is the record of this job. Nothing on this page changes it.
        </p>
      </PageHeader>

      {refreshFailed ? (
        <Notice tone="warning" title="The latest job record could not be checked">
          The loaded events remain here. Reconnect or try the read again before treating this as the
          current record.
        </Notice>
      ) : null}

      {model.stale_fields.length > 0 || !model.source_updated_at ? (
        <Notice tone="warning" title="This record has source limits">
          {!model.source_updated_at ? "The source update time is not available. " : ""}
          {model.stale_fields.length
            ? `Fields to check: ${model.stale_fields.map((field) => field.replaceAll("_", " ")).join(", ")}.`
            : ""}{" "}
          The record does not prove current release readiness.
        </Notice>
      ) : null}

      <nav
        aria-label="Job record sections"
        className="flex flex-wrap gap-x-5 gap-y-2 border-b border-border pb-3 text-sm font-semibold"
      >
        <a
          className="inline-flex min-h-11 items-center underline underline-offset-4"
          href="#job-history-gates-heading"
        >
          Handoffs
        </a>
        <a
          className="inline-flex min-h-11 items-center underline underline-offset-4"
          href="#job-history-proof-heading"
        >
          Events
        </a>
        <a
          className="inline-flex min-h-11 items-center underline underline-offset-4"
          href="#job-spine-money-heading"
        >
          Money
        </a>
        <a
          className="inline-flex min-h-11 items-center underline underline-offset-4"
          href="#job-spine-approvals-heading"
        >
          Approvals
        </a>
      </nav>

      <Card className="space-y-3 p-4 sm:p-5">
        {model.job.address ? (
          <p className="flex items-start gap-2 text-sm leading-6">
            <MapPin className="mt-1 size-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="break-words">{model.job.address}</span>
          </p>
        ) : null}
        {model.customer?.display_name ? (
          <p className="text-sm leading-6">
            <span className="font-semibold">{model.customer.display_name}</span>
          </p>
        ) : null}
        {model.customer?.phone ? (
          <p className="flex items-start gap-2 text-sm leading-6">
            <Phone className="mt-1 size-4 shrink-0 text-muted" aria-hidden="true" />
            <a className="break-words underline" href={`tel:${model.customer.phone}`}>
              {model.customer.phone}
            </a>
          </p>
        ) : null}
        {model.openable ? (
          <Button asChild variant="outline" className="sm:w-auto" fullWidth>
            <Link to="/jobs/$jobId" params={{ jobId: model.job.id }}>
              Open the live job plan
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </Card>

      <section className="space-y-3" aria-labelledby="job-history-gates-heading">
        <h2 id="job-history-gates-heading" className="text-lg font-bold tracking-[-0.025em]">
          Handoffs and work checks
        </h2>
        {model.gates.length > 0 ? (
          <Queue label="Saved job handoffs">
            {model.gates.map((gate) => (
              <QueueRow
                key={gate.id}
                title={gate.name ?? gate.id}
                next={gate.blocker_reason ?? "No blocker reason recorded"}
                meta={
                  <>
                    <GateChip name={gate.name ?? gate.id} state={gate.state ?? "Unknown"} />
                    <span className="break-words">Holder: {gate.owner ?? "Not recorded"}</span>
                    {gate.due_at ? <span>Due {formatOwnerDate(gate.due_at, locale)}</span> : null}
                  </>
                }
              />
            ))}
          </Queue>
        ) : (
          <p className="text-sm text-muted">No work-check records were returned for this job.</p>
        )}
      </section>

      <section className="space-y-4" aria-labelledby="job-history-proof-heading">
        <header className="border-b border-border pb-4">
          <h2
            id="job-history-proof-heading"
            className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl"
          >
            Job events
          </h2>
        </header>
        {model.proof_unavailable ? (
          /*
            An empty proof stream and an unreadable one look identical and mean opposite things.
            Never let the second render as the first: "nothing was photographed on this roof" is a
            claim this page would be in no position to make.
          */
          <Notice tone="warning" title="The proof could not be read">
            This is not the same as none. Try again, and if it keeps failing the evidence store is
            not answering — ask whoever runs the system before you conclude anything about this job.
          </Notice>
        ) : (
          <>
            <p className="text-sm leading-6 text-muted">
              Photos, notes, and check-ins received by the server. Source and saved state are
              recorded; these events do not provide a named actor or approval version.
            </p>
            {items.length ? (
              <Timeline
                label="Received job events"
                entries={items.map((item) => ({
                  id: item.id,
                  actor: <span>{item.type ?? "Job proof"}</span>,
                  text: (
                    <span className="[overflow-wrap:anywhere]">
                      <span className="block">{item.summary ?? "Summary not recorded"}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-2">
                        <Status
                          kind={
                            item.blocker
                              ? "stopped"
                              : item.sync_state?.toLowerCase() === "verified"
                                ? "confirmed"
                                : "neutral"
                          }
                        >
                          {item.blocker
                            ? "Work-stop report"
                            : (item.sync_state ?? "Saved state unknown")}
                        </Status>
                        <span className="text-muted">
                          {item.source ?? "Source not recorded"}
                          {item.proof_slot ? ` · ${item.proof_slot}` : ""}
                        </span>
                      </span>
                    </span>
                  ),
                  ...(item.occurred_at ? { at: item.occurred_at } : {}),
                  when: formatOwnerDate(item.occurred_at, locale),
                }))}
              />
            ) : (
              <p className="text-sm text-muted">No sent job proof yet</p>
            )}
            {olderError ? (
              <Notice tone="warning" title="Older events unavailable">
                {olderError}
              </Notice>
            ) : null}
            {cursor ? (
              <Button variant="secondary" busy={loadingMore} onClick={() => void loadOlder()}>
                Load older events
              </Button>
            ) : null}
          </>
        )}
      </section>
      <JobSpinePanel jobId={model.job.roof_job_id ?? model.job.id} />
    </section>
  );
}

function mergeProofItems(first: ProofStreamItem[], later: ProofStreamItem[]) {
  const seen = new Set<string>();
  return [...first, ...later].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
