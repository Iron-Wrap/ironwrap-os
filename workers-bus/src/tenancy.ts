// tenancy.ts — per-request tenant resolution for a shared multi-tenant Worker.
//
// One Worker used to serve one tenant: `APP_TENANT_ID` and every tenant-scoped var were pinned
// in wrangler.jsonc, and about seventy readers below the entry point take the tenant from `env`.
// This module keeps all of them unchanged and moves the decision to the entry point instead:
// the request host names a row in the tenant registry (migration 0209), and that row's settings
// and secrets are laid over `env` before any handler runs (`withTenantEnv`). A session, link or
// bearer token of another tenant presented on this host is then not found or does not match,
// exactly as it fails today between two Workers.
//
// The Worker's own vars stay the default tenant. With `APP_MULTI_TENANT_ENABLED` unset or not
// "true", `resolveRequestTenant` returns `env` untouched and never reads D1. With it on and no
// registry row for the host, the default tenant answers, so turning the flag on changes nothing
// until an operator registers a second tenant and a host for it.
//
// Fail closed: a suspended tenant, a registry read that fails, or a secrets envelope that does
// not open under the Worker's key refuses the request with 503 rather than falling back to the
// default tenant, because that fallback would serve one tenant's request from another's data.

import { operatingTenantId } from "./core.ts";

export const MULTI_TENANT_FLAG = "APP_MULTI_TENANT_ENABLED";
export const TENANT_SECRETS_KEK_NAME = "TENANT_SECRETS_KEK";
/** The one key version so far; a rotation adds a second KEK secret and re-seals rows under version 2. */
export const TENANT_SECRETS_KEY_VERSION = 1;
/** How long one isolate trusts a registry read before asking D1 again. */
export const TENANT_CACHE_TTL_MS = 60_000;
/** A host or id with no row is remembered only briefly, so a newly registered host takes effect fast. */
export const TENANT_MISS_TTL_MS = 5_000;
/** Hosts an isolate remembers at most; past it the map is cleared rather than grown without bound. */
export const TENANT_HOST_CACHE_MAX = 1_000;

/**
 * The vars a tenant row may set: the tenant facts a white-label clone rewrites
 * (`TENANT_SCOPED_VARS` in tools/generate-tenant-worker-config.mjs) plus the two that are tenant
 * facts rather than deployment facts, the data class and the commercial authority policy. A test
 * pins that every name the clone generator rewrites is either allowed here or named in
 * `CLONE_ONLY_VARS`, so a new tenant-bearing var cannot be derived for a clone and silently shared
 * in the shared Worker. Feature flags and deployment facts (`EFFECT_RUNTIME_ENABLED`,
 * `APP_BFF_ENABLED`, timeouts, schema hashes) are absent: one Worker runs one product configuration.
 */
export const TENANT_SETTING_KEYS: readonly string[] = Object.freeze([
  "APP_TENANT_NAME",
  "APP_TENANT_BRAND",
  "APP_LOCALE",
  "APP_TIME_ZONE",
  "APP_CURRENCY",
  "FROM_EMAIL",
  "OWNER_ALERT_EMAIL",
  "BACKUP_ALERT_EMAIL",
  "APP_PUBLIC_ORIGIN",
  "APP_ALLOWED_ORIGINS",
  "APP_VISUAL_PREVIEW_ALLOWED_ORIGINS",
  "PUBLIC_ESTIMATE_ALLOWED_ORIGINS",
  "PUBLIC_ESTIMATE_ALLOWED_BRANDS",
  "PUBLIC_ESTIMATE_CONSENT_JURISDICTION",
  "PUBLIC_ESTIMATE_RANGE_RULES_JSON",
  "SHARED_DRIVE_ID_JOBS",
  "SHARED_DRIVE_ID_RESTRICTED",
  "SHARED_DRIVE_ID_ARCHIVE",
  "QB_EXPECTED_REALM_ID",
  "AGENT_DATA_CLASS",
  "COMMERCIAL_AUTHORITY_POLICY_JSON",
  // The tenant's own Newo project: its agent, numbers, people and knowledge base, driven with
  // the tenant's own sealed NEWO_API_KEY. The Worker-wide Newo flags, URL, timeouts and the
  // tool and report schema hashes are product facts and stay with the Worker.
  "NEWO_PROJECT_ID",
  "NEWO_AGENT_ID",
  "NEWO_REPORT_WEBHOOK_ID",
  "NEWO_REPORT_WEBHOOK_URL",
  "NEWO_HANDOFF_WEBHOOK_ID",
  "NEWO_HANDOFF_WEBHOOK_URL",
  "NEWO_PROTECTED_WEBHOOK_IDS",
  "NEWO_KB_VERSION",
  "NEWO_KB_SHA256",
  "NEWO_PHONE_NUMBER",
  "NEWO_ENABLED_CHANNELS",
  "NEWO_TRANSFER_POLICY",
  "NEWO_OWNER_TRANSFER_NUMBER",
  "NEWO_CALLBACK_OWNER_USER",
  "NEWO_BOOKING_MODE",
  "NEWO_BOOKING_HORIZON_DAYS",
  "NEWO_USAGE_LIMIT_MINUTES",
  "NEWO_USAGE_ALERT_PERCENT",
  // The tenant's own JobNimbus account shape, Postiz providers, pricing and documents.
  "JN_CONTACT_RECORD_TYPE",
  "JN_CONTACT_STATUS",
  "JN_JOB_RECORD_TYPE",
  "JN_JOB_STATUS",
  "POSTIZ_ALLOWED_PROVIDERS",
  // A tenant's Postiz key and the Postiz host it opens travel together, as do its QuickBooks app
  // keys and the API environment (sandbox or production) they were issued for.
  "POSTIZ_API_BASE_URL",
  "QB_API_ENVIRONMENT",
  "ESTIMATOR_PRICE_LIST_JSON",
  "PROPOSAL_TEMPLATE_DOC_ID",
  "OPERATING_AUTOMATION_USER",
]);

/**
 * Clone-derived vars a registry tenant may NOT set. Each names a destination the Worker reaches
 * with a Worker-wide credential that is not sealable per tenant (the retired Frappe and Facet
 * bridges: `ERPNEXT_API_KEY`, the Frappe projection keys, the Facet HMAC keys, the issuer keys), so
 * a tenant-set URL would receive another tenant's credential. The overlay clears them for a
 * registry tenant, which leaves those bridges off for it.
 */
export const CLONE_ONLY_VARS: readonly string[] = Object.freeze([
  "ERPNEXT_ENABLED",
  "ERPNEXT_BASE_URL",
  "ERPNEXT_INTEGRATION_USER",
  "ERPNEXT_LEAD_ENVELOPE_DOCTYPE",
  "QB_RECONCILIATION_ISSUER_USER",
  "APP_FACET_QUOTE_REVISION_PREPARE_ENABLED",
  "APP_FACET_LAUNCH_ENABLED",
  "APP_FACET_LAUNCH_BASE_URL",
  "APP_FACET_LAUNCH_SOURCE_TENANT_ID",
  "FACET_DESIGN_INGEST_ENABLED",
  "FACET_DESIGN_INGEST_TENANT_MAP_JSON",
  "FACET_DESIGN_FRAPPE_PROJECTION_ENABLED",
  "FACET_V2_INGEST_ENABLED",
  "FACET_V2_ROUTES_JSON",
  "FACET_V2_NATIVE_PROJECTION_ENABLED",
  "FACET_V2_FRAPPE_PROJECTION_ENABLED",
  "POSTIZ_FACET_DRAFT_ENABLED",
  "POSTIZ_FACET_DRAFT_PROVIDER",
  "POSTIZ_FACET_DRAFT_OFFSET_HOURS",
  "POSTIZ_FACET_DRAFT_NOT_BEFORE",
  "OMNIROUTE_URL",
  // Their credentials, likewise cleared: Frappe issuer and projection keys, Facet keys, the
  // retired broker secrets. None of them is sealable per tenant.
  "ERPNEXT_API_KEY",
  "ERPNEXT_API_SECRET",
  "QB_FINAL_INVOICE_FRAPPE_API_KEY",
  "QB_FINAL_INVOICE_FRAPPE_API_SECRET",
  "QB_RECONCILIATION_ISSUER_API_KEY",
  "QB_RECONCILIATION_ISSUER_API_SECRET",
  "FLEET_CAPTURE_FRAPPE_API_KEY",
  "FLEET_CAPTURE_FRAPPE_API_SECRET",
  "WORK_PACKAGE_FRAPPE_API_KEY",
  "WORK_PACKAGE_FRAPPE_API_SECRET",
  "FACET_DESIGN_INGEST_HMAC_KEY",
  "FACET_V2_KEYS_JSON",
  "FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY",
  "FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET",
  "APPROVAL_BROKER_SHARED_SECRET",
  "QUOTE_REVISION_BROKER_SHARED_SECRET",
  "PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET",
]);

/**
 * Product and deployment facts: one Worker runs one product configuration, so these stay the
 * Worker's own for every tenant. Feature flags, provider URLs and timeouts, schema hashes and
 * release pins, the Worker-wide keys and the operator's token. A test holds every declared var
 * and secret name to exactly one of the four lists, so a new name cannot ship unclassified.
 */
export const WORKER_WIDE_NAMES: readonly string[] = Object.freeze([
  "APP_TENANT_ID",
  "APP_MULTI_TENANT_ENABLED",
  "APP_DOCUMENT_GENERATION_ENABLED",
  "APP_PRICING_CATALOG_ENABLED",
  "APP_BFF_ENABLED",
  "APP_READINESS_ADMISSION_ENABLED",
  "APP_EVIDENCE_UPLOADS_ENABLED",
  "APP_CUSTOMER_PORTAL_ENABLED",
  "APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED",
  "APP_CUSTOMER_PORTAL_DECISION_ENABLED",
  "APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED",
  "APP_PROPOSAL_PUBLICATION_ENABLED",
  "APP_ALLOW_INSECURE_LOCAL",
  "APP_FIRST_OWNER_BOOTSTRAP_ENABLED",
  "APP_FRAPPE_REQUEST_TIMEOUT_MS",
  "NEWO_PRODUCTION_REQUIRED",
  "NEWO_ENABLED",
  "NEWO_CONTROL_WRITE_ENABLED",
  "NEWO_OUTBOUND_ENABLED",
  "NEWO_API_BASE_URL",
  "NEWO_EXPECTED_CONFIG_VERSION",
  "NEWO_TOOL_SCHEMA_SHA256",
  "NEWO_REPORT_SCHEMA_SHA256",
  "NEWO_R2_LIFECYCLE_PROVEN",
  "NEWO_JOBNIMBUS_BOOKING_PROVEN",
  "NEWO_REPORT_TIMEOUT_MINUTES",
  "NEWO_SYNC_RETRY_MINUTES",
  "NEWO_API_TIMEOUT_MS",
  "NEWO_CONTROL_RECEIPT_TTL_SECONDS",
  "PUBLIC_ESTIMATE_ENABLED",
  "PUBLIC_ESTIMATE_ALLOW_INSECURE_LOCAL",
  "PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY",
  "PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS",
  "PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX",
  "PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX",
  "POSTIZ_ENABLED",
  "POSTIZ_EXPECTED_VERSION",
  "POSTIZ_API_TIMEOUT_MS",
  "QB_OAUTH_ENABLED",
  "QB_FINAL_INVOICE_ENABLED",
  "QB_API_MINOR_VERSION",
  "QB_API_TIMEOUT_MS",
  "QB_TOKEN_ENCRYPTION_KEY_VERSION",
  "MEASUREMENT_OCR_ENABLED",
  "MEASUREMENT_OCR_MODEL",
  "EFFECT_RUNTIME_ENABLED",
  "PIPELINE_AUTOMATION_ENABLED",
  "JOBNIMBUS_ENABLED",
  "DEDUP_WINDOW_HOURS",
  "STUCK_THRESHOLD_MIN",
  "AGENT_INBOUND_FROM",
  // Worker-wide keys and the operator's token.
  "ADMIN_TOKEN",
  "TENANT_SECRETS_KEK",
  "TENANT_PROXY_TOKEN",
  "QB_TOKEN_ENCRYPTION_KEY",
  "APP_AUTH_PEPPER",
  "PUBLIC_ESTIMATE_TURNSTILE_SECRET",
  "PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER",
]);

/**
 * The secrets a tenant row may hold. Each is a credential one tenant presents or one provider
 * account one tenant owns. Worker-wide keys stay out: `TENANT_SECRETS_KEK` (this envelope's own
 * key), `QB_TOKEN_ENCRYPTION_KEY` and `APP_AUTH_PEPPER` (hash and encryption domains shared by
 * every row the Worker already holds), the rate-limit pepper and the Turnstile secret (one
 * deployment, one widget), and `ADMIN_TOKEN`: `/admin/*` reads tables that carry no tenant column
 * (the audit log, dead letters, webhook receipts), so it stays the hosting operator's surface.
 */
export const TENANT_SECRET_NAMES: readonly string[] = Object.freeze([
  "INGEST_TOKEN",
  "EFFECT_RUNTIME_TOKEN",
  "AGENT_HOST_TOKEN",
  "NEWO_WEBHOOK_TOKEN",
  "NEWO_API_KEY",
  "NEWO_BOOKING_TOKEN",
  "NEWO_CONTROL_SIGNING_SECRET",
  "JOBNIMBUS_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_MAPS_API_KEY",
  "MEASUREMENT_OCR_API_KEY",
  "POSTIZ_API_KEY",
  "QB_WEBHOOK_TOKEN",
  "QB_CLIENT_ID",
  "QB_CLIENT_SECRET",
  "PIPELINE_AUTOMATION_RECIPIENTS_JSON",
]);

export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** A lowercase hostname without port: labels of 1–63 characters, dots between, 253 at most. */
export const TENANT_HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
export const MAX_SETTING_VALUE_CHARS = 4096;
export const MAX_SETTINGS_JSON_BYTES = 16 * 1024;
export const MAX_SECRET_VALUE_CHARS = 8192;
export const MAX_TENANT_HOSTS = 16;

export type TenantStatus = "active" | "suspended";
export type TenantDataClass = "business" | "synthetic";

export interface TenantRow {
  tenant_id: string;
  display_name: string;
  status: TenantStatus;
  data_class: TenantDataClass;
  settings_json: string;
  secrets_ciphertext: string | null;
  secrets_key_version: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** A registry row as the admin surface and the overlay see it: settings in the clear, secret names only. */
export interface TenantRecord {
  tenant_id: string;
  display_name: string;
  status: TenantStatus;
  data_class: TenantDataClass;
  settings: Record<string, string>;
  hosts: string[];
  secret_names: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export type TenantRefusalCode =
  | "tenant_suspended"
  | "tenant_unavailable"
  | "tenant_secrets_unavailable"
  | "tenant_proxy_untrusted";

export interface TenantRefusal {
  status: 403 | 503;
  error: TenantRefusalCode;
}

/** The hostname a trusted proxy serves, and the token that proves it is that proxy. */
export const FORWARDED_HOST_HEADER = "x-ironwrap-forwarded-host";
export const PROXY_TOKEN_HEADER = "x-ironwrap-proxy-token";

export type TenantResolution =
  /** The flag is off: `env` as bound, the tenant whatever `APP_TENANT_ID` says. */
  | { kind: "legacy"; tenantId: string | null; env: Env }
  /** The flag is on and nothing maps this host or id: the Worker's own vars answer. */
  | { kind: "default"; tenantId: string; env: Env }
  /** A registry row answers; `env` carries its settings and secrets. */
  | { kind: "tenant"; tenantId: string; via: "host" | "id"; env: Env }
  | { kind: "refused"; tenantId: string | null; refusal: TenantRefusal };

interface TenantDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

interface TenancyEnv {
  DB?: unknown;
  APP_TENANT_ID?: string;
  APP_MULTI_TENANT_ENABLED?: string;
  TENANT_SECRETS_KEK?: string;
  TENANT_PROXY_TOKEN?: string;
}

export function multiTenantEnabled(env: TenancyEnv): boolean {
  return String(env.APP_MULTI_TENANT_ENABLED ?? "").trim() === "true";
}

/** The Worker's own tenant: what every request resolved to before the registry existed. */
export function defaultTenantId(env: TenancyEnv): string | null {
  return operatingTenantId(env.APP_TENANT_ID);
}

interface CachedTenant {
  row: TenantRow | null;
  secrets: Record<string, string> | null;
  secretsError: boolean;
  expiresAt: number;
}

interface CachedHost {
  tenantId: string | null;
  expiresAt: number;
}

const tenantCache = new Map<string, CachedTenant>();
const hostCache = new Map<string, CachedHost>();

/** Forget every cached registry read: after an admin write in this isolate, and between tests. */
export function resetTenantCache(): void {
  tenantCache.clear();
  hostCache.clear();
}

async function tenantIdForHost(db: TenantDb, host: string, now: number): Promise<string | null> {
  const cached = hostCache.get(host);
  if (cached && cached.expiresAt > now) return cached.tenantId;
  const row = await db.prepare("SELECT tenant_id FROM tenant_hosts WHERE host = ?").bind(host)
    .first<{ tenant_id: string }>();
  const tenantId = row?.tenant_id ?? null;
  if (hostCache.size >= TENANT_HOST_CACHE_MAX) {
    for (const [key, entry] of hostCache) if (entry.expiresAt <= now) hostCache.delete(key);
    if (hostCache.size >= TENANT_HOST_CACHE_MAX) hostCache.clear();
  }
  hostCache.set(host, { tenantId, expiresAt: now + (tenantId ? TENANT_CACHE_TTL_MS : TENANT_MISS_TTL_MS) });
  return tenantId;
}

/** A hostname as the registry keys it: lowercase, no port, no trailing dot. */
export function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  // `host:port` and `[v6]:port` as a Host header carries them; the registry keys hostnames.
  const bracket = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) host = bracket[1];
  else if (/^[^:]+:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(":"));
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/**
 * The hostname a request is for. Behind the hosting operator's proxy (one custom domain per
 * tenant forwarding to the Worker's one `workers.dev` name) the URL carries the proxy's upstream
 * hostname, so the proxy states the hostname it served in `x-ironwrap-forwarded-host` and proves
 * it is the proxy with `x-ironwrap-proxy-token`, compared constant-time against the Worker
 * secret TENANT_PROXY_TOKEN. A forwarded host without a valid proof is refused, never read and
 * never ignored: an unauthenticated caller must not pick a tenant, and must not silently land on
 * the default one either.
 */
export function requestHost(
  req: Request,
  env: TenancyEnv,
): { ok: true; host: string } | { ok: false; refusal: TenantRefusal } {
  const forwarded = req.headers.get(FORWARDED_HOST_HEADER);
  if (forwarded === null) return { ok: true, host: normalizeHost(new URL(req.url).hostname) };
  const proof = req.headers.get(PROXY_TOKEN_HEADER) ?? "";
  if (!env.TENANT_PROXY_TOKEN || !constantTimeEqual(proof, env.TENANT_PROXY_TOKEN)) {
    return { ok: false, refusal: { status: 403, error: "tenant_proxy_untrusted" } };
  }
  return { ok: true, host: normalizeHost(forwarded) };
}

async function loadTenant(env: TenancyEnv, tenantId: string, now: number): Promise<CachedTenant> {
  const cached = tenantCache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached;
  const db = env.DB as TenantDb;
  const row = await db.prepare(
    `SELECT tenant_id, display_name, status, data_class, settings_json, secrets_ciphertext,
            secrets_key_version, version, created_at, updated_at
     FROM tenants WHERE tenant_id = ?`,
  ).bind(tenantId).first<TenantRow>();
  let secrets: Record<string, string> | null = null;
  let secretsError = false;
  if (row?.secrets_ciphertext) {
    try {
      secrets = await openTenantSecrets(
        env.TENANT_SECRETS_KEK,
        row.tenant_id,
        row.secrets_key_version ?? 0,
        row.secrets_ciphertext,
      );
    } catch {
      // A missing or wrong key, or a tampered envelope: the tenant is refused, never served
      // with the Worker's own credentials in place of its own.
      secretsError = true;
    }
  }
  const entry: CachedTenant = {
    row,
    secrets,
    secretsError,
    expiresAt: now + (row ? TENANT_CACHE_TTL_MS : TENANT_MISS_TTL_MS),
  };
  tenantCache.set(tenantId, entry);
  return entry;
}

/**
 * `env` for one registry tenant. Every tenant-scoped var and secret is cleared first, then the
 * row's own values are applied: a value the row leaves out is unset, never the Worker tenant's.
 * An unset sender mailbox, ingest token or provider key then makes the handler that needs it
 * fail closed (`not configured`), where inheritance would have sent one tenant's mail, accepted
 * one tenant's token or spent one tenant's provider account on another's behalf.
 */
export function withTenantEnv(env: Env, row: TenantRow, secrets: Record<string, string> | null): Env {
  const overlay: Record<string, unknown> = { ...(env as unknown as Record<string, unknown>) };
  for (const name of [...TENANT_SETTING_KEYS, ...CLONE_ONLY_VARS, ...TENANT_SECRET_NAMES]) overlay[name] = undefined;
  // A tenant without its own name or brand must not inherit the Worker tenant's.
  overlay.APP_TENANT_NAME = row.display_name;
  overlay.APP_TENANT_BRAND = row.display_name;
  const settings = parseStoredSettings(row.settings_json);
  for (const [name, value] of Object.entries(settings)) overlay[name] = value;
  for (const [name, value] of Object.entries(secrets ?? {})) {
    if (TENANT_SECRET_NAMES.includes(name)) overlay[name] = value;
  }
  overlay.APP_TENANT_ID = row.tenant_id;
  overlay.AGENT_DATA_CLASS = row.data_class;
  return overlay as unknown as Env;
}

function parseStoredSettings(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const out: Record<string, string> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (TENANT_SETTING_KEYS.includes(name) && typeof value === "string") out[name] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function resolveLoaded(
  env: Env,
  tenantId: string,
  loaded: CachedTenant,
  via: "host" | "id",
): TenantResolution {
  if (!loaded.row) {
    // A host that names a tenant row that no longer exists, or an id a queue message carried
    // for a tenant since removed: nothing to serve it from.
    return { kind: "refused", tenantId, refusal: { status: 503, error: "tenant_unavailable" } };
  }
  if (loaded.row.status !== "active") {
    return { kind: "refused", tenantId, refusal: { status: 503, error: "tenant_suspended" } };
  }
  if (loaded.secretsError) {
    return { kind: "refused", tenantId, refusal: { status: 503, error: "tenant_secrets_unavailable" } };
  }
  return { kind: "tenant", tenantId, via, env: withTenantEnv(env, loaded.row, loaded.secrets) };
}

/**
 * The tenant a request is for. Host first: the registry maps a hostname to a tenant. A host
 * nobody registered resolves to the Worker's own tenant, so the deployed hostnames keep working
 * the day the flag turns on. Tokens then bind to the resolved tenant inside the handlers.
 */
export async function resolveRequestTenant(
  req: Request,
  env: Env,
  now: () => number = () => Date.now(),
): Promise<TenantResolution> {
  const tenancy = env as unknown as TenancyEnv;
  if (!multiTenantEnabled(tenancy)) return { kind: "legacy", tenantId: defaultTenantId(tenancy), env };
  const fallback = defaultTenantId(tenancy);
  if (!fallback || !tenancy.DB) {
    return { kind: "refused", tenantId: fallback, refusal: { status: 503, error: "tenant_unavailable" } };
  }
  const resolvedHost = requestHost(req, tenancy);
  if (!resolvedHost.ok) return { kind: "refused", tenantId: null, refusal: resolvedHost.refusal };
  const host = resolvedHost.host;
  let tenantId: string | null;
  try {
    tenantId = TENANT_HOST_RE.test(host) ? await tenantIdForHost(tenancy.DB as TenantDb, host, now()) : null;
  } catch {
    return { kind: "refused", tenantId: null, refusal: { status: 503, error: "tenant_unavailable" } };
  }
  if (!tenantId || tenantId === fallback) return { kind: "default", tenantId: fallback, env };
  return await tenantEnvFor(env, tenantId, now);
}

/** The env for work that already knows its tenant: a queue message or a cron pass. */
export async function tenantEnvFor(
  env: Env,
  tenantId: string,
  now: () => number = () => Date.now(),
): Promise<TenantResolution> {
  const tenancy = env as unknown as TenancyEnv;
  if (!multiTenantEnabled(tenancy)) return { kind: "legacy", tenantId: defaultTenantId(tenancy), env };
  const fallback = defaultTenantId(tenancy);
  if (!fallback || !tenancy.DB) {
    return { kind: "refused", tenantId: fallback, refusal: { status: 503, error: "tenant_unavailable" } };
  }
  if (!TENANT_ID_RE.test(tenantId)) {
    return { kind: "refused", tenantId: null, refusal: { status: 503, error: "tenant_unavailable" } };
  }
  if (tenantId === fallback) return { kind: "default", tenantId: fallback, env };
  let loaded: CachedTenant;
  try {
    loaded = await loadTenant(tenancy, tenantId, now());
  } catch {
    return { kind: "refused", tenantId, refusal: { status: 503, error: "tenant_unavailable" } };
  }
  return resolveLoaded(env, tenantId, loaded, "id");
}

/** Every tenant a cron pass serves: the Worker's own, then each active registry row. */
export async function listActiveTenantIds(env: Env): Promise<string[]> {
  const tenancy = env as unknown as TenancyEnv;
  const fallback = defaultTenantId(tenancy);
  const ids = fallback ? [fallback] : [];
  if (!multiTenantEnabled(tenancy) || !tenancy.DB) return ids;
  const rows = await (tenancy.DB as TenantDb).prepare(
    "SELECT tenant_id FROM tenants WHERE status = 'active' ORDER BY tenant_id",
  ).bind().all<{ tenant_id: string }>();
  for (const row of rows.results) if (!ids.includes(row.tenant_id)) ids.push(row.tenant_id);
  return ids;
}

/** The envs one cron tick runs its tenant jobs under, and the registry tenants it had to skip. */
export async function cronTenantEnvs(
  env: Env,
  now: () => number = () => Date.now(),
): Promise<{ envs: Env[]; skipped: Array<{ tenant_id: string; error: string }> }> {
  const tenancy = env as unknown as TenancyEnv;
  if (!multiTenantEnabled(tenancy)) return { envs: [env], skipped: [] };
  let ids: string[];
  try {
    ids = await listActiveTenantIds(env);
  } catch {
    // The registry could not be read: the Worker's own tenant still gets its pass, and nothing
    // runs for a registry tenant under the wrong env.
    return { envs: [env], skipped: [{ tenant_id: "*", error: "tenant_registry_unavailable" }] };
  }
  const envs: Env[] = [];
  const skipped: Array<{ tenant_id: string; error: string }> = [];
  for (const tenantId of ids) {
    const resolution = await tenantEnvFor(env, tenantId, now);
    if (resolution.kind === "refused") skipped.push({ tenant_id: tenantId, error: resolution.refusal.error });
    else envs.push(resolution.env);
  }
  return { envs, skipped };
}

/**
 * The env a queue message is handled under. A message carries the tenant that enqueued it; a
 * message without one (sent before this field existed) is the Worker's own tenant's. A tenant
 * that cannot be served throws, so the message is retried and dead-lettered rather than handled
 * under another tenant's env.
 */
export async function queueMessageEnv(env: Env, tenantId: string | undefined): Promise<Env> {
  if (tenantId === undefined) return env;
  const resolution = await tenantEnvFor(env, tenantId);
  if (resolution.kind === "refused") throw new Error(`queue_${resolution.refusal.error}`);
  return resolution.env;
}

/** The tenant a producer stamps on a queue message: the env's, with the deployment default when unset. */
export function queueTenantId(env: { APP_TENANT_ID?: string }): string | undefined {
  return operatingTenantId(env.APP_TENANT_ID) ?? undefined;
}

// --- secrets envelope ----------------------------------------------------------------------

const SECRETS_AAD_PREFIX = "ironwrap.tenant-secrets.v1";

function decodeKek(raw: string | undefined): Uint8Array {
  const value = (raw ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(value.match(/../g)!.map((pair) => parseInt(pair, 16)));
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }
  throw new Error("tenant_secrets_kek_invalid");
}

async function importKek(raw: string | undefined): Promise<CryptoKey> {
  const bytes = decodeKek(raw);
  return await crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function aad(tenantId: string, keyVersion: number): Uint8Array {
  return new TextEncoder().encode(`${SECRETS_AAD_PREFIX}:${tenantId}:${keyVersion}`);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** A secrets object sealed for one tenant row: base64 of a 12-byte IV followed by AES-GCM output. */
export async function sealTenantSecrets(
  kek: string | undefined,
  tenantId: string,
  keyVersion: number,
  secrets: Record<string, string>,
): Promise<string> {
  const key = await importKek(kek);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(secrets));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(tenantId, keyVersion) },
    key,
    plaintext,
  ));
  const out = new Uint8Array(iv.byteLength + sealed.byteLength);
  out.set(iv, 0);
  out.set(sealed, iv.byteLength);
  return toBase64(out);
}

/** The secrets of one tenant row, or a throw when the key, the row binding or the bytes do not agree. */
export async function openTenantSecrets(
  kek: string | undefined,
  tenantId: string,
  keyVersion: number,
  ciphertext: string,
): Promise<Record<string, string>> {
  const key = await importKek(kek);
  const bytes = fromBase64(ciphertext);
  if (bytes.byteLength < 12 + 16) throw new Error("tenant_secrets_envelope_short");
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad(tenantId, keyVersion) },
    key,
    bytes.subarray(12),
  );
  const parsed = JSON.parse(new TextDecoder().decode(opened)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("tenant_secrets_shape");
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TENANT_SECRET_NAMES.includes(name) || typeof value !== "string") throw new Error("tenant_secrets_shape");
    out[name] = value;
  }
  return out;
}

/** Constant-time string equality; `b` absent is never equal. */
export function constantTimeEqual(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  const tse = (crypto.subtle as unknown as {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
  }).timingSafeEqual;
  if (typeof tse === "function") return tse.call(crypto.subtle, ab, bb);
  let diff = 0;
  for (let index = 0; index < ab.length; index += 1) diff |= ab[index] ^ bb[index];
  return diff === 0;
}
