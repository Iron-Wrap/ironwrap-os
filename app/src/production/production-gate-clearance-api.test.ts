import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import {
  clearProductionGate,
  newProductionGateClearanceKey,
} from "./production-gate-clearance-api";
import { productionGateClearanceResponseSchema } from "./production-gate-clearance-contracts";

const session = { csrf_token: "csrf-token" } as AuthenticatedSession;

function fetcher(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("clearProductionGate", () => {
  it("addresses the gate through its own job and carries the office CSRF and idempotency key", async () => {
    const fetch = fetcher({
      gate: { state: "Waived" },
      basis: "office_waiver",
      clearance: "waived",
      evidence_item: null,
      actor_role: "IronWrap Production",
      replayed: false,
    });

    const result = await clearProductionGate(
      session,
      {
        roofJobId: "job:elec122",
        gate: "Weather",
        basis: "office_waiver",
        reason: "Dry three-day window confirmed for Monday.",
      },
      "production-gate-clearance:key-0001",
      fetch as unknown as typeof globalThis.fetch,
    );

    expect(result.clearance).toBe("waived");
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/v1/production/jobs/job%3Aelec122/gates/Weather/clearance");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "production-gate-clearance:key-0001",
    );
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-token");
    expect(JSON.parse(String(init.body))).toEqual({
      basis: "office_waiver",
      reason: "Dry three-day window confirmed for Monday.",
    });
  });

  it("sends no prose at all with a settlement clearance", async () => {
    const fetch = fetcher({
      gate: { state: "Ready" },
      basis: "deposit_settlement",
      clearance: "verified",
      evidence_item: "gate-clearance:key-0002",
      actor_role: "IronWrap Owner",
      replayed: false,
    });

    await clearProductionGate(
      session,
      { roofJobId: "job:elec122", gate: "Deposit", basis: "deposit_settlement" },
      "production-gate-clearance:key-0002",
      fetch as unknown as typeof globalThis.fetch,
    );

    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ basis: "deposit_settlement" });
  });

  it("refuses a response that does not say what kind of clearance it was", () => {
    expect(() =>
      productionGateClearanceResponseSchema.parse({
        gate: { state: "Waived" },
        basis: "office_waiver",
        evidence_item: null,
        actor_role: null,
        replayed: false,
      }),
    ).toThrow();
  });

  it("mints a fresh idempotency key per clearance", () => {
    expect(newProductionGateClearanceKey()).not.toBe(newProductionGateClearanceKey());
    expect(newProductionGateClearanceKey()).toMatch(/^production-gate-clearance:/);
  });
});
