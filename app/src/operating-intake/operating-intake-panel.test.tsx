import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import { loadOperatingIntake } from "./operating-intake-api";
import { operatingIntakePayload } from "./operating-intake-fixture";
import { OperatingIntakePanel } from "./operating-intake-panel";

vi.mock("./operating-intake-api", () => ({ loadOperatingIntake: vi.fn() }));

const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_sales",
    email: "sales@example.invalid",
    display_name: "Sales",
    role: "sales",
    frappe_user_id: "sales@example.invalid",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["sales:read"],
  allowed_actions: ["sales.read"],
  csrf_token: "csrf",
  session_expires_at: "2026-08-21T18:00:00.000Z",
  source_updated_at: "2026-08-21T16:00:00.000Z",
  read_model_generated_at: "2026-08-21T16:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function renderPanel() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SessionProvider session={session}>
        <OperatingIntakePanel />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("OperatingIntakePanel", () => {
  beforeEach(() => {
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload());
  });

  it("shows a D1 website lead as intake, not as assigned or billed work", async () => {
    renderPanel();

    expect(await screen.findByRole("heading", { name: "Website intake" })).toBeVisible();
    expect(
      screen.getByText(
        "These are website leads stored on D1. They are not assigned field jobs, not published portal proposals, and not money intents.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Launch Proof")).toBeVisible();
    expect(screen.getByText("Intake")).toBeVisible();
    expect(screen.getByText("website")).toBeVisible();
    expect(screen.queryByText(/scheduled|invoice|assigned job/i)).toBeNull();
    expect(screen.queryByRole("link", { name: /open job/i })).toBeNull();
  });

  it("says when this tenant has no website intake", async () => {
    vi.mocked(loadOperatingIntake).mockResolvedValue(operatingIntakePayload({ leads: [] }));
    renderPanel();

    expect(await screen.findByText("No website intake leads for this tenant.")).toBeVisible();
    expect(screen.queryByText("Launch Proof")).toBeNull();
  });
});
