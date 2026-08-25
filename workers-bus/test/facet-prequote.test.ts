import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  permissionsForRole,
  type AppEnv,
  type AuthContext,
} from "../src/app-types.ts";
import {
  importEstimatorEvidenceFromNativeSources,
  resolveNativeEstimatorAuthority,
} from "../src/estimator-native.ts";
import {
  canonicalJson,
  facetV2DeliverySigningInput,
  signFacetEstimatorReadyReceipt,
} from "../src/facet-design-v2-protocol.ts";
import {
  handleFacetEstimatorReadyIngest,
} from "../src/facet-prequote.ts";
import { issueFacetPrequoteLaunch } from "../src/facet-prequote.ts";

const TENANT = "ironwrap";
const SOURCE_TENANT = "22222222-2222-4222-8222-222222222222";
const OWNER = "prequote-owner-0001";
const ENVELOPE = "prequote-envelope-0001";
const LEAD = "prequote-lead-0001";
const CUSTOMER = "PREQUOTE-CUSTOMER-1";
const JOB = "prequote-roof-job-1";
const JOB_NUMBER = "IW-PREQUOTE-0001";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const MEASUREMENT_RECEIPT_ID = `measurement_${"a".repeat(64)}`;
const MEASUREMENT_ID = `measurement:${"f".repeat(64)}`;
const MEASUREMENT_RAW_KEY = `raw/measurements/${"2".repeat(64)}.json`;
const SECRET = "synthetic-facet-estimator-ready-key-longer-than-thirty-two-characters";
const KEY_ID = "facet-v2-prequote-test-key";
const KEY_VERSION = 1;
const DESTINATION_URL = "https://bus.example.invalid/ingest/facet-estimator-ready";
const ROUTE = {
  version: 1,
  issuer: "facet",
  source_product: "facet",
  source_environment: "production",
  source_tenant_id: SOURCE_TENANT,
  destination_tenant_id: TENANT,
  destination_url: DESTINATION_URL,
};
const DESIGN = {
  brandId: TENANT,
  catalogRevision: {
    schema: "facet.catalog-selection-identities.v1",
    sha256: "f".repeat(64),
  },
  facetOverrides: [],
  layers: [{
    id: "roof-layer-1",
    visible: true,
    xmlSha256: "1".repeat(64),
    xmlUtf8Bytes: 4096,
  }],
  roof: { colorId: "roof-charcoal", productId: "roof-standing-seam" },
  schema: "facet.selection-evidence.v2",
  trimAccents: [],
  uniformFinish: true,
  wall: { colorId: null, productId: null },
};

class SqliteD1 {
  readonly raw = new DatabaseSync(":memory:");

  constructor() {
    this.raw.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      this.raw.exec(readFileSync(new URL(file, directory), "utf8"));
    }
    seedOperatingCore(this.raw);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql, []);
  }

  async batch(statements: SqliteStatement[]) {
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

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
  }

  async run() {
    return this.execute();
  }

  execute() {
    const result = this.raw.prepare(this.sql).run(...this.args);
    return { success: true as const, meta: { changes: Number(result.changes) } };
  }
}

class MemoryR2 {
  readonly objects = new Map<string, { body: string; object: Record<string, unknown> }>();

  async head(key: string): Promise<Record<string, unknown> | null> {
    return this.objects.get(key)?.object ?? null;
  }

  async get(key: string): Promise<{
    size: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = new TextEncoder().encode(stored.body);
    return {
      size: bytes.byteLength,
      text: async () => stored.body,
      arrayBuffer: async () => bytes.buffer,
    };
  }

  async put(
    key: string,
    body: string,
    options: { sha256?: string; customMetadata?: Record<string, string> },
  ): Promise<Record<string, unknown>> {
    const checksum = Uint8Array.from(Buffer.from(options.sha256 ?? "", "hex"));
    const object = {
      size: new TextEncoder().encode(body).byteLength,
      checksums: {
        sha256: checksum.buffer.slice(
          checksum.byteOffset,
          checksum.byteOffset + checksum.byteLength,
        ),
      },
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, object });
    return object;
  }
}

function appEnv(db: SqliteD1, raw: MemoryR2): AppEnv {
  return {
    DB: db as never,
    RAW: raw as never,
    APP_FACET_LAUNCH_ENABLED: "true",
    APP_FACET_LAUNCH_BASE_URL: "https://facet.example.invalid/",
    APP_FACET_LAUNCH_SOURCE_TENANT_ID: SOURCE_TENANT,
    FACET_LAUNCH_HMAC_KEY: Buffer.from(SECRET).toString("base64url"),
    FACET_V2_INGEST_ENABLED: "true",
    FACET_V2_ROUTES_JSON: JSON.stringify([ROUTE]),
    FACET_V2_KEYS_JSON: JSON.stringify([{
      key_id: KEY_ID,
      key_version: KEY_VERSION,
      secret: SECRET,
      not_before_ms: Date.now() - 86_400_000,
      not_after_ms: Date.now() + 86_400_000,
    }]),
    FACET_ESTIMATOR_READY_ROUTES_JSON: JSON.stringify([ROUTE]),
  } as AppEnv;
}

function officeAuth(): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: permissionsForRole("owner"),
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2027-01-15T06:00:00.000Z",
      session_expires_at: "2027-01-15T18:00:00.000Z",
      revoked_at: null,
      user_id: OWNER,
      tenant_id: TENANT,
      email_normalized: "owner@example.invalid",
      display_name: "Prequote Owner",
      role: "owner",
      frappe_user_id: null,
      active: 1,
      created_by: "test-fixture",
      created_at: "2027-01-15T06:00:00.000Z",
      updated_at: "2027-01-15T06:00:00.000Z",
    },
  };
}

function revokeProjectRequest(projectLinkId: string, reasonCode = "project_rebound"): Request {
  return new Request("https://app.example.invalid/api/v1/facet-link-revocations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": "csrf" },
    body: JSON.stringify({
      link_kind: "project",
      link_id: projectLinkId,
      reason_code: reasonCode,
    }),
  });
}

function seedOperatingCore(db: DatabaseSync): void {
  const createdAt = "2027-01-15T06:00:00.000Z";
  db.prepare(
    `INSERT INTO app_users
     (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
      active, created_by, created_at, updated_at)
     VALUES (?, ?, 'owner@example.invalid', 'Prequote Owner', 'owner', NULL,
             1, 'test-fixture', ?, ?)`,
  ).run(OWNER, TENANT, createdAt, createdAt);
  db.prepare(
    `INSERT INTO envelopes
     (envelope_id, source, contact_name, contact_email, contact_phone, payload_json,
      raw_key, ts, status, created_at, updated_at)
     VALUES (?, 'website', 'Customer', 'customer@example.invalid', NULL, '{}',
             ?, ?, 'reconciled', ?, ?)`,
  ).run(ENVELOPE, "raw/prequote/0001.json", createdAt, createdAt, createdAt);
  db.prepare(
    `INSERT INTO operating_leads
     (lead_id, tenant_id, source_envelope_id, source_raw_key, source, contact_name,
      contact_email, contact_phone, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'website', 'Customer', 'customer@example.invalid', NULL,
             'qualified', 1, ?, ?)`,
  ).run(LEAD, TENANT, ENVELOPE, "raw/prequote/0001.json", createdAt, createdAt);
  db.prepare(
    `INSERT INTO operating_customers
     (customer_id, tenant_id, source_envelope_id, source_raw_key, display_name,
      contact_email, contact_phone, lifecycle_status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Customer', 'customer@example.invalid', NULL, 'active', 1, ?, ?)`,
  ).run(CUSTOMER, TENANT, ENVELOPE, "raw/prequote/0001.json", createdAt, createdAt);
  db.prepare(
    `INSERT INTO operating_roof_jobs
     (roof_job_id, tenant_id, lead_id, customer_id, property_id,
      source_envelope_id, source_raw_key, brand, job_number, service_type, job_status,
      current_gate_state, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, 'ironwrap', ?, 'roof_replacement', 'qualified',
             'qualification', 1, ?, ?)`,
  ).run(
    JOB,
    TENANT,
    LEAD,
    CUSTOMER,
    ENVELOPE,
    "raw/prequote/0001.json",
    JOB_NUMBER,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO measurement_intake_receipts
     (receipt_id, idempotency_key_hash, payload_hash, key_strategy, measurement_id,
      provider, job_number, raw_key, content_type, status, lease_token, lease_expires_at,
      attempts, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, 'payload_hash', ?, 'AppliCad', ?, ?, 'application/json',
             'matched', NULL, NULL, 1, ?, ?, ?)`,
  ).run(
    MEASUREMENT_RECEIPT_ID,
    "1".repeat(64),
    "0".repeat(64),
    MEASUREMENT_ID,
    JOB_NUMBER,
    MEASUREMENT_RAW_KEY,
    createdAt,
    createdAt,
    createdAt,
  );
  db.prepare(
    `INSERT INTO measurement_deltas
     (receipt_id, measurement_id, job_number, provider, source, check_name, metric,
      ok, primary_value, independent_value, rel_diff, abs_diff, detail, created_at,
      tenant_id, error_kind, signed_error)
     VALUES (?, ?, ?, 'AppliCad', 'google_solar', 'solar_area', 'roof_area',
             1, 100, 100, 0, NULL, 'within tolerance', ?, ?,
             'relative_fraction', 0)`,
  ).run(
    MEASUREMENT_RECEIPT_ID,
    MEASUREMENT_ID,
    JOB_NUMBER,
    createdAt,
    TENANT,
  );
}

async function readyEvent(
  db: SqliteD1,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const link = db.raw.prepare(
    `SELECT external_project_link_id, producer_identity_link_id, facet_project_id
       FROM facet_v2_prequote_project_links LIMIT 1`,
  ).get() as Record<string, string>;
  const occurredAt = typeof overrides.occurred_at === "string"
    ? overrides.occurred_at
    : "2027-01-15T08:00:00.000Z";
  const designSha256 = sha256(canonicalJson(DESIGN));
  const frozenEvidence = {
    estimator_ready: { ready_at: occurredAt },
    design: DESIGN,
  };
  return {
    brand_id: TENANT,
    design_revision: { id: `facet-json-v1:${designSha256}`, sha256: designSha256 },
    destination: { tenant_id: TENANT },
    event_id: "55555555-5555-4555-8555-555555555555",
    event_type: "facet.design.estimator_ready.v1",
    facet_project_id: link.facet_project_id,
    frozen_evidence: frozenEvidence,
    occurred_at: occurredAt,
    operator_attestation: {
      actor: {
        actor_type: "owner",
        identity_assurance: "oidc",
        oidc_issuer: "https://accounts.google.com",
        oidc_subject_sha256: "b".repeat(64),
      },
      attestation_version: "facet-estimator-ready-operator-v1",
    },
    previous_event_id: null,
    project_link: {
      external_project_link_id: link.external_project_link_id,
      producer_identity_link_id: link.producer_identity_link_id,
    },
    schema_version: 1,
    source: {
      environment: "production",
      issuer: "facet",
      product: "facet",
      tenant_id: SOURCE_TENANT,
    },
    ...overrides,
  };
}

function signedRequest(
  body: Record<string, unknown>,
  nonce: string,
  options: { destinationUrl?: string } = {},
): Request {
  const raw = canonicalJson(body);
  const bodySha256 = sha256(raw);
  const issuedAt = Date.now() - 1_000;
  const expiresAt = Date.now() + 60_000;
  const eventId = String(body.event_id);
  const signature = createHmac("sha256", SECRET).update(
    facetV2DeliverySigningInput({
      destinationOrigin: "https://bus.example.invalid",
      destinationPath: "/ingest/facet-estimator-ready",
      issuer: ROUTE.issuer,
      product: ROUTE.source_product,
      environment: ROUTE.source_environment,
      destinationTenantId: ROUTE.destination_tenant_id,
      keyId: KEY_ID,
      keyVersion: KEY_VERSION,
      eventId,
      issuedAt: String(issuedAt),
      expiresAt: String(expiresAt),
      nonce,
      bodySha256,
    }),
  ).digest("base64url");
  return new Request(options.destinationUrl ?? DESTINATION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-event-body-sha256": bodySha256,
      "x-ironwrap-event-destination-tenant-id": TENANT,
      "x-ironwrap-event-environment": ROUTE.source_environment,
      "x-ironwrap-event-expires-at": String(expiresAt),
      "x-ironwrap-event-id": eventId,
      "x-ironwrap-event-issued-at": String(issuedAt),
      "x-ironwrap-event-issuer": ROUTE.issuer,
      "x-ironwrap-event-key-id": KEY_ID,
      "x-ironwrap-event-key-version": String(KEY_VERSION),
      "x-ironwrap-event-nonce": nonce,
      "x-ironwrap-event-product": ROUTE.source_product,
      "x-ironwrap-event-signature": signature,
    },
    body: raw,
  });
}

function count(db: SqliteD1, table: string): number {
  return Number((db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("estimator-ready ingest accepts only the separate prequote authority and replays its receipt", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = appEnv(db, raw);
  try {
    const launch = await issueFacetPrequoteLaunch(env, {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-prequote:ingest-0001",
      projectId: PROJECT,
      now: new Date("2027-01-15T07:00:00.000Z"),
    });
    assert.equal(launch.kind, "created");
    const body = await readyEvent(db);
    const first = await handleFacetEstimatorReadyIngest(
      signedRequest(body, "first-estimator-ready-nonce-000001"),
      env,
    );
    assert.equal(first.status, 202);
    const firstJson = await first.json() as Record<string, unknown>;
    assert.equal((firstJson.receipt as Record<string, unknown>).result, "accepted");
    assert.deepEqual(
      (firstJson.receipt as Record<string, unknown>).operator_attestation,
      {
        actor_type: "owner",
        identity_assurance: "oidc",
        oidc_issuer: "https://accounts.google.com",
        oidc_subject_sha256: "b".repeat(64),
      },
    );
    assert.equal(count(db, "facet_v2_estimator_ready_events"), 1);
    assert.equal(count(db, "facet_v2_estimator_ready_nonces"), 1);
    assert.equal(count(db, "facet_v2_estimator_ready_receipts"), 1);
    assert.equal(count(db, "facet_v2_customer_decisions"), 0);
    assert.equal(count(db, "facet_v2_projection_attempts"), 0);
    assert.equal(count(db, "estimator_evidence_revisions"), 0);
    assert.equal(raw.objects.size, 1);
    const firstActor = db.raw.prepare(
      `SELECT actor_identity_ref, actor_type, oidc_issuer, oidc_subject_sha256
         FROM facet_v2_estimator_ready_events WHERE event_id = ?`,
    ).get(body.event_id) as Record<string, string>;
    assert.equal(firstActor.actor_type, "owner");
    assert.equal(
      firstActor.actor_identity_ref,
      `facet-actor-oidc-v1:${sha256("https://accounts.google.com\n" + "b".repeat(64))}`,
    );

    const replay = await handleFacetEstimatorReadyIngest(
      signedRequest(body, "second-estimator-ready-nonce-00002"),
      env,
    );
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), firstJson);
    assert.equal(count(db, "facet_v2_estimator_ready_nonces"), 2);
    assert.equal(count(db, "facet_v2_estimator_ready_receipts"), 1);

    const nonMonotonic = await handleFacetEstimatorReadyIngest(
      signedRequest(await readyEvent(db, {
        event_id: "abababab-abab-4aba-8aba-abababababab",
        previous_event_id: body.event_id,
      }), "non-monotonic-estimator-ready-nonce"),
      env,
    );
    assert.equal(nonMonotonic.status, 409);
    const nonMonotonicJson = await nonMonotonic.json() as Record<string, unknown>;
    assert.equal(
      (nonMonotonicJson.receipt as Record<string, unknown>).detail_code,
      "estimator_ready_time_not_monotonic",
    );
    assert.equal(
      ((nonMonotonicJson.receipt as Record<string, unknown>).operator_attestation as Record<string, unknown>)
        .identity_assurance,
      "oidc",
    );

    const rawKeysBeforeNonceConflict = [...raw.objects.keys()].sort();
    const nonceBodyConflict = await handleFacetEstimatorReadyIngest(
      signedRequest(
        await readyEvent(db, {
          event_id: body.event_id,
          facet_project_id: "66666666-6666-4666-8666-666666666666",
        }),
        "first-estimator-ready-nonce-000001",
      ),
      env,
    );
    assert.equal(nonceBodyConflict.status, 409);
    assert.deepEqual(await nonceBodyConflict.json(), { error: "event_nonce_conflict" });
    assert.deepEqual([...raw.objects.keys()].sort(), rawKeysBeforeNonceConflict);

    const rawKeysBeforeEventBodyConflict = [...raw.objects.keys()].sort();
    const eventBodyConflict = await handleFacetEstimatorReadyIngest(
      signedRequest(
        await readyEvent(db, {
          event_id: body.event_id,
          facet_project_id: "77777777-7777-4777-8777-777777777777",
        }),
        "event-id-body-conflict-estimator-ready-nonce",
      ),
      env,
    );
    assert.equal(eventBodyConflict.status, 409);
    assert.deepEqual(await eventBodyConflict.json(), { error: "event_id_body_conflict" });
    assert.deepEqual([...raw.objects.keys()].sort(), rawKeysBeforeEventBodyConflict);

    const secondBody = await readyEvent(db, {
      event_id: "66666666-6666-4666-8666-666666666666",
      previous_event_id: body.event_id,
      occurred_at: "2027-01-15T08:01:00.000Z",
      operator_attestation: {
        actor: {
          actor_type: "expert",
          identity_assurance: "oidc",
          oidc_issuer: "https://accounts.google.com",
          oidc_subject_sha256: "b".repeat(64),
        },
        attestation_version: "facet-estimator-ready-operator-v1",
      },
    });
    const second = await handleFacetEstimatorReadyIngest(
      signedRequest(secondBody, "third-estimator-ready-nonce-00003"),
      env,
    );
    assert.equal(second.status, 202);
    const secondActor = db.raw.prepare(
      `SELECT actor_type FROM facet_v2_estimator_ready_events WHERE event_id = ?`,
    ).get(secondBody.event_id) as { actor_type: string };
    assert.equal(secondActor.actor_type, "expert");
    const thirdBody = await readyEvent(db, {
      event_id: "77777777-7777-4777-8777-777777777777",
      previous_event_id: String(secondBody.event_id),
      occurred_at: "2027-01-15T08:02:00.000Z",
    });
    const third = await handleFacetEstimatorReadyIngest(
      signedRequest(thirdBody, "fourth-estimator-ready-nonce-00004"),
      env,
    );
    assert.equal(third.status, 202);
    const staleInitial = await handleFacetEstimatorReadyIngest(
      signedRequest(await readyEvent(db, {
        event_id: "88888888-8888-4888-8888-888888888888",
      }), "stale-initial-estimator-ready-nonce"),
      env,
    );
    assert.equal(staleInitial.status, 409);

    const nonceConflict = await handleFacetEstimatorReadyIngest(
      signedRequest(await readyEvent(db, {
        event_id: "99999999-9999-4999-8999-999999999999",
      }), "second-estimator-ready-nonce-00002"),
      env,
    );
    assert.equal(nonceConflict.status, 409);
    assert.deepEqual(await nonceConflict.json(), { error: "event_nonce_conflict" });

    const actorMismatch = await handleFacetEstimatorReadyIngest(
      signedRequest(await readyEvent(db, {
        event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        operator_attestation: {
          actor: {
            actor_type: "owner",
            identity_assurance: "oidc",
            oidc_issuer: "https://issuer.attacker.invalid",
            oidc_subject_sha256: "c".repeat(64),
          },
          attestation_version: "facet-estimator-ready-operator-v1",
        },
      }), "actor-mismatch-estimator-ready-nonce"),
      env,
    );
    assert.equal(actorMismatch.status, 400);
    assert.deepEqual(await actorMismatch.json(), { error: "invalid_event_body" });
    const producerClaimsIronwrapIds = await handleFacetEstimatorReadyIngest(
      signedRequest(await readyEvent(db, {
        event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        roof_job_id: JOB,
        customer_id: CUSTOMER,
      }), "producer-claims-ironwrap-ids-nonce"),
      env,
    );
    assert.equal(producerClaimsIronwrapIds.status, 400);
    assert.deepEqual(await producerClaimsIronwrapIds.json(), { error: "invalid_event_body" });
    assert.equal(count(db, "facet_v2_customer_decisions"), 0);
    assert.equal(count(db, "facet_v2_projection_attempts"), 0);
    assert.equal(count(db, "estimator_evidence_revisions"), 0);
  } finally {
    db.raw.close();
  }
});

test("estimator-ready receipt validation requires the OIDC identity assurance field", async () => {
  const receipt = {
    schema: "ironwrap.facet-estimator-ready-receipt.v1",
    receipt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    event_body_sha256: "c".repeat(64),
    frozen_evidence_sha256: "d".repeat(64),
    design_revision: { id: `facet-json-v1:${"e".repeat(64)}`, sha256: "e".repeat(64) },
    operator_attestation: {
      actor_type: "owner",
      identity_assurance: "oidc",
      oidc_issuer: "https://accounts.google.com",
      oidc_subject_sha256: "f".repeat(64),
    },
    destination_tenant_id: "ironwrap",
    result: "accepted",
    policy_version: "facet-estimator-ready-test-v1",
    occurred_at: "2027-01-15T08:00:00.000Z",
    detail_code: "exact_prequote_project_association_verified",
    idempotent_replay: false,
  } as const;
  const key = {
    keyId: KEY_ID,
    keyVersion: KEY_VERSION,
    secret: SECRET,
  };
  await signFacetEstimatorReadyReceipt(receipt, key);
  const missingAssurance = {
    ...receipt,
    operator_attestation: {
      actor_type: receipt.operator_attestation.actor_type,
      oidc_issuer: receipt.operator_attestation.oidc_issuer,
      oidc_subject_sha256: receipt.operator_attestation.oidc_subject_sha256,
    },
  };
  await assert.rejects(
    () => signFacetEstimatorReadyReceipt(missingAssurance as never, key),
    /facet_estimator_ready_receipt_invalid/,
  );
});

test("estimator-ready ingest rejects route drift, association drift, and revoked authority", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = appEnv(db, raw);
  try {
    const launch = await issueFacetPrequoteLaunch(env, {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-prequote:ingest-rejections-0001",
      projectId: PROJECT,
      now: new Date("2027-01-15T07:00:00.000Z"),
    });
    assert.equal(launch.kind, "created");
    const routeDrift = await handleFacetEstimatorReadyIngest(
      signedRequest(
        await readyEvent(db, {
          event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
        "route-drift-estimator-ready-nonce",
        { destinationUrl: "https://bus.example.invalid/ingest/wrong" },
      ),
      env,
    );
    assert.equal(routeDrift.status, 403);
    assert.deepEqual(await routeDrift.json(), { error: "event_route_untrusted" });

    const associationDrift = await handleFacetEstimatorReadyIngest(
      signedRequest(
        await readyEvent(db, {
          event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          facet_project_id: "66666666-6666-4666-8666-666666666666",
        }),
        "association-drift-estimator-ready-nonce",
      ),
      env,
    );
    assert.equal(associationDrift.status, 409);
    const associationReceipt = await associationDrift.json() as Record<string, unknown>;
    assert.equal((associationReceipt.receipt as Record<string, unknown>).result, "rejected");
    assert.equal(
      (associationReceipt.receipt as Record<string, unknown>).detail_code,
      "estimator_ready_association_mismatch",
    );
    const associationRow = db.raw.prepare(
      `SELECT roof_job_id, customer_id, result
         FROM facet_v2_estimator_ready_events
        WHERE event_id = ?`,
    ).get("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") as {
      roof_job_id: string | null;
      customer_id: string | null;
      result: string;
    };
    assert.equal(associationRow.roof_job_id, null);
    assert.equal(associationRow.customer_id, null);
    assert.equal(associationRow.result, "rejected");

    const link = db.raw.prepare(
      `SELECT external_project_link_id FROM facet_v2_prequote_project_links LIMIT 1`,
    ).get() as { external_project_link_id: string };
    const revocation = await handleAuthenticatedRoute(
      revokeProjectRequest(link.external_project_link_id, "project_rebound"),
      env,
      officeAuth(),
    );
    assert.equal(revocation.status, 201);
    const revoked = await handleFacetEstimatorReadyIngest(
      signedRequest(
        await readyEvent(db, {
          event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        }),
        "revoked-estimator-ready-nonce-0001",
      ),
      env,
    );
    assert.equal(revoked.status, 409);
    const revokedReceipt = await revoked.json() as Record<string, unknown>;
    assert.equal((revokedReceipt.receipt as Record<string, unknown>).result, "rejected");
    assert.equal(
      (revokedReceipt.receipt as Record<string, unknown>).detail_code,
      "estimator_ready_association_revoked",
    );
    assert.equal(count(db, "facet_v2_customer_decisions"), 0);
    assert.equal(count(db, "facet_v2_estimator_ready_events"), 2);
  } finally {
    db.raw.close();
  }
});

test("native estimator import binds estimator-ready evidence without a quote and fails stale or revoked anchors", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const env = appEnv(db, raw);
  try {
    const launch = await issueFacetPrequoteLaunch(env, {
      tenantId: TENANT,
      jobName: JOB,
      actorUserId: OWNER,
      actorRole: "owner",
      idempotencyKey: "facet-prequote:estimator-import-0001",
      projectId: PROJECT,
      now: new Date("2027-01-15T07:00:00.000Z"),
    });
    assert.equal(launch.kind, "created");
    const body = await readyEvent(db);
    const accepted = await handleFacetEstimatorReadyIngest(
      signedRequest(body, "estimator-import-ready-nonce-000001"),
      env,
    );
    assert.equal(accepted.status, 202);

    const measurementSource = JSON.stringify({
      job_number: JOB_NUMBER,
      source_xml: [
        "<APPLICAD_EXPORT>",
        '<POINT id="P1" data="0,0,0"/>',
        '<POINT id="P2" data="10,0,0"/>',
        '<POINT id="P3" data="10,10,0"/>',
        '<POINT id="P4" data="0,10,0"/>',
        '<LINE id="L1" path="P1,P2" type="EAVE" length="10"/>',
        '<LINE id="L2" path="P2,P3" type="RIDGE" length="10"/>',
        '<LINE id="L3" path="P3,P4" type="EAVE" length="10"/>',
        '<LINE id="L4" path="P4,P1" type="EAVE" length="10"/>',
        '<POLYGON id="F1" path="L1,L2,L3,L4" type="Roof" size="100" mat="Metal"/>',
        "</APPLICAD_EXPORT>",
      ].join(""),
    });
    const measurementSha256 = sha256(measurementSource);
    await raw.put(MEASUREMENT_RAW_KEY, measurementSource, { sha256: measurementSha256 });
    db.raw.prepare(
      `UPDATE measurement_intake_receipts
          SET payload_hash = ?, raw_key = ?
        WHERE receipt_id = ?`,
    ).run(measurementSha256, MEASUREMENT_RAW_KEY, MEASUREMENT_RECEIPT_ID);

    const importInput = {
      tenantId: TENANT,
      roofJobId: JOB,
      measurementReceiptId: MEASUREMENT_RECEIPT_ID,
      estimatorReadyEventId: String(body.event_id),
      commercialQuoteRevisionId: null,
      revisionNumber: 1,
      importedByUserId: OWNER,
      idempotencyKey: "estimator-ready-import-0000001",
    };
    const imported = await importEstimatorEvidenceFromNativeSources(
      env,
      importInput,
      new Date("2027-01-15T08:05:00.000Z"),
    );
    assert.equal(imported.kind, "created");
    assert.equal(imported.revision.estimator_ready_event_id, body.event_id);
    assert.equal(imported.revision.commercial_quote_revision_id, null);
    assert.equal(
      imported.revision.estimator_ready_raw_sha256,
      sha256(canonicalJson(body)),
    );
    const authority = await resolveNativeEstimatorAuthority(env, TENANT, JOB);
    assert.equal(authority.state, "current");
    if (authority.state === "current") {
      assert.equal(authority.revision.estimator_ready_event_id, body.event_id);
      assert.equal(authority.revision.commercial_quote_revision_id, null);
    }

    const nextBody = await readyEvent(db, {
      event_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      previous_event_id: body.event_id,
      occurred_at: "2027-01-15T08:01:00.000Z",
    });
    const nextAccepted = await handleFacetEstimatorReadyIngest(
      signedRequest(nextBody, "estimator-import-ready-nonce-000002"),
      env,
    );
    assert.equal(nextAccepted.status, 202);
    await assert.rejects(
      () => importEstimatorEvidenceFromNativeSources(env, {
        ...importInput,
        estimatorReadyEventId: String(body.event_id),
        idempotencyKey: "estimator-ready-import-stale-000001",
      }, new Date("2027-01-15T08:06:00.000Z")),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "estimator_ready_head_mismatch");
        return true;
      },
    );

    const link = db.raw.prepare(
      `SELECT external_project_link_id FROM facet_v2_prequote_project_links LIMIT 1`,
    ).get() as { external_project_link_id: string };
    db.raw.prepare(
      `INSERT INTO facet_v2_link_revocations
       (revocation_id, link_kind, link_id, reason_code, revoked_by_user_id,
        destination_tenant_id, revoked_at)
       VALUES (?, 'project', ?, 'test_revocation', ?, ?, ?)`,
    ).run(
      "revocation:estimator-import-project-0001",
      link.external_project_link_id,
      OWNER,
      TENANT,
      "2027-01-15T08:07:00.000Z",
    );
    await assert.rejects(
      () => importEstimatorEvidenceFromNativeSources(env, {
        ...importInput,
        estimatorReadyEventId: String(nextBody.event_id),
        idempotencyKey: "estimator-ready-import-revoked-0001",
      }, new Date("2027-01-15T08:08:00.000Z")),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "estimator_ready_head_mismatch");
        return true;
      },
    );
  } finally {
    db.raw.close();
  }
});
