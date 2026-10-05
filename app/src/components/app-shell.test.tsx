import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadPublicEstimateConfig } from "../public-estimate/public-estimate-config";
import { apiCommand } from "../lib/api";
import type { AppRole } from "../lib/roles";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { AppShell } from "./app-shell";

const mocks = vi.hoisted(() => ({
  pathname: "/now",
  search: {} as Record<string, unknown>,
  searchStr: "",
  navigate: vi.fn(),
  removeQueries: vi.fn(),
  outletEnvironment: undefined as string | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    activeOptions,
    ...props
  }: React.ComponentProps<"a"> & {
    to: string;
    search?: Record<string, unknown>;
    activeOptions?: { exact?: boolean; explicitUndefined?: boolean };
  }) => {
    // Match the native Link's final aria-current override; a plain anchor hid HOME04's
    // double-current regression. The real router path is also covered in browser tests.
    const pathMatches =
      mocks.pathname === to || (!activeOptions?.exact && mocks.pathname.startsWith(`${to}/`));
    const nextSearch = search ?? {};
    const keys = activeOptions?.exact
      ? new Set([...Object.keys(mocks.search), ...Object.keys(nextSearch)])
      : new Set(Object.keys(nextSearch));
    const searchMatches = [...keys].every(
      (key) =>
        (!activeOptions?.explicitUndefined && nextSearch[key] === undefined) ||
        mocks.search[key] === nextSearch[key],
    );
    const active = pathMatches && searchMatches;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(nextSearch)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return (
      <a
        href={`${to}${params.size ? `?${params}` : ""}`}
        {...props}
        {...(active ? { "aria-current": "page" as const } : {})}
      >
        {children}
      </a>
    );
  },
  Outlet: () => <div data-testid="outlet" data-environment={mocks.outletEnvironment} />,
  useNavigate: () => mocks.navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; href: string } }) => unknown;
  }) =>
    select({ location: { pathname: mocks.pathname, href: `${mocks.pathname}${mocks.searchStr}` } }),
  useSearch: ({ select }: { select: (search: Record<string, unknown>) => unknown }) =>
    select(mocks.search),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ removeQueries: mocks.removeQueries }),
  };
});

vi.mock("../field/safety-action-panel", () => ({
  SafetyActionPanel: () => (
    <div data-testid="safety-action-panel">
      <input aria-label="Synthetic safety draft" />
    </div>
  ),
}));

vi.mock("../public-estimate/public-estimate-config", () => ({
  loadPublicEstimateConfig: vi.fn(),
}));

vi.mock("../lib/api", async (original) => ({
  ...(await original<typeof import("../lib/api")>()),
  apiCommand: vi.fn(),
}));

vi.mock("./system-status", () => ({
  SystemStatus: () => <div data-testid="system-status" />,
}));

const ownerSession: AuthenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@example.invalid",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: null,
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any", "sales:read"],
  allowed_actions: ["search.read", "navigation.read"],
  csrf_token: "csrf",
  session_expires_at: "2030-08-24T10:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-24T10:00:00.000Z",
  stale_fields: [],
};

function renderShell(session: AuthenticatedSession) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = () => (
    <QueryClientProvider client={queryClient}>
      <SessionProvider session={session}>
        <AppShell />
      </SessionProvider>
    </QueryClientProvider>
  );
  const view = render(content());
  return { ...view, rerenderShell: () => view.rerender(content()) };
}

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = "/now";
    mocks.search = {};
    mocks.searchStr = "";
    mocks.outletEnvironment = undefined;
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    vi.mocked(loadPublicEstimateConfig).mockResolvedValue({ logo_url: null } as never);
  });

  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("uses the declared company logo without probing a missing image", async () => {
    renderShell(ownerSession);

    await waitFor(() => expect(loadPublicEstimateConfig).toHaveBeenCalledOnce());
    expect(document.querySelector('img[src="/public/company-logo"]')).toBeNull();
    // Without an uploaded logo the rail carries the Iron Wrap wordmark on charcoal.
    expect(within(railOf()).getByRole("img", { name: "Iron Wrap Exteriors" })).toHaveAttribute(
      "src",
      "/brand/logo-on-dark.png",
    );

    vi.mocked(loadPublicEstimateConfig).mockResolvedValue({
      logo_url: "/public/company-logo?v=brand-1",
    } as never);
    renderShell({ ...ownerSession, tenant: { ...ownerSession.tenant, id: "freshco" } });

    await waitFor(() =>
      expect(document.querySelectorAll('img[src="/public/company-logo?v=brand-1"]')).toHaveLength(
        3,
      ),
    );
  });

  it("shows the operator search surface for an authenticated office session", () => {
    renderShell(ownerSession);
    expect(
      screen.getByRole("button", { name: "Open search (Command or Control K)" }),
    ).toBeVisible();
  });

  it("groups the rail the way the reference does and shows only what the role can open", () => {
    renderShell(ownerSession);
    expect(groupLabels()).toEqual(["Now", "Work", "Plan", "Resources", "Money", "Settings"]);
    expect(within(railOf()).getByRole("link", { name: "Now" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const cases: Array<[AppRole, string[], string[]]> = [
      ["ops", ["Now", "Work", "Plan", "Resources", "Settings"], ["Money desk", "QuickBooks"]],
      ["sales", ["Now", "Work"], ["Production", "Settings", "Owner"]],
      ["production", ["Now", "Plan"], ["Sales", "Settings"]],
      ["accounting", ["Money", "Now", "Settings"], ["Sales", "Production"]],
    ];
    for (const [role, groups, absent] of cases) {
      cleanup();
      renderShell(sessionAs(role));
      expect(groupLabels(), role).toEqual(groups);
      for (const label of absent) {
        expect(
          within(railOf()).queryByRole("link", { name: label }),
          `${role} ${label}`,
        ).toBeNull();
      }
    }
  });

  it("names the destination and the record in the breadcrumb", () => {
    mocks.pathname = "/jobs/JOB-1";
    renderShell(ownerSession);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("Plan/Production/Job");
    expect(within(crumbs).getByRole("link", { name: "Production" })).toHaveAttribute(
      "href",
      "/production",
    );
    expect(within(railOf()).getByRole("link", { name: "Production" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("selects Decisions for the validated decision view and Now for ordinary work", () => {
    mocks.search = { show: "decide" };
    mocks.searchStr = "?show=decide";
    const view = renderShell(ownerSession);
    const rail = within(railOf());
    expect(rail.getByRole("link", { name: "Decisions" })).toHaveAttribute("aria-current", "page");
    expect(rail.getByRole("link", { name: "Now" })).not.toHaveAttribute("aria-current");
    expect(rail.getByRole("link", { name: "Now" })).toHaveAttribute("href", "/now");
    for (const link of within(phoneBar()).getAllByRole("link", { name: "Now" })) {
      expect(link).not.toHaveAttribute("aria-current");
      expect(link).toHaveAttribute("href", "/now");
    }
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Decisions");

    // Only validated search selects the decision view, even if the raw URL still contains it.
    mocks.search = {};
    view.rerenderShell();
    expect(rail.getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page");
    expect(rail.getByRole("link", { name: "Decisions" })).not.toHaveAttribute("aria-current");
    mocks.searchStr = "";
    view.rerenderShell();
    expect(rail.getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page");
  });

  it("closes the navigation drawer when only the query changes", async () => {
    const view = renderShell(ownerSession);
    const menu = screen.getByRole("button", { name: "Open navigation" });
    await userEvent.click(menu);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer).toHaveAttribute("open");

    mocks.search = { show: "decide" };
    mocks.searchStr = "?show=decide";
    view.rerenderShell();
    expect(drawer).not.toHaveAttribute("open");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(within(railOf()).getByRole("link", { name: "Decisions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens the rail as a drawer below desktop width and closes it with Escape", async () => {
    renderShell(ownerSession);
    const menu = screen.getByRole("button", { name: "Open navigation" });
    const drawer = document.querySelector("dialog.shell-nav-dialog")!;
    expect(drawer).not.toHaveAttribute("open");
    await userEvent.click(menu);
    expect(screen.getByRole("dialog", { name: "Navigation" })).toHaveAttribute("open");
    expect(menu).toHaveAttribute("aria-expanded", "true");
    fireEvent(drawer, new Event("cancel", { cancelable: true }));
    expect(drawer).not.toHaveAttribute("open");
  });

  it("keeps an office phone bar to four tabs with the rest under More", () => {
    renderShell(ownerSession);
    const bar = phoneBar();
    expect(Array.from(bar.querySelectorAll(":scope > a")).map((link) => link.textContent)).toEqual([
      "Now",
      "Leads",
      "Jobs",
    ]);
    expect(within(bar).getByRole("button", { name: "Open all workspaces" })).toBeInTheDocument();

    cleanup();
    renderShell(sessionAs("sales"));
    expect(phoneBar().querySelectorAll(":scope > a")).toHaveLength(3);
    expect(within(phoneBar()).queryByRole("button", { name: "Open all workspaces" })).toBeNull();
  });

  it("closes the drawer and restores page scrolling when resized beyond tablet", async () => {
    const matchMedia = window.matchMedia.bind(window);
    const tablet = Object.assign(new EventTarget(), {
      matches: true,
      media: "(max-width: 1100px)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    });
    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      query === tablet.media ? (tablet as unknown as MediaQueryList) : matchMedia(query),
    );
    document.body.style.overflow = "auto";
    try {
      renderShell(ownerSession);
      const menu = screen.getByRole("button", { name: "Open navigation" });
      await userEvent.click(menu);
      const drawer = screen.getByRole("dialog", { name: "Navigation" });
      expect(drawer).toHaveAttribute("open");
      expect(document.body.style.overflow).toBe("hidden");

      act(() => {
        tablet.matches = false;
        tablet.dispatchEvent(new Event("change"));
      });
      await waitFor(() => expect(drawer).not.toHaveAttribute("open"));
      expect(menu).toHaveAttribute("aria-expanded", "false");
      expect(document.body.style.overflow).toBe("auto");
    } finally {
      document.body.style.overflow = "";
    }
  });

  it("pins the viewer's appearance from the person menu and remembers it", async () => {
    renderShell(ownerSession);
    expect(screen.getByRole("button", { name: "Owner, account menu" })).toBeInTheDocument();
    const appearance = screen.getByRole("group", { name: "Appearance", hidden: true });
    const dark = within(appearance).getByRole("button", { name: "Dark", hidden: true });
    const device = within(appearance).getByRole("button", { name: "Match device", hidden: true });
    expect(device).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(dark);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(dark).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(device);
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out", hidden: true })).toBeInTheDocument();
  });

  it("retains the Shop drawer on a phone resize and exits it when the desktop rail returns", async () => {
    const matchMedia = window.matchMedia.bind(window);
    const query = (media: string, matches: boolean) =>
      Object.assign(new EventTarget(), {
        media,
        matches,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      });
    const compact = query("(max-width: 1100px)", true);
    const phone = query("(max-width: 720px)", false);
    vi.spyOn(window, "matchMedia").mockImplementation((media) => {
      const target = [compact, phone].find((item) => item.media === media);
      return target ? (target as unknown as MediaQueryList) : matchMedia(media);
    });
    mocks.outletEnvironment = "shop";
    renderShell(ownerSession);
    await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    act(() => {
      phone.matches = true;
      phone.dispatchEvent(new Event("change"));
    });
    expect(drawer).toHaveAttribute("open");
    expect(document.body.style.overflow).toBe("hidden");

    act(() => {
      compact.matches = false;
      compact.dispatchEvent(new Event("change"));
    });
    await waitFor(() => expect(drawer).not.toHaveAttribute("open"));
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("reaches Safety from the office header on every screen", async () => {
    renderShell(ownerSession);
    await userEvent.click(screen.getByRole("button", { name: "Safety" }));
    const dialog = screen.getByRole("dialog", { name: "Safety" });
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByTestId("safety-action-panel")).toBeInTheDocument();
  });

  it("keeps the session and reports a failed sign-out with a retry", async () => {
    vi.mocked(apiCommand).mockRejectedValue(new Error("network unavailable"));
    renderShell(ownerSession);
    await userEvent.click(screen.getByRole("button", { name: "Owner, account menu" }));
    const signOut = screen.getByRole("button", { name: "Sign out", hidden: true });
    await userEvent.click(signOut);
    expect(await screen.findByRole("alert", { hidden: true })).toHaveTextContent(
      "Could not confirm sign-out",
    );
    expect(mocks.removeQueries).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(signOut).toBeEnabled();
  });

  it("does not send sign-out while the live session is offline", () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    renderShell(ownerSession);
    expect(
      screen.getByRole("button", { name: "Reconnect to sign out", hidden: true }),
    ).toBeDisabled();
    expect(apiCommand).not.toHaveBeenCalled();
  });

  it("gives the crew their phone shell: name, sync state in words, Help, and four tabs", async () => {
    renderShell(sessionAs("field"));

    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Field Crew, account menu" })).toHaveTextContent(
      "Field CrewCrew phone",
    );
    const tabs = screen.getByRole("navigation", { name: "Main navigation" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Now", "Check-in", "Vehicle", "Inventory"]);
    // Search stays with the crew; its results are limited server-side to assigned work.
    expect(
      screen.getByRole("button", { name: "Open search (Command or Control K)" }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Help" }));
    const help = screen.getByRole("dialog", { name: "Help" });
    expect(within(help).getByRole("link", { name: "Emergency: call 911" })).toHaveAttribute(
      "href",
      "tel:911",
    );
    expect(within(help).getByTestId("safety-action-panel")).toBeInTheDocument();
  });

  it("starts crew safety on first Help use offline and retains an unsent draft after close", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    renderShell(sessionAs("field"));
    expect(screen.queryByTestId("safety-action-panel")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Help" }));
    const help = screen.getByRole("dialog", { name: "Help" });
    expect(within(help).getByRole("link", { name: "Emergency: call 911" })).toHaveAttribute(
      "href",
      "tel:911",
    );
    const panel = within(help).getByTestId("safety-action-panel");
    const draft = within(panel).getByRole("textbox", { name: "Synthetic safety draft" });
    await user.type(draft, "Synthetic site hazard to report");
    await user.click(within(help).getByRole("button", { name: "Close" }));
    expect(help).not.toHaveAttribute("open");
    expect(screen.getByTestId("safety-action-panel")).toBe(panel);

    await user.click(screen.getByRole("button", { name: "Help" }));
    expect(help).toHaveAttribute("open");
    expect(within(help).getByTestId("safety-action-panel")).toBe(panel);
    expect(draft).toHaveValue("Synthetic site hazard to report");
  });

  it("keeps the loaded palette mounted until its close effect restores trigger focus", async () => {
    renderShell(ownerSession);
    const trigger = screen.getByRole("button", { name: "Open search (Command or Control K)" });

    await userEvent.click(trigger);
    const input = await screen.findByRole("combobox", {
      name: "Search jobs, leads, customers, or workspaces",
    });
    // `waitFor`, not a bare assertion, and for the same reason the restore assertion below uses
    // one: the palette moves focus in `requestAnimationFrame` (`operator-search-palette.tsx`),
    // because a `<dialog>` has to be laid out by `showModal()` before its input can take focus.
    // `findByRole` resolves the moment the input is IN the DOM, which is one frame earlier — so a
    // bare `expect(input).toHaveFocus()` races the frame and loses it on a contended runner.
    // The guarantee asserted is unchanged: the palette's input receives focus when it opens.
    await waitFor(() => expect(input).toHaveFocus());
    const palette = screen.getByRole("dialog", { name: "Search Iron Wrap Exteriors" });

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(palette).not.toBeVisible();
  });
});

function sessionAs(role: AppRole): AuthenticatedSession {
  return {
    ...ownerSession,
    user: {
      ...ownerSession.user,
      id: `appu_${role}`,
      email: `${role}@example.invalid`,
      display_name: role === "field" ? "Field Crew" : "Office Person",
      role,
    },
  };
}

function railOf() {
  return document.querySelector<HTMLElement>("nav.shell-rail")!;
}

function phoneBar() {
  return document.querySelector<HTMLElement>("nav.shell-tabbar")!;
}

function groupLabels() {
  return [...railOf().querySelectorAll(".shell-nav-label")].map((label) => label.textContent);
}
