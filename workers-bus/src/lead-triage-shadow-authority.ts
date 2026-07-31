import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const LEAD_TRIAGE_SHADOW_POLICY_SCHEMA =
  "ironwrap.lead-triage-shadow-policy.v1";
export const LEAD_TRIAGE_SHADOW_ACTION = "request_mark_lead_triaged";

const LEAD_TRIAGE_SHADOW_POLICY_ID = "lead-triage-shadow-authority";
const LEAD_TRIAGE_SHADOW_POLICY_VERSION = "v1";
const LEAD_TRIAGE_SHADOW_TENANT_ID = "ironwrap";
const LEAD_TRIAGE_SHADOW_SOURCE = "owned_lead_envelope";
const LEAD_TRIAGE_SHADOW_TRIAGE_STATUS = "Untriaged";
const LEAD_TRIAGE_SHADOW_SCOPE = "local_lead_triage_annotation";
const LEAD_TRIAGE_SHADOW_REQUESTED_EFFECTS = [
  "local_lead_triage_annotation",
];
const LEAD_TRIAGE_SHADOW_TRANSPORT_STATUSES = ["pushed", "reconciled"];

type PolicyStatus = "shadow" | "disabled" | "revoked";
type IdempotencyState = "fresh" | "replayed";

export type LeadTriageShadowReasonCode =
  | "shadow_eligible"
  | "policy_invalid"
  | "policy_schema_mismatch"
  | "policy_disabled"
  | "policy_revoked"
  | "policy_not_current"
  | "policy_stale"
  | "facts_invalid"
  | "tenant_mismatch"
  | "policy_reference_mismatch"
  | "action_mismatch"
  | "idempotency_replayed"
  | "facts_stale"
  | "lead_not_local"
  | "lead_not_untriaged"
  | "facts_contradictory"
  | "transport_state_ineligible"
  | "scope_expanded";

export interface LeadTriageShadowDecision {
  outcome: "shadow_eligible" | "human_approval_required";
  reason_code: LeadTriageShadowReasonCode;
  human_approval_required: true;
  policy_id: string | null;
  policy_version: string | null;
  policy_digest: string | null;
  idempotency_key_sha256: string | null;
}

interface LeadTriageShadowPolicy {
  schemaVersion: string;
  policyId: string;
  policyVersion: string;
  tenantId: string;
  action: string;
  mode: string;
  status: PolicyStatus;
  validFrom: number;
  validUntil: number;
  maxFactAgeSeconds: number;
  allowedFacts: {
    source: string;
    triageStatus: string;
    scope: string;
    requestedEffects: string[];
    transportStatuses: string[];
  };
}

interface LeadTriageShadowFacts {
  tenantId: string;
  policyId: string;
  policyVersion: string;
  action: string;
  leadEnvelopeId: string;
  source: string;
  triageStatus: string;
  triageAnnotationPresent: boolean;
  transportStatus: string;
  scope: string;
  requestedEffects: string[];
  idempotencyKey: string;
  idempotencyState: IdempotencyState;
  observedAt: number;
}

/**
 * Evaluates an intentionally non-executing lead-triage candidate. This module
 * has no Worker binding, route, broker, receipt, or mutable store dependency.
 */
export async function evaluateLeadTriageShadowAuthority(
  policyInput: unknown,
  factsInput: unknown,
  { now = new Date() }: { now?: Date } = {},
): Promise<LeadTriageShadowDecision> {
  const policy = parsePolicy(policyInput);
  if (!policy) return decision("policy_invalid");

  const policyDigest = await sha256Hex(canonicalJson(policyInput));
  const facts = parseFacts(factsInput);
  const idempotencyKeySha256 = facts
    ? await sha256Hex(facts.idempotencyKey)
    : null;
  const deny = (reasonCode: Exclude<LeadTriageShadowReasonCode, "shadow_eligible">) =>
    decision(reasonCode, policy, policyDigest, idempotencyKeySha256);

  if (policy.schemaVersion !== LEAD_TRIAGE_SHADOW_POLICY_SCHEMA) {
    return deny("policy_schema_mismatch");
  }
  if (policy.mode !== "shadow") return deny("policy_invalid");
  if (policy.status === "disabled") return deny("policy_disabled");
  if (policy.status === "revoked") return deny("policy_revoked");
  if (!matchesShadowPolicyContract(policy)) return deny("policy_invalid");
  if (policy.allowedFacts.scope !== LEAD_TRIAGE_SHADOW_SCOPE ||
      !sameStrings(policy.allowedFacts.requestedEffects, LEAD_TRIAGE_SHADOW_REQUESTED_EFFECTS)) {
    return deny("scope_expanded");
  }

  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return deny("policy_invalid");
  if (nowMs < policy.validFrom) return deny("policy_not_current");
  if (nowMs >= policy.validUntil) return deny("policy_stale");
  if (!facts) return deny("facts_invalid");
  if (facts.tenantId !== policy.tenantId) return deny("tenant_mismatch");
  if (facts.policyId !== policy.policyId || facts.policyVersion !== policy.policyVersion) {
    return deny("policy_reference_mismatch");
  }
  if (facts.action !== policy.action || facts.action !== LEAD_TRIAGE_SHADOW_ACTION) {
    return deny("action_mismatch");
  }
  if (facts.idempotencyState !== "fresh") return deny("idempotency_replayed");
  if (facts.observedAt > nowMs || nowMs - facts.observedAt > policy.maxFactAgeSeconds * 1_000) {
    return deny("facts_stale");
  }
  if (facts.source !== policy.allowedFacts.source) return deny("lead_not_local");
  if (facts.triageStatus !== policy.allowedFacts.triageStatus) return deny("lead_not_untriaged");
  if (facts.triageAnnotationPresent) return deny("facts_contradictory");
  if (!policy.allowedFacts.transportStatuses.includes(facts.transportStatus)) {
    return deny("transport_state_ineligible");
  }
  if (facts.scope !== policy.allowedFacts.scope ||
      !sameStrings(facts.requestedEffects, policy.allowedFacts.requestedEffects)) {
    return deny("scope_expanded");
  }
  return decision("shadow_eligible", policy, policyDigest, idempotencyKeySha256);
}

function decision(
  reasonCode: LeadTriageShadowReasonCode,
  policy?: LeadTriageShadowPolicy,
  policyDigest: string | null = null,
  idempotencyKeySha256: string | null = null,
): LeadTriageShadowDecision {
  return {
    outcome: reasonCode === "shadow_eligible" ? "shadow_eligible" : "human_approval_required",
    reason_code: reasonCode,
    human_approval_required: true,
    policy_id: policy?.policyId ?? null,
    policy_version: policy?.policyVersion ?? null,
    policy_digest: policyDigest,
    idempotency_key_sha256: idempotencyKeySha256,
  };
}

function parsePolicy(value: unknown): LeadTriageShadowPolicy | null {
  if (!exactKeys(value, [
    "schema_version", "policy_id", "policy_version", "tenant_id", "action", "mode", "status",
    "valid_from", "valid_until", "max_fact_age_seconds", "allowed_facts",
  ])) return null;
  const allowedFacts = value.allowed_facts;
  if (!exactKeys(allowedFacts, [
    "source", "triage_status", "scope", "requested_effects", "transport_statuses",
  ])) return null;
  const validFrom = isoMillis(value.valid_from);
  const validUntil = isoMillis(value.valid_until);
  if (validFrom === null || validUntil === null || validUntil <= validFrom ||
      !text(value.schema_version, 3, 120) || !identifier(value.policy_id) ||
      !/^v[1-9][0-9]*$/.test(String(value.policy_version ?? "")) ||
      !tenantId(value.tenant_id) || !text(value.action, 3, 140) ||
      !text(value.mode, 3, 32) || !["shadow", "disabled", "revoked"].includes(String(value.status)) ||
      !boundedInt(value.max_fact_age_seconds, 1, 3_600) ||
      !text(allowedFacts.source, 3, 64) || !text(allowedFacts.triage_status, 3, 64) ||
      !text(allowedFacts.scope, 3, 140) ||
      !uniqueTexts(allowedFacts.requested_effects, 1, 8) ||
      !uniqueTexts(allowedFacts.transport_statuses, 1, 8)) return null;
  return {
    schemaVersion: value.schema_version as string,
    policyId: value.policy_id as string,
    policyVersion: value.policy_version as string,
    tenantId: value.tenant_id as string,
    action: value.action as string,
    mode: value.mode as string,
    status: value.status as PolicyStatus,
    validFrom,
    validUntil,
    maxFactAgeSeconds: value.max_fact_age_seconds as number,
    allowedFacts: {
      source: allowedFacts.source as string,
      triageStatus: allowedFacts.triage_status as string,
      scope: allowedFacts.scope as string,
      requestedEffects: allowedFacts.requested_effects as string[],
      transportStatuses: allowedFacts.transport_statuses as string[],
    },
  };
}

function parseFacts(value: unknown): LeadTriageShadowFacts | null {
  if (!exactKeys(value, [
    "tenant_id", "policy_id", "policy_version", "action", "lead_envelope_id", "source",
    "triage_status", "triage_annotation_present", "transport_status", "scope", "requested_effects",
    "idempotency_key", "idempotency_state", "observed_at",
  ])) return null;
  const observedAt = isoMillis(value.observed_at);
  if (!tenantId(value.tenant_id) || !identifier(value.policy_id) ||
      !/^v[1-9][0-9]*$/.test(String(value.policy_version ?? "")) || !text(value.action, 3, 140) ||
      !identifier(value.lead_envelope_id) || !text(value.source, 3, 64) ||
      !text(value.triage_status, 3, 64) || typeof value.triage_annotation_present !== "boolean" ||
      !text(value.transport_status, 3, 64) || !text(value.scope, 3, 140) ||
      !uniqueTexts(value.requested_effects, 1, 8) || !text(value.idempotency_key, 8, 140) ||
      !["fresh", "replayed"].includes(String(value.idempotency_state)) || observedAt === null) return null;
  return {
    tenantId: value.tenant_id as string,
    policyId: value.policy_id as string,
    policyVersion: value.policy_version as string,
    action: value.action as string,
    leadEnvelopeId: value.lead_envelope_id as string,
    source: value.source as string,
    triageStatus: value.triage_status as string,
    triageAnnotationPresent: value.triage_annotation_present,
    transportStatus: value.transport_status as string,
    scope: value.scope as string,
    requestedEffects: value.requested_effects as string[],
    idempotencyKey: value.idempotency_key as string,
    idempotencyState: value.idempotency_state as IdempotencyState,
    observedAt,
  };
}

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    value === value.trim() && !/[\x00\r\n]/.test(value);
}

function identifier(value: unknown): value is string {
  return text(value, 1, 140) && /^[A-Za-z0-9._:-]+$/.test(value);
}

function tenantId(value: unknown): value is string {
  return text(value, 2, 64) && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function boundedInt(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function uniqueTexts(value: unknown, min: number, max: number): value is string[] {
  return Array.isArray(value) && value.length >= min && value.length <= max &&
    value.every((item) => text(item, 3, 140)) && new Set(value).size === value.length;
}

function isoMillis(value: unknown): number | null {
  if (!text(value, 24, 30)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function matchesShadowPolicyContract(policy: LeadTriageShadowPolicy): boolean {
  return policy.policyId === LEAD_TRIAGE_SHADOW_POLICY_ID &&
    policy.policyVersion === LEAD_TRIAGE_SHADOW_POLICY_VERSION &&
    policy.tenantId === LEAD_TRIAGE_SHADOW_TENANT_ID &&
    policy.action === LEAD_TRIAGE_SHADOW_ACTION &&
    policy.allowedFacts.source === LEAD_TRIAGE_SHADOW_SOURCE &&
    policy.allowedFacts.triageStatus === LEAD_TRIAGE_SHADOW_TRIAGE_STATUS &&
    sameStrings(policy.allowedFacts.transportStatuses, LEAD_TRIAGE_SHADOW_TRANSPORT_STATUSES);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
