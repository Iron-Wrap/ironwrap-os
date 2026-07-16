import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CustomerPortalView } from "./customer-portal-page";
import type { CustomerPortalResponse } from "./portal-contracts";

const model: CustomerPortalResponse = {
  version: 1,
  brand: "IronWrap",
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
});
