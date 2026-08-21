import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isCreditOrAuthExhausted,
  omnirouteConfigFrom,
  omnirouteGeminiGenerateContentUrl,
  omnirouteMessagesUrl,
  OMNIROUTE_FALLBACK_MODEL,
} from "../src/omniroute-fallback.ts";

test("credit/auth exhaustion matches billing and auth refusals, not generic faults", () => {
  assert.equal(isCreditOrAuthExhausted(401, ""), true);
  assert.equal(isCreditOrAuthExhausted(402, '{"error":{"type":"billing_error"}}'), true);
  assert.equal(isCreditOrAuthExhausted(403, "permission denied"), true);
  assert.equal(
    isCreditOrAuthExhausted(429, '{"error":{"type":"insufficient_quota","message":"credit balance is too low"}}'),
    true,
  );
  assert.equal(isCreditOrAuthExhausted(429, "Your account has no remaining credits"), true);
  assert.equal(isCreditOrAuthExhausted(429, '{"error":{"type":"rate_limit_error"}}'), false);
  assert.equal(isCreditOrAuthExhausted(400, "invalid_request_error"), false);
  assert.equal(isCreditOrAuthExhausted(500, "overloaded"), false);
  assert.equal(isCreditOrAuthExhausted(200, ""), false);
});

test("OmniRoute config requires a reachable origin and a key; localhost HTTP is local-only", () => {
  assert.equal(omnirouteConfigFrom({}), null);
  assert.equal(omnirouteConfigFrom({ OMNIROUTE_API_KEY: "sk-test" }), null);
  assert.equal(omnirouteConfigFrom({ OMNIROUTE_URL: "https://omni.example" }), null);
  assert.equal(
    omnirouteConfigFrom({ OMNIROUTE_URL: "https://omni.example/v1", OMNIROUTE_API_KEY: "sk-test" }),
    null,
  );
  assert.equal(
    omnirouteConfigFrom({ OMNIROUTE_URL: "http://omni.example", OMNIROUTE_API_KEY: "sk-test" }),
    null,
  );
  assert.deepEqual(
    omnirouteConfigFrom({ OMNIROUTE_URL: "https://omni.example/", OMNIROUTE_API_KEY: " sk-test " }),
    { baseUrl: "https://omni.example", apiKey: "sk-test" },
  );
  assert.deepEqual(
    omnirouteConfigFrom({
      OMNIROUTE_URL: "http://127.0.0.1:20128",
      OMNIROUTE_API_KEY: "sk-local",
    }),
    { baseUrl: "http://127.0.0.1:20128", apiKey: "sk-local" },
  );
});

test("OmniRoute Anthropic and Gemini URLs stay on the official compatible paths", () => {
  assert.equal(OMNIROUTE_FALLBACK_MODEL, "auto");
  assert.equal(
    omnirouteMessagesUrl("https://omni.example"),
    "https://omni.example/v1/messages",
  );
  assert.equal(
    omnirouteGeminiGenerateContentUrl("https://omni.example", "gemini-2.5-flash-image"),
    "https://omni.example/v1beta/models/gemini-2.5-flash-image:generateContent",
  );
});
