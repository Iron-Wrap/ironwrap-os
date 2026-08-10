import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AppRole, AuthContext } from "../src/app-types.ts";

const TENANT = "ironwrap";
const EVENT = {
  event_id: "facet-event-v2-api-0001",
  brand_id: "ironwrap",
  facet_project_id: "facet-project-api-0001",
  design_revision_sha256: "a".repeat(64),
  frozen_evidence_sha256: "b".repeat(64),
};
const DESIGN_REVISION_ID = `facet-json-v1:${EVENT.design_revision_sha256}`;
const ROOF_JOB_ID = "roof-job-api-0001";
const CUSTOMER_QUOTE_ID = "customer-quote-api-0001";

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0030_facet_design_ingest.sql",
      "0034_facet_customer_approval_ingest.sql",
      "0035_facet_design_evidence_associations.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const now = "2026-08-10T11:00:00.000Z";
    const insert = this.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
    );
    insert.run(
      "appu_owner_0001",
      TENANT,
      "owner@example.com",
      "Owner",
      "owner",
      "owner@example.com",
      now,
      now,
    );
    insert.run(
      "appu_ops_000001",
      TENANT,
      "ops@example.com",
      "Ops",
      "ops",
      "ops@example.com",
      now,
      now,
    );
    insert.run(
      "appu_field_0001",
      TENANT,
      "field@example.com",
      "Field",
      "field",
      "field@example.com",
      now,
      now,
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

function seedCustomerApproval(
  db: SqliteD1,
  input: {
    eventId?: string;
    brandId?: string;
    projectId?: string;
    rawSuffix?: string;
  } = {},
): void {
  const eventId = input.eventId ?? EVENT.event_id;
  const brandId = input.brandId ?? EVENT.brand_id;
  const projectId = input.projectId ?? EVENT.facet_project_id;
  const rawSuffix = input.rawSuffix ?? "1";
  db.raw.prepare(
    `INSERT INTO facet_customer_approval_events
       (event_id, event_type, schema_version, occurred_at, tenant_id, brand_id,
        facet_project_id, design_revision_id, design_revision_sha256,
        frozen_evidence_sha256, approval_actor_type, capability_fingerprint, identity_assurance,
        raw_key, raw_sha256, raw_content_length, received_at)
     VALUES (?, 'facet.design.customer_approved.v2', 2, ?, ?, ?, ?, ?, ?, ?,
             'customer_capability', ?, 'bearer_capability_only', ?, ?, 512, ?)`,
  ).run(
    eventId,
    "2026-08-10T12:00:00.000Z",
    TENANT,
    brandId,
    projectId,
    DESIGN_REVISION_ID,
    EVENT.design_revision_sha256,
    EVENT.frozen_evidence_sha256,
    rawSuffix.repeat(64),
    `facet-design/v2/${eventId}.json`,
    rawSuffix.repeat(64),
    "2026-08-10T12:01:00.000Z",
  );
}

function seedLegacyEvent(db: SqliteD1): void {
  db.raw.prepare(
    `INSERT INTO facet_design_events
       (event_id, event_type, schema_version, occurred_at, tenant_id, facet_project_id,
        design_revision_id, design_revision_sha256, frozen_evidence_sha256, raw_key,
        raw_sha256, raw_content_length, received_at)
     VALUES ('facet-event-v1-api-legacy', 'facet.design.approved.v1', 1, ?, ?,
             'facet-project-v1-api', ?, ?, ?, 'facet-design/v1/facet-event-v1-api-legacy.json',
             ?, 256, ?)`,
  ).run(
    "2026-08-10T10:00:00.000Z",
    TENANT,
    DESIGN_REVISION_ID,
    EVENT.design_revision_sha256,
    EVENT.frozen_evidence_sha256,
    "9".repeat(64),
    "2026-08-10T10:01:00.000Z",
  );
}

function env(db: SqliteD1): AppEnv {
  return {
    DB: db as never,
    ERPNEXT_BASE_URL: "https://frappe.example.com",
    ERPNEXT_API_KEY: "read-key",
    ERPNEXT_API_SECRET: "read-secret",
    APP_FRAPPE_REQUEST_TIMEOUT_MS: "5000",
  } as AppEnv;
}

function auth(role: AppRole): AuthContext {
  const actor = role === "owner"
    ? { userId: "appu_owner_0001", email: "owner@example.com" }
    : role === "ops"
      ? { userId: "appu_ops_000001", email: "ops@example.com" }
      : { userId: "appu_field_0001", email: "field@example.com" };
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: ["session:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-10T11:55:00.000Z",
      session_expires_at: "2026-08-10T13:00:00.000Z",
      revoked_at: null,
      user_id: actor.userId,
      tenant_id: TENANT,
      email_normalized: actor.email,
      display_name: role,
      role,
      frappe_user_id: actor.email,
      active: 1,
      created_by: "seed",
      created_at: "2026-08-10T11:00:00.000Z",
      updated_at: "2026-08-10T11:00:00.000Z",
    },
  };
}

function associationBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: EVENT.event_id,
    brand_id: EVENT.brand_id,
    facet_project_id: EVENT.facet_project_id,
    design_revision_id: DESIGN_REVISION_ID,
    design_revision_sha256: EVENT.design_revision_sha256,
    frozen_evidence_sha256: EVENT.frozen_evidence_sha256,
    roof_job_id: ROOF_JOB_ID,
    customer_quote_id: CUSTOMER_QUOTE_ID,
    reason: "Matched against the approved estimator review and current quote pointer.",
    ...overrides,
  };
}

function request(
  path: string,
  body?: Record<string, unknown>,
  idempotency?: string,
  csrf = true,
): Request {
  const headers = new Headers();
  if (csrf) headers.set("x-csrf-token", "csrf");
  if (body) headers.set("content-type", "application/json");
  if (idempotency) headers.set("idempotency-key", idempotency);
  return new Request(`https://app.example.com${path}`, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function installFrappeMock(options: { brand?: string; quoteStatus?: string } = {}) {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const inbound = input instanceof Request ? input : new Request(input, init);
    const url = new URL(inbound.url);
    const doctype = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    calls.push(doctype);
    if (doctype === "Roof Job") {
      return Response.json({
        data: [{
          name: "ROOF-JOB-DOC-0001",
          roof_job_id: ROOF_JOB_ID,
          brand: options.brand ?? "ironwrap",
          quotation: "QUOTE-DOC-0001",
          modified: "2026-08-10T11:00:00.000Z",
        }],
      });
    }
    if (doctype === "Customer Quote") {
      return Response.json({
        data: [{
          name: "QUOTE-DOC-0001",
          customer_quote_id: CUSTOMER_QUOTE_ID,
          roof_job: "ROOF-JOB-DOC-0001",
          quote_version: 3,
          status: options.quoteStatus ?? "Approved",
          approved_at: "2026-08-10T11:30:00.000Z",
          modified: "2026-08-10T11:30:00.000Z",
        }],
      });
    }
    return Response.json({ data: [] });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("office list returns only safe, unassociated v2 customer approval anchors", async () => {
  const db = new SqliteD1();
  seedCustomerApproval(db);
  seedLegacyEvent(db);
  const response = await handleAuthenticatedRoute(
    request("/api/v1/facet-design-evidence/association-ready"),
    env(db),
    auth("owner"),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { evidence: Array<Record<string, unknown>> };
  assert.equal(body.evidence.length, 1);
  assert.equal(body.evidence[0]?.event_id, EVENT.event_id);
  assert.equal(body.evidence[0]?.provenance, "customer_approved");
  assert.equal(body.evidence[0]?.association_state, "required");
  const serialized = JSON.stringify(body);
  for (const forbidden of ["raw_key", "raw_sha256", "capability_fingerprint", "reason", "email"]) {
    assert.equal(serialized.includes(forbidden), false, `response must not expose ${forbidden}`);
  }
  assert.throws(
    () => db.raw.prepare(
      `INSERT INTO facet_design_evidence_associations
         (event_id, tenant_id, brand_id, facet_project_id, design_revision_id,
          design_revision_sha256, frozen_evidence_sha256, roof_job_id, customer_quote_id,
          associated_by_user_id, reason, idempotency_key_sha256, association_intent_sha256,
          association_anchor_sha256, associated_at)
       SELECT event_id, tenant_id, 'iroof', facet_project_id, design_revision_id,
              design_revision_sha256, frozen_evidence_sha256, ?, ?, 'appu_owner_0001',
              'Deliberately mismatched brand for the database invariant check.', ?, ?, ?, ?
       FROM facet_customer_approval_events WHERE event_id = ?`,
    ).run(
      ROOF_JOB_ID,
      CUSTOMER_QUOTE_ID,
      "3".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
      "2026-08-10T12:02:00.000Z",
      EVENT.event_id,
    ),
    /event_anchor_mismatch/,
  );

  const field = await handleAuthenticatedRoute(
    request("/api/v1/facet-design-evidence/association-ready"),
    env(db),
    auth("field"),
  );
  assert.equal(field.status, 403);
});

test("office association is CSRF-protected, append-only, and exactly idempotent", async () => {
  const db = new SqliteD1();
  seedCustomerApproval(db);
  const appEnv = env(db);
  const missingCsrf = await handleAuthenticatedRoute(
    request("/api/v1/facet-design-evidence/associations", associationBody(), "facet-assoc-api-0001", false),
    appEnv,
    auth("ops"),
  );
  assert.equal(missingCsrf.status, 403);

  const callerTenant = await handleAuthenticatedRoute(
    request(
      "/api/v1/facet-design-evidence/associations",
      { ...associationBody(), tenant_id: "foreign" },
      "facet-assoc-api-0001",
    ),
    appEnv,
    auth("ops"),
  );
  assert.equal(callerTenant.status, 400, "callers cannot supply tenant identity");

  const mock = installFrappeMock();
  try {
    const created = await handleAuthenticatedRoute(
      request(
        "/api/v1/facet-design-evidence/associations",
        associationBody(),
        "facet-assoc-api-0001",
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(created.status, 201);
    const createdBody = await created.json() as Record<string, unknown>;
    const serialized = JSON.stringify(createdBody);
    assert.equal(serialized.includes("reason"), false);
    assert.equal(serialized.includes("associated_by"), false);
    assert.equal(serialized.includes("capability_fingerprint"), false);
    assert.deepEqual(mock.calls, ["Roof Job", "Customer Quote"]);

    const stored = db.raw.prepare(
      `SELECT tenant_id, associated_by_user_id, reason, idempotency_key_sha256,
              association_intent_sha256, association_anchor_sha256
       FROM facet_design_evidence_associations`,
    ).get() as Record<string, unknown>;
    assert.equal(stored.tenant_id, TENANT);
    assert.equal(stored.associated_by_user_id, "appu_ops_000001");
    assert.equal(stored.reason, associationBody().reason);
    for (const field of [
      "idempotency_key_sha256",
      "association_intent_sha256",
      "association_anchor_sha256",
    ]) assert.match(String(stored[field]), /^[0-9a-f]{64}$/);

    const replay = await handleAuthenticatedRoute(
      request(
        "/api/v1/facet-design-evidence/associations",
        associationBody(),
        "facet-assoc-api-0001",
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed?: boolean }).replayed, true);
    assert.deepEqual(mock.calls, ["Roof Job", "Customer Quote"], "replay must not depend on Frappe");

    const keyConflict = await handleAuthenticatedRoute(
      request(
        "/api/v1/facet-design-evidence/associations",
        associationBody({ reason: "A different association intent must not reuse this key." }),
        "facet-assoc-api-0001",
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(keyConflict.status, 409);
    assert.deepEqual(await keyConflict.json(), {
      error: "facet_design_association_idempotency_conflict",
    });

    const eventConflict = await handleAuthenticatedRoute(
      request(
        "/api/v1/facet-design-evidence/associations",
        associationBody(),
        "facet-assoc-api-0002",
      ),
      appEnv,
      auth("ops"),
    );
    assert.equal(eventConflict.status, 409);
    assert.deepEqual(await eventConflict.json(), {
      error: "facet_design_event_already_associated",
    });
    assert.equal(
      Number((db.raw.prepare("SELECT COUNT(*) AS count FROM facet_design_evidence_associations").get() as { count: number }).count),
      1,
    );
    assert.throws(
      () => db.raw.prepare("UPDATE facet_design_evidence_associations SET reason = 'Rewritten reason' WHERE event_id = ?").run(EVENT.event_id),
      /append_only/,
    );
  } finally {
    mock.restore();
  }
});

test("commercial association rejects legacy provenance, cross-brand targets, and non-approved quotes", async () => {
  const db = new SqliteD1();
  seedLegacyEvent(db);
  seedCustomerApproval(db, {
    eventId: "facet-event-v2-api-iroof",
    brandId: "iroof",
    projectId: "facet-project-api-iroof",
    rawSuffix: "2",
  });
  const appEnv = env(db);

  const legacy = await handleAuthenticatedRoute(
    request(
      "/api/v1/facet-design-evidence/associations",
      associationBody({
        event_id: "facet-event-v1-api-legacy",
        facet_project_id: "facet-project-v1-api",
      }),
      "facet-assoc-api-legacy",
    ),
    appEnv,
    auth("owner"),
  );
  assert.equal(legacy.status, 409);
  assert.deepEqual(await legacy.json(), {
    error: "facet_design_provenance_not_association_ready",
  });

  const brandMock = installFrappeMock({ brand: "ironwrap" });
  try {
    const brandMismatch = await handleAuthenticatedRoute(
      request(
        "/api/v1/facet-design-evidence/associations",
        associationBody({
          event_id: "facet-event-v2-api-iroof",
          brand_id: "iroof",
          facet_project_id: "facet-project-api-iroof",
        }),
        "facet-assoc-api-iroof",
      ),
      appEnv,
      auth("owner"),
    );
    assert.equal(brandMismatch.status, 409);
    assert.deepEqual(await brandMismatch.json(), { error: "facet_design_brand_mismatch" });
  } finally {
    brandMock.restore();
  }

  const quoteDb = new SqliteD1();
  seedCustomerApproval(quoteDb);
  const quoteMock = installFrappeMock({ quoteStatus: "Draft" });
  try {
    const quoteMismatch = await handleAuthenticatedRoute(
      request(
        "/api/v1/facet-design-evidence/associations",
        associationBody(),
        "facet-assoc-api-draft",
      ),
      env(quoteDb),
      auth("owner"),
    );
    assert.equal(quoteMismatch.status, 409);
    assert.deepEqual(await quoteMismatch.json(), {
      error: "facet_design_current_approved_quote_required",
    });
    assert.equal(
      Number((quoteDb.raw.prepare("SELECT COUNT(*) AS count FROM facet_design_evidence_associations").get() as { count: number }).count),
      0,
    );
  } finally {
    quoteMock.restore();
  }
});
