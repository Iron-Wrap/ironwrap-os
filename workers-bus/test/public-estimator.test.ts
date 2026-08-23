import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import {
  handlePublicInstantEstimate,
  prunePublicEstimateRateLimits,
  type PublicEstimatorEnv,
} from "../src/public-estimator.ts";

const ORIGIN = "https://app.example.com";
const CLIENT_ONE = "7f39f1da-5738-4b42-8090-620bdd6ea123";
const CLIENT_TWO = "e490b6f7-dcb8-4fd0-9c78-724e1df733e8";
const ENVELOPE = "ow_11111111-1111-4111-8111-111111111111";

function env(overrides: Partial<PublicEstimatorEnv> = {}) {
  const submissions = new Map<string, Record<string, unknown>>();
  const rates = new Map<string, number>();
  const value = {
    PUBLIC_ESTIMATE_ENABLED: "true",
    PUBLIC_ESTIMATE_ALLOWED_ORIGINS: ORIGIN,
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "ironwrap,iroof",
    PUBLIC_ESTIMATE_CONSENT_JURISDICTION: "Alberta, Canada",
    PUBLIC_ESTIMATE_ALLOW_INSECURE_LOCAL: "false",
    PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY: "site-key",
    PUBLIC_ESTIMATE_TURNSTILE_SECRET: "turnstile-secret",
    PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: "rate-pepper-with-at-least-thirty-two-characters",
    PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS: "900",
    PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX: "2",
    PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX: "2",
    PUBLIC_ESTIMATE_RANGE_RULES_JSON: "[]",
    ERPNEXT_ENABLED: "false",
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes("WHERE estimate_submission_key = ?")) {
                  return submissions.get(String(args[0])) ?? null;
                }
                if (sql.includes("INSERT INTO public_estimate_rate_limits")) {
                  const key = `${args[0]}:${args[1]}`;
                  const attempts = (rates.get(key) ?? 0) + 1;
                  rates.set(key, attempts);
                  return { attempts };
                }
                return null;
              },
              async run() { return { success: true }; },
            };
          },
        };
      },
    },
    ...overrides,
  } as unknown as PublicEstimatorEnv;
  return { env: value, submissions, rates };
}

function submission(clientSubmissionId = CLIENT_ONE) {
  return {
    brand: "ironwrap",
    service: "metal_roofing",
    contact: { name: "Ava Customer", email: "ava@example.com" },
    property: { address: "10 Roofline Way", city: "Calgary", province: "AB", postal_code: "T2P 1J9" },
    consent: { contact: true, privacy: true },
    turnstile_token: "turnstile-token-for-a-real-browser-session",
    client_submission_id: clientSubmissionId,
  };
}

function request(body = submission(), headers: Record<string, string> = {}) {
  return new Request("https://bus.example/public/instant-estimate", {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      "idempotency-key": body.client_submission_id,
      "cf-connecting-ip": "198.51.100.19",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function successfulTurnstile() {
  return async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(init?.method, "POST");
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("secret"), "turnstile-secret");
    assert.equal(form.get("response"), "turnstile-token-for-a-real-browser-session");
    assert.equal(form.get("remoteip"), "198.51.100.19");
    assert.equal(form.get("idempotency_key"), CLIENT_ONE);
    return Response.json({ success: true });
  };
}

test("GET config is disabled by default through the Worker route and permits same-origin no-Origin fetches", async () => {
  const response = await worker.fetch(
    new Request("https://bus.example/public/instant-estimate/config"),
    {} as never,
    { waitUntil() {} } as never,
  );
  const body = await response.json() as { enabled: boolean; turnstile_site_key: string | null; range_available: boolean };
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    enabled: false,
    turnstile_site_key: null,
    range_available: false,
    disclaimer: "This request does not produce an online price. An estimator must verify measurements, access, materials, and approved pricing before any quote, scope, schedule, material, or payment commitment.",
    review_required: true,
    // No APP_TENANT_ID in this bare Worker env, so there is no tenant whose brands could be named.
    brands: [],
    default_brand: null,
    logo_url: null,
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("GET config never advertises an online range", async () => {
  const { env: configured } = env();
  const ironwrap = await handlePublicInstantEstimate(
    new Request("https://bus.example/public/instant-estimate/config?brand=ironwrap"),
    configured,
  );
  const iroof = await handlePublicInstantEstimate(
    new Request("https://bus.example/public/instant-estimate/config?brand=iroof"),
    configured,
  );
  const unknown = await handlePublicInstantEstimate(
    new Request("https://bus.example/public/instant-estimate/config?brand=unknown"),
    configured,
  );
  assert.equal((await ironwrap.json() as { range_available: boolean }).range_available, false);
  assert.equal((await iroof.json() as { range_available: boolean }).range_available, false);
  assert.equal((await unknown.json() as { range_available: boolean }).range_available, false);
});

test("public endpoint enforces exact Origin and returns explicit preflight CORS only to allowed origins", async () => {
  const { env: configured } = env();
  const denied = await handlePublicInstantEstimate(request(submission(), { origin: "https://evil.example" }), configured);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  const preflight = await handlePublicInstantEstimate(new Request("https://bus.example/public/instant-estimate", {
    method: "OPTIONS",
    headers: { origin: ORIGIN },
  }), configured);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Idempotency-Key/);
});

test("public instant estimate rejects invalid input and failed Turnstile before ingest", async () => {
  const { env: configured } = env();
  let ingested = false;
  const invalid = await handlePublicInstantEstimate(request({ ...submission(), contact: { name: "Ava Customer" } }), configured, {
    ingest: async () => { ingested = true; return Response.json({ ok: true, envelope_id: ENVELOPE }); },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_request" });

  const rejected = await handlePublicInstantEstimate(request(), configured, {
    fetch: async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }),
    ingest: async () => { ingested = true; return Response.json({ ok: true, envelope_id: ENVELOPE }); },
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "turnstile_failed" });
  assert.equal(ingested, false);
});

test("public intake persists consent without a price or the Turnstile token", async () => {
  const { env: configured } = env();
  let captured = "";
  const response = await handlePublicInstantEstimate(request(), configured, {
    fetch: successfulTurnstile(),
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    ingest: async (_env, raw) => {
      captured = raw;
      return Response.json({ ok: true, envelope_id: ENVELOPE });
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    accepted: true,
    envelope_id: ENVELOPE,
    range: null,
    disclaimer: "This request does not produce an online price. An estimator must verify measurements, access, materials, and approved pricing before any quote, scope, schedule, material, or payment commitment.",
    review_required: true,
  });
  assert.equal(JSON.stringify(body).includes("Ava Customer"), false);
  assert.equal(JSON.stringify(body).includes("min_cad"), false);
  const raw = JSON.parse(captured) as Record<string, unknown>;
  assert.equal(raw.source_detail, "ironwrap_public_estimator");
  assert.equal(captured.includes("turnstile-token-for-a-real-browser-session"), false);
  const publicEstimator = raw.public_estimator as Record<string, unknown>;
  assert.deepEqual(publicEstimator.consent, {
    contact: true,
    privacy: true,
    recorded_at: "2026-07-18T00:00:00.000Z",
    origin: ORIGIN,
  });
  assert.equal(publicEstimator.jurisdiction, "Alberta, Canada");
  assert.equal(publicEstimator.version, 2);
  assert.equal(publicEstimator.pricing_state, "measurement_required");
  assert.equal(publicEstimator.range, null);
  assert.equal(raw.instant_estimate, true);
  assert.equal(raw.estimate_type, "review_intake");
  assert.equal(Object.hasOwn(raw, "range_low"), false);
  assert.equal(Object.hasOwn(raw, "range_high"), false);
});

test("identical retries skip single-use Turnstile and replay the durable review intake", async () => {
  const { env: configured, submissions } = env();
  let captured = "";
  const first = await handlePublicInstantEstimate(request(), configured, {
    fetch: successfulTurnstile(),
    ingest: async (_env, raw) => {
      captured = raw;
      return Response.json({ ok: true, envelope_id: ENVELOPE });
    },
  });
  assert.equal(first.status, 200);
  submissions.set(`estimate:project:public:${CLIENT_ONE}`, { payload_json: captured });
  const replay = await handlePublicInstantEstimate(request(), configured, {
    fetch: async () => { throw new Error("a replay must not re-use Turnstile"); },
    now: () => new Date("2026-07-19T00:00:00.000Z"),
    ingest: async (_env, raw) => {
      assert.equal(raw, captured);
      return Response.json({ ok: true, envelope_id: ENVELOPE, idempotent_replay: true });
    },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    accepted: true,
    envelope_id: ENVELOPE,
    range: null,
    disclaimer: "This request does not produce an online price. An estimator must verify measurements, access, materials, and approved pricing before any quote, scope, schedule, material, or payment commitment.",
    review_required: true,
    idempotent_replay: true,
  });
});

test("a legacy stored payload cannot be replayed as a v2 public review intake", async () => {
  const { env: configured, submissions } = env();
  const key = `estimate:project:public:${CLIENT_ONE}`;
  const legacyRow = {
    payload_json: JSON.stringify({
      public_estimator: {
        version: 1,
        submission_fingerprint: "a".repeat(64),
      },
    }),
  };
  submissions.set(key, legacyRow);

  let ingested = false;
  const response = await handlePublicInstantEstimate(request(), configured, {
    fetch: async () => { throw new Error("Turnstile must not run for an idempotency conflict"); },
    ingest: async () => { ingested = true; return Response.json({ ok: true, envelope_id: ENVELOPE }); },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "idempotency_conflict" });
  assert.equal(ingested, false);
  assert.strictEqual(submissions.get(key), legacyRow);
});

test("a configured secondary IP guard blocks excess verified submissions and missing range-disable config fails closed", async () => {
  const { env: configured } = env({ PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX: "1" });
  const dependencies = {
    fetch: async () => Response.json({ success: true }),
    ingest: async () => Response.json({ ok: true, envelope_id: ENVELOPE }),
  };
  const first = await handlePublicInstantEstimate(request(), configured, dependencies);
  assert.equal(first.status, 200);
  const limited = await handlePublicInstantEstimate(request(submission(CLIENT_TWO)), configured, dependencies);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "rate_limited" });

  const { env: missingRules } = env({ PUBLIC_ESTIMATE_RANGE_RULES_JSON: "" });
  const unavailable = await handlePublicInstantEstimate(request(), missingRules, dependencies);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "public_estimate_not_configured" });
});

test("only configured tenant brands can submit and legacy range rules fail closed", async () => {
  const unknownBrand = { ...submission(), brand: "unapproved-brand" };
  const { env: configured } = env();
  const rejected = await handlePublicInstantEstimate(request(unknownBrand), configured, {
    fetch: async () => { throw new Error("Turnstile must not run for an unknown brand"); },
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid_request" });

  const { env: invalidRules } = env({
    PUBLIC_ESTIMATE_RANGE_RULES_JSON: JSON.stringify([{
      rule_id: "other-brand-v1",
      brand: "unapproved-brand",
      service: "metal_roofing",
      province: "AB",
      min_cad: 1,
      max_cad: 2,
    }]),
  });
  const unavailable = await handlePublicInstantEstimate(request(), invalidRules);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "public_estimate_not_configured" });
});

test("public intake accepts only the tenant service and Canadian province catalogue", async () => {
  const { env: configured } = env();
  for (const body of [
    { ...submission(), service: "invented_service" },
    { ...submission(), property: { ...submission().property, province: "XX" } },
  ]) {
    const response = await handlePublicInstantEstimate(request(body), configured, {
      fetch: async () => { throw new Error("Turnstile must not run for an invalid catalogue value"); },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
});

test("review-only intake remains price-free and D1 failures are safely unavailable", async () => {
  const { env: noRules } = env({ PUBLIC_ESTIMATE_RANGE_RULES_JSON: "[]" });
  const reviewOnly = await handlePublicInstantEstimate(request(), noRules, {
    fetch: successfulTurnstile(),
    ingest: async () => Response.json({ ok: true, envelope_id: ENVELOPE }),
  });
  assert.equal(reviewOnly.status, 200);
  assert.deepEqual(await reviewOnly.json(), {
    accepted: true,
    envelope_id: ENVELOPE,
    range: null,
    disclaimer: "This request does not produce an online price. An estimator must verify measurements, access, materials, and approved pricing before any quote, scope, schedule, material, or payment commitment.",
    review_required: true,
  });

  const { env: unavailable } = env({
    DB: { prepare() { throw new Error("d1 is temporarily unavailable"); } },
  });
  const failed = await handlePublicInstantEstimate(request(), unavailable, {
    fetch: async () => { throw new Error("Turnstile must not run when idempotency storage is unavailable"); },
  });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "submission_unavailable" });
  assert.equal(failed.headers.get("access-control-allow-origin"), ORIGIN);
});

test("rate-limit pruning deletes only expired keyed-hash records", async () => {
  let query = "";
  const pruneEnv = {
    DB: {
      prepare(sql: string) {
        query = sql;
        return { bind: () => ({ run: async () => ({ success: true }) }) };
      },
    },
  } as unknown as PublicEstimatorEnv;
  await prunePublicEstimateRateLimits(pruneEnv, new Date("2026-07-18T00:00:00.000Z"));
  assert.match(query, /^DELETE FROM public_estimate_rate_limits WHERE window_expires_at <= \?$/);
});
