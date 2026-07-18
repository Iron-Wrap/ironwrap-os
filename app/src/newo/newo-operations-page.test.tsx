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

    await screen.findByRole("heading", { name: "Newo Operations" });
    expect(screen.getByText("Attention")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Call exceptions" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Missing session reports" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Failed handoffs" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Pending appointment requests" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Downstream sync failures" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Delivery and control recovery" })).toBeVisible();
    expect(screen.getByText("Queue dead letter")).toBeVisible();
    expect(screen.getByText("Provider event")).toBeVisible();
    expect(screen.getByText("Control action")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent sessions" })).toBeVisible();
    expect(screen.getAllByText("session-1").length).toBeGreaterThan(0);

    const readiness = screen.getByRole("heading", { name: "Readiness" }).closest("section");
    expect(readiness).not.toBeNull();
    expect(within(readiness!).getByText("Newo traffic")).toBeVisible();
    expect(within(readiness!).getAllByLabelText("Not ready").length).toBeGreaterThan(0);

    const launchState = screen.getByRole("heading", { name: "Launch state" }).closest("section");
    expect(launchState).not.toBeNull();
    expect(within(launchState!).getByText("Request Only")).toBeVisible();
    expect(within(launchState!).getByText("Outbound")).toBeVisible();
    expect(within(launchState!).getAllByText("Off").length).toBe(2);
    expect(screen.getByText("Provider minutes unavailable")).toBeVisible();

    expect(screen.queryByRole("button", { name: /send|book|approve|delete|execute/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh Newo operations" })).toBeVisible();
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

    expect(
      await screen.findByRole("heading", { name: "Newo operations unavailable" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
