import type { AppEnv } from "./app-types.ts";

/**
 * A recorded material preference is a provisional customer signal, not a legal act, so it keeps a
 * configuration surface separate from contract acceptance: a site may publish curated options and
 * collect selections without ever holding the acceptance signing credentials, and vice versa. The
 * Frappe identity behind these credentials is the dedicated decision service role, which can
 * create a Customer Decision and its receipt evidence and nothing else.
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
 * Fail closed on absent credentials. The enablement flag alone never opens the write path, which
 * is what keeps a deployed environment dark until an operator has actually provisioned the
 * dedicated Frappe service user.
 */
export function customerDecisionBackendConfigured(env: AppEnv): boolean {
  return customerDecisionBackendEnabled(env) && !!customerDecisionHmacKey(env) &&
    !!customerDecisionFrappeApiKey(env) && !!customerDecisionFrappeApiSecret(env);
}
