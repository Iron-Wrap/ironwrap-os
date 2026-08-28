/**
 * Tenant-administered automation recipients (ELEC-204).
 *
 * A stage-change automation delivers to a REFERENCE - `shop`, `accounting`, `owner` - and never to
 * an address a rule author typed. That property is the whole reason the rule builder refuses free
 * text, and it is preserved here exactly. What changes is where the reference resolves FROM.
 *
 * It used to resolve from `PIPELINE_AUTOMATION_RECIPIENTS_JSON`, a deploy secret. An administrator
 * could pick from whatever an engineer had pre-populated and could not add a destination at all;
 * "add the shop" meant rotating a secret and redeploying. This module makes the catalog tenant
 * data with the same governance every other administered aggregate here already has: a
 * CAS-protected head over append-only revisions carrying actor attribution, so a changed
 * destination is answerable after the fact.
 *
 * Two properties are load-bearing and are asserted by the suite:
 *
 *   - a destination exists ONLY in `automation_recipient_revisions`. It is never written to a rule
 *     row or an invocation row, and it never leaves this Worker in an API response - readers get a
 *     digest and a masked form;
 *   - a tenant that administers its own catalog is never silently overridden by the deployment
 *     blob. The env fallback applies to one case only: a tenant with no recipient record at all.
 *
 * Nothing here names a vertical. "The shop" is a row an administrator writes.
 */

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";

/**
 * The closed transport registry. It is closed in CODE rather than by a column CHECK on purpose:
 * 0127 had to rebuild two tables to widen such a CHECK, and registering an SMS transport should
 * cost an adapter and an entry here, not a migration that rewrites the catalog.
 */
export const AUTOMATION_RECIPIENT_CHANNELS = ["email"] as const;
export type AutomationRecipientChannel = (typeof AUTOMATION_RECIPIENT_CHANNELS)[number];

export const AUTOMATION_RECIPIENT_ACTIONS = ["create", "revise", "retire"] as const;
export type AutomationRecipientAction = (typeof AUTOMATION_RECIPIENT_ACTIONS)[number];

export const RECIPIENT_REF_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

const COMMAND_SCHEMA = "ironwrap.automation-recipient.v1";
const MAX_LABEL = 160;
const MAX_DESTINATION = 320;
const MAX_RECIPIENTS_PER_TENANT = 200;

export class AutomationRecipientsError extends Error {
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: string, detail: Readonly<Record<string, unknown>> = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
    this.name = "AutomationRecipientsError";
  }
}

export interface AutomationRecipientActor {
  role: string;
  userId: string;
}

export interface AutomationRecipientRecord {
  recipient_id: string;
  tenant_id: string;
  recipient_ref: string;
  revision_id: string;
  version: number;
  prior_revision_id: string | null;
  action: AutomationRecipientAction;
  label: string;
  channel: AutomationRecipientChannel;
  /**
   * Present on rows read straight out of D1 and consumed by the dispatcher. It is stripped by
   * `automationRecipientView` before anything reaches an HTTP response.
   */
  destination: string;
  destination_digest: string;
  active: number;
  actor_role: string;
  actor_id: string;
  command_fingerprint: string;
  idempotency_key_hash: string;
  created_at: string;
}

export interface AutomationRecipientInput {
  tenantId: string;
  recipientId?: string;
  recipientRef?: unknown;
  label?: unknown;
  channel?: unknown;
  destination?: unknown;
  expectedVersion?: unknown;
  actor: AutomationRecipientActor;
  idempotencyKey: string;
}

export interface AutomationRecipientMutation {
  kind: "created" | "replayed";
  recipient: AutomationRecipientRecord;
}

/** What the dispatcher needs, and nothing more. */
export interface ResolvedAutomationRecipient {
  ref: string;
  label: string;
  channel: AutomationRecipientChannel;
  address: string;
  digest: string;
}

/* --------------------------------------------------------------------------- validation --- */

export function validateRecipientRefValue(value: unknown): string {
  if (typeof value !== "string" || !RECIPIENT_REF_PATTERN.test(value.trim()))
    throw new AutomationRecipientsError("automation_recipient_ref_invalid");
  return value.trim();
}

export function validateRecipientLabel(value: unknown): string {
  if (typeof value !== "string") throw new AutomationRecipientsError("automation_recipient_label_invalid");
  const label = value.trim();
  if (label.length < 1 || label.length > MAX_LABEL || /\p{Cc}/u.test(label))
    throw new AutomationRecipientsError("automation_recipient_label_invalid");
  return label;
}

export function validateRecipientChannel(value: unknown): AutomationRecipientChannel {
  const channel = AUTOMATION_RECIPIENT_CHANNELS.find((candidate) => candidate === value);
  if (!channel)
    throw new AutomationRecipientsError("automation_recipient_channel_invalid", {
      channels: [...AUTOMATION_RECIPIENT_CHANNELS],
    });
  return channel;
}

/**
 * Server-side destination validation.
 *
 * A tenant administrator typing a destination is attack surface that did not exist when only an
 * engineer with deploy access could add one, so the parse is deliberately narrow rather than
 * permissive: one ASCII address, no display name, no angle brackets, no comma or semicolon list,
 * no whitespace, no control character - which is what forecloses header injection into the mail
 * the effect runtime later builds - and no non-ASCII, so a homoglyph domain cannot be written to
 * look like the tenant's own.
 *
 * What this does NOT attempt, on purpose: deliverability. No MX lookup, no probe, no
 * disposable-domain list. Those need a live provider call, which this rail does not make.
 */
export function validateRecipientDestination(
  channel: AutomationRecipientChannel,
  value: unknown,
): string {
  if (typeof value !== "string") throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  const raw = value.trim();
  if (raw.length < 3 || raw.length > MAX_DESTINATION)
    throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  // Printable ASCII only, and no whitespace anywhere inside it.
  if (!/^[\x21-\x7e]+$/.test(raw))
    throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  if (channel !== "email")
    throw new AutomationRecipientsError("automation_recipient_channel_invalid");

  const address = raw.toLowerCase();
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@") || at === address.length - 1)
    throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !/^[a-z0-9._%+-]+$/.test(local) ||
      local.startsWith(".") || local.endsWith(".") || local.includes(".."))
    throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  if (domain.length < 4 || domain.length > 255)
    throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  const labels = domain.split(".");
  if (labels.length < 2)
    throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  for (const label of labels)
    if (label.length < 1 || label.length > 63 || !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") || label.endsWith("-"))
      throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  if (!/^[a-z]{2,24}$/.test(labels[labels.length - 1] ?? ""))
    throw new AutomationRecipientsError("automation_recipient_destination_invalid");
  return address;
}

/**
 * What an administration screen may see: enough to recognise the destination they configured,
 * never enough to harvest it. The star run is fixed-length so the masked form does not leak how
 * long the local part is.
 */
export function maskDestination(channel: AutomationRecipientChannel, destination: string): string {
  if (channel !== "email") return "***";
  const at = destination.indexOf("@");
  if (at < 1) return "***";
  return `${destination.slice(0, 1)}***${destination.slice(at)}`;
}

function validateActor(actor: AutomationRecipientActor): AutomationRecipientActor {
  if (!actor || typeof actor.userId !== "string" || actor.userId.trim().length < 1 ||
      actor.userId.length > 160)
    throw new AutomationRecipientsError("automation_recipient_actor_invalid");
  if (typeof actor.role !== "string" || actor.role.trim().length < 2 || actor.role.length > 40)
    throw new AutomationRecipientsError("automation_recipient_actor_invalid");
  return { role: actor.role.trim(), userId: actor.userId.trim() };
}

function validateTenant(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9-]{2,64}$/.test(value))
    throw new AutomationRecipientsError("automation_recipient_tenant_invalid");
  return value;
}

function validNow(now: Date): string {
  const value = now.toISOString();
  if (!Number.isFinite(Date.parse(value)))
    throw new AutomationRecipientsError("automation_recipient_time_invalid");
  return value;
}

/* ------------------------------------------------------------------------------- writes --- */

export async function createAutomationRecipient(
  env: AppEnv,
  input: AutomationRecipientInput,
  now = new Date(),
): Promise<AutomationRecipientMutation> {
  const tenantId = validateTenant(input.tenantId);
  const actor = validateActor(input.actor);
  const recipientRef = validateRecipientRefValue(input.recipientRef);
  const label = validateRecipientLabel(input.label);
  const channel = validateRecipientChannel(input.channel);
  const destination = validateRecipientDestination(channel, input.destination);
  const createdAt = validNow(now);
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey);

  const replay = await recipientByIdempotency(env, tenantId, idempotencyKeyHash);
  if (replay) return { kind: "replayed", recipient: replay };

  const recipientId = await stableRecipientId(tenantId, recipientRef);
  const existing = await getAutomationRecipient(env, tenantId, recipientId);
  if (existing) throw new AutomationRecipientsError("automation_recipient_exists", { recipient_id: recipientId });
  if (await recipientCount(env, tenantId) >= MAX_RECIPIENTS_PER_TENANT)
    throw new AutomationRecipientsError("automation_recipient_limit_reached", {
      limit: MAX_RECIPIENTS_PER_TENANT,
    });

  const revisionId = await stableRevisionId(recipientId, 1);
  const commandFingerprint = await sha256Hex(canonicalJson({
    schema_version: COMMAND_SCHEMA,
    tenant_id: tenantId,
    recipient_id: recipientId,
    recipient_ref: recipientRef,
    action: "create",
    label,
    channel,
    destination_digest: await sha256Hex(destination),
    active: true,
    version: 1,
  }));
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO automation_recipient_heads (
           recipient_id, tenant_id, recipient_ref, current_revision_id, current_version,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, 0, ?, ?, ?)`,
      ).bind(recipientId, tenantId, recipientRef, actor.userId, createdAt, createdAt),
      revisionStatement(env, {
        tenantId, recipientId, recipientRef, revisionId, version: 1, priorRevisionId: null,
        action: "create", label, channel, destination, active: true, actor,
        commandFingerprint, idempotencyKeyHash, createdAt,
      }, await sha256Hex(destination)),
      env.DB.prepare(
        `UPDATE automation_recipient_heads
            SET current_revision_id = ?, current_version = 1, updated_at = ?
          WHERE tenant_id = ? AND recipient_id = ? AND current_version = 0
            AND current_revision_id IS NULL`,
      ).bind(revisionId, createdAt, tenantId, recipientId),
    ]);
  } catch (error) {
    const concurrent = await recipientByIdempotency(env, tenantId, idempotencyKeyHash);
    if (concurrent) return { kind: "replayed", recipient: concurrent };
    if (error instanceof AutomationRecipientsError) throw error;
    if (await getAutomationRecipient(env, tenantId, recipientId))
      throw new AutomationRecipientsError("automation_recipient_exists", { recipient_id: recipientId });
    throw new AutomationRecipientsError("automation_recipient_write_failed");
  }
  const created = await getAutomationRecipient(env, tenantId, recipientId);
  if (!created) throw new AutomationRecipientsError("automation_recipient_write_failed");
  return { kind: "created", recipient: created };
}

/**
 * Re-point or re-label an existing recipient, or bring a retired one back.
 *
 * The reference is NOT revisable. A rule is bound to `shop`; letting an administrator rename the
 * record would silently re-aim every rule that names it, which is exactly the class of change this
 * aggregate exists to make visible.
 */
export async function reviseAutomationRecipient(
  env: AppEnv,
  input: AutomationRecipientInput,
  now = new Date(),
): Promise<AutomationRecipientMutation> {
  const tenantId = validateTenant(input.tenantId);
  const actor = validateActor(input.actor);
  const recipientId = boundedRecipientId(input.recipientId);
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey);
  const replay = await recipientByIdempotency(env, tenantId, idempotencyKeyHash);
  if (replay) return { kind: "replayed", recipient: replay };

  const current = await getAutomationRecipient(env, tenantId, recipientId);
  if (!current) throw new AutomationRecipientsError("automation_recipient_not_found");
  if (input.recipientRef !== undefined && input.recipientRef !== null &&
      validateRecipientRefValue(input.recipientRef) !== current.recipient_ref)
    throw new AutomationRecipientsError("automation_recipient_ref_immutable", {
      recipient_ref: current.recipient_ref,
    });
  const expectedVersion = integer(input.expectedVersion, "automation_recipient_version_invalid");
  if (expectedVersion !== current.version)
    throw new AutomationRecipientsError("automation_recipient_version_conflict", {
      expected_version: expectedVersion,
      current_version: current.version,
    });

  const label = input.label === undefined || input.label === null
    ? current.label
    : validateRecipientLabel(input.label);
  const channel = input.channel === undefined || input.channel === null
    ? validateRecipientChannel(current.channel)
    : validateRecipientChannel(input.channel);
  const destination = input.destination === undefined || input.destination === null
    ? validateRecipientDestination(channel, current.destination)
    : validateRecipientDestination(channel, input.destination);
  return await appendRevision(env, {
    tenantId, current, action: "revise", label, channel, destination, active: true, actor,
    idempotencyKeyHash, now,
  });
}

/**
 * Retire a recipient - refused while a live rule still names it.
 *
 * The alternative (retire anyway and let the rule break at dispatch) turns an administrator's
 * configuration change into a silent delivery failure discovered by whoever did not get the email.
 * This refuses up front and names the rules, so the administrator repoints or deactivates them
 * first and the break is never silent. AC7.
 */
export async function retireAutomationRecipient(
  env: AppEnv,
  input: Omit<AutomationRecipientInput, "label" | "channel" | "destination" | "recipientRef">,
  now = new Date(),
): Promise<AutomationRecipientMutation> {
  const tenantId = validateTenant(input.tenantId);
  const actor = validateActor(input.actor);
  const recipientId = boundedRecipientId(input.recipientId);
  const idempotencyKeyHash = await hashIdempotency(input.idempotencyKey);
  const replay = await recipientByIdempotency(env, tenantId, idempotencyKeyHash);
  if (replay) return { kind: "replayed", recipient: replay };

  const current = await getAutomationRecipient(env, tenantId, recipientId);
  if (!current) throw new AutomationRecipientsError("automation_recipient_not_found");
  const expectedVersion = integer(input.expectedVersion, "automation_recipient_version_invalid");
  if (expectedVersion !== current.version)
    throw new AutomationRecipientsError("automation_recipient_version_conflict", {
      expected_version: expectedVersion,
      current_version: current.version,
    });
  if (current.active !== 1) throw new AutomationRecipientsError("automation_recipient_already_retired");

  const references = await automationRecipientReferences(env, tenantId, current.recipient_ref);
  if (references.length > 0)
    throw new AutomationRecipientsError("automation_recipient_in_use", {
      recipient_ref: current.recipient_ref,
      rules: references,
    });

  return await appendRevision(env, {
    tenantId,
    current,
    action: "retire",
    label: current.label,
    channel: validateRecipientChannel(current.channel),
    destination: current.destination,
    active: false,
    actor,
    idempotencyKeyHash,
    now,
  });
}

async function appendRevision(
  env: AppEnv,
  input: {
    tenantId: string;
    current: AutomationRecipientRecord;
    action: AutomationRecipientAction;
    label: string;
    channel: AutomationRecipientChannel;
    destination: string;
    active: boolean;
    actor: AutomationRecipientActor;
    idempotencyKeyHash: string;
    now: Date;
  },
): Promise<AutomationRecipientMutation> {
  const { tenantId, current } = input;
  const version = current.version + 1;
  const createdAt = validNow(input.now);
  const revisionId = await stableRevisionId(current.recipient_id, version);
  const destinationDigest = await sha256Hex(input.destination);
  const commandFingerprint = await sha256Hex(canonicalJson({
    schema_version: COMMAND_SCHEMA,
    tenant_id: tenantId,
    recipient_id: current.recipient_id,
    recipient_ref: current.recipient_ref,
    action: input.action,
    label: input.label,
    channel: input.channel,
    destination_digest: destinationDigest,
    active: input.active,
    version,
  }));
  try {
    const results = await env.DB.batch([
      revisionStatement(env, {
        tenantId,
        recipientId: current.recipient_id,
        recipientRef: current.recipient_ref,
        revisionId,
        version,
        priorRevisionId: current.revision_id,
        action: input.action,
        label: input.label,
        channel: input.channel,
        destination: input.destination,
        active: input.active,
        actor: input.actor,
        commandFingerprint,
        idempotencyKeyHash: input.idempotencyKeyHash,
        createdAt,
      }, destinationDigest),
      env.DB.prepare(
        `UPDATE automation_recipient_heads
            SET current_revision_id = ?, current_version = ?, updated_at = ?
          WHERE tenant_id = ? AND recipient_id = ? AND current_version = ?
            AND current_revision_id IS ?`,
      ).bind(revisionId, version, createdAt, tenantId, current.recipient_id, current.version,
        current.revision_id),
    ]);
    if (Number((results[1] as { meta?: { changes?: number } })?.meta?.changes ?? 0) < 1)
      throw new AutomationRecipientsError("automation_recipient_version_conflict", {
        current_version: current.version,
      });
  } catch (error) {
    const concurrent = await recipientByIdempotency(env, tenantId, input.idempotencyKeyHash);
    if (concurrent) return { kind: "replayed", recipient: concurrent };
    if (error instanceof AutomationRecipientsError) throw error;
    throw new AutomationRecipientsError("automation_recipient_version_conflict", {
      current_version: (await getAutomationRecipient(env, tenantId, current.recipient_id))?.version,
    });
  }
  const revised = await getAutomationRecipient(env, tenantId, current.recipient_id);
  if (!revised) throw new AutomationRecipientsError("automation_recipient_write_failed");
  return { kind: "created", recipient: revised };
}

function revisionStatement(
  env: AppEnv,
  input: {
    tenantId: string;
    recipientId: string;
    recipientRef: string;
    revisionId: string;
    version: number;
    priorRevisionId: string | null;
    action: AutomationRecipientAction;
    label: string;
    channel: AutomationRecipientChannel;
    destination: string;
    active: boolean;
    actor: AutomationRecipientActor;
    commandFingerprint: string;
    idempotencyKeyHash: string;
    createdAt: string;
  },
  destinationDigest: string,
) {
  return env.DB.prepare(
    `INSERT INTO automation_recipient_revisions (
       revision_id, tenant_id, recipient_id, version, prior_revision_id, recipient_ref, action,
       label, channel, destination, destination_digest, active, actor_role, actor_id,
       command_fingerprint, idempotency_key_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    input.revisionId,
    input.tenantId,
    input.recipientId,
    input.version,
    input.priorRevisionId,
    input.recipientRef,
    input.action,
    input.label,
    input.channel,
    input.destination,
    destinationDigest,
    input.active ? 1 : 0,
    input.actor.role,
    input.actor.userId,
    input.commandFingerprint,
    input.idempotencyKeyHash,
    input.createdAt,
  );
}

/* -------------------------------------------------------------------------------- reads --- */

export async function getAutomationRecipient(
  env: AppEnv,
  tenantId: string,
  recipientId: string,
): Promise<AutomationRecipientRecord | null> {
  return await env.DB.prepare(
    `SELECT h.recipient_id, h.tenant_id, h.recipient_ref, r.revision_id, r.version,
            r.prior_revision_id, r.action, r.label, r.channel, r.destination, r.destination_digest,
            r.active, r.actor_role, r.actor_id, r.command_fingerprint, r.idempotency_key_hash,
            r.created_at
       FROM automation_recipient_heads h
       JOIN automation_recipient_revisions r
         ON r.tenant_id = h.tenant_id AND r.recipient_id = h.recipient_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? AND h.recipient_id = ? LIMIT 1`,
  ).bind(tenantId, recipientId).first<AutomationRecipientRecord>();
}

export async function getAutomationRecipientByRef(
  env: AppEnv,
  tenantId: string,
  recipientRef: string,
): Promise<AutomationRecipientRecord | null> {
  return await env.DB.prepare(
    `SELECT h.recipient_id, h.tenant_id, h.recipient_ref, r.revision_id, r.version,
            r.prior_revision_id, r.action, r.label, r.channel, r.destination, r.destination_digest,
            r.active, r.actor_role, r.actor_id, r.command_fingerprint, r.idempotency_key_hash,
            r.created_at
       FROM automation_recipient_heads h
       JOIN automation_recipient_revisions r
         ON r.tenant_id = h.tenant_id AND r.recipient_id = h.recipient_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ? AND h.recipient_ref = ? LIMIT 1`,
  ).bind(tenantId, recipientRef).first<AutomationRecipientRecord>();
}

export async function listAutomationRecipients(
  env: AppEnv,
  tenantId: string,
): Promise<AutomationRecipientRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT h.recipient_id, h.tenant_id, h.recipient_ref, r.revision_id, r.version,
            r.prior_revision_id, r.action, r.label, r.channel, r.destination, r.destination_digest,
            r.active, r.actor_role, r.actor_id, r.command_fingerprint, r.idempotency_key_hash,
            r.created_at
       FROM automation_recipient_heads h
       JOIN automation_recipient_revisions r
         ON r.tenant_id = h.tenant_id AND r.recipient_id = h.recipient_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
      WHERE h.tenant_id = ?
      ORDER BY h.recipient_ref ASC`,
  ).bind(tenantId).all<AutomationRecipientRecord>();
  return rows.results;
}

export async function listAutomationRecipientRevisions(
  env: AppEnv,
  tenantId: string,
  recipientId: string,
): Promise<AutomationRecipientRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT h.recipient_id, h.tenant_id, h.recipient_ref, r.revision_id, r.version,
            r.prior_revision_id, r.action, r.label, r.channel, r.destination, r.destination_digest,
            r.active, r.actor_role, r.actor_id, r.command_fingerprint, r.idempotency_key_hash,
            r.created_at
       FROM automation_recipient_heads h
       JOIN automation_recipient_revisions r
         ON r.tenant_id = h.tenant_id AND r.recipient_id = h.recipient_id
      WHERE h.tenant_id = ? AND h.recipient_id = ?
      ORDER BY r.version ASC`,
  ).bind(tenantId, recipientId).all<AutomationRecipientRecord>();
  return rows.results;
}

/**
 * Whether this tenant administers its own catalog at all.
 *
 * This is the ONE question the deployment-secret fallback turns on, and it deliberately counts
 * every record rather than only the active ones: a tenant that created a recipient and later
 * retired it has administered its catalog, and must not silently fall back to whatever an
 * engineer once put in the env blob.
 */
export async function tenantAdministersRecipients(env: AppEnv, tenantId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM automation_recipient_heads WHERE tenant_id = ? LIMIT 1`,
  ).bind(tenantId).first<{ present: number }>();
  return Boolean(row);
}

async function recipientCount(env: AppEnv, tenantId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM automation_recipient_heads WHERE tenant_id = ?`,
  ).bind(tenantId).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/**
 * Every live consumer that would break if this reference stopped resolving.
 *
 * The automation rail is currently the only one, and this read-only query is where that coupling
 * lives so a retirement stays answerable as consumers are added. It matches the same "current
 * revision, active, on a live pipeline and stage" shape the dispatcher's own binding query uses,
 * so a rule this refuses to strand is exactly a rule that would have fired.
 */
export async function automationRecipientReferences(
  env: AppEnv,
  tenantId: string,
  recipientRef: string,
): Promise<Array<{ rule_id: string; pipeline_id: string; to_stage_id: string }>> {
  const rows = await env.DB.prepare(
    `SELECT h.rule_id, h.pipeline_id, h.to_stage_id
       FROM pipeline_automation_rule_heads h
       JOIN pipeline_automation_rule_revisions r
         ON r.tenant_id = h.tenant_id AND r.rule_id = h.rule_id
        AND r.revision_id = h.current_revision_id AND r.version = h.current_version
       JOIN pipelines p ON p.tenant_id = h.tenant_id AND p.pipeline_id = h.pipeline_id
       JOIN pipeline_stages s ON s.tenant_id = h.tenant_id AND s.pipeline_id = h.pipeline_id
        AND s.stage_id = h.to_stage_id
      WHERE h.tenant_id = ? AND r.recipient_ref = ? AND r.active = 1
        AND p.is_active = 1 AND s.is_active = 1
      ORDER BY h.rule_id ASC`,
  ).bind(tenantId, recipientRef).all<{ rule_id: string; pipeline_id: string; to_stage_id: string }>();
  return rows.results;
}

/**
 * Resolve a reference against the tenant's own catalog.
 *
 * Returns `null` when the tenant has no record for the reference at all - which the caller must
 * distinguish from a record that exists but is retired, because only the first is a case where the
 * deployment fallback may still apply.
 */
export async function resolveTenantRecipient(
  env: AppEnv,
  tenantId: string,
  recipientRef: string,
): Promise<ResolvedAutomationRecipient | null> {
  const ref = validateRecipientRefValue(recipientRef);
  const record = await getAutomationRecipientByRef(env, tenantId, ref);
  if (!record) return null;
  if (record.active !== 1) throw new AutomationRecipientsError("automation_recipient_ref_retired");
  return {
    ref: record.recipient_ref,
    label: record.label,
    channel: validateRecipientChannel(record.channel),
    address: record.destination,
    digest: record.destination_digest,
  };
}

/** The API projection. `destination` is absent by construction, not filtered by the caller. */
export function automationRecipientView(
  record: AutomationRecipientRecord,
): Record<string, unknown> {
  return {
    recipient_id: record.recipient_id,
    recipient_ref: record.recipient_ref,
    revision_id: record.revision_id,
    version: record.version,
    prior_revision_id: record.prior_revision_id,
    action: record.action,
    label: record.label,
    channel: record.channel,
    destination_masked: maskDestination(
      validateRecipientChannel(record.channel),
      record.destination,
    ),
    destination_digest: record.destination_digest,
    active: record.active === 1,
    actor: { role: record.actor_role, id: record.actor_id },
    command_fingerprint: record.command_fingerprint,
    created_at: record.created_at,
  };
}

/* ------------------------------------------------------------------------------ helpers --- */

async function recipientByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyKeyHash: string,
): Promise<AutomationRecipientRecord | null> {
  return await env.DB.prepare(
    `SELECT h.recipient_id, h.tenant_id, h.recipient_ref, r.revision_id, r.version,
            r.prior_revision_id, r.action, r.label, r.channel, r.destination, r.destination_digest,
            r.active, r.actor_role, r.actor_id, r.command_fingerprint, r.idempotency_key_hash,
            r.created_at
       FROM automation_recipient_revisions r
       JOIN automation_recipient_heads h
         ON h.tenant_id = r.tenant_id AND h.recipient_id = r.recipient_id
      WHERE r.tenant_id = ? AND r.idempotency_key_hash = ? LIMIT 1`,
  ).bind(tenantId, idempotencyKeyHash).first<AutomationRecipientRecord>();
}

async function hashIdempotency(key: string): Promise<string> {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,140}$/.test(key))
    throw new AutomationRecipientsError("automation_recipient_idempotency_key_invalid");
  return await sha256Hex(`automation-recipient:${key}`);
}

function boundedRecipientId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{12,200}$/.test(value.trim()))
    throw new AutomationRecipientsError("automation_recipient_id_invalid");
  return value.trim();
}

function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000)
    throw new AutomationRecipientsError(code);
  return Number(value);
}

async function stableRecipientId(tenantId: string, recipientRef: string): Promise<string> {
  return `arcp_${(await sha256Hex(canonicalJson({
    schema_version: COMMAND_SCHEMA, tenant_id: tenantId, recipient_ref: recipientRef,
  }))).slice(0, 40)}`;
}

async function stableRevisionId(recipientId: string, version: number): Promise<string> {
  return `arcprev_${(await sha256Hex(`${recipientId}:${version}`)).slice(0, 40)}`;
}
