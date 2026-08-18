import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../auth/session-context";
import type { AuthenticatedSession } from "../auth/session";
import { DevicePairingSettings } from "./device-pairing-settings";
import {
  issueDevicePairing,
  issueHermesDesktopPairing,
  listDevicePairings,
  listFieldUsers,
} from "./pairing-api";

vi.mock("./pairing-api", () => ({
  issueDevicePairing: vi.fn(),
  issueHermesDesktopPairing: vi.fn(),
  listDevicePairings: vi.fn(),
  listFieldUsers: vi.fn(),
  revokeDevicePairing: vi.fn(),
}));

const pairingToken = "a".repeat(43);
const ownerSession: AuthenticatedSession = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@example.test",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap Exteriors",
    brand: "IronWrap Exteriors",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: [],
  allowed_actions: [],
  csrf_token: "csrf",
  session_expires_at: "2026-07-11T12:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2026-07-10T12:00:00.000Z",
  stale_fields: [],
};

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider session={ownerSession}>
        <DevicePairingSettings />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe("DevicePairingSettings", () => {
  beforeEach(() => {
    vi.mocked(listFieldUsers).mockResolvedValue({
      users: [
        {
          id: "appu_crew",
          display_name: "Crew One",
          email: "crew@ironwrapexteriors.com",
          frappe_user_id: "crew@example.test",
        },
      ],
    });
    vi.mocked(listDevicePairings).mockResolvedValue({
      devices: [
        {
          id: "appd_crew_phone",
          field_user_id: "appu_crew",
          field_user_name: "Crew One",
          paired_at: "2026-07-10T12:00:00.000Z",
          last_seen_at: null,
          revoked_at: null,
          revoked_by: null,
        },
      ],
    });
    vi.mocked(issueDevicePairing).mockResolvedValue({
      pairing_url: `${window.location.origin}/auth/pair#token=${pairingToken}`,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      field_user: { id: "appu_crew", display_name: "Crew One" },
    });
    vi.mocked(issueHermesDesktopPairing).mockResolvedValue({
      pairing_url: `${window.location.origin}/auth/hermes-pair#token=${pairingToken}`,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      api_audience: window.location.origin,
      bound_issuer: window.location.origin,
      bootstrap_prompt: `Bind every request to ${window.location.origin}. Pair with token ${pairingToken}.`,
    });
  });

  it("issues a one-time QR flow with a fragment-only no-camera fallback and explicit revoke confirmation", async () => {
    const user = userEvent.setup();
    renderSettings();

    await screen.findByRole("button", { name: "Issue one-time QR code" });
    await user.click(screen.getByRole("button", { name: "Issue one-time QR code" }));

    expect(
      await screen.findByRole("img", { name: "One-time crew device pairing QR code" }),
    ).toBeVisible();
    const fallback = screen.getByLabelText(/No camera\? Copy or open this one-time link/i);
    expect(fallback).toHaveValue(`${window.location.origin}/auth/pair#token=${pairingToken}`);
    expect(String((fallback as HTMLInputElement).value)).not.toContain("?");

    await user.click(screen.getByRole("button", { name: "Revoke lost device" }));
    expect(screen.getByText("Revoke this device now?")).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm revoke" })).toBeVisible();
  });

  it("issues a separate fragment-only Hermes desktop pairing link", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByRole("button", { name: "Issue desktop pairing link" }));
    expect(issueHermesDesktopPairing).toHaveBeenCalledWith(ownerSession);
    const link = await screen.findByLabelText("One-time Hermes desktop pairing link");
    expect(link).toHaveValue(`${window.location.origin}/auth/hermes-pair#token=${pairingToken}`);
    expect(String((link as HTMLInputElement).value)).not.toContain("?");
    expect(
      (screen.getByLabelText("Self-configuring Hermes bootstrap prompt") as HTMLTextAreaElement)
        .value,
    ).toContain(window.location.origin);
    expect(screen.getByText(/Bound API audience:/)).toHaveTextContent(window.location.origin);
  });
});
