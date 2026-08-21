import type { AppEnv } from "./app-types.ts";

/**
 * A recorded material preference is a provisional customer signal, not a legal act, so it keeps a
 * configuration surface separate from contract acceptance: a site may publish curated options and
 * collect selections without ever holding the acceptance signing credentials, and vice versa.
 * Leftover Frappe service-user helpers remain for projection compatibility and are not required
 * for the native D1 commit.
 */
export function customerDecisionBackendEnabled(env: AppEnv): boolean {
  return String(env.APP_CUSTOMER_PORTAL_DECISION_ENABLED) === "true";
}

export function customerDecisionHmacKey(env: AppEnv): string | null {
  const value = env.APP_CUSTOMER_DECISION_HMAC_KEY?.trim() ?? "";
  return value.length >= 32 ? value : null;
}

export function customerDecisionFrappeApiKey(env: AppEnv): string | null {
  return env.APP_CUSTOMER_DECISION_FRAPPE_API_KEY?.trim() || null;
}

export function customerDecisionFrappeApiSecret(env: AppEnv): string | null {
  return env.APP_CUSTOMER_DECISION_FRAPPE_API_SECRET?.trim() || null;
}

/**
 * Fail closed on an absent HMAC. The enablement flag alone never opens the write path. Leftover
 * Frappe service-user bindings are not required for the native D1 commit.
 */
export function customerDecisionBackendConfigured(env: AppEnv): boolean {
  return customerDecisionBackendEnabled(env) && !!customerDecisionHmacKey(env);
}
