import type { AppEnv } from "./app-types.ts";

/**
 * Per-rail Frappe credentials for the two bounded capture rails the Worker issues.
 *
 * Frappe already scopes these rails server-side: `fleet_operations_api._assert_worker_issuer`
 * and `work_package_api._assert_worker_issuer` refuse any session user that is not the exact
 * identity pinned in `ironwrap_fleet_capture_issuer_user` / `ironwrap_work_package_issuer_user`.
 * What was missing is the other half of that isolation: the Worker presented the single broad
 * `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` pair — a System Manager — for both rails, so one leaked
 * key reached the whole site rather than one rail's narrow grant (ELEC-48 audit section 3).
 *
 * Each rail now carries its own pair, matching what the customer-acceptance, customer-decision,
 * QuickBooks-reconciliation and Facet-projection rails already do. `ERPNEXT_API_KEY` keeps the
 * ordinary BFF reads and the field-evidence rail; it no longer authorizes these two.
 */
export type FrappeRail = "fleet_capture" | "work_package";

export interface RailFrappeCredential {
  /** Rail identity these bytes belong to; kept for error attribution, never logged as a value. */
  rail: FrappeRail;
  apiKey: string;
  apiSecret: string;
}

interface RailBinding {
  keyBinding: keyof AppEnv;
  secretBinding: keyof AppEnv;
  /** Raised when the pair is absent — the rail is configured dead rather than shared. */
  notConfiguredCode: string;
  /** Raised when the pair is present but is the shared bus pair wearing a rail's binding name. */
  sharedCredentialCode: string;
}

const RAIL_BINDINGS: Record<FrappeRail, RailBinding> = {
  fleet_capture: {
    keyBinding: "FLEET_CAPTURE_FRAPPE_API_KEY",
    secretBinding: "FLEET_CAPTURE_FRAPPE_API_SECRET",
    notConfiguredCode: "fleet_frappe_not_configured",
    sharedCredentialCode: "fleet_frappe_shared_credential_rejected",
  },
  work_package: {
    keyBinding: "WORK_PACKAGE_FRAPPE_API_KEY",
    secretBinding: "WORK_PACKAGE_FRAPPE_API_SECRET",
    notConfiguredCode: "work_package_frappe_not_configured",
    sharedCredentialCode: "work_package_frappe_shared_credential_rejected",
  },
};

export const FRAPPE_RAILS = Object.keys(RAIL_BINDINGS) as FrappeRail[];

/** The exact binding names an operator must set, for config surfaces and validators. */
export function railCredentialBindings(rail: FrappeRail): { key: string; secret: string } {
  const binding = RAIL_BINDINGS[rail];
  return { key: binding.keyBinding, secret: binding.secretBinding };
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Isolation is a property of the VALUES, not of the binding names. Pasting the bus pair into a
 * rail binding satisfies every presence check while leaving the blast radius exactly as wide as
 * before, so that arrangement is rejected outright rather than quietly accepted.
 */
function reusesSharedBusCredential(env: AppEnv, apiKey: string, apiSecret: string): boolean {
  const sharedKey = trimmed(env.ERPNEXT_API_KEY);
  const sharedSecret = trimmed(env.ERPNEXT_API_SECRET);
  return (!!sharedKey && apiKey === sharedKey) || (!!sharedSecret && apiSecret === sharedSecret);
}

export type RailCredentialResolution =
  | { ok: true; credential: RailFrappeCredential }
  | { ok: false; code: string };

export function resolveRailFrappeCredential(
  env: AppEnv,
  rail: FrappeRail,
): RailCredentialResolution {
  const binding = RAIL_BINDINGS[rail];
  const apiKey = trimmed(env[binding.keyBinding]);
  const apiSecret = trimmed(env[binding.secretBinding]);
  if (!apiKey || !apiSecret) return { ok: false, code: binding.notConfiguredCode };
  if (reusesSharedBusCredential(env, apiKey, apiSecret))
    return { ok: false, code: binding.sharedCredentialCode };
  return { ok: true, credential: { rail, apiKey, apiSecret } };
}

/**
 * Fail-closed accessor for call sites that are already inside a rail's own error vocabulary:
 * a missing or shared pair throws that rail's code, which its handler maps to a 502 the same
 * way it always mapped `*_frappe_not_configured`.
 */
export function requireRailFrappeCredential(
  env: AppEnv,
  rail: FrappeRail,
): RailFrappeCredential {
  const resolved = resolveRailFrappeCredential(env, rail);
  if (!resolved.ok) throw new Error(resolved.code);
  return resolved.credential;
}

/** Frappe token auth header for one rail. Never accepts an ad-hoc key/secret pair. */
export function railAuthorizationHeader(env: AppEnv, rail: FrappeRail): string {
  const credential = requireRailFrappeCredential(env, rail);
  return `token ${credential.apiKey}:${credential.apiSecret}`;
}

export function railFrappeCredentialConfigured(env: AppEnv, rail: FrappeRail): boolean {
  return resolveRailFrappeCredential(env, rail).ok;
}

/**
 * Readiness predicate. Both rails ride the app BFF, so a Worker with the BFF switched off is
 * legitimately without them; any other state must be visible on `/ready` rather than discovered
 * by a driver whose pre-trip inspection returns 502 (the ELEC-40 dead-rail class).
 */
export function railCredentialIsolationConfigured(env: AppEnv): boolean {
  if (String(env.APP_BFF_ENABLED) !== "true") return true;
  // Dead leftover bindings must not turn the office plane red. Isolation is
  // only a readiness fault when the leftover Frappe projection is actually on.
  if (String(env.ERPNEXT_ENABLED) !== "true") return true;
  return FRAPPE_RAILS.every((rail) => railFrappeCredentialConfigured(env, rail));
}

/** Which rails are unhealthy and why — for the admin-authenticated readiness detail only. */
export function railCredentialIsolationFailures(env: AppEnv): string[] {
  if (String(env.APP_BFF_ENABLED) !== "true") return [];
  if (String(env.ERPNEXT_ENABLED) !== "true") return [];
  return FRAPPE_RAILS.flatMap((rail) => {
    const resolved = resolveRailFrappeCredential(env, rail);
    return resolved.ok ? [] : [resolved.code];
  });
}
