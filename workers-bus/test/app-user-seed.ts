// app-user-seed.ts — a person written straight into app_users as a test's starting state. It is
// not a product path: every route changes access through upsertAppUserWithAuthority, with its
// version check and its audit row (0157). This only sets the scene those routes then act on.

import type { AppEnv, AppUserRecord, ProvisionAppUserInput } from "../src/app-types.ts";

export async function seedAppUser(
  env: AppEnv,
  input: ProvisionAppUserInput,
): Promise<AppUserRecord> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active,
        created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id, email_normalized) DO UPDATE SET
       display_name = excluded.display_name,
       role = excluded.role,
       access_role = excluded.access_role,
       frappe_user_id = excluded.frappe_user_id,
       active = excluded.active,
       updated_at = excluded.updated_at`,
  ).bind(
    `appu_${crypto.randomUUID()}`,
    input.tenant_id,
    input.email_normalized,
    input.display_name,
    input.role === "owner" ? "owner" : "ops",
    input.role,
    input.frappe_user_id,
    input.active ? 1 : 0,
    input.provisioned_by,
    now,
    now,
  ).run();
  const row = await env.DB.prepare(
    `SELECT user_id, tenant_id, email_normalized, display_name,
            access_role AS role, access_version, frappe_user_id,
            active, created_by, created_at, updated_at
       FROM app_users WHERE tenant_id = ? AND email_normalized = ? LIMIT 1`,
  ).bind(input.tenant_id, input.email_normalized).first<AppUserRecord>();
  if (!row) throw new Error("seeded app user missing");
  return row;
}
