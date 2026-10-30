import { agentDataClass } from "./agents/api.ts";
import type { AppEnv } from "./app-types.ts";
import {
  authorizeExternalEffect,
  claimExternalEffect,
  getExternalEffect,
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
 * The action prefix this bearer handles: the MCP host's bounded agent tools, each claimed as
 * `mcp.<tool>` (`mcp/erpnext-roofing-mcp/src/server.mjs`). Every other action is the bus's own.
 */
const TOKEN_ACTION_PREFIX = "mcp.";
/**
 * The one other effect this bearer handles, and only on a Worker whose data class is exactly
 * `synthetic`: the QA seed's proposal publish through its stand-in provider, which reaches no one
 * (`tools/seed-qa-journey.mjs`). No other stand-in pair passes until someone adds it here on purpose.
 */
const QA_SEED_ACTION = "proposal.publish";
const QA_SEED_PROVIDER = "qa-synthetic-publication";
/**
 * Sends to someone outside the business. The two proposal actions are bound to a person-issued
 * permit (0093); the two email actions run only inside the bus (`google.ts`). This bearer never
 * claims, settles, reconciles or retries one, the QA seed's stand-in publish aside: its holder could
 * write the expected readback itself or report a match nobody observed, so its settlement would be
 * its own word, not the provider's. They keep their own refusal code, which says why.
 */
const OUTSIDE_SEND_ACTIONS: ReadonlySet<string> = new Set([
  "proposal.publish",
  "proposal.withdraw",
  "customer.email.send",
  "operations.email.send",
]);
/** The permit-bound sends run once: never retried, on this route and in D1 (0164). */
const PERMIT_BOUND_SENDS: ReadonlySet<string> = new Set(["proposal.publish", "proposal.withdraw"]);

/**
 * Why this bearer may not touch an effect with this action and provider, or null. It handles
 * `mcp.*` actions, and the QA seed's stand-in publish on a synthetic Worker; everything else is
 * refused, in this order:
 * - a `qa-synthetic-*` provider on a Worker whose data class is not exactly `synthetic`: unset
 *   reads as business and a misspelling as no class, so both refuse (`effect_provider_not_allowed`);
 * - an outside send (`effect_outside_send_token_refused`);
 * - any other action outside `mcp.*` (`effect_runtime_action_not_allowed`);
 * - an `mcp.*` action through a stand-in provider (`effect_provider_not_allowed`).
 * D1 cannot apply this rule: neither an attempt nor an event records who claimed it, so a bearer
 * write and a bus write look the same there. The rule lives here, on every bearer route.
 */
function tokenRefusal(env: AppEnv, action: string, provider: string): string | null {
  const syntheticWorker = agentDataClass(env.AGENT_DATA_CLASS) === "synthetic";
  const standIn = provider.startsWith("qa-synthetic-");
  if (standIn && !syntheticWorker) return "effect_provider_not_allowed";
  if (syntheticWorker && action === QA_SEED_ACTION && provider === QA_SEED_PROVIDER) return null;
  if (OUTSIDE_SEND_ACTIONS.has(action)) return "effect_outside_send_token_refused";
  if (!action.startsWith(TOKEN_ACTION_PREFIX)) return "effect_runtime_action_not_allowed";
  if (standIn) return "effect_provider_not_allowed";
  return null;
}

/** A claim that would allow a second attempt: a retry limit other than 0, or more than one attempt. */
function allowsRetry(effect: Record<string, any>, authority: EffectAuthority): boolean {
  const maxAttempts = authority.maxAttempts ?? 1;
  return (effect.retryLimit ?? 0) !== 0 || typeof maxAttempts !== "number" || maxAttempts > 1;
}

/** Bind the stored effect to this Worker before its action; a missing one keeps `effect_missing`. */
async function existingEffectRefusal(env: AppEnv, effectId: string): Promise<Response | null> {
  const existing = await getExternalEffect(env, effectId);
  // The stored tenant is immutable. Do not trust a tenant supplied beside the effect id, or
  // normalize a stored tenant into another tenant's identity.
  if (existing && existing.tenant_id !== (env.APP_TENANT_ID?.trim() || "ironwrap")) {
    return json({ error: "effect_tenant_mismatch" }, 403);
  }
  const refusal = existing && tokenRefusal(env, existing.action, existing.provider);
  return refusal ? json({ error: refusal }, effectErrorStatus(refusal)) : null;
}

/**
 * The MCP host claims its `mcp.*` effects here: it keeps its provider credentials and executes the
 * claimed Frappe request locally. Nothing else is claimed here, the QA seed's stand-in publish on a
 * synthetic Worker aside: only the bus may execute any other action. The Worker owns the durable
 * proposal/lease/readback state; this endpoint never accepts provider credentials or performs a
 * provider call.
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
  const action = String(effect.action ?? "");
  const refusal = tokenRefusal(env, action, String(effect.provider ?? ""))
    ?? (PERMIT_BOUND_SENDS.has(action) && allowsRetry(effect, authority) ? "effect_outside_send_retry_forbidden" : null);
  if (refusal) return json({ error: refusal }, effectErrorStatus(refusal));
  // The claim happens now, by the server's clock: a caller-supplied time could backdate a claim
  // past an effect's deadline.
  const now = new Date().toISOString();
  try {
    const proposed = await proposeExternalEffect(env, {
      ...effect,
      now,
      authority: {
        permitRef: String(record(effect.authority)?.permitRef ?? ""),
        policyRef: String(record(effect.authority)?.policyRef ?? ""),
        policyVersion: String(record(effect.authority)?.policyVersion ?? ""),
      },
    } as ExternalEffectRequest);
    const authorized = proposed.state === "proposed"
      ? await authorizeExternalEffect(env, proposed.effect_id, authority, now)
      : proposed;
    const claimed = await claimExternalEffect(env, authorized.effect_id, new Date(now));
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
  const refused = await existingEffectRefusal(env, effectId);
  if (refused) return refused;
  try {
    // Settled now, by the server's clock: a caller's `now` is ignored, so a settlement is dated when
    // the Worker records it, never when the caller says it was.
    const settled = await settleExternalEffect(env, effectId, {
      ...settlement,
      now: new Date().toISOString(),
    } as ExternalEffectSettlement);
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
  const refused = await existingEffectRefusal(env, effectId);
  if (refused) return refused;
  try {
    const effect = await reconcileExternalEffect(env, effectId, {
      outcome: outcome as "executed" | "not_executed" | "inconclusive",
      evidence: body.evidence,
      detailCode: text(body.detailCode) ?? undefined,
      // Reconciled now, by the server's clock; a caller's `now` is ignored.
      now: new Date().toISOString(),
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
  const refused = await existingEffectRefusal(env, effectId);
  if (refused) return refused;
  try {
    // Retried now, by the server's clock: a caller's `now` is ignored, so a backdated retry cannot
    // pass an effect's deadline.
    const effect = await retryExternalEffect(env, effectId, new Date().toISOString());
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
  // D1's outside-send guards (0164): a proposal send is never retried, and an unknown one moves on
  // only with a person's delivery confirmation.
  if (value.includes("outside_send_retry_limit_invalid") || value.includes("outside_send_retry_forbidden")) {
    return "effect_outside_send_retry_forbidden";
  }
  if (value.includes("proposal_delivery_settle_evidence_missing")) return "effect_reconciliation_evidence_missing";
  // D1's single-flight guard (0156): this proposal revision's last send is not confirmed delivered.
  if (value.includes("proposal_delivery_unconfirmed")) return "proposal_delivery_unconfirmed";
  // D1's late-answer guard (0161): an unknown proposal send is not "not executed" before its
  // provider's answer can no longer arrive.
  if (value.includes("proposal_delivery_answer_may_be_late")) return "proposal_delivery_answer_may_be_late";
  return /^effect_[a-z0-9_]+$/.test(value) ? value : "effect_runtime_error";
}

function effectErrorStatus(error: unknown): 400 | 403 | 409 | 422 | 500 {
  const code = effectError(error);
  if (code === "proposal_delivery_unconfirmed" || code === "proposal_delivery_answer_may_be_late") return 409;
  if (code === "effect_runtime_error") return 500;
  if (
    code === "effect_outside_send_token_refused" ||
    code === "effect_provider_not_allowed" ||
    code === "effect_runtime_action_not_allowed"
  ) return 403;
  if (code === "effect_outside_send_retry_forbidden") return 422;
  if (code === "effect_reconciliation_evidence_missing") return 409;
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
