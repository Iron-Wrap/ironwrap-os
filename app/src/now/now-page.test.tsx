import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadOperatingIntake } from "../operating-intake/operating-intake-api";
import { operatingIntakePayload } from "../operating-intake/operating-intake-fixture";
import { loadNow } from "./now-api";
import { nowResponseSchema, type NowResponse } from "./now-contracts";
import { NowPage } from "./now-page";

vi.mock("./now-api", () => ({ loadNow: vi.fn() }));
vi.mock("../operating-intake/operating-intake-api", () => ({
  loadOperatingIntake: vi.fn(),
}));
vi.mock("../field/today-page", () => ({
  TodayPage: () => <h1>Field run sheet</h1>,
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
  permissions: ["owner.now.read"],
  allowed_actions: ["job.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-08-14T12:00:00.000Z",
  source_updated_at: "2026-08-13T07:59:00.000Z",
  read_model_generated_at: "2026-08-13T08:00:00.000Z",
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
  },
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

function nowModel(title = "Work to do now"): NowResponse {
  return {
    version: 1,
    role: "owner",
    read_model_generated_at: "2026-08-13T08:00:00.000Z",
    permissions: ["owner.now.read"],
    allowed_actions: ["job.read"],
    sources: [
      {
        id: "owner",
        state: "current",
        read_model_generated_at: "2026-08-13T07:59:00.000Z",
        stale_fields: [],
      },
      {
        id: "facet",
        state: "current",
        read_model_generated_at: "2026-08-13T07:58:30.000Z",
        stale_fields: [],
      },
      {
        id: "production",
        state: "limited",
        read_model_generated_at: "2026-08-13T07:58:00.000Z",
        stale_fields: ["partial.materials"],
      },
      {
        id: "sales",
        state: "current",
        read_model_generated_at: "2026-08-13T07:57:00.000Z",
        stale_fields: [],
      },
    ],
    ui: {
      schema_version: 1,
      state: "limited",
      title,
      explanation: "Start with the first item, then come back for the next one.",
      sync_label: "Some job data is missing. IronWrap will not mark it as done.",
      primary_action: {
        id: "refresh-now",
        label: "Check all lists again",
        kind: "refresh",
        href: null,
        reason: "The job list may be back.",
        citation_ids: [],
      },
      sections: [
        {
          id: "decide-first",
          title: "Check first",
          summary: "One item needs a check.",
          cards: [
            {
              id: "owner:blocked-gate",
              tone: "critical",
              eyebrow: "Blocked gate",
              title: "Delivery confirmation is missing",
              detail: "The job cannot move until delivery is verified.",
              action: {
                id: "open-owner",
                label: "Open item",
                kind: "navigate",
                href: "/owner",
                reason: "Open the work record and choose the next safe step.",
                citation_ids: ["owner:blocked-gate"],
              },
              citations: [
                {
                  id: "owner:blocked-gate",
                  label: "Work record",
                  source: "owned_read_model",
                  href: "/owner",
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function renderNow(session: AuthenticatedSession = ownerSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SessionProvider session={session}>
          <NowPage />
        </SessionProvider>
      </QueryClientProvider>,
    ),
  };
}

describe("NowPage", () => {
  beforeEach(() => {
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.mocked(loadNow).mockReset().mockResolvedValue(nowModel());
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload({ leads: [] }));
  });

  it("renders the owner work list with one main action and clear list status", async () => {
    const user = userEvent.setup();
    renderNow();

    expect(await screen.findByRole("heading", { name: "Work to do now" })).toBeVisible();
    expect(
      screen.getByText("Some job data is missing. IronWrap will not mark it as done."),
    ).toBeVisible();
    expect(screen.getByRole("complementary", { name: "List status" })).toBeVisible();
    expect(screen.getByText("Delivery confirmation is missing")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check all lists again" })).toBeVisible();
    const exceptionLink = screen.getByRole("link", { name: "Open item" });
    expect(exceptionLink).toHaveAttribute("href", "/owner");
    expect(exceptionLink).toHaveAccessibleDescription(
      "Open the work record and choose the next safe step. Work record",
    );
    await user.click(screen.getByRole("button", { name: "Delivery confirmation is missing" }));
    expect(
      within(screen.getByRole("complementary", { name: "Selected item" })).getByRole("link", {
        name: "Work record",
      }),
    ).toHaveAttribute("href", "/owner");
    expect(
      screen.getByRole("button", { name: "Check all lists again" }),
    ).toHaveAccessibleDescription("The job list may be back.");
    await user.click(screen.getByText("System details"));
    expect(screen.getByText("Jobs").nextSibling).toHaveTextContent("Needs a check");
  });

  it("refreshes the same bounded read when the primary action asks for fresh records", async () => {
    const user = userEvent.setup();
    vi.mocked(loadNow)
      .mockResolvedValueOnce(nowModel())
      .mockResolvedValueOnce(nowModel("What changed now"));
    renderNow();

    await user.click(await screen.findByRole("button", { name: "Check all lists again" }));

    expect(await screen.findByRole("heading", { name: "What changed now" })).toBeVisible();
    expect(loadNow).toHaveBeenCalledTimes(2);
  });

  it("links an actionable marketing exception to its bounded Postiz intent detail", async () => {
    const model = nowModel();
    const card = model.ui.sections[0]!.cards[0]!;
    card.action = {
      ...card.action!,
      kind: "navigate",
      href: "/marketing/postiz/intent%3A001",
    };
    card.citations[0] = {
      ...card.citations[0]!,
      href: "/marketing/postiz/intent%3A001",
    };
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow();

    expect(await screen.findByRole("link", { name: "Open item" })).toHaveAttribute(
      "href",
      "/marketing/postiz/intent%3A001",
    );
  });

  it("renders one actionable QuickBooks finance card without PII or a browser write", async () => {
    const href = "/accounting/quickbooks/final-invoices/qbo_final_01JEXAMPLE0001";
    const model = nowModel("Accounting Now");
    model.role = "accounting";
    model.sources = [
      {
        id: "quickbooks_final_invoices",
        state: "current",
        read_model_generated_at: "2026-08-13T07:59:00.000Z",
        stale_fields: [],
      },
    ];
    model.ui.primary_action = null;
    model.ui.sections[0]!.cards = [
      {
        kind: "quickbooks_final_invoice",
        id: "qbo-final-invoice:qbo_final_01JEXAMPLE0001",
        tone: "attention",
        eyebrow: "QuickBooks final invoice",
        title: "Final invoice needs a check",
        detail: "CAD 1050.00",
        job_id: "JOB-0001",
        currency: "CAD",
        final_balance: "1050.00",
        invoice_state: "pending_review",
        blocker_code: null,
        rejection_reason: null,
        next_step: "refresh_candidate",
        action: { label: "Review final invoice", href },
        citations: [
          {
            id: "qbo-citation-1",
            label: "Completion packet",
            source: "owned_read_model",
            href,
          },
        ],
      },
    ];
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow(accountingSession);

    expect(await screen.findByRole("heading", { name: "Accounting Now" })).toBeVisible();
    expect(screen.getByText("JOB-0001")).toBeVisible();
    expect(screen.getByText("CAD 1050.00")).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Handoffs and evidence" })).toHaveTextContent(
      "CAD 1,050.00",
    );
    expect(
      screen.getByText("1 loaded invoice balance. This is not total receivables."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Review final invoice" })).toHaveAttribute(
      "href",
      href,
    );
    expect(screen.queryByText(/@|street|customer/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("keeps missing proposal sources explicit and never claims agent authorship", async () => {
    const model = nowModel();
    model.decisions = {
      version: 1,
      state: "empty",
      sources: [
        {
          kind: "quote_revision",
          state: "current",
          loaded_count: 0,
          has_more: false,
          next_cursor: null,
          read_model_generated_at: model.read_model_generated_at,
        },
      ],
      items: [],
    };
    vi.mocked(loadNow).mockResolvedValue(nowResponseSchema.parse(model));
    renderNow();

    expect(
      await screen.findByText("Proposal verdicts are unavailable or incomplete."),
    ).toBeVisible();
    expect(screen.getByText(/Agent authorship is not recorded/)).toBeVisible();
    expect(screen.getByText(/older receipts may be absent/)).toBeVisible();
    expect(
      screen.queryByText(/Completed approvals are on each job record/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No open proposals in the loaded list.")).not.toBeInTheDocument();
    expect(screen.getByText("Money amounts are not included in this work list.")).toBeVisible();
  });

  it("links an uncertain proposal result to the existing review route and current request version", async () => {
    const model = nowModel();
    const id = "proposal-publication-approval:test_approval_001";
    model.decisions = {
      version: 1,
      state: "ready",
      sources: ["quote_revision", "proposal_publication"].map((kind) => ({
        kind: kind as "quote_revision" | "proposal_publication",
        state: "current" as const,
        loaded_count: kind === "proposal_publication" ? 1 : 0,
        has_more: false,
        next_cursor: null,
        read_model_generated_at: model.read_model_generated_at,
      })),
      items: [
        {
          kind: "proposal_publication",
          key: `proposal_publication:${id}`,
          id,
          version: 9,
          title: "Check the publication result",
          summary: "The recorded run needs a result check.",
          native_state: "execution_uncertain",
          job_id: "JOB-0001",
          updated_at: model.read_model_generated_at,
          expires_at: null,
          review_href: "/estimator/jobs/JOB-0001",
        },
      ],
    };
    vi.mocked(loadNow).mockResolvedValue(nowResponseSchema.parse(model));
    renderNow();

    const verdicts = await screen.findByRole("list", { name: "Loaded proposal verdicts" });
    expect(
      within(verdicts).getByRole("link", { name: "Check the publication result" }),
    ).toHaveAttribute("href", "/estimator/jobs/JOB-0001");
    // A version number never stands in a person's line (ruling); the receipt keeps it.
    expect(verdicts).not.toHaveTextContent(/\b[vV]9\b|version 9/i);
    expect(within(verdicts).getByText(/^Updated /)).toBeVisible();
    expect(verdicts).not.toHaveTextContent("Approved");
  });

  it("shows D1 website intake on the office work list without calling it a scheduled job", async () => {
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload());
    renderNow();

    expect(await screen.findByRole("heading", { name: "Website intake" })).toBeVisible();
    const urgentWork = screen.getByRole("button", { name: "Delivery confirmation is missing" });
    expect(
      urgentWork.compareDocumentPosition(screen.getByRole("heading", { name: "Website intake" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Launch Proof")).toBeVisible();
    expect(screen.getByText("Intake")).toBeVisible();
    expect(loadOperatingIntake).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: /open job/i })).toBeNull();
  });

  it("keeps every loaded item reachable in the compact work rows", async () => {
    const model = nowModel();
    const card = model.ui.sections[0]!.cards[0]!;
    model.ui.sections[0]!.cards = Array.from({ length: 6 }, (_, index) => ({
      ...card,
      id: `priority-${index}`,
      title: `Priority item ${index + 1}`,
    }));
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow();

    expect(await screen.findByRole("button", { name: "Priority item 6" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Check first" }).children).toHaveLength(6);
    expect(screen.getByRole("button", { name: "All work 6" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("delegates field users to the existing Today surface without loading the office read", async () => {
    renderNow(fieldSession);

    expect(await screen.findByRole("heading", { name: "Field run sheet" })).toBeVisible();
    expect(loadNow).not.toHaveBeenCalled();
  });
  it("filters only by server sections, never by tone or invented decision state", async () => {
    const model = nowModel();
    model.ui.sections.push({
      id: "source-without-special-meaning",
      title: "Follow-up work",
      summary: "A bounded source.",
      cards: [
        {
          ...model.ui.sections[0]!.cards[0]!,
          id: "follow-up",
          title: "Follow-up requires review",
          tone: "critical",
        },
      ],
    });
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow();
    await userEvent.click(await screen.findByRole("button", { name: "Follow-up work 1" }));
    expect(screen.queryByRole("button", { name: "Delivery confirmation is missing" })).toBeNull();
    expect(screen.getByRole("button", { name: "Follow-up requires review" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Decisions|^Waiting/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "All work 2" }));
    expect(screen.getByRole("button", { name: "Delivery confirmation is missing" })).toBeVisible();
  });

  it("moves selection with keyboard and returns focus when the desktop inspector closes", async () => {
    const model = nowModel();
    const card = model.ui.sections[0]!.cards[0]!;
    model.ui.sections[0]!.cards.push({ ...card, id: "second", title: "Second work item" });
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow();
    const first = await screen.findByRole("button", { name: card.title });
    first.focus();
    await userEvent.keyboard("j");
    const second = screen.getByRole("button", { name: "Second work item" });
    expect(second).toHaveFocus();
    expect(
      within(screen.getByRole("complementary", { name: "Selected item" })).getByRole("heading", {
        name: "Second work item",
      }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(second).toHaveFocus();
    expect(screen.getByRole("complementary", { name: "Work overview" })).toBeVisible();
    await userEvent.keyboard("k{Enter}");
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute("aria-expanded", "true");
  });

  it("opens bounded card facts in the phone drawer and keeps navigation separate", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ ...window.matchMedia(""), matches: false });
    renderNow();
    const row = await screen.findByRole("button", { name: "Delivery confirmation is missing" });
    await userEvent.click(row);
    const drawer = screen.getByRole("dialog", { name: "Delivery confirmation is missing" });
    expect(drawer).toBeVisible();
    expect(within(drawer).getByRole("link", { name: "Open item" })).toHaveAttribute(
      "href",
      "/owner",
    );
    expect(within(drawer).getByRole("link", { name: "Work record" })).toHaveAttribute(
      "href",
      "/owner",
    );
    await userEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row).toHaveAttribute("aria-expanded", "false");
  });

  it("refreshes selected facts from the current card and drops a selection removed by the server", async () => {
    const initial = nowModel();
    const updated = nowModel();
    updated.ui.sections[0]!.cards[0]!.detail = "The latest bounded reason.";
    const removed = nowModel();
    removed.ui.sections = [];
    vi.mocked(loadNow)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(removed);
    renderNow();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delivery confirmation is missing" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      await within(screen.getByRole("complementary", { name: "Selected item" })).findByText(
        "The latest bounded reason.",
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("No items in this loaded list.")).toBeVisible();
    expect(screen.queryByRole("complementary", { name: "Selected item" })).toBeNull();
  });

  it("keeps stale rows and selected facts when refresh fails", async () => {
    vi.mocked(loadNow)
      .mockResolvedValueOnce(nowModel())
      .mockRejectedValueOnce(new Error("network unavailable"));
    renderNow({ ...ownerSession, csrf_token: "offline-session-no-csrf" });
    await userEvent.click(
      await screen.findByRole("button", { name: "Delivery confirmation is missing" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The last saved list is still shown",
    );
    expect(
      within(screen.getByRole("complementary", { name: "Selected item" })).getByRole("link", {
        name: "Open item",
      }),
    ).toHaveAttribute("href", "/owner");
    expect(loadNow).toHaveBeenCalledTimes(2);
  });

  it("does not turn missing actions or empty limited data into an all-clear", async () => {
    const model = nowModel();
    model.ui.sections[0]!.cards[0]!.action = null;
    model.ui.sections[0]!.cards[0]!.citations = [];
    model.ui.sections.push({
      id: "unavailable",
      title: "Unloaded source",
      summary: "This source did not load.",
      cards: [],
    });
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow();
    await userEvent.click(await screen.findByRole("button", { name: "View details" }));
    expect(
      screen.getByText("No action or linked work record is available for this item."),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Unloaded source 0" }));
    expect(screen.getByText("This source did not load.")).toBeVisible();
    expect(screen.getByText("No items in this loaded section.")).toBeVisible();
    expect(
      screen.getByText("Some job data is missing. IronWrap will not mark it as done."),
    ).toBeVisible();
  });

  it("retains the initial error and mismatched-role guards", async () => {
    vi.mocked(loadNow)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ ...nowModel(), role: "sales" });
    renderNow();
    expect(await screen.findByRole("heading", { name: "Your work did not load" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { name: "Sign in again" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delivery confirmation is missing" })).toBeNull();
  });
  it("keeps the action's declared evidence separate from other linked records", async () => {
    const model = nowModel();
    model.ui.sections[0]!.cards[0]!.citations.push({
      id: "extra",
      label: "Other job record",
      source: "owned_read_model",
      href: "/production",
    });
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delivery confirmation is missing" }),
    );
    const details = within(screen.getByRole("complementary", { name: "Selected item" }));
    expect(details.getByRole("link", { name: "Open item" })).toHaveAccessibleDescription(
      "Open the work record and choose the next safe step. Work record",
    );
    expect(details.getByRole("link", { name: "Other job record" })).toHaveAttribute(
      "href",
      "/production",
    );
  });
  it("does not reopen a phone drawer when removed work returns in a later read", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ ...window.matchMedia(""), matches: false });
    const removed = nowModel();
    removed.ui.sections = [];
    vi.mocked(loadNow)
      .mockResolvedValueOnce(nowModel())
      .mockResolvedValueOnce(removed)
      .mockResolvedValueOnce(nowModel());
    const { client } = renderNow();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delivery confirmation is missing" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => {
      await client.refetchQueries({ queryKey: ["now"] });
    });
    expect(await screen.findByText("No items in this loaded list.")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "All work 0" })).toHaveFocus();
    await act(async () => {
      await client.refetchQueries({ queryKey: ["now"] });
    });
    expect(
      await screen.findByRole("button", { name: "Delivery confirmation is missing" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "All work 1" })).toHaveFocus();
  });

  it("announces a failed card retry inside the phone drawer that holds focus", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ ...window.matchMedia(""), matches: false });
    const model = nowModel();
    model.ui.sections[0]!.cards[0]!.action = {
      id: "retry-jobs",
      kind: "refresh",
      href: null,
      label: "Try again",
      reason: "The jobs list did not load.",
      citation_ids: [],
    };
    vi.mocked(loadNow)
      .mockResolvedValueOnce(model)
      .mockRejectedValueOnce(new Error("network unavailable"));
    renderNow();
    await userEvent.click(
      await screen.findByRole("button", { name: "Delivery confirmation is missing" }),
    );
    const drawer = within(screen.getByRole("dialog"));
    await userEvent.click(drawer.getByRole("button", { name: "Try again" }));
    expect(await drawer.findByRole("alert")).toHaveTextContent(
      "The last saved list is still shown",
    );
    expect(drawer.getByRole("link", { name: "Work record" })).toHaveAttribute("href", "/owner");
    expect(loadNow).toHaveBeenCalledTimes(2);
  });
});
