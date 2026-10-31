import { emptyAgentPrivacyLedger } from "./agents-privacy-fixtures.ts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAgentHostApi } from "../src/agents/api.ts";
import { appendSignal, openRun, proposeStep, type BoundStatement } from "../src/agents/store.ts";
import { subjectsFacts, SNAPSHOT_LIMITS, type ObjectModel } from "../src/agents/memory.ts";
import { DELIVERY_RETRY, EXCEPTION_REMINDER_MS, ownerReports, periodKey, retryReportDeliveries, runWatches, safeTimeZone, watchStatus, WATCH_CONDITIONS } from "../src/agents/watches.ts";

const TENANT = "ironwrap";
const TOKEN = ["synthetic", "agent", "host", "token", "0001"].join("-");
const TZ = "America/Edmonton";

class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => /^\d+.*\.sql$/.test(name)).sort())
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => {
        const args = values as Array<string | number | null>;
        return {
          first: async <T>() => (this.raw.prepare(sql).get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: this.raw.prepare(sql).all(...args) as T[] }),
          run: async () => {
            const count = () => Number((this.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
            const before = count();
            this.raw.prepare(sql).run(...args);
            return { meta: { changes: count() - before } };
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
}

function seedLead(db: SqliteD1, id: string, at: string) {
  db.raw.prepare("INSERT OR IGNORE INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at) VALUES (?, 'website', '{}', ?, 'received', ?, ?)").run(`ow_${id}`, at, at, at);
  db.raw
    .prepare("INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, created_at, updated_at) VALUES (?, ?, ?, 'website', 'Synthetic Lead', ?, ?)")
    .run(id, TENANT, `ow_${id}`, at, at);
}

const firings = (db: SqliteD1, watch: string) =>
  db.raw.prepare("SELECT period_key, holds, signal_id FROM agent_watch_firings WHERE watch_id = ? ORDER BY fired_at, rowid").all(watch).map((row) => ({ ...row }));

test("sub-day watches use fixed slots; daily, weekly and monthly ones wait for the tenant's local time", () => {
  assert.equal(periodKey("PT15M", Date.parse("2026-03-02T10:07:00Z"), TZ), "2026-03-02T10:00:00.000Z");
  assert.equal(periodKey("PT1H", Date.parse("2026-03-02T10:59:59Z"), TZ), "2026-03-02T10:00:00.000Z");
  // 13:30 UTC is 06:30 in Edmonton (UTC-7 in early March): before the 07:00 brief.
  assert.equal(periodKey("P1D", Date.parse("2026-03-02T13:30:00Z"), TZ), null);
  assert.equal(periodKey("P1D", Date.parse("2026-03-02T14:05:00Z"), TZ), "2026-03-02");
  // Just after local midnight it is already the next local day, still before 07:00.
  assert.equal(periodKey("P1D", Date.parse("2026-03-03T07:30:00Z"), TZ), null);
  // Monday 2 March 2026 08:10 local is due; the same Monday 07:50 is not; Thursday is the same week.
  assert.equal(periodKey("P7D", Date.parse("2026-03-02T15:10:00Z"), TZ), "2026-03-02");
  assert.equal(periodKey("P7D", Date.parse("2026-03-02T14:50:00Z"), TZ), null);
  assert.equal(periodKey("P7D", Date.parse("2026-03-05T20:00:00Z"), TZ), "2026-03-02");
  assert.equal(periodKey("P1M", Date.parse("2026-03-01T14:30:00Z"), TZ), "2026-03");
  assert.equal(periodKey("P2W", Date.parse("2026-03-01T14:30:00Z"), TZ), null);
});

test("a due watch fires once per period: a held condition appends a signal, an empty one is still recorded", async () => {
  const db = new SqliteD1();
  const t0 = "2026-03-02T10:01:00.000Z";
  seedLead(db, "lead_watch_0001", "2026-03-02T09:55:00.000Z");
  const first = await runWatches(db, TENANT, t0, TZ);
  assert.ok(first.fired.includes("new_leads"), JSON.stringify(first));
  assert.deepEqual(first.failed, []);
  // The same slot never fires twice, whatever the cron does.
  await runWatches(db, TENANT, "2026-03-02T10:09:00.000Z", TZ);
  assert.equal(firings(db, "new_leads").length, 1);
  const signal = db.raw.prepare("SELECT * FROM agent_signals WHERE watch_id = 'new_leads'").get() as Record<string, string>;
  assert.deepEqual([signal.kind, signal.specialist_id, signal.source], ["watch", "lead_concierge", "watch_scheduler"]);
  assert.deepEqual(JSON.parse(signal.content_json).objects, [{ aggregate: "lead", id: "lead_watch_0001" }]);
  // The next slot has nothing new: recorded empty, no signal, no model run.
  const next = await runWatches(db, TENANT, "2026-03-02T10:16:00.000Z", TZ);
  assert.ok(next.empty.includes("new_leads"));
  assert.deepEqual(firings(db, "new_leads").map((row) => row.holds), [1, 0]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM agent_signals WHERE watch_id = 'new_leads'").get()!.n, 1);
  // Append-only.
  assert.throws(() => db.raw.exec("DELETE FROM agent_watch_firings"), /append_only/);
});

test("the daily brief and weekly review fire at their local time even on a quiet day; unregistered watches never fire", async () => {
  const db = new SqliteD1();
  assert.deepEqual((await runWatches(db, TENANT, "2026-03-02T13:30:00.000Z", TZ)).fired.filter((id) => id === "daily_owner_brief"), []);
  const morning = await runWatches(db, TENANT, "2026-03-02T15:10:00.000Z", TZ);
  assert.ok(morning.fired.includes("daily_owner_brief") && morning.fired.includes("weekly_review"), JSON.stringify(morning));
  const status = await watchStatus(db, TENANT);
  const registered = status.filter((watch) => watch.condition === "registered").map((watch) => watch.watch_id).sort();
  assert.deepEqual(registered, Object.keys(WATCH_CONDITIONS).sort());
  assert.equal(status.find((watch) => watch.watch_id === "quote_expiring")?.last_firing, null);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM agent_watch_firings WHERE watch_id = 'quote_expiring'").get()!.n, 0);
});

test("a watch run starts from every object its condition named, and the scheduler's own text is owned", async () => {
  const db = new SqliteD1();
  seedLead(db, "lead_watch_0001", "2026-03-02T09:55:00.000Z");
  seedLead(db, "lead_watch_0002", "2026-03-02T09:56:00.000Z");
  await runWatches(db, TENANT, "2026-03-02T10:01:00.000Z", TZ);
  const signal = db.raw.prepare("SELECT signal_id FROM agent_signals WHERE watch_id = 'new_leads'").get() as { signal_id: string };
  const opened = await openRun(db, TENANT, { signal_id: signal.signal_id, specialist_id: "lead_concierge", host_run_key: "watch-run-1" }, "2026-03-02T10:02:00.000Z");
  assert.ok(!("error" in opened), JSON.stringify(opened));
  const ids = opened.context.facts.map((fact) => fact.fact_id);
  assert.ok(ids.includes("lead/lead_watch_0001") && ids.includes("lead/lead_watch_0002"), ids.join(" "));
  assert.equal(opened.context.facts[0].trust, "owned");
});

test("a completed owner report reaches the owner, and a pipeline report only when a decision waits", async () => {
  const db = new SqliteD1();
  const env = { DB: db, AGENT_HOST_TOKEN: TOKEN, PRIVACY_LEDGER: emptyAgentPrivacyLedger(), APP_TENANT_ID: TENANT } as never;
  const sent: Array<[string, string]> = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handleAgentHostApi(
      new Request(`https://bus.example.invalid${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      () => Date.parse("2026-03-02T16:00:00.000Z"),
      async (subject, text) => void sent.push([subject, text]),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  await runWatches(db, TENANT, "2026-03-02T15:10:00.000Z", TZ);
  const close = (final_text: string) => ({
    status: "ok", reason: null, detail: null,
    output: { decision: "propose", escalate_to: null, reason_code: null, reason: "Composed.", receipts: [], drafts: [], final_text },
    model: { provider: "codex", model: "gpt-6.1-sol", models_used: ["gpt-6.1-sol"], auth_mode: "chatgpt", tier: "routine" },
    hashes: { system: "a".repeat(64), prompt: "b".repeat(64), schema: "c".repeat(64) },
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, cost_usd: 0.01, attempts: 1, duration_ms: 10, tool_calls: [],
  });
  const runFor = async (watch: string, key: string) => {
    const signal = db.raw.prepare("SELECT signal_id, specialist_id FROM agent_signals WHERE watch_id = ?").get(watch) as { signal_id: string; specialist_id: string };
    return (await call("POST", "/api/v1/agents/runs", { signal_id: signal.signal_id, specialist_id: signal.specialist_id, host_run_key: key })).body.run_id as string;
  };
  const brief = await runFor("daily_owner_brief", "brief-run-0001");
  assert.equal((await call("POST", `/api/v1/agents/runs/${brief}/close`, close("Synthetic brief: nothing needs you."))).status, 200);
  assert.deepEqual(sent, [["Daily owner brief", "Synthetic brief: nothing needs you."]]);
  // Pipeline fires on the hourly slot; with no decision waiting it stays in the app only.
  seedLead(db, "lead_watch_0003", "2026-03-02T15:20:00.000Z");
  db.raw.exec(`INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, created_at, updated_at) VALUES ('cus_watch_1', '${TENANT}', 'ow_lead_watch_0003', 'Synthetic', 'watch@example.invalid', 'active', '2026-03-02T15:20:00.000Z', '2026-03-02T15:20:00.000Z')`);
  db.raw.exec(`INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at) VALUES ('job_watch_1', '${TENANT}', 'lead_watch_0003', 'cus_watch_1', 'ow_lead_watch_0003', 'IW-W-1', 'Roofing', 'qualified', '2026-03-02T15:20:00.000Z', '2026-03-02T15:20:00.000Z')`);
  await runWatches(db, TENANT, "2026-03-02T16:01:00.000Z", TZ);
  const pipeline = await runFor("pipeline", "pipeline-run-0001");
  assert.equal((await call("POST", `/api/v1/agents/runs/${pipeline}/close`, close("Synthetic pipeline."))).status, 200);
  assert.equal(sent.length, 1);
});

// --- Slice 5 review regressions ---

test("a weekly period never shifts at a daylight-saving change", () => {
  // Denver keeps the Mountain daylight-saving rules; Edmonton left them in tzdata 2026c
  // (permanent UTC-6), so a zone that still changes its clocks pins the behaviour.
  const DST = "America/Denver";
  // Sunday 1 November 2026, 23:30 in Denver, after clocks fell back (06:30 UTC on Monday).
  assert.equal(periodKey("P7D", Date.parse("2026-11-02T06:30:00Z"), DST), "2026-10-26");
  assert.equal(periodKey("P7D", Date.parse("2026-11-02T15:30:00Z"), DST), "2026-11-02");
  // Spring forward: Monday 9 March 2026 08:30 local is 14:30 UTC.
  assert.equal(periodKey("P7D", Date.parse("2026-03-09T14:30:00Z"), DST), "2026-03-09");
  assert.equal(periodKey("P1D", Date.parse("2026-11-01T14:00:00Z"), DST), "2026-11-01");
  // A missed first of the month catches up on a later day; day 1 waits for its time.
  assert.equal(periodKey("P1M", Date.parse("2026-03-01T13:00:00Z"), TZ), null);
  assert.equal(periodKey("P1M", Date.parse("2026-03-02T09:00:00Z"), TZ), "2026-03");
});

test("an invalid tenant time zone falls back, and one failing watch never stops the others", async () => {
  assert.equal(safeTimeZone("Canada/Foo"), "America/Edmonton");
  assert.equal(safeTimeZone("Europe/Sofia"), "Europe/Sofia");
  const db = new SqliteD1();
  seedLead(db, "lead_tz_0001", "2026-03-02T15:55:00.000Z");
  const broken = { ...WATCH_CONDITIONS, pipeline: { version: "x", evaluate: async () => { throw new Error("D1_ERROR: synthetic failure"); } } };
  const result = await runWatches(db, TENANT, "2026-03-02T16:01:00.000Z", "Canada/Foo", broken);
  assert.equal(result.time_zone, "America/Edmonton");
  assert.ok(result.fired.includes("new_leads"));
  assert.deepEqual(result.failed.map((entry) => entry.watch_id), ["pipeline"]);
  assert.match(result.failed[0].error, /synthetic failure/);
});

test("a watch looks back to its last firing, not one cadence", async () => {
  const db = new SqliteD1();
  seedLead(db, "lead_since_0001", "2026-03-02T09:55:00.000Z");
  await runWatches(db, TENANT, "2026-03-02T10:01:00.000Z", TZ);
  seedLead(db, "lead_since_0002", "2026-03-02T10:10:00.000Z");
  // The cron was away for three slots: the 10:45 firing still covers everything since 10:01.
  assert.ok((await runWatches(db, TENANT, "2026-03-02T10:46:00.000Z", TZ)).fired.includes("new_leads"));
  const latest = db.raw.prepare("SELECT content_json FROM agent_signals WHERE watch_id = 'new_leads' ORDER BY received_at DESC LIMIT 1").get() as { content_json: string };
  assert.deepEqual(JSON.parse(latest.content_json).objects, [{ aggregate: "lead", id: "lead_since_0002" }]);
});

test("an unacknowledged exception is raised once and again only after the reminder cooldown", async () => {
  const db = new SqliteD1();
  db.raw
    .prepare(`INSERT INTO agent_exceptions (exception_id, tenant_id, source, reason_code, urgency, reviewer_role, summary, dedupe_key, opened_at) VALUES ('exc_watch_1', ?, 'host_alert', 'provider_unavailable', 'immediate', 'owner', 'Synthetic', 'synthetic:1', '2026-03-02T09:00:00.000Z')`)
    .run(TENANT);
  const holds = async (at: string) => (await runWatches(db, TENANT, at, TZ)).fired.includes("unacknowledged_exception");
  assert.equal(await holds("2026-03-02T10:01:00.000Z"), true);
  assert.equal(await holds("2026-03-02T10:06:00.000Z"), false);
  assert.equal(await holds("2026-03-02T12:01:00.000Z"), false);
  assert.equal(await holds(new Date(Date.parse("2026-03-02T10:01:00.000Z") + EXCEPTION_REMINDER_MS + 5 * 60_000).toISOString()), true);
});

test("the pipeline fires on a new waiting decision, not on one that was already waiting", async () => {
  const db = new SqliteD1();
  const signal = await appendSignal(db, TENANT, { kind: "event", specialist_id: "lead_concierge", watch_id: null, source: "test", subject: null, content: { text: "Synthetic" }, dedupe_key: "pipe:1" }, "2026-03-02T10:00:00.000Z");
  assert.ok(!("error" in signal));
  const opened = await openRun(db, TENANT, { signal_id: signal.signal_id, specialist_id: "lead_concierge", host_run_key: "pipe-run-1" }, "2026-03-02T10:00:00.000Z");
  assert.ok(!("error" in opened));
  const step = await proposeStep(db, TENANT, opened.run, { action_id: "note.add", args: { object: { aggregate: "lead", id: "synthetic-lead", version: 1 }, text: "Synthetic note." }, citations: [{ fact_id: `signal/${signal.signal_id}`, version: 1 }], step_key: "p".repeat(64) }, Date.parse("2026-03-02T10:05:00.000Z"));
  assert.ok(!("error" in step) && !("shadow" in step) && step.outcome === null, JSON.stringify(step));
  assert.ok((await runWatches(db, TENANT, "2026-03-02T11:01:00.000Z", TZ)).fired.includes("pipeline"));
  assert.ok((await runWatches(db, TENANT, "2026-03-02T12:01:00.000Z", TZ)).empty.includes("pipeline"));
});

test("several subjects share one snapshot, each whole or named as omitted", async () => {
  const db = new SqliteD1();
  const nine = (id: string) => ({ data: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, `${id}-${index}`])), links: [] });
  const models: Record<string, ObjectModel> = {
    lead: { views: [{ permission: "sales:read", pointers: Array.from({ length: 9 }, (_, index) => `/p${index}`) }], read: async (_db, _tenant, id) => nine(id) },
  };
  const subjects = ["a", "b", "c"].map((id) => ({ aggregate: "lead", id }));
  const { facts, omitted } = await subjectsFacts(db, models, TENANT, "lead_concierge", subjects, "2026-03-02T10:00:00.000Z");
  assert.equal(facts.length, 18);
  assert.ok(facts.length <= SNAPSHOT_LIMITS.facts);
  assert.deepEqual(omitted, [{ fact_id: "lead/c", reason: "limit_reached" }]);
});

test("only the scheduler's watch signals are owned and name subjects; others stay untrusted", async () => {
  const db = new SqliteD1();
  seedLead(db, "lead_trust_0001", "2026-03-02T09:55:00.000Z");
  const forged = await appendSignal(db, TENANT, { kind: "watch", specialist_id: "lead_concierge", watch_id: "new_leads", source: "someone_else", subject: null, content: { objects: [{ aggregate: "lead", id: "lead_trust_0001" }] }, dedupe_key: "forged:1" }, "2026-03-02T10:00:00.000Z");
  assert.ok(!("error" in forged));
  const opened = await openRun(db, TENANT, { signal_id: forged.signal_id, specialist_id: "lead_concierge", host_run_key: "forged-run-1" }, "2026-03-02T10:00:00.000Z");
  assert.ok(!("error" in opened));
  assert.equal(opened.context.facts[0].trust, "untrusted_text");
  assert.equal(opened.context.facts.length, 1);
});

test("report delivery: new inquiries and waiting pipelines are sent, failures are recorded and retried once, nothing else is sent", async () => {
  const db = new SqliteD1();
  const env = { DB: db, AGENT_HOST_TOKEN: TOKEN, PRIVACY_LEDGER: emptyAgentPrivacyLedger(), APP_TENANT_ID: TENANT } as never;
  const sent: string[] = [];
  let failNext = false;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handleAgentHostApi(
      new Request(`https://bus.example.invalid${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      () => Date.parse("2026-03-02T16:00:00.000Z"),
      async (subject) => {
        if (failNext) {
          failNext = false;
          throw new Error("synthetic mail outage");
        }
        sent.push(subject);
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const close = (status: "ok" | "abstained", final_text = "Synthetic report.") => ({
    status, reason: status === "ok" ? null : "provider_error", detail: null,
    output: status === "ok" ? { decision: "propose", escalate_to: null, reason_code: null, reason: "Composed.", receipts: [], drafts: [], final_text } : null,
    model: status === "ok" ? { provider: "codex", model: "gpt-6.1-sol", models_used: ["gpt-6.1-sol"], auth_mode: "chatgpt", tier: "routine" } : null,
    hashes: status === "ok" ? { system: "a".repeat(64), prompt: "b".repeat(64), schema: "c".repeat(64) } : null,
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, cost_usd: 0.01, attempts: 1, duration_ms: 10, tool_calls: [],
  });
  const open = async (signalId: string, specialist: string, key: string) => (await call("POST", "/api/v1/agents/runs", { signal_id: signalId, specialist_id: specialist, host_run_key: key })).body.run_id as string;
  seedLead(db, "lead_deliver_0001", "2026-03-02T15:55:00.000Z");
  await runWatches(db, TENANT, "2026-03-02T16:01:00.000Z", TZ);
  const leadsSignal = (db.raw.prepare("SELECT signal_id FROM agent_signals WHERE watch_id = 'new_leads'").get() as { signal_id: string }).signal_id;
  // A failed send is recorded; the host's exact retry sends it once.
  const leadsRun = await open(leadsSignal, "lead_concierge", "leads-run-0001");
  failNext = true;
  assert.equal((await call("POST", `/api/v1/agents/runs/${leadsRun}/close`, close("ok"))).status, 200);
  assert.deepEqual(sent, []);
  assert.equal((await call("POST", `/api/v1/agents/runs/${leadsRun}/close`, close("ok"))).status, 200);
  assert.equal((await call("POST", `/api/v1/agents/runs/${leadsRun}/close`, close("ok"))).status, 200);
  assert.deepEqual(sent, ["New inquiries"]);
  assert.deepEqual(db.raw.prepare("SELECT outcome FROM agent_report_deliveries ORDER BY rowid").all().map((row) => (row as { outcome: string }).outcome), ["failed", "sent"]);
  const reports = await ownerReports(db, TENANT, "new_leads", 5);
  assert.deepEqual([reports[0].run?.text, reports[0].delivery?.outcome], ["Synthetic report.", "sent"]);
  // An abstained report run is not delivered; nor is a run on a signal the scheduler did not write.
  const brief = (db.raw.prepare("SELECT signal_id FROM agent_signals WHERE watch_id = 'daily_owner_brief'").get() as { signal_id: string }).signal_id;
  assert.equal((await call("POST", `/api/v1/agents/runs/${await open(brief, "orchestrator", "brief-run-0002")}/close`, close("abstained"))).status, 200);
  const other = await appendSignal(db, TENANT, { kind: "watch", specialist_id: "orchestrator", watch_id: "daily_owner_brief", source: "test", subject: null, content: {}, dedupe_key: "other:1" }, "2026-03-02T16:00:00.000Z");
  assert.ok(!("error" in other));
  assert.equal((await call("POST", `/api/v1/agents/runs/${await open(other.signal_id, "orchestrator", "other-run-0001")}/close`, close("ok"))).status, 200);
  assert.deepEqual(sent, ["New inquiries"]);
});

// --- Slice 5 residuals ---

const hostCall = (db: SqliteD1, at: string, notify: (subject: string, text: string) => Promise<void>) => async (method: string, path: string, body?: unknown) => {
  const response = await handleAgentHostApi(
    new Request(`https://bus.example.invalid${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    { DB: db, AGENT_HOST_TOKEN: TOKEN, PRIVACY_LEDGER: emptyAgentPrivacyLedger(), APP_TENANT_ID: TENANT } as never,
    () => Date.parse(at),
    notify,
  );
  return { status: response.status, body: (await response.json()) as any };
};
const reportClose = (decision: "propose" | "escalate", final_text = "Synthetic report.") => ({
  status: "ok", reason: null, detail: null,
  output: { decision, escalate_to: null, reason_code: decision === "escalate" ? "person_requested" : null, reason: "Composed.", receipts: [], drafts: [], final_text },
  model: { provider: "codex", model: "gpt-6.1-sol", models_used: ["gpt-6.1-sol"], auth_mode: "chatgpt", tier: "routine" },
  hashes: { system: "a".repeat(64), prompt: "b".repeat(64), schema: "c".repeat(64) },
  usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, cost_usd: 0.01, attempts: 1, duration_ms: 10, tool_calls: [],
});
const watchRun = async (db: SqliteD1, call: ReturnType<typeof hostCall>, watch: string, key: string) => {
  const signal = db.raw.prepare("SELECT signal_id, specialist_id FROM agent_signals WHERE watch_id = ?").get(watch) as { signal_id: string; specialist_id: string };
  return (await call("POST", "/api/v1/agents/runs", { signal_id: signal.signal_id, specialist_id: signal.specialist_id, host_run_key: key })).body.run_id as string;
};

test("the cron retries a failed report delivery after a pause, up to the attempt limit, and never once it is sent", async () => {
  const db = new SqliteD1();
  seedLead(db, "lead_retry_0001", "2026-03-02T15:55:00.000Z");
  await runWatches(db, TENANT, "2026-03-02T16:01:00.000Z", TZ);
  const down = async () => {
    throw new Error("synthetic mail outage");
  };
  const call = hostCall(db, "2026-03-02T16:00:00.000Z", down);
  for (const [watch, key] of [["new_leads", "retry-leads-0001"], ["daily_owner_brief", "retry-brief-0001"]]) {
    const run = await watchRun(db, call, watch, key);
    assert.equal((await call("POST", `/api/v1/agents/runs/${run}/close`, reportClose("propose"))).status, 200);
  }
  const sent: string[] = [];
  const briefOnly = async (subject: string) => {
    if (subject !== "Daily owner brief") throw new Error("synthetic push outage");
    sent.push(subject);
  };
  const at = (minutes: number) => new Date(Date.parse("2026-03-02T16:00:00.000Z") + minutes * 60_000).toISOString();
  assert.deepEqual(await retryReportDeliveries(db, TENANT, at(14), briefOnly), { sent: 0, failed: 0 });
  // Without a sender nothing is attempted or recorded, even when a retry is due.
  assert.deepEqual(await retryReportDeliveries(db, TENANT, at(15), null), { sent: 0, failed: 0 });
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_report_deliveries").get() as { n: number }).n, 2);
  assert.deepEqual(await retryReportDeliveries(db, TENANT, at(15), briefOnly), { sent: 1, failed: 1 });
  // A run closed more than a day ago is no longer retried.
  assert.deepEqual(await retryReportDeliveries(db, TENANT, at(24 * 60 + 1), briefOnly), { sent: 0, failed: 0 });
  for (let attempt = 3; attempt <= DELIVERY_RETRY.attempts; attempt += 1)
    assert.deepEqual(await retryReportDeliveries(db, TENANT, at(15 * (attempt - 1)), briefOnly), { sent: 0, failed: 1 });
  assert.deepEqual(await retryReportDeliveries(db, TENANT, at(15 * 10), briefOnly), { sent: 0, failed: 0 });
  assert.deepEqual(sent, ["Daily owner brief"]);
  const attempts = db.raw.prepare("SELECT watch_id, outcome, COUNT(*) AS n FROM agent_report_deliveries GROUP BY watch_id, outcome ORDER BY watch_id, outcome").all().map((row) => ({ ...row }));
  assert.deepEqual(attempts, [
    { watch_id: "daily_owner_brief", outcome: "failed", n: 1 },
    { watch_id: "daily_owner_brief", outcome: "sent", n: 1 },
    { watch_id: "new_leads", outcome: "failed", n: DELIVERY_RETRY.attempts },
  ]);
});

test("a pipeline report is pushed when a decision waits, and an escalated report run is never delivered", async () => {
  const db = new SqliteD1();
  const signal = await appendSignal(db, TENANT, { kind: "event", specialist_id: "lead_concierge", watch_id: null, source: "test", subject: null, content: { text: "Synthetic" }, dedupe_key: "pipe:push" }, "2026-03-02T10:00:00.000Z");
  assert.ok(!("error" in signal));
  const opened = await openRun(db, TENANT, { signal_id: signal.signal_id, specialist_id: "lead_concierge", host_run_key: "pipe-push-1" }, "2026-03-02T10:00:00.000Z");
  assert.ok(!("error" in opened));
  const step = await proposeStep(db, TENANT, opened.run, { action_id: "note.add", args: { object: { aggregate: "lead", id: "synthetic-lead", version: 1 }, text: "Synthetic note." }, citations: [{ fact_id: `signal/${signal.signal_id}`, version: 1 }], step_key: "q".repeat(64) }, Date.parse("2026-03-02T10:05:00.000Z"));
  assert.ok(!("error" in step) && !("shadow" in step) && step.outcome === null, JSON.stringify(step));
  seedLead(db, "lead_escalate_0001", "2026-03-02T10:58:00.000Z");
  const fired = await runWatches(db, TENANT, "2026-03-02T11:01:00.000Z", TZ);
  assert.ok(fired.fired.includes("pipeline") && fired.fired.includes("new_leads"), JSON.stringify(fired));
  const sent: Array<[string, string]> = [];
  const call = hostCall(db, "2026-03-02T11:30:00.000Z", async (subject, text) => void sent.push([subject, text]));
  const leads = await watchRun(db, call, "new_leads", "escalate-leads-0001");
  const escalated = await call("POST", `/api/v1/agents/runs/${leads}/close`, reportClose("escalate", "Synthetic text that must stay in the app."));
  assert.equal(escalated.status, 200, JSON.stringify(escalated.body));
  const pipeline = await watchRun(db, call, "pipeline", "push-pipeline-0001");
  assert.equal((await call("POST", `/api/v1/agents/runs/${pipeline}/close`, reportClose("propose", "Synthetic pipeline: one decision waits."))).status, 200);
  assert.deepEqual(sent, [["Pipeline", "Synthetic pipeline: one decision waits."]]);
  assert.deepEqual(db.raw.prepare("SELECT watch_id, outcome FROM agent_report_deliveries").all().map((row) => ({ ...row })), [{ watch_id: "pipeline", outcome: "sent" }]);
});

test("an exception is raised only when immediate, unacknowledged and open for thirty minutes", async () => {
  const db = new SqliteD1();
  const insert = db.raw.prepare(
    "INSERT INTO agent_exceptions (exception_id, tenant_id, source, reason_code, urgency, reviewer_role, summary, dedupe_key, opened_at) VALUES (?, ?, 'host_alert', 'provider_unavailable', ?, 'owner', 'Synthetic', ?, ?)",
  );
  insert.run("exc_window_today", TENANT, "today", "synthetic:today", "2026-03-02T09:00:00.000Z");
  insert.run("exc_window_fresh", TENANT, "immediate", "synthetic:fresh", "2026-03-02T09:45:00.000Z");
  const outcome = async (at: string) => WATCH_CONDITIONS.unacknowledged_exception.evaluate(db, TENANT, "2026-03-02T00:00:00.000Z", at);
  assert.equal((await outcome("2026-03-02T10:14:00.000Z")).holds, false);
  const due = await outcome("2026-03-02T10:15:00.000Z");
  assert.equal(due.holds, true);
  assert.deepEqual((due.digest as { exceptions: Array<{ exception_id: string }> }).exceptions.map((row) => row.exception_id), ["exc_window_fresh"]);
});

test("a pipeline digest carries the exact job total past its object limit", async () => {
  const db = new SqliteD1();
  seedLead(db, "lead_totals_0001", "2026-03-02T09:00:00.000Z");
  db.raw.exec(`INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, created_at, updated_at) VALUES ('cus_totals_1', '${TENANT}', 'ow_lead_totals_0001', 'Synthetic', 'totals@example.invalid', 'active', '2026-03-02T09:00:00.000Z', '2026-03-02T09:00:00.000Z')`);
  const job = db.raw.prepare(
    `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at) VALUES (?, '${TENANT}', 'lead_totals_0001', 'cus_totals_1', 'ow_lead_totals_0001', ?, 'Roofing', 'qualified', ?, ?)`,
  );
  for (let i = 0; i < 30; i += 1) {
    const at = new Date(Date.parse("2026-03-02T10:10:00.000Z") + i * 1000).toISOString();
    job.run(`job_totals_${String(i).padStart(2, "0")}`, `IW-T-${i}`, at, at);
  }
  job.run("job_totals_old", "IW-T-old", "2026-03-01T10:00:00.000Z", "2026-03-01T10:00:00.000Z");
  const outcome = await WATCH_CONDITIONS.pipeline.evaluate(db, TENANT, "2026-03-02T10:00:00.000Z", "2026-03-02T11:01:00.000Z");
  const digest = outcome.digest as { jobs_changed: string[]; jobs_changed_total: number };
  assert.equal(digest.jobs_changed_total, 30);
  assert.equal(digest.jobs_changed.length, 24);
  assert.equal(digest.jobs_changed[0], "job_totals_29");
  assert.ok(!digest.jobs_changed.includes("job_totals_old"));
  assert.match(outcome.summary, /^30 jobs changed, 0 new decisions waiting, 0 waiting in all$/);
});

test("import_failed_items lists each recent import run with failed items and the source keys to retry", async () => {
  const db = new SqliteD1();
  const run = (id: string, at: string) =>
    db.raw
      .prepare(
        `INSERT INTO crm_import_runs (run_id,tenant_id,adapter,pipeline_key,source_label,source_digest,source_row_count,report_json,created_at)
        VALUES (?, ?, 'ghl_api', 'residential', 'Synthetic export', ?, 40, '{}', ?)`,
      )
      .run(id, TENANT, "a".repeat(64), at);
  let issue = 0;
  const failed = (runId: string, key: string | null, kind = "row_error") =>
    db.raw
      .prepare(`INSERT INTO crm_import_issues (issue_id,tenant_id,run_id,import_key,kind,field,detail,created_at) VALUES (?, ?, ?, ?, ?, NULL, 'Synthetic', ?)`)
      .run(`issue_synthetic_${++issue}`, TENANT, runId, key, kind, "2026-03-02T10:00:00.000Z");
  run("import_run_old_0001", "2026-03-02T08:00:00.000Z");
  failed("import_run_old_0001", "contact:old");
  run("import_run_clean_01", "2026-03-02T09:30:00.000Z");
  failed("import_run_clean_01", "contact:capped", "stage_capped");
  run("import_run_fail_001", "2026-03-02T09:45:00.000Z");
  failed("import_run_fail_001", "contact:b");
  failed("import_run_fail_001", "contact:a");
  failed("import_run_fail_001", "contact:a");
  failed("import_run_fail_001", null);
  const outcome = await WATCH_CONDITIONS.import_failed_items.evaluate(db as never, TENANT, "2026-03-02T09:00:00.000Z", "2026-03-02T10:00:00.000Z");
  assert.equal(outcome.holds, true);
  assert.deepEqual(outcome.objects, []);
  assert.deepEqual(outcome.digest, {
    import_runs: [
      {
        import_run_id: "import_run_fail_001",
        adapter: "ghl_api",
        pipeline_key: "residential",
        source_label: "Synthetic export",
        recorded_at: "2026-03-02T09:45:00.000Z",
        source_row_count: 40,
        failed_items: 4,
        source_keys: ["contact:a", "contact:b"],
        source_keys_total: 2,
        keyless_failed: 1,
      },
    ],
    total: 1,
  });
  assert.equal(outcome.summary, "1 import run has failed items");
  // The next firing's window starts where this one ended: the same run is not listed again.
  assert.equal((await WATCH_CONDITIONS.import_failed_items.evaluate(db as never, TENANT, "2026-03-02T10:00:00.000Z", "2026-03-02T11:00:00.000Z")).holds, false);
  // An import that started just before a firing is still writing its issues: that firing leaves it,
  // and the next one, once it has settled, lists it with every failed item.
  run("import_run_late_001", "2026-03-02T11:58:00.000Z");
  failed("import_run_late_001", "contact:c");
  const during = await WATCH_CONDITIONS.import_failed_items.evaluate(db as never, TENANT, "2026-03-02T11:00:00.000Z", "2026-03-02T12:00:00.000Z");
  assert.equal(during.holds, false);
  failed("import_run_late_001", "contact:d");
  const settled = await WATCH_CONDITIONS.import_failed_items.evaluate(db as never, TENANT, "2026-03-02T12:00:00.000Z", "2026-03-02T13:00:00.000Z");
  assert.deepEqual((settled.digest as any).import_runs.map((entry: { import_run_id: string; source_keys: string[] }) => [entry.import_run_id, entry.source_keys]), [["import_run_late_001", ["contact:c", "contact:d"]]]);
});
