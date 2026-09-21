import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, MapPin, Phone } from "lucide-react";
import { useState } from "react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { GateChip } from "../field/gate-chip";
import { messageFor } from "../field/field-formatting";
import type { ProofStreamItem } from "../field/field-contracts";
import { ProofStream } from "../field/proof-stream";
import { loadJobHistory } from "./job-history-api";
import { jobHistoryQueryKey, type JobHistoryResponse } from "./job-history-contracts";

/**
 * What happened on one job, including a job that is over.
 *
 * The work plan at `/jobs/$jobId` refuses anything that is not live, which left a finished job with
 * no route at all: the office could not open the roof a customer was calling about, and nobody
 * could see what had been done to it. This page is the other reading of a job — the record — and it
 * is read-only by construction: the server returns no allowed actions and nothing here is a
 * control, apart from a link back to the live plan when the work is still running.
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
  if (query.isError)
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  if (!query.data)
    return (
      <ErrorState message="This job is not one you can open, or it does not exist on this account." />
    );

  return <JobHistorySurface model={query.data} jobId={jobId} />;
}

function JobHistorySurface({ model, jobId }: { model: JobHistoryResponse; jobId: string }) {
  const session = useSession();
  const [items, setItems] = useState<ProofStreamItem[]>(model.proof.items);
  const [cursor, setCursor] = useState(model.proof.next_cursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const title = model.job.job_number?.trim() || model.job.id;

  async function loadOlder() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadJobHistory(jobId, cursor);
      if (!page) return;
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.proof.items.filter((item) => !seen.has(item.id))];
      });
      setCursor(page.proof.next_cursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="mx-auto max-w-5xl space-y-7 pb-8 lg:pb-4">
      <Button asChild variant="ghost" size="compact">
        <Link to="/now">
          <ChevronLeft aria-hidden="true" />
          Now
        </Link>
      </Button>

      <header className="border-b border-border pb-4">
        <p className="text-sm font-semibold text-muted">
          {model.job.status ?? "Status unknown"}
          {model.job.service_type ? ` · ${model.job.service_type}` : ""}
        </p>
        <h1 className="mt-1 break-words text-2xl font-bold tracking-[-0.03em] sm:text-3xl">
          {title}
        </h1>
        {/*
          Said once, at the top, because everything below is a record and none of it can be acted
          on. A reader who misses that will look for buttons that are deliberately not here.
        */}
        <p className="mt-2 text-sm leading-6 text-muted">
          This is the record of this job. Nothing on this page changes it.
        </p>
      </header>

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

      {model.gates.length > 0 ? (
        <section className="space-y-3" aria-labelledby="job-history-gates-heading">
          <h2 id="job-history-gates-heading" className="text-lg font-bold tracking-[-0.025em]">
            Work checks
          </h2>
          <div className="flex flex-wrap gap-2">
            {model.gates.map((gate) => (
              <GateChip key={gate.id} name={gate.name ?? gate.id} state={gate.state ?? "Unknown"} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-4" aria-labelledby="job-history-proof-heading">
        <header className="border-b border-border pb-4">
          <p className="text-sm font-semibold text-muted">Sent job proof</p>
          <h2
            id="job-history-proof-heading"
            className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl"
          >
            What was done
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
          <ProofStream
            items={items}
            hasMore={Boolean(cursor)}
            loadingMore={loadingMore}
            onLoadMore={() => void loadOlder()}
            locale={session.tenant.locale}
            timeZone={session.tenant.time_zone}
          />
        )}
      </section>
    </section>
  );
}
