import { describe, expect, it, vi } from "vitest";

import { sessionFor } from "./admin-test-harness";
import { removeCompanyLogo, saveCompanyProfile, uploadCompanyLogo } from "./admin-api";

const PROFILE = {
  tenant_id: "freshco",
  profile_version: 1,
  is_default: false,
  company_name: "FreshCo Exteriors",
  brand_name: "FreshCo",
  service_area: "Edmonton roofing",
  phone: "+1 780 555 0100",
  email: "hello@freshco.example",
  website: "https://freshco.example",
  address_line1: "12 Shop Road",
  address_line2: "",
  city: "Edmonton",
  region: "AB",
  postal_code: "T5J 0N3",
  country: "Canada",
  brand_labels: {},
  time_zone: "America/Edmonton",
  currency: "CAD",
  week_start: "monday" as const,
  logo_ref: null,
  logo: null,
  updated_at: "2026-08-24T12:00:00.000Z",
  updated_by: "owner@freshco.example",
  updated_by_user_id: "appu_owner",
};

function response(): Response {
  return Response.json({
    version: 1,
    read_model_generated_at: "2026-08-24T12:00:00.000Z",
    allowed_actions: ["company_profile.read", "company_profile.update"],
    profile: PROFILE,
    defaults: { ...PROFILE, profile_version: 0, is_default: true, updated_at: null },
    missing_fields: [],
    week_starts: ["sunday", "monday", "saturday"],
    logo_url: null,
    logo_limits: {
      max_bytes: 524288,
      content_types: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
    },
    public_brands: [],
  });
}

describe("company profile mutation transport", () => {
  it("binds every mutation to the read version and one idempotency key", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ path: String(input), init });
      return response();
    }) as typeof fetch;
    const session = sessionFor("owner");
    const input = {
      company_name: PROFILE.company_name,
      brand_name: PROFILE.brand_name,
      service_area: PROFILE.service_area,
      phone: PROFILE.phone,
      email: PROFILE.email,
      website: PROFILE.website,
      address_line1: PROFILE.address_line1,
      address_line2: PROFILE.address_line2,
      city: PROFILE.city,
      region: PROFILE.region,
      postal_code: PROFILE.postal_code,
      country: PROFILE.country,
      brand_labels: PROFILE.brand_labels,
      time_zone: PROFILE.time_zone,
      currency: PROFILE.currency,
      week_start: PROFILE.week_start,
    };

    await saveCompanyProfile(session, input, 7, fetcher);
    await uploadCompanyLogo(
      session,
      { contentType: "image/png", dataBase64: "iVBORw0KGgo=" },
      8,
      fetcher,
    );
    await removeCompanyLogo(session, 9, fetcher);

    expect(requests.map(({ path }) => path)).toEqual([
      "/api/v1/admin/company-profile",
      "/api/v1/admin/company-profile/logo",
      "/api/v1/admin/company-profile/logo",
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["PUT", "PUT", "DELETE"]);
    expect(requests.map(({ init }) => (init?.headers as Headers).get("idempotency-key"))).toEqual([
      expect.any(String),
      expect.any(String),
      expect.any(String),
    ]);
    expect(
      requests.map(({ init }) => JSON.parse(String(init?.body)).expected_profile_version),
    ).toEqual([7, 8, 9]);
  });
});
