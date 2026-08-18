import { sha256Hex } from "./app-auth.ts";
import { canonicalJson } from "./newo-hash.ts";
import { assertEffectLedgerReady, EffectRuntimeError, runExternalEffect } from "./effect-runtime.ts";
import type { AppEnv } from "./app-types.ts";

export const POSTIZ_EXPECTED_VERSION = "v2.23.0" as const;
export const POSTIZ_PROVIDERS = ["facebook", "linkedin-page", "gmb"] as const;
export type PostizProvider = (typeof POSTIZ_PROVIDERS)[number];

export type PostizIntentState =
  | "connection_required"
  | "pending_review"
  | "rejected"
  | "submission_pending"
  | "submitted"
  | "published"
  | "reconciliation_required"
  | "stop_submitted"
  | "stop_reconciliation_required";

export interface PostizCitation {
  id: string;
  label: string;
  source_ref: string;
}

interface PostizIntentRow {
  intent_id: string;
  tenant_id: string;
  remote_post_id: string;
  draft_idempotency_sha256: string;
  intent_fingerprint_sha256: string;
  drafted_by_agent_role: "specialized_marketing_agent";
  trigger_ref: string;
  title: string;
  content: string;
  provider: PostizProvider;
  integration_id: string | null;
  scheduled_at: string;
  evidence_refs_json: string;
  citations_json: string;
  permission_scope: string;
  state: PostizIntentState;
  version: number;
  submission_effect_id: string;
  stop_effect_id: string;
  approval_idempotency_sha256: string | null;
  rejection_idempotency_sha256: string | null;
  stop_idempotency_sha256: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  rejected_by_user_id: string | null;
  rejected_at: string | null;
  stop_requested_by_user_id: string | null;
  stop_requested_at: string | null;
  remote_state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT" | null;
  release_url: string | null;
  last_reconciled_at: string | null;
  published_observed_at: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface PostizEffectRow {
  effect_id: string;
  tenant_id: string;
  intent_id: string | null;
  operation: "connect" | "submit" | "stop";
  provider: PostizProvider;
  requested_by_user_id: string | null;
  idempotency_key_sha256: string;
  request_fingerprint_sha256: string;
  state: "pending" | "attempting" | "submitted" | "failed" | "unknown";
  attempt_count: number;
}

export interface PostizIntentProjection {
  id: string;
  title: string;
  content: string;
  provider: PostizProvider;
  integration_id: string | null;
  scheduled_at: string;
  evidence_refs: string[];
  citations: PostizCitation[];
  permission_scope: string;
  state: PostizIntentState;
  version: number;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostizIntentEnvelope {
  version: 1;
  adapter: { name: "postiz"; expected_version: typeof POSTIZ_EXPECTED_VERSION };
  enabled: boolean;
  connected: boolean;
  allowed_actions: Array<
    | "postiz.connect"
    | "postiz.intent.review"
    | "postiz.intent.approve"
    | "postiz.intent.reject"
    | "postiz.intent.stop"
    | "postiz.intent.reconcile"
  >;
  intent: PostizIntentProjection;
  reconciliation: {
    last_checked_at: string | null;
    remote_state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT" | null;
    release_url: null;
    detail_code: string | null;
  };
}

type Rejected = { kind: "rejected"; code: string; status: 400 | 403 | 404 | 409 | 502 | 503 };
type IntentResult =
  | { kind: "created" | "replayed" | "updated"; intent: PostizIntentRow }
  | Rejected;

interface PostizConfig {
  baseUrl: string;
  apiKey: string;
  allowedProviders: Set<PostizProvider>;
  timeoutMs: number;
}

interface FacetApprovalEventRow {
  event_id: string;
  event_type: "facet.design.customer_approved.v2";
  occurred_at: string;
  received_at: string;
  tenant_id: string;
  brand_id: string;
  frozen_evidence_sha256: string;
  raw_key: string;
}

const ACTIONABLE_STATES: PostizIntentState[] = [
  "connection_required",
  "pending_review",
  "reconciliation_required",
  "stop_reconciliation_required",
];
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const RECONCILIATION_LIMIT = 5;
const PUBLICATION_READBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FACET_DRAFT_SAFE_LEAD_MS = 24 * 60 * 60 * 1000;

export function postizEnabled(env: AppEnv): boolean {
  return String(env.POSTIZ_ENABLED ?? "") === "true";
}

export function postizConfigured(env: AppEnv): boolean {
  return postizConfig(env) !== null;
}

/**
 * Turns one existing R2-first, D1-anchored Facet customer-approval event into a
 * privacy-safe marketing review intent. The immutable event id is the draft
 * idempotency key; no Facet body or binary evidence is read into this slice.
 */
export async function createPostizDraftFromFacetApproval(
  env: AppEnv,
  eventId: string,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<"disabled" | "not_eligible" | IntentResult> {
  if (String(env.POSTIZ_FACET_DRAFT_ENABLED ?? "") !== "true") return "disabled";
  const watermark = facetDraftWatermark(env);
  if (!watermark) return rejected("postiz_facet_draft_not_configured", 503);
  if (!validOpaqueRef(eventId)) return "not_eligible";
  const event = await env.DB.prepare(
    `SELECT event_id, event_type, occurred_at, received_at, tenant_id, brand_id,
            frozen_evidence_sha256, raw_key
       FROM facet_customer_approval_events
      WHERE event_id = ? AND event_type = 'facet.design.customer_approved.v2'
      LIMIT 1`,
  ).bind(eventId).first<FacetApprovalEventRow>();
  if (!event) return "not_eligible";
  if (!facetEventAtOrAfterWatermark(event, watermark)) return "not_eligible";
  const draftIdempotencyKey = `facet.design.customer_approved.v2:${event.event_id}`;
  const existing = await intentByDraftIdempotency(
    env,
    event.tenant_id,
    await scopedHash(event.tenant_id, draftIdempotencyKey),
  );
  if (existing) return { kind: "replayed", intent: existing };
  const trigger = facetDraftConfig(env, event, now);
  if (!trigger) return rejected("postiz_facet_draft_not_configured", 503);
  const created = await createPostizDraft(env, {
    tenantId: event.tenant_id,
    agentRole: "specialized_marketing_agent",
    triggerRef: `facet-approval:${event.event_id}`,
    title: `${trigger.brandName} design approval`,
    content: `${trigger.brandName} has a customer-approved exterior design ready for its next verified step.`,
    provider: trigger.provider,
    scheduledAt: trigger.scheduledAt,
    evidenceRefs: [
      `facet-approval:${event.event_id}`,
      `r2:${event.raw_key}`,
      `sha256:${event.frozen_evidence_sha256}`,
    ],
    citations: [
      {
        id: `facet-event:${event.event_id}`,
        label: "Customer-approved Facet design event",
        source_ref: `facet-approval:${event.event_id}`,
      },
    ],
    permissionScope: `brand:${event.brand_id}:marketing.social.review`,
    idempotencyKey: draftIdempotencyKey,
    fetcher,
    now,
  });
  if (created.kind !== "rejected" || created.code !== "postiz_draft_idempotency_conflict")
    return created;
  const raced = await intentByDraftIdempotency(
    env,
    event.tenant_id,
    await scopedHash(event.tenant_id, draftIdempotencyKey),
  );
  return raced ? { kind: "replayed", intent: raced } : created;
}

export async function recoverPostizFacetDrafts(
  env: AppEnv,
  fetcher: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<{ eligible: number; created: number }> {
  if (String(env.POSTIZ_FACET_DRAFT_ENABLED ?? "") !== "true")
    return { eligible: 0, created: 0 };
  const watermark = facetDraftWatermark(env);
  if (!watermark) return { eligible: 0, created: 0 };
  const rows = await env.DB.prepare(
    `SELECT event.event_id
       FROM facet_customer_approval_events AS event
      WHERE event.event_type = 'facet.design.customer_approved.v2'
        AND event.occurred_at >= ?
        AND event.received_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM postiz_intents AS intent
           WHERE intent.tenant_id = event.tenant_id
             AND intent.trigger_ref = 'facet-approval:' || event.event_id
        )
      ORDER BY event.received_at ASC
      LIMIT ?`,
  ).bind(watermark.iso, watermark.iso, RECONCILIATION_LIMIT).all<{ event_id: string }>();
  let created = 0;
  for (const row of rows.results ?? []) {
    const result = await createPostizDraftFromFacetApproval(env, row.event_id, fetcher, now);
    if (typeof result !== "string" && (result.kind === "created" || result.kind === "replayed"))
      created += result.kind === "created" ? 1 : 0;
  }
  return { eligible: rows.results?.length ?? 0, created };
}

export async function createPostizDraft(
  env: AppEnv,
  input: {
    tenantId: string;
    agentRole: "specialized_marketing_agent";
    triggerRef: string;
    title: string;
    content: string;
    provider: PostizProvider;
    scheduledAt: string;
    evidenceRefs: string[];
    citations: PostizCitation[];
    permissionScope: string;
    idempotencyKey: string;
    now?: Date;
    intentId?: string;
    remotePostId?: string;
    submissionEffectId?: string;
    stopEffectId?: string;
    fetcher?: typeof fetch;
  },
): Promise<IntentResult> {
  const parsed = validateDraft(input);
  if (!parsed.ok) return rejected(parsed.code, 400);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const draftIdempotency = await scopedHash(input.tenantId, input.idempotencyKey);
  const fingerprint = await sha256Hex(JSON.stringify({
    trigger_ref: parsed.triggerRef,
    title: parsed.title,
    content: parsed.content,
    provider: parsed.provider,
    scheduled_at: parsed.scheduledAt,
    evidence_refs: parsed.evidenceRefs,
    citations: parsed.citations,
    permission_scope: parsed.permissionScope,
  }));
  const existing = await intentByDraftIdempotency(env, input.tenantId, draftIdempotency);
  if (existing) {
    return existing.intent_fingerprint_sha256 === fingerprint
      ? { kind: "replayed", intent: existing }
      : rejected("postiz_draft_idempotency_conflict", 409);
  }

  let integrationId: string | null = null;
  let errorCode: string | null = null;
  const config = postizConfig(env);
  if (config && config.allowedProviders.has(parsed.provider)) {
    const integration = await resolveIntegration(config, parsed.provider, input.fetcher ?? fetch);
    if (integration.kind === "connected") integrationId = integration.id;
    else errorCode = integration.code;
  } else {
    errorCode = postizEnabled(env) ? "postiz_not_configured" : "postiz_disabled";
  }
  const state: PostizIntentState = integrationId ? "pending_review" : "connection_required";
  const row: PostizIntentRow = {
    intent_id: input.intentId ?? crypto.randomUUID(),
    tenant_id: input.tenantId,
    remote_post_id: input.remotePostId ?? crypto.randomUUID(),
    draft_idempotency_sha256: draftIdempotency,
    intent_fingerprint_sha256: fingerprint,
    drafted_by_agent_role: input.agentRole,
    trigger_ref: parsed.triggerRef,
    title: parsed.title,
    content: parsed.content,
    provider: parsed.provider,
    integration_id: integrationId,
    scheduled_at: parsed.scheduledAt,
    evidence_refs_json: JSON.stringify(parsed.evidenceRefs),
    citations_json: JSON.stringify(parsed.citations),
    permission_scope: parsed.permissionScope,
    state,
    version: 1,
    submission_effect_id: input.submissionEffectId ?? crypto.randomUUID(),
    stop_effect_id: input.stopEffectId ?? crypto.randomUUID(),
    approval_idempotency_sha256: null,
    rejection_idempotency_sha256: null,
    stop_idempotency_sha256: null,
    approved_by_user_id: null,
    approved_at: null,
    rejected_by_user_id: null,
    rejected_at: null,
    stop_requested_by_user_id: null,
    stop_requested_at: null,
    remote_state: null,
    release_url: null,
    last_reconciled_at: null,
    published_observed_at: null,
    error_code: errorCode,
    created_at: nowIso,
    updated_at: nowIso,
  };
  const inserted = await env.DB.prepare(
    `INSERT INTO postiz_intents (
       intent_id, tenant_id, remote_post_id, draft_idempotency_sha256,
       intent_fingerprint_sha256, drafted_by_agent_role, trigger_ref, title,
       content, provider, integration_id, scheduled_at, evidence_refs_json,
       citations_json, permission_scope, state, version, submission_effect_id,
       stop_effect_id, error_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, draft_idempotency_sha256) DO NOTHING`,
  ).bind(
    row.intent_id,
    row.tenant_id,
    row.remote_post_id,
    row.draft_idempotency_sha256,
    row.intent_fingerprint_sha256,
    row.drafted_by_agent_role,
    row.trigger_ref,
    row.title,
    row.content,
    row.provider,
    row.integration_id,
    row.scheduled_at,
    row.evidence_refs_json,
    row.citations_json,
    row.permission_scope,
    row.state,
    row.submission_effect_id,
    row.stop_effect_id,
    row.error_code,
    row.created_at,
    row.updated_at,
  ).run();
  if (changes(inserted) === 1) return { kind: "created", intent: row };
  const raced = await intentByDraftIdempotency(env, input.tenantId, draftIdempotency);
  return raced?.intent_fingerprint_sha256 === fingerprint
    ? { kind: "replayed", intent: raced }
    : rejected("postiz_draft_idempotency_conflict", 409);
}

export async function listPostizActionableIntents(
  env: AppEnv,
  tenantId: string,
  limit = 8,
): Promise<PostizIntentProjection[]> {
  const placeholders = ACTIONABLE_STATES.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT * FROM postiz_intents
     WHERE tenant_id = ? AND state IN (${placeholders})
     ORDER BY updated_at ASC LIMIT ?`,
  ).bind(tenantId, ...ACTIONABLE_STATES, boundedLimit(limit)).all<PostizIntentRow>();
  return (rows.results ?? []).map(projectIntent);
}

export async function getPostizIntent(
  env: AppEnv,
  tenantId: string,
  intentId: string,
): Promise<PostizIntentRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM postiz_intents WHERE tenant_id = ? AND intent_id = ? LIMIT 1",
  ).bind(tenantId, intentId).first<PostizIntentRow>();
}

export function postizIntentEnvelope(
  env: AppEnv,
  row: PostizIntentRow,
): PostizIntentEnvelope {
  const enabled = postizConfigured(env);
  return {
    version: 1,
    adapter: { name: "postiz", expected_version: POSTIZ_EXPECTED_VERSION },
    enabled,
    connected: row.integration_id !== null,
    allowed_actions: allowedActions(enabled, row),
    intent: projectIntent(row),
    reconciliation: {
      last_checked_at: row.last_reconciled_at,
      remote_state: row.remote_state,
      // Pinned v2.23.0 providers emit several incompatible URL shapes.
      // Publication evidence is retained, but no remote URL is browser-safe.
      release_url: null,
      detail_code: row.error_code,
    },
  };
}

export async function requestPostizConnect(
  env: AppEnv,
  input: {
    tenantId: string;
    actorUserId: string;
    provider: PostizProvider;
    idempotencyKey: string;
    effectId?: string;
    fetcher?: typeof fetch;
    now?: Date;
  },
): Promise<
  | { kind: "created"; provider: PostizProvider; connectUrl: string; callbackOrigin: string }
  | Rejected
> {
  const config = postizConfig(env);
  if (!config) return rejected(postizEnabled(env) ? "postiz_not_configured" : "postiz_disabled", 503);
  if (!config.allowedProviders.has(input.provider))
    return rejected("postiz_provider_not_allowed", 400);
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  const fingerprint = await sha256Hex(JSON.stringify({ operation: "connect", provider: input.provider }));
  const existing = await effectByIdempotency(env, keyHash);
  if (existing) {
    if (existing.request_fingerprint_sha256 !== fingerprint)
      return rejected("postiz_idempotency_conflict", 409);
    if (existing.state !== "pending")
      return rejected("postiz_connect_handoff_already_requested", 409);
  } else {
    const nowIso = (input.now ?? new Date()).toISOString();
    await env.DB.prepare(
      `INSERT INTO postiz_effect_outbox (
         effect_id, tenant_id, operation, provider, requested_by_user_id,
         idempotency_key_sha256, request_fingerprint_sha256, state,
         attempt_count, created_at, updated_at
       ) VALUES (?, ?, 'connect', ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ).bind(
      input.effectId ?? crypto.randomUUID(), input.tenantId, input.provider,
      input.actorUserId, keyHash, fingerprint, nowIso, nowIso,
    ).run();
  }
  const effect = await effectByIdempotency(env, keyHash);
  if (!effect || !await claimEffect(env, effect.effect_id, input.now ?? new Date()))
    return rejected("postiz_connect_handoff_already_requested", 409);
  try {
    const response = await timedFetch(
      input.fetcher ?? fetch,
      `${config.baseUrl}/public/v1/social/${encodeURIComponent(input.provider)}`,
      { headers: providerHeaders(config.apiKey) },
      config.timeoutMs,
    );
    if (!response.ok) {
      await finishEffect(env, effect.effect_id, "failed", "http_error", response.status, "postiz_connect_rejected");
      return rejected("postiz_connect_rejected", 502);
    }
    const body = await boundedJson(response);
    const connectUrl = connectUrlForProvider(input.provider, body, config.baseUrl);
    if (!connectUrl) {
      await finishEffect(env, effect.effect_id, "unknown", "invalid_response", response.status, "postiz_connect_response_unverified");
      return rejected("postiz_connect_response_unverified", 502);
    }
    await finishEffect(env, effect.effect_id, "submitted", "accepted", response.status, null);
    return {
      kind: "created",
      provider: input.provider,
      connectUrl,
      callbackOrigin: config.baseUrl,
    };
  } catch {
    await finishEffect(env, effect.effect_id, "unknown", "network_error", null, "postiz_connect_response_unknown");
    return rejected("postiz_connect_response_unknown", 502);
  }
}

export async function approvePostizIntent(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    actorUserId: string;
    expectedVersion: number;
    idempotencyKey: string;
    fetcher?: typeof fetch;
    now?: Date;
  },
): Promise<IntentResult> {
  const config = postizConfig(env);
  if (!config) return rejected(postizEnabled(env) ? "postiz_not_configured" : "postiz_disabled", 503);
  const row = await getPostizIntent(env, input.tenantId, input.intentId);
  if (!row) return rejected("postiz_intent_not_found", 404);
  if (!config.allowedProviders.has(row.provider))
    return rejected("postiz_provider_not_allowed", 503);
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  if (row.approval_idempotency_sha256 === keyHash && row.version > input.expectedVersion)
    return { kind: "replayed", intent: row };
  if (row.state !== "pending_review") return rejected("postiz_approval_state_invalid", 409);
  if (row.version !== input.expectedVersion) return rejected("postiz_intent_version_conflict", 409);
  if (!row.integration_id) return rejected("postiz_connection_required", 409);
  if (Date.parse(row.scheduled_at) <= (input.now ?? new Date()).getTime() + 60_000)
    return rejected("postiz_schedule_expired", 409);
  const nowIso = (input.now ?? new Date()).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE postiz_intents
     SET state = 'submission_pending', approval_idempotency_sha256 = ?,
         approved_by_user_id = ?, approved_at = ?, error_code = NULL,
         version = version + 1, updated_at = ?
     WHERE tenant_id = ? AND intent_id = ? AND state = 'pending_review' AND version = ?`,
  ).bind(
    keyHash, input.actorUserId, nowIso, nowIso, input.tenantId,
    input.intentId, input.expectedVersion,
  ).run();
  if (changes(updated) !== 1) return rejected("postiz_intent_version_conflict", 409);
  await processPostizEffect(env, row.submission_effect_id, input.fetcher ?? fetch, input.now ?? new Date());
  const latest = await getPostizIntent(env, input.tenantId, input.intentId);
  return latest ? { kind: "updated", intent: latest } : rejected("postiz_intent_not_found", 404);
}

export async function rejectPostizIntent(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    actorUserId: string;
    expectedVersion: number;
    idempotencyKey: string;
    now?: Date;
  },
): Promise<IntentResult> {
  const row = await getPostizIntent(env, input.tenantId, input.intentId);
  if (!row) return rejected("postiz_intent_not_found", 404);
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  if (row.rejection_idempotency_sha256 === keyHash && row.version > input.expectedVersion)
    return { kind: "replayed", intent: row };
  if (row.state !== "pending_review") return rejected("postiz_rejection_state_invalid", 409);
  if (row.version !== input.expectedVersion) return rejected("postiz_intent_version_conflict", 409);
  const nowIso = (input.now ?? new Date()).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE postiz_intents
     SET state = 'rejected', rejection_idempotency_sha256 = ?,
         rejected_by_user_id = ?, rejected_at = ?, error_code = NULL,
         version = version + 1, updated_at = ?
     WHERE tenant_id = ? AND intent_id = ? AND state = 'pending_review' AND version = ?`,
  ).bind(
    keyHash, input.actorUserId, nowIso, nowIso, input.tenantId,
    input.intentId, input.expectedVersion,
  ).run();
  if (changes(updated) !== 1) return rejected("postiz_intent_version_conflict", 409);
  const latest = await getPostizIntent(env, input.tenantId, input.intentId);
  return latest ? { kind: "updated", intent: latest } : rejected("postiz_intent_not_found", 404);
}

export async function stopPostizIntent(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    actorUserId: string;
    expectedVersion: number;
    idempotencyKey: string;
    fetcher?: typeof fetch;
    now?: Date;
  },
): Promise<IntentResult> {
  const config = postizConfig(env);
  if (!config) return rejected(postizEnabled(env) ? "postiz_not_configured" : "postiz_disabled", 503);
  const row = await getPostizIntent(env, input.tenantId, input.intentId);
  if (!row) return rejected("postiz_intent_not_found", 404);
  if (!config.allowedProviders.has(row.provider))
    return rejected("postiz_provider_not_allowed", 503);
  if (row.state === "published" || row.published_observed_at)
    return rejected("postiz_published_retraction_manual", 409);
  const keyHash = await scopedHash(input.tenantId, input.idempotencyKey);
  if (row.stop_idempotency_sha256 === keyHash && row.version > input.expectedVersion)
    return { kind: "replayed", intent: row };
  if (row.state !== "submitted" && row.state !== "reconciliation_required")
    return rejected("postiz_stop_state_invalid", 409);
  if (row.version !== input.expectedVersion) return rejected("postiz_intent_version_conflict", 409);
  const nowIso = (input.now ?? new Date()).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE postiz_intents
     SET state = 'stop_submitted', stop_idempotency_sha256 = ?,
         stop_requested_by_user_id = ?, stop_requested_at = ?, error_code = NULL,
         version = version + 1, updated_at = ?
     WHERE tenant_id = ? AND intent_id = ?
       AND state IN ('submitted', 'reconciliation_required') AND version = ?`,
  ).bind(
    keyHash, input.actorUserId, nowIso, nowIso, input.tenantId,
    input.intentId, input.expectedVersion,
  ).run();
  if (changes(updated) !== 1) return rejected("postiz_intent_version_conflict", 409);
  await processPostizEffect(env, row.stop_effect_id, input.fetcher ?? fetch, input.now ?? new Date());
  const latest = await getPostizIntent(env, input.tenantId, input.intentId);
  return latest ? { kind: "updated", intent: latest } : rejected("postiz_intent_not_found", 404);
}

export async function reconcilePostizIntent(
  env: AppEnv,
  input: {
    tenantId: string;
    intentId: string;
    expectedVersion?: number;
    idempotencyKey?: string;
    triggerKind?: "manual" | "scheduled";
    fetcher?: typeof fetch;
    now?: Date;
  },
): Promise<IntentResult> {
  const config = postizConfig(env);
  if (!config) return rejected(postizEnabled(env) ? "postiz_not_configured" : "postiz_disabled", 503);
  let row = await getPostizIntent(env, input.tenantId, input.intentId);
  if (!row) return rejected("postiz_intent_not_found", 404);
  if (!config.allowedProviders.has(row.provider))
    return rejected("postiz_provider_not_allowed", 503);
  if (input.expectedVersion !== undefined && row.version !== input.expectedVersion)
    return rejected("postiz_intent_version_conflict", 409);
  const requestHash = input.idempotencyKey
    ? await scopedHash(input.tenantId, input.idempotencyKey)
    : null;
  if (requestHash) {
    const observed = await env.DB.prepare(
      "SELECT observation_id FROM postiz_reconciliation_observations WHERE request_idempotency_sha256 = ? LIMIT 1",
    ).bind(requestHash).first<{ observation_id: string }>();
    if (observed) return { kind: "replayed", intent: row };
  }
  if (row.state === "submission_pending") {
    await processPostizEffect(env, row.submission_effect_id, input.fetcher ?? fetch, input.now ?? new Date());
    row = (await getPostizIntent(env, input.tenantId, input.intentId)) ?? row;
  } else if (row.state === "stop_submitted") {
    await processPostizEffect(env, row.stop_effect_id, input.fetcher ?? fetch, input.now ?? new Date());
    row = (await getPostizIntent(env, input.tenantId, input.intentId)) ?? row;
  }
  const now = input.now ?? new Date();
  if (row.state === "connection_required" || row.state === "pending_review") {
    await reconcileConnection(env, config, row, requestHash, input.fetcher ?? fetch, now);
  } else {
    await reconcilePost(env, config, row, requestHash, input.triggerKind ?? "manual", input.fetcher ?? fetch, now);
  }
  const latest = await getPostizIntent(env, input.tenantId, input.intentId);
  return latest ? { kind: "updated", intent: latest } : rejected("postiz_intent_not_found", 404);
}

export async function recoverPostizControlPlane(
  env: AppEnv,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<{ effects_processed: number; intents_reconciled: number }> {
  if (!postizConfig(env)) return { effects_processed: 0, intents_reconciled: 0 };
  const effects = await env.DB.prepare(
    `SELECT effect_id FROM postiz_effect_outbox
     WHERE state = 'pending' AND operation IN ('submit', 'stop')
     ORDER BY created_at ASC LIMIT ?`,
  ).bind(RECONCILIATION_LIMIT).all<{ effect_id: string }>();
  let effectsProcessed = 0;
  for (const effect of effects.results ?? []) {
    if (await processPostizEffect(env, effect.effect_id, fetcher, now)) effectsProcessed += 1;
  }
  const cutoff = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
  const publicationCutoff = new Date(now.getTime() - PUBLICATION_READBACK_WINDOW_MS).toISOString();
  const intents = await env.DB.prepare(
    `SELECT tenant_id, intent_id FROM postiz_intents
     WHERE state IN ('submission_pending', 'submitted', 'reconciliation_required',
                     'stop_submitted', 'stop_reconciliation_required', 'published')
       AND (last_reconciled_at IS NULL OR last_reconciled_at <= ?)
       AND (
         (published_observed_at IS NOT NULL AND published_observed_at >= ?)
         OR (published_observed_at IS NULL AND scheduled_at >= ?)
       )
     ORDER BY COALESCE(last_reconciled_at, created_at) ASC LIMIT ?`,
  ).bind(cutoff, publicationCutoff, publicationCutoff, RECONCILIATION_LIMIT)
    .all<{ tenant_id: string; intent_id: string }>();
  let intentsReconciled = 0;
  for (const intent of intents.results ?? []) {
    const result = await reconcilePostizIntent(env, {
      tenantId: intent.tenant_id,
      intentId: intent.intent_id,
      triggerKind: "scheduled",
      fetcher,
      now,
    });
    if (result.kind !== "rejected") intentsReconciled += 1;
  }
  return { effects_processed: effectsProcessed, intents_reconciled: intentsReconciled };
}

async function processPostizEffect(
  env: AppEnv,
  effectId: string,
  fetcher: typeof fetch,
  now: Date,
): Promise<boolean> {
  const config = postizConfig(env);
  if (!config) return false;
  const effect = await env.DB.prepare(
    "SELECT * FROM postiz_effect_outbox WHERE effect_id = ? LIMIT 1",
  ).bind(effectId).first<PostizEffectRow>();
  if (!effect || effect.operation === "connect" || !effect.intent_id) return false;
  if (!config.allowedProviders.has(effect.provider)) return false;
  if (!await claimEffect(env, effect.effect_id, now)) return false;
  const intent = await getPostizIntent(env, effect.tenant_id, effect.intent_id);
  if (!intent) {
    await finishEffect(env, effect.effect_id, "failed", "invalid_response", null, "postiz_intent_not_found");
    return true;
  }
  if (effect.operation === "submit")
    await submitIntent(env, config, effect, intent, fetcher, now);
  else await submitStop(env, config, effect, intent, fetcher, now);
  return true;
}

async function submitIntent(
  env: AppEnv,
  config: PostizConfig,
  effect: PostizEffectRow,
  intent: PostizIntentRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  if (!intent.integration_id) {
    await finishEffect(env, effect.effect_id, "failed", "invalid_response", null, "postiz_connection_required");
    await transitionAfterEffect(env, intent, "reconciliation_required", "postiz_connection_required", now);
    return;
  }
  const body = {
    type: "schedule",
    date: intent.scheduled_at,
    shortLink: false,
    tags: [],
    posts: [{
      integration: { id: intent.integration_id },
      value: [{ id: intent.remote_post_id, content: intent.content, image: [] }],
      settings: providerSettings(intent.provider),
    }],
  };
  try {
    assertEffectLedgerReady(env);
    const result = await postizSubmitThroughRuntime(env, config, effect, intent, body, fetcher, now);
    if (result.state === "failed") {
      await finishEffect(env, effect.effect_id, "failed", "http_error", result.responseStatus, result.code ?? "postiz_submission_rejected");
      await transitionAfterEffect(env, intent, "reconciliation_required", "postiz_submission_rejected", now);
      return;
    }
    if (result.state === "unknown") {
      await finishEffect(env, effect.effect_id, "unknown", result.responseClass, result.responseStatus, result.code);
      await transitionAfterEffect(env, intent, "reconciliation_required", result.code, now);
      return;
    }
    await finishEffect(env, effect.effect_id, "submitted", "accepted", result.responseStatus, null);
    await transitionAfterEffect(env, intent, "submitted", null, now);
  } catch (error) {
    const unknown = error instanceof EffectRuntimeError && error.code === "effect_unknown_requires_reconciliation";
    const code = unknown ? "postiz_submission_response_unknown" : "postiz_submission_response_unknown";
    await finishEffect(env, effect.effect_id, "unknown", "network_error", null, code);
    await transitionAfterEffect(env, intent, "reconciliation_required", code, now);
  }
}

async function submitStop(
  env: AppEnv,
  config: PostizConfig,
  effect: PostizEffectRow,
  intent: PostizIntentRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  let effectState: PostizEffectRow["state"] = "unknown";
  let responseClass: "accepted" | "http_error" | "network_error" | "invalid_response" = "network_error";
  let responseStatus: number | null = null;
  let code = "postiz_stop_response_unknown";
  try {
    assertEffectLedgerReady(env);
    const result = await postizStopThroughRuntime(env, config, effect, intent, fetcher, now);
    responseStatus = result.responseStatus;
    if (result.state === "failed") {
      effectState = "failed";
      responseClass = "http_error";
      code = "postiz_stop_rejected";
    } else if (result.state === "succeeded") {
      effectState = "submitted";
      responseClass = "accepted";
      // v2.23.0 swallows Temporal termination errors. DRAFT is a DB projection,
      // never proof that a sleeping publish workflow has terminated.
      code = "postiz_stop_workflow_unverified";
    } else {
      responseClass = result.responseClass;
      code = result.code ?? "postiz_stop_response_unknown";
    }
  } catch {
    // The request may have reached Postiz. Never retry an attempted stop automatically.
  }
  await finishEffect(env, effect.effect_id, effectState, responseClass, responseStatus, code);
  await transitionAfterEffect(env, intent, "stop_reconciliation_required", code, now);
}

type PostizMutationResult = {
  state: "succeeded" | "failed" | "unknown";
  responseStatus: number | null;
  responseClass: "accepted" | "http_error" | "network_error" | "invalid_response";
  code: string | null;
  payload?: unknown;
};

async function postizSubmitThroughRuntime(
  env: AppEnv,
  config: PostizConfig,
  effect: PostizEffectRow,
  intent: PostizIntentRow,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
  now: Date,
): Promise<PostizMutationResult> {
  const tenantId = intent.tenant_id;
  const requestHash = await sha256Hex(canonicalJson(body));
  const idempotencyKey = `postiz:submit:${effect.idempotency_key_sha256}`;
  const deadlineAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const actorId = intent.approved_by_user_id ?? "postiz-adapter";
  const actorType = intent.approved_by_user_id ? "owner" as const : "agent" as const;
  const approvalRef = intent.approval_idempotency_sha256 ?? effect.idempotency_key_sha256;
  try {
    const result = await runExternalEffect(env, {
      tenantId,
      actor: { type: actorType, id: actorId },
      taskId: `postiz:${intent.intent_id}:submit`,
      authority: {
        permitRef: `postiz:approval:${approvalRef}`,
        policyRef: "postiz.intent.submit",
        policyVersion: "v1",
        tenantId,
        actorType,
        actorId,
        expiresAt: deadlineAt,
        allowedActions: ["postiz.intent.submit"],
        maxAttempts: 1,
      },
      aggregate: { type: "postiz_intent", id: intent.intent_id, version: intent.version },
      intentId: intent.intent_id,
      action: "postiz.intent.submit",
      request: body,
      requestHash,
      provider: "postiz",
      idempotencyKey,
      deadlineAt,
      expectedReadback: { postId: intent.remote_post_id },
      retryLimit: 0,
      compensationPlan: {},
      correlationId: effect.effect_id,
    }, {
      async dispatch() {
        const response = await timedFetch(
          fetcher,
          `${config.baseUrl}/public/v1/posts`,
          { method: "POST", headers: providerHeaders(config.apiKey, true), body: JSON.stringify(body) },
          config.timeoutMs,
        );
        if (!response.ok) return { outcome: "rejected" as const, detailCode: "postiz_submission_rejected" };
        const payload = await boundedJson(response);
        if (!validCreateResponse(payload, intent.remote_post_id, intent.integration_id ?? "")) {
          return { outcome: "unknown" as const, detailCode: "postiz_submission_response_unverified", providerResponse: payload };
        }
        return { outcome: "accepted" as const, value: payload, providerExternalId: intent.remote_post_id, providerResponse: payload };
      },
      async readback() {
        return await postizPostReadback(config, intent, fetcher);
      },
      async replay() {
        const readback = await postizPostReadback(config, intent, fetcher);
        if (readback.status !== "match" || readback.observed === undefined) {
          throw new Error(readback.detailCode ?? "postiz_replay_readback_failed");
        }
        return readback.observed;
      },
    }, now);
    if (result.effect.state === "succeeded") {
      return { state: "succeeded", responseStatus: 200, responseClass: "accepted", code: null, payload: result.value };
    }
    if (result.effect.state === "failed") {
      return { state: "failed", responseStatus: null, responseClass: "http_error", code: result.effect.result_code };
    }
    return { state: "unknown", responseStatus: null, responseClass: "network_error", code: result.effect.result_code ?? "postiz_submission_response_unknown" };
  } catch (error) {
    if (error instanceof EffectRuntimeError && error.code === "effect_unknown_requires_reconciliation") {
      return { state: "unknown", responseStatus: null, responseClass: "network_error", code: "postiz_submission_response_unknown" };
    }
    throw error;
  }
}

async function postizStopThroughRuntime(
  env: AppEnv,
  config: PostizConfig,
  effect: PostizEffectRow,
  intent: PostizIntentRow,
  fetcher: typeof fetch,
  now: Date,
): Promise<PostizMutationResult> {
  const tenantId = intent.tenant_id;
  const request = { postId: intent.remote_post_id, status: "draft" };
  const requestHash = await sha256Hex(canonicalJson(request));
  const idempotencyKey = `postiz:stop:${effect.idempotency_key_sha256}`;
  const deadlineAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const actorId = intent.stop_requested_by_user_id ?? "postiz-adapter";
  const actorType = intent.stop_requested_by_user_id ? "owner" as const : "agent" as const;
  const approvalRef = intent.stop_idempotency_sha256 ?? effect.idempotency_key_sha256;
  const result = await runExternalEffect(env, {
    tenantId,
    actor: { type: actorType, id: actorId },
    taskId: `postiz:${intent.intent_id}:stop`,
    authority: {
      permitRef: `postiz:approval:${approvalRef}`,
      policyRef: "postiz.intent.stop",
      policyVersion: "v1",
      tenantId,
      actorType,
      actorId,
      expiresAt: deadlineAt,
      allowedActions: ["postiz.intent.stop"],
      maxAttempts: 1,
    },
    aggregate: { type: "postiz_intent", id: intent.intent_id, version: intent.version },
    intentId: intent.intent_id,
    action: "postiz.intent.stop",
    request,
    requestHash,
    provider: "postiz",
    idempotencyKey,
    deadlineAt,
    expectedReadback: { postId: intent.remote_post_id, state: "DRAFT" },
    retryLimit: 0,
    compensationPlan: {},
    correlationId: effect.effect_id,
  }, {
    async dispatch() {
      const response = await timedFetch(
        fetcher,
        `${config.baseUrl}/public/v1/posts/${encodeURIComponent(intent.remote_post_id)}/status`,
        { method: "PUT", headers: providerHeaders(config.apiKey, true), body: JSON.stringify(request) },
        config.timeoutMs,
      );
      if (!response.ok) return { outcome: "rejected" as const, detailCode: "postiz_stop_rejected" };
      const payload = await boundedJson(response);
      if (!isRecord(payload) || payload.id !== intent.remote_post_id || payload.state !== "DRAFT") {
        return { outcome: "unknown" as const, detailCode: "postiz_stop_response_unverified", providerResponse: payload };
      }
      return { outcome: "accepted" as const, value: payload, providerExternalId: intent.remote_post_id, providerResponse: payload };
    },
    async readback() {
      return await postizPostReadback(config, intent, fetcher, "DRAFT");
    },
    async replay() {
      const readback = await postizPostReadback(config, intent, fetcher, "DRAFT");
      if (readback.status !== "match" || readback.observed === undefined) {
        throw new Error(readback.detailCode ?? "postiz_stop_replay_readback_failed");
      }
      return readback.observed as Record<string, unknown>;
    },
  }, now);
  if (result.effect.state === "succeeded") return { state: "succeeded", responseStatus: 200, responseClass: "accepted", code: null, payload: result.value };
  if (result.effect.state === "failed") return { state: "failed", responseStatus: null, responseClass: "http_error", code: result.effect.result_code };
  return { state: "unknown", responseStatus: null, responseClass: "network_error", code: result.effect.result_code ?? "postiz_stop_response_unknown" };
}

async function postizPostReadback(
  config: PostizConfig,
  intent: PostizIntentRow,
  fetcher: typeof fetch,
  expectedState?: "DRAFT",
): Promise<{ status: "match" | "conflict" | "unavailable" | "not_found"; observed?: unknown; detailCode?: string }> {
  const window = reconciliationWindow(intent.scheduled_at);
  if (!window) return { status: "unavailable", detailCode: "postiz_readback_window_invalid" };
  try {
    const query = new URLSearchParams({ startDate: window.start, endDate: window.end });
    const response = await timedFetch(
      fetcher,
      `${config.baseUrl}/public/v1/posts?${query.toString()}`,
      { headers: providerHeaders(config.apiKey) },
      config.timeoutMs,
    );
    if (!response.ok) return { status: "unavailable", detailCode: `postiz_readback_${response.status}` };
    const body = await boundedJson(response);
    const posts = isRecord(body) && Array.isArray(body.posts) ? body.posts : null;
    if (!posts) return { status: "unavailable", detailCode: "postiz_readback_response_unverified" };
    const matches = posts.filter((value) => isRecord(value) && value.id === intent.remote_post_id);
    if (matches.length === 0) return { status: "not_found", detailCode: "postiz_readback_not_found" };
    if (matches.length !== 1) return { status: "conflict", observed: matches, detailCode: "postiz_readback_ambiguous" };
    const observed = { postId: intent.remote_post_id, state: isRecord(matches[0]) ? matches[0].state : null };
    if (expectedState && observed.state !== expectedState) return { status: "conflict", observed, detailCode: "postiz_stop_readback_conflict" };
    return { status: "match", observed };
  } catch {
    return { status: "unavailable", detailCode: "postiz_readback_unavailable" };
  }
}

async function reconcileConnection(
  env: AppEnv,
  config: PostizConfig,
  row: PostizIntentRow,
  requestHash: string | null,
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  const result = await resolveIntegration(config, row.provider, fetcher);
  const connected = result.kind === "connected";
  const state: PostizIntentState = connected ? "pending_review" : "connection_required";
  const code = connected ? "postiz_connection_confirmed" : result.code;
  await recordObservation(env, {
    row,
    triggerKind: "connection_poll",
    requestHash,
    providerFound: connected,
    remoteState: null,
    releaseUrl: null,
    outcomeCode: code,
    now,
  });
  await env.DB.prepare(
    `UPDATE postiz_intents
     SET state = ?, integration_id = ?, last_reconciled_at = ?, error_code = ?,
         version = version + 1, updated_at = ?
     WHERE intent_id = ? AND version = ?`,
  ).bind(
    state, connected ? result.id : null, now.toISOString(),
    connected ? null : code, now.toISOString(), row.intent_id, row.version,
  ).run();
}

async function reconcilePost(
  env: AppEnv,
  config: PostizConfig,
  row: PostizIntentRow,
  requestHash: string | null,
  triggerKind: "manual" | "scheduled",
  fetcher: typeof fetch,
  now: Date,
): Promise<void> {
  const window = reconciliationWindow(row.scheduled_at);
  if (!window) {
    await applyPostObservation(env, row, requestHash, triggerKind, null, "postiz_reconciliation_window_expired", now);
    return;
  }
  try {
    const query = new URLSearchParams({ startDate: window.start, endDate: window.end });
    const response = await timedFetch(
      fetcher,
      `${config.baseUrl}/public/v1/posts?${query.toString()}`,
      { headers: providerHeaders(config.apiKey) },
      config.timeoutMs,
    );
    if (!response.ok) {
      await applyPostObservation(env, row, requestHash, triggerKind, null, "postiz_reconciliation_read_failed", now);
      return;
    }
    const body = await boundedJson(response);
    const posts = isRecord(body) && Array.isArray(body.posts) ? body.posts : null;
    if (!posts) {
      await applyPostObservation(env, row, requestHash, triggerKind, null, "postiz_reconciliation_response_unverified", now);
      return;
    }
    const matches = posts.filter((post) => isRecord(post) && post.id === row.remote_post_id);
    const remote = matches.length === 1 ? remotePost(matches[0]) : null;
    const code = matches.length > 1
      ? "postiz_remote_post_ambiguous"
      : matches.length === 0
        ? "postiz_remote_post_absent"
        : remote
        ? remote.state === "PUBLISHED"
          ? "postiz_publication_confirmed"
          : remote.state === "ERROR"
            ? "postiz_publication_failed"
            : remote.state === "DRAFT"
              ? "postiz_remote_draft_observed"
              : "postiz_submission_confirmed"
        : "postiz_reconciliation_response_unverified";
    await applyPostObservation(env, row, requestHash, triggerKind, remote, code, now);
  } catch {
    await applyPostObservation(env, row, requestHash, triggerKind, null, "postiz_reconciliation_read_failed", now);
  }
}

async function applyPostObservation(
  env: AppEnv,
  row: PostizIntentRow,
  requestHash: string | null,
  triggerKind: "manual" | "scheduled",
  remote: { state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT"; releaseUrl: null } | null,
  code: string,
  now: Date,
): Promise<void> {
  const stop = row.state === "stop_submitted" || row.state === "stop_reconciliation_required";
  const publicationWasObserved = row.published_observed_at !== null || row.state === "published";
  const driftCode = publicationWasObserved
    ? publicationDriftCode(remote, code)
    : null;
  const priorDriftCode = row.error_code?.startsWith("postiz_publication_drift_")
    ? row.error_code
    : null;
  const nextState: PostizIntentState = stop
    ? "stop_reconciliation_required"
    : remote?.state === "PUBLISHED"
      ? "published"
      : driftCode
        ? "reconciliation_required"
      : row.state === "published"
        ? "published"
      : remote?.state === "QUEUE"
        ? "submitted"
        : "reconciliation_required";
  const detailCode = stop
    ? remote?.state === "PUBLISHED"
      ? "postiz_stop_failed_published"
      : "postiz_stop_workflow_unverified"
    : driftCode ?? priorDriftCode ?? code;
  await recordObservation(env, {
    row,
    triggerKind,
    requestHash,
    providerFound: null,
    remoteState: remote?.state ?? null,
    releaseUrl: null,
    outcomeCode: detailCode,
    now,
  });
  await env.DB.prepare(
    `UPDATE postiz_intents
     SET state = ?, remote_state = ?, release_url = NULL, last_reconciled_at = ?,
         published_observed_at = ?, error_code = ?, version = version + 1, updated_at = ?
     WHERE intent_id = ? AND version = ?`,
  ).bind(
    nextState, remote?.state ?? null, now.toISOString(),
    remote?.state === "PUBLISHED" ? row.published_observed_at ?? now.toISOString() : row.published_observed_at,
    nextState === "published" ? null : detailCode,
    now.toISOString(), row.intent_id, row.version,
  ).run();
}

function publicationDriftCode(
  remote: { state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT"; releaseUrl: null } | null,
  code: string,
): string | null {
  if (remote?.state === "PUBLISHED") return null;
  if (remote?.state === "ERROR") return "postiz_publication_drift_error";
  if (remote?.state === "QUEUE" || remote?.state === "DRAFT")
    return "postiz_publication_drift_remote_state";
  if (code === "postiz_remote_post_absent") return "postiz_publication_drift_absent";
  if (code === "postiz_remote_post_ambiguous") return "postiz_publication_drift_ambiguous";
  return null;
}

async function recordObservation(
  env: AppEnv,
  input: {
    row: PostizIntentRow;
    triggerKind: "manual" | "scheduled" | "connection_poll";
    requestHash: string | null;
    providerFound: boolean | null;
    remoteState: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT" | null;
    releaseUrl: string | null;
    outcomeCode: string;
    now: Date;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO postiz_reconciliation_observations (
       observation_id, tenant_id, intent_id, trigger_kind,
       request_idempotency_sha256, provider_found, remote_state, release_url,
       outcome_code, checked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), input.row.tenant_id, input.row.intent_id,
    input.triggerKind, input.requestHash,
    input.providerFound === null ? null : input.providerFound ? 1 : 0,
    input.remoteState, input.releaseUrl, input.outcomeCode,
    input.now.toISOString(),
  ).run();
}

async function resolveIntegration(
  config: PostizConfig,
  provider: PostizProvider,
  fetcher: typeof fetch,
): Promise<{ kind: "connected"; id: string } | { kind: "missing"; code: string }> {
  try {
    const response = await timedFetch(
      fetcher,
      `${config.baseUrl}/public/v1/integrations`,
      { headers: providerHeaders(config.apiKey) },
      config.timeoutMs,
    );
    if (!response.ok) return { kind: "missing", code: "postiz_connection_read_failed" };
    const body = await boundedJson(response);
    if (!Array.isArray(body)) return { kind: "missing", code: "postiz_connection_response_unverified" };
    const matches = body.filter((value) =>
      isRecord(value) && value.identifier === provider && value.disabled === false &&
      typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 200
    ) as Array<{ id: string }>;
    if (matches.length === 1) return { kind: "connected", id: matches[0]!.id };
    return {
      kind: "missing",
      code: matches.length > 1 ? "postiz_integration_ambiguous" : "postiz_connection_required",
    };
  } catch {
    return { kind: "missing", code: "postiz_connection_read_failed" };
  }
}

function postizConfig(env: AppEnv): PostizConfig | null {
  if (!postizEnabled(env)) return null;
  if (String(env.POSTIZ_EXPECTED_VERSION ?? "") !== POSTIZ_EXPECTED_VERSION) return null;
  const apiKey = String(env.POSTIZ_API_KEY ?? "").trim();
  if (!apiKey || apiKey.length > 512) return null;
  const allowedProviders = new Set<PostizProvider>();
  for (const value of String(env.POSTIZ_ALLOWED_PROVIDERS ?? "").split(",")) {
    const provider = value.trim();
    if ((POSTIZ_PROVIDERS as readonly string[]).includes(provider))
      allowedProviders.add(provider as PostizProvider);
    else if (provider) return null;
  }
  if (allowedProviders.size === 0) return null;
  try {
    const url = new URL(String(env.POSTIZ_API_BASE_URL ?? ""));
    if (
      url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash || url.pathname !== "/" || unsafeProviderHost(url.hostname)
    ) return null;
    const timeout = Number(env.POSTIZ_API_TIMEOUT_MS ?? "10000");
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 30_000) return null;
    return { baseUrl: url.origin, apiKey, allowedProviders, timeoutMs: timeout };
  } catch {
    return null;
  }
}

function facetDraftConfig(
  env: AppEnv,
  event: FacetApprovalEventRow,
  now: Date,
): { provider: PostizProvider; brandName: string; scheduledAt: string } | null {
  const provider = String(env.POSTIZ_FACET_DRAFT_PROVIDER ?? "").trim();
  if (!(POSTIZ_PROVIDERS as readonly string[]).includes(provider)) return null;
  const offsetHours = Number(env.POSTIZ_FACET_DRAFT_OFFSET_HOURS ?? "168");
  const occurredAt = Date.parse(event.occurred_at);
  const receivedAt = Date.parse(event.received_at);
  if (!Number.isFinite(occurredAt) || !Number.isFinite(receivedAt) ||
      !Number.isInteger(offsetHours) || offsetHours < 1 || offsetHours > 720 ||
      !Number.isFinite(now.getTime()))
    return null;
  const brandName = String(env.APP_TENANT_BRAND ?? "").trim();
  if (!boundedPlainText(brandName, 2, 80) || containsLikelyPii(brandName)) return null;
  const scheduledAt = Math.max(
    occurredAt + offsetHours * 60 * 60 * 1000,
    now.getTime() + FACET_DRAFT_SAFE_LEAD_MS,
  );
  return {
    provider: provider as PostizProvider,
    brandName,
    scheduledAt: new Date(scheduledAt).toISOString(),
  };
}

function facetDraftWatermark(env: AppEnv): { iso: string; time: number } | null {
  const iso = String(env.POSTIZ_FACET_DRAFT_NOT_BEFORE ?? "").trim();
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? { iso, time } : null;
}

function facetEventAtOrAfterWatermark(
  event: Pick<FacetApprovalEventRow, "occurred_at" | "received_at">,
  watermark: { time: number },
): boolean {
  const occurredAt = Date.parse(event.occurred_at);
  const receivedAt = Date.parse(event.received_at);
  return Number.isFinite(occurredAt) && Number.isFinite(receivedAt) &&
    occurredAt >= watermark.time && receivedAt >= watermark.time;
}

function validateDraft(input: {
  tenantId: string;
  agentRole: string;
  triggerRef: string;
  title: string;
  content: string;
  provider: string;
  scheduledAt: string;
  evidenceRefs: string[];
  citations: PostizCitation[];
  permissionScope: string;
  idempotencyKey: string;
}):
  | { ok: true; triggerRef: string; title: string; content: string; provider: PostizProvider; scheduledAt: string; evidenceRefs: string[]; citations: PostizCitation[]; permissionScope: string }
  | { ok: false; code: string } {
  const triggerRef = input.triggerRef.trim();
  const title = input.title.trim();
  const content = input.content.trim();
  const permissionScope = input.permissionScope.trim();
  const scheduled = new Date(input.scheduledAt);
  if (input.agentRole !== "specialized_marketing_agent") return { ok: false, code: "postiz_agent_role_invalid" };
  if (!validTenant(input.tenantId) || !validIdempotency(input.idempotencyKey))
    return { ok: false, code: "postiz_draft_invalid" };
  if (!(POSTIZ_PROVIDERS as readonly string[]).includes(input.provider))
    return { ok: false, code: "postiz_provider_not_allowed" };
  if (!validOpaqueRef(triggerRef) || !boundedPlainText(title, 1, 160) ||
      !boundedPlainText(content, 1, 5000) || !boundedPlainText(permissionScope, 1, 100) ||
      Number.isNaN(scheduled.getTime()) || scheduled.toISOString() !== input.scheduledAt)
    return { ok: false, code: "postiz_draft_invalid" };
  if (containsLikelyPii(title) || containsLikelyPii(content))
    return { ok: false, code: "postiz_customer_pii_forbidden" };
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length < 1 || input.evidenceRefs.length > 20 ||
      input.evidenceRefs.some((ref) => !validOpaqueRef(ref)))
    return { ok: false, code: "postiz_evidence_refs_invalid" };
  if (!Array.isArray(input.citations) || input.citations.length < 1 || input.citations.length > 20 ||
      input.citations.some((citation) => !validCitation(citation)))
    return { ok: false, code: "postiz_citations_invalid" };
  return {
    ok: true,
    triggerRef,
    title,
    content,
    provider: input.provider as PostizProvider,
    scheduledAt: input.scheduledAt,
    evidenceRefs: [...input.evidenceRefs],
    citations: input.citations.map((citation) => ({ ...citation })),
    permissionScope,
  };
}

function projectIntent(row: PostizIntentRow): PostizIntentProjection {
  return {
    id: row.intent_id,
    title: row.title,
    content: row.content,
    provider: row.provider,
    integration_id: row.integration_id,
    scheduled_at: row.scheduled_at,
    evidence_refs: parseStringArray(row.evidence_refs_json),
    citations: parseCitations(row.citations_json),
    permission_scope: row.permission_scope,
    state: row.state,
    version: Number(row.version),
    error_code: row.error_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function allowedActions(enabled: boolean, row: PostizIntentRow): PostizIntentEnvelope["allowed_actions"] {
  const actions: PostizIntentEnvelope["allowed_actions"] = ["postiz.intent.review"];
  if (!enabled) return actions;
  if (row.state === "connection_required") actions.push("postiz.connect", "postiz.intent.reconcile");
  if (row.state === "pending_review")
    actions.push("postiz.intent.approve", "postiz.intent.reject", "postiz.intent.reconcile");
  if (row.state === "submitted" || row.state === "reconciliation_required") {
    if (!row.published_observed_at) actions.push("postiz.intent.stop");
    actions.push("postiz.intent.reconcile");
  }
  if (row.state === "published" || row.state === "stop_reconciliation_required")
    actions.push("postiz.intent.reconcile");
  return actions;
}

function providerSettings(provider: PostizProvider): Record<string, unknown> {
  if (provider === "linkedin-page") return { __type: provider, post_as_images_carousel: false };
  if (provider === "gmb") return { __type: provider, topicType: "STANDARD" };
  return { __type: provider };
}

function connectUrlForProvider(
  provider: PostizProvider,
  body: unknown,
  callbackOrigin: string,
): string | null {
  if (!isRecord(body) || typeof body.url !== "string") return null;
  return validPostizOAuthUrl(provider, body.url, callbackOrigin) ? body.url : null;
}

function validPostizOAuthUrl(
  provider: PostizProvider,
  value: string,
  callbackOrigin: string,
): boolean {
  const contract: {
    host: string;
    path: string;
    callbackPath: string;
    stateLength: number;
    scope: string;
    keys: readonly string[];
    fixed: Readonly<Record<string, string>>;
  } = provider === "facebook"
    ? {
        host: "www.facebook.com",
        path: "/v20.0/dialog/oauth",
        callbackPath: "/integrations/social/facebook",
        stateLength: 6,
        scope: "pages_show_list,business_management,pages_manage_posts,pages_manage_engagement,pages_read_engagement,read_insights",
        keys: ["client_id", "redirect_uri", "state", "scope"],
        fixed: {},
      }
    : provider === "linkedin-page"
      ? {
          host: "www.linkedin.com",
          path: "/oauth/v2/authorization",
          callbackPath: "/integrations/social/linkedin-page",
          stateLength: 6,
          scope: "openid profile w_member_social r_basicprofile rw_organization_admin w_organization_social r_organization_social",
          keys: ["response_type", "prompt", "client_id", "redirect_uri", "state", "scope"],
          fixed: { response_type: "code", prompt: "none" },
        }
      : {
          host: "accounts.google.com",
          path: "/o/oauth2/v2/auth",
          callbackPath: "/integrations/social/gmb",
          stateLength: 7,
          scope: "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/business.manage",
          keys: ["access_type", "prompt", "state", "redirect_uri", "scope", "response_type", "client_id"],
          fixed: { access_type: "offline", prompt: "consent", response_type: "code" },
        };
  if (!value.startsWith(`https://${contract.host}${contract.path}?`)) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.hostname !== contract.host || url.port ||
      url.pathname !== contract.path || url.username || url.password || url.hash
    ) return false;
    const keys = [...url.searchParams.keys()];
    if (
      keys.length !== contract.keys.length ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !contract.keys.includes(key))
    ) return false;
    for (const [key, expected] of Object.entries(contract.fixed)) {
      if (url.searchParams.get(key) !== expected) return false;
    }
    const clientId = url.searchParams.get("client_id") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (
      !/^[A-Za-z0-9._-]{1,256}$/.test(clientId) ||
      clientId === "undefined" || clientId === "null" ||
      !new RegExp(`^[A-Za-z0-9]{${contract.stateLength}}$`).test(state) ||
      url.searchParams.get("scope") !== contract.scope
    ) return false;
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    return callback.protocol === "https:" && !callback.username && !callback.password &&
      !callback.search && !callback.hash &&
      callback.origin === callbackOrigin && callback.pathname === contract.callbackPath;
  } catch {
    return false;
  }
}

function remotePost(value: unknown): { state: "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT"; releaseUrl: null } | null {
  if (!isRecord(value) || !["QUEUE", "PUBLISHED", "ERROR", "DRAFT"].includes(String(value.state)))
    return null;
  return {
    state: value.state as "QUEUE" | "PUBLISHED" | "ERROR" | "DRAFT",
    // releaseURL is provider-controlled and v2.23.0 has no uniform safe shape.
    releaseUrl: null,
  };
}

function validCreateResponse(body: unknown, postId: string, integrationId: string): boolean {
  return Array.isArray(body) && body.length === 1 && isRecord(body[0]) &&
    body[0].postId === postId && body[0].integration === integrationId;
}

async function claimEffect(env: AppEnv, effectId: string, now: Date): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE postiz_effect_outbox
     SET state = 'attempting', attempt_count = 1, attempted_at = ?, updated_at = ?
     WHERE effect_id = ? AND state = 'pending' AND attempt_count = 0`,
  ).bind(now.toISOString(), now.toISOString(), effectId).run();
  return changes(result) === 1;
}

async function finishEffect(
  env: AppEnv,
  effectId: string,
  state: "submitted" | "failed" | "unknown",
  responseClass: "accepted" | "http_error" | "network_error" | "invalid_response",
  responseStatus: number | null,
  detailCode: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE postiz_effect_outbox
     SET state = ?, response_class = ?, response_status = ?, detail_code = ?, updated_at = ?
     WHERE effect_id = ? AND state = 'attempting' AND attempt_count = 1`,
  ).bind(state, responseClass, responseStatus, detailCode, new Date().toISOString(), effectId).run();
}

async function transitionAfterEffect(
  env: AppEnv,
  row: PostizIntentRow,
  state: "submitted" | "reconciliation_required" | "stop_reconciliation_required",
  errorCode: string | null,
  now: Date,
): Promise<void> {
  const currentState = state === "stop_reconciliation_required"
    ? "stop_submitted"
    : "submission_pending";
  await env.DB.prepare(
    `UPDATE postiz_intents
     SET state = ?, error_code = ?, version = version + 1, updated_at = ?
     WHERE intent_id = ? AND state = ? AND version = ?`,
  ).bind(state, errorCode, now.toISOString(), row.intent_id, currentState, row.version).run();
}

async function effectByIdempotency(env: AppEnv, hash: string): Promise<PostizEffectRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM postiz_effect_outbox WHERE idempotency_key_sha256 = ? LIMIT 1",
  ).bind(hash).first<PostizEffectRow>();
}

async function intentByDraftIdempotency(
  env: AppEnv,
  tenantId: string,
  hash: string,
): Promise<PostizIntentRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM postiz_intents WHERE tenant_id = ? AND draft_idempotency_sha256 = ? LIMIT 1",
  ).bind(tenantId, hash).first<PostizIntentRow>();
}

async function scopedHash(tenantId: string, value: string): Promise<string> {
  return await sha256Hex(`${tenantId}\n${value}`);
}

async function timedFetch(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("postiz_response_too_large");
  const text = await response.text();
  if (text.length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("postiz_response_too_large");
  return JSON.parse(text) as unknown;
}

function providerHeaders(apiKey: string, json = false): Headers {
  const headers = new Headers({ Accept: "application/json", Authorization: apiKey });
  if (json) headers.set("Content-Type", "application/json");
  return headers;
}

function reconciliationWindow(scheduledAt: string): { start: string; end: string } | null {
  const scheduled = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduled)) return null;
  return {
    start: new Date(scheduled - 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(scheduled + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed.slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function parseCitations(value: string): PostizCitation[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validCitation).slice(0, 20) : [];
  } catch {
    return [];
  }
}

function validCitation(value: unknown): value is PostizCitation {
  return isRecord(value) && Object.keys(value).length === 3 &&
    boundedPlainText(value.id, 1, 100) && boundedPlainText(value.label, 1, 160) &&
    validOpaqueRef(value.source_ref);
}

function validOpaqueRef(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 300 &&
    /^[A-Za-z0-9][A-Za-z0-9:_./-]*$/.test(value) && !value.includes("..") &&
    !containsLikelyPii(value);
}

function boundedPlainText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    !value.includes("<") && !value.includes(">");
}

function containsLikelyPii(value: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value) ||
    /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/.test(value);
}

function validTenant(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && /^[a-z0-9-]+$/.test(value);
}

function validIdempotency(value: string): boolean {
  return value.length >= 16 && value.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function unsafeProviderHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") || normalized === "0.0.0.0" || normalized === "::1"
  ) return true;
  if (normalized.includes(":")) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
    return !normalized.includes(".");
  const [a, b] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19));
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(25, Math.trunc(value) || 1));
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

function rejected(code: string, status: Rejected["status"]): Rejected {
  return { kind: "rejected", code, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
