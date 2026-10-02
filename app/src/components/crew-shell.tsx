import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { CircleHelp, Phone, Search } from "lucide-react";
import { useState } from "react";

import { useSession } from "../auth/session-context";
import { SafetyActionPanel } from "../field/safety-action-panel";
import { navigationForRole } from "../lib/roles";
import { navigationItemForPath } from "./shell-navigation";
import { PersonMenu, SearchPalette } from "./shell-controls";
import { useCompanyLogoUrl, useSearchPalette } from "./shell-hooks";
import { SystemStatus } from "./system-status";
import { BrandMark } from "./ui/brand";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/**
 * The crew phone shell (reference FieldShell): who this phone belongs to, whether its work has
 * reached the office, and Help one tap away on every screen. Help holds the safety rights (stop,
 * make safe, mark equipment unsafe, call for rescue) and a direct 911 call that needs no app.
 */
export function CrewShell() {
  const session = useSession();
  const items = navigationForRole(session.user.role);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = navigationItemForPath(items, pathname);
  const logoUrl = useCompanyLogoUrl();
  const search = useSearchPalette();
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpMounted, setHelpMounted] = useState(false);
  const name = session.user.display_name || session.user.email;

  return (
    <div className="crew" style={{ "--header-h": "3.75rem" } as React.CSSProperties}>
      <a
        href="#main-content"
        className="fixed top-4 left-4 z-[60] -translate-y-24 rounded-md bg-primary px-4 py-3 font-semibold text-primary-foreground transition-transform focus:translate-y-0"
      >
        Skip to main content
      </a>
      <header className="crew-top flex flex-wrap items-center gap-x-2">
        <Link
          to="/now"
          className="grid h-15 w-7 shrink-0 place-items-center"
          aria-label={`${session.tenant.brand}, Today`}
        >
          {logoUrl ? (
            <img src={logoUrl} alt="" className="max-h-7 w-7 object-contain" />
          ) : (
            <BrandMark size={24} />
          )}
        </Link>
        <PersonMenu
          triggerClassName="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-md px-1 text-left leading-tight hover:bg-surface-hover"
          trigger={
            <>
              <strong className="max-w-full truncate text-[0.9375rem] font-[620]">{name}</strong>
              <span className="text-[0.78125rem] text-faint">Crew phone</span>
            </>
          }
        />
        <SystemStatus
          variant="crew"
          bannerClassName="crew-banner -mr-3 -ml-4 basis-[calc(100%+1.75rem)]"
        />
        <Button
          variant="quiet"
          size="icon"
          className="text-foreground"
          aria-label="Open search (Command or Control K)"
          aria-keyshortcuts="Control+K Meta+K"
          title="Search (⌘K / Ctrl+K)"
          onClick={search.openSearch}
        >
          <Search aria-hidden="true" />
        </Button>
        <button
          type="button"
          aria-haspopup="dialog"
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-surface py-0 pr-3.5 pl-3 text-[0.9375rem] font-[640] text-foreground shadow-[inset_0_0_0_1px_var(--border-strong),0_1px_2px_rgb(21_24_28/0.06)] transition-colors hover:bg-surface-hover"
          onClick={() => {
            setHelpMounted(true);
            setHelpOpen(true);
          }}
        >
          <CircleHelp className="size-[1.125rem] text-danger" aria-hidden="true" />
          Help
        </button>
      </header>

      <main id="main-content" tabIndex={-1} className="crew-main app-main min-w-0 space-y-5">
        <Outlet />
      </main>

      <nav className="crew-tabs" aria-label="Main navigation">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className="shell-tab"
              aria-current={item.to === current.to ? "page" : undefined}
            >
              <Icon aria-hidden="true" />
              <span className="max-w-full truncate">{item.mobileLabel ?? item.label}</span>
            </Link>
          );
        })}
      </nav>

      <SearchPalette loaded={search.loaded} open={search.open} onOpenChange={search.setOpen} />

      <Dialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Help"
        description="Stop work, make an area safe, or call for rescue. It works with no job open and no signal."
        side="end"
        className="[&>div:nth-child(2)]:px-0"
      >
        <div className="px-5">
          <Button asChild variant="danger" size="field" fullWidth>
            <a href="tel:911">
              <Phone aria-hidden="true" />
              Emergency: call 911
            </a>
          </Button>
          <p className="mt-2 text-sm text-muted">
            A call uses the phone’s normal service and works without the app.
          </p>
        </div>
        {/* Keep the code available offline; mount on first use and retain unsent drafts on close. */}
        {helpMounted ? <SafetyActionPanel session={session} /> : null}
      </Dialog>
    </div>
  );
}
