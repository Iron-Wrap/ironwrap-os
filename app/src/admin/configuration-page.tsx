import { Link } from "@tanstack/react-router";
import { BellRing, Boxes, FileStack, FileText, SlidersHorizontal } from "lucide-react";

import { RoleGuard } from "../components/role-guard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { AdminPageHeader } from "./admin-shell";

export function ConfigurationPage() {
  return (
    <RoleGuard surface="ownerConfiguration">
      <section className="mx-auto max-w-5xl space-y-6 pb-6">
        <AdminPageHeader
          icon={<SlidersHorizontal className="size-6 text-accent" aria-hidden="true" />}
          title="Owner configuration"
          description="Shape the work model your team uses. Every change is checked by the server, versioned, and safe to review without developer tools."
        />
        <Card>
          <CardHeader>
            <CardTitle>Configuration areas</CardTitle>
            <CardDescription>
              Choose a surface. Read-only cached data can remain visible offline, but configuration
              changes are never queued from an offline session.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <ConfigurationLink
              to="/settings/configuration/pipelines"
              icon={<Boxes className="size-5 text-accent" aria-hidden="true" />}
              title="Pipelines"
              description="Boards, stages, order, and role access."
            />
            <ConfigurationLink
              to="/settings/configuration/fields"
              icon={<FileText className="size-5 text-accent" aria-hidden="true" />}
              title="Fields"
              description="Structured data and its evidence policy."
            />
            <ConfigurationLink
              to="/settings/configuration/documents"
              icon={<FileStack className="size-5 text-accent" aria-hidden="true" />}
              title="Documents"
              description="Contracts, estimates, and lists built from your fields."
            />
            <ConfigurationLink
              to="/settings/configuration/automations"
              icon={<BellRing className="size-5 text-accent" aria-hidden="true" />}
              title="Automations"
              description="What happens when a card enters a stage."
            />
          </CardContent>
        </Card>
      </section>
    </RoleGuard>
  );
}

function ConfigurationLink({
  to,
  icon,
  title,
  description,
}: {
  to:
    | "/settings/configuration/pipelines"
    | "/settings/configuration/fields"
    | "/settings/configuration/documents"
    | "/settings/configuration/automations";
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-32 flex-col justify-between gap-4 rounded-lg border border-border bg-surface-raised p-4 transition-colors hover:border-border-strong hover:bg-surface-muted focus-visible:outline-offset-2"
    >
      <span className="grid size-11 place-items-center rounded-lg bg-surface-muted">{icon}</span>
      <span>
        <span className="block font-extrabold tracking-[-0.02em]">{title}</span>
        <span className="mt-1 block text-sm leading-5 text-muted">{description}</span>
      </span>
    </Link>
  );
}
