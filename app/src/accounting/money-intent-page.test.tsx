import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import {
  approveAccountingIntent,
  compensateAccountingIntent,
  loadAccountingIntent,
  reconcileAccountingIntent,
  rejectAccountingIntent,
} from "./money-api";
import { MoneyIntentPage } from "./money-intent-page";
import {
  accountingSession,
  commandResponse,
  detailResponse,
  intentRow,
  mismatchedDetail,
} from "./money-fixtures";

vi.mock("./money-api", () => ({
  loadAccountingIntent: vi.fn(),
  approveAccountingIntent: vi.fn(),
  rejectAccountingIntent: vi.fn(),
  reconcileAccountingIntent: vi.fn(),
  compensateAccountingIntent: vi.fn(),
  newAccountingActionKey: (action: string) => `accounting:${action}:test-key-0000000000`,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ intentId: "acct-intent:job-0001:deposit_invoice" }),
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

function renderIntent() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={accountingSession()}>
        <MoneyIntentPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("money intent detail", () => {
  beforeEach(() => {
    vi.mocked(loadAccountingIntent).mockReset();
    vi.mocked(approveAccountingIntent).mockReset();
    vi.mocked(rejectAccountingIntent).mockReset();
    vi.mocked(reconcileAccountingIntent).mockReset();
    vi.mocked(compensateAccountingIntent).mockReset();
  });

  it("leads with the badge, the amount, and the single next step", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(detailResponse());
    renderIntent();

    expect(await screen.findByRole("heading", { name: "Deposit invoice" })).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("CAD 1260.00")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Check the amount against the approved paperwork, then approve or reject it.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps system check codes behind a plain details label", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(detailResponse());
    const user = userEvent.setup();
    renderIntent();

    const details = await screen.findByText("System details");
    await user.click(details);
    const evidence = details.closest("details");
    expect(evidence).not.toBeNull();
    expect(evidence).toHaveTextContent("4620816365000000000");
    expect(evidence).toHaveTextContent("Not created yet");
    expect(evidence).toHaveTextContent("CAD 5000.00");
    expect(evidence).toHaveTextContent("a".repeat(64));
    expect(evidence).toHaveTextContent("Tax rate (GST)");
    expect(evidence).toHaveTextContent("Saved totals code");
  });

  it("says nothing has been read back rather than claiming a disagreement", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(detailResponse());
    renderIntent();

    const comparison = await screen.findByRole("region", {
      name: "IronWrap and QuickBooks",
    });
    expect(comparison).toHaveTextContent("QuickBooks has not answered yet");
    expect(within(comparison).getAllByText("not read yet").length).toBeGreaterThan(0);
  });

  it("renders the difference field by field when QuickBooks disagrees", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(mismatchedDetail());
    renderIntent();

    const comparison = await screen.findByRole("region", {
      name: "IronWrap and QuickBooks",
    });
    expect(comparison).toHaveTextContent("The numbers do not match");
    expect(comparison).toHaveTextContent("Total amount");
    expect(comparison).toHaveTextContent("1500.00");
  });

  it("offers approve and reject on a candidate, and sends the version it read", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(detailResponse());
    vi.mocked(approveAccountingIntent).mockResolvedValue(commandResponse());
    const user = userEvent.setup();
    renderIntent();

    await user.click(await screen.findByRole("button", { name: "Approve and send to QuickBooks" }));
    await waitFor(() => expect(approveAccountingIntent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(approveAccountingIntent).mock.calls[0]?.[1]).toBe(
      "acct-intent:job-0001:deposit_invoice",
    );
    expect(vi.mocked(approveAccountingIntent).mock.calls[0]?.[2]).toBe(1);
    expect(await screen.findByText(/Your choice is saved/u)).toBeInTheDocument();
  });

  it("records a bounded reason when the accountant does not approve", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(detailResponse());
    vi.mocked(rejectAccountingIntent).mockResolvedValue(
      commandResponse({ intent: intentRow({ state: "rejected", badge: "rejected", version: 2 }) }),
    );
    const user = userEvent.setup();
    renderIntent();

    await user.selectOptions(
      await screen.findByLabelText("Reason for not approving"),
      "paperwork missing",
    );
    await user.click(screen.getByRole("button", { name: "Do not approve" }));
    await waitFor(() => expect(rejectAccountingIntent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(rejectAccountingIntent).mock.calls[0]?.[3]).toBe("paperwork_missing");
  });

  it("offers only the reversals the exception put on offer, and never a delete", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(mismatchedDetail());
    vi.mocked(compensateAccountingIntent).mockResolvedValue(
      commandResponse({
        intent: intentRow({ state: "compensating", badge: "compensated", version: 5 }),
        compensation_plan: {
          intentId: "acct-intent:job-0001:deposit_invoice",
          exceptionId: "acct-exc-0001",
          reasonCode: "provider_overpayment",
          remedy: "credit_memo_issued",
          reversalKind: "credit_memo",
          providerEntityType: "CreditMemo",
          totalAmount: "-240.00",
          magnitudeAmount: "240.00",
          basis: { originalTotal: "1260.00", observedSettled: "1500.00", surplus: "240.00" },
        },
      }),
    );
    const user = userEvent.setup();
    renderIntent();

    const actions = await screen.findByRole("region", { name: "What you can do" });
    expect(
      within(actions).getByRole("button", { name: "Issue a credit memo" }),
    ).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Issue a refund" })).toBeInTheDocument();
    expect(within(actions).queryByRole("button", { name: /delete/iu })).not.toBeInTheDocument();

    await user.click(within(actions).getByRole("button", { name: "Issue a credit memo" }));
    await waitFor(() => expect(compensateAccountingIntent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(compensateAccountingIntent).mock.calls[0]?.[3]).toBe("credit_memo_issued");
    expect(
      await screen.findByText(/Issue a credit memo is approved for CAD 240.00/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been sent to QuickBooks yet/u)).toBeInTheDocument();
  });

  it("offers a re-read as the safe recovery on anything already sent", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(mismatchedDetail());
    vi.mocked(reconcileAccountingIntent).mockResolvedValue(commandResponse());
    const user = userEvent.setup();
    renderIntent();

    await user.click(await screen.findByRole("button", { name: "Check QuickBooks again" }));
    await waitFor(() => expect(reconcileAccountingIntent).toHaveBeenCalledTimes(1));
  });

  it("shows only the actions the role is allowed", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(
      detailResponse({ allowed_actions: ["accounting.read"] }),
    );
    renderIntent();

    const actions = await screen.findByRole("region", { name: "What you can do" });
    expect(within(actions).queryByRole("button")).not.toBeInTheDocument();
    expect(actions).toHaveTextContent("There is nothing for you to decide on this one right now.");
  });

  it("says a replay was a replay, so nobody thinks it happened twice", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(detailResponse());
    vi.mocked(approveAccountingIntent).mockResolvedValue(commandResponse({ replayed: true }));
    const user = userEvent.setup();
    renderIntent();

    await user.click(await screen.findByRole("button", { name: "Approve and send to QuickBooks" }));
    expect(
      await screen.findByText(
        "This exact decision was already recorded, so nothing happened a second time.",
      ),
    ).toBeInTheDocument();
  });

  it("turns a refused decision into a sentence about what to do next", async () => {
    vi.mocked(loadAccountingIntent).mockResolvedValue(detailResponse());
    vi.mocked(approveAccountingIntent).mockRejectedValue(
      new ApiError({
        message: "refused",
        status: 409,
        code: "accounting_intent_separation_of_duty",
      }),
    );
    const user = userEvent.setup();
    renderIntent();

    await user.click(await screen.findByRole("button", { name: "Approve and send to QuickBooks" }));
    expect(
      await screen.findByText(
        "The person who prepared these figures cannot also approve them. Ask a second approver.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing was changed")).toBeInTheDocument();
  });

  it("stays honest when the intent cannot be read at all", async () => {
    vi.mocked(loadAccountingIntent).mockRejectedValue(new Error("offline"));
    renderIntent();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "This money movement is unavailable" }),
      ).toBeInTheDocument(),
    );
  });
});
