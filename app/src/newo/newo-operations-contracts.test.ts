import { describe, expect, it } from "vitest";

import { newoOperationsResponseSchema } from "./newo-operations-contracts";
import { newoOperationsFixture } from "./newo-operations-test-fixture";

describe("Newo operations browser contract", () => {
  it("accepts the bounded exception-first projection", () => {
    expect(newoOperationsResponseSchema.safeParse(newoOperationsFixture()).success).toBe(true);
  });

  it("rejects caller, transcript, recording, and raw-storage fields", () => {
    const widened = newoOperationsFixture();
    widened.recent_sessions[0] = {
      ...widened.recent_sessions[0],
      contact_phone: "+15875550101",
      transcript_ref: "transcript://private",
      recording_ref: "recording://private",
      raw_key: "raw/newo/private.json",
    } as never;

    expect(newoOperationsResponseSchema.safeParse(widened).success).toBe(false);
  });

  it("rejects caller identity or content on an open callback", () => {
    const widened = newoOperationsFixture();
    widened.exceptions.open_callbacks[0] = {
      ...widened.exceptions.open_callbacks[0],
      contact_phone: "+15875550101",
      reason: "Caller asked for a person.",
    } as never;

    expect(newoOperationsResponseSchema.safeParse(widened).success).toBe(false);
  });

  it("rejects control evidence and reconciliation detail widening", () => {
    const widened = newoOperationsFixture();
    widened.exceptions.control_failures[0] = {
      ...widened.exceptions.control_failures[0],
      args_json: "{}",
      approval_receipt_hash: "secret",
    } as never;
    widened.reconciliation.daily = {
      ...widened.reconciliation.daily!,
      detail_json: "{}",
    } as never;

    expect(newoOperationsResponseSchema.safeParse(widened).success).toBe(false);
  });

  it("requires the complete readiness check set in stable order", () => {
    const reordered = newoOperationsFixture();
    reordered.readiness.checks = [...reordered.readiness.checks].reverse();

    expect(newoOperationsResponseSchema.safeParse(reordered).success).toBe(false);
  });
});
