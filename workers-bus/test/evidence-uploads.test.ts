import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";
import { handleEvidenceUpload, isDisposedDomainLinkRefusal, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_REQUEST_BYTES, resolveEvidenceUploads, type EvidenceScope } from "../src/evidence-uploads.ts";
import { assignCorrectiveAction, reportSafetyOccurrence, verifyCorrectiveAction } from "../src/safety-lifecycle.ts";
import { EVIDENCE_BYTES, EvidenceR2, PrivacyLedgerR2, evidenceUploadRequest, uploadedEvidence } from "./evidence-upload-fixture.ts";

const TENANT = "ironwrap";
const USERS = { owner: "appu_owner_0001", ops: "appu_ops_0001", field: "appu_field_0001", production: "appu_production_1", sales: "appu_sales_0001" };
test("a disposal that wins manifest creation is a definitive refusal, not a store retry", () => {
  assert.equal(isDisposedDomainLinkRefusal(new Error(
    "D1_ERROR: evidence_disposition_blocks_manifest: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)")), true);
  assert.equal(isDisposedDomainLinkRefusal(new Error("D1_ERROR: evidence_disposition_blocks_manifest: SQLITE_ERROR")), false);
  assert.equal(isDisposedDomainLinkRefusal(new Error("D1_ERROR: no such table: SQLITE_ERROR")), false);
});
test("backup and restore inventories require the receipt and corrective manifest guards", () => {
  for (const file of ["backup-d1-to-r2.sh", "restore-d1-from-r2.sh"]) {
    const contract = readFileSync(new URL(`../../deploy/${file}`, import.meta.url), "utf8");
    assert.match(contract, /evidence_upload_manifest_receipt_scope_guard=evidence_upload_manifests/);
    assert.match(contract, /safety_corrective_receipt_manifest_guard=safety_corrective_actions/);
    assert.match(contract, /safety_corrective_receipt_manifest_insert_guard=safety_corrective_actions/);
    assert.match(contract, /evidence_disposed_corrective_insert_guard=safety_corrective_actions/);
    assert.match(contract, /evidence_upload_write_claim_lookup=evidence_upload_write_claims/);
    assert.match(contract, /REQUIRED_TABLES\+?=.*evidence_upload_write_claims/);
    for (const [trigger, table] of [
      ["evidence_upload_write_claim_insert_guard", "evidence_upload_write_claims"],
      ["evidence_upload_write_claim_transition_guard", "evidence_upload_write_claims"],
      ["evidence_upload_write_claim_immutable_delete", "evidence_upload_write_claims"],
      ["evidence_upload_disposition_write_claim_insert_guard", "evidence_upload_dispositions"],
      ["evidence_upload_disposition_write_claim_transition_guard", "evidence_upload_dispositions"],
    ]) assert.ok(contract.includes(`${trigger}=${table}`));
    assert.match(contract, /REQUIRED_TRIGGER_COUNT=740/);
  }
});
class D1 {
  raw = new DatabaseSync(":memory:");
  failReceipt = false;
  failManifest = false;
  failDisposition = false;
  failReverifyOnce = false;
  failEvidenceProjection = false;
  failUnknownWrite = false;
  symptomReadBarrier: (() => Promise<void>) | null = null;
  beforeWriteClaim: (() => Promise<void>) | null = null;
  beforeDisposition: (() => Promise<void>) | null = null;
  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const file of ["0011_app_bff_auth.sql", "0013_field_action_throttles.sql", "0042_external_effect_runtime.sql", "0047_safety_lifecycle.sql", "0056_service_case_lifecycle.sql", "0139_evidence_upload_receipts.sql", "0140_service_case_atomic_steps.sql"]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    this.raw.exec(`ALTER TABLE app_users ADD COLUMN access_role TEXT;
      CREATE TABLE inventory_lots (tenant_id TEXT, lot_id TEXT);
      CREATE TABLE inventory_commands (tenant_id TEXT, command_id TEXT, transition TEXT,
        actor_type TEXT, actor_user_id TEXT, authority_ref TEXT, policy_ref TEXT, policy_version TEXT,
        idempotency_key_sha256 TEXT, request_fingerprint_sha256 TEXT, approval_id TEXT,
        evidence_refs_json TEXT, payload_json TEXT, status TEXT, result_json TEXT,
        rejection_code TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT);
      INSERT INTO inventory_lots VALUES ('ironwrap', 'lot_synthetic_1'), ('ironwrap', 'lot_synthetic_2');
      CREATE TABLE operating_roof_jobs (tenant_id TEXT, roof_job_id TEXT);
      INSERT INTO operating_roof_jobs VALUES ('ironwrap', 'JOB-SYNTHETIC-1'), ('ironwrap', 'JOB-SYNTHETIC-2');`);
    this.raw.exec(readFileSync(new URL("../migrations/0141_evidence_privacy_disposition.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0149_evidence_upload_write_claims.sql", import.meta.url), "utf8"));
    for (const [role, user] of Object.entries(USERS)) {
      this.raw.prepare(`INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,frappe_user_id,active,created_by,created_at,updated_at)
        VALUES (?,? ,?,?, ?,?,?,1,'seed',?,?)`).run(user, TENANT, `${role}@example.invalid`, role,
          ["owner", "field"].includes(role) ? role : "ops", role, `${role}@example.invalid`, new Date().toISOString(), new Date().toISOString());
    }
  }
  prepare(sql: string) {
    const db = this;
    return { bind(...args: unknown[]) {
      return {
        async first<T>() {
          if (db.failEvidenceProjection && sql.startsWith("SELECT * FROM evidence_upload_receipts WHERE tenant_id")) {
            throw new Error("synthetic evidence index outage");
          }
          const row = (db.raw.prepare(sql).get(...args as never[]) ?? null) as T | null;
          if (sql.includes("symptom_code = ? AND state != 'closed'")) await db.symptomReadBarrier?.();
          return row;
        },
        async all<T>() { return { results: db.raw.prepare(sql).all(...args as never[]) as T[] }; },
        async run() {
          if (sql.startsWith("INSERT INTO evidence_upload_write_claims")) await db.beforeWriteClaim?.();
          if (sql.startsWith("INSERT INTO evidence_upload_dispositions")) await db.beforeDisposition?.();
          if (db.failUnknownWrite && sql.includes("SET state = 'unknown'")) throw new Error("synthetic claim transition outage");
          if (db.failReceipt && sql.startsWith("INSERT INTO evidence_upload_receipts")) throw new Error("synthetic D1 receipt outage");
          if (db.failManifest && sql.startsWith("INSERT INTO evidence_upload_manifests")) throw new Error("synthetic D1 manifest outage");
          if (db.failDisposition && sql.includes("INSERT INTO evidence_upload_dispositions")) throw new Error("synthetic D1 disposition outage");
          if (db.failReverifyOnce && sql.includes("SET reappearance_reverified_at")) {
            db.failReverifyOnce = false;
            throw new Error("synthetic D1 reverify outage");
          }
          const before = (db.raw.prepare("SELECT total_changes() AS total").get() as { total: number }).total;
          db.raw.prepare(sql).run(...args as never[]);
          const after = (db.raw.prepare("SELECT total_changes() AS total").get() as { total: number }).total;
          return { success: true, meta: { changes: after - before } };
        },
      };
    } };
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}
function fixture() {
  const db = new D1(); const raw = new EvidenceR2(); const ledger = new PrivacyLedgerR2();
  const env = { DB: db, RAW: raw, PRIVACY_LEDGER: ledger, APP_ALLOW_INSECURE_LOCAL: "true", APP_EVIDENCE_UPLOADS_ENABLED: "true", APP_EVIDENCE_RECEIPTS_REQUIRED: "true" } as never as AppEnv;
  return { db, raw, ledger, env };
}
function auth(role: keyof typeof USERS = "ops", tenantId = TENANT): AuthContext {
  return { csrfToken: "csrf", rawSessionToken: "s".repeat(43), permissions: [],
    session: { user_id: USERS[role], tenant_id: tenantId, role, active: 1 } } as AuthContext;
}
const STOCK: EvidenceScope = { purpose: "stock", targetId: "lot_synthetic_1", action: "receive", operationId: "cmd_synthetic_01" };
const INTAKE: EvidenceScope = { purpose: "service_intake", targetId: "JOB-SYNTHETIC-1", action: "open", operationId: "intake-synthetic-1" };
async function responseBody(response: Response) { return await response.json() as { error?: string; receipt?: { receipt_id: string }; result?: string; service_case?: { service_case_id: string; state: string; intake_evidence_digest: string } }; }
function command(path: string, body: unknown, key = INTAKE.operationId): Request {
  return new Request(`https://app.example.invalid${path}`, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "csrf", "idempotency-key": key }, body: JSON.stringify(body) });
}
function read(path: string): Request { return new Request(`https://app.example.invalid${path}`); }
function contentPath(id: string): string { return `/api/v1/evidence-uploads/${id}/content`; }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const intakeBody = (id: string) => ({ customer_id: "CUSTOMER-SYNTHETIC", property_key: "PROPERTY-SYNTHETIC", roof_job_id: INTAKE.targetId,
  severity: "standard", symptom_code: "synthetic_leak", reported_channel: "phone", consent_ref: "consent-synthetic", response_sla_minutes: 60, evidence_receipt_ids: [id] });

test("Worker hashes non-UTF8 binary bytes; stored body is rehashed and tampering fails with unchanged metadata", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const receipt = db.raw.prepare("SELECT * FROM evidence_upload_receipts WHERE receipt_id = ?").get(id) as { sha256: string; r2_key: string; byte_size: number };
  assert.equal(receipt.sha256, createHash("sha256").update(EVIDENCE_BYTES).digest("hex"));
  assert.notEqual(receipt.sha256, createHash("sha256").update(new TextDecoder().decode(EVIDENCE_BYTES)).digest("hex"));
  assert.equal(receipt.byte_size, EVIDENCE_BYTES.length);
  const resolved = await resolveEvidenceUploads(env, auth(), STOCK, [id]);
  assert.deepEqual(resolved.refs, [{ ref: `evidence-upload://${id}`, sha256: receipt.sha256 }]);
  raw.rows.get(receipt.r2_key)!.bytes[14] ^= 1;
  await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, [id]), /evidence_object_mismatch/);
});

test("same upload key + scope + bytes returns original receipt; bytes, name and target changes conflict", async () => {
  const { db, raw, env } = fixture();
  const key = "synthetic-upload-1";
  const first = await responseBody(await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth()));
  const replay = await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  assert.equal(replay.status, 200); assert.equal((await responseBody(replay)).receipt?.receipt_id, first.receipt?.receipt_id);
  assert.equal(raw.puts, 1);
  for (const [scope, options] of [
    [{ ...STOCK, targetId: "lot_synthetic_2" }, {}],
    [STOCK, { name: "other-name.png" }],
    [STOCK, { bytes: new Uint8Array([...EVIDENCE_BYTES, 20]) }],
  ] as const) {
    const changed = await handleEvidenceUpload(evidenceUploadRequest(scope, key, options), env, auth());
    assert.equal(changed.status, 409); assert.equal((await responseBody(changed)).error, "evidence_upload_conflict");
  }
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get() as { n: number }).n, 1);
});

test("a competing R2 create cannot replace bytes after the upload's first read", async () => {
  const { db, raw, env } = fixture();
  const originalPut = raw.put.bind(raw);
  const competingBytes = new Uint8Array([...EVIDENCE_BYTES, 42]);
  raw.put = async (key, bytes, options) => {
    raw.rows.set(key, {
      bytes: competingBytes,
      httpMetadata: { contentType: "image/png" },
      customMetadata: { sha256: "b".repeat(64), request_sha256: "competing-request" },
    });
    return originalPut(key, bytes, options);
  };
  const response = await handleEvidenceUpload(evidenceUploadRequest(STOCK, "synthetic-create-race"), env, auth());
  assert.equal(response.status, 409);
  assert.equal((await responseBody(response)).error, "evidence_object_mismatch");
  assert.equal(raw.rows.size, 1);
  assert.deepEqual([...raw.rows.values()][0]!.bytes, competingBytes);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get() as { n: number }).n, 0);
});

for (const boundary of ["read", "put"] as const) {
  test(`disposal cannot prove destruction while a cold upload is paused at RAW ${boundary}`, async () => {
    const { db, raw, ledger, env } = fixture();
    const entered = deferred(); const resume = deferred();
    let paused = false;
    const originalGet = raw.get.bind(raw); const originalPut = raw.put.bind(raw);
    const pause = async () => { if (!paused) { paused = true; entered.resolve(); await resume.promise; } };
    if (boundary === "read") raw.get = async (key) => { await pause(); return originalGet(key); };
    else raw.put = async (key, bytes, options) => { await pause(); return originalPut(key, bytes, options); };
    const key = `synthetic-inflight-${boundary}`;
    const delayed = handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
    await entered.promise;
    let id = ""; let hash = ""; let r2Key = "";
    try {
      id = await uploadedEvidence(env, auth(), STOCK, key);
      const receipt = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
        .get(id) as { sha256: string; r2_key: string };
      hash = receipt.sha256; r2Key = receipt.r2_key;
      const disposal = await handleAuthenticatedRoute(privacyCommand(
        `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(hash)), env, auth("owner"));
      assert.equal(disposal.status, 409);
      assert.equal((await responseBody(disposal)).error, "evidence_upload_write_pending");
      assert.equal(db.raw.prepare("SELECT state FROM evidence_upload_dispositions WHERE receipt_id = ?").get(id), undefined);
      assert.equal(ledger.rows.size, 0);
      assert.equal(raw.rows.has(r2Key), true);
      const inspection = await handleAuthenticatedRoute(read(
        `/api/v1/privacy/evidence-uploads/write-claims?receipt_id=${id}`), env, auth("owner"));
      assert.equal(inspection.status, 200);
      const claims = await inspection.json() as { claims: Array<{ state: string; receipt_id: string }> };
      assert.equal(claims.claims.length, 1);
      assert.equal(claims.claims[0]!.state, "active");
      assert.equal(claims.claims[0]!.receipt_id, id);
    } finally { resume.resolve(); }
    assert.equal((await delayed).status, 200);
    const disposal = await handleAuthenticatedRoute(privacyCommand(
      `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(hash)), env, auth("owner"));
    assert.equal(disposal.status, 200);
    assert.equal(raw.rows.has(r2Key), false);
    assert.equal(ledger.rows.size, 1);
    assert.equal((await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth())).status, 410);
    assert.equal(raw.rows.has(r2Key), false);
  });
}

test("an owner can hold evidence while a cold PUT is pending, without a compensating delete", async () => {
  const { db, raw, env } = fixture();
  const entered = deferred(); const resume = deferred();
  const originalPut = raw.put.bind(raw); let paused = false;
  raw.put = async (key, bytes, options) => {
    if (!paused) { paused = true; entered.resolve(); await resume.promise; }
    return originalPut(key, bytes, options);
  };
  const key = "synthetic-held-inflight-upload";
  const delayed = handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  await entered.promise;
  let id = ""; let hash = ""; let r2Key = "";
  const hold = { hold_id: "hold-inflight-upload", reason: "Preserve this proof during legal review" };
  try {
    id = await uploadedEvidence(env, auth(), STOCK, key);
    const receipt = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
      .get(id) as { sha256: string; r2_key: string };
    hash = receipt.sha256; r2Key = receipt.r2_key;
    const held = await handleAuthenticatedRoute(privacyCommand(
      `/api/v1/privacy/evidence-uploads/${id}/holds`, hold), env, auth("owner"));
    assert.equal(held.status, 201);
    const refused = await handleAuthenticatedRoute(privacyCommand(
      `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(hash)), env, auth("owner"));
    assert.equal(refused.status, 409);
    assert.equal((await responseBody(refused)).error, "evidence_legal_hold_active");
  } finally { resume.resolve(); }
  assert.equal((await delayed).status, 200);
  assert.equal(raw.rows.has(r2Key), true);
  assert.equal((db.raw.prepare("SELECT active FROM evidence_upload_holds WHERE hold_id = ?").get(hold.hold_id) as { active: number }).active, 1);
});

test("a disposition that commits before the cold-upload claim prevents any RAW write", async () => {
  const { db, raw, env } = fixture();
  const entered = deferred(); const resume = deferred(); let paused = false;
  db.beforeWriteClaim = async () => {
    if (!paused) { paused = true; entered.resolve(); await resume.promise; }
  };
  const key = "synthetic-disposition-before-claim";
  const delayed = handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  await entered.promise;
  let r2Key = "";
  try {
    const id = await uploadedEvidence(env, auth(), STOCK, key);
    const receipt = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
      .get(id) as { sha256: string; r2_key: string };
    r2Key = receipt.r2_key;
    const disposed = await handleAuthenticatedRoute(privacyCommand(
      `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256)), env, auth("owner"));
    assert.equal(disposed.status, 200);
  } finally { resume.resolve(); }
  assert.equal((await delayed).status, 410);
  assert.equal(raw.puts, 1);
  assert.equal(raw.rows.has(r2Key), false);
});

test("a claim arriving after disposal prechecks still blocks the atomic D1 decision insert", async () => {
  const { db, raw, ledger, env } = fixture();
  const atClaim = deferred(); const resumeClaim = deferred();
  const atDecision = deferred(); const resumeDecision = deferred();
  const atRead = deferred(); const resumeRead = deferred();
  let claimPaused = false; let decisionPaused = false; let pauseRead = false;
  db.beforeWriteClaim = async () => {
    if (!claimPaused) { claimPaused = true; atClaim.resolve(); await resumeClaim.promise; }
  };
  db.beforeDisposition = async () => {
    if (!decisionPaused) { decisionPaused = true; atDecision.resolve(); await resumeDecision.promise; }
  };
  const originalGet = raw.get.bind(raw);
  raw.get = async (key) => {
    if (pauseRead) { pauseRead = false; atRead.resolve(); await resumeRead.promise; }
    return originalGet(key);
  };
  const key = "synthetic-claim-after-disposal-prechecks";
  const delayed = handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  await atClaim.promise;
  let disposal!: Promise<Response>;
  try {
    const id = await uploadedEvidence(env, auth(), STOCK, key);
    const receipt = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
      .get(id) as { sha256: string; r2_key: string };
    disposal = handleAuthenticatedRoute(privacyCommand(
      `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256)), env, auth("owner"));
    await atDecision.promise;
    pauseRead = true; resumeClaim.resolve(); await atRead.promise;
    resumeDecision.resolve();
    const refused = await disposal;
    assert.equal(refused.status, 409);
    assert.equal((await responseBody(refused)).error, "evidence_upload_write_pending");
    assert.equal(ledger.rows.size, 0);
  } finally { resumeClaim.resolve(); resumeDecision.resolve(); resumeRead.resolve(); }
  assert.equal((await delayed).status, 200);
});

test("a rejected RAW PUT retains an inspectable unknown claim and is never auto-settled", async () => {
  const { db, raw, env } = fixture();
  const originalPut = raw.put.bind(raw);
  raw.put = async (key, bytes, options) => {
    await originalPut(key, bytes, options);
    throw new Error("synthetic acknowledgement lost after provider accepted bytes");
  };
  const key = "synthetic-unknown-upload-outcome";
  const upload = await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  assert.equal(upload.status, 502);
  assert.equal((await responseBody(upload)).error, "evidence_upload_write_outcome_unknown");
  assert.equal(raw.rows.size, 1);
  assert.equal(db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get()!.n, 0);
  const inspection = await handleAuthenticatedRoute(read(
    "/api/v1/privacy/evidence-uploads/write-claims"), env, auth("owner"));
  assert.equal(inspection.status, 200);
  const body = await inspection.json() as { claims: Array<{ state: string; failure_code: string; settled_at: string | null }> };
  assert.equal(body.claims.length, 1);
  assert.equal(body.claims[0]!.state, "unknown");
  assert.equal(body.claims[0]!.failure_code, "raw_put_outcome_unknown");
  assert.equal(body.claims[0]!.settled_at, null);
  raw.put = originalPut;
  const retry = await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  assert.equal(retry.status, 409);
  assert.equal((await responseBody(retry)).error, "evidence_upload_write_outcome_unknown");
  assert.equal(raw.puts, 1);
  assert.equal((await handleAuthenticatedRoute(read(
    "/api/v1/privacy/evidence-uploads/write-claims"), env, auth())).status, 403);
  assert.equal((await handleAuthenticatedRoute(read(
    "/api/v1/privacy/evidence-uploads/write-claims"), env, auth("owner", "other-tenant"))).status, 403);
  assert.throws(() => db.raw.prepare(`UPDATE evidence_upload_write_claims
    SET state = 'settled', failure_code = NULL, settled_at = ?`).run(new Date().toISOString()),
    /evidence_upload_write_claim_transition_invalid/);
});

test("a provider PUT may finish after rejection without releasing its unknown fence", async () => {
  const { db, raw, env } = fixture();
  const originalPut = raw.put.bind(raw);
  let finishProviderWrite!: () => ReturnType<typeof originalPut>;
  raw.put = async (key, bytes, options) => {
    finishProviderWrite = () => originalPut(key, bytes, options);
    throw new Error("synthetic response lost while provider still owns the request");
  };
  const upload = await handleEvidenceUpload(evidenceUploadRequest(STOCK, "synthetic-late-provider-completion"), env, auth());
  assert.equal(upload.status, 502);
  assert.equal((await responseBody(upload)).error, "evidence_upload_write_outcome_unknown");
  assert.equal(raw.rows.size, 0);
  await finishProviderWrite();
  assert.equal(raw.rows.size, 1);
  assert.equal(db.raw.prepare("SELECT state FROM evidence_upload_write_claims").get()!.state, "unknown");
  assert.equal(db.raw.prepare("SELECT settled_at FROM evidence_upload_write_claims").get()!.settled_at, null);
});

test("an unknown-state D1 outage retains the active fence with an actionable exception", async () => {
  const { db, raw, env } = fixture();
  db.failUnknownWrite = true; raw.failPut = true;
  const upload = await handleEvidenceUpload(evidenceUploadRequest(STOCK, "synthetic-unknown-state-outage"), env, auth());
  assert.equal(upload.status, 502);
  const failure = await upload.json() as { error: string; claim_audit: string; exception: string };
  assert.equal(failure.error, "evidence_upload_write_outcome_unknown");
  assert.equal(failure.exception, "provider_quiescence_evidence_required");
  const inspection = await handleAuthenticatedRoute(read(failure.claim_audit), env, auth("owner"));
  assert.equal(inspection.status, 200);
  const claims = (await inspection.json() as { claims: Array<{ state: string }> }).claims;
  assert.equal(claims.length, 1); assert.equal(claims[0]!.state, "active");
});

test("pending claim inspection is bounded, paginated and isolated from another active tenant owner", async () => {
  const { db, raw, env } = fixture();
  raw.failPut = true;
  for (const key of ["synthetic-page-claim-one", "synthetic-page-claim-two"]) {
    assert.equal((await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth())).status, 502);
  }
  const path = "/api/v1/privacy/evidence-uploads/write-claims";
  const page = await handleAuthenticatedRoute(read(`${path}?limit=1`), env, auth("owner"));
  const first = await page.json() as { claims: Array<{ claim_id: string }>; next_cursor: string; automatic_expiry: boolean };
  assert.equal(first.claims.length, 1); assert.equal(first.automatic_expiry, false); assert.ok(first.next_cursor);
  const next = await handleAuthenticatedRoute(read(`${path}?limit=1&cursor=${first.next_cursor}`), env, auth("owner"));
  const second = await next.json() as { claims: Array<{ claim_id: string }>; next_cursor: string | null };
  assert.equal(second.claims.length, 1); assert.equal(second.next_cursor, null);
  assert.notEqual(first.claims[0]!.claim_id, second.claims[0]!.claim_id);
  db.raw.exec(`INSERT INTO app_users
    (user_id, tenant_id, email_normalized, display_name, role, access_role, frappe_user_id, active, created_by, created_at, updated_at)
    VALUES ('appu_other_owner', 'other-tenant', 'other-owner@example.invalid', 'Other synthetic owner',
      'owner', 'owner', 'other-owner@example.invalid', 1, 'seed', 'synthetic-now', 'synthetic-now')`);
  const other = auth("owner", "other-tenant"); other.session.user_id = "appu_other_owner";
  const isolated = await handleAuthenticatedRoute(read(path), env, other);
  assert.equal(isolated.status, 200);
  assert.deepEqual((await isolated.json() as { claims: unknown[] }).claims, []);
  for (const query of ["limit=51", "cursor=not-a-claim", "receipt_id=other"]) {
    assert.equal((await handleAuthenticatedRoute(read(`${path}?${query}`), env, auth("owner"))).status, 400);
  }
});

test("an ambiguous writer still blocks disposal after another attempt created the receipt", async () => {
  const { db, raw, env } = fixture();
  const entered = deferred(); const resume = deferred(); let paused = false;
  const originalPut = raw.put.bind(raw);
  raw.put = async (key, bytes, options) => {
    if (!paused) {
      paused = true; entered.resolve(); await resume.promise;
      await originalPut(key, bytes, options);
      throw new Error("synthetic ambiguous write acknowledgement");
    }
    return originalPut(key, bytes, options);
  };
  const key = "synthetic-ambiguous-writer-with-receipt";
  const delayed = handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  await entered.promise;
  let id = "";
  try { id = await uploadedEvidence(env, auth(), STOCK, key); }
  finally { resume.resolve(); }
  assert.equal((await delayed).status, 502);
  const receipt = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string; r2_key: string };
  const base = `/api/v1/privacy/evidence-uploads/${id}`;
  const refused = await handleAuthenticatedRoute(privacyCommand(
    `${base}/destruction`, destroyBody(receipt.sha256)), env, auth("owner"));
  assert.equal(refused.status, 409);
  const refusal = await refused.json() as { error: string; unknown_write_claims: number; claim_audit: string; exception: string };
  assert.equal(refusal.error, "evidence_upload_write_pending");
  assert.equal(refusal.unknown_write_claims, 1);
  assert.equal(refusal.exception, "provider_quiescence_evidence_required");
  assert.equal(refusal.claim_audit, `/api/v1/privacy/evidence-uploads/write-claims?receipt_id=${id}`);
  const hold = { hold_id: "hold-ambiguous-upload", reason: "Preserve this proof while provider outcome is investigated" };
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/holds`, hold), env, auth("owner"))).status, 201);
  const held = await handleAuthenticatedRoute(privacyCommand(`${base}/destruction`, destroyBody(receipt.sha256)), env, auth("owner"));
  assert.equal((await responseBody(held)).error, "evidence_legal_hold_active");
  assert.equal(raw.rows.has(receipt.r2_key), true);
  assert.equal(db.raw.prepare("SELECT state FROM evidence_upload_dispositions WHERE receipt_id = ?").get(id), undefined);
});

test("write claims bind the exact tenant, actor, request and RAW key and only settle once", async () => {
  const { db, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const settled = db.raw.prepare("SELECT * FROM evidence_upload_write_claims WHERE receipt_id = ?")
    .get(id) as { claim_id: string; tenant_id: string; actor_user_id: string; request_sha256: string; r2_key: string; state: string; settled_at: string };
  assert.equal(settled.state, "settled"); assert.ok(settled.settled_at);
  assert.throws(() => db.raw.prepare("UPDATE evidence_upload_write_claims SET state = 'active', settled_at = NULL").run(),
    /evidence_upload_write_claim_transition_invalid/);
  assert.throws(() => db.raw.prepare("DELETE FROM evidence_upload_write_claims").run(), /evidence_upload_write_claim_immutable/);
  const insert = db.raw.prepare(`INSERT OR REPLACE INTO evidence_upload_write_claims
    (claim_id, tenant_id, receipt_id, actor_user_id, request_sha256, r2_key, started_at, last_transition_at, state)
    VALUES (?, ?, ?, ?, ?, ?, 'synthetic-start', 'synthetic-start', 'active')`);
  const attempt = (change: Partial<typeof settled> = {}) => {
    const row = { ...settled, claim_id: `ewc_${crypto.randomUUID()}`, ...change };
    return insert.run(row.claim_id, row.tenant_id, id, row.actor_user_id, row.request_sha256, row.r2_key);
  };
  for (const change of [{ tenant_id: "other-tenant" }, { actor_user_id: USERS.owner },
    { request_sha256: "f".repeat(64) }, { r2_key: "evidence/v1/wrong-object.bin" }, { claim_id: settled.claim_id }]) {
    assert.throws(() => attempt(change), /evidence_upload_write_claim_invalid|CHECK constraint failed/);
  }
  attempt();
  const active = db.raw.prepare("SELECT claim_id FROM evidence_upload_write_claims WHERE state = 'active'").get() as { claim_id: string };
  assert.throws(() => db.raw.prepare("UPDATE evidence_upload_write_claims SET request_sha256 = ? WHERE claim_id = ?")
    .run("e".repeat(64), active.claim_id), /evidence_upload_write_claim_transition_invalid/);
});

test("a real SQLite backup preserves unresolved claims and their disposal fences", async () => {
  const { db, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  db.raw.prepare(`INSERT INTO evidence_upload_write_claims
    (claim_id, tenant_id, receipt_id, actor_user_id, request_sha256, r2_key, started_at, last_transition_at, state)
    SELECT ?, tenant_id, receipt_id, actor_user_id, request_sha256, r2_key, ?, ?, 'active'
      FROM evidence_upload_receipts WHERE receipt_id = ?`)
    .run(`ewc_${crypto.randomUUID()}`, "synthetic-start", "synthetic-start", id);
  db.raw.exec(`UPDATE evidence_upload_write_claims SET state = 'unknown', failure_code = 'raw_put_outcome_unknown',
    last_transition_at = 'synthetic-unknown' WHERE state = 'active'`);
  const directory = mkdtempSync(join(tmpdir(), "ironwrap-evidence-claim-"));
  let restored: DatabaseSync | undefined;
  try {
    const snapshot = join(directory, "backup.sqlite3");
    db.raw.prepare("VACUUM INTO ?").run(snapshot);
    restored = new DatabaseSync(snapshot);
    restored.exec("PRAGMA foreign_keys = ON");
    assert.equal(restored.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    assert.equal(restored.prepare("SELECT count(*) AS n FROM evidence_upload_write_claims WHERE state = 'unknown'").get()!.n, 1);
    assert.throws(() => restored!.prepare(`INSERT INTO evidence_upload_dispositions
      (receipt_id, tenant_id, decision_id, basis, authority_ref, policy_version, reason,
        requested_by, requested_at, last_actor_user_id, last_transition_at, state)
      VALUES (?, ?, 'decision-restored-claim', 'manual_correction', 'privacy-synthetic', 'manual-v1',
        'Approved exact receipt destruction', ?, 'synthetic-now', ?, 'synthetic-now', 'destroying')`)
      .run(id, TENANT, USERS.owner, USERS.owner), /evidence_upload_write_pending/);
    assert.throws(() => restored!.exec("DELETE FROM evidence_upload_write_claims"), /evidence_upload_write_claim_immutable/);
    assert.throws(() => restored!.exec(`UPDATE evidence_upload_write_claims SET state = 'settled',
      failure_code = NULL, settled_at = 'synthetic-later' WHERE state = 'unknown'`), /evidence_upload_write_claim_transition_invalid/);
  } finally { restored?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an exact replay never restores bytes after an immutable receipt was disposed", async () => {
  const { db, raw, env } = fixture();
  const key = "synthetic-disposal-race";
  const id = await uploadedEvidence(env, auth(), STOCK, key);
  const receipt = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string; r2_key: string };
  const originalGet = raw.get.bind(raw);
  let disposed = false;
  raw.get = async (objectKey) => {
    if (!disposed) {
      disposed = true;
      const response = await handleAuthenticatedRoute(privacyCommand(
        `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256)), env, auth("owner"));
      assert.equal(response.status, 200);
    }
    return originalGet(objectKey);
  };
  const putsBeforeReplay = raw.puts;
  const replay = await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  assert.equal(replay.status, 410);
  assert.equal((await responseBody(replay)).error, "evidence_destroyed");
  assert.equal(raw.puts, putsBeforeReplay);
  assert.equal(raw.rows.has(receipt.r2_key), false);
});

test("R2 success followed by D1 failure is recoverable only with the original upload intent", async () => {
  const { db, raw, env } = fixture(); db.failReceipt = true;
  const key = "synthetic-recovery-1";
  assert.equal((await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth())).status, 502);
  assert.equal(raw.rows.size, 1); assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get() as { n: number }).n, 0);
  const changed = await handleEvidenceUpload(evidenceUploadRequest({ ...STOCK, action: "quarantine" }, key), env, auth());
  assert.equal(changed.status, 409); assert.equal((await responseBody(changed)).error, "evidence_upload_conflict");
  db.failReceipt = false;
  const recovered = await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), env, auth());
  assert.equal(recovered.status, 201); assert.equal(raw.puts, 1);
  await resolveEvidenceUploads(env, auth(), STOCK, [(await responseBody(recovered)).receipt!.receipt_id]);
});

test("R2 failure never creates a receipt and missing bytes never resolve", async () => {
  const { db, raw, env } = fixture(); raw.failPut = true;
  assert.equal((await handleEvidenceUpload(evidenceUploadRequest(STOCK), env, auth())).status, 502);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get() as { n: number }).n, 0);
  raw.failPut = false;
  const id = await uploadedEvidence(env, auth(), STOCK); raw.rows.clear();
  await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, [id]), /evidence_object_missing/);
});

test("tenant, actor, purpose, target, action and operation are all enforced on resolution", async () => {
  const { env } = fixture(); const id = await uploadedEvidence(env, auth(), STOCK);
  for (const scope of [{ ...STOCK, targetId: "lot_synthetic_2" }, { ...STOCK, action: "quarantine" }, { ...STOCK, operationId: "cmd_synthetic_02" }, INTAKE]) {
    await assert.rejects(resolveEvidenceUploads(env, auth(), scope, [id]), /evidence_receipt_scope_mismatch/);
  }
  await assert.rejects(resolveEvidenceUploads(env, auth("owner"), STOCK, [id]), /evidence_receipt_scope_mismatch/);
  await assert.rejects(resolveEvidenceUploads(env, auth("ops", "other-tenant"), STOCK, [id]), /evidence_actor_inactive/);
  for (const ids of [[], [id, id], ["missing"], [id,id,id,id,id]]) await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, ids), /evidence_receipts_required/);
});

test("stock readback exposes linked metadata and serves only applied, authorized, verified bytes", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 404);
  const resolved = await resolveEvidenceUploads(env, auth(), STOCK, [id]);
  db.raw.prepare(`INSERT INTO inventory_commands (tenant_id, command_id, transition, evidence_refs_json, status)
    VALUES (?, ?, ?, ?, ?)`)
    .run(TENANT, STOCK.operationId, STOCK.action, resolved.refsJson, "pending");
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 404);
  db.raw.prepare("UPDATE inventory_commands SET status = 'applied'").run();
  const detail = await handleAuthenticatedRoute(read(`/api/v1/inventory/commands/${STOCK.operationId}`), env, auth());
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { evidence_files: unknown; evidence_files_unavailable: boolean };
  assert.deepEqual(detailBody.evidence_files, [{
    receipt_id: id, file_name: "synthetic-proof.png", content_type: "image/png", byte_size: EVIDENCE_BYTES.length,
  }]);
  assert.equal(detailBody.evidence_files_unavailable, false);
  db.failEvidenceProjection = true;
  const unavailable = await handleAuthenticatedRoute(read(`/api/v1/inventory/commands/${STOCK.operationId}`), env, auth());
  assert.equal(unavailable.status, 200);
  const unavailableBody = await unavailable.json() as { command: { status: string };
    evidence_files: unknown[]; evidence_files_unavailable: boolean };
  assert.equal(unavailableBody.command.status, "applied");
  assert.deepEqual(unavailableBody.evidence_files, []);
  assert.equal(unavailableBody.evidence_files_unavailable, true);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 502);
  db.failEvidenceProjection = false;
  db.raw.prepare("UPDATE inventory_commands SET evidence_refs_json = ? WHERE command_id = ?")
    .run("not-json", STOCK.operationId);
  const brokenLink = await handleAuthenticatedRoute(read(`/api/v1/inventory/commands/${STOCK.operationId}`), env, auth());
  assert.equal(brokenLink.status, 200);
  assert.equal((await brokenLink.json() as { evidence_files_unavailable: boolean }).evidence_files_unavailable, true);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 502);
  db.raw.prepare("UPDATE inventory_commands SET evidence_refs_json = ? WHERE command_id = ?")
    .run(resolved.refsJson, STOCK.operationId);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth("sales"))).status, 403);
  const content = await handleAuthenticatedRoute(read(contentPath(id)), env, auth());
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "image/png");
  assert.equal(content.headers.get("cache-control"), "private, no-store");
  assert.equal(content.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await content.arrayBuffer()), EVIDENCE_BYTES);
  db.raw.exec("UPDATE app_users SET access_role = 'sales' WHERE user_id = 'appu_ops_0001'");
  assert.equal((await handleAuthenticatedRoute(read(`/api/v1/inventory/commands/${STOCK.operationId}`), env, auth())).status, 403);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 403);
  db.raw.exec("UPDATE app_users SET access_role = 'ops' WHERE user_id = 'appu_ops_0001'");
  db.raw.prepare(`INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,
    frappe_user_id,active,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,'seed',?,?)`)
    .run("appu_other_0001", "other-tenant", "other@example.invalid", "other", "ops", "ops",
      "other@example.invalid", new Date().toISOString(), new Date().toISOString());
  const other = auth(); other.session.user_id = "appu_other_0001"; other.session.tenant_id = "other-tenant";
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, other)).status, 404);
  raw.rows.values().next().value!.bytes[14] ^= 1;
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 409);
});

test("upload requires CSRF, active permitted role, permitted Field transition and a tenant-owned target", async () => {
  const { db, env } = fixture();
  for (const [actor, scope, options, status, code] of [
    [auth(), STOCK, { csrf: false }, 403, "csrf_failed"],
    [auth("sales"), STOCK, {}, 403, "inventory_write_role_required"],
    [auth("production"), INTAKE, {}, 403, "office_role_required"],
    [auth("field"), STOCK, {}, 403, "inventory_transition_role_required"],
    [auth(), { ...STOCK, targetId: "not-a-real-lot" }, {}, 404, "evidence_target_not_found"],
  ] as const) {
    const res = await handleEvidenceUpload(evidenceUploadRequest(scope, crypto.randomUUID(), options), env, actor);
    assert.equal(res.status, status); assert.equal((await responseBody(res)).error, code);
  }
  for (const action of ["issue_use", "return", "quarantine"]) await uploadedEvidence(env, auth("field"), { ...STOCK, action });
  db.raw.exec("UPDATE app_users SET active = 0 WHERE user_id = 'appu_ops_0001'");
  assert.equal((await handleEvidenceUpload(evidenceUploadRequest(STOCK), env, auth())).status, 403);
});

test("MIME signature, file size, actual streamed request size and caller-supplied hashes are bounded", async () => {
  const { env } = fixture();
  for (const [options, status, code] of [
    [{ type: "text/html" }, 415, "evidence_type_unsupported"],
    [{ type: "image/jpeg" }, 415, "evidence_type_mismatch"],
    [{ bytes: new Uint8Array() }, 413, "evidence_file_size_invalid"],
    [{ bytes: new Uint8Array(MAX_EVIDENCE_FILE_BYTES + 1) }, 413, "evidence_file_size_invalid"],
    [{ extra: ["sha256", "0".repeat(64)] as [string,string] }, 400, "unexpected_field"],
  ] as const) {
    const res = await handleEvidenceUpload(evidenceUploadRequest(STOCK, crypto.randomUUID(), options), env, auth());
    assert.equal(res.status, status); assert.equal((await responseBody(res)).error, code);
  }
  const req = new Request("https://app.example.invalid/api/v1/evidence-uploads", { method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x", "idempotency-key": "synthetic-large-1", "x-csrf-token": "csrf", "content-length": "1" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_EVIDENCE_REQUEST_BYTES + 1)); controller.close(); } }), duplex: "half" } as RequestInit);
  const large = await handleEvidenceUpload(req, env, auth());
  assert.equal(large.status, 413); assert.equal((await responseBody(large)).error, "payload_too_large");
});

test("field permits eight uploads; office permits sixteen attempts including exact replays", async () => {
  const field = fixture();
  const fieldScope = { ...STOCK, action: "issue_use" };
  for (let i = 0; i < 8; i++) await uploadedEvidence(field.env, auth("field"), fieldScope);
  const fieldDenied = await handleEvidenceUpload(evidenceUploadRequest(fieldScope), field.env, auth("field"));
  assert.equal(fieldDenied.status, 429);
  assert.ok(Number(fieldDenied.headers.get("retry-after")) > 0);
  assert.equal(field.raw.rows.size, 8);

  const office = fixture();
  const key = "office-exact-replay";
  await uploadedEvidence(office.env, auth(), STOCK, key);
  for (let i = 0; i < 14; i++) await uploadedEvidence(office.env, auth(), STOCK);
  assert.equal((await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), office.env, auth())).status, 200);
  const officeDenied = await handleEvidenceUpload(evidenceUploadRequest(STOCK), office.env, auth());
  assert.equal(officeDenied.status, 429);
  assert.ok(Number(officeDenied.headers.get("retry-after")) > 0);
  assert.equal(office.raw.rows.size, 15);
});

test("D1 receipt and manifest facts cannot be updated, deleted or replaced", async () => {
  const { db, env } = fixture(); const id = await uploadedEvidence(env, auth(), STOCK);
  const resolved = await resolveEvidenceUploads(env, auth(), STOCK, [id]);
  for (const table of ["evidence_upload_receipts", "evidence_upload_manifests"]) {
    assert.throws(() => db.raw.exec(`UPDATE ${table} SET tenant_id = 'other-tenant'`), /immutable/);
    assert.throws(() => db.raw.exec(`DELETE FROM ${table}`), /immutable/);
    assert.throws(() => db.raw.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`), /immutable/);
  }
  assert.equal((db.raw.prepare("SELECT refs_json FROM evidence_upload_manifests WHERE sha256 = ?").get(resolved.sha256) as { refs_json: string }).refs_json, resolved.refsJson);
});

test("D1 rejects a forged upload manifest before it can authorize a business reference", async () => {
  const { db, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const receipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string };
  const insert = db.raw.prepare(`INSERT INTO evidence_upload_manifests
    (sha256, tenant_id, actor_user_id, purpose, target_id, action, operation_id, refs_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const refsJson = JSON.stringify([{ ref: `evidence-upload://${id}`, sha256: receipt.sha256 }]);
  for (const [actor, target, refs] of [
    [USERS.owner, STOCK.targetId, refsJson],
    [USERS.ops, "lot_synthetic_2", refsJson],
    [USERS.ops, STOCK.targetId, JSON.stringify([{ ref: `evidence-upload://${id}`, sha256: "a".repeat(64) }])],
  ]) {
    assert.throws(() => insert.run("f".repeat(64), TENANT, actor, STOCK.purpose, target,
      STOCK.action, STOCK.operationId, refs, new Date().toISOString()),
    /evidence_manifest_receipt_scope_invalid/);
  }
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_manifests").get() as { n: number }).n, 0);
  await resolveEvidenceUploads(env, auth(), STOCK, [id]);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_manifests").get() as { n: number }).n, 1);
});

test("intake exact retry and concurrent retry return the original case; changed intent conflicts", async () => {
  const { db, env } = fixture(); const id = await uploadedEvidence(env, auth(), INTAKE); const body = intakeBody(id);
  const send = (value: unknown = body) => handleAuthenticatedRoute(command("/api/v1/service-cases", value), env, auth());
  const initial = await Promise.all([send(), send()]);
  assert.deepEqual(initial.map((res) => res.status).sort(), [200, 201]);
  const first = await responseBody(initial.find((res) => res.status === 201)!);
  assert.equal(first.result, "opened");
  const detail = await handleAuthenticatedRoute(read(`/api/v1/service-cases/${first.service_case!.service_case_id}`), env, auth());
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { evidence_files: unknown; evidence_files_unavailable: boolean };
  assert.deepEqual(detailBody.evidence_files, [{
    receipt_id: id, file_name: "synthetic-proof.png", content_type: "image/png", byte_size: EVIDENCE_BYTES.length,
  }]);
  assert.equal(detailBody.evidence_files_unavailable, false);
  db.failEvidenceProjection = true;
  const unavailable = await handleAuthenticatedRoute(read(`/api/v1/service-cases/${first.service_case!.service_case_id}`), env, auth());
  assert.equal(unavailable.status, 200);
  const unavailableBody = await unavailable.json() as { service_case: { state: string };
    evidence_files: unknown[]; evidence_files_unavailable: boolean };
  assert.equal(unavailableBody.service_case.state, "intake");
  assert.deepEqual(unavailableBody.evidence_files, []);
  assert.equal(unavailableBody.evidence_files_unavailable, true);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 502);
  db.failEvidenceProjection = false;
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth("field"))).status, 403);
  const content = await handleAuthenticatedRoute(read(contentPath(id)), env, auth());
  assert.equal(content.status, 200);
  assert.deepEqual(new Uint8Array(await content.arrayBuffer()), EVIDENCE_BYTES);
  const unlinked = await uploadedEvidence(env, auth(), { ...INTAKE, operationId: "intake-unlinked-2" });
  assert.equal((await handleAuthenticatedRoute(read(contentPath(unlinked)), env, auth())).status, 404);
  const retries = await Promise.all([send(), send({ ...body, evidence_receipt_ids: [id] })]);
  for (const res of retries) { assert.equal(res.status, 200); const replay = await responseBody(res); assert.equal(replay.result, "replayed"); assert.equal(replay.service_case?.service_case_id, first.service_case?.service_case_id); }
  const changed = await send({ ...body, symptom_code: "other_symptom" });
  assert.equal(changed.status, 409); assert.equal((await responseBody(changed)).error, "service_case_intake_request_conflict");
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM service_cases").get() as { n: number }).n, 1);
});

test("intake retry converges when a competing report wins the open-symptom race", async () => {
  const { db, env } = fixture();
  const firstReceipt = await uploadedEvidence(env, auth(), INTAKE, "upload-first-report");
  const secondScope = { ...INTAKE, operationId: "intake-synthetic-2" };
  const secondReceipt = await uploadedEvidence(env, auth(), secondScope, "upload-second-report");
  // Hold the three initial snapshot reads until each request observes no original. This models
  // concurrent D1 requests before the first insert, rather than depending on fixture timing.
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  db.symptomReadBarrier = async () => {
    reads += 1;
    if (reads === 3) release();
    if (reads <= 3) await gate;
  };
  const send = (id: string, key: string) => handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(id), key), env, auth());
  const responses = await Promise.all([
    send(firstReceipt, INTAKE.operationId),
    send(secondReceipt, secondScope.operationId),
    send(secondReceipt, secondScope.operationId),
  ]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 201, 201]);
  const reports = await Promise.all(responses.map(responseBody));
  assert.deepEqual(reports.map((body) => body.result).sort(), ["duplicate", "opened", "replayed"]);
  // Either report may win the open-symptom race. The two sends with the same intake key
  // must converge on one case, whether that case is the original or the duplicate.
  assert.equal(reports[1]?.service_case?.service_case_id, reports[2]?.service_case?.service_case_id);
  const cases = db.raw.prepare("SELECT service_case_id, state, closure_reason, duplicate_of_case_id FROM service_cases")
    .all() as Array<{ service_case_id: string; state: string; closure_reason: string | null; duplicate_of_case_id: string | null }>;
  const originals = cases.filter((row) => row.state !== "closed");
  const duplicates = cases.filter((row) => row.state === "closed" && row.closure_reason === "duplicate");
  assert.equal(cases.length, 2);
  assert.equal(originals.length, 1);
  assert.equal(duplicates.length, 1);
  const original = originals[0]!;
  const duplicate = duplicates[0]!;
  assert.equal(duplicate.duplicate_of_case_id, original.service_case_id);
  assert.equal(reports.find((body) => body.result === "opened")?.service_case?.service_case_id, original.service_case_id);
  assert.equal(reports.find((body) => body.result === "duplicate")?.service_case?.service_case_id, duplicate.service_case_id);
});

test("receipt enforcement is off by default; legacy service and corrective assertions stay unverified", async () => {
  const { db, env } = fixture();
  delete env.APP_EVIDENCE_RECEIPTS_REQUIRED;
  delete env.APP_EVIDENCE_UPLOADS_ENABLED;
  const { evidence_receipt_ids: _ids, ...intent } = intakeBody("");
  const legacyDigest = "a".repeat(64);
  const intake = command("/api/v1/service-cases", { ...intent, intake_evidence_digest: legacyDigest });
  intake.headers.delete("idempotency-key");
  const opened = await handleAuthenticatedRoute(intake, env, auth());
  assert.equal(opened.status, 201);
  const caseId = (await responseBody(opened)).service_case!.service_case_id;
  const triage = { advisory_source: "none", final_category: "material_manufacturer", responsibility: "manufacturer", evidence_digest: legacyDigest };
  assert.equal((await handleAuthenticatedRoute(command(`/api/v1/service-cases/${caseId}/triage`, triage), env, auth())).status, 201);
  const now = new Date().toISOString();
  await reportSafetyOccurrence(env, { occurrenceId: "occ_legacy_01", tenantId: TENANT, occurrenceKind: "hazard", severity: "high", scope: { type: "tenant", id: TENANT }, reportedByUserId: USERS.field, reportedAt: now, summary: "Synthetic legacy hazard", rescueRequired: false, evidence: null, capturedOffline: false, deviceActionId: null, now });
  await assignCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_legacy_01", occurrenceId: "occ_legacy_01", riskLevel: "high", ownerUserId: USERS.ops, dueAt: now, description: "Synthetic legacy control", recurrenceOfId: null, actorUserId: USERS.owner, now });
  const legacy = { evidence_refs_json: JSON.stringify([{ ref: "legacy://synthetic-assertion", sha256: legacyDigest }]), evidence_sha256: legacyDigest, detail: "Legacy assertion" };
  const path = "/api/v1/safety/corrective-actions/ca_legacy_01/evidence";
  assert.equal((await handleAuthenticatedRoute(command(path, legacy), env, auth())).status, 200);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get() as { n: number }).n, 0);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_manifests").get() as { n: number }).n, 0);
  const mixed = await handleAuthenticatedRoute(command(path, { ...legacy, evidence_receipt_ids: [`evu_${"0".repeat(64)}`] }), env, auth());
  assert.equal(mixed.status, 400);
  env.APP_EVIDENCE_RECEIPTS_REQUIRED = "true";
  for (const [url, body] of [[path, legacy], [`/api/v1/service-cases/${caseId}/triage`, triage], ["/api/v1/service-cases", { ...intent, intake_evidence_digest: legacyDigest }]] as const) {
    const refused = await handleAuthenticatedRoute(command(url, body), env, auth());
    assert.equal(refused.status, 400); assert.equal((await responseBody(refused)).error, "evidence_receipts_required");
  }
});

test("upload and receipt linking stay closed without the separate rollout switch", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), INTAKE);
  delete env.APP_EVIDENCE_UPLOADS_ENABLED;
  const refusedUpload = await handleEvidenceUpload(evidenceUploadRequest(STOCK), env, auth());
  assert.equal(refusedUpload.status, 503);
  assert.equal((await responseBody(refusedUpload)).error, "evidence_uploads_disabled");
  assert.equal(raw.puts, 1);
  await assert.rejects(resolveEvidenceUploads(env, auth(), INTAKE, [id]), /evidence_uploads_disabled/);
  const refusedLink = await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(id)), env, auth());
  assert.equal(refusedLink.status, 503);
  assert.equal((await responseBody(refusedLink)).error, "evidence_uploads_disabled");
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_manifests").get() as { n: number }).n, 0);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM service_cases").get() as { n: number }).n, 0);
  env.APP_EVIDENCE_UPLOADS_ENABLED = "true";
  env.APP_EVIDENCE_RECEIPTS_REQUIRED = "false";
  const linked = await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(id)), env, auth());
  assert.equal(linked.status, 201);
});

test("receipts enforce actual file proof and reject mixed digests while enforcement is off", async () => {
  const { raw, env } = fixture(); env.APP_EVIDENCE_RECEIPTS_REQUIRED = "false";
  const id = await uploadedEvidence(env, auth(), INTAKE);
  const body = intakeBody(id);
  const mixed = await handleAuthenticatedRoute(command("/api/v1/service-cases", { ...body, intake_evidence_digest: "a".repeat(64) }), env, auth());
  assert.equal(mixed.status, 400); assert.equal((await responseBody(mixed)).error, "evidence_receipts_required");
  raw.rows.values().next().value!.bytes[14] ^= 1;
  const tampered = await handleAuthenticatedRoute(command("/api/v1/service-cases", body), env, auth());
  assert.equal(tampered.status, 409); assert.equal((await responseBody(tampered)).error, "evidence_object_mismatch");
});

test("concurrent first upload converges on one receipt; a four-file manifest is stable across selection order", async () => {
  const { db, raw, env } = fixture();
  const first = await Promise.all([handleEvidenceUpload(evidenceUploadRequest(STOCK, "concurrent-upload-1"), env, auth()), handleEvidenceUpload(evidenceUploadRequest(STOCK, "concurrent-upload-1"), env, auth())]);
  assert.deepEqual(first.map((res) => res.status).sort(), [200, 201]);
  const ids = [(await responseBody(first[0])).receipt!.receipt_id];
  for (let i = 0; i < 3; i++) ids.push(await uploadedEvidence(env, auth(), STOCK));
  const manifest = await resolveEvidenceUploads(env, auth(), STOCK, ids);
  assert.equal((await resolveEvidenceUploads(env, auth(), STOCK, [...ids].reverse())).sha256, manifest.sha256);
  assert.equal(manifest.refs.length, 4); assert.equal(raw.rows.size, 4);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_receipts").get() as { n: number }).n, 4);
});

test("receipt IDs cannot cross tenant boundaries even where both actors own the same target token", async () => {
  const { db, env } = fixture(); const id = await uploadedEvidence(env, auth(), STOCK);
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,active,created_by,created_at,updated_at)
    VALUES ('appu_other_ops_1','other-tenant','other@example.invalid','Synthetic other operator','ops','ops',1,'seed',?,?)`).run(now,now);
  db.raw.exec("INSERT INTO inventory_lots VALUES ('other-tenant','lot_synthetic_1')");
  const actor = auth("ops", "other-tenant"); actor.session.user_id = "appu_other_ops_1";
  await assert.rejects(resolveEvidenceUploads(env, actor, STOCK, [id]), /evidence_receipt_not_found/);
});

test("intake rejects wrong job, missing files, legacy digest and caller digest beside a valid receipt before creating cases", async () => {
  const { db, raw, env } = fixture(); const id = await uploadedEvidence(env, auth(), INTAKE); const body = intakeBody(id);
  for (const candidate of [{ ...body, roof_job_id: "JOB-SYNTHETIC-2" }, { ...body, intake_evidence_digest: "0".repeat(64) }]) {
    const res = await handleAuthenticatedRoute(command("/api/v1/service-cases", candidate), env, auth());
    assert.ok([400,403].includes(res.status));
  }
  raw.rows.clear();
  assert.equal((await handleAuthenticatedRoute(command("/api/v1/service-cases", body), env, auth())).status, 409);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM service_cases").get() as { n: number }).n, 0);
});

test("service-step action scope and manifest failure refuse before any service transition", async () => {
  const { db, env } = fixture(); const intake = await uploadedEvidence(env, auth(), INTAKE);
  const opened = await responseBody(await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(intake)), env, auth()));
  const caseId = opened.service_case!.service_case_id;
  const scope: EvidenceScope = { purpose: "service_step", targetId: caseId, action: "triage", operationId: "" };
  const id = await uploadedEvidence(env, auth(), scope);
  const body = { advisory_source: "none", final_category: "material_manufacturer", responsibility: "manufacturer", evidence_receipt_ids: [id] };
  const wrongAction = await handleAuthenticatedRoute(command(`/api/v1/service-cases/${caseId}/diagnoses`, { root_cause_code: "synthetic_cause", corrective_action_code: "replace_panel", work_package_ref: "WP-SYNTHETIC-1", work_package_version: 1, warranty_reserve_cents: 0, evidence_receipt_ids: [id] }), env, auth());
  assert.equal(wrongAction.status, 403);
  db.failManifest = true;
  const failed = await handleAuthenticatedRoute(command(`/api/v1/service-cases/${caseId}/triage`, body), env, auth());
  assert.equal(failed.status, 502);
  assert.equal((db.raw.prepare("SELECT state FROM service_cases WHERE service_case_id = ?").get(caseId) as { state: string }).state, "intake");
  db.failManifest = false;
  const success = await handleAuthenticatedRoute(command(`/api/v1/service-cases/${caseId}/triage`, body), env, auth());
  assert.equal(success.status, 201);
  const audited = await handleAuthenticatedRoute(new Request(`https://app.example.invalid/api/v1/privacy/evidence-uploads/${id}/audit`), env, auth("owner"));
  assert.equal(audited.status, 200);
  assert.equal((await audited.json() as { business_linked: boolean }).business_linked, true);
  const detail = await handleAuthenticatedRoute(read(`/api/v1/service-cases/${caseId}`), env, auth());
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json() as { evidence_files: Array<{ receipt_id: string }> }).evidence_files.map((file) => file.receipt_id), [intake, id]);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 200);
});

test("corrective evidence uses actual files and preserves independent safety verification", async () => {
  const { db, raw, env } = fixture(); const now = new Date().toISOString();
  await reportSafetyOccurrence(env, { occurrenceId: "occ_synthetic_01", tenantId: TENANT, occurrenceKind: "hazard", severity: "high", scope: { type: "tenant", id: TENANT }, reportedByUserId: USERS.field, reportedAt: now, summary: "Synthetic loose ladder", rescueRequired: false, evidence: null, capturedOffline: false, deviceActionId: null, now });
  await assignCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_synthetic_01", occurrenceId: "occ_synthetic_01", riskLevel: "high", ownerUserId: USERS.ops, dueAt: now, description: "Secure synthetic ladder", recurrenceOfId: null, actorUserId: USERS.owner, now });
  const scope: EvidenceScope = { purpose: "corrective_action", targetId: "ca_synthetic_01", action: "submit", operationId: "" };
  db.raw.exec("UPDATE app_users SET access_role = 'field' WHERE user_id = 'appu_ops_0001'");
  const staleRole = await handleEvidenceUpload(evidenceUploadRequest(scope), env, auth());
  assert.equal(staleRole.status, 403);
  assert.equal((await responseBody(staleRole)).error, "evidence_actor_role_changed");
  assert.equal(raw.rows.size, 0);
  db.raw.exec("UPDATE app_users SET access_role = 'ops' WHERE user_id = 'appu_ops_0001'");
  const id = await uploadedEvidence(env, auth(), scope);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth())).status, 404);
  const stored = raw.rows.values().next().value!; const original = stored.bytes.slice(); stored.bytes[14] ^= 1;
  const send = () => handleAuthenticatedRoute(command("/api/v1/safety/corrective-actions/ca_synthetic_01/evidence", { evidence_receipt_ids: [id], detail: "Synthetic control photographed" }), env, auth());
  assert.equal((await send()).status, 409);
  assert.equal((db.raw.prepare("SELECT state FROM safety_corrective_actions").get() as { state: string }).state, "open");
  stored.bytes = original;
  assert.equal((await send()).status, 200);
  const detail = await handleAuthenticatedRoute(read("/api/v1/safety/corrective-actions/ca_synthetic_01"), env, auth("field"));
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { evidence_files: unknown; evidence_files_unavailable: boolean };
  assert.deepEqual(detailBody.evidence_files, [{
    receipt_id: id, file_name: "synthetic-proof.png", content_type: "image/png", byte_size: EVIDENCE_BYTES.length,
  }]);
  assert.equal(detailBody.evidence_files_unavailable, false);
  db.failEvidenceProjection = true;
  const unavailable = await handleAuthenticatedRoute(read("/api/v1/safety/corrective-actions/ca_synthetic_01"), env, auth("field"));
  assert.equal(unavailable.status, 200);
  const unavailableBody = await unavailable.json() as { corrective_action: { state: string };
    evidence_files: unknown[]; evidence_files_unavailable: boolean };
  assert.equal(unavailableBody.corrective_action.state, "evidence_submitted");
  assert.deepEqual(unavailableBody.evidence_files, []);
  assert.equal(unavailableBody.evidence_files_unavailable, true);
  assert.equal((await handleAuthenticatedRoute(read(contentPath(id)), env, auth("field"))).status, 502);
  db.failEvidenceProjection = false;
  assert.deepEqual(new Uint8Array(await (await handleAuthenticatedRoute(read(contentPath(id)), env, auth("field"))).arrayBuffer()), EVIDENCE_BYTES);
  await assert.rejects(verifyCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_synthetic_01", actorUserId: USERS.ops, verdict: "verified", detail: "I own and captured this evidence", now }), /reporter, owner, and evidence capturer/);
  const verified = await verifyCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_synthetic_01", actorUserId: USERS.owner, verdict: "verified", detail: "Independent synthetic inspection", now });
  assert.equal(verified.state, "verified");
  assert.equal((await send()).status, 200); // exact lost-response replay remains safe after verification
  const audited = await handleAuthenticatedRoute(new Request(`https://app.example.invalid/api/v1/privacy/evidence-uploads/${id}/audit`), env, auth("owner"));
  assert.equal(audited.status, 200);
  assert.equal((await audited.json() as { business_linked: boolean }).business_linked, true);
});

test("legacy safety evidence cannot name an upload receipt without its scoped manifest", async () => {
  const { db, env } = fixture(); env.APP_EVIDENCE_RECEIPTS_REQUIRED = "false";
  const now = new Date().toISOString();
  await reportSafetyOccurrence(env, { occurrenceId: "occ_manifest_01", tenantId: TENANT,
    occurrenceKind: "hazard", severity: "high", scope: { type: "tenant", id: TENANT },
    reportedByUserId: USERS.field, reportedAt: now, summary: "Synthetic missing guard",
    rescueRequired: false, evidence: null, capturedOffline: false, deviceActionId: null, now });
  await assignCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_manifest_01",
    occurrenceId: "occ_manifest_01", riskLevel: "high", ownerUserId: USERS.ops,
    dueAt: now, description: "Replace the guard", recurrenceOfId: null,
    actorUserId: USERS.owner, now });
  const scope: EvidenceScope = { purpose: "corrective_action", targetId: "ca_manifest_01",
    action: "submit", operationId: "" };
  const id = await uploadedEvidence(env, auth(), scope);
  const hash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string }).sha256;
  const canonicalRef = `evidence-upload://${id}`;
  const refs = JSON.stringify([{ ref: canonicalRef, sha256: hash }]);
  const path = "/api/v1/safety/corrective-actions/ca_manifest_01/evidence";
  const legacy = await handleAuthenticatedRoute(command(path, {
    evidence_refs_json: refs, evidence_sha256: hash, detail: "Claim this upload directly",
  }), env, auth());
  assert.equal(legacy.status, 400);
  assert.equal((await responseBody(legacy)).error, "safety_evidence_invalid");
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_manifests")
    .get() as { n: number }).n, 0);
  assert.throws(() => db.raw.prepare(`UPDATE safety_corrective_actions SET version = version + 1,
      state = 'evidence_submitted', evidence_refs_json = ?, evidence_sha256 = ?,
      evidence_captured_by_user_id = ?, evidence_submitted_at = ?, updated_at = ?
      WHERE tenant_id = ? AND corrective_action_id = ?`)
    .run(refs, hash, USERS.ops, now, now, TENANT, scope.targetId),
  /evidence_receipt_manifest_required/);
  assert.equal((db.raw.prepare("SELECT state FROM safety_corrective_actions WHERE corrective_action_id = ?")
    .get(scope.targetId) as { state: string }).state, "open");
  assert.throws(() => db.raw.prepare(`INSERT INTO safety_corrective_actions
      (corrective_action_id, tenant_id, occurrence_id, version, state, risk_level,
       owner_user_id, assigned_by_user_id, due_at, description, evidence_refs_json,
       evidence_sha256, evidence_captured_by_user_id, evidence_submitted_at, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'evidence_submitted', 'high', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("ca_manifest_insert", TENANT, "occ_manifest_01", USERS.ops, USERS.owner,
      now, "Direct insert must not claim an upload", refs, hash, USERS.ops, now, now, now),
  /evidence_receipt_manifest_required/);
  for (const alias of [` ${canonicalRef}`, `\t${canonicalRef}`, `\n${canonicalRef}`,
    canonicalRef.toUpperCase()]) {
    const aliased = JSON.stringify([{ ref: alias, sha256: hash }]);
    assert.throws(() => db.raw.prepare(`UPDATE safety_corrective_actions SET version = version + 1,
        state = 'evidence_submitted', evidence_refs_json = ?, evidence_sha256 = ?,
        evidence_captured_by_user_id = ?, evidence_submitted_at = ?, updated_at = ?
        WHERE tenant_id = ? AND corrective_action_id = ?`)
      .run(aliased, hash, USERS.ops, now, now, TENANT, scope.targetId),
    /evidence_receipt_manifest_required/);
  }

  const resolved = await handleAuthenticatedRoute(command(path, {
    evidence_receipt_ids: [id], detail: "Resolved upload proof",
  }), env, auth());
  assert.equal(resolved.status, 200);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_manifests")
    .get() as { n: number }).n, 1);
});

test("privacy evidence inventory is owner-only, paginated and tenant-scoped", async () => {
  const { db, env } = fixture();
  const ids = [await uploadedEvidence(env, auth(), STOCK), await uploadedEvidence(env, auth(), STOCK)].sort();
  const path = "/api/v1/privacy/evidence-uploads?limit=1";
  const get = (suffix: string, actor = auth("owner")) =>
    handleAuthenticatedRoute(new Request(`https://app.example.invalid${suffix}`), env, actor);
  const forbidden = await get(path, auth());
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("cache-control"), "private, no-store");
  const first = await get(path);
  const firstBody = await first.json() as { receipts: Array<{ receipt_id: string; file_name: string }>; next_cursor: string };
  assert.deepEqual(firstBody.receipts.map((row) => row.receipt_id), [ids[0]]);
  assert.equal(firstBody.receipts[0]?.file_name, "synthetic-proof.png");
  assert.equal(firstBody.next_cursor, ids[0]);
  const second = await get(`${path}&cursor=${firstBody.next_cursor}`);
  const secondBody = await second.json() as { receipts: Array<{ receipt_id: string }>; next_cursor: string | null };
  assert.deepEqual(secondBody.receipts.map((row) => row.receipt_id), [ids[1]]);
  assert.equal(secondBody.next_cursor, null);
  assert.equal((await get(`${path}&cursor=bad`)).status, 400);
  assert.equal((await get("/api/v1/privacy/evidence-uploads?limit=51")).status, 400);

  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,
    active,created_by,created_at,updated_at) VALUES ('appu_other_owner_1','other-tenant',
    'owner@other.invalid','Other owner','owner','owner',1,'seed',?,?)`).run(now, now);
  const other = auth("owner", "other-tenant"); other.session.user_id = "appu_other_owner_1";
  const otherList = await get(path, other);
  assert.deepEqual((await otherList.json() as { receipts: unknown[] }).receipts, []);
  assert.equal((await get(`/api/v1/privacy/evidence-uploads/${ids[0]}/audit`, other)).status, 404);
  db.raw.exec("UPDATE app_users SET access_role = 'ops' WHERE user_id = 'appu_owner_0001'");
  assert.equal((await get(path)).status, 403);
});

test("independent privacy inventory finds markers missing from a restored D1", async () => {
  const live = fixture();
  const restored = fixture();
  const ids: string[] = [];
  const decisions = new Map<string, string>();
  let restoredKey = "";
  let restoredBytes: NonNullable<ReturnType<typeof live.raw.rows.get>> | undefined;
  for (const key of ["marker-inventory-1", "marker-inventory-2"]) {
    const id = await uploadedEvidence(live.env, auth(), STOCK, key);
    const receipt = live.db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
      .get(id) as { sha256: string; r2_key: string };
    if (!restoredKey) {
      restoredKey = receipt.r2_key;
      restoredBytes = live.raw.rows.get(restoredKey);
    }
    const decisionId = `decision-${key}`;
    const destroyed = await handleAuthenticatedRoute(privacyCommand(
      `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256, decisionId)),
      live.env, auth("owner"));
    assert.equal(destroyed.status, 200);
    ids.push(id);
    decisions.set(id, decisionId);
  }
  ids.sort();
  const path = "/api/v1/privacy/evidence-uploads/markers";
  const get = (suffix: string, env = live.env, actor = auth("owner")) =>
    handleAuthenticatedRoute(new Request(`https://app.example.invalid${suffix}`), env, actor);
  assert.equal((await get(path, live.env, auth())).status, 403);
  const first = await get(`${path}?limit=1`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  const firstBody = await first.json() as { markers: Array<{ receipt_id: string; d1_receipt: string;
    d1_disposition_state: string; raw_object_present: boolean }>; marker_issues: unknown[];
    marker_entries_valid: boolean; next_cursor: string };
  assert.deepEqual(firstBody.marker_issues, []);
  assert.equal(firstBody.marker_entries_valid, true);
  assert.deepEqual(firstBody.markers, [{ receipt_id: ids[0],
    marker_decision_id: decisions.get(ids[0]!),
    d1_receipt: "matches", d1_disposition_state: "destroyed", raw_object_present: false }]);
  const second = await get(`${path}?limit=1&cursor=${encodeURIComponent(firstBody.next_cursor)}`);
  const secondBody = await second.json() as { markers: Array<{ receipt_id: string }>; next_cursor: string | null };
  assert.deepEqual(secondBody.markers.map((marker) => marker.receipt_id), [ids[1]]);
  assert.equal(secondBody.next_cursor, null);

  // The old D1 snapshot has no receipt, yet the independent ledger and restored
  // RAW bytes remain observable to the owner before any correction is attempted.
  restored.env.PRIVACY_LEDGER = live.ledger as never;
  restored.raw.rows.set(restoredKey, restoredBytes!);
  const afterRestore = await get(path, restored.env);
  const restoreBody = await afterRestore.json() as { markers: Array<{ d1_receipt: string;
    d1_disposition_state: string | null; raw_object_present: boolean }> };
  assert.equal(afterRestore.status, 200);
  assert.equal(restoreBody.markers.length, 2);
  assert.deepEqual(restoreBody.markers.map((marker) => marker.d1_receipt), ["missing", "missing"]);
  assert.deepEqual(restoreBody.markers.map((marker) => marker.d1_disposition_state), [null, null]);
  assert.equal(restoreBody.markers.filter((marker) => marker.raw_object_present).length, 1);
  const receiptList = await get("/api/v1/privacy/evidence-uploads", restored.env);
  assert.deepEqual((await receiptList.json() as { receipts: unknown[] }).receipts, []);
  const now = new Date().toISOString();
  restored.db.raw.prepare(`INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,
    role,access_role,active,created_by,created_at,updated_at)
    VALUES ('appu_marker_other','other-tenant','other@example.invalid','Other owner',
      'owner','owner',1,'seed',?,?)`).run(now, now);
  const other = auth("owner", "other-tenant"); other.session.user_id = "appu_marker_other";
  const otherList = await get(path, restored.env, other);
  assert.deepEqual((await otherList.json() as { markers: unknown[] }).markers, []);
  assert.equal((await get(`${path}?limit=51`)).status, 400);
  assert.equal((await get(`${path}?cursor=%0A`)).status, 400);
  live.ledger.failRead = true;
  assert.equal((await get(path)).status, 502);
  live.ledger.failRead = false;
  restored.raw.failGet = true;
  assert.equal((await get(path, restored.env)).status, 502);
  restored.raw.failGet = false;
  const [markerKey, originalMarker] = [...live.ledger.rows.entries()][0]!;
  const changed = JSON.parse(new TextDecoder().decode(originalMarker)) as Record<string, unknown>;
  const originalLedgerGet = live.ledger.get.bind(live.ledger);
  live.ledger.get = async (key) => key === markerKey ? null : originalLedgerGet(key);
  const missingBody = await (await get(path, restored.env)).json() as { marker_entries_valid: boolean;
    marker_issues: Array<{ receipt_id: string | null; reason: string }> };
  assert.equal(missingBody.marker_entries_valid, false);
  assert.deepEqual(missingBody.marker_issues, [{ receipt_id: changed.receipt_id,
    marker_key_sha256: createHash("sha256").update(markerKey).digest("hex"),
    reason: "missing_marker" }]);
  live.ledger.get = originalLedgerGet;
  live.ledger.rows.set(markerKey, new TextEncoder().encode(JSON.stringify({ ...changed,
    r2_key: "evidence/v1/other-tenant.bin" })));
  const malformed = await get(path, restored.env);
  assert.equal(malformed.status, 200);
  const malformedBody = await malformed.json() as { markers: Array<{ receipt_id: string }>;
    marker_issues: Array<{ receipt_id: string | null; marker_key_sha256: string; reason: string }>;
    marker_entries_valid: boolean; next_cursor: string | null };
  assert.equal(malformedBody.marker_entries_valid, false);
  assert.deepEqual(malformedBody.markers.map((marker) => marker.receipt_id),
    ids.filter((id) => id !== changed.receipt_id));
  assert.deepEqual(malformedBody.marker_issues, [{ receipt_id: changed.receipt_id,
    marker_key_sha256: createHash("sha256").update(markerKey).digest("hex"),
    reason: "invalid_marker" }]);
  assert.equal(malformedBody.next_cursor, null);
  assert.equal(JSON.stringify(malformedBody).includes("evidence-dispositions/"), false);
  const invalidKey = "evidence-dispositions/v1/ironwrap/stray.json";
  live.ledger.rows.set(invalidKey, new TextEncoder().encode("{}"));
  const invalidKeyBody = await (await get(path, restored.env)).json() as typeof malformedBody;
  assert.equal(invalidKeyBody.marker_entries_valid, false);
  assert.deepEqual(invalidKeyBody.marker_issues.map((issue) => issue.reason).sort(),
    ["invalid_key", "invalid_marker"]);
  assert.deepEqual(invalidKeyBody.marker_issues.find((issue) => issue.reason === "invalid_key"),
    { receipt_id: null, marker_key_sha256: createHash("sha256").update(invalidKey).digest("hex"),
      reason: "invalid_key" });
  const stillBlocked = await get(`/api/v1/privacy/evidence-uploads/${changed.receipt_id}/audit`);
  assert.equal(stillBlocked.status, 409);
});

test("privacy audit distinguishes an abandoned manifest and R2 missing or altered bytes", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  await resolveEvidenceUploads(env, auth(), STOCK, [id]); // a manifest is not a business fact
  const path = `/api/v1/privacy/evidence-uploads/${id}/audit`;
  const get = () => handleAuthenticatedRoute(new Request(`https://app.example.invalid${path}`), env, auth("owner"));
  const stored = await get();
  assert.equal(stored.status, 200);
  assert.equal(stored.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await stored.json() as { business_linked: boolean; domain_record_linked: boolean; object_status: string },
    { version: 1, receipt_id: id, purpose: "stock", target_id: STOCK.targetId,
      actor_user_id: USERS.ops, created_at: (db.raw.prepare("SELECT created_at FROM evidence_upload_receipts WHERE receipt_id = ?").get(id) as { created_at: string }).created_at,
      file_name: "synthetic-proof.png", content_type: "image/png", byte_size: EVIDENCE_BYTES.length,
      business_linked: false, domain_record_linked: false,
      disposition_state: "available", active_hold_count: 0, external_marker_present: false,
      external_marker_decision_id: null, restore_recheck_pending: false,
      recent_events: [], object_status: "verified" });
  const receipt = db.raw.prepare("SELECT r2_key FROM evidence_upload_receipts WHERE receipt_id = ?").get(id) as { r2_key: string };
  raw.rows.get(receipt.r2_key)!.bytes[14] ^= 1;
  assert.equal((await (await get()).json() as { object_status: string }).object_status, "mismatch");
  raw.rows.clear();
  assert.equal((await (await get()).json() as { object_status: string }).object_status, "missing");
  raw.failGet = true;
  assert.equal((await get()).status, 502); // outage cannot be misreported as absent
});

test("privacy audit counts only accepted stock and service links", async () => {
  const { db, env } = fixture();
  const stockId = await uploadedEvidence(env, auth(), STOCK);
  const stockReceipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?").get(stockId) as { sha256: string };
  const stockRefs = JSON.stringify([{ ref: `evidence-upload://${stockId}`, sha256: stockReceipt.sha256 }]);
  db.raw.prepare("INSERT INTO inventory_commands (tenant_id, command_id, transition, status, evidence_refs_json) VALUES (?, ?, ?, ?, ?)")
    .run(TENANT, STOCK.operationId, STOCK.action, "rejected", stockRefs);
  const audit = async (id: string) => (await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid/api/v1/privacy/evidence-uploads/${id}/audit`),
    env, auth("owner"))).json() as Promise<{ business_linked: boolean; domain_record_linked: boolean }>;
  assert.deepEqual(await audit(stockId), {
    version: 1, receipt_id: stockId, purpose: "stock", target_id: STOCK.targetId,
    actor_user_id: USERS.ops,
    created_at: (db.raw.prepare("SELECT created_at FROM evidence_upload_receipts WHERE receipt_id = ?").get(stockId) as { created_at: string }).created_at,
    file_name: "synthetic-proof.png", content_type: "image/png", byte_size: EVIDENCE_BYTES.length,
    business_linked: false, domain_record_linked: true,
    disposition_state: "available", active_hold_count: 0, external_marker_present: false,
    external_marker_decision_id: null, restore_recheck_pending: false,
    recent_events: [], object_status: "verified",
  });
  db.raw.prepare("UPDATE inventory_commands SET status = 'applied'").run();
  assert.equal((await audit(stockId)).business_linked, true);

  const intakeId = await uploadedEvidence(env, auth(), INTAKE);
  await resolveEvidenceUploads(env, auth(), INTAKE, [intakeId]);
  assert.equal((await audit(intakeId)).business_linked, false);
  assert.equal((await audit(intakeId)).domain_record_linked, false);
  const opened = await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(intakeId)), env, auth());
  assert.equal(opened.status, 201);
  assert.equal((await audit(intakeId)).business_linked, true);
  assert.equal((await audit(intakeId)).domain_record_linked, true);
});

test("privacy audit retains a durable service child row even when its transition never lands", async () => {
  const { db, env } = fixture();
  const intakeId = await uploadedEvidence(env, auth(), INTAKE);
  const opened = await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(intakeId)), env, auth());
  assert.equal(opened.status, 201);
  const caseId = (await responseBody(opened)).service_case!.service_case_id;
  const scope: EvidenceScope = { purpose: "service_step", targetId: caseId, action: "triage", operationId: "" };
  const id = await uploadedEvidence(env, auth(), scope);
  const digest = (await resolveEvidenceUploads(env, auth(), scope, [id])).sha256;
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO service_case_triage (triage_id,service_case_id,tenant_id,case_version,
    advisory_source,advisory_category,advisory_confidence_bps,final_category,responsibility,
    authority_kind,decided_by_user_id,decided_by_role,evidence_digest,decided_at,created_at)
    VALUES ('svc_triage_synthetic_01',?,?,1,'none',NULL,NULL,'workmanship',
      'ironwrap_workmanship','human',?,'ops',?,?,?)`)
    .run(caseId, TENANT, USERS.ops, digest, now, now);
  const response = await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid/api/v1/privacy/evidence-uploads/${id}/audit`),
    env, auth("owner"));
  assert.equal(response.status, 200);
  const audit = await response.json() as { business_linked: boolean; domain_record_linked: boolean };
  assert.equal(audit.business_linked, false); // advanceCase did not run
  assert.equal(audit.domain_record_linked, true); // the child record is immutable
  const receipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string };
  const destroy = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256, "decision-service-child-1")),
    env, auth("owner"));
  assert.equal(destroy.status, 409);
  assert.equal((await responseBody(destroy)).error, "evidence_business_record_linked");
});

test("privacy disposal preserves a service case's last evidence without an event row", async () => {
  const { db, raw, env } = fixture();
  const intakeId = await uploadedEvidence(env, auth(), INTAKE);
  const opened = await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(intakeId)), env, auth());
  assert.equal(opened.status, 201);
  const caseId = (await responseBody(opened)).service_case!.service_case_id;
  const scope: EvidenceScope = { purpose: "service_step", targetId: caseId, action: "triage", operationId: "" };
  const id = await uploadedEvidence(env, auth(), scope);
  const digest = (await resolveEvidenceUploads(env, auth(), scope, [id])).sha256;
  // A historical/direct D1 writer can persist last_evidence_digest with a version step
  // but no state change. The state-transition event trigger does not run in that case.
  db.raw.prepare(`UPDATE service_cases SET version = version + 1,
    last_evidence_digest = ?, updated_at = ? WHERE service_case_id = ?`)
    .run(digest, new Date().toISOString(), caseId);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM service_case_events WHERE evidence_digest = ?")
    .get(digest) as { n: number }).n, 0);
  const audit = await handleAuthenticatedRoute(new Request(
    `https://app.example.invalid/api/v1/privacy/evidence-uploads/${id}/audit`), env, auth("owner"));
  assert.equal(audit.status, 200);
  const status = await audit.json() as { business_linked: boolean; domain_record_linked: boolean };
  assert.equal(status.business_linked, false);
  assert.equal(status.domain_record_linked, true);
  const receipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string };
  const destroyed = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256,
      "decision-service-last-evidence-1")), env, auth("owner"));
  assert.equal(destroyed.status, 409);
  assert.equal((await responseBody(destroyed)).error, "evidence_business_record_linked");
  assert.equal(raw.rows.size, 2);
});

test("privacy disposal preserves a corrective action's manifest digest with legacy refs", async () => {
  const { db, raw, env } = fixture();
  const now = new Date().toISOString();
  await reportSafetyOccurrence(env, { occurrenceId: "occ_digest_link_01", tenantId: TENANT,
    occurrenceKind: "hazard", severity: "high", scope: { type: "tenant", id: TENANT },
    reportedByUserId: USERS.field, reportedAt: now, summary: "Synthetic loose material",
    rescueRequired: false, evidence: null, capturedOffline: false, deviceActionId: null, now });
  await assignCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_digest_link_01",
    occurrenceId: "occ_digest_link_01", riskLevel: "high", ownerUserId: USERS.ops,
    dueAt: now, description: "Remove the loose material", recurrenceOfId: null,
    actorUserId: USERS.owner, now });
  const scope: EvidenceScope = { purpose: "corrective_action", targetId: "ca_digest_link_01",
    action: "submit", operationId: "" };
  const id = await uploadedEvidence(env, auth(), scope);
  const digest = (await resolveEvidenceUploads(env, auth(), scope, [id])).sha256;
  const receipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string };
  // A legacy or direct writer can persist the exact upload manifest digest while
  // the refs JSON names something else. The case row is still a durable claim.
  db.raw.prepare(`UPDATE safety_corrective_actions SET version = version + 1,
    state = 'evidence_submitted', evidence_refs_json = ?, evidence_sha256 = ?,
    evidence_captured_by_user_id = ?, evidence_submitted_at = ?, updated_at = ?
    WHERE tenant_id = ? AND corrective_action_id = ?`)
    .run(JSON.stringify([{ ref: "legacy://site-note", sha256: receipt.sha256 }]), digest,
      USERS.ops, now, now, TENANT, scope.targetId);
  const audit = await handleAuthenticatedRoute(new Request(
    `https://app.example.invalid/api/v1/privacy/evidence-uploads/${id}/audit`), env, auth("owner"));
  assert.equal(audit.status, 200);
  const status = await audit.json() as { business_linked: boolean; domain_record_linked: boolean };
  assert.equal(status.domain_record_linked, true);
  const destroyed = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256,
      "decision-corrective-digest-1")), env, auth("owner"));
  assert.equal(destroyed.status, 409);
  assert.equal((await responseBody(destroyed)).error, "evidence_business_record_linked");
  assert.equal(raw.rows.size, 1);
});

function privacyCommand(path: string, body: unknown, csrf = true): Request {
  return new Request(`https://app.example.invalid${path}`, { method: "POST", headers: {
    "content-type": "application/json", ...(csrf ? { "x-csrf-token": "csrf" } : {}),
  }, body: JSON.stringify(body) });
}
function destroyBody(hash: string, decisionId = "decision-synthetic-1") {
  return { decision_id: decisionId, basis: "manual_correction", authority_ref: "privacy-case-synthetic-1",
    policy_version: "manual-v1", reason: "Approved exact receipt destruction", expected_sha256: hash };
}

test("owner hold blocks destruction; release and exact decision destroy bytes with readback and immutable events", async () => {
  const { db, raw, env } = fixture();
  const uploadKey = "synthetic-held-upload";
  const id = await uploadedEvidence(env, auth(), STOCK, uploadKey);
  const stored = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string; r2_key: string };
  const original = raw.rows.get(stored.r2_key)!;
  const base = `/api/v1/privacy/evidence-uploads/${id}`;
  const post = (path: string, body: unknown, actor = auth("owner")) => handleAuthenticatedRoute(privacyCommand(path, body), env, actor);
  const hold = { hold_id: "hold-synthetic-1", reason: "Preserve while claim is reviewed" };
  assert.equal((await post(`${base}/holds`, hold)).status, 201);
  assert.equal((await post(`${base}/holds`, hold)).status, 200);
  assert.equal((await post(`${base}/destruction`, destroyBody(stored.sha256))).status, 409);
  assert.equal(raw.rows.size, 1);
  const release = `${base}/holds/${hold.hold_id}/release`;
  assert.equal((await post(release, { reason: "Claim review is complete" })).status, 200);
  assert.equal((await post(release, { reason: "Claim review is complete" })).status, 200);
  const destroyed = await post(`${base}/destruction`, destroyBody(stored.sha256));
  assert.equal(destroyed.status, 200);
  assert.equal((await destroyed.json() as { state: string }).state, "destroyed");
  assert.equal(raw.rows.size, 0);
  assert.equal((await post(`${base}/destruction`, destroyBody(stored.sha256))).status, 200);
  await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, [id]), /evidence_destroyed/);
  assert.throws(() => db.raw.prepare(`INSERT INTO evidence_upload_manifests
    (sha256, tenant_id, actor_user_id, purpose, target_id, action, operation_id, refs_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("f".repeat(64), TENANT, USERS.ops,
      STOCK.purpose, STOCK.targetId, STOCK.action, STOCK.operationId,
      JSON.stringify([{ ref: `evidence-upload://${id}`, sha256: stored.sha256 }]), new Date().toISOString()),
  /evidence_disposition_blocks_manifest/);
  const replay = await handleEvidenceUpload(evidenceUploadRequest(STOCK, uploadKey), env, auth());
  assert.equal(replay.status, 410);
  const audit = await handleAuthenticatedRoute(new Request(`https://app.example.invalid${base}/audit`), env, auth("owner"));
  const detail = await audit.json() as { disposition_state: string; active_hold_count: number; object_status: string; recent_events: Array<{ kind: string }> };
  assert.equal(detail.disposition_state, "destroyed");
  assert.equal(detail.active_hold_count, 0);
  assert.equal(detail.object_status, "missing");
  assert.deepEqual(detail.recent_events.map((event) => event.kind).sort(),
    ["hold_created", "hold_released", "destruction_requested", "destruction_verified"].sort());
  assert.throws(() => db.raw.exec("DELETE FROM evidence_upload_privacy_events"), /immutable/);
  assert.throws(() => db.raw.exec("UPDATE evidence_upload_receipts SET tenant_id = 'other'"), /immutable/);
  raw.rows.set(stored.r2_key, original); // Simulate a backup restore that reintroduces destroyed bytes.
  assert.equal((await (await handleAuthenticatedRoute(new Request(`https://app.example.invalid${base}/audit`), env, auth("owner"))).json() as { object_status: string }).object_status,
    "restore_reappeared");
  const reverified = await post(`${base}/destruction`, destroyBody(stored.sha256));
  assert.equal(reverified.status, 200);
  assert.equal((await reverified.json() as { result: string }).result, "reverified");
  assert.equal(raw.rows.size, 0);
  const afterRestore = await (await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${base}/audit`), env, auth("owner"))).json() as {
      object_status: string; restore_recheck_pending: boolean; recent_events: Array<{ kind: string }>;
    };
  assert.equal(afterRestore.object_status, "missing");
  assert.equal(afterRestore.restore_recheck_pending, false);
  assert.equal(afterRestore.recent_events.filter((event) => event.kind === "reappearance_detected").length, 1);
  assert.equal(afterRestore.recent_events.filter((event) => event.kind === "destruction_reverified").length, 1);
  assert.equal((await post(`${base}/destruction`, destroyBody(stored.sha256))).status, 200);
  await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, [id]), /evidence_destroyed/);
});

test("restored bytes stay blocked and an interrupted re-purge resumes under the original decision", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const stored = db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string; r2_key: string };
  const original = raw.rows.get(stored.r2_key)!;
  const base = `/api/v1/privacy/evidence-uploads/${id}`;
  const post = () => handleAuthenticatedRoute(privacyCommand(`${base}/destruction`, destroyBody(stored.sha256)), env, auth("owner"));
  assert.equal((await post()).status, 200);
  raw.rows.set(stored.r2_key, original);
  raw.failDelete = true;
  assert.equal((await post()).status, 502);
  const pending = await (await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${base}/audit`), env, auth("owner"))).json() as {
      object_status: string; restore_recheck_pending: boolean;
    };
  assert.equal(pending.object_status, "restore_reappeared");
  assert.equal(pending.restore_recheck_pending, true);
  await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, [id]), /evidence_destroyed/);
  raw.failDelete = false;
  assert.equal((await post()).status, 200);
  assert.equal(raw.rows.size, 0);
  const kinds = db.raw.prepare("SELECT kind FROM evidence_upload_privacy_events WHERE receipt_id = ?")
    .all(id) as Array<{ kind: string }>;
  assert.equal(kinds.filter((event) => event.kind === "reappearance_detected").length, 1);
  assert.equal(kinds.filter((event) => event.kind === "destruction_reverified").length, 1);
  raw.rows.set(stored.r2_key, original);
  db.failReverifyOnce = true;
  assert.equal((await post()).status, 502); // Bytes are gone, but the D1 settlement did not land.
  assert.equal(raw.rows.size, 0);
  const afterD1Failure = await (await handleAuthenticatedRoute(
    new Request(`https://app.example.invalid${base}/audit`), env, auth("owner"))).json() as {
      object_status: string; restore_recheck_pending: boolean;
    };
  assert.equal(afterD1Failure.object_status, "missing");
  assert.equal(afterD1Failure.restore_recheck_pending, true);
  assert.equal((await post()).status, 200);
  const afterRetry = db.raw.prepare("SELECT kind FROM evidence_upload_privacy_events WHERE receipt_id = ?")
    .all(id) as Array<{ kind: string }>;
  assert.equal(afterRetry.filter((event) => event.kind === "reappearance_detected").length, 2);
  assert.equal(afterRetry.filter((event) => event.kind === "destruction_reverified").length, 2);
  raw.rows.set(stored.r2_key, original);
  const concurrent = await Promise.all([post(), post()]);
  assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
  assert.equal(raw.rows.size, 0);
  const afterConcurrent = db.raw.prepare("SELECT kind FROM evidence_upload_privacy_events WHERE receipt_id = ?")
    .all(id) as Array<{ kind: string }>;
  assert.equal(afterConcurrent.filter((event) => event.kind === "reappearance_detected").length, 3);
  assert.equal(afterConcurrent.filter((event) => event.kind === "destruction_reverified").length, 3);
});

test("provider failure stays retryable, blocks use, and accepts a new hold before retry", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const hash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?").get(id) as { sha256: string }).sha256;
  const base = `/api/v1/privacy/evidence-uploads/${id}`;
  const post = (path: string, body: unknown) => handleAuthenticatedRoute(privacyCommand(path, body), env, auth("owner"));
  raw.failDelete = true;
  const failed = await post(`${base}/destruction`, destroyBody(hash));
  assert.equal(failed.status, 502);
  assert.equal((db.raw.prepare("SELECT state FROM evidence_upload_dispositions WHERE receipt_id = ?").get(id) as { state: string }).state, "failed");
  await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, [id]), /evidence_destruction_pending/);
  const hold = { hold_id: "hold-after-failure-1", reason: "Pause retry for legal review" };
  assert.equal((await post(`${base}/holds`, hold)).status, 201);
  raw.failDelete = false;
  assert.equal((await post(`${base}/destruction`, destroyBody(hash))).status, 409);
  assert.equal((await post(`${base}/holds/${hold.hold_id}/release`, { reason: "Legal review has ended" })).status, 200);
  assert.equal((await post(`${base}/destruction`, destroyBody(hash))).status, 200);
  const kinds = db.raw.prepare("SELECT kind FROM evidence_upload_privacy_events WHERE receipt_id = ?")
    .all(id) as Array<{ kind: string }>;
  assert.deepEqual(kinds.map((row) => row.kind).sort(), ["destruction_requested", "destruction_failed", "hold_created", "hold_released", "destruction_retried", "destruction_verified"].sort());
});

test("an external privacy marker blocks an old D1 and RAW restore until the exact decision is replayed", async () => {
  const live = fixture();
  const restored = fixture();
  const key = "old-d1-restore-evidence";
  const id = await uploadedEvidence(live.env, auth(), STOCK, key);
  const oldReceipt = await uploadedEvidence(restored.env, auth(), STOCK, key);
  assert.equal(oldReceipt, id);
  const stored = live.db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string; r2_key: string };
  const original = live.raw.rows.get(stored.r2_key)!;
  const decision = destroyBody(stored.sha256);
  const path = `/api/v1/privacy/evidence-uploads/${id}/destruction`;
  assert.equal((await handleAuthenticatedRoute(privacyCommand(path, decision), live.env, auth("owner"))).status, 200);
  assert.equal(live.ledger.rows.size, 1);
  assert.equal(live.raw.rows.size, 0);
  const marker = JSON.parse(new TextDecoder().decode([...live.ledger.rows.values()][0])) as Record<string, unknown>;
  const markerBytes = new Uint8Array([...live.ledger.rows.values()][0]);
  assert.deepEqual(Object.keys(marker).sort(), ["version", "tenant_id", "receipt_id", "receipt_sha256",
    "r2_key", "decision_id", "decision_sha256"].sort());
  assert.match(String(marker.decision_sha256), /^[0-9a-f]{64}$/);

  // The restored D1 still has the immutable receipt, but its disposition is gone;
  // restoring RAW bytes must not make that old state usable again.
  restored.env.PRIVACY_LEDGER = live.ledger as never;
  restored.raw.rows.set(stored.r2_key, original);
  const different = await handleAuthenticatedRoute(privacyCommand(path,
    destroyBody(stored.sha256, "decision-conflicting-1")), restored.env, auth("owner"));
  assert.equal(different.status, 409);
  const editedReason = await handleAuthenticatedRoute(privacyCommand(path,
    { ...decision, reason: "A different destruction reason" }), restored.env, auth("owner"));
  assert.equal(editedReason.status, 409);
  assert.equal((restored.db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_dispositions")
    .get() as { n: number }).n, 0);
  assert.equal(restored.raw.rows.size, 1);
  const hold = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/holds`,
    { hold_id: "hold-after-rollback-1", reason: "Do not reclassify destroyed proof" },
  ), restored.env, auth("owner"));
  assert.equal(hold.status, 409);
  assert.equal((await responseBody(hold)).error, "evidence_privacy_reconciliation_required");
  await assert.rejects(resolveEvidenceUploads(restored.env, auth(), STOCK, [id]), /evidence_privacy_reconciliation_required/);
  const replay = await handleEvidenceUpload(evidenceUploadRequest(STOCK, key), restored.env, auth());
  assert.equal(replay.status, 409);
  assert.equal((await responseBody(replay)).error, "evidence_privacy_reconciliation_required");
  const list = await handleAuthenticatedRoute(new Request("https://app.example.invalid/api/v1/privacy/evidence-uploads"), restored.env, auth("owner"));
  assert.equal((await list.json() as { receipts: Array<{ disposition_state: string }> }).receipts[0]?.disposition_state, "quarantined");
  const audit = await handleAuthenticatedRoute(new Request(`https://app.example.invalid/api/v1/privacy/evidence-uploads/${id}/audit`), restored.env, auth("owner"));
  const detail = await audit.json() as { disposition_state: string; external_marker_present: boolean;
    external_marker_decision_id: string; object_status: string };
  assert.equal(detail.disposition_state, "quarantined");
  assert.equal(detail.external_marker_present, true);
  assert.equal(detail.external_marker_decision_id, decision.decision_id);
  assert.equal(detail.object_status, "restore_reappeared");

  const resumed = await handleAuthenticatedRoute(privacyCommand(path, decision), restored.env, auth("owner"));
  assert.equal(resumed.status, 200);
  assert.equal(restored.raw.rows.size, 0);
  assert.deepEqual([...live.ledger.rows.values()][0], markerBytes);
  assert.equal((restored.db.raw.prepare("SELECT state FROM evidence_upload_dispositions WHERE receipt_id = ?")
    .get(id) as { state: string }).state, "destroyed");
});

test("an owner can reconcile and re-purge a marked receipt when the old D1 decision text is lost", async () => {
  const live = fixture();
  const restored = fixture();
  const key = "restore-with-unknown-decision-text";
  const id = await uploadedEvidence(live.env, auth(), STOCK, key);
  assert.equal(await uploadedEvidence(restored.env, auth(), STOCK, key), id);
  const stored = live.db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string; r2_key: string };
  const original = live.raw.rows.get(stored.r2_key)!;
  const oldDecision = destroyBody(stored.sha256, "decision-before-restore");
  const destroyPath = `/api/v1/privacy/evidence-uploads/${id}/destruction`;
  assert.equal((await handleAuthenticatedRoute(privacyCommand(destroyPath, oldDecision), live.env, auth("owner"))).status, 200);
  restored.env.PRIVACY_LEDGER = live.ledger as never;
  restored.raw.rows.set(stored.r2_key, original);
  const reconcilePath = `/api/v1/privacy/evidence-uploads/${id}/reconciliation`;
  const request = { decision_id: "decision-restore-reconciliation", marker_decision_id: oldDecision.decision_id,
    reason: "Owner verified the prior disposal marker after D1 restore", expected_sha256: stored.sha256 };
  const [markerKey, markerBytes] = [...live.ledger.rows.entries()][0]!;
  const marker = JSON.parse(new TextDecoder().decode(markerBytes)) as Record<string, unknown>;
  live.ledger.rows.set(markerKey, new TextEncoder().encode(JSON.stringify({ ...marker, receipt_sha256: "0".repeat(64) })));
  const changedMarker = await handleAuthenticatedRoute(privacyCommand(reconcilePath, request), restored.env, auth("owner"));
  assert.equal(changedMarker.status, 409);
  assert.equal((await responseBody(changedMarker)).error, "evidence_destruction_conflict");
  assert.equal(restored.raw.rows.size, 1);
  live.ledger.rows.set(markerKey, markerBytes);
  const wrongMarker = await handleAuthenticatedRoute(privacyCommand(reconcilePath,
    { ...request, marker_decision_id: "decision-other-marker" }), restored.env, auth("owner"));
  assert.equal(wrongMarker.status, 409);
  assert.equal((restored.db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_dispositions")
    .get() as { n: number }).n, 0);
  const recovered = await handleAuthenticatedRoute(privacyCommand(reconcilePath, request), restored.env, auth("owner"));
  assert.equal(recovered.status, 200);
  assert.equal(recovered.headers.get("cache-control"), "private, no-store");
  assert.equal((await responseBody(recovered)).result, "reconciled");
  assert.equal(restored.raw.rows.size, 0);
  const row = restored.db.raw.prepare("SELECT state, decision_id, authority_ref, reason FROM evidence_upload_dispositions WHERE receipt_id = ?")
    .get(id) as { state: string; decision_id: string; authority_ref: string; reason: string };
  assert.equal(row.state, "destroyed");
  assert.equal(row.decision_id, request.decision_id);
  assert.match(row.authority_ref, /^restore-marker:[0-9a-f]{64}$/);
  assert.equal(row.reason, request.reason);
  assert.equal((restored.db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_privacy_events WHERE receipt_id = ? AND kind = 'destruction_requested'")
    .get(id) as { n: number }).n, 1);
  const replay = await handleAuthenticatedRoute(privacyCommand(reconcilePath, request), restored.env, auth("owner"));
  assert.equal(replay.status, 200);
  assert.equal((await responseBody(replay)).result, "replayed");
  assert.equal((await handleAuthenticatedRoute(privacyCommand(reconcilePath,
    { ...request, reason: "A different owner reason" }), restored.env, auth("owner"))).status, 409);
});

test("restore reconciliation refuses an unmarked receipt and cannot manufacture prior disposal", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const hash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string }).sha256;
  const result = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/reconciliation`,
    { decision_id: "decision-reconcile-unmarked", marker_decision_id: "decision-missing-marker",
      reason: "Try to reconcile a receipt that was never destroyed", expected_sha256: hash },
  ), env, auth("owner"));
  assert.equal(result.status, 409);
  assert.equal((await responseBody(result)).error, "evidence_privacy_reconciliation_not_required");
  assert.equal(raw.rows.size, 1);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_dispositions")
    .get() as { n: number }).n, 0);
});

test("reconciliation does not delete RAW when the surviving marker vanishes before readback", async () => {
  const live = fixture();
  const restored = fixture();
  const key = "restore-marker-vanishes";
  const id = await uploadedEvidence(live.env, auth(), STOCK, key);
  assert.equal(await uploadedEvidence(restored.env, auth(), STOCK, key), id);
  const stored = live.db.raw.prepare("SELECT sha256, r2_key FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string; r2_key: string };
  const original = live.raw.rows.get(stored.r2_key)!;
  const prior = destroyBody(stored.sha256, "decision-marker-vanishes");
  assert.equal((await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/destruction`, prior), live.env, auth("owner"))).status, 200);
  restored.env.PRIVACY_LEDGER = live.ledger as never;
  restored.raw.rows.set(stored.r2_key, original);
  const originalGet = live.ledger.get.bind(live.ledger);
  let reads = 0;
  live.ledger.get = async (markerKey) => {
    reads++;
    if (reads === 3) live.ledger.rows.delete(markerKey);
    return originalGet(markerKey);
  };
  const result = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/reconciliation`,
    { decision_id: "decision-reconcile-marker-vanishes", marker_decision_id: prior.decision_id,
      reason: "Attempt to re-purge after the marker vanishes", expected_sha256: stored.sha256 },
  ), restored.env, auth("owner"));
  assert.equal(result.status, 502);
  assert.equal((await responseBody(result)).error, "evidence_privacy_ledger_unavailable");
  assert.equal(restored.raw.rows.size, 1);
  assert.equal((restored.db.raw.prepare("SELECT state FROM evidence_upload_dispositions WHERE receipt_id = ?")
    .get(id) as { state: string }).state, "destroying");
});

test("a readable changed privacy marker is a conflict, while a failed R2 read stays unavailable", async () => {
  const { db, raw, ledger, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const hash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string }).sha256;
  const path = `/api/v1/privacy/evidence-uploads/${id}/destruction`;
  const request = () => handleAuthenticatedRoute(privacyCommand(path, destroyBody(hash)), env, auth("owner"));
  raw.failDelete = true;
  assert.equal((await request()).status, 502);
  raw.failDelete = false;
  const [key, original] = [...ledger.rows.entries()][0]!;
  const marker = JSON.parse(new TextDecoder().decode(original)) as Record<string, unknown>;
  ledger.rows.set(key, new TextEncoder().encode(JSON.stringify({ ...marker, decision_sha256: "0".repeat(64) })));
  const changed = await request();
  assert.equal(changed.status, 409);
  assert.equal((await responseBody(changed)).error, "evidence_destruction_conflict");
  assert.equal(raw.rows.size, 1);

  ledger.rows.set(key, new TextEncoder().encode("{broken"));
  const malformed = await request();
  assert.equal(malformed.status, 409);
  assert.equal((await responseBody(malformed)).error, "evidence_destruction_conflict");
  assert.equal(raw.rows.size, 1);

  ledger.failRead = true;
  const unavailable = await request();
  assert.equal(unavailable.status, 502);
  assert.equal((await responseBody(unavailable)).error, "evidence_privacy_ledger_unavailable");
  assert.equal(raw.rows.size, 1);
});

test("a failed ledger write or readback leaves D1 blocking use and never deletes RAW", async () => {
  const { db, raw, ledger, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const hash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?").get(id) as { sha256: string }).sha256;
  const request = () => handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(hash)), env, auth("owner"));
  ledger.failPut = true;
  assert.equal((await request()).status, 502);
  assert.equal(ledger.rows.size, 0);
  assert.equal((db.raw.prepare("SELECT state FROM evidence_upload_dispositions WHERE receipt_id = ?").get(id) as { state: string }).state, "destroying");
  assert.equal(raw.rows.size, 1);
  await assert.rejects(resolveEvidenceUploads(env, auth(), STOCK, [id]), /evidence_destruction_pending/);
  ledger.failPut = false;
  ledger.failRead = true;
  assert.equal((await request()).status, 502);
  assert.equal(ledger.rows.size, 1); // A lost readback also leaves the external marker.
  assert.equal(raw.rows.size, 1);
  ledger.failRead = false;
  assert.equal((await request()).status, 200);
  assert.equal(raw.rows.size, 0);
});

test("a D1 decision outage does not start destruction; an exact retry can still finish", async () => {
  const { db, raw, ledger, env } = fixture();
  const uploadKey = "d1-outage-upload";
  const id = await uploadedEvidence(env, auth(), STOCK, uploadKey);
  const hash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?").get(id) as { sha256: string }).sha256;
  const path = `/api/v1/privacy/evidence-uploads/${id}/destruction`;
  const request = (body = destroyBody(hash)) => handleAuthenticatedRoute(privacyCommand(path, body), env, auth("owner"));
  db.failDisposition = true;
  assert.equal((await request()).status, 502);
  assert.equal(ledger.rows.size, 0);
  assert.equal(raw.rows.size, 1);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_dispositions").get() as { n: number }).n, 0);
  assert.equal((await handleEvidenceUpload(evidenceUploadRequest(STOCK, uploadKey), env, auth())).status, 200);
  db.failDisposition = false;
  assert.equal((await request()).status, 200);
  assert.equal(ledger.rows.size, 1);
  assert.equal(raw.rows.size, 0);
});

test("D1 closes the manifest race before the external marker can be written", async () => {
  const { db, raw, ledger, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const receipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string };
  const originalPut = ledger.put.bind(ledger);
  let attempted = false;
  ledger.put = async (key, value, options) => {
    attempted = true;
    assert.throws(() => db.raw.prepare(`INSERT INTO evidence_upload_manifests
      (sha256, tenant_id, actor_user_id, purpose, target_id, action, operation_id, refs_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("f".repeat(64), TENANT, USERS.ops,
      STOCK.purpose, STOCK.targetId, STOCK.action, STOCK.operationId,
      JSON.stringify([{ ref: `evidence-upload://${id}`, sha256: receipt.sha256 }]), new Date().toISOString()),
    /evidence_disposition_blocks_manifest/);
    return originalPut(key, value, options);
  };
  const response = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256)), env, auth("owner"));
  assert.equal(response.status, 200);
  assert.equal(attempted, true);
  assert.equal(raw.rows.size, 0);
});

test("a D1 restore during marker creation cannot delete RAW under a lost decision", async () => {
  const live = fixture();
  const restored = fixture();
  const key = "restore-during-marker";
  const id = await uploadedEvidence(live.env, auth(), STOCK, key);
  assert.equal(await uploadedEvidence(restored.env, auth(), STOCK, key), id);
  const hash = (live.db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string }).sha256;
  const originalPut = live.ledger.put.bind(live.ledger);
  live.ledger.put = async (markerKey, value, options) => {
    const stored = await originalPut(markerKey, value, options);
    live.env.DB = restored.env.DB;
    return stored;
  };
  const path = `/api/v1/privacy/evidence-uploads/${id}/destruction`;
  const response = await handleAuthenticatedRoute(privacyCommand(path, destroyBody(hash)), live.env, auth("owner"));
  assert.equal(response.status, 502);
  assert.equal((await responseBody(response)).error, "evidence_destruction_settlement_unknown");
  assert.equal(live.raw.rows.size, 1);
  assert.equal(live.ledger.rows.size, 1);
  assert.equal((restored.db.raw.prepare("SELECT count(*) AS n FROM evidence_upload_dispositions")
    .get() as { n: number }).n, 0);
  await assert.rejects(resolveEvidenceUploads(live.env, auth(), STOCK, [id]), /evidence_privacy_reconciliation_required/);
  assert.equal((await handleAuthenticatedRoute(privacyCommand(path, destroyBody(hash)), live.env, auth("owner"))).status, 200);
  assert.equal(live.raw.rows.size, 0);
});

test("privacy mutations enforce owner parity, tenant, CSRF and exact decision identity", async () => {
  const { db, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const hash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?").get(id) as { sha256: string }).sha256;
  const base = `/api/v1/privacy/evidence-uploads/${id}`;
  const hold = { hold_id: "hold-authority-1", reason: "Keep this proof on legal hold" };
  const reconcile = { decision_id: "decision-access-denied", marker_decision_id: "decision-before-restore",
    reason: "An unauthorized reconciliation must not run", expected_sha256: hash };
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/reconciliation`, reconcile), env, auth())).status, 403);
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/reconciliation`, reconcile, false), env, auth("owner"))).status, 403);
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/holds`, hold, false), env, auth("owner"))).status, 403);
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/holds`, hold), env, auth())).status, 403);
  db.raw.exec("UPDATE app_users SET access_role = 'ops' WHERE user_id = 'appu_owner_0001'");
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/holds`, hold), env, auth("owner"))).status, 403);
  db.raw.exec("UPDATE app_users SET access_role = 'owner' WHERE user_id = 'appu_owner_0001'");
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,
    active,created_by,created_at,updated_at) VALUES ('appu_other_owner_1','other-tenant',
    'owner@other.invalid','Other owner','owner','owner',1,'seed',?,?)`).run(now, now);
  const other = auth("owner", "other-tenant"); other.session.user_id = "appu_other_owner_1";
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/holds`, hold), env, other)).status, 404);
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/destruction`, destroyBody(hash)), env, auth("owner"))).status, 200);
  assert.equal((await handleAuthenticatedRoute(privacyCommand(`${base}/destruction`, destroyBody(hash, "decision-other-1")), env, auth("owner"))).status, 409);
});

test("manual correction refuses durable business evidence and unapproved subject or retention claims", async () => {
  const { db, raw, env } = fixture();
  const id = await uploadedEvidence(env, auth(), STOCK);
  const receipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
    .get(id) as { sha256: string };
  const base = `/api/v1/privacy/evidence-uploads/${id}/destruction`;
  const send = (body: unknown) => handleAuthenticatedRoute(privacyCommand(base, body), env, auth("owner"));
  for (const basis of ["subject_request", "approved_retention"]) {
    const response = await send({ ...destroyBody(receipt.sha256), basis });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, "evidence_policy_not_approved");
  }
  const refs = JSON.stringify([{ ref: `evidence-upload://${id}`, sha256: receipt.sha256 }]);
  db.raw.prepare("INSERT INTO inventory_commands (tenant_id, command_id, transition, status, evidence_refs_json) VALUES (?, ?, ?, ?, ?)")
    .run(TENANT, STOCK.operationId, STOCK.action, "rejected", refs);
  const denied = await send(destroyBody(receipt.sha256));
  assert.equal(denied.status, 409);
  assert.equal((await denied.json() as { error: string }).error, "evidence_business_record_linked");
  assert.equal(raw.rows.size, 1);
  assert.equal((db.raw.prepare("SELECT count(*) AS count FROM evidence_upload_dispositions").get() as { count: number }).count, 0);
  // Historical arrays can contain plain strings. They cannot break an unrelated
  // owner disposal or a new domain write that names no disposed receipt.
  db.raw.prepare("INSERT INTO inventory_commands (tenant_id, command_id, transition, status, evidence_refs_json) VALUES (?, ?, ?, ?, ?)")
    .run(TENANT, "cmd_legacy_text_01", "receive", "applied", JSON.stringify(["legacy://paper-note"]));
  const intakeId = await uploadedEvidence(env, auth(), INTAKE);
  await resolveEvidenceUploads(env, auth(), INTAKE, [intakeId]);
  const intakeHash = (db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?").get(intakeId) as { sha256: string }).sha256;
  const manifestOnly = await handleAuthenticatedRoute(privacyCommand(
    `/api/v1/privacy/evidence-uploads/${intakeId}/destruction`, destroyBody(intakeHash, "decision-manifest-1")), env, auth("owner"));
  assert.equal(manifestOnly.status, 200); // a prepared manifest alone is not a domain record
  assert.equal((db.raw.prepare("SELECT count(*) AS count FROM evidence_upload_manifests").get() as { count: number }).count, 1);
  assert.equal(raw.rows.size, 1); // the earlier durable stock receipt remains; the intake bytes were removed
  const after = await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(intakeId)), env, auth());
  assert.notEqual(after.status, 201);
  assert.equal((db.raw.prepare("SELECT count(*) AS count FROM service_cases").get() as { count: number }).count, 0);
});

test("manifest-only correction closes later stock, corrective and service writes in D1", async () => {
  const { db, env } = fixture();
  async function dispose(id: string, decisionId: string): Promise<string> {
    const receipt = db.raw.prepare("SELECT sha256 FROM evidence_upload_receipts WHERE receipt_id = ?")
      .get(id) as { sha256: string };
    const response = await handleAuthenticatedRoute(privacyCommand(
      `/api/v1/privacy/evidence-uploads/${id}/destruction`, destroyBody(receipt.sha256, decisionId)),
      env, auth("owner"));
    assert.equal(response.status, 200);
    return receipt.sha256;
  }

  const stockId = await uploadedEvidence(env, auth(), STOCK);
  await resolveEvidenceUploads(env, auth(), STOCK, [stockId]);
  const stockHash = await dispose(stockId, "decision-stock-orphan-1");
  const stockRefs = JSON.stringify([{ ref: `evidence-upload://${stockId}`, sha256: stockHash }]);
  assert.throws(() => db.raw.prepare("INSERT INTO inventory_commands (tenant_id, command_id, transition, status, evidence_refs_json) VALUES (?, ?, ?, ?, ?)")
    .run(TENANT, STOCK.operationId, STOCK.action, "pending", stockRefs),
  /evidence_disposition_blocks_domain_link/);
  assert.throws(() => db.raw.prepare("INSERT INTO inventory_commands (tenant_id, command_id, transition, status, evidence_refs_json) VALUES (?, ?, ?, ?, ?)")
    .run(TENANT, "cmd_text_ref_01", STOCK.action, "pending", JSON.stringify([`evidence-upload://${stockId}`])),
  /evidence_disposition_blocks_domain_link/);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM inventory_commands").get() as { n: number }).n, 0);

  const now = new Date().toISOString();
  await reportSafetyOccurrence(env, { occurrenceId: "occ_orphan_01", tenantId: TENANT,
    occurrenceKind: "hazard", severity: "high", scope: { type: "tenant", id: TENANT },
    reportedByUserId: USERS.field, reportedAt: now, summary: "Synthetic loose material",
    rescueRequired: false, evidence: null, capturedOffline: false, deviceActionId: null, now });
  await assignCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_orphan_01",
    occurrenceId: "occ_orphan_01", riskLevel: "high", ownerUserId: USERS.ops,
    dueAt: now, description: "Remove the loose material", recurrenceOfId: null,
    actorUserId: USERS.owner, now });
  const corrective: EvidenceScope = { purpose: "corrective_action", targetId: "ca_orphan_01",
    action: "submit", operationId: "" };
  const correctiveId = await uploadedEvidence(env, auth(), corrective);
  await resolveEvidenceUploads(env, auth(), corrective, [correctiveId]);
  const correctiveHash = await dispose(correctiveId, "decision-corrective-orphan-1");
  const correctiveRefs = JSON.stringify([{ ref: `evidence-upload://${correctiveId}`, sha256: correctiveHash }]);
  const correctiveDigest = (db.raw.prepare(`SELECT sha256 FROM evidence_upload_manifests
    WHERE tenant_id = ? AND purpose = 'corrective_action' AND target_id = ?`).get(TENANT,
    corrective.targetId) as { sha256: string }).sha256;
  const legacyRefs = JSON.stringify([{ ref: "legacy://site-note", sha256: correctiveHash }]);
  assert.throws(() => db.raw.prepare(`UPDATE safety_corrective_actions SET version = version + 1,
      state = 'evidence_submitted', evidence_refs_json = ?, evidence_sha256 = ?,
      evidence_captured_by_user_id = ?, evidence_submitted_at = ?, updated_at = ?
      WHERE tenant_id = ? AND corrective_action_id = ?`)
    .run(correctiveRefs, correctiveHash, USERS.ops, now, now, TENANT, corrective.targetId),
  /evidence_disposition_blocks_domain_link|evidence_receipt_manifest_required/);
  assert.throws(() => db.raw.prepare(`UPDATE safety_corrective_actions SET version = version + 1,
      state = 'evidence_submitted', evidence_refs_json = ?, evidence_sha256 = ?,
      evidence_captured_by_user_id = ?, evidence_submitted_at = ?, updated_at = ?
      WHERE tenant_id = ? AND corrective_action_id = ?`)
    .run(legacyRefs, correctiveDigest, USERS.ops, now, now, TENANT, corrective.targetId),
  /evidence_disposition_blocks_domain_link/);
  assert.throws(() => db.raw.prepare(`INSERT INTO safety_corrective_actions
      (corrective_action_id, tenant_id, occurrence_id, version, state, risk_level, owner_user_id,
        assigned_by_user_id, due_at, description, recurrence_of_id, evidence_refs_json,
        evidence_sha256, evidence_captured_by_user_id, evidence_submitted_at, verified_by_user_id,
        verified_at, closed_at, created_at, updated_at)
      SELECT 'ca_digest_late_01', tenant_id, occurrence_id, 1, 'evidence_submitted', risk_level,
        owner_user_id, assigned_by_user_id, due_at, description, NULL, ?, ?, ?, ?, NULL, NULL,
        NULL, ?, ? FROM safety_corrective_actions WHERE corrective_action_id = ?`)
    .run(legacyRefs, correctiveDigest, USERS.ops, now, now, now, corrective.targetId),
  /evidence_disposition_blocks_domain_link/);
  assert.equal((db.raw.prepare("SELECT state FROM safety_corrective_actions WHERE corrective_action_id = ?")
    .get(corrective.targetId) as { state: string }).state, "open");

  const intakeId = await uploadedEvidence(env, auth(), INTAKE);
  const opened = await handleAuthenticatedRoute(command("/api/v1/service-cases", intakeBody(intakeId)), env, auth());
  assert.equal(opened.status, 201);
  const caseId = (await responseBody(opened)).service_case!.service_case_id;
  const step: EvidenceScope = { purpose: "service_step", targetId: caseId, action: "triage", operationId: "" };
  const stepId = await uploadedEvidence(env, auth(), step);
  const digest = (await resolveEvidenceUploads(env, auth(), step, [stepId])).sha256;
  await dispose(stepId, "decision-service-orphan-1");
  assert.throws(() => db.raw.prepare(`INSERT INTO service_case_triage (triage_id,service_case_id,tenant_id,case_version,
    advisory_source,advisory_category,advisory_confidence_bps,final_category,responsibility,
    authority_kind,decided_by_user_id,decided_by_role,evidence_digest,decided_at,created_at)
    VALUES ('svc_triage_orphan_01',?,?,1,'none',NULL,NULL,'workmanship',
      'ironwrap_workmanship','human',?,'ops',?,?,?)`)
    .run(caseId, TENANT, USERS.ops, digest, now, now),
  /evidence_disposition_blocks_domain_link/);
  assert.equal((db.raw.prepare("SELECT count(*) AS n FROM service_case_triage WHERE service_case_id = ?")
    .get(caseId) as { n: number }).n, 0);
});
