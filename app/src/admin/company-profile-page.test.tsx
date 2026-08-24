import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import { LinkStub } from "./admin-link-stub";
import { renderWithSession, sessionFor } from "./admin-test-harness";
import {
  loadCompanyProfile,
  removeCompanyLogo,
  saveCompanyProfile,
  uploadCompanyLogo,
} from "./admin-api";
import { CompanyProfilePage } from "./company-profile-page";

vi.mock("./admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./admin-api")>()),
  loadCompanyProfile: vi.fn(),
  saveCompanyProfile: vi.fn(),
  uploadCompanyLogo: vi.fn(),
  removeCompanyLogo: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ Link: LinkStub }));

function profileResponse(overrides: Record<string, unknown> = {}) {
  const { profile: profileOverrides, ...rest } = overrides;
  const profile = {
    tenant_id: "freshco",
    profile_version: 0,
    is_default: true,
    company_name: "FreshCo Exteriors",
    brand_name: "FreshCo",
    service_area: "",
    phone: "",
    email: "",
    website: "",
    address_line1: "",
    address_line2: "",
    city: "",
    region: "",
    postal_code: "",
    country: "",
    brand_labels: {},
    time_zone: "America/Edmonton",
    currency: "CAD",
    week_start: "monday" as const,
    logo_ref: null,
    logo: null,
    updated_at: null,
    updated_by: null,
    updated_by_user_id: null,
    ...(profileOverrides as Record<string, unknown> | undefined),
  };
  return {
    version: 1 as const,
    read_model_generated_at: "2026-08-24T12:00:00.000Z",
    allowed_actions: ["company_profile.read", "company_profile.update"],
    profile,
    defaults: { ...profile },
    missing_fields: [],
    week_starts: ["sunday", "monday", "saturday"] as const,
    logo_url: null,
    logo_limits: {
      max_bytes: 524288,
      content_types: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
    },
    public_brands: [
      {
        id: "freshco",
        display_name: "FreshCo Exteriors",
        short_name: "FreshCo",
        service_area: "",
      },
    ],
    ...rest,
  };
}

describe("CompanyProfilePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets an owner enter their company details and save them", async () => {
    vi.mocked(loadCompanyProfile).mockResolvedValue(profileResponse() as never);
    // The real route answers with what it stored, which is what turns the save into "saved".
    vi.mocked(saveCompanyProfile).mockImplementation(
      async (_session, input) =>
        profileResponse({
          profile: {
            ...input,
            profile_version: 1,
            is_default: false,
            updated_at: "2026-08-22T12:00:00.000Z",
          },
        }) as never,
    );
    const user = userEvent.setup();
    renderWithSession(<CompanyProfilePage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "Company details" });
    // Saving is off until something actually changed, so an accidental tap cannot overwrite.
    expect(screen.getByRole("button", { name: "Save company details" })).toBeDisabled();

    await user.clear(screen.getByLabelText(/^Company name/));
    await user.type(screen.getByLabelText(/^Company name/), "FreshCo Exteriors Ltd.");
    await user.type(screen.getByLabelText("City"), "Edmonton");
    await user.click(screen.getByRole("button", { name: "Save company details" }));

    await waitFor(() => expect(saveCompanyProfile).toHaveBeenCalledOnce());
    expect(vi.mocked(saveCompanyProfile).mock.calls[0]![1]).toMatchObject({
      company_name: "FreshCo Exteriors Ltd.",
      brand_name: "FreshCo",
      city: "Edmonton",
    });
    expect(vi.mocked(saveCompanyProfile).mock.calls[0]![2]).toBe(0);
    expect(await screen.findByText("Company details saved")).toBeInTheDocument();
  });

  it("says what went wrong in words the reader can act on", async () => {
    vi.mocked(loadCompanyProfile).mockResolvedValue(profileResponse() as never);
    vi.mocked(saveCompanyProfile).mockRejectedValue(
      new ApiError({ status: 400, code: "invalid_website", message: "invalid_website" }),
    );
    const user = userEvent.setup();
    renderWithSession(<CompanyProfilePage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "Company details" });
    await user.type(screen.getByLabelText("Website"), "freshco.example");
    await user.click(screen.getByRole("button", { name: "Save company details" }));

    expect(
      await screen.findByText("Enter the website as a full address, starting with https://."),
    ).toBeInTheDocument();
  });

  it("uploads a logo, shows it, and can take it away again", async () => {
    vi.mocked(loadCompanyProfile).mockResolvedValue(profileResponse() as never);
    vi.mocked(uploadCompanyLogo).mockResolvedValue(
      profileResponse({ logo_url: "/public/company-logo?v=abc" }) as never,
    );
    vi.mocked(removeCompanyLogo).mockResolvedValue(profileResponse() as never);
    const user = userEvent.setup();
    renderWithSession(<CompanyProfilePage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "Company details" });
    await user.upload(
      screen.getByLabelText("Choose a logo file"),
      new File(["PNG"], "logo.png", { type: "image/png" }),
    );

    await waitFor(() => expect(uploadCompanyLogo).toHaveBeenCalledOnce());
    expect(vi.mocked(uploadCompanyLogo).mock.calls[0]![1]!.contentType).toBe("image/png");
    expect(vi.mocked(uploadCompanyLogo).mock.calls[0]![2]).toBe(0);
    const logo = await screen.findByAltText("FreshCo Exteriors logo");
    expect(logo).toHaveAttribute("src", "/public/company-logo?v=abc");

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeCompanyLogo).toHaveBeenCalledOnce());
    expect(vi.mocked(removeCompanyLogo).mock.calls[0]![1]).toBe(0);
  });

  it("keeps a rejected logo out of the way of the rest of the form", async () => {
    vi.mocked(loadCompanyProfile).mockResolvedValue(profileResponse() as never);
    vi.mocked(uploadCompanyLogo).mockRejectedValue(
      new ApiError({ status: 400, code: "logo_too_large", message: "logo_too_large" }),
    );
    const user = userEvent.setup();
    renderWithSession(<CompanyProfilePage />, sessionFor("owner"));

    await screen.findByRole("heading", { name: "Company details" });
    await user.upload(
      screen.getByLabelText("Choose a logo file"),
      new File(["x".repeat(64)], "logo.png", { type: "image/png" }),
    );

    expect(
      await screen.findByText("That file is too large. Use a logo under 512 KB."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save company details" })).toBeInTheDocument();
  });

  it("never sends a role that has no business here to the Frappe desk or to a raw error", async () => {
    renderWithSession(<CompanyProfilePage />, sessionFor("field"));
    expect(
      await screen.findByRole("heading", { name: "This work belongs to another role" }),
    ).toBeInTheDocument();
    expect(loadCompanyProfile).not.toHaveBeenCalled();
  });
});
