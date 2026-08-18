import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { appendHermesResultAtomic } from "../src/hermes-result.ts";

const NOW = "2026-08-11T12:00:00.000Z";
const TENANT_ID = "ironwrap";
const USER_ID = "appu_owner_0001";
const PAIRING_ID = "hdpairing:test-0001";
const DEVICE_ID = "hddevice:test-0001";
const ENVELOPE_ID = "hdenvelope:test-0001";
const CONTEXT_SHA256 = "d".repeat(64);
const PROVIDER_REQUEST_SHA256 = "e".repeat(64);
const BINDING = {
  tenant_id: TENANT_ID,
  user_id: USER_ID,
  role: "owner" as const,
  device_id: DEVICE_ID,
  pairing_id: PAIRING_ID,
};
const SUBMISSION = {
  envelope_id: ENVELOPE_ID,
  output: { body: "Synthetic governed draft.", subject: "Roof estimate" },
};
const VALIDATION = { errors: [], ok: true };
const HANDOFF = {
  approval_required: true,
  execution_attempted: false,
  required_tool: "dry_run_communication_event",
};

type AppendInput = Parameters<typeof appendHermesResultAtomic>[0];

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");
  failBatchAt: number | null = null;

  constructor(options: { accessExpiresAt?: string; revokedAt?: string } = {}) {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of ["0011_app_bff_auth.sql", "0036_hermes_desktop_pilot.sql"])
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    this.seed(options);
  }

  prepare(sql: string) {
    return { bind: (...args: unknown[]) => new SqliteStatement(this.raw, sql, args) };
  }

  async batch(statements: SqliteStatement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement, index) => {
        if (index === this.failBatchAt) throw new Error(`synthetic_batch_failure_${index}`);
        const result = statement.execute();
        return { success: true, meta: { changes: Number(result.changes ?? 0) } };
      });
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }

  private seed(options: { accessExpiresAt?: string; revokedAt?: string }): void {
    this.raw.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', 'owner@example.invalid',
               1, 'seed', ?, ?)`,
    ).run(USER_ID, TENANT_ID, NOW, NOW);
    this.raw.prepare(
      `INSERT INTO hermes_desktop_pairings
       (pairing_id, token_sha256, tenant_id, user_id, role, api_audience,
        bound_issuer, bound_origin, issued_at, expires_at)
       VALUES (?, ?, ?, ?, 'owner', 'https://app.example.com',
               'https://app.example.com', 'https://app.example.com',
               '2026-08-11T11:00:00.000Z', '2026-08-11T13:00:00.000Z')`,
    ).run(PAIRING_ID, "a".repeat(64), TENANT_ID, USER_ID);
    this.raw.prepare(
      `INSERT INTO hermes_desktop_devices
       (device_id, pairing_id, tenant_id, user_id, role, api_audience,
        bound_issuer, bound_origin, connector_capabilities_json, device_name,
        device_proof_sha256, access_token_sha256, access_expires_at, paired_at,
        revoked_at, revoked_by_user_id)
       VALUES (?, ?, ?, ?, 'owner', 'https://app.example.com',
               'https://app.example.com', 'https://app.example.com', '[]',
               'Synthetic Desktop', ?, ?, ?, '2026-08-11T11:01:00.000Z', ?, ?)`,
    ).run(
      DEVICE_ID,
      PAIRING_ID,
      TENANT_ID,
      USER_ID,
      "b".repeat(64),
      "c".repeat(64),
      options.accessExpiresAt ?? "2026-08-11T13:00:00.000Z",
      options.revokedAt ?? null,
      options.revokedAt ? USER_ID : null,
    );
    this.raw.prepare(
      `INSERT INTO hermes_desktop_envelopes
       (envelope_id, version, workflow, tenant_id, user_id, role, device_id,
        pairing_id, lead_id, lead_envelope_id, roof_job_id, channel,
        recipient_ref, consent_id, consent_basis, state, context_sha256,
        context_json, envelope_json, provider_request_json,
        provider_request_sha256, output_schema_sha256, messages_sha256,
        issued_at, expires_at)
       VALUES (?, 'task_envelope_v1', 'lead_follow_up_draft', ?, ?, 'owner', ?, ?,
               'lead:test-0001', 'lead-envelope:test-0001', NULL, 'Email',
               'customer@example.invalid', 'consent:test-0001', 'Express',
               'issued', ?, '{}', '{}', '{}', ?, ?, ?,
               '2026-08-11T11:30:00.000Z', '2026-08-11T12:30:00.000Z')`,
    ).run(
      ENVELOPE_ID,
      TENANT_ID,
      USER_ID,
      DEVICE_ID,
      PAIRING_ID,
      CONTEXT_SHA256,
      PROVIDER_REQUEST_SHA256,
      "f".repeat(64),
      "0".repeat(64),
    );
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(
    raw: DatabaseSync,
    sql: string,
    args: unknown[],
  ) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  execute() {
    return this.raw.prepare(this.sql).run(...this.args);
  }
}

function appendInput(db: SqliteD1, overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    env: { DB: db as never },
    binding: BINDING,
    envelopeId: ENVELOPE_ID,
    contextId: null,
    contextSha256: CONTEXT_SHA256,
    providerRequestSha256: PROVIDER_REQUEST_SHA256,
    sourceChannel: "desktop",
    idempotencyKey: "idem:test-0001",
    submission: SUBMISSION,
    outcome: "accepted",
    validation: VALIDATION,
    governedHandoff: HANDOFF,
    resultId: "hdresult:test-0001",
    eventId: "hdevent:test-0001",
    recordedAt: NOW,
    ...overrides,
  };
}

function count(db: SqliteD1, table: "hermes_desktop_results" | "hermes_desktop_events"): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function envelopeState(db: SqliteD1): { state: string; submitted_at: string | null } {
  return { ...db.raw.prepare(
    "SELECT state, submitted_at FROM hermes_desktop_envelopes WHERE envelope_id = ?",
  ).get(ENVELOPE_ID) } as { state: string; submitted_at: string | null };
}

test("accepted result appends once, transitions terminally, and records its event", async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());

  const response = await appendHermesResultAtomic(appendInput(db));
  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.replayed, false);
  assert.equal(response.outcome, "accepted");
  assert.match(response.resultSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(envelopeState(db), { state: "submitted", submitted_at: NOW });

  const stored = db.raw.prepare(
    `SELECT result_id, outcome, result_sha256, result_json
       FROM hermes_desktop_results`,
  ).get() as { result_id: string; outcome: string; result_sha256: string; result_json: string };
  assert.equal(stored.result_id, response.resultId);
  assert.equal(stored.outcome, "accepted");
  assert.equal(stored.result_sha256, response.resultSha256);
  assert.deepEqual(JSON.parse(stored.result_json), response.result);
  assert.deepEqual(
    { ...db.raw.prepare(
      "SELECT event_type, envelope_id, result_id FROM hermes_desktop_events",
    ).get() },
    { event_type: "draft_result_recorded", envelope_id: ENVELOPE_ID, result_id: response.resultId },
  );
});

test("rejected result is append-only evidence and leaves the envelope nonterminal", async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());

  const response = await appendHermesResultAtomic(appendInput(db, {
    outcome: "rejected",
    governedHandoff: null,
  }));
  assert.equal(response.ok, true);
  assert.deepEqual(envelopeState(db), { state: "issued", submitted_at: null });
  assert.equal(count(db, "hermes_desktop_results"), 1);
  assert.equal(count(db, "hermes_desktop_events"), 1);
  assert.equal(
    (db.raw.prepare("SELECT outcome FROM hermes_desktop_results").get() as { outcome: string }).outcome,
    "rejected",
  );
});

test("an exact replay returns the stored row while changed submission bytes conflict", async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());

  const first = await appendHermesResultAtomic(appendInput(db));
  assert.equal(first.ok, true);
  const replay = await appendHermesResultAtomic(appendInput(db, {
    resultId: "hdresult:replay-ignored",
    eventId: "hdevent:replay-ignored",
  }));
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.resultId, first.resultId);
  assert.equal(replay.resultSha256, first.resultSha256);
  assert.equal(count(db, "hermes_desktop_results"), 1);
  assert.equal(count(db, "hermes_desktop_events"), 1);

  const crossDeviceReplay = await appendHermesResultAtomic(appendInput(db, {
    binding: {
      ...BINDING,
      device_id: "hddevice:other-0002",
      pairing_id: "hdpairing:other-0002",
    },
    resultId: "hdresult:cross-device-ignored",
    eventId: "hdevent:cross-device-ignored",
  }));
  assert.deepEqual(crossDeviceReplay, { ok: false, error: "terminal_conflict" });
  assert.equal("result" in crossDeviceReplay, false);

  const conflict = await appendHermesResultAtomic(appendInput(db, {
    submission: {
      ...SUBMISSION,
      output: { ...SUBMISSION.output, body: "Changed canonical bytes." },
    },
    resultId: "hdresult:conflict-ignored",
    eventId: "hdevent:conflict-ignored",
  }));
  assert.deepEqual(conflict, { ok: false, error: "idempotency_conflict" });
  assert.equal(count(db, "hermes_desktop_results"), 1);
  assert.equal(count(db, "hermes_desktop_events"), 1);
});

test("concurrent desktop and hosted acceptance stores exactly one terminal result", async (t) => {
  const db = new SqliteD1();
  t.after(() => db.close());

  const responses = await Promise.all([
    appendHermesResultAtomic(appendInput(db, {
      sourceChannel: "desktop",
      idempotencyKey: "idem:desktop-race",
      resultId: "hdresult:desktop-race",
      eventId: "hdevent:desktop-race",
    })),
    appendHermesResultAtomic(appendInput(db, {
      sourceChannel: "hosted_reference",
      idempotencyKey: "idem:hosted-race",
      resultId: "hdresult:hosted-race",
      eventId: "hdevent:hosted-race",
    })),
  ]);

  assert.equal(responses.filter((response) => response.ok).length, 1);
  assert.equal(responses.filter((response) => !response.ok).length, 1);
  assert.equal(count(db, "hermes_desktop_results"), 1);
  assert.equal(count(db, "hermes_desktop_events"), 1);
  assert.deepEqual(envelopeState(db), { state: "submitted", submitted_at: NOW });
  assert.equal(
    (db.raw.prepare("SELECT outcome FROM hermes_desktop_results").get() as { outcome: string }).outcome,
    "accepted",
  );
});

test("result or event batch failure exposes no handoff and rolls back every partial row", async (t) => {
  for (const [name, failBatchAt] of [["result insert", 0], ["event insert", 2]] as const) {
    await t.test(name, async (t) => {
      const db = new SqliteD1();
      t.after(() => db.close());
      db.failBatchAt = failBatchAt;

      const response = await appendHermesResultAtomic(appendInput(db));
      assert.deepEqual(response, { ok: false, error: "result_store_unavailable" });
      assert.equal("result" in response, false);
      assert.equal(count(db, "hermes_desktop_results"), 0);
      assert.equal(count(db, "hermes_desktop_events"), 0);
      assert.deepEqual(envelopeState(db), { state: "issued", submitted_at: null });
    });
  }
});

test("a binding revoked before result append or expiring exactly now is denied", async (t) => {
  for (const [name, options] of [
    ["revoked", { revokedAt: "2026-08-11T11:59:59.000Z" }],
    ["exact expiry", { accessExpiresAt: NOW }],
  ] as const) {
    await t.test(name, async (t) => {
      const db = new SqliteD1(options);
      t.after(() => db.close());

      const response = await appendHermesResultAtomic(appendInput(db));
      assert.deepEqual(response, { ok: false, error: "binding_revoked_or_expired" });
      assert.equal("result" in response, false);
      assert.equal(count(db, "hermes_desktop_results"), 0);
      assert.equal(count(db, "hermes_desktop_events"), 0);
      assert.deepEqual(envelopeState(db), { state: "issued", submitted_at: null });
    });
  }
});

test("desktop and hosted reference produce the same result digest in fresh databases", async (t) => {
  const desktopDb = new SqliteD1();
  const hostedDb = new SqliteD1();
  t.after(() => {
    desktopDb.close();
    hostedDb.close();
  });

  const desktop = await appendHermesResultAtomic(appendInput(desktopDb, {
    sourceChannel: "desktop",
    resultId: "hdresult:desktop-parity",
    eventId: "hdevent:desktop-parity",
  }));
  const hosted = await appendHermesResultAtomic(appendInput(hostedDb, {
    sourceChannel: "hosted_reference",
    resultId: "hdresult:hosted-parity",
    eventId: "hdevent:hosted-parity",
  }));
  assert.equal(desktop.ok, true);
  assert.equal(hosted.ok, true);
  if (!desktop.ok || !hosted.ok) return;
  assert.notEqual(desktop.sourceChannel, hosted.sourceChannel);
  assert.notEqual(desktop.resultId, hosted.resultId);
  assert.equal(desktop.resultSha256, hosted.resultSha256);
  assert.deepEqual(desktop.result, hosted.result);
});
