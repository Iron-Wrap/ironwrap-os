/**
 * D1 access for the generic pipeline board (IRO-209).
 *
 * Reads are batched and joined in memory, in the style of `readCommercialSalesSources` +
 * `buildSalesReadModel`: one statement per stage/card/relation set for a whole board, never one
 * per card.  Writes go through a single `batch()` so the card update, the append-only audit row
 * and the M4 automation-outbox row commit together or not at all, per the evidence contract's
 * "resulting state and audit event commit atomically" rule.
 */

import type { AppEnv } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import {
  MAX_STAGES_PER_PIPELINE,
  PIPELINE_CARD_POSITION_STEP,
  type PipelineCardRecord,
  type PipelineRecord,
  type PipelineRelationBag,
  type PipelineRoleAccess,
  type PipelineRoleGrantInput,
  type PipelineRoleGrantRecord,
  type PipelineSafeguard,
  type PipelineStageInput,
  type PipelineStageRecord,
  type PipelineTransitionRecord,
} from "./pipeline-board.ts";

const MAX_BOARD_CARDS = 500;
const MAX_IN_CHUNK = 100;
const MAX_CONFIGURATION_DETAIL_BYTES = 4_000;

export class PipelineStoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "PipelineStoreError";
  }
}

/* ------------------------------------------------------------------ entity registry ------ */

/**
 * The entity-type registry.  SQLite cannot express a polymorphic foreign key, so this is where
 * `(entity_type, entity_id)` is validated against the real table before a card is trusted, and
 * where each entity type publishes the named relations a card template may read from.
 *
 * The KEYS are the generic vocabulary (`lead`, `job`) and are what the core model, the routes and
 * the templates speak.  The VALUES point at tables that already exist in this database, one of
 * which still carries a roofing noun in its name (`operating_roof_jobs`, shipped in
 * 0090_operating_core.sql).  That noun is inherited, not introduced: it sits on the configuration
 * side of the boundary, and M2's generic-core split renames it without touching this contract.
 */
interface PipelineEntityAdapter {
  table: string;
  idColumn: string;
  /** Human label for the administration chooser; generic business vocabulary, never a vertical. */
  label: string;
  /** Batched relation lookups; each returns rows keyed by the card's `entity_id`. */
  resolvers: Record<string, (env: AppEnv, tenantId: string, ids: string[]) => Promise<Map<string, Record<string, unknown>>>>;
}

const ENTITY_REGISTRY: Readonly<Record<string, PipelineEntityAdapter>> = {
  lead: {
    table: "operating_leads",
    idColumn: "lead_id",
    label: "Lead",
    resolvers: {
      entity: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_leads",
          ["lead_id", "contact_name", "contact_email", "lifecycle_status"],
          "lead_id",
          "lead_id",
          ids,
        ),
      job: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_roof_jobs",
          ["lead_id", "job_number", "service_type", "job_status"],
          "lead_id",
          "lead_id",
          ids,
          "created_at ASC",
        ),
      estimate: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_instant_estimates",
          ["lead_id", "estimate_total_cents", "status"],
          "lead_id",
          "lead_id",
          ids,
          "updated_at DESC",
        ),
      quote: (env, tenantId, ids) => quotesByLead(env, tenantId, ids),
    },
  },
  job: {
    table: "operating_roof_jobs",
    idColumn: "roof_job_id",
    label: "Job",
    resolvers: {
      entity: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_roof_jobs",
          ["roof_job_id", "job_number", "service_type", "job_status"],
          "roof_job_id",
          "roof_job_id",
          ids,
        ),
      job: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_roof_jobs",
          ["roof_job_id", "job_number", "service_type", "job_status"],
          "roof_job_id",
          "roof_job_id",
          ids,
        ),
      estimate: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_instant_estimates",
          ["roof_job_id", "estimate_total_cents", "status"],
          "roof_job_id",
          "roof_job_id",
          ids,
          "updated_at DESC",
        ),
      quote: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "commercial_quote_revisions",
          ["roof_job_id", "total_cents", "status", "revision_number"],
          "roof_job_id",
          "roof_job_id",
          ids,
          "revision_number DESC",
        ),
    },
  },
};

export function knownEntityType(entityType: string): boolean {
  return Object.hasOwn(ENTITY_REGISTRY, entityType);
}

/**
 * The entity types a pipeline may bind cards to, published to the administration surface so the
 * "what kind of work moves through this board" chooser is SERVER-driven.  A module that registers
 * a new entity type appears in the administrator's list without a client release and without a
 * migration - which is the whole reason the registry, not an enum column, owns this vocabulary.
 */
export function pipelineEntityTypeCatalog(): Array<{ entity_type: string; label: string }> {
  return Object.entries(ENTITY_REGISTRY)
    .map(([entityType, adapter]) => ({ entity_type: entityType, label: adapter.label }))
    .sort((left, right) => left.entity_type.localeCompare(right.entity_type));
}

/**
 * Confirms `(entity_type, entity_id)` names a row that exists in THIS tenant.  A card is never
 * inserted or trusted without it; an unknown type or a missing row is a 404, not a dangling card.
 */
export async function entityExists(
  env: AppEnv,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  const adapter = ENTITY_REGISTRY[entityType];
  if (!adapter) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM ${adapter.table}
      WHERE tenant_id = ? AND ${adapter.idColumn} = ? LIMIT 1`,
  )
    .bind(tenantId, entityId)
    .first<{ present: number }>();
  return Boolean(row);
}

/**
 * Resolves exactly the relations a board's card template asks for, batched across every card.
 * An entity type that cannot publish a requested relation simply contributes nothing for it, so a
 * template that over-reaches renders a thinner card instead of failing the whole board.
 */
export async function resolveCardRelations(
  env: AppEnv,
  tenantId: string,
  cards: readonly PipelineCardRecord[],
  relations: readonly string[],
): Promise<Map<string, PipelineRelationBag>> {
  const bags = new Map<string, PipelineRelationBag>();
  for (const card of cards) bags.set(card.card_id, {});
  const byType = new Map<string, PipelineCardRecord[]>();
  for (const card of cards) {
    const bucket = byType.get(card.entity_type);
    if (bucket) bucket.push(card);
    else byType.set(card.entity_type, [card]);
  }
  for (const [entityType, typedCards] of byType) {
    const adapter = ENTITY_REGISTRY[entityType];
    if (!adapter) continue;
    const ids = [...new Set(typedCards.map((card) => card.entity_id))];
    for (const relation of relations) {
      const resolver = adapter.resolvers[relation];
      if (!resolver) continue;
      const rows = await resolver(env, tenantId, ids);
      for (const card of typedCards) {
        const bag = bags.get(card.card_id) as PipelineRelationBag;
        bag[relation] = rows.get(card.entity_id) ?? null;
      }
    }
  }
  return bags;
}

async function rowsByKey(
  env: AppEnv,
  tenantId: string,
  table: string,
  columns: readonly string[],
  keyColumn: string,
  aliasColumn: string,
  ids: readonly string[],
  order?: string,
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const chunk of chunked(ids)) {
    const rows = await env.DB.prepare(
      `SELECT ${columns.join(", ")} FROM ${table}
        WHERE tenant_id = ? AND ${keyColumn} IN (${chunk.map(() => "?").join(", ")})
        ${order ? `ORDER BY ${order}` : ""}`,
    )
      .bind(tenantId, ...chunk)
      .all<Record<string, unknown>>();
    // First row wins, so an `order` clause decides "current" (latest estimate, highest revision).
    for (const row of rows.results) {
      const key = row[aliasColumn];
      if (typeof key === "string" && !found.has(key)) found.set(key, row);
    }
  }
  return found;
}

/** The current quote for a lead, reached through the lead's job in one batched pass. */
async function quotesByLead(
  env: AppEnv,
  tenantId: string,
  leadIds: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const chunk of chunked(leadIds)) {
    const rows = await env.DB.prepare(
      `SELECT job.lead_id AS lead_id, quote.total_cents, quote.status, quote.revision_number
         FROM commercial_quote_revisions quote
         JOIN operating_roof_jobs job
           ON job.tenant_id = quote.tenant_id AND job.roof_job_id = quote.roof_job_id
        WHERE quote.tenant_id = ? AND job.lead_id IN (${chunk.map(() => "?").join(", ")})
        ORDER BY quote.revision_number DESC, quote.quote_revision_id ASC`,
    )
      .bind(tenantId, ...chunk)
      .all<Record<string, unknown>>();
    for (const row of rows.results) {
      const key = row.lead_id;
      if (typeof key === "string" && !found.has(key)) found.set(key, row);
    }
  }
  return found;
}

function chunked(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += MAX_IN_CHUNK)
    chunks.push(ids.slice(index, index + MAX_IN_CHUNK) as string[]);
  return chunks;
}

/* ------------------------------------------------------------------------- reads ------ */

/**
 * Every live board in the tenant.  There is deliberately NO `LIMIT` here: the stakeholder runs a
 * board per office and per part of the business and asked for as many as the business needs, so a
 * row that exists is a row that lists.  The payload stays small because a pipeline summary is
 * identity plus counts, not its cards.
 */
export async function listPipelines(
  env: AppEnv,
  tenantId: string,
): Promise<PipelineRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipelines
      WHERE tenant_id = ? AND is_active = 1 AND is_template = 0
      ORDER BY position ASC, key ASC`,
  )
    .bind(tenantId)
    .all<PipelineRecord>();
  return rows.results;
}

/** Every pipeline an administrator may configure, archived boards and copy templates included. */
export async function listPipelinesForAdmin(
  env: AppEnv,
  tenantId: string,
): Promise<PipelineRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipelines
      WHERE tenant_id = ?
      ORDER BY is_active DESC, position ASC, key ASC`,
  )
    .bind(tenantId)
    .all<PipelineRecord>();
  return rows.results;
}

export async function getPipelineByKey(
  env: AppEnv,
  tenantId: string,
  key: string,
): Promise<PipelineRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipelines WHERE tenant_id = ? AND key = ? LIMIT 1`,
  )
    .bind(tenantId, key)
    .first<PipelineRecord>();
}

export async function getPipeline(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<PipelineRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipelines WHERE tenant_id = ? AND pipeline_id = ? LIMIT 1`,
  )
    .bind(tenantId, pipelineId)
    .first<PipelineRecord>();
}

/**
 * The board's ordered stage list.  This order, not the raw `position`, defines adjacency - so an
 * archived stage is excluded HERE, at the one place adjacency is computed, and can never sit
 * invisibly between two live stages making a one-step move look like a skip.
 */
export async function listStages(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<PipelineStageRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_stages
      WHERE tenant_id = ? AND pipeline_id = ? AND is_active = 1
      ORDER BY position ASC, key ASC
      LIMIT ${MAX_STAGES_PER_PIPELINE}`,
  )
    .bind(tenantId, pipelineId)
    .all<PipelineStageRecord>();
  return rows.results;
}

/** Every stage an administrator may configure, archived ones included. */
export async function listStagesForAdmin(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<PipelineStageRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_stages
      WHERE tenant_id = ? AND pipeline_id = ?
      ORDER BY is_active DESC, position ASC, key ASC`,
  )
    .bind(tenantId, pipelineId)
    .all<PipelineStageRecord>();
  return rows.results;
}

export async function getStage(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  stageId: string,
): Promise<PipelineStageRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_stages
      WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ? LIMIT 1`,
  )
    .bind(tenantId, pipelineId, stageId)
    .first<PipelineStageRecord>();
}

/** Every tenant stage in one pass, so the administration list never walks pipeline by pipeline. */
export async function stagesByPipelineForAdmin(
  env: AppEnv,
  tenantId: string,
): Promise<Map<string, PipelineStageRecord[]>> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_stages
      WHERE tenant_id = ?
      ORDER BY pipeline_id ASC, is_active DESC, position ASC, key ASC`,
  )
    .bind(tenantId)
    .all<PipelineStageRecord>();
  const byPipeline = new Map<string, PipelineStageRecord[]>();
  for (const stage of rows.results) {
    const bucket = byPipeline.get(stage.pipeline_id);
    if (bucket) bucket.push(stage);
    else byPipeline.set(stage.pipeline_id, [stage]);
  }
  return byPipeline;
}

export async function listCards(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<PipelineCardRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_cards
      WHERE tenant_id = ? AND pipeline_id = ?
      ORDER BY position_in_stage ASC, card_id ASC
      LIMIT ${MAX_BOARD_CARDS}`,
  )
    .bind(tenantId, pipelineId)
    .all<PipelineCardRecord>();
  return rows.results;
}

export async function cardCountsByPipeline(
  env: AppEnv,
  tenantId: string,
): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT pipeline_id, COUNT(*) AS card_count FROM pipeline_cards
      WHERE tenant_id = ? GROUP BY pipeline_id`,
  )
    .bind(tenantId)
    .all<{ pipeline_id: string; card_count: number }>();
  return new Map(rows.results.map((row) => [row.pipeline_id, Number(row.card_count)]));
}

export async function getCard(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  cardId: string,
): Promise<PipelineCardRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_cards
      WHERE tenant_id = ? AND pipeline_id = ? AND card_id = ? LIMIT 1`,
  )
    .bind(tenantId, pipelineId, cardId)
    .first<PipelineCardRecord>();
}

export async function getTransition(
  env: AppEnv,
  tenantId: string,
  transitionId: string,
): Promise<PipelineTransitionRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_card_transitions
      WHERE tenant_id = ? AND transition_id = ? LIMIT 1`,
  )
    .bind(tenantId, transitionId)
    .first<PipelineTransitionRecord>();
}

export async function latestTransition(
  env: AppEnv,
  tenantId: string,
  cardId: string,
): Promise<PipelineTransitionRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_card_transitions
      WHERE tenant_id = ? AND card_id = ?
      ORDER BY occurred_at DESC, card_version DESC, transition_id DESC
      LIMIT 1`,
  )
    .bind(tenantId, cardId)
    .first<PipelineTransitionRecord>();
}

export async function listCardTransitions(
  env: AppEnv,
  tenantId: string,
  cardId: string,
): Promise<PipelineTransitionRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_card_transitions
      WHERE tenant_id = ? AND card_id = ?
      ORDER BY occurred_at ASC, card_version ASC, transition_id ASC
      LIMIT 200`,
  )
    .bind(tenantId, cardId)
    .all<PipelineTransitionRecord>();
  return rows.results;
}

async function initialPlacementTransition(
  env: AppEnv,
  tenantId: string,
  cardId: string,
): Promise<PipelineTransitionRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_card_transitions
      WHERE tenant_id = ? AND card_id = ? AND from_stage_id IS NULL
      ORDER BY card_version ASC, transition_id ASC LIMIT 1`,
  )
    .bind(tenantId, cardId)
    .first<PipelineTransitionRecord>();
}

async function transitionByIdempotency(
  env: AppEnv,
  tenantId: string,
  idempotencyKeyHash: string,
): Promise<PipelineTransitionRecord | null> {
  return await env.DB.prepare(
    `SELECT * FROM pipeline_card_transitions
      WHERE tenant_id = ? AND idempotency_key_hash = ? LIMIT 1`,
  )
    .bind(tenantId, idempotencyKeyHash)
    .first<PipelineTransitionRecord>();
}

export type PipelineCommandOperation = "placement" | "transition";

export interface PipelineCommandFingerprintInput {
  operation: PipelineCommandOperation;
  tenantId: string;
  pipelineId: string;
  cardId: string;
  toStageId: string;
  expectedVersion: number | null;
  safeguard: PipelineSafeguard;
  reasonCode: string | null;
  correlationId: string | null;
  actorType: string;
  actorId: string;
  rawConfirmation: boolean | null;
  undoTransitionId: string | null;
  entityType: string | null;
  entityId: string | null;
}

/** One canonical intent representation for placement, move, and undo replay checks. */
export async function pipelineCommandFingerprint(
  input: PipelineCommandFingerprintInput,
): Promise<string> {
  return await sha256Hex(
    canonicalJson({
      schema_version: "ironwrap.pipeline-command.v2",
      operation: input.operation,
      tenant_id: input.tenantId,
      pipeline_id: input.pipelineId,
      card_id: input.cardId,
      to_stage_id: input.toStageId,
      expected_version: input.expectedVersion,
      safeguard: input.safeguard,
      reason_code: input.reasonCode,
      correlation_id: input.correlationId,
      actor_type: input.actorType,
      actor_id: input.actorId,
      raw_confirmation: input.rawConfirmation,
      undo_transition_id: input.undoTransitionId,
      entity_type: input.entityType,
      entity_id: input.entityId,
    }),
  );
}

export interface PipelineReplayIntent
  extends Omit<PipelineCommandFingerprintInput, "safeguard"> {
  /** Omit for a retry before the original safeguard is known; the stored value is authoritative. */
  safeguard?: PipelineSafeguard;
}

/**
 * The transition a given idempotency key already produced, if any.  A retry after a dropped
 * response has to find its own result here: by then the card has moved, so a plain CAS check on
 * the version the client still holds would answer "conflict" for a request that in fact succeeded.
 * The store owns the complete fingerprint comparison; callers cannot silently replay a partial
 * tuple of card, destination and version.
 */
export async function findTransitionByIdempotencyKey(
  env: AppEnv,
  tenantId: string,
  idempotencyKey: string,
  intent: PipelineReplayIntent,
): Promise<PipelineTransitionRecord | null> {
  const existing = await transitionByIdempotency(env, tenantId, await sha256Hex(idempotencyKey));
  if (!existing) return null;
  const fingerprint = await pipelineCommandFingerprint({
    ...intent,
    tenantId,
    safeguard: intent.safeguard ?? storedSafeguard(existing.safeguard),
  });
  if (existing.command_fingerprint !== fingerprint)
    throw new PipelineStoreError("pipeline_transition_idempotency_conflict");
  return existing;
}

function storedSafeguard(value: string): PipelineSafeguard {
  if (value === "direct" || value === "confirmed" || value === "undo") return value;
  throw new PipelineStoreError("pipeline_transition_write_failed");
}

/* ------------------------------------------------------------------------ writes ------ */

export interface CommitTransitionInput {
  tenantId: string;
  pipelineId: string;
  card: PipelineCardRecord;
  toStageId: string;
  expectedVersion: number;
  safeguard: PipelineSafeguard;
  reasonCode: string | null;
  correlationId: string | null;
  actorType: string;
  actorId: string;
  idempotencyKey: string;
  rawConfirmation: boolean | null;
  undoTransitionId: string | null;
}

export interface CommitTransitionResult {
  kind: "created" | "replayed";
  transition: PipelineTransitionRecord;
  cardVersion: number;
}

/**
 * Commits one card move: the card update (CAS on `expected_version`), the append-only audit row,
 * and the automation-outbox row, in a single `batch()`.
 *
 * Replaying the same idempotency key with the same command returns the original transition instead
 * of moving the card twice.  Reusing a key for a DIFFERENT command is refused outright, so a
 * client that recycles keys cannot silently land somewhere it did not ask for.
 */
export async function commitCardTransition(
  env: AppEnv,
  input: CommitTransitionInput,
  now = new Date(),
): Promise<CommitTransitionResult> {
  const idempotencyKeyHash = await sha256Hex(input.idempotencyKey);

  const existing = await findTransitionByIdempotencyKey(env, input.tenantId, input.idempotencyKey, {
    operation: "transition",
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    cardId: input.card.card_id,
    toStageId: input.toStageId,
    expectedVersion: input.expectedVersion,
    safeguard: input.safeguard,
    reasonCode: input.reasonCode,
    correlationId: input.correlationId,
    actorType: input.actorType,
    actorId: input.actorId,
    rawConfirmation: input.rawConfirmation,
    undoTransitionId: input.undoTransitionId,
    entityType: null,
    entityId: null,
  });
  if (existing)
    return { kind: "replayed", transition: existing, cardVersion: existing.card_version };

  const commandFingerprint = await pipelineCommandFingerprint({
    operation: "transition",
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    cardId: input.card.card_id,
    toStageId: input.toStageId,
    expectedVersion: input.expectedVersion,
    safeguard: input.safeguard,
    reasonCode: input.reasonCode,
    correlationId: input.correlationId,
    actorType: input.actorType,
    actorId: input.actorId,
    rawConfirmation: input.rawConfirmation,
    undoTransitionId: input.undoTransitionId,
    entityType: null,
    entityId: null,
  });

  const occurredAt = now.toISOString();
  const transitionId = `pct_${(
    await sha256Hex(`${input.tenantId}:${idempotencyKeyHash}`)
  ).slice(0, 40)}`;
  const outboxId = `pcto_${(
    await sha256Hex(`${input.tenantId}:${idempotencyKeyHash}:outbox`)
  ).slice(0, 40)}`;
  const cardVersion = input.expectedVersion + 1;
  const position = await nextPositionInStage(env, input.tenantId, input.pipelineId, input.toStageId);

  // Every statement below is predicated on the CAS update having landed.  D1 runs a batch as one
  // transaction, but a WHERE that matches nothing is not an error: the audit INSERT turns a failed
  // card CAS into a NOT NULL violation, so a stale `expected_version` cannot commit any statement.
  let results: unknown[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE pipeline_cards
          SET stage_id = ?, position_in_stage = ?, stage_entered_at = ?, version = version + 1,
              updated_at = ?, last_transition_id = ?
        WHERE tenant_id = ? AND pipeline_id = ? AND card_id = ? AND version = ?
          AND EXISTS (
            SELECT 1 FROM pipelines p
             WHERE p.tenant_id = pipeline_cards.tenant_id
               AND p.pipeline_id = pipeline_cards.pipeline_id
               AND p.is_active = 1
          )
          AND EXISTS (
            SELECT 1 FROM pipeline_stages source
             WHERE source.tenant_id = pipeline_cards.tenant_id
               AND source.pipeline_id = pipeline_cards.pipeline_id
               AND source.stage_id = pipeline_cards.stage_id
               AND source.is_active = 1
          )
          AND EXISTS (
            SELECT 1 FROM pipeline_stages destination
             WHERE destination.tenant_id = pipeline_cards.tenant_id
               AND destination.pipeline_id = pipeline_cards.pipeline_id
               AND destination.stage_id = ?
               AND destination.is_active = 1
          )`,
      ).bind(
        input.toStageId,
        position,
        occurredAt,
        occurredAt,
        transitionId,
        input.tenantId,
        input.pipelineId,
        input.card.card_id,
        input.expectedVersion,
        input.toStageId,
      ),
      env.DB.prepare(
        `INSERT INTO pipeline_card_transitions (
         transition_id, tenant_id, pipeline_id, card_id, from_stage_id, to_stage_id,
         actor_type, actor_id, safeguard, reason_code, correlation_id,
         command_fingerprint, idempotency_key_hash, card_version, occurred_at, created_at
       )
       SELECT ?,
          CASE WHEN EXISTS (
            SELECT 1 FROM pipeline_cards card
             WHERE card.tenant_id = ? AND card.pipeline_id = ? AND card.card_id = ?
               AND card.version = ? AND card.stage_id = ? AND card.last_transition_id = ?
          ) THEN ? ELSE NULL END,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM (SELECT 1)`,
      ).bind(
        transitionId,
        input.tenantId,
        input.pipelineId,
        input.card.card_id,
        cardVersion,
        input.toStageId,
        transitionId,
        input.tenantId,
        input.pipelineId,
        input.card.card_id,
        input.card.stage_id,
        input.toStageId,
        input.actorType,
        input.actorId,
        input.safeguard,
        input.reasonCode,
        input.correlationId,
        commandFingerprint,
        idempotencyKeyHash,
        cardVersion,
        occurredAt,
        occurredAt,
      ),
      env.DB.prepare(
        `INSERT INTO pipeline_stage_automation_outbox (
         outbox_id, tenant_id, pipeline_id, card_id, transition_id,
         from_stage_id, to_stage_id, status, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?
         FROM pipeline_card_transitions committed
        WHERE committed.tenant_id = ? AND committed.pipeline_id = ? AND committed.transition_id = ?`,
      ).bind(
        outboxId,
        input.tenantId,
        input.pipelineId,
        input.card.card_id,
        transitionId,
        input.card.stage_id,
        input.toStageId,
        occurredAt,
        input.tenantId,
        input.pipelineId,
        transitionId,
      ),
    ]);
  } catch (error) {
    if (String(error).includes("pipeline_card_transitions.tenant_id")) {
      const pipeline = await getPipeline(env, input.tenantId, input.pipelineId);
      const fromStage = await getStage(env, input.tenantId, input.pipelineId, input.card.stage_id);
      const toStage = await getStage(env, input.tenantId, input.pipelineId, input.toStageId);
      if (
        !pipeline ||
        pipeline.is_active !== 1 ||
        !fromStage ||
        fromStage.is_active !== 1 ||
        !toStage ||
        toStage.is_active !== 1
      )
        throw new PipelineStoreError("pipeline_stage_changed");
      throw new PipelineStoreError("pipeline_card_version_conflict");
    }
    throw error;
  }

  // The transition INSERT is the in-batch receipt for the card CAS. Its conditional tenant_id is
  // NULL unless the exact post-CAS version/stage/marker exists, which forces the whole batch back.
  if (changes(results[0]) !== 1) throw new PipelineStoreError("pipeline_card_version_conflict");
  if (changes(results[1]) !== 1 || changes(results[2]) !== 1)
    throw new PipelineStoreError("pipeline_transition_write_failed");

  const transition = await getTransition(env, input.tenantId, transitionId);
  if (!transition) throw new PipelineStoreError("pipeline_transition_write_failed");
  return { kind: "created", transition, cardVersion };
}

function changes(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

async function nextPositionInStage(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  stageId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT MAX(position_in_stage) AS top FROM pipeline_cards
      WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ?`,
  )
    .bind(tenantId, pipelineId, stageId)
    .first<{ top: number | null }>();
  const top = typeof row?.top === "number" ? row.top : 0;
  return Math.min(top + PIPELINE_CARD_POSITION_STEP, 1_000_000_000);
}

/** True once some later transition already reverses `transitionId`. */
export async function undoAlreadyRecorded(
  env: AppEnv,
  tenantId: string,
  transitionId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM pipeline_card_transitions
      WHERE tenant_id = ? AND correlation_id = ? LIMIT 1`,
  )
    .bind(tenantId, transitionId)
    .first<{ present: number }>();
  return Boolean(row);
}

export interface PlaceCardInput {
  tenantId: string;
  pipelineId: string;
  stageId: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  idempotencyKey: string;
}

export interface PlaceCardResult {
  kind: "created" | "replayed";
  card: PipelineCardRecord;
  transition: PipelineTransitionRecord | null;
}

/**
 * Puts an entity on a board for the first time.
 *
 * This is where the entity-type registry earns its keep: `(entity_type, entity_id)` is checked
 * against the real table for THIS tenant before anything is written, because SQLite cannot express
 * the polymorphic foreign key that would otherwise do it.  A card that already exists for the pair
 * is returned as-is rather than duplicated, so an import that runs twice does not double the board.
 *
 * The placement is audited like any other transition, with a NULL `from_stage_id`, and feeds the
 * automation outbox: M4's rule engine sees "entered stage" for a new card exactly as it does for a
 * dragged one.
 */
export async function placeCard(
  env: AppEnv,
  input: PlaceCardInput,
  now = new Date(),
): Promise<PlaceCardResult> {
  if (!knownEntityType(input.entityType))
    throw new PipelineStoreError("pipeline_entity_type_unknown");
  if (!(await entityExists(env, input.tenantId, input.entityType, input.entityId)))
    throw new PipelineStoreError("pipeline_entity_not_found");

  const cardId = `plc_${(
    await sha256Hex(
      `${input.tenantId}:${input.pipelineId}:${input.entityType}:${input.entityId}`,
    )
  ).slice(0, 40)}`;
  const idempotencyKeyHash = await sha256Hex(input.idempotencyKey);
  const commandFingerprint = await pipelineCommandFingerprint({
    operation: "placement",
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    cardId,
    toStageId: input.stageId,
    expectedVersion: null,
    safeguard: "direct",
    reasonCode: null,
    correlationId: null,
    actorType: input.actorType,
    actorId: input.actorId,
    rawConfirmation: null,
    undoTransitionId: null,
    entityType: input.entityType,
    entityId: input.entityId,
  });
  const priorByKey = await findTransitionByIdempotencyKey(env, input.tenantId, input.idempotencyKey, {
    operation: "placement",
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    cardId,
    toStageId: input.stageId,
    expectedVersion: null,
    safeguard: "direct",
    reasonCode: null,
    correlationId: null,
    actorType: input.actorType,
    actorId: input.actorId,
    rawConfirmation: null,
    undoTransitionId: null,
    entityType: input.entityType,
    entityId: input.entityId,
  });

  if (priorByKey) {
    const card = await getCard(env, input.tenantId, input.pipelineId, cardId);
    if (!card) throw new PipelineStoreError("pipeline_card_write_failed");
    return { kind: "replayed", card, transition: priorByKey };
  }

  const existing = await getCard(env, input.tenantId, input.pipelineId, cardId);
  if (existing) {
    const placement = await initialPlacementTransition(env, input.tenantId, cardId);
    if (!placement || placement.command_fingerprint !== commandFingerprint)
      throw new PipelineStoreError("pipeline_transition_idempotency_conflict");
    return { kind: "replayed", card: existing, transition: placement };
  }

  const occurredAt = now.toISOString();
  const transitionId = `pct_${(
    await sha256Hex(`${input.tenantId}:${idempotencyKeyHash}`)
  ).slice(0, 40)}`;
  const outboxId = `pcto_${(
    await sha256Hex(`${input.tenantId}:${idempotencyKeyHash}:outbox`)
  ).slice(0, 40)}`;
  const position = await nextPositionInStage(
    env,
    input.tenantId,
    input.pipelineId,
    input.stageId,
  );

  let results: unknown[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO pipeline_cards (
           card_id, tenant_id, pipeline_id, stage_id, entity_type, entity_id,
           position_in_stage, stage_entered_at, version, last_transition_id, created_at, updated_at
         )
         SELECT ?, ?, ?,
           CASE WHEN EXISTS (
             SELECT 1 FROM pipelines p
              JOIN pipeline_stages s
                ON s.tenant_id = p.tenant_id AND s.pipeline_id = p.pipeline_id
             WHERE p.tenant_id = ? AND p.pipeline_id = ? AND p.is_active = 1
               AND s.stage_id = ? AND s.is_active = 1
           ) THEN ? ELSE NULL END,
           ?, ?, ?, ?, 1, ?, ?, ?
           FROM (SELECT 1)`,
      ).bind(
        cardId,
        input.tenantId,
        input.pipelineId,
        input.tenantId,
        input.pipelineId,
        input.stageId,
        input.stageId,
        input.entityType,
        input.entityId,
        position,
        occurredAt,
        transitionId,
        occurredAt,
        occurredAt,
      ),
    env.DB.prepare(
      `INSERT INTO pipeline_card_transitions (
         transition_id, tenant_id, pipeline_id, card_id, from_stage_id, to_stage_id,
         actor_type, actor_id, safeguard, reason_code, correlation_id,
         command_fingerprint, idempotency_key_hash, card_version, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'direct', NULL, NULL, ?, ?, 1, ?, ?)`,
    ).bind(
      transitionId,
      input.tenantId,
      input.pipelineId,
      cardId,
      input.stageId,
      input.actorType,
      input.actorId,
      commandFingerprint,
      idempotencyKeyHash,
      occurredAt,
      occurredAt,
    ),
    env.DB.prepare(
      `INSERT INTO pipeline_stage_automation_outbox (
         outbox_id, tenant_id, pipeline_id, card_id, transition_id,
         from_stage_id, to_stage_id, status, created_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', ?)`,
    ).bind(
      outboxId,
      input.tenantId,
      input.pipelineId,
      cardId,
      transitionId,
      input.stageId,
      occurredAt,
    ),
    ]);
  } catch (error) {
    if (String(error).includes("pipeline_cards.stage_id"))
      throw new PipelineStoreError("pipeline_stage_changed");
    throw error;
  }

  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[2]) !== 1)
    throw new PipelineStoreError("pipeline_card_write_failed");

  const card = await getCard(env, input.tenantId, input.pipelineId, cardId);
  if (!card) throw new PipelineStoreError("pipeline_card_write_failed");
  return { kind: "created", card, transition: await getTransition(env, input.tenantId, transitionId) };
}

/* ------------------------------------------------------- administration: reads ------ */

/** Deterministic ids, derived exactly as `tools/seed-pipeline.mjs` derives them, so a board an
 * administrator creates and a board the seeder installs are the same kind of row. */
export async function pipelineIdFor(tenantId: string, pipelineKey: string): Promise<string> {
  return `pl_${(await sha256Hex(`${tenantId}:${pipelineKey}`)).slice(0, 40)}`;
}

export async function stageIdFor(
  tenantId: string,
  pipelineKey: string,
  stageKey: string,
): Promise<string> {
  return `pls_${(await sha256Hex(`${tenantId}:${pipelineKey}:${stageKey}`)).slice(0, 40)}`;
}

export async function listRoleGrants(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<PipelineRoleGrantRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_role_grants
      WHERE tenant_id = ? AND pipeline_id = ? ORDER BY role ASC`,
  )
    .bind(tenantId, pipelineId)
    .all<PipelineRoleGrantRecord>();
  return rows.results;
}

export async function roleGrantsByPipeline(
  env: AppEnv,
  tenantId: string,
): Promise<Map<string, PipelineRoleGrantRecord[]>> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_role_grants WHERE tenant_id = ? ORDER BY pipeline_id ASC, role ASC`,
  )
    .bind(tenantId)
    .all<PipelineRoleGrantRecord>();
  const byPipeline = new Map<string, PipelineRoleGrantRecord[]>();
  for (const grant of rows.results) {
    const bucket = byPipeline.get(grant.pipeline_id);
    if (bucket) bucket.push(grant);
    else byPipeline.set(grant.pipeline_id, [grant]);
  }
  return byPipeline;
}

/**
 * The acting session's own grants, and only those.  The query binds BOTH tenant and role, so an
 * index handed to `canViewPipeline` can never carry another role's authority: the fail-closed
 * shape PR #171 established survives the addition of grants because absence is still the deny.
 */
export async function pipelineRoleAccessFor(
  env: AppEnv,
  tenantId: string,
  role: string,
): Promise<PipelineRoleAccess> {
  const rows = await env.DB.prepare(
    `SELECT pipeline_id, can_write FROM pipeline_role_grants
      WHERE tenant_id = ? AND role = ?`,
  )
    .bind(tenantId, role)
    .all<{ pipeline_id: string; can_write: number }>();
  return new Map(
    rows.results.map((row) => [row.pipeline_id, { can_write: row.can_write === 1 }]),
  );
}

export async function cardCountsByStage(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<Map<string, number>> {
  const rows = await env.DB.prepare(
    `SELECT stage_id, COUNT(*) AS card_count FROM pipeline_cards
      WHERE tenant_id = ? AND pipeline_id = ? GROUP BY stage_id`,
  )
    .bind(tenantId, pipelineId)
    .all<{ stage_id: string; card_count: number }>();
  return new Map(rows.results.map((row) => [row.stage_id, Number(row.card_count)]));
}

/** Every stage card count in the tenant in one statement, so the administration list never runs
 * a per-pipeline query. */
export async function cardCountsByStageForTenant(
  env: AppEnv,
  tenantId: string,
): Promise<Map<string, Map<string, number>>> {
  const rows = await env.DB.prepare(
    `SELECT pipeline_id, stage_id, COUNT(*) AS card_count FROM pipeline_cards
      WHERE tenant_id = ? GROUP BY pipeline_id, stage_id`,
  )
    .bind(tenantId)
    .all<{ pipeline_id: string; stage_id: string; card_count: number }>();
  const byPipeline = new Map<string, Map<string, number>>();
  for (const row of rows.results) {
    const bucket = byPipeline.get(row.pipeline_id) ?? new Map<string, number>();
    bucket.set(row.stage_id, Number(row.card_count));
    byPipeline.set(row.pipeline_id, bucket);
  }
  return byPipeline;
}

export async function countCardsInStage(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  stageId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS card_count FROM pipeline_cards
      WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ?`,
  )
    .bind(tenantId, pipelineId, stageId)
    .first<{ card_count: number }>();
  return Number(row?.card_count ?? 0);
}

/**
 * True once the append-only trail names this stage.  Such a stage can never be deleted - the
 * transition and outbox rows hold ON DELETE RESTRICT edges to it and the trail is not rewritable -
 * so removal archives it instead, and the audit an owner may read next year stays intact.
 */
export async function stageHasHistory(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  stageId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM pipeline_card_transitions
      WHERE tenant_id = ? AND pipeline_id = ? AND (from_stage_id = ? OR to_stage_id = ?)
      LIMIT 1`,
  )
    .bind(tenantId, pipelineId, stageId, stageId)
    .first<{ present: number }>();
  return Boolean(row);
}

export async function listConfigurationEvents(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  limit = 50,
): Promise<PipelineConfigurationEventRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_configuration_events
      WHERE tenant_id = ? AND pipeline_id = ?
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT ?`,
  )
    .bind(tenantId, pipelineId, Math.min(Math.max(limit, 1), 200))
    .all<PipelineConfigurationEventRecord>();
  return rows.results;
}

export interface PipelineConfigurationEventRecord {
  event_id: string;
  tenant_id: string;
  pipeline_id: string;
  stage_id: string | null;
  action: string;
  actor_role: string;
  actor_id: string;
  pipeline_version: number;
  detail_json: string;
  occurred_at: string;
}

/* ------------------------------------------------------ administration: writes ------ */

export type PipelineConfigurationAction =
  | "pipeline_created"
  | "pipeline_updated"
  | "pipeline_copied"
  | "pipelines_reordered"
  | "stage_added"
  | "stage_updated"
  | "stage_removed"
  | "stage_archived"
  | "stages_reordered"
  | "role_grants_replaced";

export interface PipelineAdminActor {
  role: string;
  userId: string;
}

interface ConfigurationEventInput {
  tenantId: string;
  pipelineId: string;
  stageId: string | null;
  action: PipelineConfigurationAction;
  actor: PipelineAdminActor;
  /** The version the pipeline row LANDS ON; it is the receipt this event is predicated upon. */
  pipelineVersion: number;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/**
 * The seal a single administration command writes with: one digest over everything that makes the
 * command what it is - tenant, pipeline, stage, action, the version it lands on, the actor, the
 * instant, and the payload.
 *
 * The `marker` half is stamped on the pipeline row BY the version CAS.  The `eventId` half names
 * the evidence row.  Every dependent statement in the same batch then predicates itself on
 * `version = N AND configuration_marker = <this command's marker>`, which is what makes a batched
 * administration command safe: D1 reports a statement that matched nothing as a SUCCESS and does
 * not roll a committed batch back because a later check threw, so "the pipeline is now at version
 * N" alone would let a STALE writer's stage insert land on the back of whoever really reached N.
 * Two commands can only collide on the marker by being byte-identical, and then the event row's
 * own uniqueness aborts the batch - so the loser writes nothing either way.
 *
 * `pipeline_cards.last_transition_id` (0113) is the same idiom for the same reason.
 */
interface CommandSeal {
  eventId: string;
  marker: string;
}

async function commandSeal(input: ConfigurationEventInput): Promise<CommandSeal> {
  const digest = (
    await sha256Hex(
      canonicalJson({
        schema_version: "ironwrap.pipeline-configuration-command.v1",
        tenant_id: input.tenantId,
        pipeline_id: input.pipelineId,
        stage_id: input.stageId,
        action: input.action,
        pipeline_version: input.pipelineVersion,
        actor_role: input.actor.role,
        actor_id: input.actor.userId,
        occurred_at: input.occurredAt,
        detail: input.detail,
      }),
    )
  ).slice(0, 40);
  return { eventId: `plce_${digest}`, marker: `plcm_${digest}` };
}

/** Preserve a verifiable receipt even when the full order would exceed the event row bound. */
async function boundedStageOrderDetail(
  stageIds: readonly string[],
): Promise<Record<string, unknown>> {
  const order = [...stageIds];
  const detail = { order };
  if (JSON.stringify(detail).length <= MAX_CONFIGURATION_DETAIL_BYTES) return detail;
  return {
    order_count: order.length,
    order_sha256: await sha256Hex(canonicalJson(order)),
  };
}

function configurationEventStatement(
  env: AppEnv,
  input: ConfigurationEventInput,
  seal: CommandSeal,
  /** Extra proof that the change this event DESCRIBES actually landed, for a command whose own
   * statement can legitimately match nothing (see `removeStage`). */
  proof?: { sql: string; params: unknown[] },
) {
  const detailJson = JSON.stringify(input.detail);
  if (
    typeof detailJson !== "string" ||
    detailJson.length < 2 ||
    detailJson.length > MAX_CONFIGURATION_DETAIL_BYTES
  )
    throw new PipelineStoreError("pipeline_configuration_detail_too_large");

  // D1 treats a zero-row SELECT as a successful statement.  The event is therefore also the
  // in-batch assertion: a missing aggregate proof deliberately violates a NOT NULL column,
  // forcing D1 to roll the complete batch back instead of allowing a caller to discover the
  // failure only after an earlier CAS has committed.
  const aggregateProof = `p.tenant_id = ? AND p.pipeline_id = ? AND p.version = ?
        AND p.configuration_marker = ?`;
  const mutationProof = proof
    ? `${aggregateProof}\n        AND ${proof.sql}`
    : aggregateProof;
  return env.DB.prepare(
    `INSERT INTO pipeline_configuration_events (
       event_id, tenant_id, pipeline_id, stage_id, action, actor_role, actor_id,
       pipeline_version, detail_json, occurred_at
     )
     SELECT ?,
       CASE WHEN EXISTS (SELECT 1 FROM pipelines p WHERE ${aggregateProof})
         THEN ? ELSE NULL END,
       CASE WHEN EXISTS (SELECT 1 FROM pipelines p WHERE ${mutationProof})
         THEN ? ELSE NULL END,
       ?, ?, ?, ?, ?, ?, ?
       FROM (SELECT 1)`,
  ).bind(
    seal.eventId,
    input.tenantId,
    input.pipelineId,
    input.pipelineVersion,
    seal.marker,
    input.tenantId,
    input.tenantId,
    input.pipelineId,
    input.pipelineVersion,
    seal.marker,
    ...(proof?.params ?? []),
    input.pipelineId,
    input.stageId,
    input.action,
    input.actor.role,
    input.actor.userId,
    input.pipelineVersion,
    detailJson,
    input.occurredAt,
  );
}

/** CAS on the pipeline row: the aggregate's version is the concurrency token for its whole
 * configuration, stages and role grants included, so an administration surface holds ONE version
 * per board instead of one per row it might touch.  The same statement stamps this command's
 * marker, which is what every dependent statement below proves itself against. */
function pipelineCasStatement(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  expectedVersion: number,
  marker: string,
  occurredAt: string,
) {
  return env.DB.prepare(
    `UPDATE pipelines SET version = version + 1, updated_at = ?, configuration_marker = ?
      WHERE tenant_id = ? AND pipeline_id = ? AND version = ?`,
  ).bind(occurredAt, marker, tenantId, pipelineId, expectedVersion);
}

type D1BatchStatements = Parameters<AppEnv["DB"]["batch"]>[0];

/** Convert the event assertion's intentional constraint failure into the route's stable error. */
async function configurationBatch(
  env: AppEnv,
  statements: D1BatchStatements,
  proofFailureCode = "pipeline_write_failed",
) {
  try {
    return await env.DB.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes("pipeline_configuration_events.tenant_id"))
      throw new PipelineStoreError("pipeline_version_conflict");
    if (message.includes("pipeline_configuration_events.pipeline_id"))
      throw new PipelineStoreError(proofFailureCode);
    if (message.includes("pipeline_card_transitions.tenant_id"))
      throw new PipelineStoreError(proofFailureCode);
    throw error;
  }
}

function stageInsertStatement(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  pipelineVersion: number,
  marker: string,
  stageId: string,
  stage: PipelineStageInput,
  position: number,
  occurredAt: string,
) {
  return env.DB.prepare(
    `INSERT INTO pipeline_stages (
       stage_id, tenant_id, pipeline_id, key, name, color, position, is_won, is_lost,
       min_role_to_enter, is_active, version, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?
       FROM pipelines p
      WHERE p.tenant_id = ? AND p.pipeline_id = ? AND p.version = ?
        AND p.configuration_marker = ?`,
  ).bind(
    stageId,
    tenantId,
    pipelineId,
    stage.key,
    stage.name,
    stage.color,
    position,
    stage.is_won ? 1 : 0,
    stage.is_lost ? 1 : 0,
    stage.min_role_to_enter,
    occurredAt,
    occurredAt,
    tenantId,
    pipelineId,
    pipelineVersion,
    marker,
  );
}

async function roleGrantStatements(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
  pipelineVersion: number,
  marker: string,
  grants: readonly PipelineRoleGrantInput[],
  actor: PipelineAdminActor,
  occurredAt: string,
) {
  const statements = [];
  for (const grant of grants) {
    const grantId = `plrg_${(
      await sha256Hex(`${tenantId}:${pipelineId}:${grant.role}`)
    ).slice(0, 40)}`;
    statements.push(
      env.DB.prepare(
        `INSERT INTO pipeline_role_grants (
           grant_id, tenant_id, pipeline_id, role, can_write, granted_by, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
           FROM pipelines p
          WHERE p.tenant_id = ? AND p.pipeline_id = ? AND p.version = ?
            AND p.configuration_marker = ?`,
      ).bind(
        grantId,
        tenantId,
        pipelineId,
        grant.role,
        grant.can_write ? 1 : 0,
        actor.userId,
        occurredAt,
        occurredAt,
        tenantId,
        pipelineId,
        pipelineVersion,
        marker,
      ),
    );
  }
  return statements;
}

export interface CreatePipelineInput {
  tenantId: string;
  key: string;
  name: string;
  entityType: string;
  owningRole: string | null;
  position: number;
  cardTemplateJson: string;
  isTemplate: boolean;
  templateSourceId: string | null;
  stages: readonly PipelineStageInput[];
  grants: readonly PipelineRoleGrantInput[];
  actor: PipelineAdminActor;
  action: Extract<PipelineConfigurationAction, "pipeline_created" | "pipeline_copied">;
}

/**
 * A new board, its stages, its role grants and its creation evidence in one batch.
 *
 * A copy lands here too: duplicating a pipeline is creating a new one from the source's stage list,
 * with `template_source_id` recording where it came from and NO cards carried over.  That is the
 * whole reason the copy produces an independent pipeline - there is no live link to follow, only a
 * provenance column, so editing the copy can never reach back into the original.
 */
export async function createPipeline(
  env: AppEnv,
  input: CreatePipelineInput,
  now = new Date(),
): Promise<PipelineRecord> {
  if (input.stages.length > MAX_STAGES_PER_PIPELINE)
    throw new PipelineStoreError("pipeline_stage_limit_reached");
  const occurredAt = now.toISOString();
  const pipelineId = await pipelineIdFor(input.tenantId, input.key);
  const event: ConfigurationEventInput = {
    tenantId: input.tenantId,
    pipelineId,
    stageId: null,
    action: input.action,
    actor: input.actor,
    pipelineVersion: 1,
    detail: {
      key: input.key,
      name: input.name,
      entity_type: input.entityType,
      owning_role: input.owningRole,
      stage_count: input.stages.length,
      template_source_id: input.templateSourceId,
    },
    occurredAt,
  };
  const seal = await commandSeal(event);

  const statements = [
    // The `pipelines` INSERT is this command's CAS: a key that already names a board in the tenant
    // violates `UNIQUE (tenant_id, key)` and aborts the whole batch rather than half-creating one.
    env.DB.prepare(
      `INSERT INTO pipelines (
         pipeline_id, tenant_id, key, name, entity_type, owning_role, card_template_json,
         is_template, template_source_id, is_active, position, configuration_marker, version,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?)`,
    ).bind(
      pipelineId,
      input.tenantId,
      input.key,
      input.name,
      input.entityType,
      input.owningRole,
      input.cardTemplateJson,
      input.isTemplate ? 1 : 0,
      input.templateSourceId,
      input.position,
      seal.marker,
      occurredAt,
      occurredAt,
    ),
  ];
  for (const [index, stage] of input.stages.entries())
    statements.push(
      stageInsertStatement(
        env,
        input.tenantId,
        pipelineId,
        1,
        seal.marker,
        await stageIdFor(input.tenantId, input.key, stage.key),
        stage,
        index,
        occurredAt,
      ),
    );
  statements.push(
    ...(await roleGrantStatements(
      env,
      input.tenantId,
      pipelineId,
      1,
      seal.marker,
      input.grants,
      input.actor,
      occurredAt,
    )),
  );
  statements.push(configurationEventStatement(env, event, seal));

  const results = await configurationBatch(env, statements);
  for (const result of results)
    if (changes(result) !== 1) throw new PipelineStoreError("pipeline_write_failed");

  const created = await getPipeline(env, input.tenantId, pipelineId);
  if (!created) throw new PipelineStoreError("pipeline_write_failed");
  return created;
}

export interface UpdatePipelineInput {
  tenantId: string;
  pipeline: PipelineRecord;
  expectedVersion: number;
  name: string;
  position: number;
  owningRole: string | null;
  isActive: boolean;
  cardTemplateJson: string;
  actor: PipelineAdminActor;
}

/** Rename, reposition, re-scope, archive or reactivate one board.  Identity - key, entity type and
 * provenance - is immutable by trigger, so nothing here can rewrite what the board IS. */
export async function updatePipeline(
  env: AppEnv,
  input: UpdatePipelineInput,
  now = new Date(),
): Promise<PipelineRecord> {
  const occurredAt = now.toISOString();
  const nextVersion = input.expectedVersion + 1;
  const event: ConfigurationEventInput = {
    tenantId: input.tenantId,
    pipelineId: input.pipeline.pipeline_id,
    stageId: null,
    action: "pipeline_updated",
    actor: input.actor,
    pipelineVersion: nextVersion,
    detail: {
      name: input.name,
      position: input.position,
      owning_role: input.owningRole,
      is_active: input.isActive,
      card_template_changed: input.cardTemplateJson !== input.pipeline.card_template_json,
    },
    occurredAt,
  };
  const seal = await commandSeal(event);
  const results = await configurationBatch(env, [
    env.DB.prepare(
      `UPDATE pipelines
          SET name = ?, position = ?, owning_role = ?, is_active = ?, card_template_json = ?,
              version = version + 1, updated_at = ?, configuration_marker = ?
        WHERE tenant_id = ? AND pipeline_id = ? AND version = ?`,
    ).bind(
      input.name,
      input.position,
      input.owningRole,
      input.isActive ? 1 : 0,
      input.cardTemplateJson,
      occurredAt,
      seal.marker,
      input.tenantId,
      input.pipeline.pipeline_id,
      input.expectedVersion,
    ),
    configurationEventStatement(env, event, seal),
  ]);
  if (changes(results[0]) !== 1) throw new PipelineStoreError("pipeline_version_conflict");
  if (changes(results[1]) !== 1) throw new PipelineStoreError("pipeline_write_failed");

  const updated = await getPipeline(env, input.tenantId, input.pipeline.pipeline_id);
  if (!updated) throw new PipelineStoreError("pipeline_write_failed");
  return updated;
}

export interface ReorderPipelinesInput {
  tenantId: string;
  /** The complete intended order; index becomes `position`. */
  order: ReadonlyArray<{ pipelineId: string; expectedVersion: number }>;
  actor: PipelineAdminActor;
}

export async function reorderPipelines(
  env: AppEnv,
  input: ReorderPipelinesInput,
  now = new Date(),
): Promise<PipelineRecord[]> {
  const occurredAt = now.toISOString();
  const statements = [];
  for (const [index, entry] of input.order.entries()) {
    const event: ConfigurationEventInput = {
      tenantId: input.tenantId,
      pipelineId: entry.pipelineId,
      stageId: null,
      action: "pipelines_reordered",
      actor: input.actor,
      pipelineVersion: entry.expectedVersion + 1,
      detail: { position: index },
      occurredAt,
    };
    const seal = await commandSeal(event);
    statements.push(
      env.DB.prepare(
        `UPDATE pipelines
            SET position = ?, version = version + 1, updated_at = ?, configuration_marker = ?
          WHERE tenant_id = ? AND pipeline_id = ? AND version = ?`,
      ).bind(
        index,
        occurredAt,
        seal.marker,
        input.tenantId,
        entry.pipelineId,
        entry.expectedVersion,
      ),
    );
    statements.push(configurationEventStatement(env, event, seal));
  }
  const results = await configurationBatch(env, statements);
  for (const [index, result] of results.entries())
    if (changes(result) !== 1)
      throw new PipelineStoreError(
        index % 2 === 0 ? "pipeline_version_conflict" : "pipeline_write_failed",
      );
  return await listPipelinesForAdmin(env, input.tenantId);
}

export interface AddStageInput {
  tenantId: string;
  pipelineId: string;
  expectedVersion: number;
  stage: PipelineStageInput;
  pipelineKey: string;
  /** Appended after the current live stages; the administrator reorders afterwards. */
  position: number;
  actor: PipelineAdminActor;
}

export async function addStage(
  env: AppEnv,
  input: AddStageInput,
  now = new Date(),
): Promise<PipelineStageRecord> {
  const occurredAt = now.toISOString();
  const nextVersion = input.expectedVersion + 1;
  const stageId = await stageIdFor(input.tenantId, input.pipelineKey, input.stage.key);
  const event: ConfigurationEventInput = {
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    stageId,
    action: "stage_added",
    actor: input.actor,
    pipelineVersion: nextVersion,
    detail: { key: input.stage.key, name: input.stage.name, position: input.position },
    occurredAt,
  };
  const seal = await commandSeal(event);
  const results = await configurationBatch(env, [
    pipelineCasStatement(
      env,
      input.tenantId,
      input.pipelineId,
      input.expectedVersion,
      seal.marker,
      occurredAt,
    ),
    stageInsertStatement(
      env,
      input.tenantId,
      input.pipelineId,
      nextVersion,
      seal.marker,
      stageId,
      input.stage,
      input.position,
      occurredAt,
    ),
    configurationEventStatement(env, event, seal),
  ]);
  if (changes(results[0]) !== 1) throw new PipelineStoreError("pipeline_version_conflict");
  if (changes(results[1]) !== 1 || changes(results[2]) !== 1)
    throw new PipelineStoreError("pipeline_write_failed");

  const stage = await getStage(env, input.tenantId, input.pipelineId, stageId);
  if (!stage) throw new PipelineStoreError("pipeline_write_failed");
  return stage;
}

export interface UpdateStageInput {
  tenantId: string;
  pipelineId: string;
  stageId: string;
  expectedVersion: number;
  name: string;
  color: string | null;
  isWon: boolean;
  isLost: boolean;
  minRoleToEnter: string | null;
  isActive: boolean;
  actor: PipelineAdminActor;
}

export async function updateStage(
  env: AppEnv,
  input: UpdateStageInput,
  now = new Date(),
): Promise<PipelineStageRecord> {
  const occurredAt = now.toISOString();
  const nextVersion = input.expectedVersion + 1;
  const event: ConfigurationEventInput = {
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    action: "stage_updated",
    actor: input.actor,
    pipelineVersion: nextVersion,
    detail: {
      name: input.name,
      color: input.color,
      is_won: input.isWon,
      is_lost: input.isLost,
      min_role_to_enter: input.minRoleToEnter,
      is_active: input.isActive,
    },
    occurredAt,
  };
  const seal = await commandSeal(event);
  const results = await configurationBatch(env, [
    pipelineCasStatement(
      env,
      input.tenantId,
      input.pipelineId,
      input.expectedVersion,
      seal.marker,
      occurredAt,
    ),
    env.DB.prepare(
      `UPDATE pipeline_stages
          SET name = ?, color = ?, is_won = ?, is_lost = ?, min_role_to_enter = ?, is_active = ?,
              version = version + 1, updated_at = ?
        WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ?
          AND EXISTS (
            SELECT 1 FROM pipelines p
             WHERE p.tenant_id = pipeline_stages.tenant_id
               AND p.pipeline_id = pipeline_stages.pipeline_id
               AND p.version = ? AND p.configuration_marker = ?
          )`,
    ).bind(
      input.name,
      input.color,
      input.isWon ? 1 : 0,
      input.isLost ? 1 : 0,
      input.minRoleToEnter,
      input.isActive ? 1 : 0,
      occurredAt,
      input.tenantId,
      input.pipelineId,
      input.stageId,
      nextVersion,
      seal.marker,
    ),
    configurationEventStatement(env, event, seal),
  ]);
  if (changes(results[0]) !== 1) throw new PipelineStoreError("pipeline_version_conflict");
  if (changes(results[1]) !== 1 || changes(results[2]) !== 1)
    throw new PipelineStoreError("pipeline_write_failed");

  const stage = await getStage(env, input.tenantId, input.pipelineId, input.stageId);
  if (!stage) throw new PipelineStoreError("pipeline_write_failed");
  return stage;
}

export interface ReorderStagesInput {
  tenantId: string;
  pipelineId: string;
  expectedVersion: number;
  /** The complete intended order of the pipeline's live stages; index becomes `position`. */
  stageIds: readonly string[];
  actor: PipelineAdminActor;
}

/**
 * Reordering writes positions 0..n-1 in one batch.  Adjacency is read from the ORDERED stage list
 * rather than from the raw `position` value (0113), so this never has to invent a temporary value
 * to dodge a collision, and a board mid-reorder can never make a one-step move look like a skip.
 */
export async function reorderStages(
  env: AppEnv,
  input: ReorderStagesInput,
  now = new Date(),
): Promise<PipelineStageRecord[]> {
  const occurredAt = now.toISOString();
  const nextVersion = input.expectedVersion + 1;
  const event: ConfigurationEventInput = {
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    stageId: null,
    action: "stages_reordered",
    actor: input.actor,
    pipelineVersion: nextVersion,
    detail: await boundedStageOrderDetail(input.stageIds),
    occurredAt,
  };
  const seal = await commandSeal(event);
  const statements = [
    pipelineCasStatement(
      env,
      input.tenantId,
      input.pipelineId,
      input.expectedVersion,
      seal.marker,
      occurredAt,
    ),
  ];
  for (const [index, stageId] of input.stageIds.entries())
    statements.push(
      env.DB.prepare(
        `UPDATE pipeline_stages
            SET position = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ? AND is_active = 1
            AND EXISTS (
              SELECT 1 FROM pipelines p
               WHERE p.tenant_id = pipeline_stages.tenant_id
                 AND p.pipeline_id = pipeline_stages.pipeline_id
                 AND p.version = ? AND p.configuration_marker = ?
            )`,
      ).bind(
        index,
        occurredAt,
        input.tenantId,
        input.pipelineId,
        stageId,
        nextVersion,
        seal.marker,
      ),
    );
  statements.push(configurationEventStatement(env, event, seal));

  const results = await configurationBatch(env, statements);
  if (changes(results[0]) !== 1) throw new PipelineStoreError("pipeline_version_conflict");
  for (const result of results.slice(1))
    if (changes(result) !== 1) throw new PipelineStoreError("pipeline_write_failed");
  return await listStages(env, input.tenantId, input.pipelineId);
}

export interface RemoveStageInput {
  tenantId: string;
  pipelineId: string;
  stageId: string;
  expectedVersion: number;
  /** Where the stage's cards go first; `null` only when the stage is already empty. */
  moveCardsToStageId: string | null;
  cardCount: number;
  /** Archive instead of delete: the append-only trail already names this stage. */
  archiveOnly: boolean;
  actor: PipelineAdminActor;
}

export interface RemoveStageResult {
  outcome: "deleted" | "archived";
  moved_cards: number;
  stages: PipelineStageRecord[];
}

/**
 * Remove a stage, honestly.
 *
 * Three facts decide what "remove" means, and none of them is a cascade:
 *
 *   - cards still in the stage are re-homed first, in the SAME batch, to the destination the
 *     administrator named.  Without a destination the caller never reaches here: the route refuses
 *     with the exact card count, because deleting work in progress silently is not a feature.
 *   - each re-homed card gets its own append-only transition row, so the board's history says
 *     where the work went and why.  No automation-outbox row is written: reshaping a board is a
 *     configuration change, not a business event, and M4 rules fire on work moving, not on an
 *     administrator tidying columns.
 *   - a stage the trail already names is archived rather than deleted.  The audit rows hold
 *     ON DELETE RESTRICT edges to it and are not rewritable, so archiving is the only removal that
 *     does not destroy evidence.  A stage nothing ever touched is deleted outright.
 */
export async function removeStage(
  env: AppEnv,
  input: RemoveStageInput,
  now = new Date(),
): Promise<RemoveStageResult> {
  const occurredAt = now.toISOString();
  const nextVersion = input.expectedVersion + 1;
  const archiveOnly = input.archiveOnly || input.cardCount > 0;
  const event: ConfigurationEventInput = {
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    stageId: input.stageId,
    action: archiveOnly ? "stage_archived" : "stage_removed",
    actor: input.actor,
    pipelineVersion: nextVersion,
    detail: {
      // What was true when the command was ACCEPTED. The number of cards this batch re-homes is
      // fixed by the snapshot; if any card leaves or changes before commit, its in-batch receipt
      // proof fails and the entire command rolls back rather than claiming a partial move.
      card_count_at_command: input.cardCount,
      moved_to_stage_id: input.cardCount > 0 ? input.moveCardsToStageId : null,
    },
    occurredAt,
  };
  const seal = await commandSeal(event);
  const statements = [
    pipelineCasStatement(
      env,
      input.tenantId,
      input.pipelineId,
      input.expectedVersion,
      seal.marker,
      occurredAt,
    ),
  ];

  const movedCards: PipelineCardRecord[] = [];
  if (input.cardCount > 0 && input.moveCardsToStageId) {
    const cards = await env.DB.prepare(
      `SELECT * FROM pipeline_cards
        WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ?
        ORDER BY position_in_stage ASC, card_id ASC`,
    )
      .bind(input.tenantId, input.pipelineId, input.stageId)
      .all<PipelineCardRecord>();
    movedCards.push(...cards.results);
    let position = await nextPositionInStage(
      env,
      input.tenantId,
      input.pipelineId,
      input.moveCardsToStageId,
    );
    for (const card of movedCards) {
      const transitionId = `pct_${(
        await sha256Hex(`${input.tenantId}:${card.card_id}:stage-removed:${nextVersion}`)
      ).slice(0, 40)}`;
      const idempotencyKeyHash = await sha256Hex(
        `pipeline-stage-removal:${input.tenantId}:${input.pipelineId}:${input.stageId}:${card.card_id}:${nextVersion}`,
      );
      const commandFingerprint = await pipelineCommandFingerprint({
        operation: "transition",
        tenantId: input.tenantId,
        pipelineId: input.pipelineId,
        cardId: card.card_id,
        toStageId: input.moveCardsToStageId,
        expectedVersion: card.version,
        safeguard: "confirmed",
        reasonCode: "stage_removed",
        correlationId: null,
        actorType: input.actor.role === "owner" ? "owner" : "worker",
        actorId: input.actor.userId,
        rawConfirmation: true,
        undoTransitionId: null,
        entityType: null,
        entityId: null,
      });
      statements.push(
        env.DB.prepare(
          `UPDATE pipeline_cards
              SET stage_id = ?, position_in_stage = ?, stage_entered_at = ?, version = version + 1,
                  updated_at = ?, last_transition_id = ?
            WHERE tenant_id = ? AND pipeline_id = ? AND card_id = ? AND version = ?
              AND EXISTS (
                SELECT 1 FROM pipelines p
                 WHERE p.tenant_id = pipeline_cards.tenant_id
                   AND p.pipeline_id = pipeline_cards.pipeline_id
                   AND p.version = ? AND p.configuration_marker = ?
              )
              AND EXISTS (
                SELECT 1 FROM pipeline_stages destination
                 WHERE destination.tenant_id = pipeline_cards.tenant_id
                   AND destination.pipeline_id = pipeline_cards.pipeline_id
                   AND destination.stage_id = ?
                   AND destination.is_active = 1
              )`,
        ).bind(
          input.moveCardsToStageId,
          position,
          occurredAt,
          occurredAt,
          transitionId,
          input.tenantId,
          input.pipelineId,
          card.card_id,
          card.version,
          nextVersion,
          seal.marker,
          input.moveCardsToStageId,
        ),
      );
      statements.push(
        env.DB.prepare(
          `INSERT INTO pipeline_card_transitions (
             transition_id, tenant_id, pipeline_id, card_id, from_stage_id, to_stage_id,
             actor_type, actor_id, safeguard, reason_code, correlation_id,
             command_fingerprint, idempotency_key_hash, card_version, occurred_at, created_at
           )
           SELECT ?,
              CASE WHEN EXISTS (
                SELECT 1 FROM pipeline_cards card
                 WHERE card.tenant_id = ? AND card.pipeline_id = ? AND card.card_id = ?
                   AND card.version = ? AND card.stage_id = ? AND card.last_transition_id = ?
              ) THEN ? ELSE NULL END,
              ?, ?, ?, ?, ?, ?, 'confirmed', 'stage_removed', NULL, ?, ?, ?, ?, ?
             FROM (SELECT 1)`,
        ).bind(
          transitionId,
          input.tenantId,
          input.pipelineId,
          card.card_id,
          card.version + 1,
          input.moveCardsToStageId,
          transitionId,
          input.tenantId,
          input.pipelineId,
          card.card_id,
          input.stageId,
          input.moveCardsToStageId,
          input.actor.role === "owner" ? "owner" : "worker",
          input.actor.userId,
          commandFingerprint,
          idempotencyKeyHash,
          card.version + 1,
          occurredAt,
          occurredAt,
        ),
      );
      position = Math.min(position + PIPELINE_CARD_POSITION_STEP, 1_000_000_000);
    }
  }

  // The stage only leaves the board once it is EMPTY at commit time.  A card moved into it while
  // this command was being assembled would otherwise be stranded in a column nobody can see, so
  // the guard is here rather than only in the route's pre-read.
  const emptyStage = `NOT EXISTS (
                SELECT 1 FROM pipeline_cards c
                 WHERE c.tenant_id = ? AND c.pipeline_id = ? AND c.stage_id = ?
              )`;
  statements.push(
    archiveOnly
      ? env.DB.prepare(
          `UPDATE pipeline_stages
              SET is_active = 0, version = version + 1, updated_at = ?
            WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ? AND is_active = 1
              AND EXISTS (
                SELECT 1 FROM pipelines p
                 WHERE p.tenant_id = pipeline_stages.tenant_id
                   AND p.pipeline_id = pipeline_stages.pipeline_id
                   AND p.version = ? AND p.configuration_marker = ?
              )
              AND ${emptyStage}`,
        ).bind(
          occurredAt,
          input.tenantId,
          input.pipelineId,
          input.stageId,
          nextVersion,
          seal.marker,
          input.tenantId,
          input.pipelineId,
          input.stageId,
        )
      : env.DB.prepare(
          `DELETE FROM pipeline_stages
            WHERE tenant_id = ? AND pipeline_id = ? AND stage_id = ?
              AND EXISTS (
                SELECT 1 FROM pipelines p
                 WHERE p.tenant_id = pipeline_stages.tenant_id
                   AND p.pipeline_id = pipeline_stages.pipeline_id
                   AND p.version = ? AND p.configuration_marker = ?
              )
              AND ${emptyStage}`,
        ).bind(
          input.tenantId,
          input.pipelineId,
          input.stageId,
          nextVersion,
          seal.marker,
          input.tenantId,
          input.pipelineId,
          input.stageId,
        ),
  );
  // The evidence row is predicated on the removal itself, not merely on the version the command
  // reached: an event that says "archived" while the stage is still live would be a lie the audit
  // trail can never take back.
  statements.push(
    configurationEventStatement(
      env,
      event,
      seal,
      archiveOnly
        ? {
            sql: `EXISTS (SELECT 1 FROM pipeline_stages s
                           WHERE s.tenant_id = ? AND s.pipeline_id = ? AND s.stage_id = ?
                             AND s.is_active = 0)`,
            params: [input.tenantId, input.pipelineId, input.stageId],
          }
        : {
            sql: `NOT EXISTS (SELECT 1 FROM pipeline_stages s
                               WHERE s.tenant_id = ? AND s.pipeline_id = ? AND s.stage_id = ?)`,
            params: [input.tenantId, input.pipelineId, input.stageId],
          },
    ),
  );

  const results = await configurationBatch(env, statements, "pipeline_stage_changed");
  if (changes(results[0]) !== 1) throw new PipelineStoreError("pipeline_version_conflict");

  // Each re-homed card contributes a (card update, transition insert) pair.  The transition insert
  // is an in-batch proof of the card update, so a card that changed after the snapshot aborts the
  // whole batch before this postcondition is reached.  A pair that DISAGREES is therefore a server
  // fault, never a partially committed move.
  let moved = 0;
  for (let index = 0; index < movedCards.length; index += 1) {
    const cardChanges = changes(results[1 + index * 2]);
    const auditChanges = changes(results[2 + index * 2]);
    if (cardChanges !== auditChanges) throw new PipelineStoreError("pipeline_write_failed");
    moved += cardChanges;
  }
  const removal = results[1 + movedCards.length * 2];
  if (changes(removal) !== 1) throw new PipelineStoreError("pipeline_stage_changed");
  if (changes(results[2 + movedCards.length * 2]) !== 1)
    throw new PipelineStoreError("pipeline_write_failed");

  return {
    outcome: archiveOnly ? "archived" : "deleted",
    moved_cards: moved,
    stages: await listStages(env, input.tenantId, input.pipelineId),
  };
}

export interface ReplaceRoleGrantsInput {
  tenantId: string;
  pipelineId: string;
  expectedVersion: number;
  grants: readonly PipelineRoleGrantInput[];
  actor: PipelineAdminActor;
}

/**
 * Replaces a pipeline's whole role-scope set under the pipeline's own version CAS.  Replace, not
 * merge: an administrator looking at the scope list is looking at the complete answer, and a
 * partial update would let a role survive a removal the administrator believed they had made.
 */
export async function replaceRoleGrants(
  env: AppEnv,
  input: ReplaceRoleGrantsInput,
  now = new Date(),
): Promise<PipelineRoleGrantRecord[]> {
  const occurredAt = now.toISOString();
  const nextVersion = input.expectedVersion + 1;
  const event: ConfigurationEventInput = {
    tenantId: input.tenantId,
    pipelineId: input.pipelineId,
    stageId: null,
    action: "role_grants_replaced",
    actor: input.actor,
    pipelineVersion: nextVersion,
    detail: {
      grants: input.grants.map((grant) => ({ role: grant.role, can_write: grant.can_write })),
    },
    occurredAt,
  };
  const seal = await commandSeal(event);
  const statements = [
    pipelineCasStatement(
      env,
      input.tenantId,
      input.pipelineId,
      input.expectedVersion,
      seal.marker,
      occurredAt,
    ),
    env.DB.prepare(
      `DELETE FROM pipeline_role_grants
        WHERE tenant_id = ? AND pipeline_id = ?
          AND EXISTS (
            SELECT 1 FROM pipelines p
             WHERE p.tenant_id = pipeline_role_grants.tenant_id
               AND p.pipeline_id = pipeline_role_grants.pipeline_id
               AND p.version = ? AND p.configuration_marker = ?
          )`,
    ).bind(input.tenantId, input.pipelineId, nextVersion, seal.marker),
  ];
  const inserts = await roleGrantStatements(
    env,
    input.tenantId,
    input.pipelineId,
    nextVersion,
    seal.marker,
    input.grants,
    input.actor,
    occurredAt,
  );
  statements.push(...inserts);
  statements.push(configurationEventStatement(env, event, seal));

  const results = await configurationBatch(env, statements);
  if (changes(results[0]) !== 1) throw new PipelineStoreError("pipeline_version_conflict");
  // The DELETE legitimately matches zero rows on a pipeline that had no grants yet.
  for (const result of results.slice(2))
    if (changes(result) !== 1) throw new PipelineStoreError("pipeline_write_failed");
  return await listRoleGrants(env, input.tenantId, input.pipelineId);
}
