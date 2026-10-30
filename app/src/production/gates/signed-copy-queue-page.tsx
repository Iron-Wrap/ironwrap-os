import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { useSession } from "../../auth/session-context";
import { RoleGuard } from "../../components/role-guard";
import { Button } from "../../components/ui/button";
import { ErrorState } from "../../components/ui/state-panel";
import { messageForLoad } from "../../lib/plain-error";
import type { AppRole } from "../../lib/roles";
import { loadSignedCopyQueue, signedCopyQueueQueryKey } from "./gate-api";
import { gateCopy } from "./gate-copy";
import type { SignedCopyQueueJob, SignedCopyQueueResponse } from "./gate-contracts";
import { canRecordSignedCopy } from "./gate-model";
import { officeStamp } from "./gate-time";
import { GateField, InfoBanner, NextLine } from "./gate-ui";

/**
 * Q1, the work queue of signed jobs whose cancellation window is unknown (A5). Owner and ops
 * only, as the Worker serves it; each row opens that job's record step.
 */
export function SignedCopyQueuePage() {
  return (
    <RoleGuard surface="production">
      <SignedCopyQueueGuard />
    </RoleGuard>
  );
}

function SignedCopyQueueGuard() {
  const session = useSession();
  if (!canRecordSignedCopy(session.user.role)) {
    return (
      <section className="mx-auto max-w-3xl">
        <InfoBanner>{gateCopy.queue.noAccess}</InfoBanner>
      </section>
    );
  }
  return <SignedCopyQueueContent role={session.user.role} />;
}

function SignedCopyQueueContent({ role }: { role: AppRole }) {
  const session = useSession();
  const query = useQuery({
    queryKey: signedCopyQueueQueryKey(session.tenant.id, session.user.id),
    queryFn: () => loadSignedCopyQueue(),
  });
  if (!query.data) {
    if (query.isError) {
      return (
        <section className="mx-auto max-w-3xl">
          <ErrorState
            title={gateCopy.queue.loadFailed}
            message={messageForLoad(query.error)}
            error={query.error}
            action={
              <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
                {gateCopy.queue.retry}
              </Button>
            }
          />
        </section>
      );
    }
    return (
      <section className="mx-auto max-w-3xl" aria-busy="true">
        <p className="text-sm text-muted">{gateCopy.queue.loading}</p>
      </section>
    );
  }
  return (
    <SignedCopyQueue
      model={query.data}
      role={role}
      timeZone={session.tenant.time_zone}
      now={new Date()}
    />
  );
}

/** One row per category (Q1): what is missing, and the control that opens the record step. */
function rowWords(job: SignedCopyQueueJob, stamp: (value: string | null) => string | null) {
  const name = job.customer_display_name;
  if (job.unknown_reason === "signed_copy_unconfirmed") {
    return {
      status: gateCopy.queue.unconfirmed(stamp(job.copy_shown_at)),
      action: gateCopy.queue.confirm(name),
    };
  }
  if (job.unknown_reason === "signed_copy_before_contract") {
    return {
      status: gateCopy.queue.earlierContract(stamp(job.contract_signed_at)),
      action: gateCopy.queue.update(name),
    };
  }
  return { status: gateCopy.queue.notRecorded, action: gateCopy.queue.add(name) };
}

export function SignedCopyQueue({
  model,
  role,
  timeZone,
  now,
}: {
  model: SignedCopyQueueResponse;
  role: AppRole;
  timeZone: string;
  now: Date;
}) {
  const stamp = (value: string | null) => officeStamp(value, { timeZone, now });
  return (
    <section className="mx-auto grid max-w-3xl gap-5 pb-6">
      <header className="grid gap-2">
        <nav aria-label="Breadcrumb" className="text-sm font-semibold text-muted">
          <ol className="flex flex-wrap items-center gap-1.5">
            <li>{gateCopy.queue.breadcrumbRoot}</li>
            <li className="flex items-center gap-1.5">
              <ChevronRight className="size-3.5" aria-hidden="true" />
              <span aria-current="page">{gateCopy.queue.title}</span>
            </li>
          </ol>
        </nav>
        <h1 className="text-2xl leading-[1.15] font-[640] tracking-[-0.018em]">
          {gateCopy.queue.title}
        </h1>
        <div className="grid gap-0.5 text-sm leading-6 text-muted">
          <p className="font-semibold text-foreground">{gateCopy.queue.count(model.count)}</p>
          <p>{gateCopy.queue.why}</p>
        </div>
      </header>
      {model.jobs.length === 0 ? (
        <InfoBanner>{gateCopy.queue.empty}</InfoBanner>
      ) : (
        <>
          <InfoBanner>{gateCopy.queue.rule}</InfoBanner>
          <ol className="grid gap-5">
            {model.jobs.map((job, index) => {
              const words = rowWords(job, stamp);
              const label = [job.customer_display_name, job.address_line1]
                .filter((part): part is string => Boolean(part))
                .join(" · ");
              return (
                <li key={job.roof_job_id} className="grid gap-3">
                  <GateField label={label} value={words.status} />
                  {canRecordSignedCopy(role) ? (
                    <div>
                      <Button asChild variant={index === 0 ? "primary" : "secondary"}>
                        <Link
                          to="/production/jobs/$jobId/gates"
                          params={{ jobId: job.roof_job_id }}
                          search={{ step: "window" }}
                        >
                          {words.action}
                        </Link>
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {model.complete ? null : (
            <p className="text-sm text-muted">{gateCopy.queue.partial(model.jobs.length)}</p>
          )}
          <NextLine>{gateCopy.queue.next}</NextLine>
        </>
      )}
    </section>
  );
}
