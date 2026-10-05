import { describe, expect, it } from "vitest";

import { customerPortalResponseSchema } from "./portal-contracts";

const base = {
  version: 1,
  brand: "IronWrap Exteriors",
  contract_acceptance_available: false,
  material_decision_available: false,
  source_updated_at: null,
  read_model_generated_at: "2026-07-16T10:00:00.000Z",
  job: { job_number: "IW-100", service_type: "Roofing", status: "In Production" },
  proposal: null,
  scope: [],
  option_packages: [],
  progress: [],
  closeout: null,
  warranty: null,
};

describe("customer portal company contact", () => {
  it("parses responses with and without the owner-shared contact", () => {
    expect(customerPortalResponseSchema.safeParse(base).success).toBe(true);
    for (const company_contact of [
      null,
      { phone: "+14035550100", email: "office@example.com" },
      { phone: null, email: "office@example.com" },
      { phone: "+14035550100", email: null },
      // The Worker accepts this address, so the page must too.
      { phone: null, email: "first..last@example.co" },
    ]) {
      expect(customerPortalResponseSchema.safeParse({ ...base, company_contact }).success).toBe(
        true,
      );
    }
  });

  it("refuses a contact that is not a dialable number, an email or the agreed shape", () => {
    for (const company_contact of [
      { phone: "403-555-0100", email: null },
      { phone: null, email: "not-an-email" },
      { phone: null, email: null, staff_name: "Pat" },
      { phone: "+14035550100" },
    ]) {
      expect(customerPortalResponseSchema.safeParse({ ...base, company_contact }).success).toBe(
        false,
      );
    }
  });
});
