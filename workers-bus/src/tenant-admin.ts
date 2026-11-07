// tenant-admin.ts — the operator surface of the tenant registry (migration 0209).
//
// `/admin/tenants` is served from the Worker's OWN env, before per-request tenant resolution,
// and only against the Worker's own ADMIN_TOKEN: a tenant's registered ADMIN_TOKEN administers
// that tenant's records, never the registry that decides which tenant a host is. Secret values
// go in through this surface once, sealed under TENANT_SECRETS_KEK, and never come back out;
// a read lists secret names only.
//
// Writes are upserts with a version check (the writer states the version it read), so two
// operators cannot overwrite each other, and they clear this isolate's registry cache. Other
// isolates pick a change up within TENANT_CACHE_TTL_MS.

import {
  MAX_SECRET_VALUE_CHARS,
  MAX_SETTING_VALUE_CHARS,
  MAX_SETTINGS_JSON_BYTES,
  MAX_TENANT_HOSTS,
  TENANT_HOST_RE,
  TENANT_ID_RE,
  TENANT_SECRETS_KEY_VERSION,
  TENANT_SECRET_NAMES,
  TENANT_SETTING_KEYS,
  constantTimeEqual,
  defaultTenantId,
  multiTenantEnabled,
  resetTenantCache,
  sealTenantSecrets,
  type TenantDataClass,
  type TenantRecord,
  type TenantRow,
  type TenantStatus,
} from "./tenancy.ts";

const MAX_BODY_BYTES = 64 * 1024;

interface AdminDb {
  prepare(sql: string): {
    bind(...args: unknown[]): AdminStatement;
  };
  batch(statements: AdminStatement[]): Promise<unknown>;
}

interface AdminStatement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

interface TenantAdminEnv {
  DB?: unknown;
  ADMIN_TOKEN?: string;
  APP_TENANT_ID?: string;
  APP_MULTI_TENANT_ENABLED?: string;
  TENANT_SECRETS_KEK?: string;
}

export function isTenantAdminPath(pathname: string): boolean {
  return pathname === "/admin/tenants" || pathname.startsWith("/admin/tenants/");
}

export async function handleTenantAdmin(
  req: Request,
  env: TenantAdminEnv,
  now: () => string = () => new Date().toISOString(),
): Promise<Response> {
  // With the flag off the registry is not consulted, so it is not administered either: the
  // surface stays dark and the flag-off Worker gains no write path.
  if (!multiTenantEnabled(env)) return json({ error: "not_found" }, 404);
  if (!env.ADMIN_TOKEN || !constantTimeEqual(bearer(req), env.ADMIN_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!env.DB) return json({ error: "tenant_registry_unavailable" }, 503);
  const db = env.DB as AdminDb;
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/admin/tenants") {
    return json({ tenants: await listTenants(db) });
  }
  const match = url.pathname.match(/^\/admin\/tenants\/([^/]+)$/);
  if (!match) return json({ error: "not_found" }, 404);
  const tenantId = match[1];
  if (!TENANT_ID_RE.test(tenantId)) return json({ error: "invalid_tenant_id" }, 400);
  if (req.method === "GET") {
    const record = await readTenant(db, tenantId);
    return record ? json({ tenant: record }) : json({ error: "not_found" }, 404);
  }
  if (req.method === "PUT") return await upsertTenant(req, env, db, tenantId, now());
  return json({ error: "method_not_allowed" }, 405);
}

async function listTenants(db: AdminDb): Promise<TenantRecord[]> {
  const rows = await db.prepare(
    `SELECT tenant_id, display_name, status, data_class, settings_json, secrets_ciphertext,
            secrets_key_version, version, created_at, updated_at
     FROM tenants ORDER BY tenant_id`,
  ).bind().all<TenantRow>();
  const hosts = await db.prepare("SELECT host, tenant_id FROM tenant_hosts ORDER BY host").bind()
    .all<{ host: string; tenant_id: string }>();
  return rows.results.map((row) => toRecord(row, hosts.results.filter((h) => h.tenant_id === row.tenant_id).map((h) => h.host)));
}

async function readTenant(db: AdminDb, tenantId: string): Promise<TenantRecord | null> {
  const row = await db.prepare(
    `SELECT tenant_id, display_name, status, data_class, settings_json, secrets_ciphertext,
            secrets_key_version, version, created_at, updated_at
     FROM tenants WHERE tenant_id = ?`,
  ).bind(tenantId).first<TenantRow>();
  if (!row) return null;
  const hosts = await db.prepare("SELECT host FROM tenant_hosts WHERE tenant_id = ? ORDER BY host").bind(tenantId)
    .all<{ host: string }>();
  return toRecord(row, hosts.results.map((h) => h.host));
}

function toRecord(row: TenantRow, hosts: string[]): TenantRecord {
  // The sealed names ride in settings_json beside the envelope; they are not a setting.
  const settings = storedSettings(row.settings_json);
  return {
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    status: row.status,
    data_class: row.data_class,
    settings,
    hosts,
    secret_names: secretNamesOf(row),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The names sealed in the row are not recoverable without the key; the registry keeps them beside it. */
function secretNamesOf(row: TenantRow): string[] {
  if (!row.secrets_ciphertext) return [];
  try {
    const parsed = JSON.parse(row.settings_json) as Record<string, unknown>;
    const names = parsed.__secret_names;
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/** `null` for settings, hosts and secrets means "not in the body": keep what the row holds. */
interface UpsertBody {
  display_name: string;
  status: TenantStatus;
  data_class: TenantDataClass;
  settings: Record<string, string> | null;
  hosts: string[] | null;
  secrets: Record<string, string> | null;
  expected_version: number | null;
}

type Parsed = { ok: true; body: UpsertBody } | { ok: false; error: string; detail?: unknown };

function parseUpsert(raw: unknown): Parsed {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_body" };
  const body = raw as Record<string, unknown>;
  const allowed = new Set(["display_name", "status", "data_class", "settings", "hosts", "secrets", "expected_version"]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return { ok: false, error: "invalid_body", detail: { unknown_field: key } };
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (displayName.length < 1 || displayName.length > 120) return { ok: false, error: "invalid_display_name" };
  const status = body.status ?? "active";
  if (status !== "active" && status !== "suspended") return { ok: false, error: "invalid_status" };
  const dataClass = body.data_class;
  if (dataClass !== "business" && dataClass !== "synthetic") return { ok: false, error: "invalid_data_class" };

  let settings: Record<string, string> | null = null;
  if (body.settings !== undefined) {
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) return { ok: false, error: "invalid_settings" };
    settings = {};
    for (const [name, value] of Object.entries(body.settings as Record<string, unknown>)) {
      if (!TENANT_SETTING_KEYS.includes(name)) return { ok: false, error: "setting_not_tenant_scoped", detail: { name } };
      if (typeof value !== "string" || value.length > MAX_SETTING_VALUE_CHARS) return { ok: false, error: "invalid_setting_value", detail: { name } };
      settings[name] = value;
    }
    if (new TextEncoder().encode(JSON.stringify(settings)).byteLength > MAX_SETTINGS_JSON_BYTES) return { ok: false, error: "settings_too_large" };
  }

  let hosts: string[] | null = null;
  if (body.hosts !== undefined) {
    if (!Array.isArray(body.hosts) || body.hosts.length > MAX_TENANT_HOSTS) return { ok: false, error: "invalid_hosts" };
    hosts = [];
    for (const host of body.hosts) {
      if (typeof host !== "string" || !TENANT_HOST_RE.test(host)) return { ok: false, error: "invalid_host", detail: { host } };
      if (!hosts.includes(host)) hosts.push(host);
    }
  }

  let secrets: Record<string, string> | null = null;
  if (body.secrets !== undefined) {
    if (!body.secrets || typeof body.secrets !== "object" || Array.isArray(body.secrets)) return { ok: false, error: "invalid_secrets" };
    secrets = {};
    for (const [name, value] of Object.entries(body.secrets as Record<string, unknown>)) {
      if (!TENANT_SECRET_NAMES.includes(name)) return { ok: false, error: "secret_not_tenant_scoped", detail: { name } };
      if (typeof value !== "string" || value.length < 1 || value.length > MAX_SECRET_VALUE_CHARS) return { ok: false, error: "invalid_secret_value", detail: { name } };
      secrets[name] = value;
    }
  }

  let expectedVersion: number | null = null;
  if (body.expected_version !== undefined) {
    if (!Number.isInteger(body.expected_version) || (body.expected_version as number) < 1) return { ok: false, error: "invalid_expected_version" };
    expectedVersion = body.expected_version as number;
  }
  return { ok: true, body: { display_name: displayName, status, data_class: dataClass, settings, hosts, secrets, expected_version: expectedVersion } };
}

async function upsertTenant(req: Request, env: TenantAdminEnv, db: AdminDb, tenantId: string, now: string): Promise<Response> {
  const raw = await readJson(req);
  if (raw === TOO_LARGE) return json({ error: "body_too_large" }, 413);
  const parsed = parseUpsert(raw);
  if (!parsed.ok) return json({ error: parsed.error, ...(parsed.detail ? { detail: parsed.detail } : {}) }, 400);
  const body = parsed.body;

  // The Worker's own tenant is configured by its vars. The registry may give it hosts, nothing
  // else: a setting or secret here would silently change the deployed tenant's behaviour, and a
  // suspension would refuse every request the deployment was made for.
  if (tenantId === defaultTenantId(env)) {
    if ((body.settings && Object.keys(body.settings).length > 0) || (body.secrets && Object.keys(body.secrets).length > 0)) {
      return json({ error: "default_tenant_uses_worker_vars" }, 400);
    }
    if (body.status !== "active") return json({ error: "default_tenant_always_active" }, 400);
  }

  const existing = await db.prepare("SELECT version, secrets_ciphertext, secrets_key_version, settings_json FROM tenants WHERE tenant_id = ?")
    .bind(tenantId).first<{ version: number; secrets_ciphertext: string | null; secrets_key_version: number | null; settings_json: string }>();
  if (existing) {
    if (body.expected_version === null) return json({ error: "expected_version_required", version: existing.version }, 409);
    if (body.expected_version !== existing.version) return json({ error: "version_conflict", version: existing.version }, 409);
  } else if (body.expected_version !== null) {
    return json({ error: "version_conflict", version: null }, 409);
  }

  for (const host of body.hosts ?? []) {
    const owner = await db.prepare("SELECT tenant_id FROM tenant_hosts WHERE host = ?").bind(host).first<{ tenant_id: string }>();
    if (owner && owner.tenant_id !== tenantId) return json({ error: "host_taken", host, tenant_id: owner.tenant_id }, 409);
  }

  const existingSettings = existing ? storedSettings(existing.settings_json) : {};
  const settings = body.settings ?? existingSettings;
  let secretsCiphertext = existing?.secrets_ciphertext ?? null;
  let secretsKeyVersion = existing?.secrets_key_version ?? null;
  let secretNames = existing ? secretNamesOf({ settings_json: existing.settings_json, secrets_ciphertext: existing.secrets_ciphertext } as TenantRow) : [];
  if (body.secrets !== null) {
    if (Object.keys(body.secrets).length === 0) {
      secretsCiphertext = null;
      secretsKeyVersion = null;
      secretNames = [];
    } else {
      if (!env.TENANT_SECRETS_KEK) return json({ error: "tenant_secrets_kek_missing" }, 503);
      try {
        secretsCiphertext = await sealTenantSecrets(env.TENANT_SECRETS_KEK, tenantId, TENANT_SECRETS_KEY_VERSION, body.secrets);
      } catch {
        return json({ error: "tenant_secrets_kek_invalid" }, 503);
      }
      secretsKeyVersion = TENANT_SECRETS_KEY_VERSION;
      secretNames = Object.keys(body.secrets).sort();
    }
  }
  const settingsJson = JSON.stringify(
    secretNames.length > 0 ? { ...settings, __secret_names: secretNames } : settings,
  );
  const version = existing ? existing.version + 1 : 1;
  const writeId = crypto.randomUUID();

  // One batch, every statement conditioned on the row this write produces: the row update matches
  // only the version that was read, and each host statement runs only while the row carries this
  // write's own id (a concurrent writer that reached the same version number stamped its own). A
  // lost race therefore leaves this batch with no row change and no host change, which the
  // row-change count below turns into a conflict instead of a mixed row.
  const thisWrite = `EXISTS (SELECT 1 FROM tenants WHERE tenant_id = ? AND write_id = ?)`;
  const statements: AdminStatement[] = [
    existing
      ? db.prepare(
        `UPDATE tenants SET display_name = ?, status = ?, data_class = ?, settings_json = ?,
                secrets_ciphertext = ?, secrets_key_version = ?, version = ?, write_id = ?, updated_at = ?
         WHERE tenant_id = ? AND version = ?`,
      ).bind(body.display_name, body.status, body.data_class, settingsJson, secretsCiphertext, secretsKeyVersion, version, writeId, now, tenantId, existing.version)
      : db.prepare(
        `INSERT INTO tenants (tenant_id, display_name, status, data_class, settings_json,
                              secrets_ciphertext, secrets_key_version, version, write_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(tenantId, body.display_name, body.status, body.data_class, settingsJson, secretsCiphertext, secretsKeyVersion, writeId, now, now),
    ...(body.hosts === null ? [] : [
      db.prepare(`DELETE FROM tenant_hosts WHERE tenant_id = ? AND ${thisWrite}`).bind(tenantId, tenantId, writeId),
      ...body.hosts.map((host) =>
        db.prepare(`INSERT INTO tenant_hosts (host, tenant_id, created_at) SELECT ?, ?, ? WHERE ${thisWrite}`)
          .bind(host, tenantId, now, tenantId, writeId),
      ),
    ]),
  ];
  let results: unknown;
  try {
    results = await db.batch(statements);
  } catch {
    // A primary-key clash on a concurrent create, or a CHECK the row failed: nothing was written.
    return json({ error: "tenant_write_conflict" }, 409);
  }
  const rowChanges = changesOf(Array.isArray(results) ? results[0] : undefined);
  resetTenantCache();
  if (rowChanges !== 1) {
    const current = await db.prepare("SELECT version FROM tenants WHERE tenant_id = ?").bind(tenantId).first<{ version: number }>();
    return json({ error: "version_conflict", version: current?.version ?? null }, 409);
  }
  const record = await readTenant(db, tenantId);
  return json({ tenant: record }, existing ? 200 : 201);
}

/** The row-change count of one batched statement, as D1 and the test fixture report it. */
function changesOf(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const meta = (result as { meta?: { changes?: unknown } }).meta;
  const changes = meta?.changes ?? (result as { changes?: unknown }).changes;
  return typeof changes === "number" ? changes : typeof changes === "bigint" ? Number(changes) : null;
}

function storedSettings(settingsJson: string): Record<string, string> {
  try {
    const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (TENANT_SETTING_KEYS.includes(name) && typeof value === "string") out[name] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const TOO_LARGE = Symbol("too_large");

async function readJson(req: Request): Promise<unknown | typeof TOO_LARGE> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return TOO_LARGE;
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return TOO_LARGE;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : header;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
