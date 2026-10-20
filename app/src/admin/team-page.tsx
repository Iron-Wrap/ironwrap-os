import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Info, UserPlus, Users } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { Status } from "../components/ui/status";
import { cn } from "../lib/cn";
import { appRoles, roleLabel, type AppRole } from "../lib/roles";
import { accessConflictOf, adminErrorMessage, listAppUsers, provisionAppUser } from "./admin-api";
import {
  appUsersQueryKey,
  type AccessConflict,
  type AppUser,
  type AppUserListResponse,
} from "./admin-contracts";
import { AdminPageHeader } from "./admin-shell";
import {
  PAIR_AGAIN,
  REMOVE_EXPLAINS,
  REMOVING_EXPLAINS,
  cannotApplyLine,
  changedElsewhere,
  conflictLine,
  firstName,
  whatTheChangeDoes,
} from "./team-access-copy";

const ROLE_HELP: Readonly<Record<AppRole, string>> = {
  owner: "Everything, including money and company setup.",
  ops: "Runs the day: sees every desk, changes no money.",
  sales: "Leads and quotes only.",
  production: "The job runway and crew scheduling.",
  accounting: "The money desk and QuickBooks only.",
  field: "The Field Companion on a paired phone. Needed before you can pair a device.",
};

export function TeamPage() {
  return (
    <RoleGuard surface="owner">
      <TeamContent />
    </RoleGuard>
  );
}

/**
 * A change to one person's access that this page holds and has not saved. It lives in page state:
 * hiding the person's access keeps it, leaving the page drops it. `seen` is the person's access as
 * this page showed it when the change was decided; the panel shows it and every write names its
 * version, so a change made elsewhere meanwhile is refused (409) instead of overwritten.
 */
interface AccessDraft {
  seen: AppUser;
  change: { kind: "role"; role: AppRole } | { kind: "remove" } | null;
  conflict: {
    /** What the Worker said moved; null when its answer could not be read. */
    info: AccessConflict | null;
    /** The access this page showed when the change was refused. */
    refused: AppUser;
    state: "stale" | "failed" | "offline" | "reloaded";
    reloading: boolean;
    /**
     * When this page last heard from the Worker about the person (the refusal, then the reload):
     * the clock the "when" in the copy is read against, so render stays pure.
     */
    observedAt: number;
  } | null;
}

type DraftUpdate = (draft: AccessDraft | undefined) => AccessDraft | undefined;

/** The draft against the access just reloaded: its change kept unless that is already true. */
function reloadedDraft(draft: AccessDraft, fresh: AppUser, observedAt: number): AccessDraft {
  const change = draft.change;
  const settled =
    (change?.kind === "role" && change.role === fresh.role) ||
    (change?.kind === "remove" && !fresh.active);
  return {
    seen: fresh,
    change: settled ? null : change,
    conflict: draft.conflict && {
      ...draft.conflict,
      state: "reloaded",
      reloading: false,
      observedAt,
    },
  };
}

function TeamContent() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canManage = !isOfflineSession(session);
  const listKey = appUsersQueryKey(session.tenant.id);
  const users = useQuery({
    queryKey: listKey,
    queryFn: () => listAppUsers(),
    enabled: canManage,
  });
  const [drafts, setDrafts] = useState<Readonly<Record<string, AccessDraft>>>({});
  const [openUserId, setOpenUserId] = useState<string | null>(null);

  if (!canManage) {
    return (
      <Section>
        <ErrorState
          title="Reconnect before changing who has access"
          message="Adding or removing an account changes who can sign in, so it needs a live connection."
        />
      </Section>
    );
  }
  if (users.isPending) return <LoadingState label="Loading your people…" />;
  // A failed background refresh keeps the list it already has, and any change held on it.
  if (!users.data) {
    return (
      <Section>
        <ErrorState
          title="Your people could not load"
          message={adminErrorMessage(users.error)}
          onRetry={() => void users.refetch()}
        />
      </Section>
    );
  }

  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey });
  const updateDraft = (userId: string, update: DraftUpdate) =>
    setDrafts((all) => {
      const { [userId]: current, ...rest } = all;
      const next = update(current);
      return next ? { ...rest, [userId]: next } : rest;
    });
  const storeRow = (row: AppUser) =>
    queryClient.setQueryData<AppUserListResponse>(listKey, (list) =>
      list
        ? { ...list, users: list.users.map((user) => (user.user_id === row.user_id ? row : user)) }
        : list,
    );
  const reload = async (userId: string) => {
    const conflictState =
      (state: Partial<NonNullable<AccessDraft["conflict"]>>): DraftUpdate =>
      (draft) =>
        draft?.conflict ? { ...draft, conflict: { ...draft.conflict, ...state } } : draft;
    updateDraft(userId, conflictState({ reloading: true }));
    let list: AppUserListResponse;
    try {
      list = await listAppUsers();
    } catch {
      updateDraft(
        userId,
        conflictState({
          reloading: false,
          state: navigator.onLine === false ? "offline" : "failed",
        }),
      );
      return;
    }
    queryClient.setQueryData(listKey, list);
    const fresh = list.users.find((user) => user.user_id === userId);
    const observedAt = Date.now();
    updateDraft(userId, (draft) =>
      draft && fresh ? reloadedDraft(draft, fresh, observedAt) : undefined,
    );
  };

  return (
    <Section>
      <AdminPageHeader
        icon={<Users className="size-6 text-accent" aria-hidden="true" />}
        title="People"
        description="Choose what each person can do. Nobody can change their own access."
      />
      <AddTeammate onAdded={refresh} />
      <TeamList
        users={users.data.users}
        drafts={drafts}
        openUserId={openUserId}
        onToggle={(userId) => setOpenUserId((open) => (open === userId ? null : userId))}
        updateDraft={updateDraft}
        onSaved={storeRow}
        onReload={(userId) => void reload(userId)}
      />
    </Section>
  );
}

function AddTeammate({ onAdded }: { onAdded: () => void }) {
  const session = useSession();
  const emailId = useId();
  const nameId = useId();
  const roleId = useId();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<AppRole>("sales");
  const [added, setAdded] = useState<string>();

  const add = useMutation({
    mutationFn: () => provisionAppUser(session, { email, displayName, role, active: true }),
    onSuccess: (result) => {
      setAdded(result.user.display_name);
      setEmail("");
      setDisplayName("");
      onAdded();
    },
  });

  const ready = email.trim().length > 3 && displayName.trim().length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add someone</CardTitle>
        <CardDescription>
          They get access straight away and sign in from the same address as you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setAdded(undefined);
            add.mutate();
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={nameId} className="block text-sm font-bold">
                Their name
              </label>
              <Input
                id={nameId}
                value={displayName}
                autoComplete="name"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={emailId} className="block text-sm font-bold">
                Their work email
              </label>
              <Input
                id={emailId}
                type="email"
                inputMode="email"
                value={email}
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor={roleId} className="block text-sm font-bold">
              What they can see
            </label>
            <Select
              id={roleId}
              value={role}
              onChange={(event) => setRole(event.target.value as AppRole)}
            >
              {appRoles.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value)}
                </option>
              ))}
            </Select>
            <p className="text-xs leading-5 text-muted">{ROLE_HELP[role]}</p>
          </div>

          {add.isError ? (
            <Notice tone="danger" title="That person was not added">
              {adminErrorMessage(add.error)}
            </Notice>
          ) : null}
          {added ? (
            <Notice tone="success" title={`${added} can sign in now`}>
              They use the same sign-in link page as you, with their own email address.
            </Notice>
          ) : null}

          {/* Secondary: an open person's access panel carries the page's one primary action. */}
          <Button
            type="submit"
            variant="secondary"
            fullWidth
            busy={add.isPending}
            disabled={!ready}
          >
            <UserPlus aria-hidden="true" />
            Add to the company
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TeamList({
  users,
  drafts,
  openUserId,
  onToggle,
  updateDraft,
  onSaved,
  onReload,
}: {
  users: AppUser[];
  drafts: Readonly<Record<string, AccessDraft>>;
  openUserId: string | null;
  onToggle: (userId: string) => void;
  updateDraft: (userId: string, update: DraftUpdate) => void;
  onSaved: (row: AppUser) => void;
  onReload: (userId: string) => void;
}) {
  if (users.length === 0) {
    return (
      <EmptyState
        title="Nobody has been added yet"
        message="Add the people who work here above. Each of them signs in with their own email."
      />
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Who has access</CardTitle>
        <CardDescription>
          {users.length} {users.length === 1 ? "account" : "accounts"}.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y divide-border border-t border-border">
        {users.map((user) => (
          <TeamRow
            key={user.user_id}
            user={user}
            draft={drafts[user.user_id]}
            open={openUserId === user.user_id}
            onToggle={() => onToggle(user.user_id)}
            updateDraft={(update) => updateDraft(user.user_id, update)}
            onSaved={onSaved}
            onReload={() => onReload(user.user_id)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

type WriteIntent = "save" | "remove" | "restore";

function TeamRow({
  user,
  draft,
  open,
  onToggle,
  updateDraft,
  onSaved,
  onReload,
}: {
  user: AppUser;
  draft: AccessDraft | undefined;
  open: boolean;
  onToggle: () => void;
  updateDraft: (update: DraftUpdate) => void;
  onSaved: (row: AppUser) => void;
  onReload: () => void;
}) {
  const session = useSession();
  const panelId = useId();
  // While a change is held, the row shows the access it was decided on, not a later refresh.
  const shown = draft?.seen ?? user;
  const write = useMutation({
    mutationFn: (input: { intent: WriteIntent; role: AppRole; active: boolean; seen: AppUser }) =>
      provisionAppUser(session, {
        email: input.seen.email,
        displayName: input.seen.display_name,
        role: input.role,
        active: input.active,
        expectedAccessVersion: input.seen.access_version,
      }),
    onSuccess: ({ user: saved }, input) => {
      const row: AppUser = {
        ...input.seen,
        display_name: saved.display_name,
        role: saved.role,
        active: saved.active,
        access_version: saved.access_version,
      };
      onSaved(row);
      // Giving access back is a decision of its own: a role change waiting for it stays, now
      // decided on the version the restore produced, and still needs Save.
      updateDraft((current) =>
        input.intent === "restore" && current?.change?.kind === "role"
          ? { seen: row, change: current.change, conflict: null }
          : undefined,
      );
    },
    onError: (error, input) => {
      const info = accessConflictOf(error);
      if (info === undefined) return;
      // A remove, or a role change this page holds, waits for the person's next decision. With
      // nothing held the page reloads in place and shows no conflict line. (`draft` is the one this
      // write was made from.)
      const held = input.intent === "remove" || Boolean(draft?.change);
      const observedAt = Date.now();
      updateDraft((current) => ({
        seen: current?.seen ?? input.seen,
        change: input.intent === "remove" ? { kind: "remove" } : (current?.change ?? null),
        conflict: { info, refused: input.seen, state: "stale", reloading: false, observedAt },
      }));
      if (!held) onReload();
    },
  });
  const busy = write.isPending ? (write.variables?.intent ?? null) : null;
  const failure =
    write.isError && accessConflictOf(write.error) === undefined
      ? adminErrorMessage(write.error)
      : null;

  const chooseRole = (role: AppRole) => {
    write.reset();
    updateDraft((current) => {
      const seen = current?.seen ?? user;
      const change = role === seen.role ? null : { kind: "role" as const, role };
      return change || current?.conflict
        ? { seen, change, conflict: current?.conflict ?? null }
        : undefined;
    });
  };

  // After a reload, a change to whether they can sign in is marked beside the access chip; a
  // removal that leaves a held role change unable to apply is said in the panel instead.
  const conflict = draft?.conflict;
  const accessChanged =
    conflict?.state === "reloaded" &&
    conflict.refused.active !== shown.active &&
    !(draft?.change?.kind === "role" && !shown.active);

  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-bold">
            <span className={cn("truncate", !shown.active && "text-muted")}>
              {shown.display_name}
            </span>
            {shown.is_self ? (
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-bold text-muted">
                You
              </span>
            ) : null}
            {draft?.change && !open ? <Status kind="local">Not saved</Status> : null}
          </p>
          <p className="mt-0.5 truncate text-sm text-muted">
            {roleLabel(shown.role)} · {shown.email}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {shown.active ? (
            <Status kind="confirmed">Active</Status>
          ) : (
            <Status kind="retired">No access</Status>
          )}
          {accessChanged ? (
            <span className="text-xs text-muted">
              {changedElsewhere(conflict.info, conflict.observedAt)}
            </span>
          ) : null}
          {shown.is_self ? (
            <p className="text-sm text-muted">Nobody can change their own access.</p>
          ) : (
            <Button
              type="button"
              variant="quiet"
              size="compact"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={onToggle}
            >
              {open ? "Hide access" : "See access"}
              <span className="sr-only"> for {shown.display_name}</span>
              {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            </Button>
          )}
        </div>
      </div>
      {open && !shown.is_self ? (
        <AccessPanel
          id={panelId}
          person={shown}
          draft={draft}
          busy={busy}
          failure={failure}
          onChooseRole={chooseRole}
          onSave={(role) => write.mutate({ intent: "save", role, active: true, seen: shown })}
          onRemove={() =>
            write.mutate({ intent: "remove", role: shown.role, active: false, seen: shown })
          }
          onRestore={() =>
            write.mutate({ intent: "restore", role: shown.role, active: true, seen: shown })
          }
          onReload={onReload}
        />
      ) : null}
    </div>
  );
}

/**
 * One person's access (SET-03 "Access conflict states", frozen build 7): the role choice saved by
 * an explicit Save, removing and giving access back, and the states a change refused because the
 * access moved elsewhere goes through. Each state has exactly one primary action; a next step that
 * waits on something is a disabled secondary button that says what it waits for.
 */
function AccessPanel({
  id,
  person,
  draft,
  busy,
  failure,
  onChooseRole,
  onSave,
  onRemove,
  onRestore,
  onReload,
}: {
  id: string;
  person: AppUser;
  draft: AccessDraft | undefined;
  busy: WriteIntent | null;
  failure: string | null;
  onChooseRole: (role: AppRole) => void;
  onSave: (role: AppRole) => void;
  onRemove: () => void;
  onRestore: () => void;
  onReload: () => void;
}) {
  const now = draft?.conflict?.observedAt ?? 0;
  const first = firstName(person.display_name);
  const change = draft?.change ?? null;
  const conflict = draft?.conflict ?? null;
  // A refused change with nothing held reloads in place (TeamRow) and shows no conflict line.
  const reloadingInPlace = conflict?.state === "stale" && change === null;
  const unresolved =
    conflict && conflict.state !== "reloaded" && !reloadingInPlace ? conflict : null;
  const pendingRole = change?.kind === "role" ? change.role : null;
  const pendingRemove = change?.kind === "remove";

  // The button a person pressed is often gone in the state it leads to (Save becomes Reload,
  // Reload becomes Save). Focus then falls to the page; hand it to this state's primary action,
  // or the role choice, rather than to the top of the page. Focus held anywhere else is left alone.
  const panelRef = useRef<HTMLDivElement>(null);
  const stateKey = `${person.active}:${change?.kind ?? "none"}:${conflict?.state ?? "none"}`;
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>('button[data-variant="primary"]:not(:disabled)') ??
      panel?.querySelector<HTMLElement>("input[type=radio]:checked:not(:disabled)");
    target?.focus();
  }, [stateKey]);

  const removeLine = <EditLine lead={`Remove ${first} from the team:`}>{REMOVE_EXPLAINS}</EditLine>;
  const hadAccess = `they can sign in again with the access they had (${roleLabel(person.role)}); ${PAIR_AGAIN}.`;

  let body: ReactNode;
  if (unresolved) {
    const keepUntil = pendingRemove ? "remove them" : "save it";
    const reloadLabel =
      unresolved.state === "stale" ? `Reload ${first}’s access` : `Reload ${first}’s access again`;
    const kept = change ? `; your change is kept until you ${keepUntil} or leave this page` : "";
    const statusLine =
      unresolved.state === "stale"
        ? conflictLine(person.display_name, unresolved.info, unresolved.refused, now)
        : unresolved.state === "failed"
          ? `${first}’s access did not reload${kept}.`
          : `You are offline, so ${first}’s access cannot reload${kept}. When you’re back online, reload their access.`;
    const nextStep = pendingRemove
      ? `Remove ${first} from the team · after reload`
      : pendingRole && unresolved.state !== "stale"
        ? `Save ${first}’s access · after reload`
        : null;
    body = (
      <>
        {person.active ? (
          <>
            <RoleChoice
              person={person}
              first={first}
              pendingRole={pendingRole}
              locked
              onChoose={onChooseRole}
            />
            <hr className="border-border" />
          </>
        ) : null}
        {pendingRemove ? (
          <div className="space-y-1">
            <PendingLine>Your change: remove {first} from the team.</PendingLine>
            <p className="text-sm text-muted">{REMOVING_EXPLAINS}</p>
          </div>
        ) : null}
        {!person.active && pendingRole ? (
          <PendingLine>
            Your change: {whatTheChangeDoes(`${first}’s`, person.role, pendingRole)}.
          </PendingLine>
        ) : null}
        <InfoLine>{statusLine}</InfoLine>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className="whitespace-normal"
            busy={unresolved.reloading}
            onClick={onReload}
          >
            {reloadLabel}
          </Button>
          {nextStep ? (
            <Button
              type="button"
              variant="secondary"
              disabled
              className={cn("whitespace-normal", pendingRemove && "ml-auto")}
            >
              {nextStep}
            </Button>
          ) : null}
        </div>
        <EditLine lead={`${reloadLabel}:`}>
          {change
            ? `shows their access as it is now and keeps your change until you ${keepUntil} or leave this page. It does not undo anything.`
            : "shows their access as it is now. It does not undo anything."}
        </EditLine>
      </>
    );
  } else if (!person.active) {
    const restoreBusy = busy === "restore" || reloadingInPlace;
    body = pendingRole ? (
      <>
        <PendingLine>
          Your change: {whatTheChangeDoes(`${first}’s`, person.role, pendingRole)}.
        </PendingLine>
        <hr className="border-border" />
        <InfoLine>{cannotApplyLine(person.display_name, conflict?.info ?? null, now)}</InfoLine>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className="whitespace-normal"
            busy={restoreBusy}
            onClick={onRestore}
          >
            Give {first} access back
          </Button>
          <Button type="button" variant="secondary" className="whitespace-normal" disabled>
            Save {first}’s access · after they’re back
          </Button>
        </div>
        <EditLine lead={`Give ${first} access back:`}>
          {hadAccess} Then save to add your change:{" "}
          {whatTheChangeDoes("their", person.role, pendingRole)}.
        </EditLine>
      </>
    ) : (
      <>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            className="whitespace-normal"
            busy={restoreBusy}
            onClick={onRestore}
          >
            Give {first} access back
          </Button>
        </div>
        <EditLine lead={`Give ${first} access back:`}>{hadAccess}</EditLine>
      </>
    );
  } else {
    const changedRole =
      conflict?.state === "reloaded" && conflict.refused.role !== person.role ? person.role : null;
    body = (
      <>
        <RoleChoice
          person={person}
          first={first}
          pendingRole={pendingRole}
          locked={false}
          changedRole={changedRole}
          changedLabel={changedElsewhere(conflict?.info ?? null, now)}
          onChoose={onChooseRole}
        />
        <hr className="border-border" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {pendingRole ? (
            <>
              <Button
                type="button"
                className="whitespace-normal"
                busy={busy === "save"}
                onClick={() => onSave(pendingRole)}
              >
                Save {first}’s access
              </Button>
              {/* The line wraps before the buttons do, so Remove keeps its place at the end. */}
              <p className="min-w-0 flex-1 basis-56 text-sm">
                Your change is not saved yet:{" "}
                {whatTheChangeDoes(`${first}’s`, person.role, pendingRole)}.
              </p>
            </>
          ) : null}
          {pendingRemove ? (
            <div className="min-w-0 flex-1 basis-56">
              <PendingLine>Your change: remove {first} from the team.</PendingLine>
            </div>
          ) : null}
          <Button
            type="button"
            variant={pendingRemove ? "primary" : "secondary"}
            className="ml-auto whitespace-normal"
            busy={busy === "remove"}
            onClick={onRemove}
          >
            Remove {first} from the team
          </Button>
        </div>
        {removeLine}
      </>
    );
  }

  return (
    <div
      ref={panelRef}
      id={id}
      role="region"
      aria-label={`${person.display_name}’s access`}
      className="mt-3 space-y-4 rounded-[var(--radius-card)] border border-border bg-surface-sunk p-4 sm:p-5"
    >
      {body}
      {failure ? (
        <p className="text-sm font-semibold text-danger" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

function RoleChoice({
  person,
  first,
  pendingRole,
  locked,
  changedRole = null,
  changedLabel,
  onChoose,
}: {
  person: AppUser;
  first: string;
  pendingRole: AppRole | null;
  /** The access shown is out of date: only the pending choice stays as it is until a reload. */
  locked: boolean;
  /** The role chosen elsewhere, labelled after a reload. */
  changedRole?: AppRole | null;
  changedLabel?: string;
  onChoose: (role: AppRole) => void;
}) {
  const selected = pendingRole ?? person.role;
  return (
    <fieldset className="min-w-0">
      <legend className="font-semibold">What {first} can do</legend>
      <div className="mt-2">
        {appRoles.map((role) => {
          const checked = role === selected;
          const greyed = locked && !(checked && pendingRole);
          return (
            <label
              key={role}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 py-1.5",
                greyed && "cursor-default text-faint",
              )}
            >
              <input
                type="radio"
                className="mt-1 size-4 shrink-0"
                name={`access-role-${person.user_id}`}
                value={role}
                checked={checked}
                disabled={greyed}
                onChange={() => onChoose(role)}
              />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold">{roleLabel(role)}</span>
                  {checked && pendingRole ? <Status kind="local">Not saved</Status> : null}
                </span>
                <span className={cn("block text-sm", greyed ? "text-faint" : "text-muted")}>
                  {ROLE_HELP[role]}
                </span>
                {role === changedRole ? (
                  <span className="block text-xs text-muted">{changedLabel}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {locked && pendingRole ? (
        <p className="mt-2 text-xs text-muted">The greyed roles wait until their access reloads.</p>
      ) : null}
    </fieldset>
  );
}

function PendingLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <Status kind="local">Not saved</Status>
      <span>{children}</span>
    </p>
  );
}

/** Ink text with the info glyph: a conflict is information, never an error. */
function InfoLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-2.5">
      <Info className="mt-0.5 size-[1.125rem] shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** What a button does, led by its own label. */
function EditLine({ lead, children }: { lead: string; children: ReactNode }) {
  return (
    <p className="text-sm text-muted">
      <strong className="font-semibold text-foreground">{lead}</strong> {children}
    </p>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-4xl space-y-6 pb-6">{children}</section>;
}
