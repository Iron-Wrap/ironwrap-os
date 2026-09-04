import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Users } from "lucide-react";
import { useMemo } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { EmptyState, ErrorState, LoadingState, NoAccessState } from "../components/ui/state-panel";
import { WorkspaceHeader } from "../components/workspace-header";
import { ApiError } from "../lib/api";
import { authorityQueryKeys, loadAuthorityDesk } from "./authority-api";
import {
  denialText,
  subjectName,
  verdictLabel,
  type AuthorityHead,
  type AuthoritySubject,
} from "./authority-contracts";

/** Worst first. An expiry nobody can see is the whole reason this screen exists. */
const ATTENTION = new Set(["revoked", "expired", "contradictory", "unknown", "expiring"]);

function needsAttention(subject: AuthoritySubject): boolean {
  return subject.records.some((r) => ATTENTION.has(r.verdict));
}

function expiryText(head: AuthorityHead): string {
  if (head.authority_revoked_at) return `Revoked ${head.authority_revoked_at}`;
  if (!head.authority_expires_at) return "No expiry on file";
  if (head.days_left === null) return `Expires ${head.authority_expires_at}`;
  if (head.days_left < 0)
    return `Expired ${head.authority_expires_at}, ${Math.abs(head.days_left)} days ago`;
  if (head.days_left === 0) return `Expires today, ${head.authority_expires_at}`;
  return `Expires ${head.authority_expires_at}, in ${head.days_left} days`;
}

function RecordRow({ head }: { head: AuthorityHead }) {
  const denial = denialText(head.denial_code);
  return (
    <li className="border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words font-bold">{head.authority_kind ?? "Authority"}</p>
        <p className="text-sm font-bold tabular-nums">{verdictLabel(head.verdict)}</p>
      </div>
      <p className="mt-1 text-sm text-muted">{expiryText(head)}</p>
      <p className="mt-1 text-sm break-words text-muted">
        {head.issuer_name}, {head.issuer_jurisdiction}. Read back {head.observed_at.slice(0, 10)}.
        Version {head.authority_version}.
        {head.authority_scope ? ` Scope: ${head.authority_scope}.` : ""}
      </p>
      {denial ? <p className="mt-1 text-sm">{denial}</p> : null}
    </li>
  );
}

function SubjectCard({ subject }: { subject: AuthoritySubject }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="break-all">{subjectName(subject)}</CardTitle>
        <CardDescription>
          {[subject.subject_role, subject.subject_type].filter(Boolean).join(", ") ||
            "No role on file"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul>
          {subject.records.map((head) => (
            <RecordRow key={`${head.authority_record_id}:${head.authority_version}`} head={head} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function PeoplePage() {
  const session = useSession();
  const offline = isOfflineSession(session);
  const desk = useQuery({
    queryKey: authorityQueryKeys.desk,
    queryFn: () => loadAuthorityDesk(),
    retry: false,
  });

  const { attention, clear, counts } = useMemo(() => {
    const subjects = desk.data?.subjects ?? [];
    const attention = subjects.filter(needsAttention);
    const clear = subjects.filter((s) => !needsAttention(s));
    const records = subjects.flatMap((s) => s.records);
    return {
      attention,
      clear,
      counts: {
        subjects: subjects.length,
        blocked: records.filter((r) => r.verdict === "revoked" || r.verdict === "expired").length,
        expiring: records.filter((r) => r.verdict === "expiring").length,
        lastRead: records.reduce<string | null>(
          (latest, r) => (!latest || r.observed_at > latest ? r.observed_at : latest),
          null,
        ),
      },
    };
  }, [desk.data]);

  const forbidden = desk.error instanceof ApiError && desk.error.status === 403;

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        icon={<Users aria-hidden="true" />}
        title="Who may do what, and until when"
        description="Every ticket, permit and competency this company has read back from its issuer. No issuer is called from this screen: these are the records already on file."
        actions={
          <Button variant="outline" onClick={() => void desk.refetch()} disabled={desk.isFetching}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      {offline ? (
        <Notice tone="warning" title="Offline, so this is read only">
          You are seeing the last copy this device holds. Nothing on this screen changes anything,
          so nothing is queued.
        </Notice>
      ) : null}

      {forbidden ? (
        <NoAccessState
          title="Not your role"
          message="Authority records are read by the owner and by operations. Your own tickets stay on your own surfaces."
          nextAction="Ask the office if you need to see someone else's."
          personPath="the owner or operations"
        />
      ) : desk.isPending ? (
        <LoadingState label="Reading what is on file…" />
      ) : desk.isError ? (
        <ErrorState
          message={
            desk.error instanceof ApiError && desk.error.status === 502
              ? "The authority store did not answer. Nothing is lost; try again."
              : "This did not load. Nothing is lost; try again."
          }
          onRetry={() => void desk.refetch()}
        />
      ) : counts.subjects === 0 ? (
        <EmptyState
          title="Nothing has been read back yet"
          message="A ticket appears here once its issuer has been read back through the authority tool. Until then this company has nothing on file, which is not the same as nobody being qualified."
        />
      ) : (
        <>
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-4">
              <div>
                <p className="text-sm font-bold text-muted">People and firms</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{counts.subjects}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-muted">Blocked now</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{counts.blocked}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-muted">
                  Expiring in {desk.data.expiring_within_days} days
                </p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{counts.expiring}</p>
              </div>
              <div>
                <p className="text-sm font-bold text-muted">Last issuer read</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {counts.lastRead ? counts.lastRead.slice(0, 10) : "None"}
                </p>
              </div>
            </CardContent>
          </Card>

          {attention.length > 0 ? (
            <section aria-labelledby="attention" className="space-y-3">
              <h2 id="attention" className="text-lg font-bold">
                Needs attention, {attention.length} of {counts.subjects}
              </h2>
              {attention.map((s) => (
                <SubjectCard key={s.subject_key} subject={s} />
              ))}
            </section>
          ) : null}

          {clear.length > 0 ? (
            <section aria-labelledby="clear" className="space-y-3">
              <h2 id="clear" className="text-lg font-bold">
                Clear, {clear.length}
              </h2>
              {clear.map((s) => (
                <SubjectCard key={s.subject_key} subject={s} />
              ))}
            </section>
          ) : null}

          <p className="text-sm text-muted">
            Read model generated {desk.data.read_model_generated_at.slice(0, 16).replace("T", " ")}{" "}
            UTC. Recording, verifying, renewing and revoking happen on the authority rail, not here.
          </p>
        </>
      )}
    </div>
  );
}

export default PeoplePage;
