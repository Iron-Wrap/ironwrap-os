import { personCookieSession, validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AppRole, AuthContext } from "./app-types.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { getNewoCallbackRecord, newoTenantId, type NewoCallbackRecord } from "./newo-store.ts";

/**
 * A person's resolution of a Newo caller's callback: a requested callback, a failed handoff, or a
 * failed session's callback.
 *
 * The receptionist is callback only. A callback it requests is `requested`
 * (`newo_sessions.handoff_status`, newo.ts, newoHandoffStatus) and has a D1 callback record
 * (migration 0168); a failed handoff is a request for a person that did not arrive or could not be
 * processed (`failed`); a failed session with the caller's phone or email has a record too. The operations read model keeps the model in `attention` while either is
 * open (`open_callbacks`, `failed_handoffs`), and the Newo reconcile counts failed handoffs, until
 * a person records how it ended. There is no lookback window: a window would retire a callback
 * that nobody made. These routes are the only write path for that record:
 *
 *   POST /api/v1/newo/operations/handoffs/{session_id}/resolution  record it (CSRF + Idempotency-Key)
 *   GET  /api/v1/newo/operations/handoffs/{session_id}/resolution  the handoff, its callback record
 *                                                                  and its resolution
 *
 * Resolving is people-only: never an agent, automation, connector, service token, effect runtime
 * or MCP actor. The resolving roles are owner and ops, the roles that already read Newo operations
 * (`GET /api/v1/newo/operations`). A resolution needs an outcome and a note. It is stored
 * append-only (migration 0151, guard re-created in 0168), at most one per session, stamped with
 * D1's clock, together with one audit_log row in the same batch. D1 re-checks the resolver, the
 * note and that the session holds a callback to close. Every refusal has its own code:
 *
 *   403 newo_handoff_resolution_person_required  not a person's own cookie session
 *   403 newo_handoff_resolution_role_required    not owner or ops (the live role, for a write)
 *   403 csrf_failed                              no valid CSRF token
 *   400 idempotency_key_required                 no usable Idempotency-Key
 *   413 payload_too_large · 400 invalid_json
 *   400 invalid_newo_handoff_resolution          not an object, an unknown field, or a non-text note
 *   400 newo_handoff_resolution_outcome_required no known outcome
 *   400 newo_handoff_resolution_note_required    no note, or only spaces
 *   400 newo_handoff_resolution_note_too_long    a note over 1000 characters
 *   404 newo_handoff_not_found                   no such session
 *   409 newo_handoff_not_open                    no callback owed: no requested or failed handoff and no record
 *   409 newo_handoff_already_resolved            a person already closed it
 *   409 newo_handoff_resolution_replay_conflict  the key was used for a different resolution
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
// The 0168 guard admits these handoff states; a session with a callback record counts as well.
const OPEN_HANDOFF_STATUSES = new Set(["requested", "failed"]);

type HandoffOutcome = (typeof OUTCOMES)[number];
type ResolvingRole = "owner" | "ops";

interface ResolutionRequest {
  outcome: HandoffOutcome;
  note: string;
}

interface ResolutionRow {
  resolution_id: string;
  tenant_id: string;
  idempotency_key: string;
  request_sha256: string;
  session_id: string;
  outcome: HandoffOutcome;
  note: string;
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
  const [callback, resolution] = await Promise.all([
    getNewoCallbackRecord(env, sessionId),
    resolutionBySession(env, auth.session.tenant_id, sessionId),
  ]);
  return json({
    handoff: {
      session_id: handoff.session_id,
      handoff_status: handoff.handoff_status,
      updated_at: handoff.updated_at,
    },
    // The details a person needs to call back; the operations overview never carries them.
    callback: callback ? callbackProjection(callback) : null,
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
  const callback = await getNewoCallbackRecord(env, sessionId);
  if (!OPEN_HANDOFF_STATUSES.has(handoff.handoff_status ?? "") && !callback)
    throw new ResolutionRefusal("newo_handoff_not_open", 409);

  const resolutionId = `nhr_${(await sha256Hex(`${tenantId}:${idempotencyKey}:newo-handoff-resolution`)).slice(0, 32)}`;
  // D1 stamps the resolution and its audit row from its own clock; the 0168 guard refuses any
  // other time. The audit row commits with the resolution or not at all.
  const insert = env.DB.prepare(
    `INSERT INTO newo_handoff_resolutions (${RESOLUTION_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).bind(
    resolutionId,
    tenantId,
    idempotencyKey,
    requestSha256,
    sessionId,
    input.outcome,
    input.note,
    person.userId,
    role,
  );
  const audit = env.DB.prepare(
    `INSERT INTO audit_log
       (ts, automation, trigger, source_ids, target_ids, action, result, approved_by, reason)
     SELECT resolution.resolved_at, 'newo_callback_resolution', 'person', ?, ?, ?, 'ok', ?, ?
       FROM newo_handoff_resolutions resolution
      WHERE resolution.tenant_id = ? AND resolution.resolution_id = ?`,
  ).bind(
    `newo_session:${sessionId}`,
    `newo_handoff_resolution:${resolutionId}`,
    `resolve_${input.outcome}`,
    person.userId,
    // Why the callback was owed: the record's reason, or a pre-0168 session's handoff status.
    `${role}:${callback?.reason ?? `handoff_${handoff.handoff_status}`}`,
    tenantId,
    resolutionId,
  );
  try {
    // The 0168 insert guard re-checks the resolver's tenant, role and activity, the note, the
    // clock and that the session holds a callback to close, and refuses a second resolution.
    await env.DB.batch([insert, audit]);
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
  // How it ended, in the person's words: a blank note is no note, and a note never silently loses
  // words, so an overlong one is refused.
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (!trimmed) throw new ResolutionRefusal("newo_handoff_resolution_note_required", 400);
  if (trimmed.length > MAX_NOTE_LENGTH) throw new ResolutionRefusal("newo_handoff_resolution_note_too_long", 400);
  return { outcome, note: trimmed };
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
  if (message.includes("newo_handoff_resolution_not_open"))
    return new ResolutionRefusal("newo_handoff_not_open", 409);
  if (message.includes("newo_handoff_resolution_actor_invalid"))
    return new ResolutionRefusal("newo_handoff_resolution_role_required", 403);
  if (message.includes("newo_handoff_resolution_note_required"))
    return new ResolutionRefusal("newo_handoff_resolution_note_required", 400);
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

function callbackProjection(row: NewoCallbackRecord): Record<string, unknown> {
  return {
    callback_id: row.callback_id,
    session_id: row.session_id,
    reason: row.reason,
    urgency: row.urgency,
    handoff_summary: row.handoff_summary,
    contact: {
      name: row.contact_name,
      phone: row.contact_phone,
      email: row.contact_email,
      address: {
        line1: row.address_line1,
        city: row.city,
        province: row.province,
        postal_code: row.postal_code,
      },
    },
    recorded_at: row.recorded_at,
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
