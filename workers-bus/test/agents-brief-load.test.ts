// A daily owner brief over a busy day, as QA's run_1e6f9b8c was: 24 jobs changed, 50 decisions
// waiting and 20 more receipts since the last brief. It counts the D1 statements a run's open and
// its resume make, and holds the resume to the same facts, versions, hashes and omissions.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalJson } from "../src/agents/schema.ts";
import { appendSignal, expireRuns, openRun, proposeStep, type BoundStatement, type RunRow } from "../src/agents/store.ts";
import { ownerReports, runWatches } from "../src/agents/watches.ts";

const TENANT = "ironwrap";
const TZ = "America/Edmonton";
// 16:10 UTC is past the 07:00 brief at Edmonton's offset with or without summer time.
const FIRED = "2026-03-02T16:10:00.000Z";
const SEEDED = "2026-03-02T09:00:00.000Z";
const IN_BATCH = Symbol("in batch");

/**
 * Real SQLite with every migration, D1's one-transaction batch, and a count of every statement. With
 * `latencyMs`, each statement and each batch first waits that long, as a round trip to D1 does, so
 * the time a call takes shows how many of its round trips run one after another.
 */
class CountingD1 {
  raw = new DatabaseSync(":memory:");
  statements: string[] = [];
  batches = 0;
  latencyMs = 0;
  private trip = () => (this.latencyMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.latencyMs)) : Promise.resolve());
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((name) => /^\d+.*\.sql$/.test(name)).sort())
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  reset() {
    this.statements = [];
    this.batches = 0;
  }
  prepare(sql: string) {
    const raw = this.raw;
    const changes = (write: () => void) => {
      const count = () => Number((raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
      const before = count();
      write();
      return count() - before;
    };
    return {
      bind: (...values: unknown[]) => {
        const args = values as Array<string | number | null>;
        const record = async () => {
          this.statements.push(sql);
          await this.trip();
        };
        return {
          first: async <T>() => {
            await record();
            return (this.raw.prepare(sql).get(...args) ?? null) as T | null;
          },
          all: async <T>() => {
            await record();
            return { results: this.raw.prepare(sql).all(...args) as T[] };
          },
          run: async () => {
            await record();
            return execute();
          },
          // A batch's own statements: counted, but inside the batch's single round trip.
          [IN_BATCH]: () => {
            this.statements.push(sql);
            return execute();
          },
        };
        function execute(this: void) {
          return { meta: { changes: changes(() => raw.prepare(sql).run(...args)) } };
        }
      },
    };
  }
  async batch(statements: BoundStatement[]) {
    this.batches += 1;
    // One round trip for the whole batch; its statements run inside it without another wait.
    await this.trip();
    this.raw.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push((statement as unknown as { [IN_BATCH]: () => unknown })[IN_BATCH]());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

/** One synthetic job with its lead, customer, property, consent, six gates and a deposit intent. */
function seedJob(db: CountingD1, n: number) {
  const id = String(n).padStart(4, "0");
  const raw = db.raw;
  raw.prepare("INSERT INTO envelopes (envelope_id, source, payload_json, ts, status, created_at, updated_at) VALUES (?, 'website', '{}', ?, 'received', ?, ?)").run(`ow_brief_${id}`, SEEDED, SEEDED, SEEDED);
  raw
    .prepare("INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_name, contact_email, created_at, updated_at) VALUES (?, ?, ?, 'website', ?, ?, ?, ?)")
    .run(`lead_brief_${id}`, TENANT, `ow_brief_${id}`, `Synthetic Lead ${id}`, `lead-${id}@example.invalid`, SEEDED, SEEDED);
  raw
    .prepare(
      `INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_email, lifecycle_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(`cus_brief_${id}`, TENANT, `ow_brief_${id}`, `Synthetic Holdings ${id}`, `customer-${id}@example.invalid`, SEEDED, SEEDED);
  raw
    .prepare(
      `INSERT INTO operating_properties (property_id, tenant_id, property_key, lead_id, source_envelope_id, address_line1, city, province, postal_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'Calgary', 'AB', 'T2P 0A0', ?, ?)`,
    )
    .run(`prp_brief_${id}`, TENANT, `ironwrap/brief/${id}`, `lead_brief_${id}`, `ow_brief_${id}`, `${n} Synthetic Way`, SEEDED, SEEDED);
  // Each job changed later than the one before, so the brief lists them newest first.
  const changed = new Date(Date.parse(SEEDED) + n * 60_000).toISOString();
  raw
    .prepare(
      `INSERT INTO operating_roof_jobs (roof_job_id, tenant_id, lead_id, customer_id, property_id, source_envelope_id, job_number, service_type, job_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Metal re-roof', 'qualified', ?, ?)`,
    )
    .run(`job_brief_${id}`, TENANT, `lead_brief_${id}`, `cus_brief_${id}`, `prp_brief_${id}`, `ow_brief_${id}`, `IW-BRIEF-${id}`, SEEDED, changed);
  raw
    .prepare(
      `INSERT INTO operating_consents (consent_id, tenant_id, lead_id, customer_id, roof_job_id, source_envelope_id, source_raw_key, channel, purpose, status, jurisdiction, consent_basis, captured_by, recorded_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'raw/leads/synthetic.json', 'email', 'estimate_follow_up', 'granted', 'CA-AB', 'express', 'public_estimator', ?, ?)`,
    )
    .run(`consent_brief_${id}`, TENANT, `lead_brief_${id}`, `cus_brief_${id}`, `job_brief_${id}`, `ow_brief_${id}`, SEEDED, SEEDED);
  const gate = raw.prepare(
    `INSERT INTO operating_production_gates (gate_id, tenant_id, roof_job_id, source_envelope_id, gate, state, owner_user, assigned_at, due_at, blocker_reason, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'blocked', 'owner@example.invalid', ?, ?, 'Synthetic blocker', 1, ?, ?)`,
  );
  for (const name of ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew"]) gate.run(`gate_brief_${id}_${name.toLowerCase()}`, TENANT, `job_brief_${id}`, `ow_brief_${id}`, name, SEEDED, SEEDED, SEEDED, SEEDED);
}

/** The owner, 24 jobs changed today, 50 decisions waiting and 20 more receipts since the last brief. */
async function busyDay(db: CountingD1) {
  db.raw
    .prepare(
      `INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, access_role, active, created_by, created_at, updated_at)
       VALUES ('appu_owner_brief', ?, 'owner@example.invalid', 'Synthetic Owner', 'owner', 'owner', 1, 'seed', ?, ?)`,
    )
    .run(TENANT, SEEDED, SEEDED);
  for (let n = 1; n <= 24; n += 1) seedJob(db, n);
  // Each run takes at most ten steps here: five runs of ten notes that ask first, and two runs of
  // ten reads that are recorded done.
  const steps = async (runIndex: number, actionId: string, args: (step: number) => unknown) => {
    const signal = await appendSignal(db, TENANT, {
      kind: "event", specialist_id: "lead_concierge", watch_id: null, source: "synthetic-test",
      subject: { aggregate: "lead", id: "lead_brief_0001" }, content: { text: "Synthetic" }, dedupe_key: `brief-steps-${runIndex}`,
    }, SEEDED);
    assert.ok("signal_id" in signal);
    const opened = await openRun(db, TENANT, { signal_id: signal.signal_id, specialist_id: "lead_concierge", host_run_key: `brief-steps-run-${runIndex}` }, SEEDED);
    assert.ok(!("error" in opened), JSON.stringify(opened));
    for (let step = 0; step < 10; step += 1) {
      const proposed = await proposeStep(db, TENANT, opened.run as RunRow, {
        action_id: actionId, args: args(step), citations: [{ fact_id: `signal/${signal.signal_id}`, version: 1 }],
        step_key: `${String(runIndex).padStart(2, "0")}${String(step).padStart(2, "0")}`.padEnd(64, "0"),
      }, Date.parse(SEEDED) + step);
      assert.ok(!("error" in proposed), JSON.stringify(proposed));
    }
  };
  for (let run = 0; run < 5; run += 1)
    await steps(run, "note.add", (step) => ({ object: { aggregate: "lead", id: "lead_brief_0001", version: 1 }, text: `Synthetic note ${run}.${step}.` }));
  for (let run = 5; run < 7; run += 1) await steps(run, "fact.explain", (step) => ({ object: null, explanation: `Synthetic read ${run}.${step}.` }));
}

/** Fires the day's brief and returns its signal. */
async function briefSignal(db: CountingD1, at = FIRED) {
  await runWatches(db, TENANT, at, TZ);
  const signal = db.raw.prepare("SELECT signal_id, content_json FROM agent_signals WHERE watch_id = 'daily_owner_brief' ORDER BY signal_seq DESC LIMIT 1").get() as { signal_id: string; content_json: string };
  const content = JSON.parse(signal.content_json) as { objects: unknown[]; digest: { waiting: unknown[]; waiting_total: number; jobs_changed_total: number; receipts_by_outcome: Array<{ n: number }> } };
  return { signal_id: signal.signal_id, content };
}

/** Opens (or resumes) the brief's run and counts what that took. */
async function openBrief(db: CountingD1, signalId: string, at: string, key = "brief-run-0001") {
  db.reset();
  const started = performance.now();
  const opened = await openRun(db, TENANT, { signal_id: signalId, specialist_id: "orchestrator", host_run_key: key }, at);
  const ms = performance.now() - started;
  const ledgerReads = db.statements.filter((sql) => /^\s*SELECT[\s\S]*FROM agent_fact_versions/.test(sql)).length;
  const ledgerWrites = db.statements.filter((sql) => sql.startsWith("INSERT INTO agent_fact_versions")).length;
  return { opened, ms, statements: db.statements.length, batches: db.batches, ledgerReads, ledgerWrites };
}

const shape = (context: { facts: Array<{ fact_id: string; version: number; hash: string; current?: false }>; omitted: unknown[] }) => ({
  facts: context.facts.map(({ fact_id, version, hash, current }) => ({ fact_id, version, hash, current: current ?? true })),
  omitted: context.omitted,
});

test("a busy day's brief opens and resumes in few D1 round trips, with the same facts, versions and omissions", async () => {
  const db = new CountingD1();
  await busyDay(db);
  const { signal_id, content } = await briefSignal(db);
  assert.equal(content.objects.length, 24);
  assert.deepEqual([content.digest.waiting.length, content.digest.waiting_total, content.digest.jobs_changed_total], [50, 50, 24]);
  assert.equal(content.digest.receipts_by_outcome.reduce((sum, row) => sum + Number(row.n), 0), 70);

  const ledgerLines = () => Number(db.raw.prepare("SELECT COUNT(*) AS n FROM agent_fact_versions").get()!.n);
  const linesBefore = ledgerLines();
  const open = await openBrief(db, signal_id, "2026-03-02T16:11:00.000Z");
  assert.ok(!("error" in open.opened), JSON.stringify(open.opened));
  const context = open.opened.context;
  // The snapshot fills with the newest jobs and what they link to; the rest are named, not dropped.
  assert.deepEqual([context.facts.length, context.omitted.length], [21, 20]);
  assert.ok(context.omitted.every((entry) => entry.reason === "limit_reached"));
  // Before: 844 statements, one ledger read and one first-version write per fact read (120 each),
  // for every job whether or not it fitted. Now one ledger read per group of six subjects, and one
  // batch that records only the facts the run is given.
  // Each lead also reads its open proposals (one statement among its concurrent reads, no extra wait).
  assert.ok(open.statements <= 670, String(open.statements));
  assert.ok(open.ledgerReads <= 4, String(open.ledgerReads));
  assert.equal(open.ledgerWrites, context.facts.length - 1);
  assert.equal(open.batches, 1);
  assert.equal(ledgerLines() - linesBefore, context.facts.length - 1, "no line for a fact the run is not given");

  // Before: 125 statements, 20 of them ledger reads. Now one ledger read and no ledger write.
  const resume = await openBrief(db, signal_id, "2026-03-02T16:12:00.000Z");
  assert.ok(!("error" in resume.opened) && resume.opened.resumed, JSON.stringify(resume.opened));
  assert.ok(resume.statements <= 110, String(resume.statements));
  assert.deepEqual([resume.ledgerReads, resume.ledgerWrites, resume.batches], [1, 0, 0]);
  // The resume reads every fact again and finds each where the open left it, value included.
  assert.deepEqual(shape(resume.opened.context), shape(context));
  assert.equal(canonicalJson(resume.opened.context.facts.map((fact) => fact.data)), canonicalJson(context.facts.map((fact) => fact.data)));

  // A job that changes since the open comes back stale and without a value; nothing else moves.
  const changed = context.facts[1].fact_id;
  db.raw.prepare("UPDATE operating_roof_jobs SET job_status = 'in_progress', version = version + 1 WHERE roof_job_id = ?").run(changed.split("/")[1]);
  const stale = await openBrief(db, signal_id, "2026-03-02T16:13:00.000Z");
  assert.ok(!("error" in stale.opened));
  assert.deepEqual(
    stale.opened.context.facts.filter((fact) => fact.current === false).map((fact) => [fact.fact_id, fact.data]),
    [[changed, null]],
  );
  assert.equal(stale.ledgerWrites, 0);
  // A new run of the brief takes that job at its next version: one line, written in the one batch.
  const next = await openBrief(db, signal_id, "2026-03-02T16:13:30.000Z", "brief-run-0002");
  assert.ok(!("error" in next.opened));
  assert.equal(next.opened.context.facts.find((fact) => fact.fact_id === changed)?.version, 2);
  assert.deepEqual([next.ledgerWrites, next.batches], [1, 1]);

  // With each D1 round trip taking 20 ms, a call's time is its round trips run one after another.
  // Before, with 5 ms round trips: open 3351 ms, resume 534 ms. Concurrent reads keep each call
  // well under half of what its statements would take one after another.
  // A round trip is measured here, not assumed: a loaded machine's timers run late for both.
  const calibrating = performance.now();
  for (let trip = 0; trip < 5; trip += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  const perTrip = (performance.now() - calibrating) / 5;
  db.latencyMs = 20;
  const slow = await openBrief(db, signal_id, "2026-03-02T16:14:00.000Z");
  db.latencyMs = 0;
  assert.ok(!("error" in slow.opened));
  assert.ok(slow.ms < slow.statements * perTrip * 0.5, `${Math.round(slow.ms)} ms for ${slow.statements} statements at ${perTrip.toFixed(1)} ms a round trip`);
});

test("a brief whose host never closes it closes at its ceiling, on its next open or by the cron, and its report shows that", async () => {
  const db = new CountingD1();
  await busyDay(db);
  const report = async (signalId: string) => (await ownerReports(db, TENANT, "daily_owner_brief", 10)).find((entry) => entry.signal_id === signalId)?.run;
  const exceptions = (runId: string) => Number(db.raw.prepare("SELECT COUNT(*) AS n FROM agent_exceptions WHERE run_id = ?").get(runId)!.n);
  const receipt = (runId: string) => ({ ...db.raw.prepare("SELECT outcome, reason_code, needs_reviewer_role FROM agent_run_steps WHERE run_id = ? AND action_id = 'exception.escalate'").get(runId) });

  // The busy day's own runs were opened at 09:00 and never closed: the cron closes them first.
  assert.deepEqual(await expireRuns(db, TENANT, FIRED), { expired: 7, failed: 0 });
  // Past its wall-time ceiling the cron leaves the brief's run open for the grace, so a close still
  // on its way lands; it closes the run once both have passed, and not a moment before.
  const today = await briefSignal(db);
  const swept = await openBrief(db, today.signal_id, "2026-03-02T16:11:00.000Z", "brief-swept");
  assert.ok(!("error" in swept.opened));
  const runId = swept.opened.run.run_id;
  assert.deepEqual(await expireRuns(db, TENANT, "2026-03-02T16:21:00.001Z"), { expired: 0, failed: 0 });
  assert.deepEqual(await expireRuns(db, TENANT, "2026-03-02T17:21:00.000Z"), { expired: 0, failed: 0 });
  assert.equal((await report(today.signal_id))?.state, "open");
  assert.deepEqual(await expireRuns(db, TENANT, "2026-03-02T17:21:00.001Z"), { expired: 1, failed: 0 });
  assert.deepEqual(await report(today.signal_id), { run_id: runId, state: "closed", result: "ceiling_reached", text: null });
  // A report's receipt names nobody: the report shows the result, so nobody is interrupted for it.
  assert.deepEqual(receipt(runId), { outcome: "abstained", reason_code: "ceiling_reached", needs_reviewer_role: null });
  assert.equal(exceptions(runId), 0);
  assert.deepEqual(await expireRuns(db, TENANT, "2026-03-02T17:30:00.000Z"), { expired: 0, failed: 0 }, "a closed run is not closed again");
  const late = await openBrief(db, today.signal_id, "2026-03-02T17:31:00.000Z", "brief-swept");
  assert.deepEqual("error" in late.opened ? [late.opened.error, late.opened.status] : null, ["run_closed", 409]);

  // The next day's brief, opened and abandoned: its next open closes it and answers run_expired.
  const tomorrow = await briefSignal(db, "2026-03-03T16:10:00.000Z");
  const opened = await openBrief(db, tomorrow.signal_id, "2026-03-03T16:11:00.000Z", "brief-resumed");
  assert.ok(!("error" in opened.opened));
  const expired = await openBrief(db, tomorrow.signal_id, "2026-03-03T16:21:00.001Z", "brief-resumed");
  assert.deepEqual("error" in expired.opened ? [expired.opened.error, expired.opened.status] : null, ["run_expired", 409]);
  assert.deepEqual(await report(tomorrow.signal_id), { run_id: opened.opened.run.run_id, state: "closed", result: "ceiling_reached", text: null });
  assert.equal(receipt(opened.opened.run.run_id).needs_reviewer_role, null);

  // Any other run that expires names its specialist's reviewer, as a ceiling close does.
  const event = await appendSignal(db, TENANT, {
    kind: "event", specialist_id: "lead_concierge", watch_id: null, source: "synthetic-test",
    subject: { aggregate: "lead", id: "lead_brief_0002" }, content: { text: "Synthetic" }, dedupe_key: "brief-expiry-event",
  }, "2026-03-03T17:00:00.000Z");
  assert.ok("signal_id" in event);
  const lead = await openRun(db, TENANT, { signal_id: event.signal_id, specialist_id: "lead_concierge", host_run_key: "brief-expiry-lead" }, "2026-03-03T17:00:00.000Z");
  assert.ok(!("error" in lead));
  assert.deepEqual(await expireRuns(db, TENANT, "2026-03-03T18:10:00.001Z"), { expired: 1, failed: 0 });
  assert.deepEqual(receipt(lead.run.run_id), { outcome: "abstained", reason_code: "ceiling_reached", needs_reviewer_role: "sales" });
  assert.equal(exceptions(lead.run.run_id), 1);
});
