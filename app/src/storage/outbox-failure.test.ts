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
  it.each([
    ["upload_too_slow", undefined, false],
    ["evidence_actor_role_changed", 403, true],
    ["evidence_actor_inactive", 403, true],
    ["evidence_receipt_scope_mismatch", 400, true],
  ] as const)("keeps the send outcome explicit for %s", (code, status, notSent) => {
    const guidance = outboxFailureGuidance(
      checkIn({ code, message: code, occurredAt: 1_000, ...(status ? { status } : {}) }),
    );
    expect(guidance.notSent).toBe(notSent);
  });

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
      officeConfirmed: false,
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
      officeConfirmed: false,
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
      officeConfirmed: false,
    });
  });

  it("says exactly that the office confirmed it has this once a person there checked the item", () => {
    const guidance = outboxFailureGuidance({
      kind: "fleet_pre_trip_inspection",
      verification: {
        verifiedAt: 2_000,
        serverRef: "device-fleet-0001",
        cursor: `fir_${"1".repeat(64)}`,
        officeResolution: {
          resolutionId: `fir_${"1".repeat(64)}`,
          resolution: "arrived",
          linkedRecord: { type: "fleet_asset_action", id: "device-fleet-0001" },
        },
      },
    });
    expect(guidance.reason).toBe("The office confirmed it has this.");
    expect(guidance).toMatchObject({ retryable: false, notSent: false, officeConfirmed: true });
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
      officeConfirmed: false,
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
      officeConfirmed: false,
    });
  });
});

describe("what a saved item says when the Worker refuses its files", () => {
  const stopped = (
    kind: OutboxAction["kind"],
    code: string,
    status: number,
  ): Pick<OutboxAction, "kind" | "lastError" | "conflict"> => ({
    kind,
    lastError: { code, message: "The picker's own sentence.", status, occurredAt: 1_000 },
  });

  const filesCodes: Array<[number, string, string]> = [
    [
      403,
      "evidence_receipt_scope_mismatch",
      "The files on this saved item don't match this action.",
    ],
    [404, "evidence_receipt_not_found", "The files on this saved item don't match this action."],
    [400, "evidence_scope_invalid", "The files on this saved item don't match this action."],
    [400, "evidence_receipts_required", "This step needs a photo or PDF."],
    [404, "evidence_target_not_found", "We couldn't find what these files belong to."],
    [409, "evidence_object_missing", "We couldn't confirm that a file was saved."],
    [409, "evidence_object_mismatch", "We couldn't confirm that a file was saved."],
    [
      409,
      "evidence_upload_conflict",
      "A file on this saved item was already used for something else.",
    ],
    [413, "evidence_file_size_invalid", "A file on this saved item can't be used."],
    [415, "evidence_type_mismatch", "A file on this saved item can't be used."],
    [400, "evidence_file_name_invalid", "A file on this saved item can't be used."],
    [400, "evidence_idempotency_key_required", "We couldn't use the files on this saved item."],
  ];

  it.each(filesCodes)(
    "gives a stock action one step, and no picker button, for %i %s",
    (status, code, reason) => {
      expect(outboxFailureGuidance(stopped("inventory_command", code, status))).toEqual({
        reason,
        nextStep:
          "Nothing was recorded. Record the action again on the stock desk and add the files again.",
        retryable: false,
        notSent: true,
        officeConfirmed: false,
      });
    },
  );

  it.each(filesCodes)(
    "gives corrective evidence one step, and no picker button, for %i %s",
    (status, code, reason) => {
      expect(outboxFailureGuidance(stopped("safety_corrective_evidence", code, status))).toEqual({
        reason,
        nextStep: "Nothing was submitted. Open the action and add the files again.",
        retryable: false,
        notSent: true,
        officeConfirmed: false,
      });
    },
  );

  it("never mixes the picker's wording or the generic 'tell the office' with it", () => {
    for (const [status, code] of filesCodes) {
      const { reason, nextStep } = outboxFailureGuidance(
        stopped("safety_corrective_evidence", code, status),
      );
      const text = `${reason} ${nextStep}`;
      expect(text, code).not.toMatch(
        /Remove it|Remove the|Choose another|Try again|tell the office/,
      );
      expect(text, code).not.toMatch(/evidence_|receipt|sha|digest|hash|\bR2\b|evu_/i);
    }
  });

  it("sends an account problem to the owner, not to the picker", () => {
    for (const code of ["evidence_actor_inactive", "inventory_write_role_required"]) {
      expect(outboxFailureGuidance(stopped("inventory_command", code, 403))).toEqual({
        reason: "Your account can't add files for this step.",
        nextStep: "Ask the owner for help. Nothing was sent.",
        retryable: false,
        notSent: true,
        officeConfirmed: false,
      });
    }
  });

  it("keeps the sign-in step for a changed role", () => {
    expect(
      outboxFailureGuidance(stopped("inventory_command", "evidence_actor_role_changed", 403)),
    ).toMatchObject({
      nextStep: "Sign in again, then open the action and add the files again.",
      retryable: false,
      notSent: true,
      officeConfirmed: false,
    });
  });

  it("calls a file that keeps timing out slow, and lets the person try again", () => {
    expect(
      outboxFailureGuidance(stopped("safety_corrective_evidence", "upload_too_slow", 408)),
    ).toEqual({
      reason: "A file is taking too long to upload on this connection.",
      nextStep: "Move to a place with better signal, then try again. Nothing was lost.",
      retryable: true,
      notSent: false,
      officeConfirmed: false,
    });
  });
});
