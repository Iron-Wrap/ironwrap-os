import { useQuery } from "@tanstack/react-query";
import { Building2, Settings, Smartphone, Users } from "lucide-react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { listAppUsers, loadCompanyProfile } from "./admin-api";
import { appUsersQueryKey, companyProfileQueryKey } from "./admin-contracts";
import { SetupLink } from "./admin-shell";

/**
 * `/settings` used to be crew device pairing and nothing else, which meant the two things a new
 * company must do first — say who it is, and add its people — had no screen at all. It is now the
 * setup list; device pairing kept its own place inside it, at `/settings/devices`.
 */
export function SetupPage() {
  return (
    <RoleGuard surface="owner">
      <OwnerSetup />
    </RoleGuard>
  );
}

function OwnerSetup() {
  const session = useSession();
  const live = !isOfflineSession(session);
  const profile = useQuery({
    queryKey: companyProfileQueryKey(session.tenant.id),
    queryFn: () => loadCompanyProfile(),
    enabled: live,
  });
  const users = useQuery({
    queryKey: appUsersQueryKey(session.tenant.id),
    queryFn: () => listAppUsers(),
    enabled: live,
  });

  const companyStatus = profile.data
    ? profile.data.profile.updated_at
      ? "Set"
      : "Not set yet"
    : undefined;
  const peopleCount = users.data?.users.filter((user) => user.active).length;

  return (
    <section className="mx-auto max-w-4xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="min-w-0 p-5 sm:p-7 lg:p-8">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
              <Settings className="size-6 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="mt-1 text-3xl font-black tracking-[-0.035em] text-balance sm:text-4xl">
                Setup
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
                Everything you set up once: who this company is, who works here, and which phones
                the crew uses.
              </p>
            </div>
          </div>
        </header>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Start here</CardTitle>
          <CardDescription>Do these in order the first time.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SetupLink
            to="/settings/company"
            icon={Building2}
            title="Company details"
            description="Name, logo, address, and what customers see on your request form."
            status={companyStatus}
          />
          <SetupLink
            to="/settings/team"
            icon={Users}
            title="People"
            description="Add the people who work here and choose what each of them sees."
            status={
              peopleCount === undefined
                ? undefined
                : `${peopleCount} ${peopleCount === 1 ? "person" : "people"}`
            }
          />
          <SetupLink
            to="/settings/devices"
            icon={Smartphone}
            title="Crew phones"
            description="Pair a phone to a crew account so it can work offline on site."
          />
        </CardContent>
      </Card>
    </section>
  );
}
