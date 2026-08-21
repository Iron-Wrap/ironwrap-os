import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Boxes, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { clearSessionSnapshot, isOfflineSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { useSession } from "../auth/session-context";
import { sessionQueryKey } from "../auth/session-query";
import { apiCommand } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { cn } from "../lib/cn";
import { navigationForRole, roleCanAccess, roleLabel, type NavigationItem } from "../lib/roles";
import { SafetyActionPanel } from "../field/safety-action-panel";
import { Button } from "./ui/button";
import { SystemStatus } from "./system-status";

const desktopActiveClassName =
  "border-chrome-border bg-chrome-raised !text-chrome-foreground shadow-[inset_3px_0_0_var(--accent)]";
const mobileActiveClassName =
  "bg-surface-muted !text-foreground shadow-[inset_0_3px_0_var(--accent)]";

export function AppShell() {
  const session = useSession();
  const items = navigationForRole(session.user.role);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [signingOut, setSigningOut] = useState(false);
  const offlineSession = isOfflineSession(session);

  async function signOut() {
    if (offlineSession) return;
    setSigningOut(true);
    try {
      await apiCommand({
        path: API_PATHS.logout,
        csrfToken: session.csrf_token,
        deviceProof: session.user.role === "field" ? getDeviceSecret : undefined,
      });
      await clearSessionSnapshot();
      queryClient.removeQueries({ queryKey: sessionQueryKey });
      await navigate({ to: "/", replace: true });
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[60] -translate-y-24 rounded-md bg-foreground px-4 py-3 font-bold text-background transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>
      <header className="safe-top sticky top-0 z-40 border-b bg-surface/92 shadow-[0_1px_0_color-mix(in_oklch,var(--foreground)_5%,transparent)] backdrop-blur-xl">
        <div className="mx-auto grid min-h-14 max-w-[100rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 px-4 sm:min-h-16 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-x-3 sm:px-6">
          <Link
            to="/now"
            className="group col-start-1 row-start-1 flex min-h-11 w-fit min-w-0 items-center gap-3 justify-self-start rounded-lg focus-visible:outline-offset-4"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-foreground/15 bg-foreground text-background shadow-sm transition-transform group-hover:-translate-y-0.5 sm:size-10">
              <ShieldCheck className="size-[1.125rem] text-accent sm:size-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-extrabold tracking-[-0.02em]">
                {session.tenant.brand}
              </span>
              <span className="flex items-center gap-1.5 truncate text-xs text-muted">
                <span className="hidden sm:inline">Operations</span>
                <span className="hidden text-border-strong sm:inline" aria-hidden="true">
                  /
                </span>
                <span>{roleLabel(session.user.role)}</span>
              </span>
            </span>
          </Link>
          {roleCanAccess(session.user.role, "inventory") ? (
            <Link
              to="/inventory"
              className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-bold text-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label="Open inventory"
            >
              <Boxes className="size-5" aria-hidden="true" />
              <span className="hidden sm:inline">Inventory</span>
            </Link>
          ) : null}
          <SystemStatus />
          <Button
            className="col-start-2 row-start-1 sm:col-start-3"
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
      </header>

      <div className="mx-auto grid max-w-[100rem] lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside
          className="hidden min-h-[calc(100dvh-4rem)] border-r border-chrome-border bg-chrome px-3 py-6 text-chrome-foreground lg:block"
          aria-label="Main navigation"
        >
          <nav className="sticky top-20 space-y-1.5">
            <p className="px-3 pb-2 text-[0.6875rem] font-extrabold uppercase tracking-[0.14em] text-chrome-muted">
              Workspace
            </p>
            {items.map((item) => (
              <DesktopNavItem
                key={item.to}
                item={item}
                aliasActive={
                  session.user.role === "field" && pathname === "/today" && item.to === "/now"
                }
              />
            ))}
          </nav>
        </aside>
        <main
          id="main-content"
          tabIndex={-1}
          className="app-main min-w-0 space-y-6 px-4 py-6 pb-28 sm:px-6 sm:py-8 lg:px-8 lg:pb-10 xl:px-10"
        >
          <Outlet />
        </main>
      </div>

      {/* Mounted on every authenticated screen on purpose. Reporting a hazard,
          making an area safe, condemning equipment, and calling for rescue must
          never depend on having a job packet open.

          It is anchored out of the document flow deliberately. In flow after
          <Outlet /> it was pushed down the page every time a route swapped a
          loading state for its real content: a layout shift on every
          authenticated screen, and a rescue call the worker had to scroll a
          whole run sheet to reach. Fixed, nothing above it can move it. */}
      <div className="safe-bottom fixed inset-x-0 bottom-0 z-50 bg-surface/96 shadow-[0_-8px_24px_oklch(0_0_0/0.08)] lg:inset-x-auto lg:bottom-3 lg:left-3 lg:w-[13.5rem] lg:rounded-lg lg:border lg:border-danger/25 lg:bg-chrome-raised lg:p-0 lg:text-chrome-foreground lg:shadow-[0_14px_36px_oklch(0_0_0/0.2)]">
        <div className="flex items-stretch lg:block">
          <details className="group shrink-0 border-t-2 border-danger/45 lg:w-full lg:border-t-0">
            <summary className="flex min-h-16 w-16 cursor-pointer list-none flex-col items-center justify-center gap-1 px-2 text-xs font-black transition-colors hover:bg-danger-soft group-open:bg-danger-soft group-open:text-danger lg:min-h-12 lg:w-full lg:flex-row lg:justify-start lg:gap-2.5 lg:rounded-lg lg:px-3 lg:text-sm [&::-webkit-details-marker]:hidden">
              <ShieldAlert className="size-5 shrink-0 text-danger" aria-hidden="true" />
              <span>Safety</span>
            </summary>
            <div className="safety-action-drawer fixed inset-x-0 max-h-[min(60dvh,36rem)] overflow-y-auto overscroll-contain border-t bg-surface text-foreground shadow-[0_-8px_24px_oklch(0_0_0/0.12)] lg:left-[15rem]">
              <SafetyActionPanel session={session} />
            </div>
          </details>
          <nav
            className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain border-t [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden"
            aria-label="Main navigation"
          >
            <div className="mx-auto flex min-w-full max-w-lg snap-x snap-proximity gap-1 px-1">
              {items.map((item) => (
                <MobileNavItem
                  key={item.to}
                  item={item}
                  aliasActive={
                    session.user.role === "field" && pathname === "/today" && item.to === "/now"
                  }
                />
              ))}
            </div>
          </nav>
        </div>
      </div>
    </div>
  );
}

function DesktopNavItem({ item, aliasActive }: { item: NavigationItem; aliasActive: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "group flex min-h-11 items-center gap-3 rounded-lg border border-transparent px-3 text-sm font-bold text-chrome-muted transition-[background-color,border-color,color,transform] hover:translate-x-0.5 hover:border-chrome-border hover:bg-chrome-raised hover:text-chrome-foreground",
        aliasActive && desktopActiveClassName,
      )}
      aria-current={aliasActive ? "page" : undefined}
      activeProps={{ className: desktopActiveClassName }}
    >
      <Icon
        className="size-[1.125rem] transition-transform group-hover:scale-105"
        aria-hidden="true"
      />
      {item.label}
    </Link>
  );
}

function MobileNavItem({ item, aliasActive }: { item: NavigationItem; aliasActive: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "flex min-h-16 min-w-[3.75rem] flex-1 snap-start flex-col items-center justify-center gap-1 rounded-lg px-1 text-[0.6875rem] font-bold text-muted transition-[background-color,color,transform] active:scale-[0.98]",
        aliasActive && mobileActiveClassName,
      )}
      aria-current={aliasActive ? "page" : undefined}
      activeProps={{ className: mobileActiveClassName }}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="max-w-full truncate">{item.mobileLabel ?? item.label}</span>
    </Link>
  );
}
