import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { useCapability } from "../capabilities/capability-signal";
import { officeCapability } from "../capabilities/capability-test-fixture";
import { loadNewoOperations } from "./newo-operations-api";
import type {
  NewoOperationsOpenCallback,
  NewoOperationsResponse,
} from "./newo-operations-contracts";
import { NewoOperationsPage } from "./newo-operations-page";
import { newoOperationsFixture } from "./newo-operations-test-fixture";

vi.mock("./newo-operations-api", () => ({ loadNewoOperations: vi.fn() }));
vi.mock("../capabilities/capability-signal", () => ({ useCapability: vi.fn() }));
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
    email: "owner@example.invalid",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.invalid",
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
    email: "crew@example.invalid",
    display_name: "Crew",
    role: "field",
    frappe_user_id: "crew@example.invalid",
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

function callbackFixture(
  index: number,
  overrides: Partial<NewoOperationsOpenCallback> = {},
): NewoOperationsOpenCallback {
  return {
    callback_id: `ncb_${index.toString(16).padStart(32, "0")}`,
    session_id: `synthetic-callback-session-${index}`,
    reason: "callback_requested",
    urgency: "routine",
    requested_at: `2026-07-18T18:${index.toString().padStart(2, "0")}:00.000Z`,
    ...overrides,
  };
}

function callbackOverview(
  count: number,
  callbacks: NewoOperationsOpenCallback[],
): NewoOperationsResponse {
  const model = newoOperationsFixture();
  return newoOperationsFixture({
    counts: {
      ...model.counts,
      sessions: callbacks.length,
      pending_sync: 0,
      failed_sync: 0,
      failed_events: 0,
      missing_reports: 0,
      failed_handoffs: 0,
      open_callbacks: count,
      pending_bookings: 0,
      control_failures: 0,
      dlq_items: 0,
      unresolved_incidents: 0,
    },
    exceptions: {
      missing_reports: [],
      failed_handoffs: [],
      open_callbacks: callbacks,
      pending_bookings: [],
      sync_failures: [],
      failed_events: [],
      dlq_items: [],
      control_failures: [],
    },
    recent_sessions: [],
  });
}

describe("NewoOperationsPage", () => {
  beforeEach(() => {
    vi.mocked(useCapability).mockReturnValue({ status: "unreadable", offline: false });
    vi.mocked(loadNewoOperations).mockResolvedValue(newoOperationsFixture());
  });

  it("renders readiness and every required exception category without mutation controls", async () => {
    renderPage();

    await screen.findByRole("heading", { name: "Reception" });
    expect(screen.getByText("Check")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Calls to check" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Call reports missing" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Calls not passed on" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Calls to return" })).toBeVisible();
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

  it("shows callback-only work without an all-clear or a detail/completion action", async () => {
    const callback = callbackFixture(1);
    vi.mocked(loadNewoOperations).mockResolvedValue(callbackOverview(1, [callback]));
    renderPage();

    const queue = await screen.findByRole("region", { name: "Calls to return" });
    expect(within(queue).getByText("Total reported: 1")).toBeVisible();
    expect(within(queue).getByText("Call back requested")).toBeVisible();
    expect(screen.queryByText("No call or booking needs a check.")).toBeNull();
    expect(within(queue).queryByRole("link")).toBeNull();
    expect(within(queue).queryByRole("button")).toBeNull();
    expect(screen.queryByText(callback.callback_id)).toBeNull();
    expect(screen.queryByText(callback.session_id)).toBeNull();
  });

  it("keeps known-off guidance truthful while failed calls still need a return call", async () => {
    vi.mocked(useCapability).mockReturnValue({
      status: "known",
      capability: officeCapability("newo", "Reception"),
    });
    vi.mocked(loadNewoOperations).mockResolvedValue(
      callbackOverview(1, [callbackFixture(1, { reason: "session_failed" })]),
    );
    renderPage();

    expect(await screen.findByRole("heading", { name: "Reception is turned off" })).toBeVisible();
    expect(screen.getByText("Turned off")).toBeVisible();
    expect(
      screen.getByText(
        "Reception is turned off. Saved calls can still need a check. Use the lists below.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Whoever deploys IronWrap for your company has to make it/),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Ask whoever administers this IronWrap deployment. No one can make this change from inside the app.",
      ),
    ).toBeVisible();
    const queue = screen.getByRole("region", { name: "Calls to return" });
    expect(within(queue).getByText("Call failed")).toBeVisible();
    expect(within(queue).getByText("Total reported: 1")).toBeVisible();
    expect(screen.queryByText(/Nothing here has failed/)).toBeNull();
    expect(screen.queryByText("No call or booking needs a check.")).toBeNull();
    expect(within(queue).queryByRole("button")).toBeNull();
    expect(within(queue).queryByRole("link")).toBeNull();
  });

  it("keeps all-clear for an empty callback total and list with no other queued calls", async () => {
    vi.mocked(loadNewoOperations).mockResolvedValue(callbackOverview(0, []));
    renderPage();

    expect(await screen.findByText("No call or booking needs a check.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Calls to return" })).toBeNull();
  });

  it("shows the total separately from all 25 returned rows", async () => {
    const callbacks = Array.from({ length: 25 }, (_, index) => callbackFixture(index + 1));
    vi.mocked(loadNewoOperations).mockResolvedValue(callbackOverview(31, callbacks));
    renderPage();

    const queue = await screen.findByRole("region", { name: "Calls to return" });
    expect(within(queue).getByText("Total reported: 31")).toBeVisible();
    expect(within(queue).getByText(/25 shown here/)).toBeVisible();
    expect(within(queue).getAllByRole("listitem")).toHaveLength(25);
    const counts = screen.getByLabelText("Reception counts");
    expect(within(counts).getByText("Calls to return").parentElement).toHaveTextContent("31");
  });

  it("keeps a positive callback total visible when its returned list is empty", async () => {
    vi.mocked(loadNewoOperations).mockResolvedValue(callbackOverview(4, []));
    renderPage();

    const queue = await screen.findByRole("region", { name: "Calls to return" });
    expect(within(queue).getByText("Total reported: 4")).toBeVisible();
    expect(within(queue).getByText(/0 shown here/)).toBeVisible();
    expect(
      within(queue).getByText("Call details are not in this list. Try Refresh."),
    ).toBeVisible();
    expect(screen.queryByText("No call or booking needs a check.")).toBeNull();
  });

  it("keeps returned callbacks and attention visible when separate total/status reads say ready", async () => {
    const model = callbackOverview(0, [callbackFixture(1, { reason: "session_failed" })]);
    model.status = "ready";
    model.readiness = {
      ...model.readiness,
      status: "ready",
      enabled: true,
      checks: model.readiness.checks.map((check) => ({ ...check, ok: true })),
      drift_reasons: [],
    };
    vi.mocked(loadNewoOperations).mockResolvedValue(model);
    renderPage();

    const queue = await screen.findByRole("region", { name: "Calls to return" });
    expect(within(queue).getByText("Total reported: 0")).toBeVisible();
    expect(within(queue).getByText("Call failed")).toBeVisible();
    expect(within(queue).getByText("The total and list differ. Try Refresh.")).toBeVisible();
    expect(screen.queryByText("No call or booking needs a check.")).toBeNull();
    expect(screen.getByRole("heading", { name: "Reception needs a check" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Reception is ready" })).toBeNull();
    const hero = screen.getByRole("heading", { name: "Reception" }).parentElement!;
    expect(within(hero).getByText("Check")).toBeVisible();
    expect(within(hero).queryByText("Ready")).toBeNull();
    const readiness = screen.getByRole("heading", { name: "System checks" }).parentElement!;
    expect(within(readiness).getByText("Ready")).toBeVisible();
  });

  it("renders both reasons and every urgency in supplied order without sorting across urgency", async () => {
    const callbacks = [
      callbackFixture(13, { urgency: "emergency" }),
      callbackFixture(15, { urgency: "emergency", reason: "session_failed" }),
      callbackFixture(12, { urgency: "urgent" }),
      callbackFixture(14, { urgency: "urgent", reason: "session_failed" }),
      callbackFixture(11),
      callbackFixture(16, { reason: "session_failed" }),
    ];
    vi.mocked(loadNewoOperations).mockResolvedValue(callbackOverview(6, callbacks));
    renderPage();

    const queue = await screen.findByRole("region", { name: "Calls to return" });
    const rows = within(queue).getAllByRole("listitem");
    expect(rows).toHaveLength(callbacks.length);
    callbacks.forEach((callback, index) => {
      expect(rows[index]).toHaveTextContent(
        callback.reason === "callback_requested" ? "Call back requested" : "Call failed",
      );
      expect(rows[index]).toHaveTextContent(
        callback.urgency.charAt(0).toUpperCase() + callback.urgency.slice(1),
      );
      expect(rows[index]).toHaveTextContent(
        new Intl.DateTimeFormat("en-CA", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: "America/Edmonton",
        }).format(new Date(callback.requested_at)),
      );
    });
  });

  it("retains saved callback work when Refresh fails", async () => {
    vi.mocked(loadNewoOperations).mockResolvedValue(callbackOverview(1, [callbackFixture(1)]));
    renderPage();
    await screen.findByRole("region", { name: "Calls to return" });

    vi.mocked(loadNewoOperations).mockRejectedValue(new Error("synthetic refresh unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Reception" }));

    expect(await screen.findByText("The new list did not load")).toBeVisible();
    expect(
      screen.getByText("The last saved list is still shown. Try Refresh again."),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Calls to return" })).toHaveTextContent(
      "Call back requested",
    );
    expect(screen.queryByText("No call or booking needs a check.")).toBeNull();
  });
});
