import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, History, MapPin } from "lucide-react";

import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import type { FieldDateOptions } from "../field/field-formatting";
import { formatFieldDay, messageFor } from "../field/field-formatting";
import { loadCustomerJobHistory } from "./customer-history-api";
import {
  customerJobHistoryQueryKey,
  propertyAddressLabel,
  type CustomerJobHistoryEntry,
} from "./customer-history-contracts";

/**
 * What else this customer has had done.
 *
 * Until this section existed, a job left the product the moment it completed: operator search
 * returns only live work and the job route refuses anything else, so an office taking a call about
 * a roof done two winters ago had nothing to look at. The facts are on the row itself — service,
 * address, status, date — because most of the time recognising the earlier work IS the whole task,
 * and the finished job cannot be opened anyway.
 *
 * Shown only to readers holding `jobs:read:any`. The server refuses everyone else and this renders
 * nothing rather than an explanation, because a crew member is not missing anything they were
 * meant to have.
 */
export function CustomerJobHistorySection({
  jobId,
  dateOptions,
  headingId = "customer-history-heading",
}: {
  jobId: string | null;
  dateOptions: FieldDateOptions;
  headingId?: string;
}) {
  const session = useSession();
  const query = useQuery({
    queryKey: customerJobHistoryQueryKey(session.tenant.id, session.user.id, jobId ?? ""),
    enabled: Boolean(jobId),
    queryFn: () => loadCustomerJobHistory(jobId!),
  });

  if (!jobId) return null;
  if (query.isPending) return <LoadingState label="Loading earlier work…" />;
  if (query.isError)
    return <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />;
  // Not permitted, or a job the server will not name. Either way there is nothing to say here.
  if (!query.data) return null;

  const { customer, entries, truncated } = query.data;
  const earlier = entries.filter((entry) => !entry.is_anchor);
  const customerName = customer.display_name?.trim() || "this customer";

  return (
    <section className="space-y-4" aria-labelledby={headingId} data-testid="customer-job-history">
      <header className="border-b border-border pb-4">
        <p className="text-sm font-semibold text-muted">{customerName}</p>
        <h2 id={headingId} className="mt-1 text-2xl font-bold tracking-[-0.03em] sm:text-3xl">
          Earlier work
        </h2>
      </header>

      {earlier.length === 0 ? (
        /*
          Said out loud rather than shown as an empty space. "No earlier work" and "you are not
          allowed to see earlier work" would otherwise look identical, and only one of them means
          this is a new customer.
        */
        <p className="flex items-start gap-2 text-sm leading-6 text-muted">
          <History className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>This is the first job on record for {customerName}.</span>
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {earlier.map((entry) => (
              <EarlierJobRow key={entry.roof_job_id} entry={entry} dateOptions={dateOptions} />
            ))}
          </ul>
          {truncated ? (
            <p className="text-sm leading-6 text-muted">
              The {earlier.length} most recent are shown. {customerName} has more work on record
              than fits here.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function EarlierJobRow({
  entry,
  dateOptions,
}: {
  entry: CustomerJobHistoryEntry;
  dateOptions: FieldDateOptions;
}) {
  const address = propertyAddressLabel(entry.property);
  const title = entry.job_number?.trim() || entry.roof_job_id;
  const when = entry.updated_at ? formatFieldDay(entry.updated_at, dateOptions) : null;

  return (
    <li>
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {/* `break-words`: job numbers and ids can be long, and a desk card must not push the row wide. */}
            <h3 className="break-words text-base font-bold tracking-[-0.02em]">{title}</h3>
            {/*
              Status as words, never colour alone — this row is read outdoors on a phone and by a
              screen reader, and "Cancelled" has to survive both.
            */}
            <p className="text-sm font-semibold text-muted">
              {entry.job_status ?? "Status unknown"}
            </p>
          </div>
          {entry.service_type ? (
            <p className="break-words text-sm leading-6">{entry.service_type}</p>
          ) : null}
          {address ? (
            <p className="flex items-start gap-1.5 text-sm leading-6 text-muted">
              <MapPin className="mt-1 size-4 shrink-0" aria-hidden="true" />
              <span className="break-words">{address}</span>
            </p>
          ) : null}
          {when ? <p className="text-sm leading-6 text-muted">Last updated {when}</p> : null}
        </div>
        {/*
          Two readings of a job, and the row offers whichever one exists. The work plan closes with
          the work, so a finished job leads to its record instead — never to a control that would
          answer 404.
        */}
        <Button asChild variant="outline" className="sm:w-auto" fullWidth>
          {entry.openable ? (
            <Link to="/jobs/$jobId" params={{ jobId: entry.roof_job_id }}>
              Open this job
              <ChevronRight aria-hidden="true" />
            </Link>
          ) : (
            <Link to="/jobs/$jobId/history" params={{ jobId: entry.roof_job_id }}>
              See what was done
              <ChevronRight aria-hidden="true" />
            </Link>
          )}
        </Button>
      </Card>
    </li>
  );
}
