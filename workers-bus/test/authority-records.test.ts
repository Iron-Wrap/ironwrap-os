import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  AUTHORITY_VERIFICATION_METHODS,
  claimAuthorityRecordAction,
  completeAuthorityRecordAction,
  EXTERNAL_ISSUER_AUTHORITY_KINDS,
  listAuthorityRecordReadbacks,
  parseAuthorityRequirements,
  recordAuthorityReadback,
  resolveAuthorityLifecycle,
  resolveAuthorityRequirement,
  type AuthorityRequirement,
  type AuthorityRecordOperation,
} from "../src/authority-records.ts";
import { handleAuthorityRecordRoute } from "../src/authority-record-api.ts";
import { handleAuthorityRecordExecutorRoute } from "../src/authority-record-executor-api.ts";
import { permissionsForRole, type AppEnv, type AppRole, type AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const OTHER_TENANT = "other-tenant";
const NOW = "2026-08-17T12:00:00.000Z";
const ACTOR = "appu_ops_authority_0001";
const FRAPPE_ACTOR = "ops@authority.example.invalid";
const SAME_TENANT_OTHER_ACTOR = "appu_ops_authority_0002";
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
    this.raw.exec(readFileSync(new URL("../migrations/0117_authority_readback_lifecycle.sql", import.meta.url), "utf8"));
    const insert = this.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ops', ?, 1, 'seed', ?, ?)`,
    );
    insert.run(ACTOR, TENANT, "ops@authority.example.invalid", "Authority Ops", "ops@authority.example.invalid", NOW, NOW);
    insert.run(
      SAME_TENANT_OTHER_ACTOR,
      TENANT,
      "ops-2@authority.example.invalid",
      "Authority Ops 2",
      "ops-2@authority.example.invalid",
      NOW,
      NOW,
    );
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

function authorityMaterialForOperation(
  operation: AuthorityRecordOperation,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const material = authorityMaterial();
  if (operation === "record") {
    Object.assign(material, {
      status: "Unverified",
      verification_method: "",
      verified_at: "",
      verification_reference: "",
      verified_by: "",
      revoked_at: "",
      revocation_reference: "",
      revoked_by: "",
      supersedes: "",
      correction_reason: "",
      exception_status: "None",
      exception_reason: "",
      issuer_readback_json: "",
    });
  } else if (operation === "revoke") {
    Object.assign(material, {
      authority_record_id: `${RECORD}-revoke-01`,
      status: "Revoked",
      verification_method: "",
      verified_at: "",
      verification_reference: "",
      verified_by: "",
      revoked_at: NOW,
      revocation_reference: "revocation:1",
      revoked_by: ACTOR,
      supersedes: RECORD,
      correction_reason: "revoked by issuer",
      exception_status: "None",
      exception_reason: "",
    });
  } else {
    Object.assign(material, {
      authority_record_id: operation === "verify" ? RECORD : `${RECORD}-${operation}-01`,
      status: "Verified",
      supersedes: operation === "verify" ? "" : RECORD,
      correction_reason: operation === "verify" ? "" : `${operation}:correction`,
      exception_status: operation === "resolve_exception" ? "Resolved" : "None",
      exception_reason: "",
    });
  }
  Object.assign(material, overrides);
  material.state_digest_sha256 = sha256(canonicalJson(Object.fromEntries(
    AUTHORITY_DIGEST_FIELDS.map((field) => [field, material[field] ?? ""]),
  )));
  return material;
}

function issuerReceiptForMaterial(
  material: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    receipt_id: `Issuer-Receipt-${String(material.authority_record_id)}`,
    tenant: material.tenant,
    authority_record_id: material.authority_record_id,
    authority_version: Number(material.version),
    issuer_name: material.issuer_name,
    issuer_jurisdiction: material.issuer_jurisdiction,
    issuer_reference: material.issuer_reference,
    issuer_source_version: material.source_version,
    evidence_refs_json: material.evidence_refs_json,
    evidence_sha256: String(material.evidence_sha256).toLowerCase(),
    state_digest_sha256: material.state_digest_sha256,
    verification_state: material.status === "Revoked"
      ? "revoked"
      : material.status === "Verified"
      ? "verified"
      : "unavailable",
    ...overrides,
  };
}

function executorClaimPayload(
  operation: AuthorityRecordOperation,
  command: Record<string, unknown>,
  issuerReceipt: Record<string, unknown> | null,
  actionId: string,
) {
  return {
    action_id: actionId,
    authority_record_id: command.authority_record_id,
    expected_version: Number(command.version),
    idempotency_key: `authority-executor-${actionId}`,
    operation,
    request_fingerprint_sha256: sha256(canonicalJson({ command, issuer_receipt: issuerReceipt })),
    tenant_id: TENANT,
    actor_user_id: ACTOR,
    frappe_actor_user_id: FRAPPE_ACTOR,
    business_role: "IronWrap Production",
    command_json: JSON.stringify(command),
    issuer_receipt_json: issuerReceipt ? JSON.stringify(issuerReceipt) : null,
  };
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
    authorityEffectiveFrom: "2026-08-01",
    authorityExpiresAt: "2026-12-31",
    authorityRevokedAt: null,
    supersedesAuthorityRecordId: null,
    authorityVerificationMethod: "Internal Competency Assessment",
    issuerReceiptSha256: null,
    observedByUserId: ACTOR,
    observedAt: NOW,
    actionId: null,
    ...overrides,
  };
}

function authorityRequirement(
  overrides: Partial<AuthorityRequirement> = {},
): AuthorityRequirement {
  return {
    subject_type: "Person",
    subject_role: "Worker",
    subject_ref: "worker@example.invalid",
    authority_kind: "Worker Competency",
    authority_scope: "field installation",
    scope_type: "Field",
    scope_ref: "field:job-1",
    issuer_name: "Alberta issuer",
    issuer_jurisdiction: "AB-CA",
    issuer_reference: "https://issuer.example.invalid/record/1",
    source_version: "2026-08-17",
    ...overrides,
  };
}

test("authority requirements accept only the bounded sparse canonical shape", () => {
  const parsed = parseAuthorityRequirements(JSON.stringify([authorityRequirement({
    authority_record_id: `  ${RECORD}  `,
    version: 1,
    state_digest_sha256: "E".repeat(64),
  })]));
  assert.deepEqual(parsed, [authorityRequirement({
    authority_record_id: RECORD,
    version: 1,
    state_digest_sha256: "e".repeat(64),
  })]);

  assert.throws(() => parseAuthorityRequirements([]), /authority_requirements_invalid/);
  assert.throws(
    () => parseAuthorityRequirements(Array.from({ length: 21 }, () => authorityRequirement())),
    /authority_requirements_invalid/,
  );
  assert.throws(
    () => parseAuthorityRequirements(`${JSON.stringify([authorityRequirement()])}${" ".repeat(20_001)}`),
    /authority_requirements_invalid/,
  );
  assert.throws(
    () => parseAuthorityRequirements([{ ...authorityRequirement(), unexpected: true }]),
    /authority_requirements_invalid/,
  );
  assert.throws(
    () => parseAuthorityRequirements([{ ...authorityRequirement(), issuer_name: null }]),
    /authority_requirements_invalid/,
  );
  assert.throws(
    () => parseAuthorityRequirements([{ ...authorityRequirement(), authority_scope: "x".repeat(241) }]),
    /authority_requirements_invalid/,
  );
});

test("sparse authority requirements resolve exactly one current verified head", async () => {
  const db = new SqliteD1();
  await recordAuthorityReadback(env(db), readbackInput());
  const verdict = await resolveAuthorityRequirement(env(db), {
    tenantId: TENANT,
    now: NOW,
    requirement: authorityRequirement({
      authority_record_id: RECORD,
      version: 1,
      state_digest_sha256: "e".repeat(64),
    }),
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, null);
  assert.equal(verdict.current?.readback_id, "Authority-Readback-0001");
});

test("sparse authority requirements fail closed for invalid lifecycle heads", async (t) => {
  await t.test("revoked", async () => {
    const db = new SqliteD1();
    await recordAuthorityReadback(env(db), readbackInput({
      verificationState: "revoked",
      authorityRevokedAt: NOW,
    }));
    const verdict = await resolveAuthorityRequirement(env(db), {
      tenantId: TENANT,
      now: NOW,
      requirement: authorityRequirement(),
    });
    assert.equal(verdict.code, "authority_revoked");
  });

  await t.test("expired", async () => {
    const db = new SqliteD1();
    await recordAuthorityReadback(env(db), readbackInput({
      authorityExpiresAt: "2026-08-16",
    }));
    const verdict = await resolveAuthorityRequirement(env(db), {
      tenantId: TENANT,
      now: NOW,
      requirement: authorityRequirement(),
    });
    assert.equal(verdict.code, "authority_expired");
  });

  await t.test("wrong jurisdiction", async () => {
    const db = new SqliteD1();
    await recordAuthorityReadback(env(db), readbackInput());
    const verdict = await resolveAuthorityRequirement(env(db), {
      tenantId: TENANT,
      now: NOW,
      requirement: authorityRequirement({ issuer_jurisdiction: "BC-CA" }),
    });
    assert.equal(verdict.code, "authority_jurisdiction_mismatch");
  });

  await t.test("superseded pinned record", async () => {
    const db = new SqliteD1();
    await recordAuthorityReadback(env(db), readbackInput());
    await recordAuthorityReadback(env(db), readbackInput({
      readbackId: "Authority-Readback-Successor-01",
      authorityRecordId: "Authority-Record-Successor-01",
      supersedesAuthorityRecordId: RECORD,
      evidenceSha256: "d".repeat(64),
      authorityStateDigestSha256: "f".repeat(64),
      observedAt: "2026-08-18T12:00:00.000Z",
    }));
    const verdict = await resolveAuthorityRequirement(env(db), {
      tenantId: TENANT,
      now: "2026-08-18T13:00:00.000Z",
      requirement: authorityRequirement({ authority_record_id: RECORD }),
    });
    assert.equal(verdict.code, "authority_superseded");
  });

  await t.test("ambiguous unlinked heads", async () => {
    const db = new SqliteD1();
    await recordAuthorityReadback(env(db), readbackInput());
    await recordAuthorityReadback(env(db), readbackInput({
      readbackId: "Authority-Readback-Ambiguous-02",
      authorityRecordId: "Authority-Record-Ambiguous-02",
      issuerJurisdiction: "BC-CA",
      evidenceSha256: "d".repeat(64),
      authorityStateDigestSha256: "f".repeat(64),
    }));
    const verdict = await resolveAuthorityRequirement(env(db), {
      tenantId: TENANT,
      now: NOW,
      requirement: authorityRequirement(),
    });
    assert.equal(verdict.code, "authority_ambiguous");
  });
});

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
  const actorSubstitution = await claimAuthorityRecordAction(env(db), claimInput({
    actorUserId: SAME_TENANT_OTHER_ACTOR,
  }));
  assert.equal(actorSubstitution.kind, "conflict");
  const actionIdSubstitution = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Substitute-01",
  }));
  assert.equal(actionIdSubstitution.kind, "conflict");
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
      issuerReadbackId: "Authority-Readback-0001",
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
      issuerReadbackId: "Authority-Readback-Complete-01",
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
  await assert.rejects(
    () => completeAuthorityRecordAction(env(db), {
      tenantId: TENANT,
      actionId: claimed.action.action_id,
      actorUserId: SAME_TENANT_OTHER_ACTOR,
      terminal: {
        kind: "reconciliation_required",
        actionId: claimed.action.action_id,
        authorityRecordId: RECORD,
        reason: "cross_actor_replay",
        reconciliationReceiptSha256: "b".repeat(64),
      },
      now: "2026-08-17T12:02:00.000Z",
    }),
    /authority_record_business_actor_required/,
  );
  assert.throws(
    () => db.raw.prepare("DELETE FROM authority_record_actions WHERE action_id = ?").run(claimed.action.action_id),
    /authority_record_actions_retained/,
  );
});

test("authority action completion binds the exact business actor from the claim", async () => {
  const db = new SqliteD1();
  const claimed = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Actor-Binding-01",
    idempotencyKey: "authority-verify-actor-binding-01",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Actor-Binding-01",
    actionId: claimed.action.action_id,
  }));
  await assert.rejects(
    () => completeAuthorityRecordAction(env(db), {
      tenantId: TENANT,
      actionId: claimed.action.action_id,
      actorUserId: SAME_TENANT_OTHER_ACTOR,
      terminal: {
        kind: "material_applied",
        actionId: claimed.action.action_id,
        authorityRecordId: RECORD,
        authorityVersion: 1,
        authorityStateDigestSha256: "e".repeat(64),
        materialReadbackSha256: "f".repeat(64),
        issuerReadbackId: "Authority-Readback-Actor-Binding-01",
      },
      now: NOW,
    }),
    /authority_record_business_actor_required/,
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
        issuerReadbackId: "Authority-Readback-Missing-01",
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
  assert.match(terminalPayload.action.result_json, /issuer_readback_id/);
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

test("authority lifecycle mirrors the canonical verification method contract", async () => {
  assert.deepEqual(
    [...AUTHORITY_VERIFICATION_METHODS].sort(),
    [
      "Internal Competency Assessment",
      "Issuer Portal Readback",
      "Manufacturer Portal Readback",
      "Regulator Readback",
      "Signed Issuer Record",
    ],
  );
  const db = new SqliteD1();
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Canonical-Internal-01",
    authorityVerificationMethod: "Internal Competency Assessment",
    verificationState: "verified",
  }));
  const internal = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Canonical-Internal-01",
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
    issuerReference: "https://issuer.example.invalid/record/1",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(internal.ok, true);

  const externalMethods = [
    "Issuer Portal Readback",
    "Signed Issuer Record",
    "Regulator Readback",
    "Manufacturer Portal Readback",
  ] as const;
  for (const [index, method] of externalMethods.entries()) {
    const readbackId = `Authority-Readback-Canonical-External-${index + 1}`;
    await recordAuthorityReadback(env(db), readbackInput({
      readbackId,
      authorityRecordId: `Authority-Record-Canonical-External-${index + 1}`,
      authorityKind: method === "Manufacturer Portal Readback"
        ? "Manufacturer Certification"
        : "Permit",
      issuerReference: `issuer:canonical:${index + 1}`,
      issuerSourceVersion: "2026-08-17",
      authorityVerificationMethod: method,
      issuerReceiptSha256: `${index + 1}`.repeat(64).slice(0, 64),
      evidenceSha256: `${index + 2}`.repeat(64).slice(0, 64),
      authorityStateDigestSha256: `${index + 3}`.repeat(64).slice(0, 64),
    }));
    const verdict = await resolveAuthorityLifecycle(env(db), {
      tenantId: TENANT,
      now: NOW,
      readbackId,
      subjectType: "Person",
      subjectRole: "Worker",
      personUser: "worker@example.invalid",
      organization: null,
      authorityKind: method === "Manufacturer Portal Readback"
        ? "Manufacturer Certification"
        : "Permit",
      authorityScope: "field installation",
      scopeType: "Field",
      scopeRef: "field:job-1",
      roofJob: "job-1",
      scopeJson: "{}",
      issuerReference: `issuer:canonical:${index + 1}`,
      issuerSourceVersion: "2026-08-17",
      issuerJurisdiction: "AB-CA",
    });
    assert.equal(verdict.ok, true, method);
  }
});

test("authority lifecycle treats null mandatory issuer bindings as missing authority", async () => {
  const db = new SqliteD1();
  const expectation = {
    tenantId: TENANT,
    now: NOW,
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
    issuerReference: "https://issuer.example.invalid/record/1",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  };
  for (const field of ["issuerReference", "issuerSourceVersion", "issuerJurisdiction"] as const) {
    const verdict = await resolveAuthorityLifecycle(env(db), { ...expectation, [field]: null });
    assert.equal(verdict.ok, false, field);
    assert.equal(verdict.code, "authority_missing", field);
  }
});

test("executor terminalizes all authority operations with the exact persisted readback", async () => {
  const cases = [
    { operation: "record", material: authorityMaterialForOperation("record") },
    { operation: "verify", material: authorityMaterialForOperation("verify") },
    { operation: "renew", material: authorityMaterialForOperation("renew") },
    { operation: "supersede", material: authorityMaterialForOperation("supersede") },
    {
      operation: "revoke",
      material: authorityMaterialForOperation("revoke", {
        authority_kind: "Permit",
        issuer_reference: "issuer:revoke:1",
        source_version: "2026-08-17",
      }),
    },
    { operation: "resolve_exception", material: authorityMaterialForOperation("resolve_exception") },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const db = new SqliteD1();
    const appEnv = env(db);
    const actionId = `Authority-Action-Executor-Op-${index + 1}`;
    const needsReceipt = EXTERNAL_ISSUER_AUTHORITY_KINDS.has(String(testCase.material.authority_kind)) &&
      testCase.material.status !== "Unverified";
    const issuerReceipt = needsReceipt ? issuerReceiptForMaterial(testCase.material) : null;
    if (issuerReceipt) testCase.material.issuer_readback_json = JSON.stringify(issuerReceipt);
    const claimPayload = executorClaimPayload(testCase.operation, { ...testCase.material }, issuerReceipt, actionId);
    const claimed = await handleAuthorityRecordExecutorRoute(
      executorRequest("/internal/v1/authority-records/actions", claimPayload),
      appEnv,
    );
    assert.equal(claimed?.status, 201, testCase.operation);
    const terminal = await handleAuthorityRecordExecutorRoute(
      executorRequest(`/internal/v1/authority-records/actions/${actionId}/terminal`, {
        action_id: actionId,
        command_json: JSON.stringify(testCase.material),
        issuer_receipt_json: issuerReceipt ? JSON.stringify(issuerReceipt) : null,
        material_readback_json: JSON.stringify(testCase.material),
        reconciliation_reason: null,
      }),
      appEnv,
    );
    assert.equal(terminal?.status, 200, testCase.operation);
    const payload = await terminal?.json() as { action: { status: string; result_json: string } };
    assert.equal(payload.action.status, "applied", testCase.operation);
    assert.match(payload.action.result_json, /issuer_readback_id/, testCase.operation);
  }
});

test("material completion enforces exact action binding and per-operation expected state", async () => {
  const db = new SqliteD1();

  const recordAction = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Record-01",
    operation: "record",
    idempotencyKey: "authority-record-01",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Record-Wrong-State-01",
    actionId: recordAction.action.action_id,
    verificationState: "verified",
  }));
  await assert.rejects(
    () => completeAuthorityRecordAction(env(db), {
      tenantId: TENANT,
      actionId: recordAction.action.action_id,
      actorUserId: ACTOR,
      terminal: {
        kind: "material_applied",
        actionId: recordAction.action.action_id,
        authorityRecordId: RECORD,
        authorityVersion: 1,
        authorityStateDigestSha256: "e".repeat(64),
        materialReadbackSha256: "f".repeat(64),
        issuerReadbackId: "Authority-Readback-Record-Wrong-State-01",
      },
      now: NOW,
    }),
    /authority_record_issuer_readback_required/,
  );

  const verifyAction = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Verify-Other-01",
    operation: "verify",
    idempotencyKey: "authority-verify-other-01",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Verify-Other-01",
    actionId: "Authority-Action-Other-Binding-01",
  }));
  await assert.rejects(
    () => completeAuthorityRecordAction(env(db), {
      tenantId: TENANT,
      actionId: verifyAction.action.action_id,
      actorUserId: ACTOR,
      terminal: {
        kind: "material_applied",
        actionId: verifyAction.action.action_id,
        authorityRecordId: RECORD,
        authorityVersion: 1,
        authorityStateDigestSha256: "e".repeat(64),
        materialReadbackSha256: "f".repeat(64),
        issuerReadbackId: "Authority-Readback-Verify-Other-01",
      },
      now: NOW,
    }),
    /authority_record_issuer_readback_required/,
  );

  for (const operation of ["renew", "supersede", "resolve_exception"] as const) {
    const claimed = await claimAuthorityRecordAction(env(db), claimInput({
      actionId: `Authority-Action-${operation}-01`,
      operation,
      idempotencyKey: `authority-${operation}-01`,
    }));
    await recordAuthorityReadback(env(db), readbackInput({
      readbackId: `Authority-Readback-${operation}-Wrong-State-01`,
      actionId: claimed.action.action_id,
      verificationState: "revoked",
      authorityRevokedAt: NOW,
      authorityVerificationMethod: null,
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
          issuerReadbackId: `Authority-Readback-${operation}-Wrong-State-01`,
        },
        now: NOW,
      }),
      /authority_record_issuer_readback_required/,
      operation,
    );
  }

  const revokeAction = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Revoke-01",
    operation: "revoke",
    idempotencyKey: "authority-revoke-01",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Revoke-No-Receipt-01",
    actionId: revokeAction.action.action_id,
    authorityKind: "Permit",
    verificationState: "revoked",
    authorityRevokedAt: NOW,
    authorityVerificationMethod: null,
    issuerReceiptSha256: null,
  }));
  await assert.rejects(
    () => completeAuthorityRecordAction(env(db), {
      tenantId: TENANT,
      actionId: revokeAction.action.action_id,
      actorUserId: ACTOR,
      terminal: {
        kind: "material_applied",
        actionId: revokeAction.action.action_id,
        authorityRecordId: RECORD,
        authorityVersion: 1,
        authorityStateDigestSha256: "e".repeat(64),
        materialReadbackSha256: "f".repeat(64),
        issuerReadbackId: "Authority-Readback-Revoke-No-Receipt-01",
      },
      now: NOW,
    }),
    /authority_record_issuer_readback_required/,
  );
});

test("authority lifecycle fails closed for expired, ambiguous, and unverifiable external heads", async () => {
  const db = new SqliteD1();

  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Expired-01",
    authorityRecordId: "Authority-Record-Expired-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:expired",
    issuerSourceVersion: "2026-08-17",
    authorityExpiresAt: "2026-08-16",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "a".repeat(64),
    evidenceSha256: "1".repeat(64),
    authorityStateDigestSha256: "2".repeat(64),
  }));
  const expired = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Expired-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:expired",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, "authority_expired");

  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Ambiguous-01",
    authorityRecordId: "Authority-Record-Ambiguous-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:ambiguous",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "3".repeat(64),
    evidenceSha256: "4".repeat(64),
    authorityStateDigestSha256: "5".repeat(64),
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Ambiguous-02",
    authorityRecordId: "Authority-Record-Ambiguous-02",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:ambiguous",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "6".repeat(64),
    evidenceSha256: "7".repeat(64),
    authorityStateDigestSha256: "8".repeat(64),
  }));
  const ambiguous = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:ambiguous",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "authority_ambiguous");

  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Unverifiable-01",
    authorityRecordId: "Authority-Record-Unverifiable-01",
    authorityKind: "Trade Licence",
    issuerReference: "issuer:trade:1",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: "Internal Competency Assessment",
    evidenceSha256: "9".repeat(64),
    authorityStateDigestSha256: "a".repeat(64),
  }));
  const unverifiable = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Unverifiable-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Trade Licence",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:trade:1",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(unverifiable.ok, false);
  assert.equal(unverifiable.code, "authority_unverifiable");
});

test("verify completion refuses an expired issuer-backed readback", async () => {
  const db = new SqliteD1();
  const claimed = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Expired-Verify-01",
    idempotencyKey: "authority-expired-verify-01",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Expired-Verify-01",
    actionId: claimed.action.action_id,
    authorityKind: "Permit",
    issuerReference: "issuer:permit:verify-expired",
    issuerSourceVersion: "2026-08-17",
    authorityExpiresAt: "2026-08-16",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "b".repeat(64),
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
        issuerReadbackId: "Authority-Readback-Expired-Verify-01",
      },
      now: NOW,
    }),
    /authority_record_issuer_readback_required/,
  );
});

test("verify completion fails closed when the referenced persisted readback does not exist", async () => {
  const db = new SqliteD1();
  const claimed = await claimAuthorityRecordAction(env(db), claimInput({
    actionId: "Authority-Action-Explicit-Verify-01",
    idempotencyKey: "authority-explicit-verify-01",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Explicit-Verify-01",
    actionId: claimed.action.action_id,
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
        issuerReadbackId: "Authority-Readback-Unknown-01",
      },
      now: NOW,
    }),
    /authority_record_issuer_readback_required/,
  );
});

test("authority lifecycle follows explicit supersession even when issuer metadata changes", async () => {
  const db = new SqliteD1();
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Lineage-Root-01",
    authorityRecordId: "Authority-Record-Lineage-Root-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:lineage-root",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "c".repeat(64),
    evidenceSha256: "d".repeat(64),
    authorityStateDigestSha256: "e".repeat(64),
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Lineage-Head-01",
    authorityRecordId: "Authority-Record-Lineage-Head-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:lineage-head",
    issuerSourceVersion: "2026-08-18",
    supersedesAuthorityRecordId: "Authority-Record-Lineage-Root-01",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "f".repeat(64),
    evidenceSha256: "1".repeat(64),
    authorityStateDigestSha256: "2".repeat(64),
  }));
  const verdict = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Lineage-Root-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:lineage-root",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "authority_scope_mismatch");
  assert.equal(verdict.current?.readback_id, "Authority-Readback-Lineage-Head-01");
});

test("authority lifecycle fails closed when the current head changes jurisdiction or branches", async () => {
  const db = new SqliteD1();
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Jurisdiction-Root-01",
    authorityRecordId: "Authority-Record-Jurisdiction-Root-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:jurisdiction-root",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "3".repeat(64),
    evidenceSha256: "4".repeat(64),
    authorityStateDigestSha256: "5".repeat(64),
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Jurisdiction-Head-01",
    authorityRecordId: "Authority-Record-Jurisdiction-Head-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:jurisdiction-next",
    issuerSourceVersion: "2026-08-18",
    issuerJurisdiction: "BC-CA",
    supersedesAuthorityRecordId: "Authority-Record-Jurisdiction-Root-01",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "6".repeat(64),
    evidenceSha256: "7".repeat(64),
    authorityStateDigestSha256: "8".repeat(64),
  }));
  const jurisdiction = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Jurisdiction-Root-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:jurisdiction-root",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(jurisdiction.ok, false);
  assert.equal(jurisdiction.code, "authority_jurisdiction_mismatch");

  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Branch-Root-01",
    authorityRecordId: "Authority-Record-Branch-Root-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:branch-root",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "9".repeat(64),
    evidenceSha256: "a".repeat(64),
    authorityStateDigestSha256: "b".repeat(64),
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Branch-Head-01",
    authorityRecordId: "Authority-Record-Branch-Head-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:branch-head-1",
    issuerSourceVersion: "2026-08-18",
    supersedesAuthorityRecordId: "Authority-Record-Branch-Root-01",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "c".repeat(64),
    evidenceSha256: "d".repeat(64),
    authorityStateDigestSha256: "e".repeat(64),
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Branch-Head-02",
    authorityRecordId: "Authority-Record-Branch-Head-02",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:branch-head-2",
    issuerSourceVersion: "2026-08-18",
    supersedesAuthorityRecordId: "Authority-Record-Branch-Root-01",
    authorityVerificationMethod: "Issuer Portal Readback",
    issuerReceiptSha256: "f".repeat(64),
    evidenceSha256: "1".repeat(64),
    authorityStateDigestSha256: "2".repeat(64),
  }));
  const branching = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Branch-Root-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:branch-root",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(branching.ok, false);
  assert.equal(branching.code, "authority_ambiguous");
});

test("authority lifecycle fails closed on contradictory same-version peers for one authority record", async () => {
  const db = new SqliteD1();
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Contradictory-01",
    authorityRecordId: "Authority-Record-Contradictory-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:contradictory",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: null,
    verificationState: "revoked",
    authorityRevokedAt: NOW,
    issuerReceiptSha256: "1".repeat(64),
    evidenceSha256: "2".repeat(64),
    authorityStateDigestSha256: "3".repeat(64),
    observedAt: "2026-08-17T12:00:00.000Z",
  }));
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Contradictory-02",
    authorityRecordId: "Authority-Record-Contradictory-01",
    authorityKind: "Permit",
    issuerReference: "issuer:permit:contradictory",
    issuerSourceVersion: "2026-08-17",
    authorityVerificationMethod: "Issuer Portal Readback",
    verificationState: "verified",
    authorityRevokedAt: null,
    issuerReceiptSha256: "4".repeat(64),
    evidenceSha256: "5".repeat(64),
    authorityStateDigestSha256: "6".repeat(64),
    observedAt: "2026-08-17T12:00:01.000Z",
  }));
  const verdict = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Contradictory-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:contradictory",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "authority_contradictory");
});

test("authority lifecycle fails closed when an oversized binding root set exceeds the bounded lineage component", async () => {
  const db = new SqliteD1();
  for (let index = 1; index <= 33; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await recordAuthorityReadback(env(db), readbackInput({
      readbackId: `Authority-Readback-Binding-Limit-${suffix}`,
      authorityRecordId: `Authority-Record-Binding-Limit-${suffix}`,
      authorityKind: "Permit",
      issuerReference: "issuer:permit:binding-limit",
      issuerSourceVersion: "2026-08-17",
      supersedesAuthorityRecordId: null,
      authorityVerificationMethod: "Issuer Portal Readback",
      issuerReceiptSha256: `${((index + 1) % 10).toString()}`.repeat(64),
      evidenceSha256: `${(index % 10).toString()}`.repeat(64),
      authorityStateDigestSha256: `${(index % 10).toString()}`.repeat(64),
      observedAt: `2026-08-17T12:${String((index - 1) % 60).padStart(2, "0")}:00.000Z`,
    }));
  }
  const verdict = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Binding-Limit-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:binding-limit",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "authority_ambiguous");
});

test("authority lifecycle fails closed when an oversized same-record peer set exceeds the bounded lineage component", async () => {
  const db = new SqliteD1();
  for (let index = 1; index <= 33; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await recordAuthorityReadback(env(db), readbackInput({
      readbackId: `Authority-Readback-Peer-Limit-${suffix}`,
      authorityRecordId: "Authority-Record-Peer-Limit-01",
      authorityVersion: index,
      authorityKind: "Permit",
      issuerReference: `issuer:permit:peer-limit-${suffix}`,
      issuerSourceVersion: `2026-08-${String(Math.min(index, 28)).padStart(2, "0")}`,
      authorityVerificationMethod: "Issuer Portal Readback",
      issuerReceiptSha256: `${(index % 10).toString()}`.repeat(64),
      evidenceSha256: `${((index + 2) % 10).toString()}`.repeat(64),
      authorityStateDigestSha256: `${((index + 3) % 10).toString()}`.repeat(64),
      observedAt: `2026-08-17T13:${String((index - 1) % 60).padStart(2, "0")}:00.000Z`,
    }));
  }
  const verdict = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Peer-Limit-01",
    subjectType: "Person",
    subjectRole: "Worker",
    personUser: "worker@example.invalid",
    organization: null,
    authorityKind: "Permit",
    authorityScope: "field installation",
    scopeType: "Field",
    scopeRef: "field:job-1",
    roofJob: "job-1",
    scopeJson: "{}",
    issuerReference: "issuer:permit:peer-limit-01",
    issuerSourceVersion: "2026-08-01",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "authority_ambiguous");
});

test("authority lifecycle fails closed when freshness windows are missing", async () => {
  const db = new SqliteD1();
  await recordAuthorityReadback(env(db), readbackInput({
    readbackId: "Authority-Readback-Missing-Freshness-01",
    authorityEffectiveFrom: null,
    authorityExpiresAt: null,
  }));
  const verdict = await resolveAuthorityLifecycle(env(db), {
    tenantId: TENANT,
    now: NOW,
    readbackId: "Authority-Readback-Missing-Freshness-01",
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
    issuerReference: "https://issuer.example.invalid/record/1",
    issuerSourceVersion: "2026-08-17",
    issuerJurisdiction: "AB-CA",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "authority_stale");
});
