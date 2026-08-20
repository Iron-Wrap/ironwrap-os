// accounting-api-fixture.ts - the route-level harness for the money desk BFF (slice S8).
//
// Two things separate it from `accounting-fixture.ts`, and both exist because a route test that
// does not have them proves less than it looks like it proves:
//
//  1. **It speaks D1's error dialect.** Real D1 never surfaces SQLite's bare text; it wraps every
//     failure as `D1_ERROR: <message>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`.
//     `accounting-api.ts` extracts the `accounting_…` code from that string to answer 409 rather
//     than 502, so a harness that forwarded `node:sqlite`'s plain message would let the whole
//     409-as-502 defect class ship green - exactly what happened on the service-case lane
//     (Multica ELEC-22 section 5), and the reason `service-cases-api.test.ts` carries the same
//     wrapper.
//  2. **It goes through the real dispatch path.** Every call below enters
//     `handleAuthenticatedRoute`, so the router, the permission set built from `ROLE_PERMISSIONS`,
//     CSRF, and the idempotency header are all executed rather than assumed.

import { DatabaseSync } from "node:sqlite";

import { handleAuthenticatedRoute, type AppRouteDeps } from "../src/app-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";
import { ACCOUNTING_MIGRATIONS, NOW, TENANT, readAccountingMigration } from "./accounting-fixture.ts";

export const ACCOUNTANT_ID = "appu_accounting_0001";
export const SECOND_ACCOUNTANT_ID = "appu_accounting_0002";
export const OWNER_ID = "appu_owner_0001";
export const OPS_ID = "appu_ops_0001";
export const SALES_ID = "appu_sales_0001";

/** Extended SQLite result codes D1 names in its wrapper; the low byte of each is `SQLITE_CONSTRAINT`. */
const SQLITE_EXTENDED_CONSTRAINT: Record<number, string> = {
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
};

function asD1Error(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const errcode = (error as { errcode?: number }).errcode ?? 0;
  if ((errcode & 0xff) !== 19) return new Error(`D1_ERROR: ${error.message}: SQLITE_ERROR`);
  const extended = SQLITE_EXTENDED_CONSTRAINT[errcode];
  const detail = extended ? `SQLITE_CONSTRAINT (extended: ${extended})` : "SQLITE_CONSTRAINT";
  return new Error(`D1_ERROR: ${error.message}: ${detail}`);
}

function throughD1<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw asD1Error(error);
  }
}

/**
 * The money-plane schema behind a D1-shaped facade that fails the way D1 fails.
 *
 * `meta.changes` is taken from `total_changes()` deltas rather than `sqlite3_changes()`, matching
 * D1: `0058`-`0061` write through AFTER triggers, and a facade that reported only the direct row
 * would hide any guard that mis-reads a triggered write.
 */
export class AccountingApiTestD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of ACCOUNTING_MIGRATIONS) {
      this.raw.exec(readAccountingMigration(migration));
    }
    const insert = this.raw.prepare(
      `INSERT INTO app_users (
         user_id, tenant_id, email_normalized, display_name, role, access_role,
         active, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    const seed = (userId: string, tenantId: string, accessRole: AppRole) => {
      insert.run(
        userId, tenantId, `${userId}@example.invalid`, accessRole,
        // `role` keeps the legacy three-value column; `access_role` is the effective one.
        accessRole === "accounting" || accessRole === "sales" ? "ops" : accessRole,
        accessRole, NOW.toISOString(), NOW.toISOString(),
      );
    };
    seed(OWNER_ID, TENANT, "owner");
    seed(OPS_ID, TENANT, "ops");
    seed(SALES_ID, TENANT, "sales");
    seed(ACCOUNTANT_ID, TENANT, "accounting");
    seed(SECOND_ACCOUNTANT_ID, TENANT, "accounting");
  }

  private totalChanges(): number {
    return Number(
      (this.raw.prepare("SELECT total_changes() AS total").get() as { total: number }).total,
    );
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = throughD1(() => this.raw.prepare(sql));
        return {
          first: async <T>(column?: string) =>
            throughD1(() => {
              const row = statement.get(...(args as never[])) as Record<string, unknown> | undefined;
              if (!row) return null;
              return (column === undefined ? row : row[column]) as T | null;
            }),
          all: async <T>() =>
            throughD1(() => ({
              success: true as const,
              results: statement.all(...(args as never[])) as T[],
              meta: { changes: 0 },
            })),
          run: async () =>
            throughD1(() => {
              const before = this.totalChanges();
              statement.run(...(args as never[]));
              return {
                success: true as const,
                results: [] as [],
                meta: { changes: this.totalChanges() - before },
              };
            }),
        };
      },
    };
  }
}

export function apiTestEnv(): { env: AppEnv; db: AccountingApiTestD1 } {
  const db = new AccountingApiTestD1();
  return {
    env: {
      DB: db as never,
      APP_TENANT_ID: TENANT,
      APP_ALLOW_INSECURE_LOCAL: "true",
    } as AppEnv,
    db,
  };
}

const USER_BY_ROLE: Readonly<Record<AppRole, string>> = {
  owner: OWNER_ID,
  ops: OPS_ID,
  sales: SALES_ID,
  production: SALES_ID,
  accounting: ACCOUNTANT_ID,
  field: SALES_ID,
};

/**
 * A session for one role, with the permission set the runtime really builds.
 *
 * `permissions` comes from `permissionsForRole` rather than a literal, so a permission removed
 * from `ROLE_PERMISSIONS` turns these tests red instead of leaving them asserting a set nobody
 * grants any more.
 */
export function auth(
  role: AppRole,
  options: { userId?: string; tenantId?: string } = {},
): AuthContext {
  const now = new Date();
  const userId = options.userId ?? USER_BY_ROLE[role];
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: new Date(now.getTime() - 60_000).toISOString(),
      session_expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
      revoked_at: null,
      device_id: null,
      device_proof_hash: null,
      user_id: userId,
      tenant_id: options.tenantId ?? TENANT,
      email_normalized: `${userId}@example.invalid`,
      display_name: role,
      role,
      frappe_user_id: null,
      active: 1,
      created_by: OWNER_ID,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
  } as AuthContext;
}

export interface CallOptions {
  body?: Record<string, unknown>;
  csrf?: boolean;
  idempotencyKey?: string | null;
  userId?: string;
  tenantId?: string;
  /**
   * The optional route seams, threaded through the real router.
   *
   * Only the money desk's provider-observation binding so far, and it exists so a route that
   * reaches QuickBooks can be driven against a synthetic Intuit double *without* the test
   * stepping outside `handleAuthenticatedRoute` - the permission set, the CSRF check and the
   * idempotency header are still executed on the way in, which is the whole reason this harness
   * goes through the real dispatch path.
   */
  deps?: AppRouteDeps;
}

export async function call(
  env: AppEnv,
  role: AppRole,
  method: "GET" | "POST",
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (options.csrf !== false) headers.set("x-csrf-token", "csrf");
  if (options.body) headers.set("content-type", "application/json");
  const key = options.idempotencyKey === undefined
    ? `idem-${method}-${path.replace(/[^A-Za-z0-9]/g, "-")}`.slice(0, 120).padEnd(16, "0")
    : options.idempotencyKey;
  if (key !== null) headers.set("idempotency-key", key);

  const request = new Request(`https://app.example.com${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const response = await handleAuthenticatedRoute(
    request,
    env,
    auth(role, {
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    }),
    options.deps ?? {},
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
