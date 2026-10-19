import type { AppEnv } from "./app-types.ts";
import {
  authorizeExternalEffect,
  claimExternalEffect,
  proposeExternalEffect,
  reconcileExternalEffect,
  retryExternalEffect,
  settleExternalEffect,
  type EffectAuthority,
  type ExternalEffectRequest,
  type ExternalEffectSettlement,
} from "./effect-runtime.ts";

const MAX_EFFECT_BODY_BYTES = 256 * 1024;

/**
 * The MCP host keeps its provider credentials and executes the claimed Frappe
 * request locally. The Worker owns the durable proposal/lease/readback state;
 * this endpoint never accepts provider credentials or performs a provider call.
 */
export async function handleExternalEffectClaim(req: Request, env: AppEnv): Promise<Response> {
  const body = await parseJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const effect = record(body.effect);
  const authority = record(body.authority) as EffectAuthority | null;
  if (!effect || !authority) return json({ error: "effect_envelope_invalid" }, 400);
  if (!tenantMatches(env, effect.tenantId) || authority.tenantId !== effect.tenantId) {
    return json({ error: "effect_tenant_mismatch" }, 403);
  }
  try {
    const proposed = await proposeExternalEffect(env, {
      ...effect,
      authority: {
        permitRef: String(record(effect.authority)?.permitRef ?? ""),
        policyRef: String(record(effect.authority)?.policyRef ?? ""),
        policyVersion: String(record(effect.authority)?.policyVersion ?? ""),
      },
    } as ExternalEffectRequest);
    const authorized = proposed.state === "proposed"
      ? await authorizeExternalEffect(env, proposed.effect_id, authority, String(effect.now ?? new Date().toISOString()))
      : proposed;
    const claimed = await claimExternalEffect(env, authorized.effect_id, new Date(String(effect.now ?? new Date().toISOString())));
    return json({ effect: claimed.effect, attempt: claimed.attempt });
  } catch (error) {
    return json({ error: effectError(error) }, effectErrorStatus(error));
  }
}

/** Settle an attempt after the MCP/provider authority has performed readback. */
export async function handleExternalEffectSettlement(req: Request, env: AppEnv): Promise<Response> {
  const body = await parseJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const effectId = text(body.effectId);
  const settlement = record(body.settlement);
  if (!effectId || !settlement) return json({ error: "effect_settlement_invalid" }, 400);
  try {
    const settled = await settleExternalEffect(env, effectId, settlement as ExternalEffectSettlement);
    return json({ effect: settled.effect, attempt: settled.attempt, value: settled.value });
  } catch (error) {
    return json({ error: effectError(error) }, effectErrorStatus(error));
  }
}

/** Record provider evidence for an unknown effect; this is the gate before retry. */
export async function handleExternalEffectReconciliation(req: Request, env: AppEnv): Promise<Response> {
  const body = await parseJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const effectId = text(body.effectId);
  const outcome = text(body.outcome);
  if (!effectId || !outcome || !["executed", "not_executed", "inconclusive"].includes(outcome) || !("evidence" in body)) {
    return json({ error: "effect_reconciliation_invalid" }, 400);
  }
  try {
    const effect = await reconcileExternalEffect(env, effectId, {
      outcome: outcome as "executed" | "not_executed" | "inconclusive",
      evidence: body.evidence,
      detailCode: text(body.detailCode) ?? undefined,
      now: text(body.now) ?? undefined,
    });
    return json({ effect });
  } catch (error) {
    return json({ error: effectError(error) }, effectErrorStatus(error));
  }
}

/** Permit a new attempt only after the effect has been reconciled. */
export async function handleExternalEffectRetry(req: Request, env: AppEnv): Promise<Response> {
  const body = await parseJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const effectId = text(body.effectId);
  if (!effectId) return json({ error: "effect_retry_invalid" }, 400);
  try {
    const effect = await retryExternalEffect(env, effectId, text(body.now) ?? undefined);
    return json({ effect });
  } catch (error) {
    return json({ error: effectError(error) }, effectErrorStatus(error));
  }
}

async function parseJson(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_EFFECT_BODY_BYTES) return null;
  const raw = await req.text();
  if (raw.length > MAX_EFFECT_BODY_BYTES) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return record(value);
  } catch {
    return null;
  }
}

function tenantMatches(env: AppEnv, value: unknown): boolean {
  const tenant = text(value);
  return !!tenant && tenant === (env.APP_TENANT_ID?.trim() || "ironwrap");
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function effectError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  // D1's single-flight guard (0156): this proposal revision's last send is not confirmed delivered.
  if (value.includes("proposal_delivery_unconfirmed")) return "proposal_delivery_unconfirmed";
  return /^effect_[a-z0-9_]+$/.test(value) ? value : "effect_runtime_error";
}

function effectErrorStatus(error: unknown): 400 | 409 | 422 | 500 {
  const code = effectError(error);
  if (code === "proposal_delivery_unconfirmed") return 409;
  if (code === "effect_runtime_error") return 500;
  if (code.includes("conflict") || code.includes("in_flight") || code.includes("lease_lost")) return 409;
  if (code.includes("missing") || code.includes("invalid") || code.includes("expired") || code.includes("denied")) return 422;
  return 400;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
