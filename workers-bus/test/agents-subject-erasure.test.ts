import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAgentHostApi, handleAgentTeamAppRoute } from "../src/agents/api.ts";
import { leadProposal, openLeadProposals } from "../src/agents/lead-proposals.ts";
import { requestMarkerKey, signalMarkerKey, type SignalErasureMarker } from "../src/agents/privacy-ledger.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { appendSignal, openRun, type BoundStatement, type SignalRow } from "../src/agents/store.ts";
import { assertAgentValueAvailable, ERASURE_ARGUMENT_BATCH, ERASURE_MAX_SIGNALS, ERASURE_SIGNAL_BATCH } from "../src/agents/subject-erasure.ts";
import type { AuthContext } from "../src/app-types.ts";
import { MemoryAgentPrivacyLedger } from "./agents-privacy-fixtures.ts";

const TENANT = "ironwrap", OWNER = "appu_privacy_owner", CUSTOMER = "customer_privacy_primary", LEAD = "lead_privacy_primary";
const CSRF = "synthetic-privacy-csrf", TOKEN = "synthetic-privacy-host-token";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ORIGINAL = "Synthetic private inquiry text";
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  beforeBatch: (() => void) | null = null;
  failSql: RegExp | null = null;
  seen: string[] = [];
  queries: Array<{ sql: string; args: Array<string | number | null> }> = [];
  constructor() {
    this.raw.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter((v) => /^\d{4}_.+\.sql$/.test(v)).sort()) this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  prepare(sql: string) {
    this.seen.push(sql);
    return { bind: (...values: unknown[]) => {
      const args = values as Array<string | number | null>;
      this.queries.push({ sql, args });
      return {
        first: async <T>() => (this.raw.prepare(sql).get(...args) ?? null) as T | null,
        all: async <T>() => ({ results: this.raw.prepare(sql).all(...args) as T[] }),
        run: async () => {
          if (this.failSql?.test(sql)) throw new Error("synthetic_d1_failure");
          const before = this.total(); this.raw.prepare(sql).run(...args);
          return { meta: { changes: this.total() - before } };
        },
      };
    } };
  }
  private total() { return Number((this.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n); }
  async batch(statements: BoundStatement[]) {
    this.beforeBatch?.();
    this.raw.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.raw.exec("COMMIT"); return results; }
    catch (error) { this.raw.exec("ROLLBACK"); throw error; }
  }
  row(table: string, column: string, id: string) { return this.raw.prepare(`SELECT * FROM ${table} WHERE ${column} = ?`).get(id) as Record<string, any>; }
  count(table: string) { return Number((this.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n); }
}
function setup(options: { withoutPhone?: boolean } = {}) {
  const db = new SqliteD1(), ledger = new MemoryAgentPrivacyLedger();
  let clock = Date.now();
  const now = () => new Date(clock).toISOString();
  db.raw.prepare(`INSERT INTO app_users (user_id, tenant_id, email_normalized, display_name, role, active, created_by, created_at, updated_at)
    VALUES (?, ?, 'privacy-owner@example.invalid', 'Synthetic Owner', 'owner', 1, 'seed', ?, ?)` ).run(OWNER, TENANT, now(), now());
  db.raw.prepare(`INSERT INTO app_sessions (session_hash, user_id, tenant_id, created_at, expires_at, last_seen_at, created_ip_hash, created_user_agent_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(hash("session"), OWNER, TENANT, now(), new Date(clock + 3600000).toISOString(), now(), hash("ip"), hash("ua"));
  db.raw.prepare("INSERT INTO envelopes (envelope_id, source, payload_json, status, ts, created_at, updated_at) VALUES ('privacy_envelope_primary', 'website', '{}', 'received', ?, ?, ?)").run(now(), now(), now());
  db.raw.prepare(`INSERT INTO operating_customers (customer_id, tenant_id, source_envelope_id, display_name, contact_phone, contact_email, created_at, updated_at)
    VALUES (?, ?, 'privacy_envelope_primary', 'Synthetic Customer', ?, 'privacy-customer@example.invalid', ?, ?)`).run(CUSTOMER, TENANT, options.withoutPhone ? null : "+15875550142", now(), now());
  db.raw.prepare(`INSERT INTO operating_leads (lead_id, tenant_id, source_envelope_id, source, contact_email, created_at, updated_at)
    VALUES (?, ?, 'privacy_envelope_primary', 'website', 'privacy-customer@example.invalid', ?, ?)`).run(LEAD, TENANT, now(), now());
  const auth = { session: { user_id: OWNER, tenant_id: TENANT, role: "owner", session_hash: hash("session"), session_created_at: now(), session_expires_at: new Date(clock + 3600000).toISOString() },
    csrfToken: CSRF, rawSessionToken: "synthetic", permissions: [] } as unknown as AuthContext;
  const env = { DB: db, PRIVACY_LEDGER: ledger.binding(), AGENT_HOST_TOKEN: TOKEN, APP_TENANT_ID: TENANT, AGENT_DATA_CLASS: "synthetic" };
  const input = { customer_id: CUSTOMER, expected_customer_version: 1, verification: { method: "on_file_email", on_file_check_completed: true, evidence_ref: "ver_synthetic_evidence_0001" } };
  async function app(method: string, path = "/privacy/erasures", body: unknown = input, options: { key?: string; auth?: AuthContext; csrf?: string } = {}) {
    const res = await handleAgentTeamAppRoute(new Request(`https://bus.example.invalid/api/v1/agent-team${path}`, { method,
      headers: { "content-type": "application/json", "x-csrf-token": options.csrf ?? CSRF, "idempotency-key": options.key ?? "synthetic-erasure-key" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), env, options.auth ?? auth, () => clock);
    return { status: res.status, body: await res.json() as any };
  }
  async function host(method: string, path: string, body?: unknown, token = TOKEN) {
    const res = await handleAgentHostApi(new Request(`https://bus.example.invalid/api/v1/agents${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, () => clock);
    return { status: res.status, body: res.status === 204 ? null : await res.json() as any };
  }
  async function signal(options: { tenant?: string; subject?: { aggregate: string; id: string } | null; content?: unknown; kind?: SignalRow["kind"] } = {}) {
    const result = await appendSignal(db, options.tenant ?? TENANT, { kind: options.kind ?? "event", specialist_id: "lead_concierge", source: "web_form", watch_id: null,
      subject: options.subject === undefined ? { aggregate: "lead", id: LEAD } : options.subject,
      content: options.content ?? { envelope_id: "privacy_envelope_primary", excerpt: ORIGINAL, service: "Synthetic service", form_fields: { address: "1 Synthetic Way", scope: "Synthetic scope", timing: "Synthetic timing" },
        sender: { customer_id: null, matched_on: null, conflict: false } }, dedupe_key: `synthetic:${crypto.randomUUID()}` }, now());
    assert.ok("signal_id" in result); return result.signal_id;
  }
  async function run(signalId: string) {
    const result = await openRun(db, TENANT, { signal_id: signalId, specialist_id: "lead_concierge", host_run_key: `synthetic:${crypto.randomUUID()}` }, now());
    assert.ok(!("error" in result), JSON.stringify(result)); return result.run.run_id;
  }
  function proposal(runId: string, signalId: string, options: { shadow?: boolean; action?: string; lead?: string; cite?: string; outcome?: string | null } = {}) {
    const id = `${options.shadow ? "sh" : "step"}_${crypto.randomUUID()}`, action = options.action ?? "lead_fact.propose";
    const args = canonicalJson({ lead_id: options.lead ?? LEAD, fields: { service: "Synthetic service", scope: "Synthetic scope", address: "1 Synthetic Way", timing: "Synthetic timing" } });
    const signalRow = db.row("agent_signals", "signal_id", signalId);
    const sources = canonicalJson([{ fact_id: `signal/${options.cite ?? signalId}`, version: 1, hash: `sha256:${signalRow.content_sha256}` }]);
    if (options.shadow) db.raw.prepare(`INSERT INTO agent_shadow_steps (shadow_step_id, tenant_id, run_id, specialist_id, action_id, step_key, args_json, args_sha256, sources_json, policy_json, subject_aggregate, subject_id, proposed_at)
      VALUES (?, ?, ?, 'lead_concierge', ?, ?, ?, ?, ?, '{}', 'lead', ?, ?)`).run(id, TENANT, runId, action, hash(id), args, hash(args), sources, LEAD, now());
    else db.raw.prepare(`INSERT INTO agent_run_steps (step_id, tenant_id, run_id, step_seq, step_key, specialist_id, action_id, autonomy, args_json, args_sha256, sources_json, policy_json, permit_json, outcome, undo_json, do_it_myself_json, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, 'lead_concierge', ?, 'A1', ?, ?, ?, '{}', '{}', ?, '{}', '{}', ?, ?)`)
      .run(id, TENANT, runId, db.count("agent_run_steps") + 1, hash(id), action, args, hash(args), sources, options.outcome === undefined ? "succeeded" : options.outcome, now(), now());
    return id;
  }
  return { db, ledger, env, auth, input, app, host, signal, run, proposal, now, tick: (ms: number) => { clock += ms; } };
}

test("owner erasure records checked identity, exact signal/live/shadow text and original hashes", async () => {
  const s = setup();
  try {
    const id = await s.signal(), run = await s.run(id), live = s.proposal(run, id), shadow = s.proposal(run, id, { shadow: true });
    const wrongLead = s.proposal(run, id, { lead: "lead_unrelated_0001" }), wrongCitation = s.proposal(run, id, { cite: "sig_unrelated" });
    const confirm = s.proposal(run, id, { action: "lead_fact.confirm" });
    const unrelatedShadow = [s.proposal(run, id, { shadow: true, lead: "lead_unrelated_0001" }),
      s.proposal(run, id, { shadow: true, cite: "sig_unrelated" }), s.proposal(run, id, { shadow: true, action: "lead_fact.confirm" })];
    const foreign = await s.signal({ tenant: "foreign" }), unbound = await s.signal({ subject: null });
    const conflicting = await s.signal({ subject: null, content: { excerpt: ORIGINAL, sender: { customer_id: CUSTOMER, matched_on: "email", conflict: true } } });
    const watch = await s.signal({ kind: "watch" });
    const before = { signal: s.db.row("agent_signals", "signal_id", id), live: s.db.row("agent_run_steps", "step_id", live), shadow: s.db.row("agent_shadow_steps", "shadow_step_id", shadow) };
    const result = await s.app("POST");
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.completed, true);
    assert.equal(result.body.eligible_signals, 1);
    const query = s.db.queries.find((q) => q.sql.includes("INSERT INTO agent_subject_erasures") && q.sql.includes("INDEXED BY idx_agent_signals_erasure_sender"))!;
    assert.ok(query);
    const plans = s.db.raw.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args) as Array<{ detail: string }>;
    for (const index of ["idx_agent_signals_erasure_subject", "idx_agent_signals_erasure_sender"]) assert.ok(plans.some((row) => new RegExp(`SEARCH agent_signals USING (?:COVERING )?INDEX ${index}`).test(row.detail)), index); assert.ok(result.body.unreached_copies.includes("archived_backup_bytes"));
    const signal = s.db.row("agent_signals", "signal_id", id);
    assert.deepEqual(JSON.parse(signal.content_json), { envelope_id: "privacy_envelope_primary", sender: { customer_id: null, matched_on: null, conflict: false }, redacted: true });
    for (const key of Object.keys(before.signal).filter((v) => v !== "content_json")) assert.equal(signal[key], before.signal[key], key);
    for (const [table, column, stepId, original] of [["agent_run_steps", "step_id", live, before.live], ["agent_shadow_steps", "shadow_step_id", shadow, before.shadow]] as const) {
      const row = s.db.row(table, column, stepId), args = JSON.parse(row.args_json);
      assert.deepEqual(args, { lead_id: LEAD, fields: { service: null, scope: null, address: null, timing: null }, redacted: true });
      for (const key of Object.keys(original).filter((v) => v !== "args_json")) assert.equal(row[key], original[key], `${table}.${key}`);
    }
    for (const stepId of [wrongLead, wrongCitation, confirm]) assert.equal(JSON.parse(s.db.row("agent_run_steps", "step_id", stepId).args_json).redacted, undefined);
    for (const stepId of unrelatedShadow) assert.equal(JSON.parse(s.db.row("agent_shadow_steps", "shadow_step_id", stepId).args_json).redacted, undefined);
    for (const signalId of [foreign, unbound, conflicting, watch]) assert.equal(JSON.parse(s.db.row("agent_signals", "signal_id", signalId).content_json).excerpt, ORIGINAL);
    assert.equal(await leadProposal(s.db, TENANT, live), null); assert.deepEqual(await openLeadProposals(s.db, TENANT, LEAD, 10), [wrongCitation]);
    const replay = await s.app("POST"); assert.equal(replay.body.erasure_id, result.body.erasure_id); assert.equal(s.db.count("agent_subject_erasures"), 1);
    const changed = await s.app("POST", undefined, { ...s.input, verification: { ...s.input.verification, evidence_ref: "ver_different_evidence_0002" } });
    assert.equal(changed.status, 409); assert.equal(changed.body.error, "idempotency_conflict");
    const later = await s.signal(); assert.equal((await s.app("POST")).body.completed, true);
    assert.equal(JSON.parse(s.db.row("agent_signals", "signal_id", later).content_json).excerpt, ORIGINAL, "frontier stays frozen");
    const markerText = [...s.ledger.objects.values()].join("\n");
    for (const text of [ORIGINAL, "privacy-customer@example.invalid", "+15875550142", s.input.verification.evidence_ref, "Synthetic scope"]) assert.ok(!markerText.includes(text), text);
    assert.ok(markerText.includes(s.input.verification.method));
    assert.equal((await s.host("POST", "/runs", { signal_id: id, specialist_id: "lead_concierge", host_run_key: "synthetic-refused-run" })).status, 409);
    assert.equal((await s.host("GET", `/runs/${run}/tools`)).status, 409);
    assert.equal((await s.app("GET", `/steps/${live}`)).status, 409);
  } finally { s.db.raw.close(); }
});

test("current owner/session/CSRF and recorded on-file verification fail closed", async (t) => {
  for (const mode of ["ops", "host", "csrf", "stale", "revoked", "deactivated", "demoted", "expired", "foreign_customer", "wrong_version", "missing_contact", "unperformed", "raw_reference", "bad_method", "authority_race", "customer_version_race", "cross_tenant"] as const) {
    await t.test(mode, async () => {
      const s = setup({ withoutPhone: mode === "missing_contact" });
      try {
        await s.signal(); let input: any = structuredClone(s.input), auth = structuredClone(s.auth), csrf = CSRF;
        if (mode === "ops") auth.session.role = "ops";
        if (mode === "csrf") csrf = "synthetic-wrong";
        if (mode === "stale") s.tick(6 * 60000);
        if (mode === "revoked") s.db.raw.prepare("UPDATE app_sessions SET revoked_at = ?").run(s.now());
        if (mode === "deactivated") s.db.raw.exec("UPDATE app_users SET active = 0");
        if (mode === "demoted") s.db.raw.exec("UPDATE app_users SET access_role = 'ops'");
        if (mode === "expired") s.tick(2 * 3600000);
        if (mode === "foreign_customer") input.customer_id = "customer_not_in_tenant";
        if (mode === "wrong_version") input.expected_customer_version = 2;
        if (mode === "missing_contact") input.verification.method = "on_file_phone";
        if (mode === "unperformed") input.verification.on_file_check_completed = false;
        if (mode === "raw_reference") input.verification.evidence_ref = "privacy-customer@example.invalid";
        if (mode === "bad_method") input.verification.method = "text_message";
        if (mode === "cross_tenant") auth.session.tenant_id = "foreign";
        if (mode === "authority_race" || mode === "customer_version_race") {
          let batches = 0;
          s.db.beforeBatch = () => { if (++batches !== 2) return; s.db.beforeBatch = null;
            if (mode === "authority_race") s.db.raw.prepare("UPDATE app_sessions SET revoked_at = ?").run(s.now());
            else s.db.raw.exec("UPDATE operating_customers SET version = version + 1"); };
        }
        const result = mode === "host" ? await s.host("POST", "/privacy/erasures", input) : await s.app("POST", undefined, input, { auth, csrf });
        assert.ok(result.status >= 400, JSON.stringify(result)); assert.equal(s.ledger.objects.size, 0); assert.equal(s.db.count("agent_subject_erasures"), 0);
      } finally { s.db.raw.close(); }
    });
  }
});

test("independent marker/D1 failures retain partial state without a completed erasure and retry safely", async (t) => {
  for (const mode of ["missing_bucket", "get_failure", "put_failure", "lost_put_response", "lost_signal_put_response", "missing_readback", "conflicting_marker", "initial_d1", "after_marker_d1", "owner_revoked_after_marker", "owner_expired_after_marker"] as const) {
    await t.test(mode, async () => {
      const s = setup();
      try {
        const signal = await s.signal();
        if (mode === "missing_bucket") s.env.PRIVACY_LEDGER = undefined as never;
        if (mode === "get_failure") s.ledger.failGet = true;
        if (mode === "put_failure") s.ledger.failPut = true;
        if (mode === "lost_put_response") s.ledger.losePutResponse = true;
        if (mode === "lost_signal_put_response") s.ledger.afterPut = () => { if (s.ledger.objects.size === 2) s.ledger.losePutResponse = true; };
        if (mode === "missing_readback") s.ledger.omitReadback = true;
        if (mode === "conflicting_marker") s.ledger.objects.set(signalMarkerKey(TENANT, signal), '{"version":1,"type":"signal"}');
        if (mode === "initial_d1") s.db.failSql = /INSERT INTO agent_subject_erasures/;
        if (mode === "after_marker_d1") s.db.failSql = /UPDATE agent_signals SET content_json/;
        if (mode === "owner_revoked_after_marker") s.ledger.afterPut = () => { s.db.raw.prepare("UPDATE app_sessions SET revoked_at = ?").run(s.now()); };
        if (mode === "owner_expired_after_marker") s.ledger.afterPut = () => { s.tick(2 * 3600000); };
        const result = await s.app("POST"); assert.ok(result.status >= 400, JSON.stringify(result)); assert.notEqual(result.body.completed, true);
        assert.equal(JSON.parse(s.db.row("agent_signals", "signal_id", signal).content_json).excerpt, ORIGINAL);
        if (mode === "initial_d1") assert.equal(s.ledger.objects.size, 0);
        if (["lost_put_response", "lost_signal_put_response", "after_marker_d1"].includes(mode)) {
          assert.ok(s.ledger.objects.size > 0); s.ledger.losePutResponse = false; s.ledger.afterPut = null; s.db.failSql = null;
          const retry = await s.app("POST"); assert.equal(retry.status, 200, JSON.stringify(retry)); assert.equal(retry.body.completed, true);
        }
      } finally { s.db.raw.close(); }
    });
  }
});

test("older D1 restore is held before disclosure and real paged replay erases live/shadow copies again", async () => {
  const s = setup(), scratch = mkdtempSync(join(tmpdir(), "ironwrap-agent-erasure-"));
  try {
    const signal = await s.signal(), run = await s.run(signal), live = s.proposal(run, signal), shadow = s.proposal(run, signal, { shadow: true });
    const originalHashes = [s.db.row("agent_signals", "signal_id", signal).content_sha256, s.db.row("agent_run_steps", "step_id", live).args_sha256, s.db.row("agent_shadow_steps", "shadow_step_id", shadow).args_sha256];
    const second = await s.signal();
    s.db.raw.prepare("VACUUM INTO ?").run(join(scratch, "before.sqlite"));
    const decision = await s.app("POST"); assert.equal(decision.status, 200, JSON.stringify(decision));
    const commitments = new Map(s.ledger.objects);
    s.db.raw.close(); copyFileSync(join(scratch, "before.sqlite"), join(scratch, "restored.sqlite")); s.db.raw = new DatabaseSync(join(scratch, "restored.sqlite")); s.db.raw.exec("PRAGMA foreign_keys=ON");
    assert.equal(s.db.count("agent_subject_erasures"), 0); assert.equal(s.db.count("agent_signal_erasures"), 0);
    const blocked = await s.host("POST", "/runs", { signal_id: signal, specialist_id: "lead_concierge", host_run_key: "synthetic-restore-run" });
    assert.equal(blocked.status, 409, JSON.stringify(blocked)); assert.ok(!JSON.stringify(blocked).includes(ORIGINAL));
    assert.equal(s.db.count("agent_subject_erasures"), 1); assert.equal(s.db.count("agent_signal_erasures"), 1);
    const masked = await s.host("GET", "/signals"); assert.equal(masked.status, 200); assert.ok(!JSON.stringify(masked).includes(ORIGINAL)); assert.ok(masked.body.signals.every((row: any) => row.content.redacted === true));
    assert.equal((await s.app("GET", `/steps/${live}`)).status, 409);
    let cursor: string | null = null, pages = 0;
    do { const page = await s.app("POST", "/privacy/erasures/reapply", { cursor }); assert.equal(page.status, 200, JSON.stringify(page)); cursor = page.body.next_cursor; pages++; assert.ok(pages <= 6); } while (cursor);
    assert.ok(pages >= 2); assert.deepEqual(s.ledger.objects, commitments);
    for (const id of [signal, second]) assert.equal(JSON.parse(s.db.row("agent_signals", "signal_id", id).content_json).redacted, true);
    for (const [table, column, id] of [["agent_run_steps", "step_id", live], ["agent_shadow_steps", "shadow_step_id", shadow]]) assert.equal(JSON.parse(s.db.row(table, column, id).args_json).redacted, true);
    assert.deepEqual([s.db.row("agent_signals", "signal_id", signal).content_sha256, s.db.row("agent_run_steps", "step_id", live).args_sha256, s.db.row("agent_shadow_steps", "shadow_step_id", shadow).args_sha256], originalHashes);
    const retry = await s.app("POST"); assert.equal(retry.body.erasure_id, decision.body.erasure_id); assert.equal(retry.body.completed, true);
    assert.ok(s.db.row("envelopes", "envelope_id", "privacy_envelope_primary"));
  } finally { s.db.raw.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("signal and argument budgets require explicit progress without widening the frozen frontier", async () => {
  const s = setup();
  try {
    const signals = []; for (let i = 0; i < ERASURE_SIGNAL_BATCH + 2; i++) signals.push(await s.signal());
    const run = await s.run(signals[0]);
    for (let i = 0; i < ERASURE_ARGUMENT_BATCH + 3; i++) s.proposal(run, signals[0], { shadow: i % 2 === 0 });
    const first = await s.app("POST"); assert.equal(first.status, 202, JSON.stringify(first)); assert.equal(first.body.completed, false);
    assert.equal(s.db.count("agent_signal_erasures"), ERASURE_SIGNAL_BATCH); assert.equal(first.body.remaining_argument_rows, 3);
    const later = await s.signal(); const next = await s.app("POST"); assert.equal(next.status, 200, JSON.stringify(next)); assert.equal(next.body.completed, true);
    assert.equal(next.body.eligible_signals, signals.length); assert.equal(JSON.parse(s.db.row("agent_signals", "signal_id", later).content_json).excerpt, ORIGINAL);
    const tooMany = setup();
    try { for (let i = 0; i <= ERASURE_MAX_SIGNALS; i++) await tooMany.signal(); const refused = await tooMany.app("POST"); assert.equal(refused.status, 422, JSON.stringify(refused)); assert.equal(refused.body.error, "erasure_supported_scope_exceeded"); assert.equal(refused.body.accepted, false); assert.equal(refused.body.completed, false); assert.deepEqual(refused.body.supported_scope, { max_identities: 64, max_signals: ERASURE_MAX_SIGNALS }); assert.equal(tooMany.ledger.objects.size, 0); assert.equal(tooMany.db.count("agent_subject_erasures"), 0); }
    finally { tooMany.db.raw.close(); }
  } finally { s.db.raw.close(); }
});

test("oversized native scopes refuse the whole decision and publish explicit supported limits", async () => {
  const s = setup();
  try {
    for (let i = 0; i < 63; i++) s.db.raw.prepare(`INSERT INTO operating_roof_jobs
      (roof_job_id, tenant_id, lead_id, customer_id, source_envelope_id, service_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'privacy_envelope_primary', 'Synthetic service', ?, ?)`)
      .run(`job_privacy_limit_${i}`, TENANT, LEAD, CUSTOMER, s.now(), s.now());
    const refused = await s.app("POST");
    assert.equal(refused.status, 422, JSON.stringify(refused));
    assert.equal(refused.body.error, "erasure_supported_scope_exceeded");
    assert.equal(refused.body.accepted, false); assert.equal(refused.body.completed, false);
    assert.deepEqual(refused.body.supported_scope, { max_identities: 64, max_signals: ERASURE_MAX_SIGNALS });
    assert.equal(s.db.count("agent_subject_erasures"), 0); assert.equal(s.db.count("agent_signal_erasures"), 0); assert.equal(s.ledger.objects.size, 0);
  } finally { s.db.raw.close(); }
});

test("an old restore assigning low sequences to new signal IDs cannot widen the frozen decision", async () => {
  const s = setup(), scratch = mkdtempSync(join(tmpdir(), "ironwrap-agent-frontier-"));
  try {
    s.db.raw.prepare("VACUUM INTO ?").run(join(scratch, "empty-signals.sqlite"));
    const originals = [await s.signal(), await s.signal()];
    const result = await s.app("POST"); assert.equal(result.status, 200, JSON.stringify(result));
    const frozen = JSON.parse(result.body.decision.scope_json).signals;
    assert.deepEqual(frozen.map((entry: { signal_id: string }) => entry.signal_id), originals);
    s.db.raw.close(); copyFileSync(join(scratch, "empty-signals.sqlite"), join(scratch, "restored.sqlite"));
    s.db.raw = new DatabaseSync(join(scratch, "restored.sqlite")); s.db.raw.exec("PRAGMA foreign_keys=ON");
    const later = [await s.signal(), await s.signal()];
    assert.ok(later.every((id) => s.db.row("agent_signals", "signal_id", id).signal_seq <= result.body.decision.signal_seq_ceiling));
    const retry = await s.app("POST"); assert.equal(retry.status, 202, JSON.stringify(retry));
    assert.equal(retry.body.erasure_id, result.body.erasure_id); assert.equal(retry.body.completed, false);
    assert.deepEqual(retry.body.absent_signal_ids, originals); assert.equal(retry.body.eligible_signals, originals.length);
    assert.equal(s.db.count("agent_signal_erasures"), 0);
    const absent: string[] = []; let cursor: string | null = null, pages = 0;
    do { const page = await s.app("POST", "/privacy/erasures/reapply", { cursor }); assert.equal(page.status, 200, JSON.stringify(page));
      absent.push(...page.body.absent_signal_ids); cursor = page.body.next_cursor; assert.ok(++pages <= 4); } while (cursor);
    assert.deepEqual(absent.sort(), [...originals].sort());
    for (const id of later) { assert.equal(JSON.parse(s.db.row("agent_signals", "signal_id", id).content_json).excerpt, ORIGINAL);
      assert.equal((await s.host("POST", "/runs", { signal_id: id, specialist_id: "lead_concierge", host_run_key: `later:${id}` })).status, 201); }
    assert.equal(s.db.count("agent_signal_erasures"), 0);
  } finally { s.db.raw.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("a later signal cannot admit a run that still cites a held lead proposal in its context", async () => {
  const s = setup();
  try {
    const original = await s.signal(), run = await s.run(original), proposal = s.proposal(run, original);
    s.db.failSql = /UPDATE agent_signals SET content_json/;
    assert.equal((await s.app("POST")).status, 503); s.db.failSql = null;
    assert.equal(JSON.parse(s.db.row("agent_run_steps", "step_id", proposal).args_json).redacted, undefined);
    const laterText = "Synthetic later inquiry outside the frozen erasure";
    const later = await s.signal({ content: { ...JSON.parse(s.db.row("agent_signals", "signal_id", original).content_json), excerpt: laterText } });
    const opened = await s.host("POST", "/runs", { signal_id: later, specialist_id: "lead_concierge", host_run_key: "later-held-context" });
    assert.equal(opened.status, 409, JSON.stringify(opened)); assert.equal(opened.body.error, "agent_source_erased");
    assert.equal(Number((s.db.raw.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE signal_id = ?").get(later) as { n: number }).n), 0);
    assert.equal((await s.app("POST")).status, 200);
    const after = await s.host("POST", "/runs", { signal_id: later, specialist_id: "lead_concierge", host_run_key: "later-cleared-context" });
    assert.equal(after.status, 201, JSON.stringify(after)); assert.ok(!JSON.stringify(after).includes(ORIGINAL));
    assert.equal(after.body.context.facts.find((fact: any) => fact.fact_id === `signal/${later}`).data.excerpt, laterText);
    assert.ok(!after.body.context.facts.some((fact: any) => fact.fact_id === `lead_proposal/${proposal}`));
  } finally { s.db.raw.close(); }
});

test("privacy reads bind supported pointer citations to the complete underlying signal", async () => {
  const s = setup();
  try {
    const signal = await s.signal(), run = await s.run(signal), proposal = s.proposal(run, signal);
    const refs = { source: `lead_proposal/${proposal}#/fields/service` };
    await assert.doesNotReject(() => assertAgentValueAvailable(s.db, s.env, TENANT, refs, s.now()));
    const step = { action_id: "fact.explain", args: { object: null, explanation: "Synthetic current inquiry." },
      citations: [{ fact_id: `signal/${signal}#/excerpt`, version: 1 }] };
    const input = { ...step, step_key: hash(canonicalJson(step)) };
    const current = await s.host("POST", `/runs/${run}/steps`, input);
    assert.equal(current.status, 200, JSON.stringify(current)); assert.equal(current.body.decision, "recorded");
    assert.equal((await s.app("POST")).body.completed, true);
    await assert.rejects(() => assertAgentValueAvailable(s.db, s.env, TENANT, refs, s.now()), { code: "agent_source_erased" });
    const erased = await s.host("POST", `/runs/${run}/steps`, input);
    assert.equal(erased.status, 409, JSON.stringify(erased)); assert.equal(erased.body.error, "agent_source_erased");
    assert.ok(!JSON.stringify(erased).includes(ORIGINAL));
  } finally { s.db.raw.close(); }
});

test("SQL admission holds whole and pointer signal/proposal references in run contexts and live/shadow sources", async () => {
  const s = setup();
  try {
    const signal = await s.signal(), run = await s.run(signal), live = s.proposal(run, signal), shadow = s.proposal(run, signal, { shadow: true });
    s.db.failSql = /UPDATE agent_signals SET content_json/;
    assert.equal((await s.app("POST")).status, 503); s.db.failSql = null;
    const later = await s.signal();
    const oldRun = s.db.row("agent_runs", "run_id", run), oldContext = JSON.parse(oldRun.context_json);
    const safeContext = canonicalJson({ ...oldContext, facts: [] });
    const safeRun = { ...oldRun, run_id: "run_privacy_pointer_unrelated", signal_id: later, host_run_key: hash("unrelated-pointer"),
      context_json: safeContext, context_snapshot_hash: hash(safeContext) };
    const insert = (table: string, row: Record<string, any>) => s.db.raw.prepare(
      `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
    insert("agent_runs", safeRun);
    const admitted: string[] = [];
    const refs = [`signal/${signal}`, `signal/${signal}#/excerpt`, `lead_proposal/${live}`, `lead_proposal/${live}#/fields/service`];
    for (const factId of refs) for (const table of ["agent_runs", "agent_run_steps", "agent_shadow_steps"] as const) {
      const ref = { fact_id: factId, version: 1, hash: `sha256:${hash(canonicalJson(ORIGINAL))}` };
      const label = `${table}:${factId}`;
      s.db.raw.exec("SAVEPOINT pointer_hold");
      try {
        if (table === "agent_runs") {
          const context = canonicalJson({ ...oldContext, facts: [ref] });
          insert(table, { ...safeRun, run_id: "run_privacy_pointer_held", host_run_key: hash(label), context_json: context, context_snapshot_hash: hash(context) });
        } else {
          const id = table === "agent_run_steps" ? live : shadow, key = table === "agent_run_steps" ? "step_id" : "shadow_step_id";
          insert(table, { ...s.db.row(table, key, id), [key]: `pointer_${crypto.randomUUID()}`, run_id: safeRun.run_id,
            step_key: hash(label), sources_json: canonicalJson([ref]) });
        }
        admitted.push(label);
      } catch (error) { assert.match(String(error), /agent_source_erased/, label); }
      finally { s.db.raw.exec("ROLLBACK TO pointer_hold; RELEASE pointer_hold"); }
    }
    assert.deepEqual(admitted, [], "no held source may be admitted by spelling its supported pointer");
  } finally { s.db.raw.close(); }
});

test("marker missing/conflicting/unavailable and malformed pagination never expose restored text or acknowledge replay", async (t) => {
  for (const mode of ["missing_signal", "missing_request", "get_failure", "malformed", "foreign_marker", "hash_conflict", "list_failure", "cursor_cycle", "foreign_list_key", "oversized_marker"] as const) {
    await t.test(mode, async () => {
      const s = setup();
      try {
        const signal = await s.signal(); const result = await s.app("POST"); assert.equal(result.status, 200, JSON.stringify(result));
        const key = signalMarkerKey(TENANT, signal);
        if (mode === "missing_signal") s.ledger.objects.delete(key);
        if (mode === "missing_request") s.ledger.objects.delete(requestMarkerKey(TENANT, result.body.erasure_id));
        if (mode === "get_failure") s.ledger.failGet = true;
        if (mode === "malformed") s.ledger.objects.set(key, "{}");
        if (mode === "oversized_marker") s.ledger.objects.set(key, " ".repeat(65 * 1024));
        if (mode === "foreign_marker" || mode === "hash_conflict") { const m = JSON.parse(s.ledger.objects.get(key)!) as SignalErasureMarker; if (mode === "foreign_marker") m.tenant_id = "foreign"; else m.content_sha256 = "0".repeat(64); s.ledger.objects.set(key, canonicalJson(m)); }
        if (mode === "list_failure") s.ledger.failList = true;
        if (mode === "cursor_cycle") s.ledger.listOverride = () => ({ objects: [{ key }], truncated: true, cursor: "cycle" });
        if (mode === "foreign_list_key") s.ledger.listOverride = () => ({ objects: [{ key: signalMarkerKey("foreign", signal) }], truncated: false });
        if (["list_failure", "cursor_cycle", "foreign_list_key"].includes(mode)) {
          const first = await s.app("POST", "/privacy/erasures/reapply", { cursor: null });
          if (mode === "cursor_cycle") { assert.equal(first.status, 200); const second = await s.app("POST", "/privacy/erasures/reapply", { cursor: first.body.next_cursor }); assert.equal(second.status, 503); }
          else assert.equal(first.status, 503, JSON.stringify(first));
        } else {
          const blocked = await s.host("POST", "/runs", { signal_id: signal, specialist_id: "lead_concierge", host_run_key: "synthetic-marker-run" });
          assert.equal(blocked.status, 503, JSON.stringify(blocked)); assert.ok(!JSON.stringify(blocked).includes(ORIGINAL));
          assert.equal((await s.app("GET", `/privacy/erasures/${result.body.erasure_id}`)).status, 503);
          if (mode === "missing_signal") {
            const first = await s.app("POST", "/privacy/erasures/reapply", { cursor: null });
            assert.equal(first.status, 200); assert.ok(first.body.next_cursor);
            const audit = await s.app("POST", "/privacy/erasures/reapply", { cursor: first.body.next_cursor });
            assert.equal(audit.status, 503); assert.equal(audit.body.error, "privacy_marker_missing");
          }
        }
      } finally { s.db.raw.close(); }
    });
  }
});

test("exact exceptions pin every schema column, preserve old bodies and refuse all non-erasure runtime writes", async () => {
  const s = setup();
  try {
    const signal = await s.signal(), run = await s.run(signal), live = s.proposal(run, signal), shadow = s.proposal(run, signal, { shadow: true });
    s.db.failSql = /UPDATE agent_signals SET content_json/;
    assert.equal((await s.app("POST")).status, 503); s.db.failSql = null;
    const signalSet = "content_json = json_set(json_remove(content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'))";
    const argsSet = "args_json = json_set(args_json, '$.fields.service', NULL, '$.fields.scope', NULL, '$.fields.address', NULL, '$.fields.timing', NULL, '$.redacted', json('true'))";
    for (const [table, column, id, changed, set] of [["agent_signals", "signal_id", signal, "content_json", signalSet], ["agent_run_steps", "step_id", live, "args_json", argsSet], ["agent_shadow_steps", "shadow_step_id", shadow, "args_json", argsSet]]) {
      const original = s.db.row(table, column, id), cols = s.db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      for (const { name } of cols.filter((v) => v.name !== changed)) {
        const value = original[name] === null ? "synthetic" : typeof original[name] === "number" ? original[name] + 1 : `${original[name]}synthetic`;
        assert.throws(() => s.db.raw.prepare(`UPDATE ${table} SET ${set}, ${name} = ? WHERE ${column} = ?`).run(value, id), /agent_.*(append_only|immutable|decided|erased)/, `${table}.${name}`);
      }
      s.db.raw.exec("SAVEPOINT exact_text"); s.db.raw.prepare(`UPDATE ${table} SET ${set} WHERE ${column} = ?`).run(id);
      assert.throws(() => s.db.raw.prepare(`UPDATE ${table} SET ${set} WHERE ${column} = ?`).run(id)); s.db.raw.exec("ROLLBACK TO exact_text; RELEASE exact_text");
    }
    for (const set of ["args_json = json_set(args_json, '$.fields.service', NULL)", "args_json = json_set(args_json, '$.redacted', json('true'))", "args_json = '{}'", "outcome = 'failed'", "version = version + 1"]) assert.throws(() => s.db.raw.prepare(`UPDATE agent_run_steps SET ${set} WHERE step_id = ?`).run(live));
    assert.throws(() => s.db.raw.prepare("UPDATE agent_runs SET attempt = attempt + 1 WHERE run_id = ?").run(run), /agent_source_erased/);
    assert.throws(() => s.proposal(run, signal, { shadow: true }), /agent_source_erased/);
    assert.throws(() => s.proposal(run, signal), /agent_source_erased/);
    for (const table of ["agent_subject_erasures", "agent_signal_erasures"]) {
      assert.throws(() => s.db.raw.exec(`UPDATE ${table} SET tenant_id = 'foreign'`), /append_only/);
      assert.throws(() => s.db.raw.exec(`DELETE FROM ${table}`), /append_only/);
      const columns = (s.db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((v) => v.name).join(",");
      assert.throws(() => s.db.raw.exec(`INSERT OR REPLACE INTO ${table} (${columns}) SELECT ${columns} FROM ${table}`), /append_only|target_invalid/);
    }
    const oldSignal = readFileSync(new URL("../migrations/0207_agent_signal_redaction.sql", import.meta.url), "utf8");
    const oldDraft = readFileSync(new URL("../migrations/0206_agent_draft_closing.sql", import.meta.url), "utf8");
    const signalSql = (s.db.raw.prepare("SELECT sql FROM sqlite_schema WHERE name = 'prevent_agent_signal_update'").get() as { sql: string }).sql;
    assert.ok(signalSql.includes("OLD.received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')"));
    for (const { name } of s.db.raw.prepare("PRAGMA table_info(agent_signals)").all() as Array<{ name: string }>) if (name !== "content_json") assert.ok(signalSql.includes(`NEW.${name} IS OLD.${name}`), name);
    const draftSql = (s.db.raw.prepare("SELECT sql FROM sqlite_schema WHERE name = 'prevent_decided_agent_step_update'").get() as { sql: string }).sql;
    const oldClause = /\n  AND NOT \([\s\S]*?\n  \)/.exec(oldDraft)![0]; assert.ok(draftSql.includes(oldClause));
    assert.ok(oldSignal.includes("'-90 days'"));
    const result = await s.app("POST"); assert.equal(result.status, 200, JSON.stringify(result));
  } finally { s.db.raw.close(); }
});

test("each overlapping erasure guard independently needs every immutable column pin", async () => {
  const s = setup();
  try {
    const signal = await s.signal(), run = await s.run(signal), live = s.proposal(run, signal), shadow = s.proposal(run, signal, { shadow: true });
    s.db.failSql = /UPDATE agent_signals SET content_json/;
    assert.equal((await s.app("POST")).status, 503); s.db.failSql = null;
    // Isolate the guard under test from FK and overlapping guards in this synthetic SQLite
    // transaction. Each mutation is rolled back; no application/storage policy is bypassed.
    s.db.raw.exec("PRAGMA foreign_keys=OFF");
    const signalSet = "content_json = json_set(json_remove(content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'))";
    const argsSet = "args_json = json_set(args_json, '$.fields.service', NULL, '$.fields.scope', NULL, '$.fields.address', NULL, '$.fields.timing', NULL, '$.redacted', json('true'))";
    const guards = [
      { name: "prevent_agent_signal_update", table: "agent_signals", key: "signal_id", id: signal, changed: "content_json", set: signalSet },
      { name: "prevent_agent_step_proposal_update", table: "agent_run_steps", key: "step_id", id: live, changed: "args_json", set: argsSet },
      { name: "prevent_decided_agent_step_update", table: "agent_run_steps", key: "step_id", id: live, changed: "args_json", set: argsSet },
      { name: "agent_run_steps_erasure_update_guard", table: "agent_run_steps", key: "step_id", id: live, changed: "args_json", set: argsSet },
      { name: "prevent_agent_shadow_step_update", table: "agent_shadow_steps", key: "shadow_step_id", id: shadow, changed: "args_json", set: argsSet },
    ];
    const alternate = (key: string, value: any): string | number => {
      if (key.endsWith("_json")) return key === "sources_json" ? "[]" : '{"synthetic":true}';
      if (key === "kind") return "handoff";
      if (key === "outcome") return "failed";
      if (key === "autonomy") return "A2";
      if (key === "tenant_id") return "foreign";
      if (key === "needs_reviewer_role") return "owner";
      if (key.endsWith("_sha256") || key === "step_key") return hash(`${key}:synthetic-mutant`);
      if (key.endsWith("_at") && typeof value === "string") return new Date(Date.parse(value) + 1).toISOString();
      if (typeof value === "number") return value + 1000;
      return value === null ? "synthetic" : `${value}:synthetic`;
    };
    let mutants = 0;
    for (const guard of guards) {
      const original = s.db.row(guard.table, guard.key, guard.id);
      const sql = (s.db.raw.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(guard.name) as { sql: string }).sql;
      const columns = s.db.raw.prepare(`PRAGMA table_info(${guard.table})`).all() as Array<{ name: string }>;
      for (const { name } of columns.filter((column) => column.name !== guard.changed)) {
        const pin = `    AND NEW.${name} IS OLD.${name}`;
        const erasureClause = guard.name === "prevent_decided_agent_step_update" ? sql.slice(sql.lastIndexOf(") AND NOT (")) : sql;
        assert.equal(erasureClause.split(pin).length, 2, `${guard.name}.${name}: complete erasure pin inventory`);
        const last = sql.lastIndexOf(pin);
        const mutant = sql.slice(0, last) + sql.slice(last + pin.length);
        s.db.raw.exec("SAVEPOINT pin_mutant");
        try {
          if (guard.table === "agent_run_steps") for (const other of ["prevent_agent_step_proposal_update", "prevent_decided_agent_step_update", "agent_run_steps_erasure_update_guard"]) {
            if (other !== guard.name) s.db.raw.exec(`DROP TRIGGER ${other}`);
          }
          const update = () => s.db.raw.prepare(`UPDATE ${guard.table} SET ${guard.set}, ${name} = ? WHERE ${guard.key} = ?`).run(alternate(name, original[name]), guard.id);
          assert.throws(update, /agent_/, `${guard.name}.${name}: original guard must refuse`);
          s.db.raw.exec(`DROP TRIGGER ${guard.name}`); s.db.raw.exec(mutant);
          assert.doesNotThrow(update, `${guard.name}.${name}: removing this pin must expose the otherwise masked mutation`);
          mutants++;
        } finally { s.db.raw.exec("ROLLBACK TO pin_mutant; RELEASE pin_mutant"); }
      }
    }
    console.log(JSON.stringify({ isolated_erasure_pin_mutants_detected: mutants, guards: guards.map((guard) => guard.name) }));
    assert.ok(mutants > 80);
    s.db.raw.exec("PRAGMA foreign_keys=ON");
    assert.equal((await s.app("POST")).status, 200);
  } finally { s.db.raw.close(); }
});
