import { useQuery } from "@tanstack/react-query";
import { Building2, Settings, Smartphone, Users } from "lucide-react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { loadSetupProgress } from "./admin-api";
import { setupProgressQueryKey, type SetupStep } from "./admin-contracts";
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
  const progress = useQuery({
    queryKey: setupProgressQueryKey(session.tenant.id),
    queryFn: () => loadSetupProgress(),
    enabled: live,
  });
  const steps = new Map(progress.data?.progress.steps.map((step) => [step.id, step]));

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
          <CardDescription>
            {progress.data
              ? `${progress.data.progress.done} of ${progress.data.progress.total} setup areas complete.`
              : "Do these in order the first time."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SetupLink
            to="/settings/company"
            icon={Building2}
            title="Company details"
            description="Name, logo, address, and what customers see on your request form."
            status={setupStatus(steps.get("company"))}
          />
          <SetupLink
            to="/settings/team"
            icon={Users}
            title="People"
            description="Add the people who work here and choose what each of them sees."
            status={setupStatus(steps.get("people"))}
          />
          <SetupLink
            to="/settings/devices"
            icon={Smartphone}
            title="Crew phones"
            description="Pair a phone to a crew account so it can work offline on site."
            status={setupStatus(steps.get("crew_phones"))}
          />
        </CardContent>
      </Card>
    </section>
  );
}

function setupStatus(step: SetupStep | undefined): string | undefined {
  if (!step) return undefined;
  return {
    done: "Done",
    in_progress: "In progress",
    skipped: "Not needed",
    later: "Later",
  }[step.status];
}
