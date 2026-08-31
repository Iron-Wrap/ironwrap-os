import type {
  Capability,
  CapabilitySignalResponse,
  OfficeCapability,
} from "./capability-contracts";

/**
 * Builders for the `GET /api/v1/capabilities` read model, shaped exactly as
 * `docs/CAPABILITY-SIGNAL-CONTRACT.md` describes it.
 *
 * The office and scoped projections are separate builders on purpose. A test that renders a sales
 * or accounting surface must not be able to hand it a payload carrying `missing_configuration`,
 * because the server never would: a non-office role receives strictly less, and a screen that
 * quietly depends on the office fields would pass its test and be wrong in production.
 */

const REFERENCE_GENERATED_AT = "2026-08-31T00:00:00.000Z";

export function scopedCapability(
  id: string,
  title: string,
  overrides: Partial<Capability> = {},
): Capability {
  return {
    id,
    title,
    presence: "present",
    state: "off",
    reason: "flag_off",
    flag_state: "off",
    configuration_state: "not_evaluated",
    readback_required: false,
    ...overrides,
  };
}

export function officeCapability(
  id: string,
  title: string,
  overrides: Partial<OfficeCapability> = {},
): OfficeCapability {
  return {
    ...(scopedCapability(id, title) as OfficeCapability),
    flag_binding: null,
    flag_declared: "false",
    missing_configuration: [],
    indeterminate_configuration: [],
    dependencies: [],
    ...overrides,
  };
}

/** Present, switched on, setup unfinished — with the blank bindings named, office projection. */
export function unconfiguredOfficeCapability(
  id: string,
  title: string,
  missing: string[],
): OfficeCapability {
  return officeCapability(id, title, {
    state: "unconfigured",
    reason: "configuration_incomplete",
    flag_state: "on",
    configuration_state: "incomplete",
    flag_declared: "true",
    missing_configuration: missing,
  });
}

/** Present, on, every binding filled, and the capability's own parser refused them anyway. */
export function rejectedOfficeCapability(id: string, title: string): OfficeCapability {
  return officeCapability(id, title, {
    state: "unconfigured",
    reason: "configuration_rejected",
    flag_state: "on",
    configuration_state: "incomplete",
    flag_declared: "true",
    missing_configuration: [],
  });
}

export function capabilitySignal(
  role: string,
  capabilities: Capability[],
  overrides: Partial<CapabilitySignalResponse> = {},
): CapabilitySignalResponse {
  return {
    version: 1,
    tenant_id: "ironwrap",
    role,
    projection: role === "owner" || role === "ops" ? "office" : "scoped",
    read_model_generated_at: REFERENCE_GENERATED_AT,
    capabilities,
    proof_claimed: false,
    configuration_mutations_available: false,
    allowed_actions: ["capabilities.read"],
    readback_obligations: capabilities.some((capability) => capability.readback_required),
    ...overrides,
  };
}
