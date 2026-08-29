import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, History, Link as LinkIcon, Plus, Send } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { useReadOnlyOfflineSurface } from "../components/offline-write-mode";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Notice } from "../components/ui/notice";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { useOnlineStatus } from "../hooks/use-online-status";
import { AutomationRecipientForm } from "./automation-recipient-form";
import {
  automationRecipientErrorMessage,
  createAutomationRecipient,
  loadAutomationRecipientDetail,
  loadAutomationRecipientHistory,
  loadAutomationRecipients,
  retireAutomationRecipient,
  reviseAutomationRecipient,
} from "./configuration-api";
import {
  automationRecipientDetailQueryKey,
  automationRecipientHistoryQueryKey,
  automationRecipientQueryKey,
  type AutomationRecipient,
  type AutomationRecipientDetailResponse,
  type AutomationRecipientHistoryResponse,
  type AutomationRecipientListResponse,
  type AutomationRecipientWriteInput,
} from "./configuration-contracts";
import { AdminPageHeader } from "./admin-shell";

/**
 * Who an automation is allowed to email — administered by the account, not shipped in a secret.
 *
 * This is the screen that makes the rule builder's promise true. A rule delivers to a REFERENCE
 * (`shop`), never to an address a rule author typed, and until this page existed the only way to
 * create that reference was `wrangler secret put PIPELINE_AUTOMATION_RECIPIENTS_JSON` — a
 * developer, a deploy, and a restart to add the shop's inbox (ELEC-218).
 *
 * Two server properties shape everything here and neither is negotiable from the client:
 *
 *   - an address goes IN and never comes back out. Reads carry a mask and a digest, so this screen
 *     can say WHICH inbox is configured and cannot hand one to a stolen owner session;
 *   - a reference is permanent. Rules are bound to it, so renaming would silently re-aim every
 *     rule that names it. Retiring is refused while a live rule still points at it, and this page
 *     asks the server which rules those are before offering the command.
 */
export function AutomationRecipientsConfigurationPage() {
  return (
    <RoleGuard surface="ownerConfiguration">
      <AutomationRecipientsContent />
    </RoleGuard>
  );
}

/**
 * Live recipients first, in the order the server sorts them; retired ones after, because a retired
 * recipient is history rather than a choice. Sorting by label would disagree with the reference
 * order every other automation surface reads.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sortAutomationRecipients(recipients: AutomationRecipient[]): AutomationRecipient[] {
  return [...recipients].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return left.recipient_ref.localeCompare(right.recipient_ref);
  });
}

function AutomationRecipientsContent() {
  // Configuration refuses an offline edit and keeps nothing, so the app-wide banner
  // must not promise this screen's work is waiting on the device to be sent.
  useReadOnlyOfflineSurface();
  const session = useSession();
  const online = useOnlineStatus();
  const live = online && !isOfflineSession(session);
  const queryClient = useQueryClient();
  const recipientsKey = automationRecipientQueryKey(session.tenant.id);
  const recipients = useQuery({
    queryKey: recipientsKey,
    queryFn: () => loadAutomationRecipients(),
    enabled: live,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: recipientsKey });

  if (!live && !recipients.data) return <ConfigurationOffline />;
  if (recipients.isPending && !recipients.data) return <LoadingState label="Loading recipients…" />;
  if (recipients.isError && !recipients.data) {
    return (
      <Section>
        <ErrorState
          title="Recipients could not load"
          message={automationRecipientErrorMessage(recipients.error)}
          onRetry={() => void recipients.refetch()}
        />
      </Section>
    );
  }
  const data = recipients.data;
  if (!data) return null;

  return (
    <Section>
      <AdminPageHeader
        icon={<Send className="size-6 text-accent" aria-hidden="true" />}
        title="Recipients"
        description="Who your automation rules can email. Add the shop, an office inbox, or a shared address here — no developer and no deployment secret."
        action={<AutomationsLink />}
      />
      {!live ? <OfflineNotice /> : null}
      {recipients.isError ? (
        <Notice tone="danger" title="The latest recipient refresh failed">
          {automationRecipientErrorMessage(recipients.error)} <ReloadButton />
        </Notice>
      ) : null}
      <RecipientCreateCard
        channels={data.catalog.channels}
        firstForAccount={data.recipients.length === 0}
        live={live}
        onCreated={refresh}
      />
      <RecipientList data={data} live={live} onChanged={refresh} />
    </Section>
  );
}

function RecipientList({
  data,
  live,
  onChanged,
}: {
  data: AutomationRecipientListResponse;
  live: boolean;
  onChanged: () => void;
}) {
  if (data.recipients.length === 0)
    return (
      <EmptyState
        title="No recipients yet"
        message="Add who should receive automation email — the shop, an office inbox, whoever needs to know a job moved. A rule cannot be saved until at least one exists."
      />
    );
  return (
    <div className="space-y-4" aria-label="Automation recipients">
      {sortAutomationRecipients(data.recipients).map((recipient) => (
        <RecipientCard
          key={recipient.recipient_id}
          recipient={recipient}
          channels={data.catalog.channels}
          live={live}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function RecipientCreateCard({
  channels,
  firstForAccount,
  live,
  onCreated,
}: {
  channels: string[];
  firstForAccount: boolean;
  live: boolean;
  onCreated: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const create = useMutation({
    mutationFn: (input: AutomationRecipientWriteInput) =>
      createAutomationRecipient(session, {
        recipient_ref: input.recipient_ref ?? "",
        label: input.label ?? "",
        channel: input.channel ?? channels[0] ?? "email",
        destination: input.destination ?? "",
      }),
    onSuccess: () => {
      setOpen(false);
      onCreated();
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Add a recipient</CardTitle>
            <CardDescription>
              A recipient is a name your rules point at. Change where it delivers later without
              touching a single rule.
            </CardDescription>
          </div>
          {!open ? (
            <div className="flex flex-wrap items-center gap-2">
              {create.isSuccess ? (
                <span className="text-sm font-bold text-ok" role="status">
                  Recipient added.
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={!live}
                onClick={() => {
                  create.reset();
                  setOpen(true);
                }}
              >
                <Plus aria-hidden="true" /> New recipient
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-4">
          {firstForAccount ? (
            <Notice tone="warning" title="This is the first recipient this account owns">
              Until now your automations resolve against whatever recipient list this deployment
              shipped with. Saving here takes that list over, so add every destination your rules
              need — not only this one.
            </Notice>
          ) : null}
          <AutomationRecipientForm
            idPrefix="recipient-new"
            channels={channels}
            live={live}
            busy={create.isPending}
            error={create.error}
            submitLabel="Save recipient"
            onCancel={() => setOpen(false)}
            onSubmit={(input) => create.mutate(input)}
          />
        </CardContent>
      ) : null}
    </Card>
  );
}

function RecipientCard({
  recipient,
  channels,
  live,
  onChanged,
}: {
  recipient: AutomationRecipient;
  channels: string[];
  live: boolean;
  onChanged: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const detailKey = automationRecipientDetailQueryKey(
    session.tenant.id,
    recipient.recipient_id,
    recipient.version,
  );
  // Asked for only when a retirement is being considered, because that is the only question it
  // answers: which live rules would this break. The server refuses the command on the same facts,
  // so the screen and the command cannot disagree about what is at stake.
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => loadAutomationRecipientDetail(recipient.recipient_id),
    enabled: confirmingRetire && live,
  });
  const historyKey = automationRecipientHistoryQueryKey(
    session.tenant.id,
    recipient.recipient_id,
    recipient.version,
  );
  const history = useQuery({
    queryKey: historyKey,
    queryFn: () => loadAutomationRecipientHistory(recipient.recipient_id),
    enabled: historyOpen && live,
  });
  const revise = useMutation({
    mutationFn: (input: AutomationRecipientWriteInput) =>
      reviseAutomationRecipient(session, recipient.recipient_id, {
        ...input,
        expected_version: recipient.version,
      }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: historyKey });
      onChanged();
    },
  });
  const retire = useMutation({
    mutationFn: () => retireAutomationRecipient(session, recipient),
    onSuccess: () => {
      setConfirmingRetire(false);
      void queryClient.invalidateQueries({ queryKey: historyKey });
      onChanged();
    },
  });
  const blockingRules = detail.data?.referenced_by ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="truncate">{recipient.label}</span>
              <StatusPill active={recipient.active}>
                {recipient.active ? "In use" : "Retired"}
              </StatusPill>
            </CardTitle>
            <CardDescription className="mt-1 break-words">
              {recipient.recipient_ref} · {recipient.channel} · {recipient.destination_masked} ·
              revision {recipient.version}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="compact"
              variant="outline"
              disabled={!live}
              onClick={() => {
                revise.reset();
                setEditing((value) => !value);
              }}
            >
              {editing ? "Close edit" : recipient.active ? "Edit" : "Restore"}
            </Button>
            {recipient.active ? (
              <Button
                type="button"
                size="compact"
                variant="ghost"
                disabled={!live}
                onClick={() => {
                  retire.reset();
                  setConfirmingRetire((value) => !value);
                }}
              >
                <Archive aria-hidden="true" />
                Retire
              </Button>
            ) : null}
            <Button
              type="button"
              size="compact"
              variant="ghost"
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <History aria-hidden="true" />
              {historyOpen ? "Hide history" : "History"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!recipient.active ? (
          <Notice tone="info" title="Retired">
            No rule can select this recipient, and a rule still naming it fails rather than
            delivering somewhere unintended. Restore it to make it available again.
          </Notice>
        ) : null}
        {retire.isError ? (
          <Notice tone="danger" title="This recipient was not retired">
            {automationRecipientErrorMessage(retire.error)}
          </Notice>
        ) : null}
        {revise.isSuccess ? (
          <Notice tone="success" title="Recipient saved">
            Rules pointing at {recipient.recipient_ref} now deliver to the new address. Every
            earlier revision stays readable in history.
          </Notice>
        ) : null}
        {confirmingRetire ? (
          <div className="rounded-lg border border-border bg-surface-muted p-4">
            <h3 className="font-bold">Retire this recipient?</h3>
            {/* Not `text-muted`: on the muted panel background it lands under 4.5:1 at this size. */}
            <p className="mt-1 text-sm leading-5">
              It stops being offered to new rules. Nothing is deleted — every revision stays
              readable in history, and you can restore it later.
            </p>
            <RetireBlockers
              detail={detail}
              live={live}
              recipientRef={recipient.recipient_ref}
              onRetry={() => void detail.refetch()}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="danger"
                busy={retire.isPending}
                disabled={!live || detail.isPending || blockingRules.length > 0}
                onClick={() => retire.mutate()}
              >
                <Archive aria-hidden="true" />
                Retire recipient
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={retire.isPending}
                onClick={() => setConfirmingRetire(false)}
              >
                Keep it
              </Button>
            </div>
          </div>
        ) : null}
        {editing ? (
          <>
            {!recipient.active ? (
              <Notice tone="info" title="Saving brings this recipient back">
                A retired recipient has no separate "restore" command — saving it appends a revision
                that turns it on again.
              </Notice>
            ) : null}
            <AutomationRecipientForm
              key={`${recipient.recipient_id}:${recipient.version}`}
              idPrefix={recipient.recipient_id}
              channels={channels}
              initial={recipient}
              live={live}
              busy={revise.isPending}
              error={revise.error}
              submitLabel={recipient.active ? "Save recipient" : "Restore recipient"}
              onCancel={() => setEditing(false)}
              onSubmit={(input) => revise.mutate(input)}
            />
          </>
        ) : null}
        {historyOpen ? (
          <RecipientHistory
            recipient={recipient}
            history={history}
            live={live}
            onRetry={() => void history.refetch()}
          />
        ) : null}
        <p className="text-xs leading-5 text-muted">
          Created {formatDate(recipient.created_at)} by {recipient.actor.role}. The address is held
          by the server and never shown in full, here or anywhere else in the app.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * What a retirement would strand, asked before the command rather than discovered by whoever did
 * not get the email. The server refuses on exactly these rules, so an empty answer here is the
 * same answer the command will give.
 */
function RetireBlockers({
  detail,
  live,
  recipientRef,
  onRetry,
}: {
  detail: {
    data?: AutomationRecipientDetailResponse;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  live: boolean;
  recipientRef: string;
  onRetry: () => void;
}) {
  if (!live)
    return (
      <p className="mt-3 text-sm" role="status">
        Reconnect to check which rules still send here.
      </p>
    );
  if (detail.isPending && !detail.data)
    return (
      <p className="mt-3 text-sm" role="status">
        Checking which rules still send here…
      </p>
    );
  if (detail.isError && !detail.data)
    return (
      <div className="mt-3">
        <Notice tone="warning" title="Could not check which rules use this recipient">
          {automationRecipientErrorMessage(detail.error)}{" "}
          <button type="button" className="ml-1 min-h-11 font-bold underline" onClick={onRetry}>
            Try again
          </button>
        </Notice>
      </div>
    );
  const rules = detail.data?.referenced_by ?? [];
  if (rules.length === 0)
    return (
      <p className="mt-3 text-sm font-bold" role="status">
        No live rule sends to {recipientRef}. This is safe to retire.
      </p>
    );
  return (
    <div className="mt-3">
      <Notice
        tone="warning"
        title={
          rules.length === 1
            ? "One live rule still sends here"
            : `${rules.length} live rules still send here`
        }
      >
        Point them at another recipient or turn them off first — retiring is refused while a rule
        would break.
        <ul className="mt-2 space-y-1" aria-label="Rules using this recipient">
          {rules.map((rule) => (
            <li key={rule.rule_id} className="break-words font-bold">
              {rule.pipeline_id} · stage {rule.to_stage_id}
            </li>
          ))}
        </ul>
      </Notice>
    </div>
  );
}

function RecipientHistory({
  recipient,
  history,
  live,
  onRetry,
}: {
  recipient: AutomationRecipient;
  history: {
    data?: AutomationRecipientHistoryResponse;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  live: boolean;
  onRetry: () => void;
}) {
  if (!live && !history.data)
    return (
      <Notice tone="warning" title="History is not cached">
        Reconnect to read this recipient's revision history.
      </Notice>
    );
  if (history.isPending && !history.data)
    return (
      <p className="border-t border-border pt-4 text-sm text-muted" role="status">
        Loading recipient history…
      </p>
    );
  if (history.isError && !history.data)
    return (
      <Notice tone="danger" title="History could not load">
        {automationRecipientErrorMessage(history.error)}{" "}
        <button type="button" className="ml-1 min-h-11 font-bold underline" onClick={onRetry}>
          Try again
        </button>
      </Notice>
    );
  if (!history.data) return null;
  return (
    <div className="border-t border-border pt-4">
      <h3 className="font-bold">Immutable history</h3>
      <p className="mt-1 text-sm text-muted">
        Current revision {history.data.current_version ?? recipient.version}. Each entry records who
        changed the destination and when — the address itself stays masked.
      </p>
      <ol className="mt-3 space-y-2">
        {history.data.revisions.map((revision) => (
          <li
            key={revision.revision_id}
            className="rounded-md border border-border bg-surface-raised p-3 text-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-bold">
                Revision {revision.version} · {revisionActionLabel(revision.action)}
              </span>
              <span className="text-muted">{formatDate(revision.created_at)}</span>
            </div>
            <p className="mt-1 break-words text-muted">
              {revision.label} · {revision.destination_masked} · {revision.actor.role} ·{" "}
              {revision.revision_id}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AutomationsLink() {
  return (
    <Link
      to="/settings/configuration/automations"
      className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-bold text-muted hover:text-foreground focus-visible:outline-focus"
    >
      <LinkIcon className="size-4" aria-hidden="true" />
      Back to automations
    </Link>
  );
}

function OfflineNotice() {
  return (
    <Notice tone="warning" title="Offline — configuration is read-only">
      Cached recipients remain readable when available. Reconnect before adding, editing, or
      retiring one; no mutation is queued.
    </Notice>
  );
}

function StatusPill({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-bold ${active ? "bg-ok-soft text-ok" : "bg-surface-muted text-muted"}`}
    >
      {children}
    </span>
  );
}

function revisionActionLabel(action: AutomationRecipient["action"]): string {
  if (action === "create") return "created";
  if (action === "retire") return "retired";
  return "revised";
}

function ReloadButton() {
  return (
    <button
      type="button"
      className="ml-1 min-h-11 font-bold underline underline-offset-4 focus-visible:outline-focus"
      onClick={() => window.location.reload()}
    >
      Reload
    </button>
  );
}

function ConfigurationOffline() {
  return (
    <Section>
      <ErrorState
        title="Reconnect to open recipients"
        message="Recipient configuration is not available offline yet. Reconnect to load cached-safe settings; no configuration change will be queued."
      />
    </Section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "unknown time"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-5xl space-y-6 pb-6">{children}</section>;
}
