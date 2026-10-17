import { ApiError } from "../lib/api";

/**
 * What a person reads when a file could not be attached. Every message names exactly one next
 * step in everyday words; no code, hash or storage term ever reaches the screen. The Worker's own
 * code only picks the sentence.
 *
 * - `retry`: sending the same file again can work, so a Try again button is offered.
 * - `readd`: the same file would fail the same way, so the only way forward is to remove it and
 *   choose it again (which also gives it a fresh upload key).
 * - `fix`: nothing is wrong with the file; a detail above it is. Correcting that detail starts the
 *   upload again by itself, and sending it again unchanged could only fail the same way.
 * - `signin`: nothing about the file is wrong; the person has to sign in again first.
 * - `none`: the person cannot fix this themselves.
 */
export type EvidenceNextStep = "retry" | "readd" | "fix" | "signin" | "none";

export interface EvidenceProblem {
  message: string;
  next: EvidenceNextStep;
}

export const TOO_LARGE_MESSAGE =
  "This file is too large (max 8 MB). Choose a smaller photo or PDF.";
export const UNSUPPORTED_MESSAGE = "This kind of file can't be used. Choose a photo or a PDF.";

const ROLE_CODES = new Set([
  "inventory_write_role_required",
  "inventory_transition_role_required",
  "office_role_required",
  "owner_role_required",
]);

/**
 * `target` is the plain noun for what the file belongs to ("job", "stock lot", "action"), so a
 * missing record reads as "We couldn't find that job" rather than as a failure of the file.
 */
export function evidenceProblemFor(input: {
  status: number;
  code: string;
  target?: string;
}): EvidenceProblem {
  const { status, code } = input;
  switch (code) {
    case "evidence_actor_role_changed":
      return { message: "Your access changed. Sign in again to attach files.", next: "signin" };
    case "evidence_actor_inactive":
      return { message: "Your account can't add files. Ask the owner for help.", next: "none" };
    case "csrf_failed":
      return {
        message: "Your sign-in needs refreshing. Reload the page, then add the file again.",
        next: "signin",
      };
    case "evidence_upload_rate_limited":
      return { message: "Too many uploads right now. Try again in a moment.", next: "retry" };
    case "evidence_file_size_invalid":
    case "payload_too_large":
      return { message: TOO_LARGE_MESSAGE, next: "readd" };
    case "evidence_type_unsupported":
      return { message: UNSUPPORTED_MESSAGE, next: "readd" };
    case "evidence_type_mismatch":
      return {
        message: "This file isn't a real photo or PDF. Choose another file.",
        next: "readd",
      };
    case "evidence_file_name_invalid":
      return {
        message: "This file's name can't be used. Rename the file, then add it again.",
        next: "readd",
      };
    case "evidence_scope_invalid":
      return {
        message: "Finish the details above. This file will try again by itself.",
        next: "fix",
      };
    case "evidence_target_not_found":
      return {
        message: `We couldn't find that ${input.target ?? "item"}. Check it and this file will try again by itself.`,
        next: "fix",
      };
    case "evidence_upload_conflict":
      return {
        message: "This file was already used for something else. Remove it and add it again.",
        next: "readd",
      };
    case "evidence_object_missing":
      return { message: "We couldn't confirm the file was saved. Try again.", next: "retry" };
    case "evidence_object_mismatch":
      return {
        message: "We couldn't confirm the file was saved. Remove it and add it again.",
        next: "readd",
      };
    case "evidence_receipts_required":
      return { message: "This step needs a photo or PDF. Add one, then save.", next: "readd" };
    case "evidence_receipt_not_found":
      return {
        message:
          "One of the files could not be found. Remove the files, add them again, then save.",
        next: "readd",
      };
    case "evidence_receipt_scope_mismatch":
      return {
        message:
          "These files were added for a different step. Remove them, add them again, then save.",
        next: "readd",
      };
    case "multipart_required":
    case "invalid_multipart":
    case "unexpected_field":
    case "evidence_file_required":
    case "evidence_idempotency_key_required":
    case "evidence_receipt_mismatch":
      return { message: "This file could not be sent. Remove it and add it again.", next: "readd" };
    default:
      break;
  }
  if (ROLE_CODES.has(code)) {
    return { message: "You can't add files for this step. Ask the owner for help.", next: "none" };
  }
  if (status === 401) {
    return {
      message: "Your sign-in ended. Sign in again, then add the file again.",
      next: "signin",
    };
  }
  if (status === 429) {
    return { message: "Too many uploads right now. Try again in a moment.", next: "retry" };
  }
  if (code === "timeout") {
    return {
      message:
        "This upload is too slow on this connection. Move to a better signal, then try again.",
      next: "retry",
    };
  }
  if (status === 0) {
    return { message: "No signal. Check your connection, then try again.", next: "retry" };
  }
  if (status === 403) {
    return { message: "You can't add files for this step. Ask the owner for help.", next: "none" };
  }
  return { message: "Couldn't upload. Try again in a moment.", next: "retry" };
}

/**
 * Why an attached file could not be opened, or a record that lists files could not be read.
 * The Worker answers 404 for a file that is not linked to a record this person may see, 403 once
 * their access no longer matches their sign-in, 409 when the stored bytes cannot be verified,
 * and 502 for a store that is down.
 */
export function evidenceReadProblemFor(input: { status: number; code: string }): EvidenceProblem {
  if (input.code === "timeout") {
    return {
      message:
        "This is taking too long on this connection. Move to a better signal, then try again.",
      next: "retry",
    };
  }
  switch (input.status) {
    case 404:
      return {
        message: "This file is not available. Ask the office if you need it.",
        next: "none",
      };
    case 403:
      return {
        message: "Your access changed. Sign in again to open files.",
        next: "signin",
      };
    case 409:
      return { message: "This file could not be verified. Ask the office.", next: "none" };
    case 502:
      return { message: "Couldn't load this file. Try again.", next: "retry" };
    case 401:
      return { message: "Your sign-in ended. Sign in again to open files.", next: "signin" };
    case 0:
      return { message: "No signal. Check your connection, then try again.", next: "retry" };
    default:
      return { message: "Couldn't open this file. Try again.", next: "retry" };
  }
}

export function evidenceProblemFromError(error: unknown, target?: string): EvidenceProblem {
  if (error instanceof ApiError) {
    return evidenceProblemFor({
      status: error.status,
      code: error.code,
      ...(target === undefined ? {} : { target }),
    });
  }
  return { message: "Couldn't upload. Try again in a moment.", next: "retry" };
}

/**
 * Whether a refusal is about the person's account or about the files, for a saved item that
 * cannot offer the picker's buttons. `undefined` for anything that is not an evidence refusal.
 */
export function evidenceRefusalKind(code: string): "account" | "files" | undefined {
  if (code === "evidence_actor_inactive" || ROLE_CODES.has(code)) return "account";
  if (
    code === "payload_too_large" ||
    code === "multipart_required" ||
    code === "invalid_multipart" ||
    code === "unexpected_field"
  ) {
    return "files";
  }
  return isEvidenceSubmitCode(code) ? "files" : undefined;
}

/** The codes only an evidence-carrying submit can answer with, so a page can say them plainly. */
export function isEvidenceSubmitCode(code: string): boolean {
  return code.startsWith("evidence_") && code !== "evidence_upload_rate_limited";
}
