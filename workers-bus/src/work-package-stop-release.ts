import { csrfTokenFor, sessionHashFor, validAppCsrf } from "./app-auth.ts";
import { findActiveSession } from "./app-auth-store.ts";
import {
  appUserIdentities,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "./app-types.ts";
import {
  FieldActionError,
  listJobEvidenceItemsFromD1,
  r2ObjectStore,
} from "./field-actions.ts";
import { canonicalJson, sha256Hex } from "./newo-hash.ts";
import { RESPONSE_AUTHORITY_ROLES } from "./safety-lifecycle.ts";

/**
 * Person-owned release of a crew stop on one exact Work Package version.
 *
 * A crew stop moves the version to Blocked, and office reissue of a Blocked version is refused
 * (`work_package_stop_release_required`). Releasing that stop is `safety_stop.release`, a
 * people-only act (class H in docs/AI-TEAM-CONTRACT.md): never an agent, automation, service
 * token, effect runtime or MCP actor, and never the person who raised or reported the stop. These
 * routes are its only write path:
 *
 *   POST /api/v1/work-packages/{id}/stop-releases  record one release (CSRF + Idempotency-Key)
 *   GET  /api/v1/work-packages/{id}/stop-releases  the stop holding the version and every release
 *
 * A release names the exact Blocked version and stop event, cites correction evidence captured on
 * the package's job, and gives a reason. Migration 0145 stores it append-only, re-checks every fact
 * below, and in the same statement returns the version to the status the stop interrupted, which is
 * the state office reissue accepts.
 *
 * Releasing roles are owner, ops and production: `RESPONSE_AUTHORITY_ROLES`, the roles that already
 * release a safety-occurrence stop, and the production supervisor the contract names. Sales,
 * accounting and field may not.
 */

const ROUTE = /^\/api\/v1\/work-packages\/([^/]+)\/stop-releases$/;
const REQUEST_KEYS = new Set(["evidence_ids", "reason", "stop_event_id", "work_package_version"]);
const MAX_BODY_BYTES = 32 * 1024;
const MAX_EVIDENCE = 10;
const WORK_PACKAGE_ID = /^[A-Za-z0-9._:-]{1,140}$/;
const STOP_EVENT_ID = /^[A-Za-z0-9._:-]{8,140}$/;
const EVIDENCE_ID = /^evi_[0-9a-f]{32}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,140}$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RELEASE_COLUMNS = `release_id, tenant_id, device_action_id, request_sha256, work_package_id,
       work_package_version, job_id, stop_event_id, stop_device_action_id, stop_actor_user_id,
       stop_reporter_user_id, restored_status, released_by_user_id, released_by_role,
       independence_json, evidence_refs_json, reason, manifest_key, created_at`;

type RestoredStatus = "Released" | "Acknowledged" | "In Progress";

interface StopReleaseRequest {
  workPackageVersion: number;
  stopEventId: string;
  reason: string;
  evidenceIds: string[];
}

interface StopReleaseRow {
  release_id: string;
  tenant_id: string;
  device_action_id: string;
  request_sha256: string;
  work_package_id: string;
  work_package_version: number;
  job_id: string;
  stop_event_id: string;
  stop_device_action_id: string;
  stop_actor_user_id: string;
  stop_reporter_user_id: string | null;
  restored_status: RestoredStatus;
  released_by_user_id: string;
  released_by_role: string;
  independence_json: string;
  evidence_refs_json: string;
  reason: string;
  manifest_key: string;
  created_at: string;
}

interface PackageHead {
  version: number;
  job_id: string;
  status: string;
}

interface StopEvent {
  event_id: string;
  device_action_id: string;
  actor_user_id: string;
  occurred_at: string;
  payload_json: string;
}

interface PersonSession {
  userId: string;
  role: AppRole;
  identities: string[];
}

class StopReleaseRefusal extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export async function handleWorkPackageStopReleaseRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const match = new URL(req.url).pathname.match(ROUTE);
  if (!match) return null;
  const workPackageId = decodedSegment(match[1]!);
  if (
    (env.APP_TENANT_ID ?? "ironwrap").trim() !== auth.session.tenant_id ||
    !workPackageId ||
    !WORK_PACKAGE_ID.test(workPackageId)
  ) {
    return json({ error: "not_found" }, 404);
  }
  try {
    if (req.method === "GET") return await readStopReleases(env, auth, workPackageId);
    if (req.method === "POST") return await recordStopRelease(req, env, auth, workPackageId);
    return json({ error: "method_not_allowed" }, 405);
  } catch (error) {
    if (error instanceof StopReleaseRefusal) return json({ error: error.code }, error.status);
    if (error instanceof FieldActionError && error.code === "immutable_object_conflict")
      return json({ error: "work_package_stop_release_replay_conflict" }, 409);
    return json({ error: "work_package_native_unavailable" }, 502);
  }
}

async function readStopReleases(
  env: AppEnv,
  auth: AuthContext,
  workPackageId: string,
): Promise<Response> {
  if (!RESPONSE_AUTHORITY_ROLES.has(auth.session.role))
    throw new StopReleaseRefusal("work_package_stop_release_role_required", 403);
  const tenantId = auth.session.tenant_id;
  const head = await packageHead(env, tenantId, workPackageId);
  if (!head) throw new StopReleaseRefusal("work_package_not_found", 404);
  let currentStop: StopEvent | null = null;
  if (head.status === "Blocked") {
    const holding = await unreleasedStops(env, tenantId, workPackageId, head.version);
    // A Blocked version is held by exactly one unreleased stop. Anything else is reported as a
    // conflict rather than guessed at, so no release form is ever built against it.
    if (holding.length !== 1)
      throw new StopReleaseRefusal("work_package_stop_release_stop_conflict", 409);
    currentStop = holding[0]!;
  }
  const releases = await env.DB.prepare(
    `SELECT ${RELEASE_COLUMNS}
       FROM work_package_stop_releases
      WHERE tenant_id = ? AND work_package_id = ?
      ORDER BY created_at ASC, release_id ASC`,
  )
    .bind(tenantId, workPackageId)
    .all<StopReleaseRow>();
  return json({
    work_package: {
      id: workPackageId,
      version: head.version,
      job_id: head.job_id,
      status: head.status,
    },
    current_stop: currentStop ? stopProjection(currentStop) : null,
    releases: (releases.results ?? []).map(releaseProjection),
  });
}

async function recordStopRelease(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
  workPackageId: string,
): Promise<Response> {
  const person = await personSession(env, auth);
  if (!person)
    throw new StopReleaseRefusal("work_package_stop_release_person_required", 403);
  if (!RESPONSE_AUTHORITY_ROLES.has(person.role))
    throw new StopReleaseRefusal("work_package_stop_release_role_required", 403);
  if (!validAppCsrf(req, auth)) throw new StopReleaseRefusal("csrf_failed", 403);
  const deviceActionId = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(deviceActionId))
    throw new StopReleaseRefusal("idempotency_key_required", 400);
  if (req.headers.get("x-device-action-id")?.trim() !== deviceActionId)
    throw new StopReleaseRefusal("device_action_id_mismatch", 400);
  const input = parseStopReleaseRequest(await readBody(req));
  const tenantId = auth.session.tenant_id;
  const requestSha256 = await sha256Hex(
    canonicalJson({
      schema_version: "ironwrap.work-package-stop-release-request.v1",
      tenant_id: tenantId,
      released_by_user_id: person.userId,
      device_action_id: deviceActionId,
      work_package_id: workPackageId,
      work_package_version: input.workPackageVersion,
      stop_event_id: input.stopEventId,
      reason: input.reason,
      evidence_ids: input.evidenceIds,
    }),
  );
  // An exact replay answers from the stored record before any current state is consulted: the
  // release itself moved the version out of Blocked.
  const prior = await releaseByDeviceAction(env, tenantId, deviceActionId);
  if (prior) return await replayed(env, prior, requestSha256);

  const head = await packageHead(env, tenantId, workPackageId);
  if (!head) throw new StopReleaseRefusal("work_package_not_found", 404);
  if (head.version !== input.workPackageVersion)
    throw new StopReleaseRefusal("work_package_stop_release_version_conflict", 409);
  const released = await env.DB.prepare(
    `SELECT release_id FROM work_package_stop_releases
      WHERE tenant_id = ? AND work_package_id = ? AND stop_event_id = ?`,
  )
    .bind(tenantId, workPackageId, input.stopEventId)
    .first<{ release_id: string }>();
  if (released) throw new StopReleaseRefusal("work_package_stop_already_released", 409);
  if (head.status !== "Blocked") throw new StopReleaseRefusal("work_package_not_blocked", 409);
  const holding = await unreleasedStops(env, tenantId, workPackageId, head.version);
  if (holding.length !== 1 || holding[0]!.event_id !== input.stopEventId)
    throw new StopReleaseRefusal("work_package_stop_release_stop_conflict", 409);
  const stop = holding[0]!;

  const receipt = await env.DB.prepare(
    `SELECT user_id FROM field_work_package_actions
      WHERE tenant_id = ? AND device_action_id = ? AND work_package_id = ?
        AND action_kind = 'stop_work'`,
  )
    .bind(tenantId, stop.device_action_id, workPackageId)
    .first<{ user_id: string }>();
  const reporter = receipt?.user_id ?? null;
  const stopIdentities = await personIdentities(env, tenantId, [stop.actor_user_id, reporter]);
  if (person.identities.some((identity) => stopIdentities.has(identity)))
    throw new StopReleaseRefusal("work_package_stop_release_independence_required", 403);

  const evidenceRefs = await citedEvidence(env, tenantId, head.job_id, input.evidenceIds);
  const row: StopReleaseRow = {
    release_id: `wsr_${(await sha256Hex(`${tenantId}:${deviceActionId}:stop-release`)).slice(0, 32)}`,
    tenant_id: tenantId,
    device_action_id: deviceActionId,
    request_sha256: requestSha256,
    work_package_id: workPackageId,
    work_package_version: head.version,
    job_id: head.job_id,
    stop_event_id: stop.event_id,
    stop_device_action_id: stop.device_action_id,
    stop_actor_user_id: stop.actor_user_id,
    stop_reporter_user_id: reporter,
    restored_status: await interruptedStatus(env, tenantId, workPackageId, head.version),
    released_by_user_id: person.userId,
    released_by_role: person.role,
    independence_json: canonicalJson({
      released_by_is_stop_actor: false,
      released_by_is_stop_reporter: false,
      released_in_person_session: true,
    }),
    evidence_refs_json: canonicalJson(evidenceRefs),
    reason: input.reason,
    manifest_key: `work-packages/office-actions/${tenantId}/${deviceActionId}.json`,
    created_at: new Date().toISOString(),
  };
  // The immutable office-action manifest is the audit object kept beside the D1 fact, under the
  // same key space as every other office Work Package action, so one Idempotency-Key can never
  // carry two different intents. It carries no time: a retry rewrites identical bytes.
  await ensureManifest(env, row);
  try {
    // One statement: the 0145 insert trigger re-checks every fact above and its after-insert
    // trigger restores the interrupted status, so the record and the transition commit together.
    await env.DB.batch([insertRelease(env, row)]);
  } catch (error) {
    const winner = await releaseByDeviceAction(env, tenantId, deviceActionId);
    if (winner) return await replayed(env, winner, requestSha256);
    throw writeRefusal(error);
  }
  const stored = await releaseByDeviceAction(env, tenantId, deviceActionId);
  if (!stored) throw new Error("work_package_stop_release_readback_missing");
  return json(releaseResponse(stored));
}

/**
 * The caller is a person only when the request carries the cookie session a sign-in created: a
 * well-formed token whose keyed hash is this session's hash, the CSRF token derived from that same
 * token, and a live session row for the same user. A desktop connector, an agent host, a service
 * token or the effect runtime never holds one. The role is the user's role right now.
 */
async function personSession(env: AppEnv, auth: AuthContext): Promise<PersonSession | null> {
  const token = auth.rawSessionToken;
  if (!SESSION_TOKEN.test(token)) return null;
  if ((await sessionHashFor(env, token)) !== auth.session.session_hash) return null;
  if ((await csrfTokenFor(env, token)) !== auth.csrfToken) return null;
  const live = await findActiveSession(
    env,
    auth.session.session_hash,
    auth.session.tenant_id,
    new Date().toISOString(),
  );
  if (!live || live.user_id !== auth.session.user_id) return null;
  return { userId: live.user_id, role: live.role, identities: appUserIdentities(live) };
}

function parseStopReleaseRequest(value: unknown): StopReleaseRequest {
  const invalid = new StopReleaseRefusal("invalid_work_package_stop_release", 400);
  if (!isRecord(value) || Object.keys(value).some((key) => !REQUEST_KEYS.has(key))) throw invalid;
  const evidence = value.evidence_ids;
  if (
    evidence === undefined ||
    evidence === null ||
    (Array.isArray(evidence) && evidence.length === 0)
  )
    throw new StopReleaseRefusal("work_package_stop_release_evidence_required", 400);
  if (
    !Array.isArray(evidence) ||
    evidence.length > MAX_EVIDENCE ||
    evidence.some((id) => typeof id !== "string" || !EVIDENCE_ID.test(id)) ||
    new Set(evidence).size !== evidence.length
  )
    throw invalid;
  const version = value.work_package_version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 1_000_000
  )
    throw invalid;
  const stopEventId = value.stop_event_id;
  if (typeof stopEventId !== "string" || !STOP_EVENT_ID.test(stopEventId)) throw invalid;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (reason.length < 1 || reason.length > 4000) throw invalid;
  return {
    workPackageVersion: version,
    stopEventId,
    reason,
    evidenceIds: [...(evidence as string[])].sort(),
  };
}

async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    throw new StopReleaseRefusal("payload_too_large", 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new StopReleaseRefusal("payload_too_large", 413);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StopReleaseRefusal("invalid_json", 400);
  }
}

async function packageHead(
  env: AppEnv,
  tenantId: string,
  workPackageId: string,
): Promise<PackageHead | null> {
  return await env.DB.prepare(
    `SELECT version, job_id, status
       FROM work_packages
      WHERE tenant_id = ? AND work_package_id = ?
      ORDER BY version DESC
      LIMIT 1`,
  )
    .bind(tenantId, workPackageId)
    .first<PackageHead>();
}

/** Stop events on this version that no release resolves; a Blocked version has exactly one. */
async function unreleasedStops(
  env: AppEnv,
  tenantId: string,
  workPackageId: string,
  version: number,
): Promise<StopEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT stop.event_id, stop.device_action_id, stop.actor_user_id, stop.occurred_at,
            stop.payload_json
       FROM work_package_events stop
      WHERE stop.tenant_id = ? AND stop.work_package_id = ? AND stop.work_package_version = ?
        AND stop.event_kind = 'stop_work'
        AND NOT EXISTS (
          SELECT 1 FROM work_package_stop_releases released
           WHERE released.tenant_id = stop.tenant_id
             AND released.stop_event_id = stop.event_id
        )
      ORDER BY stop.occurred_at DESC, stop.event_id DESC
      LIMIT 2`,
  )
    .bind(tenantId, workPackageId, version)
    .all<StopEvent>();
  return rows.results ?? [];
}

/** Every identity the stop's actor and reporter carry in this tenant, normalized. */
async function personIdentities(
  env: AppEnv,
  tenantId: string,
  userIds: Array<string | null>,
): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const userId of userIds) {
    if (!userId) continue;
    identities.add(userId.trim().toLowerCase());
    const user = await env.DB.prepare(
      `SELECT user_id, email_normalized, frappe_user_id
         FROM app_users
        WHERE tenant_id = ? AND user_id = ?`,
    )
      .bind(tenantId, userId)
      .first<{ user_id: string; email_normalized: string; frappe_user_id: string | null }>();
    if (user) for (const identity of appUserIdentities(user)) identities.add(identity);
  }
  return identities;
}

/** The status the stop interrupted, derived exactly as the 0145 insert trigger derives it. */
async function interruptedStatus(
  env: AppEnv,
  tenantId: string,
  workPackageId: string,
  version: number,
): Promise<RestoredStatus> {
  const row = await env.DB.prepare(
    `SELECT
       EXISTS (
         SELECT 1 FROM work_package_events
          WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
            AND event_kind = 'start_work'
       ) AS started,
       EXISTS (
         SELECT 1 FROM work_package_events
          WHERE tenant_id = ? AND work_package_id = ? AND work_package_version = ?
            AND event_kind = 'acknowledged'
       ) AS acknowledged`,
  )
    .bind(tenantId, workPackageId, version, tenantId, workPackageId, version)
    .first<{ started: number; acknowledged: number }>();
  if (!row) throw new Error("work_package_stop_release_status_unreadable");
  return row.started ? "In Progress" : row.acknowledged ? "Acknowledged" : "Released";
}

/**
 * Every cited id must be exactly one verified, manifested, stored Work Package capture of this
 * tenant's job. The reference keeps the checksum of the stored object, read from D1, never from
 * the browser.
 */
async function citedEvidence(
  env: AppEnv,
  tenantId: string,
  jobId: string,
  evidenceIds: string[],
): Promise<Array<{ ref: string; sha256: string }>> {
  const invalid = new StopReleaseRefusal("work_package_stop_release_evidence_invalid", 409);
  let rows: Awaited<ReturnType<typeof listJobEvidenceItemsFromD1>>;
  try {
    rows = await listJobEvidenceItemsFromD1(env, { tenantId, jobId, evidenceIds });
  } catch (error) {
    // A cited row that cannot be read as complete evidence is not evidence; an unreadable store
    // still propagates as unavailable.
    if (error instanceof Error && error.message.startsWith("field_evidence_")) throw invalid;
    throw error;
  }
  if (rows === null) throw new Error("work_package_stop_release_evidence_unavailable");
  const checksums = new Map<string, string>();
  for (const row of rows) {
    if (row.verification !== "Verified" || checksums.has(row.evidenceItem)) throw invalid;
    checksums.set(row.evidenceItem, row.checksumSha256);
  }
  if (checksums.size !== evidenceIds.length || evidenceIds.some((id) => !checksums.has(id)))
    throw invalid;
  return evidenceIds.map((id) => ({ ref: `field-evidence://${id}`, sha256: checksums.get(id)! }));
}

async function releaseByDeviceAction(
  env: AppEnv,
  tenantId: string,
  deviceActionId: string,
): Promise<StopReleaseRow | null> {
  return await env.DB.prepare(
    `SELECT ${RELEASE_COLUMNS}
       FROM work_package_stop_releases
      WHERE tenant_id = ? AND device_action_id = ?`,
  )
    .bind(tenantId, deviceActionId)
    .first<StopReleaseRow>();
}

function insertRelease(env: AppEnv, row: StopReleaseRow) {
  return env.DB.prepare(
    `INSERT INTO work_package_stop_releases (${RELEASE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.release_id,
    row.tenant_id,
    row.device_action_id,
    row.request_sha256,
    row.work_package_id,
    row.work_package_version,
    row.job_id,
    row.stop_event_id,
    row.stop_device_action_id,
    row.stop_actor_user_id,
    row.stop_reporter_user_id,
    row.restored_status,
    row.released_by_user_id,
    row.released_by_role,
    row.independence_json,
    row.evidence_refs_json,
    row.reason,
    row.manifest_key,
    row.created_at,
  );
}

async function ensureManifest(env: AppEnv, row: StopReleaseRow): Promise<void> {
  const body = canonicalJson({
    version: 1,
    kind: "stop_release",
    tenant_id: row.tenant_id,
    user_id: row.released_by_user_id,
    role: row.released_by_role,
    job_id: row.job_id,
    work_package_id: row.work_package_id,
    work_package_version: row.work_package_version,
    target: {
      release_id: row.release_id,
      request_sha256: row.request_sha256,
      stop_event_id: row.stop_event_id,
      stop_device_action_id: row.stop_device_action_id,
      stop_actor_user_id: row.stop_actor_user_id,
      stop_reporter_user_id: row.stop_reporter_user_id,
      restored_status: row.restored_status,
      independence: JSON.parse(row.independence_json) as unknown,
      evidence_refs: JSON.parse(row.evidence_refs_json) as unknown,
      reason: row.reason,
    },
  });
  await r2ObjectStore(env.RAW).ensure(
    row.manifest_key,
    body,
    "application/json",
    await sha256Hex(body),
  );
}

/** A refused write means a fact changed between the reads above and the insert. */
function writeRefusal(error: unknown): unknown {
  const message = String(error instanceof Error ? error.message : error);
  if (message.includes("work_package_stop_already_released"))
    return new StopReleaseRefusal("work_package_stop_already_released", 409);
  if (message.includes("work_package_stop_release_append_only"))
    return new StopReleaseRefusal("work_package_stop_release_replay_conflict", 409);
  if (
    message.includes("work_package_stop_release_scope_invalid") ||
    message.includes("work_package_stop_release_status_invalid") ||
    message.includes("work_package_stop_release_required") ||
    message.includes("work_package_projection_without_fact")
  )
    return new StopReleaseRefusal("work_package_stop_release_stop_conflict", 409);
  if (message.includes("work_package_stop_release_actor_invalid"))
    return new StopReleaseRefusal("work_package_stop_release_role_required", 403);
  if (message.includes("work_package_stop_release_independence_required"))
    return new StopReleaseRefusal("work_package_stop_release_independence_required", 403);
  if (message.includes("work_package_stop_release_evidence_invalid"))
    return new StopReleaseRefusal("work_package_stop_release_evidence_invalid", 409);
  if (/UNIQUE constraint failed: work_packages\./.test(message))
    return new StopReleaseRefusal("work_package_stop_release_assignment_conflict", 409);
  return error;
}

async function replayed(
  env: AppEnv,
  row: StopReleaseRow,
  requestSha256: string,
): Promise<Response> {
  if (row.request_sha256 !== requestSha256)
    throw new StopReleaseRefusal("work_package_stop_release_replay_conflict", 409);
  await ensureManifest(env, row);
  return json(releaseResponse(row));
}

function releaseResponse(row: StopReleaseRow): Record<string, unknown> {
  return {
    device_action_id: row.device_action_id,
    status: "verified",
    server_ref: row.work_package_id,
    cursor: row.release_id,
    release: releaseProjection(row),
  };
}

function releaseProjection(row: StopReleaseRow): Record<string, unknown> {
  return {
    release_id: row.release_id,
    work_package_id: row.work_package_id,
    work_package_version: row.work_package_version,
    job_id: row.job_id,
    stop_event_id: row.stop_event_id,
    stop_device_action_id: row.stop_device_action_id,
    stop_actor_user_id: row.stop_actor_user_id,
    stop_reporter_user_id: row.stop_reporter_user_id,
    restored_status: row.restored_status,
    released_by_user_id: row.released_by_user_id,
    released_by_role: row.released_by_role,
    independence: JSON.parse(row.independence_json) as unknown,
    evidence_refs: JSON.parse(row.evidence_refs_json) as unknown,
    reason: row.reason,
    created_at: row.created_at,
  };
}

function stopProjection(stop: StopEvent): Record<string, unknown> {
  const payload = JSON.parse(stop.payload_json) as Record<string, unknown>;
  return {
    stop_event_id: stop.event_id,
    stop_device_action_id: stop.device_action_id,
    stop_actor_user_id: stop.actor_user_id,
    occurred_at: stop.occurred_at,
    // The crew may stop without typing a reason; null means none was given.
    blocker_reason: typeof payload.blocker_reason === "string" ? payload.blocker_reason : null,
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
