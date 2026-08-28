import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { AppShell } from "./app-shell";

const mocks = vi.hoisted(() => ({
  pathname: "/now",
  navigate: vi.fn(),
  removeQueries: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
  Outlet: () => <div data-testid="outlet" />,
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: mocks.pathname } }),
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
  SafetyActionPanel: () => <div data-testid="safety-action-panel" />,
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
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider session={session}>
        <AppShell />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("shows the operator search surface for an authenticated office session", () => {
    renderShell(ownerSession);
    expect(
      screen.getByRole("button", { name: "Open search (Command or Control K)" }),
    ).toBeVisible();
  });

  it("keeps the operator search surface available to the authenticated field role", () => {
    renderShell({
      ...ownerSession,
      user: {
        ...ownerSession.user,
        id: "appu_field",
        email: "field@example.invalid",
        display_name: "Field Crew",
        role: "field",
      },
      permissions: ["jobs:read:assigned"],
      allowed_actions: ["field.checkin.create"],
    });

    expect(
      screen.getByRole("button", { name: "Open search (Command or Control K)" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("dialog", { hidden: true })).not.toBeVisible();
  });
});
