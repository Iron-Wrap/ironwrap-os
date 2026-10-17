// @vitest-environment node

import { describe, expect, it } from "vitest";

import { classifyOutboxFailure, outboxFailureGuidance } from "./outbox-failure";
import type { OutboxAction } from "./outbox-types";

function checkIn(
  lastError: OutboxAction["lastError"],
  conflict?: OutboxAction["conflict"],
): Pick<OutboxAction, "kind" | "lastError" | "conflict"> {
  return { kind: "field_checkin", lastError, ...(conflict ? { conflict } : {}) };
}

describe("outbox failure classification", () => {
  it("keeps transient answers and transport failures retryable", () => {
    expect(classifyOutboxFailure({ status: 503, code: "busy" })).toBe("retryable");
    expect(classifyOutboxFailure({ status: 502, code: "field_action_failed" })).toBe("retryable");
    expect(classifyOutboxFailure({ status: 429 })).toBe("retryable");
    expect(classifyOutboxFailure({ status: 408 })).toBe("retryable");
    expect(classifyOutboxFailure({})).toBe("retryable");
  });

  it("treats a refusal this device cannot satisfy as terminal", () => {
    expect(classifyOutboxFailure({ status: 422, code: "field_action_invalid_metadata" })).toBe(
      "terminal",
    );
    expect(classifyOutboxFailure({ status: 403, code: "forbidden" })).toBe("terminal");
  });

  /**
   * The defect this exists to close: a constraint violation the Worker still wraps in a 502 is
   * not retryable however friendly the status looks, and a client that trusts status alone
   * replays it for ever behind a "Waiting" label.
   */
  it("lets a terminal code override a retryable status", () => {
    expect(
      classifyOutboxFailure({ status: 502, code: "field_action_work_package_binding_invalid" }),
    ).toBe("terminal");
    expect(
      classifyOutboxFailure({ status: 500, code: "field_action_evidence_requires_work_package" }),
    ).toBe("terminal");
  });

  it("separates a conflict from both", () => {
    expect(classifyOutboxFailure({ status: 409, code: "assignment_changed" })).toBe("conflict");
    expect(classifyOutboxFailure({ status: 412, code: "version_changed" })).toBe("conflict");
  });
});

describe("crew guidance for a stopped item", () => {
  it("names the missing work plan and a next step the crew member can take", () => {
    const guidance = outboxFailureGuidance(
      checkIn({
        code: "field_action_evidence_requires_work_package",
        message: "Evidence requires a released work package.",
        status: 422,
        occurredAt: 1_000,
      }),
    );

    expect(guidance).toEqual({
      reason: "Production has not issued a work plan for this job, so files cannot be filed to it.",
      nextStep:
        "Your files stay on this phone. Ask production to issue the work plan, then add them again. You can send a note-only blocker report now.",
      retryable: false,
      notSent: true,
    });
  });

  it("says the office refused an unknown terminal refusal, never in the server's own words", () => {
    expect(
      outboxFailureGuidance(
        checkIn({
          code: "field_action_invalid_metadata",
          message: "Work Package acknowledgement payload is invalid.",
          status: 400,
          occurredAt: 1_000,
        }),
      ),
    ).toEqual({
      reason: "The office refused this saved item.",
      nextStep:
        "Sending it again will not change the answer. Keep it on this phone and tell the office.",
      retryable: false,
      notSent: true,
    });
  });

  it("never says not sent, nor offers a resend, when the office answered with something else", () => {
    // A 2xx whose body did not verify: the office may already have recorded the item.
    expect(classifyOutboxFailure({ status: 201, code: "verification_mismatch" })).toBe("terminal");
    expect(
      outboxFailureGuidance(
        checkIn({
          code: "verification_mismatch",
          message: "The server answered, but did not verify this exact saved item.",
          status: 201,
          occurredAt: 1_000,
        }),
      ),
    ).toEqual({
      reason:
        "The office answered, but this phone could not confirm the office has this exact item.",
      nextStep:
        "Do not save it again. Call the office and ask whether it arrived. It stays on this phone.",
      retryable: false,
      notSent: false,
    });
  });

  it("stops a collision whose stored record the office cannot read, without saying not sent", () => {
    const stopped = {
      kind: "fleet_collision_report" as const,
      lastError: {
        code: "fleet_collision_storage_mismatch",
        message: "A stored collision could not be read safely.",
        status: 502,
        occurredAt: 1_000,
      },
    };
    expect(classifyOutboxFailure({ status: 502, code: "fleet_collision_storage_mismatch" })).toBe(
      "terminal",
    );
    expect(outboxFailureGuidance(stopped)).toMatchObject({ retryable: false, notSent: false });
  });

  it("still promises a retry for a transient answer", () => {
    expect(
      outboxFailureGuidance(
        checkIn({ code: "http_503", message: "Busy.", status: 503, occurredAt: 1_000 }),
      ),
    ).toMatchObject({
      reason: "The server could not take this item yet.",
      retryable: true,
      notSent: false,
    });
  });

  it("routes a preserved conflict to the office rather than to a retry", () => {
    expect(
      outboxFailureGuidance(
        checkIn(
          {
            code: "assignment_changed",
            message: "The office assignment changed.",
            status: 409,
            occurredAt: 1_000,
          },
          {
            status: 409,
            code: "assignment_changed",
            message: "The office assignment changed.",
            detectedAt: 1_000,
          },
        ),
      ),
    ).toMatchObject({
      reason: "The office copy changed after this item was saved.",
      retryable: false,
      notSent: false,
    });
  });
});
