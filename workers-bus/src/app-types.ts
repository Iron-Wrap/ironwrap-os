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

export type AppRole = "owner" | "ops" | "sales" | "production" | "accounting" | "field";

/** Immutable parent/context envelope for universal physical-work routes. */
export interface WorkObjectScope {
  workObjectType: string;
  workObjectId: string;
  physicalContextType: string;
  physicalContextId: string;
}

export type AppEnv = Env & {
  APP_BFF_ENABLED?: string;
  // Dedicated owner/ops desktop draft pilot. False by default and separate from
  // field-device pairing, browser sessions, and every approved-write rail.
  APP_HERMES_DESKTOP_ENABLED?: string;
  // The native desktop and hosted reference paths share one persisted provider request.
  // A real provider model must be configured explicitly; source never chooses one.
  APP_HERMES_PROVIDER_MODEL?: string;
  // Reference execution remains separately disabled even when desktop pairing is enabled.
  APP_HERMES_HOSTED_REFERENCE_ENABLED?: string;
  // A customer portal is a separately activated, read-only capability surface. It never
  // inherits an office BFF session or the office read-model allowlists.
  APP_CUSTOMER_PORTAL_ENABLED?: string;
  // Customer contract signing is a distinct, false-by-default capability. It requires its own
  // enablement in addition to a portal, email transport, Frappe service auth, and HMAC secret.
  APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED?: string;
  APP_TENANT_ID?: string;
  APP_TENANT_NAME?: string;
  APP_TENANT_BRAND?: string;
  APP_LOCALE?: string;
  APP_TIME_ZONE?: string;
  APP_CURRENCY?: string;
  APP_PUBLIC_ORIGIN?: string;
  APP_ALLOWED_ORIGINS?: string;
  APP_ALLOW_INSECURE_LOCAL?: string;
  APP_FIRST_OWNER_BOOTSTRAP_ENABLED?: string;
  // Exact comma-separated HTTPS origins allowed to supply office-only visual-model previews.
  // This is intentionally separate from browser CORS origins; unset means previews stay hidden.
  APP_VISUAL_PREVIEW_ALLOWED_ORIGINS?: string;
  APP_AUTH_PEPPER?: string;
  // Dedicated shared secret for the narrow customer-contract preparation/commit methods.
  // It must never be reused for browser sessions, portal links, or approval brokers.
  APP_CUSTOMER_ACCEPTANCE_HMAC_KEY?: string;
  // Dedicated Frappe service credentials for customer-contract preparation/commit only. These
  // must not fall back to the broad ERPNEXT_API_KEY/ERPNEXT_API_SECRET used by the app BFF.
  APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY?: string;
  APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET?: string;
  APP_FRAPPE_REQUEST_TIMEOUT_MS?: string;
  // Exact Frappe identities authorized to see restricted insurance-proof state in the app BFF.
  // This is deliberately separate from broad `ops` access and defaults to no estimator access.
  APP_INSURANCE_ESTIMATOR_FRAPPE_USERS?: string;
  APP_APPROVAL_BROKER_URL?: string;
  APP_APPROVAL_BROKER_KEY_ID?: string;
  APP_APPROVAL_APPROVER_ID?: string;
  APP_APPROVAL_MAX_SESSION_AGE_SECONDS?: string;
  APP_APPROVAL_BROKER_TIMEOUT_MS?: string;
  APP_APPROVAL_EXECUTION_LEASE_SECONDS?: string;
  APPROVAL_BROKER_SHARED_SECRET?: string;
  // Quote revisions have their own broker, signing secret, and execution
  // lease. Never route them through the fixed lead-triage authority.
  APP_QUOTE_REVISION_BROKER_URL?: string;
  APP_QUOTE_REVISION_BROKER_KEY_ID?: string;
  APP_QUOTE_REVISION_BROKER_TIMEOUT_MS?: string;
  APP_QUOTE_REVISION_EXECUTION_LEASE_SECONDS?: string;
  QUOTE_REVISION_BROKER_SHARED_SECRET?: string;
  // A durable Facet association may prepare the existing quote-revision approval rail only
  // after this separate, false-by-default capability is explicitly enabled.
  APP_FACET_QUOTE_REVISION_PREPARE_ENABLED?: string;
  // Governed Facet launch is a distinct owner-only capability. The source tenant must match one
  // exact static v2 route; the HMAC key is declared only in the secret binding contract.
  APP_FACET_LAUNCH_ENABLED?: string;
  APP_FACET_LAUNCH_BASE_URL?: string;
  APP_FACET_LAUNCH_SOURCE_TENANT_ID?: string;
  FACET_LAUNCH_HMAC_KEY?: string;
  // Postiz is an execution adapter only. The API key remains a Worker secret;
  // D1 and the browser receive only opaque integration ids and bounded receipts.
  // Every provider mutation adapter is fail-closed behind the durable universal effect ledger.
  // Unit-only callers may omit this flag; deployed Worker environments set it explicitly.
  EFFECT_RUNTIME_ENABLED?: string;
  POSTIZ_ENABLED?: string;
  POSTIZ_EXPECTED_VERSION?: string;
  POSTIZ_API_BASE_URL?: string;
  POSTIZ_API_TIMEOUT_MS?: string;
  POSTIZ_ALLOWED_PROVIDERS?: string;
  POSTIZ_API_KEY?: string;
  POSTIZ_FACET_DRAFT_ENABLED?: string;
  POSTIZ_FACET_DRAFT_PROVIDER?: string;
  POSTIZ_FACET_DRAFT_OFFSET_HOURS?: string;
  POSTIZ_FACET_DRAFT_NOT_BEFORE?: string;
  // QuickBooks authorization and residential final-balance invoicing are two independent,
  // false-by-default capabilities. Provider credentials and the 32-byte bundle key are Worker
  // secrets; D1 and browser projections receive ciphertext or non-secret configuration only.
  QB_OAUTH_ENABLED?: string;
  QB_FINAL_INVOICE_ENABLED?: string;
  QB_API_ENVIRONMENT?: "sandbox" | "production" | string;
  QB_API_MINOR_VERSION?: string;
  QB_EXPECTED_REALM_ID?: string;
  QB_API_TIMEOUT_MS?: string;
  QB_CLIENT_ID?: string;
  QB_CLIENT_SECRET?: string;
  QB_TOKEN_ENCRYPTION_KEY?: string;
  QB_TOKEN_ENCRYPTION_KEY_VERSION?: string;
  QB_FINAL_INVOICE_FRAPPE_API_KEY?: string;
  QB_FINAL_INVOICE_FRAPPE_API_SECRET?: string;
  // Production scheduling is a separate high-consequence authority from lead
  // triage and commercial quote revisions. Its broker identity, approver, and
  // recent-session limit must never inherit another mutation rail by default.
  APP_PRODUCTION_SCHEDULE_BROKER_URL?: string;
  APP_PRODUCTION_SCHEDULE_BROKER_KEY_ID?: string;
  APP_PRODUCTION_SCHEDULE_APPROVER_ID?: string;
  APP_PRODUCTION_SCHEDULE_MAX_SESSION_AGE_SECONDS?: string;
  APP_PRODUCTION_SCHEDULE_BROKER_TIMEOUT_MS?: string;
  APP_PRODUCTION_SCHEDULE_EXECUTION_LEASE_SECONDS?: string;
  PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET?: string;
  ERPNEXT_BASE_URL?: string;
  ERPNEXT_API_KEY?: string;
  ERPNEXT_API_SECRET?: string;
  // Dedicated HMAC for the narrow authority-record executor. Browser sessions
  // and the ordinary app bearer never authorize Frappe authority mutations.
  AUTHORITY_RECORD_EXECUTOR_HMAC_KEY?: string;
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
  owner: [
    "session:read",
    "now:read",
    "today:read",
    "jobs:read:any",
    "owner:read",
    "sales:read",
    "estimator:read",
    "production:read",
    "approvals:read",
    "approvals:prepare",
    "approvals:decide",
    "facet:read",
    "facet:launch",
    "quickbooks:read",
    "quickbooks:review",
    "quickbooks:reconcile",
    "authority:read",
    "authority:write",
  ],
  ops: [
    "session:read",
    "now:read",
    "today:read",
    "jobs:read:any",
    "owner:read",
    "sales:read",
    "estimator:read",
    "production:read",
    "approvals:read",
    "approvals:prepare",
    "facet:read",
    "authority:read",
    "authority:write",
  ],
  sales: [
    "session:read",
    "now:read",
    "sales:read",
    "estimator:read",
    "approvals:read",
    "approvals:prepare",
  ],
  production: ["session:read", "now:read", "jobs:read:any", "production:read", "authority:read"],
  accounting: [
    "session:read",
    "now:read",
    "quickbooks:read",
    "quickbooks:review",
    "quickbooks:reconcile",
  ],
  field: [
    "session:read",
    "today:read",
    "jobs:read:assigned",
    "field:write:assigned",
    "authority:read",
  ],
};

export function permissionsForRole(role: AppRole): string[] {
  return [...ROLE_PERMISSIONS[role]];
}
