import { gmailConfigured } from "./google.ts";
import type { AppEnv } from "./app-types.ts";

export function customerAcceptanceBackendEnabled(env: AppEnv): boolean {
  return String(env.APP_CUSTOMER_CONTRACT_ACCEPTANCE_ENABLED) === "true";
}

export function customerAcceptanceHmacKey(env: AppEnv): string | null {
  const value = env.APP_CUSTOMER_ACCEPTANCE_HMAC_KEY?.trim() ?? "";
  return value.length >= 32 ? value : null;
}

export function customerAcceptanceFrappeApiKey(env: AppEnv): string | null {
  return env.APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_KEY?.trim() || null;
}

export function customerAcceptanceFrappeApiSecret(env: AppEnv): string | null {
  return env.APP_CUSTOMER_ACCEPTANCE_FRAPPE_API_SECRET?.trim() || null;
}

export function customerAcceptanceBackendConfigured(env: AppEnv): boolean {
  return customerAcceptanceBackendEnabled(env) && !!customerAcceptanceHmacKey(env) &&
    !!customerAcceptanceFrappeApiKey(env) && !!customerAcceptanceFrappeApiSecret(env) &&
    gmailConfigured(env);
}
