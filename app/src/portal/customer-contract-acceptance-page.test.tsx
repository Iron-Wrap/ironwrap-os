import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CustomerContractAcceptancePage } from "./customer-contract-acceptance-page";
import { confirmCustomerContractAcceptance } from "./portal-api";
import { clearPendingMagicLinkToken } from "../auth/magic-link-fragment";

vi.mock("./portal-api", () => ({ confirmCustomerContractAcceptance: vi.fn() }));

const confirmAcceptance = vi.mocked(confirmCustomerContractAcceptance);
const emailToken = "c".repeat(43);

describe("CustomerContractAcceptancePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPendingMagicLinkToken();
    window.history.replaceState(null, "", `/contract-accept#token=${emailToken}`);
  });

  it("scrubs an email token and records an attested confirmation", async () => {
    confirmAcceptance.mockResolvedValue({ status: "accepted", acceptance_id: "acceptance-0001" });

    render(<CustomerContractAcceptancePage />);

    expect(window.location.hash).toBe("");
    fireEvent.change(screen.getByLabelText(/your full name/i), {
      target: { value: "Customer Example" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /confirm acceptance/i }));

    expect(await screen.findByText(/your acceptance was recorded/i)).toBeInTheDocument();
    expect(confirmAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ token: emailToken, signerName: "Customer Example" }),
    );
  });
});
