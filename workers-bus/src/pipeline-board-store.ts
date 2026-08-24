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
  PIPELINE_CARD_POSITION_STEP,
  type PipelineCardRecord,
  type PipelineRecord,
  type PipelineRelationBag,
  type PipelineSafeguard,
  type PipelineStageRecord,
  type PipelineTransitionRecord,
} from "./pipeline-board.ts";

const MAX_BOARD_CARDS = 500;
const MAX_IN_CHUNK = 100;

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
  /** Batched relation lookups; each returns rows keyed by the card's `entity_id`. */
  resolvers: Record<string, (env: AppEnv, tenantId: string, ids: string[]) => Promise<Map<string, Record<string, unknown>>>>;
}

const ENTITY_REGISTRY: Readonly<Record<string, PipelineEntityAdapter>> = {
  lead: {
    table: "operating_leads",
    idColumn: "lead_id",
    resolvers: {
      entity: (env, tenantId, ids) =>
        rowsByKey(env, tenantId, "operating_leads", "lead_id", "lead_id", ids),
      job: (env, tenantId, ids) =>
        rowsByKey(env, tenantId, "operating_roof_jobs", "lead_id", "lead_id", ids, "created_at ASC"),
      estimate: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_instant_estimates",
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
    resolvers: {
      entity: (env, tenantId, ids) =>
        rowsByKey(env, tenantId, "operating_roof_jobs", "roof_job_id", "roof_job_id", ids),
      job: (env, tenantId, ids) =>
        rowsByKey(env, tenantId, "operating_roof_jobs", "roof_job_id", "roof_job_id", ids),
      estimate: (env, tenantId, ids) =>
        rowsByKey(
          env,
          tenantId,
          "operating_instant_estimates",
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
  keyColumn: string,
  aliasColumn: string,
  ids: readonly string[],
  order?: string,
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const chunk of chunked(ids)) {
    const rows = await env.DB.prepare(
      `SELECT * FROM ${table}
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
      `SELECT job.lead_id AS lead_id, quote.*
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

export async function listPipelines(
  env: AppEnv,
  tenantId: string,
): Promise<PipelineRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipelines
      WHERE tenant_id = ? AND is_active = 1 AND is_template = 0
      ORDER BY position ASC, key ASC
      LIMIT 100`,
  )
    .bind(tenantId)
    .all<PipelineRecord>();
  return rows.results;
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

/** The board's ordered stage list.  This order, not the raw `position`, defines adjacency. */
export async function listStages(
  env: AppEnv,
  tenantId: string,
  pipelineId: string,
): Promise<PipelineStageRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pipeline_stages
      WHERE tenant_id = ? AND pipeline_id = ?
      ORDER BY position ASC, key ASC
      LIMIT 200`,
  )
    .bind(tenantId, pipelineId)
    .all<PipelineStageRecord>();
  return rows.results;
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
  // transaction, but a WHERE that matches nothing is not an error: without these guards a stale
  // `expected_version` would still commit an audit row describing a move that never happened.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE pipeline_cards
          SET stage_id = ?, position_in_stage = ?, stage_entered_at = ?, version = version + 1,
              updated_at = ?, last_transition_id = ?
        WHERE tenant_id = ? AND pipeline_id = ? AND card_id = ? AND version = ?`,
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
    ),
    env.DB.prepare(
      `INSERT INTO pipeline_card_transitions (
         transition_id, tenant_id, pipeline_id, card_id, from_stage_id, to_stage_id,
         actor_type, actor_id, safeguard, reason_code, correlation_id,
         command_fingerprint, idempotency_key_hash, card_version, occurred_at, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM pipeline_cards card
        WHERE card.tenant_id = ? AND card.pipeline_id = ? AND card.card_id = ?
          AND card.version = ? AND card.stage_id = ? AND card.last_transition_id = ?`,
    ).bind(
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
      input.tenantId,
      input.pipelineId,
      input.card.card_id,
      cardVersion,
      input.toStageId,
      transitionId,
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

  // D1 reports zero changed rows as a successful statement.  The marker makes the transition
  // INSERT zero-row only for this stale writer, never for the winner's already-advanced state.
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

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pipeline_cards (
         card_id, tenant_id, pipeline_id, stage_id, entity_type, entity_id,
         position_in_stage, stage_entered_at, version, last_transition_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      cardId,
      input.tenantId,
      input.pipelineId,
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

  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[2]) !== 1)
    throw new PipelineStoreError("pipeline_card_write_failed");

  const card = await getCard(env, input.tenantId, input.pipelineId, cardId);
  if (!card) throw new PipelineStoreError("pipeline_card_write_failed");
  return { kind: "created", card, transition: await getTransition(env, input.tenantId, transitionId) };
}
