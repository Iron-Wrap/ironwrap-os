// helm-authority-plan.ts — compiles one tenant's `helm.authority.provision.v1` plan: the effect
// types, principals, mandates and limits HELM must hold before `enforce` can admit anything.
//
// It produces a document and applies nothing. The plan is proposed to HELM and approved there by
// a distinct person, so this module is an input to that step and grants no authority itself.
//
// What goes in is what the Worker can actually propose (helm-gateway.ts sends `ironwrap.<action>`
// for the effect runtime's action), not the agent catalog: agent steps reach no provider yet, and
// a plan built from the catalog alone would leave almost every live effect out of scope. An action
// the catalog also names follows the tenant's delegation settings; every other action has no
// delegation setting to mirror, so it is in scope and stays gated by the Worker's own authority
// check. `mcp.*` tools are left out: an unlisted effect type is denied, which is the safe default.
//
// Three gateway rules shape the plan:
//
// - Terms and limits belong to a mandate, not to an effect type, so each effect type gets its own
//   mandate; a shared count limit would spend one effect's budget on another.
// - The gateway picks the caller's shallowest mandate for an effect type, so the Worker must never
//   hold the root: that would select the root's open terms over the child carrying the approval
//   threshold and limits.
// - A high or irreversible risk class makes every call of the effect type escalate, and a
//   registered class can only ever be raised. Effects outside the catalog therefore register as
//   `medium`, which keeps today's Worker-gated behaviour and can still be raised later.

import { ACCOUNTING_PROVIDER_ACTIONS } from "./accounting-submission.ts";
import { CATALOG_VERSION, catalogAction, type CatalogAction } from "./agents/catalog.ts";
import { currentDelegation } from "./agents/control.ts";
import type { AgentDb } from "./agents/store.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import {
  gatewayEffectType,
  gatewayMandateFor,
  type DelegationSetting,
  type GatewayMandateFragment,
} from "./helm-gateway.ts";

export type RiskClass = "low" | "medium" | "high" | "irreversible";

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

interface PlanLimit {
  node: string;
  unit: "count";
  measure: "count";
  window: "hour" | "day";
  span: number;
  value: number;
}

interface PlanTerms {
  effect_types: string[];
  targets: null;
  approval_threshold?: number;
}

export interface AuthorityPlan {
  schema: "helm.authority.provision.v1";
  org_ref: string;
  version_ref: string;
  stage: AuthorityPlanStage;
  base_plan_digest: string;
  valid_from: string;
  valid_until: string;
  effect_types: Array<{ effect_type: string; risk_class: RiskClass }>;
  principals: Array<{ id: string; kind: "service" }>;
  mandates: Array<{ node: string; holder: string; parent: string | null; terms: PlanTerms }>;
  limits: PlanLimit[];
}

export interface AuthorityPlanResult {
  plan: AuthorityPlan;
  plan_digest: string;
  /** Effect types the tenant's delegation settings leave out; the gateway denies them. */
  out_of_scope: string[];
}

export interface MandateTerms {
  approval_threshold: number | null;
  limits: GatewayMandateFragment["limits"];
}

/**
 * One principal per tenant means one set of terms per effect type, whichever specialist acts. The
 * effect is in scope if any specialist may use it, at the most cautious setting among those: the
 * Worker still refuses a specialist whose own setting is `off`. Null when none may use it.
 */
export function mostCautiousTerms(fragments: GatewayMandateFragment[]): MandateTerms | null {
  const live = fragments.filter((fragment) => fragment.in_scope);
  if (live.length === 0) return null;
  const thresholds = live.flatMap((fragment) => fragment.approval_threshold === null ? [] : [fragment.approval_threshold]);
  const limits = new Map<string, GatewayMandateFragment["limits"][number]>();
  for (const limit of live.flatMap((fragment) => fragment.limits)) {
    const key = `${limit.window_kind}:${limit.span}`;
    const held = limits.get(key);
    if (!held || limit.limit_value < held.limit_value) limits.set(key, limit);
  }
  return {
    approval_threshold: thresholds.length > 0 ? Math.min(...thresholds) : null,
    limits: [...limits.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, limit]) => limit),
  };
}

function catalogRisk(action: CatalogAction): RiskClass {
  switch (action.side_effect_class) {
    case "external_irreversible":
      return "irreversible";
    case "money":
    case "legal":
    case "safety":
      return "high";
    case "external_reversible":
      return "medium";
    default:
      return "low";
  }
}

function defaultDelegation(action: CatalogAction): DelegationSetting {
  if (action.default_delegation === "off_until_enabled") return "off";
  // An action nobody can delegate has no default; a person still decides each call.
  return action.default_delegation ?? "asks_first";
}

async function termsFor(db: AgentDb, tenantId: string, action: CatalogAction): Promise<MandateTerms | null> {
  const fragments = await Promise.all(action.owners.map(async (specialistId) => {
    // The effective setting: a demotion or a release hold already reads as `asks_first` here.
    const current = await currentDelegation(db, tenantId, specialistId, action.action_id);
    return gatewayMandateFor({
      tenantId,
      specialistId,
      actionId: action.action_id,
      delegation: current?.setting ?? defaultDelegation(action),
      ceiling: current?.ceiling ?? null,
    });
  }));
  return mostCautiousTerms(fragments);
}

/** The digest HELM computes: SHA-256 of the RFC 8785 form of the plan without its base digest. */
export async function authorityPlanDigest(plan: Record<string, unknown>): Promise<string> {
  const { base_plan_digest: _base, ...digested } = plan;
  return await sha256Hex(canonicalJson(digested));
}

export async function compileAuthorityPlan(db: AgentDb, input: AuthorityPlanInput): Promise<AuthorityPlanResult> {
  const grants = await Promise.all(GATEWAY_EFFECT_ACTIONS.map(async (actionId) => {
    const action = catalogAction(actionId);
    return {
      effect_type: gatewayEffectType(actionId),
      risk_class: action ? catalogRisk(action) : "medium" as RiskClass,
      terms: action ? await termsFor(db, input.tenantId, action) : { approval_threshold: null, limits: [] },
    };
  }));
  const inScope = grants.flatMap((grant) => grant.terms ? [{ ...grant, terms: grant.terms }] : []);
  const node = (effectType: string) => `worker:${effectType}`;
  const plan: AuthorityPlan = {
    schema: "helm.authority.provision.v1",
    org_ref: input.orgRef,
    version_ref: `ironwrap-catalog:${CATALOG_VERSION.slice(0, 32)}`,
    stage: input.stage,
    base_plan_digest: input.basePlanDigest,
    valid_from: input.validFrom,
    valid_until: input.validUntil,
    effect_types: inScope.map(({ effect_type, risk_class }) => ({ effect_type, risk_class })),
    principals: [
      { id: input.orgRef, kind: "service" },
      { id: input.workerPrincipal, kind: "service" },
    ],
    mandates: [
      {
        node: input.orgRef,
        holder: input.orgRef,
        parent: null,
        terms: { effect_types: inScope.map((grant) => grant.effect_type), targets: null },
      },
      ...inScope.map(({ effect_type, terms }) => ({
        node: node(effect_type),
        holder: input.workerPrincipal,
        parent: input.orgRef,
        terms: {
          effect_types: [effect_type],
          targets: null,
          ...(terms.approval_threshold === null ? {} : { approval_threshold: terms.approval_threshold }),
        } as PlanTerms,
      })),
    ],
    limits: inScope.flatMap(({ effect_type, terms }) => terms.limits.map((limit) => ({
      node: node(effect_type),
      unit: limit.unit,
      measure: limit.measure,
      window: limit.window_kind,
      span: limit.span,
      value: limit.limit_value,
    }))),
  };
  return {
    plan,
    plan_digest: await authorityPlanDigest(plan as unknown as Record<string, unknown>),
    out_of_scope: grants.filter((grant) => !grant.terms).map((grant) => grant.effect_type),
  };
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

/** The operator's inputs. A window is explicit: re-issuing with a later end widens every mandate. */
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
