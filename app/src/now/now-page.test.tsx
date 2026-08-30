import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadOperatingIntake } from "../operating-intake/operating-intake-api";
import { operatingIntakePayload } from "../operating-intake/operating-intake-fixture";
import { loadNow } from "./now-api";
import type { NowResponse } from "./now-contracts";
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
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <NowPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("NowPage", () => {
  beforeEach(() => {
    vi.mocked(loadNow).mockResolvedValue(nowModel());
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
    expect(screen.getByRole("link", { name: "Work record" })).toHaveAttribute("href", "/owner");
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
        title: "Final invoice pending review",
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
    expect(screen.getByRole("link", { name: "Review final invoice" })).toHaveAttribute(
      "href",
      href,
    );
    expect(screen.queryByText(/@|street|customer/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("shows D1 website intake on the office work list without calling it a scheduled job", async () => {
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload());
    renderNow();

    expect(await screen.findByRole("heading", { name: "Website intake" })).toBeVisible();
    expect(screen.getByText("Launch Proof")).toBeVisible();
    expect(screen.getByText("Intake")).toBeVisible();
    expect(loadOperatingIntake).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: /open job/i })).toBeNull();
  });

  it("previews a long work section and reveals the rest on demand", async () => {
    const model = nowModel();
    const card = model.ui.sections[0]!.cards[0]!;
    model.ui.sections[0]!.cards = Array.from({ length: 6 }, (_, index) => ({
      ...card,
      id: `priority-${index}`,
      title: `Priority item ${index + 1}`,
    }));
    vi.mocked(loadNow).mockResolvedValue(model);
    renderNow();

    expect(await screen.findByText("Priority item 2")).toBeVisible();
    expect(screen.queryByText("Priority item 3")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    expect(screen.getByText("Priority item 6")).toBeVisible();
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("delegates field users to the existing Today surface without loading the office read", async () => {
    renderNow(fieldSession);

    expect(await screen.findByRole("heading", { name: "Field run sheet" })).toBeVisible();
    expect(loadNow).not.toHaveBeenCalled();
  });
});
