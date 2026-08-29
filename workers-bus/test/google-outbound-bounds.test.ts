// Every Google call leaves the Worker for a third party, so every one of them must fail on a
// bound rather than wait. These are contract tests for that bound (ELEC-220): a present-but-
// wrong credential — a typo'd key, a revoked service account, a partition to Google — must cost
// one timeout and then fast failures, never an open-ended wait per request.
//
// googleToken() is the choke point every Gmail/Drive/Docs call passes through, so exercising it
// exercises the shared door; the remaining ten call sites route through the same googleFetch().
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_DEFAULT_TIMEOUT_MS,
  googleRequestTimeout,
  googleToken,
  resetGoogleAdapterStateForTest,
} from "../src/google.ts";

const SUB = "sales@example.test";

/** A throwaway key generated per run: real enough for crypto.subtle, never a credential. */
async function serviceAccountJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const base64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  return JSON.stringify({
    client_email: "adapter@example.iam.gserviceaccount.test",
    private_key: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`,
  });
}

async function env(overrides: Record<string, string> = {}): Promise<Env> {
  return {
    GOOGLE_SERVICE_ACCOUNT_JSON: await serviceAccountJson(),
    FROM_EMAIL: SUB,
    ...overrides,
  } as unknown as Env;
}

test("the Google request bound is configurable but never unbounded or absurd", () => {
  assert.equal(googleRequestTimeout(undefined), GOOGLE_DEFAULT_TIMEOUT_MS);
  assert.equal(googleRequestTimeout("2500"), 2_500);
  assert.equal(googleRequestTimeout("0"), GOOGLE_DEFAULT_TIMEOUT_MS);
  assert.equal(googleRequestTimeout("999"), GOOGLE_DEFAULT_TIMEOUT_MS);
  assert.equal(googleRequestTimeout("30001"), GOOGLE_DEFAULT_TIMEOUT_MS);
  assert.equal(googleRequestTimeout("2.5"), GOOGLE_DEFAULT_TIMEOUT_MS);
  assert.equal(googleRequestTimeout("soon"), GOOGLE_DEFAULT_TIMEOUT_MS);
});

test("a Google host that never answers fails on the bound instead of hanging", async (t) => {
  resetGoogleAdapterStateForTest();
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
  const config = await env({ APP_GOOGLE_REQUEST_TIMEOUT_MS: "1000" });
  await assert.rejects(
    () => googleToken(config, SUB),
    /^Error: google_token_timeout_1000ms$/,
  );
});

test("an unresponsive Google host is skipped once the breaker trips, with no further outbound call", async (t) => {
  resetGoogleAdapterStateForTest();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("connection refused");
  });
  const config = await env();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(() => googleToken(config, `${SUB}#${attempt}`), /^Error: google_token_network_error$/);
  }
  assert.equal(fetchMock.mock.callCount(), 3);

  // Fourth call: refused locally, before the socket. The cost of a bad credential stops growing.
  await assert.rejects(() => googleToken(config, `${SUB}#4`), /^Error: google_token_circuit_open_\d+s$/);
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("a Google host that answers clears the failure run behind it", async (t) => {
  resetGoogleAdapterStateForTest();
  let answer = false;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    if (!answer) throw new TypeError("connection refused");
    return new Response(JSON.stringify({ access_token: "token-value" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const config = await env();

  await assert.rejects(() => googleToken(config, `${SUB}#a`), /google_token_network_error/);
  await assert.rejects(() => googleToken(config, `${SUB}#b`), /google_token_network_error/);
  answer = true;
  assert.equal(await googleToken(config, `${SUB}#c`), "token-value");

  // Two fresh failures must not land on top of the pre-success run, so the next call still tries.
  answer = false;
  await assert.rejects(() => googleToken(config, `${SUB}#d`), /google_token_network_error/);
  await assert.rejects(() => googleToken(config, `${SUB}#e`), /google_token_network_error/);
  assert.equal(fetchMock.mock.callCount(), 5);
  await assert.rejects(() => googleToken(config, `${SUB}#f`), /google_token_network_error/);
  assert.equal(fetchMock.mock.callCount(), 6);
});

test("a rejection from Google is an answer, not unresponsiveness, and never trips the breaker", async (t) => {
  resetGoogleAdapterStateForTest();
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
  const config = await env();
  for (let attempt = 1; attempt <= 5; attempt++) {
    await assert.rejects(
      () => googleToken(config, `${SUB}#${attempt}`),
      /^Error: google_token: invalid_grant Invalid JWT Signature\.$/,
    );
  }
  // A prompt 4xx costs nothing to repeat, and the caller — not the breaker — must classify it.
  assert.equal(fetchMock.mock.callCount(), 5);
});
