import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import worker from "../src/index.ts";

const HMAC_SECRET = "facet-design-ingest-test-secret-longer-than-thirty-two-characters";
const FROZEN_DESIGN = {
  geometry: {
    planes: [{ id: "roof-plane-a", pitch: "6:12", area_square_meters: 143.25 }],
    perimeter_meters: 58.4,
  },
  materials: { roof_covering: "standing-seam-metal", underlayment: "synthetic" },
};
const FROZEN_DESIGN_SHA256 = sha256(canonicalJson(FROZEN_DESIGN));
const EVENT = {
  event_id: "facet-event-0001",
  event_type: "facet.design.approved.v1",
  schema_version: 1,
  occurred_at: "2026-07-31T12:00:00.000Z",
  tenant_id: "facet-production",
  facet_project_id: "facet-project-0001",
  design_revision: {
    id: `facet-json-v1:${FROZEN_DESIGN_SHA256}`,
    sha256: FROZEN_DESIGN_SHA256,
  },
  frozen_evidence: {
    design: FROZEN_DESIGN,
    catalog_revision: "catalog-2026-07",
    geometry_sha256: "b".repeat(64),
    estimate_inputs_sha256: "c".repeat(64),
    estimate_outputs_sha256: "d".repeat(64),
  },
};
const CUSTOMER_APPROVAL_EVENT = {
  event_id: "facet-event-v2-0001",
  event_type: "facet.design.customer_approved.v2",
  schema_version: 2,
  occurred_at: "2026-07-31T12:00:00.000Z",
  tenant_id: "facet-production",
  brand_id: "ironwrap",
  facet_project_id: "facet-project-0001",
  design_revision: EVENT.design_revision,
  approval_actor_type: "customer_capability",
  capability_fingerprint: "e".repeat(64),
  frozen_evidence: {
    design: FROZEN_DESIGN,
    approval: {
      approved_at: "2026-07-31T12:00:00.000Z",
      client_revision: { roofColorId: "charcoal" },
    },
  },
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec(readFileSync(new URL("../migrations/0030_facet_design_ingest.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0034_facet_customer_approval_ingest.sql", import.meta.url), "utf8"));
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ success: true; meta: { changes: number } }>> {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.execute());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

class SqliteStatement {
  private readonly raw: DatabaseSync;
  private readonly sql: string;
  private readonly args: unknown[];

  constructor(
    raw: DatabaseSync,
    sql: string,
    args: unknown[],
  ) {
    this.raw = raw;
    this.sql = sql;
    this.args = args;
  }

  bind(...args: unknown[]): SqliteStatement {
    return new SqliteStatement(this.raw, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    return (this.raw.prepare(this.sql).get(...this.args) ?? null) as T | null;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    return this.execute();
  }

  execute(): { success: true; meta: { changes: number } } {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes ?? 0) } };
  }
}

class MemoryR2 {
  readonly objects = new Map<string, { body: string; object: Record<string, unknown> }>();
  putCalls = 0;
  failPuts = false;

  async head(key: string) {
    return this.objects.get(key)?.object ?? null;
  }

  async put(key: string, body: string, options: { sha256?: string; customMetadata?: Record<string, string>; onlyIf?: unknown }) {
    this.putCalls += 1;
    if (this.failPuts) throw new Error("r2 unavailable");
    if (this.objects.has(key) && options.onlyIf) return null;
    const checksum = fromHex(options.sha256 ?? "");
    const object = {
      size: new TextEncoder().encode(body).byteLength,
      checksums: { sha256: checksum.buffer.slice(checksum.byteOffset, checksum.byteOffset + checksum.byteLength) },
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, object });
    return object;
  }
}

function testEnv(db: SqliteD1, raw: MemoryR2): Env {
  return {
    DB: db as never,
    RAW: raw as never,
    FACET_DESIGN_INGEST_ENABLED: "true",
    FACET_DESIGN_INGEST_HMAC_KEY: HMAC_SECRET,
    FACET_DESIGN_INGEST_TENANT_MAP_JSON: JSON.stringify({ "facet-production": "ironwrap" }),
    APP_TENANT_ID: "ironwrap",
  } as Env;
}

function signedRequest(
  body: Record<string, unknown> = EVENT,
  options: { eventId?: string; timestamp?: string; nonce?: string; signature?: string } = {},
): Request {
  const raw = JSON.stringify(body);
  const eventId = options.eventId ?? String(body.event_id);
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? randomBytes(32).toString("base64url");
  const signature = options.signature ?? createHmac("sha256", HMAC_SECRET)
    .update(`${timestamp}.${nonce}.${sha256(raw)}`)
    .digest("base64url");
  return new Request("https://bus.example/ingest/facet-design", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-event-id": eventId,
      "x-ironwrap-event-timestamp": timestamp,
      "x-ironwrap-event-nonce": nonce,
      "x-ironwrap-event-signature": signature,
    },
    body: raw,
  });
}

function count(db: SqliteD1, table: string): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function expectedReceipt(
  idempotentReplay = false,
  event: {
    event_id: string;
    event_type: string;
    frozen_evidence: unknown;
    design_revision: { id: string; sha256: string };
    brand_id?: string;
    capability_fingerprint?: string;
  } = EVENT,
): Record<string, unknown> {
  const customerApproval = event.event_type === "facet.design.customer_approved.v2";
  return {
    accepted: true,
    event_id: event.event_id,
    status: "received",
    raw_sha256: sha256(JSON.stringify(event)),
    frozen_evidence_sha256: sha256(canonicalJson(event.frozen_evidence)),
    design_revision: event.design_revision,
    provenance: customerApproval
      ? {
        status: "customer_approved",
        brand_id: event.brand_id,
        approval_actor_type: "customer_capability",
        capability_fingerprint: event.capability_fingerprint,
      }
      : { status: "provenance_unknown" },
    ...(idempotentReplay ? { idempotent_replay: true } : {}),
  };
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

test("Facet design receipt is HMAC-authenticated, R2-first, idempotent, and nonce-replay safe", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = testEnv(db, raw);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Facet ingress must not call a provider or Frappe");
  };
  try {
    const nonce = randomBytes(32).toString("base64url");
    const timestamp = String(Date.now());
    assert.equal(EVENT.design_revision.sha256, sha256(canonicalJson(EVENT.frozen_evidence.design)));
    assert.equal(EVENT.design_revision.id, `facet-json-v1:${EVENT.design_revision.sha256}`);
    const first = await worker.fetch(signedRequest(EVENT, { nonce, timestamp }), env, {} as never);
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), expectedReceipt());
    assert.equal(raw.objects.size, 1);
    assert.equal(count(db, "facet_design_events"), 1);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 1);
    assert.equal(fetchCalls, 0);
    const stored = db.raw.prepare("SELECT * FROM facet_design_events").get() as Record<string, unknown>;
    assert.equal(stored.event_type, EVENT.event_type);
    assert.equal(stored.schema_version, 1);
    assert.equal(stored.tenant_id, "ironwrap");
    assert.equal(stored.facet_project_id, EVENT.facet_project_id);
    assert.equal(stored.design_revision_id, EVENT.design_revision.id);
    assert.equal(stored.design_revision_sha256, EVENT.design_revision.sha256);
    assert.match(String(stored.frozen_evidence_sha256), /^[0-9a-f]{64}$/);
    assert.match(String(stored.raw_key), /^facet-design\/v1\/facet-event-0001\.json$/);
    assert.equal(raw.objects.get(String(stored.raw_key))?.body, JSON.stringify(EVENT));

    const exactRetry = await worker.fetch(signedRequest(EVENT), env, {} as never);
    assert.equal(exactRetry.status, 200);
    assert.deepEqual(await exactRetry.json(), expectedReceipt(true));
    assert.equal(count(db, "facet_design_events"), 1);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 2);
    assert.equal(raw.putCalls, 1);

    const replay = await worker.fetch(signedRequest(EVENT, { nonce, timestamp }), env, {} as never);
    assert.equal(replay.status, 409);
    assert.deepEqual(await replay.json(), { error: "event_replay" });
    assert.equal(count(db, "facet_design_events"), 1);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 2);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.raw.close();
  }
});

test("Facet customer approval v2 stores explicit customer-capability provenance without commercial side effects", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = testEnv(db, raw);
  env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = JSON.stringify({
    "facet-production": { tenant_id: "ironwrap", brand_ids: ["ironwrap", "iroof"] },
  });
  try {
    const nonce = randomBytes(32).toString("base64url");
    const timestamp = String(Date.now());
    const first = await worker.fetch(
      signedRequest(CUSTOMER_APPROVAL_EVENT, { nonce, timestamp }),
      env,
      {} as never,
    );
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), expectedReceipt(false, CUSTOMER_APPROVAL_EVENT));
    assert.equal(count(db, "facet_design_events"), 0);
    assert.equal(count(db, "facet_customer_approval_events"), 1);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 1);
    const stored = db.raw.prepare(
      "SELECT * FROM facet_customer_approval_events",
    ).get() as Record<string, unknown>;
    assert.equal(stored.event_type, CUSTOMER_APPROVAL_EVENT.event_type);
    assert.equal(stored.schema_version, 2);
    assert.equal(stored.brand_id, "ironwrap");
    assert.equal(stored.approval_actor_type, "customer_capability");
    assert.equal(stored.capability_fingerprint, CUSTOMER_APPROVAL_EVENT.capability_fingerprint);
    assert.match(String(stored.raw_key), /^facet-design\/v2\/facet-event-v2-0001\.json$/);

    const exactRetry = await worker.fetch(
      signedRequest(CUSTOMER_APPROVAL_EVENT),
      env,
      {} as never,
    );
    assert.equal(exactRetry.status, 200);
    assert.deepEqual(await exactRetry.json(), expectedReceipt(true, CUSTOMER_APPROVAL_EVENT));
    assert.equal(count(db, "facet_customer_approval_events"), 1);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 2);

    const crossVersionId = await worker.fetch(
      signedRequest({ ...EVENT, event_id: CUSTOMER_APPROVAL_EVENT.event_id }),
      env,
      {} as never,
    );
    assert.equal(crossVersionId.status, 409);
    assert.deepEqual(await crossVersionId.json(), { error: "event_id_conflict" });
    assert.equal(count(db, "facet_design_events"), 0);

    const crossVersionReplay = await worker.fetch(
      signedRequest(EVENT, { nonce, timestamp }),
      env,
      {} as never,
    );
    assert.equal(crossVersionReplay.status, 409);
    assert.deepEqual(await crossVersionReplay.json(), { error: "event_replay" });
    assert.equal(count(db, "facet_design_events"), 0);
  } finally {
    db.raw.close();
  }
});

test("Facet customer approval v2 rejects downgrade, non-customer actors, PII, totals, and untrusted brands", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = testEnv(db, raw);
  env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = JSON.stringify({
    "facet-production": { tenant_id: "ironwrap", brand_ids: ["ironwrap"] },
  });
  try {
    const { approval_actor_type: _ignoredActor, ...missingActor } = CUSTOMER_APPROVAL_EVENT;
    const cases = [
      missingActor,
      { ...CUSTOMER_APPROVAL_EVENT, approval_actor_type: "owner_session" },
      { ...CUSTOMER_APPROVAL_EVENT, capability_fingerprint: "short" },
      {
        ...CUSTOMER_APPROVAL_EVENT,
        frozen_evidence: {
          ...CUSTOMER_APPROVAL_EVENT.frozen_evidence,
          customer_email: "customer@example.invalid",
        },
      },
      {
        ...CUSTOMER_APPROVAL_EVENT,
        frozen_evidence: {
          ...CUSTOMER_APPROVAL_EVENT.frozen_evidence,
          estimate: { total: 1 },
        },
      },
      {
        ...CUSTOMER_APPROVAL_EVENT,
        occurred_at: "2026-07-31T12:00:01.000Z",
      },
    ];
    void _ignoredActor;
    for (const candidate of cases) {
      const response = await worker.fetch(signedRequest(candidate), env, {} as never);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_event_body" });
    }

    const unknownBrand = await worker.fetch(
      signedRequest({ ...CUSTOMER_APPROVAL_EVENT, brand_id: "unknown-brand" }),
      env,
      {} as never,
    );
    assert.equal(unknownBrand.status, 403);
    assert.deepEqual(await unknownBrand.json(), { error: "event_brand_untrusted" });

    env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = JSON.stringify({
      "facet-production": "ironwrap",
    });
    const legacyOnlyBinding = await worker.fetch(
      signedRequest(CUSTOMER_APPROVAL_EVENT),
      env,
      {} as never,
    );
    assert.equal(legacyOnlyBinding.status, 403);
    assert.deepEqual(await legacyOnlyBinding.json(), { error: "event_brand_untrusted" });

    assert.equal(raw.objects.size, 0);
    assert.equal(count(db, "facet_customer_approval_events"), 0);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 0);
  } finally {
    db.raw.close();
  }
});

test("Facet tenant mapping authorizes only explicit source-to-local pairs before R2 or D1", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = testEnv(db, raw);
  try {
    const unknownSource = await worker.fetch(
      signedRequest({ ...EVENT, tenant_id: "facet-untrusted" }),
      env,
      {} as never,
    );
    assert.equal(unknownSource.status, 403);
    assert.deepEqual(await unknownSource.json(), { error: "event_tenant_untrusted" });

    env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = JSON.stringify({ "facet-production": "other-tenant" });
    const mismatchedLocal = await worker.fetch(signedRequest(), env, {} as never);
    assert.equal(mismatchedLocal.status, 403);
    assert.deepEqual(await mismatchedLocal.json(), { error: "event_tenant_untrusted" });

    env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = "{}";
    const emptyMap = await worker.fetch(signedRequest(), env, {} as never);
    assert.equal(emptyMap.status, 503);
    assert.deepEqual(await emptyMap.json(), { error: "facet_design_ingest_unavailable" });

    env.FACET_DESIGN_INGEST_TENANT_MAP_JSON = "{";
    const malformedMap = await worker.fetch(signedRequest(), env, {} as never);
    assert.equal(malformedMap.status, 503);
    assert.deepEqual(await malformedMap.json(), { error: "facet_design_ingest_unavailable" });

    delete env.FACET_DESIGN_INGEST_TENANT_MAP_JSON;
    const missingMap = await worker.fetch(signedRequest(), env, {} as never);
    assert.equal(missingMap.status, 503);
    assert.deepEqual(await missingMap.json(), { error: "facet_design_ingest_unavailable" });

    assert.equal(raw.objects.size, 0);
    assert.equal(count(db, "facet_design_events"), 0);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 0);
  } finally {
    db.raw.close();
  }
});

test("Facet design ingress rejects malformed, stale, bad-signature, and cross-header events before persistence", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = testEnv(db, raw);
  try {
    const badSignature = await worker.fetch(signedRequest(EVENT, { signature: "x".repeat(43) }), env, {} as never);
    assert.equal(badSignature.status, 401);
    assert.deepEqual(await badSignature.json(), { error: "event_signature_invalid" });

    const staleTimestamp = String(Date.now() - 6 * 60 * 1_000);
    const stale = await worker.fetch(signedRequest(EVENT, { timestamp: staleTimestamp }), env, {} as never);
    assert.equal(stale.status, 401);
    assert.deepEqual(await stale.json(), { error: "event_timestamp_stale" });

    const mismatch = await worker.fetch(signedRequest(EVENT, { eventId: "facet-event-0002" }), env, {} as never);
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), { error: "event_id_mismatch" });

    const wrongType = { ...EVENT, event_type: "facet.design.draft.v1" };
    const invalidBody = await worker.fetch(signedRequest(wrongType), env, {} as never);
    assert.equal(invalidBody.status, 400);
    assert.deepEqual(await invalidBody.json(), { error: "invalid_event_body" });

    const mismatchedRevisionHash = await worker.fetch(
      signedRequest({
        ...EVENT,
        design_revision: { ...EVENT.design_revision, sha256: "a".repeat(64) },
      }),
      env,
      {} as never,
    );
    assert.equal(mismatchedRevisionHash.status, 400);
    assert.deepEqual(await mismatchedRevisionHash.json(), { error: "invalid_event_body" });

    const mismatchedRevisionId = await worker.fetch(
      signedRequest({
        ...EVENT,
        design_revision: { ...EVENT.design_revision, id: `facet-json-v1:${"b".repeat(64)}` },
      }),
      env,
      {} as never,
    );
    assert.equal(mismatchedRevisionId.status, 400);
    assert.deepEqual(await mismatchedRevisionId.json(), { error: "invalid_event_body" });

    const { design: ignoredDesign, ...frozenEvidenceWithoutDesign } = EVENT.frozen_evidence;
    void ignoredDesign;
    const missingFrozenDesign = await worker.fetch(
      signedRequest({ ...EVENT, frozen_evidence: frozenEvidenceWithoutDesign }),
      env,
      {} as never,
    );
    assert.equal(missingFrozenDesign.status, 400);
    assert.deepEqual(await missingFrozenDesign.json(), { error: "invalid_event_body" });

    const extraTopLevelField = await worker.fetch(
      signedRequest({ ...EVENT, untrusted_extension: true }),
      env,
      {} as never,
    );
    assert.equal(extraTopLevelField.status, 400);
    assert.deepEqual(await extraTopLevelField.json(), { error: "invalid_event_body" });

    assert.equal(raw.objects.size, 0);
    assert.equal(count(db, "facet_design_events"), 0);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 0);
  } finally {
    db.raw.close();
  }
});

test("Facet design ingress leaves D1 untouched when immutable R2 evidence storage fails", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  raw.failPuts = true;
  const env = testEnv(db, raw);
  try {
    const response = await worker.fetch(signedRequest(), env, {} as never);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "facet_design_ingest_unavailable" });
    assert.equal(raw.objects.size, 0);
    assert.equal(count(db, "facet_design_events"), 0);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 0);
  } finally {
    db.raw.close();
  }
});

test("Facet design ingress is disabled by default and fails closed without its dedicated key", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = testEnv(db, raw);
  try {
    env.FACET_DESIGN_INGEST_ENABLED = "false";
    const disabled = await worker.fetch(signedRequest(), env, {} as never);
    assert.equal(disabled.status, 404);
    assert.deepEqual(await disabled.json(), { error: "not_found" });

    env.FACET_DESIGN_INGEST_ENABLED = "true";
    delete env.FACET_DESIGN_INGEST_HMAC_KEY;
    const unconfigured = await worker.fetch(signedRequest(), env, {} as never);
    assert.equal(unconfigured.status, 503);
    assert.deepEqual(await unconfigured.json(), { error: "facet_design_ingest_unavailable" });
    assert.equal(raw.objects.size, 0);
    assert.equal(count(db, "facet_design_events"), 0);
    assert.equal(count(db, "facet_design_ingest_nonce_registry"), 0);
  } finally {
    db.raw.close();
  }
});
