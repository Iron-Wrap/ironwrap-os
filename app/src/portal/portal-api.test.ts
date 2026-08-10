import { describe, expect, it, vi } from "vitest";

import {
  confirmCustomerContractAcceptance,
  loadCustomerPortal,
  requestCustomerContractAcceptanceChallenge,
} from "./portal-api";

const portal = {
  version: 1,
  brand: "IronWrap Exteriors",
  contract_acceptance_available: false,
  source_updated_at: "2026-07-16T10:00:00.000Z",
  read_model_generated_at: "2026-07-16T10:01:00.000Z",
  job: { job_number: "IW-100", service_type: "Roofing", status: "In Production" },
  proposal: null,
  scope: [],
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
});
