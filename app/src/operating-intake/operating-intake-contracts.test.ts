import { describe, expect, it } from "vitest";

import { operatingIntakeResponseSchema } from "./operating-intake-contracts";
import { operatingIntakePayload } from "./operating-intake-fixture";

describe("Operating intake browser contract", () => {
  it("accepts a D1 website intake DTO and nothing else", () => {
    const payload = operatingIntakePayload();
    expect(operatingIntakeResponseSchema.parse(payload)).toEqual(payload);
  });

  it("fails closed if Frappe is claimed as operating authority", () => {
    expect(
      operatingIntakeResponseSchema.safeParse({
        ...operatingIntakePayload(),
        operating_authority: "frappe",
      }).success,
    ).toBe(false);
  });

  it("fails closed if a lead is dressed as a scheduled job", () => {
    const payload = operatingIntakePayload();
    const lead = payload.leads[0]!;
    expect(
      operatingIntakeResponseSchema.safeParse({
        ...payload,
        leads: [{ ...lead, desk_state: "scheduled" }],
      }).success,
    ).toBe(false);
    expect(
      operatingIntakeResponseSchema.safeParse({
        ...payload,
        leads: [{ ...lead, job_id: "JOB-A" }],
      }).success,
    ).toBe(false);
    expect(
      operatingIntakeResponseSchema.safeParse({
        ...payload,
        leads: [{ ...lead, not_a_scheduled_job: false }],
      }).success,
    ).toBe(false);
    expect(
      operatingIntakeResponseSchema.safeParse({
        ...payload,
        leads: [{ ...lead, not_a_money_intent: false }],
      }).success,
    ).toBe(false);
  });

  it("fails closed if the envelope identity is not a website envelope id", () => {
    const payload = operatingIntakePayload();
    const lead = payload.leads[0]!;
    expect(
      operatingIntakeResponseSchema.safeParse({
        ...payload,
        leads: [{ ...lead, envelope_id: "LEAD-A" }],
      }).success,
    ).toBe(false);
  });
});
