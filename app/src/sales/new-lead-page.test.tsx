import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LinkStub } from "../admin/admin-link-stub";
import { renderWithSession, sessionFor } from "../admin/admin-test-harness";
import { ApiError } from "../lib/api";
import { createLead } from "./sales-api";
import { NewLeadPage } from "./new-lead-page";

const navigate = vi.fn();

vi.mock("./sales-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sales-api")>()),
  createLead: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: LinkStub,
  useNavigate: () => navigate,
}));

function accepted(overrides: Partial<{ duplicate: boolean }> = {}) {
  return {
    version: 1 as const,
    lead: {
      envelope_id: "ow_11111111-1111-4111-8111-111111111111",
      canonical_envelope_id: "ow_11111111-1111-4111-8111-111111111111",
      tenant_id: "freshco",
      status: "pending_jn_push",
      duplicate: overrides.duplicate ?? false,
      queue: "residential_sales",
    },
  };
}

describe("NewLeadPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("takes a lead a salesperson was told about over the phone", async () => {
    vi.mocked(createLead).mockResolvedValue(accepted());
    const user = userEvent.setup();
    renderWithSession(
      <NewLeadPage />,
      sessionFor("sales", { allowed_actions: ["sales.lead.create"] }),
    );

    await screen.findByRole("heading", { name: "Add a lead" });
    expect(screen.getByRole("button", { name: "Add the lead" })).toBeDisabled();

    await user.type(screen.getByLabelText(/^Full name/), "Grace Green");
    await user.type(screen.getByLabelText("Phone"), "403-555-0117");
    await user.type(screen.getByLabelText("What they need"), "Cedar shake restoration");
    await user.type(screen.getByLabelText("City"), "Edmonton");
    await user.click(screen.getByRole("button", { name: "Add the lead" }));

    await waitFor(() => expect(createLead).toHaveBeenCalledOnce());
    expect(vi.mocked(createLead).mock.calls[0]![1]).toMatchObject({
      name: "Grace Green",
      phone: "403-555-0117",
      // A service nobody configured in advance is kept exactly as typed.
      service: "Cedar shake restoration",
      city: "Edmonton",
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/sales" }));
  });

  it("will not send a lead nobody could call back", async () => {
    const user = userEvent.setup();
    renderWithSession(
      <NewLeadPage />,
      sessionFor("sales", { allowed_actions: ["sales.lead.create"] }),
    );

    await screen.findByRole("heading", { name: "Add a lead" });
    await user.type(screen.getByLabelText(/^Full name/), "Grace Green");

    expect(screen.getByRole("button", { name: "Add the lead" })).toBeDisabled();
    expect(screen.getByText("Add a way to reach them")).toBeInTheDocument();
    expect(createLead).not.toHaveBeenCalled();
  });

  it("says plainly when the same person is already on the desk, and does not navigate away", async () => {
    vi.mocked(createLead).mockResolvedValue(accepted({ duplicate: true }));
    const user = userEvent.setup();
    renderWithSession(
      <NewLeadPage />,
      sessionFor("sales", { allowed_actions: ["sales.lead.create"] }),
    );

    await screen.findByRole("heading", { name: "Add a lead" });
    await user.type(screen.getByLabelText(/^Full name/), "Grace Green");
    await user.type(screen.getByLabelText("Email"), "grace@example.com");
    await user.click(screen.getByRole("button", { name: "Add the lead" }));

    expect(await screen.findByText("This person is already on the sales desk")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("turns a server refusal into something the reader can act on", async () => {
    vi.mocked(createLead).mockRejectedValue(
      new ApiError({ status: 400, code: "contact_required", message: "contact_required" }),
    );
    const user = userEvent.setup();
    renderWithSession(
      <NewLeadPage />,
      sessionFor("sales", { allowed_actions: ["sales.lead.create"] }),
    );

    await screen.findByRole("heading", { name: "Add a lead" });
    await user.type(screen.getByLabelText(/^Full name/), "Grace Green");
    await user.type(screen.getByLabelText("Email"), "grace@example.com");
    await user.click(screen.getByRole("button", { name: "Add the lead" }));

    expect(
      await screen.findByText(
        "Enter an email address or a phone number so someone can reach them.",
      ),
    ).toBeInTheDocument();
  });

  it("is closed to a crew account", async () => {
    renderWithSession(<NewLeadPage />, sessionFor("field"));
    expect(
      await screen.findByRole("heading", { name: "This work belongs to another role" }),
    ).toBeInTheDocument();
  });
});
