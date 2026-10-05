import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerPortalView } from "./customer-portal-page";
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
    expect(within(overview).getByText("Payment due date not yet shared.")).toBeVisible();
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
