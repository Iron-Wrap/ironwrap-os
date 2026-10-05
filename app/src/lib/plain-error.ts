import { ApiError, isRetryableApiError } from "./api";

/**
 * A change was sent and no answer came back that this app can trust: a 5xx, a timeout the server
 * reported, or an app fault around the request. The Worker can commit a change, or a provider can
 * act on it, and still fail before it answers, so the change may have happened. The next step is
 * to check, never to resend blind, and nothing claims the change did not happen.
 */
export const PLAIN_UNCONFIRMED =
  "We could not confirm this went through. Check what was saved before you try again.";

/** A read that failed on our side. A read changes nothing, so trying again is safe. */
export const PLAIN_LOAD_FAILED = "Something went wrong on our side. Try again.";

/**
 * The server answered with success, but this app could not read the answer (an old app version
 * against a newer server, a cut-off reply). A change may well have gone through.
 */
export const PLAIN_UNREADABLE =
  "We could not read the answer, so we cannot say if this went through. Reload before you try again.";

/** The same, for a read: nothing was being changed, so the page only needs loading again. */
export const PLAIN_UNREADABLE_LOAD = "We could not read the answer. Reload the page and try again.";

/**
 * A refusal nobody wrote words for: the office answered and said no. Trying the same thing again
 * gets the same answer, so it never says "Try again". The code stays in System details.
 */
export const PLAIN_REFUSED = "The office did not accept this. Ask the office what to change.";

/**
 * What every screen says for the refusals that mean the same thing wherever they come from. A
 * screen's own `byCode` wins over these; status words come after them (`refusalByStatus`).
 */
const SHARED_BY_CODE: Readonly<Record<string, string>> = {
  csrf_failed: "Your session needs refreshing. Reload the page and try again.",
};

/**
 * What happened to a change sent with no answer back, for a screen that adds its own next step
 * (it may have reached the office before the connection dropped).
 */
export const UNANSWERED_CONNECTION: Readonly<Record<string, string>> = {
  network_error: "The connection dropped before IronWrap OS answered.",
  timeout: "The connection took too long.",
};

/**
 * A change sent with no answer back may have reached the office before the connection dropped, so
 * the person checks before sending it again. This is what `messageFor` says by default; `api.ts`
 * words its own connection errors for a phone whose items wait on the device, and none of the
 * screens that ask for words has saved anything on the device when the request fails.
 */
export const ONLINE_ONLY_CONNECTION: Readonly<Record<string, string>> = {
  network_error: `${UNANSWERED_CONNECTION.network_error} Check what was saved before you try again.`,
  timeout: `${UNANSWERED_CONNECTION.timeout} Check what was saved before you try again.`,
};

/** A read with no answer back: it changed nothing, so the person only needs signal again. */
const LOAD_CONNECTION: Readonly<Record<string, string>> = {
  network_error: "No connection to IronWrap OS. Try again when you are back online.",
  timeout: "The connection took too long. Try again when signal improves.",
};

/**
 * An error whose message a person wrote for the person reading the screen. Throw this instead
 * of a plain `Error` when the words are meant to be shown: `messageFor` shows no other error
 * text verbatim.
 */
export class PlainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlainError";
  }
}

export interface PlainErrorCopy {
  /** Sentences this screen wrote for the API codes it knows. */
  byCode?: Readonly<Record<string, string>>;
  /**
   * This screen's sentence for a refusal it has no code for, in place of `PLAIN_REFUSED`. Used
   * only for a 4xx that no status sentence covers (a 400 or 422, mostly), so it describes a
   * request the office will not take as sent.
   */
  refused?: string;
  /**
   * This screen's sentence for a failure that is not a refusal: a 5xx, a timeout or an app fault.
   * For a change it must not claim the change did not happen (defaults to `PLAIN_UNCONFIRMED`);
   * for a read (`messageForLoad`) it defaults to `PLAIN_LOAD_FAILED`.
   */
  fallback?: string;
}

/**
 * True when the office answered and said no: a 4xx that waiting or resending cannot change (a
 * 408 or 429 can). A screen shows no "Try again" for one, and adds no retry advice of its own.
 */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    !isRetryableApiError(error)
  );
}

/** True when a request got no answer at all, so nobody can say yet whether it went through. */
export function unanswered(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "network_error" || error.code === "timeout");
}

/**
 * The words to show for an error from a request that changes something. Only words written for
 * people reach the screen: a `PlainError`'s message, a sentence a screen or this module wrote for
 * a known API code, a sentence for what the status means, or the app's own words for a request
 * that never got an answer. Server prose, parser output and `Error` text never do: the raw error
 * goes to the console for whoever is debugging (design/ZERO-LEARNING-GATE.md, Z2).
 *
 * Only a refusal (a 4xx the office answered before doing anything) is a known outcome. Every
 * other failure says the change may have happened and to check first (`PLAIN_UNCONFIRMED`), and
 * a refusal never says "Try again" unless waiting or reloading fixes it (Z3.4: one next step).
 */
export function messageFor(error: unknown, copy: PlainErrorCopy = {}): string {
  return plainWords(error, copy, "change");
}

/** The words for a failed read. A read changes nothing, so a server fault may say "Try again". */
export function messageForLoad(error: unknown, copy: PlainErrorCopy = {}): string {
  return plainWords(error, copy, "load");
}

function plainWords(error: unknown, copy: PlainErrorCopy, request: "change" | "load"): string {
  if (error instanceof PlainError) return error.message;
  if (error instanceof ApiError) {
    const known =
      sentenceFor(copy.byCode, error.code) ??
      sentenceFor(SHARED_BY_CODE, error.code) ??
      sentenceFor(request === "load" ? LOAD_CONNECTION : ONLINE_ONLY_CONNECTION, error.code);
    if (known) return known;
    if (error.status === 0) return error.message;
    report(error);
    if (error.status >= 200 && error.status < 300) {
      return request === "load" ? PLAIN_UNREADABLE_LOAD : PLAIN_UNREADABLE;
    }
    if (error.status >= 400 && error.status < 500) {
      const byStatus = refusalByStatus(error);
      if (byStatus) return byStatus;
      if (isRefusal(error)) return copy.refused ?? PLAIN_REFUSED;
    }
  } else {
    report(error);
  }
  return copy.fallback ?? (request === "load" ? PLAIN_LOAD_FAILED : PLAIN_UNCONFIRMED);
}

function sentenceFor(
  byCode: Readonly<Record<string, string>> | undefined,
  code: string,
): string | undefined {
  return byCode && Object.hasOwn(byCode, code) ? byCode[code] : undefined;
}

/** What the status alone says truthfully, whichever route answered. */
function refusalByStatus(error: ApiError): string | undefined {
  switch (error.status) {
    case 401:
      return "Your session expired. Sign in again to carry on.";
    case 403:
      return "Your account does not have access to this. Ask the office to check your access.";
    case 404:
      return "We could not find this. It may be closed, or not open to you. Open it again from your list.";
    case 409:
    case 412:
      return "What is saved now does not allow this. Open it again to see where things stand.";
    case 429:
      return `Too many tries in a short time. Wait ${waitFor(error.retryAfterMs)}, then try again.`;
    default:
      return undefined;
  }
}

function waitFor(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return "a minute";
  const seconds = Math.ceil(retryAfterMs / 1_000);
  if (seconds <= 1) return "a second";
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/** Errors already sent to the console: a screen asks for its words again on every render. */
const reported = new WeakSet<object>();

function report(error: unknown): void {
  const isObject = typeof error === "object" && error !== null;
  if (isObject && reported.has(error)) return;
  if (isObject) reported.add(error);
  console.error("Showing a plain message instead of this error:", error);
}
