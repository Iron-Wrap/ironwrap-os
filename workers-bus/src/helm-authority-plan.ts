// helm-authority-plan.ts — compiles one tenant's `helm.authority.provision.v1` plan: the effect
// types, principals and mandates HELM must hold before `enforce` can admit anything.
//
// It produces a document and applies nothing. The plan is proposed to HELM and approved there by
// a distinct person, so this module is an input to that step and grants no authority itself.
//
// What goes in is what the effect runtime can actually propose (helm-gateway.ts sends
// `ironwrap.<action>`), each action in scope for the Worker's service principal. `mcp.*` tools are
// left out: an unlisted effect type is denied, which is the safe default.
//
// The plan adds no approval and no limit of its own, because every listed action already passes
// the Worker's own authority check. It does not mirror delegation settings (`gatewayMandateFor`):
// those govern agents, agent steps reach no provider yet, and one principal per tenant cannot tell
// an agent from the person behind a permit. An agent's `off` would deny that person's call, and
// `asks_first` would ask again for what a person just approved. Mirroring belongs with per-specialist
// principals, once agent steps reach the effect runtime.
//
// Two gateway rules shape the plan:
//
// - The gateway picks the caller's shallowest mandate for an effect type, so the Worker holds a
//   child of the organization's root and never the root: an approval or limit later put on that
//   child would otherwise be skipped.
// - A high or irreversible risk class makes every call of the effect type escalate, and a
//   registered class can only ever be raised. Every action therefore registers as `medium`, which
//   keeps today's Worker-gated behaviour and can still be raised later.

import { ACCOUNTING_PROVIDER_ACTIONS } from "./accounting-submission.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { gatewayEffectType } from "./helm-gateway.ts";

const NEWO_OPERATIONS = [
  "agent_actor.create",
  "auth.token.revoke",
  "chat.user.send",
  "conversation.agent_message.send",
  "session.update",
  "user_actor.create",
  "user_actor.delete",
  "user_actor.get_or_create",
  "user_actor.update",
  "webhook.incoming.create",
  "webhook.incoming.delete",
  "webhook.incoming.update",
  "webhook.outgoing.create",
  "webhook.outgoing.delete",
  "webhook.outgoing.update",
];

const ACCOUNTING_ACTIONS = Object.values(ACCOUNTING_PROVIDER_ACTIONS)
  .filter((action): action is string => action !== null);

/** Every action the effect runtime can propose to the gateway; a source-scan test keeps it whole. */
export const GATEWAY_EFFECT_ACTIONS: readonly string[] = Object.freeze([...new Set([
  "accounting.invoice.submit",
  "customer.email.send",
  "docs.document.merge",
  "document.generate",
  "drive.file.copy",
  "drive.file.upload",
  "drive.folder.create",
  "facet.design.v2.compatibility_projection",
  "facet.design.v2.compatibility_projection.blocked",
  "jobnimbus.post",
  "jobnimbus.put",
  "operations.email.send",
  "postiz.intent.stop",
  "postiz.intent.submit",
  "proposal.publish",
  "proposal.withdraw",
  ...ACCOUNTING_ACTIONS,
  ...NEWO_OPERATIONS,
])].sort());

const WORKER_NODE = "seat:ironwrap-bus#g1";
const STAGES = ["draft", "approval-required", "constrained-live", "certified-live"] as const;
export type AuthorityPlanStage = typeof STAGES[number];

export interface AuthorityPlanInput {
  tenantId: string;
  orgRef: string;
  workerPrincipal: string;
  stage: AuthorityPlanStage;
  basePlanDigest: string;
  validFrom: string;
  validUntil: string;
}

interface PlanTerms {
  effect_types: string[];
  targets: null;
}

export interface AuthorityPlan {
  schema: "helm.authority.provision.v1";
  org_ref: string;
  version_ref: string;
  stage: AuthorityPlanStage;
  base_plan_digest: string;
  valid_from: string;
  valid_until: string;
  effect_types: Array<{ effect_type: string; risk_class: "medium" }>;
  principals: Array<{ id: string; kind: "service" }>;
  mandates: Array<{ node: string; holder: string; parent: string | null; terms: PlanTerms }>;
}

export interface AuthorityPlanResult {
  plan: AuthorityPlan;
  plan_digest: string;
}

/** The digest HELM computes: SHA-256 of the RFC 8785 form of the plan without its base digest. */
export async function authorityPlanDigest(plan: Record<string, unknown>): Promise<string> {
  const { base_plan_digest: _base, ...digested } = plan;
  return await sha256Hex(canonicalJson(digested));
}

export async function compileAuthorityPlan(input: AuthorityPlanInput): Promise<AuthorityPlanResult> {
  const effectTypes = GATEWAY_EFFECT_ACTIONS.map((action) => gatewayEffectType(action));
  const terms: PlanTerms = { effect_types: effectTypes, targets: null };
  const plan: AuthorityPlan = {
    schema: "helm.authority.provision.v1",
    org_ref: input.orgRef,
    version_ref: `ironwrap-effects:${(await sha256Hex(canonicalJson(effectTypes))).slice(0, 32)}`,
    stage: input.stage,
    base_plan_digest: input.basePlanDigest,
    valid_from: input.validFrom,
    valid_until: input.validUntil,
    effect_types: effectTypes.map((effect_type) => ({ effect_type, risk_class: "medium" })),
    principals: [
      { id: input.orgRef, kind: "service" },
      { id: input.workerPrincipal, kind: "service" },
    ],
    mandates: [
      { node: input.orgRef, holder: input.orgRef, parent: null, terms },
      { node: WORKER_NODE, holder: input.workerPrincipal, parent: input.orgRef, terms },
    ],
  };
  return { plan, plan_digest: await authorityPlanDigest(plan as unknown as Record<string, unknown>) };
}

const ORG_REF_RE = /^org:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLAN_DIGEST_RE = /^([0-9a-f]{64})?$/;
// eslint-disable-next-line no-control-regex
const PRINCIPAL_RE = /^[^\u0000-\u001f\u007f]{1,255}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function instant(value: string | null): number | null {
  if (value === null || !INSTANT_RE.test(value)) return null;
  const parsed = Date.parse(value);
  // The round trip refuses a calendar date Date.parse would quietly roll over.
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace(".000Z", "Z") === value ? parsed : null;
}

/** The operator's inputs. A window is explicit: re-issuing with a later end widens the mandates. */
export function parseAuthorityPlanQuery(
  tenantId: string,
  query: URLSearchParams,
): { input: AuthorityPlanInput } | { error: string } {
  const orgRef = query.get("org_ref") ?? `org:${tenantId}`;
  if (!ORG_REF_RE.test(orgRef)) return { error: "invalid_org_ref" };
  const workerPrincipal = query.get("worker_principal") ?? "";
  if (!PRINCIPAL_RE.test(workerPrincipal) || workerPrincipal.trim() !== workerPrincipal) {
    return { error: "invalid_worker_principal" };
  }
  if (workerPrincipal === orgRef) return { error: "worker_principal_is_root" };
  const stage = (query.get("stage") ?? "draft") as AuthorityPlanStage;
  if (!STAGES.includes(stage)) return { error: "invalid_stage" };
  const basePlanDigest = query.get("base_plan_digest") ?? "";
  if (!PLAN_DIGEST_RE.test(basePlanDigest)) return { error: "invalid_base_plan_digest" };
  const validFrom = query.get("valid_from");
  const validUntil = query.get("valid_until");
  const from = instant(validFrom);
  const until = instant(validUntil);
  if (from === null || until === null || until <= from) return { error: "invalid_validity_window" };
  return { input: { tenantId, orgRef, workerPrincipal, stage, basePlanDigest, validFrom: validFrom!, validUntil: validUntil! } };
}
