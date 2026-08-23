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
  return {
    version: 1 as const,
    profile: {
      tenant_id: "freshco",
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
      logo: null,
      updated_at: null,
      updated_by: null,
      ...(profileOverrides as Record<string, unknown> | undefined),
    },
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
          profile: { ...input, updated_at: "2026-08-22T12:00:00.000Z" },
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
    const logo = await screen.findByAltText("FreshCo Exteriors logo");
    expect(logo).toHaveAttribute("src", "/public/company-logo?v=abc");

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeCompanyLogo).toHaveBeenCalledOnce());
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
