import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import { afterFailedSend } from "./work-plan-intent";

const answer = (status: number, code: string, retryAfterMs?: number) =>
  new ApiError({ status, code, message: code, retryAfterMs });

describe("what a failed Start or Finish means for the kept request", () => {
  it("keeps it whenever the first send may have committed", () => {
    for (const error of [
      answer(0, "network_error"),
      answer(0, "timeout"),
      answer(502, "upstream_unavailable"),
      answer(408, "http_408"),
      answer(429, "rate_limited"),
      new Error("app fault"),
    ]) {
      expect(afterFailedSend(error, false)).toBe("keep");
      expect(afterFailedSend(error, true)).toBe("keep");
    }
  });

  it("keeps a resend across a session or access problem, but drops a first send it refused", () => {
    for (const error of [
      answer(401, "unauthorized"),
      answer(403, "csrf_failed"),
      answer(403, "field_role_required"),
    ]) {
      expect(afterFailedSend(error, true)).toBe("keep");
      expect(afterFailedSend(error, false)).toBe("drop");
    }
  });

  it("drops it on a definite refusal of the action itself", () => {
    for (const error of [
      answer(409, "idempotency_conflict"),
      answer(409, "work_package_version_conflict"),
      answer(404, "not_found"),
      answer(400, "invalid_work_package_action"),
    ]) {
      expect(afterFailedSend(error, true)).toBe("drop");
    }
  });

  it("waits for the Worker's Retry-After while the same request is still running", () => {
    expect(afterFailedSend(answer(503, "action_in_progress", 2_000), true)).toEqual({
      waitMs: 2_000,
    });
    expect(afterFailedSend(answer(503, "action_in_progress"), false)).toEqual({ waitMs: 5_000 });
  });
});
