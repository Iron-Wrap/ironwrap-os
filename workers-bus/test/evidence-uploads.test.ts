import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";
import { handleEvidenceUpload, MAX_EVIDENCE_FILE_BYTES, MAX_EVIDENCE_REQUEST_BYTES, resolveEvidenceUploads, type EvidenceScope } from "../src/evidence-uploads.ts";
import { assignCorrectiveAction, reportSafetyOccurrence, verifyCorrectiveAction } from "../src/safety-lifecycle.ts";
import { EVIDENCE_BYTES, EvidenceR2, evidenceUploadRequest, uploadedEvidence } from "./evidence-upload-fixture.ts";

const TENANT = "ironwrap";
const USERS = { owner: "appu_owner_0001", ops: "appu_ops_0001", field: "appu_field_0001", production: "appu_production_1", sales: "appu_sales_0001" };
class D1 {
  raw = new DatabaseSync(":memory:");
  failReceipt = false;
  failManifest = false;
  symptomReadBarrier: (() => Promise<void>) | null = null;
  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const file of ["0011_app_bff_auth.sql", "0013_field_action_throttles.sql", "0042_external_effect_runtime.sql", "0047_safety_lifecycle.sql", "0056_service_case_lifecycle.sql", "0139_evidence_upload_receipts.sql", "0140_service_case_atomic_steps.sql"]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    this.raw.exec(`ALTER TABLE app_users ADD COLUMN access_role TEXT;
      CREATE TABLE inventory_lots (tenant_id TEXT, lot_id TEXT);
      INSERT INTO inventory_lots VALUES ('ironwrap', 'lot_synthetic_1'), ('ironwrap', 'lot_synthetic_2');
      CREATE TABLE operating_roof_jobs (tenant_id TEXT, roof_job_id TEXT);
      INSERT INTO operating_roof_jobs VALUES ('ironwrap', 'JOB-SYNTHETIC-1'), ('ironwrap', 'JOB-SYNTHETIC-2');`);
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
          const row = (db.raw.prepare(sql).get(...args as never[]) ?? null) as T | null;
          if (sql.includes("symptom_code = ? AND state != 'closed'")) await db.symptomReadBarrier?.();
          return row;
        },
        async all<T>() { return { results: db.raw.prepare(sql).all(...args as never[]) as T[] }; },
        async run() {
          if (db.failReceipt && sql.startsWith("INSERT INTO evidence_upload_receipts")) throw new Error("synthetic D1 receipt outage");
          if (db.failManifest && sql.startsWith("INSERT INTO evidence_upload_manifests")) throw new Error("synthetic D1 manifest outage");
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
  const db = new D1(); const raw = new EvidenceR2();
  const env = { DB: db, RAW: raw, APP_ALLOW_INSECURE_LOCAL: "true", APP_EVIDENCE_RECEIPTS_REQUIRED: "true" } as never as AppEnv;
  return { db, raw, env };
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

test("intake exact retry and concurrent retry return the original case; changed intent conflicts", async () => {
  const { db, env } = fixture(); const id = await uploadedEvidence(env, auth(), INTAKE); const body = intakeBody(id);
  const send = (value: unknown = body) => handleAuthenticatedRoute(command("/api/v1/service-cases", value), env, auth());
  const initial = await Promise.all([send(), send()]);
  assert.deepEqual(initial.map((res) => res.status).sort(), [200, 201]);
  const first = await responseBody(initial.find((res) => res.status === 201)!);
  assert.equal(first.result, "opened");
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
  const { db, env } = fixture(); delete env.APP_EVIDENCE_RECEIPTS_REQUIRED;
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
  const stored = raw.rows.values().next().value!; const original = stored.bytes.slice(); stored.bytes[14] ^= 1;
  const send = () => handleAuthenticatedRoute(command("/api/v1/safety/corrective-actions/ca_synthetic_01/evidence", { evidence_receipt_ids: [id], detail: "Synthetic control photographed" }), env, auth());
  assert.equal((await send()).status, 409);
  assert.equal((db.raw.prepare("SELECT state FROM safety_corrective_actions").get() as { state: string }).state, "open");
  stored.bytes = original;
  assert.equal((await send()).status, 200);
  await assert.rejects(verifyCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_synthetic_01", actorUserId: USERS.ops, verdict: "verified", detail: "I own and captured this evidence", now }), /reporter, owner, and evidence capturer/);
  const verified = await verifyCorrectiveAction(env, { tenantId: TENANT, correctiveActionId: "ca_synthetic_01", actorUserId: USERS.owner, verdict: "verified", detail: "Independent synthetic inspection", now });
  assert.equal(verified.state, "verified");
  assert.equal((await send()).status, 200); // exact lost-response replay remains safe after verification
});
