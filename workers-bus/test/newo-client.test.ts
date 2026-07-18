import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEWO_DOCUMENTED_OPERATIONS,
  NewoApiClient,
  resetNewoTokenCacheForTest,
} from "../src/newo-client.ts";

const config = {
  baseUrl: "https://api.newo.example",
  apiKey: "api-key-super-secret",
  timeoutMs: 1_000,
};

test("the typed client enumerates all 31 documented Newo operations", () => {
  assert.equal(NEWO_DOCUMENTED_OPERATIONS.length, 31);
  assert.equal(new Set(NEWO_DOCUMENTED_OPERATIONS).size, 31);
});

test("cold token exchange and one 401 refresh retry keep tokens in request memory", async (t) => {
  resetNewoTokenCacheForTest();
  const calls: Array<{ url: string; authorization: string | null; body: string | null }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (url.endsWith("/api/v1/auth/api-key/token")) {
      assert.equal(headers.get("x-api-key"), config.apiKey);
      return json({ access_token: "access-one", refresh_token: "refresh-one", token_type: "Bearer", expires_in: "900" });
    }
    if (url.endsWith("/api/v1/auth/token/refresh")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { refresh_token: "refresh-one" });
      return json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", expires_in: "900" });
    }
    if (url.includes("/api/v1/actors/agent")) {
      if (headers.get("authorization") === "Bearer access-one") {
        return json({ code: 401, reason: "expired" }, 401);
      }
      assert.equal(headers.get("authorization"), "Bearer access-two");
      return json([{ id: "agent-1" }]);
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const result = await new NewoApiClient(config).listAgentActors({
    integration_idn: "ironwrap",
    connector_idn: "receptionist",
  });
  assert.deepEqual(result, [{ id: "agent-1" }]);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(({ url }) => url.endsWith("/api/v1/auth/token/refresh")).length, 1);
  assert.equal(JSON.stringify(calls).includes(config.apiKey), false, "captured URL/body evidence must not contain the API key");
});

test("provider errors cannot echo bearer material", async (t) => {
  resetNewoTokenCacheForTest();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/api-key/token")) {
      return json({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer", expires_in: 900 });
    }
    return json({ reason: "Authorization Bearer access-secret" }, 500);
  });
  await assert.rejects(
    () => new NewoApiClient(config).getAgentActor("agent-1"),
    (error: Error) => {
      assert.equal(error.message, "newo_api_http_500:provider_error");
      assert.doesNotMatch(error.message, /access-secret|refresh-secret|Bearer/);
      return true;
    },
  );
});

test("Newo requests fail with a bounded timeout", async (t) => {
  resetNewoTokenCacheForTest();
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
  await assert.rejects(
    () => new NewoApiClient({ ...config, timeoutMs: 10 }).authenticate(),
    /newo_api_timeout_10ms/,
  );
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
