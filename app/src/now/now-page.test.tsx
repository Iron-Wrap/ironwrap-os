import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadNow } from "./now-api";
import type { NowResponse } from "./now-contracts";
import { NowPage } from "./now-page";

vi.mock("./now-api", () => ({ loadNow: vi.fn() }));
vi.mock("../field/field-pages", () => ({
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

function nowModel(title = "What needs you now"): NowResponse {
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
      explanation: "Resolve the first verified exception, then return for the next one.",
      sync_label: "Production is limited and is not treated as clear.",
      primary_action: {
        id: "refresh-now",
        label: "Refresh live records",
        kind: "refresh",
        href: null,
        reason: "Production may have recovered.",
        citation_ids: [],
      },
      sections: [
        {
          id: "decide-first",
          title: "Decide first",
          summary: "One verified exception needs a decision.",
          cards: [
            {
              id: "owner:blocked-gate",
              tone: "critical",
              eyebrow: "Blocked gate",
              title: "Delivery confirmation is missing",
              detail: "The job cannot move until delivery is verified.",
              action: {
                id: "open-owner",
                label: "Review exception",
                kind: "navigate",
                href: "/owner",
                reason: "The owner exception record has the decision context.",
                citation_ids: ["owner:blocked-gate"],
              },
              citations: [
                {
                  id: "owner:blocked-gate",
                  label: "Owner exception record",
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
  });

  it("renders the trusted owner view with one emphasized action and clear sync truth", async () => {
    renderNow();

    expect(await screen.findByRole("heading", { name: "What needs you now" })).toBeVisible();
    expect(screen.getByText("Production is limited and is not treated as clear.")).toBeVisible();
    expect(screen.getByText("Delivery confirmation is missing")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh live records" })).toBeVisible();
    const exceptionLink = screen.getByRole("link", { name: "Review exception" });
    expect(exceptionLink).toHaveAttribute("href", "/owner");
    expect(exceptionLink).toHaveAccessibleDescription(
      "The owner exception record has the decision context. Owner exception record",
    );
    expect(screen.getByRole("link", { name: "Owner exception record" })).toHaveAttribute(
      "href",
      "/owner",
    );
    expect(
      screen.getByRole("button", { name: "Refresh live records" }),
    ).toHaveAccessibleDescription("Production may have recovered.");
    expect(screen.getByText("Production").nextSibling).toHaveTextContent("Limited");
  });

  it("refreshes the same bounded read when the primary action asks for fresh records", async () => {
    const user = userEvent.setup();
    vi.mocked(loadNow)
      .mockResolvedValueOnce(nowModel())
      .mockResolvedValueOnce(nowModel("What changed now"));
    renderNow();

    await user.click(await screen.findByRole("button", { name: "Refresh live records" }));

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

    expect(await screen.findByRole("link", { name: "Review exception" })).toHaveAttribute(
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

  it("delegates field users to the existing Today surface without loading the office read", async () => {
    renderNow(fieldSession);

    expect(await screen.findByRole("heading", { name: "Field run sheet" })).toBeVisible();
    expect(loadNow).not.toHaveBeenCalled();
  });
});
