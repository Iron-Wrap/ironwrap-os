import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Megaphone,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useRef, useState } from "react";

import { isOfflineSession, type AuthenticatedSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { CapabilityUnavailable } from "../capabilities/capability-unavailable";
import { capabilityPreventsUse, useCapability } from "../capabilities/capability-signal";
import { ReturnToNow } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
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
  submission_pending: "Waiting to send",
  submitted: "Sent",
  published: "Posted",
  reconciliation_required: "Needs a check",
  stop_submitted: "Stop sent",
  stop_reconciliation_required: "Stop needs a check",
  connection_required: "Sign-in needed",
  rejected: "Turned down",
};

export function PostizPage() {
  const session = useSession();
  if (session.user.role !== "owner") {
    return (
      <ErrorState
        title="This work belongs to another role"
        message="Only the owner can review or decide a public marketing post."
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
  // Postiz reaches owner and ops only, so a role that never receives the capability keeps the
  // Worker's own `enabled` flag below rather than being told the site is off on no evidence.
  const postiz = useCapability("postiz");
  const postizUnusable = capabilityPreventsUse(postiz);
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
        title="This marketing link is not complete"
        message="No post was found in this link. Go back to Now and open the current item."
      />
    );
  }
  if (!query.data && query.isPending) return <PostizSkeleton />;
  if (!query.data && query.isError) {
    return (
      <ErrorState
        title="This marketing post could not load"
        message="Nothing was changed. Go online and load the saved post before you choose."
        onRetry={() => void refresh()}
      />
    );
  }
  if (!query.data) return <PostizSkeleton />;

  const model = query.data;
  const intent = model.intent;
  const decisionReadStale = requiresFreshRead || query.isError;
  const canMutate = (permission: PostizAction) =>
    !offline && !decisionReadStale && !postizUnusable && model.allowed_actions.includes(permission);
  const busy = mutation.isPending;

  function command(kind: CommandKind) {
    if (!canMutate(actionPermission[kind]) || busy) return;
    setActionError(false);
    mutation.mutate({ kind, intentId: intent.id, expectedVersion: intent.version });
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="grid min-w-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <Button asChild variant="ghost" size="compact" className="-ml-2">
              <Link to="/now">
                <ArrowLeft aria-hidden="true" />
                Back to Now
              </Link>
            </Button>
            <div className="mt-5 flex min-w-0 items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
                <Megaphone className="size-6 text-accent" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                  {intent.title}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                  Review this post. Use only the actions IronWrap currently allows.
                </p>
              </div>
            </div>
          </div>
          <div className="border-t border-border bg-surface-muted/45 p-5 sm:p-7 lg:border-t-0 lg:border-l lg:p-8">
            <p className="text-sm font-bold text-muted">Next step</p>
            <h2 className="mt-2 text-xl font-black tracking-[-0.025em]">
              {stateLabel[intent.state]}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {model.connected ? "This site is connected." : "This site is not connected yet."}
            </p>
            <Button
              type="button"
              variant="outline"
              size="compact"
              className="mt-4"
              busy={query.isFetching}
              disabled={query.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw aria-hidden="true" />
              Load again
            </Button>
          </div>
        </header>
      </Card>

      {offline ? (
        <Notice tone="warning" title="Go online before you choose">
          Marketing choices are not saved while you are offline. The last saved post stays
          read-only.
        </Notice>
      ) : null}
      {query.isError ? (
        <Notice tone="warning" title="Showing the last saved post">
          Load this post again before you choose. The failed load did not change anything.
        </Notice>
      ) : null}
      {actionError ? (
        <Notice tone="danger" title="The choice was not saved">
          Load the saved post before you choose again. No extra error from the site is shown.
        </Notice>
      ) : null}
      {postiz.status === "known" ? (
        <CapabilityUnavailable read={postiz} />
      ) : !model.enabled ? (
        <Notice tone="warning" title="Marketing posting is turned off">
          You can still read this post, but sending is turned off. An administrator turns it back
          on; ask your owner or operations lead. IronWrap could not read the capability signal on
          this load, so it cannot say whether the setup behind it is finished either.
        </Notice>
      ) : null}

      <StatusCard model={model} />

      <Card id="postiz-content" className="p-5 sm:p-6">
        <h2 className="text-xl font-black tracking-[-0.025em]">Review content</h2>
        <p className="mt-4 whitespace-pre-wrap break-words text-base leading-7">{intent.content}</p>
        <dl className="mt-6 grid gap-4 border-t border-border pt-5 text-sm sm:grid-cols-2">
          <Fact label="Scheduled" value={formatDate(intent.scheduled_at, session)} />
          <Fact label="Site" value={providerLabel[intent.provider]} />
        </dl>
      </Card>

      <section
        className="overflow-hidden rounded-lg border border-border bg-surface-raised py-5 shadow-[0_1px_2px_oklch(0_0_0/0.035)]"
        aria-labelledby="postiz-actions"
      >
        <h2 id="postiz-actions" className="px-5 text-xl font-black tracking-[-0.025em] sm:px-6">
          What you can do
        </h2>
        <div className="mt-4 flex flex-col gap-3 px-5 sm:flex-row sm:flex-wrap sm:px-6">
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
              Approve post
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
              Turn down
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
              Stop post
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
              Check saved state
            </Button>
          ) : null}
          {model.allowed_actions.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              Nothing can be done on this post right now.
            </p>
          ) : null}
        </div>
      </section>

      <Proof model={model} />
      <PostizSystemDetails model={model} />
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
          <p className="text-sm font-bold text-muted">Saved state</p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.025em]">
            {stateLabel[intent.state]}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {providerLabel[intent.provider]} · {model.connected ? "Connected" : "Not connected"}
          </p>
          {publicationDrift ? (
            <p className="mt-2 text-sm font-semibold text-warning">
              The posted copy no longer matches what IronWrap saved. Check it by hand. IronWrap will
              not take the post down for you.
            </p>
          ) : needsAttention ? (
            <p className="mt-2 text-sm font-semibold text-warning">
              The site still needs a check. Load again or check it when you can.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function Proof({ model }: { model: PostizIntentResponse }) {
  if (model.intent.citations.length === 0) return null;
  return (
    <section aria-labelledby="postiz-proof">
      <h2 id="postiz-proof" className="text-xl font-black tracking-[-0.025em]">
        Proof
      </h2>
      <ul className="mt-4 space-y-3 overflow-hidden rounded-lg border border-border bg-surface-raised py-4 text-sm">
        {model.intent.citations.map((citation) => (
          <li key={citation.id} className="px-5 sm:px-6">
            <p className="font-bold">{citation.label}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PostizSystemDetails({ model }: { model: PostizIntentResponse }) {
  const intent = model.intent;
  return (
    <details className="group rounded-lg border border-border bg-surface-raised">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-bold sm:min-h-14 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span>System details</span>
        <ChevronRight
          className="size-4 text-muted transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <dl className="grid gap-3 border-t border-border px-4 py-3 text-sm text-muted sm:grid-cols-2 sm:px-5">
        <MetadataLine label="Post ID" value={intent.id} />
        <MetadataLine label="Connection" value={intent.integration_id ?? "Not found"} />
        <MetadataLine
          label="Adapter"
          value={`${model.adapter.name} ${model.adapter.expected_version}`}
        />
        <MetadataLine label="Permission" value={intent.permission_scope} />
        <MetadataLine label="Site state" value={model.reconciliation.remote_state ?? "Not found"} />
        {intent.citations.map((citation) => (
          <MetadataLine key={citation.id} label={citation.label} value={citation.source_ref} />
        ))}
        {intent.evidence_refs.map((reference) => (
          <MetadataLine key={reference} label="Proof record" value={reference} />
        ))}
      </dl>
    </details>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-semibold text-foreground">{label}</dt>
      <dd className="mt-0.5 break-all">{value}</dd>
    </div>
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

function PostizSkeleton() {
  return (
    <section
      className="mx-auto max-w-6xl space-y-6"
      aria-busy="true"
      aria-label="Loading this marketing post"
    >
      <div className="h-40 rounded-lg border border-border bg-surface-muted/70" />
      <div className="min-h-28 rounded-lg border border-border bg-surface-muted/55" />
      <LoadingState label="Loading this marketing post" />
    </section>
  );
}

function formatDate(value: string, session: AuthenticatedSession): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not found";
  return new Intl.DateTimeFormat(session.tenant.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: session.tenant.time_zone,
  }).format(date);
}
