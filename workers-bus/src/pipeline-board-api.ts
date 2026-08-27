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
import { ROLE_PERMISSIONS, type AppEnv, type AuthContext } from "./app-types.ts";
import {
  canAdministerPipelines,
  canMoveCards,
  canViewPipeline,
  configColor,
  configFlag,
  configKey,
  configName,
  configPosition,
  evaluateSafeguard,
  MAX_STAGES_PER_PIPELINE,
  optionalConfigRole,
  parsePipelineCardTemplate,
  parseRoleGrantInputs,
  parseStageInput,
  parseStageInputs,
  PipelineConfigError,
  PipelineTemplateError,
  PIPELINE_UNDO_WINDOW_MS,
  transitionActorType,
  type PipelineRecord,
  type PipelineRoleAccess,
  type PipelineRoleGrantRecord,
  type PipelineStageInput,
  type PipelineStageRecord,
} from "./pipeline-board.ts";
import {
  addStage,
  cardCountsByPipeline,
  cardCountsByStage,
  cardCountsByStageForTenant,
  commitCardTransition,
  countCardsInStage,
  createPipeline,
  getCard,
  getPipeline,
  getPipelineByKey,
  findTransitionByIdempotencyKey,
  getStage,
  getTransition,
  knownEntityType,
  latestTransition,
  listPipelinesForAdmin,
  listRoleGrants,
  listStages,
  listStagesForAdmin,
  pipelineEntityTypeCatalog,
  pipelineRoleAccessFor,
  PipelineStoreError,
  placeCard,
  removeStage,
  reorderPipelines,
  reorderStages,
  replaceRoleGrants,
  roleGrantsByPipeline,
  stageHasHistory,
  stagesByPipelineForAdmin,
  undoAlreadyRecorded,
  updatePipeline,
  updateStage,
} from "./pipeline-board-store.ts";

const MAX_PIPELINE_BODY_BYTES = 4 * 1024;
/** A pipeline an administrator submits carries a stage list and a card template; the board
 * commands it later serves never carry more than one card id. */
const MAX_PIPELINE_ADMIN_BODY_BYTES = 32 * 1024;
const MAX_CARD_TEMPLATE_BYTES = 8_000;
const ADMIN_ROOT = "/api/v1/admin/pipelines";

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
  const administration = url.pathname === ADMIN_ROOT || url.pathname.startsWith(`${ADMIN_ROOT}/`);
  if (
    !administration &&
    url.pathname !== "/api/v1/pipelines" &&
    !url.pathname.startsWith("/api/v1/pipelines/")
  )
    return null;

  if (administration) return await handleAdministrationRoute(req, env, auth, url, now);

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
  const access = await pipelineRoleAccessFor(env, auth.session.tenant_id, auth.session.role);
  // An unreadable pipeline and a missing one answer the same way: a board this session may not see
  // must not be discoverable by probing ids.
  if (!pipeline || !canViewPipeline(auth, pipeline, access))
    return json({ error: "not_found" }, 404);
  try {
    return json(await buildPipelineBoardReadModel(env, auth, pipeline, access));
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
  const access = await pipelineRoleAccessFor(env, auth.session.tenant_id, auth.session.role);
  if (!pipeline || !canViewPipeline(auth, pipeline, access))
    return json({ error: "not_found" }, 404);
  if (!canMoveCards(auth, pipeline, access))
    return json({ error: "pipeline_move_forbidden" }, 403);

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
  const { pipeline, card, stages, idempotencyKey } = preflight;

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
  if (!stages.some((stage) => stage.stage_id === undone.from_stage_id))
    return json({ error: "pipeline_stage_changed" }, 409);

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
  const access = await pipelineRoleAccessFor(env, auth.session.tenant_id, auth.session.role);
  if (!pipeline || !canViewPipeline(auth, pipeline, access))
    return { response: json({ error: "not_found" }, 404) };
  if (!canMoveCards(auth, pipeline, access))
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
  limit = MAX_PIPELINE_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string; status: number }> {
  if (Number(req.headers.get("content-length") ?? "0") > limit)
    return { ok: false, error: "payload_too_large", status: 413 };
  const text = await req.text();
  if (text.length > limit)
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

/* ============================================================== administration ==============
 *
 * `/api/v1/admin/pipelines` - the surface an administrator configures boards through, WITHOUT a
 * developer and without ever seeing the Frappe desk.  It sits beside `/api/v1/admin/app-users`
 * because it answers the same class of question (how is this company shaped?), and it lives in
 * this file because it commands exactly the model the board routes above read.
 *
 * Three properties hold on every route here:
 *
 *   - authority is checked first and once (`canAdministerPipelines`), before a path is even
 *     matched against a real row, so an unauthorized session cannot map the tenant by probing;
 *   - every mutation carries the pipeline's version and lands through the CAS the schema already
 *     enforces, so a stale administration screen is refused with the exact conflict rather than
 *     silently overwriting whoever saved first;
 *   - nothing names a vertical.  Stage names, colours, entity types and role scopes are all data.
 */

const ADMIN_PIPELINE_ROUTE = new RegExp(`^${ADMIN_ROOT}/([^/]+)$`);
const ADMIN_COPY_ROUTE = new RegExp(`^${ADMIN_ROOT}/([^/]+)/copy$`);
const ADMIN_ROLES_ROUTE = new RegExp(`^${ADMIN_ROOT}/([^/]+)/roles$`);
const ADMIN_STAGES_ROUTE = new RegExp(`^${ADMIN_ROOT}/([^/]+)/stages$`);
const ADMIN_STAGE_ORDER_ROUTE = new RegExp(`^${ADMIN_ROOT}/([^/]+)/stages/order$`);
const ADMIN_STAGE_ROUTE = new RegExp(`^${ADMIN_ROOT}/([^/]+)/stages/([^/]+)$`);
const ADMIN_STAGE_REMOVE_ROUTE = new RegExp(`^${ADMIN_ROOT}/([^/]+)/stages/([^/]+)/remove$`);

async function handleAdministrationRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  url: URL,
  now: Date,
): Promise<Response> {
  if (!canAdministerPipelines(auth)) return json({ error: "pipeline_admin_forbidden" }, 403);

  if (req.method === "GET")
    return url.pathname === ADMIN_ROOT
      ? await handleAdminPipelineList(env, auth)
      : json({ error: "not_found" }, 404);
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  if (!validAppCsrf(req, auth)) return json({ error: "csrf_failed" }, 403);

  const parsed = await readJson(req, MAX_PIPELINE_ADMIN_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return json({ error: "invalid_pipeline_configuration" }, 400);

  try {
    if (url.pathname === ADMIN_ROOT) return await handleAdminPipelineCreate(env, auth, body, now);
    if (url.pathname === `${ADMIN_ROOT}/order`)
      return await handleAdminPipelineReorder(env, auth, body, now);

    // The most specific paths first: a `stages/order` request must never be read as a command
    // against a stage whose id happens to be spelled `order`.
    const stageRemove = url.pathname.match(ADMIN_STAGE_REMOVE_ROUTE);
    if (stageRemove)
      return await handleAdminStageRemove(
        env,
        auth,
        stageRemove[1] ?? "",
        stageRemove[2] ?? "",
        body,
        now,
      );
    const stageOrder = url.pathname.match(ADMIN_STAGE_ORDER_ROUTE);
    if (stageOrder) return await handleAdminStageReorder(env, auth, stageOrder[1] ?? "", body, now);
    const stage = url.pathname.match(ADMIN_STAGE_ROUTE);
    if (stage)
      return await handleAdminStageUpdate(env, auth, stage[1] ?? "", stage[2] ?? "", body, now);
    const stages = url.pathname.match(ADMIN_STAGES_ROUTE);
    if (stages) return await handleAdminStageAdd(env, auth, stages[1] ?? "", body, now);
    const roles = url.pathname.match(ADMIN_ROLES_ROUTE);
    if (roles) return await handleAdminRoleGrants(env, auth, roles[1] ?? "", body, now);
    const copy = url.pathname.match(ADMIN_COPY_ROUTE);
    if (copy) return await handleAdminPipelineCopy(env, auth, copy[1] ?? "", body, now);
    const pipeline = url.pathname.match(ADMIN_PIPELINE_ROUTE);
    if (pipeline) return await handleAdminPipelineUpdate(env, auth, pipeline[1] ?? "", body, now);
  } catch (error) {
    return administrationFailure(error);
  }
  return json({ error: "not_found" }, 404);
}

/**
 * Every board in the tenant with everything the administration screen needs to render without a
 * second request: stages (archived ones included), role scope, card counts, and the SERVER-owned
 * vocabularies - which entity types exist, and which roles a scope may name.  Those two lists are
 * published rather than hardcoded in the client so a module that registers a new entity type
 * appears in the administrator's chooser without a UI release.
 */
async function handleAdminPipelineList(env: AppEnv, auth: AuthContext): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const [pipelines, stages, grants, counts, stageCounts] = await Promise.all([
    listPipelinesForAdmin(env, tenantId),
    stagesByPipelineForAdmin(env, tenantId),
    roleGrantsByPipeline(env, tenantId),
    cardCountsByPipeline(env, tenantId),
    cardCountsByStageForTenant(env, tenantId),
  ]);

  return json({
    version: 1,
    entity_types: pipelineEntityTypeCatalog(),
    roles: Object.keys(ROLE_PERMISSIONS),
    stage_limit: MAX_STAGES_PER_PIPELINE,
    pipelines: pipelines.map((pipeline) =>
      adminPipelinePayload(
        pipeline,
        stages.get(pipeline.pipeline_id) ?? [],
        grants.get(pipeline.pipeline_id) ?? [],
        counts.get(pipeline.pipeline_id) ?? 0,
        stageCounts.get(pipeline.pipeline_id) ?? new Map(),
      ),
    ),
  });
}

async function handleAdminPipelineCreate(
  env: AppEnv,
  auth: AuthContext,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const key = configKey(body.key, "invalid_pipeline_key");
  const name = configName(body.name, "invalid_pipeline_name");
  const entityType = typeof body.entity_type === "string" ? body.entity_type.trim() : "";
  if (!knownEntityType(entityType))
    return json({ error: "pipeline_entity_type_unknown", entity_types: pipelineEntityTypeCatalog() }, 400);
  const owningRole = optionalConfigRole(body.owning_role, "invalid_pipeline_owning_role");
  const stages = parseStageInputs(body.stages);
  const grants = parseRoleGrantInputs(body.role_grants);
  validatePipelineRoles(owningRole, stages, grants);
  const cardTemplateJson = normalizedCardTemplate(body.card_template);
  const isTemplate = configFlag(body.is_template, "invalid_pipeline_configuration", false);

  if (await getPipelineByKey(env, tenantId, key))
    return json({ error: "pipeline_key_exists", key }, 409);

  const created = await createPipeline(
    env,
    {
      tenantId,
      key,
      name,
      entityType,
      owningRole,
      position:
        configPosition(body.position, "invalid_pipeline_position") ??
        (await nextPipelinePosition(env, tenantId)),
      cardTemplateJson,
      isTemplate,
      templateSourceId: null,
      stages,
      grants,
      actor: { role: auth.session.role, userId: auth.session.user_id },
      action: "pipeline_created",
    },
    now,
  );
  return json({ pipeline: await adminPipelineDetail(env, tenantId, created) }, 201);
}

/**
 * Duplicating a board.  The copy is a NORMAL pipeline from the moment it exists: `template_source_id`
 * records where its stage list came from and nothing else follows that edge, so editing the copy can
 * never reach back into the original.  Cards, transition history and counts are deliberately not
 * carried - a second office starts empty, not holding the first office's customers.
 */
async function handleAdminPipelineCopy(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const source = await adminPipeline(env, tenantId, encodedPipelineId);
  if (!source) return json({ error: "not_found" }, 404);

  const key = configKey(body.key, "invalid_pipeline_key");
  const name = configName(body.name, "invalid_pipeline_name");
  if (await getPipelineByKey(env, tenantId, key))
    return json({ error: "pipeline_key_exists", key }, 409);

  const sourceStages = await listStages(env, tenantId, source.pipeline_id);
  if (sourceStages.length === 0) return json({ error: "pipeline_stages_required" }, 409);
  const stages: PipelineStageInput[] = sourceStages.map((stage) => ({
    key: stage.key,
    name: stage.name,
    color: stage.color,
    is_won: stage.is_won === 1,
    is_lost: stage.is_lost === 1,
    min_role_to_enter: stage.min_role_to_enter,
  }));
  const grants = configFlag(body.copy_role_grants, "invalid_pipeline_configuration", true)
    ? (await listRoleGrants(env, tenantId, source.pipeline_id)).map((grant) => ({
        role: grant.role,
        can_write: grant.can_write === 1,
      }))
    : parseRoleGrantInputs(body.role_grants);
  const owningRole = Object.hasOwn(body, "owning_role")
    ? optionalConfigRole(body.owning_role, "invalid_pipeline_owning_role")
    : source.owning_role;
  validatePipelineRoles(owningRole, stages, grants);

  const copied = await createPipeline(
    env,
    {
      tenantId,
      key,
      name,
      entityType: source.entity_type,
      owningRole,
      position:
        configPosition(body.position, "invalid_pipeline_position") ??
        (await nextPipelinePosition(env, tenantId)),
      cardTemplateJson: source.card_template_json,
      isTemplate: configFlag(body.is_template, "invalid_pipeline_configuration", false),
      templateSourceId: source.pipeline_id,
      stages,
      grants,
      actor: { role: auth.session.role, userId: auth.session.user_id },
      action: "pipeline_copied",
    },
    now,
  );
  return json({ pipeline: await adminPipelineDetail(env, tenantId, copied) }, 201);
}

async function handleAdminPipelineUpdate(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const pipeline = await adminPipeline(env, tenantId, encodedPipelineId);
  if (!pipeline) return json({ error: "not_found" }, 404);
  const expectedVersion = expectedPipelineVersion(body);
  const conflict = versionConflict(pipeline, expectedVersion);
  if (conflict) return conflict;

  const owningRole = Object.hasOwn(body, "owning_role")
    ? optionalConfigRole(body.owning_role, "invalid_pipeline_owning_role")
    : pipeline.owning_role;
  validatePipelineRoles(owningRole, [], []);

  const updated = await updatePipeline(
    env,
    {
      tenantId,
      pipeline,
      expectedVersion,
      name: Object.hasOwn(body, "name")
        ? configName(body.name, "invalid_pipeline_name")
        : pipeline.name,
      position:
        configPosition(body.position, "invalid_pipeline_position") ?? pipeline.position,
      owningRole,
      isActive: configFlag(body.is_active, "invalid_pipeline_configuration", pipeline.is_active === 1),
      cardTemplateJson: Object.hasOwn(body, "card_template")
        ? normalizedCardTemplate(body.card_template)
        : pipeline.card_template_json,
      actor: { role: auth.session.role, userId: auth.session.user_id },
    },
    now,
  );
  return json({ pipeline: await adminPipelineDetail(env, tenantId, updated) });
}

async function handleAdminPipelineReorder(
  env: AppEnv,
  auth: AuthContext,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const requested = body.pipelines;
  if (!Array.isArray(requested) || requested.length === 0)
    return json({ error: "invalid_pipeline_order" }, 400);
  const order = requested.map((entry) => {
    const row = entry as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new PipelineConfigError("invalid_pipeline_order");
    const pipelineId = typeof row.pipeline_id === "string" ? row.pipeline_id.trim() : "";
    const expectedVersion = row.expected_version;
    if (
      pipelineId.length < 8 ||
      pipelineId.length > 200 ||
      typeof expectedVersion !== "number" ||
      !Number.isInteger(expectedVersion) ||
      expectedVersion < 1
    )
      throw new PipelineConfigError("invalid_pipeline_order");
    return { pipelineId, expectedVersion };
  });
  const ids = new Set(order.map((entry) => entry.pipelineId));
  if (ids.size !== order.length) return json({ error: "invalid_pipeline_order" }, 400);

  const known = await listPipelinesForAdmin(env, tenantId);
  const knownIds = new Set(known.map((pipeline) => pipeline.pipeline_id));
  for (const entry of order)
    if (!knownIds.has(entry.pipelineId)) return json({ error: "not_found" }, 404);
  if (ids.size !== knownIds.size)
    return json(
      { error: "pipeline_order_incomplete", expected_pipeline_ids: [...knownIds] },
      409,
    );

  const reordered = await reorderPipelines(
    env,
    { tenantId, order, actor: { role: auth.session.role, userId: auth.session.user_id } },
    now,
  );
  const [stages, grants, counts, stageCounts] = await Promise.all([
    stagesByPipelineForAdmin(env, tenantId),
    roleGrantsByPipeline(env, tenantId),
    cardCountsByPipeline(env, tenantId),
    cardCountsByStageForTenant(env, tenantId),
  ]);
  return json({
    pipelines: reordered.map((pipeline) =>
      adminPipelinePayload(
        pipeline,
        stages.get(pipeline.pipeline_id) ?? [],
        grants.get(pipeline.pipeline_id) ?? [],
        counts.get(pipeline.pipeline_id) ?? 0,
        stageCounts.get(pipeline.pipeline_id) ?? new Map(),
      ),
    ),
  });
}

async function handleAdminStageAdd(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const pipeline = await adminPipeline(env, tenantId, encodedPipelineId);
  if (!pipeline) return json({ error: "not_found" }, 404);
  const expectedVersion = expectedPipelineVersion(body);
  const conflict = versionConflict(pipeline, expectedVersion);
  if (conflict) return conflict;

  const stage = parseStageInput(body);
  const existing = await listStagesForAdmin(env, tenantId, pipeline.pipeline_id);
  if (existing.some((candidate) => candidate.key === stage.key))
    return json({ error: "pipeline_stage_key_exists", stage_key: stage.key }, 409);
  const live = existing.filter((candidate) => candidate.is_active === 1);
  if (live.length >= MAX_STAGES_PER_PIPELINE)
    return json({ error: "pipeline_stage_limit_reached", stage_limit: MAX_STAGES_PER_PIPELINE }, 409);

  const added = await addStage(
    env,
    {
      tenantId,
      pipelineId: pipeline.pipeline_id,
      expectedVersion,
      stage,
      pipelineKey: pipeline.key,
      position: live.reduce((top, candidate) => Math.max(top, candidate.position + 1), 0),
      actor: { role: auth.session.role, userId: auth.session.user_id },
    },
    now,
  );
  return json(
    {
      stage: stagePayload(added, 0),
      pipeline: await adminPipelineDetail(env, tenantId, pipeline.pipeline_id),
    },
    201,
  );
}

async function handleAdminStageUpdate(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  encodedStageId: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const pipeline = await adminPipeline(env, tenantId, encodedPipelineId);
  const stageId = decoded(encodedStageId);
  if (!pipeline || !stageId) return json({ error: "not_found" }, 404);
  const stage = await getStage(env, tenantId, pipeline.pipeline_id, stageId);
  if (!stage) return json({ error: "not_found" }, 404);
  const expectedVersion = expectedPipelineVersion(body);
  const conflict = versionConflict(pipeline, expectedVersion);
  if (conflict) return conflict;

  const isWon = configFlag(body.is_won, "invalid_pipeline_stage", stage.is_won === 1);
  const isLost = configFlag(body.is_lost, "invalid_pipeline_stage", stage.is_lost === 1);
  if (isWon && isLost) return json({ error: "pipeline_stage_won_and_lost" }, 400);
  const minRoleToEnter = Object.hasOwn(body, "min_role_to_enter")
    ? optionalConfigRole(body.min_role_to_enter, "invalid_pipeline_stage_role")
    : stage.min_role_to_enter;
  validatePipelineRoles(null, [{ min_role_to_enter: minRoleToEnter }], []);

  const updated = await updateStage(
    env,
    {
      tenantId,
      pipelineId: pipeline.pipeline_id,
      stageId,
      expectedVersion,
      name: Object.hasOwn(body, "name")
        ? configName(body.name, "invalid_pipeline_stage_name")
        : stage.name,
      color: Object.hasOwn(body, "color")
        ? configColor(body.color, "invalid_pipeline_stage_color")
        : stage.color,
      isWon,
      isLost,
      minRoleToEnter,
      isActive: configFlag(body.is_active, "invalid_pipeline_stage", stage.is_active === 1),
      actor: { role: auth.session.role, userId: auth.session.user_id },
    },
    now,
  );
  return json({
    stage: stagePayload(updated, await countCardsInStage(env, tenantId, pipeline.pipeline_id, stageId)),
    pipeline: await adminPipelineDetail(env, tenantId, pipeline.pipeline_id),
  });
}

/**
 * Reordering takes the COMPLETE live order, never a pairwise swap.  A partial list would let two
 * administrators each move one column and leave the board in an order neither of them chose.
 */
async function handleAdminStageReorder(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const pipeline = await adminPipeline(env, tenantId, encodedPipelineId);
  if (!pipeline) return json({ error: "not_found" }, 404);
  const expectedVersion = expectedPipelineVersion(body);
  const conflict = versionConflict(pipeline, expectedVersion);
  if (conflict) return conflict;

  const requested = body.stage_ids;
  if (!Array.isArray(requested)) return json({ error: "invalid_pipeline_stage_order" }, 400);
  const stageIds = requested.map((value) => {
    if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 200)
      throw new PipelineConfigError("invalid_pipeline_stage_order");
    return value.trim();
  });
  const live = await listStages(env, tenantId, pipeline.pipeline_id);
  const liveIds = new Set(live.map((stage) => stage.stage_id));
  if (
    stageIds.length !== live.length ||
    new Set(stageIds).size !== stageIds.length ||
    stageIds.some((stageId) => !liveIds.has(stageId))
  )
    return json(
      {
        error: "pipeline_stage_order_incomplete",
        expected_stage_ids: [...liveIds],
      },
      409,
    );

  const stages = await reorderStages(
    env,
    {
      tenantId,
      pipelineId: pipeline.pipeline_id,
      expectedVersion,
      stageIds,
      actor: { role: auth.session.role, userId: auth.session.user_id },
    },
    now,
  );
  const counts = await cardCountsByStage(env, tenantId, pipeline.pipeline_id);
  return json({
    stages: stages.map((stage) => stagePayload(stage, counts.get(stage.stage_id) ?? 0)),
    pipeline: await adminPipelineDetail(env, tenantId, pipeline.pipeline_id),
  });
}

/**
 * Removing a stage.  A stage still holding cards is REFUSED, with the exact count, unless the
 * administrator names where those cards go - and then the re-home and the removal commit in one
 * batch, so there is never a moment where the column is gone and the work is nowhere.  Removing the
 * last remaining stage is refused outright: a board with no stages is not a board.
 */
async function handleAdminStageRemove(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  encodedStageId: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const pipeline = await adminPipeline(env, tenantId, encodedPipelineId);
  const stageId = decoded(encodedStageId);
  if (!pipeline || !stageId) return json({ error: "not_found" }, 404);
  const stage = await getStage(env, tenantId, pipeline.pipeline_id, stageId);
  if (!stage || stage.is_active !== 1) return json({ error: "not_found" }, 404);
  const expectedVersion = expectedPipelineVersion(body);
  const conflict = versionConflict(pipeline, expectedVersion);
  if (conflict) return conflict;

  const live = await listStages(env, tenantId, pipeline.pipeline_id);
  if (live.length <= 1)
    return json({ error: "pipeline_stage_last_remaining", stage_id: stageId }, 409);

  const cardCount = await countCardsInStage(env, tenantId, pipeline.pipeline_id, stageId);
  const destinationId =
    body.move_cards_to_stage_id === undefined || body.move_cards_to_stage_id === null
      ? null
      : typeof body.move_cards_to_stage_id === "string"
        ? body.move_cards_to_stage_id.trim()
        : "";
  if (destinationId !== null) {
    const destination = live.find((candidate) => candidate.stage_id === destinationId);
    if (!destination || destination.stage_id === stageId)
      return json(
        {
          error: "pipeline_stage_destination_invalid",
          available_stage_ids: live
            .filter((candidate) => candidate.stage_id !== stageId)
            .map((candidate) => candidate.stage_id),
        },
        409,
      );
  }
  if (cardCount > 0 && destinationId === null)
    return json(
      {
        error: "pipeline_stage_has_cards",
        stage_id: stageId,
        card_count: cardCount,
        available_stage_ids: live
          .filter((candidate) => candidate.stage_id !== stageId)
          .map((candidate) => candidate.stage_id),
      },
      409,
    );

  const result = await removeStage(
    env,
    {
      tenantId,
      pipelineId: pipeline.pipeline_id,
      stageId,
      expectedVersion,
      moveCardsToStageId: cardCount > 0 ? destinationId : null,
      cardCount,
      archiveOnly: await stageHasHistory(env, tenantId, pipeline.pipeline_id, stageId),
      actor: { role: auth.session.role, userId: auth.session.user_id },
    },
    now,
  );
  const counts = await cardCountsByStage(env, tenantId, pipeline.pipeline_id);
  return json({
    outcome: result.outcome,
    moved_cards: result.moved_cards,
    stages: result.stages.map((entry) => stagePayload(entry, counts.get(entry.stage_id) ?? 0)),
    pipeline: await adminPipelineDetail(env, tenantId, pipeline.pipeline_id),
  });
}

/**
 * Per-pipeline role scoping.  `owning_role` keeps its meaning; these grants ADD roles beside it and
 * hold more than one from day one, because the stakeholder's shop board is read by production and
 * written by ops.  A role that neither owns the board nor holds a grant still reads the empty
 * state, exactly as PR #171 established - a grant can only ever widen deliberately, never by
 * default.
 */
async function handleAdminRoleGrants(
  env: AppEnv,
  auth: AuthContext,
  encodedPipelineId: string,
  body: Record<string, unknown>,
  now: Date,
): Promise<Response> {
  const tenantId = auth.session.tenant_id;
  const pipeline = await adminPipeline(env, tenantId, encodedPipelineId);
  if (!pipeline) return json({ error: "not_found" }, 404);
  const expectedVersion = expectedPipelineVersion(body);
  const conflict = versionConflict(pipeline, expectedVersion);
  if (conflict) return conflict;

  const grants = parseRoleGrantInputs(body.grants);
  const roles = new Set(Object.keys(ROLE_PERMISSIONS));
  for (const grant of grants)
    if (!roles.has(grant.role))
      return json({ error: "pipeline_role_unknown", role: grant.role, roles: [...roles] }, 400);

  await replaceRoleGrants(
    env,
    {
      tenantId,
      pipelineId: pipeline.pipeline_id,
      expectedVersion,
      grants,
      actor: { role: auth.session.role, userId: auth.session.user_id },
    },
    now,
  );
  return json({ pipeline: await adminPipelineDetail(env, tenantId, pipeline.pipeline_id) });
}

/* ------------------------------------------------------- administration helpers ------ */

/** An administrator reaches archived boards and copy templates too, which is exactly why this does
 * NOT go through `canViewPipeline`: that predicate answers "may this session work this board?" */
async function adminPipeline(
  env: AppEnv,
  tenantId: string,
  encodedPipelineId: string,
): Promise<PipelineRecord | null> {
  const pipelineId = decoded(encodedPipelineId);
  if (!pipelineId) return null;
  return await getPipeline(env, tenantId, pipelineId);
}

function expectedPipelineVersion(body: Record<string, unknown>): number {
  const value = body.expected_version;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000)
    throw new PipelineConfigError("expected_version_required");
  return value;
}

/** The stale-write refusal, answered with the version the caller should have held. */
function versionConflict(pipeline: PipelineRecord, expectedVersion: number): Response | null {
  return pipeline.version === expectedVersion
    ? null
    : json(
        {
          error: "pipeline_version_conflict",
          pipeline_version: pipeline.version,
          expected_version: expectedVersion,
        },
        409,
      );
}

async function nextPipelinePosition(env: AppEnv, tenantId: string): Promise<number> {
  const pipelines = await listPipelinesForAdmin(env, tenantId);
  return pipelines.reduce((top, pipeline) => Math.max(top, pipeline.position + 1), 0);
}

function normalizedCardTemplate(value: unknown): string {
  const template = parsePipelineCardTemplate(value);
  const json = JSON.stringify(template);
  if (json.length > MAX_CARD_TEMPLATE_BYTES)
    throw new PipelineConfigError("pipeline_card_template_too_large");
  return json;
}

function stagePayload(stage: PipelineStageRecord, cardCount: number): Record<string, unknown> {
  return {
    stage_id: stage.stage_id,
    key: stage.key,
    name: stage.name,
    color: stage.color,
    position: stage.position,
    is_won: stage.is_won === 1,
    is_lost: stage.is_lost === 1,
    min_role_to_enter: stage.min_role_to_enter,
    is_active: stage.is_active === 1,
    card_count: cardCount,
    updated_at: stage.updated_at,
  };
}

function adminPipelinePayload(
  pipeline: PipelineRecord,
  stages: readonly PipelineStageRecord[],
  grants: readonly PipelineRoleGrantRecord[],
  cardCount: number,
  stageCounts: ReadonlyMap<string, number>,
): Record<string, unknown> {
  return {
    pipeline_id: pipeline.pipeline_id,
    key: pipeline.key,
    name: pipeline.name,
    entity_type: pipeline.entity_type,
    owning_role: pipeline.owning_role,
    is_active: pipeline.is_active === 1,
    is_template: pipeline.is_template === 1,
    template_source_id: pipeline.template_source_id,
    position: pipeline.position,
    version: pipeline.version,
    card_count: cardCount,
    card_template: JSON.parse(pipeline.card_template_json) as unknown,
    stages: stages.map((stage) => stagePayload(stage, stageCounts.get(stage.stage_id) ?? 0)),
    role_grants: grants.map((grant) => ({ role: grant.role, can_write: grant.can_write === 1 })),
    updated_at: pipeline.updated_at,
  };
}

/** One board, re-read after a command so the caller's next write carries the version that command
 * produced instead of guessing at it. */
async function adminPipelineDetail(
  env: AppEnv,
  tenantId: string,
  pipelineOrId: PipelineRecord | string,
): Promise<Record<string, unknown>> {
  const pipeline =
    typeof pipelineOrId === "string"
      ? await getPipeline(env, tenantId, pipelineOrId)
      : pipelineOrId;
  if (!pipeline) throw new PipelineStoreError("pipeline_write_failed");
  const [stages, grants, counts] = await Promise.all([
    listStagesForAdmin(env, tenantId, pipeline.pipeline_id),
    listRoleGrants(env, tenantId, pipeline.pipeline_id),
    cardCountsByStage(env, tenantId, pipeline.pipeline_id),
  ]);
  const cardCount = [...counts.values()].reduce((total, count) => total + count, 0);
  return adminPipelinePayload(pipeline, stages, grants, cardCount, counts);
}

const ADMIN_FAILURE_STATUS: Readonly<Record<string, number>> = {
  expected_version_required: 400,
  pipeline_card_template_too_large: 400,
  pipeline_configuration_detail_too_large: 400,
  pipeline_stage_won_and_lost: 400,
  pipeline_stages_required: 400,
  pipeline_stage_limit_reached: 409,
  pipeline_stage_key_duplicated: 409,
  pipeline_order_incomplete: 409,
  pipeline_role_grant_duplicated: 409,
  pipeline_version_conflict: 409,
  pipeline_stage_changed: 409,
  pipeline_write_failed: 500,
};

function administrationFailure(error: unknown): Response {
  if (error instanceof PipelineConfigError)
    return json(
      { error: error.code, ...error.detail },
      ADMIN_FAILURE_STATUS[error.code] ?? 400,
    );
  if (error instanceof PipelineTemplateError)
    return json({ error: error.code }, 400);
  if (error instanceof PipelineStoreError)
    return json({ error: error.code }, ADMIN_FAILURE_STATUS[error.code] ?? 409);
  throw error;
}

function validatePipelineRoles(
  owningRole: string | null,
  stages: readonly { min_role_to_enter: string | null }[],
  grants: readonly { role: string }[],
): void {
  const roles = new Set(Object.keys(ROLE_PERMISSIONS));
  const configured = [
    owningRole,
    ...stages.map((stage) => stage.min_role_to_enter),
    ...grants.map((grant) => grant.role),
  ];
  for (const role of configured)
    if (role !== null && !roles.has(role))
      throw new PipelineConfigError("pipeline_role_unknown", {
        role,
        roles: [...roles],
      });
}
