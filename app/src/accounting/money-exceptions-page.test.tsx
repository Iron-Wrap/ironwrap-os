import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import { ApiError } from "../lib/api";
import { loadAccountingExceptions, resolveAccountingException } from "./money-api";
import { MoneyExceptionsPage } from "./money-exceptions-page";
import { accountingSession, exceptionListResponse, exceptionRow } from "./money-fixtures";

vi.mock("./money-api", () => ({
  loadAccountingExceptions: vi.fn(),
  resolveAccountingException: vi.fn(),
  newAccountingActionKey: (action: string) => `accounting:${action}:test-key-0000000000`,
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

function renderQueue() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={accountingSession()}>
        <MoneyExceptionsPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("money exception queue", () => {
  beforeEach(() => {
    vi.mocked(loadAccountingExceptions).mockReset();
    vi.mocked(resolveAccountingException).mockReset();
  });

  it("names the issue in words and keeps both check codes in system details", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue(exceptionListResponse());
    const user = userEvent.setup();
    renderQueue();

    expect(
      await screen.findByRole("heading", { name: "More was paid than was invoiced" }),
    ).toBeInTheDocument();
    await user.click(screen.getByText("System check"));
    expect(screen.getByText("Our check code")).toBeInTheDocument();
    expect(screen.getByText("QuickBooks check code")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("b".repeat(64))).toBeInTheDocument();
  });

  it("sends a reversal to the money movement instead of asking for a reference", async () => {
    // The fixture offers only reversing remedies, which is the shape ELEC-71 exploited: it typed
    // an invented reference into a free-text box and closed a real $240 overpayment with it. There
    // is no box now, and no reversing remedy is closeable from this screen at all.
    vi.mocked(loadAccountingExceptions).mockResolvedValue(exceptionListResponse());
    renderQueue();

    expect(await screen.findByText(/To put money back, open the money item/u)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Reference of the reversal in QuickBooks"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close this issue" })).not.toBeInTheDocument();
    expect(screen.getByText("You cannot close this issue from this page.")).toBeInTheDocument();
  });

  it("offers only the remedies that move no money, in the exception's own words", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue(
      exceptionListResponse([
        exceptionRow({
          offered_remedies: [
            "credit_memo_issued",
            "accepted_as_posted",
            "superseded_by_new_intent",
          ],
        }),
      ]),
    );
    renderQueue();

    const select = await screen.findByLabelText("What did you do?");
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "Choose an answer",
      "Accept what QuickBooks holds",
      "Replace it with new figures",
    ]);
    // Section 8.2: reversal is always provider-supported, never a deletion.
    expect(options.join(" ")).not.toMatch(/delete/iu);
  });

  it("does not ask for a reversal when the remedy moves no money", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue(
      exceptionListResponse([
        exceptionRow({
          offered_remedies: ["accepted_as_posted", "superseded_by_new_intent"],
        }),
      ]),
    );
    const user = userEvent.setup();
    renderQueue();

    await user.selectOptions(
      await screen.findByLabelText("What did you do?"),
      "Accept what QuickBooks holds",
    );
    expect(
      screen.queryByLabelText("Reference of the reversal in QuickBooks"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close this issue" })).toBeEnabled();
  });

  it("sends the chosen remedy and never a compensating effect", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue(
      exceptionListResponse([exceptionRow({ offered_remedies: ["accepted_as_posted"] })]),
    );
    vi.mocked(resolveAccountingException).mockResolvedValue({
      version: 1,
      read_model_generated_at: "2026-08-20T09:00:00.000Z",
      allowed_actions: ["accounting.exception.resolve"],
      exception: exceptionRow({ status: "resolved", resolution_action: "accepted_as_posted" }),
    });
    const user = userEvent.setup();
    renderQueue();

    await user.selectOptions(
      await screen.findByLabelText("What did you do?"),
      "Accept what QuickBooks holds",
    );
    await user.click(screen.getByRole("button", { name: "Close this issue" }));

    await waitFor(() => expect(resolveAccountingException).toHaveBeenCalledTimes(1));
    const call = vi.mocked(resolveAccountingException).mock.calls[0];
    expect(call?.[2]).toBe("accepted_as_posted");
    // The screen has nothing to claim a reversal with, which is the point.
    expect(call?.[3]).toBeNull();
    expect(await screen.findByText("Issue closed")).toBeInTheDocument();
  });

  it("turns a server refusal into a sentence rather than a code", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue(
      exceptionListResponse([exceptionRow({ offered_remedies: ["accepted_as_posted"] })]),
    );
    vi.mocked(resolveAccountingException).mockRejectedValue(
      new ApiError({
        message: "refused",
        status: 409,
        code: "accounting_exception_compensating_effect_unknown",
      }),
    );
    const user = userEvent.setup();
    renderQueue();

    await user.selectOptions(
      await screen.findByLabelText("What did you do?"),
      "Accept what QuickBooks holds",
    );
    await user.click(screen.getByRole("button", { name: "Close this issue" }));

    expect(
      await screen.findByText(
        "We have no record of that reversal reaching QuickBooks, so this stays open.",
      ),
    ).toBeInTheDocument();
  });

  it("offers no resolve control on an exception already closed", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue(
      exceptionListResponse([
        exceptionRow({ status: "resolved", resolution_action: "credit_memo_issued" }),
      ]),
    );
    renderQueue();

    expect(await screen.findByText("Closed as Issue a credit memo.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close this issue" })).not.toBeInTheDocument();
  });

  it("hides the resolve control from a role that may only read", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue({
      ...exceptionListResponse(),
      allowed_actions: ["accounting.read"],
    });
    renderQueue();

    await screen.findByRole("heading", { name: "More was paid than was invoiced" });
    expect(screen.queryByRole("button", { name: "Close this issue" })).not.toBeInTheDocument();
  });

  it("says the queue is empty rather than showing an empty list", async () => {
    vi.mocked(loadAccountingExceptions).mockResolvedValue(exceptionListResponse([]));
    renderQueue();

    expect(
      await screen.findByText("Nothing needs your help. All money issues are closed."),
    ).toBeInTheDocument();
  });

  it("stays honest when the queue cannot be read", async () => {
    vi.mocked(loadAccountingExceptions).mockRejectedValue(new Error("offline"));
    renderQueue();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Money issues are unavailable" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Nothing was changed/u)).toBeInTheDocument();
  });
});
