import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { authenticateAppRequest, randomToken, sessionHashFor, sha256Hex } from "../src/app-auth.ts";
import { permissionsForRole, type AppEnv, type AuthContext } from "../src/app-types.ts";
import { d1FleetActionWriter, type PersistFleetActionInput } from "../src/fleet-actions.ts";
import { FieldActionError } from "../src/field-actions.ts";
import { seedStopPhoto } from "./safety-stop-photo-fixture.ts";
import {
  addToSafetyStop,
  rescopeSafetyStop,
  stopReleasePhotos,
  holdingSafetyStops,
  vehicleSafetyStops,
  safetyOccurrenceDetail,
  recordMakeSafe,
  recordSafetyResponse,
  reportSafetyOccurrence,
  SafetyError,
  type SafetyResponseCommand,
} from "../src/safety-lifecycle.ts";

// The P33 safety-stop route gaps (owner-accepted rulings): the stop reads name the raiser and say
// whether this viewer may release the stop (L06-aware), and show the controlled step. Every fixture
// is synthetic: reserved example.invalid identities, and times relative to the run.

const TENANT = "ironwrap";
const PEPPER = "synthetic-safety-stop-route-gaps-pepper-0123456789";
const BASE = Date.now() - 6 * 60 * 60 * 1_000;
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const SCOPE = { type: "roof_job" as const, id: "JOB-SAFETY-GAPS-1" };

interface FixtureUser {
  id: string;
  email: string;
  name: string;
  role: "owner" | "ops" | "field";
  access: string;
  frappe?: string;
}

const USERS = {
  owner: { id: "appu_owner_stop_gaps", email: "owner@example.invalid", name: "Synthetic Owner", role: "owner", access: "owner" },
  ops: { id: "appu_ops_stop_gaps", email: "ops@example.invalid", name: "Synthetic Ops", role: "ops", access: "ops" },
  production: { id: "appu_production_stop_gaps", email: "production@example.invalid", name: "Synthetic Production", role: "ops", access: "production" },
  sales: { id: "appu_sales_stop_gaps", email: "sales@example.invalid", name: "Synthetic Sales", role: "ops", access: "sales" },
  crew: { id: "appu_crew_stop_gaps", email: "crew@example.invalid", name: "Synthetic Crew", role: "field", access: "field", frappe: "crew@example.invalid" },
  mate: { id: "appu_mate_stop_gaps", email: "mate@example.invalid", name: "Synthetic Mate", role: "field", access: "field", frappe: "mate@example.invalid" },
} satisfies Record<string, FixtureUser>;

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  /** Batches the Worker sent, so a test can prove a refusal came before any write. */
  batches = 0;
  beforeBatch: (() => void) | null = null;
  beforeWrite: (() => void) | null = null;

  prepare(sql: string) {
    const sqlite = this.sqlite;
    const owner = this;
    return {
      bind(...values: unknown[]) {
        return {
          all<T>() {
            return { results: sqlite.prepare(sql).all(...(values as never[])) as T[] };
          },
          first<T>() {
            return (sqlite.prepare(sql).get(...(values as never[])) as T | undefined) ?? null;
          },
          async run() {
            const concurrent = owner.beforeWrite;
            owner.beforeWrite = null;
            concurrent?.();
            const result = sqlite.prepare(sql).run(...(values as never[]));
            return { meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }

  /** D1 runs a batch as one transaction: every statement commits, or none does. */
  async batch(statements: Array<{ run(): unknown }>) {
    this.batches += 1;
    const concurrent = this.beforeBatch;
    this.beforeBatch = null;
    concurrent?.();
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

type TestEnv = AppEnv & { DB: TestD1 };

function testEnv(users: FixtureUser[] = Object.values(USERS), options: { beforeAdditionsMigration?: boolean } = {}): TestEnv {
  const DB = new TestD1();
  DB.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = OFF");
  for (const name of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((value) => /^\d{4}_.+\.sql$/.test(value))
    .sort()) {
    if (options.beforeAdditionsMigration && name === "0171_safety_stop_additions_release_photo_rescope.sql") continue;
    DB.sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  for (const user of users) {
    DB.sqlite
      .prepare(
        `INSERT INTO app_users
          (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id,
           active, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(user.id, TENANT, user.email, user.name, user.role, user.access, user.frappe ?? null,
        "owner@example.invalid", at(-60), at(-60));
  }
  return { APP_TENANT_ID: TENANT, APP_AUTH_PEPPER: PEPPER, DB } as unknown as TestEnv;
}

function setFrappeLogin(env: TestEnv, user: FixtureUser, login: string) {
  env.DB.sqlite.prepare("UPDATE app_users SET frappe_user_id = ? WHERE user_id = ?").run(login, user.id);
}

// --- Occurrences ---------------------------------------------------------------------------------

let nextOccurrence = 0;

async function respond(
  env: TestEnv,
  actor: FixtureUser,
  occurrenceId: string,
  command: SafetyResponseCommand,
  detail = `Recorded ${command}.`,
) {
  return await recordSafetyResponse(env, {
    tenantId: TENANT,
    occurrenceId,
    actorUserId: actor.id,
    command,
    detail,
    evidence: null,
    now: new Date().toISOString(),
  });
}

/** A stop raised by `raiser`, made safe, and driven to `upTo` by `supervisor`. */
async function raisedStop(
  env: TestEnv,
  raiser: FixtureUser,
  options: {
    upTo?: "reported" | "made_safe" | "investigating" | "controlled";
    supervisor?: FixtureUser;
    rescueRequired?: boolean;
  } = {},
): Promise<string> {
  nextOccurrence += 1;
  const occurrenceId = `so_gaps_stop_${String(nextOccurrence).padStart(4, "0")}`;
  await reportSafetyOccurrence(env, {
    occurrenceId,
    tenantId: TENANT,
    occurrenceKind: "hazard",
    severity: "high",
    scope: SCOPE,
    reportedByUserId: raiser.id,
    reportedAt: at(nextOccurrence),
    summary: `Ice on the north slope, report ${nextOccurrence}.`,
    rescueRequired: options.rescueRequired ?? false,
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    now: at(nextOccurrence),
  });
  const upTo = options.upTo ?? "controlled";
  if (upTo === "reported") return occurrenceId;
  await recordMakeSafe(env, {
    tenantId: TENANT,
    occurrenceId,
    actorUserId: raiser.access === "field" ? raiser.id : USERS.crew.id,
    detail: "Crew off the roof, ladder roped off.",
    evidence: null,
    capturedOffline: false,
    deviceActionId: null,
    occurredAt: at(nextOccurrence),
    now: at(nextOccurrence),
  });
  if (upTo === "made_safe") return occurrenceId;
  const supervisor = options.supervisor ?? USERS.ops;
  await respond(env, supervisor, occurrenceId, "investigation_opened");
  if (upTo === "investigating") return occurrenceId;
  await respond(env, supervisor, occurrenceId, "controlled", "Salt on the deck and ladder.");
  return occurrenceId;
}

// --- Person sessions and requests ----------------------------------------------------------------

/** A real cookie session, authenticated the way the router authenticates a signed-in person. */
async function personAuth(
  env: TestEnv,
  user: FixtureUser,
  signedInMinutesAgo = 1,
): Promise<AuthContext> {
  const token = randomToken();
  const now = Date.now();
  const signedIn = new Date(now - signedInMinutesAgo * 60_000).toISOString();
  // A field session lives on a paired crew phone and carries that phone's proof.
  const field = user.access === "field";
  const proof = field ? randomToken() : null;
  const deviceId = field ? `device-${randomToken().slice(0, 20)}` : null;
  if (proof && deviceId) {
    env.DB.sqlite
      .prepare(
        `INSERT INTO app_devices
          (device_id, tenant_id, user_id, device_proof_hash, paired_at, last_seen_at,
           created_ip_hash, created_user_agent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(deviceId, TENANT, user.id, await sha256Hex(proof), signedIn, signedIn,
        "d".repeat(64), "e".repeat(64));
  }
  env.DB.sqlite
    .prepare(
      `INSERT INTO app_sessions
        (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
         created_ip_hash, created_user_agent_hash, device_id)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(await sessionHashFor(env, token), user.id, TENANT, signedIn,
      new Date(now + 3_600_000).toISOString(), signedIn, "d".repeat(64), "e".repeat(64), deviceId);
  const outcome = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", {
      headers: {
        cookie: `__Host-ironwrap_session=${token}`,
        ...(proof ? { "x-ironwrap-device-proof": proof } : {}),
      },
    }),
    env,
  );
  assert.ok(outcome.ok, "the synthetic person session authenticates");
  return outcome.auth;
}

/** The context an agent host, desktop connector or service credential carries: no cookie token. */
function connectorAuth(user: FixtureUser): AuthContext {
  return {
    rawSessionToken: "",
    csrfToken: "",
    permissions: permissionsForRole(user.access as "production"),
    session: {
      session_hash: "f".repeat(64),
      session_created_at: new Date(Date.now() - 60_000).toISOString(),
      session_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      revoked_at: null,
      device_id: "device-synthetic-connector",
      device_proof_hash: null,
      user_id: user.id,
      tenant_id: TENANT,
      email_normalized: user.email,
      display_name: user.name,
      role: user.access as "production",
      frappe_user_id: null,
      active: 1,
      created_by: USERS.owner.email,
      created_at: at(-60),
      updated_at: at(-60),
    },
  };
}

async function call(
  env: TestEnv,
  auth: AuthContext,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "content-type": "application/json", "x-csrf-token": auth.csrfToken, ...headers }
        : headers,
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
    auth,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const occurrencePath = (occurrenceId: string) =>
  `/api/v1/safety/occurrences/${encodeURIComponent(occurrenceId)}`;

function insertRow(env: TestEnv, table: string, row: Record<string, string | number | null>, replace = false) {
  const columns = Object.keys(row);
  env.DB.sqlite.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function seedJob(env: TestEnv, jobId = SCOPE.id, tenantId = TENANT) {
  const db = env.DB.sqlite;
  db.prepare(`INSERT INTO envelopes (envelope_id, source, contact_name, contact_email,
    payload_json, raw_key, ts, status, created_at, updated_at)
    VALUES ('env-stop-171', 'manual', 'Synthetic Customer', 'synthetic@example.invalid', '{}',
    'raw/stop-171.json', ?, 'reconciled', ?, ?) ON CONFLICT DO NOTHING`).run(at(-60), at(-60), at(-60));
  db.prepare(`INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, created_at, updated_at)
    VALUES (?, ?, 'env-stop-171', 'manual', ?, ?) ON CONFLICT DO NOTHING`).run(`lead-${tenantId}`, tenantId, at(-60), at(-60));
  db.prepare(`INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_email, created_at, updated_at)
    VALUES (?, ?, 'env-stop-171', 'Synthetic Customer', 'synthetic@example.invalid', ?, ?) ON CONFLICT DO NOTHING`).run(`customer-${tenantId}`, tenantId, at(-60), at(-60));
  db.prepare(`INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, service_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'env-stop-171', 'Roofing', ?, ?)`).run(jobId, tenantId, `lead-${tenantId}`, `customer-${tenantId}`, at(-60), at(-60));
}

const photoId = (n: number) => `evi_${n.toString(16).padStart(32, '0')}`;
function photo(env: TestEnv, n: number, overrides: Partial<Parameters<typeof seedStopPhoto>[1]> = {}) {
  return seedStopPhoto(env.DB.sqlite, { userId: USERS.crew.id, jobId: SCOPE.id,
    evidenceId: photoId(n), capturedAt: at(200), ...overrides });
}
function occurrence(env: TestEnv, id: string) {
  return env.DB.sqlite.prepare('SELECT * FROM safety_occurrences WHERE occurrence_id = ?').get(id) as Record<string, any>;
}
function additionInput(id: string, key = 'addition-synthetic-01') {
  return { tenantId: TENANT, occurrenceId: id, actorUserId: USERS.crew.id,
    note: 'The crew is off the roof.', evidenceIds: [] as string[], idempotencyKey: key };
}
function releaseInput(id: string, ids: string[]) {
  return { tenantId: TENANT, occurrenceId: id, actorUserId: USERS.ops.id, command: 'released' as const,
    detail: 'Correction inspected independently.', evidence: null, evidenceIds: ids, now: new Date().toISOString() };
}
const rejectsCode = (code: string) => (error: unknown) => error instanceof SafetyError && error.code === code;

function directRelease(env: TestEnv, id: string, refs: unknown, version?: number) {
  const row = occurrence(env, id);
  insertRow(env, 'safety_occurrence_events', {
    event_id: `direct-release-${id}`, tenant_id: TENANT, occurrence_id: id,
    occurrence_version: version ?? row.version + 1, event_kind: 'released', actor_user_id: USERS.ops.id,
    actor_role: 'ops', detail: 'Correction inspected independently.', evidence_refs_json: refs === null ? null : JSON.stringify(refs),
    evidence_sha256: refs === null ? null : 'c'.repeat(64), captured_offline: 0,
    occurred_at: at(220), recorded_at: at(220), device_action_id: null,
  });
}

test('additions preserve the stop and append a D1-timed note/photo receipt with exact replay', async () => {
  const env = testEnv();
  const id = await raisedStop(env, USERS.crew);
  const original = occurrence(env, id);
  const evidenceId = photo(env, 1);
  const input = { ...additionInput(id), evidenceIds: [evidenceId] };
  const result = await addToSafetyStop(env, input);
  assert.equal(result.replayed, false);
  assert.equal(result.addition.added_by_display_name, USERS.crew.name);
  assert.deepEqual(result.addition.photos, [{ evidence_id: evidenceId, sha256: 'b'.repeat(64) }]);
  assert.ok(Math.abs(Date.now() - Date.parse(result.addition.added_at)) < 5000);
  assert.deepEqual(occurrence(env, id), original);
  assert.deepEqual(await addToSafetyStop(env, input), { ...result, replayed: true });
  await assert.rejects(addToSafetyStop(env, { ...input, note: 'A different note.' }), rejectsCode('idempotency_conflict'));
  const auth = await personAuth(env, USERS.crew);
  const read = await call(env, auth, occurrencePath(id));
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.additions, [result.addition]);
  const stored = env.DB.sqlite.prepare('SELECT * FROM safety_occurrence_additions').get() as Record<string, string | number | null>;
  assert.throws(() => insertRow(env, 'safety_occurrence_additions', { ...stored, note: 'Changed history.' }, true), /safety_stop_addition_append_only/);
  assert.throws(() => env.DB.sqlite.exec("UPDATE safety_occurrence_additions SET note = 'Changed history.'"), /safety_stop_addition_append_only/);
  assert.throws(() => env.DB.sqlite.exec('DELETE FROM safety_occurrence_additions'), /safety_stop_addition_retained/);
});

test('additions and scope correction routes require person cookies and reject raw evidence and unknown keys', async () => {
  const env = testEnv();
  const id = await raisedStop(env, USERS.crew);
  const auth = await personAuth(env, USERS.crew);
  const path = `${occurrencePath(id)}/additions`;
  const headers = { 'idempotency-key': 'addition-route-01' };
  assert.equal((await call(env, auth, path, { note: 'Crew off the roof.' })).body.error, 'idempotency_key_required');
  assert.equal((await call(env, auth, path, { note: 'Crew off the roof.', evidence_refs_json: '[]' }, headers)).status, 400);
  assert.equal((await call(env, connectorAuth(USERS.crew), path, { note: 'Crew off the roof.' }, headers)).body.error, 'safety_stop_addition_person_required');
  const added = await call(env, auth, path, { note: 'Crew off the roof.' }, headers);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal((await call(env, auth, path, { note: 'Crew off the roof.' }, headers)).status, 200);
  const correction = { occurrence_version: occurrence(env, id).version, scope_type: 'roof_job', scope_id: SCOPE.id, reason: 'Corrected job reference.' };
  assert.equal((await call(env, connectorAuth(USERS.owner), `${occurrencePath(id)}/scope`, correction, headers)).body.error, 'safety_stop_rescope_person_required');
  const released = await call(env, await personAuth(env, USERS.ops), `${occurrencePath(id)}/commands`, {
    command: 'released', detail: 'Correction checked.', evidence_refs_json: '[]', evidence_sha256: 'a'.repeat(64),
  });
  assert.equal(released.status, 400);
});

test('release requires real manifested same-tenant same-scope post-stop photos and uses server checksums', async () => {
  const env = testEnv();
  seedJob(env);
  const id = await raisedStop(env, USERS.crew);
  const before = occurrence(env, id);
  await assert.rejects(recordSafetyResponse(env, releaseInput(id, [])), rejectsCode('safety_stop_release_evidence_required'));
  const tooEarly = photo(env, 2, { capturedAt: before.reported_at });
  await assert.rejects(recordSafetyResponse(env, releaseInput(id, [tooEarly])), rejectsCode('safety_stop_release_evidence_before_stop'));
  for (const [n, overrides] of [
    [3, { jobId: 'JOB-OTHER-SYNTHETIC' }], [4, { tenantId: 'otherco' }],
    [5, { status: 'r2_stored' }], [6, { manifested: false }],
  ] as const) {
    const invalid = photo(env, n, overrides);
    await assert.rejects(recordSafetyResponse(env, releaseInput(id, [invalid])), rejectsCode('safety_stop_release_evidence_invalid'));
    assert.throws(() => directRelease(env, id, [{ ref: `field-evidence://${invalid}`, sha256: 'b'.repeat(64) }]), /safety_stop_release_evidence_invalid/);
  }
  const valid = photo(env, 7);
  assert.throws(() => directRelease(env, id, [{ ref: `field-evidence://${valid}`, sha256: 'a'.repeat(64) }]), /safety_stop_release_evidence_invalid/);
  assert.throws(() => directRelease(env, id, [{ ref: `field-evidence://${tooEarly}`, sha256: 'b'.repeat(64) }]), /safety_stop_release_evidence_before_stop/);
  assert.deepEqual(occurrence(env, id), before);
  const released = await recordSafetyResponse(env, releaseInput(id, [valid]));
  assert.equal(released.stop_active, 0);
  const event = env.DB.sqlite.prepare("SELECT evidence_refs_json, evidence_sha256 FROM safety_occurrence_events WHERE occurrence_id = ? AND event_kind = 'released'").get(id) as { evidence_refs_json: string; evidence_sha256: string };
  assert.deepEqual(JSON.parse(event.evidence_refs_json), [{ ref: `field-evidence://${valid}`, sha256: 'b'.repeat(64) }]);
  assert.equal(event.evidence_sha256, await sha256Hex(event.evidence_refs_json));
  await assert.rejects(addToSafetyStop(env, additionInput(id)), rejectsCode('safety_stop_not_open'));
});

test('non-photo evidence cannot qualify in Worker or direct D1', async () => {
  const env = testEnv();
  const id = await raisedStop(env, USERS.crew);
  const invalid = photo(env, 8, { contentType: 'application/pdf', source: 'document' });
  await assert.rejects(recordSafetyResponse(env, releaseInput(id, [invalid])), rejectsCode('safety_stop_release_evidence_invalid'));
  assert.throws(() => directRelease(env, id, [{ ref: `field-evidence://${invalid}`, sha256: 'b'.repeat(64) }]), /safety_stop_release_evidence_invalid/);
  await assert.rejects(addToSafetyStop(env, { ...additionInput(id), evidenceIds: [invalid] }), rejectsCode('safety_stop_addition_evidence_invalid'));
});

test('ambiguous evidence ids are excluded before limiting the release-photo read', async () => {
  const env = testEnv();
  const id = await raisedStop(env, USERS.crew);
  const duplicate = photo(env, 9);
  photo(env, 9, { actionId: 'capture-duplicate-old', capturedAt: at(190) });
  const valid = photo(env, 10, { capturedAt: at(180) });
  const rows = await stopReleasePhotos(env, occurrence(env, id) as any, 1);
  assert.deepEqual(rows.map((row) => row.evidence_id), [valid]);
  await assert.rejects(recordSafetyResponse(env, releaseInput(id, [duplicate])), rejectsCode('safety_stop_release_evidence_invalid'));
});

function asset(env: TestEnv, id: string, holder = 'User', replace = false) {
  insertRow(env, 'fleet_assets', { fleet_asset_id: id, tenant_id: TENANT, display_name: id,
    asset_kind: 'Vehicle', status: 'Active', custody_holder_type: holder,
    custody_user_id: holder === 'User' ? USERS.crew.id : null, custody_crew_id: null,
    version: 1, last_command_id: `create-${id}`, last_actor_user_id: USERS.ops.id,
    created_at: at(-10), updated_at: at(-10) }, replace);
}
async function vehicleStop(env: TestEnv, assetId: string) {
  const id = `so_vehicle_${assetId}`;
  await reportSafetyOccurrence(env, { occurrenceId: id, tenantId: TENANT, occurrenceKind: 'hazard', severity: 'high',
    scope: { type: 'vehicle', id: assetId }, reportedByUserId: USERS.crew.id, reportedAt: at(10),
    summary: 'Synthetic vehicle stopped for brake fault.', rescueRequired: false, evidence: null,
    capturedOffline: false, deviceActionId: null, now: at(10) });
  return id;
}

test('a vehicle stop guards new custody and INSERT OR REPLACE as well as custody updates', async () => {
  const env = testEnv();
  await vehicleStop(env, 'TRUCK-SYNTHETIC');
  assert.throws(() => asset(env, 'TRUCK-SYNTHETIC'), /fleet_vehicle_safety_stop_active/);
  asset(env, 'TRUCK-SYNTHETIC', 'Yard');
  assert.throws(() => asset(env, 'TRUCK-SYNTHETIC', 'User', true), /fleet_vehicle_safety_stop_active/);
  assert.throws(() => env.DB.sqlite.prepare(`UPDATE fleet_assets SET custody_holder_type = 'User', custody_user_id = ?, version = version + 1 WHERE fleet_asset_id = 'TRUCK-SYNTHETIC'`).run(USERS.crew.id), /fleet_vehicle_safety_stop_active/);
  assert.equal((await vehicleSafetyStops(env, TENANT, 'TRUCK-SYNTHETIC'))[0]?.raiser_display_name, USERS.crew.name);
});

test('a stop raised after cargo was Loaded prevents In Transit and new loading on vehicle or trailer', async () => {
  const env = testEnv();
  seedJob(env);
  asset(env, 'TRUCK-SYNTHETIC');
  asset(env, 'TRAILER-SYNTHETIC');
  insertRow(env, 'fleet_driver_authorities', { driver_authority_id: 'driver-authority-synthetic', tenant_id: TENANT,
    user_id: USERS.crew.id, status: 'Active', authority_source: 'Physical Document', licence_class: 'Synthetic',
    licence_expiry: new Date(Date.now() + 86400000).toISOString().slice(0, 10), evidence_key: 'synthetic/licence', evidence_sha256: 'a'.repeat(64),
    version: 1, last_command_id: 'driver-create-synthetic', last_actor_user_id: USERS.ops.id, created_at: at(-10), updated_at: at(-10) });
  const load = { cargo_load_id: 'cargo-synthetic-01', tenant_id: TENANT, roof_job_id: SCOPE.id,
    fleet_asset_id: 'TRUCK-SYNTHETIC', trailer_asset_id: 'TRAILER-SYNTHETIC', driver_authority_id: 'driver-authority-synthetic',
    driver_user_id: USERS.crew.id, status: 'Loaded', loaded_weight_kg_milli: 1000,
    custody_holder_type: 'User', custody_user_id: USERS.crew.id, version: 1, last_command_id: 'cargo-create-synthetic',
    last_actor_user_id: USERS.ops.id, created_at: at(-5), updated_at: at(-5) };
  insertRow(env, 'fleet_cargo_loads', load);
  await vehicleStop(env, 'TRAILER-SYNTHETIC');
  assert.throws(() => env.DB.sqlite.exec(`UPDATE fleet_cargo_loads SET status = 'In Transit', version = 2`), /fleet_vehicle_safety_stop_active/);
  assert.throws(() => insertRow(env, 'fleet_cargo_loads', { ...load, cargo_load_id: 'cargo-synthetic-02' }), /fleet_vehicle_safety_stop_active/);
  assert.throws(() => insertRow(env, 'fleet_cargo_loads', load, true), /fleet_vehicle_safety_stop_active/);
  env.DB.sqlite.exec(`UPDATE fleet_cargo_loads SET status = 'Returned', version = 2`);
  assert.equal((env.DB.sqlite.prepare('SELECT status FROM fleet_cargo_loads').get() as { status: string }).status, 'Returned');
});

test('a photo invalidated after the Worker read is refused atomically with a named conflict', async () => {
  const env = testEnv();
  const id = await raisedStop(env, USERS.crew);
  const evidenceId = photo(env, 11);
  const before = occurrence(env, id);
  env.DB.beforeBatch = () => env.DB.sqlite.prepare('UPDATE field_actions SET manifest_key = NULL WHERE device_action_id = ?').run(`capture-${evidenceId}`);
  await assert.rejects(recordSafetyResponse(env, releaseInput(id, [evidenceId])), rejectsCode('safety_stop_release_evidence_invalid'));
  assert.deepEqual(occurrence(env, id), before);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM safety_occurrence_events WHERE event_kind = 'released'").get()?.n, 0);
  const additionId = photo(env, 12);
  env.DB.beforeWrite = () => env.DB.sqlite.prepare('UPDATE field_actions SET manifest_key = NULL WHERE device_action_id = ?').run(`capture-${additionId}`);
  await assert.rejects(addToSafetyStop(env, { ...additionInput(id), evidenceIds: [additionId] }), rejectsCode('safety_stop_addition_evidence_invalid'));
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_occurrence_additions').get()?.n, 0);
});

test('D1 additions reject a forged timestamp, an inactive writer and a stop released before insert', async () => {
  const env = testEnv();
  const id = await raisedStop(env, USERS.crew);
  await addToSafetyStop(env, additionInput(id));
  const row = env.DB.sqlite.prepare('SELECT * FROM safety_occurrence_additions').get() as Record<string, string | number | null>;
  const candidate = { ...row, addition_id: `soa_${'f'.repeat(32)}`, idempotency_key: 'addition-direct-02' };
  assert.throws(() => insertRow(env, 'safety_occurrence_additions', { ...candidate, added_at: at(-20) }), /safety_stop_addition_clock_invalid/);
  env.DB.sqlite.prepare('UPDATE app_users SET active = 0 WHERE user_id = ?').run(USERS.crew.id);
  assert.throws(() => insertRow(env, 'safety_occurrence_additions', candidate), /safety_actor_unknown/);
  env.DB.sqlite.prepare('UPDATE app_users SET active = 1 WHERE user_id = ?').run(USERS.crew.id);
  await recordSafetyResponse(env, releaseInput(id, [photo(env, 13)]));
  assert.throws(() => insertRow(env, 'safety_occurrence_additions', candidate), /safety_stop_not_open/);
});

function fleetInput(env: TestEnv, kind: PersistFleetActionInput['kind'], label: string): PersistFleetActionInput {
  const id = `fleet-action-${label}`;
  const input: PersistFleetActionInput = { kind, tenantId: TENANT, fleetAssetId: 'TRUCK-SYNTHETIC',
    actorUserId: USERS.crew.id, deviceActionId: id, manifestKey: `fleet/${id}/manifest.json`,
    payloadHash: 'a'.repeat(64), recordedAt: at(200), payload: kind === 'defect_report'
      ? { fleet_asset_id: 'TRUCK-SYNTHETIC', detected_at: at(200), severity: 'Minor', description: 'Synthetic brake defect.' }
      : { fleet_asset_id: 'TRUCK-SYNTHETIC', performed_at: at(200),
          items: [{ sequence: 1, check_point: 'Brakes', result: 'Pass', severity: 'None' }] } };
  insertRow(env, 'fleet_asset_actions', { device_action_id: id, tenant_id: TENANT, user_id: USERS.crew.id,
    fleet_asset_id: input.fleetAssetId, action_kind: kind, payload_hash: input.payloadHash,
    status: 'r2_stored', manifest_key: input.manifestKey, created_at: at(200), updated_at: at(200) });
  return input;
}

test('vehicle writer returns stop display facts, preserves replay and allows post-trip and defect reports', async () => {
  const env = testEnv();
  asset(env, 'TRUCK-SYNTHETIC');
  const writer = d1FleetActionWriter(env);
  const completed = fleetInput(env, 'pre_trip_inspection', 'completed');
  const prior = await writer.persistAction(completed);
  const stop = await vehicleStop(env, 'TRUCK-SYNTHETIC');
  assert.deepEqual(await writer.persistAction(completed), prior);
  await assert.rejects(writer.persistAction(fleetInput(env, 'pre_trip_inspection', 'blocked')), (error) => {
    assert.ok(error instanceof FieldActionError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'fleet_vehicle_safety_stop_active');
    assert.deepEqual(error.details?.safety_stops, [{ occurrence_id: stop, scope: 'vehicle', reported_at: at(10),
      summary: 'Synthetic vehicle stopped for brake fault.', raiser_display_name: USERS.crew.name }]);
    return true;
  });
  await writer.persistAction(fleetInput(env, 'post_trip_inspection', 'post-trip'));
  await writer.persistAction(fleetInput(env, 'defect_report', 'defect'));
  env.DB.sqlite.exec(`UPDATE fleet_assets SET custody_holder_type = 'Yard', custody_user_id = NULL, last_command_id = 'synthetic-return-yard', version = version + 1`);
  assert.equal(env.DB.sqlite.prepare('SELECT custody_holder_type FROM fleet_assets').get()?.custody_holder_type, 'Yard');
});

test('a concurrent vehicle stop is enforced by D1 and its refusal still includes display facts', async () => {
  const env = testEnv();
  asset(env, 'TRUCK-SYNTHETIC');
  const input = fleetInput(env, 'pre_trip_inspection', 'race');
  // Insert the occurrence directly between the Worker's hold read and inspection write.
  env.DB.beforeWrite = () => insertRow(env, 'safety_occurrences', {
    occurrence_id: 'so_vehicle_race', tenant_id: TENANT, occurrence_kind: 'hazard', severity: 'high', version: 1,
    state: 'reported', stop_active: 1, rescue_required: 0, scope_type: 'vehicle', scope_id: input.fleetAssetId,
    reported_by_user_id: USERS.crew.id, reported_at: at(10), summary: 'Synthetic race stop.',
    report_fingerprint_sha256: 'd'.repeat(64), created_at: at(10), updated_at: at(10),
  });
  await assert.rejects(d1FleetActionWriter(env).persistAction(input), (error) => {
    assert.ok(error instanceof FieldActionError);
    assert.equal(error.code, 'fleet_vehicle_safety_stop_active');
    assert.equal((error.details?.safety_stops as any[])?.[0]?.occurrence_id, 'so_vehicle_race');
    return true;
  });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM fleet_inspections').get()?.n, 0);
});

test('D1 refuses an ambiguous photo id even when only one checksum matches', async () => {
  const env = testEnv();
  const id = await raisedStop(env, USERS.crew);
  const evidenceId = photo(env, 14);
  photo(env, 14, { actionId: 'capture-duplicate-checksum', checksum: 'c'.repeat(64) });
  await assert.rejects(recordSafetyResponse(env, releaseInput(id, [evidenceId])), rejectsCode('safety_stop_release_evidence_invalid'));
  assert.throws(() => directRelease(env, id, [{ ref: `field-evidence://${evidenceId}`, sha256: 'b'.repeat(64) }]), /safety_stop_release_evidence_invalid/);
});

function rescopeInput(env: TestEnv, id: string, overrides: Record<string, unknown> = {}) {
  return { tenantId: TENANT, occurrenceId: id, actorUserId: USERS.owner.id,
    occurrenceVersion: occurrence(env, id).version,
    scope: { type: 'roof_job' as const, id: 'JOB-SYNTHETIC-TARGET' },
    reason: 'The report meant the synthetic target job.', idempotencyKey: 'scope-correction-01', ...overrides };
}

test('owner or ops scope correction preserves the stop, identity and history, and L06 still refuses its raiser', async () => {
  const env = testEnv();
  seedJob(env, 'JOB-SYNTHETIC-TARGET');
  const id = await raisedStop(env, USERS.owner);
  const before = occurrence(env, id);
  const input = rescopeInput(env, id);
  const result = await rescopeSafetyStop(env, input);
  assert.equal(result.replayed, false);
  assert.equal(result.occurrence.scope_id, input.scope.id);
  assert.equal(result.occurrence.stop_active, 1);
  assert.equal(result.occurrence.state, before.state);
  assert.equal(result.occurrence.reported_by_user_id, before.reported_by_user_id);
  assert.equal(result.occurrence.report_fingerprint_sha256, before.report_fingerprint_sha256);
  assert.equal(result.correction.from_version, before.version);
  assert.equal(result.correction.to_version, before.version + 1);
  assert.ok(Math.abs(Date.now() - Date.parse(result.correction.moved_at)) < 5000);
  assert.equal((await rescopeSafetyStop(env, input)).replayed, true);
  await assert.rejects(rescopeSafetyStop(env, { ...input, reason: 'Different correction.' }), rejectsCode('idempotency_conflict'));
  await assert.rejects(recordSafetyResponse(env, { ...releaseInput(id, []), actorUserId: USERS.owner.id }), rejectsCode('safety_stop_release_by_raiser_forbidden'));
  const read = await call(env, await personAuth(env, USERS.owner), occurrencePath(id));
  assert.deepEqual(read.body.scope_corrections, [result.correction]);
  const stored = env.DB.sqlite.prepare('SELECT * FROM safety_occurrence_rescopes').get() as Record<string, string | number | null>;
  assert.throws(() => insertRow(env, 'safety_occurrence_rescopes', { ...stored, reason: 'Replaced correction.' }, true), /safety_stop_rescope_append_only/);
  assert.throws(() => env.DB.sqlite.exec("UPDATE safety_occurrence_rescopes SET reason = 'Changed history.'"), /safety_stop_rescope_append_only/);
  assert.throws(() => env.DB.sqlite.exec('DELETE FROM safety_occurrence_rescopes'), /safety_stop_rescope_retained/);
});

test('scope correction refuses unauthorized people, foreign targets and stale reads without writing', async () => {
  const env = testEnv();
  seedJob(env, 'JOB-SYNTHETIC-TARGET');
  seedJob(env, 'JOB-SYNTHETIC-FOREIGN', 'otherco');
  const id = await raisedStop(env, USERS.crew);
  const before = occurrence(env, id);
  for (const actor of [USERS.crew, USERS.production, USERS.sales]) {
    await assert.rejects(rescopeSafetyStop(env, rescopeInput(env, id, { actorUserId: actor.id })), rejectsCode('safety_rescope_authority_required'));
  }
  await assert.rejects(rescopeSafetyStop(env, rescopeInput(env, id, { scope: { type: 'roof_job', id: 'JOB-SYNTHETIC-FOREIGN' } })), rejectsCode('safety_stop_scope_target_unknown'));
  assert.throws(() => env.DB.sqlite.prepare(`UPDATE safety_occurrences SET scope_id = 'JOB-SYNTHETIC-TARGET', version = version + 1 WHERE occurrence_id = ?`).run(id), /safety_occurrence_identity_immutable/);
  assert.deepEqual(occurrence(env, id), before);
  env.DB.beforeBatch = () => env.DB.sqlite.prepare('UPDATE safety_occurrences SET version = version + 1 WHERE occurrence_id = ?').run(id);
  await assert.rejects(rescopeSafetyStop(env, rescopeInput(env, id)), rejectsCode('safety_occurrence_version_conflict'));
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_occurrence_rescopes').get()?.n, 0);
  assert.equal(occurrence(env, id).stop_active, 1);
});

test('a direct D1 correction applies atomically and retains its resolved target', async () => {
  const env = testEnv();
  seedJob(env, 'JOB-SYNTHETIC-TARGET');
  const id = await raisedStop(env, USERS.crew);
  const before = occurrence(env, id);
  env.DB.sqlite.prepare(`INSERT INTO safety_occurrence_rescopes
    (rescope_id, tenant_id, idempotency_key, request_sha256, occurrence_id, from_version, to_version,
     from_scope_type, from_scope_id, to_scope_type, to_scope_id, moved_by_user_id, moved_by_role, reason, moved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'roof_job', ?, 'roof_job', ?, ?, 'owner', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    .run(`sor_${'d'.repeat(32)}`, TENANT, 'direct-rescope-01', 'd'.repeat(64), id, before.version, before.version + 1,
      SCOPE.id, 'JOB-SYNTHETIC-TARGET', USERS.owner.id, 'Corrected the synthetic job reference.');
  const after = occurrence(env, id);
  assert.equal(after.scope_id, 'JOB-SYNTHETIC-TARGET');
  assert.equal(after.version, before.version + 1);
  assert.equal(after.stop_active, 1);
  assert.throws(() => env.DB.sqlite.prepare('DELETE FROM operating_roof_jobs WHERE roof_job_id = ?').run(after.scope_id), /safety_stop_scope_target_retained/);
  const target = env.DB.sqlite.prepare('SELECT * FROM operating_roof_jobs WHERE roof_job_id = ?').get(after.scope_id) as Record<string, string | number | null>;
  assert.throws(() => insertRow(env, 'operating_roof_jobs', target, true), /safety_stop_scope_target_retained/);
});

test('concurrent identical additions and corrections each retain one auditable receipt', async () => {
  const env = testEnv();
  seedJob(env, 'JOB-SYNTHETIC-TARGET');
  const id = await raisedStop(env, USERS.crew);
  const additions = await Promise.all([addToSafetyStop(env, additionInput(id)), addToSafetyStop(env, additionInput(id))]);
  assert.equal(additions.filter((row) => !row.replayed).length, 1);
  assert.deepEqual(additions[0].addition, additions[1].addition);
  const input = rescopeInput(env, id);
  const corrections = await Promise.all([rescopeSafetyStop(env, input), rescopeSafetyStop(env, input)]);
  assert.equal(corrections.filter((row) => !row.replayed).length, 1);
  assert.deepEqual(corrections[0].correction, corrections[1].correction);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_occurrence_rescopes').get()?.n, 1);
  assert.equal(occurrence(env, id).stop_active, 1);
});

test('replacing an occurrence cannot release it or rewrite the raiser without the guarded command', async () => {
  const env = testEnv();
  // An interrupted report may already have committed its stop before the journal insert. The
  // stop must hold even in that gap, where there is no child FK to incidentally prevent REPLACE.
  const id = 'so_interrupted_report';
  insertRow(env, 'safety_occurrences', { occurrence_id: id, tenant_id: TENANT,
    occurrence_kind: 'hazard', severity: 'high', version: 1, state: 'reported', stop_active: 1,
    rescue_required: 0, scope_type: 'tenant', scope_id: TENANT, reported_by_user_id: USERS.owner.id,
    reported_at: at(10), summary: 'Synthetic interrupted report.', report_fingerprint_sha256: 'e'.repeat(64),
    created_at: at(10), updated_at: at(10) });
  const before = occurrence(env, id);
  assert.throws(() => insertRow(env, 'safety_occurrences', { ...before, stop_active: 0, released_by_user_id: USERS.owner.id }, true), /safety_occurrence_identity_immutable/);
  assert.throws(() => insertRow(env, 'safety_occurrences', { ...before, reported_by_user_id: USERS.crew.id }, true), /safety_occurrence_identity_immutable/);
  assert.deepEqual(occurrence(env, id), before);
});

test('concurrent report retries converge despite the occurrence replacement guard', async () => {
  const env = testEnv();
  const input = { occurrenceId: 'so_concurrent_report', tenantId: TENANT, occurrenceKind: 'hazard' as const,
    severity: 'high' as const, scope: SCOPE, reportedByUserId: USERS.crew.id, reportedAt: at(10),
    summary: 'Synthetic concurrent report.', rescueRequired: false, evidence: null,
    capturedOffline: false, deviceActionId: null, now: at(10) };
  const answers = await Promise.all([reportSafetyOccurrence(env, input),
    reportSafetyOccurrence(env, { ...input, occurrenceId: 'so_concurrent_other_device' })]);
  assert.equal(answers.filter((answer) => answer.kind === 'reported').length, 1);
  assert.equal(answers[0].occurrence.occurrence_id, answers[1].occurrence.occurrence_id);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_occurrences').get()?.n, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_occurrence_events').get()?.n, 1);
});

test('effective latch: only owner or ops person sessions may confirm the same late-arriving job', async () => {
  for (const actor of [USERS.owner, USERS.ops]) {
    const env = testEnv();
    const id = await raisedStop(env, USERS.owner);
    seedJob(env);
    const before = occurrence(env, id);
    const body = { occurrence_version: before.version, scope_type: 'roof_job', scope_id: SCOPE.id,
      reason: 'Explicitly confirmed the late-arriving synthetic job.' };
    const headers = { 'idempotency-key': 'late-target-person-session' };
    assert.equal((await call(env, connectorAuth(actor), `${occurrencePath(id)}/scope`, body, headers)).body.error,
      'safety_stop_rescope_person_required');
    const corrected = await call(env, await personAuth(env, actor), `${occurrencePath(id)}/scope`, body, headers);
    assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
    const after = occurrence(env, id);
    assert.equal(after.version, before.version + 1);
    assert.equal(after.scope_id, before.scope_id);
    assert.equal(after.stop_active, 1);
    assert.equal(after.reported_by_user_id, USERS.owner.id);
    await assert.rejects(recordSafetyResponse(env, { ...releaseInput(id, []), actorUserId: USERS.owner.id }),
      rejectsCode('safety_stop_release_by_raiser_forbidden'));
  }
});

for (const race of ['authority', 'target'] as const) {
  test(`effective latch: correction refuses raced ${race} changes without phantom history`, async () => {
    const env = testEnv();
    seedJob(env, 'JOB-SYNTHETIC-TARGET');
    const id = await raisedStop(env, USERS.crew);
    const before = occurrence(env, id);
    env.DB.beforeBatch = () => {
      if (race === 'authority') {
        env.DB.sqlite.prepare("UPDATE app_users SET access_role = 'field' WHERE user_id = ?").run(USERS.owner.id);
      } else {
        env.DB.sqlite.prepare('DELETE FROM operating_roof_jobs WHERE roof_job_id = ?').run('JOB-SYNTHETIC-TARGET');
      }
    };
    await assert.rejects(rescopeSafetyStop(env, rescopeInput(env, id)),
      rejectsCode(race === 'authority' ? 'safety_actor_unknown' : 'safety_stop_scope_target_unknown'));
    assert.deepEqual(occurrence(env, id), before);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_occurrence_rescopes').get()?.n, 0);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_stop_unresolved_scopes').get()?.n, 1);
  });
}

function installAdditionsMigration(env: TestEnv) {
  env.DB.sqlite.exec(readFileSync(new URL('../migrations/0171_safety_stop_additions_release_photo_rescope.sql', import.meta.url), 'utf8'));
}

function consumeSavedRelease(env: TestEnv, id: string) {
  return env.DB.sqlite.prepare(`UPDATE safety_occurrences SET version = version + 1, stop_active = 0,
    released_by_user_id = ?, updated_at = ? WHERE occurrence_id = ?`)
    .run(USERS.ops.id, new Date().toISOString(), id);
}

const storedRefs = (evidenceId: string, checksum = 'b'.repeat(64)) =>
  [{ ref: `field-evidence://${evidenceId}`, sha256: checksum }];

test('retained release: new journal proof must name the immediate next occurrence version', async () => {
  const env = testEnv();
  seedJob(env);
  const id = await raisedStop(env, USERS.crew);
  const before = occurrence(env, id);
  const evidenceId = photo(env, 901);
  assert.throws(() => directRelease(env, id, storedRefs(evidenceId), before.version + 2), /safety_occurrence_version_conflict/);
  assert.deepEqual(occurrence(env, id), before);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM safety_occurrence_events WHERE event_kind = 'released'").get()?.n, 0);
});

test('retained release: legacy future proof is rechecked when consumed after a human scope correction', async () => {
  const env = testEnv(undefined, { beforeAdditionsMigration: true });
  seedJob(env, 'JOB-SYNTHETIC-CONFIRMED');
  const id = await raisedStop(env, USERS.crew);
  const before = occurrence(env, id);
  const evidenceId = photo(env, 902, { jobId: 'JOB-SYNTHETIC-UNRELATED' });
  directRelease(env, id, storedRefs(evidenceId), before.version + 2);
  const saved = env.DB.sqlite.prepare("SELECT * FROM safety_occurrence_events WHERE event_kind = 'released'").get();
  installAdditionsMigration(env);
  await rescopeSafetyStop(env, rescopeInput(env, id, { scope: { type: 'roof_job', id: 'JOB-SYNTHETIC-CONFIRMED' } }));
  const corrected = occurrence(env, id);
  assert.equal(corrected.version, before.version + 1);
  assert.deepEqual(await stopReleasePhotos(env, corrected as any), []);
  await assert.rejects(recordSafetyResponse(env, releaseInput(id, [evidenceId])), rejectsCode('safety_stop_release_evidence_invalid'));
  assert.throws(() => consumeSavedRelease(env, id), /safety_stop_release_evidence_invalid/);
  assert.deepEqual(occurrence(env, id), corrected);
  assert.deepEqual(env.DB.sqlite.prepare("SELECT * FROM safety_occurrence_events WHERE event_kind = 'released'").get(), saved);
});

for (const invalid of ['missing_refs', 'missing_manifest', 'unverified', 'wrong_checksum', 'before_stop', 'ambiguous_id', 'non_photo'] as const) {
  test(`retained release: actual use rejects legacy ${invalid} proof`, async () => {
    const env = testEnv(undefined, { beforeAdditionsMigration: true });
    seedJob(env);
    const id = await raisedStop(env, USERS.crew);
    const before = occurrence(env, id);
    const overrides = invalid === 'missing_manifest' ? { manifested: false }
      : invalid === 'unverified' ? { status: 'r2_stored' }
      : invalid === 'before_stop' ? { capturedAt: before.reported_at }
      : invalid === 'non_photo' ? { contentType: 'application/pdf' } : {};
    const evidenceId = photo(env, 903, overrides);
    if (invalid === 'ambiguous_id') photo(env, 903, { actionId: 'synthetic-legacy-duplicate' });
    directRelease(env, id, invalid === 'missing_refs' ? null : storedRefs(evidenceId, (invalid === 'wrong_checksum' ? 'c' : 'b').repeat(64)));
    installAdditionsMigration(env);
    const expected = invalid === 'missing_refs' ? /safety_stop_release_evidence_required/
      : invalid === 'before_stop' ? /safety_stop_release_evidence_before_stop/ : /safety_stop_release_evidence_invalid/;
    assert.throws(() => consumeSavedRelease(env, id), expected);
    assert.deepEqual(occurrence(env, id), before);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM safety_occurrence_events WHERE event_kind = 'released'").get()?.n, 1);
  });
}

test('retained release: a photo that becomes ambiguous after insertion cannot lift the stop', async () => {
  const env = testEnv();
  seedJob(env);
  const id = await raisedStop(env, USERS.crew);
  const before = occurrence(env, id);
  const evidenceId = photo(env, 904);
  directRelease(env, id, storedRefs(evidenceId));
  photo(env, 904, { actionId: 'synthetic-new-duplicate' });
  assert.throws(() => consumeSavedRelease(env, id), /safety_stop_release_evidence_invalid/);
  assert.deepEqual(occurrence(env, id), before);
});

test('retained release: actual use needs current authority and permits a still-authorized promotion', async () => {
  const env = testEnv();
  seedJob(env);
  const id = await raisedStop(env, USERS.crew);
  const before = occurrence(env, id);
  directRelease(env, id, storedRefs(photo(env, 905)));
  env.DB.sqlite.prepare("UPDATE app_users SET access_role = 'sales' WHERE user_id = ?").run(USERS.ops.id);
  assert.throws(() => consumeSavedRelease(env, id), /safety_actor_unknown/);
  assert.deepEqual(occurrence(env, id), before);
  env.DB.sqlite.prepare("UPDATE app_users SET access_role = 'owner' WHERE user_id = ?").run(USERS.ops.id);
  assert.doesNotThrow(() => consumeSavedRelease(env, id));
  assert.equal(occurrence(env, id).stop_active, 0);
});

function interruptedPackage(id: string, job: string, assignment: string) {
  const row = { work_package_id: id, tenant_id: TENANT, version: 1, job_id: job, assignment_id: assignment,
    work_object_type: 'Roof Job', work_object_id: job, physical_context_type: 'Roof Site', physical_context_id: job,
    assignment_authority_user: null, assignment_authority_role: null, status: 'Released', title: 'Synthetic package',
    objective: 'Synthetic objective', boundaries: 'Synthetic boundaries', prerequisites: 'Synthetic prerequisites',
    expected_result: 'Synthetic result', stop_conditions: 'Stop for danger', make_safe_procedure: 'Leave synthetic site',
    issued_at: at(-10), expires_at: at(900), released_at: at(-10), release_attempt_id: `synthetic-attempt-${id}`,
    supersedes_id: null, correction_reason: null, created_at: at(-10), updated_at: at(-10) };
  return { ...row, definition_json: JSON.stringify(row) };
}

for (const recursive of [false, true]) {
  for (const key of ['primary', 'current_assignment'] as const) {
    test(`retained target: package ${key} replacement stays closed with recursive triggers ${recursive}`, async () => {
      const env = testEnv();
      env.DB.sqlite.exec(`PRAGMA recursive_triggers = ${recursive ? 'ON' : 'OFF'}`);
      seedJob(env, 'JOB-SYNTHETIC-ORIGINAL');
      seedJob(env, 'JOB-SYNTHETIC-SUBSTITUTE');
      const target = interruptedPackage('WP-SYNTHETIC-ORIGINAL', 'JOB-SYNTHETIC-ORIGINAL', 'ASSIGN-SYNTHETIC-ORIGINAL');
      insertRow(env, 'work_packages', target);
      const storedTarget = env.DB.sqlite.prepare('SELECT * FROM work_packages WHERE work_package_id = ?').get(target.work_package_id);
      assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_package_events').get()?.n, 0);
      const id = await raisedStop(env, USERS.crew);
      await rescopeSafetyStop(env, rescopeInput(env, id, { scope: { type: 'work_package', id: target.work_package_id } }));
      const before = occurrence(env, id);
      const replacement = key === 'primary' ? target : interruptedPackage('WP-SYNTHETIC-CONFLICT', target.job_id, target.assignment_id);
      assert.throws(() => insertRow(env, 'work_packages', replacement, true), /safety_stop_scope_target_retained/);
      assert.throws(() => insertRow(env, 'work_packages', interruptedPackage(target.work_package_id, 'JOB-SYNTHETIC-SUBSTITUTE', 'ASSIGN-SYNTHETIC-NEW'), true), /safety_stop_scope_target_retained/);
      assert.deepEqual(env.DB.sqlite.prepare('SELECT * FROM work_packages WHERE work_package_id = ?').get(target.work_package_id), storedTarget);
      const held = await holdingSafetyStops(env, TENANT, [target.job_id, 'JOB-SYNTHETIC-SUBSTITUTE']);
      assert.equal(held.get(target.job_id)?.length, 1);
      assert.deepEqual(held.get('JOB-SYNTHETIC-SUBSTITUTE'), []);
      assert.deepEqual(occurrence(env, id), before);
      assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM safety_occurrence_rescopes').get()?.n, 1);
      assert.doesNotThrow(() => insertRow(env, 'work_packages', interruptedPackage('WP-SYNTHETIC-UNRELATED', 'JOB-SYNTHETIC-SUBSTITUTE', 'ASSIGN-SYNTHETIC-UNRELATED')));
    });
  }
}

for (const tenant of [TENANT, 'otherco']) {
  test(`retained target: job replacement conflict preserves the protected existing tenant for ${tenant}`, async () => {
    const env = testEnv();
    seedJob(env, 'JOB-SYNTHETIC-TARGET');
    seedJob(env, 'JOB-SYNTHETIC-OTHER', tenant);
    const id = await raisedStop(env, USERS.crew);
    await rescopeSafetyStop(env, rescopeInput(env, id));
    const original = env.DB.sqlite.prepare('SELECT * FROM operating_roof_jobs WHERE roof_job_id = ?').get('JOB-SYNTHETIC-TARGET') as Record<string, string | number | null>;
    const other = env.DB.sqlite.prepare('SELECT * FROM operating_roof_jobs WHERE roof_job_id = ?').get('JOB-SYNTHETIC-OTHER') as Record<string, string | number | null>;
    assert.throws(() => insertRow(env, 'operating_roof_jobs', { ...other, roof_job_id: original.roof_job_id }, true), /safety_stop_scope_target_retained/);
    assert.deepEqual(env.DB.sqlite.prepare('SELECT * FROM operating_roof_jobs WHERE roof_job_id = ?').get(original.roof_job_id), original);
  });
}

test('retained target: every declared unique key is inventoried for guard coverage', () => {
  const env = testEnv();
  const unique = (table: string) => (env.DB.sqlite.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number; partial: number }>)
    .filter((index) => index.unique === 1).map((index) => ({ partial: index.partial,
      columns: (env.DB.sqlite.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map((column) => column.name) }))
    .sort((a, b) => a.columns.join(',').localeCompare(b.columns.join(',')));
  assert.deepEqual(unique('operating_roof_jobs'), [
    { partial: 0, columns: ['roof_job_id'] }, { partial: 0, columns: ['roof_job_id', 'tenant_id'] },
  ]);
  assert.deepEqual(unique('work_packages'), [
    { partial: 1, columns: ['tenant_id', 'job_id', 'assignment_id'] },
    { partial: 0, columns: ['work_package_id', 'tenant_id', 'version'] },
  ]);
});
