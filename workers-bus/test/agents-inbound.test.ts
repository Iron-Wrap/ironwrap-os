import { emptyAgentPrivacyLedger } from "./agents-privacy-fixtures.ts";
// The inbound producer (src/agents/inbound.ts): every inbound envelope becomes one new_inbound
// signal for the AI receptionist, from intake's own insert or from the cron's sweep, and a run on
// it can propose the lead's facts from that signal alone. Synthetic data only (example.invalid).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAgentHostApi } from "../src/agents/api.ts";
import {
  INBOUND_CHANNELS,
  inboundAfterInsert,
  inboundFrom,
  inboundSignal,
  produceInbound,
  senderMatch,
  sweepInbound,
  SWEEP_WINDOW_MS,
  type InboundSender,
} from "../src/agents/inbound.ts";
import { INBOUND_ONLY } from "../src/agents/policy.ts";
import { OBJECT_MODELS } from "../src/agents/read-models.ts";
import { INBOUND_CHANNELS as REPLAY_INBOUND_CHANNELS, INBOUND_ONLY as REPLAY_INBOUND_ONLY } from "../../agent-host/src/replay/case-run.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import type { BoundStatement } from "../src/agents/store.ts";
import type { EnvelopeRecord } from "../src/core.ts";
import worker from "../src/index.ts";
import { ingestLead } from "../src/lead-intake.ts";
import { materializeOperatingCore } from "../src/operating-core.ts";

const TENANT = "ironwrap";
const TOKEN = "synthetic-agent-host-token-0001";
// Switched on well before any clock these tests run on; the boundary tests name their own instants.
const ON = "2026-01-01T00:00:00Z";
const FROM = "2026-01-01T00:00:00.000Z";
const NO_MATCH: InboundSender = { customer_id: null, matched_on: null, conflict: false };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Real SQLite with every migration, D1's atomic batch and trigger-inclusive change counts. */
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  /** A statement this matches throws, as D1 does when it is unavailable. */
  failWhen: ((sql: string, values: unknown[]) => boolean) | null = null;
  /** Every statement prepared, for its query plan. */
  seen: string[] = [];
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    const files = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    for (const file of files) this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  prepare(sql: string) {
    this.seen.push(sql);
    return {
      bind: (...values: unknown[]) => {
        const args = values as Array<string | number | null>;
        const reach = () => {
          if (this.failWhen?.(sql, values)) throw new Error("D1_ERROR: synthetic outage");
        };
        return {
          first: async <T>() => {
            reach();
            return (this.raw.prepare(sql).get(...args) ?? null) as T | null;
          },
          all: async <T>() => {
            reach();
            return { results: this.raw.prepare(sql).all(...args) as T[] };
          },
          run: async () => {
            reach();
            const before = this.changes();
            this.raw.prepare(sql).run(...args);
            return { success: true, meta: { changes: this.changes() - before } };
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
  scalar(sql: string, ...values: Array<string | number | null>) {
    return this.raw.prepare(sql).get(...values) as Record<string, any>;
  }
  private changes(): number {
    return Number((this.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  }
}

/** The Worker's env for intake and the agent host API, with the producer switch as given. */
function workerEnv(db: SqliteD1, vars: Record<string, string> = { AGENT_INBOUND_FROM: ON }) {
  return {
    DB: db,
    APP_TENANT_ID: TENANT,
    AGENT_HOST_TOKEN: TOKEN, PRIVACY_LEDGER: emptyAgentPrivacyLedger(),
    DEDUP_WINDOW_HOURS: "72",
    OWNER_ALERT_EMAIL: "owner@example.invalid",
    RAW: { put: async () => {} },
    JN_QUEUE: { send: async () => {} },
    ...vars,
  };
}

/** A website form through the real generic ingest path, with its acknowledgement work settled. */
async function ingest(env: ReturnType<typeof workerEnv>, form: Record<string, unknown>, releaseSmoke = false) {
  const pending: Array<Promise<unknown>> = [];
  const result = await ingestLead(
    env as unknown as Env,
    { waitUntil: (promise) => void pending.push(promise) },
    { source: "website", rawText: JSON.stringify(form), contentType: "application/json", releaseSmoke },
  );
  await Promise.all(pending);
  assert.ok(result.ok, JSON.stringify(result));
  return result.body.envelope_id;
}

function host(env: ReturnType<typeof workerEnv>, path: string, body?: unknown) {
  return handleAgentHostApi(
    new Request(`https://bus.example.invalid/api/v1/agents${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  ).then(async (response) => ({ status: response.status, body: (await response.json()) as any }));
}

function envelopeRow(db: SqliteD1, envelopeId: string): EnvelopeRecord {
  return db.scalar("SELECT * FROM envelopes WHERE envelope_id = ?", envelopeId) as EnvelopeRecord;
}

const inboundSignals = (db: SqliteD1) =>
  db.raw.prepare("SELECT * FROM agent_signals WHERE dedupe_key LIKE 'inbound:%' ORDER BY signal_seq").all() as Array<Record<string, any>>;

/** An envelope as an intake path writes it; tests vary the source, payload and contact. */
function envelope(overrides: Partial<EnvelopeRecord> & { payload?: Record<string, unknown> } = {}): EnvelopeRecord {
  const { payload, ...rest } = overrides;
  return {
    envelope_id: "ow_00000000-0000-4000-8000-000000000001",
    source: "website",
    contact_name: "Avery Example",
    contact_phone: "+15875550142",
    contact_email: "avery@example.invalid",
    job_ref: null,
    payload_json: JSON.stringify(payload ?? {}),
    raw_key: "raw/2026-02-01/ow_00000000-0000-4000-8000-000000000001.json",
    ts: "2026-02-01T10:00:00.000Z",
    status: "pending_jn_push",
    dedup_key: "p:+15875550142",
    dup_of: null,
    attempts: 0,
    last_error: null,
    jn_contact_id: null,
    jn_job_id: null,
    intent_queue: "residential_sales",
    tenant_id: TENANT,
    release_smoke: 0,
    created_at: "2026-02-01T10:00:00.000Z",
    updated_at: "2026-02-01T10:00:00.000Z",
    ...rest,
  };
}

function insertRow(db: SqliteD1, rec: EnvelopeRecord) {
  db.raw
    .prepare(
      `INSERT INTO envelopes (envelope_id, source, contact_name, contact_phone, contact_email, payload_json, raw_key, ts,
         status, dedup_key, created_at, updated_at, tenant_id, release_smoke)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      rec.envelope_id, rec.source, rec.contact_name, rec.contact_phone, rec.contact_email, rec.payload_json, rec.raw_key,
      rec.ts, rec.status, rec.dedup_key, rec.created_at, rec.updated_at, rec.tenant_id ?? TENANT, rec.release_smoke ?? 0,
    );
}

/** A customer of the tenant, created from its own (synthetic) envelope. */
function customer(db: SqliteD1, customerId: string, contact: { email?: string; phone?: string; tenant?: string; source?: string }) {
  const source = contact.source ?? `ow_customer_${customerId}`;
  db.raw
    .prepare("INSERT OR IGNORE INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at, tenant_id) VALUES (?, 'manual', '{}', ?, 'received', ?, ?, ?)")
    .run(source, FROM, FROM, FROM, contact.tenant ?? TENANT);
  db.raw
    .prepare(
      `INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_phone, contact_email, created_at, updated_at)
       VALUES (?, ?, ?, 'Synthetic Customer', ?, ?, ?, ?)`,
    )
    .run(customerId, contact.tenant ?? TENANT, source, contact.phone ?? null, contact.email ?? null, FROM, FROM);
}

const FORM = {
  name: "Avery Example",
  email: "avery@example.invalid",
  phone: "(587) 555-0142",
  brand: "IronWrap",
  service: "metal roofing",
  message: "  Synthetic: please quote a metal re-roof.  ",
  address: "1 Synthetic Way",
  city: "Calgary",
  province: "AB",
  postal_code: "T2P 0A1",
  scope: "house and detached garage",
  timing: "before the first snow",
};

test("an inbound web form reaches the receptionist once, and the proposal from it lands on its lead", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  const db = new SqliteD1();
  const env = workerEnv(db);
  const envelopeId = await ingest(env, FORM);

  // Intake's insert appended it, and the sweep after it adds nothing.
  const [signal, ...others] = inboundSignals(db);
  assert.deepEqual(others, []);
  assert.deepEqual(
    [signal.kind, signal.specialist_id, signal.watch_id, signal.source, signal.subject_aggregate, signal.dedupe_key],
    ["event", "lead_concierge", "new_inbound", "web_form", "lead", `inbound:${envelopeId}`],
  );
  assert.deepEqual(JSON.parse(signal.content_json), {
    envelope_id: envelopeId,
    channel: "web_form",
    brand: "ironwrap",
    received_via: null,
    sender: NO_MATCH,
    has_phone: true,
    has_email: true,
    service: "metal roofing",
    excerpt: "Synthetic: please quote a metal re-roof.",
    form_fields: { address: "1 Synthetic Way, Calgary, AB, T2P 0A1", scope: "house and detached garage", timing: "before the first snow" },
  });
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, new Date().toISOString()), { produced: 0, failed: 0 });
  assert.equal(inboundSignals(db).length, 1);

  // Its subject is the lead the envelope materializes, named before the lead exists.
  const core = await materializeOperatingCore(env as unknown as Env, envelopeRow(db, envelopeId));
  assert.equal(signal.subject_id, core.leadId);
  // The customer this envelope created is never the sender's match.
  assert.deepEqual(await senderMatch(db, TENANT, envelopeRow(db, envelopeId)), NO_MATCH);

  // The host sees it as the Worker wrote it, with no actor.
  const listed = await host(env, "/signals?after=0&limit=20");
  assert.deepEqual(
    listed.body.signals.map((entry: any) => [entry.signal_id, entry.watch_id, entry.source, entry.actor, entry.subject]),
    [[signal.signal_id, "new_inbound", "web_form", null, { aggregate: "lead", id: core.leadId }]],
  );

  // A receptionist run on it reads the signal as untrusted text, and the lead.
  const opened = await host(env, "/runs", { signal_id: signal.signal_id, specialist_id: "lead_concierge", host_run_key: "inbound-e2e-0001" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const facts = new Map(opened.body.context.facts.map((fact: any) => [fact.fact_id, fact]));
  const signalFact = facts.get(`signal/${signal.signal_id}`) as any;
  assert.deepEqual([signalFact.trust, signalFact.data], ["untrusted_text", JSON.parse(signal.content_json)]);
  assert.ok(facts.has(`lead/${core.leadId}`), JSON.stringify([...facts.keys()]));

  // It proposes the lead's facts citing only that signal, and the draft is a fact of the lead.
  const content = signalFact.data;
  const fields = { service: content.service, scope: content.form_fields.scope, address: content.form_fields.address, timing: content.form_fields.timing };
  const step = { action_id: "lead_fact.propose", args: { lead_id: core.leadId, fields }, citations: [{ fact_id: `signal/${signal.signal_id}`, version: 1 }] };
  const proposed = await host(env, `/runs/${opened.body.run_id}/steps`, { ...step, step_key: sha256(canonicalJson(step)) });
  assert.deepEqual([proposed.status, proposed.body.decision, proposed.body.outcome], [200, "drafted", "succeeded"], JSON.stringify(proposed.body));
  const lead = await OBJECT_MODELS.lead.read(db, TENANT, core.leadId);
  assert.ok(lead?.links.some((link) => link.kind === "lead_proposal" && link.id === proposed.body.step_id), JSON.stringify(lead?.links));
  const proposal = await OBJECT_MODELS.lead_proposal.read(db, TENANT, proposed.body.step_id);
  assert.deepEqual([proposal?.data.lead_id, proposal?.data.fields, proposal?.data.source], [core.leadId, fields, `signal/${signal.signal_id}`]);

  // The same sender from another number is recorded as that customer, and nothing is linked.
  const before = db.scalar("SELECT (SELECT COUNT(*) FROM operating_customers) AS customers, (SELECT COUNT(*) FROM operating_leads) AS leads");
  const repeat = await ingest(env, { ...FORM, phone: "(587) 555-0143", message: "Synthetic: one more question." });
  const repeated = inboundSignals(db).find((row) => row.dedupe_key === `inbound:${repeat}`);
  assert.deepEqual(JSON.parse(repeated?.content_json ?? "null").sender, { customer_id: core.customerId, matched_on: "email", conflict: false });
  assert.deepEqual(db.scalar("SELECT (SELECT COUNT(*) FROM operating_customers) AS customers, (SELECT COUNT(*) FROM operating_leads) AS leads"), before);
});

test("intake never fails for a signal: the insert logs it, and the sweep produces it", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logged.push(String(line)));
  const db = new SqliteD1();
  const env = workerEnv(db);
  db.failWhen = (sql) => sql.includes("agent_signals");
  const envelopeId = await ingest(env, FORM);

  assert.equal(envelopeRow(db, envelopeId)?.envelope_id, envelopeId);
  assert.deepEqual(inboundSignals(db), []);
  const entries = logged
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((entry) => entry.at === "agent_inbound");
  assert.deepEqual(entries.map((entry) => [entry.envelope_id, entry.error]), [[envelopeId, "Error: D1_ERROR: synthetic outage"]]);
  // The log names the envelope, never the sender.
  assert.ok(!logged.some((line) => line.includes("avery@example.invalid") || line.includes("5550142")));

  // A sweep that cannot read throws, for the cron to log; one that cannot append counts the
  // envelope as failed; then it produces it, once.
  await assert.rejects(sweepInbound(db, TENANT, FROM, new Date().toISOString()), /synthetic outage/);
  db.failWhen = (sql) => sql.includes("INSERT INTO agent_signals");
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, new Date().toISOString()), { produced: 0, failed: 1 });
  db.failWhen = null;
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, new Date().toISOString()), { produced: 1, failed: 0 });
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, new Date().toISOString()), { produced: 0, failed: 0 });
  assert.deepEqual(inboundSignals(db).map((row) => row.dedupe_key), [`inbound:${envelopeId}`]);
});

test("intake waits on the hook at most two seconds; the sweep produces what that leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logged: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logged.push(String(line)));
  const hung = { prepare: () => ({ bind: () => ({ all: () => new Promise(() => {}), first: () => new Promise(() => {}), run: () => new Promise(() => {}) }) }) };
  const rec = envelope();
  let done = false;
  const hook = inboundAfterInsert({ DB: hung, AGENT_INBOUND_FROM: ON }, TENANT, rec).then(() => (done = true));
  await Promise.resolve();
  t.mock.timers.tick(1_999);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await hook;
  assert.deepEqual(logged.map((line) => JSON.parse(line)), [{ at: "agent_inbound", envelope_id: rec.envelope_id, error: "Error: inbound_hook_timeout" }]);
});

test("the producer is off until AGENT_INBOUND_FROM names an instant, and a release smoke never produces", async () => {
  for (const raw of [undefined, "", "   ", "yes", "2026-10-20", "2026-10-20T15:52:43", "2026-10-20 15:52:43Z", "2026-13-45T15:52:43Z",
    // Dates the calendar lacks are off, never rolled forward to another instant.
    "2026-02-30T00:00:00Z", "2026-11-31T00:00:00Z", "2026-10-20T24:00:00Z", "2026-10-20T23:60:00Z", "2026-10-20T23:59:60Z",
    "2026-10-20T15:52:43+24:00", "2026-10-20T15:52:43-99:99", "2026-10-20T15:52:43+05:60"])
    assert.equal(inboundFrom(raw), null, String(raw));
  assert.equal(inboundFrom("2026-10-20T15:52:43Z"), "2026-10-20T15:52:43.000Z");
  assert.equal(inboundFrom(" 2026-10-20T17:52:43.250+02:00 "), "2026-10-20T15:52:43.250Z");

  // Off, the insert's call reads nothing at all, so no hand-rolled store sees its SQL.
  const touched: string[] = [];
  const untouchable = { prepare: (sql: string) => void touched.push(sql) };
  for (const vars of [{}, { AGENT_INBOUND_FROM: "" }, { AGENT_INBOUND_FROM: "not an instant" }])
    await inboundAfterInsert({ DB: untouchable, ...vars }, TENANT, envelope());
  // On, it reads nothing for a release smoke, an import, a row with no raw body, one with neither a
  // phone nor an email (intake refuses it after the insert), or a row before the instant.
  for (const rec of [
    envelope({ release_smoke: 1 }),
    envelope({ envelope_id: "ow_imp_0123456789abcdef", source: "manual" }),
    envelope({ raw_key: null }),
    envelope({ contact_phone: null, contact_email: null }),
    envelope({ contact_phone: "", contact_email: "" }),
    envelope({ created_at: "2025-12-31T23:59:59.999Z" }),
  ])
    await inboundAfterInsert({ DB: untouchable, AGENT_INBOUND_FROM: ON }, TENANT, rec);
  assert.deepEqual(touched, []);

  // Through real intake: no switch, no signal; and a release smoke under the switch, none either.
  const db = new SqliteD1();
  await ingest(workerEnv(db, {}), FORM);
  await ingest(workerEnv(db, { AGENT_INBOUND_FROM: "" }), { ...FORM, email: "second@example.invalid", phone: "(587) 555-0144" });
  await ingest(workerEnv(db), { ...FORM, email: "smoke@example.invalid", phone: "(587) 555-0145" }, true);
  assert.equal(db.scalar("SELECT COUNT(*) AS n FROM envelopes").n, 3);
  assert.deepEqual(inboundSignals(db), []);
});

test("each intake path's envelope maps to its channel, and the channel set is exactly those", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["website", {}, "web_form"],
    ["website", { instant_estimate: true }, "instant_estimate"],
    ["website", { instant_estimate: "true" }, "web_form"],
    ["phone", {}, "phone"],
    ["phone", { provider: "newo" }, "newo_call"],
    ["phone", { provider: "twilio" }, "phone"],
    ["manual", {}, "office"],
    ["manual", { office_capture: { intake_source: "walk_in" } }, "walk_in"],
    ["manual", { office_capture: { intake_source: "referral" } }, "office"],
    ["gbp", {}, "gbp"],
    ["ad", {}, "ad"],
    ["referral", {}, "referral"],
  ];
  const channels = new Set<string>();
  for (const [source, payload, channel] of cases) {
    const signal = await inboundSignal(TENANT, envelope({ source, payload }), NO_MATCH);
    assert.deepEqual([signal?.source, signal?.content.channel], [channel, channel], `${source} ${JSON.stringify(payload)}`);
    channels.add(channel);
  }
  assert.deepEqual([...INBOUND_CHANNELS].sort(), [...channels].sort());
  // The eval replay applies the same inbound-only rule (agent-host/src/replay/case-run.ts).
  assert.deepEqual([...REPLAY_INBOUND_CHANNELS].sort(), [...INBOUND_CHANNELS].sort());
  assert.deepEqual([...REPLAY_INBOUND_ONLY].sort(), [...INBOUND_ONLY].sort());
  // A source no intake path writes is not inbound.
  assert.equal(await inboundSignal(TENANT, envelope({ source: "quickbooks" }), NO_MATCH), null);
  // The signal is about the lead the operating core derives for the envelope, for its tenant.
  const signal = await inboundSignal(TENANT, envelope(), NO_MATCH);
  assert.deepEqual(signal?.subject, { aggregate: "lead", id: `lead:${TENANT}:${sha256(`lead\u0000${TENANT}\u0000${envelope().envelope_id}`)}` });
  assert.equal(signal?.dedupe_key, `inbound:${envelope().envelope_id}`);
});

test("the content holds exactly its keys and names nobody, and caps what the sender wrote", async () => {
  const contentOf = async (payload: Record<string, unknown>, overrides: Partial<EnvelopeRecord> = {}) =>
    (await inboundSignal(TENANT, envelope({ payload, ...overrides }), NO_MATCH))!.content;
  // received_via stays null whatever the payload says, until intake records it.
  const content = await contentOf({ ...FORM, customer: "Avery Example", received_via: "sales@example.invalid" });
  assert.deepEqual(Object.keys(content).sort(), ["brand", "channel", "envelope_id", "excerpt", "form_fields", "has_email", "has_phone", "received_via", "sender", "service"]);
  assert.deepEqual(Object.keys(content.sender).sort(), ["conflict", "customer_id", "matched_on"]);
  assert.deepEqual(Object.keys(content.form_fields).sort(), ["address", "scope", "timing"]);
  const json = JSON.stringify(content);
  for (const detail of ["Avery", "avery@example.invalid", "5550142", "555-0142"]) assert.ok(!json.includes(detail), detail);
  assert.equal(content.received_via, null);

  // Brand: the payload's, else the public estimator's, as the operating core reads a brand.
  const brand = async (payload: Record<string, unknown>) => (await contentOf(payload)).brand;
  assert.deepEqual(
    await Promise.all([
      brand({ brand: "ironwrap" }),
      brand({ brand: " IRoof " }),
      brand({ brand: "acme", public_estimator: { brand: "iroof" } }),
      brand({ public_estimator: { brand: "ironwrap" } }),
      brand({ brand: "acme", public_estimator: { brand: "acme" } }),
      brand({ brand: 7 }),
      brand({}),
    ]),
    ["ironwrap", "iroof", "iroof", "ironwrap", null, null, null],
  );

  // The excerpt: the message, else a Newo call's hand-off summary, trimmed and at most 1000
  // characters as the argument schemas count them.
  const excerpt = async (payload: Record<string, unknown>) => (await contentOf(payload)).excerpt;
  assert.equal(await excerpt({ message: "   ", handoff_summary: " Caller wants a quote. " }), "Caller wants a quote.");
  assert.equal(await excerpt({}), null);
  assert.equal(await excerpt({ message: "x".repeat(1500) }), "x".repeat(1000));
  const astral = (await excerpt({ message: "\u{1F3E0}".repeat(1200) })) ?? "";
  assert.deepEqual([[...astral].length, astral.length], [1000, 2000]);

  // The form fields, from the keys each intake path writes, blanks skipped and each capped.
  const fields = async (payload: Record<string, unknown>) => (await contentOf(payload)).form_fields;
  assert.deepEqual(await fields({ address: " 1 Synthetic Way ", city: "", province: "AB", postal_code: null }), { address: "1 Synthetic Way, AB", scope: null, timing: null });
  assert.deepEqual((await fields({ address: "2 Estimator Way", city: "Calgary", state_text: "AB", zip: "T2P 0A2" })).address, "2 Estimator Way, Calgary, AB, T2P 0A2");
  assert.deepEqual((await fields({ address_line1: "3 Newo Way", city: "Airdrie", province: "AB", postal_code: "T4B 0A3" })).address, "3 Newo Way, Airdrie, AB, T4B 0A3");
  assert.deepEqual((await fields({ address1: "4 Webhook Way", city: "Calgary", state: "AB", postal: "T2P 0A4" })).address, "4 Webhook Way, Calgary, AB, T2P 0A4");
  assert.deepEqual(await fields({ address: "", city: " ", province: 5 }), { address: null, scope: null, timing: null });
  assert.equal((await contentOf({ service_intent: " Metal roof " })).service, "Metal roof");
  assert.equal((await fields({ address: "a".repeat(595), city: "Calgary" })).address, `${"a".repeat(595)}, Cal`);
  assert.deepEqual(await fields({ timing: "", preferred_time: "mornings", timeline: "spring" }), { address: null, scope: null, timing: "mornings" });
  assert.equal((await fields({ timeline: "spring" })).timing, "spring");
  assert.equal((await fields({ timing: "t".repeat(700) })).timing, "t".repeat(600));
  assert.equal((await fields({ scope: null, project_scope: "  ", public_estimator: { scope: "full re-roof" } })).scope, "full re-roof");
  assert.equal((await fields({ scope: "s".repeat(2500), project_scope: "other" })).scope, "s".repeat(2000));
  assert.equal((await contentOf({ service: "v".repeat(250) })).service, "v".repeat(200));

  // What the contact gives, and a payload that does not parse still makes the signal.
  assert.deepEqual(
    await contentOf({}, { contact_phone: null, contact_email: "  " }).then((value) => [value.has_phone, value.has_email]),
    [false, false],
  );
  assert.deepEqual(await contentOf({}, { payload_json: "not json" }).then((value) => [value.channel, value.service, value.form_fields]), [
    "web_form",
    null,
    { address: null, scope: null, timing: null },
  ]);
});

test("the sender is matched exactly, by email, phone or both, never to its own customer, and a split is a conflict", async () => {
  const db = new SqliteD1();
  customer(db, "customer:ironwrap:email-only", { email: "email.only@example.invalid" });
  customer(db, "customer:ironwrap:phone-only", { phone: "+15875550150" });
  customer(db, "customer:ironwrap:both", { email: "both@example.invalid", phone: "+15875550151" });
  customer(db, "customer:ironwrap:other-tenant", { email: "elsewhere@example.invalid", tenant: "northside" });
  const sender = (email: string | null, phone: string | null, envelopeId = "ow_00000000-0000-4000-8000-000000000009") =>
    senderMatch(db, TENANT, envelope({ envelope_id: envelopeId, contact_email: email, contact_phone: phone }));

  assert.deepEqual(await sender("email.only@example.invalid", "+15875550199"), { customer_id: "customer:ironwrap:email-only", matched_on: "email", conflict: false });
  assert.deepEqual(await sender(" Email.Only@Example.Invalid ", null), { customer_id: "customer:ironwrap:email-only", matched_on: "email", conflict: false });
  assert.deepEqual(await sender("new@example.invalid", "(587) 555-0150"), { customer_id: "customer:ironwrap:phone-only", matched_on: "phone", conflict: false });
  // The operating core keeps a phone's digits with the sender's own plus; core's normaliser reads
  // each stored form of the same number as the sender's.
  customer(db, "customer:ironwrap:bare", { phone: "5875550160" });
  customer(db, "customer:ironwrap:eleven", { phone: "15875550161" });
  assert.equal((await sender(null, "+1 587 555 0160")).customer_id, "customer:ironwrap:bare");
  assert.equal((await sender(null, "587-555-0161")).customer_id, "customer:ironwrap:eleven");
  assert.equal((await sender(null, "+44 20 7946 0160")).customer_id, null);
  customer(db, "customer:ironwrap:bare-twin", { phone: "+15875550160" });
  assert.deepEqual(await sender(null, "587 555 0160"), { customer_id: null, matched_on: null, conflict: true });
  assert.deepEqual(await sender("both@example.invalid", "+15875550151"), { customer_id: "customer:ironwrap:both", matched_on: "email_and_phone", conflict: false });
  assert.deepEqual(await sender("email.only@example.invalid", "+15875550150"), { customer_id: null, matched_on: null, conflict: true });
  assert.deepEqual(await sender("elsewhere@example.invalid", null), NO_MATCH);
  assert.deepEqual(await sender(null, null), NO_MATCH);
  // The customer an envelope created is not the sender's match on that envelope.
  customer(db, "customer:ironwrap:own", { email: "own@example.invalid", phone: "+15875550152", source: "ow_00000000-0000-4000-8000-000000000010" });
  assert.deepEqual(await sender("own@example.invalid", "+15875550152", "ow_00000000-0000-4000-8000-000000000010"), NO_MATCH);
  assert.deepEqual(await sender("own@example.invalid", null), { customer_id: "customer:ironwrap:own", matched_on: "email", conflict: false });

  // produceInbound records the match in the signal, once.
  const rec = envelope({ envelope_id: "ow_00000000-0000-4000-8000-000000000011", contact_email: "both@example.invalid", contact_phone: "+15875550151" });
  insertRow(db, rec);
  const first = await produceInbound(db, TENANT, rec, "2026-02-01T10:00:01.000Z");
  const again = await produceInbound(db, TENANT, rec, "2026-02-01T10:05:00.000Z");
  assert.deepEqual([first?.created, again?.created, again?.signal_id], [true, false, first?.signal_id]);
  assert.deepEqual(JSON.parse(inboundSignals(db)[0].content_json).sender, { customer_id: "customer:ironwrap:both", matched_on: "email_and_phone", conflict: false });
});

test("the sweep takes inbound envelopes from the switch's instant on, oldest first, and skips the rest", async () => {
  const db = new SqliteD1();
  const id = (n: number) => `ow_00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
  const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const rows = {
    atInstant: envelope({ envelope_id: id(1), created_at: FROM }),
    first: envelope({ envelope_id: id(2), created_at: at(1), source: "phone", payload: { provider: "newo" } }),
    second: envelope({ envelope_id: id(3), created_at: at(2), source: "manual", payload: { office_capture: { intake_source: "walk_in" } } }),
    third: envelope({ envelope_id: id(4), created_at: at(3), source: "gbp" }),
    smoke: envelope({ envelope_id: id(5), created_at: at(0), release_smoke: 1 }),
    // An import never is, even with a raw body; a row without one never is either.
    imported: envelope({ envelope_id: `ow_imp_${"a".repeat(64)}`, created_at: at(0), source: "manual" }),
    rawless: envelope({ envelope_id: id(6), created_at: at(0), raw_key: null }),
    before: envelope({ envelope_id: id(7), created_at: "2025-12-31T23:59:59.999Z" }),
    elsewhere: envelope({ envelope_id: id(8), created_at: at(0), tenant_id: "northside" }),
    unknown: envelope({ envelope_id: id(9), created_at: at(0), source: "quickbooks" }),
    contactless: envelope({ envelope_id: id(12), created_at: at(0), contact_phone: null, contact_email: null }),
  };
  for (const rec of Object.values(rows)) insertRow(db, rec);
  const swept = () => inboundSignals(db).map((row) => row.dedupe_key.slice("inbound:".length));
  const now = "2026-01-01T11:00:00.000Z";

  assert.deepEqual(await sweepInbound(db, TENANT, FROM, now, 2), { produced: 2, failed: 0 });
  assert.deepEqual(swept(), [rows.atInstant.envelope_id, rows.first.envelope_id]);
  // One that fails is counted; the others still run, and it comes back on the next tick.
  db.failWhen = (sql, values) => sql.includes("INSERT INTO agent_signals") && values.includes(`inbound:${rows.second.envelope_id}`);
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, now, 2), { produced: 1, failed: 1 });
  db.failWhen = null;
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, now), { produced: 1, failed: 0 });
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, now), { produced: 0, failed: 0 });
  assert.deepEqual(swept(), [rows.atInstant.envelope_id, rows.first.envelope_id, rows.third.envelope_id, rows.second.envelope_id]);
  assert.deepEqual(inboundSignals(db).map((row) => row.source), ["web_form", "newo_call", "gbp", "walk_in"]);
  // Each tick reads only the last two days: an envelope every tick missed for longer gets none.
  const later = "2026-01-05T00:00:00.000Z";
  const stale = envelope({ envelope_id: id(10), created_at: new Date(Date.parse(later) - SWEEP_WINDOW_MS - 1).toISOString() });
  const recent = envelope({ envelope_id: id(11), created_at: new Date(Date.parse(later) - SWEEP_WINDOW_MS).toISOString() });
  insertRow(db, stale);
  insertRow(db, recent);
  assert.deepEqual(await sweepInbound(db, TENANT, FROM, later), { produced: 1, failed: 0 });
  assert.deepEqual(swept().slice(-1), [recent.envelope_id]);
});

test("the five-minute cron sweeps a missed inbound signal in, and only while the switch is on", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    throw new Error(`unexpected fetch ${String(input)}`);
  });
  const db = new SqliteD1();
  const cron = async (vars: Record<string, string>) => {
    const pending: Array<Promise<unknown>> = [];
    await worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} } as never,
      {
        ...workerEnv(db, vars),
        ADMIN_TOKEN: "admin-secret",
        INGEST_TOKEN: "ingest-secret",
        BACKUP_ALERT_EMAIL: "backup@example.invalid",
        FROM_EMAIL: "bus@example.invalid",
        JOBNIMBUS_ENABLED: "false",
        ERPNEXT_ENABLED: "false",
        STUCK_THRESHOLD_MIN: "15",
        MEASUREMENT_QUEUE: { send: async () => {} },
        JN_QUEUE: { send: async () => {}, sendBatch: async () => {} },
      } as never,
      { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException() {} } as never,
    );
    assert.equal(pending.length, 1);
    await Promise.all(pending);
  };
  // An envelope whose insert appended no signal, as when D1 failed right after the row.
  const missed = envelope({ created_at: new Date().toISOString() });
  insertRow(db, missed);
  await cron({ AGENT_INBOUND_FROM: "" });
  assert.deepEqual(inboundSignals(db), []);
  await cron({ AGENT_INBOUND_FROM: ON });
  await cron({ AGENT_INBOUND_FROM: ON });
  assert.deepEqual(inboundSignals(db).map((row) => row.dedupe_key), [`inbound:${missed.envelope_id}`]);
});

test("the sender match and the sweep read by index, since intake and every tick pay for them", async () => {
  const db = new SqliteD1();
  await senderMatch(db, TENANT, envelope());
  await sweepInbound(db, TENANT, FROM, "2026-02-01T11:00:00.000Z");
  const plan = (needle: string) => {
    const sql = db.seen.find((entry) => entry.includes(needle));
    assert.ok(sql, needle);
    return (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  };
  assert.match(plan("FROM operating_customers"), /\(tenant_id=\? AND contact_email=\?\).*UNION.*\(tenant_id=\? AND contact_phone=\?\)/);
  assert.match(plan("FROM envelopes e"), /SEARCH e USING INDEX idx_env_day \(created_at>\?\)/);
  assert.match(plan("FROM envelopes e"), /SEARCH s USING COVERING INDEX \S+ \(tenant_id=\? AND dedupe_key=\?\)/);
});
