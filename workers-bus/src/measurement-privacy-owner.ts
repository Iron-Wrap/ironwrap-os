import type { AppEnv, AuthContext } from "./app-types.ts";

export const privatePrivacyJson = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });

export async function isCurrentPrivacyOwner(
  env: AppEnv,
  auth: AuthContext,
): Promise<boolean> {
  if (
    auth.session.role !== "owner" ||
    auth.session.tenant_id !== env.APP_TENANT_ID
  )
    return false;
  const current = await env.DB.prepare(
    "SELECT COALESCE(access_role, role) AS role FROM app_users WHERE tenant_id=? AND user_id=? AND active=1",
  )
    .bind(auth.session.tenant_id, auth.session.user_id)
    .first<{ role: string }>();
  return current?.role === "owner";
}
