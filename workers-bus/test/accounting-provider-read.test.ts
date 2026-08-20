// Slice S3, the authenticated provider-detail read.
//
// docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 5.1: this is the only mechanism that may
// settle a money state, so what it does with every non-200 matters as much as the happy path. A
// 404 is an accounting fact; a 401, a 429, a 5xx and a dropped socket are outages that must leave
// every money state exactly where it was.
//
// The transport is the injected `fetcher` (section 9). No test here can reach a real host: an
// unrouted path is answered by the double, not by the network, and project rule 5 is what that is
// for.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NOW,
  REALM,
  TENANT,
  fakeIntuit,
  quickBooksError,
  quickBooksFixture,
  stubAuthPort,
} from "./accounting-fixture.ts";
import {
  readProviderEntity,
  readProviderTaxRates,
} from "../src/accounting-provider-read.ts";
import { QuickBooksAuthError, type QuickBooksAuthPort } from "../src/quickbooks-auth-port.ts";

const INVOICE_PATH = `/v3/company/${REALM}/invoice/2001`;
const TAX_RATE_PATH = `/v3/company/${REALM}/taxrate/3`;

test("a successful read returns the normalized fact set and carries the bearer token in the header only", async () => {
  const { fetcher, calls } = fakeIntuit([
    { path: INVOICE_PATH, body: quickBooksFixture("invoice-open.json") },
  ]);

  const read = await readProviderEntity(stubAuthPort(), {
    tenantId: TENANT,
    entityType: "Invoice",
    entityId: "2001",
    source: "dispatch_readback",
    effectAttemptId: "effect:ironwrap:1:attempt:1",
  }, fetcher, NOW);

  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  assert.equal(read.entityId, "2001");
  assert.equal(read.realmId, REALM);
  assert.equal(read.normalized.facts["TotalAmt"], "1260.00");
  assert.equal(read.readAt, NOW.toISOString());
  assert.equal(read.effectAttemptId, "effect:ironwrap:1:attempt:1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.authorization, "Bearer test-access-token-not-a-credential");
  // The credential reaches the header and nothing else: not the URL, not the result.
  assert.equal(calls[0]!.url.includes("test-access-token"), false);
  assert.match(calls[0]!.url, /minorversion=75$/);
  assert.equal(JSON.stringify(read.normalized).includes("test-access-token"), false);
});

test("a 404 is an accounting fact, and every other failure is an outage", async () => {
  const cases: Array<{ status: number; body: unknown; expect: string; detail: string }> = [
    { status: 404, body: { Fault: {} }, expect: "not_found", detail: "provider_entity_absent" },
    {
      status: 401,
      body: quickBooksError("error-3200-auth-failure.json"),
      expect: "unavailable",
      detail: "provider_auth_failed",
    },
    { status: 429, body: {}, expect: "unavailable", detail: "provider_throttled" },
    { status: 500, body: {}, expect: "unavailable", detail: "provider_error" },
    {
      status: 400,
      body: quickBooksError("error-5010-stale-object.json"),
      expect: "unavailable",
      detail: "provider_error",
    },
  ];

  for (const scenario of cases) {
    const { fetcher } = fakeIntuit([
      { path: INVOICE_PATH, status: scenario.status, body: scenario.body },
    ]);
    const read = await readProviderEntity(stubAuthPort(), {
      tenantId: TENANT, entityType: "Invoice", entityId: "2001", source: "sweep",
    }, fetcher, NOW);
    assert.equal(read.status, scenario.expect, `status ${scenario.status}`);
    assert.equal(
      read.status === "unavailable" ? read.detailCode : (read as { detailCode?: string }).detailCode,
      scenario.detail,
      `status ${scenario.status}`,
    );
  }
});

test("a dropped socket is an outage, not a missing entity", async () => {
  const { fetcher } = fakeIntuit([{ path: INVOICE_PATH, networkError: true }]);
  const read = await readProviderEntity(stubAuthPort(), {
    tenantId: TENANT, entityType: "Invoice", entityId: "2001", source: "sweep",
  }, fetcher, NOW);
  assert.equal(read.status, "unavailable");
  if (read.status !== "unavailable") return;
  assert.equal(read.detailCode, "provider_unreachable");
});

test("a connection the auth port cannot resolve never becomes an unauthenticated read", async () => {
  const refusing: QuickBooksAuthPort = {
    async activeRealm() {
      throw new QuickBooksAuthError("quickbooks_connection_required");
    },
  };
  const { fetcher, calls } = fakeIntuit([
    { path: INVOICE_PATH, body: quickBooksFixture("invoice-open.json") },
  ]);

  const read = await readProviderEntity(refusing, {
    tenantId: TENANT, entityType: "Invoice", entityId: "2001", source: "sweep",
  }, fetcher, NOW);

  assert.equal(read.status, "unavailable");
  if (read.status !== "unavailable") return;
  assert.equal(read.detailCode, "quickbooks_connection_required");
  assert.equal(calls.length, 0, "no request may be made without a resolved realm");
});

test("a response whose body is not the named entity is unreadable, not empty", async () => {
  const { fetcher } = fakeIntuit([{ path: INVOICE_PATH, body: { QueryResponse: {} } }]);
  const read = await readProviderEntity(stubAuthPort(), {
    tenantId: TENANT, entityType: "Invoice", entityId: "2001", source: "sweep",
  }, fetcher, NOW);
  assert.equal(read.status, "unavailable");
  if (read.status !== "unavailable") return;
  assert.equal(read.detailCode, "provider_response_unreadable");
});

test("tax rates are read per bound code, and a code that could not be read is simply absent", async () => {
  const { fetcher } = fakeIntuit([
    { path: TAX_RATE_PATH, body: quickBooksFixture("tax-rate-gst-6.json") },
    { path: `/v3/company/${REALM}/taxrate/9`, status: 500, body: {} },
  ]);

  const rates = await readProviderTaxRates(stubAuthPort(), {
    tenantId: TENANT,
    taxRateIdsByCode: new Map([["GST", "3"], ["PST", "9"]]),
  }, fetcher, NOW);

  assert.deepEqual([...rates.keys()], ["GST"]);
  assert.equal(rates.get("GST")?.facts["RateValue"], "6.0000");
});

test("an unrouted path is answered by the double, never by the network", async () => {
  const { fetcher } = fakeIntuit([]);
  const read = await readProviderEntity(stubAuthPort(), {
    tenantId: TENANT, entityType: "CreditMemo", entityId: "4001", source: "sweep",
  }, fetcher, NOW);
  assert.equal(read.status, "not_found");
});
