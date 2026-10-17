import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import {
  evidenceProblemFor,
  evidenceReadProblemFor,
  evidenceProblemFromError,
  evidenceRefusalKind,
  isEvidenceSubmitCode,
  type EvidenceNextStep,
} from "./evidence-messages";

const cases: Array<[number, string, EvidenceNextStep, RegExp]> = [
  [400, "evidence_idempotency_key_required", "readd", /could not be sent/],
  [400, "invalid_multipart", "readd", /could not be sent/],
  [400, "unexpected_field", "readd", /could not be sent/],
  [400, "evidence_scope_invalid", "fix", /Finish the details above/],
  [400, "evidence_file_required", "readd", /could not be sent/],
  [400, "evidence_file_name_invalid", "readd", /name can't be used/],
  [413, "evidence_file_size_invalid", "readd", /too large \(max 8 MB\)/],
  [413, "payload_too_large", "readd", /too large \(max 8 MB\)/],
  [415, "multipart_required", "readd", /could not be sent/],
  [415, "evidence_type_unsupported", "readd", /photo or a PDF/],
  [415, "evidence_type_mismatch", "readd", /isn't a real photo or PDF/],
  [403, "csrf_failed", "signin", /Reload the page/],
  [403, "inventory_write_role_required", "none", /Ask the owner/],
  [403, "inventory_transition_role_required", "none", /Ask the owner/],
  [403, "office_role_required", "none", /Ask the owner/],
  [403, "owner_role_required", "none", /Ask the owner/],
  [403, "evidence_actor_inactive", "none", /Ask the owner/],
  [403, "evidence_actor_role_changed", "signin", /Sign in again to attach files/],
  [404, "evidence_target_not_found", "fix", /couldn't find that item/],
  [409, "evidence_upload_conflict", "readd", /Remove it and add it again/],
  [409, "evidence_object_missing", "retry", /Try again/],
  [409, "evidence_object_mismatch", "readd", /Remove it and add it again/],
  [429, "evidence_upload_rate_limited", "retry", /Too many uploads right now/],
  [502, "evidence_store_unavailable", "retry", /Try again/],
  [403, "evidence_receipt_scope_mismatch", "readd", /different step/],
  [404, "evidence_receipt_not_found", "readd", /could not be found/],
  [400, "evidence_receipts_required", "readd", /needs a photo or PDF/],
];

describe("evidence messages", () => {
  it.each(cases)("%i %s gives one plain next step", (status, code, next, wording) => {
    const problem = evidenceProblemFor({ status, code });
    expect(problem.next).toBe(next);
    expect(problem.message).toMatch(wording);
  });

  it("never shows a code, a receipt, a hash or a storage term", () => {
    const banned = /receipt|sha|digest|hash|\br2\b|evu_|evidence_|csrf|multipart|idempotency|http/i;
    for (const [status, code] of cases) {
      expect(evidenceProblemFor({ status, code }).message, `${status} ${code}`).not.toMatch(banned);
    }
    for (const status of [0, 401, 403, 500, 503]) {
      expect(evidenceProblemFor({ status, code: "something_new" }).message).not.toMatch(banned);
    }
  });

  it("does not offer a retry when access changed after sign-in", () => {
    expect(evidenceProblemFor({ status: 403, code: "evidence_actor_role_changed" })).toEqual({
      message: "Your access changed. Sign in again to attach files.",
      next: "signin",
    });
  });

  it("names what a missing record is", () => {
    expect(
      evidenceProblemFor({ status: 404, code: "evidence_target_not_found", target: "job" }).message,
    ).toBe("We couldn't find that job. Check it and this file will try again by itself.");
  });

  it("never offers Try again where sending the same file again could only fail the same way", () => {
    // These are about a detail above the file: fixing it starts the upload again by itself.
    for (const code of ["evidence_scope_invalid", "evidence_target_not_found"]) {
      expect(evidenceProblemFor({ status: 400, code }).next).toBe("fix");
    }
  });

  it("says a slow upload is slow, not that there is no signal, and asks for a better signal", () => {
    const problem = evidenceProblemFor({ status: 0, code: "timeout" });
    expect(problem.next).toBe("retry");
    expect(problem.message).toBe(
      "This upload is too slow on this connection. Move to a better signal, then try again.",
    );
    expect(problem.message).not.toMatch(/no signal/i);
  });

  it("says a download that is too slow is slow, and offers another try", () => {
    expect(evidenceReadProblemFor({ status: 0, code: "timeout" })).toEqual({
      message:
        "This is taking too long on this connection. Move to a better signal, then try again.",
      next: "retry",
    });
    expect(evidenceReadProblemFor({ status: 0, code: "network_error" }).message).toMatch(
      /No signal/,
    );
  });

  it("explains the cases the Worker only answers by status", () => {
    expect(evidenceProblemFor({ status: 0, code: "network_error" })).toMatchObject({
      next: "retry",
      message: expect.stringContaining("No signal"),
    });
    expect(evidenceProblemFor({ status: 401, code: "session_invalid" }).next).toBe("signin");
    expect(evidenceProblemFor({ status: 403, code: "forbidden" }).next).toBe("none");
    expect(evidenceProblemFor({ status: 500, code: "anything" }).next).toBe("retry");
  });

  it("reads an ApiError and falls back for anything else", () => {
    const error = new ApiError({
      status: 409,
      code: "evidence_upload_conflict",
      message: "Conflict",
    });
    expect(evidenceProblemFromError(error).next).toBe("readd");
    expect(evidenceProblemFromError(new Error("boom"))).toEqual({
      message: "Couldn't upload. Try again in a moment.",
      next: "retry",
    });
  });

  it("tells a refusal about the account from a refusal about the files", () => {
    for (const code of [
      "evidence_actor_inactive",
      "inventory_write_role_required",
      "owner_role_required",
    ]) {
      expect(evidenceRefusalKind(code), code).toBe("account");
    }
    for (const code of [
      "evidence_receipt_scope_mismatch",
      "evidence_object_missing",
      "payload_too_large",
      "unexpected_field",
    ]) {
      expect(evidenceRefusalKind(code), code).toBe("files");
    }
    expect(evidenceRefusalKind("http_500")).toBeUndefined();
    expect(evidenceRefusalKind("evidence_upload_rate_limited")).toBeUndefined();
  });

  it("recognises the codes an evidence-carrying submit can answer with", () => {
    expect(isEvidenceSubmitCode("evidence_actor_role_changed")).toBe(true);
    expect(isEvidenceSubmitCode("evidence_receipt_scope_mismatch")).toBe(true);
    expect(isEvidenceSubmitCode("safety_corrective_action_state_invalid")).toBe(false);
    expect(isEvidenceSubmitCode("evidence_upload_rate_limited")).toBe(false);
  });
});
