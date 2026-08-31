/**
 * The runtime capability signal: what a surface may honestly say about a capability it cannot use.
 *
 * This is deliberately NOT `capability-readiness.ts`. That module answers "has this capability been
 * PROVEN against a provider", from append-only manifest and proof facts, and it answers `blocked`
 * for everything a tenant has never proven -- which is the correct answer to its question and a
 * useless one for a UI that has to explain WHY a button does nothing. This module answers the
 * prior, cheaper question: is the capability in this build at all, is its flag on, and is the
 * configuration it needs actually present. It never claims a capability is proven; `proof_claimed`
 * is a constant `false` and the proof ladder stays with the readiness read model (ELEC-240, G1.3).
 *
 * Three facts stay separate on purpose, because collapsing them is the dishonesty G1 exists to
 * remove (ELEC-232 found all three collapsed into one boolean or into nothing at all):
 *
 *   - presence      -- does source consume this binding at all? Two flags in `wrangler.jsonc` have
 *                      no consumer in `src/`, so they name nothing a user gets.
 *   - flag state    -- on, off, undeclared, or a value that is neither. Separate from readiness:
 *                      a flag that is on over missing credentials is not "off" and not "ready".
 *   - configuration -- are the bindings the capability needs present, missing, or unreadable.
 *
 * Everything here is pure and free of runtime imports so that both the Worker (against live
 * bindings, where secrets are readable) and `tools/production-readiness.mjs` (against
 * `wrangler.jsonc`, where they are not) evaluate the SAME registry through the SAME evaluator.
 * A capability that drifts between the two cannot happen: there is one table.
 */

/** Every capability G1.3's audit table names, plus the effect runtime the adapters depend on. */
export const CAPABILITY_SIGNAL_IDS = [
  "document_generation",
  "effect_runtime",
  "facet_design_ingest",
  "facet_design_ingest_v1",
  "facet_frappe_projection",
  "facet_launch",
  "facet_native_projection",
  "facet_quote_revision_prepare",
  "hermes_desktop",
  "hermes_hosted_reference",
  "newo",
  "postiz",
  "proposal_publication",
  "proposal_template",
  "public_estimator",
  "quickbooks_final_invoice",
  "quickbooks_oauth",
] as const;

export type CapabilitySignalId = (typeof CAPABILITY_SIGNAL_IDS)[number];

/**
 * The eight capabilities spec §9.3 names and G1.3 audited. `tools/production-readiness.mjs` gates
 * exactly this set, so a flag flip on any of them fails the readiness contract until the reference
 * state is re-recorded. Kept here, beside the registry, so the tool cannot cover a stale list.
 */
export const NAMED_REFERENCE_CAPABILITY_IDS = [
  "facet_design_ingest",
  "hermes_desktop",
  "newo",
  "postiz",
  "proposal_template",
  "public_estimator",
  "quickbooks_final_invoice",
  "quickbooks_oauth",
] as const satisfies readonly CapabilitySignalId[];

/** Is the capability in this build at all, or only a name in the configuration file? */
export type CapabilityPresence = "present" | "absent";

/**
 * Flag state, never merged into readiness. `undeclared` and `invalid` both refuse the capability,
 * but they are different operator facts: one is an omission, the other is a typo that would
 * silently read as "off" if this collapsed them.
 */
export type CapabilityFlagState = "on" | "off" | "undeclared" | "invalid" | "not_flagged";

/** Configuration state, never merged into flag state. */
export type CapabilityConfigurationState =
  | "configured"
  | "incomplete"
  | "indeterminate"
  | "not_evaluated";

/**
 * The state a surface renders. These never collapse into one boolean, and `available` means
 * "reachable" -- never "proven", which only the readiness read model may say.
 */
export type CapabilityState =
  /** No consumer in source. The UI must not present this id as a capability at all. */
  | "absent"
  /** Present in the build, switched off. Turning it on is an administrator decision. */
  | "off"
  /** On (or unflagged and mounted) but the configuration it needs is missing. Fails at first use. */
  | "unconfigured"
  /** On and configured, but something it depends on is not available. */
  | "dependency_blocked"
  /** A required input could not be determined. Carries a readback obligation; never "ready". */
  | "unknown"
  /** On and configured. Reachable -- not proven. */
  | "available";

export type CapabilityReason =
  | "no_source_consumer"
  | "flag_off"
  | "flag_undeclared"
  | "flag_value_invalid"
  | "configuration_incomplete"
  /** Every required binding is present, and the capability's own parser still refused them. */
  | "configuration_rejected"
  | "configuration_indeterminate"
  | "dependency_unavailable"
  | "dependency_indeterminate"
  | "flag_on_and_configured"
  | "mounted_and_configured";

/** How a binding's value is judged once it is read. */
type BindingShape =
  /** Any non-blank value counts as present. */
  | "non_blank"
  /** Must parse as a JSON array with at least one element; unparseable is indeterminate. */
  | "non_empty_json_array";

interface BindingRequirement {
  binding: string;
  shape: BindingShape;
  /**
   * A Worker secret. Live bindings can read it; static analysis of `wrangler.jsonc` cannot, and
   * must then report `indeterminate` with a readback obligation rather than guess either way.
   */
  secret: boolean;
}

export interface CapabilityDefinition {
  id: CapabilitySignalId;
  /** Human-facing label. Safe for every audience; carries no infrastructure detail. */
  title: string;
  presence: CapabilityPresence;
  /** `null` when the capability has no flag at all and is mounted unconditionally. */
  flagBinding: string | null;
  requires: readonly BindingRequirement[];
  dependsOn: readonly CapabilitySignalId[];
  /**
   * Permissions that reach this capability's surface. A role sees the capability if it holds any
   * of them. Deriving the audience from the permission that actually reaches the route -- rather
   * than a hand-kept role list -- is what keeps a capability from leaking to a role that could
   * never use it, and what routes a new capability to the right roles without a second edit.
   * Empty means office-only (owner/ops), used for the two absent ids and internal projections.
   */
  audience: readonly string[];
  /** Why the audience is what it is, and what an absent id means. Not shown to a client. */
  note: string;
}

const OFFICE_ONLY: readonly string[] = ["owner:read"];

function binding(
  name: string,
  options: { secret?: boolean; shape?: BindingShape } = {},
): BindingRequirement {
  return {
    binding: name,
    shape: options.shape ?? "non_blank",
    secret: options.secret ?? false,
  };
}

/**
 * The registry. Every row is one line of G1.3's audit table (ELEC-232 closing comment, verified on
 * `main` @ `3da7ee2b`), plus `effect_runtime`, which is not user-visible on its own but is the
 * dependency every provider adapter fails closed against (`assertEffectLedgerReady`).
 */
export const CAPABILITY_SIGNAL_REGISTRY: Readonly<
  Record<CapabilitySignalId, CapabilityDefinition>
> = {
  quickbooks_oauth: {
    id: "quickbooks_oauth",
    title: "QuickBooks connection",
    presence: "present",
    flagBinding: "QB_OAUTH_ENABLED",
    requires: [
      binding("QB_CLIENT_ID", { secret: true }),
      binding("QB_CLIENT_SECRET", { secret: true }),
      binding("QB_TOKEN_ENCRYPTION_KEY", { secret: true }),
      binding("QB_TOKEN_ENCRYPTION_KEY_VERSION"),
      binding("QB_API_ENVIRONMENT"),
      binding("QB_API_MINOR_VERSION"),
      binding("APP_PUBLIC_ORIGIN"),
    ],
    dependsOn: [],
    // `ops` holds `accounting:read` but not `quickbooks:read`; both belong here so the office
    // pair and the accounting role all reach the same fact.
    audience: ["quickbooks:read", "accounting:read"],
    note: "Connecting is an administrator action needing Intuit credentials. The accounting role must be able to say so without the office readiness view.",
  },
  quickbooks_final_invoice: {
    id: "quickbooks_final_invoice",
    title: "QuickBooks final-invoice execution",
    presence: "present",
    flagBinding: "QB_FINAL_INVOICE_ENABLED",
    requires: [],
    dependsOn: ["quickbooks_oauth", "effect_runtime"],
    audience: ["quickbooks:read", "accounting:read"],
    note: "Off means no invoice reaches QuickBooks and an approved intent waits; it does not mean the intent was lost.",
  },
  hermes_desktop: {
    id: "hermes_desktop",
    title: "Hermes desktop pilot",
    presence: "present",
    flagBinding: "APP_HERMES_DESKTOP_ENABLED",
    requires: [],
    dependsOn: [],
    audience: OFFICE_ONLY,
    note: "Owner/ops desktop draft pilot. G1.3 found it had no readiness entry at all.",
  },
  hermes_hosted_reference: {
    id: "hermes_hosted_reference",
    title: "Hermes hosted reference execution",
    presence: "present",
    flagBinding: "APP_HERMES_HOSTED_REFERENCE_ENABLED",
    requires: [binding("APP_HERMES_PROVIDER_MODEL")],
    dependsOn: [],
    audience: OFFICE_ONLY,
    note: "Undeclared in every environment. `undeclared` rather than `off` keeps the omission legible to an operator.",
  },
  public_estimator: {
    id: "public_estimator",
    title: "Public website estimator",
    presence: "present",
    flagBinding: "PUBLIC_ESTIMATE_ENABLED",
    requires: [
      binding("PUBLIC_ESTIMATE_ALLOWED_ORIGINS"),
      binding("PUBLIC_ESTIMATE_ALLOWED_BRANDS"),
      binding("PUBLIC_ESTIMATE_CONSENT_JURISDICTION"),
      binding("PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY"),
      binding("PUBLIC_ESTIMATE_TURNSTILE_SECRET", { secret: true }),
      binding("PUBLIC_ESTIMATE_RATE_LIMIT_PEPPER", { secret: true }),
      binding("PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS"),
      binding("PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX"),
      binding("PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX"),
    ],
    dependsOn: [],
    audience: ["sales:read"],
    note: "Sales is a non-office role and owns the lead desk the estimator feeds.",
  },
  newo: {
    id: "newo",
    title: "Newo voice reception",
    presence: "present",
    flagBinding: "NEWO_ENABLED",
    requires: [
      binding("NEWO_API_BASE_URL"),
      binding("NEWO_PROJECT_ID"),
      binding("NEWO_AGENT_ID"),
      binding("NEWO_API_KEY", { secret: true }),
      binding("NEWO_WEBHOOK_TOKEN", { secret: true }),
      binding("NEWO_BOOKING_TOKEN", { secret: true }),
    ],
    dependsOn: ["effect_runtime"],
    audience: OFFICE_ONLY,
    note: "Configuration presence only. Whether the credential authenticates needs a live provider call and stays a readback obligation.",
  },
  postiz: {
    id: "postiz",
    title: "Postiz marketing publication",
    presence: "present",
    flagBinding: "POSTIZ_ENABLED",
    requires: [
      binding("POSTIZ_API_BASE_URL"),
      binding("POSTIZ_API_KEY", { secret: true }),
    ],
    dependsOn: ["effect_runtime"],
    audience: OFFICE_ONLY,
    note: "Execution adapter; fails closed behind the effect ledger.",
  },
  facet_design_ingest: {
    id: "facet_design_ingest",
    title: "Facet design delivery",
    presence: "present",
    flagBinding: "FACET_V2_INGEST_ENABLED",
    requires: [
      binding("FACET_V2_ROUTES_JSON", { shape: "non_empty_json_array" }),
      binding("FACET_V2_KEYS_JSON", { secret: true }),
    ],
    dependsOn: [],
    audience: ["facet:read", "estimator:read"],
    note: "The exact G1.3 case: flag `true` with `FACET_V2_ROUTES_JSON` `\"[]\"`, so `/ingest/facet-design` answers 503, not 404. On, unconfigured.",
  },
  facet_launch: {
    id: "facet_launch",
    title: "Facet design launch",
    presence: "present",
    flagBinding: "APP_FACET_LAUNCH_ENABLED",
    requires: [
      binding("APP_FACET_LAUNCH_BASE_URL"),
      binding("APP_FACET_LAUNCH_SOURCE_TENANT_ID"),
      binding("FACET_LAUNCH_HMAC_KEY", { secret: true }),
      binding("FACET_V2_ROUTES_JSON", { shape: "non_empty_json_array" }),
    ],
    dependsOn: [],
    audience: ["facet:launch", "facet:read"],
    note: "Tenant-scoped: the launch route matches exactly one static route for the caller's tenant, so two tenants can hold different states from one binding set.",
  },
  facet_native_projection: {
    id: "facet_native_projection",
    title: "Facet native projection",
    presence: "present",
    flagBinding: "FACET_V2_NATIVE_PROJECTION_ENABLED",
    requires: [],
    dependsOn: ["facet_design_ingest"],
    audience: OFFICE_ONLY,
    note: "On, but there is nothing to project until ingest is configured -- which is `dependency_blocked`, not `off` and not `available`.",
  },
  facet_frappe_projection: {
    id: "facet_frappe_projection",
    title: "Facet compatibility projection into Frappe",
    presence: "present",
    flagBinding: "FACET_DESIGN_FRAPPE_PROJECTION_ENABLED",
    requires: [
      binding("FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY", { secret: true }),
      binding("FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY", { secret: true }),
      binding("FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET", { secret: true }),
    ],
    dependsOn: ["effect_runtime"],
    audience: OFFICE_ONLY,
    note: "Compatibility-only projection, retiring under G5.",
  },
  facet_design_ingest_v1: {
    id: "facet_design_ingest_v1",
    title: "Facet v1 design ingest",
    presence: "absent",
    flagBinding: "FACET_DESIGN_INGEST_ENABLED",
    requires: [],
    dependsOn: [],
    audience: OFFICE_ONLY,
    note: "`FACET_DESIGN_INGEST_ENABLED` has no consumer in `workers-bus/src`; only `tools/production-readiness.mjs` reads it. Reported so a surface can prove it is deliberately not presented, rather than silently omitting it.",
  },
  facet_quote_revision_prepare: {
    id: "facet_quote_revision_prepare",
    title: "Facet quote-revision preparation",
    presence: "absent",
    flagBinding: "APP_FACET_QUOTE_REVISION_PREPARE_ENABLED",
    requires: [],
    dependsOn: [],
    audience: OFFICE_ONLY,
    note: "Declared in `app-types.ts` and read nowhere. The flag does not describe anything a user gets.",
  },
  proposal_template: {
    id: "proposal_template",
    title: "Proposal document template",
    presence: "present",
    flagBinding: null,
    requires: [
      binding("PROPOSAL_TEMPLATE_DOC_ID"),
      binding("GOOGLE_SERVICE_ACCOUNT_JSON", { secret: true }),
      binding("SHARED_DRIVE_ID_JOBS"),
    ],
    dependsOn: [],
    audience: ["estimator:read"],
    note: "No flag exists. `POST /api/v1/estimator/proposal-doc` is mounted unconditionally and answers 503 `proposal_doc_not_configured`, so an estimator is offered the action and it fails at first use. \"Not configured\" is the honest word; \"unavailable\" would be misleading.",
  },
  proposal_publication: {
    id: "proposal_publication",
    title: "Proposal publication to the customer",
    presence: "present",
    flagBinding: "APP_PROPOSAL_PUBLICATION_ENABLED",
    requires: [
      binding("APP_PROPOSAL_PUBLICATION_BROKER_URL"),
      binding("APP_PROPOSAL_PUBLICATION_BROKER_KEY_ID"),
      binding("PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET", { secret: true }),
    ],
    dependsOn: [],
    audience: ["estimator:read", "approvals:read"],
    note: "The only step that makes quote terms customer-visible. Today the app learns it is off from an omitted `allowed_actions` entry, which reads identically to a permission refusal.",
  },
  document_generation: {
    id: "document_generation",
    title: "Immutable document generation",
    presence: "present",
    flagBinding: "APP_DOCUMENT_GENERATION_ENABLED",
    requires: [],
    dependsOn: ["effect_runtime"],
    audience: ["owner:read", "production:read"],
    note: "Production sees it because governed stage automation on the runway produces documents through it.",
  },
  effect_runtime: {
    id: "effect_runtime",
    title: "Effect ledger",
    presence: "present",
    flagBinding: "EFFECT_RUNTIME_ENABLED",
    requires: [],
    dependsOn: [],
    audience: OFFICE_ONLY,
    note: "Not a user capability on its own. Every provider mutation refuses with `effect_runtime_required` unless it is on, so it is the dependency the adapters above resolve against.",
  },
};

/**
 * Every binding in the registry that is a Worker secret.
 *
 * `tools/production-readiness.mjs` passes this as `opaque`: it analyses `wrangler.jsonc`, where a
 * secret is by design absent, and must answer `indeterminate` rather than read that absence as
 * "missing". A live Worker passes nothing -- its secret bindings are readable.
 */
export function capabilitySecretBindings(): Set<string> {
  const secrets = new Set<string>();
  for (const id of CAPABILITY_SIGNAL_IDS) {
    for (const requirement of CAPABILITY_SIGNAL_REGISTRY[id].requires) {
      if (requirement.secret) secrets.add(requirement.binding);
    }
  }
  return secrets;
}

/** Reads one binding value. `undefined` means the binding is not declared. */
export type CapabilityBindingReader = (binding: string) => string | undefined;

export interface CapabilitySignalInput {
  read: CapabilityBindingReader;
  /**
   * Binding names the caller genuinely cannot observe. The Worker passes nothing here -- a live
   * secret binding is readable. Static analysis of `wrangler.jsonc` passes every secret, and gets
   * `indeterminate` back instead of a confident answer it has not earned.
   */
  opaque?: ReadonlySet<string>;
  /**
   * Refinement applied only to a capability the binding sweep already judged `available`, for the
   * cases where "every binding is non-blank" is weaker than the module's own parser. `facet_launch`
   * is the tenant-scoped one: the binding set can be complete while no static route matches THIS
   * tenant, which is `unconfigured` for that tenant and `available` for another. Others are
   * deployment-scoped -- a malformed key set, an out-of-range minor version -- where the Worker
   * would refuse at first use and the signal must say so before the user finds out.
   */
  refine?: Partial<Record<CapabilitySignalId, "available" | "unconfigured" | "unknown">>;
}

export interface CapabilitySignalItem {
  id: CapabilitySignalId;
  title: string;
  presence: CapabilityPresence;
  state: CapabilityState;
  reason: CapabilityReason;
  flag: {
    binding: string | null;
    state: CapabilityFlagState;
    /** The declared literal, or `null` when the binding is absent. Never a secret value. */
    declared: string | null;
  };
  configuration: {
    state: CapabilityConfigurationState;
    missing: readonly string[];
    indeterminate: readonly string[];
  };
  dependencies: ReadonlyArray<{ id: CapabilitySignalId; state: CapabilityState }>;
  /** True when this capability's state rests on something that must be read back to be settled. */
  readback_required: boolean;
}

const BLANK = /^\s*$/;

/**
 * Evaluate every capability. Pure: same inputs, same answer, no clock, no storage, no network.
 *
 * Ordering inside one capability is deliberate and fail-closed: presence, then flag, then
 * configuration, then dependencies. A capability whose flag is off is never asked about its
 * credentials, because "off" is a complete and true answer that leaks nothing.
 */
export function evaluateCapabilitySignals(
  input: CapabilitySignalInput,
): Record<CapabilitySignalId, CapabilitySignalItem> {
  const memo = new Map<CapabilitySignalId, CapabilitySignalItem>();
  const evaluating = new Set<CapabilitySignalId>();

  const evaluate = (id: CapabilitySignalId): CapabilitySignalItem => {
    const cached = memo.get(id);
    if (cached) return cached;
    const definition = CAPABILITY_SIGNAL_REGISTRY[id];
    // A registry cycle is a source defect, not a runtime condition. Refusing with `unknown`
    // keeps the read model answerable instead of recursing until the isolate dies.
    if (evaluating.has(id)) {
      return {
        id,
        title: definition.title,
        presence: definition.presence,
        state: "unknown",
        reason: "dependency_indeterminate",
        flag: { binding: definition.flagBinding, state: "not_flagged", declared: null },
        configuration: { state: "not_evaluated", missing: [], indeterminate: [] },
        dependencies: [],
        readback_required: true,
      };
    }
    evaluating.add(id);
    const item = evaluateOne(definition, input, evaluate);
    evaluating.delete(id);
    memo.set(id, item);
    return item;
  };

  const result = {} as Record<CapabilitySignalId, CapabilitySignalItem>;
  for (const id of CAPABILITY_SIGNAL_IDS) result[id] = evaluate(id);
  return result;
}

function evaluateOne(
  definition: CapabilityDefinition,
  input: CapabilitySignalInput,
  evaluate: (id: CapabilitySignalId) => CapabilitySignalItem,
): CapabilitySignalItem {
  const flagRaw =
    definition.flagBinding === null ? undefined : input.read(definition.flagBinding);
  const declared = flagRaw === undefined ? null : flagRaw;
  const flagState = flagStateOf(definition.flagBinding, flagRaw);
  const base = {
    id: definition.id,
    title: definition.title,
    presence: definition.presence,
    flag: { binding: definition.flagBinding, state: flagState, declared },
  } as const;

  if (definition.presence === "absent") {
    return {
      ...base,
      state: "absent",
      reason: "no_source_consumer",
      configuration: { state: "not_evaluated", missing: [], indeterminate: [] },
      dependencies: [],
      readback_required: false,
    };
  }

  if (flagState === "off" || flagState === "undeclared" || flagState === "invalid") {
    return {
      ...base,
      state: "off",
      reason:
        flagState === "off"
          ? "flag_off"
          : flagState === "undeclared"
            ? "flag_undeclared"
            : "flag_value_invalid",
      configuration: { state: "not_evaluated", missing: [], indeterminate: [] },
      dependencies: [],
      readback_required: false,
    };
  }

  const missing: string[] = [];
  const indeterminate: string[] = [];
  for (const requirement of definition.requires) {
    if (input.opaque?.has(requirement.binding)) {
      indeterminate.push(requirement.binding);
      continue;
    }
    const verdict = bindingVerdict(requirement, input.read(requirement.binding));
    if (verdict === "missing") missing.push(requirement.binding);
    if (verdict === "indeterminate") indeterminate.push(requirement.binding);
  }

  // A definitively missing binding beats an unreadable one: it is the more actionable truth and
  // an operator can fix it without a readback.
  if (missing.length > 0) {
    return {
      ...base,
      state: "unconfigured",
      reason: "configuration_incomplete",
      configuration: { state: "incomplete", missing, indeterminate },
      dependencies: [],
      readback_required: indeterminate.length > 0,
    };
  }
  if (indeterminate.length > 0) {
    return {
      ...base,
      state: "unknown",
      reason: "configuration_indeterminate",
      configuration: { state: "indeterminate", missing, indeterminate },
      dependencies: [],
      readback_required: true,
    };
  }

  const dependencies = definition.dependsOn.map((id) => ({ id, state: evaluate(id).state }));
  const configuration = {
    state: "configured" as const,
    missing: [] as readonly string[],
    indeterminate: [] as readonly string[],
  };
  const blockedDependency = dependencies.find(
    (dependency) => dependency.state !== "available",
  );
  if (blockedDependency) {
    const indeterminateDependency = blockedDependency.state === "unknown";
    return {
      ...base,
      state: indeterminateDependency ? "unknown" : "dependency_blocked",
      reason: indeterminateDependency ? "dependency_indeterminate" : "dependency_unavailable",
      configuration,
      dependencies,
      readback_required: indeterminateDependency,
    };
  }

  const scoped = input.refine?.[definition.id];
  if (scoped === "unconfigured") {
    // No binding is blank, and the capability's own parser refused anyway -- a value out of range,
    // a key set that does not parse, or a static route set with no entry for this tenant. Reporting
    // it as plain `configuration_incomplete` would send an operator hunting for an empty binding
    // that does not exist, so the reason says the values are present and were rejected.
    return {
      ...base,
      state: "unconfigured",
      reason: "configuration_rejected",
      configuration: { state: "incomplete", missing: [], indeterminate: [] },
      dependencies,
      readback_required: false,
    };
  }
  if (scoped === "unknown") {
    return {
      ...base,
      state: "unknown",
      reason: "configuration_indeterminate",
      configuration: { state: "indeterminate", missing: [], indeterminate: [] },
      dependencies,
      readback_required: true,
    };
  }

  return {
    ...base,
    state: "available",
    reason: definition.flagBinding === null ? "mounted_and_configured" : "flag_on_and_configured",
    configuration,
    dependencies,
    readback_required: false,
  };
}

function flagStateOf(flagBinding: string | null, raw: string | undefined): CapabilityFlagState {
  if (flagBinding === null) return "not_flagged";
  if (raw === undefined || BLANK.test(raw)) return "undeclared";
  if (raw === "true") return "on";
  if (raw === "false") return "off";
  // Fail closed. `"1"`, `"yes"`, `"TRUE"` are not the literal the Worker's own gates accept, and
  // reporting them as plain `off` would hide an operator error that looks like it worked.
  return "invalid";
}

function bindingVerdict(
  requirement: BindingRequirement,
  raw: string | undefined,
): "present" | "missing" | "indeterminate" {
  if (raw === undefined || BLANK.test(raw)) return "missing";
  if (requirement.shape === "non_blank") return "present";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return "indeterminate";
    return parsed.length > 0 ? "present" : "missing";
  } catch {
    // Set, but uninterpretable. Neither "missing" nor "present" is honest here, and claiming
    // either would be exactly the confident-but-wrong answer the ambiguity rule forbids.
    return "indeterminate";
  }
}
