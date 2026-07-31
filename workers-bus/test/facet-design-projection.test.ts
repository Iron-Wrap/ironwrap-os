import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { reconcileFacetDesignFrappeProjections } from "../src/facet-design-projection.ts";

const HMAC_SECRET = "facet-projection-test-secret-longer-than-thirty-two-characters";
const EVENT = {
  event_id: "facet-event-0001",
  tenant_id: "ironwrap",
  facet_project_id: "facet-project-0001",
  design_revision_sha256: "a".repeat(64),
  frozen_evidence_sha256: "b".repeat(64),
  raw_key: "facet-design/v1/facet-event-0001.json",
  raw_sha256: "c".repeat(64),
  raw_content_length: 512,
  occurred_at: "2026-07-31T12:00:00.000Z",
  received_at: "2026-07-31T12:01:00.000Z",
};
const DESIGN_REVISION_ID = `facet-json-v1:${EVENT.design_revision_sha256}`;

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    for (const migration of ["0030_facet_design_ingest.sql", "0032_facet_design_frappe_projection.sql"]) {
      this.raw.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
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

function eventFor(sequence: number) {
  const suffix = String(sequence).padStart(4, "0");
  return {
    ...EVENT,
    event_id: `facet-event-${suffix}`,
    facet_project_id: `facet-project-${suffix}`,
    raw_key: `facet-design/v1/facet-event-${suffix}.json`,
    raw_sha256: createHash("sha256").update(`facet-raw-${suffix}`).digest("hex"),
  };
}

function seedEvent(db: SqliteD1, event = EVENT): void {
  db.raw.prepare(
    `INSERT INTO facet_design_events
       (event_id, event_type, schema_version, occurred_at, tenant_id, facet_project_id,
        design_revision_id, design_revision_sha256, frozen_evidence_sha256, raw_key,
        raw_sha256, raw_content_length, received_at)
     VALUES (?, 'facet.design.approved.v1', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_id,
    event.occurred_at,
    event.tenant_id,
    event.facet_project_id,
    `facet-json-v1:${event.design_revision_sha256}`,
    event.design_revision_sha256,
    event.frozen_evidence_sha256,
    event.raw_key,
    event.raw_sha256,
    event.raw_content_length,
    event.received_at,
  );
}

function association(
  overrides: Partial<Record<string, string>> = {},
  event = EVENT,
) {
  return {
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    facet_project_id: event.facet_project_id,
    design_revision_id: `facet-json-v1:${event.design_revision_sha256}`,
    design_revision_sha256: event.design_revision_sha256,
    frozen_evidence_sha256: event.frozen_evidence_sha256,
    roof_job_id: "roof-job-0001",
    customer_quote_id: "customer-quote-0001",
    ...overrides,
  };
}

function testEnv(db: SqliteD1, associations = [association()]): Env {
  return {
    DB: db as never,
    FACET_DESIGN_FRAPPE_PROJECTION_ENABLED: "true",
    FACET_DESIGN_FRAPPE_PROJECTION_HMAC_KEY: HMAC_SECRET,
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_KEY: "facet-projection-key",
    FACET_DESIGN_FRAPPE_PROJECTION_FRAPPE_API_SECRET: "facet-projection-secret",
    FACET_DESIGN_FRAPPE_PROJECTION_ASSOCIATIONS_JSON: JSON.stringify({
      schema_version: 1,
      associations,
    }),
    ERPNEXT_BASE_URL: "https://frappe.example",
    APP_FRAPPE_REQUEST_TIMEOUT_MS: "8000",
  } as Env;
}

function count(db: SqliteD1, outcome: string): number {
  return Number((db.raw.prepare(
    "SELECT COUNT(*) AS count FROM facet_design_projection_attempts WHERE outcome = ?",
  ).get(outcome) as { count: number }).count);
}

function installFrappeMock(status: number | ((claim: Record<string, unknown>) => number) = 200): {
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
    const responseStatus = typeof status === "function" ? status(claim) : status;
    if (responseStatus !== 200) {
      return new Response(JSON.stringify({ error: "rejected" }), { status: responseStatus });
    }
    const eventId = String(claim.event_id);
    const eventHash = createHash("sha256").update(eventId).digest("hex");
    return new Response(JSON.stringify({
      message: {
        event_id: eventId,
        evidence_id: `facet-design:${eventHash}`,
        reconciliation_id: `facet-design-projection:${eventHash}`,
        idempotent_replay: false,
      },
    }), { headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

test("Facet projection consumes only D1 anchors and is idempotent after a durable Frappe receipt", async () => {
  const db = new SqliteD1();
  seedEvent(db);
  const env = testEnv(db);
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:02:00.000Z"));

    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0]!;
    assert.equal(call.headers.get("authorization"), "token facet-projection-key:facet-projection-secret");
    assert.ok(call.headers.get("x-ironwrap-facet-projection-signature"));
    assert.equal(call.claim.event_id, EVENT.event_id);
    assert.equal(call.claim.raw_key, EVENT.raw_key);
    assert.equal(call.claim.raw_sha256, EVENT.raw_sha256);
    assert.equal(call.claim.roof_job_id, "roof-job-0001");
    assert.equal(call.claim.customer_quote_id, "customer-quote-0001");
    for (const forbidden of ["price", "contract", "acceptance", "proposal_pack"]) {
      assert.equal(forbidden in call.claim, false, `projection claim must not carry ${forbidden}`);
    }
    assert.equal(count(db, "projected"), 1);

    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:07:00.000Z"));
    assert.equal(mock.calls.length, 1, "a durable success must not call Frappe again");
    assert.equal(count(db, "projected"), 1);
  } finally {
    mock.restore();
  }
});

test("Facet projection holds missing mappings and rejects stale or foreign exact-anchor mappings before Frappe", async () => {
  const missingDb = new SqliteD1();
  seedEvent(missingDb);
  const missingMock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(testEnv(missingDb, []));
    await reconcileFacetDesignFrappeProjections(testEnv(missingDb, []));
    assert.equal(missingMock.calls.length, 0);
    assert.equal(count(missingDb, "held_missing_association"), 1);
  } finally {
    missingMock.restore();
  }

  const staleDb = new SqliteD1();
  seedEvent(staleDb);
  const staleMock = installFrappeMock();
  try {
    const staleHash = "d".repeat(64);
    await reconcileFacetDesignFrappeProjections(testEnv(staleDb, [association({
      design_revision_sha256: staleHash,
      design_revision_id: `facet-json-v1:${staleHash}`,
    })]));
    assert.equal(staleMock.calls.length, 0);
    assert.equal(count(staleDb, "rejected_association_mismatch"), 1);
  } finally {
    staleMock.restore();
  }

  const foreignDb = new SqliteD1();
  seedEvent(foreignDb);
  const foreignMock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(testEnv(foreignDb, [association({
      tenant_id: "foreign-tenant",
    })]));
    assert.equal(foreignMock.calls.length, 0);
    assert.equal(count(foreignDb, "rejected_association_mismatch"), 1);
  } finally {
    foreignMock.restore();
  }
});

test("Facet projection does not let unchanged held receipts starve a later exact association", async () => {
  const db = new SqliteD1();
  for (let sequence = 1; sequence <= 25; sequence += 1) seedEvent(db, eventFor(sequence));
  const mock = installFrappeMock();
  try {
    await reconcileFacetDesignFrappeProjections(testEnv(db, []));
    assert.equal(count(db, "held_missing_association"), 25);

    const readyEvent = eventFor(26);
    seedEvent(db, readyEvent);
    await reconcileFacetDesignFrappeProjections(testEnv(db, [association({}, readyEvent)]));

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]!.claim.event_id, readyEvent.event_id);
    assert.equal(count(db, "projected"), 1);
  } finally {
    mock.restore();
  }
});

test("Facet projection rejects configuration above the D1 binding ceiling before any query or Frappe call", async () => {
  const db = new SqliteD1();
  const associations = Array.from(
    { length: 50 },
    (_, index) => association({}, eventFor(index + 1)),
  );
  const mock = installFrappeMock();
  try {
    await assert.rejects(
      () => reconcileFacetDesignFrappeProjections(testEnv(db, associations)),
      /facet_design_projection_not_configured/,
    );
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("Facet projection records a permanent Frappe refusal once without fabricating a local success", async () => {
  const db = new SqliteD1();
  seedEvent(db);
  const mock = installFrappeMock(409);
  try {
    const env = testEnv(db);
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:02:00.000Z"));
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T13:02:00.000Z"));
    assert.equal(mock.calls.length, 1);
    assert.equal(count(db, "projected"), 0);
    assert.equal(count(db, "rejected_frappe"), 1);
    const result = db.raw.prepare(
      "SELECT error_code FROM facet_design_projection_attempts WHERE outcome = 'rejected_frappe'",
    ).get() as { error_code: string };
    assert.equal(result.error_code, "frappe_http_409");
  } finally {
    mock.restore();
  }
});

test("Facet projection retries a repaired Frappe authorization failure instead of stranding the revision", async () => {
  const db = new SqliteD1();
  seedEvent(db);
  let responseStatus = 401;
  const mock = installFrappeMock(() => responseStatus);
  try {
    const env = testEnv(db);
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:00:00.000Z"));
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:00:30.000Z"));
    assert.equal(mock.calls.length, 1, "authorization repair must respect the bounded retry delay");
    assert.equal(count(db, "rejected_frappe"), 0);
    assert.equal(count(db, "uncertain"), 1);

    responseStatus = 200;
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:01:01.000Z"));
    assert.equal(mock.calls.length, 2);
    assert.equal(count(db, "projected"), 1);
  } finally {
    mock.restore();
  }
});

test("Facet projection lets 25 permanent Frappe refusals yield to a later exact association", async () => {
  const db = new SqliteD1();
  const rejectedEvents = Array.from({ length: 25 }, (_, index) => eventFor(index + 1));
  const readyEvent = eventFor(26);
  for (const event of [...rejectedEvents, readyEvent]) seedEvent(db, event);
  const mock = installFrappeMock((claim) =>
    claim.event_id === readyEvent.event_id ? 200 : 409,
  );
  try {
    const env = testEnv(db, [...rejectedEvents, readyEvent].map((event) => association({}, event)));
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:02:00.000Z"));
    assert.equal(mock.calls.length, 25);
    assert.equal(count(db, "rejected_frappe"), 25);

    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:03:00.000Z"));
    assert.equal(mock.calls.length, 26);
    assert.equal(mock.calls[25]!.claim.event_id, readyEvent.event_id);
    assert.equal(count(db, "projected"), 1);
  } finally {
    mock.restore();
  }
});

test("Facet projection backoffs transient uncertainty and prioritizes a later never-tried association", async () => {
  const db = new SqliteD1();
  const uncertainEvent = eventFor(1);
  const readyEvent = eventFor(2);
  seedEvent(db, uncertainEvent);
  const mock = installFrappeMock((claim) =>
    claim.event_id === uncertainEvent.event_id ? 503 : 200,
  );
  try {
    const env = testEnv(db, [association({}, uncertainEvent), association({}, readyEvent)]);
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:00:00.000Z"));
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:00:30.000Z"));
    assert.equal(mock.calls.length, 1, "first uncertainty must wait at least one minute");

    seedEvent(db, readyEvent);
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:02:00.000Z"));
    assert.deepEqual(
      mock.calls.map((call) => call.claim.event_id),
      [uncertainEvent.event_id, readyEvent.event_id, uncertainEvent.event_id],
    );
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:04:00.000Z"));
    assert.equal(mock.calls.length, 3, "second uncertainty must wait five minutes");
    await reconcileFacetDesignFrappeProjections(env, new Date("2026-07-31T12:07:01.000Z"));
    assert.equal(mock.calls.length, 4);
    assert.equal(count(db, "uncertain"), 3);
  } finally {
    mock.restore();
  }
});
