import { Link, Outlet, useRouterState, useSearch } from "@tanstack/react-router";
import { LayoutGrid, Menu, Search, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useSession } from "../auth/session-context";
import { jobIdFromPath } from "../field/job-stop";
import { SafetyActionPanel } from "../field/safety-action-panel";
import { cn } from "../lib/cn";
import {
  navigationForRole,
  roleLabel,
  type NavigationItem,
  type NavigationWorkspace,
} from "../lib/roles";
import { scopes } from "../lib/theme";
import { CrewShell } from "./crew-shell";
import {
  breadcrumbTrail,
  groupNavigation,
  initials,
  phoneTabs,
  shellPlace,
} from "./shell-navigation";
import { PersonMenu, SearchPalette } from "./shell-controls";
import { useCompanyLogoUrl, useSearchPalette } from "./shell-hooks";
import { ShopReadingContext } from "./shop-reading";
import { SystemStatus } from "./system-status";
import { BrandMark, Logo } from "./ui/brand";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

// TanStack adds aria-current after custom props. Make /now's native active match exclude
// the decision query, and explicitly clear that query when returning to ordinary work.
const nowLinkOptions = {
  search: { show: undefined },
  activeOptions: { exact: true, explicitUndefined: true },
};

/** The crew get their own phone shell; every office role gets the rail. */
export function AppShell() {
  const session = useSession();
  if (session.user.role === "field") return <CrewShell />;
  return <OfficeShell />;
}

function OfficeShell() {
  const session = useSession();
  const items = navigationForRole(session.user.role);
  const { pathname, href } = useRouterState({ select: (state) => state.location });
  const showDecisions = useSearch({ strict: false, select: (search) => search.show === "decide" });
  const logoUrl = useCompanyLogoUrl();
  const search = useSearchPalette();
  // The drawer belongs to this URL, including its query, so navigation closes it.
  const [navOpenOn, setNavOpenOn] = useState<string | null>(null);
  const navOpen = navOpenOn === href;
  const setNavOpen = (open: boolean) => setNavOpenOn(open ? href : null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [shopReading, setShopReading] = useState(false);
  const groups = groupNavigation(items);
  const place = shellPlace(items, pathname === "/now" && showDecisions ? "/approvals" : pathname);
  // A safety report from an open job holds that job, not every Work Package in the company.
  const officeStopJob = jobIdFromPath(pathname);
  const trail = breadcrumbTrail(place);
  const tabs = phoneTabs(items);
  const tabsInMore = tabs.hasMore && !tabs.primary.some((item) => item.to === place.item.to);
  const name = session.user.display_name || session.user.email;

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return;
    if (!navOpen) {
      if (drawer.open) drawer.close();
      return;
    }
    drawer.showModal();
    drawer.querySelector<HTMLElement>("a[aria-current='page'], a")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const compact = window.matchMedia("(max-width: 1100px)");
    const phone = window.matchMedia("(max-width: 720px)");
    const onResize = () => {
      const shop = document.querySelector('.shell [data-density="glove"]');
      if (!compact.matches || (phone.matches && !shop)) setNavOpenOn(null);
    };
    compact.addEventListener("change", onResize);
    phone.addEventListener("change", onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      compact.removeEventListener("change", onResize);
      phone.removeEventListener("change", onResize);
    };
  }, [navOpen]);

  return (
    <div className="shell" data-tabs="" {...(shopReading ? scopes.shopReading : {})}>
      <a
        href="#main-content"
        className="fixed top-4 left-4 z-[60] -translate-y-24 rounded-md bg-primary px-4 py-3 font-semibold text-primary-foreground transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>

      <NavigationRail groups={groups} currentTo={place.item.to} logoUrl={logoUrl} />
      <dialog
        ref={drawerRef}
        className="shell-nav-dialog"
        aria-label="Navigation"
        onCancel={(event) => {
          event.preventDefault();
          setNavOpen(false);
        }}
        onClose={() => setNavOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setNavOpen(false);
        }}
      >
        <NavigationRail
          groups={groups}
          currentTo={place.item.to}
          logoUrl={logoUrl}
          className="shell-drawer-rail"
          onNavigate={() => setNavOpen(false)}
        >
          <Button
            variant="quiet"
            size="icon"
            className="ml-auto text-chrome-foreground"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
          >
            <X aria-hidden="true" />
          </Button>
        </NavigationRail>
      </dialog>

      <div className="shell-column">
        <header className="shell-topbar">
          <Button
            variant="quiet"
            size="icon"
            className="shell-menu-btn shell-topbar-row-item text-foreground"
            aria-label="Open navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <Menu aria-hidden="true" />
          </Button>
          <Link
            to="/now"
            {...nowLinkOptions}
            className="shell-topbar-mark shell-topbar-row-item environment-control grid min-w-12 shrink-0 place-items-center"
            aria-label={`${session.tenant.brand}, Now`}
          >
            {logoUrl ? (
              <img src={logoUrl} alt="" className="max-h-7 w-7 object-contain" />
            ) : (
              <BrandMark size={24} />
            )}
          </Link>
          <nav
            aria-label="Breadcrumb"
            className="shell-topbar-row-item flex min-w-0 flex-1 items-center text-[0.84375rem] text-faint"
          >
            <ol className="flex min-w-0 items-center gap-2">
              {trail.workspace ? (
                // Below 1101px the workspace is read, not seen; its link shows itself when tabbed to.
                <li className="sr-only shrink-0 focus-within:not-sr-only min-[1101px]:not-sr-only">
                  {trail.workspace.to ? (
                    <Link
                      to={trail.workspace.to}
                      activeOptions={{ exact: true }}
                      className="environment-control inline-flex items-center hover:text-foreground"
                    >
                      {trail.workspace.label}
                    </Link>
                  ) : (
                    trail.workspace.label
                  )}
                </li>
              ) : null}
              {[trail.destination, trail.parent].map((crumb) =>
                crumb ? (
                  <li
                    key={crumb.to}
                    className="hidden shrink-0 items-center gap-2 min-[1101px]:flex"
                  >
                    <span aria-hidden="true">/</span>
                    <Link
                      to={crumb.to}
                      activeOptions={{ exact: true }}
                      {...(crumb.to === "/now" ? nowLinkOptions : {})}
                      className="environment-control inline-flex items-center hover:text-foreground"
                    >
                      {crumb.label}
                    </Link>
                  </li>
                ) : null,
              )}
              <li className="flex min-w-0 items-center gap-2">
                {trail.workspace ? (
                  <span aria-hidden="true" className="hidden min-[1101px]:inline">
                    /
                  </span>
                ) : null}
                <strong className="truncate font-[580] text-foreground" aria-current="page">
                  {trail.current}
                </strong>
              </li>
            </ol>
          </nav>
          <SystemStatus bannerClassName="-mx-8 basis-[calc(100%+4rem)] max-[1100px]:-mx-6 max-[1100px]:basis-[calc(100%+3rem)] max-[720px]:-mx-4 max-[720px]:basis-[calc(100%+2rem)]" />
          <button
            type="button"
            className="shell-search-trigger environment-control inline-flex h-11 shrink-0 items-center gap-2.5 rounded-md bg-surface px-3 text-left text-[0.84375rem] text-faint shadow-[inset_0_0_0_1px_var(--border-control),0_1px_2px_rgb(21_24_28/0.05)] transition-shadow hover:shadow-[inset_0_0_0_1px_var(--border-strong),0_1px_2px_rgb(21_24_28/0.05)] max-[1100px]:w-11 max-[1100px]:justify-center max-[1100px]:px-0 min-[1101px]:min-w-[17.5rem]"
            aria-label="Search work"
            aria-keyshortcuts="Control+K Meta+K"
            title="Search (⌘K / Ctrl+K)"
            onClick={search.openSearch}
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <span className="max-[1100px]:hidden">Search work</span>
            {/* The shortcut hint is drawn by CSS, so the button's name is exactly its words. */}
            <kbd
              aria-hidden="true"
              data-keys="⌘K"
              className="ml-auto rounded border border-border bg-surface-sunk px-1.5 font-mono text-xs text-muted after:content-[attr(data-keys)] max-[1100px]:hidden"
            />
          </button>
          <Button
            variant="quiet"
            className="shell-safety-trigger px-3 text-foreground max-[1100px]:w-11 max-[1100px]:px-0"
            aria-haspopup="dialog"
            onClick={() => setSafetyOpen(true)}
          >
            <ShieldAlert className="text-danger" aria-hidden="true" />
            <span className="max-[1100px]:sr-only">Safety</span>
          </Button>
          <PersonMenu
            label={`${name}, ${roleLabel(session.user.role)}`}
            triggerClassName="shell-person-trigger environment-control -mr-2 inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-2.5 rounded-md px-1 text-left hover:bg-surface-hover min-[721px]:pr-2"
            trigger={
              <>
                {/* Initials are drawn by CSS, not text, so the words a screen reader hears start
                    with the name the button shows (WCAG 2.5.3 label in name). */}
                <span
                  aria-hidden="true"
                  data-initials={initials(name)}
                  className="grid size-[1.875rem] shrink-0 place-items-center rounded-full border border-line-strong bg-chrome text-[0.75rem] font-[640] tracking-[0.02em] text-chrome-foreground before:content-[attr(data-initials)]"
                />
                <span className="hidden flex-col text-[0.84375rem] leading-tight font-[560] min-[1101px]:flex">
                  <span className="max-w-40 truncate">{name}</span>{" "}
                  <span className="text-xs font-normal text-faint">
                    {roleLabel(session.user.role)}
                  </span>
                </span>
              </>
            }
          />
        </header>

        <main id="main-content" tabIndex={-1} className="shell-main app-main min-w-0 space-y-5">
          <ShopReadingContext value={setShopReading}>
            <Outlet />
          </ShopReadingContext>
        </main>
      </div>

      <nav className="shell-tabbar" aria-label="Main navigation">
        {tabs.primary.map((item) => {
          const Icon = item.icon;
          const active = item.to === place.item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              {...(item.to === "/now" ? nowLinkOptions : {})}
              className="shell-tab"
              aria-current={active ? "page" : undefined}
            >
              <Icon aria-hidden="true" />
              <span className="max-w-full truncate">{item.mobileLabel ?? item.label}</span>
            </Link>
          );
        })}
        {tabs.hasMore ? (
          <MoreTab groups={groups} currentTo={place.item.to} current={tabsInMore} />
        ) : null}
      </nav>

      <SearchPalette loaded={search.loaded} open={search.open} onOpenChange={search.setOpen} />

      {/* Mounted on every authenticated screen on purpose. Reporting a hazard, making an area
          safe, condemning equipment and calling for rescue must never depend on having a job
          packet open, so the header carries it at every width. */}
      <Dialog
        open={safetyOpen}
        onClose={() => setSafetyOpen(false)}
        title="Safety"
        side="end"
        className="[&>div:nth-child(2)]:p-0"
      >
        <SafetyActionPanel
          session={session}
          scope={officeStopJob ? { type: "roof_job", id: officeStopJob } : undefined}
        />
      </Dialog>
    </div>
  );
}

function NavigationRail({
  groups,
  currentTo,
  logoUrl,
  className,
  onNavigate,
  children,
}: {
  groups: Array<{ workspace: NavigationWorkspace; items: NavigationItem[] }>;
  currentTo: NavigationItem["to"];
  logoUrl: string | null;
  className?: string;
  onNavigate?: () => void;
  children?: React.ReactNode;
}) {
  const session = useSession();
  return (
    <nav
      className={cn("shell-rail", className)}
      aria-label="Main navigation"
      onClick={(event) => {
        if ((event.target as Element).closest("a")) onNavigate?.();
      }}
    >
      {children}
      <Link
        to="/now"
        {...nowLinkOptions}
        className="shell-brand"
        aria-label={`${session.tenant.brand}, Now`}
      >
        {logoUrl ? (
          <span className="grid h-11 max-w-[9.5rem] place-items-center rounded-md bg-surface px-2">
            <img src={logoUrl} alt="" className="max-h-9 w-auto object-contain" />
          </span>
        ) : (
          <Logo height={44} className="w-[9.5rem]" />
        )}
      </Link>
      {groups.map((group) => (
        <div className="shell-nav-group" key={group.workspace}>
          <p className="shell-nav-label">{group.workspace}</p>
          {group.items.map((item) => (
            <RailLink key={item.to} item={item} active={item.to === currentTo} />
          ))}
        </div>
      ))}
      <p className="shell-rail-foot">
        {session.tenant.brand} · {roleLabel(session.user.role)}
      </p>
    </nav>
  );
}

function RailLink({ item, active }: { item: NavigationItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      {...(item.to === "/now" ? nowLinkOptions : {})}
      className="shell-nav-link"
      aria-current={active ? "page" : undefined}
    >
      <Icon aria-hidden="true" />
      <span className="shell-nav-link-label">{item.label}</span>
    </Link>
  );
}

function MoreTab({
  groups,
  currentTo,
  current,
}: {
  groups: Array<{ workspace: NavigationWorkspace; items: NavigationItem[] }>;
  currentTo: NavigationItem["to"];
  current: boolean;
}) {
  return (
    <>
      <button
        type="button"
        popoverTarget="mobile-workspace-popover"
        aria-controls="mobile-workspace-popover"
        className="shell-tab"
        data-current={current || undefined}
      >
        <LayoutGrid aria-hidden="true" />
        <span>More</span>
        <span className="sr-only"> workspaces</span>
      </button>
      <div
        id="mobile-workspace-popover"
        popover="auto"
        onClick={(event) => {
          if ((event.target as Element).closest("a")) event.currentTarget.hidePopover();
        }}
        className="fixed inset-x-3 top-auto bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] z-[60] m-0 max-h-[min(72dvh,40rem)] w-auto overflow-y-auto overscroll-contain rounded-xl bg-surface-raised p-3 text-foreground shadow-[var(--shadow-floating)]"
      >
        <div className="flex min-h-11 items-center justify-between gap-4 border-b border-border px-1 pb-2">
          <p className="text-sm font-semibold">All work</p>
          <button
            type="button"
            popoverTarget="mobile-workspace-popover"
            popoverTargetAction="hide"
            className="environment-control grid size-11 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            aria-label="Close all workspaces"
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-4 pt-3">
          {groups.map((group) => (
            <section key={group.workspace}>
              <h2 className="mb-1 px-2 text-xs font-semibold text-faint">{group.workspace}</h2>
              <div className="grid grid-cols-2 gap-1 max-[360px]:grid-cols-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.to === currentTo;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      {...(item.to === "/now" ? nowLinkOptions : {})}
                      className={cn(
                        "environment-control flex min-h-12 min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground",
                        active && "bg-selected text-foreground [&_svg]:text-accent",
                      )}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon className="size-[1.125rem] shrink-0" aria-hidden="true" />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
