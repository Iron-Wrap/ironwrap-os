import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import {
  isRefusal,
  messageFor,
  messageForLoad,
  ONLINE_ONLY_CONNECTION,
  PLAIN_LOAD_FAILED,
  PLAIN_REFUSED,
  PLAIN_UNCONFIRMED,
  PLAIN_UNREADABLE,
  PLAIN_UNREADABLE_LOAD,
  PlainError,
  unanswered,
  UNANSWERED_CONNECTION,
} from "./plain-error";

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

afterEach(() => vi.restoreAllMocks());

const refusal = (status: number, code = "a_code_nobody_named") =>
  new ApiError({ status, code, message: `[${code}] raw server wording` });

describe("messageFor", () => {
  it("shows words a person wrote for the screen", () => {
    expect(messageFor(new PlainError("Pick a job first."))).toBe("Pick a job first.");
  });

  it("never shows server prose, parser output or Error text, and logs the raw error", () => {
    const log = quiet();
    const server = new ApiError({
      status: 500,
      code: "upstream_unavailable",
      message: "D1_ERROR: no such table: work_packages",
    });
    const errors = [server, new Error("D1_ERROR: no such table"), "boom", null];
    for (const error of errors) expect(messageFor(error)).toBe(PLAIN_UNCONFIRMED);
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls[0]![1]).toBe(server);
    for (const error of errors) expect(messageForLoad(error)).toBe(PLAIN_LOAD_FAILED);
  });

  it("never claims a change did not happen unless the office refused it", () => {
    quiet();
    // The Worker can commit a change, or a provider act on it, and still fail before it answers;
    // an answer can be lost on the way back; an app fault can come after the request left.
    const uncertain = [
      new ApiError({ status: 500, code: "upstream_unavailable", message: "x" }),
      new ApiError({ status: 502, code: "approval_store_unavailable", message: "x" }),
      new ApiError({ status: 503, code: "decision_in_progress", message: "x" }),
      new ApiError({ status: 408, code: "http_408", message: "x" }),
      new ApiError({ status: 0, code: "network_error", message: "No connection." }),
      new ApiError({ status: 0, code: "timeout", message: "The connection took too long." }),
      new ApiError({ status: 200, code: "invalid_response", message: "x" }),
      new Error("IndexedDB write failed after send"),
    ];
    for (const error of uncertain) {
      const words = messageFor(error);
      expect(words).not.toMatch(/nothing was changed|stayed|was not saved/i);
      expect(words).toMatch(/could not confirm|cannot say if|check what was saved/i);
    }
    expect(PLAIN_UNCONFIRMED).toBe(
      "We could not confirm this went through. Check what was saved before you try again.",
    );
  });

  it("lets a read say Try again, because a read changes nothing", () => {
    quiet();
    const down = new ApiError({ status: 502, code: "upstream_unavailable", message: "x" });
    expect(messageForLoad(down)).toBe("Something went wrong on our side. Try again.");
    expect(messageForLoad(new ApiError({ status: 0, code: "network_error", message: "x" }))).toBe(
      "No connection to IronWrap OS. Try again when you are back online.",
    );
    expect(messageForLoad(new ApiError({ status: 200, code: "invalid_json", message: "x" }))).toBe(
      PLAIN_UNREADABLE_LOAD,
    );
    // A refusal reads the same on a load as on a change.
    expect(messageForLoad(refusal(404))).toBe(messageFor(refusal(404)));
  });

  it("never words a refusal as our fault or as a retry that cannot work", () => {
    quiet();
    // The statuses a refusal comes back with. Only 429 clears by waiting, and it says how long.
    for (const status of [400, 401, 403, 404, 405, 409, 410, 412, 413, 422]) {
      const words = messageFor(refusal(status), { fallback: "Check the call and try again." });
      expect(words, String(status)).not.toBe(PLAIN_UNCONFIRMED);
      expect(words, String(status)).not.toMatch(/on our side|try again/i);
      expect(words, String(status)).not.toMatch(/raw server wording|a_code_nobody_named/);
    }
  });

  it("says what each refusal status means, with one next step", () => {
    quiet();
    expect(messageFor(refusal(401))).toBe("Your session expired. Sign in again to carry on.");
    expect(messageFor(refusal(403))).toBe(
      "Your account does not have access to this. Ask the office to check your access.",
    );
    expect(messageFor(refusal(404))).toBe(
      "We could not find this. It may be closed, or not open to you. Open it again from your list.",
    );
    for (const status of [409, 412]) {
      expect(messageFor(refusal(status))).toBe(
        "What is saved now does not allow this. Open it again to see where things stand.",
      );
    }
  });

  it("gives an unnamed refusal the honest generic sentence, or the screen's own", () => {
    quiet();
    expect(messageFor(refusal(422))).toBe(PLAIN_REFUSED);
    expect(PLAIN_REFUSED).toBe("The office did not accept this. Ask the office what to change.");
    expect(messageFor(refusal(400), { refused: "Check the details and try again." })).toBe(
      "Check the details and try again.",
    );
    // A status sentence is truer than a screen's guess at what a 403 means.
    expect(messageFor(refusal(403), { refused: "Check the details and try again." })).toMatch(
      /does not have access/,
    );
  });

  it("tells the person how long to wait when the office asks them to slow down", () => {
    quiet();
    const limited = (retryAfterMs?: number) =>
      new ApiError({ status: 429, code: "rate_limited", message: "slow down", retryAfterMs });
    expect(messageFor(limited(30_000))).toBe(
      "Too many tries in a short time. Wait 30 seconds, then try again.",
    );
    expect(messageFor(limited(300_000))).toBe(
      "Too many tries in a short time. Wait 5 minutes, then try again.",
    );
    expect(messageFor(limited())).toBe(
      "Too many tries in a short time. Wait a minute, then try again.",
    );
  });

  it("uses words every screen shares for a stale session", () => {
    expect(messageFor(refusal(403, "csrf_failed"))).toBe(
      "Your session needs refreshing. Reload the page and try again.",
    );
  });

  it("does not say nothing changed when the server answered but the app could not read it", () => {
    const log = quiet();
    const contract = new ApiError({
      status: 200,
      code: "invalid_response",
      message: "The server response did not match the app contract.",
    });
    // Even a screen with its own fallback cannot know, so its fallback is not used.
    expect(messageFor(contract, { fallback: "Check the details and try again." })).toBe(
      PLAIN_UNREADABLE,
    );
    expect(PLAIN_UNREADABLE).not.toMatch(/nothing was changed/i);
    expect(log).toHaveBeenCalledOnce();
    // A screen that knows the code still words it itself.
    expect(messageFor(contract, { byCode: { invalid_response: "Reload the page." } })).toBe(
      "Reload the page.",
    );
  });

  it("never promises saved work when the connection drops", () => {
    const offline = new ApiError({
      status: 0,
      code: "network_error",
      message: "No connection to IronWrap OS. Your saved work stays on this device.",
    });
    const slow = new ApiError({
      status: 0,
      code: "timeout",
      message: "The connection took too long. Try again when signal improves.",
    });
    // A change with no answer may have reached the office, so the person checks first.
    expect(messageFor(offline)).toBe(ONLINE_ONLY_CONNECTION.network_error);
    expect(messageFor(slow)).toBe(ONLINE_ONLY_CONNECTION.timeout);
    expect(messageFor(offline, { byCode: UNANSWERED_CONNECTION })).toBe(
      "The connection dropped before IronWrap OS answered.",
    );
    for (const sentence of [
      ...Object.values(ONLINE_ONLY_CONNECTION),
      ...Object.values(UNANSWERED_CONNECTION),
      messageForLoad(offline),
      messageForLoad(slow),
    ]) {
      expect(sentence).not.toMatch(/saved work stays/i);
    }
    expect(unanswered(offline) && unanswered(slow)).toBe(true);
    expect(unanswered(refusal(409))).toBe(false);
  });

  it("keeps the other messages the app words itself for a request that never left", () => {
    const unopened = new ApiError({
      status: 0,
      code: "offline_packet_unavailable",
      message:
        "This field packet has not been opened on this device yet. Reconnect to load it once.",
    });
    expect(messageFor(unopened)).toBe(unopened.message);
  });

  it("logs an error once, however often a screen asks for its words again", () => {
    const log = quiet();
    const refused = new Error("D1_ERROR: no such table");
    messageFor(refused);
    messageFor(refused);
    expect(log).toHaveBeenCalledTimes(1);
    messageFor(new Error("D1_ERROR: no such table"));
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("uses the screen's own sentence for a known code, then its own fallback", () => {
    quiet();
    const copy = {
      byCode: { approval_expired: "This review ended before you chose. Ask for a new review." },
      fallback: "We could not save this choice. Load the saved list before you choose again.",
    };
    const expired = new ApiError({ status: 409, code: "approval_expired", message: "expired" });
    const down = new ApiError({ status: 502, code: "approval_store_unavailable", message: "x" });
    expect(messageFor(expired, copy)).toBe(copy.byCode.approval_expired);
    expect(messageFor(down, copy)).toBe(copy.fallback);
    // An inherited property is not a sentence anyone wrote.
    const inherited = new ApiError({ status: 502, code: "constructor", message: "x" });
    expect(messageFor(inherited, copy)).toBe(copy.fallback);
  });
});

describe("isRefusal", () => {
  it("is true only for an answer that resending cannot change", () => {
    for (const status of [400, 401, 403, 404, 409, 412, 422]) {
      expect(isRefusal(refusal(status)), String(status)).toBe(true);
    }
    for (const status of [0, 200, 408, 429, 500, 502, 503]) {
      expect(isRefusal(refusal(status)), String(status)).toBe(false);
    }
    expect(isRefusal(new Error("x"))).toBe(false);
    expect(isRefusal(undefined)).toBe(false);
  });
});
