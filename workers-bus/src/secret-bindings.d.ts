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
  QB_WEBHOOK_TOKEN: string;
  ERPNEXT_API_KEY: string;
  ERPNEXT_API_SECRET: string;
  PUBLIC_ESTIMATE_TURNSTILE_SECRET: string;
  PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: string;
  APP_AUTH_PEPPER: string;
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
    QB_WEBHOOK_TOKEN: string;
    ERPNEXT_API_KEY: string;
    ERPNEXT_API_SECRET: string;
    PUBLIC_ESTIMATE_TURNSTILE_SECRET: string;
    PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER: string;
    APP_AUTH_PEPPER: string;
    APPROVAL_BROKER_SHARED_SECRET: string;
    QUOTE_REVISION_BROKER_SHARED_SECRET: string;
    PRODUCTION_SCHEDULE_BROKER_SHARED_SECRET: string;
  }
}
