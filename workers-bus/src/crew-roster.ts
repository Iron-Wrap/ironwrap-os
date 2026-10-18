// crew-roster.ts - the governed write path for crews and their members.
//
// Scheduling a roof job needs an active crew whose members are active field users
// (operating-job-assignment-store.ts), and nothing else in the Worker writes fleet_crews or
// fleet_crew_members. An owner or ops person sets them here, through their own cookie session:
// agents, connectors, service tokens and the effect runtime are refused. Every change is
// idempotent by its natural key and expected version, and writes one audit_log event in the same
// batch, so a roster change and its audit commit together or not at all.

import { personCookieSession, validAppCsrf } from "./app-auth.ts";
import type { AppEnv, AppRole, AuthContext } from "./app-types.ts";
import { sha256Hex } from "./newo-hash.ts";

const CREWS_PATH = "/api/v1/admin/crews";
const MEMBERS_PATH = /^\/api\/v1\/admin\/crews\/([^/]+)\/members$/;
const CREW_ID = /^[A-Za-z0-9._:-]{8,140}$/;
const USER_ID = /^[A-Za-z0-9._:@-]{3,128}$/;
const ROSTER_ROLES: ReadonlySet<AppRole> = new Set(["owner", "ops"]);
const CREW_STATUSES = new Set(["Active", "Inactive"]);
const MAX_BODY_BYTES = 8 * 1024;

class RosterRefusal extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

interface CrewRow {
  crew_id: string;
  display_name: string;
  status: string;
  version: number;
  updated_at: string;
}

interface MemberRow {
  membership_id: string;
  crew_id: string;
  user_id: string;
  active: number;
  version: number;
  updated_at: string;
}

export async function handleCrewRosterRoute(
  req: Request,
  env: AppEnv,
  auth: AuthContext,
): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const memberMatch = path.match(MEMBERS_PATH);
  if (path !== CREWS_PATH && !memberMatch) return null;
  try {
    if (!ROSTER_ROLES.has(auth.session.role))
      throw new RosterRefusal("crew_roster_role_required", 403);
    const tenantId = auth.session.tenant_id;
    if (req.method === "GET" && !memberMatch) return reply({ crews: await listCrews(env, tenantId) });
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    if (!validAppCsrf(req, auth)) throw new RosterRefusal("csrf_failed", 403);
    const person = await personCookieSession(env, auth);
    if (!person) throw new RosterRefusal("person_session_required", 403);
    if (!ROSTER_ROLES.has(person.role)) throw new RosterRefusal("crew_roster_role_required", 403);
    const body = await readBody(req);
    if (!memberMatch) return await recordCrew(env, tenantId, person.userId, body);
    const crewId = decodedSegment(memberMatch[1]!);
    if (!crewId || !CREW_ID.test(crewId)) throw new RosterRefusal("crew_not_found", 404);
    return await recordMember(env, tenantId, person.userId, crewId, body);
  } catch (error) {
    if (error instanceof RosterRefusal) return reply({ error: error.code }, error.status);
    console.error("crew roster write failed", error);
    return reply({ error: "crew_roster_unavailable" }, 503);
  }
}

/** Create a crew (`expected_version: null`) or change its name or status at the next version. */
async function recordCrew(
  env: AppEnv,
  tenantId: string,
  actorUserId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!exactKeys(body, ["crew_id", "display_name", "status", "expected_version"]))
    throw new RosterRefusal("invalid_crew", 400);
  const crewId = body.crew_id;
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  const status = body.status;
  const expected = body.expected_version;
  if (
    typeof crewId !== "string" ||
    !CREW_ID.test(crewId) ||
    displayName.length < 1 ||
    displayName.length > 120 ||
    typeof status !== "string" ||
    !CREW_STATUSES.has(status) ||
    !(expected === null || isVersion(expected))
  )
    throw new RosterRefusal("invalid_crew", 400);

  const same = (row: CrewRow | null) =>
    row !== null && row.display_name === displayName && row.status === status;
  const current = await crewById(env, tenantId, crewId);
  if (expected === null) {
    if (current) {
      if (same(current)) return reply({ crew: crewView(current), replayed: true });
      throw new RosterRefusal("crew_exists", 409);
    }
  } else {
    if (!current) throw new RosterRefusal("crew_not_found", 404);
    if (current.version === expected + 1 && same(current))
      return reply({ crew: crewView(current), replayed: true });
    if (current.version !== expected) throw new RosterRefusal("crew_version_conflict", 409);
  }

  const now = new Date().toISOString();
  const nextVersion = expected === null ? 1 : expected + 1;
  const write =
    expected === null
      ? env.DB.prepare(
          `INSERT INTO fleet_crews
             (crew_id, tenant_id, display_name, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        ).bind(crewId, tenantId, displayName, status, now, now)
      : env.DB.prepare(
          `UPDATE fleet_crews
              SET display_name = ?, status = ?, version = version + 1, updated_at = ?
            WHERE tenant_id = ? AND crew_id = ? AND version = ?`,
        ).bind(displayName, status, now, tenantId, crewId, expected);
  const audit = auditEvent(
    env,
    now,
    actorUserId,
    expected === null ? "crew_create" : "crew_update",
    `crew:${crewId}`,
    `version:${nextVersion},status:${status}`,
    `SELECT 1 FROM fleet_crews
      WHERE tenant_id = ? AND crew_id = ? AND version = ? AND display_name = ? AND status = ?`,
    [tenantId, crewId, nextVersion, displayName, status],
  );
  await writeOrReplay(env, [write, audit], async () => {
    const winner = await crewById(env, tenantId, crewId);
    return winner?.version === nextVersion && same(winner);
  });
  const stored = await crewById(env, tenantId, crewId);
  if (!stored || stored.version !== nextVersion || !same(stored))
    throw new RosterRefusal("crew_version_conflict", 409);
  return reply({ crew: crewView(stored), replayed: false }, expected === null ? 201 : 200);
}

/** Add a field user to a crew (`expected_version: null`) or set their membership active or not. */
async function recordMember(
  env: AppEnv,
  tenantId: string,
  actorUserId: string,
  crewId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!exactKeys(body, ["user_id", "active", "expected_version"]))
    throw new RosterRefusal("invalid_crew_member", 400);
  const userId = body.user_id;
  const active = body.active;
  const expected = body.expected_version;
  if (
    typeof userId !== "string" ||
    !USER_ID.test(userId) ||
    typeof active !== "boolean" ||
    !(expected === null || isVersion(expected))
  )
    throw new RosterRefusal("invalid_crew_member", 400);
  if (!(await crewById(env, tenantId, crewId))) throw new RosterRefusal("crew_not_found", 404);
  // Scheduling admits only active field users on a roster, so the roster takes nobody else.
  const worker = await env.DB.prepare(
    `SELECT 1 AS present FROM app_users
      WHERE tenant_id = ? AND user_id = ? AND active = 1 AND access_role = 'field'`,
  )
    .bind(tenantId, userId)
    .first<{ present: number }>();
  if (!worker) throw new RosterRefusal("crew_member_not_field_user", 422);

  const activeFlag = active ? 1 : 0;
  const same = (row: MemberRow | null) => row !== null && row.active === activeFlag;
  const current = await memberOf(env, tenantId, crewId, userId);
  if (expected === null) {
    if (current) {
      if (same(current)) return reply({ member: memberView(current), replayed: true });
      throw new RosterRefusal("crew_member_exists", 409);
    }
  } else {
    if (!current) throw new RosterRefusal("crew_member_not_found", 404);
    if (current.version === expected + 1 && same(current))
      return reply({ member: memberView(current), replayed: true });
    if (current.version !== expected) throw new RosterRefusal("crew_member_version_conflict", 409);
  }

  const now = new Date().toISOString();
  const nextVersion = expected === null ? 1 : expected + 1;
  const membershipId =
    current?.membership_id ??
    `crew_member:${(await sha256Hex(`${tenantId}\n${crewId}\n${userId}`)).slice(0, 40)}`;
  const write =
    expected === null
      ? env.DB.prepare(
          `INSERT INTO fleet_crew_members
             (membership_id, tenant_id, crew_id, user_id, active, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        ).bind(membershipId, tenantId, crewId, userId, activeFlag, now, now)
      : env.DB.prepare(
          `UPDATE fleet_crew_members
              SET active = ?, version = version + 1, updated_at = ?
            WHERE tenant_id = ? AND membership_id = ? AND version = ?`,
        ).bind(activeFlag, now, tenantId, membershipId, expected);
  const audit = auditEvent(
    env,
    now,
    actorUserId,
    expected === null ? "crew_member_add" : "crew_member_update",
    `crew:${crewId},user:${userId}`,
    `version:${nextVersion},active:${activeFlag}`,
    `SELECT 1 FROM fleet_crew_members
      WHERE tenant_id = ? AND membership_id = ? AND version = ? AND active = ?`,
    [tenantId, membershipId, nextVersion, activeFlag],
  );
  await writeOrReplay(env, [write, audit], async () => {
    const winner = await memberOf(env, tenantId, crewId, userId);
    return winner?.version === nextVersion && same(winner);
  });
  const stored = await memberOf(env, tenantId, crewId, userId);
  if (!stored || stored.version !== nextVersion || !same(stored))
    throw new RosterRefusal("crew_member_version_conflict", 409);
  return reply({ member: memberView(stored), replayed: false }, expected === null ? 201 : 200);
}

/**
 * The audit event is written only when the row it describes is in exactly the state the change
 * produced, inside the same batch, so a lost race leaves neither the change nor its audit.
 */
function auditEvent(
  env: AppEnv,
  ts: string,
  actorUserId: string,
  action: string,
  targetIds: string,
  sourceIds: string,
  existsSql: string,
  existsBindings: unknown[],
) {
  return env.DB.prepare(
    `INSERT INTO audit_log
       (ts, automation, trigger, envelope_id, source_ids, target_ids, action, result, approved_by)
     SELECT ?, 'crew_roster', 'office', NULL, ?, ?, ?, 'ok', ?
      WHERE EXISTS (${existsSql})`,
  ).bind(ts, sourceIds, targetIds, action, actorUserId, ...existsBindings);
}

/** A concurrent identical change that won the race is this request's replay, not a failure. */
async function writeOrReplay(
  env: AppEnv,
  statements: D1PreparedStatement[],
  sameAsWinner: () => Promise<boolean>,
): Promise<void> {
  try {
    const [result] = await env.DB.batch(statements);
    if (Number(result?.meta?.changes ?? 0) === 1) return;
  } catch (error) {
    if (await sameAsWinner()) return;
    throw new RosterRefusal(conflictCode(error), 409);
  }
  if (!(await sameAsWinner())) throw new RosterRefusal("crew_roster_conflict", 409);
}

function conflictCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /version_conflict/.test(message) ? "crew_roster_version_conflict" : "crew_roster_conflict";
}

async function listCrews(env: AppEnv, tenantId: string) {
  const crews = await env.DB.prepare(
    `SELECT crew_id, display_name, status, version, updated_at
       FROM fleet_crews WHERE tenant_id = ? ORDER BY lower(display_name), crew_id`,
  )
    .bind(tenantId)
    .all<CrewRow>();
  const members = await env.DB.prepare(
    `SELECT membership.membership_id, membership.crew_id, membership.user_id, membership.active,
            membership.version, membership.updated_at, person.display_name
       FROM fleet_crew_members membership
       JOIN app_users person
         ON person.tenant_id = membership.tenant_id AND person.user_id = membership.user_id
      WHERE membership.tenant_id = ?
      ORDER BY lower(person.display_name), membership.user_id`,
  )
    .bind(tenantId)
    .all<MemberRow & { display_name: string }>();
  return crews.results.map((crew) => ({
    ...crewView(crew),
    members: members.results
      .filter((member) => member.crew_id === crew.crew_id)
      .map((member) => ({ ...memberView(member), display_name: member.display_name })),
  }));
}

async function crewById(env: AppEnv, tenantId: string, crewId: string): Promise<CrewRow | null> {
  return await env.DB.prepare(
    `SELECT crew_id, display_name, status, version, updated_at
       FROM fleet_crews WHERE tenant_id = ? AND crew_id = ?`,
  )
    .bind(tenantId, crewId)
    .first<CrewRow>();
}

async function memberOf(
  env: AppEnv,
  tenantId: string,
  crewId: string,
  userId: string,
): Promise<MemberRow | null> {
  return await env.DB.prepare(
    `SELECT membership_id, crew_id, user_id, active, version, updated_at
       FROM fleet_crew_members WHERE tenant_id = ? AND crew_id = ? AND user_id = ?`,
  )
    .bind(tenantId, crewId, userId)
    .first<MemberRow>();
}

function crewView(row: CrewRow) {
  return {
    crew_id: row.crew_id,
    display_name: row.display_name,
    status: row.status,
    version: Number(row.version),
    updated_at: row.updated_at,
  };
}

function memberView(row: MemberRow) {
  return {
    crew_id: row.crew_id,
    user_id: row.user_id,
    active: Number(row.active) === 1,
    version: Number(row.version),
    updated_at: row.updated_at,
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES)
    throw new RosterRefusal("payload_too_large", 413);
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new RosterRefusal("payload_too_large", 413);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RosterRefusal("invalid_json", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RosterRefusal("invalid_json", 400);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isVersion(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) < 1_000_000;
}

function decodedSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
