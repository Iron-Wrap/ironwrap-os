import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import { loadAccountingSummary } from "./money-api";
import { MoneyDeskPage } from "./money-desk-page";
import { accountingSession, exceptionRow, intentRow, summaryResponse } from "./money-fixtures";

vi.mock("./money-api", () => ({
  loadAccountingSummary: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: { intentId?: string };
  }) => (
    <a href={to.replace("$intentId", params?.intentId ?? "$intentId")} {...props}>
      {children}
    </a>
  ),
}));

function renderDesk() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={accountingSession()}>
        <MoneyDeskPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("money desk", () => {
  beforeEach(() => {
    vi.mocked(loadAccountingSummary).mockReset();
  });

  it("shows the four queues section 8.2 names, with their counts", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(summaryResponse());
    renderDesk();

    for (const queue of ["Needs approval", "Awaiting QuickBooks", "Mismatched", "Exceptions"]) {
      expect(await screen.findByRole("heading", { name: queue })).toBeInTheDocument();
    }
  });

  it("gives every row its job, customer, amount, age, and single next step", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(summaryResponse());
    renderDesk();

    const queue = await screen.findByRole("region", { name: "Needs approval" });
    const row = within(queue).getByRole("link", { name: /Deposit invoice/u });
    expect(row).toHaveTextContent("CUST-0001");
    expect(row).toHaveTextContent("job-0001");
    expect(row).toHaveTextContent("CAD 1260.00");
    expect(row).toHaveTextContent("1h old");
    // Section 8.2: a plain-language next step, never a reason code.
    expect(row).toHaveTextContent(
      "Check the amount against the approved paperwork, then approve or reject it.",
    );
    expect(row.textContent).not.toMatch(/pending_review/u);
  });

  it("renders one badge per intent, taken from the server", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(summaryResponse());
    renderDesk();

    const needsApproval = await screen.findByRole("region", { name: "Needs approval" });
    expect(within(needsApproval).getByText("Pending")).toBeInTheDocument();

    const mismatched = screen.getByRole("region", { name: "Mismatched" });
    const row = within(mismatched).getByRole("link", { name: /Deposit invoice/u });
    expect(within(row).getByText("Mismatched")).toBeInTheDocument();
  });

  it.each([
    ["pending", "Pending"],
    ["in_flight", "In flight"],
    ["uncertain", "Uncertain"],
    ["mismatched", "Mismatched"],
    ["compensated", "Compensated"],
    ["reconciled", "Reconciled"],
    ["rejected", "Not approved"],
    ["failed", "Failed"],
  ] as const)("renders the %s badge as %s", async (badge, label) => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(
      summaryResponse({
        queues: {
          needs_approval: [intentRow({ badge })],
          awaiting_provider: [],
          mismatched: [],
          exceptions: [],
        },
      }),
    );
    renderDesk();
    const queue = await screen.findByRole("region", { name: "Needs approval" });
    expect(within(queue).getByText(label)).toBeInTheDocument();
  });

  it("links each row to its own detail screen", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(summaryResponse());
    renderDesk();

    const queue = await screen.findByRole("region", { name: "Needs approval" });
    const row = within(queue).getByRole("link", { name: /Deposit invoice/u });
    expect(row).toHaveAttribute("href", "/accounting/intents/acct-intent:job-0001:deposit_invoice");
  });

  it("shows reconciliation health, including what has never been read back", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(summaryResponse());
    renderDesk();

    const health = await screen.findByRole("region", { name: "Reconciliation health" });
    expect(health).toHaveTextContent("Not re-read recently");
    expect(health).toHaveTextContent("Never read back");
    expect(health).toHaveTextContent("Oldest unfinished money movement");
  });

  it("says so plainly when there is nothing in a queue", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(
      summaryResponse({
        summary: {
          queues: {
            needs_approval: { count: 0, oldest_age_seconds: null },
            awaiting_provider: { count: 0, oldest_age_seconds: null },
            mismatched: { count: 0, oldest_age_seconds: null },
            exceptions: { count: 0, oldest_age_seconds: null },
          },
          reconciliation_health: {
            open_exceptions: 0,
            acknowledged_exceptions: 0,
            oldest_open_exception_age_seconds: null,
            oldest_unreconciled_intent_id: null,
            oldest_unreconciled_age_seconds: null,
            stale_observation_count: 0,
            stale_after_seconds: 86_400,
            unobserved_intent_count: 0,
          },
        },
        queues: {
          needs_approval: [],
          awaiting_provider: [],
          mismatched: [],
          exceptions: [],
        },
      }),
    );
    renderDesk();

    expect(await screen.findByText("Nothing is waiting on a decision.")).toBeInTheDocument();
    expect(screen.getByText("Everything we have sent matches QuickBooks.")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing is outstanding. Every money movement has reached a settled state."),
    ).toBeInTheDocument();
  });

  it("names an exception in words rather than by its reason code", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(
      summaryResponse({
        queues: {
          needs_approval: [],
          awaiting_provider: [],
          mismatched: [],
          exceptions: [exceptionRow({ reason_code: "duplicate_provider_payment" })],
        },
      }),
    );
    renderDesk();

    expect(await screen.findByText("Two payments landed against one invoice")).toBeInTheDocument();
    expect(screen.queryByText("duplicate_provider_payment")).not.toBeInTheDocument();
  });

  it("offers no destructive action anywhere on the desk", async () => {
    vi.mocked(loadAccountingSummary).mockResolvedValue(summaryResponse());
    renderDesk();
    await screen.findByRole("heading", { name: "Money desk" });
    // Section 8.2: "No screen offers a destructive action, because there isn't one."
    expect(document.body.textContent).not.toMatch(/\bdelete\b/iu);
    expect(document.body.textContent).not.toMatch(/\bremove\b/iu);
  });

  it("keeps the desk read-only and honest when the server cannot be reached", async () => {
    vi.mocked(loadAccountingSummary).mockRejectedValue(new Error("offline"));
    renderDesk();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Money desk unavailable" })).toBeInTheDocument(),
    );
    expect(screen.getByText(/Nothing was approved, sent, or changed/u)).toBeInTheDocument();
  });
});
