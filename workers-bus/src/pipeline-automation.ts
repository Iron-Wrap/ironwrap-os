/**
 * Governed stage-change automation (IRO-244).
 *
 * This module is deliberately a small, CLOSED rail: a fixed registry of actions, a built-in
 * template plus tenant-authored document templates, and tenant-administered recipient references
 * (ELEC-204 - see `automation-recipients.ts`; the deployment secret survives only as a fallback for
 * tenants that have not yet written a catalog of their own).
 * Pipeline transitions remain the business source of truth; this consumer only binds and drains
 * their durable outbox rows. Provider execution is delegated to the universal effect runtime.
 *
 * Nothing in the registry, the dispatcher or the routes names a trade. An action says "generate a
 * document and deliver it"; WHICH document is a template row an administrator authors, so every
 * document a business sends on a stage change - in any industry - is the same code path with
 * different configuration.
 */

import type { AppEnv } from "./app-types.ts";
import {
  getDocumentTemplate,
  getDocumentTemplateRevision,
  listDocumentTemplates,
  type DocumentGenerationServiceAuthority,
  type DocumentTemplateRevision,
} from "./document-templates.ts";
import { generateDocumentToR2 } from "./document-generation-r2.ts";
import {
  AutomationRecipientsError,
  listAutomationRecipients,
  resolveTenantRecipient,
  tenantAdministersRecipients,
} from "./automation-recipients.ts";
import { effectLedgerAvailable } from "./effect-runtime.ts";
import { sendPipelineAutomationEmail, gmailConfigured } from "./google.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

/** Deliver the built-in stage-change summary. */
export const PIPELINE_AUTOMATION_ACTION = "operations.email.send" as const;
/** Generate a configured document for the card's entity, then deliver it on the same rail. */
export const PIPELINE_AUTOMATION_DOCUMENT_ACTION = "operations.document.generate_and_send" as const;
export const PIPELINE_AUTOMATION_TEMPLATE_KEY = "pipeline.stage-change-summary" as const;
export const PIPELINE_AUTOMATION_TEMPLATE_VERSION = 1 as const;

/**
 * The whole registry. Adding an entry here is the ONLY way a new action becomes authorable or
 * executable - there is no formula language, no webhook and no tenant code path. The pickers an
 * administrator sees are rendered from this list by way of `pipelineAutomationCatalog`, so a new
 * entry reaches the rule builder without a client release.
 */
export const PIPELINE_AUTOMATION_REGISTRY = [
  {
    action: PIPELINE_AUTOMATION_ACTION,
    label: "Stage-change email",
    template_source: "builtin",
  },
  {
    action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
    label: "Generate a document and email it",
    template_source: "document_template",
  },
] as const;

export type PipelineAutomationAction = (typeof PIPELINE_AUTOMATION_REGISTRY)[number]["action"];

export const PIPELINE_AUTOMATION_ACTIONS: readonly PipelineAutomationAction[] =
  PIPELINE_AUTOMATION_REGISTRY.map((entry) => entry.action);

/** A document permit lives well past the retry ladder but never indefinitely. */
const DOCUMENT_PERMIT_TTL_MS = 24 * 60 * 60_000;
/** The generation effect asks the ledger for this much runway; the permit must still cover it. */
const DOCUMENT_EFFECT_DEADLINE_MS = 5 * 60_000;
const DOCUMENT_POLICY_REF = "policy:pipeline-automation:document.generate";
const DOCUMENT_POLICY_VERSION = "v1";
const DOCUMENT_ACTOR_ID = "pipeline-automation";
const DOCUMENT_ACTOR_AUTHORITY_REF = "authority:pipeline-automation";
export const PIPELINE_AUTOMATION_DEFAULT_LIMIT = 25;
export const PIPELINE_AUTOMATION_MAX_LIMIT = 100;
/**
 * How many recent firings the activity read publishes. An administrator opens it to answer "did the
 * last one work?", not to audit a year of dispatch, and an unbounded read of an append-only table is
 * a cost a configuration screen should never be able to impose. The window and whether it clipped
 * anything both travel in the response, so a client is never left guessing whether it is looking at
 * the whole record.
 */
export const PIPELINE_AUTOMATION_ACTIVITY_LIMIT = 20;
const PIPELINE_AUTOMATION_RETRY_LIMIT = 2;
const INVOCATION_LEASE_MS = 2 * 60_000;
const RECIPIENT_REF_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_FAILURES_IN_REPORT = 10;

export interface PipelineAutomationRule {
  rule_id: string;
  tenant_id: string;
  pipeline_id: string;
  to_stage_id: string;
  revision_id: string;
  version: number;
  prior_revision_id: string | null;
  action: PipelineAutomationAction;
  recipient_ref: string;
  template_key: string;
  template_version: number;
  active: number;
  actor_role: string;
  actor_id: string;
  created_at: string;
}

export interface AutomationRuleActor {
  role: string;
  userId: string;
}

export interface AutomationRuleInput {
  pipelineId: string;
  toStageId: string;
  action: unknown;
  recipientRef: unknown;
  templateKey: unknown;
  templateVersion: unknown;
  active: unknown;
}

export interface CreatePipelineAutomationRuleInput extends AutomationRuleInput {
  tenantId?: string;
  actor: AutomationRuleActor;
}

export interface RevisePipelineAutomationRuleInput extends AutomationRuleInput {
  tenantId?: string;
  ruleId: string;
  expectedVersion: number;
  actor: AutomationRuleActor;
}

export interface AutomationRecipient {
  ref: string;
  /** Raw address is kept in memory only while dispatching; it is never returned or persisted. */
  address: string;
  digest: string;
}

export class PipelineAutomationError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.name = "PipelineAutomationError";
  }
}

interface RuleHeadRow {
  rule_id: string;
  tenant_id: string;
  pipeline_id: string;
  to_stage_id: string;
  current_revision_id: string | null;
  current_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  outbox_id: string;
  tenant_id: string;
  pipeline_id: string;
  card_id: string;
  transition_id: string;
  from_stage_id: string | null;
  to_stage_id: string;
  status: "pending" | "claimed" | "done" | "failed";
  binding_state: "unbound" | "bound" | "no_rule";
  rule_id: string | null;
  rule_revision_id: string | null;
  rule_version: number | null;
  binding_digest: string | null;
  lease_ref: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  terminal_code: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The lifecycle of one firing, as the schema stores it.
 *
 * `succeeded`, `failed` and `unknown` are THREE terminal answers, not two. `unknown` is the effect
 * ledger declining to claim a delivery it could not verify - the message may well have gone out.
 * Anything that reads this rail (including the administrator's own screen) has to keep it separate:
 * collapsing it into either neighbour asserts something the server deliberately refused to assert.
 */
export type PipelineAutomationDispatchStatus =
  | "pending"
  | "claimed"
  | "retry"
  | "succeeded"
  | "failed"
  | "unknown";

interface InvocationRow {
  invocation_id: string;
  tenant_id: string;
  outbox_id: string;
  pipeline_id: string;
  transition_id: string;
  rule_id: string;
  rule_revision_id: string;
  rule_version: number;
  action: PipelineAutomationAction;
  recipient_ref: string;
  recipient_digest: string | null;
  template_key: string;
  template_version: number;
  status: PipelineAutomationDispatchStatus;
  attempt_count: number;
  lease_ref: string | null;
  lease_expires_at: string | null;
  effect_id: string | null;
  effect_state: string | null;
  provider_external_id: string | null;
  provider_response_hash: string | null;
  readback_hash: string | null;
  result_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface DeliveryContext {
  pipeline_name: string;
  card_id: string;
  entity_type: string;
  entity_id: string;
  from_stage_name: string | null;
  to_stage_name: string;
  occurred_at: string;
  reason_code: string | null;
}

export interface AutomationSendResult {
  outcome: "succeeded" | "retry" | "failed" | "unknown";
  effectId?: string | null;
  effectState?: string | null;
  providerExternalId?: string | null;
  providerResponseHash?: string | null;
  readbackHash?: string | null;
  resultCode?: string | null;
}

export interface AutomationSendInput {
  tenantId: string;
  invocationId: string;
  idempotencyKey: string;
  recipient: AutomationRecipient;
  subject: string;
  html: string;
  pipelineId: string;
  transitionId: string;
  now: string;
}

export type PipelineAutomationSender = (
  input: AutomationSendInput,
) => Promise<AutomationSendResult>;

export interface AutomationDocumentRequest {
  tenantId: string;
  entityType: string;
  entityId: string;
  templateId: string;
  serviceAuthority: DocumentGenerationServiceAuthority;
  idempotencyKey: string;
  now: string;
}

export interface AutomationDocumentResult {
  outcome: "succeeded" | "failed" | "unknown" | "manual_exception" | "not_executed";
  label: string;
  body: string;
  outputDigest: string;
  providerDocumentId: string | null;
  receiptId: string;
  templateRevisionId: string;
  templateVersion: number;
  resultCode?: string;
}

/**
 * The generation half of the document action. Production always runs the governed R2 generator;
 * the seam exists so a test can prove the dispatcher's own contract without an object store.
 */
export type PipelineAutomationDocumentGenerator = (
  input: AutomationDocumentRequest,
) => Promise<AutomationDocumentResult>;

export interface PipelineAutomationDrainOptions {
  now?: Date;
  limit?: number;
  sender?: PipelineAutomationSender;
  documentGenerator?: PipelineAutomationDocumentGenerator;
}

export interface PipelineAutomationDrainReport {
  enabled: boolean;
  available: boolean;
  scanned: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  unknown: number;
  no_rule: number;
  recovered: number;
  unavailable: number;
  failures: Array<{ outbox_id: string; error: string }>;
}

export interface PipelineAutomationLeaseRecoveryReport {
  scanned: number;
  recovered: number;
  retried: number;
  unknown: number;
  failed: number;
  failures: Array<{ invocation_id: string; error: string }>;
}

export interface PipelineAutomationCatalog {
  actions: Array<{ action: PipelineAutomationAction; label: string; template_source: string }>;
  templates: Array<{ template_key: string; version: number; label: string; action: PipelineAutomationAction }>;
  recipient_refs: string[];
  /** Labels for the same refs, in the same order, so a picker shows what an owner authored. */
  recipient_labels: Array<{ recipient_ref: string; label: string }>;
  recipient_configured: boolean;
  /**
   * `tenant` once this tenant administers its own catalog, `deployment` while it is still running
   * on the legacy env blob, `none` when neither exists. The rule builder shows the administrator
   * whether "add a recipient" is a screen they can use or a deployment they have to inherit.
   */
  recipient_source: "tenant" | "deployment" | "none";
  document_generation_configured: boolean;
  /**
   * True when this deployment also serves `.../automation-rules/:ruleId/activity`, i.e. publishes
   * what a rule DID and not only how it is configured. A client keys its whole firing surface off
   * this flag rather than off an empty list, because an empty panel from a deployment that never
   * publishes outcomes reads as "nothing has gone wrong" - a claim an unpublished outcome cannot
   * support. It is a statement about the BUILD, not about the tenant's data or configuration.
   */
  activity_available: boolean;
}

/**
 * The actions and templates that can be persisted, published for the administrator's pickers.
 *
 * The list is server-owned on purpose: the rule builder renders whatever comes back, so an action
 * registered here appears in the UI without a client release. Templates are scoped to the
 * pipeline's own entity type, because a rule can only ever generate a document about the entity its
 * cards carry.
 */
export async function pipelineAutomationCatalog(
  env: AppEnv,
  tenantId: string,
  entityType: string,
): Promise<PipelineAutomationCatalog> {
  const recipients = await automationRecipientCatalog(env, tenantId);
  const documents = documentGenerationConfigured(env);
  const templates: PipelineAutomationCatalog["templates"] = [{
    template_key: PIPELINE_AUTOMATION_TEMPLATE_KEY,
    version: PIPELINE_AUTOMATION_TEMPLATE_VERSION,
    label: "Stage-change summary",
    action: PIPELINE_AUTOMATION_ACTION,
  }];
  if (documents)
    for (const template of await listDocumentTemplates(env, tenantId, entityType)) {
      if (!template.active) continue;
      templates.push({
        template_key: template.template_id,
        version: template.version,
        label: template.label,
        action: PIPELINE_AUTOMATION_DOCUMENT_ACTION,
      });
    }
  return {
    // An action whose deployment prerequisites are missing is withheld rather than offered and then
    // refused: an administrator can only compose a rule this deployment can actually run.
    actions: PIPELINE_AUTOMATION_REGISTRY
      .filter((entry) => entry.template_source !== "document_template" || documents)
      .map((entry) => ({ action: entry.action, label: entry.label, template_source: entry.template_source })),
    templates,
    recipient_refs: recipients.entries.map((entry) => entry.ref),
    recipient_labels: recipients.entries.map((entry) => ({
      recipient_ref: entry.ref,
      label: entry.label,
    })),
    recipient_configured: recipients.entries.length > 0,
    recipient_source: recipients.source,
    document_generation_configured: documents,
    // Unconditional, unlike the two flags above: those report deployment configuration, this one
    // reports that `listPipelineAutomationActivity` is wired to a route in this build. Nothing an
    // operator can switch off changes the answer, and a rule that has never fired still publishes
    // an honest empty window rather than no window at all.
    activity_available: true,
  };
}

/**
 * Document generation is separately activated per deployment (IRO-242). The automation rail never
 * widens that switch - it reads it, and withholds the document action until an operator sets it.
 */
export function documentGenerationConfigured(env: AppEnv): boolean {
  if (String(env.APP_DOCUMENT_GENERATION_ENABLED ?? "") !== "true") return false;
  const bucket = (env as { RAW?: { head?: unknown; put?: unknown } }).RAW;
  return typeof bucket?.head === "function" && typeof bucket.put === "function";
}

export function pipelineAutomationEnabled(env: AppEnv): boolean {
  return String(env.PIPELINE_AUTOMATION_ENABLED) === "true";
}

/** Validate the closed registry and deployment-owned recipient reference before a rule write. */
export async function validateAutomationRuleInput(
  env: AppEnv,
  input: AutomationRuleInput,
  scope: { tenantId: string; entityType: string },
): Promise<{
  action: PipelineAutomationAction;
  recipient: AutomationRecipient;
  active: boolean;
  template: { key: string; version: number };
}> {
  const action = validateAction(env, input.action);
  const template = await validateTemplate(env, scope, action, input.templateKey, input.templateVersion);
  const recipientRef = validateRecipientRef(input.recipientRef);
  const recipient = await resolvePipelineAutomationRecipient(env, scope.tenantId, recipientRef);
  const active = input.active === undefined || input.active === null ? true : input.active;
  if (typeof active !== "boolean") throw new PipelineAutomationError("automation_active_invalid");
  return { action, recipient, active, template };
}

/**
 * The registry is closed at authoring AND at execution. Anything outside it is refused here before
 * a row can exist; the same guard runs again when a claimed invocation is dispatched, so a value
 * that somehow reached D1 still cannot reach a provider.
 */
export function validateAction(env: AppEnv, value: unknown): PipelineAutomationAction {
  const available = PIPELINE_AUTOMATION_REGISTRY.filter(
    (entry) => entry.template_source !== "document_template" || documentGenerationConfigured(env),
  );
  const entry = available.find((candidate) => candidate.action === value);
  if (!entry)
    throw new PipelineAutomationError("automation_action_invalid", {
      actions: available.map((candidate) => candidate.action),
    });
  return entry.action;
}

/**
 * The built-in action keeps its built-in template. The document action carries a document-template
 * identifier the administrator authored, checked against the pipeline's own entity type so a rule
 * cannot ask for a document about something its cards never hold.
 */
export async function validateTemplate(
  env: AppEnv,
  scope: { tenantId: string; entityType: string },
  action: PipelineAutomationAction,
  key: unknown,
  version: unknown,
): Promise<{ key: string; version: number }> {
  if (action === PIPELINE_AUTOMATION_ACTION) {
    if (key !== PIPELINE_AUTOMATION_TEMPLATE_KEY || version !== PIPELINE_AUTOMATION_TEMPLATE_VERSION)
      throw new PipelineAutomationError("automation_template_invalid", {
        template_key: PIPELINE_AUTOMATION_TEMPLATE_KEY,
        template_version: PIPELINE_AUTOMATION_TEMPLATE_VERSION,
      });
    return { key: PIPELINE_AUTOMATION_TEMPLATE_KEY, version: PIPELINE_AUTOMATION_TEMPLATE_VERSION };
  }
  if (typeof key !== "string" || key === PIPELINE_AUTOMATION_TEMPLATE_KEY ||
      key.trim().length < 12 || key.trim().length > 220 || !/^[A-Za-z0-9._:-]+$/.test(key.trim()))
    throw new PipelineAutomationError("automation_template_invalid");
  if (!Number.isInteger(version) || Number(version) < 1)
    throw new PipelineAutomationError("automation_template_invalid");
  const templateId = key.trim();
  const template = await getDocumentTemplate(env, scope.tenantId, templateId);
  if (!template) throw new PipelineAutomationError("automation_document_template_not_found");
  if (!template.active) throw new PipelineAutomationError("automation_document_template_retired");
  if (template.entity_type !== scope.entityType)
    throw new PipelineAutomationError("automation_document_template_entity_mismatch", {
      entity_type: scope.entityType,
    });
  // The administrator picks the version the catalog offered. Execution follows the template head,
  // and the immutable generation receipt records the revision actually rendered - so this pin is
  // provenance for the choice, not a freeze on the document.
  if (template.version !== Number(version))
    throw new PipelineAutomationError("automation_document_template_version_conflict", {
      template_version: template.version,
    });
  return { key: templateId, version: template.version };
}

export function validateRecipientRef(value: unknown): string {
  if (typeof value !== "string" || !RECIPIENT_REF_PATTERN.test(value.trim()))
    throw new PipelineAutomationError("automation_recipient_ref_invalid");
  return value.trim();
}

/**
 * Resolve a reference to a destination, without ever returning it from an API or writing it to a
 * rule or invocation row.
 *
 * Precedence, and the answer to "what happens to a deployment that already populated
 * `PIPELINE_AUTOMATION_RECIPIENTS_JSON`":
 *
 *   1. the tenant's own catalog, if the tenant has one;
 *   2. otherwise the deployment blob, read as a FALLBACK.
 *
 * The chosen migration rule is fallback-on-empty, not seed-on-first-boot. A seed would have to run
 * somewhere, would mint rows nobody authored, and would have to guess an actor for the attribution
 * this aggregate exists to keep honest. The fallback needs none of that and is reversible: an
 * existing deployment keeps delivering unchanged, and the first recipient an owner creates takes
 * the whole catalog over.
 *
 * That takeover is deliberately per-TENANT and not per-reference. Once a tenant administers its
 * own catalog the env blob stops being consulted entirely, so a reference the owner did not carry
 * across fails loudly here rather than silently resolving to an address an engineer set months ago
 * and nobody can see. `automationRecipientCatalog` publishes which source is live, so the rule
 * builder can say so before an administrator writes the first record.
 */
export async function resolvePipelineAutomationRecipient(
  env: AppEnv,
  tenantId: string,
  recipientRef: string,
): Promise<AutomationRecipient> {
  const ref = validateRecipientRef(recipientRef);
  let tenantRecipient: Awaited<ReturnType<typeof resolveTenantRecipient>>;
  try {
    tenantRecipient = await resolveTenantRecipient(env, tenantId, ref);
  } catch (error) {
    throw new PipelineAutomationError(
      error instanceof AutomationRecipientsError ? error.code : "automation_recipient_ref_unknown",
    );
  }
  if (tenantRecipient)
    return { ref, address: tenantRecipient.address, digest: tenantRecipient.digest };
  if (await tenantAdministersRecipients(env, tenantId))
    throw new PipelineAutomationError("automation_recipient_ref_unknown");

  const config = parseRecipientConfiguration(env);
  if (!config.ok) throw new PipelineAutomationError(config.error);
  const address = config.entries.get(ref);
  if (!address) throw new PipelineAutomationError("automation_recipient_ref_unknown");
  return {
    ref,
    address,
    digest: await sha256Hex(address),
  };
}

/**
 * The refs an administrator may pick from, with the source they came from.
 *
 * Same precedence as resolution, and it must stay that way: a picker that offered a deployment ref
 * the dispatcher would refuse to resolve is exactly the mismatch that made the original defect
 * invisible until a stage change failed.
 */
export async function automationRecipientCatalog(
  env: AppEnv,
  tenantId: string,
): Promise<{
  source: "tenant" | "deployment" | "none";
  entries: Array<{ ref: string; label: string }>;
}> {
  if (await tenantAdministersRecipients(env, tenantId)) {
    const records = await listAutomationRecipients(env, tenantId);
    return {
      source: "tenant",
      entries: records
        .filter((record) => record.active === 1)
        .map((record) => ({ ref: record.recipient_ref, label: record.label })),
    };
  }
  const config = parseRecipientConfiguration(env);
  if (!config.ok) return { source: "none", entries: [] };
  return {
    source: "deployment",
    entries: [...config.entries.keys()].sort().map((ref) => ({ ref, label: ref })),
  };
}

/**
 * Whether ANY recipient source can answer a resolution for this tenant. The drain refuses to do
 * provider work while this is false, exactly as it did when the deployment blob was the only
 * source.
 */
export async function recipientCatalogAvailable(env: AppEnv, tenantId: string): Promise<boolean> {
  return (await automationRecipientCatalog(env, tenantId)).entries.length > 0;
}

/**
 * The legacy deployment blob. It is no longer the catalog - it is the fallback a tenant that has
 * never written a recipient record still resolves through, so an existing deployment keeps
 * delivering across this change.
 */
type RecipientConfiguration =
  | { ok: true; entries: Map<string, string> }
  | { ok: false; error: "automation_recipient_config_unavailable" | "automation_recipient_config_malformed" };

function parseRecipientConfiguration(env: AppEnv): RecipientConfiguration {
  const source = env.PIPELINE_AUTOMATION_RECIPIENTS_JSON?.trim();
  if (!source) return { ok: false, error: "automation_recipient_config_unavailable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: "automation_recipient_config_malformed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, error: "automation_recipient_config_malformed" };
  const entries = new Map<string, string>();
  for (const [ref, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!RECIPIENT_REF_PATTERN.test(ref) || typeof raw !== "string")
      return { ok: false, error: "automation_recipient_config_malformed" };
    const address = raw.trim().toLowerCase();
    if (address.length < 3 || address.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
      return { ok: false, error: "automation_recipient_config_malformed" };
    entries.set(ref, address);
  }
  if (entries.size === 0) return { ok: false, error: "automation_recipient_config_malformed" };
  return { ok: true, entries };
}

export async function listPipelineAutomationRules(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<PipelineAutomationRule[]> {
  const rows = await env.DB.prepare(
    `SELECT h.rule_id, h.tenant_id, h.pipeline_id, h.to_stage_id,
            r.revision_id, r.version, r.prior_revision_id, r.action,
            r.recipient_ref, r.template_key, r.template_version, r.active,
            r.actor_role, r.actor_id, r.created_at
       FROM pipeline_automation_rule_heads h
       JOIN pipeline_automation_rule_revisions r
         ON r.tenant_id = h.tenant_id AND r.rule_id = h.rule_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? AND h.pipeline_id = ?
      ORDER BY h.to_stage_id ASC, h.rule_id ASC`,
  ).bind(tenantId, pipelineId).all<PipelineAutomationRule>();
  return rows.results;
}

export async function listPipelineAutomationRuleRevisions(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  ruleId: string,
): Promise<PipelineAutomationRule[] | null> {
  const rows = await env.DB.prepare(
    `SELECT h.rule_id, h.tenant_id, h.pipeline_id, h.to_stage_id,
            r.revision_id, r.version, r.prior_revision_id, r.action,
            r.recipient_ref, r.template_key, r.template_version, r.active,
            r.actor_role, r.actor_id, r.created_at
       FROM pipeline_automation_rule_heads h
       JOIN pipeline_automation_rule_revisions r
         ON r.tenant_id = h.tenant_id AND r.rule_id = h.rule_id
      WHERE h.tenant_id = ? AND h.pipeline_id = ? AND h.rule_id = ?
      ORDER BY r.version ASC, r.revision_id ASC`,
  ).bind(tenantId, pipelineId, ruleId).all<PipelineAutomationRule>();
  return rows.results.length > 0 ? rows.results : null;
}

/**
 * One firing of one rule, as an administrator is entitled to see it.
 *
 * Deliberately NARROWER than `InvocationRow`. The recipient reference and digest, the effect id and
 * state, the provider's external id and the response/readback hashes all stay server-side: they are
 * delivery evidence for an operator holding the effect ledger, not something a configuration screen
 * needs in order to say what happened. `result_code` is the one diagnostic that crosses, and it
 * crosses as PROVENANCE beside a translated sentence, never as the sentence itself.
 */
export interface PipelineAutomationDispatch {
  invocation_id: string;
  outbox_id: string;
  transition_id: string;
  /** The card whose move fired this rule. */
  card_id: string | null;
  to_stage_id: string;
  rule_version: number;
  action: PipelineAutomationAction;
  status: PipelineAutomationDispatchStatus;
  attempt_count: number;
  result_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * What a rule DID, newest first - the counterpart to `listPipelineAutomationRuleRevisions`, which
 * answers only how the rule was configured over time.
 *
 * A rule that exists and has never fired returns an empty window; that is a different answer from
 * "this deployment does not publish outcomes" (the catalog's `activity_available`) and from "no such
 * rule" (a 404 at the route), and all three have to stay distinguishable or an administrator cannot
 * tell a healthy rule from an invisible failure.
 *
 * The join to the outbox is what supplies the card and the stage the card landed on; the invocation
 * row itself carries no card. `binding_state = 'no_rule'` rows are excluded explicitly: today they
 * never own an invocation (one is only inserted once the outbox is `bound`), so the predicate costs
 * nothing and stops a future binding state from quietly renaming somebody else's transition as this
 * rule's firing.
 */
export async function listPipelineAutomationActivity(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  ruleId: string,
  limit: number = PIPELINE_AUTOMATION_ACTIVITY_LIMIT,
): Promise<{ activity: PipelineAutomationDispatch[]; limit: number; truncated: boolean }> {
  const window = boundedLimit(limit);
  // One row beyond the window, so "there is more" is observed rather than inferred from a full page.
  const rows = await env.DB.prepare(
    `SELECT i.invocation_id, i.outbox_id, i.transition_id, o.card_id, o.to_stage_id,
            i.rule_version, i.action, i.status, i.attempt_count, i.result_code,
            i.created_at, i.updated_at, i.completed_at
       FROM pipeline_stage_automation_invocations i
       JOIN pipeline_stage_automation_outbox o
         ON o.tenant_id = i.tenant_id AND o.outbox_id = i.outbox_id
      WHERE i.tenant_id = ? AND i.pipeline_id = ? AND i.rule_id = ?
        AND o.binding_state != 'no_rule'
      ORDER BY i.created_at DESC, i.invocation_id DESC
      LIMIT ?`,
  ).bind(tenantId, pipelineId, ruleId, window + 1).all<PipelineAutomationDispatch>();
  return {
    activity: rows.results.slice(0, window),
    limit: window,
    truncated: rows.results.length > window,
  };
}

export async function createPipelineAutomationRule(
  env: AppEnv,
  input: CreatePipelineAutomationRuleInput,
  now = new Date(),
): Promise<PipelineAutomationRule> {
  const actor = validateActor(input.actor);
  const nowIso = validNow(now);
  const tenantId = input.tenantId ?? env.APP_TENANT_ID ?? "ironwrap";
  const target = await assertActiveTarget(env, tenantId, input.pipelineId, input.toStageId);
  const checked = await validateAutomationRuleInput(env, input, { tenantId, entityType: target.entityType });
  const ruleId = await stableRuleId(tenantId, input.pipelineId, input.toStageId);
  const revisionId = await stableRevisionId(ruleId, 1);
  const headCreated = await env.DB.prepare(
    `INSERT INTO pipeline_automation_rule_heads (
       rule_id, tenant_id, pipeline_id, to_stage_id, current_revision_id, current_version,
       created_by, created_at, updated_at
     )
     SELECT ?, ?, p.pipeline_id, s.stage_id, NULL, 0, ?, ?, ?
       FROM pipelines p
       JOIN pipeline_stages s
         ON s.tenant_id = p.tenant_id AND s.pipeline_id = p.pipeline_id
      WHERE p.tenant_id = ? AND p.pipeline_id = ? AND p.is_active = 1
        AND s.stage_id = ? AND s.is_active = 1`,
  ).bind(
    ruleId,
    tenantId,
    actor.userId,
    nowIso,
    nowIso,
    tenantId,
    input.pipelineId,
    input.toStageId,
  );
  const revision = env.DB.prepare(
    `INSERT INTO pipeline_automation_rule_revisions (
       revision_id, tenant_id, rule_id, version, prior_revision_id, pipeline_id, to_stage_id,
       action, recipient_ref, template_key, template_version, active, actor_role, actor_id, created_at
     )
     SELECT ?, h.tenant_id, h.rule_id, 1, NULL, h.pipeline_id, h.to_stage_id,
            ?, ?, ?, ?, ?, ?, ?, ?
       FROM pipeline_automation_rule_heads h
      WHERE h.tenant_id = ? AND h.rule_id = ? AND h.current_version = 0
        AND h.current_revision_id IS NULL`,
  ).bind(
    revisionId,
    checked.action,
    checked.recipient.ref,
    checked.template.key,
    checked.template.version,
    checked.active ? 1 : 0,
    actor.role,
    actor.userId,
    nowIso,
    tenantId,
    ruleId,
  );
  const headUpdated = env.DB.prepare(
    `UPDATE pipeline_automation_rule_heads
        SET current_revision_id = ?, current_version = 1, updated_at = ?
      WHERE tenant_id = ? AND rule_id = ? AND current_version = 0 AND current_revision_id IS NULL`,
  ).bind(revisionId, nowIso, tenantId, ruleId);
  try {
    const results = await env.DB.batch([headCreated, revision, headUpdated]);
    if (Number((results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1)
      throw new PipelineAutomationError("automation_rule_exists");
  } catch (error) {
    if (error instanceof PipelineAutomationError) throw error;
    const existing = await getPipelineAutomationRule(env, tenantId, ruleId);
    if (existing) throw new PipelineAutomationError("automation_rule_exists");
    throw new PipelineAutomationError("automation_rule_write_failed");
  }
  const created = await getPipelineAutomationRule(env, tenantId, ruleId);
  if (!created) throw new PipelineAutomationError("automation_rule_write_failed");
  return created;
}

export async function revisePipelineAutomationRule(
  env: AppEnv,
  input: RevisePipelineAutomationRuleInput,
  now = new Date(),
): Promise<PipelineAutomationRule> {
  const actor = validateActor(input.actor);
  const nowIso = validNow(now);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new PipelineAutomationError("automation_expected_version_invalid");
  const tenantId = input.tenantId ?? env.APP_TENANT_ID ?? "ironwrap";
  const target = await assertActiveTarget(env, tenantId, input.pipelineId, input.toStageId);
  const checked = await validateAutomationRuleInput(env, input, { tenantId, entityType: target.entityType });
  const head = await env.DB.prepare(
    `SELECT * FROM pipeline_automation_rule_heads
      WHERE tenant_id = ? AND rule_id = ? AND pipeline_id = ? AND to_stage_id = ? LIMIT 1`,
  ).bind(tenantId, input.ruleId, input.pipelineId, input.toStageId).first<RuleHeadRow>();
  if (!head) throw new PipelineAutomationError("automation_rule_not_found");
  if (head.current_version !== input.expectedVersion)
    throw new PipelineAutomationError("automation_rule_version_conflict", {
      current_version: head.current_version,
      expected_version: input.expectedVersion,
    });
  const nextVersion = head.current_version + 1;
  const revisionId = await stableRevisionId(head.rule_id, nextVersion);
  const revision = env.DB.prepare(
    `INSERT INTO pipeline_automation_rule_revisions (
       revision_id, tenant_id, rule_id, version, prior_revision_id, pipeline_id, to_stage_id,
       action, recipient_ref, template_key, template_version, active, actor_role, actor_id, created_at
     ) SELECT ?, h.tenant_id, h.rule_id, ?, h.current_revision_id, h.pipeline_id, h.to_stage_id,
            ?, ?, ?, ?, ?, ?, ?, ?
       FROM pipeline_automation_rule_heads h
      WHERE h.tenant_id = ? AND h.rule_id = ? AND h.current_version = ?
        AND h.current_revision_id IS ?`,
  ).bind(
    revisionId,
    nextVersion,
    checked.action,
    checked.recipient.ref,
    checked.template.key,
    checked.template.version,
    checked.active ? 1 : 0,
    actor.role,
    actor.userId,
    nowIso,
    tenantId,
    head.rule_id,
    input.expectedVersion,
    head.current_revision_id,
  );
  const headUpdated = env.DB.prepare(
    `UPDATE pipeline_automation_rule_heads
        SET current_revision_id = ?, current_version = ?, updated_at = ?
      WHERE tenant_id = ? AND rule_id = ? AND current_version = ?
        AND current_revision_id IS ?`,
  ).bind(
    revisionId,
    nextVersion,
    nowIso,
    tenantId,
    head.rule_id,
    input.expectedVersion,
    head.current_revision_id,
  );
  try {
    const results = await env.DB.batch([revision, headUpdated]);
    if (Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1)
      throw new PipelineAutomationError("automation_rule_version_conflict");
  } catch (error) {
    if (error instanceof PipelineAutomationError) throw error;
    throw new PipelineAutomationError("automation_rule_write_failed");
  }
  const revised = await getPipelineAutomationRule(env, tenantId, head.rule_id);
  if (!revised) throw new PipelineAutomationError("automation_rule_write_failed");
  return revised;
}

export async function getPipelineAutomationRule(
  env: AppEnv,
  tenantId: string,
  ruleId: string,
): Promise<PipelineAutomationRule | null> {
  return await env.DB.prepare(
    `SELECT h.rule_id, h.tenant_id, h.pipeline_id, h.to_stage_id,
            r.revision_id, r.version, r.prior_revision_id, r.action,
            r.recipient_ref, r.template_key, r.template_version, r.active,
            r.actor_role, r.actor_id, r.created_at
       FROM pipeline_automation_rule_heads h
       JOIN pipeline_automation_rule_revisions r
         ON r.tenant_id = h.tenant_id AND r.rule_id = h.rule_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? AND h.rule_id = ? LIMIT 1`,
  ).bind(tenantId, ruleId).first<PipelineAutomationRule>();
}

async function assertActiveTarget(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  stageId: string,
): Promise<{ entityType: string }> {
  const row = await env.DB.prepare(
    `SELECT p.is_active AS pipeline_active, p.entity_type AS entity_type, s.is_active AS stage_active
       FROM pipelines p
       JOIN pipeline_stages s
         ON s.tenant_id = p.tenant_id AND s.pipeline_id = p.pipeline_id
      WHERE p.tenant_id = ? AND p.pipeline_id = ? AND s.stage_id = ? LIMIT 1`,
  ).bind(tenantId, pipelineId, stageId).first<{ pipeline_active: number; entity_type: string; stage_active: number }>();
  if (!row) throw new PipelineAutomationError("automation_pipeline_or_stage_not_found");
  if (row.pipeline_active !== 1 || row.stage_active !== 1)
    throw new PipelineAutomationError("automation_pipeline_or_stage_inactive");
  return { entityType: row.entity_type };
}

function validateActor(actor: AutomationRuleActor): AutomationRuleActor {
  if (!actor || typeof actor.userId !== "string" || actor.userId.trim().length < 1 || actor.userId.length > 160)
    throw new PipelineAutomationError("automation_actor_invalid");
  if (typeof actor.role !== "string" || actor.role.trim().length < 2 || actor.role.length > 40)
    throw new PipelineAutomationError("automation_actor_invalid");
  return { role: actor.role.trim(), userId: actor.userId.trim() };
}

function validNow(now: Date): string {
  const value = now.toISOString();
  if (!Number.isFinite(Date.parse(value))) throw new PipelineAutomationError("automation_time_invalid");
  return value;
}

async function stableRuleId(tenantId: string, pipelineId: string, stageId: string): Promise<string> {
  return `parule_${(await sha256Hex(canonicalJson({ schema_version: "ironwrap.pipeline-automation-rule.v1", tenant_id: tenantId, pipeline_id: pipelineId, to_stage_id: stageId }))).slice(0, 48)}`;
}

async function stableRevisionId(ruleId: string, version: number): Promise<string> {
  return `parrev_${(await sha256Hex(`${ruleId}:${version}`)).slice(0, 48)}`;
}

async function stableInvocationId(tenantId: string, outboxId: string): Promise<string> {
  return `parinv_${(await sha256Hex(`pipeline-automation-invocation:${tenantId}:${outboxId}`)).slice(0, 48)}`;
}

export function pipelineAutomationEffectKey(invocationId: string): string {
  return `pipeline-automation:${invocationId}`;
}

/**
 * Bounded five-minute drain. It never performs provider work while the feature, recipient catalog,
 * Gmail adapter or universal effect ledger is unavailable. A custom sender is test-only plumbing;
 * production's default sender always runs through the governed Gmail adapter.
 */
export async function drainPipelineStageAutomation(
  env: AppEnv,
  options: PipelineAutomationDrainOptions = {},
): Promise<PipelineAutomationDrainReport> {
  const now = options.now ?? new Date();
  const nowIso = validNow(now);
  const limit = boundedLimit(options.limit);
  const report: PipelineAutomationDrainReport = {
    enabled: pipelineAutomationEnabled(env),
    available: false,
    scanned: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    unknown: 0,
    no_rule: 0,
    recovered: 0,
    unavailable: 0,
    failures: [],
  };
  if (!report.enabled) return report;

  const customSender = options.sender;
  const available = customSender
    ? effectLedgerAvailable(env) && env.EFFECT_RUNTIME_ENABLED === "true"
    : effectLedgerAvailable(env) && env.EFFECT_RUNTIME_ENABLED === "true" && gmailConfigured(env);
  report.available = available;
  if (!available) {
    report.unavailable = 1;
    return report;
  }
  if (!(await recipientCatalogAvailable(env, automationTenantId(env)))) {
    report.available = false;
    report.unavailable = 1;
    return report;
  }

  const recovery = await recoverPipelineAutomationLeases(env, nowIso, limit);
  report.recovered = recovery.recovered;
  report.retried += recovery.retried;
  report.unknown += recovery.unknown;
  report.failed += recovery.failed;
  for (const failure of recovery.failures)
    if (report.failures.length < MAX_FAILURES_IN_REPORT)
      report.failures.push({ outbox_id: failure.invocation_id, error: failure.error });

  const sender = customSender ?? defaultPipelineAutomationSender(env);
  const documentGenerator = options.documentGenerator ?? defaultAutomationDocumentGenerator(env);
  for (let index = 0; index < limit; index += 1) {
    const candidate = await claimNextPipelineAutomation(env, nowIso);
    if (!candidate) break;
    report.scanned += 1;
    if (candidate.noRule) {
      report.no_rule += 1;
      continue;
    }
    report.claimed += 1;
    try {
      const outcome = await processClaimedInvocation(
        env, candidate.outbox, candidate.invocation, sender, documentGenerator, nowIso,
      );
      if (outcome === "succeeded") report.sent += 1;
      else if (outcome === "retry") report.retried += 1;
      else if (outcome === "unknown") report.unknown += 1;
      else report.failed += 1;
    } catch (error) {
      report.failed += 1;
      if (report.failures.length < MAX_FAILURES_IN_REPORT)
        report.failures.push({ outbox_id: candidate.outbox.outbox_id, error: automationErrorCode(error) });
      try {
        await finalizeAutomationInvocation(
          env,
          candidate.outbox,
          candidate.invocation,
          candidate.invocation.lease_ref ?? "",
          { outcome: "failed", resultCode: "automation_drain_failed" },
          nowIso,
        );
      } catch {
        // The exact lease guard deliberately wins over a best-effort cleanup.
      }
    }
  }
  return report;
}

function defaultPipelineAutomationSender(env: AppEnv): PipelineAutomationSender {
  return async (input) => {
    try {
      const receipt = await sendPipelineAutomationEmail(env, input.recipient.address, input.subject, input.html, {
        idempotencyKey: input.idempotencyKey,
        taskId: `pipeline-automation:${input.invocationId}`,
        actorId: "pipeline-automation",
        aggregate: { type: "pipeline_transition", id: input.transitionId, version: 1 },
      });
      return {
        outcome: "succeeded",
        effectId: receipt.effectId,
        effectState: receipt.effectState,
        providerExternalId: receipt.providerMessageId,
        providerResponseHash: receipt.providerResponseHash,
        readbackHash: receipt.readbackHash,
      };
    } catch (error) {
      const effect = await env.DB.prepare(
        `SELECT effect_id, state, provider_external_id, provider_response_hash, readback_hash, result_code
           FROM external_effects WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
      ).bind(input.tenantId, input.idempotencyKey).first<{
        effect_id: string;
        state: string;
        provider_external_id: string | null;
        provider_response_hash: string | null;
        readback_hash: string | null;
        result_code: string | null;
      }>();
      if (effect && ["unknown", "manual_exception", "executing", "reconciling"].includes(effect.state))
        return {
          outcome: "unknown",
          effectId: effect.effect_id,
          effectState: effect.state,
          providerExternalId: effect.provider_external_id,
          providerResponseHash: effect.provider_response_hash,
          readbackHash: effect.readback_hash,
          resultCode: effect.result_code ?? automationErrorCode(error),
        };
      if (effect?.state === "failed")
        return { outcome: "retry", effectId: effect.effect_id, effectState: effect.state, resultCode: effect.result_code };
      return { outcome: "failed", effectId: effect?.effect_id, effectState: effect?.state, resultCode: automationErrorCode(error) };
    }
  };
}

interface ClaimedAutomation {
  outbox: OutboxRow;
  invocation: InvocationRow;
  noRule: boolean;
}

interface ActiveAutomationRule {
  rule_id: string;
  revision_id: string;
  version: number;
  action: PipelineAutomationAction;
  recipient_ref: string;
  template_key: string;
  template_version: number;
}

async function claimNextPipelineAutomation(env: AppEnv, nowIso: string): Promise<ClaimedAutomation | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM pipeline_stage_automation_outbox
      WHERE tenant_id = ? AND status = 'pending' AND binding_state IN ('unbound', 'bound')
      ORDER BY created_at ASC, outbox_id ASC LIMIT 1`,
  ).bind(automationTenantId(env)).first<OutboxRow>();
  if (!row) return null;
  const leaseRef = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.parse(nowIso) + INVOCATION_LEASE_MS).toISOString();
  if (row.binding_state === "unbound") {
    const activeRule = await getActiveAutomationRule(env, row);
    const baseDigest = {
      schema_version: "ironwrap.pipeline-automation-binding.v1",
      tenant_id: row.tenant_id,
      outbox_id: row.outbox_id,
      transition_id: row.transition_id,
      pipeline_id: row.pipeline_id,
      to_stage_id: row.to_stage_id,
    };
    if (!activeRule) {
      const digest = await sha256Hex(canonicalJson({ ...baseDigest, binding_state: "no_rule" }));
      const noRule = await env.DB.prepare(
        `UPDATE pipeline_stage_automation_outbox AS o
            SET binding_state = 'no_rule', binding_digest = ?, status = 'done',
                terminal_code = 'no_matching_rule', updated_at = ?
          WHERE o.tenant_id = ? AND o.outbox_id = ? AND o.status = 'pending'
            AND o.binding_state = 'unbound'
            AND NOT EXISTS (
              SELECT 1 FROM pipeline_automation_rule_heads h
              JOIN pipeline_automation_rule_revisions r
                ON r.tenant_id = h.tenant_id AND r.rule_id = h.rule_id
               AND r.revision_id = h.current_revision_id AND r.version = h.current_version
              JOIN pipelines p ON p.tenant_id = h.tenant_id AND p.pipeline_id = h.pipeline_id
              JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.pipeline_id = h.pipeline_id
               AND s.stage_id = h.to_stage_id
             WHERE h.tenant_id = o.tenant_id AND h.pipeline_id = o.pipeline_id
               AND h.to_stage_id = o.to_stage_id AND r.active = 1
               AND p.is_active = 1 AND s.is_active = 1
               AND r.created_at < o.created_at
            )`,
      ).bind(digest, nowIso, row.tenant_id, row.outbox_id).run();
      if (Number(noRule.meta?.changes ?? 0) < 1) return null;
      const completed = await getOutbox(env, row.tenant_id, row.outbox_id);
      if (!completed) throw new PipelineAutomationError("automation_outbox_missing");
      return { outbox: completed, invocation: null as never, noRule: true };
    }

    const digest = await sha256Hex(canonicalJson({
      ...baseDigest,
      binding_state: "bound",
      rule_id: activeRule.rule_id,
      revision_id: activeRule.revision_id,
      version: activeRule.version,
      action: activeRule.action,
      recipient_ref: activeRule.recipient_ref,
      template_key: activeRule.template_key,
      template_version: activeRule.template_version,
    }));
    const invocationId = await stableInvocationId(row.tenant_id, row.outbox_id);
    const update = env.DB.prepare(
      `UPDATE pipeline_stage_automation_outbox AS o
          SET binding_state = 'bound', rule_id = ?, rule_revision_id = ?, rule_version = ?,
              binding_digest = ?, status = 'claimed', lease_ref = ?, lease_expires_at = ?,
              attempt_count = attempt_count + 1, terminal_code = NULL, updated_at = ?
        WHERE o.outbox_id = ? AND o.tenant_id = ? AND o.status = 'pending'
          AND o.binding_state = 'unbound'
          AND EXISTS (
            SELECT 1 FROM pipeline_automation_rule_heads h
            JOIN pipeline_automation_rule_revisions r
              ON r.tenant_id = h.tenant_id AND r.rule_id = h.rule_id
             AND r.revision_id = h.current_revision_id AND r.version = h.current_version
            JOIN pipelines p ON p.tenant_id = h.tenant_id AND p.pipeline_id = h.pipeline_id
            JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.pipeline_id = h.pipeline_id
             AND s.stage_id = h.to_stage_id
           WHERE h.tenant_id = o.tenant_id AND h.pipeline_id = o.pipeline_id
             AND h.to_stage_id = o.to_stage_id AND h.rule_id = ?
             AND h.current_revision_id = ? AND h.current_version = ?
             AND r.active = 1 AND p.is_active = 1 AND s.is_active = 1
             AND r.created_at < o.created_at
          )`,
    ).bind(
      activeRule.rule_id,
      activeRule.revision_id,
      activeRule.version,
      digest,
      leaseRef,
      leaseExpiresAt,
      nowIso,
      row.outbox_id,
      row.tenant_id,
      activeRule.rule_id,
      activeRule.revision_id,
      activeRule.version,
    );
    const insert = env.DB.prepare(
      `INSERT INTO pipeline_stage_automation_invocations (
         invocation_id, tenant_id, outbox_id, pipeline_id, transition_id, rule_id, rule_revision_id,
         rule_version, action, recipient_ref, template_key, template_version, status, attempt_count,
         lease_ref, lease_expires_at, created_at, updated_at
       ) SELECT ?, o.tenant_id, o.outbox_id, o.pipeline_id, o.transition_id, o.rule_id,
                o.rule_revision_id, o.rule_version, r.action, r.recipient_ref, r.template_key,
                r.template_version, 'claimed', 1, o.lease_ref, o.lease_expires_at, ?, ?
           FROM pipeline_stage_automation_outbox o
           JOIN pipeline_automation_rule_revisions r
             ON r.tenant_id = o.tenant_id AND r.revision_id = o.rule_revision_id
            AND r.version = o.rule_version
          WHERE o.outbox_id = ? AND o.tenant_id = ? AND o.binding_state = 'bound'
            AND o.status = 'claimed' AND o.lease_ref = ?
            AND NOT EXISTS (
              SELECT 1 FROM pipeline_stage_automation_invocations i
               WHERE i.tenant_id = o.tenant_id AND i.outbox_id = o.outbox_id
            )`,
    ).bind(invocationId, nowIso, nowIso, row.outbox_id, row.tenant_id, leaseRef);
    const results = await env.DB.batch([update, insert]);
    const updated = Number((results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0);
    const outbox = await getOutbox(env, row.tenant_id, row.outbox_id);
    if (updated < 1 || !outbox) return null;
    const invocation = await getInvocation(env, row.tenant_id, invocationId);
    if (!invocation) throw new PipelineAutomationError("automation_invocation_missing");
    return { outbox, invocation, noRule: false };
  }

  if (!row.rule_revision_id || !row.rule_id) return null;
  const invocation = await env.DB.prepare(
    `SELECT * FROM pipeline_stage_automation_invocations
      WHERE tenant_id = ? AND outbox_id = ? LIMIT 1`,
  ).bind(row.tenant_id, row.outbox_id).first<InvocationRow>();
  if (!invocation || (invocation.status !== "pending" && invocation.status !== "retry")) return null;
  const outboxUpdate = env.DB.prepare(
    `UPDATE pipeline_stage_automation_outbox
        SET status = 'claimed', lease_ref = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
            terminal_code = NULL, updated_at = ?
      WHERE tenant_id = ? AND outbox_id = ? AND binding_state = 'bound' AND status = 'pending'`,
  ).bind(leaseRef, leaseExpiresAt, nowIso, row.tenant_id, row.outbox_id);
  const invocationUpdate = env.DB.prepare(
    `UPDATE pipeline_stage_automation_invocations
        SET status = 'claimed', lease_ref = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
            result_code = NULL, updated_at = ?
      WHERE tenant_id = ? AND invocation_id = ? AND status IN ('pending', 'retry')`,
  ).bind(leaseRef, leaseExpiresAt, nowIso, row.tenant_id, invocation.invocation_id);
  const results = await env.DB.batch([outboxUpdate, invocationUpdate]);
  if (Number((results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1 ||
      Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1) return null;
  const claimedOutbox = await getOutbox(env, row.tenant_id, row.outbox_id);
  const claimedInvocation = await getInvocation(env, row.tenant_id, invocation.invocation_id);
  if (!claimedOutbox || !claimedInvocation) throw new PipelineAutomationError("automation_invocation_missing");
  return { outbox: claimedOutbox, invocation: claimedInvocation, noRule: false };
}

async function getActiveAutomationRule(env: AppEnv, row: OutboxRow): Promise<ActiveAutomationRule | null> {
  return await env.DB.prepare(
    `SELECT h.rule_id, h.current_revision_id AS revision_id, h.current_version AS version,
            r.action, r.recipient_ref, r.template_key, r.template_version
       FROM pipeline_automation_rule_heads h
       JOIN pipeline_automation_rule_revisions r
         ON r.tenant_id = h.tenant_id AND r.rule_id = h.rule_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
       JOIN pipelines p ON p.tenant_id = h.tenant_id AND p.pipeline_id = h.pipeline_id
       JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.pipeline_id = h.pipeline_id
        AND s.stage_id = h.to_stage_id
      WHERE h.tenant_id = ? AND h.pipeline_id = ? AND h.to_stage_id = ?
        AND r.active = 1 AND p.is_active = 1 AND s.is_active = 1
        AND r.created_at < ?
      LIMIT 1`,
  ).bind(row.tenant_id, row.pipeline_id, row.to_stage_id, row.created_at).first<ActiveAutomationRule>();
}

async function processClaimedInvocation(
  env: AppEnv,
  outbox: OutboxRow,
  invocation: InvocationRow,
  sender: PipelineAutomationSender,
  documentGenerator: PipelineAutomationDocumentGenerator,
  nowIso: string,
): Promise<"succeeded" | "retry" | "failed" | "unknown"> {
  const leaseRef = invocation.lease_ref;
  if (!leaseRef) throw new PipelineAutomationError("automation_lease_missing");
  let recipient: AutomationRecipient;
  try {
    recipient = await resolvePipelineAutomationRecipient(
      env, invocation.tenant_id, invocation.recipient_ref,
    );
  } catch (error) {
    return await finalizeAutomationInvocation(env, outbox, invocation, leaseRef, {
      outcome: "failed",
      resultCode: automationErrorCode(error),
    }, nowIso);
  }
  const digestSet = await env.DB.prepare(
    `UPDATE pipeline_stage_automation_invocations
        SET recipient_digest = ?, updated_at = ?
      WHERE tenant_id = ? AND invocation_id = ? AND status = 'claimed' AND lease_ref = ?
        AND recipient_digest IS NULL`,
  ).bind(recipient.digest, nowIso, invocation.tenant_id, invocation.invocation_id, leaseRef).run();
  const leasedOutbox = await getOutbox(env, outbox.tenant_id, outbox.outbox_id);
  const leasedInvocation = await getInvocation(env, invocation.tenant_id, invocation.invocation_id);
  if (Number(digestSet.meta?.changes ?? 0) < 1 &&
      (!leasedInvocation || leasedInvocation.status !== "claimed" || leasedInvocation.lease_ref !== leaseRef))
    throw new PipelineAutomationError("automation_lease_lost");
  if (!leasedInvocation || leasedInvocation.status !== "claimed" || leasedInvocation.lease_ref !== leaseRef ||
      !leasedOutbox || leasedOutbox.status !== "claimed" || leasedOutbox.lease_ref !== leaseRef)
    throw new PipelineAutomationError("automation_lease_lost");
  if (leasedInvocation.recipient_digest !== recipient.digest) {
    return await finalizeAutomationInvocation(env, outbox, leasedInvocation, leaseRef, {
      outcome: "failed",
      resultCode: leasedInvocation.recipient_digest
        ? "automation_recipient_digest_changed"
        : "automation_recipient_digest_missing",
    }, nowIso, true);
  }
  const context = await getDeliveryContext(env, outbox);
  if (!context) {
    return await finalizeAutomationInvocation(env, outbox, leasedInvocation, leaseRef, {
      outcome: "failed",
      resultCode: "automation_transition_context_missing",
    }, nowIso);
  }
  const prepared = await prepareAutomationDelivery(
    env, leasedInvocation, context, documentGenerator, nowIso,
  );
  if ("failure" in prepared) {
    return await finalizeAutomationInvocation(env, outbox, leasedInvocation, leaseRef, {
      outcome: prepared.failure.outcome,
      resultCode: prepared.failure.resultCode,
    }, nowIso, prepared.failure.terminal);
  }
  const rendered = prepared.rendered;
  const idempotencyKey = pipelineAutomationEffectKey(leasedInvocation.invocation_id);
  let result: AutomationSendResult;
  try {
    result = await sender({
      tenantId: leasedInvocation.tenant_id,
      invocationId: leasedInvocation.invocation_id,
      idempotencyKey,
      recipient,
      subject: rendered.subject,
      html: rendered.html,
      pipelineId: outbox.pipeline_id,
      transitionId: outbox.transition_id,
      now: nowIso,
    });
  } catch (error) {
    result = { outcome: "unknown", resultCode: automationErrorCode(error) };
  }
  return await finalizeAutomationInvocation(env, outbox, leasedInvocation, leaseRef, result, nowIso);
}

async function getDeliveryContext(env: AppEnv, outbox: OutboxRow): Promise<DeliveryContext | null> {
  return await env.DB.prepare(
    `SELECT p.name AS pipeline_name, c.card_id, c.entity_type, c.entity_id,
            fs.name AS from_stage_name, ts.name AS to_stage_name,
            t.occurred_at, t.reason_code
       FROM pipeline_stage_automation_outbox o
       JOIN pipelines p ON p.tenant_id = o.tenant_id AND p.pipeline_id = o.pipeline_id
       JOIN pipeline_cards c ON c.tenant_id = o.tenant_id AND c.pipeline_id = o.pipeline_id
        AND c.card_id = o.card_id
       JOIN pipeline_card_transitions t ON t.tenant_id = o.tenant_id
        AND t.pipeline_id = o.pipeline_id AND t.transition_id = o.transition_id
       JOIN pipeline_stages ts ON ts.tenant_id = o.tenant_id AND ts.pipeline_id = o.pipeline_id
        AND ts.stage_id = o.to_stage_id
       LEFT JOIN pipeline_stages fs ON fs.tenant_id = o.tenant_id AND fs.pipeline_id = o.pipeline_id
        AND fs.stage_id = o.from_stage_id
      WHERE o.tenant_id = ? AND o.outbox_id = ? LIMIT 1`,
  ).bind(outbox.tenant_id, outbox.outbox_id).first<DeliveryContext>();
}

export interface PreparedDelivery {
  rendered: { subject: string; html: string };
}

export interface DeliveryFailure {
  failure: {
    outcome: "failed" | "unknown";
    resultCode: string;
    /** Provider ambiguity is terminal automation work; it is never redispatched. */
    terminal: boolean;
  };
}

/**
 * Turn a claimed invocation into the bytes that will be delivered.
 *
 * The action decides HOW the payload is produced, never WHAT is in it: the built-in action renders
 * the stage-change summary, and the document action asks the generation domain for the document its
 * rule names. A generation that does not settle successfully stops here - the transition is already
 * committed and stays committed; only the automation is recorded as failed.
 */
export async function prepareAutomationDelivery(
  env: AppEnv,
  invocation: InvocationRow,
  context: DeliveryContext,
  documentGenerator: PipelineAutomationDocumentGenerator,
  nowIso: string,
): Promise<PreparedDelivery | DeliveryFailure> {
  const action = registeredAction(invocation.action);
  if (!action)
    return { failure: { outcome: "failed", resultCode: "automation_action_unregistered", terminal: true } };
  if (action === PIPELINE_AUTOMATION_ACTION) return { rendered: renderStageChangeSummary(context) };

  if (!documentGenerationConfigured(env))
    return { failure: { outcome: "failed", resultCode: "automation_document_generation_unavailable", terminal: false } };
  const permit = automationDocumentPermit(invocation, context);
  if (Date.parse(nowIso) + DOCUMENT_EFFECT_DEADLINE_MS > Date.parse(permit.expiresAt))
    return { failure: { outcome: "failed", resultCode: "automation_document_permit_expired", terminal: true } };

  let document: AutomationDocumentResult;
  try {
    document = await documentGenerator({
      tenantId: invocation.tenant_id,
      entityType: context.entity_type,
      entityId: context.entity_id,
      templateId: invocation.template_key,
      serviceAuthority: permit,
      idempotencyKey: automationDocumentIdempotencyKey(invocation.invocation_id),
      now: nowIso,
    });
  } catch (error) {
    return { failure: { outcome: "failed", resultCode: automationErrorCode(error), terminal: false } };
  }
  if (document.outcome !== "succeeded")
    return {
      failure: {
        outcome: document.outcome === "unknown" || document.outcome === "manual_exception" ? "unknown" : "failed",
        resultCode: document.resultCode ?? `automation_document_${document.outcome}`,
        terminal: document.outcome === "unknown" || document.outcome === "manual_exception",
      },
    };
  return { rendered: renderDocumentDelivery(context, document) };
}

function registeredAction(value: string): PipelineAutomationAction | null {
  return PIPELINE_AUTOMATION_REGISTRY.find((entry) => entry.action === value)?.action ?? null;
}

/**
 * An automation is not a person, so it does not borrow the owner's route or the owner's role.
 *
 * It presents a scoped service permit instead: one tenant, one entity, one template, one action,
 * one attempt, an explicit expiry, and a `worker`/`ops` identity that is never a signed-in user.
 * Every field is derived from the durable invocation, so a redelivery mints the SAME permit and
 * replays the same generation attempt rather than authorising a second one.
 */
export function automationDocumentPermit(
  invocation: Pick<InvocationRow, "invocation_id" | "tenant_id" | "template_key" | "created_at">,
  context: Pick<DeliveryContext, "entity_type" | "entity_id">,
): DocumentGenerationServiceAuthority {
  return {
    kind: "service",
    permitRef: `permit:pipeline-automation:${invocation.invocation_id}`,
    policyRef: DOCUMENT_POLICY_REF,
    policyVersion: DOCUMENT_POLICY_VERSION,
    tenantId: invocation.tenant_id,
    entityType: context.entity_type,
    entityId: context.entity_id,
    templateId: invocation.template_key,
    action: "document.generate",
    expiresAt: new Date(Date.parse(invocation.created_at) + DOCUMENT_PERMIT_TTL_MS).toISOString(),
    maxAttempts: 1,
    stopPolicy: "stop_on_unknown",
    compensationPolicy: "none",
    actor: {
      type: "worker",
      role: "ops",
      userId: DOCUMENT_ACTOR_ID,
      authorityRef: DOCUMENT_ACTOR_AUTHORITY_REF,
    },
  };
}

export function automationDocumentIdempotencyKey(invocationId: string): string {
  return `pipeline-automation-document:${invocationId}`;
}

function defaultAutomationDocumentGenerator(env: AppEnv): PipelineAutomationDocumentGenerator {
  return async (request) => {
    const result = await generateDocumentToR2(env, {
      tenantId: request.tenantId,
      entityType: request.entityType,
      entityId: request.entityId,
      templateId: request.templateId,
      serviceAuthority: request.serviceAuthority,
      idempotencyKey: request.idempotencyKey,
    }, new Date(request.now));
    const revision = await getDocumentTemplateRevision(
      env, request.tenantId, request.templateId, result.receipt.template_revision_id,
    );
    return {
      outcome: result.outcome,
      label: revision?.label ?? "Document",
      body: result.document.body,
      outputDigest: result.document.outputDigest,
      providerDocumentId: result.document.providerDocumentId,
      receiptId: result.receipt.receipt_id,
      templateRevisionId: result.receipt.template_revision_id,
      templateVersion: result.receipt.template_version,
    };
  };
}

/**
 * The delivered email carries the document itself, not a claim that one exists: the body is the
 * exact rendered output the receipt attests, followed by the evidence a reader needs to match the
 * mail against the immutable receipt.
 */
export function renderDocumentDelivery(
  context: DeliveryContext,
  document: AutomationDocumentResult,
): { subject: string; html: string } {
  const pipeline = escapeHtml(context.pipeline_name);
  const from = escapeHtml(context.from_stage_name ?? "New");
  const to = escapeHtml(context.to_stage_name);
  const entity = escapeHtml(`${context.entity_type}:${context.entity_id}`);
  const subject = safeHeader(`${document.label}: ${context.pipeline_name} - ${context.to_stage_name}`);
  const html = `<p>Pipeline <strong>${pipeline}</strong> moved <strong>${from}</strong> &rarr; ` +
    `<strong>${to}</strong> for <strong>${entity}</strong>, and generated the document below.</p>` +
    `<hr>${document.body}<hr>` +
    `<p>Document: <strong>${escapeHtml(document.label)}</strong><br>` +
    `Receipt: ${escapeHtml(document.receiptId)}<br>` +
    `Template revision: ${escapeHtml(document.templateRevisionId)} v${document.templateVersion}<br>` +
    `Stored object: ${escapeHtml(document.providerDocumentId ?? "none")}<br>` +
    `Output digest: ${escapeHtml(document.outputDigest)}</p>`;
  return { subject, html };
}

export function renderStageChangeSummary(context: DeliveryContext): { subject: string; html: string } {
  const pipeline = escapeHtml(context.pipeline_name);
  const from = escapeHtml(context.from_stage_name ?? "New");
  const to = escapeHtml(context.to_stage_name);
  const card = escapeHtml(context.card_id);
  const entity = escapeHtml(`${context.entity_type}:${context.entity_id}`);
  const occurred = escapeHtml(context.occurred_at);
  const reason = context.reason_code ? `<p>Reason: <strong>${escapeHtml(context.reason_code)}</strong></p>` : "";
  const subject = safeHeader(`Stage change: ${context.pipeline_name} - ${context.to_stage_name}`);
  const html = `<p>Pipeline <strong>${pipeline}</strong> recorded a governed stage change.</p>` +
    `<p><strong>${from}</strong> &rarr; <strong>${to}</strong></p>` +
    `<p>Card: <strong>${card}</strong><br>Entity: <strong>${entity}</strong><br>Occurred: ${occurred}</p>` +
    reason;
  return { subject, html };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180) || "Stage change";
}

async function finalizeAutomationInvocation(
  env: AppEnv,
  outbox: OutboxRow,
  invocation: InvocationRow,
  leaseRef: string,
  result: AutomationSendResult,
  nowIso: string,
  forceTerminal = false,
): Promise<AutomationSendResult["outcome"]> {
  const retryExhausted = result.outcome === "retry" && invocation.attempt_count >= PIPELINE_AUTOMATION_RETRY_LIMIT;
  const terminal = forceTerminal || result.outcome === "succeeded" || result.outcome === "unknown" ||
    ((result.outcome === "failed" || result.outcome === "retry") &&
      invocation.attempt_count >= PIPELINE_AUTOMATION_RETRY_LIMIT);
  const invocationStatus: AutomationSendResult["outcome"] = result.outcome === "succeeded"
    ? "succeeded"
    : result.outcome === "unknown"
      ? "unknown"
      : terminal
        ? "failed"
        : "retry";
  const outboxStatus = invocationStatus === "succeeded" ? "done" : invocationStatus === "retry" ? "pending" : "failed";
  const terminalCode = retryExhausted
    ? "automation_retry_exhausted"
    : result.resultCode ?? (
    invocationStatus === "succeeded" ? "delivered" : invocationStatus === "retry" ? "provider_retryable" : invocationStatus
  );
  const completedAt = invocationStatus === "retry" ? null : nowIso;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE pipeline_stage_automation_invocations
          SET status = ?, lease_ref = NULL, lease_expires_at = NULL,
              effect_id = COALESCE(?, effect_id), effect_state = COALESCE(?, effect_state),
              provider_external_id = COALESCE(?, provider_external_id),
              provider_response_hash = COALESCE(?, provider_response_hash),
              readback_hash = COALESCE(?, readback_hash), result_code = ?,
              updated_at = ?, completed_at = ?
        WHERE tenant_id = ? AND invocation_id = ? AND status = 'claimed' AND lease_ref = ?`,
    ).bind(
      invocationStatus,
      result.effectId ?? null,
      result.effectState ?? null,
      result.providerExternalId ?? null,
      result.providerResponseHash ?? null,
      result.readbackHash ?? null,
      terminalCode,
      nowIso,
      completedAt,
      invocation.tenant_id,
      invocation.invocation_id,
      leaseRef,
    ),
    env.DB.prepare(
      `UPDATE pipeline_stage_automation_outbox
          SET status = ?, lease_ref = NULL, lease_expires_at = NULL, terminal_code = ?, updated_at = ?
        WHERE tenant_id = ? AND outbox_id = ? AND status = 'claimed' AND lease_ref = ?`,
    ).bind(outboxStatus, terminalCode, nowIso, outbox.tenant_id, outbox.outbox_id, leaseRef),
  ]);
  if (Number((results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1 ||
      Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1)
    throw new PipelineAutomationError("automation_lease_lost");
  return invocationStatus;
}

export async function recoverPipelineAutomationLeases(
  env: AppEnv,
  now = new Date().toISOString(),
  limit = PIPELINE_AUTOMATION_DEFAULT_LIMIT,
): Promise<PipelineAutomationLeaseRecoveryReport> {
  const bounded = boundedLimit(limit);
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_stage_automation_invocations
      WHERE tenant_id = ? AND status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC, invocation_id ASC LIMIT ?`,
  ).bind(automationTenantId(env), now, bounded).all<InvocationRow>();
  const report: PipelineAutomationLeaseRecoveryReport = {
    scanned: rows.results.length,
    recovered: 0,
    retried: 0,
    unknown: 0,
    failed: 0,
    failures: [],
  };
  for (const invocation of rows.results) {
    try {
      const outbox = await getOutbox(env, invocation.tenant_id, invocation.outbox_id);
      if (!outbox || !invocation.lease_ref) throw new PipelineAutomationError("automation_lease_missing");
      const evidence = invocation.effect_id
        ? await env.DB.prepare(
          `SELECT effect_id, state, provider_external_id, provider_response_hash, readback_hash, result_code
             FROM external_effects WHERE tenant_id = ? AND effect_id = ? LIMIT 1`,
        ).bind(invocation.tenant_id, invocation.effect_id).first<{
          effect_id: string; state: string; provider_external_id: string | null;
          provider_response_hash: string | null; readback_hash: string | null; result_code: string | null;
        }>()
        : null;
      if (evidence?.state === "succeeded") {
        await finalizeAutomationInvocation(env, outbox, invocation, invocation.lease_ref, {
          outcome: "succeeded",
          effectId: evidence.effect_id,
          effectState: evidence.state,
          providerExternalId: evidence.provider_external_id,
          providerResponseHash: evidence.provider_response_hash,
          readbackHash: evidence.readback_hash,
          resultCode: "recovered_effect_success",
        }, now);
        report.recovered += 1;
        continue;
      }
      if (!evidence || evidence.state === "authorized" || evidence.state === "retry" || evidence.state === "failed") {
        if (invocation.attempt_count >= PIPELINE_AUTOMATION_RETRY_LIMIT) {
          await finalizeAutomationInvocation(env, outbox, invocation, invocation.lease_ref, {
            outcome: "failed",
            effectId: evidence?.effect_id,
            effectState: evidence?.state,
            providerExternalId: evidence?.provider_external_id,
            providerResponseHash: evidence?.provider_response_hash,
            readbackHash: evidence?.readback_hash,
            resultCode: evidence?.result_code ?? "automation_lease_expired",
          }, now);
          report.recovered += 1;
          report.failed += 1;
          continue;
        }
        const results = await env.DB.batch([
          env.DB.prepare(
            `UPDATE pipeline_stage_automation_invocations
                SET status = 'retry', lease_ref = NULL, lease_expires_at = NULL,
                    result_code = 'automation_lease_expired', updated_at = ?
              WHERE tenant_id = ? AND invocation_id = ? AND status = 'claimed' AND lease_ref = ?`,
          ).bind(now, invocation.tenant_id, invocation.invocation_id, invocation.lease_ref),
          env.DB.prepare(
            `UPDATE pipeline_stage_automation_outbox
                SET status = 'pending', lease_ref = NULL, lease_expires_at = NULL,
                    terminal_code = 'automation_lease_expired', updated_at = ?
              WHERE tenant_id = ? AND outbox_id = ? AND status = 'claimed' AND lease_ref = ?`,
          ).bind(now, invocation.tenant_id, invocation.outbox_id, invocation.lease_ref),
        ]);
        if (Number((results[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1 ||
            Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1)
          throw new PipelineAutomationError("automation_lease_lost");
        report.recovered += 1;
        report.retried += 1;
        continue;
      }
      // An executing/reconciling/unknown/manual-exception effect has provider ambiguity. It is
      // terminal automation work until the effect ledger is reconciled; never redispatch it.
      await finalizeAutomationInvocation(env, outbox, invocation, invocation.lease_ref, {
        outcome: "unknown",
        effectId: evidence?.effect_id ?? invocation.effect_id,
        effectState: evidence?.state ?? "unknown",
        providerExternalId: evidence?.provider_external_id,
        providerResponseHash: evidence?.provider_response_hash,
        readbackHash: evidence?.readback_hash,
        resultCode: evidence?.result_code ?? "automation_provider_uncertain",
      }, now);
      report.recovered += 1;
      report.unknown += 1;
    } catch (error) {
      report.failed += 1;
      if (report.failures.length < MAX_FAILURES_IN_REPORT)
        report.failures.push({ invocation_id: invocation.invocation_id, error: automationErrorCode(error) });
    }
  }
  return report;
}

async function getOutbox(env: AppEnv, tenantId: string, outboxId: string): Promise<OutboxRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_stage_automation_outbox WHERE tenant_id = ? AND outbox_id = ? LIMIT 1`,
  ).bind(tenantId, outboxId).first<OutboxRow>();
}

async function getInvocation(env: AppEnv, tenantId: string, invocationId: string): Promise<InvocationRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_stage_automation_invocations WHERE tenant_id = ? AND invocation_id = ? LIMIT 1`,
  ).bind(tenantId, invocationId).first<InvocationRow>();
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return PIPELINE_AUTOMATION_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.floor(value), PIPELINE_AUTOMATION_MAX_LIMIT));
}

function automationTenantId(env: AppEnv): string {
  return env.APP_TENANT_ID ?? "ironwrap";
}

function automationErrorCode(error: unknown): string {
  if (error instanceof PipelineAutomationError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string")
    return (error as { code: string }).code;
  return "automation_provider_error";
}
