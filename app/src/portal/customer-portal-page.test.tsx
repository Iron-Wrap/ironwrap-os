import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearPendingMagicLinkToken } from "../auth/magic-link-fragment";
import { persistAuthenticatedSession } from "../auth/session";
import { resetDatabaseForTests } from "../storage/db";
import { CustomerPortalPage, CustomerPortalView } from "./customer-portal-page";
import type { CustomerPortalResponse } from "./portal-contracts";

const model: CustomerPortalResponse = {
  version: 1,
  brand: "IronWrap Exteriors",
  contract_acceptance_available: false,
  material_decision_available: false,
  source_updated_at: null,
  read_model_generated_at: "2026-07-16T10:00:00.000Z",
  job: { job_number: "IW-100", service_type: "Roofing", status: "In Production" },
  proposal: null,
  scope: [
    {
      id: "scope-1",
      type: "Included",
      title: "Roof scope",
      text: "<img src=x onerror=alert(1)>",
      version: "1",
    },
  ],
  option_packages: [],
  progress: [],
  closeout: null,
  warranty: null,
};

describe("CustomerPortalView", () => {
  it("prioritizes the published balance and due date while keeping the installation schedule unknown", () => {
    const withPayment: CustomerPortalResponse = {
      ...model,
      proposal: {
        status: "Sent",
        prepared_at: null,
        approved_at: null,
        signed_at: null,
        quote: {
          version: 2,
          status: "Approved",
          total: 9000,
          currency: "CAD",
          deposit_amount: null,
          balance_due: 5384.25,
          payment_status: "Part paid",
          payment_due_date: "2026-10-13",
          valid_until: null,
          scope_summary: null,
          assumptions: null,
          exclusions: null,
        },
      },
    };
    render(<CustomerPortalView model={withPayment} />);
    const overview = screen.getByRole("region", { name: "Project overview" });
    expect(within(overview).getByText("$5,384.25")).toBeVisible();
    expect(within(overview).getByText(/Due Oct 13, 2026/)).toBeVisible();
    expect(within(overview).getByText("Part paid")).toBeVisible();
    expect(within(overview).getByText("Schedule not yet shared")).toBeVisible();
    const proposal = screen.getByText("Project proposal").closest("#project-proposal");
    expect(overview.compareDocumentPosition(proposal!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("shows the booked installation in the office's own time, whatever the phone's zone", () => {
    render(
      <CustomerPortalView
        model={{
          ...model,
          install_window: {
            scheduled_start: "2026-10-14T08:00:00-06:00",
            scheduled_end: "2026-10-14T12:00:00-06:00",
            confirmed: true,
            confirmation_basis: "office_committed_assignment",
          },
        }}
      />,
    );
    const overview = screen.getByRole("region", { name: "Project overview" });
    expect(within(overview).getByText("Wednesday, October 14, 2026")).toBeVisible();
    expect(within(overview).getByText("Work planned from 8:00 a.m. to 12:00 p.m.")).toBeVisible();
    expect(
      within(overview).getByText(
        "IronWrap Exteriors booked this time. If it does not work for you, contact them.",
      ),
    ).toBeVisible();
    expect(within(overview).queryByText("Schedule not yet shared")).toBeNull();
  });

  it("offers the company's own phone and email only when the office shared them", () => {
    const { rerender } = render(<CustomerPortalView model={model} />);
    expect(screen.queryByRole("link", { name: /^Call / })).toBeNull();
    rerender(
      <CustomerPortalView
        model={{
          ...model,
          company_contact: { phone: "+14035550100", email: "office@example.com" },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Call IronWrap Exteriors" })).toHaveAttribute(
      "href",
      "tel:+14035550100",
    );
    expect(screen.getByRole("link", { name: "Email IronWrap Exteriors" })).toHaveAttribute(
      "href",
      "mailto:office@example.com",
    );
    rerender(
      <CustomerPortalView
        model={{ ...model, company_contact: { phone: null, email: "office@example.com" } }}
      />,
    );
    expect(screen.queryByRole("link", { name: /^Call / })).toBeNull();
    expect(screen.getByRole("link", { name: "Email IronWrap Exteriors" })).toBeVisible();
  });

  it("does not infer a balance from the proposal total or a customer contact from a placeholder", () => {
    const { container } = render(
      <CustomerPortalView
        model={{
          ...model,
          proposal: {
            status: "Sent",
            prepared_at: null,
            approved_at: null,
            signed_at: null,
            quote: {
              version: 2,
              status: "Approved",
              total: 9000,
              currency: "CAD",
              deposit_amount: null,
              balance_due: null,
              payment_status: null,
              payment_due_date: null,
              valid_until: null,
              scope_summary: null,
              assumptions: null,
              exclusions: null,
            },
          },
        }}
      />,
    );
    const overview = screen.getByRole("region", { name: "Project overview" });
    expect(within(overview).getByText("Amount not yet shared")).toBeVisible();
    expect(within(overview).queryByText(/9,000/)).not.toBeInTheDocument();
    expect(within(overview).getByText(/Your proposal price is not a bill\./)).toBeVisible();
    expect(within(overview).getByText(/Ask them if you need it sooner/)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText("MR", { exact: true })).not.toBeInTheDocument();
    expect(within(overview).getByRole("link", { name: "See project updates" })).toHaveAttribute(
      "href",
      "#project-progress",
    );
    expect(container.querySelector("#project-progress")).toHaveTextContent("Project updates");
  });
  it("renders published text as text, never as customer-supplied HTML", () => {
    const { container } = render(<CustomerPortalView model={model} />);

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not offer acceptance from a read-only capability without an approved quote", () => {
    render(<CustomerPortalView model={model} portalToken={"a".repeat(43)} />);

    expect(screen.queryByRole("button", { name: /send acceptance email/i })).toBeNull();
  });

  it("does not offer acceptance when the backend acceptance flow is disabled or not configured", () => {
    render(
      <CustomerPortalView
        model={{
          ...model,
          proposal: {
            status: "Approved",
            prepared_at: null,
            approved_at: null,
            signed_at: null,
            quote: {
              version: 2,
              status: "Approved",
              total: 1000,
              currency: "CAD",
              deposit_amount: null,
              balance_due: 1000,
              payment_status: null,
              payment_due_date: null,
              valid_until: null,
              scope_summary: null,
              assumptions: null,
              exclusions: null,
            },
          },
        }}
        portalToken={"a".repeat(43)}
      />,
    );

    expect(screen.queryByRole("button", { name: /send acceptance email/i })).toBeNull();
  });

  it("offers acceptance when the proposal is approved and the backend flow is available", () => {
    render(
      <CustomerPortalView
        model={{
          ...model,
          contract_acceptance_available: true,
          proposal: {
            status: "Approved",
            prepared_at: null,
            approved_at: null,
            signed_at: null,
            quote: {
              version: 2,
              status: "Approved",
              total: 1000,
              currency: "CAD",
              deposit_amount: null,
              balance_due: 1000,
              payment_status: null,
              payment_due_date: null,
              valid_until: null,
              scope_summary: null,
              assumptions: null,
              exclusions: null,
            },
          },
        }}
        portalToken={"a".repeat(43)}
      />,
    );

    expect(screen.getByRole("button", { name: /send acceptance email/i })).toBeInTheDocument();
  });
});

describe("CustomerPortalPage", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearPendingMagicLinkToken();
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    await resetDatabaseForTests();
  });

  it.each([
    ["no office sign-in", false, { token: "p".repeat(43) }],
    ["a live office sign-in", true, { token: "p".repeat(43), staff_preview: true }],
  ])("with %s, the resolve request is %j", async (_label, signedIn, body) => {
    if (signedIn) {
      await persistAuthenticatedSession({
        version: 1,
        authenticated: true,
        user: {
          id: "appu_owner_0001",
          email: "owner@example.invalid",
          display_name: "Owner",
          role: "owner",
          frappe_user_id: null,
        },
        tenant: {
          id: "ironwrap",
          name: "IronWrap Exteriors",
          brand: "IronWrap Exteriors",
          locale: "en-CA",
          time_zone: "America/Edmonton",
          currency: "CAD",
        },
        permissions: [],
        allowed_actions: [],
        csrf_token: "csrf-token",
        session_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        source_updated_at: null,
        read_model_generated_at: new Date().toISOString(),
        stale_fields: [],
      });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(model));
    vi.stubGlobal("fetch", fetcher);
    const open = vi.spyOn(indexedDB, "open");
    clearPendingMagicLinkToken();
    window.history.replaceState(null, "", `/portal#token=${"p".repeat(43)}`);

    render(<CustomerPortalPage />);

    expect(await screen.findByText(/IW-100/)).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/v1/customer-portal/resolve");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(init?.credentials).toBe("omit");
    // Neither a customer's device nor a staff one opens the local database to decide the flag.
    expect(open).not.toHaveBeenCalled();
  });
});
