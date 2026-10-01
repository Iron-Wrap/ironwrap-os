// Each Google call site asks for the scopes it uses and no more. Mail asks for gmail.send alone,
// so a domain-wide delegation grant that lists only gmail.send (the qa Worker's) can still mint
// a token for it; Drive keeps asking for drive. The per-isolate token cache is keyed by scope as
// well as subject, so a token minted for one service is never replayed against the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureJobFolder, resetGoogleAdapterStateForTest, sendGmail } from "../src/google.ts";
import { withTestEffectRuntime } from "./effect-runtime-fixture.ts";

const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const DRIVE = "https://www.googleapis.com/auth/drive";

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

async function googleEnv(): Promise<Env> {
  return withTestEffectRuntime({
    GOOGLE_SERVICE_ACCOUNT_JSON: await serviceAccountJson(),
    FROM_EMAIL: "sales@example.test",
    SHARED_DRIVE_ID_JOBS: "shared-drive-jobs",
  }) as unknown as Env;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * Fake Google: the token endpoint hands back a token named after the `scope` claim it was asked
 * for, and every Gmail/Drive request records which token it carried.
 */
function fakeGoogle() {
  const mintedScopes: string[] = [];
  const gmailTokens: string[] = [];
  const driveTokens: string[] = [];
  let lastRaw = "";
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
      const claims = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString()) as { scope: string };
      mintedScopes.push(claims.scope);
      return json({ access_token: `token-for ${claims.scope}`, expires_in: 3600 });
    }
    if (url.startsWith("https://gmail.googleapis.com/")) {
      gmailTokens.push(bearer);
      if (url.endsWith("/messages/send")) {
        lastRaw = String((JSON.parse(String(init?.body)) as { raw: string }).raw);
        return json({ id: "gmail-message-1" });
      }
      return json({ id: "gmail-message-1", raw: lastRaw });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      driveTokens.push(bearer);
      return json({ files: [{ id: "folder-1", name: "26-0007 Dana Example (IronWrap)" }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { fetchMock, mintedScopes, gmailTokens, driveTokens };
}

test("mail asks Google for gmail.send and nothing else", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle();
  t.mock.method(globalThis, "fetch", google.fetchMock);

  await sendGmail(await googleEnv(), "pat@example.test", "Your estimate", "<p>Attached.</p>");

  assert.deepEqual(google.mintedScopes, [GMAIL_SEND]);
  assert.ok(google.gmailTokens.length >= 1);
  for (const token of google.gmailTokens) assert.equal(token, `token-for ${GMAIL_SEND}`);
});

test("a Drive call still asks Google for drive", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle();
  t.mock.method(globalThis, "fetch", google.fetchMock);

  await ensureJobFolder(await googleEnv(), "26-0007");

  assert.deepEqual(google.mintedScopes, [DRIVE]);
  assert.ok(google.driveTokens.length >= 1);
  for (const token of google.driveTokens) assert.equal(token, `token-for ${DRIVE}`);
});

test("the token cache never hands a gmail-only token to a Drive call", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle();
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();

  await sendGmail(env, "pat@example.test", "First", "<p>One.</p>");
  await ensureJobFolder(env, "26-0007");
  await sendGmail(env, "pat@example.test", "Second", "<p>Two.</p>");
  await ensureJobFolder(env, "26-0007");

  // One mint per scope: Drive got its own token, and each service then reused its own.
  assert.deepEqual(google.mintedScopes, [GMAIL_SEND, DRIVE]);
  for (const token of google.driveTokens) assert.equal(token, `token-for ${DRIVE}`);
  for (const token of google.gmailTokens) assert.equal(token, `token-for ${GMAIL_SEND}`);
});
