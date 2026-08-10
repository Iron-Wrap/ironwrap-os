import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  facetDesignAssociationAnchorSha256,
  type FacetDesignAssociationAnchor,
} from "../src/facet-design-association.ts";
import { reconcileFacetDesignFrappeProjections } from "../src/facet-design-projection.ts";

const HMAC_SECRET = "facet-projection-test-secret-longer-than-thirty-two-characters";
const EVENT = {
  event_id: "facet-event-v2-0001",
  tenant_id: "ironwrap",
  brand_id: "ironwrap",
  facet_project_id: "facet-project-0001",
  design_revision_sha256: "a".repeat(64),
  frozen_evidence_sha256: "b".repeat(64),
  raw_key: "facet-design/v2/facet-event-v2-0001.json",
  raw_sha256: "c".repeat(64),
  raw_content_length: 512,
  occurred_at: "2026-08-10T12:00:00.000Z",
  received_at: "2026-08-10T12:01:00.000Z",
};
const DESIGN_REVISION_ID = `facet-json-v1:${EVENT.design_revision_sha256}`;

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0011_app_bff_auth.sql",
      "0030_facet_design_ingest.sql",
      "0032_facet_design_frappe_projection.sql",
      "0034_facet_customer_approval_ingest.sql",
      "0035_facet_design_evidence_associations.sql",
    ]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    const now = "2026-08-10T11:00:00.000Z";
    this.raw.prepare(
      `INSERT INTO app_users
         (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
          active, created_by, created_at, updated_at)
       VALUES ('appu_owner_0001', 'ironwrap', 'owner@example.com', 'Owner', 'owner',
               'owner@example.com', 1, 'seed', ?, ?)`,
    ).run(now, now);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(raw: DatabaseSync, sql: string, args: unknown[]) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.raw, this.sql, args);
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

function seedCustomerApproval(db: SqliteD1): void {
  db.raw.prepare(
    `INSERT INTO facet_customer_approval_events
       (event_id, event_type, schema_version, occurred_at, tenant_id, brand_id,
        facet_project_id, design_revision_id, design_revision_sha256,
        frozen_evidence_sha256, approval_actor_type, capability_fingerprint, identity_assurance,
        raw_key, raw_sha256, raw_content_length, received_at)
     VALUES (?, 'facet.design.customer_approved.v2', 2, ?, ?, ?, ?, ?, ?, ?,
             'customer_capability', ?, 'bearer_capability_only', ?, ?, ?, ?)`,
  ).run(
    EVENT.event_id,
    EVENT.occurred_at,
    EVENT.tenant_id,
    EVENT.brand_id,
    EVENT.facet_project_id,
    DESIGN_REVISION_ID,
    EVENT.design_revision_sha256,
    EVENT.frozen_evidence_sha256,
    "d".repeat(64),
    EVENT.raw_key,
    EVENT.raw_sha256,
    EVENT.raw_content_length,
    EVENT.received_at,
  );
}

function seedLegacyEvent(db: SqliteD1): void {
  db.raw.prepare(
    `INSERT INTO facet_design_events
       (event_id, event_type, schema_version, occurred_at, tenant_id, facet_project_id,
        design_revision_id, design_revision_sha256, frozen_evidence_sha256, raw_key,
        raw_sha256, raw_content_length, received_at)
     VALUES ('facet-event-v1-legacy', 'facet.design.approved.v1', 1, ?, 'ironwrap',
             'facet-project-legacy', ?, ?, ?, 'facet-design/v1/facet-event-v1-legacy.json',
             ?, 256, ?)`,
  ).run(
    EVENT.occurred_at,
    DESIGN_REVISION_ID,
    EVENT.design_revision_sha256,
    EVENT.frozen_evidence_sha256,
    "9".repeat(64),
    EVENT.received_at,
  );
}

async function seedAssociation(db: SqliteD1): Promise<void> {
  const anchor: FacetDesignAssociationAnchor = {
    event_id: EVENT.event_id,
    tenant_id: EVENT.tenant_id,
    brand_id: EVENT.brand_id,
    facet_project_id: EVENT.facet_project_id,
    design_revision_id: DESIGN_REVISION_ID,
    design_revision_sha256: EVENT.design_revision_sha256,
    frozen_evidence_sha256: EVENT.frozen_evidence_sha256,
    roof_job_id: "roof-job-0001",
    customer_quote_id: "customer-quote-0001",
  };
  db.raw.prepare(
    `INSERT INTO facet_design_evidence_associations
       (event_id, tenant_id, brand_id, facet_project_id, design_revision_id,
        design_revision_sha256, frozen_evidence_sha256, roof_job_id, customer_quote_id,
        associated_by_user_id, reason, idempotency_key_sha256, association_intent_sha256,
        association_anchor_sha256, associated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'appu_owner_0001', ?, ?, ?, ?, ?)`,
  ).run(
    anchor.event_id,
    anchor.tenant_id,
    anchor.brand_id,
    anchor.facet_project_id,
    anchor.design_revision_id,
    anchor.design_revision_sha256,
    anchor.frozen_evidence_sha256,
    anchor.roof_job_id,
    anchor.customer_quote_id,
    "Operator matched the approved design to the current quote.",
    "e".repeat(64),
    "f".repeat(64),
    await facetDesignAssociationAnchorSha256(anchor),
    "2026-08-10T12:02:00.000Z",
  );
}

function testEnv(db: SqliteD1): Env {
  return {
    DB: db as never,
    FACET_DESIGN_FRAPPE_PROJECTION_ENABLED: "true",
    FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: HMAC_SECRET,
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: "facet-projection-key",
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: "facet-projection-secret",
    // Retained for rollout compatibility, but deliberately not consulted by projection.
    FACET_DESIGN_FRAPPE_PROJECTION_ASSOCIATIONS_JSON: JSON.stringify({
      schema_version: 1,
      associations: [{ event_id: EVENT.event_id, tenant_id: "foreign-tenant" }],
    }),
    ERPNEXT_BASE_URL: "https://frappe.example",
    APP_FRAPPE_REQUEST_TIMEOUT_MS: "8000",
  } as Env;
}

function count(db: SqliteD1, outcome: string): number {
  return Number((db.raw.prepare(
    `SELECT COUNT(*) AS count
     FROM facet_customer_approval_projection_attempts
     WHERE outcome = ?`,
  ).get(outcome) as { count: number }).count);
}

function installFrappeMock(status = 200): {
  calls: Array<{ claim: Record<string, unknown>; headers: Headers }>;
  restore(): void;
} {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ claim: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = async (_input, init) => {
    const request = init as RequestInit;
    const body = JSON.parse(String(request.body)) as { facet_claim_json: string };
    const claim = JSON.parse(body.facet_claim_json) as Record<string, unknown>;
    const headers = new Headers(request.headers);
    calls.push({ claim, headers });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "rejected" }), { status });
    }
    const eventId = String(claim.event_id);
    const eventHash = createHash("sha256").update(eventId).digest("hex");
    return Response.json({
      message: {
        event_id: eventId,
        evidence_id: `facet-design:${eventHash}`,
        reconciliation_id: `facet-design-projection:${eventHash}`,
      },
    });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("Facet projection trusts only the durable v2 ledger and remains terminal after success", async () => {
  const db = new SqliteD1();
  seedCustomerApproval(db);
  seedLegacyEvent(db);
  await seedAssociation(db);
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(
      testEnv(db),
      new Date("2026-08-10T12:03:00.000Z"),
    );
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0]!;
    assert.equal(call.claim.event_id, EVENT.event_id);
    assert.equal(call.claim.raw_key, EVENT.raw_key);
    assert.equal(call.claim.roof_job_id, "roof-job-0001");
    assert.equal(call.claim.customer_quote_id, "customer-quote-0001");
    assert.equal(call.headers.get("authorization"), "token facet-projection-key:facet-projection-secret");
    for (const forbidden of [
      "brand_id",
      "capability_fingerprint",
      "price",
      "contract",
      "acceptance",
      "proposal_pack",
    ]) assert.equal(forbidden in call.claim, false, `claim must not carry ${forbidden}`);
    assert.equal(count(db, "projected"), 1);
    assert.equal(
      Number((db.raw.prepare("SELECT COUNT(*) AS count FROM facet_design_projection_attempts").get() as { count: number }).count),
      0,
      "legacy v1 projection history must remain separate",
    );

    await reconcileFacetDesignFrappeProjections(
      testEnv(db),
      new Date("2026-08-10T12:10:00.000Z"),
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("Facet projection holds an unassociated v2 receipt once and resumes after an operator binding", async () => {
  const db = new SqliteD1();
  seedCustomerApproval(db);
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(testEnv(db));
    await reconcileFacetDesignFrappeProjections(testEnv(db));
    assert.equal(mock.calls.length, 0);
    assert.equal(count(db, "held_missing_association"), 1);

    await seedAssociation(db);
    await reconcileFacetDesignFrappeProjections(testEnv(db));
    assert.equal(mock.calls.length, 1);
    assert.equal(count(db, "projected"), 1);
  } finally {
    mock.restore();
  }
});

test("Facet projection retries transient Frappe uncertainty without inventing success", async () => {
  const db = new SqliteD1();
  seedCustomerApproval(db);
  await seedAssociation(db);
  const mock = installFrappeMock(503);
  try {
    await reconcileFacetDesignFrappeProjections(
      testEnv(db),
      new Date("2026-08-10T12:00:00.000Z"),
    );
    await reconcileFacetDesignFrappeProjections(
      testEnv(db),
      new Date("2026-08-10T12:00:30.000Z"),
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(count(db, "uncertain"), 1);
    assert.equal(count(db, "projected"), 0);
  } finally {
    mock.restore();
  }
});
