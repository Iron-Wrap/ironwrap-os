import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  claimAuthorityRecordAction,
  completeAuthorityRecordAction,
  listAuthorityRecordReadbacks,
  recordAuthorityReadback,
} from "../src/authority-records.ts";
import { handleAuthorityRecordRoute } from "../src/authority-record-api.ts";
import { handleAuthorityRecordExecutorRoute } from "../src/authority-record-executor-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "other-tenant";
const NOW = "2026-08-17T12:00:00.000Z";
const ACTOR = "appu_ops_authority_0001";
const FRAPPE_ACTOR = "ops@authority.example.invalid";
const OTHER_ACTOR = "appu_ops_other_authority_01";
const RECORD = "Authority-Record-0001";
const EVIDENCE_SHA256 = "c".repeat(64);

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec(readFileSync(new URL("../migrations/0011_app_bff_auth.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0045_authority_record_actions.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0091_authority_readback_subject_scope.sql", import.meta.url), "utf8"));
    const insert = this.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ops', ?, 1, 'seed', ?, ?)`,
    );
    insert.run(ACTOR, TENANT, "ops@authority.example.invalid", "Authority Ops", "ops@authority.example.invalid", NOW, NOW);
    insert.run(OTHER_ACTOR, OTHER_TENANT, "ops@other.example.invalid", "Other Ops", "ops@other.example.invalid", NOW, NOW);
  }

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => {
        const statement = this.raw.prepare(sql);
        return {
          first: async <T>() => (statement.get(...args) ?? null) as T | null,
          all: async <T>() => ({ results: statement.all(...args) as T[] }),
          run: async () => {
            const result = statement.run(...args);
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
      },
    };
  }
}

function env(db: SqliteD1): AppEnv {
  return { DB: db as never, AUTHORITY_RECORD_EXECUTOR_HMAC_KEY: "x".repeat(32) } as AppEnv;
}

function auth(role: AppRole, tenantId = TENANT): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole(role),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: NOW,
      session_expires_at: "2026-08-18T12:00:00.000Z",
      revoked_at: null,
      user_id: role === "ops" ? ACTOR : `appu_${role}_authority_0001`,
      tenant_id: tenantId,
      email_normalized: `${role}@authority.example.invalid`,
      display_name: role,
      role,
      frappe_user_id: `${role}@authority.example.invalid`,
      active: 1,
      created_by: ACTOR,
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

function apiRequest(
  method: string,
  path: string,
  payload?: Record<string, unknown>,
  csrf = true,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (csrf) headers.set("x-csrf-token", "csrf");
  return new Request(`https://app.example.invalid${path}`, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function executorRequest(path: string, payload: Record<string, unknown>, key = "x".repeat(32)): Request {
  const raw = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", key)
    .update(`${timestamp}\nPOST\n${path}\n${raw}`)
    .digest("hex");
  return new Request(`https://bus.example.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-authority-executor-timestamp": timestamp,
      "x-ironwrap-authority-executor-signature": signature,
    },
    body: raw,
  });
}

const AUTHORITY_DIGEST_FIELDS = [
  "authority_record_id", "tenant", "subject_type", "subject_role", "person_user", "organization",
  "authority_kind", "authority_scope", "scope_type", "scope_ref", "roof_job", "scope_json",
  "issuer_name", "issuer_jurisdiction", "issuer_reference", "source_version", "evidence_refs_json",
  "evidence_sha256", "effective_from", "expires_at", "version", "status", "verification_method",
  "verified_at", "verification_reference", "verified_by", "revoked_at", "revocation_reference",
  "revoked_by", "supersedes", "correction_reason", "exception_status", "exception_reason",
] as const;

function authorityMaterial(): Record<string, unknown> {
  const material: Record<string, unknown> = {
    authority_record_id: RECORD,
    tenant: TENANT,
    subject_type: "Person",
    subject_role: "Worker",
    person_user: "worker@example.invalid",
    organization: "",
    authority_kind: "Worker Competency",
    authority_scope: "field installation",
    scope_type: "Field",
    scope_ref: "field:job-1",
    roof_job: "job-1",
    scope_json: "{}",
    issuer_name: "IronWrap Production",
    issuer_jurisdiction: "AB-CA",
    issuer_reference: "internal:competency:1",
    source_version: "assessment:1",
    evidence_refs_json: JSON.stringify([{ ref: "r2://authority/competency-1", sha256: EVIDENCE_SHA256 }]),
    evidence_sha256: EVIDENCE_SHA256,
    effective_from: "2026-08-17",
    expires_at: "2026-12-31",
    version: 1,
    status: "Verified",
    verification_method: "Internal Competency Assessment",
    verified_at: "2026-08-17 12:00:00",
    verification_reference: "assessment:1",
    verified_by: ACTOR,
    revoked_at: "",
    revocation_reference: "",
    revoked_by: "",
    supersedes: "",
    correction_reason: "",
    exception_status: "None",
    exception_reason: "",
    issuer_readback_json: "",
  };
  material.state_digest_sha256 = sha256(canonicalJson(Object.fromEntries(
    AUTHORITY_DIGEST_FIELDS.map((field) => [field, material[field] ?? ""]),
  )));
  return material;
}

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    actionId: "Authority-Action-0001",
    tenantId: TENANT,
    authorityRecordId: RECORD,
    operation: "verify" as const,
    expectedVersion: 1,
    idempotencyKey: "authority-verify-0001",
    requestFingerprintSha256: "a".repeat(64),
    actorUserId: ACTOR,
    now: NOW,
    ...overrides,
  };
}

function readbackInput(overrides: Record<string, unknown> = {}) {
  return {
    readbackId: "Authority-Readback-0001",
    tenantId: TENANT,
    authorityRecordId: RECORD,
    authorityVersion: 1,
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Worker Competency",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerName: "Alberta issuer",
    issuerJurisdiction: "AB-CA",
    issuerReference: "https://issuer.example.invalid/record/1",
    issuerSourceVersion: "2026-08-17",
    verificationState: "verified" as const,
    evidenceRefsJson: JSON.stringify([{ ref: "r2://authority/record-1.pdf", sha256: EVIDENCE_SHA256 }]),
    evidenceSha256: EVIDENCE_SHA256,
    authorityStateDigestSha256: "e".repeat(64),
    observedByUserId: ACTOR,
    observedAt: NOW,
    actionId: "Authority-Action-0001",
    ...overrides,
  };
}

test("authority actions are tenant-bound and replay/idempotency safe", async () => {
  const db = new SqliteD1();
  const first = await claimAuthorityRecordAction(env(db), claimInput());
  assert.equal(first.kind, "claimed");
  assert.equal(first.action.status, "pending");

  const replay = await claimAuthorityRecordAction(env(db), claimInput());
  assert.equal(replay.kind, "replayed");
  assert.equal(replay.action.action_id, first.action.action_id);

  const conflict = await claimAuthorityRecordAction(env(db), claimInput({
    requestFingerprintSha256: "b".repeat(64),
  }));
  assert.equal(conflict.kind, "conflict");

  const otherTenant = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Other-01",
    tenantId: OTHER_TENANT,
    actorUserId: OTHER_ACTOR,
    idempotencyKey: "authority-verify-other-01",
  }));
  assert.equal(otherTenant.kind, "claimed");
  assert.equal(await completeAuthorityRecordAction(env(db), {
    tenantId: TENANT,
    actionId: first.action.action_id,
    actorUserId: OTHER_ACTOR,
    terminal: {
      kind: "material_applied",
      actionId: "Authority-Action-0001",
      authorityRecordId: RECORD,
      authorityVersion: 1,
      authorityStateDigestSha256: "e".repeat(64),
      materialReadbackSha256: "f".repeat(64),
    },
    now: NOW,
  }).catch((error: unknown) => (error as Error).message), "authority_record_business_actor_required");
});

test("authority action completion is an explicit terminal transition", async () => {
  const db = new SqliteD1();
  const claimed = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Complete-01",
    idempotencyKey: "authority-verify-complete-01",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Complete-01",
    actionId: claimed.action.action_id,
  }));
  const completed = await completeAuthorityRecordAction(env(db), {
    tenantId: TENANT,
    actionId: claimed.action.action_id,
    actorUserId: ACTOR,
    terminal: {
      kind: "material_applied",
      actionId: claimed.action.action_id,
      authorityRecordId: RECORD,
      authorityVersion: 1,
      authorityStateDigestSha256: "e".repeat(64),
      materialReadbackSha256: "f".repeat(64),
    },
    now: NOW,
  });
  assert.equal(completed?.status, "applied");
  assert.equal(completed?.completed_at, NOW);
  const replayedCompletion = await completeAuthorityRecordAction(env(db), {
    tenantId: TENANT,
    actionId: claimed.action.action_id,
    actorUserId: ACTOR,
    terminal: {
      kind: "reconciliation_required",
      actionId: claimed.action.action_id,
      authorityRecordId: RECORD,
      reason: "late_retry",
      reconciliationReceiptSha256: "a".repeat(64),
    },
    now: "2026-08-17T12:01:00.000Z",
  });
  assert.equal(replayedCompletion?.status, "applied");
  assert.throws(
    () => db.raw.prepare("DELETE FROM authority_record_actions WHERE action_id = ?").run(claimed.action.action_id),
    /authority_record_actions_retained/,
  );
});

test("verification cannot complete without a verified issuer readback", async () => {
  const db = new SqliteD1();
  const claimed = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-No-Readback-01",
    idempotencyKey: "authority-verify-no-readback-01",
  }));
  await assert.rejects(
    () => completeAuthorityRecordAction(env(db), {
      tenantId: TENANT,
      actionId: claimed.action.action_id,
      actorUserId: ACTOR,
      terminal: {
        kind: "material_applied",
        actionId: claimed.action.action_id,
        authorityRecordId: RECORD,
        authorityVersion: 1,
        authorityStateDigestSha256: "e".repeat(64),
        materialReadbackSha256: "f".repeat(64),
      },
      now: NOW,
    }),
    /authority_record_issuer_readback_required/,
  );
});

test("issuer readbacks retain exact references, states, and tenant scope", async () => {
  const db = new SqliteD1();
  const action = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Readback-01",
    idempotencyKey: "authority-verify-readback-01",
  }));
  const input = readbackInput({ actionId: action.action.action_id });
  const recorded = await recordAuthorityReadback(env(db), input);
  assert.equal(recorded.kind, "recorded");
  assert.equal(recorded.readback.verification_state, "verified");
  assert.equal(recorded.readback.evidence_sha256, EVIDENCE_SHA256);

  const replayed = await recordAuthorityReadback(env(db), input);
  assert.equal(replayed.kind, "replayed");
  const conflict = await recordAuthorityReadback(env(db), {
    ...input,
    verificationState: "revoked",
  });
  assert.equal(conflict.kind, "conflict");

  const revoked = await recordAuthorityReadback(env(db), {
    ...input,
    readbackId: "Authority-Readback-Revoked-01",
    authorityVersion: 2,
    evidenceSha256: "d".repeat(64),
    evidenceRefsJson: JSON.stringify([{ ref: "r2://authority/record-1-revoked.pdf", sha256: "d".repeat(64) }]),
    verificationState: "revoked",
    actionId: null,
  });
  assert.equal(revoked.kind, "recorded");
  assert.equal(revoked.readback.verification_state, "revoked");

  const otherTenantRows = await listAuthorityRecordReadbacks(env(db), OTHER_TENANT, RECORD);
  assert.deepEqual(otherTenantRows, []);
  assert.throws(
    () => db.raw.prepare("UPDATE authority_record_readbacks SET issuer_name = 'forged' WHERE readback_id = ?")
      .run(recorded.readback.readback_id),
    /authority_record_readbacks_append_only/,
  );
});

test("readback action references cannot cross tenant or authority identity", async () => {
  const db = new SqliteD1();
  assert.rejects(
    () => recordAuthorityReadback(env(db), readbackInput({
      actionId: "Authority-Action-Missing-01",
    })),
    /authority_record_readback_action_tenant_mismatch/,
  );
  const action = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Mismatch-01",
    idempotencyKey: "authority-verify-mismatch-01",
  }));
  assert.rejects(
    () => recordAuthorityReadback(env(db), readbackInput({
      readbackId: "Authority-Readback-Mismatch-01",
      authorityRecordId: "Authority-Record-Other-01",
      actionId: action.action.action_id,
    })),
    /authority_record_readback_action_tenant_mismatch/,
  );
});

test("PWA authority routes derive tenant and actor, enforce CSRF, and expose readbacks", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const claimed = await handleAuthorityRecordRoute(
    apiRequest("POST", "/api/v1/authority-records/actions", {
      action_id: "Authority-Action-Api-01",
      authority_record_id: RECORD,
      expected_version: 1,
      idempotency_key: "authority-api-verify-01",
      operation: "verify",
      request_fingerprint_sha256: "d".repeat(64),
    }),
    appEnv,
    auth("ops"),
  );
  assert.equal(claimed?.status, 201);

  const deniedFieldWrite = await handleAuthorityRecordRoute(
    apiRequest("POST", "/api/v1/authority-records/actions", {
      action_id: "Authority-Action-Api-02",
      authority_record_id: RECORD,
      expected_version: 1,
      idempotency_key: "authority-api-verify-02",
      operation: "verify",
      request_fingerprint_sha256: "e".repeat(64),
    }),
    appEnv,
    auth("field"),
  );
  assert.equal(deniedFieldWrite?.status, 403);

  const deniedCsrf = await handleAuthorityRecordRoute(
    apiRequest("POST", "/api/v1/authority-records/actions", {
      action_id: "Authority-Action-Api-03",
      authority_record_id: RECORD,
      expected_version: 1,
      idempotency_key: "authority-api-verify-03",
      operation: "verify",
      request_fingerprint_sha256: "f".repeat(64),
    }, false),
    appEnv,
    auth("ops"),
  );
  assert.equal(deniedCsrf?.status, 403);

  const readAsField = await handleAuthorityRecordRoute(
    apiRequest("GET", "/api/v1/authority-records/actions/Authority-Action-Api-01"),
    appEnv,
    auth("field"),
  );
  assert.equal(readAsField?.status, 200);
  assert.equal(
    (await readAsField?.json() as { action: { tenant_id: string } }).action.tenant_id,
    TENANT,
  );

  const crossTenantRead = await handleAuthorityRecordRoute(
    apiRequest("GET", "/api/v1/authority-records/actions/Authority-Action-Api-01"),
    appEnv,
    auth("field", OTHER_TENANT),
  );
  assert.equal(crossTenantRead?.status, 404);

  const readback = await handleAuthorityRecordRoute(
    apiRequest("POST", "/api/v1/authority-records/readbacks", {
      action_id: "Authority-Action-Api-01",
      authority_record_id: RECORD,
      authority_version: 1,
      evidence_refs_json: JSON.stringify([{ ref: "r2://authority/api-1", sha256: EVIDENCE_SHA256 }]),
      evidence_sha256: EVIDENCE_SHA256,
      issuer_jurisdiction: "AB-CA",
      issuer_name: "Alberta issuer",
      issuer_reference: "issuer:api:1",
      issuer_source_version: "2026-08-17",
      readback_id: "Authority-Readback-Api-01",
      verification_state: "verified",
    }),
    appEnv,
    auth("ops"),
  );
  assert.equal(readback?.status, 403);

  const completed = await handleAuthorityRecordRoute(
    apiRequest("POST", "/api/v1/authority-records/actions/Authority-Action-Api-01/complete", {
      rejection_code: null,
      result_json: JSON.stringify({ authority_version: 1 }),
      status: "applied",
    }),
    appEnv,
    auth("ops"),
  );
  assert.equal(completed?.status, 403);
});

test("HMAC authority executor binds one command to exact Frappe material and terminalizes D1", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const material = authorityMaterial();
  const command = { ...material };
  const actionId = "Authority-Action-Executor-01";
  const claimPayload = {
    action_id: actionId,
    authority_record_id: RECORD,
    expected_version: 1,
    idempotency_key: "authority-executor-01",
    operation: "verify",
    request_fingerprint_sha256: sha256(canonicalJson({ command, issuer_receipt: null })),
    tenant_id: TENANT,
    actor_user_id: ACTOR,
    frappe_actor_user_id: FRAPPE_ACTOR,
    business_role: "IronWrap Production",
    command_json: JSON.stringify(command),
    issuer_receipt_json: null,
  };
  const claimed = await handleAuthorityRecordExecutorRoute(
    executorRequest("/internal/v1/authority-records/actions", claimPayload),
    appEnv,
  );
  assert.equal(claimed?.status, 201);
  const terminal = await handleAuthorityRecordExecutorRoute(
    executorRequest(`/internal/v1/authority-records/actions/${actionId}/terminal`, {
      action_id: actionId,
      command_json: JSON.stringify(command),
      issuer_receipt_json: null,
      material_readback_json: JSON.stringify(material),
      reconciliation_reason: null,
    }),
    appEnv,
  );
  assert.equal(terminal?.status, 200);
  const terminalPayload = await terminal?.json() as { action: { status: string; result_json: string } };
  assert.equal(terminalPayload.action.status, "applied");
  assert.match(terminalPayload.action.result_json, /authority_state_digest_sha256/);
});

test("authority executor turns forged material evidence into reconciliation and rejects bad HMAC", async () => {
  const db = new SqliteD1();
  const appEnv = env(db);
  const material = authorityMaterial();
  const actionId = "Authority-Action-Executor-02";
  const command = { ...material };
  const claimPayload = {
    action_id: actionId,
    authority_record_id: RECORD,
    expected_version: 1,
    idempotency_key: "authority-executor-02",
    operation: "verify",
    request_fingerprint_sha256: sha256(canonicalJson({ command, issuer_receipt: null })),
    tenant_id: TENANT,
    actor_user_id: ACTOR,
    frappe_actor_user_id: FRAPPE_ACTOR,
    business_role: "IronWrap Production",
    command_json: JSON.stringify(command),
    issuer_receipt_json: null,
  };
  const claimed = await handleAuthorityRecordExecutorRoute(
    executorRequest("/internal/v1/authority-records/actions", claimPayload),
    appEnv,
  );
  assert.equal(claimed?.status, 201);
  const forged = { ...material, evidence_sha256: "f".repeat(64) };
  const terminal = await handleAuthorityRecordExecutorRoute(
    executorRequest(`/internal/v1/authority-records/actions/${actionId}/terminal`, {
      action_id: actionId,
      command_json: JSON.stringify(command),
      issuer_receipt_json: null,
      material_readback_json: JSON.stringify(forged),
      reconciliation_reason: null,
    }),
    appEnv,
  );
  assert.equal(terminal?.status, 200);
  assert.equal((await terminal?.json() as { action: { status: string } }).action.status, "reconciliation_required");
  const badAuth = await handleAuthorityRecordExecutorRoute(
    executorRequest("/internal/v1/authority-records/actions", claimPayload, "y".repeat(32)),
    appEnv,
  );
  assert.equal(badAuth?.status, 401);
});
