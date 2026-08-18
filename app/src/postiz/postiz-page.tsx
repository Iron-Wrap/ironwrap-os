import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { ReturnToNow } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import {
  approvePostizIntent,
  connectPostiz,
  loadPostizIntent,
  newPostizActionKey,
  rejectPostizIntent,
  reconcilePostizIntent,
  stopPostizIntent,
} from "./postiz-api";
import type { PostizAction, PostizIntentResponse, PostizProvider } from "./postiz-contracts";

type CommandKind = "approve" | "reject" | "stop" | "reconcile";
type PageAction =
  | { kind: "connect"; provider: PostizProvider }
  | { kind: CommandKind; intentId: string; expectedVersion: number };

const actionPermission: Record<CommandKind, PostizAction> = {
  approve: "postiz.intent.approve",
  reject: "postiz.intent.reject",
  stop: "postiz.intent.stop",
  reconcile: "postiz.intent.reconcile",
};

const providerLabel: Record<PostizProvider, string> = {
  facebook: "Facebook",
  "linkedin-page": "LinkedIn Page",
  gmb: "Google Business Profile",
};

const stateLabel: Record<PostizIntentResponse["intent"]["state"], string> = {
  pending_review: "Needs review",
  submission_pending: "Submission pending",
  submitted: "Submitted",
  published: "Published",
  reconciliation_required: "Reconciliation required",
  stop_submitted: "Stop submitted",
  stop_reconciliation_required: "Stop reconciliation required",
  connection_required: "Connection required",
  rejected: "Rejected",
};

export function PostizPage() {
  const session = useSession();
  if (session.user.role !== "owner") {
    return (
      <ErrorState
        title="This work belongs to another role"
        message="Only the owner can review or decide public marketing intent."
        action={<ReturnToNow />}
      />
    );
  }
  return <PostizContent />;
}

function PostizContent() {
  const { intentId } = useParams({ strict: false }) as { intentId?: string };
  const session = useSession();
  const queryClient = useQueryClient();
  const offline = isOfflineSession(session);
  const queryKey = ["postiz-intent", session.tenant.id, session.user.id, intentId] as const;
  const query = useQuery({
    queryKey,
    enabled: Boolean(intentId),
    queryFn: () => loadPostizIntent(intentId!),
    retry: false,
  });
  const keys = useRef(new Map<string, string>());
  const [actionError, setActionError] = useState(false);
  const [requiresFreshRead, setRequiresFreshRead] = useState(false);

  async function refresh() {
    const result = await query.refetch();
    if (!result.error && result.data) {
      setActionError(false);
      setRequiresFreshRead(false);
    }
  }

  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: PageAction) => {
      const keyName =
        action.kind === "connect"
          ? `${action.kind}:${intentId ?? "unknown"}`
          : `${action.kind}:${action.intentId}:${action.expectedVersion}`;
      const idempotencyKey = keys.current.get(keyName) ?? newPostizActionKey(action.kind);
      keys.current.set(keyName, idempotencyKey);
      if (action.kind === "connect") {
        return {
          kind: "connect" as const,
          response: await connectPostiz(session, action.provider, idempotencyKey),
        };
      }
      const command =
        action.kind === "approve"
          ? approvePostizIntent
          : action.kind === "reject"
            ? rejectPostizIntent
            : action.kind === "stop"
              ? stopPostizIntent
              : reconcilePostizIntent;
      return {
        kind: action.kind,
        response: await command(session, action.intentId, action.expectedVersion, idempotencyKey),
      };
    },
    onSuccess: (result) => {
      setActionError(false);
      setRequiresFreshRead(false);
      if (result.kind === "connect") {
        window.location.assign(result.response.connect_url);
        return;
      }
      queryClient.setQueryData(queryKey, result.response);
    },
    onError: () => {
      setActionError(true);
      setRequiresFreshRead(true);
    },
    onSettled: (_data, _error, action) => {
      if (action.kind !== "connect") void refresh();
    },
  });

  if (!intentId) {
    return (
      <ErrorState
        title="This marketing review link is incomplete"
        message="No intent record was provided. Return to Now and open the current exception."
      />
    );
  }
  if (!query.data && query.isPending) return <LoadingState label="Loading marketing review…" />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="Marketing review unavailable"
        message="No intent was changed. Reconnect and load the current recorded state before deciding."
        onRetry={() => void refresh()}
      />
    );
  }
  if (!query.data) return <LoadingState label="Loading marketing review…" />;

  const model = query.data;
  const intent = model.intent;
  const decisionReadStale = requiresFreshRead || query.isError;
  const canMutate = (permission: PostizAction) =>
    !offline && !decisionReadStale && model.allowed_actions.includes(permission);
  const busy = mutation.isPending;

  function command(kind: CommandKind) {
    if (!canMutate(actionPermission[kind]) || busy) return;
    setActionError(false);
    mutation.mutate({ kind, intentId: intent.id, expectedVersion: intent.version });
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6 pb-4">
      <header className="border-b border-border pb-5 sm:pb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/now">
                <ArrowLeft aria-hidden="true" />
                Back to Now
              </Link>
            </Button>
            <p className="mt-4 text-xs font-extrabold uppercase tracking-[0.16em] text-muted">
              Marketing intent · {providerLabel[intent.provider]}
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
              {intent.title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted">
              Review the bounded intent and use only the actions IronWrap OS currently permits.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="compact"
            busy={query.isFetching}
            disabled={query.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
            Refresh state
          </Button>
        </div>
      </header>

      {offline ? (
        <Notice title="Reconnect before acting">
          Marketing actions are never queued offline. The last saved state remains read-only.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice title="Showing the previous recorded state">
          Refresh this intent before acting. No provider action was issued by the failed read.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice title="The action was not confirmed" danger>
          Refresh the recorded intent before deciding again. No provider error detail is shown.
        </Notice>
      ) : null}
      {!model.enabled ? (
        <Notice title="Postiz is disabled">
          This intent remains visible, but the adapter has not been enabled for action.
        </Notice>
      ) : null}

      <StatusCard model={model} />

      <Card id="postiz-content" className="p-5 sm:p-6">
        <h2 className="text-xl font-black tracking-[-0.025em]">Review content</h2>
        <p className="mt-4 whitespace-pre-wrap break-words text-base leading-7">{intent.content}</p>
        <dl className="mt-6 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2">
          <Fact label="Scheduled" value={formatDate(intent.scheduled_at, session)} />
          <Fact label="Authorization" value={intent.permission_scope} />
        </dl>
      </Card>

      <section className="border-y border-border py-5" aria-labelledby="postiz-actions">
        <h2 id="postiz-actions" className="text-xl font-black tracking-[-0.025em]">
          Available actions
        </h2>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {model.allowed_actions.includes("postiz.intent.review") ? (
            <Button asChild variant="outline" className="w-full sm:w-auto">
              <a href="#postiz-content">Review content</a>
            </Button>
          ) : null}
          {model.allowed_actions.includes("postiz.connect") ? (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              busy={busy}
              disabled={!canMutate("postiz.connect") || busy}
              onClick={() => mutation.mutate({ kind: "connect", provider: intent.provider })}
            >
              Connect {providerLabel[intent.provider]}
            </Button>
          ) : null}
          {model.allowed_actions.includes("postiz.intent.approve") ? (
            <Button
              type="button"
              variant="accent"
              className="w-full sm:w-auto"
              busy={busy}
              disabled={!canMutate("postiz.intent.approve") || busy}
              onClick={() => command("approve")}
            >
              Approve intent
            </Button>
          ) : null}
          {model.allowed_actions.includes("postiz.intent.reject") ? (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              busy={busy}
              disabled={!canMutate("postiz.intent.reject") || busy}
              onClick={() => command("reject")}
            >
              Reject intent
            </Button>
          ) : null}
          {model.allowed_actions.includes("postiz.intent.stop") ? (
            <Button
              type="button"
              variant="danger"
              className="w-full sm:w-auto"
              busy={busy}
              disabled={!canMutate("postiz.intent.stop") || busy}
              onClick={() => command("stop")}
            >
              Stop intent
            </Button>
          ) : null}
          {model.allowed_actions.includes("postiz.intent.reconcile") ? (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              busy={busy}
              disabled={!canMutate("postiz.intent.reconcile") || busy}
              onClick={() => command("reconcile")}
            >
              Reconcile state
            </Button>
          ) : null}
          {model.allowed_actions.length === 0 ? (
            <p className="text-sm leading-6 text-muted">No action is permitted in this read.</p>
          ) : null}
        </div>
      </section>

      <Evidence model={model} />
    </section>
  );
}

function StatusCard({ model }: { model: PostizIntentResponse }) {
  const intent = model.intent;
  const needsAttention = Boolean(intent.error_code || model.reconciliation.detail_code);
  const publicationDrift = intent.error_code?.startsWith("postiz_publication_drift_") ?? false;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        {needsAttention ? (
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-muted">
            Recorded state
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.025em]">
            {stateLabel[intent.state]}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Adapter {model.adapter.expected_version} ·{" "}
            {model.connected ? "Connected" : "Not connected"}
            {model.reconciliation.remote_state
              ? ` · Provider ${model.reconciliation.remote_state}`
              : ""}
          </p>
          {publicationDrift ? (
            <p className="mt-2 text-sm font-semibold text-warning">
              A previously observed publication no longer matches exact-ID readback. Reconcile
              manually; public retraction is not automated.
            </p>
          ) : needsAttention ? (
            <p className="mt-2 text-sm font-semibold text-warning">
              Provider confirmation needs attention. Refresh or reconcile when permitted.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Evidence({ model }: { model: PostizIntentResponse }) {
  if (model.intent.evidence_refs.length === 0 && model.intent.citations.length === 0) return null;
  return (
    <section aria-labelledby="postiz-evidence">
      <h2 id="postiz-evidence" className="text-xl font-black tracking-[-0.025em]">
        Evidence
      </h2>
      <ul className="mt-4 space-y-3 border-y border-border py-4 text-sm">
        {model.intent.citations.map((citation) => (
          <li key={citation.id}>
            <p className="font-bold">{citation.label}</p>
            <p className="mt-1 break-all text-muted">{citation.source_ref}</p>
          </li>
        ))}
        {model.intent.evidence_refs.map((reference) => (
          <li key={reference} className="break-all text-muted">
            {reference}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-muted">{label}</dt>
      <dd className="mt-1 break-words font-bold">{value}</dd>
    </div>
  );
}

function Notice({
  title,
  danger = false,
  children,
}: {
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`border px-4 py-4 ${danger ? "border-danger/35 bg-danger-soft" : "border-warning/35 bg-warning-soft"}`}
      role={danger ? "alert" : "status"}
    >
      <p className="font-bold">{title}</p>
      <p className="mt-1 text-sm leading-6 text-muted">{children}</p>
    </div>
  );
}

function formatDate(value: string, session: AuthenticatedSession): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Schedule unavailable";
  return new Intl.DateTimeFormat(session.tenant.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: session.tenant.time_zone,
  }).format(date);
}
