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
  NEWO_WEBHOOK_TOKEN: string;
  NEWO_API_KEY: string;
  NEWO_BOOKING_TOKEN: string;
  NEWO_CONTROL_SIGNING_SECRET: string;
  JOBNIMBUS_API_KEY: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  /** Google Maps Platform key (Solar API cross-check); absence disables the check. */
  GOOGLE_MAPS_API_KEY: string;
  QB_WEBHOOK_TOKEN: string;
  /** Non-secret tenant configuration: exact QuickBooks company realm. */
  QB_EXPECTED_REALM_ID: string;
  /** Non-secret expected Frappe principal for the bounded QuickBooks issuer. */
  QB_RECONCILIATION_ISSUER_USER: string;
  QB_RECONCILIATION_ISSUER_API_KEY: string;
  QB_RECONCILIATION_ISSUER_API_SECRET: string;
  ERPNEXT_API_KEY: string;
  ERPNEXT_API_SECRET: string;
  PUBLIC_ESTIMATE_TURNSTILE_SECRET: string;
  PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: string;
  APP_AUTH_PEPPER: string;
  APP_CUSTOMER_ACCEPTANCE_HMAC_KEY: string;
  APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY: string;
  APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET: string;
  FACET_DESIGN_INGEST_HMAC_KEY: string;
  FACET_DESIGN_INGEST_TENANT_MAP_JSON: string;
  FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: string;
  FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: string;
  FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: string;
  FACET_DESIGN_FRAPPE_PROJECTION_ASSOCIATIONS_JSON: string;
  APPROVAL_BROKER_SHARED_SECRET: string;
  QUOTE_REVISION_BROKER_SHARED_SECRET: string;
  PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: string;
}

declare namespace Cloudflare {
  interface Env {
    INGEST_TOKEN: string;
    ADMIN_TOKEN: string;
    NEWO_WEBHOOK_TOKEN: string;
    NEWO_API_KEY: string;
    NEWO_BOOKING_TOKEN: string;
    NEWO_CONTROL_SIGNING_SECRET: string;
    JOBNIMBUS_API_KEY: string;
    GOOGLE_SERVICE_ACCOUNT_JSON: string;
    GOOGLE_MAPS_API_KEY: string;
    QB_WEBHOOK_TOKEN: string;
    QB_EXPECTED_REALM_ID: string;
    QB_RECONCILIATION_ISSUER_USER: string;
    QB_RECONCILIATION_ISSUER_API_KEY: string;
    QB_RECONCILIATION_ISSUER_API_SECRET: string;
    ERPNEXT_API_KEY: string;
    ERPNEXT_API_SECRET: string;
    PUBLIC_ESTIMATE_TURNSTILE_SECRET: string;
    PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: string;
    APP_AUTH_PEPPER: string;
    APP_CUSTOMER_ACCEPTANCE_HMAC_KEY: string;
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY: string;
    APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET: string;
    FACET_DESIGN_INGEST_HMAC_KEY: string;
    FACET_DESIGN_INGEST_TENANT_MAP_JSON: string;
    FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: string;
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: string;
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: string;
    FACET_DESIGN_FRAPPE_PROJECTION_ASSOCIATIONS_JSON: string;
    APPROVAL_BROKER_SHARED_SECRET: string;
    QUOTE_REVISION_BROKER_SHARED_SECRET: string;
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: string;
  }
}
