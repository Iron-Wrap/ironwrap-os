import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import { SessionProvider } from "../auth/session-context";
import {
  issueCustomerPortalLink,
  loadCustomerPortalLinks,
  revokeCustomerPortalLink,
} from "./customer-portal-office-api";
import { CustomerPortalOfficeAccess } from "./customer-portal-office-access";
import { customerPortalExpiryBounds, customerPortalExpiryToIso } from "./customer-portal-expiry";

vi.mock("./customer-portal-office-api", () => ({
  issueCustomerPortalLink: vi.fn(),
  loadCustomerPortalLinks: vi.fn(),
  revokeCustomerPortalLink: vi.fn(),
}));

const token = "A".repeat(43);
const activeLink = {
  id: "portal_11111111-1111-4111-8111-111111111111",
  roof_job_id: "JOB-A",
  created_at: "2030-01-01T12:00:00.000Z",
  expires_at: "2030-01-02T12:00:00.000Z",
  revoked_at: null,
  last_accessed_at: null,
  access_count: 0,
};
const ownerSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap OS",
    brand: "IronWrap",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read"],
  csrf_token: "csrf",
  session_expires_at: "2030-01-01T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2030-01-01T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

function futureExpiryInput(): string {
  return datetimeLocal(new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000));
}

function datetimeLocal(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function renderAccess(session: AuthenticatedSession = ownerSession) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider session={session}>
        <CustomerPortalOfficeAccess roofJobId="JOB-A" locale="en-CA" />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("CustomerPortalOfficeAccess", () => {
  it("rounds the visible minimum expiry up and validates against a fresh exact boundary", () => {
    const now = new Date(2030, 0, 1, 10, 0, 45).getTime();

    expect(customerPortalExpiryBounds(now).min).toBe("2030-01-01T11:01");
    expect(customerPortalExpiryToIso("2030-01-01T11:00", now)).toBeNull();
    expect(customerPortalExpiryToIso("2030-01-01T11:01", now)).toMatch(/^2030-01-01T/);
  });

  it("surfaces a stale expiry instead of submitting a now-invalid link request", async () => {
    const now = new Date(2030, 0, 1, 10, 0, 45).getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    vi.mocked(loadCustomerPortalLinks).mockResolvedValue({ links: [] });

    renderAccess();

    await screen.findByText("No customer portal link has been issued for this project.");
    fireEvent.change(screen.getByLabelText("Access expires at"), {
      target: { value: datetimeLocal(new Date(now + 60 * 60 * 1_000 + 15_000)) },
    });
    const issue = screen.getByRole("button", { name: "Issue customer link" });
    expect(issue).toBeEnabled();
    nowSpy.mockReturnValue(now + 90_000);
    fireEvent.click(issue);

    expect(await screen.findByText("Choose a current customer-access expiry.")).toBeInTheDocument();
    expect(issueCustomerPortalLink).not.toHaveBeenCalled();
  });

  it("requires an explicit expiry and keeps a newly issued bearer link copy-only in local UI", async () => {
    vi.mocked(loadCustomerPortalLinks).mockResolvedValue({ links: [activeLink] });
    vi.mocked(issueCustomerPortalLink).mockResolvedValue({
      link: activeLink,
      portal_url: `${window.location.origin}/portal#token=${token}`,
    });

    const { queryClient } = renderAccess();

    expect(await screen.findByText("Current customer access")).toBeInTheDocument();
    const expiry = screen.getByLabelText("Access expires at");
    const issue = screen.getByRole("button", { name: "Replace active link" });
    expect(issue).toBeDisabled();
    fireEvent.change(expiry, { target: { value: futureExpiryInput() } });
    expect(issue).toBeEnabled();
    fireEvent.click(issue);

    await waitFor(() => {
      expect(issueCustomerPortalLink).toHaveBeenCalledWith(
        ownerSession,
        expect.objectContaining({
          roofJobId: "JOB-A",
          expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      );
    });
    const issued = await screen.findByLabelText("New customer portal link");
    expect(issued).toHaveAttribute("readonly");
    expect(issued).toHaveValue(`${window.location.origin}/portal#token=${token}`);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /customer portal/i })).not.toBeInTheDocument();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain(token);
  });

  it("requires inline confirmation before revoking an active link", async () => {
    vi.mocked(loadCustomerPortalLinks).mockResolvedValue({ links: [activeLink] });
    vi.mocked(revokeCustomerPortalLink).mockResolvedValue();

    renderAccess();

    await screen.findByText("Current customer access");
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(revokeCustomerPortalLink).not.toHaveBeenCalled();
    expect(screen.getByText("Revoke this customer link?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    await waitFor(() => {
      expect(revokeCustomerPortalLink).toHaveBeenCalledWith(ownerSession, activeLink.id);
    });
  });

  it("never reads or changes access from an offline session", async () => {
    renderAccess({ ...ownerSession, csrf_token: "offline-session-no-csrf" });

    expect(screen.getByText("Customer links are unavailable offline.")).toBeInTheDocument();
    expect(loadCustomerPortalLinks).not.toHaveBeenCalled();
    expect(issueCustomerPortalLink).not.toHaveBeenCalled();
  });

  it("does not expose the control to a non-office session", () => {
    const fieldSession: AuthenticatedSession = {
      ...ownerSession,
      user: { ...ownerSession.user, role: "field" },
    };
    renderAccess(fieldSession);

    expect(screen.queryByRole("heading", { name: "Customer access" })).not.toBeInTheDocument();
    expect(loadCustomerPortalLinks).not.toHaveBeenCalled();
  });
});
