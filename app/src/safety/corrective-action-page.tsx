import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { useSession } from "../auth/session-context";
import { isOfflineSession } from "../auth/session";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import { ErrorSystemDetails } from "../components/ui/system-details";
import { Textarea } from "../components/ui/textarea";
import { WorkspaceHeader } from "../components/workspace-header";
import { useOnlineStatus } from "../hooks/use-online-status";
import { ApiError } from "../lib/api";
import { isRefusal, messageFor, messageForLoad, UNANSWERED_CONNECTION } from "../lib/plain-error";
import { subscribeOutboxChanges } from "../storage/outbox-store";
import {
  loadCorrectiveAction,
  listQueuedCorrectiveEvidence,
  queueCorrectiveEvidence,
  decideCorrectiveAction,
} from "./corrective-action-api";
import { correctiveActionStateLabel } from "./safety-desk-contracts";

export function CorrectiveActionPage({ actionId }: { actionId: string }) {
  const session = useSession();
  const online = useOnlineStatus() && !isOfflineSession(session);
  const client = useQueryClient();
  const [detail, setDetail] = useState("");
  const [reference, setReference] = useState("");
  const [digest, setDigest] = useState("");
  const [mustRefresh, setMustRefresh] = useState(false);
  const record = useQuery({
    queryKey: ["safety", "corrective-action", session.tenant.id, session.user.id, actionId],
    queryFn: () => loadCorrectiveAction(session, actionId),
    retry: false,
  });
  // Evidence already saved on this device for this action. A reload, a second tab, or a
  // cached "open" copy must never invite the same evidence twice while the queue holds it.
  const queued = useQuery({
    queryKey: ["safety", "corrective-evidence-queue", session.tenant.id, session.user.id, actionId],
    queryFn: () => listQueuedCorrectiveEvidence(session, actionId),
  });
  // The queue and the record move together: when an upload lands, the server's readback is
  // what the person should see, without a manual refresh.
  useEffect(
    () => subscribeOutboxChanges(() => void client.invalidateQueries({ queryKey: ["safety"] })),
    [client],
  );
  const waiting = (queued.data ?? []).filter((item) => item.state !== "needs_attention");
  const stopped = (queued.data ?? []).filter((item) => item.state === "needs_attention");
  const evidence = useMutation({
    networkMode: "always",
    mutationFn: async () => {
      const refs = JSON.stringify([{ ref: reference.trim(), sha256: digest.trim().toLowerCase() }]);
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(refs));
      return queueCorrectiveEvidence(session, actionId, {
        detail: detail.trim(),
        evidence_refs_json: refs,
        evidence_sha256: Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["safety"] });
    },
  });
  const decision = useMutation({
    mutationFn: (command: "verify" | "reject" | "close") =>
      decideCorrectiveAction(session, actionId, command, detail.trim()),
    onSuccess: async () => {
      setDetail("");
      await client.invalidateQueries({ queryKey: ["safety"] });
    },
    onError: () => setMustRefresh(true),
  });
  const action = record.data?.response.corrective_action;
  const allowed = record.data?.response.allowed_actions ?? [];
  const live = online && record.isSuccess && !record.data.offline;
  const busy = decision.isPending || evidence.isPending;
  const findingsTooShort = detail.trim().length < 3;
  // The server refused the session itself, not the decision. The route stays put so the job
  // context survives; the person signs in again and re-reads before deciding.
  const sessionLost = [evidence.error, decision.error].some(
    (error) => error instanceof ApiError && error.status === 401,
  );

  async function refresh() {
    const refreshed = await record.refetch();
    if (refreshed.isSuccess && !refreshed.data.offline) setMustRefresh(false);
  }

  return (
    <div className="space-y-5">
      <WorkspaceHeader
        icon={<ShieldCheck aria-hidden="true" />}
        title="Corrective action"
        description="Submit evidence of the fix, then have an independent authorized person verify it before closure."
      />
      {record.isPending ? <LoadingState label="Reading corrective action…" /> : null}
      {record.isError ? (
        <ErrorState
          message={messageForLoad(record.error, { fallback: "This action could not be read." })}
          error={record.error}
          onRetry={() => void refresh()}
        />
      ) : null}
      {action ? (
        <Card>
          <CardContent className="space-y-4 pt-5">
            <h2 className="break-all text-lg font-bold">{action.description}</h2>
            <p>
              {correctiveActionStateLabel(action.state)}. {action.risk_level} risk. Due{" "}
              {action.due_at}.
            </p>
            <p className="break-all text-sm text-muted">
              Action {action.corrective_action_id}. Owned by {action.owner_user_id}. From{" "}
              {action.occurrence_id}.
            </p>
            <Button
              variant="outline"
              onClick={() => void refresh()}
              disabled={record.isFetching || busy}
            >
              Refresh action
            </Button>
            {!live ? (
              <Notice tone="warning" title="Current state is not confirmed">
                This may be a saved copy. Evidence can be queued on this device; verification and
                closure require a fresh online read.
              </Notice>
            ) : null}
            {action.evidence_refs_json ? (
              <details className="space-y-2">
                <summary className="min-h-11 cursor-pointer py-3 font-bold">
                  Submitted evidence
                </summary>
                <pre className="text-sm whitespace-pre-wrap break-all">
                  {action.evidence_refs_json}
                </pre>
                <p className="break-all text-sm">
                  Captured by {action.evidence_captured_by_user_id}. Evidence digest{" "}
                  {action.evidence_sha256}.
                </p>
              </details>
            ) : null}
            {action.verified_by_user_id ? (
              <p className="break-all text-sm">
                Verified by {action.verified_by_user_id} at {action.verified_at}.
              </p>
            ) : null}
            {action.closed_at ? <p className="text-sm">Closed {action.closed_at}.</p> : null}
            {record.data?.response.verification_unavailable_reason ? (
              <Notice tone="info" title="Independent verification required">
                {record.data.response.verification_unavailable_reason}
              </Notice>
            ) : null}
            {!evidence.isSuccess && waiting.length ? (
              <Notice tone="info" title="Evidence saved on this device is waiting to upload">
                This device holds {waiting.length === 1 ? "one submission" : "submissions"} for this
                action that the server has not confirmed yet. It uploads when there is signal;
                nothing needs entering again.
              </Notice>
            ) : null}
            {stopped.length ? (
              <Notice tone="warning" title="A saved submission for this action needs attention">
                Review it in Saved work before entering evidence again, so the office sees one
                answer rather than two.
              </Notice>
            ) : null}
            {evidence.isSuccess ? (
              <Notice
                tone={evidence.data?.state === "needs_attention" ? "warning" : "info"}
                title={
                  evidence.data?.state === "verified"
                    ? "Evidence accepted by the server"
                    : "Evidence saved on this device"
                }
              >
                {evidence.data?.state === "needs_attention"
                  ? "The server did not accept this submission. Review it in Saved work before retrying."
                  : "The durable outbox keeps this submission until the server confirms it. Refresh this action to see its current state."}
              </Notice>
            ) : null}
            {decision.isSuccess ? (
              <Notice tone="success" title="Decision recorded">
                The server accepted this decision. The current action is shown above.
              </Notice>
            ) : null}
            {sessionLost ? (
              <Notice tone="warning" title="Your sign-in ended before this was recorded">
                Nothing was recorded. Your findings stay on this screen and this action stays open
                here; sign in again in another tab or reload, then press Refresh action and decide
                again.
              </Notice>
            ) : evidence.isError || decision.isError ? (
              isRefusal(evidence.error ?? decision.error) ? (
                // A refusal is a confirmed "no", and its sentence already names the next step.
                <Notice tone="danger" title="Submission not recorded">
                  {messageFor(evidence.error ?? decision.error, {
                    refused: "Check the details and try again.",
                  })}{" "}
                  Your entered details remain here.
                  <ErrorSystemDetails error={evidence.error ?? decision.error} />
                </Notice>
              ) : (
                <Notice tone="danger" title="Submission not confirmed">
                  {messageFor(evidence.error ?? decision.error, {
                    byCode: UNANSWERED_CONNECTION,
                    fallback: "The office did not confirm it.",
                  })}{" "}
                  {mustRefresh
                    ? "Refresh and review the action before trying again."
                    : "Your entered details remain here."}
                  <ErrorSystemDetails error={evidence.error ?? decision.error} />
                </Notice>
              )
            ) : null}
            {allowed.includes("submit_evidence") &&
            !evidence.isSuccess &&
            queued.isSuccess &&
            !waiting.length ? (
              <form
                className="space-y-4 border-t pt-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) evidence.mutate();
                }}
              >
                <label className="block text-sm font-bold">
                  Stored evidence reference
                  <Input
                    className="mt-1"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    required
                    minLength={3}
                    maxLength={512}
                  />
                </label>
                <label className="block text-sm font-bold">
                  Evidence SHA-256
                  <Input
                    className="mt-1"
                    value={digest}
                    onChange={(event) => setDigest(event.target.value)}
                    required
                    pattern="[a-fA-F0-9]{64}"
                    minLength={64}
                    maxLength={64}
                  />
                </label>
                <p className="text-sm text-muted">
                  Use the reference and digest of evidence already stored, such as an inspection
                  record. This form does not upload a new file.
                </p>
                <label className="block text-sm font-bold">
                  What was fixed
                  <Textarea
                    className="mt-1"
                    value={detail}
                    onChange={(event) => setDetail(event.target.value)}
                    required
                    minLength={3}
                    maxLength={4000}
                  />
                </label>
                <Button type="submit" busy={evidence.isPending} disabled={busy}>
                  Save evidence
                </Button>
              </form>
            ) : null}
            {live && allowed.some((value) => value !== "submit_evidence") ? (
              <div className="space-y-4 border-t pt-4">
                <label className="block text-sm font-bold">
                  Decision findings
                  <Textarea
                    className="mt-1"
                    value={detail}
                    onChange={(event) => setDetail(event.target.value)}
                    minLength={3}
                    maxLength={4000}
                    aria-describedby="decision-findings-hint"
                  />
                </label>
                <p id="decision-findings-hint" className="text-sm text-muted">
                  {findingsTooShort
                    ? "Write at least three characters of findings to enable the decision buttons. Your findings are recorded with the decision."
                    : "Your findings are recorded with the decision."}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(["verify", "reject", "close"] as const)
                    .filter((command) => allowed.includes(command))
                    .map((command) => (
                      <Button
                        key={command}
                        variant={command === "reject" ? "outline" : "default"}
                        disabled={busy || mustRefresh || findingsTooShort}
                        aria-describedby="decision-findings-hint"
                        onClick={() => decision.mutate(command)}
                      >
                        {command === "verify"
                          ? "Verify the fix"
                          : command === "reject"
                            ? "Reject the evidence"
                            : "Close action"}
                      </Button>
                    ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
