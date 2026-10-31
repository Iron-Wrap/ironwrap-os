// Signal text retention (src/agents/retention.ts, migration 0207): ninety days after a signal was
// received its free text is redacted in place, once, and nothing else about it moves. The guard
// reads the age on D1's clock, so these tests date their signals from the real clock. Synthetic
// data only (example.invalid).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAgentHostApi } from "../src/agents/api.ts";
import { inboundSignal, type InboundSender } from "../src/agents/inbound.ts";
import { redactSignalText, SIGNAL_REDACTION_BATCH, SIGNAL_TEXT_RETENTION_DAYS, signalRedactionOn } from "../src/agents/retention.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { appendSignal, listSignals, openRun, type BoundStatement } from "../src/agents/store.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import worker from "../src/index.ts";

const TENANT = "ironwrap";
const DAY = 86_400_000;
const NO_MATCH: InboundSender = { customer_id: null, matched_on: null, conflict: false };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const migration = (file: string) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
/** An instant `days` before the real clock, in the ISO form every signal writer stores. */
const ago = (days: number, ms = 0) => new Date(Date.now() - days * DAY - ms).toISOString();

/** Real SQLite with every migration, D1's atomic batch and trigger-inclusive change counts. */
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  beforeRunInsert: (() => Promise<void>) | null = null;
  afterRunInsert: (() => Promise<void>) | null = null;
  /** Every statement prepared, for its query plan. */
  seen: string[] = [];
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    const files = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    for (const file of files) this.raw.exec(migration(file));
  }
  prepare(sql: string) {
    this.seen.push(sql);
    return {
      bind: (...values: unknown[]) => {
        const args = values as Array<string | number | null>;
        return {
          first: async <T>() => (this.raw.prepare(sql).get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: this.raw.prepare(sql).all(...args) as T[] }),
          run: async () => {
            const runInsert = /^\s*INSERT INTO agent_runs\s/.test(sql);
            if (runInsert && this.beforeRunInsert) {
              const beforeInsert = this.beforeRunInsert;
              this.beforeRunInsert = null;
              await beforeInsert();
            }
            const before = this.changes();
            this.raw.prepare(sql).run(...args);
            const changes = this.changes() - before;
            if (runInsert && this.afterRunInsert) {
              const afterInsert = this.afterRunInsert;
              this.afterRunInsert = null;
              await afterInsert();
            }
            return { success: true, meta: { changes } };
          },
        };
      },
    };
  }
  async batch(statements: BoundStatement[]) {
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
  row(signalId: string) {
    return this.raw.prepare("SELECT * FROM agent_signals WHERE signal_id = ?").get(signalId) as Record<string, any>;
  }
  content(signalId: string) {
    return JSON.parse(this.row(signalId).content_json);
  }
  private changes(): number {
    return Number((this.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  }
}

/** A website form envelope, as intake writes it. */
function envelope(id: string): EnvelopeRecord {
  return {
    envelope_id: id,
    source: "website",
    contact_name: "Avery Example",
    contact_phone: "+15875550142",
    contact_email: "avery@example.invalid",
    job_ref: null,
    payload_json: JSON.stringify({
      brand: "IronWrap",
      service: "metal roofing",
      message: "Synthetic: please quote a metal re-roof.",
      address: "1 Synthetic Way",
      city: "Calgary",
      province: "AB",
      postal_code: "T2P 0A1",
      scope: "house and detached garage",
      timing: "before the first snow",
    }),
    raw_key: null,
    ts: "2026-02-01T10:00:00.000Z",
    status: "pending_jn_push",
    dedup_key: null,
    dup_of: null,
    attempts: 0,
    last_error: null,
    jn_contact_id: null,
    jn_job_id: null,
  };
}

/** The content each signal writer records (inbound.ts, ask.ts, store.ts handoff, watches.ts). */
const ASK = { question: "Synthetic: what is waiting on this job?", context: { route: "/jobs/job_synthetic", object: { aggregate: "job", id: "job_synthetic" } }, asker_role: "sales" };
const REQUEST = { expected_action_id: "lead.qualify", target: { aggregate: "lead", id: "lead_synthetic" }, ask_id: null, requester_role: "owner" };
const HANDOFF = {
  from_specialist_id: "lead_concierge",
  from_run_id: "run_synthetic",
  object: { aggregate: "lead", id: "lead_synthetic", version: 1 },
  reason: "Synthetic: the caller asked for a site visit.",
  expected_action_id: "lead.qualify",
};
const WATCH = { objects: [{ aggregate: "lead", id: "lead_synthetic" }], condition: "stale_lead" };

let seq = 0;
/** A signal row as its writer leaves it, received at `at`. */
function insert(db: SqliteD1, kind: string, content: unknown, at: string, tenant = TENANT) {
  seq += 1;
  const id = `sig_synthetic_${seq}`;
  const json = canonicalJson(content);
  db.raw
    .prepare(
      `INSERT INTO agent_signals (signal_id, tenant_id, kind, specialist_id, watch_id, source, subject_aggregate, subject_id,
        content_json, content_sha256, dedupe_key, parent_run_id, handoff_depth, received_at)
       VALUES (?, ?, ?, 'lead_concierge', ?, ?, 'lead', 'lead_synthetic', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tenant,
      kind,
      kind === "handoff" ? "handoff.created" : kind === "watch" ? "stale_lead" : null,
      kind === "owner_request" ? "ask:appu_sales_0001" : kind === "handoff" ? "orchestrator" : "web_form",
      json,
      sha256(json),
      `synthetic:${seq}`,
      kind === "handoff" ? "run_synthetic" : null,
      kind === "handoff" ? 1 : 0,
      at,
    );
  return id;
}

// The redaction the guard admits, written here independently of retention.ts.
const REDACTED = `CASE kind
  WHEN 'event' THEN json_set(json_remove(content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'))
  WHEN 'owner_request' THEN json_set(json_remove(content_json, '$.question'), '$.redacted', json('true'))
  WHEN 'handoff' THEN json_set(json_remove(content_json, '$.reason'), '$.redacted', json('true')) END`;
const update = (db: SqliteD1, id: string, set: string) => () => db.raw.prepare(`UPDATE agent_signals SET ${set} WHERE signal_id = ?`).run(id);

test("migration 0207: the signal guard is 0200's plus one exception, at the code's ninety days", () => {
  const db = new SqliteD1();
  const live = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_agent_signal_update'").get() as { sql: string };
  const base = /CREATE TRIGGER IF NOT EXISTS prevent_agent_signal_update\n[\s\S]*?\nEND/.exec(migration("0200_agent_coordination.sql"))![0];
  const exception = /\nWHEN NOT \([\s\S]*?\n {2}\)/.exec(migration("0207_agent_signal_redaction.sql"))![0];
  assert.equal(live.sql.split(exception).length, 2, "the exception appears once");
  assert.equal(live.sql.replace(exception, ""), base.replace("IF NOT EXISTS ", ""));
  // The owner's ruling, final; the guard's age is the same, so the code can never go below it.
  assert.equal(SIGNAL_TEXT_RETENTION_DAYS, 90);
  assert.deepEqual([...exception.matchAll(/'now', '-(\d+) days'/g)].map((match) => Number(match[1])), [SIGNAL_TEXT_RETENTION_DAYS]);
  // The delete guard and the no-replace guard are 0200's, untouched.
  for (const name of ["prevent_agent_signal_delete", "agent_signals_no_insert_replace"]) {
    const sql = (db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as { sql: string }).sql;
    assert.equal(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\n[\\s\\S]*?\\nEND`).exec(migration("0200_agent_coordination.sql"))![0].replace("IF NOT EXISTS ", ""));
  }
});

test("migration 0207: only a signal past ninety days loses its text, once, and nothing else about it moves", () => {
  const db = new SqliteD1();
  const old = ago(SIGNAL_TEXT_RETENTION_DAYS + 1);
  const refused = (fn: () => unknown, label: string) => assert.throws(fn, /agent_signals_append_only/, label);

  // Each frozen column, moved alone beside an otherwise valid redaction, is refused (the last
  // assignment to a column wins in SQLite). The table's own columns name what must be frozen, so a
  // column added later fails here until the guard pins it.
  const event = insert(db, "event", { envelope_id: "ow_synthetic", channel: "web_form", excerpt: "Synthetic text.", form_fields: { address: "1 Synthetic Way", scope: null, timing: null }, service: "metal roofing" }, old);
  const frozen: Record<string, string> = {
    signal_seq: "signal_seq + 1000",
    signal_id: "'sig_synthetic_other'",
    tenant_id: "'tenant_synthetic'",
    kind: "'owner_request'",
    specialist_id: "'estimator'",
    watch_id: "'synthetic'",
    source: "'phone'",
    subject_aggregate: "'job'",
    subject_id: "'lead_other'",
    content_sha256: "'synthetic'",
    dedupe_key: "'synthetic:other'",
    parent_run_id: "'run_synthetic'",
    handoff_depth: "handoff_depth + 1",
    received_at: `'${ago(SIGNAL_TEXT_RETENTION_DAYS + 2)}'`,
  };
  const columns = (db.raw.prepare("PRAGMA table_info(agent_signals)").all() as Array<{ name: string }>).map((column) => column.name).filter((name) => name !== "content_json");
  assert.deepEqual(Object.keys(frozen).sort(), columns.sort());
  const guard = (db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_agent_signal_update'").get() as { sql: string }).sql;
  for (const column of columns) assert.ok(guard.includes(`AND NEW.${column} IS OLD.${column}\n`), `the guard pins ${column}`);
  for (const [column, value] of Object.entries(frozen)) refused(update(db, event, `content_json = ${REDACTED}, ${column} = ${value}`), column);
  // Any content but the exact redaction of its kind is refused.
  for (const content of [
    "content_json",
    "json_set(json_remove(content_json, '$.excerpt'), '$.redacted', json('true'))",
    "json_set(json_remove(content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'), '$.channel', 'phone')",
    "json_set(json_remove(content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('false'))",
    "json_remove(content_json, '$.excerpt', '$.form_fields', '$.service')",
    "json_set(json_remove(content_json, '$.question'), '$.redacted', json('true'))",
    "NULL",
  ])
    refused(update(db, event, `content_json = ${content}`), content);

  // Ninety days is the floor, on D1's clock in the stored ISO form: a minute short is refused, a
  // minute past is redacted.
  const young = insert(db, "event", { envelope_id: "ow_young", excerpt: "Synthetic text." }, ago(SIGNAL_TEXT_RETENTION_DAYS, -60_000));
  refused(update(db, young, `content_json = ${REDACTED}`), "a minute short of ninety days");
  const due = insert(db, "event", { envelope_id: "ow_due", excerpt: "Synthetic text." }, ago(SIGNAL_TEXT_RETENTION_DAYS, 60_000));
  assert.equal(update(db, due, `content_json = ${REDACTED}`)().changes, 1);

  // A watch holds the Worker's own records: never redacted, nor emptied.
  const watch = insert(db, "watch", WATCH, old);
  refused(update(db, watch, "content_json = json_set(content_json, '$.redacted', json('true'))"), "a watch");
  refused(update(db, watch, "content_json = NULL"), "a watch emptied");

  // Each other kind loses exactly its own text, keeps its hash, and is then final.
  const expected: Array<[string, unknown, unknown]> = [
    ["event", { envelope_id: "ow_synthetic", channel: "web_form", excerpt: "x", form_fields: { address: null, scope: "x", timing: null }, service: "x", sender: NO_MATCH }, { envelope_id: "ow_synthetic", channel: "web_form", sender: NO_MATCH, redacted: true }],
    ["owner_request", ASK, { context: ASK.context, asker_role: "sales", redacted: true }],
    ["owner_request", REQUEST, { ...REQUEST, redacted: true }],
    ["handoff", HANDOFF, { from_specialist_id: "lead_concierge", from_run_id: "run_synthetic", object: HANDOFF.object, expected_action_id: "lead.qualify", redacted: true }],
  ];
  for (const [kind, content, redacted] of expected) {
    const id = insert(db, kind, content, old);
    const before = db.row(id);
    assert.equal(update(db, id, `content_json = ${REDACTED}`)().changes, 1, kind);
    assert.deepEqual(db.content(id), redacted, kind);
    assert.deepEqual({ ...db.row(id), content_json: before.content_json }, { ...before }, `${kind}: every other column as it was`);
    assert.equal(db.row(id).content_sha256, sha256(canonicalJson(content)), `${kind}: the hash of what was received`);
    // Once: a second redaction, which would change nothing, is refused, as is any other change.
    refused(update(db, id, `content_json = ${REDACTED}`), `${kind}: a second redaction`);
    refused(update(db, id, `content_json = json_remove(content_json, '$.redacted')`), `${kind}: un-redacted`);
    refused(update(db, id, "source = 'synthetic'"), `${kind}: any other change`);
    assert.throws(() => db.raw.prepare("DELETE FROM agent_signals WHERE signal_id = ?").run(id), /agent_signals_append_only/, `${kind}: never deleted`);
  }
});

test("redactSignalText redacts the oldest past ninety days, at most a batch a run, once, through the unredacted index", async () => {
  const db = new SqliteD1();
  const text = { envelope_id: "ow_synthetic", excerpt: "Synthetic text." };
  // Two more than a batch past their ninety days, the newest of them last.
  const due = Array.from({ length: SIGNAL_REDACTION_BATCH + 2 }, (_, index) => insert(db, "event", text, ago(SIGNAL_TEXT_RETENTION_DAYS + 1, (SIGNAL_REDACTION_BATCH + 2 - index) * 1_000)));
  const young = insert(db, "owner_request", ASK, ago(SIGNAL_TEXT_RETENTION_DAYS - 1));
  const watch = insert(db, "watch", WATCH, ago(SIGNAL_TEXT_RETENTION_DAYS + 30));
  const elsewhere = insert(db, "handoff", HANDOFF, ago(SIGNAL_TEXT_RETENTION_DAYS + 30), "tenant_synthetic");
  const redacted = (ids: string[]) => ids.filter((id) => db.content(id).redacted === true).length;

  assert.equal(await redactSignalText(db, TENANT), SIGNAL_REDACTION_BATCH);
  assert.equal(redacted(due.slice(0, SIGNAL_REDACTION_BATCH)), SIGNAL_REDACTION_BATCH, "the oldest first");
  assert.equal(redacted(due.slice(SIGNAL_REDACTION_BATCH)), 0, "the newest wait for the next run");
  assert.equal(await redactSignalText(db, TENANT), 2);
  assert.equal(await redactSignalText(db, TENANT), 0, "nothing twice");
  assert.equal(redacted(due), due.length);
  assert.deepEqual([db.content(young), db.content(watch), db.content(elsewhere)], [ASK, WATCH, HANDOFF], "younger, a watch, another tenant: untouched");

  // The read walks only signals still holding their text: the partial index, by tenant and age.
  const sql = db.seen.find((entry) => entry.startsWith("UPDATE agent_signals"))!;
  const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  assert.match(plan, /SEARCH agent_signals USING INDEX idx_agent_signals_unredacted \(tenant_id=\? AND received_at<\?\)/, plan);
  assert.doesNotMatch(plan, /SCAN agent_signals|TEMP B-TREE/, plan);
  assert.equal(Number((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_signals INDEXED BY idx_agent_signals_unredacted WHERE tenant_id = ? AND kind IN ('event', 'owner_request', 'handoff') AND json_extract(content_json, '$.redacted') IS NULL").get(TENANT) as { n: number }).n), 1, "only the young ask is left in it");
});

test("an inbound event keeps its envelope, channel and sender match and loses what the sender wrote", async () => {
  const db = new SqliteD1();
  const signal = (await inboundSignal(TENANT, envelope("ow_00000000-0000-4000-8000-000000000207"), NO_MATCH))!;
  const appended = await appendSignal(db, TENANT, signal, ago(SIGNAL_TEXT_RETENTION_DAYS + 1));
  assert.ok("signal_id" in appended && appended.created);
  const received = db.row(appended.signal_id);
  assert.deepEqual(Object.keys(db.content(appended.signal_id)).sort(), ["brand", "channel", "envelope_id", "excerpt", "form_fields", "has_email", "has_phone", "received_via", "sender", "service"]);

  assert.equal(await redactSignalText(db, TENANT), 1);
  assert.deepEqual(db.content(appended.signal_id), {
    envelope_id: "ow_00000000-0000-4000-8000-000000000207",
    channel: "web_form",
    brand: "ironwrap",
    received_via: null,
    sender: NO_MATCH,
    has_phone: true,
    has_email: true,
    redacted: true,
  });
  const text = db.row(appended.signal_id).content_json as string;
  for (const written of ["re-roof", "Synthetic Way", "detached garage", "first snow", "metal"]) assert.ok(!text.includes(written), written);
  assert.equal(db.row(appended.signal_id).content_sha256, received.content_sha256);
  // The host reads the redacted content under the signal's own id and subject, and no run starts
  // on it (409: the host skips it).
  const { signals } = await listSignals(db, TENANT, 0, 10);
  assert.deepEqual([signals[0].signal_id, signals[0].subject, signals[0].content.redacted], [appended.signal_id, signal.subject, true]);
  assert.deepEqual(await openRun(db, TENANT, { signal_id: appended.signal_id, specialist_id: "lead_concierge", host_run_key: "synthetic-redacted" }, new Date().toISOString()), {
    error: "signal_redacted",
    status: 409,
  });
});

test("run admission and redaction serialize at the actual INSERT, preserving existing run keys", async (t) => {
  for (const ordering of ["redaction first", "admission first", "same-key winner then redaction"] as const) {
    await t.test(ordering, async () => {
      const db = new SqliteD1();
      try {
        const excerpt = "Synthetic text erased at admission.";
        const appended = await appendSignal(db, TENANT, {
          kind: "event", specialist_id: "lead_concierge", watch_id: "new_inbound", source: "web_form", subject: null,
          content: { envelope_id: "envelope_synthetic_race", channel: "web_form", excerpt },
          dedupe_key: "synthetic:redaction-admission",
        }, ago(SIGNAL_TEXT_RETENTION_DAYS + 1));
        assert.ok("signal_id" in appended && appended.created);
        const id = appended.signal_id;
        const originalHash = db.row(id).content_sha256;
        const request = async (key = "synthetic-admission", specialist = "lead_concierge") => {
          const response = await handleAgentHostApi(new Request("https://bus.example.invalid/api/v1/agents/runs", {
            method: "POST",
            headers: { authorization: "Bearer synthetic-retention-token", "content-type": "application/json" },
            body: JSON.stringify({ signal_id: id, specialist_id: specialist, host_run_key: key }),
          }), { DB: db, AGENT_HOST_TOKEN: "synthetic-retention-token", APP_TENANT_ID: TENANT, AGENT_DATA_CLASS: "synthetic" });
          return { status: response.status, body: await response.json() as Record<string, any> };
        };
        const redact = async () => { assert.equal(await redactSignalText(db, TENANT), 1); };
        let winnerId: string | null = null;
        if (ordering === "redaction first") db.beforeRunInsert = redact;
        else if (ordering === "admission first") db.afterRunInsert = redact;
        else db.beforeRunInsert = async () => {
          const winner = await request();
          assert.equal(winner.status, 201);
          winnerId = winner.body.run_id;
          await redact();
        };

        const opened = await request();
        assert.equal(db.content(id).redacted, true);
        assert.equal(Object.hasOwn(db.content(id), "excerpt"), false);
        assert.equal(db.row(id).content_sha256, originalHash);
        const count = (table: string) => Number((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
        if (ordering === "redaction first") {
          assert.deepEqual(opened, { status: 409, body: { error: "signal_redacted" } });
          assert.equal(count("agent_runs"), 0);
          assert.equal(count("agent_run_events"), 0);
          assert.equal(JSON.stringify(opened).includes(excerpt), false);
        } else {
          assert.equal(opened.status, ordering === "admission first" ? 201 : 200);
          assert.equal(count("agent_runs"), 1);
          if (winnerId) assert.equal(opened.body.run_id, winnerId, "the existing same-key run wins before redaction classification");
          // Admission before redaction is valid; replay retains that run but hydrates the now-redacted row.
          const replay = await request();
          assert.equal(replay.status, 200);
          assert.equal(replay.body.run_id, opened.body.run_id);
          assert.equal(replay.body.resumed, true);
          assert.equal(JSON.stringify(replay.body).includes(excerpt), false);
          assert.equal(replay.body.context.facts.find((fact: { fact_id: string }) => fact.fact_id === `signal/${id}`).hash, `sha256:${originalHash}`);
          assert.deepEqual(await request("synthetic-admission", "estimator"), { status: 422, body: { error: "run_key_conflict" } });
        }
        assert.deepEqual(await request("synthetic-admission-new"), { status: 409, body: { error: "signal_redacted" } });
      } finally {
        db.raw.close();
      }
    });
  }
});

test("a signal is stored only under the time form the redaction's age check compares", async () => {
  const db = new SqliteD1();
  const input = { kind: "event" as const, specialist_id: "lead_concierge", watch_id: null, source: "web_form", subject: null, content: { excerpt: "Synthetic." }, dedupe_key: "synthetic:time" };
  // A space for the T sorts before the stored form and would read a day old too early.
  for (const now of ["2026-07-01 10:00:00.000Z", "2026-07-01T10:00:00Z", "2026-07-01T10:00:00.000+00:00", ""])
    await assert.rejects(appendSignal(db, TENANT, input, now), /invalid_signal_time/, now);
  assert.equal(Number((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_signals").get() as { n: number }).n), 0);
  const stored = await appendSignal(db, TENANT, input, new Date().toISOString());
  assert.ok("signal_id" in stored && stored.created);
  // D1's clock in the guard writes the same form.
  const d1 = (db.raw.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS at").get() as { at: string }).at;
  assert.match(d1, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(db.row(stored.signal_id).received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("the daily cron redacts only while AGENT_SIGNAL_REDACTION is on", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  t.mock.method(console, "log", () => {});
  assert.deepEqual([undefined, "", " ", "off", "true", "ON", "on", " on "].map(signalRedactionOn), [false, false, false, false, false, false, true, true]);
  const db = new SqliteD1();
  const id = insert(db, "owner_request", ASK, ago(SIGNAL_TEXT_RETENTION_DAYS + 1));
  const cron = async (vars: Record<string, string>) => {
    const pending: Array<Promise<unknown>> = [];
    await worker.scheduled(
      { cron: "0 14 * * *", scheduledTime: Date.now(), noRetry() {} } as never,
      {
        DB: db,
        APP_TENANT_ID: TENANT,
        ADMIN_TOKEN: "admin-secret",
        INGEST_TOKEN: "ingest-secret",
        OWNER_ALERT_EMAIL: "owner@example.invalid",
        BACKUP_ALERT_EMAIL: "backup@example.invalid",
        FROM_EMAIL: "bus@example.invalid",
        JOBNIMBUS_ENABLED: "false",
        ERPNEXT_ENABLED: "false",
        RAW: { put: async () => {} },
        JN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
        ...vars,
      } as never,
      { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException() {} } as never,
    );
    assert.equal(pending.length, 1);
    // The tick's other jobs may fail on this bare env; the redaction runs beside them regardless.
    await Promise.allSettled(pending);
  };
  await cron({ AGENT_SIGNAL_REDACTION: "" });
  assert.deepEqual(db.content(id), ASK, "off: untouched");
  await cron({ AGENT_SIGNAL_REDACTION: "on" });
  assert.deepEqual(db.content(id), { context: ASK.context, asker_role: "sales", redacted: true });
});

test("only retention.ts updates a signal, and nothing hashes a signal's content again", () => {
  const src = new URL("../src/", import.meta.url);
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((file) => file.endsWith(".ts")).sort();
  const read = (file: string) => readFileSync(new URL(file, src), "utf8");
  assert.deepEqual(files.filter((file) => /UPDATE\s+(OR\s+\w+\s+)?agent_signals/i.test(read(file))), ["agents/retention.ts"]);
  // The stored content_sha256 is the hash of what was received; a receipt that cites a signal
  // names it (store.ts signalFact, ask.ts). Only the two inserts hash content, before it is stored,
  // and nothing hashes a stored row's content_json in its place.
  assert.deepEqual(files.filter((file) => /(sha256Hex|factHash|sha256)\([^)]*content_json/.test(read(file))), []);
  assert.deepEqual(files.filter((file) => /INSERT INTO agent_signals[^;]*content_sha256/.test(read(file))), ["agents/store.ts"]);
});
