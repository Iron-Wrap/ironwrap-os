import { describe, expect, it, vi } from "vitest";

import {
  confirmCustomerContractAcceptance,
  loadCustomerPortal,
  portalStaffPreview,
  recordCustomerPortalDecision,
  requestCustomerContractAcceptanceChallenge,
} from "./portal-api";

const portal = {
  version: 1,
  brand: "IronWrap Exteriors",
  contract_acceptance_available: false,
  material_decision_available: false,
  source_updated_at: "2026-07-16T10:00:00.000Z",
  read_model_generated_at: "2026-07-16T10:01:00.000Z",
  job: { job_number: "IW-100", service_type: "Roofing", status: "In Production" },
  proposal: null,
  scope: [],
  option_packages: [],
  progress: [],
  closeout: null,
  warranty: null,
};

describe("customer portal API", () => {
  it("uses one fixed path with omitted credentials and no-store caching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(portal));

    const result = await loadCustomerPortal("a".repeat(43), fetcher);

    expect(result.job.job_number).toBe("IW-100");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/customer-portal/resolve",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({ token: "a".repeat(43) }),
      }),
    );
  });

  it("adds staff_preview: true only when an office sign-in is live, and still omits credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(portal));

    await loadCustomerPortal("a".repeat(43), fetcher, true);
    await loadCustomerPortal("a".repeat(43), fetcher, false);

    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { token: "a".repeat(43), staff_preview: true },
      { token: "a".repeat(43) },
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init?.credentials).toBe("omit");
  });

  it("keeps both acceptance steps on fixed public paths with omitted credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "challenge_sent", expires_at: "2026-08-01T10:15:00.000Z" }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "accepted", acceptance_id: "acceptance-0001" }),
      );

    await requestCustomerContractAcceptanceChallenge("b".repeat(43), fetcher);
    await confirmCustomerContractAcceptance(
      {
        token: "c".repeat(43),
        signerName: "Customer Example",
        idempotencyKey: "acceptance-key-0001",
      },
      fetcher,
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/customer-portal/acceptance/challenge");
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({ token: "b".repeat(43) }),
      }),
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/customer-portal/acceptance/confirm");
    const headers = new Headers(fetcher.mock.calls[1]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("acceptance-key-0001");
    expect(fetcher.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({
          token: "c".repeat(43),
          signer_name: "Customer Example",
          accepted: true,
        }),
      }),
    );
  });

  it("records a material decision on its own fixed path with an idempotency key", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "recorded", decision_id: "decision_abc12345" }));

    const result = await recordCustomerPortalDecision(
      {
        token: "d".repeat(43),
        optionPackageId: "OPT-BETTER",
        idempotencyKey: "portal-decision:OPT-BETTER:0001",
      },
      fetcher,
    );

    expect(result).toEqual({ status: "recorded", decision_id: "decision_abc12345" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/customer-portal/decision");
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Idempotency-Key")).toBe("portal-decision:OPT-BETTER:0001");
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        // The decision route is a customer capability, never an office session.
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify({ token: "d".repeat(43), option_package_id: "OPT-BETTER" }),
      }),
    );
  });
});

describe("portalStaffPreview", () => {
  it("answers false after 1 s when the check never settles", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const answer = portalStaffPreview(() => new Promise<boolean>(() => {})).then((value) => {
        settled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(answer).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers false when the check throws or rejects, and true only for a live sign-in", async () => {
    await expect(
      portalStaffPreview(() => {
        throw new Error("storage disabled");
      }),
    ).resolves.toBe(false);
    await expect(portalStaffPreview(() => Promise.reject(new Error("broken")))).resolves.toBe(false);
    await expect(portalStaffPreview(() => false)).resolves.toBe(false);
    await expect(portalStaffPreview(() => true)).resolves.toBe(true);
  });
});
