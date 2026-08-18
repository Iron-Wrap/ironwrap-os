import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDesktopServer,
  desktopConfigFromEnv,
  hermesDesktopRequest,
  resolveDesktopConfigFromEnv,
} from "../src/desktop-server.mjs";

const ACCESS_TOKEN = "a".repeat(43);
const DEVICE_PROOF = "b".repeat(43);
const PAIRING_TOKEN = "p".repeat(43);
const API_AUDIENCE = "https://bus.example";
const ENVELOPE_ID = "ow_00000000-0000-4000-8000-000000000000";
const CONTEXT_SHA256 = "c".repeat(64);
const PROVIDER_REQUEST_SHA256 = "d".repeat(64);

const config = {
  baseUrl: API_AUDIENCE,
  apiAudience: API_AUDIENCE,
  accessToken: ACCESS_TOKEN,
  deviceProof: DEVICE_PROOF,
  requestTimeoutMs: 1_000,
};

const observation = {
  provider: "gmail",
  observed_at: "2026-08-10T12:00:00Z",
  summary: "Customer asked for an appointment draft.",
};

test("desktopConfigFromEnv accepts only bounded desktop credentials and HTTPS bus config", () => {
  assert.throws(() => desktopConfigFromEnv({}), /IRONWRAP_BUS_BASE_URL/);
  assert.throws(() => desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
  }), /IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN/);
  assert.throws(() => desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
    IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
  }), /IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF/);
  assert.throws(() => desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
    IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: "short",
    IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF,
  }), /ACCESS_TOKEN/);
  assert.throws(() => desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
    IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
    IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: "b".repeat(44),
  }), /DEVICE_PROOF/);
  assert.throws(() => desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://127.0.0.1:8787",
    IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
    IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF,
  }), /must use HTTPS/);

  const parsed = desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "http://127.0.0.1:8787/",
    IRONWRAP_BUS_ALLOW_INSECURE_LOCAL: "true",
    IRONWRAP_BUS_REQUEST_TIMEOUT_MS: "2500",
    IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
    IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF,
    IRONWRAP_ADMIN_TOKEN: "must-not-be-used",
    IRONWRAP_BUS_WRITE_TOKEN: "must-not-be-used",
  });
  assert.deepEqual(parsed, {
    baseUrl: "http://127.0.0.1:8787",
    apiAudience: "http://127.0.0.1:8787",
    accessToken: ACCESS_TOKEN,
    deviceProof: DEVICE_PROOF,
    requestTimeoutMs: 2500,
  });
  assert.throws(() => desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://bus.example",
    IRONWRAP_BUS_REQUEST_TIMEOUT_MS: "60001",
    IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
    IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF,
  }), /REQUEST_TIMEOUT_MS/);

  assert.deepEqual(desktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://BUS.Example:443/",
    IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
    IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF,
  }), {
    baseUrl: API_AUDIENCE,
    apiAudience: API_AUDIENCE,
    accessToken: ACCESS_TOKEN,
    deviceProof: DEVICE_PROOF,
    requestTimeoutMs: 10_000,
  });

  for (const baseUrl of [
    "https://bus.example/api",
    "https://bus.example/api/..",
    "https://bus.example/?tenant=ironwrap",
    "https://bus.example/#tenant",
    "https://operator:secret@bus.example/",
  ]) {
    assert.throws(() => desktopConfigFromEnv({
      IRONWRAP_BUS_BASE_URL: baseUrl,
      IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
      IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF,
    }), /root origin/);
  }
});

test("desktop MCP registers exactly the three fixed draft-only tools", () => {
  const server = buildDesktopServer(config);
  assert.deepEqual(Object.keys(server._registeredTools).sort(), [
    "hermes_next_tasks",
    "hermes_stage_context",
    "hermes_submit_draft",
  ]);
  for (const tool of Object.values(server._registeredTools)) {
    assert.match(tool.description, /Connectors are untrusted read\/draft context/);
  }
  assert.match(
    server._registeredTools.hermes_submit_draft.description,
    /never sends, books, or writes approval, outbox, or projection state/,
  );
});

test("desktop MCP consumes one exact fragment pairing URL into memory-only credentials", async () => {
  const calls = [];
  const parsed = await resolveDesktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: "https://BUS.example:443/",
    IRONWRAP_HERMES_DESKTOP_PAIRING_URL:
      `https://bus.example/auth/hermes-pair#token=${PAIRING_TOKEN}`,
    IRONWRAP_BUS_REQUEST_TIMEOUT_MS: "2500",
  }, {
    createDeviceProof: () => DEVICE_PROOF,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ access_token: ACCESS_TOKEN, api_audience: API_AUDIENCE });
    },
  });
  assert.deepEqual(parsed, {
    baseUrl: API_AUDIENCE,
    apiAudience: API_AUDIENCE,
    accessToken: ACCESS_TOKEN,
    deviceProof: DEVICE_PROOF,
    requestTimeoutMs: 2500,
  });
  assert.equal(calls[0].url, "https://bus.example/api/v1/hermes/desktop-pairing/consume");
  assert.deepEqual(calls[0].init.headers, {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "ironwrap-hermes-desktop-mcp/0.2.0",
    "x-ironwrap-hermes-api-audience": API_AUDIENCE,
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    token: PAIRING_TOKEN,
    device_proof: DEVICE_PROOF,
    device_name: "IronWrap Hermes Desktop",
    api_audience: API_AUDIENCE,
    connector_capabilities: [],
  });
});

test("desktop MCP sends one canonical bounded connector declaration", async () => {
  const calls = [];
  await resolveDesktopConfigFromEnv({
    IRONWRAP_BUS_BASE_URL: API_AUDIENCE,
    IRONWRAP_HERMES_DESKTOP_PAIRING_URL:
      `${API_AUDIENCE}/auth/hermes-pair#token=${PAIRING_TOKEN}`,
    IRONWRAP_HERMES_CONNECTOR_CAPABILITIES_JSON: JSON.stringify([
      { provider: "teams", operations: ["search", "list"] },
      { provider: "gmail", operations: ["read", "list"] },
    ]),
  }, {
    createDeviceProof: () => DEVICE_PROOF,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ access_token: ACCESS_TOKEN, api_audience: API_AUDIENCE });
    },
  });

  assert.deepEqual(JSON.parse(calls[0].init.body).connector_capabilities, [
    { provider: "gmail", operations: ["list", "read"] },
    { provider: "teams", operations: ["list", "search"] },
  ]);
});

test("desktop MCP rejects invalid or mutating connector declarations before proof or fetch", async () => {
  for (const declaration of [
    "not-json",
    JSON.stringify([{ provider: "gmail", operations: ["read", "send"] }]),
    JSON.stringify([{ provider: "gmail", operations: ["read"], token: "must-not-leak" }]),
    JSON.stringify([
      { provider: "gmail", operations: ["read"] },
      { provider: "gmail", operations: ["search"] },
    ]),
    JSON.stringify([{ provider: "teams", operations: ["read", "read"] }]),
  ]) {
    let proofCalls = 0;
    let fetchCalls = 0;
    await assert.rejects(
      () => resolveDesktopConfigFromEnv({
        IRONWRAP_BUS_BASE_URL: API_AUDIENCE,
        IRONWRAP_HERMES_DESKTOP_PAIRING_URL:
          `${API_AUDIENCE}/auth/hermes-pair#token=${PAIRING_TOKEN}`,
        IRONWRAP_HERMES_CONNECTOR_CAPABILITIES_JSON: declaration,
      }, {
        createDeviceProof: () => {
          proofCalls += 1;
          return DEVICE_PROOF;
        },
        fetcher: async () => {
          fetchCalls += 1;
          return Response.json({ access_token: ACCESS_TOKEN, api_audience: API_AUDIENCE });
        },
      }),
      (caught) => {
        assert.equal(
          caught.message,
          "IRONWRAP_HERMES_CONNECTOR_CAPABILITIES_JSON must declare bounded read-only connector capabilities",
        );
        assert.doesNotMatch(
          caught.message,
          new RegExp(`must-not-leak|${PAIRING_TOKEN}|${ACCESS_TOKEN}|${DEVICE_PROOF}`),
        );
        return true;
      },
    );
    assert.equal(proofCalls, 0);
    assert.equal(fetchCalls, 0);
  }
});

test("desktop MCP rejects pairing URL confusion before proof generation or fetch", async () => {
  const cases = [
    {
      baseUrl: API_AUDIENCE,
      pairingUrl: `https://app.example/auth/hermes-pair#token=${PAIRING_TOKEN}`,
      error: /same normalized origin/,
    },
    {
      baseUrl: "https://bus.example:8443",
      pairingUrl: `https://bus.example/auth/hermes-pair#token=${PAIRING_TOKEN}`,
      error: /same normalized origin/,
    },
    {
      baseUrl: API_AUDIENCE,
      pairingUrl: `https://bus.example/auth/hermes-pair/#token=${PAIRING_TOKEN}`,
      error: /exact fragment-only/,
    },
    {
      baseUrl: API_AUDIENCE,
      pairingUrl: `https://bus.example/auth/unused/../hermes-pair#token=${PAIRING_TOKEN}`,
      error: /exact fragment-only/,
    },
    {
      baseUrl: API_AUDIENCE,
      pairingUrl: `https://bus.example/auth/hermes-pair?source=copy#token=${PAIRING_TOKEN}`,
      error: /exact fragment-only/,
    },
    {
      baseUrl: API_AUDIENCE,
      pairingUrl: `https://bus.example/auth/hermes-pair#token=${PAIRING_TOKEN}&`,
      error: /one fragment token/,
    },
    {
      baseUrl: API_AUDIENCE,
      pairingUrl: `https://operator:secret@bus.example/auth/hermes-pair#token=${PAIRING_TOKEN}`,
      error: /exact fragment-only/,
    },
    {
      baseUrl: "http://127.0.0.1:8787",
      pairingUrl: `http://localhost:8787/auth/hermes-pair#token=${PAIRING_TOKEN}`,
      allowInsecureLocal: true,
      error: /same normalized origin/,
    },
  ];

  for (const { baseUrl, pairingUrl, allowInsecureLocal, error } of cases) {
    let proofCalls = 0;
    let fetchCalls = 0;
    await assert.rejects(
      () => resolveDesktopConfigFromEnv({
        IRONWRAP_BUS_BASE_URL: baseUrl,
        IRONWRAP_BUS_ALLOW_INSECURE_LOCAL: allowInsecureLocal ? "true" : undefined,
        IRONWRAP_HERMES_DESKTOP_PAIRING_URL: pairingUrl,
      }, {
        createDeviceProof: () => {
          proofCalls += 1;
          return DEVICE_PROOF;
        },
        fetcher: async () => {
          fetchCalls += 1;
          return Response.json({ access_token: ACCESS_TOKEN, api_audience: baseUrl });
        },
      }),
      (caught) => {
        assert.match(caught.message, error);
        assert.doesNotMatch(caught.message, new RegExp(PAIRING_TOKEN));
        return true;
      },
    );
    assert.equal(proofCalls, 0);
    assert.equal(fetchCalls, 0);
  }
});

test("desktop MCP rejects mixed credential modes before proof generation or fetch", async () => {
  for (const credentials of [
    { IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN },
    { IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF },
    {
      IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN: ACCESS_TOKEN,
      IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF: DEVICE_PROOF,
    },
  ]) {
    let proofCalls = 0;
    let fetchCalls = 0;
    await assert.rejects(
      () => resolveDesktopConfigFromEnv({
        IRONWRAP_BUS_BASE_URL: API_AUDIENCE,
        IRONWRAP_HERMES_DESKTOP_PAIRING_URL:
          `${API_AUDIENCE}/auth/hermes-pair#token=${PAIRING_TOKEN}`,
        ...credentials,
      }, {
        createDeviceProof: () => {
          proofCalls += 1;
          return DEVICE_PROOF;
        },
        fetcher: async () => {
          fetchCalls += 1;
          return Response.json({ access_token: ACCESS_TOKEN, api_audience: API_AUDIENCE });
        },
      }),
      (caught) => {
        assert.match(caught.message, /mixed credential modes/);
        assert.doesNotMatch(
          caught.message,
          new RegExp(`${PAIRING_TOKEN}|${ACCESS_TOKEN}|${DEVICE_PROOF}`),
        );
        return true;
      },
    );
    assert.equal(proofCalls, 0);
    assert.equal(fetchCalls, 0);
  }
});

test("desktop MCP rejects pairing audience mismatch without accepting the response token", async () => {
  const responseToken = "z".repeat(43);
  await assert.rejects(
    () => resolveDesktopConfigFromEnv({
      IRONWRAP_BUS_BASE_URL: API_AUDIENCE,
      IRONWRAP_HERMES_DESKTOP_PAIRING_URL:
        `${API_AUDIENCE}/auth/hermes-pair#token=${PAIRING_TOKEN}`,
    }, {
      createDeviceProof: () => DEVICE_PROOF,
      fetcher: async () => Response.json({
        access_token: responseToken,
        api_audience: "https://other.example",
      }),
    }),
    (caught) => {
      assert.equal(caught.message, "hermes_desktop_pairing_api_audience_mismatch");
      assert.doesNotMatch(caught.message, new RegExp(responseToken));
      return true;
    },
  );
});

test("desktop MCP pairing refuses redirects without following or leaking credentials", async () => {
  const calls = [];
  await assert.rejects(
    () => resolveDesktopConfigFromEnv({
      IRONWRAP_BUS_BASE_URL: API_AUDIENCE,
      IRONWRAP_HERMES_DESKTOP_PAIRING_URL:
        `${API_AUDIENCE}/auth/hermes-pair#token=${PAIRING_TOKEN}`,
    }, {
      createDeviceProof: () => DEVICE_PROOF,
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return Response.redirect("https://redirect.example/capture", 302);
      },
    }),
    (caught) => {
      assert.equal(caught.message, "hermes_desktop_pairing_redirect");
      assert.doesNotMatch(caught.message, new RegExp(`${PAIRING_TOKEN}|${DEVICE_PROOF}`));
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_AUDIENCE}/api/v1/hermes/desktop-pairing/consume`);
  assert.equal(calls[0].init.redirect, "error");
});

test("desktop tool schemas enforce strict inputs, bounds, hashes, slots, and calendar provenance", () => {
  const tools = buildDesktopServer(config)._registeredTools;
  const next = tools.hermes_next_tasks.inputSchema;
  assert.equal(next.safeParse({}).success, true);
  assert.equal(next.safeParse({ limit: 1 }).success, false);
  assert.equal(next.safeParse({ admin_token: "no" }).success, false);

  const stage = tools.hermes_stage_context.inputSchema;
  const validStage = {
    envelope_id: ENVELOPE_ID,
    context_sha256: CONTEXT_SHA256,
    observations: [observation],
    calendar_slots: [],
  };
  assert.equal(stage.safeParse(validStage).success, true);
  assert.equal(stage.safeParse({ ...validStage, context_sha256: "A".repeat(64) }).success, false);
  assert.equal(stage.safeParse({ ...validStage, observations: [] }).success, true);
  assert.equal(stage.safeParse({
    ...validStage,
    observations: [{ ...observation, provider: "unknown" }],
  }).success, false);
  assert.equal(stage.safeParse({ ...validStage, send: true }).success, false);
  assert.equal(stage.safeParse({
    ...validStage,
    calendar_slots: [{
      slot_id: "slot-1",
      start: "2026-08-11T09:00:00-06:00",
      end: "2026-08-11T10:00:00-06:00",
      time_zone: "America/Edmonton",
    }],
  }).success, false);
  assert.equal(stage.safeParse({
    ...validStage,
    observations: [{ ...observation, provider: "google_calendar" }],
    calendar_slots: [{
      slot_id: "slot-1",
      start: "2026-08-11T09:00:00-06:00",
      end: "2026-08-11T10:00:00-06:00",
      time_zone: "America/Edmonton",
    }],
  }).success, true);
  assert.equal(stage.safeParse({
    ...validStage,
    observations: [{ ...observation, provider: "outlook_calendar" }],
    calendar_slots: [{
      slot_id: "slot-2",
      start: "2026-08-11T09:00:00-06:00",
      end: "2026-08-11T10:00:00-06:00",
      time_zone: "America/Edmonton",
    }],
  }).success, true);
  for (const provider of ["outlook", "calendar", "drive"])
    assert.equal(stage.safeParse({
      ...validStage,
      observations: [{ ...observation, provider }],
    }).success, false);

  const submit = tools.hermes_submit_draft.inputSchema;
  const validSubmit = {
    idempotency_key: "draft:1",
    envelope_id: ENVELOPE_ID,
    context_sha256: CONTEXT_SHA256,
    provider_request_sha256: PROVIDER_REQUEST_SHA256,
    output: {
      subject: "",
      body: "Draft only",
      suggested_slot_ids: [],
      fact_refs: ["lead.display_name"],
      observation_refs: [],
    },
  };
  assert.equal(submit.safeParse(validSubmit).success, true);
  assert.equal(submit.safeParse({
    ...validSubmit,
    output: { ...validSubmit.output, send: true },
  }).success, false);
  assert.equal(submit.safeParse({
    ...validSubmit,
    output: { ...validSubmit.output, body: " ".repeat(10) },
  }).success, false);
  assert.equal(submit.safeParse({
    ...validSubmit,
    output: { ...validSubmit.output, suggested_slot_ids: ["a", "b", "c", "d"] },
  }).success, false);
  assert.equal(submit.safeParse({
    ...validSubmit,
    output: { ...validSubmit.output, suggested_slot_ids: ["slot-1", "slot-1"] },
  }).success, false);
  for (const missing of ["idempotency_key", "provider_request_sha256"]) {
    const incomplete = { ...validSubmit };
    delete incomplete[missing];
    assert.equal(submit.safeParse(incomplete).success, false);
  }
  assert.equal(submit.safeParse({
    ...validSubmit,
    output: { ...validSubmit.output, fact_refs: ["lead.name", "lead.name"] },
  }).success, false);
  assert.equal(submit.safeParse({ ...validSubmit, idempotency_key: "_draft:1" }).success, false);
});

test("desktop tools use only desktop auth headers and the exact Worker paths", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, url }), {
      headers: { "content-type": "application/json" },
    });
  });
  const tools = buildDesktopServer({
    ...config,
    adminToken: "admin-secret",
    writeToken: "write-secret",
    connectorToken: "connector-secret",
  })._registeredTools;

  await tools.hermes_next_tasks.handler({});
  await tools.hermes_stage_context.handler({
    envelope_id: ENVELOPE_ID,
    context_sha256: CONTEXT_SHA256,
    observations: [observation],
    calendar_slots: [],
  });
  await tools.hermes_submit_draft.handler({
    idempotency_key: "draft:1",
    envelope_id: ENVELOPE_ID,
    context_sha256: CONTEXT_SHA256,
    provider_request_sha256: PROVIDER_REQUEST_SHA256,
    output: {
      subject: "Estimate",
      body: "Draft only",
      suggested_slot_ids: [],
      fact_refs: ["lead.display_name"],
      observation_refs: [],
    },
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    "https://bus.example/api/v1/hermes/next-tasks",
    "https://bus.example/api/v1/hermes/stage-context",
    "https://bus.example/api/v1/hermes/submit-draft",
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.deepEqual(init.headers, {
      accept: "application/json",
      authorization: `Bearer ${ACCESS_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "ironwrap-hermes-desktop-mcp/0.2.0",
      "x-ironwrap-hermes-api-audience": API_AUDIENCE,
      "x-ironwrap-hermes-device-proof": DEVICE_PROOF,
    });
    assert.doesNotMatch(JSON.stringify(init), /admin-secret|write-secret|connector-secret/);
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    envelope_id: ENVELOPE_ID,
    context_sha256: CONTEXT_SHA256,
    observations: [observation],
    calendar_slots: [],
  });
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    idempotency_key: "draft:1",
    envelope_id: ENVELOPE_ID,
    context_sha256: CONTEXT_SHA256,
    provider_request_sha256: PROVIDER_REQUEST_SHA256,
    output: {
      subject: "Estimate",
      body: "Draft only",
      suggested_slot_ids: [],
      fact_refs: ["lead.display_name"],
      observation_refs: [],
    },
  });
});

test("desktop tool responses are text JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ tasks: [{ id: 1 }] }), {
    headers: { "content-type": "application/json" },
  }));
  const result = await buildDesktopServer(config)._registeredTools.hermes_next_tasks.handler({});
  assert.deepEqual(result, {
    content: [{ type: "text", text: JSON.stringify({ tasks: [{ id: 1 }] }, null, 2) }],
  });
});

test("desktop requests preserve bounded Worker error codes without leaking response bodies", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    error: "invalid_device_proof",
    detail: `do not leak ${ACCESS_TOKEN}`,
  }), { status: 401 }));
  await assert.rejects(
    () => hermesDesktopRequest(config, "/api/v1/hermes/next-tasks", {}),
    (error) => {
      assert.equal(error.message, "hermes_desktop_http_401:invalid_device_proof");
      assert.doesNotMatch(error.message, new RegExp(ACCESS_TOKEN));
      return true;
    },
  );

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response("not json", { status: 500 }));
  await assert.rejects(
    () => hermesDesktopRequest(config, "/api/v1/hermes/next-tasks", {}),
    /hermes_desktop_http_500:request_failed/,
  );
});

test("desktop requests fail closed on invalid JSON, timeouts, and unapproved paths", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not json", { status: 200 }));
  await assert.rejects(
    () => hermesDesktopRequest(config, "/api/v1/hermes/next-tasks", {}),
    /hermes_desktop_invalid_json/,
  );

  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async (_url, init) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  }));
  await assert.rejects(
    () => hermesDesktopRequest({ ...config, requestTimeoutMs: 10 }, "/api/v1/hermes/next-tasks", {}),
    /hermes_desktop_request_timeout/,
  );
  await assert.rejects(
    () => hermesDesktopRequest(config, "/admin/replay", {}),
    /hermes_desktop_path_not_allowed/,
  );
});

test("desktop requests require the exact configured audience before fetch", async (t) => {
  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    return Response.json({ ok: true });
  });

  for (const invalidConfig of [
    { ...config, apiAudience: undefined },
    { ...config, apiAudience: "https://other.example" },
    { ...config, baseUrl: `${API_AUDIENCE}/api`, apiAudience: `${API_AUDIENCE}/api` },
  ]) {
    await assert.rejects(
      () => hermesDesktopRequest(invalidConfig, "/api/v1/hermes/next-tasks", {}),
      /hermes_desktop_api_audience_mismatch/,
    );
  }
  assert.equal(fetchCalls, 0);
});

test("desktop requests refuse redirects without following or leaking credentials", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return Response.redirect("https://redirect.example/capture", 302);
  });

  await assert.rejects(
    () => hermesDesktopRequest(config, "/api/v1/hermes/next-tasks", {}),
    (caught) => {
      assert.equal(caught.message, "hermes_desktop_redirect");
      assert.doesNotMatch(caught.message, new RegExp(`${ACCESS_TOKEN}|${DEVICE_PROOF}`));
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${API_AUDIENCE}/api/v1/hermes/next-tasks`);
  assert.equal(calls[0].init.redirect, "error");
});
