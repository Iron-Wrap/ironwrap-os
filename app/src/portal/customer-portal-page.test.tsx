import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerPortalView } from "./customer-portal-page";
import type { CustomerPortalResponse } from "./portal-contracts";

const model: CustomerPortalResponse = {
  version: 1,
  brand: "IronWrap Exteriors",
  contract_acceptance_available: false,
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
  progress: [],
  closeout: null,
  warranty: null,
};

describe("CustomerPortalView", () => {
  it("renders published text as text, never as customer-supplied HTML", () => {
    const { container } = render(<CustomerPortalView model={model} />);

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not offer acceptance from a read-only capability without an approved quote", () => {
    render(<CustomerPortalView model={model} portalToken={"a".repeat(43)} />);

    expect(screen.queryByRole("button", { name: /email me a confirmation link/i })).toBeNull();
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

    expect(screen.queryByRole("button", { name: /email me a confirmation link/i })).toBeNull();
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

    expect(screen.getByRole("button", { name: /email me a confirmation link/i })).toBeInTheDocument();
  });
});
