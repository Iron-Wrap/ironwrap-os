import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  canonicalJson,
  facetV2DeliverySigningInput,
  facetV2ReceiptSigningInput,
  type FacetV2CustomerDecisionEvent,
  type SignedFacetV2Receipt,
} from "../src/facet-design-v2-protocol.ts";
import {
  handleFacetDesignIngest,
  reconcileFacetV2UnassociatedIntakes,
} from "../src/facet-design-ingest.ts";
import {
  facetV2ExternalLinkIds,
  registerFacetV2AuthorityLink,
  type FacetV2AuthorityRegistration,
} from "../src/facet-v2-authority.ts";
import worker from "../src/index.ts";

const NOW = Date.now();
const DESTINATION_URL = "https://bus.example.invalid/ingest/facet-design";
const SECRET = "synthetic-facet-v2-ingest-key-longer-than-thirty-two-characters";
const SOURCE_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_PARTY_REF = "a".repeat(64);
const OIDC_SUBJECT_SHA256 = "b".repeat(64);
const EXTERNAL_CUSTOMER_IDENTITY_LINK = `facet-customer-oidc-v1:${"9".repeat(64)}`;
const USER_ID = "owner-user-0001";
const ROUTE = {
  version: 1,
  issuer: "facet",
  source_product: "facet",
  source_environment: "production",
  source_tenant_id: SOURCE_TENANT_ID,
  destination_tenant_id: "ironwrap",
  destination_url: DESTINATION_URL,
};
const KEY = {
  key_id: "facet-v2-test-key",
  key_version: 3,
  secret: SECRET,
  not_before_ms: NOW - 86_400_000,
  not_after_ms: NOW + 86_400_000,
};
const ROTATED_SECRET = "synthetic-facet-v2-rotated-key-longer-than-thirty-two-characters";
const ROTATED_KEY = {
  key_id: KEY.key_id,
  key_version: KEY.key_version + 1,
  secret: ROTATED_SECRET,
  not_before_ms: NOW - 1_000,
  not_after_ms: NOW + 172_800_000,
};
const DESIGN = {
  brandId: "ironwrap",
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
    this.raw.exec(readFileSync(new URL("../migrations/0011_app_bff_auth.sql", import.meta.url), "utf8"));
    this.raw.exec(readFileSync(new URL("../migrations/0043_facet_v2_signed_identity.sql", import.meta.url), "utf8"));
    this.raw.prepare(
      `INSERT INTO app_users
       (user_id, tenant_id, email_normalized, display_name, role, frappe_user_id,
        active, created_by, created_at, updated_at)
       VALUES (?, 'ironwrap', 'owner@example.invalid', 'Synthetic Owner', 'owner', NULL,
               1, 'test-fixture', ?, ?)`,
    ).run(USER_ID, iso(NOW - 60_000), iso(NOW - 60_000));
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

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.raw.prepare(this.sql).all(...this.args) as T[] };
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
  beforePut: (() => void) | null = null;
  failPuts = false;

  async head(key: string): Promise<Record<string, unknown> | null> {
    return this.objects.get(key)?.object ?? null;
  }

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const stored = this.objects.get(key);
    return stored ? { text: async () => stored.body } : null;
  }

  async put(
    key: string,
    body: string,
    options: { sha256?: string; customMetadata?: Record<string, string>; onlyIf?: unknown },
  ): Promise<Record<string, unknown> | null> {
    if (this.failPuts) throw new Error("synthetic_r2_failure");
    this.beforePut?.();
    if (this.objects.has(key) && options.onlyIf) return null;
    const checksum = Uint8Array.from(Buffer.from(options.sha256 ?? "", "hex"));
    const object = {
      size: new TextEncoder().encode(body).byteLength,
      checksums: {
        sha256: checksum.buffer.slice(checksum.byteOffset, checksum.byteOffset + checksum.byteLength),
      },
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, object });
    return object;
  }
}

function env(db = new SqliteD1(), raw = new MemoryR2()): Env {
  return {
    DB: db as never,
    RAW: raw as never,
    APP_TENANT_ID: "ironwrap",
    FACET_V2_INGEST_ENABLED: "true",
    FACET_V2_ROUTES_JSON: JSON.stringify([ROUTE]),
    FACET_V2_KEYS_JSON: JSON.stringify([KEY]),
    FACET_DESIGN_INGEST_ENABLED: "false",
    APP_IRONWRAP_LEGACY_V1_DESIGN_EVENTS_ENABLED: "false",
  } as Env;
}

function authorityInput(overrides: Partial<FacetV2AuthorityRegistration> = {}): FacetV2AuthorityRegistration {
  return {
    destinationTenantId: "ironwrap",
    sourceTenantId: SOURCE_TENANT_ID,
    issuer: "facet",
    sourceEnvironment: "production",
    brandId: "ironwrap",
    facetProjectId: PROJECT_ID,
    producerIdentityProofSha256: "2".repeat(64),
    projectClaimSha256: "3".repeat(64),
    customerPartyRef: CUSTOMER_PARTY_REF,
    externalCustomerIdentityLinkId: EXTERNAL_CUSTOMER_IDENTITY_LINK,
    roofJobId: "ROOF-JOB-0001",
    customerQuoteId: "CUSTOMER-QUOTE-0001",
    createdByUserId: USER_ID,
    createdAt: iso(NOW - 30_000),
    ...overrides,
  };
}

async function event(
  registration = authorityInput(),
  overrides: {
    eventId?: string;
    occurredAt?: string;
    decision?: "approved" | "corrected" | "superseded" | "withdrawn";
    previousEventId?: string | null;
    reasonSha256?: string | null;
    receiptId?: string;
    receiptSha256?: string;
    oidcIssuer?: string;
    oidcSubjectSha256?: string;
    extraFrozenApproval?: Record<string, unknown>;
  } = {},
): Promise<FacetV2CustomerDecisionEvent & Record<string, unknown>> {
  const links = await facetV2ExternalLinkIds(registration);
  const occurredAt = overrides.occurredAt ?? "2027-01-15T08:00:00.000Z";
  const frozenEvidence = {
    approval: {
      approved_at: occurredAt,
      client_revision: { roofColorId: "roof-charcoal", wallColorId: null },
      ...overrides.extraFrozenApproval,
    },
    design: DESIGN,
  };
  const designSha256 = sha256(canonicalJson(DESIGN));
  return {
    approval: {
      actor: {
        customer_party_ref: registration.customerPartyRef,
        external_identity_link_id: registration.externalCustomerIdentityLinkId,
        identity_assurance: "oidc",
        oidc_issuer: overrides.oidcIssuer ?? "https://accounts.google.com",
        oidc_subject_sha256: overrides.oidcSubjectSha256 ?? OIDC_SUBJECT_SHA256,
      },
      attestation_version: "facet-customer-approval-v1",
      decision: overrides.decision ?? "approved",
      manifest_sha256: sha256(canonicalJson(frozenEvidence)),
      previous_event_id: overrides.previousEventId ?? null,
      reason_sha256: overrides.reasonSha256 ?? null,
      receipt_id: overrides.receiptId ?? "33333333-3333-4333-8333-333333333333",
      receipt_sha256: overrides.receiptSha256 ?? "d".repeat(64),
    },
    brand_id: registration.brandId,
    design_revision: { id: `facet-json-v1:${designSha256}`, sha256: designSha256 },
    destination: { tenant_id: registration.destinationTenantId },
    event_id: overrides.eventId ?? "44444444-4444-4444-8444-444444444444",
    event_type: "facet.design.customer_approved.v2",
    facet_project_id: registration.facetProjectId,
    frozen_evidence: frozenEvidence,
    occurred_at: occurredAt,
    project_link: {
      external_project_link_id: links.externalProjectLinkId,
      producer_identity_link_id: links.producerIdentityLinkId,
    },
    schema_version: 2,
    source: {
      environment: registration.sourceEnvironment,
      issuer: registration.issuer,
      product: "facet",
      tenant_id: registration.sourceTenantId,
    },
  } as FacetV2CustomerDecisionEvent & Record<string, unknown>;
}

function request(
  body: Record<string, unknown>,
  options: {
    nonce?: string;
    eventId?: string;
    issuedAt?: number;
    expiresAt?: number;
    secret?: string;
    keyId?: string;
    keyVersion?: number;
    destinationUrl?: string;
  } = {},
): Request {
  const raw = canonicalJson(body);
  return signedRawRequest(raw, options.eventId ?? String(body.event_id), options);
}

function signedRawRequest(
  raw: string,
  eventId: string,
  options: {
    nonce?: string;
    issuedAt?: number;
    expiresAt?: number;
    secret?: string;
    keyId?: string;
    keyVersion?: number;
    destinationUrl?: string;
  } = {},
): Request {
  const bodySha256 = sha256(raw);
  const issuedAt = options.issuedAt ?? NOW - 1_000;
  const expiresAt = options.expiresAt ?? NOW + 119_000;
  const nonce = options.nonce ?? "0123456789abcdefghijklmnopqrstuv";
  const keyId = options.keyId ?? KEY.key_id;
  const keyVersion = options.keyVersion ?? KEY.key_version;
  const destinationUrl = options.destinationUrl ?? DESTINATION_URL;
  const destination = new URL(destinationUrl);
  const signature = createHmac("sha256", options.secret ?? SECRET).update(
    facetV2DeliverySigningInput({
      destinationOrigin: destination.origin,
      destinationPath: destination.pathname,
      issuer: ROUTE.issuer,
      product: ROUTE.source_product,
      environment: ROUTE.source_environment,
      destinationTenantId: ROUTE.destination_tenant_id,
      keyId,
      keyVersion,
      eventId,
      issuedAt: String(issuedAt),
      expiresAt: String(expiresAt),
      nonce,
      bodySha256,
    }),
  ).digest("base64url");
  return new Request(destinationUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-event-body-sha256": bodySha256,
      "x-ironwrap-event-destination-tenant-id": ROUTE.destination_tenant_id,
      "x-ironwrap-event-environment": ROUTE.source_environment,
      "x-ironwrap-event-expires-at": String(expiresAt),
      "x-ironwrap-event-id": eventId,
      "x-ironwrap-event-issued-at": String(issuedAt),
      "x-ironwrap-event-issuer": ROUTE.issuer,
      "x-ironwrap-event-key-id": keyId,
      "x-ironwrap-event-key-version": String(keyVersion),
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

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function receipt(response: Response): Promise<SignedFacetV2Receipt> {
  return await response.json() as SignedFacetV2Receipt;
}

function assertReceiptSignedWith(
  signed: SignedFacetV2Receipt,
  key: { key_id: string; key_version: number; secret: string },
): void {
  assert.equal(signed.signature.key_id, key.key_id);
  assert.equal(signed.signature.key_version, key.key_version);
  assert.equal(signed.receipt_sha256, sha256(canonicalJson(signed.receipt)));
  assert.equal(
    signed.signature.value,
    createHmac("sha256", key.secret)
      .update(facetV2ReceiptSigningInput(signed.receipt_sha256))
      .digest("base64url"),
  );
}

test("accepts only a signed v2 OIDC decision with both static route and durable exact authority", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  raw.beforePut = () => {
    assert.equal(count(db, "facet_v2_raw_intakes"), 0);
    assert.equal(count(db, "facet_v2_customer_decisions"), 0);
    assert.equal(count(db, "facet_v2_consumer_receipts"), 0);
  };
  const registration = authorityInput();
  const authority = await registerFacetV2AuthorityLink(env(db, raw), registration);
  const body = await event(registration);
  const response = await handleFacetDesignIngest(request(body), env(db, raw));
  assert.equal(response.status, 202);
  const signed = await receipt(response);
  assert.equal(signed.receipt.result, "accepted_associated");
  assert.equal(signed.receipt.actor_identity_assurance, "oidc");
  assert.equal(signed.signature.key_id, KEY.key_id);
  assert.equal(count(db, "facet_v2_raw_intakes"), 1);
  assert.equal(count(db, "facet_v2_customer_decisions"), 1);
  assert.equal(count(db, "facet_v2_consumer_receipts"), 1);
  assert.equal(raw.objects.size, 1);
  const stored = db.raw.prepare(
    `SELECT external_project_link_id, producer_identity_link_id, association_sha256,
            roof_job_id, customer_quote_id, identity_assurance
       FROM facet_v2_customer_decisions WHERE event_id = ?`,
  ).get(body.event_id) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, {
    external_project_link_id: authority.externalProjectLinkId,
    producer_identity_link_id: authority.producerIdentityLinkId,
    association_sha256: authority.associationSha256,
    roof_job_id: registration.roofJobId,
    customer_quote_id: registration.customerQuoteId,
    identity_assurance: "oidc",
  });
});

test("returns a current-key duplicate receipt and exactly replays that receipt for a lost response", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const testEnv = env(db, raw);
  const registration = authorityInput();
  await registerFacetV2AuthorityLink(testEnv, registration);
  const body = await event(registration);
  const first = await receipt(await handleFacetDesignIngest(request(body), testEnv));
  const duplicate = await receipt(await handleFacetDesignIngest(
    request(body, { nonce: "1123456789abcdefghijklmnopqrstuv" }), testEnv,
  ));
  assert.equal(first.receipt.result, "accepted_associated");
  assert.equal(duplicate.receipt.result, "duplicate");
  assert.equal(duplicate.receipt.idempotent_replay, true);
  assertReceiptSignedWith(duplicate, KEY);
  const sameNonce = await receipt(await handleFacetDesignIngest(
    request(body, { nonce: "1123456789abcdefghijklmnopqrstuv" }), testEnv,
  ));
  assert.deepEqual(sameNonce, duplicate);
  assert.equal(raw.objects.size, 1);
  assert.equal(count(db, "facet_v2_raw_intakes"), 2);
  assert.equal(count(db, "facet_v2_customer_decisions"), 1);
  assert.equal(count(db, "facet_v2_consumer_receipts"), 2);
  const conflicting = await event(registration, {
    eventId: "55555555-5555-4555-8555-555555555555",
    receiptId: "66666666-6666-4666-8666-666666666666",
    receiptSha256: "e".repeat(64),
  });
  const conflict = await handleFacetDesignIngest(
    request(conflicting, { nonce: "1123456789abcdefghijklmnopqrstuv" }), testEnv,
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "event_nonce_conflict" });
});

test("key rotation signs exact duplicate responses with the current request key and revokes the old key", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const testEnv = env(db, raw);
  const registration = authorityInput();
  await registerFacetV2AuthorityLink(testEnv, registration);
  const body = await event(registration);
  const accepted = await receipt(await handleFacetDesignIngest(request(body), testEnv));
  assertReceiptSignedWith(accepted, KEY);

  testEnv.FACET_V2_KEYS_JSON = JSON.stringify([ROTATED_KEY]);
  const rotatedResponse = await handleFacetDesignIngest(request(body, {
    nonce: "rotated-current-key-nonce-000001",
    keyVersion: ROTATED_KEY.key_version,
    secret: ROTATED_KEY.secret,
  }), testEnv);
  assert.equal(rotatedResponse.status, 200);
  const rotated = await receipt(rotatedResponse);
  assert.equal(rotated.receipt.result, "duplicate");
  assert.equal(rotated.receipt.idempotent_replay, true);
  assertReceiptSignedWith(rotated, ROTATED_KEY);

  const revokedBody = await event(registration, {
    eventId: "55555555-5555-4555-8555-555555555555",
    receiptId: "66666666-6666-4666-8666-666666666666",
    receiptSha256: "e".repeat(64),
  });
  const revoked = await handleFacetDesignIngest(request(revokedBody, {
    nonce: "v".repeat(32),
  }), testEnv);
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), { error: "event_key_unknown" });
  assert.equal(raw.objects.size, 1);
  assert.deepEqual(
    db.raw.prepare(
      `SELECT signature_key_version FROM facet_v2_consumer_receipts ORDER BY rowid`,
    ).all().map((row) => ({ ...row })),
    [{ signature_key_version: KEY.key_version }, { signature_key_version: ROTATED_KEY.key_version }],
  );
});

test("stored receipt tamper fails closed instead of replaying unauthenticated history", async () => {
  for (const mutation of [
    "UPDATE facet_v2_consumer_receipts SET receipt_json = receipt_json || ' '",
    `UPDATE facet_v2_consumer_receipts SET receipt_sha256 = '${"0".repeat(64)}'`,
    "UPDATE facet_v2_consumer_receipts SET signature_value = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'",
  ]) {
    const db = new SqliteD1();
    const testEnv = env(db);
    const registration = authorityInput();
    await registerFacetV2AuthorityLink(testEnv, registration);
    const body = await event(registration);
    assert.equal((await handleFacetDesignIngest(request(body), testEnv)).status, 202);
    db.raw.exec("DROP TRIGGER facet_v2_consumer_receipts_append_only_update");
    db.raw.exec(mutation);
    const replay = await handleFacetDesignIngest(request(body), testEnv);
    assert.equal(replay.status, 503, mutation);
    assert.deepEqual(await replay.json(), { error: "facet_v2_receipt_integrity_unavailable" });
  }
});

test("concurrent same-nonce unassociated and rejected requests converge on one signed receipt", async () => {
  const unassociatedDb = new SqliteD1();
  const unassociatedEnv = env(unassociatedDb);
  const registration = authorityInput();
  const unassociatedBody = await event(registration);
  const unassociatedNonce = "u".repeat(32);
  const unassociatedResponses = await Promise.all([
    handleFacetDesignIngest(request(unassociatedBody, { nonce: unassociatedNonce }), unassociatedEnv),
    handleFacetDesignIngest(request(unassociatedBody, { nonce: unassociatedNonce }), unassociatedEnv),
  ]);
  assert.deepEqual(unassociatedResponses.map((response) => response.status), [202, 202]);
  const unassociatedReceipts = await Promise.all(unassociatedResponses.map(receipt));
  assert.deepEqual(unassociatedReceipts[0], unassociatedReceipts[1]);
  assert.equal(unassociatedReceipts[0]!.receipt.result, "accepted_unassociated");
  assert.equal(count(unassociatedDb, "facet_v2_raw_intakes"), 1);
  assert.equal(count(unassociatedDb, "facet_v2_consumer_receipts"), 1);

  const rejectedDb = new SqliteD1();
  const rejectedEnv = env(rejectedDb);
  await registerFacetV2AuthorityLink(rejectedEnv, registration);
  assert.equal((await handleFacetDesignIngest(request(unassociatedBody), rejectedEnv)).status, 202);
  const rejectedBody = await event(registration, {
    eventId: "55555555-5555-4555-8555-555555555555",
    receiptId: "66666666-6666-4666-8666-666666666666",
    receiptSha256: "e".repeat(64),
  });
  const rejectedNonce = "r".repeat(32);
  const rejectedResponses = await Promise.all([
    handleFacetDesignIngest(request(rejectedBody, { nonce: rejectedNonce }), rejectedEnv),
    handleFacetDesignIngest(request(rejectedBody, { nonce: rejectedNonce }), rejectedEnv),
  ]);
  assert.deepEqual(rejectedResponses.map((response) => response.status), [409, 409]);
  const rejectedReceipts = await Promise.all(rejectedResponses.map(receipt));
  assert.deepEqual(rejectedReceipts[0], rejectedReceipts[1]);
  assert.equal(rejectedReceipts[0]!.receipt.result, "rejected");
  assert.equal(rejectedReceipts[0]!.receipt.detail_code, "initial_decision_already_exists");
  assert.equal(count(rejectedDb, "facet_v2_raw_intakes"), 2);
  assert.equal(count(rejectedDb, "facet_v2_consumer_receipts"), 2);
  assert.equal(count(rejectedDb, "facet_v2_customer_decisions"), 1);
});

test("holds unassociated raw evidence and later appends reconciliation without rewriting intake", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const testEnv = env(db, raw);
  const registration = authorityInput();
  const body = await event(registration);
  const response = await handleFacetDesignIngest(request(body), testEnv);
  assert.equal(response.status, 202);
  assert.equal((await receipt(response)).receipt.result, "accepted_unassociated");
  assert.equal(count(db, "facet_v2_customer_decisions"), 0);
  await registerFacetV2AuthorityLink(testEnv, registration);
  assert.equal(await reconcileFacetV2UnassociatedIntakes(testEnv, new Date(NOW + 60_000)), 1);
  assert.equal(count(db, "facet_v2_raw_intakes"), 1);
  assert.equal(count(db, "facet_v2_customer_decisions"), 1);
  assert.equal(count(db, "facet_v2_consumer_receipts"), 2);
  assert.deepEqual(
    db.raw.prepare(`SELECT result FROM facet_v2_consumer_receipts ORDER BY created_at`).all()
      .map((row) => ({ ...row })),
    [{ result: "accepted_unassociated" }, { result: "reconciled" }],
  );
});

test("unassociated intake reconciles with an active rotated key and current-key replay closes delivery", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  const testEnv = env(db, raw);
  const registration = authorityInput();
  const body = await event(registration);
  const unassociated = await receipt(await handleFacetDesignIngest(request(body), testEnv));
  assert.equal(unassociated.receipt.result, "accepted_unassociated");
  assertReceiptSignedWith(unassociated, KEY);

  await registerFacetV2AuthorityLink(testEnv, registration);
  const retiredOldKey = { ...KEY, not_after_ms: NOW - 1 };
  testEnv.FACET_V2_KEYS_JSON = JSON.stringify([retiredOldKey]);
  assert.equal(await reconcileFacetV2UnassociatedIntakes(testEnv, new Date(NOW + 60_000)), 0);
  assert.equal(count(db, "facet_v2_customer_decisions"), 0);
  assert.equal(count(db, "facet_v2_consumer_receipts"), 1);
  testEnv.FACET_V2_KEYS_JSON = JSON.stringify([retiredOldKey, ROTATED_KEY]);
  assert.equal(await reconcileFacetV2UnassociatedIntakes(testEnv, new Date(NOW + 60_000)), 1);
  const reconciledHistory = db.raw.prepare(
    `SELECT result, signature_key_version FROM facet_v2_consumer_receipts ORDER BY rowid`,
  ).all().map((row) => ({ ...row }));
  assert.deepEqual(reconciledHistory, [
    { result: "accepted_unassociated", signature_key_version: KEY.key_version },
    { result: "reconciled", signature_key_version: ROTATED_KEY.key_version },
  ]);

  const replayResponse = await handleFacetDesignIngest(request(body, {
    nonce: "reconciled-current-key-nonce-0001",
    keyVersion: ROTATED_KEY.key_version,
    secret: ROTATED_KEY.secret,
  }), testEnv);
  assert.equal(replayResponse.status, 200);
  const replay = await receipt(replayResponse);
  assert.equal(replay.receipt.result, "reconciled");
  assert.equal(replay.receipt.idempotent_replay, true);
  assertReceiptSignedWith(replay, ROTATED_KEY);
  assert.equal(count(db, "facet_v2_customer_decisions"), 1);
  assert.equal(count(db, "facet_v2_raw_intakes"), 2);
  assert.equal(count(db, "facet_v2_consumer_receipts"), 3);
});

test("accepts correction and withdrawal append events and closes the withdrawn chain", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  const registration = authorityInput();
  await registerFacetV2AuthorityLink(testEnv, registration);
  const initial = await event(registration);
  assert.equal((await handleFacetDesignIngest(request(initial), testEnv)).status, 202);
  const wrongOidcSubject = await event(registration, {
    eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    occurredAt: "2027-01-15T08:00:30.000Z",
    decision: "corrected",
    previousEventId: initial.event_id,
    reasonSha256: "a".repeat(64),
    receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    receiptSha256: "b".repeat(64),
    oidcSubjectSha256: "c".repeat(64),
  });
  const identityRejected = await handleFacetDesignIngest(
    request(wrongOidcSubject, { nonce: "1123456789abcdefghijklmnopqrstuv" }),
    testEnv,
  );
  assert.equal(identityRejected.status, 409);
  assert.equal(
    (await receipt(identityRejected)).receipt.detail_code,
    "decision_customer_identity_mismatch",
  );
  const corrected = await event(registration, {
    eventId: "55555555-5555-4555-8555-555555555555",
    occurredAt: "2027-01-15T08:01:00.000Z",
    decision: "corrected",
    previousEventId: initial.event_id,
    reasonSha256: "4".repeat(64),
    receiptId: "66666666-6666-4666-8666-666666666666",
    receiptSha256: "5".repeat(64),
  });
  assert.equal((await handleFacetDesignIngest(
    request(corrected, { nonce: "2123456789abcdefghijklmnopqrstuv" }), testEnv,
  )).status, 202);
  const withdrawn = await event(registration, {
    eventId: "77777777-7777-4777-8777-777777777777",
    occurredAt: "2027-01-15T08:02:00.000Z",
    decision: "withdrawn",
    previousEventId: corrected.event_id,
    reasonSha256: "6".repeat(64),
    receiptId: "88888888-8888-4888-8888-888888888888",
    receiptSha256: "7".repeat(64),
  });
  assert.equal((await handleFacetDesignIngest(
    request(withdrawn, { nonce: "3123456789abcdefghijklmnopqrstuv" }), testEnv,
  )).status, 202);
  const afterWithdrawal = await event(registration, {
    eventId: "99999999-9999-4999-8999-999999999999",
    occurredAt: "2027-01-15T08:03:00.000Z",
    decision: "corrected",
    previousEventId: withdrawn.event_id,
    reasonSha256: "8".repeat(64),
    receiptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    receiptSha256: "9".repeat(64),
  });
  const rejected = await handleFacetDesignIngest(
    request(afterWithdrawal, { nonce: "4123456789abcdefghijklmnopqrstuv" }), testEnv,
  );
  assert.equal(rejected.status, 409);
  assert.equal((await receipt(rejected)).receipt.detail_code, "withdrawn_chain_is_terminal");
  assert.deepEqual(
    db.raw.prepare(`SELECT decision_kind FROM facet_v2_customer_decisions ORDER BY occurred_at`).all()
      .map((row) => ({ ...row })),
    [{ decision_kind: "approved" }, { decision_kind: "corrected" }, { decision_kind: "withdrawn" }],
  );
});

test("authentication rejects transport drift without R2 writes and holds identity drift after raw evidence", async () => {
  const registration = authorityInput();
  const body = await event(registration);
  const cases: Array<{
    name: string;
    req: () => Request;
    status: number;
    configure?: (testEnv: Env) => void;
  }> = [
    {
      name: "tamper",
      req: () => request({ ...body, brand_id: "iroof" }, { secret: "wrong-secret-longer-than-thirty-two-characters" }),
      status: 401,
    },
    { name: "unknown key", req: () => request(body, { keyId: "unknown-key" }), status: 401 },
    {
      name: "inactive key",
      req: () => request(body),
      status: 401,
      configure: (testEnv) => {
        testEnv.FACET_V2_KEYS_JSON = JSON.stringify([{
          ...KEY,
          not_before_ms: NOW - 86_400_000,
          not_after_ms: NOW - 2_000,
        }]);
      },
    },
    {
      name: "expiry",
      req: () => request(body, { issuedAt: NOW - 600_000, expiresAt: NOW - 300_000 }),
      status: 401,
    },
    {
      name: "route drift",
      req: () => request(body, { destinationUrl: "https://other.example.invalid/ingest/facet-design" }),
      status: 403,
    },
  ];
  for (const item of cases) {
    const db = new SqliteD1();
    const raw = new MemoryR2();
    const testEnv = env(db, raw);
    item.configure?.(testEnv);
    await registerFacetV2AuthorityLink(testEnv, registration);
    const response = await handleFacetDesignIngest(item.req(), testEnv);
    assert.equal(response.status, item.status, item.name);
    assert.equal(raw.objects.size, 0, `${item.name} must not reach R2`);
    assert.equal(count(db, "facet_v2_raw_intakes"), 0, item.name);
  }

  for (const [name, req, status] of [
    ["malformed JSON", signedRawRequest("{", String(body.event_id)), 400],
    ["oversize body", signedRawRequest("x".repeat(512 * 1024 + 1), String(body.event_id)), 413],
  ] as const) {
    const db = new SqliteD1();
    const raw = new MemoryR2();
    const response = await handleFacetDesignIngest(req, env(db, raw));
    assert.equal(response.status, status, name);
    assert.equal(raw.objects.size, 0, `${name} must not reach R2`);
    assert.equal(count(db, "facet_v2_raw_intakes"), 0, name);
  }
  const identityDb = new SqliteD1();
  const identityRaw = new MemoryR2();
  const identityEnv = env(identityDb, identityRaw);
  await registerFacetV2AuthorityLink(identityEnv, registration);
  const wrongIdentity = structuredClone(body);
  wrongIdentity.approval.actor.customer_party_ref = "0".repeat(64);
  const held = await handleFacetDesignIngest(request(wrongIdentity), identityEnv);
  assert.equal(held.status, 202);
  assert.equal((await receipt(held)).receipt.result, "accepted_unassociated");
  assert.equal(count(identityDb, "facet_v2_customer_decisions"), 0);
  const privateDb = new SqliteD1();
  const privateRaw = new MemoryR2();
  const privateEnv = env(privateDb, privateRaw);
  const privateBody = await event(registration, { extraFrozenApproval: { customer_address: "not allowed" } });
  const invalid = await handleFacetDesignIngest(request(privateBody), privateEnv);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_event_body" });
  assert.equal(privateRaw.objects.size, 0);
});

test("legacy flags and bearer-capability v1 can never authorize the live route", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  testEnv.FACET_V2_INGEST_ENABLED = "false";
  testEnv.FACET_DESIGN_INGEST_ENABLED = "true";
  testEnv.APP_IRONWRAP_LEGACY_V1_DESIGN_EVENTS_ENABLED = "true";
  const legacy = {
    event_id: "legacy-facet-event",
    event_type: "facet.design.approved.v1",
    schema_version: 1,
    identity_assurance: "bearer_capability_only",
  };
  const response = await worker.fetch(request(legacy), testEnv, {} as ExecutionContext);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.equal(count(db, "facet_v2_raw_intakes"), 0);
});

test("R2 failure prevents every D1 intake, receipt, and decision write", async () => {
  const db = new SqliteD1();
  const raw = new MemoryR2();
  raw.failPuts = true;
  const testEnv = env(db, raw);
  const registration = authorityInput();
  await registerFacetV2AuthorityLink(testEnv, registration);
  const response = await handleFacetDesignIngest(request(await event(registration)), testEnv);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "facet_v2_raw_store_unavailable" });
  assert.equal(count(db, "facet_v2_raw_intakes"), 0);
  assert.equal(count(db, "facet_v2_consumer_receipts"), 0);
  assert.equal(count(db, "facet_v2_customer_decisions"), 0);
});

test("0043 authority and evidence records are append-only", async () => {
  const db = new SqliteD1();
  const testEnv = env(db);
  const registration = authorityInput();
  await registerFacetV2AuthorityLink(testEnv, registration);
  await handleFacetDesignIngest(request(await event(registration)), testEnv);
  assert.throws(
    () => db.raw.exec("UPDATE facet_v2_project_links SET roof_job_id = 'DRIFT'"),
    /facet_v2_project_links_append_only/,
  );
  assert.throws(
    () => db.raw.exec("DELETE FROM facet_v2_customer_decisions"),
    /facet_v2_customer_decisions_append_only/,
  );
  assert.throws(
    () => db.raw.exec("UPDATE facet_v2_consumer_receipts SET detail_code = 'drift'"),
    /facet_v2_consumer_receipts_append_only/,
  );
});
