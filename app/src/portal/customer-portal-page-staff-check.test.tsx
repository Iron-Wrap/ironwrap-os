import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearPendingMagicLinkToken } from "../auth/magic-link-fragment";
import { officeSessionIsLive } from "../auth/session";
import { CustomerPortalPage } from "./customer-portal-page";

// The staff check is replaced here so it can hang or fail; the page must load either way.
vi.mock("../auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/session")>()),
  officeSessionIsLive: vi.fn(),
}));

const portal = {
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

async function openPortal(): Promise<{ elapsedMs: number; body: unknown }> {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(portal));
  vi.stubGlobal("fetch", fetcher);
  clearPendingMagicLinkToken();
  window.history.replaceState(null, "", `/portal#token=${"s".repeat(43)}`);
  const started = performance.now();
  render(<CustomerPortalPage />);
  expect(await screen.findByText(/IW-100/)).toBeVisible();
  const elapsedMs = performance.now() - started;
  expect(fetcher).toHaveBeenCalledTimes(1);
  return { elapsedMs, body: JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) };
}

describe("CustomerPortalPage staff check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(officeSessionIsLive).mockReset();
    clearPendingMagicLinkToken();
    window.history.replaceState(null, "", "/");
  });

  it("loads within about 1 s, without the flag, when the check never answers", async () => {
    vi.mocked(officeSessionIsLive).mockImplementation(
      (() => new Promise<boolean>(() => {})) as unknown as typeof officeSessionIsLive,
    );
    const { elapsedMs, body } = await openPortal();
    expect(body).toEqual({ token: "s".repeat(43) });
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("loads without the flag when the check throws", async () => {
    vi.mocked(officeSessionIsLive).mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const { body } = await openPortal();
    expect(body).toEqual({ token: "s".repeat(43) });
  });

  it("sends the flag when the check finds a live office sign-in", async () => {
    vi.mocked(officeSessionIsLive).mockReturnValue(true);
    const { body } = await openPortal();
    expect(body).toEqual({ token: "s".repeat(43), staff_preview: true });
  });
});
