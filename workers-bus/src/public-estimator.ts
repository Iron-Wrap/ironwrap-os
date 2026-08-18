import { normalizeEmail, normalizePhone } from "./core.ts";
import { handleEstimateIngest } from "./estimates.ts";
import * as store from "./store.ts";

const MAX_BODY_BYTES = 32 * 1024;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_DISCLAIMER = "This request does not produce an online price. An estimator must verify measurements, access, materials, and approved pricing before any quote, scope, schedule, material, or payment commitment.";
const PUBLIC_ESTIMATE_SERVICES = new Set(["roofing", "metal_roofing", "siding", "gutters", "soffit_fascia"]);
const PUBLIC_ESTIMATE_PROVINCES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);

/**
 * Public browser contract (v2):
 *
 * POST /public/instant-estimate
 * {
 *   brand, service,
 *   contact: { name, email?, phone? },
 *   property: { address, city?, province?, postal_code? },
 *   consent: { contact: true, privacy: true },
 *   turnstile_token, client_submission_id
 * }
 *
 * The response intentionally contains only acceptance, an opaque envelope id,
 * the fixed no-online-price disclaimer, and review state. It never reflects
 * submitted contact/address data or claims a price without measurement evidence.
 */
export type PublicEstimatorEnv = Env & {
  PUBLIC_ESTIMATE_ENABLED?: string;
  PUBLIC_ESTIMATE_ALLOWED_ORIGINS?: string;
  PUBLIC_ESTIMATE_ALLOWED_BRANDS?: string;
  PUBLIC_ESTIMATE_CONSENT_JURISDICTION?: string;
  PUBLIC_ESTIMATE_ALLOW_INSECURE_LOCAL?: string;
  PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY?: string;
  PUBLIC_ESTIMATE_TURNSTILE_SECRET?: string;
  PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER?: string;
  PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS?: string;
  PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX?: string;
  PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX?: string;
  PUBLIC_ESTIMATE_RANGE_RULES_JSON?: string;
  ERPNEXT_ENABLED?: string;
  ERPNEXT_INTEGRATION_USER?: string;
};

interface RateLimitConfig {
  windowSeconds: number;
  ipMax: number;
  clientMax: number;
}

interface PublicEstimateConfig {
  activated: boolean;
  ready: boolean;
  allowedOrigins: Set<string>;
  allowedBrands: Set<string>;
  consentJurisdiction: string | null;
  siteKey: string | null;
  turnstileSecret: string | null;
  rateLimitPepper: string | null;
  rateLimit: RateLimitConfig | null;
}

interface PublicEstimateInput {
  brand: string;
  service: string;
  contact: { name: string; email: string | null; phone: string | null };
  property: { address: string; city: string | null; province: string | null; postalCode: string | null };
  clientSubmissionId: string;
}

interface ExistingPublicEstimate {
  fingerprint: string;
}

export interface PublicEstimatorDependencies {
  fetch?: typeof fetch;
  ingest?: typeof handleEstimateIngest;
  now?: () => Date;
}

export async function handlePublicInstantEstimate(
  req: Request,
  env: PublicEstimatorEnv,
  dependencies: PublicEstimatorDependencies = {},
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const isConfig = path === "/public/instant-estimate/config";
  const isSubmission = path === "/public/instant-estimate";
  if (!isConfig && !isSubmission) return publicJson({ error: "not_found" }, 404);

  const origin = validateOrigin(req, env, req.method === "POST" || req.method === "OPTIONS");
  if (!origin.ok) return publicJson({ error: "origin_not_allowed" }, 403);
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), origin.origin);

  const config = publicEstimateConfiguration(env);
  if (isConfig && req.method === "GET") {
    return withCors(publicJson({
      enabled: config.activated && config.ready,
      turnstile_site_key: config.activated && config.ready ? config.siteKey : null,
      range_available: false,
      disclaimer: DEFAULT_DISCLAIMER,
      review_required: true,
    }), origin.origin);
  }
  if (!isSubmission || req.method !== "POST") {
    return withCors(publicJson({ error: "method_not_allowed" }, 405), origin.origin);
  }
  if (!config.activated || !config.ready) {
    return withCors(publicJson({ error: "public_estimate_not_configured" }, 503), origin.origin);
  }

  const parsed = await readInput(req, config.allowedBrands);
  if (!parsed.ok) return withCors(publicJson({ error: parsed.error }, parsed.status), origin.origin);
  const headerKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (headerKey && headerKey.toLowerCase() !== parsed.value.clientSubmissionId) {
    return withCors(publicJson({ error: "idempotency_key_mismatch" }, 400), origin.origin);
  }

  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const fingerprint = await hmacHex(config.rateLimitPepper!, JSON.stringify({
    brand: parsed.value.brand,
    service: parsed.value.service,
    contact: parsed.value.contact,
    property: parsed.value.property,
  }));
  const estimateProjectId = `public:${parsed.value.clientSubmissionId}`;
  let existing: Awaited<ReturnType<typeof store.findEstimateSubmission>>;
  try {
    existing = await store.findEstimateSubmission(env, `estimate:project:${estimateProjectId}`);
  } catch {
    return unavailableResponse(origin.origin);
  }
  if (existing) {
    const prior = existingPublicEstimate(existing.payload_json);
    if (!prior || prior.fingerprint !== fingerprint) {
      return withCors(publicJson({ error: "idempotency_conflict" }, 409), origin.origin);
    }
    // Turnstile tokens are intentionally single-use. A byte-for-byte retry must
    // re-drive the durable mirror without asking the browser for a new token.
    const ingest = dependencies.ingest ?? handleEstimateIngest;
    try {
      const response = await ingest(env, existing.payload_json, "application/json", parsed.value.clientSubmissionId);
      return withCors(await publicIngestResponse(response), origin.origin);
    } catch {
      return unavailableResponse(origin.origin);
    }
  }

  const verified = await verifyTurnstile(
    req,
    config.turnstileSecret!,
    parsed.turnstileToken,
    parsed.value.clientSubmissionId,
    dependencies.fetch ?? fetch,
  );
  if (!verified) return withCors(publicJson({ error: "turnstile_failed" }, 403), origin.origin);

  const windowExpiresAt = new Date(Date.parse(now) + config.rateLimit!.windowSeconds * 1_000).toISOString();
  const ip = requestIp(req);
  const [ipHash, clientHash] = await Promise.all([
    hmacHex(config.rateLimitPepper!, `ip:${ip}`),
    hmacHex(config.rateLimitPepper!, `client:${parsed.value.clientSubmissionId}`),
  ]);
  let ipAllowed: boolean;
  let clientAllowed: boolean;
  try {
    [ipAllowed, clientAllowed] = await Promise.all([
      claimRateLimit(env, "ip", ipHash, now, windowExpiresAt, config.rateLimit!.ipMax),
      claimRateLimit(env, "client", clientHash, now, windowExpiresAt, config.rateLimit!.clientMax),
    ]);
  } catch {
    return unavailableResponse(origin.origin);
  }
  if (!ipAllowed || !clientAllowed) {
    return withCors(publicJson({ error: "rate_limited" }, 429), origin.origin);
  }

  const payload = canonicalPayload(
    parsed.value,
    estimateProjectId,
    fingerprint,
    now,
    origin.origin!,
    config.consentJurisdiction!,
  );
  const ingest = dependencies.ingest ?? handleEstimateIngest;
  try {
    const response = await ingest(env, JSON.stringify(payload), "application/json", parsed.value.clientSubmissionId);
    return withCors(await publicIngestResponse(response), origin.origin);
  } catch {
    return unavailableResponse(origin.origin);
  }
}

/** Disabled is healthy. Once enabled, every public control must be present and valid. */
export function publicEstimateConfigured(env: PublicEstimatorEnv): boolean {
  const config = publicEstimateConfiguration(env);
  return !config.activated || config.ready;
}

/** Expired secondary-abuse hashes have no operational value and are removed daily. */
export async function prunePublicEstimateRateLimits(
  env: PublicEstimatorEnv,
  now = new Date(),
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM public_estimate_rate_limits WHERE window_expires_at <= ?",
  ).bind(now.toISOString()).run();
}

export function publicEstimateConfiguration(env: PublicEstimatorEnv): PublicEstimateConfig {
  const activated = String(env.PUBLIC_ESTIMATE_ENABLED) === "true";
  const allowedOrigins = configuredOrigins(env);
  const allowedBrands = configuredBrands(env);
  const consentJurisdiction = text(env.PUBLIC_ESTIMATE_CONSENT_JURISDICTION, 2, 120);
  const siteKey = nonEmpty(env.PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY);
  const turnstileSecret = nonEmpty(env.PUBLIC_ESTIMATE_TURNSTILE_SECRET);
  const rateLimitPepper = secretAtLeast(env.PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER, 32);
  const rateLimit = rateLimitConfig(env);
  const legacyRangesDisabled = exactEmptyArray(env.PUBLIC_ESTIMATE_RANGE_RULES_JSON);
  const erpConsentMirrorReady = String(env.ERPNEXT_ENABLED) !== "true" || !!nonEmpty(env.ERPNEXT_INTEGRATION_USER);
  return {
    activated,
    ready: activated && allowedOrigins.size > 0 && allowedBrands.size > 0 && !!consentJurisdiction && !!siteKey && !!turnstileSecret &&
      !!rateLimitPepper && !!rateLimit && legacyRangesDisabled && erpConsentMirrorReady,
    allowedOrigins,
    allowedBrands,
    consentJurisdiction,
    siteKey,
    turnstileSecret,
    rateLimitPepper,
    rateLimit,
  };
}

function validateOrigin(
  req: Request,
  env: PublicEstimatorEnv,
  requireOrigin: boolean,
): { ok: true; origin: string | null } | { ok: false } {
  const supplied = req.headers.get("origin");
  if (!supplied) return requireOrigin ? { ok: false } : { ok: true, origin: null };
  const normalized = normalizeOrigin(
    supplied,
    String(env.PUBLIC_ESTIMATE_ALLOW_INSECURE_LOCAL) === "true",
  );
  return normalized && configuredOrigins(env).has(normalized)
    ? { ok: true, origin: normalized }
    : { ok: false };
}

function configuredOrigins(env: PublicEstimatorEnv): Set<string> {
  const allowInsecureLocal = String(env.PUBLIC_ESTIMATE_ALLOW_INSECURE_LOCAL) === "true";
  const result = new Set<string>();
  for (const value of (env.PUBLIC_ESTIMATE_ALLOWED_ORIGINS ?? "").split(",")) {
    const origin = normalizeOrigin(value, allowInsecureLocal);
    if (origin) result.add(origin);
  }
  return result;
}

function configuredBrands(env: PublicEstimatorEnv): Set<string> {
  const result = new Set<string>();
  for (const value of (env.PUBLIC_ESTIMATE_ALLOWED_BRANDS ?? "").split(",")) {
    const brand = selector(value, 80);
    if (brand) result.add(brand);
  }
  return result;
}

function normalizeOrigin(value: string, allowInsecureLocal: boolean): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(allowInsecureLocal && local && url.protocol === "http:")) return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readInput(req: Request, allowedBrands: Set<string>): Promise<
  | { ok: true; value: PublicEstimateInput; turnstileToken: string }
  | { ok: false; error: string; status: number }
> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return { ok: false, error: "payload_too_large", status: 413 };
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return { ok: false, error: "payload_too_large", status: 413 };
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!record(parsed)) throw new Error("not_object");
    body = parsed;
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
  const allowed = new Set([
    "brand", "service", "contact", "property", "consent", "turnstile_token", "client_submission_id",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return { ok: false, error: "unexpected_field", status: 400 };
  }
  const brand = selector(body.brand, 80);
  const service = selector(body.service, 120);
  const contact = parseContact(body.contact);
  const property = parseProperty(body.property);
  const consent = body.consent;
  const turnstileToken = text(body.turnstile_token, 20, 2_048);
  const clientSubmissionId = submissionId(body.client_submission_id);
  if (!brand || !allowedBrands.has(brand) || !service || !PUBLIC_ESTIMATE_SERVICES.has(service) || !contact || !property || !record(consent) || consent.contact !== true || consent.privacy !== true ||
    !turnstileToken || !clientSubmissionId) {
    return { ok: false, error: "invalid_request", status: 400 };
  }
  return {
    ok: true,
    value: { brand, service, contact, property, clientSubmissionId },
    turnstileToken,
  };
}

function parseContact(value: unknown): PublicEstimateInput["contact"] | null {
  if (!record(value) || Object.keys(value).some((key) => !["name", "email", "phone"].includes(key))) return null;
  const name = text(value.name, 2, 120);
  const emailRaw = value.email === undefined ? null : normalizeEmail(value.email);
  const phoneRaw = value.phone === undefined ? null : normalizePhone(value.phone);
  if (!name || (!emailRaw && !phoneRaw)) return null;
  if (value.email !== undefined && !emailRaw) return null;
  if (value.phone !== undefined && !phoneRaw) return null;
  return { name, email: emailRaw, phone: phoneRaw };
}

function parseProperty(value: unknown): PublicEstimateInput["property"] | null {
  if (!record(value) || Object.keys(value).some((key) => !["address", "city", "province", "postal_code"].includes(key))) return null;
  const address = text(value.address, 2, 240);
  const city = optionalText(value.city, 120);
  const province = optionalProvince(value.province);
  const postalCode = optionalText(value.postal_code, 16);
  if (!address || city === undefined || !province || !PUBLIC_ESTIMATE_PROVINCES.has(province) || postalCode === undefined) return null;
  return { address, city, province, postalCode };
}

function canonicalPayload(
  input: PublicEstimateInput,
  estimateProjectId: string,
  fingerprint: string,
  recordedAt: string,
  origin: string,
  jurisdiction: string,
): Record<string, unknown> {
  const publicEstimator = {
    version: 2,
    brand: input.brand,
    service: input.service,
    client_submission_id: input.clientSubmissionId,
    submission_fingerprint: fingerprint,
    property: {
      address: input.property.address,
      ...(input.property.city ? { city: input.property.city } : {}),
      ...(input.property.province ? { province: input.property.province } : {}),
      ...(input.property.postalCode ? { postal_code: input.property.postalCode } : {}),
    },
    consent: {
      contact: true,
      privacy: true,
      recorded_at: recordedAt,
      origin,
    },
    jurisdiction,
    pricing_state: "measurement_required",
    range: null,
    review_required: true,
  };
  return {
    estimate_project_id: estimateProjectId,
    source_detail: "ironwrap_public_estimator",
    instant_estimate: true,
    estimate_type: "review_intake",
    service: input.service,
    selected_services: [input.service],
    customer: input.contact.name,
    ...(input.contact.email ? { email: input.contact.email } : {}),
    ...(input.contact.phone ? { phone: input.contact.phone } : {}),
    address: input.property.address,
    ...(input.property.city ? { city: input.property.city } : {}),
    ...(input.property.province ? { state_text: input.property.province } : {}),
    ...(input.property.postalCode ? { zip: input.property.postalCode } : {}),
    assumptions: DEFAULT_DISCLAIMER,
    exclusions: "Not a final quote, contract, material order, or payment request.",
    public_estimator: publicEstimator,
  };
}

function existingPublicEstimate(payloadJson: string): ExistingPublicEstimate | null {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    if (!record(payload) || !record(payload.public_estimator)) return null;
    const publicEstimator = payload.public_estimator;
    const fingerprint = typeof publicEstimator.submission_fingerprint === "string" &&
      /^[0-9a-f]{64}$/.test(publicEstimator.submission_fingerprint)
      ? publicEstimator.submission_fingerprint
      : null;
    if (!fingerprint || publicEstimator.version !== 2 ||
      publicEstimator.pricing_state !== "measurement_required" ||
      publicEstimator.range !== null || publicEstimator.review_required !== true) return null;
    return { fingerprint };
  } catch {
    return null;
  }
}

function exactEmptyArray(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

function rateLimitConfig(env: PublicEstimatorEnv): RateLimitConfig | null {
  const windowSeconds = positiveInteger(env.PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS, 60, 3_600);
  const ipMax = positiveInteger(env.PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX, 1, 100);
  const clientMax = positiveInteger(env.PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX, 1, 20);
  return windowSeconds && ipMax && clientMax ? { windowSeconds, ipMax, clientMax } : null;
}

async function verifyTurnstile(
  req: Request,
  secret: string,
  token: string,
  idempotencyKey: string,
  requestFetch: typeof fetch,
): Promise<boolean> {
  const form = new URLSearchParams({ secret, response: token, idempotency_key: idempotencyKey });
  const remoteIp = requestIp(req);
  if (/^[0-9a-fA-F:.]{3,64}$/.test(remoteIp)) form.set("remoteip", remoteIp);
  let response: Response;
  try {
    response = await requestFetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  try {
    const result = await response.json() as unknown;
    return record(result) && result.success === true;
  } catch {
    return false;
  }
}

async function claimRateLimit(
  env: PublicEstimatorEnv,
  scope: "ip" | "client",
  subjectHash: string,
  now: string,
  windowExpiresAt: string,
  limit: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO public_estimate_rate_limits
       (scope, subject_hash, window_started_at, window_expires_at, attempts, updated_at)
     VALUES (?,?,?,?,1,?)
     ON CONFLICT(scope, subject_hash) DO UPDATE SET
       window_started_at = CASE
         WHEN public_estimate_rate_limits.window_expires_at <= excluded.window_started_at
         THEN excluded.window_started_at ELSE public_estimate_rate_limits.window_started_at END,
       window_expires_at = CASE
         WHEN public_estimate_rate_limits.window_expires_at <= excluded.window_started_at
         THEN excluded.window_expires_at ELSE public_estimate_rate_limits.window_expires_at END,
       attempts = CASE
         WHEN public_estimate_rate_limits.window_expires_at <= excluded.window_started_at
         THEN 1 ELSE public_estimate_rate_limits.attempts + 1 END,
       updated_at = excluded.updated_at
     RETURNING attempts`,
  ).bind(scope, subjectHash, now, windowExpiresAt, now).first<{ attempts: number }>();
  return Number(row?.attempts ?? limit + 1) <= limit;
}

async function publicIngestResponse(response: Response): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json() as unknown;
    if (record(parsed)) body = parsed;
  } catch {
    // A downstream failure is never reflected to the public caller verbatim.
  }
  const envelopeId = typeof body.envelope_id === "string" && /^ow_[0-9a-f-]{36}$/i.test(body.envelope_id)
    ? body.envelope_id
    : null;
  const accepted = body.ok === true || body.accepted === true;
  if (!accepted || !envelopeId) {
    return publicJson({ error: response.status >= 500 ? "submission_unavailable" : "submission_rejected" },
      response.status >= 500 ? 503 : 400);
  }
  return publicJson({
    accepted: true,
    envelope_id: envelopeId,
    range: null,
    disclaimer: DEFAULT_DISCLAIMER,
    review_required: true,
    ...(body.idempotent_replay === true ? { idempotent_replay: true } : {}),
  }, response.status === 202 ? 202 : 200);
}

function withCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type, Idempotency-Key, X-Request-ID, X-Correlation-ID");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function publicJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function unavailableResponse(origin: string | null): Response {
  return withCors(publicJson({ error: "submission_unavailable" }, 503), origin);
}

function requestIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") ?? "unknown").trim().slice(0, 64) || "unknown";
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | null {
  const result = value?.trim();
  return result ? result : null;
}

function secretAtLeast(value: string | undefined, minLength: number): string | null {
  const result = nonEmpty(value);
  return result && result.length >= minLength ? result : null;
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length >= min && result.length <= max && !/[\u0000-\u001f\u007f]/.test(result) ? result : null;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  return value === undefined ? null : text(value, 1, max);
}

function selector(value: unknown, max: number): string | null {
  const result = text(value, 2, max)?.toLowerCase().replace(/\s+/g, " ");
  return result && /^[a-z0-9][a-z0-9 _/-]*$/.test(result) ? result : null;
}

function optionalProvince(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  const result = text(value, 2, 3)?.toUpperCase();
  return result && /^[A-Z]{2,3}$/.test(result) ? result : undefined;
}

function submissionId(value: unknown): string | null {
  const result = text(value, 16, 140)?.toLowerCase();
  return result && /^[A-Za-z0-9][A-Za-z0-9._:-]{15,139}$/.test(result) ? result : null;
}

function positiveInteger(value: string | undefined, min: number, max: number): number | null {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= min && result <= max ? result : null;
}
