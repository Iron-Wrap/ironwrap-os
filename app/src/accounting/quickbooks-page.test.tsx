import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import {
  approveQuickBooksFinalInvoice,
  connectQuickBooks,
  loadQuickBooksConnection,
  loadQuickBooksFinalInvoice,
  newQuickBooksActionKey,
  reconcileQuickBooksFinalInvoice,
  rejectQuickBooksFinalInvoice,
  removeQuickBooksFromIronWrap,
} from "./quickbooks-api";
import { QuickBooksFinalInvoicePage, QuickBooksSettingsPage } from "./quickbooks-page";
import {
  quickBooksIntentStates,
  type QuickBooksFinalInvoiceResponse,
} from "./quickbooks-contracts";
import { quickBooksFinalInvoiceFixture } from "./quickbooks-test-fixture";

const route = vi.hoisted(() => ({ intentId: "qbo_final_01JEXAMPLE0001" }));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => route,
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("./quickbooks-api", () => ({
  loadQuickBooksConnection: vi.fn(),
  loadQuickBooksFinalInvoice: vi.fn(),
  connectQuickBooks: vi.fn(),
  approveQuickBooksFinalInvoice: vi.fn(),
  rejectQuickBooksFinalInvoice: vi.fn(),
  reconcileQuickBooksFinalInvoice: vi.fn(),
  removeQuickBooksFromIronWrap: vi.fn(),
  newQuickBooksActionKey: vi.fn(),
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
  permissions: ["quickbooks:read", "quickbooks:review", "quickbooks:reconcile"],
  allowed_actions: ["quickbooks:read"],
  csrf_token: "csrf-qbo",
  session_expires_at: "2026-08-14T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-08-13T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

const accountingSession = {
  ...ownerSession,
  user: {
    ...ownerSession.user,
    id: "appu_accounting",
    email: "accounting@example.invalid",
    display_name: "Accounting",
    role: "accounting",
  },
} satisfies AuthenticatedSession;

function sessionFor(role: "ops" | "sales" | "production" | "field"): AuthenticatedSession {
  return {
    ...ownerSession,
    user: {
      ...ownerSession.user,
      id: `appu_${role}`,
      email: `${role}@example.invalid`,
      display_name: role,
      role,
    },
  };
}

function renderPage(page: "detail" | "settings", session: AuthenticatedSession = ownerSession) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        {page === "detail" ? <QuickBooksFinalInvoicePage /> : <QuickBooksSettingsPage />}
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function stateFixture(
  state: (typeof quickBooksIntentStates)[number],
): QuickBooksFinalInvoiceResponse {
  const fixture = quickBooksFinalInvoiceFixture();
  fixture.allowed_actions = ["refresh"];
  fixture.intent.state = state;
  if (state === "connection_required") {
    fixture.connection = {
      state: "connection_required",
      realm_id: null,
      last_connected_at: null,
    };
    fixture.intent.blocker = {
      code: "oauth_connection_required",
      next_step: "connect_quickbooks",
    };
  }
  if (state === "blocked") {
    fixture.intent.blocker = {
      code: "commercial_policy_hold",
      next_step: "resolve_commercial_policy",
    };
  }
  if (state === "rejected") fixture.intent.rejection_reason = "not_ready_to_invoice";
  if (state === "submitted" || state === "matched") {
    fixture.intent.provider = {
      invoice_id: "10001",
      submitted_at: "2026-08-13T12:01:00.000Z",
      matched_at: state === "matched" ? "2026-08-13T12:02:00.000Z" : null,
    };
  }
  if (state === "reconciliation_required") {
    fixture.intent.blocker = {
      code: "provider_response_uncertain",
      next_step: "reconcile_provider_invoice",
    };
    fixture.allowed_actions = ["reconcile", "refresh"];
  }
  return fixture;
}

describe("QuickBooks final-invoice page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    route.intentId = "qbo_final_01JEXAMPLE0001";
    vi.mocked(loadQuickBooksFinalInvoice).mockResolvedValue(quickBooksFinalInvoiceFixture());
    vi.mocked(approveQuickBooksFinalInvoice).mockResolvedValue(stateFixture("submission_pending"));
    vi.mocked(rejectQuickBooksFinalInvoice).mockResolvedValue(stateFixture("rejected"));
    vi.mocked(reconcileQuickBooksFinalInvoice).mockResolvedValue(stateFixture("submitted"));
    vi.mocked(newQuickBooksActionKey).mockReturnValue("quickbooks:decision:stable-key");
  });

  it.each([ownerSession, accountingSession])(
    "allows $user.role to review the immutable candidate with one primary decision",
    async (session) => {
      renderPage("detail", session);

      expect(await screen.findByRole("heading", { name: "CAD 1050.00" })).toBeVisible();
      expect(screen.getByText("JOB-0001", { exact: false })).toBeVisible();
      expect(screen.getByText("Residential roofing contract")).toBeVisible();
      expect(screen.getByText("2026-08-13")).toBeVisible();
      expect(screen.getByText("2026-09-12")).toBeVisible();
      expect(screen.getByText(/Approval authorizes submission/i)).toBeVisible();
      expect(screen.getByRole("button", { name: "Approve external invoice" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Reject" })).toBeVisible();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    },
  );

  it.each(["ops", "sales", "production", "field"] as const)(
    "denies %s before loading finance detail",
    (role) => {
      vi.mocked(loadQuickBooksFinalInvoice).mockClear();
      renderPage("detail", sessionFor(role));

      expect(
        screen.getByRole("heading", { name: "This work belongs to another role" }),
      ).toBeVisible();
      expect(loadQuickBooksFinalInvoice).not.toHaveBeenCalled();
    },
  );

  it("fails closed offline while still showing the cached immutable read", async () => {
    renderPage("detail", {
      ...accountingSession,
      csrf_token: "offline-session-no-csrf",
      stale_fields: ["session.offline_snapshot"],
    });

    expect((await screen.findAllByText("Reconnect before deciding")).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "CAD 1050.00" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve external invoice" })).toBeNull();
    expect(approveQuickBooksFinalInvoice).not.toHaveBeenCalled();
  });

  it("submits only the displayed version and a bounded rejection reason", async () => {
    const user = userEvent.setup();
    renderPage("detail", accountingSession);

    await user.click(await screen.findByRole("button", { name: "Reject" }));
    await user.selectOptions(
      screen.getByLabelText("Rejection reason"),
      "duplicate_or_already_billed",
    );
    await user.click(screen.getByRole("button", { name: "Reject candidate" }));

    await waitFor(() =>
      expect(rejectQuickBooksFinalInvoice).toHaveBeenCalledWith(
        accountingSession,
        "qbo_final_01JEXAMPLE0001",
        1,
        "duplicate_or_already_billed",
        "quickbooks:decision:stable-key",
      ),
    );
  });

  it("reuses the same idempotency key after an uncertain request and a fresh read", async () => {
    const user = userEvent.setup();
    vi.mocked(approveQuickBooksFinalInvoice)
      .mockRejectedValueOnce(
        new ApiError({ status: 0, code: "network_error", message: "uncertain" }),
      )
      .mockResolvedValueOnce(stateFixture("submission_pending"));
    renderPage("detail", ownerSession);

    await user.click(await screen.findByRole("button", { name: "Approve external invoice" }));
    await waitFor(() => expect(approveQuickBooksFinalInvoice).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Approve external invoice" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Approve external invoice" }));

    await waitFor(() => expect(approveQuickBooksFinalInvoice).toHaveBeenCalledTimes(2));
    expect(vi.mocked(approveQuickBooksFinalInvoice).mock.calls.map((call) => call[3])).toEqual([
      "quickbooks:decision:stable-key",
      "quickbooks:decision:stable-key",
    ]);
    expect(newQuickBooksActionKey).toHaveBeenCalledTimes(1);
  });

  it("shows a stale-version warning and requires current server state", async () => {
    const user = userEvent.setup();
    vi.mocked(approveQuickBooksFinalInvoice).mockRejectedValue(
      new ApiError({
        status: 409,
        code: "quickbooks_final_invoice_version_conflict",
        message: "conflict",
      }),
    );
    vi.mocked(loadQuickBooksFinalInvoice)
      .mockResolvedValueOnce(quickBooksFinalInvoiceFixture())
      .mockRejectedValueOnce(new ApiError({ status: 0, code: "network_error", message: "down" }));
    renderPage("detail", ownerSession);

    await user.click(await screen.findByRole("button", { name: "Approve external invoice" }));

    expect(await screen.findByText(/changed while you were reviewing/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve external invoice" })).toBeNull();
  });

  it.each([
    ["connection_required", "QuickBooks connection required"],
    ["blocked", "Blocked before review"],
    ["pending_review", "Needs finance review"],
    ["rejected", "Not approved"],
    ["submission_pending", "Submission pending"],
    ["submitted", "Accepted by QuickBooks"],
    ["matched", "Matched by authenticated readback"],
    ["failed", "Submission failed"],
    ["reconciliation_required", "Reconciliation required"],
  ] as const)("renders bounded %s state copy", async (state, heading) => {
    vi.mocked(loadQuickBooksFinalInvoice).mockResolvedValue(stateFixture(state));
    renderPage("detail", accountingSession);

    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    if (state === "submitted") {
      expect(screen.getByText(/awaiting authenticated readback/i)).toBeVisible();
    }
    if (state === "matched") expect(screen.getByText(/Payment is not implied/i)).toBeVisible();
    if (state === "reconciliation_required") {
      expect(screen.getByRole("button", { name: "Reconcile exact invoice" })).toBeVisible();
    }
  });

  it("keeps a server-declared connect action owner-only on finance detail", async () => {
    const ownerModel = stateFixture("connection_required");
    ownerModel.allowed_actions = ["connect", "refresh"];
    vi.mocked(loadQuickBooksFinalInvoice).mockResolvedValue(ownerModel);
    const owner = renderPage("detail", ownerSession);

    expect(await screen.findByRole("button", { name: "Connect QuickBooks" })).toBeVisible();
    owner.unmount();

    vi.mocked(loadQuickBooksFinalInvoice).mockResolvedValue(ownerModel);
    renderPage("detail", accountingSession);

    expect(
      (await screen.findAllByText(/Ask the owner to connect the intended QuickBooks company/i))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
  });
});

describe("QuickBooks connection settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/accounting/quickbooks");
    vi.mocked(loadQuickBooksConnection).mockResolvedValue({
      version: 1,
      state: "connected",
      connection_version: 4,
      realm_id: "123456789",
      last_connected_at: "2026-08-13T11:00:00.000Z",
      allowed_actions: ["remove_from_ironwrap", "refresh"],
    });
    vi.mocked(newQuickBooksActionKey).mockReturnValue("quickbooks:settings:stable-key");
  });

  it("shows only the server-declared owner connection action", async () => {
    renderPage("settings", ownerSession);

    expect(await screen.findByRole("heading", { name: "Connected" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review removal" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
  });

  it("keeps connection changes owner-only for accounting", async () => {
    renderPage("settings", accountingSession);

    expect(
      await screen.findByRole("heading", { name: "Connection changes belong to the owner" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review removal" })).toBeNull();
  });

  it("ignores a server-declared connect action for accounting", async () => {
    vi.mocked(loadQuickBooksConnection).mockResolvedValue({
      version: 1,
      state: "connection_required",
      connection_version: null,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["connect", "refresh"],
    });
    renderPage("settings", accountingSession);

    expect(
      await screen.findByRole("heading", { name: "Ask the owner to connect QuickBooks" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
    expect(connectQuickBooks).not.toHaveBeenCalled();
  });

  it("keeps an offline owner connection read-only and never queues removal", async () => {
    const user = userEvent.setup();
    renderPage("settings", {
      ...ownerSession,
      csrf_token: "offline-session-no-csrf",
      stale_fields: ["session.offline_snapshot"],
    });

    expect(await screen.findByText("Reconnect before changing QuickBooks")).toBeVisible();
    const reviewRemoval = screen.getByRole("button", { name: "Review removal" });
    expect(reviewRemoval).toBeDisabled();
    await user.click(reviewRemoval);
    expect(removeQuickBooksFromIronWrap).not.toHaveBeenCalled();
  });

  it("offers connect only when the server grants it", async () => {
    vi.mocked(loadQuickBooksConnection).mockResolvedValue({
      version: 1,
      state: "connection_required",
      connection_version: null,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["connect", "refresh"],
    });
    renderPage("settings", ownerSession);

    expect(await screen.findByRole("button", { name: "Connect QuickBooks" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Review removal" })).toBeNull();
  });

  it("shows reconciliation-required connection uncertainty without a competing connect action", async () => {
    vi.mocked(loadQuickBooksConnection).mockResolvedValue({
      version: 1,
      state: "reconciliation_required",
      connection_version: 4,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["refresh"],
    });
    renderPage("settings", ownerSession);

    expect(
      await screen.findByRole("heading", { name: "Connection needs reconciliation" }),
    ).toBeVisible();
    expect(screen.getByText("QuickBooks connection state is uncertain")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect QuickBooks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Review removal" })).toBeNull();
  });

  it("does not trust ?quickbooks=connected without a confirmed connected state", async () => {
    window.history.replaceState({}, "", "/accounting/quickbooks?quickbooks=connected");
    vi.mocked(loadQuickBooksConnection).mockResolvedValue({
      version: 1,
      state: "connection_required",
      connection_version: null,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["connect", "refresh"],
    });
    renderPage("settings", ownerSession);

    expect(await screen.findByText("QuickBooks return is not yet confirmed")).toBeVisible();
    expect(screen.queryByText(/server accepted the OAuth callback/i)).toBeNull();
  });

  it("sends the displayed connection version only after explicit removal confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(removeQuickBooksFromIronWrap).mockResolvedValue({
      version: 1,
      state: "revoked",
      connection_version: 4,
      realm_id: null,
      last_connected_at: null,
      allowed_actions: ["connect", "refresh"],
    });
    renderPage("settings", ownerSession);

    await user.click(await screen.findByRole("button", { name: "Review removal" }));
    expect(removeQuickBooksFromIronWrap).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove from IronWrap" }));

    await waitFor(() =>
      expect(removeQuickBooksFromIronWrap).toHaveBeenCalledWith(
        ownerSession,
        4,
        "quickbooks:settings:stable-key",
      ),
    );
    expect(await screen.findByRole("heading", { name: "Removed from IronWrap" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect QuickBooks" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Review removal" })).toBeNull();
  });
});
