/**
 * A minimal stand-in for the onboarding surfaces' dependencies: an in-memory R2 for the company
 * profile document, an in-memory D1 for the two tables these routes touch (`app_users` and the
 * envelope/audit rows a hand-entered lead writes), and a hand-built `AuthContext` so a test can
 * call `handleAuthenticatedRoute` without driving a magic link first.
 */
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";
import { permissionsForRole } from "../src/app-types.ts";

export const TEST_ORIGIN = "https://app.example.com";
export const TEST_CSRF = "csrf-token-for-tests";

export class MemoryR2 {
  objects = new Map<string, { body: Uint8Array; contentType: string }>();
  deletedKeys: string[] = [];

  async get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.body;
    return {
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      get body() {
        return new Blob([bytes as unknown as BlobPart]).stream();
      },
    };
  }

  async put(
    key: string,
    body: string | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.objects.set(key, {
      body: bytes,
      contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
    });
  }

  async delete(key: string) {
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }
}

export interface StoredAppUser {
  user_id: string;
  tenant_id: string;
  email_normalized: string;
  display_name: string;
  role: string;
  access_role: AppRole;
  frappe_user_id: string | null;
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Only the statements the onboarding routes issue are modelled. Anything else returns an empty
 * result rather than throwing, so an unrelated audit insert does not fail a profile test.
 */
export class OnboardingMemoryDb {
  users: StoredAppUser[] = [];
  envelopes: Array<Record<string, unknown>> = [];
  audits: Array<Record<string, unknown>> = [];
  dedupClaims = new Map<string, {
    dedup_key: string;
    first_envelope_id: string;
    first_seen_at: string;
    updated_at: string;
  }>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => this.first(sql, args) as T | null,
        run: async () => this.run(sql, args),
        all: async <T>() => ({ results: this.all(sql, args) as T[] }),
      }),
    };
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  private first(sql: string, args: unknown[]): unknown {
    if (sql.includes("FROM app_users") && sql.includes("email_normalized = ?")) {
      const user = this.users.find(
        (candidate) => candidate.tenant_id === String(args[0]) &&
          candidate.email_normalized === String(args[1]),
      );
      return user ? { ...user, role: user.access_role } : null;
    }
    if (sql.includes("FROM dedup_claims")) {
      return this.dedupClaims.get(String(args[0])) ?? null;
    }
    return null;
  }

  private all(sql: string, args: unknown[]): unknown[] {
    if (sql.includes("FROM app_users")) {
      return this.users
        .filter((user) => user.tenant_id === String(args[0]))
        .filter((user) => !sql.includes("access_role = 'field'") || user.access_role === "field")
        .filter((user) => !sql.includes("active = 1") || user.active === 1)
        .map((user) => ({ ...user, role: user.access_role }))
        .sort(
          (left, right) =>
            right.active - left.active ||
            left.display_name.localeCompare(right.display_name),
        );
    }
    return [];
  }

  private run(sql: string, args: unknown[]): { success: true; meta: { changes: number } } {
    if (sql.includes("UPDATE app_users") && sql.includes("display_name = ?")) {
      const [
        displayName,
        role,
        accessRole,
        frappeUserId,
        active,
        updatedAt,
        tenantId,
        email,
        userId,
        expectedRole,
        expectedActive,
        expectedUpdatedAt,
      ] = args;
      const existing = this.users.find(
        (user) => user.tenant_id === String(tenantId) &&
          user.email_normalized === String(email) && user.user_id === String(userId),
      );
      if (
        !existing || existing.access_role !== expectedRole ||
        existing.active !== Number(expectedActive) ||
        existing.updated_at !== String(expectedUpdatedAt)
      ) return { success: true, meta: { changes: 0 } };
      existing.display_name = String(displayName);
      existing.role = String(role);
      existing.access_role = accessRole as AppRole;
      existing.frappe_user_id = frappeUserId === null ? null : String(frappeUserId);
      existing.active = Number(active);
      existing.updated_at = String(updatedAt);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO app_users")) {
      const [
        userId, tenantId, email, displayName, role, accessRole, frappeUserId, active, createdBy,
        createdAt, updatedAt,
      ] = args;
      const existing = this.users.find(
        (user) => user.tenant_id === String(tenantId) && user.email_normalized === String(email),
      );
      if (existing) {
        existing.display_name = String(displayName);
        existing.role = String(role);
        existing.access_role = accessRole as AppRole;
        existing.frappe_user_id = frappeUserId === null ? null : String(frappeUserId);
        existing.active = Number(active);
        existing.updated_at = String(updatedAt);
        return { success: true, meta: { changes: 1 } };
      }
      this.users.push({
        user_id: String(userId),
        tenant_id: String(tenantId),
        email_normalized: String(email),
        display_name: String(displayName),
        role: String(role),
        access_role: accessRole as AppRole,
        frappe_user_id: frappeUserId === null ? null : String(frappeUserId),
        active: Number(active),
        created_by: String(createdBy),
        created_at: String(createdAt),
        updated_at: String(updatedAt),
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO dedup_claims")) {
      const [key, envelopeId, seenAt, updatedAt] = args.map(String);
      if (this.dedupClaims.has(key!)) throw new Error("UNIQUE constraint failed");
      this.dedupClaims.set(key!, {
        dedup_key: key!,
        first_envelope_id: envelopeId!,
        first_seen_at: seenAt!,
        updated_at: updatedAt!,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO envelopes")) {
      this.envelopes.push({ envelope_id: args[0], source: args[1], payload_json: args[6] });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO audit_log")) {
      this.audits.push({ sql, args });
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
}

export interface OnboardingEnvHandles {
  env: AppEnv;
  db: OnboardingMemoryDb;
  raw: MemoryR2;
  queued: Array<{ envelope_id: string }>;
}

export function onboardingEnv(overrides: Partial<AppEnv> = {}): OnboardingEnvHandles {
  const db = new OnboardingMemoryDb();
  const raw = new MemoryR2();
  const queued: Array<{ envelope_id: string }> = [];
  const env = {
    APP_BFF_ENABLED: "true",
    APP_TENANT_ID: "freshco",
    APP_TENANT_NAME: "FreshCo Exteriors",
    APP_TENANT_BRAND: "FreshCo",
    APP_LOCALE: "en-CA",
    APP_TIME_ZONE: "America/Edmonton",
    APP_CURRENCY: "CAD",
    APP_PUBLIC_ORIGIN: TEST_ORIGIN,
    APP_ALLOWED_ORIGINS: TEST_ORIGIN,
    APP_ALLOW_INSECURE_LOCAL: "false",
    APP_AUTH_PEPPER: "test-only-pepper-which-is-longer-than-thirty-two-characters",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    PUBLIC_ESTIMATE_ALLOWED_BRANDS: "freshco",
    JOBNIMBUS_ENABLED: "false",
    ERPNEXT_ENABLED: "false",
    FROM_EMAIL: "sales@freshco.example",
    OWNER_ALERT_EMAIL: "owner@freshco.example",
    DB: db,
    RAW: raw,
    JN_QUEUE: {
      async send(message: { envelope_id: string }) {
        queued.push(message);
      },
    },
    ...overrides,
  } as unknown as AppEnv;
  return { env, db, raw, queued };
}

export function authFor(role: AppRole, overrides: Partial<AuthContext["session"]> = {}): AuthContext {
  return {
    session: {
      user_id: `appu_${role}`,
      tenant_id: "freshco",
      email_normalized: `${role}@freshco.example`,
      display_name: `${role} user`,
      role,
      frappe_user_id: null,
      active: 1,
      created_by: "system",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
      session_hash: "session-hash",
      session_created_at: "2026-08-22T00:00:00.000Z",
      session_expires_at: "2036-08-22T00:00:00.000Z",
      revoked_at: null,
      device_id: null,
      device_proof_hash: null,
      ...overrides,
    },
    rawSessionToken: "raw-session-token",
    csrfToken: TEST_CSRF,
    permissions: permissionsForRole(role),
  };
}

export function apiRequest(
  path: string,
  init: { method?: string; body?: unknown; csrf?: string | null } = {},
): Request {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.csrf !== null) headers["x-csrf-token"] = init.csrf ?? TEST_CSRF;
  return new Request(`https://worker.example.com${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** A 1×1 PNG, the smallest input that satisfies the upload's magic-byte check. */
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
