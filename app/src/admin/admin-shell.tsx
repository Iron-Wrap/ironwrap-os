import { Link } from "@tanstack/react-router";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { WorkspaceHeader } from "../components/workspace-header";

/**
 * One header for every setup screen. It carries the way back to the setup list, because these
 * screens are reached from there and a phone has no sidebar to return through.
 */
export function AdminPageHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <WorkspaceHeader
      icon={icon}
      title={title}
      description={description}
      actions={action}
      back={
        <Link
          to="/settings"
          className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm font-bold text-muted transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Settings
        </Link>
      }
    />
  );
}

export function SetupLink({
  to,
  icon: Icon,
  title,
  description,
  status,
}: {
  to:
    | "/settings/company"
    | "/settings/team"
    | "/settings/devices"
    | "/settings/integrations"
    | "/settings/configuration";
  icon: LucideIcon;
  title: string;
  description: string;
  status?: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-16 items-center gap-4 rounded-lg border border-border bg-surface-raised p-4 transition-colors hover:border-border-strong hover:bg-surface-muted focus-visible:outline-offset-2 sm:p-5"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-muted">
        <Icon className="size-5 text-accent" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold tracking-[-0.02em]">{title}</span>
        <span className="mt-0.5 block text-sm leading-5 text-muted">{description}</span>
      </span>
      {status ? (
        <span className="shrink-0 rounded-full bg-surface-muted px-2.5 py-1 text-xs font-bold text-muted">
          {status}
        </span>
      ) : null}
    </Link>
  );
}
