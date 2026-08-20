import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CustomerPortalView } from "./customer-portal-page";
import { MaterialComparisonSection } from "./material-comparison-section";
import { recordCustomerPortalDecision } from "./portal-api";
import type { CustomerPortalOptionPackage, CustomerPortalResponse } from "./portal-contracts";

// CustomerPortalView pulls the whole portal client in, so the factory has to answer for every
// export the tree imports, not just the one under test.
vi.mock("./portal-api", () => ({
  loadCustomerPortal: vi.fn(),
  recordCustomerPortalDecision: vi.fn(),
  requestCustomerContractAcceptanceChallenge: vi.fn(),
}));

const recordDecision = vi.mocked(recordCustomerPortalDecision);

const TOKEN = "a".repeat(43);

const better: CustomerPortalOptionPackage = {
  id: "OPT-BETTER",
  package_name: "Charcoal standing seam",
  tier: "Better",
  material_system: "26ga standing seam steel",
  price_delta: 2400,
  currency: "CAD",
  options: {
    colour: "Charcoal",
    panel_profile: "1.5in nail strip",
    // Non-scalar and oversized members must be dropped rather than walked into the DOM.
    swatch: { url: "https://example.invalid/charcoal.png" },
    injected: "<img src=x onerror=alert(1)>",
  },
  warranty_summary: "40-year finish warranty",
};

const good: CustomerPortalOptionPackage = {
  id: "OPT-GOOD",
  package_name: "Weathered slate asphalt",
  tier: "Good",
  material_system: null,
  price_delta: 0,
  currency: "CAD",
  options: null,
  warranty_summary: null,
};

function model(overrides: Partial<CustomerPortalResponse> = {}): CustomerPortalResponse {
  return {
    version: 1,
    brand: "IronWrap Exteriors",
    contract_acceptance_available: false,
    material_decision_available: true,
    source_updated_at: null,
    read_model_generated_at: "2026-08-20T10:00:00.000Z",
    job: { job_number: "IW-100", service_type: "Roofing", status: "In Production" },
    proposal: null,
    scope: [],
    option_packages: [good, better],
    progress: [],
    closeout: null,
    warranty: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MaterialComparisonSection", () => {
  it("renders each approved option with its tier, delta and detail pairs", () => {
    render(<MaterialComparisonSection model={model()} portalToken={TOKEN} />);

    expect(screen.getByRole("heading", { name: "Charcoal standing seam" })).toBeInTheDocument();
    expect(screen.getByText("Better")).toBeInTheDocument();
    expect(screen.getByText("+$2,400 vs. your current price")).toBeInTheDocument();
    expect(screen.getByText("Charcoal")).toBeInTheDocument();
    expect(screen.getByText("Panel profile:")).toBeInTheDocument();
    expect(screen.getByText("Included in your current price")).toBeInTheDocument();
  });

  it("renders an office-authored option value as text, never as markup", () => {
    const { container } = render(<MaterialComparisonSection model={model()} portalToken={TOKEN} />);

    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    // A nested object is not a scalar: it must not have produced a row at all.
    expect(screen.queryByText(/example\.invalid/)).toBeNull();
  });

  it("records the chosen option and confirms it without claiming anything was ordered", async () => {
    recordDecision.mockResolvedValue({ status: "recorded", decision_id: "decision_abc12345" });

    render(<MaterialComparisonSection model={model()} portalToken={TOKEN} />);
    fireEvent.click(screen.getAllByRole("button", { name: /choose this option/i })[0]!);

    await waitFor(() => expect(recordDecision).toHaveBeenCalledTimes(1));
    const call = recordDecision.mock.calls[0]![0];
    expect(call.token).toBe(TOKEN);
    expect(call.optionPackageId).toBe("OPT-GOOD");
    expect(call.idempotencyKey).toMatch(/^portal-decision:OPT-GOOD:/);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /You chose Weathered slate asphalt.*nothing\s+is billed or ordered/s,
    );
  });

  it("surfaces a failed selection as a retryable sentence, not a policy code", async () => {
    recordDecision.mockRejectedValue(new Error("decision_rejected"));

    render(<MaterialComparisonSection model={model()} portalToken={TOKEN} />);
    fireEvent.click(screen.getAllByRole("button", { name: /choose this option/i })[0]!);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not save that choice/i);
    expect(screen.queryByText(/decision_rejected/)).toBeNull();
  });

  it("shows the comparison read-only when the decision backend is unavailable", () => {
    render(
      <MaterialComparisonSection
        model={model({ material_decision_available: false })}
        portalToken={TOKEN}
      />,
    );

    expect(screen.getByRole("heading", { name: "Charcoal standing seam" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /choose this option/i })).toBeNull();
  });
});

describe("CustomerPortalView materials placement", () => {
  it("stays silent when the office has approved no option package", () => {
    render(<CustomerPortalView model={model({ option_packages: [] })} portalToken={TOKEN} />);

    expect(screen.queryByRole("heading", { name: /materials and colours/i })).toBeNull();
  });

  it("places materials between the approved scope and verified progress", () => {
    render(<CustomerPortalView model={model()} portalToken={TOKEN} />);

    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent ?? "");
    expect(headings.indexOf("Approved scope")).toBeLessThan(
      headings.indexOf("Materials and colours"),
    );
    expect(headings.indexOf("Materials and colours")).toBeLessThan(
      headings.indexOf("Verified progress"),
    );
  });
});
