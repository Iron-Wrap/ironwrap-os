import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { clearSessionSnapshot, isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { sessionQueryKey } from "../auth/session-query";
import { apiCommand } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { cn } from "../lib/cn";
import { navigationForRole, roleLabel, type NavigationItem } from "../lib/roles";
import { Button } from "./ui/button";
import { SystemStatus } from "./system-status";

const activeClasses: Record<NavigationItem["activeColor"], string> = {
  accent: "bg-accent text-accent-foreground",
  ok: "bg-ok-soft text-ok",
  warning: "bg-warning-soft text-warning",
};

export function AppShell() {
  const session = useSession();
  const items = navigationForRole(session.user.role);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const offlineSession = isOfflineSession(session);

  async function signOut() {
    if (offlineSession) return;
    setSigningOut(true);
    try {
      await apiCommand({ path: API_PATHS.logout, csrfToken: session.csrf_token });
      await clearSessionSnapshot();
      queryClient.removeQueries({ queryKey: sessionQueryKey });
      await navigate({ to: "/", replace: true });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <header className="safe-top sticky top-0 z-40 border-b bg-surface/95 backdrop-blur-lg">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link to="/today" className="flex min-w-0 items-center gap-3 rounded-md">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-foreground text-background">
              <ShieldCheck className="size-5 text-accent" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-extrabold tracking-[-0.02em]">
                {session.tenant.brand}
              </span>
              <span className="block truncate text-xs text-muted">
                {roleLabel(session.user.role)}
              </span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Sign out"
              title={offlineSession ? "Reconnect before signing out" : "Sign out"}
              disabled={offlineSession}
              busy={signingOut}
              onClick={() => void signOut()}
            >
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </div>
        <SystemStatus />
      </header>

      <div className="mx-auto grid max-w-7xl lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden border-r px-3 py-6 lg:block" aria-label="Main navigation">
          <nav className="sticky top-24 space-y-2">
            {items.map((item) => (
              <DesktopNavItem key={item.to} item={item} />
            ))}
          </nav>
        </aside>
        <main id="main-content" className="min-w-0 px-4 py-6 pb-32 sm:px-6 sm:py-8 lg:pb-10">
          <Outlet />
        </main>
      </div>

      <nav
        className="safe-bottom fixed inset-x-0 bottom-0 z-50 border-t bg-surface/96 px-2 pt-2 shadow-[0_-8px_24px_oklch(0_0_0/0.08)] backdrop-blur-lg lg:hidden"
        aria-label="Main navigation"
      >
        <div className="mx-auto grid max-w-lg auto-cols-fr grid-flow-col gap-1">
          {items.map((item) => (
            <MobileNavItem key={item.to} item={item} />
          ))}
        </div>
      </nav>
    </div>
  );
}

function DesktopNavItem({ item }: { item: NavigationItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className="flex min-h-14 items-center gap-3 rounded-lg px-4 font-bold text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
      activeProps={{ className: activeClasses[item.activeColor] }}
    >
      <Icon className="size-5" aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function MobileNavItem({ item }: { item: NavigationItem }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "flex min-h-16 min-w-14 flex-col items-center justify-center gap-1 rounded-lg px-2 text-[0.6875rem] font-bold text-muted transition-colors",
      )}
      activeProps={{ className: activeClasses[item.activeColor] }}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );
}
