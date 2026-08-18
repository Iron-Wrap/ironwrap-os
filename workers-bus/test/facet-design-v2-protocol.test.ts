import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  FACET_V2_RECEIPT_SCHEMA,
  canonicalJson,
  facetV2DeliverySigningInput,
  signFacetV2Receipt,
  verifyFacetV2Delivery,
  type FacetV2CustomerDecisionEvent,
  type FacetV2Receipt,
  type FacetV2StaticRoute,
  type FacetV2VerificationKey,
} from "../src/facet-design-v2-protocol.ts";

const SECRET = "synthetic-facet-v2-hmac-key-for-contract-tests-0001";
const FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/facet-v2-signed-roundtrip.json", import.meta.url),
  "utf8",
)) as {
  event: FacetV2CustomerDecisionEvent;
  expected: {
    event_body_sha256: string;
    delivery_signature: string;
    receipt_sha256: string;
    receipt_signature: string;
  };
};
const NOW = 1_800_000_000_000;
const ISSUED_AT = String(NOW - 1_000);
const EXPIRES_AT = String(NOW + 119_000);
const NONCE = "0123456789abcdefghijklmnopqrstuv";
const ROUTE: FacetV2StaticRoute = {
  version: 1,
  issuer: "facet",
  sourceProduct: "facet",
  sourceEnvironment: "production",
  sourceTenantId: "22222222-2222-4222-8222-222222222222",
  destinationTenantId: "ironwrap",
  destinationUrl: "https://bus.example.invalid/ingest/facet-design",
};
const KEY: FacetV2VerificationKey = {
  keyId: "facet-v2-2026-08",
  keyVersion: 3,
  secret: SECRET,
  notBeforeMs: NOW - 86_400_000,
  notAfterMs: NOW + 86_400_000,
};
const EVENT = FIXTURE.event;

function requestFor(event = EVENT, overrides: Record<string, string> = {}): Request {
  const body = canonicalJson(event);
  const bodySha256 = sha256(body);
  const destination = new URL(ROUTE.destinationUrl);
  const signature = createHmac("sha256", SECRET).update(facetV2DeliverySigningInput({
    destinationOrigin: destination.origin,
    destinationPath: destination.pathname,
    issuer: ROUTE.issuer,
    product: ROUTE.sourceProduct,
    environment: ROUTE.sourceEnvironment,
    destinationTenantId: ROUTE.destinationTenantId,
    keyId: KEY.keyId,
    keyVersion: KEY.keyVersion,
    eventId: String(event.event_id),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    nonce: NONCE,
    bodySha256,
  })).digest("base64url");
  return new Request(ROUTE.destinationUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ironwrap-event-body-sha256": bodySha256,
      "x-ironwrap-event-destination-tenant-id": ROUTE.destinationTenantId,
      "x-ironwrap-event-environment": ROUTE.sourceEnvironment,
      "x-ironwrap-event-expires-at": EXPIRES_AT,
      "x-ironwrap-event-id": String(event.event_id),
      "x-ironwrap-event-issued-at": ISSUED_AT,
      "x-ironwrap-event-issuer": ROUTE.issuer,
      "x-ironwrap-event-key-id": KEY.keyId,
      "x-ironwrap-event-key-version": String(KEY.keyVersion),
      "x-ironwrap-event-nonce": NONCE,
      "x-ironwrap-event-product": ROUTE.sourceProduct,
      "x-ironwrap-event-signature": signature,
      ...overrides,
    },
    body,
  });
}

test("verifies the exact Facet v2 canonical delivery and signs the matching IronWrap receipt", async () => {
  const body = canonicalJson(EVENT);
  assert.deepEqual(EVENT, FIXTURE.event);
  assert.equal(sha256(body), FIXTURE.expected.event_body_sha256);
  const verified = await verifyFacetV2Delivery(requestFor(), body, {
    routes: [ROUTE],
    keys: [KEY],
    nowMs: NOW,
  });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.value.event.event_id, EVENT.event_id);
  assert.equal(verified.value.headers.keyId, KEY.keyId);
  assert.equal(verified.value.headers.signature, FIXTURE.expected.delivery_signature);

  const receipt: FacetV2Receipt = {
    schema: FACET_V2_RECEIPT_SCHEMA,
    receipt_id: "55555555-5555-4555-8555-555555555555",
    event_id: EVENT.event_id,
    event_body_sha256: verified.value.bodySha256,
    frozen_evidence_sha256: sha256(canonicalJson(EVENT.frozen_evidence)),
    design_revision: EVENT.design_revision,
    decision_kind: EVENT.approval.decision,
    approval_receipt_sha256: EVENT.approval.receipt_sha256,
    actor_identity_assurance: EVENT.approval.actor.identity_assurance,
    destination_tenant_id: ROUTE.destinationTenantId,
    result: "accepted_unassociated",
    policy_version: "ironwrap-facet-consumer-v2",
    occurred_at: "2027-01-15T08:00:01.000Z",
    detail_code: "awaiting_exact_project_identity_association",
    idempotent_replay: false,
  };
  const signed = await signFacetV2Receipt(receipt, KEY);
  assert.equal(signed.receipt, receipt);
  assert.equal(signed.receipt_sha256, FIXTURE.expected.receipt_sha256);
  assert.equal(signed.signature.value, FIXTURE.expected.receipt_signature);
});

test("keeps the prebound customer link distinct from the exact OIDC subject proof", async () => {
  const distinctIdentity = structuredClone(EVENT);
  distinctIdentity.approval.actor.oidc_subject_sha256 = "9".repeat(64);
  const body = canonicalJson(distinctIdentity);
  const verified = await verifyFacetV2Delivery(
    requestFor(distinctIdentity),
    body,
    { routes: [ROUTE], keys: [KEY], nowMs: NOW },
  );
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.notEqual(
    verified.value.event.approval.actor.external_identity_link_id,
    `facet-customer-oidc-v1:${verified.value.event.approval.actor.oidc_subject_sha256}`,
  );
});

test("fails closed for body tamper, unknown or inactive keys, expiry, and route drift", async () => {
  const body = canonicalJson(EVENT);
  const tampered = canonicalJson({ ...EVENT, brand_id: "iroof" });
  assert.deepEqual(
    await verifyFacetV2Delivery(requestFor(), tampered, { routes: [ROUTE], keys: [KEY], nowMs: NOW }),
    { ok: false, code: "event_signature_invalid", status: 401 },
  );
  assert.deepEqual(
    await verifyFacetV2Delivery(requestFor(), body, { routes: [ROUTE], keys: [], nowMs: NOW }),
    { ok: false, code: "event_key_unknown", status: 401 },
  );
  assert.deepEqual(
    await verifyFacetV2Delivery(requestFor(), body, {
      routes: [ROUTE],
      keys: [{ ...KEY, notAfterMs: Number(ISSUED_AT) }],
      nowMs: NOW,
    }),
    { ok: false, code: "event_key_inactive", status: 401 },
  );
  assert.deepEqual(
    await verifyFacetV2Delivery(requestFor(), body, {
      routes: [ROUTE], keys: [KEY], nowMs: Number(EXPIRES_AT) + 60_001,
    }),
    { ok: false, code: "event_timestamp_stale", status: 401 },
  );
  assert.deepEqual(
    await verifyFacetV2Delivery(requestFor(), body, {
      routes: [{ ...ROUTE, sourceTenantId: "33333333-3333-4333-8333-333333333333" }],
      keys: [KEY],
      nowMs: NOW,
    }),
    { ok: false, code: "event_route_mismatch", status: 403 },
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
