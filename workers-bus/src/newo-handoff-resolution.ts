import { personCookieSession, validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AppRole, AuthContext } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { newoTenantId } from "./newo-store.ts";

/**
 * A person's resolution of one failed Newo handoff.
 *
 * A failed handoff is a caller who asked for a person and was not put through
 * (`newo_sessions.handoff_status = 'failed'`). The Newo reconcile and the operations read model
 * count it, and keep the model in `attention`, until a person records how it ended. There is no
 * lookback window: a window would retire a failure that nobody decided. These routes are the only
 * write path for that record:
 *
 *   POST /api/v1/newo/operations/handoffs/{session_id}/resolution  record it (CSRF + Idempotency-Key)
 *   GET  /api/v1/newo/operations/handoffs/{session_id}/resolution  the handoff and its resolution
 *
 * Resolving is people-only: never an agent, automation, connector, service token, effect runtime
 * or MCP actor. The resolving roles are owner and ops, the roles that already read Newo operations
 * (`GET /api/v1/newo/operations`). Migration 0151 stores the record append-only, at most one per
 * failed handoff, and re-checks the resolver and the failed status.
 */

const ROUTE = /^\/api\/v1\/newo\/operations\/handoffs\/([^/]+)\/resolution$/;
const REQUEST_KEYS = new Set(["note", "outcome"]);
const OUTCOMES = ["called_back", "unreachable", "not_needed"] as const;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_NOTE_LENGTH = 1000;
// The provider identifier shape that newo.ts accepts for a session id.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,140}$/;
const RESOLUTION_COLUMNS = `resolution_id, tenant_id, idempotency_key, request_sha256, session_id,
       outcome, note, resolved_by, resolved_by_role, resolved_at`;

type HandoffOutcome = (typeof OUTCOMES)[number];
type ResolvingRole = "owner" | "ops";

interface ResolutionRequest {
  outcome: HandoffOutcome;
  note: string | null;
}

interface ResolutionRow {
  resolution_id: string;
  tenant_id: string;
  idempotency_key: string;
  request_sha256: string;
  session_id: string;
  outcome: HandoffOutcome;
  note: string | null;
  resolved_by: string;
  resolved_by_role: ResolvingRole;
  resolved_at: string;
}

interface HandoffRow {
  session_id: string;
  handoff_status: string | null;
  updated_at: string;
}

class ResolutionRefusal extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export async function handleNewoHandoffResolutionRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const match = new URL(req.url).pathname.match(ROUTE);
  if (!match) return null;
  const sessionId = decodedSegment(match[1]!);
  if (newoTenantId(env) !== auth.session.tenant_id || !sessionId || !SESSION_ID.test(sessionId)) {
    return json({ error: "not_found" }, 404);
  }
  try {
    if (req.method === "GET") return await readResolution(env, auth, sessionId);
    if (req.method === "POST") return await recordResolution(req, env, auth, sessionId);
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    if (error instanceof ResolutionRefusal) return json({ error: error.code }, error.status);
    return json({ error: "newo_handoff_resolution_unavailable" }, 502);
  }
}

async function readResolution(env: AppEnv, auth: AuthContext, sessionId: string): Promise<Response> {
  if (!resolvingRole(auth.session.role))
    throw new ResolutionRefusal("newo_handoff_resolution_role_required", 403);
  const handoff = await handoffRow(env, sessionId);
  if (!handoff) throw new ResolutionRefusal("newo_handoff_not_found", 404);
  const resolution = await resolutionBySession(env, auth.session.tenant_id, sessionId);
  return json({
    handoff: {
      session_id: handoff.session_id,
      handoff_status: handoff.handoff_status,
      updated_at: handoff.updated_at,
    },
    resolution: resolution ? resolutionProjection(resolution) : null,
  });
}

async function recordResolution(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  sessionId: string,
): Promise<Response> {
  const person = await personCookieSession(env, auth);
  if (!person) throw new ResolutionRefusal("newo_handoff_resolution_person_required", 403);
  const role = person.role;
  if (!resolvingRole(role)) throw new ResolutionRefusal("newo_handoff_resolution_role_required", 403);
  if (!validAppCsrf(req, auth)) throw new ResolutionRefusal("csrf_failed", 403);
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(idempotencyKey))
    throw new ResolutionRefusal("idempotency_key_required", 400);
  const input = parseResolutionRequest(await readBody(req));
  const tenantId = auth.session.tenant_id;
  const requestSha256 = await sha256Hex(
    canonicalJson({
      schema_version: "ironwrap.newo-handoff-resolution-request.v1",
      tenant_id: tenantId,
      resolved_by: person.userId,
      idempotency_key: idempotencyKey,
      session_id: sessionId,
      outcome: input.outcome,
      note: input.note,
    }),
  );
  // An exact replay answers from the stored record before any current state is consulted: the
  // session's handoff status may have moved on since the resolution was recorded.
  const prior = await resolutionByKey(env, tenantId, idempotencyKey);
  if (prior) return replayed(prior, requestSha256);

  const handoff = await handoffRow(env, sessionId);
  if (!handoff) throw new ResolutionRefusal("newo_handoff_not_found", 404);
  if (await resolutionBySession(env, tenantId, sessionId))
    throw new ResolutionRefusal("newo_handoff_already_resolved", 409);
  if (handoff.handoff_status !== "failed") throw new ResolutionRefusal("newo_handoff_not_failed", 409);

  const row: ResolutionRow = {
    resolution_id: `nhr_${(await sha256Hex(`${tenantId}:${idempotencyKey}:newo-handoff-resolution`)).slice(0, 32)}`,
    tenant_id: tenantId,
    idempotency_key: idempotencyKey,
    request_sha256: requestSha256,
    session_id: sessionId,
    outcome: input.outcome,
    note: input.note,
    resolved_by: person.userId,
    resolved_by_role: role,
    resolved_at: new Date().toISOString(),
  };
  try {
    // The 0151 insert trigger re-checks the resolver's tenant, role and activity and the failed
    // status, and refuses a second resolution of the same handoff.
    await env.DB.prepare(
      `INSERT INTO newo_handoff_resolutions (${RESOLUTION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.resolution_id,
        row.tenant_id,
        row.idempotency_key,
        row.request_sha256,
        row.session_id,
        row.outcome,
        row.note,
        row.resolved_by,
        row.resolved_by_role,
        row.resolved_at,
      )
      .run();
  } catch (error) {
    const winner = await resolutionByKey(env, tenantId, idempotencyKey);
    if (winner) return replayed(winner, requestSha256);
    throw writeRefusal(error);
  }
  const stored = await resolutionByKey(env, tenantId, idempotencyKey);
  if (!stored) throw new Error("newo_handoff_resolution_readback_missing");
  return json({ resolution: resolutionProjection(stored) });
}

function resolvingRole(role: AppRole): role is ResolvingRole {
  return role === "owner" || role === "ops";
}

function parseResolutionRequest(value: unknown): ResolutionRequest {
  const invalid = new ResolutionRefusal("invalid_newo_handoff_resolution", 400);
  if (!isRecord(value) || Object.keys(value).some((key) => !REQUEST_KEYS.has(key))) throw invalid;
  const outcome = OUTCOMES.find((candidate) => candidate === value.outcome);
  if (!outcome) throw new ResolutionRefusal("newo_handoff_resolution_outcome_required", 400);
  const note = value.note;
  if (note !== undefined && note !== null && typeof note !== "string") throw invalid;
  // A blank note is no note; a note never silently loses words, so an overlong one is refused.
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length > MAX_NOTE_LENGTH) throw invalid;
  return { outcome, note: trimmed || null };
}

async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    throw new ResolutionRefusal("payload_too_large", 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ResolutionRefusal("payload_too_large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResolutionRefusal("invalid_json", 400);
  }
}

async function handoffRow(env: AppEnv, sessionId: string): Promise<HandoffRow | null> {
  return await env.DB.prepare(
    "SELECT session_id, handoff_status, updated_at FROM newo_sessions WHERE session_id = ?",
  )
    .bind(sessionId)
    .first<HandoffRow>();
}

async function resolutionByKey(
  env: AppEnv,
  tenantId: string,
  idempotencyKey: string,
): Promise<ResolutionRow | null> {
  return await env.DB.prepare(
    `SELECT ${RESOLUTION_COLUMNS}
       FROM newo_handoff_resolutions
      WHERE tenant_id = ? AND idempotency_key = ?`,
  )
    .bind(tenantId, idempotencyKey)
    .first<ResolutionRow>();
}

async function resolutionBySession(
  env: AppEnv,
  tenantId: string,
  sessionId: string,
): Promise<ResolutionRow | null> {
  return await env.DB.prepare(
    `SELECT ${RESOLUTION_COLUMNS}
       FROM newo_handoff_resolutions
      WHERE tenant_id = ? AND session_id = ?`,
  )
    .bind(tenantId, sessionId)
    .first<ResolutionRow>();
}

/** A refused write means a fact changed between the reads above and the insert. */
function writeRefusal(error: unknown): unknown {
  const message = String(error instanceof Error ? error.message : error);
  if (message.includes("newo_handoff_already_resolved"))
    return new ResolutionRefusal("newo_handoff_already_resolved", 409);
  if (message.includes("newo_handoff_resolution_append_only"))
    return new ResolutionRefusal("newo_handoff_resolution_replay_conflict", 409);
  if (message.includes("newo_handoff_resolution_not_failed"))
    return new ResolutionRefusal("newo_handoff_not_failed", 409);
  if (message.includes("newo_handoff_resolution_actor_invalid"))
    return new ResolutionRefusal("newo_handoff_resolution_role_required", 403);
  return error;
}

function replayed(row: ResolutionRow, requestSha256: string): Response {
  if (row.request_sha256 !== requestSha256)
    throw new ResolutionRefusal("newo_handoff_resolution_replay_conflict", 409);
  return json({ resolution: resolutionProjection(row) });
}

function resolutionProjection(row: ResolutionRow): Record<string, unknown> {
  return {
    resolution_id: row.resolution_id,
    session_id: row.session_id,
    outcome: row.outcome,
    note: row.note,
    resolved_by: row.resolved_by,
    resolved_by_role: row.resolved_by_role,
    resolved_at: row.resolved_at,
  };
}

function decodedSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}
