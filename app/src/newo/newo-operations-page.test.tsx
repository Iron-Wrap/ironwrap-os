import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadNewoOperations } from "./newo-operations-api";
import { NewoOperationsPage } from "./newo-operations-page";
import { newoOperationsFixture } from "./newo-operations-test-fixture";

vi.mock("./newo-operations-api", () => ({ loadNewoOperations: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const ownerSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["owner:read"],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2026-07-19T18:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-18T18:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const fieldSession = {
  ...ownerSession,
  user: {
    ...ownerSession.user,
    id: "appu_field",
    email: "crew@ironwrapexteriors.com",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@ironwrapexteriors.com",
  },
} satisfies AuthenticatedSession;

function renderPage(session: AuthenticatedSession = ownerSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={session}>
        <NewoOperationsPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("NewoOperationsPage", () => {
  beforeEach(() => {
    vi.mocked(loadNewoOperations).mockResolvedValue(newoOperationsFixture());
  });

  it("renders readiness and every required exception category without mutation controls", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "Reception" });
    expect(screen.getByText("Check")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Calls to check" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Call reports missing" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Calls not passed on" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Booking requests" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Calls not saved" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "System fixes" })).toBeVisible();
    expect(screen.getByText("Saved call list")).toBeVisible();
    expect(screen.getByText("Call report", { exact: true })).toBeVisible();
    expect(screen.getByText("System change")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Latest calls" })).toBeVisible();
    for (const callId of screen.getAllByText(/Call ID session-1/)) {
      expect(callId.closest("details")?.open).toBe(false);
    }

    const readiness = screen.getByRole("heading", { name: "System checks" }).closest("div");
    expect(readiness).not.toBeNull();
    expect(within(readiness!).getByText("Call center")).toBeVisible();
    expect(within(readiness!).getAllByLabelText("Not ready").length).toBeGreaterThan(0);

    const launchState = screen.getByRole("heading", { name: "Live settings" }).closest("div");
    expect(launchState).not.toBeNull();
    expect(within(launchState!).getByText("Ask first")).toBeVisible();
    expect(within(launchState!).getByText("Calls out")).toBeVisible();
    expect(within(launchState!).getAllByText("Off").length).toBe(3);
    expect(screen.getByText("Call time not found")).toBeVisible();

    expect(screen.queryByRole("button", { name: /send|book|approve|delete|execute/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh Reception" })).toBeVisible();
  });

  it("fails closed for field-role sessions without issuing the operations read", () => {
    renderPage(fieldSession);

    expect(
      screen.getByRole("heading", { name: "This work belongs to another role" }),
    ).toBeVisible();
    expect(loadNewoOperations).not.toHaveBeenCalled();
  });

  it("keeps a failed read explicit and retryable", async () => {
    vi.mocked(loadNewoOperations).mockRejectedValueOnce(new Error("unavailable"));
    renderPage();

    expect(await screen.findByRole("heading", { name: "Reception could not load" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
