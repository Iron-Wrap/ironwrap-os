export const APP_API_VERSION = 1;
export const APP_SESSION_COOKIE = "__Host-ironwrap_session";
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const AUTH_THROTTLE_WINDOW_SECONDS = 15 * 60;
export const MAGIC_LINK_REQUEST_EMAIL_LIMIT = 5;
export const MAGIC_LINK_REQUEST_IP_LIMIT = 20;
export const MAGIC_LINK_CONSUME_IP_LIMIT = 30;
export const DEVICE_PAIRING_TTL_SECONDS = 10 * 60;
export const APP_DEVICE_PROOF_HEADER = "x-ironwrap-device-proof";

export type AppRole = "owner" | "ops" | "field";

export type AppEnv = Env & {
  APP_BFF_ENABLED?: string;
  APP_TENANT_ID?: string;
  APP_TENANT_NAME?: string;
  APP_TENANT_BRAND?: string;
  APP_LOCALE?: string;
  APP_TIME_ZONE?: string;
  APP_CURRENCY?: string;
  APP_PUBLIC_ORIGIN?: string;
  APP_ALLOWED_ORIGINS?: string;
  APP_ALLOW_INSECURE_LOCAL?: string;
  APP_AUTH_PEPPER?: string;
  APP_FRAPPE_REQUEST_TIMEOUT_MS?: string;
  APP_APPROVAL_BROKER_URL?: string;
  APP_APPROVAL_BROKER_KEY_ID?: string;
  APP_APPROVAL_APPROVER_ID?: string;
  APP_APPROVAL_MAX_SESSION_AGE_SECONDS?: string;
  APP_APPROVAL_BROKER_TIMEOUT_MS?: string;
  APP_APPROVAL_EXECUTION_LEASE_SECONDS?: string;
  APPROVAL_BROKER_SHARED_SECRET?: string;
  ERPNEXT_BASE_URL?: string;
  ERPNEXT_API_KEY?: string;
  ERPNEXT_API_SECRET?: string;
};

export interface AppUserRecord {
  user_id: string;
  tenant_id: string;
  email_normalized: string;
  display_name: string;
  role: AppRole;
  frappe_user_id: string | null;
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AppSessionRecord extends AppUserRecord {
  session_hash: string;
  session_created_at: string;
  session_expires_at: string;
  revoked_at: string | null;
  device_id: string | null;
  device_proof_hash: string | null;
}

export interface AppDeviceRecord {
  device_id: string;
  tenant_id: string;
  user_id: string;
  field_user_name: string;
  paired_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
}

export interface AuthContext {
  session: AppSessionRecord;
  rawSessionToken: string;
  csrfToken: string;
  permissions: string[];
}

export interface ProvisionAppUserInput {
  tenant_id: string;
  email_normalized: string;
  display_name: string;
  role: AppRole;
  frappe_user_id: string | null;
  active: boolean;
  provisioned_by: string;
}

export interface AuthRequestContext {
  ip_hash: string;
  user_agent_hash: string;
}

export interface AppTenantPublic {
  id: string;
  name: string;
  brand: string;
  locale: string;
  time_zone: string;
  currency: string;
}

export const ROLE_PERMISSIONS: Readonly<Record<AppRole, readonly string[]>> = {
  owner: ["session:read", "jobs:read:any", "owner:read", "sales:read", "approvals:read", "approvals:decide"],
  ops: ["session:read", "jobs:read:any", "owner:read", "sales:read", "approvals:read", "approvals:prepare"],
  field: ["session:read", "jobs:read:assigned", "field:write:assigned"],
};

export function permissionsForRole(role: AppRole): string[] {
  return [...ROLE_PERMISSIONS[role]];
}
