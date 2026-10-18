// Each Google call site asks for the scopes it uses and no more. Mail asks for gmail.send alone,
// so a domain-wide delegation grant that lists only gmail.send (the qa Worker's) can still mint
// a token for it; Drive keeps asking for drive. The per-isolate token cache is keyed by scope as
// well as subject, so a token minted for one service is never replayed against the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureJobFolder, resetGoogleAdapterStateForTest, sendGmail } from "../src/google.ts";
import { getExternalEffectByIdempotency } from "../src/effect-runtime.ts";
import { canonicalJson, sha256Hex } from "../src/newo-hash.ts";
import { watchdogAlertHtml } from "../src/operations.ts";
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
function fakeGoogle(options: { denyGmailRead?: boolean; sendResponse?: unknown } = {}) {
  const mintedScopes: string[] = [];
  const gmailTokens: string[] = [];
  const driveTokens: string[] = [];
  let gmailPosts = 0;
  let gmailGets = 0;
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
        gmailPosts++;
        lastRaw = String((JSON.parse(String(init?.body)) as { raw: string }).raw);
        return json(options.sendResponse ?? { id: "gmail-message-1" });
      }
      gmailGets++;
      if (options.denyGmailRead) return new Response("read scope required", { status: 403 });
      return json({ id: "gmail-message-1", raw: lastRaw });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) {
      driveTokens.push(bearer);
      return json({ files: [{ id: "folder-1", name: "26-0007 Dana Example (IronWrap)" }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return {
    fetchMock, mintedScopes, gmailTokens, driveTokens,
    get gmailPosts() { return gmailPosts; },
    get gmailGets() { return gmailGets; },
  };
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

test("a send-only grant confirms the accepted send and replays without mailbox read access", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const options = { idempotencyKey: "gmail-send-proof-0001" };

  const first = await sendGmail(env, "pat@example.test", "Your estimate", "<p>Attached.</p>", options);
  const replay = await sendGmail(env, "pat@example.test", "Your estimate", "<p>Attached.</p>", options);

  assert.deepEqual(first, { providerMessageId: "gmail-message-1" });
  assert.deepEqual(replay, first);
  assert.equal(google.gmailPosts, 1);
  assert.equal(google.gmailGets, 0);
  assert.deepEqual(google.mintedScopes, [GMAIL_SEND]);
  const effect = await getExternalEffectByIdempotency(env as never, "ironwrap", options.idempotencyKey);
  assert.equal(effect?.state, "succeeded");
  assert.equal(effect?.provider_external_id, "gmail-message-1");
  assert.match(effect?.provider_response_hash ?? "", /^[0-9a-f]{64}$/);
  assert.match(effect?.readback_hash ?? "", /^[0-9a-f]{64}$/);
});

test("a default Gmail effect key keeps the recipient out of durable ledger identifiers", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "pat@example.test";
  const subject = "Your estimate";
  const html = "<p>Attached.</p>";
  const requestHash = await sha256Hex(canonicalJson({ to, subject, html }));
  const key = `gmail:${requestHash}`;

  await sendGmail(env, to, subject, html);
  const replay = await sendGmail(env, to, subject, html);

  assert.deepEqual(replay, { providerMessageId: "gmail-message-1" });
  assert.equal(google.gmailPosts, 1);
  const effect = await getExternalEffectByIdempotency(env as never, "ironwrap", key);
  assert.equal(effect?.state, "succeeded");
  for (const value of [effect?.idempotency_key, effect?.task_id, effect?.aggregate_id, effect?.intent_id, effect?.correlation_id]) {
    assert.ok(value && !value.includes(to));
  }
});

test("a persistent watchdog finding replays within a check window and sends in the next one", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "owner@example.test";
  const subject = "IronWrap bus watchdog: attention required";
  const finding = ["core readiness failing: d1"];
  const first = watchdogAlertHtml(finding, new Date("2026-01-01T14:00:00.000Z"));
  const retry = watchdogAlertHtml(finding, new Date("2026-01-01T14:05:00.000Z"));
  const persistent = watchdogAlertHtml(finding, new Date("2026-01-02T14:00:00.000Z"));

  await sendGmail(env, to, subject, first);
  await sendGmail(env, to, subject, retry);
  assert.equal(google.gmailPosts, 1);
  await sendGmail(env, to, subject, persistent);
  assert.equal(google.gmailPosts, 2);
  assert.equal(google.gmailGets, 0);
  for (const html of [first, persistent]) {
    const requestHash = await sha256Hex(canonicalJson({ to, subject, html }));
    assert.equal((await getExternalEffectByIdempotency(env as never, "ironwrap", `gmail:${requestHash}`))?.state, "succeeded");
  }
});

test("a default send replays a pre-upgrade effect instead of minting a second key", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "pat@example.test";
  const subject = "Your estimate";
  const html = "<p>Attached.</p>";
  const requestHash = await sha256Hex(canonicalJson({ to, subject, html }));
  const legacyKey = `gmail:${to}:${requestHash}`;

  await sendGmail(env, to, subject, html, { idempotencyKey: legacyKey });
  const replay = await sendGmail(env, to, subject, html);

  assert.deepEqual(replay, { providerMessageId: "gmail-message-1" });
  assert.equal(google.gmailPosts, 1);
  assert.equal(await getExternalEffectByIdempotency(env as never, "ironwrap", `gmail:${requestHash}`), null);
});

test("a mixed-version send cannot insert the legacy key after the opaque effect exists", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "pat@example.test";
  const subject = "Your estimate";
  const html = "<p>Attached.</p>";
  const requestHash = await sha256Hex(canonicalJson({ to, subject, html }));

  await sendGmail(env, to, subject, html);
  await assert.rejects(
    sendGmail(env, to, subject, html, { idempotencyKey: `gmail:${to}:${requestHash}` }),
    /effect_proposal_failed/,
  );
  assert.equal(google.gmailPosts, 1);
});

test("a new Worker replays an old effect inserted after its first legacy lookup", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "pat@example.test";
  const subject = "Your estimate";
  const html = "<p>Attached.</p>";
  const requestHash = await sha256Hex(canonicalJson({ to, subject, html }));
  const legacyKey = `gmail:${to}:${requestHash}`;
  const database = env.DB;
  let injected = false;
  const racingDatabase = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM external_effects WHERE tenant_id = ? AND idempotency_key = ?")) return statement;
          return {
            bind(...args: unknown[]) {
              const bound = statement.bind(...args);
              return {
                async first() {
                  const row = await bound.first();
                  if (!injected && args[1] === legacyKey && row === null) {
                    injected = true;
                    await sendGmail({ ...env, DB: database }, to, subject, html, { idempotencyKey: legacyKey });
                  }
                  return row;
                },
              };
            },
          };
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const replay = await sendGmail({ ...env, DB: racingDatabase }, to, subject, html);

  assert.equal(injected, true);
  assert.deepEqual(replay, { providerMessageId: "gmail-message-1" });
  assert.equal(google.gmailPosts, 1);
  assert.equal(await getExternalEffectByIdempotency(env as never, "ironwrap", `gmail:${requestHash}`), null);
});

test("a legacy unknown send remains unknown after the key change", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ sendResponse: {} });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "pat@example.test";
  const subject = "Your estimate";
  const html = "<p>Attached.</p>";
  const requestHash = await sha256Hex(canonicalJson({ to, subject, html }));
  const legacyKey = `gmail:${to}:${requestHash}`;

  await assert.rejects(sendGmail(env, to, subject, html, { idempotencyKey: legacyKey }), /effect_dispatch_unknown/);
  await assert.rejects(sendGmail(env, to, subject, html), /effect_unknown_requires_reconciliation/);
  assert.equal(google.gmailPosts, 1);
  assert.equal(await getExternalEffectByIdempotency(env as never, "ironwrap", `gmail:${requestHash}`), null);
});

test("an explicit recipient-bearing key can migrate without resending a prior effect", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "pat@example.test";
  const subject = "Your decision was recorded";
  const html = "<p>Thanks.</p>";
  const legacyKey = `portal-decision-confirmation:ironwrap:decision-1:${to}`;
  const newKey = `portal-decision-confirmation:${await sha256Hex(canonicalJson({
    tenantId: "ironwrap", decisionId: "decision-1", recipient: to,
  }))}`;
  const taskId = "portal-decision-confirmation:ironwrap:decision-1";

  await sendGmail(env, to, subject, html, { idempotencyKey: legacyKey, taskId });
  const replay = await sendGmail(env, to, subject, html, {
    idempotencyKey: newKey, legacyIdempotencyKey: legacyKey, taskId,
  });

  assert.deepEqual(replay, { providerMessageId: "gmail-message-1" });
  assert.equal(google.gmailPosts, 1);
  assert.equal(await getExternalEffectByIdempotency(env as never, "ironwrap", newKey), null);

  const nextDecision = "decision-2";
  const nextKey = `portal-decision-confirmation:${await sha256Hex(canonicalJson({
    tenantId: "ironwrap", decisionId: nextDecision, recipient: to,
  }))}`;
  await sendGmail(env, to, subject, "<p>Another choice.</p>", {
    idempotencyKey: nextKey,
    legacyIdempotencyKey: `portal-decision-confirmation:ironwrap:${nextDecision}:${to}`,
    taskId: `portal-decision-confirmation:ironwrap:${nextDecision}`,
  });
  assert.equal(google.gmailPosts, 2);
  const nextEffect = await getExternalEffectByIdempotency(env as never, "ironwrap", nextKey);
  assert.equal(nextEffect?.state, "succeeded");
  for (const value of [nextEffect?.idempotency_key, nextEffect?.task_id, nextEffect?.aggregate_id, nextEffect?.intent_id, nextEffect?.correlation_id]) {
    assert.ok(value && !value.includes(to));
  }
});

test("a mixed-version portal confirmation cannot send again under its old key", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ denyGmailRead: true });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const to = "pat@example.test";
  const subject = "We recorded your material choice";
  const html = "<p>We recorded it.</p>";
  const taskId = "portal-decision-confirmation:ironwrap:decision-1";
  const legacyKey = `${taskId}:${to}`;
  const newKey = `portal-decision-confirmation:${await sha256Hex(canonicalJson({
    tenantId: "ironwrap", decisionId: "decision-1", recipient: to,
  }))}`;

  await sendGmail(env, to, subject, html, {
    idempotencyKey: newKey, legacyIdempotencyKey: legacyKey, taskId,
  });
  await assert.rejects(
    sendGmail(env, to, subject, html, { idempotencyKey: legacyKey, taskId }),
    /effect_proposal_failed/,
  );
  assert.equal(google.gmailPosts, 1);

  const otherTaskId = "portal-decision-confirmation:ironwrap:decision-2";
  await sendGmail(env, to, subject, html, {
    idempotencyKey: `portal-decision-confirmation:${await sha256Hex(canonicalJson({
      tenantId: "ironwrap", decisionId: "decision-2", recipient: to,
    }))}`,
    taskId: otherTaskId,
  });
  assert.equal(google.gmailPosts, 2);
});

test("an accepted send with a missing receipt remains unknown and never sends a second time", async (t) => {
  resetGoogleAdapterStateForTest();
  const google = fakeGoogle({ sendResponse: {} });
  t.mock.method(globalThis, "fetch", google.fetchMock);
  const env = await googleEnv();
  const options = { idempotencyKey: "gmail-send-no-receipt-0001" };

  await assert.rejects(
    sendGmail(env, "pat@example.test", "Your estimate", "<p>Attached.</p>", options),
    /effect_dispatch_unknown/,
  );
  await assert.rejects(
    sendGmail(env, "pat@example.test", "Your estimate", "<p>Attached.</p>", options),
    /effect_unknown_requires_reconciliation/,
  );
  assert.equal(google.gmailPosts, 1);
  assert.equal(google.gmailGets, 0);
  const effect = await getExternalEffectByIdempotency(env as never, "ironwrap", options.idempotencyKey);
  assert.equal(effect?.state, "unknown");
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
