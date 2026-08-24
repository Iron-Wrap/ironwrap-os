import type { AppEnv } from "./app-types.ts";

/**
 * A recorded material preference is a provisional customer signal, not a legal act, so it keeps a
 * configuration surface separate from contract acceptance: a site may publish curated options and
 * collect selections without ever holding the acceptance signing credentials, and vice versa.
 */
export function customerDecisionBackendEnabled(env: AppEnv): boolean {
  return String(env.APP_CUSTOMER_PORTAL_DECISION_ENABLED) === "true";
}
