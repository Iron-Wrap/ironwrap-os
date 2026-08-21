import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import {
  approvePostizIntent,
  connectPostiz,
  loadPostizIntent,
  reconcilePostizIntent,
  rejectPostizIntent,
  stopPostizIntent,
} from "./postiz-api";
import { PostizPage } from "./postiz-page";
import { postizIntentFixture, submittedPostizIntentFixture } from "./postiz-test-fixture";

function facebookOAuthUrl(): string {
  const query = new URLSearchParams({
    client_id: "client_123",
    redirect_uri: "https://postiz.example.invalid/integrations/social/facebook",
    state: "Ab12Cd",
    scope:
      "pages_show_list,business_management,pages_manage_posts,pages_manage_engagement,pages_read_engagement,read_insights",
  });
  return `https://www.facebook.com/v20.0/dialog/oauth?${query.toString()}`;
}

vi.mock("./postiz-api", () => ({
  loadPostizIntent: vi.fn(),
  connectPostiz: vi.fn(),
  approvePostizIntent: vi.fn(),
  rejectPostizIntent: vi.fn(),
  stopPostizIntent: vi.fn(),
  reconcilePostizIntent: vi.fn(),
  newPostizActionKey: vi.fn(() => "postiz:test:key"),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ intentId: "11111111-1111-4111-8111-111111111111" }),
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
  permissions: ["postiz.intent.read"],
  allowed_actions: ["postiz.intent.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-08-14T12:00:00.000Z",
  source_updated_at: null,
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

const opsSession = {
  ...ownerSession,
  user: {
    ...ownerSession.user,
    id: "appu_ops",
    email: "ops@example.invalid",
    display_name: "Operations",
    role: "ops",
  },
} satisfies AuthenticatedSession;

function renderPage(session: AuthenticatedSession = ownerSession) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <PostizPage />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("PostizPage", () => {
  beforeEach(() => {
    vi.mocked(loadPostizIntent).mockResolvedValue(postizIntentFixture());
    vi.mocked(approvePostizIntent).mockResolvedValue(postizIntentFixture());
    vi.mocked(stopPostizIntent).mockResolvedValue(postizIntentFixture());
    vi.mocked(rejectPostizIntent).mockResolvedValue(postizIntentFixture());
    vi.mocked(reconcilePostizIntent).mockResolvedValue(postizIntentFixture());
    vi.mocked(connectPostiz).mockResolvedValue({
      version: 1,
      connect_url: facebookOAuthUrl(),
      callback_origin: "https://postiz.example.invalid",
      provider: "facebook",
    });
  });

  it("renders the sanitized phone-first review and only server-declared controls", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Spring roof inspection reminder" }),
    ).toBeVisible();
    expect(
      screen.getByText("Book a documented spring roof inspection before the next thaw."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Review content" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve post" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Turn down" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop post" })).toBeNull();
    expect(screen.getByRole("button", { name: "Check saved state" })).toBeVisible();
    expect(screen.queryByText("provider_detail_not_exposed")).toBeNull();
    expect(screen.queryByText("marketing.social.publish.reviewed")).not.toBeVisible();
  });

  it("offers stop only after submission", async () => {
    vi.mocked(loadPostizIntent).mockResolvedValue(submittedPostizIntentFixture());
    renderPage();

    expect(await screen.findByRole("button", { name: "Stop post" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve post" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn down" })).toBeNull();
  });

  it("shows publication drift as manual reconciliation and never offers stop or a remote link", async () => {
    const fixture = submittedPostizIntentFixture();
    vi.mocked(loadPostizIntent).mockResolvedValue({
      ...fixture,
      allowed_actions: ["postiz.intent.review", "postiz.intent.reconcile"],
      intent: {
        ...fixture.intent,
        state: "reconciliation_required",
        error_code: "postiz_publication_drift_absent",
      },
      reconciliation: {
        ...fixture.reconciliation,
        remote_state: null,
        release_url: null,
        detail_code: "postiz_publication_drift_absent",
      },
    });
    renderPage();

    expect(await screen.findByText(/no longer matches what IronWrap saved/i)).toBeVisible();
    expect(screen.getByText(/will not take the post down/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check saved state" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop post" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View published post" })).toBeNull();
  });

  it("submits the displayed version through the bounded approval command", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Approve post" }));

    await waitFor(() =>
      expect(approvePostizIntent).toHaveBeenCalledWith(
        ownerSession,
        "11111111-1111-4111-8111-111111111111",
        7,
        "postiz:test:key",
      ),
    );
  });

  it("does not invent mutation controls when the server grants review only", async () => {
    vi.mocked(loadPostizIntent).mockResolvedValue({
      ...postizIntentFixture(),
      allowed_actions: ["postiz.intent.review"],
    });
    renderPage();

    expect(await screen.findByRole("link", { name: "Review content" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect Facebook" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve post" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop post" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check saved state" })).toBeNull();
  });

  it.each([opsSession, fieldSession])(
    "fails closed for $user.role before loading the intent",
    (session) => {
      vi.mocked(loadPostizIntent).mockClear();
      renderPage(session);

      expect(
        screen.getByRole("heading", { name: "This work belongs to another role" }),
      ).toBeVisible();
      expect(loadPostizIntent).not.toHaveBeenCalled();
    },
  );
});
