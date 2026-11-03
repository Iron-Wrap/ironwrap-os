import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppRole } from "../../lib/roles";
import type { GateStep } from "./gate-model";
import {
  clearedGate,
  gate,
  materialsProof,
  model,
  readyToSchedule,
  request,
  screen as gateScreen,
} from "./gate-test-fixtures";
import { GatesScreen } from "./job-gates-page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const type = async (user: ReturnType<typeof userEvent.setup>, label: string, value: string) =>
  await user.type(screen.getByLabelText(label), value);

const cases = [
  {
    name: "proof",
    step: "materials",
    gates: () => model("ended"),
    action: "Clear Materials with this proof",
    fill: async (user: ReturnType<typeof userEvent.setup>) =>
      await type(user, "Supplier reference", "synthetic-order"),
  },
  {
    name: "waiver request",
    step: "waive-materials",
    role: "production",
    gates: () => model("ended"),
    action: "Ask the owner to waive Materials",
    fill: async (user: ReturnType<typeof userEvent.setup>) =>
      await type(user, "Why waive Materials?", "The supplier reference is pending."),
  },
  {
    name: "owner waiver submission",
    step: "waive-access",
    gates: () => model("ended"),
    action: "Submit the Access waiver with reason",
    fill: async (user: ReturnType<typeof userEvent.setup>) =>
      await type(user, "Why waive Access?", "The crew can use the driveway."),
  },
  {
    name: "waiver decision",
    step: "waive-materials",
    gates: () =>
      model("ended", {
        Materials: gate("Materials", {
          open_waiver_requests: [request({ is_own_request: false })],
        }),
      }),
    action: "Approve the waiver with this reason",
    fill: async (user: ReturnType<typeof userEvent.setup>) =>
      await type(user, "Your reason (needed to approve or to decline)", "The owner checked it."),
  },
  {
    name: "reversal",
    step: "materials",
    gates: () => model("ended", { Materials: clearedGate("Materials", materialsProof, null) }),
    action: "Reverse the clearance with this reason",
    fill: async (user: ReturnType<typeof userEvent.setup>) =>
      await type(user, "Why reverse it?", "The proof names another order."),
  },
  {
    name: "settlement",
    step: "deposit",
    gates: () => model("ended", { Deposit: gate("Deposit") }),
    action: "Clear Deposit on the settled payment",
    fill: async () => undefined,
  },
  {
    name: "schedule",
    step: "crew",
    gates: readyToSchedule,
    action: "Schedule the crew",
    fill: async (user: ReturnType<typeof userEvent.setup>) => {
      const select = screen.getByLabelText("Which crew") as HTMLSelectElement;
      await user.selectOptions(select, select.options[1]!.value);
      await type(user, "Crew day starts", "2026-11-03T07:00");
    },
  },
  {
    name: "signed-copy receipt",
    step: "window",
    gates: () => model("unknown"),
    action: "Record when Elena Marchetti received it",
    fill: async (user: ReturnType<typeof userEvent.setup>) => {
      await type(user, "Signed copy received", "2026-10-20T18:26");
      await type(user, "Why are you recording it?", "The email was delivered.");
      await type(user, "Evidence reference", "synthetic-email-reference");
    },
  },
] satisfies Array<{
  name: string;
  step: GateStep;
  role?: AppRole;
  gates: typeof model;
  action: string;
  fill: (user: ReturnType<typeof userEvent.setup>) => Promise<unknown>;
}>;

describe("office commands are never queued for reconnect", () => {
  it.each(cases)(
    "refuses a $name tap during the connectivity race and sends nothing on reconnect",
    async (testCase) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <GatesScreen
            screen={gateScreen(testCase.gates(), {
              role: "role" in testCase ? testCase.role : "owner",
            })}
            step={testCase.step}
          />
        </QueryClientProvider>,
      );
      const user = userEvent.setup();
      await testCase.fill(user);
      const action = screen.getByRole("button", { name: testCase.action });
      expect(action).toBeEnabled();
      // Simulate the network manager noticing loss before the disabled UI has rerendered.
      onlineManager.setOnline(false);
      await user.click(action);
      expect(
        await screen.findByText("Nothing was sent. Reconnect, then choose the action again."),
      ).toBeVisible();
      await act(async () => onlineManager.setOnline(true));
      expect(fetcher).not.toHaveBeenCalled();
      expect(
        client
          .getMutationCache()
          .getAll()
          .some((mutation) => mutation.state.isPaused),
      ).toBe(false);
      client.clear();
    },
  );

  it("disables the open form immediately when the browser loses connectivity", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <GatesScreen screen={gateScreen(model("unknown"), { role: "owner" })} step="window" />
      </QueryClientProvider>,
    );
    const action = screen.getByRole("button", { name: "Record when Elena Marchetti received it" });
    expect(action).toBeEnabled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(action).toBeDisabled();
    client.clear();
  });
});
