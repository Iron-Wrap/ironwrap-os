import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, Users } from "lucide-react";
import { useId, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state-panel";
import { appRoles, roleLabel, type AppRole } from "../lib/roles";
import { adminErrorMessage, listAppUsers, provisionAppUser } from "./admin-api";
import { appUsersQueryKey, type AppUser } from "./admin-contracts";
import { AdminPageHeader } from "./admin-shell";

const ROLE_HELP: Readonly<Record<AppRole, string>> = {
  owner: "Everything, including money and company setup.",
  ops: "Runs the day: sees every desk, changes no money.",
  sales: "Leads and quotes only.",
  production: "The job runway and crew scheduling.",
  accounting: "The money desk and QuickBooks only.",
  field:
    "The crew phone app on a paired phone. Give someone this role before you pair their phone.",
};

export function TeamPage() {
  return (
    <RoleGuard surface="owner">
      <TeamContent />
    </RoleGuard>
  );
}

function TeamContent() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canManage = !isOfflineSession(session);
  const users = useQuery({
    queryKey: appUsersQueryKey(session.tenant.id),
    queryFn: () => listAppUsers(),
    enabled: canManage,
  });

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
  if (users.isError) {
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

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: appUsersQueryKey(session.tenant.id) });

  return (
    <Section>
      <AdminPageHeader
        icon={<Users className="size-6 text-accent" aria-hidden="true" />}
        title="People"
        description="Add the people who work here and choose what each of them sees. They sign in with a link sent to their email, so there is no password to hand out."
      />
      <AddTeammate onAdded={refresh} />
      <TeamList users={users.data.users} onChanged={refresh} />
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

          <Button type="submit" variant="accent" fullWidth busy={add.isPending} disabled={!ready}>
            <UserPlus aria-hidden="true" />
            Add to the team
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TeamList({ users, onChanged }: { users: AppUser[]; onChanged: () => void }) {
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
          <TeamRow key={user.user_id} user={user} onChanged={onChanged} />
        ))}
      </CardContent>
    </Card>
  );
}

function TeamRow({ user, onChanged }: { user: AppUser; onChanged: () => void }) {
  const session = useSession();
  const [confirming, setConfirming] = useState(false);
  const change = useMutation({
    mutationFn: (input: { role: AppRole; active: boolean }) =>
      provisionAppUser(session, {
        email: user.email,
        displayName: user.display_name,
        role: input.role,
        active: input.active,
      }),
    onSuccess: () => {
      setConfirming(false);
      onChanged();
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 font-bold">
          <span className="truncate">{user.display_name}</span>
          {user.is_self ? (
            <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-bold text-muted">
              You
            </span>
          ) : null}
          {user.active ? null : (
            <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs font-bold text-danger">
              No access
            </span>
          )}
        </p>
        <p className="mt-0.5 truncate text-sm text-muted">{user.email}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`role-${user.user_id}`}>
          Role for {user.display_name}
        </label>
        <Select
          id={`role-${user.user_id}`}
          className="w-40"
          value={user.role}
          disabled={user.is_self || change.isPending}
          onChange={(event) =>
            change.mutate({ role: event.target.value as AppRole, active: user.active })
          }
        >
          {appRoles.map((value) => (
            <option key={value} value={value}>
              {roleLabel(value)}
            </option>
          ))}
        </Select>
        {user.is_self ? null : user.active ? (
          confirming ? (
            <>
              <Button
                type="button"
                variant="danger"
                size="compact"
                busy={change.isPending}
                onClick={() => change.mutate({ role: user.role, active: false })}
              >
                Remove access
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="compact"
                onClick={() => setConfirming(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="compact"
              onClick={() => setConfirming(true)}
            >
              Remove access
            </Button>
          )
        ) : (
          <Button
            type="button"
            variant="outline"
            size="compact"
            busy={change.isPending}
            onClick={() => change.mutate({ role: user.role, active: true })}
          >
            Give access back
          </Button>
        )}
      </div>

      {change.isError ? (
        <p className="w-full text-sm font-semibold text-danger" role="alert">
          {adminErrorMessage(change.error)}
        </p>
      ) : null}
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-4xl space-y-6 pb-6">{children}</section>;
}
