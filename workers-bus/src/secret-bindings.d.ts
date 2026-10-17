/**
 * Secret binding names are part of the Worker compile-time contract, but their values are not.
 *
 * Wrangler augments `Env` from a developer's `.dev.vars` when that file exists. CI and clean
 * production build hosts deliberately have no secret values, so those names must be declared
 * independently of local state. Runtime presence is still enforced by readiness checks.
 */
interface Env {
  INGEST_TOKEN: string;
  ADMIN_TOKEN: string;
  EFFECT_RUNTIME_TOKEN: string;
  /** The AI team host's bearer for /api/v1/agents/*; unset keeps that surface dark. */
  AGENT_HOST_TOKEN: string;
  NEWO_WEBHOOK_TOKEN: string;
  NEWO_API_KEY: string;
  NEWO_BOOKING_TOKEN: string;
  NEWO_CONTROL_SIGNING_SECRET: string;
  JOBNIMBUS_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  /**
   * LEGACY deployment-owned recipient mapping for governed pipeline automation.
   *
   * Superseded by the tenant-administered catalog in `automation-recipients.ts` (ELEC-204).
   * It is now read only as a fallback, for a tenant that has never written a recipient record
   * of its own, so existing deployments keep delivering across the change. Do not add a
   * destination here for a new deployment - an owner adds one through
   * `POST /api/v1/admin/automation-recipients`, with no secret rotation and no deploy.
   */
  PIPELINE_AUTOMATION_RECIPIENTS_JSON: string;
  /** Google Maps Platform key (Solar API cross-check); absence disables the check. */
  GOOGLE_MAPS_API_KEY: string;
  MEASUREMENT_OCR_API_KEY: string;
  QB_WEBHOOK_TOKEN: string;
  QB_CLIENT_ID: string;
  QB_CLIENT_SECRET: string;
  QB_TOKEN_ENCRYPTION_KEY: string;
  QB_FINAL_INVOICE_FRAPPE_API_KEY: string;
  QB_FINAL_INVOICE_FRAPPE_API_SECRET: string;
  /** Non-secret tenant configuration: exact QuickBooks company realm. */
  QB_EXPECTED_REALM_ID: string;
  /** Non-secret expected Frappe principal for the bounded QuickBooks issuer. */
  QB_RECONCILIATION_ISSUER_USER: string;
  QB_RECONCILIATION_ISSUER_API_KEY: string;
  QB_RECONCILIATION_ISSUER_API_SECRET: string;
  ERPNEXT_API_KEY: string;
  ERPNEXT_API_SECRET: string;
  /** Per-rail Frappe issuers; never the broad ERPNEXT pair (rail-frappe-credentials.ts). */
  FLEET_CAPTURE_FRAPPE_API_KEY: string;
  FLEET_CAPTURE_FRAPPE_API_SECRET: string;
  WORK_PACKAGE_FRAPPE_API_KEY: string;
  WORK_PACKAGE_FRAPPE_API_SECRET: string;
  PUBLIC_ESTIMATE_TURNSTILE_SECRET: string;
  PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: string;
  APP_AUTH_PEPPER: string;
  FACET_DESIGN_INGEST_HMAC_KEY: string;
  FACET_DESIGN_INGEST_TENANT_MAP_JSON: string;
  /** Rotating Facet v2 verification keys. Secret JSON; never a Wrangler var. */
  FACET_V2_KEYS_JSON: string;
  /** Shared only with the Facet launch verifier; never reused for v2 event delivery. */
  FACET_LAUNCH_HMAC_KEY: string;
  FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: string;
  FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: string;
  FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: string;
  POSTIZ_API_KEY: string;
  APPROVAL_BROKER_SHARED_SECRET: string;
  QUOTE_REVISION_BROKER_SHARED_SECRET: string;
  PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: string;
}

declare namespace Cloudflare {
  interface Env {
    INGEST_TOKEN: string;
    ADMIN_TOKEN: string;
    EFFECT_RUNTIME_TOKEN: string;
    AGENT_HOST_TOKEN: string;
    NEWO_WEBHOOK_TOKEN: string;
    NEWO_API_KEY: string;
    NEWO_BOOKING_TOKEN: string;
    NEWO_CONTROL_SIGNING_SECRET: string;
    JOBNIMBUS_API_KEY: string;
    GOOGLE_SERVICE_ACCOUNT_JSON: string;
    PIPELINE_AUTOMATION_RECIPIENTS_JSON: string;
    GOOGLE_MAPS_API_KEY: string;
    MEASUREMENT_OCR_API_KEY: string;
    QB_WEBHOOK_TOKEN: string;
    QB_CLIENT_ID: string;
    QB_CLIENT_SECRET: string;
    QB_TOKEN_ENCRYPTION_KEY: string;
    QB_FINAL_INVOICE_FRAPPE_API_KEY: string;
    QB_FINAL_INVOICE_FRAPPE_API_SECRET: string;
    QB_EXPECTED_REALM_ID: string;
    QB_RECONCILIATION_ISSUER_USER: string;
    QB_RECONCILIATION_ISSUER_API_KEY: string;
    QB_RECONCILIATION_ISSUER_API_SECRET: string;
    ERPNEXT_API_KEY: string;
    ERPNEXT_API_SECRET: string;
    FLEET_CAPTURE_FRAPPE_API_KEY: string;
    FLEET_CAPTURE_FRAPPE_API_SECRET: string;
    WORK_PACKAGE_FRAPPE_API_KEY: string;
    WORK_PACKAGE_FRAPPE_API_SECRET: string;
    PUBLIC_ESTIMATE_TURNSTILE_SECRET: string;
    PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: string;
    APP_AUTH_PEPPER: string;
    FACET_DESIGN_INGEST_HMAC_KEY: string;
    FACET_DESIGN_INGEST_TENANT_MAP_JSON: string;
    FACET_V2_KEYS_JSON: string;
    FACET_LAUNCH_HMAC_KEY: string;
    FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: string;
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: string;
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: string;
    POSTIZ_API_KEY: string;
    APPROVAL_BROKER_SHARED_SECRET: string;
    QUOTE_REVISION_BROKER_SHARED_SECRET: string;
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: string;
  }
}
