import { sha256Hex } from "./app-auth.ts";
import type { AppEnv } from "./app-types.ts";
import { canonicalHermesJson } from "./hermes-draft.ts";

export type HermesResultOutcome = "accepted" | "rejected" | "uncertain";
export type HermesResultSource = "desktop" | "hosted_reference";

export interface HermesResultBinding {
  tenant_id: string;
  user_id: string;
  role: "owner" | "ops";
  device_id: string;
  pairing_id: string;
}

export interface HermesStoredResult {
  result_id: string;
  envelope_id: string;
  device_id: string;
  pairing_id: string;
  context_sha256: string;
  provider_request_sha256: string;
  source_channel: HermesResultSource;
  input_sha256: string;
  outcome: HermesResultOutcome;
  result_sha256: string;
  result_json: string;
  recorded_at: string;
}

export interface HermesResultPayload {
  version: "hermes_draft_result_v1";
  envelope_id: string;
  context_sha256: string;
  provider_request_sha256: string;
  outcome: HermesResultOutcome;
  validation: unknown;
  governed_handoff: unknown | null;
}

export type AppendHermesResultResponse =
  | {
      ok: true;
      replayed: boolean;
      resultId: string;
      sourceChannel: HermesResultSource;
      outcome: HermesResultOutcome;
      resultSha256: string;
      result: HermesResultPayload;
      recordedAt: string;
    }
  | {
      ok: false;
      error: "idempotency_conflict" | "terminal_conflict" | "binding_revoked_or_expired" |
        "result_store_unavailable";
    };

export async function appendHermesResultAtomic(input: {
  env: Pick<AppEnv, "DB">;
  binding: HermesResultBinding;
  envelopeId: string;
  contextId: string | null;
  contextSha256: string;
  providerRequestSha256: string;
  sourceChannel: HermesResultSource;
  idempotencyKey: string;
  submission: unknown;
  outcome: HermesResultOutcome;
  validation: unknown;
  governedHandoff: unknown | null;
  resultId: string;
  eventId: string;
  recordedAt: string;
}): Promise<AppendHermesResultResponse> {
  const inputJson = canonicalHermesJson(input.submission);
  const inputSha256 = await sha256Hex(inputJson);
  const idempotencyKeySha256 = await sha256Hex(input.idempotencyKey);
  const existing = await findStoredResult(
    input.env,
    input.binding.tenant_id,
    input.binding.user_id,
    idempotencyKeySha256,
  );
  if (existing) return replayOrConflict(existing, inputSha256, input);

  const result: HermesResultPayload = {
    version: "hermes_draft_result_v1",
    envelope_id: input.envelopeId,
    context_sha256: input.contextSha256,
    provider_request_sha256: input.providerRequestSha256,
    outcome: input.outcome,
    validation: input.validation,
    governed_handoff: input.governedHandoff,
  };
  const validationSha256 = await sha256Hex(canonicalHermesJson(input.validation));
  const handoffSha256 = await sha256Hex(canonicalHermesJson(input.governedHandoff));
  const resultJson = canonicalHermesJson(result);
  const resultSha256 = await sha256Hex(resultJson);
  const eventDetailSha256 = await sha256Hex(canonicalHermesJson({
    envelope_id: input.envelopeId,
    context_sha256: input.contextSha256,
    provider_request_sha256: input.providerRequestSha256,
    outcome: input.outcome,
    result_sha256: resultSha256,
  }));

  try {
    const statements = [
      input.env.DB.prepare(
        `INSERT INTO hermes_desktop_results
         (result_id, envelope_id, context_id, tenant_id, user_id, role, device_id,
          pairing_id, context_sha256, provider_request_sha256, source_channel,
          idempotency_key_sha256, input_sha256, outcome, validation_sha256,
          handoff_sha256, result_sha256, result_json, recorded_at)
         SELECT ?, e.envelope_id, ?, e.tenant_id, e.user_id, e.role, e.device_id,
                e.pairing_id, e.context_sha256, e.provider_request_sha256, ?, ?, ?,
                ?, ?, ?, ?, ?, ?
           FROM hermes_desktop_envelopes e
           JOIN hermes_desktop_devices d
             ON d.device_id = e.device_id AND d.pairing_id = e.pairing_id
            AND d.tenant_id = e.tenant_id AND d.user_id = e.user_id AND d.role = e.role
          WHERE e.envelope_id = ? AND e.tenant_id = ? AND e.user_id = ?
            AND e.role = ? AND e.device_id = ? AND e.pairing_id = ?
            AND e.context_sha256 = ? AND e.provider_request_sha256 = ?
            AND e.state IN ('issued', 'staged') AND e.expires_at > ?
            AND d.revoked_at IS NULL AND d.access_expires_at > ?
            AND (
              (? IS NULL AND e.state = 'issued') OR
              EXISTS (
                SELECT 1 FROM hermes_desktop_contexts c
                 WHERE c.context_id = ? AND c.envelope_id = e.envelope_id
                   AND c.device_id = e.device_id AND c.pairing_id = e.pairing_id
                   AND c.tenant_id = e.tenant_id AND c.user_id = e.user_id
                   AND c.role = e.role AND c.context_sha256 = e.context_sha256
                   AND c.provider_request_sha256 = e.provider_request_sha256
              )
            )`,
      ).bind(
        input.resultId,
        input.contextId,
        input.sourceChannel,
        idempotencyKeySha256,
        inputSha256,
        input.outcome,
        validationSha256,
        handoffSha256,
        resultSha256,
        resultJson,
        input.recordedAt,
        input.envelopeId,
        input.binding.tenant_id,
        input.binding.user_id,
        input.binding.role,
        input.binding.device_id,
        input.binding.pairing_id,
        input.contextSha256,
        input.providerRequestSha256,
        input.recordedAt,
        input.recordedAt,
        input.contextId,
        input.contextId,
      ),
      input.env.DB.prepare(
        `UPDATE hermes_desktop_envelopes
            SET state = 'submitted', submitted_at = ?
          WHERE envelope_id = ? AND state IN ('issued', 'staged')
            AND ? = 'accepted'
            AND EXISTS (
              SELECT 1 FROM hermes_desktop_results r
               WHERE r.result_id = ? AND r.envelope_id = hermes_desktop_envelopes.envelope_id
                 AND r.outcome = 'accepted'
            )`,
      ).bind(input.recordedAt, input.envelopeId, input.outcome, input.resultId),
      input.env.DB.prepare(
        `INSERT INTO hermes_desktop_events
         (event_id, event_type, tenant_id, user_id, role, pairing_id, device_id,
          envelope_id, context_id, result_id, detail_sha256, created_at)
         SELECT ?, 'draft_result_recorded', tenant_id, user_id, role, pairing_id,
                device_id, envelope_id, context_id, result_id, ?, ?
           FROM hermes_desktop_results WHERE result_id = ?`,
      ).bind(input.eventId, eventDetailSha256, input.recordedAt, input.resultId),
    ];
    const results = await input.env.DB.batch(statements);
    if (resultChanges(results[0]) !== 1) {
      const raced = await findStoredResult(
        input.env,
        input.binding.tenant_id,
        input.binding.user_id,
        idempotencyKeySha256,
      );
      if (raced) return replayOrConflict(raced, inputSha256, input);
      return await classifyAppendDenial(input);
    }
    if (resultChanges(results[2]) !== 1 ||
      (input.outcome === "accepted" && resultChanges(results[1]) !== 1)) {
      return { ok: false, error: "result_store_unavailable" };
    }
  } catch {
    const raced = await findStoredResult(
      input.env,
      input.binding.tenant_id,
      input.binding.user_id,
      idempotencyKeySha256,
    );
    if (raced) return replayOrConflict(raced, inputSha256, input);
    return await classifyAppendDenial(input);
  }

  return {
    ok: true,
    replayed: false,
    resultId: input.resultId,
    sourceChannel: input.sourceChannel,
    outcome: input.outcome,
    resultSha256,
    result,
    recordedAt: input.recordedAt,
  };
}

async function classifyAppendDenial(input: {
  env: Pick<AppEnv, "DB">;
  binding: HermesResultBinding;
  envelopeId: string;
  recordedAt: string;
}): Promise<AppendHermesResultResponse> {
  const terminal = await input.env.DB.prepare(
    `SELECT 1 AS present FROM hermes_desktop_results
      WHERE envelope_id = ? AND outcome = 'accepted' LIMIT 1`,
  ).bind(input.envelopeId).first<{ present: number }>();
  if (terminal) return { ok: false, error: "terminal_conflict" };
  const device = await input.env.DB.prepare(
    `SELECT revoked_at, access_expires_at FROM hermes_desktop_devices
      WHERE device_id = ? AND pairing_id = ? AND tenant_id = ? AND user_id = ?
        AND role = ? LIMIT 1`,
  ).bind(
    input.binding.device_id,
    input.binding.pairing_id,
    input.binding.tenant_id,
    input.binding.user_id,
    input.binding.role,
  ).first<{ revoked_at: string | null; access_expires_at: string }>();
  if (!device || device.revoked_at || device.access_expires_at <= input.recordedAt)
    return { ok: false, error: "binding_revoked_or_expired" };
  return { ok: false, error: "result_store_unavailable" };
}

async function findStoredResult(
  env: Pick<AppEnv, "DB">,
  tenantId: string,
  userId: string,
  idempotencyKeySha256: string,
): Promise<HermesStoredResult | null> {
  return await env.DB.prepare(
    `SELECT result_id, envelope_id, device_id, pairing_id, context_sha256,
            provider_request_sha256, source_channel, input_sha256, outcome,
            result_sha256, result_json, recorded_at
       FROM hermes_desktop_results
      WHERE tenant_id = ? AND user_id = ? AND idempotency_key_sha256 = ?
      LIMIT 1`,
  ).bind(tenantId, userId, idempotencyKeySha256).first<HermesStoredResult>();
}

function replayOrConflict(
  existing: HermesStoredResult,
  inputSha256: string,
  expected: {
    binding: HermesResultBinding;
    envelopeId: string;
    contextSha256: string;
    providerRequestSha256: string;
  },
): AppendHermesResultResponse {
  if (existing.envelope_id !== expected.envelopeId ||
    existing.device_id !== expected.binding.device_id ||
    existing.pairing_id !== expected.binding.pairing_id ||
    existing.context_sha256 !== expected.contextSha256 ||
    existing.provider_request_sha256 !== expected.providerRequestSha256) {
    return { ok: false, error: "terminal_conflict" };
  }
  if (existing.input_sha256 !== inputSha256)
    return { ok: false, error: "idempotency_conflict" };
  try {
    return {
      ok: true,
      replayed: true,
      resultId: existing.result_id,
      sourceChannel: existing.source_channel,
      outcome: existing.outcome,
      resultSha256: existing.result_sha256,
      result: JSON.parse(existing.result_json) as HermesResultPayload,
      recordedAt: existing.recorded_at,
    };
  } catch {
    return { ok: false, error: "result_store_unavailable" };
  }
}

function resultChanges(result: D1Result<unknown> | undefined): number {
  return Number(result?.meta?.changes ?? 0);
}
