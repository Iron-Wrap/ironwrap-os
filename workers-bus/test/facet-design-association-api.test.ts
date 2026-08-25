import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AppRole,
  type AuthContext,
} from "../src/app-types.ts";

const TENANT = "ironwrap";
const USER = "appu_owner_0001";
const PRODUCER_LINK = `ironwrap-identity-v1:${"1".repeat(64)}`;
const PROJECT_LINK = `ironwrap-project-v1:${"2".repeat(64)}`;
const CUSTOMER_LINK = `facet-customer-oidc-v1:${"3".repeat(64)}`;
const PROJECT = "facet-project-api-0001";
const ROOF_JOB = "roof-job-api-0001";
const QUOTE = "customer-quote-api-0001";
const ASSOCIATION = "4".repeat(64);

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0043_facet_v2_signed_identity.sql",
      "0105_facet_native_design_projection.sql",
      "0121_facet_prequote_estimator_consumer.sql",
    ])
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    this.raw.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES (?, ?, 'owner@example.invalid', 'Owner', 'owner', 'owner@example.invalid',
               1, 'seed', ?, ?)`,
    ).run(USER, TENANT, "2026-08-16T09:00:00.000Z", "2026-08-16T09:00:00.000Z");
    this.raw.prepare(
      `INSERT INTO facet_v2_producer_identity_links
       (producer_identity_link_id, destination_tenant_id, source_tenant_id, issuer,
        source_product, source_environment, proof_sha256, created_from_project_id, created_at)
       VALUES (?, ?, 'facet-tenant', 'https://facet.example.invalid', 'facet', 'production',
               ?, ?, ?)`,
    ).run(PRODUCER_LINK, TENANT, "5".repeat(64), PROJECT, "2026-08-16T09:01:00.000Z");
    this.raw.prepare(
      `INSERT INTO facet_v2_project_links
       (external_project_link_id, producer_identity_link_id, destination_tenant_id,
        source_tenant_id, brand_id, facet_project_id, customer_party_ref,
        external_customer_identity_link_id, roof_job_id, customer_quote_id,
        project_claim_sha256, association_sha256, created_by_user_id, created_at)
       VALUES (?, ?, ?, 'facet-tenant', 'ironwrap-exteriors', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      PROJECT_LINK,
      PRODUCER_LINK,
      TENANT,
      PROJECT,
      "6".repeat(64),
      CUSTOMER_LINK,
      ROOF_JOB,
      QUOTE,
      "7".repeat(64),
      ASSOCIATION,
      USER,
      "2026-08-16T09:02:00.000Z",
    );
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

function seedDecision(
  db: SqliteD1,
  input: {
    eventId: string;
    decisionKind: "approved" | "corrected" | "superseded" | "withdrawn";
    previousEventId?: string;
    ordinal: number;
  },
): void {
  const digest = input.ordinal.toString(16).padStart(64, "0");
  db.raw.prepare(
    `INSERT INTO facet_v2_customer_decisions
     (event_id, event_type, schema_version, event_body_sha256, issuer, source_product,
      source_environment, source_tenant_id, destination_tenant_id, brand_id,
      facet_project_id, external_project_link_id, producer_identity_link_id,
      association_sha256, roof_job_id, customer_quote_id, customer_party_ref,
      external_customer_identity_link_id, oidc_issuer, oidc_subject_sha256,
      identity_assurance, attestation_version, decision_kind, previous_event_id,
      reason_sha256, approval_receipt_id, approval_receipt_sha256, design_revision_id,
      design_revision_sha256, frozen_evidence_sha256, raw_key, raw_sha256,
      raw_content_length, occurred_at, received_at)
     VALUES (?, 'facet.design.customer_approved.v2', 2, ?, 'https://facet.example.invalid',
             'facet', 'production', 'facet-tenant', ?, 'ironwrap-exteriors', ?, ?, ?, ?,
             ?, ?, ?, ?, 'https://accounts.google.com', ?, 'oidc',
             'facet-customer-approval-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 512, ?, ?)`,
  ).run(
    input.eventId,
    digest,
    TENANT,
    PROJECT,
    PROJECT_LINK,
    PRODUCER_LINK,
    ASSOCIATION,
    ROOF_JOB,
    QUOTE,
    "6".repeat(64),
    CUSTOMER_LINK,
    "8".repeat(64),
    input.decisionKind,
    input.previousEventId ?? null,
    input.previousEventId ? "9".repeat(64) : null,
    `facet-approval-receipt-${input.ordinal}`,
    input.ordinal.toString(16).padStart(64, "a"),
    `facet-json-v1:${digest}`,
    digest,
    input.ordinal.toString(16).padStart(64, "b"),
    `facet-design/v2/raw/${input.eventId}.json`,
    digest,
    `2026-08-16T09:0${input.ordinal}:00.000Z`,
    `2026-08-16T09:0${input.ordinal}:01.000Z`,
  );
}

function seedProjection(db: SqliteD1, eventId: string): void {
  db.raw.prepare(
    `INSERT INTO facet_v2_projection_attempts
     (attempt_id, event_id, outcome, evidence_id, reconciliation_id,
      draft_customer_quote_id, draft_quote_version, error_code, attempted_at)
     VALUES ('facet-attempt-1', ?, 'projected_blank_draft', 'facet-evidence-1',
             'facet-reconciliation-1', 'facet-draft-quote-1', 4, NULL, ?)`,
  ).run(eventId, "2026-08-16T09:05:00.000Z");
}

function seedIntakeException(
  db: SqliteD1,
  input: {
    eventId: string;
    ordinal: number;
    result: "accepted_unassociated" | "rejected";
    detailCode: string;
    resolved?: boolean;
  },
): void {
  const intakeId = `facet-v2-intake:test-${input.ordinal}`;
  const bodySha256 = input.ordinal.toString(16).padStart(64, "c");
  const receivedAt = `2026-08-16T09:${String(10 + input.ordinal).padStart(2, "0")}:00.000Z`;
  db.raw.prepare(
    `INSERT INTO facet_v2_raw_intakes
     (intake_id, event_id, event_body_sha256, raw_key, raw_sha256,
      raw_content_length, issuer, source_product, source_environment,
      source_tenant_id, destination_tenant_id, delivery_key_id,
      delivery_key_version, issued_at_ms, expires_at_ms, nonce_sha256,
      result, detail_code, received_at)
     VALUES (?, ?, ?, ?, ?, 512, 'https://facet.example.invalid', 'facet',
             'production', 'facet-tenant', ?, 'facet-v2-test-key', 3,
             1800000000000, 1800000120000, ?, ?, ?, ?)`,
  ).run(
    intakeId,
    input.eventId,
    bodySha256,
    `facet-design/v2/raw/${bodySha256}.json`,
    bodySha256,
    TENANT,
    (input.ordinal + 20).toString(16).padStart(64, "d"),
    input.result,
    input.detailCode,
    receivedAt,
  );
  db.raw.prepare(
    `INSERT INTO facet_v2_consumer_receipts
     (receipt_id, intake_id, event_id, event_body_sha256, result, detail_code,
      receipt_json, receipt_sha256, signature_algorithm, signature_key_id,
      signature_key_version, signature_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 'HMAC-SHA256', 'facet-v2-test-key', 3,
             'synthetic-signature', ?)`,
  ).run(
    `facet-v2-receipt:test-${input.ordinal}`,
    intakeId,
    input.eventId,
    bodySha256,
    input.result,
    input.detailCode,
    (input.ordinal + 40).toString(16).padStart(64, "e"),
    receivedAt,
  );
  if (input.resolved) {
    db.raw.prepare(
      `INSERT INTO facet_v2_consumer_receipts
       (receipt_id, intake_id, event_id, event_body_sha256, result, detail_code,
        receipt_json, receipt_sha256, signature_algorithm, signature_key_id,
        signature_key_version, signature_value, created_at)
       VALUES (?, ?, ?, ?, 'reconciled', 'exact_association_reconciled_from_raw_intake',
               '{}', ?, 'HMAC-SHA256', 'facet-v2-test-key', 3,
               'synthetic-signature', ?)`,
    ).run(
      `facet-v2-receipt:reconciled-${input.ordinal}`,
      intakeId,
      input.eventId,
      bodySha256,
      (input.ordinal + 60).toString(16).padStart(64, "f"),
      "2026-08-16T09:30:00.000Z",
    );
  }
}

function appEnv(db: SqliteD1): AppEnv {
  return {
    DB: db as never,
    APP_FACET_QUOTE_REVISION_PREPARE_ENABLED: "true",
    APP_IRONWRAP_LEGACY_V1_DESIGN_EVENTS_ENABLED: "true",
  } as AppEnv;
}

function auth(withRead = true): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole("owner").filter(
      (permission) => withRead || permission !== "facet:read",
    ),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-16T09:00:00.000Z",
      session_expires_at: "2026-08-16T11:00:00.000Z",
      revoked_at: null,
      user_id: USER,
      tenant_id: TENANT,
      email_normalized: "owner@example.invalid",
      display_name: "Owner",
      role: "owner",
      frappe_user_id: "owner@example.invalid",
      active: 1,
      created_by: "seed",
      created_at: "2026-08-16T09:00:00.000Z",
      updated_at: "2026-08-16T09:00:00.000Z",
    },
  };
}

function authFor(role: AppRole, tenantId = TENANT): AuthContext {
  const owner = auth();
  return {
    ...owner,
    permissions: permissionsForRole(role),
    session: { ...owner.session, role, tenant_id: tenantId },
  };
}

function request(path: string, method = "GET"): Request {
  return new Request(`https://app.example.invalid${path}`, {
    method,
    headers: method === "POST"
      ? { "content-type": "application/json", "x-csrf-token": "csrf" }
      : undefined,
    body: method === "POST" ? JSON.stringify({ legacy: true }) : undefined,
  });
}

function revocationRequest(
  body: unknown,
  options: { contentType?: string; csrf?: string } = {},
): Request {
  return new Request("https://app.example.invalid/api/v1/facet-link-revocations", {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      "x-csrf-token": options.csrf ?? "csrf",
    },
    body: JSON.stringify(body),
  });
}

test("office read quarantines legacy projection history behind the signed-v2 chain head", async () => {
  const db = new SqliteD1();
  seedDecision(db, { eventId: "facet-approved-1", decisionKind: "approved", ordinal: 3 });
  seedDecision(db, {
    eventId: "facet-corrected-2",
    decisionKind: "corrected",
    previousEventId: "facet-approved-1",
    ordinal: 4,
  });
  seedProjection(db, "facet-corrected-2");
  seedIntakeException(db, {
    eventId: "facet-unassociated-3",
    ordinal: 3,
    result: "accepted_unassociated",
    detailCode: "awaiting_exact_project_identity_association",
  });
  seedIntakeException(db, {
    eventId: "facet-rejected-4",
    ordinal: 4,
    result: "rejected",
    detailCode: "decision_customer_identity_mismatch",
  });
  seedIntakeException(db, {
    eventId: "facet-reconciled-5",
    ordinal: 5,
    result: "accepted_unassociated",
    detailCode: "awaiting_exact_project_identity_association",
    resolved: true,
  });

  const response = await handleAuthenticatedRoute(
    request("/api/v1/facet-design-evidence"),
    appEnv(db),
    auth(),
  );

  assert.equal(response.status, 200);
  const body = await response.json() as {
    version: number;
    allowed_actions: string[];
    evidence: Array<Record<string, unknown>>;
    intake_exceptions: Array<Record<string, unknown>>;
  };
  assert.equal(body.version, 2);
  assert.deepEqual(body.allowed_actions, ["facet_design.read"]);
  assert.equal(body.evidence.length, 1);
  assert.equal(body.evidence[0]?.event_id, "facet-corrected-2");
  assert.equal(body.evidence[0]?.identity_assurance, "oidc");
  assert.equal(body.evidence[0]?.projection_state, "awaiting_projection");
  assert.equal(body.evidence[0]?.status_code, "awaiting_native_design_projection");
  assert.equal(body.evidence[0]?.projection, null);
  assert.deepEqual(body.intake_exceptions, [
    {
      event_id: "facet-rejected-4",
      received_at: "2026-08-16T09:14:00.000Z",
      state: "rejected",
      status_code: "decision_customer_identity_mismatch",
      recovery: "governed_reissue_required",
    },
    {
      event_id: "facet-unassociated-3",
      received_at: "2026-08-16T09:13:00.000Z",
      state: "awaiting_association",
      status_code: "awaiting_exact_project_identity_association",
      recovery: "automatic_reconciliation",
    },
  ]);
  const serialized = JSON.stringify(body);
  for (const forbidden of [
    "customer_party_ref",
    "external_customer_identity_link_id",
    "oidc_subject_sha256",
    "raw_key",
    "raw_sha256",
    "nonce_sha256",
    "bearer_capability_only",
    "facet-draft-quote-1",
    "facet-evidence-1",
  ]) assert.equal(serialized.includes(forbidden), false, `must not expose ${forbidden}`);
});

test("read model fails closed on revoked authority and denies callers without Facet read", async () => {
  const db = new SqliteD1();
  seedDecision(db, { eventId: "facet-approved-1", decisionKind: "approved", ordinal: 3 });
  const revoked = await handleAuthenticatedRoute(
    revocationRequest({
      link_kind: "project",
      link_id: PROJECT_LINK,
      reason_code: "project_rebound",
    }),
    appEnv(db),
    auth(),
  );
  assert.equal(revoked.status, 201);

  const response = await handleAuthenticatedRoute(
    request("/api/v1/facet-design-evidence"),
    appEnv(db),
    auth(),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { evidence: Array<Record<string, unknown>> };
  assert.equal(body.evidence[0]?.projection_state, "attention_required");
  assert.equal(body.evidence[0]?.status_code, "facet_v2_authority_drift");

  const denied = await handleAuthenticatedRoute(
    request("/api/v1/facet-design-evidence"),
    appEnv(db),
    auth(false),
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "facet_read_required" });
});

test("governed Facet link revocation is owner-only, tenant-bound, strict, replayable, and append-only", async () => {
  const db = new SqliteD1();
  const env = appEnv(db);
  const projectBody = {
    link_kind: "project",
    link_id: PROJECT_LINK,
    reason_code: "project_rebound",
  } as const;

  const wrongRole = await handleAuthenticatedRoute(
    revocationRequest(projectBody),
    env,
    authFor("ops"),
  );
  assert.equal(wrongRole.status, 403);
  assert.deepEqual(await wrongRole.json(), { error: "facet_link_revocation_owner_required" });

  const wrongTenant = await handleAuthenticatedRoute(
    revocationRequest(projectBody),
    env,
    authFor("owner", "other-tenant"),
  );
  assert.equal(wrongTenant.status, 404);
  assert.deepEqual(await wrongTenant.json(), { error: "facet_link_not_found" });

  const missingContentType = await handleAuthenticatedRoute(
    revocationRequest(projectBody, { contentType: "text/plain" }),
    env,
    auth(),
  );
  assert.equal(missingContentType.status, 415);
  assert.deepEqual(await missingContentType.json(), { error: "content_type_required" });

  for (const contentType of ["application/jsonx", "application/json-seq"]) {
    const invalidMediaType = await handleAuthenticatedRoute(
      revocationRequest(projectBody, { contentType }),
      env,
      auth(),
    );
    assert.equal(invalidMediaType.status, 415, contentType);
    assert.deepEqual(await invalidMediaType.json(), { error: "content_type_required" });
    assert.equal(
      Number((db.raw.prepare("SELECT COUNT(*) AS count FROM facet_v2_link_revocations").get() as { count: number }).count),
      0,
      contentType,
    );
  }

  const wrongCsrf = await handleAuthenticatedRoute(
    revocationRequest(projectBody, { csrf: "wrong-csrf" }),
    env,
    auth(),
  );
  assert.equal(wrongCsrf.status, 403);
  assert.deepEqual(await wrongCsrf.json(), { error: "csrf_failed" });

  const malformed = await handleAuthenticatedRoute(
    revocationRequest({ ...projectBody, unexpected: true }),
    env,
    auth(),
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_facet_link_revocation" });

  const badKind = await handleAuthenticatedRoute(
    revocationRequest({ ...projectBody, link_kind: "association" }),
    env,
    auth(),
  );
  assert.equal(badKind.status, 400);
  const badReason = await handleAuthenticatedRoute(
    revocationRequest({ ...projectBody, reason_code: "arbitrary_reason" }),
    env,
    auth(),
  );
  assert.equal(badReason.status, 400);

  const created = await handleAuthenticatedRoute(
    revocationRequest(projectBody, { contentType: "application/json; charset=utf-8" }),
    env,
    auth(),
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json() as {
    revocation: Record<string, string>;
  };
  assert.equal(createdBody.revocation.link_id, PROJECT_LINK);
  assert.equal(createdBody.revocation.destination_tenant_id, TENANT);
  assert.equal(createdBody.revocation.revoked_by_user_id, USER);
  assert.match(createdBody.revocation.revocation_id, /^facet-link-revocation-v1:[0-9a-f]{64}$/);
  assert.equal(
    Number((db.raw.prepare("SELECT COUNT(*) AS count FROM facet_v2_link_revocations").get() as { count: number }).count),
    1,
  );

  const replay = await handleAuthenticatedRoute(
    revocationRequest(projectBody),
    env,
    auth(),
  );
  assert.equal(replay.status, 200);
  const replayBody = await replay.json() as { revocation: Record<string, string>; replayed: boolean };
  assert.equal(replayBody.replayed, true);
  assert.deepEqual(replayBody.revocation, createdBody.revocation);

  const changedReason = await handleAuthenticatedRoute(
    revocationRequest({ ...projectBody, reason_code: "source_authority_drift" }),
    env,
    auth(),
  );
  assert.equal(changedReason.status, 409);
  assert.deepEqual(await changedReason.json(), { error: "facet_link_revocation_conflict" });
  assert.equal(
    Number((db.raw.prepare("SELECT COUNT(*) AS count FROM facet_v2_link_revocations").get() as { count: number }).count),
    1,
  );

  const row = db.raw.prepare(
    `SELECT revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
            destination_tenant_id, revoked_at
       FROM facet_v2_link_revocations`,
  ).get() as Record<string, string>;
  assert.deepEqual({ ...row }, createdBody.revocation);
  assert.throws(() => db.raw.prepare(
    `UPDATE facet_v2_link_revocations SET reason_code = 'source_authority_drift'
      WHERE revocation_id = ?`,
  ).run(row.revocation_id));
  assert.throws(() => db.raw.prepare(
    `DELETE FROM facet_v2_link_revocations WHERE revocation_id = ?`,
  ).run(row.revocation_id));
});

test("governed revocation accepts each existing Facet link kind only within the tenant", async () => {
  const db = new SqliteD1();
  const env = appEnv(db);
  for (const body of [
    {
      link_kind: "producer_identity",
      link_id: PRODUCER_LINK,
      reason_code: "producer_identity_compromised",
    },
    {
      link_kind: "customer_identity",
      link_id: CUSTOMER_LINK,
      reason_code: "customer_identity_compromised",
    },
  ] as const) {
    const response = await handleAuthenticatedRoute(
      revocationRequest(body),
      env,
      auth(),
    );
    assert.equal(response.status, 201, body.link_kind);
  }
  assert.equal(
    Number((db.raw.prepare("SELECT COUNT(*) AS count FROM facet_v2_link_revocations").get() as { count: number }).count),
    2,
  );
});

test("legacy association and quote-preparation routes stay 404 even when old flags are true", async () => {
  const db = new SqliteD1();
  for (const path of [
    "/api/v1/facet-design-evidence/association-ready",
    "/api/v1/facet-design-evidence/associations",
    "/api/v1/facet-design-evidence/associations/facet-approved-1/quote-revision-approvals",
  ]) {
    const response = await handleAuthenticatedRoute(
      request(path, path.endsWith("association-ready") ? "GET" : "POST"),
      appEnv(db),
      auth(),
    );
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "not_found" });
  }
  assert.equal(permissionsForRole("owner").includes("facet:associate"), false);
  assert.equal(permissionsForRole("ops").includes("facet:associate"), false);
});

test("live Facet ingress and recovery keep signed-v2 authority ahead of gated Frappe projection", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.equal(source.match(/reconcileFacetDesignSurfaces\(env\)/g)?.length, 2);
  assert.equal(source.match(/reconcileFacetDesignFrappeProjections/g)?.length, 2);
  assert.match(
    source,
    /reconcileFacetDesignNativeProjections\(env\);[\s\S]*?at: "facet_design_native_projection_reconcile"/,
  );
  assert.match(
    source,
    /reconcileFacetDesignFrappeProjections\([\s\S]*?at: "facet_design_frappe_compatibility_reconcile"/,
  );
  assert.equal(source.match(/at: "facet_design_native_projection_reconcile"/g)?.length, 1);
  assert.equal(source.match(/at: "facet_design_frappe_compatibility_reconcile"/g)?.length, 1);
  assert.doesNotMatch(
    source,
    /reconcileFacetDesignFrappeProjections\([\s\S]{0,500}facet_design_native_projection/,
  );
  assert.doesNotMatch(source, /createPostizDraftFromFacetApproval/);
  assert.doesNotMatch(source, /recoverPostizFacetDrafts/);
});
