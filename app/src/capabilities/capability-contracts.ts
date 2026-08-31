import { z } from "zod";

/**
 * The client half of `GET /api/v1/capabilities` (ELEC-240,
 * `docs/CAPABILITY-SIGNAL-CONTRACT.md`).
 *
 * This read model answers "can this capability be reached at all" — is it in the build, is its
 * flag on, is the configuration it needs present. It is NOT
 * `/api/v1/integrations/readiness`, which answers "has this been proven against a provider" from
 * append-only proof rows. The two are never mixed on one surface without saying which is which,
 * and this one never claims proof: `proof_claimed` is a constant `false` on the wire and a
 * `z.literal(false)` here, so a payload that ever claimed otherwise fails to parse rather than
 * reaching a screen.
 */

/**
 * The six states a surface may render. Closed on purpose: these ARE the presentation contract, so
 * a seventh value must reach a reviewer rather than be guessed at by a fallback branch. A payload
 * carrying an unrecognised state fails to parse and every surface falls back to "state could not
 * be read", which is honest, where guessing would not be.
 */
export const capabilityStates = [
  "absent",
  "off",
  "unconfigured",
  "dependency_blocked",
  "unknown",
  "available",
] as const;
export type CapabilityState = (typeof capabilityStates)[number];

/**
 * The capability ids this app has a surface for. Deliberately NOT the parser's vocabulary: the
 * server registry grows, and a new id must not break every screen at once. `id` parses as a
 * bounded string and each surface looks up the one it owns, so an unknown id is simply a
 * capability nothing on this client claims to present.
 */
export const KNOWN_CAPABILITY_IDS = [
  "quickbooks_oauth",
  "quickbooks_final_invoice",
  "hermes_desktop",
  "hermes_hosted_reference",
  "public_estimator",
  "newo",
  "postiz",
  "facet_design_ingest",
  "facet_launch",
  "facet_native_projection",
  "facet_frappe_projection",
  "facet_design_ingest_v1",
  "facet_quote_revision_prepare",
  "proposal_template",
  "proposal_publication",
  "document_generation",
  "effect_runtime",
] as const;
export type KnownCapabilityId = (typeof KNOWN_CAPABILITY_IDS)[number];

/**
 * `reason`, `flag_state` and `configuration_state` parse as bounded strings for the same
 * forward-compatibility reason as `id`: they refine the copy a state gets, and an unrecognised
 * value degrades to the state-level wording instead of blanking a screen. `state` alone decides
 * what is rendered, so only `state` is closed.
 */
const scopedCapabilitySchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  presence: z.enum(["present", "absent"]),
  state: z.enum(capabilityStates),
  reason: z.string().min(1).max(80),
  flag_state: z.string().min(1).max(40),
  configuration_state: z.string().min(1).max(40),
  readback_required: z.boolean(),
});

/**
 * `owner` and `ops` only. A capability state leaks commercial and infrastructure facts — which
 * binding is blank names a secret, and "on with no credentials" says the company never finished
 * an accounting setup — so every other role receives strictly less, by design. Nothing in this
 * file may present an office field to a scoped payload, because a scoped payload never carries
 * one.
 */
const officeCapabilitySchema = scopedCapabilitySchema.extend({
  flag_binding: z.string().nullable(),
  flag_declared: z.string().nullable(),
  missing_configuration: z.array(z.string().min(1).max(120)).max(40),
  indeterminate_configuration: z.array(z.string().min(1).max(120)).max(40),
  dependencies: z
    .array(z.object({ id: z.string().min(1).max(80), state: z.enum(capabilityStates) }))
    .max(40),
});

/** Office first: a scoped object would also accept an office payload and silently strip it. */
const capabilityItemSchema = z.union([officeCapabilitySchema, scopedCapabilitySchema]);

export const capabilitySignalResponseSchema = z
  .object({
    version: z.literal(1),
    tenant_id: z.string().min(1).max(64),
    role: z.string().min(1).max(40),
    projection: z.enum(["office", "scoped"]),
    read_model_generated_at: z.string().min(20).max(64),
    capabilities: z.array(capabilityItemSchema).max(64),
    proof_claimed: z.literal(false),
    configuration_mutations_available: z.literal(false),
    allowed_actions: z.tuple([z.literal("capabilities.read")]),
    readback_obligations: z.boolean(),
  })
  .strict();

export type ScopedCapability = z.infer<typeof scopedCapabilitySchema>;
export type OfficeCapability = z.infer<typeof officeCapabilitySchema>;
export type Capability = ScopedCapability | OfficeCapability;
export type CapabilitySignalResponse = z.infer<typeof capabilitySignalResponseSchema>;

/** The operator detail exists only in the office projection; ask, never assume. */
export function officeDetail(capability: Capability): OfficeCapability | undefined {
  return "missing_configuration" in capability ? capability : undefined;
}

/**
 * An `absent` capability names nothing a user gets, so it is never rendered — not as a card, not
 * as a disabled control, not as a switched-off one. Filtering here rather than at each call site
 * is what keeps that rule from being re-decided per surface.
 */
export function presentableCapabilities(model: CapabilitySignalResponse): Capability[] {
  return model.capabilities.filter((capability) => capability.state !== "absent");
}
