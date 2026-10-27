import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { authenticateAppRequest, randomToken, sessionHashFor } from "../src/app-auth.ts";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import { buildOwnerNowReadModel } from "../src/app-read-models.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";
import { recordProposalDeliveryConfirmation } from "../src/commercial-store.ts";
import {
  EFFECT_ATTEMPT_LEASE_MS,
  authorizeExternalEffect,
  claimExternalEffect,
  proposeExternalEffect,
  reconcileExternalEffect,
  recoverExpiredExternalEffects,
  runExternalEffect,
  type EffectAuthority,
  type ExternalEffectRequest,
} from "../src/effect-runtime.ts";
import {
  PROPOSAL_DELIVERY_CHECK_LIMIT,
  PROPOSAL_DELIVERY_ESCALATION_MS,
  PROPOSAL_DELIVERY_STALE_REASON,
  ProposalDeliveryTransportError,
  checkProposalDelivery,
  escalateStaleProposalDeliveries,
  readProposalDeliveryState,
  type ProposalDeliveryReadbackAdapter,
} from "../src/proposal-delivery-checks.ts";
import {
  OTHER_TENANT,
  SqliteD1,
  TENANT,
  USERS,
  auth as fixtureAuth,
  env as fixtureEnv,
  type SqliteStatement,
} from "./company-setup-fixture.ts";

// #15b-1b, migration 0167: a person's "Check delivery" reads back what the provider knows about one
// proposal send and keeps the answer as one append-only row; no check moves the send. A send whose
// provider answered (a readback conflict, from reconciling or from failed) may be recorded as not
// delivered only by citing a check newer than that conflict that scanned completely and found
// nothing; until Proof P1 no check can, so the conflict stays an exception. D1 rules run against the
// full migration chain with raw SQL and the in-process runtime; the routes run through the Worker's
// own router with a real person session.

const REAL = "native-commercial-publication";
const QA = "qa-synthetic-publication";
/** A test-only provider whose own late answer can never arrive after its attempt ends (window 0). */
const PROMPT = "synthetic-prompt-provider";
const OTHER_OPS = "appu_other_ops_0001";
const PEPPER = "proposal-delivery-checks-test-pepper-0123456789abcdef";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** D1 answers a batch with `{ meta: { changes } }` per statement, as the lease claim reads it. */
class D1 extends SqliteD1 {
  constructor() {
    super({ seedUsers: ["owner", "ops", "sales", "production"] });
    this.addUser("ops", OTHER_TENANT, OTHER_OPS);
    this.raw.prepare(
      `INSERT INTO proposal_delivery_late_answer_windows (provider, window_ms, source)
       VALUES (?, 0, 'Test-only provider: its late answer can never arrive after its attempt ends.')`,
    ).run(PROMPT);
  }

  override async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    const results = (await super.batch(statements)) as Array<{ changes?: number | bigint }>;
    return results.map((result) => ({ success: true, meta: { changes: Number(result.changes ?? 0) } }));
  }
}

function workerEnv(db: D1, dataClass = "business"): AppEnv {
  return fixtureEnv(db, {
    EFFECT_RUNTIME_ENABLED: "true",
    APP_AUTH_PEPPER: PEPPER,
    AGENT_DATA_CLASS: dataClass,
  } as never);
}

const deadline = () => new Date(Date.now() + 30 * 60_000).toISOString();

/** A send envelope as the bus writes one; its authority names no permit unless a test adds one. */
function envelope(
  id: string,
  options: { provider?: string; action?: string; tenantId?: string; aggregateType?: string } = {},
) {
  const action = options.action ?? "proposal.publish";
  const tenantId = options.tenantId ?? TENANT;
  const actorId = tenantId === TENANT ? USERS.ops : OTHER_OPS;
  const deadlineAt = deadline();
  const binding = { permitRef: `synthetic-authority:delivery-check:${id}`, policyRef: "synthetic-delivery-check", policyVersion: "v1" };
  const request = { proposal_revision_id: `proposal-revision:${id}`, proposal_pack_id: `proposal-pack:${id}`, state: "published" };
  return {
    effect: {
      effectId: `effect:delivery-check:${id}`,
      tenantId,
      actor: { type: "worker" as const, id: actorId },
      taskId: `task:${id}`,
      authority: binding,
      aggregate: { type: options.aggregateType ?? "proposal_publication", id: `proposal-pack:${id}`, version: 1 },
      intentId: `proposal-revision:${id}`,
      action,
      request,
      provider: options.provider ?? REAL,
      idempotencyKey: `delivery-check:${id}`,
      deadlineAt,
      expectedReadback: request,
      correlationId: `correlation:${id}`,
    },
    authority: {
      ...binding,
      tenantId,
      actorType: "worker" as const,
      actorId,
      expiresAt: deadlineAt,
      allowedActions: [action],
    },
  };
}

/** One send run in the bus: lost (unknown), refused (failed), read back wrong (a conflict), or accepted. */
async function send(
  env: AppEnv,
  id: string,
  mode: "lost" | "refused" | "conflict" | "accepted",
  options: Parameters<typeof envelope>[1] = {},
): Promise<string> {
  const { effect, authority } = envelope(id, options);
  const result = await runExternalEffect(env, { ...effect, authority } as never, {
    async dispatch() {
      if (mode === "lost") throw new Error("synthetic_provider_response_lost");
      if (mode === "refused") return { outcome: "rejected" as const, detailCode: "provider_refused" };
      return {
        outcome: "accepted" as const,
        providerExternalId: `provider:${id}`,
        readback: {
          status: "match" as const,
          observed: mode === "conflict" ? { ...effect.request, state: "withdrawn" } : effect.request,
        },
      };
    },
    async replay() {
      return {};
    },
  });
  return result.effect.effect_id;
}

/** A send the provider refused that a later check says ran: failed -> manual_exception. */
async function failedConflict(env: AppEnv, id: string, provider = PROMPT, now?: string): Promise<string> {
  const effectId = await send(env, id, "refused", { provider });
  const contradicted = await reconcileExternalEffect(env, effectId, {
    outcome: "executed",
    evidence: { provider: "found the message after all" },
    ...(now === undefined ? {} : { now }),
  });
  assert.equal(contradicted.state, "manual_exception");
  return effectId;
}

const count = (db: D1, sql: string, ...args: Array<string | number>) =>
  Number((db.raw.prepare(sql).get(...args) as { n: number }).n);
const effectRow = (db: D1, effectId: string) =>
  ({ ...(db.raw.prepare("SELECT * FROM external_effects WHERE effect_id = ?").get(effectId) as Record<string, any>) });
const stateOf = (db: D1, effectId: string) => effectRow(db, effectId).state as string;
const moveTo = (db: D1, effectId: string, state: string, at: string) =>
  db.raw.prepare("UPDATE external_effects SET state = ?, updated_at = ? WHERE effect_id = ?").run(state, at, effectId);
const conflictAt = (db: D1, effectId: string) =>
  (db.raw.prepare(
    `SELECT occurred_at FROM external_effect_events WHERE effect_id = ? AND to_state = 'manual_exception'
      ORDER BY event_seq DESC LIMIT 1`,
  ).get(effectId) as { occurred_at: string }).occurred_at;
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

let rawSequence = 0;
/** One check row written straight to D1, as a Worker would write it unless a test overrides a field. */
function insertCheck(
  db: D1,
  effectId: string,
  options: Partial<{
    checkId: string;
    tenantId: string;
    packId: string;
    revisionId: string;
    effectState: string;
    userId: string;
    role: string;
    keyHash: string;
    outcome: string;
    scanComplete: number;
    evidence: string | null;
    unavailableSince: string | null;
    createdAt: string;
    replace: boolean;
  }> = {},
): string {
  const effect = effectRow(db, effectId);
  const n = ++rawSequence;
  const outcome = options.outcome ?? "unknown";
  const createdAt = options.createdAt ?? new Date().toISOString();
  const checkId = options.checkId ?? `delivery-check:raw-${String(n).padStart(6, "0")}`;
  db.raw.prepare(
    `INSERT ${options.replace ? "OR REPLACE " : ""}INTO proposal_delivery_checks
       (check_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, effect_state,
        requested_by_user_id, requested_by_role, idempotency_key_hash, request_sha256, outcome,
        scan_complete, provider_external_id, evidence_sha256, unavailable_since, detail_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
  ).run(
    checkId, options.tenantId ?? effect.tenant_id, effectId,
    options.packId ?? effect.aggregate_id, options.revisionId ?? effect.intent_id,
    options.effectState ?? effect.state,
    options.userId ?? USERS.ops, options.role ?? "ops",
    options.keyHash ?? sha256(`raw-check-key-${n}`), sha256(`raw-check-request-${n}`),
    outcome, options.scanComplete ?? (outcome === "not_found" ? 1 : 0),
    options.evidence === undefined
      ? (["sent", "bounced", "not_found"].includes(outcome) ? sha256(`raw-check-evidence-${n}`) : null)
      : options.evidence,
    options.unavailableSince === undefined
      ? (outcome === "provider_unavailable" ? createdAt : null)
      : options.unavailableSince,
    createdAt,
  );
  return checkId;
}

/** One confirmation row written straight to D1, as 0156's route would write it. */
function insertConfirmation(
  db: D1,
  effectId: string,
  outcome: "delivered" | "not_delivered",
  options: Partial<{ tenantId: string; checkId: string | null; createdAt: string; userId: string }> = {},
): void {
  const effect = effectRow(db, effectId);
  const n = ++rawSequence;
  db.raw.prepare(
    `INSERT INTO proposal_delivery_confirmations
       (confirmation_id, tenant_id, effect_id, proposal_pack_id, proposal_revision_id, outcome, note,
        confirmed_by_user_id, confirmed_by_role, idempotency_key_hash, request_sha256, created_at,
        delivery_check_id)
     VALUES (?, ?, ?, ?, ?, ?, 'Checked with the customer by phone.', ?, 'ops', ?, ?, ?, ?)`,
  ).run(
    `delivery-confirmation:raw-${String(n).padStart(6, "0")}`, options.tenantId ?? effect.tenant_id, effectId,
    effect.aggregate_id, effect.intent_id, outcome, options.userId ?? USERS.ops,
    sha256(`raw-confirmation-key-${n}`), sha256(`raw-confirmation-request-${n}`),
    options.createdAt ?? new Date().toISOString(), options.checkId ?? null,
  );
}

/** The send's own permit, as 0093 would have bound it, so the permit holder can be named. */
function insertPermit(db: D1, effectId: string, tenantId = TENANT, permitId?: string): void {
  const effect = effectRow(db, effectId);
  const issuedAt = new Date(Date.parse(effect.created_at) - 1_000).toISOString();
  db.raw.prepare(
    `INSERT INTO commercial_authority_permits
       (permit_id, tenant_id, policy_id, policy_version, policy_digest, policy_snapshot_json, action,
        actor_type, actor_id, aggregate_type, aggregate_id, aggregate_version, amount_cents,
        command_fingerprint, facts_digest, evidence_refs_json, evidence_digest, idempotency_key_hash,
        request_fingerprint, issued_at, expires_at)
     VALUES (?, ?, 'synthetic-delivery-check', 'v1', ?, '{}', 'proposal.publish', 'worker', ?,
             'proposal_publication', ?, 1, NULL, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    permitId ?? effect.authority_ref, tenantId, sha256("policy"), effect.actor_id, effect.aggregate_id,
    sha256(`command:${effectId}`), sha256(`facts:${effectId}`), sha256(`evidence:${effectId}`),
    sha256(`permit-key:${effectId}:${tenantId}`), sha256(`permit-request:${effectId}`),
    issuedAt, deadline(),
  );
}

/** A real signed-in person: the session row sign-in would write, and the CSRF token it answers. */
async function person(db: D1, env: AppEnv, role: AppRole): Promise<AuthContext> {
  const token = randomToken();
  const now = new Date();
  db.raw.prepare(
    `INSERT INTO app_sessions
       (session_hash, user_id, tenant_id, created_at, expires_at, revoked_at, last_seen_at,
        created_ip_hash, created_user_agent_hash, device_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  ).run(
    await sessionHashFor(env, token), USERS[role], TENANT, now.toISOString(),
    new Date(now.getTime() + 3_600_000).toISOString(), now.toISOString(), "d".repeat(64), "e".repeat(64),
  );
  const authenticated = await authenticateAppRequest(
    new Request("https://app.example.invalid/api/v1/session", { headers: { cookie: `__Host-ironwrap_session=${token}` } }),
    env,
  );
  assert.ok(authenticated.ok);
  return authenticated.auth;
}

const CHECK_PATH = "/api/v1/commercial/proposal-publications/delivery-checks";
const CONFIRM_PATH = "/api/v1/commercial/proposal-publications/delivery-confirmations";
const READ_PATH = "/api/v1/commercial/proposal-publications/delivery";

async function post(
  env: AppEnv,
  auth: AuthContext,
  path: string,
  body: unknown,
  key: string | null,
  csrf = auth.csrfToken,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf,
        ...(key === null ? {} : { "idempotency-key": key }),
      },
      body: JSON.stringify(body),
    }),
    env,
    auth,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function read(env: AppEnv, auth: AuthContext, query: string) {
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${READ_PATH}${query}`, { method: "GET" }),
    env,
    auth,
  );
  return { status: response.status, body: await response.json() as Record<string, any> };
}

/** Run a check in-process with a scripted readback, as later adapters will answer. */
const check = (
  env: AppEnv,
  effectId: string,
  key: string,
  adapter?: ProposalDeliveryReadbackAdapter,
  timeoutMs?: number,
  clock?: () => number,
) =>
  checkProposalDelivery(env, {
    tenantId: TENANT,
    effectId,
    actorUserId: USERS.ops,
    actorRole: "ops",
    idempotencyKey: key,
    ...(adapter ? { adapter } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(clock ? { clock } : {}),
  });
/** A readback that can scan completely, as the Gmail readback will after Proof P1. */
const scanning = (answer: () => Promise<Awaited<ReturnType<ProposalDeliveryReadbackAdapter>>>): ProposalDeliveryReadbackAdapter =>
  Object.assign(async () => await answer(), { scansCompletely: true });
const endedAtOf = (db: D1, effectId: string) =>
  (db.raw.prepare("SELECT ended_at FROM external_effect_attempts WHERE effect_id = ?").get(effectId) as { ended_at: string }).ended_at;
const notFoundComplete: ProposalDeliveryReadbackAdapter = async () => ({
  outcome: "not_found",
  scanComplete: true,
  evidence: { scanned: "every message from the send's mailbox", matched: 0 },
});

// ---------------------------------------------------------------------------------------------
// D1: the check row

test("a check names a proposal send of its own tenant, pack and revision, in the state it saw", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const lost = await send(env, "row:lost", "lost");
  const effect = effectRow(db, lost);
  const invalid = /proposal_delivery_check_effect_invalid/;
  assert.throws(() => insertCheck(db, lost, { packId: "proposal-pack:another" }), invalid);
  assert.throws(() => insertCheck(db, lost, { revisionId: "proposal-revision:another" }), invalid);
  assert.throws(() => insertCheck(db, lost, { effectState: "succeeded" }), invalid);
  assert.throws(() => insertCheck(db, lost, { tenantId: OTHER_TENANT, userId: OTHER_OPS }), invalid);
  // Only checkable states are kept at all.
  assert.throws(() => insertCheck(db, lost, { effectState: "failed" }), invalid);
  // A withdrawal, or a publish bound to another aggregate, is not a proposal publication send.
  const withdrawal = await send(env, "row:withdraw", "lost", { action: "proposal.withdraw" });
  assert.throws(() => insertCheck(db, withdrawal), invalid);
  const misbound = await send(env, "row:misbound", "lost", { aggregateType: "communication" });
  assert.equal(stateOf(db, misbound), "unknown");
  assert.throws(() => insertCheck(db, misbound), invalid);
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), 0);
  insertCheck(db, lost);
  assert.equal(effect.state, "unknown");
  assert.equal(stateOf(db, lost), "unknown");
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), 1);
});

test("a check is asked for by an active account holder of the same tenant in that role", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const lost = await send(env, "row:actor", "lost");
  const actor = /proposal_delivery_check_actor_invalid/;
  assert.throws(() => insertCheck(db, lost, { userId: USERS.ops, role: "sales" }), actor);
  assert.throws(() => insertCheck(db, lost, { userId: OTHER_OPS, role: "ops" }), actor);
  assert.throws(() => insertCheck(db, lost, { userId: "appu_nobody_0001", role: "ops" }), actor);
  // An active production person in their own role passes the person rule; the role list refuses them.
  assert.throws(() => insertCheck(db, lost, { userId: USERS.production, role: "production" }), /CHECK constraint failed/);
  db.deactivateUser(USERS.sales);
  assert.throws(() => insertCheck(db, lost, { userId: USERS.sales, role: "sales" }), actor);
  insertCheck(db, lost, { userId: USERS.owner, role: "owner" });
});

test("a check is dated by the Worker's clock within a minute of D1's, and unavailable_since precedes it", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const lost = await send(env, "row:clock", "lost");
  const skew = /proposal_delivery_check_clock_skew/;
  assert.throws(() => insertCheck(db, lost, { createdAt: new Date(Date.now() - 90_000).toISOString() }), skew);
  assert.throws(() => insertCheck(db, lost, { createdAt: new Date(Date.now() + 90_000).toISOString() }), skew);
  assert.throws(() => insertCheck(db, lost, { createdAt: "not-a-timestamp-at-all" }), skew);
  insertCheck(db, lost, { createdAt: new Date(Date.now() - 30_000).toISOString() });

  const since = /proposal_delivery_check_unavailable_since_invalid/;
  const now = new Date().toISOString();
  assert.throws(() => insertCheck(db, lost, { outcome: "provider_unavailable", createdAt: now, unavailableSince: plus(now, 1) }), since);
  assert.throws(() => insertCheck(db, lost, { outcome: "provider_unavailable", unavailableSince: "not-a-timestamp-at-all" }), since);
  assert.throws(() => insertCheck(db, lost, { outcome: "provider_unavailable", unavailableSince: null }), /CHECK constraint failed/);
  assert.throws(() => insertCheck(db, lost, { outcome: "unknown", unavailableSince: now }), /CHECK constraint failed/);
  insertCheck(db, lost, { outcome: "provider_unavailable", createdAt: now, unavailableSince: plus(now, -600_000) });
  insertCheck(db, lost, { outcome: "provider_unavailable", createdAt: now, unavailableSince: now });
});

test("not found needs a complete scan, an unconfirmed send, evidence, and the provider's window to have passed", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const prompt = await send(env, "row:not-found:prompt", "lost", { provider: PROMPT });
  assert.throws(() => insertCheck(db, prompt, { outcome: "not_found", scanComplete: 0 }), /CHECK constraint failed/);
  assert.throws(() => insertCheck(db, prompt, { outcome: "not_found", evidence: null }), /CHECK constraint failed/);
  insertCheck(db, prompt, { outcome: "not_found" });
  // A sent attempt is only ever checked for a bounce.
  const accepted = await send(env, "row:not-found:sent", "accepted", { provider: PROMPT });
  assert.equal(stateOf(db, accepted), "succeeded");
  assert.throws(() => insertCheck(db, accepted, { outcome: "not_found" }), /CHECK constraint failed/);
  insertCheck(db, accepted, { outcome: "bounced" });

  // The default window (0161's `*` row): two minutes after the attempt ended.
  const real = await send(env, "row:not-found:real", "lost");
  assert.throws(() => insertCheck(db, real, { outcome: "not_found" }), /proposal_delivery_check_too_early/);
  insertCheck(db, real, { outcome: "unknown" });
  // The anchor is the end of the attempt, not the send's last move: a refused send moved into the
  // exception later is checkable as soon as its own window from the refusal has passed.
  const contradicted = await failedConflict(env, "row:not-found:anchor", PROMPT, new Date(Date.now() + 30_000).toISOString());
  insertCheck(db, contradicted, { outcome: "not_found" });
});

test("a check is dated as its readback starts, so a scan begun inside the provider's window is too early", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await send(env, "dated:start", "lost", { provider: PROMPT });
  const opensAt = Date.parse(endedAtOf(db, effectId));
  // The scan starts a millisecond before the window closes and answers well after it: refused, and
  // nothing is written.
  const slow = scanning(async () => {
    await new Promise((done) => setTimeout(done, 30));
    return { outcome: "not_found", scanComplete: true, evidence: { matched: 0 } };
  });
  await assert.rejects(check(env, effectId, "dated:start:early", slow, undefined, () => opensAt - 1), {
    code: "proposal_delivery_check_too_early",
    status: 409,
  });
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks WHERE effect_id = ?", effectId), 0);
  // Started as the window closes: kept, dated at its start.
  const kept = await check(env, effectId, "dated:start:on-time", slow, undefined, () => opensAt);
  assert.equal(kept.check.outcome, "not_found");
  assert.equal(kept.check.created_at, new Date(opensAt).toISOString());
});

test("one row per check and per key; a check is never changed, removed or replaced", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const lost = await send(env, "row:append", "lost");
  const first = insertCheck(db, lost, { keyHash: sha256("key-one") });
  const exists = /proposal_delivery_check_exists/;
  assert.throws(() => insertCheck(db, lost, { checkId: first, keyHash: sha256("key-two") }), exists);
  assert.throws(() => insertCheck(db, lost, { keyHash: sha256("key-one") }), exists);
  assert.throws(() => insertCheck(db, lost, { checkId: first, keyHash: sha256("key-one"), replace: true }), exists);
  // A key is the tenant's own: another tenant may use the same one.
  const other = await send(env, "row:append:other", "lost", { tenantId: OTHER_TENANT });
  insertCheck(db, other, { keyHash: sha256("key-one"), userId: OTHER_OPS });
  assert.throws(() => db.raw.prepare("UPDATE proposal_delivery_checks SET outcome = 'sent' WHERE check_id = ?").run(first), /proposal_delivery_checks_append_only/);
  assert.throws(() => db.raw.prepare("DELETE FROM proposal_delivery_checks WHERE check_id = ?").run(first), /proposal_delivery_checks_append_only/);
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks WHERE effect_id = ?", lost), 1);
});

test("at most twenty checks of each kind are kept per send: answers that prove nothing never use up the proof's or a found message's room", async () => {
  const db = new D1();
  const env = workerEnv(db);
  assert.equal(PROPOSAL_DELIVERY_CHECK_LIMIT, 20);
  const lost = await send(env, "row:limit", "lost", { provider: PROMPT });
  const other = await send(env, "row:limit:other", "lost", { provider: PROMPT });
  for (let n = 0; n < 20; n += 1) insertCheck(db, lost, { outcome: n % 2 ? "unknown" : "provider_unavailable" });
  assert.throws(() => insertCheck(db, lost), /proposal_delivery_check_limit/);
  // A bounce is one of the other answers.
  assert.throws(() => insertCheck(db, lost, { outcome: "bounced" }), /proposal_delivery_check_limit/);
  insertCheck(db, other);
  // A found message keeps its own room: twenty answers that prove nothing never refuse it.
  for (let n = 0; n < 20; n += 1) insertCheck(db, lost, { outcome: "sent" });
  assert.throws(() => insertCheck(db, lost, { outcome: "sent" }), /proposal_delivery_check_limit/);
  // So does the citable kind.
  for (let n = 0; n < 20; n += 1) insertCheck(db, lost, { outcome: "not_found" });
  assert.throws(() => insertCheck(db, lost, { outcome: "not_found" }), /proposal_delivery_check_limit/);
  for (let n = 0; n < 20; n += 1) insertCheck(db, other, { outcome: "not_found" });
  insertCheck(db, other, { outcome: "sent" });
  insertCheck(db, other, { outcome: "unknown" });
});

test("the Worker refuses a check nobody could keep before it calls the provider, and the read says so", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await send(env, "quota:worker", "lost", { provider: PROMPT });
  const read = async () => await readProposalDeliveryState(env, TENANT, "proposal-pack:quota:worker", "proposal-revision:quota:worker");
  let calls = 0;
  // Like every provider without a readback yet: it can never find the message.
  const blind: ProposalDeliveryReadbackAdapter = Object.assign(async () => {
    calls += 1;
    return { outcome: "unknown" as const, detailCode: "readback_not_supported" };
  }, { findsMessages: false });
  for (let n = 0; n < 19; n += 1) insertCheck(db, effectId);
  assert.equal((await read()).check_allowed, true);
  await check(env, effectId, "quota:worker:20", blind);
  assert.equal(calls, 1);
  // Twenty answers that prove nothing, and a readback that can neither find the message nor scan
  // completely: closed.
  assert.equal((await read()).check_allowed, false);
  await assert.rejects(check(env, effectId, "quota:worker:21", blind), { code: "proposal_delivery_check_limit", status: 409 });
  assert.equal(calls, 1);
  const ops = await person(db, env, "ops");
  assert.deepEqual(
    await post(env, ops, CHECK_PATH, { external_effect_id: effectId }, "delivery-check-quota-0001"),
    { status: 409, body: { error: "proposal_delivery_check_limit" } },
  );
  // A readback that can find the message still runs, and a found message is always kept...
  const sentAnswer = await check(env, effectId, "quota:worker:found", async () => ({ outcome: "sent", evidence: { found: true } }));
  assert.equal(sentAnswer.check.outcome, "sent");
  // ...while any other answer of it is refused by D1, writing nothing.
  const rows = () => count(db, "SELECT count(*) AS n FROM proposal_delivery_checks WHERE effect_id = ?", effectId);
  const before = rows();
  await assert.rejects(
    check(env, effectId, "quota:worker:found-unclear", async () => ({ outcome: "unknown" })),
    { code: "proposal_delivery_check_limit", status: 409 },
  );
  assert.equal(rows(), before);
  // A readback that scans completely keeps the proof's room: its "not found" is kept.
  const kept = await check(env, effectId, "quota:worker:scan", scanning(async () => ({ outcome: "not_found", scanComplete: true, evidence: { matched: 0 } })));
  assert.equal(kept.check.outcome, "not_found");
  // Once every room is full, even a readback that finds and scans is refused before the call.
  for (let n = 0; n < 19; n += 1) insertCheck(db, effectId, { outcome: "not_found" });
  for (let n = 0; n < 19; n += 1) insertCheck(db, effectId, { outcome: "sent" });
  let scans = 0;
  await assert.rejects(
    check(env, effectId, "quota:worker:all-full", scanning(async () => { scans += 1; return { outcome: "not_found", scanComplete: true }; })),
    { code: "proposal_delivery_check_limit", status: 409 },
  );
  assert.equal(scans, 0);
});

test("a send the stand-in can find stays checkable once the other answers are full, and its found message is kept", async () => {
  const db = new D1();
  const env = workerEnv(db, "synthetic");
  // A readback conflict: the stand-in holds the send's provider id, so it finds the message.
  const effectId = await send(env, "quota:found-room", "conflict", { provider: QA });
  for (let n = 0; n < 20; n += 1) insertCheck(db, effectId, { outcome: n % 2 ? "bounced" : "unknown" });
  const read = async () => await readProposalDeliveryState(env, TENANT, "proposal-pack:quota:found-room", "proposal-revision:quota:found-room");
  assert.deepEqual([(await read()).state, (await read()).check_allowed], ["1", true]);
  const answered = await post(env, await person(db, env, "ops"), CHECK_PATH, { external_effect_id: effectId }, "delivery-check-found-room-0001");
  assert.equal(answered.status, 201, JSON.stringify(answered.body));
  assert.equal(answered.body.check.outcome, "sent");
  // And the found message closes "didn't get it".
  assert.equal((await read()).not_delivered_allowed, false);
});

test("each check writes one audit row naming the person who asked", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const lost = await send(env, "row:audit", "lost");
  const checkId = insertCheck(db, lost, { outcome: "provider_unavailable", userId: USERS.owner, role: "owner" });
  const rows = db.raw.prepare(
    "SELECT automation, trigger, source_ids, target_ids, action, result, approved_by FROM audit_log WHERE source_ids = ?",
  ).all(`check:${checkId}`).map((row) => ({ ...row }));
  assert.deepEqual(rows, [{
    automation: "proposal_delivery",
    trigger: "office",
    source_ids: `check:${checkId}`,
    target_ids: `effect:${lost},proposal:proposal-revision:row:audit`,
    action: "proposal_delivery_check_provider_unavailable",
    result: "ok",
    approved_by: USERS.owner,
  }]);
});

test("no check moves the send, opens a send or a permit, or touches its attempt", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const sends = {
    unknown: await send(env, "still:unknown", "lost", { provider: PROMPT }),
    succeeded: await send(env, "still:succeeded", "accepted", { provider: PROMPT }),
    reconciling: await send(env, "still:conflict", "conflict", { provider: PROMPT }),
    failed: await failedConflict(env, "still:failed"),
  };
  const snapshot = () => ({
    effects: db.raw.prepare("SELECT * FROM external_effects ORDER BY effect_id").all().map((row) => ({ ...row })),
    attempts: db.raw.prepare("SELECT * FROM external_effect_attempts ORDER BY attempt_id").all().map((row) => ({ ...row })),
    events: count(db, "SELECT count(*) AS n FROM external_effect_events"),
    exceptions: count(db, "SELECT count(*) AS n FROM external_effect_exceptions"),
    permits: count(db, "SELECT count(*) AS n FROM commercial_authority_permits"),
    publications: count(db, "SELECT count(*) AS n FROM commercial_proposal_publication_events"),
    confirmations: count(db, "SELECT count(*) AS n FROM proposal_delivery_confirmations"),
  });
  const before = snapshot();
  for (const effectId of Object.values(sends)) {
    const outcomes = stateOf(db, effectId) === "succeeded"
      ? ["sent", "bounced", "unknown", "provider_unavailable"]
      : ["sent", "bounced", "not_found", "unknown", "provider_unavailable"];
    for (const outcome of outcomes) insertCheck(db, effectId, { outcome });
  }
  // The Worker's own check, every outcome its readback can give.
  for (const [n, adapter] of [
    notFoundComplete,
    async () => ({ outcome: "sent" as const, evidence: { found: true } }),
    async () => { throw new ProposalDeliveryTransportError("http", 503); },
  ].entries()) {
    await check(env, sends.unknown, `still:worker:${n}`, adapter);
    await check(env, sends.reconciling, `still:worker:conflict:${n}`, adapter);
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), 25);
});

// ---------------------------------------------------------------------------------------------
// D1: PR-S's evidence guard, re-created with the check rows B2 will move a send on

test("from B2 on, a sent or bounced check dated at the move settles an unknown send as delivered", async () => {
  const db = new D1();
  const env = workerEnv(db);
  for (const outcome of ["sent", "bounced"]) {
    const effectId = await send(env, `move:${outcome}`, "lost");
    insertPermit(db, effectId);
    const at = new Date().toISOString();
    insertCheck(db, effectId, { outcome, createdAt: at });
    assert.throws(() => moveTo(db, effectId, "succeeded", plus(at, 1)), /proposal_delivery_settle_evidence_missing/, "dated off the move");
    assert.throws(() => moveTo(db, effectId, "reconciled", at), /proposal_delivery_settle_evidence_missing/, "a found send is not 'not executed'");
    moveTo(db, effectId, "succeeded", at);
    assert.equal(stateOf(db, effectId), "succeeded");
  }
  for (const outcome of ["unknown", "provider_unavailable", "not_found"]) {
    const effectId = await send(env, `move:none:${outcome}`, "lost", { provider: PROMPT });
    insertPermit(db, effectId);
    const at = new Date().toISOString();
    insertCheck(db, effectId, { outcome, createdAt: at });
    assert.throws(() => moveTo(db, effectId, "succeeded", at), /proposal_delivery_settle_evidence_missing/, outcome);
  }
});

test("from B2 on, a complete-scan not-found check dated at the move settles an unknown send as not executed", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await send(env, "move:not-found", "lost", { provider: PROMPT });
  const at = new Date().toISOString();
  // Only "not found" proves the send went nowhere, however complete the scan behind another answer.
  // (A `sent` answer contradicts it outright: see the B2 contradiction test.)
  for (const outcome of ["unknown", "provider_unavailable"]) {
    insertCheck(db, effectId, { outcome, createdAt: at, scanComplete: 1 });
  }
  assert.throws(() => moveTo(db, effectId, "reconciled", at), /proposal_delivery_settle_evidence_missing/);
  insertCheck(db, effectId, { outcome: "not_found", createdAt: plus(at, 1) });
  assert.throws(() => moveTo(db, effectId, "reconciled", at), /proposal_delivery_settle_evidence_missing/, "dated off the move");
  moveTo(db, effectId, "reconciled", plus(at, 1));
  assert.equal(stateOf(db, effectId), "reconciled");
});

test("a check counts only for its own send and tenant", async () => {
  const db = new D1();
  const env = workerEnv(db);
  // Validation refuses such rows; it is dropped here so they sit beside the send and only the guard decides.
  db.raw.exec("DROP TRIGGER proposal_delivery_checks_validate_insert;");
  const effectId = await send(env, "move:foreign", "lost", { provider: PROMPT });
  const neighbour = await send(env, "move:foreign:neighbour", "lost", { provider: PROMPT });
  insertPermit(db, effectId);
  const at = new Date().toISOString();
  insertCheck(db, effectId, { outcome: "sent", createdAt: at, tenantId: OTHER_TENANT });
  insertCheck(db, neighbour, { outcome: "sent", createdAt: at });
  insertCheck(db, effectId, { outcome: "not_found", createdAt: plus(at, 1), tenantId: OTHER_TENANT });
  insertCheck(db, neighbour, { outcome: "not_found", createdAt: plus(at, 1) });
  assert.throws(() => moveTo(db, effectId, "succeeded", at), /proposal_delivery_settle_evidence_missing/);
  assert.throws(() => moveTo(db, effectId, "reconciled", plus(at, 1)), /proposal_delivery_settle_evidence_missing/);
  assert.equal(stateOf(db, effectId), "unknown");
});

test("a check moves a send to delivered only when its permit names the holder who records it", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const missing = /proposal_delivery_settle_permit_holder_missing/;
  const sentAtMove = async (id: string) => {
    const effectId = await send(env, id, "lost");
    const at = new Date().toISOString();
    insertCheck(db, effectId, { outcome: "sent", createdAt: at });
    return { effectId, at };
  };
  // No permit at all.
  const none = await sentAtMove("holder:none");
  assert.throws(() => moveTo(db, none.effectId, "succeeded", none.at), missing);
  // The send's permit id, but another tenant's permit.
  const foreign = await sentAtMove("holder:foreign-tenant");
  insertPermit(db, foreign.effectId, OTHER_TENANT);
  assert.throws(() => moveTo(db, foreign.effectId, "succeeded", foreign.at), missing);
  // A permit of the tenant, but not this send's.
  const unrelated = await sentAtMove("holder:unrelated-permit");
  insertPermit(db, unrelated.effectId, TENANT, "synthetic-authority:holder:some-other-send-permit");
  assert.throws(() => moveTo(db, unrelated.effectId, "succeeded", unrelated.at), missing);
  for (const { effectId } of [none, foreign, unrelated]) assert.equal(stateOf(db, effectId), "unknown");
  // Its own permit: the move passes.
  const own = await sentAtMove("holder:own");
  insertPermit(db, own.effectId);
  moveTo(db, own.effectId, "succeeded", own.at);
  assert.equal(stateOf(db, own.effectId), "succeeded");
  // "Not executed" records no publication, so it needs no permit.
  const notFound = await send(env, "holder:not-found", "lost", { provider: PROMPT });
  const at = new Date().toISOString();
  insertCheck(db, notFound, { outcome: "not_found", createdAt: at });
  moveTo(db, notFound, "reconciled", at);
  assert.equal(stateOf(db, notFound), "reconciled");
  // A person's own "delivered" names its recorder itself: no permit is needed (0156, unchanged).
  const byHand = await send(env, "holder:by-hand", "lost");
  insertConfirmation(db, byHand, "delivered");
  assert.equal(stateOf(db, byHand), "succeeded");
});

test("only a delivered confirmation of the same send and tenant stands in for the permit holder", async () => {
  const db = new D1();
  const env = workerEnv(db);
  // 0156 refuses such rows and moves the send itself on insert. Its two triggers are dropped here, so
  // the rows sit beside an unknown send and only the evidence guard decides.
  db.raw.exec(`DROP TRIGGER proposal_delivery_confirmations_validate_insert;
    DROP TRIGGER proposal_delivery_confirmations_apply;`);
  const missing = /proposal_delivery_settle_permit_holder_missing/;
  const neighbour = await send(env, "stand-in:neighbour", "lost");
  for (const [id, plant] of [
    ["stand-in:other-tenant", (effectId: string) => insertConfirmation(db, effectId, "delivered", { tenantId: OTHER_TENANT })],
    ["stand-in:not-delivered", (effectId: string) => insertConfirmation(db, effectId, "not_delivered")],
    ["stand-in:other-send", () => insertConfirmation(db, neighbour, "delivered")],
  ] as const) {
    const effectId = await send(env, id, "lost");
    plant(effectId);
    const at = new Date().toISOString();
    insertCheck(db, effectId, { outcome: "sent", createdAt: at });
    assert.throws(() => moveTo(db, effectId, "succeeded", at), missing, id);
  }
  const own = await send(env, "stand-in:own", "lost");
  insertConfirmation(db, own, "delivered");
  moveTo(db, own, "succeeded", new Date().toISOString());
  assert.equal(stateOf(db, own), "succeeded");
});

// ---------------------------------------------------------------------------------------------
// D1 and the Worker: "not delivered" out of a conflict cites a newer complete-scan not-found

const conflicts = {
  reconciling: async (env: AppEnv, id: string) => await send(env, id, "conflict", { provider: PROMPT }),
  failed: async (env: AppEnv, id: string) => await failedConflict(env, id),
};

test("out of either kind of conflict, not delivered passes when it cites a newer complete-scan not-found", async () => {
  for (const [origin, make] of Object.entries(conflicts)) {
    const db = new D1();
    const env = workerEnv(db);
    // In D1.
    const direct = await make(env, `cited:${origin}:d1`);
    assert.equal(stateOf(db, direct), "manual_exception");
    const directCheck = insertCheck(db, direct, { outcome: "not_found", createdAt: plus(conflictAt(db, direct), 1) });
    assert.throws(() => insertConfirmation(db, direct, "not_delivered"), /proposal_delivery_confirmation_conflict_needs_provider_evidence/);
    insertConfirmation(db, direct, "not_delivered", { checkId: directCheck });
    assert.equal(stateOf(db, direct), "reconciled", origin);

    // Through the Worker: the person's check, then the person's record citing it.
    const effectId = await make(env, `cited:${origin}:worker`);
    const ops = await person(db, env, "ops");
    // A person's check comes after the conflict, never in its millisecond.
    await new Promise((done) => setTimeout(done, 5));
    const checked = await check(env, effectId, `cited:${origin}:check`, notFoundComplete);
    assert.equal(checked.check.outcome, "not_found");
    assert.equal(checked.check.scan_complete, 1);
    assert.equal(checked.check.effect_state, "manual_exception");
    assert.equal(checked.deliveryState.state, "1");
    assert.equal(checked.deliveryState.not_delivered_allowed, true);
    assert.equal(checked.deliveryState.not_delivered_check_id, checked.check.check_id);
    const body = {
      external_effect_id: effectId,
      outcome: "not_delivered",
      note: "The service scanned the mailbox and found nothing.",
      delivery_check_id: checked.check.check_id,
    };
    const recorded = await post(env, ops, CONFIRM_PATH, body, `cited:${origin}:confirm`);
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    assert.equal(recorded.body.confirmation.delivery_check_id, checked.check.check_id);
    assert.equal(stateOf(db, effectId), "reconciled");
    assert.equal(count(db, "SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ? AND status = 'open'", effectId), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM audit_log WHERE action = 'proposal_delivery_not_delivered' AND target_ids LIKE ?", `effect:${effectId},%`), 1);
    // The same key and body replay; the cited check is part of the request.
    const replay = await post(env, ops, CONFIRM_PATH, body, `cited:${origin}:confirm`);
    assert.equal(replay.status, 200);
    const changed = await post(env, ops, CONFIRM_PATH, { ...body, delivery_check_id: undefined }, `cited:${origin}:confirm`);
    assert.equal(changed.status, 409);
  }
});

test("a check no newer than the conflict does not settle it", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const refused = /proposal_delivery_confirmation_conflict_needs_provider_evidence/;
  // At the very moment of the conflict.
  const atMoment = await conflicts.reconciling(env, "stale:moment");
  const momentCheck = insertCheck(db, atMoment, { outcome: "not_found", createdAt: conflictAt(db, atMoment) });
  assert.throws(() => insertConfirmation(db, atMoment, "not_delivered", { checkId: momentCheck }), refused);
  await assert.rejects(
    recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId: atMoment, outcome: "not_delivered", note: "Cited the check made at that moment.",
      actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: "stale:moment:worker", deliveryCheckId: momentCheck,
    }),
    {
      code: "proposal_delivery_confirmation_conflict_needs_provider_evidence",
      status: 409,
      detail: { delivery_state: "manual_exception" },
    },
  );
  // Before it: a refused send that a later check contradicted, the contradiction dated ahead.
  const contradicted = await failedConflict(env, "stale:older", PROMPT, new Date(Date.now() + 30_000).toISOString());
  const older = insertCheck(db, contradicted, { outcome: "not_found" });
  assert.ok(Date.parse(conflictAt(db, contradicted)) > Date.now());
  assert.throws(() => insertConfirmation(db, contradicted, "not_delivered", { checkId: older }), refused);
  await assert.rejects(
    recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId: contradicted, outcome: "not_delivered", note: "Cited the check made before.",
      actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: "stale:older:worker", deliveryCheckId: older,
    }),
    {
      code: "proposal_delivery_confirmation_conflict_needs_provider_evidence",
      status: 409,
      detail: { delivery_state: "manual_exception" },
    },
  );
  // A newer one passes.
  const newer = insertCheck(db, contradicted, { outcome: "not_found", createdAt: plus(conflictAt(db, contradicted), 1) });
  insertConfirmation(db, contradicted, "not_delivered", { checkId: newer });
  assert.equal(stateOf(db, contradicted), "reconciled");
  assert.equal(stateOf(db, atMoment), "manual_exception");
});

test("a check that found the message sent voids every not-found of the send, from either kind of conflict", async () => {
  for (const [origin, make] of Object.entries(conflicts)) {
    for (const found of ["sent"]) {
      for (const order of ["later", "earlier"]) {
        const db = new D1();
        const env = workerEnv(db);
        const id = `contradicted:${origin}:${found}:${order}`;
        const effectId = await make(env, id);
        const after = conflictAt(db, effectId);
        // The lagging mailbox: the scan found nothing, then (or before) a check found the message.
        const stamps = order === "later" ? [plus(after, 1), plus(after, 2)] : [plus(after, 2), plus(after, 1)];
        const notFound = insertCheck(db, effectId, { outcome: "not_found", createdAt: stamps[0] });
        insertCheck(db, effectId, { outcome: found, createdAt: stamps[1] });
        const label = `${origin} ${found} ${order}`;
        // The read no longer offers it.
        const state = await readProposalDeliveryState(env, TENANT, `proposal-pack:${id}`, `proposal-revision:${id}`);
        assert.deepEqual([state.not_delivered_allowed, state.not_delivered_check_id], [false, null], label);
        // D1 refuses it.
        assert.throws(
          () => insertConfirmation(db, effectId, "not_delivered", { checkId: notFound }),
          /proposal_delivery_confirmation_check_contradicted/,
          label,
        );
        // The Worker refuses it, through the person's route as well.
        await assert.rejects(
          recordProposalDeliveryConfirmation(env, {
            tenantId: TENANT, effectId, outcome: "not_delivered", note: "Cited the scan that found nothing.",
            actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: `${id}:worker`, deliveryCheckId: notFound,
          }),
          { code: "proposal_delivery_confirmation_check_contradicted", status: 409, detail: { delivery_state: "manual_exception" } },
          label,
        );
        const answered = await post(env, await person(db, env, "ops"), CONFIRM_PATH, {
          external_effect_id: effectId, outcome: "not_delivered", note: "Cited the scan that found nothing.",
          delivery_check_id: notFound,
        }, `contradicted-${origin}-${found}-${order}`);
        assert.deepEqual(answered, {
          status: 409,
          body: { error: "proposal_delivery_confirmation_check_contradicted", delivery_state: "manual_exception" },
        }, label);
        assert.equal(stateOf(db, effectId), "manual_exception", label);
        // So it keeps blocking a second send of the same revision.
        const second = envelope(id);
        second.effect.effectId = `effect:delivery-check:${id}:second`;
        second.effect.idempotencyKey = `delivery-check:${id}:second`;
        await assert.rejects(proposeExternalEffect(env, second.effect as ExternalEffectRequest), { code: "effect_proposal_delivery_unconfirmed" });
        // "Delivered" stays open.
        insertConfirmation(db, effectId, "delivered");
        assert.equal(stateOf(db, effectId), "succeeded", label);
      }
    }
  }
});

test("a bounce does not void a citation: the customer did not get it, so not delivered stays the way to send again", async () => {
  for (const [origin, make] of Object.entries(conflicts)) {
    for (const order of ["later", "earlier"]) {
      const db = new D1();
      const env = workerEnv(db);
      const id = `bounced:${origin}:${order}`;
      const effectId = await make(env, id);
      const after = conflictAt(db, effectId);
      const stamps = order === "later" ? [plus(after, 1), plus(after, 2)] : [plus(after, 2), plus(after, 1)];
      const notFound = insertCheck(db, effectId, { outcome: "not_found", createdAt: stamps[0] });
      insertCheck(db, effectId, { outcome: "bounced", createdAt: stamps[1] });
      const label = `${origin} ${order}`;
      const state = await readProposalDeliveryState(env, TENANT, `proposal-pack:${id}`, `proposal-revision:${id}`);
      assert.deepEqual([state.not_delivered_allowed, state.not_delivered_check_id], [true, notFound], label);
      const answered = await post(env, await person(db, env, "ops"), CONFIRM_PATH, {
        external_effect_id: effectId, outcome: "not_delivered", note: "The message bounced; the scan found nothing.",
        delivery_check_id: notFound,
      }, `bounced-${origin}-${order}`);
      assert.equal(answered.status, 201, `${label} ${JSON.stringify(answered.body)}`);
      assert.equal(stateOf(db, effectId), "reconciled", label);
    }
  }
});

test("a found message closes not delivered on 0156's path too, uncited; a bounce does not", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const ops = await person(db, env, "ops");
  const silent = async (id: string) => {
    const effectId = await send(env, id, "lost", { provider: PROMPT });
    await reconcileExternalEffect(env, effectId, { outcome: "inconclusive", evidence: { provider: "no answer" } });
    return effectId;
  };
  const sends = {
    unknown: async (id: string) => await send(env, id, "lost", { provider: PROMPT }),
    silent,
  };
  for (const [kind, make] of Object.entries(sends)) {
    // A check found the message sent: "not delivered" is closed, in the read, D1, the Worker and the route.
    const foundId = `uncited:${kind}:found`;
    const found = await make(foundId);
    insertCheck(db, found, { outcome: "sent" });
    const state = await readProposalDeliveryState(env, TENANT, `proposal-pack:${foundId}`, `proposal-revision:${foundId}`);
    assert.deepEqual([state.record_allowed, state.not_delivered_allowed], [true, false], kind);
    assert.throws(() => insertConfirmation(db, found, "not_delivered"), /proposal_delivery_confirmation_check_contradicted/, kind);
    await assert.rejects(
      recordProposalDeliveryConfirmation(env, {
        tenantId: TENANT, effectId: found, outcome: "not_delivered", note: "The customer says it never came.",
        actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: `${foundId}:worker`,
      }),
      { code: "proposal_delivery_confirmation_check_contradicted", status: 409, detail: { delivery_state: stateOf(db, found) } },
      kind,
    );
    assert.deepEqual(
      await post(env, ops, CONFIRM_PATH, {
        external_effect_id: found, outcome: "not_delivered", note: "The customer says it never came.",
      }, `uncited-${kind}-found`),
      { status: 409, body: { error: "proposal_delivery_confirmation_check_contradicted", delivery_state: stateOf(db, found) } },
      kind,
    );
    // "Delivered" stays open.
    assert.equal((await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId: found, outcome: "delivered", note: "The provider shows it was sent.",
      actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: `${foundId}:delivered`,
    })).effectState, "succeeded", kind);
    // A bounce does not close it (frame 1·b).
    const bouncedId = `uncited:${kind}:bounced`;
    const bounced = await make(bouncedId);
    insertCheck(db, bounced, { outcome: "bounced" });
    const bouncedState = await readProposalDeliveryState(env, TENANT, `proposal-pack:${bouncedId}`, `proposal-revision:${bouncedId}`);
    assert.equal(bouncedState.not_delivered_allowed, true, kind);
    assert.equal((await recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId: bounced, outcome: "not_delivered", note: "It bounced; the address will be fixed.",
      actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: `${bouncedId}:worker`,
    })).effectState, "reconciled", kind);
  }
});

test("only a check of the same send and tenant contradicts a citation", async () => {
  const db = new D1();
  const env = workerEnv(db);
  db.raw.exec("DROP TRIGGER proposal_delivery_checks_validate_insert;");
  const effectId = await conflicts.reconciling(env, "contradicted:foreign");
  const neighbour = await conflicts.reconciling(env, "contradicted:foreign:neighbour");
  const after = conflictAt(db, effectId);
  const notFound = insertCheck(db, effectId, { outcome: "not_found", createdAt: plus(after, 1) });
  insertCheck(db, effectId, { outcome: "sent", createdAt: plus(after, 2), tenantId: OTHER_TENANT });
  insertCheck(db, neighbour, { outcome: "sent", createdAt: plus(after, 2) });
  const state = await readProposalDeliveryState(env, TENANT, "proposal-pack:contradicted:foreign", "proposal-revision:contradicted:foreign");
  assert.equal(state.not_delivered_check_id, notFound);
  insertConfirmation(db, effectId, "not_delivered", { checkId: notFound });
  assert.equal(stateOf(db, effectId), "reconciled");
});

test("from B2 on, a not-found never settles a send a check found", async () => {
  const db = new D1();
  const env = workerEnv(db);
  db.raw.exec("DROP TRIGGER proposal_delivery_checks_validate_insert;");
  {
    const effectId = await send(env, "move:contradicted:sent", "lost", { provider: PROMPT });
    const at = new Date().toISOString();
    insertCheck(db, effectId, { outcome: "sent", createdAt: plus(at, -1) });
    insertCheck(db, effectId, { outcome: "not_found", createdAt: at });
    assert.throws(() => moveTo(db, effectId, "reconciled", at), /proposal_delivery_settle_evidence_missing/);
  }
  {
    // A bounce is no found message: the not-found still settles the send.
    const effectId = await send(env, "move:contradicted:bounced", "lost", { provider: PROMPT });
    const at = new Date().toISOString();
    insertCheck(db, effectId, { outcome: "bounced", createdAt: plus(at, -1) });
    insertCheck(db, effectId, { outcome: "not_found", createdAt: at });
    moveTo(db, effectId, "reconciled", at);
    assert.equal(stateOf(db, effectId), "reconciled");
  }
  // Another tenant's row or another send's does not.
  const effectId = await send(env, "move:contradicted:foreign", "lost", { provider: PROMPT });
  const neighbour = await send(env, "move:contradicted:neighbour", "lost", { provider: PROMPT });
  const at = new Date().toISOString();
  insertCheck(db, effectId, { outcome: "sent", createdAt: plus(at, -1), tenantId: OTHER_TENANT });
  insertCheck(db, neighbour, { outcome: "sent", createdAt: plus(at, -1) });
  insertCheck(db, effectId, { outcome: "not_found", createdAt: at });
  moveTo(db, effectId, "reconciled", at);
  assert.equal(stateOf(db, effectId), "reconciled");
});

test("a cited check must be a complete-scan not-found of the same send and tenant", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const invalid = /proposal_delivery_confirmation_check_invalid/;
  const effectId = await conflicts.reconciling(env, "cite:invalid");
  const later = plus(conflictAt(db, effectId), 1);
  // A found result, and an answer that could not tell, are no evidence the send went nowhere, even
  // after a complete scan.
  const found = insertCheck(db, effectId, { outcome: "sent", createdAt: later, scanComplete: 1 });
  const unclear = insertCheck(db, effectId, { outcome: "unknown", createdAt: later, scanComplete: 1 });
  // Another send's complete-scan not-found.
  const neighbour = await conflicts.reconciling(env, "cite:invalid:neighbour");
  const neighbours = insertCheck(db, neighbour, { outcome: "not_found", createdAt: plus(conflictAt(db, neighbour), 1) });
  for (const checkId of [found, unclear, neighbours, "delivery-check:does-not-exist"]) {
    assert.throws(() => insertConfirmation(db, effectId, "not_delivered", { checkId }), invalid, checkId);
    await assert.rejects(
      recordProposalDeliveryConfirmation(env, {
        tenantId: TENANT, effectId, outcome: "not_delivered", note: "Cited a check that proves nothing.",
        actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: `cite:invalid:${checkId}`, deliveryCheckId: checkId,
      }),
      { code: "proposal_delivery_confirmation_check_invalid", status: 409, detail: { delivery_state: "manual_exception" } },
    );
  }
  // Another tenant's row for this very send (validation dropped to plant it).
  db.raw.exec("DROP TRIGGER proposal_delivery_checks_validate_insert;");
  const foreign = insertCheck(db, effectId, { outcome: "not_found", createdAt: later, tenantId: OTHER_TENANT });
  assert.throws(() => insertConfirmation(db, effectId, "not_delivered", { checkId: foreign }), invalid);
  // Only "not delivered" cites a check at all.
  const valid = insertCheck(db, effectId, { outcome: "not_found", createdAt: later });
  assert.throws(() => insertConfirmation(db, effectId, "delivered", { checkId: valid }), /CHECK constraint failed/);
  await assert.rejects(
    recordProposalDeliveryConfirmation(env, {
      tenantId: TENANT, effectId, outcome: "delivered", note: "Delivered, citing a not-found check.",
      actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: "cite:invalid:delivered", deliveryCheckId: valid,
    }),
    { code: "proposal_delivery_confirmation_check_invalid", status: 409, detail: { delivery_state: "manual_exception" } },
  );
  assert.equal(stateOf(db, effectId), "manual_exception");
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_confirmations WHERE effect_id = ?", effectId), 0);
});

test("a not-found without a complete scan is kept as unknown and cannot be cited", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await conflicts.failed(env, "cite:incomplete");
  const partial = await check(env, effectId, "cite:incomplete:check", async () => ({
    outcome: "not_found",
    evidence: { scanned: "the first page only" },
  }));
  assert.equal(partial.check.outcome, "unknown");
  assert.equal(partial.check.scan_complete, 0);
  assert.equal(partial.check.detail_code, "scan_incomplete");
  assert.equal(partial.deliveryState.not_delivered_allowed, false);
  assert.throws(
    () => insertConfirmation(db, effectId, "not_delivered", { checkId: partial.check.check_id }),
    /proposal_delivery_confirmation_check_invalid/,
  );
  assert.equal(stateOf(db, effectId), "manual_exception");
});

test("a silent provider's exception keeps 0156's path; a citation there must still be valid", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const silent = async (id: string) => {
    const effectId = await send(env, id, "lost", { provider: PROMPT });
    await reconcileExternalEffect(env, effectId, { outcome: "inconclusive", evidence: { provider: "no answer" } });
    assert.equal(stateOf(db, effectId), "manual_exception");
    return effectId;
  };
  // No citation needed.
  const plain = await silent("silent:plain");
  insertConfirmation(db, plain, "not_delivered");
  assert.equal(stateOf(db, plain), "reconciled");
  // A found message closes it, uncited as well (0167).
  const foundSilent = await silent("silent:found");
  insertCheck(db, foundSilent, { outcome: "sent" });
  assert.throws(() => insertConfirmation(db, foundSilent, "not_delivered"), /proposal_delivery_confirmation_check_contradicted/);
  assert.equal(stateOf(db, foundSilent), "manual_exception");
  // A citation that proves nothing is refused all the same.
  const cited = await silent("silent:cited");
  const unclear = insertCheck(db, cited, { outcome: "unknown" });
  assert.throws(() => insertConfirmation(db, cited, "not_delivered", { checkId: unclear }), /proposal_delivery_confirmation_check_invalid/);
  // The Worker does not run a check there: the person records it after 0161's wait.
  await assert.rejects(check(env, cited, "silent:check"), { code: "proposal_delivery_check_effect_invalid", status: 409 });
});

test("0167 re-creates 0164's two guards after 0164 in every order, carrying 0164's text", async () => {
  const db = new D1();
  const applied = (name: string) =>
    (db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string }).sql;
  const own = readFileSync(new URL("../migrations/0167_proposal_delivery_checks.sql", import.meta.url), "utf8");
  const base = readFileSync(new URL("../migrations/0164_outside_send_effect_guards.sql", import.meta.url), "utf8");
  const body = (text: string, name: string) =>
    new RegExp(`CREATE TRIGGER (?:IF NOT EXISTS )?${name}\\n([\\s\\S]*?\\nEND)`).exec(text)![1];
  const references = {
    external_effects_proposal_settle_evidence_guard: [
      "commercial_authority_permits", "external_effects", "proposal_delivery_checks", "proposal_delivery_confirmations",
    ],
    proposal_delivery_confirmations_conflict_guard: [
      "external_effect_events", "proposal_delivery_checks", "proposal_delivery_confirmations",
    ],
  };
  for (const [name, tables] of Object.entries(references)) {
    // The schema holds 0167's version.
    assert.equal(body(applied(name), name), body(own, name), name);
    // Every line of 0164's version is still there, in order; only a closing `;` moved behind the new
    // clause that follows it.
    const ours = body(own, name).split("\n");
    let at = 0;
    for (const line of body(base, name).split("\n")) {
      const found = ours.findIndex((candidate, index) => index >= at && (candidate === line || `${candidate};` === line));
      assert.ok(found >= 0, `${name} lost: ${line}`);
      at = found + 1;
    }
    const read = new Set([...applied(name).matchAll(/\b(?:FROM|JOIN|ON)\s+([a-z_]+)/gi)].map((match) => match[1]));
    assert.deepEqual([...read].sort(), tables, name);
  }
  // 0164 run again (its IF NOT EXISTS) keeps 0167's versions.
  const before = references && Object.keys(references).map(applied);
  db.raw.exec(base);
  assert.deepEqual(Object.keys(references).map(applied), before);
});

// ---------------------------------------------------------------------------------------------
// The routes

test("checking delivery is a person's own request: the commercial set, CSRF, a key and a bare body", async () => {
  const db = new D1();
  const env = workerEnv(db, "synthetic");
  const effectId = await send(env, "route:gates", "accepted", { provider: QA });
  const body = { external_effect_id: effectId };
  const ops = await person(db, env, "ops");
  assert.deepEqual(await post(env, fixtureAuth("production"), CHECK_PATH, body, "delivery-check-gates-0001"), { status: 403, body: { error: "office_role_required" } });
  // A token or connector holds the commercial set but no person's own session.
  assert.deepEqual(await post(env, fixtureAuth("ops"), CHECK_PATH, body, "delivery-check-gates-0001"), { status: 403, body: { error: "person_session_required" } });
  assert.deepEqual(await post(env, ops, CHECK_PATH, body, "delivery-check-gates-0001", "forged"), { status: 403, body: { error: "csrf_failed" } });
  assert.deepEqual(await post(env, ops, CHECK_PATH, body, null), { status: 400, body: { error: "idempotency_key_required" } });
  for (const bad of [{}, { ...body, outcome: "sent" }, { external_effect_id: 42 }, { external_effect_id: "short" }]) {
    assert.deepEqual(await post(env, ops, CHECK_PATH, bad, "delivery-check-gates-0001"), { status: 400, body: { error: "invalid_proposal_delivery_check" } });
  }
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), 0);
  for (const role of ["owner", "sales"] as const) {
    const answered = await post(env, await person(db, env, role), CHECK_PATH, body, `delivery-check-gates-${role}`);
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    assert.equal(answered.body.check.requested_by_role, role);
  }
});

test("a check replays under its key, conflicts on another body, and answers the read-back outcome", async () => {
  const db = new D1();
  const env = workerEnv(db, "synthetic");
  const sent = await send(env, "route:replay", "accepted", { provider: QA });
  const lost = await send(env, "route:replay:lost", "lost", { provider: QA });
  const ops = await person(db, env, "ops");
  const first = await post(env, ops, CHECK_PATH, { external_effect_id: sent }, "replay-1");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.check.outcome, "sent");
  assert.equal(first.body.check.effect_state, "succeeded");
  assert.equal(first.body.check.provider_external_id, "provider:route:replay");
  assert.match(first.body.check.evidence_sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.body.delivery_state.state, "Q");
  const again = await post(env, ops, CHECK_PATH, { external_effect_id: sent }, "replay-1");
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.check, first.body.check);
  assert.equal(again.body.replayed, true);
  assert.deepEqual(
    await post(env, ops, CHECK_PATH, { external_effect_id: lost }, "replay-1"),
    { status: 409, body: { error: "proposal_delivery_check_replay_conflict" } },
  );
  // The stand-in answers "unknown" for a send it holds no provider id for.
  const unclear = await post(env, ops, CHECK_PATH, { external_effect_id: lost }, "replay-2");
  assert.equal(unclear.status, 201);
  assert.equal(unclear.body.check.outcome, "unknown");
  assert.equal(unclear.body.check.detail_code, "provider_external_id_missing");
  assert.equal(unclear.body.delivery_state.state, "7·u");
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), 2);
});

test("the readback is chosen by the send's provider, and a stand-in only on a synthetic Worker", async () => {
  const db = new D1();
  const synthetic = workerEnv(db, "synthetic");
  const qaSend = await send(synthetic, "route:adapter:qa", "accepted", { provider: QA });
  const realSend = await send(synthetic, "route:adapter:real", "lost");
  for (const dataClass of ["business", "", "Synthetic"]) {
    const env = workerEnv(db, dataClass);
    const ops = await person(db, env, "ops");
    assert.deepEqual(
      await post(env, ops, CHECK_PATH, { external_effect_id: qaSend }, `adapter-${dataClass}`),
      { status: 403, body: { error: "effect_provider_not_allowed" } },
    );
  }
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), 0);
  // The read says the same: no check is offered where this Worker may not read the provider back.
  await send(synthetic, "route:adapter:qa-lost", "lost", { provider: QA });
  const readOn = async (env: AppEnv) =>
    await readProposalDeliveryState(env, TENANT, "proposal-pack:route:adapter:qa-lost", "proposal-revision:route:adapter:qa-lost");
  const [businessRead, syntheticRead] = [await readOn(workerEnv(db, "business")), await readOn(synthetic)];
  assert.deepEqual([businessRead.state, businessRead.check_allowed], ["7", false]);
  assert.deepEqual([syntheticRead.state, syntheticRead.check_allowed], ["7", true]);
  // Every provider without a readback yet answers "unknown", named.
  const business = workerEnv(db, "business");
  const real = await post(business, await person(db, business, "ops"), CHECK_PATH, { external_effect_id: realSend }, "adapter-real");
  assert.equal(real.status, 201);
  assert.equal(real.body.check.outcome, "unknown");
  assert.equal(real.body.check.detail_code, "readback_not_supported");
  assert.equal(real.body.check.evidence_sha256, null);
});

/** A send claimed long enough ago that its attempt's lease has run out. */
async function lapsedSend(env: AppEnv, id: string): Promise<string> {
  const { effect, authority } = envelope(id);
  const past = new Date(Date.now() - EFFECT_ATTEMPT_LEASE_MS - 10_000);
  const proposed = await proposeExternalEffect(env, { ...effect, now: past.toISOString() } as ExternalEffectRequest);
  await authorizeExternalEffect(env, proposed.effect_id, authority as EffectAuthority, past.toISOString());
  await claimExternalEffect(env, proposed.effect_id, past);
  return proposed.effect_id;
}

test("a check never moves a send whose lease ran out: the lease sweep records it, then it is checked", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await lapsedSend(env, "route:lease");
  assert.equal(stateOf(db, effectId), "executing");
  const before = effectRow(db, effectId);
  const events = count(db, "SELECT count(*) AS n FROM external_effect_events WHERE effect_id = ?", effectId);
  const read = async () => await readProposalDeliveryState(env, TENANT, "proposal-pack:route:lease", "proposal-revision:route:lease");
  assert.deepEqual([(await read()).state, (await read()).check_allowed], ["7", false]);
  const ops = await person(db, env, "ops");
  assert.deepEqual(
    await post(env, ops, CHECK_PATH, { external_effect_id: effectId }, "delivery-check-lease-0001"),
    { status: 409, body: { error: "proposal_delivery_check_effect_invalid", delivery_state: "executing" } },
  );
  assert.deepEqual(effectRow(db, effectId), before);
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effect_events WHERE effect_id = ?", effectId), events);
  // The */5 lease sweep records it as unknown; then the person's check runs.
  await recoverExpiredExternalEffects(env);
  assert.equal(stateOf(db, effectId), "unknown");
  assert.deepEqual([(await read()).state, (await read()).check_allowed], ["7", true]);
  const answered = await post(env, ops, CHECK_PATH, { external_effect_id: effectId }, "delivery-check-lease-0002");
  assert.equal(answered.status, 201, JSON.stringify(answered.body));
  assert.equal(answered.body.check.effect_state, "unknown");
  // A lapsed lease reads the same while the readback is still being reconciled.
  const reconciling = await lapsedSend(env, "route:lease:reconciling");
  db.raw.prepare("UPDATE external_effects SET state = 'reconciling' WHERE effect_id = ?").run(reconciling);
  const state = await readProposalDeliveryState(env, TENANT, "proposal-pack:route:lease:reconciling", "proposal-revision:route:lease:reconciling");
  assert.deepEqual([state.state, state.check_allowed], ["7", false]);
});

test("only an unconfirmed, sent or answered-conflict send is checked; another tenant's is not found", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const ops = await person(db, env, "ops");
  const failed = await send(env, "route:not-checkable:failed", "refused");
  const { effect, authority } = envelope("route:not-checkable:live");
  const proposed = await proposeExternalEffect(env, effect as ExternalEffectRequest);
  await authorizeExternalEffect(env, proposed.effect_id, authority as EffectAuthority);
  await claimExternalEffect(env, proposed.effect_id);
  const silent = await send(env, "route:not-checkable:silent", "lost");
  await reconcileExternalEffect(env, silent, { outcome: "inconclusive", evidence: { provider: "no answer" } });
  for (const [effectId, state] of [[failed, "failed"], [proposed.effect_id, "executing"], [silent, "manual_exception"]] as const) {
    assert.deepEqual(
      await post(env, ops, CHECK_PATH, { external_effect_id: effectId }, `not-checkable:${state}`),
      { status: 409, body: { error: "proposal_delivery_check_effect_invalid", delivery_state: state } },
    );
  }
  const foreign = await send(env, "route:not-checkable:foreign", "lost", { tenantId: OTHER_TENANT });
  const withdrawal = await send(env, "route:not-checkable:withdraw", "lost", { action: "proposal.withdraw" });
  for (const effectId of [foreign, withdrawal, "effect:delivery-check:missing"]) {
    assert.deepEqual(
      await post(env, ops, CHECK_PATH, { external_effect_id: effectId }, `not-checkable:${effectId}`),
      { status: 404, body: { error: "proposal_delivery_effect_not_found" } },
    );
  }
  // Both kinds of conflict are checkable.
  for (const [origin, make] of Object.entries(conflicts)) {
    const effectId = await make(env, `route:checkable:${origin}`);
    const answered = await post(env, ops, CHECK_PATH, { external_effect_id: effectId }, `checkable:${origin}`);
    assert.equal(answered.status, 201, origin);
    assert.equal(answered.body.check.effect_state, "manual_exception");
  }
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), 2);
});

test("a provider that does not answer is unavailable since the run began; one that refuses us answered", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await send(env, "route:transport", "lost");
  const throwing = (error: Error): ProposalDeliveryReadbackAdapter => async () => { throw error; };
  let aborted = false;
  const outcomes: Array<[string, ProposalDeliveryReadbackAdapter, string, string]> = [
    ["timeout", (_effect, signal) => new Promise((resolve) => signal.addEventListener("abort", () => {
      aborted = true;
      resolve({ outcome: "sent", evidence: { too: "late" } });
    })), "provider_unavailable", "provider_timeout"],
    ["network", throwing(new ProposalDeliveryTransportError("network")), "provider_unavailable", "provider_network"],
    ["breaker", throwing(new ProposalDeliveryTransportError("breaker_open")), "provider_unavailable", "provider_breaker_open"],
    ["5xx", throwing(new ProposalDeliveryTransportError("http", 502)), "provider_unavailable", "provider_http_502"],
    ["401", throwing(new ProposalDeliveryTransportError("http", 401)), "unknown", "provider_auth"],
    ["403", throwing(new ProposalDeliveryTransportError("http", 403)), "unknown", "provider_auth"],
    ["404", throwing(new ProposalDeliveryTransportError("http", 404)), "unknown", "provider_http_404"],
  ];
  const results = [];
  for (const [label, adapter, outcome, detail] of outcomes) {
    const answered = await check(env, effectId, `transport:${label}`, adapter, 20);
    assert.equal(answered.check.outcome, outcome, label);
    assert.equal(answered.check.detail_code, detail, label);
    results.push(answered.check);
  }
  // The timed-out call was told to stop, and its late answer was dropped.
  assert.equal(aborted, true);
  // The four unavailable checks are one unbroken run: each says since the first.
  const firstSince = results[0].unavailable_since;
  assert.ok(firstSince && Date.parse(firstSince) <= Date.parse(results[0].created_at));
  for (const row of results.slice(0, 4)) assert.equal(row.unavailable_since, firstSince);
  for (const row of results.slice(4)) assert.equal(row.unavailable_since, null);
  // After an answer, a new run starts.
  const fresh = await check(env, effectId, "transport:fresh", throwing(new ProposalDeliveryTransportError("network")));
  assert.notEqual(fresh.check.unavailable_since, firstSince);
  assert.ok(Date.parse(fresh.check.unavailable_since!) > Date.parse(results[3].created_at));
  assert.equal(fresh.deliveryState.state, "7c");
  assert.equal(fresh.deliveryState.since, fresh.check.unavailable_since);
  // A failure of the Worker's own is no answer at all: nothing is written.
  const rows = count(db, "SELECT count(*) AS n FROM proposal_delivery_checks");
  await assert.rejects(check(env, effectId, "transport:own", throwing(new TypeError("worker bug"))), TypeError);
  assert.equal(count(db, "SELECT count(*) AS n FROM proposal_delivery_checks"), rows);
});

test("the delivery read is the sales set's, for a revision that exists", async () => {
  const db = new D1();
  const env = workerEnv(db);
  assert.deepEqual(await read(env, fixtureAuth("production"), "?proposal_pack_id=a&proposal_revision_id=b"), {
    status: 403, body: { error: "sales_read_required" },
  });
  assert.deepEqual(await read(env, fixtureAuth("sales"), "?proposal_pack_id=a"), {
    status: 400, body: { error: "invalid_proposal_delivery_read" },
  });
  assert.deepEqual(await read(env, fixtureAuth("sales"), "?proposal_pack_id=proposal-pack:none&proposal_revision_id=proposal-revision:none"), {
    status: 404, body: { error: "not_found" },
  });
});

// ---------------------------------------------------------------------------------------------
// The escalation sweep

test("a send left unknown for T opens one owner-visible exception, which a person's record resolves", async () => {
  const db = new D1();
  const env = workerEnv(db);
  // Neither a withdrawal, another kind of send, nor a send that settled is escalated here.
  await send(env, "sweep:withdraw", "lost", { action: "proposal.withdraw" });
  await send(env, "sweep:other", "lost", { action: "mcp.test_write", aggregateType: "communication" });
  await send(env, "sweep:refused", "refused");
  // A send a person settled before T: never escalated, by its state alone.
  const settledFirst = await send(env, "sweep:settled-first", "lost");
  await recordProposalDeliveryConfirmation(env, {
    tenantId: TENANT, effectId: settledFirst, outcome: "delivered", note: "The customer confirmed by phone.",
    actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: "sweep:settled-first",
  });
  const effectId = await send(env, "sweep:lost", "lost");
  const endedAt = (db.raw.prepare(
    "SELECT ended_at FROM external_effect_attempts WHERE effect_id = ?",
  ).get(effectId) as { ended_at: string }).ended_at;
  // Every other send ended no later than this one, so the bounds below are this send's.
  const at = (ms: number) => new Date(Date.parse(endedAt) + ms);
  assert.deepEqual(await escalateStaleProposalDeliveries(env, at(PROPOSAL_DELIVERY_ESCALATION_MS - 1)), { opened: 0 });
  assert.deepEqual(await escalateStaleProposalDeliveries(env, at(PROPOSAL_DELIVERY_ESCALATION_MS)), { opened: 1 });
  assert.deepEqual(await escalateStaleProposalDeliveries(env, at(PROPOSAL_DELIVERY_ESCALATION_MS * 2)), { opened: 0 });
  const exception = db.raw.prepare(
    "SELECT exception_id, tenant_id, reason_code, status, created_at FROM external_effect_exceptions WHERE effect_id = ?",
  ).get(effectId) as Record<string, string>;
  assert.equal(exception.reason_code, PROPOSAL_DELIVERY_STALE_REASON);
  assert.equal(exception.tenant_id, TENANT);
  assert.equal(exception.status, "open");
  assert.equal(stateOf(db, effectId), "unknown");
  const owner = await buildOwnerNowReadModel(env, fixtureAuth("owner"));
  assert.ok(owner.exceptions.some((item: { id?: string }) => item.id === exception.exception_id));
  const state = await readProposalDeliveryState(env, TENANT, "proposal-pack:sweep:lost", "proposal-revision:sweep:lost");
  assert.equal(state.state, "7e");
  assert.equal(state.escalated_at, exception.created_at);
  // The person's record resolves it, and a settled send is never escalated again.
  await recordProposalDeliveryConfirmation(env, {
    tenantId: TENANT, effectId, outcome: "delivered", note: "The customer confirmed by phone.",
    actorUserId: USERS.ops, actorRole: "ops", idempotencyKey: "sweep:record",
  });
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ? AND status = 'open'", effectId), 0);
  assert.deepEqual(await escalateStaleProposalDeliveries(env, at(PROPOSAL_DELIVERY_ESCALATION_MS * 3)), { opened: 0 });
  assert.equal(count(db, "SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ?", settledFirst), 0);
});

test("the sweep opens at most its limit per run and takes the rest next time", async () => {
  const db = new D1();
  const env = workerEnv(db);
  for (const id of ["sweep:batch:1", "sweep:batch:2", "sweep:batch:3"]) await send(env, id, "lost");
  const later = new Date(Date.now() + PROPOSAL_DELIVERY_ESCALATION_MS);
  assert.deepEqual(await escalateStaleProposalDeliveries(env, later, 2), { opened: 2 });
  assert.deepEqual(await escalateStaleProposalDeliveries(env, later, 2), { opened: 1 });
  assert.deepEqual(await escalateStaleProposalDeliveries(env, later, 2), { opened: 0 });
});

test("a stuck publish claimed under another aggregate type is escalated all the same", async () => {
  // The aggregate type is the claimer's own word; the sweep, like 0164's evidence guard, keys on the
  // action. The check route still answers 404 for such a send: there is no proposal publication to
  // check delivery of.
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await send(env, "sweep:misbound", "lost", { aggregateType: "communication" });
  assert.equal(effectRow(db, effectId).aggregate_type, "communication");
  assert.deepEqual(await escalateStaleProposalDeliveries(env, new Date(Date.now() + PROPOSAL_DELIVERY_ESCALATION_MS)), { opened: 1 });
  assert.equal(
    count(db, "SELECT count(*) AS n FROM external_effect_exceptions WHERE effect_id = ? AND reason_code = ? AND status = 'open'",
      effectId, PROPOSAL_DELIVERY_STALE_REASON),
    1,
  );
  const ops = await person(db, env, "ops");
  assert.deepEqual(
    await post(env, ops, CHECK_PATH, { external_effect_id: effectId }, "delivery-check-misbound-0001"),
    { status: 404, body: { error: "proposal_delivery_effect_not_found" } },
  );
});

test("a send already escalated once is never escalated again, open or resolved", async () => {
  const db = new D1();
  const env = workerEnv(db);
  const effectId = await send(env, "sweep:once", "lost");
  db.raw.prepare(
    `INSERT INTO external_effect_exceptions (exception_id, effect_id, tenant_id, reason_code, status, created_at, resolved_at)
     VALUES ('effect-exception:sweep-once-resolved', ?, ?, ?, 'resolved', ?, ?)`,
  ).run(effectId, TENANT, PROPOSAL_DELIVERY_STALE_REASON, new Date().toISOString(), new Date().toISOString());
  assert.deepEqual(await escalateStaleProposalDeliveries(env, new Date(Date.now() + PROPOSAL_DELIVERY_ESCALATION_MS * 2)), { opened: 0 });
});

// ---------------------------------------------------------------------------------------------
// The delivery read: one state per revision (DESIGN.md §6)

test("the delivery read derives each state PR-A can reach", async () => {
  const db = new D1();
  const env = workerEnv(db, "synthetic");
  const stateFor = async (id: string, now?: Date) =>
    await readProposalDeliveryState(env, TENANT, `proposal-pack:${id}`, `proposal-revision:${id}`, now);

  assert.equal((await stateFor("state:none")).state, "S0");
  // Sending: proposed before its deadline, or claimed with a live lease.
  const { effect: proposedEffect } = envelope("state:proposed");
  await proposeExternalEffect(env, proposedEffect as ExternalEffectRequest);
  assert.equal((await stateFor("state:proposed")).state, "S2");
  assert.equal((await stateFor("state:proposed", new Date(Date.parse(proposedEffect.deadlineAt) + 1))).state, "S3");
  const { effect: liveEffect, authority: liveAuthority } = envelope("state:live");
  const live = await proposeExternalEffect(env, liveEffect as ExternalEffectRequest);
  await authorizeExternalEffect(env, live.effect_id, liveAuthority as EffectAuthority);
  await claimExternalEffect(env, live.effect_id);
  assert.equal((await stateFor("state:live")).state, "S2");
  await send(env, "state:failed", "refused");
  assert.equal((await stateFor("state:failed")).state, "S4");
  await send(env, "state:qa", "accepted", { provider: QA });
  assert.equal((await stateFor("state:qa")).state, "Q");
  await send(env, "state:real-sent", "accepted");
  assert.equal((await stateFor("state:real-sent")).state, "E1");

  // Unknown: 7, then by the newest check 7·u, 7c, 8(a), 1·b.
  const unknown = await send(env, "state:unknown", "lost");
  const seven = await stateFor("state:unknown");
  assert.equal(seven.state, "7");
  assert.equal(seven.check_allowed, true);
  assert.equal(seven.record_allowed, false);
  const endedAt = (db.raw.prepare("SELECT ended_at FROM external_effect_attempts WHERE effect_id = ?").get(unknown) as { ended_at: string }).ended_at;
  insertCheck(db, unknown, { outcome: "unknown" });
  const unclear = await stateFor("state:unknown");
  assert.equal(unclear.state, "7·u");
  assert.equal(unclear.record_allowed, true);
  assert.equal(unclear.not_delivered_allowed, true);
  // "Didn't get it" waits for the provider's window from the end of the attempt (0161).
  assert.equal(unclear.record_not_before, plus(endedAt, EFFECT_ATTEMPT_LEASE_MS));
  assert.equal((await stateFor("state:unknown", new Date(Date.parse(endedAt) + EFFECT_ATTEMPT_LEASE_MS))).record_not_before, null);
  const since = new Date(Date.now() - 5_000).toISOString();
  insertCheck(db, unknown, { outcome: "provider_unavailable", unavailableSince: since });
  const down = await stateFor("state:unknown");
  assert.equal(down.state, "7c");
  assert.equal(down.since, since);
  insertCheck(db, unknown, { outcome: "sent", createdAt: new Date(Date.now() + 1_000).toISOString() });
  assert.equal((await stateFor("state:unknown")).state, "8(a)");
  const bouncedAt = new Date(Date.now() + 2_000).toISOString();
  insertCheck(db, unknown, { outcome: "bounced", createdAt: bouncedAt });
  const bounced = await stateFor("state:unknown");
  assert.equal(bounced.state, "1·b");
  assert.equal(bounced.since, bouncedAt);
  // The earlier check found the message sent, so "didn't get it" stays closed beside the bounce.
  assert.equal(bounced.not_delivered_allowed, false);

  // A conflict of either kind: frame 1, checkable, and "didn't get it" only with a cited check.
  for (const [origin, make] of Object.entries(conflicts)) {
    const id = `state:conflict:${origin}`;
    const effectId = await make(env, id);
    const stuck = await stateFor(id);
    assert.deepEqual(
      [stuck.state, stuck.check_allowed, stuck.record_allowed, stuck.not_delivered_allowed, stuck.not_delivered_check_id],
      ["1", true, true, false, null],
      origin,
    );
    const cited = insertCheck(db, effectId, { outcome: "not_found", createdAt: plus(conflictAt(db, effectId), 1) });
    const open = await stateFor(id);
    assert.deepEqual([open.not_delivered_allowed, open.not_delivered_check_id, open.check?.check_id], [true, cited, cited], origin);
    insertConfirmation(db, effectId, "not_delivered", { checkId: cited });
    assert.equal((await stateFor(id)).state, "3/9b");
  }
  // A not-found at the conflict's moment, or before it, is not offered.
  const atMoment = await conflicts.reconciling(env, "state:conflict:moment");
  insertCheck(db, atMoment, { outcome: "not_found", createdAt: conflictAt(db, atMoment) });
  assert.equal((await stateFor("state:conflict:moment")).not_delivered_allowed, false);
  const earlier = await failedConflict(env, "state:conflict:earlier", PROMPT, new Date(Date.now() + 30_000).toISOString());
  insertCheck(db, earlier, { outcome: "not_found" });
  assert.equal((await stateFor("state:conflict:earlier")).not_delivered_allowed, false);
  // A silent provider's exception: frame 1, not checkable, recordable after the window.
  const silent = await send(env, "state:silent", "lost");
  await reconcileExternalEffect(env, silent, { outcome: "inconclusive", evidence: { provider: "no answer" } });
  const quiet = await stateFor("state:silent");
  assert.deepEqual([quiet.state, quiet.check_allowed, quiet.not_delivered_allowed], ["1", false, true]);
  assert.ok(quiet.record_not_before !== null);
  insertConfirmation(db, silent, "delivered");
  assert.equal((await stateFor("state:silent")).state, "4/9");
});
