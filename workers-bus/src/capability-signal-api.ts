import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  CAPABILITY_SIGNAL_IDS,
  CAPABILITY_SIGNAL_REGISTRY,
  evaluateCapabilitySignals,
  type CapabilityConfigurationState,
  type CapabilityFlagState,
  type CapabilityPresence,
  type CapabilityReason,
  type CapabilitySignalId,
  type CapabilitySignalItem,
  type CapabilityState,
} from "./capability-signal.ts";
import { facetV2ConsumerConfig } from "./facet-design-ingest.ts";
import { facetLaunchConfigured } from "./facet-launch.ts";
import { publicEstimateConfiguration } from "./public-estimator.ts";
import { quickBooksProviderApiBase } from "./quickbooks-final-invoice.ts";

/**
 * The role-scoped runtime capability read model (ELEC-240).
 *
 * Two projections, because a capability state is not neutral information. "QuickBooks is on but
 * has no credentials" tells a reader that the company has not finished an accounting setup;
 * "`FACET_LAUNCH_HMAC_KEY` is missing" names a secret binding. The office pair already reaches
 * `/api/v1/integrations/readiness` and the owner runtime read, so the detail costs them nothing
 * new. Every other role gets the minimum that lets a surface be honest: what state, and why, in
 * closed vocabulary -- no binding names, no declared literals, no dependency graph.
 *
 * Nothing here is cached and nothing is read from the request. Every field is derived from the
 * live bindings on each call, so a configuration change is visible on the next request without a
 * deploy, an invalidation, or a client refresh (acceptance criterion 6).
 */

export const CAPABILITY_SIGNAL_VERSION = 1;

/** What a non-office role receives. Deliberately smaller than the office item. */
export interface ScopedCapabilityItem {
  id: CapabilitySignalId;
  title: string;
  presence: CapabilityPresence;
  state: CapabilityState;
  reason: CapabilityReason;
  flag_state: CapabilityFlagState;
  configuration_state: CapabilityConfigurationState;
  readback_required: boolean;
}

/** What owner/ops receive: the scoped item plus the operator detail they can act on. */
export interface OfficeCapabilityItem extends ScopedCapabilityItem {
  flag_binding: string | null;
  flag_declared: string | null;
  missing_configuration: readonly string[];
  indeterminate_configuration: readonly string[];
  dependencies: ReadonlyArray<{ id: CapabilitySignalId; state: CapabilityState }>;
}

export interface CapabilitySignalReadModel {
  version: typeof CAPABILITY_SIGNAL_VERSION;
  tenant_id: string;
  role: string;
  /** `office` carries the operator detail; `scoped` is the minimum honest projection. */
  projection: "office" | "scoped";
  read_model_generated_at: string;
  capabilities: ReadonlyArray<ScopedCapabilityItem | OfficeCapabilityItem>;
  /**
   * This read model reports reachability, never proof. The proof ladder stays with
   * `GET /api/v1/integrations/readiness`, which answers a different question from different facts.
   */
  proof_claimed: false;
  /** Reading capability state never changes it. Enabling a capability is an administrator action. */
  configuration_mutations_available: false;
  allowed_actions: readonly ["capabilities.read"];
  /**
   * True when at least one capability's state rests on something that must be read back before it
   * can be settled. A surface must not render those as either working or broken.
   */
  readback_obligations: boolean;
}

/**
 * Build the read model for exactly this caller, from exactly this deployment's live bindings.
 *
 * `tenantId` comes from the authenticated session and never from the request: a capability state
 * is a tenant fact, and accepting one from a caller would be the cross-tenant read this signal
 * exists to make safe (acceptance criterion 5).
 */
export function buildCapabilitySignalReadModel(
  env: AppEnv,
  auth: AuthContext,
  now: Date = new Date(),
): CapabilitySignalReadModel {
  const tenantId = auth.session.tenant_id;
  const evaluated = evaluateCapabilitySignals({
    read: (name) => bindingValue(env, name),
    refine: runtimeRefinements(env, tenantId),
  });
  const office = auth.session.role === "owner" || auth.session.role === "ops";
  const visible = CAPABILITY_SIGNAL_IDS.filter((id) => visibleToCaller(id, auth)).map(
    (id) => evaluated[id],
  );
  return {
    version: CAPABILITY_SIGNAL_VERSION,
    tenant_id: tenantId,
    role: auth.session.role,
    projection: office ? "office" : "scoped",
    read_model_generated_at: now.toISOString(),
    capabilities: visible.map((item) => (office ? officeItem(item) : scopedItem(item))),
    proof_claimed: false,
    configuration_mutations_available: false,
    allowed_actions: ["capabilities.read"],
    readback_obligations: visible.some((item) => item.readback_required),
  };
}

/** A role sees a capability when it holds a permission that actually reaches its surface. */
export function visibleToCaller(id: CapabilitySignalId, auth: AuthContext): boolean {
  return CAPABILITY_SIGNAL_REGISTRY[id].audience.some((permission) =>
    auth.permissions.includes(permission),
  );
}

function scopedItem(item: CapabilitySignalItem): ScopedCapabilityItem {
  return {
    id: item.id,
    title: item.title,
    presence: item.presence,
    state: item.state,
    reason: item.reason,
    flag_state: item.flag.state,
    configuration_state: item.configuration.state,
    readback_required: item.readback_required,
  };
}

function officeItem(item: CapabilitySignalItem): OfficeCapabilityItem {
  return {
    ...scopedItem(item),
    flag_binding: item.flag.binding,
    flag_declared: item.flag.declared,
    missing_configuration: item.configuration.missing,
    indeterminate_configuration: item.configuration.indeterminate,
    dependencies: item.dependencies,
  };
}

/**
 * A live binding is readable, including a secret one, so nothing is `opaque` here -- that argument
 * exists for `tools/production-readiness.mjs`, which analyses `wrangler.jsonc` and genuinely
 * cannot see a secret. Non-string bindings (queues, buckets, D1) are not configuration values and
 * read as undeclared rather than as a truthy present.
 */
function bindingValue(env: AppEnv, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Where a capability's own parser is stricter than "every binding is non-blank".
 *
 * Each of these is a case where the Worker would refuse at first use even though no binding is
 * blank -- a key set that does not parse, a minor version out of range, a static route set with no
 * entry for this tenant. Reusing the module's own configuration function rather than restating its
 * rules here is what keeps the signal and the refusal from drifting apart.
 */
function runtimeRefinements(
  env: AppEnv,
  tenantId: string,
): Partial<Record<CapabilitySignalId, "available" | "unconfigured">> {
  return {
    // Tenant-scoped: complete bindings still resolve to nothing unless exactly one static route
    // names this tenant as its destination.
    facet_launch: facetLaunchConfigured(env, tenantId) ? "available" : "unconfigured",
    facet_design_ingest: facetV2ConsumerConfig(env) ? "available" : "unconfigured",
    quickbooks_oauth: quickBooksProviderApiBase(env) !== null ? "available" : "unconfigured",
    public_estimator: publicEstimateConfiguration(env).ready ? "available" : "unconfigured",
  };
}
