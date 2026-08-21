import type { AppEnv } from "./app-types.ts";
import type { EffectActorType, EffectAuthority } from "./effect-runtime.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

export const COMMERCIAL_ACTIONS = [
  "lead.triage.record",
  "quote.revision.record",
  "proposal.revision.record",
  "proposal.publish",
  "proposal.withdraw",
] as const;

export type CommercialAction = (typeof COMMERCIAL_ACTIONS)[number];
export type CommercialAggregateType =
  | "lead"
  | "customer_quote"
  | "proposal"
  | "proposal_publication";

export interface CommercialEvidenceRef {
  ref: string;
  sha256: string;
}

export interface CommercialPermitRecord {
  permit_id: string;
  tenant_id: string;
  policy_id: string;
  policy_version: string;
  policy_digest: string;
  policy_snapshot_json: string;
  action: CommercialAction;
  actor_type: EffectActorType;
  actor_id: string;
  aggregate_type: CommercialAggregateType;
  aggregate_id: string;
  aggregate_version: number;
  amount_cents: number | null;
  command_fingerprint: string;
  facts_digest: string;
  evidence_refs_json: string;
  evidence_digest: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  issued_at: string;
  expires_at: string;
}

export interface AdmitCommercialPermitInput {
  tenantId: string;
  actor: { type: EffectActorType; id: string };
  action: CommercialAction;
  aggregate: { type: CommercialAggregateType; id: string; version: number };
  amountCents?: number | null;
  command: unknown;
  facts: unknown;
  factsObservedAt: string;
  evidence: readonly CommercialEvidenceRef[];
  idempotencyKey: string;
  expiresAt: string;
}

export type CommercialAuthorityBinding =
  | { kind: "policy_permit"; permitId: string }
  | {
      kind: "approval_request";
      requestId: string;
      legacyTargetId: string;
      legacyArgsDigest: string;
    };

export interface CommercialAuthorityExpectation {
  tenantId: string;
  action: CommercialAction;
  aggregate: { type: CommercialAggregateType; id: string; version: number };
  commandFingerprint: string;
  amountCents?: number | null;
  roofJobId?: string;
  customerQuoteId?: string;
  proposalPackId?: string;
  now: string;
}

export interface ResolvedCommercialAuthority {
  kind: "policy_permit" | "approval_request";
  authorityRef: string;
  actorType: EffectActorType;
  actorId: string;
  evidenceDigest: string;
  policyPermitId: string | null;
  approvalRequestId: string | null;
}

type CommercialEnv = AppEnv & { COMMERCIAL_AUTHORITY_POLICY_JSON?: string };

interface CommercialPolicy {
  schema_version: "ironwrap.commercial-authority-policy.v1";
  policy_id: string;
  policy_version: string;
  tenant_id: string;
  status: "active" | "revoked" | "disabled";
  valid_from: string;
  valid_until: string;
  max_fact_age_seconds: number;
  max_permit_lifetime_seconds: number;
  allowed_actions: CommercialAction[];
  allowed_actor_types: EffectActorType[];
  max_quote_total_cents: number;
}

export class CommercialAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export async function commercialCommandFingerprint(command: unknown): Promise<string> {
  const json = boundedCanonicalJson(command, 131_072, "commercial_command_invalid");
  return await sha256Hex(json);
}

export async function admitCommercialPermit(
  env: CommercialEnv,
  input: AdmitCommercialPermitInput,
  now = new Date(),
): Promise<{ kind: "created" | "replayed"; permit: CommercialPermitRecord }> {
  const policy = configuredPolicy(env);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) fail("commercial_clock_invalid");
  const nowIso = now.toISOString();
  const validFrom = Date.parse(policy.valid_from);
  const validUntil = Date.parse(policy.valid_until);
  const observedAt = Date.parse(input.factsObservedAt);
  const expiresAt = Date.parse(input.expiresAt);

  if (policy.status !== "active") fail("commercial_policy_inactive");
  if (policy.tenant_id !== input.tenantId) fail("commercial_policy_tenant_mismatch");
  if (nowMs < validFrom || nowMs >= validUntil) fail("commercial_policy_not_current");
  if (!policy.allowed_actions.includes(input.action)) fail("commercial_policy_action_denied");
  if (!policy.allowed_actor_types.includes(input.actor.type)) fail("commercial_policy_actor_denied");
  if (!actorIdentifier(input.actor.id, 160)) fail("commercial_actor_invalid");
  assertAggregate(input.aggregate);
  if (!canonicalIso(input.factsObservedAt) || observedAt > nowMs + 30_000) {
    fail("commercial_facts_timestamp_invalid");
  }
  if (nowMs - observedAt > policy.max_fact_age_seconds * 1_000) fail("commercial_facts_stale");
  if (
    !canonicalIso(input.expiresAt) || expiresAt <= nowMs || expiresAt > validUntil ||
    expiresAt - nowMs > policy.max_permit_lifetime_seconds * 1_000
  ) fail("commercial_permit_expiry_invalid");

  const amountCents = input.amountCents ?? null;
  if (input.action === "quote.revision.record") {
    if (!money(amountCents) || amountCents > policy.max_quote_total_cents) {
      fail("commercial_policy_amount_ceiling_exceeded");
    }
  } else if (amountCents !== null) {
    fail("commercial_policy_amount_not_applicable");
  }

  const evidence = evidenceRefs(input.evidence);
  const policySnapshotJson = canonicalJson(policy);
  const policyDigest = await sha256Hex(policySnapshotJson);
  const commandFingerprint = await commercialCommandFingerprint(input.command);
  const factsJson = boundedCanonicalJson(input.facts, 65_536, "commercial_facts_invalid");
  const factsDigest = await sha256Hex(factsJson);
  const evidenceRefsJson = canonicalJson(evidence);
  const evidenceDigest = await sha256Hex(evidenceRefsJson);
  const idempotencyKey = boundedText(input.idempotencyKey, 8, 280, "commercial_idempotency_key_invalid");
  const idempotencyKeyHash = await sha256Hex(idempotencyKey);
  const requestFingerprint = await sha256Hex(canonicalJson({
    tenant_id: input.tenantId,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_digest: policyDigest,
    actor: input.actor,
    action: input.action,
    aggregate: input.aggregate,
    amount_cents: amountCents,
    command_fingerprint: commandFingerprint,
    facts_digest: factsDigest,
    evidence_digest: evidenceDigest,
    expires_at: input.expiresAt,
  }));
  const permitId = `commercial-permit:${await sha256Hex(`${input.tenantId}:${idempotencyKeyHash}`)}`;
  const existing = await getCommercialPermit(env, input.tenantId, permitId, idempotencyKeyHash);
  if (existing) {
    if (existing.request_fingerprint !== requestFingerprint) fail("commercial_permit_idempotency_conflict");
    return { kind: "replayed", permit: existing };
  }

  let result;
  try {
    result = await env.DB.prepare(
      `INSERT INTO commercial_authority_permits (
         permit_id, tenant_id, policy_id, policy_version, policy_digest, policy_snapshot_json,
         action, actor_type, actor_id, aggregate_type, aggregate_id, aggregate_version,
         amount_cents, command_fingerprint, facts_digest, evidence_refs_json, evidence_digest,
         idempotency_key_hash, request_fingerprint, issued_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      permitId, input.tenantId, policy.policy_id, policy.policy_version, policyDigest,
      policySnapshotJson, input.action, input.actor.type, input.actor.id, input.aggregate.type,
      input.aggregate.id, input.aggregate.version, amountCents, commandFingerprint, factsDigest,
      evidenceRefsJson, evidenceDigest, idempotencyKeyHash, requestFingerprint, nowIso, input.expiresAt,
    ).run();
  } catch (error) {
    const concurrent = await getCommercialPermit(env, input.tenantId, permitId, idempotencyKeyHash);
    if (!concurrent) throw error;
    if (concurrent.request_fingerprint !== requestFingerprint) fail("commercial_permit_idempotency_conflict");
    return { kind: "replayed", permit: concurrent };
  }
  const stored = await getCommercialPermit(env, input.tenantId, permitId, idempotencyKeyHash);
  if (!stored) fail("commercial_permit_write_failed");
  if (stored.request_fingerprint !== requestFingerprint) fail("commercial_permit_idempotency_conflict");
  return { kind: d1Changes(result) === 1 ? "created" : "replayed", permit: stored };
}

export async function getCommercialPermit(
  env: AppEnv,
  tenantId: string,
  permitId: string,
  idempotencyKeyHash?: string,
): Promise<CommercialPermitRecord | null> {
  const suffix = idempotencyKeyHash ? " AND idempotency_key_hash = ?" : "";
  const statement = env.DB.prepare(
    `SELECT * FROM commercial_authority_permits WHERE tenant_id = ? AND permit_id = ?${suffix}`,
  );
  return idempotencyKeyHash
    ? await statement.bind(tenantId, permitId, idempotencyKeyHash).first<CommercialPermitRecord>()
    : await statement.bind(tenantId, permitId).first<CommercialPermitRecord>();
}

export function commercialEffectAuthority(permit: CommercialPermitRecord): EffectAuthority {
  return {
    permitRef: permit.permit_id,
    policyRef: permit.policy_id,
    policyVersion: permit.policy_version,
    tenantId: permit.tenant_id,
    actorType: permit.actor_type,
    actorId: permit.actor_id,
    expiresAt: permit.expires_at,
    allowedActions: [permit.action],
  };
}

export function commercialActionConfigured(
  env: CommercialEnv,
  tenantId: string,
  action: CommercialAction,
  actorType: EffectActorType,
  now = new Date(),
): boolean {
  try {
    const policy = configuredPolicy(env);
    const timestamp = now.getTime();
    return Number.isFinite(timestamp) &&
      policy.status === "active" &&
      policy.tenant_id === tenantId &&
      timestamp >= Date.parse(policy.valid_from) &&
      timestamp < Date.parse(policy.valid_until) &&
      policy.allowed_actions.includes(action) &&
      policy.allowed_actor_types.includes(actorType);
  } catch {
    return false;
  }
}

export async function resolveCommercialAuthority(
  env: AppEnv,
  binding: CommercialAuthorityBinding,
  expected: CommercialAuthorityExpectation,
): Promise<ResolvedCommercialAuthority> {
  if (!canonicalIso(expected.now)) fail("commercial_clock_invalid");
  if (binding.kind === "policy_permit") {
    const permit = await getCommercialPermit(env, expected.tenantId, binding.permitId);
    if (!permit) fail("commercial_permit_missing");
    const currentPolicy = configuredPolicy(env as CommercialEnv);
    const currentPolicyDigest = await sha256Hex(canonicalJson(currentPolicy));
    const expectedAt = Date.parse(expected.now);
    if (
      permit.action !== expected.action || permit.aggregate_type !== expected.aggregate.type ||
      permit.aggregate_id !== expected.aggregate.id || permit.aggregate_version !== expected.aggregate.version ||
      permit.command_fingerprint !== expected.commandFingerprint ||
      permit.amount_cents !== (expected.amountCents ?? null)
    ) fail("commercial_permit_binding_mismatch");
    if (
      currentPolicy.status !== "active" || currentPolicy.tenant_id !== expected.tenantId ||
      currentPolicy.policy_id !== permit.policy_id || currentPolicy.policy_version !== permit.policy_version ||
      currentPolicyDigest !== permit.policy_digest || !currentPolicy.allowed_actions.includes(expected.action) ||
      !currentPolicy.allowed_actor_types.includes(permit.actor_type) ||
      expectedAt < Date.parse(currentPolicy.valid_from) || expectedAt >= Date.parse(currentPolicy.valid_until)
    ) fail("commercial_permit_policy_not_current");
    if (Date.parse(permit.issued_at) > expectedAt) fail("commercial_permit_not_yet_valid");
    if (Date.parse(permit.expires_at) <= expectedAt) fail("commercial_permit_expired");
    return {
      kind: "policy_permit",
      authorityRef: permit.permit_id,
      actorType: permit.actor_type,
      actorId: permit.actor_id,
      evidenceDigest: permit.evidence_digest,
      policyPermitId: permit.permit_id,
      approvalRequestId: null,
    };
  }

  const legacyTargetId = boundedText(
    binding.legacyTargetId,
    1,
    160,
    "commercial_approval_target_invalid",
  );
  const legacyArgsDigest = sha256(binding.legacyArgsDigest, "commercial_approval_digest_invalid");
  const approved = await resolvedApproval(env, binding.requestId, legacyTargetId, legacyArgsDigest, expected);
  return {
    kind: "approval_request",
    authorityRef: `approval:${approved.kind}:${approved.id}`,
    actorType: "owner",
    actorId: approved.actorId,
    evidenceDigest: approved.evidenceDigest,
    policyPermitId: null,
    approvalRequestId: approved.id,
  };
}

async function resolvedApproval(
  env: AppEnv,
  requestId: string,
  legacyTargetId: string,
  legacyArgsDigest: string,
  expected: CommercialAuthorityExpectation,
): Promise<{ kind: string; id: string; actorId: string; evidenceDigest: string }> {
  if (expected.action === "lead.triage.record") {
    const row = await env.DB.prepare(
      `SELECT approval_request_id AS id, state, version, lead_envelope_id AS target_id,
              approved_by_user_id AS actor_id, args_digest, preview_digest, result_json,
              reconciliation_outcome, reconciliation_evidence
         FROM approval_requests
        WHERE tenant_id = ? AND approval_request_id = ?`,
    ).bind(expected.tenantId, requestId).first<ApprovalRow>();
    return approvalRow(row, "lead_triage", requestId, legacyTargetId, legacyArgsDigest);
  }
  if (expected.action === "quote.revision.record") {
    const row = await env.DB.prepare(
      `SELECT quote_revision_approval_id AS id, state, version,
              target_customer_quote_id AS target_id, target_quote_version, roof_job_id,
              approved_by_user_id AS actor_id, args_digest, preview_digest, result_json,
              reconciliation_outcome, reconciliation_evidence
         FROM quote_revision_approval_requests
        WHERE tenant_id = ? AND quote_revision_approval_id = ?`,
    ).bind(expected.tenantId, requestId).first<ApprovalRow>();
    if (
      row && (row.target_quote_version !== expected.aggregate.version || row.roof_job_id !== expected.roofJobId ||
        row.target_id !== expected.customerQuoteId)
    ) fail("commercial_approval_binding_mismatch");
    return approvalRow(row, "quote_revision", requestId, legacyTargetId, legacyArgsDigest);
  }
  if (expected.action === "proposal.publish") {
    const row = await env.DB.prepare(
      `SELECT proposal_publication_approval_id AS id, state, version,
              proposal_evidence_pack_id AS target_id, customer_quote_id, roof_job_id,
              approved_by_user_id AS actor_id, args_digest, preview_digest, result_json,
              reconciliation_outcome, reconciliation_evidence
         FROM proposal_publication_approval_requests
        WHERE tenant_id = ? AND proposal_publication_approval_id = ?`,
    ).bind(expected.tenantId, requestId).first<ApprovalRow>();
    if (
      row && (row.roof_job_id !== expected.roofJobId || row.customer_quote_id !== expected.customerQuoteId ||
        row.target_id !== expected.proposalPackId)
    ) fail("commercial_approval_binding_mismatch");
    return approvalRow(row, "proposal_publication", requestId, legacyTargetId, legacyArgsDigest);
  }
  fail("commercial_approval_not_supported");
}

interface ApprovalRow {
  id: string;
  state: string;
  version: number;
  target_id: string;
  target_quote_version?: number;
  roof_job_id?: string;
  customer_quote_id?: string;
  actor_id: string | null;
  args_digest: string;
  preview_digest: string;
  result_json: string | null;
  reconciliation_outcome: string | null;
  reconciliation_evidence: string | null;
}

function approvalRow(
  row: ApprovalRow | null,
  kind: string,
  requestId: string,
  targetId: string,
  argsDigest: string,
): { kind: string; id: string; actorId: string; evidenceDigest: string } {
  if (!row) fail("commercial_approval_missing");
  if (!executedApproval(row) || !row.actor_id) fail("commercial_approval_not_executed");
  if (row.target_id !== targetId || row.args_digest !== argsDigest) fail("commercial_approval_binding_mismatch");
  return {
    kind,
    id: requestId,
    actorId: row.actor_id,
    evidenceDigest: sha256(row.args_digest, "commercial_approval_evidence_invalid"),
  };
}

function executedApproval(row: ApprovalRow): boolean {
  return row.state === "executed" ||
    (row.state === "execution_uncertain" && row.reconciliation_outcome === "executed" &&
      typeof row.reconciliation_evidence === "string" && row.reconciliation_evidence.length >= 3);
}

function configuredPolicy(env: CommercialEnv): CommercialPolicy {
  const raw = env.COMMERCIAL_AUTHORITY_POLICY_JSON;
  if (!raw || raw.length > 32_768) fail("commercial_policy_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("commercial_policy_invalid");
  }
  if (!exactKeys(parsed, [
    "schema_version", "policy_id", "policy_version", "tenant_id", "status", "valid_from",
    "valid_until", "max_fact_age_seconds", "max_permit_lifetime_seconds", "allowed_actions",
    "allowed_actor_types", "max_quote_total_cents",
  ])) fail("commercial_policy_invalid");
  const actions = uniqueEnum(parsed.allowed_actions, COMMERCIAL_ACTIONS);
  const actors = uniqueEnum(parsed.allowed_actor_types, [
    "agent", "worker", "customer", "external_authority", "device", "owner",
  ] as const);
  if (
    parsed.schema_version !== "ironwrap.commercial-authority-policy.v1" ||
    !strictIdentifier(parsed.policy_id, 3, 120) || !/^v[1-9][0-9]*$/.test(String(parsed.policy_version)) ||
    !tenantId(parsed.tenant_id) || !["active", "revoked", "disabled"].includes(String(parsed.status)) ||
    !canonicalIso(parsed.valid_from) || !canonicalIso(parsed.valid_until) ||
    Date.parse(String(parsed.valid_until)) <= Date.parse(String(parsed.valid_from)) ||
    !integer(parsed.max_fact_age_seconds, 1, 3600) ||
    !integer(parsed.max_permit_lifetime_seconds, 30, 900) || !actions || !actors ||
    actions.length === 0 || actors.length === 0 || !money(parsed.max_quote_total_cents)
  ) fail("commercial_policy_invalid");
  return {
    schema_version: "ironwrap.commercial-authority-policy.v1",
    policy_id: String(parsed.policy_id),
    policy_version: String(parsed.policy_version),
    tenant_id: String(parsed.tenant_id),
    status: parsed.status as CommercialPolicy["status"],
    valid_from: String(parsed.valid_from),
    valid_until: String(parsed.valid_until),
    max_fact_age_seconds: Number(parsed.max_fact_age_seconds),
    max_permit_lifetime_seconds: Number(parsed.max_permit_lifetime_seconds),
    allowed_actions: actions,
    allowed_actor_types: actors,
    max_quote_total_cents: Number(parsed.max_quote_total_cents),
  };
}

function assertAggregate(value: AdmitCommercialPermitInput["aggregate"]): void {
  if (
    !["lead", "customer_quote", "proposal", "proposal_publication"].includes(value.type) ||
    !strictIdentifier(value.id, 8, 200) || !integer(value.version, 1, 1_000_000)
  ) fail("commercial_aggregate_invalid");
}

function evidenceRefs(value: readonly CommercialEvidenceRef[]): CommercialEvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) fail("commercial_evidence_invalid");
  const refs = value.map((entry) => {
    if (!entry || !evidenceRef(entry.ref) || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail("commercial_evidence_invalid");
    }
    return { ref: entry.ref, sha256: entry.sha256 };
  });
  if (new Set(refs.map(({ ref }) => ref)).size !== refs.length) fail("commercial_evidence_duplicate");
  return refs;
}

function evidenceRef(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 512 &&
    !/[\s?#]/.test(value) && !value.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function boundedCanonicalJson(value: unknown, max: number, code: string): string {
  let json: string;
  try {
    json = canonicalJson(value);
  } catch {
    fail(code);
  }
  if (json.length < 2 || json.length > max) fail(code);
  return json;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function uniqueEnum<T extends string>(value: unknown, allowed: readonly T[]): T[] | null {
  if (!Array.isArray(value) || value.length > allowed.length) return null;
  const result = value.filter((entry): entry is T => typeof entry === "string" && allowed.includes(entry as T));
  return result.length === value.length && new Set(result).size === result.length ? result : null;
}

function actorIdentifier(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value);
}

function strictIdentifier(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function tenantId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function money(value: unknown): value is number {
  return integer(value, 0, 1_000_000_000_000);
}

function boundedText(value: unknown, min: number, max: number, code: string): string {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) fail(code);
  return value;
}

function sha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(code);
  return value;
}

function d1Changes(result: { meta?: { changes?: number } }): number {
  return Number(result.meta?.changes ?? 0);
}

function fail(code: string): never {
  throw new CommercialAuthorityError(code);
}
