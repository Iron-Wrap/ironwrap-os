import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { ChevronDown, LayoutGrid, LogOut, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { clearSessionSnapshot, isOfflineSession } from "../auth/session";
import { getDeviceSecret } from "../auth/device-credential";
import { useSession } from "../auth/session-context";
import { sessionQueryKey } from "../auth/session-query";
import { apiCommand } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { cn } from "../lib/cn";
import {
  navigationForRole,
  roleLabel,
  type NavigationItem,
  type NavigationWorkspace,
} from "../lib/roles";
import { SafetyActionPanel } from "../field/safety-action-panel";
import { Button } from "./ui/button";
import { SystemStatus } from "./system-status";

const desktopActiveClassName =
  "border-chrome-border bg-chrome-raised !text-chrome-foreground shadow-[inset_0_-2px_0_var(--accent)]";
const mobileActiveClassName =
  "bg-surface-muted !text-foreground shadow-[inset_0_2px_0_var(--accent)]";

/**
 * The company's own logo once an owner has uploaded one, and the product mark until then.
 *
 * It is a plain `<img>` at a fixed public path rather than a query, so no role — including a
 * field device that may be offline — pays a round trip for it, and a company with no logo simply
 * 404s into the fallback.
 */
function CompanyMark({ className }: { className: string }) {
  const [hasLogo, setHasLogo] = useState(true);
  if (!hasLogo) return <ShieldCheck className={className} aria-hidden="true" />;
  return (
    <img
      src={API_PATHS.companyLogo}
      alt=""
      aria-hidden="true"
      className="size-full object-contain p-0.5"
      onError={() => setHasLogo(false)}
    />
  );
}

export function AppShell() {
  const session = useSession();
  const items = navigationForRole(session.user.role);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [signingOut, setSigningOut] = useState(false);
  const offlineSession = isOfflineSession(session);
  const groups = groupNavigation(items);
  const currentItem = navigationItemForPath(items, pathname);
  const primaryItems = items.length <= 4 ? items : items.filter((item) => item.mobilePrimary);
  const hasMore = primaryItems.length < items.length;
  const currentItemIsInMore = hasMore && !primaryItems.some((item) => item.to === currentItem.to);

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
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[15.5rem_minmax(0,1fr)]">
      <a
        href="#main-content"
        className="fixed left-4 top-4 z-[60] -translate-y-24 rounded-md bg-foreground px-4 py-3 font-bold text-background transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>

      <aside
        className="hidden border-r border-chrome-border bg-chrome text-chrome-foreground lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col"
        aria-label="Main navigation"
      >
        <div className="border-b border-chrome-border px-4 py-4">
          <Link
            to="/now"
            className="group flex min-h-11 min-w-0 items-center gap-3 rounded-lg focus-visible:outline-offset-4"
          >
            <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-chrome-border bg-chrome-raised transition-transform group-hover:-translate-y-0.5">
              <CompanyMark className="size-[1.125rem] text-accent" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-extrabold tracking-[-0.02em]">
                {session.tenant.brand}
              </span>
              <span className="block truncate text-xs font-semibold text-chrome-muted">
                IronWrap OS · {roleLabel(session.user.role)}
              </span>
            </span>
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-4">
          <div className="space-y-1.5">
            {groups.map((group) => (
              <DesktopWorkspace key={group.workspace} group={group} currentTo={currentItem.to} />
            ))}
          </div>
        </nav>
      </aside>

      <div className="min-w-0">
        <header className="safe-top sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur-lg">
          <div className="mx-auto grid min-h-14 max-w-[100rem] grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-2 px-4 sm:gap-x-3 sm:px-6 lg:px-8">
            <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3">
              {/* The only "go home" control a phone has, so it carries the 44 px thumb
                  floor the mobile suite enforces; the mark inside stays 20 px. */}
              <Link
                to="/now"
                className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-foreground/10 bg-foreground text-background lg:hidden"
                aria-label={`${session.tenant.brand} home`}
              >
                <CompanyMark className="size-5 text-accent" />
              </Link>
              <p className="truncate text-sm font-bold text-muted">
                <span className="lg:hidden">{session.tenant.brand} · </span>
                <span className="text-foreground">{currentItem.workspace}</span>
                <span className="px-1.5 text-border-strong" aria-hidden="true">
                  /
                </span>
                {currentItem.label}
              </p>
            </div>
            <SystemStatus />
            <Button
              className="col-start-3 row-start-1"
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

        <main
          id="main-content"
          tabIndex={-1}
          className="app-main mx-auto min-w-0 max-w-[100rem] space-y-6 px-4 py-6 pb-28 sm:px-6 sm:py-8 lg:px-8 lg:pb-10 xl:px-10"
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
            <summary className="flex min-h-16 w-16 cursor-pointer list-none flex-col items-center justify-center gap-1 px-2 text-xs font-black transition-colors hover:bg-danger-soft group-open:bg-danger-soft group-open:text-foreground lg:min-h-12 lg:w-full lg:flex-row lg:justify-start lg:gap-2.5 lg:rounded-lg lg:px-3 lg:text-sm [&::-webkit-details-marker]:hidden">
              <ShieldAlert className="size-5 shrink-0 text-danger" aria-hidden="true" />
              <span>Safety</span>
            </summary>
            <div className="safety-action-drawer fixed inset-x-0 max-h-[min(60dvh,36rem)] overflow-y-auto overscroll-contain border-t bg-surface text-foreground shadow-[0_-8px_24px_oklch(0_0_0/0.12)] lg:left-[15.5rem]">
              <SafetyActionPanel session={session} />
            </div>
          </details>
          <nav className="min-w-0 flex-1 border-t lg:hidden" aria-label="Main navigation">
            <div className="mx-auto flex min-w-full max-w-lg gap-1 px-1">
              {primaryItems.map((item) => (
                <MobileNavItem key={item.to} item={item} active={item.to === currentItem.to} />
              ))}
              {hasMore ? (
                <div key={pathname} className="min-w-[4rem] flex-1">
                  <button
                    type="button"
                    popoverTarget="mobile-workspace-popover"
                    aria-controls="mobile-workspace-popover"
                    className={cn(
                      "flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-lg px-1 text-[0.6875rem] font-bold text-muted transition-colors hover:bg-surface-muted active:scale-[0.98]",
                      currentItemIsInMore && mobileActiveClassName,
                    )}
                    aria-label="Open all workspaces"
                  >
                    <LayoutGrid className="size-5" aria-hidden="true" />
                    <span>More</span>
                  </button>
                  <div
                    id="mobile-workspace-popover"
                    popover="auto"
                    onClick={(event) => {
                      if ((event.target as Element).closest("a")) event.currentTarget.hidePopover();
                    }}
                    className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] top-auto z-[60] m-0 max-h-[min(72dvh,40rem)] w-auto overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-3 text-foreground shadow-[0_24px_72px_oklch(0_0_0/0.28)]"
                  >
                    <div className="flex min-h-11 items-center justify-between gap-4 border-b border-border px-1 pb-2">
                      <p className="text-sm font-extrabold">All work</p>
                      <button
                        type="button"
                        popoverTarget="mobile-workspace-popover"
                        popoverTargetAction="hide"
                        className="grid size-10 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-muted hover:text-foreground"
                        aria-label="Close all workspaces"
                      >
                        <X className="size-5" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="space-y-4 pt-3">
                      {groups.map((group) => (
                        <section key={group.workspace}>
                          <h2 className="mb-1 px-2 text-xs font-bold text-muted">
                            {group.workspace}
                          </h2>
                          <div className="grid grid-cols-2 gap-1">
                            {group.items.map((item) => (
                              <MobileDrawerItem
                                key={item.to}
                                item={item}
                                active={item.to === currentItem.to}
                              />
                            ))}
                          </div>
                        </section>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </nav>
        </div>
      </div>
    </div>
  );
}

function DesktopWorkspace({
  group,
  currentTo,
}: {
  group: { workspace: NavigationWorkspace; items: NavigationItem[] };
  currentTo: NavigationItem["to"];
}) {
  const active = group.items.some((item) => item.to === currentTo);
  if (group.items.length === 1) {
    return <DesktopNavItem item={group.items[0]!} active={active} />;
  }
  const Icon = group.items[0]!.icon;
  return (
    <details open={active} className="group/workspace">
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-3 text-sm font-bold text-chrome-muted transition-colors hover:bg-chrome-raised hover:text-chrome-foreground [&::-webkit-details-marker]:hidden",
          active && "text-chrome-foreground",
        )}
      >
        <Icon className="size-[1.125rem] shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{group.workspace}</span>
        <ChevronDown
          className="size-4 shrink-0 transition-transform group-open/workspace:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="ml-[1.35rem] mt-1 space-y-0.5 border-l border-chrome-border pl-2">
        {group.items.map((item) => (
          <DesktopNavItem key={item.to} item={item} active={item.to === currentTo} nested />
        ))}
      </div>
    </details>
  );
}

function DesktopNavItem({
  item,
  active,
  nested = false,
}: {
  item: NavigationItem;
  active: boolean;
  nested?: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "group flex min-h-11 items-center gap-3 rounded-lg border border-transparent px-3 text-sm font-bold text-chrome-muted transition-[background-color,border-color,color,transform] hover:translate-x-0.5 hover:border-chrome-border hover:bg-chrome-raised hover:text-chrome-foreground",
        nested && "min-h-9 gap-0 px-3 text-[0.8125rem]",
        active && desktopActiveClassName,
      )}
      aria-current={active ? "page" : undefined}
    >
      {!nested ? (
        <Icon
          className="size-[1.125rem] transition-transform group-hover:scale-105"
          aria-hidden="true"
        />
      ) : null}
      {item.label}
    </Link>
  );
}

function MobileNavItem({ item, active }: { item: NavigationItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "flex min-h-16 min-w-[3.75rem] flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[0.6875rem] font-bold text-muted transition-[background-color,color,transform] active:scale-[0.98]",
        active && mobileActiveClassName,
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="max-w-full truncate">{item.mobileLabel ?? item.label}</span>
    </Link>
  );
}

function MobileDrawerItem({ item, active }: { item: NavigationItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      className={cn(
        "flex min-h-14 items-center gap-2.5 rounded-lg px-3 text-sm font-bold text-muted transition-colors hover:bg-surface-muted hover:text-foreground",
        active && mobileActiveClassName,
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className="size-[1.125rem] shrink-0" aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function groupNavigation(items: readonly NavigationItem[]) {
  const groups: Array<{ workspace: NavigationWorkspace; items: NavigationItem[] }> = [];
  for (const item of items) {
    const group = groups.find((candidate) => candidate.workspace === item.workspace);
    if (group) group.items.push(item);
    else groups.push({ workspace: item.workspace, items: [item] });
  }
  return groups;
}

function navigationItemForPath(items: readonly NavigationItem[], pathname: string): NavigationItem {
  const direct = [...items]
    .sort((left, right) => right.to.length - left.to.length)
    .find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  if (direct) return direct;

  const alias =
    pathname === "/today" || pathname.startsWith("/jobs/") || pathname.startsWith("/work-objects/")
      ? "/today"
      : pathname === "/owner"
        ? "/now"
        : pathname.startsWith("/estimator/") || pathname.startsWith("/marketing/")
          ? "/sales"
          : pathname.startsWith("/quote-revision-approvals")
            ? "/approvals"
            : undefined;

  return (
    items.find((item) => item.to === alias) ??
    (alias === "/today" ? items.find((item) => item.to === "/now") : undefined) ??
    items[0]!
  );
}
