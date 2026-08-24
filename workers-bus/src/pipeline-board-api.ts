/**
 * `/api/v1/pipelines` - the generic pipeline board API (IRO-209).
 *
 * The safe-movement contract is enforced HERE, before anything commits: the client mirrors these
 * rules for a responsive drag, it does not own them.  A UI-only confirmation satisfies nothing.
 */

import { validAppCsrf } from "./app-auth.ts";
import {
  buildPipelineBoardReadModel,
  buildPipelineListReadModel,
  PipelineReadModelError,
} from "./app-read-models.ts";
import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  canMoveCards,
  canViewPipeline,
  evaluateSafeguard,
  PIPELINE_UNDO_WINDOW_MS,
  transitionActorType,
  type PipelineStageRecord,
} from "./pipeline-board.ts";
import {
  commitCardTransition,
  getCard,
  getPipeline,
  findTransitionByIdempotencyKey,
  getTransition,
  knownEntityType,
  latestTransition,
  listStages,
  PipelineStoreError,
  placeCard,
  undoAlreadyRecorded,
} from "./pipeline-board-store.ts";

const MAX_PIPELINE_BODY_BYTES = 4 * 1024;

const BOARD_ROUTE = /^\/api\/v1\/pipelines\/([^/]+)\/board$/;
const CARDS_ROUTE = /^\/api\/v1\/pipelines\/([^/]+)\/cards$/;
const TRANSITIONS_ROUTE = /^\/api\/v1\/pipelines\/([^/]+)\/cards\/([^/]+)\/transitions$/;
const UNDO_ROUTE =
  /^\/api\/v1\/pipelines\/([^/]+)\/cards\/([^/]+)\/transitions\/([^/]+)\/undo$/;

/**
 * Returns `null` when the path is not ours, so `handleAuthenticatedRoute` keeps walking its chain
 * the same way the safety and inventory sub-routers behave.
 */
export async function handlePipelineRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  now: Date = new Date(),
): Promise<Response | null> {
  const url = new URL(req.url);
  if (
    url.pathname !== "/api/v1/pipelines" &&
    !url.pathname.startsWith("/api/v1/pipelines/")
  )
    return null;

  if (req.method === "GET" && url.pathname === "/api/v1/pipelines") {
    if (!boardReader(auth)) return json({ error: "pipeline_read_forbidden" }, 403);
    return json(await buildPipelineListReadModel(env, auth));
  }

  const board = url.pathname.match(BOARD_ROUTE);
  if (board && req.method === "GET") return await handleBoardRead(env, auth, board[1] ?? "");

  const cards = url.pathname.match(CARDS_ROUTE);
  if (cards && req.method === "POST")
    return await handleCardPlacement(req, env, auth, cards[1] ?? "", now);

  const transitions = url.pathname.match(TRANSITIONS_ROUTE);
  if (transitions && req.method === "POST")
    return await handleTransition(req, env, auth, transitions[1] ?? "", transitions[2] ?? "", now);

  const undo = url.pathname.match(UNDO_ROUTE);
  if (undo && req.method === "POST")
    return await handleUndo(req, env, auth, undo[1] ?? "", undo[2] ?? "", undo[3] ?? "", now);

  return json({ error: "not_found" }, 404);
}

async function handleBoardRead(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
): Promise<Response> {
  if (!boardReader(auth)) return json({ error: "pipeline_read_forbidden" }, 403);
  const pipelineId = decoded(encodedPipelineId);
  if (!pipelineId) return json({ error: "not_found" }, 404);
  const pipeline = await getPipeline(env, auth.session.tenant_id, pipelineId);
  // An unreadable pipeline and a missing one answer the same way: a board this session may not see
  // must not be discoverable by probing ids.
  if (!pipeline || !canViewPipeline(auth, pipeline))
    return json({ error: "not_found" }, 404);
  try {
    return json(await buildPipelineBoardReadModel(env, auth, pipeline));
  } catch (error) {
    if (error instanceof PipelineReadModelError)
      return json({ error: error.code }, error.code === "pipeline_read_forbidden" ? 403 : 409);
    throw error;
  }
}

/**
 * Puts an entity on a board.  Without this an M1 board could only ever be empty: leads land in the
 * operating core through ingest, and nothing else in the product knows how to give one a card.
 * The route is deliberately generic - it takes an entity type and an id, and the registry decides
 * whether that pair is real in this tenant.
 */
async function handleCardPlacement(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  now: Date,
): Promise<Response> {
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,140}$/.test(idempotencyKey))
    return json({ error: "idempotency_key_required" }, 400);
  const pipelineId = decoded(encodedPipelineId);
  if (!pipelineId) return json({ error: "not_found" }, 404);
  const pipeline = await getPipeline(env, auth.session.tenant_id, pipelineId);
  if (!pipeline || !canViewPipeline(auth, pipeline)) return json({ error: "not_found" }, 404);
  if (!canMoveCards(auth, pipeline)) return json({ error: "pipeline_move_forbidden" }, 403);

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value as Record<string, unknown> | null;
  const entityType = typeof body?.entity_type === "string" ? body.entity_type.trim() : "";
  const entityId = typeof body?.entity_id === "string" ? body.entity_id.trim() : "";
  if (!knownEntityType(entityType) || entityId.length < 1 || entityId.length > 200)
    return json({ error: "invalid_pipeline_card" }, 400);
  // A pipeline declares the entity kind its cards bind to; a card of another kind belongs on
  // another board, not this one.
  if (entityType !== pipeline.entity_type)
    return json({ error: "pipeline_entity_type_mismatch" }, 409);

  const stages = await listStages(env, auth.session.tenant_id, pipeline.pipeline_id);
  if (stages.length === 0) return json({ error: "not_found" }, 404);
  const requestedKey = typeof body?.stage_key === "string" ? body.stage_key.trim() : "";
  const stage = requestedKey
    ? stages.find((candidate) => candidate.key === requestedKey)
    : stages[0];
  if (!stage) return json({ error: "not_found" }, 404);

  try {
    const result = await placeCard(
      env,
      {
        tenantId: auth.session.tenant_id,
        pipelineId: pipeline.pipeline_id,
        stageId: stage.stage_id,
        entityType,
        entityId,
        actorType: transitionActorType(auth.session.role),
        actorId: auth.session.user_id,
        idempotencyKey,
      },
      now,
    );
    return json(
      {
        card_id: result.card.card_id,
        pipeline_id: result.card.pipeline_id,
        stage_id: result.card.stage_id,
        entity_type: result.card.entity_type,
        entity_id: result.card.entity_id,
        card_version: result.card.version,
        transition_id: result.transition?.transition_id ?? null,
        replayed: result.kind === "replayed",
      },
      result.kind === "created" ? 201 : 200,
    );
  } catch (error) {
    return storeFailure(error);
  }
}

async function handleTransition(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  encodedCardId: string,
  now: Date,
): Promise<Response> {
  const preflight = await mutationPreflight(req, env, auth, encodedPipelineId, encodedCardId);
  if ("response" in preflight) return preflight.response;
  const { pipeline, card, stages, idempotencyKey } = preflight;

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const input = parseTransitionBody(parsed.value);
  if (!input) return json({ error: "invalid_pipeline_transition" }, 400);

  const toStage = stages.find((stage) => stage.stage_id === input.toStageId);
  if (!toStage) return json({ error: "not_found" }, 404);

  // A retry is answered before the CAS check, otherwise a client whose response was dropped would
  // be told its own committed move conflicts with itself.  The store owns the full intent check.
  try {
    const replay = await findTransitionByIdempotencyKey(env, auth.session.tenant_id, idempotencyKey, {
      operation: "transition",
      tenantId: auth.session.tenant_id,
      pipelineId: pipeline.pipeline_id,
      cardId: card.card_id,
      toStageId: input.toStageId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode,
      correlationId: null,
      actorType: transitionActorType(auth.session.role),
      actorId: auth.session.user_id,
      rawConfirmation: input.rawConfirmation,
      undoTransitionId: null,
      entityType: null,
      entityId: null,
    });
    if (replay) return json(transitionPayload(replay, replay.card_version, true));
  } catch (error) {
    return storeFailure(error);
  }
  if (card.version !== input.expectedVersion)
    return json({ error: "pipeline_card_version_conflict", card_version: card.version }, 409);

  const decision = evaluateSafeguard({
    stageOrder: stages,
    fromStageId: card.stage_id,
    toStageId: input.toStageId,
    actorRole: auth.session.role,
    confirmed: input.confirmed,
  });
  if (decision.outcome === "noop") return json({ error: "pipeline_transition_noop" }, 409);
  if (decision.outcome === "stage_entry_role_required")
    return json(
      { error: "stage_entry_role_required", required_role: decision.requiredRole },
      403,
    );
  if (decision.outcome === "confirmation_required")
    return json(
      {
        error: "confirmation_required",
        jump: decision.jump,
        from_stage: stageDigest(stages, card.stage_id),
        to_stage: stageDigest(stages, input.toStageId),
      },
      409,
    );

  try {
    const result = await commitCardTransition(
      env,
      {
        tenantId: auth.session.tenant_id,
        pipelineId: pipeline.pipeline_id,
        card,
        toStageId: input.toStageId,
        expectedVersion: input.expectedVersion,
        safeguard: decision.safeguard,
        reasonCode: input.reasonCode,
        correlationId: null,
        actorType: transitionActorType(auth.session.role),
        actorId: auth.session.user_id,
        idempotencyKey,
        rawConfirmation: input.rawConfirmation,
        undoTransitionId: null,
      },
      now,
    );
    return json(transitionPayload(result.transition, result.cardVersion, result.kind === "replayed"));
  } catch (error) {
    return storeFailure(error);
  }
}

async function handleUndo(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  encodedCardId: string,
  encodedTransitionId: string,
  now: Date,
): Promise<Response> {
  const preflight = await mutationPreflight(req, env, auth, encodedPipelineId, encodedCardId);
  if ("response" in preflight) return preflight.response;
  const { pipeline, card, idempotencyKey } = preflight;

  const parsed = await readJson(req);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const expectedVersion = positiveInteger((parsed.value as Record<string, unknown>)?.expected_version);
  if (expectedVersion === null) return json({ error: "invalid_pipeline_transition" }, 400);

  const transitionId = decoded(encodedTransitionId);
  if (!transitionId) return json({ error: "not_found" }, 404);
  const undone = await getTransition(env, auth.session.tenant_id, transitionId);
  if (!undone || undone.card_id !== card.card_id) return json({ error: "not_found" }, 404);

  try {
    const replay = await findTransitionByIdempotencyKey(env, auth.session.tenant_id, idempotencyKey, {
      operation: "transition",
      tenantId: auth.session.tenant_id,
      pipelineId: pipeline.pipeline_id,
      cardId: card.card_id,
      toStageId: undone.from_stage_id ?? "",
      expectedVersion,
      reasonCode: undone.reason_code,
      correlationId: undone.transition_id,
      actorType: transitionActorType(auth.session.role),
      actorId: auth.session.user_id,
      rawConfirmation: null,
      undoTransitionId: undone.transition_id,
      entityType: null,
      entityId: null,
    });
    if (replay) return json(transitionPayload(replay, replay.card_version, true));
  } catch (error) {
    return storeFailure(error);
  }
  if (card.version !== expectedVersion)
    return json({ error: "pipeline_card_version_conflict", card_version: card.version }, 409);

  // The original actor may always take their own move back; anyone else needs the owner's reach.
  // No new fine-grained permission set ships in M1 (PO decision D8), so this is a role comparison.
  if (undone.actor_id !== auth.session.user_id && auth.session.role !== "owner")
    return json({ error: "pipeline_undo_actor_forbidden" }, 403);
  if (undone.safeguard === "undo")
    return json({ error: "pipeline_undo_not_undoable" }, 409);
  if (!undone.from_stage_id) return json({ error: "pipeline_undo_origin_unknown" }, 409);

  const elapsed = now.getTime() - Date.parse(undone.occurred_at);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > PIPELINE_UNDO_WINDOW_MS)
    return json(
      { error: "pipeline_undo_window_expired", undo_window_seconds: Math.round(PIPELINE_UNDO_WINDOW_MS / 1000) },
      409,
    );

  const latest = await latestTransition(env, auth.session.tenant_id, card.card_id);
  if (!latest || latest.transition_id !== undone.transition_id)
    return json({ error: "pipeline_undo_superseded" }, 409);
  if (await undoAlreadyRecorded(env, auth.session.tenant_id, undone.transition_id))
    return json({ error: "pipeline_undo_superseded" }, 409);

  try {
    // An undo is a transition like any other: a new append-only row back to the origin stage,
    // never a delete and never a rewrite of the row it reverses.
    const result = await commitCardTransition(
      env,
      {
        tenantId: auth.session.tenant_id,
        pipelineId: pipeline.pipeline_id,
        card,
        toStageId: undone.from_stage_id,
        expectedVersion,
        safeguard: "undo",
        reasonCode: undone.reason_code,
        correlationId: undone.transition_id,
        actorType: transitionActorType(auth.session.role),
        actorId: auth.session.user_id,
        idempotencyKey,
        rawConfirmation: null,
        undoTransitionId: undone.transition_id,
      },
      now,
    );
    return json(transitionPayload(result.transition, result.cardVersion, result.kind === "replayed"));
  } catch (error) {
    return storeFailure(error);
  }
}

type MutationPreflight =
  | { response: Response }
  | {
      pipeline: Awaited<ReturnType<typeof getPipeline>> & object;
      card: NonNullable<Awaited<ReturnType<typeof getCard>>>;
      stages: PipelineStageRecord[];
      idempotencyKey: string;
    };

/**
 * Everything a board mutation must satisfy before its body is even read: CSRF, a required
 * idempotency key, a pipeline this session may move cards on, and a card that is really in it.
 */
async function mutationPreflight(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  encodedCardId: string,
): Promise<MutationPreflight> {
  if (!validAppCsrf(req, auth)) return { response: json({ error: "csrf_failed" }, 403) };
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,140}$/.test(idempotencyKey))
    return { response: json({ error: "idempotency_key_required" }, 400) };

  const pipelineId = decoded(encodedPipelineId);
  const cardId = decoded(encodedCardId);
  if (!pipelineId || !cardId) return { response: json({ error: "not_found" }, 404) };

  const pipeline = await getPipeline(env, auth.session.tenant_id, pipelineId);
  if (!pipeline || !canViewPipeline(auth, pipeline))
    return { response: json({ error: "not_found" }, 404) };
  if (!canMoveCards(auth, pipeline))
    return { response: json({ error: "pipeline_move_forbidden" }, 403) };

  const card = await getCard(env, auth.session.tenant_id, pipeline.pipeline_id, cardId);
  if (!card) return { response: json({ error: "not_found" }, 404) };

  const stages = await listStages(env, auth.session.tenant_id, pipeline.pipeline_id);
  if (stages.length === 0) return { response: json({ error: "not_found" }, 404) };
  return { pipeline, card, stages, idempotencyKey };
}

function transitionPayload(
  transition: { transition_id: string; card_id: string; from_stage_id: string | null; to_stage_id: string; safeguard: string; correlation_id: string | null; occurred_at: string },
  cardVersion: number,
  replayed: boolean,
): Record<string, unknown> {
  return {
    transition_id: transition.transition_id,
    card_id: transition.card_id,
    from_stage_id: transition.from_stage_id,
    to_stage_id: transition.to_stage_id,
    safeguard: transition.safeguard,
    correlation_id: transition.correlation_id,
    card_version: cardVersion,
    occurred_at: transition.occurred_at,
    undo_window_seconds: Math.round(PIPELINE_UNDO_WINDOW_MS / 1000),
    replayed,
  };
}

const STORE_FAILURE_STATUS: Readonly<Record<string, number>> = {
  pipeline_entity_type_unknown: 400,
  pipeline_entity_not_found: 404,
  pipeline_transition_write_failed: 500,
  pipeline_card_write_failed: 500,
};

function storeFailure(error: unknown): Response {
  if (error instanceof PipelineStoreError)
    return json({ error: error.code }, STORE_FAILURE_STATUS[error.code] ?? 409);
  throw error;
}

function stageDigest(
  stages: readonly PipelineStageRecord[],
  stageId: string,
): Record<string, unknown> | null {
  const stage = stages.find((candidate) => candidate.stage_id === stageId);
  return stage
    ? { stage_id: stage.stage_id, key: stage.key, name: stage.name, position: stage.position }
    : null;
}

function boardReader(auth: AuthContext): boolean {
  return auth.permissions.includes("now:read");
}

function parseTransitionBody(value: unknown): {
  toStageId: string;
  expectedVersion: number;
  confirmed: boolean;
  rawConfirmation: boolean | null;
  reasonCode: string | null;
} | null {
  const body = value as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const toStageId = typeof body.to_stage_id === "string" ? body.to_stage_id.trim() : "";
  if (toStageId.length < 8 || toStageId.length > 200) return null;
  const expectedVersion = positiveInteger(body.expected_version);
  if (expectedVersion === null) return null;
  if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") return null;
  const reasonCode =
    body.reason_code === undefined || body.reason_code === null
      ? null
      : typeof body.reason_code === "string" && body.reason_code.trim().length >= 1 &&
          body.reason_code.trim().length <= 80
        ? body.reason_code.trim()
        : undefined;
  if (reasonCode === undefined) return null;
  return {
    toStageId,
    expectedVersion,
    confirmed: body.confirmed === true,
    rawConfirmation: body.confirmed === undefined ? null : body.confirmed,
    reasonCode,
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000
    ? value
    : null;
}

function decoded(value: string): string | null {
  try {
    const text = decodeURIComponent(value).trim();
    return text.length >= 1 && text.length <= 200 ? text : null;
  } catch {
    return null;
  }
}

async function readJson(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_PIPELINE_BODY_BYTES)
    return { ok: false, error: "payload_too_large", status: 413 };
  const text = await req.text();
  if (text.length > MAX_PIPELINE_BODY_BYTES)
    return { ok: false, error: "payload_too_large", status: 413 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json", status: 400 };
  }
}

function json(body: unknown, status = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  response.headers.set("cache-control", "private, no-store");
  return response;
}
