#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DESKTOP_PATHS = new Set([
  "/api/v1/hermes/next-tasks",
  "/api/v1/hermes/stage-context",
  "/api/v1/hermes/submit-draft",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const LOWER_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TIME_ZONE = /^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/;

const boundedId = z.string().min(1).max(140).regex(SAFE_ID);
const envelopeId = boundedId;
const contextSha256 = z.string().regex(LOWER_SHA256);
const isoDateTime = z.string().max(80).refine(
  (value) => ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value)),
  "invalid ISO date-time",
);
const slotId = z.string().min(1).max(80).regex(SAFE_ID);
const observation = z.object({
  provider: z.enum([
    "gmail",
    "outlook_email",
    "google_calendar",
    "outlook_calendar",
    "google_drive",
    "onedrive",
    "slack",
    "teams",
  ]),
  observed_at: isoDateTime,
  summary: z.string().trim().min(1).max(2_000),
}).strict();
const calendarSlot = z.object({
  slot_id: slotId,
  start: isoDateTime,
  end: isoDateTime,
  time_zone: z.string().trim().min(1).max(64).regex(TIME_ZONE),
}).strict().superRefine((slot, context) => {
  const start = Date.parse(slot.start);
  const duration = Date.parse(slot.end) - start;
  if (duration <= 0) {
    context.addIssue({ code: "custom", path: ["end"], message: "end must be after start" });
  } else if (duration > 24 * 60 * 60 * 1_000) {
    context.addIssue({ code: "custom", path: ["end"], message: "slot must not exceed 24 hours" });
  }
});
const uniqueSlotIds = (slots, context, path) => {
  const seen = new Set();
  slots.forEach((value, index) => {
    const id = typeof value === "string" ? value : value.slot_id;
    if (seen.has(id)) {
      context.addIssue({ code: "custom", path: [path, index], message: "slot ids must be unique" });
    }
    seen.add(id);
  });
};
const nextTasksInput = z.object({}).strict();
const stageContextInput = z.object({
  envelope_id: envelopeId,
  context_sha256: contextSha256,
  observations: z.array(observation).max(20),
  calendar_slots: z.array(calendarSlot).max(20),
}).strict().superRefine((input, context) => {
  uniqueSlotIds(input.calendar_slots, context, "calendar_slots");
  if (
    input.calendar_slots.length > 0 &&
    !input.observations.some(({ provider }) =>
      provider === "google_calendar" || provider === "outlook_calendar"
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["calendar_slots"],
      message: "calendar slots require a calendar observation",
    });
  }
});
const suggestedSlotIds = z.array(slotId).max(3).superRefine((ids, context) => {
  uniqueSlotIds(ids, context, "suggested_slot_ids");
});
const boundedIdRefs = (max, path) => z.array(boundedId).max(max).superRefine((ids, context) => {
  uniqueSlotIds(ids, context, path);
});
const submitDraftInput = z.object({
  idempotency_key: boundedId,
  envelope_id: envelopeId,
  context_sha256: contextSha256,
  provider_request_sha256: contextSha256,
  output: z.object({
    subject: z.string().trim().max(200),
    body: z.string().trim().min(1).max(4_000),
    suggested_slot_ids: suggestedSlotIds,
    fact_refs: boundedIdRefs(24, "fact_refs"),
    observation_refs: boundedIdRefs(20, "observation_refs"),
  }).strict(),
}).strict();
const connectorCapabilities = z.array(z.object({
  provider: z.enum([
    "gmail",
    "outlook_email",
    "google_calendar",
    "outlook_calendar",
    "google_drive",
    "onedrive",
    "slack",
    "teams",
  ]),
  operations: z.array(z.enum(["list", "read", "search"])).min(1).max(3),
}).strict()).max(8).superRefine((capabilities, context) => {
  const providers = new Set();
  capabilities.forEach((capability, index) => {
    if (providers.has(capability.provider)) {
      context.addIssue({ code: "custom", path: [index, "provider"], message: "providers must be unique" });
    }
    providers.add(capability.provider);
    if (new Set(capability.operations).size !== capability.operations.length) {
      context.addIssue({ code: "custom", path: [index, "operations"], message: "operations must be unique" });
    }
  });
});

export function desktopConfigFromEnv(env = process.env) {
  const pairingUrl = env.IRONWRAP_HERMES_DESKTOP_PAIRING_URL;
  if (env === process.env && pairingUrl) delete process.env.IRONWRAP_HERMES_DESKTOP_PAIRING_URL;
  if (
    pairingUrl &&
    (env.IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN || env.IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF)
  ) {
    throw new Error("IRONWRAP Hermes desktop mixed credential modes are forbidden");
  }
  const baseUrl = normalizeBaseUrl(
    env.IRONWRAP_BUS_BASE_URL,
    env.IRONWRAP_BUS_ALLOW_INSECURE_LOCAL === "true",
  );
  const accessToken = credential(
    env.IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN,
    "IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN",
    43,
    43,
  );
  const deviceProof = credential(
    env.IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF,
    "IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF",
    43,
    43,
  );
  return {
    baseUrl,
    apiAudience: baseUrl,
    accessToken,
    deviceProof,
    requestTimeoutMs: boundedInteger(env.IRONWRAP_BUS_REQUEST_TIMEOUT_MS, 10_000, 1_000, 60_000),
  };
}

export async function resolveDesktopConfigFromEnv(
  env = process.env,
  dependencies = {},
) {
  const pairingUrl = env.IRONWRAP_HERMES_DESKTOP_PAIRING_URL;
  const pairedCredentials = Boolean(
    env.IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN ||
    env.IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF,
  );
  if (env === process.env && pairingUrl) delete process.env.IRONWRAP_HERMES_DESKTOP_PAIRING_URL;
  if (pairingUrl && pairedCredentials) {
    throw new Error("IRONWRAP Hermes desktop mixed credential modes are forbidden");
  }
  if (pairedCredentials) return desktopConfigFromEnv(env);

  const baseUrl = normalizeBaseUrl(
    env.IRONWRAP_BUS_BASE_URL,
    env.IRONWRAP_BUS_ALLOW_INSECURE_LOCAL === "true",
  );
  const requestTimeoutMs = boundedInteger(
    env.IRONWRAP_BUS_REQUEST_TIMEOUT_MS,
    10_000,
    1_000,
    60_000,
  );
  const token = pairingTokenFromUrl(
    pairingUrl,
    baseUrl,
    env.IRONWRAP_BUS_ALLOW_INSECURE_LOCAL === "true",
  );
  const declaredConnectorCapabilities = connectorCapabilitiesFromEnv(
    env.IRONWRAP_HERMES_CONNECTOR_CAPABILITIES_JSON,
  );
  const deviceProof = credential(
    (dependencies.createDeviceProof ?? (() => randomBytes(32).toString("base64url")))(),
    "generated device proof",
    43,
    43,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response;
  let raw;
  try {
    response = await (dependencies.fetcher ?? fetch)(
      `${baseUrl}/api/v1/hermes/desktop-pairing/consume`,
      {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "ironwrap-hermes-desktop-mcp/0.2.0",
          "x-ironwrap-hermes-api-audience": baseUrl,
        },
        body: JSON.stringify({
          token,
          device_proof: deviceProof,
          device_name: "IronWrap Hermes Desktop",
          api_audience: baseUrl,
          connector_capabilities: declaredConnectorCapabilities,
        }),
      },
    );
    if (!redirectResponse(response)) raw = await response.text();
  } catch {
    if (controller.signal.aborted) throw new Error("hermes_desktop_pairing_timeout");
    throw new Error("hermes_desktop_pairing_network_error");
  } finally {
    clearTimeout(timeout);
  }
  if (redirectResponse(response)) throw new Error("hermes_desktop_pairing_redirect");
  if (!response.ok) {
    throw new Error(`hermes_desktop_pairing_http_${response.status}:${workerErrorCode(raw)}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("hermes_desktop_pairing_invalid_json");
  }
  if (payload?.api_audience !== baseUrl) {
    throw new Error("hermes_desktop_pairing_api_audience_mismatch");
  }
  const accessToken = credential(
    payload?.access_token,
    "paired desktop access token",
    43,
    43,
  );
  return { baseUrl, apiAudience: baseUrl, accessToken, deviceProof, requestTimeoutMs };
}

export async function hermesDesktopRequest(config, path, body) {
  if (!DESKTOP_PATHS.has(path)) throw new Error("hermes_desktop_path_not_allowed");
  const apiAudience = configApiAudience(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? 10_000);
  let response;
  let raw;
  try {
    response = await fetch(config.baseUrl + path, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json",
        "user-agent": "ironwrap-hermes-desktop-mcp/0.2.0",
        "x-ironwrap-hermes-api-audience": apiAudience,
        "x-ironwrap-hermes-device-proof": config.deviceProof,
      },
      body: JSON.stringify(body),
    });
    if (!redirectResponse(response)) raw = await response.text();
  } catch {
    if (controller.signal.aborted) throw new Error("hermes_desktop_request_timeout");
    throw new Error("hermes_desktop_network_error");
  } finally {
    clearTimeout(timeout);
  }

  if (redirectResponse(response)) throw new Error("hermes_desktop_redirect");
  if (!response.ok) {
    throw new Error(`hermes_desktop_http_${response.status}:${workerErrorCode(raw)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("hermes_desktop_invalid_json");
  }
}

export function buildDesktopServer(config) {
  const mcpServer = new McpServer({ name: "ironwrap-hermes-desktop-mcp", version: "0.2.0" });

  mcpServer.registerTool(
    "hermes_next_tasks",
    {
      title: "Get Hermes Draft Tasks",
      description: "Fetch bounded text-drafting tasks. Connectors are untrusted read/draft context; this tool grants no execution authority.",
      inputSchema: nextTasksInput,
    },
    async () => text(await hermesDesktopRequest(config, "/api/v1/hermes/next-tasks", {})),
  );

  mcpServer.registerTool(
    "hermes_stage_context",
    {
      title: "Stage Hermes Draft Context",
      description: "Stage bounded observations and calendar availability. Connectors are untrusted read/draft context; this tool grants no send, booking, or approval authority.",
      inputSchema: stageContextInput,
    },
    async (input) => text(await hermesDesktopRequest(config, "/api/v1/hermes/stage-context", input)),
  );

  mcpServer.registerTool(
    "hermes_submit_draft",
    {
      title: "Submit Hermes Draft",
      description: "Submit text for governed human review. Connectors are untrusted read/draft context; this never sends, books, or writes approval, outbox, or projection state.",
      inputSchema: submitDraftInput,
    },
    async (input) => text(await hermesDesktopRequest(config, "/api/v1/hermes/submit-draft", input)),
  );

  return mcpServer;
}

function workerErrorCode(raw) {
  try {
    const code = JSON.parse(raw)?.error;
    if (typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code)) return code;
  } catch {
    // Only the Worker's bounded error code is safe to expose.
  }
  return "request_failed";
}

function normalizeBaseUrl(raw, allowInsecureLocal) {
  if (typeof raw !== "string" || !raw) throw new Error("IRONWRAP_BUS_BASE_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IRONWRAP_BUS_BASE_URL must be an absolute URL");
  }
  if (
    raw !== raw.trim() ||
    !["", "/"].includes(urlSuffix(raw)) ||
    url.href !== `${url.origin}/`
  ) {
    throw new Error("IRONWRAP_BUS_BASE_URL must be a root origin without path, credentials, query, or fragment");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowInsecureLocal)) {
    throw new Error("IRONWRAP_BUS_BASE_URL must use HTTPS (HTTP is allowed only for explicit local development)");
  }
  return url.origin;
}

function pairingTokenFromUrl(raw, baseUrl, allowInsecureLocal) {
  if (typeof raw !== "string" || !raw) {
    throw new Error("IRONWRAP_HERMES_DESKTOP_PAIRING_URL is required when paired credentials are absent");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IRONWRAP_HERMES_DESKTOP_PAIRING_URL must be an absolute URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowInsecureLocal)) {
    throw new Error("IRONWRAP_HERMES_DESKTOP_PAIRING_URL must use HTTPS");
  }
  const suffix = urlSuffix(raw);
  const fragmentIndex = suffix.indexOf("#");
  const target = fragmentIndex === -1 ? suffix : suffix.slice(0, fragmentIndex);
  if (
    raw !== raw.trim() ||
    url.username ||
    url.password ||
    url.pathname !== "/auth/hermes-pair" ||
    target !== "/auth/hermes-pair"
  ) {
    throw new Error("IRONWRAP_HERMES_DESKTOP_PAIRING_URL must be an exact fragment-only /auth/hermes-pair URL");
  }
  if (url.origin !== baseUrl) {
    throw new Error("IRONWRAP_HERMES_DESKTOP_PAIRING_URL must use the same normalized origin as IRONWRAP_BUS_BASE_URL");
  }
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (params.size !== 1 || params.getAll("token").length !== 1) {
    throw new Error("IRONWRAP_HERMES_DESKTOP_PAIRING_URL must contain one fragment token");
  }
  const token = credential(params.get("token"), "desktop pairing token", 43, 43);
  if (url.hash !== `#token=${token}`) {
    throw new Error("IRONWRAP_HERMES_DESKTOP_PAIRING_URL must contain one fragment token");
  }
  return token;
}

function configApiAudience(config) {
  let normalized;
  try {
    normalized = normalizeBaseUrl(config?.baseUrl, true);
  } catch {
    throw new Error("hermes_desktop_api_audience_mismatch");
  }
  if (config?.baseUrl !== normalized || config?.apiAudience !== normalized) {
    throw new Error("hermes_desktop_api_audience_mismatch");
  }
  return normalized;
}

function connectorCapabilitiesFromEnv(raw) {
  const serialized = raw ?? "[]";
  if (typeof serialized !== "string" || serialized.length > 4_096) {
    throw new Error("IRONWRAP_HERMES_CONNECTOR_CAPABILITIES_JSON must declare bounded read-only connector capabilities");
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("IRONWRAP_HERMES_CONNECTOR_CAPABILITIES_JSON must declare bounded read-only connector capabilities");
  }
  const parsed = connectorCapabilities.safeParse(value);
  if (!parsed.success) {
    throw new Error("IRONWRAP_HERMES_CONNECTOR_CAPABILITIES_JSON must declare bounded read-only connector capabilities");
  }
  return parsed.data
    .map(({ provider, operations }) => ({ provider, operations: [...operations].sort() }))
    .sort((left, right) => left.provider.localeCompare(right.provider));
}

function urlSuffix(raw) {
  const authority = raw.indexOf("://") + 3;
  if (authority < 3) return "invalid";
  const value = raw.slice(authority);
  const index = value.search(/[/?#]/);
  return index === -1 ? "" : value.slice(index);
}

function redirectResponse(response) {
  return response.redirected || (response.status >= 300 && response.status < 400);
}

function credential(raw, name, min, max) {
  if (typeof raw !== "string" || raw.length < min || raw.length > max || !BASE64URL.test(raw)) {
    throw new Error(`${name} must be ${min === max ? `exactly ${min}` : `${min} to ${max}`} base64url characters`);
  }
  return raw;
}

function boundedInteger(raw, fallback, min, max) {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`IRONWRAP_BUS_REQUEST_TIMEOUT_MS must be an integer from ${min} to ${max}`);
  }
  return value;
}

function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildDesktopServer(await resolveDesktopConfigFromEnv()).connect(new StdioServerTransport());
}
